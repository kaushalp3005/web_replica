// ── Vendor Management · API client (web port) ──
//
// TypeScript port of the Electron renderer's
// frontend_replica/src/modules/purchase/vendor-management/lib/vendor-api.js.
// Runs on the shared `apiFetch` (bearer + silent refresh) and the same-origin
// `/api/v1/...` proxy declared in next.config.ts.
//
// Backend error envelopes seen here:
//   • FastAPI HTTPException(detail={code, msg, ...})  — vendor routes
//   • request_context middleware {error, message, …}  — unhandled paths
// `readVendorError` reads both; `VendorApiError` carries the `code` so the
// wizard can branch to friendly toasts (too_many_files, file_too_large, …).

import { apiFetch } from "./auth";

const VENDORS_PATH = "/api/v1/vendors";
const LOOKUPS_PATH = "/api/v1/lookups";

// ── Hardcoded enums (no API needed) — mirror vendor-api.js ENUMS ──
export const VENDOR_STATUS = [
  { code: "active", label: "Active" },
  { code: "inactive", label: "Inactive" },
  { code: "blacklisted", label: "Blacklisted" },
] as const;

export const DOC_TYPE = [
  { code: "FSSAI", label: "FSSAI" },
  { code: "BRC", label: "BRC" },
  { code: "PAN", label: "PAN" },
  { code: "GST", label: "GST" },
  { code: "MSME", label: "MSME" },
  { code: "UDYAM", label: "UDYAM" },
  { code: "IEC", label: "IEC" },
  { code: "EPR", label: "EPR" },
  { code: "CIN", label: "CIN" },
  { code: "TIN", label: "TIN" },
  { code: "TAN", label: "TAN" },
  { code: "POLLUTION", label: "Pollution" },
  { code: "CONTRACT", label: "Contract" },
  { code: "OTHER", label: "Other" },
] as const;

export const CONTRACT_TYPE = [
  { code: "yearly", label: "Yearly" },
  { code: "one-time", label: "One-time" },
  { code: "NDA", label: "NDA" },
  { code: "MSA", label: "MSA" },
] as const;

export const UPLOAD_ACCEPT = "application/pdf,image/jpeg,image/png";
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024; // 25 MB — mirrors backend cap
export const MAX_FILES = 20; // per-batch cap — mirrors the backend _MAX_DOCS_PER_REQUEST
const UPLOAD_MIMES = ["application/pdf", "image/jpeg", "image/png"];

// ── Types ────────────────────────────────────────────────────────────────

export interface LookupRow {
  lookup_id: string;
  lookup_type?: string;
  code?: string | null;
  label?: string | null;
  parent_lookup_id?: string | null;
  display_order?: number | null;
  is_active?: boolean;
}

// Vendor master fields the wizard collects. Everything except `name` is
// optional/nullable — mirrors VendorBase on the backend.
export interface VendorBody {
  supplier_code?: string | null;
  supplier_reg_year?: string | null;
  name: string;
  status?: string;
  supplier_type_id?: string | null;
  firm_status_id?: string | null;
  business_type_id?: string | null;
  category_code_id?: string | null;
  sub_category?: string | null;
  local_os_id?: string | null;
  msme_type_id?: string | null;
  scoc_status_id?: string | null;
  kyc_status_id?: string | null;
  doc_status_id?: string | null;
  // Free-text companions — set only when the matching *_id select is "Others".
  supplier_type_other?: string | null;
  firm_status_other?: string | null;
  business_type_other?: string | null;
  core_business?: string | null;
  contact_person?: string | null;
  designation?: string | null;
  phone_company?: string | null;
  mobile?: string | null;
  email?: string | null;
  website?: string | null;
  address_line?: string | null;
  state?: string | null;
  city?: string | null;
  pin_code?: string | null;
  fssai_no?: string | null;
  brc_other?: string | null;
  cin_no?: string | null;
  pan_no?: string | null;
  gstn?: string | null;
  iec_no?: string | null;
  pollution_epr?: string | null;
  tin_tan?: string | null;
  is_msme?: boolean;
  msme_registration_date?: string | null;
  uam_udyam_no?: string | null;
  business_turnover_3y?: string | null;
  capabilities?: string | null;
  remarks?: string | null;
  reference?: string | null;
}

export interface StagedBankingItem {
  bank_name: string;
  account_no: string;
  account_name: string;
  branch?: string | null;
  ifsc?: string | null;
  swift?: string | null;
  account_type_id?: string | null;
  is_primary?: boolean;
  is_active?: boolean;
  valid_from?: string | null;
  valid_to?: string | null;
}

export interface StagedDocumentItem {
  s3_url?: string | null;
  doc_type: string;
  doc_number?: string | null;
  issued_on?: string | null;
  valid_from?: string | null;
  valid_to?: string | null;
}

export interface StagedContractItem {
  s3_url?: string | null;
  contract_type?: string | null;
  signed_date?: string | null;
  effective_from?: string | null;
  effective_to?: string | null;
  value_inr?: number | null;
  scoc_signed?: boolean;
  auto_renew?: boolean;
}

// ExtractBulkResponse — free-form per-tab suggestions keyed by staging_id.
export interface ExtractBulkResult {
  staging_id: string;
  vendor_fields: Record<string, unknown>;
  banking_fields: Record<string, unknown>[];
  documents: ExtractedDocRow[];
  contracts: Record<string, unknown>[];
  conflicts: ExtractConflict[];
  failures: ExtractFailure[];
}

export interface ExtractedDocRow {
  doc_type?: string | null;
  doc_number?: string | null;
  s3_url?: string | null;
  issued_on?: string | null;
  valid_from?: string | null;
  valid_to?: string | null;
  extraction_status?: string | null;
  extraction_error?: string | null;
  [k: string]: unknown;
}

export interface ExtractConflict {
  field: string;
  values_seen?: string[];
  sources?: string[];
}

export interface ExtractFailure {
  // Positional index into the uploaded files[] — set by the backend when an S3
  // upload fails, so the UI can mark the right queue row as failed.
  index?: number;
  doc_type?: string | null;
  filename?: string | null;
  error?: string | null;
}

export interface SubmitStagedBody {
  staging_id?: string | null;
  vendor: VendorBody;
  banking: StagedBankingItem[];
  documents: StagedDocumentItem[];
  contracts: StagedContractItem[];
}

export type VendorStatus = "active" | "inactive" | "blacklisted";

// Full vendor row. Mirrors VendorResponse (VendorBase columns + audit fields);
// the backend's extra="allow" means the row also carries every other
// vendor_master column, hence the index signature.
export interface VendorResponse {
  vendor_id: string;
  supplier_code: string;
  name: string;
  status: VendorStatus;
  approved_by?: string | null;
  approved_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  is_deleted?: boolean;
  [k: string]: unknown;
}

// Mirrors BankingResponse (extra="allow").
export interface BankingResponse {
  bank_id: string;
  vendor_id: string;
  bank_name: string;
  account_no: string;
  account_name: string;
  is_primary: boolean;
  is_active: boolean;
  [k: string]: unknown;
}

// Mirrors DocumentResponse (extra="allow"). `s3_urls` is a comma-separated CSV.
export interface DocumentResponse {
  doc_id: string;
  vendor_id: string;
  doc_type: string;
  doc_number?: string | null;
  s3_urls: string;
  issued_on?: string | null;
  valid_from?: string | null;
  valid_to?: string | null;
  status_id?: string | null;
  uploaded_by?: string | null;
  uploaded_at?: string | null;
  [k: string]: unknown;
}

// Mirrors ContractResponse (extra="allow").
export interface ContractResponse {
  contract_id: string;
  vendor_id: string;
  contract_type?: string | null;
  signed_date?: string | null;
  effective_from?: string | null;
  effective_to?: string | null;
  s3_urls: string;
  scoc_signed: boolean;
  value_inr?: number | null;
  auto_renew: boolean;
  created_by?: string | null;
  created_at?: string | null;
  [k: string]: unknown;
}

// POST /submit-staged result — mirrors SubmitStagedResponse.
export interface SubmitStagedResult {
  vendor: VendorResponse;
  banking: BankingResponse[];
  documents: DocumentResponse[];
  contracts: ContractResponse[];
}

// POST /with-documents result — mirrors VendorWithDocumentsResponse. The vendor
// commits first; `documents` holds the rows that saved (each wrapping the saved
// row + its extracted fields), `failures` lists per-file upload/extract errors.
export interface DocumentUploadResponse {
  document: DocumentResponse;
  extracted: ExtractedDocRow;
}
export interface DocumentUploadFailure {
  doc_type: string;
  filename?: string | null;
  error: string;
}
export interface VendorWithDocumentsResponse {
  vendor: VendorResponse;
  documents: DocumentUploadResponse[];
  failures: DocumentUploadFailure[];
}

// ── List / search shapes (existing-vendors page) ──────────────────────────
// Mirror VendorCounts / VendorListRow / VendorListResponse / VendorSearchResponse.

export interface VendorCounts {
  documents: number;
  contracts: number;
  banking: number;
}

// Enriched row returned by the list + search endpoints. Extends the full
// vendor row with the three server-computed fields the table renders on:
// `is_approved` (collapses approved_by/approved_at), `has_primary_banking`
// (the approval pre-condition), and per-vendor sub-row `counts`.
export interface VendorListRow extends VendorResponse {
  is_approved: boolean;
  has_primary_banking: boolean;
  counts: VendorCounts;
}

// GET /vendors/paged (and /vendors) — paginated, page_size pinned to 200 on /paged.
export interface VendorListResponse {
  vendors: VendorListRow[];
  total: number;
  page: number;
  page_size: number;
}

// GET /vendors/search — one round-trip, no pagination. `truncated=true` means
// the query hit the server's 1000-row hard cap before exhausting matches.
export interface VendorSearchResponse {
  vendors: VendorListRow[];
  total_returned: number;
  truncated: boolean;
}

export type ApprovalFilter = "approved" | "pending";

// ── Error type ─────────────────────────────────────────────────────────────

export class VendorApiError extends Error {
  code: string | null;
  status: number;
  context: Record<string, unknown>;
  constructor(status: number, code: string | null, message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = "VendorApiError";
    this.status = status;
    this.code = code;
    this.context = context;
  }
}

async function readVendorError(res: Response, fallback: string): Promise<VendorApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  const b = (body ?? {}) as Record<string, unknown>;

  // The backend's request_context middleware renders EVERY non-2xx response as
  //   { error, message, request_id, timestamp, details }
  // Router handlers raise HTTPException(detail={ code, msg, ... }); the middleware
  // promotes that dict into `details` — so the specific machine code lands at
  // details.code (NOT top-level `error`, which is only the generic status code
  // like "bad_request"), and 422s carry details.errors = [{ loc, msg, ... }].
  // We read all of that so callers can branch on the specific code (see the
  // wizard's byCode toasts) and show field-level validation messages.
  const details =
    b.details && typeof b.details === "object" && !Array.isArray(b.details)
      ? (b.details as Record<string, unknown>)
      : {};

  // Prefer the router's specific code (details.code) over the envelope's generic one.
  const code =
    (typeof details.code === "string" && details.code) ||
    (typeof b.error === "string" && b.error) ||
    null;

  // Message priority: field-level validation errors > router's own msg > envelope message.
  let message: string | null = null;
  const errs = details.errors;
  if (Array.isArray(errs) && errs.length) {
    message = errs
      .map((e) => {
        const rec = (e ?? {}) as Record<string, unknown>;
        const loc = Array.isArray(rec.loc) ? rec.loc.filter((p) => p !== "body").join(".") : "";
        const m = typeof rec.msg === "string" ? rec.msg : "";
        return loc ? `${loc}: ${m}` : m;
      })
      .filter(Boolean)
      .join("; ");
  }
  if (!message && typeof details.msg === "string" && details.msg) message = details.msg;
  if (!message && typeof b.message === "string" && b.message) message = b.message;

  // Defensive: tolerate a raw FastAPI shape ({ detail }) in case a path bypasses
  // the envelope middleware.
  if (!message) {
    const detail = b.detail;
    if (typeof detail === "string" && detail) message = detail;
    else if (detail && typeof detail === "object" && !Array.isArray(detail)) {
      const d = detail as Record<string, unknown>;
      message =
        (typeof d.msg === "string" && d.msg) ||
        (typeof d.message === "string" && d.message) ||
        null;
    }
  }

  return new VendorApiError(res.status, code, message || `${fallback} (HTTP ${res.status})`, details);
}

// ── Lookups (module-scoped cache — dropdown sources) ──
const _lookupCache = new Map<string, LookupRow[]>();
const _lookupInflight = new Map<string, Promise<LookupRow[]>>();

export async function getLookups(type: string): Promise<LookupRow[]> {
  if (!type) return [];
  const cached = _lookupCache.get(type);
  if (cached) return cached;
  const inflight = _lookupInflight.get(type);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      const res = await apiFetch(`${LOOKUPS_PATH}?type=${encodeURIComponent(type)}`);
      if (!res.ok) throw await readVendorError(res, `Failed to load ${type}`);
      const data = (await res.json()) as unknown;
      const list = Array.isArray(data) ? (data as LookupRow[]) : [];
      const filtered = list
        .filter((r) => r.is_active !== false)
        .sort((a, b) => (a.display_order ?? 999) - (b.display_order ?? 999));
      // Only cache a NON-EMPTY result. An empty array usually means the
      // lookup_value table isn't seeded (or doesn't exist yet — the backend
      // returns [] on a missing table); caching that would pin the dropdown to
      // empty for the whole SPA session, so a seed applied afterwards wouldn't
      // show until a full reload. Not caching [] lets the next call pick up the
      // seed. A genuinely-empty lookup just costs one cheap re-fetch per call.
      if (filtered.length > 0) _lookupCache.set(type, filtered);
      return filtered;
    } catch {
      // Transient failure (network / 5xx / refresh-abort): do NOT cache.
      // Returning [] lets the form render now; the next call retries.
      return [];
    } finally {
      _lookupInflight.delete(type);
    }
  })();
  _lookupInflight.set(type, p);
  return p;
}

/** Batch-load several lookup types at once. Returns a map keyed by type. */
export async function getLookupBundle(types: string[]): Promise<Record<string, LookupRow[]>> {
  const uniq = [...new Set(types)];
  const rows = await Promise.all(uniq.map((t) => getLookups(t).then((r) => [t, r] as const)));
  return Object.fromEntries(rows);
}

// ── Phase 1: extract-bulk ──
export async function extractBulk(
  files: File[],
  docsMeta: { doc_type?: string }[],
  opts: { signal?: AbortSignal } = {},
): Promise<ExtractBulkResult> {
  const fd = new FormData();
  fd.append("docs_meta", JSON.stringify(docsMeta || []));
  files.forEach((f) => fd.append("files", f, f.name));
  const res = await apiFetch(`${VENDORS_PATH}/extract-bulk`, { method: "POST", body: fd, signal: opts.signal });
  if (!res.ok) throw await readVendorError(res, "Extraction failed");
  return res.json();
}

// ── Phase 2: submit-staged ──
export async function submitStagedVendor(body: SubmitStagedBody): Promise<SubmitStagedResult> {
  const res = await apiFetch(`${VENDORS_PATH}/submit-staged`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readVendorError(res, "Couldn't create vendor");
  return res.json();
}

// ── Skip-manual fallback: combined create + per-row banking ──
export async function createVendorWithDocuments(
  vendor: VendorBody,
  files: File[],
  docsMeta: { doc_type?: string }[],
): Promise<VendorWithDocumentsResponse> {
  const fd = new FormData();
  fd.append("vendor", JSON.stringify(vendor));
  fd.append("docs_meta", JSON.stringify(docsMeta || []));
  (files || []).forEach((f) => fd.append("files", f, f.name));
  const res = await apiFetch(`${VENDORS_PATH}/with-documents`, { method: "POST", body: fd });
  if (!res.ok) throw await readVendorError(res, "Couldn't create vendor");
  return res.json();
}

export async function addBanking(vendorId: string, body: StagedBankingItem): Promise<BankingResponse> {
  const res = await apiFetch(`${VENDORS_PATH}/${encodeURIComponent(vendorId)}/banking`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readVendorError(res, "Couldn't add banking row");
  return res.json();
}

// POST /{vendor_id}/contracts — manual contract create (ContractManualCreate).
// Used by the skip-manual path to persist contract rows after the vendor exists
// (the /with-documents endpoint only accepts vendor + documents). `s3_urls` is a
// comma-separated CSV on the wire.
export interface ContractCreateBody {
  contract_type?: string | null;
  signed_date?: string | null;
  effective_from?: string | null;
  effective_to?: string | null;
  s3_urls?: string;
  value_inr?: number | null;
  scoc_signed?: boolean;
  auto_renew?: boolean;
}
export async function addContract(vendorId: string, body: ContractCreateBody): Promise<ContractResponse> {
  const res = await apiFetch(`${VENDORS_PATH}/${encodeURIComponent(vendorId)}/contracts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readVendorError(res, "Couldn't add contract");
  return res.json();
}

// ── Vendor master list / search / lifecycle (existing-vendors page) ────────

export interface VendorListParams {
  status?: string;
  category_code_id?: string;
  approval?: ApprovalFilter | string;
  page?: number;
  /** Server-side name substring (≥2 chars). Distinct from the /search endpoint. */
  search?: string;
  signal?: AbortSignal;
}

// GET /vendors/paged — page_size is pinned server-side to 200; we don't send it.
// Empty-string filters are omitted so we never send `?status=` and trip a 422.
export async function listVendorsPaged(params: VendorListParams = {}): Promise<VendorListResponse> {
  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  if (params.category_code_id) qs.set("category_code_id", params.category_code_id);
  if (params.approval) qs.set("approval", String(params.approval));
  if (params.search) qs.set("search", params.search);
  qs.set("page", String(params.page ?? 1));
  const res = await apiFetch(`${VENDORS_PATH}/paged?${qs.toString()}`, { signal: params.signal });
  if (!res.ok) throw await readVendorError(res, "Failed to load vendors");
  return res.json();
}

export interface VendorSearchParams {
  q: string;
  status?: string;
  category_code_id?: string;
  approval?: ApprovalFilter | string;
  signal?: AbortSignal;
}

// GET /vendors/search — direct DB hit, no pagination, up to 1000 rows. `q` is
// required and 2-char minimum; we early-return an empty shape below that so the
// UI never fires an empty search (matches the Electron client's guard).
export async function searchVendors(params: VendorSearchParams): Promise<VendorSearchResponse> {
  const q = (params.q || "").trim();
  if (q.length < 2) return { vendors: [], total_returned: 0, truncated: false };
  const qs = new URLSearchParams();
  qs.set("q", q);
  if (params.status) qs.set("status", params.status);
  if (params.category_code_id) qs.set("category_code_id", params.category_code_id);
  if (params.approval) qs.set("approval", String(params.approval));
  const res = await apiFetch(`${VENDORS_PATH}/search?${qs.toString()}`, { signal: params.signal });
  if (!res.ok) throw await readVendorError(res, "Search failed");
  return res.json();
}

// POST /vendors/{id}/approve — SCM-Head sign-off. 409 (ApprovalError) surfaces
// as a VendorApiError whose `code` is the specific pre-condition failure
// (e.g. no_primary_banking, kyc_incomplete).
export async function approveVendor(vendorId: string): Promise<VendorResponse> {
  const res = await apiFetch(`${VENDORS_PATH}/${encodeURIComponent(vendorId)}/approve`, { method: "POST" });
  if (!res.ok) throw await readVendorError(res, "Couldn't approve vendor");
  return res.json();
}

// DELETE /vendors/{id} — soft-delete; returns 204 No Content (no body to parse).
export async function deleteVendor(vendorId: string): Promise<void> {
  const res = await apiFetch(`${VENDORS_PATH}/${encodeURIComponent(vendorId)}`, { method: "DELETE" });
  if (!res.ok) throw await readVendorError(res, "Couldn't delete vendor");
}

/** Resolve a lookup_id to its visible label (label → code → ""). Mirrors
 *  vendor-api.js getLookupLabel — used to render the category column. */
export function getLookupLabel(rows: LookupRow[], id: string | null | undefined): string {
  if (id == null) return "";
  const row = (rows || []).find((r) => r.lookup_id === id);
  return row ? row.label || row.code || "" : "";
}

// ── Field-level helpers (mirror vendor-api.js) ──

/** IFSC: 4 letters + '0' + 6 alphanumeric (uppercase). */
export function isValidIfsc(s: string | null | undefined): boolean {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test((s || "").toUpperCase());
}

/** File type / size guard mirroring the backend 25 MB PDF/JPEG/PNG allowlist. */
export function validateUploadFile(file: File | null): string | null {
  if (!file) return "No file chosen.";
  // A 0-byte file passes the MIME check (File.type comes from the extension) but
  // the backend rejects it with `empty_file`, failing the ENTIRE extract batch —
  // reject it here with a clear per-file message instead. The browser-declared
  // MIME is advisory; the `accept` attribute + the backend's magic-byte sniff are
  // the real gate.
  if (file.size === 0) return "File is empty (0 bytes).";
  if (!UPLOAD_MIMES.includes(file.type)) return "Only PDF / JPEG / PNG are accepted.";
  if (file.size > UPLOAD_MAX_BYTES) return `File too large (${(file.size / 1048576).toFixed(1)} MB). Max is 25 MB.`;
  return null;
}

/** Coerce common Indian date formats to YYYY-MM-DD so <input type="date">
 *  accepts the value. Empty / unparseable inputs return "". */
export function normaliseISODate(v: unknown): string {
  if (!v) return "";
  const s = String(v).trim();
  let y = "";
  let m = "";
  let d = "";
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); // ISO (possibly with a time suffix)
  const dmy = s.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/); // DD/MM/YYYY or DD-MM-YYYY
  if (iso) {
    [, y, m, d] = iso;
  } else if (dmy) {
    [, d, m, y] = dmy;
  } else {
    // Fallback: let JS try a free-form string (e.g. "March 15 2024").
    const dt = new Date(s);
    if (isNaN(dt.getTime())) return "";
    y = String(dt.getFullYear());
    m = String(dt.getMonth() + 1);
    d = String(dt.getDate());
  }
  const mm = m.padStart(2, "0");
  const dd = d.padStart(2, "0");
  // Reject impossible calendar dates (2024-13-45, 2024-02-30, …) that are
  // ISO-shaped but would 422 against the backend's `date` type. `new Date` on an
  // invalid ISO date yields Invalid Date; the round-trip guard also catches any
  // engine that silently rolls overflowed values over.
  const probe = new Date(`${y}-${mm}-${dd}T00:00:00Z`);
  if (
    isNaN(probe.getTime()) ||
    probe.getUTCFullYear() !== Number(y) ||
    probe.getUTCMonth() + 1 !== Number(mm) ||
    probe.getUTCDate() !== Number(dd)
  ) {
    return "";
  }
  return `${y}-${mm}-${dd}`;
}

/** Find a lookup row whose visible label matches `label` (case-insensitive;
 *  exact wins, else substring) and return its lookup_id, or "" on no match.
 *  Mirrors _resolveLookupLabel in vendor-new.js. */
export function resolveLookupLabel(rows: LookupRow[], label: string | null | undefined): string {
  if (!rows || !label) return "";
  const needle = String(label).trim().toLowerCase();
  if (!needle) return "";
  let contains = "";
  for (const r of rows) {
    const text = String(r.label || r.code || "").trim().toLowerCase();
    if (!text) continue;
    if (text === needle) return r.lookup_id;
    if (!contains && (text.includes(needle) || needle.includes(text))) contains = r.lookup_id;
  }
  return contains;
}

// ═══════════════════════════════════════════════════════════════════════════
// Vendor Detail — read/mutate surface (port of vendor-api.js the detail screen
// uses). All under /api/v1/vendors; same apiFetch + readVendorError style as
// above. GET /{id} returns the NESTED VendorDetailResponse (vendor + child
// arrays), NOT a bare vendor row.
// ═══════════════════════════════════════════════════════════════════════════

// GET /vendors/{id} → nested payload. Mirrors backend VendorDetailResponse.
export interface VendorDetailResponse {
  vendor: VendorResponse;
  banking: BankingResponse[];
  documents: DocumentResponse[];
  contracts: ContractResponse[];
}

// PATCH /vendors/{id}. `_reason` (attached by patchVendor when a reason is
// passed) is stripped off the column patch by the backend and persisted on the
// history row. Everything is a partial column update.
export type VendorPatchBody = Partial<VendorBody> & { _reason?: string | null };

// PATCH /{id}/banking/{bankId} — any subset of the banking columns.
export type BankingPatchBody = Partial<StagedBankingItem>;

// POST /{id}/documents — manual create (JSON, no file). `s3_urls` is a CSV on the wire.
export interface DocumentCreateBody {
  doc_type: string;
  doc_number?: string | null;
  s3_urls?: string;
  issued_on?: string | null;
  valid_from?: string | null;
  valid_to?: string | null;
  status_id?: string | null;
}
export type DocumentPatchBody = Partial<DocumentCreateBody>;

// PATCH /{id}/contracts/{contractId} — reuses the contract column set.
export type ContractPatchBody = Partial<ContractCreateBody>;

// Extracted-contract row from /contracts/extract + upload-and-save (mirrors ExtractedDocRow).
export interface ExtractedContractRow {
  contract_type?: string | null;
  signed_date?: string | null;
  effective_from?: string | null;
  effective_to?: string | null;
  value_inr?: number | null;
  s3_url?: string | null;
  extraction_status?: string | null;
  extraction_error?: string | null;
  [k: string]: unknown;
}

// upload-and-save result = saved row + extracted fields (mirrors DocumentUploadResponse).
export interface ContractUploadResponse {
  contract: ContractResponse;
  extracted: ExtractedContractRow;
}

// dry-run extract result shapes (backend DocExtractResponse / ContractExtractResponse).
export interface DocExtractResponse {
  s3_url?: string | null;
  doc_type?: string | null;
  extracted: ExtractedDocRow;
}
export interface ContractExtractResponse {
  s3_url?: string | null;
  extracted: ExtractedContractRow;
}

// ── History (authoritative shape — backend HistoryEntry, extra="allow") ──
// history_id is an INT; the wire wraps entries in { entries, total, page, page_size }.
// `diff` is a per-field map whose cells carry { from, to } (the source renders
// diff[k].from / diff[k].to).
export interface VendorHistoryDiffCell {
  from?: unknown;
  to?: unknown;
  [k: string]: unknown;
}
export interface VendorHistoryEntry {
  history_id: number;
  operation: string; // create | update | approve | delete | restore | revert | set_primary | append_file
  changed_by?: string | null;
  changed_at: string;
  previous_state?: Record<string, unknown> | null;
  new_state?: Record<string, unknown> | null;
  diff?: Record<string, VendorHistoryDiffCell>;
  source?: string;
  reason?: string | null;
  [k: string]: unknown;
}
export interface VendorHistoryListResponse {
  entries: VendorHistoryEntry[];
  total: number;
  page: number;
  page_size: number;
}

// ── S3 URL helpers (s3_urls is a comma-separated CSV on the wire) ──

/** Split the CSV into a trimmed, empty-dropped array (read paths). */
export function s3UrlsToArray(s: string | null | undefined): string[] {
  return String(s || "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
}

/** Join an array back to the CSV the backend expects (empties/null dropped). */
export function s3UrlsToCsv(arr: (string | null | undefined)[]): string {
  return (arr || []).filter(Boolean).join(",");
}

/** Friendly chip label from an S3 URL: last path segment, de-querystringed,
 *  URL-decoded, truncated to 40 chars. Falls back to `fallback`. */
export function s3UrlBasename(url: string | null | undefined, fallback = "file"): string {
  try {
    const path = String(url || "").split("?")[0];
    const tail = path.split("/").filter(Boolean).pop() || "";
    const decoded = decodeURIComponent(tail);
    if (!decoded) return fallback;
    return decoded.length > 40 ? decoded.slice(0, 37) + "…" : decoded;
  } catch {
    return fallback;
  }
}

// ── Vendor master (detail) ──

// GET /vendors/{id} → { vendor, banking[], documents[], contracts[] }.
export async function getVendor(vendorId: string): Promise<VendorDetailResponse> {
  const res = await apiFetch(`${VENDORS_PATH}/${encodeURIComponent(vendorId)}`);
  if (!res.ok) throw await readVendorError(res, "Failed to load vendor");
  return res.json();
}

// PATCH /vendors/{id} — partial column update; `reason` rides as `_reason`.
export async function patchVendor(
  vendorId: string,
  patch: VendorPatchBody,
  reason?: string | null,
): Promise<VendorResponse> {
  const payload = reason ? { ...patch, _reason: reason } : patch;
  const res = await apiFetch(`${VENDORS_PATH}/${encodeURIComponent(vendorId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw await readVendorError(res, "Couldn't save vendor");
  return res.json();
}

// ── Banking ──

// GET /{id}/banking?active_only=…
export async function listBanking(vendorId: string, activeOnly = false): Promise<BankingResponse[]> {
  const res = await apiFetch(
    `${VENDORS_PATH}/${encodeURIComponent(vendorId)}/banking?active_only=${activeOnly ? "true" : "false"}`,
  );
  if (!res.ok) throw await readVendorError(res, "Failed to load banking");
  return res.json();
}

// PATCH /{id}/banking/{bankId}
export async function patchBanking(
  vendorId: string,
  bankId: string,
  patch: BankingPatchBody,
): Promise<BankingResponse> {
  const res = await apiFetch(
    `${VENDORS_PATH}/${encodeURIComponent(vendorId)}/banking/${encodeURIComponent(bankId)}`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) },
  );
  if (!res.ok) throw await readVendorError(res, "Couldn't save banking row");
  return res.json();
}

// POST /{id}/banking/{bankId}/set-primary — atomically flips is_primary.
export async function setPrimaryBanking(vendorId: string, bankId: string): Promise<BankingResponse> {
  const res = await apiFetch(
    `${VENDORS_PATH}/${encodeURIComponent(vendorId)}/banking/${encodeURIComponent(bankId)}/set-primary`,
    { method: "POST" },
  );
  if (!res.ok) throw await readVendorError(res, "Couldn't set primary bank");
  return res.json();
}

// DELETE /{id}/banking/{bankId} — 204.
export async function deleteBanking(vendorId: string, bankId: string): Promise<void> {
  const res = await apiFetch(
    `${VENDORS_PATH}/${encodeURIComponent(vendorId)}/banking/${encodeURIComponent(bankId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw await readVendorError(res, "Couldn't delete banking row");
}

// ── Documents ──

// GET /{id}/documents?doc_type=…
export async function listDocuments(vendorId: string, docType?: string): Promise<DocumentResponse[]> {
  const qs = docType ? `?doc_type=${encodeURIComponent(docType)}` : "";
  const res = await apiFetch(`${VENDORS_PATH}/${encodeURIComponent(vendorId)}/documents${qs}`);
  if (!res.ok) throw await readVendorError(res, "Failed to load documents");
  return res.json();
}

// POST /{id}/documents — manual create (JSON, no file).
export async function addDocument(vendorId: string, body: DocumentCreateBody): Promise<DocumentResponse> {
  const res = await apiFetch(`${VENDORS_PATH}/${encodeURIComponent(vendorId)}/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readVendorError(res, "Couldn't add document");
  return res.json();
}

// POST /{id}/documents/extract — upload one file, get extracted fields (nothing persisted).
export async function extractDocument(vendorId: string, file: File, docType: string): Promise<DocExtractResponse> {
  const fd = new FormData();
  fd.append("file", file, file.name);
  fd.append("doc_type", docType);
  const res = await apiFetch(`${VENDORS_PATH}/${encodeURIComponent(vendorId)}/documents/extract`, {
    method: "POST",
    body: fd,
  });
  if (!res.ok) throw await readVendorError(res, "Extraction failed");
  return res.json();
}

// POST /{id}/documents/upload-and-save — upload + extract + persist in one call.
export async function uploadAndSaveDocument(
  vendorId: string,
  file: File,
  docType: string,
  opts: { docNumber?: string; statusId?: string } = {},
): Promise<DocumentUploadResponse> {
  const fd = new FormData();
  fd.append("file", file, file.name);
  fd.append("doc_type", docType);
  if (opts.docNumber) fd.append("doc_number", opts.docNumber);
  if (opts.statusId) fd.append("status_id", opts.statusId);
  const res = await apiFetch(`${VENDORS_PATH}/${encodeURIComponent(vendorId)}/documents/upload-and-save`, {
    method: "POST",
    body: fd,
  });
  if (!res.ok) throw await readVendorError(res, "Couldn't save document");
  return res.json();
}

// POST /{id}/documents/{docId}/append-file — attach another file (appends to s3_urls CSV).
export async function appendDocumentFile(vendorId: string, docId: string, file: File): Promise<DocumentResponse> {
  const fd = new FormData();
  fd.append("file", file, file.name);
  const res = await apiFetch(
    `${VENDORS_PATH}/${encodeURIComponent(vendorId)}/documents/${encodeURIComponent(docId)}/append-file`,
    { method: "POST", body: fd },
  );
  if (!res.ok) throw await readVendorError(res, "Couldn't attach file");
  return res.json();
}

// PATCH /{id}/documents/{docId}
export async function patchDocument(
  vendorId: string,
  docId: string,
  patch: DocumentPatchBody,
): Promise<DocumentResponse> {
  const res = await apiFetch(
    `${VENDORS_PATH}/${encodeURIComponent(vendorId)}/documents/${encodeURIComponent(docId)}`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) },
  );
  if (!res.ok) throw await readVendorError(res, "Couldn't save document");
  return res.json();
}

// DELETE /{id}/documents/{docId} — 204.
export async function deleteDocument(vendorId: string, docId: string): Promise<void> {
  const res = await apiFetch(
    `${VENDORS_PATH}/${encodeURIComponent(vendorId)}/documents/${encodeURIComponent(docId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw await readVendorError(res, "Couldn't delete document");
}

// ── Contracts ──

// GET /{id}/contracts?contract_type=…
export async function listContracts(vendorId: string, contractType?: string): Promise<ContractResponse[]> {
  const qs = contractType ? `?contract_type=${encodeURIComponent(contractType)}` : "";
  const res = await apiFetch(`${VENDORS_PATH}/${encodeURIComponent(vendorId)}/contracts${qs}`);
  if (!res.ok) throw await readVendorError(res, "Failed to load contracts");
  return res.json();
}

// POST /{id}/contracts/extract — upload one file, get extracted contract fields.
export async function extractContract(vendorId: string, file: File): Promise<ContractExtractResponse> {
  const fd = new FormData();
  fd.append("file", file, file.name);
  const res = await apiFetch(`${VENDORS_PATH}/${encodeURIComponent(vendorId)}/contracts/extract`, {
    method: "POST",
    body: fd,
  });
  if (!res.ok) throw await readVendorError(res, "Extraction failed");
  return res.json();
}

// POST /{id}/contracts/upload-and-save — upload + extract + persist.
export async function uploadAndSaveContract(
  vendorId: string,
  file: File,
  opts: { contractType?: string } = {},
): Promise<ContractUploadResponse> {
  const fd = new FormData();
  fd.append("file", file, file.name);
  if (opts.contractType) fd.append("contract_type", opts.contractType);
  const res = await apiFetch(`${VENDORS_PATH}/${encodeURIComponent(vendorId)}/contracts/upload-and-save`, {
    method: "POST",
    body: fd,
  });
  if (!res.ok) throw await readVendorError(res, "Couldn't save contract");
  return res.json();
}

// POST /{id}/contracts/{contractId}/append-file
export async function appendContractFile(
  vendorId: string,
  contractId: string,
  file: File,
): Promise<ContractResponse> {
  const fd = new FormData();
  fd.append("file", file, file.name);
  const res = await apiFetch(
    `${VENDORS_PATH}/${encodeURIComponent(vendorId)}/contracts/${encodeURIComponent(contractId)}/append-file`,
    { method: "POST", body: fd },
  );
  if (!res.ok) throw await readVendorError(res, "Couldn't attach file");
  return res.json();
}

// PATCH /{id}/contracts/{contractId}
export async function patchContract(
  vendorId: string,
  contractId: string,
  patch: ContractPatchBody,
): Promise<ContractResponse> {
  const res = await apiFetch(
    `${VENDORS_PATH}/${encodeURIComponent(vendorId)}/contracts/${encodeURIComponent(contractId)}`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) },
  );
  if (!res.ok) throw await readVendorError(res, "Couldn't save contract");
  return res.json();
}

// DELETE /{id}/contracts/{contractId} — 204.
export async function deleteContract(vendorId: string, contractId: string): Promise<void> {
  const res = await apiFetch(
    `${VENDORS_PATH}/${encodeURIComponent(vendorId)}/contracts/${encodeURIComponent(contractId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw await readVendorError(res, "Couldn't delete contract");
}

// ── History ──

// GET /{id}/history?operation=&page=&page_size=
export async function listVendorHistory(
  vendorId: string,
  operation?: string,
  opts: { page?: number; pageSize?: number } = {},
): Promise<VendorHistoryListResponse> {
  const qs = new URLSearchParams();
  if (operation) qs.set("operation", operation);
  qs.set("page", String(opts.page ?? 1));
  qs.set("page_size", String(opts.pageSize ?? 50));
  const res = await apiFetch(`${VENDORS_PATH}/${encodeURIComponent(vendorId)}/history?${qs.toString()}`);
  if (!res.ok) throw await readVendorError(res, "Failed to load history");
  return res.json();
}

// GET /{id}/history/{hid} — one snapshot. hid is an int on the wire.
export async function getHistoryEntry(vendorId: string, historyId: number | string): Promise<VendorHistoryEntry> {
  const res = await apiFetch(
    `${VENDORS_PATH}/${encodeURIComponent(vendorId)}/history/${encodeURIComponent(String(historyId))}`,
  );
  if (!res.ok) throw await readVendorError(res, "Failed to load history entry");
  return res.json();
}

// POST /{id}/history/{hid}/revert — restore the pre-mutation state as a fresh patch.
export async function revertHistory(
  vendorId: string,
  historyId: number | string,
  reason?: string | null,
): Promise<VendorResponse> {
  const res = await apiFetch(
    `${VENDORS_PATH}/${encodeURIComponent(vendorId)}/history/${encodeURIComponent(String(historyId))}/revert`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: reason ?? null }),
    },
  );
  if (!res.ok) throw await readVendorError(res, "Couldn't revert change");
  return res.json();
}

/** null/''/undefined → "—"; else the value as a string. Small display helper. */
export function dash(v: unknown): string {
  if (v == null) return "—";
  const s = String(v).trim();
  return s === "" ? "—" : s;
}

/** Collapse a datetime/date string to YYYY-MM-DD; null → "—"; unparseable → raw. */
export function fmtVendorDate(v: unknown): string {
  if (v == null || v === "") return "—";
  const s = String(v);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s;
}
