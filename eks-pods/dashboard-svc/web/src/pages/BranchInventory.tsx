import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { fetchOverview, postReturnsRequest, type Role } from '../api';
import { useLocations } from '../useLocations';
import { useScope } from '../auth';
import InlineMessage from '../components/InlineMessage';

const RETURN_REASONS = ['파손', '불량', '누락', '계약 종료', '기타'];

export default function BranchInventory() {
  const { role } = useOutletContext<{ role: Role }>();
  const { scope_store_id } = useScope();
  const wh_id = 1;
  const my_store = scope_store_id ?? 1;
  const { nameOf } = useLocations(role);
  const qc = useQueryClient();

  const ov = useQuery({ queryKey: ['ov', wh_id, role], queryFn: () => fetchOverview(wh_id, role), refetchInterval: 5000 });

  const myInventory = ov.data?.inventory?.items.filter((it) => (it as any).location_id === my_store) ?? [];

  const total = myInventory.length;
  const lowStock = myInventory.filter((it) => it.available <= 10).length;
  const totalQty = myInventory.reduce((s, it) => s + it.on_hand, 0);

  // P1-3 반품 신청 modal state
  const [returnTarget, setReturnTarget] = useState<{ isbn13: string; on_hand: number } | null>(null);
  const [reason, setReason] = useState(RETURN_REASONS[0]);
  const [qty, setQty] = useState(1);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  const reqMu = useMutation({
    mutationFn: (body: { isbn13: string; location_id: number; qty: number; reason: string }) =>
      postReturnsRequest(role, body),
    onSuccess: (r) => {
      setFeedback({
        type: 'success',
        msg: `반품 신청됨 — return_id ${r.return_id.slice(0, 8)} · 본사 반품 큐 진입`,
      });
      setReturnTarget(null);
      setQty(1);
      qc.invalidateQueries({ queryKey: ['ov', wh_id, role] });
    },
    onError: (e: Error) => setFeedback({ type: 'error', msg: `반품 신청 실패: ${e.message}` }),
  });

  const onSubmit = () => {
    if (!returnTarget) return;
    reqMu.mutate({
      isbn13: returnTarget.isbn13,
      location_id: my_store,
      qty,
      reason,
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="h1">{nameOf(my_store)} · 매장 재고</h1>
        <p className="text-bf-muted text-xs mt-1">
          현재 보유한 도서 SKU와 가용량 — POS 판매 시 자동 감소 (pos-ingestor Lambda).
          파손/불량/누락 등이 발견되면 SKU 우측 "반품 신청" 으로 본사에 신청할 수 있어요.
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

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="metric-card">
          <div className="metric-label">SKU 수</div>
          <div className="metric-value">{total.toLocaleString()}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">총 보유 수량</div>
          <div className="metric-value">{totalQty.toLocaleString()}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">재고 부족 (≤10)</div>
          <div className="metric-value text-bf-danger">{lowStock}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">예약중 합계</div>
          <div className="metric-value">{myInventory.reduce((s, it) => s + it.reserved_qty, 0).toLocaleString()}</div>
        </div>
      </div>

      <div className="card">
        <h2 className="h2 mb-3">SKU 목록 (Top 50)</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>ISBN13</th>
              <th className="text-right">보유</th>
              <th className="text-right">예약</th>
              <th className="text-right">가용</th>
              <th className="text-right">안전재고</th>
              <th>상태</th>
              <th className="text-right">처리</th>
            </tr>
          </thead>
          <tbody>
            {myInventory.slice(0, 50).map((it) => (
              <tr key={it.isbn13}>
                <td className="font-mono text-[11px]">{it.isbn13}</td>
                <td className="text-right">{it.on_hand}</td>
                <td className="text-right text-bf-muted">{it.reserved_qty}</td>
                <td className="text-right font-semibold">{it.available}</td>
                <td className="text-right text-bf-muted">{(it as any).safety_stock ?? '-'}</td>
                <td>
                  {it.available === 0
                    ? <span className="pill-rejected">SOLD OUT</span>
                    : it.available <= 10
                    ? <span className="pill-pending">LOW</span>
                    : <span className="pill-approved">OK</span>}
                </td>
                <td className="text-right">
                  <button
                    className="btn-outline btn-sm"
                    disabled={it.on_hand === 0}
                    onClick={() => { setQty(1); setReason(RETURN_REASONS[0]); setReturnTarget({ isbn13: it.isbn13, on_hand: it.on_hand }); }}
                    title="파손/불량/누락 등 발견 시 본사에 반품 신청"
                  >
                    반품 신청
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 반품 신청 모달 */}
      {returnTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setReturnTarget(null)}>
          <div className="bg-bf-bg border border-bf-border rounded-lg p-5 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h3 className="h2 mb-3">반품 신청</h3>
            <div className="text-xs text-bf-muted mb-4">
              ISBN <span className="font-mono">{returnTarget.isbn13}</span> · 매장 보유 <b>{returnTarget.on_hand}</b>권 중 일부 반품 신청 → 본사 반품 큐 진입.
            </div>
            <div className="space-y-3">
              <div>
                <div className="label-tag mb-1">사유</div>
                <select className="ipt w-full" value={reason} onChange={(e) => setReason(e.target.value)}>
                  {RETURN_REASONS.map((r) => <option key={r}>{r}</option>)}
                </select>
              </div>
              <div>
                <div className="label-tag mb-1">수량 (1 ~ {returnTarget.on_hand})</div>
                <input
                  type="number"
                  className="ipt w-full"
                  value={qty}
                  min={1}
                  max={returnTarget.on_hand}
                  onChange={(e) => setQty(Math.max(1, Math.min(returnTarget.on_hand, parseInt(e.target.value) || 1)))}
                />
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn-secondary" onClick={() => setReturnTarget(null)}>취소</button>
              <button
                className="btn-primary"
                disabled={reqMu.isPending}
                onClick={onSubmit}
              >
                {reqMu.isPending ? '신청 중…' : '신청'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
