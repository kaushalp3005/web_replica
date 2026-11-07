// BOM module API surface. Typed wrappers over the standalone BOM router at
// server_replica/app/modules/bom/router.py, backed by
// server_replica/app/modules/bom/services/bom_aggregate_service.py.
//
// The `/api/v1` prefix is NOT applied centrally — main.py calls
// `app.include_router(bom_router)` with no kwargs, so the prefix lives on the
// router itself (`APIRouter(prefix="/api/v1/bom")`). The full paths below are
// therefore the literal wire paths; do not strip or re-add a prefix here.
//
//   GET    /api/v1/bom/aggregate   → { results: BomAggregateRow[], pagination: {...} }
//   GET    /api/v1/bom/lookups/materials?q=  → { results: BomMaterialOption[] }   (form picker)
//   GET    /api/v1/bom/lookups/processes?q=  → { results: BomProcessOption[] }    (form picker)
//   GET    /api/v1/bom/{bom_id}    → { header, lines, route, counts }   (404 if absent)
//   POST   /api/v1/bom             → BomCreateResponse (201)             strict create
//   PATCH  /api/v1/bom/{bom_id}    → BomUpdateResponse                   partial update
//   DELETE /api/v1/bom/{bom_id}    → BomDeleteResponse                   SOFT delete
//
// Each endpoint is gated on its own ('bom', NULL, NULL, <action>) permission:
// view + create are seeded by app/db/095_bom_module_rbac.sql, update + delete
// by app/db/139_bom_module_rbac_update_delete.sql. A 403 means the migration
// has not been deployed, or the caller's role lacks that grant.
//
// DELETE never removes anything: bom_id is referenced from plan lines, job
// cards, QC and costing, so the server flips bom_header.is_active to FALSE and
// stops. It is idempotent (a second call reports already_inactive: true) and is
// reversed with PATCH { is_active: true }.
//
// Every call goes through apiFetch so it picks up the bearer token and the
// deduped silent-refresh retry on 401.

import { apiFetch, readApiErrorMessage } from "./auth";

const BASE = "/api/v1/bom";

// ── Aggregate row (one row per BOM) ──────────────────────────────────────
//
// The rollups are computed in SQL via LEFT JOIN LATERAL, so a BOM with zero
// lines and/or zero route steps still comes back — with zeros, not missing.
// That is deliberate: those are exactly the broken BOMs this screen exists to
// surface, and an inner join would hide them.
//
// NUMERIC columns and SUM()/AVG() over them arrive from asyncpg as Decimal.
// There is no global JSON codec on the pool, so depending on the call site's
// serializer they land on the wire as either a JSON number or a string. Every
// such field is typed `number | string | null` — always coerce before doing
// arithmetic or calling toFixed().

export interface BomAggregateRow {
  bom_id: number;
  fg_sku_name: string;
  customer_name?: string | null;
  version?: number | null;
  is_active?: boolean | null;
  entity?: string | null;               // 'cfpl' | 'cdpl' (lowercase — CHECK constraint)
  item_group?: string | null;
  sub_group?: string | null;
  pack_size_kg?: number | string | null;
  output_uom?: string | null;
  effective_from?: string | null;       // YYYY-MM-DD
  effective_to?: string | null;         // YYYY-MM-DD; null ⇒ open-ended
  // ── bom_line rollups ──
  rm_count?: number | null;             // lines with item_type = 'rm'
  pm_count?: number | null;             // lines with item_type = 'pm'
  other_count?: number | null;          // everything else — 'sfg' occurs in practice
  line_count?: number | null;           // rm + pm + other; 0 ⇒ header with no lines
  total_qty_per_unit?: number | string | null;   // Σ quantity_per_unit (mixed UOMs — indicative only)
  total_qty_rm?: number | string | null;
  total_qty_pm?: number | string | null;
  avg_line_loss_pct?: number | string | null;    // see the service's comment for weighted vs simple
  // ── bom_process_route rollups ──
  step_count?: number | null;           // 0 ⇒ BOM has no process route at all
  total_std_time_min?: number | string | null;
  total_route_loss_pct?: number | string | null;
  // ── flags ──
  distinct_godowns?: string[] | null;   // DISTINCT bom_line.godown, NULLs dropped
  has_offgrade_lines?: boolean | null;  // any line with can_use_offgrade = true
  [k: string]: unknown;
}

// ── Detail rows ──────────────────────────────────────────────────────────

export interface BomLineRow {
  bom_line_id: number;
  line_number: number;                  // UNIQUE(bom_id, line_number) — the display order
  material_sku_name: string;
  item_type?: string | null;            // 'rm' | 'pm' — 'sfg' also occurs in the data
  quantity_per_unit?: number | string | null;
  uom?: string | null;
  loss_pct?: number | string | null;
  godown?: string | null;               // 'RM Store' | 'PM Store' | ...
  can_use_offgrade?: boolean | null;
  offgrade_max_pct?: number | string | null;
  unit_rate_inr?: number | string | null;
  process_stage?: string | null;        // free text from the master ingest
  staging_method?: string | null;       // 'pick' | 'backflush' | 'floor_stock' (CHECK)
  // Free text written by master_ingest.py — e.g. 'Final FG (opening RM)'. It is
  // NOT a foreign key into bom_process_route and shares no vocabulary with it.
  // Render it as a plain column; never use it to join or bucket lines under steps.
  consumed_at_stage?: string | null;
  [k: string]: unknown;
}

export interface BomRouteStep {
  route_id: number;
  step_number: number;                  // UNIQUE(bom_id, step_number) — the strip order
  process_name: string;
  stage?: string | null;                // slug, e.g. 'packing' | 'create_wip'
  std_time_min?: number | string | null;
  loss_pct?: number | string | null;
  qc_check?: string | null;
  machine_type?: string | null;
  practical_operation?: string | null;  // e.g. 'Roast & Flavour/Salt' (bar_line_service.py)
  stage_bucket?: string | null;
  [k: string]: unknown;
}

export interface BomPagination {
  page?: number;
  page_size?: number;
  total?: number;
  total_pages?: number;
}

export interface BomAggregateResponse {
  results?: BomAggregateRow[];
  pagination?: BomPagination;
}

// DO NOT "improve" this into a nested shape.
//
// `lines` and `route` are two FLAT, independently-ordered arrays on purpose.
// bom_header → bom_line and bom_header → bom_process_route are both real FKs on
// bom_id, but bom_line ↔ bom_process_route have NO FK and NO reliable join key.
// They are only related through free text written by two different ingest paths:
// bom_line.consumed_at_stage holds values like 'Final FG (opening RM)'
// (master_ingest.py:836), while bom_process_route.practical_operation holds
// values like 'Roast & Flavour/Salt' (bar_line_service.py:63) and
// bom_process_route.stage holds slugs like 'packing' / 'create_wip'.
//
// Nesting lines under steps therefore requires a string match that silently
// DROPS every line whose text does not match a step, and mis-buckets the rest —
// on exactly the malformed BOMs this screen was built to find. Keep them flat:
// render the lines as a table with consumed_at_stage / process_stage as plain
// columns, and the route as its own ordered strip.
export interface BomDetail {
  header: Record<string, unknown>;      // all 26 bom_header columns, un-narrowed
  lines: BomLineRow[];                  // server-ordered by line_number
  route: BomRouteStep[];                // server-ordered by step_number
  counts?: Record<string, unknown>;
}

// ── Listing query ────────────────────────────────────────────────────────
//
// Server param names: search, entity, item_group, customer_name, is_active,
// item_type, page (>=1), page_size (default 50, max 200).
//
// `item_type` is an EXISTS filter, not a projection filter: it returns BOMs
// that have at least one line of that type, with all their lines intact.
//
// NOTE on `entity`: require_permission auto-applies entity scoping from this
// query param (middleware.py:163), so passing an entity the caller's role is
// not scoped to yields a 403, not an empty list.

export interface BomFilters {
  search?: string;
  entity?: string;                      // 'cfpl' | 'cdpl'
  item_group?: string;
  customer_name?: string;
  is_active?: boolean;                  // tri-state: undefined ⇒ omit (both)
  item_type?: string;                   // 'rm' | 'pm' | 'sfg'
  page?: number;
  page_size?: number;
}

function buildAggregateParams(f: BomFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.search) p.set("search", f.search);
  if (f.entity) p.set("entity", f.entity);
  if (f.item_group) p.set("item_group", f.item_group);
  if (f.customer_name) p.set("customer_name", f.customer_name);
  // is_active is genuinely tri-state. `if (f.is_active)` would drop the
  // explicit `false` filter (inactive-only) and silently widen it to "all",
  // so test for the boolean type rather than truthiness.
  if (typeof f.is_active === "boolean") p.set("is_active", String(f.is_active));
  if (f.item_type) p.set("item_type", f.item_type);
  if (f.page != null) p.set("page", String(f.page));
  if (f.page_size != null) p.set("page_size", String(f.page_size));
  return p;
}

// ── Calls ────────────────────────────────────────────────────────────────

export async function listBomAggregate(
  f: BomFilters,
  signal?: AbortSignal,
): Promise<BomAggregateResponse> {
  const res = await apiFetch(`${BASE}/aggregate?${buildAggregateParams(f)}`, { signal });
  if (!res.ok) {
    // Surface the server's own message ({error,message,details} / {detail}
    // envelope) so a scope rejection reads "Permission denied: bom/*/view"
    // rather than a generic "BOMs HTTP 403". readApiErrorMessage handles the
    // non-JSON body and the fallback in one place.
    throw new Error(await readApiErrorMessage(res, `BOMs HTTP ${res.status}`));
  }
  return (await res.json()) as BomAggregateResponse;
}

export async function getBomDetail(
  bomId: number,
  signal?: AbortSignal,
): Promise<BomDetail> {
  const res = await apiFetch(`${BASE}/${bomId}`, { signal });
  if (res.status === 404) throw new Error("BOM not found.");
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res, `BOM HTTP ${res.status}`));
  }
  return (await res.json()) as BomDetail;
}

// ── Writes ───────────────────────────────────────────────────────────────
//
// Mirrors BomLineIn / BomRouteStepIn / BomCreateRequest / BomUpdateRequest in
// server_replica/app/modules/bom/router.py. The server assigns line_number and
// step_number from ARRAY ORDER (never from the client), bom_id and version are
// server-owned, and bom_header.created_at defaults.

export type BomEntity = "cfpl" | "cdpl";
export type BomItemType = "rm" | "pm" | "sfg";
export type BomStagingMethod = "pick" | "backflush" | "floor_stock";

export interface BomLineInput {
  // UPDATE ONLY. Present ⇒ that existing line is updated in place and keeps its
  // id (so job-card indents / consumption rows stay attached). Absent ⇒ a new
  // line is inserted. An existing line whose id is not sent back is deleted —
  // unless a job card references it, which is a 409 `line_referenced`.
  bom_line_id?: number;
  material_sku_name: string;
  item_type: BomItemType;
  quantity_per_unit: number;            // per ONE unit of FG; must be ≥ 0.001
  uom?: string | null;
  loss_pct?: number | null;
  godown?: string | null;
  can_use_offgrade?: boolean | null;
  offgrade_max_pct?: number | null;
  unit_rate_inr?: number | null;
  process_stage?: string | null;
  staging_method?: BomStagingMethod | null;
  consumed_at_stage?: string | null;
}

export interface BomRouteStepInput {
  process_name: string;
  stage?: string | null;                // defaults to a slug of process_name
  std_time_min?: number | null;
  loss_pct?: number | null;
  qc_check?: string | null;
  machine_type?: string | null;
  practical_operation?: string | null;
  stage_bucket?: string | null;
  input_kind?: string | null;
  output_kind?: string | null;
  input_code?: string | null;
  output_code?: string | null;
}

// Every header column the write endpoints accept. On PATCH a key that is
// PRESENT is written (null clears a nullable column); a key that is absent is
// left alone — so build update payloads as diffs, never by spreading the whole
// header back.
export interface BomHeaderInput {
  fg_sku_name?: string;
  entity?: BomEntity | null;
  customer_name?: string | null;        // null ⇒ generic BOM
  pack_size_kg?: number | null;
  output_uom?: string | null;
  item_group?: string | null;
  sub_group?: string | null;
  process_category?: string | null;
  business_unit?: string | null;
  factory?: string | null;
  floors?: string[] | null;
  machines?: string[] | null;
  bar_line_process?: string | null;
  shelf_life_days?: number | null;      // integer
  gst_rate?: number | null;
  hsn_sac?: string | null;
  inventory_group?: string | null;
  customer_code?: string | null;
  // A FRACTION, not a percent: 0.001 = 0.1 %. Server refuses anything outside
  // [0, 1] and refuses null on PATCH (the column is NOT NULL).
  allowed_balance_tolerance_pct?: number | null;
  effective_from?: string | null;       // YYYY-MM-DD; create defaults to today
  effective_to?: string | null;
  notes?: string | null;
}

export interface BomCreateInput extends BomHeaderInput {
  fg_sku_name: string;
  lines: BomLineInput[];                // at least one
  route?: BomRouteStepInput[];
}

export interface BomUpdateInput extends BomHeaderInput {
  is_active?: boolean;                  // true re-activates (409 if the FG name is taken)
  lines?: BomLineInput[];               // whole set, matched by bom_line_id; ≥ 1 when sent
  route?: BomRouteStepInput[];          // whole strip; [] clears it
}

export interface BomCreateResponse {
  bom_id: number;
  fg_sku_name: string;
  version: number;
  entity: string | null;
  lines_created: number;
  route_steps_created: number;
  created_by: string | null;
  warnings: string[];                   // e.g. the Tally-refresh caveat
}

export interface BomUpdateResponse {
  bom_id: number;
  fg_sku_name: string;
  version: number;
  is_active: boolean;
  updated_by: string | null;
  changes: {
    header_fields: string[];
    lines: { inserted: number; updated: number; deleted: number } | null;
    route: { steps_created: number } | null;
  };
  warnings: string[];
  detail: BomDetail;                    // fresh read after the write, same shape as GET
}

export interface BomDeleteResponse {
  bom_id: number;
  fg_sku_name: string;
  version: number;
  is_active: false;
  already_inactive: boolean;
  deactivated_by: string | null;
}

async function sendJson<T>(path: string, method: "POST" | "PATCH", payload: unknown, fallback: string): Promise<T> {
  const res = await apiFetch(path, { method, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(await readApiErrorMessage(res, fallback));
  return (await res.json()) as T;
}

export function createBom(input: BomCreateInput): Promise<BomCreateResponse> {
  // 409 `bom_exists` when an ACTIVE BOM already holds this FG name — the
  // server never supersedes; deactivate the incumbent first.
  return sendJson<BomCreateResponse>(BASE, "POST", input, "Could not create the BOM.");
}

export function updateBom(bomId: number, patch: BomUpdateInput): Promise<BomUpdateResponse> {
  // 400 `empty_update` for {}, 409 `bom_exists` on a rename / re-activation
  // clash, 409 `line_referenced` when a dropped line is still used by a job
  // card (the whole save is rolled back; keep the line and edit it instead).
  return sendJson<BomUpdateResponse>(`${BASE}/${bomId}`, "PATCH", patch, "Could not save the BOM.");
}

export async function deleteBom(bomId: number): Promise<BomDeleteResponse> {
  // Soft delete — see the header comment. 200 with a body, not 204.
  const res = await apiFetch(`${BASE}/${bomId}`, { method: "DELETE" });
  if (res.status === 404) throw new Error("BOM not found.");
  if (!res.ok) throw new Error(await readApiErrorMessage(res, "Could not deactivate the BOM."));
  return (await res.json()) as BomDeleteResponse;
}

// ── Lookups (type-ahead for the form) ────────────────────────────────────
//
// Both are gated on bom.view like the reads. The material search is NOT
// /so/sku-lookup: it returns a short ranked list WITH each article's
// item_type (so a pick sets the line's rm/pm/sfg) and it does not hide sfg or
// fg — hamper BOMs carry finished goods as rm components.

export interface BomMaterialOption {
  sku_id: number;
  particulars: string;
  item_type?: string | null;            // 'rm' | 'pm' | 'sfg' | 'fg' | null (lowercase in all_sku)
  item_group?: string | null;
  sub_group?: string | null;
}

export interface BomProcessOption {
  process_name: string;
  stage?: string | null;                // the slug most BOMs store for this name
  boms: number;                         // how many BOMs use it — the ranking key
}

export async function searchBomMaterials(
  q: string,
  opts: { item_type?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<BomMaterialOption[]> {
  const t = q.trim();
  if (!t) return [];                    // the server returns [] too; skip the round trip
  const p = new URLSearchParams({ q: t });
  if (opts.item_type) p.set("item_type", opts.item_type);
  if (opts.limit != null) p.set("limit", String(opts.limit));
  const res = await apiFetch(`${BASE}/lookups/materials?${p}`, { signal });
  if (!res.ok) throw new Error(await readApiErrorMessage(res, `Material lookup HTTP ${res.status}`));
  return ((await res.json()) as { results?: BomMaterialOption[] }).results ?? [];
}

export async function searchBomProcesses(q: string, signal?: AbortSignal): Promise<BomProcessOption[]> {
  const p = new URLSearchParams();
  if (q.trim()) p.set("q", q.trim());
  const res = await apiFetch(`${BASE}/lookups/processes?${p}`, { signal });
  if (!res.ok) throw new Error(await readApiErrorMessage(res, `Process lookup HTTP ${res.status}`));
  return ((await res.json()) as { results?: BomProcessOption[] }).results ?? [];
}
