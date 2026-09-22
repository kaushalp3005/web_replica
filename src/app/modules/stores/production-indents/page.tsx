"use client";

// Stores → Production Indents — every material request the production floor has
// sent to the store from a job card's Material allocation tab
// (floor_requisition, server_replica app/modules/floor_requisition).
//
// Requests only ARRIVE here. There is deliberately no way to raise one on this
// screen: a request always comes from a job card, which is what ties it to a
// place, an article on that card's BOM and the shortage the floor saw.
//
// One table, one row per request, every field the request has. The report card:
//   • mouse: rest on a row and its full report (job card, quantities, progress
//     with the time each step took) appears beside it; moving to another row
//     swaps it; it never takes the pointer, so the table stays usable;
//   • keyboard: focusing a request number shows the same card;
//   • click / tap / Enter on the request number pins the report: it then takes
//     the pointer, scrolls if tall, and (from the keyboard) takes focus. Esc, Tab,
//     a second click on the number, or a press or focus outside it closes it;
//     a report the user closed stays closed until the mouse leaves that row.
// Below md the table becomes stacked cards, each with a "Full report" disclosure.
//
// The store's two actions, Issue and Cancel, sit on raised rows for users holding
// production.floor_requisitions.{issue,cancel}; the floor marks a request
// received on its job card. Nothing here moves stock.
//
// Filtered and paged on the server. The server also limits the list to the
// viewer's granted warehouses and floors.

import Link from "next/link";
import {
  useCallback, useEffect, useRef, useState,
  type FocusEvent as ReactFocusEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent,
} from "react";
import { useRouter } from "next/navigation";
import { IssueDialog } from "@/app/modules/production/floor-requisitions/_IssueDialog";
import {
  BTN, BTN_LINK, BTN_PRIMARY, CancelRequisitionDialog, FIELD, StatusTag,
} from "@/components/floor-requisitions/RequisitionUi";
import { FLOORS_BY_WAREHOUSE } from "@/lib/admin-api";
import { friendlyApiError } from "@/lib/apiErrors";
import {
  formatQty, formatWhen, REQUISITION_STATUSES, STATUS_LABEL, storeResponseLine, type RequisitionStatus,
} from "@/lib/floor-requisition-form";
import {
  listFloorRequisitions, RequisitionApiError, type FloorRequisition, type FloorRequisitionPage,
} from "@/lib/floor-requisitions";
import { useHasPermission, useMe, useRequireAuth, useRequireModuleAccess } from "@/lib/user";
import { StoresChrome } from "../_chrome";
import { PendingActionDialog, type IssuedAction } from "./_PendingActionDialog";
import { ScanMaterialDialog } from "./_ScanMaterialDialog";
import { ReportHoverCard, RequestReport, issuedVersusRequested, words } from "./_RequestReport";

const PAGE_SIZE = 50;
const PLANTS = Object.keys(FLOORS_BY_WAREHOUSE);
/** Rest this long on a row before its report opens; once one is open, moving to
 *  another row swaps it at once. */
const OPEN_DELAY_MS = 350;
const CLOSE_DELAY_MS = 120;

const CARD =
  "bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-3 sm:p-4 mb-4";
const TABLE = "w-full text-[12px] border-collapse";
const TH =
  "border border-[var(--aws-border)] bg-[#fafafa] px-2.5 py-2 text-left text-[10px] font-bold uppercase " +
  "tracking-wide text-[var(--text-secondary)] whitespace-nowrap";
const TD = "border border-[var(--aws-border)] px-2.5 py-2 align-top";
const NUM = `${TD} text-right font-mono tabular-nums whitespace-nowrap`;
const HINT = "text-[12px] text-[var(--text-muted)] italic";
const SUB = "block text-[11px] text-[var(--text-muted)] break-words";
const PAGE_BTN =
  "h-7 px-2.5 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[12px] " +
  "hover:border-[var(--aws-navy)] disabled:opacity-50 disabled:cursor-not-allowed";
// The Action column stays in view while the wide table scrolls sideways.
const STICKY_EDGE = "sticky right-0 shadow-[-1px_0_0_var(--aws-border)]";
const DASH = <span className="text-[var(--text-muted)]">—</span>;

/** Which row's report is showing, and where that row sat on screen when it opened. */
interface ReportAnchor {
  id: number;
  top: number;
  bottom: number;
  x: number;
  /** Opened from the request number: stays until Esc / second click / outside. */
  pinned: boolean;
  /** Pinned with Enter or Space: focus moves into the report. */
  viaKeyboard: boolean;
}

function anchorFor(row: Element, id: number, x: number, pinned = false, viaKeyboard = false): ReportAnchor {
  const b = row.getBoundingClientRect();
  return { id, top: b.top, bottom: b.bottom, x, pinned, viaKeyboard };
}

function Chrome({ children }: { children: React.ReactNode }) {
  return <StoresChrome title="Production Indents" showBackToStores wide>{children}</StoresChrome>;
}

function qtyOrDash(n: number | null, unit: string | null | undefined, fallbackUnit: string) {
  return n == null ? DASH : formatQty(n, unit ?? fallbackUnit);
}

function JobCardCell({ r }: { r: FloorRequisition }) {
  const jc = r.job_card;
  const lineage = jc ? [jc.batch_number, jc.process_name, jc.stage ? words(jc.stage) : ""].filter(Boolean).join(" · ") : "";
  return (
    <>
      <Link href={`/modules/job-card/${r.job_card_id}`} className="font-mono text-[var(--aws-link)] underline whitespace-nowrap">
        {jc?.job_card_number ?? `#${r.job_card_id}`}
      </Link>
      {jc ? (
        <>
          <span className="block text-[var(--text-primary)] break-words">{jc.fg_sku_name}</span>
          {jc.customer_name ? <span className={SUB}>{jc.customer_name}</span> : null}
          {lineage ? <span className={SUB}>{lineage}</span> : null}
          <span className={SUB}>Card {words(jc.status).toLowerCase()}{jc.entity ? ` · ${jc.entity.toUpperCase()}` : ""}</span>
        </>
      ) : null}
    </>
  );
}

export default function StoresProductionIndentsPage() {
  const router = useRouter();
  useRequireAuth(router.replace);
  useRequireModuleAccess("stores/production-indents", router.replace);
  const me = useMe();
  const canView = useHasPermission("production", "floor_requisitions", null, "view");
  const canIssue = useHasPermission("production", "floor_requisitions", null, "issue");
  const canCancel = useHasPermission("production", "floor_requisitions", null, "cancel");

  // Opens on every status: this is the store's full record of what was asked for.
  // Newest raised first, so the requests still waiting sit at the top.
  const [status, setStatus] = useState<RequisitionStatus | "">("");
  const [plant, setPlant] = useState("");
  const [floor, setFloor] = useState("");
  const [search, setSearch] = useState("");
  const [searchApplied, setSearchApplied] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<FloorRequisitionPage | null>(null);
  /** When `data` arrived; the report's "open for" figures are measured to it. */
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // A 403 means the picked plant/floor is outside the viewer's grants — not an
  // outage, so it reads calmly and the filters stay usable.
  const [notAssigned, setNotAssigned] = useState(false);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [issuing, setIssuing] = useState<FloorRequisition | null>(null);
  const [cancelling, setCancelling] = useState<FloorRequisition | null>(null);
  const [pending, setPending] = useState<{ kind: IssuedAction; r: FloorRequisition } | null>(null);

  const [report, setReport] = useState<ReportAnchor | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The row under the mouse, so a report closed by a scroll, Esc or a reload can
   *  come back on the next mouse move without leaving the row. */
  const hovered = useRef<{ row: HTMLTableRowElement; id: number; x: number } | null>(null);
  /** The request-number button a pinned report was opened from; Esc returns focus to it. */
  const pinTrigger = useRef<HTMLButtonElement | null>(null);
  /** The row whose report the user just dismissed (Esc, Tab, second click, press
   *  outside). A mouse move on that row must not bring it back; leaving the row
   *  clears it. Closes caused by a scroll, resize or reload do not set it. */
  const dismissedId = useRef<number | null>(null);

  /** A reload is about to remove a pinned report: if it holds focus, hand focus
   *  back to its request number rather than dropping it to <body>. */
  const rescueFocus = useCallback(() => {
    const a = document.activeElement;
    const trigger = pinTrigger.current;
    if (a instanceof Element && a.closest("[data-report-card]") && trigger?.isConnected) {
      trigger.focus({ preventScroll: true });
    }
  }, []);

  const clearTimers = useCallback(() => {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null; }
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  }, []);
  useEffect(() => clearTimers, [clearTimers]);

  // Search is sent a moment after typing stops, not on every key.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearchApplied(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!canView) return;
    const ctrl = new AbortController();
    queueMicrotask(() => {
      setLoading(true);
      listFloorRequisitions(
        { status, warehouse: plant, floor, search: searchApplied, page, pageSize: PAGE_SIZE },
        ctrl.signal,
      )
        .then((p) => {
          if (ctrl.signal.aborted) return;
          setData(p);
          setLoadedAt(Date.now());
          setErr(null);
          setNotAssigned(false);
          // Rows moved under any open (or about to open) report.
          clearTimers();
          rescueFocus();
          setReport(null);
        })
        .catch((e: unknown) => {
          if (ctrl.signal.aborted) return;
          clearTimers();
          rescueFocus();
          setReport(null);
          if (e instanceof RequisitionApiError && e.status === 403) {
            setData(null);
            setErr(null);
            setNotAssigned(true);
          } else {
            setErr(friendlyApiError(e));
            setNotAssigned(false);
          }
        })
        .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    });
    return () => ctrl.abort();
  }, [canView, status, plant, floor, searchApplied, page, attempt, clearTimers, rescueFocus]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const pageCount = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  // Issuing or cancelling the last row of the last page shrinks the list under
  // the reader: step back to the page that now exists.
  useEffect(() => {
    if (data && page > pageCount) queueMicrotask(() => setPage(pageCount));
  }, [data, page, pageCount]);

  // ── report card ────────────────────────────────────────────────────────────

  // While a report shows: a scroll (outside the card) or a resize detaches it
  // from its row, except a keyboard-focus report, which follows its focused
  // number (focusing a row below the fold is itself what scrolls). Esc closes it
  // (returning focus to the number that pinned it), and so does Tab out of a
  // pinned report, so the keyboard carries on from the row instead of the end of
  // the page. A press or a focus move outside a pinned report closes it.
  useEffect(() => {
    if (!report) return;
    const close = (restoreFocus: boolean, dismissed = false) => {
      clearTimers();
      if (dismissed) dismissedId.current = report.id;
      if (restoreFocus && report.pinned) pinTrigger.current?.focus({ preventScroll: true });
      setReport(null);
    };
    const insideCard = (t: EventTarget | null) => t instanceof Element && t.closest("[data-report-card]") !== null;
    const onScroll = (e: Event) => {
      if (insideCard(e.target)) return;
      const a = document.activeElement;
      if (!report.pinned && a instanceof HTMLElement && a.matches("[data-report-trigger]:focus-visible")
          && Number(a.dataset.reportTrigger) === report.id) {
        const row = a.closest("tr");
        if (row) { setReport(anchorFor(row, report.id, a.getBoundingClientRect().left)); return; }
      }
      close(false);
    };
    const onResize = () => close(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(true, true);
      else if (e.key === "Tab" && report.pinned && insideCard(document.activeElement)) {
        e.preventDefault();
        close(true, true);
      }
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target;
      const onTrigger = t instanceof Element && t.closest("[data-report-trigger]") !== null;
      if (report.pinned && !onTrigger && !insideCard(t)) close(false, true);
    };
    const onFocusIn = (e: FocusEvent) => {
      if (report.pinned && e.target !== pinTrigger.current && !insideCard(e.target)) close(false, true);
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [report, clearTimers]);

  /** Start the open delay for the row under the mouse. The row is measured when
   *  the card opens, not when the pointer arrived, so a scroll during the delay
   *  cannot misplace it. */
  function armOpen() {
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      const h = hovered.current;
      if (!h || !h.row.isConnected) return;
      const next = anchorFor(h.row, h.id, h.x);
      setReport((cur) => (cur?.pinned ? cur : next));
    }, OPEN_DELAY_MS);
  }

  function enterRow(e: ReactPointerEvent<HTMLTableRowElement>, r: FloorRequisition) {
    // Touch and pen have no hover; they use the number button instead.
    if (e.pointerType !== "mouse") return;
    dismissedId.current = null;
    hovered.current = { row: e.currentTarget, id: r.requisition_id, x: e.clientX };
    if (report?.pinned) return;
    clearTimers();
    if (report) setReport(anchorFor(e.currentTarget, r.requisition_id, e.clientX));
    else armOpen();
  }

  function moveInRow(e: ReactPointerEvent<HTMLTableRowElement>, r: FloorRequisition) {
    if (e.pointerType !== "mouse") return;
    hovered.current = { row: e.currentTarget, id: r.requisition_id, x: e.clientX };
    // Nothing showing and nothing pending (closed by a scroll or a reload): re-arm.
    // Not after the user dismissed this row's report; that holds until they leave the row.
    if (!report && !openTimer.current && !closeTimer.current && dismissedId.current !== r.requisition_id) armOpen();
  }

  function leaveRow(e: ReactPointerEvent<HTMLTableRowElement>) {
    if (e.pointerType !== "mouse") return;
    if (hovered.current?.row === e.currentTarget) hovered.current = null;
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null; }
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setReport((cur) => (cur?.pinned ? cur : null));
    }, CLOSE_DELAY_MS);
  }

  function leaveTable(e: ReactPointerEvent<HTMLTableSectionElement>) {
    if (e.pointerType !== "mouse") return;
    hovered.current = null;
    dismissedId.current = null;
    clearTimers();
    setReport((cur) => (cur?.pinned ? cur : null));
  }

  function togglePinned(e: ReactMouseEvent<HTMLButtonElement>, r: FloorRequisition) {
    clearTimers();
    if (report?.pinned && report.id === r.requisition_id) {
      dismissedId.current = r.requisition_id;
      setReport(null);
      return;
    }
    dismissedId.current = null;
    const button = e.currentTarget;
    // detail 0 = activated from the keyboard (no pointer position to use).
    const viaKeyboard = e.detail === 0;
    const x = viaKeyboard ? button.getBoundingClientRect().left : e.clientX;
    pinTrigger.current = button;
    setReport(anchorFor(button.closest("tr") ?? button, r.requisition_id, x, true, viaKeyboard));
  }

  function focusNumber(e: ReactFocusEvent<HTMLButtonElement>, r: FloorRequisition) {
    // Keyboard focus only: a mouse click also focuses the button, and pins instead.
    if (report?.pinned || !e.currentTarget.matches(":focus-visible")) return;
    const row = e.currentTarget.closest("tr");
    if (!row) return;
    clearTimers();
    dismissedId.current = null;
    setReport(anchorFor(row, r.requisition_id, e.currentTarget.getBoundingClientRect().left));
  }

  function blurNumber(r: FloorRequisition) {
    setReport((cur) => (cur && !cur.pinned && cur.id === r.requisition_id ? null : cur));
  }

  function startIssue(r: FloorRequisition) { clearTimers(); setReport(null); setIssuing(r); }
  function startCancel(r: FloorRequisition) { clearTimers(); setReport(null); setCancelling(r); }
  function startPending(kind: IssuedAction, r: FloorRequisition) { clearTimers(); setReport(null); setPending({ kind, r }); }

  // ── render ─────────────────────────────────────────────────────────────────

  if (!me) {
    return <Chrome><div className={CARD}><p className={HINT}>Loading…</p></div></Chrome>;
  }
  if (!canView) {
    return (
      <Chrome>
        <div className={CARD}>
          <p className={HINT}>
            You don&apos;t have access to material requests. Ask an admin for the Floor Requisitions view permission.
          </p>
        </div>
      </Chrome>
    );
  }

  const floors = plant
    ? FLOORS_BY_WAREHOUSE[plant] ?? []
    : [...new Set(Object.values(FLOORS_BY_WAREHOUSE).flat())];
  const filtering = status !== "" || plant !== "" || floor !== "" || search.trim() !== "";
  const showActions = canIssue || canCancel;
  const reportRow = report && data ? data.items.find((r) => r.requisition_id === report.id) ?? null : null;
  const reportId = reportRow ? `request-report-${reportRow.requisition_id}` : undefined;

  function action(r: FloorRequisition) {
    // Issued: the next steps for store — scan the material (_ScanMaterialDialog; not
    // stored yet), and edit the indent within limits still to be specified
    // (_PendingActionDialog, a placeholder).
    if (r.status === "issued") {
      if (!canIssue) return null;
      return (
        <span className="inline-flex flex-wrap items-center gap-2">
          <button type="button" className={BTN_PRIMARY} onClick={() => startPending("scan", r)}>Scan</button>
          <button type="button" className={BTN} onClick={() => startPending("edit", r)}>Edit indent</button>
        </span>
      );
    }
    if (r.status !== "raised") return null;
    const issue = canIssue ? <button type="button" className={BTN_PRIMARY} onClick={() => startIssue(r)}>Issue</button> : null;
    const cancel = canCancel ? <button type="button" className={BTN_LINK} onClick={() => startCancel(r)}>Cancel</button> : null;
    if (!issue && !cancel) return null;
    return <span className="inline-flex flex-wrap items-center gap-2">{issue}{cancel}</span>;
  }

  const pager = data && pageCount > 1 ? (
    <nav aria-label="Request pages" className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
      <span className="text-[var(--text-secondary)]">
        {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, data.total)} of {data.total}
      </span>
      <div className="flex items-center gap-1.5">
        <button type="button" className={PAGE_BTN} disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Prev</button>
        <span className="px-1 whitespace-nowrap text-[var(--text-secondary)]">Page {page} of {pageCount}</span>
        <button type="button" className={PAGE_BTN} disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next ›</button>
      </div>
    </nav>
  ) : null;

  return (
    <Chrome>
      <div className="flex flex-wrap items-baseline justify-between gap-3 mb-1">
        <h1 className="text-[20px] leading-[24px] font-semibold text-[var(--text-primary)]">Production Indents</h1>
        {data ? (
          <span className="text-[12px] text-[var(--text-secondary)]">
            {data.total} request{data.total !== 1 ? "s" : ""}{loading ? " · refreshing…" : ""}
          </span>
        ) : null}
      </div>
      <p className="text-[12px] text-[var(--text-secondary)] mb-4">
        Material requests sent from job cards&apos; Material allocation tab. Rest the mouse on a row for the full
        request report, or click its number to pin it.
      </p>

      <div className={CARD}>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search article"
            aria-label="Search article"
            className={`${FIELD} w-full sm:w-auto sm:flex-1 sm:min-w-[220px]`}
          />
          <div className="flex flex-wrap gap-2">
            <select
              value={status}
              onChange={(e) => { setStatus(e.target.value as RequisitionStatus | ""); setPage(1); }}
              aria-label="Filter by status"
              className={`${FIELD} flex-1 sm:flex-none`}
            >
              <option value="">Status: all</option>
              {REQUISITION_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
            <select
              value={plant}
              onChange={(e) => {
                const next = e.target.value;
                setPlant(next);
                if (next && !(FLOORS_BY_WAREHOUSE[next] ?? []).includes(floor)) setFloor("");
                setPage(1);
              }}
              aria-label="Filter by plant"
              className={`${FIELD} flex-1 sm:flex-none`}
            >
              <option value="">Plant: all</option>
              {PLANTS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <select
              value={floor}
              onChange={(e) => { setFloor(e.target.value); setPage(1); }}
              aria-label="Filter by floor"
              className={`${FIELD} flex-1 sm:flex-none`}
            >
              <option value="">Floor: all</option>
              {floors.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          {filtering ? (
            <button
              type="button"
              className={BTN_LINK}
              onClick={() => {
                setStatus(""); setPlant(""); setFloor(""); setSearch(""); setSearchApplied(""); setPage(1);
              }}
            >
              Reset
            </button>
          ) : null}
        </div>
      </div>

      <div className={CARD}>
        {notAssigned ? (
          <p className={HINT}>You are not assigned to that plant or floor. Pick a different one above.</p>
        ) : err ? (
          <p className="text-[12px] text-[var(--aws-error)]">
            {err}{" "}
            <button type="button" onClick={reload} className="underline">Retry</button>
          </p>
        ) : !data ? (
          <p className={HINT}>Loading requests…</p>
        ) : data.items.length === 0 ? (
          <p className={HINT}>
            {filtering
              ? "No requests match these filters."
              : "No material has been requested from a job card in your plants and floors yet."}
          </p>
        ) : (
          <>
            {pager ? <div className="mb-2">{pager}</div> : null}
            <div className="hidden md:block overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr>
                    <th className={TH}>Request</th>
                    <th className={TH}>Raised</th>
                    <th className={TH}>Job card</th>
                    <th className={TH}>Place</th>
                    <th className={TH}>Article</th>
                    <th className={`${TH} text-right`}>Requested</th>
                    <th className={`${TH} text-right`}>Required</th>
                    <th className={`${TH} text-right`}>Fresh stock</th>
                    <th className={`${TH} text-right`}>Shortage</th>
                    <th className={`${TH} text-right`}>Issued</th>
                    <th className={TH}>Received</th>
                    <th className={TH}>Status</th>
                    {showActions ? <th className={`${TH} ${STICKY_EDGE} z-[1]`}>Action</th> : null}
                  </tr>
                </thead>
                <tbody onPointerLeave={leaveTable}>
                  {data.items.map((r) => {
                    const u = r.requested_unit;
                    const active = report?.id === r.requisition_id;
                    const pinnedHere = active && report?.pinned === true;
                    const short = r.shortage_qty != null && r.shortage_qty > 0;
                    const versus = issuedVersusRequested(r);
                    const rowBg = active ? "bg-[#fbeced]" : "bg-white group-hover:bg-[#f7f9fa]";
                    return (
                      <tr
                        key={r.requisition_id}
                        onPointerEnter={(e) => enterRow(e, r)}
                        onPointerMove={(e) => moveInRow(e, r)}
                        onPointerLeave={leaveRow}
                        className={`group transition-colors ${active ? "bg-[#fbeced]" : "hover:bg-[#f7f9fa]"}`}
                      >
                        <td className={`${TD} whitespace-nowrap`}>
                          <button
                            type="button"
                            data-report-trigger={r.requisition_id}
                            onClick={(e) => togglePinned(e, r)}
                            onFocus={(e) => focusNumber(e, r)}
                            onBlur={() => blurNumber(r)}
                            aria-expanded={pinnedHere}
                            aria-controls={active ? reportId : undefined}
                            aria-describedby={active && !pinnedHere ? reportId : undefined}
                            title="Show the full request report"
                            className="font-mono text-[var(--aws-link)] underline decoration-dotted underline-offset-2"
                          >
                            #{r.requisition_id}
                          </button>
                        </td>
                        <td className={TD}>
                          <span className="block break-words">{r.raised_by}</span>
                          <span className={`${SUB} whitespace-nowrap`}>{formatWhen(r.raised_at)}</span>
                          {r.note ? <span className={SUB}>&ldquo;{r.note}&rdquo;</span> : null}
                        </td>
                        <td className={`${TD} min-w-[190px]`}><JobCardCell r={r} /></td>
                        <td className={`${TD} whitespace-nowrap`}>{r.warehouse}<span className={SUB}>{r.floor}</span></td>
                        <td className={`${TD} min-w-[200px] text-[var(--text-primary)]`}>
                          {r.material_sku_name}
                          {r.item_type ? <span className="text-[var(--text-muted)]"> · {r.item_type}</span> : null}
                        </td>
                        <td className={`${NUM} font-semibold`}>{formatQty(r.requested_qty, u)}</td>
                        <td className={NUM}>{qtyOrDash(r.required_qty, r.required_unit, u)}</td>
                        <td className={NUM}>{formatQty(r.available_qty, r.available_unit ?? u)}</td>
                        <td className={`${NUM} ${short ? "text-[var(--aws-error)] font-semibold" : ""}`}>
                          {qtyOrDash(r.shortage_qty, r.shortage_unit, u)}
                        </td>
                        <td className={`${TD} text-right min-w-[150px]`}>
                          <span className="font-mono tabular-nums whitespace-nowrap">{qtyOrDash(r.issued_qty, r.issued_unit, u)}</span>
                          {r.issued_qty != null ? (
                            <>
                              <span className={SUB}>{r.issued_by} · {formatWhen(r.issued_at)}</span>
                              {versus && versus !== "As requested" ? <span className={SUB}>{versus}</span> : null}
                              {r.issue_note ? <span className={SUB}>&ldquo;{r.issue_note}&rdquo;</span> : null}
                            </>
                          ) : null}
                        </td>
                        <td className={TD}>
                          {r.received_at ? (
                            <>
                              <span className="block break-words">{r.received_by}</span>
                              <span className={`${SUB} whitespace-nowrap`}>{formatWhen(r.received_at)}</span>
                            </>
                          ) : DASH}
                        </td>
                        <td className={TD}>
                          <StatusTag status={r.status} />
                          {r.status === "raised" && r.store_response ? (
                            <span className={SUB}>{storeResponseLine(r.store_response)}</span>
                          ) : null}
                          {r.status === "cancelled" ? (
                            <>
                              <span className={SUB}>{r.cancelled_by ?? "—"} · {formatWhen(r.cancelled_at)}</span>
                              {r.cancel_reason ? <span className={SUB}>&ldquo;{r.cancel_reason}&rdquo;</span> : null}
                            </>
                          ) : null}
                        </td>
                        {showActions ? <td className={`${TD} ${STICKY_EDGE} ${rowBg} transition-colors`}>{action(r) ?? DASH}</td> : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <ul className="md:hidden space-y-2">
              {data.items.map((r) => {
                const act = showActions ? action(r) : null;
                return (
                  <li key={r.requisition_id} className="border border-[var(--aws-border)] rounded-[2px] bg-white p-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 break-words text-[13px] font-medium text-[var(--text-primary)]">
                        {r.material_sku_name}
                      </span>
                      <StatusTag status={r.status} />
                    </div>
                    <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
                      <dt className="text-[var(--text-muted)]">Request</dt>
                      <dd className="font-mono">#{r.requisition_id}</dd>
                      <dt className="text-[var(--text-muted)]">Job card</dt>
                      <dd className="min-w-0"><JobCardCell r={r} /></dd>
                      <dt className="text-[var(--text-muted)]">Place</dt>
                      <dd className="break-words">{r.warehouse} · {r.floor}</dd>
                      <dt className="text-[var(--text-muted)]">Requested</dt>
                      <dd className="font-mono tabular-nums">{formatQty(r.requested_qty, r.requested_unit)}</dd>
                      <dt className="text-[var(--text-muted)]">Issued</dt>
                      <dd className="break-words">
                        {r.issued_qty != null
                          ? <><span className="font-mono tabular-nums">{formatQty(r.issued_qty, r.issued_unit ?? r.requested_unit)}</span> · {r.issued_by} · {formatWhen(r.issued_at)}</>
                          : DASH}
                      </dd>
                      <dt className="text-[var(--text-muted)]">Raised</dt>
                      <dd className="break-words">{r.raised_by} · {formatWhen(r.raised_at)}</dd>
                      {r.status === "raised" && r.store_response ? (
                        <>
                          <dt className="text-[var(--text-muted)]">Store</dt>
                          <dd className="break-words">{storeResponseLine(r.store_response)}</dd>
                        </>
                      ) : null}
                    </dl>
                    <details className="mt-2 border-t border-[var(--aws-border)] pt-2">
                      <summary className="cursor-pointer text-[12px] text-[var(--aws-link)] underline">Full report</summary>
                      <div className="mt-2"><RequestReport r={r} asOf={loadedAt} /></div>
                    </details>
                    {act ? <div className="mt-2 border-t border-[var(--aws-border)] pt-2">{act}</div> : null}
                  </li>
                );
              })}
            </ul>
            {pager ? <div className="mt-3">{pager}</div> : null}
          </>
        )}
      </div>

      {report && reportRow && reportId ? (
        <ReportHoverCard
          id={reportId}
          titleId={`${reportId}-title`}
          anchorTop={report.top}
          anchorBottom={report.bottom}
          pointerX={report.x}
          pinned={report.pinned}
          focusOnOpen={report.pinned && report.viaKeyboard}
        >
          <RequestReport r={reportRow} asOf={loadedAt} titleId={`${reportId}-title`} />
        </ReportHoverCard>
      ) : null}

      {issuing ? (
        <IssueDialog
          requisition={issuing}
          onClose={() => setIssuing(null)}
          onDone={() => { setIssuing(null); reload(); }}
        />
      ) : null}
      {cancelling ? (
        <CancelRequisitionDialog
          requisition={cancelling}
          onClose={() => setCancelling(null)}
          onDone={() => { setCancelling(null); reload(); }}
        />
      ) : null}
      {pending ? (
        pending.kind === "scan" ? (
          <ScanMaterialDialog requisition={pending.r} onClose={() => setPending(null)} />
        ) : (
          <PendingActionDialog requisition={pending.r} onClose={() => setPending(null)} />
        )
      ) : null}
    </Chrome>
  );
}
