import { useEffect, useMemo, useState } from 'react';
import { ko, ORDER_TYPE_KO, URGENCY_KO } from '../labels';

/**
 * BatchMapView — 일자별 batch 결과 지도형 시각화 (Approval / Decision / WhApprove / WhInstructions 공통).
 *
 * 사용자 요구 (2026-05-13):
 *   "일자별 상세 + 지도형 view 가 있어야 한눈에 흐름이 보임."
 *
 * 디자인 (단순 좌·우 권역 그룹):
 *   ┌────────────────────────────────────────┐
 *   │            📦 출판사 (top)              │
 *   │             ↓ ↓                        │
 *   │  🏬 수도권 ←→ 🏬 영남                   │  (중앙 WH × 2)
 *   │   ↓ ↓ ↓        ↓ ↓ ↓                   │
 *   │   [매장 row1]   [매장 row2]             │  (bottom · wh_id 분기)
 *   │                            💻 온라인    │
 *   └────────────────────────────────────────┘
 *
 * - SVG viewBox 1000×600 으로 좌표 고정 · CSS 로 responsive scale.
 * - 화살표는 (source, target, order_type) triple 로 group · 두께 ∝ count · 색 by order_type.
 * - dominant status 가 REJECTED 면 점선.
 * - 화살표 click → 우측 drawer 슬라이드 · ESC / backdrop click 으로 close.
 */

export type MapItem = {
  order_id: string;
  order_type: string;            // REBALANCE | WH_TRANSFER | PUBLISHER_ORDER
  source_location_id: number | null;  // null = 출판사
  target_location_id: number | null;
  isbn13: string;
  title?: string | null;
  qty: number;
  urgency_level: string;
  status: string;                // PENDING / APPROVED / EXECUTED / REJECTED / AUTO_EXECUTED
  created_at: string;
  approved_at?: string | null;
};

type Props = {
  items: MapItem[];
  nameOf: (id: number | null) => string;
  whIdOf?: (locationId: number | null) => number | null;
};

// ── 색상 + 두께 helpers ────────────────────────────────────────────────────
const ORDER_TYPE_COLOR: Record<string, string> = {
  REBALANCE:       '#3b82f6',  // 파랑
  WH_TRANSFER:     '#f97316',  // 주황
  PUBLISHER_ORDER: '#22c55e',  // 초록
};

function arrowColor(orderType: string): string {
  return ORDER_TYPE_COLOR[orderType] ?? '#6b7280';
}

function arrowWidth(count: number): number {
  // 1 ~ 8 px 사이 · log scale (count 1 → 1.5, 10 → 4.8, 100 → 8)
  return Math.min(8, Math.max(1.5, 1 + Math.log2(count) * 1.2));
}

// ── 노드 좌표 (SVG viewBox 1000 × 600 기준) ────────────────────────────────
type NodePos = { x: number; y: number; w: number; h: number };

const PUBLISHER_POS: NodePos = { x: 460, y: 30,  w: 120, h: 44 };
const WH1_POS: NodePos       = { x: 200, y: 220, w: 160, h: 56 };
const WH2_POS: NodePos       = { x: 640, y: 220, w: 160, h: 56 };

// 매장 노드 한 줄 layout · wh1 좌측 · wh2 우측 · 온라인 별도 우하단
const STORE_W = 80;
const STORE_H = 36;
const STORE_ROW_Y = 470;
const ONLINE_AREA_X = 700;
const ONLINE_AREA_Y = 540;

// 화살표 끝점 = 노드 경계의 중점 (간략화: 사각형 중심 → 중심)
function centerOf(p: NodePos): { x: number; y: number } {
  return { x: p.x + p.w / 2, y: p.y + p.h / 2 };
}

// ── helper ─────────────────────────────────────────────────────────────────
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

// ── 매장 분류 (fallback: wh_id 모르면 location_id mod 2 로 분배) ───────────
function classifyStores(
  ids: number[],
  whIdOf: ((id: number | null) => number | null) | undefined,
): { wh1: number[]; wh2: number[]; online: number[] } {
  const wh1: number[] = [];
  const wh2: number[] = [];
  const online: number[] = [];
  for (const id of ids) {
    // 온라인 매장: location_id 가 50 이상이면 online 으로 추정 (seed convention) · 명시적 hook 없음
    // → 보수적으로 모두 wh 매장으로 처리 · 호출자가 별도 online prop 안 주는 한 분류 불가
    const wh = whIdOf ? whIdOf(id) : null;
    if (wh === 1) wh1.push(id);
    else if (wh === 2) wh2.push(id);
    else {
      // fallback: id mod 2
      if (id % 2 === 1) wh1.push(id); else wh2.push(id);
    }
  }
  return { wh1, wh2, online };
}

export default function BatchMapView({ items, nameOf, whIdOf }: Props) {
  // ── 1. 등장하는 location_id 수집 ──────────────────────────────────────
  const { storePositions, edges, hasPublisher } = useMemo(() => {
    const storeIds = new Set<number>();
    let hasPub = false;
    for (const it of items) {
      if (it.source_location_id == null) hasPub = true;
      else if (it.source_location_id !== -1) storeIds.add(it.source_location_id);
      if (it.target_location_id != null) storeIds.add(it.target_location_id);
    }
    // wh location_id (1번/2번 wh 자체) 는 store list 에서 분리
    // → wh_id 가 null 이면 type 추정 불가 · 임시로 location_id ≤ 2 면 wh 로 본다? 안전하지 않음.
    // 보수적 처리: WH1_POS / WH2_POS 는 location_id 가 아니라 권역 자체. wh_id (1 or 2) 로만 매핑.
    // batch row 의 source/target 이 wh location_id 인 경우 → whIdOf 가 그 location 을 1/2 로 매핑해야 함.
    // 여기선 storeIds 에 들어간 id 중 whIdOf 결과가 본인과 같은 wh "거점" 이면 wh 노드로 흡수.

    // wh 거점 노드 id 추출 (location_type 정보 없으니 whIdOf 만으로 판단 불가)
    // → 호출자가 nameOf 로 '수도권 거점창고' 같은 라벨 줄 것이므로,
    //   여기선 source/target id 가 1/2 (seed convention) 인 row 를 wh 노드로 매핑.
    // simplification: location_id === 100/200 같은 WH seed 가 별도 있을 수도 있어, wh node 결정은 nameOf
    // 결과 문자열에 '거점창고' 포함 여부로 추정.
    const whNodeIds = new Map<number, 1 | 2>();
    for (const id of storeIds) {
      const wh = whIdOf ? whIdOf(id) : null;
      const label = nameOf(id);
      const isWh = /거점창고|물류센터|WH|창고/.test(label);
      if (isWh && (wh === 1 || wh === 2)) {
        whNodeIds.set(id, wh);
      }
    }
    // wh node 는 store list 에서 제외
    for (const id of whNodeIds.keys()) storeIds.delete(id);

    // ── 매장 분류 ──
    const storeArr = Array.from(storeIds).sort((a, b) => a - b);
    // 온라인 매장 추정: name 에 '온라인' 포함 → 별도 cluster
    // 나머지는 whIdOf 또는 id mod 2 fallback 으로 wh1 / wh2 분배.
    const onlineIds: number[] = [];
    const offlineIds: number[] = [];
    for (const id of storeArr) {
      if (/온라인/.test(nameOf(id))) onlineIds.push(id);
      else offlineIds.push(id);
    }
    const { wh1: wh1Stores, wh2: wh2Stores } = classifyStores(offlineIds, whIdOf);
    const onlineStores = onlineIds;

    // ── 매장 좌표 계산 ──
    const positions = new Map<number, NodePos>();
    const placeRow = (ids: number[], xStart: number, xEnd: number, y: number) => {
      if (!ids.length) return;
      const slots = ids.length;
      const totalW = xEnd - xStart;
      const gap = slots > 1 ? (totalW - STORE_W) / (slots - 1) : 0;
      ids.forEach((id, i) => {
        const x = slots === 1 ? xStart + (totalW - STORE_W) / 2 : xStart + gap * i;
        positions.set(id, { x, y, w: STORE_W, h: STORE_H });
      });
    };
    placeRow(wh1Stores, 40,  400, STORE_ROW_Y);
    placeRow(wh2Stores, 540, 900, STORE_ROW_Y);

    // 온라인 매장: 우하단 cluster (가로 줄)
    onlineStores.forEach((id, i) => {
      const x = ONLINE_AREA_X + (i % 3) * (STORE_W + 10);
      const y = ONLINE_AREA_Y + Math.floor(i / 3) * (STORE_H + 8);
      positions.set(id, { x, y, w: STORE_W, h: STORE_H });
    });

    // wh node 좌표
    for (const [id, wh] of whNodeIds) {
      positions.set(id, wh === 1 ? WH1_POS : WH2_POS);
    }

    // ── 2. edge grouping ──
    type EdgeKey = string;
    const edgeMap = new Map<EdgeKey, MapItem[]>();
    const keyOf = (it: MapItem): EdgeKey =>
      `${it.source_location_id ?? 'PUB'}|${it.target_location_id ?? 'NULL'}|${it.order_type}`;
    for (const it of items) {
      const k = keyOf(it);
      const arr = edgeMap.get(k) ?? [];
      arr.push(it);
      edgeMap.set(k, arr);
    }
    const edgesArr = Array.from(edgeMap.entries()).map(([k, rows]) => {
      const first = rows[0];
      return {
        key: k,
        sourceId: first.source_location_id,
        targetId: first.target_location_id,
        orderType: first.order_type,
        rows,
        count: rows.length,
        totalQty: rows.reduce((s, r) => s + (r.qty ?? 0), 0),
        dominant: dominantStatus(rows),
      };
    });

    return { storePositions: positions, edges: edgesArr, hasPublisher: hasPub };
  }, [items, nameOf, whIdOf]);

  // ── 3. drawer state ──
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

  // ── 4. helper: 노드 좌표 lookup ──
  const posOf = (locId: number | null, orderType: string): NodePos | null => {
    if (locId == null) {
      // 출판사 (source 측 only, PUBLISHER_ORDER 한정)
      return orderType === 'PUBLISHER_ORDER' ? PUBLISHER_POS : null;
    }
    return storePositions.get(locId) ?? null;
  };

  if (items.length === 0) {
    return (
      <div className="card flex flex-col items-center justify-center py-16 text-bf-muted" style={{ minHeight: 500 }}>
        <div className="text-4xl mb-2 opacity-60" aria-hidden>🗺️</div>
        <div className="text-sm">선택된 일자에 이동 기록 없음</div>
      </div>
    );
  }

  // ── 5. 렌더링 ──
  return (
    <div className="card relative" style={{ minHeight: 500 }}>
      {/* legend */}
      <div className="flex items-center gap-3 mb-2 text-[11px] text-bf-muted flex-wrap">
        <span className="font-semibold text-bf-text">🗺️ 이동 흐름 지도</span>
        <span>· 화살표 클릭 시 책 상세</span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-1 rounded" style={{ background: ORDER_TYPE_COLOR.REBALANCE }} />
          지점 재분배
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-1 rounded" style={{ background: ORDER_TYPE_COLOR.WH_TRANSFER }} />
          권역 이동
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-1 rounded" style={{ background: ORDER_TYPE_COLOR.PUBLISHER_ORDER }} />
          출판사 발주
        </span>
        <span className="text-bf-muted">· 점선 = 거절 우세</span>
      </div>

      <svg
        viewBox="0 0 1000 620"
        className="w-full"
        style={{ height: 'auto', minHeight: 460, background: '#FAFBFC', borderRadius: 6 }}
        role="img"
        aria-label="batch 이동 흐름 지도"
      >
        {/* 화살표 marker 정의 (order_type 별 색) */}
        <defs>
          {Object.entries(ORDER_TYPE_COLOR).map(([ot, color]) => (
            <marker
              key={ot}
              id={`arrow-${ot}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 Z" fill={color} />
            </marker>
          ))}
        </defs>

        {/* ── edges ── */}
        {edges.map((e) => {
          const src = posOf(e.sourceId, e.orderType);
          const tgt = posOf(e.targetId, e.orderType);
          if (!src || !tgt) return null;
          const sc = centerOf(src);
          const tc = centerOf(tgt);
          // 양방향 (wh1↔wh2 같은) 화살표 시각 분리 위해 offset 살짝
          const hasReverse = edges.some(
            (other) =>
              other.key !== e.key &&
              other.sourceId === e.targetId &&
              other.targetId === e.sourceId &&
              other.orderType === e.orderType,
          );
          const dx = tc.x - sc.x;
          const dy = tc.y - sc.y;
          const len = Math.max(1, Math.hypot(dx, dy));
          // perpendicular unit vector
          const px = -dy / len;
          const py = dx / len;
          const offset = hasReverse ? 6 : 0;
          const x1 = sc.x + px * offset;
          const y1 = sc.y + py * offset;
          const x2 = tc.x + px * offset;
          const y2 = tc.y + py * offset;
          const isRejected = e.dominant === 'REJECTED';
          const color = arrowColor(e.orderType);
          const sw = arrowWidth(e.count);
          const isSelected = selectedKey === e.key;
          return (
            <g
              key={e.key}
              style={{ cursor: 'pointer' }}
              onClick={() => setSelectedKey(e.key)}
            >
              {/* 두꺼운 hit area (투명) */}
              <line
                x1={x1} y1={y1} x2={x2} y2={y2}
                stroke="transparent"
                strokeWidth={Math.max(14, sw + 10)}
              />
              <line
                x1={x1} y1={y1} x2={x2} y2={y2}
                stroke={color}
                strokeWidth={sw}
                strokeDasharray={isRejected ? '6 4' : undefined}
                strokeOpacity={isSelected ? 1 : 0.85}
                markerEnd={`url(#arrow-${e.orderType})`}
              />
              {/* 카운트 라벨 */}
              <g>
                <circle
                  cx={(x1 + x2) / 2}
                  cy={(y1 + y2) / 2}
                  r={11}
                  fill="white"
                  stroke={color}
                  strokeWidth={isSelected ? 2 : 1}
                />
                <text
                  x={(x1 + x2) / 2}
                  y={(y1 + y2) / 2 + 4}
                  textAnchor="middle"
                  fontSize="11"
                  fontWeight="600"
                  fill={color}
                >
                  {e.count}
                </text>
              </g>
            </g>
          );
        })}

        {/* ── 출판사 노드 ── */}
        {hasPublisher && (
          <g>
            <rect
              x={PUBLISHER_POS.x}
              y={PUBLISHER_POS.y}
              width={PUBLISHER_POS.w}
              height={PUBLISHER_POS.h}
              rx={8}
              fill="#FFFFFF"
              stroke="#22c55e"
              strokeWidth={1.5}
            />
            <text
              x={PUBLISHER_POS.x + PUBLISHER_POS.w / 2}
              y={PUBLISHER_POS.y + PUBLISHER_POS.h / 2 + 5}
              textAnchor="middle"
              fontSize="13"
              fontWeight="600"
              fill="#212529"
            >
              📦 출판사
            </text>
          </g>
        )}

        {/* ── WH 노드 × 2 ── */}
        {[
          { pos: WH1_POS, label: '🏬 수도권 거점' },
          { pos: WH2_POS, label: '🏬 영남 거점' },
        ].map(({ pos, label }) => (
          <g key={label}>
            <rect
              x={pos.x}
              y={pos.y}
              width={pos.w}
              height={pos.h}
              rx={8}
              fill="#FFFFFF"
              stroke="#3b82f6"
              strokeWidth={1.5}
            />
            <text
              x={pos.x + pos.w / 2}
              y={pos.y + pos.h / 2 + 5}
              textAnchor="middle"
              fontSize="13"
              fontWeight="600"
              fill="#212529"
            >
              {label}
            </text>
          </g>
        ))}

        {/* ── 매장 노드 ── */}
        {Array.from(storePositions.entries()).map(([id, pos]) => {
          // wh 노드 좌표와 일치하면 skip (이미 위에서 그렸음)
          if (pos === WH1_POS || pos === WH2_POS) return null;
          const label = nameOf(id);
          const short = label.length > 6 ? label.slice(0, 5) + '…' : label;
          return (
            <g key={id}>
              <rect
                x={pos.x}
                y={pos.y}
                width={pos.w}
                height={pos.h}
                rx={6}
                fill="#FFFFFF"
                stroke="#6b7280"
                strokeWidth={1}
              />
              <text
                x={pos.x + pos.w / 2}
                y={pos.y + pos.h / 2 + 4}
                textAnchor="middle"
                fontSize="11"
                fill="#212529"
              >
                {short}
              </text>
            </g>
          );
        })}
      </svg>

      {/* ── drawer ── */}
      {selectedEdge && (
        <>
          <div
            className="fixed inset-0 bg-black/50 z-40"
            onClick={() => setSelectedKey(null)}
            aria-hidden
          />
          <div
            className="fixed inset-y-0 right-0 w-96 bg-bf-bg border-l border-bf-border z-50 overflow-y-auto shadow-2xl"
            role="dialog"
            aria-modal="true"
          >
            <div className="sticky top-0 bg-bf-bg border-b border-bf-border px-4 py-3 flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-bf-text">
                  {selectedEdge.sourceId == null ? '출판사' : nameOf(selectedEdge.sourceId)}
                  {' → '}
                  {selectedEdge.targetId == null ? '-' : nameOf(selectedEdge.targetId)}
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
        </>
      )}
    </div>
  );
}
