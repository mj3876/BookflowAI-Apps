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
//
// 2026-05-16 walkthrough-10 이슈18·19 — face 판정 단일 규칙으로 통일.
//   기존엔 hq(planView) 경로와 wh/branch(scope) 경로가 서로 다른 코드라
//   wh-manager 가 WH_TO_STORE 의 target(STORE) 을 자기 권역으로 잘못 잡아 입고면까지 노출.
//   → face 가시성을 "그 face 의 kind + 그 entity 가 내 것인지" 단일 규칙으로 판정.
//     hq(planView) · wh-manager scope · branch-clerk scope 가 전부 같은 함수를 탐.
//     불변식: "HQ 물류센터 계획 == 해당 wh-manager 자기 뷰",
//             "HQ 지점 계획     == 해당 branch-clerk 자기 뷰".

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

// ── face 가시성 단일 규칙 ──────────────────────────────────────────────
// 보는 주체별 entity:
//   hq-admin     — 제한 없음. planView 가 어느 face-kind 를 볼지 선택.
//   wh-manager   — 자기 창고(WH). WH-kind face 이고 그 WH 가 내 창고일 때만.
//   branch-clerk — 자기 매장(STORE). STORE-kind face 이고 그 STORE 가 내 매장일 때만.
//
// face 별 (kind, 그 entity 가 내 것인지) 판정 — hq 든 wh 든 branch 든 동일 함수.
//   WH-kind face   → 그 위치의 wh_id (source_wh_id / target_wh_id) 가 내 scope_wh_id 와 일치.
//   STORE-kind face→ 그 위치의 location_id (source/target_location_id) 가 내 scope_store_id 와 일치.
//   EXT face (PUBLISHER source) → 어떤 내부 주체에게도 "내 것" 아님.
function visibleFaces(
  o: PendingOrder, role: string, scope: Scope, planView: PlanView,
): { src: boolean; tgt: boolean } {
  const kind = faceKinds(o.order_type);
  const srcWh = (o as PendingOrder & { source_wh_id?: number | null }).source_wh_id;
  const tgtWh = (o as PendingOrder & { target_wh_id?: number | null }).target_wh_id;

  if (role === 'hq-admin') {
    // hq 는 entity 제한 없음 — planView 로 face-kind 만 선택.
    //   all → 양면 (단 PUBLISHER source 는 EXT — 출고/운송 면 없음 · B1)
    //   mine(물류센터 계획) → WH-kind face 만 · observe(지점 계획) → STORE-kind face 만.
    if (planView === 'all') return { src: kind.src !== 'EXT', tgt: kind.tgt !== 'EXT' };
    const want: FaceKind = planView === 'mine' ? 'WH' : 'STORE';
    return { src: kind.src === want, tgt: kind.tgt === want };
  }

  if (role.startsWith('wh-manager')) {
    // wh-manager — 내 창고 WH-face(mine) + 내 권역 매장 REBALANCE-face(observe).
    //   mine    : WH-kind face 가 내 창고 (WH_TO_STORE 출고 · WH_TRANSFER · PUBLISHER 입고)
    //   observe : REBALANCE 의 STORE-kind face 가 내 권역 (권역 매장 재분배)
    //   all     : 둘 다. WH_TO_STORE 의 STORE target 면은 계속 숨김 (이슈19 의도 — branch 몫).
    const my = scope.scope_wh_id;
    if (my == null) return { src: false, tgt: false };
    const srcMine = kind.src === 'WH' && srcWh === my;
    const tgtMine = kind.tgt === 'WH' && tgtWh === my;
    const isReb = o.order_type === 'REBALANCE';
    const srcReg = isReb && kind.src === 'STORE' && srcWh === my;
    const tgtReg = isReb && kind.tgt === 'STORE' && tgtWh === my;
    if (planView === 'mine')    return { src: srcMine, tgt: tgtMine };
    if (planView === 'observe') return { src: srcReg,  tgt: tgtReg  };
    return { src: srcMine || srcReg, tgt: tgtMine || tgtReg };
  }

  // branch-clerk — STORE-kind face 이고 그 STORE 가 내 매장일 때만.
  //   REBALANCE   : 내 매장이 src 면 출고면 / tgt 면 입고면.
  //   WH_TO_STORE : tgt(STORE=내매장) 입고면만 · src(WH) 안 보임.
  const myStore = scope.scope_store_id;
  return {
    src: kind.src === 'STORE' && myStore != null && o.source_location_id === myStore,
    tgt: kind.tgt === 'STORE' && myStore != null && o.target_location_id === myStore,
  };
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
