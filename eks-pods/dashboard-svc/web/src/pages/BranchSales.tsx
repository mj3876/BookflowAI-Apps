import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import {
  fetchSalesBySpecificStore, fetchKpiByCategory, fetchBestsellers,
  fetchSales30Days, fetchSalesByPayment, fetchSalesAsp,
  fetchSalesByWeekday, fetchSalesByHourAvg, fetchSalesTimeseries,
  type Granularity, type Role,
} from '../api';
import { useLocations } from '../useLocations';
import EmptyState from '../components/EmptyState';
import KpiLine from '../components/charts/KpiLine';
import KpiBar from '../components/charts/KpiBar';
import KpiPie from '../components/charts/KpiPie';
import { GranularityToggle } from '../components/GranularityToggle';
import { formatBucket, grainCaption } from '../granularity';

export default function BranchSales() {
  const { role } = useOutletContext<{ role: Role }>();
  const [storeId, setStoreId] = useState(1);
  const { items: locItems, nameOf } = useLocations(role);

  // 최근 트랜잭션 list (POS 실시간 흐름) — 5 초 (이전 3 초는 과함)
  const q = useQuery({
    queryKey: ['sales-store', storeId, role],
    queryFn: () => fetchSalesBySpecificStore(role, storeId, 50),
    refetchInterval: 5000,
    staleTime: 3000,
  });

  // 카테고리 매출 30 일 — 5 분 cache
  const byCat = useQuery({
    queryKey: ['sales-cat', storeId, role],
    queryFn: () => fetchKpiByCategory(role, 30, storeId),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 2 * 60 * 1000,
  });

  // 30 일 베스트셀러 — 거의 안 변함. 5 분
  const best30 = useQuery({
    queryKey: ['sales-best30', storeId, role],
    queryFn: () => fetchBestsellers(role, 30, 20, storeId),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 2 * 60 * 1000,
  });

  // 30일 일별 매출 (sales/30days · 실 endpoint)
  const sales30 = useQuery({
    queryKey: ['sales-30d', storeId, role],
    queryFn: () => fetchSales30Days(role, storeId),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 2 * 60 * 1000,
  });

  // 시간대별 평균 (30일 평균 · backend 가 평균 산출)
  const hourAvg = useQuery({
    queryKey: ['sales-hour-avg', storeId, role],
    queryFn: () => fetchSalesByHourAvg(role, 30, storeId),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 2 * 60 * 1000,
  });

  // 결제수단 분포 (30일)
  const payQ = useQuery({
    queryKey: ['sales-payment', storeId, role],
    queryFn: () => fetchSalesByPayment(role, 30, storeId),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 2 * 60 * 1000,
  });

  // ASP 트렌드 (객단가 30일)
  const aspQ = useQuery({
    queryKey: ['sales-asp', storeId, role],
    queryFn: () => fetchSalesAsp(role, 30, storeId),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 2 * 60 * 1000,
  });

  // 요일별 매출 패턴
  const weekdayQ = useQuery({
    queryKey: ['sales-weekday', storeId, role],
    queryFn: () => fetchSalesByWeekday(role, 30, storeId),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 2 * 60 * 1000,
  });

  // 매출 시계열 (분/시간/일 토글 · 선택 매장)
  const [grain, setGrain] = useState<Granularity>('hour');
  const timeseriesQ = useQuery({
    queryKey: ['sales-timeseries', storeId, grain, role],
    queryFn: () => fetchSalesTimeseries(role, grain, storeId),
    refetchInterval: grain === 'minute' ? 30000 : 5 * 60 * 1000,
    staleTime: grain === 'minute' ? 15000 : 2 * 60 * 1000,
    retry: 0,
  });

  const items = q.data?.items ?? [];
  const totalRev = items.reduce((s, x) => s + x.revenue, 0);
  const onlineCount = items.filter((x) => x.channel.startsWith('ONLINE')).length;
  const storeOptions = locItems.filter((l) => l.location_type !== 'WH' && l.active !== false);

  // 30일 일별 매출 — 실 데이터 (date YYYY-MM-DD → M/D 라벨)
  const daily30 = (sales30.data?.items ?? []).map((it) => {
    const [, mm, dd] = it.date.split('-');
    return { date: `${parseInt(mm)}/${parseInt(dd)}`, revenue: it.revenue };
  });

  // 7일 vs 30일 매출 비교 (이중 line) — 30일 일별 + 마지막 7일만 별도 series
  const dual7v30 = daily30.map((d, idx, arr) => ({
    date: d.date,
    revenue30: d.revenue,
    revenue7: idx >= arr.length - 7 ? d.revenue : null,
  }));

  // 카테고리 매출
  const catItems = ((byCat.data?.items ?? []) as { category: string; revenue: number }[])
    .map((it) => ({ name: it.category ?? '기타', value: it.revenue ?? 0 }));

  // 시간대별 평균 (24h · 누락 0 채움)
  const hourlyAvg = Array.from({ length: 24 }, (_, h) => {
    const found = hourAvg.data?.items.find((it) => it.hour === h);
    return { hour: `${h}시`, avgRevenue: found ? Math.round(found.avg_revenue ?? 0) : 0 };
  });

  // 결제수단 pie
  const paymentItems = (payQ.data?.items ?? []).map((it) => ({
    name: it.payment ?? '기타', value: it.revenue ?? 0,
  }));

  // ASP 트렌드
  const aspSeries = (aspQ.data?.items ?? []).map((it) => {
    const [, mm, dd] = it.date.split('-');
    return { date: `${parseInt(mm)}/${parseInt(dd)}`, asp: Math.round(it.asp ?? 0) };
  });

  // 요일별 (월~일 순)
  const weekdayItems = (weekdayQ.data?.items ?? [])
    .slice()
    .sort((a, b) => a.dow - b.dow)
    .map((it) => ({ dow: it.dow_label, revenue: it.revenue }));

  // 베스트셀러 30일
  const bestList = ((best30.data?.items ?? []) as { isbn13: string; title?: string | null; qty: number }[])
    .slice(0, 20)
    .map((it) => ({ label: (it.title ?? it.isbn13).slice(0, 24), qty: it.qty }));

  // 매출 시계열 (granularity 토글 반영)
  const timeseries = (timeseriesQ.data?.items ?? []).map((d) => ({
    t: formatBucket(d.bucket, grain),
    revenue: d.revenue,
    qty: d.qty,
  }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="h1">{nameOf(storeId)} · 매출</h1>
          <p className="text-bf-muted text-xs mt-1">
            매장에서 POS 로 결제된 트랜잭션이 실시간 (5초) 으로 흐르는 화면입니다.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="label-tag">매장 선택</span>
          <select className="ipt" value={storeId} onChange={(e) => setStoreId(Number(e.target.value))}>
            {storeOptions.map((l) => (
              <option key={l.location_id} value={l.location_id}>
                {l.name ?? `매장 ${l.location_id}`}{l.location_type === 'STORE_ONLINE' ? ' (온라인)' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="metric-card">
          <div className="metric-label">최근 트랜잭션</div>
          <div className="metric-value">{items.length}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">합계 매출</div>
          <div className="metric-value">₩{(totalRev / 1000).toFixed(0)}K</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">온라인</div>
          <div className="metric-value">{onlineCount}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">오프라인</div>
          <div className="metric-value">{items.length - onlineCount}</div>
        </div>
      </div>

      {/* 차트 0행: 매출 추이 (분/시간/일 토글) */}
      <div className="card">
        <div className="flex items-center justify-between mb-2">
          <h2 className="h2 text-sm">📈 매출 추이 · 건수</h2>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-bf-muted">{grainCaption(grain)}</span>
            <GranularityToggle value={grain} onChange={setGrain} />
          </div>
        </div>
        <KpiLine
          data={timeseries}
          xKey="t"
          yKey={['revenue', 'qty']}
          yLabels={['매출(₩)', '건수']}
          dualAxis
          area
          height={240}
          isLoading={timeseriesQ.isLoading}
        />
      </div>

      {/* 차트 1행: 7일 vs 30일 비교 (이중 line) + 카테고리 매출 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="card lg:col-span-2">
          <div className="flex items-center justify-between mb-2">
            <h2 className="h2 text-sm">📊 7일 vs 30일 매출 비교</h2>
            <span className="text-[10px] text-bf-muted">최근 7일 트렌드를 30일 base 와 함께 표시</span>
          </div>
          <KpiLine
            data={dual7v30}
            xKey="date"
            yKey={['revenue30', 'revenue7']}
            yLabels={['30일 (전체)', '7일 (최근)']}
            height={240}
            isLoading={sales30.isLoading}
          />
        </div>
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h2 className="h2 text-sm">📊 카테고리 매출 (30일)</h2>
          </div>
          <KpiPie
            data={catItems}
            nameKey="name"
            valueKey="value"
            donut
            height={240}
            isLoading={byCat.isLoading}
          />
        </div>
      </div>

      {/* 차트 2행: 결제수단 분포 + ASP 트렌드 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h2 className="h2 text-sm">📈 결제수단 분포 (30일)</h2>
          </div>
          <KpiPie
            data={paymentItems}
            nameKey="name"
            valueKey="value"
            donut
            height={240}
            isLoading={payQ.isLoading}
          />
        </div>
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h2 className="h2 text-sm">📈 ASP 트렌드 (객단가 30일)</h2>
          </div>
          <KpiLine
            data={aspSeries}
            xKey="date"
            yKey="asp"
            yLabels={['객단가 (원)']}
            area
            height={240}
            isLoading={aspQ.isLoading}
          />
        </div>
      </div>

      {/* 차트 3행: 요일별 + 시간대 평균 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h2 className="h2 text-sm">📊 요일별 매출 패턴 (30일)</h2>
          </div>
          <KpiBar
            data={weekdayItems}
            xKey="dow"
            yKey="revenue"
            yLabels={['매출']}
            height={240}
            isLoading={weekdayQ.isLoading}
          />
        </div>
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h2 className="h2 text-sm">📊 시간대별 매출 (30일 평균)</h2>
          </div>
          <KpiBar
            data={hourlyAvg}
            xKey="hour"
            yKey="avgRevenue"
            yLabels={['평균 매출']}
            height={240}
            isLoading={hourAvg.isLoading}
          />
        </div>
      </div>

      {/* 차트 4행: 베스트셀러 */}
      <div className="grid grid-cols-1 gap-3">
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h2 className="h2 text-sm">🏆 30일 베스트셀러 top 20</h2>
          </div>
          <KpiBar
            data={bestList}
            xKey="label"
            yKey="qty"
            horizontal
            yLabels={['판매 수량']}
            height={360}
            isLoading={best30.isLoading}
          />
        </div>
      </div>

      <div className="card">
        <table className="data-table">
          <thead>
            <tr>
              <th>시간</th>
              <th>ISBN</th>
              <th>제목</th>
              <th>저자</th>
              <th>채널</th>
              <th className="text-right">수량</th>
              <th className="text-right">단가</th>
              <th className="text-right">매출</th>
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.txn_id}>
                <td className="text-bf-muted">{new Date(s.event_ts).toLocaleTimeString()}</td>
                <td className="font-mono text-[11px]">{s.isbn13}</td>
                <td className="font-medium">{s.title ?? '-'}</td>
                <td>{s.author ?? '-'}</td>
                <td><span className={s.channel === 'OFFLINE' ? 'pill-info' : 'pill-up'}>{s.channel}</span></td>
                <td className="text-right">{s.qty}</td>
                <td className="text-right">₩{s.unit_price.toLocaleString()}</td>
                <td className="text-right font-semibold">₩{s.revenue.toLocaleString()}</td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={8}>
                <EmptyState message="최근 트랜잭션 없음" hint="POS 판매가 발생하면 5초 내에 여기에 표시됩니다 (pos-ingestor Lambda)" />
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
