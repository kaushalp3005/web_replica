"use client";

// Request dialog — raise a floor requisition for one BOM article, from the
// Request column of the Material allocation tab.
//
// Quantity opens with the shortage (empty when the article is not short), in the
// unit the request will carry. It is checked here with the server's own rules and
// words (lib/floor-requisition-form) before sending; the server still decides.
// A 409 — an open request for this article already exists — shows its message
// inline instead of closing, so the operator sees which request is waiting.

import { useRef, useState, type FormEvent } from "react";
import { BTN, BTN_PRIMARY, FIELD, RequisitionModal, TEXTAREA } from "@/components/floor-requisitions/RequisitionUi";
import { friendlyApiError } from "@/lib/apiErrors";
import { checkQty, defaultRequestQty, formatQty, type RequisitionUnit } from "@/lib/floor-requisition-form";
import { raiseFloorRequisition, RequisitionConflictError, type FloorRequisition } from "@/lib/floor-requisitions";
import type { Coverage } from "@/lib/floorStock";

const DT = "text-[var(--text-muted)]";

export function RequestDialog({
  jobCardId, place, article, itemType, unit, cover, onClose, onRaised,
}: {
  jobCardId: number;
  /** "W202 · First Floor" */
  place: string;
  article: string;
  itemType: string;
  unit: RequisitionUnit;
  /** Fresh stock against the requirement; null when the job card has no requirement for it. */
  cover: Coverage | null;
  onClose: () => void;
  onRaised: (r: FloorRequisition) => void;
}) {
  const qtyRef = useRef<HTMLInputElement>(null);
  // rules.snapshot() on the server counts an indent line in a uom it doesn't
  // recognise, and falls back to pieces (PM) / kg (RM) regardless — so cover
  // can arrive in a different unit than the request itself will carry. When
  // that happens the figures below are not comparable to `unit`, so treat it
  // the same as "no indent line": dashes, and an empty quantity box rather
  // than a shortage figure in the wrong unit.
  const coverInUnit = cover && cover.unit === unit ? cover : null;
  const [qty, setQty] = useState(() => defaultRequestQty(coverInUnit?.balance, unit));
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const short = coverInUnit != null && coverInUnit.balance < 0;

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
      const r = await raiseFloorRequisition({
        job_card_id: jobCardId,
        material_sku_name: article,
        requested_qty: checked.value,
        note: note.trim() || undefined,
      });
      onRaised(r);
    } catch (err) {
      setError(err instanceof RequisitionConflictError ? err.message : friendlyApiError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <RequisitionModal title="Request material" onClose={onClose} initialFocus={qtyRef}>
      <form onSubmit={submit} className="flex flex-col gap-3 p-4">
        <div>
          <p className="text-[13px] font-semibold text-[var(--text-primary)] break-words">{article}</p>
          <p className="text-[12px] text-[var(--text-secondary)]">{itemType} · {place}</p>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px] text-[var(--text-primary)]">
          <dt className={DT}>Required</dt>
          <dd className="font-mono tabular-nums">{coverInUnit ? formatQty(coverInUnit.required, coverInUnit.unit) : "— (no indent line)"}</dd>
          <dt className={DT}>Fresh stock here</dt>
          <dd className="font-mono tabular-nums">{coverInUnit ? formatQty(coverInUnit.available, coverInUnit.unit) : "—"}</dd>
          <dt className={DT}>Shortage</dt>
          <dd className={`font-mono tabular-nums ${short ? "text-[var(--text-danger)] font-semibold" : ""}`}>
            {coverInUnit ? (short ? formatQty(-coverInUnit.balance, coverInUnit.unit) : "None") : "—"}
          </dd>
        </dl>
        <label className="flex flex-col gap-1 text-[12px] text-[var(--text-secondary)]">
          Quantity
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
          <textarea
            rows={2}
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className={TEXTAREA}
          />
        </label>
        {error ? <p role="alert" className="text-[12px] text-[var(--aws-error)]">{error}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={BTN} onClick={onClose}>Cancel</button>
          <button type="submit" className={BTN_PRIMARY} disabled={saving}>
            {saving ? "Raising…" : "Raise request"}
          </button>
        </div>
      </form>
    </RequisitionModal>
  );
}
