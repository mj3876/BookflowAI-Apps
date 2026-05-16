// PR-C (2026-05-15) 4-step state machine v2 — 날짜별 상세 (4 탭).
//
// 📥 입고 — target = 내 측 · status ∈ {PENDING, APPROVED, IN_TRANSIT}
// 📤 출고 — source = 내 측 · status ∈ {PENDING, APPROVED}
// 🚚 운송 — 양측 중 하나 · status = IN_TRANSIT
// ✅ 완료 — 양측 중 하나 · status ∈ {EXECUTED, AUTO_EXECUTED} · executed_at::date = day
//
// 액션 매트릭스 (ActionButtons 컴포넌트 책임):
//   PENDING        → [✓ 동의] [✗ 거부]
//   APPROVED (src) → [🚚 발송] [✗ 취소]
//   APPROVED (tgt) → (대기)
//   IN_TRANSIT(tgt)→ [📦 수령] [↩ 반품]
//   IN_TRANSIT(src)→ (운송 중)
//   EXECUTED       → (완료)
//   REJECTED       → (거부 사유)
import { useMemo, useState } from 'react';
import { Link, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import {
  fetchPending, postOrderApprove, postOrderDispatch, postOrderReceive, postOrderReject,
  type PendingOrder, type PlanView,
} from '../api';
import { getRole, getScope } from '../auth';
import { ORDER_STATUS_KO, ORDER_TYPE_KO, REJECTION_STAGE_KO, orderTypeClass } from '../labels';
import { useLocations } from '../useLocations';
import { useToast } from '../components/Toast';
import { PlanViewToggle, planViewOptions } from '../components/PlanViewToggle';

// plan_view (order_type 기반) — 캘린더 분리 토글과 동일 매핑.
const PLAN_VIEW_TYPES: Record<Exclude<PlanView, 'all'>, string[]> = {
  mine: ['WH_TO_STORE', 'WH_TRANSFER', 'PUBLISHER_ORDER'],
  observe: ['REBALANCE'],
};

type ToastShow = (msg: string, type: 'success' | 'error' | 'info' | 'warning') => void;

// 이슈10 2026-05-16: chained WH_TO_STORE 판별 —
//   상위 발주(WH_TRANSFER/PUBLISHER_ORDER) 실행 후 자동 생성된 결과물(이미 APPROVED 강제).
//   forecast_rationale.auto_approved=true 로 표식. hq 는 강제승인/발송/수령 대상 아님(read-only 관제).
//   발송(물류센터)·수령(지점) 실행 주체만 액션. hq 액션 버튼 미노출.
function isChained(o: PendingOrder): boolean {
  return o.forecast_rationale?.auto_approved === true;
}

type Tab = 'inbound' | 'outbound' | 'in_transit' | 'executed';
type Side = 'source' | 'target' | 'both' | 'none';
type Placement = { tab: Tab; side: Side };

// 이슈3 2026-05-16: WH_TO_STORE (물류센터→지점) 는 양면 업무 —
//   source(물류센터)=출고 탭 · target(지점)=입고 탭 양쪽에 분류.
//   그 외 order_type 은 기존대로 한 탭에만 분류.
function classify(o: PendingOrder, role: string, scope: { scope_wh_id: number | null; scope_store_id: number | null }): {
  side: Side;
  placements: Placement[];
} {
  // hq-admin 은 모든 row 의 양측을 볼 수 있음
  const isHq = role === 'hq-admin';
  // simplistic check using location IDs (backend filter 가 scope 보장하므로 frontend 는 표시용)
  const isSrc = isHq
    || (scope.scope_store_id != null && o.source_location_id === scope.scope_store_id)
    || (scope.scope_wh_id != null && (o as any).source_wh_id === scope.scope_wh_id);
  const isTgt = isHq
    || (scope.scope_store_id != null && o.target_location_id === scope.scope_store_id)
    || (scope.scope_wh_id != null && (o as any).target_wh_id === scope.scope_wh_id);

  const side: Side = isSrc && isTgt ? 'both' : isSrc ? 'source' : isTgt ? 'target' : 'none';
  const status = o.status;
  const placements: Placement[] = [];

  // v5 2026-05-15 피드백 #8: PENDING 은 /approval 전용 · CalendarDetail 는 APPROVED+ 만
  if (status === 'IN_TRANSIT') {
    placements.push({ tab: 'in_transit', side });
  } else if (status === 'EXECUTED' || status === 'AUTO_EXECUTED') {
    placements.push({ tab: 'executed', side });
  } else if (status === 'APPROVED') {
    if (o.order_type === 'WH_TO_STORE') {
      if (isSrc) placements.push({ tab: 'outbound', side: 'source' });
      if (isTgt) placements.push({ tab: 'inbound', side: 'target' });
      if (!isSrc && !isTgt) placements.push({ tab: 'inbound', side });
    } else if (isTgt && !isSrc) {
      placements.push({ tab: 'inbound', side });
    } else if (isSrc && !isTgt) {
      placements.push({ tab: 'outbound', side });
    } else {
      placements.push({ tab: 'inbound', side });  // BOTH (hq) default
    }
  }
  return { side, placements };
}

function ActionButtons({ order, side, onDone }: { order: PendingOrder; side: 'source' | 'target' | 'both' | 'none'; onDone: () => void }) {
  const role = getRole()!;
  const { showToast } = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['orders'] }); qc.invalidateQueries({ queryKey: ['pending-active'] }); qc.invalidateQueries({ queryKey: ['calendar'] }); onDone(); };
  const toast: ToastShow = (msg, t) => showToast({ type: t, message: msg });

  const wrap = async (label: string, fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      toast(`✅ ${label} 완료`, 'success');
      refresh();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast(`✗ ${label} 실패: ${msg}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const onApprove = () => wrap('동의', () => postOrderApprove(role, order.order_id, {}));
  const onDispatch = () => wrap('발송', () => postOrderDispatch(role, order.order_id, {}));
  const onReceive = () => wrap('수령', () => postOrderReceive(role, order.order_id, {}));
  const onReject = () => {
    const reason = window.prompt('거부 사유 (간단히)');
    if (!reason) return;
    void wrap('거부', () => postOrderReject(role, order.order_id, { reject_reason: reason }));
  };

  const st = order.status;
  // 이슈10: chained WH_TO_STORE 는 hq read-only (관제) — 강제승인/발송/수령 버튼 미노출.
  //   실행 주체는 물류센터(발송)·지점(수령)뿐. hq 는 진행 상태만 표시.
  const chainedReadOnly = isChained(order) && role === 'hq-admin';
  if (chainedReadOnly) {
    return <span className="text-xs text-bf-muted">{ORDER_STATUS_KO[st] ?? st} · 자동 (관제)</span>;
  }
  // 액션 매트릭스
  if (st === 'PENDING') {
    return (
      <div className="flex gap-1">
        <button className="bf-btn-primary text-xs" disabled={busy} onClick={onApprove}>✓ 동의</button>
        <button className="bf-btn-danger-secondary text-xs" disabled={busy} onClick={onReject}>✗ 거부</button>
      </div>
    );
  }
  if (st === 'APPROVED') {
    if (side === 'source' || side === 'both' || role === 'hq-admin') {
      return (
        <div className="flex gap-1">
          <button className="bf-btn-primary text-xs" disabled={busy} onClick={onDispatch}>🚚 발송</button>
          <button className="bf-btn-danger-secondary text-xs" disabled={busy} onClick={onReject}>✗ 취소</button>
        </div>
      );
    }
    return <span className="text-xs text-bf-muted">상대 측 발송 대기</span>;
  }
  if (st === 'IN_TRANSIT') {
    if (side === 'target' || side === 'both' || role === 'hq-admin') {
      return (
        <div className="flex gap-1">
          <button className="bf-btn-primary text-xs" disabled={busy} onClick={onReceive}>📦 수령</button>
          <button className="bf-btn-danger-secondary text-xs" disabled={busy} onClick={onReject}>↩ 반품</button>
        </div>
      );
    }
    return <span className="text-xs text-bf-muted">운송 중</span>;
  }
  if (st === 'REJECTED') {
    const stage = (order as PendingOrder & { rejection_stage?: string }).rejection_stage;
    return <span className="text-xs text-bf-muted">{stage ? `❌ ${REJECTION_STAGE_KO[stage] ?? stage}` : '❌ 거부됨'}</span>;
  }
  return <span className="text-xs text-bf-muted">{ORDER_STATUS_KO[st] ?? st}</span>;
}

export default function CalendarDetail() {
  const { date } = useParams<{ date: string }>();
  const navigate = useNavigate();
  const role = getRole();
  const scope = getScope();
  const { nameOf } = useLocations(role ?? 'hq-admin');
  const [tab, setTab] = useState<Tab>('inbound');
  const [searchParams, setSearchParams] = useSearchParams();

  const planView: PlanView = (() => {
    const v = searchParams.get('view');
    return v === 'mine' || v === 'observe' ? v : 'all';
  })();
  const setPlanView = (v: PlanView) => {
    const next = new URLSearchParams(searchParams);
    if (v === 'all') next.delete('view'); else next.set('view', v);
    setSearchParams(next, { replace: true });
  };

  // fetchPending(expected_date=YYYY-MM-DD) — backend `/intervention/queue?expected_date=`
  // 가 expected_arrival_at OR executed_at::date 기반으로 모든 status row 응답.
  // 캘린더 cell count (`/orders/calendar`) 와 같은 의미 → intra-user 정합성 보장.
  const q = useQuery({
    queryKey: ['orders', 'day', role, date],
    queryFn: () => fetchPending(role!, { limit: 5000, expected_date: date }),
    enabled: !!role && !!date,
    staleTime: 5000,
    refetchInterval: 10000,
  });

  // 이슈3: WH_TO_STORE 는 두 탭(출고+입고)에 출현 가능 → row 별 placement 별 entry 보관.
  const grouped = useMemo(() => {
    const empty: Record<Tab, { order: PendingOrder; side: Side }[]> =
      { inbound: [], outbound: [], in_transit: [], executed: [] };
    if (!q.data || !role) return empty;
    // backend 가 이미 date filter — frontend 는 4 탭 분류 + plan_view(order_type) 필터.
    const result: Record<Tab, { order: PendingOrder; side: Side }[]> =
      { inbound: [], outbound: [], in_transit: [], executed: [] };
    const allowTypes = planView !== 'all' ? PLAN_VIEW_TYPES[planView] : null;
    for (const o of q.data.items as PendingOrder[]) {
      if (allowTypes && !allowTypes.includes(o.order_type)) continue;
      const { placements } = classify(o, role, scope);
      for (const p of placements) result[p.tab].push({ order: o, side: p.side });
    }
    return result;
  }, [q.data, role, scope, planView]);

  if (!role || !date) return null;
  const counts = {
    inbound: grouped.inbound.length,
    outbound: grouped.outbound.length,
    in_transit: grouped.in_transit.length,
    executed: grouped.executed.length,
  };
  const items = grouped[tab];

  const hasToggle = planViewOptions(role) !== null;
  const viewBadge =
    planView === 'mine' ? { text: role === 'hq-admin' ? '🏢 물류센터 계획' : '📦 내 입출고', cls: 'bg-blue-100 text-blue-700 border-blue-200' }
    : planView === 'observe' ? { text: role === 'hq-admin' ? '🏬 지점 계획' : '🔄 권역 매장 재분배', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' }
    : null;
  const backHref = `/calendar${planView !== 'all' ? `?view=${planView}` : ''}`;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">📅 {date}</h1>
            {viewBadge && (
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${viewBadge.cls}`}>
                {viewBadge.text}
              </span>
            )}
          </div>
          <Link to={backHref} className="text-xs text-bf-primary hover:underline">← 캘린더로</Link>
        </div>
        {q.isFetching && <span className="text-xs text-bf-muted">갱신 중…</span>}
      </div>

      {hasToggle && (
        <PlanViewToggle role={role} value={planView} onChange={setPlanView} />
      )}

      <div className="bf-card">
        <div className="grid grid-cols-4">
          {(['inbound', 'outbound', 'in_transit', 'executed'] as Tab[]).map((t) => {
            const labels: Record<Tab, string> = {
              inbound: '📥 입고', outbound: '📤 출고', in_transit: '🚚 운송', executed: '✅ 완료',
            };
            const active = tab === t;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`py-2 text-sm border-b-2 ${active ? 'border-bf-primary text-bf-primary' : 'border-transparent text-bf-muted'}`}
              >
                {labels[t]} ({counts[t]})
              </button>
            );
          })}
        </div>
        <div className="divide-y divide-bf-border">
          {items.length === 0 ? (
            <div className="p-6 text-center text-sm text-bf-muted">해당 날짜에 항목이 없습니다.</div>
          ) : tab === 'executed' ? (
            /* v5: 완료 탭 order_type × 도서별 그룹핑 (Logistics 와 동일) */
            (() => {
              const groups: Record<string, { order: PendingOrder; side: Side }[]> = {};
              for (const e of items) { (groups[e.order.order_type] = groups[e.order.order_type] || []).push(e); }
              const order: string[] = ['REBALANCE', 'WH_TO_STORE', 'WH_TRANSFER', 'PUBLISHER_ORDER'];
              return order.filter((k) => groups[k]?.length).map((k) => {
                const byBook: Record<string, { order: PendingOrder; side: Side }[]> = {};
                for (const e of groups[k]) {
                  const key = `${e.order.isbn13}|${e.order.title ?? ''}`;
                  (byBook[key] = byBook[key] || []).push(e);
                }
                const books = Object.entries(byBook).sort((a, b) => b[1].length - a[1].length);
                return (
                  <div key={k}>
                    <div className={`${orderTypeClass(k)} px-3 py-2 text-sm font-medium bg-bf-panel2/60 flex items-center gap-2`}>
                      <span className="ot-dot" />
                      {ORDER_TYPE_KO[k] ?? k} ({groups[k].length}) · {books.length} 도서
                    </div>
                    <div className="divide-y divide-bf-border">
                      {books.map(([bk, list]) => {
                        const [isbn, title] = bk.split('|');
                        const totalQty = list.reduce((s, e) => s + e.order.qty, 0);
                        return (
                          <div key={bk} className="px-3 py-2">
                            <div className="text-sm font-medium truncate">
                              {title || `ISBN ${isbn}`} <span className="text-xs text-bf-muted">· ISBN {isbn} · 총 {totalQty}권 · {list.length}건</span>
                            </div>
                            <div className="mt-1 space-y-0.5">
                              {list.map(({ order: o }) => (
                                <div key={o.order_id} className="text-xs text-bf-muted flex items-center gap-2">
                                  <span>{nameOf(o.source_location_id ?? undefined) ?? '외부'} → {nameOf(o.target_location_id) ?? '?'} · {o.qty}권</span>
                                  <span className="px-1.5 py-0.5 rounded bg-bf-surface border border-bf-border">{ORDER_STATUS_KO[o.status] ?? o.status}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              });
            })()
          ) : (
            items.map(({ order: o, side }) => {
              return (
                <div
                  key={`${o.order_id}-${side}`}
                  className={`${orderTypeClass(o.order_type)} ot-row-hover p-3 flex items-center gap-3 transition`}
                >
                  <span className="ot-bar self-stretch" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 text-sm font-medium truncate">
                      <span className="ot-dot" />
                      {ORDER_TYPE_KO[o.order_type] ?? o.order_type} · ISBN {o.isbn13} · 수량 {o.qty}
                    </div>
                    <div className="text-xs text-bf-muted mt-0.5">
                      {nameOf(o.source_location_id ?? undefined) ?? '외부'} → {nameOf(o.target_location_id) ?? '?'}
                      <span className="ml-2 px-1.5 py-0.5 rounded bg-bf-panel2 border border-bf-border">
                        {ORDER_STATUS_KO[o.status] ?? o.status}
                      </span>
                    </div>
                  </div>
                  <div className="flex-shrink-0">
                    <ActionButtons order={o} side={side} onDone={() => q.refetch()} />
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
