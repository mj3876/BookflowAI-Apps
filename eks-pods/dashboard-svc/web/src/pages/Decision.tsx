import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { fetchInsufficientStock, fetchPending, postDecide, postIntervene, type InsufficientStockItem, type Role } from '../api';
import { ko, ORDER_TYPE_KO, URGENCY_KO } from '../labels';
import ConfirmModal from '../components/ConfirmModal';
import EmptyState from '../components/EmptyState';
import HelpHint from '../components/HelpHint';
import { useLocations } from '../useLocations';

/**
 * 본사 의사결정 모니터링 + escalation.
 *
 * 사용자 정정 (2026-05-08):
 *   - 본사는 ISBN 치고 직접 발주 발의하지 않는다 (자동 cascade 가 정석).
 *   - Decision = "3단계 플로우 진행 상황의 큰 그림" + "필요 시 강제 승인 (escalation)".
 *   - 자동 cascade 는 forecast-svc (CronJob/Lambda) · spike-detect Lambda · 매장 입고 요청 등이 트리거.
 *   - 본사 hq-admin 의 강제 승인 권한 = 다른 역할이 처리 안 한 PENDING 을 즉시 APPROVED.
 */

const STAGE_FROM_TYPE = (t: string): 1 | 2 | 3 =>
  t === 'REBALANCE' ? 1 : t === 'WH_TRANSFER' ? 2 : 3;

const STAGE_LABEL: Record<number, { name: string; color: string; desc: string }> = {
  1: { name: '1단계 · 권역 내 재분배', color: 'pill-info',     desc: '같은 권역 내 매장끼리 재고 이동 — 물류센터 단독 승인' },
  2: { name: '2단계 · 권역 간 이동',   color: 'pill-pending', desc: '수도권 ↔ 영남 — 양쪽 권역 매니저 승인 필요' },
  3: { name: '3단계 · 외부 발주',      color: 'pill-rejected', desc: '출판사 신규 발주 — 비용 발생 · 본사/물류센터 자기 권역 승인' },
};

export default function Decision() {
  const { role } = useOutletContext<{ role: Role }>();
  const qc = useQueryClient();
  const { nameOf } = useLocations(role);

  const pending = useQuery({
    queryKey: ['pending-all', role],
    queryFn: () => fetchPending(role, { limit: 50 }),
    refetchInterval: 5000,
  });

  const items = pending.data?.items ?? [];
  const stage1 = items.filter((o) => STAGE_FROM_TYPE(o.order_type) === 1);
  const stage2 = items.filter((o) => STAGE_FROM_TYPE(o.order_type) === 2);
  const stage3 = items.filter((o) => STAGE_FROM_TYPE(o.order_type) === 3);

  const [escalateTarget, setEscalateTarget] = useState<{ order_id: string; title: string; qty: number } | null>(null);

  const escalate = useMutation({
    mutationFn: (order_id: string) =>
      postIntervene(role, 'approve', { order_id, approval_side: 'FINAL', note: 'HQ escalation' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pending-all'] }),
    onError: (e) => alert(`강제 승인 실패: ${String(e)}`),
  });

  // P1-4b 시연 trigger — 예측 부족 도서 자동 cascade 일괄 발의 (HQ 만)
  const [demoOpen, setDemoOpen] = useState(false);
  const [demoResult, setDemoResult] = useState<string | null>(null);
  const insufficient = useQuery({
    queryKey: ['insufficient', role],
    queryFn: () => fetchInsufficientStock(role, 10),
    enabled: role === 'hq-admin' && demoOpen,
  });

  const triggerDemo = useMutation({
    mutationFn: async (items: InsufficientStockItem[]) => {
      let s1 = 0, s2 = 0, s3 = 0;
      for (const it of items) {
        try {
          const r = await postDecide(role, {
            isbn13: it.isbn13,
            target_location_id: it.store_id,
            qty: it.suggested_qty,
            note: '시연용 자동 cascade · 예측 부족',
          });
          if (r.stage === 1) s1++;
          else if (r.stage === 2) s2++;
          else if (r.stage === 3) s3++;
        } catch { /* skip */ }
      }
      return { total: items.length, s1, s2, s3 };
    },
    onSuccess: (r) => {
      setDemoResult(`${r.total}건 처리 — 1단계 ${r.s1} · 2단계 ${r.s2} · 3단계 ${r.s3}`);
      setDemoOpen(false);
      qc.invalidateQueries({ queryKey: ['pending-all'] });
      setTimeout(() => setDemoResult(null), 8000);
    },
    onError: (e) => alert(`자동 발의 실패: ${String(e)}`),
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="h1">의사결정 플로우 현황</h1>
          <p className="text-bf-muted text-xs mt-1">
            현재 진행 중인 모든 발주 결정의 단계와 처리 상황. 자동 cascade (수요 예측·SNS 급등·매장 요청)로 발의되며,
            {role === 'hq-admin' ? ' 본사는 필요 시 다른 역할의 승인을 기다리지 않고 강제 승인 (escalation) 할 수 있어요.' : ' 권한이 있는 행만 처리 가능합니다.'}
          </p>
        </div>
        {role === 'hq-admin' && (
          <button
            className="btn-outline btn-sm shrink-0"
            title="시연용 — 예측 부족 도서 자동 cascade 일괄 발의 (각 단계의 처리 대기를 만들어 다른 역할이 승인 흐름 검증)"
            onClick={() => setDemoOpen(true)}
          >
            시연: 예측 자동 발의
          </button>
        )}
      </div>

      {demoResult && (
        <div className="card-tight bg-bf-success/10 border-bf-success text-bf-success text-xs">
          ✓ {demoResult}
        </div>
      )}

      {/* Stage 별 카운트 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {[1, 2, 3].map((s) => {
          const list = s === 1 ? stage1 : s === 2 ? stage2 : stage3;
          const urgent = list.filter((o) => o.urgency_level === 'URGENT' || o.urgency_level === 'CRITICAL').length;
          return (
            <div key={s} className="metric-card">
              <div className="flex items-center justify-between mb-2">
                <span className={STAGE_LABEL[s].color}>{STAGE_LABEL[s].name}</span>
                {urgent > 0 && <span className="text-[11px] text-bf-danger">긴급 {urgent}건</span>}
              </div>
              <div className="metric-value">{list.length}건</div>
              <div className="text-[11px] text-bf-muted mt-1">{STAGE_LABEL[s].desc}</div>
            </div>
          );
        })}
      </div>

      {/* 처리 대기 통합 list */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="h2">
            처리 대기 ({items.length})
            <HelpHint text="자동 cascade 결과 또는 매장/SNS 발의 결과. 본사는 필요 시 강제 승인 (escalation) 으로 즉시 통과시킬 수 있어요." />
          </h2>
          <span className="label-tag">5초마다 자동 갱신</span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>긴급도</th>
              <th>단계</th>
              <th>도서</th>
              <th>출발 → 도착</th>
              <th className="text-right">수량</th>
              <th>생성</th>
              {role === 'hq-admin' && <th className="text-right">강제 승인</th>}
            </tr>
          </thead>
          <tbody>
            {items.slice(0, 30).map((o) => {
              const stage = STAGE_FROM_TYPE(o.order_type);
              return (
                <tr key={o.order_id}>
                  <td>
                    <span className={
                      o.urgency_level === 'CRITICAL' ? 'pill-rejected' :
                      o.urgency_level === 'URGENT'   ? 'pill-pending' : 'pill-info'
                    }>{ko(URGENCY_KO, o.urgency_level)}</span>
                  </td>
                  <td><span className={STAGE_LABEL[stage].color}>{stage}단계</span> <span className="text-[11px] text-bf-muted ml-1">{ko(ORDER_TYPE_KO, o.order_type)}</span></td>
                  <td>
                    <div className="text-sm">{o.title ?? o.isbn13}</div>
                    <div className="font-mono text-[10px] text-bf-muted">{o.isbn13}</div>
                  </td>
                  <td className="text-[11px]">
                    {o.source_location_id != null ? nameOf(o.source_location_id) : '(출판사)'} → {o.target_location_id != null ? nameOf(o.target_location_id) : '-'}
                  </td>
                  <td className="text-right">{o.qty}권</td>
                  <td className="text-bf-muted text-[11px]">{new Date(o.created_at).toLocaleString('ko-KR')}</td>
                  {role === 'hq-admin' && (
                    <td className="text-right">
                      <button
                        className="btn-outline btn-sm"
                        title="다른 역할 승인 기다리지 않고 본사 단독 강제 승인 (escalation)"
                        onClick={() => setEscalateTarget({
                          order_id: o.order_id,
                          title: o.title ?? o.isbn13,
                          qty: o.qty,
                        })}
                      >
                        강제 승인
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
            {items.length === 0 && !pending.isLoading && (
              <tr><td colSpan={role === 'hq-admin' ? 7 : 6}>
                <EmptyState message="처리 대기 결정 없음" hint="자동 cascade · 매장 요청 · SNS 급등 결과로 발의가 들어오면 여기에 표시됩니다" />
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 시연 trigger 모달 — 예측 부족 도서 list 보여주고 일괄 cascade 발의 */}
      {demoOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setDemoOpen(false)}>
          <div className="bg-bf-bg border border-bf-border rounded-lg p-5 w-full max-w-2xl max-h-[80vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <h3 className="h2 mb-2">시연: 예측 부족 도서 자동 발의</h3>
            <p className="text-xs text-bf-muted mb-3">
              forecast-svc 가 detect 한 "예측 수요 &gt; 현 가용 재고" 인 도서. 한 번 클릭으로 각 도서 cascade 자동 발의 (1단계→2단계→3단계).
              결과 pending_orders 가 생성되어 각 역할이 들어가 승인 흐름 검증 가능.
            </p>
            {insufficient.isLoading && <div className="text-xs text-bf-muted">조회 중…</div>}
            {insufficient.data && (
              <>
                <div className="text-[11px] text-bf-muted mb-2">
                  snapshot {insufficient.data.snapshot_date} · 부족 도서 {insufficient.data.items.length}건
                </div>
                <table className="data-table text-[11px]">
                  <thead>
                    <tr><th>도서</th><th>매장</th><th className="text-right">예측</th><th className="text-right">가용</th><th className="text-right">제안 발주</th></tr>
                  </thead>
                  <tbody>
                    {insufficient.data.items.map((it) => (
                      <tr key={`${it.isbn13}-${it.store_id}`}>
                        <td>{it.title ?? it.isbn13}</td>
                        <td>{nameOf(it.store_id)}</td>
                        <td className="text-right">{it.predicted_demand.toFixed(1)}</td>
                        <td className="text-right">{it.available}</td>
                        <td className="text-right font-semibold">{it.suggested_qty}권</td>
                      </tr>
                    ))}
                    {insufficient.data.items.length === 0 && (
                      <tr><td colSpan={5} className="text-center py-4 text-bf-muted">부족 도서 없음 (시드 forecast_cache 확인 필요)</td></tr>
                    )}
                  </tbody>
                </table>
              </>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn-secondary" onClick={() => setDemoOpen(false)}>취소</button>
              <button
                className="btn-primary"
                disabled={triggerDemo.isPending || !insufficient.data || insufficient.data.items.length === 0}
                onClick={() => insufficient.data && triggerDemo.mutate(insufficient.data.items)}
              >
                {triggerDemo.isPending ? '처리 중…' : `${insufficient.data?.items.length ?? 0}건 일괄 발의`}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        open={escalateTarget !== null}
        title="본사 강제 승인 (escalation)"
        message={escalateTarget ? `"${escalateTarget.title}" · ${escalateTarget.qty}권\n\n다른 역할의 승인을 기다리지 않고 본사 단독으로 즉시 통과시킵니다.\n외부 발주인 경우 비용이 발생할 수 있어요.` : ''}
        confirmText="강제 승인"
        danger
        onConfirm={() => {
          if (escalateTarget) {
            escalate.mutate(escalateTarget.order_id);
            setEscalateTarget(null);
          }
        }}
        onCancel={() => setEscalateTarget(null)}
        isLoading={escalate.isPending}
      />
    </div>
  );
}
