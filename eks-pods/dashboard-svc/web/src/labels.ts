// 한글 표시 매핑 - DB enum 값을 사용자 친화 한글로 변환.
// 기술 식별자는 그대로 두되, UI 노출 텍스트는 모두 이 파일을 거치게 한다.

export const ORDER_TYPE_KO: Record<string, string> = {
  WH_TO_STORE:     '🏬 매장 보충',
  REBALANCE:       '🔄 매장 간 재분배',
  WH_TRANSFER:     '🚛 권역 간 이동',
  PUBLISHER_ORDER: '📦 외부 발주',
};

// order_type 별 컬러 일관 적용 (캘린더 cell · 승인 row).
//   REBALANCE=초록 · WH_TO_STORE=파랑 · WH_TRANSFER=보라 · PUBLISHER_ORDER=주황
// 클래스명 ot-{order_type} 가 styles.css 에서 --ot CSS 변수 정의.
export function orderTypeClass(order_type: string): string {
  return `ot-${order_type}`;
}

export const ORDER_STATUS_KO: Record<string, string> = {
  PENDING:       '⏳ 협의 중',
  APPROVED:      '📋 계획 확정',
  IN_TRANSIT:    '🚚 운송 중',
  EXECUTED:      '✅ 완료',
  AUTO_EXECUTED: '⚡ 자동 실행',
  REJECTED:      '❌ 거부됨',
  CANCELED:      '취소됨',
};

// PR-B 4-step state machine v2 — REJECTED rejection_stage 라벨
export const REJECTION_STAGE_KO: Record<string, string> = {
  PENDING:    '협의 단계 거부',
  APPROVED:   '발송 전 취소',
  IN_TRANSIT: '운송 중 반품 (재고 복원)',
};

export const URGENCY_KO: Record<string, string> = {
  NORMAL:   '일반',
  URGENT:   '긴급',
  CRITICAL: '매우 긴급',
  NEWBOOK:  '신간 발주',
};

export const APPROVAL_SIDE_KO: Record<string, string> = {
  FINAL:  '최종 승인',
  SOURCE: '출고측 승인',
  TARGET: '입고측 승인',
};

// 신간 신청 상태
export const NEWBOOK_STATUS_KO: Record<string, string> = {
  NEW:      '신규',
  FETCHED:  '검토중',
  APPROVED: '편입완료',
  REJECTED: '거절',
};

// 반품 상태
export const RETURN_STATUS_KO: Record<string, string> = {
  PENDING:  '신청',
  APPROVED: '승인',
  EXECUTED: '실행됨',
  REJECTED: '거절',
};

// 알림 상태
export const NOTIFICATION_STATUS_KO: Record<string, string> = {
  SENT:    '발송 완료',
  FAILED:  '발송 실패',
  PENDING: '대기',
};

// wh_id → 권역명
export const WH_NAME_KO: Record<number, string> = {
  1: '수도권',
  2: '영남',
};

export function whName(wh_id: number | null | undefined): string {
  if (wh_id == null) return '-';
  return WH_NAME_KO[wh_id] ?? `권역 ${wh_id}`;
}

// 안전 lookup helper - 매핑 없으면 원본 그대로
export function ko(map: Record<string, string>, key: string | null | undefined): string {
  if (!key) return '-';
  return map[key] ?? key;
}
