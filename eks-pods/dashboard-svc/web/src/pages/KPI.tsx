/**
 * 본사 KPI 모니터링 — 풀-스택 BI 대시보드 (echarts).
 *
 * 기존 차트 (1h 실시간) + 30일 trend 분석 차트 통합.
 * 데이터 소스:
 *   - sales-summary / sales-by-store / recent-sales / overview (1h · 실시간 30 초 polling)
 *   - sales/daily-30d · sales/weekday-avg · sales/hour-avg · kpi/category-trend
 *     sales/asp · forecast/accuracy · sales/store-weekday (30 분 polling · trend 차트)
 *   - sales/bestsellers · cascade/funnel · kpi/by-category (5 분 staleTime · 변동 적음)
 */
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useOutletContext } from 'react-router-dom';
import KpiLine from '../components/charts/KpiLine';
import KpiBar from '../components/charts/KpiBar';
import KpiPie from '../components/charts/KpiPie';
import KpiFunnel from '../components/charts/KpiFunnel';
import KpiHeatmap from '../components/charts/KpiHeatmap';
import {
  fetchOverview,
  fetchSalesSummary,
  fetchSalesByStore,
  fetchRecentSales,
  fetchBestsellers,
  fetchCascadeFunnel,
  type Role,
  type PendingOrder,
} from '../api';
import { token } from '../auth';
import { useLocations } from '../useLocations';

// ─── KPI 전용 trend fetch helper (inline · BFF 신규 endpoint 호출) ────
// endpoint 미배포 시 fetch 가 throw → useQuery isError · data undefined → 차트 "데이터 없음" placeholder
async function _kpiGet<T>(path: string, role: Role): Promise<T> {
  const r = await fetch(path, { headers: { Authorization: token(role) } });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

// path 정합 — backend (master.py · sub-agent a8040c 결과) 와 일치
type DailySalesItem = { date: string; revenue: number; qty: number };
const fetchSales30Days = (role: Role) =>
  _kpiGet<{ items: DailySalesItem[] }>('/dashboard/sales/30days', role);

type WeekdayItem = { dow: number; dow_label: string; revenue: number; qty: number; tx_count: number };
const fetchSalesByWeekday = (role: Role) =>
  _kpiGet<{ days: number; items: WeekdayItem[] }>('/dashboard/sales/by-weekday?days=30', role);

type HourAvgItem = { hour: number; avg_revenue: number; avg_qty: number; avg_tx_count: number };
const fetchSalesByHourAvg = (role: Role) =>
  _kpiGet<{ days: number; items: HourAvgItem[] }>('/dashboard/sales/by-hour-avg?days=30', role);

type CategoryTrendItem = { date: string; category: string; revenue: number };
const fetchCategoryTrend = (role: Role) =>
  _kpiGet<{ days: number; categories: string[]; items: CategoryTrendItem[] }>(
    '/dashboard/sales/category-trend?days=30', role,
  );

type AspItem = { date: string; asp: number; revenue: number; tx_count: number };
const fetchSalesAsp = (role: Role) =>
  _kpiGet<{ days: number; items: AspItem[] }>('/dashboard/sales/asp?days=30', role);

type AccuracyItem = { date: string; mae: number; mape: number; total_predicted: number; total_actual: number };
const fetchForecastAccuracy = (role: Role) =>
  _kpiGet<{ days: number; items: AccuracyItem[] }>('/dashboard/forecast/accuracy?days=7', role);

type StoreWeekdayItem = { store_id: number; store_name: string; dow: number; revenue: number };
const fetchStoreWeekday = (role: Role) =>
  _kpiGet<{ items: StoreWeekdayItem[] }>('/dashboard/sales/store-weekday', role);

// ─── 컴포넌트 ────────────────────────────────────────────────────────
export default function KPI() {
  const { role } = useOutletContext<{ role: Role }>();
  const wh_id = 1;
  const { nameOf, byId } = useLocations(role);

  // ── 실시간 (30 초) — 기존 ──────────────────────────────────────────
  const ov = useQuery({
    queryKey: ['ov', wh_id, role],
    queryFn: () => fetchOverview(wh_id, role),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  const summ = useQuery({
    queryKey: ['summ', role],
    queryFn: () => fetchSalesSummary(role),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  const byStore = useQuery({
    queryKey: ['byStore', role],
    queryFn: () => fetchSalesByStore(role),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  const recent = useQuery({
    queryKey: ['recent', role],
    queryFn: () => fetchRecentSales(role, 60),
    refetchInterval: 5_000,
    staleTime: 3_000,
  });

  // ── trend (30 분) — 신규 ───────────────────────────────────────────
  const TREND_OPTS = { refetchInterval: 30 * 60 * 1000, staleTime: 5 * 60 * 1000, retry: 0 };
  const sales30 = useQuery({ queryKey: ['sales30', role], queryFn: () => fetchSales30Days(role), ...TREND_OPTS });
  const weekday = useQuery({ queryKey: ['weekday', role], queryFn: () => fetchSalesByWeekday(role), ...TREND_OPTS });
  const hourAvg = useQuery({ queryKey: ['hourAvg', role], queryFn: () => fetchSalesByHourAvg(role), ...TREND_OPTS });
  const catTrend = useQuery({ queryKey: ['catTrend', role], queryFn: () => fetchCategoryTrend(role), ...TREND_OPTS });
  const asp = useQuery({ queryKey: ['asp', role], queryFn: () => fetchSalesAsp(role), ...TREND_OPTS });
  const accuracy = useQuery({ queryKey: ['accuracy', role], queryFn: () => fetchForecastAccuracy(role), ...TREND_OPTS });
  const storeWeek = useQuery({ queryKey: ['storeWeek', role], queryFn: () => fetchStoreWeekday(role), ...TREND_OPTS });

  // ── 변동 적음 (5 분) ──────────────────────────────────────────────
  const SLOW_OPTS = { refetchInterval: 5 * 60 * 1000, staleTime: 5 * 60 * 1000, retry: 0 };
  const best = useQuery({ queryKey: ['best30', role], queryFn: () => fetchBestsellers(role, 30, 30), ...SLOW_OPTS });
  const funnel = useQuery({ queryKey: ['funnel7', role], queryFn: () => fetchCascadeFunnel(role, 7), ...SLOW_OPTS });

  // ─── 차트 데이터 가공 ──────────────────────────────────────────────

  /** 최근 60건 트랜잭션 분 단위 버킷 (기존). */
  const minuteSeries = useMemo(() => {
    const rows = recent.data?.items ?? [];
    const buckets = new Map<string, { revenue: number; qty: number }>();
    for (const r of rows) {
      const d = new Date(r.event_ts);
      const key = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const b = buckets.get(key) ?? { revenue: 0, qty: 0 };
      b.revenue += r.revenue;
      b.qty += r.qty;
      buckets.set(key, b);
    }
    return Array.from(buckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([t, v]) => ({ t, revenue: v.revenue, qty: v.qty }));
  }, [recent.data]);

  /** 채널 mix. */
  const channelMix = useMemo(() => {
    if (!summ.data) return [];
    return [
      { name: '온라인', value: summ.data.online_count },
      { name: '오프라인', value: summ.data.offline_count },
    ];
  }, [summ.data]);

  /** 매장별 매출 top 12. */
  const storeBars = useMemo(() => {
    const items = byStore.data?.items ?? [];
    return [...items]
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 12)
      .map((s) => ({ name: nameOf(s.store_id), revenue: s.revenue, transactions: s.transactions }));
  }, [byStore.data, nameOf]);

  /** 권역 stacked. */
  const regionStack = useMemo(() => {
    const items = byStore.data?.items ?? [];
    const agg: Record<number, { revenue: number; tx: number; online: number; offline: number }> = {
      1: { revenue: 0, tx: 0, online: 0, offline: 0 },
      2: { revenue: 0, tx: 0, online: 0, offline: 0 },
    };
    for (const s of items) {
      const wh = byId.get(s.store_id)?.wh_id;
      if (wh !== 1 && wh !== 2) continue;
      agg[wh].revenue += s.revenue;
      agg[wh].tx += s.transactions;
      agg[wh].online += s.online_count;
      agg[wh].offline += s.transactions - s.online_count;
    }
    return [
      { name: '수도권 (WH-1)', online: agg[1].online, offline: agg[1].offline },
      { name: '영남 (WH-2)', online: agg[2].online, offline: agg[2].offline },
    ];
  }, [byStore.data, byId]);

  /** PENDING funnel. */
  const pendingFunnel = useMemo(() => {
    const items = (ov.data?.pending_orders?.items ?? []) as PendingOrder[];
    const counts: Record<string, number> = { REBALANCE: 0, WH_TRANSFER: 0, PUBLISHER_ORDER: 0 };
    for (const p of items) if (p.order_type in counts) counts[p.order_type] += 1;
    return [
      { name: 'REBALANCE (매장↔매장)', value: counts.REBALANCE },
      { name: 'WH_TRANSFER (창고→매장)', value: counts.WH_TRANSFER },
      { name: 'PUBLISHER_ORDER (출판사 발주)', value: counts.PUBLISHER_ORDER },
    ];
  }, [ov.data]);

  /** 30일 매출 trend — date, revenue, qty. */
  const sales30Series = useMemo(
    () => (sales30.data?.items ?? []).map((d) => ({ date: d.date.slice(5), revenue: d.revenue, qty: d.qty })),
    [sales30.data],
  );

  /** 요일별 평균 매출 — 월~일. */
  const weekdayBars = useMemo(() => {
    const items = weekday.data?.items ?? [];
    return [...items]
      .sort((a, b) => a.dow - b.dow)
      .map((d) => ({ name: d.dow_label, value: d.revenue }));
  }, [weekday.data]);

  /** 시간대 평균 매출 — 0~23. */
  const hourBars = useMemo(
    () => (hourAvg.data?.items ?? []).map((d) => ({ name: `${d.hour}시`, value: d.avg_revenue })),
    [hourAvg.data],
  );

  /** 카테고리 trend — date × top 5 카테고리. KpiLine 다중 series 입력 형태. */
  const catTrendSeries = useMemo(() => {
    if (!catTrend.data) return { rows: [] as Record<string, string | number>[], cats: [] as string[] };
    const cats = catTrend.data.categories ?? [];
    const byDate = new Map<string, Record<string, string | number>>();
    for (const it of catTrend.data.items) {
      const dt = it.date.slice(5);
      const row = byDate.get(dt) ?? { date: dt };
      row[it.category] = it.revenue;
      byDate.set(dt, row);
    }
    // 빈 값 채움 (0)
    const rows = Array.from(byDate.values()).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    for (const r of rows) for (const c of cats) if (r[c] === undefined) r[c] = 0;
    return { rows, cats };
  }, [catTrend.data]);

  /** ASP trend. */
  const aspSeries = useMemo(
    () => (asp.data?.items ?? []).map((d) => ({ date: d.date.slice(5), asp: d.asp })),
    [asp.data],
  );

  /** 베스트셀러 top 30 (horizontal bar — title 자르기). */
  const bestBars = useMemo(() => {
    const items = best.data?.items ?? [];
    return items.slice(0, 30).map((b) => ({
      name: (b.title ?? b.isbn13).slice(0, 18),
      value: b.revenue,
    })).reverse(); // horizontal 은 상위가 위쪽
  }, [best.data]);

  const WEEKDAY_LABELS = ['월', '화', '수', '목', '금', '토', '일'];

  /** 매장 × 요일 매출 heatmap — /dashboard/sales/store-weekday (Postgres DOW → 월~일 라벨 매핑). */
  const storeHeat = useMemo(
    () => (storeWeek.data?.items ?? []).map((d) => ({
      x: WEEKDAY_LABELS[(d.dow + 6) % 7],
      y: d.store_name,
      value: d.revenue,
    })),
    [storeWeek.data],
  );

  /** forecast 정확도 (MAPE 7일 line). */
  const accuracySeries = useMemo(
    () => (accuracy.data?.items ?? []).map((d) => ({ date: d.date.slice(5), mape: d.mape })),
    [accuracy.data],
  );

  /** funnel 7일 cascade summary (data alt: cascade 가 있으면 그것 사용 · 없으면 PENDING funnel 유지). */
  const cascadeBars = useMemo(() => {
    const summary = funnel.data?.summary;
    if (!summary) return [];
    const order = ['PENDING', 'APPROVED', 'AUTO_EXECUTED', 'EXECUTED', 'REJECTED'];
    return order
      .filter((k) => summary[k] !== undefined)
      .map((k) => ({ name: k, value: summary[k] }));
  }, [funnel.data]);

  // ─── 권역 요약 카드 ────────────────────────────────────────────────
  const regionSummary = useMemo(() => {
    const items = byStore.data?.items ?? [];
    if (items.length === 0) return null;
    const agg: Record<number, { stores: number; revenue: number; tx: number; online: number }> = {
      1: { stores: 0, revenue: 0, tx: 0, online: 0 },
      2: { stores: 0, revenue: 0, tx: 0, online: 0 },
    };
    for (const s of items) {
      const wh = byId.get(s.store_id)?.wh_id;
      if (wh !== 1 && wh !== 2) continue;
      agg[wh].stores += 1;
      agg[wh].revenue += s.revenue;
      agg[wh].tx += s.transactions;
      agg[wh].online += s.online_count;
    }
    return agg;
  }, [byStore.data, byId]);

  const isLoadingAll = ov.isLoading && summ.isLoading && byStore.isLoading && recent.isLoading;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="h1">본사 KPI 모니터링</h1>
          <p className="text-bf-muted text-xs mt-1">
            실시간 1h · 30일 trend · 7일 forecast · echarts BI
          </p>
        </div>
        {ov.data && ov.data._partial_failures.length > 0 && (
          <span className="pill-pending text-xs">
            미응답: {ov.data._partial_failures.join(', ')}
          </span>
        )}
      </div>

      {/* ── 1행: 5 metric ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="metric-card">
          <div className="metric-label">트랜잭션 (1h)</div>
          <div className="metric-value">{summ.data?.transactions ?? '-'}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">매출 (1h)</div>
          <div className="metric-value">
            {summ.data ? `₩${(summ.data.total_revenue / 1000).toFixed(0)}K` : '-'}
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">온라인 / 오프라인</div>
          <div className="metric-value">
            {summ.data ? `${summ.data.online_count}/${summ.data.offline_count}` : '-'}
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">PENDING 주문</div>
          <div className="metric-value">{ov.data?.pending_orders?.items.length ?? '-'}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">5-pod 상태</div>
          <div className="metric-value text-base">
            <span
              className={
                ov.data && ov.data._partial_failures.length === 0
                  ? 'text-bf-success'
                  : 'text-bf-danger'
              }
            >
              {ov.data ? `${5 - ov.data._partial_failures.length}/5` : '-'}
            </span>
          </div>
        </div>
      </div>

      {/* ── 2행: 30일 매출 trend + 채널 pie ───────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="card lg:col-span-2">
          <div className="flex items-center justify-between mb-2">
            <h3 className="h3">30일 매출 추이</h3>
            <span className="label-tag">daily · 매출 + 수량</span>
          </div>
          <KpiLine
            data={sales30Series}
            xKey="date"
            yKey={['revenue', 'qty']}
            yLabels={['매출(₩)', '수량']}
            area
            smooth
            height={320}
            isLoading={sales30.isLoading}
          />
        </div>
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h3 className="h3">채널 mix (1h)</h3>
            <span className="label-tag">online vs offline</span>
          </div>
          <KpiPie data={channelMix} donut height={320} isLoading={summ.isLoading} />
        </div>
      </div>

      {/* ── 3행: 요일 + 시간대 평균 ──────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h3 className="h3">요일별 매출 평균 (30일)</h3>
            <span className="label-tag">월~일</span>
          </div>
          <KpiBar data={weekdayBars} height={260} isLoading={weekday.isLoading} />
        </div>
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h3 className="h3">시간대별 매출 평균 (30일)</h3>
            <span className="label-tag">0~23시</span>
          </div>
          <KpiBar data={hourBars} height={260} isLoading={hourAvg.isLoading} />
        </div>
      </div>

      {/* ── 4행: 카테고리 trend + ASP ────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h3 className="h3">카테고리 매출 트렌드 (top 5)</h3>
            <span className="label-tag">30일 daily</span>
          </div>
          <KpiLine
            data={catTrendSeries.rows}
            xKey="date"
            yKey={catTrendSeries.cats}
            yLabels={catTrendSeries.cats}
            smooth
            height={260}
            isLoading={catTrend.isLoading}
          />
        </div>
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h3 className="h3">객단가 (ASP) 트렌드</h3>
            <span className="label-tag">30일 daily</span>
          </div>
          <KpiLine
            data={aspSeries}
            xKey="date"
            yKey="asp"
            yLabels={['ASP(₩)']}
            area
            smooth
            height={260}
            isLoading={asp.isLoading}
          />
        </div>
      </div>

      {/* ── 5행: 매장 매출 horizontal + 의사결정 funnel ─────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h3 className="h3">매장별 매출 top 12 (1h)</h3>
            <span className="label-tag">{byStore.data?.items.length ?? 0} 매장</span>
          </div>
          <KpiBar
            data={storeBars}
            xKey="name"
            yKey="revenue"
            horizontal
            height={360}
            isLoading={byStore.isLoading}
          />
        </div>
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h3 className="h3">의사결정 funnel (7일)</h3>
            <span className="label-tag">decision-svc cascade</span>
          </div>
          {cascadeBars.length > 0 ? (
            <KpiFunnel data={cascadeBars} height={360} isLoading={funnel.isLoading} />
          ) : (
            <KpiFunnel data={pendingFunnel} height={360} isLoading={ov.isLoading} />
          )}
        </div>
      </div>

      {/* ── 6행: 베스트셀러 top 30 + 매장 × 요일 heatmap ────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h3 className="h3">베스트셀러 top 30 (30일)</h3>
            <span className="label-tag">매출 기준</span>
          </div>
          <KpiBar
            data={bestBars}
            xKey="name"
            yKey="value"
            horizontal
            height={520}
            isLoading={best.isLoading}
          />
        </div>
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h3 className="h3">매장 × 요일 매출 heatmap</h3>
            <span className="label-tag">30일 평균</span>
          </div>
          <KpiHeatmap data={storeHeat} xLabels={WEEKDAY_LABELS} height={520} isLoading={storeWeek.isLoading} />
        </div>
      </div>

      {/* ── 7행: 권역 stacked + forecast 정확도 ──────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h3 className="h3">권역 × 채널 거래 건수 (1h)</h3>
            <span className="label-tag">WH-1 · WH-2 stacked</span>
          </div>
          <KpiBar
            data={regionStack}
            xKey="name"
            yKey={['online', 'offline']}
            yLabels={['온라인', '오프라인']}
            stacked
            height={260}
            isLoading={byStore.isLoading}
          />
        </div>
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h3 className="h3">forecast 정확도 (MAPE 7일)</h3>
            <span className="label-tag">낮을수록 정확</span>
          </div>
          <KpiLine
            data={accuracySeries}
            xKey="date"
            yKey="mape"
            yLabels={['MAPE(%)']}
            smooth
            height={260}
            isLoading={accuracy.isLoading}
          />
        </div>
      </div>

      {/* ── 8행: 권역 요약 카드 (보존) ───────────────────────────── */}
      {regionSummary && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {([1, 2] as const).map((wh) => {
            const a = regionSummary[wh];
            const total = regionSummary[1].revenue + regionSummary[2].revenue;
            const share = total > 0 ? Math.round((a.revenue / total) * 100) : 0;
            const onlinePct = a.tx > 0 ? Math.round((a.online / a.tx) * 100) : 0;
            const meta = wh === 1
              ? { name: '수도권', color: 'border-blue-300' }
              : { name: '영남', color: 'border-rose-300' };
            return (
              <div key={wh} className={`card border-2 ${meta.color}`}>
                <div className="flex items-baseline justify-between mb-2">
                  <h2 className="h2">{meta.name} 권역 (WH-{wh})</h2>
                  <span className="text-xs text-bf-muted">매출 점유 {share}%</span>
                </div>
                <div className="grid grid-cols-4 gap-3">
                  <div>
                    <div className="text-bf-muted text-[10px]">관할 매장</div>
                    <div className="text-lg font-mono">{a.stores}</div>
                  </div>
                  <div>
                    <div className="text-bf-muted text-[10px]">매출 (1h)</div>
                    <div className="text-lg font-mono">₩{(a.revenue / 1000).toFixed(0)}K</div>
                  </div>
                  <div>
                    <div className="text-bf-muted text-[10px]">거래 수</div>
                    <div className="text-lg font-mono">{a.tx}</div>
                  </div>
                  <div>
                    <div className="text-bf-muted text-[10px]">온라인 비중</div>
                    <div className="text-lg font-mono">{onlinePct}%</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── 9행: 분 단위 trend (실시간 5초) + raw table ──────────── */}
      <div className="card">
        <div className="flex items-center justify-between mb-2">
          <h3 className="h3">최근 트랜잭션 분당 매출 · 건수</h3>
          <span className="label-tag">5초 polling · 최근 60건</span>
        </div>
        <KpiLine
          data={minuteSeries}
          xKey="t"
          yKey={['revenue', 'qty']}
          yLabels={['매출(₩)', '건수']}
          dualAxis
          area
          smooth
          height={220}
          isLoading={recent.isLoading}
        />
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="h2">최근 POS 트랜잭션</h2>
          <span className="label-tag">pos-ingestor Lambda · 5초 polling</span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>시간</th>
              <th>ISBN</th>
              <th>매장</th>
              <th>채널</th>
              <th>수량</th>
              <th className="text-right">매출</th>
            </tr>
          </thead>
          <tbody>
            {recent.data?.items.slice(0, 12).map((s) => (
              <tr key={s.txn_id}>
                <td className="text-bf-muted">{new Date(s.event_ts).toLocaleTimeString()}</td>
                <td className="font-mono">{s.isbn13}</td>
                <td>{nameOf(s.store_id)}</td>
                <td>
                  <span className={s.channel === 'OFFLINE' ? 'pill-info' : 'pill-up'}>
                    {s.channel}
                  </span>
                </td>
                <td>{s.qty}</td>
                <td className="text-right">₩{s.revenue.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isLoadingAll && (
        <p className="text-bf-muted text-xs text-center">초기 데이터 로딩 중…</p>
      )}
    </div>
  );
}
