import { Fragment, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { ApiError, fetchPending, patchPendingOrder, postIntervene, type Role } from '../api';
import ConfirmModal from '../components/ConfirmModal';
import { useLocations } from '../useLocations';
import { useToast } from '../components/Toast';
import { groupByDate, dateGroupTone } from '../dateGroup';

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
  // D1-1 (재정정): WhApprove 에 3 탭 모두 — REBALANCE (단독), WH_TRANSFER (양측 SOURCE/TARGET), PUBLISHER_ORDER (단독).
  // WhTransfer 페이지는 시각화 + 발의자 추적 보조용 · 승인은 양쪽에서 가능.
  const [searchParams] = useSearchParams();
  const initialTab = (() => {
    const t = searchParams.get('tab');
    return (t === 'WH_TRANSFER' || t === 'PUBLISHER_ORDER') ? t : 'REBALANCE';
  })() as 'REBALANCE' | 'WH_TRANSFER' | 'PUBLISHER_ORDER';
  const [tab, setTab] = useState<'REBALANCE' | 'WH_TRANSFER' | 'PUBLISHER_ORDER'>(initialTab);
  useEffect(() => {
    const t = searchParams.get('tab');
    if (t === 'REBALANCE' || t === 'WH_TRANSFER' || t === 'PUBLISHER_ORDER') setTab(t);
  }, [searchParams]);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<{ order_id: string; side: 'FINAL' | 'SOURCE' | 'TARGET' } | null>(null);
  const [approveTarget, setApproveTarget] = useState<{ order_id: string; side: 'FINAL' | 'SOURCE' | 'TARGET'; isbn13: string; qty: number; isPublisher: boolean } | null>(null);
  // D5-7 AI 추천 수정 modal state (qty + target_location_id)
  const [editTarget, setEditTarget] = useState<{ order_id: string; isbn13: string; qty: number; target_location_id: number | null; note: string } | null>(null);
  const { nameOf, items: locItems } = useLocations(role);
  const { showToast } = useToast();

  const editMu = useMutation({
    mutationFn: (body: { qty?: number; target_location_id?: number; note?: string }) => {
      if (!editTarget) throw new Error('대상 없음');
      return patchPendingOrder(role, editTarget.order_id, body);
    },
    onSuccess: (r) => {
      showToast({ type: 'success', message: `수정 완료 — 수량 ${r.qty}권 · 매장 ${nameOf(r.target_location_id)}` });
      setEditTarget(null);
      qc.invalidateQueries({ queryKey: ['pending'] });
    },
    onError: (e) => {
      const err = e as ApiError | Error;
      showToast({ type: 'error', message: `수정 실패: ${err.message}`, details: err instanceof ApiError ? err.code : undefined });
    },
  });

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

      <div className="flex gap-2 border-b border-bf-border flex-wrap">
        <button
          className={`px-4 py-2 text-xs font-medium border-b-2 ${tab === 'REBALANCE' ? 'border-bf-primary text-bf-primary' : 'border-transparent text-bf-muted'}`}
          onClick={() => setTab('REBALANCE')}
        >
          🟢 권역 내 재분배 (단독 승인)
        </button>
        <button
          className={`px-4 py-2 text-xs font-medium border-b-2 ${tab === 'WH_TRANSFER' ? 'border-bf-primary text-bf-primary' : 'border-transparent text-bf-muted'}`}
          onClick={() => setTab('WH_TRANSFER')}
        >
          🟡 권역 간 이동 (양측 협의)
        </button>
        <button
          className={`px-4 py-2 text-xs font-medium border-b-2 ${tab === 'PUBLISHER_ORDER' ? 'border-bf-primary text-bf-primary' : 'border-transparent text-bf-muted'}`}
          onClick={() => setTab('PUBLISHER_ORDER')}
        >
          🔴 외부 발주 (자기 권역분 · 비용 발생)
        </button>
        <div className="ml-auto px-4 py-2 text-[11px] text-bf-muted">
          시각화/발의자 추적은 <a href="/wh-transfer" className="text-bf-primary hover:underline">권역 간 이동</a> 페이지 (보조)
        </div>
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
              <th>도서</th>
              <th>출발 → 도착</th>
              {tab === 'WH_TRANSFER' && <th>나의 사이드</th>}
              <th>수량</th>
              <th>자동 실행</th>
              <th>생성</th>
              <th className="text-right">액션</th>
            </tr>
          </thead>
          <tbody>
            {groupByDate(pending.data?.items ?? []).map((group) => {
              const ncols = tab === 'WH_TRANSFER' ? 8 : 7;
              const tone = dateGroupTone(group.label);
              return (
                <Fragment key={group.key}>
                  <tr className="bg-bf-panel2">
                    <td colSpan={ncols} className={`py-1.5 px-3 ${tone.wrap}`}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`px-2 py-0.5 rounded text-[11px] font-semibold ${tone.pill}`}>{group.label}</span>
                        <span className="text-[11px] text-bf-muted">{group.total}건 · 처리완료 {group.done}/{group.total} ({group.progressPct}%)</span>
                        {group.approved > 0 && <span className="text-[10px] text-green-700">✓ {group.approved}</span>}
                        {group.rejected > 0 && <span className="text-[10px] text-red-700">✗ {group.rejected}</span>}
                        {group.pending > 0 && <span className="text-[10px] text-orange-600">⏳ {group.pending}</span>}
                        {group.allDone && (
                          <span className="ml-1 px-2 py-0.5 rounded bg-green-500/20 text-green-300 text-[10px] font-semibold border border-green-500/40">
                            ✅ 완료 · 최종 계획안
                          </span>
                        )}
                        <span className="text-[10px] text-bf-muted ml-auto">매일 cycle (07:00 자동 승인 · 18:00 자동 거절)</span>
                      </div>
                    </td>
                  </tr>
                  {group.rows.map((o) => {
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
                  <td>
                    <div className="text-sm">{o.title ?? o.isbn13}</div>
                    <div className="font-mono text-[10px] text-bf-muted">{o.isbn13}</div>
                  </td>
                  <td className="text-[11px]">
                    {o.source_location_id != null ? nameOf(o.source_location_id) : '(출판사)'}
                    {' → '}
                    {o.target_location_id != null ? nameOf(o.target_location_id) : '-'}
                  </td>
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
                        {/* D5-7 AI 추천 수정 */}
                        <button
                          className="btn-outline btn-sm"
                          disabled={busy === o.order_id}
                          onClick={() => setEditTarget({ order_id: o.order_id, isbn13: o.isbn13, qty: o.qty, target_location_id: o.target_location_id ?? null, note: '' })}
                          title="추천 수정 — 수량/대상 매장 변경"
                        >
                          수정
                        </button>
                      </div>
                    ) : (
                      <span className="text-[10px] text-bf-muted">권한 없음</span>
                    )}
                  </td>
                </tr>
                    );
                  })}
                </Fragment>
              );
            })}
            {(pending.data?.items.length ?? 0) === 0 && (
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

      {/* D5-7 AI 추천 수정 modal */}
      {editTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[1000]" role="dialog" aria-modal="true">
          <div className="bg-bf-panel border border-bf-border rounded-lg p-5 w-[480px] shadow-xl">
            <h2 className="h2 mb-3">추천 수정</h2>
            <div className="text-xs text-bf-muted mb-3">
              ISBN <span className="font-mono">{editTarget.isbn13}</span> · 자기 권역 PENDING 만 수정 가능. 변경 후 audit_log 자동 기록.
            </div>
            <div className="space-y-3 mb-4">
              <div className="flex justify-between items-center text-xs">
                <label className="text-bf-muted">수량</label>
                <input
                  type="number"
                  className="ipt w-24 text-right"
                  value={editTarget.qty}
                  onChange={(e) => setEditTarget({ ...editTarget, qty: parseInt(e.target.value, 10) || 0 })}
                  min={1}
                />
              </div>
              <div className="flex justify-between items-center text-xs">
                <label className="text-bf-muted">대상 매장</label>
                <select
                  className="ipt w-56"
                  value={editTarget.target_location_id ?? ''}
                  onChange={(e) => setEditTarget({ ...editTarget, target_location_id: e.target.value ? parseInt(e.target.value, 10) : null })}
                >
                  <option value="">변경 없음</option>
                  {locItems.filter((l) => l.location_type !== 'WH' && l.wh_id === my_wh).map((l) => (
                    <option key={l.location_id} value={l.location_id}>{l.name ?? `매장 ${l.location_id}`}</option>
                  ))}
                </select>
              </div>
              <div className="flex justify-between items-start text-xs">
                <label className="text-bf-muted pt-1">사유</label>
                <input
                  type="text"
                  className="ipt w-56"
                  value={editTarget.note}
                  onChange={(e) => setEditTarget({ ...editTarget, note: e.target.value })}
                  placeholder="예: 매장 사정 변경 / 재고 부족"
                  maxLength={200}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button className="btn-secondary" onClick={() => setEditTarget(null)}>취소</button>
              <button
                className="btn-primary"
                disabled={editMu.isPending || editTarget.qty <= 0}
                onClick={() => {
                  const body: { qty?: number; target_location_id?: number; note?: string } = {};
                  if (editTarget.qty > 0) body.qty = editTarget.qty;
                  if (editTarget.target_location_id != null) body.target_location_id = editTarget.target_location_id;
                  if (editTarget.note) body.note = editTarget.note;
                  editMu.mutate(body);
                }}
              >
                {editMu.isPending ? '처리 중…' : '수정'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
