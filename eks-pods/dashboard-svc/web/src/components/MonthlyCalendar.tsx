// PR-C (2026-05-15) 4-step state machine v2 — 캘린더 중심 UI 컴포넌트.
//
// role/scope 자동 필터 (backend /dashboard/orders/calendar 가 처리)
// cell 마다: 📥 inbound · 📤 outbound · 🚚 in_transit · ✅ executed count
// cell click → onSelectDate(date) callback (보통 /cal/:date 라우트 이동)
//
// past dates: 회색 · today: 굵은 테두리 · future: 정상
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { fetchCalendar, type CalendarDay } from '../api';
import { type Role } from '../auth';

type Props = {
  role: Role;
  year: number;
  month: number;            // 1-12
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

export function MonthlyCalendar({ role, year, month, onSelectDate, selectedDate }: Props) {
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
    queryKey: ['calendar', role, fromDate, toDate],
    queryFn: () => fetchCalendar(role, fromDate, toDate),
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

  return (
    <div className="bf-card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-lg font-semibold">{year}년 {month}월</div>
        {q.isFetching && <div className="text-xs text-bf-muted">갱신 중…</div>}
      </div>
      <div className="grid grid-cols-7 gap-1 text-xs text-bf-muted mb-1">
        {weekdayLabel.map((w, i) => (
          <div key={i} className={`text-center py-1 ${i === 0 ? 'text-bf-danger' : ''} ${i === 6 ? 'text-bf-primary' : ''}`}>{w}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
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

          return (
            <button
              key={iso}
              type="button"
              onClick={() => onSelectDate?.(iso)}
              className={[
                'text-left rounded p-1.5 min-h-[78px] border transition-colors',
                muted ? 'border-bf-border/30 bg-bf-surface/40 text-bf-muted' : 'border-bf-border bg-bf-surface hover:border-bf-primary',
                isToday ? 'ring-2 ring-bf-primary' : '',
                isSelected ? 'border-bf-primary' : '',
              ].join(' ')}
              aria-label={`${iso} (입고 ${inb} · 출고 ${out} · 운송 ${trn} · 완료 ${exe})`}
            >
              <div className={`text-xs font-medium ${isPast && !isToday ? 'text-bf-muted' : ''}`}>
                {d.getDate()}
              </div>
              {total > 0 && (
                <div className="text-[10px] mt-0.5 leading-tight space-y-0.5">
                  {inb > 0 && <div>📥 {inb}</div>}
                  {out > 0 && <div>📤 {out}</div>}
                  {trn > 0 && <div>🚚 {trn}</div>}
                  {exe > 0 && <div>✅ {exe}</div>}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
