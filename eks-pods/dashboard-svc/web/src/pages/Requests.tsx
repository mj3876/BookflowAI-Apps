import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import {
  fetchNewBookRequests,
  fetchNewBookForecastHint,
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

// ─── DetailPanel ─────────────────────────────────────────────────────────────
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

  // Vertex AI 수요검증 — 편입 결정의 필수 단계. HQ 가 행을 선택하면 자동 로드.
  const predict = useQuery({
    queryKey: ['newbook-predict', req.id, role],
    queryFn: () => postNewBookPredictDemand(role, { isbn13: req.isbn13, publisher_id: req.publisher_id }),
    enabled: isHQ && !decided,
    staleTime: 60_000,
  });

  // forecast-hint — Vertex 예측 미수신 시 분배 수량 fallback (카테고리 매출 60/40).
  const hint = useQuery({
    queryKey: ['forecast-hint', req.id, role],
    queryFn: () => fetchNewBookForecastHint(role, req.id, 100),
    enabled: isHQ && !decided,
    staleTime: 30_000,
  });

  const [wh1, setWh1] = useState<number | null>(null);
  const [wh2, setWh2] = useState<number | null>(null);
  const [prefillSource, setPrefillSource] = useState<'vertex' | 'hint' | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [showApproveConfirm, setShowApproveConfirm] = useState(false);

  // Vertex 예측의 위치별 30일 수요를 wh_id(1=수도권·2=영남) 별로 합산.
  const vertexWh = predict.data
    ? predict.data.predictions.reduce(
        (acc, p) => {
          if (p.wh_id === 1) acc.wh1 += p.predicted_demand_30d;
          else if (p.wh_id === 2) acc.wh2 += p.predicted_demand_30d;
          return acc;
        },
        { wh1: 0, wh2: 0 },
      )
    : null;

  // 분배 수량 prefill — Vertex 예측 우선, 없으면 forecast-hint fallback.
  // (사용자가 직접 수정하기 전, 아직 prefill 안 됐을 때만 1회 적용)
  useEffect(() => {
    if (prefillSource !== null) return;
    if (vertexWh && (vertexWh.wh1 > 0 || vertexWh.wh2 > 0)) {
      setWh1(Math.round(vertexWh.wh1));
      setWh2(Math.round(vertexWh.wh2));
      setPrefillSource('vertex');
    } else if (hint.data) {
      setWh1(hint.data.wh1_qty);
      setWh2(hint.data.wh2_qty);
      setPrefillSource('hint');
    }
  }, [predict.data, hint.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const approve = useMutation({
    mutationFn: () =>
      postNewBookApprove(role, req.id, { wh1_qty: wh1 ?? 0, wh2_qty: wh2 ?? 0 }),
    onSuccess: (d) => {
      setFeedback(`✓ 편입 결정 완료 · 발주 지시서 ${d.orders.length}건 생성 (수도권 ${d.wh1_qty}권 · 영남 ${d.wh2_qty}권)`);
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

      {/* VertexAI 수요검증 — 편입 결정의 필수 단계 (HQ 전용 + 미결정 상태만) */}
      {isHQ && !decided && (
        <div className="card-tight">
          <h2 className="h3 mb-2">📊 VertexAI 수요검증</h2>
          {predict.isLoading && <div className="text-xs text-bf-muted">Vertex 수요예측 호출 중…</div>}
          {predict.isError && (
            <div className="text-xs text-bf-danger">
              수요예측 실패: {predict.error instanceof Error ? predict.error.message : String(predict.error)}
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
                  <div className={`metric-value ${RECO_CLASS[predict.data.recommendation]}`}>
                    {RECO_KO[predict.data.recommendation]}
                  </div>
                </div>
              </div>
              <div className="text-[11px] text-bf-muted mt-2">
                model: {predict.data.model_version} · {predict.data.predicted_at.slice(0, 19)}
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
              <div className="text-[11px] text-bf-muted mt-2">
                ⚠ 현재 GCP 미연결 · forecast-svc mock 응답 (책 메타 기반 임시 분포). 연결 후 실측치 자동 교체.
              </div>
            </>
          )}
        </div>
      )}

      {/* 권역별 분배 수량 폼 (HQ 전용 + 미결정 상태만) */}
      {isHQ && !decided && (
        <div className="card-tight">
          <h3 className="h3 mb-2">
            권역별 분배 수량 <span className="text-[10px] text-bf-muted ml-1">(수정 가능)</span>
          </h3>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <label className="flex flex-col gap-1">
              <span className="text-bf-muted">수도권 권역</span>
              <input
                type="number"
                min={0}
                className="ipt"
                value={wh1 ?? ''}
                onChange={(e) => { setWh1(e.target.value === '' ? 0 : Number(e.target.value)); setPrefillSource('vertex'); }}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-bf-muted">영남 권역</span>
              <input
                type="number"
                min={0}
                className="ipt"
                value={wh2 ?? ''}
                onChange={(e) => { setWh2(e.target.value === '' ? 0 : Number(e.target.value)); setPrefillSource('vertex'); }}
              />
            </label>
          </div>
          <div className="text-[11px] text-bf-muted mt-2">
            {prefillSource === 'vertex'
              ? 'Vertex 위치별 30일 수요예측을 권역(수도권 wh1 · 영남 wh2)별로 합산한 값입니다.'
              : prefillSource === 'hint'
                ? (hint.data?.source === 'category'
                    ? `Vertex 예측 미수신 — 같은 카테고리 최근 14일 매출 비율 (수도권 ${hint.data.wh1_pct}% · 영남 ${hint.data.wh2_pct}%) fallback`
                    : 'Vertex 예측 미수신 — 카테고리 매출 데이터 부족, 기본값 60/40 fallback')
                : '수요예측 로딩 중…'}
          </div>
          <div className="text-[11px] text-bf-muted mt-1">총 발주 수량 = <b className="text-bf-text">{total}</b>권</div>
        </div>
      )}

      {/* 액션 + 피드백 */}
      {feedback && (
        <div className={`card-tight text-xs ${feedback.startsWith('✓') ? 'text-bf-success' : 'text-bf-danger'}`}>
          {feedback}
        </div>
      )}
      {isHQ && !decided && (
        <div className="flex gap-2">
          <button
            className="btn-primary flex-1"
            disabled={total <= 0 || approve.isPending}
            title={total <= 0 ? '수도권 + 영남 권역 분배 합이 1 이상이어야 합니다' : ''}
            onClick={() => setShowApproveConfirm(true)}
          >
            {approve.isPending ? '처리 중…' : `신간 편입 결정 (총 ${total}권)`}
          </button>
          <button
            className="btn-ghost"
            disabled={reject.isPending}
            onClick={() => setShowRejectModal(true)}
          >
            거절
          </button>
        </div>
      )}
      {decided && (
        <div className="card-tight text-[11px] text-bf-muted">
          {req.status === 'APPROVED' ? '편입 완료 · 양쪽 권역 발주 지시서 발송됨' : '거절된 요청'}
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
        message={`총 ${total}권 (수도권 ${wh1 ?? 0} + 영남 ${wh2 ?? 0}) 편입 결정 시 양쪽 권역에 발주 지시서가 자동 발송됩니다.`}
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
