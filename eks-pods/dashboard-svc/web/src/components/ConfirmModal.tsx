import { useEffect, useState } from 'react';

/**
 * 확인 모달 — window.confirm/prompt 대체. 위험 액션 (거부/삭제 등) 또는 일반 확인.
 *
 * - danger=true: 빨간 강조 (거부/삭제)
 * - withReason=true: textarea 입력 받음 (reasonRequired=true 면 필수). onConfirm 에 reason 전달.
 *   reason 사용 안 하면 onConfirm() 호출 (인자 없음).
 */
export default function ConfirmModal({
  open,
  title,
  message,
  confirmText = '확인',
  cancelText = '취소',
  danger = false,
  withReason = false,
  reasonRequired = false,
  reasonLabel = '사유',
  reasonPlaceholder = '사유를 입력하세요',
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
  withReason?: boolean;
  reasonRequired?: boolean;
  reasonLabel?: string;
  reasonPlaceholder?: string;
  onConfirm: (reason?: string) => void;
  onCancel: () => void;
  isLoading?: boolean;
}) {
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (open) setReason('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const reasonInvalid = withReason && reasonRequired && reason.trim().length === 0;

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
        {withReason && (
          <div className="mb-4">
            <label className="block text-xs text-bf-muted mb-1">
              {reasonLabel}{reasonRequired && <span className="text-bf-danger ml-0.5">*</span>}
            </label>
            <textarea
              className="w-full text-sm border border-bf-border rounded p-2 bg-bf-panel resize-none"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={reasonPlaceholder}
              autoFocus
              disabled={isLoading}
            />
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onCancel} disabled={isLoading}>
            {cancelText}
          </button>
          <button
            className={danger ? 'btn-primary text-bf-danger border-bf-danger' : 'btn-primary'}
            onClick={() => onConfirm(withReason ? reason.trim() : undefined)}
            disabled={isLoading || reasonInvalid}
          >
            {isLoading ? '처리 중…' : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
