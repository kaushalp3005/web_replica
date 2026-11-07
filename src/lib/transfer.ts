// Inter-Unit Transfer API client. Mirrors the production `interunitApiService`
// but targets the replica backend at /api/v1/transfer/* (proxied same-origin —
// see next.config.ts). Types match server_replica/app/modules/transfer/schemas.py
// 1:1 so the dashboard renders the same fields the production UI did.

import { apiFetch, readApiErrorMessage } from "./auth";

const BASE = "/api/v1/transfer";

// ── Shared list-envelope ──────────────────────────────────────────────────
export interface ListEnvelope<T> {
  records: T[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

// ── Requests ────────────────────────────────────────────────────────────────
export interface RequestLine {
  id: number;
  request_id: number;
  material_type: string;
  item_category: string;
  sub_category: string;
  item_description: string;
  quantity: string;
  uom: string;
  pack_size: string;
  unit_pack_size?: string | null;
  net_weight: string;
  lot_number?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface TransferRequest {
  id: number;
  request_no: string;
  request_date: string;
  from_warehouse: string;
  to_warehouse: string;
  reason_description: string;
  status: string;
  created_by?: string | null;
  created_ts?: string | null;
  updated_at?: string | null;
  // Backend migration 121: the store accepts or rejects, an inventory manager approves or
  // rejects, then the store scans and sends. store_decision "Accepted" | "Rejected" |
  // "Held" and manager_decision "Approved" | "Rejected" | "Held" are each one's answer
  // (null = not answered yet); *_decided_by is the email of whoever answered.
  store_decision?: string | null;
  store_decided_by?: string | null;
  store_decided_at?: string | null;
  store_reject_reason?: string | null;
  manager_decision?: string | null;
  manager_decided_by?: string | null;
  manager_decided_at?: string | null;
  manager_reject_reason?: string | null;
  // Backend migration 127: holds. A store hold keeps the request Pending (store_decision
  // "Held"); a manager hold makes it "On Hold" (manager_decision "Held"). Each reason
  // stays once the request is answered, as history.
  store_hold_reason?: string | null;
  manager_hold_reason?: string | null;
  // Legacy: the only reason a request rejected before migration 121 has (both decisions
  // above are null for it). The backend still returns it.
  reject_reason?: string | null;
  // The request's newest transfer, the one Scan & send adds boxes to (null when it has
  // none). Filled when one request is read (getRequest); a listed request may leave it null.
  transfer_id?: number | null;
  transfer_challan_no?: string | null;
  transfer_status?: string | null;
  lines: RequestLine[];
}

/** Request statuses: Pending → Accepted (store) → Approved (inventory manager) →
 *  Transferred (scanned and sent). Rejected ends it: the store rejects a Pending
 *  request, the inventory manager an Accepted (or On Hold) one. A store hold keeps a
 *  request Pending (store_decision "Held"); an inventory manager's hold makes an
 *  Accepted one On Hold, from which it can still be approved or rejected. */
export const REQUEST_STATUS = {
  PENDING: "Pending",
  ACCEPTED: "Accepted",
  ON_HOLD: "On Hold",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  TRANSFERRED: "Transferred",
} as const;

/** store_decision / manager_decision of a hold. */
export const HELD = "Held";

/** A Pending request the supplying store has put on hold (it can still accept or reject it). */
export function isStoreHeld(r: Pick<TransferRequest, "status" | "store_decision">): boolean {
  return (r.status || REQUEST_STATUS.PENDING) === REQUEST_STATUS.PENDING && r.store_decision === HELD;
}

// ── Transfers (OUT) ──────────────────────────────────────────────────────────
export interface TransferBox {
  id: number;
  header_id: number;
  transfer_line_id?: number | null;
  box_number: number;
  box_id?: string | null;
  article: string;
  lot_number?: string | null;
  batch_number?: string | null;
  transaction_no?: string | null;
  net_weight: string;
  gross_weight: string;
  storage_location?: string | null;
  source_storage?: string | null;
  source_unit?: string | null;
  lot_origin_unit?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface TransferLine {
  id: number;
  header_id: number;
  material_type: string;
  item_category: string;
  sub_category: string;
  item_description: string;
  quantity: string;
  uom: string;
  pack_size: string;
  unit_pack_size?: string | null;
  net_weight: string;
  total_weight: string;
  batch_number?: string | null;
  lot_number?: string | null;
}

export interface GrnRecord {
  id: number;
  grn_number: string;
  status: string;
  received_by: string;
  received_at?: string | null;
  received_boxes: number;
}

export interface TransferHeader {
  id: number;
  challan_no: string;
  stock_trf_date: string;
  from_warehouse: string;
  to_warehouse: string;
  vehicle_no: string;
  driver_name?: string | null;
  approved_by?: string | null;
  remark?: string | null;
  reason_code?: string | null;
  status: string;
  request_id?: number | null;
  request_no?: string | null;
  created_by?: string | null;
  created_ts?: string | null;
  approved_ts?: string | null;
  has_variance: boolean;
  from_cold_unit?: string | null;
}

export interface TransferListItem extends TransferHeader {
  items_count: number;
  boxes_count: number;
  total_qty: number;
  pending_items: number;
  lot_numbers_text?: string | null;
}

export interface TransferDetail extends TransferHeader {
  lines: TransferLine[];
  boxes: TransferBox[];
  grn_records: GrnRecord[];
}

// A transfer's own status that says it is still out: ERP's Dispatch / Partial, and IMS's
// older In Transit / Completed (IMS shows Completed as Dispatch and parks its boxes as in
// transit). The server's rule (backend lookup_service.is_in_transit_status).
const IN_TRANSIT_STATUSES: ReadonlySet<string> = new Set(["dispatch", "partial", "in transit", "completed"]);

/** Whether `status` says the transfer is still in transit (see IN_TRANSIT_STATUSES; case and
 *  outer spaces aside). Received, IMS's Partially Received, a blank or any other status is
 *  not: such a transfer can't be edited (409). Only the status: a transfer whose receipt has
 *  begun is refused too. */
export function isInTransitStatus(status: string | null | undefined): boolean {
  return IN_TRANSIT_STATUSES.has((status || "").trim().toLowerCase());
}

// ── Transfers IN (GRN) ────────────────────────────────────────────────────────
export interface TransferInBox {
  id: number;
  header_id: number;
  box_id: string;
  transfer_out_box_id?: number | null;
  article?: string | null;
  batch_number?: string | null;
  lot_number?: string | null;
  transaction_no?: string | null;
  net_weight?: number | null;
  gross_weight?: number | null;
  scanned_at?: string | null;
  is_matched: boolean;
  issue?: Record<string, unknown> | null;
  line_index?: number | null;
}

export interface TransferInRecord {
  id: number;
  transfer_out_id: number;
  transfer_out_no: string;
  grn_number: string;
  grn_date?: string | null;
  receiving_warehouse: string;
  from_warehouse?: string | null;
  // The dispatch's cold units ("Rishi, Savla D-39") when it went from cold storage.
  from_cold_unit?: string | null;
  received_by: string;
  received_at?: string | null;
  box_condition?: string | null;
  condition_remarks?: string | null;
  status: string;
  created_at?: string | null;
  updated_at?: string | null;
  total_boxes_scanned: number;
}

export interface TransferInDetail extends TransferInRecord {
  boxes: TransferInBox[];
}

// ── Pending stock (in-transit) ────────────────────────────────────────────────
export interface PendingTransferRecord {
  transfer_out_id: number;
  transfer_out_challan_no: string;
  dispatched_at?: string | null;
  from_site?: string | null;
  to_site?: string | null;
  from_company?: string | null;
  to_company?: string | null;
  from_storage_type?: string | null;
  to_storage_type?: string | null;
  total_boxes: number;
  total_cartons: number;
  total_kg: number;
  dispatched_by?: string | null;
  status?: string | null;
  header_status?: string | null;
  unallocated_boxes?: number | null;
  updated_ts?: string | null;
}

export interface PendingStockResponse {
  records: PendingTransferRecord[];
  total: number;
  filter_options: {
    from_sites: string[];
    to_sites: string[];
    from_site_counts: Record<string, number>;
    to_site_counts: Record<string, number>;
  };
}

// ── Inner cold ────────────────────────────────────────────────────────────────
export interface InnerColdLine {
  item_description?: string | null;
  item_category?: string | null;
  quantity?: number | null;
  old_lot_number?: string | null;
  new_lot_number?: string | null;
  net_weight_kg: number;
  new_storage_location?: string | null;
}

export interface InnerColdChallan {
  challan_no?: string | null;
  transfer_date?: string | null;
  from_warehouse?: string | null;
  reason_code?: string | null;
  remark?: string | null;
  status: string;
  line_count: number;
  total_boxes?: number | null;
  created_at?: string | null;
  lines: InnerColdLine[];
}

// ── Inner cold transfer create / edit (doc 11) ──
// new_storage_location may only name the challan's own store (the page sends none).
export interface InnerTransferLineInput {
  stock_record_id: number | null;
  // The cold table stock_record_id is a row of (cfpl / cdpl, the picked search row's
  // company): ids repeat across cfpl_cold_stocks and cdpl_cold_stocks, so each line names
  // its own. Without it the server looks the id up in both.
  company?: string | null;
  item_category?: string | null;
  item_description?: string | null;
  net_weight?: number | null;
  quantity: number;
  old_lot_number: string;
  new_lot_number: string;
  new_storage_location?: string | null;
}
export interface InnerTransferCreateBody {
  header: {
    challan_no: string;
    transfer_name?: string | null;
    from_warehouse: string;
    remark?: string | null;
    reason_code?: string | null;
    transfer_type?: string;
  };
  lines: InnerTransferLineInput[];
}
export interface InnerTransferResult {
  status: string;
  updated_records: number;
  errors: string[];
  challan_no: string;
}
export interface InnerTransferDetailLine {
  id: number;
  stock_record_id: number | null;
  item_category?: string | null;
  item_description?: string | null;
  net_weight_kg: number;
  quantity: number;
  old_lot_number?: string | null;
  new_lot_number?: string | null;
  new_storage_location?: string | null;
}
export interface InnerTransferDetail {
  challan_no: string;
  transfer_date?: string | null;
  from_warehouse?: string | null;
  reason_code?: string | null;
  remark?: string | null;
  status: string;
  created_at?: string | null;
  lines: InnerTransferDetailLine[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

async function getJson<T>(path: string, fallback: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(await readApiErrorMessage(res, fallback));
  return (await res.json()) as T;
}

async function mutate<T>(path: string, method: "POST" | "DELETE", fallback: string): Promise<T> {
  const res = await apiFetch(path, { method });
  if (!res.ok) throw new Error(await readApiErrorMessage(res, fallback));
  return (await res.json()) as T;
}

async function postJson<T>(path: string, payload: unknown, fallback: string): Promise<T> {
  const res = await apiFetch(path, { method: "POST", body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(await readApiErrorMessage(res, fallback));
  return (await res.json()) as T;
}

async function putJson<T>(path: string, payload: unknown, fallback: string): Promise<T> {
  const res = await apiFetch(path, { method: "PUT", body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(await readApiErrorMessage(res, fallback));
  return (await res.json()) as T;
}

async function patchJson<T>(path: string, payload: unknown, fallback: string): Promise<T> {
  const res = await apiFetch(path, { method: "PATCH", body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(await readApiErrorMessage(res, fallback));
  return (await res.json()) as T;
}

// ── Receive (Transfer-IN) lifecycle payloads ──
export interface AcknowledgeBoxInput {
  box_id: string;
  transfer_out_box_id?: number | null;
  article?: string | null;
  batch_number?: string | null;
  lot_number?: string | null;
  transaction_no?: string | null;
  net_weight?: number | null;
  gross_weight?: number | null;
  is_matched?: boolean;
  issue?: Record<string, unknown> | null;
  line_index?: number | null;
  scan_source?: string;
}
export interface PendingLookup {
  exists: boolean;
  header: TransferInDetail | null;
}
// A box of an acknowledge-batch the server refused (e.g. 409: not on the transfer, or a
// second box with the same box id on one receipt); the others are recorded.
export interface AckConflict {
  box_id?: string | null;
  transaction_no?: string | null;
  status_code?: number;
  detail?: unknown;
}
export interface AckBatchResult {
  success: boolean;
  count: number;
  // The receipt box rows the batch wrote, one per box it recorded.
  boxes?: TransferInBox[];
  conflicts: AckConflict[];
}
// What the in-transit sync did (counts of boxes); `error` when it could not run.
export interface BackfillResult {
  transfers_scanned?: number;
  transfers_with_existing_pending?: number;
  boxes_parked_from_cold?: number;
  boxes_parked_from_warehouse?: number;
  boxes_parked_without_source?: number;
  boxes_skipped_already_parked?: number;
  boxes_with_missing_id?: number;
  // Not recorded: the box went on on a newer transfer, or IMS's cold receive took it in.
  boxes_skipped_sent_on?: number;
  boxes_skipped_received?: number;
  error?: string;
}

// ── Public API ──────────────────────────────────────────────────────────────
export interface ListParams {
  page?: number;
  per_page?: number;
  sort_by?: string;
  sort_order?: string;
}

export const TransferApi = {
  getRequests: (p: ListParams = {}) =>
    getJson<ListEnvelope<TransferRequest>>(
      `${BASE}/requests${qs({ page: p.page ?? 1, per_page: p.per_page ?? 15 })}`,
      "Failed to load requests.",
    ),

  getRequest: (id: number) =>
    getJson<TransferRequest>(`${BASE}/requests/${id}`, "Failed to load request."),

  getTransfers: (p: ListParams = {}) =>
    getJson<ListEnvelope<TransferListItem>>(
      `${BASE}/transfers${qs({
        page: p.page ?? 1, per_page: p.per_page ?? 15,
        sort_by: p.sort_by ?? "created_ts", sort_order: p.sort_order ?? "desc",
      })}`,
      "Failed to load transfers.",
    ),

  getTransfer: (id: number) =>
    getJson<TransferDetail>(`${BASE}/transfers/${id}`, "Failed to load transfer."),

  // Resolve a transfer by its challan number (Receive/GRN search). Mirrors the
  // production getTransferByNumber: list by challan_no, then fetch full detail.
  getTransferByNumber: async (challanNo: string): Promise<TransferDetail | null> => {
    const list = await getJson<ListEnvelope<TransferListItem>>(
      `${BASE}/transfers${qs({ challan_no: challanNo, per_page: 1 })}`,
      "Failed to search transfer.",
    );
    if (!list.records.length) return null;
    return getJson<TransferDetail>(`${BASE}/transfers/${list.records[0].id}`, "Failed to load transfer.");
  },

  getTransferIns: (p: ListParams = {}) =>
    getJson<ListEnvelope<TransferInRecord>>(
      `${BASE}/transfer-in${qs({
        page: p.page ?? 1, per_page: p.per_page ?? 15,
        sort_by: p.sort_by ?? "created_at", sort_order: p.sort_order ?? "desc",
      })}`,
      "Failed to load transfer INs.",
    ),

  getTransferIn: (id: number) =>
    getJson<TransferInDetail>(`${BASE}/transfer-in/${id}`, "Failed to load transfer IN."),

  getPendingStock: (params: { company?: string; search?: string; from_date?: string; to_date?: string } = {}) =>
    getJson<PendingStockResponse>(`${BASE}/pending-stock${qs(params)}`, "Failed to load pending stock."),

  // Sync, on demand: records in-transit rows for dispatched transfers that have none,
  // copying their boxes' details, leaving out boxes that went on since or that IMS took in.
  // Record only — the stock tables (kept by IMS) are never changed.
  backfillPendingStock: () =>
    mutate<BackfillResult>(`${BASE}/pending-stock/backfill`, "POST", "Failed to sync pending stock."),

  getInnerColdList: (p: ListParams = {}) =>
    getJson<ListEnvelope<InnerColdChallan>>(
      `${BASE}/inner-transfer/list${qs({ page: p.page ?? 1, per_page: p.per_page ?? 15 })}`,
      "Failed to load inner cold transfers.",
    ),

  // ── Request flow (migration 121) ──
  // The store team of the supplying warehouse accepts (→ it goes to the inventory managers)
  // or rejects with a reason (the request is closed).
  acceptRequest: (id: number) =>
    postJson<TransferRequest>(`${BASE}/requests/${id}/accept`, {}, "Failed to accept the request."),
  storeRejectRequest: (id: number, reason: string) =>
    postJson<TransferRequest>(`${BASE}/requests/${id}/store-reject`, { reason }, "Failed to reject the request."),
  // Or holds it with a reason (migration 127): it stays Pending, and the store can still
  // accept or reject it.
  storeHoldRequest: (id: number, reason: string) =>
    postJson<TransferRequest>(`${BASE}/requests/${id}/store-hold`, { reason }, "Failed to put the request on hold."),
  // An inventory manager approves (the store may then scan and send) or rejects with a reason.
  approveRequest: (id: number) =>
    postJson<TransferRequest>(`${BASE}/requests/${id}/approve`, {}, "Failed to approve the request."),
  rejectRequest: (id: number, reason: string) =>
    postJson<TransferRequest>(`${BASE}/requests/${id}/reject`, { reason }, "Failed to reject the request."),
  // Or holds an Accepted one with a reason (it turns On Hold and can still be approved or
  // rejected).
  holdRequest: (id: number, reason: string) =>
    postJson<TransferRequest>(`${BASE}/requests/${id}/hold`, { reason }, "Failed to put the request on hold."),

  deleteRequest: (id: number) =>
    mutate<{ success: boolean; message: string }>(`${BASE}/requests/${id}`, "DELETE", "Failed to delete request."),

  // Deletes the transfer and its in-transit / receipt records, which frees its boxes for
  // another transfer. Nothing is put back into stock (record only).
  deleteTransfer: (id: number) =>
    mutate<{ success: boolean; message: string }>(`${BASE}/transfers/${id}`, "DELETE", "Failed to delete transfer."),

  deleteTransferIn: (id: number) =>
    mutate<{ success: boolean; message: string }>(`${BASE}/transfer-in/${id}`, "DELETE", "Failed to delete transfer IN."),

  // Deleting an inner cold challan undoes it: every cold-stock row it changed gets its old
  // lot, location, cartons, weight and value back, and the rows it added are removed, in
  // one transaction. Refused (409) when one of those rows has changed since.
  deleteInnerCold: (challanNo: string) =>
    mutate<{ success: boolean; message: string }>(
      `${BASE}/inner-transfer/${encodeURIComponent(challanNo)}`, "DELETE", "Failed to delete inner cold transfer."),

  // Relabels lots inside one cold store (header.from_warehouse): each line acts on its
  // picked row (stock_record_id), then on rows of the same lot group at that store whose
  // boxes are there by their latest transfer. A move to another cold store is refused (409:
  // that has to be an inter-unit transfer); so is a store the user is not assigned to.
  createInnerTransfer: (body: InnerTransferCreateBody) =>
    postJson<InnerTransferResult>(`${BASE}/inner-transfer`, body, "Failed to submit inner cold transfer."),

  getInnerTransfer: (challanNo: string) =>
    getJson<InnerTransferDetail>(
      `${BASE}/inner-transfer/${encodeURIComponent(challanNo)}`, "Failed to load inner cold transfer."),

  // ── Receive lifecycle ──
  getPendingByTransferOut: (transferOutId: number) =>
    getJson<PendingLookup>(`${BASE}/transfer-in/pending/by-transfer-out/${transferOutId}`, "Failed to load pending receipt."),

  createPendingTransferIn: (body: {
    transfer_out_id: number; grn_number: string; receiving_warehouse: string;
    received_by: string; box_condition?: string; condition_remarks?: string;
  }) => postJson<TransferInDetail>(`${BASE}/transfer-in/pending`, body, "Failed to start receipt."),

  acknowledgeBox: (headerId: number, body: AcknowledgeBoxInput) =>
    postJson<{ box_id: string; reconciliation?: unknown }>(`${BASE}/transfer-in/${headerId}/acknowledge`, body, "Failed to acknowledge box."),

  acknowledgeBatch: (headerId: number, boxes: AcknowledgeBoxInput[]) =>
    postJson<AckBatchResult>(`${BASE}/transfer-in/${headerId}/acknowledge-batch`, boxes, "Failed to acknowledge boxes."),

  // Takes a box off a pending receipt. `transactionNo` names which of two boxes sharing the
  // box id goes; a server that does not read it takes off every receipt row of that box id.
  unacknowledgeBox: (headerId: number, boxId: string, transactionNo?: string | null) =>
    mutate<{ success: boolean }>(
      `${BASE}/transfer-in/${headerId}/acknowledge/${encodeURIComponent(boxId)}${qs({ transaction_no: transactionNo })}`,
      "DELETE", "Failed to un-acknowledge box."),

  finalizeTransferIn: (headerId: number, body: { box_condition?: string; condition_remarks?: string }) =>
    postJson<TransferInDetail>(`${BASE}/transfer-in/${headerId}/finalize`, body, "Failed to finalize receipt."),

  reopenTransferIn: (headerId: number, reason?: string) =>
    postJson<TransferInDetail>(`${BASE}/transfer-in/${headerId}/reopen`, { reason }, "Failed to re-open receipt."),

  closeTransferInWithShortage: (headerId: number, shortage_reason?: string) =>
    postJson<TransferInDetail & { shortage_written_off?: number }>(
      `${BASE}/transfer-in/${headerId}/close-with-shortage`, { shortage_reason }, "Failed to close with shortage."),

  editTransferIn: (headerId: number, body: {
    grn_number?: string; receiving_warehouse?: string; box_condition?: string; condition_remarks?: string;
    boxes?: { box_id: string; lot_number?: string; article?: string; net_weight?: number; gross_weight?: number }[];
  }) => putJson<TransferInDetail>(`${BASE}/transfer-in/${headerId}`, body, "Failed to edit receipt."),

  // ── New Request (doc 05) ──
  getWarehouseSites: () =>
    getJson<WarehouseSite[]>(`${BASE}/dropdowns/warehouse-sites?active_only=true`, "Failed to load warehouses."),

  categorialSearch: (search: string, limit = 200) =>
    getJson<CategorialSearchResponse>(`${BASE}/categorial-search${qs({ search, limit })}`, "Search failed."),

  categorialDropdown: (p: { material_type?: string; item_category?: string; sub_category?: string; search?: string; limit?: number } = {}) =>
    getJson<CategorialDropdownResponse>(`${BASE}/categorial-dropdown${qs({ ...p, limit: p.limit ?? 500 })}`, "Failed to load options."),

  createRequest: (body: RequestCreateBody) =>
    postJson<TransferRequest>(`${BASE}/requests`, body, "Failed to create request."),
  // Edit a Pending request (its raiser or an admin): the whole form, as on create; the
  // request number, raiser and status stay.
  updateRequest: (id: number, body: RequestCreateBody) =>
    putJson<TransferRequest>(`${BASE}/requests/${id}`, body, "Failed to save request."),

  // ── Transfer OUT create / update (docs 07 / 08) ──
  // Record only: each box's stock row is copied onto the transfer, never deducted. Before
  // anything is written the server refuses with a 409: a box whose latest transfer has not
  // left it at this dispatch's From site (still in transit, received at another site, or
  // written off as short; on update the transfer's own boxes don't count), and, for a
  // request's dispatch, a box the request doesn't take (another article, another lot, or
  // over the line's qty) or no box at all ("Scan at least one box before sending.").
  createTransfer: (body: TransferCreateBody) =>
    postJson<TransferDetail>(`${BASE}/transfers`, body, "Failed to create transfer."),

  updateTransfer: (id: number, body: TransferCreateBody) =>
    putJson<TransferDetail>(`${BASE}/transfers/${id}`, body, "Failed to update transfer."),

  // ── Scan & send: save on scan ──
  // Every box scanned for a request is saved at once. The first scan of an Approved request
  // creates its transfer (as createTransfer would, with that one box; the transport is
  // required, else 409) and marks the request Transferred; each later scan adds its box to
  // that transfer. The server refuses (409) what createTransfer refuses — a box the request
  // doesn't take, or one not available at the request's From site — and a box already on
  // the transfer, or a transfer received at its destination. Only scanned boxes are in
  // transit: the transfer is Dispatch once its boxes reach the request's qty, else Partial.
  scanBox: (requestId: number, body: ScanBoxBody) =>
    postJson<ScanResult>(`${BASE}/requests/${requestId}/scan`, body, "Failed to save the box."),

  // Only for a request's transfer that has not been received. Taking off its last box (or
  // all of them) deletes the transfer and puts the request back to Approved (cancelled).
  removeTransferBoxes: (transferId: number, body: RemoveBoxesBody) =>
    postJson<RemoveBoxesResult>(`${BASE}/transfers/${transferId}/remove-boxes`, body, "Failed to remove the box."),

  // A box's weights on a request's transfer (422 when negative, or net > gross while gross > 0).
  updateTransferBoxWeights: (transferId: number, body: BoxWeightsBody) =>
    patchJson<SavedTransferBox>(`${BASE}/transfers/${transferId}/boxes`, body, "Failed to save the weights."),

  // Vehicle, driver and approval authority of a request's transfer, each non-blank (422).
  updateTransferTransport: (transferId: number, body: TransportBody) =>
    patchJson<TransportResult>(`${BASE}/transfers/${transferId}/transport`, body, "Failed to save the transfer information."),

  // In-transit (pending) qty + per-challan breakdown for a lot+item (cold picker hover).
  pendingByLot: (p: { lot_no?: string; item_description?: string; from_site?: string; from_company?: string }) =>
    getJson<PendingByLotResult>(`${BASE}/pending-stock/by-lot${qs(p)}`, "Failed to load in-transit stock."),

  // Box lookups for the transfer-OUT form (manual entry by box number or box ID, and the box
  // QR: an IMS TR- / BE- code or an ERP Material In label). Read only. The by-number and
  // by-id lookups search the IMS stock tables first and ERP Material In (po_box) only when
  // they miss; a Material In box number restarts in every lot section, so one that matches
  // more than one box is a 409 asking for the box ID or the QR. The box's latest transfer
  // decides whether it can go on this one, from `fromWarehouse` (the dispatch's From site):
  // none, or Received at that site with the box acknowledged on the receipt, lets it go on
  // (an onward transfer); one still in transit, Received at another site, or Received with
  // the box written off as short is refused with a 409 naming the challan ("Box … is
  // already on challan … (in transit)", "Box … was received at … on challan …; send it
  // from …", "Box … did not arrive on challan … (written off as short)"). Without
  // `fromWarehouse` any transfer refuses it. The thrown Error carries the server's text for
  // the form to show.
  boxLookupByNumber: (company: string, boxNumber: number, transactionNo: string, fromWarehouse?: string | null) =>
    getJson<BoxLookupResult>(
      `${BASE}/box-lookup/${encodeURIComponent(company)}${qs({ box_number: boxNumber, transaction_no: transactionNo, from_warehouse: fromWarehouse })}`,
      "Box not found.",
    ),
  boxLookupById: (company: string, boxId: string, transactionNo: string, fromWarehouse?: string | null) =>
    getJson<BoxLookupResult>(
      `${BASE}/box-lookup-by-id/${encodeURIComponent(company)}${qs({ box_id: boxId, transaction_no: transactionNo, from_warehouse: fromWarehouse })}`,
      "Box not found.",
    ),
  bulkEntryBoxLookup: (company: string, boxId: string, transactionNo: string, fromWarehouse?: string | null) =>
    getJson<BoxLookupResult>(
      `${BASE}/bulk-entry-box-lookup/${encodeURIComponent(company)}${qs({ box_id: boxId, transaction_no: transactionNo, from_warehouse: fromWarehouse })}`,
      "Box not found.",
    ),
};

// ── Transfer OUT create types (doc 07) ──
export interface TransferLineCreateInput {
  material_type: string;
  item_category: string;
  sub_category: string;
  item_description: string;
  quantity?: string;
  uom?: string;
  pack_size?: string;
  unit_pack_size?: string | null;
  net_weight?: string | null;
  total_weight?: string | null;
  batch_number?: string | null;
  lot_number?: string | null;
  vakkal?: string | null;
}

export interface TransferBoxCreateInput {
  box_number: number;
  box_id?: string | null;
  article: string;
  lot_number?: string | null;
  batch_number?: string | null;
  transaction_no?: string | null;
  net_weight: string;
  gross_weight: string;
}

export interface TransferCreateBody {
  header: {
    challan_no?: string | null;
    stock_trf_date: string; // DD-MM-YYYY
    from_warehouse: string;
    to_warehouse: string;
    vehicle_no: string;
    driver_name?: string | null;
    approved_by?: string | null;
    remark?: string | null;
    // Optional (backend migration 122 made the column nullable); a request's transfer has none.
    reason_code?: string | null;
  };
  // With a request_id (on create, or the transfer's own on an edit) the server locks the
  // dispatch to the approved request: the route must be the request's (else 409), and the
  // lines, remark and reason code come from the request, so these lines are ignored (at
  // least one is still required). The boxes must be ones the request's lines take (see
  // transferBoxMatch.ts), and at least one, else 409. An edit never changes a transfer's
  // request_id.
  lines: TransferLineCreateInput[];
  boxes?: TransferBoxCreateInput[];
  request_id?: number | null;
}

// ── Scan & send (save on scan) types ──
export interface TransportBody {
  vehicle_no: string;
  driver_name: string;
  approved_by: string;
}

export interface ScanBoxBody {
  // Used only by the scan that creates the transfer (route, lines and remark are the
  // request's); a scan that adds to it leaves its header as it is.
  header: TransportBody & {
    challan_no?: string | null;
    stock_trf_date?: string | null; // DD-MM-YYYY
  };
  box: TransferBoxCreateInput;
}

/** A box as the transfer stores it. */
export interface SavedTransferBox {
  box_number: number;
  box_id?: string | null;
  transaction_no?: string | null;
  article: string;
  lot_number?: string | null;
  batch_number?: string | null;
  net_weight: string | number;
  gross_weight: string | number;
}

export interface ScanResult {
  transfer_id: number;
  challan_no: string;
  status: string;          // "Dispatch" | "Partial"
  box_count: number;       // real boxes on the transfer
  created: boolean;        // this scan created the transfer
  box: SavedTransferBox;
}

export interface TransferBoxKey {
  box_id: string;
  transaction_no: string;
}

export type RemoveBoxesBody = { boxes: TransferBoxKey[] } | { all: true };

export type RemoveBoxesResult =
  | { cancelled: true; request_status: string }
  | { cancelled: false; transfer_id: number; status: string; box_count: number };

export interface BoxWeightsBody extends TransferBoxKey {
  net_weight: number;
  gross_weight: number;
}

export interface TransportResult extends TransportBody {
  transfer_id: number;
}

// Box-lookup response (shared shape for manual / TR- / BE- lookups). A box found in ERP
// Material In also carries the optional fields after `count`; an IMS box has none of them.
export interface LookupBox {
  box_id?: string | null;
  transaction_no?: string | null;
  box_number?: number | null;
  article_description?: string | null;
  item_description?: string | null;
  sku_id?: number | string | null;
  item_category?: string | null;
  sub_category?: string | null;
  material_type?: string | null;
  net_weight?: number | null;
  gross_weight?: number | null;
  lot_number?: string | null;
  batch_number?: string | null;
  uom?: string | null;
  quantity_units?: number | string | null;
  packaging_type?: string | null;
  count?: number | null;
  // "material_in" for a box from ERP Material In (po_box).
  source?: string | null;
  // The PO's company (cfpl / cdpl).
  company?: string | null;
  // The PO's warehouse (the site it was received into), by canonical name; null when blank.
  inward_site?: string | null;
  po_number?: string | null;
  // The PO line's Tally item name, as the box's label prints it.
  tally_name?: string | null;
  // How the article was chosen: "exact" (an item-master name equal to the Tally name),
  // "matched" (the item-master name the PO line was matched to) or "tally" (the Tally name).
  article_basis?: string | null;
}

export interface BoxLookupResult {
  success: boolean;
  box: LookupBox;
}

// ── Pending-by-lot (cold picker "+N in transit" hover) ──
export interface PendingByLotTransfer {
  transfer_out_id: number;
  challan_no: string;
  dispatched_at?: string | null;
  from_site?: string | null;
  to_site?: string | null;
  from_storage_type?: string | null;
  to_storage_type?: string | null;
  box_count: number;
  cartons: number;
  weight_kg: number;
  dispatched_by?: string | null;
  vehicle_no?: string | null;
  driver_name?: string | null;
  approved_by?: string | null;
  remark?: string | null;
  reason_code?: string | null;
  transfer_status?: string | null;
  has_variance: boolean;
  updated_ts?: string | null;
}

export interface PendingByLotResult {
  pending_cartons: number;
  pending_kg: number;
  box_count: number;
  transfers: PendingByLotTransfer[];
}

// ── New Request types (doc 05) ──
export interface WarehouseSite {
  id: number;
  site_code: string;
  site_name?: string | null;
  is_active?: boolean | null;
}

export interface CategorialSearchItem {
  id: number;
  item_description: string;
  material_type?: string | null;
  group?: string | null;
  sub_group?: string | null;
  uom?: number | null;
}

export interface CategorialSearchResponse {
  items: CategorialSearchItem[];
  meta: { total_items?: number; has_more?: boolean; [k: string]: unknown };
}

export interface CategorialDropdownResponse {
  selected: { material_type?: string | null; item_category?: string | null; sub_category?: string | null };
  options: {
    material_types: string[];
    item_categories: string[];
    sub_categories: string[];
    item_descriptions: string[];
    uom_values: (number | null)[];
  };
  meta: Record<string, unknown>;
}

export interface ArticleCreateInput {
  material_type: string;
  item_category: string;
  sub_category: string;
  item_description: string;
  quantity?: string;
  uom?: string;
  pack_size?: string;
  unit_pack_size?: string | null;
  net_weight?: string;
  total_weight?: string | null;
  lot_number?: string | null;
}

export interface RequestCreateBody {
  form_data: {
    request_date: string;
    from_warehouse: string;
    to_warehouse: string;
    reason_description: string;
  };
  article_data: ArticleCreateInput[];
  computed_fields?: { request_no?: string };
}
