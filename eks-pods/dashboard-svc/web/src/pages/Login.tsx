import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchSessionRole, setAuthMode, setRole, type Role, type Scope } from '../auth';

const ROLES: { id: Role; label: string; group: string; desc: string }[] = [
  { id: 'hq-admin',     label: '본사 관리자',  group: 'HQ',     desc: '시연 발의 + 전사 관제' },
  { id: 'wh-manager-1', label: '창고 매니저 (수도권)', group: 'WH',     desc: '수도권 권역 협의 + 입출고' },
  { id: 'wh-manager-2', label: '창고 매니저 (영남)',   group: 'WH',     desc: '영남 권역 협의 + 입출고' },
  { id: 'engineer',     label: '운영 엔지니어', group: 'OPS',    desc: '멀티클라우드 인프라 관제 (Grafana)' },
];

// 2026-05-15 v3 시연 편의 — 12 매장 별도 mock (실제 운영은 Entra ID OIDC)
// id·이름은 DB seed-data/locations.csv (STORE_OFFLINE) 와 1:1 정확히 일치해야 함 (이슈14 · 2026-05-16).
const STORES: { id: number; name: string; wh: number }[] = [
  { id: 1, name: '강남점',    wh: 1 }, { id: 2, name: '광화문점',  wh: 1 },
  { id: 3, name: '잠실점',    wh: 1 }, { id: 4, name: '홍대점',    wh: 1 },
  { id: 5, name: '신촌점',    wh: 1 }, { id: 6, name: '용산점',    wh: 1 },
  { id: 7, name: '부산 서면점', wh: 2 }, { id: 8, name: '대구 동성점', wh: 2 },
  { id: 9, name: '울산 삼산점', wh: 2 }, { id: 10, name: '대구 교대점', wh: 2 },
  { id: 11, name: '부산 센텀점', wh: 2 }, { id: 12, name: '포항 양덕점', wh: 2 },
];

export default function Login() {
  const nav = useNavigate();
  const [checking, setChecking] = useState(true);

  // Entra OIDC cookie 자동 감지 — bookflow_session 유효시 mock 버튼 안 거치고 자동 진입.
  useEffect(() => {
    fetchSessionRole().then((s) => {
      if (s) {
        setAuthMode('entra');  // 이후 모든 API 호출 cookie 기반 (mock-token Authorization 발송 X)
        setRole(s.role, s.scope);
        nav('/', { replace: true });
      } else {
        setChecking(false);
      }
    });
  }, [nav]);

  const onPick = (r: Role) => {
    setAuthMode('mock');  // mock 버튼 → Authorization Bearer mock-token-{role}
    setRole(r);
    nav('/', { replace: true });
  };

  // 매장 직원 mock — store_id 별 별도 mock token + scope override
  const onPickStore = (storeId: number) => {
    setAuthMode('mock');
    const scope: Scope = { scope_wh_id: null, scope_store_id: storeId };
    // store-specific role key ('branch-clerk' 로 frontend Role type 유지하되 mockSuffix 로 token 구분)
    setRole('branch-clerk', scope, `mock-token-branch-clerk-${storeId}`);
    nav('/', { replace: true });
  };

  if (checking) {
    return (
      <div className="min-h-screen bg-bf-bg flex items-center justify-center">
        <div className="text-bf-muted text-sm">세션 확인 중…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bf-bg flex items-center justify-center p-6">
      <div className="w-full max-w-3xl">
        <div className="text-center mb-10">
          <h1 className="text-2xl font-bold m-0 mb-2 text-bf-text">📚 BookFlow</h1>
          <p className="text-bf-muted text-sm m-0">도서 유통 AI 통합 물류·재고 관리 플랫폼</p>
          <p className="text-bf-muted text-[11px] mt-2">
            Phase γ Entra ID OIDC 활성 · 아래 "Microsoft 로그인" 권장 · 개발용 mock 도 가능
          </p>
        </div>

        <div className="mb-6 text-center">
          <a
            href="/auth/login"
            className="inline-flex items-center gap-2 px-6 py-3 bg-bf-primary text-white font-semibold rounded shadow hover:opacity-90 transition"
          >
            <svg width="20" height="20" viewBox="0 0 21 21" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
              <rect x="1" y="1" width="9" height="9" />
              <rect x="11" y="1" width="9" height="9" />
              <rect x="1" y="11" width="9" height="9" />
              <rect x="11" y="11" width="9" height="9" />
            </svg>
            Microsoft 계정으로 로그인 (Entra ID)
          </a>
          <div className="text-[11px] text-bf-muted mt-2">
            BookFlow-Internal App · BF-Admin / BF-HeadQuarter / BF-Logistics / BF-Branch 그룹 매핑
          </div>
        </div>

        <div className="text-center text-[11px] text-bf-muted mb-3">
          —— 또는 개발용 mock 역할 선택 ——
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
          {ROLES.map((r) => (
            <button
              key={r.id}
              onClick={() => onPick(r.id)}
              className="text-left card hover:border-bf-primary hover:shadow transition cursor-pointer"
            >
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] uppercase px-2 py-0.5 rounded bg-bf-bg border border-bf-border text-bf-primary tracking-wider font-semibold">
                  {r.group}
                </span>
                <span className="text-base font-semibold text-bf-text">{r.label}</span>
              </div>
              <div className="text-xs text-bf-muted">{r.desc}</div>
            </button>
          ))}
        </div>

        <div className="text-center text-[11px] text-bf-muted mb-2 mt-4">
          —— 매장 직원 (12 매장 시연용) ——
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {STORES.map((s) => (
            <button
              key={s.id}
              onClick={() => onPickStore(s.id)}
              className="text-left p-2 card hover:border-bf-primary hover:shadow transition cursor-pointer"
            >
              <div className="text-[10px] text-bf-muted">{s.wh === 1 ? '수도권' : '영남'}</div>
              <div className="text-sm font-semibold text-bf-text">{s.name}</div>
            </button>
          ))}
        </div>

        <div className="mt-10 text-center text-[11px] text-bf-muted">
          V6.4 · MSA 7 Pod + 1 CronJob + 7 Lambda · Real-time POS / Spike Detection
        </div>
      </div>
    </div>
  );
}
