import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { fetchInstructions, type Role } from '../api';
import { ko, ORDER_TYPE_KO, URGENCY_KO, whName } from '../labels';
import { useLocations } from '../useLocations';

/**
 * 출고/입고 지시서 — 승인된 pending_orders.
 * UX-5: 본사 신간 발주 (urgency_level=NEWBOOK) 와 일반 지시 (NORMAL/URGENT/CRITICAL) 를 분리.
 *   - 신간 지시서: 본사 결정으로 자동 생성된 PUBLISHER_ORDER · 권역 wh 단위 입고
 *   - 일반 지시서: 의사결정 cascade 결과 (REBALANCE / WH_TRANSFER / 일반 PUBLISHER_ORDER)
 */
export default function WhInstructions() {
  const { role } = useOutletContext<{ role: Role }>();
  const wh = role === 'wh-manager-2' ? 2 : 1;
  const { nameOf } = useLocations(role);
  const q = useQuery({ queryKey: ['instr', wh, role], queryFn: () => fetchInstructions(role, wh), refetchInterval: 8000 });

  const all = q.data?.items ?? [];
  const newBookItems = all.filter((o) => o.urgency_level === 'NEWBOOK');
  const generalItems = all.filter((o) => o.urgency_level !== 'NEWBOOK');

  const renderTable = (items: typeof all, emptyText: string, hideUrgency = false) => (
    <table className="data-table">
      <thead>
        <tr>
          <th>승인 일시</th>
          <th>유형</th>
          {!hideUrgency && <th>긴급도</th>}
          <th>ISBN</th>
          <th>제목</th>
          <th>출발 → 도착</th>
          <th className="text-right">수량</th>
          <th>상태</th>
        </tr>
      </thead>
      <tbody>
        {items.map((o) => (
          <tr key={o.order_id}>
            <td className="text-bf-muted">{o.approved_at ? new Date(o.approved_at).toLocaleString('ko-KR') : '-'}</td>
            <td>{ko(ORDER_TYPE_KO, o.order_type)}</td>
            {!hideUrgency && (
              <td>
                <span className={
                  o.urgency_level === 'CRITICAL' ? 'pill-rejected' :
                  o.urgency_level === 'URGENT'   ? 'pill-pending' : 'pill-info'
                }>{ko(URGENCY_KO, o.urgency_level)}</span>
              </td>
            )}
            <td className="font-mono text-[11px]">{o.isbn13}</td>
            <td>{o.title ?? '-'}</td>
            <td>{nameOf(o.source_location_id)} → {nameOf(o.target_location_id)}</td>
            <td className="text-right">{o.qty}권</td>
            <td>
              <span className={o.status === 'EXECUTED' ? 'pill-info' : 'pill-approved'}>
                {o.status === 'EXECUTED' ? '실행됨' : '대기 중'}
              </span>
            </td>
          </tr>
        ))}
        {items.length === 0 && (
          <tr><td colSpan={hideUrgency ? 7 : 8} className="text-center py-6 text-bf-muted">{emptyText}</td></tr>
        )}
      </tbody>
    </table>
  );

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="h1">출고/입고 지시서 · {whName(wh)} 권역</h1>
        <p className="text-bf-muted text-xs mt-1">
          승인된 발주·이동 지시 — 창고 작업자가 출고하거나 입고를 수령할 항목.
          본사 신간 편입 결정 건은 별도 섹션에서 우선 확인하세요.
        </p>
      </div>

      {/* 본사 신간 지시 (NEWBOOK) — 우선 표시 */}
      <div className="card border-purple-300 bg-purple-50/30">
        <div className="flex items-center justify-between mb-3">
          <h2 className="h2 text-purple-900">📚 본사 신간 지시서 ({newBookItems.length})</h2>
          <span className="text-[10px] text-purple-700">출판사 발주 · 본사 직접 결정</span>
        </div>
        {renderTable(newBookItems, '신간 지시 없음 — 최근 본사 신간 편입 건 없습니다.', true)}
      </div>

      {/* 일반 출고/입고 지시 (REBALANCE / WH_TRANSFER / 긴급 PUBLISHER_ORDER) */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="h2">일반 지시 ({generalItems.length})</h2>
          <span className="text-[10px] text-bf-muted">의사결정 cascade 결과</span>
        </div>
        {renderTable(generalItems, '일반 지시 없음')}
      </div>
    </div>
  );
}
