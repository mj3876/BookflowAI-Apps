import { useQuery } from '@tanstack/react-query';
import { Link, useOutletContext } from 'react-router-dom';
import { fetchPendingGrouped, fetchInventoryByStore, fetchCuration, type Role } from '../api';

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
  const today = new Date().toISOString().slice(0, 10);

  // mock 'branch-clerk' role 의 scope_store_id = 1 (강남점) — 실제론 JWT 의 scope
  const storeId = 1;
  const storeName = STORE_NAMES[storeId];

  const grouped = useQuery({
    queryKey: ['branch-grouped', role, today],
    queryFn: () => fetchPendingGrouped(role, today),
    refetchInterval: 10000,
  });

  const inv = useQuery({
    queryKey: ['branch-inv', storeId, role],
    queryFn: () => fetchInventoryByStore(role, storeId),
    refetchInterval: 30000,
  });

  const cur = useQuery({
    queryKey: ['branch-cur', storeId, role],
    queryFn: () => fetchCuration(role, storeId),
    refetchInterval: 60000,
  });

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
              {lowStock.map((it) => (
                <tr key={it.isbn13} className="border-t border-bf-border2">
                  <td className="py-1.5 font-medium">{it.title ?? it.isbn13}</td>
                  <td className="py-1.5 text-bf-muted">{it.author ?? '-'}</td>
                  <td className="py-1.5 text-right">{it.on_hand}</td>
                  <td className="py-1.5 text-right">{it.safety_stock}</td>
                  <td className="py-1.5 text-right">
                    <span className="text-bf-danger font-bold">{it.available}</span>
                  </td>
                </tr>
              ))}
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
