// Job-Work API client — material sent OUT to a job worker (de-seeding, dicing,
// cracking, stuffing, vacuum packaging, slicing) against a delivery challan, and the
// processed material received back IN.
//
// CONTRACT-FIRST. Only `createOut` (POST /out) is built in server_replica so far —
// every other call here still 404s until it lands. The shapes below are ported from
// the production surface so the backend has an exact spec to build against:
//   legacy_backend/services/ims_service/jobwork_models.py   (jb_materialout_header /
//     jb_materialout_lines / jb_work_inward_receipt / jb_work_inward_lines)
//   legacy_backend/services/ims_service/job_work_server.py  (the routes mirrored here)
// Base path follows the rebuild's convention (/api/v1/<module>), NOT legacy's /job-work.
//
// Callers should treat a failure as "not built yet" rather than a hard error — see
// isNotBuiltYet() below.

import { apiFetch, readApiErrorMessage } from "./auth";

const BASE = "/api/v1/job-work";

// ── Header / lines ──────────────────────────────────────────────────────────
/** Party the material is dispatched to. Mirrors jb_materialout_header.dispatch_to. */
export interface JobWorkParty {
  name: string;
  address: string;
  state?: string;
  city?: string;
  pin_code?: string;
  contact_company?: string;
  contact_mobile?: string;
  email?: string;
  sub_category?: string;
}

/** One dispatched article. Weight columns are strings in the source schema. */
export interface JobWorkLine {
  sl_no: number;
  item_description: string;
  material_type?: string | null;
  item_category?: string | null;
  sub_category?: string | null;
  quantity_kgs: number;
  quantity_boxes: number;
  rate_per_kg?: number | null;
  amount?: number | null;
  uom?: string | null;
  case_pack?: string | null;
  net_weight?: string | null;
  total_weight?: string | null;
  batch_number?: string | null;
  lot_number?: string | null;
  manufacturing_date?: string | null;
  expiry_date?: string | null;
  line_remarks?: string | null;
  cold_unit?: string | null;
  item_mark?: string | null;
  /** Set when the line came from a scanned cold-storage box. */
  box_id?: string | null;
  transaction_no?: string | null;
  hsn_sac?: string | null;
  gst_rate?: string | null;
  /** Read-only. True when this line's box was found in cold storage and removed
   *  by the dispatch. False on a scanned line means the box was already gone. */
  cold_deducted?: boolean;
}

export type JobWorkStatus = "sent" | "partial" | "closed" | "cancelled";

export interface JobWorkHeader {
  id: number;
  challan_no: string;
  job_work_date?: string | null;
  from_warehouse?: string | null;
  to_party?: string | null;
  party_address?: string | null;
  party_state?: string | null;
  party_city?: string | null;
  party_pin_code?: string | null;
  party_contact_company?: string | null;
  party_contact_mobile?: string | null;
  party_email?: string | null;
  sub_category?: string | null;
  contact_person?: string | null;
  contact_number?: string | null;
  purpose_of_work?: string | null;
  expected_return_date?: string | null;
  vehicle_no?: string | null;
  driver_name?: string | null;
  authorized_person?: string | null;
  remarks?: string | null;
  e_way_bill_no?: string | null;
  dispatched_through?: string | null;
  type: "OUT";
  status: JobWorkStatus | string;
  dispatch_to?: JobWorkParty | null;
  created_by?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface JobWorkRecord extends JobWorkHeader {
  lines: JobWorkLine[];
  /** Present on detail reads once material has come back. */
  inward_receipts?: JobWorkInwardReceipt[];
  /** Returned by createOut: how many boxes this dispatch actually removed from
   *  cold storage. Fewer than the number of scanned lines means some boxes were
   *  already gone — dispatched on paper but never deducted. Worth surfacing. */
  cold_boxes_deducted?: number;
}

// ── Inward (material back from the job worker) ──────────────────────────────
export interface JobWorkInwardLine {
  sl_no: number;
  item_description: string;
  sent_kgs: number;
  sent_boxes: number;
  finished_goods_kgs: number;
  finished_goods_boxes: number;
  waste_kgs: number;
  waste_type?: string | null;
  rejection_kgs: number;
  rejection_boxes: number;
  line_remarks?: string | null;
  process_type?: string | null;
  min_loss_pct?: number | null;
  max_loss_pct?: number | null;
  waste_with_partial?: boolean;
  single_shot?: boolean;
}

export interface JobWorkInwardReceipt {
  id: number;
  ir_number: string;
  challan_no?: string | null;
  header_id: number;
  receipt_date?: string | null;
  receipt_type: "partial" | "final" | string;
  vehicle_no?: string | null;
  driver_name?: string | null;
  inward_warehouse?: string | null;
  remarks?: string | null;
  created_by?: string | null;
  created_at?: string | null;
  lines: JobWorkInwardLine[];
}

// ── Create payloads ─────────────────────────────────────────────────────────
export interface JobWorkCreateBody {
  header: Omit<JobWorkHeader, "id" | "created_at" | "updated_at" | "status" | "type"> & {
    type?: "OUT";
  };
  dispatch_to: JobWorkParty;
  line_items: JobWorkLine[];
}

export interface JobWorkListParams {
  page?: number;
  per_page?: number;
  search?: string;
  status?: string;
  from_date?: string;
  to_date?: string;
  party?: string;
}

export interface JobWorkListResponse {
  records: JobWorkRecord[];
  total: number;
  page: number;
  per_page: number;
}

// ── SKU lookup (article picker) ─────────────────────────────────────────────
export interface JobWorkSku {
  sku_id?: number | null;
  particulars: string;
  item_type?: string | null;
  item_group?: string | null;
  sub_group?: string | null;
  uom?: string | null;
  hsn_sac?: string | null;
  gst_rate?: string | null;
}

// ── Transport ───────────────────────────────────────────────────────────────
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

/** True when a call failed because the job-work backend does not exist yet, rather
 *  than because the request was bad. Lets pages show "not built" instead of an error. */
export function isNotBuiltYet(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err ?? "");
  return /\b404\b|not found|cannot (get|post)|failed to fetch|networkerror/i.test(m);
}

export const JobWorkApi = {
  // ── Material OUT ──
  list: (p: JobWorkListParams = {}) =>
    getJson<JobWorkListResponse>(`${BASE}/list${qs(p as Record<string, string | number>)}`, "Failed to load job-work records."),

  get: (recordId: number) =>
    getJson<JobWorkRecord>(`${BASE}/${recordId}`, "Failed to load the job-work record."),

  getByChallan: (challanNo: string) =>
    getJson<JobWorkRecord>(`${BASE}/out/${encodeURIComponent(challanNo)}`, "Challan not found."),

  searchOut: (search: string) =>
    getJson<JobWorkListResponse>(`${BASE}/out/search${qs({ search })}`, "Search failed."),

  createOut: (body: JobWorkCreateBody) =>
    postJson<JobWorkRecord>(`${BASE}/out`, body, "Failed to save the job-work challan."),

  updateOut: (recordId: number, body: JobWorkCreateBody) =>
    putJson<JobWorkRecord>(`${BASE}/out/${recordId}`, body, "Failed to update the job-work challan."),

  // ── Material IN ──
  listInward: (headerId?: number) =>
    getJson<{ records: JobWorkInwardReceipt[] }>(`${BASE}/material-in/list${qs({ header_id: headerId })}`, "Failed to load receipts."),

  getInward: (irId: number) =>
    getJson<JobWorkInwardReceipt>(`${BASE}/material-in/${irId}`, "Receipt not found."),

  // ── Article picker ──
  skuSearch: (search: string) =>
    getJson<{ records: JobWorkSku[] }>(`${BASE}/all-sku-search${qs({ search })}`, "Item search failed."),

  skuDetail: (description: string) =>
    getJson<JobWorkSku>(`${BASE}/sku-detail${qs({ description })}`, "Item not found."),
};

// ── Issuing company block printed on the challan (from the production payload) ──
export const JOB_WORK_COMPANY = {
  name: "CANDOR DATES PRIVATE LIMITED",
  address: "W-202A, MIDC, TTC INDUSTRIAL AREA, KHAIRNE, MIDC, NAVI MUMBAI, THANE 400710",
  fssai_no: "11522998001846",
  gstin: "27AAKCC3130A1Z9",
  state: "Maharashtra",
  state_code: "27",
  email: "accounts@candorfoods.in",
} as const;

/** Process types offered for the job worker's sub-category. */
export const JOB_WORK_SUB_CATEGORIES = [
  "De seeding", "Dicing", "Cracking", "Stuffing", "Vacuum Packaging", "Slicing",
] as const;

/** Challan number format used by the production form: JW-<YYYYMMDDHHMMSS>. */
export function generateChallanNo(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `JW-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
