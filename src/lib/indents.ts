// Indent API surface — covers BOTH indent families that the Production
// Indents sub-module (/modules/production/prod-indents) puts side by side as
// two tabs. They are separate tables, separate lifecycles and separate
// permission trees; only the screen is shared.
//
//   A) production_indent — FG/SFG, maker-checker.
//      Table: server_replica/app/db/ims_new_schema.sql:8
//      Service: app/modules/production/services/production_indent_service.py
//      Routes: server_replica/app/modules/production/router.py:3597+
//        GET  /production-indents                  (list, paginated)
//        GET  /production-indents/{indent_id}
//        POST /production-indents                  (create)
//        PUT  /production-indents/{id}/submit|approve|return|cancel
//        POST /production-indents/{id}/create-internal-order
//
//   B) purchase_indent — RM/PM shortage → Purchase.
//      Table: app/db/production_schema.sql:588 + columns added by
//             app/db/production_migrate.sql (see PurchaseIndentRow).
//      Service: app/modules/production/services/indent_manager.py
//      Routes: server_replica/app/modules/production/router.py:1182+
//        GET  /indents                             (list, paginated)
//        GET  /indents/{indent_id}
//        PUT  /indents/{id}                        (edit draft)
//        PUT  /indents/{id}/send|acknowledge|link-po
//
// Both list endpoints return { results, pagination: { page, page_size, total,
// total_pages } }, BUT the two disagree on the empty case: production-indents
// floors total_pages at 1 (service :65 `max(1, …)`), purchase indents return 0
// (router.py:1248 `… if total else 0`). Callers must not assume >= 1.
//
// IDENTITY FIELDS ARE SERVER-DERIVED — DELIBERATELY ABSENT FROM REQUEST BODIES.
// production_indent.maker_user / checker_user and purchase_indent.acknowledged_by
// are filled server-side from the authenticated user (AuthUser.full_name, see
// app/modules/auth/middleware.py:38). They used to be client-supplied strings,
// which made maker-checker segregation decorative — any authenticated caller
// could post someone else's name as both maker AND checker. Never add them back
// to ProductionIndentCreateBody / the approve/return/acknowledge payloads; they
// are read-only row fields only.

import { apiFetch, readApiErrorMessage } from "./auth";

// ── Row shapes ───────────────────────────────────────────────────────────

// production_indent — all 24 columns (ims_new_schema.sql:8-34). NUMERIC(12,2)
// columns arrive from asyncpg as JSON numbers today but are widened to
// `number | string` for the same reason plans.ts does: a driver/serialiser
// change turning them into strings must not break the UI.
export interface ProductionIndentRow {
  id: number;
  prod_indent_id: string;                 // PRDI-YYYYMMDD-SEQ — the id used by every route
  item_description?: string | null;
  item_category?: string | null;
  sub_category?: string | null;
  material_type?: "FG" | "SFG" | string | null;   // CHECK IN ('FG','SFG')
  uom?: string | null;                    // defaults 'kg'
  required_qty?: number | string | null;
  available_qty?: number | string | null;
  shortfall_qty?: number | string | null;
  triggered_by_job_card?: string | null;
  triggered_by_so?: string | null;        // participates in the duplicate check
  customer_name?: string | null;
  maker_user?: string | null;             // server-derived on create — read-only here
  checker_user?: string | null;           // server-derived on approve/return — read-only here
  checker_comment?: string | null;        // why it was returned / approved
  status?:
    | "draft" | "submitted" | "approved"
    | "internal_jc_created" | "fulfilled" | "cancelled"
    | string | null;
  linked_internal_order?: string | null;  // INT-ORD-… set by create-internal-order
  linked_internal_jc?: string | null;     // IJC-… set by create-internal-order
  entity?: "cfpl" | "cdpl" | string | null;
  created_at?: string | null;
  approved_at?: string | null;
  fulfilled_at?: string | null;
  cancel_reason?: string | null;
  [k: string]: unknown;
}

// purchase_indent — the ACTUAL 29 live columns, not just the base CREATE TABLE.
// Base table is production_schema.sql:589-601 (cols 1-13); everything below the
// `entity`/`created_at` pair was added later by production_migrate.sql and the
// line numbers are noted per field. NUMERIC(15,3) → widened to number | string.
//
// NOTE there is NO check constraint on `status` — any string can be stored, so
// treat PURCHASE_INDENT_STATUSES as the observed vocabulary, not a guarantee.
export interface PurchaseIndentRow {
  indent_id: number;                      // SERIAL PK — the id used by every route
  indent_number?: string | null;          // TEXT UNIQUE
  material_sku_name?: string | null;      // the RM/PM article
  required_qty_kg?: number | string | null;
  required_by_date?: string | null;       // DATE, YYYY-MM-DD
  priority?: number | null;               // INT, default 5
  plan_line_id?: number | null;           // FK → production_plan_line
  po_reference?: string | null;           // set by link-po
  status?:
    | "draft" | "raised" | "acknowledged" | "po_created"
    | "received" | "cancelled"
    | string | null;
  acknowledged_by?: string | null;        // server-derived on acknowledge — read-only here
  acknowledged_at?: string | null;
  entity?: "cfpl" | "cdpl" | string | null;   // the table's ONLY check constraint
  created_at?: string | null;
  // ── added by production_migrate.sql:202-204 (store-rejection tracking) ──
  store_allocation_id?: number | null;
  job_card_id?: number | null;
  indent_source?: string | null;          // 'mrp' (default) | 'auto_shortfall' | 'force_reassign' | …
  // ── added by production_migrate.sql:213-218 (inventory-production integration) ──
  customer_name?: string | null;
  so_reference?: string | null;           // always NULL for Android-raised indents (create_indent omits it)
  triggered_by_batch?: string | null;
  shortfall_qty_kg?: number | string | null;
  cascade_from_indent_id?: number | null; // parent indent when this one was cascaded
  cascade_reason?: string | null;
  // ── added by production_migrate.sql:311-313 ──
  cancelled_at?: string | null;
  cancelled_reason?: string | null;
  cascade_event_id?: number | null;
  // ── added by production_migrate.sql:385-388 (store allocation tracking) ──
  allocated_qty_kg?: number | string | null;
  allocated_by?: string | null;
  allocated_at?: string | null;
  insufficient_reason?: string | null;
  [k: string]: unknown;
}

// GET /indents/{indent_id} adds this only when plan_line_id is non-null.
export type PurchaseIndentDetail = PurchaseIndentRow & {
  plan_line?: {
    fg_sku_name?: string | null;
    customer_name?: string | null;
    planned_qty_kg?: number | string | null;
  } | null;
};

export interface IndentPagination {
  page?: number;
  page_size?: number;
  total?: number;
  // Purchase indents return 0 for an empty result set; production indents
  // floor at 1. Never rely on >= 1.
  total_pages?: number;
}

export interface ProductionIndentListResponse {
  results?: ProductionIndentRow[];
  pagination?: IndentPagination;
}

export interface PurchaseIndentListResponse {
  results?: PurchaseIndentRow[];
  pagination?: IndentPagination;
}

// ── Listing query ───────────────────────────────────────────────────────
//
// Both endpoints accept the same param names (entity, status, search,
// date_from, date_to, page, page_size) so one filter bar drives both tabs.
// ONE asymmetry: GET /indents splits `status` on commas into an IN (…)
// (router.py:1207), while GET /production-indents does a plain `status = $n`
// (production_indent_service.py:33). Keep `status` a single value unless the
// caller knows it is targeting the purchase tab.
//
// date_from / date_to filter on created_at; date_to is inclusive of the whole
// day on both sides (`::date + interval '1 day'`).

export interface IndentFilters {
  entity?: string;
  status?: string;            // single value; comma-joined multi only works on the purchase tab
  search?: string;
  date_from?: string;         // YYYY-MM-DD
  date_to?: string;           // YYYY-MM-DD, inclusive
  page?: number;
  page_size?: number;
}

function buildIndentParams(f: IndentFilters & { source?: string }): URLSearchParams {
  const p = new URLSearchParams();
  if (f.entity) p.set("entity", f.entity);
  if (f.status) p.set("status", f.status);
  if (f.source) p.set("source", f.source);
  if (f.search) p.set("search", f.search);
  if (f.date_from) p.set("date_from", f.date_from);
  if (f.date_to) p.set("date_to", f.date_to);
  if (f.page != null) p.set("page", String(f.page));
  if (f.page_size != null) p.set("page_size", String(f.page_size));
  return p;
}

// ── Errors ───────────────────────────────────────────────────────────────

// POST /production-indents answers 409 when an OPEN indent already exists for
// the same item_description + triggered_by_so (service :88-95). The operator
// must change the item or the SO, so the page surfaces this INLINE in the
// create form rather than as a toast. The server sends a string detail
// ("Open indent already exists: PRDI-…"), so the offending id is only inside
// the message — there is no machine-readable field for it. `message` carries
// the server sentence for callers that do not branch on the class.
export class ProductionIndentDuplicateError extends Error {
  constructor(message: string, public body: unknown = null) {
    super(message);
    this.name = "ProductionIndentDuplicateError";
  }
}

// ── production_indent (FG/SFG) calls ─────────────────────────────────────

export async function listProductionIndents(
  f: IndentFilters,
  signal?: AbortSignal,
): Promise<ProductionIndentListResponse> {
  const res = await apiFetch(
    `/api/v1/production/production-indents?${buildIndentParams(f)}`,
    { signal },
  );
  if (!res.ok) {
    // Surface the server's actual message ({message,error,detail} envelope) so
    // the UI shows the real cause instead of a generic HTTP code.
    // readApiErrorMessage handles non-JSON bodies and the fallback in one place.
    throw new Error(await readApiErrorMessage(res, `Production indents HTTP ${res.status}`));
  }
  return (await res.json()) as ProductionIndentListResponse;
}

// `id` is the prod_indent_id (PRDI-…), though the server also accepts the
// numeric surrogate id as text (service :73 `prod_indent_id = $1 OR id::text = $1`).
export async function getProductionIndent(
  id: string,
  signal?: AbortSignal,
): Promise<ProductionIndentRow> {
  const res = await apiFetch(
    `/api/v1/production/production-indents/${encodeURIComponent(id)}`,
    { signal },
  );
  if (res.status === 404) throw new Error("Production indent not found.");
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res, `Production indent HTTP ${res.status}`));
  }
  return (await res.json()) as ProductionIndentRow;
}

// maker_user is intentionally NOT here — the server stamps it from the
// authenticated user. See the identity note at the top of this file.
export interface ProductionIndentCreateBody {
  item_description: string;
  material_type?: "FG" | "SFG" | string;   // server default 'FG'
  uom?: string;                            // server default 'kg'
  required_qty: number;
  available_qty?: number;
  shortfall_qty?: number;
  triggered_by_job_card?: string | null;
  triggered_by_so?: string | null;         // set ⇒ the duplicate check runs
  customer_name?: string | null;
  status?: string;                         // server default 'draft'
  entity?: string;                         // server default 'cfpl'
}

export async function createProductionIndent(
  body: ProductionIndentCreateBody,
): Promise<{ prod_indent_id: string; status: string }> {
  const res = await apiFetch(`/api/v1/production/production-indents`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (res.status === 409) {
    // Branch BEFORE !res.ok so the create form can render this beside the
    // item / SO fields instead of in the generic error slot.
    const msg = await readApiErrorMessage(res, "An open indent already exists for this item and SO.");
    throw new ProductionIndentDuplicateError(msg);
  }
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res, `Create production indent HTTP ${res.status}`));
  }
  return (await res.json()) as { prod_indent_id: string; status: string };
}

// ── Transitions (draft → submitted → approved → internal_jc_created) ─────
//
// All four return { updated: boolean } with HTTP 200 — the UPDATE carries a
// status guard in its WHERE clause, so `updated: false` means the row was NOT
// in the expected state (or does not exist; the two are indistinguishable).
// Treat false as a STALE VIEW: tell the operator the indent is no longer in the
// expected state and refetch the list. It is NOT an error and must not be
// thrown.

export interface IndentTransitionResult {
  updated: boolean;
}

async function putTransition(
  path: string,
  fallback: string,
  body?: unknown,
): Promise<IndentTransitionResult> {
  const res = await apiFetch(path, {
    method: "PUT",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res, `${fallback} HTTP ${res.status}`));
  }
  return (await res.json()) as IndentTransitionResult;
}

// draft → submitted.
export async function submitProductionIndent(id: string): Promise<IndentTransitionResult> {
  return putTransition(
    `/api/v1/production/production-indents/${encodeURIComponent(id)}/submit`,
    "Submit indent",
  );
}

// submitted → approved. checker_user is server-derived; only the comment is sent.
export async function approveProductionIndent(
  id: string,
  checker_comment: string,
): Promise<IndentTransitionResult> {
  return putTransition(
    `/api/v1/production/production-indents/${encodeURIComponent(id)}/approve`,
    "Approve indent",
    { checker_comment },
  );
}

// submitted → draft (sent back to the maker). checker_user is server-derived.
export async function returnProductionIndent(
  id: string,
  checker_comment: string,
): Promise<IndentTransitionResult> {
  return putTransition(
    `/api/v1/production/production-indents/${encodeURIComponent(id)}/return`,
    "Return indent",
    { checker_comment },
  );
}

// Any non-terminal status → cancelled. Refused (updated:false) once the indent
// is fulfilled or already cancelled.
export async function cancelProductionIndent(
  id: string,
  cancel_reason: string,
): Promise<IndentTransitionResult> {
  return putTransition(
    `/api/v1/production/production-indents/${encodeURIComponent(id)}/cancel`,
    "Cancel indent",
    { cancel_reason },
  );
}

// approved → internal_jc_created. Spawns an internal order + internal job card.
// Unlike the transitions above this one is a POST and DOES fail loudly: a wrong
// state comes back as 400 "Indent not found or not in approved status"
// (router.py:3705), not as { updated: false }. bom_found=false means the JC was
// created without a BOM match — surface it, it is not a failure.
export interface CreateInternalOrderResult {
  internal_order_id: string;
  internal_jc_id: string;
  bom_found: boolean;
}

export async function createInternalOrder(id: string): Promise<CreateInternalOrderResult> {
  const res = await apiFetch(
    `/api/v1/production/production-indents/${encodeURIComponent(id)}/create-internal-order`,
    { method: "POST" },
  );
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res, `Create internal order HTTP ${res.status}`));
  }
  return (await res.json()) as CreateInternalOrderResult;
}

// ── purchase_indent (RM/PM) calls ────────────────────────────────────────

// `source` maps to the indent_source column ('mrp' | 'auto_shortfall' |
// 'force_reassign' | …) and is purchase-only — the production tab has no
// equivalent, which is why it is not part of IndentFilters.
export async function listPurchaseIndents(
  f: IndentFilters & { source?: string },
  signal?: AbortSignal,
): Promise<PurchaseIndentListResponse> {
  const res = await apiFetch(`/api/v1/production/indents?${buildIndentParams(f)}`, { signal });
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res, `Purchase indents HTTP ${res.status}`));
  }
  return (await res.json()) as PurchaseIndentListResponse;
}

export async function getPurchaseIndent(
  id: number,
  signal?: AbortSignal,
): Promise<PurchaseIndentDetail> {
  const res = await apiFetch(`/api/v1/production/indents/${id}`, { signal });
  if (res.status === 404) throw new Error("Indent not found.");
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res, `Purchase indent HTTP ${res.status}`));
  }
  return (await res.json()) as PurchaseIndentDetail;
}

// Draft-only edit — the server refuses anything else with the `not_draft` code.
// Every field is optional; only the ones supplied are written (the service
// builds the SET clause from the non-null args) and it errors with `no_fields`
// when nothing is sent, so undefined/empty keys are trimmed here first.
export interface PurchaseIndentEditBody {
  required_qty_kg?: number;
  required_by_date?: string;   // YYYY-MM-DD
  priority?: number;           // lower = more urgent; DB default 5
}

export async function editPurchaseIndent(
  id: number,
  patch: PurchaseIndentEditBody,
): Promise<unknown> {
  // Drop undefined / empty keys so they aren't serialised as null — the server
  // treats a null field as "not supplied", but a cleaner wire is friendlier in
  // logs and request inspectors.
  const trimmed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined && v !== "") trimmed[k] = v;
  }
  if (Object.keys(trimmed).length === 0) throw new Error("Nothing to update");
  const res = await apiFetch(`/api/v1/production/indents/${id}`, {
    method: "PUT",
    body: JSON.stringify(trimmed),
  });
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res, `Edit indent HTTP ${res.status}`));
  }
  return await res.json();
}

// draft → raised. Fans out two store_alerts (purchase + stores) and emits the
// `indent.sent` webhook event, so this is the point of no return for a draft.
export async function sendPurchaseIndent(id: number): Promise<unknown> {
  const res = await apiFetch(`/api/v1/production/indents/${id}/send`, { method: "PUT" });
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res, `Send indent HTTP ${res.status}`));
  }
  return await res.json();
}

// raised → acknowledged. acknowledged_by / acknowledged_at are stamped
// server-side from the authenticated user — there is no request body.
export async function acknowledgePurchaseIndent(id: number): Promise<unknown> {
  const res = await apiFetch(`/api/v1/production/indents/${id}/acknowledge`, { method: "PUT" });
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res, `Acknowledge indent HTTP ${res.status}`));
  }
  return await res.json();
}

// acknowledged → po_created. po_reference is free text (the PO number).
export async function linkPurchaseIndentToPo(
  id: number,
  po_reference: string,
): Promise<unknown> {
  const ref = po_reference.trim();
  if (!ref) throw new Error("PO reference is required");
  const res = await apiFetch(`/api/v1/production/indents/${id}/link-po`, {
    method: "PUT",
    body: JSON.stringify({ po_reference: ref }),
  });
  if (!res.ok) {
    throw new Error(await readApiErrorMessage(res, `Link PO HTTP ${res.status}`));
  }
  return await res.json();
}

// ── Status vocabularies ──────────────────────────────────────────────────
//
// The two families do NOT share a lifecycle — do not merge these lists or
// reuse one tab's badge map for the other.
//
//   production_indent is MAKER-CHECKER: the maker drafts and submits, a
//   different-permission checker approves (→ internal order + internal JC) or
//   returns it to draft with a comment. Enforced by a DB check constraint
//   (ims_new_schema.sql:26), so these six are exhaustive:
//     draft → submitted → approved → internal_jc_created → fulfilled
//                                                       (+ cancelled anytime)
//
//   purchase_indent is RAISE → ACKNOWLEDGE → PO: the shortage is raised (by
//   MRP, the auto-shortfall cascade, or the Android app), purchase
//   acknowledges it, then links the PO. There is NO check constraint on the
//   column, so this list is the observed vocabulary, not a guarantee — always
//   keep a fallback style for unknown values.
//     draft → raised → acknowledged → po_created → received
//                                                (+ cancelled)
//   NOTE `draft` is currently a dead end: the only writer that produces it
//   (indent_manager.generate_draft_indents) has zero callers, so every live row
//   starts at `raised`. Edit and Send therefore apply to no existing data yet —
//   render those actions, but expect them to be inert until drafts exist.

export const PRODUCTION_INDENT_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "internal_jc_created",
  "fulfilled",
  "cancelled",
] as const satisfies readonly string[];

export const PURCHASE_INDENT_STATUSES = [
  "draft",
  "raised",
  "acknowledged",
  "po_created",
  "received",
  "cancelled",
] as const satisfies readonly string[];

export type ProductionIndentStatus = (typeof PRODUCTION_INDENT_STATUSES)[number];
export type PurchaseIndentStatus = (typeof PURCHASE_INDENT_STATUSES)[number];

// ── Display helpers ──────────────────────────────────────────────────────
//
// Shared by the table and the detail drawer so the two never disagree on how a
// status or a quantity reads.

// Human label for a status from either family. Falls back to de-snake-casing
// the raw value so an unmodelled status still renders as words.
export function indentStatusLabel(status?: string | null): string {
  if (!status) return "—";
  const s = String(status).toLowerCase();
  const labels: Record<string, string> = {
    // production_indent
    draft: "Draft",
    submitted: "Submitted",
    approved: "Approved",
    internal_jc_created: "Internal JC created",
    fulfilled: "Fulfilled",
    cancelled: "Cancelled",
    // purchase_indent
    raised: "Raised",
    acknowledged: "Acknowledged",
    po_created: "PO created",
    received: "Received",
  };
  return labels[s] ?? s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

// True once the record can no longer move — used to hide lifecycle actions.
export function isIndentTerminal(status?: string | null): boolean {
  const s = (status || "").toLowerCase();
  return s === "fulfilled" || s === "cancelled" || s === "received";
}

// NUMERIC columns can arrive as numbers or strings; both render the same.
export function fmtIndentQty(v: number | string | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = typeof v === "number" ? v : parseFloat(v);
  if (Number.isNaN(n)) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 3 });
}

export function fmtIndentDate(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  } catch {
    return iso;
  }
}

export function fmtIndentDateTime(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
