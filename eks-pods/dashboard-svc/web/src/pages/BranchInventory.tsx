import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { fetchOverview, type Role } from '../api';
import { useLocations } from '../useLocations';

export default function BranchInventory() {
  const { role } = useOutletContext<{ role: Role }>();
  // branch-clerk - default WH 1 인근 매장 (location_id 1)
  const wh_id = 1;
  const my_store = 1;
  const { nameOf } = useLocations(role);

  const ov = useQuery({ queryKey: ['ov', wh_id, role], queryFn: () => fetchOverview(wh_id, role), refetchInterval: 5000 });

  // Filter inventory rows by location_id == my_store
  const myInventory = ov.data?.inventory?.items.filter((it) => (it as any).location_id === my_store) ?? [];

  const total = myInventory.length;
  const lowStock = myInventory.filter((it) => it.available <= 10).length;
  const totalQty = myInventory.reduce((s, it) => s + it.on_hand, 0);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="h1">{nameOf(my_store)} · 매장 재고</h1>
        <p className="text-bf-muted text-xs mt-1">현재 보유한 도서 SKU와 가용량 — POS 판매 시 자동 감소 (pos-ingestor Lambda)</p>
      </div>

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
            <tr><th>ISBN13</th><th className="text-right">보유</th><th className="text-right">예약</th><th className="text-right">가용</th><th className="text-right">안전재고</th><th>상태</th></tr>
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
