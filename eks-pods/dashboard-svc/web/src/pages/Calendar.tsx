// PR-C (2026-05-15) 4-step state machine v2 — 캘린더 view 진입점.
// 2026-05-16: plan_view 분리 토글 (물류센터 계획 / 지점 계획) + 디자인 개편.
//
// MonthlyCalendar 컴포넌트 + 월/연 네비. role 자동 필터 (backend 처리).
// 상단 세그먼트 토글로 계획 단위 분리 (URL ?view=mine|observe|all).
// cell click → /cal/:date?view= 상세 페이지로 이동 (view 유지).
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { MonthlyCalendar } from '../components/MonthlyCalendar';
import { PlanViewToggle, planViewOptions } from '../components/PlanViewToggle';
import { getRole } from '../auth';
import { type PlanView } from '../api';

export default function Calendar() {
  const navigate = useNavigate();
  const role = getRole();
  const [searchParams, setSearchParams] = useSearchParams();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const planView: PlanView = (() => {
    const v = searchParams.get('view');
    return v === 'mine' || v === 'observe' ? v : 'all';
  })();
  const setPlanView = (v: PlanView) => {
    const next = new URLSearchParams(searchParams);
    if (v === 'all') next.delete('view'); else next.set('view', v);
    setSearchParams(next, { replace: true });
  };

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

  const hasToggle = planViewOptions(role) !== null;
  // 현재 view 헤더 배지 — scope 구분 명확화
  const viewBadge =
    planView === 'mine' ? { text: role === 'hq-admin' ? '🏢 물류센터 계획' : '📦 내 입출고', cls: 'bg-blue-100 text-blue-700 border-blue-200' }
    : planView === 'observe' ? { text: role === 'hq-admin' ? '🏬 지점 계획' : '🔄 권역 매장 재분배', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' }
    : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold">📅 캘린더</h1>
          {viewBadge && (
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${viewBadge.cls}`}>
              {viewBadge.text}
            </span>
          )}
        </div>
        <div className="flex gap-1">
          <button className="bf-btn-secondary text-sm" onClick={prev} aria-label="이전 달">◀</button>
          <button className="bf-btn-secondary text-sm" onClick={today}>오늘</button>
          <button className="bf-btn-secondary text-sm" onClick={next} aria-label="다음 달">▶</button>
        </div>
      </div>

      {hasToggle && (
        <PlanViewToggle role={role} value={planView} onChange={setPlanView} />
      )}

      <div className="text-sm text-bf-muted">
        각 날짜를 클릭하면 입고/출고/운송/완료 상세를 볼 수 있습니다.
        <span className="text-emerald-700"> 📥 입고</span> ·
        <span className="text-blue-700"> 📤 출고</span> ·
        <span className="text-violet-700"> 🚚 운송 중</span> ·
        <span className="text-bf-muted"> ✅ 완료</span>
      </div>

      <MonthlyCalendar
        role={role}
        year={year}
        month={month}
        planView={planView}
        onSelectDate={(iso) => navigate(`/cal/${iso}${planView !== 'all' ? `?view=${planView}` : ''}`)}
      />
    </div>
  );
}
