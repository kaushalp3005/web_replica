// Typed client for the legacy Stores receiving endpoints (/api/v1/purchase/*).
// Mirrors the network calls in frontend_replica's po-receiving.js. Backend
// request models live in server_replica/app/modules/purchase/router.py
// (StoresHeaderUpdate, StoresLineUpdate, SectionInput/BoxInput,
// SectionUpdate/BoxUpdate). Field names here match those exactly.

import { apiFetch } from "./auth";

// ── GET /{txn} response shape (POHeaderOut → build_po_detail) ──────────────────
export interface PurchaseBox {
  box_id: string;
  box_number: number;
  net_weight?: number | null;
  gross_weight?: number | null;
  lot_number?: string | null;
  count?: number | null;
}
export interface PurchaseSection {
  line_number: number;
  section_number: number;
  lot_number?: string | null;
  box_count?: number | null;
  // Actual box count for the section (accurate even in lazy mode, where `boxes`
  // is empty). Set by the backend build_po_detail.
  total_boxes?: number | null;
  manufacturing_date?: string | null;
  expiry_date?: string | null;
  boxes: PurchaseBox[];
}
export interface PurchaseLine {
  transaction_no: string;
  line_number: number;
  sku_name?: string | null;
  particulars?: string | null;
  item_category?: string | null;
  sub_category?: string | null;
  item_type?: string | null;
  uom?: string | null;
  pack_count?: number | null;
  po_weight?: number | null;
  rate?: number | null;
  amount?: number | null;
  gst_rate?: number | null;
  carton_weight?: number | null;
  status?: string | null;
  sections: PurchaseSection[];
}
export interface PurchasePoDetail {
  transaction_no: string;
  entity: string;
  po_date?: string | null;
  po_number?: string | null;
  voucher_type?: string | null;
  vendor_supplier_name?: string | null;
  gross_total?: number | null;
  total_amount?: number | null;
  status?: string | null;
  total_lines?: number | null;
  total_boxes?: number | null;
  customer_party_name?: string | null;
  vehicle_number?: string | null;
  transporter_name?: string | null;
  lr_number?: string | null;
  source_location?: string | null;
  challan_number?: string | null;
  invoice_number?: string | null;
  grn_number?: string | null;
  system_grn_date?: string | null;
  purchased_by?: string | null;
  inward_authority?: string | null;
  warehouse?: string | null;
  lines: PurchaseLine[];
}

// ── PUT /{txn}/receive (StoresReceiveRequest) ─────────────────────────────────
export interface ReceiveHeader {
  customer_party_name?: string | null;
  vehicle_number?: string | null;
  transporter_name?: string | null;
  lr_number?: string | null;
  source_location?: string | null;
  challan_number?: string | null;
  invoice_number?: string | null;
  grn_number?: string | null;
  system_grn_date?: string | null;
  purchased_by?: string | null;
  inward_authority?: string | null;
  warehouse?: string | null;
}
export interface ReceiveLine {
  line_number: number;
  carton_weight?: number | null;
}
export interface ReceiveRequest {
  header?: ReceiveHeader | null;
  lines: ReceiveLine[];
}

// ── POST /{txn}/boxes (AddSectionsRequest) ────────────────────────────────────
export interface BoxInputPayload {
  box_id: string;
  box_number: number;
  net_weight?: number | null;
  gross_weight?: number | null;
  lot_number?: string | null;
  count?: number | null;
}
export interface AddSectionPayload {
  line_number: number;
  // When set, the backend APPENDS these boxes to this existing section instead
  // of creating a new one (the per-section "+ Add Boxes" panel).
  section_number?: number | null;
  box_count?: number | null;
  lot_number?: string | null;
  manufacturing_date?: string | null;
  expiry_date?: string | null;
  boxes: BoxInputPayload[];
}
export interface AddBoxesRequest {
  sections: AddSectionPayload[];
}

// ── PUT /{txn}/boxes (UpdateSectionsRequest) ──────────────────────────────────
export interface UpdateBoxPayload {
  box_id: string;
  box_number?: number | null;
  net_weight?: number | null;
  gross_weight?: number | null;
  lot_number?: string | null;
  count?: number | null;
}
export interface UpdateSectionPayload {
  line_number: number;
  section_number: number;
  lot_number?: string | null;
  box_count?: number | null;
  manufacturing_date?: string | null;
  expiry_date?: string | null;
  boxes: UpdateBoxPayload[];
}
export interface UpdateBoxesRequest {
  sections: UpdateSectionPayload[];
}

// ── Error helper (mirrors lib/po.ts readError) ────────────────────────────────
async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    const d = body?.detail;
    if (typeof d === "string") return d;
    if (d && typeof d === "object" && typeof d.message === "string") return d.message;
  } catch {
    /* ignore */
  }
  return `${fallback} (HTTP ${res.status})`;
}

// ── Endpoints ─────────────────────────────────────────────────────────────────
export async function getPurchasePo(
  txn: string,
  signal?: AbortSignal,
  includeBoxes = true,
): Promise<PurchasePoDetail> {
  // includeBoxes=false → sections come back with counts only (empty box arrays);
  // box rows are then loaded lazily per expanded section via listSectionBoxes.
  const qs = includeBoxes ? "" : "?include_boxes=false";
  const res = await apiFetch(`/api/v1/purchase/${encodeURIComponent(txn)}${qs}`, { signal });
  if (!res.ok) throw new Error(await readError(res, "Failed to load Purchase Order"));
  return res.json();
}

// ── Lazy per-section box loading (GET /{txn}/boxes) ───────────────────────────
export interface SectionBoxListResponse {
  boxes: PurchaseBox[];
  total: number;
  page: number;
  page_size: number;
}

/** Paginated boxes for ONE section — fetched when a section is expanded. */
export async function listSectionBoxes(
  txn: string,
  lineNumber: number,
  sectionNumber: number,
  opts: { page?: number; pageSize?: number; signal?: AbortSignal } = {},
): Promise<SectionBoxListResponse> {
  const qs = new URLSearchParams({
    line_number: String(lineNumber),
    section_number: String(sectionNumber),
    page: String(opts.page ?? 1),
    page_size: String(opts.pageSize ?? 200),
  });
  const res = await apiFetch(`/api/v1/purchase/${encodeURIComponent(txn)}/boxes?${qs.toString()}`, {
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(await readError(res, "Failed to load boxes"));
  return res.json();
}

// ── Boxes for printing (GET /{txn}/boxes/print) — all, or a box_number range ──
export interface SectionBoxPrintResponse {
  boxes: PurchaseBox[];
  total: number;
}

export async function listSectionBoxesForPrint(
  txn: string,
  lineNumber: number,
  sectionNumber: number,
  opts: { fromBox?: number; toBox?: number; signal?: AbortSignal } = {},
): Promise<SectionBoxPrintResponse> {
  const qs = new URLSearchParams({
    line_number: String(lineNumber),
    section_number: String(sectionNumber),
  });
  if (opts.fromBox != null) qs.set("from_box", String(opts.fromBox));
  if (opts.toBox != null) qs.set("to_box", String(opts.toBox));
  const res = await apiFetch(`/api/v1/purchase/${encodeURIComponent(txn)}/boxes/print?${qs.toString()}`, {
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(await readError(res, "Failed to load boxes for printing"));
  return res.json();
}

export async function saveReceive(txn: string, body: ReceiveRequest): Promise<PurchasePoDetail> {
  const res = await apiFetch(`/api/v1/purchase/${encodeURIComponent(txn)}/receive`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readError(res, "Failed to save receiving data"));
  return res.json();
}

export async function addBoxes(txn: string, body: AddBoxesRequest): Promise<PurchasePoDetail> {
  const res = await apiFetch(`/api/v1/purchase/${encodeURIComponent(txn)}/boxes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readError(res, "Failed to add boxes"));
  return res.json();
}

export async function updateBoxes(txn: string, body: UpdateBoxesRequest): Promise<PurchasePoDetail> {
  const res = await apiFetch(`/api/v1/purchase/${encodeURIComponent(txn)}/boxes`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readError(res, "Failed to update boxes"));
  return res.json();
}
