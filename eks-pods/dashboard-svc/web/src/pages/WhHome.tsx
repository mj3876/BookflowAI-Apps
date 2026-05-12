import { useQuery } from '@tanstack/react-query';
import { Link, useOutletContext } from 'react-router-dom';
import { fetchPending, fetchPendingGrouped, fetchInstructions, fetchOverview, type Role } from '../api';

/**
 * WH Home — 물류센터 매니저 진입 첫 화면.
 *
 * 메인:
 *  - 권역 매장 한눈에 (매출/재고 요약)
 *  - PENDING 4 카테고리 카운트 (재분배 / 권역간 출고 / 권역간 입고 / 외부 발주)
 *  - 오늘 출고 지시 카운트
 */
export default function WhHome() {
  const { role } = useOutletContext<{ role: Role }>();
  const wh = role === 'wh-manager-2' ? 2 : 1;
  const whName = wh === 1 ? '수도권' : '영남';
  const partnerName = wh === 1 ? '영남' : '수도권';

  const today = new Date().toISOString().slice(0, 10);
  const grouped = useQuery({
    queryKey: ['wh-grouped', role, today],
    queryFn: () => fetchPendingGrouped(role, today),
    refetchInterval: 30000,
  });

  const overview = useQuery({ queryKey: ['wh-ov', wh, role], queryFn: () => fetchOverview(wh, role), refetchInterval: 5000 });
  const reb = useQuery({ queryKey: ['wh-pending-reb', wh, role], queryFn: () => fetchPending(role, { order_type: 'REBALANCE', limit: 50 }), refetchInterval: 8000 });
  const tr = useQuery({ queryKey: ['wh-pending-tr', wh, role], queryFn: () => fetchPending(role, { order_type: 'WH_TRANSFER', limit: 50 }), refetchInterval: 8000 });
  const pub = useQuery({ queryKey: ['wh-pending-pub', wh, role], queryFn: () => fetchPending(role, { order_type: 'PUBLISHER_ORDER', limit: 50 }), refetchInterval: 8000 });
  const instr = useQuery({ queryKey: ['wh-instr', wh, role], queryFn: () => fetchInstructions(role, wh), refetchInterval: 8000 });

  const rebPending = (reb.data?.items ?? []).filter((o) => o.status === 'PENDING').length;
  const trItems = tr.data?.items ?? [];
  // 출고 측 (source 가 내 권역) vs 입고 측 (target 이 내 권역)
  const trSource = trItems.filter((o) => o.status === 'PENDING' && o.source_location_id != null && _isMyWh(o.source_location_id, wh)).length;
  const trTarget = trItems.filter((o) => o.status === 'PENDING' && o.target_location_id != null && _isMyWh(o.target_location_id, wh) && !_isMyWh(o.source_location_id ?? 0, wh)).length;
  const pubPending = (pub.data?.items ?? []).filter((o) => o.status === 'PENDING').length;
  const instrCount = (instr.data?.items ?? []).filter((o) => o.status === 'APPROVED').length;

  // 권역 매장 매출 + 부족 SKU
  // overview 에 매장별 매출 없음 (pending/inventory 만) — 권역 매출은 fetchSalesByStore 별도. 일단 임시로 0 처리.
  const mySalesByStore: any[] = [];
  const totalRevenue = 0;
  const myInv = (overview.data?.inventory?.items ?? []).filter((it: any) => _isMyWh(it.location_id, wh));
  const lowStockCount = myInv.filter((it: any) => it.available <= 10).length;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="h1">{whName} 권역 · {today}</h1>
        <p className="text-bf-muted text-xs mt-1">
          내 권역 매장 6곳 · 오늘 batch 처리 현황과 협의 필요한 권역간 이동을 한 화면으로.
        </p>
      </div>

      {/* 메인 카드: 오늘 batch monitor */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="metric-card bg-bf-panel2 border-bf-border2">
          <div className="metric-label">✅ 07:00 batch 자동 승인</div>
          <div className="metric-value text-bf-success">{grouped.data?.auto_executed_at_07 ?? 0}건</div>
          <div className="text-[11px] text-bf-muted mt-1">내 권역 URGENT/CRITICAL 자동 처리</div>
        </div>
        <Link to="/wh-approve" className="metric-card hover:border-bf-primary transition border-bf-warn">
          <div className="metric-label">📋 내 권역 검토 필요</div>
          <div className="metric-value text-bf-warn">{grouped.data?.manual_review ?? 0}건</div>
          <div className="text-[11px] text-bf-muted mt-1">단독 승인 + 양측 협의</div>
        </Link>
        <div className="metric-card bg-bf-panel2 border-bf-border2">
          <div className="metric-label">⏰ 18:00 batch 거절 예정</div>
          <div className="metric-value text-bf-muted">{grouped.data?.auto_reject_at_18_pending ?? 0}건</div>
          <div className="text-[11px] text-bf-muted mt-1">NORMAL · D-1 이전 미처리</div>
        </div>
      </div>

      {/* 1행: 권역 매출 + 재고 요약 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="metric-card">
          <div className="metric-label">권역 24h 매출</div>
          <div className="metric-value">₩{Math.round(totalRevenue / 10000).toLocaleString()}만</div>
          <div className="text-[11px] text-bf-muted mt-1">{mySalesByStore.length} 매장 합산</div>
        </div>
        <Link to="/wh-dashboard" className="metric-card hover:border-bf-primary transition">
          <div className="metric-label">권역 SKU</div>
          <div className="metric-value">{myInv.length.toLocaleString()}</div>
          <div className="text-[11px] text-bf-muted mt-1">
            부족 (가용 ≤ 10) <b className="text-bf-danger">{lowStockCount}건</b>
          </div>
        </Link>
        <Link to="/wh-instructions" className="metric-card hover:border-bf-primary transition">
          <div className="metric-label">오늘 출고/입고 지시</div>
          <div className="metric-value">{instrCount}건</div>
          <div className="text-[11px] text-bf-muted mt-1">승인 완료 → 운송/매장 입고</div>
        </Link>
        <div className="metric-card">
          <div className="metric-label">전체 처리 대기</div>
          <div className="metric-value">{rebPending + trSource + trTarget + pubPending}건</div>
          <div className="text-[11px] text-bf-muted mt-1">하단 카드별 분류</div>
        </div>
      </div>

      {/* D1-1 disjoint 카테고리: 단독 승인 (REBALANCE + PUBLISHER_ORDER) vs 양측 협의 (WH_TRANSFER) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Link to="/wh-approve?tab=REBALANCE" className="metric-card hover:border-bf-primary transition">
          <div className="metric-label">🟢 권역 내 재분배 (단독 승인)</div>
          <div className="metric-value">{rebPending}건</div>
          <div className="text-[11px] text-bf-muted mt-1">자기 권역 매장 간 이동 · 단독 즉시 승인</div>
        </Link>
        <Link to="/wh-approve?tab=WH_TRANSFER" className="metric-card hover:border-bf-primary transition border-orange-300/40">
          <div className="metric-label">🟡 권역 간 이동 (양측 협의 필요)</div>
          <div className="metric-value">{trSource + trTarget}건</div>
          <div className="text-[11px] text-bf-muted mt-1">
            출고 {trSource} · 입고 {trTarget} · 처리 대기에서 자기 측(SOURCE/TARGET) 승인
          </div>
        </Link>
        <Link to="/wh-approve?tab=PUBLISHER_ORDER" className="metric-card hover:border-bf-primary transition border-red-300/40">
          <div className="metric-label">🔴 외부 발주 (단독 승인 · 비용 발생)</div>
          <div className="metric-value">{pubPending}건</div>
          <div className="text-[11px] text-bf-muted mt-1">자기 권역분 출판사 발주 · 1·2 단계 불가 시</div>
        </Link>
      </div>

      {/* 추천 액션 */}
      <div className="card-tight bg-bf-panel2 border-bf-border2">
        <div className="text-[11px] text-bf-muted mb-2">📋 추천 액션</div>
        <ul className="text-xs space-y-1 ml-4 list-disc">
          {rebPending > 0 && <li>권역 내 재분배 <b>{rebPending}건</b> — <Link to="/wh-approve" className="text-bf-primary hover:underline">처리 대기</Link> 에서 승인</li>}
          {trTarget > 0 && <li>{partnerName} 권역에서 보낸 입고 <b>{trTarget}건</b> 수락 대기 — <Link to="/wh-transfer" className="text-bf-primary hover:underline">권역 간 이동</Link></li>}
          {trSource > 0 && <li>출고 발의 <b>{trSource}건</b> 상대 권역 수락 대기 중</li>}
          {pubPending > 0 && <li>외부 발주 <b>{pubPending}건</b> 자기 권역분 — <Link to="/wh-approve" className="text-bf-primary hover:underline">외부 발주 탭</Link></li>}
          {instrCount > 0 && <li>오늘 출고/입고 지시서 <b>{instrCount}건</b> 처리 — <Link to="/wh-instructions" className="text-bf-primary hover:underline">지시서</Link></li>}
          {rebPending === 0 && trSource === 0 && trTarget === 0 && pubPending === 0 && (
            <li className="list-none text-bf-muted">현재 처리 대기 없음 · 권역 매장 정상 운영 중</li>
          )}
        </ul>
      </div>
    </div>
  );
}

function _isMyWh(location_id: number, my_wh: number): boolean {
  // location_id 1~6 = wh1, 7~12 = wh2, 13/14 = online (wh1/wh2)
  if (location_id <= 6) return my_wh === 1;
  if (location_id <= 12) return my_wh === 2;
  return location_id === 13 ? my_wh === 1 : my_wh === 2;
}
