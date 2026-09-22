"use client";

// Edit indent on an ISSUED request — a placeholder for now.
//
// The button sits in the Stores → Production Indents Action column (beside Scan,
// which opens _ScanMaterialDialog) so store staff can see where this step will
// live. What may still be changed after issue is yet to be specified, so a click
// opens this dialog with the request's facts and says so. Nothing is sent to the
// server. When the limits are defined, only this dialog's body changes.

import { useRef } from "react";
import { BTN, RequisitionFacts, RequisitionModal } from "@/components/floor-requisitions/RequisitionUi";
import { formatQty, formatWhen } from "@/lib/floor-requisition-form";
import type { FloorRequisition } from "@/lib/floor-requisitions";

/** The steps an ISSUED request offers store in the Action column. */
export type IssuedAction = "scan" | "edit";

export function PendingActionDialog({
  requisition, onClose,
}: {
  requisition: FloorRequisition;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const r = requisition;
  return (
    <RequisitionModal title="Edit indent" onClose={onClose} initialFocus={closeRef}>
      <div className="flex flex-col gap-3 p-4">
        <RequisitionFacts r={r} />
        {r.issued_qty != null ? (
          <p className="text-[12px] text-[var(--text-primary)]">
            <span className="text-[var(--text-muted)]">Issued </span>
            <span className="font-mono tabular-nums">{formatQty(r.issued_qty, r.requested_unit)}</span>
            {r.issued_by ? <span className="text-[var(--text-secondary)]"> · {r.issued_by} · {formatWhen(r.issued_at)}</span> : null}
          </p>
        ) : null}
        <p className="rounded-[2px] border border-dashed border-[var(--aws-border-strong)] bg-[#fafafa] px-3 py-2 text-[12px] text-[var(--text-secondary)]">
          Editing an issued indent isn&apos;t set up yet — its limits are still to be defined.
        </p>
        <div className="flex justify-end">
          <button ref={closeRef} type="button" className={BTN} onClick={onClose}>Close</button>
        </div>
      </div>
    </RequisitionModal>
  );
}
