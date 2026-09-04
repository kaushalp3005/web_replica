"use client";

// "Change expected date" from the overdue-dispatch reminder mail. A native
// <input type="date"> deliberately: the business head arrives from an email with no
// portal session and should never have to know the wire format. The control emits
// YYYY-MM-DD, which is exactly what the backend's Optional[date] takes — the same
// pairing the job card's DispatchPlanCard already uses for this field.

import { useState } from "react";

export function RedateDialog({ current, busy, onCancel, onSubmit }: {
  current?: string | null;
  busy?: boolean;
  onCancel: () => void;
  onSubmit: (isoDate: string) => void;
}) {
  const [value, setValue] = useState((current ?? "").slice(0, 10));
  // Local calendar day, not toISOString()'s UTC one: the reminder scan that will
  // re-evaluate this date runs on the IST day, and for the first 5.5h of each IST
  // day a UTC "today" is still yesterday — which would let the BH pick a date that
  // is already overdue and get chased again on the next tick.
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const invalid = !value || value < today;
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-3"
      onClick={() => { if (!busy) onCancel(); }}>
      <div className="bg-white rounded-md w-full max-w-sm p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-[15px] font-semibold text-[var(--text-primary)] mb-1">Change expected dispatch date</h3>
        <p className="text-[13px] text-[var(--text-secondary)] mb-3">
          The NPD team is notified of the new date, and the daily overdue reminders stop
          until it passes.
        </p>
        <label className="block text-[11px] text-[var(--text-secondary)]">New expected dispatch date
          <input className="form-input mt-0.5" type="date" min={today} autoFocus
            value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        {value && value < today && (
          <p className="mt-1 text-[12px] text-[var(--aws-error)]">Pick a date in the future.</p>
        )}
        <div className="flex gap-2 mt-4">
          <button disabled={busy} onClick={onCancel}
            className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] disabled:opacity-50 hover:bg-[var(--surface-subtle)]">Cancel</button>
          <div className="flex-1" />
          <button disabled={busy || invalid} onClick={() => onSubmit(value)}
            className="h-9 px-5 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">
            {busy ? "Saving…" : "Save new date"}
          </button>
        </div>
      </div>
    </div>
  );
}
