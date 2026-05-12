/**
 * D5-3 Toast — 화면 우측 상단 floating 알림 stack.
 *
 * 사용:
 *   const { showToast } = useToast();
 *   showToast({ type: 'success', message: '승인 완료' });
 *   showToast({ type: 'error', message: e.message, details: e.requestId });
 *
 * App root 에 <ToastProvider> 로 wrap.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export type ToastItem = {
  id: number;
  type: ToastType;
  message: string;
  details?: string;
  autoDismissMs?: number;
};

type ToastContextValue = {
  showToast: (t: Omit<ToastItem, 'id'>) => void;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be inside <ToastProvider>');
  return ctx;
}

const DEFAULT_DISMISS: Record<ToastType, number> = {
  success: 3500,
  info: 3500,
  warning: 6000,
  error: 7000,
};

const TYPE_STYLE: Record<ToastType, { bg: string; border: string; text: string; icon: string }> = {
  success: { bg: 'bg-green-50',  border: 'border-green-400',  text: 'text-green-900',  icon: '✅' },
  info:    { bg: 'bg-blue-50',   border: 'border-blue-400',   text: 'text-blue-900',   icon: 'ℹ️' },
  warning: { bg: 'bg-yellow-50', border: 'border-yellow-400', text: 'text-yellow-900', icon: '⚠️' },
  error:   { bg: 'bg-red-50',    border: 'border-red-500',    text: 'text-red-900',    icon: '🛑' },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback((t: Omit<ToastItem, 'id'>) => {
    const id = ++seq.current;
    setItems((prev) => [...prev, { ...t, id }]);
  }, []);

  return (
    <ToastContext.Provider value={{ showToast, dismiss }}>
      {children}
      <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 min-w-[280px] max-w-[420px] pointer-events-none">
        {items.map((t) => (
          <ToastView key={t.id} item={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const tone = TYPE_STYLE[item.type];
  const ttl = item.autoDismissMs ?? DEFAULT_DISMISS[item.type];

  useEffect(() => {
    if (ttl <= 0) return;
    const t = setTimeout(() => onDismiss(item.id), ttl);
    return () => clearTimeout(t);
  }, [item.id, ttl, onDismiss]);

  return (
    <div className={`pointer-events-auto p-3 rounded-md border-2 shadow-lg ${tone.bg} ${tone.border} ${tone.text} text-xs animate-slide-in-right`}>
      <div className="flex items-start gap-2">
        <span className="text-base leading-none">{tone.icon}</span>
        <div className="flex-1">
          <div className="font-semibold">{item.message}</div>
          {item.details && <div className="mt-1 text-[10px] opacity-70 font-mono">{item.details}</div>}
        </div>
        <button
          onClick={() => onDismiss(item.id)}
          className="ml-1 opacity-50 hover:opacity-100 text-[14px] leading-none"
          title="닫기"
        >
          ×
        </button>
      </div>
    </div>
  );
}
