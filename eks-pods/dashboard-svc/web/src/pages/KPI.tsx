import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { fetchOverview, fetchSalesSummary, fetchSalesByStore, fetchRecentSales, type Role } from '../api';
import { useLocations } from '../useLocations';

export default function KPI() {
  const { role } = useOutletContext<{ role: Role }>();
  const wh_id = 1;
  const { nameOf } = useLocations(role);

  const ov = useQuery({ queryKey: ['ov', wh_id, role], queryFn: () => fetchOverview(wh_id, role), refetchInterval: 5000 });
  const summ = useQuery({ queryKey: ['summ', role], queryFn: () => fetchSalesSummary(role), refetchInterval: 5000 });
  const byStore = useQuery({ queryKey: ['byStore', role], queryFn: () => fetchSalesByStore(role), refetchInterval: 5000 });
  const recent = useQuery({ queryKey: ['recent', role], queryFn: () => fetchRecentSales(role, 12), refetchInterval: 3000 });

  const maxStoreRev = Math.max(1, ...(byStore.data?.items.map((s) => s.revenue) ?? [1]));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="h1">본사 KPI 모니터링</h1>
          <p className="text-bf-muted text-xs mt-1">실시간 POS · 5-pod fan-in · 3-5초 polling</p>
        </div>
      </div>

      {/* KPI 카드 */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="metric-card">
          <div className="metric-label">트랜잭션 (1h)</div>
          <div className="metric-value">{summ.data?.transactions ?? '-'}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">매출 (1h)</div>
          <div className="metric-value">{summ.data ? `₩${(summ.data.total_revenue / 1000).toFixed(0)}K` : '-'}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">온라인 / 오프라인</div>
          <div className="metric-value">{summ.data ? `${summ.data.online_count}/${summ.data.offline_count}` : '-'}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">PENDING 주문</div>
          <div className="metric-value">{ov.data?.pending_orders?.items.length ?? '-'}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">5-pod 상태</div>
          <div className="metric-value text-base">
            <span className={ov.data && ov.data._partial_failures.length === 0 ? 'text-bf-success' : 'text-bf-danger'}>
              {ov.data ? `${5 - ov.data._partial_failures.length}/5` : '-'}
            </span>
          </div>
          {ov.data && ov.data._partial_failures.length > 0 && (
            <div className="text-[10px] text-bf-muted mt-1">미응답: {ov.data._partial_failures.join(', ')}</div>
          )}
        </div>
      </div>

      {/* 매장별 매출 차트 */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="h2">매장별 매출 (1h)</h2>
          <span className="label-tag">{byStore.data?.items.length ?? 0} 매장</span>
        </div>
        <div className="space-y-1.5">
          {byStore.data?.items.slice(0, 12).map((s) => (
            <div key={s.store_id} className="flex items-center gap-3">
              <div className="w-24 text-xs text-bf-muted truncate" title={nameOf(s.store_id)}>{nameOf(s.store_id)}</div>
              <div className="flex-1 h-5 bg-bf-bg rounded relative overflow-hidden">
                <div
                  className="h-full bg-bf-primary"
                  style={{ width: `${(s.revenue / maxStoreRev) * 100}%` }}
                />
                <div className="absolute inset-0 flex items-center px-2 text-[11px] text-bf-text mix-blend-difference">
                  ₩{s.revenue.toLocaleString()} · {s.transactions}건
                </div>
              </div>
              <div className="w-16 text-[10px] text-bf-muted text-right">
                온라인 {s.online_count}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 최근 트랜잭션 */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="h2">최근 POS 트랜잭션</h2>
          <span className="label-tag">pos-ingestor Lambda · 3초 polling</span>
        </div>
        <table className="data-table">
          <thead>
            <tr><th>시간</th><th>ISBN</th><th>매장</th><th>채널</th><th>수량</th><th className="text-right">매출</th></tr>
          </thead>
          <tbody>
            {recent.data?.items.map((s) => (
              <tr key={s.txn_id}>
                <td className="text-bf-muted">{new Date(s.event_ts).toLocaleTimeString()}</td>
                <td className="font-mono">{s.isbn13}</td>
                <td>{nameOf(s.store_id)}</td>
                <td><span className={s.channel === 'OFFLINE' ? 'pill-info' : 'pill-up'}>{s.channel}</span></td>
                <td>{s.qty}</td>
                <td className="text-right">₩{s.revenue.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
