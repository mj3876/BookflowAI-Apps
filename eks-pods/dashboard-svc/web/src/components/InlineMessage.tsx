import { useEffect } from 'react';

type Type = 'success' | 'error' | 'info' | 'warn';

const STYLES: Record<Type, { icon: string; cls: string }> = {
  success: { icon: '✓', cls: 'border-green-300 bg-green-50 text-green-900' },
  error:   { icon: '✗', cls: 'border-red-300 bg-red-50 text-red-900' },
  info:    { icon: 'ℹ', cls: 'border-blue-300 bg-blue-50 text-blue-900' },
  warn:    { icon: '⚠', cls: 'border-yellow-300 bg-yellow-50 text-yellow-900' },
};

/**
 * 페이지 상단에 표시되는 일회성 알림 (성공/에러/정보).
 * 닫기 버튼 + 옵션 자동 dismiss (autoDismissMs).
 */
export default function InlineMessage({
  type = 'info',
  message,
  onClose,
  autoDismissMs,
}: {
  type?: Type;
  message: string;
  onClose: () => void;
  autoDismissMs?: number;
}) {
  useEffect(() => {
    if (!autoDismissMs) return;
    const t = setTimeout(onClose, autoDismissMs);
    return () => clearTimeout(t);
  }, [autoDismissMs, onClose]);

  const s = STYLES[type];
  return (
    <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${s.cls}`}>
      <span className="font-bold mt-[1px]">{s.icon}</span>
      <span className="flex-1">{message}</span>
      <button
        className="opacity-70 hover:opacity-100 leading-none"
        onClick={onClose}
        aria-label="닫기"
      >
        ✕
      </button>
    </div>
  );
}
