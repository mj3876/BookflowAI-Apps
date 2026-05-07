import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Layout from './Layout';
import Login from './pages/Login';
import KPI from './pages/KPI';
import Books from './pages/Books';
import Inventory from './pages/Inventory';
import Decision from './pages/Decision';
import Approval from './pages/Approval';
import Returns from './pages/Returns';
import Requests from './pages/Requests';
import Spikes from './pages/Spikes';
import WhDashboard from './pages/WhDashboard';
import WhApprove from './pages/WhApprove';
import WhTransfer from './pages/WhTransfer';
import WhInstructions from './pages/WhInstructions';
import Manual from './pages/Manual';
import BranchInventory from './pages/BranchInventory';
import BranchInbound from './pages/BranchInbound';
import BranchSales from './pages/BranchSales';
import BranchCuration from './pages/BranchCuration';
import Notifications from './pages/Notifications';
import LiveEvents from './pages/LiveEvents';
import { getRole, roleGroup } from './auth';
import './styles.css';

const qc = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 3_000 } },
});

function RequireRole({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  const role = getRole();
  if (!role) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

function HomeRedirect() {
  const role = getRole();
  if (!role) return <Navigate to="/login" replace />;
  const group = roleGroup(role);
  const home = group === 'HQ' ? '/kpi' : group === 'WH' ? '/wh-dashboard' : '/branch-inventory';
  return <Navigate to={home} replace />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<RequireRole><Layout /></RequireRole>}>
            <Route path="/" element={<HomeRedirect />} />

            {/* HQ */}
            <Route path="/kpi"        element={<KPI />} />
            <Route path="/inventory"  element={<Inventory />} />
            <Route path="/books"      element={<Books />} />
            <Route path="/decision"   element={<Decision />} />
            <Route path="/approval"   element={<Approval />} />
            <Route path="/returns"    element={<Returns />} />
            <Route path="/requests"   element={<Requests />} />
            <Route path="/spikes"     element={<Spikes />} />

            {/* WH */}
            <Route path="/wh-dashboard"    element={<WhDashboard />} />
            <Route path="/wh-approve"      element={<WhApprove />} />
            <Route path="/wh-transfer"     element={<WhTransfer />} />
            <Route path="/wh-instructions" element={<WhInstructions />} />
            <Route path="/wh-manual"       element={<Manual scope="WH" />} />

            {/* Branch */}
            <Route path="/branch-inventory" element={<BranchInventory />} />
            <Route path="/branch-inbound"   element={<BranchInbound />} />
            <Route path="/branch-sales"     element={<BranchSales />} />
            <Route path="/branch-curation"  element={<BranchCuration />} />
            <Route path="/branch-manual"    element={<Manual scope="BRANCH" />} />

            {/* 공통 */}
            <Route path="/notifications" element={<Notifications />} />
            <Route path="/live"          element={<LiveEvents />} />

            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
