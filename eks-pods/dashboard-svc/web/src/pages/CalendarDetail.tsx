// PR-C (2026-05-15) 4-step state machine v2 — 날짜별 상세 (4 탭).
// 2026-05-16 walkthrough-9 이슈15: /logistics 도 이 컴포넌트를 date 없이(=오늘) 렌더.
//
// 📥 입고 — target face · status ∈ {APPROVED, IN_TRANSIT}
// 📤 출고 — source face · status = APPROVED
// 🚚 운송 — source face · status = IN_TRANSIT
// ✅ 완료 — 노출 face · status ∈ {EXECUTED, AUTO_EXECUTED}
//
// 분류/액션 규칙은 lib/orderClassify.ts 단일 모듈 — CalendarDetail · /logistics 공유.
// 액션 매트릭스 (ActionButtons 컴포넌트 책임 · placement.side 만 따름):
//   APPROVED  (source) → [🚚 발송] [✗ 취소]
//   APPROVED  (target) → (상대 측 발송 대기)
//   IN_TRANSIT(target) → [📦 수령] [↩ 반품]
//   IN_TRANSIT(source) → (운송 중)
//   EXECUTED           → (완료)
//   REJECTED           → (거부 사유)
import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  fetchPending, postOrderDispatch, postOrderReceive, postOrderReject,
  type PendingOrder, type PlanView,
} from '../api';
import { getRole, getScope } from '../auth';
import { ORDER_STATUS_KO, ORDER_TYPE_KO, REJECTION_STAGE_KO, orderTypeClass } from '../labels';
import { useLocations } from '../useLocations';
import { useToast } from '../components/Toast';
import { PlanViewToggle, planViewOptions } from '../components/PlanViewToggle';
import UsageGuide, { type GuideEntry } from '../components/UsageGuide';
import { classify, isChained, type Tab, type Side } from '../lib/orderClassify';

type ToastShow = (msg: string, type: 'success' | 'error' | 'info' | 'warning') => void;

// 이슈5 2026-05-16 — 입출고(오늘) 페이지 role별 사용법 안내 (구 Logistics.tsx 에서 이전).
const LOGISTICS_GUIDE: GuideEntry[] = [
  {
    role: 'hq-admin',
    label: '🏢 본사 관리자',
    lines: [
      '오늘 처리할 입고·출고·운송·완료를 4개 탭으로 봅니다.',
      '📤 출고 — 발송(🚚) · 📥 입고 — 수령(📦) 처리.',
      '매장 보충(WH_TO_STORE)은 물류센터(출고)·지점(입고) 양쪽 탭에 함께 나타납니다.',
      '외부 발주는 출판사가 발송하므로 운송 탭에 바로 나타나고, 수령만 처리합니다.',
    ],
  },
  {
    role: 'wh-manager',
    label: '📦 물류센터 담당자',
    lines: [
      '📤 출고 탭 — 내 권역에서 보내는 건을 발송(🚚)합니다.',
      '📥 입고 탭 — 내 권역으로 들어오는 건을 수령(📦)합니다.',
      '매장 보충은 출고(물류센터)·입고(지점) 양면 업무 — 출고 탭에서 발송하면 지점이 입고 탭에서 수령합니다.',
      '🚚 운송 탭 — 발송 후 도착 대기 중인 건을 확인합니다.',
    ],
  },
  {
    role: 'branch-clerk',
    label: '🏬 지점 담당자',
    lines: [
      '📥 입고 탭 — 내 지점으로 도착하는 건을 수령(📦)합니다.',
      '📤 출고 탭 — 내 지점에서 다른 매장으로 보내는 재분배 건을 발송(🚚)합니다.',
      '✅ 완료 탭 — 오늘 처리가 끝난 건을 도서별로 확인합니다.',
    ],
  },
];

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function ActionButtons({ order, side, onDone }: { order: PendingOrder; side: Side; onDone: () => void }) {
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
  // 액션 매트릭스 — 이슈13-2: hq 블랭킷 override 제거. 오직 placement.side 만 따름.
  //   출고 탭(side='source') = 발송 행위 · 입고 탭(side='target') = 수령 행위.
  if (st === 'APPROVED') {
    if (side === 'source') {
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
    if (side === 'target') {
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

// 이슈11 2026-05-16: 일괄 발송/수령 — 현재 탭/scope 대상 일괄 처리 (구 Logistics.tsx 에서 이전).
//   출고 탭 → APPROVED source face 일괄 발송 · 입고 탭 → IN_TRANSIT target face 일괄 수령.
//   chained(auto_approved) hq read-only 는 제외 — placement.side 만 따름.
function BulkActionBar({ tab, items, onDone }: {
  tab: Tab;
  items: { order: PendingOrder; side: Side }[];
  onDone: () => void;
}) {
  const role = getRole()!;
  const { showToast } = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  if (tab !== 'outbound' && tab !== 'inbound') return null;

  const eligible = items.filter(({ order, side }) => {
    if (isChained(order) && role === 'hq-admin') return false;
    if (tab === 'outbound') return order.status === 'APPROVED' && side === 'source';
    return order.status === 'IN_TRANSIT' && side === 'target';
  });

  if (eligible.length === 0) return null;

  const isOutbound = tab === 'outbound';
  const label = isOutbound ? '일괄 발송' : '일괄 수령';
  const icon = isOutbound ? '🚚' : '📦';

  const run = async () => {
    if (busy) return;
    if (!window.confirm(`${eligible.length}건을 ${label}하시겠습니까?`)) return;
    setBusy(true);
    let ok = 0;
    let fail = 0;
    for (const { order } of eligible) {
      try {
        if (isOutbound) await postOrderDispatch(role, order.order_id, {});
        else await postOrderReceive(role, order.order_id, {});
        ok += 1;
      } catch {
        fail += 1;
      }
    }
    qc.invalidateQueries({ queryKey: ['orders'] });
    qc.invalidateQueries({ queryKey: ['calendar'] });
    qc.invalidateQueries({ queryKey: ['approval'] });
    showToast({
      type: fail === 0 ? 'success' : 'warning',
      message: `${label} 완료 — 성공 ${ok}건${fail ? ` · 실패 ${fail}건` : ''}`,
    });
    setBusy(false);
    onDone();
  };

  return (
    <div className="px-3 py-2 flex items-center justify-between bg-bf-panel2/60 border-b border-bf-border">
      <span className="text-xs text-bf-muted">{label} 대상 {eligible.length}건</span>
      <button type="button" className="bf-btn-primary text-xs" disabled={busy} onClick={run}>
        {icon} {label} ({eligible.length})
      </button>
    </div>
  );
}

// /cal/:date — 날짜별 상세. /logistics — date 파라미터 없음 → 오늘(today) 로 렌더 (이슈15).
export default function CalendarDetail() {
  const { date: paramDate } = useParams<{ date: string }>();
  const isLogistics = !paramDate;            // /logistics 진입 (date 파라미터 없음)
  const date = paramDate ?? todayIso();
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
    enabled: !!role,
    staleTime: 5000,
    refetchInterval: 10000,
  });

  // classify(order, role, scope, planView) — face 기반 분류 (lib/orderClassify.ts).
  //   planView 필터·face 가시성 모두 classify 안에서 처리. WH_TO_STORE 양면도 동일 규칙.
  const grouped = useMemo(() => {
    const empty: Record<Tab, { order: PendingOrder; side: Side }[]> =
      { inbound: [], outbound: [], in_transit: [], executed: [] };
    if (!q.data || !role) return empty;
    const result: Record<Tab, { order: PendingOrder; side: Side }[]> =
      { inbound: [], outbound: [], in_transit: [], executed: [] };
    for (const o of q.data.items as PendingOrder[]) {
      const { placements } = classify(o, role, scope, planView);
      for (const p of placements) result[p.tab].push({ order: o, side: p.side });
    }
    return result;
  }, [q.data, role, scope, planView]);

  if (!role) return null;
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
            <h1 className="text-xl font-semibold">
              {isLogistics ? `🚚 입출고 · 오늘 ${date}` : `📅 ${date}`}
            </h1>
            {viewBadge && (
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${viewBadge.cls}`}>
                {viewBadge.text}
              </span>
            )}
          </div>
          {isLogistics ? (
            <div className="text-xs text-bf-muted mt-0.5">
              <Link to="/calendar" className="text-bf-primary hover:underline">📅 캘린더</Link> 의 오늘 cell 과 동일. 다른 날짜는 캘린더에서 클릭.
            </div>
          ) : (
            <Link to={backHref} className="text-xs text-bf-primary hover:underline">← 캘린더로</Link>
          )}
        </div>
        {q.isFetching && <span className="text-xs text-bf-muted">갱신 중…</span>}
      </div>

      {isLogistics && (
        <UsageGuide title="입출고 페이지 사용법" role={role} entries={LOGISTICS_GUIDE} />
      )}

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
        {(tab === 'outbound' || tab === 'inbound') && (
          <BulkActionBar tab={tab} items={items} onDone={() => q.refetch()} />
        )}
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
