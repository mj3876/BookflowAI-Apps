import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useOutletContext } from 'react-router-dom';
import {
  fetchAllForecast,
  fetchBestsellers,
  fetchCascadeFunnel,
  fetchInventoryHeatmap,
  fetchInventoryTurnover,
  fetchKpiByCategory,
  fetchOverview,
  fetchPending,
  fetchSalesByStore,
  fetchSalesByWeekday,
  type LocationCell,
  type Role,
} from '../api';
import { useStockUpdates } from '../useStockUpdates';
import { ko, ORDER_TYPE_KO, URGENCY_KO } from '../labels';
import { useLocations } from '../useLocations';
import { useScope } from '../auth';
import KpiBar from '../components/charts/KpiBar';
import KpiLine from '../components/charts/KpiLine';
import KpiFunnel from '../components/charts/KpiFunnel';
import KpiPie from '../components/charts/KpiPie';

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

/**
 * WhDashboard — 권역 (WH) BI 대시보드 · 2026-05-13 WhHome 통합 진입점.
 *
 * 사용자 결정: WhHome 폐기 + WhDashboard 가 권역 진입점 + BI 차트 강화.
 * 4 row 차트 layout:
 *   row 0: 4 metric cards (30일 권역 매출 · 협의 필요 · 입출고 대기 · 부족 SKU)
 *   row 1: 권역 매장 매출 비교 bar (1h) + cascade funnel (7d)
 *   row 2: 7일 입출고 추이 line (APPROVED · EXECUTED · REJECTED)
 *   row 3: 권역 베스트셀러 top 10 bar
 *   row 4: 협의 필요 list (PENDING orders · 기존 유지)
 *   row 5+: 권역 재고 히트맵 + 부족 도서 매트릭스 (top 50 만 · 기존 유지 · 시각 부담 줄임)
 */
export default function WhDashboard() {
  const { role } = useOutletContext<{ role: Role }>();
  const { nameOf, items: locItems } = useLocations(role);
  const { scope_wh_id } = useScope();

  // role 기반 WH selector — hq-admin 두 권역 / wh-manager 자기 권역 고정
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

  // overview: 거점창고 + 매장 재고 + PENDING orders — 큰 payload. 30 초 (이전 5 초는 과함 · Redis 가 실시간 처리)
  const ov = useQuery({
    queryKey: ['ov', wh_id, role],
    queryFn: () => fetchOverview(wh_id, role),
    refetchInterval: 30000,
    staleTime: 15000,
  });
  const otherWh = wh_id === 1 ? 2 : 1;
  // 타 센터 overview: Stage 2 의사결정 참고. 2 분
  const otherOv = useQuery({
    queryKey: ['ov-other', otherWh, role],
    queryFn: () => fetchOverview(otherWh, role).catch(() => null),
    refetchInterval: 2 * 60 * 1000,
    staleTime: 60000,
  });
  // byStore: 매장별 매출 1h (KPI 와 queryKey 통일) — 30 초
  const byStore = useQuery({
    queryKey: ['byStore', role],
    queryFn: () => fetchSalesByStore(role),
    refetchInterval: 30000,
    staleTime: 15000,
  });
  // heatmap: 부족/결품 카운트 — 1 분 OK (재고 변동 Redis)
  const heat = useQuery({
    queryKey: ['heatmap', role],
    queryFn: () => fetchInventoryHeatmap(role),
    refetchInterval: 60000,
    staleTime: 30000,
  });

  // 신규 BI 쿼리 (다른 sub-agent 가 추가한 api · 2026-05-13)
  // 카테고리 30 일 — 5 분
  const byCat = useQuery({
    queryKey: ['kpi-cat-wh', wh_id, role],
    queryFn: () => fetchKpiByCategory(role, 30),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 2 * 60 * 1000,
  });
  // 베스트셀러 7 일 — 5 분
  const best = useQuery({
    queryKey: ['best-wh', wh_id, role],
    queryFn: () => fetchBestsellers(role, 7, 10),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 2 * 60 * 1000,
  });
  // funnel 7 일 — 1 분
  const funnel = useQuery({
    queryKey: ['funnel-wh', wh_id, role],
    queryFn: () => fetchCascadeFunnel(role, 7),
    refetchInterval: 60000,
    staleTime: 30000,
  });
  // PENDING orders — 30 초
  const pending = useQuery({
    queryKey: ['wh-pending', wh_id, role],
    queryFn: () => fetchPending(role, { limit: 100 }),
    refetchInterval: 30000,
    staleTime: 15000,
  });

  // 신규 (2026-05-13 차트 강화) ----------------------------------------
  // 권역 회전율 30 일 (전사 응답 · frontend 에서 내 wh_id 필터) — 5 분
  const turnover = useQuery({
    queryKey: ['turnover-all', role],
    queryFn: () => fetchInventoryTurnover(role, 30),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 2 * 60 * 1000,
  });
  // 요일별 매출 30 일 — 5 분 (전사 응답)
  const weekday = useQuery({
    queryKey: ['weekday-all', role],
    queryFn: () => fetchSalesByWeekday(role, 30),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 2 * 60 * 1000,
  });

  // D+1 AI 수요예측 batch — 하루 1회 갱신. 30 분
  const fcQ = useQuery({
    queryKey: ['forecast-all', role],
    queryFn: () => fetchAllForecast(role),
    refetchInterval: 30 * 60 * 1000,
    staleTime: 10 * 60 * 1000,
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
  const totalRev1h = filteredSales.reduce((sum, s) => sum + s.revenue, 0);
  const totalLowSku = stores.reduce((sum, s) => sum + s.low_count, 0);
  const totalZeroSku = stores.reduce((sum, s) => sum + s.zero_count, 0);

  // 30 일 권역 매출 = byCat 합계 (backend 가 role 기반 wh scope 적용)
  const total30dRev = (byCat.data?.items ?? []).reduce((s, c) => s + c.revenue, 0);

  // 협의 필요 (PENDING) 수 — 권역 관련 주문만 (source/target 매장이 내 권역)
  const myPending = (pending.data?.items ?? []).filter((o) => {
    if (o.status !== 'PENDING') return false;
    const src = o.source_location_id;
    const tgt = o.target_location_id;
    return (src != null && (myStoreIds.has(src) || src === wh?.location_id))
        || (tgt != null && (myStoreIds.has(tgt) || tgt === wh?.location_id));
  });
  const pendingCount = myPending.length;
  // 4-stage cascade 분포 (2026-05-14 Stage 0 WH_TO_STORE 추가).
  // 권역 매니저 시야: WH_TO_STORE=내 wh 본체 → 내 권역 매장 / WH_TRANSFER=내 권역 ↔ 다른 권역.
  const myStage0 = myPending.filter((o) => o.order_type === 'WH_TO_STORE').length;
  const myStage1 = myPending.filter((o) => o.order_type === 'REBALANCE').length;
  const myStage2Out = myPending.filter(
    (o) => o.order_type === 'WH_TRANSFER' && o.source_location_id != null && myStoreIds.has(o.source_location_id),
  ).length;
  const myStage2In = myPending.filter(
    (o) => o.order_type === 'WH_TRANSFER' && o.target_location_id != null && (myStoreIds.has(o.target_location_id) || o.target_location_id === wh?.location_id),
  ).length;
  const myStage3 = myPending.filter((o) => o.order_type === 'PUBLISHER_ORDER').length;

  // 받을 거 — 도착 예정일 별 group (forecast_rationale.expected_arrival_date)
  // WH 본체 / 권역 매장이 TARGET 인 PENDING + APPROVED 묶음.
  const todayIso = new Date().toISOString().slice(0, 10);
  const myUpcomingArrival = (pending.data?.items ?? []).filter((o) => {
    if (o.status !== 'PENDING' && o.status !== 'APPROVED') return false;
    const t = o.target_location_id;
    if (t == null) return false;
    return myStoreIds.has(t) || t === wh?.location_id;
  });
  type WhArrivalBucket = { date: string; count: number; orders: typeof myUpcomingArrival };
  const whArrivalBuckets: WhArrivalBucket[] = (() => {
    const m = new Map<string, WhArrivalBucket>();
    for (const o of myUpcomingArrival) {
      const r = ((o as any).forecast_rationale ?? {}) as Record<string, unknown>;
      const d = typeof r.expected_arrival_date === 'string' ? r.expected_arrival_date : null;
      if (!d) continue;
      if (d < todayIso) continue;  // 과거 도착일/출고일 제외 (history 시드 잔존 회피)
      if (!m.has(d)) m.set(d, { date: d, count: 0, orders: [] });
      const b = m.get(d)!;
      b.count += 1;
      b.orders.push(o);
    }
    return [...m.values()].sort((a, b) => a.date.localeCompare(b.date));
  })();
  // 출고 대기 (자기 wh 의 source · PENDING+APPROVED · 운송 대기) — 날짜별 group
  const myUpcomingOutbound = (pending.data?.items ?? []).filter((o) => {
    if (o.status !== 'PENDING' && o.status !== 'APPROVED') return false;
    const s = o.source_location_id;
    if (s == null) return false;
    return myStoreIds.has(s) || s === wh?.location_id;
  });
  const whOutboundBuckets: WhArrivalBucket[] = (() => {
    const m = new Map<string, WhArrivalBucket>();
    for (const o of myUpcomingOutbound) {
      const r = ((o as any).forecast_rationale ?? {}) as Record<string, unknown>;
      const d = typeof r.expected_arrival_date === 'string' ? r.expected_arrival_date : null;
      if (!d) continue;
      if (d < todayIso) continue;  // 과거 도착일/출고일 제외 (history 시드 잔존 회피)
      if (!m.has(d)) m.set(d, { date: d, count: 0, orders: [] });
      const b = m.get(d)!;
      b.count += 1;
      b.orders.push(o);
    }
    return [...m.values()].sort((a, b) => a.date.localeCompare(b.date));
  })();
  const whArrivalLabel = (iso: string): string => {
    const t = new Date(todayIso + 'T00:00:00');
    const d = new Date(iso + 'T00:00:00');
    const diff = Math.round((d.getTime() - t.getTime()) / (24 * 3600 * 1000));
    if (diff <= 0) return '오늘';
    if (diff === 1) return '내일 (D+1)';
    if (diff === 2) return '모레 (D+2)';
    return `${diff}일 후 (D+${diff})`;
  };

  // 입출고 대기 = APPROVED 상태로 실행 대기 중인 주문 (instructions)
  const instrPending = (ov.data?.pending_orders?.items ?? []).filter((o: any) => o.status === 'APPROVED').length;

  // 권역 매장 매출 차트 데이터 (horizontal bar · 1h)
  const storeSalesChart = useMemo(
    () =>
      filteredSales
        .map((s) => {
          const cell = myCells.find((c) => c.location_id === s.store_id);
          const name = cell?.name ?? `매장 ${s.store_id}`;
          return { name, value: Math.round(s.revenue) };
        })
        .sort((a, b) => b.value - a.value),
    [filteredSales, myCells],
  );

  // Funnel data (PENDING → APPROVED → EXECUTED)
  const funnelData = useMemo(() => {
    const sum = funnel.data?.summary ?? {};
    return [
      { name: '대기 (PENDING)', value: sum.PENDING ?? 0 },
      { name: '승인 (APPROVED)', value: sum.APPROVED ?? 0 },
      { name: '실행 (EXECUTED)', value: sum.EXECUTED ?? 0 },
    ];
  }, [funnel.data?.summary]);

  // 일별 line chart 데이터 (date · APPROVED · EXECUTED · REJECTED)
  const dailyChart = useMemo(() => {
    const daily = funnel.data?.daily ?? [];
    return daily.map((d: any) => ({
      date: typeof d.date === 'string' ? d.date.slice(5) : d.date, // MM-DD
      APPROVED: d.APPROVED ?? 0,
      EXECUTED: d.EXECUTED ?? 0,
      REJECTED: d.REJECTED ?? 0,
    }));
  }, [funnel.data?.daily]);

  // 베스트셀러 top 10
  const bestChart = useMemo(
    () =>
      (best.data?.items ?? []).slice(0, 10).map((b) => ({
        name: (b.title ?? b.isbn13).slice(0, 20),
        value: b.qty,
      })),
    [best.data?.items],
  );

  // 카테고리별 권역 매출 pie — 30 일 (상위 8 + 기타)
  const catPieChart = useMemo(() => {
    const items = byCat.data?.items ?? [];
    const sorted = [...items].sort((a, b) => b.revenue - a.revenue);
    const top = sorted.slice(0, 8).map((c) => ({ name: c.category, value: Math.round(c.revenue) }));
    const rest = sorted.slice(8).reduce((s, c) => s + c.revenue, 0);
    return rest > 0 ? [...top, { name: '기타', value: Math.round(rest) }] : top;
  }, [byCat.data?.items]);

  // 권역 회전율 bar (전사 응답에서 내 wh_id 필터 — 1개 row 만 표시되지만 비교 위해 양 권역 모두 표시)
  const turnoverChart = useMemo(
    () =>
      (turnover.data?.items ?? [])
        .map((t) => ({
          name: t.wh_id === 1 ? '수도권' : t.wh_id === 2 ? '영남' : `권역 ${t.wh_id}`,
          value: Number((t.turnover ?? 0).toFixed(2)),
        }))
        .sort((a, b) => b.value - a.value),
    [turnover.data?.items],
  );

  // 요일별 매출 bar (backend dow=0(일)~6(토) 가정 — dow_label 우선 사용)
  const weekdayChart = useMemo(() => {
    const items = weekday.data?.items ?? [];
    return items
      .slice()
      .sort((a, b) => a.dow - b.dow)
      .map((w) => ({ name: w.dow_label ?? String(w.dow), value: Math.round(w.revenue ?? 0) }));
  }, [weekday.data?.items]);

  return (
    <div className="flex flex-col gap-4">
      {/* 헤더 + hq-admin 모드 selector */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="h1">{wh_id === 1 ? '수도권' : '영남'} 권역 대시보드</h1>
          <p className="text-bf-muted text-xs mt-1">매장 매출 · 의사결정 funnel · 베스트셀러 · 재고 한눈에</p>
        </div>
        {isHq && accessibleWhs.length > 1 && (
          <div className="flex items-center gap-2 p-2 rounded-lg bg-bf-panel/60 border border-bf-border/40 shrink-0">
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

      {/* row 0 — 4 metric cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="metric-card">
          <div className="metric-label">30일 권역 매출</div>
          <div className="metric-value">₩{Math.round(total30dRev / 10000).toLocaleString()}만</div>
          <div className="text-[11px] text-bf-muted mt-1">{byCat.data?.items.length ?? 0} 카테고리 합산</div>
        </div>
        <Link to="/wh-approve" className={`metric-card hover:border-bf-primary transition ${pendingCount > 0 ? 'border-bf-warn' : ''}`}>
          <div className="metric-label">협의 필요 (PENDING)</div>
          <div className={`metric-value ${pendingCount > 0 ? 'text-bf-warn' : ''}`}>{pendingCount}건</div>
          <div className="text-[11px] text-bf-muted mt-1">
            🏬 {myStage0} · 🔄 {myStage1} · 🚛 {myStage2Out}/{myStage2In} · 📦 {myStage3}
          </div>
        </Link>
        <Link to="/wh-instructions" className="metric-card hover:border-bf-primary transition">
          <div className="metric-label">입출고 대기</div>
          <div className="metric-value">{instrPending}건</div>
          <div className="text-[11px] text-bf-muted mt-1">승인 완료 → 운송 대기</div>
        </Link>
        <div className="metric-card">
          <div className="metric-label">권역 부족 SKU</div>
          <div className={`metric-value ${totalLowSku > 0 ? 'text-orange-600' : ''}`}>{totalLowSku}</div>
          <div className="text-[11px] text-bf-muted mt-1">결품 {totalZeroSku} · 1h 매출 ₩{Math.round(totalRev1h / 1000)}K</div>
        </div>
      </div>

      {/* row 0.5 — 📥 받을 거 (도착 예정일 별 stage 별 lead time 반영) */}
      {whArrivalBuckets.length > 0 && (
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h2 className="h2 text-sm">📥 받을 거 — 도착 예정일별</h2>
            <span className="text-[10px] text-bf-muted">
              D+1 매장 보충/재분배 · D+2 권역간 · D+4 외부 발주
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            {whArrivalBuckets.map((b) => {
              const types = new Set(b.orders.map((o) => o.order_type));
              const typeLabel = [...types]
                .map((t) =>
                  t === 'WH_TO_STORE'    ? '🏬 매장보충' :
                  t === 'REBALANCE'      ? '🔄 재분배' :
                  t === 'WH_TRANSFER'    ? '🚛 권역간' :
                  t === 'PUBLISHER_ORDER'? '📦 외부발주' : t,
                ).join(' · ');
              return (
                <Link
                  key={b.date}
                  to="/wh-instructions"
                  className="p-3 rounded-md border border-bf-border2 bg-bf-panel2 hover:border-bf-primary transition"
                  title={`${b.count}건 도착 예정`}
                >
                  <div className="flex items-baseline justify-between">
                    <span className="text-xs font-semibold text-bf-primary">{whArrivalLabel(b.date)}</span>
                    <span className="text-[10px] text-bf-muted">{b.date}</span>
                  </div>
                  <div className="mt-1 text-lg font-bold text-bf-text">{b.count}건</div>
                  <div className="text-[11px] text-bf-muted mt-1">{typeLabel}</div>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* row 0.6 — 📤 출고 대기 (자기 wh source · 운송 대기) · 날짜별 group */}
      {whOutboundBuckets.length > 0 && (
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h2 className="h2 text-sm">📤 보낼 거 — 출고 대기 (날짜별)</h2>
            <span className="text-[10px] text-bf-muted">우리 wh 또는 권역 매장 source · 운송 차 routing</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {whOutboundBuckets.map((b) => {
              const types = new Set(b.orders.map((o) => o.order_type));
              const typeLabel = [...types]
                .map((t) =>
                  t === 'WH_TO_STORE'    ? '🏬 매장보충' :
                  t === 'REBALANCE'      ? '🔄 재분배' :
                  t === 'WH_TRANSFER'    ? '🚛 권역간' :
                  t === 'PUBLISHER_ORDER'? '📦 외부발주' : t,
                ).join(' · ');
              return (
                <Link
                  key={b.date}
                  to="/wh-instructions"
                  className="block p-2 rounded border border-bf-border2 bg-bf-panel2 hover:border-bf-warn transition"
                  title={`${b.count}건 출고 예정`}
                >
                  <div className="flex items-baseline justify-between">
                    <span className="text-xs font-semibold text-bf-warn">{whArrivalLabel(b.date)}</span>
                    <span className="text-[10px] text-bf-muted">{b.date}</span>
                  </div>
                  <div className="mt-1 text-lg font-bold text-bf-text">{b.count}건</div>
                  <div className="text-[11px] text-bf-muted mt-1">{typeLabel}</div>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* row 1 — 매장 매출 비교 + cascade funnel */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="card">
          <h3 className="h3 mb-2">권역 매장 매출 (최근 1시간)</h3>
          <KpiBar
            data={storeSalesChart}
            horizontal
            height={280}
            isLoading={byStore.isLoading}
          />
        </div>
        <div className="card">
          <h3 className="h3 mb-2">권역 의사결정 funnel (7일)</h3>
          <KpiFunnel data={funnelData} height={280} isLoading={funnel.isLoading} />
        </div>
      </div>

      {/* row 2 — 7일 입출고 추이 */}
      <div className="card">
        <h3 className="h3 mb-2">7일 입출고 추이 (승인 · 실행 · 거절)</h3>
        <KpiLine
          data={dailyChart}
          xKey="date"
          yKey={['APPROVED', 'EXECUTED', 'REJECTED']}
          yLabels={['승인', '실행', '거절']}
          height={260}
          smooth
          isLoading={funnel.isLoading}
        />
      </div>

      {/* row 3 — 베스트셀러 top 10 */}
      <div className="card">
        <h3 className="h3 mb-2">권역 베스트셀러 top 10 (7일)</h3>
        <KpiBar
          data={bestChart}
          horizontal
          height={320}
          isLoading={best.isLoading}
        />
      </div>

      {/* row 3.5 — 신규 BI: 카테고리 pie + 회전율 bar (2 col) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="card">
          <h3 className="h3 mb-2">카테고리별 권역 매출 (30일)</h3>
          <KpiPie data={catPieChart} height={300} isLoading={byCat.isLoading} />
        </div>
        <div className="card">
          <h3 className="h3 mb-2">권역 회전율 비교 (30일 · 매출 ÷ 평균재고)</h3>
          <KpiBar
            data={turnoverChart}
            height={300}
            isLoading={turnover.isLoading}
          />
        </div>
      </div>

      {/* row 3.6 — 요일별 매출 (30일 합산 · 전사 응답) */}
      <div className="card">
        <h3 className="h3 mb-2">요일별 매출 (30일 합산)</h3>
        <KpiBar data={weekdayChart} height={240} isLoading={weekday.isLoading} />
      </div>

      {/* row 4 — 협의 필요 list (기존 유지 · 권역 매장 필터) */}
      <div className="card">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="h2">협의 필요 (PENDING) · 권역 매장</h2>
          <Link to="/wh-approve" className="text-xs text-bf-primary hover:underline">전체 처리 대기 →</Link>
        </div>
        <table className="data-table">
          <thead>
            <tr><th>긴급도</th><th>유형</th><th>ISBN</th><th>출발 → 도착</th><th>수량</th><th>접수 시각</th></tr>
          </thead>
          <tbody>
            {myPending.slice(0, 15).map((o) => (
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
            {myPending.length === 0 && (
              <tr><td colSpan={6} className="text-center text-bf-muted py-4">협의 필요 주문 없음</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* row 5 — 권역 재고 히트맵 (기존 유지 · 셀 grid · 큰 부담 X) */}
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

      {/* row 6 — 부족 도서 × 매장 매트릭스 (top 50 만 · 시각 부담 감소 · Redis 실시간 cell flash) */}
      {(() => {
        const invItems = (ov.data?.inventory?.items ?? []) as any[];
        const myInv = invItems.filter((it) => myStoreIds.has(it.location_id));
        const lowByIsbn = new Map<string, { title?: string; perStore: Record<number, any> }>();
        for (const it of myInv) {
          const av = availableOf(it.isbn13, it.location_id) ?? it.available;
          if (av > (it.safety_stock ?? 10) * 2) continue;
          if (!lowByIsbn.has(it.isbn13)) lowByIsbn.set(it.isbn13, { title: it.title, perStore: {} });
          lowByIsbn.get(it.isbn13)!.perStore[it.location_id] = it;
        }
        // top 50 (부족 매장 많은 순) · 사용자 결정 — 1000 × 6 부담 줄임
        const sorted = [...lowByIsbn.entries()]
          .sort((a, b) => Object.keys(b[1].perStore).length - Object.keys(a[1].perStore).length)
          .slice(0, 50);
        if (sorted.length === 0) return null;
        return (
          <div className="card">
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="h2">권역 부족 도서 × 매장 (top 50 · 책 단위 실시간)</h2>
              <div className="text-[11px] text-bf-muted">
                POS 결제 시 cell <span className="px-1 bg-yellow-100">flash</span> · 가용 ≤ 2× 안전재고 만 표시 ·
                <span className="ml-1">셀 아래 작은 숫자 = <b>AI D+1 예측 (5일치)</b></span>
              </div>
            </div>
            <div className="overflow-x-auto max-h-[480px]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-bf-panel">
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

      {/* row 7 — 타 센터 재고 (Stage 2 의사결정 참고 · 기존 유지) */}
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
        const oInvItems = (other.inventory?.items ?? []) as any[];
        const oWhStores = new Set(oCells.map((c) => c.location_id));
        const oLowByIsbn = new Map<string, { title?: string; available: number; safety: number; on_hand: number }>();
        for (const it of oInvItems) {
          if (!oWhStores.has(it.location_id)) continue;
          const av = it.available ?? 0;
          const sf = it.safety_stock ?? 10;
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
    </div>
  );
}
