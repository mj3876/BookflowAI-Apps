import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import {
  fetchNewBookRequests,
  postNewBookApprove,
  postNewBookReject,
  postNewBookPredictDemand,
  type NewBookRequest,
  type Role,
} from '../api';
import { roleGroup } from '../auth';
import ConfirmModal from '../components/ConfirmModal';

// 사용자 정정 (2026-05-08): 4 탭 → 2 탭 단순화 (대기중 = NEW+FETCHED · 처리완료 = APPROVED+REJECTED)
type StatusTab = 'PENDING' | 'DONE';

const TABS: { key: StatusTab; label: string; hint: string }[] = [
  { key: 'PENDING', label: '대기중',   hint: '신규 신청 + 검토중 (본사 결정 필요)' },
  { key: 'DONE',    label: '처리완료', hint: '편입 완료 + 거절' },
];

// DB status → 한글 라벨
const STATUS_KO: Record<string, string> = {
  NEW: '신규',
  FETCHED: '검토중',
  APPROVED: '편입완료',
  REJECTED: '거절',
};

// new_book_requests.status 값 → 2 bucket 매핑
function bucketOf(status: string): StatusTab {
  if (status === 'NEW' || status === 'FETCHED') return 'PENDING';
  return 'DONE';
}

// Vertex 추천 등급 → 한글 라벨 + 색상
const RECO_KO: Record<string, string> = {
  STRONG_BUY: '적극 편입',
  BUY: '편입 권장',
  NEUTRAL: '중립',
  PASS: '편입 보류',
};
const RECO_CLASS: Record<string, string> = {
  STRONG_BUY: 'text-bf-success',
  BUY: 'text-bf-primary',
  NEUTRAL: 'text-bf-muted',
  PASS: 'text-bf-danger',
};

function StatusPill({ status }: { status: string }) {
  const cls =
    status === 'APPROVED' ? 'pill-approved' :
    status === 'REJECTED' ? 'pill-rejected' :
    status === 'FETCHED'  ? 'pill-info'     : 'pill-pending';
  return <span className={cls}>{STATUS_KO[status] ?? status}</span>;
}

export default function Requests() {
  const { role } = useOutletContext<{ role: Role }>();
  const isHQ = roleGroup(role) === 'HQ';

  const [tab, setTab] = useState<StatusTab>('PENDING');
  const [selected, setSelected] = useState<NewBookRequest | null>(null);

  const list = useQuery({
    queryKey: ['requests', role],
    queryFn: () => fetchNewBookRequests(role, 200),
    refetchInterval: 8000,
    placeholderData: keepPreviousData,
  });

  const filtered = (list.data?.items ?? []).filter((r) => bucketOf(r.status) === tab);
  const tabCounts: Record<StatusTab, number> = { PENDING: 0, DONE: 0 };
  for (const r of list.data?.items ?? []) tabCounts[bucketOf(r.status)] += 1;

  // Auto-select first row when tab changes / new data arrives
  useEffect(() => {
    if (selected && bucketOf(selected.status) === tab) return;
    setSelected(filtered[0] ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, list.dataUpdatedAt]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="h1">출판사 신간 요청 수신함</h1>
        <p className="text-bf-muted text-xs mt-1">
          출판사가 신청한 신간을 본사가 검토하고 시스템 편입 여부를 결정합니다 ·{' '}
          <b>편입 시 양쪽 권역(수도권·영남)에 출판사 발주 지시서가 자동 생성됩니다</b>
        </p>
      </div>

      {/* 탭 */}
      <div className="card-tight flex gap-2 flex-wrap">
        {TABS.map((t) => (
          <button
            key={t.key}
            title={t.hint}
            onClick={() => setTab(t.key)}
            className={`btn ${tab === t.key ? 'btn-primary' : 'btn-ghost'}`}
          >
            {t.label} <span className="ml-1 text-[10px] opacity-80">({tabCounts[t.key]})</span>
          </button>
        ))}
        <span className="ml-auto text-[11px] text-bf-muted self-center">
          전체 {list.data?.items.length ?? 0}건 · 매 8초 새로고침
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-4">
        {/* 좌측: 표 */}
        <div className="card">
          <table className="data-table">
            <thead>
              <tr>
                <th>요청 일시</th>
                <th>ISBN</th>
                <th>제목</th>
                <th>출판사</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>
              {list.isLoading && (
                <tr><td colSpan={5} className="text-center py-6 text-bf-muted">로딩 중…</td></tr>
              )}
              {!list.isLoading && filtered.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center py-10 text-bf-muted">
                    <div className="text-sm font-medium text-bf-text mb-1">
                      이 탭에 요청 없음
                    </div>
                    <div className="text-[11px]">
                      {tab === 'PENDING' && '출판사가 새 신청을 보내면 여기에 표시됩니다 (1분 주기 갱신).'}
                      {tab === 'DONE' && '본사가 편입 결정 또는 거절 처리한 요청 (수량/사유 포함).'}
                    </div>
                  </td>
                </tr>
              )}
              {filtered.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setSelected(r)}
                  className={`cursor-pointer ${selected?.id === r.id ? 'bg-bf-panel2' : ''}`}
                >
                  <td className="text-bf-muted text-[11px]">
                    {new Date(r.requested_at).toLocaleString('ko-KR')}
                  </td>
                  <td className="font-mono text-[11px]">{r.isbn13}</td>
                  <td className="font-medium">{r.title ?? '-'}</td>
                  <td>출판사 #{r.publisher_id}</td>
                  <td><StatusPill status={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 우측: 상세 패널 */}
        <div className="flex flex-col gap-4">
          {selected ? (
            <DetailPanel
              key={`${selected.id}-${selected.status}`}
              req={selected}
              role={role}
              isHQ={isHQ}
              onSuccess={() => list.refetch()}
            />
          ) : (
            <div className="card text-bf-muted text-xs text-center py-8">
              ← 좌측 표에서 행을 클릭하면 상세가 보입니다.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── StepBadge — ①②③ 단계 표시 ──────────────────────────────────────────────
function StepBadge({ n, done }: { n: number; done?: boolean }) {
  return (
    <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[11px] font-bold ${
      done ? 'bg-bf-success text-white' : 'bg-bf-primary text-white'
    }`}>
      {done ? '✓' : n}
    </span>
  );
}

// ─── DetailPanel ─────────────────────────────────────────────────────────────
// 신간 편입 흐름 (한눈에): ① Vertex 수요검증 요청 → ② 권역 분배 → ③ 편입 결정.
//   Vertex 검증은 본사가 [요청] 버튼을 눌러야 실행 (auto-load 아님).
//   편입 결정은 검증 완료 후에만 가능 — "Vertex 결과 기반 결정".
function DetailPanel({
  req, role, isHQ, onSuccess,
}: {
  req: NewBookRequest;
  role: Role;
  isHQ: boolean;
  onSuccess: () => void;
}) {
  const qc = useQueryClient();
  const decided = req.status === 'APPROVED' || req.status === 'REJECTED';

  const [wh1, setWh1] = useState<number | null>(null);
  const [wh2, setWh2] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [showApproveConfirm, setShowApproveConfirm] = useState(false);

  // STEP 1 — Vertex AI 수요검증: 본사가 [요청] 버튼을 눌러야 실행.
  //   결과 수신 시 위치별 30일 수요를 권역(수도권 wh1 · 영남 wh2)별로 합산해 분배 수량 prefill.
  const predict = useMutation({
    mutationFn: () => postNewBookPredictDemand(role, { isbn13: req.isbn13, publisher_id: req.publisher_id }),
    onSuccess: (d) => {
      let v1 = 0, v2 = 0;
      for (const p of d.predictions) {
        if (p.wh_id === 1) v1 += p.predicted_demand_30d;
        else if (p.wh_id === 2) v2 += p.predicted_demand_30d;
      }
      setWh1(Math.round(v1));
      setWh2(Math.round(v2));
    },
  });
  const verified = !!predict.data;

  const approve = useMutation({
    mutationFn: () =>
      postNewBookApprove(role, req.id, { wh1_qty: wh1 ?? 0, wh2_qty: wh2 ?? 0 }),
    onSuccess: (d) => {
      setFeedback(`✓ 편입 결정 완료 · 발주 지시서 ${d.orders.length}건 생성 (수도권 ${d.wh1_qty}권 · 영남 ${d.wh2_qty}권) — 입출고 계획에 반영됨`);
      qc.invalidateQueries({ queryKey: ['requests'] });
      onSuccess();
    },
    onError: (e) => setFeedback(`✗ 실패: ${String(e)}`),
  });

  const reject = useMutation({
    mutationFn: (reason: string) => postNewBookReject(role, req.id, { reason }),
    onSuccess: () => {
      setShowRejectModal(false);
      setFeedback(`✓ 거절 완료 (요청 #${req.id})`);
      qc.invalidateQueries({ queryKey: ['requests'] });
      onSuccess();
    },
    onError: (e) => setFeedback(`✗ 실패: ${String(e)}`),
  });

  const total = (wh1 ?? 0) + (wh2 ?? 0);

  return (
    <>
      {/* 요청 상세 */}
      <div className="card-tight">
        <h2 className="h3 mb-2">요청 상세</h2>
        <dl className="text-xs grid grid-cols-[80px_1fr] gap-y-1 gap-x-3">
          <dt className="text-bf-muted">ISBN</dt><dd className="font-mono">{req.isbn13}</dd>
          <dt className="text-bf-muted">제목</dt><dd className="font-medium">{req.title ?? '-'}</dd>
          <dt className="text-bf-muted">출판사</dt><dd>출판사 #{req.publisher_id}</dd>
          <dt className="text-bf-muted">요청 일시</dt><dd>{new Date(req.requested_at).toLocaleString('ko-KR')}</dd>
          <dt className="text-bf-muted">상태</dt><dd><StatusPill status={req.status} /></dd>
        </dl>
      </div>

      {isHQ && !decided && (
        <>
          {/* STEP 1 — Vertex AI 수요검증 (본사가 요청해야 실행) */}
          <div className="card-tight">
            <h3 className="h3 mb-2 flex items-center gap-2"><StepBadge n={1} done={verified} /> Vertex AI 수요검증</h3>
            {!verified && !predict.isPending && !predict.isError && (
              <>
                <p className="text-xs text-bf-muted mb-2">
                  편입 결정 전, Vertex AI 에 이 신간의 권역별 예상 수요를 검증 요청합니다.
                </p>
                <button type="button" className="btn-primary w-full" onClick={() => predict.mutate()}>
                  📊 Vertex AI 수요검증 요청
                </button>
              </>
            )}
            {predict.isPending && (
              <div className="text-xs text-bf-muted py-3 text-center">Vertex AI 수요예측 분석 중…</div>
            )}
            {predict.isError && !predict.isPending && (
              <div className="text-xs text-bf-danger">
                검증 실패: {predict.error instanceof Error ? predict.error.message : String(predict.error)}
                <button type="button" className="btn-ghost ml-2 text-[11px]" onClick={() => predict.mutate()}>재시도</button>
              </div>
            )}
            {predict.data && (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <div className="metric-card">
                    <div className="metric-label">7일 총 수요</div>
                    <div className="metric-value">{Math.round(predict.data.total_7d)}</div>
                  </div>
                  <div className="metric-card">
                    <div className="metric-label">30일 총 수요</div>
                    <div className="metric-value">{Math.round(predict.data.total_30d)}</div>
                  </div>
                  <div className="metric-card">
                    <div className="metric-label">편입 추천</div>
                    <div className={`metric-value ${RECO_CLASS[predict.data.recommendation] ?? ''}`}>
                      {RECO_KO[predict.data.recommendation] ?? predict.data.recommendation}
                    </div>
                  </div>
                </div>
                <table className="data-table text-xs mt-2">
                  <thead>
                    <tr>
                      <th>위치</th><th>유형</th>
                      <th className="text-right">7일</th><th className="text-right">30일</th>
                      <th className="text-right">신뢰도</th>
                    </tr>
                  </thead>
                  <tbody>
                    {predict.data.predictions.map((p) => (
                      <tr key={p.location_id}>
                        <td>{p.location_name}</td>
                        <td>{p.location_type}</td>
                        <td className="text-right">{Math.round(p.predicted_demand_7d)}</td>
                        <td className="text-right">{Math.round(p.predicted_demand_30d)}</td>
                        <td className="text-right">{(p.confidence * 100).toFixed(0)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="flex items-center justify-between mt-2">
                  <span className="text-[11px] text-bf-muted">model: {predict.data.model_version} · GCP 미연결 mock</span>
                  <button type="button" className="btn-ghost text-[11px]" disabled={predict.isPending} onClick={() => predict.mutate()}>재검증</button>
                </div>
              </>
            )}
          </div>

          {/* STEP 2 — 권역별 분배 수량 (검증 완료 후 노출) */}
          {verified && (
            <div className="card-tight">
              <h3 className="h3 mb-2 flex items-center gap-2"><StepBadge n={2} /> 권역별 분배 수량</h3>
              <p className="text-[11px] text-bf-muted mb-2">
                Vertex 30일 수요예측을 권역별로 합산한 값 — 필요 시 수정하세요.
              </p>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <label className="flex flex-col gap-1">
                  <span className="text-bf-muted">수도권 권역</span>
                  <input type="number" min={0} className="ipt" value={wh1 ?? ''}
                    onChange={(e) => setWh1(e.target.value === '' ? 0 : Number(e.target.value))} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-bf-muted">영남 권역</span>
                  <input type="number" min={0} className="ipt" value={wh2 ?? ''}
                    onChange={(e) => setWh2(e.target.value === '' ? 0 : Number(e.target.value))} />
                </label>
              </div>
              <div className="text-[11px] text-bf-muted mt-2">총 발주 수량 = <b className="text-bf-text">{total}</b>권</div>
            </div>
          )}

          {/* STEP 3 — 편입 결정 */}
          <div className="card-tight">
            <h3 className="h3 mb-2 flex items-center gap-2"><StepBadge n={3} /> 편입 결정</h3>
            {!verified ? (
              <p className="text-xs text-bf-muted mb-2">먼저 STEP 1 의 Vertex 수요검증을 완료하면 편입 결정을 할 수 있습니다.</p>
            ) : (
              <p className="text-[11px] text-bf-muted mb-2">
                편입 결정 시 양쪽 권역에 출판사 발주(PUBLISHER_ORDER)가 자동 생성되어 입출고 계획에 바로 반영됩니다.
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-primary flex-1"
                disabled={!verified || total <= 0 || approve.isPending}
                title={!verified ? 'Vertex 수요검증을 먼저 요청하세요' : total <= 0 ? '분배 수량 합이 1 이상이어야 합니다' : ''}
                onClick={() => setShowApproveConfirm(true)}
              >
                {approve.isPending ? '처리 중…' : `✅ 신간 편입 결정${verified ? ` (총 ${total}권 발주)` : ''}`}
              </button>
              <button type="button" className="btn-ghost" disabled={reject.isPending} onClick={() => setShowRejectModal(true)}>
                거절
              </button>
            </div>
          </div>
        </>
      )}

      {/* 피드백 */}
      {feedback && (
        <div className={`card-tight text-xs ${feedback.startsWith('✓') ? 'text-bf-success' : 'text-bf-danger'}`}>
          {feedback}
        </div>
      )}
      {decided && (
        <div className="card-tight text-[11px] text-bf-muted">
          {req.status === 'APPROVED' ? '편입 완료 · 양쪽 권역 발주 지시서가 입출고 계획에 반영됨' : '거절된 요청'}
        </div>
      )}

      {showRejectModal && (
        <RejectModal
          onClose={() => setShowRejectModal(false)}
          onSubmit={(reason) => reject.mutate(reason)}
          submitting={reject.isPending}
        />
      )}

      <ConfirmModal
        open={showApproveConfirm}
        title="신간 편입 결정"
        message={`총 ${total}권 (수도권 ${wh1 ?? 0} + 영남 ${wh2 ?? 0}) 편입 결정 시 양쪽 권역에 발주 지시서가 자동 생성되어 입출고 계획에 반영됩니다.`}
        confirmText="편입 결정"
        onConfirm={() => { setShowApproveConfirm(false); approve.mutate(); }}
        onCancel={() => setShowApproveConfirm(false)}
        isLoading={approve.isPending}
      />
    </>
  );
}

// ─── RejectModal ─────────────────────────────────────────────────────────────
function RejectModal({
  onClose, onSubmit, submitting,
}: { onClose: () => void; onSubmit: (reason: string) => void; submitting: boolean }) {
  const [reason, setReason] = useState('');
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40">
      <div className="card w-[480px] max-w-[90vw]">
        <div className="flex items-start justify-between mb-3">
          <h2 className="h2">신간 편입 거절</h2>
          <button onClick={onClose} className="text-bf-muted hover:text-bf-text">×</button>
        </div>
        <label className="text-[11px] text-bf-muted">사유 (선택, 감사 로그에 기록됨)</label>
        <input
          className="ipt w-full mt-1"
          placeholder="예) 시스템 적합성 부족 / 카테고리 포화 / 출판사 신뢰도…"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={100}
          autoFocus
        />
        <div className="flex justify-end gap-2 mt-4">
          <button className="btn-ghost" onClick={onClose} disabled={submitting}>취소</button>
          <button
            className="btn-danger"
            onClick={() => onSubmit(reason.trim())}
            disabled={submitting}
          >
            {submitting ? '처리 중…' : '거절 확정'}
          </button>
        </div>
      </div>
    </div>
  );
}
