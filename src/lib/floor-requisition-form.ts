// Floor requisitions — the pure half shared by the job card tab and the store
// screen: the unit a request carries, the quantity a dialog opens with and
// accepts, how quantities, times and statuses read, and which request belongs to
// which BOM article.
//
// The quantity rules and messages match the server's
// (server_replica app/modules/floor_requisition/rules.py), so a person sees before
// sending the same refusal the server would give.
//
// No React / Next imports, so this runs under plain Node for its test:
//     node src/lib/floor-requisition-form.test.ts

export type RequisitionUnit = "kg" | "pcs";
export type RequisitionStatus = "raised" | "issued" | "received" | "cancelled";

export const REQUISITION_STATUSES: readonly RequisitionStatus[] = ["raised", "issued", "received", "cancelled"];

export const STATUS_LABEL: Record<RequisitionStatus, string> = {
  raised: "Raised",
  issued: "Issued",
  received: "Received",
  cancelled: "Cancelled",
};

/** Store's reply to a raised request, from the Accept / Hold buttons on the
 *  floor_requisition_raised_store WhatsApp message (server migration 112). It is
 *  NOT a status: the request stays raised until store issues it. */
export type StoreResponse = "accepted" | "on_hold";

export const STORE_RESPONSE_LABEL: Record<StoreResponse, string> = {
  accepted: "Taken up by store",
  on_hold: "On hold at store",
};

const STORE_RESPONSE_BY: Record<StoreResponse, string> = {
  accepted: "Taken up by",
  on_hold: "Put on hold by",
};

/** "Taken up by Kaushal Patil · 17 Sep 2026, 13:05" / "Put on hold by …", or the
 *  plain label when the server sent no name; null when there is no reply. An
 *  unknown value from a newer server still reads as words. */
export function storeResponseLine(
  sr: { response: string; by: string | null; at: string | null } | null | undefined,
): string | null {
  if (!sr) return null;
  const known = sr.response === "accepted" || sr.response === "on_hold";
  const who = known
    ? (sr.by ? `${STORE_RESPONSE_BY[sr.response as StoreResponse]} ${sr.by}` : STORE_RESPONSE_LABEL[sr.response as StoreResponse])
    : `${sr.response.replace(/_/g, " ")}${sr.by ? ` (${sr.by})` : ""}`;
  return `${who}${sr.at ? ` · ${formatWhen(sr.at)}` : ""}`;
}

/** The unit a request for this article carries — the server's unit_for: the
 *  requirement's unit, else pieces for PM, else kg. */
export function requisitionUnit(
  reqUnit: string | null | undefined,
  itemType: string | null | undefined,
): RequisitionUnit {
  if (reqUnit === "kg" || reqUnit === "pcs") return reqUnit;
  return (itemType ?? "").trim().toUpperCase() === "PM" ? "pcs" : "kg";
}

/** What the Quantity field opens with: the shortage when short, otherwise empty.
 *  `balance` is Coverage.balance from lib/floorStock (negative = short by that). */
export function defaultRequestQty(balance: number | null | undefined, unit: RequisitionUnit): string {
  if (balance == null || !(balance < 0)) return "";
  const short = -balance;
  return unit === "pcs" ? String(Math.ceil(short)) : String(Math.round(short * 1000) / 1000);
}

export type QtyCheck = { ok: true; value: number } | { ok: false; message: string };

// Plain decimal text only — no exponents, no hex, no grouping commas.
const NUMBER_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/** A typed quantity, checked in the same order and words as the server. */
export function checkQty(text: string, unit: RequisitionUnit): QtyCheck {
  const s = text.trim();
  if (!NUMBER_TEXT.test(s)) return { ok: false, message: "Enter a quantity as a number." };
  const value = Number(s);
  if (!(value > 0)) return { ok: false, message: "The quantity must be more than 0." };
  if (value >= 1e11) return { ok: false, message: "That quantity is too large." };
  const decimals = (s.split(".")[1] ?? "").replace(/0+$/, "").length;
  if (unit === "pcs" && decimals > 0) return { ok: false, message: "Pieces are whole numbers." };
  if (decimals > 3) return { ok: false, message: "Kilograms go to 3 decimals at most." };
  return { ok: true, value };
}

/** "88.200 kg", "1,000 pcs": kg to 3 decimals, pieces whole, Indian grouping. */
export function formatQty(n: number, unit: string): string {
  const dp = unit === "pcs" ? 0 : 3;
  return `${n.toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp })} ${unit}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const IST_OFFSET_MS = 330 * 60 * 1000;

/** An ISO timestamp as India time, "15 Sep 2026, 14:05". Built from parts, so it
 *  reads the same in every browser and locale. */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms + IST_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export type RequisitionLike = {
  requisition_id: number;
  material_sku_name: string;
  status: RequisitionStatus;
  raised_at: string;
};

export type ArticleRequests<T> = { open: T | null; latest: T | null };

// The tab's articleKey (lib/floorStock), repeated here so this module stays
// importable under plain Node without a path alias.
const keyOf = (name: string | null | undefined) => (name ?? "").trim().toUpperCase();

/** Per article (trimmed, upper-cased name): its open — raised — request, and its
 *  newest request that was not cancelled. Requisition numbers are not in date
 *  order, so "newest" is by raised_at. */
export function requestStateByArticle<T extends RequisitionLike>(
  rows: readonly T[],
): Map<string, ArticleRequests<T>> {
  const newestFirst = [...rows].sort((a, b) =>
    Date.parse(b.raised_at) - Date.parse(a.raised_at) || b.requisition_id - a.requisition_id);
  const out = new Map<string, ArticleRequests<T>>();
  for (const r of newestFirst) {
    const k = keyOf(r.material_sku_name);
    const cur = out.get(k) ?? { open: null, latest: null };
    if (r.status === "raised" && !cur.open) cur.open = r;
    if (r.status !== "cancelled" && !cur.latest) cur.latest = r;
    out.set(k, cur);
  }
  return out;
}
