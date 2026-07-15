// Customer-Returns (CR) API client — mirrors server_replica/app/modules/customer_returns.
// Terminology: the source filed this under "RTV" but it is a customer-RETURN document
// system that mints CR- ids; the target's return-to-vendor (/rtv/*) is a DIFFERENT module.
//
// Live backend today is Phase 1 (CRUD) + Phase 2 (boxes + export). There is NO
// approve / send-for-approval / email / summary / sku endpoint — the approval flow
// is stubbed on fixtures in the module (see customer-returns/_fixtures.ts).
//
// Keys: the header PK is `rtv_id` (the CR-YYYYMMDDHHMMSS string). There is no
// numeric id — every path segment and link uses the rtv_id string.
// Numeric fields come back as strings to match the production API contract.

import { apiFetch, readApiErrorMessage } from "./auth";

const BASE = "/api/v1/customer-returns";

export type Company = "CFPL" | "CDPL";
export const COMPANIES: Company[] = ["CFPL", "CDPL"];

// status values the backend can set: Pending (create), Submitted (bulk box save).
// Approved/Rejected/On Hold only reachable via the (not-yet-live) approval flow.
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
}

export type CRHeaderUpdate = Partial<CRHeaderCreate> & { status?: CRStatus };

export interface CRBulkBoxItem {
  article_description: string;
  box_number: number;
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
}

export interface CRLinesUpdateResponse {
  status: string;
  rtv_id: string;
  lines_count: number;
}

export interface CRBoxUpsertResponse {
  status: "inserted" | "updated" | "unchanged";
  box_id: string;
  rtv_id: string;
  article_description: string;
  box_number: number;
}

export interface CRBulkBoxUpdateResponse {
  status: string;
  rtv_id: string;
  inserted: number;
  updated: number;
  unchanged: number;
  deleted: number;
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
async function jsonOrThrow<T>(resP: Response | Promise<Response>, fallback: string): Promise<T> {
  const res = await resP;
  if (!res.ok) throw new Error(await readApiErrorMessage(res, fallback));
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

export function createCustomerReturn(company: Company, body: CRCreate): Promise<CRWithDetails> {
  return jsonOrThrow(
    apiFetch(`${BASE}/${company}`, { method: "POST", body: JSON.stringify(body) }),
    "Failed to create customer return",
  );
}

export function updateCustomerReturn(company: Company, crId: string, body: CRHeaderUpdate): Promise<CRHeader> {
  return jsonOrThrow(
    apiFetch(`${BASE}/${company}/${enc(crId)}`, { method: "PUT", body: JSON.stringify(body) }),
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

export function deleteCustomerReturn(company: Company, crId: string): Promise<CRDeleteResponse> {
  return jsonOrThrow(
    apiFetch(`${BASE}/${company}/${enc(crId)}`, { method: "DELETE" }),
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

// State-aware full sync of the box set (insert/update/keep/delete).
export function bulkSaveBoxes(
  company: Company,
  crId: string,
  boxes: CRBulkBoxItem[],
  opts: { notifyDiscrepancy?: boolean; allowClear?: boolean } = {},
): Promise<CRBulkBoxUpdateResponse> {
  const q = new URLSearchParams();
  if (opts.notifyDiscrepancy === false) q.set("notify_discrepancy", "false");
  if (opts.allowClear) q.set("allow_clear", "true");
  const qs = q.toString() ? `?${q}` : "";
  return jsonOrThrow(
    apiFetch(`${BASE}/${company}/${enc(crId)}/boxes${qs}`, { method: "PUT", body: JSON.stringify({ boxes }) }),
    "Failed to save boxes",
  );
}

export function logBoxEdits(body: CRBoxEditLogRequest): Promise<CRBoxEditLogResponse> {
  return jsonOrThrow(
    apiFetch(`${BASE}/box-edit-log`, { method: "POST", body: JSON.stringify(body) }),
    "Failed to log box edits",
  );
}

// Server-built styled .xlsx (edited cells highlighted). Returns a Blob to download.
export async function exportCustomerReturns(
  company: Company,
  params: Omit<CRListParams, "page" | "per_page"> = {},
): Promise<Blob> {
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
  return res.blob();
}

// yyyy-mm-dd (native <input type=date>) → DD-MM-YYYY (backend filter format).
export function toApiDate(val: string): string | undefined {
  if (!val) return undefined;
  const [y, m, d] = val.split("-");
  if (!y || !m || !d) return undefined;
  return `${d}-${m}-${y}`;
}
