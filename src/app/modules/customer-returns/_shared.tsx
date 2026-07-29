"use client";

// Shared bits for the Customer-Returns module: company toggle, status pill,
// inline banners, and small formatters. Underscore prefix = not a route.

import { useEffect, useId, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { useSessionCache } from "@/lib/session-state";
import { COMPANIES, type Company, type CRStatus, type CRWithDetails } from "@/lib/customer-returns";
import { WAREHOUSES } from "@/lib/sample";
import { getDisplayWarehouseName } from "@/lib/transferBuildSummary";

export { WAREHOUSES };

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

// Company (CFPL/CDPL) is local UI state — there is no company context in the app.
// Persist across back-nav via the tab-scoped session cache.
export function useCompany(): [Company, (c: Company) => void] {
  return useSessionCache<Company>("cr:company", "CFPL");
}

// Read-only company for id-scoped pages (detail/approve): honor the ?company= URL
// param the list links pass, falling back to the tab-scoped session cache. Without
// this, a bookmarked/shared/cold-tab link to a non-default company's CR loads the
// wrong per-company table (fresh sessionStorage defaults to CFPL) and 404s.
export function useCompanyParam(): Company {
  const [cached] = useCompany();
  const q = useSearchParams().get("company");
  return q === "CFPL" || q === "CDPL" ? q : cached;
}

// `disabled` pins the company once a record is committed (the create page mints a
// CR on first box-print) — every later write is company-namespaced, so the toggle
// must not diverge from the CR's namespace after that.
export function CompanyToggle({ value, onChange, disabled }: { value: Company; onChange: (c: Company) => void; disabled?: boolean }) {
  return (
    <div className={cx("inline-flex bg-white border border-[var(--aws-border)] rounded-[8px] p-[2px] gap-[2px]", disabled && "opacity-60")}>
      {COMPANIES.map((c) => (
        <button
          key={c}
          onClick={() => !disabled && onChange(c)}
          disabled={disabled}
          aria-pressed={value === c}
          title={disabled ? "Company is fixed once the return is created" : undefined}
          className={cx(
            "text-[12px] px-[12px] py-[4px] rounded-[6px]",
            value === c ? "bg-[var(--aws-navy)] text-white font-semibold" : "text-[var(--text-secondary)]",
            disabled && "cursor-not-allowed",
          )}
        >
          {c}
        </button>
      ))}
    </div>
  );
}

// Read-only company indicator for id-scoped pages (detail/approve/view). The
// company can't change mid-record, so these show a chip rather than the toggle.
export function CompanyChip({ company }: { company: Company }) {
  return (
    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border border-[var(--aws-border)] text-[var(--text-secondary)] bg-white">{company}</span>
  );
}

const STATUS_STYLE: Record<CRStatus, string> = {
  Pending: "bg-[#fdf6e3] text-[#8a6d1a] border-[#ecd9a3]",
  Approved: "bg-[#eaf6ed] text-[var(--text-success)] border-[#b6dbb1]",
  Submitted: "bg-[#eaf0fb] text-[#2c5fa8] border-[#c3d4f0]",
  Rejected: "bg-[#fbeced] text-[var(--aws-error)] border-[#f0c0c4]",
  "On Hold": "bg-[#f3eefb] text-[#6b3fa0] border-[#d9c8f0]",
};

// Single-source status pill for the whole module (list, detail, approve, view,
// dashboard). Carries a per-status leading icon; pass icon={false} for a bare pill.
function StatusIcon({ status, className }: { status: CRStatus; className?: string }) {
  const p = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, className: className ?? "h-3 w-3", "aria-hidden": true };
  switch (status) {
    case "Approved": return (<svg {...p}><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></svg>);
    case "Submitted": return (<svg {...p}><path d="M18 6 7 17l-5-5" /><path d="m22 10-7.5 7.5L13 16" /></svg>);
    case "Rejected": return (<svg {...p}><circle cx="12" cy="12" r="10" /><path d="m15 9-6 6" /><path d="m9 9 6 6" /></svg>);
    case "On Hold": return (<svg {...p}><circle cx="12" cy="12" r="10" /><line x1="10" x2="10" y1="9" y2="15" /><line x1="14" x2="14" y1="9" y2="15" /></svg>);
    default: return (<svg {...p}><circle cx="12" cy="12" r="10" /><path d="M12 7v5l3 2" /></svg>); // Pending — clock
  }
}

export function StatusBadge({ status, icon = true }: { status: CRStatus; icon?: boolean }) {
  const cls = STATUS_STYLE[status] ?? STATUS_STYLE.Pending;
  return (
    <span className={cx("inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded border", cls)}>
      {icon && <StatusIcon status={status} />}
      {status}
    </span>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-[#f0c7be] bg-[#fdf3f1] px-3 py-2 text-[13px] text-[#b1361e]">
      {message}
    </div>
  );
}

export function SuccessBanner({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-[#b6dbb1] bg-[#eaf6ed] px-3 py-2 text-[13px] text-[var(--text-success)]">
      {message}
    </div>
  );
}

export function InfoBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-[#c3d4f0] bg-[#eaf0fb] px-3 py-2 text-[13px] text-[#2c5fa8]">
      {children}
    </div>
  );
}

// Deterministic date formatters (no date-fns in this app; native Intl only).
export function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export function fmtDateTime(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function num(v: string | number | null | undefined): number {
  const n = typeof v === "number" ? v : parseFloat(v ?? "");
  return isNaN(n) ? 0 : n;
}

// Number / value(₹) / rate(₹) formatters — one definition for the whole module
// (dashboard + view + detail summaries) so currency/number rendering can't drift.
export function fmtN(v: string | number | null | undefined): string {
  const n = num(v);
  return Math.round(n).toLocaleString("en-IN");
}
export function fmtV(v: string | number | null | undefined): string {
  const n = num(v);
  return n !== 0 ? "₹" + Math.round(n).toLocaleString("en-IN") : "₹0";
}
export function fmtR(v: string | number | null | undefined): string {
  const n = num(v);
  return n ? "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : "—";
}

// Shared read-only CR header field grid — one field order + label set + breakpoint
// used by BOTH the detail read-mode ("CR Information") and the read-only view, so
// the two id-scoped pages present the header identically.
export function CrHeaderGrid({ cr }: { cr: CRWithDetails }) {
  return (
    <dl className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-3 text-[13px]">
      <CrField label="Factory Unit" value={getDisplayWarehouseName(cr.factory_unit) || "—"} />
      <CrField label="Customer" value={cr.customer} />
      <CrField label="Invoice No" value={cr.invoice_number} />
      <CrField label="Challan No" value={cr.challan_no} />
      <CrField label="DN No" value={cr.dn_no} />
      <CrField label="Sales POC" value={cr.sales_poc} />
      <CrField label="Business Head" value={cr.business_head} />
      <CrField label="Date" value={fmtDate(cr.rtv_date)} />
      <CrField label="Vehicle Number" value={cr.vehicle_number} />
      <CrField label="Transporter" value={cr.transporter_name} />
      <CrField label="Driver Name" value={cr.driver_name} />
      <CrField label="Inward Manager" value={cr.inward_manager} />
      <CrField label="Created By" value={cr.created_by} />
      {cr.remark && (
        <div className="col-span-full">
          <dt className="text-[11px] uppercase tracking-wider text-[var(--text-secondary)]">Remark</dt>
          <dd className="text-[13px] mt-0.5 text-[var(--text-primary)] break-words">{cr.remark}</dd>
        </div>
      )}
    </dl>
  );
}

function CrField({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wider text-[var(--text-secondary)]">{label}</dt>
      <dd className="text-[13px] font-medium mt-0.5 text-[var(--text-primary)] break-words">{value || "—"}</dd>
    </div>
  );
}

// Cold-storage warehouses (legacy parity): the cold-only line fields
// (lot_number/item_mark/spl_remarks/vakkal) show only for these factory units.
const COLD_WAREHOUSES = new Set(["D-39", "D-514", "Rishi", "Supreme", "Eskimo"]);
export function isColdWarehouse(code: string | null | undefined): boolean {
  return !!code && COLD_WAREHOUSES.has(code.trim());
}

// Accessible confirm dialog (role=dialog/aria-modal + labelled title, initial
// focus on Cancel, Escape-to-close unless busy, Tab focus-trap). Shared by the
// list + detail pages so the a11y logic lives in one place.
export function ConfirmDialog({
  title, children, confirmLabel = "Confirm", danger = true, busy = false, busyLabel, onCancel, onConfirm,
}: {
  title: string;
  children: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  busyLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId(); // unique per instance — no fixed-id collision if two ever coexist

  // Focus Cancel on open; restore focus to the opener (e.g. the row's Delete
  // button) when the dialog closes so keyboard users keep their place.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => opener?.focus?.();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { if (!busy) { e.preventDefault(); onCancel(); } return; }
      if (e.key !== "Tab") return;
      const nodes = panelRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])");
      if (!nodes || nodes.length === 0) { e.preventDefault(); return; }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={() => !busy && onCancel()}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-white rounded-lg max-w-md w-full p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="text-[15px] font-semibold text-[var(--text-primary)]">{title}</h2>
        <div className="text-[13px] text-[var(--text-secondary)] mt-2">{children}</div>
        <div className="flex justify-end gap-2 mt-4">
          <button ref={cancelRef} onClick={onCancel} disabled={busy} className="text-[13px] rounded-md border border-[var(--aws-border)] px-3 py-1.5 bg-white">Cancel</button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className={cx("text-[13px] rounded-md px-3 py-1.5 text-white disabled:opacity-50", danger ? "bg-[var(--aws-error)]" : "bg-[var(--aws-orange)]")}
          >
            {busy ? (busyLabel ?? "Working…") : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
