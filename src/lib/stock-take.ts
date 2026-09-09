// Stock Take — typed client for the read-only latest-stock view.
//
// The rows come from `new_stock_entries` — the canonical copy of the
// `stocktake_entries` that the separate Stock Take app (Stock_Take/backend_st)
// writes into the same RDS warehouse_db that server_replica reads. This console
// is a reader: there is no create/update path here, and counting stays in that app.
//
// WHY THAT MATTERS TO THIS FILE: floor names arrive canonicalised. The floor app
// records free text, so the same floor reached the browser as "1 ST FLOOR ",
// "1ST FLOOR" and "FIRST FLOOR"; here it is the single "First Floor" that
// FLOORS_BY_WAREHOUSE (admin-api.ts) declares. Filter values are still compared
// case- and whitespace-insensitively server-side, so a stale value keeps working.
//
// Every call goes through apiFetch so it picks up the bearer token and the
// silent-refresh retry.

import { apiFetch, readApiErrorMessage } from "./auth";

const BASE = "/api/v1/stock-take";

export interface StockTakeItem {
  item_name: string;
  item_type: string | null;
  item_category: string | null;
  item_subcategory: string | null;
  /** "Fresh Stock" or "Off Grade/Rejection" — never summed together. */
  stock_type: string;
  /** NETTED: counted at the last count, plus adjustments posted since. */
  total_quantity: number;
  total_weight: number;
  /** The counted half on its own, so the derived figure is never the only one shown. */
  counted_weight: number;
  net_adjustment_kg: number;
  net_adjustment_units: number;
  /** How many raw count rows folded into this item. 0 = adjusted but never counted. */
  entry_count: number;
  /**
   * The day THIS article was last physically counted (YYYY-MM-DD), or null if it
   * has only ever been adjusted. Rows on one page come from many different days,
   * so a weight is not interpretable without it.
   */
  last_counted_date: string | null;
  /** Age of that count in days, measured against the day being viewed. */
  days_since_count: number | null;
  transaction_count: number;
  warehouse_count: number;
  floor_count: number;
}

export interface StockTakeTotals {
  items: number;
  entries: number;
  transactions: number;
  total_quantity: number;
  total_weight: number;
  counted_weight: number;
  net_adjustment_kg: number;
  /**
   * The span of count dates this page represents, and how much of it is old.
   * A single total that mixes a count from today with one from eight months ago
   * looks equally authoritative either way, so the span travels with it.
   */
  oldest_counted_date: string | null;
  newest_counted_date: string | null;
  /** Articles whose last count is more than 30 days old. */
  stale_items: number;
  /** Articles that have only ever been adjusted, never counted. */
  never_counted_items: number;
}

export interface LatestStockResponse {
  /** YYYY-MM-DD, or null when no row matches the filters. */
  as_of_date: string | null;
  items: StockTakeItem[];
  totals: StockTakeTotals;
  pagination: { page: number; page_size: number; total: number; total_pages: number };
  sort: { sort_by: string; sort_order: string };
  filters: Record<string, unknown>;
}

export interface StockTakeFilterOptions {
  warehouses: string[];
  floors: string[];
  item_types: string[];
  stock_types: string[];
}

export interface LatestStockQuery {
  warehouse?: string[];
  floorName?: string[];
  itemType?: string[];
  category?: string[];
  subcategory?: string[];
  stockType?: string[];
  enteredBy?: string;
  search?: string;
  verified?: boolean;
  includeDrafts?: boolean;
  /** Latest count on or before this day, YYYY-MM-DD. */
  asOf?: string;
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
}

/** Multi-value params are repeated (`?warehouse=A&warehouse=B`), which is what
 *  FastAPI's `list[str]` Query binding expects — a comma-joined single value
 *  would arrive as one string containing a comma. */
function buildParams(q: LatestStockQuery): string {
  const p = new URLSearchParams();
  const lists: [keyof LatestStockQuery, string][] = [
    ["warehouse", "warehouse"],
    ["floorName", "floorName"],
    ["itemType", "itemType"],
    ["category", "category"],
    ["subcategory", "subcategory"],
    ["stockType", "stockType"],
  ];
  for (const [key, name] of lists) {
    const v = q[key] as string[] | undefined;
    if (v?.length) v.forEach((one) => p.append(name, one));
  }
  if (q.enteredBy) p.set("enteredBy", q.enteredBy);
  if (q.search) p.set("search", q.search);
  if (q.verified !== undefined) p.set("verified", String(q.verified));
  if (q.includeDrafts) p.set("includeDrafts", "true");
  if (q.asOf) p.set("asOf", q.asOf);
  if (q.page) p.set("page", String(q.page));
  if (q.pageSize) p.set("pageSize", String(q.pageSize));
  if (q.sortBy) p.set("sortBy", q.sortBy);
  if (q.sortOrder) p.set("sortOrder", q.sortOrder);
  return p.toString();
}

export async function fetchLatestStock(
  q: LatestStockQuery = {},
  signal?: AbortSignal,
): Promise<LatestStockResponse> {
  const qs = buildParams(q);
  const res = await apiFetch(`${BASE}/latest-stock${qs ? `?${qs}` : ""}`, { signal });
  if (!res.ok) {
    // Surface the API's own message (e.g. an invalid asOf) rather than a bare
    // "HTTP 400" — readApiErrorMessage unwraps the house error envelope.
    throw new Error(await readApiErrorMessage(res, `Stock take HTTP ${res.status}`));
  }
  return (await res.json()) as LatestStockResponse;
}

export async function fetchStockTakeFilterOptions(
  signal?: AbortSignal,
): Promise<StockTakeFilterOptions> {
  const res = await apiFetch(`${BASE}/filter-options`, { signal });
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res, `Stock take filters HTTP ${res.status}`));
  }
  return (await res.json()) as StockTakeFilterOptions;
}

/** en-IN grouping, matching the rest of the console's quantity columns. */
export function formatNumber(n: number, dp = 2): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** "2026-09-02" -> "02 Sep 2026". Parsed as parts, never `new Date(str)`, which
 *  would treat the value as UTC midnight and render the previous day west of
 *  Greenwich. */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(d).padStart(2, "0")} ${MONTHS[m - 1]} ${y}`;
}

// ── Stock adjustment ledger (stocktake_transactions) ───────────────────────
// Append-only: a posted row is final and the table blocks UPDATE/DELETE at the
// database level, so there is deliberately no update or delete client here.
// Corrections are new rows carrying reverses_txn_id.

const TXN_BASE = "/api/v1/stock-take";

export type StockOperation = "ADDITION" | "SUBTRACTION";

/** What the signed-in user may post against, and why not when they may not. */
export interface StockTakeScope {
  warehouses: string[];
  floors: string[];
  /** Floors per warehouse, so the form can narrow the list once a warehouse is
   *  chosen. The server builds this from the ERP profile (FLOORS_BY_WAREHOUSE),
   *  falling back to the data only for warehouses that declare no floors. */
  floors_by_warehouse?: Record<string, string[]>;
  can_post: boolean;
  blocked_reason: "no_stock_data" | "no_floor_access" | "no_warehouse_access" | null;
  warehouses_unrestricted?: boolean;
  floors_unrestricted?: boolean;
}

export interface StockBalance {
  /** Baseline count date for this article at this place; null = never counted. */
  as_of_date: string | null;
  counted_kg: number;
  net_adjustment_kg: number;
  available_kg: number;
  uncounted: boolean;
}

export interface StockTransaction {
  /** Internal key. The FK target of reverses_txn_id — never displayed. */
  txn_id: number;
  /** 8-digit reference shown to operators: YYMMDD + a per-day sequence, e.g. "26090401". */
  txn_code: string;
  item_name: string;
  sku_id: number | null;
  is_new_article: boolean;
  material_type: string;
  item_category: string;
  item_subcategory: string;
  stock_type: string;
  units: number | null;
  qty_kg: number | null;
  operation: StockOperation;
  reason: string;
  warehouse: string;
  location: string;
  reverses_txn_id: number | null;
  /** The target's txn_code, resolved server-side so the UI shows one id format. */
  reverses_txn_code: string | null;
  is_reversal: boolean;
  created_by: string;
  created_at: string;
}

export interface CreateTransactionInput {
  item_name: string;
  sku_id?: number | null;
  is_new_article?: boolean;
  material_type: string;
  item_category: string;
  item_subcategory: string;
  stock_type?: string;
  units: number;
  qty_kg: number;
  operation: StockOperation;
  reason: string;
  /** Only to CHOOSE among granted values; the server validates against the token. */
  warehouse?: string;
  location?: string;
  reverses_txn_id?: number | null;
}

export interface CreateTransactionResult {
  transaction: StockTransaction;
  balance_before: StockBalance;
  balance_after_kg: number;
  /** Advisory: a subtraction beyond the available balance still posts. */
  overdrawn: boolean;
}

export async function fetchStockTakeScope(signal?: AbortSignal): Promise<StockTakeScope> {
  const res = await apiFetch(`${TXN_BASE}/scope`, { signal });
  if (!res.ok) throw new Error(await readApiErrorMessage(res, `Scope HTTP ${res.status}`));
  return (await res.json()) as StockTakeScope;
}

export async function fetchStockBalance(
  q: { itemName: string; stockType?: string; warehouse?: string; location?: string },
  signal?: AbortSignal,
): Promise<StockBalance> {
  const p = new URLSearchParams({ itemName: q.itemName });
  if (q.stockType) p.set("stockType", q.stockType);
  if (q.warehouse) p.set("warehouse", q.warehouse);
  if (q.location) p.set("location", q.location);
  const res = await apiFetch(`${TXN_BASE}/balance?${p}`, { signal });
  if (!res.ok) throw new Error(await readApiErrorMessage(res, `Balance HTTP ${res.status}`));
  return (await res.json()) as StockBalance;
}

export async function createStockTransaction(
  input: CreateTransactionInput,
  signal?: AbortSignal,
): Promise<CreateTransactionResult> {
  const res = await apiFetch(`${TXN_BASE}/transactions`, {
    method: "POST",
    body: JSON.stringify(input),
    signal,
  });
  if (!res.ok) throw new Error(await readApiErrorMessage(res, `Transaction HTTP ${res.status}`));
  return (await res.json()) as CreateTransactionResult;
}

export async function listStockTransactions(
  q: { warehouse?: string; location?: string; itemName?: string; page?: number; pageSize?: number } = {},
  signal?: AbortSignal,
): Promise<{ transactions: StockTransaction[]; pagination: { page: number; page_size: number; total: number; total_pages: number } }> {
  const p = new URLSearchParams();
  if (q.warehouse) p.set("warehouse", q.warehouse);
  if (q.location) p.set("location", q.location);
  if (q.itemName) p.set("itemName", q.itemName);
  if (q.page) p.set("page", String(q.page));
  if (q.pageSize) p.set("pageSize", String(q.pageSize));
  const qs = p.toString();
  const res = await apiFetch(`${TXN_BASE}/transactions${qs ? `?${qs}` : ""}`, { signal });
  if (!res.ok) throw new Error(await readApiErrorMessage(res, `Ledger HTTP ${res.status}`));
  return await res.json();
}

// ── Ledger view + export ───────────────────────────────────────────────────
// Both use the SAME filter shape, because the server builds both from one
// WHERE clause — an export that filtered differently from the screen it was
// launched from would hand someone a spreadsheet that disagrees with it.

export interface LedgerFilters {
  warehouse?: string;
  location?: string;
  itemName?: string;
  operation?: StockOperation;
  /** Exact day, YYYY-MM-DD. Overrides the range server-side. */
  date?: string;
  dateFrom?: string;
  dateTo?: string;
}

function ledgerParams(f: LedgerFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.warehouse) p.set("warehouse", f.warehouse);
  if (f.location) p.set("location", f.location);
  if (f.itemName) p.set("itemName", f.itemName);
  if (f.operation) p.set("operation", f.operation);
  if (f.date) p.set("date", f.date);
  else {
    if (f.dateFrom) p.set("dateFrom", f.dateFrom);
    if (f.dateTo) p.set("dateTo", f.dateTo);
  }
  return p;
}

export interface LedgerPage {
  transactions: StockTransaction[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
  filters: Record<string, unknown>;
}

/** One page of the ledger. The server defaults to 200 per page. */
export async function fetchLedger(
  f: LedgerFilters & { page?: number; pageSize?: number } = {},
  signal?: AbortSignal,
): Promise<LedgerPage> {
  const p = ledgerParams(f);
  if (f.page) p.set("page", String(f.page));
  if (f.pageSize) p.set("pageSize", String(f.pageSize));
  const res = await apiFetch(`${TXN_BASE}/transactions?${p}`, { signal });
  if (!res.ok) throw new Error(await readApiErrorMessage(res, `Ledger HTTP ${res.status}`));
  return (await res.json()) as LedgerPage;
}

/** Download every matching row as .xlsx — no paging is sent or accepted.
 *
 *  The blob is fetched through apiFetch (rather than pointing the browser at the
 *  URL) because the endpoint needs the bearer token, which a plain navigation
 *  would not carry. */
export async function downloadLedgerExcel(f: LedgerFilters = {}): Promise<number> {
  const res = await apiFetch(`${TXN_BASE}/transactions/export?${ledgerParams(f)}`);
  if (!res.ok) throw new Error(await readApiErrorMessage(res, `Export HTTP ${res.status}`));
  const rows = Number(res.headers.get("X-Total-Rows") ?? 0);
  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition") ?? "";
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? "stock-transactions.xlsx";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick: revoking synchronously can cancel the download in
  // some browsers before it has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return rows;
}


// ── Floor count export ─────────────────────────────────────────────────────
// The raw counting rows behind the aggregate on the Stock Take landing page:
// one row per weighing, not one per article. Same filter shape as
// fetchLatestStock so the file matches the screen it was launched from, plus a
// date range, because a raw-row sheet is read by period.

/** Filters for the count-row export. A superset of the floor app's five. */
export interface EntriesExportFilters {
  warehouse?: string[];
  floorName?: string[];
  itemType?: string[];
  category?: string[];
  subcategory?: string[];
  stockType?: string[];
  enteredBy?: string;
  search?: string;
  verified?: boolean;
  /** IST calendar day, YYYY-MM-DD, inclusive. */
  dateFrom?: string;
  dateTo?: string;
}

/** What the download actually contained, for the confirmation message. */
export interface EntriesExportResult {
  /** Submitted count rows written to the sheet. */
  rows: number;
  /** Draft rows the export deliberately left out. */
  drafts: number;
  filename: string;
}

function entriesParams(f: EntriesExportFilters): URLSearchParams {
  const p = new URLSearchParams();
  const lists: [keyof EntriesExportFilters, string][] = [
    ["warehouse", "warehouse"],
    ["floorName", "floorName"],
    ["itemType", "itemType"],
    ["category", "category"],
    ["subcategory", "subcategory"],
    ["stockType", "stockType"],
  ];
  for (const [key, name] of lists) {
    const v = f[key] as string[] | undefined;
    if (v?.length) v.forEach((one) => p.append(name, one));
  }
  if (f.enteredBy) p.set("enteredBy", f.enteredBy);
  if (f.search) p.set("search", f.search);
  if (f.verified !== undefined) p.set("verified", String(f.verified));
  if (f.dateFrom) p.set("dateFrom", f.dateFrom);
  if (f.dateTo) p.set("dateTo", f.dateTo);
  return p;
}

/** Download every matching count row as .xlsx. Drafts are never included.
 *
 *  Like the ledger export this is unpaginated and fetched through apiFetch
 *  rather than by pointing the browser at the URL, because the endpoint needs
 *  the bearer token a plain navigation would not carry.
 *
 *  X-Total-Rows / X-Draft-Rows / Content-Disposition are only readable because
 *  they are in the API's CORS expose_headers — an unlisted header comes back as
 *  null with no error, which is why the counts below have fallbacks. */
export async function downloadEntriesExcel(
  f: EntriesExportFilters = {},
): Promise<EntriesExportResult> {
  const qs = entriesParams(f).toString();
  const res = await apiFetch(`${TXN_BASE}/entries/export${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(await readApiErrorMessage(res, `Export HTTP ${res.status}`));
  const rows = Number(res.headers.get("X-Total-Rows") ?? 0);
  const drafts = Number(res.headers.get("X-Draft-Rows") ?? 0);
  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition") ?? "";
  const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? "StockTakeEntries.xlsx";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { rows, drafts, filename };
}
