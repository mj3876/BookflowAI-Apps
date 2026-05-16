// 2026-05-16 walkthrough-9 이슈13 종합 — order 분류 단일 모듈.
//
// CalendarDetail(날짜별 상세) · /logistics(당일 상세) 가 공유. 중복 classify 제거.
//
// 핵심: 각 order 를 source face / target face 2면으로 분해.
//   - source face = 보내는 측 (발송 행위)  → APPROVED 면 출고 탭
//   - target face = 받는 측  (수령 행위)  → APPROVED/IN_TRANSIT 면 입고 탭
// 어느 face 를 노출하느냐는 (role, scope, planView) 로 결정.
//
// 이슈13   — planView(scope 필터) 미반영 → 물류센터 계획에 WH_TO_STORE 입고면 오출현.
// 이슈13-2 — hq 가 isSrc=isTgt 라 모든 APPROVED 가 "BOTH→inbound" 로 떨어져 입고 탭에 발송버튼.
// → face 기반 명시 매트릭스로 재설계.

import type { PendingOrder } from '../api';

export type Tab = 'inbound' | 'outbound' | 'in_transit' | 'executed';
export type Side = 'source' | 'target';
export type Placement = { tab: Tab; side: Side };
export type PlanView = 'all' | 'mine' | 'observe';

type Scope = { scope_wh_id: number | null; scope_store_id: number | null };

// 이슈10 2026-05-16: chained WH_TO_STORE 판별 —
//   상위 발주(WH_TRANSFER/PUBLISHER_ORDER) 실행 후 자동 생성된 결과물(이미 APPROVED 강제).
//   forecast_rationale.auto_approved=true 표식. hq 는 강제승인/발송/수령 대상 아님(read-only 관제).
export function isChained(o: PendingOrder): boolean {
  return o.forecast_rationale?.auto_approved === true;
}

// order_type 별 source/target face 의 위치 종류 (WH=물류센터 · STORE=매장 · EXT=외부 출판사).
//   WH_TO_STORE     source=WH    target=STORE
//   WH_TRANSFER     source=WH    target=WH
//   REBALANCE       source=STORE target=STORE
//   PUBLISHER_ORDER source=EXT   target=WH
type FaceKind = 'WH' | 'STORE' | 'EXT';
function faceKinds(orderType: string): { src: FaceKind; tgt: FaceKind } {
  switch (orderType) {
    case 'WH_TO_STORE':     return { src: 'WH', tgt: 'STORE' };
    case 'WH_TRANSFER':     return { src: 'WH', tgt: 'WH' };
    case 'REBALANCE':       return { src: 'STORE', tgt: 'STORE' };
    case 'PUBLISHER_ORDER': return { src: 'EXT', tgt: 'WH' };
    default:                return { src: 'WH', tgt: 'WH' };
  }
}

// 내 스코프가 source/target face 에 닿는지 (branch-clerk / wh-manager 용).
function scopeTouch(o: PendingOrder, scope: Scope): { src: boolean; tgt: boolean } {
  const srcWh = (o as PendingOrder & { source_wh_id?: number | null }).source_wh_id;
  const tgtWh = (o as PendingOrder & { target_wh_id?: number | null }).target_wh_id;
  const src =
    (scope.scope_store_id != null && o.source_location_id === scope.scope_store_id) ||
    (scope.scope_wh_id != null && srcWh === scope.scope_wh_id);
  const tgt =
    (scope.scope_store_id != null && o.target_location_id === scope.scope_store_id) ||
    (scope.scope_wh_id != null && tgtWh === scope.scope_wh_id);
  return { src, tgt };
}

// 노출할 face 결정 — (role, scope, planView) 조합.
//   branch-clerk / wh-manager: 내 스코프가 닿는 face 만.
//   hq-admin: planView='all' → 양면 · 'mine'(물류센터) → WH face 만 · 'observe'(지점) → STORE face 만.
function visibleFaces(
  o: PendingOrder, role: string, scope: Scope, planView: PlanView,
): { src: boolean; tgt: boolean } {
  if (role === 'hq-admin') {
    if (planView === 'all') return { src: true, tgt: true };
    const kind = faceKinds(o.order_type);
    const want: FaceKind = planView === 'mine' ? 'WH' : 'STORE';
    return { src: kind.src === want, tgt: kind.tgt === want };
  }
  // branch-clerk / wh-manager — backend 가 scope 보장하지만 frontend 도 face 단위로 분해.
  return scopeTouch(o, scope);
}

// 각 order → placement 목록 (탭 + 그 탭의 face).
//   source face: APPROVED→outbound · IN_TRANSIT→in_transit · EXECUTED→executed
//   target face: APPROVED→inbound  · IN_TRANSIT→inbound    · EXECUTED→executed
//   PENDING 은 협의(/approval) 전용 → 배치 안 함.
export function classify(
  o: PendingOrder, role: string, scope: Scope, planView: PlanView = 'all',
): { placements: Placement[] } {
  const faces = visibleFaces(o, role, scope, planView);
  const placements: Placement[] = [];
  const st = o.status;

  if (st === 'EXECUTED' || st === 'AUTO_EXECUTED') {
    // 완료 — 노출되는 face 중 하나만 (중복 카운트 방지: source 우선, 없으면 target).
    if (faces.src) placements.push({ tab: 'executed', side: 'source' });
    else if (faces.tgt) placements.push({ tab: 'executed', side: 'target' });
    return { placements };
  }

  if (faces.src) {
    if (st === 'APPROVED') placements.push({ tab: 'outbound', side: 'source' });
    else if (st === 'IN_TRANSIT') placements.push({ tab: 'in_transit', side: 'source' });
  }
  if (faces.tgt) {
    if (st === 'APPROVED') placements.push({ tab: 'inbound', side: 'target' });
    else if (st === 'IN_TRANSIT') placements.push({ tab: 'inbound', side: 'target' });
  }
  return { placements };
}
