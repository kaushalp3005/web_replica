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
  scan_source?: string;
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
    postJson<{ success: boolean; count: number; conflicts: unknown[] }>(`${BASE}/transfer-in/${headerId}/acknowledge-batch`, boxes, "Failed to acknowledge boxes."),

  unacknowledgeBox: (headerId: number, boxId: string) =>
    mutate<{ success: boolean }>(`${BASE}/transfer-in/${headerId}/acknowledge/${encodeURIComponent(boxId)}`, "DELETE", "Failed to un-acknowledge box."),

  finalizeTransferIn: (headerId: number, body: { box_condition?: string; condition_remarks?: string }) =>
    postJson<TransferInDetail>(`${BASE}/transfer-in/${headerId}/finalize`, body, "Failed to finalize receipt."),

  // ── New Request (doc 05) ──
  getWarehouseSites: () =>
    getJson<WarehouseSite[]>(`${BASE}/dropdowns/warehouse-sites?active_only=true`, "Failed to load warehouses."),

  categorialSearch: (search: string, limit = 200) =>
    getJson<CategorialSearchResponse>(`${BASE}/categorial-search${qs({ search, limit })}`, "Search failed."),

  categorialDropdown: (p: { material_type?: string; item_category?: string; sub_category?: string; search?: string; limit?: number } = {}) =>
    getJson<CategorialDropdownResponse>(`${BASE}/categorial-dropdown${qs({ ...p, limit: p.limit ?? 500 })}`, "Failed to load options."),

  createRequest: (body: RequestCreateBody) =>
    postJson<TransferRequest>(`${BASE}/requests`, body, "Failed to create request."),
};

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
