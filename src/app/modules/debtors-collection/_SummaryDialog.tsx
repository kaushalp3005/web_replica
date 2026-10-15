"use client";

// The "Summary" sheet for one party: its collection remarks, the calling
// agent's summaries of earlier calls, and the contact number on file. The dues
// themselves are on the row; this sheet is for what has been said and done.
// A call summary can be added to the remarks, dated, under what is already
// there. "Call now" hands over to the call sheet.
//
// A native <dialog> opened with showModal(), like the call sheet: Escape,
// focus trapping and the inert page behind come from the browser.

import { useEffect, useRef } from "react";
import { phoneNumbers, type DpdParty, type DpdSectionKey } from "@/lib/debtors";
import { saveParty, type CallSummary } from "@/lib/debtor-calls";
import { PhoneIcon } from "./_ui";
import { CallSummaries, remarkLine } from "./_CallSummaries";

const H3 = "text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]";

export function PartySummaryDialog({
  party,
  section,
  onClose,
  onCall,
  onPartyChange,
}: {
  /** The party to summarise; null keeps the dialog closed. */
  party: DpdParty | null;
  section: DpdSectionKey;
  onClose: () => void;
  onCall: (p: DpdParty) => void;
  /** The party was changed here (its remarks): swap `before` for `after` on screen. */
  onPartyChange: (before: DpdParty, after: DpdParty) => void;
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

  const numbers = party ? phoneNumbers(party.phone) : [];

  /** The summary goes under the remarks already there, on a line of its own. */
  async function addToRemarks(s: CallSummary) {
    if (!party) return;
    const line = remarkLine(s);
    const after = await saveParty(section, party, { remarks: party.remarks ? `${party.remarks}\n${line}` : line });
    onPartyChange(party, after);
  }

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
            <h2 id="dpd-summary-title" className="text-[15px] font-semibold leading-[20px] text-[var(--text-primary)] break-words">
              {party.customer}
            </h2>
          </div>

          <div className="px-5 py-4 space-y-5">
            <div>
              <h3 className={H3}>Remarks</h3>
              {party.remarks ? (
                <p className="mt-1.5 rounded-[2px] bg-[var(--surface-subtle)] border border-[var(--surface-divider)] px-2.5 py-2 text-[12px] leading-[18px] text-[var(--text-primary)] whitespace-pre-line break-words">
                  {party.remarks}
                </p>
              ) : (
                <p className="mt-1.5 text-[12px] text-[var(--text-secondary)]">No remarks for this party yet.</p>
              )}
            </div>

            <CallSummaries key={party.id} partyKey={party.id} remarks={party.remarks} onAddToRemarks={addToRemarks} />

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
