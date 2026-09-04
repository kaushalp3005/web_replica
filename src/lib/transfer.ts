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
  reject_reason?: string | null;
  created_by?: string | null;
  created_ts?: string | null;
  rejected_ts?: string | null;
  updated_at?: string | null;
  lines: RequestLine[];
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
  /** Cold-storage carton mark. Printed on the delivery challan; only populated on
   *  legacy-written rows — neither dispatch form captures it yet. */
  vakkal?: string | null;
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

/** One unit of a BOX-LESS line, parked "In Transit" by the backend's park_lines.
 *  A manually-keyed (DIRECT) line ships without a scanned carton, so it writes no
 *  `boxes` row — these are what the dispatch actually put on the vehicle.
 *  `transfer_line_id` is decoded server-side from the synthetic "LINE-<id>-<n>"
 *  box_id, so a unit can be counted against the item it belongs to. */
export interface ParkedUnit {
  transfer_line_id?: number | null;
  box_id: string;
  article: string;
  lot_number: string;
  net_weight: string;
  gross_weight: string;
}

export interface TransferDetail extends TransferHeader {
  lines: TransferLine[];
  boxes: TransferBox[];
  grn_records: GrnRecord[];
  /** Empty on a scanned dispatch, and empty again once the receipt picks the rows. */
  parked_units?: ParkedUnit[];
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
  received_by: string;
  received_at?: string | null;
  box_condition?: string | null;
  condition_remarks?: string | null;
  status: string;
  created_at?: string | null;
  updated_at?: string | null;
  total_boxes_scanned: number;
}

// Article+lot rollup returned by getTransferIn(id, { summary: true }) instead of
// the raw boxes. A GRN routinely holds 400-800 boxes; anything that only renders
// groups should ask for these.
export interface TransferInLine {
  article: string;
  lot_number?: string | null;
  box_count: number;
  net_weight: number;
  gross_weight: number;
  unmatched: number;
}

export interface TransferInDetail extends TransferInRecord {
  boxes: TransferInBox[];
  // Populated only in summary mode — `boxes` is empty there, and vice versa.
  lines?: TransferInLine[];
}

// One printed sticker. `entry_key` is the receive screen's stable per-row key —
// box_id is the value being assigned, so it cannot key its own assignment.
export interface QrAssignmentBody {
  transfer_out_id: number;
  transaction_no: string;
  assignments: { entry_key: string; box_id: string }[];
}

export interface QrAssignments {
  /** Only the default the screen continues minting under — NOT the transaction of
   *  every row. Rows of one dispatch can legitimately carry different ones. */
  transaction_no: string;
  box_ids: Record<string, string>;
  /** entry_key -> the transaction that row's sticker was actually printed under. */
  transactions?: Record<string, string>;
}

// What POST /transfer-in/{id}/finalize returns. `remaining_in_transit > 0` means
// the receipt posted what arrived but is NOT closed: the outstanding boxes are
// still on the in-transit bridge and the GRN is still Pending.
// Cold rows this receipt posted, read back from <company>_cold_stocks and carrying the
// storage detail the receipt header has no columns for. Empty for a warehouse
// destination. Free-form because the row shape is the externally-managed cold table's.
export interface ColdStorageRow {
  box_id?: string | null;
  lot_no?: string | null;
  vakkal?: string | null;
  item_description?: string | null;
  storage_location?: string | null;
  /** Which cold table the row came from. */
  _source_table?: string;
  [key: string]: unknown;
}

export interface TransferInFinalizeResult extends TransferInDetail {
  remaining_in_transit: number;
  boxes_posted: number;
}

// ── Bulk one-shot receipt (POST /transfer-in) ────────────────────────────────
// Identity + observed weights ONLY. article / batch_number / lot_number /
// transaction_no are deliberately absent: the server resolves them from the
// dispatch row, so a stale client copy can no longer overwrite what the challan
// said. Do not add them back.
export interface BulkTransferInBox {
  /** The sticker actually scanned - the ordinary claim key. */
  box_id: string;
  /**
   * interunit_transfer_boxes.id. Send it whenever the screen knows which dispatch
   * row this scan belongs to. It is the claim path that survives a RELABEL (the
   * received sticker differs from the dispatched one); omit it and a relabelled
   * carton stays In Transit instead of posting.
   */
  dispatch_box_id?: number | null;
  /** Weighed at receipt - legitimately differs from the dispatched figure. */
  net_weight?: number | null;
  gross_weight?: number | null;
  is_matched?: boolean;
  issue?: Record<string, unknown> | null;
  line_index?: number | null;
}

// Cold-storage detail captured on a cold-destination receipt. The server used to take
// these as an untyped dict and read them through a lookup that returned undefined for
// anything it could not find - so `lot_number` instead of `lot_no` wrote a cold-stock
// row with that column silently NULL. Both ends are typed now: a wrong key is a compile
// error here and a 422 there.
export interface ColdStorageBoxDetail {
  box_id?: string | null;
  transaction_no?: string | null;
  weight_kg?: number | null;
}

export interface ColdStorageItem {
  /** Chooses the destination table (cfpl/cdpl_cold_stocks). An item without it is skipped. */
  cold_company?: "cfpl" | "cdpl" | null;
  item_description?: string | null;
  inward_dt?: string | null;
  unit?: string | null;
  vakkal?: string | null;
  lot_no?: string | null;
  item_mark?: string | null;
  no_of_cartons?: number | null;
  weight_kg?: number | null;
  group_name?: string | null;
  item_subgroup?: string | null;
  storage_location?: string | null;
  exporter?: string | null;
  rate?: number | null;
  value?: number | null;
  spl_remarks?: string | null;
  box_details?: ColdStorageBoxDetail[] | null;
}

// `received_by` is absent on purpose - the server takes it from the JWT.
export interface BulkTransferInInput {
  transfer_out_id: number;
  grn_number: string;
  receiving_warehouse: string;
  box_condition?: string;
  condition_remarks?: string | null;
  scanned_boxes: BulkTransferInBox[];
  cold_storage_items?: ColdStorageItem[] | null;
}

// ── Pending stock (in-transit) ────────────────────────────────────────────────
// One parked box of a dispatch, as GET /pending-stock/boxes/by-transfer-out
// returns it. These rows ARE the dispatch's declaration - create_service parked
// exactly one per committed box - so they are the authoritative scan checklist.
// Two ids only: `box_id` (the sticker, or a LINE- sentinel) and `dispatch_box_id`
// (interunit_transfer_boxes.id, the relabel-safe claim path). The pending row's
// own surrogate id is deliberately not returned.
export interface PendingBoxRow {
  box_id: string;
  dispatch_box_id: number | null;
  transaction_no: string | null;
  article: string | null;
  lot_number: string | null;
  batch_number: string | null;
  net_weight: number | null;
  gross_weight: number | null;
  /** A quantity-only row: no physical sticker was dispatched, so an id must be minted. */
  synthetic: boolean;
}

export interface PendingBoxes {
  transfer_out_id: number;
  total: number;
  boxes: PendingBoxRow[];
}

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
export interface InnerTransferLineInput {
  stock_record_id: number | null;
  item_category?: string | null;
  item_description?: string | null;
  net_weight?: number | null;
  quantity: number;
  old_lot_number: string;
  new_lot_number: string;
  new_storage_location?: string | null;
}
export interface InnerTransferCreateBody {
  company?: string;
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

/** Header-only correction. Unlike TransferCreateBody this touches no lines, boxes or
 *  stock, so the backend accepts it at ANY status — including after a GRN exists, where
 *  a full PUT is refused because it would rebuild the boxes the receiver acknowledged.
 *  Only the keys you send are written; from/to are not patchable (the parked in-transit
 *  rows carry the route the boxes shipped on). */
export interface TransferHeaderPatchBody {
  stock_trf_date?: string;   // DD-MM-YYYY
  vehicle_no?: string;
  driver_name?: string | null;
  approved_by?: string | null;
  remark?: string | null;
  reason_code?: string | null;
}

// ── Box history (traceability) ──
export interface BoxHistoryEvent {
  kind: "disposition" | "transfer_out" | "transfer_in";
  when: string;
  summary: string;
  row_id?: number | null;
}
export interface BoxHistory {
  box_id: string;
  transaction_no?: string | null;
  current_state: {
    cold_stocks: Record<string, unknown>[];
    warehouse_boxes: Record<string, unknown>[];
    return_boxes: Record<string, unknown>[];
    pending_transit: Record<string, unknown>[];
  };
  dispositions: Record<string, unknown>[];
  transfer_out_boxes: Record<string, unknown>[];
  transfer_in_boxes: Record<string, unknown>[];
  timeline: BoxHistoryEvent[];
  summary: {
    in_cold_stocks: number;
    in_warehouse: number;
    in_returns: number;
    in_transit: number;
    disposition_events: number;
    active_dispositions: number;
    dispatch_events: number;
    receipt_events: number;
    /** The headline. Since the park stopped deleting source rows, a row in cold_stocks
     *  no longer means the box is on hand — branch on this, not on the counts. */
    available: boolean;
  };
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
// STBR (Scan-Time Box-ID Reconciliation) outcome, returned on every acknowledge.
// When the scanned box_id differs from the placeholder IMS picked at dispatch, the
// server remaps the pending row and reports the swap here; a detected series offset
// also propagates to the remaining siblings in the same batch.
//   noop                 nothing to reconcile (also what server_replica returns
//                        wholesale until STBR lands — see receive_service P8b-2)
//   matched              scanned id already equalled the parked one
//   overridden           pending row remapped to the scanned id
//   overridden_no_source remapped, but no source row was found to restore
//   propagated           remap applied to this box AND its siblings
// Duplicate (409) and conflict (422) arrive as HTTP errors, not as a status here.
export type ReconciliationStatus =
  | "noop" | "matched" | "overridden" | "overridden_no_source" | "propagated";

export interface BoxReconciliation {
  status: ReconciliationStatus | string;
  original_box_id?: string | null;
  actual_box_id?: string | null;
  propagated_count?: number;
  siblings?: Array<{ old: string; new: string }>;
  reconciliation_id?: number | string | null;
}

export interface AcknowledgeBoxResult {
  box_id: string;
  reconciliation?: BoxReconciliation | null;
  // True when this box completed the dispatch and the server closed the GRN.
  auto_finalized?: boolean;
}

export interface PendingLookup {
  exists: boolean;
  header: TransferInDetail | null;
}

// ── Public API ──────────────────────────────────────────────────────────────
export interface ListParams {
  page?: number;
  per_page?: number;
  sort_by?: string;
  sort_order?: string;
  /** Free text. Server-side across challan/GRN, route, vehicle, driver, status,
   *  DD-MM-YYYY date and lot number. */
  search?: string;
  status?: string;
  /** DD-MM-YYYY, inclusive. */
  from_date?: string;
  to_date?: string;
  /** Warehouse code or cold unit, applied to the side named by `warehouse_dir`. */
  warehouse?: string;
  warehouse_dir?: "all" | "from" | "to";
  /** Transfer-OUTs only: dispatched but with no GRN started ("Incoming Material").
   *  Replaces an anti-join the page used to do over the full lists. */
  awaiting_grn?: boolean;
}

export const TransferApi = {
  getRequests: (p: ListParams = {}) =>
    getJson<ListEnvelope<TransferRequest>>(
      `${BASE}/requests${qs({ page: p.page ?? 1, per_page: p.per_page ?? 15 })}`,
      "Failed to load requests.",
    ),

  getRequest: (id: number) =>
    getJson<TransferRequest>(`${BASE}/requests/${id}`, "Failed to load request."),

  // `qs` drops undefined/null/"" keys, so an unset filter is simply not sent and
  // the server default applies.
  getTransfers: (p: ListParams = {}) =>
    getJson<ListEnvelope<TransferListItem>>(
      `${BASE}/transfers${qs({
        page: p.page ?? 1, per_page: p.per_page ?? 15,
        sort_by: p.sort_by ?? "created_ts", sort_order: p.sort_order ?? "desc",
        search: p.search, status: p.status,
        from_date: p.from_date, to_date: p.to_date,
        warehouse: p.warehouse, warehouse_dir: p.warehouse_dir,
        awaiting_grn: p.awaiting_grn ? "true" : undefined,
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
        search: p.search, status: p.status,
        from_date: p.from_date, to_date: p.to_date,
        warehouse: p.warehouse, warehouse_dir: p.warehouse_dir,
      })}`,
      "Failed to load transfer INs.",
    ),

  // `summary` swaps the box array for the SQL-side article+lot rollup. Use it
  // for anything that only draws groups — the hover card was pulling 800 rows
  // to render four.
  getTransferIn: (id: number, opts: { summary?: boolean } = {}) =>
    getJson<TransferInDetail>(
      `${BASE}/transfer-in/${id}${opts.summary ? "?summary=true" : ""}`,
      "Failed to load transfer IN."),

  getPendingStock: (params: { company?: string; search?: string; from_date?: string; to_date?: string } = {}) =>
    getJson<PendingStockResponse>(`${BASE}/pending-stock${qs(params)}`, "Failed to load pending stock."),

  backfillPendingStock: () =>
    mutate<{ synced?: number; message?: string }>(`${BASE}/pending-stock/backfill`, "POST", "Failed to sync pending stock."),

  getInnerColdList: (p: ListParams = {}) =>
    getJson<ListEnvelope<InnerColdChallan>>(
      `${BASE}/inner-transfer/list${qs({ page: p.page ?? 1, per_page: p.per_page ?? 15 })}`,
      "Failed to load inner cold transfers.",
    ),

  deleteRequest: (id: number) =>
    mutate<{ success: boolean; message: string }>(`${BASE}/requests/${id}`, "DELETE", "Failed to delete request."),

  deleteTransfer: (id: number) =>
    mutate<{ success: boolean; message: string }>(`${BASE}/transfers/${id}`, "DELETE", "Failed to delete transfer."),

  deleteTransferIn: (id: number) =>
    mutate<{ success: boolean; message: string }>(`${BASE}/transfer-in/${id}`, "DELETE", "Failed to delete transfer IN."),

  deleteInnerCold: (challanNo: string) =>
    mutate<{ success: boolean; message: string }>(
      `${BASE}/inner-transfer/${encodeURIComponent(challanNo)}`, "DELETE", "Failed to delete inner cold transfer."),

  createInnerTransfer: (body: InnerTransferCreateBody) =>
    postJson<InnerTransferResult>(`${BASE}/inner-transfer`, body, "Failed to submit inner cold transfer."),

  getInnerTransfer: (challanNo: string) =>
    getJson<InnerTransferDetail>(
      `${BASE}/inner-transfer/${encodeURIComponent(challanNo)}`, "Failed to load inner cold transfer."),

  // The dispatch's parked in-transit boxes - what finalize will actually claim
  // against. Use it to corroborate the client-derived checklist rather than
  // guessing which quantity-only lines are box-backed.
  getPendingBoxes: (transferOutId: number) =>
    getJson<PendingBoxes>(
      `${BASE}/pending-stock/boxes/by-transfer-out/${transferOutId}`,
      "Failed to load the dispatch's in-transit boxes."),

  // ── Receive lifecycle ──
  getPendingByTransferOut: (transferOutId: number) =>
    getJson<PendingLookup>(`${BASE}/transfer-in/pending/by-transfer-out/${transferOutId}`, "Failed to load pending receipt."),

  createPendingTransferIn: (body: {
    transfer_out_id: number; grn_number: string; receiving_warehouse: string;
    received_by: string; box_condition?: string; condition_remarks?: string;
  }) => postJson<TransferInDetail>(`${BASE}/transfer-in/pending`, body, "Failed to start receipt."),

  // Bulk one-shot receipt: header + every scanned box + the stock post, in one
  // atomic call. Use this when the whole dispatch is scanned in a single sitting;
  // use the pending -> acknowledge -> finalize trio when the operator needs to
  // stop and resume. All-or-nothing: any refused box rolls the whole receipt back
  // (409 with a `conflicts` list), so nothing partial is ever left behind.
  createTransferIn: (body: BulkTransferInInput) =>
    postJson<TransferInFinalizeResult>(
      `${BASE}/transfer-in`, body, "Failed to record the receipt."),

  acknowledgeBox: (headerId: number, body: AcknowledgeBoxInput) =>
    postJson<AcknowledgeBoxResult>(`${BASE}/transfer-in/${headerId}/acknowledge`, body, "Failed to acknowledge box."),

  // `auto_finalized` — the acknowledge completed the dispatch, so the server
  // closed the GRN for us. The receipt is already Received; do not offer Confirm.
  acknowledgeBatch: (headerId: number, boxes: AcknowledgeBoxInput[]) =>
    postJson<{ success: boolean; count: number; conflicts: unknown[]; auto_finalized?: boolean }>(
      `${BASE}/transfer-in/${headerId}/acknowledge-batch`, boxes, "Failed to acknowledge boxes."),

  // Printed QR ids, recorded the moment they are minted — BEFORE anything is
  // acknowledged. Not a receipt and no stock effect: this exists so a page
  // reload cannot orphan a sticker already stuck on a carton.
  saveQrIds: (body: QrAssignmentBody) =>
    postJson<QrAssignments>(`${BASE}/transfer-in/qr-ids`, body, "Failed to save the QR ids."),

  getQrIds: (transferOutId: number) =>
    getJson<QrAssignments>(`${BASE}/transfer-in/qr-ids/${transferOutId}`,
      "Failed to load the saved QR ids."),

  // Backlog sweep for receipts stranded before acknowledge learned to close
  // itself: every box acknowledged, Confirm never pressed, dispatch still on the
  // in-transit bridge. Idempotent, and inherits finalize's bridge invariant.
  finalizeCompletePendingGrns: (limit?: number) =>
    postJson<{ scanned: number; finalized: number; skipped: number;
      records: { id: number; grn_number: string }[] }>(
      `${BASE}/transfer-in/finalize-complete${limit ? `?limit=${limit}` : ""}`, {},
      "Failed to sweep pending GRNs."),

  unacknowledgeBox: (headerId: number, boxId: string) =>
    mutate<{ success: boolean }>(`${BASE}/transfer-in/${headerId}/acknowledge/${encodeURIComponent(boxId)}`, "DELETE", "Failed to un-acknowledge box."),

  // Finalize honours the bridge invariant: it posts only the boxes this GRN
  // claims. When boxes are still In Transit it posts what arrived and stays
  // Pending — so `remaining_in_transit` decides whether the receipt is DONE.
  finalizeTransferIn: (headerId: number, body: { box_condition?: string; condition_remarks?: string }) =>
    postJson<TransferInFinalizeResult>(
      `${BASE}/transfer-in/${headerId}/finalize`, body, "Failed to finalize receipt."),

  reopenTransferIn: (headerId: number, reason?: string) =>
    postJson<TransferInDetail>(`${BASE}/transfer-in/${headerId}/reopen`, { reason }, "Failed to re-open receipt."),

  closeTransferInWithShortage: (headerId: number, shortage_reason?: string) =>
    postJson<TransferInDetail & { shortage_written_off?: number }>(
      `${BASE}/transfer-in/${headerId}/close-with-shortage`, { shortage_reason }, "Failed to close with shortage."),

  // Per-box edits land in THREE tables server-side: the receipt, the in-transit row,
  // and the DISPATCH's own box row (through the transfer_out_box_id FK). Omitted
  // fields are COALESCE'd — null means "leave as is", not "blank it". Weights are
  // stored numeric(x,2) on the box tables, so a third decimal is rounded.
  editTransferIn: (headerId: number, body: {
    grn_number?: string; receiving_warehouse?: string; box_condition?: string; condition_remarks?: string;
    boxes?: { box_id: string; lot_number?: string; article?: string; batch_number?: string;
              net_weight?: number; gross_weight?: number }[];
  }) => putJson<TransferInDetail>(`${BASE}/transfer-in/${headerId}`, body, "Failed to edit receipt."),

  // ── New Request (doc 05) ──
  // No UI caller: the warehouse list is a frontend constant (lib/warehouses.ts).
  // Kept because the endpoint is live and reads the real warehouse_sites table —
  // use it if a screen ever needs the DB set rather than the canonical one.
  getWarehouseSites: () =>
    getJson<WarehouseSite[]>(`${BASE}/dropdowns/warehouse-sites?active_only=true`, "Failed to load warehouses."),

  categorialSearch: (search: string, limit = 200) =>
    getJson<CategorialSearchResponse>(`${BASE}/categorial-search${qs({ search, limit })}`, "Search failed."),

  categorialDropdown: (p: { material_type?: string; item_category?: string; sub_category?: string; search?: string; limit?: number } = {}) =>
    getJson<CategorialDropdownResponse>(`${BASE}/categorial-dropdown${qs({ ...p, limit: p.limit ?? 500 })}`, "Failed to load options."),

  createRequest: (body: RequestCreateBody) =>
    postJson<TransferRequest>(`${BASE}/requests`, body, "Failed to create request."),

  // ── Transfer OUT create / update (docs 07 / 08) ──
  createTransfer: (body: TransferCreateBody) =>
    postJson<TransferDetail>(`${BASE}/transfers`, body, "Failed to create transfer."),

  updateTransfer: (id: number, body: TransferCreateBody) =>
    putJson<TransferDetail>(`${BASE}/transfers/${id}`, body, "Failed to update transfer."),

  /** Header-only correction — safe after a GRN exists (see TransferHeaderPatchBody). */
  patchTransferHeader: (id: number, body: TransferHeaderPatchBody) =>
    patchJson<TransferDetail>(`${BASE}/transfers/${id}`, body, "Failed to update transfer details."),

  /** Trace one box across inventory, in-transit, the disposition ledger and the
   *  transfers that moved it. `txn` is optional but recommended — a box_id label can
   *  repeat across inward batches. */
  boxHistory: (boxId: string, txn?: string | null) =>
    getJson<BoxHistory>(
      `${BASE}/box-history/${encodeURIComponent(boxId)}${qs({ txn: txn || undefined })}`,
      "Failed to load box history.",
    ),

  // In-transit (pending) qty + per-challan breakdown for a lot+item (cold picker hover).
  pendingByLot: (p: { lot_no?: string; item_description?: string; from_site?: string; from_company?: string }) =>
    getJson<PendingByLotResult>(`${BASE}/pending-stock/by-lot${qs(p)}`, "Failed to load in-transit stock."),

  // Box lookups for the transfer-OUT form (manual entry + TR-/BE- QR).
  boxLookupByNumber: (company: string, boxNumber: number, transactionNo: string) =>
    getJson<BoxLookupResult>(
      `${BASE}/box-lookup/${encodeURIComponent(company)}${qs({ box_number: boxNumber, transaction_no: transactionNo })}`,
      "Box not found.",
    ),
  boxLookupById: (company: string, boxId: string, transactionNo: string) =>
    getJson<BoxLookupResult>(
      `${BASE}/box-lookup-by-id/${encodeURIComponent(company)}${qs({ box_id: boxId, transaction_no: transactionNo })}`,
      "Box not found.",
    ),
  // No UI caller: boxLookupById already searches bulk_entry_boxes (and boxes_v2 and
  // rtv_boxes), so a BE- QR resolves through it. This is the same search narrowed to
  // bulk only — kept for callers that must NOT match an inward or return box.
  bulkEntryBoxLookup: (company: string, boxId: string, transactionNo: string) =>
    getJson<BoxLookupResult>(
      `${BASE}/bulk-entry-box-lookup/${encodeURIComponent(company)}${qs({ box_id: boxId, transaction_no: transactionNo })}`,
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
    reason_code?: string | null;
  };
  lines: TransferLineCreateInput[];
  boxes?: TransferBoxCreateInput[];
  request_id?: number | null;
}

// Box-lookup response (shared shape for manual / TR- / BE- lookups).
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
