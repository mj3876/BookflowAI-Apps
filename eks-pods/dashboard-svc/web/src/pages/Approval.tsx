import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { fetchPending, postIntervene, type Role } from '../api';
import { useLocations } from '../useLocations';
import ConfirmModal from '../components/ConfirmModal';

/**
 * HQ Approval - Stage 3 (PUBLISHER_ORDER) 단독 최종 승인.
 * Stage 1/2 는 WH 매니저 권한 (별도 페이지).
 */
export default function Approval() {
  const { role } = useOutletContext<{ role: Role }>();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<string | null>(null);
  const [approveTarget, setApproveTarget] = useState<{ order_id: string; isbn13: string; qty: number } | null>(null);
  const { nameOf } = useLocations(role);

  // PUBLISHER_ORDER 만 필터 (HQ 가 처리할 외부 발주)
  const pending = useQuery({
    queryKey: ['pending', 'PUBLISHER_ORDER', role],
    queryFn: () => fetchPending(role, { order_type: 'PUBLISHER_ORDER', limit: 50 }),
    refetchInterval: 5000,
  });

  const act = useMutation({
    mutationFn: async (a: { order_id: string; action: 'approve' | 'reject'; reason?: string }) => {
      const body = a.action === 'reject'
        ? { order_id: a.order_id, approval_side: 'FINAL', reject_reason: a.reason ?? 'HQ 거절' }
        : { order_id: a.order_id, approval_side: 'FINAL' };
      return postIntervene(role, a.action, body);
    },
    onMutate: (v) => { setBusy(v.order_id); setFeedback(null); },
    onSuccess: (d, v) => {
      setBusy(null);
      setFeedback(`${v.action === 'approve' ? '✓ 승인' : '✓ 거절'} · ${d.approval_id ?? d.order_id ?? d.detail}`);
      qc.invalidateQueries({ queryKey: ['pending'] });
    },
    onError: (e) => { setBusy(null); setFeedback(`✗ 실패: ${String(e)}`); },
  });

  if (role !== 'hq-admin') {
    return (
      <div className="card text-center text-bf-muted text-xs py-10">
        본사 관리자 (hq-admin) 권한이 필요합니다. Stage 1/2 결정은 창고 매니저 영역의 "승인 큐" 에서 처리됩니다.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="h1">외부 발주 (출판사) 최종 승인</h1>
        <p className="text-bf-muted text-xs mt-1">
          출판사에 발주하는 건은 비용이 발생하므로 본사 단독 최종 승인 단계입니다. 권역 간 이동은 물류센터 (창고 매니저) 영역이에요.
        </p>
      </div>

      {feedback && (
        <div className={`card-tight text-xs ${feedback.startsWith('✓') ? 'text-bf-success' : 'text-bf-danger'}`}>
          {feedback}
        </div>
      )}

      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="h2">외부 발주 대기 ({pending.data?.items.length ?? 0})</h2>
          <span className="label-tag">5초마다 자동 갱신</span>
        </div>
        <table className="data-table">
          <thead>
            <tr><th>긴급도</th><th>ISBN</th><th>도착</th><th>수량</th><th>생성</th><th className="text-right">액션</th></tr>
          </thead>
          <tbody>
            {pending.data?.items.map((o) => (
              <tr key={o.order_id}>
                <td>
                  <span className={
                    o.urgency_level === 'CRITICAL' ? 'pill-rejected' :
                    o.urgency_level === 'URGENT'   ? 'pill-pending' : 'pill-info'
                  }>{o.urgency_level}</span>
                </td>
                <td className="font-mono text-[11px]">{o.isbn13}</td>
                <td>{nameOf(o.target_location_id)}</td>
                <td>{o.qty}</td>
                <td className="text-bf-muted">{new Date(o.created_at).toLocaleString()}</td>
                <td className="text-right">
                  <div className="flex gap-1 justify-end">
                    <button
                      className="btn-primary btn-sm"
                      disabled={busy === o.order_id}
                      onClick={() => setApproveTarget({ order_id: o.order_id, isbn13: o.isbn13, qty: o.qty })}
                    >
                      승인
                    </button>
                    <button
                      className="btn-danger btn-sm"
                      disabled={busy === o.order_id}
                      onClick={() => setRejectTarget(o.order_id)}
                    >
                      거절
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {pending.data?.items.length === 0 && (
              <tr><td colSpan={6} className="text-center py-6 text-bf-muted">대기 중인 외부 발주 없음</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <ConfirmModal
        open={approveTarget !== null}
        title="외부 발주 승인"
        message={approveTarget ? `ISBN ${approveTarget.isbn13} · ${approveTarget.qty}권 외부 발주를 승인합니다.\n\n비용이 발생하는 결정이며, 승인 즉시 출판사에 발주 지시서가 전달됩니다.` : ''}
        confirmText="승인 (비용 발생)"
        onConfirm={() => {
          if (approveTarget) {
            act.mutate({ order_id: approveTarget.order_id, action: 'approve' });
            setApproveTarget(null);
          }
        }}
        onCancel={() => setApproveTarget(null)}
        isLoading={act.isPending}
      />

      <ConfirmModal
        open={rejectTarget !== null}
        title="외부 발주 거절"
        message={`PUBLISHER_ORDER 를 거절합니다 (order_id: ${rejectTarget?.slice(0, 8) ?? ''}).\n비용 발생 발주라 거절 후 신중히 다시 발의해야 합니다.`}
        confirmText="거절"
        danger
        withReason
        reasonRequired
        reasonLabel="거절 사유"
        reasonPlaceholder="예: 예산 미배정 / 단가 재협상 필요 / 분기 외"
        onConfirm={(reason) => {
          if (rejectTarget && reason) {
            act.mutate({ order_id: rejectTarget, action: 'reject', reason });
            setRejectTarget(null);
          }
        }}
        onCancel={() => setRejectTarget(null)}
        isLoading={act.isPending}
      />
    </div>
  );
}
