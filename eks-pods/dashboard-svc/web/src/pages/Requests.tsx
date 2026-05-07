import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import {
  fetchNewBookRequests,
  fetchNewBookForecastHint,
  postNewBookApprove,
  postNewBookReject,
  type NewBookRequest,
  type NewBookForecastHint,
  type Role,
} from '../api';
import { roleGroup } from '../auth';

type StatusTab = 'NEW' | 'REVIEWING' | 'APPROVED' | 'REJECTED';

const TABS: { key: StatusTab; label: string; hint: string }[] = [
  { key: 'NEW',       label: '신규',     hint: '출판사 신간 신청 도착 직후' },
  { key: 'REVIEWING', label: '검토중',   hint: '본사가 자료 확인 중' },
  { key: 'APPROVED',  label: '편입완료', hint: '본사 편입 결정 + 발주 지시서 발송 완료' },
  { key: 'REJECTED',  label: '거절',     hint: '본사가 편입 거절' },
];

// DB status → 한글 라벨
const STATUS_KO: Record<string, string> = {
  NEW: '신규',
  FETCHED: '검토중',
  APPROVED: '편입완료',
  REJECTED: '거절',
};

// new_book_requests.status 값 매핑 - 'FETCHED' 도 검토중 탭으로 묶어 표시.
function bucketOf(status: string): StatusTab {
  if (status === 'NEW')      return 'NEW';
  if (status === 'FETCHED')  return 'REVIEWING';
  if (status === 'APPROVED') return 'APPROVED';
  if (status === 'REJECTED') return 'REJECTED';
  return 'NEW';
}

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

  const [tab, setTab] = useState<StatusTab>('NEW');
  const [selected, setSelected] = useState<NewBookRequest | null>(null);

  const list = useQuery({
    queryKey: ['requests', role],
    queryFn: () => fetchNewBookRequests(role, 200),
    refetchInterval: 8000,
    placeholderData: keepPreviousData,
  });

  const filtered = (list.data?.items ?? []).filter((r) => bucketOf(r.status) === tab);
  const tabCounts: Record<StatusTab, number> = { NEW: 0, REVIEWING: 0, APPROVED: 0, REJECTED: 0 };
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
                      {tab === 'NEW' && '출판사가 새 신청을 보내면 여기에 표시됩니다 (1분 주기 갱신).'}
                      {tab === 'REVIEWING' && '본사가 자료를 확인 중인 요청만 표시됩니다.'}
                      {tab === 'APPROVED' && '본사가 편입 결정한 요청 + 권역별 발주 수량.'}
                      {tab === 'REJECTED' && '본사가 거절한 요청 + 사유.'}
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

  const hint = useQuery({
    queryKey: ['forecast-hint', req.id, role],
    queryFn: () => fetchNewBookForecastHint(role, req.id, 100),
    enabled: isHQ && !decided,
    staleTime: 30_000,
  });

  const [wh1, setWh1] = useState<number | null>(null);
  const [wh2, setWh2] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [showRejectModal, setShowRejectModal] = useState(false);

  // hint 로드되면 prefill (이미 사용자가 손대지 않았을 때만)
  useEffect(() => {
    if (hint.data && wh1 === null && wh2 === null) {
      setWh1(hint.data.wh1_qty);
      setWh2(hint.data.wh2_qty);
    }
  }, [hint.data]); // eslint-disable-line react-hooks/exhaustive-deps

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

      {/* AI 정책별 결과 + 분배 폼 (HQ 전용 + 미결정 상태만) */}
      {isHQ && !decided && (
        <div className="card-tight">
          <h2 className="h3 mb-2">AI 권역별 추천</h2>
          {hint.isLoading && <div className="text-xs text-bf-muted">분석 중…</div>}
          {hint.data && (
            <>
              <BarChart hint={hint.data} />
              <div className="text-[11px] text-bf-muted mt-2">
                {hint.data.source === 'category'
                  ? `같은 카테고리 최근 14일 매출 비율 (수도권 ${hint.data.wh1_pct}% · 영남 ${hint.data.wh2_pct}%)`
                  : '카테고리 매출 데이터 부족 — 기본값 60/40 (수도권 우세) 적용'}
              </div>

              <h3 className="h3 mt-4 mb-2">권역별 분배 수량 <span className="text-[10px] text-bf-muted ml-1">(수정 가능)</span></h3>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <label className="flex flex-col gap-1">
                  <span className="text-bf-muted">수도권 권역</span>
                  <input
                    type="number"
                    min={0}
                    className="ipt"
                    value={wh1 ?? ''}
                    onChange={(e) => setWh1(e.target.value === '' ? 0 : Number(e.target.value))}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-bf-muted">영남 권역</span>
                  <input
                    type="number"
                    min={0}
                    className="ipt"
                    value={wh2 ?? ''}
                    onChange={(e) => setWh2(e.target.value === '' ? 0 : Number(e.target.value))}
                  />
                </label>
              </div>
              <div className="text-[11px] text-bf-muted mt-2">총 발주 수량 = <b className="text-bf-text">{total}</b>권</div>
            </>
          )}
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
            title={total <= 0 ? 'WH-1 + WH-2 합이 1 이상이어야 합니다' : ''}
            onClick={() => approve.mutate()}
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
    </>
  );
}

// ─── BarChart (recharts 안 쓰고 div로 단순 표시) ─────────────────────────────
function BarChart({ hint }: { hint: NewBookForecastHint }) {
  const max = Math.max(hint.wh1_qty, hint.wh2_qty, 1);
  const Row = ({ label, qty, color }: { label: string; qty: number; color: string }) => (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-16 text-bf-muted">{label}</span>
      <div className="flex-1 h-5 bg-bf-panel2 rounded overflow-hidden">
        <div
          className="h-full transition-[width] duration-300"
          style={{ width: `${(qty / max) * 100}%`, background: color }}
        />
      </div>
      <span className="w-12 text-right font-mono">{qty}권</span>
    </div>
  );
  return (
    <div className="flex flex-col gap-1.5 mt-1">
      <Row label="수도권" qty={hint.wh1_qty} color="#1B3A5C" />
      <Row label="영남" qty={hint.wh2_qty} color="#1A7A6D" />
    </div>
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
