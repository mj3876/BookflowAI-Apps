import { useOutletContext } from 'react-router-dom';
import { useLiveStream } from '../useLiveStream';
import type { Role } from '../auth';

const CH_LABEL: Record<string, { label: string; pub: string; cls: string }> = {
  'stock.changed':   { label: 'stock.changed',   pub: 'pos-ingestor Lambda',         cls: 'text-bf-success' },
  'order.pending':   { label: 'order.pending',   pub: 'decision-svc / notification-svc', cls: 'text-bf-warn' },
  'spike.detected':  { label: 'spike.detected',  pub: 'spike-detect Lambda',         cls: 'text-bf-danger' },
  'newbook.request': { label: 'newbook.request', pub: 'publisher-watcher CronJob',   cls: 'text-purple-700' },
};

export default function LiveEvents() {
  const { role } = useOutletContext<{ role: Role }>();
  const { events, status, counts } = useLiveStream(role);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="h1">Live Events · Redis Pub/Sub</h1>
        <p className="text-bf-muted text-xs mt-1">
          dashboard-svc WS broker · 4 Redis 채널 실시간 fan-out · 연결 상태: <b>{status}</b>
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Object.entries(counts).map(([ch, n]) => (
          <div key={ch} className="metric-card">
            <div className="metric-label">{CH_LABEL[ch]?.label ?? ch}</div>
            <div className="metric-value">{n}</div>
            <div className="text-[10px] text-bf-muted mt-1">{CH_LABEL[ch]?.pub ?? ''}</div>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="h2">이벤트 스트림 ({events.length})</h2>
          <span className="label-tag">최근 200건 보존</span>
        </div>
        <div className="space-y-1.5 max-h-[60vh] overflow-y-auto">
          {events.map((e, i) => (
            <div key={i} className="flex items-start gap-3 text-xs border-b border-bf-border2 pb-1.5">
              <span className="text-bf-muted w-20 shrink-0">{e.ts}</span>
              <span className={`font-semibold w-32 shrink-0 ${CH_LABEL[e.channel]?.cls ?? 'text-bf-text'}`}>{e.channel}</span>
              <span className="text-bf-text2 flex-1 break-all font-mono text-[11px]">
                {JSON.stringify(e.data)}
              </span>
            </div>
          ))}
          {events.length === 0 && (
            <div className="text-center py-6 text-bf-muted text-xs">
              이벤트 대기 중… (POS 트래픽이 ECS sim 에서 발생하면 자동으로 표시)
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
