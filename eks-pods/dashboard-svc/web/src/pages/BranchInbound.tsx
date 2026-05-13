import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { fetchInstructions, postInboundReceive, postInboundReject, postInboundBatchReceive, type Role } from '../api';
import { ko, ORDER_TYPE_KO, URGENCY_KO } from '../labels';
import { groupByDate, dateGroupTone } from '../dateGroup';
import ConfirmModal from '../components/ConfirmModal';
import EmptyState from '../components/EmptyState';
import HelpHint from '../components/HelpHint';
import InlineMessage from '../components/InlineMessage';
import { useLocations } from '../useLocations';

/**
 * UX-6 매장 입·출고 처리 — FR-A6.6 (지점 수동 개입).
 *
 * V6.2 시나리오: 지점은 입고 + 출고 모두 처리.
 * - 입고: target_location_id = 내 매장 → 수령/거부
 * - 출고: source_location_id = 내 매장 → 발송 완료 (Stage 1 REBALANCE source 측)
 *
 * Quick-mode: 출고 발송 완료는 기존 /inbound/{order_id}/receive 재사용
 * (status=EXECUTED 마킹 — backend 입장에선 source/target 양측 모두 동일 처리).
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
  const allInstr = q.data?.items ?? [];
  // 입고: target = 내 매장 + APPROVED
  const myInbound = allInstr.filter((o) => o.target_location_id === my_store && o.status === 'APPROVED');
  // 출고: source = 내 매장 + APPROVED (매장 간 REBALANCE 의 source 측)
  const myOutbound = allInstr.filter((o) => o.source_location_id === my_store && o.status === 'APPROVED');
  // PENDING 입고 — 본사 승인 대기 (별도 섹션)
  const myPending = allInstr.filter(
    (o) => o.target_location_id === my_store && (o.status === 'PENDING' || o.status === 'AUTO_EXECUTED'),
  );

  const [tab, setTab] = useState<'inbound' | 'outbound'>('inbound');

  // Reject modal state
  const [rejectTarget, setRejectTarget] = useState<{ order_id: string; isbn13: string; qty: number } | null>(null);
  const [reason, setReason] = useState(REJECT_REASONS[0]);
  const [note, setNote] = useState('');
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [receiveTarget, setReceiveTarget] = useState<{ order_id: string; qty: number } | null>(null);
  const [shipTarget, setShipTarget] = useState<{ order_id: string; qty: number; dest: string } | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  // P1-2 입고 거부 — intervention-svc /inbound/{order_id}/reject 호출 (별도 endpoint).
  const reject = useMutation({
    mutationFn: ({ order_id, reject_reason }: { order_id: string; reject_reason: string }) =>
      postInboundReject(role, order_id, reject_reason),
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

  // 출고 발송 완료 — 기존 receive endpoint 재사용 (status → EXECUTED).
  const shipMu = useMutation({
    mutationFn: (id: string) => postInboundReceive(role, id),
    onSuccess: (r) => {
      if (r.detail) {
        setFeedback({ type: 'error', msg: `발송 실패: ${r.detail}` });
        return;
      }
      setFeedback({ type: 'success', msg: `발송 완료 (${r.qty ?? '?'}권) · 운송 시작` });
      qc.invalidateQueries({ queryKey: ['instr-all', role] });
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      setFeedback({ type: 'error', msg: `발송 실패: ${msg}` });
    },
  });

  const handleReceiveConfirm = () => {
    if (!receiveTarget) return;
    receiveMu.mutate(receiveTarget.order_id);
    setReceiveTarget(null);
  };

  const handleShipConfirm = () => {
    if (!shipTarget) return;
    shipMu.mutate(shipTarget.order_id);
    setShipTarget(null);
  };

  const handleReject = () => {
    if (!rejectTarget) return;
    const reasonText = note ? `${reason}: ${note}`.slice(0, 50) : reason;
    reject.mutate({
      order_id: rejectTarget.order_id,
      reject_reason: reasonText,
    });
  };

  const tabBtn = (key: 'inbound' | 'outbound', label: string, count: number) => (
    <button
      key={key}
      onClick={() => setTab(key)}
      className={`px-4 py-2 text-sm border-b-2 -mb-px transition ${
        tab === key
          ? 'border-bf-primary text-bf-primary font-semibold'
          : 'border-transparent text-bf-muted hover:text-bf-text'
      }`}
    >
      {label} ({count})
    </button>
  );

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="h1">{nameOf(my_store)} · 입·출고 처리</h1>
        <p className="text-bf-muted text-xs mt-1">
          물류센터 → 우리 매장 도착 건은 <b>입고 대기</b>, 우리 매장 → 타 매장 재분배 (REBALANCE) 발송 건은 <b>출고 대기</b> 에서 처리합니다.
        </p>
        <div className="text-[11px] text-bf-muted mt-1">
          처리 → 매장 재고 자동 갱신 → <a href="/branch-inventory" className="text-bf-primary hover:underline">매장 재고</a> 확인
        </div>
      </div>

      {feedback && (
        <InlineMessage
          type={feedback.type}
          message={feedback.msg}
          onClose={() => setFeedback(null)}
          autoDismissMs={feedback.type === 'success' ? 4000 : undefined}
        />
      )}

      <div className="flex gap-2 border-b border-bf-border">
        {tabBtn('inbound', '📥 입고 대기', myInbound.length)}
        {tabBtn('outbound', '📤 출고 대기', myOutbound.length)}
      </div>

      {tab === 'inbound' && (
        <div className="card">
          <div className="flex items-center justify-between mb-1">
            <h2 className="h2 flex items-center">입고 대기 ({myInbound.length})<HelpHint text="물류센터 또는 타 매장에서 발송된 도서. 정상이면 수령, 수량/품질 문제가 있으면 거부합니다." /></h2>
            <button
              className="btn-primary text-xs"
              onClick={async () => {
                if (!myInbound.length) { setFeedback({ type:'error', msg:'입고 대기 항목이 없습니다.' }); return; }
                if (!window.confirm(`입고 대기 ${myInbound.length}건을 모두 수령 처리합니다. 진행할까요?`)) return;
                setBulkBusy(true);
                try {
                  const r = await postInboundBatchReceive(role, myInbound.map((o) => o.order_id));
                  setFeedback({
                    type: r.failed > 0 ? 'error' : 'success',
                    msg: `일괄 수령 완료 · ${r.ok}/${r.total}${r.failed ? ` · 실패 ${r.failed}` : ''}`,
                  });
                  qc.invalidateQueries({ queryKey: ['instr-all', role] });
                } catch (e) {
                  setFeedback({ type: 'error', msg: `일괄 수령 실패: ${String(e)}` });
                }
                setBulkBusy(false);
              }}
              disabled={bulkBusy || !myInbound.length}
              title="모든 입고 대기를 일괄 수령"
            >
              {bulkBusy ? '진행 중…' : `전체 수령 (${myInbound.length}건)`}
            </button>
          </div>
          <p className="text-xs text-bf-muted mb-3">본사 승인 완료된 항목만 수령 가능</p>
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
              {groupByDate(myInbound).map((g) => {
                const tone = dateGroupTone(g.label);
                return (
                  <Fragment key={g.key}>
                    <tr className="bg-bf-panel2"><td colSpan={8} className={`py-1.5 px-3 ${tone.wrap}`}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`px-2 py-0.5 rounded text-[11px] font-semibold ${tone.pill}`}>{g.label}</span>
                        <span className="text-[11px] text-bf-muted">{g.total}건 입고 대기</span>
                      </div>
                    </td></tr>
                    {g.rows.map((o) => (
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
                  </Fragment>
                );
              })}
              {myInbound.length === 0 && (
                <tr><td colSpan={8}>
                  <EmptyState icon="📦" message="입고 대기 없음" hint="모든 발송 건이 수령 또는 거부 처리되었습니다" />
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'outbound' && (
        <div className="card">
          <div className="flex items-center justify-between mb-1">
            <h2 className="h2 flex items-center">출고 대기 ({myOutbound.length})<HelpHint text="우리 매장에서 타 매장으로 재분배 발송할 도서 (Stage 1 REBALANCE source). 포장 후 발송 완료를 눌러 운송을 시작합니다." /></h2>
            <button
              className="btn-primary text-xs"
              onClick={async () => {
                if (!myOutbound.length) { setFeedback({ type:'error', msg:'출고 대기 항목이 없습니다.' }); return; }
                if (!window.confirm(`출고 대기 ${myOutbound.length}건을 모두 발송 처리합니다. 진행할까요?`)) return;
                setBulkBusy(true);
                try {
                  const r = await postInboundBatchReceive(role, myOutbound.map((o) => o.order_id));
                  setFeedback({
                    type: r.failed > 0 ? 'error' : 'success',
                    msg: `일괄 발송 완료 · ${r.ok}/${r.total}${r.failed ? ` · 실패 ${r.failed}` : ''}`,
                  });
                  qc.invalidateQueries({ queryKey: ['instr-all', role] });
                } catch (e) {
                  setFeedback({ type: 'error', msg: `일괄 발송 실패: ${String(e)}` });
                }
                setBulkBusy(false);
              }}
              disabled={bulkBusy || !myOutbound.length}
              title="모든 출고 대기를 일괄 발송"
            >
              {bulkBusy ? '진행 중…' : `전체 발송 (${myOutbound.length}건)`}
            </button>
          </div>
          <p className="text-xs text-bf-muted mb-3">본사 승인 완료된 재분배 (REBALANCE) 의 source 측. 포장 후 발송 완료를 누르면 도착지 매장에 입고 대기로 표시됩니다.</p>
          <table className="data-table">
            <thead>
              <tr>
                <th>승인 일시</th>
                <th>유형</th>
                <th>긴급도</th>
                <th>ISBN</th>
                <th>제목</th>
                <th>도착지</th>
                <th className="text-right">수량</th>
                <th className="text-right">처리</th>
              </tr>
            </thead>
            <tbody>
              {groupByDate(myOutbound).map((g) => {
                const tone = dateGroupTone(g.label);
                return (
                  <Fragment key={g.key}>
                    <tr className="bg-bf-panel2"><td colSpan={8} className={`py-1.5 px-3 ${tone.wrap}`}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`px-2 py-0.5 rounded text-[11px] font-semibold ${tone.pill}`}>{g.label}</span>
                        <span className="text-[11px] text-bf-muted">{g.total}건 출고 대기</span>
                      </div>
                    </td></tr>
                    {g.rows.map((o) => (
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
                  <td>{o.target_location_id != null ? nameOf(o.target_location_id) : '-'}</td>
                  <td className="text-right">{o.qty}권</td>
                  <td className="text-right">
                    <button
                      className="btn-primary btn-sm"
                      onClick={() => setShipTarget({
                        order_id: o.order_id,
                        qty: o.qty,
                        dest: o.target_location_id != null ? nameOf(o.target_location_id) : '-',
                      })}
                    >
                      발송 완료
                    </button>
                  </td>
                </tr>
                    ))}
                  </Fragment>
                );
              })}
              {myOutbound.length === 0 && (
                <tr><td colSpan={8}>
                  <EmptyState icon="🚚" message="출고 대기 없음" hint="우리 매장에서 발송할 재분배 건이 없습니다" />
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'inbound' && myPending.length > 0 && (
        <div className="card opacity-70">
          <h2 className="h2">🕒 승인 대기 중 ({myPending.length})</h2>
          <p className="text-xs text-bf-muted mb-2">
            본사가 발주 승인하면 자동으로 위 "입고 대기" 로 이동합니다. 수령은 APPROVED 상태에서만 가능.
          </p>
          <table className="data-table">
            <thead><tr><th>유형</th><th>긴급도</th><th>ISBN</th><th>제목</th><th>출발지</th><th>수량</th><th>현 상태</th></tr></thead>
            <tbody>
              {myPending.map((o) => (
                <tr key={o.order_id}>
                  <td>{ko(ORDER_TYPE_KO, o.order_type)}</td>
                  <td>{ko(URGENCY_KO, o.urgency_level)}</td>
                  <td className="font-mono text-[11px]">{o.isbn13}</td>
                  <td>{o.title ?? '-'}</td>
                  <td>{o.source_location_id != null ? nameOf(o.source_location_id) : '-'}</td>
                  <td className="text-right">{o.qty}권</td>
                  <td><span className="pill-pending">{o.status === 'AUTO_EXECUTED' ? '자동 실행됨' : '승인 대기'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 수령 확인 모달 */}
      <ConfirmModal
        open={receiveTarget !== null}
        title="수령 확인"
        message={receiveTarget ? `${receiveTarget.qty}권 수령을 확인하시겠습니까?\n수령 후 매장 재고에 자동 반영됩니다.` : ''}
        confirmText="수령 처리"
        onConfirm={handleReceiveConfirm}
        onCancel={() => setReceiveTarget(null)}
      />

      {/* 발송 확인 모달 */}
      <ConfirmModal
        open={shipTarget !== null}
        title="발송 확인"
        message={shipTarget ? `${shipTarget.dest} 으로 ${shipTarget.qty}권 발송을 확인하시겠습니까?\n발송 완료 시 매장 재고에서 차감되고 도착지에 입고 대기로 표시됩니다.` : ''}
        confirmText="발송 완료"
        onConfirm={handleShipConfirm}
        onCancel={() => setShipTarget(null)}
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
