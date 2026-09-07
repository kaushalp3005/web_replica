// The six statuses the sample queue and dashboard show, collapsed from the 13 raw
// lifecycle states:
//
//   Pending      sent, not yet accepted
//   Awaiting BH  086's business-head gate is still open (its own column, not status)
//   Hold         on hold (the reason rides along for the tooltip)
//   In process   accepted, nothing shipped yet
//   Partial      some of the quantity shipped
//   Dispatched   all of it shipped, or the gate pass closed it
//   Cancelled    cancelled or rejected
//
// The authority is the SERVER: list_requisitions computes display_status in SQL, because
// the queue filter has to be a WHERE — filtering after the fetch would page against the
// unfiltered row set, so page 2 of "Partial" would skip rows page 1 never showed.
//
// This module is the client's fallback and its presentation. Keep the buckets in step with
// DISPLAY_STATUSES in app/modules/sample/services/requisition_service.py.

export type DisplayStatus =
  | "PENDING" | "BH_PENDING" | "HOLD" | "IN_PROCESS" | "PARTIAL"
  | "DISPATCHED" | "CANCELLED";

export const DISPLAY_STATUS_LABEL: Record<DisplayStatus, string> = {
  PENDING: "Pending",
  BH_PENDING: "Awaiting BH",
  HOLD: "Hold",
  IN_PROCESS: "In process",
  PARTIAL: "Partial",
  DISPATCHED: "Dispatched",
  CANCELLED: "Cancelled",
};

export const DISPLAY_STATUS_STYLES: Record<DisplayStatus, { bg: string; fg: string; ring: string }> = {
  PENDING:    { bg: "#eaf3ff", fg: "#1d4ed8", ring: "#bbd9f3" },
  BH_PENDING: { bg: "#eef2ff", fg: "#4338ca", ring: "#c7d2fe" },
  HOLD:       { bg: "#fef9c3", fg: "#854d0e", ring: "#fde68a" },
  IN_PROCESS: { bg: "#fef3c7", fg: "#92400e", ring: "#fde68a" },
  PARTIAL:    { bg: "#fff7ed", fg: "#c2410c", ring: "#fed7aa" },
  DISPATCHED: { bg: "#eaf6ed", fg: "#1d8102", ring: "#b6dbb1" },
  CANCELLED:  { bg: "#f4f4f4", fg: "#687078", ring: "#d5dbdb" },
};

// The queue's filter. `value` is sent verbatim as the display_statuses query param, so it
// must match the server's bucket names exactly.
export const DISPLAY_STATUS_FILTERS: { value: DisplayStatus; label: string }[] =
  (["PENDING", "BH_PENDING", "HOLD", "IN_PROCESS", "PARTIAL", "DISPATCHED",
    "CANCELLED"] as const)
    .map((v) => ({ value: v, label: DISPLAY_STATUS_LABEL[v] }));

/** The raw statuses the client can map on its own, for cached rows. */
const FALLBACK: Record<string, DisplayStatus> = {
  DRAFT: "PENDING", SUBMITTED: "PENDING",
  ON_HOLD: "HOLD",
  CANCELLED: "CANCELLED", BH_REJECTED: "CANCELLED",
  GATE_PASS_ISSUED: "DISPATCHED", CLOSED: "DISPATCHED",
  BH_APPROVED: "IN_PROCESS", IN_PRODUCTION: "IN_PROCESS",
  PACKING: "IN_PROCESS", READY_FOR_DISPATCH: "IN_PROCESS",
  // Deliberately NOT Partial. INTERNALLY_DISPATCHED means stock left without a gate pass
  // and PARTIALLY_CONVERTED means the request was split into child requisitions — neither
  // says how much of the quantity shipped. Only the server sees the dispatch ledger, so
  // guessing here would tell someone stock had gone when it may not have.
  INTERNALLY_DISPATCHED: "IN_PROCESS", PARTIALLY_CONVERTED: "IN_PROCESS",
};

/**
 * The bucket to render for a queue row.
 *
 * Prefers the server's `display_status`; falls back to the raw status for rows restored
 * from the sessionStorage list cache, which may have been written before the field
 * existed. A blank pill reads as broken, so there is always an answer.
 */
export function displayStatusOf(
  row: {
    status?: string | null;
    display_status?: string | null;
    bh_signoff_state?: string | null;
  },
): DisplayStatus {
  const fromServer = String(row.display_status ?? "").trim().toUpperCase();
  if (fromServer in DISPLAY_STATUS_LABEL) return fromServer as DisplayStatus;
  // 086's gate lives on its own column, not on `status`, so the fallback has to read it
  // separately — and it outranks the lifecycle state for the same reason the server's
  // CASE puts it first.
  if (String(row.bh_signoff_state ?? "").trim().toUpperCase() === "PENDING") return "BH_PENDING";
  return FALLBACK[String(row.status ?? "").trim().toUpperCase()] ?? "PENDING";
}

/**
 * Whether a string is one of the six buckets.
 *
 * Guards the queue's remembered filter: sample-list-cache persists it in sessionStorage,
 * and before display_status existed it held a RAW status. Sending one of those as a
 * display bucket matches nothing, so a stale tab would open to an empty queue with no
 * explanation. An unrecognised value is dropped back to "all".
 */
export function isDisplayStatus(v: string | null | undefined): boolean {
  return String(v ?? "").trim().toUpperCase() in DISPLAY_STATUS_LABEL;
}
