"use client";

// The "Call now" sheet for one party. Its main action hands the call to the
// Sarvam Collections agent (_AgentCall.tsx); dialling the number yourself is
// still there. Under them: the contact number, which can be changed here
// (_ContactNumber.tsx), the dues to talk about and the collection remarks, so
// whoever is on the call has it all in front of them.
//
// Numbers are the party's contact_number in the database (joined in from the
// debtors contact list when the report is imported). Many parties have none on
// file; the sheet says so rather than offering a link that dials nothing.
//
// A native <dialog> opened with showModal(), styled like the module modals
// elsewhere: Escape, keeping focus inside, and an inert page behind it come
// from the browser instead of hand-rolled listeners.

import { useEffect, useRef } from "react";
import {
  AGE_BUCKETS, formatInr, hasDues, phoneNumbers, telHref, dimensionValue, type DpdParty, type DpdSectionKey,
} from "@/lib/debtors";
import { AgeingBar, PhoneIcon, Remark, Swatch, isFlag } from "./_ui";
import { AgentCall } from "./_AgentCall";
import { ContactNumber } from "./_ContactNumber";
import type { DimensionDef } from "./_sections";

export function CallDialog({
  party,
  section,
  dimensions,
  onClose,
  onViewSummary,
  onContactSaved,
}: {
  /** The party to call; null keeps the dialog closed. */
  party: DpdParty | null;
  /** The tab the party is on; sent with a call so the backend files it there. */
  section: DpdSectionKey;
  dimensions: readonly DimensionDef[];
  onClose: () => void;
  /** Open this party's Summary sheet, where a finished call's summary and conversation are. */
  onViewSummary: (p: DpdParty) => void;
  /** The party's contact number was changed here (null: cleared). */
  onContactSaved: (p: DpdParty, phone: string | null) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (party && !dialog.open) {
      dialog.showModal();
      // Land on Close, never on a button that rings somebody.
      closeRef.current?.focus();
    } else if (!party && dialog.open) {
      dialog.close();
    }
  }, [party]);

  // A phone field can hold several numbers; the main action dials the first,
  // and each one gets its own link when there is more than one.
  const numbers = party ? phoneNumbers(party.phone) : [];
  const tel = numbers.length > 0 ? telHref(numbers[0]) : null;
  // Oldest dues first — the ones the call is about.
  const owed = party ? [...AGE_BUCKETS].reverse().filter((b) => hasDues(party.ageing[b.key])) : [];
  const meta = party
    ? dimensions
        .map((d) => [d.label, dimensionValue(party, d.field)] as const)
        .filter(([, v]) => v)
        .map(([label, v]) => `${label}: ${v}`)
        .join(" · ")
    : "";

  return (
    <dialog
      ref={ref}
      aria-labelledby="dpd-call-title"
      onClose={onClose}
      // A click on the backdrop lands on the <dialog> itself; one on the sheet lands inside it.
      onClick={(e) => {
        if (e.target === e.currentTarget) e.currentTarget.close();
      }}
      className="m-auto w-[92vw] max-w-[26rem] max-h-[90vh] overflow-y-auto rounded-md bg-white p-0 text-left shadow-[0_8px_32px_rgba(0,28,36,0.28)] backdrop:bg-black/40 scale-100 transition-[opacity,scale] duration-150 ease-out starting:open:opacity-0 starting:open:scale-95 motion-reduce:transition-none"
    >
      {party ? (
        <>
          <div className="px-5 pt-5 pb-3 border-b border-[var(--aws-border)]">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--aws-orange)]">
              <PhoneIcon className="w-3.5 h-3.5" />
              Call now
            </p>
            <h2 id="dpd-call-title" className="mt-1 text-[15px] font-semibold leading-[20px] text-[var(--text-primary)] break-words">
              {party.customer}
              {party.remarks && isFlag(party.remarks) ? <Remark text={party.remarks} /> : null}
            </h2>
            {meta ? <p className="mt-0.5 text-[12px] text-[var(--text-secondary)]">{meta}</p> : null}
          </div>

          <div className="px-5 py-4 space-y-4">
            <AgentCall
              key={party.id}
              section={section}
              party={party}
              dialable={numbers.length > 0}
              onViewSummary={() => onViewSummary(party)}
            />

            <ContactNumber
              key={party.id}
              party={party}
              onSaved={(phone) => onContactSaved(party, phone)}
            />

            {party.remarks && !isFlag(party.remarks) ? (
              <div>
                <p className="text-[11px] font-medium text-[var(--text-secondary)]">Remarks</p>
                <p className="mt-1 rounded-[2px] bg-[var(--surface-subtle)] border border-[var(--surface-divider)] px-2.5 py-2 text-[12px] leading-[18px] text-[var(--text-primary)] whitespace-pre-line break-words">
                  {party.remarks}
                </p>
              </div>
            ) : null}

            <div>
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[11px] font-medium text-[var(--text-secondary)]">Outstanding</p>
                <p className="text-[16px] font-semibold tabular-nums text-[var(--text-primary)]">{formatInr(party.pending)}</p>
              </div>
              <AgeingBar ageing={party.ageing} height={8} className="mt-2" />
              {owed.length > 0 ? (
                <ul className="mt-2.5 space-y-1.5">
                  {owed.map((b) => (
                    <li key={b.key} className="flex items-center justify-between gap-3 text-[12px]">
                      <span className="flex items-center gap-1.5 text-[var(--text-secondary)]">
                        <Swatch bucket={b.key} />
                        {b.label}
                      </span>
                      <span className="tabular-nums font-medium text-[var(--text-primary)]">
                        {formatInr(party.ageing[b.key])}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
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
            {tel ? (
              <a
                href={tel}
                className="inline-flex items-center gap-2 h-9 px-4 rounded-[2px] border border-[var(--aws-orange)] bg-white text-[13px] font-semibold text-[var(--aws-orange)] hover:bg-[var(--aws-orange)] hover:text-white"
              >
                <PhoneIcon className="w-4 h-4" />
                Dial {numbers[0]} myself
              </a>
            ) : null}
          </div>
        </>
      ) : null}
    </dialog>
  );
}
