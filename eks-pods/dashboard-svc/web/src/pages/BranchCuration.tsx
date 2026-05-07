import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { fetchCuration, type Role } from '../api';
import { useLocations } from '../useLocations';

export default function BranchCuration() {
  const { role } = useOutletContext<{ role: Role }>();
  const my_store = 1;
  const { nameOf } = useLocations(role);
  const q = useQuery({ queryKey: ['curation', my_store, role], queryFn: () => fetchCuration(role, my_store), refetchInterval: 30000 });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="h1">{nameOf(my_store)} · 큐레이션 추천</h1>
        <p className="text-bf-muted text-xs mt-1">
          최근 24시간 SNS 에서 급등한 도서 중 매장에 재고가 있는 책을 우선 진열하세요. 30초마다 갱신.
        </p>
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="h2">급등 인기 도서 ({q.data?.items.length ?? 0})</h2>
          <span className="label-tag">spike_events JOIN inventory · 30초 갱신</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {q.data?.items.map((c) => {
            const sev = (c.z_score ?? 0) >= 3 ? 'CRITICAL' : (c.z_score ?? 0) >= 1.5 ? 'WARNING' : 'INFO';
            const stockOk = c.available > 0;
            return (
              <div key={c.isbn13} className="card-tight">
                <div className="flex items-start justify-between mb-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold truncate">{c.title ?? c.isbn13}</div>
                    <div className="text-[10px] text-bf-muted truncate">{c.author ?? '-'} · {c.category ?? '-'}</div>
                  </div>
                  <span className={
                    sev === 'CRITICAL' ? 'pill-rejected' :
                    sev === 'WARNING'  ? 'pill-pending' : 'pill-info'
                  }>{sev}</span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-center text-xs my-3">
                  <div>
                    <div className="text-[10px] text-bf-muted">z-score</div>
                    <div className="font-semibold text-bf-danger">{c.z_score?.toFixed(2) ?? '-'}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-bf-muted">매출</div>
                    <div className="font-semibold">{c.mentions_count}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-bf-muted">매장 가용</div>
                    <div className={`font-semibold ${stockOk ? 'text-bf-success' : 'text-bf-danger'}`}>
                      {c.available}
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-bf-muted">{c.price_sales ? `₩${c.price_sales.toLocaleString()}` : '-'}</span>
                  <span className="font-mono text-[10px] text-bf-muted">{c.isbn13}</span>
                </div>
                {!stockOk && (
                  <div className="mt-2 text-[10px] text-bf-warn">⚠ 매장 재고 없음 - 입고 요청 필요</div>
                )}
              </div>
            );
          })}
          {q.data?.items.length === 0 && (
            <div className="col-span-full text-center py-6 text-bf-muted text-xs">
              최근 24시간 내 급등 감지 없음 · spike-detect Lambda 가 10분마다 실행
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
