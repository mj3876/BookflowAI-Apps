import { useQuery } from '@tanstack/react-query';
import { Link, useOutletContext } from 'react-router-dom';
import {
  fetchPending, fetchPendingGrouped, fetchSpikeEvents, fetchReturns, fetchNewBookRequests,
  fetchSalesSummary, fetchInsufficientStock, type Role,
} from '../api';
import KpiLine from '../components/charts/KpiLine';
import KpiBar from '../components/charts/KpiBar';
import KpiPie from '../components/charts/KpiPie';

/**
 * HQ Home — 본사 진입 첫 화면.
 *
 * 메인: "오늘 무엇이 있고 어디로 가야 하는지" 즉시 보임.
 *  - 4 PENDING 카운트 (의사결정 / 외부발주 승인 / 반품 / 신간)
 *  - 24h 매출 요약
 *  - SNS 급등 카운트
 *  - 다음 액션 링크 (각 카운트 클릭 시 해당 페이지로)
 */
export default function HqHome() {
  const { role } = useOutletContext<{ role: Role }>();
  const today = new Date().toISOString().slice(0, 10);

  // D2 batch monitor (오늘 자동 승인 / 검토 필요 / 18:00 거절 예정)
  const grouped = useQuery({
    queryKey: ['hq-grouped', role, today],
    queryFn: () => fetchPendingGrouped(role, today),
    refetchInterval: 60000,
    staleTime: 30000,
  });

  // pending: PENDING orders 가 hq-admin 페이지에서 처리되므로 30 초 (이전 10 초는 과함)
  const pending = useQuery({
    queryKey: ['hq-pending', role],
    queryFn: () => fetchPending(role, { limit: 100 }),
    refetchInterval: 30000,
    staleTime: 15000,
  });
  // spike: 10 분 batch detect — 30 초도 빠름 · 3 분
  const spikes = useQuery({
    queryKey: ['hq-spikes', role],
    queryFn: () => fetchSpikeEvents(role, 30),
    refetchInterval: 3 * 60 * 1000,
    staleTime: 60000,
  });
  // returns: 매장 신청 → 본사 처리. 분당이면 충분
  const returns = useQuery({
    queryKey: ['hq-returns', role],
    queryFn: () => fetchReturns(role, 50),
    refetchInterval: 60000,
    staleTime: 30000,
  });
  // requests: 출판사 신간 (자주 안 변함) — 5 분
  const requests = useQuery({
    queryKey: ['hq-requests', role],
    queryFn: () => fetchNewBookRequests(role),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 2 * 60 * 1000,
  });
  // sales: 매출 1h summary — 30 초 (이전 10 초)
  const sales = useQuery({
    queryKey: ['hq-sales', role],
    queryFn: () => fetchSalesSummary(role),
    refetchInterval: 30000,
    staleTime: 15000,
  });
  // insufficient: forecast 기반 (시간당 갱신 OK)
  const insufficient = useQuery({
    queryKey: ['hq-insufficient', role],
    queryFn: () => fetchInsufficientStock(role, 10),
    refetchInterval: 30 * 60 * 1000,
    staleTime: 10 * 60 * 1000,
  });

  const items = pending.data?.items ?? [];
  const stage1 = items.filter((o) => o.order_type === 'REBALANCE').length;
  const stage2 = items.filter((o) => o.order_type === 'WH_TRANSFER').length;
  const stage3 = items.filter((o) => o.order_type === 'PUBLISHER_ORDER').length;
  const totalPending = items.filter((o) => o.status === 'PENDING').length;
  const urgentPending = items.filter((o) => (o.urgency_level === 'URGENT' || o.urgency_level === 'CRITICAL') && o.status === 'PENDING').length;

  const spikeCritical = (spikes.data?.items ?? []).filter((s) => (s.z_score ?? 0) >= 3).length;
  const spikeWarning = (spikes.data?.items ?? []).filter((s) => (s.z_score ?? 0) >= 1.5 && (s.z_score ?? 0) < 3).length;

  const returnsPending = (returns.data?.items ?? []).filter((r) => r.status === 'PENDING').length;
  const requestsPending = (requests.data?.items ?? []).filter((r) => r.status === 'NEW' || r.status === 'FETCHED').length;

  const todaysRevenue = sales.data?.total_revenue ?? 0;
  const totalTransactions = sales.data?.transactions ?? 0;

  // 7일 매출 추이 mock (daily sales summary 미구현 — sales-summary 단일 시점 기반 가상 series)
  // TODO: backend /dashboard/sales-daily 엔드포인트 생기면 교체
  const today7 = (() => {
    const arr: { date: string; revenue: number }[] = [];
    const base = todaysRevenue || 1000000;
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const noise = 0.7 + Math.random() * 0.6;
      arr.push({ date: `${d.getMonth() + 1}/${d.getDate()}`, revenue: Math.round(base * noise) });
    }
    return arr;
  })();

  // cascade stage 분포 (PENDING 만)
  const cascadeDist = [
    { name: '재분배 (1단계)', value: stage1 },
    { name: '권역간 (2단계)', value: stage2 },
    { name: '외부발주 (3단계)', value: stage3 },
  ].filter((d) => d.value > 0);

  // 검토 필요 도서 top 10 (forecast-svc insufficient)
  const insufficientTop = (insufficient.data?.items ?? [])
    .slice(0, 10)
    .map((it) => ({
      label: (it.title ?? it.isbn13).slice(0, 24),
      gap: it.gap,
    }));

  // spike 도서 top 5 (z_score desc)
  const spikeTop5 = [...(spikes.data?.items ?? [])]
    .sort((a, b) => (b.z_score ?? 0) - (a.z_score ?? 0))
    .slice(0, 5);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="h1">본사 · {today}</h1>
        <p className="text-bf-muted text-xs mt-1">
          오늘 batch 처리 현황과 검토 필요 건수를 한 화면으로. 카드를 클릭하면 처리 페이지로 이동합니다.
        </p>
      </div>

      {/* 메인 카드: 오늘 batch monitor */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="metric-card bg-bf-panel2 border-bf-border2">
          <div className="metric-label">✅ 07:00 batch 자동 승인</div>
          <div className="metric-value text-bf-success">{grouped.data?.auto_executed_at_07 ?? 0}건</div>
          <div className="text-[11px] text-bf-muted mt-1">URGENT/CRITICAL 자동 처리 완료</div>
        </div>
        <Link to="/decision" className="metric-card hover:border-bf-primary transition border-bf-warn">
          <div className="metric-label">📋 검토 필요</div>
          <div className="metric-value text-bf-warn">{grouped.data?.manual_review ?? 0}건</div>
          <div className="text-[11px] text-bf-muted mt-1">
            클릭 → 처리하러 가기
            {grouped.data?.by_type && (
              <span className="ml-1">
                · 재분배 {grouped.data.by_type.REBALANCE ?? 0} · 권역간 {grouped.data.by_type.WH_TRANSFER ?? 0} · 발주 {grouped.data.by_type.PUBLISHER_ORDER ?? 0}
              </span>
            )}
          </div>
        </Link>
        <div className="metric-card bg-bf-panel2 border-bf-border2">
          <div className="metric-label">⏰ 18:00 batch 거절 예정</div>
          <div className="metric-value text-bf-muted">{grouped.data?.auto_reject_at_18_pending ?? 0}건</div>
          <div className="text-[11px] text-bf-muted mt-1">NORMAL · D-1 이전 미처리</div>
        </div>
      </div>

      {/* 1행: PENDING 카운트 4종 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Link to="/decision" className="metric-card hover:border-bf-primary transition">
          <div className="metric-label">의사결정 처리 대기</div>
          <div className="metric-value">{totalPending}건</div>
          <div className="text-[11px] text-bf-muted mt-1">
            1단계 {stage1} · 2단계 {stage2} · 3단계 {stage3}
            {urgentPending > 0 && <span className="text-bf-danger ml-1">· 긴급 {urgentPending}</span>}
          </div>
        </Link>
        <Link to="/approval" className="metric-card hover:border-bf-primary transition">
          <div className="metric-label">외부 발주 승인 대기</div>
          <div className="metric-value">{stage3}건</div>
          <div className="text-[11px] text-bf-muted mt-1">출판사 발주 — 비용 발생</div>
        </Link>
        <Link to="/returns" className="metric-card hover:border-bf-primary transition">
          <div className="metric-label">반품 처리 대기</div>
          <div className="metric-value">{returnsPending}건</div>
          <div className="text-[11px] text-bf-muted mt-1">매장 → 본사 신청</div>
        </Link>
        <Link to="/requests" className="metric-card hover:border-bf-primary transition">
          <div className="metric-label">신간 편입 결정</div>
          <div className="metric-value">{requestsPending}건</div>
          <div className="text-[11px] text-bf-muted mt-1">출판사 신간 신청</div>
        </Link>
      </div>

      {/* 2행: 매출 + SNS 급등 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Link to="/kpi" className="card hover:border-bf-primary transition">
          <div className="flex items-center justify-between mb-2">
            <h2 className="h2">오늘 매출</h2>
            <span className="text-[11px] text-bf-muted">30초마다 갱신</span>
          </div>
          <div className="text-3xl font-bold text-bf-text">
            ₩{todaysRevenue.toLocaleString()}
          </div>
          <div className="text-xs mt-1 text-bf-muted">
            거래 {totalTransactions.toLocaleString()}건
          </div>
        </Link>
        <Link to="/spikes" className="card hover:border-bf-primary transition">
          <div className="flex items-center justify-between mb-2">
            <h2 className="h2">SNS 급등 (24h)</h2>
            <span className="text-[11px] text-bf-muted">10분마다 분석</span>
          </div>
          <div className="flex gap-3 text-sm">
            <div>
              <div className="text-[11px] text-bf-muted">매우 높음</div>
              <div className="text-2xl font-bold text-bf-danger">{spikeCritical}건</div>
            </div>
            <div>
              <div className="text-[11px] text-bf-muted">높음</div>
              <div className="text-2xl font-bold text-bf-warn">{spikeWarning}건</div>
            </div>
            <div>
              <div className="text-[11px] text-bf-muted">전체</div>
              <div className="text-2xl font-bold text-bf-text">{spikes.data?.items.length ?? 0}건</div>
            </div>
          </div>
        </Link>
      </div>

      {/* 3행: 7일 매출 추이 + cascade stage 분포 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="card lg:col-span-2">
          <div className="flex items-center justify-between mb-2">
            <h2 className="h2 text-sm">📊 7일 매출 추이</h2>
            <Link to="/kpi" className="text-[11px] text-bf-primary hover:underline">📈 상세 KPI 보기 →</Link>
          </div>
          <KpiLine
            data={today7}
            xKey="date"
            yKey="revenue"
            yLabels={['일 매출']}
            area
            height={220}
            isLoading={sales.isLoading}
          />
        </div>
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h2 className="h2 text-sm">📊 의사결정 단계 분포</h2>
            <Link to="/decision" className="text-[11px] text-bf-primary hover:underline">처리 →</Link>
          </div>
          <KpiPie
            data={cascadeDist}
            nameKey="name"
            valueKey="value"
            donut
            height={220}
            isLoading={pending.isLoading}
          />
        </div>
      </div>

      {/* 4행: 검토 필요 도서 top 10 + spike top 5 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h2 className="h2 text-sm">📊 검토 필요 도서 top 10 (예측 부족분)</h2>
            <Link to="/decision" className="text-[11px] text-bf-primary hover:underline">처리 →</Link>
          </div>
          <KpiBar
            data={insufficientTop}
            xKey="label"
            yKey="gap"
            horizontal
            yLabels={['부족 수량']}
            height={280}
            isLoading={insufficient.isLoading}
          />
        </div>
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h2 className="h2 text-sm">🔥 SNS 급등 top 5</h2>
            <Link to="/spikes" className="text-[11px] text-bf-primary hover:underline">결정 발의 →</Link>
          </div>
          {spikeTop5.length === 0 ? (
            <div className="text-xs text-bf-muted py-6 text-center">급등 도서 없음</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-bf-muted">
                <tr>
                  <th className="text-left py-1">제목</th>
                  <th className="text-left py-1">분야</th>
                  <th className="text-right py-1">z-score</th>
                  <th className="text-right py-1">언급</th>
                </tr>
              </thead>
              <tbody>
                {spikeTop5.map((s) => (
                  <tr key={s.event_id} className="border-t border-bf-border2">
                    <td className="py-1.5 font-medium truncate max-w-[200px]">{s.title ?? s.isbn13}</td>
                    <td className="py-1.5 text-bf-muted">{s.category ?? '-'}</td>
                    <td className={`py-1.5 text-right font-bold ${(s.z_score ?? 0) >= 3 ? 'text-bf-danger' : 'text-bf-warn'}`}>
                      {(s.z_score ?? 0).toFixed(2)}
                    </td>
                    <td className="py-1.5 text-right">{s.mentions_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* 5행: 다음 액션 hint */}
      <div className="card-tight bg-bf-panel2 border-bf-border2">
        <div className="text-[11px] text-bf-muted mb-2">📋 추천 액션</div>
        <ul className="text-xs space-y-1 ml-4 list-disc">
          {urgentPending > 0 && (
            <li>긴급 처리 대기 <b className="text-bf-danger">{urgentPending}건</b> — <Link to="/decision" className="text-bf-primary hover:underline">의사결정 현황</Link>에서 강제 승인 검토</li>
          )}
          {stage3 > 0 && <li>외부 발주 <b>{stage3}건</b> 비용 발생 — <Link to="/approval" className="text-bf-primary hover:underline">승인</Link></li>}
          {returnsPending > 0 && <li>매장 반품 신청 <b>{returnsPending}건</b> 처리 필요 — <Link to="/returns" className="text-bf-primary hover:underline">반품 처리</Link></li>}
          {requestsPending > 0 && <li>출판사 신간 <b>{requestsPending}건</b> 편입 결정 — <Link to="/requests" className="text-bf-primary hover:underline">신간 편입</Link></li>}
          {spikeCritical > 0 && <li>화제 도서 <b className="text-bf-danger">{spikeCritical}건</b> 매우 높음 — <Link to="/spikes" className="text-bf-primary hover:underline">결정 발의</Link></li>}
          {totalPending === 0 && returnsPending === 0 && requestsPending === 0 && spikeCritical === 0 && (
            <li className="list-none text-bf-muted">현재 처리할 긴급 항목 없음</li>
          )}
        </ul>
      </div>
    </div>
  );
}
