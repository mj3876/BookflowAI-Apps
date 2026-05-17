// 매출 시계열 차트용 시간 granularity 세그먼트 토글 (분/시간/일).
// 본사 KPI · 물류센터 · 지점 매출 페이지 공용.
import { type Granularity } from '../api';

const OPTS: { key: Granularity; label: string }[] = [
  { key: 'minute', label: '분' },
  { key: 'hour', label: '시간' },
  { key: 'day', label: '일' },
];

export function GranularityToggle({
  value, onChange,
}: {
  value: Granularity;
  onChange: (v: Granularity) => void;
}) {
  return (
    <div className="bf-seg">
      {OPTS.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={`bf-seg-btn ${value === o.key ? 'bf-seg-btn-on' : ''}`}
        >{o.label}</button>
      ))}
    </div>
  );
}
