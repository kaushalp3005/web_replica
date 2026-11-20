"use client";

// What SO Creation's second upload (the Tally Sales Register) found: totals,
// how the invoices link to SOs, what needs a look, and the invoices
// themselves. The first pass only reads and checks the file; Save stores the
// invoices (sales_invoice / sales_invoice_line).

import { useState } from "react";
import type { SalesInvoiceUploadResponse } from "@/lib/so";

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const num = (n: number, dp = 3) => n.toLocaleString("en-IN", { maximumFractionDigits: dp });

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 border border-[var(--aws-border)] rounded-sm px-2.5 py-2 bg-white">
      <div className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted)]">{label}</div>
      <div className="text-[14px] font-semibold text-[var(--text-primary)] truncate" title={value}>{value}</div>
      {sub ? <div className="text-[11px] text-[var(--text-secondary)] truncate" title={sub}>{sub}</div> : null}
    </div>
  );
}

function Problem({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <details className="border border-[var(--aws-border)] rounded-sm bg-white">
      <summary className="cursor-pointer px-2.5 py-1.5 text-[12px] font-semibold text-[#9a393e]">
        {title} ({count})
      </summary>
      <div className="px-2.5 pb-2 text-[12px] text-[var(--text-primary)] max-h-56 overflow-y-auto">{children}</div>
    </details>
  );
}

export function SalesInvoiceResult({ result, onSave, saving = false }: {
  result: SalesInvoiceUploadResponse;
  // Stores the checked file's invoices; omitted = no Save button.
  onSave?: () => void;
  saving?: boolean;
}) {
  const s = result.summary;
  const saved = result.save_result;
  const [showInvoices, setShowInvoices] = useState(false);
  const sites = Object.entries(s.by_dispatch_site).map(([k, v]) => `${k} ${v}`).join(" · ");
  const types = Object.entries(s.by_voucher_type).map(([k, v]) => `${k} ${v}`).join(" · ");
  const flagged = result.invoices.filter((i) => i.issues.length > 0);

  return (
    <div className="mt-3 border border-[var(--aws-border)] rounded-md bg-[var(--surface-subtle)] p-3 space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">
          Sales Register{s.period ? ` · ${s.period}` : ""}
        </h3>
        {s.company ? <span className="text-[12px] text-[var(--text-secondary)]">{s.company}</span> : null}
        <span className="ml-auto flex items-center gap-2">
          {result.saved && saved ? (
            <span className="text-[11px] px-2 py-0.5 rounded-sm border border-[#b7dfb9] bg-[#eef7ee] text-[var(--text-success)]">
              Saved · {saved.inserted} new, {saved.updated} updated · {saved.lines} lines
            </span>
          ) : (
            <span className="text-[11px] px-2 py-0.5 rounded-sm border border-[#ffe69c] bg-[#fff8e6] text-[#664d03]">
              Checked only — not saved yet
            </span>
          )}
          {onSave && !result.saved ? (
            <button
              type="button"
              onClick={onSave}
              disabled={saving || s.duplicate_vouchers > 0}
              title={s.duplicate_vouchers > 0 ? "The file has a voucher number twice — fix it in Tally first" : undefined}
              className="h-7 px-3 text-[12px] rounded-[2px] font-semibold border bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? "Saving…" : `Save ${s.invoices + s.cancelled} invoices`}
            </button>
          ) : null}
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <Stat label="Invoices" value={num(s.invoices, 0)} sub={`${s.cancelled} cancelled · ${s.parties} parties`} />
        <Stat label="Item lines" value={num(s.lines, 0)} sub={types} />
        <Stat label="Value" value={inr(s.total_value)} sub={`Gross ${inr(s.total_gross)}`} />
        <Stat label="Weight" value={`${num(s.total_kg)} kg`}
          sub={s.lines_without_kg ? `${s.lines_without_kg} line${s.lines_without_kg === 1 ? "" : "s"} without kg` : "every line has kg"} />
        <Stat label="Dates" value={`${fmtDate(s.date_from)} – ${fmtDate(s.date_to)}`} />
        <Stat label="Dispatched from" value={sites || "—"} />
      </div>

      <p className="text-[12px] text-[var(--text-secondary)]">
        <strong className="text-[var(--text-primary)]">{s.linked_to_so}</strong> of {s.invoices} invoices belong to an
        SO in the ERP ({s.sos_invoiced} SOs); {s.lines_on_so_line} of their items are tied to an SO line
        {s.lines_not_on_so_line ? <>, <strong className="text-[#9a393e]">{s.lines_not_on_so_line} aren&apos;t on their SO</strong></> : null}.
        {s.so_not_found ? <> <strong className="text-[#9a393e]">{s.so_not_found}</strong> quote an SO number the ERP doesn&apos;t have.</> : null}
        {" "}{s.reference_not_an_so} quote a reference that isn&apos;t an SO here, {s.without_reference} quote nothing.
      </p>

      {result.issues.length || result.unmatched_articles.length || result.low_confidence_articles.length
        || result.so_numbers_not_found.length || flagged.length ? (
        <div className="space-y-1.5">
          {result.issues.length ? (
            <Problem title="File checks" count={result.issues.length}>
              <ul className="list-disc pl-4 space-y-0.5">{result.issues.map((t) => <li key={t}>{t}</li>)}</ul>
            </Problem>
          ) : null}
          {result.unmatched_articles.length ? (
            <Problem title="Articles not in the master list" count={result.unmatched_articles.length}>
              <ul className="space-y-0.5">
                {result.unmatched_articles.map((a) => (
                  <li key={a.particulars}>{a.particulars} <span className="text-[var(--text-muted)]">· {a.lines} line{a.lines === 1 ? "" : "s"}</span></li>
                ))}
              </ul>
            </Problem>
          ) : null}
          {result.low_confidence_articles.length ? (
            <Problem title="Articles matched only loosely — check them" count={result.low_confidence_articles.length}>
              <ul className="space-y-0.5">
                {result.low_confidence_articles.map((a) => (
                  <li key={a.particulars}>
                    {a.particulars} → <span className="font-semibold">{a.matched_article}</span>{" "}
                    <span className="text-[var(--text-muted)]">({Math.round(a.match_score * 100)}% · {a.lines} line{a.lines === 1 ? "" : "s"})</span>
                  </li>
                ))}
              </ul>
            </Problem>
          ) : null}
          {result.so_numbers_not_found.length ? (
            <Problem title="SO numbers not in the ERP" count={result.so_numbers_not_found.length}>
              <p className="font-mono">{result.so_numbers_not_found.join(", ")}</p>
            </Problem>
          ) : null}
          {flagged.length ? (
            <Problem title="Invoices with a problem" count={flagged.length}>
              <ul className="space-y-0.5">
                {flagged.map((i) => (
                  <li key={`${i.voucher_no}-${i.date}`}>
                    <span className="font-mono">{i.voucher_no}</span> · {i.party ?? "—"}: {i.issues.join(" ")}
                  </li>
                ))}
              </ul>
            </Problem>
          ) : null}
        </div>
      ) : (
        <p className="text-[12px] text-[var(--text-success)]">No problems found in the file.</p>
      )}

      <div>
        <button
          type="button"
          onClick={() => setShowInvoices((v) => !v)}
          className="text-[12px] text-[var(--aws-link)] hover:underline font-semibold"
          aria-expanded={showInvoices}
        >
          {showInvoices ? "Hide" : "Show"} the {result.invoices.length} vouchers
        </button>
        {showInvoices ? (
          <div className="mt-2 max-h-[420px] overflow-auto border border-[var(--aws-border)] rounded-sm bg-white">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-[var(--surface-subtle)] text-left text-[11px] text-[var(--text-secondary)]">
                <tr>
                  <th className="px-2 py-1.5 font-semibold">Date</th>
                  <th className="px-2 py-1.5 font-semibold">Voucher</th>
                  <th className="px-2 py-1.5 font-semibold">Party</th>
                  <th className="px-2 py-1.5 font-semibold">SO / reference</th>
                  <th className="px-2 py-1.5 font-semibold">From</th>
                  <th className="px-2 py-1.5 font-semibold text-right">Lines</th>
                  <th className="px-2 py-1.5 font-semibold text-right">kg</th>
                  <th className="px-2 py-1.5 font-semibold text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {result.invoices.map((i) => {
                  const kg = i.lines.reduce((t, l) => t + (l.kg ?? 0), 0);
                  return (
                    <tr key={`${i.voucher_no}-${i.date}`}
                      className={["border-t border-[var(--aws-border)] align-top", i.cancelled ? "text-[var(--text-muted)] line-through" : ""].join(" ")}>
                      <td className="px-2 py-1 whitespace-nowrap">{fmtDate(i.date)}</td>
                      <td className="px-2 py-1 font-mono whitespace-nowrap" title={i.voucher_type ?? undefined}>{i.voucher_no}</td>
                      <td className="px-2 py-1 max-w-[220px] truncate" title={i.party ?? undefined}>{i.party ?? "—"}</td>
                      <td className="px-2 py-1 whitespace-nowrap">
                        {i.so_found ? (
                          <span className="text-[var(--text-success)]" title="SO in the ERP">{i.so_number}</span>
                        ) : i.quoted_so_number ? (
                          <span className="text-[#9a393e]" title="SO not in the ERP">{i.quoted_so_number}</span>
                        ) : (i.reference ?? "—")}
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap">{i.dispatch_from ?? "—"}</td>
                      <td className="px-2 py-1 text-right">{i.lines.length || "—"}</td>
                      <td className="px-2 py-1 text-right">{kg ? num(kg) : "—"}</td>
                      <td className="px-2 py-1 text-right whitespace-nowrap">{i.value != null ? inr(i.value) : i.gross_total != null ? inr(i.gross_total) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}
