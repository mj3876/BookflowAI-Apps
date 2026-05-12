import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { fetchPending, type PendingOrder, type Role } from '../api';
import { ko, ORDER_STATUS_KO, URGENCY_KO, whName } from '../labels';
import { useLocations } from '../useLocations';

/**
 * 권역 이동 - 2단계 SOURCE/TARGET 이중 승인 시나리오 (.pen C-1~C-4).
 * pending_orders 중 order_type='WH_TRANSFER' 만 필터.
 *
 * UX-4: row 클릭 시 forecast_rationale 펼침 — Stage 2 partner_surplus 계산 내역 표시 (FR-A5.3 / A5.6).
 */

type Rationale = NonNullable<PendingOrder['forecast_rationale']>;

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'number') return v.toLocaleString();
  return String(v);
}

function RationaleDetail({ r, qty }: { r: Rationale; qty: number }) {
  const stage = r.stage as number | undefined;
  const partnerSurplus = r.partner_surplus as number | undefined;
  return (
    <div className="bg-bf-card border border-bf-border rounded-md p-3 text-xs">
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-bf-fg font-semibold">의사결정 근거 (Stage {stage ?? '?'})</div>
        <div className="text-bf-muted">요청 수량 {qty.toLocaleString()}권</div>
      </div>
      {stage === 2 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <div><div className="text-bf-muted text-[10px]">출발 권역</div><div className="font-mono">{whName((r.partner_wh as number) ?? 0)}</div></div>
          <div><div className="text-bf-muted text-[10px]">출발 보유</div><div className="font-mono">{fmt(r.partner_on_hand)}</div></div>
          <div><div className="text-bf-muted text-[10px]">예약 분</div><div className="font-mono">{fmt(r.partner_reserved)}</div></div>
          <div><div className="text-bf-muted text-[10px]">안전재고</div><div className="font-mono">{fmt(r.partner_safety)}</div></div>
          <div><div className="text-bf-muted text-[10px]">14일 예상수요</div><div className="font-mono">{fmt(r.partner_expected_demand_14d)}</div></div>
          <div><div className="text-bf-muted text-[10px]">출발 여유분</div><div className={`font-mono font-semibold ${typeof partnerSurplus === 'number' && partnerSurplus < qty ? 'text-orange-600' : 'text-green-700'}`}>{fmt(partnerSurplus)}</div></div>
          <div><div className="text-bf-muted text-[10px]">이전 가능</div><div className="font-mono">{fmt(r.transferable_qty)}</div></div>
          <div><div className="text-bf-muted text-[10px]">출발 위치 ID</div><div className="font-mono">{fmt(r.source_location_id)}</div></div>
        </div>
      )}
      {stage !== 2 && (
        <div className="text-bf-muted">Stage {stage ?? '?'} · partner 정보 없음 (Stage 2 권역간 이동만 표시)</div>
      )}
      {typeof r.stock_days_remaining === 'number' && (
        <div className="mt-2 pt-2 border-t border-bf-border text-bf-muted text-[11px]">
          현재 가용 {fmt(r.current_available)} · 일일 예상수요 {fmt(r.predicted_daily_demand)} · 재고 잔여 {(r.stock_days_remaining as number).toFixed(2)}일
        </div>
      )}
    </div>
  );
}

function TransferTable({
  rows,
  emptyText,
  expandedId,
  onToggle,
  labelOf,
  myWh,
  whIdOf,
}: {
  rows: PendingOrder[];
  emptyText: string;
  expandedId: string | null;
  onToggle: (id: string) => void;
  labelOf: (id: number | null | undefined) => string;
  myWh: number;
  whIdOf: (id: number | null | undefined) => number | undefined;
}) {
  return (
    <table className="data-table">
      <thead>
        <tr><th></th><th>긴급도</th><th>도서</th><th>출발 → 도착</th><th className="text-right">수량</th><th>상태</th></tr>
      </thead>
      <tbody>
        {rows.slice(0, 20).map((o) => {
          const isOpen = expandedId === o.order_id;
          const hasR = !!o.forecast_rationale;
          return (
            <>
              <tr key={o.order_id} className={hasR ? 'cursor-pointer hover:bg-bf-card/50' : ''} onClick={() => hasR && onToggle(o.order_id)}>
                <td className="text-bf-muted text-xs">{hasR ? (isOpen ? '▼' : '▶') : ''}</td>
                <td>
                  <span className={
                    o.urgency_level === 'CRITICAL' ? 'pill-rejected' :
                    o.urgency_level === 'URGENT'   ? 'pill-pending' : 'pill-info'
                  }>{ko(URGENCY_KO, o.urgency_level)}</span>
                </td>
                <td>
                  <div className="text-xs">{o.title ?? o.isbn13}</div>
                  <div className="font-mono text-[10px] text-bf-muted">{o.isbn13}</div>
                </td>
                <td>
                  {(() => {
                    const sWh = whIdOf(o.source_location_id);
                    const tWh = whIdOf(o.target_location_id);
                    const sMine = sWh === myWh;
                    const tMine = tWh === myWh;
                    return (
                      <div className="flex items-center gap-1.5 text-[11px]">
                        <span className={`px-1.5 py-0.5 rounded border ${sMine ? 'bg-blue-500/15 text-blue-300 border-blue-500/40 font-semibold' : 'bg-bf-panel2 text-bf-muted border-bf-border'}`}>{labelOf(o.source_location_id)}</span>
                        <span className="text-bf-primary font-bold">→</span>
                        <span className={`px-1.5 py-0.5 rounded border ${tMine ? 'bg-rose-500/15 text-rose-300 border-rose-500/40 font-semibold' : 'bg-bf-panel2 text-bf-muted border-bf-border'}`}>{labelOf(o.target_location_id)}</span>
                      </div>
                    );
                  })()}
                </td>
                <td className="text-right">{o.qty}권</td>
                <td>
                  <span className={
                    o.status === 'APPROVED' ? 'pill-approved' :
                    o.status === 'REJECTED' ? 'pill-rejected' : 'pill-pending'
                  }>{ko(ORDER_STATUS_KO, o.status)}</span>
                </td>
              </tr>
              {isOpen && hasR && (
                <tr key={`${o.order_id}-detail`}>
                  <td colSpan={6} className="!p-2">
                    <RationaleDetail r={o.forecast_rationale as Rationale} qty={o.qty} />
                  </td>
                </tr>
              )}
            </>
          );
        })}
        {rows.length === 0 && (
          <tr><td colSpan={6} className="text-center py-6 text-bf-muted">{emptyText}</td></tr>
        )}
      </tbody>
    </table>
  );
}

export default function WhTransfer() {
  const { role } = useOutletContext<{ role: Role }>();
  const wh = role === 'wh-manager-2' ? 2 : 1;
  const [expanded, setExpanded] = useState<string | null>(null);
  const { byId, labelOf } = useLocations(role);
  const whIdOf = (id: number | null | undefined) => (id == null ? undefined : byId.get(id)?.wh_id);

  const q = useQuery({ queryKey: ['pending-transfer', role], queryFn: () => fetchPending(role, { order_type: 'WH_TRANSFER', limit: 100 }), refetchInterval: 5000 });

  const transfers = q.data?.items.filter((o) => o.order_type === 'WH_TRANSFER') ?? [];
  // D1-3a: locations.wh_id 기준 분리 (이전 not-null 비교는 모든 row 가 양쪽 list 에 중복으로 들어가 버그)
  const outbound = transfers.filter((o) => whIdOf(o.source_location_id) === wh); // 내 권역 매장이 출고
  const inbound  = transfers.filter((o) => whIdOf(o.target_location_id) === wh); // 내 권역 매장이 입고
  const toggle = (id: string) => setExpanded((cur) => (cur === id ? null : id));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="h1">권역 이동 · {whName(wh)} 권역</h1>
        <p className="text-bf-muted text-xs mt-1">
          권역 간 재고 이동 — 출고측 권역이 먼저 발의하고 입고측 권역이 수락해야 운송 시작 (양쪽 승인 필요).
          행 클릭 시 의사결정 근거 (여유분 계산) 펼침.
        </p>
      </div>

      {/* 권역 흐름 다이어그램 */}
      <div className="card">
        <div className="flex items-center justify-center gap-4 py-4">
          {/* 좌측 권역 */}
          <div className={`flex flex-col items-center px-5 py-3 rounded-lg border-2 ${wh === 1 ? 'border-bf-primary bg-bf-primary/10' : 'border-bf-border bg-bf-panel2'}`}>
            <div className="text-base font-bold mb-1">수도권</div>
            <div className="text-[10px] text-bf-muted text-center leading-tight">강남·광화문·잠실<br/>홍대·신촌·용산</div>
            <div className="mt-2 text-xs">
              {wh === 1 ? (
                <span className="pill-info">내 권역</span>
              ) : (
                <span className="text-bf-muted">상대 권역</span>
              )}
            </div>
          </div>

          {/* 화살표 (양방향) */}
          <div className="flex flex-col items-center text-bf-muted">
            <div className="flex items-center gap-1 text-xs">
              <span>→</span>
              <span className="text-[10px]">출고 {outbound.length}건</span>
            </div>
            <div className="my-1 text-[10px] text-bf-muted">{transfers.length} 건</div>
            <div className="flex items-center gap-1 text-xs">
              <span className="text-[10px]">입고 {inbound.length}건</span>
              <span>←</span>
            </div>
          </div>

          {/* 우측 권역 */}
          <div className={`flex flex-col items-center px-5 py-3 rounded-lg border-2 ${wh === 2 ? 'border-bf-primary bg-bf-primary/10' : 'border-bf-border bg-bf-panel2'}`}>
            <div className="text-base font-bold mb-1">영남</div>
            <div className="text-[10px] text-bf-muted text-center leading-tight">부산서면·대구동성<br/>울산삼산·대구교대<br/>부산센텀·포항양덕</div>
            <div className="mt-2 text-xs">
              {wh === 2 ? (
                <span className="pill-info">내 권역</span>
              ) : (
                <span className="text-bf-muted">상대 권역</span>
              )}
            </div>
          </div>
        </div>
        <div className="text-[11px] text-bf-muted text-center">
          내 권역(파랑) 입장 — 출고는 상대 권역으로 보내고, 입고는 상대 권역에서 받습니다.
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <h2 className="h2">우리 창고가 보낼 항목 ({outbound.length})</h2>
            <span className="text-[10px] text-bf-muted">상대 창고 수락 대기</span>
          </div>
          <TransferTable rows={outbound} emptyText="발의 건 없음" expandedId={expanded} onToggle={toggle} labelOf={labelOf} myWh={wh} whIdOf={whIdOf} />
        </div>

        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <h2 className="h2">우리 창고가 받을 항목 ({inbound.length})</h2>
            <span className="text-[10px] text-bf-muted">수락하면 운송 시작</span>
          </div>
          <TransferTable rows={inbound} emptyText="수락 대기 없음" expandedId={expanded} onToggle={toggle} labelOf={labelOf} myWh={wh} whIdOf={whIdOf} />
        </div>
      </div>
    </div>
  );
}
