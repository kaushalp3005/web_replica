"use client";

// Shared UI atoms for the Inventory Ledger module. Quantity-first: quantities
// render bold via <QtyCell>; value is muted + "≈" via <ValCell>. Export bar
// does Copy / Excel / CSV / Print client-side (xlsx-js-style is a project dep).

import { useRef, useState } from "react";

// ── number formatting (NaN/Infinity render as "—", not "NaN"/"∞") ──
export function fmtQty(n: number | null | undefined, dp = 3): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
export function fmtVal(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `≈ ${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}
export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}
// UOM drives precision: count units (nos/no) print whole, weights print 3dp.
export function uomDp(uom: string | undefined): number {
  return uom === "nos" || uom === "no" ? 0 : 3;
}

// ── quantity / value cells ─────────────────────────────────────────
export function QtyCell({ n, dp, uom }: { n: number | null | undefined; dp?: number; uom?: string }) {
  const neg = typeof n === "number" && n < 0;
  const p = dp ?? uomDp(uom);
  return (
    <span
      className={`font-mono tabular-nums font-semibold ${neg ? "text-[var(--aws-error)]" : "text-[var(--text-primary)]"}`}
    >
      {fmtQty(n, p)}
    </span>
  );
}
export function ValCell({ n }: { n: number | null | undefined }) {
  return <span className="font-mono tabular-nums text-[12px] italic text-[var(--text-muted)]">{fmtVal(n)}</span>;
}

// ── pills ──────────────────────────────────────────────────────────
type PillTone = "in" | "out" | "xfer" | "warn" | "mut" | "kg" | "nos";
const PILL_CLS: Record<PillTone, string> = {
  in: "text-[#1d8102] bg-[#e5f5ee]",
  out: "text-[var(--aws-error)] bg-[#fce8e9]",
  xfer: "text-[#2f74cf] bg-[#e6effb]",
  warn: "text-[#c07d09] bg-[#fbf0d8]",
  mut: "text-[var(--text-secondary)] bg-[var(--surface-divider)]",
  kg: "text-[#2f74cf] bg-[#e6effb]",
  nos: "text-[#8a5cd1] bg-[#efe7fb]",
};
export function Pill({ tone = "mut", children }: { tone?: PillTone; children: React.ReactNode }) {
  return (
    <span className={`inline-block font-mono text-[10px] font-bold px-[6px] py-[2px] rounded ${PILL_CLS[tone]} whitespace-nowrap`}>
      {children}
    </span>
  );
}
export function UomBadge({ uom }: { uom: string }) {
  const tone: PillTone = uom === "nos" ? "nos" : uom === "no" ? "mut" : "kg";
  return <Pill tone={tone}>{uom === "mixed" ? "Kgs +NOS" : uom.toUpperCase()}</Pill>;
}

// ── stat card ──────────────────────────────────────────────────────
export function StatCard({
  label, value, unit, delta, flag = false, onClick,
}: {
  label: string; value: string; unit?: string; delta?: string; flag?: boolean; onClick?: () => void;
}) {
  const base = `rounded-[10px] border p-3 ${
    flag ? "border-[#c07d09] bg-[linear-gradient(0deg,#fbf0d8,#fff)]" : "border-[var(--aws-border)] bg-white"
  }`;
  const body = (
    <>
      <div className="font-mono text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
      <div className={`font-mono tabular-nums text-[18px] font-bold mt-1 ${flag ? "text-[#c07d09]" : "text-[var(--text-primary)]"}`}>
        {value} {unit && <span className="text-[10px] text-[var(--text-muted)] font-medium">{unit}</span>}
      </div>
      {delta && <div className="font-mono text-[10px] mt-1 text-[var(--text-muted)]">{delta}</div>}
    </>
  );
  // Only render an interactive button when there's a handler — otherwise a plain
  // div, so keyboard users don't tab to a card that does nothing.
  if (!onClick) return <div className={base}>{body}</div>;
  return (
    <button type="button" onClick={onClick} className={`text-left w-full transition hover:-translate-y-[2px] hover:shadow-md ${base}`}>
      {body}
    </button>
  );
}

// ── section tabs ───────────────────────────────────────────────────
export interface TabDef { key: string; label: string; }
export function SectionTabs({
  tabs, active, onSelect,
}: { tabs: TabDef[]; active: string; onSelect: (key: string) => void }) {
  return (
    <div className="flex gap-[2px] border-b border-[var(--aws-border)] overflow-x-auto" role="tablist">
      {tabs.map((t) => {
        const on = t.key === active;
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={on}
            onClick={() => onSelect(t.key)}
            className={`text-[12.5px] px-3 py-2 whitespace-nowrap border-b-2 -mb-px ${
              on
                ? "text-[var(--text-primary)] font-semibold border-[var(--aws-orange)]"
                : "text-[var(--text-secondary)] border-transparent hover:text-[var(--text-primary)]"
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ── export bar (Copy / Excel / CSV / Print) ───────────────────────
type Cell = string | number | null | undefined;
export interface ExportSpec {
  filename: string;
  sheet: string;
  // Header row + body rows as an array-of-arrays (already formatted for display).
  rows: () => Cell[][];
}
function toMatrix(rows: Cell[][]): (string | number)[][] {
  return rows.map((r) => r.map((c) => (c === null || c === undefined ? "" : c)));
}
// Neutralize spreadsheet formula-injection on STRING cells only (a cell like
// "=SUM()", "@x", "+91…", "-1" would otherwise be evaluated by Excel/Sheets on
// open). Numbers stay raw so they remain real numeric cells. Only needed for
// CSV/TSV — xlsx aoa_to_sheet already emits strings as text cells, not formulas.
function guardText(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}
export function ExportBar({ spec }: { spec: ExportSpec }) {
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);
  function ping(msg: string) {
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    setFlash(msg);
    flashTimer.current = window.setTimeout(() => setFlash(null), 1400);
  }
  function onCopy() {
    if (!navigator.clipboard) { ping("Copy unavailable"); return; }
    const tsv = spec.rows()
      .map((r) => r.map((c) => {
        if (c === null || c === undefined) return "";
        if (typeof c === "number") return String(c);
        return guardText(c).replace(/[\t\r\n]/g, " ");
      }).join("\t"))
      .join("\n");
    navigator.clipboard.writeText(tsv).then(() => ping("Copied"), () => ping("Copy failed"));
  }
  async function onExcel() {
    const XLSX = await import("xlsx-js-style");
    const ws = XLSX.utils.aoa_to_sheet(toMatrix(spec.rows()));
    const wb = XLSX.utils.book_new();
    // Excel sheet names: max 31 chars, none of : \ / ? * [ ], non-blank.
    const sheet = (spec.sheet.replace(/[:\\/?*[\]]/g, " ").trim().slice(0, 31)) || "Sheet1";
    XLSX.utils.book_append_sheet(wb, ws, sheet);
    XLSX.writeFile(wb, `${spec.filename}.xlsx`);
    ping("Excel");
  }
  function onCsv() {
    const csv = spec.rows()
      .map((r) => r.map((c) => {
        if (c === null || c === undefined) return "";
        if (typeof c === "number") return String(c);
        const s = guardText(c);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${spec.filename}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    ping("CSV");
  }
  const btn = "font-mono text-[10.5px] inline-flex gap-[5px] items-center border border-[var(--aws-border)] rounded-[7px] px-[9px] py-[5px] hover:border-[var(--aws-orange)] hover:text-[var(--aws-orange)]";
  return (
    <div className="flex gap-[6px] items-center flex-wrap ml-auto">
      {flash && <span className="font-mono text-[10px] text-[var(--text-success)]">{flash}</span>}
      <button type="button" className={btn} onClick={onCopy}>⧉ Copy</button>
      <button
        type="button"
        className="font-mono text-[10.5px] inline-flex gap-[5px] items-center rounded-[7px] px-[9px] py-[5px] bg-[var(--aws-navy)] text-white hover:bg-[var(--aws-orange-active)]"
        onClick={() => { void onExcel(); }}
      >⤓ Excel</button>
      <button type="button" className={btn} onClick={onCsv}>CSV</button>
      <button type="button" className={btn} onClick={() => window.print()}>⎙ Print</button>
    </div>
  );
}

// ── filter chip (display-only stand-in until the filter bar is wired) ─
export function FilterChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-[6px] bg-white border border-[var(--aws-border)] rounded-[8px] px-[10px] py-[5px] font-mono text-[10.5px]">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span className="text-[var(--text-primary)] font-semibold">{value}</span>
      <span className="text-[var(--text-muted)]">▾</span>
    </span>
  );
}

// ── panel + table shells ──────────────────────────────────────────
export function TableShell({ children, minW = 640 }: { children: React.ReactNode; minW?: number }) {
  return (
    <div className="border border-[var(--aws-border)] rounded-[11px] overflow-hidden bg-white">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12px]" style={{ minWidth: minW }}>
          {children}
        </table>
      </div>
    </div>
  );
}
export const thCls = "font-mono text-[9.5px] uppercase tracking-wide text-[var(--text-muted)] text-left px-[11px] py-2 bg-[var(--surface-subtle)] border-b border-[var(--aws-border)] whitespace-nowrap font-semibold";
export const tdCls = "px-[11px] py-2 border-b border-[var(--surface-divider)] text-[var(--text-primary)] align-middle";
