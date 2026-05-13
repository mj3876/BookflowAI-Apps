import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { fetchPending, postIntervene, type Role } from '../api';
import { useLocations } from '../useLocations';
import ConfirmModal from '../components/ConfirmModal';
import DateHistoryTabs from '../components/DateHistoryTabs';

/**
 * HQ Approval - Stage 3 (PUBLISHER_ORDER) 단독 최종 승인.
 * Stage 1/2 는 WH 매니저 권한 (별도 페이지).
 */
export default function Approval() {
  const { role } = useOutletContext<{ role: Role }>();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [rejectTarget, setRejectTarget] = useState<string | null>(null);
  const [approveTarget, setApproveTarget] = useState<{ order_id: string; isbn13: string; qty: number } | null>(null);
  const { nameOf } = useLocations(role);

  // PUBLISHER_ORDER 만 필터 (HQ 가 처리할 외부 발주)
  const pending = useQuery({
    queryKey: ['pending', 'PUBLISHER_ORDER', role],
    queryFn: () => fetchPending(role, { order_type: 'PUBLISHER_ORDER', limit: 500, include_history: true, days: 7 }),
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

  const bulkApprove = async () => {
    const items = (pending.data?.items ?? []) as any[];
    const approvable = items.filter((o) => o.status === 'PENDING');
    if (!approvable.length) { setFeedback('승인할 PENDING 항목이 없습니다.'); return; }
    if (!window.confirm(`외부 발주 PENDING ${approvable.length}건을 모두 승인합니다 (비용 발생). 진행할까요?`)) return;
    setBulkBusy(true);
    let ok = 0, ng = 0;
    for (const o of approvable) {
      try { await act.mutateAsync({ order_id: o.order_id, action: 'approve' }); ok++; }
      catch { ng++; }
      setFeedback(`일괄 승인 중… (${ok + ng}/${approvable.length}) · 성공 ${ok} 실패 ${ng}`);
    }
    setFeedback(`✓ 일괄 승인 완료 · 성공 ${ok} 실패 ${ng}`);
    setBulkBusy(false);
    qc.invalidateQueries({ queryKey: ['pending'] });
  };

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
        {/* D5-4 workflow link */}
        <div className="text-[11px] text-bf-muted mt-1">
          승인 → publisher API 발주 → <a href="/wh-instructions" className="text-bf-primary hover:underline">권역 입고 지시서</a> → <a href="/branch-inbound" className="text-bf-primary hover:underline">매장 입고</a>
        </div>
      </div>

      {feedback && (
        <div className={`card-tight text-xs ${feedback.startsWith('✓') ? 'text-bf-success' : 'text-bf-danger'}`}>
          {feedback}
        </div>
      )}

      <DateHistoryTabs
        items={pending.data?.items ?? []}
        days={6}
        pageLabel="외부 발주 처리 기록 7일"
        todayActions={
          <div className="flex items-center gap-2">
            <button
              className="btn-primary text-xs"
              onClick={bulkApprove}
              disabled={bulkBusy || (pending.data?.items ?? []).every((o: any) => o.status !== 'PENDING')}
              title="외부 발주 PENDING 전건 일괄 최종 승인"
            >
              {bulkBusy ? '진행 중…' : `전체 승인 (${(pending.data?.items ?? []).filter((o: any) => o.status === 'PENDING').length}건)`}
            </button>
            <span className="label-tag">5초마다 자동 갱신</span>
          </div>
        }
      >
        {(filtered, { isToday }) => (
          <div className="card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>긴급도</th>
                  <th>도서</th>
                  <th>도착</th>
                  <th>수량</th>
                  <th>{isToday ? '생성' : '처리 일시'}</th>
                  <th>상태</th>
                  {isToday && <th className="text-right">액션</th>}
                </tr>
              </thead>
              <tbody>
                {filtered.map((o: any) => {
                  const isPending = o.status === 'PENDING';
                  const ts = o.approved_at ?? o.executed_at ?? o.created_at;
                  return (
                    <tr key={o.order_id}>
                      <td>
                        <span className={
                          o.urgency_level === 'CRITICAL' ? 'pill-rejected' :
                          o.urgency_level === 'URGENT'   ? 'pill-pending' : 'pill-info'
                        }>{o.urgency_level}</span>
                      </td>
                      <td>
                        <div className="text-sm">{o.title ?? o.isbn13}</div>
                        <div className="font-mono text-[10px] text-bf-muted">{o.isbn13}</div>
                      </td>
                      <td>{nameOf(o.target_location_id)}</td>
                      <td>{o.qty}</td>
                      <td className="text-bf-muted text-[11px]">{ts ? new Date(ts).toLocaleString('ko-KR') : '-'}</td>
                      <td>
                        <span className={
                          o.status === 'PENDING' ? 'pill-pending' :
                          o.status === 'APPROVED' ? 'pill-approved' :
                          o.status === 'EXECUTED' ? 'pill-info' :
                          o.status === 'REJECTED' ? 'pill-rejected' : 'pill-info'
                        }>{o.status}</span>
                      </td>
                      {isToday && (
                        <td className="text-right">
                          {isPending ? (
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
                          ) : (
                            <span className="text-[10px] text-bf-muted">-</span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={isToday ? 7 : 6} className="text-center py-6 text-bf-muted">
                      해당 일자에 처리 기록이 없습니다
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </DateHistoryTabs>

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
