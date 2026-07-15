"use client";

// Shared bits for the Customer-Returns module: company toggle, status pill,
// inline banners, and small formatters. Underscore prefix = not a route.

import { useSessionCache } from "@/lib/session-state";
import { COMPANIES, type Company, type CRStatus } from "@/lib/customer-returns";
import { WAREHOUSES } from "@/lib/sample";

export { WAREHOUSES };

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

// Company (CFPL/CDPL) is local UI state — there is no company context in the app.
// Persist across back-nav via the tab-scoped session cache.
export function useCompany(): [Company, (c: Company) => void] {
  return useSessionCache<Company>("cr:company", "CFPL");
}

export function CompanyToggle({ value, onChange }: { value: Company; onChange: (c: Company) => void }) {
  return (
    <div className="inline-flex bg-white border border-[var(--aws-border)] rounded-[8px] p-[2px] gap-[2px]">
      {COMPANIES.map((c) => (
        <button
          key={c}
          onClick={() => onChange(c)}
          aria-pressed={value === c}
          className={cx(
            "text-[12px] px-[12px] py-[4px] rounded-[6px]",
            value === c ? "bg-[var(--aws-navy)] text-white font-semibold" : "text-[var(--text-secondary)]",
          )}
        >
          {c}
        </button>
      ))}
    </div>
  );
}

const STATUS_STYLE: Record<CRStatus, string> = {
  Pending: "bg-[#fdf6e3] text-[#8a6d1a] border-[#ecd9a3]",
  Approved: "bg-[#eaf6ed] text-[var(--text-success)] border-[#b6dbb1]",
  Submitted: "bg-[#eaf0fb] text-[#2c5fa8] border-[#c3d4f0]",
  Rejected: "bg-[#fbeced] text-[var(--aws-error)] border-[#f0c0c4]",
  "On Hold": "bg-[#f3eefb] text-[#6b3fa0] border-[#d9c8f0]",
};

export function StatusBadge({ status }: { status: CRStatus }) {
  const cls = STATUS_STYLE[status] ?? STATUS_STYLE.Pending;
  return (
    <span className={cx("inline-block text-[11px] font-medium px-2 py-0.5 rounded border", cls)}>{status}</span>
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

// Cold-storage warehouses (legacy parity): the cold-only line fields
// (lot_number/item_mark/spl_remarks/vakkal) show only for these factory units.
const COLD_WAREHOUSES = new Set(["D-39", "D-514", "Rishi", "Supreme", "Eskimo"]);
export function isColdWarehouse(code: string | null | undefined): boolean {
  return !!code && COLD_WAREHOUSES.has(code.trim());
}
