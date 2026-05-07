import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchSessionRole, setRole, type Role } from '../auth';

const ROLES: { id: Role; label: string; group: string; desc: string }[] = [
  { id: 'hq-admin',     label: '본사 관리자',  group: 'HQ',     desc: 'KPI · Books · Decision · Approval · Returns · Requests' },
  { id: 'wh-manager-1', label: '창고 매니저 (수도권)', group: 'WH',     desc: 'Dashboard · Approve · Transfer · Manual' },
  { id: 'wh-manager-2', label: '창고 매니저 (영남)',   group: 'WH',     desc: 'Dashboard · Approve · Transfer · Manual' },
  { id: 'branch-clerk', label: '지점 직원',     group: 'BRANCH', desc: 'Inventory · Inbound · Sales · Curation' },
];

export default function Login() {
  const nav = useNavigate();
  const [checking, setChecking] = useState(true);

  // Entra OIDC cookie 자동 감지 — bookflow_session 유효시 mock 버튼 안 거치고 자동 진입.
  useEffect(() => {
    fetchSessionRole().then((r) => {
      if (r) {
        setRole(r);
        nav('/', { replace: true });
      } else {
        setChecking(false);
      }
    });
  }, [nav]);

  const onPick = (r: Role) => {
    setRole(r);
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

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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

        <div className="mt-10 text-center text-[11px] text-bf-muted">
          V6.4 · MSA 7 Pod + 1 CronJob + 7 Lambda · Real-time POS / Spike Detection
        </div>
      </div>
    </div>
  );
}
