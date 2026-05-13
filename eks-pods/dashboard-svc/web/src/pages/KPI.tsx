/**
 * 본사 KPI 모니터링 — BI 대시보드 (echarts).
 *
 * 기존 5초 polling 유지. 매장별 막대를 echarts bar 로 교체 + 다음 차트 추가:
 *  - line  : 최근 트랜잭션 분당 매출/건수 trend
 *  - pie   : 채널 mix (online vs offline)
 *  - bar   : 매장별 매출 (horizontal · top 12)
 *  - bar   : 권역별 매출/건수/온라인 (stacked vertical)
 *  - funnel: PENDING orders by type (REBALANCE → WH_TRANSFER → PUBLISHER_ORDER)
 *
 * Note: 차트 wrapper 는 ./components/charts/* — 모든 페이지 재사용 가능.
 */
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useOutletContext } from 'react-router-dom';
import KpiLine from '../components/charts/KpiLine';
import KpiBar from '../components/charts/KpiBar';
import KpiPie from '../components/charts/KpiPie';
import KpiFunnel from '../components/charts/KpiFunnel';
import {
  fetchOverview,
  fetchSalesSummary,
  fetchSalesByStore,
  fetchRecentSales,
  type Role,
  type PendingOrder,
} from '../api';
import { useLocations } from '../useLocations';

export default function KPI() {
  const { role } = useOutletContext<{ role: Role }>();
  const wh_id = 1;
  const { nameOf, byId } = useLocations(role);

  // overview: 큰 payload (inventory + pending) — 30 초 (queryKey 통일)
  const ov = useQuery({
    queryKey: ['ov', wh_id, role],
    queryFn: () => fetchOverview(wh_id, role),
    refetchInterval: 30000,
    staleTime: 15000,
  });
  // summary: 1h 매출 — 30 초 (이전 5 초)
  const summ = useQuery({
    queryKey: ['summ', role],
    queryFn: () => fetchSalesSummary(role),
    refetchInterval: 30000,
    staleTime: 15000,
  });
  // 매장별 (KPI 와 WhDashboard 공유) — 30 초
  const byStore = useQuery({
    queryKey: ['byStore', role],
    queryFn: () => fetchSalesByStore(role),
    refetchInterval: 30000,
    staleTime: 15000,
  });
  // 최근 트랜잭션 stream — 5 초 (실시간 시연용 · 3 초는 과함)
  const recent = useQuery({
    queryKey: ['recent', role],
    queryFn: () => fetchRecentSales(role, 60),
    refetchInterval: 5000,
    staleTime: 3000,
  });

  // ─── 차트 데이터 가공 ───────────────────────────────────────────────

  /** 최근 60건 트랜잭션을 분 단위 버킷으로 묶어 매출/건수 trend 생성. */
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

  /** 채널 mix (online vs offline). */
  const channelMix = useMemo(() => {
    if (!summ.data) return [];
    return [
      { name: '온라인', value: summ.data.online_count },
      { name: '오프라인', value: summ.data.offline_count },
    ];
  }, [summ.data]);

  /** 매장별 매출 top 12 (horizontal bar). */
  const storeBars = useMemo(() => {
    const items = byStore.data?.items ?? [];
    return [...items]
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 12)
      .map((s) => ({
        name: nameOf(s.store_id),
        revenue: s.revenue,
        transactions: s.transactions,
      }));
  }, [byStore.data, nameOf]);

  /** 권역(WH-1 수도권 · WH-2 영남) 집계 — stacked bar. */
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
      { name: '수도권 (WH-1)', online: agg[1].online, offline: agg[1].offline, revenue: agg[1].revenue, tx: agg[1].tx },
      { name: '영남 (WH-2)', online: agg[2].online, offline: agg[2].offline, revenue: agg[2].revenue, tx: agg[2].tx },
    ];
  }, [byStore.data, byId]);

  /** PENDING orders funnel — by order_type. */
  const pendingFunnel = useMemo(() => {
    const items = (ov.data?.pending_orders?.items ?? []) as PendingOrder[];
    const counts: Record<string, number> = { REBALANCE: 0, WH_TRANSFER: 0, PUBLISHER_ORDER: 0 };
    for (const p of items) {
      if (p.order_type in counts) counts[p.order_type] += 1;
    }
    return [
      { name: 'REBALANCE (매장↔매장)', value: counts.REBALANCE },
      { name: 'WH_TRANSFER (창고→매장)', value: counts.WH_TRANSFER },
      { name: 'PUBLISHER_ORDER (출판사 발주)', value: counts.PUBLISHER_ORDER },
    ];
  }, [ov.data]);

  const isLoadingAll = ov.isLoading && summ.isLoading && byStore.isLoading && recent.isLoading;

  // ─── 권역 요약 카드 (기존 로직 보존) ────────────────────────────────
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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="h1">본사 KPI 모니터링</h1>
          <p className="text-bf-muted text-xs mt-1">실시간 POS · 5-pod fan-in · 5-30초 polling · echarts BI</p>
        </div>
        {ov.data && ov.data._partial_failures.length > 0 && (
          <span className="pill-pending text-xs">
            미응답: {ov.data._partial_failures.join(', ')}
          </span>
        )}
      </div>

      {/* ── 1행: KPI 카드 ───────────────────────────────────────────── */}
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

      {/* ── 2행: 트랜잭션 trend (line · col-span 2) + 채널 mix (pie) ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="card lg:col-span-2">
          <div className="flex items-center justify-between mb-2">
            <h3 className="h3">최근 트랜잭션 분당 매출 · 건수</h3>
            <span className="label-tag">5초 polling · 최근 60건</span>
          </div>
          <KpiLine
            data={minuteSeries}
            xKey="t"
            yKey={['revenue', 'qty']}
            yLabels={['매출(₩)', '건수']}
            area
            smooth
            height={260}
            isLoading={recent.isLoading}
          />
        </div>
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h3 className="h3">채널 mix (1h)</h3>
            <span className="label-tag">online vs offline</span>
          </div>
          <KpiPie data={channelMix} donut height={260} isLoading={summ.isLoading} />
        </div>
      </div>

      {/* ── 3행: 권역 요약 카드 (보존) ─────────────────────────────── */}
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

      {/* ── 4행: 매장별 매출 top 12 (horizontal) + PENDING funnel ──── */}
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
            <h3 className="h3">PENDING 주문 종류별 분포</h3>
            <span className="label-tag">decision-svc</span>
          </div>
          <KpiFunnel
            data={pendingFunnel}
            height={360}
            isLoading={ov.isLoading}
          />
        </div>
      </div>

      {/* ── 5행: 권역 stacked (online vs offline) ──────────────────── */}
      <div className="card">
        <div className="flex items-center justify-between mb-2">
          <h3 className="h3">권역 × 채널 거래 건수 (stacked)</h3>
          <span className="label-tag">WH-1 수도권 · WH-2 영남</span>
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

      {/* ── 6행: 최근 트랜잭션 raw table (기존 보존) ──────────────── */}
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
