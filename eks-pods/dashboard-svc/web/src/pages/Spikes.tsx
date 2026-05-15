import { useQuery } from '@tanstack/react-query';
import { Link, useOutletContext } from 'react-router-dom';
import { fetchSpikeEvents, type Role } from '../api';
import EmptyState from '../components/EmptyState';

export default function Spikes() {
  const { role } = useOutletContext<{ role: Role }>();
  const q = useQuery({ queryKey: ['spikes', role], queryFn: () => fetchSpikeEvents(role, 30), refetchInterval: 10000 });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="h1">SNS 급등 감지</h1>
        <p className="text-bf-muted text-xs mt-1">
          최근 24시간 SNS 언급량이 평소 대비 급격히 증가한 도서 (10분마다 자동 분석).
          심각도 높은 항목은 우측 "결정 발의" 버튼으로 발주 절차를 바로 시작할 수 있어요.
        </p>
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="h2">최근 급등 도서 ({q.data?.items.length ?? 0})</h2>
          <span className="label-tag">10초마다 자동 갱신</span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>감지 시간</th>
              <th>ISBN</th>
              <th>제목</th>
              <th>저자</th>
              <th>카테고리</th>
              <th className="text-right">SNS 언급</th>
              <th className="text-right">수요 급등 (z)</th>
              <th>심각도</th>
              <th className="text-right">처리</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.items.map((s) => {
              const z = s.z_score ?? 0;
              const sev = z >= 3 ? 'CRITICAL' : z >= 1.5 ? 'WARNING' : 'INFO';
              const sevLabel = sev === 'CRITICAL' ? '매우 높음' : sev === 'WARNING' ? '높음' : '보통';
              // CRITICAL/WARNING 만 발의 가능 — 수량 default = z 기반 합리적 수치 (z×30 · 30~120)
              const suggestedQty = Math.min(120, Math.max(30, Math.round(z * 30)));
              return (
                <tr key={s.event_id}>
                  <td className="text-bf-muted">{new Date(s.detected_at).toLocaleString('ko-KR')}</td>
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
                    } title={`z-score ${z.toFixed(2)}`}>{sevLabel}</span>
                  </td>
                  <td className="text-right">
                    {role === 'hq-admin' ? (
                      <Link
                        to={`/decision?isbn=${s.isbn13}&qty=${suggestedQty}&note=${encodeURIComponent('SNS 급등 대응')}`}
                        className="btn-outline btn-sm"
                        title={`Decision 페이지로 이동 — ${s.title ?? s.isbn13} 자동 입력 (수량 ${suggestedQty})`}
                      >
                        결정 발의
                      </Link>
                    ) : (
                      <span className="text-[10px] text-bf-muted">본사만 발의</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {(q.data?.items.length ?? 0) === 0 && !q.isLoading && (
              <tr><td colSpan={9}>
                <EmptyState message="감지된 급등 도서 없음" hint="spike-detect Lambda 가 10분마다 SNS 데이터를 분석합니다" />
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
