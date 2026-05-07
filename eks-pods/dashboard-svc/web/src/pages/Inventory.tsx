import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { fetchInventoryHeatmap, fetchSpikeEvents, type LocationCell, type Role, type SpikeEvent } from '../api';
import AnomalyBanner from '../components/AnomalyBanner';
import EmptyState from '../components/EmptyState';
import HelpHint from '../components/HelpHint';

/**
 * UX-8 전사 재고 + 이상 감지 — 본사 KPI/Inventory 페이지.
 *
 * 상단: AnomalyBanner (결품 위치 / 부족 위치 / 24h SNS 급등 카운트)
 *   - 클릭 시 해당 섹션으로 자동 스크롤 (UX-8 드릴다운)
 * 메트릭 카드 4개
 * 권역별 위치 카드 (수도권 / 영남)
 * SNS 급등 도서 패널
 */
export default function Inventory() {
  const { role } = useOutletContext<{ role: Role }>();
  const heat = useQuery({ queryKey: ['inv-heatmap', role], queryFn: () => fetchInventoryHeatmap(role), refetchInterval: 8000 });
  const spike = useQuery({ queryKey: ['spike-24h', role], queryFn: () => fetchSpikeEvents(role, 20), refetchInterval: 30000 });

  const items = heat.data?.items ?? [];
  const totalSku = items.reduce((s, c) => s + c.sku_count, 0);
  const totalQty = items.reduce((s, c) => s + c.total_qty, 0);
  const totalLow = items.reduce((s, c) => s + c.low_count, 0);
  const totalZero = items.reduce((s, c) => s + c.zero_count, 0);

  // AnomalyBanner 입력: 위치 단위 카운트 (location 1개라도 zero/low 면 카운트)
  const zeroLocations = items.filter((c) => c.zero_count > 0).length;
  const lowLocations = items.filter((c) => c.low_count > 0).length;

  // 최근 24h spike 만 (서버 응답은 최신순 20개) — 여기서 클라이언트 필터
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const spikes24h = (spike.data?.items ?? []).filter((s) => Date.parse(s.detected_at) >= cutoff);

  // 드릴다운 — 섹션 ref + scroll
  const refWh = useRef<HTMLDivElement | null>(null);
  const refSpike = useRef<HTMLDivElement | null>(null);
  const [highlightFilter, setHighlightFilter] = useState<'zero' | 'low' | null>(null);
  const scrollTo = (ref: React.MutableRefObject<HTMLDivElement | null>, filter: 'zero' | 'low' | null) => {
    setHighlightFilter(filter);
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const byWh = (whId: number | null) => items.filter((c) => c.wh_id === whId);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="h1">전사 재고 현황</h1>
        <p className="text-bf-muted text-xs mt-1">14개 위치 · 보유/예약/부족 한눈 보기 · 8초 자동 갱신</p>
      </div>

      <AnomalyBanner
        zeroLocations={zeroLocations}
        lowLocations={lowLocations}
        spikes24h={spikes24h.length}
        onClickZero={() => scrollTo(refWh, 'zero')}
        onClickLow={() => scrollTo(refWh, 'low')}
        onClickSpikes={() => scrollTo(refSpike, null)}
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="metric-card">
          <div className="metric-label flex items-center">총 SKU<HelpHint text="현재 등록된 (위치 × 도서) 조합 수. 14 위치 × 1000책 ≒ 14000 SKU." /></div>
          <div className="metric-value">{totalSku.toLocaleString()}</div>
          <div className="text-[10px] text-bf-muted mt-1">위치 × 도서 조합</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">총 보유 수량</div>
          <div className="metric-value">{totalQty.toLocaleString()}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label flex items-center">재고 부족<HelpHint text="가용 (on_hand - reserved) ≤ 10 인 SKU 의 위치별 합." /></div>
          <div className="metric-value text-bf-warn">{totalLow.toLocaleString()}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label flex items-center">완전 소진<HelpHint text="on_hand = 0 인 SKU 의 위치별 합. 즉시 발주 필요." /></div>
          <div className="metric-value text-bf-danger">{totalZero.toLocaleString()}</div>
        </div>
      </div>

      <div ref={refWh}>
        {highlightFilter && (
          <div className="text-xs text-bf-muted mb-2">
            드릴다운: {highlightFilter === 'zero' ? '결품' : '부족'} 위치 강조 표시 중 ·
            <button className="ml-2 underline" onClick={() => setHighlightFilter(null)}>전체 보기</button>
          </div>
        )}
        <WarehouseSection title="수도권 권역 (창고 1)" cells={byWh(1)} highlightFilter={highlightFilter} />
        <WarehouseSection title="영남 권역 (창고 2)" cells={byWh(2)} highlightFilter={highlightFilter} />
      </div>

      <div ref={refSpike} className="card">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="h2">SNS 급등 도서 (최근 24h)<HelpHint text="spike-detect Lambda 가 z-score 임계 초과 시 발생. 여기 표시된 도서는 수요 급변 가능성 높음." /></h2>
          <span className="text-xs text-bf-muted">{spikes24h.length}건 감지</span>
        </div>
        {spikes24h.length === 0 && (
          <EmptyState icon="📈" message="최근 24h SNS 급등 도서 없음" hint="z-score 임계 미만 — 정상 범위" />
        )}
        {spikes24h.length > 0 && (
          <table className="data-table">
            <thead>
              <tr><th>감지 시각</th><th>ISBN</th><th>제목</th><th>저자</th><th className="text-right">z-score</th><th className="text-right">언급수</th></tr>
            </thead>
            <tbody>
              {spikes24h.slice(0, 10).map((s: SpikeEvent) => (
                <tr key={s.event_id}>
                  <td className="text-bf-muted">{new Date(s.detected_at).toLocaleString('ko-KR')}</td>
                  <td className="font-mono text-[11px]">{s.isbn13}</td>
                  <td>{s.title ?? '-'}</td>
                  <td>{s.author ?? '-'}</td>
                  <td className="text-right font-mono">{s.z_score?.toFixed(2) ?? '-'}</td>
                  <td className="text-right">{s.mentions_count?.toLocaleString() ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function WarehouseSection({
  title,
  cells,
  highlightFilter,
}: {
  title: string;
  cells: LocationCell[];
  highlightFilter: 'zero' | 'low' | null;
}) {
  if (cells.length === 0) return null;
  // 필터 모드: 해당 항목 위치만 dim 해제 (전체 표시는 유지하되 강조만 변경)
  const matchesFilter = (c: LocationCell): boolean => {
    if (!highlightFilter) return true;
    if (highlightFilter === 'zero') return c.zero_count > 0;
    return c.low_count > 0;
  };
  const maxQty = Math.max(1, ...cells.map((c) => c.total_qty));
  return (
    <div className="card mb-3">
      <h2 className="h2 mb-3">{title}</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {cells.map((c) => {
          const intensity = c.total_qty / maxQty;
          const dimmed = highlightFilter !== null && !matchesFilter(c);
          const rowsClass =
            c.zero_count > 0 ? 'border-bf-danger' :
            c.low_count > 5  ? 'border-bf-warn'   : 'border-bf-border';
          return (
            <div
              key={c.location_id}
              className={`card-tight border-l-4 ${rowsClass} transition-opacity ${dimmed ? 'opacity-30' : 'opacity-100'}`}
            >
              <div className="flex items-start justify-between mb-2">
                <div>
                  <div className="text-sm font-semibold">{c.name ?? `위치 #${c.location_id}`}</div>
                  <div className="text-[10px] text-bf-muted">위치 #{c.location_id} · {c.location_type ?? '-'} · {c.region ?? '-'}</div>
                </div>
                <span className={
                  c.zero_count > 0 ? 'pill-rejected' :
                  c.low_count > 5  ? 'pill-pending'  : 'pill-approved'
                }>
                  {c.zero_count > 0 ? '주의' : c.low_count > 5 ? '경고' : '정상'}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div>
                  <div className="text-[10px] text-bf-muted">SKU</div>
                  <div className="text-sm font-semibold">{c.sku_count}</div>
                </div>
                <div>
                  <div className="text-[10px] text-bf-muted">보유</div>
                  <div className="text-sm font-semibold">{c.total_qty.toLocaleString()}</div>
                </div>
                <div>
                  <div className="text-[10px] text-bf-muted">부족</div>
                  <div className={`text-sm font-semibold ${c.low_count > 0 ? 'text-bf-warn' : ''}`}>{c.low_count}</div>
                </div>
              </div>
              <div className="mt-2 h-1.5 bg-bf-bg rounded overflow-hidden">
                <div className="h-full bg-bf-primary" style={{ width: `${intensity * 100}%` }}></div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
