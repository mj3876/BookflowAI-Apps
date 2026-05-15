import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { token, type Role } from './auth';

/**
 * Redis pub/sub → WebSocket → TanStack Query invalidate bridge.
 *
 * Layout 에서 mount. dashboard-svc /ws/updates 가 broadcast 하는 8 채널 수신 (PR-B v2):
 *   - order.pending     → PENDING 발의 (cross-user)
 *   - order.approved    → PENDING→APPROVED (한쪽/양측 완료)
 *   - order.dispatched  → APPROVED→IN_TRANSIT + source -qty (재고도 변동)
 *   - order.executed    → IN_TRANSIT→EXECUTED + target +qty
 *   - order.rejected    → any→REJECTED (payload.rejection_stage='IN_TRANSIT' 시만 재고 변동)
 *   - stock.changed     → inventory.on_hand 변동
 *   - newbook.request   → 출판사 신간 신청
 *   - spike.detected    → SNS 급등
 *
 * mutation onSuccess invalidate 와 중복일 수 있으나, "다른 사용자" 의 행동도 즉시 반영하려면
 * WebSocket 경유 invalidate 가 필수. refetchInterval 5~10s 보다 빠른 sub-second 반영.
 */
export function useLiveInvalidate(role: Role | null) {
  const qc = useQueryClient();
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!role) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/updates`);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token: token(role) }));
    };
    // 공통 order-state 무효화 함수 (PENDING / APPROVED / DISPATCHED / EXECUTED / REJECTED 모두 같은 query 무효화)
    const invalidateOrderQueries = () => {
      qc.invalidateQueries({ queryKey: ['pending-active'] });
      qc.invalidateQueries({ queryKey: ['pending-detail'] });
      qc.invalidateQueries({ queryKey: ['pending-summary'] });
      qc.invalidateQueries({ queryKey: ['pending-summary-today'] });
      qc.invalidateQueries({ queryKey: ['pending-transfer'] });
      qc.invalidateQueries({ queryKey: ['instr'] });
      qc.invalidateQueries({ queryKey: ['instr-all'] });
      qc.invalidateQueries({ queryKey: ['plan-summary'] });
      qc.invalidateQueries({ queryKey: ['plan-items'] });
      qc.invalidateQueries({ queryKey: ['plan-items-approved'] });
      qc.invalidateQueries({ queryKey: ['plan-items-delta'] });
      qc.invalidateQueries({ queryKey: ['hq-pending'] });
      qc.invalidateQueries({ queryKey: ['hq-grouped'] });
      qc.invalidateQueries({ queryKey: ['branch-grouped'] });
      qc.invalidateQueries({ queryKey: ['wh-pending'] });
      qc.invalidateQueries({ queryKey: ['calendar'] });
      qc.invalidateQueries({ queryKey: ['orders'] });
    };

    // 재고 변동 query 무효화 (dispatch / receive / IN_TRANSIT-reject 시)
    const invalidateInventoryQueries = () => {
      qc.invalidateQueries({ queryKey: ['ov'] });
      qc.invalidateQueries({ queryKey: ['ov-other'] });
      qc.invalidateQueries({ queryKey: ['heatmap'] });
      qc.invalidateQueries({ queryKey: ['inv-category'] });
      qc.invalidateQueries({ queryKey: ['inv-cat-all'] });
      qc.invalidateQueries({ queryKey: ['inv-turnover-all'] });
      qc.invalidateQueries({ queryKey: ['turnover-all'] });
      qc.invalidateQueries({ queryKey: ['forecast-all'] });
      qc.invalidateQueries({ queryKey: ['branch-inv'] });
    };

    ws.onmessage = (ev) => {
      try {
        const obj = JSON.parse(ev.data);
        // payload (notification-svc 가 publish · order.* 채널) — rejection_stage 등 포함
        const payload = obj.data || {};
        switch (obj.channel) {
          case 'order.pending':
            invalidateOrderQueries();
            break;
          case 'order.approved':
            // PR-B 신규 — 양측 협의 완료 시 화면 색/badge 즉시 동기화
            invalidateOrderQueries();
            break;
          case 'order.dispatched':
            // PR-B 신규 — source -qty (재고 변동 동반)
            invalidateOrderQueries();
            invalidateInventoryQueries();
            break;
          case 'order.executed':
            // PR-B 신규 — target +qty (재고 변동 동반)
            invalidateOrderQueries();
            invalidateInventoryQueries();
            break;
          case 'order.rejected':
            // PR-B 신규 — rejection_stage='IN_TRANSIT' 시만 source +qty 복원 → 재고 query 갱신
            invalidateOrderQueries();
            if (payload?.rejection_stage === 'IN_TRANSIT') {
              invalidateInventoryQueries();
            }
            break;
          case 'stock.changed':
            // 재고 변동 — overview/inventory heatmap/forecast 갱신
            invalidateInventoryQueries();
            break;
          case 'newbook.request':
            qc.invalidateQueries({ queryKey: ['requests'] });
            qc.invalidateQueries({ queryKey: ['hq-requests'] });
            qc.invalidateQueries({ queryKey: ['forecast-hint'] });
            break;
          case 'spike.detected':
            qc.invalidateQueries({ queryKey: ['spikes'] });
            qc.invalidateQueries({ queryKey: ['spike-24h'] });
            qc.invalidateQueries({ queryKey: ['hq-spikes'] });
            qc.invalidateQueries({ queryKey: ['curation'] });
            qc.invalidateQueries({ queryKey: ['branch-cur'] });
            break;
          default:
            break;
        }
      } catch {
        /* ignore */
      }
    };
    return () => ws.close();
  }, [role, qc]);
}
