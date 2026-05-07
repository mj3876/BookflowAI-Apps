import { useEffect } from 'react';

/**
 * 확인 모달 — window.confirm 대체. 위험 액션 (거부/삭제 등) 또는 일반 확인.
 * danger=true 면 빨간 강조, 아니면 기본 색상.
 */
export default function ConfirmModal({
  open,
  title,
  message,
  confirmText = '확인',
  cancelText = '취소',
  danger = false,
  onConfirm,
  onCancel,
  isLoading = false,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  isLoading?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-bf-bg border border-bf-border rounded-lg p-5 w-full max-w-sm shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold mb-2">{title}</h3>
        <div className="text-sm text-bf-muted mb-4 whitespace-pre-line">{message}</div>
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onCancel} disabled={isLoading}>
            {cancelText}
          </button>
          <button
            className={danger ? 'btn-primary text-bf-danger border-bf-danger' : 'btn-primary'}
            onClick={onConfirm}
            disabled={isLoading}
          >
            {isLoading ? '처리 중…' : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
