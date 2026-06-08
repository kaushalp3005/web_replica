// Shared presentational helpers for the Sample module. Underscore-prefixed so
// the Next App Router does NOT treat it as a route. Imported by the queue,
// wizard, and detail pages.

export const STATUS_STYLES: Record<string, { bg: string; fg: string; ring: string }> = {
  DRAFT:                 { bg: "#f4f4f4", fg: "#414d5c", ring: "#d5dbdb" },
  SUBMITTED:             { bg: "#eaf3ff", fg: "#1d4ed8", ring: "#bbd9f3" },
  BH_APPROVED:           { bg: "#eef2ff", fg: "#4338ca", ring: "#c7d2fe" },
  BH_REJECTED:           { bg: "#fdf3f1", fg: "#b1361e", ring: "#f0c7be" },
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
