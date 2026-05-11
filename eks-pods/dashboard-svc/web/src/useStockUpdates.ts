import { useEffect, useRef, useState } from 'react';
import { token, type Role } from './auth';

/**
 * Redis stock.changed 실시간 구독 hook.
 *
 * dashboard-svc 가 /ws/updates 로 Redis stock.changed 채널 broadcast (이미 구현 · redis_bridge).
 * 화면 cell 색상 flash 애니메이션을 위해 (isbn13, location_id) 별 최근 update timestamp 유지.
 *
 * 사용:
 *   const { flashed, available } = useStockUpdates(role);
 *   // 셀 className 에 `${flashed(isbn13, loc_id) ? 'animate-flash' : ''}`
 *   // available[`${isbn13}:${loc_id}`] 가 최신 값 (없으면 fetch 결과 사용)
 */
export type StockUpdate = {
  isbn13: string;
  location_id: number;
  on_hand?: number;
  reserved_qty?: number;
  available?: number;
  ts: number; // unix ms
};

export function useStockUpdates(role: Role | null) {
  // (isbn13|loc_id) → 최신 update
  const [updates, setUpdates] = useState<Record<string, StockUpdate>>({});
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
        if (obj.channel !== 'stock.changed') return;
        const d = obj.data as Partial<StockUpdate> & { isbn13?: string; location_id?: number };
        if (!d.isbn13 || d.location_id == null) return;
        const key = `${d.isbn13}:${d.location_id}`;
        setUpdates((prev) => ({
          ...prev,
          [key]: { ...prev[key], ...(d as any), ts: Date.now() },
        }));
      } catch {
        /* ignore */
      }
    };
    return () => ws.close();
  }, [role]);

  /**
   * 특정 (isbn13, loc) 가 최근 N초 안에 update 됐는지 (flash 애니메이션 트리거).
   * 호출 시점 기준 시간 비교라 컴포넌트 re-render 가 필요 — setUpdates 가 그 역할.
   */
  const flashed = (isbn13: string, loc: number, windowMs = 2000): boolean => {
    const u = updates[`${isbn13}:${loc}`];
    return u != null && Date.now() - u.ts < windowMs;
  };

  /**
   * 최신 available 값 (없으면 undefined → caller 가 fetch 값 사용).
   */
  const availableOf = (isbn13: string, loc: number): number | undefined => {
    return updates[`${isbn13}:${loc}`]?.available;
  };

  return { updates, flashed, availableOf };
}
