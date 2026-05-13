// Same-origin (FastAPI serves SPA + API + WS).
import { getAuthMode, token, type Role } from './auth';

export type { Role } from './auth';

// D5-3 P1-6 ErrorResponse 표준 (intervention-svc pilot · main.py)
export type ApiErrorBody = {
  error_code: string;
  message: string;
  details?: Record<string, unknown> | null;
  request_id?: string | null;
};

export class ApiError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown> | null;
  requestId?: string | null;
  constructor(status: number, body: ApiErrorBody | string) {
    if (typeof body === 'string') {
      super(body);
      this.status = status;
      this.code = `HTTP_${status}`;
    } else {
      super(body.message || `${status} error`);
      this.status = status;
      this.code = body.error_code;
      this.details = body.details ?? null;
      this.requestId = body.request_id ?? null;
    }
  }
}

async function _throwApiError(r: Response): Promise<never> {
  const text = await r.text().catch(() => '');
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object' && typeof j.error_code === 'string' && typeof j.message === 'string') {
      throw new ApiError(r.status, j as ApiErrorBody);
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    // JSON parse 실패 — fallthrough
  }
  throw new ApiError(r.status, text || `${r.status} ${r.statusText}`);
}

// Entra 모드: Authorization 헤더 생략 + credentials:'include' (httpOnly cookie 만)
// mock 모드: Authorization: Bearer mock-token-{role}
function _authInit(role: Role, body?: unknown, method?: string): RequestInit {
  const mode = getAuthMode();
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (mode === 'mock') headers.Authorization = token(role);
  const init: RequestInit = {
    method,
    headers,
    credentials: 'include',  // Entra cookie 필요 시 자동 첨부
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return init;
}

async function getJson<T>(path: string, role: Role): Promise<T> {
  const r = await fetch(path, _authInit(role));
  if (!r.ok) await _throwApiError(r);
  return r.json();
}

async function postJson<T>(path: string, role: Role, body: unknown): Promise<T> {
  const r = await fetch(path, _authInit(role, body, 'POST'));
  if (!r.ok) await _throwApiError(r);
  return r.json();
}

async function patchJson<T>(path: string, role: Role, body: unknown): Promise<T> {
  const r = await fetch(path, _authInit(role, body, 'PATCH'));
  if (!r.ok) await _throwApiError(r);
  return r.json();
}

// D5-7 WH AI 추천 수정 (qty / target_location_id)
export function patchPendingOrder(role: Role, order_id: string, body: { qty?: number; target_location_id?: number; note?: string }) {
  return patchJson<{ order_id: string; qty: number; target_location_id: number; edited_at: string; edited_by: string }>(
    `/dashboard/pending-orders/${order_id}`, role, body,
  );
}

// D5-8 Branch 의견 제출 (Notion 3.5)
export function postBranchFeedback(role: Role, body: { feedback_type: 'SLOW_SELLER' | 'STOCK_REQUEST' | 'OTHER'; isbn13?: string; message: string }) {
  return postJson<{ notification_id: string; feedback_type: string; submitted_at: string }>(
    '/dashboard/branch-feedback', role, body,
  );
}

// ─── Overview / fan-in ──────────────────────────────────────────────
export type Overview = {
  wh_id: number;
  inventory: { items: { isbn13: string; on_hand: number; reserved_qty: number; available: number }[] } | null;
  forecast: { items: unknown[] } | null;
  pending_orders: { items: PendingOrder[] } | null;
  interventions: { items: unknown[] } | null;
  notifications: { items: unknown[] } | null;
  _partial_failures: string[];
};

// ─── Pending orders (decision-svc) ──────────────────────────────────
export type PendingOrder = {
  order_id: string;
  order_type: string;
  isbn13: string;
  source_location_id: number | null;
  target_location_id: number | null;
  qty: number;
  urgency_level: string;
  auto_execute_eligible: boolean;
  status: string;
  created_at: string;
  // decision-svc 가 채운 의사결정 근거 (Stage 1 effective / Stage 2 partner_surplus / Stage 3 EOQ).
  // intervention-svc /queue 에서 반환 (UX-4 / FR-A5.6).
  forecast_rationale?: Record<string, unknown> | null;
  // P3-1 ISBN → 제목 우선 표시 (intervention-svc 가 LEFT JOIN books 로 채움)
  title?: string | null;
  // include_history=true 응답에서 채워짐 (PENDING 모드는 null)
  approved_at?: string | null;
  executed_at?: string | null;
};

export const fetchOverview = (whId: number, role: Role) =>
  getJson<Overview>(`/dashboard/overview/${whId}`, role);

export const fetchPending = (
  role: Role,
  opts: {
    limit?: number;
    offset?: number;
    order_type?: 'REBALANCE' | 'WH_TRANSFER' | 'PUBLISHER_ORDER';
    wh_id?: number;
    /** 특정 일자 (YYYY-MM-DD KST) detail · lazy fetch. summary count 와 함께 사용 권장. */
    date?: string;
    /** @deprecated 365일치 통째 fetch — 사용 자제. summary + date 조합 권장. */
    include_history?: boolean;
    days?: number;
  } = {},
) => {
  const qs = new URLSearchParams();
  qs.set('limit', String(opts.limit ?? 200));
  if (opts.offset) qs.set('offset', String(opts.offset));
  if (opts.order_type) qs.set('order_type', opts.order_type);
  if (opts.wh_id !== undefined) qs.set('wh_id', String(opts.wh_id));
  if (opts.date) {
    qs.set('date', opts.date);
  } else if (opts.include_history) {
    qs.set('include_history', 'true');
    qs.set('days', String(opts.days ?? 7));
  }
  return getJson<{
    items: PendingOrder[];
    total?: number;
    stage_counts?: Record<string, number>;
  }>(`/dashboard/pending?${qs.toString()}`, role);
};

// 일자별 status count summary — 가벼운 응답. DateHistoryTabs pill row 카운트.
export type PendingSummary = {
  days: number;
  items: Array<{
    date: string;
    PENDING: number;
    APPROVED: number;
    EXECUTED: number;
    REJECTED: number;
    AUTO_EXECUTED: number;
    total: number;
  }>;
};

export const fetchPendingSummary = (
  role: Role,
  opts: {
    days?: number;
    order_type?: 'REBALANCE' | 'WH_TRANSFER' | 'PUBLISHER_ORDER';
    wh_id?: number;
  } = {},
) => {
  const qs = new URLSearchParams();
  qs.set('days', String(opts.days ?? 365));
  if (opts.order_type) qs.set('order_type', opts.order_type);
  if (opts.wh_id !== undefined) qs.set('wh_id', String(opts.wh_id));
  return getJson<PendingSummary>(`/dashboard/pending/summary?${qs.toString()}`, role);
};

// D2 Home 메인 카드 — batch 처리 현황 + 검토 필요 건수
export type PendingGrouped = {
  date: string;
  auto_executed_at_07: number;       // 오늘 07:00 batch 자동 승인
  manual_review: number;             // 사용자가 처리할 PENDING (시점 무관 · scope)
  auto_reject_at_18_pending: number; // 18:00 batch 거절 예정 (NORMAL · D-1 이전)
  by_type: Record<string, number>;   // 'REBALANCE' | 'WH_TRANSFER' | 'PUBLISHER_ORDER' → count
  items: PendingOrder[];             // 사용자 직접 처리할 list (urgency desc + created asc)
};
export const fetchPendingGrouped = (role: Role, date?: string) => {
  const qs = date ? `?date=${date}` : '';
  return getJson<PendingGrouped>(`/dashboard/pending/grouped${qs}`, role);
};

// ─── Recent POS sales (direct RDS) ──────────────────────────────────
export type SaleRow = {
  txn_id: string;
  event_ts: string;
  isbn13: string;
  store_id: number;
  channel: string;
  qty: number;
  revenue: number;
};
export const fetchRecentSales = (role: Role, limit = 20) =>
  getJson<{ items: SaleRow[] }>(`/dashboard/recent-sales?limit=${limit}`, role);

export type SalesSummary = {
  window: string;
  transactions: number;
  total_revenue: number;
  online_count: number;
  offline_count: number;
};
export const fetchSalesSummary = (role: Role) =>
  getJson<SalesSummary>('/dashboard/sales-summary', role);

export type StoreSales = { store_id: number; transactions: number; revenue: number; online_count: number };
export const fetchSalesByStore = (role: Role) =>
  getJson<{ items: StoreSales[] }>('/dashboard/sales-by-store', role);

// ─── Books catalog ──────────────────────────────────────────────────
export type BookStatusFilter = 'ACTIVE' | 'SOFT_DC' | 'INACTIVE' | 'ALL';
export type BookStatusMode = 'NORMAL' | 'SOFT_DISCONTINUE' | 'INACTIVE';

export type Book = {
  isbn13: string;
  title: string;
  author: string | null;
  publisher: string | null;
  pub_date: string | null;
  category: string | null;
  price_standard: number | null;
  price_sales: number | null;
  active: boolean;
  discontinue_mode: string | null;
  discontinue_reason: string | null;
  discontinue_at: string | null;
  expected_soldout_at: string | null;
  cover_url: string | null;
};
export const fetchBooks = (
  role: Role,
  params: { limit?: number; offset?: number; q?: string; status?: BookStatusFilter; category?: string } = {},
) => {
  const qs = new URLSearchParams();
  if (params.limit !== undefined)  qs.set('limit',  String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  if (params.q)                    qs.set('q',      params.q);
  if (params.status)               qs.set('status', params.status);
  if (params.category)             qs.set('category', params.category);
  return getJson<{ total: number; limit: number; offset: number; items: Book[] }>(
    `/dashboard/books?${qs.toString()}`, role,
  );
};

export type BookCategory = { category: string; count: number };
export const fetchBookCategories = (role: Role) =>
  getJson<{ items: BookCategory[] }>('/dashboard/books/categories', role);

export type BookAuditEntry = {
  log_id: number;
  ts: string;
  actor_id: string | null;
  action: string;
  after_state: Record<string, unknown> | null;
};
export const fetchBookAudit = (role: Role, isbn13: string) =>
  getJson<{ isbn13: string; items: BookAuditEntry[] }>(`/dashboard/books/${isbn13}/audit`, role);

export const updateBookStatus = (
  role: Role,
  isbn13: string,
  body: { mode: BookStatusMode; reason?: string },
) =>
  postJson<{ isbn13: string; active: boolean; discontinue_mode: string; mode: BookStatusMode }>(
    `/dashboard/books/${isbn13}/status`, role, body,
  );

// ─── Spike events ───────────────────────────────────────────────────
export type SpikeEvent = {
  event_id: string;
  detected_at: string;
  isbn13: string;
  z_score: number | null;
  mentions_count: number;
  title: string | null;
  author: string | null;
  category: string | null;
};
export const fetchSpikeEvents = (role: Role, limit = 20) =>
  getJson<{ items: SpikeEvent[] }>(`/dashboard/spike-events?limit=${limit}`, role);

// ─── Returns ────────────────────────────────────────────────────────
export type ReturnRow = {
  return_id: string;
  isbn13: string;
  location_id: number;
  qty: number;
  reason: string;
  status: string;
  requested_at: string;
  hq_approved_at: string | null;
  executed_at: string | null;
  title: string | null;
  author: string | null;
};
export const fetchReturns = (role: Role, limit = 50) =>
  getJson<{ items: ReturnRow[] }>(`/dashboard/returns?limit=${limit}`, role);

// ─── New book requests ──────────────────────────────────────────────
export type NewBookRequest = {
  id: number;
  isbn13: string;
  publisher_id: number;
  title: string | null;
  status: string;
  requested_at: string;
};
export const fetchNewBookRequests = (role: Role, limit = 50) =>
  getJson<{ items: NewBookRequest[] }>(`/dashboard/new-book-requests?limit=${limit}`, role);

// ─── Inventory heatmap (HQ Inventory) ──────────────────────────────
export type LocationCell = {
  location_id: number;
  name: string;
  location_type: string | null;
  region: string | null;
  wh_id: number | null;
  sku_count: number;
  total_qty: number;
  reserved_qty: number;
  low_count: number;
  zero_count: number;
};
export const fetchInventoryHeatmap = (role: Role) =>
  getJson<{ items: LocationCell[] }>('/dashboard/locations/heatmap', role);

// ─── Inventory by store (Branch Inventory) ──────────────────────────
export type StoreInventoryRow = {
  isbn13: string;
  on_hand: number;
  reserved_qty: number;
  available: number;
  safety_stock: number;
  updated_at: string | null;
  title: string | null;
  author: string | null;
  category: string | null;
  price_sales: number | null;
};
export const fetchInventoryByStore = (role: Role, store_id: number) =>
  getJson<{ store_id: number; items: StoreInventoryRow[] }>(
    `/dashboard/store-inventory/${store_id}`, role,
  );

// ─── Sales by specific store (Branch Sales) ─────────────────────────
export type StoreSaleRow = {
  txn_id: string;
  event_ts: string;
  isbn13: string;
  channel: string;
  qty: number;
  unit_price: number;
  revenue: number;
  title: string | null;
  author: string | null;
};
export const fetchSalesBySpecificStore = (role: Role, store_id: number, limit = 50) =>
  getJson<{ store_id: number; items: StoreSaleRow[] }>(
    `/dashboard/sales-by-store/${store_id}?limit=${limit}`, role,
  );

// ─── Instructions (WH Instructions / Branch Inbound) ────────────────
export type Instruction = {
  order_id: string;
  order_type: string;
  isbn13: string;
  source_location_id: number | null;
  target_location_id: number | null;
  qty: number;
  urgency_level: string;
  status: string;
  approved_at: string | null;
  title: string | null;
};
export const fetchInstructions = (role: Role, wh_id?: number) => {
  const qs = wh_id !== undefined ? `?wh_id=${wh_id}` : '';
  return getJson<{ items: Instruction[] }>(`/dashboard/instructions${qs}`, role);
};

// ─── Curation (Branch Curation) ─────────────────────────────────────
export type CurationItem = {
  isbn13: string;
  z_score: number | null;
  mentions_count: number;
  detected_at: string;
  title: string | null;
  author: string | null;
  category: string | null;
  price_sales: number | null;
  cover_url: string | null;
  on_hand: number;
  available: number;
};
export const fetchCuration = (role: Role, store_id: number) =>
  getJson<{ store_id: number; items: CurationItem[] }>(`/dashboard/curation/${store_id}`, role);

// ─── Notifications ──────────────────────────────────────────────────
export type Notification = {
  notification_id: string;
  event_type: string;
  severity: string | null;
  status: string;
  channels: string | null;
  payload_summary: unknown;
  sent_at: string;
};
export const fetchNotifications = (role: Role, limit = 50) =>
  getJson<{ items: Notification[] }>(`/dashboard/notifications?limit=${limit}`, role);

// ─── Mutations ──────────────────────────────────────────────────────
export const postIntervene = (role: Role, action: 'approve' | 'reject', body: unknown) =>
  postJson<{ approval_id?: string; order_id?: string; decision?: string; detail?: string }>(
    `/dashboard/intervene/${action}`, role, body,
  );

// 일괄 승인/거절 (시연 일괄 처리) — frontend N 회 → backend 1 회
export type InterveneBatchItem = { order_id: string; approval_side?: string; reject_reason?: string };
export type InterveneBatchResult = { total: number; ok: number; failed: number; errors: string[] };
export const postIntervenebatch = (role: Role, action: 'approve' | 'reject', items: InterveneBatchItem[]) =>
  postJson<InterveneBatchResult>('/dashboard/intervene/batch', role, { action, items });

export type DecideResult = {
  order_id: string;
  order_type: 'REBALANCE' | 'WH_TRANSFER' | 'PUBLISHER_ORDER';
  stage: 1 | 2 | 3;
  source_location_id: number | null;
  target_location_id: number;
  qty: number;
  urgency_level: string;
  auto_execute_eligible: boolean;
  status: string;
  rationale: Record<string, unknown>;
  created_at: string;
};
export const postDecide = (role: Role, body: { isbn13: string; target_location_id: number; qty: number; note?: string }) =>
  postJson<DecideResult>('/dashboard/decide', role, body);

// 일괄 cascade (시연 + 매일 03:30 batch) — N items 한 번에 backend 처리
export type CascadeBatchResult = {
  total: number;
  s1: number;
  s2: number;
  s3: number;
  failed: number;
  errors: string[];
};
export type CascadeBatchItem = { isbn13: string; target_location_id: number; qty: number; note?: string };
export const postCascadeBatch = (role: Role, items: CascadeBatchItem[]) =>
  postJson<CascadeBatchResult>('/dashboard/cascade/run-batch', role, { items });

// D+1 익일 plan 발의 — forecast_cache 기반 전 isbn × 전 location 동시 plan
// 정식 source: BQ 결과 테이블 → forecast_cache sync (GCP 준비 후) · 현재 RDS 직읽음
export type PlanDailyResult = {
  snapshot_date: string;
  rows_created: number;
  by_stage: Record<string, number>;
  isbns_planned: number;
};
export const postPlanDaily = (role: Role, snapshot_date?: string) =>
  postJson<PlanDailyResult>('/dashboard/cascade/plan-daily', role, snapshot_date ? { snapshot_date } : {});

// 일괄 입고 수령 (BranchInbound 전체 수령/발송)
export type InboundBatchResult = { total: number; ok: number; failed: number; errors: string[] };
export const postInboundBatchReceive = (role: Role, order_ids: string[]) =>
  postJson<InboundBatchResult>('/dashboard/inbound/batch-receive', role, { order_ids });

// 오늘 PENDING 전체 일괄 승인 — 서버측 fetch + bulk (페이지네이션 우회)
export type ApproveAllResult = {
  total_orders: number;
  ok: number;
  failed: number;
  errors: string[];
};
export const postApproveAllToday = (
  role: Role,
  order_type?: 'REBALANCE' | 'WH_TRANSFER' | 'PUBLISHER_ORDER',
) => postJson<ApproveAllResult>('/dashboard/intervene/approve-all-today', role, order_type ? { order_type } : {});

// UX-6: 재고 수동 조정 (Manual 페이지) — inventory-svc /adjust 프록시.
export type InventoryAdjustResult = {
  isbn13: string;
  location_id: number;
  on_hand_before: number;
  on_hand_after: number;
  detail?: string;
};
export const postInventoryAdjust = (
  role: Role,
  body: { isbn13: string; location_id: number; delta: number; reason: string },
) => postJson<InventoryAdjustResult>('/dashboard/inventory/adjust', role, body);

// UX-9: location 마스터 — 모든 페이지에서 ID → 이름 변환에 사용.
export type LocationItem = {
  location_id: number;
  name: string | null;
  location_type: string | null;
  wh_id: number | null;
  region: string | null;
  is_virtual?: boolean;
  active?: boolean;
};
export const fetchLocations = (role: Role) =>
  getJson<{ items: LocationItem[] }>('/dashboard/locations', role);

// UX-6: 매장 입고 수령 — intervention-svc /inbound/{order_id}/receive 프록시.
export type InboundReceiveResult = {
  order_id: string;
  status: string;
  isbn13?: string;
  qty?: number;
  inventory_adjust?: 'ADJUSTED' | 'PENDING_ADJUST';
  detail?: string;
};
export const postInboundReceive = (role: Role, order_id: string) =>
  postJson<InboundReceiveResult>(`/dashboard/inbound/${order_id}/receive`, role, {});

// P1-2 매장 입고 거부 — reject_reason 필수 (수량 불일치/파손/누락 등)
export const postInboundReject = (role: Role, order_id: string, reject_reason: string) =>
  postJson<{ order_id: string; status: string; isbn13: string; qty: number; reject_reason: string }>(
    `/dashboard/inbound/${order_id}/reject`, role, { reject_reason },
  );

// P1-3 Branch 반품 신청 — branch-clerk only (scope_store_id == location_id)
export const postReturnsRequest = (
  role: Role,
  body: { isbn13: string; location_id: number; qty: number; reason: string },
) =>
  postJson<{
    return_id: string; isbn13: string; location_id: number; qty: number;
    reason: string; status: string; requested_at: string;
  }>('/dashboard/returns/request', role, body);

export const postReturnsApprove = (role: Role, body: { return_id: string; note?: string }) =>
  postJson<{ return_id: string; status: string; hq_approved_at: string }>('/dashboard/returns/approve', role, body);

// A4 (FR-A6.8) 본사 마스터 반품 거부 · reject_reason 필수
export const postReturnsReject = (role: Role, body: { return_id: string; reject_reason: string }) =>
  postJson<{ return_id: string; status: string; rejected_at: string; reject_reason: string }>(
    '/dashboard/returns/reject',
    role,
    body,
  );

// UX-2 신간 편입 결정 (.pen HQ Requests 우측 패널)
export type NewBookForecastHint = {
  request_id: number;
  default_qty: number;
  wh1_qty: number;
  wh2_qty: number;
  wh1_pct: number;
  wh2_pct: number;
  source: 'category' | 'fallback';
  raw_counts: { wh_id: number; n: number }[];
};
export const fetchNewBookForecastHint = (role: Role, request_id: number, defaultQty = 100) =>
  getJson<NewBookForecastHint>(
    `/dashboard/new-book-requests/${request_id}/forecast-hint?default_qty=${defaultQty}`,
    role,
  );

export type NewBookApproveResp = {
  id: number;
  status: string;
  isbn13: string;
  wh1_qty: number;
  wh2_qty: number;
  orders: { order_id: string; wh_id: number; qty: number }[];
};
export const postNewBookApprove = (
  role: Role,
  request_id: number,
  body: { wh1_qty: number; wh2_qty: number },
) =>
  postJson<NewBookApproveResp>(`/dashboard/new-book-requests/${request_id}/approve`, role, body);

export const postNewBookReject = (
  role: Role,
  request_id: number,
  body: { reason?: string } = {},
) =>
  postJson<{ id: number; status: string; isbn13: string }>(
    `/dashboard/new-book-requests/${request_id}/reject`,
    role,
    body,
  );

export const postNotifySend = (role: Role, body: unknown) =>
  postJson<{ notification_id: string; status: string; sent_at: string }>('/dashboard/notify/send', role, body);

// P1-4b 시연 trigger: 예측 수요 > 가용 재고 인 도서 list (HQ 만 호출)
export type InsufficientStockItem = {
  isbn13: string;
  title: string | null;
  store_id: number;
  predicted_demand: number;
  safety_stock_5days: number;
  available: number;
  gap: number;
  suggested_qty: number;
  recommend_target_location_id: number;  // 신규 · WH location (출판사 → WH → 매장 분배)
};
export const fetchInsufficientStock = (role: Role, limit = 20) =>
  getJson<{ snapshot_date: string; items: InsufficientStockItem[] }>(
    `/dashboard/forecast/insufficient?limit=${limit}`, role,
  );

// ─── KPI by category / Bestsellers / Hourly / Cascade funnel ────────
export type CategorySales = { category: string; revenue: number; qty: number; tx_count: number };
export const fetchKpiByCategory = (role: Role, days = 30, store_id?: number) =>
  getJson<{ days: number; items: CategorySales[] }>(
    `/dashboard/kpi/by-category?days=${days}${store_id ? `&store_id=${store_id}` : ''}`,
    role,
  );

export type Bestseller = {
  isbn13: string;
  title: string | null;
  author: string | null;
  qty: number;
  revenue: number;
  tx_count: number;
};
export const fetchBestsellers = (role: Role, days = 7, limit = 20, store_id?: number) =>
  getJson<{ days: number; items: Bestseller[] }>(
    `/dashboard/sales/bestsellers?days=${days}&limit=${limit}${store_id ? `&store_id=${store_id}` : ''}`,
    role,
  );

export type HourlySales = { hour: number; qty: number; revenue: number; tx_count: number };
export const fetchHourlySales = (role: Role, store_id: number, date?: string) =>
  getJson<{ date: string; store_id: number; items: HourlySales[] }>(
    `/dashboard/sales/hourly?store_id=${store_id}${date ? `&date=${date}` : ''}`,
    role,
  );

export type CascadeFunnel = {
  days: number;
  summary: Record<string, number>;
  by_stage: Record<string, Record<string, number>>;
  daily: Array<{ date: string } & Record<string, number>>;
};
export const fetchCascadeFunnel = (role: Role, days = 7) =>
  getJson<CascadeFunnel>(`/dashboard/cascade/funnel?days=${days}`, role);

// 전 매장 × 전 ISBN forecast batch (inventory 페이지 AI 수요예측 컬럼용).
// snapshot_date 생략 시 backend D+1 KST 자동 계산.
export type ForecastBatchItem = {
  snapshot_date: string;
  isbn13: string;
  store_id: number;
  predicted_demand: number;
};
export const fetchAllForecast = (role: Role, snapshot_date?: string) => {
  const qs = snapshot_date ? `?snapshot_date=${snapshot_date}` : '';
  return getJson<{ snapshot_date: string; items: ForecastBatchItem[] }>(
    `/dashboard/forecast/all${qs}`, role,
  );
};

// ─── Extended sales / inventory / forecast analytics (10 endpoints) ────
const _storeQS = (store_id?: number) => (store_id !== undefined ? `&store_id=${store_id}` : '');

export type WeekdaySales = { dow: number; dow_label: string; revenue: number; qty: number; tx_count: number };
export const fetchSalesByWeekday = (role: Role, days = 30, store_id?: number) =>
  getJson<{ days: number; items: WeekdaySales[] }>(
    `/dashboard/sales/by-weekday?days=${days}${_storeQS(store_id)}`, role,
  );

export type HourAvgSales = { hour: number; avg_revenue: number; avg_qty: number; avg_tx_count: number };
export const fetchSalesByHourAvg = (role: Role, days = 30, store_id?: number) =>
  getJson<{ days: number; items: HourAvgSales[] }>(
    `/dashboard/sales/by-hour-avg?days=${days}${_storeQS(store_id)}`, role,
  );

export type PaymentSales = { payment: string; revenue: number; count: number };
export const fetchSalesByPayment = (role: Role, days = 30, store_id?: number) =>
  getJson<{ days: number; items: PaymentSales[] }>(
    `/dashboard/sales/by-payment?days=${days}${_storeQS(store_id)}`, role,
  );

export type ASPTrend = { date: string; asp: number; revenue: number; tx_count: number };
export const fetchSalesAsp = (role: Role, days = 30, store_id?: number) =>
  getJson<{ days: number; items: ASPTrend[] }>(
    `/dashboard/sales/asp?days=${days}${_storeQS(store_id)}`, role,
  );

export type DailySales = { date: string; revenue: number; qty: number };
export const fetchSales30Days = (role: Role, store_id?: number) =>
  getJson<{ items: DailySales[] }>(
    `/dashboard/sales/30days${store_id !== undefined ? `?store_id=${store_id}` : ''}`, role,
  );

export type TurnoverItem = { wh_id: number; turnover: number; total_sales: number; avg_inventory: number };
export const fetchInventoryTurnover = (role: Role, days = 7) =>
  getJson<{ days: number; items: TurnoverItem[] }>(
    `/dashboard/inventory/turnover?days=${days}`, role,
  );

export type InsufficientTrendItem = { date: string; insufficient_count: number };
export const fetchInsufficientTrend = (role: Role, days = 30) =>
  getJson<{ days: number; items: InsufficientTrendItem[]; note?: string }>(
    `/dashboard/inventory/insufficient-trend?days=${days}`, role,
  );

export type InventoryByCategory = { category: string; on_hand: number; available: number };
export const fetchInventoryByCategory = (role: Role) =>
  getJson<{ items: InventoryByCategory[] }>(`/dashboard/inventory/by-category`, role);

export type CategoryTrendItem = { date: string; category: string; revenue: number };
export const fetchCategoryTrend = (role: Role, days = 30) =>
  getJson<{ days: number; categories: string[]; items: CategoryTrendItem[] }>(
    `/dashboard/sales/category-trend?days=${days}`, role,
  );

export type ForecastAccuracyItem = {
  date: string; mae: number; mape: number; total_predicted: number; total_actual: number;
};
export const fetchForecastAccuracy = (role: Role, days = 7) =>
  getJson<{ days: number; items: ForecastAccuracyItem[]; note?: string }>(
    `/dashboard/forecast/accuracy?days=${days}`, role,
  );
