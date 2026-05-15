import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchPending, fetchPendingSummary, type PendingOrder, type Role } from '../api';
import SearchBox from './SearchBox';

/**
 * 일자별 상세 history view — Approval/Decision/WhApprove/WhInstructions 공통.
 *
 * 효율 설계 (사용자 지적 2026-05-13):
 *   "일자별로 들어갈 때 그 날짜만 불러와야 함. 통째로 365일 불러오는 거 미친짓."
 * → 2 query 분리:
 *    1) summary  : 일자별 status count (가벼움 · 365일 OK · 60s stale)
 *    2) detail   : 선택된 일자만 row fetch (오늘만 5s refetch · 과거는 영구 cache)
 *
 * 디자인:
 *  - 상단 pill row: [전체] [오늘 (D-0)] [5/12 (D-1)] ... [5/07 (D-6)]
 *  - 일자 선택 시: detail query 가 lazy fetch
 *  - D-0 선택 시: 부모가 전달한 todayActions 영역 표시 (전체 승인 / 일괄 발의 등)
 */

type OrderTypeOpt = 'WH_TO_STORE' | 'REBALANCE' | 'WH_TRANSFER' | 'PUBLISHER_ORDER';

type HistoryItem = {
  status?: string | null;
  created_at?: string | null;
  approved_at?: string | null;
  executed_at?: string | null;
};

/**
 * 2 가지 모드:
 *  - "lazy" (role 지정): summary + 일자별 detail 을 컴포넌트가 직접 fetch (pending_orders 전용)
 *  - "items" (items 지정): 부모가 통째 items 전달 후 클라이언트 측 일자별 filter (WhInstructions 등 다른 endpoint 용 fallback)
 */
type LazyProps = {
  role: Role;
  /** PUBLISHER_ORDER | REBALANCE | WH_TRANSFER · 미지정 시 전체 */
  order_type?: OrderTypeOpt;
  /** hq-admin 이 명시한 wh scope (wh-manager 는 backend 자동) */
  wh_id?: number;
  items?: never;
};
type ItemsProps<T extends HistoryItem> = {
  /** 부모가 통째 items 전달 (lazy 모드 X · WhInstructions fallback 등) */
  items: T[];
  role?: never;
  order_type?: never;
  wh_id?: never;
};

type CommonProps<T> = {
  days?: number;          // 과거 일자 수 (default 6 — 오늘 D-0 포함 시 7일치)
  children: (
    items: T[],
    meta: {
      selectedKey: string;
      isToday: boolean;
      isAll: boolean;
      viewMode: 'list' | 'map';
      isLoading: boolean;
    },
  ) => ReactNode;
  /** D-0 선택 시 children 위에 표시할 액션 영역 (전체 승인 버튼 등) */
  todayActions?: ReactNode;
  /** 페이지 제목 (헤더 우측 pill 옆) */
  pageLabel?: string;
};

type Props<T extends HistoryItem> = CommonProps<T> & (LazyProps | ItemsProps<T>);

const STATUSES = ['all', 'PENDING', 'APPROVED', 'EXECUTED', 'REJECTED'] as const;
type StatusFilter = typeof STATUSES[number];

const STATUS_KO: Record<string, string> = {
  all: '전체',
  PENDING: '처리 대기',
  APPROVED: '승인',
  EXECUTED: '실행 완료',
  REJECTED: '거절',
};

function dateKey(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  return kst.toISOString().slice(0, 10);
}

function todayKstKey(): string {
  return dateKey(new Date().toISOString())!;
}

function dayLabel(key: string, offset: number): { primary: string; secondary: string } {
  if (offset === 0) return { primary: '오늘', secondary: 'D-0' };
  const [, mm, dd] = key.split('-');
  if (offset === -1) return { primary: `${parseInt(mm)}/${parseInt(dd)}`, secondary: '' };
  return { primary: `${parseInt(mm)}/${parseInt(dd)}`, secondary: `D-${offset}` };
}

function pickTimestamp<T extends HistoryItem>(it: T): string | null | undefined {
  return it.approved_at ?? it.executed_at ?? it.created_at ?? null;
}

export default function DateHistoryTabs<T extends HistoryItem = PendingOrder>(props: Props<T>) {
  const {
    days = 6,
    children,
    pageLabel,
    todayActions,
  } = props;
  const lazyMode = props.items === undefined;
  const role = (props as LazyProps).role;
  const order_type = (props as LazyProps).order_type;
  const wh_id = (props as LazyProps).wh_id;
  const providedItems = (props as ItemsProps<T>).items;
  // 최근 12개월 list (월 picker 드롭다운용)
  const monthOptions = useMemo(() => {
    const now = new Date();
    const list: { key: string; label: string }[] = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const label = i === 0 ? `이번 달 (${key})` : key;
      list.push({ key, label });
    }
    return list;
  }, []);

  const [selectedMonth, setSelectedMonth] = useState(monthOptions[0].key);
  const isCurrentMonth = selectedMonth === monthOptions[0].key;

  // 일자 키 list — 이번 달이면 오늘 + 과거 days 일, 다른 달이면 그 달의 일자 전체 (최신 먼저)
  const dayKeys = useMemo(() => {
    if (isCurrentMonth) {
      const list: { key: string; offset: number }[] = [];
      for (let i = 0; i <= days; i++) {
        const d = new Date(Date.now() - i * 86400 * 1000);
        list.push({ key: dateKey(d.toISOString())!, offset: i });
      }
      return list;
    }
    const [y, m] = selectedMonth.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const list: { key: string; offset: number }[] = [];
    for (let d = daysInMonth; d >= 1; d--) {
      const key = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      list.push({ key, offset: -1 });
    }
    return list;
  }, [days, selectedMonth, isCurrentMonth]);

  const todayKey = todayKstKey();
  const [selectedKey, setSelectedKey] = useState<string>(todayKey);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [viewMode, setViewMode] = useState<'list' | 'map'>('list');
  // P1 검색 — backend intervention-svc /queue 의 q 파라미터 (isbn / title / location)
  const [searchQ, setSearchQ] = useState<string>('');

  const isAll = selectedKey === 'all';
  const isToday = selectedKey === todayKey;

  // 1) summary — 일자별 카운트만 (lazy 모드 전용 · 가벼움)
  const summary = useQuery({
    queryKey: ['pending-summary', role, order_type ?? null, wh_id ?? null],
    queryFn: () => fetchPendingSummary(role!, { days: 365, order_type, wh_id }),
    staleTime: 60_000,
    refetchInterval: 30_000,
    enabled: lazyMode,
  });

  // 2) detail — 선택된 일자만 (lazy) + 페이지네이션 (page=1 부터 · 100 row/page)
  //    isAll 모드: PENDING 만 보여줌 (오늘 처리 대기 + 시점 무관)
  //    isToday   : date 없이 PENDING default · 5초 refetch
  //    과거 일자 : date=key · 영구 cache (refetch 없음)
  const PAGE_SIZE = 100;
  const [page, setPage] = useState(1);
  // 일자/필터/검색어 바뀌면 page 1 로 reset
  useEffect(() => { setPage(1); }, [selectedKey, statusFilter, order_type, wh_id, searchQ]);
  const detailKey = isAll || isToday ? '__today__' : selectedKey;
  const detail = useQuery({
    queryKey: ['pending-detail', role, order_type ?? null, wh_id ?? null, detailKey, page, searchQ],
    queryFn: () => {
      const opts = {
        order_type, wh_id,
        limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE,
        q: searchQ || undefined,
      };
      if (isAll || isToday) return fetchPending(role!, opts);
      return fetchPending(role!, { ...opts, date: selectedKey });
    },
    refetchInterval: isAll || isToday ? 5_000 : false,
    staleTime: isAll || isToday ? 0 : Infinity,
    enabled: lazyMode,
  });

  // lazy 모드: detail.data?.items / items 모드: 부모가 전달 + 클라이언트 측 일자 filter
  const allRawItems: T[] = useMemo(() => {
    if (lazyMode) return (detail.data?.items ?? []) as unknown as T[];
    return providedItems ?? [];
  }, [lazyMode, detail.data, providedItems]);

  // items 모드에서는 클라이언트 측에서 일자별 filter (lazy 모드는 이미 그 일자 row 만 들어 있음)
  const dayItems = useMemo(() => {
    if (lazyMode) return allRawItems;  // 이미 그 일자만 fetch 됨
    if (isAll) return allRawItems;
    return allRawItems.filter((it) => dateKey(pickTimestamp(it)) === selectedKey);
  }, [lazyMode, allRawItems, selectedKey, isAll]);

  // status 토글 적용
  const filtered = useMemo(() => {
    if (statusFilter === 'all') return dayItems;
    return dayItems.filter((it) => it.status === statusFilter);
  }, [dayItems, statusFilter]);

  // pill row count
  //  - lazy 모드: summary 의 그 일자 total
  //  - items 모드: 클라이언트 측 카운트 (items 통째 가지고 있음)
  const itemsDayStats = useMemo(() => {
    if (lazyMode) return new Map<string, number>();
    const m = new Map<string, number>();
    for (const it of allRawItems) {
      const k = dateKey(pickTimestamp(it));
      if (!k) continue;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }, [lazyMode, allRawItems]);

  const dayCount = (key: string): number => {
    if (lazyMode) {
      const r = summary.data?.items.find((i) => i.date === key);
      return r?.total ?? 0;
    }
    return itemsDayStats.get(key) ?? 0;
  };

  // 헤더 status 분포
  //  - lazy 모드: summary 의 선택 일자 row 사용 (전체 day count · 페이지 무관)
  //  - items 모드: 클라이언트 측 카운트 (items 통째 보유)
  const counts = useMemo(() => {
    if (lazyMode && summary.data) {
      const r = summary.data.items.find((i) => i.date === selectedKey);
      if (r) {
        return {
          PENDING: r.PENDING ?? 0,
          APPROVED: r.APPROVED ?? 0,
          EXECUTED: r.EXECUTED ?? 0,
          REJECTED: r.REJECTED ?? 0,
          total: r.total ?? 0,
        };
      }
    }
    const c = { PENDING: 0, APPROVED: 0, EXECUTED: 0, REJECTED: 0, total: dayItems.length };
    for (const it of dayItems) {
      if (it.status && it.status in c) (c as Record<string, number>)[it.status]++;
    }
    return c;
  }, [lazyMode, summary.data, selectedKey, dayItems]);

  // 페이지네이션 — detail 응답의 total (전체 row 수 · 필터 적용 후) 기반
  const dayTotal = lazyMode
    ? (detail.data?.total ?? counts.total ?? 0)
    : dayItems.length;
  const totalPages = Math.max(1, Math.ceil(dayTotal / PAGE_SIZE));

  // 전체 row count
  const totalAll = useMemo(() => {
    if (lazyMode) {
      if (!summary.data) return 0;
      return summary.data.items.reduce((acc, i) => acc + i.total, 0);
    }
    return allRawItems.length;
  }, [lazyMode, summary.data, allRawItems]);

  return (
    <div className="flex flex-col gap-3">
      {/* 일자 selector pill row */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {pageLabel && (
          <span className="px-2 py-1 text-[11px] rounded bg-bf-panel2 text-bf-muted mr-1">📅 {pageLabel}</span>
        )}
        <select
          className="px-2 py-1 rounded text-xs bg-bf-panel2 text-bf-text border border-bf-border"
          value={selectedMonth}
          onChange={(e) => setSelectedMonth(e.target.value)}
        >
          {monthOptions.map((m) => (
            <option key={m.key} value={m.key}>{m.label}</option>
          ))}
        </select>
        <button
          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            isAll ? 'bg-bf-primary text-white' : 'bg-bf-panel2 text-bf-muted hover:bg-bf-panel'
          }`}
          onClick={() => setSelectedKey('all')}
          title={lazyMode ? '현재 처리 대기 (PENDING) 만 표시' : '전체 표시'}
        >
          {lazyMode
            ? `처리 대기 (${summary.data?.items.find((i) => i.date === todayKey)?.PENDING ?? counts.PENDING})`
            : `전체 (${allRawItems.length})`}
        </button>
        {dayKeys.map(({ key, offset }) => {
          const { primary, secondary } = dayLabel(key, offset);
          const count = dayCount(key);
          const selected = selectedKey === key;
          return (
            <button
              key={key}
              className={`px-2.5 py-1 rounded text-xs transition-colors text-left ${
                selected ? 'bg-bf-primary text-white' : 'bg-bf-panel2 text-bf-muted hover:bg-bf-panel'
              }`}
              onClick={() => setSelectedKey(key)}
              title={`${key} 처리 ${count}건`}
            >
              <span className="font-semibold">{primary}</span>
              <span className={`ml-1 text-[10px] ${selected ? 'text-white/80' : 'text-bf-muted'}`}>
                {secondary}
              </span>
              {count > 0 && (
                <span className={`ml-1.5 text-[10px] ${selected ? 'text-white/90' : 'text-bf-muted'}`}>
                  · {count}
                </span>
              )}
            </button>
          );
        })}
        <span className="ml-2 text-[10px] text-bf-muted">
          {lazyMode
            ? `(요약 ${totalAll}건 · ${summary.isLoading ? '집계 중…' : `${summary.data?.items.length ?? 0}일`})`
            : `(총 ${totalAll}건)`}
        </span>
        {lazyMode && (
          <div className="ml-auto">
            <SearchBox
              placeholder="ISBN / 제목 / 매장 검색…"
              onSearch={setSearchQ}
            />
          </div>
        )}
      </div>

      {/* 선택된 일자 헤더 + status 토글 */}
      <div className="card !py-2 !px-3 flex items-center gap-3 flex-wrap">
        <span className="text-sm font-semibold text-bf-text">
          {isAll
            ? (lazyMode ? `📅 현재 처리 대기` : `📅 전체 (최근 ${days + 1}일)`)
            : isToday
              ? `📅 오늘 (D-0)`
              : `📅 ${selectedKey}`}
        </span>
        <span className="text-xs text-bf-muted">
          {lazyMode && detail.isLoading ? '조회 중…' : (
            <>
              처리 {counts.total}건
              {counts.total > 0 && (
                <>
                  {' · '}
                  <span className="text-bf-warning">대기 {counts.PENDING}</span>
                  {' · '}
                  <span className="text-bf-success">승인 {counts.APPROVED}</span>
                  {' · '}
                  <span className="text-bf-muted">실행 {counts.EXECUTED}</span>
                  {' · '}
                  <span className="text-bf-danger">거절 {counts.REJECTED}</span>
                </>
              )}
            </>
          )}
        </span>
        {!isAll && counts.total > 0 && counts.PENDING === 0 && (
          <span className="px-1.5 py-0.5 rounded text-[10px] bg-bf-success/20 text-bf-success font-medium">
            ✅ 최종 계획안
          </span>
        )}
        <div className="flex-1" />
        <div className="flex items-center gap-1">
          {STATUSES.map((s) => (
            <button
              key={s}
              className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
                statusFilter === s ? 'bg-bf-text text-bf-bg' : 'bg-bf-panel2 text-bf-muted hover:bg-bf-panel'
              }`}
              onClick={() => setStatusFilter(s)}
            >
              {STATUS_KO[s]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 ml-2 border-l border-bf-border pl-2">
          <button
            className={`px-2 py-0.5 rounded text-[11px] ${viewMode === 'list' ? 'bg-bf-text text-bf-bg' : 'bg-bf-panel2 text-bf-muted'}`}
            onClick={() => setViewMode('list')}
          >📋 리스트</button>
          <button
            className={`px-2 py-0.5 rounded text-[11px] ${viewMode === 'map' ? 'bg-bf-text text-bf-bg' : 'bg-bf-panel2 text-bf-muted'}`}
            onClick={() => setViewMode('map')}
          >🗺️ 지도</button>
        </div>
      </div>

      {/* 오늘 액션 영역 (D-0 only) */}
      {isToday && todayActions}

      {/* children 으로 filtered items 전달 */}
      {children(filtered, {
        selectedKey,
        isToday,
        isAll,
        viewMode,
        isLoading: lazyMode ? detail.isLoading : false,
      })}

      {/* 페이지네이션 컨트롤 — lazy 모드 + 전체 > PAGE_SIZE 일 때만 */}
      {lazyMode && dayTotal > PAGE_SIZE && (
        <div className="flex items-center justify-center gap-3 text-xs py-2">
          <button
            className="btn-secondary btn-sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >← 이전</button>
          <span className="text-bf-muted">
            페이지 <b className="text-bf-text">{page}</b> / {totalPages}
            <span className="ml-2">(총 {dayTotal}건 · {PAGE_SIZE}건씩)</span>
          </span>
          <button
            className="btn-secondary btn-sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >다음 →</button>
        </div>
      )}
    </div>
  );
}
