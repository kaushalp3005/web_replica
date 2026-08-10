// Inventory Ledger — typed client + domain types.
//
// Quantity-first, Tally-aligned model (see INVENTORY_LEDGER_V2_TALLY_VIEW_PLAN.md).
// Value/rate ride along as *indicative only* (not reconciled), so nothing here
// sums value into a control total. Quantities NEVER cross UOM classes — every
// roll-up carries a `uom_class` and is grouped by it.
//
// The backend endpoints under /api/v1/ledger are not built yet; the page code
// renders from `_fixtures.ts` today and swaps to `LedgerApi.*` once the routes
// land. The client below is the wire contract (matches the artifact §11 API).

import { apiFetch, readApiErrorMessage } from "@/lib/auth";

// ── Enums / primitives ─────────────────────────────────────────────
export type UomClass = "kg" | "nos" | "no";
export type Direction = "IN" | "OUT" | "TRANSFER";
export type Entity = "cfpl" | "cdpl";
export type SummaryLevel = "group" | "subgroup" | "item";
export type LedgerGrain = "item" | "subgroup" | "group";
export type LotStatus =
  | "AVAILABLE" | "BLOCKED" | "ISSUED" | "IN_TRANSIT" | "INTERNAL_HOLD"
  | "FLAGGED" | "RETURNED" | "SCRAPPED" | "QC_HOLD" | "DISCARDED";
export type FifoFlagType = "violation" | "override" | "blocked" | "near_expiry";
export type AgeBucket = "0_30" | "31_60" | "61_90" | "90_plus";

// ── Paged envelope (shared by every view/search endpoint) ──────────
export interface ListEnvelope<T> {
  data: T[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  has_next: boolean;
}

// ── Row shapes (mirror the artifact §11 response payloads) ─────────
export interface ItemSearchResult {
  sku_id: number;
  particulars: string;
  item_type: string | null;
  item_group: string | null;
  sub_group: string | null;
  uom_class: UomClass;
  closing_qty: number;
  value_indicative: number | null;
}

export interface SummaryRow {
  drill_key: string;
  label: string;
  level: SummaryLevel;
  uom_class: UomClass | "mixed";
  opening_qty: number | null;
  inward_qty: number | null;
  outward_qty: number | null;
  closing_qty: number | null;
  value_indicative: number | null;
  item_count: number;
  has_children: boolean;
}

// ── Granular movement columns (the full ledger equation) ───────────
// Closing = Opening + Inward + Production + Returns − Consumption − Outward − Transfer-out
export interface MovementCols {
  opening_qty: number;
  inward_qty: number;       // 101 GR + transfer-in + material-in
  production_qty: number;   // 531 FG output / byproduct
  returns_qty: number;      // 451 customer return + 262
  consumption_qty: number;  // 261 goods-issue to production
  outward_qty: number;      // dispatch 601 + write-off 551 + RTV 122
  transfer_out_qty: number; // 301 / 311 transfer-out
}
export const MOVEMENT_KEYS = [
  "opening", "inward", "consumption", "production", "returns", "outward", "transfer_out",
] as const;
export type MovementKey = (typeof MOVEMENT_KEYS)[number];

export interface LeafItem extends MovementCols {
  sku_id: number;
  label: string;
  item_type: string; // rm / pm / fg
  group: string;
  subgroup: string;
  uom_class: UomClass;
  godown: string;
  value_indicative: number;
}

export interface UomSubtotal extends MovementCols {
  uom_class: UomClass;
  closing_qty: number;
  value_indicative: number;
}

// A row in the Stock Summary tree. Numeric columns are per-UOM sums for a
// single-UOM node; for a MIXED node they are null and `uom_subtotals` carries
// the per-UOM breakdown (quantities are never summed across UOM classes).
export interface LedgerNode {
  key: string;
  label: string;
  level: SummaryLevel;
  uom_class: UomClass | "mixed";
  opening_qty: number | null;
  inward_qty: number | null;
  production_qty: number | null;
  returns_qty: number | null;
  consumption_qty: number | null;
  outward_qty: number | null;
  transfer_out_qty: number | null;
  closing_qty: number | null;
  value_indicative: number;
  item_count: number;
  godown?: string; // leaf only
  sku_id?: number; // leaf only
  drill_key?: string; // route slug for full-page drill (groups)
  uom_subtotals: UomSubtotal[];
  children: LedgerNode[];
}

export interface VoucherRow {
  ledger_id: number; // 8-digit time id
  posting_date: string; // ISO date
  sku_name: string;
  vch_type: string;
  vch_no: string | null;
  movement_type: string;
  direction: Direction;
  in_qty: number | null;
  out_qty: number | null;
  uom_class: UomClass;
  running_balance: number;
  counterpart_label: string | null;
  ref_type: string | null;
  ref_id: string | null;
  is_synthetic: boolean;
  fifo_flag: FifoFlagType | null;
}

export interface MonthlyRow {
  month: string; // "Opening" | "April" | ...
  in_qty: number | null;
  in_value: number | null;
  out_qty: number | null;
  out_value: number | null;
  closing_qty: number;
  closing_value: number | null;
}

export interface Lot {
  batch_id: string;
  sku_name: string;
  lot_number: string | null;
  box_id: string | null;
  current_qty: number;
  uom_class: UomClass;
  warehouse_code: string | null;
  floor_id: string | null;
  status: LotStatus;
  inward_date: string;
  expiry_date: string | null;
  age_days: number;
  near_expiry: boolean;
  blocked_for_so: string | null;
  source_store: string;
}

export interface AgeingRow {
  group_key: string;
  uom_class: UomClass;
  b_0_30: number;
  b_31_60: number;
  b_61_90: number;
  b_90_plus: number;
  total_qty: number;
  expired_qty: number | null;
  near_expiry_qty: number | null;
}

export interface FifoFlag {
  flag_id: number; // 8-digit time id
  vch_no: string;
  sku_name: string;
  consumed_lot: string | null;
  oldest_available_lot: string | null;
  flag_type: FifoFlagType;
  reason: string | null;
  disposition: string | null;
}

export interface ReconRow {
  sku_name: string;
  warehouse_code: string;
  batch_qty: number;
  floor_qty: number | null;
  delta_qty: number | null;
  status: "matched" | "variance" | "store_gap";
}

// ── Shared query filters (all optional; omit = no filter) ──────────
export interface LedgerFilter {
  entity?: Entity | "both";
  item_type?: string;
  item_group?: string;
  sub_group?: string;
  sku?: string;
  warehouse_code?: string;
  batch_id?: string;
  lot_number?: string;
  uom_class?: UomClass;
  movement_type?: string;
  ref_type?: string;
  direction?: Direction;
  status?: LotStatus;
  age_bucket?: AgeBucket;
  date_from?: string;
  date_to?: string;
  q?: string;
}
export interface PageQuery {
  page?: number;
  page_size?: number;
  sort?: string;
  order?: "asc" | "desc";
}

const BASE = "/api/v1/ledger";

function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    // Repeat the key for array-valued filters (multi-select), e.g. ?wh=A&wh=B.
    if (Array.isArray(v)) { for (const item of v) sp.append(k, String(item)); continue; }
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await apiFetch(`${BASE}${path}`, signal ? { signal } : {});
  if (!res.ok) {
    // readApiErrorMessage extracts a clean message from the error envelope
    // instead of dumping an HTML error page into Error.message.
    throw new Error(await readApiErrorMessage(res, `Ledger request failed (${res.status})`));
  }
  const text = await res.text();
  if (!text) return {} as T; // tolerate an empty 200 body
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("Ledger returned a malformed response.");
  }
}

// ── The wire client (paths mirror artifact §11) ───────────────────
export const LedgerApi = {
  // The flat leaf dataset the module derives every view from. Fixtures are the
  // fallback (see _LedgerData); in live mode this feeds the whole module.
  leaves(signal?: AbortSignal) {
    return getJson<{ data: LeafItem[] }>(`/leaves`, signal);
  },
  searchItems(f: LedgerFilter & PageQuery) {
    return getJson<ListEnvelope<ItemSearchResult>>(`/items/search${qs({ ...f })}`);
  },
  stockSummary(f: LedgerFilter & PageQuery & { level: SummaryLevel; as_of?: string }) {
    return getJson<ListEnvelope<SummaryRow>>(`/stock-summary${qs({ ...f })}`);
  },
  articleLedger(sku: string, f: LedgerFilter & PageQuery & { grain?: LedgerGrain }) {
    return getJson<ListEnvelope<VoucherRow>>(
      `/article/${encodeURIComponent(sku)}/ledger${qs({ ...f })}`,
    );
  },
  articleMonthly(sku: string, f: LedgerFilter) {
    return getJson<{ data: MonthlyRow[] }>(
      `/article/${encodeURIComponent(sku)}/monthly${qs({ ...f })}`,
    );
  },
  lotsAvailable(f: LedgerFilter & PageQuery & { near_expiry?: boolean; min_qty?: number }) {
    return getJson<ListEnvelope<Lot>>(`/lots-available${qs({ ...f })}`);
  },
  ageing(f: LedgerFilter & PageQuery & { level: SummaryLevel; bucket?: AgeBucket }) {
    return getJson<ListEnvelope<AgeingRow>>(`/ageing${qs({ ...f })}`);
  },
  fifoCompliance(f: LedgerFilter & PageQuery & { flag_type?: FifoFlagType }) {
    return getJson<ListEnvelope<FifoFlag>>(`/fifo-compliance${qs({ ...f })}`);
  },
  // Export routes are file streams (no pagination) — return the built URL so a
  // plain <a download> / window.open triggers the browser download.
  exportUrl(view: string, f: LedgerFilter & { format?: "xlsx" | "csv" }): string {
    return `${BASE}/${view}/export${qs({ ...f })}`;
  },
};
