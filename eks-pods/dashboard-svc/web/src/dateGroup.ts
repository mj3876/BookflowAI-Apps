/**
 * 날짜별 그루핑 helper (D2 핵심 UX — 매일 cycle 안에서 처리되는 작업).
 *
 * 03:30 cascade 발의 → 07:00 자동 승인 → 사용자 검토 (9-18h) → 18:00 auto reject
 * = 모든 처리 페이지의 PENDING 은 "오늘" 안에서 끝나는 것이 정상.
 */

export type DateGroup<T> = {
  key: string;
  label: string;
  rows: T[];
  /** 그룹 stats — 그룹 헤더 progress 표시 + 최종 계획안 트리거에 사용 */
  total: number;
  approved: number;
  rejected: number;
  pending: number;
  done: number;       // approved + rejected
  progressPct: number; // 0~100
  allDone: boolean;    // total>0 && pending===0
};

/** items 를 created_at 의 YYYY-MM-DD (KST) 별로 그룹. 최신 날짜 먼저.
 *  사용자 요구 (2026-05-12): 승인 전부 완료되면 최종 계획안 표시 → progress stats 동봉.
 */
export function groupByDate<T extends { created_at?: string | null; status?: string | null }>(items: T[]): DateGroup<T>[] {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const key = it.created_at ? dateKey(it.created_at) : '미지정';
    if (!m.has(key)) m.set(key, []);
    m.get(key)!.push(it);
  }
  return [...m.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([key, rows]) => {
      const total = rows.length;
      const approved = rows.filter((r) => r.status === 'APPROVED').length;
      const rejected = rows.filter((r) => r.status === 'REJECTED').length;
      const pending = total - approved - rejected;
      const done = approved + rejected;
      const progressPct = total > 0 ? Math.round((done / total) * 100) : 0;
      const allDone = total > 0 && pending === 0;
      return { key, label: dateLabel(key), rows, total, approved, rejected, pending, done, progressPct, allDone };
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO(notification · D5 ε 후속): 그룹 완료 시 매장별 알림
//   - 사용자 요구 (2026-05-12): "notification 도 각각 지점별로 다 가야됨"
//   - 그룹의 allDone === true 가 처음 trigger 되는 순간:
//     1) 그룹 내 row 들의 target_location_id (또는 source_location_id) distinct 매장 list 추출
//     2) 매장별로 notification-svc 호출:
//        - 본사: GroupCompleted 알림 (전체 요약)
//        - 매장: OrderApproved/OrderRejected 알림 (자기 매장 row 만)
//        - WH: TransferReady 알림 (자기 권역 row 만)
//   - 현재는 frontend rendering 단계라 미구현. backend (intervention-svc 또는 별도 cron) 에서
//     status transition watch 가 더 적합 — D5 ε 후속 PR 에서 결정.
// ─────────────────────────────────────────────────────────────────────────────

/** Date|ISO string → 'YYYY-MM-DD' (KST 시간대 기준) */
function dateKey(iso: string): string {
  const d = new Date(iso);
  // KST 9h 오프셋 적용 후 UTC date 추출
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  return kst.toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' → '📅 오늘 (2026-05-12)' / '📅 어제' / '📅 2일 전' / '📅 2026-05-09' */
export function dateLabel(key: string): string {
  if (key === '미지정') return '📅 날짜 미지정';
  const today = dateKey(new Date().toISOString());
  if (key === today) return `📅 오늘 (${key})`;
  const yesterday = new Date(Date.now() - 86400 * 1000);
  if (key === dateKey(yesterday.toISOString())) return `📅 어제 (${key})`;
  const diffDays = Math.round((Date.now() - new Date(key + 'T00:00:00+09:00').getTime()) / 86400 / 1000);
  if (diffDays > 0 && diffDays <= 7) return `📅 ${diffDays}일 전 (${key})`;
  return `📅 ${key}`;
}

/** 그룹 강조 색상 — 오늘=primary, 어제=warning, 이전=muted (UI 가독성) */
export function dateGroupTone(label: string): { wrap: string; pill: string } {
  if (label.startsWith('📅 오늘')) return { wrap: 'border-l-4 border-bf-primary',  pill: 'bg-bf-primary/15 text-bf-primary' };
  if (label.startsWith('📅 어제')) return { wrap: 'border-l-4 border-orange-400',  pill: 'bg-orange-500/15 text-orange-300' };
  return { wrap: 'border-l-4 border-bf-border', pill: 'bg-bf-panel2 text-bf-muted' };
}
