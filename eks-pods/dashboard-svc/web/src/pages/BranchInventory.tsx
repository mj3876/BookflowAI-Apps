import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import {
  ApiError, fetchAllForecast, fetchOverview, postBranchFeedback, postReturnsRequest,
  fetchInventoryByCategory, fetchInsufficientTrend,
  type Role,
} from '../api';
import { useToast } from '../components/Toast';
import { useLocations } from '../useLocations';
import { useScope } from '../auth';
import { useStockUpdates } from '../useStockUpdates';
import InlineMessage from '../components/InlineMessage';
import Pagination, { pageSlice } from '../components/Pagination';
import KpiPie from '../components/charts/KpiPie';
import KpiLine from '../components/charts/KpiLine';

const RETURN_REASONS = ['파손', '불량', '누락', '계약 종료', '기타'];

export default function BranchInventory() {
  const { role } = useOutletContext<{ role: Role }>();
  const { scope_store_id, scope_wh_id } = useScope();
  const { nameOf, byId, items: locItems } = useLocations(role);

  // 2026-05-13 role 기반 매장 selector (hq-admin: 전체 offline+WH · wh-manager: 자기 권역 · branch-clerk: selector 숨김)
  const isHq = role === 'hq-admin';
  const isWhMgr = role === 'wh-manager-1' || role === 'wh-manager-2';
  const accessibleStores = useMemo(() => {
    const offlineAndWh = locItems.filter(
      (l: any) => l.location_type === 'STORE_OFFLINE' || l.location_type === 'WH'
    );
    if (isHq) return offlineAndWh;
    if (isWhMgr && scope_wh_id != null) {
      return offlineAndWh.filter((l: any) => l.wh_id === scope_wh_id);
    }
    if (scope_store_id) return offlineAndWh.filter((l: any) => l.location_id === scope_store_id);
    return [];
  }, [isHq, isWhMgr, locItems, scope_wh_id, scope_store_id]);

  const [selectedLocId, setSelectedLocId] = useState<number | null>(null);
  const effectiveLocId =
    selectedLocId ?? scope_store_id ?? accessibleStores[0]?.location_id ?? 1;
  const effectiveLoc = locItems.find((l: any) => l.location_id === effectiveLocId);
  const effectiveWhId = effectiveLoc?.wh_id ?? 1;

  const my_store = effectiveLocId;
  const wh_id = effectiveWhId;
  // D1-4 Notion 1.1: 온라인 매장 = WH 본체 재고 출처 (별도 inventory row 없음 · backend UNION ALL 으로 노출)
  const myLoc = byId.get(my_store);
  const isOnlineStore = myLoc?.location_type === 'STORE_ONLINE';
  const sourceWhId = myLoc?.wh_id;
  const qc = useQueryClient();

  // overview: 큰 payload (inventory + pending). queryKey ['ov', wh_id, role] WhDashboard/KPI 공유 — 30 초
  // 재고 셀 변동은 Redis stock.changed 로 실시간 반영 (availableOf) · polling 은 정기 reconciliation 용
  const ov = useQuery({
    queryKey: ['ov', wh_id, role],
    queryFn: () => fetchOverview(wh_id, role),
    refetchInterval: 30000,
    staleTime: 15000,
  });

  // D+1 AI 수요예측 batch — 하루 1회. 30 분
  const fcQ = useQuery({
    queryKey: ['forecast-all', role],
    queryFn: () => fetchAllForecast(role),
    refetchInterval: 30 * 60 * 1000,
    staleTime: 10 * 60 * 1000,
  });
  const forecastMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of fcQ.data?.items ?? []) {
      // store_id 가 number/string 가 섞일 가능성 대비 — Number() 정규화
      m.set(`${f.isbn13}|${Number(f.store_id)}`, f.predicted_demand);
    }
    return m;
  }, [fcQ.data?.items]);

  // 매장 forecast 없을 경우 WH location 의 forecast 로 fallback
  // (forecast_cache 가 매장이 아닌 WH 만 갖고 있는 row 대응)
  const forecastOf = (isbn: string, locId: number): number | undefined => {
    const direct = forecastMap.get(`${isbn}|${Number(locId)}`);
    if (direct !== undefined) return direct;
    // fallback: 그 매장의 wh_id 에 해당하는 WH location_id 로 lookup
    const loc = byId.get(locId);
    if (loc?.wh_id != null) {
      // WH location_id 는 14 + wh_id pattern 일 가능성 (seed 기준 15/16) 하나, byId 로 더 안전하게 매칭
      const whLoc = locItems.find(
        (l: any) => l.location_type === 'WH' && l.wh_id === loc.wh_id,
      );
      if (whLoc) {
        const whPred = forecastMap.get(`${isbn}|${Number(whLoc.location_id)}`);
        if (whPred !== undefined) return whPred;
      }
    }
    return undefined;
  };


  // Redis stock.changed 실시간 (cell flash + 가용 즉시 갱신)
  const { flashed, availableOf } = useStockUpdates(role);

  // 검색 / 정렬 / 페이지
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<'available' | 'on_hand' | 'title'>('available');
  const [page, setPage] = useState(1);
  // 검색/정렬 변경 시 첫 페이지로
  useEffect(() => setPage(1), [search, sortKey]);

  const myInventoryRaw = ov.data?.inventory?.items.filter((it) => (it as any).location_id === my_store) ?? [];

  // 검색 + 정렬 + 실시간 available 덮어쓰기
  const myInventory = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? myInventoryRaw.filter((it: any) => (it.title?.toLowerCase() ?? '').includes(q) || (it.author?.toLowerCase() ?? '').includes(q) || it.isbn13.includes(q))
      : myInventoryRaw;
    const sorted = [...filtered].sort((a: any, b: any) => {
      if (sortKey === 'title') return (a.title ?? '').localeCompare(b.title ?? '');
      if (sortKey === 'on_hand') return b.on_hand - a.on_hand;
      // default: 가용 asc (부족 먼저)
      const aAv = availableOf(a.isbn13, my_store) ?? a.available;
      const bAv = availableOf(b.isbn13, my_store) ?? b.available;
      return aAv - bAv;
    });
    return sorted;
  }, [myInventoryRaw, search, sortKey, availableOf, my_store]);

  const total = myInventoryRaw.length;
  const lowStock = myInventoryRaw.filter((it: any) => (availableOf(it.isbn13, my_store) ?? it.available) <= (it.safety_stock ?? 10)).length;
  const totalQty = myInventoryRaw.reduce((s, it) => s + it.on_hand, 0);

  // 차트 1: 카테고리 분포 (매장/권역 보유) — backend role-scope 자동 적용
  const catQ = useQuery({
    queryKey: ['inv-category', role, my_store],
    queryFn: () => fetchInventoryByCategory(role),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 2 * 60 * 1000,
  });
  const categoryPie = (catQ.data?.items ?? []).map((it) => ({
    name: it.category, value: it.on_hand,
  }));

  // 차트 2: 부족 도서 추이 (이번 달 · 30일)
  const trendQ = useQuery({
    queryKey: ['inv-insufficient-trend', role],
    queryFn: () => fetchInsufficientTrend(role, 30),
    refetchInterval: 30 * 60 * 1000,
    staleTime: 10 * 60 * 1000,
  });
  const trendSeries = (trendQ.data?.items ?? []).map((it) => {
    const [, mm, dd] = it.date.split('-');
    return { date: `${parseInt(mm)}/${parseInt(dd)}`, count: it.insufficient_count };
  });

  // P1-3 반품 신청 modal state
  const [returnTarget, setReturnTarget] = useState<{ isbn13: string; on_hand: number } | null>(null);
  const [reason, setReason] = useState(RETURN_REASONS[0]);
  const [qty, setQty] = useState(1);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  // D5-8 의견 제출 modal state
  const { showToast } = useToast();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [fbType, setFbType] = useState<'SLOW_SELLER' | 'STOCK_REQUEST' | 'OTHER'>('SLOW_SELLER');
  const [fbIsbn, setFbIsbn] = useState('');
  const [fbMessage, setFbMessage] = useState('');
  const fbMu = useMutation({
    mutationFn: () => postBranchFeedback(role, {
      feedback_type: fbType,
      isbn13: fbIsbn.length === 13 ? fbIsbn : undefined,
      message: fbMessage,
    }),
    onSuccess: () => {
      showToast({ type: 'success', message: '본사/물류에 의견 제출됨 — 검토 후 회신됩니다' });
      setFeedbackOpen(false); setFbIsbn(''); setFbMessage('');
    },
    onError: (e) => {
      const err = e as ApiError | Error;
      showToast({ type: 'error', message: `제출 실패: ${err.message}`, details: err instanceof ApiError ? err.code : undefined });
    },
  });

  const reqMu = useMutation({
    mutationFn: (body: { isbn13: string; location_id: number; qty: number; reason: string }) =>
      postReturnsRequest(role, body),
    onSuccess: (r) => {
      setFeedback({
        type: 'success',
        msg: `반품 신청됨 — return_id ${r.return_id.slice(0, 8)} · 본사 반품 큐 진입`,
      });
      setReturnTarget(null);
      setQty(1);
      qc.invalidateQueries({ queryKey: ['ov', wh_id, role] });
    },
    onError: (e: Error) => setFeedback({ type: 'error', msg: `반품 신청 실패: ${e.message}` }),
  });

  const onSubmit = () => {
    if (!returnTarget) return;
    reqMu.mutate({
      isbn13: returnTarget.isbn13,
      location_id: my_store,
      qty,
      reason,
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="h1">{nameOf(my_store)} · 매장 재고</h1>
        <p className="text-bf-muted text-xs mt-1">
          현재 보유한 도서 SKU와 가용량 — POS 판매 시 자동 감소 (pos-ingestor Lambda).
          파손/불량/누락 등이 발견되면 SKU 우측 "반품 신청" 으로 본사에 신청할 수 있어요.
        </p>
        {(isHq || isWhMgr) && accessibleStores.length > 1 && (
          <div className="flex items-center gap-2 mt-2 p-2 rounded-lg bg-bf-panel/60 border border-bf-border/40">
            <span className="text-xs text-bf-muted">
              {isHq ? '🔧 본사 모드' : '🏬 권역 매니저'}
            </span>
            <span className="text-xs">·</span>
            <span className="text-xs text-bf-muted">보는 매장:</span>
            <select
              className="ipt text-sm px-2 py-1 rounded bg-bf-panel border border-bf-border"
              value={effectiveLocId}
              onChange={(e) => setSelectedLocId(parseInt(e.target.value, 10))}
            >
              {accessibleStores.map((l: any) => (
                <option key={l.location_id} value={l.location_id}>
                  {l.name}{l.location_type === 'WH' ? ' (온라인 포함)' : ''}
                </option>
              ))}
            </select>
          </div>
        )}
        {isOnlineStore && (
          <div className="mt-2 p-3 rounded-md bg-blue-50 border border-blue-300 text-xs text-blue-900">
            <span className="font-semibold">ℹ️ 온라인 매장 재고 안내</span> — 표시되는 재고는
            <span className="font-semibold"> {sourceWhId === 2 ? '영남' : '수도권'} 권역 거점창고 본체</span> 의 보유량입니다.
            온라인 주문 결제 시 거점창고에서 직접 출하되며, 별도 매장 재고는 운영하지 않습니다.
          </div>
        )}
        {/* D5-8 본사/물류 의견 제출 (Notion 3.5) */}
        <div className="mt-2">
          <button className="btn-outline btn-sm" onClick={() => setFeedbackOpen(true)} title="이 책이 안 팔린다 / 재고가 더 필요하다 등 본사·물류센터에 직접 의견 전달">
            💬 본사·물류에 의견 제출
          </button>
        </div>
      </div>

      {feedback && (
        <InlineMessage
          type={feedback.type}
          message={feedback.msg}
          onClose={() => setFeedback(null)}
          autoDismissMs={feedback.type === 'success' ? 4000 : undefined}
        />
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="metric-card">
          <div className="metric-label">SKU 수</div>
          <div className="metric-value">{total.toLocaleString()}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">총 보유 수량</div>
          <div className="metric-value">{totalQty.toLocaleString()}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">재고 부족 (≤10)</div>
          <div className="metric-value text-bf-danger">{lowStock}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">예약중 합계</div>
          <div className="metric-value">{myInventory.reduce((s, it) => s + it.reserved_qty, 0).toLocaleString()}</div>
        </div>
      </div>

      {/* 차트: 카테고리 분포 + 부족 도서 추이 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h2 className="h2 text-sm">📊 카테고리 분포 (보유)</h2>
          </div>
          <KpiPie
            data={categoryPie}
            nameKey="name"
            valueKey="value"
            donut
            height={220}
            isLoading={catQ.isLoading}
          />
        </div>
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <h2 className="h2 text-sm">📊 부족 도서 추이 (30일)</h2>
            {trendQ.data?.note && (
              <span className="text-[10px] text-bf-muted">{trendQ.data.note}</span>
            )}
          </div>
          <KpiLine
            data={trendSeries}
            xKey="date"
            yKey="count"
            yLabels={['부족 SKU 수']}
            area
            height={220}
            isLoading={trendQ.isLoading}
          />
        </div>
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-3 gap-2">
          <h2 className="h2">매장 도서 (책 단위 · 실시간)</h2>
          <div className="flex gap-2 items-center">
            <input
              className="ipt text-xs w-48"
              placeholder="제목/저자/ISBN 검색"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              className="ipt text-xs"
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as any)}
              title="정렬 기준"
            >
              <option value="available">가용 적은 순</option>
              <option value="on_hand">재고 많은 순</option>
              <option value="title">제목 가나다</option>
            </select>
          </div>
        </div>
        <div className="text-[11px] text-bf-muted mb-2">
          POS 결제·재고조정 발생 시 가용 셀이 <span className="px-1 bg-yellow-100">노란 flash</span> 로 표시됩니다 (Redis stock.changed 실시간)
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>도서</th>
              <th>저자</th>
              <th className="text-right">보유</th>
              <th className="text-right">예약</th>
              <th className="text-right">가용</th>
              <th className="text-right">안전재고</th>
              <th className="text-right" title="forecast-svc D+1 예측 수요 (권/일) · 5일치 = 안전재고 권장선">
                AI 수요예측<br/>
                <span className="text-[10px] font-normal text-bf-muted">D+1 권/일</span>
              </th>
              <th>상태</th>
              <th className="text-right">처리</th>
            </tr>
          </thead>
          <tbody>
            {pageSlice(myInventory, page, 20).map((it: any) => {
              const liveAvail = availableOf(it.isbn13, my_store);
              const av = liveAvail ?? it.available;
              const isFlashing = flashed(it.isbn13, my_store);
              const safety = it.safety_stock ?? 10;
              return (
                <tr key={it.isbn13}>
                  <td>
                    <div className="flex items-center gap-2">
                      {it.cover_url ? (
                        <img
                          src={it.cover_url}
                          alt=""
                          className="w-[36px] h-[50px] object-cover rounded-sm border border-bf-border flex-shrink-0"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-[36px] h-[50px] bg-bf-panel2 border border-bf-border rounded-sm flex-shrink-0" />
                      )}
                      <div>
                        <div className="font-medium text-bf-text">{it.title ?? it.isbn13}</div>
                        <div className="font-mono text-[10px] text-bf-muted">{it.isbn13}</div>
                      </div>
                    </div>
                  </td>
                  <td className="text-bf-muted">{it.author ?? '-'}</td>
                  <td className="text-right">{it.on_hand}</td>
                  <td className="text-right text-bf-muted">{it.reserved_qty}</td>
                  <td className={`text-right font-semibold ${isFlashing ? 'animate-flash' : ''}`}>
                    {av}
                  </td>
                  <td className="text-right text-bf-muted">{safety}</td>
                  <td className="text-right">
                    {(() => {
                      const pred = forecastOf(it.isbn13, my_store);
                      if (pred == null) return <span className="text-bf-muted">-</span>;
                      const safety5 = Math.round(pred * 5);
                      // 가용 < 5일치 예측 = 안전선 미만 → 강조
                      const insufficient = av < safety5;
                      return (
                        <>
                          <span className={`font-mono ${insufficient ? 'text-orange-600 font-semibold' : ''}`}>
                            {pred.toFixed(1)}
                          </span>
                          <div className="text-[10px] text-bf-muted">
                            5일치 <span className={insufficient ? 'text-orange-600' : ''}>{safety5}</span>
                          </div>
                        </>
                      );
                    })()}
                  </td>
                  <td>
                    {av === 0
                      ? <span className="pill-rejected">SOLD OUT</span>
                      : av <= safety
                      ? <span className="pill-pending">LOW</span>
                      : av <= safety * 2
                      ? <span className="pill-pending text-yellow-700">주의</span>
                      : <span className="pill-approved">OK</span>}
                  </td>
                  <td className="text-right">
                    <button
                      className="btn-outline btn-sm"
                      disabled={it.on_hand === 0}
                      onClick={() => { setQty(1); setReason(RETURN_REASONS[0]); setReturnTarget({ isbn13: it.isbn13, on_hand: it.on_hand }); }}
                      title="파손/불량/누락 등 발견 시 본사에 반품 신청"
                    >
                      반품 신청
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <Pagination total={myInventory.length} page={page} pageSize={20} onChange={setPage} />
      </div>

      {/* 반품 신청 모달 */}
      {returnTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setReturnTarget(null)}>
          <div className="bg-bf-bg border border-bf-border rounded-lg p-5 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h3 className="h2 mb-3">반품 신청</h3>
            <div className="text-xs text-bf-muted mb-4">
              ISBN <span className="font-mono">{returnTarget.isbn13}</span> · 매장 보유 <b>{returnTarget.on_hand}</b>권 중 일부 반품 신청 → 본사 반품 큐 진입.
            </div>
            <div className="space-y-3">
              <div>
                <div className="label-tag mb-1">사유</div>
                <select className="ipt w-full" value={reason} onChange={(e) => setReason(e.target.value)}>
                  {RETURN_REASONS.map((r) => <option key={r}>{r}</option>)}
                </select>
              </div>
              <div>
                <div className="label-tag mb-1">수량 (1 ~ {returnTarget.on_hand})</div>
                <input
                  type="number"
                  className="ipt w-full"
                  value={qty}
                  min={1}
                  max={returnTarget.on_hand}
                  onChange={(e) => setQty(Math.max(1, Math.min(returnTarget.on_hand, parseInt(e.target.value) || 1)))}
                />
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn-secondary" onClick={() => setReturnTarget(null)}>취소</button>
              <button
                className="btn-primary"
                disabled={reqMu.isPending}
                onClick={onSubmit}
              >
                {reqMu.isPending ? '신청 중…' : '신청'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* D5-8 본사·물류 의견 제출 modal */}
      {feedbackOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[1000]" role="dialog" aria-modal="true">
          <div className="bg-bf-panel border border-bf-border rounded-lg p-5 w-[460px] shadow-xl">
            <h2 className="h2 mb-3">본사·물류에 의견 제출</h2>
            <div className="text-xs text-bf-muted mb-3">
              "이 책 안 팔린다" / "재고 더 필요" / 기타 매장 사정 의견을 본사·권역 물류센터에 직접 전달합니다.
            </div>
            <div className="space-y-3 mb-4">
              <div>
                <label className="text-xs text-bf-muted">유형</label>
                <select className="ipt w-full" value={fbType} onChange={(e) => setFbType(e.target.value as any)}>
                  <option value="SLOW_SELLER">잘 안 팔림 (SLOW_SELLER)</option>
                  <option value="STOCK_REQUEST">재고 추가 요청 (STOCK_REQUEST)</option>
                  <option value="OTHER">기타 (OTHER)</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-bf-muted">ISBN (선택 · 13자리)</label>
                <input className="ipt w-full font-mono" value={fbIsbn} onChange={(e) => setFbIsbn(e.target.value)} placeholder="9788..." maxLength={13} />
              </div>
              <div>
                <label className="text-xs text-bf-muted">의견 *</label>
                <textarea
                  className="ipt w-full"
                  rows={4}
                  maxLength={500}
                  value={fbMessage}
                  onChange={(e) => setFbMessage(e.target.value)}
                  placeholder="예: 이 책은 신간이지만 한 달째 1권도 안 팔립니다 — 다른 매장으로 재분배 검토 부탁드립니다"
                />
                <div className="text-[10px] text-bf-muted text-right mt-1">{fbMessage.length}/500</div>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button className="btn-secondary" onClick={() => setFeedbackOpen(false)}>취소</button>
              <button className="btn-primary" disabled={fbMu.isPending || fbMessage.trim().length === 0} onClick={() => fbMu.mutate()}>
                {fbMu.isPending ? '제출 중…' : '제출'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
