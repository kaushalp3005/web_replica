// BOM module API surface. Typed wrappers over the standalone BOM router at
// server_replica/app/modules/bom/router.py, backed by
// server_replica/app/modules/bom/services/bom_aggregate_service.py.
//
// The `/api/v1` prefix is NOT applied centrally — main.py calls
// `app.include_router(bom_router)` with no kwargs, so the prefix lives on the
// router itself (`APIRouter(prefix="/api/v1/bom")`). The full paths below are
// therefore the literal wire paths; do not strip or re-add a prefix here.
//
//   GET /api/v1/bom/aggregate    → { results: BomAggregateRow[], pagination: {...} }
//   GET /api/v1/bom/{bom_id}     → { header, lines, route, counts }   (404 if absent)
//
// Both endpoints are gated on the ('bom', NULL, NULL, 'view') permission seeded
// by app/db/095_bom_module_rbac.sql — a 403 here means the migration has not
// been deployed, or the caller's role lacks the grant.
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
