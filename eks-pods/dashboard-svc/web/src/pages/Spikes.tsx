import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { fetchSpikeEvents, type Role } from '../api';

export default function Spikes() {
  const { role } = useOutletContext<{ role: Role }>();
  const q = useQuery({ queryKey: ['spikes', role], queryFn: () => fetchSpikeEvents(role, 30), refetchInterval: 10000 });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="h1">Spike Detection</h1>
        <p className="text-bf-muted text-xs mt-1">
          spike-detect Lambda (10분 cron) · cross-ISBN z-score · z≥0.5 인기 도서 자동 검출
        </p>
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="h2">최근 spike events ({q.data?.items.length ?? 0})</h2>
          <span className="label-tag">spike_events 테이블 · 10초 polling</span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>감지 시간</th>
              <th>ISBN</th>
              <th>제목</th>
              <th>저자</th>
              <th>카테고리</th>
              <th className="text-right">매출 카운트</th>
              <th className="text-right">z-score</th>
              <th>심각도</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.items.map((s) => {
              const z = s.z_score ?? 0;
              const sev = z >= 3 ? 'CRITICAL' : z >= 1.5 ? 'WARNING' : 'INFO';
              return (
                <tr key={s.event_id}>
                  <td className="text-bf-muted">{new Date(s.detected_at).toLocaleString()}</td>
                  <td className="font-mono text-[11px]">{s.isbn13}</td>
                  <td className="font-medium">{s.title ?? '-'}</td>
                  <td>{s.author ?? '-'}</td>
                  <td className="text-bf-muted">{s.category ?? '-'}</td>
                  <td className="text-right">{s.mentions_count}</td>
                  <td className="text-right font-mono font-semibold">{z.toFixed(2)}</td>
                  <td>
                    <span className={
                      sev === 'CRITICAL' ? 'pill-rejected' :
                      sev === 'WARNING'  ? 'pill-pending' : 'pill-info'
                    }>{sev}</span>
                  </td>
                </tr>
              );
            })}
            {q.data?.items.length === 0 && (
              <tr><td colSpan={8} className="text-center py-6 text-bf-muted">감지된 spike 없음</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
