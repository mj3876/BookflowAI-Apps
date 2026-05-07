import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { fetchInventoryHeatmap, fetchOverview, fetchSalesByStore, type LocationCell, type Role } from '../api';
import { ko, ORDER_TYPE_KO, URGENCY_KO } from '../labels';

// 부족률 (low_count / sku_count) 기반 히트맵 색상.
// 0% green / <5% yellow / <15% orange / 15%+ red. 데이터 없으면 회색.
function heatTone(low: number, total: number): { bg: string; border: string; text: string } {
  if (total === 0) return { bg: 'bg-bf-card', border: 'border-bf-border', text: 'text-bf-muted' };
  const pct = (low / total) * 100;
  if (pct === 0) return { bg: 'bg-green-50', border: 'border-green-400', text: 'text-green-900' };
  if (pct < 5) return { bg: 'bg-yellow-50', border: 'border-yellow-400', text: 'text-yellow-900' };
  if (pct < 15) return { bg: 'bg-orange-50', border: 'border-orange-400', text: 'text-orange-900' };
  return { bg: 'bg-red-50', border: 'border-red-500', text: 'text-red-900' };
}

function locationLabel(c: LocationCell): string {
  if (c.location_type === 'WH') return `${c.name ?? `위치 ${c.location_id}`} (WH)`;
  if (c.location_type === 'STORE_ONLINE') return `${c.name ?? `매장 ${c.location_id}`} (온라인)`;
  return c.name ?? `매장 ${c.location_id}`;
}

export default function WhDashboard() {
  const { role } = useOutletContext<{ role: Role }>();
  const wh_id = role === 'wh-manager-2' ? 2 : 1;

  const ov = useQuery({ queryKey: ['ov', wh_id, role], queryFn: () => fetchOverview(wh_id, role), refetchInterval: 5000 });
  const byStore = useQuery({ queryKey: ['byStore', role], queryFn: () => fetchSalesByStore(role), refetchInterval: 5000 });
  const heat = useQuery({ queryKey: ['heatmap', role], queryFn: () => fetchInventoryHeatmap(role), refetchInterval: 30000 });

  // 권역 (wh_id) 기준 동적 필터 — 시드 데이터의 wh_id 신뢰 (locations.wh_id)
  const myCells = (heat.data?.items ?? []).filter((c) => c.wh_id === wh_id);
  const myStoreIds = new Set(myCells.filter((c) => c.location_type !== 'WH').map((c) => c.location_id));
  const wh = myCells.find((c) => c.location_type === 'WH');
  const stores = myCells.filter((c) => c.location_type !== 'WH').sort((a, b) => a.location_id - b.location_id);

  const filteredSales = byStore.data?.items.filter((s) => myStoreIds.has(s.store_id)) ?? [];
  const totalRev = filteredSales.reduce((sum, s) => sum + s.revenue, 0);
  const totalTx = filteredSales.reduce((sum, s) => sum + s.transactions, 0);
  const totalLowSku = stores.reduce((sum, s) => sum + s.low_count, 0);
  const totalZeroSku = stores.reduce((sum, s) => sum + s.zero_count, 0);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="h1">{wh_id === 1 ? '수도권' : '영남'} 권역 대시보드</h1>
        <p className="text-bf-muted text-xs mt-1">관할 매장 매출 · 재고 · 대기 중인 주문 한눈에</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="metric-card">
          <div className="metric-label">관할 매장 수</div>
          <div className="metric-value">{stores.length}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">최근 1시간 매출</div>
          <div className="metric-value">₩{(totalRev / 1000).toFixed(0)}K</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">최근 1시간 거래수</div>
          <div className="metric-value">{totalTx}건</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">부족 SKU 합</div>
          <div className="metric-value text-orange-600">{totalLowSku}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">결품 SKU 합</div>
          <div className="metric-value text-red-600">{totalZeroSku}</div>
        </div>
      </div>

      {/* UX-3: 권역 재고 히트맵 — 부족률 색상 + WH 단독 카드 + 매장 grid */}
      <div className="card">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="h2">권역 재고 히트맵</h2>
          <div className="flex items-center gap-3 text-xs text-bf-muted">
            <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-green-50 border border-green-400" /> 양호</span>
            <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-yellow-50 border border-yellow-400" /> 주의</span>
            <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-orange-50 border border-orange-400" /> 부족</span>
            <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-red-50 border border-red-500" /> 위험</span>
          </div>
        </div>
        {heat.isLoading && <div className="text-bf-muted text-sm">불러오는 중…</div>}
        {!heat.isLoading && myCells.length === 0 && <div className="text-bf-muted text-sm">데이터 없음</div>}
        {wh && (() => {
          const tone = heatTone(wh.low_count, wh.sku_count);
          return (
            <div className={`mb-3 p-4 rounded-lg border-2 ${tone.bg} ${tone.border}`}>
              <div className={`flex items-baseline justify-between ${tone.text}`}>
                <div className="font-semibold text-sm">{locationLabel(wh)}</div>
                <div className="text-xs opacity-70">권역 거점 창고</div>
              </div>
              <div className="mt-2 grid grid-cols-4 gap-2 text-sm">
                <div><div className="text-bf-muted text-[11px]">SKU</div><div className="font-mono">{wh.sku_count}</div></div>
                <div><div className="text-bf-muted text-[11px]">총 재고</div><div className="font-mono">{wh.total_qty.toLocaleString()}</div></div>
                <div><div className="text-bf-muted text-[11px]">부족 SKU</div><div className={`font-mono ${wh.low_count > 0 ? 'text-orange-600' : ''}`}>{wh.low_count}</div></div>
                <div><div className="text-bf-muted text-[11px]">결품 SKU</div><div className={`font-mono ${wh.zero_count > 0 ? 'text-red-600' : ''}`}>{wh.zero_count}</div></div>
              </div>
            </div>
          );
        })()}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
          {stores.map((c) => {
            const tone = heatTone(c.low_count, c.sku_count);
            const lowPct = c.sku_count > 0 ? Math.round((c.low_count / c.sku_count) * 100) : 0;
            return (
              <div key={c.location_id} className={`p-3 rounded-md border ${tone.bg} ${tone.border}`}>
                <div className={`text-xs font-semibold ${tone.text}`}>{locationLabel(c)}</div>
                <div className="mt-1 text-[11px] text-bf-muted">SKU {c.sku_count} · 재고 {c.total_qty.toLocaleString()}</div>
                <div className="mt-2 flex items-baseline justify-between">
                  <div className={`text-[11px] ${c.low_count > 0 ? 'text-orange-700' : 'text-bf-muted'}`}>부족 {c.low_count}</div>
                  <div className={`text-xs font-mono ${tone.text}`}>{lowPct}%</div>
                </div>
                {c.zero_count > 0 && <div className="mt-1 text-[11px] text-red-700">결품 {c.zero_count}</div>}
              </div>
            );
          })}
        </div>
      </div>

      <div className="card">
        <h2 className="h2 mb-3">관할 매장 매출 (최근 1시간)</h2>
        <table className="data-table">
          <thead>
            <tr><th>매장</th><th className="text-right">거래 수</th><th className="text-right">매출</th><th className="text-right">온라인 비중</th></tr>
          </thead>
          <tbody>
            {filteredSales.map((s) => {
              const cell = myCells.find((c) => c.location_id === s.store_id);
              const label = cell ? locationLabel(cell) : `매장 ${s.store_id}`;
              return (
                <tr key={s.store_id}>
                  <td>{label}</td>
                  <td className="text-right">{s.transactions}건</td>
                  <td className="text-right">₩{s.revenue.toLocaleString()}</td>
                  <td className="text-right">{s.transactions > 0 ? `${Math.round((s.online_count / s.transactions) * 100)}%` : '-'}</td>
                </tr>
              );
            })}
            {filteredSales.length === 0 && (
              <tr><td colSpan={4} className="text-center text-bf-muted py-4">최근 1시간 거래 없음</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2 className="h2 mb-3">대기 중인 주문 (관할)</h2>
        <table className="data-table">
          <thead>
            <tr><th>긴급도</th><th>유형</th><th>ISBN</th><th>출발 → 도착</th><th>수량</th><th>접수 시각</th></tr>
          </thead>
          <tbody>
            {ov.data?.pending_orders?.items.slice(0, 15).map((o) => (
              <tr key={o.order_id}>
                <td>
                  <span className={
                    o.urgency_level === 'CRITICAL' ? 'pill-rejected' :
                    o.urgency_level === 'URGENT'   ? 'pill-pending' : 'pill-info'
                  }>{ko(URGENCY_KO, o.urgency_level)}</span>
                </td>
                <td>{ko(ORDER_TYPE_KO, o.order_type)}</td>
                <td className="font-mono text-[11px]">{o.isbn13}</td>
                <td>{o.source_location_id ?? '-'} → {o.target_location_id ?? '-'}</td>
                <td>{o.qty}권</td>
                <td className="text-bf-muted">{new Date(o.created_at).toLocaleString('ko-KR')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
