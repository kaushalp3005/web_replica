// Floor requisitions API client — /api/v1/floor-requisitions
// (server_replica app/modules/floor_requisition/router.py).
//
// A 409 from a write is not a red error: either someone already moved the request
// on (status_changed) or an open request for the article exists
// (open_requisition_exists). It surfaces as RequisitionConflictError, so a screen
// can reload or show the server's message inline.
//
// Every other failure (a plain 403/404/500/network error) surfaces as
// RequisitionApiError, carrying the HTTP status alongside the server's
// message — so a caller that needs to tell "you're not scoped to this
// warehouse" (403) apart from a genuine outage (network/500) can do so
// without parsing the message text.

import { apiFetch, readApiErrorMessage } from "./auth";
import type { RequisitionStatus, RequisitionUnit, StoreResponse } from "./floor-requisition-form";

const BASE = "/api/v1/floor-requisitions";

/** The job card a request was raised from, as the LIST endpoint reads it
 *  (requisition_service._job_cards). Writes (raise / issue / receive / cancel)
 *  answer without it, and a server older than the list enrichment omits it, so
 *  every reader must treat it as optional. */
export interface RequisitionJobCard {
  job_card_id: number;
  /** "PLAN-{plan}-L{line}-S{step}" — the number people know the card by. */
  job_card_number: string;
  fg_sku_name: string;
  customer_name: string | null;
  batch_number: string;
  process_name: string;
  stage: string;
  /** The job card's own lifecycle status (locked … closed / cancelled). */
  status: string;
  entity: string;
}

export interface FloorRequisition {
  /** The requisition number: an 8-digit time-based id. Not in date order. */
  requisition_id: number;
  job_card_id: number;
  warehouse: string;
  floor: string;
  material_sku_name: string;
  item_type: string | null;
  requested_qty: number;
  requested_unit: RequisitionUnit;
  /** Snapshot when raised. null = the job card had no indent line for it. */
  required_qty: number | null;
  required_unit: RequisitionUnit | null;
  available_qty: number;
  available_unit: RequisitionUnit;
  shortage_qty: number | null;
  shortage_unit: RequisitionUnit | null;
  issued_qty: number | null;
  issued_unit: RequisitionUnit | null;
  status: RequisitionStatus;
  note: string | null;
  issue_note: string | null;
  cancel_reason: string | null;
  raised_by: string;
  raised_at: string;
  issued_by: string | null;
  issued_at: string | null;
  received_by: string | null;
  received_at: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
  /** List responses only; null when the job card could not be read. */
  job_card?: RequisitionJobCard | null;
  /** List responses only: store's latest Accept / Hold reply on WhatsApp, or null.
   *  Absent from a server without migration 112. Not a status. */
  store_response?: RequisitionStoreResponse | null;
}

export interface RequisitionStoreResponse {
  response: StoreResponse;
  by: string | null;
  /** ISO timestamp. */
  at: string | null;
}

export interface FloorRequisitionPage {
  items: FloorRequisition[];
  total: number;
  page: number;
  page_size: number;
}

export interface RequisitionQuery {
  status?: RequisitionStatus | "";
  warehouse?: string;
  floor?: string;
  jobCardId?: number;
  search?: string;
  page?: number;
  pageSize?: number;
}

export class RequisitionConflictError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "RequisitionConflictError";
    this.code = code;
  }
}

/** Any non-409 failure. `status` lets a caller distinguish, e.g., a 403
 *  "not assigned to this warehouse" from a genuine outage without matching
 *  on the message text. */
export class RequisitionApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "RequisitionApiError";
    this.status = status;
  }
}

async function readOrThrow<T>(res: Response, fallback: string): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  if (res.status === 409) {
    const body = (await res.clone().json().catch(() => null)) as { detail?: { error?: string } } | null;
    throw new RequisitionConflictError(await readApiErrorMessage(res, fallback), body?.detail?.error ?? "conflict");
  }
  throw new RequisitionApiError(await readApiErrorMessage(res, fallback), res.status);
}

function post(path: string, body?: unknown): Promise<Response> {
  return apiFetch(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
}

export async function listFloorRequisitions(
  q: RequisitionQuery,
  signal?: AbortSignal,
): Promise<FloorRequisitionPage> {
  const p = new URLSearchParams();
  if (q.status) p.set("status", q.status);
  if (q.warehouse) p.set("warehouse", q.warehouse);
  if (q.floor) p.set("floorName", q.floor);
  if (q.jobCardId != null) p.set("job_card_id", String(q.jobCardId));
  if (q.search?.trim()) p.set("search", q.search.trim());
  p.set("page", String(q.page ?? 1));
  p.set("page_size", String(q.pageSize ?? 100));
  return readOrThrow(await apiFetch(`${BASE}?${p}`, { signal }), "Failed to load floor requisitions");
}

export async function raiseFloorRequisition(body: {
  job_card_id: number;
  material_sku_name: string;
  requested_qty: number;
  note?: string;
}): Promise<FloorRequisition> {
  return readOrThrow(await post(BASE, body), "Failed to raise the request");
}

export async function issueFloorRequisition(
  id: number,
  body: { issued_qty: number; issue_note?: string },
): Promise<FloorRequisition> {
  return readOrThrow(await post(`${BASE}/${id}/issue`, body), "Failed to issue");
}

export async function receiveFloorRequisition(id: number): Promise<FloorRequisition> {
  return readOrThrow(await post(`${BASE}/${id}/receive`), "Failed to mark received");
}

export async function cancelFloorRequisition(id: number, reason: string): Promise<FloorRequisition> {
  return readOrThrow(await post(`${BASE}/${id}/cancel`, { reason }), "Failed to cancel");
}

/** One box store scanned or printed for a request (floor_requisition_box). */
export interface RequisitionBox {
  requisition_id: number;
  box_code: string;
  source: "printed" | "scanned";
  /** Where the box was found: sfg_box, po_box, or a legacy box table. */
  box_table: string;
  /** Printed boxes: the "Box #" on the sticker. */
  box_number: number | null;
  transaction_no: string | null;
  article: string;
  /** Printed boxes: "Fresh Stock" or "Off Grade/Rejection". */
  stock_type: string | null;
  lot_number: string | null;
  net_weight: number | null;
  gross_weight: number | null;
  count: number | null;
  recorded_by: string;
  recorded_at: string | null;
  /** The box's article is not the requested material. */
  article_mismatch: boolean;
}

/** One page of a request's boxes (newest first) with figures for the whole request. */
export interface RequisitionBoxes {
  requisition_id: number;
  status: RequisitionStatus;
  boxes: RequisitionBox[];
  page: number;
  page_size: number;
  /** Boxes on the whole request. */
  total: number;
  pages: number;
  totals: { boxes: number; net_weight: number; gross_weight: number; count: number };
  /** Net weight and box count per article, heaviest first — the whole request. */
  by_article: { article: string; net_weight: number; boxes: number }[];
  /** The next free sticker "Box #" on the request. */
  next_box_number: number;
  /** With `find`: the box id it matched (its page is the one returned), or null. */
  found: string | null;
}

export interface RequisitionBoxQuery {
  page?: number;
  pageSize?: number;
  /** A box id, a scanned sticker's QR, or a sticker "Box #". */
  find?: string;
}

export interface PrintBoxLine {
  box_number: number;
  net_weight: number;
  gross_weight: number | null;
  count: number | null;
  lot_number: string | null;
}

export async function listRequisitionBoxes(
  id: number,
  q: RequisitionBoxQuery = {},
  signal?: AbortSignal,
): Promise<RequisitionBoxes> {
  const p = new URLSearchParams();
  p.set("page", String(q.page ?? 1));
  p.set("page_size", String(q.pageSize ?? 10));
  if (q.find?.trim()) p.set("find", q.find.trim());
  return readOrThrow(await apiFetch(`${BASE}/${id}/boxes?${p}`, { signal }), "Failed to load the boxes");
}

/** `code` is the raw QR — the server reads {"tx","bi"} itself. */
export async function scanRequisitionBox(id: number, code: string): Promise<RequisitionBox> {
  return readOrThrow(await post(`${BASE}/${id}/boxes/scan`, { code }), "Failed to record the box");
}

export async function printRequisitionBoxes(
  id: number,
  body: { article: string; stock_type: string; boxes: PrintBoxLine[] },
): Promise<{ requisition_id: number; boxes: RequisitionBox[] }> {
  return readOrThrow(await post(`${BASE}/${id}/boxes/print`, body), "Failed to save the boxes");
}

export async function removeRequisitionBox(
  id: number,
  code: string,
): Promise<{ requisition_id: number; box_code: string; removed: boolean }> {
  return readOrThrow(
    await apiFetch(`${BASE}/${id}/boxes/${encodeURIComponent(code)}`, { method: "DELETE" }),
    "Failed to remove the box",
  );
}
