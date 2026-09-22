"use client";

// Issue dialog — store records what it sent against a raised floor requisition.
// Issued quantity opens with the requested quantity, in the request's unit. It
// may differ: less (the floor raises another request for the rest) or more.
// A 409 — someone already issued or cancelled it — closes and reloads the list.

import { useRef, useState, type FormEvent } from "react";
import {
  BTN, BTN_PRIMARY, FIELD, RequisitionFacts, RequisitionModal, TEXTAREA,
} from "@/components/floor-requisitions/RequisitionUi";
import { friendlyApiError } from "@/lib/apiErrors";
import { checkQty } from "@/lib/floor-requisition-form";
import { issueFloorRequisition, RequisitionConflictError, type FloorRequisition } from "@/lib/floor-requisitions";

export function IssueDialog({
  requisition, onClose, onDone,
}: {
  requisition: FloorRequisition;
  onClose: () => void;
  onDone: () => void;
}) {
  const qtyRef = useRef<HTMLInputElement>(null);
  const unit = requisition.requested_unit;
  const [qty, setQty] = useState(() => String(requisition.requested_qty));
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const checked = checkQty(qty, unit);
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await issueFloorRequisition(requisition.requisition_id, {
        issued_qty: checked.value,
        issue_note: note.trim() || undefined,
      });
      onDone();
    } catch (err) {
      if (err instanceof RequisitionConflictError) onDone();
      else setError(friendlyApiError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <RequisitionModal title="Issue material" onClose={onClose} initialFocus={qtyRef}>
      <form onSubmit={submit} className="flex flex-col gap-3 p-4">
        <RequisitionFacts r={requisition} />
        <label className="flex flex-col gap-1 text-[12px] text-[var(--text-secondary)]">
          Issued quantity
          <span className="flex items-center gap-2">
            <input
              ref={qtyRef}
              inputMode="decimal"
              autoComplete="off"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              className={`${FIELD} min-w-0 flex-1 font-mono`}
            />
            <span className="text-[13px] text-[var(--text-primary)]">{unit}</span>
          </span>
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-[var(--text-secondary)]">
          Note (optional)
          <textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} className={TEXTAREA} />
        </label>
        {error ? <p role="alert" className="text-[12px] text-[var(--aws-error)]">{error}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={BTN} onClick={onClose}>Cancel</button>
          <button type="submit" className={BTN_PRIMARY} disabled={saving}>{saving ? "Issuing…" : "Issue"}</button>
        </div>
      </form>
    </RequisitionModal>
  );
}
