// Auth · localStorage (mock 버튼) + Entra OIDC cookie (httpOnly bookflow_session) 둘 다 지원.
// Cookie 우선 — Login.tsx 진입 시 /auth/whoami 호출해서 cookie 유효하면 자동 setRole.
import { useEffect, useState } from 'react';

export type Role = 'hq-admin' | 'wh-manager-1' | 'wh-manager-2' | 'branch-clerk' | 'engineer';

export type Scope = {
  scope_wh_id: number | null;     // wh-manager 일 때 1 (수도권) / 2 (영남)
  scope_store_id: number | null;  // branch-clerk 일 때 매장 ID 1~12
};

/** /auth/whoami 호출 → cookie 유효시 Role + scope 반환 · 아니면 null */
export async function fetchSessionRole(): Promise<{ role: Role; scope: Scope } | null> {
  try {
    const r = await fetch('/auth/whoami', { credentials: 'include' });
    if (!r.ok) return null;
    const j = await r.json();
    const scope: Scope = {
      scope_wh_id: j.scope_wh_id ?? null,
      scope_store_id: j.scope_store_id ?? null,
    };
    let role: Role | null = null;
    if (j.role === 'hq-admin') role = 'hq-admin';
    else if (j.role === 'wh-manager') role = scope.scope_wh_id === 2 ? 'wh-manager-2' : 'wh-manager-1';
    else if (j.role === 'branch-clerk') role = 'branch-clerk';
    else if (j.role === 'engineer') role = 'engineer';
    return role ? { role, scope } : null;
  } catch { return null; }
}

const STORAGE_KEY = 'bookflow.role';
const SCOPE_KEY = 'bookflow.scope';
const MODE_KEY = 'bookflow.auth_mode';   // 'entra' (cookie) · 'mock' (Authorization mock-token)
const TOKEN_OVERRIDE_KEY = 'bookflow.mock_token';  // 2026-05-15 v3 — 매장별 mock-token-branch-clerk-N

export type AuthMode = 'entra' | 'mock';
export function getAuthMode(): AuthMode {
  return (localStorage.getItem(MODE_KEY) as AuthMode) ?? 'mock';
}
export function setAuthMode(m: AuthMode): void {
  localStorage.setItem(MODE_KEY, m);
}

// mock role 별 default scope (Entra 미사용 시) — 시드 fixture 기반
const MOCK_SCOPE: Record<Role, Scope> = {
  'hq-admin':     { scope_wh_id: null, scope_store_id: null },
  'wh-manager-1': { scope_wh_id: 1,    scope_store_id: null },
  'wh-manager-2': { scope_wh_id: 2,    scope_store_id: null },
  'branch-clerk': { scope_wh_id: null, scope_store_id: 1 },  // 강남점 (location_id=1)
  'engineer':     { scope_wh_id: null, scope_store_id: null },  // 전역 · 운영 대시보드
};

const ROLE_LABELS: Record<Role, string> = {
  'hq-admin':     '본사 관리자',
  'wh-manager-1': '창고 매니저 (수도권)',
  'wh-manager-2': '창고 매니저 (영남)',
  'branch-clerk': '지점 직원',
  'engineer':     '운영 엔지니어',
};

export type RoleGroup = 'HQ' | 'WH' | 'BRANCH' | 'OPS';

const ROLE_GROUP: Record<Role, RoleGroup> = {
  'hq-admin': 'HQ', 'wh-manager-1': 'WH', 'wh-manager-2': 'WH', 'branch-clerk': 'BRANCH',
  'engineer': 'OPS',
};

export function roleLabel(r: Role): string { return ROLE_LABELS[r]; }
export function roleGroup(r: Role): RoleGroup { return ROLE_GROUP[r]; }
export function token(role: Role): string {
  // 매장별 mock token override (Login.tsx 의 onPickStore 가 설정)
  const override = localStorage.getItem(TOKEN_OVERRIDE_KEY);
  if (override) return `Bearer ${override}`;
  return `Bearer mock-token-${role}`;
}

export function getRole(): Role | null {
  const v = localStorage.getItem(STORAGE_KEY);
  return v ? (v as Role) : null;
}
export function setRole(r: Role | null, scope?: Scope, tokenOverride?: string): void {
  if (r) {
    localStorage.setItem(STORAGE_KEY, r);
    const s = scope ?? MOCK_SCOPE[r];
    localStorage.setItem(SCOPE_KEY, JSON.stringify(s));
    if (tokenOverride) localStorage.setItem(TOKEN_OVERRIDE_KEY, tokenOverride);
    else localStorage.removeItem(TOKEN_OVERRIDE_KEY);
  } else {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(SCOPE_KEY);
    localStorage.removeItem(MODE_KEY);
    localStorage.removeItem(TOKEN_OVERRIDE_KEY);
  }
  window.dispatchEvent(new Event('bookflow-role-changed'));
}

export function getScope(): Scope {
  try {
    const v = localStorage.getItem(SCOPE_KEY);
    if (v) return JSON.parse(v) as Scope;
  } catch { /* ignore */ }
  const r = getRole();
  return r ? MOCK_SCOPE[r] : { scope_wh_id: null, scope_store_id: null };
}

export function useRole(): [Role | null, (r: Role | null, scope?: Scope) => void] {
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
  return [role, (r, scope) => { setRole(r, scope); set(r); }];
}

/** 현재 사용자의 scope (wh_id / store_id) — 권한별 페이지에서 사용 */
export function useScope(): Scope {
  const [scope, set] = useState<Scope>(getScope());
  useEffect(() => {
    const f = () => set(getScope());
    window.addEventListener('bookflow-role-changed', f);
    window.addEventListener('storage', f);
    return () => {
      window.removeEventListener('bookflow-role-changed', f);
      window.removeEventListener('storage', f);
    };
  }, []);
  return scope;
}
