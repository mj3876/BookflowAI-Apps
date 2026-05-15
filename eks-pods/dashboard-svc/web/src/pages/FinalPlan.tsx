import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import {
  fetchPlanItems,
  fetchPlanSummary,
  type PlanItem,
  type Role,
} from '../api';
import { ko, ORDER_TYPE_KO, URGENCY_KO, ORDER_STATUS_KO } from '../labels';
import EmptyState from '../components/EmptyState';
import HelpHint from '../components/HelpHint';
import Pagination from '../components/Pagination';
import SearchBox from '../components/SearchBox';
import StatusBadge from '../components/StatusBadge';

/**
 * 최종 계획안 — /plan-daily 발의 결과 한 화면.
 *
 *  - Tab 1 [전체 계획안]: order_type × status 매트릭스 (cell 클릭 → 하단 list)
 *  - Tab 2 [승인 진행]: PENDING + WH_TRANSFER 양측 진행률 + 최근 5분 APPROVED 타임라인
 *  - Tab 3 [실행 결과]: EXECUTED · REJECTED list (reject_reason 표시)
 *
 * snapshot_date default = D+1 KST. role/scope 자동 (backend decision-svc 처리).
 */

const ORDER_TYPES: { key: string; label: string }[] = [
  { key: 'WH_TO_STORE',     label: '🏬 매장 보충 (Stage 0)' },
  { key: 'REBALANCE',       label: '🔄 권역 내 재분배 (Stage 1)' },
  { key: 'WH_TRANSFER',     label: '🚛 권역 간 이동 (Stage 2)' },
  { key: 'PUBLISHER_ORDER', label: '📦 외부 발주 (Stage 3)' },
];

const STATUSES: { key: string; label: string; tone: string }[] = [
  { key: 'PENDING',       label: '대기 중',  tone: 'pill-pending' },
  { key: 'APPROVED',      label: '승인됨',   tone: 'pill-approved' },
  { key: 'EXECUTED',      label: '실행됨',   tone: 'pill-info' },
  { key: 'REJECTED',      label: '거절됨',   tone: 'pill-rejected' },
  { key: 'AUTO_EXECUTED', label: '자동 실행', tone: 'pill-info' },
];

// D+1 KST 계산 (today + 1)
function defaultSnapshotDate(): string {
  const now = new Date();
  // KST = UTC+9 — toLocaleDateString 의 ko-KR 가 KST 처리해줌
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  kst.setUTCDate(kst.getUTCDate() + 1);
  return kst.toISOString().slice(0, 10);
}

// Stage 별 LEAD_DAYS group — decision-svc LEAD_DAYS 와 동일 (UI 카드 라벨 + group 키)
const ARRIVAL_GROUPS: { days: number; label: string; types: string[] }[] = [
  { days: 1, label: '내일 도착 (D+1)',  types: ['WH_TO_STORE', 'REBALANCE'] },
  { days: 2, label: '모레 도착 (D+2)',  types: ['WH_TRANSFER'] },
  { days: 4, label: '4일 후 도착 (D+4)', types: ['PUBLISHER_ORDER'] },
];

export default function FinalPlan() {
  const { role } = useOutletContext<{ role: Role }>();
  const [snapshotDate, setSnapshotDate] = useState<string>(defaultSnapshotDate());
  const [tab, setTab] = useState<'all' | 'approval' | 'result' | 'arrival'>('all');
  const [searchQ, setSearchQ] = useState<string>('');
  // Tab 1 의 cell-driven 필터 (cell 클릭 시 set)
  const [cellFilter, setCellFilter] = useState<{ order_type?: string; status?: string }>({});
  // Tab 4 의 도착일 group 필터 (카드 클릭 시 set · undefined=전체)
  const [arrivalFilter, setArrivalFilter] = useState<number | undefined>(undefined);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 50;

  // summary — 매트릭스 카운트 (가벼움 · 30s refetch)
  const summary = useQuery({
    queryKey: ['plan-summary', role, snapshotDate],
    queryFn: () => fetchPlanSummary(role, snapshotDate),
    refetchInterval: tab === 'approval' ? 5_000 : 30_000,
    staleTime: 3_000,
  });

  // Tab 별 list query params
  const listParams = useMemo<{ status?: string; order_type?: string }>(() => {
    if (tab === 'all') return cellFilter;
    if (tab === 'approval') return { status: 'PENDING' };
    if (tab === 'arrival') {
      // 카드 클릭으로 group 필터 → 해당 group 의 order_type 중 하나만 backend 에 전달.
      // 한 group 이 여러 order_type (D+1: WH_TO_STORE + REBALANCE) 인 경우 client-side 추가 필터.
      if (arrivalFilter !== undefined) {
        const grp = ARRIVAL_GROUPS.find((g) => g.days === arrivalFilter);
        if (grp && grp.types.length === 1) {
          return { order_type: grp.types[0] };
        }
      }
      return {};
    }
    return {}; // 'result' tab — EXECUTED + REJECTED 둘 다 표시 (아래에서 client-side split)
  }, [tab, cellFilter, arrivalFilter]);

  const items = useQuery({
    queryKey: ['plan-items', role, snapshotDate, tab, listParams, searchQ, page],
    queryFn: () =>
      fetchPlanItems(role, snapshotDate, {
        ...listParams,
        q: searchQ || undefined,
        offset: (page - 1) * PAGE_SIZE,
        limit: PAGE_SIZE,
      }),
    refetchInterval: tab === 'approval' ? 5_000 : false,
    staleTime: 3_000,
  });

  // 'result' tab 은 REJECTED + EXECUTED 둘 다 보여줘야 함 — backend 가 single status 필터만 받음
  // → 시연 단순화: result 탭은 status 미지정 → 모두 받고 client-side 에서 EXECUTED + REJECTED 만 추림
  // (PENDING/APPROVED 는 다른 탭에서 처리)
  const rawItems = items.data?.items ?? [];
  const visibleItems: PlanItem[] = useMemo(() => {
    if (tab === 'result') {
      return rawItems.filter((it) => it.status === 'EXECUTED' || it.status === 'REJECTED');
    }
    if (tab === 'arrival' && arrivalFilter !== undefined) {
      const grp = ARRIVAL_GROUPS.find((g) => g.days === arrivalFilter);
      if (grp) {
        return rawItems.filter((it) => grp.types.includes(it.order_type));
      }
    }
    return rawItems;
  }, [tab, rawItems, arrivalFilter]);

  // 최근 5분 APPROVED — approval 탭 타임라인 용 (rawItems 가 PENDING 만이라 별도 query 필요)
  const recentApproved = useQuery({
    queryKey: ['plan-items-approved', role, snapshotDate],
    queryFn: () =>
      fetchPlanItems(role, snapshotDate, {
        status: 'APPROVED',
        offset: 0,
        limit: 50,
      }),
    enabled: tab === 'approval',
    refetchInterval: 5_000,
    staleTime: 3_000,
  });
  const approvedRecentItems = useMemo(() => {
    const list = recentApproved.data?.items ?? [];
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    return list
      .filter((it) => it.approved_at && new Date(it.approved_at).getTime() >= fiveMinAgo)
      .sort((a, b) => (b.approved_at ?? '').localeCompare(a.approved_at ?? ''))
      .slice(0, 10);
  }, [recentApproved.data]);

  // Tab 3 inventory delta summary — APPROVED/EXECUTED 의 source(-qty) / target(+qty) 합산.
  // EXECUTED 시점 target+qty 반영, APPROVED 만이면 source-qty 만 (입고 대기 중).
  // 별도 query 로 페이지네이션 무시하고 전체 fetch (limit=500 가정 — 시연 데이터 규모 OK).
  const resultItemsForDelta = useQuery({
    queryKey: ['plan-items-delta', role, snapshotDate],
    queryFn: () => fetchPlanItems(role, snapshotDate, { offset: 0, limit: 500 }),
    enabled: tab === 'result',
    staleTime: 10_000,
  });
  type DeltaRow = { name: string; delta: number };
  const inventoryDelta = useMemo<DeltaRow[]>(() => {
    const list = resultItemsForDelta.data?.items ?? [];
    const m = new Map<string, number>();
    for (const it of list) {
      if (it.status !== 'APPROVED' && it.status !== 'EXECUTED') continue;
      // source -qty (APPROVED 시점에 차감됨 · EXECUTED 후에도 유지)
      if (it.source_location_name) {
        m.set(it.source_location_name, (m.get(it.source_location_name) ?? 0) - it.qty);
      }
      // target +qty (EXECUTED 시점에 입고 — APPROVED 만 이면 운송 중 미반영)
      if (it.status === 'EXECUTED' && it.target_location_name) {
        m.set(it.target_location_name, (m.get(it.target_location_name) ?? 0) + it.qty);
      }
    }
    return Array.from(m.entries())
      .map(([name, delta]) => ({ name, delta }))
      .filter((r) => r.delta !== 0)
      .sort((a, b) => b.delta - a.delta);
  }, [resultItemsForDelta.data]);

  const totals = summary.data?.totals;
  const byStageStatus = summary.data?.by_stage_status ?? [];

  // cell count lookup
  const countOf = (order_type: string, status: string): number => {
    const r = byStageStatus.find((b) => b.order_type === order_type && b.status === status);
    return r?.cnt ?? 0;
  };
  const qtyOf = (order_type: string, status: string): number => {
    const r = byStageStatus.find((b) => b.order_type === order_type && b.status === status);
    return r?.qty_total ?? 0;
  };

  const onCellClick = (order_type: string, status: string) => {
    setCellFilter((prev) => {
      // 같은 cell 다시 누르면 해제
      if (prev.order_type === order_type && prev.status === status) return {};
      return { order_type, status };
    });
    setPage(1);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="h1">최종 계획안</h1>
          <p className="text-bf-muted text-xs mt-1">
            D+1 forecast 기반 익일 plan 발의 결과. 단계별 × 상태별 매트릭스에서 cell 을 누르면 상세 list 가 펼쳐집니다.
            role/scope 자동 (본사 전체 · 권역 매니저 자기 권역 · 매장 직원 자기 매장).
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <label className="text-xs text-bf-muted">계획 일자</label>
          <input
            type="date"
            className="ipt text-xs"
            value={snapshotDate}
            onChange={(e) => { setSnapshotDate(e.target.value); setPage(1); }}
          />
          <SearchBox
            placeholder="ISBN / 제목 / 매장 검색…"
            onSearch={(q) => { setSearchQ(q); setPage(1); }}
          />
        </div>
      </div>

      {/* Tab nav */}
      <div className="flex gap-2 border-b border-bf-border">
        {[
          { key: 'all',      label: '전체 계획안',     hint: '4 단계 (Stage 0~3) × 5 상태 매트릭스' },
          { key: 'approval', label: '승인 진행',       hint: '대기 중 + 최근 승인 타임라인' },
          { key: 'result',   label: '실행 결과',       hint: '완료 / 거절 (사유)' },
          { key: 'arrival',  label: '📅 도착 예정일별', hint: 'stage 별 lead time 반영 — D+1 / D+2 / D+4' },
        ].map((t) => (
          <button
            key={t.key}
            className={`px-4 py-2 text-sm border-b-2 -mb-px transition ${
              tab === t.key
                ? 'border-bf-primary text-bf-primary font-semibold'
                : 'border-transparent text-bf-muted hover:text-bf-text'
            }`}
            onClick={() => {
              setTab(t.key as 'all' | 'approval' | 'result' | 'arrival');
              setPage(1);
              setCellFilter({});
              setArrivalFilter(undefined);
            }}
            title={t.hint}
          >
            {t.label}
          </button>
        ))}
      </div>

      {summary.isLoading && (
        <div className="card-tight text-xs text-bf-muted">매트릭스 조회 중…</div>
      )}

      {summary.isError && (
        <div className="card-tight text-xs text-bf-danger">
          매트릭스 조회 실패 — decision-svc 응답 없음. plan-daily 가 아직 발의되지 않았을 수 있어요.
        </div>
      )}

      {/* Totals summary */}
      {totals && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="metric-card">
            <div className="text-[11px] text-bf-muted">총 plan</div>
            <div className="metric-value">{totals.total_orders}건</div>
            <div className="text-[10px] text-bf-muted">{totals.total_qty.toLocaleString()}권</div>
          </div>
          <div className="metric-card">
            <div className="text-[11px] text-bf-muted">대기 / 승인</div>
            <div className="metric-value">
              {totals.statuses.PENDING ?? 0}
              <span className="text-sm text-bf-muted"> / {(totals.statuses.APPROVED ?? 0) + (totals.statuses.AUTO_EXECUTED ?? 0)}</span>
            </div>
            <div className="text-[10px] text-bf-muted">PENDING · APPROVED+AUTO</div>
          </div>
          <div className="metric-card">
            <div className="text-[11px] text-bf-muted">실행됨</div>
            <div className="metric-value">{totals.statuses.EXECUTED ?? 0}</div>
            <div className="text-[10px] text-bf-muted">EXECUTED</div>
          </div>
          <div className="metric-card">
            <div className="text-[11px] text-bf-muted">거절됨</div>
            <div className="metric-value">{totals.statuses.REJECTED ?? 0}</div>
            <div className="text-[10px] text-bf-muted">REJECTED</div>
          </div>
        </div>
      )}

      {/* Tab 1 — 매트릭스 */}
      {tab === 'all' && (
        <div className="card">
          <div className="flex items-center gap-2 mb-2">
            <h2 className="h2 flex items-center">
              단계 × 상태 매트릭스
              <HelpHint text="cell 을 누르면 해당 (단계, 상태) row 만 하단 list 에 표시됩니다. 다시 누르면 해제." />
            </h2>
            {(cellFilter.order_type || cellFilter.status) && (
              <button
                className="btn-secondary btn-sm ml-2"
                onClick={() => { setCellFilter({}); setPage(1); }}
              >
                필터 해제
              </button>
            )}
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th className="text-left">단계 / 상태</th>
                {STATUSES.map((s) => (
                  <th key={s.key} className="text-right" title={s.key}>{s.label}</th>
                ))}
                <th className="text-right">합계</th>
              </tr>
            </thead>
            <tbody>
              {ORDER_TYPES.map((ot) => {
                const rowTotal = STATUSES.reduce((acc, s) => acc + countOf(ot.key, s.key), 0);
                return (
                  <tr key={ot.key}>
                    <td className="font-medium">{ot.label}</td>
                    {STATUSES.map((s) => {
                      const cnt = countOf(ot.key, s.key);
                      const qty = qtyOf(ot.key, s.key);
                      const selected = cellFilter.order_type === ot.key && cellFilter.status === s.key;
                      return (
                        <td key={s.key} className="text-right">
                          <button
                            className={`px-2 py-1 rounded text-xs transition ${
                              cnt === 0
                                ? 'text-bf-muted cursor-default'
                                : selected
                                  ? 'bg-bf-primary text-white font-semibold'
                                  : 'bg-bf-panel2 hover:bg-bf-panel text-bf-text'
                            }`}
                            disabled={cnt === 0}
                            onClick={() => cnt > 0 && onCellClick(ot.key, s.key)}
                            title={cnt > 0 ? `${cnt}건 · ${qty.toLocaleString()}권` : '없음'}
                          >
                            {cnt}
                          </button>
                        </td>
                      );
                    })}
                    <td className="text-right text-bf-muted">{rowTotal}</td>
                  </tr>
                );
              })}
              <tr className="border-t-2 border-bf-border">
                <td className="font-semibold">합계</td>
                {STATUSES.map((s) => {
                  const colTotal = ORDER_TYPES.reduce((acc, ot) => acc + countOf(ot.key, s.key), 0);
                  return <td key={s.key} className="text-right text-bf-muted">{colTotal}</td>;
                })}
                <td className="text-right font-semibold">{totals?.total_orders ?? 0}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* Tab 2 — WH_TRANSFER 양측 진행률 + 승인 타임라인 */}
      {tab === 'approval' && totals && (
        <>
          <div className="card">
            <h2 className="h2">권역 간 이동 (WH_TRANSFER) 양측 진행률</h2>
            <p className="text-xs text-bf-muted mb-3">
              WH_TRANSFER 는 source / target 양측 매니저 승인이 모두 완료되어야 status=APPROVED 가 됩니다.
              아래는 현재 (단순화) 단측 처리 카운트.
            </p>
            {(() => {
              const wt = ORDER_TYPES.find((o) => o.key === 'WH_TRANSFER')!;
              const pending = countOf(wt.key, 'PENDING');
              const approved = countOf(wt.key, 'APPROVED');
              const executed = countOf(wt.key, 'EXECUTED');
              const rejected = countOf(wt.key, 'REJECTED');
              const total = pending + approved + executed + rejected;
              const ratio = total > 0 ? (approved + executed) / total : 0;
              return (
                <div className="space-y-2">
                  <div className="flex items-center gap-3 text-xs">
                    <span className="text-bf-muted">전체 {total}건</span>
                    <span className="text-bf-warning">대기 {pending}</span>
                    <span className="text-bf-success">승인+실행 {approved + executed}</span>
                    <span className="text-bf-danger">거절 {rejected}</span>
                  </div>
                  <div className="w-full h-2 bg-bf-panel2 rounded overflow-hidden">
                    <div
                      className="h-full bg-bf-success transition-all"
                      style={{ width: `${ratio * 100}%` }}
                      title={`승인+실행 비율 ${(ratio * 100).toFixed(1)}%`}
                    />
                  </div>
                </div>
              );
            })()}
          </div>

          <div className="card">
            <h2 className="h2">최근 5분 승인 (APPROVED) 타임라인</h2>
            {approvedRecentItems.length === 0 ? (
              <EmptyState message="최근 5분 내 승인 없음" hint="5초마다 자동 갱신됩니다" />
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>승인 일시</th>
                    <th>단계</th>
                    <th>도서</th>
                    <th>출발 → 도착</th>
                    <th className="text-right">수량</th>
                  </tr>
                </thead>
                <tbody>
                  {approvedRecentItems.map((it) => (
                    <tr key={it.order_id}>
                      <td className="text-bf-muted text-[11px]">
                        {it.approved_at ? new Date(it.approved_at).toLocaleString('ko-KR') : '-'}
                      </td>
                      <td>{ko(ORDER_TYPE_KO, it.order_type)}</td>
                      <td>
                        <div className="text-sm">{it.title ?? it.isbn13}</div>
                        <div className="font-mono text-[10px] text-bf-muted">{it.isbn13}</div>
                      </td>
                      <td className="text-[11px]">
                        {it.source_location_name ?? '(출판사)'} → {it.target_location_name ?? '-'}
                      </td>
                      <td className="text-right">{it.qty}권</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {/* Tab 4 — 도착 예정일별 카드 (stage 별 lead time 반영) */}
      {tab === 'arrival' && (
        <div className="card">
          <div className="flex items-center gap-2 mb-2">
            <h2 className="h2 flex items-center">
              📅 도착 예정일별 보기
              <HelpHint text="발의 (승인) 는 모두 발의일에 결정됩니다. 입고 (도착) 만 stage 별 lead time 에 발생: D+1 (매장 보충/재분배) · D+2 (권역간 이동) · D+4 (외부 발주)." />
            </h2>
            {arrivalFilter !== undefined && (
              <button
                className="btn-secondary btn-sm ml-2"
                onClick={() => { setArrivalFilter(undefined); setPage(1); }}
              >
                필터 해제
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {ARRIVAL_GROUPS.map((g) => {
              const cnt = g.types.reduce(
                (acc, ot) =>
                  acc + STATUSES.reduce((a, s) => a + countOf(ot, s.key), 0),
                0,
              );
              const qty = g.types.reduce(
                (acc, ot) =>
                  acc + STATUSES.reduce((a, s) => a + qtyOf(ot, s.key), 0),
                0,
              );
              const selected = arrivalFilter === g.days;
              const typeLabels = g.types.map((t) => ko(ORDER_TYPE_KO, t)).join(' / ');
              return (
                <button
                  key={g.days}
                  className={`metric-card text-left transition ${
                    cnt === 0
                      ? 'opacity-60 cursor-not-allowed'
                      : selected
                        ? 'border-bf-primary ring-2 ring-bf-primary'
                        : 'hover:border-bf-primary'
                  }`}
                  disabled={cnt === 0}
                  onClick={() => {
                    if (cnt === 0) return;
                    setArrivalFilter((prev) => (prev === g.days ? undefined : g.days));
                    setPage(1);
                  }}
                  title={`${g.label} · ${typeLabels}`}
                >
                  <div className="metric-label">{g.label}</div>
                  <div className="metric-value">{cnt}건</div>
                  <div className="text-[11px] text-bf-muted mt-1">
                    {qty.toLocaleString()}권 · {typeLabels}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="text-[11px] text-bf-muted mt-2">
            카드 클릭 시 해당 도착일의 plan list 가 아래에 표시됩니다.
          </div>
        </div>
      )}

      {/* Tab 3 inventory delta summary — APPROVED/EXECUTED 의 source(-) / target(+) 합산 */}
      {tab === 'result' && inventoryDelta.length > 0 && (
        <div className="card">
          <h2 className="h2 flex items-center gap-1">
            📦 {snapshotDate} 재고 변동 요약
            <HelpHint text="APPROVED → source -qty, EXECUTED → target +qty 합산 (운송 중인 APPROVED 는 target 미반영)" />
          </h2>
          <div className="flex flex-wrap gap-2 mt-2">
            {inventoryDelta.map((r) => {
              const positive = r.delta > 0;
              return (
                <span
                  key={r.name}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs border ${
                    positive
                      ? 'bg-bf-successbg text-bf-success border-green-300'
                      : 'bg-bf-dangerbg text-bf-danger border-red-300'
                  }`}
                  title={`${r.name} ${positive ? '+' : ''}${r.delta}권`}
                >
                  <span className="font-medium">{r.name}</span>
                  <span className="font-mono font-bold">
                    {positive ? '+' : ''}{r.delta}
                  </span>
                </span>
              );
            })}
          </div>
          <div className="text-[10px] text-bf-muted mt-2">
            총 {inventoryDelta.length} location · 표시 ≠ 0 만
          </div>
        </div>
      )}

      {/* Items list — Tab 1 (cell 클릭 시) · Tab 2 (PENDING) · Tab 3 (EXECUTED + REJECTED) */}
      <div className="card">
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <h2 className="h2">
            {tab === 'all' && (cellFilter.order_type || cellFilter.status)
              ? `상세 list (${ko(ORDER_TYPE_KO, cellFilter.order_type ?? '')} / ${ko(ORDER_STATUS_KO, cellFilter.status ?? '')})`
              : tab === 'all'
                ? '전체 plan (단계 × 상태 cell 을 누르면 필터됩니다)'
                : tab === 'approval'
                  ? '대기 중 (PENDING) list — 5초마다 자동 갱신'
                  : tab === 'arrival'
                    ? (arrivalFilter !== undefined
                        ? `상세 list (${ARRIVAL_GROUPS.find((g) => g.days === arrivalFilter)?.label})`
                        : '전체 plan (도착일 카드를 누르면 필터됩니다)')
                    : '실행 결과 (EXECUTED + REJECTED)'}
          </h2>
          {items.data && (
            <span className="text-xs text-bf-muted">
              총 {items.data.total.toLocaleString()}건
              {tab === 'result' && (
                <span className="ml-1">· 표시 {visibleItems.length}건</span>
              )}
            </span>
          )}
        </div>

        {items.isLoading ? (
          <div className="text-xs text-bf-muted py-6 text-center">조회 중…</div>
        ) : visibleItems.length === 0 ? (
          <EmptyState
            message={tab === 'approval' ? '대기 중 항목 없음' : '해당 조건의 plan 이 없습니다'}
            hint={tab === 'all' && !cellFilter.order_type ? 'cell 을 눌러 필터하거나, 검색어를 입력하세요' : undefined}
          />
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>긴급도</th>
                <th>단계</th>
                <th>상태</th>
                <th>도서</th>
                <th>출발 → 도착</th>
                <th className="text-right">수량</th>
                <th>생성</th>
                {tab === 'arrival' && <th>도착 예정일</th>}
                {tab === 'result' && <th>처리 일시 / 사유</th>}
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((it) => {
                return (
                  <tr key={it.order_id}>
                    <td>
                      <span className={
                        it.urgency_level === 'CRITICAL' ? 'pill-rejected' :
                        it.urgency_level === 'URGENT' ? 'pill-pending' : 'pill-info'
                      }>
                        {ko(URGENCY_KO, it.urgency_level ?? '')}
                      </span>
                    </td>
                    <td className="text-[11px]">{ko(ORDER_TYPE_KO, it.order_type)}</td>
                    <td>
                      <StatusBadge
                        status={it.status as any}
                        orderType={it.order_type as any}
                        approvedAt={it.approved_at}
                      />
                    </td>
                    <td>
                      <div className="text-sm">{it.title ?? it.isbn13}</div>
                      <div className="font-mono text-[10px] text-bf-muted">{it.isbn13}</div>
                    </td>
                    <td className="text-[11px]">
                      {it.source_location_name ?? '(출판사)'} → {it.target_location_name ?? '-'}
                    </td>
                    <td className="text-right">{it.qty}권</td>
                    <td className="text-bf-muted text-[10px]">
                      {it.created_at ? new Date(it.created_at).toLocaleString('ko-KR') : '-'}
                    </td>
                    {tab === 'arrival' && (
                      <td className="text-[11px] font-medium text-bf-primary">
                        {it.expected_arrival_date ?? '-'}
                      </td>
                    )}
                    {tab === 'result' && (
                      <td className="text-[10px]">
                        {it.status === 'EXECUTED' && it.executed_at && (
                          <span className="text-bf-muted">{new Date(it.executed_at).toLocaleString('ko-KR')}</span>
                        )}
                        {it.status === 'REJECTED' && (
                          <span className="text-bf-danger">{it.reject_reason ?? '사유 없음'}</span>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {items.data && items.data.total > PAGE_SIZE && (
          <Pagination
            total={items.data.total}
            page={page}
            pageSize={PAGE_SIZE}
            onChange={setPage}
          />
        )}
      </div>
    </div>
  );
}
