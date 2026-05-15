// PR-C (2026-05-15) 4-step state machine v2 — 캘린더 view 진입점.
//
// MonthlyCalendar 컴포넌트 + 월/연 네비. role 자동 필터 (backend 처리).
// cell click → /cal/:date 상세 페이지로 이동.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { MonthlyCalendar } from '../components/MonthlyCalendar';
import { getRole } from '../auth';

export default function Calendar() {
  const navigate = useNavigate();
  const role = getRole();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  if (!role) return null;

  const prev = () => {
    if (month === 1) { setYear(year - 1); setMonth(12); }
    else setMonth(month - 1);
  };
  const next = () => {
    if (month === 12) { setYear(year + 1); setMonth(1); }
    else setMonth(month + 1);
  };
  const today = () => {
    const t = new Date();
    setYear(t.getFullYear()); setMonth(t.getMonth() + 1);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">📅 캘린더</h1>
        <div className="flex gap-1">
          <button className="bf-btn-secondary text-sm" onClick={prev} aria-label="이전 달">◀</button>
          <button className="bf-btn-secondary text-sm" onClick={today}>오늘</button>
          <button className="bf-btn-secondary text-sm" onClick={next} aria-label="다음 달">▶</button>
        </div>
      </div>

      <div className="text-sm text-bf-muted">
        각 날짜를 클릭하면 입고/출고/운송/완료 상세를 볼 수 있습니다.
        📥 입고 · 📤 출고 · 🚚 운송 중 · ✅ 완료
      </div>

      <MonthlyCalendar
        role={role}
        year={year}
        month={month}
        onSelectDate={(iso) => navigate(`/cal/${iso}`)}
      />
    </div>
  );
}
