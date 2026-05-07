import { useEffect, useRef, useState } from 'react';
import { token, type Role } from './auth';

export type LiveEvent = { ts: string; channel: string; data: unknown };
export type WsStatus = 'connecting' | 'up' | 'down';

export function useLiveStream(role: Role | null) {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [status, setStatus] = useState<WsStatus>(role ? 'connecting' : 'down');
  const [counts, setCounts] = useState<Record<string, number>>({
    'stock.changed': 0, 'order.pending': 0, 'spike.detected': 0, 'newbook.request': 0,
  });
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!role) { setStatus('down'); return; }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/updates`);
    wsRef.current = ws;
    setStatus('connecting');

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token: token(role) }));
      setStatus('up');
    };
    ws.onmessage = (ev) => {
      try {
        const obj = JSON.parse(ev.data);
        const e: LiveEvent = { ts: new Date().toLocaleTimeString(), channel: obj.channel, data: obj.data };
        setEvents((prev) => [e, ...prev].slice(0, 200));
        setCounts((prev) => ({ ...prev, [obj.channel]: (prev[obj.channel] ?? 0) + 1 }));
      } catch { /* ignore */ }
    };
    ws.onerror = () => setStatus('down');
    ws.onclose = () => setStatus('down');

    return () => ws.close();
  }, [role]);

  return { events, status, counts };
}
