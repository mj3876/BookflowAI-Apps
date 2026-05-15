import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import {
  fetchAllForecast,
  fetchCascadeFunnel,
  fetchInventoryByCategory,
  fetchInventoryByStore,
  fetchOverview,
  type Role,
} from '../api';
import { useLocations } from '../useLocations';
import { useScope } from '../auth';
import { useStockUpdates } from '../useStockUpdates';
import Pagination, { pageSlice } from '../components/Pagination';
import KpiBar from '../components/charts/KpiBar';
import KpiLine from '../components/charts/KpiLine';
import KpiPie from '../components/charts/KpiPie';

/**
 * D1-5 v2 (2026-05-12 사용자 추가 요구):
 *   "물류센터도 재고 볼 수 있는거 — 지점이 자기 재고 보듯이 탭을 하나 만들라"
 *   wh-manager 가 자기 거점창고 (location_type='WH') 의 1000 SKU 를 책 단위로 본다.
 *   레이아웃 = BranchInventory 와 동일 (검색 + 정렬 + 페이지 + 실시간 cell flash).
 */
export default function WhInventory() {
  const { role } = useOutletContext<{ role: Role }>();
  const { byId, items: locItems } = useLocations(role);
  const { scope_wh_id, scope_store_id } = useScope();

  // 2026-05-13 role 기반 WH selector — hq-admin: 두 권역 선택 · wh-manager: 자기 권역만 · branch-clerk: 자기 매장 wh 자동
  const isHq = role === 'hq-admin';
  const isWhMgr = role === 'wh-manager-1' || role === 'wh-manager-2';
  const isBranchClerk = role === 'branch-clerk';

  // branch-clerk: 자기 매장의 wh_id 자동 derive
  const branchWhId = useMemo(() => {
    if (!isBranchClerk || scope_store_id == null) return null;
    const myStore = locItems.find((l: any) => l.location_id === scope_store_id);
    return (myStore as any)?.wh_id ?? null;
  }, [isBranchClerk, scope_store_id, locItems]);

  const accessibleWhs = useMemo(() => {
    const whs = locItems.filter((l: any) => l.location_type === 'WH');
    if (isHq) return whs;
    if (isWhMgr && scope_wh_id != null) return whs.filter((l: any) => l.wh_id === scope_wh_id);
    if (isBranchClerk && branchWhId != null) return whs.filter((l: any) => l.wh_id === branchWhId);
    return [];
  }, [isHq, isWhMgr, isBranchClerk, branchWhId, locItems, scope_wh_id]);

  const [selectedWhId, setSelectedWhId] = useState<number | null>(null);
  const fallbackWhId = role === 'wh-manager-2' ? 2 : 1;
  const wh_id =
    selectedWhId ?? scope_wh_id ?? branchWhId ?? accessibleWhs[0]?.wh_id ?? fallbackWhId;

  // 내 거점창고 location (각 wh 당 1개) — locations 의 wh_id × type=WH
  const whLoc = useMemo(() => locItems.find((l) => l.wh_id === wh_id && l.location_type === 'WH'), [locItems, wh_id]);
  const whLocId = whLoc?.location_id;

  // v5 2026-05-15: 매장 view 분기
  // - URL ?view=stores → 권역 매장 selector + 매장 inventory
  // - branch-clerk → 자기 매장 자동 (selectedLocId 고정)
  // - default (wh body) → 거점창고 본체 inventory
  const urlParams = new URLSearchParams(window.location.search);
  const initialViewMode: 'wh' | 'stores' = urlParams.get('view') === 'stores' ? 'stores' : 'wh';
  const [viewMode, setViewMode] = useState<'wh' | 'stores'>(isBranchClerk ? 'stores' : initialViewMode);

  // 권역 내 매장 (location_type !== 'WH' && wh_id 일치)
  const storeLocsInScope = useMemo(() => {
    if (!wh_id) return [];
    return locItems.filter((l: any) => l.wh_id === wh_id && l.location_type !== 'WH' && !l.is_virtual);
  }, [locItems, wh_id]);

  const [selectedStoreLocId, setSelectedStoreLocId] = useState<number | null>(null);
  // 실제 표시할 location_id
  const effectiveLocId =
    viewMode === 'stores'
      ? (isBranchClerk ? scope_store_id : (selectedStoreLocId ?? storeLocsInScope[0]?.location_id ?? whLocId))
      : whLocId;
  const effectiveLoc = useMemo(() => locItems.find((l) => l.location_id === effectiveLocId), [locItems, effectiveLocId]);

  // overview: queryKey 통일 — WhDashboard/BranchInventory/KPI 공유. 30 초 (재고 셀 변동 Redis 실시간)
  const ov = useQuery({
    queryKey: ['ov', wh_id, role],
    queryFn: () => fetchOverview(wh_id, role),
    refetchInterval: 30000,
    staleTime: 15000,
  });
  const { flashed, availableOf } = useStockUpdates(role);

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
      m.set(`${f.isbn13}|${f.store_id}`, f.predicted_demand);
    }
    return m;
  }, [fcQ.data?.items]);
  const forecastOf = (isbn: string, locId: number) => forecastMap.get(`${isbn}|${locId}`);

  // 신규 차트 쿼리 (2026-05-13) -----------------------------------------
  // 카테고리별 재고 분포 — 5 분 (전사 응답 · backend wh_id 필터 미지원)
  const invByCat = useQuery({
    queryKey: ['inv-cat-all', role],
    queryFn: () => fetchInventoryByCategory(role),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 2 * 60 * 1000,
  });
  // 7일 입출고 추이 (cascade funnel daily) — 1 분
  const funnel7 = useQuery({
    queryKey: ['funnel-wh-inv', wh_id, role],
    queryFn: () => fetchCascadeFunnel(role, 7),
    refetchInterval: 60000,
    staleTime: 30000,
  });

  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<'available' | 'on_hand' | 'title'>('available');
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [search, sortKey]);

  // v5 2026-05-15 (별도 fetch): viewMode='stores' 면 그 매장 별 inventory 별도 fetch (피드백 follow-up)
  const storeInv = useQuery({
    queryKey: ['store-inv', effectiveLocId, role],
    queryFn: () => fetchInventoryByStore(role, effectiveLocId as number),
    enabled: viewMode === 'stores' && effectiveLocId != null && effectiveLocId !== whLocId,
    staleTime: 15000,
    refetchInterval: 30000,
  });

  // raw: wh body view → ov.data 의 wh body inventory · stores view → storeInv 별도 fetch
  const raw = useMemo(() => {
    if (viewMode === 'stores' && effectiveLocId != null && effectiveLocId !== whLocId) {
      return (storeInv.data?.items ?? []) as any[];
    }
    const items = ov.data?.inventory?.items ?? [];
    return items.filter((it: any) => it.location_id === effectiveLocId);
  }, [ov.data, storeInv.data, viewMode, effectiveLocId, whLocId]);

  const sorted = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? raw.filter((it: any) => (it.title?.toLowerCase() ?? '').includes(q) || (it.author?.toLowerCase() ?? '').includes(q) || it.isbn13.includes(q))
      : raw;
    const arr = [...filtered];
    arr.sort((a: any, b: any) => {
      if (sortKey === 'title') return (a.title ?? '').localeCompare(b.title ?? '');
      if (sortKey === 'on_hand') return b.on_hand - a.on_hand;
      const aAv = availableOf(a.isbn13, whLocId ?? 0) ?? a.available;
      const bAv = availableOf(b.isbn13, whLocId ?? 0) ?? b.available;
      return aAv - bAv;
    });
    return arr;
  }, [raw, search, sortKey, availableOf, whLocId]);

  const total = raw.length;
  const lowStock = raw.filter((it: any) => (availableOf(it.isbn13, whLocId ?? 0) ?? it.available) <= (it.safety_stock ?? 50)).length;
  const zeroStock = raw.filter((it: any) => (availableOf(it.isbn13, whLocId ?? 0) ?? it.available) <= 0).length;
  const totalQty = raw.reduce((s: number, it: any) => s + (it.on_hand ?? 0), 0);

  const pageItems = pageSlice(sorted, page, 20);

  // 안전재고 미달 도서 수 (이미 lowStock 으로 계산. 별도 명칭만)
  const belowSafetyCount = lowStock;

  // 카테고리 분포 pie (재고 수량 합계)
  const catPieChart = useMemo(() => {
    const items = (invByCat.data?.items ?? []) as Array<{ category: string; on_hand: number }>;
    const sorted = [...items].sort((a, b) => b.on_hand - a.on_hand);
    const top = sorted.slice(0, 8).map((c) => ({ name: c.category || '미분류', value: c.on_hand }));
    const rest = sorted.slice(8).reduce((s, c) => s + c.on_hand, 0);
    return rest > 0 ? [...top, { name: '기타', value: rest }] : top;
  }, [invByCat.data?.items]);

  // 7일 입출고 추이 line (APPROVED · EXECUTED)
  const dailyChart = useMemo(() => {
    const daily = funnel7.data?.daily ?? [];
    return daily.map((d: any) => ({
      date: typeof d.date === 'string' ? d.date.slice(5) : d.date,
      입고: d.APPROVED ?? 0,
      출고: d.EXECUTED ?? 0,
    }));
  }, [funnel7.data?.daily]);

  // 출판사별 보유 top 10 (frontend GROUP BY · raw inventory + books JOIN 가정)
  const publisherChart = useMemo(() => {
    const byPub = new Map<string, number>();
    for (const it of raw as any[]) {
      const pub = it.publisher ?? '미상';
      byPub.set(pub, (byPub.get(pub) ?? 0) + (it.on_hand ?? 0));
    }
    return [...byPub.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
  }, [raw]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="h1">{effectiveLoc?.name ?? whLoc?.name ?? `WH-${wh_id}`} · 재고</h1>
        <p className="text-bf-muted text-xs mt-1">
          {viewMode === 'wh'
            ? '거점창고 1,000종 재고 실시간. 온라인 주문도 이 창고에서 출하 (Notion 1.1). 권역 재분배·외부 발주 의사결정에 활용.'
            : '권역 지점별 재고 (selector 로 매장 전환).'}
        </p>
        {/* v5: wh/매장 view 토글 + 매장 selector + (hq) 권역 selector */}
        <div className="flex items-center gap-2 mt-2 p-2 rounded-lg bg-bf-panel/60 border border-bf-border/40 flex-wrap">
          {!isBranchClerk && (
            <>
              <button
                type="button"
                onClick={() => setViewMode('wh')}
                className={`px-3 py-1 text-xs rounded ${viewMode === 'wh' ? 'bg-bf-primary text-white' : 'bg-bf-surface text-bf-muted hover:text-bf-text'}`}
              >🏢 거점창고</button>
              <button
                type="button"
                onClick={() => setViewMode('stores')}
                className={`px-3 py-1 text-xs rounded ${viewMode === 'stores' ? 'bg-bf-primary text-white' : 'bg-bf-surface text-bf-muted hover:text-bf-text'}`}
              >🏪 권역 지점별</button>
            </>
          )}
          {isHq && accessibleWhs.length > 1 && (
            <>
              <span className="text-xs text-bf-muted ml-2">권역:</span>
              <select
                className="ipt text-sm px-2 py-1 rounded bg-bf-panel border border-bf-border"
                value={wh_id}
                onChange={(e) => setSelectedWhId(parseInt(e.target.value, 10))}
              >
                {accessibleWhs.map((l: any) => (
                  <option key={l.wh_id} value={l.wh_id}>{l.name}</option>
                ))}
              </select>
            </>
          )}
          {viewMode === 'stores' && !isBranchClerk && storeLocsInScope.length > 0 && (
            <>
              <span className="text-xs text-bf-muted ml-2">매장:</span>
              <select
                className="ipt text-sm px-2 py-1 rounded bg-bf-panel border border-bf-border"
                value={selectedStoreLocId ?? storeLocsInScope[0]?.location_id ?? ''}
                onChange={(e) => setSelectedStoreLocId(parseInt(e.target.value, 10))}
              >
                {storeLocsInScope.map((l: any) => (
                  <option key={l.location_id} value={l.location_id}>{l.name}</option>
                ))}
              </select>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="metric-card"><div className="metric-label">SKU 수</div><div className="metric-value">{total.toLocaleString()}</div></div>
        <div className="metric-card"><div className="metric-label">총 보유 수량</div><div className="metric-value">{totalQty.toLocaleString()}</div></div>
        <div className="metric-card"><div className="metric-label">부족 SKU (≤ 안전재고)</div><div className="metric-value text-orange-600">{lowStock}</div></div>
        <div className="metric-card"><div className="metric-label">결품 SKU (0권)</div><div className="metric-value text-red-600">{zeroStock}</div></div>
        <div className="metric-card"><div className="metric-label">안전재고 미달 도서</div><div className="metric-value text-orange-600">{belowSafetyCount}</div></div>
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-3 gap-2">
          <h2 className="h2">거점창고 도서 (책 단위 · 실시간)</h2>
          <div className="flex gap-2 items-center">
            <input className="ipt text-xs w-48" placeholder="제목/저자/ISBN 검색" value={search} onChange={(e) => setSearch(e.target.value)} />
            <select className="ipt text-xs" value={sortKey} onChange={(e) => setSortKey(e.target.value as any)} title="정렬 기준">
              <option value="available">가용 적은 순</option>
              <option value="on_hand">보유량 많은 순</option>
              <option value="title">제목 순</option>
            </select>
          </div>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>표지</th>
              <th>제목 / 저자</th>
              <th className="text-right">보유</th>
              <th className="text-right">예약</th>
              <th className="text-right">가용</th>
              <th className="text-right">안전재고</th>
              <th className="text-right" title="forecast-svc D+1 권역 예측 수요 (권/일)">
                AI 수요예측<br/>
                <span className="text-[10px] font-normal text-bf-muted">D+1 권/일</span>
              </th>
              <th>상태</th>
            </tr>
          </thead>
          <tbody>
            {pageItems.map((it: any) => {
              const av = availableOf(it.isbn13, whLocId ?? 0) ?? it.available;
              const safety = it.safety_stock ?? 50;
              const tone = av === 0 ? { c: 'text-red-600 font-bold', label: '결품' }
                : av <= safety ? { c: 'text-orange-600 font-bold', label: '부족' }
                : av <= safety * 2 ? { c: 'text-yellow-700', label: '주의' }
                : { c: 'text-green-700', label: '정상' };
              return (
                <tr key={it.isbn13} className={flashed(it.isbn13, whLocId ?? 0) ? 'animate-flash' : ''}>
                  <td>{it.cover_url ? <img src={it.cover_url} alt="" className="w-8 h-12 object-cover rounded-sm" /> : '-'}</td>
                  <td>
                    <div className="text-xs font-medium">{it.title ?? it.isbn13}</div>
                    <div className="font-mono text-[10px] text-bf-muted">{it.author ?? ''} · {it.isbn13}</div>
                  </td>
                  <td className="text-right font-mono">{it.on_hand}</td>
                  <td className="text-right font-mono text-bf-muted">{it.reserved_qty}</td>
                  <td className={`text-right font-mono ${tone.c}`}>{av}</td>
                  <td className="text-right font-mono text-bf-muted">{safety}</td>
                  <td className="text-right">
                    {(() => {
                      const pred = whLocId != null ? forecastOf(it.isbn13, whLocId) : undefined;
                      if (pred == null) return <span className="text-bf-muted">-</span>;
                      const safety5 = Math.round(pred * 5);
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
                  <td><span className={`text-[10px] px-1.5 py-0.5 rounded ${tone.c}`}>{tone.label}</span></td>
                </tr>
              );
            })}
            {pageItems.length === 0 && (
              <tr><td colSpan={8} className="text-center py-6 text-bf-muted">{search ? '검색 결과 없음' : '재고 데이터 없음'}</td></tr>
            )}
          </tbody>
        </table>
        <Pagination total={sorted.length} pageSize={20} page={page} onChange={setPage} />
      </div>

      {/* 페이지 하단 신규 BI 차트 (2026-05-13) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="card">
          <h3 className="h3 mb-2">카테고리 재고 분포 (전사 집계)</h3>
          <KpiPie data={catPieChart} height={300} isLoading={invByCat.isLoading} />
        </div>
        <div className="card">
          <h3 className="h3 mb-2">7일 입출고 추이</h3>
          <KpiLine
            data={dailyChart}
            xKey="date"
            yKey={['입고', '출고']}
            yLabels={['입고 (승인)', '출고 (실행)']}
            height={300}
            smooth
            isLoading={funnel7.isLoading}
          />
        </div>
      </div>
      <div className="card">
        <h3 className="h3 mb-2">출판사별 보유 top 10 (거점창고)</h3>
        <KpiBar
          data={publisherChart}
          horizontal
          height={320}
          isLoading={ov.isLoading}
        />
      </div>
    </div>
  );
}
