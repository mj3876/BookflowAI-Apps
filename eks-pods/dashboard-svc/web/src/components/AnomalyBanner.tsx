/**
 * UX-8 이상 감지 배너 — Inventory 페이지 상단 위험 요약.
 *
 * 표시:
 *  - 결품 위치 수 (zero_count > 0 인 location 카운트) — 빨강
 *  - 부족 위치 수 (low_count > 0 인 location 카운트) — 주황
 *  - 24h SNS 급등 도서 수 — 보라 (z_score 임계 초과)
 *
 * 모두 0 이면 "정상" 상태 표시.
 */
type Tile = {
  count: number;
  label: string;
  hint: string;
  bg: string;
  fg: string;
  border: string;
  onClick?: () => void;
};

export default function AnomalyBanner({
  zeroLocations,
  lowLocations,
  spikes24h,
  onClickZero,
  onClickLow,
  onClickSpikes,
}: {
  zeroLocations: number;
  lowLocations: number;
  spikes24h: number;
  onClickZero?: () => void;
  onClickLow?: () => void;
  onClickSpikes?: () => void;
}) {
  const allClear = zeroLocations === 0 && lowLocations === 0 && spikes24h === 0;

  if (allClear) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-green-300 bg-green-50 text-green-900 px-3 py-2 text-sm">
        <span className="font-bold">✓</span>
        <span>위험 신호 없음 — 결품·부족·급등 도서 모두 정상 범위</span>
      </div>
    );
  }

  const tiles: Tile[] = [
    {
      count: zeroLocations,
      label: '결품 위치',
      hint: '재고 0 SKU 보유 위치',
      bg: 'bg-red-50',
      fg: 'text-red-900',
      border: 'border-red-300',
      onClick: onClickZero,
    },
    {
      count: lowLocations,
      label: '부족 위치',
      hint: '가용 ≤ 10 SKU 보유 위치',
      bg: 'bg-orange-50',
      fg: 'text-orange-900',
      border: 'border-orange-300',
      onClick: onClickLow,
    },
    {
      count: spikes24h,
      label: 'SNS 급등 도서',
      hint: '최근 24h z-score 임계 초과',
      bg: 'bg-purple-50',
      fg: 'text-purple-900',
      border: 'border-purple-300',
      onClick: onClickSpikes,
    },
  ];

  return (
    <div className="rounded-md border border-bf-warn bg-bf-warnbg/40 p-3">
      <div className="text-xs font-semibold text-bf-warn mb-2 flex items-center gap-1">
        <span>⚠</span>
        <span>이상 신호 감지</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {tiles.map((t) => (
          <button
            key={t.label}
            type="button"
            disabled={t.count === 0 || !t.onClick}
            className={`rounded-md border ${t.border} ${t.bg} ${t.fg} p-2 text-left disabled:opacity-50 ${t.onClick && t.count > 0 ? 'hover:brightness-95 cursor-pointer' : 'cursor-default'}`}
            onClick={t.onClick}
          >
            <div className="text-[11px] opacity-80">{t.label}</div>
            <div className="text-2xl font-bold leading-none mt-1">{t.count}</div>
            <div className="text-[10px] opacity-60 mt-1">{t.hint}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
