// 2026-05-16 — 캘린더·승인 페이지 계획 단위 분리 세그먼트 토글.
//
// plan_view (order_type 기반) 를 role 별 의미에 맞는 라벨로 노출:
//   hq-admin     — 물류센터 계획 (mine) / 지점 계획 (observe)
//   wh-manager-* — 내 입출고 (mine)   / 권역 매장 재분배 (observe)
//   branch-clerk — 분리 없음 (이 컴포넌트 미노출)
//
// scope 구분은 헤더 배지(ScopeBadge) + 이 세그먼트 토글로 명확히.
import { type PlanView } from '../api';
import { type Role } from '../auth';

type Opt = { key: PlanView; label: string };

// branch-clerk 는 분리 없음 → null 반환 시 호출부에서 토글 미렌더.
export function planViewOptions(role: Role): Opt[] | null {
  if (role === 'hq-admin') {
    return [
      { key: 'all', label: '전체' },
      { key: 'mine', label: '🏢 물류센터 계획' },
      { key: 'observe', label: '🏬 지점 계획' },
    ];
  }
  if (role === 'wh-manager-1' || role === 'wh-manager-2') {
    return [
      { key: 'all', label: '전체' },
      { key: 'mine', label: '📦 내 입출고' },
      { key: 'observe', label: '🔄 권역 매장 재분배' },
    ];
  }
  return null;  // branch-clerk
}

export function PlanViewToggle({
  role, value, onChange,
}: {
  role: Role;
  value: PlanView;
  onChange: (v: PlanView) => void;
}) {
  const opts = planViewOptions(role);
  if (!opts) return null;
  return (
    <div className="bf-seg">
      {opts.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={`bf-seg-btn ${value === o.key ? 'bf-seg-btn-on' : ''}`}
        >{o.label}</button>
      ))}
    </div>
  );
}
