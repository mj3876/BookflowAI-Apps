// PR-C v3 (2026-05-15) 입출고 페이지 — 사이드바 진입.
// 4-step state machine 의 2~3 단계: APPROVED + IN_TRANSIT 만 표시.
// 양측 협의 완료된 최종 계획안 → source 측 [🚚 출고] → target 측 [📦 입고].
// EXECUTED 되면 이 페이지에서 사라짐 (완료).
//
// scope 자동 필터 (backend 가 처리):
//   hq-admin       — 모든 row
//   wh-manager-X   — 자기 권역 (source 또는 target)
//   branch-clerk-S — 자기 매장 (source 또는 target)
//
// 액션 매트릭스:
//   APPROVED  + source=내 측 → [🚚 출고] / [⚡ 자동 완료(시연)]
//   APPROVED  + target=내 측 → 대기 (상대 발송)
//   IN_TRANSIT + source=내 측 → 운송 중 (상대 수령 대기)
//   IN_TRANSIT + target=내 측 → [📦 입고] / [↩ 반품]
//   양측(BOTH) — 둘 다 가능 (예: hq-admin)
import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import {
  fetchPending, postOrderDispatch, postOrderReceive, postOrderReject,
  type PendingOrder,
} from '../api';
import { getRole, getScope } from '../auth';
import { ORDER_STATUS_KO, ORDER_TYPE_KO } from '../labels';
import { useLocations } from '../useLocations';
import { useToast } from '../components/Toast';

type StatusFilter = 'all' | 'APPROVED' | 'IN_TRANSIT';

function whichSide(o: PendingOrder, scope: { scope_wh_id: number | null; scope_store_id: number | null }): 'SOURCE' | 'TARGET' | 'BOTH' | null {
  const srcWh = (o as PendingOrder & { source_wh_id?: number | null }).source_wh_id;
  const tgtWh = (o as PendingOrder & { target_wh_id?: number | null }).target_wh_id;
  const isSrc = (scope.scope_store_id != null && o.source_location_id === scope.scope_store_id)
    || (scope.scope_wh_id != null && srcWh === scope.scope_wh_id);
  const isTgt = (scope.scope_store_id != null && o.target_location_id === scope.scope_store_id)
    || (scope.scope_wh_id != null && tgtWh === scope.scope_wh_id);
  if (isSrc && isTgt) return 'BOTH';
  if (isSrc) return 'SOURCE';
  if (isTgt) return 'TARGET';
  return null;
}

export default function Logistics() {
  const role = getRole();
  const scope = getScope();
  const { nameOf } = useLocations(role ?? 'hq-admin');
  const { showToast } = useToast();
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  // backend /queue 는 default 가 PENDING — 우리는 APPROVED+IN_TRANSIT 가 필요.
  // include_history=true (deprecated 표시지만 작동) 로 처리 완료 전 row 모두 가져옴.
  const q = useQuery({
    queryKey: ['logistics', role],
    queryFn: () => fetchPending(role!, { limit: 500, include_history: true, days: 30 }),
    enabled: !!role,
    staleTime: 5000,
    refetchInterval: 8000,
  });

  const items = useMemo(() => {
    const list = (q.data?.items as PendingOrder[] | undefined) ?? [];
    return list.filter((o) => {
      if (o.status !== 'APPROVED' && o.status !== 'IN_TRANSIT') return false;
      if (statusFilter !== 'all' && o.status !== statusFilter) return false;
      return true;
    });
  }, [q.data, statusFilter]);

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['logistics'] });
    qc.invalidateQueries({ queryKey: ['approval'] });
    qc.invalidateQueries({ queryKey: ['calendar'] });
    qc.invalidateQueries({ queryKey: ['heatmap'] });
    qc.invalidateQueries({ queryKey: ['inv'] });
  };

  const dispatchMu = useMutation({
    mutationFn: (id: string) => postOrderDispatch(role!, id, {}),
    onSuccess: () => { showToast({ type: 'success', message: '🚚 출고 처리 — 운송 중' }); invalidateAll(); },
    onError: (e: Error) => showToast({ type: 'error', message: `출고 실패: ${e.message}` }),
  });

  const receiveMu = useMutation({
    mutationFn: (id: string) => postOrderReceive(role!, id, {}),
    onSuccess: () => { showToast({ type: 'success', message: '📦 입고 처리 — 운송 완료' }); invalidateAll(); },
    onError: (e: Error) => showToast({ type: 'error', message: `입고 실패: ${e.message}` }),
  });

  const rejectMu = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => postOrderReject(role!, id, { reject_reason: reason }),
    onSuccess: () => { showToast({ type: 'warning', message: '↩ 거부 — IN_TRANSIT 거부 시 source 재고 복원' }); invalidateAll(); },
    onError: (e: Error) => showToast({ type: 'error', message: `거부 실패: ${e.message}` }),
  });

  const [autoBusy, setAutoBusy] = useState<string | null>(null);
  const autoComplete = async (id: string) => {
    // 시연용 자동 완료: dispatch + receive 순차 호출.
    if (autoBusy) return;
    setAutoBusy(id);
    try {
      await postOrderDispatch(role!, id, {});
      await postOrderReceive(role!, id, {});
      showToast({ type: 'success', message: '⚡ 시연 자동 완료 — 출고+입고 처리' });
      invalidateAll();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast({ type: 'error', message: `자동 완료 실패: ${msg}` });
    } finally {
      setAutoBusy(null);
    }
  };

  if (!role) return null;

  const filters: { key: StatusFilter; label: string }[] = [
    { key: 'all', label: '전체' },
    { key: 'APPROVED', label: '📋 계획 확정 (발송 대기)' },
    { key: 'IN_TRANSIT', label: '🚚 운송 중' },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">🚚 입출고</h1>
          <div className="text-sm text-bf-muted mt-0.5">
            <a href="/approval" className="text-bf-primary hover:underline">협의</a> 가 끝난 최종 계획안. 출고/입고가 끝나면 자동으로 완료됩니다.
          </div>
        </div>
        {q.isFetching && <span className="text-xs text-bf-muted">갱신 중…</span>}
      </div>

      <div className="bf-card p-2">
        <div className="flex gap-1 flex-wrap">
          {filters.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setStatusFilter(f.key)}
              className={`px-3 py-1 text-xs rounded ${statusFilter === f.key ? 'bg-bf-primary text-white' : 'bg-bf-surface text-bf-muted hover:text-bf-text'}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="bf-card divide-y divide-bf-border">
        {items.length === 0 ? (
          <div className="p-6 text-center text-sm text-bf-muted">처리할 입출고 항목이 없습니다.</div>
        ) : (
          items.map((o) => {
            const side = whichSide(o, scope);
            const isHq = role === 'hq-admin';
            const canDispatch = o.status === 'APPROVED' && (isHq || side === 'SOURCE' || side === 'BOTH');
            const canReceive = o.status === 'IN_TRANSIT' && (isHq || side === 'TARGET' || side === 'BOTH');
            const canReject = isHq || side !== null;
            const busy = autoBusy === o.order_id;
            return (
              <div key={o.order_id} className="p-3 flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">{ORDER_TYPE_KO[o.order_type] ?? o.order_type}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${o.status === 'IN_TRANSIT' ? 'bg-bf-warn/10 text-bf-warn border-bf-warn/30' : 'bg-bf-primary/10 text-bf-primary border-bf-primary/30'}`}>
                      {ORDER_STATUS_KO[o.status] ?? o.status}
                    </span>
                    {side && side !== 'BOTH' && !isHq && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${side === 'SOURCE' ? 'bg-bf-primary/10 text-bf-primary border-bf-primary/30' : 'bg-bf-success/10 text-bf-success border-bf-success/30'}`}>
                        {side === 'SOURCE' ? '📤 내 측이 출고' : '📥 내 측이 입고'}
                      </span>
                    )}
                  </div>
                  {o.title && (
                    <div className="text-sm text-bf-text mt-0.5 truncate">{o.title}</div>
                  )}
                  <div className="text-xs text-bf-muted mt-1 truncate">
                    ISBN {o.isbn13} · 수량 {o.qty}권 · {nameOf(o.source_location_id ?? undefined) ?? '외부'} → {nameOf(o.target_location_id ?? undefined) ?? '?'}
                    {/* AA: 캘린더 연동 — 도착 예정일 클릭 시 그 날짜 detail */}
                    {(o as PendingOrder & { expected_arrival_at?: string | null }).expected_arrival_at && (
                      <Link
                        to={`/cal/${(o as PendingOrder & { expected_arrival_at?: string | null }).expected_arrival_at}`}
                        className="ml-2 text-bf-primary hover:underline"
                      >📅 {(o as PendingOrder & { expected_arrival_at?: string | null }).expected_arrival_at}</Link>
                    )}
                  </div>
                </div>
                <div className="flex-shrink-0 flex gap-1">
                  {canDispatch && (
                    <>
                      <button type="button" className="bf-btn-primary text-xs" disabled={dispatchMu.isPending || busy} onClick={() => dispatchMu.mutate(o.order_id)}>🚚 출고</button>
                      <button type="button" className="bf-btn-secondary text-xs" disabled={busy} onClick={() => autoComplete(o.order_id)} title="시연용: 출고+입고 한번에">⚡ 자동</button>
                    </>
                  )}
                  {canReceive && (
                    <button type="button" className="bf-btn-primary text-xs" disabled={receiveMu.isPending || busy} onClick={() => receiveMu.mutate(o.order_id)}>📦 입고</button>
                  )}
                  {!canDispatch && !canReceive && side && (
                    <span className="text-xs text-bf-muted">{o.status === 'APPROVED' ? '발송 대기' : '수령 대기'}</span>
                  )}
                  {canReject && (
                    <button
                      type="button"
                      className="bf-btn-danger-secondary text-xs"
                      disabled={rejectMu.isPending || busy}
                      onClick={() => {
                        const reason = window.prompt('거부 사유 (IN_TRANSIT 거부 시 재고 자동 복원)');
                        if (reason) rejectMu.mutate({ id: o.order_id, reason });
                      }}
                    >✗</button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
