// PR-C v5 (2026-05-15) 입출고 페이지 = 당일(today) CalendarDetail.
// 사용자 요구: "그냥 당일꺼 왼쪽 네비게이션 바에 빼놓은거라고. /logistics 와 /cal/:date 는 같은 구조여야."
//
// 4 탭 layout (CalendarDetail 과 동일):
//   📥 입고 — target=내 측 · status ∈ {PENDING, APPROVED, IN_TRANSIT}
//   📤 출고 — source=내 측 · status ∈ {PENDING, APPROVED}
//   🚚 운송 — 양측 · status=IN_TRANSIT
//   ✅ 완료 — 양측 · status ∈ {EXECUTED, AUTO_EXECUTED}
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  fetchPending, postOrderApprove, postOrderDispatch, postOrderReceive, postOrderReject,
  type PendingOrder,
} from '../api';
import { getRole, getScope } from '../auth';
import { ORDER_STATUS_KO, ORDER_TYPE_KO, REJECTION_STAGE_KO } from '../labels';
import { useLocations } from '../useLocations';
import { useToast } from '../components/Toast';
import UsageGuide, { type GuideEntry } from '../components/UsageGuide';

type ToastShow = (msg: string, type: 'success' | 'error' | 'info' | 'warning') => void;
type Tab = 'inbound' | 'outbound' | 'in_transit' | 'executed';

// 이슈5 2026-05-16 — 입출고 페이지 role별 사용법 안내.
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

// 이슈10 2026-05-16: chained WH_TO_STORE 판별 —
//   상위 발주(WH_TRANSFER/PUBLISHER_ORDER) 실행 후 자동 생성된 결과물(이미 APPROVED 강제).
//   forecast_rationale.auto_approved=true 표식. hq 는 강제승인/발송/수령 대상 아님(read-only 관제).
function isChained(o: PendingOrder): boolean {
  return o.forecast_rationale?.auto_approved === true;
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

type Side = 'source' | 'target' | 'both' | 'none';
type Placement = { tab: Tab; side: Side };

// 이슈3 2026-05-16: WH_TO_STORE (물류센터→지점) 는 양면 업무 —
//   source(물류센터)=출고 탭 · target(지점)=입고 탭 양쪽에 분류.
//   양쪽 측을 다 가진 사용자(hq · source==target 권역 wh-manager)는 두 탭 모두 출현,
//   각 탭 row 의 액션은 그 탭 관점의 side 로 결정 (출고 탭=발송 / 입고 탭=수령 대기).
// 그 외 order_type 은 기존대로 한 탭에만 분류.
function classify(o: PendingOrder, role: string, scope: { scope_wh_id: number | null; scope_store_id: number | null }): {
  side: Side;
  placements: Placement[];
} {
  const isHq = role === 'hq-admin';
  const srcWh = (o as PendingOrder & { source_wh_id?: number | null }).source_wh_id;
  const tgtWh = (o as PendingOrder & { target_wh_id?: number | null }).target_wh_id;
  const isSrc = isHq
    || (scope.scope_store_id != null && o.source_location_id === scope.scope_store_id)
    || (scope.scope_wh_id != null && srcWh === scope.scope_wh_id);
  const isTgt = isHq
    || (scope.scope_store_id != null && o.target_location_id === scope.scope_store_id)
    || (scope.scope_wh_id != null && tgtWh === scope.scope_wh_id);

  const side: Side = isSrc && isTgt ? 'both' : isSrc ? 'source' : isTgt ? 'target' : 'none';
  const status = o.status;
  const placements: Placement[] = [];

  // v5 2026-05-15 피드백 #8: PENDING 은 /approval 전용 · /logistics 는 APPROVED+ 만
  if (status === 'IN_TRANSIT') {
    placements.push({ tab: 'in_transit', side });
  } else if (status === 'EXECUTED' || status === 'AUTO_EXECUTED') {
    placements.push({ tab: 'executed', side });
  } else if (status === 'APPROVED') {
    if (o.order_type === 'WH_TO_STORE') {
      // 양면 분류 — source 측이면 출고, target 측이면 입고 (둘 다면 양쪽)
      if (isSrc) placements.push({ tab: 'outbound', side: 'source' });
      if (isTgt) placements.push({ tab: 'inbound', side: 'target' });
      if (!isSrc && !isTgt) placements.push({ tab: 'inbound', side });
    } else if (isTgt && !isSrc) {
      placements.push({ tab: 'inbound', side });
    } else if (isSrc && !isTgt) {
      placements.push({ tab: 'outbound', side });
    } else {
      placements.push({ tab: 'inbound', side });  // BOTH (hq) default → inbound
    }
  }
  return { side, placements };
}

function ActionButtons({ order, side, onDone }: { order: PendingOrder; side: 'source' | 'target' | 'both' | 'none'; onDone: () => void }) {
  const role = getRole()!;
  const { showToast } = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['orders'] });
    qc.invalidateQueries({ queryKey: ['logistics'] });
    qc.invalidateQueries({ queryKey: ['calendar'] });
    qc.invalidateQueries({ queryKey: ['approval'] });
    onDone();
  };
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
    } finally { setBusy(false); }
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
  //   실행 주체는 물류센터(발송)·지점(수령)뿐.
  const chainedReadOnly = isChained(order) && role === 'hq-admin';
  if (chainedReadOnly) {
    return <span className="text-xs text-bf-muted">{ORDER_STATUS_KO[st] ?? st} · 자동 (관제)</span>;
  }
  if (st === 'PENDING') {
    return (
      <div className="flex gap-1">
        <button type="button" className="bf-btn-primary text-xs" disabled={busy} onClick={onApprove}>✓ 동의</button>
        <button type="button" className="bf-btn-danger-secondary text-xs" disabled={busy} onClick={onReject}>✗ 거부</button>
      </div>
    );
  }
  if (st === 'APPROVED') {
    if (side === 'source' || side === 'both' || role === 'hq-admin') {
      return (
        <div className="flex gap-1">
          <button type="button" className="bf-btn-primary text-xs" disabled={busy} onClick={onDispatch}>🚚 발송</button>
          <button type="button" className="bf-btn-danger-secondary text-xs" disabled={busy} onClick={onReject}>✗ 취소</button>
        </div>
      );
    }
    return <span className="text-xs text-bf-muted">상대 측 발송 대기</span>;
  }
  if (st === 'IN_TRANSIT') {
    if (side === 'target' || side === 'both' || role === 'hq-admin') {
      return (
        <div className="flex gap-1">
          <button type="button" className="bf-btn-primary text-xs" disabled={busy} onClick={onReceive}>📦 수령</button>
          <button type="button" className="bf-btn-danger-secondary text-xs" disabled={busy} onClick={onReject}>↩ 반품</button>
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

function ExecutedGroup({ label, rows, nameOf, onDone }: {
  label: string;
  rows: { order: PendingOrder; side: Side }[];
  nameOf: (id: number | undefined) => string | undefined;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(true);
  // 책별 sub-그룹 (같은 ISBN 묶기 — 과거 기록 가시성 ↑)
  const byBook: Record<string, { order: PendingOrder; side: Side }[]> = {};
  for (const e of rows) {
    const key = `${e.order.isbn13}|${e.order.title ?? ''}`;
    (byBook[key] = byBook[key] || []).push(e);
  }
  const books = Object.entries(byBook).sort((a, b) => b[1].length - a[1].length);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-3 py-2 flex items-center justify-between text-sm font-medium bg-bf-surface/50 hover:bg-bf-surface"
      >
        <span>{open ? '▼' : '▶'} {label}</span>
        <span className="text-xs text-bf-muted">{books.length} 도서 · {rows.length} 건</span>
      </button>
      {open && (
        <div className="divide-y divide-bf-border">
          {books.map(([key, list]) => {
            const [isbn, title] = key.split('|');
            const totalQty = list.reduce((s, e) => s + e.order.qty, 0);
            return (
              <div key={key} className="px-3 py-2">
                <div className="text-sm font-medium truncate">
                  {title || `ISBN ${isbn}`} <span className="text-xs text-bf-muted">· ISBN {isbn} · 총 {totalQty}권 · {list.length}건</span>
                </div>
                <div className="mt-1 space-y-0.5">
                  {list.map(({ order: o, side }) => (
                    <div key={o.order_id} className="text-xs text-bf-muted flex items-center gap-2">
                      <span>{nameOf(o.source_location_id ?? undefined) ?? '외부'} → {nameOf(o.target_location_id ?? undefined) ?? '?'} · {o.qty}권</span>
                      <span className="px-1.5 py-0.5 rounded bg-bf-surface border border-bf-border">
                        {ORDER_STATUS_KO[o.status] ?? o.status}
                      </span>
                      <span className="ml-auto"><ActionButtons order={o} side={side} onDone={onDone} /></span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// 이슈11 2026-05-16: 일괄 발송/수령 — 현재 탭/scope 대상 일괄 처리.
//   출고 탭 → APPROVED 발송 대상 일괄 발송 · 입고 탭 → IN_TRANSIT 수령 대상 일괄 수령.
//   chained(auto_approved) 도 물류센터/지점 실행 주체는 일괄 대상에 포함 (hq read-only 제외).
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

  // hq 는 chained read-only — 일괄 대상에서 제외.
  const eligible = items.filter(({ order, side }) => {
    if (isChained(order) && role === 'hq-admin') return false;
    if (tab === 'outbound') {
      return order.status === 'APPROVED' && (side === 'source' || side === 'both' || role === 'hq-admin');
    }
    return order.status === 'IN_TRANSIT' && (side === 'target' || side === 'both' || role === 'hq-admin');
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
    qc.invalidateQueries({ queryKey: ['logistics'] });
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

export default function Logistics() {
  const role = getRole();
  const scope = getScope();
  const { nameOf } = useLocations(role ?? 'hq-admin');
  const date = todayIso();
  const [tab, setTab] = useState<Tab>('inbound');

  const q = useQuery({
    queryKey: ['orders', 'day', role, date],
    queryFn: () => fetchPending(role!, { limit: 5000, expected_date: date }),
    enabled: !!role,
    staleTime: 5000,
    refetchInterval: 10000,
  });

  // 이슈3: WH_TO_STORE 는 두 탭(출고+입고)에 출현 가능 → row 별 placement 별 entry 보관.
  const grouped = useMemo(() => {
    const empty: Record<Tab, { order: PendingOrder; side: Side }[]> =
      { inbound: [], outbound: [], in_transit: [], executed: [] };
    if (!q.data || !role) return empty;
    const result: Record<Tab, { order: PendingOrder; side: Side }[]> =
      { inbound: [], outbound: [], in_transit: [], executed: [] };
    for (const o of q.data.items as PendingOrder[]) {
      const { placements } = classify(o, role, scope);
      for (const p of placements) result[p.tab].push({ order: o, side: p.side });
    }
    return result;
  }, [q.data, role, scope]);

  if (!role) return null;
  const counts = {
    inbound: grouped.inbound.length,
    outbound: grouped.outbound.length,
    in_transit: grouped.in_transit.length,
    executed: grouped.executed.length,
  };
  const items = grouped[tab];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">🚚 입출고 · 오늘 {date}</h1>
          <div className="text-sm text-bf-muted mt-0.5">
            <Link to="/calendar" className="text-bf-primary hover:underline">📅 캘린더</Link> 의 오늘 cell 과 동일. 다른 날짜는 캘린더에서 클릭.
          </div>
        </div>
        {q.isFetching && <span className="text-xs text-bf-muted">갱신 중…</span>}
      </div>

      <UsageGuide title="입출고 페이지 사용법" role={role} entries={LOGISTICS_GUIDE} />

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
            <div className="p-6 text-center text-sm text-bf-muted">오늘 처리할 항목이 없습니다.</div>
          ) : tab === 'executed' ? (
            /* 완료 탭 — order_type 별 그룹핑 (사용자 요청: 리스트만이라 보기 어려움) */
            (() => {
              const groups: Record<string, { order: PendingOrder; side: Side }[]> = {};
              for (const e of items) {
                const key = e.order.order_type;
                (groups[key] = groups[key] || []).push(e);
              }
              const order: string[] = ['REBALANCE', 'WH_TO_STORE', 'WH_TRANSFER', 'PUBLISHER_ORDER'];
              return order.filter((k) => groups[k]?.length).map((k) => (
                <ExecutedGroup
                  key={k}
                  label={`${ORDER_TYPE_KO[k] ?? k} (${groups[k].length})`}
                  rows={groups[k]}
                  nameOf={nameOf}
                  onDone={() => q.refetch()}
                />
              ));
            })()
          ) : (
            items.map(({ order: o, side }) => {
              return (
                <div key={`${o.order_id}-${side}`} className="p-3 flex items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      {ORDER_TYPE_KO[o.order_type] ?? o.order_type} · ISBN {o.isbn13} · 수량 {o.qty}
                      {o.title && <span className="text-bf-muted ml-2">{o.title}</span>}
                    </div>
                    <div className="text-xs text-bf-muted mt-0.5">
                      {nameOf(o.source_location_id ?? undefined) ?? '외부'} → {nameOf(o.target_location_id ?? undefined) ?? '?'}
                      <span className="ml-2 px-1.5 py-0.5 rounded bg-bf-surface border border-bf-border">
                        {ORDER_STATUS_KO[o.status] ?? o.status}
                      </span>
                      {/* v5: side 별 시점 다름 — source 발송 / target 도착 */}
                      {(() => {
                        const eaa = (o as PendingOrder & { expected_arrival_at?: string | null }).expected_arrival_at;
                        const dispAt = (o as PendingOrder & { dispatched_at?: string | null }).dispatched_at;
                        const dispDate = dispAt ? new Date(dispAt).toISOString().slice(0,10) : null;
                        if (side === 'source') return <span className="ml-2">📤 출고 {dispDate ?? '예정'}</span>;
                        if (side === 'target') return <span className="ml-2">📥 도착 {eaa ?? '?'}</span>;
                        if (side === 'both' && eaa) return <span className="ml-2">📦 {eaa}</span>;
                        return null;
                      })()}
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
