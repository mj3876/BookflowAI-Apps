import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchPending, postDecide, type DecideResult, type Role } from '../api';
import { ko, ORDER_TYPE_KO, URGENCY_KO } from '../labels';

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
  1: { name: 'Stage 1 · 재분배', color: 'pill-info',     desc: '같은 권역 내 location 간 이동 - WH 매니저 단독 승인' },
  2: { name: 'Stage 2 · 권역이동', color: 'pill-pending', desc: '수도권 ↔ 영남 - SOURCE/TARGET WH 양쪽 승인 필요' },
  3: { name: 'Stage 3 · EOQ 발주', color: 'pill-rejected', desc: '외부 출판사 발주 - HQ 단독 최종 승인' },
};

export default function Decision() {
  const { role } = useOutletContext<{ role: Role }>();
  const qc = useQueryClient();

  const pending = useQuery({ queryKey: ['pending', role], queryFn: () => fetchPending(role, { limit: 30 }), refetchInterval: 5000 });

  const [form, setForm] = useState({ isbn13: '', target_location_id: 3, qty: 50, note: '' });
  const [result, setResult] = useState<DecideResult | null>(null);

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

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2 flex flex-col gap-4">
        <div>
          <h1 className="h1">3단계 의사결정</h1>
          <p className="text-bf-muted text-xs mt-1">
            decision-svc 자동 cascade · ISBN/도착지/수량 입력 → Stage 1 (재분배) → Stage 2 (권역이동) → Stage 3 (EOQ 발주) 순으로 자동 시도
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
            <h2 className="h2">PENDING 결정 큐</h2>
            <span className="label-tag">5초 polling · role 자동 필터</span>
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
                  <td className="text-bf-muted">-</td>
                  <td className="text-bf-muted">{new Date(o.created_at).toLocaleString('ko-KR')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <div className="card">
          <h2 className="h2 mb-3">신규 의사결정</h2>
          <p className="text-[11px] text-bf-muted mb-3">백엔드가 inventory + forecast_cache 조회 후 Stage 자동 결정</p>
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
              onClick={() => decide.mutate()}
            >
              {decide.isPending ? '결정 중…' : '3단계 의사결정 시작'}
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
    </div>
  );
}
