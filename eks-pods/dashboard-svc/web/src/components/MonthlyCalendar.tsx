// PR-C (2026-05-15) 4-step state machine v2 — 캘린더 중심 UI 컴포넌트.
// 2026-05-16: plan_view 분리 (물류센터 계획 / 지점 계획) + 디자인 개편.
//
// role/scope 자동 필터 (backend /dashboard/orders/calendar 가 처리)
// planView 분리: mine=물류센터 계획 · observe=지점 계획 · all=전체
// cell 마다: 📥 inbound · 📤 outbound · 🚚 in_transit · ✅ executed count
// cell click → onSelectDate(date) callback (보통 /cal/:date 라우트 이동)
//
// past dates: 회색 · today: 굵은 테두리 · future: 정상
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { fetchCalendar, type CalendarDay, type PlanView } from '../api';
import { type Role } from '../auth';

type Props = {
  role: Role;
  year: number;
  month: number;            // 1-12
  planView?: PlanView;      // 2026-05-16 — 계획 단위 분리 (default all)
  onSelectDate?: (isoDate: string) => void;
  selectedDate?: string | null;
};

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfCalendarGrid(year: number, month: number): Date {
  // 월 첫째 날 이전 일요일까지 거슬러올라가 그리드 시작 (7 × 6 = 42 cell)
  const first = new Date(year, month - 1, 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  return start;
}

export function MonthlyCalendar({ role, year, month, planView = 'all', onSelectDate, selectedDate }: Props) {
  const fromDate = useMemo(() => ymd(new Date(year, month - 1, 1)), [year, month]);
  // 다음달 첫째날의 하루 전 = 이번달 마지막 날 + 그리드 끝까지
  const toDate = useMemo(() => {
    const last = new Date(year, month, 0);
    const gridEnd = new Date(last);
    gridEnd.setDate(last.getDate() + (6 - last.getDay()));
    return ymd(gridEnd);
  }, [year, month]);

  const today = ymd(new Date());

  const q = useQuery({
    queryKey: ['calendar', role, fromDate, toDate, planView],
    queryFn: () => fetchCalendar(role, fromDate, toDate, planView),
    staleTime: 5000,
    refetchInterval: 30000,
  });

  // date → CalendarDay 매핑
  const byDate = useMemo(() => {
    const m = new Map<string, CalendarDay>();
    (q.data?.items ?? []).forEach((d) => m.set(d.date, d));
    return m;
  }, [q.data]);

  // 6주 × 7일 그리드 (42 cell)
  const cells = useMemo(() => {
    const start = startOfCalendarGrid(year, month);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [year, month]);

  const weekdayLabel = ['일', '월', '화', '수', '목', '금', '토'];

  // planView 별 cell 강조 색 (테두리 hover · 합계 배지)
  const accent =
    planView === 'mine' ? 'group-hover:border-blue-400'
    : planView === 'observe' ? 'group-hover:border-emerald-400'
    : 'group-hover:border-bf-primary';

  return (
    <div className="bf-card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-lg font-semibold">{year}년 {month}월</div>
        {q.isFetching && <div className="text-xs text-bf-muted">갱신 중…</div>}
      </div>
      <div className="grid grid-cols-7 gap-1.5 text-xs text-bf-muted mb-1.5">
        {weekdayLabel.map((w, i) => (
          <div key={i} className={`text-center py-1 font-medium ${i === 0 ? 'text-bf-danger' : ''} ${i === 6 ? 'text-bf-primary' : ''}`}>{w}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1.5">
        {cells.map((d) => {
          const iso = ymd(d);
          const inMonth = d.getMonth() === month - 1;
          const isPast = iso < today;
          const isToday = iso === today;
          const isSelected = selectedDate === iso;
          const day = byDate.get(iso);
          const inb = day?.inbound ?? 0;
          const out = day?.outbound ?? 0;
          const trn = day?.in_transit ?? 0;
          const exe = day?.executed ?? 0;
          const total = inb + out + trn + exe;
          const muted = !inMonth || (isPast && total === 0);
          const hasPlan = total > 0;

          return (
            <button
              key={iso}
              type="button"
              onClick={() => onSelectDate?.(iso)}
              className={[
                'group text-left rounded-lg p-2 min-h-[88px] border transition-all',
                muted
                  ? 'border-bf-border2 bg-bf-panel2/60 text-bf-muted'
                  : `bg-bf-panel border-bf-border ${accent} hover:shadow-md hover:-translate-y-0.5`,
                isToday ? 'ring-2 ring-bf-primary ring-offset-1' : '',
                isSelected ? 'border-bf-primary shadow-md' : '',
              ].join(' ')}
              aria-label={`${iso} (입고 ${inb} · 출고 ${out} · 운송 ${trn} · 완료 ${exe})`}
            >
              <div className="flex items-center justify-between">
                <span className={`text-xs font-semibold ${isPast && !isToday ? 'text-bf-muted' : 'text-bf-text'}`}>
                  {d.getDate()}
                </span>
                {hasPlan && (
                  <span className={[
                    'text-[10px] font-bold px-1.5 py-0.5 rounded-full',
                    planView === 'mine' ? 'bg-blue-100 text-blue-700'
                    : planView === 'observe' ? 'bg-emerald-100 text-emerald-700'
                    : 'bg-bf-ring text-bf-primary3',
                  ].join(' ')}>{total}</span>
                )}
              </div>
              {hasPlan && (
                <div className="text-[10px] mt-1 leading-tight grid grid-cols-2 gap-x-1.5 gap-y-0.5">
                  {inb > 0 && <span className="text-emerald-700">📥 {inb}</span>}
                  {out > 0 && <span className="text-blue-700">📤 {out}</span>}
                  {trn > 0 && <span className="text-violet-700">🚚 {trn}</span>}
                  {exe > 0 && <span className="text-bf-muted">✅ {exe}</span>}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
