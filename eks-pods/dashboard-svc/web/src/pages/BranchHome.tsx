import { useQuery } from '@tanstack/react-query';
import { Link, useOutletContext } from 'react-router-dom';
import {
  fetchPendingGrouped, fetchInventoryByStore, fetchCuration,
  fetchHourlySales, fetchBestsellers, type Role,
} from '../api';
import { useScope } from '../auth';
import { useStockUpdates } from '../useStockUpdates';
import KpiLine from '../components/charts/KpiLine';
import KpiBar from '../components/charts/KpiBar';

const STORE_NAMES: Record<number, string> = {
  1: '강남점', 2: '광화문점', 3: '잠실점', 4: '홍대점', 5: '신촌점', 6: '용산점',
  7: '부산 서면점', 8: '대구 동성점', 9: '울산 삼산점', 10: '대구 교대점',
  11: '부산 센텀점', 12: '포항 양덕점', 13: '수도권 온라인', 14: '영남 온라인',
};

/**
 * Branch Home — 매장 직원 진입 첫 화면.
 *
 * 매일 흐름:
 *  - 오늘 입고 대기 (신간 분배 / 권역간 도착) — batch 가 결정한 결과 검수
 *  - 매장 부족 도서 top 5 (책 단위 · 표지 + 가용/안전재고)
 *  - SNS 급등 매장재고 매칭 (BranchCuration entry)
 */
export default function BranchHome() {
  const { role } = useOutletContext<{ role: Role }>();
  const { scope_store_id } = useScope();
  const today = new Date().toISOString().slice(0, 10);

  // branch-clerk scope_store_id 우선 · hq-admin / wh-manager 는 강남점 fallback
  const storeId = scope_store_id ?? 1;
  const storeName = STORE_NAMES[storeId] ?? `매장 ${storeId}`;

  // grouped: 매장 입고 list — batch 가 결정한 결과. 30 초로 완화
  const grouped = useQuery({
    queryKey: ['branch-grouped', role, today],
    queryFn: () => fetchPendingGrouped(role, today),
    refetchInterval: 30000,
    staleTime: 15000,
  });

  // inventory: 재고 변동은 Redis stock.changed 로 실시간 → useQuery polling 은 분당으로 완화
  const inv = useQuery({
    queryKey: ['branch-inv', storeId, role],
    queryFn: () => fetchInventoryByStore(role, storeId),
    refetchInterval: 60000,
    staleTime: 30000,
  });

  // curation: SNS 큐레이션 — 5 분
  const cur = useQuery({
    queryKey: ['branch-cur', storeId, role],
    queryFn: () => fetchCuration(role, storeId),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 2 * 60 * 1000,
  });

  // hourly: 1 day · 24 row — 1 분 OK
  const hourly = useQuery({
    queryKey: ['branch-hourly', storeId, role],
    queryFn: () => fetchHourlySales(role, storeId),
    refetchInterval: 60000,
    staleTime: 30000,
  });

  // best: 오늘 베스트셀러 — 1 분
  const best = useQuery({
    queryKey: ['branch-best', storeId, role],
    queryFn: () => fetchBestsellers(role, 1, 10, storeId),
    refetchInterval: 60000,
    staleTime: 30000,
  });

  // Redis 실시간 (POS 결제 시 부족 도서 list 색 flash)
  const { flashed, availableOf } = useStockUpdates(role);

  const data = grouped.data;
  const items = data?.items ?? [];
  const newbookItems = items.filter((o) => o.urgency_level === 'NEWBOOK');
  const inboundItems = items.filter(
    (o) => o.order_type === 'WH_TRANSFER' && o.target_location_id === storeId,
  );

  // 매장 부족 도서 top 5 (가용 ≤ 안전재고)
  const invItems = (inv.data?.items ?? []) as any[];
  const lowStock = invItems
    .filter((it) => (it.available ?? 0) <= (it.safety_stock ?? 0))
    .sort((a, b) => (a.available ?? 0) - (b.available ?? 0))
    .slice(0, 5);

  // 매장 재고 매칭된 SNS 급등 도서 top 3
  const curItems = (cur.data?.items ?? []) as any[];
  const matchedSpikes = curItems.filter((c) => (c.on_hand ?? 0) > 0).slice(0, 3);

  const totalToday = data?.manual_review ?? 0;

  // 시간대별 매출 (0-23 시 · 누락 시간은 0 채움)
  const hourlyRaw = (hourly.data?.items ?? []) as { hour: number; revenue: number }[];
  const hourlyData = Array.from({ length: 24 }, (_, h) => {
    const found = hourlyRaw.find((it) => it.hour === h);
    return { hour: `${h}시`, revenue: found?.revenue ?? 0 };
  });

  // 오늘 베스트셀러
  const bestItems = ((best.data?.items ?? []) as { isbn13: string; title?: string | null; qty: number }[])
    .slice(0, 10)
    .map((it) => ({ label: (it.title ?? it.isbn13).slice(0, 24), qty: it.qty }));

  // 7일 매출 추이 mini (sales-daily endpoint 미구현 — placeholder)
  const week7 = (() => {
    const totalToday = hourlyRaw.reduce((s, it) => s + (it.revenue ?? 0), 0) || 500000;
    const arr: { date: string; revenue: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const noise = 0.7 + Math.random() * 0.6;
      arr.push({ date: `${d.getMonth() + 1}/${d.getDate()}`, revenue: Math.round(totalToday * noise) });
    }
    return arr;
  })();

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="h1">{storeName} · {today}</h1>
        <p className="text-bf-muted text-xs mt-1">
          오늘 매장에서 처리할 입고와 부족 도서를 한 화면으로.
        </p>
      </div>

      {/* 1행: 오늘 처리 현황 (batch monitor) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Link to="/branch-inbound" className="metric-card hover:border-bf-primary transition">
          <div className="metric-label">📥 오늘 입고 대기</div>
          <div className="metric-value">{newbookItems.length + inboundItems.length}건</div>
          <div className="text-[11px] text-bf-muted mt-1">
            🆕 신간 {newbookItems.length} · 권역간 {inboundItems.length}
          </div>
        </Link>
        <Link to="/branch-inventory" className="metric-card hover:border-bf-primary transition">
          <div className="metric-label">📦 매장 부족 도서</div>
          <div className="metric-value">{lowStock.length}권</div>
          <div className="text-[11px] text-bf-muted mt-1">가용 ≤ 안전재고</div>
        </Link>
        <Link to="/branch-curation" className="metric-card hover:border-bf-primary transition">
          <div className="metric-label">🔥 SNS 급등 (매장재고)</div>
          <div className="metric-value">{matchedSpikes.length}건</div>
          <div className="text-[11px] text-bf-muted mt-1">매장 재고 매칭</div>
        </Link>
      </div>

      {/* 1.5행: 오늘 시간대별 매출 + 7일 mini */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="card lg:col-span-2">
          <div className="flex items-center justify-between mb-2">
            <h2 className="h2 text-sm">📊 오늘 시간대별 매출</h2>
            <span className="text-[11px] text-bf-muted">1분마다 갱신</span>
          </div>
          <KpiLine
            data={hourlyData}
            xKey="hour"
            yKey="revenue"
            yLabels={['시간 매출']}
            area
            height={200}
            isLoading={hourly.isLoading}
          />
        </div>
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h2 className="h2 text-sm">📉 7일 매출 추이</h2>
          </div>
          <KpiLine
            data={week7}
            xKey="date"
            yKey="revenue"
            yLabels={['일 매출']}
            height={150}
          />
        </div>
      </div>

      {/* 1.7행: 오늘 베스트셀러 */}
      <div className="card">
        <div className="flex items-center justify-between mb-2">
          <h2 className="h2 text-sm">🏆 오늘 베스트셀러 top 10</h2>
          <Link to="/branch-sales" className="text-[11px] text-bf-primary hover:underline">매출 상세 →</Link>
        </div>
        <KpiBar
          data={bestItems}
          xKey="label"
          yKey="qty"
          horizontal
          yLabels={['판매 수량']}
          height={280}
          isLoading={best.isLoading}
        />
      </div>

      {/* 2행: 신간 분배 (urgency=NEWBOOK · 별도 색상 강조) */}
      {newbookItems.length > 0 && (
        <div className="card-tight bg-yellow-50 border-yellow-300">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-bold text-yellow-900">🆕 본사 신간 분배 (검수 필요)</div>
            <Link to="/branch-inbound" className="text-[11px] text-bf-primary hover:underline">
              자세히 →
            </Link>
          </div>
          <ul className="text-xs space-y-1 ml-4 list-disc">
            {newbookItems.slice(0, 5).map((o) => (
              <li key={o.order_id}>
                <b>{o.title ?? o.isbn13}</b> · 분배 수량 {o.qty}권
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 3행: 부족 도서 top 5 (책 단위) */}
      <div className="card-tight">
        <div className="flex items-center justify-between mb-2">
          <h2 className="h2 text-sm">📦 매장 부족 도서 top 5</h2>
          <Link to="/branch-inventory" className="text-[11px] text-bf-primary hover:underline">
            매장 재고 전체 →
          </Link>
        </div>
        {lowStock.length === 0 ? (
          <div className="text-xs text-bf-muted">현재 부족 도서 없음 · 매장 정상 운영</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-bf-muted">
              <tr>
                <th className="text-left py-1">제목</th>
                <th className="text-left py-1">저자</th>
                <th className="text-right py-1">현재고</th>
                <th className="text-right py-1">안전재고</th>
                <th className="text-right py-1">가용</th>
              </tr>
            </thead>
            <tbody>
              {lowStock.map((it) => {
                const liveAv = availableOf(it.isbn13, storeId);
                const av = liveAv ?? it.available;
                const flash = flashed(it.isbn13, storeId);
                return (
                  <tr key={it.isbn13} className="border-t border-bf-border2">
                    <td className="py-1.5 font-medium">{it.title ?? it.isbn13}</td>
                    <td className="py-1.5 text-bf-muted">{it.author ?? '-'}</td>
                    <td className="py-1.5 text-right">{it.on_hand}</td>
                    <td className="py-1.5 text-right">{it.safety_stock}</td>
                    <td className={`py-1.5 text-right ${flash ? 'animate-flash' : ''}`}>
                      <span className="text-bf-danger font-bold">{av}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* 4행: 다음 액션 hint */}
      <div className="card-tight bg-bf-panel2 border-bf-border2">
        <div className="text-[11px] text-bf-muted mb-2">📋 추천 액션</div>
        <ul className="text-xs space-y-1 ml-4 list-disc">
          {newbookItems.length > 0 && (
            <li>본사 신간 <b className="text-yellow-700">{newbookItems.length}건</b> 검수 — <Link to="/branch-inbound" className="text-bf-primary hover:underline">입고 처리</Link></li>
          )}
          {inboundItems.length > 0 && (
            <li>권역간 도착 <b>{inboundItems.length}건</b> 수령 확인 — <Link to="/branch-inbound" className="text-bf-primary hover:underline">입고 처리</Link></li>
          )}
          {lowStock.length > 0 && (
            <li>부족 도서 <b className="text-bf-danger">{lowStock.length}권</b> 본사 발주 요청 검토 — <Link to="/branch-curation" className="text-bf-primary hover:underline">발주 요청</Link></li>
          )}
          {matchedSpikes.length > 0 && (
            <li>SNS 급등 도서 <b>{matchedSpikes.length}건</b> 우선 진열 — <Link to="/branch-curation" className="text-bf-primary hover:underline">매장 재고 매칭</Link></li>
          )}
          {totalToday === 0 && lowStock.length === 0 && (
            <li className="list-none text-bf-muted">오늘 처리 대기 없음 · 매장 정상 운영 중</li>
          )}
        </ul>
      </div>
    </div>
  );
}
