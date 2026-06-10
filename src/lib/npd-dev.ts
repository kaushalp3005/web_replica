// Standalone NPD development job-card client. Pure R&D, decoupled from sample
// requisitions: create a dev job card, author the trial recipe, start
// development, then close — which records the output and promotes the recipe
// into a live BOM. All under /api/v1/sample/npd-dev-job-cards/*.

import { apiFetch, readApiErrorMessage } from "./auth";

export type DevJcStatus = "DRAFT" | "IN_DEVELOPMENT" | "CLOSED" | "CANCELLED";

export interface DevLine {
  id?: number;
  sku_id: number | null;   // null for clone-from-base lines (bom_line has no sku_id)
  sku_name: string;
  qty: number | string;
  uom: string;
  item_type?: "rm" | "pm" | null;
  // Off-master = a free-typed external/test ingredient not in the SKU master.
  // Recorded for traceability only (no inventory posting).
  is_off_master?: boolean;
  line_order?: number;
  notes?: string | null;
}

export interface DevJobCard {
  id: number;
  dev_jc_number: string;
  title: string;
  description?: string | null;
  warehouse?: string | null;
  base_bom_id?: number | null;
  base_bom_name?: string | null;   // FG name of the base BOM (detail header)
  fg_sku_id?: number | null;
  fg_sku_name?: string | null;
  target_qty?: number | string | null;
  uom?: string | null;
  status: DevJcStatus;
  output_qty?: number | string | null;
  output_uom?: string | null;
  yield_pct?: number | string | null;
  rm_consumed_qty?: number | string | null;
  wastage_qty?: number | string | null;
  extra_give_away_qty?: number | string | null;
  output_notes?: string | null;
  promoted_bom_id?: number | null;
  fg_sample_batch_id?: string | null;   // R&D-location FG-sample batch minted on close (Step B)
  dispatched_at?: string | null;        // Step C — issued out of R&D
  dispatch_recipient?: string | null;
  dispatch_qty?: number | string | null;
  dispatch_mat_doc_id?: string | null;
  cancellation_reason?: string | null;
  created_at?: string | null;
  started_at?: string | null;
  closed_at?: string | null;
  // List rows carry a line_count; the detail GET carries the full lines.
  line_count?: number;
  lines?: DevLine[];
}

export interface DevJobCardCreate {
  title: string;
  description?: string;
  warehouse?: string;
  base_bom_id?: number;
  fg_sku_id?: number;
  fg_sku_name?: string;
  target_qty?: number;
  uom?: string;
  source_requisition_id?: number;   // set when started from a request's "Develop"
  clone_from_base?: boolean;
  lines?: DevLine[];
}

export interface DevJobCardCloseBody {
  output_qty?: number;
  output_uom?: string;
  yield_pct?: number;
  rm_consumed_qty?: number;
  wastage_qty?: number;
  extra_give_away_qty?: number;
  output_notes?: string;
}

// Compact BOM row for the 'Base BOM' typeahead (there are ~1300 active BOMs,
// so the operator searches rather than scrolling a static list).
export interface BomOption {
  bom_id: number;
  fg_sku_name?: string | null;
  customer_name?: string | null;
  version?: number | string | null;
  is_active?: boolean | null;
  pack_size_kg?: number | string | null;
}

async function jsonOrThrow<T>(resP: Response | Promise<Response>, fallback: string): Promise<T> {
  const res = await resP;
  if (!res.ok) throw new Error(await readApiErrorMessage(res, fallback));
  return (await res.json()) as T;
}

function post(path: string, body?: unknown): Promise<Response> {
  return apiFetch(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
}

const BASE = "/api/v1/sample/npd-dev-job-cards";

export async function listDevJobCards(status?: string): Promise<DevJobCard[]> {
  const q = new URLSearchParams();
  if (status) q.set("status", status);
  q.set("limit", "200");
  return jsonOrThrow(await apiFetch(`${BASE}?${q}`), "Failed to load development job cards");
}

export async function getDevJobCard(id: number): Promise<DevJobCard> {
  return jsonOrThrow(await apiFetch(`${BASE}/${id}`), "Failed to load job card");
}

// A BOM's material line. References material by name; sku_id is resolved server
// side via the normalised-name match (nullable — ~99% resolve) so callers that
// need a real id (requisition articles) can use it directly.
export interface BomLine {
  line_number?: number | null;
  material_sku_name: string;
  item_type?: string | null;
  quantity_per_unit: number | string;
  uom?: string | null;
  sku_id?: number | null;
}

// Full material list of a BOM — used to replicate the base recipe into a new
// dev job card's trial recipe.
export async function getBomLines(bomId: number): Promise<BomLine[]> {
  return jsonOrThrow(await apiFetch(`/api/v1/sample/boms/${bomId}/lines`), "Failed to load BOM lines");
}

// Cascade browse for the Base-BOM picker's "Browse" tab — drills the article
// master (joined to BOMs on the normalised FG name) Item type -> Group ->
// Sub-group -> Item, then lists the matching BOM(s).
export interface BomBrowseResult {
  options: { item_types: string[]; item_groups: string[]; sub_groups: string[]; particulars: string[] };
  boms: BomOption[];
}
export interface BomBrowseParams {
  item_type?: string; item_group?: string; sub_group?: string; particulars?: string;
}
const EMPTY_BROWSE: BomBrowseResult = {
  options: { item_types: [], item_groups: [], sub_groups: [], particulars: [] }, boms: [],
};
export async function browseBoms(params: BomBrowseParams): Promise<BomBrowseResult> {
  try {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    const res = await apiFetch(`/api/v1/sample/bom-browse?${q}`);
    if (!res.ok) return EMPTY_BROWSE;
    return (await res.json()) as BomBrowseResult;
  } catch {
    return EMPTY_BROWSE;
  }
}

// Typeahead for the Base BOM picker. Swallows transport errors to an empty list
// so the picker degrades to "no matches" rather than throwing in render.
export async function searchBoms(search: string): Promise<BomOption[]> {
  try {
    const q = new URLSearchParams({ limit: "30" });
    if (search.trim()) q.set("search", search.trim());
    const res = await apiFetch(`/api/v1/sample/boms?${q}`);
    if (!res.ok) return [];
    return (await res.json()) as BomOption[];
  } catch {
    return [];
  }
}

export async function createDevJobCard(body: DevJobCardCreate): Promise<DevJobCard> {
  return jsonOrThrow(await post(BASE, body), "Failed to create job card");
}

export async function replaceDevLines(id: number, lines: DevLine[]): Promise<DevJobCard> {
  return jsonOrThrow(
    await apiFetch(`${BASE}/${id}/lines`, { method: "PUT", body: JSON.stringify({ lines }) }),
    "Failed to save recipe lines");
}

export const startDevJobCard = (id: number) =>
  jsonOrThrow<DevJobCard>(post(`${BASE}/${id}/start`), "Start failed");
export const closeDevJobCard = (id: number, body: DevJobCardCloseBody) =>
  jsonOrThrow<DevJobCard>(post(`${BASE}/${id}/close`, body), "Close failed");
export const cancelDevJobCard = (id: number, reason: string) =>
  jsonOrThrow<DevJobCard>(post(`${BASE}/${id}/cancel`, { reason }), "Cancel failed");
export const dispatchDevJobCard = (id: number, body: { recipient?: string; qty?: number }) =>
  jsonOrThrow<DevJobCard>(post(`${BASE}/${id}/dispatch`, body), "Dispatch failed");
