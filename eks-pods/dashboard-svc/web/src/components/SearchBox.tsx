import { useEffect, useState } from 'react';

/**
 * 검색 입력 박스 — 300ms debounce + clear 버튼.
 *
 * 사용:
 *   <SearchBox placeholder="ISBN / 제목 / 매장 검색…" onSearch={setQ} />
 * onSearch 는 debounced 값으로 호출됨. 빈 문자열 ("") 도 호출 → 검색 해제.
 */
type Props = {
  placeholder?: string;
  onSearch: (q: string) => void;
  initial?: string;
  /** debounce 지연 (ms) · default 300 */
  debounceMs?: number;
};

export default function SearchBox({
  placeholder = '검색…',
  onSearch,
  initial = '',
  debounceMs = 300,
}: Props) {
  const [value, setValue] = useState(initial);

  useEffect(() => {
    const t = setTimeout(() => onSearch(value.trim()), debounceMs);
    return () => clearTimeout(t);
    // onSearch 가 부모에서 매 렌더 새로 생기는 경우 → deps 에 안 넣음 (value 만 변화 트리거)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, debounceMs]);

  return (
    <div className="relative inline-flex items-center">
      <input
        type="text"
        className="ipt pl-7 pr-7 text-xs w-56"
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <span className="absolute left-2 text-bf-muted text-xs pointer-events-none" aria-hidden>
        🔍
      </span>
      {value && (
        <button
          type="button"
          className="absolute right-2 text-bf-muted hover:text-bf-text text-xs"
          onClick={() => setValue('')}
          aria-label="검색어 지우기"
          title="검색어 지우기"
        >
          ✕
        </button>
      )}
    </div>
  );
}
