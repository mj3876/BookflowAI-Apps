import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { roleLabel, roleGroup, useRole, type Role } from './auth';
import { useLiveStream } from './useLiveStream';
import { useLocations } from './useLocations';

type NavItem = { to: string; label: string; desc: string; allow: 'HQ' | 'WH' | 'BRANCH' | 'ALL' };

const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: '본사 (전사 관제)',
    items: [
      { to: '/kpi',         label: '실시간 KPI',         desc: '전사 매출·거래량 한눈에',                allow: 'HQ' },
      { to: '/inventory',   label: '전사 재고',           desc: '모든 매장 재고와 부족 알림',              allow: 'HQ' },
      { to: '/books',       label: '도서 카탈로그',       desc: '도서 검색 · 판매 ON/OFF 결정',            allow: 'HQ' },
      { to: '/decision',    label: '의사결정 발의',       desc: '필요한 도서를 어디서 보낼지 결정 시작',    allow: 'HQ' },
      { to: '/approval',    label: '외부 발주 승인',      desc: '비용 발생하는 출판사 발주 최종 승인',      allow: 'HQ' },
      { to: '/returns',     label: '반품 처리',           desc: '매장이 신청한 반품 승인 / 거부',           allow: 'HQ' },
      { to: '/requests',    label: '신간 편입 결정',      desc: '출판사 신간을 우리 매장에 들일지 결정',    allow: 'HQ' },
      { to: '/spikes',      label: 'SNS 급등 감지',       desc: '최근 24시간 화제가 된 도서 (수요 급변)',   allow: 'HQ' },
    ],
  },
  {
    section: '물류센터 (자기 권역)',
    items: [
      { to: '/wh-dashboard',    label: '권역 대시보드',     desc: '내 권역 매장 매출과 재고 한눈에',        allow: 'WH' },
      { to: '/wh-approve',      label: '처리 대기',         desc: '권역 내 재분배 · 외부 발주 (자기 권역분) 승인 대기', allow: 'WH' },
      { to: '/wh-transfer',     label: '권역 간 이동',      desc: '수도권 ↔ 영남 도서 이동 (양쪽 승인 필요)', allow: 'WH' },
      { to: '/wh-instructions', label: '출고/입고 지시',    desc: '오늘 처리할 출고와 입고 (신간 별도 표시)', allow: 'WH' },
      { to: '/wh-manual',       label: '재고 수동 조정',    desc: '파손 / 분실 등 재고 보정',                allow: 'WH' },
    ],
  },
  {
    section: '매장 (자기 매장)',
    items: [
      { to: '/branch-inventory', label: '매장 재고',         desc: '내 매장 도서 재고와 부족 알림',          allow: 'BRANCH' },
      { to: '/branch-inbound',   label: '입고 확인',         desc: '오늘 들어오는 도서 수령 / 거부',         allow: 'BRANCH' },
      { to: '/branch-sales',     label: '매장 매출',         desc: '내 매장 실시간 판매 (POS)',              allow: 'BRANCH' },
      { to: '/branch-curation',  label: 'SNS 급등 도서',     desc: '최근 24시간 화제가 된 도서 중 매장 재고 보유분 (입고 요청 발의)', allow: 'BRANCH' },
      { to: '/branch-manual',    label: '재고 수동 조정',    desc: '파손 / 분실 등 재고 보정',                allow: 'BRANCH' },
    ],
  },
  {
    section: '공통',
    items: [
      { to: '/notifications', label: '알림 이력',           desc: '주문 / 시스템 이벤트 송신 이력',          allow: 'ALL' },
      { to: '/live',          label: '실시간 이벤트',       desc: '재고 변동 · 주문 · SNS 급등 실시간 스트림', allow: 'ALL' },
    ],
  },
];

const STATUS_PILL: Record<string, string> = {
  up: 'pill-up', connecting: 'pill-connecting', down: 'pill-down',
};

const STATUS_LABEL: Record<string, string> = {
  up: '연결됨', connecting: '연결 중', down: '끊김',
};

const PAGE_LABEL: Record<string, string> = {
  kpi: '실시간 KPI',
  inventory: '전사 재고',
  books: '도서 카탈로그',
  decision: '의사결정',
  approval: '승인 / 거절',
  returns: '반품 처리',
  requests: '신간 신청',
  spikes: '급등 감지',
  'wh-dashboard': '창고 대시보드',
  'wh-approve': '권역 처리 대기',
  'wh-transfer': '권역 이동',
  'wh-instructions': '출고 지시서',
  'wh-manual': '창고 수동 조정',
  'branch-inventory': '매장 재고',
  'branch-inbound': '입고 확인',
  'branch-sales': '매장 매출',
  'branch-curation': 'SNS 급등 도서',
  'branch-manual': '매장 수동 조정',
  notifications: '알림 로그',
  live: '실시간 이벤트',
};

export default function Layout() {
  const [role, setRole] = useRole();
  const nav = useNavigate();
  const loc = useLocation();
  const { status, counts } = useLiveStream(role);
  const { nameOf } = useLocations(role ?? 'hq-admin');

  if (!role) return null;

  const group = roleGroup(role);
  const visible = NAV.map((s) => ({
    section: s.section,
    items: s.items.filter((i) => i.allow === 'ALL' || i.allow === group),
  })).filter((s) => s.items.length > 0);

  const onLogout = () => {
    // mock localStorage role + Entra OIDC httpOnly cookie 둘 다 정리.
    // /auth/logout 가 cookie 삭제 + Entra end_session redirect 처리 → 새로고침 시 자동 재로그인 방지.
    setRole(null);
    window.location.href = '/auth/logout';
  };
  const seg = loc.pathname.split('/').filter(Boolean)[0] ?? 'home';
  const pageTitle = PAGE_LABEL[seg] ?? seg;
  const groupLabel = group === 'HQ' ? '본사' : group === 'WH' ? '물류센터' : '매장';
  // 역할별 scope 표시 (본사 = 전사 / wh = 권역 / branch = 매장명)
  const scopeLabel =
    role === 'hq-admin' ? '전사 관제'
    : role === 'wh-manager-1' ? '수도권 권역'
    : role === 'wh-manager-2' ? '영남 권역'
    : role === 'branch-clerk' ? `${nameOf(1)}` : '';

  return (
    <div className="min-h-screen bg-bf-bg flex">
      <aside className="w-[220px] shrink-0 bg-bf-sidebar text-white flex flex-col">
        <div className="px-5 py-4 border-b border-bf-sidebar2">
          <div className="text-base font-bold flex items-center gap-2">📚 BookFlow</div>
          <div className="text-[10px] text-gray-400 mt-0.5">도서 유통 통합 관제</div>
        </div>
        <nav className="flex-1 overflow-y-auto py-3 flex flex-col gap-3">
          {visible.map((s) => (
            <div key={s.section}>
              <div className="text-[10px] uppercase tracking-wider text-gray-500 px-5 mb-1">{s.section}</div>
              <ul className="flex flex-col">
                {s.items.map((i) => (
                  <li key={i.to}>
                    <NavLink
                      to={i.to}
                      title={i.desc}
                      className={({ isActive }) =>
                        `flex flex-col px-5 py-1.5 border-l-[3px] transition ${
                          isActive
                            ? 'bg-bf-sidebar2 text-white border-bf-primary'
                            : 'text-gray-300 hover:bg-bf-sidebar2 hover:text-white border-transparent'
                        }`
                      }
                    >
                      <span className="text-xs">{i.label}</span>
                      <span className="text-[10px] text-gray-500 truncate">{i.desc}</span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="px-5 py-3 border-t border-bf-sidebar2">
          <div className="text-[10px] uppercase tracking-wider text-gray-500">{groupLabel}</div>
          <div className="text-xs text-white">{roleLabel(role)}</div>
          <div className="text-[10px] text-gray-400 mb-2">{scopeLabel}</div>
          <button onClick={onLogout} className="text-[11px] text-gray-400 hover:text-white">
            로그아웃
          </button>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
        <header className="h-12 border-b border-bf-border px-6 flex items-center gap-4 bg-bf-panel shrink-0">
          <div className="text-sm text-bf-text font-semibold">{pageTitle}</div>
          <span className={STATUS_PILL[status] ?? 'pill-down'} title="WebSocket broker · Redis 4채널">실시간 {STATUS_LABEL[status] ?? status}</span>
          <div className="flex gap-3 ml-auto text-[11px]">
            <span title="stock.changed · pos-ingestor Lambda" className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-bf-success inline-block"></span>
              <span className="text-bf-muted">재고변동</span><b className="text-bf-text">{counts['stock.changed']}</b>
            </span>
            <span title="order.pending · 주문 대기" className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-bf-warn inline-block"></span>
              <span className="text-bf-muted">주문</span><b className="text-bf-text">{counts['order.pending']}</b>
            </span>
            <span title="spike.detected · 급등 감지 Lambda" className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-bf-danger inline-block"></span>
              <span className="text-bf-muted">급등</span><b className="text-bf-text">{counts['spike.detected']}</b>
            </span>
            <span title="newbook.request · 출판사 신간 신청" className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-purple-600 inline-block"></span>
              <span className="text-bf-muted">신간</span><b className="text-bf-text">{counts['newbook.request']}</b>
            </span>
          </div>
        </header>
        <div className="flex-1 overflow-auto p-6">
          <Outlet context={{ role } satisfies { role: Role }} />
        </div>
      </main>
    </div>
  );
}
