import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { fetchExecutionByLocation, type Role } from '../api';
import EmptyState from '../components/EmptyState';

/**
 * 위치별 실행 추적 (2026-05-14 신규)
 *
 * pending_orders APPROVED/EXECUTED row 를 location 별 input/output 으로 집계.
 *  - 매장: 출고 (REBALANCE source) · 입고 (WH_TO_STORE/REBALANCE/WH_TRANSFER target)
 *  - WH 본체: 출고 (WH_TO_STORE/WH_TRANSFER source) · 입고 (PUBLISHER_ORDER/WH_TRANSFER target)
 *
 * role/scope 자동 (backend dashboard-svc /execution/by-location).
 */
export default function ExecutionByLocation() {
  const { role } = useOutletContext<{ role: Role }>();
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);

  const q = useQuery({
    queryKey: ['execution-by-location', role, date],
    queryFn: () => fetchExecutionByLocation(role, date),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const items = q.data?.items ?? [];

  // wh_id 별 group (UI 직관)
  const groups = new Map<number, typeof items>();
  for (const it of items) {
    const wh = it.wh_id ?? 0;
    if (!groups.has(wh)) groups.set(wh, []);
    groups.get(wh)!.push(it);
  }

  // 합계 (전체)
  const total = items.reduce(
    (acc, r) => {
      acc.in += r.inbound_qty;
      acc.out += r.outbound_qty;
      acc.exec += r.executed_count;
      return acc;
    },
    { in: 0, out: 0, exec: 0 },
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="h1">📍 위치별 실행 추적</h1>
          <p className="text-bf-muted text-xs mt-1">
            오늘 (또는 지정 일자) 의 APPROVED + EXECUTED 발주를 위치별 출고/입고/순변동으로 집계.
            role/scope 자동 필터 (HQ 전체 · 권역 매니저 자기 권역 · 매장 직원 자기 매장).
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <label className="text-xs text-bf-muted">날짜</label>
          <input
            type="date"
            className="ipt text-xs"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
      </div>

      {/* 전체 합계 카드 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="metric-card border-bf-success">
          <div className="metric-label">📥 총 입고 (qty)</div>
          <div className="metric-value text-bf-success">+{total.in.toLocaleString()}권</div>
          <div className="text-[11px] text-bf-muted mt-1">target location 합산</div>
        </div>
        <div className="metric-card border-bf-warn">
          <div className="metric-label">📤 총 출고 (qty)</div>
          <div className="metric-value text-bf-warn">-{total.out.toLocaleString()}권</div>
          <div className="text-[11px] text-bf-muted mt-1">source location 합산</div>
        </div>
        <div className="metric-card border-bf-primary">
          <div className="metric-label">✅ EXECUTED 도착</div>
          <div className="metric-value text-bf-primary">{total.exec.toLocaleString()}건</div>
          <div className="text-[11px] text-bf-muted mt-1">매장 입고 수령 완료</div>
        </div>
      </div>

      {q.isLoading && <div className="card-tight text-xs text-bf-muted">조회 중…</div>}
      {q.isError && <div className="card-tight text-xs text-bf-danger">조회 실패</div>}

      {items.length === 0 && !q.isLoading ? (
        <EmptyState message={`${date} 에는 처리된 발주가 없습니다`} />
      ) : null}

      {/* 권역별 group 표시 */}
      {Array.from(groups.entries())
        .sort((a, b) => (a[0] || 0) - (b[0] || 0))
        .map(([whId, rows]) => (
          <div key={whId} className="card">
            <h2 className="h2 text-sm mb-2">
              {whId === 1 ? '🏢 수도권' : whId === 2 ? '🏢 영남' : '(미지정 권역)'}
            </h2>
            <table className="data-table">
              <thead>
                <tr>
                  <th>위치</th>
                  <th>유형</th>
                  <th className="text-right">출고 (-)</th>
                  <th className="text-right">입고 (+)</th>
                  <th className="text-right">순변동</th>
                  <th className="text-right">APPROVED</th>
                  <th className="text-right">EXECUTED</th>
                  <th>order_type 분포 (out/in)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const positive = r.net_change > 0;
                  const negative = r.net_change < 0;
                  return (
                    <tr key={r.location_id}>
                      <td className="font-medium">{r.name}</td>
                      <td className="text-bf-muted text-[11px]">{r.location_type ?? '-'}</td>
                      <td className="text-right text-bf-warn">
                        {r.outbound_qty > 0 ? `-${r.outbound_qty}` : '0'}
                      </td>
                      <td className="text-right text-bf-success">
                        {r.inbound_qty > 0 ? `+${r.inbound_qty}` : '0'}
                      </td>
                      <td className={`text-right font-bold ${positive ? 'text-bf-success' : negative ? 'text-bf-danger' : 'text-bf-muted'}`}>
                        {positive ? `+${r.net_change}` : r.net_change}
                      </td>
                      <td className="text-right">{r.approved_count}</td>
                      <td className="text-right">{r.executed_count}</td>
                      <td className="text-[10px]">
                        <div className="flex flex-wrap gap-1">
                          {(['WH_TO_STORE', 'REBALANCE', 'WH_TRANSFER', 'PUBLISHER_ORDER'] as const).map((ot) => {
                            const cnt = r.by_order_type[ot];
                            if (cnt.outbound === 0 && cnt.inbound === 0) return null;
                            const emoji =
                              ot === 'WH_TO_STORE' ? '🏬'
                                : ot === 'REBALANCE' ? '🔄'
                                : ot === 'WH_TRANSFER' ? '🚛'
                                : '📦';
                            return (
                              <span key={ot} className="px-1.5 py-0.5 rounded bg-bf-panel2 border border-bf-border">
                                {emoji} {cnt.outbound}/{cnt.inbound}
                              </span>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  );
}
