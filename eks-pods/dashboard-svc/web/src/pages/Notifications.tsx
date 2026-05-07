import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { fetchNotifications, type Role } from '../api';
import { ko, NOTIFICATION_STATUS_KO } from '../labels';

const SEVERITY_PILL: Record<string, string> = {
  CRITICAL: 'pill-rejected', WARNING: 'pill-pending', INFO: 'pill-info',
};
const SEVERITY_KO: Record<string, string> = {
  CRITICAL: '매우 긴급', WARNING: '주의', INFO: '안내',
};
const STATUS_PILL: Record<string, string> = {
  SENT: 'pill-approved', FAILED: 'pill-rejected', RETRYING: 'pill-pending', PENDING: 'pill-pending',
};

// 시트04 12 events 한글 매핑
const EVENT_TYPE_KO: Record<string, string> = {
  OrderPending:        '주문 대기',
  OrderApproved:       '주문 승인',
  OrderRejected:       '주문 거절',
  AutoExecutedUrgent:  '자동 발주 (긴급)',
  AutoRejectedBatch:   '일괄 거절 (반복 거절)',
  SpikeUrgent:         'SNS 급등 감지',
  StockDepartPending:  '출고 대기',
  StockArrivalPending: '입고 대기',
  NewBookRequest:      '신간 신청',
  ReturnPending:       '반품 신청',
  LambdaAlarm:         '시스템 경보',
  DeploymentRollback:  '배포 롤백',
};

export default function Notifications() {
  const { role } = useOutletContext<{ role: Role }>();
  const q = useQuery({ queryKey: ['notif', role], queryFn: () => fetchNotifications(role, 50), refetchInterval: 5000 });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="h1">알림 로그</h1>
        <p className="text-bf-muted text-xs mt-1">시스템 12종 알림 이벤트 발송 이력</p>
      </div>
      <div className="card">
        <table className="data-table">
          <thead>
            <tr><th>발송 시각</th><th>이벤트</th><th>심각도</th><th>채널</th><th>상태</th><th>요약</th></tr>
          </thead>
          <tbody>
            {q.data?.items.map((n) => (
              <tr key={n.notification_id}>
                <td className="text-bf-muted">{new Date(n.sent_at).toLocaleString('ko-KR')}</td>
                <td>{ko(EVENT_TYPE_KO, n.event_type)}</td>
                <td><span className={SEVERITY_PILL[n.severity ?? 'INFO'] ?? 'pill-info'}>{ko(SEVERITY_KO, n.severity ?? 'INFO')}</span></td>
                <td className="text-bf-muted">{n.channels ?? '-'}</td>
                <td><span className={STATUS_PILL[n.status] ?? 'pill-info'}>{ko(NOTIFICATION_STATUS_KO, n.status)}</span></td>
                <td className="text-[11px] text-bf-muted truncate max-w-md">
                  {n.payload_summary ? JSON.stringify(n.payload_summary).slice(0, 100) : '-'}
                </td>
              </tr>
            ))}
            {q.data?.items.length === 0 && (
              <tr><td colSpan={6} className="text-center py-6 text-bf-muted">알림 없음</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
