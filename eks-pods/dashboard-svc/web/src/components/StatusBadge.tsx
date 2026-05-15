/**
 * StatusBadge — 시연 시 출고/입고/거부/실행 명확화용 공통 뱃지.
 *
 * 뱃지 매트릭스:
 *   PENDING + 양측 협의 + selfDone           → ⏳ 상대 측 대기 (yellow)
 *   PENDING + 협의 전                         → 📋 협의 대기 (gray)
 *   APPROVED                                  → 🚚 출고 완료 · 입고 대기 (blue)
 *   EXECUTED                                  → ✅ 실행 완료 (green)
 *   REJECTED + approvedAt null               → ❌ 계획 거부 (red)
 *   REJECTED + approvedAt 있음                → 🔄 거부 · 재고 복원됨 (orange)
 *   AUTO_EXECUTED                             → ⚡ 자동 실행 (purple)
 *
 * 색상 토큰: tailwind.config.js 의 bf 팔레트 우선 (bf-warn/success/danger 등),
 * orange/purple 처럼 bf 토큰 없는 색은 tailwind 기본 색 사용.
 */

type Props = {
  status: 'PENDING' | 'APPROVED' | 'EXECUTED' | 'REJECTED' | 'AUTO_EXECUTED' | string;
  /** 양측 협의 진행 — frontend 에서 status + selfDone 으로 추정 (backend 미확장). */
  approvalSidesDone?: string[];
  orderType?: 'WH_TO_STORE' | 'REBALANCE' | 'WH_TRANSFER' | 'PUBLISHER_ORDER' | string;
  /** REJECTED 의 거부 시점 판단 (있으면 APPROVED 후 거부 → 재고 복원됨) */
  approvedAt?: string | null;
  className?: string;
};

export default function StatusBadge({
  status,
  approvalSidesDone,
  orderType,
  approvedAt,
  className = '',
}: Props) {
  const isBothSides = orderType === 'WH_TO_STORE' || orderType === 'REBALANCE' || orderType === 'WH_TRANSFER';
  const partialDone = (approvalSidesDone?.length ?? 0) > 0 && (approvalSidesDone?.length ?? 0) < 2;

  let icon = '';
  let label = '';
  let tone = '';

  if (status === 'PENDING') {
    if (isBothSides && partialDone) {
      icon = '⏳';
      label = '상대 측 대기';
      tone = 'bg-bf-warnbg text-bf-warn border border-yellow-300';
    } else {
      icon = '📋';
      label = '협의 대기';
      tone = 'bg-bf-panel2 text-bf-muted border border-bf-border';
    }
  } else if (status === 'APPROVED') {
    icon = '🚚';
    label = '출고 완료 · 입고 대기';
    tone = 'bg-blue-50 text-blue-700 border border-blue-300';
  } else if (status === 'EXECUTED') {
    icon = '✅';
    label = '실행 완료';
    tone = 'bg-bf-successbg text-bf-success border border-green-300';
  } else if (status === 'REJECTED') {
    if (approvedAt) {
      icon = '🔄';
      label = '거부 · 재고 복원됨';
      tone = 'bg-orange-50 text-orange-700 border border-orange-300';
    } else {
      icon = '❌';
      label = '계획 거부';
      tone = 'bg-bf-dangerbg text-bf-danger border border-red-300';
    }
  } else if (status === 'AUTO_EXECUTED') {
    icon = '⚡';
    label = '자동 실행';
    tone = 'bg-purple-50 text-purple-700 border border-purple-300';
  } else {
    icon = '·';
    label = status;
    tone = 'bg-bf-panel2 text-bf-muted border border-bf-border';
  }

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${tone} ${className}`}
      title={`${status}${approvedAt ? ` · approved_at=${approvedAt}` : ''}`}
    >
      <span aria-hidden>{icon}</span>
      <span>{label}</span>
    </span>
  );
}
