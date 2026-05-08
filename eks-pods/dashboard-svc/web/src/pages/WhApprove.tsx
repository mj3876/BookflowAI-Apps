import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { fetchPending, postIntervene, type Role } from '../api';
import ConfirmModal from '../components/ConfirmModal';

/**
 * 창고 승인 큐 - 자기 wh 의 Stage 1 (REBALANCE) + Stage 2 (WH_TRANSFER SOURCE/TARGET) 분리.
 *
 * 백엔드 intervention-svc /intervention/queue 가 role/scope_wh_id 자동 필터.
 * approval_side:
 *   - REBALANCE: FINAL (단독)
 *   - WH_TRANSFER: SOURCE/TARGET 둘 중 자기 wh 사이드만 가능
 */
export default function WhApprove() {
  const { role } = useOutletContext<{ role: Role }>();
  const qc = useQueryClient();
  const my_wh = role === 'wh-manager-2' ? 2 : 1;
  const [tab, setTab] = useState<'REBALANCE' | 'WH_TRANSFER' | 'PUBLISHER_ORDER'>('REBALANCE');
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<{ order_id: string; side: 'FINAL' | 'SOURCE' | 'TARGET' } | null>(null);
  const [approveTarget, setApproveTarget] = useState<{ order_id: string; side: 'FINAL' | 'SOURCE' | 'TARGET'; isbn13: string; qty: number; isPublisher: boolean } | null>(null);

  const pending = useQuery({
    queryKey: ['pending', tab, role],
    queryFn: () => fetchPending(role, { order_type: tab, limit: 50 }),
    refetchInterval: 5000,
  });

  const act = useMutation({
    mutationFn: async (a: { order_id: string; action: 'approve' | 'reject'; side: 'FINAL' | 'SOURCE' | 'TARGET'; reason?: string }) => {
      const body = a.action === 'reject'
        ? { order_id: a.order_id, approval_side: a.side, reject_reason: a.reason ?? 'WH 거절' }
        : { order_id: a.order_id, approval_side: a.side };
      return postIntervene(role, a.action, body);
    },
    onMutate: (v) => { setBusy(v.order_id); setFeedback(null); },
    onSuccess: (d, v) => {
      setBusy(null);
      setFeedback(`${v.action === 'approve' ? '✓' : '✓'} ${v.side} ${v.action} · ${d.approval_id ?? d.order_id ?? d.detail}`);
      qc.invalidateQueries({ queryKey: ['pending'] });
    },
    onError: (e) => { setBusy(null); setFeedback(`✗ 실패: ${String(e)}`); },
  });

  if (role !== 'wh-manager-1' && role !== 'wh-manager-2') {
    return (
      <div className="card text-center text-bf-muted text-xs py-10">
        창고 매니저 권한이 필요합니다.
      </div>
    );
  }

  // Stage 2 의 source/target 어느 쪽이 내 wh 인지 표시
  const sideForOrder = (o: { source_location_id: number | null; target_location_id: number | null }) => {
    // location_id 매핑: 1-2 = 창고 (wh1/wh2), 3-8 = wh1 매장, 9-14 = wh2 매장
    const wh = (id: number | null) => id === null ? null : (id <= 2 ? id : id <= 8 ? 1 : 2);
    if (wh(o.source_location_id) === my_wh) return 'SOURCE';
    if (wh(o.target_location_id) === my_wh) return 'TARGET';
    return null;
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="h1">{my_wh === 1 ? '수도권' : '영남'} 권역 · 처리 대기</h1>
        <p className="text-bf-muted text-xs mt-1">
          내 권역 관련 처리 대기 건만 표시됩니다. 권역 내 재분배는 단독 승인,
          권역 간 이동은 양쪽 권역 매니저 승인 필요, 외부 발주는 자기 권역분 단독 승인 (비용 발생).
        </p>
      </div>

      {feedback && (
        <div className={`card-tight text-xs ${feedback.startsWith('✓') ? 'text-bf-success' : 'text-bf-danger'}`}>
          {feedback}
        </div>
      )}

      <div className="flex gap-2 border-b border-bf-border">
        <button
          className={`px-4 py-2 text-xs font-medium border-b-2 ${tab === 'REBALANCE' ? 'border-bf-primary text-bf-primary' : 'border-transparent text-bf-muted'}`}
          onClick={() => setTab('REBALANCE')}
        >
          권역 내 재분배 (단독 승인)
        </button>
        <button
          className={`px-4 py-2 text-xs font-medium border-b-2 ${tab === 'WH_TRANSFER' ? 'border-bf-primary text-bf-primary' : 'border-transparent text-bf-muted'}`}
          onClick={() => setTab('WH_TRANSFER')}
        >
          권역 간 이동 (양측 승인 필요)
        </button>
        <button
          className={`px-4 py-2 text-xs font-medium border-b-2 ${tab === 'PUBLISHER_ORDER' ? 'border-bf-primary text-bf-primary' : 'border-transparent text-bf-muted'}`}
          onClick={() => setTab('PUBLISHER_ORDER')}
        >
          외부 발주 (자기 권역분 · 비용 발생)
        </button>
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="h2">
            {tab === 'REBALANCE' ? '재분배 (자기 권역 내)'
              : tab === 'WH_TRANSFER' ? '권역 이동 (수도권 ↔ 영남)'
              : '외부 발주 (자기 권역분)'}
            <span className="text-bf-muted ml-2">({pending.data?.items.length ?? 0})</span>
          </h2>
          <span className="label-tag">5초마다 자동 갱신</span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>긴급도</th>
              <th>ISBN</th>
              <th>출발 → 도착</th>
              {tab === 'WH_TRANSFER' && <th>나의 사이드</th>}
              <th>수량</th>
              <th>자동 실행</th>
              <th>생성</th>
              <th className="text-right">액션</th>
            </tr>
          </thead>
          <tbody>
            {pending.data?.items.map((o) => {
              // REBALANCE/PUBLISHER_ORDER 는 'FINAL' (단독 승인) · WH_TRANSFER 는 sideForOrder() 로 자기 측 (SOURCE/TARGET)
              const side = tab === 'WH_TRANSFER' ? sideForOrder(o) : 'FINAL' as const;
              const isPublisher = tab === 'PUBLISHER_ORDER';
              return (
                <tr key={o.order_id}>
                  <td>
                    <span className={
                      o.urgency_level === 'CRITICAL' ? 'pill-rejected' :
                      o.urgency_level === 'URGENT'   ? 'pill-pending' : 'pill-info'
                    }>{o.urgency_level}</span>
                  </td>
                  <td className="font-mono text-[11px]">{o.isbn13}</td>
                  <td>{o.source_location_id ?? '-'} → {o.target_location_id ?? '-'}</td>
                  {tab === 'WH_TRANSFER' && (
                    <td>{side ? <span className="pill-info">{side === 'SOURCE' ? '출고 측' : '입고 측'}</span> : <span className="text-bf-muted text-[10px]">-</span>}</td>
                  )}
                  <td>{o.qty}</td>
                  <td className="text-bf-muted">-</td>
                  <td className="text-bf-muted">{new Date(o.created_at).toLocaleString()}</td>
                  <td className="text-right">
                    {side ? (
                      <div className="flex gap-1 justify-end">
                        <button
                          className="btn-primary btn-sm"
                          disabled={busy === o.order_id}
                          onClick={() => setApproveTarget({ order_id: o.order_id, side: side as 'FINAL' | 'SOURCE' | 'TARGET', isbn13: o.isbn13, qty: o.qty, isPublisher })}
                        >
                          {tab === 'REBALANCE' ? '승인'
                            : tab === 'PUBLISHER_ORDER' ? '발주 승인'
                            : (side === 'SOURCE' ? '출고 승인' : '입고 승인')}
                        </button>
                        <button
                          className="btn-danger btn-sm"
                          disabled={busy === o.order_id}
                          onClick={() => setRejectTarget({ order_id: o.order_id, side: side as 'FINAL' | 'SOURCE' | 'TARGET' })}
                        >
                          거절
                        </button>
                      </div>
                    ) : (
                      <span className="text-[10px] text-bf-muted">권한 없음</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {pending.data?.items.length === 0 && (
              <tr><td colSpan={tab === 'WH_TRANSFER' ? 8 : 7} className="text-center py-6 text-bf-muted">대기 중인 주문 없음</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <ConfirmModal
        open={approveTarget !== null}
        title={approveTarget?.isPublisher ? '외부 발주 승인 (비용 발생)' : '승인'}
        message={
          approveTarget
            ? approveTarget.isPublisher
              ? `ISBN ${approveTarget.isbn13} · ${approveTarget.qty}권 외부 발주를 자기 권역분으로 승인합니다.\n\n비용이 발생합니다.`
              : `ISBN ${approveTarget.isbn13} · ${approveTarget.qty}권 처리를 승인합니다.${approveTarget.side === 'SOURCE' ? ' (출고 측)' : approveTarget.side === 'TARGET' ? ' (입고 측)' : ''}`
            : ''
        }
        confirmText={approveTarget?.isPublisher ? '발주 승인 (비용 발생)' : '승인'}
        onConfirm={() => {
          if (approveTarget) {
            act.mutate({ order_id: approveTarget.order_id, action: 'approve', side: approveTarget.side });
            setApproveTarget(null);
          }
        }}
        onCancel={() => setApproveTarget(null)}
        isLoading={act.isPending}
      />

      <ConfirmModal
        open={rejectTarget !== null}
        title="거절"
        message={`처리 요청을 거절합니다 (order_id: ${rejectTarget?.order_id.slice(0, 8) ?? ''}).\n사유는 발의자에게 알림으로 전달됩니다.`}
        confirmText="거절"
        danger
        withReason
        reasonRequired
        reasonLabel="거절 사유"
        reasonPlaceholder="예: 재고 부족 / 출고 일정 불가 / 정책 외"
        onConfirm={(reason) => {
          if (rejectTarget && reason) {
            act.mutate({ order_id: rejectTarget.order_id, action: 'reject', side: rejectTarget.side, reason });
            setRejectTarget(null);
          }
        }}
        onCancel={() => setRejectTarget(null)}
        isLoading={act.isPending}
      />
    </div>
  );
}
