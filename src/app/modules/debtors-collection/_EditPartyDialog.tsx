"use client";

// The "Edit" sheet for one row of the Parties table, and the confirmation that
// stands between it and the database.
//
// Every value of the row can be changed. Pressing "Save changes" does not
// save: it opens a second popup that lists exactly what will change, old value
// against new, and only "Yes, save" there writes anything. These are the
// figures collection decisions are made on, so nobody should change one by a
// slip of the hand — or without seeing that the buckets no longer add up.
//
// Two native <dialog>s opened with showModal(): the confirmation sits on top of
// the form and makes it inert, and Escape closes whichever is on top.

import { useEffect, useId, useRef, useState } from "react";
import { AGE_BUCKETS, formatInr, type AgeBucketKey, type DpdDimension, type DpdParty, type DpdSectionKey } from "@/lib/debtors";
import { saveParty, type PartyChanges } from "@/lib/debtor-calls";
import type { DimensionDef } from "./_sections";

const SHEET =
  "m-auto rounded-md bg-white p-0 text-left shadow-[0_8px_32px_rgba(0,28,36,0.28)] backdrop:bg-black/40 scale-100 transition-[opacity,scale] duration-150 ease-out starting:open:opacity-0 starting:open:scale-95 motion-reduce:transition-none";
const FIELD =
  "mt-1 h-9 w-full px-3 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[var(--aws-orange)] focus:shadow-[0_0_0_1px_var(--aws-orange)] aria-[invalid=true]:border-[#b0280e]";
const LABEL = "block text-[11px] font-medium text-[var(--text-secondary)]";
const SECONDARY =
  "h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] font-medium text-[var(--text-primary)] hover:bg-[var(--surface-subtle)] disabled:opacity-60";
const PRIMARY =
  "h-9 px-4 rounded-[2px] bg-[var(--aws-orange)] text-[13px] font-semibold text-white hover:bg-[var(--aws-orange-hover)] disabled:opacity-60";

type AmountKey = "pending" | AgeBucketKey;
const AMOUNTS: { key: AmountKey; label: string }[] = [
  { key: "pending", label: "Outstanding" },
  ...AGE_BUCKETS.map((b) => ({ key: b.key as AmountKey, label: b.label })),
];

/** The form's fields, all as the text in their boxes. */
interface Draft {
  customer: string;
  dims: Record<DpdDimension, string>;
  amounts: Record<AmountKey, string>;
  remarks: string;
  phone: string;
}

/** One line of the confirmation: what a field was, and what it will be. */
interface Change {
  label: string;
  from: string;
  to: string;
}

const amountOf = (p: DpdParty, key: AmountKey): number => (key === "pending" ? p.pending : p.ageing[key]);
const tidy = (s: string) => s.replace(/\s+/g, " ").trim();
// Remarks keep their line breaks; each line is tidied, the way the backend stores them.
const tidyNote = (s: string) => s.split(/\r?\n/).map(tidy).filter(Boolean).join("\n");
const shown = (s: string | null) => (s ? s : "(blank)");

/** Rupees to the paisa when there are paise, so ₹100.50 → ₹100.75 does not read as no change. */
function rupees(n: number): string {
  return Number.isInteger(Math.round(n * 100) / 100) ? formatInr(n) : `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "29,60,823.35", "₹ 5000" → a number; null for anything that is not an amount. */
function parseAmount(text: string): number | null {
  const s = text.replace(/[,\s₹]/g, "");
  if (s === "" || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function draftOf(p: DpdParty): Draft {
  return {
    customer: p.customer,
    dims: { division: p.division ?? "", salesPerson: p.salesPerson ?? "", type: p.type ?? "", broker: p.broker ?? "" },
    amounts: Object.fromEntries(AMOUNTS.map((a) => [a.key, String(amountOf(p, a.key))])) as Record<AmountKey, string>,
    remarks: p.remarks ?? "",
    phone: p.phone ?? "",
  };
}

export function EditPartyDialog({
  party,
  section,
  dimensions,
  onClose,
  onSaved,
}: {
  /** The party to edit; null keeps the dialog closed. */
  party: DpdParty | null;
  section: DpdSectionKey;
  /** The section's text columns: each gets a box. */
  dimensions: readonly DimensionDef[];
  onClose: () => void;
  /** The row as the database now has it. */
  onSaved: (before: DpdParty, after: DpdParty) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (party && !dialog.open) dialog.showModal();
    else if (!party && dialog.open) dialog.close();
  }, [party]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="dpd-edit-title"
      onClose={onClose}
      // No close on a backdrop click here: a stray click must not throw away what was typed.
      className={`${SHEET} w-[94vw] max-w-[34rem] max-h-[92vh] overflow-y-auto`}
    >
      {party ? (
        <EditForm
          key={party.id}
          party={party}
          section={section}
          dimensions={dimensions}
          onCancel={() => ref.current?.close()}
          onSaved={(after) => onSaved(party, after)}
        />
      ) : null}
    </dialog>
  );
}

function EditForm({
  party,
  section,
  dimensions,
  onCancel,
  onSaved,
}: {
  party: DpdParty;
  section: DpdSectionKey;
  dimensions: readonly DimensionDef[];
  onCancel: () => void;
  onSaved: (after: DpdParty) => void;
}) {
  const id = useId();
  const confirmRef = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<Draft>(() => draftOf(party));
  // Problems found when "Save changes" was pressed, by field.
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  // What the confirmation is asking about; null while it is closed.
  const [review, setReview] = useState<{ changes: PartyChanges; lines: Change[]; warning: string | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = confirmRef.current;
    if (!dialog) return;
    if (review && !dialog.open) dialog.showModal();
    else if (!review && dialog.open) dialog.close();
  }, [review]);

  /** Check the form and work out what differs from the saved row. */
  function prepare() {
    const found: Record<string, string> = {};
    const changes: PartyChanges = {};
    const lines: Change[] = [];

    const customer = tidy(draft.customer);
    if (!customer) found.customer = "The customer name cannot be blank.";
    else if (customer !== party.customer) {
      changes.customer = customer;
      lines.push({ label: "Customer", from: party.customer, to: customer });
    }

    for (const d of dimensions) {
      const next = tidy(draft.dims[d.field]);
      const was = party[d.field] ?? "";
      if (next !== was) {
        changes[d.field] = next;
        lines.push({ label: d.label, from: shown(was), to: shown(next) });
      }
    }

    const amounts = {} as Record<AmountKey, number>;
    for (const a of AMOUNTS) {
      const n = parseAmount(draft.amounts[a.key]);
      if (n === null) {
        found[a.key] = "Enter an amount, like 250000 or 2,50,000.50.";
        continue;
      }
      amounts[a.key] = n;
      const was = Math.round(amountOf(party, a.key) * 100) / 100;
      if (n !== was) {
        if (a.key === "pending") changes.pending = n;
        else changes.ageing = { ...changes.ageing, [a.key]: n };
        lines.push({ label: a.label, from: rupees(was), to: rupees(n) });
      }
    }

    const remarks = tidyNote(draft.remarks);
    if (remarks !== (party.remarks ?? "")) {
      changes.remarks = remarks;
      lines.push({ label: "Remarks", from: shown(party.remarks), to: shown(remarks) });
    }

    const phone = tidy(draft.phone);
    if (phone !== (party.phone ?? "")) {
      changes.phone = phone;
      lines.push({ label: "Contact number", from: shown(party.phone), to: shown(phone) });
    }

    setProblems(found);
    if (Object.keys(found).length > 0) {
      setNotice("Fix the highlighted fields first.");
      return;
    }
    if (lines.length === 0) {
      setNotice("Nothing has been changed.");
      return;
    }
    // Not a reason to refuse — Tally's own buckets can be a rupee off — but
    // worth saying before the figures are saved.
    const buckets = AGE_BUCKETS.reduce((s, b) => s + amounts[b.key], 0);
    const gap = Math.round((amounts.pending - buckets) * 100) / 100;
    const warning =
      Math.abs(gap) >= 1
        ? `The four age buckets add up to ${rupees(buckets)}, which is ${rupees(Math.abs(gap))} ${gap > 0 ? "less" : "more"} than the outstanding of ${rupees(amounts.pending)}.`
        : null;
    setNotice(null);
    setSaveError(null);
    setReview({ changes, lines, warning });
  }

  async function save() {
    if (!review) return;
    setSaving(true);
    setSaveError(null);
    try {
      const after = await saveParty(section, party, review.changes);
      setReview(null);
      onSaved(after);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Couldn't save the changes.");
    } finally {
      setSaving(false);
    }
  }

  const textBox = (key: string, label: string, value: string, onChange: (v: string) => void, extra?: { type?: string; hint?: string }) => (
    <div>
      <label htmlFor={`${id}-${key}`} className={LABEL}>{label}</label>
      <input
        id={`${id}-${key}`}
        type={extra?.type ?? "text"}
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={problems[key] ? true : undefined}
        aria-describedby={problems[key] ? `${id}-${key}-problem` : extra?.hint ? `${id}-${key}-hint` : undefined}
        className={FIELD}
      />
      {problems[key] ? (
        <p id={`${id}-${key}-problem`} className="mt-1 text-[11px] text-[#b0280e]">{problems[key]}</p>
      ) : extra?.hint ? (
        <p id={`${id}-${key}-hint`} className="mt-1 text-[11px] text-[var(--text-muted)]">{extra.hint}</p>
      ) : null}
    </div>
  );

  return (
    <>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          prepare();
        }}
      >
        <div className="px-5 pt-5 pb-3 border-b border-[var(--aws-border)]">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--aws-orange)]">Edit</p>
          <h2 id="dpd-edit-title" className="mt-1 text-[15px] font-semibold leading-[20px] text-[var(--text-primary)] break-words">
            {party.customer}
          </h2>
        </div>

        <div className="px-5 py-4 space-y-3.5">
          {textBox("customer", "Customer", draft.customer, (v) => setDraft((d) => ({ ...d, customer: v })))}

          {dimensions.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {dimensions.map((d) =>
                textBox(d.field, d.label, draft.dims[d.field], (v) => setDraft((prev) => ({ ...prev, dims: { ...prev.dims, [d.field]: v } }))),
              )}
            </div>
          ) : null}

          {textBox("pending", "Outstanding (₹)", draft.amounts.pending, (v) => setDraft((d) => ({ ...d, amounts: { ...d.amounts, pending: v } })), {
            type: "text",
          })}

          <div className="grid gap-3 grid-cols-2">
            {AGE_BUCKETS.map((b) =>
              textBox(b.key, `${b.label} (₹)`, draft.amounts[b.key], (v) => setDraft((d) => ({ ...d, amounts: { ...d.amounts, [b.key]: v } }))),
            )}
          </div>

          <div>
            <label htmlFor={`${id}-remarks`} className={LABEL}>Remarks</label>
            <textarea
              id={`${id}-remarks`}
              rows={3}
              value={draft.remarks}
              maxLength={4000}
              onChange={(e) => setDraft((d) => ({ ...d, remarks: e.target.value }))}
              className="mt-1 w-full px-3 py-2 text-[13px] leading-[18px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[var(--aws-orange)] focus:shadow-[0_0_0_1px_var(--aws-orange)] resize-y"
            />
          </div>

          {textBox("phone", "Contact number", draft.phone, (v) => setDraft((d) => ({ ...d, phone: v })), {
            type: "tel",
            hint: "A 10-digit mobile number; separate several with “/”. The calling agent rings the first.",
          })}

          <p className="rounded-[2px] bg-[var(--surface-subtle)] border border-[var(--surface-divider)] px-2.5 py-2 text-[11px] leading-[16px] text-[var(--text-secondary)]">
            The next Excel import for this tab writes the report&rsquo;s values over these again, all except the contact
            number.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 px-5 py-3 border-t border-[var(--aws-border)] bg-[var(--surface-subtle)]">
          {notice ? <p role="status" className="mr-auto text-[12px] text-[var(--text-secondary)]">{notice}</p> : null}
          <button type="button" onClick={onCancel} className={SECONDARY}>
            Cancel
          </button>
          <button type="submit" className={PRIMARY}>
            Save changes
          </button>
        </div>
      </form>

      <dialog
        ref={confirmRef}
        aria-labelledby={`${id}-confirm-title`}
        onClose={() => setReview(null)}
        className={`${SHEET} w-[92vw] max-w-[28rem] max-h-[88vh] overflow-y-auto`}
      >
        {review ? (
          <>
            <div className="px-5 pt-5 pb-3 border-b border-[var(--aws-border)]">
              <h2 id={`${id}-confirm-title`} className="text-[15px] font-semibold leading-[20px] text-[var(--text-primary)]">
                Save {review.lines.length === 1 ? "this change" : `these ${review.lines.length} changes`}?
              </h2>
              <p className="mt-0.5 text-[12px] text-[var(--text-secondary)] break-words">{party.customer}</p>
            </div>

            <div className="px-5 py-4">
              <ul className="space-y-2.5">
                {review.lines.map((c) => (
                  <li key={c.label} className="text-[12px] leading-[17px]">
                    <p className="font-medium text-[var(--text-secondary)]">{c.label}</p>
                    <p className="mt-0.5 break-words whitespace-pre-line">
                      <span className="text-[var(--text-muted)] line-through decoration-[var(--text-disabled)]">{c.from}</span>
                      <span aria-hidden className="mx-1.5 text-[var(--text-muted)]">→</span>
                      <span className="sr-only"> changes to </span>
                      <span className="font-semibold text-[var(--text-primary)]">{c.to}</span>
                    </p>
                  </li>
                ))}
              </ul>
              {review.warning ? (
                <p className="mt-3 rounded-[2px] border border-[#e6c47a] bg-[#fdf6e3] px-2.5 py-2 text-[12px] leading-[17px] text-[#6b4e00]">
                  {review.warning} You can still save.
                </p>
              ) : null}
              {saveError ? <p role="alert" className="mt-3 text-[12px] text-[#b0280e]">{saveError}</p> : null}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 px-5 py-3 border-t border-[var(--aws-border)] bg-[var(--surface-subtle)]">
              <button type="button" disabled={saving} onClick={() => confirmRef.current?.close()} className={SECONDARY}>
                Go back
              </button>
              <button type="button" disabled={saving} onClick={save} className={PRIMARY}>
                {saving ? "Saving…" : "Yes, save"}
              </button>
            </div>
          </>
        ) : null}
      </dialog>
    </>
  );
}
