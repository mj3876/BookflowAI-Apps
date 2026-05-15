import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { token, type Role } from './auth';

/**
 * Redis pub/sub → WebSocket → TanStack Query invalidate bridge.
 *
 * Layout 에서 mount. dashboard-svc /ws/updates 가 broadcast 하는 4 채널 수신:
 *   - order.pending     → pending-* / instr-all / plan-* 무효화 (다른 사용자 발의 즉시 반영)
 *   - stock.changed     → ov / inv-* / forecast-all 무효화 (재고 변동 즉시 반영)
 *   - newbook.request   → requests / hq-requests 무효화
 *   - spike.detected    → spikes / spike-24h / hq-spikes 무효화
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
    ws.onmessage = (ev) => {
      try {
        const obj = JSON.parse(ev.data);
        switch (obj.channel) {
          case 'order.pending':
            // 신규 PENDING 발생 — 의사결정/승인/입출고 큐 즉시 갱신
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
            break;
          case 'stock.changed':
            // 재고 변동 — overview/inventory heatmap/forecast 갱신
            qc.invalidateQueries({ queryKey: ['ov'] });
            qc.invalidateQueries({ queryKey: ['ov-other'] });
            qc.invalidateQueries({ queryKey: ['inv-heatmap'] });
            qc.invalidateQueries({ queryKey: ['heatmap'] });
            qc.invalidateQueries({ queryKey: ['inv-category'] });
            qc.invalidateQueries({ queryKey: ['inv-cat-all'] });
            qc.invalidateQueries({ queryKey: ['inv-turnover-all'] });
            qc.invalidateQueries({ queryKey: ['turnover-all'] });
            qc.invalidateQueries({ queryKey: ['forecast-all'] });
            qc.invalidateQueries({ queryKey: ['branch-inv'] });
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
