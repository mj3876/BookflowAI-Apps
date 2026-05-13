import { useMemo, useState, type ReactNode } from 'react';

/**
 * 일자별 상세 history view — Approval/Decision/WhApprove/WhInstructions 공통.
 *
 * 사용자 요구 (2026-05-13):
 *   "매일 매일 하는 업무니까 과거기록을 상세하게 볼 수 가 있어야하잖아"
 * → summary 가 아니라 일자 selector + 그 날의 전체 row 상세 테이블.
 *
 * 디자인:
 *  - 상단 pill row: [전체] [오늘 (D-0)] [5/12 (D-1)] ... [5/07 (D-6)]
 *  - 일자 선택 시: children 에 그 날 filtered items 전달 + status 토글 적용
 *  - D-0 선택 시: 부모가 전달한 todayActions 영역 표시 (전체 승인 / 일괄 발의 등)
 *
 * 데이터 모델: pending_orders 의 처리 시점 = approved_at | executed_at | created_at 폴백.
 */

type HistoryItem = {
  status?: string | null;
  created_at?: string | null;
  approved_at?: string | null;
  executed_at?: string | null;
};

type Props<T extends HistoryItem> = {
  items: T[];
  days?: number;          // 과거 일자 수 (default 6 — 오늘 D-0 포함 시 7일치)
  children: (filtered: T[], meta: { selectedKey: string; isToday: boolean; isAll: boolean }) => ReactNode;
  /** D-0 선택 시 children 위에 표시할 액션 영역 (전체 승인 버튼 등) */
  todayActions?: ReactNode;
  /** 페이지 제목 (헤더 우측 pill 옆) */
  pageLabel?: string;
};

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

function pickTimestamp<T extends HistoryItem>(item: T): string | null | undefined {
  // 처리 시점 우선순위: approved_at → executed_at → created_at
  return item.approved_at ?? item.executed_at ?? item.created_at ?? null;
}

function dayLabel(key: string, offset: number): { primary: string; secondary: string } {
  // 오늘 = D-0, 어제 = D-1, ...
  if (offset === 0) return { primary: '오늘', secondary: 'D-0' };
  // YYYY-MM-DD → MM/DD
  const [, mm, dd] = key.split('-');
  return { primary: `${parseInt(mm)}/${parseInt(dd)}`, secondary: `D-${offset}` };
}

export default function DateHistoryTabs<T extends HistoryItem>({
  items,
  days = 6,
  children,
  todayActions,
  pageLabel,
}: Props<T>) {
  // 오늘 (KST) 기준 일자 키 list — 오늘 + 과거 days 일
  const dayKeys = useMemo(() => {
    const todayKey = dateKey(new Date().toISOString())!;
    const list: { key: string; offset: number }[] = [];
    for (let i = 0; i <= days; i++) {
      const d = new Date(Date.now() - i * 86400 * 1000);
      list.push({ key: dateKey(d.toISOString())!, offset: i });
    }
    return list;
  }, [days]);

  const todayKey = dayKeys[0].key;
  const [selectedKey, setSelectedKey] = useState<string>(todayKey);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  // 일자별 stats (모든 status · pill 옆 카운트용)
  const dayStats = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of items) {
      const k = dateKey(pickTimestamp(it));
      if (!k) continue;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }, [items]);

  const isAll = selectedKey === 'all';
  const isToday = selectedKey === todayKey;

  // 선택된 일자 + status 로 필터
  const filtered = useMemo(() => {
    return items.filter((it) => {
      if (!isAll) {
        const k = dateKey(pickTimestamp(it));
        if (k !== selectedKey) return false;
      }
      if (statusFilter !== 'all' && it.status !== statusFilter) return false;
      return true;
    });
  }, [items, selectedKey, statusFilter, isAll]);

  // 선택된 일자의 status 분포 (헤더 표시)
  const counts = useMemo(() => {
    const dayItems = isAll
      ? items
      : items.filter((it) => dateKey(pickTimestamp(it)) === selectedKey);
    const c = { PENDING: 0, APPROVED: 0, EXECUTED: 0, REJECTED: 0, total: dayItems.length };
    for (const it of dayItems) {
      if (it.status && it.status in c) (c as Record<string, number>)[it.status]++;
    }
    return c;
  }, [items, selectedKey, isAll]);

  return (
    <div className="flex flex-col gap-3">
      {/* 일자 selector pill row */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {pageLabel && (
          <span className="px-2 py-1 text-[11px] rounded bg-bf-panel2 text-bf-muted mr-1">📅 {pageLabel}</span>
        )}
        <button
          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            isAll ? 'bg-bf-primary text-white' : 'bg-bf-panel2 text-bf-muted hover:bg-bf-panel'
          }`}
          onClick={() => setSelectedKey('all')}
        >
          전체 ({items.length})
        </button>
        {dayKeys.map(({ key, offset }) => {
          const { primary, secondary } = dayLabel(key, offset);
          const count = dayStats.get(key) ?? 0;
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
      </div>

      {/* 선택된 일자 헤더 + status 토글 */}
      <div className="card !py-2 !px-3 flex items-center gap-3 flex-wrap">
        <span className="text-sm font-semibold text-bf-text">
          {isAll
            ? `📅 전체 (최근 ${days + 1}일)`
            : isToday
              ? `📅 오늘 (D-0)`
              : `📅 ${selectedKey}`}
        </span>
        <span className="text-xs text-bf-muted">
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
      </div>

      {/* 오늘 액션 영역 (D-0 only) */}
      {isToday && todayActions}

      {/* children 으로 filtered items 전달 */}
      {children(filtered, { selectedKey, isToday, isAll })}
    </div>
  );
}
