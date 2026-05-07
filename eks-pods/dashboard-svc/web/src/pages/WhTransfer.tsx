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
  nameOf,
}: {
  rows: PendingOrder[];
  emptyText: string;
  expandedId: string | null;
  onToggle: (id: string) => void;
  nameOf: (id: number | null | undefined) => string;
}) {
  return (
    <table className="data-table">
      <thead>
        <tr><th></th><th>긴급도</th><th>ISBN</th><th>출발 → 도착</th><th className="text-right">수량</th><th>상태</th></tr>
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
                <td className="font-mono text-[11px]">{o.isbn13}</td>
                <td>{nameOf(o.source_location_id)} → {nameOf(o.target_location_id)}</td>
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
  const { nameOf } = useLocations(role);

  const q = useQuery({ queryKey: ['pending-transfer', role], queryFn: () => fetchPending(role, { order_type: 'WH_TRANSFER', limit: 100 }), refetchInterval: 5000 });

  const transfers = q.data?.items.filter((o) => o.order_type === 'WH_TRANSFER') ?? [];
  const inbound = transfers.filter((o) => o.target_location_id !== null);
  const outbound = transfers.filter((o) => o.source_location_id !== null);
  const toggle = (id: string) => setExpanded((cur) => (cur === id ? null : id));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="h1">권역 이동 · {whName(wh)} 권역</h1>
        <p className="text-bf-muted text-xs mt-1">
          창고 간 재고 이동 — 출고측 창고가 먼저 발의하고 입고측 창고가 수락해야 운송됩니다 (양쪽 승인 필요).
          행을 클릭하면 의사결정 근거 (출발 권역의 여유분 계산 내역) 가 펼쳐집니다.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <h2 className="h2">우리 창고가 보낼 항목 ({outbound.length})</h2>
            <span className="text-[10px] text-bf-muted">상대 창고 수락 대기</span>
          </div>
          <TransferTable rows={outbound} emptyText="발의 건 없음" expandedId={expanded} onToggle={toggle} nameOf={nameOf} />
        </div>

        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <h2 className="h2">우리 창고가 받을 항목 ({inbound.length})</h2>
            <span className="text-[10px] text-bf-muted">수락하면 운송 시작</span>
          </div>
          <TransferTable rows={inbound} emptyText="수락 대기 없음" expandedId={expanded} onToggle={toggle} nameOf={nameOf} />
        </div>
      </div>
    </div>
  );
}
