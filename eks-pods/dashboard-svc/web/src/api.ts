// Same-origin (FastAPI serves SPA + API + WS).
import { token, type Role } from './auth';

export type { Role } from './auth';

async function getJson<T>(path: string, role: Role): Promise<T> {
  const r = await fetch(path, { headers: { Authorization: token(role) } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

async function postJson<T>(path: string, role: Role, body: unknown): Promise<T> {
  const r = await fetch(path, {
    method: 'POST',
    headers: { Authorization: token(role), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`${r.status} ${r.statusText}: ${text}`);
  }
  return r.json();
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
};

export const fetchOverview = (whId: number, role: Role) =>
  getJson<Overview>(`/dashboard/overview/${whId}`, role);

export const fetchPending = (
  role: Role,
  opts: { limit?: number; order_type?: 'REBALANCE' | 'WH_TRANSFER' | 'PUBLISHER_ORDER'; wh_id?: number } = {},
) => {
  const qs = new URLSearchParams();
  qs.set('limit', String(opts.limit ?? 100));
  if (opts.order_type) qs.set('order_type', opts.order_type);
  if (opts.wh_id !== undefined) qs.set('wh_id', String(opts.wh_id));
  return getJson<{ items: PendingOrder[] }>(`/dashboard/pending?${qs.toString()}`, role);
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
  available: number;
  gap: number;
  suggested_qty: number;
};
export const fetchInsufficientStock = (role: Role, limit = 20) =>
  getJson<{ snapshot_date: string; items: InsufficientStockItem[] }>(
    `/dashboard/forecast/insufficient?limit=${limit}`, role,
  );
