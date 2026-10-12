"use client";

// The "Summary" sheet for one party: its dues and their ageing, where it ranks
// in the section, the customer's other rows (the same customer billed under
// both CF and CD shows up twice in the report) with the combined total, the
// collection remarks, the calling agent's summaries of earlier calls and the
// contacts on file. "Call now" hands over to the call sheet.
//
// A native <dialog> opened with showModal(), like the call sheet: Escape,
// focus trapping and the inert page behind come from the browser.

import { useEffect, useMemo, useRef } from "react";
import {
  AGE_BUCKETS, dimensionValue, formatInr, formatShare, hasDues, partyKey, phoneNumbers, totalsOf,
  type DpdParty, type DpdSectionKey,
} from "@/lib/debtors";
import { AgeingBar, PhoneIcon, Remark, Swatch, isFlag } from "./_ui";
import { CallSummaries } from "./_CallSummaries";
import type { DimensionDef } from "./_sections";

const H3 = "text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]";
const TD = "py-1.5 border-t border-[var(--surface-divider)]";
const TD_NUM = `${TD} pl-3 text-right tabular-nums whitespace-nowrap`;

// The same customer across rows: case and punctuation aside, never fuzzily.
const customerKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function Dash() {
  return <span className="text-[var(--text-disabled)]">—</span>;
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="min-w-0 rounded-md border border-[var(--aws-border)] px-3 py-2">
      <p className="text-[11px] text-[var(--text-secondary)]">{label}</p>
      <p className="mt-0.5 text-[15px] font-semibold tabular-nums text-[var(--text-primary)] truncate">{value}</p>
      {note ? <p className="text-[11px] text-[var(--text-muted)] truncate">{note}</p> : null}
    </div>
  );
}

export function PartySummaryDialog({
  party,
  section,
  all,
  dimensions,
  onClose,
  onCall,
}: {
  /** The party to summarise; null keeps the dialog closed. */
  party: DpdParty | null;
  /** The section the party is in: part of the id its call summaries are filed under. */
  section: DpdSectionKey;
  /** Every party in the section, for the rank, the share and the customer's other rows. */
  all: readonly DpdParty[];
  dimensions: readonly DimensionDef[];
  onClose: () => void;
  onCall: (p: DpdParty) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (party && !dialog.open) {
      dialog.showModal();
      closeRef.current?.focus();
    } else if (!party && dialog.open) {
      dialog.close();
    }
  }, [party]);

  const sectionTotal = useMemo(() => totalsOf(all).pending, [all]);
  const ranked = useMemo(() => [...all].sort((a, b) => b.pending - a.pending), [all]);

  const rank = party ? ranked.indexOf(party) + 1 : 0;
  const rowsOfCustomer = party ? ranked.filter((p) => customerKey(p.customer) === customerKey(party.customer)) : [];
  const combined = totalsOf(rowsOfCustomer);
  const numbers = party ? phoneNumbers(party.phone) : [];
  const metaOf = (p: DpdParty) =>
    dimensions
      .map((d) => [d.label, dimensionValue(p, d.field)] as const)
      .filter(([, v]) => v)
      .map(([label, v]) => `${label}: ${v}`)
      .join(" · ");
  const rowLabel = (p: DpdParty) =>
    dimensions.map((d) => dimensionValue(p, d.field)).filter(Boolean).join(" · ") || "No details";

  return (
    <dialog
      ref={ref}
      aria-labelledby="dpd-summary-title"
      onClose={onClose}
      // A click on the backdrop lands on the <dialog> itself; one on the sheet lands inside it.
      onClick={(e) => {
        if (e.target === e.currentTarget) e.currentTarget.close();
      }}
      className="m-auto w-[94vw] max-w-[32rem] max-h-[90vh] overflow-y-auto rounded-md bg-white p-0 text-left shadow-[0_8px_32px_rgba(0,28,36,0.28)] backdrop:bg-black/40 scale-100 transition-[opacity,scale] duration-150 ease-out starting:open:opacity-0 starting:open:scale-95 motion-reduce:transition-none"
    >
      {party ? (
        <>
          <div className="px-5 pt-5 pb-3 border-b border-[var(--aws-border)]">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--aws-orange)]">Customer summary</p>
            <h2 id="dpd-summary-title" className="mt-1 text-[15px] font-semibold leading-[20px] text-[var(--text-primary)] break-words">
              {party.customer}
              {party.remarks && isFlag(party.remarks) ? <Remark text={party.remarks} /> : null}
            </h2>
            {metaOf(party) ? <p className="mt-0.5 text-[12px] text-[var(--text-secondary)]">{metaOf(party)}</p> : null}
          </div>

          <div className="px-5 py-4 space-y-5">
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Outstanding" value={formatInr(party.pending)} />
              <Stat
                label="Over 90 days"
                value={hasDues(party.ageing.gt90) ? formatInr(party.ageing.gt90) : "—"}
                note={hasDues(party.ageing.gt90) ? `${formatShare(party.ageing.gt90, party.pending)} of its dues` : "None"}
              />
              <Stat label="Rank by outstanding" value={`#${rank}`} note={`of ${all.length} parties`} />
              <Stat label="Share of section" value={formatShare(party.pending, sectionTotal)} note={`of ${formatInr(sectionTotal)}`} />
            </div>

            <div>
              <h3 className={H3}>Ageing</h3>
              <AgeingBar ageing={party.ageing} height={10} className="mt-2" />
              <table className="mt-2 w-full text-[12px] border-collapse">
                <caption className="sr-only">Outstanding by age</caption>
                <tbody>
                  {[...AGE_BUCKETS].reverse().map((b) => {
                    const v = party.ageing[b.key];
                    return (
                      <tr key={b.key}>
                        <th scope="row" className={`${TD} text-left font-normal text-[var(--text-secondary)]`}>
                          <span className="flex items-center gap-1.5">
                            <Swatch bucket={b.key} />
                            {b.label}
                          </span>
                        </th>
                        <td className={`${TD_NUM} font-medium text-[var(--text-primary)]`}>
                          {hasDues(v) ? formatInr(v) : <Dash />}
                        </td>
                        <td className={`${TD_NUM} w-16 text-[var(--text-muted)]`}>{hasDues(v) ? formatShare(v, party.pending) : ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {rowsOfCustomer.length > 1 ? (
              <div>
                <h3 className={H3}>All rows for this customer</h3>
                <table className="mt-1 w-full text-[12px] border-collapse">
                  <caption className="sr-only">This customer&apos;s rows in the report, and their total</caption>
                  <thead>
                    <tr>
                      <th scope="col" className="py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Row</th>
                      <th scope="col" className="py-1.5 pl-3 text-right text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Outstanding</th>
                      <th scope="col" className="py-1.5 pl-3 text-right text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)] whitespace-nowrap">&gt; 90 days</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rowsOfCustomer.map((p, i) => (
                      <tr key={i} className={p === party ? "bg-[#fdf6f6]" : ""}>
                        <th scope="row" className={`${TD} text-left font-normal text-[var(--text-secondary)] break-words`}>
                          {rowLabel(p)}
                          {p === party ? <span className="ml-1.5 text-[10px] text-[var(--text-muted)]">(this row)</span> : null}
                        </th>
                        <td className={`${TD_NUM} font-medium text-[var(--text-primary)]`}>{formatInr(p.pending)}</td>
                        <td className={`${TD_NUM} text-[var(--text-secondary)]`}>
                          {hasDues(p.ageing.gt90) ? formatInr(p.ageing.gt90) : <Dash />}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <th scope="row" className={`${TD} text-left font-semibold text-[var(--text-primary)]`}>Combined</th>
                      <td className={`${TD_NUM} font-semibold text-[var(--text-primary)]`}>{formatInr(combined.pending)}</td>
                      <td className={`${TD_NUM} font-semibold text-[var(--text-primary)]`}>
                        {hasDues(combined.ageing.gt90) ? formatInr(combined.ageing.gt90) : <Dash />}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            ) : null}

            {party.remarks && !isFlag(party.remarks) ? (
              <div>
                <h3 className={H3}>Remarks</h3>
                <p className="mt-1.5 rounded-[2px] bg-[var(--surface-subtle)] border border-[var(--surface-divider)] px-2.5 py-2 text-[12px] leading-[18px] text-[var(--text-primary)] whitespace-pre-line break-words">
                  {party.remarks}
                </p>
              </div>
            ) : null}

            <CallSummaries key={partyKey(section, party)} partyKey={partyKey(section, party)} />

            <div>
              <h3 className={H3}>Contact</h3>
              {numbers.length > 0 ? (
                <p className="mt-1.5 text-[13px] font-medium tabular-nums text-[var(--text-primary)] select-all">{numbers.join(" / ")}</p>
              ) : (
                <p className="mt-1.5 text-[12px] text-[var(--text-secondary)]">No phone number on file for this party yet.</p>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 px-5 py-3 border-t border-[var(--aws-border)] bg-[var(--surface-subtle)]">
            <button
              ref={closeRef}
              type="button"
              onClick={() => ref.current?.close()}
              className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] font-medium text-[var(--text-primary)] hover:bg-[var(--surface-subtle)]"
            >
              Close
            </button>
            <button
              type="button"
              onClick={() => onCall(party)}
              className="inline-flex items-center gap-2 h-9 px-4 rounded-[2px] bg-[var(--aws-orange)] text-[13px] font-semibold text-white hover:bg-[var(--aws-orange-hover)]"
            >
              <PhoneIcon className="w-4 h-4" />
              Call now
            </button>
          </div>
        </>
      ) : null}
    </dialog>
  );
}
