// PR-C v3 (2026-05-15) 협의 페이지 — 사이드바 진입.
// 4-step state machine 의 1 단계: PENDING (양측 협의 중) 만 표시.
// 양측 ✓ 완료되면 → APPROVED 전환 → 이 페이지에서 사라짐 → /logistics 로 이동.
//
// scope 자동 필터 (backend `/intervention/queue` 가 처리 · v3 에서 branch-clerk 추가):
//   hq-admin       — 모든 PENDING
//   wh-manager-X   — source.wh_id=X 또는 target.wh_id=X
//   branch-clerk-S — source_location_id=S 또는 target_location_id=S
//
// 기존 legacy Approval.tsx (PUBLISHER_ORDER 전용 + DateHistoryTabs) 는 이 파일로 대체.
import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { fetchPending, postOrderApprove, postOrderReject, type PendingOrder } from '../api';
import { getRole, getScope } from '../auth';
import { ORDER_TYPE_KO, URGENCY_KO } from '../labels';
import { useLocations } from '../useLocations';
import { useToast } from '../components/Toast';

type StageFilter = 'all' | 'REBALANCE' | 'WH_TO_STORE' | 'WH_TRANSFER' | 'PUBLISHER_ORDER';

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

export default function Approval() {
  const role = getRole();
  const scope = getScope();
  const { nameOf } = useLocations(role ?? 'hq-admin');
  const { showToast } = useToast();
  const qc = useQueryClient();
  const [stage, setStage] = useState<StageFilter>('all');

  const q = useQuery({
    queryKey: ['approval', role, stage],
    queryFn: () => fetchPending(role!, {
      limit: 300,
      ...(stage !== 'all' ? { order_type: stage } : {}),
    }),
    enabled: !!role,
    staleTime: 5000,
    refetchInterval: 10000,
  });

  const items = useMemo(() => {
    const list = (q.data?.items as PendingOrder[] | undefined) ?? [];
    return list.filter((o) => o.status === 'PENDING');
  }, [q.data]);

  const approveMu = useMutation({
    mutationFn: (id: string) => postOrderApprove(role!, id, {}),
    onSuccess: (r) => {
      const m = r.transitioned ? '🚚 양측 협의 완료 — 입출고 섹션으로 이동' : '✓ 내 측 동의 완료 (상대 측 대기)';
      showToast({ type: 'success', message: m });
      qc.invalidateQueries({ queryKey: ['approval'] });
      qc.invalidateQueries({ queryKey: ['logistics'] });
      qc.invalidateQueries({ queryKey: ['calendar'] });
    },
    onError: (e: Error) => showToast({ type: 'error', message: `동의 실패: ${e.message}` }),
  });

  const rejectMu = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => postOrderReject(role!, id, { reject_reason: reason }),
    onSuccess: () => {
      showToast({ type: 'warning', message: '❌ 협의 단계 거부' });
      qc.invalidateQueries({ queryKey: ['approval'] });
      qc.invalidateQueries({ queryKey: ['calendar'] });
    },
    onError: (e: Error) => showToast({ type: 'error', message: `거부 실패: ${e.message}` }),
  });

  if (!role) return null;

  const stages: { key: StageFilter; label: string }[] = [
    { key: 'all', label: '전체' },
    { key: 'REBALANCE', label: '🔄 재분배' },
    { key: 'WH_TO_STORE', label: '🏬 매장 보충' },
    { key: 'WH_TRANSFER', label: '🚛 권역 이동' },
    { key: 'PUBLISHER_ORDER', label: '📦 외부 발주' },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">📋 협의 중</h1>
          <div className="text-sm text-bf-muted mt-0.5">
            양측 협의가 모두 완료되면 자동으로 <a href="/logistics" className="text-bf-primary hover:underline">입출고 섹션</a>으로 이동.
          </div>
        </div>
        {q.isFetching && <span className="text-xs text-bf-muted">갱신 중…</span>}
      </div>

      <div className="bf-card p-2">
        <div className="flex gap-1 flex-wrap">
          {stages.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setStage(s.key)}
              className={`px-3 py-1 text-xs rounded ${stage === s.key ? 'bg-bf-primary text-white' : 'bg-bf-surface text-bf-muted hover:text-bf-text'}`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="bf-card divide-y divide-bf-border">
        {items.length === 0 ? (
          <div className="p-6 text-center text-sm text-bf-muted">협의 대기 중인 항목이 없습니다.</div>
        ) : (
          items.map((o) => {
            const side = whichSide(o, scope);
            const isHq = role === 'hq-admin';
            const canAct = isHq || side === 'SOURCE' || side === 'TARGET' || side === 'BOTH';
            return (
              <div key={o.order_id} className="p-3 flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">{ORDER_TYPE_KO[o.order_type] ?? o.order_type}</span>
                    {o.urgency_level && o.urgency_level !== 'NORMAL' && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-bf-warn/10 text-bf-warn border border-bf-warn/30">
                        {URGENCY_KO[o.urgency_level] ?? o.urgency_level}
                      </span>
                    )}
                    {side && side !== 'BOTH' && !isHq && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${side === 'SOURCE' ? 'bg-bf-primary/10 text-bf-primary border-bf-primary/30' : 'bg-bf-success/10 text-bf-success border-bf-success/30'}`}>
                        {side === 'SOURCE' ? '📤 내 측이 출고' : '📥 내 측이 입고'}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-bf-muted mt-1 truncate">
                    ISBN {o.isbn13} · 수량 {o.qty}권 · {nameOf(o.source_location_id ?? undefined) ?? '외부'} → {nameOf(o.target_location_id) ?? '?'}
                  </div>
                </div>
                <div className="flex-shrink-0 flex gap-1">
                  {canAct ? (
                    <>
                      <button
                        type="button"
                        className="bf-btn-primary text-xs"
                        disabled={approveMu.isPending}
                        onClick={() => approveMu.mutate(o.order_id)}
                      >✓ 동의</button>
                      <button
                        type="button"
                        className="bf-btn-danger-secondary text-xs"
                        disabled={rejectMu.isPending}
                        onClick={() => {
                          const reason = window.prompt('거부 사유');
                          if (reason) rejectMu.mutate({ id: o.order_id, reason });
                        }}
                      >✗ 거부</button>
                    </>
                  ) : (
                    <span className="text-xs text-bf-muted">권한 없음</span>
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
