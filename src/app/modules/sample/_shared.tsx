// Shared presentational helpers for the Sample module. Underscore-prefixed so
// the Next App Router does NOT treat it as a route. Imported by the queue,
// wizard, and detail pages.

export const STATUS_STYLES: Record<string, { bg: string; fg: string; ring: string }> = {
  DRAFT:                 { bg: "#f4f4f4", fg: "#414d5c", ring: "#d5dbdb" },
  SUBMITTED:             { bg: "#eaf3ff", fg: "#1d4ed8", ring: "#bbd9f3" },
  BH_APPROVED:           { bg: "#eef2ff", fg: "#4338ca", ring: "#c7d2fe" },
  BH_REJECTED:           { bg: "#fdf3f1", fg: "#b1361e", ring: "#f0c7be" },
  ON_HOLD:               { bg: "#fef9c3", fg: "#854d0e", ring: "#fde68a" },
  IN_PRODUCTION:         { bg: "#fef3c7", fg: "#92400e", ring: "#fde68a" },
  PACKING:               { bg: "#f5f3ff", fg: "#6d28d9", ring: "#ddd6fe" },
  READY_FOR_DISPATCH:    { bg: "#ecfeff", fg: "#0e7490", ring: "#a5f0fc" },
  INTERNALLY_DISPATCHED: { bg: "#eaf6ed", fg: "#1d8102", ring: "#b6dbb1" },
  PARTIALLY_CONVERTED:   { bg: "#fff7ed", fg: "#c2410c", ring: "#fed7aa" },
  GATE_PASS_ISSUED:      { bg: "#ecfdf5", fg: "#047857", ring: "#a7f3d0" },
  CLOSED:                { bg: "#f4f4f4", fg: "#687078", ring: "#d5dbdb" },
  CANCELLED:             { bg: "#f4f4f4", fg: "#687078", ring: "#d5dbdb" },
};

export const TYPE_LABEL: Record<string, string> = {
  BASIS_RM: "Basis RM", BASIS_FG: "Basis FG", NPD: "NPD", INTERNAL: "Internal", TRIAL: "Trial",
};

export function StatusPill({ status }: { status?: string | null }) {
  const s = STATUS_STYLES[status ?? ""] ?? STATUS_STYLES.DRAFT;
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap"
      style={{ background: s.bg, color: s.fg, boxShadow: `inset 0 0 0 1px ${s.ring}` }}
    >
      {(status ?? "").replace(/_/g, " ")}
    </span>
  );
}

// NPD review status — the NPD queue/detail surface only 3 review states:
//   Pending  ← DRAFT, SUBMITTED (the default on create / awaiting review)
//   Hold     ← ON_HOLD (the Hold pill's tooltip shows the reason)
//   Accepted ← BH_APPROVED and everything downstream (in production … closed)
// CANCELLED / BH_REJECTED are terminal negatives, shown as "Cancelled".
// BH_PENDING (086) is a PILL state, not a filter bucket: it lives on bh_signoff_state,
// not on `status`, so the server-side status filters below cannot express it. A request
// waiting on its business head still files under "Pending" — it just says so honestly.
export type NpdReviewStatus = "PENDING" | "BH_PENDING" | "HOLD" | "ACCEPTED" | "CANCELLED";

// Filter buckets (the 3 active states) → the underlying statuses they cover.
export const NPD_STATUS_FILTERS: { value: NpdReviewStatus; label: string; statuses: string[] }[] = [
  { value: "PENDING", label: "Pending", statuses: ["DRAFT", "SUBMITTED"] },
  { value: "HOLD", label: "Hold", statuses: ["ON_HOLD"] },
  {
    value: "ACCEPTED", label: "Accepted",
    statuses: ["BH_APPROVED", "IN_PRODUCTION", "PACKING", "READY_FOR_DISPATCH",
      "INTERNALLY_DISPATCHED", "PARTIALLY_CONVERTED", "GATE_PASS_ISSUED", "CLOSED"],
  },
];

export function npdReviewStatus(
  raw?: string | null, bhSignoffState?: string | null,
): NpdReviewStatus {
  // The BH gate outranks the raw status: a SUBMITTED request whose business head has not
  // approved yet was never handed to NPD, and showing it as plain "Pending" invites a
  // reviewer to act on something the server will refuse.
  if (bhSignoffState === "PENDING") return "BH_PENDING";
  switch (raw) {
    case "ON_HOLD": return "HOLD";
    case "CANCELLED":
    case "BH_REJECTED": return "CANCELLED";
    case "BH_APPROVED":
    case "IN_PRODUCTION":
    case "PACKING":
    case "READY_FOR_DISPATCH":
    case "INTERNALLY_DISPATCHED":
    case "PARTIALLY_CONVERTED":
    case "GATE_PASS_ISSUED":
    case "CLOSED": return "ACCEPTED";
    default: return "PENDING";   // DRAFT, SUBMITTED, anything else
  }
}

const NPD_STATUS_STYLES: Record<NpdReviewStatus, { bg: string; fg: string; ring: string; label: string }> = {
  PENDING:   { bg: "#eaf3ff", fg: "#1d4ed8", ring: "#bbd9f3", label: "Pending" },
  BH_PENDING: { bg: "#eef2ff", fg: "#4338ca", ring: "#c7d2fe", label: "Awaiting BH" },
  HOLD:      { bg: "#fef9c3", fg: "#854d0e", ring: "#fde68a", label: "Hold" },
  ACCEPTED:  { bg: "#eaf6ed", fg: "#1d8102", ring: "#b6dbb1", label: "Accepted" },
  CANCELLED: { bg: "#f4f4f4", fg: "#687078", ring: "#d5dbdb", label: "Cancelled" },
};

// Simplified NPD status pill. For a HOLD, hovering shows the reason.
export function NpdStatusPill({ status, holdReason, bhSignoffState }: {
  status?: string | null; holdReason?: string | null; bhSignoffState?: string | null;
}) {
  const key = npdReviewStatus(status, bhSignoffState);
  const s = NPD_STATUS_STYLES[key];
  const title = key === "HOLD" && holdReason ? `On hold — ${holdReason}`
    : key === "BH_PENDING" ? "Waiting on the business head — it reaches NPD once they approve"
    : undefined;
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap"
      style={{ background: s.bg, color: s.fg, boxShadow: `inset 0 0 0 1px ${s.ring}` }}
      title={title}
    >
      {/* The ⓘ marks a tooltip that carries DATA (the hold reason). BH_PENDING's tooltip
          only explains the state, and the queue's fixed-width Status column has no room
          to spare — so it goes without. */}
      {s.label}{key === "HOLD" && holdReason ? " ⓘ" : ""}
    </span>
  );
}

// Compact billing summary for a list row (NPD/TRIAL): return type + paid amount.
// "—" when nothing is set (e.g. non-NPD requisitions). Shared by the Sample queue and
// the NPD Development queue so the two never drift on how billing reads.
export function billingSummary(r: {
  returnable?: boolean | null; non_returnable?: boolean | null;
  paid?: boolean | null; amount?: number | null;
}): string {
  const rt = r.returnable ? "Returnable" : r.non_returnable ? "Non-returnable" : "";
  const paid = r.paid
    ? `Paid ${Number(r.amount ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "";
  return [rt, paid].filter(Boolean).join(" · ") || "—";
}

// Standalone NPD development job-card statuses (own vocabulary, own palette).
export const DEV_JC_STATUS_STYLES: Record<string, { bg: string; fg: string; ring: string }> = {
  DRAFT:          { bg: "#f4f4f4", fg: "#414d5c", ring: "#d5dbdb" },
  IN_DEVELOPMENT: { bg: "#fef3c7", fg: "#92400e", ring: "#fde68a" },
  CLOSED:         { bg: "#ecfdf5", fg: "#047857", ring: "#a7f3d0" },
  CANCELLED:      { bg: "#f4f4f4", fg: "#687078", ring: "#d5dbdb" },
};

export function DevJcStatusPill({ status }: { status?: string | null }) {
  const s = DEV_JC_STATUS_STYLES[status ?? ""] ?? DEV_JC_STATUS_STYLES.DRAFT;
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap"
      style={{ background: s.bg, color: s.fg, boxShadow: `inset 0 0 0 1px ${s.ring}` }}
    >
      {(status ?? "").replace(/_/g, " ")}
    </span>
  );
}

// RM Issue / Collection Form (Document 015) statuses.
export const RM_FORM_STATUS_STYLES: Record<string, { bg: string; fg: string; ring: string }> = {
  DRAFT:     { bg: "#f4f4f4", fg: "#414d5c", ring: "#d5dbdb" },
  SUBMITTED: { bg: "#eaf3ff", fg: "#1d4ed8", ring: "#bbd9f3" },
  APPROVED:  { bg: "#eef2ff", fg: "#4338ca", ring: "#c7d2fe" },
  ISSUED:    { bg: "#eaf6ed", fg: "#1d8102", ring: "#b6dbb1" },
  CLOSED:    { bg: "#ecfdf5", fg: "#047857", ring: "#a7f3d0" },
  CANCELLED: { bg: "#f4f4f4", fg: "#687078", ring: "#d5dbdb" },
};

export function RmFormStatusPill({ status }: { status?: string | null }) {
  const s = RM_FORM_STATUS_STYLES[status ?? ""] ?? RM_FORM_STATUS_STYLES.DRAFT;
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap"
      style={{ background: s.bg, color: s.fg, boxShadow: `inset 0 0 0 1px ${s.ring}` }}
    >
      {(status ?? "").replace(/_/g, " ")}
    </span>
  );
}
