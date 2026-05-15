import { Navigate } from 'react-router-dom';

/**
 * 2026-05-13 WhHome 폐기 · WhDashboard 일원화.
 *
 * 기존 권역 홈은 batch monitor + 카테고리 카운트만 노출했는데,
 * 사용자 결정: WhDashboard 를 진짜 BI 대시보드로 키우고 진입점을 일원화.
 *
 * 이 파일은 router 에서 더 이상 import 되지 않지만 (main.tsx 가 직접 Navigate),
 * 다른 곳에서 import 하더라도 깨지지 않도록 redirect stub 으로 남겨둔다.
 */
export default function WhHome() {
  return <Navigate to="/wh-dashboard" replace />;
}
