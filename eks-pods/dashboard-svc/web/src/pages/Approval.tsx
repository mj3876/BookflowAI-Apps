// PR-C v4 (2026-05-15) 협의 페이지 — 사이드바 진입 (모든 role).
// 4-step state machine 의 1 단계: PENDING (양측 협의 중) 만 표시.
//
// Phase 13.1 강화 (WhApprove 패턴 흡수):
//   - 4 order_type 탭 (WH_TO_STORE / REBALANCE / WH_TRANSFER / PUBLISHER_ORDER) + 전체
//   - 검색 (isbn/title/location)
//   - 페이지네이션 (limit 50 + offset)
//   - bulk 일괄 승인 (postOrdersBatchApprove)
//   - AI 추천 수정 modal (qty / target_location_id 변경 후 동의)
//   - selfDone Set (자기 측 처리 끝 표시 · WH_TRANSFER 한쪽만 처리 시 화면 잔존 명확화)
//
// scope 자동 필터 (backend `/intervention/queue` v3):
//   hq-admin       — 모든 PENDING
//   wh-manager-X   — source.wh_id=X 또는 target.wh_id=X
//   branch-clerk-S — source_location_id=S 또는 target_location_id=S
//
// 양측 ✓ 완료되면 → APPROVED 전환 → 이 페이지에서 사라짐 → /logistics 로 이동.
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import {
  fetchPending, postOrderApprove, postOrderReject, patchOrder, postOrdersBatchApprove,
  type PendingOrder,
} from '../api';
import { getRole, getScope } from '../auth';
import { ORDER_TYPE_KO, URGENCY_KO } from '../labels';
import { useLocations } from '../useLocations';
import { useToast } from '../components/Toast';

type StageFilter = 'all' | 'REBALANCE' | 'WH_TO_STORE' | 'WH_TRANSFER' | 'PUBLISHER_ORDER';

function whichSide(o: PendingOrder, scope: { scope_wh_id: number | null; scope_store_id: number | null }): 'SOURCE' | 'TARGET' | 'BOTH' | null {
  const srcWh = (o as PendingOrder & { source_wh_id?: number | null }).source_wh_id;
  const tgtWh = (o as PendingOrder & { target_wh_id?: number | null }).target_wh_id;
  const isSrc = (scope.scope_store_id != null && o.source_location_id === scope.scope_store_id)
    || (scope.scope_wh_id != null && srcWh === scope.scope_wh_id);
  const isTgt = (scope.scope_store_id != null && o.target_location_id === scope.scope_store_id)
    || (scope.scope_wh_id != null && tgtWh === scope.scope_wh_id);
  if (isSrc && isTgt) return 'BOTH';
  if (isSrc) return 'SOURCE';
  if (isTgt) return 'TARGET';
  return null;
}

const PAGE_SIZE = 50;

export default function Approval() {
  const role = getRole();
  const scope = getScope();
  const { nameOf, items: locItems } = useLocations(role ?? 'hq-admin');
  const { showToast } = useToast();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const initialStage = (() => {
    const t = searchParams.get('stage');
    if (t === 'WH_TO_STORE' || t === 'REBALANCE' || t === 'WH_TRANSFER' || t === 'PUBLISHER_ORDER') return t;
    return 'all';
  })() as StageFilter;
  const [stage, setStage] = useState<StageFilter>(initialStage);
  const [q, setQ] = useState<string>(searchParams.get('q') ?? '');
  // 검색박스 3 분리 (ISBN · 제목 · 매장) — client-side filter (mySideRes 500건 대상)
  const [qIsbn, setQIsbn] = useState('');
  const [qTitle, setQTitle] = useState('');
  const [qStore, setQStore] = useState('');
  // 지점 재분배 sub-tab — 입고 (target=내 매장) / 출고 (source=내 매장) 분류
  const [rebalanceSide, setRebalanceSide] = useState<'all' | 'inbound' | 'outbound'>('all');
  const [page, setPage] = useState(0);
  const [selfDone, setSelfDone] = useState<Set<string>>(new Set());
  const [editTarget, setEditTarget] = useState<{
    order_id: string; isbn13: string; qty: number; target_location_id: number | null;
  } | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  // stage 변경 시 URL searchParam 동기화 + 페이지 리셋
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (stage === 'all') next.delete('stage'); else next.set('stage', stage);
    if (q) next.set('q', q); else next.delete('q');
    setSearchParams(next, { replace: true });
    setPage(0);
  }, [stage, q]); // eslint-disable-line react-hooks/exhaustive-deps

  const offset = page * PAGE_SIZE;
  const queryKey = ['approval', role, stage, q, page] as const;
  const queryRes = useQuery({
    queryKey,
    queryFn: () => fetchPending(role!, {
      limit: PAGE_SIZE,
      offset,
      ...(stage !== 'all' ? { order_type: stage } : {}),
      ...(q ? { q } : {}),
    }),
    enabled: !!role,
    staleTime: 5000,
    refetchInterval: 10000,
  });

  // 별도 stats query — stage filter 무시한 전체 stage_counts + total + mySide overview 용
  // (탭 변경/검색 시에도 4 탭 카운트 모두 표시 · EE+FF · 그리고 CC overview 전체 기준)
  const statsRes = useQuery({
    queryKey: ['approval-stats', role, q],
    queryFn: () => fetchPending(role!, { limit: 1, ...(q ? { q } : {}) }),
    enabled: !!role,
    staleTime: 5000,
    refetchInterval: 15000,
  });
  const fullStats = statsRes.data;

  const items = useMemo(() => {
    const list = (queryRes.data?.items as PendingOrder[] | undefined) ?? [];
    const trimmedIsbn = qIsbn.trim().toLowerCase();
    const trimmedTitle = qTitle.trim().toLowerCase();
    const trimmedStore = qStore.trim().toLowerCase();
    return list.filter((o) => {
      if (o.status !== 'PENDING') return false;
      if (trimmedIsbn && !o.isbn13.toLowerCase().includes(trimmedIsbn)) return false;
      if (trimmedTitle && !(o.title ?? '').toLowerCase().includes(trimmedTitle)) return false;
      if (trimmedStore) {
        const srcName = (nameOf(o.source_location_id ?? undefined) ?? '').toLowerCase();
        const tgtName = (nameOf(o.target_location_id ?? undefined) ?? '').toLowerCase();
        if (!srcName.includes(trimmedStore) && !tgtName.includes(trimmedStore)) return false;
      }
      // REBALANCE sub-tab — 입고 (target=내 측) / 출고 (source=내 측) 분류
      if (stage === 'REBALANCE' && rebalanceSide !== 'all') {
        const side = whichSide(o, scope);
        if (rebalanceSide === 'inbound' && !(side === 'TARGET' || side === 'BOTH')) return false;
        if (rebalanceSide === 'outbound' && !(side === 'SOURCE' || side === 'BOTH')) return false;
      }
      return true;
    });
  }, [queryRes.data, qIsbn, qTitle, qStore, nameOf, stage, rebalanceSide, scope]);
  const totalPending = queryRes.data?.total ?? 0;
  const totalAll = fullStats?.total ?? 0;  // 전체 (stage filter 무시)

  // 카운트 보조 — stage filter 무시한 전체 stage_counts (4 탭 모두 정확히)
  const stageCounts = (fullStats?.stage_counts as Record<string, number> | undefined) ?? {};

  // 전체 row 의 mySide overview (페이지 50 만 아닌) — 별도 limit 큰 fetch
  // (한 사용자가 자기 측 row 가 전체 몇 건인지 보기 위해)
  const mySideRes = useQuery({
    queryKey: ['approval-myside', role],
    queryFn: () => fetchPending(role!, { limit: 500 }),
    enabled: !!role,
    staleTime: 10000,
    refetchInterval: 30000,
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['approval'] });
    qc.invalidateQueries({ queryKey: ['logistics'] });
    qc.invalidateQueries({ queryKey: ['calendar'] });
    qc.invalidateQueries({ queryKey: ['pending-active'] });
  };

  const approveMu = useMutation({
    mutationFn: (id: string) => postOrderApprove(role!, id, {}),
    onSuccess: (r, id) => {
      const m = r.transitioned ? '🚚 양측 협의 완료 — 입출고 섹션으로 이동' : '✓ 내 측 동의 완료 (상대 측 대기)';
      showToast({ type: r.transitioned ? 'success' : 'info', message: m });
      if (!r.transitioned) setSelfDone((prev) => new Set(prev).add(id));
      invalidateAll();
    },
    onError: (e: Error) => showToast({ type: 'error', message: `동의 실패: ${e.message}` }),
  });

  const rejectMu = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => postOrderReject(role!, id, { reject_reason: reason }),
    onSuccess: (_r, v) => {
      showToast({ type: 'warning', message: '❌ 협의 단계 거부' });
      setSelfDone((prev) => new Set(prev).add(v.id));
      invalidateAll();
    },
    onError: (e: Error) => showToast({ type: 'error', message: `거부 실패: ${e.message}` }),
  });

  const patchMu = useMutation({
    mutationFn: (body: { qty?: number; target_location_id?: number }) => {
      if (!editTarget) throw new Error('대상 없음');
      return patchOrder(role!, editTarget.order_id, body);
    },
    onSuccess: () => {
      showToast({ type: 'success', message: '✓ AI 추천 수정 완료' });
      setEditTarget(null);
      invalidateAll();
    },
    onError: (e: Error) => showToast({ type: 'error', message: `수정 실패: ${e.message}` }),
  });

  const bulkApprove = async () => {
    // 일괄 동의는 pagination 무관 — 모든 PENDING 가져와서 처리 (CHUNK 200 단위).
    const label = role === 'hq-admin' ? '강제 승인 (escalation · 양측 자동)' : '동의';
    setBulkBusy(true);
    try {
      // 전체 PENDING IDs fetch (limit 1000 충분 · 시연 데이터 526~)
      const allRes = await fetchPending(role!, {
        limit: 1000,
        ...(stage !== 'all' ? { order_type: stage } : {}),
      });
      const allIds = ((allRes.items as PendingOrder[] | undefined) ?? [])
        .filter((o) => o.status === 'PENDING')
        .map((o) => o.order_id);
      if (allIds.length === 0) { showToast({ type: 'info', message: '승인할 PENDING 이 없습니다.' }); setBulkBusy(false); return; }
      if (!window.confirm(`전체 PENDING ${allIds.length}건 ${label} 합니다.\n(${stage === 'all' ? '모든 stage' : stage} · pagination 무관 전체)`)) {
        setBulkBusy(false); return;
      }
      // 전체 한 번에 — backend batch_approve limit 없음.
      const r = await postOrdersBatchApprove(role!, { order_ids: allIds });
      const okCnt = r.ok.length;
      const failCnt = r.failed.length;
      showToast({
        type: 'success',
        message: `✓ ${label} 완료 — 성공 ${okCnt}건${failCnt > 0 ? ` · 실패 ${failCnt}건` : ''}`,
        details: failCnt > 0 ? `${failCnt}건 실패 (권한 미달 또는 status 변경)` : undefined,
      });
      invalidateAll();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast({ type: 'error', message: `일괄 실패: ${msg}` });
    } finally {
      setBulkBusy(false);
    }
  };

  if (!role) return null;

  const stages: { key: StageFilter; label: string }[] = [
    { key: 'all', label: '전체' },
    { key: 'REBALANCE', label: '🔄 재분배' },
    { key: 'WH_TO_STORE', label: '🏬 매장 보충' },
    { key: 'WH_TRANSFER', label: '🚛 권역 이동' },
    { key: 'PUBLISHER_ORDER', label: '📦 외부 발주' },
  ];

  // 사용자별 overview 통계 — 전체 mySideRes 기반 (페이지 50 X · CC + X 정합)
  const mySide = { source: 0, target: 0, escalation: 0 };
  const mySideItems = (mySideRes.data?.items as PendingOrder[] | undefined) ?? [];
  for (const o of mySideItems) {
    if (o.status !== 'PENDING') continue;
    const side = whichSide(o, scope);
    if (side === 'SOURCE') mySide.source++;
    else if (side === 'TARGET') mySide.target++;
    else if (side === 'BOTH') mySide.source++;
    else if (role === 'hq-admin') mySide.escalation++;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">📋 협의 중</h1>
          <div className="text-sm text-bf-muted mt-0.5">
            양측 협의가 모두 완료되면 자동으로 <a href="/logistics" className="text-bf-primary hover:underline">입출고 섹션</a>으로 이동.
          </div>
        </div>
        <div className="flex items-center gap-2">
          {queryRes.isFetching && <span className="text-xs text-bf-muted">갱신 중…</span>}
          <button
            type="button"
            className="bg-bf-primary text-white px-4 py-2 rounded font-medium text-sm hover:opacity-90 disabled:opacity-40"
            disabled={bulkBusy || items.length === 0}
            onClick={bulkApprove}
            title={role === 'hq-admin' ? '이 페이지의 PENDING 전체 강제 승인 (escalation · 양측 자동)' : '이 페이지의 PENDING 전체 자기 측 동의'}
          >{role === 'hq-admin' ? `⚡ 강제 승인 (${items.length})` : `⚡ 일괄 동의 (${items.length})`}</button>
        </div>
      </div>

      {/* 사용자별 overview card */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="bf-card p-3">
          <div className="text-xs text-bf-muted">전체 협의 대기</div>
          <div className="text-2xl font-semibold mt-0.5">{totalAll.toLocaleString()}</div>
        </div>
        <div className="bf-card p-3">
          <div className="text-xs text-bf-muted">📤 내 측이 출고</div>
          <div className="text-2xl font-semibold mt-0.5 text-bf-primary">{mySide.source.toLocaleString()}</div>
        </div>
        <div className="bf-card p-3">
          <div className="text-xs text-bf-muted">📥 내 측이 입고</div>
          <div className="text-2xl font-semibold mt-0.5 text-bf-success">{mySide.target.toLocaleString()}</div>
        </div>
        <div className="bf-card p-3">
          <div className="text-xs text-bf-muted">{role === 'hq-admin' ? '⚡ 강제 승인 대상' : '🔒 권한 없음'}</div>
          <div className="text-2xl font-semibold mt-0.5 text-bf-muted">{role === 'hq-admin' ? mySide.escalation.toLocaleString() : Math.max(0, totalAll - mySide.source - mySide.target).toLocaleString()}</div>
        </div>
      </div>

      <div className="bf-card p-2 space-y-2">
        <div className="flex gap-1 flex-wrap">
          {stages.map((s) => {
            // 탭별 카운트 — 항상 4 stage 모두 표시 (FF · stage filter 무시한 전체 stage_counts)
            const c = s.key === 'all' ? totalAll : (stageCounts[s.key] ?? 0);
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => setStage(s.key)}
                className={`px-3 py-1 text-xs rounded ${stage === s.key ? 'bg-bf-primary text-white' : 'bg-bf-surface text-bf-muted hover:text-bf-text'}`}
              >
                {s.label} ({c})
              </button>
            );
          })}
        </div>
        {/* 재분배 sub-tab — 입고/출고 분류 (REBALANCE 탭에서만 노출) */}
        {stage === 'REBALANCE' && (
          <div className="flex gap-1 flex-wrap pt-1 border-t border-bf-border">
            {(['all', 'inbound', 'outbound'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setRebalanceSide(k)}
                className={`px-3 py-1 text-xs rounded ${rebalanceSide === k ? 'bg-bf-primary text-white' : 'bg-bf-surface text-bf-muted hover:text-bf-text'}`}
              >{k === 'all' ? '전체' : k === 'inbound' ? '📥 내 측 입고' : '📤 내 측 출고'}</button>
            ))}
          </div>
        )}
        {/* 검색박스 3개 분리 (ISBN · 제목 · 매장) — client-side filter */}
        <div className="grid grid-cols-3 gap-2">
          <input
            type="text"
            value={qIsbn}
            onChange={(e) => setQIsbn(e.target.value)}
            placeholder="ISBN13"
            className="bf-input text-sm"
          />
          <input
            type="text"
            value={qTitle}
            onChange={(e) => setQTitle(e.target.value)}
            placeholder="제목"
            className="bf-input text-sm"
          />
          <input
            type="text"
            value={qStore}
            onChange={(e) => setQStore(e.target.value)}
            placeholder="매장 (출발·도착)"
            className="bf-input text-sm"
          />
        </div>
        {(qIsbn || qTitle || qStore) && (
          <button
            type="button"
            className="bf-btn-secondary text-xs self-start"
            onClick={() => { setQIsbn(''); setQTitle(''); setQStore(''); }}
          >검색 초기화</button>
        )}
      </div>

      <div className="bf-card divide-y divide-bf-border">
        {items.length === 0 ? (
          <div className="p-6 text-center text-sm text-bf-muted">
            {totalPending === 0 ? '협의 대기 중인 항목이 없습니다.' : `이 조건으로 표시할 항목이 없습니다 (전체 ${totalPending}건)`}
          </div>
        ) : (
          items.map((o) => {
            const side = whichSide(o, scope);
            const isHq = role === 'hq-admin';
            const canAct = isHq || side === 'SOURCE' || side === 'TARGET' || side === 'BOTH';
            const done = selfDone.has(o.order_id);
            const canEdit = isHq || side === 'SOURCE' || side === 'BOTH';  // qty/target 수정 권한
            return (
              <div key={o.order_id} className="p-3 flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">{ORDER_TYPE_KO[o.order_type] ?? o.order_type}</span>
                    {o.urgency_level && o.urgency_level !== 'NORMAL' && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-bf-warn/10 text-bf-warn border border-bf-warn/30">
                        {URGENCY_KO[o.urgency_level] ?? o.urgency_level}
                      </span>
                    )}
                    {side && side !== 'BOTH' && !isHq && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${side === 'SOURCE' ? 'bg-bf-primary/10 text-bf-primary border-bf-primary/30' : 'bg-bf-success/10 text-bf-success border-bf-success/30'}`}>
                        {side === 'SOURCE' ? '📤 내 측이 출고' : '📥 내 측이 입고'}
                      </span>
                    )}
                    {done && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-bf-success/10 text-bf-success border border-bf-success/30">
                        ✓ 내 측 처리 끝
                      </span>
                    )}
                  </div>
                  {o.title && (
                    <div className="text-sm text-bf-text mt-0.5 truncate">{o.title}</div>
                  )}
                  <div className="text-xs text-bf-muted mt-1 truncate">
                    ISBN {o.isbn13} · 수량 {o.qty}권 · {nameOf(o.source_location_id ?? undefined) ?? '외부'} → {nameOf(o.target_location_id ?? undefined) ?? '?'}
                  </div>
                </div>
                <div className="flex-shrink-0 flex items-center gap-2">
                  {canEdit && !done && (
                    <button
                      type="button"
                      className="px-3 py-1.5 text-xs rounded border border-bf-border bg-bf-surface hover:border-bf-primary hover:text-bf-primary transition"
                      onClick={() => setEditTarget({
                        order_id: o.order_id, isbn13: o.isbn13, qty: o.qty,
                        target_location_id: o.target_location_id,
                      })}
                      title="AI 추천 수정 (수량 · 매장)"
                    >✎ 수정</button>
                  )}
                  {canAct && !done ? (
                    <>
                      <button
                        type="button"
                        className="px-3 py-1.5 text-xs rounded bg-bf-primary text-white font-medium hover:opacity-90 disabled:opacity-40"
                        disabled={approveMu.isPending}
                        onClick={() => approveMu.mutate(o.order_id)}
                        title={role === 'hq-admin' ? '강제 승인 (양측 자동 · escalation)' : '내 측 동의'}
                      >{role === 'hq-admin' ? '⚡ 강제 승인' : '✓ 동의'}</button>
                      <button
                        type="button"
                        className="px-3 py-1.5 text-xs rounded border border-bf-danger/40 text-bf-danger bg-bf-danger/5 hover:bg-bf-danger/15 transition disabled:opacity-40"
                        disabled={rejectMu.isPending}
                        onClick={() => {
                          const reason = window.prompt('거부 사유');
                          if (reason) rejectMu.mutate({ id: o.order_id, reason });
                        }}
                      >✗ 거부</button>
                    </>
                  ) : !canAct ? (
                    <span className="text-xs text-bf-muted px-2 py-1">권한 없음</span>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* 페이지네이션 */}
      {totalPending > PAGE_SIZE && (
        <div className="flex items-center justify-between text-xs text-bf-muted">
          <span>{offset + 1}–{Math.min(offset + items.length, totalPending)} / {totalPending}건</span>
          <div className="flex gap-1">
            <button
              type="button"
              className="bf-btn-secondary text-xs"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >◀ 이전</button>
            <button
              type="button"
              className="bf-btn-secondary text-xs"
              disabled={offset + items.length >= totalPending}
              onClick={() => setPage((p) => p + 1)}
            >다음 ▶</button>
          </div>
        </div>
      )}

      {/* AI 추천 수정 modal */}
      {editTarget && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setEditTarget(null)}>
          <div className="bf-card max-w-md w-full p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold">✎ AI 추천 수정</h2>
            <div className="text-xs text-bf-muted">ISBN {editTarget.isbn13}</div>
            <label className="block">
              <span className="text-sm text-bf-muted">수량 (현재 {editTarget.qty})</span>
              <input
                type="number"
                value={editTarget.qty}
                onChange={(e) => setEditTarget({ ...editTarget, qty: Number(e.target.value) || 0 })}
                className="bf-input mt-1 w-full"
                min={1}
              />
            </label>
            <label className="block">
              <span className="text-sm text-bf-muted">대상 매장</span>
              <select
                value={editTarget.target_location_id ?? ''}
                onChange={(e) => setEditTarget({ ...editTarget, target_location_id: Number(e.target.value) || null })}
                className="bf-input mt-1 w-full"
              >
                {locItems.map((l) => (
                  <option key={l.location_id} value={l.location_id}>{l.name}</option>
                ))}
              </select>
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="bf-btn-secondary text-sm" onClick={() => setEditTarget(null)}>취소</button>
              <button
                type="button"
                className="bf-btn-primary text-sm"
                disabled={patchMu.isPending || editTarget.qty <= 0}
                onClick={() => patchMu.mutate({
                  qty: editTarget.qty,
                  target_location_id: editTarget.target_location_id ?? undefined,
                })}
              >저장</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
