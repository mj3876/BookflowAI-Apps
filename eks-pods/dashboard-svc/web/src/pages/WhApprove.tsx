import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { fetchPending, postIntervene, type Role } from '../api';

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
  const [tab, setTab] = useState<'REBALANCE' | 'WH_TRANSFER'>('REBALANCE');
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

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
        <h1 className="h1">창고 승인 큐 · 창고 {my_wh} ({my_wh === 1 ? '수도권' : '영남'})</h1>
        <p className="text-bf-muted text-xs mt-1">
          본인 창고 관련 PENDING 만 자동 필터 (intervention-svc 가 scope_wh_id 검증)
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
          Stage 1 · 재분배 (단독 승인)
        </button>
        <button
          className={`px-4 py-2 text-xs font-medium border-b-2 ${tab === 'WH_TRANSFER' ? 'border-bf-primary text-bf-primary' : 'border-transparent text-bf-muted'}`}
          onClick={() => setTab('WH_TRANSFER')}
        >
          Stage 2 · 권역 이동 (SOURCE+TARGET 양쪽 승인)
        </button>
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="h2">
            {tab === 'REBALANCE' ? '재분배 (자기 창고 내)' : '권역 이동 (수도권 ↔ 영남)'}
            <span className="text-bf-muted ml-2">({pending.data?.items.length ?? 0})</span>
          </h2>
          <span className="label-tag">5초 polling</span>
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
              const side = tab === 'WH_TRANSFER' ? sideForOrder(o) : 'FINAL' as const;
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
                          onClick={() => act.mutate({ order_id: o.order_id, action: 'approve', side: side as 'FINAL' | 'SOURCE' | 'TARGET' })}
                        >
                          {tab === 'REBALANCE' ? '승인' : (side === 'SOURCE' ? '출고 승인' : '입고 승인')}
                        </button>
                        <button
                          className="btn-danger btn-sm"
                          disabled={busy === o.order_id}
                          onClick={() => {
                            const reason = window.prompt('거절 사유?', '재고 부족');
                            if (reason) act.mutate({ order_id: o.order_id, action: 'reject', side: side as 'FINAL' | 'SOURCE' | 'TARGET', reason });
                          }}
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
    </div>
  );
}
