// Customer-Returns (CR) API client — mirrors server_replica/app/modules/customer_returns.
// Terminology: the source filed this under "RTV" but it is a customer-RETURN document
// system that mints CR- ids; the target's return-to-vendor (/rtv/*) is a DIFFERENT module.
//
// Live backend: CRUD, boxes + export, and the approval flow — send for approval
// (mail + WhatsApp, reporting what actually went out) and Approve / Reject / Hold
// in-app, by the mailed link or by WhatsApp. Only the CR's Business Head or a
// standing deputy may decide, never the person who raised it, and only while it is
// Pending / On Hold (the server enforces this; see sendCustomerReturnForApproval and
// decideCustomerReturn below).
//
// Keys: the header PK is `rtv_id` (the CR-YYYYMMDDHHMMSS string). There is no
// numeric id — every path segment and link uses the rtv_id string.
// Numeric fields come back as strings to match the production API contract.

import { apiFetch, readApiErrorMessage } from "./auth";

const BASE = "/api/v1/customer-returns";

// CFERP shares the live _rtv_* tables with IMS. Phase 2 (the _rtv_* write path) is
// live, so full create/edit/print/approve is enabled. Flip to true (and set
// router.py CR_READ_ONLY = True) as a kill switch to fall back to read-only.
export const CR_READ_ONLY: boolean = false;

export type Company = "CFPL" | "CDPL";
export const COMPANIES: Company[] = ["CFPL", "CDPL"];

// Pending (create) → Approved / Rejected / On Hold by a decision, taken only from
// Pending or On Hold. Submitted = approved, then the warehouse saved boxes (the bulk
// box save flips Approved → Submitted); it is decided, like Approved and Rejected.
export type CRStatus = "Pending" | "Approved" | "Submitted" | "Rejected" | "On Hold";

// ── Requests ────────────────────────────────────────────────────────────────
export interface CRHeaderCreate {
  factory_unit: string;
  customer: string;
  invoice_number?: string;
  challan_no?: string;
  dn_no?: string;
  conversion?: string;
  sales_poc?: string;
  sales_poc_email?: string;
  business_head?: string;
  remark?: string;
  vehicle_number?: string;
  transporter_name?: string;
  driver_name?: string;
  inward_manager?: string;
}

export interface CRLineCreate {
  material_type: string;
  item_category: string;
  sub_category: string;
  item_description: string;
  sale_group?: string; // auto-filled from all_sku on item pick (legacy parity)
  uom: string;
  qty?: string;
  rate?: string;
  value?: string;
  conversion?: string; // line-level conversion (legacy sends = uom)
  net_weight?: string;
  carton_weight?: string;
  lot_number?: string;
  item_mark?: string;
  spl_remarks?: string;
  vakkal?: string;
}

export interface CRCreate {
  company: Company;
  header: CRHeaderCreate;
  lines: CRLineCreate[];
  boxes?: CRBulkBoxItem[]; // saved with it, in the same transaction (none printed yet)
}

// No status: a return is decided only by Approve / Reject / Hold (decideCustomerReturn,
// the mailed link or WhatsApp), where the server checks who decides and when. The
// header PUT ignores a status, so it can neither decide a return nor re-open one.
export type CRHeaderUpdate = Partial<CRHeaderCreate>;

export interface CRBulkBoxItem {
  article_description: string;
  box_number: number;
  box_id?: string; // the label this page believes the box has; omitted = unprinted
  uom?: string;
  conversion?: string;
  lot_number?: string;
  item_mark?: string;
  spl_remarks?: string;
  vakkal?: string;
  net_weight?: string;
  gross_weight?: string;
  count?: number;
}

export interface CRBoxUpsertRequest {
  article_description: string;
  box_number: number;
  // The label this page believes the box has (omitted = unprinted) and the box-set
  // fingerprint it loaded: a mismatch is refused (409 box_changed / boxes_changed)
  // instead of overwriting a box printed elsewhere.
  box_id?: string;
  base_version?: string;
  uom?: string;
  conversion?: string;
  net_weight?: string;
  gross_weight?: string;
  lot_number?: string;
  item_mark?: string;
  spl_remarks?: string;
  vakkal?: string;
  count?: number;
}

export interface CRBoxEditChange {
  field_name: string;
  old_value?: string;
  new_value?: string;
}

export interface CRBoxEditLogRequest {
  email_id: string; // FE-compat; the backend ignores it and uses the JWT identity
  box_id: string;
  rtv_id: string;
  changes: CRBoxEditChange[];
}

// ── Responses ───────────────────────────────────────────────────────────────
export interface CRLine {
  rtv_id: string;
  item_description: string;
  material_type: string;
  item_category: string;
  sub_category: string;
  sale_group?: string | null;
  uom: string;
  qty: string;
  rate: string;
  value: string;
  conversion?: string | null;
  net_weight: string;
  carton_weight: string;
  lot_number?: string | null;
  item_mark?: string | null;
  spl_remarks?: string | null;
  vakkal?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface CRBox {
  rtv_id: string;
  article_description: string;
  box_number: number;
  box_id?: string | null; // NULL until printed
  uom?: string | null;
  conversion?: string | null;
  lot_number?: string | null;
  item_mark?: string | null;
  spl_remarks?: string | null;
  vakkal?: string | null;
  net_weight: string;
  gross_weight: string;
  count?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface CRHeader {
  rtv_id: string;
  rtv_date?: string | null;
  factory_unit: string;
  customer: string;
  invoice_number?: string | null;
  challan_no?: string | null;
  dn_no?: string | null;
  conversion?: string | null;
  sales_poc?: string | null;
  sales_poc_email?: string | null;
  business_head?: string | null;
  remark?: string | null;
  vehicle_number?: string | null;
  transporter_name?: string | null;
  driver_name?: string | null;
  inward_manager?: string | null;
  status: CRStatus;
  created_by?: string | null;
  created_ts?: string | null;
  updated_at?: string | null;
}

export interface CRWithDetails extends CRHeader {
  lines: CRLine[];
  boxes: CRBox[];
  box_version?: string | null; // fingerprint of the boxes as read; sent back with box writes
  // Fingerprint of the figures an approver decides on (customer, unit, invoice, challan,
  // and each line's article, unit, qty, rate, value, net weight); sent back with a decision.
  figures_version?: string | null;
  // The latest approval request recorded: when, by whom, and whether it showed the
  // figures the return has now. null: none recorded (never sent from the ERP, or sent
  // before requests were recorded).
  approval_request?: CRApprovalRequest | null;
}

export interface CRApprovalRequest {
  sent_at: string;
  sent_by?: string | null;
  figures_current: boolean;
}

export interface CRListItem extends CRHeader {
  items_count: number;
  boxes_count: number;
  total_qty: number;
  total_net_weight: number;
}

export interface CRListResponse {
  records: CRListItem[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

export interface CRDeleteResponse {
  success: boolean;
  message: string;
  rtv_id?: string;
  lines_count: number;
  boxes_count: number;
  printed_boxes?: number;
}

export interface CRLinesUpdateResponse {
  status: string;
  rtv_id: string;
  lines_count: number;
  boxes_removed?: number; // unprinted boxes of the articles taken off the return
  box_version?: string | null; // the box-set fingerprint after it, for the next box save
}

export interface CRBoxUpsertResponse {
  status: "inserted" | "updated" | "unchanged";
  box_id: string;
  rtv_id: string;
  article_description: string;
  box_number: number;
  box_version?: string | null; // the box-set fingerprint after this write
}

export interface CRBulkBoxUpdateResponse {
  status: string;
  rtv_id: string;
  inserted: number;
  updated: number;
  unchanged: number;
  deleted: number;
  kept_printed?: number; // printed boxes left out of the save, kept (a save never deletes a label)
  box_version?: string | null;
  // printed boxes whose label shows a value this save changed: to be reprinted
  reprint?: { article_description: string; box_number: number; box_id: string }[];
}

// PUT /{company}/{cr_id}/save: the whole form in one transaction.
export interface CRSaveRequest {
  header: CRHeaderUpdate;
  lines: CRLineCreate[];
  boxes?: CRBulkBoxItem[] | null; // null/omitted: leave the boxes as they are
  base_version?: string | null; // the box-set fingerprint the page loaded
  send?: boolean; // then send it for approval (Save & send)
}

export interface CRSaveResponse {
  status: string;
  rtv_id: string;
  lines_count: number;
  boxes_removed: number;
  inserted: number;
  updated: number;
  deleted: number;
  kept_printed: number;
  box_version?: string | null;
  reprint?: { article_description: string; box_number: number; box_id: string }[];
  figures_version?: string | null;
  figures_changed: boolean; // the figures an approver decides on changed
  // The approval request sent after the save, and why: "requested" (Save & send) or
  // "figures_changed" (sent again on its own: it had been sent before). null: not sent.
  // A send refused because the return was decided meanwhile comes back as
  // { status: "failed", reason: "already_decided", message }.
  approval?: (CRSendForApprovalResponse & { message?: string }) | null;
  sent_because?: "requested" | "figures_changed" | null;
}

export interface CRBoxEditLogResponse {
  status: string;
  entries: number;
}

export interface CRListParams {
  page?: number;
  per_page?: number;
  status?: string;
  factory_unit?: string;
  customer?: string;
  from_date?: string; // DD-MM-YYYY
  to_date?: string; // DD-MM-YYYY
  sort_by?: string;
  sort_order?: "asc" | "desc";
}

// ── transport helpers (match the sample/transfer client idiom) ───────────────
/** A refusal from the server: the message to show, plus the module's error code
 *  (detail.error, e.g. "duplicate_invoice") and details, for a screen that acts on it. */
export class CRApiError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number, readonly details?: unknown) {
    super(message);
    this.name = "CRApiError";
  }
}

async function jsonOrThrow<T>(resP: Response | Promise<Response>, fallback: string): Promise<T> {
  const res = await resP;
  if (!res.ok) {
    const body = res.clone();
    const message = await readApiErrorMessage(res, fallback);
    let code: string | undefined;
    let details: unknown;
    try {
      const detail = ((await body.json()) as { detail?: unknown } | null)?.detail;
      if (detail && typeof detail === "object") {
        code = (detail as { error?: string }).error;
        details = (detail as { details?: unknown }).details;
      }
    } catch {
      /* non-JSON body: the message is enough */
    }
    throw new CRApiError(message, code, res.status, details);
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

// ── endpoints ────────────────────────────────────────────────────────────────
export function listCustomerReturns(company: Company, params: CRListParams = {}): Promise<CRListResponse> {
  const q = new URLSearchParams();
  if (params.page) q.set("page", String(params.page));
  if (params.per_page) q.set("per_page", String(params.per_page));
  if (params.status) q.set("status", params.status);
  if (params.factory_unit) q.set("factory_unit", params.factory_unit);
  if (params.customer) q.set("customer", params.customer);
  if (params.from_date) q.set("from_date", params.from_date);
  if (params.to_date) q.set("to_date", params.to_date);
  if (params.sort_by) q.set("sort_by", params.sort_by);
  if (params.sort_order) q.set("sort_order", params.sort_order);
  const qs = q.toString() ? `?${q}` : "";
  return jsonOrThrow(apiFetch(`${BASE}/${company}${qs}`), "Failed to load customer returns");
}

export function getCustomerReturn(company: Company, crId: string): Promise<CRWithDetails> {
  return jsonOrThrow(apiFetch(`${BASE}/${company}/${enc(crId)}`), "Failed to load customer return");
}

// allowDuplicateInvoice: save even though the customer's invoice or challan is already on
// another return (a 409 duplicate_invoice otherwise, naming those returns).
export function createCustomerReturn(
  company: Company,
  body: CRCreate,
  opts: { allowDuplicateInvoice?: boolean } = {},
): Promise<CRWithDetails> {
  const qs = opts.allowDuplicateInvoice ? "?allow_duplicate_invoice=true" : "";
  return jsonOrThrow(
    apiFetch(`${BASE}/${company}${qs}`, { method: "POST", body: JSON.stringify(body) }),
    "Failed to create customer return",
  );
}

export function updateCustomerReturn(
  company: Company,
  crId: string,
  body: CRHeaderUpdate,
  opts: { allowDuplicateInvoice?: boolean } = {},
): Promise<CRHeader> {
  const qs = opts.allowDuplicateInvoice ? "?allow_duplicate_invoice=true" : "";
  return jsonOrThrow(
    apiFetch(`${BASE}/${company}/${enc(crId)}${qs}`, { method: "PUT", body: JSON.stringify(body) }),
    "Failed to update customer return",
  );
}

export function updateCustomerReturnLines(
  company: Company,
  crId: string,
  lines: CRLineCreate[],
): Promise<CRLinesUpdateResponse> {
  return jsonOrThrow(
    apiFetch(`${BASE}/${company}/${enc(crId)}/lines`, { method: "PUT", body: JSON.stringify({ lines }) }),
    "Failed to update line items",
  );
}

// Deletes an undecided return (a decided one is refused, 409 already_decided) and
// records it on the server. notify: false skips the "deleted" mail to the approvers —
// for the New screen's Discard of a draft that was never sent.
// Save an undecided return as the form holds it: header, lines and boxes in one
// transaction — all saved or none. Then, server-side, the approval request when
// opts.send, or on its own when the save changed the figures of a return already sent.
export function saveCustomerReturn(
  company: Company,
  crId: string,
  body: CRSaveRequest,
  opts: { allowDuplicateInvoice?: boolean } = {},
): Promise<CRSaveResponse> {
  const qs = opts.allowDuplicateInvoice ? "?allow_duplicate_invoice=true" : "";
  return jsonOrThrow(
    apiFetch(`${BASE}/${company}/${enc(crId)}/save${qs}`, { method: "PUT", body: JSON.stringify(body) }),
    "Failed to save customer return",
  );
}

export function deleteCustomerReturn(company: Company, crId: string, opts: { notify?: boolean } = {}): Promise<CRDeleteResponse> {
  const qs = opts.notify === false ? "?notify=false" : "";
  return jsonOrThrow(
    apiFetch(`${BASE}/${company}/${enc(crId)}${qs}`, { method: "DELETE" }),
    "Failed to delete customer return",
  );
}

// Print/upsert a single box (mints/keeps a box_id).
export function upsertBox(company: Company, crId: string, body: CRBoxUpsertRequest): Promise<CRBoxUpsertResponse> {
  return jsonOrThrow(
    apiFetch(`${BASE}/${company}/${enc(crId)}/box`, { method: "PUT", body: JSON.stringify(body) }),
    "Failed to save box",
  );
}

// State-aware full sync of the box set (insert/update/delete unprinted; a printed box
// is never deleted). baseVersion: the box-set fingerprint this page loaded — a save
// from an out-of-date page is refused (409 boxes_changed).
export function bulkSaveBoxes(
  company: Company,
  crId: string,
  boxes: CRBulkBoxItem[],
  opts: { notifyDiscrepancy?: boolean; allowClear?: boolean; baseVersion?: string | null } = {},
): Promise<CRBulkBoxUpdateResponse> {
  const q = new URLSearchParams();
  if (opts.notifyDiscrepancy === false) q.set("notify_discrepancy", "false");
  if (opts.allowClear) q.set("allow_clear", "true");
  const qs = q.toString() ? `?${q}` : "";
  return jsonOrThrow(
    apiFetch(`${BASE}/${company}/${enc(crId)}/boxes${qs}`, {
      method: "PUT",
      body: JSON.stringify({ boxes, base_version: opts.baseVersion ?? undefined }),
    }),
    "Failed to save boxes",
  );
}

export function logBoxEdits(body: CRBoxEditLogRequest): Promise<CRBoxEditLogResponse> {
  return jsonOrThrow(
    apiFetch(`${BASE}/box-edit-log`, { method: "POST", body: JSON.stringify(body) }),
    "Failed to log box edits",
  );
}

// Approval e-mail routing (DB-backed; replaces the old hardcoded maps). Company-
// agnostic. Feeds the approve screen's recipient matrix (via _approvalMatrix) AND
// the create form's Business-Head / Sales-POC dropdown names.
export interface CrEmailRouting {
  business_head: { name: string; email: string }[];
  sales_poc: { name: string; email: string }[];
  warehouse_cc: { match_key: string; match_type: string; email: string }[];
  constant_cc: string[];
  notify_to: string | null;
  // Standing deputies who hold the same Approve/Reject/Hold buttons as the CR's
  // Business Head, so a return still closes the same day when the primary is away.
  deputy_approver: { name: string; email: string }[];
}

export function getCrEmailRouting(): Promise<CrEmailRouting> {
  return jsonOrThrow(apiFetch(`${BASE}/email-routing`), "Failed to load approval email routing");
}

// Send the approval request: the threaded mail (each approver who can decide gets the
// Approve / Reject / Hold buttons, everyone else — the person who raised the return
// included, even when they are an approver — a copy) and the WhatsApp card to the
// same approvers. Allowed only while the CR is Pending / On Hold (else 409
// already_decided), so it is also the re-send. Sending is best-effort, but the
// response says what actually went out.
export type CRSendStatus = "sent" | "partial" | "failed";

export interface CRSendMailOutcome {
  sent: boolean; // every copy went out
  to: string[]; // the TO line: the approvers who can decide + notify_to
  cc_count: number;
  approvers_mailed: number; // approver copies (with the buttons) that went out
  reason?: "smtp_not_configured" | "no_recipients" | "smtp_error" | "error" | (string & {});
  failed?: string[]; // addresses that were not mailed
}

export interface CRSendWhatsAppOutcome {
  status: CRSendStatus | "skipped"; // skipped = not configured / no number on file
  sent: number;
  failed: number;
  reason?:
    | "wa_disabled" | "no_approver_phone" | "send_failed" | "media_upload_failed"
    | "mapping_store_failed" | "exception" | (string & {});
  recipients?: { name: string; sent: boolean }[];
}

export interface CRSendForApprovalResponse {
  // sent: every mail copy went out and WhatsApp didn't fail; failed: nobody who can
  // decide was reached, or nobody can decide it — reason "no_approver" (no Business
  // Head mapped and no deputy) or "only_creator" (its only approver raised it);
  // partial: in between.
  status: CRSendStatus;
  reason?: "no_approver" | "only_creator" | (string & {});
  approver: { name: string; email: string } | null; // the Business Head, when mapped (even if they raised it)
  approvers: { name: string; email: string }[]; // everyone who may decide it, BH first — never its creator
  to: string[];
  cc_count: number;
  mail: CRSendMailOutcome;
  whatsapp: CRSendWhatsAppOutcome;
}
export function sendCustomerReturnForApproval(company: Company, crId: string): Promise<CRSendForApprovalResponse> {
  return jsonOrThrow(
    apiFetch(`${BASE}/${company}/${enc(crId)}/send-for-approval`, { method: "POST" }),
    "Failed to send for approval",
  );
}

// In-app Approve/Reject/Hold as the logged-in user — persists the status + audit and
// sends the threaded status mail. 403 when the user isn't the CR's Business Head or a
// deputy approver, raised the return themselves, or has no e-mail; 409 when the CR has
// no approver at all, and 409 figures_changed when the return was changed after the page
// loaded `figures` (its figures_version). A decided CR comes back already_actioned. (The
// emailed buttons open the public /email-action confirmation page instead.)
export type CRApprovalAction = "approve" | "reject" | "hold";
export interface CRDecisionResponse {
  rtv_id: string;
  status: CRStatus;
  already_actioned: boolean;
  decided_by?: string; // the e-mail recorded as approved_by (a real decision only)
}
export function decideCustomerReturn(
  company: Company, crId: string, action: CRApprovalAction, remark?: string, figures?: string | null,
): Promise<CRDecisionResponse> {
  return jsonOrThrow(
    apiFetch(`${BASE}/${company}/${enc(crId)}/approve`, {
      method: "POST",
      body: JSON.stringify({ action, remark, figures: figures ?? undefined }),
    }),
    "Failed to apply the decision",
  );
}

// Server-built styled .xlsx (edited cells highlighted): the file to download and the
// name the server gave it (its Content-Disposition, readable because the API lists it
// in CORS expose_headers; null when the header didn't come through).
export interface CRExportFile {
  blob: Blob;
  filename: string | null;
}
export async function exportCustomerReturns(
  company: Company,
  params: Omit<CRListParams, "page" | "per_page"> = {},
): Promise<CRExportFile> {
  const q = new URLSearchParams();
  q.set("company", company);
  if (params.status) q.set("status", params.status);
  if (params.customer) q.set("customer", params.customer);
  if (params.factory_unit) q.set("factory_unit", params.factory_unit);
  if (params.from_date) q.set("from_date", params.from_date);
  if (params.to_date) q.set("to_date", params.to_date);
  if (params.sort_by) q.set("sort_by", params.sort_by);
  if (params.sort_order) q.set("sort_order", params.sort_order);
  const res = await apiFetch(`${BASE}/export?${q}`, {
    headers: { Accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  });
  if (!res.ok) throw new Error(await readApiErrorMessage(res, "Export failed"));
  const cd = res.headers.get("Content-Disposition") ?? "";
  const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? null;
  return { blob: await res.blob(), filename };
}

// yyyy-mm-dd (native <input type=date>) → DD-MM-YYYY (backend filter format).
export function toApiDate(val: string): string | undefined {
  if (!val) return undefined;
  const [y, m, d] = val.split("-");
  if (!y || !m || !d) return undefined;
  return `${d}-${m}-${y}`;
}
