/**
 * 빈상태 placeholder — 테이블/리스트가 비었을 때 일관된 메시지 표시.
 * 표 셀 안에서 사용 시 colSpan 을 부모에서 맞춰야 함.
 */
export default function EmptyState({
  icon = '📭',
  message = '표시할 데이터가 없습니다',
  hint,
  className = '',
}: {
  icon?: string;
  message?: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={`flex flex-col items-center justify-center py-10 text-bf-muted ${className}`}>
      <div className="text-4xl mb-2 opacity-60" aria-hidden>{icon}</div>
      <div className="text-sm">{message}</div>
      {hint && <div className="text-xs mt-1 opacity-70">{hint}</div>}
    </div>
  );
}
