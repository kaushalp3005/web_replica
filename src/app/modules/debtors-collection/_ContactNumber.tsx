"use client";

// The party's contact number in the "Call now" sheet, and the way to change
// it. This is the number the Sarvam Collections agent rings, so a wrong one is
// fixed here, where it is noticed — and stays fixed: a number saved from the
// screen is never overwritten by the next report import.
//
// The field is free text ("98200 12345 / 96112 74235"). The agent rings the
// first mobile number in it; the rest are there for whoever dials by hand.

import { useId, useState } from "react";
import { phoneNumbers, telHref, type DpdParty } from "@/lib/debtors";
import { saveContactNumber } from "@/lib/debtor-calls";

const LINK = "text-[12px] font-medium text-[var(--aws-link)] hover:underline disabled:opacity-50 disabled:no-underline";

/** Mount with `key={party.id}` so each party starts out of edit mode. */
export function ContactNumber({
  party,
  onSaved,
}: {
  party: DpdParty;
  /** The number as saved; null when it was cleared. */
  onSaved: (phone: string | null) => void;
}) {
  const inputId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const numbers = phoneNumbers(party.phone);

  function startEditing() {
    setDraft(party.phone ?? "");
    setError(null);
    setEditing(true);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      onSaved(await saveContactNumber(party, draft));
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the number.");
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label htmlFor={inputId} className="block text-[11px] font-medium text-[var(--text-secondary)]">
          Contact number
        </label>
        <input
          id={inputId}
          type="tel"
          inputMode="tel"
          autoComplete="off"
          autoFocus
          value={draft}
          maxLength={200}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="98200 12345"
          aria-describedby={`${inputId}-hint`}
          aria-invalid={error ? true : undefined}
          className="mt-1 h-9 w-full px-3 text-[14px] tabular-nums rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[var(--aws-orange)] focus:shadow-[0_0_0_1px_var(--aws-orange)]"
        />
        <p id={`${inputId}-hint`} className="mt-1 text-[11px] leading-[15px] text-[var(--text-muted)]">
          A 10-digit mobile number. For more than one, separate them with “/” — the agent calls the first. Leave it
          blank to remove the number.
        </p>
        {error ? <p role="alert" className="mt-1 text-[12px] text-[#b0280e]">{error}</p> : null}
        <div className="mt-2 flex items-center gap-2">
          <button
            type="submit"
            disabled={saving}
            className="h-8 px-3 rounded-[2px] bg-[var(--aws-orange)] text-[12px] font-semibold text-white hover:bg-[var(--aws-orange-hover)] disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save number"}
          </button>
          <button type="button" disabled={saving} onClick={() => setEditing(false)} className={LINK}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-medium text-[var(--text-secondary)]">
          {numbers.length > 1 ? "Contact numbers" : "Contact number"}
        </p>
        <button type="button" onClick={startEditing} className={LINK}>
          {party.phone ? "Change" : "Add a number"}
        </button>
      </div>
      {numbers.length > 0 ? (
        <ul className="mt-1 space-y-1">
          {numbers.map((n) => (
            <li key={n} className="flex items-center justify-between gap-3">
              <span className="text-[16px] font-semibold tabular-nums text-[var(--text-primary)] select-all">{n}</span>
              {numbers.length > 1 ? (
                <a
                  href={telHref(n) ?? undefined}
                  aria-label={`Call ${n}`}
                  className="shrink-0 text-[12px] font-medium text-[var(--aws-link)] hover:underline"
                >
                  Call
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-[13px] text-[var(--text-secondary)]">
          {party.phone ? `On file: ${party.phone} — not a number that can be dialled.` : "No phone number on file for this party yet."}
        </p>
      )}
    </div>
  );
}
