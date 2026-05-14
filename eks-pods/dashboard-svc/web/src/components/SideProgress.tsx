/**
 * SideProgress — 양측 협의 (REBALANCE / WH_TRANSFER) 의 SOURCE/TARGET 진행 시각화.
 *
 * UI:
 *   [강남점 ✓] ─🚚→ [잠실점 ⏳]
 *    SOURCE done       TARGET pending
 *
 * 자기 측 (mySide) 은 굵게/border 강조.
 */

type Side = {
  name: string;
  done: boolean;
};

type Props = {
  source: Side;
  target: Side;
  /** 자기 측 강조 (mySide === 'SOURCE' 면 source 박스 강조) */
  mySide?: 'SOURCE' | 'TARGET' | null;
  className?: string;
};

export default function SideProgress({ source, target, mySide, className = '' }: Props) {
  const sourceMine = mySide === 'SOURCE';
  const targetMine = mySide === 'TARGET';

  const sideBox = (s: Side, isMine: boolean) => {
    const borderTone = isMine
      ? 'border-bf-primary bg-bf-primary/5'
      : s.done
        ? 'border-green-300 bg-bf-successbg/60'
        : 'border-bf-border bg-bf-panel2';
    const textTone = isMine ? 'font-bold text-bf-primary' : s.done ? 'text-bf-success font-medium' : 'text-bf-muted';
    return (
      <div className={`inline-flex items-center gap-1 px-2 py-1 rounded border ${borderTone}`}>
        <span className={`text-[11px] ${textTone}`}>{s.name}</span>
        <span className="text-[11px]" aria-hidden>{s.done ? '✓' : '⏳'}</span>
      </div>
    );
  };

  // 화살표 — 양측 done 이면 🚚 (운송중), 아니면 ─ (점선)
  const bothDone = source.done && target.done;
  const arrow = bothDone ? '─🚚→' : source.done ? '─→' : '⋯→';

  return (
    <div className={`inline-flex items-center gap-1.5 ${className}`}>
      {sideBox(source, sourceMine)}
      <span className="text-bf-muted text-[11px]" aria-hidden>{arrow}</span>
      {sideBox(target, targetMine)}
    </div>
  );
}
