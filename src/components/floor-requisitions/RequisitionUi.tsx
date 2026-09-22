"use client";

// Shared pieces of the floor-requisition UI. The job card's Material allocation
// tab and Production → Floor Requisitions both use them: the modal shell, the
// status tag, the facts of one request, the cancel dialog, and the field /
// button classes.
//
// The modal follows the job card Amendments dialog: full-screen below md, a
// centred box from md, Esc or a backdrop click closes it, Tab stays inside, and
// focus returns to whatever opened it.

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { friendlyApiError } from "@/lib/apiErrors";
import { formatQty, formatWhen, STATUS_LABEL, type RequisitionStatus } from "@/lib/floor-requisition-form";
import { cancelFloorRequisition, RequisitionConflictError, type FloorRequisition } from "@/lib/floor-requisitions";

export const FIELD =
  "h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none " +
  "focus:border-[var(--aws-navy)] text-[var(--text-primary)]";
export const TEXTAREA =
  "px-2 py-1.5 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none " +
  "focus:border-[var(--aws-navy)] text-[var(--text-primary)] resize-y";
export const BTN =
  "h-8 px-3 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] text-[var(--text-primary)] " +
  "hover:border-[var(--aws-navy)] disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap";
export const BTN_PRIMARY =
  "h-8 px-3 rounded-[2px] border border-[var(--aws-navy)] bg-[var(--aws-navy)] text-white text-[13px] font-semibold " +
  "disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap";
export const BTN_LINK =
  "text-[12px] text-[var(--aws-link)] underline disabled:opacity-50 disabled:cursor-not-allowed";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function RequisitionModal({
  title, onClose, initialFocus, wide = false, children,
}: {
  title: string;
  onClose: () => void;
  /** Focused when the dialog opens. */
  initialFocus: RefObject<HTMLElement | null>;
  /** 760px on desktop instead of 520px — for a dialog holding a wide table. */
  wide?: boolean;
  children: ReactNode;
}) {
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  // The latest onClose, without re-running the open effect — re-running it would
  // pull focus back to the first field on every parent render.
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const trigger = document.activeElement;
    queueMicrotask(() => { initialFocus.current?.focus(); });
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const root = rootRef.current;
      if (!root) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (trigger instanceof HTMLElement) trigger.focus();
    };
  }, [initialFocus]);

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 bg-black/40 flex items-stretch md:items-center justify-center md:p-4"
      onClick={(e) => { if (e.target === e.currentTarget) closeRef.current(); }}
    >
      <div className={`bg-white w-full ${wide ? "md:max-w-[760px]" : "md:max-w-[520px]"} md:rounded-md md:shadow-xl flex flex-col max-h-screen md:max-h-[90vh] overflow-hidden`}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--aws-border)]">
          <h3 id={titleId} className="text-[14px] font-semibold text-[var(--text-primary)]">{title}</h3>
          <button
            type="button"
            onClick={() => closeRef.current()}
            aria-label="Close"
            className="px-1 text-[18px] leading-none text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            ×
          </button>
        </div>
        <div className="overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

const TAG: Record<RequisitionStatus, string> = {
  raised: "bg-[#fff4e0] text-[#8a5300]",
  issued: "bg-[#e8f1fb] text-[#0b5cad]",
  received: "bg-[#eaf6ed] text-[var(--text-success)]",
  cancelled: "bg-[#f2f3f3] text-[var(--text-secondary)]",
};

export function StatusTag({ status }: { status: RequisitionStatus }) {
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap ${TAG[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

const DT = "text-[var(--text-muted)]";

/** One request's facts, for the top of the Issue and Cancel dialogs. */
export function RequisitionFacts({ r }: { r: FloorRequisition }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px] text-[var(--text-primary)]">
      <dt className={DT}>Number</dt>
      <dd className="font-mono">#{r.requisition_id}</dd>
      <dt className={DT}>Article</dt>
      <dd className="break-words">{r.material_sku_name}{r.item_type ? ` · ${r.item_type}` : ""}</dd>
      <dt className={DT}>Place</dt>
      <dd className="break-words">{r.warehouse} · {r.floor} · Job card {r.job_card_id}</dd>
      <dt className={DT}>Requested</dt>
      <dd className="font-mono tabular-nums">{formatQty(r.requested_qty, r.requested_unit)}</dd>
      {r.shortage_qty != null ? (
        <>
          <dt className={DT}>Short when raised</dt>
          <dd className="font-mono tabular-nums">{formatQty(r.shortage_qty, r.requested_unit)}</dd>
        </>
      ) : null}
      <dt className={DT}>Raised</dt>
      <dd className="break-words">{r.raised_by} · {formatWhen(r.raised_at)}</dd>
      {r.note ? (
        <>
          <dt className={DT}>Note</dt>
          <dd className="break-words">{r.note}</dd>
        </>
      ) : null}
    </dl>
  );
}

/** Cancel a raised request, with a reason. `onDone` also fires when someone had
 *  already moved the request on (409): the caller reloads, which shows why. */
export function CancelRequisitionDialog({
  requisition, onClose, onDone,
}: {
  requisition: FloorRequisition;
  onClose: () => void;
  onDone: () => void;
}) {
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!reason.trim()) {
      setError("Give a reason for cancelling.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await cancelFloorRequisition(requisition.requisition_id, reason.trim());
      onDone();
    } catch (err) {
      if (err instanceof RequisitionConflictError) onDone();
      else setError(friendlyApiError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <RequisitionModal title="Cancel request" onClose={onClose} initialFocus={reasonRef}>
      <form onSubmit={submit} className="flex flex-col gap-3 p-4">
        <RequisitionFacts r={requisition} />
        <label className="flex flex-col gap-1 text-[12px] text-[var(--text-secondary)]">
          Reason
          <textarea
            ref={reasonRef}
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className={TEXTAREA}
          />
        </label>
        {error ? <p role="alert" className="text-[12px] text-[var(--aws-error)]">{error}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={BTN} onClick={onClose}>Keep request</button>
          <button type="submit" className={BTN_PRIMARY} disabled={saving}>
            {saving ? "Cancelling…" : "Cancel request"}
          </button>
        </div>
      </form>
    </RequisitionModal>
  );
}
