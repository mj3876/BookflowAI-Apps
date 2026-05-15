import { useQuery } from '@tanstack/react-query';
import { Link, useOutletContext } from 'react-router-dom';
import {
  fetchPendingGrouped, fetchInventoryByStore, fetchCuration,
  fetchHourlySales, type Role,
} from '../api';
import { useScope } from '../auth';
import { useStockUpdates } from '../useStockUpdates';

const STORE_NAMES: Record<number, string> = {
  1: '강남점', 2: '광화문점', 3: '잠실점', 4: '홍대점', 5: '신촌점', 6: '용산점',
  7: '부산 서면점', 8: '대구 동성점', 9: '울산 삼산점', 10: '대구 교대점',
  11: '부산 센텀점', 12: '포항 양덕점', 13: '수도권 온라인', 14: '영남 온라인',
};

/**
 * Branch Home — 매장 직원 진입 첫 화면.
 *
 * 차트 0 · "오늘 매장에서 뭐 해야 하는지" 액션 list.
 *  - 3 metric card (오늘 매출 / 입고 대기 / 부족 도서) — 색상 강화
 *  - 입고 대기 / 부족 도서 / 급등+매장재고 / 신간 분배 list
 *  - 매출 상세 차트는 /branch-sales CTA
 */
export default function BranchHome() {
  const { role } = useOutletContext<{ role: Role }>();
  const { scope_store_id } = useScope();
  const today = new Date().toISOString().slice(0, 10);

  // branch-clerk scope_store_id 우선 · hq-admin / wh-manager 는 강남점 fallback
  const storeId = scope_store_id ?? 1;
  const storeName = STORE_NAMES[storeId] ?? `매장 ${storeId}`;

  // grouped: 우리 매장 관련 plan (date 인자 없이 history 포함 · BranchInbound 와 동일 row 범위)
  // 카드 카운트와 BranchInbound 의 입고/출고 대기 정합 보장.
  const grouped = useQuery({
    queryKey: ['branch-grouped', role],
    queryFn: () => fetchPendingGrouped(role),
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

  // hourly: 오늘 매출 총액만 사용 (차트 X · 카드 숫자에만)
  const hourly = useQuery({
    queryKey: ['branch-hourly', storeId, role],
    queryFn: () => fetchHourlySales(role, storeId),
    refetchInterval: 60000,
    staleTime: 30000,
  });

  // Redis 실시간 (POS 결제 시 부족 도서 list 색 flash)
  const { flashed, availableOf } = useStockUpdates(role);

  const data = grouped.data;
  const items = data?.items ?? [];
  const newbookItems = items.filter((o) => o.urgency_level === 'NEWBOOK');
  const inboundItems = items
    .filter((o) => o.order_type === 'WH_TRANSFER' && o.target_location_id === storeId)
    .slice(0, 10);
  const approvedInbound = items.filter(
    (o) => o.target_location_id === storeId && o.status === 'APPROVED',
  ).slice(0, 10);

  // 4-stage cascade 정합 (2026-05-14 Stage 0 WH_TO_STORE 추가).
  // 우리 매장 협의 중 = PENDING + (WH_TO_STORE TARGET || REBALANCE SOURCE/TARGET)
  const myPendingNegotiating = items.filter((o) => {
    if (o.status !== 'PENDING') return false;
    if (o.order_type === 'WH_TO_STORE') return o.target_location_id === storeId;
    if (o.order_type === 'REBALANCE')
      return o.source_location_id === storeId || o.target_location_id === storeId;
    return false;
  });
  // 입고 대기 (양측 ✓ APPROVED) = 우리 매장 TARGET + APPROVED
  const myApprovedInbound = items.filter(
    (o) => o.target_location_id === storeId && o.status === 'APPROVED',
  );

  // 도착 예정일 별 group (forecast_rationale.expected_arrival_date · decision-svc LEAD_DAYS 결과)
  // PENDING (협의 중) + APPROVED (운송 중) 둘 다 묶음 → 매장 직원이 언제 무엇이 도착할지 한눈에.
  const myUpcomingInbound = items.filter(
    (o) =>
      o.target_location_id === storeId &&
      (o.status === 'PENDING' || o.status === 'APPROVED'),
  );
  type ArrivalBucket = { date: string; count: number; orders: typeof items };
  const arrivalBuckets: ArrivalBucket[] = (() => {
    const m = new Map<string, ArrivalBucket>();
    for (const o of myUpcomingInbound) {
      const r = (o.forecast_rationale ?? {}) as Record<string, unknown>;
      const d = typeof r.expected_arrival_date === 'string' ? r.expected_arrival_date : null;
      if (!d) continue;
      if (d < today) continue;  // 과거 도착일 제외 (history 시드 잔존 row 회피)
      if (!m.has(d)) m.set(d, { date: d, count: 0, orders: [] });
      const b = m.get(d)!;
      b.count += 1;
      b.orders.push(o);
    }
    return [...m.values()].sort((a, b) => a.date.localeCompare(b.date));
  })();
  // 출고 대기 (우리 매장이 source · APPROVED · 운송 차 출발 대기) — 날짜별 group
  const myUpcomingOutbound = items.filter(
    (o) => o.source_location_id === storeId && (o.status === 'PENDING' || o.status === 'APPROVED'),
  );
  const outboundBuckets: ArrivalBucket[] = (() => {
    const m = new Map<string, ArrivalBucket>();
    for (const o of myUpcomingOutbound) {
      const r = (o.forecast_rationale ?? {}) as Record<string, unknown>;
      const d = typeof r.expected_arrival_date === 'string' ? r.expected_arrival_date : null;
      if (!d) continue;
      if (d < today) continue;  // 과거 출고일 제외
      if (!m.has(d)) m.set(d, { date: d, count: 0, orders: [] });
      const b = m.get(d)!;
      b.count += 1;
      b.orders.push(o);
    }
    return [...m.values()].sort((a, b) => a.date.localeCompare(b.date));
  })();
  // D+N 라벨 (오늘 대비 일 수 차이)
  const arrivalLabel = (iso: string): string => {
    const t = new Date(today + 'T00:00:00');
    const d = new Date(iso + 'T00:00:00');
    const diff = Math.round((d.getTime() - t.getTime()) / (24 * 3600 * 1000));
    if (diff <= 0) return '오늘';
    if (diff === 1) return '내일 (D+1)';
    if (diff === 2) return '모레 (D+2)';
    return `${diff}일 후 (D+${diff})`;
  };
  // 오늘 처리 완료 EXECUTED
  const myExecutedToday = items.filter(
    (o) =>
      (o.target_location_id === storeId || o.source_location_id === storeId) &&
      (o.status === 'EXECUTED' || o.status === 'AUTO_EXECUTED'),
  );

  // 매장 부족 도서 (가용 ≤ 안전재고)
  const invItems = (inv.data?.items ?? []) as any[];
  const lowStockAll = invItems
    .filter((it) => (it.available ?? 0) <= (it.safety_stock ?? 0))
    .sort((a, b) => (a.available ?? 0) - (b.available ?? 0));
  const lowStock = lowStockAll.slice(0, 5);

  // 매장 재고 매칭된 SNS 급등 도서 top 10
  const curItems = (cur.data?.items ?? []) as any[];
  const matchedSpikes = curItems.filter((c) => (c.on_hand ?? 0) > 0).slice(0, 10);

  const totalToday = data?.manual_review ?? 0;

  // 오늘 매출 총액 (hourly raw sum)
  const hourlyRaw = (hourly.data?.items ?? []) as { hour: number; revenue: number }[];
  const todaysRevenue = hourlyRaw.reduce((s, it) => s + (it.revenue ?? 0), 0);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="h1">{storeName} · {today}</h1>
        <p className="text-bf-muted text-xs mt-1">
          오늘 매장에서 처리할 액션을 한 화면으로. 매출 차트는 매장 매출 상세 페이지에서 확인하세요.
        </p>
      </div>

      {/* 0행: 매장 4-stage cascade 처리 현황 (PENDING / APPROVED / EXECUTED) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Link to="/branch-inbound" className="metric-card hover:border-bf-primary transition border-bf-warn">
          <div className="metric-label">📋 우리 매장 협의 중</div>
          <div className="metric-value text-bf-warn">{myPendingNegotiating.length}건</div>
          <div className="text-[11px] text-bf-muted mt-1">
            🏬 매장 보충 (WH→Store) / 🔄 매장 간 재분배 (양측 협의)
          </div>
        </Link>
        <Link to="/branch-inbound" className="metric-card hover:border-bf-primary transition border-bf-primary">
          <div className="metric-label">📦 입고 대기 (양측 ✓)</div>
          <div className="metric-value text-bf-primary">{myApprovedInbound.length}건</div>
          <div className="text-[11px] text-bf-muted mt-1">출고 측 발송 완료 · 도착 확인 대기</div>
        </Link>
        <Link to="/execution" className="metric-card hover:border-bf-primary transition border-bf-success">
          <div className="metric-label">✅ 오늘 처리 완료</div>
          <div className="metric-value text-bf-success">{myExecutedToday.length}건</div>
          <div className="text-[11px] text-bf-muted mt-1">EXECUTED · 위치별 추적 →</div>
        </Link>
      </div>

      {/* 1행: 오늘 처리 현황 (3 카드 · 색상 강화) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Link to="/branch-sales" className="metric-card hover:border-bf-primary transition border-bf-success">
          <div className="metric-label">💰 오늘 매출</div>
          <div className="metric-value text-bf-success">₩{todaysRevenue.toLocaleString()}</div>
          <div className="text-[11px] text-bf-muted mt-1">매장 매출 상세 →</div>
        </Link>
        <Link to="/branch-inbound" className="metric-card hover:border-bf-primary transition border-bf-warn">
          <div className="metric-label">📥 오늘 입고 대기</div>
          <div className="metric-value text-bf-warn">{newbookItems.length + approvedInbound.length}건</div>
          <div className="text-[11px] text-bf-muted mt-1">
            🆕 신간 {newbookItems.length} · 권역간 {approvedInbound.length}
          </div>
        </Link>
        <Link to="/branch-inventory" className="metric-card hover:border-bf-primary transition border-bf-danger">
          <div className="metric-label">⚠️ 매장 부족 도서</div>
          <div className="metric-value text-bf-danger">{lowStockAll.length}권</div>
          <div className="text-[11px] text-bf-muted mt-1">가용 ≤ 안전재고</div>
        </Link>
      </div>

      {/* 2행: 신간 분배 (urgency=NEWBOOK · 별도 색상 강조) */}
      {newbookItems.length > 0 && (
        <div className="card-tight bg-yellow-50 border-yellow-300">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-bold text-yellow-900">📥 오늘 신간 분배 (검수 필요)</div>
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

      {/* 3행: 입고 대기 list (APPROVED top 10) */}
      <div className="card">
        <div className="flex items-center justify-between mb-2">
          <h2 className="h2 text-sm">📦 입고 대기 (승인 완료 · 도착 대기) top 10</h2>
          <Link to="/branch-inbound" className="text-[11px] text-bf-primary hover:underline">입고 처리 →</Link>
        </div>
        {approvedInbound.length === 0 && inboundItems.length === 0 ? (
          <div className="text-xs text-bf-muted py-6 text-center">입고 대기 없음</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-bf-muted">
              <tr>
                <th className="text-left py-1">긴급도</th>
                <th className="text-left py-1">제목</th>
                <th className="text-left py-1">출발</th>
                <th className="text-right py-1">수량</th>
                <th className="text-left py-1 pl-2">상태</th>
              </tr>
            </thead>
            <tbody>
              {(approvedInbound.length > 0 ? approvedInbound : inboundItems).map((o) => (
                <tr key={o.order_id} className="border-t border-bf-border2 hover:bg-bf-panel2">
                  <td className={`py-1.5 font-bold ${o.urgency_level === 'CRITICAL' ? 'text-bf-danger' : o.urgency_level === 'URGENT' ? 'text-bf-warn' : 'text-bf-muted'}`}>
                    {o.urgency_level}
                  </td>
                  <td className="py-1.5 font-medium truncate max-w-[220px]">{o.title ?? o.isbn13}</td>
                  <td className="py-1.5 text-bf-muted">위치 {o.source_location_id ?? '-'}</td>
                  <td className="py-1.5 text-right">{o.qty}</td>
                  <td className="py-1.5 pl-2 text-bf-warn">{o.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 3.5행: 📥 받을 거 — 도착 예정일 별 group (stage 별 lead time 반영) */}
      {arrivalBuckets.length > 0 && (
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h2 className="h2 text-sm">📥 받을 거 — 도착 예정일별</h2>
            <span className="text-[10px] text-bf-muted">
              D+1 매장 보충/재분배 · D+2 권역간 · D+4 외부 발주
            </span>
          </div>
          <ul className="space-y-1.5">
            {arrivalBuckets.map((b) => {
              const types = new Set(b.orders.map((o) => o.order_type));
              const typeLabel = [...types]
                .map((t) =>
                  t === 'WH_TO_STORE'    ? '🏬 매장보충' :
                  t === 'REBALANCE'      ? '🔄 재분배' :
                  t === 'WH_TRANSFER'    ? '🚛 권역간' :
                  t === 'PUBLISHER_ORDER'? '📦 외부발주' : t,
                ).join(' · ');
              return (
                <li
                  key={b.date}
                  className="flex items-center justify-between p-2 rounded border border-bf-border2 bg-bf-panel2"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-bf-primary">{arrivalLabel(b.date)}</span>
                    <span className="text-[10px] text-bf-muted">{b.date}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs">
                    <span className="text-bf-muted">{typeLabel}</span>
                    <Link
                      to="/branch-inbound"
                      className="font-bold text-bf-primary hover:underline"
                      title={`${b.count}건 도착 예정`}
                    >
                      {b.count}건 →
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* 3.7행: 📤 보낼 거 — 출고 대기 (우리 매장이 source) · 날짜별 group */}
      {outboundBuckets.length > 0 && (
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h2 className="h2 text-sm">📤 보낼 거 — 출고 대기 (날짜별)</h2>
            <span className="text-[10px] text-bf-muted">우리 매장에서 출고 예정 · 운송 차 routing</span>
          </div>
          <ul className="space-y-1.5">
            {outboundBuckets.map((b) => {
              const types = new Set(b.orders.map((o) => o.order_type));
              const typeLabel = [...types]
                .map((t) =>
                  t === 'WH_TO_STORE'    ? '🏬 매장보충' :
                  t === 'REBALANCE'      ? '🔄 재분배' :
                  t === 'WH_TRANSFER'    ? '🚛 권역간' :
                  t === 'PUBLISHER_ORDER'? '📦 외부발주' : t,
                ).join(' · ');
              return (
                <li
                  key={b.date}
                  className="flex items-center justify-between p-2 rounded border border-bf-border2 bg-bf-panel2"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-bf-warn">{arrivalLabel(b.date)}</span>
                    <span className="text-[10px] text-bf-muted">{b.date}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs">
                    <span className="text-bf-muted">{typeLabel}</span>
                    <Link
                      to="/branch-inbound"
                      className="font-bold text-bf-warn hover:underline"
                      title={`${b.count}건 출고 예정`}
                    >
                      {b.count}건 →
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* 4행: 부족 도서 alert top 5 */}
      <div className="card">
        <div className="flex items-center justify-between mb-2">
          <h2 className="h2 text-sm">⚠️ 매장 부족 도서 top 5 (안전재고 미달)</h2>
          <Link to="/branch-inventory" className="text-[11px] text-bf-primary hover:underline">
            매장 재고 전체 →
          </Link>
        </div>
        {lowStock.length === 0 ? (
          <div className="text-xs text-bf-muted py-6 text-center">현재 부족 도서 없음 · 매장 정상 운영</div>
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
                  <tr key={it.isbn13} className="border-t border-bf-border2 hover:bg-bf-panel2">
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

      {/* 5행: SNS 급등 + 매장 보유 top 10 */}
      <div className="card">
        <div className="flex items-center justify-between mb-2">
          <h2 className="h2 text-sm">🔥 SNS 급등 + 매장 보유 top 10 (우선 진열)</h2>
          <Link to="/branch-curation" className="text-[11px] text-bf-primary hover:underline">큐레이션 →</Link>
        </div>
        {matchedSpikes.length === 0 ? (
          <div className="text-xs text-bf-muted py-6 text-center">매장 재고 매칭 급등 도서 없음</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-bf-muted">
              <tr>
                <th className="text-left py-1">제목</th>
                <th className="text-left py-1">분야</th>
                <th className="text-right py-1">z-score</th>
                <th className="text-right py-1">매장재고</th>
              </tr>
            </thead>
            <tbody>
              {matchedSpikes.map((c, i) => (
                <tr key={`${c.isbn13 ?? i}-${i}`} className="border-t border-bf-border2 hover:bg-bf-panel2">
                  <td className="py-1.5 font-medium truncate max-w-[220px]">{c.title ?? c.isbn13}</td>
                  <td className="py-1.5 text-bf-muted">{c.category ?? '-'}</td>
                  <td className={`py-1.5 text-right font-bold ${(c.z_score ?? 0) >= 3 ? 'text-bf-danger' : 'text-bf-warn'}`}>
                    {(c.z_score ?? 0).toFixed(2)}
                  </td>
                  <td className="py-1.5 text-right text-bf-success font-bold">{c.on_hand}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 6행: 큰 CTA — 매출 상세 페이지 */}
      <Link to="/branch-sales" className="card hover:border-bf-primary transition flex items-center justify-between py-6">
        <div>
          <div className="text-xs text-bf-muted mb-1">📊 시간대별 매출 · 베스트셀러 차트</div>
          <div className="text-xl font-bold text-bf-text">매장 매출 상세 보기</div>
          <div className="text-[11px] text-bf-muted mt-1">오늘 시간대별 매출 · 베스트셀러 top 10 · 카테고리 분포</div>
        </div>
        <div className="text-3xl text-bf-primary">→</div>
      </Link>

      {/* 7행: 추천 액션 hint */}
      <div className="card-tight bg-bf-panel2 border-bf-border2">
        <div className="text-[11px] text-bf-muted mb-2">📋 추천 액션</div>
        <ul className="text-xs space-y-1 ml-4 list-disc">
          {newbookItems.length > 0 && (
            <li>본사 신간 <b className="text-yellow-700">{newbookItems.length}건</b> 검수 — <Link to="/branch-inbound" className="text-bf-primary hover:underline">입고 처리</Link></li>
          )}
          {approvedInbound.length > 0 && (
            <li>권역간 도착 <b>{approvedInbound.length}건</b> 수령 확인 — <Link to="/branch-inbound" className="text-bf-primary hover:underline">입고 처리</Link></li>
          )}
          {lowStockAll.length > 0 && (
            <li>부족 도서 <b className="text-bf-danger">{lowStockAll.length}권</b> 본사 발주 요청 검토 — <Link to="/branch-curation" className="text-bf-primary hover:underline">발주 요청</Link></li>
          )}
          {matchedSpikes.length > 0 && (
            <li>SNS 급등 도서 <b>{matchedSpikes.length}건</b> 우선 진열 — <Link to="/branch-curation" className="text-bf-primary hover:underline">매장 재고 매칭</Link></li>
          )}
          {totalToday === 0 && lowStockAll.length === 0 && (
            <li className="list-none text-bf-muted">오늘 처리 대기 없음 · 매장 정상 운영 중</li>
          )}
        </ul>
      </div>
    </div>
  );
}
