"use client";

// The full report of one material request, and the hover card that shows it.
//
// A request is raised from a job card's Material allocation tab
// (floor_requisition). The table on the page carries every column; this report
// arranges the same facts the way a person reads a request: what was asked for
// and for which job, what the floor was looking at when it asked, and how far
// the request has got — with the time each step took.
//
// <RequestReport> is plain markup, used both inside the hover card (desktop) and
// inline under a "Full report" disclosure (phones, where there is no hover).
// <ReportHoverCard> is portalled to <body> so the table's horizontal scroll
// container cannot clip it. It has two modes:
//   • hover (role=tooltip): never takes the pointer (pointer-events: none), so
//     the rows underneath stay hoverable and moving down the table simply swaps
//     the report for the next row's;
//   • pinned (role=dialog, non-modal): opened from the request number. It takes
//     the pointer — a press on it no longer falls through to the row underneath,
//     its text can be selected and a tall report scrolls — and when pinned from
//     the keyboard it takes focus so a screen reader reads it.

import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { StatusTag } from "@/components/floor-requisitions/RequisitionUi";
import { formatQty, formatWhen, STORE_RESPONSE_LABEL } from "@/lib/floor-requisition-form";
import type { FloorRequisition } from "@/lib/floor-requisitions";
import { formatSpan, issuedDelta, placeReport, spanBetween } from "@/lib/request-report";

const SECTION = "text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)] mb-1";
const DT = "text-[var(--text-muted)] whitespace-nowrap";
const DD = "text-[var(--text-primary)] break-words min-w-0";
const QTY = "font-mono tabular-nums";

/** "in_progress" → "In progress". */
export function words(s: string | null | undefined): string {
  if (!s) return "—";
  const t = s.replace(/_/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "—";
}

/** How the issued quantity compares with the request, in words; null until
 *  something was issued. */
export function issuedVersusRequested(r: FloorRequisition): string | null {
  const d = issuedDelta(r.issued_qty, r.requested_qty);
  if (!d) return null;
  if (d.kind === "same") return "As requested";
  const unit = r.issued_unit ?? r.requested_unit;
  return `${formatQty(d.amount, unit)} ${d.kind === "less" ? "less" : "more"} than requested`;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className={DT}>{label}</dt>
      <dd className={DD}>{children}</dd>
    </>
  );
}

function Step({
  done, title, who, when, after, note, pending,
}: {
  done: boolean;
  title: string;
  who?: string | null;
  when?: string | null;
  /** "2 h 10 m after raising" */
  after?: string | null;
  note?: string | null;
  /** Shown instead of who/when while the step has not happened. */
  pending?: string | null;
}) {
  return (
    <li className="relative pl-4">
      <span
        aria-hidden
        className={[
          "absolute left-0 top-[5px] w-2 h-2 rounded-full border",
          done ? "bg-[var(--aws-orange)] border-[var(--aws-orange)]" : "bg-white border-[var(--aws-border-strong)]",
        ].join(" ")}
      />
      <span className="font-semibold text-[var(--text-primary)]">{title}</span>
      {done ? (
        <span className="text-[var(--text-secondary)]">
          {" — "}{who || "—"} · {formatWhen(when)}
          {after ? <span className="text-[var(--text-muted)]"> · {after}</span> : null}
        </span>
      ) : pending ? (
        <span className="text-[var(--text-muted)] italic"> — {pending}</span>
      ) : null}
      {note ? <span className="block text-[11px] text-[var(--text-secondary)] break-words">&ldquo;{note}&rdquo;</span> : null}
    </li>
  );
}

/** The report body. `asOf` is when the list was loaded — the "open for" figure
 *  is measured to it, so the report never reads the clock while rendering. */
export function RequestReport({
  r, asOf, titleId,
}: {
  r: FloorRequisition;
  asOf: number | null;
  /** id for the "Request #…" heading, so a pinned card can be labelled by it. */
  titleId?: string;
}) {
  const jc = r.job_card ?? null;
  const unit = (u: string | null | undefined) => u ?? r.requested_unit;
  const short = r.shortage_qty != null && r.shortage_qty > 0;
  const versus = issuedVersusRequested(r);
  const openFor = r.status === "raised" ? formatSpan(r.raised_at, asOf) : null;
  const awaitingReceipt = r.status === "issued" ? formatSpan(r.issued_at, asOf) : null;
  const issuedAfter = spanBetween(r.raised_at, r.issued_at);
  const receivedAfter = spanBetween(r.issued_at, r.received_at);
  const cancelledAfter = spanBetween(r.raised_at, r.cancelled_at);
  const storeRepliedAfter = spanBetween(r.raised_at, r.store_response?.at);

  return (
    <div className="text-[12px] leading-[17px]">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <p id={titleId} className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)]">
            Request <span className="font-mono normal-case">#{r.requisition_id}</span>
          </p>
          <p className="text-[13px] font-semibold text-[var(--text-primary)] break-words">
            {r.material_sku_name}
            {r.item_type ? (
              <span className="ml-1.5 align-middle inline-block rounded-sm border border-[var(--aws-border)] bg-[var(--surface-subtle)] px-1 text-[10px] font-semibold text-[var(--text-secondary)]">
                {r.item_type}
              </span>
            ) : null}
          </p>
        </div>
        <StatusTag status={r.status} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-3">
        <section>
          <h5 className={SECTION}>Job card</h5>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <Row label="Number"><span className="font-mono">{jc?.job_card_number ?? `#${r.job_card_id}`}</span></Row>
            {jc ? (
              <>
                <Row label="Product">{jc.fg_sku_name}</Row>
                <Row label="Customer">{jc.customer_name || "—"}</Row>
                <Row label="Batch"><span className="font-mono">{jc.batch_number}</span></Row>
                <Row label="Entity">{jc.entity ? jc.entity.toUpperCase() : "—"}</Row>
                <Row label="Process">{jc.process_name}{jc.stage ? ` · ${words(jc.stage)}` : ""}</Row>
                <Row label="Card status">{words(jc.status)}</Row>
              </>
            ) : (
              <Row label="Details">Not available</Row>
            )}
            <Row label="Place">{r.warehouse} · {r.floor}</Row>
          </dl>
        </section>

        <section>
          <h5 className={SECTION}>Quantities</h5>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <Row label="Requested"><span className={`${QTY} font-semibold`}>{formatQty(r.requested_qty, r.requested_unit)}</span></Row>
            <Row label="Required">
              <span className={QTY}>{r.required_qty != null ? formatQty(r.required_qty, unit(r.required_unit)) : "— (no indent line)"}</span>
            </Row>
            <Row label="Fresh stock"><span className={QTY}>{formatQty(r.available_qty, unit(r.available_unit))}</span></Row>
            <Row label="Shortage">
              <span className={`${QTY} ${short ? "text-[var(--aws-error)] font-semibold" : ""}`}>
                {r.shortage_qty != null ? formatQty(r.shortage_qty, unit(r.shortage_unit)) : "—"}
              </span>
            </Row>
            <Row label="Issued">
              <span className={QTY}>{r.issued_qty != null ? formatQty(r.issued_qty, unit(r.issued_unit)) : "—"}</span>
              {versus ? <span className="block text-[11px] text-[var(--text-secondary)]">{versus}</span> : null}
            </Row>
          </dl>
          <p className="mt-1 text-[10px] text-[var(--text-muted)]">
            Required, fresh stock and shortage are as the floor saw them when raising.
          </p>
        </section>
      </div>

      <section className="mt-3">
        <h5 className={SECTION}>Progress</h5>
        <ol className="space-y-1">
          <Step done title="Raised" who={r.raised_by} when={r.raised_at} note={r.note} />
          {r.store_response ? (
            <Step
              done
              title={(STORE_RESPONSE_LABEL as Record<string, string>)[r.store_response.response] ?? "Store replied"}
              who={r.store_response.by}
              when={r.store_response.at}
              after={storeRepliedAfter ? `${storeRepliedAfter} after raising · on WhatsApp` : "on WhatsApp"}
            />
          ) : null}
          {r.status === "cancelled" ? (
            <Step
              done
              title="Cancelled"
              who={r.cancelled_by}
              when={r.cancelled_at}
              after={cancelledAfter ? `${cancelledAfter} after raising` : null}
              note={r.cancel_reason}
            />
          ) : (
            <>
              <Step
                done={r.issued_at != null}
                title="Issued by store"
                who={r.issued_by}
                when={r.issued_at}
                after={issuedAfter ? `${issuedAfter} after raising` : null}
                note={r.issue_note}
                pending={openFor ? `waiting for store · open ${openFor}` : "waiting for store"}
              />
              <Step
                done={r.received_at != null}
                title="Received on the floor"
                who={r.received_by}
                when={r.received_at}
                after={receivedAfter ? `${receivedAfter} after issue` : null}
                pending={
                  r.status === "issued"
                    ? awaitingReceipt ? `waiting for the floor to confirm · issued ${awaitingReceipt} ago` : "waiting for the floor to confirm"
                    : "after store issues"
                }
              />
            </>
          )}
        </ol>
      </section>
    </div>
  );
}

/** The report floating next to a table row. Placed below the row, above it, or
 *  beside the pointer (see placeReport), always inside the viewport. `pinned`
 *  marks a report opened from the request number: it stays until Esc, a second
 *  click on the number, or a press outside it. */
export function ReportHoverCard({
  id, titleId, anchorTop, anchorBottom, pointerX, pinned, focusOnOpen, children,
}: {
  id: string;
  /** The report heading's id; labels the pinned dialog. */
  titleId: string;
  anchorTop: number;
  anchorBottom: number;
  pointerX: number;
  pinned: boolean;
  /** Pinned from the keyboard: move focus into the report. */
  focusOnOpen: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Measure after every render (the content height depends on the request) and
  // place the card directly on the element: no state, so no second render.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { left, top } = placeReport({
      anchorTop, anchorBottom, pointerX,
      width: el.offsetWidth, height: el.offsetHeight,
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
    });
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.visibility = "visible";
  });

  // preventScroll: the page closes the report on any scroll outside it.
  useEffect(() => {
    if (pinned && focusOnOpen) ref.current?.focus({ preventScroll: true });
  }, [id, pinned, focusOnOpen]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={ref}
      id={id}
      data-report-card
      role={pinned ? "dialog" : "tooltip"}
      aria-modal={pinned ? false : undefined}
      aria-labelledby={pinned ? titleId : undefined}
      tabIndex={pinned ? -1 : undefined}
      style={{ position: "fixed", left: 0, top: 0, visibility: "hidden" }}
      className={[
        "z-40 w-[480px] max-w-[calc(100vw-16px)] max-h-[calc(100vh-16px)] outline-none",
        "bg-white rounded-md shadow-[0_8px_24px_rgba(0,28,36,0.22)] p-3",
        pinned
          ? "pointer-events-auto overflow-y-auto overscroll-contain border-2 border-[var(--aws-orange)]"
          : "pointer-events-none overflow-hidden border border-[var(--aws-border)]",
      ].join(" ")}
    >
      {children}
      {pinned ? (
        <p className="mt-2 pt-1.5 border-t border-[var(--aws-border)] text-[10px] text-[var(--text-muted)]">
          Pinned — press Esc, click the request number again, or click outside the report to close.
        </p>
      ) : null}
    </div>,
    document.body,
  );
}
