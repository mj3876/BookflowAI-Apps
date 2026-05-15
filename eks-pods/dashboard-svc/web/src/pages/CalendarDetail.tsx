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
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

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

function classify(o: PendingOrder, role: string, scope: { scope_wh_id: number | null; scope_store_id: number | null }): {
  side: 'source' | 'target' | 'both' | 'none';
  tab: Tab | null;
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

  const status = o.status;
  let tab: Tab | null = null;
  // v5 2026-05-15 피드백 #8: PENDING 은 /approval 전용 · CalendarDetail 는 APPROVED+ 만
  if (status === 'IN_TRANSIT') tab = 'in_transit';
  else if (status === 'EXECUTED' || status === 'AUTO_EXECUTED') tab = 'executed';
  else if (status === 'APPROVED') {
    if (isTgt && !isSrc) tab = 'inbound';
    else if (isSrc && !isTgt) tab = 'outbound';
    else tab = 'inbound'; // BOTH (hq) default
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

  const grouped = useMemo(() => {
    if (!q.data || !role) return { inbound: [], outbound: [], in_transit: [], executed: [] };
    // backend 가 이미 date filter — frontend 는 4 탭 분류만 수행.
    const result: Record<Tab, PendingOrder[]> = { inbound: [], outbound: [], in_transit: [], executed: [] };
    for (const o of q.data.items as PendingOrder[]) {
      const { tab: t } = classify(o, role, scope);
      if (t) result[t].push(o);
    }
    return result;
  }, [q.data, role, scope]);

  if (!role || !date) return null;
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
          <h1 className="text-xl font-semibold">📅 {date}</h1>
          <Link to="/calendar" className="text-xs text-bf-primary hover:underline">← 캘린더로</Link>
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
            <div className="p-6 text-center text-sm text-bf-muted">해당 날짜에 항목이 없습니다.</div>
          ) : tab === 'executed' ? (
            /* v5: 완료 탭 order_type × 도서별 그룹핑 (Logistics 와 동일) */
            (() => {
              const groups: Record<string, PendingOrder[]> = {};
              for (const o of items) { (groups[o.order_type] = groups[o.order_type] || []).push(o); }
              const order: string[] = ['REBALANCE', 'WH_TO_STORE', 'WH_TRANSFER', 'PUBLISHER_ORDER'];
              return order.filter((k) => groups[k]?.length).map((k) => {
                const byBook: Record<string, PendingOrder[]> = {};
                for (const o of groups[k]) {
                  const key = `${o.isbn13}|${o.title ?? ''}`;
                  (byBook[key] = byBook[key] || []).push(o);
                }
                const books = Object.entries(byBook).sort((a, b) => b[1].length - a[1].length);
                return (
                  <div key={k}>
                    <div className="px-3 py-2 text-sm font-medium bg-bf-surface/50">
                      {ORDER_TYPE_KO[k] ?? k} ({groups[k].length}) · {books.length} 도서
                    </div>
                    <div className="divide-y divide-bf-border">
                      {books.map(([bk, list]) => {
                        const [isbn, title] = bk.split('|');
                        const totalQty = list.reduce((s, o) => s + o.qty, 0);
                        return (
                          <div key={bk} className="px-3 py-2">
                            <div className="text-sm font-medium truncate">
                              {title || `ISBN ${isbn}`} <span className="text-xs text-bf-muted">· ISBN {isbn} · 총 {totalQty}권 · {list.length}건</span>
                            </div>
                            <div className="mt-1 space-y-0.5">
                              {list.map((o) => (
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
            items.map((o) => {
              const { side } = classify(o, role, scope);
              return (
                <div key={o.order_id} className="p-3 flex items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      {ORDER_TYPE_KO[o.order_type] ?? o.order_type} · ISBN {o.isbn13} · 수량 {o.qty}
                    </div>
                    <div className="text-xs text-bf-muted mt-0.5">
                      {nameOf(o.source_location_id ?? undefined) ?? '외부'} → {nameOf(o.target_location_id) ?? '?'}
                      <span className="ml-2 px-1.5 py-0.5 rounded bg-bf-surface border border-bf-border">
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
