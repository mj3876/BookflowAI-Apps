import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { fetchCuration, postNotifySend, type Role } from '../api';
import { useScope } from '../auth';
import { useLocations } from '../useLocations';
import EmptyState from '../components/EmptyState';
import HelpHint from '../components/HelpHint';
import ConfirmModal from '../components/ConfirmModal';

type RequestTarget = { isbn13: string; title: string };

export default function BranchCuration() {
  const { role } = useOutletContext<{ role: Role }>();
  const { scope_store_id } = useScope();
  const { nameOf } = useLocations(role);
  const my_store = scope_store_id ?? 1;  // hq-admin 등은 fallback

  const [target, setTarget] = useState<RequestTarget | null>(null);
  const [resultMsg, setResultMsg] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ['curation', my_store, role],
    queryFn: () => fetchCuration(role, my_store),
    refetchInterval: 30000,
    enabled: my_store > 0,
  });

  const requestMu = useMutation({
    mutationFn: (t: RequestTarget) =>
      postNotifySend(role, {
        event_type: 'StockArrivalPending',
        severity: 'INFO',
        payload: {
          isbn13: t.isbn13,
          title: t.title,
          store_id: my_store,
          store_name: nameOf(my_store),
        },
      }),
    onSuccess: (_, t) => {
      setTarget(null);
      setResultMsg(`물류센터에 입고 요청 알림을 보냈어요 — ${t.title}`);
      setTimeout(() => setResultMsg(null), 4000);
    },
    onError: (e: Error) => alert(`입고 요청 실패: ${e.message}`),
  });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="h1">{nameOf(my_store)} · 내 매장 SNS 매칭</h1>
        <p className="text-bf-muted text-xs mt-1">
          전사 SNS 급등 도서 중 우리 매장 재고 보유분 — 입고 요청 발의 가능.
          최근 24시간 SNS 에서 화제가 된 도서를 spike-detect Lambda 가 10분마다 감지하며,
          재고가 부족하면 "입고 요청" 으로 물류센터에 알림이 발송됩니다.
          <span className="text-bf-muted/70"> 30초마다 갱신.</span>
        </p>
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="h2">
            급등 도서 ({q.data?.items.length ?? 0})
            <HelpHint text="SNS 언급량 z-score ≥ 0.5 인 도서 (10분마다 spike-detect Lambda 가 감지). z-score 가 높을수록 평소보다 화제." />
          </h2>
        </div>

        {q.isLoading && (
          <div className="text-center py-10 text-bf-muted text-xs">로딩 중…</div>
        )}

        {q.data?.items.length === 0 && !q.isLoading && (
          <EmptyState
            message="최근 24시간 급등 감지 없음"
            hint="spike-detect Lambda 가 10분마다 SNS 데이터를 분석합니다. 급등 도서가 생기면 자동 표시돼요."
          />
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {q.data?.items.map((c) => {
            const sev = (c.z_score ?? 0) >= 3 ? 'CRITICAL' : (c.z_score ?? 0) >= 1.5 ? 'WARNING' : 'INFO';
            const sevLabel = sev === 'CRITICAL' ? '매우 높음' : sev === 'WARNING' ? '높음' : '보통';
            const stockOk = c.available > 0;
            return (
              <div key={c.isbn13} className="card-tight flex gap-3">
                {/* 표지 */}
                <div className="shrink-0">
                  {c.cover_url ? (
                    <img
                      src={c.cover_url}
                      alt={c.title ?? c.isbn13}
                      className="w-[60px] h-[84px] object-cover rounded-sm border border-bf-border"
                      loading="lazy"
                      onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }}
                    />
                  ) : (
                    <div className="w-[60px] h-[84px] bg-bf-panel2 rounded-sm border border-bf-border" />
                  )}
                </div>

                {/* 정보 */}
                <div className="flex-1 min-w-0 flex flex-col">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold truncate" title={c.title ?? c.isbn13}>
                        {c.title ?? c.isbn13}
                      </div>
                      <div className="text-[10px] text-bf-muted truncate">
                        {c.author ?? '-'} · {c.category ?? '-'}
                      </div>
                    </div>
                    <span className={
                      sev === 'CRITICAL' ? 'pill-rejected' :
                      sev === 'WARNING'  ? 'pill-pending' : 'pill-info'
                    } title={`z-score ${c.z_score?.toFixed(2)}`}>
                      {sevLabel}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-1 text-center text-[11px] my-1">
                    <div>
                      <div className="text-[9px] text-bf-muted">수요 급등</div>
                      <div className="font-semibold text-bf-danger">{c.z_score?.toFixed(1) ?? '-'}</div>
                    </div>
                    <div>
                      <div className="text-[9px] text-bf-muted">SNS 언급</div>
                      <div className="font-semibold">{c.mentions_count}</div>
                    </div>
                    <div>
                      <div className="text-[9px] text-bf-muted">매장 재고</div>
                      <div className={`font-semibold ${stockOk ? 'text-bf-success' : 'text-bf-danger'}`}>
                        {c.available}
                      </div>
                    </div>
                  </div>

                  <div className="mt-auto flex items-center justify-between text-[10px]">
                    <span className="text-bf-muted">
                      {c.price_sales ? `₩${c.price_sales.toLocaleString()}` : '-'}
                    </span>
                    {stockOk ? (
                      <span className="pill-approved">진열 가능</span>
                    ) : (
                      <button
                        type="button"
                        className="btn-outline btn-sm"
                        title="물류센터에 입고 요청 알림 (notification-svc → Logic Apps)"
                        onClick={() => setTarget({ isbn13: c.isbn13, title: c.title ?? c.isbn13 })}
                      >
                        입고 요청
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {resultMsg && (
        <div className="card-tight bg-bf-success/10 border-bf-success text-bf-success text-xs">
          {resultMsg}
        </div>
      )}

      <ConfirmModal
        open={!!target}
        title="입고 요청"
        message={target ? `"${target.title}" 을(를) 매장 ${nameOf(my_store)} 으로 입고 요청 알림을 물류센터에 보냅니다.` : ''}
        confirmText="요청 보내기"
        cancelText="취소"
        onConfirm={() => target && requestMu.mutate(target)}
        onCancel={() => setTarget(null)}
        isLoading={requestMu.isPending}
      />
    </div>
  );
}
