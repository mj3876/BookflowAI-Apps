import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Layout from './Layout';
import Login from './pages/Login';
import KPI from './pages/KPI';
import Books from './pages/Books';
import Inventory from './pages/Inventory';
// PR-D (2026-05-15): Decision / FinalPlan / ExecutionByLocation 폐기 → Plan / Calendar / Analytics 로 흡수
import Plan from './pages/Plan';
import Approval from './pages/Approval';
import Returns from './pages/Returns';
import Requests from './pages/Requests';
import Spikes from './pages/Spikes';
import HqHome from './pages/HqHome';
import BranchHome from './pages/BranchHome';
import WhDashboard from './pages/WhDashboard';
import WhInventory from './pages/WhInventory';
// PR-D (2026-05-15): legacy 페이지 정리
//   - WhApprove → /approval (PR-C v4)
//   - WhInstructions · WhTransfer · BranchInbound → /logistics
//   - BranchInventory → /inventory  ·  BranchCuration → /spikes  ·  Manual → /inventory
//   - Decision · FinalPlan · ExecutionByLocation → Plan / Calendar / Analytics
import BranchSales from './pages/BranchSales';
import Notifications from './pages/Notifications';
import LiveEvents from './pages/LiveEvents';
// PR-C (2026-05-15) 4-step state machine v2 — 캘린더 + 사이드바 분리 페이지
// 이슈15 2026-05-16: Logistics.tsx 폐기 → /logistics 는 CalendarDetail 을 date 없이(오늘) 렌더.
import Calendar from './pages/Calendar';
import CalendarDetail from './pages/CalendarDetail';
import OpsDashboard from './pages/OpsDashboard';
import { getRole, roleGroup } from './auth';
import { ToastProvider } from './components/Toast';
import './styles.css';

const qc = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 3_000 } },
});

function RequireRole({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  const role = getRole();
  if (!role) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  // engineer 는 운영 대시보드(/ops) 외 비즈니스 페이지 접근 불가.
  const isOps = roleGroup(role) === 'OPS';
  const onOpsPath = loc.pathname === '/ops';
  if (isOps && !onOpsPath) return <Navigate to="/ops" replace />;
  if (!isOps && onOpsPath) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function HomeRedirect() {
  const role = getRole();
  if (!role) return <Navigate to="/login" replace />;
  const group = roleGroup(role);
  const home =
    group === 'OPS' ? '/ops'
    : group === 'HQ' ? '/home/hq'
    : group === 'WH' ? '/wh-dashboard'
    : '/home/branch';
  return <Navigate to={home} replace />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <ToastProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<RequireRole><Layout /></RequireRole>}>
            <Route path="/" element={<HomeRedirect />} />

            {/* 홈 3 페이지 (role 별 진입) */}
            <Route path="/home/hq"     element={<HqHome />} />
            {/* 2026-05-13 WhHome 폐기 · WhDashboard 가 권역 진입점. 기존 링크/북마크 보존을 위해 redirect 유지. */}
            <Route path="/home/wh"     element={<Navigate to="/wh-dashboard" replace />} />
            <Route path="/home/branch" element={<BranchHome />} />

            {/* HQ */}
            <Route path="/kpi"        element={<KPI />} />
            <Route path="/inventory"  element={<Inventory />} />
            <Route path="/books"      element={<Books />} />
            <Route path="/plan"       element={<Plan />} />
            <Route path="/approval"   element={<Approval />} />
            <Route path="/returns"    element={<Returns />} />
            <Route path="/requests"   element={<Requests />} />
            <Route path="/spikes"     element={<Spikes />} />
            {/* PR-D legacy redirect (북마크 보존) */}
            <Route path="/decision"   element={<Navigate to="/plan" replace />} />
            <Route path="/final-plan" element={<Navigate to="/calendar" replace />} />
            <Route path="/execution"  element={<Navigate to="/calendar" replace />} />

            {/* WH */}
            <Route path="/wh-dashboard"    element={<WhDashboard />} />
            <Route path="/wh-inventory"    element={<WhInventory />} />
            {/* PR-D: WH 처리 페이지들 모두 /approval + /logistics 로 흡수 */}
            <Route path="/wh-approve"      element={<Navigate to="/approval" replace />} />
            <Route path="/wh-transfer"     element={<Navigate to="/logistics" replace />} />
            <Route path="/wh-instructions" element={<Navigate to="/logistics" replace />} />
            <Route path="/wh-manual"       element={<Navigate to="/inventory" replace />} />

            {/* Branch */}
            <Route path="/branch-sales"     element={<BranchSales />} />
            {/* PR-D: Branch 처리 페이지들 흡수 */}
            <Route path="/branch-inventory" element={<Navigate to="/inventory" replace />} />
            <Route path="/branch-inbound"   element={<Navigate to="/approval" replace />} />
            <Route path="/branch-curation"  element={<Navigate to="/spikes" replace />} />
            <Route path="/branch-manual"    element={<Navigate to="/inventory" replace />} />

            {/* 운영 (engineer 전용 · Grafana 임베드) */}
            <Route path="/ops" element={<OpsDashboard />} />

            {/* 공통 */}
            <Route path="/notifications" element={<Notifications />} />
            <Route path="/live"          element={<LiveEvents />} />

            {/* PR-C 4-step state machine v2 — 사이드바 진입점 (모든 role 자동 필터) */}
            <Route path="/calendar"      element={<Calendar />} />
            <Route path="/cal/:date"     element={<CalendarDetail />} />
            {/* 이슈15: /logistics = date 없는 CalendarDetail (오늘) — 코드 단일화 */}
            <Route path="/logistics"     element={<CalendarDetail />} />
            {/* /approval 은 위 HQ section 의 기존 path 그대로 활용 (legacy Approval.tsx 가 새 협의 페이지로 교체됨) */}

            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
