import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { fetchPending, fetchPendingSummary, postDecide, postIntervene, postIntervenebatch, postPlanDaily, postApproveAllToday, ApiError, type Role } from '../api';
import { ko, ORDER_TYPE_KO, URGENCY_KO } from '../labels';
import ConfirmModal from '../components/ConfirmModal';
import EmptyState from '../components/EmptyState';
import HelpHint from '../components/HelpHint';
import DateHistoryTabs from '../components/DateHistoryTabs';
import BatchMapView from '../components/BatchMapView';
import StatusBadge from '../components/StatusBadge';
import { useLocations } from '../useLocations';
import { useToast } from '../components/Toast';

/**
 * 본사 의사결정 모니터링 + escalation.
 *
 * 사용자 정정 (2026-05-08):
 *   - 본사는 ISBN 치고 직접 발주 발의하지 않는다 (자동 cascade 가 정석).
 *   - Decision = "3단계 플로우 진행 상황의 큰 그림" + "필요 시 강제 승인 (escalation)".
 *   - 자동 cascade 는 forecast-svc (CronJob/Lambda) · spike-detect Lambda · 매장 입고 요청 등이 트리거.
 *   - 본사 hq-admin 의 강제 승인 권한 = 다른 역할이 처리 안 한 PENDING 을 즉시 APPROVED.
 */

const STAGE_FROM_TYPE = (t: string): 0 | 1 | 2 | 3 =>
  t === 'REBALANCE' ? 0 : t === 'WH_TO_STORE' ? 1 : t === 'WH_TRANSFER' ? 2 : 3;

const STAGE_LABEL: Record<number, { name: string; color: string; desc: string }> = {
  0: { name: '0단계 · 권역 내 재분배', color: 'pill-info',     desc: '같은 권역 내 매장 ↔ 매장 (1순위 시도) — 양측 매장 승인' },
  1: { name: '1단계 · 매장 보충 (WH→Store)', color: 'pill-info', desc: '재분배 폴백: 자기 wh 본체 → 자기 권역 매장 — wh-manager + branch-clerk 양측 협의' },
  2: { name: '2단계 · 권역 간 이동',   color: 'pill-pending', desc: '수도권 ↔ 영남 — 양쪽 권역 매니저 승인 필요' },
  3: { name: '3단계 · 외부 발주',      color: 'pill-rejected', desc: '출판사 신규 발주 — 비용 발생 · 본사/물류센터 자기 권역 승인' },
};

export default function Decision() {
  const { role } = useOutletContext<{ role: Role }>();
  const qc = useQueryClient();
  const { nameOf, items: locItems } = useLocations(role);
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  // D5-6 Spike → Decision pre-fill (?isbn=...&qty=...&note=...)
  const prefillIsbn = searchParams.get('isbn');
  const prefillQty = parseInt(searchParams.get('qty') ?? '50', 10) || 50;
  const prefillNote = searchParams.get('note') ?? '';

  // Stage 별 카운트 + 페이지네이션 — 백엔드 응답의 total/stage_counts 사용 (limit 무관 정확 카운트).
  // 일자별 detail 은 DateHistoryTabs 가 자체 lazy fetch — 여기서 fetchPending 으로 통째 365 일치 fetch 안 함.
  const PAGE_SIZE = 100;
  const [page, setPage] = useState(1);
  const pending = useQuery({
    queryKey: ['pending-active', role, page],
    queryFn: () => fetchPending(role, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    refetchInterval: 5000,
  });

  // 오늘 처리 완료 카운트 — PENDING=0 CTA 용 (가벼움 · 30s refetch)
  const todaySummary = useQuery({
    queryKey: ['pending-summary-today', role],
    queryFn: () => fetchPendingSummary(role, { days: 1 }),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
  const todayKey = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const todayRow = todaySummary.data?.items.find((i) => i.date === todayKey);
  const todayApproved = (todayRow?.APPROVED ?? 0) + (todayRow?.AUTO_EXECUTED ?? 0);
  const todayRejected = todayRow?.REJECTED ?? 0;

  const pendingOnly = (pending.data?.items ?? []).filter((o) => o.status === 'PENDING');
  const totalPending = pending.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalPending / PAGE_SIZE));
  const sc = pending.data?.stage_counts ?? {};
  const stage0Count = sc.WH_TO_STORE ?? 0;
  const stage1Count = sc.REBALANCE ?? 0;
  const stage2Count = sc.WH_TRANSFER ?? 0;
  const stage3Count = sc.PUBLISHER_ORDER ?? 0;
  // 현재 페이지 안의 stage 별 list (table 렌더 + urgent 카운트용)
  const stage0 = pendingOnly.filter((o) => STAGE_FROM_TYPE(o.order_type) === 0);
  const stage1 = pendingOnly.filter((o) => STAGE_FROM_TYPE(o.order_type) === 1);
  const stage2 = pendingOnly.filter((o) => STAGE_FROM_TYPE(o.order_type) === 2);
  const stage3 = pendingOnly.filter((o) => STAGE_FROM_TYPE(o.order_type) === 3);

  const [escalateTarget, setEscalateTarget] = useState<{ order_id: string; title: string; qty: number } | null>(null);

  const escalate = useMutation({
    mutationFn: (order_id: string) =>
      postIntervene(role, 'approve', { order_id, approval_side: 'FINAL', note: 'HQ escalation' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pending-active'] });
      qc.invalidateQueries({ queryKey: ['pending-detail'] });
      qc.invalidateQueries({ queryKey: ['pending-summary'] });
      qc.invalidateQueries({ queryKey: ['pending-summary-today'] });
      qc.invalidateQueries({ queryKey: ['plan-summary'] });
      qc.invalidateQueries({ queryKey: ['plan-items'] });
      qc.invalidateQueries({ queryKey: ['plan-items-approved'] });
      qc.invalidateQueries({ queryKey: ['plan-items-delta'] });
      showToast({ type: 'success', message: '강제 승인 완료' });
    },
    onError: (e) => {
      const err = e as ApiError | Error;
      showToast({ type: 'error', message: `강제 승인 실패: ${err.message}`, details: err instanceof ApiError ? err.requestId ?? undefined : undefined });
    },
  });

  // 본사 일괄 강제 승인 — 오늘 PENDING 전체 (Stage 1+2+3) 일괄 escalation.
  //   · WH_TRANSFER 는 양측 (SOURCE + TARGET) 모두 escalate 필요
  //   · 그 외는 FINAL 한 번
  const [bulkEscalateOpen, setBulkEscalateOpen] = useState(false);
  const bulkEscalate = useMutation({
    mutationFn: async () => {
      // 서버측 일괄 승인 — 페이지네이션·batch limit 우회, 단일 transaction.
      const r = await postApproveAllToday(role);
      return { total: r.total_orders, ok: r.ok, failed: r.failed, errors: r.errors };
    },
    onSuccess: (r) => {
      showToast({ type: 'success', message: `본사 강제 승인 완료 — ${r?.ok ?? 0}/${r?.total ?? 0} 처리` });
      qc.invalidateQueries({ queryKey: ['pending-active'] });
      qc.invalidateQueries({ queryKey: ['pending-detail'] });
      qc.invalidateQueries({ queryKey: ['pending-summary'] });
      qc.invalidateQueries({ queryKey: ['pending-summary-today'] });
      qc.invalidateQueries({ queryKey: ['plan-summary'] });
      qc.invalidateQueries({ queryKey: ['plan-items'] });
      qc.invalidateQueries({ queryKey: ['plan-items-approved'] });
      qc.invalidateQueries({ queryKey: ['plan-items-delta'] });
    },
    onError: (e) => showToast({ type: 'error', message: `본사 강제 승인 실패: ${String(e)}` }),
  });

  // D5-6 prefill 발의 modal state
  const [prefillTarget, setPrefillTarget] = useState<{ isbn: string; qty: number; note: string; storeId: number | null } | null>(null);
  useEffect(() => {
    if (prefillIsbn && role === 'hq-admin') {
      setPrefillTarget({ isbn: prefillIsbn, qty: prefillQty, note: prefillNote, storeId: null });
    }
  }, [prefillIsbn, prefillQty, prefillNote, role]);

  const prefillMu = useMutation({
    mutationFn: () => {
      if (!prefillTarget || !prefillTarget.storeId) throw new Error('대상 매장 선택 필요');
      return postDecide(role, {
        isbn13: prefillTarget.isbn,
        target_location_id: prefillTarget.storeId,
        qty: prefillTarget.qty,
        note: prefillTarget.note || 'Spike 발의',
      });
    },
    onSuccess: (r) => {
      showToast({ type: 'success', message: `발의 성공 — ${r.stage}단계 (${r.order_type})` });
      qc.invalidateQueries({ queryKey: ['pending-active'] });
      qc.invalidateQueries({ queryKey: ['pending-detail'] });
      qc.invalidateQueries({ queryKey: ['pending-summary'] });
      qc.invalidateQueries({ queryKey: ['pending-summary-today'] });
      qc.invalidateQueries({ queryKey: ['plan-summary'] });
      qc.invalidateQueries({ queryKey: ['plan-items'] });
      qc.invalidateQueries({ queryKey: ['plan-items-approved'] });
      qc.invalidateQueries({ queryKey: ['plan-items-delta'] });
      setPrefillTarget(null);
      setSearchParams({});
    },
    onError: (e) => {
      const err = e as ApiError | Error;
      showToast({ type: 'error', message: `발의 실패: ${err.message}`, details: err instanceof ApiError ? err.code : undefined });
    },
  });

  // 시연 trigger — D+1 forecast 기반 익일 plan 발의 (HQ 만)
  // 2026-05-13: cascade/run-batch (insufficient list 기반 per-store decide) → plan-daily (전 isbn × 전 location 동시 plan)
  // 정식 흐름은 BQ 결과 테이블 → forecast_cache sync (GCP 준비 후), 현재는 RDS forecast_cache 직읽음.
  const [demoResult, setDemoResult] = useState<string | null>(null);

  const triggerDemo = useMutation({
    mutationFn: async () => postPlanDaily(role),
    onSuccess: (r) => {
      const s1 = r.by_stage?.['1'] ?? 0;
      const s2 = r.by_stage?.['2'] ?? 0;
      const s3 = r.by_stage?.['3'] ?? 0;
      setDemoResult(
        `✓ D+1 (${r.snapshot_date}) plan 발의 — ${r.rows_created}건 (${r.isbns_planned} 도서) · 1단계 ${s1} · 2단계 ${s2} · 3단계 ${s3}`,
      );
      qc.invalidateQueries({ queryKey: ['pending-active'] });
      qc.invalidateQueries({ queryKey: ['pending-detail'] });
      qc.invalidateQueries({ queryKey: ['pending-summary'] });
      qc.invalidateQueries({ queryKey: ['pending-summary-today'] });
      qc.invalidateQueries({ queryKey: ['plan-summary'] });
      qc.invalidateQueries({ queryKey: ['plan-items'] });
      qc.invalidateQueries({ queryKey: ['plan-items-approved'] });
      qc.invalidateQueries({ queryKey: ['plan-items-delta'] });
      setTimeout(() => setDemoResult(null), 10000);
    },
    onError: (e) => alert(`plan 발의 실패: ${String(e)}`),
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="h1">의사결정 플로우 현황</h1>
          <p className="text-bf-muted text-xs mt-1">
            현재 진행 중인 모든 발주 결정의 단계와 처리 상황. 자동 cascade (수요 예측·SNS 급등·매장 요청)로 발의되며,
            {role === 'hq-admin' ? ' 본사는 필요 시 다른 역할의 승인을 기다리지 않고 강제 승인 (escalation) 할 수 있어요.' : ' 권한이 있는 행만 처리 가능합니다.'}
          </p>
          {/* D5-4 workflow link */}
          <div className="text-[11px] text-bf-muted mt-1">
            발의 후 → <Link to="/wh-approve" className="text-bf-primary hover:underline">권역 물류센터 승인</Link>
            {' · '}양쪽 협의 → <Link to="/wh-transfer" className="text-bf-primary hover:underline">권역 이동</Link>
            {' · '}D+1 plan 결과 → <Link to="/final-plan" className="text-bf-primary hover:underline">최종 계획안</Link>
          </div>
        </div>
        {role === 'hq-admin' && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              className="btn-outline btn-sm"
              title="시연용 — 예측 부족 도서 자동 cascade 일괄 발의 (각 단계의 처리 대기를 만들어 다른 역할이 승인 흐름 검증)"
              disabled={triggerDemo.isPending}
              onClick={() => {
                if (!confirm('D+1 forecast 기반 익일 plan 을 발의합니다. 진행할까요?')) return;
                triggerDemo.mutate();
              }}
            >
              시연: 예측 자동 발의
            </button>
            {totalPending > 0 && (
              <button
                className="px-3 py-1.5 rounded-md text-sm font-semibold bg-rose-600 hover:bg-rose-700 text-white border border-rose-700 disabled:opacity-50"
                title="오늘 PENDING 전체 (Stage 1+2+3) 를 본사 단독 강제 승인. WH_TRANSFER 는 양측 (SOURCE+TARGET) 자동 처리."
                disabled={bulkEscalate.isPending}
                onClick={() => setBulkEscalateOpen(true)}
              >
                {bulkEscalate.isPending ? '처리 중…' : `🔥 본사 강제 승인 (${totalPending}건)`}
              </button>
            )}
          </div>
        )}
      </div>

      {demoResult && (
        <div className="card-tight bg-bf-success/10 border-bf-success text-bf-success text-xs">
          ✓ {demoResult}
        </div>
      )}

      {/* PENDING=0 prominent CTA — 오늘 처리 완료 + 최종 계획안 진입 */}
      {totalPending === 0 && (todayApproved > 0 || todayRejected > 0) && (
        <div className="card flex items-center justify-between gap-3 bg-bf-success/10 border-bf-success">
          <div>
            <div className="text-sm font-semibold text-bf-success">오늘 plan 처리 완료</div>
            <div className="text-xs text-bf-muted mt-0.5">
              승인 {todayApproved}건 · 거절 {todayRejected}건 · 처리 대기 0건
            </div>
          </div>
          <Link
            to="/final-plan"
            className="btn-primary text-xs"
            title="최종 계획안 — 단계 × 상태 매트릭스 + 상세 list"
          >
            최종 계획안 보기 →
          </Link>
        </div>
      )}

      {/* Stage 별 카운트 — 백엔드 stage_counts (전체 합 · 페이지 무관) */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        {[0, 1, 2, 3].map((s) => {
          const count = s === 0 ? stage0Count : s === 1 ? stage1Count : s === 2 ? stage2Count : stage3Count;
          const urgentList = s === 0 ? stage0 : s === 1 ? stage1 : s === 2 ? stage2 : stage3;
          const urgentSeen = urgentList.filter((o) => o.urgency_level === 'URGENT' || o.urgency_level === 'CRITICAL').length;
          return (
            <div key={s} className="metric-card">
              <div className="flex items-center justify-between mb-2">
                <span className={STAGE_LABEL[s].color}>{STAGE_LABEL[s].name}</span>
                {urgentSeen > 0 && <span className="text-[11px] text-bf-danger">긴급 (현재 페이지) {urgentSeen}건</span>}
              </div>
              <div className="metric-value">{count}건</div>
              <div className="text-[11px] text-bf-muted mt-1">{STAGE_LABEL[s].desc}</div>
            </div>
          );
        })}
      </div>

      {/* 페이지네이션 컨트롤 */}
      {totalPending > PAGE_SIZE && (
        <div className="flex items-center justify-center gap-3 text-xs">
          <button
            className="btn-secondary btn-sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >← 이전</button>
          <span className="text-bf-muted">
            페이지 <b className="text-bf-text">{page}</b> / {totalPages}
            <span className="ml-2">(총 {totalPending}건 · {PAGE_SIZE}건씩)</span>
          </span>
          <button
            className="btn-secondary btn-sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >다음 →</button>
        </div>
      )}

      {/* 처리 대기 + 일자별 처리 기록 */}
      <DateHistoryTabs
        role={role}
        days={6}
        pageLabel="의사결정 처리 기록 7일"
      >
        {(filtered, { isToday, viewMode, isLoading }) => {
          const todayBar = isToday ? (
            <div className="card-tight flex items-center gap-2 text-xs">
              <HelpHint text="자동 cascade 결과 또는 매장/SNS 발의 결과. 본사는 필요 시 강제 승인 (escalation) 으로 즉시 통과시킬 수 있어요." />
              <span className="text-bf-muted">오늘 처리 대기 {pendingOnly.length}건</span>
              <span className="label-tag ml-auto">5초마다 자동 갱신</span>
            </div>
          ) : null;
          const body = viewMode === 'map' ? (
            <BatchMapView items={filtered as any} nameOf={nameOf} />
          ) : (
          <div className="card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>긴급도</th>
                  <th>단계</th>
                  <th>도서</th>
                  <th>출발 → 도착</th>
                  <th className="text-right">수량</th>
                  <th>{isToday ? '생성' : '처리 일시'}</th>
                  <th>상태</th>
                  {role === 'hq-admin' && isToday && <th className="text-right">강제 승인</th>}
                </tr>
              </thead>
              <tbody>
                {filtered.map((o) => {
                  const stage = STAGE_FROM_TYPE(o.order_type);
                  const ts = o.approved_at ?? o.executed_at ?? o.created_at;
                  const showAction = role === 'hq-admin' && isToday;
                  return (
                    <tr key={o.order_id}>
                      <td>
                        <span className={
                          o.urgency_level === 'CRITICAL' ? 'pill-rejected' :
                          o.urgency_level === 'URGENT'   ? 'pill-pending' : 'pill-info'
                        }>{ko(URGENCY_KO, o.urgency_level)}</span>
                      </td>
                      <td>
                        <span className={STAGE_LABEL[stage].color}>{stage}단계</span>
                        <span className="text-[11px] text-bf-muted ml-1">{ko(ORDER_TYPE_KO, o.order_type)}</span>
                        {o.order_type === 'PUBLISHER_ORDER' && (
                          <span className="text-[10px] text-emerald-500 ml-1" title="출판사 → 거점창고 → 매장 분배 (출판사 lead time 최대 3일)">
                            📦 출판사→WH (D+3)
                          </span>
                        )}
                      </td>
                      <td>
                        <div className="text-sm">{o.title ?? o.isbn13}</div>
                        <div className="font-mono text-[10px] text-bf-muted">{o.isbn13}</div>
                      </td>
                      <td className="text-[11px]">
                        {o.source_location_id != null ? nameOf(o.source_location_id) : '(출판사)'} → {o.target_location_id != null ? nameOf(o.target_location_id) : '-'}
                      </td>
                      <td className="text-right">{o.qty}권</td>
                      <td className="text-bf-muted text-[11px]">{ts ? new Date(ts).toLocaleString('ko-KR') : '-'}</td>
                      <td>
                        <StatusBadge
                          status={o.status as any}
                          orderType={o.order_type as any}
                          approvedAt={o.approved_at}
                        />
                      </td>
                      {showAction && (
                        <td className="text-right">
                          {o.status === 'PENDING' ? (
                            <button
                              className="btn-outline btn-sm"
                              title="다른 역할 승인 기다리지 않고 본사 단독 강제 승인 (escalation)"
                              onClick={() => setEscalateTarget({
                                order_id: o.order_id,
                                title: o.title ?? o.isbn13,
                                qty: o.qty,
                              })}
                            >
                              강제 승인
                            </button>
                          ) : (
                            <span className="text-[10px] text-bf-muted">-</span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
                {filtered.length === 0 && !isLoading && (
                  <tr>
                    <td colSpan={role === 'hq-admin' && isToday ? 8 : 7}>
                      <EmptyState
                        message={isToday ? '처리 대기 결정 없음' : '해당 일자에 처리 기록이 없습니다'}
                        hint={isToday ? '자동 cascade · 매장 요청 · SNS 급등 결과로 발의가 들어오면 여기에 표시됩니다' : undefined}
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          );
          return (
            <>
              {todayBar}
              {body}
            </>
          );
        }}
      </DateHistoryTabs>

      <ConfirmModal
        open={escalateTarget !== null}
        title="본사 강제 승인 (escalation)"
        message={escalateTarget ? `"${escalateTarget.title}" · ${escalateTarget.qty}권\n\n다른 역할의 승인을 기다리지 않고 본사 단독으로 즉시 통과시킵니다.\n외부 발주인 경우 비용이 발생할 수 있어요.` : ''}
        confirmText="강제 승인"
        danger
        onConfirm={() => {
          if (escalateTarget) {
            escalate.mutate(escalateTarget.order_id);
            setEscalateTarget(null);
          }
        }}
        onCancel={() => setEscalateTarget(null)}
        isLoading={escalate.isPending}
      />

      {/* 본사 일괄 강제 승인 confirm */}
      <ConfirmModal
        open={bulkEscalateOpen}
        title="본사 일괄 강제 승인"
        message={`오늘 PENDING ${pendingOnly.length}건을 본사 단독으로 즉시 통과시킵니다.\n\n· Stage 1 (권역 내 재분배) · Stage 2 (권역 간 이동) · Stage 3 (외부 발주) 모두 포함\n· WH_TRANSFER 는 양측 (SOURCE + TARGET) 자동 처리\n· 외부 발주 (Stage 3) 는 비용이 발생합니다\n\n진행할까요?`}
        confirmText="강제 승인"
        danger
        onConfirm={() => {
          setBulkEscalateOpen(false);
          bulkEscalate.mutate();
        }}
        onCancel={() => setBulkEscalateOpen(false)}
        isLoading={bulkEscalate.isPending}
      />

      {/* D5-6 Spike → Decision pre-fill modal */}
      {prefillTarget && role === 'hq-admin' && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[1000]" role="dialog" aria-modal="true">
          <div className="bg-bf-panel border border-bf-border rounded-lg p-5 w-[480px] shadow-xl">
            <h2 className="h2 mb-3">발의 (Spike 자동 prefill)</h2>
            <div className="text-xs text-bf-muted mb-3">
              SNS 급등으로 자동 입력된 ISBN · 수량 · 사유. 대상 매장만 선택 후 발의하세요. 발의 후 cascade (1→2→3) 가 자동 진행됩니다.
            </div>
            <div className="space-y-2 mb-4">
              <div className="flex justify-between text-xs">
                <span className="text-bf-muted">ISBN</span>
                <span className="font-mono">{prefillTarget.isbn}</span>
              </div>
              <div className="flex justify-between items-center text-xs">
                <label className="text-bf-muted">수량</label>
                <input
                  type="number"
                  className="ipt w-24 text-right"
                  value={prefillTarget.qty}
                  onChange={(e) => setPrefillTarget({ ...prefillTarget, qty: parseInt(e.target.value, 10) || 0 })}
                  min={1}
                />
              </div>
              <div className="flex justify-between items-center text-xs">
                <label className="text-bf-muted">대상 매장</label>
                <select
                  className="ipt w-56"
                  value={prefillTarget.storeId ?? ''}
                  onChange={(e) => setPrefillTarget({ ...prefillTarget, storeId: e.target.value ? parseInt(e.target.value, 10) : null })}
                >
                  <option value="">매장 선택…</option>
                  {locItems.filter((l) => l.location_type !== 'WH').map((l) => (
                    <option key={l.location_id} value={l.location_id}>{l.name ?? `매장 ${l.location_id}`}</option>
                  ))}
                </select>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-bf-muted">사유</span>
                <span className="text-right max-w-[280px]">{prefillTarget.note || '-'}</span>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button className="btn-secondary" onClick={() => { setPrefillTarget(null); setSearchParams({}); }}>취소</button>
              <button
                className="btn-primary"
                disabled={prefillMu.isPending || !prefillTarget.storeId || prefillTarget.qty <= 0}
                onClick={() => prefillMu.mutate()}
              >
                {prefillMu.isPending ? '처리 중…' : '발의'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
