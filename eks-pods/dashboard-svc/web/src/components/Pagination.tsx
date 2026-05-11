/**
 * 페이징 공통 컴포넌트.
 *
 * <Pagination total={items.length} page={page} pageSize={20} onChange={setPage} />
 * - 1 / 2 / ... / N 페이지 번호 + Prev/Next + 현재 페이지 강조
 * - pageSize 기본 20
 */
type Props = {
  total: number;
  page: number;         // 1-based
  pageSize?: number;
  onChange: (page: number) => void;
  showInfo?: boolean;   // "X / Y 건" 표시
};

export default function Pagination({ total, page, pageSize = 20, onChange, showInfo = true }: Props) {
  const last = Math.max(1, Math.ceil(total / pageSize));
  const cur = Math.min(Math.max(1, page), last);

  if (total === 0) return null;

  const pages: (number | '...')[] = [];
  const add = (p: number | '...') => { if (pages[pages.length - 1] !== p) pages.push(p); };
  // 1 ... cur-1 cur cur+1 ... last
  add(1);
  if (cur - 2 > 2) add('...');
  for (let p = Math.max(2, cur - 1); p <= Math.min(last - 1, cur + 1); p++) add(p);
  if (cur + 2 < last - 1) add('...');
  if (last > 1) add(last);

  const start = (cur - 1) * pageSize + 1;
  const end = Math.min(cur * pageSize, total);

  return (
    <div className="flex items-center justify-between gap-3 text-xs mt-3">
      {showInfo ? (
        <div className="text-bf-muted">
          {start.toLocaleString()}–{end.toLocaleString()} / {total.toLocaleString()}건
        </div>
      ) : <div />}
      <div className="flex items-center gap-1">
        <button
          className="px-2 py-1 rounded border border-bf-border hover:bg-bf-panel2 disabled:opacity-40 disabled:hover:bg-transparent"
          disabled={cur === 1}
          onClick={() => onChange(cur - 1)}
        >
          ← 이전
        </button>
        {pages.map((p, i) =>
          p === '...' ? (
            <span key={`e${i}`} className="px-2 text-bf-muted">…</span>
          ) : (
            <button
              key={p}
              className={`px-2.5 py-1 rounded border ${
                p === cur
                  ? 'bg-bf-primary text-white border-bf-primary font-semibold'
                  : 'border-bf-border hover:bg-bf-panel2'
              }`}
              onClick={() => onChange(p)}
            >
              {p}
            </button>
          ),
        )}
        <button
          className="px-2 py-1 rounded border border-bf-border hover:bg-bf-panel2 disabled:opacity-40 disabled:hover:bg-transparent"
          disabled={cur === last}
          onClick={() => onChange(cur + 1)}
        >
          다음 →
        </button>
      </div>
    </div>
  );
}

/**
 * page slice helper — items.slice() 대신 사용 가능.
 *   const visible = pageSlice(items, page, 20);
 */
export function pageSlice<T>(items: T[], page: number, pageSize = 20): T[] {
  const start = Math.max(0, (page - 1) * pageSize);
  return items.slice(start, start + pageSize);
}
