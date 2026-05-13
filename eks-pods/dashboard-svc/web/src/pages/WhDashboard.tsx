import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { fetchAllForecast, fetchInventoryHeatmap, fetchOverview, fetchSalesByStore, type LocationCell, type Role } from '../api';
import { useStockUpdates } from '../useStockUpdates';
import { ko, ORDER_TYPE_KO, URGENCY_KO } from '../labels';
import { useLocations } from '../useLocations';
import { useScope } from '../auth';

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
  const { nameOf, items: locItems } = useLocations(role);
  const { scope_wh_id } = useScope();

  // 2026-05-13 role 기반 WH selector — hq-admin 두 권역 / wh-manager 자기 권역 고정
  const isHq = role === 'hq-admin';
  const isWhMgr = role === 'wh-manager-1' || role === 'wh-manager-2';
  const accessibleWhs = useMemo(() => {
    const whs = locItems.filter((l: any) => l.location_type === 'WH');
    if (isHq) return whs;
    if (isWhMgr && scope_wh_id != null) return whs.filter((l: any) => l.wh_id === scope_wh_id);
    return [];
  }, [isHq, isWhMgr, locItems, scope_wh_id]);

  const [selectedWhId, setSelectedWhId] = useState<number | null>(null);
  const fallbackWhId = role === 'wh-manager-2' ? 2 : 1;
  const wh_id =
    selectedWhId ?? scope_wh_id ?? accessibleWhs[0]?.wh_id ?? fallbackWhId;

  const ov = useQuery({ queryKey: ['ov', wh_id, role], queryFn: () => fetchOverview(wh_id, role), refetchInterval: 5000 });
  // Notion 2.1: 타 센터 재고 조회 (수도권 ↔ 영남 상호 가시성 · 2단계 의사결정용)
  const otherWh = wh_id === 1 ? 2 : 1;
  const otherOv = useQuery({
    queryKey: ['ov-other', otherWh, role],
    queryFn: () => fetchOverview(otherWh, role).catch(() => null),
    refetchInterval: 30000,
  });
  const byStore = useQuery({ queryKey: ['byStore', role], queryFn: () => fetchSalesByStore(role), refetchInterval: 5000 });
  const heat = useQuery({ queryKey: ['heatmap', role], queryFn: () => fetchInventoryHeatmap(role), refetchInterval: 30000 });

  // D+1 AI 수요예측 (전 매장 batch · 권역 매장별 예측 셀에 표시)
  const fcQ = useQuery({
    queryKey: ['forecast-all', role],
    queryFn: () => fetchAllForecast(role),
    refetchInterval: 60000,
    staleTime: 30000,
  });
  const forecastMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of fcQ.data?.items ?? []) {
      m.set(`${f.isbn13}|${f.store_id}`, f.predicted_demand);
    }
    return m;
  }, [fcQ.data?.items]);
  const forecastOf = (isbn: string, locId: number) => forecastMap.get(`${isbn}|${locId}`);

  // Redis 실시간 (cell flash)
  const { flashed, availableOf } = useStockUpdates(role);

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
        {isHq && accessibleWhs.length > 1 && (
          <div className="flex items-center gap-2 mt-2 p-2 rounded-lg bg-bf-panel/60 border border-bf-border/40">
            <span className="text-xs text-bf-muted">🔧 본사 모드 · 보는 권역:</span>
            <select
              className="ipt text-sm px-2 py-1 rounded bg-bf-panel border border-bf-border"
              value={wh_id}
              onChange={(e) => setSelectedWhId(parseInt(e.target.value, 10))}
            >
              {accessibleWhs.map((l: any) => (
                <option key={l.wh_id} value={l.wh_id}>{l.name}</option>
              ))}
            </select>
          </div>
        )}
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

      {/* D1-5 Notion 2.1: 타 센터 재고 현황 (2단계 의사결정 — 상대 여유분 파악) */}
      {(() => {
        const other = otherOv.data;
        if (otherOv.isLoading) {
          return <div className="card text-xs text-bf-muted">타 센터 ({otherWh === 1 ? '수도권' : '영남'}) 재고 불러오는 중…</div>;
        }
        if (!other) return null;
        const oCells = (heat.data?.items ?? []).filter((c) => c.wh_id === otherWh);
        const oWh = oCells.find((c) => c.location_type === 'WH');
        const oStores = oCells.filter((c) => c.location_type !== 'WH');
        const oSku = oCells.reduce((s, c) => s + c.sku_count, 0);
        const oQty = oCells.reduce((s, c) => s + c.total_qty, 0);
        const oLow = oCells.reduce((s, c) => s + c.low_count, 0);
        const oZero = oCells.reduce((s, c) => s + c.zero_count, 0);
        // 부족 도서 top 8 (상대 권역 → 우리가 발의 가능한 후보)
        const oInvItems = (other.inventory?.items ?? []) as any[];
        const oWhStores = new Set(oCells.map((c) => c.location_id));
        const oLowByIsbn = new Map<string, { title?: string; available: number; safety: number; on_hand: number }>();
        for (const it of oInvItems) {
          if (!oWhStores.has(it.location_id)) continue;
          const av = it.available ?? 0;
          const sf = it.safety_stock ?? 10;
          // 상대 여유분 = available - safety (양수만 transfer 가능)
          const surplus = av - sf;
          if (surplus <= 0) continue;
          const cur = oLowByIsbn.get(it.isbn13);
          if (!cur || surplus > cur.available) {
            oLowByIsbn.set(it.isbn13, { title: it.title, available: surplus, safety: sf, on_hand: it.on_hand ?? 0 });
          }
        }
        const surplusTop = [...oLowByIsbn.entries()].sort((a, b) => b[1].available - a[1].available).slice(0, 8);
        return (
          <div className="card border-2 border-purple-200">
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="h2">타 센터 ({otherWh === 1 ? '수도권' : '영남'}) 재고 현황</h2>
              <div className="text-[11px] text-bf-muted">읽기 전용 · 권역 간 이동(Stage 2) 의사결정 참고</div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-3">
              <div className="metric-card"><div className="metric-label">관할 매장</div><div className="metric-value">{oStores.length}</div></div>
              <div className="metric-card"><div className="metric-label">SKU 합</div><div className="metric-value">{oSku.toLocaleString()}</div></div>
              <div className="metric-card"><div className="metric-label">총 재고</div><div className="metric-value">{oQty.toLocaleString()}</div></div>
              <div className="metric-card"><div className="metric-label">부족 SKU</div><div className="metric-value text-orange-600">{oLow}</div></div>
              <div className="metric-card"><div className="metric-label">결품 SKU</div><div className="metric-value text-red-600">{oZero}</div></div>
            </div>
            {oWh && (
              <div className="mb-3 p-3 rounded-md bg-purple-50 border border-purple-300 text-xs text-purple-900">
                <span className="font-semibold">{locationLabel(oWh)}</span>
                {' · '}SKU {oWh.sku_count} · 재고 {oWh.total_qty.toLocaleString()} · 부족 {oWh.low_count} · 결품 {oWh.zero_count}
              </div>
            )}
            {surplusTop.length > 0 && (
              <div>
                <div className="text-xs text-bf-muted mb-1">📦 상대 권역 여유분 top {surplusTop.length} (안전재고 차감 후 가용)</div>
                <table className="data-table">
                  <thead><tr><th>도서</th><th className="text-right">상대 가용</th><th className="text-right">상대 안전재고</th><th className="text-right">여유분</th></tr></thead>
                  <tbody>
                    {surplusTop.map(([isbn, info]) => (
                      <tr key={isbn}>
                        <td><div className="text-xs">{info.title ?? isbn}</div><div className="font-mono text-[10px] text-bf-muted">{isbn}</div></td>
                        <td className="text-right font-mono">{(info.available + info.safety).toLocaleString()}</td>
                        <td className="text-right font-mono text-bf-muted">{info.safety}</td>
                        <td className="text-right font-mono text-green-700 font-semibold">+{info.available.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {surplusTop.length === 0 && (
              <div className="text-xs text-bf-muted text-center py-3">타 센터 여유분 없음 (Stage 2 발의 후보 0건)</div>
            )}
          </div>
        );
      })()}

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

      {/* 권역 6 매장 × 부족 도서 top 20 책 단위 heatmap (Redis 실시간 cell flash) */}
      {(() => {
        const invItems = (ov.data?.inventory?.items ?? []) as any[];
        const myInv = invItems.filter((it) => myStoreIds.has(it.location_id));
        // 가용 ≤ 안전재고 인 (isbn, store) 만 추출 → isbn 별 group → 부족 매장 많은 순 top 20
        const lowByIsbn = new Map<string, { title?: string; perStore: Record<number, any> }>();
        for (const it of myInv) {
          const av = availableOf(it.isbn13, it.location_id) ?? it.available;
          if (av > (it.safety_stock ?? 10) * 2) continue;
          if (!lowByIsbn.has(it.isbn13)) lowByIsbn.set(it.isbn13, { title: it.title, perStore: {} });
          lowByIsbn.get(it.isbn13)!.perStore[it.location_id] = it;
        }
        const sorted = [...lowByIsbn.entries()]
          .sort((a, b) => Object.keys(b[1].perStore).length - Object.keys(a[1].perStore).length)
          .slice(0, 20);
        if (sorted.length === 0) return null;
        return (
          <div className="card">
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="h2">권역 부족 도서 × 매장 (책 단위 실시간)</h2>
              <div className="text-[11px] text-bf-muted">
                POS 결제 시 cell <span className="px-1 bg-yellow-100">flash</span> · 가용 ≤ 2× 안전재고 만 표시 ·
                <span className="ml-1">셀 아래 작은 숫자 = <b>AI D+1 예측 (5일치)</b></span>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-bf-muted">
                    <th className="text-left py-1 px-2">도서</th>
                    {stores.map((s) => (
                      <th key={s.location_id} className="text-right py-1 px-2 whitespace-nowrap">{s.name ?? `매장 ${s.location_id}`}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map(([isbn, info]) => (
                    <tr key={isbn} className="border-t border-bf-border2">
                      <td className="py-1.5 px-2 font-medium">{info.title ?? isbn}</td>
                      {stores.map((s) => {
                        const it = info.perStore[s.location_id];
                        if (!it) return <td key={s.location_id} className="py-1.5 px-2 text-right text-bf-muted">-</td>;
                        const av = availableOf(isbn, s.location_id) ?? it.available;
                        const safety = it.safety_stock ?? 10;
                        const cls = av === 0 ? 'text-red-600 font-bold' : av <= safety ? 'text-orange-600 font-bold' : 'text-yellow-700';
                        const pred = forecastOf(isbn, s.location_id);
                        const safety5 = pred != null ? Math.round(pred * 5) : null;
                        const insufficient = safety5 != null && av < safety5;
                        return (
                          <td key={s.location_id} className={`py-1.5 px-2 text-right ${cls} ${flashed(isbn, s.location_id) ? 'animate-flash' : ''}`}>
                            {av}
                            {pred != null && (
                              <div className={`text-[10px] font-normal ${insufficient ? 'text-orange-600' : 'text-bf-muted'}`}>
                                {pred.toFixed(1)} / {safety5}
                              </div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

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
                <td>
                  <div className="text-sm">{o.title ?? o.isbn13}</div>
                  <div className="font-mono text-[10px] text-bf-muted">{o.isbn13}</div>
                </td>
                <td className="text-[11px]">
                  {o.source_location_id != null ? nameOf(o.source_location_id) : '(출판사)'}
                  {' → '}
                  {o.target_location_id != null ? nameOf(o.target_location_id) : '-'}
                </td>
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
