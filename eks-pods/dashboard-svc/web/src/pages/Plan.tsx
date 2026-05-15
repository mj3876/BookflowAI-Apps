// PR-D (2026-05-15) Plan 페이지 — hq-admin 시연 발의 진입점.
//
// 4-step state machine 흐름:
//   1. hq Plan 시연 발의 → decision-svc /plan-daily 가 D+1 forecast 기반 cascade 4-stage PENDING 일괄 생성
//   2. PENDING → /approval (양측 협의)
//   3. APPROVED → /logistics (출고/입고)
//   4. EXECUTED → 완료 (캘린더 ✅)
//
// Decision.tsx (legacy) 의 시연 발의 + Spike prefill 흡수.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';

import {
  postPlanDaily, postDecide, fetchPending,
  postOrdersBatchApprove, postOrdersBatchDispatch, postOrdersBatchReceive,
  type PendingOrder,
} from '../api';
import { getRole } from '../auth';
import { useToast } from '../components/Toast';

export default function Plan() {
  const role = getRole();
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [searchParams] = useSearchParams();

  // Spike → Plan prefill (?isbn=...&qty=...&note=...)
  const prefillIsbn = searchParams.get('isbn');
  const prefillNote = searchParams.get('note') ?? '';
  const [singleIsbn, setSingleIsbn] = useState(prefillIsbn ?? '');
  const [singleQty, setSingleQty] = useState(parseInt(searchParams.get('qty') ?? '50', 10) || 50);

  const [demoResult, setDemoResult] = useState<string | null>(null);

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['approval'] });
    qc.invalidateQueries({ queryKey: ['logistics'] });
    qc.invalidateQueries({ queryKey: ['calendar'] });
    qc.invalidateQueries({ queryKey: ['pending-active'] });
    qc.invalidateQueries({ queryKey: ['plan-summary'] });
    qc.invalidateQueries({ queryKey: ['plan-items'] });
  };

  const planMu = useMutation({
    mutationFn: () => postPlanDaily(role!),
    onSuccess: (r: { snapshot_date: string; rows_created: number; isbns_planned: number; by_stage?: Record<string, number> }) => {
      const s0 = r.by_stage?.['0'] ?? 0;  // REBALANCE
      const s1 = r.by_stage?.['1'] ?? 0;  // WH_TO_STORE
      const s2 = r.by_stage?.['2'] ?? 0;  // WH_TRANSFER
      const s3 = r.by_stage?.['3'] ?? 0;  // PUBLISHER_ORDER
      const msg = `✓ D+1 (${r.snapshot_date}) plan — 총 ${r.rows_created}건 (${r.isbns_planned} 도서) · 🔄 재분배 ${s0} · 🏬 매장 보충 ${s1} · 🚛 권역 이동 ${s2} · 📦 외부 발주 ${s3}`;
      setDemoResult(msg);
      showToast({ type: 'success', message: msg });
      invalidateAll();
    },
    onError: (e: Error) => showToast({ type: 'error', message: `plan 발의 실패: ${e.message}` }),
  });

  // 시연용 풀 cycle 자동 (T) — PENDING → APPROVED → IN_TRANSIT → EXECUTED 일괄
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoProgress, setAutoProgress] = useState<string | null>(null);
  const autoFullCycle = async () => {
    if (!window.confirm('현재 PENDING 모두 (강제 승인) → 출고 → 입고 한 번에 진행합니다. 시연용 풀 cycle.')) return;
    setAutoBusy(true);
    setAutoProgress('1/3 PENDING fetch 중…');
    try {
      // 1. PENDING 모두 가져옴 (limit 500)
      const pendRes = await fetchPending(role!, { limit: 500 });
      const pendIds = (pendRes.items as PendingOrder[]).filter((o) => o.status === 'PENDING').map((o) => o.order_id);
      if (pendIds.length === 0) {
        showToast({ type: 'info', message: 'PENDING 없음 — 먼저 시연 발의' });
        return;
      }
      setAutoProgress(`2/3 ${pendIds.length}건 강제 승인 중…`);
      const appr = await postOrdersBatchApprove(role!, { order_ids: pendIds });
      const approvedIds = appr.ok.map((o: unknown) => (o as { order_id: string }).order_id);

      setAutoProgress(`3/3 ${approvedIds.length}건 출고+입고 중…`);
      const disp = await postOrdersBatchDispatch(role!, { order_ids: approvedIds });
      const dispatchedIds = disp.ok.map((o: unknown) => (o as { order_id: string }).order_id);

      const recv = await postOrdersBatchReceive(role!, { order_ids: dispatchedIds });
      const executedIds = recv.ok.map((o: unknown) => (o as { order_id: string }).order_id);

      const result = `✓ 풀 cycle 완료 — 승인 ${appr.ok.length} · 출고 ${disp.ok.length} · 입고 ${recv.ok.length} · 최종 EXECUTED ${executedIds.length}`;
      setAutoProgress(result);
      showToast({ type: 'success', message: result });
      invalidateAll();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast({ type: 'error', message: `풀 cycle 실패: ${msg}` });
      setAutoProgress(`✗ 실패: ${msg}`);
    } finally {
      setAutoBusy(false);
    }
  };

  const decideMu = useMutation({
    mutationFn: () => postDecide(role!, {
      isbn13: singleIsbn,
      qty: singleQty,
      note: prefillNote || 'Plan 페이지 수동 발의',
    } as Parameters<typeof postDecide>[1]),
    onSuccess: () => {
      showToast({ type: 'success', message: '✓ 단건 발의 완료' });
      invalidateAll();
    },
    onError: (e: Error) => showToast({ type: 'error', message: `단건 발의 실패: ${e.message}` }),
  });

  if (!role || role !== 'hq-admin') {
    return (
      <div className="bf-card p-6 text-center text-sm text-bf-muted">
        Plan 페이지는 본사 관리자(hq-admin) 만 접근 가능합니다.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">🎬 Plan · 시연 발의</h1>
        <div className="text-sm text-bf-muted mt-1">
          D+1 forecast 기반 cascade 4-stage 일괄 발의 → <Link to="/approval" className="text-bf-primary hover:underline">📋 협의</Link> 페이지에서 양측 협의 → <Link to="/logistics" className="text-bf-primary hover:underline">🚚 입출고</Link> 처리.
        </div>
      </div>

      {/* 시연 발의 — 일괄 cascade */}
      <div className="bf-card p-4 space-y-3">
        <div>
          <h2 className="text-lg font-semibold">🎬 시연: 예측 자동 발의</h2>
          <div className="text-sm text-bf-muted mt-1">
            D+1 부족 예측 도서 전체를 cascade (REBALANCE 1순위 → WH_TO_STORE 2순위 → WH_TRANSFER → PUBLISHER_ORDER) 일괄 발의합니다.
            발의 후 모든 row 는 PENDING 상태로 <Link to="/approval" className="text-bf-primary hover:underline">/approval</Link> 에서 양측 협의를 거쳐야 합니다.
          </div>
        </div>
        <button
          type="button"
          className="bf-btn-primary"
          disabled={planMu.isPending}
          onClick={() => {
            if (!window.confirm('D+1 forecast 기반 cascade 4-stage plan 을 발의합니다. 진행할까요?')) return;
            planMu.mutate();
          }}
        >
          {planMu.isPending ? '발의 중…' : '🎬 시연 발의'}
        </button>
        {demoResult && (
          <div className="text-xs px-3 py-2 rounded bg-bf-success/10 text-bf-success border border-bf-success/30">
            {demoResult}
          </div>
        )}
      </div>

      {/* 시연용 풀 cycle 자동 완성 (T) */}
      <div className="bf-card p-4 space-y-3 border-bf-warn/40">
        <div>
          <h2 className="text-lg font-semibold">⚡ 시연 풀 cycle 자동</h2>
          <div className="text-sm text-bf-muted mt-1">
            현재 PENDING 전체 → 강제 승인 (escalation 양측 자동) → 출고 → 입고 → EXECUTED 한 번에. <strong className="text-bf-warn">시연 시간 절약용</strong>.
          </div>
        </div>
        <button
          type="button"
          className="px-5 py-2.5 rounded bg-bf-warn text-white font-medium hover:opacity-90 disabled:opacity-40"
          disabled={autoBusy}
          onClick={autoFullCycle}
        >
          {autoBusy ? autoProgress ?? '진행 중…' : '⚡ PENDING → APPROVED → IN_TRANSIT → EXECUTED 풀 cycle'}
        </button>
        {autoProgress && !autoBusy && (
          <div className="text-xs px-3 py-2 rounded bg-bf-warn/10 text-bf-warn border border-bf-warn/30">
            {autoProgress}
          </div>
        )}
      </div>

      {/* 단건 발의 — Spike prefill 또는 수동 */}
      <div className="bf-card p-4 space-y-3">
        <div>
          <h2 className="text-lg font-semibold">📦 단건 발의</h2>
          <div className="text-sm text-bf-muted mt-1">
            특정 ISBN 발주 (Spike Detection 페이지에서 자동 prefill).
            {prefillIsbn && <span className="ml-2 text-bf-warn">prefill ISBN={prefillIsbn}</span>}
          </div>
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={singleIsbn}
            onChange={(e) => setSingleIsbn(e.target.value)}
            placeholder="ISBN13 (예: 9791168473690)"
            className="bf-input text-sm flex-1"
          />
          <input
            type="number"
            value={singleQty}
            onChange={(e) => setSingleQty(Number(e.target.value) || 50)}
            placeholder="수량"
            className="bf-input text-sm w-24"
            min={1}
          />
          <button
            type="button"
            className="bf-btn-secondary"
            disabled={decideMu.isPending || !singleIsbn}
            onClick={() => decideMu.mutate()}
          >단건 발의</button>
        </div>
      </div>
    </div>
  );
}
