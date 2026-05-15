/**
 * 도움말 툴팁 — `(?)` 아이콘에 hover 하면 설명 표시.
 * 짧은 안내 (한 두 줄) 용. 긴 설명은 별도 카드 권장.
 */
export default function HelpHint({ text, className = '' }: { text: string; className?: string }) {
  return (
    <span className={`inline-flex items-center group relative align-middle ${className}`}>
      <span
        className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-bf-border text-[10px] text-bf-muted cursor-help leading-none ml-1"
        aria-label="도움말"
      >
        ?
      </span>
      <span className="absolute left-1/2 -translate-x-1/2 top-5 w-56 px-2 py-1.5 bg-bf-fg text-bf-bg text-[11px] rounded shadow-lg opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity whitespace-pre-line z-30">
        {text}
      </span>
    </span>
  );
}
