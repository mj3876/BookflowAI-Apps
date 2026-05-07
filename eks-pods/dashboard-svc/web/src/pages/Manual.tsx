import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { postInventoryAdjust, type Role } from '../api';
import InlineMessage from '../components/InlineMessage';
import { useLocations } from '../useLocations';

const REASONS = ['파손', '분실', '도난', '입고 누락', '폐기', '기타'];

/**
 * 수동 조정 폼 — UX-6: dashboard-svc /dashboard/inventory/adjust 프록시 활성화.
 * inventory-svc 가 single writer (FR-A6.6 + 권한매트릭스 검증).
 */
export default function Manual({ scope }: { scope: 'WH' | 'BRANCH' }) {
  const { role } = useOutletContext<{ role: Role }>();
  const isWh = scope === 'WH';
  const [form, setForm] = useState({
    isbn13: '',
    location_id: isWh && role === 'wh-manager-2' ? 2 : 1,
    delta: -1,
    reason: REASONS[0],
    note: '',
  });
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const { items: locItems, nameOf } = useLocations(role);
  const locOptions = locItems.filter((l) =>
    isWh ? l.location_type === 'WH' : l.location_type !== 'WH'
  );

  const submit = useMutation({
    mutationFn: async () => {
      const reasonText = form.note ? `${form.reason}: ${form.note}`.slice(0, 50) : form.reason;
      return postInventoryAdjust(role, {
        isbn13: form.isbn13,
        location_id: form.location_id,
        delta: form.delta,
        reason: reasonText,
      });
    },
    onSuccess: (r) =>
      setFeedback({
        type: 'success',
        msg: `조정 완료 — ${nameOf(r.location_id)} · 재고 ${r.on_hand_before} → ${r.on_hand_after}`,
      }),
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      setFeedback({ type: 'error', msg });
    },
  });

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <div>
        <h1 className="h1">{isWh ? '창고' : '매장'} 수동 재고 조정</h1>
        <p className="text-bf-muted text-xs mt-1">
          {isWh ? '창고 직원' : '매장 직원'} 권한 · 파손/분실/입고 누락 등 수동 보정 · audit_log 자동 기록
        </p>
      </div>

      {feedback && (
        <InlineMessage
          type={feedback.type}
          message={feedback.msg}
          onClose={() => setFeedback(null)}
          autoDismissMs={feedback.type === 'success' ? 5000 : undefined}
        />
      )}

      <div className="card">
        <h2 className="h2 mb-4">신규 조정</h2>
        <div className="space-y-3">
          <div>
            <div className="label-tag mb-1">도서 ISBN13</div>
            <input
              className="ipt w-full font-mono"
              value={form.isbn13}
              onChange={(e) => setForm({ ...form, isbn13: e.target.value })}
              placeholder="9788936434120"
              maxLength={13}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="label-tag mb-1">{isWh ? '창고' : '매장'}</div>
              <select
                className="ipt w-full"
                value={form.location_id}
                onChange={(e) => setForm({ ...form, location_id: Number(e.target.value) })}
              >
                {locOptions.map((l) => (
                  <option key={l.location_id} value={l.location_id}>
                    {l.name ?? `위치 ${l.location_id}`}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div className="label-tag mb-1">변동 수량 (음수=감소)</div>
              <input
                className="ipt w-full"
                type="number"
                value={form.delta}
                onChange={(e) => setForm({ ...form, delta: Number(e.target.value) })}
              />
            </div>
          </div>
          <div>
            <div className="label-tag mb-1">사유</div>
            <select
              className="ipt w-full"
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
            >
              {REASONS.map((r) => <option key={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <div className="label-tag mb-1">상세 메모</div>
            <textarea
              className="ipt w-full h-20"
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              placeholder="예: 매대 추락으로 표지 손상 5권"
            />
          </div>
          <button
            className="btn-primary w-full"
            disabled={!form.isbn13 || form.delta === 0 || submit.isPending}
            onClick={() => submit.mutate()}
          >
            {submit.isPending ? '처리 중…' : '조정 제출'}
          </button>
        </div>
      </div>

      <div className="card-tight bg-bf-card text-bf-muted">
        <div className="text-xs">
          • <strong>음수 delta</strong> = 재고 감소 (분실·파손) · <strong>양수 delta</strong> = 재고 증가 (입고 누락 보정)
          <br />
          • {isWh ? '창고 매니저는 자기 권역 내 location 만 가능' : '매장 직원은 자기 매장만 가능 (FR-A6.6)'}
          <br />
          • 모든 조정은 audit_log 에 기록 (변경 전/후 + 사유 + 작업자)
        </div>
      </div>
    </div>
  );
}
