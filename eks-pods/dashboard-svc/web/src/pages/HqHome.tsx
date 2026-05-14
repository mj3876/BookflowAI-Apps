import { useQuery } from '@tanstack/react-query';
import { Link, useOutletContext } from 'react-router-dom';
import {
  fetchPending, fetchPendingGrouped, fetchSpikeEvents, fetchReturns, fetchNewBookRequests,
  fetchInsufficientStock, type Role,
} from '../api';

/**
 * HQ Home — 본사 진입 첫 화면.
 *
 * 차트 0 · "오늘 무엇을 처리해야 하는지" 액션 list 중심.
 *  - 4 metric card (오늘 batch / 검토 필요 / spike / 반품)
 *  - 검토 필요 / spike / 반품 / 신간 top 5 list (각각 행동 페이지로 link)
 *  - 상세 차트는 KPI / 의사결정 페이지로 CTA
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
  // insufficient: forecast 기반 (시간당 갱신 OK)
  const insufficient = useQuery({
    queryKey: ['hq-insufficient', role],
    queryFn: () => fetchInsufficientStock(role, 20),
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

  const returnsItems = (returns.data?.items ?? []);
  const returnsPending = returnsItems.filter((r) => r.status === 'PENDING').length;
  const requestsItems = (requests.data?.items ?? []);
  const requestsPending = requestsItems.filter((r) => r.status === 'NEW' || r.status === 'FETCHED').length;

  // 검토 필요 도서 top 20 (URGENT/CRITICAL 우선 → gap 큰 순)
  const urgencyRank = (u: string) => (u === 'CRITICAL' ? 0 : u === 'URGENT' ? 1 : u === 'NEWBOOK' ? 2 : 3);
  const pendingTop = [...items]
    .filter((o) => o.status === 'PENDING')
    .sort((a, b) => urgencyRank(a.urgency_level) - urgencyRank(b.urgency_level))
    .slice(0, 20);

  // spike 도서 top 5 (z_score desc)
  const spikeTop5 = [...(spikes.data?.items ?? [])]
    .sort((a, b) => (b.z_score ?? 0) - (a.z_score ?? 0))
    .slice(0, 5);

  // 반품 신청 top 5 (PENDING · 최근 신청 순)
  const returnsTop5 = returnsItems
    .filter((r) => r.status === 'PENDING')
    .slice(0, 5);

  // 신간 신청 top 5 (NEW / FETCHED)
  const requestsTop5 = requestsItems
    .filter((r) => r.status === 'NEW' || r.status === 'FETCHED')
    .slice(0, 5);

  // 검토 필요 (예측 부족 forecast) top 20
  const insufficientTop = (insufficient.data?.items ?? []).slice(0, 20);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="h1">본사 · {today}</h1>
        <p className="text-bf-muted text-xs mt-1">
          오늘 처리할 액션을 한 화면으로. 차트는 상단 KPI · 의사결정 페이지에서 확인하세요.
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

      {/* 1행: PENDING 카운트 4종 — 색상 강화 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Link to="/decision" className="metric-card hover:border-bf-primary transition border-bf-warn">
          <div className="metric-label">📋 의사결정 처리</div>
          <div className="metric-value text-bf-warn">{totalPending}건</div>
          <div className="text-[11px] text-bf-muted mt-1">
            1단계 {stage1} · 2단계 {stage2} · 3단계 {stage3}
            {urgentPending > 0 && <span className="text-bf-danger ml-1">· 긴급 {urgentPending}</span>}
          </div>
        </Link>
        <Link to="/spikes" className="metric-card hover:border-bf-primary transition border-bf-danger">
          <div className="metric-label">🔥 SNS 급등</div>
          <div className="metric-value text-bf-danger">{spikes.data?.items.length ?? 0}건</div>
          <div className="text-[11px] text-bf-muted mt-1">
            매우높음 {spikeCritical} · 높음 {spikeWarning}
          </div>
        </Link>
        <Link to="/returns" className="metric-card hover:border-bf-primary transition border-bf-primary">
          <div className="metric-label">📦 반품 처리</div>
          <div className="metric-value text-bf-primary">{returnsPending}건</div>
          <div className="text-[11px] text-bf-muted mt-1">매장 → 본사 신청</div>
        </Link>
        <Link to="/requests" className="metric-card hover:border-bf-primary transition border-bf-success">
          <div className="metric-label">📚 신간 편입</div>
          <div className="metric-value text-bf-success">{requestsPending}건</div>
          <div className="text-[11px] text-bf-muted mt-1">출판사 신간 신청</div>
        </Link>
      </div>

      {/* 2행: 검토 필요 PENDING top 20 (urgency 우선) */}
      <div className="card">
        <div className="flex items-center justify-between mb-2">
          <h2 className="h2 text-sm">⚠️ 검토 필요 PENDING top 20</h2>
          <Link to="/decision" className="text-[11px] text-bf-primary hover:underline">전체 처리 →</Link>
        </div>
        {pendingTop.length === 0 ? (
          <div className="text-xs text-bf-muted py-6 text-center">PENDING 의사결정 없음 · 정상 운영</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-bf-muted">
                <tr>
                  <th className="text-left py-1">긴급도</th>
                  <th className="text-left py-1">단계</th>
                  <th className="text-left py-1">제목</th>
                  <th className="text-right py-1">수량</th>
                  <th className="text-left py-1 pl-2">생성</th>
                </tr>
              </thead>
              <tbody>
                {pendingTop.map((o) => {
                  const stageLabel = o.order_type === 'REBALANCE' ? '재분배' : o.order_type === 'WH_TRANSFER' ? '권역간' : '발주';
                  const uColor = o.urgency_level === 'CRITICAL' ? 'text-bf-danger' : o.urgency_level === 'URGENT' ? 'text-bf-warn' : 'text-bf-muted';
                  return (
                    <tr key={o.order_id} className="border-t border-bf-border2 hover:bg-bf-panel2">
                      <td className={`py-1.5 font-bold ${uColor}`}>{o.urgency_level}</td>
                      <td className="py-1.5">{stageLabel}</td>
                      <td className="py-1.5 font-medium truncate max-w-[260px]">{o.title ?? o.isbn13}</td>
                      <td className="py-1.5 text-right">{o.qty}</td>
                      <td className="py-1.5 pl-2 text-bf-muted">{o.created_at?.slice(5, 16) ?? '-'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 3행: spike top 5 + 반품 top 5 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h2 className="h2 text-sm">🔥 SNS 급등 도서 top 5</h2>
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
                  <tr key={s.event_id} className="border-t border-bf-border2 hover:bg-bf-panel2">
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

        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h2 className="h2 text-sm">📦 반품 신청 top 5</h2>
            <Link to="/returns" className="text-[11px] text-bf-primary hover:underline">전체 처리 →</Link>
          </div>
          {returnsTop5.length === 0 ? (
            <div className="text-xs text-bf-muted py-6 text-center">반품 신청 없음</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-bf-muted">
                <tr>
                  <th className="text-left py-1">제목</th>
                  <th className="text-left py-1">매장</th>
                  <th className="text-right py-1">수량</th>
                  <th className="text-left py-1 pl-2">사유</th>
                </tr>
              </thead>
              <tbody>
                {returnsTop5.map((r) => (
                  <tr key={`${r.isbn13}-${r.requested_at}`} className="border-t border-bf-border2 hover:bg-bf-panel2">
                    <td className="py-1.5 font-medium truncate max-w-[180px]">{r.title ?? r.isbn13}</td>
                    <td className="py-1.5 text-bf-muted">매장 {r.location_id}</td>
                    <td className="py-1.5 text-right">{r.qty}</td>
                    <td className="py-1.5 pl-2 text-bf-muted truncate max-w-[120px]">{r.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* 4행: 신간 신청 top 5 + 예측 부족 top 5 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h2 className="h2 text-sm">📚 신간 편입 신청 top 5</h2>
            <Link to="/requests" className="text-[11px] text-bf-primary hover:underline">전체 검토 →</Link>
          </div>
          {requestsTop5.length === 0 ? (
            <div className="text-xs text-bf-muted py-6 text-center">신간 신청 없음</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-bf-muted">
                <tr>
                  <th className="text-left py-1">제목</th>
                  <th className="text-left py-1">출판사</th>
                  <th className="text-left py-1">상태</th>
                  <th className="text-left py-1 pl-2">신청일</th>
                </tr>
              </thead>
              <tbody>
                {requestsTop5.map((r) => (
                  <tr key={r.id} className="border-t border-bf-border2 hover:bg-bf-panel2">
                    <td className="py-1.5 font-medium truncate max-w-[200px]">{r.title ?? r.isbn13}</td>
                    <td className="py-1.5 text-bf-muted">P-{r.publisher_id}</td>
                    <td className="py-1.5 text-bf-warn">{r.status}</td>
                    <td className="py-1.5 pl-2 text-bf-muted">{r.requested_at?.slice(5, 10) ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h2 className="h2 text-sm">📉 예측 부족 도서 top 5</h2>
            <Link to="/decision" className="text-[11px] text-bf-primary hover:underline">의사결정 →</Link>
          </div>
          {insufficientTop.length === 0 ? (
            <div className="text-xs text-bf-muted py-6 text-center">예측 부족 도서 없음</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-bf-muted">
                <tr>
                  <th className="text-left py-1">제목</th>
                  <th className="text-right py-1">예측수요</th>
                  <th className="text-right py-1">가용</th>
                  <th className="text-right py-1">부족</th>
                </tr>
              </thead>
              <tbody>
                {insufficientTop.slice(0, 5).map((it) => (
                  <tr key={`${it.isbn13}-${it.store_id}`} className="border-t border-bf-border2 hover:bg-bf-panel2">
                    <td className="py-1.5 font-medium truncate max-w-[200px]">{it.title ?? it.isbn13}</td>
                    <td className="py-1.5 text-right">{it.predicted_demand}</td>
                    <td className="py-1.5 text-right">{it.available}</td>
                    <td className="py-1.5 text-right text-bf-danger font-bold">{it.gap}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* 5행: 큰 CTA — 차트 페이지로 유도 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Link to="/kpi" className="card hover:border-bf-primary transition flex items-center justify-between py-6">
          <div>
            <div className="text-xs text-bf-muted mb-1">📈 매출 차트 · 카테고리별 분석</div>
            <div className="text-xl font-bold text-bf-text">전사 KPI 차트 보기</div>
            <div className="text-[11px] text-bf-muted mt-1">7일 매출 · 카테고리 분포 · 베스트셀러</div>
          </div>
          <div className="text-3xl text-bf-primary">→</div>
        </Link>
        <Link to="/decision" className="card hover:border-bf-primary transition flex items-center justify-between py-6">
          <div>
            <div className="text-xs text-bf-muted mb-1">📊 의사결정 단계 분포 · cascade</div>
            <div className="text-xl font-bold text-bf-text">의사결정 현황 보기</div>
            <div className="text-[11px] text-bf-muted mt-1">PENDING 처리 · 강제 승인 · 거절</div>
          </div>
          <div className="text-3xl text-bf-primary">→</div>
        </Link>
      </div>

      {/* 6행: 추천 액션 hint */}
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
