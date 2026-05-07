import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { fetchInstructions, postInboundReceive, postIntervene, type Role } from '../api';
import { ko, ORDER_TYPE_KO, URGENCY_KO } from '../labels';
import ConfirmModal from '../components/ConfirmModal';
import EmptyState from '../components/EmptyState';
import HelpHint from '../components/HelpHint';
import InlineMessage from '../components/InlineMessage';
import { useLocations } from '../useLocations';

/**
 * UX-6 매장 입고 처리 — FR-A6.6 (지점 수동 개입).
 *
 * - 수령 (정상 입고 완료)  → confirm 후 status=EXECUTED 마킹 (intervention-svc 후속 처리)
 * - 거부 (수량 불일치 · 파손 · 누락) → 사유 입력 모달 → /intervene/reject 호출
 *
 * 거부 시 물류센터에 알림 (FR-A8.7) — notification-svc OrderRejected 이벤트 발행.
 */
const REJECT_REASONS = [
  '수량 부족',
  '파손 발견',
  '품목 불일치',
  '입고 시점 매장 영업 종료',
  '기타',
];

export default function BranchInbound() {
  const { role } = useOutletContext<{ role: Role }>();
  const my_store = 1; // branch-clerk default store
  const qc = useQueryClient();
  const { nameOf } = useLocations(role);

  const q = useQuery({
    queryKey: ['instr-all', role],
    queryFn: () => fetchInstructions(role),
    refetchInterval: 8000,
  });
  const myInbound = q.data?.items.filter((o) => o.target_location_id === my_store) ?? [];

  // Reject modal state
  const [rejectTarget, setRejectTarget] = useState<{ order_id: string; isbn13: string; qty: number } | null>(null);
  const [reason, setReason] = useState(REJECT_REASONS[0]);
  const [note, setNote] = useState('');
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [receiveTarget, setReceiveTarget] = useState<{ order_id: string; qty: number } | null>(null);

  const reject = useMutation({
    mutationFn: async (body: { order_id: string; approval_side: 'FINAL'; reject_reason: string }) => {
      const r = await postIntervene(role, 'reject', body);
      if (r.detail) throw new Error(r.detail);
      return r;
    },
    onSuccess: () => {
      setFeedback({ type: 'success', msg: '거부 처리됨 — 물류센터에 통보되었습니다' });
      setRejectTarget(null);
      setNote('');
      qc.invalidateQueries({ queryKey: ['instr-all', role] });
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      setFeedback({ type: 'error', msg: `거부 실패: ${msg}` });
    },
  });

  const receiveMu = useMutation({
    mutationFn: (id: string) => postInboundReceive(role, id),
    onSuccess: (r) => {
      if (r.detail) {
        setFeedback({ type: 'error', msg: `수령 실패: ${r.detail}` });
        return;
      }
      const tail = r.inventory_adjust === 'ADJUSTED' ? '· 매장 재고 반영됨' : '· 재고 반영 보류 (별도 처리)';
      setFeedback({
        type: 'success',
        msg: `수령 완료 (${r.qty ?? '?'}권) ${tail}`,
      });
      qc.invalidateQueries({ queryKey: ['instr-all', role] });
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      setFeedback({ type: 'error', msg: `수령 실패: ${msg}` });
    },
  });

  const handleReceiveConfirm = () => {
    if (!receiveTarget) return;
    receiveMu.mutate(receiveTarget.order_id);
    setReceiveTarget(null);
  };

  const handleReject = () => {
    if (!rejectTarget) return;
    const reasonText = note ? `${reason}: ${note}`.slice(0, 50) : reason;
    reject.mutate({
      order_id: rejectTarget.order_id,
      approval_side: 'FINAL',
      reject_reason: reasonText,
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="h1">{nameOf(my_store)} · 입고 확인</h1>
        <p className="text-bf-muted text-xs mt-1">
          물류센터에서 발송된 도서가 매장에 도착했을 때 처리하는 화면입니다.
          정상이면 <b>수령</b>, 수량/품질 문제가 있으면 <b>거부</b> 후 사유를 입력하면 물류센터에 즉시 통보됩니다.
        </p>
      </div>

      {feedback && (
        <InlineMessage
          type={feedback.type}
          message={feedback.msg}
          onClose={() => setFeedback(null)}
          autoDismissMs={feedback.type === 'success' ? 4000 : undefined}
        />
      )}

      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="h2 flex items-center">입고 대기 ({myInbound.length})<HelpHint text="물류센터에서 발송된 도서. 정상이면 수령, 수량/품질 문제가 있으면 거부합니다. 거부 사유는 물류센터에 즉시 통보됩니다." /></h2>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>승인 일시</th>
              <th>유형</th>
              <th>긴급도</th>
              <th>ISBN</th>
              <th>제목</th>
              <th>출발지</th>
              <th className="text-right">수량</th>
              <th className="text-right">처리</th>
            </tr>
          </thead>
          <tbody>
            {myInbound.map((o) => (
              <tr key={o.order_id}>
                <td className="text-bf-muted">{o.approved_at ? new Date(o.approved_at).toLocaleString('ko-KR') : '-'}</td>
                <td>{ko(ORDER_TYPE_KO, o.order_type)}</td>
                <td>
                  <span className={
                    o.urgency_level === 'CRITICAL' ? 'pill-rejected' :
                    o.urgency_level === 'URGENT'   ? 'pill-pending' : 'pill-info'
                  }>{ko(URGENCY_KO, o.urgency_level)}</span>
                </td>
                <td className="font-mono text-[11px]">{o.isbn13}</td>
                <td>{o.title ?? '-'}</td>
                <td>{o.source_location_id != null ? nameOf(o.source_location_id) : '-'}</td>
                <td className="text-right">{o.qty}권</td>
                <td className="text-right">
                  <div className="inline-flex gap-2">
                    <button
                      className="btn-primary btn-sm"
                      onClick={() => setReceiveTarget({ order_id: o.order_id, qty: o.qty })}
                    >
                      수령
                    </button>
                    <button
                      className="btn-secondary btn-sm text-bf-danger border-bf-danger"
                      onClick={() => setRejectTarget({ order_id: o.order_id, isbn13: o.isbn13, qty: o.qty })}
                    >
                      거부
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {myInbound.length === 0 && (
              <tr><td colSpan={8}>
                <EmptyState icon="📦" message="입고 대기 없음" hint="모든 발송 건이 수령 또는 거부 처리되었습니다" />
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 수령 확인 모달 */}
      <ConfirmModal
        open={receiveTarget !== null}
        title="수령 확인"
        message={receiveTarget ? `${receiveTarget.qty}권 수령을 확인하시겠습니까?\n수령 후 매장 재고에 자동 반영됩니다.` : ''}
        confirmText="수령 처리"
        onConfirm={handleReceiveConfirm}
        onCancel={() => setReceiveTarget(null)}
      />

      {/* 거부 사유 모달 */}
      {rejectTarget && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setRejectTarget(null)}
        >
          <div
            className="bg-bf-bg border border-bf-border rounded-lg p-5 w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="h2 mb-3">입고 거부 사유</h3>
            <div className="text-xs text-bf-muted mb-4">
              ISBN <span className="font-mono">{rejectTarget.isbn13}</span> · {rejectTarget.qty}권 입고를 거부합니다.
              물류센터에 알림이 전송됩니다.
            </div>
            <div className="space-y-3">
              <div>
                <div className="label-tag mb-1">사유 분류</div>
                <select className="ipt w-full" value={reason} onChange={(e) => setReason(e.target.value)}>
                  {REJECT_REASONS.map((r) => <option key={r}>{r}</option>)}
                </select>
              </div>
              <div>
                <div className="label-tag mb-1">상세 메모 (선택)</div>
                <textarea
                  className="ipt w-full h-20"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="예: 표지 5권 손상 확인"
                  maxLength={40}
                />
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn-secondary" onClick={() => setRejectTarget(null)}>취소</button>
              <button
                className="btn-primary text-bf-danger border-bf-danger"
                disabled={reject.isPending}
                onClick={handleReject}
              >
                {reject.isPending ? '처리 중…' : '거부 확정'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
