import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import {
  fetchSpikeEvents,
  postSpikePredictDemand,
  postSpikeEventApprove,
  type Role,
  type SpikeEvent,
  type SpikePredictResp,
} from '../api';
import EmptyState from '../components/EmptyState';

// Vertex 추천 등급 → 한글 라벨
const RECO_KO: Record<string, string> = {
  STRONG_BUY: '적극 확보',
  BUY: '확보 권장',
  NEUTRAL: '중립',
  PASS: '확보 보류',
};

// 책 표지 썸네일 — cover_url 로드 실패 시 책 아이콘 placeholder 로 대체.
function BookCover({
  url, title, className = 'w-[64px] h-[88px]',
}: { url: string | null; title: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) {
    return (
      <div
        className={`${className} flex items-center justify-center bg-bf-panel2 rounded border border-bf-border text-bf-muted text-2xl shrink-0`}
        aria-label={title}
      >
        📕
      </div>
    );
  }
  return (
    <img
      src={url}
      alt={title}
      className={`${className} object-cover rounded border border-bf-border shrink-0`}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

// z-score → 심각도 등급 (1.5 / 3.0 임계)
function severityOf(z: number) {
  if (z >= 3) return { key: 'CRITICAL', label: '매우 높음', pill: 'pill-rejected' } as const;
  if (z >= 1.5) return { key: 'WARNING', label: '높음', pill: 'pill-pending' } as const;
  return { key: 'INFO', label: '보통', pill: 'pill-info' } as const;
}

// SNS 급등 발주 plan 모달 — 본사가 예측을 확인하고 선제 발주를 승인.
//
// 흐름: spike_event 선택 → forecast-svc /forecast/spike/predict-demand (예측 재고 필요량)
//       → 본사가 수량 확인 → /spike-events/{id}/approve → PUBLISHER_ORDER status=APPROVED.
function SpikeOrderModal({
  spike, role, onClose,
}: {
  spike: SpikeEvent;
  role: Role;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  // mock = z-score 기반 추정 (GCP 무관 · 평소 시연) · real = 실제 Vertex 호출.
  const [mode, setMode] = useState<'mock' | 'real'>('mock');
  const [pred, setPred] = useState<SpikePredictResp | null>(null);
  const z = spike.z_score ?? 0;
  const sev = severityOf(z);

  const predictMut = useMutation({
    mutationFn: () => postSpikePredictDemand(
      role,
      { isbn13: spike.isbn13, z_score: z, mentions: spike.mentions_count, category: spike.category ?? undefined },
      mode,
    ),
    onSuccess: (data) => setPred(data),
  });

  const approveMut = useMutation({
    // wh1_qty/wh2_qty 미전달 → intervention-svc 가 predicted_qty 60/40 분배.
    // 예측 성공 시 권장 발주량을 60/40 으로 명시 전달.
    mutationFn: () => {
      const total = pred?.recommended_preemptive_qty ?? spike.predicted_qty ?? 0;
      const wh1 = Math.round(total * 0.6);
      return postSpikeEventApprove(role, spike.event_id, { wh1_qty: wh1, wh2_qty: total - wh1 });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['spikes'] });
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="card w-[480px] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
        <h2 className="h2 mb-3">SNS 급등 발주 plan</h2>

        {/* 대상 도서 — 표지 + 제목/저자/지표 */}
        <div className="flex gap-3 rounded border border-bf-border bg-bf-panel2 p-3 mb-3">
          <BookCover url={spike.cover_url} title={spike.title ?? spike.isbn13} />
          <div className="min-w-0 flex flex-col gap-1">
            <div className="font-semibold text-sm leading-snug">{spike.title ?? spike.isbn13}</div>
            <div className="text-bf-muted text-xs">{spike.author ?? '저자 미상'}</div>
            <div className="font-mono text-[10px] text-bf-muted">{spike.isbn13}</div>
            <div className="flex items-center gap-1.5 mt-1">
              <span className={sev.pill}>{sev.label}</span>
              <span className="label-tag">z {z.toFixed(2)}</span>
              <span className="label-tag">언급 {spike.mentions_count}건</span>
            </div>
          </div>
        </div>

        <p className="text-bf-muted text-xs mb-3">
          SNS 언급이 평소 대비 급증했습니다. 선제 재고 확보가 필요한지 본사가 판단해 발주를 승인하세요.
        </p>

        <div className="flex items-center gap-2 mb-3">
          <span className="label-tag">예측 모드</span>
          <button
            className={mode === 'mock' ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'}
            onClick={() => { setMode('mock'); setPred(null); }}
          >mock</button>
          <button
            className={mode === 'real' ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'}
            onClick={() => { setMode('real'); setPred(null); }}
          >real (Vertex)</button>
        </div>

        <button
          className="btn-ghost btn-sm mb-3"
          onClick={() => predictMut.mutate()}
          disabled={predictMut.isPending}
        >
          {predictMut.isPending ? '예측 중...' : '수요예측 실행'}
        </button>

        {predictMut.isError && (
          <p className="text-bf-danger text-xs mb-2">
            예측 실패 — real 모드는 GCP/Vertex 연결이 필요합니다. mock 모드로 시연하세요.
          </p>
        )}

        {pred && (
          <div className="rounded border border-bf-border p-3 mb-3 text-sm flex flex-col gap-1">
            <div className="flex justify-between">
              <span className="text-bf-muted">7일 예측 수요</span>
              <span className="font-mono font-semibold">{pred.predicted_demand_7d.toLocaleString()}권</span>
            </div>
            <div className="flex justify-between">
              <span className="text-bf-muted">선제 확보 권장량</span>
              <span className="font-mono font-semibold text-bf-primary">{pred.recommended_preemptive_qty.toLocaleString()}권</span>
            </div>
            <div className="flex justify-between">
              <span className="text-bf-muted">신뢰도 / 등급</span>
              <span>{Math.round(pred.confidence * 100)}% · {RECO_KO[pred.recommendation] ?? pred.recommendation}</span>
            </div>
            <div className="flex justify-between text-[11px] text-bf-muted">
              <span>모델</span>
              <span>{pred.model_version} ({pred.source})</span>
            </div>
          </div>
        )}

        {approveMut.isError && (
          <p className="text-bf-danger text-xs mb-2">발주 승인 실패 — 잠시 후 다시 시도하세요.</p>
        )}

        <div className="flex justify-end gap-2">
          <button className="btn-ghost btn-sm" onClick={onClose}>취소</button>
          <button
            className="btn-primary btn-sm"
            onClick={() => approveMut.mutate()}
            disabled={!pred || approveMut.isPending}
            title={pred ? '본사 승인 — PUBLISHER_ORDER 즉시 생성' : '먼저 수요예측을 실행하세요'}
          >
            {approveMut.isPending ? '승인 중...' : '발주 승인'}
          </button>
        </div>
      </div>
    </div>
  );
}

// 화제 도서 카드 — 표지 + 제목/저자/지표 + 발주 plan 액션.
function SpikeCard({
  spike, isHQ, onOrder,
}: { spike: SpikeEvent; isHQ: boolean; onOrder: () => void }) {
  const z = spike.z_score ?? 0;
  const sev = severityOf(z);
  const resolved = !!spike.resolved_at;

  return (
    <div className="card-tight flex gap-3 hover:border-bf-primary transition-colors">
      <BookCover url={spike.cover_url} title={spike.title ?? spike.isbn13} />

      <div className="min-w-0 flex flex-col flex-1">
        {/* 제목 + 심각도 */}
        <div className="flex items-start justify-between gap-2">
          <div className="font-semibold text-sm leading-snug line-clamp-2">
            {spike.title ?? spike.isbn13}
          </div>
          <span className={`${sev.pill} shrink-0`} title={`z-score ${z.toFixed(2)}`}>{sev.label}</span>
        </div>
        <div className="text-bf-muted text-xs mt-0.5">{spike.author ?? '저자 미상'}</div>
        <div className="text-bf-muted text-[11px]">{spike.category ?? '카테고리 미상'}</div>

        {/* 지표 — z-score · 언급 · 추정 발주량 */}
        <div className="grid grid-cols-3 gap-1 mt-2 mb-2 text-center">
          <div className="rounded bg-bf-panel2 py-1">
            <div className="label-tag">수요 급등</div>
            <div className="font-mono font-bold text-sm">{z.toFixed(2)}</div>
          </div>
          <div className="rounded bg-bf-panel2 py-1">
            <div className="label-tag">SNS 언급</div>
            <div className="font-mono font-bold text-sm">{spike.mentions_count}</div>
          </div>
          <div className="rounded bg-bf-panel2 py-1">
            <div className="label-tag">추정 발주</div>
            <div className="font-mono font-bold text-sm">
              {spike.predicted_qty != null ? `${spike.predicted_qty}` : '-'}
            </div>
          </div>
        </div>

        {/* 하단 — 감지 시각 + 액션 */}
        <div className="flex items-center justify-between gap-2 mt-auto">
          <span className="text-[11px] text-bf-muted">
            {new Date(spike.detected_at).toLocaleString('ko-KR')}
          </span>
          {resolved ? (
            <span
              className="pill-approved"
              title={`발주 생성 ${new Date(spike.resolved_at!).toLocaleString('ko-KR')}`}
            >
              발주 완료
            </span>
          ) : isHQ ? (
            <button
              className="btn-primary btn-sm"
              onClick={onOrder}
              title={`${spike.title ?? spike.isbn13} — 수요예측 확인 후 선제 발주 승인`}
            >
              급등 발주
            </button>
          ) : (
            <span className="text-[10px] text-bf-muted">본사만 발주</span>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Spikes() {
  const { role } = useOutletContext<{ role: Role }>();
  const isHQ = role === 'hq-admin';
  const q = useQuery({ queryKey: ['spikes', role], queryFn: () => fetchSpikeEvents(role, 30), refetchInterval: 10000 });
  const [target, setTarget] = useState<SpikeEvent | null>(null);

  const items = q.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="h1">SNS 급등 감지</h1>
        <p className="text-bf-muted text-xs mt-1">
          최근 24시간 SNS 언급량이 평소 대비 급격히 증가한 도서 (10분마다 자동 분석).
          본사는 각 카드의 "급등 발주" 버튼으로 수요예측을 확인하고 선제 재고 확보 발주를 승인할 수 있어요.
        </p>
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="h2">최근 급등 도서 ({items.length})</h2>
          <span className="label-tag">10초마다 자동 갱신</span>
        </div>

        {items.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {items.map((s) => (
              <SpikeCard
                key={s.event_id}
                spike={s}
                isHQ={isHQ}
                onOrder={() => setTarget(s)}
              />
            ))}
          </div>
        ) : !q.isLoading ? (
          <EmptyState
            icon="📈"
            message="감지된 급등 도서 없음"
            hint="spike-detect Lambda 가 10분마다 SNS 데이터를 분석합니다"
          />
        ) : (
          <div className="text-center py-10 text-bf-muted text-sm">로딩 중…</div>
        )}
      </div>

      {target && (
        <SpikeOrderModal spike={target} role={role} onClose={() => setTarget(null)} />
      )}
    </div>
  );
}
