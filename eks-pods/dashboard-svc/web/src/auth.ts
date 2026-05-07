// Auth · localStorage (mock 버튼) + Entra OIDC cookie (httpOnly bookflow_session) 둘 다 지원.
// Cookie 우선 — Login.tsx 진입 시 /auth/whoami 호출해서 cookie 유효하면 자동 setRole.
import { useEffect, useState } from 'react';

export type Role = 'hq-admin' | 'wh-manager-1' | 'wh-manager-2' | 'branch-clerk';

/** /auth/whoami 호출 → cookie 유효시 Role 반환 · 아니면 null */
export async function fetchSessionRole(): Promise<Role | null> {
  try {
    const r = await fetch('/auth/whoami', { credentials: 'include' });
    if (!r.ok) return null;
    const j = await r.json();
    // backend role: 'hq-admin' | 'wh-manager' | 'branch-clerk' (scope_wh_id 로 wh-manager-1/2 분리)
    if (j.role === 'hq-admin') return 'hq-admin';
    if (j.role === 'wh-manager') return j.scope_wh_id === 2 ? 'wh-manager-2' : 'wh-manager-1';
    if (j.role === 'branch-clerk') return 'branch-clerk';
    return null;
  } catch { return null; }
}

const STORAGE_KEY = 'bookflow.role';

const ROLE_LABELS: Record<Role, string> = {
  'hq-admin':     '본사 관리자',
  'wh-manager-1': '창고 매니저 (수도권)',
  'wh-manager-2': '창고 매니저 (영남)',
  'branch-clerk': '지점 직원',
};

const ROLE_GROUP: Record<Role, 'HQ' | 'WH' | 'BRANCH'> = {
  'hq-admin': 'HQ', 'wh-manager-1': 'WH', 'wh-manager-2': 'WH', 'branch-clerk': 'BRANCH',
};

export function roleLabel(r: Role): string { return ROLE_LABELS[r]; }
export function roleGroup(r: Role): 'HQ' | 'WH' | 'BRANCH' { return ROLE_GROUP[r]; }
export function token(role: Role): string { return `Bearer mock-token-${role}`; }

export function getRole(): Role | null {
  const v = localStorage.getItem(STORAGE_KEY);
  return v ? (v as Role) : null;
}
export function setRole(r: Role | null): void {
  if (r) localStorage.setItem(STORAGE_KEY, r);
  else localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event('bookflow-role-changed'));
}

export function useRole(): [Role | null, (r: Role | null) => void] {
  const [role, set] = useState<Role | null>(getRole());
  useEffect(() => {
    const f = () => set(getRole());
    window.addEventListener('bookflow-role-changed', f);
    window.addEventListener('storage', f);
    return () => {
      window.removeEventListener('bookflow-role-changed', f);
      window.removeEventListener('storage', f);
    };
  }, []);
  return [role, (r) => { setRole(r); set(r); }];
}
