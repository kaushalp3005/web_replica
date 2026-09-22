"use client";

// "Requisitions for this job card" — on the Material allocation tab, below the
// BOM articles. Every floor requisition this job card has raised, newest first:
// Mark received on issued ones, Cancel on raised ones, each only with its
// permission. Bordered table from md up; stacked cards below it.
//
// The tab owns the list (it also drives the Request column), so this renders
// what it is given and asks the tab to reload after any change. A 409 — someone
// already moved the request on — reloads too, which shows what happened.

import { useState } from "react";
import { BTN, BTN_LINK, CancelRequisitionDialog, StatusTag } from "@/components/floor-requisitions/RequisitionUi";
import { friendlyApiError } from "@/lib/apiErrors";
import { formatQty, formatWhen, storeResponseLine } from "@/lib/floor-requisition-form";
import { receiveFloorRequisition, RequisitionConflictError, type FloorRequisition } from "@/lib/floor-requisitions";
import { useHasPermission } from "@/lib/user";

// The tab's own card and cell classes, so the section reads as part of it.
const CARD =
  "bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-3 sm:p-4 mb-4";
const HEADING = "text-[12px] uppercase tracking-wide font-semibold text-[var(--text-secondary)]";
const TABLE = "w-full text-[12px] border-collapse";
const TH =
  "border border-[var(--aws-border)] bg-[#fafafa] px-2.5 py-2 text-left text-[10px] font-bold uppercase " +
  "tracking-wide text-[var(--text-secondary)] whitespace-nowrap";
const TD = "border border-[var(--aws-border)] px-2.5 py-2 align-top";
const HINT = "text-[12px] text-[var(--text-muted)] italic";
const SUB = "text-[11px] text-[var(--text-muted)] break-words";

function Issued({ r }: { r: FloorRequisition }) {
  if (r.issued_qty == null) return <span className="text-[var(--text-muted)]">—</span>;
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span className="font-mono tabular-nums whitespace-nowrap">{formatQty(r.issued_qty, r.requested_unit)}</span>
      <span className={SUB}>{r.issued_by} · {formatWhen(r.issued_at)}</span>
      {r.issue_note ? <span className={SUB}>{r.issue_note}</span> : null}
    </span>
  );
}

function Status({ r }: { r: FloorRequisition }) {
  const detail =
    r.status === "received" ? `${r.received_by ?? ""} · ${formatWhen(r.received_at)}`
    : r.status === "cancelled" ? `${r.cancel_reason ?? ""} — ${r.cancelled_by ?? ""}`
    // Store's Accept / Hold reply on WhatsApp, so the floor knows it was seen.
    : r.status === "raised" ? storeResponseLine(r.store_response)
    : null;
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <StatusTag status={r.status} />
      {detail ? <span className={SUB}>{detail}</span> : null}
    </span>
  );
}

function Raised({ r }: { r: FloorRequisition }) {
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span className="break-words">{r.raised_by}</span>
      <span className={SUB}>{formatWhen(r.raised_at)}</span>
      {r.note ? <span className={SUB}>{r.note}</span> : null}
    </span>
  );
}

export function JobCardRequisitions({
  rows, error, onRetry, onChanged,
}: {
  /** null while loading. */
  rows: FloorRequisition[] | null;
  error: string | null;
  onRetry: () => void;
  onChanged: () => void;
}) {
  const canReceive = useHasPermission("production", "floor_requisitions", null, "receive");
  const canCancel = useHasPermission("production", "floor_requisitions", null, "cancel");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<FloorRequisition | null>(null);
  const hasActions = canReceive || canCancel;

  async function receive(r: FloorRequisition) {
    setBusyId(r.requisition_id);
    setActionErr(null);
    try {
      await receiveFloorRequisition(r.requisition_id);
      onChanged();
    } catch (e) {
      if (e instanceof RequisitionConflictError) onChanged();
      else setActionErr(friendlyApiError(e));
    } finally {
      setBusyId(null);
    }
  }

  function action(r: FloorRequisition) {
    if (r.status === "issued" && canReceive) {
      const busy = busyId === r.requisition_id;
      return (
        <button type="button" className={BTN} disabled={busy} onClick={() => void receive(r)}>
          {busy ? "Saving…" : "Mark received"}
        </button>
      );
    }
    if (r.status === "raised" && canCancel) {
      return <button type="button" className={BTN_LINK} onClick={() => setCancelling(r)}>Cancel</button>;
    }
    return null;
  }

  return (
    <div className={CARD}>
      <h4 className={`${HEADING} mb-2`}>
        Requisitions for this job card{rows ? ` (${rows.length})` : ""}
      </h4>
      {error ? (
        <p className="text-[12px] text-[var(--aws-error)]">
          {error}{" "}
          <button type="button" onClick={onRetry} className="underline">Retry</button>
        </p>
      ) : rows === null ? (
        <p className={HINT}>Loading requisitions…</p>
      ) : rows.length === 0 ? (
        <p className={HINT}>No requisitions raised for this job card yet.</p>
      ) : (
        <>
          {actionErr ? <p role="alert" className="mb-2 text-[12px] text-[var(--aws-error)]">{actionErr}</p> : null}
          <div className="hidden md:block overflow-x-auto">
            <table className={TABLE}>
              <thead>
                <tr>
                  <th className={TH}>Number</th>
                  <th className={TH}>Article</th>
                  <th className={`${TH} text-right`}>Requested</th>
                  <th className={TH}>Issued</th>
                  <th className={TH}>Status</th>
                  <th className={TH}>Raised</th>
                  {hasActions ? <th className={TH}>Action</th> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.requisition_id}>
                    <td className={`${TD} font-mono whitespace-nowrap`}>#{r.requisition_id}</td>
                    <td className={`${TD} text-[var(--text-primary)]`}>
                      {r.material_sku_name}
                      {r.item_type ? <span className="text-[var(--text-muted)]"> · {r.item_type}</span> : null}
                    </td>
                    <td className={`${TD} text-right font-mono tabular-nums whitespace-nowrap`}>
                      {formatQty(r.requested_qty, r.requested_unit)}
                    </td>
                    <td className={TD}><Issued r={r} /></td>
                    <td className={TD}><Status r={r} /></td>
                    <td className={TD}><Raised r={r} /></td>
                    {hasActions ? <td className={TD}>{action(r)}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="md:hidden space-y-2">
            {rows.map((r) => {
              const act = action(r);
              return (
                <li key={r.requisition_id} className="border border-[var(--aws-border)] rounded-[2px] bg-white p-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 break-words text-[13px] font-medium text-[var(--text-primary)]">
                      {r.material_sku_name}
                    </span>
                    <span className="shrink-0 font-mono text-[12px] text-[var(--text-secondary)]">#{r.requisition_id}</span>
                  </div>
                  <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
                    <dt className="text-[var(--text-muted)]">Status</dt>
                    <dd><Status r={r} /></dd>
                    <dt className="text-[var(--text-muted)]">Requested</dt>
                    <dd className="font-mono tabular-nums">{formatQty(r.requested_qty, r.requested_unit)}</dd>
                    <dt className="text-[var(--text-muted)]">Issued</dt>
                    <dd><Issued r={r} /></dd>
                    <dt className="text-[var(--text-muted)]">Raised</dt>
                    <dd><Raised r={r} /></dd>
                  </dl>
                  {act ? <div className="mt-2 border-t border-[var(--aws-border)] pt-2">{act}</div> : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {cancelling ? (
        <CancelRequisitionDialog
          requisition={cancelling}
          onClose={() => setCancelling(null)}
          onDone={() => { setCancelling(null); onChanged(); }}
        />
      ) : null}
    </div>
  );
}
