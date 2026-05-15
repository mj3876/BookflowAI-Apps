import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ko, ORDER_TYPE_KO, URGENCY_KO } from '../labels';

/**
 * BatchMapView v2 (2026-05-13 사용자 피드백):
 *   "지도도 다 겹치게 만들거면 왜 만드냐. 좀 제대로 만들어라 현대적인 디자인으로 좀 간지나게"
 *
 * 새 구조:
 *   ┌──────────────────────────────────────────────────┐
 *   │ 📦 외부 │ 🌆 수도권 │ 🌊 영남 │ 💻 온라인         │   (CSS Grid 4-col)
 *   │ 출판사  │ WH1       │ WH2     │ 온라인 매장들      │
 *   │         │ + 매장들  │ + 매장들 │                  │
 *   └──────────────────────────────────────────────────┘
 *   엣지: SVG overlay (DOM 좌표 측정 후 viewBox 정규화) · 노드 겹침 0.
 *
 * 디자인 요소:
 *   - bg gradient · panel backdrop blur · 노드 카드 hover scale + glow
 *   - 엣지 linear gradient · 색별 마커 · 점선 = 거절 우세
 *   - count badge: 다크 배경 + 컬러 테두리
 *   - drawer: backdrop blur + 슬라이드 진입
 */

export type MapItem = {
  order_id: string;
  order_type: string;
  source_location_id: number | null;
  target_location_id: number | null;
  isbn13: string;
  title?: string | null;
  qty: number;
  urgency_level: string;
  status: string;
  created_at: string;
  approved_at?: string | null;
};

type Props = {
  items: MapItem[];
  nameOf: (id: number | null) => string;
  whIdOf?: (locationId: number | null) => number | null;
};

const ORDER_TYPE_COLOR: Record<string, string> = {
  REBALANCE:       '#3b82f6',
  WH_TRANSFER:     '#f97316',
  PUBLISHER_ORDER: '#22c55e',
};
const ORDER_TYPE_COLOR_LIGHT: Record<string, string> = {
  REBALANCE:       '#60a5fa',
  WH_TRANSFER:     '#fdba74',
  PUBLISHER_ORDER: '#86efac',
};

function arrowColor(orderType: string): string {
  return ORDER_TYPE_COLOR[orderType] ?? '#6b7280';
}

function arrowWidth(count: number): number {
  return Math.min(7, Math.max(1.5, 1 + Math.log2(count) * 1.1));
}

function dominantStatus(rows: MapItem[]): string {
  const c: Record<string, number> = {};
  for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1;
  let best = ''; let max = -1;
  for (const [k, v] of Object.entries(c)) {
    if (v > max) { best = k; max = v; }
  }
  return best;
}

function fmtTime(iso: string): string {
  try { return new Date(iso).toLocaleString('ko-KR'); } catch { return iso; }
}

const PUBLISHER_KEY = 'PUBLISHER';

// ── NodeCard ───────────────────────────────────────────────────────────────
type NodeType = 'publisher' | 'wh' | 'store' | 'online';

function NodeCard({
  nodeId,
  label,
  icon,
  type,
  highlight,
  registerRef,
}: {
  nodeId: string;
  label: string;
  icon: string;
  type: NodeType;
  highlight?: boolean;
  registerRef: (id: string, el: HTMLDivElement | null) => void;
}) {
  const borderClass =
    type === 'wh' ? 'border-bf-primary/50' :
    type === 'publisher' ? 'border-emerald-500/50' :
    type === 'online' ? 'border-purple-400/50' :
    'border-bf-border/60';
  const hoverGlow =
    type === 'wh' ? 'hover:border-bf-primary hover:shadow-blue-500/20' :
    type === 'publisher' ? 'hover:border-emerald-400 hover:shadow-emerald-500/20' :
    type === 'online' ? 'hover:border-purple-400 hover:shadow-purple-500/20' :
    'hover:border-bf-primary/60';
  return (
    <div
      ref={(el) => registerRef(nodeId, el)}
      className={`relative w-full px-2.5 py-2 rounded-xl border bg-gradient-to-br from-bf-panel to-bf-panel2 shadow-md transition-all hover:scale-105 hover:shadow-lg ${borderClass} ${hoverGlow} ${highlight ? 'ring-2 ring-bf-primary/30' : ''}`}
    >
      <div className="text-lg text-center leading-none">{icon}</div>
      <div className="text-[11px] font-medium text-center mt-1 leading-tight text-bf-text whitespace-nowrap overflow-hidden text-ellipsis">
        {label}
      </div>
    </div>
  );
}

// ── 매장 분류 ──────────────────────────────────────────────────────────────
function classifyNodes(
  ids: number[],
  whIdOf: ((id: number | null) => number | null) | undefined,
  nameOf: (id: number) => string,
) {
  const wh1Stores: number[] = [];
  const wh2Stores: number[] = [];
  const onlineStores: number[] = [];
  for (const id of ids) {
    if (/온라인/.test(nameOf(id))) {
      onlineStores.push(id);
      continue;
    }
    const wh = whIdOf ? whIdOf(id) : null;
    if (wh === 1) wh1Stores.push(id);
    else if (wh === 2) wh2Stores.push(id);
    else {
      if (id % 2 === 1) wh1Stores.push(id); else wh2Stores.push(id);
    }
  }
  return { wh1Stores, wh2Stores, onlineStores };
}

export default function BatchMapView({ items, nameOf, whIdOf }: Props) {
  // ── 1. 노드 분류 ─────────────────────────────────────────────────────
  const { wh1Stores, wh2Stores, onlineStores, wh1Id, wh2Id, hasPublisher, edges } = useMemo(() => {
    const storeIds = new Set<number>();
    let hasPub = false;
    for (const it of items) {
      if (it.source_location_id == null) hasPub = true;
      else if (it.source_location_id !== -1) storeIds.add(it.source_location_id);
      if (it.target_location_id != null) storeIds.add(it.target_location_id);
    }

    // wh 거점 노드 식별 (name 에 거점창고 등 포함 + whIdOf 결과)
    const whNodeIds = new Map<number, 1 | 2>();
    for (const id of storeIds) {
      const wh = whIdOf ? whIdOf(id) : null;
      const label = nameOf(id);
      const isWh = /거점창고|물류센터|WH|창고/.test(label);
      if (isWh && (wh === 1 || wh === 2)) {
        whNodeIds.set(id, wh);
      }
    }
    for (const id of whNodeIds.keys()) storeIds.delete(id);
    let wh1: number | null = null;
    let wh2: number | null = null;
    for (const [id, wh] of whNodeIds) {
      if (wh === 1) wh1 = id; else wh2 = id;
    }

    const storeArr = Array.from(storeIds).sort((a, b) => a - b);
    const { wh1Stores, wh2Stores, onlineStores } = classifyNodes(storeArr, whIdOf, nameOf);

    // edges grouping
    type EdgeRow = {
      key: string;
      sourceKey: string;   // PUBLISHER | <locId>
      targetKey: string;
      orderType: string;
      rows: MapItem[];
      count: number;
      totalQty: number;
      dominant: string;
    };
    const edgeMap = new Map<string, MapItem[]>();
    const keyOf = (it: MapItem): string =>
      `${it.source_location_id ?? 'PUB'}|${it.target_location_id ?? 'NULL'}|${it.order_type}`;
    for (const it of items) {
      const k = keyOf(it);
      const arr = edgeMap.get(k) ?? [];
      arr.push(it);
      edgeMap.set(k, arr);
    }
    const edgesArr: EdgeRow[] = Array.from(edgeMap.entries()).map(([k, rows]) => {
      const first = rows[0];
      return {
        key: k,
        sourceKey: first.source_location_id == null ? PUBLISHER_KEY : String(first.source_location_id),
        targetKey: first.target_location_id == null ? 'NULL' : String(first.target_location_id),
        orderType: first.order_type,
        rows,
        count: rows.length,
        totalQty: rows.reduce((s, r) => s + (r.qty ?? 0), 0),
        dominant: dominantStatus(rows),
      };
    });

    return {
      wh1Stores,
      wh2Stores,
      onlineStores,
      wh1Id: wh1,
      wh2Id: wh2,
      hasPublisher: hasPub,
      edges: edgesArr,
    };
  }, [items, nameOf, whIdOf]);

  // ── 2. DOM 좌표 측정 ─────────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 1000, h: 680 });

  const registerRef = (id: string, el: HTMLDivElement | null) => {
    if (el) nodeRefs.current.set(id, el);
    else nodeRefs.current.delete(id);
  };

  const measure = () => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    setContainerSize({ w: rect.width, h: rect.height });
    const m = new Map<string, { x: number; y: number }>();
    nodeRefs.current.forEach((el, id) => {
      const r = el.getBoundingClientRect();
      m.set(id, {
        x: r.left - rect.left + r.width / 2,
        y: r.top - rect.top + r.height / 2,
      });
    });
    setPositions(m);
  };

  useLayoutEffect(() => {
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, wh1Stores.length, wh2Stores.length, onlineStores.length, hasPublisher]);

  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(() => measure());
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  // ── 3. drawer state ──────────────────────────────────────────────────
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selectedEdge = useMemo(
    () => edges.find((e) => e.key === selectedKey) ?? null,
    [edges, selectedKey],
  );

  useEffect(() => {
    if (!selectedKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedKey(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedKey]);

  // ── 4. empty state ───────────────────────────────────────────────────
  if (items.length === 0) {
    return (
      <div className="card flex flex-col items-center justify-center py-16 text-bf-muted" style={{ minHeight: 500 }}>
        <div className="text-4xl mb-2 opacity-60" aria-hidden>🗺️</div>
        <div className="text-sm">선택된 일자에 이동 기록 없음</div>
      </div>
    );
  }

  // ── 5. 엣지 path 계산 — 같은 (source,target,direction) edge 가 여러 개면 perpendicular offset 으로 분리
  // 양방향 (A→B, B→A) 은 perpendicular 부호가 자연 반전되어 자동 분리.
  // 같은 방향의 multi order_type (REBALANCE + WH_TRANSFER 등) 은 index/total 로 명시 분리.
  const directionGroups = new Map<string, string[]>();
  edges.forEach((e) => {
    const key = `${e.sourceKey}→${e.targetKey}`;
    if (!directionGroups.has(key)) directionGroups.set(key, []);
    directionGroups.get(key)!.push(e.key);
  });
  const edgeIndex = new Map<string, { index: number; total: number }>();
  directionGroups.forEach((keys) => {
    keys.forEach((k, i) => edgeIndex.set(k, { index: i, total: keys.length }));
  });

  const edgePath = (
    sx: number,
    sy: number,
    tx: number,
    ty: number,
    offsetIndex = 0,
    total = 1,
  ): string => {
    const dx = tx - sx;
    const dy = ty - sy;
    const dist = Math.hypot(dx, dy) || 1;
    // perpendicular unit vector
    const px = -dy / dist;
    const py = dx / dist;
    // index 가 center 중심으로 분포: [-1.5, -0.5, 0.5, 1.5] * SEPARATION 등
    const SEPARATION = 22;
    const off = (offsetIndex - (total - 1) / 2) * SEPARATION;
    const ox = px * off;
    const oy = py * off;
    const cOff = Math.min(140, Math.max(50, dist * 0.4));
    const s1x = sx + ox, s1y = sy + oy;
    const t1x = tx + ox, t1y = ty + oy;
    return `M ${s1x},${s1y} C ${s1x + cOff},${s1y} ${t1x - cOff},${t1y} ${t1x},${t1y}`;
  };

  return (
    <div
      ref={containerRef}
      className="relative w-full bg-gradient-to-br from-bf-bg via-bf-panel/30 to-bf-bg rounded-2xl p-5 overflow-hidden border border-bf-border/40 shadow-inner"
      style={{ minHeight: 680 }}
    >
      {/* Legend (우상단 floating) */}
      <div className="absolute top-3 right-3 z-20 bg-bf-panel/85 backdrop-blur-md rounded-lg border border-bf-border/60 px-3 py-2 text-[11px] shadow-lg">
        <div className="font-semibold text-bf-text mb-1.5">이동 유형</div>
        <div className="flex items-center gap-1.5 mb-1">
          <span className="inline-block w-4 h-0.5 rounded" style={{ background: ORDER_TYPE_COLOR.REBALANCE }} />
          <span className="text-bf-text">지점 재분배</span>
        </div>
        <div className="flex items-center gap-1.5 mb-1">
          <span className="inline-block w-4 h-0.5 rounded" style={{ background: ORDER_TYPE_COLOR.WH_TRANSFER }} />
          <span className="text-bf-text">권역 이동</span>
        </div>
        <div className="flex items-center gap-1.5 mb-1">
          <span className="inline-block w-4 h-0.5 rounded" style={{ background: ORDER_TYPE_COLOR.PUBLISHER_ORDER }} />
          <span className="text-bf-text">출판사 발주</span>
          <span className="text-[10px] text-emerald-500 ml-1" title="출판사 → 거점창고 → 매장 분배">lead time D+3</span>
        </div>
        <div className="mt-1.5 pt-1.5 border-t border-bf-border/40 text-bf-muted">
          점선 = 거절 우세 · 클릭 시 상세
        </div>
      </div>

      {/* Title */}
      <div className="mb-3">
        <div className="text-sm font-semibold text-bf-text">🗺️ 이동 흐름 지도</div>
        <div className="text-[11px] text-bf-muted">노드 4열 정렬 · 화살표 클릭 → 책 단위 상세</div>
      </div>

      {/* 4-column Grid · 노드들 */}
      <div ref={gridRef} className="grid grid-cols-4 gap-5 relative z-10" style={{ minHeight: 580 }}>
        {/* col 1: 외부 (출판사) */}
        <div className="flex flex-col items-center gap-3">
          <div className="text-[11px] text-bf-muted font-semibold tracking-wide uppercase">📦 외부</div>
          {hasPublisher ? (
            <NodeCard
              nodeId={PUBLISHER_KEY}
              label="출판사"
              icon="📚"
              type="publisher"
              registerRef={registerRef}
            />
          ) : (
            <div className="text-[10px] text-bf-muted/60 italic mt-3">발주 없음</div>
          )}
        </div>

        {/* col 2: 수도권 WH + 매장 */}
        <div className="flex flex-col items-center gap-3">
          <div className="text-[11px] text-bf-muted font-semibold tracking-wide uppercase">🌆 수도권</div>
          {wh1Id != null && (
            <NodeCard
              nodeId={String(wh1Id)}
              label={nameOf(wh1Id)}
              icon="🏬"
              type="wh"
              highlight
              registerRef={registerRef}
            />
          )}
          {wh1Stores.length > 0 && (
            <div className="grid grid-cols-2 gap-2 w-full">
              {wh1Stores.map((s) => (
                <NodeCard
                  key={s}
                  nodeId={String(s)}
                  label={nameOf(s)}
                  icon="🏪"
                  type="store"
                  registerRef={registerRef}
                />
              ))}
            </div>
          )}
        </div>

        {/* col 3: 영남 WH + 매장 */}
        <div className="flex flex-col items-center gap-3">
          <div className="text-[11px] text-bf-muted font-semibold tracking-wide uppercase">🌊 영남</div>
          {wh2Id != null && (
            <NodeCard
              nodeId={String(wh2Id)}
              label={nameOf(wh2Id)}
              icon="🏬"
              type="wh"
              highlight
              registerRef={registerRef}
            />
          )}
          {wh2Stores.length > 0 && (
            <div className="grid grid-cols-2 gap-2 w-full">
              {wh2Stores.map((s) => (
                <NodeCard
                  key={s}
                  nodeId={String(s)}
                  label={nameOf(s)}
                  icon="🏪"
                  type="store"
                  registerRef={registerRef}
                />
              ))}
            </div>
          )}
        </div>

        {/* col 4: 온라인 */}
        <div className="flex flex-col items-center gap-3">
          <div className="text-[11px] text-bf-muted font-semibold tracking-wide uppercase">💻 온라인</div>
          {onlineStores.length === 0 ? (
            <div className="text-[10px] text-bf-muted/60 italic mt-3">이동 없음</div>
          ) : (
            <div className="grid grid-cols-1 gap-2 w-full">
              {onlineStores.map((s) => (
                <NodeCard
                  key={s}
                  nodeId={String(s)}
                  label={nameOf(s)}
                  icon="💻"
                  type="online"
                  registerRef={registerRef}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* SVG overlay · 엣지 */}
      <svg
        className="absolute inset-0 w-full h-full pointer-events-none z-30"
        viewBox={`0 0 ${containerSize.w} ${containerSize.h}`}
        preserveAspectRatio="none"
        aria-hidden
      >
        <defs>
          {Object.entries(ORDER_TYPE_COLOR).map(([ot, color]) => (
            <linearGradient key={`grad-${ot}`} id={`grad-${ot}`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={color} stopOpacity="0.95" />
              <stop offset="100%" stopColor={ORDER_TYPE_COLOR_LIGHT[ot] ?? color} stopOpacity="0.75" />
            </linearGradient>
          ))}
          {Object.entries(ORDER_TYPE_COLOR).map(([ot, color]) => (
            <marker
              key={`arrow-${ot}`}
              id={`arrow-${ot}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 Z" fill={color} />
            </marker>
          ))}
        </defs>

        {edges.map((e) => {
          const src = positions.get(e.sourceKey);
          const tgt = positions.get(e.targetKey);
          if (!src || !tgt) return null;
          const isRejected = e.dominant === 'REJECTED';
          const sw = arrowWidth(e.count);
          const isSelected = selectedKey === e.key;
          const eIdx = edgeIndex.get(e.key) ?? { index: 0, total: 1 };
          const pathD = edgePath(src.x, src.y, tgt.x, tgt.y, eIdx.index, eIdx.total);
          // badge 위치도 같은 perpendicular offset 적용
          const dxe = tgt.x - src.x;
          const dye = tgt.y - src.y;
          const diste = Math.hypot(dxe, dye) || 1;
          const pxe = -dye / diste, pye = dxe / diste;
          const SEPARATION = 22;
          const off = (eIdx.index - (eIdx.total - 1) / 2) * SEPARATION;
          const midX = (src.x + tgt.x) / 2 + pxe * off;
          const midY = (src.y + tgt.y) / 2 + pye * off - 16;
          const color = arrowColor(e.orderType);
          return (
            <g
              key={e.key}
              className="pointer-events-auto cursor-pointer"
              onClick={() => setSelectedKey(e.key)}
            >
              {/* hit area (투명 · 클릭 hit-area 확대) */}
              <path d={pathD} stroke="transparent" strokeWidth={Math.max(22, sw + 18)} fill="none" />
              {/* visible stroke */}
              <path
                d={pathD}
                stroke={`url(#grad-${e.orderType})`}
                strokeWidth={isSelected ? sw + 1 : sw}
                strokeDasharray={isRejected ? '8 5' : undefined}
                strokeOpacity={isSelected ? 1 : 0.9}
                markerEnd={`url(#arrow-${e.orderType})`}
                fill="none"
                className="transition-all"
                style={{ filter: isSelected ? `drop-shadow(0 0 4px ${color})` : undefined }}
              />
              {/* count badge */}
              <g>
                <circle
                  cx={midX}
                  cy={midY}
                  r={12}
                  fill="#0f172a"
                  stroke={color}
                  strokeWidth={isSelected ? 2 : 1.5}
                />
                <text
                  x={midX}
                  y={midY + 4}
                  textAnchor="middle"
                  fontSize="11"
                  fontWeight="700"
                  fill="#e2e8f0"
                >
                  {e.count}
                </text>
              </g>
            </g>
          );
        })}
      </svg>

      {/* Drawer */}
      {selectedEdge && (
        <>
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 transition-opacity"
            onClick={() => setSelectedKey(null)}
            aria-hidden
          />
          <div
            className="fixed inset-y-0 right-0 w-[460px] max-w-[92vw] bg-bf-bg border-l border-bf-border z-50 overflow-y-auto shadow-2xl animate-[slideIn_0.2s_ease-out]"
            role="dialog"
            aria-modal="true"
            style={{
              animation: 'slideIn 0.2s ease-out',
            }}
          >
            <div className="sticky top-0 bg-bf-bg/95 backdrop-blur border-b border-bf-border px-4 py-3 flex items-center justify-between z-10">
              <div>
                <div className="text-sm font-semibold text-bf-text">
                  {selectedEdge.sourceKey === PUBLISHER_KEY
                    ? '📦 출판사'
                    : nameOf(Number(selectedEdge.sourceKey))}
                  {' → '}
                  {selectedEdge.targetKey === 'NULL'
                    ? '-'
                    : nameOf(Number(selectedEdge.targetKey))}
                </div>
                <div className="text-[11px] text-bf-muted mt-0.5">
                  {selectedEdge.count}건 · 총 {selectedEdge.totalQty}권 ·{' '}
                  <span style={{ color: arrowColor(selectedEdge.orderType) }}>
                    {ko(ORDER_TYPE_KO, selectedEdge.orderType)}
                  </span>
                </div>
              </div>
              <button
                className="text-bf-muted hover:text-bf-text text-lg leading-none px-2"
                onClick={() => setSelectedKey(null)}
                aria-label="닫기"
              >
                ✕
              </button>
            </div>

            <table className="data-table">
              <thead>
                <tr>
                  <th>처리시각</th>
                  <th>ISBN</th>
                  <th>제목</th>
                  <th className="text-right">수량</th>
                  <th>긴급도</th>
                  <th>상태</th>
                </tr>
              </thead>
              <tbody>
                {selectedEdge.rows.map((r) => (
                  <tr key={r.order_id}>
                    <td className="text-bf-muted text-[11px]">
                      {fmtTime(r.approved_at ?? r.created_at)}
                    </td>
                    <td className="font-mono text-[11px]">{r.isbn13}</td>
                    <td>{r.title ?? '-'}</td>
                    <td className="text-right">{r.qty}권</td>
                    <td>
                      <span
                        className={
                          r.urgency_level === 'CRITICAL' ? 'pill-rejected' :
                          r.urgency_level === 'URGENT'   ? 'pill-pending' : 'pill-info'
                        }
                      >
                        {ko(URGENCY_KO, r.urgency_level)}
                      </span>
                    </td>
                    <td>
                      <span
                        className={
                          r.status === 'REJECTED' ? 'pill-rejected' :
                          r.status === 'APPROVED' ? 'pill-approved' :
                          r.status === 'EXECUTED' ? 'pill-approved' :
                          r.status === 'AUTO_EXECUTED' ? 'pill-info' :
                          'pill-pending'
                        }
                      >
                        {r.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <style>{`
            @keyframes slideIn {
              from { transform: translateX(100%); opacity: 0; }
              to   { transform: translateX(0);    opacity: 1; }
            }
          `}</style>
        </>
      )}
    </div>
  );
}
