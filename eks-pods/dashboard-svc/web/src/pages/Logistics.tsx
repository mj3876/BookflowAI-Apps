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

type ToastShow = (msg: string, type: 'success' | 'error' | 'info' | 'warning') => void;
type Tab = 'inbound' | 'outbound' | 'in_transit' | 'executed';

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function classify(o: PendingOrder, role: string, scope: { scope_wh_id: number | null; scope_store_id: number | null }): {
  side: 'source' | 'target' | 'both' | 'none';
  tab: Tab | null;
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

  const status = o.status;
  let tab: Tab | null = null;
  // v5 2026-05-15 피드백 #8: PENDING 은 /approval 전용 · /logistics 는 APPROVED+ 만
  if (status === 'IN_TRANSIT') tab = 'in_transit';
  else if (status === 'EXECUTED' || status === 'AUTO_EXECUTED') tab = 'executed';
  else if (status === 'APPROVED') {
    if (isTgt && !isSrc) tab = 'inbound';
    else if (isSrc && !isTgt) tab = 'outbound';
    else tab = 'inbound';  // BOTH (hq) default → inbound
  }

  const side: 'source' | 'target' | 'both' | 'none' =
    isSrc && isTgt ? 'both' : isSrc ? 'source' : isTgt ? 'target' : 'none';
  return { side, tab };
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

function ExecutedGroup({ label, rows, nameOf, role, scope, onDone }: {
  label: string;
  rows: PendingOrder[];
  nameOf: (id: number | undefined) => string | undefined;
  role: string;
  scope: { scope_wh_id: number | null; scope_store_id: number | null };
  onDone: () => void;
}) {
  const [open, setOpen] = useState(true);
  // 책별 sub-그룹 (같은 ISBN 묶기 — 과거 기록 가시성 ↑)
  const byBook: Record<string, PendingOrder[]> = {};
  for (const o of rows) {
    const key = `${o.isbn13}|${o.title ?? ''}`;
    (byBook[key] = byBook[key] || []).push(o);
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
            const totalQty = list.reduce((s, o) => s + o.qty, 0);
            return (
              <div key={key} className="px-3 py-2">
                <div className="text-sm font-medium truncate">
                  {title || `ISBN ${isbn}`} <span className="text-xs text-bf-muted">· ISBN {isbn} · 총 {totalQty}권 · {list.length}건</span>
                </div>
                <div className="mt-1 space-y-0.5">
                  {list.map((o) => {
                    const { side } = classify(o, role, scope);
                    return (
                      <div key={o.order_id} className="text-xs text-bf-muted flex items-center gap-2">
                        <span>{nameOf(o.source_location_id ?? undefined) ?? '외부'} → {nameOf(o.target_location_id ?? undefined) ?? '?'} · {o.qty}권</span>
                        <span className="px-1.5 py-0.5 rounded bg-bf-surface border border-bf-border">
                          {ORDER_STATUS_KO[o.status] ?? o.status}
                        </span>
                        <span className="ml-auto"><ActionButtons order={o} side={side} onDone={onDone} /></span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
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

  const grouped = useMemo(() => {
    if (!q.data || !role) return { inbound: [], outbound: [], in_transit: [], executed: [] };
    const result: Record<Tab, PendingOrder[]> = { inbound: [], outbound: [], in_transit: [], executed: [] };
    for (const o of q.data.items as PendingOrder[]) {
      const { tab: t } = classify(o, role, scope);
      if (t) result[t].push(o);
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
            <div className="p-6 text-center text-sm text-bf-muted">오늘 처리할 항목이 없습니다.</div>
          ) : tab === 'executed' ? (
            /* 완료 탭 — order_type 별 그룹핑 (사용자 요청: 리스트만이라 보기 어려움) */
            (() => {
              const groups: Record<string, PendingOrder[]> = {};
              for (const o of items) {
                const key = o.order_type;
                (groups[key] = groups[key] || []).push(o);
              }
              const order: string[] = ['REBALANCE', 'WH_TO_STORE', 'WH_TRANSFER', 'PUBLISHER_ORDER'];
              return order.filter((k) => groups[k]?.length).map((k) => (
                <ExecutedGroup
                  key={k}
                  label={`${ORDER_TYPE_KO[k] ?? k} (${groups[k].length})`}
                  rows={groups[k]}
                  nameOf={nameOf}
                  role={role}
                  scope={scope}
                  onDone={() => q.refetch()}
                />
              ));
            })()
          ) : (
            items.map((o) => {
              const { side } = classify(o, role, scope);
              return (
                <div key={o.order_id} className="p-3 flex items-center justify-between gap-3">
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
