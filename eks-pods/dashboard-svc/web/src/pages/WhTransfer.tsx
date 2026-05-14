import { Fragment, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import ReactECharts from 'echarts-for-react';
import { fetchPending, postIntervenebatch, type PendingOrder, type Role } from '../api';
import { ko, ORDER_STATUS_KO, URGENCY_KO, whName } from '../labels';
import { useLocations } from '../useLocations';
import { groupByDate, dateGroupTone } from '../dateGroup';
import KpiLine from '../components/charts/KpiLine';
import KpiPie from '../components/charts/KpiPie';
import { useToast } from '../components/Toast';

/**
 * 권역 이동 - 2단계 SOURCE/TARGET 이중 승인 시나리오 (.pen C-1~C-4).
 * pending_orders 중 order_type='WH_TRANSFER' 만 필터.
 *
 * UX-4: row 클릭 시 forecast_rationale 펼침 — Stage 2 partner_surplus 계산 내역 표시 (FR-A5.3 / A5.6).
 */

type Rationale = NonNullable<PendingOrder['forecast_rationale']>;

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'number') return v.toLocaleString();
  return String(v);
}

function RationaleDetail({ r, qty }: { r: Rationale; qty: number }) {
  const stage = r.stage as number | undefined;
  const partnerSurplus = r.partner_surplus as number | undefined;
  const hasPartner = stage === 2 && r.partner_wh != null;
  const ratio = r.ratio as number | undefined;
  const reason = r.reason as string | undefined;

  // partner_surplus 계산식 시각화 — 출발 권역 가용 보유분 산출 step-by-step.
  // 공식 (decision-svc Stage 2): partner_surplus = on_hand - reserved - safety - expected_demand_14d
  const onHand = typeof r.partner_on_hand === 'number' ? r.partner_on_hand : null;
  const reserved = typeof r.partner_reserved === 'number' ? r.partner_reserved : null;
  const safety = typeof r.partner_safety === 'number' ? r.partner_safety : null;
  const demand14 = typeof r.partner_expected_demand_14d === 'number' ? r.partner_expected_demand_14d : null;
  const canCompute = hasPartner && onHand != null && reserved != null && safety != null && demand14 != null;
  const computed = canCompute ? onHand - reserved - safety - demand14 : null;
  const surplusValue = typeof partnerSurplus === 'number' ? partnerSurplus : computed;

  return (
    <div className="bg-bf-card border border-bf-border rounded-md p-3 text-xs">
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-bf-fg font-semibold">
          의사결정 근거 {stage ? `· Stage ${stage}` : '· 권역 간 이동'}
        </div>
        <div className="text-bf-muted">요청 수량 {qty.toLocaleString()}권</div>
      </div>
      {hasPartner ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <div><div className="text-bf-muted text-[10px]">출발 권역</div><div className="font-mono">{whName((r.partner_wh as number) ?? 0)}</div></div>
            <div><div className="text-bf-muted text-[10px]">출발 보유</div><div className="font-mono">{fmt(r.partner_on_hand)}</div></div>
            <div><div className="text-bf-muted text-[10px]">예약 분</div><div className="font-mono">{fmt(r.partner_reserved)}</div></div>
            <div><div className="text-bf-muted text-[10px]">안전재고</div><div className="font-mono">{fmt(r.partner_safety)}</div></div>
            <div><div className="text-bf-muted text-[10px]">14일 예상수요</div><div className="font-mono">{fmt(r.partner_expected_demand_14d)}</div></div>
            <div><div className="text-bf-muted text-[10px]">출발 여유분</div><div className={`font-mono font-semibold ${typeof partnerSurplus === 'number' && partnerSurplus < qty ? 'text-orange-600' : 'text-green-700'}`}>{fmt(partnerSurplus)}</div></div>
            <div><div className="text-bf-muted text-[10px]">이전 가능</div><div className="font-mono">{fmt(r.transferable_qty)}</div></div>
            <div><div className="text-bf-muted text-[10px]">출발 위치 ID</div><div className="font-mono">{fmt(r.source_location_id)}</div></div>
          </div>

          {/* partner_surplus 계산식 자세히 — 시각적 분해 (.pen C-3 의 Stage 2 산출 공식) */}
          <div className="mt-3 pt-3 border-t border-bf-border">
            <div className="text-[11px] text-bf-fg font-semibold mb-2">📐 출발 권역 가용 여유분 계산식</div>
            <div className="flex items-center flex-wrap gap-1.5 text-[11px]">
              <span className="px-2 py-1 rounded bg-blue-500/10 border border-blue-500/40 font-mono">
                보유 <b>{fmt(onHand)}</b>
              </span>
              <span className="text-bf-muted">−</span>
              <span className="px-2 py-1 rounded bg-orange-500/10 border border-orange-500/40 font-mono">
                예약 <b>{fmt(reserved)}</b>
              </span>
              <span className="text-bf-muted">−</span>
              <span className="px-2 py-1 rounded bg-yellow-500/10 border border-yellow-500/40 font-mono">
                안전재고 <b>{fmt(safety)}</b>
              </span>
              <span className="text-bf-muted">−</span>
              <span className="px-2 py-1 rounded bg-rose-500/10 border border-rose-500/40 font-mono">
                14일 수요 <b>{fmt(demand14)}</b>
              </span>
              <span className="text-bf-muted">=</span>
              <span className={`px-2.5 py-1 rounded font-mono font-bold ${
                surplusValue != null && surplusValue < qty
                  ? 'bg-orange-500/20 border border-orange-500/60 text-orange-700'
                  : 'bg-green-500/20 border border-green-500/60 text-green-700'
              }`}>
                가용 {fmt(surplusValue)}
              </span>
            </div>
            <div className="mt-2 text-[10px] text-bf-muted">
              {surplusValue != null && surplusValue < qty
                ? `⚠ 가용 여유분 ${surplusValue}권 < 요청 ${qty}권 — 부분 이전 또는 거절 권장`
                : `✓ 가용 여유분이 요청 수량을 충족 — 이전 가능`}
            </div>
          </div>
        </>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {reason && <div><div className="text-bf-muted text-[10px]">발의 사유</div><div className="font-medium">{reason}</div></div>}
          {typeof ratio === 'number' && <div><div className="text-bf-muted text-[10px]">권역 균형 비율</div><div className="font-mono">{(ratio * 100).toFixed(0)}%</div></div>}
        </div>
      )}
      {typeof r.stock_days_remaining === 'number' && (
        <div className="mt-2 pt-2 border-t border-bf-border text-bf-muted text-[11px]">
          현재 가용 {fmt(r.current_available)} · 일일 예상수요 {fmt(r.predicted_daily_demand)} · 재고 잔여 {(r.stock_days_remaining as number).toFixed(2)}일
        </div>
      )}
    </div>
  );
}

function TransferTable({
  rows,
  emptyText,
  expandedId,
  onToggle,
  labelOf,
  myWh,
  whIdOf,
}: {
  rows: PendingOrder[];
  emptyText: string;
  expandedId: string | null;
  onToggle: (id: string) => void;
  labelOf: (id: number | null | undefined) => string;
  myWh: number;
  whIdOf: (id: number | null | undefined) => number | undefined;
}) {
  return (
    <table className="data-table">
      <thead>
        <tr><th></th><th>긴급도</th><th>도서</th><th>출발 → 도착</th><th>발의</th><th className="text-right">수량</th><th>상태</th></tr>
      </thead>
      <tbody>
        {groupByDate(rows.slice(0, 50)).map((g) => {
          const tone = dateGroupTone(g.label);
          return (
        <Fragment key={g.key}>
          <tr className="bg-bf-panel2"><td colSpan={7} className={`py-1.5 px-3 ${tone.wrap}`}>
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`px-2 py-0.5 rounded text-[11px] font-semibold ${tone.pill}`}>{g.label}</span>
              <span className="text-[11px] text-bf-muted">{g.total}건 · 처리완료 {g.done}/{g.total} ({g.progressPct}%)</span>
              {g.approved > 0 && <span className="text-[10px] text-green-700">✓ {g.approved}</span>}
              {g.rejected > 0 && <span className="text-[10px] text-red-700">✗ {g.rejected}</span>}
              {g.pending > 0 && <span className="text-[10px] text-orange-600">⏳ {g.pending}</span>}
              {g.allDone && <span className="ml-1 px-2 py-0.5 rounded bg-green-500/20 text-green-300 text-[10px] font-semibold border border-green-500/40">✅ 완료 · 최종 계획안</span>}
            </div>
          </td></tr>
        {g.rows.map((o) => {
          const isOpen = expandedId === o.order_id;
          const hasR = !!o.forecast_rationale;
          return (
            <Fragment key={o.order_id}>
              <tr className={hasR ? 'cursor-pointer hover:bg-bf-card/50' : ''} onClick={() => hasR && onToggle(o.order_id)}>
                <td className="text-bf-muted text-xs">{hasR ? (isOpen ? '▼' : '▶') : ''}</td>
                <td>
                  <span className={
                    o.urgency_level === 'CRITICAL' ? 'pill-rejected' :
                    o.urgency_level === 'URGENT'   ? 'pill-pending' : 'pill-info'
                  }>{ko(URGENCY_KO, o.urgency_level)}</span>
                </td>
                <td>
                  <div className="text-xs">{o.title ?? o.isbn13}</div>
                  <div className="font-mono text-[10px] text-bf-muted">{o.isbn13}</div>
                </td>
                <td>
                  {(() => {
                    const sWh = whIdOf(o.source_location_id);
                    const tWh = whIdOf(o.target_location_id);
                    const sMine = sWh === myWh;
                    const tMine = tWh === myWh;
                    return (
                      <div className="flex items-center gap-1.5 text-[11px]">
                        <span className={`px-1.5 py-0.5 rounded border ${sMine ? 'bg-blue-500/15 text-blue-300 border-blue-500/40 font-semibold' : 'bg-bf-panel2 text-bf-muted border-bf-border'}`}>{labelOf(o.source_location_id)}</span>
                        <span className="text-bf-primary font-bold">→</span>
                        <span className={`px-1.5 py-0.5 rounded border ${tMine ? 'bg-rose-500/15 text-rose-300 border-rose-500/40 font-semibold' : 'bg-bf-panel2 text-bf-muted border-bf-border'}`}>{labelOf(o.target_location_id)}</span>
                      </div>
                    );
                  })()}
                </td>
                <td>
                  {/* D1-7: WH_TRANSFER 발의자 = source 권역. source 가 내 권역이면 우리 발의 */}
                  {whIdOf(o.source_location_id) === myWh ? (
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-blue-500/15 text-blue-300 border border-blue-500/40">🟦 우리 발의</span>
                  ) : (
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-orange-500/15 text-orange-300 border border-orange-500/40">🟧 상대 발의</span>
                  )}
                </td>
                <td className="text-right">{o.qty}권</td>
                <td>
                  <span className={
                    o.status === 'APPROVED' ? 'pill-approved' :
                    o.status === 'REJECTED' ? 'pill-rejected' : 'pill-pending'
                  }>{ko(ORDER_STATUS_KO, o.status)}</span>
                </td>
              </tr>
              {isOpen && hasR && (
                <tr>
                  <td colSpan={7} className="!p-2">
                    <RationaleDetail r={o.forecast_rationale as Rationale} qty={o.qty} />
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
        </Fragment>
          );
        })}
        {rows.length === 0 && (
          <tr><td colSpan={7} className="text-center py-6 text-bf-muted">{emptyText}</td></tr>
        )}
      </tbody>
    </table>
  );
}

export default function WhTransfer() {
  const { role } = useOutletContext<{ role: Role }>();
  // role check 완화 (2026-05-13) — hq-admin · wh-manager-1 · wh-manager-2 모두 허용.
  // 본사 (hq-admin) = 전사 모든 데이터 read + 강제 승인 권한.
  const isHq = role === 'hq-admin';
  const wh = role === 'wh-manager-2' ? 2 : 1; // hq-admin 은 표시상 수도권 다이어그램 기준 (UI 강조 X)
  const [expanded, setExpanded] = useState<string | null>(null);
  const { byId, labelOf } = useLocations(role);
  const qc = useQueryClient();
  const { showToast } = useToast();
  const whIdOf = (id: number | null | undefined): number | undefined => {
    if (id == null) return undefined;
    return byId.get(id)?.wh_id ?? undefined;
  };

  const q = useQuery({ queryKey: ['pending-transfer', role], queryFn: () => fetchPending(role, { order_type: 'WH_TRANSFER', limit: 100 }), refetchInterval: 5000 });

  // 30일 history (분석 뷰 차별화 — 추세 라인 + 발의자 pie + sankey)
  // include_history=true · days=30 — 5 분 cache (분석용 · 실시간 불필요)
  const history30 = useQuery({
    queryKey: ['transfer-history-30', role],
    queryFn: () => fetchPending(role, { order_type: 'WH_TRANSFER', include_history: true, days: 30, limit: 500 }),
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });

  const transfers = q.data?.items.filter((o) => o.order_type === 'WH_TRANSFER') ?? [];
  const history = history30.data?.items.filter((o) => o.order_type === 'WH_TRANSFER') ?? [];

  // 30일 권역 이동 추이 line (date → count · qty)
  const dailyTrend = useMemo(() => {
    const byDate = new Map<string, { count: number; qty: number }>();
    for (const o of history) {
      const d = (o.created_at ?? '').slice(0, 10);
      if (!d) continue;
      const cur = byDate.get(d) ?? { count: 0, qty: 0 };
      cur.count += 1;
      cur.qty += o.qty ?? 0;
      byDate.set(d, cur);
    }
    return [...byDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, v]) => ({ date: date.slice(5), 건수: v.count, 수량: v.qty }));
  }, [history]);

  // 발의자 분석 pie (auto vs manual)
  //   AUTO_EXECUTED (07:00 batch 자동 승인) = auto
  //   그 외 PENDING/APPROVED/REJECTED/EXECUTED = manual (사용자 의사결정)
  const initiatorPie = useMemo(() => {
    let auto = 0;
    let manual = 0;
    for (const o of history) {
      if (o.status === 'AUTO_EXECUTED' || (o as any).auto_execute_eligible === true) {
        auto += 1;
      } else {
        manual += 1;
      }
    }
    return [
      { name: 'decision-svc 자동', value: auto },
      { name: '사용자 수동', value: manual },
    ];
  }, [history]);

  // 권역간 흐름 sankey — wh1 ↔ wh2 양방향 qty
  const sankeyOption = useMemo(() => {
    let wh1ToWh2 = 0;
    let wh2ToWh1 = 0;
    for (const o of history) {
      const sWh = whIdOf(o.source_location_id);
      const tWh = whIdOf(o.target_location_id);
      const qty = o.qty ?? 0;
      if (sWh === 1 && tWh === 2) wh1ToWh2 += qty;
      else if (sWh === 2 && tWh === 1) wh2ToWh1 += qty;
    }
    // Sankey 는 양방향 표현 불가 — 한쪽씩 source/target 분리 노드 사용
    const nodes = [
      { name: '수도권 (출발)' },
      { name: '영남 (출발)' },
      { name: '수도권 (도착)' },
      { name: '영남 (도착)' },
    ];
    const links = [
      { source: '수도권 (출발)', target: '영남 (도착)', value: wh1ToWh2 },
      { source: '영남 (출발)', target: '수도권 (도착)', value: wh2ToWh1 },
    ].filter((l) => l.value > 0);
    return {
      tooltip: { trigger: 'item', formatter: (p: any) => `${p.name}<br/>${p.value?.toLocaleString?.() ?? p.value} 권` },
      series: [
        {
          type: 'sankey',
          left: 30,
          right: 130,
          top: 20,
          bottom: 20,
          nodeWidth: 18,
          nodeGap: 14,
          data: nodes,
          links,
          lineStyle: { color: 'gradient', curveness: 0.5 },
          label: { color: '#212529', fontSize: 11 },
          itemStyle: { borderColor: '#FFFFFF', borderWidth: 1 },
        },
      ],
    };
  }, [history, whIdOf]);
  const sankeyHasData = (sankeyOption.series[0].links?.length ?? 0) > 0;
  // D1-3a: locations.wh_id 기준 분리 (이전 not-null 비교는 모든 row 가 양쪽 list 에 중복으로 들어가 버그)
  // hq-admin: 자기 권역 제약 없이 전사 모든 WH_TRANSFER 표시 (수도권→영남 = outbound, 영남→수도권 = inbound 로 분리)
  const outbound = isHq
    ? transfers.filter((o) => whIdOf(o.source_location_id) === 1)
    : transfers.filter((o) => whIdOf(o.source_location_id) === wh);
  const inbound  = isHq
    ? transfers.filter((o) => whIdOf(o.source_location_id) === 2)
    : transfers.filter((o) => whIdOf(o.target_location_id) === wh);
  const toggle = (id: string) => setExpanded((cur) => (cur === id ? null : id));

  // 본사 (hq-admin) 일괄 강제 승인 — SOURCE + TARGET 양측 모두 처리
  const pendingTransfers = transfers.filter((o) => o.status === 'PENDING');
  const hqBulkApprove = async () => {
    if (!isHq) return;
    if (!pendingTransfers.length) return;
    if (!confirm(`${pendingTransfers.length}건의 권역 이동을 본사 강제 승인합니다.\n양측 (SOURCE + TARGET) 모두 처리됩니다.`)) return;
    try {
      const sourceItems = pendingTransfers.map((o) => ({ order_id: o.order_id, approval_side: 'SOURCE' }));
      const targetItems = pendingTransfers.map((o) => ({ order_id: o.order_id, approval_side: 'TARGET' }));
      const r1 = await postIntervenebatch(role, 'approve', sourceItems);
      const r2 = await postIntervenebatch(role, 'approve', targetItems);
      showToast({ type: 'success', message: `본사 강제 승인 완료 — SOURCE ${r1.ok}/${r1.total} · TARGET ${r2.ok}/${r2.total}` });
      qc.invalidateQueries({ queryKey: ['pending-transfer'] });
      qc.invalidateQueries({ queryKey: ['transfer-history-30'] });
      qc.invalidateQueries({ queryKey: ['pending-active'] });
      qc.invalidateQueries({ queryKey: ['pending-detail'] });
      qc.invalidateQueries({ queryKey: ['pending-summary'] });
      qc.invalidateQueries({ queryKey: ['pending-summary-today'] });
      qc.invalidateQueries({ queryKey: ['plan-summary'] });
      qc.invalidateQueries({ queryKey: ['plan-items'] });
      qc.invalidateQueries({ queryKey: ['plan-items-approved'] });
      qc.invalidateQueries({ queryKey: ['plan-items-delta'] });
      qc.invalidateQueries({ queryKey: ['instr-all'] });
      qc.invalidateQueries({ queryKey: ['instr'] });
    } catch (e) {
      showToast({ type: 'error', message: `본사 강제 승인 실패: ${String(e)}` });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="h1">
            {isHq ? '🔧 본사 모드 · 전사 권역 이동 분석' : `${whName(wh)} 권역 이동 분석`}
          </h1>
          <p className="text-bf-muted text-xs mt-1">
            권역 간 이동의 <b>근거 분석 · 추세 · 발의자</b> 중심 뷰입니다. <b>승인 처리</b>는 처리 대기 (WhApprove · WH_TRANSFER 탭) 에서 진행하세요.
            행 클릭 시 출발 권역의 가용 여유분 (보유 − 예약 − 안전재고 − 14일 수요) 계산식을 단계별로 보여줍니다.
          </p>
        </div>
        {isHq && pendingTransfers.length > 0 && (
          <button
            className="btn-primary shrink-0 text-sm font-semibold"
            onClick={hqBulkApprove}
            title="양측 (SOURCE + TARGET) 모두 한 번에 강제 승인"
          >
            🔧 본사 일괄 강제 승인 ({pendingTransfers.length}건)
          </button>
        )}
      </div>

      {/* 권역 흐름 다이어그램 */}
      <div className="card">
        <div className="flex items-center justify-center gap-4 py-4">
          {/* 좌측 권역 */}
          <div className={`flex flex-col items-center px-5 py-3 rounded-lg border-2 ${wh === 1 ? 'border-bf-primary bg-bf-primary/10' : 'border-bf-border bg-bf-panel2'}`}>
            <div className="text-base font-bold mb-1">수도권</div>
            <div className="text-[10px] text-bf-muted text-center leading-tight">강남·광화문·잠실<br/>홍대·신촌·용산</div>
            <div className="mt-2 text-xs">
              {wh === 1 ? (
                <span className="pill-info">내 권역</span>
              ) : (
                <span className="text-bf-muted">상대 권역</span>
              )}
            </div>
          </div>

          {/* 화살표 (양방향) */}
          <div className="flex flex-col items-center text-bf-muted">
            <div className="flex items-center gap-1 text-xs">
              <span>→</span>
              <span className="text-[10px]">출고 {outbound.length}건</span>
            </div>
            <div className="my-1 text-[10px] text-bf-muted">{transfers.length} 건</div>
            <div className="flex items-center gap-1 text-xs">
              <span className="text-[10px]">입고 {inbound.length}건</span>
              <span>←</span>
            </div>
          </div>

          {/* 우측 권역 */}
          <div className={`flex flex-col items-center px-5 py-3 rounded-lg border-2 ${wh === 2 ? 'border-bf-primary bg-bf-primary/10' : 'border-bf-border bg-bf-panel2'}`}>
            <div className="text-base font-bold mb-1">영남</div>
            <div className="text-[10px] text-bf-muted text-center leading-tight">부산서면·대구동성<br/>울산삼산·대구교대<br/>부산센텀·포항양덕</div>
            <div className="mt-2 text-xs">
              {wh === 2 ? (
                <span className="pill-info">내 권역</span>
              ) : (
                <span className="text-bf-muted">상대 권역</span>
              )}
            </div>
          </div>
        </div>
        <div className="text-[11px] text-bf-muted text-center">
          내 권역(파랑) 입장 — 출고는 상대 권역으로 보내고, 입고는 상대 권역에서 받습니다.
        </div>
      </div>

      {/* 분석 뷰 차별화 (2026-05-13) — 추세 + 발의자 + 흐름 */}
      <div className="card">
        <h3 className="h3 mb-2">권역 이동 30일 추이 (건수 · 수량)</h3>
        <KpiLine
          data={dailyTrend}
          xKey="date"
          yKey={['건수', '수량']}
          yLabels={['건수', '수량 (권)']}
          height={260}
          smooth
          isLoading={history30.isLoading}
        />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="card">
          <h3 className="h3 mb-2">발의자 분석 (30일 · auto vs manual)</h3>
          <KpiPie data={initiatorPie} height={280} isLoading={history30.isLoading} />
          <div className="text-[10px] text-bf-muted mt-1">
            decision-svc 07:00 KST batch 자동 발의 vs 본사/창고 담당자 수동 발의 비율
          </div>
        </div>
        <div className="card">
          <h3 className="h3 mb-2">권역간 흐름 (30일 누적 수량)</h3>
          {history30.isLoading ? (
            <div className="h-[280px] rounded bg-bf-panel2 border border-bf-border2 animate-pulse" />
          ) : sankeyHasData ? (
            <ReactECharts option={sankeyOption} style={{ height: 280 }} opts={{ renderer: 'svg' }} />
          ) : (
            <div className="h-[280px] flex items-center justify-center text-bf-muted text-xs rounded bg-bf-panel2 border border-bf-border2">
              30일 권역 이동 누적 데이터 없음
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <h2 className="h2">{isHq ? `수도권 → 영남 (${outbound.length})` : `우리 창고가 보낼 항목 (${outbound.length})`}</h2>
            <span className="text-[10px] text-bf-muted">{isHq ? '본사 전사 모니터링' : '상대 창고 수락 대기'}</span>
          </div>
          <TransferTable rows={outbound} emptyText="발의 건 없음" expandedId={expanded} onToggle={toggle} labelOf={labelOf} myWh={wh} whIdOf={whIdOf} />
        </div>

        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <h2 className="h2">{isHq ? `영남 → 수도권 (${inbound.length})` : `우리 창고가 받을 항목 (${inbound.length})`}</h2>
            <span className="text-[10px] text-bf-muted">{isHq ? '본사 전사 모니터링' : '수락하면 운송 시작'}</span>
          </div>
          <TransferTable rows={inbound} emptyText="수락 대기 없음" expandedId={expanded} onToggle={toggle} labelOf={labelOf} myWh={wh} whIdOf={whIdOf} />
        </div>
      </div>
    </div>
  );
}
