import { useEffect, useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchPending, postDecide, type DecideResult, type Role } from '../api';
import { ko, ORDER_TYPE_KO, URGENCY_KO } from '../labels';
import ConfirmModal from '../components/ConfirmModal';
import EmptyState from '../components/EmptyState';

const LOCATIONS = [
  { id: 3, name: '강남점 (수도권)' },
  { id: 4, name: '홍대점 (수도권)' },
  { id: 5, name: '잠실점 (수도권)' },
  { id: 6, name: '신촌점 (수도권)' },
  { id: 7, name: '수원점 (수도권)' },
  { id: 8, name: 'WH1 온라인 (수도권)' },
  { id: 9, name: '부산점 (영남)' },
  { id: 10, name: '대구점 (영남)' },
  { id: 11, name: '광주점 (영남)' },
  { id: 12, name: '대전점 (영남)' },
  { id: 13, name: '울산점 (영남)' },
  { id: 14, name: 'WH2 온라인 (영남)' },
];

const STAGE_LABEL: Record<number, { name: string; color: string; desc: string }> = {
  1: { name: '1단계 · 권역 내 재분배', color: 'pill-info',     desc: '같은 권역 내 매장끼리 재고 이동 — 물류센터(창고 매니저) 단독 승인' },
  2: { name: '2단계 · 권역 간 이동',   color: 'pill-pending', desc: '수도권 ↔ 영남 — 양쪽 권역 매니저 승인 필요' },
  3: { name: '3단계 · 외부 발주',      color: 'pill-rejected', desc: '출판사에 신규 발주 — 비용 발생, 본사 단독 최종 승인 (긴급은 자동 발주)' },
};

export default function Decision() {
  const { role } = useOutletContext<{ role: Role }>();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();

  const pending = useQuery({ queryKey: ['pending', role], queryFn: () => fetchPending(role, { limit: 30 }), refetchInterval: 5000 });

  // P2-5 Spike → Decision pre-fill: ?isbn=...&qty=...
  const [form, setForm] = useState({ isbn13: '', target_location_id: 3, qty: 50, note: '' });
  const [result, setResult] = useState<DecideResult | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    const qIsbn = params.get('isbn');
    const qQty = params.get('qty');
    const qNote = params.get('note');
    if (qIsbn || qQty || qNote) {
      setForm((f) => ({
        ...f,
        isbn13: qIsbn ?? f.isbn13,
        qty: qQty ? Number(qQty) : f.qty,
        note: qNote ?? f.note,
      }));
      // URL 정리 (한 번 적용 후 query 제거)
      setParams({});
    }
  }, [params, setParams]);

  const decide = useMutation({
    mutationFn: () => postDecide(role, {
      isbn13: form.isbn13,
      target_location_id: Number(form.target_location_id),
      qty: Number(form.qty),
      note: form.note || undefined,
    }),
    onSuccess: (d) => {
      setResult(d);
      qc.invalidateQueries({ queryKey: ['pending'] });
    },
    onError: (e) => alert(`실패: ${String(e)}`),
  });

  const targetName = LOCATIONS.find((l) => l.id === form.target_location_id)?.name ?? `매장 ${form.target_location_id}`;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2 flex flex-col gap-4">
        <div>
          <h1 className="h1">재고 결정 (3단계 자동 진행)</h1>
          <p className="text-bf-muted text-xs mt-1">
            ISBN/도착 매장/수량을 입력하면 자동으로 1단계(권역 내 재분배) → 2단계(권역 간 이동) → 3단계(외부 발주) 순으로 가능 여부를 확인하고 결정해요.
          </p>
        </div>

        <div className="card-tight bg-bf-panel2 border-bf-border2">
          <div className="grid grid-cols-3 gap-3 text-xs">
            {[1, 2, 3].map((s) => (
              <div key={s} className="border-l-4 pl-3" style={{ borderColor: s === 1 ? '#3B82F6' : s === 2 ? '#92400E' : '#991B1B' }}>
                <div className="font-semibold text-bf-text">{STAGE_LABEL[s].name}</div>
                <div className="text-bf-muted mt-1">{STAGE_LABEL[s].desc}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <h2 className="h2">처리 대기 큐</h2>
            <span className="label-tag">5초마다 자동 갱신</span>
          </div>
          <table className="data-table">
            <thead>
              <tr><th>긴급도</th><th>유형</th><th>ISBN</th><th>출발 → 도착</th><th>수량</th><th>자동실행</th><th>생성</th></tr>
            </thead>
            <tbody>
              {pending.data?.items.slice(0, 20).map((o) => (
                <tr key={o.order_id}>
                  <td>
                    <span className={
                      o.urgency_level === 'CRITICAL' ? 'pill-rejected' :
                      o.urgency_level === 'URGENT'   ? 'pill-pending' : 'pill-info'
                    }>{ko(URGENCY_KO, o.urgency_level)}</span>
                  </td>
                  <td>{ko(ORDER_TYPE_KO, o.order_type)}</td>
                  <td className="font-mono text-[11px]">{o.isbn13}</td>
                  <td>{o.source_location_id ?? '-'} → {o.target_location_id ?? '-'}</td>
                  <td>{o.qty}권</td>
                  <td className="text-bf-muted">{o.auto_execute_eligible ? '✓' : '-'}</td>
                  <td className="text-bf-muted">{new Date(o.created_at).toLocaleString('ko-KR')}</td>
                </tr>
              ))}
              {(pending.data?.items.length ?? 0) === 0 && !pending.isLoading && (
                <tr><td colSpan={7}>
                  <EmptyState message="처리 대기 결정 없음" hint="새 결정을 발의하면 cascade 결과가 여기에 표시됩니다" />
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <div className="card">
          <h2 className="h2 mb-3">새 결정 발의</h2>
          <p className="text-[11px] text-bf-muted mb-3">
            매장 재고 + 24h 매출 + 예측 수요를 종합해 백엔드가 가능한 단계를 자동 선택합니다.
          </p>
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
            <div>
              <div className="label-tag mb-1">도착 매장 / 위치</div>
              <select
                className="ipt w-full"
                value={form.target_location_id}
                onChange={(e) => setForm({ ...form, target_location_id: Number(e.target.value) })}
              >
                {LOCATIONS.map((l) => <option key={l.id} value={l.id}>{l.name} (#{l.id})</option>)}
              </select>
            </div>
            <div>
              <div className="label-tag mb-1">필요 수량</div>
              <input
                className="ipt w-full"
                type="number" min={1}
                value={form.qty}
                onChange={(e) => setForm({ ...form, qty: Number(e.target.value) })}
              />
            </div>
            <div>
              <div className="label-tag mb-1">메모 (선택)</div>
              <input
                className="ipt w-full"
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
                placeholder="예: 이벤트 특수 수요 예상"
              />
            </div>
            <button
              className="btn-primary w-full"
              disabled={!form.isbn13 || decide.isPending}
              onClick={() => setConfirmOpen(true)}
            >
              {decide.isPending ? '결정 중…' : '결정 시작'}
            </button>
          </div>
        </div>

        {result && (
          <div className="card">
            <h2 className="h2 mb-3">결정 결과</h2>
            <div className="space-y-2 text-xs">
              <div>
                <span className={STAGE_LABEL[result.stage].color}>{STAGE_LABEL[result.stage].name}</span>
              </div>
              <div className="text-bf-muted">{STAGE_LABEL[result.stage].desc}</div>
              <hr className="border-bf-border2" />
              <div><span className="label-tag">유형</span> <span className="ml-2">{ko(ORDER_TYPE_KO, result.order_type)}</span></div>
              <div><span className="label-tag">긴급도</span> <span className="ml-2">{ko(URGENCY_KO, result.urgency_level)}</span></div>
              <div><span className="label-tag">자동 실행 조건</span> <span className="ml-2">{result.auto_execute_eligible ? '✓ 충족' : '× 미충족'}</span></div>
              <div><span className="label-tag">출발</span> <span className="ml-2">{result.source_location_id ?? '(출판사)'}</span></div>
              <div><span className="label-tag">도착</span> <span className="ml-2">{result.target_location_id}</span></div>
              <div><span className="label-tag">주문 ID</span> <span className="font-mono text-[10px] ml-2 text-bf-muted">{result.order_id}</span></div>
              <hr className="border-bf-border2" />
              <details>
                <summary className="cursor-pointer text-bf-muted">의사결정 근거 (수요 예측 기반)</summary>
                <pre className="mt-2 text-[10px] bg-bf-panel2 p-2 rounded overflow-x-auto">
{JSON.stringify(result.rationale, null, 2)}
                </pre>
              </details>
            </div>
          </div>
        )}
      </div>

      <ConfirmModal
        open={confirmOpen}
        title="결정 발의 확인"
        message={`도서 ${form.isbn13}\n도착: ${targetName}\n수량: ${form.qty}권\n\n3단계 자동 cascade 가 시작됩니다 (3단계 도달 시 외부 발주 → 비용 발생).`}
        confirmText="발의"
        onConfirm={() => { setConfirmOpen(false); decide.mutate(); }}
        onCancel={() => setConfirmOpen(false)}
        isLoading={decide.isPending}
      />
    </div>
  );
}
