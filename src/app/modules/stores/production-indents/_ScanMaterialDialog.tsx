"use client";

// Scan material on an ISSUED request — the job card's box scanner, laid out like
// its Raw Material tab, plus a manual print for boxes that have no sticker:
// camera scanner, manual print (_ManualPrint: Material-In's box sections), a
// per-article total and the request's box list, paged by the server, 10 a page
// (newest first), with Find box to jump to one box's page.
//
// Boxes are stored on the request (floor_requisition_box, via
// /floor-requisitions/{id}/boxes); a printed box is also minted in sfg_box as
// item_type 'rm'. A scan sends the raw QR and the server looks the box up in the
// job card scanner's own tables (sfg_box, po_box, then the wider identify), so
// its article, weights and Txn arrive with it. The floor still scans the boxes
// into the job card, where RM issued is counted.
//
// The header totals, the per-article summary and Manual print's next "Box #"
// come with every page and cover the whole request, not just the page shown.

import { useCallback, useEffect, useRef, useState } from "react";
import { QrScanner } from "@/app/modules/job-card/[id]/_RawMaterialTab";
import { PrinterIcon } from "@/app/modules/purchase/material-in/[transaction_no]/_SectionEditor";
import { BTN, FIELD, RequisitionFacts, RequisitionModal } from "@/components/floor-requisitions/RequisitionUi";
import { parseBoxQr } from "@/lib/box-scan";
import { formatQty, formatWhen } from "@/lib/floor-requisition-form";
import {
  listRequisitionBoxes, removeRequisitionBox, RequisitionConflictError, scanRequisitionBox,
  type FloorRequisition, type RequisitionBox, type RequisitionBoxes,
} from "@/lib/floor-requisitions";
import { ManualPrint, OffGradeTag, printStickers } from "./_ManualPrint";

// How long the "Added …" message stays up — same as the job card's.
const TOAST_MS = 3500;
// Boxes per page of the request's list — as Material-In's box table.
const PAGE_SIZE = 10;
// How long a found box stays highlighted.
const HIGHLIGHT_MS = 4000;

type Toast = { kind: "ok" | "err"; text: string } | null;

const SOURCE_TAG: Record<RequisitionBox["source"], { label: string; cls: string }> = {
  printed: { label: "Printed", cls: "border-[#b6dbb1] bg-[#eaf6ed] text-[var(--text-success)]" },
  scanned: { label: "Scanned", cls: "border-[var(--aws-border-strong)] bg-[#fafafa] text-[var(--text-secondary)]" },
};

const ICON_BTN =
  "shrink-0 h-7 w-7 flex items-center justify-center rounded-[2px] border border-[var(--aws-border-strong)] " +
  "text-[var(--text-muted)] disabled:opacity-50";
const PAGER_BTN =
  "h-7 px-2 rounded-[2px] border border-[var(--aws-border-strong)] bg-white disabled:opacity-50 disabled:cursor-not-allowed";

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function ScanMaterialDialog({
  requisition, onClose,
}: {
  requisition: FloorRequisition;
  onClose: () => void;
}) {
  const r = requisition;
  // Focus lands on the top of the dialog, not a control further down: focusing
  // Close (below a tall scanner) would scroll the request's details out of view.
  const topRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [data, setData] = useState<RequisitionBoxes | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [findText, setFindText] = useState("");
  const [findMsg, setFindMsg] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null); // box id Find landed on
  const [toast, setToast] = useState<Toast>(null);
  const [dupWarn, setDupWarn] = useState<string | null>(null); // last repeated box id → red chip on the camera
  const toastTimerRef = useRef<number | null>(null);
  const highlightTimerRef = useRef<number | null>(null);
  // The list request in flight; a newer one aborts it so a stale page can't land.
  const loadCtlRef = useRef<AbortController | null>(null);
  // Guards a double-tap double-submit while a scan round-trip is in flight.
  const scanningRef = useRef(false);

  const boxes = data?.boxes ?? [];
  const page = data?.page ?? 1;
  const pages = data?.pages ?? 1;
  const total = data?.total ?? 0;
  const pageStart = (page - 1) * (data?.page_size ?? PAGE_SIZE);

  const flashToast = useCallback((t: { kind: "ok" | "err"; text: string }) => {
    setToast(t);
    if (toastTimerRef.current != null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), TOAST_MS);
  }, []);
  useEffect(() => () => {
    if (toastTimerRef.current != null) window.clearTimeout(toastTimerRef.current);
    if (highlightTimerRef.current != null) window.clearTimeout(highlightTimerRef.current);
  }, []);

  // One page from the server — or, with `find`, the page holding that box. The
  // server clamps a page past the end to the last page. Resolves to the data, or
  // null when it failed or a newer load replaced it.
  const load = useCallback(async (q: { page: number; find?: string }): Promise<RequisitionBoxes | null> => {
    loadCtlRef.current?.abort();
    const ctl = new AbortController();
    loadCtlRef.current = ctl;
    setLoading(true);
    // A reload for any other reason (a scan, a print, a page) makes the last
    // Find's "isn't on this request" out of date.
    if (!q.find) setFindMsg(null);
    try {
      const d = await listRequisitionBoxes(r.requisition_id, { page: q.page, pageSize: PAGE_SIZE, find: q.find }, ctl.signal);
      if (ctl.signal.aborted) return null;
      setData(d);
      setLoadErr(null);
      return d;
    } catch (e) {
      if (ctl.signal.aborted) return null;
      setLoadErr(errorText(e));
      return null;
    } finally {
      if (loadCtlRef.current === ctl) {
        loadCtlRef.current = null;
        setLoading(false);
      }
    }
  }, [r.requisition_id]);

  useEffect(() => {
    const ctlRef = loadCtlRef;
    // Deferred past the effect body (react-hooks/set-state-in-effect), as the job card's RM tab does.
    queueMicrotask(() => { void load({ page: 1 }); });
    return () => ctlRef.current?.abort();
  }, [load]);

  // Bring the box Find landed on into view once its page has rendered.
  useEffect(() => {
    if (!highlight) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-box="${CSS.escape(highlight)}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlight, data]);

  const handleScan = useCallback((value: string) => {
    const raw = value.trim();
    if (!raw || scanningRef.current) return;
    setDupWarn(null); // a fresh scan clears the previous repeated-box warning
    scanningRef.current = true;
    void (async () => {
      try {
        const box = await scanRequisitionBox(r.requisition_id, raw);
        void load({ page: 1 }); // new boxes go on top
        flashToast(box.article_mismatch
          ? { kind: "err", text: `Added ${box.box_code}, but its article (${box.article}) is not the requested material.` }
          : { kind: "ok", text: `Added ${box.box_code}` });
      } catch (e) {
        if (e instanceof RequisitionConflictError && e.code === "duplicate_box") {
          setDupWarn(parseBoxQr(raw).code || raw);
        }
        flashToast({ kind: "err", text: errorText(e) });
      } finally {
        scanningRef.current = false;
      }
    })();
  }, [r.requisition_id, flashToast, load]);

  const reloadFirstPage = useCallback(() => { void load({ page: 1 }); }, [load]);
  const reloadPage = useCallback(() => { void load({ page }); }, [load, page]);

  async function removeBox(code: string) {
    setRemoving(code);
    try {
      await removeRequisitionBox(r.requisition_id, code);
      void load({ page }); // the server moves back a page if this one emptied
      setDupWarn((w) => (w === code ? null : w));
      flashToast({ kind: "ok", text: `Removed ${code}` });
    } catch (e) {
      flashToast({ kind: "err", text: errorText(e) });
    } finally {
      setRemoving(null);
    }
  }

  function reprint(b: RequisitionBox) {
    printStickers(r, [b]).then(
      () => flashToast({ kind: "ok", text: `Sent ${b.box_code} to print.` }),
      (e) => flashToast({ kind: "err", text: `Couldn't print: ${errorText(e)}` }),
    );
  }

  async function findBox() {
    const q = findText.trim();
    if (!q) return;
    setFindMsg(null);
    const d = await load({ page, find: q });
    if (!d) return;
    if (!d.found) {
      setFindMsg(`Box ${parseBoxQr(q).code || q} isn't on this request.`);
      return;
    }
    setHighlight(d.found);
    if (highlightTimerRef.current != null) window.clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = window.setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
  }

  return (
    // Wide: Material-In's box table (Gross / Net / LOT / Count) doesn't fit 520px.
    <RequisitionModal title="Scan material" onClose={onClose} initialFocus={topRef} wide>
      <div className="flex flex-col gap-3 p-4">
        <div ref={topRef} tabIndex={-1} className="flex flex-col gap-3 outline-none">
          <RequisitionFacts r={r} />
          {r.issued_qty != null ? (
            <p className="text-[12px] text-[var(--text-primary)]">
              <span className="text-[var(--text-muted)]">Issued </span>
              <span className="font-mono tabular-nums">{formatQty(r.issued_qty, r.requested_unit)}</span>
              {r.issued_by ? <span className="text-[var(--text-secondary)]"> · {r.issued_by} · {formatWhen(r.issued_at)}</span> : null}
            </p>
          ) : null}
        </div>

        <QrScanner onResult={handleScan} warning={dupWarn} title="Scan box QR" />

        <ManualPrint
          requisition={r}
          nextNumber={data?.next_box_number ?? null}
          onSaved={reloadFirstPage}
          onStale={reloadPage}
          onMessage={flashToast}
        />

        {toast ? (
          <div
            role="status"
            aria-live="polite"
            className={`px-3 py-2 text-[13px] rounded-[2px] border flex items-center justify-between gap-3 ${
              toast.kind === "ok"
                ? "bg-[#eaf6ed] border-[#b6dbb1] text-[var(--text-success)]"
                : "bg-[#fdecea] border-[#f5c6c2] text-[var(--text-danger)]"
            }`}
          >
            <span className="break-words">{toast.text}</span>
            <button
              type="button"
              onClick={() => setToast(null)}
              aria-label="Dismiss"
              className="shrink-0 text-[15px] leading-none text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              ✕
            </button>
          </div>
        ) : null}

        {/* Net weight per article — the whole request. */}
        {data && data.by_article.length > 0 ? (
          <div className="bg-white border border-[var(--aws-border)] rounded-md overflow-hidden">
            <div className="px-4 py-3 border-b border-[var(--aws-border)]">
              <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">Boxes (per article)</h3>
            </div>
            <ul className="divide-y divide-[var(--aws-border)]">
              {data.by_article.map((it) => (
                <li key={it.article} className="px-4 py-2.5 flex items-center justify-between gap-3">
                  <span className="text-[13px] text-[var(--text-primary)] break-all">{it.article}</span>
                  <span className="shrink-0 text-[13px] font-semibold text-[var(--text-primary)] tabular-nums">
                    {it.net_weight.toFixed(3)} kg
                    <span className="ml-2 text-[11px] font-normal text-[var(--text-muted)]">
                      {it.boxes} box{it.boxes === 1 ? "" : "es"}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* The request's boxes — 🖨 reprints a printed one, ✕ removes one. */}
        <div className="bg-white border border-[var(--aws-border)] rounded-md overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--aws-border)] flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">Boxes for this request</h3>
            <span className="text-[12px] text-[var(--text-muted)] tabular-nums">
              {loading && data ? "Loading… " : ""}
              {data && data.totals.boxes > 0
                ? `${data.totals.boxes} box${data.totals.boxes === 1 ? "" : "es"} · ${data.totals.net_weight.toFixed(3)} kg · ${data.totals.count} units`
                : ""}
            </span>
          </div>

          {/* Find box — a box id, a scanned sticker's QR, or a sticker Box #. */}
          <form
            onSubmit={(e) => { e.preventDefault(); void findBox(); }}
            className="px-4 py-2 border-b border-[var(--aws-border)] flex items-center gap-2"
          >
            <input
              value={findText}
              onChange={(e) => { setFindText(e.target.value); setFindMsg(null); }}
              placeholder="Box id or Box #"
              aria-label="Find box"
              className={`${FIELD} flex-1 min-w-0`}
            />
            <button type="submit" className={BTN} disabled={!findText.trim()}>Find</button>
          </form>
          {findMsg ? (
            <div role="status" className="px-4 py-1.5 border-b border-[var(--aws-border)] text-[12px] text-[var(--text-danger)] break-words">
              {findMsg}
            </div>
          ) : null}

          {!data && loading ? (
            <div className="p-4 text-[12px] text-[var(--text-muted)]">Loading…</div>
          ) : loadErr ? (
            <div className="p-4 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--aws-border)]">
              <span className="text-[12px] text-[var(--text-danger)] break-words">{loadErr}</span>
              <button type="button" className={BTN} onClick={() => void load({ page })}>Retry</button>
            </div>
          ) : null}

          {data && total === 0 ? (
            <div className="p-4 text-center text-[12px] text-[var(--text-muted)]">
              Scan a box QR, or print stickers for boxes without one.
            </div>
          ) : data ? (
            <ul ref={listRef} className="divide-y divide-[var(--aws-border)]">
              {boxes.map((b) => {
                const tag = SOURCE_TAG[b.source];
                const lit = highlight === b.box_code;
                return (
                  <li
                    key={b.box_code}
                    data-box={b.box_code}
                    className={`px-4 py-3 flex items-start justify-between gap-3 transition-colors ${lit ? "bg-[#fff5cc]" : ""}`}
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[13px] text-[var(--text-primary)] break-all">{b.box_code}</span>
                        <span className={`rounded-[2px] border px-1.5 text-[11px] font-semibold ${tag.cls}`}>{tag.label}</span>
                        {b.article_mismatch ? (
                          <span className="rounded-[2px] border border-[#f0c36d] bg-[#fdf3dc] px-1.5 text-[11px] font-semibold text-[#8a5a00]">
                            Different article
                          </span>
                        ) : null}
                      </div>
                      {/* Only the article name wraps; Box #, Lot and Txn each stay whole. */}
                      <div className="text-[12px] text-[var(--text-muted)] break-words">
                        {b.article}
                        <OffGradeTag stockType={b.stock_type} />
                        {b.box_number != null ? <>{" "}<span className="whitespace-nowrap">· Box #{b.box_number}</span></> : null}
                        {b.lot_number ? <>{" "}<span className="whitespace-nowrap">· Lot {b.lot_number}</span></> : null}
                        {b.transaction_no ? <>{" "}<span className="whitespace-nowrap">· Txn {b.transaction_no}</span></> : null}
                      </div>
                      <div className="text-[12px] text-[var(--text-secondary)] mt-0.5 tabular-nums">
                        {b.net_weight != null ? `${b.net_weight.toFixed(3)} kg net` : "— net"}
                        {b.gross_weight != null ? ` · ${b.gross_weight.toFixed(3)} kg gross` : ""}
                        {b.count != null ? ` · ${b.count} units` : ""}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {b.source === "printed" ? (
                        <button
                          type="button"
                          onClick={() => reprint(b)}
                          aria-label={`Reprint box ${b.box_code}`}
                          title="Reprint this sticker"
                          className={`${ICON_BTN} hover:border-[#2c5fa8] hover:text-[#2c5fa8]`}
                        >
                          <PrinterIcon size={12} />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => void removeBox(b.box_code)}
                        disabled={removing === b.box_code}
                        aria-label={`Remove box ${b.box_code}`}
                        title="Remove this box"
                        className={`${ICON_BTN} hover:border-[var(--text-danger)] hover:text-[var(--text-danger)]`}
                      >
                        ✕
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {data && pages > 1 ? (
            <div className="px-4 py-2 border-t border-[var(--aws-border)] flex flex-wrap items-center gap-2 text-[12px]">
              <button type="button" disabled={page <= 1} onClick={() => void load({ page: page - 1 })}
                aria-label="Previous page" className={PAGER_BTN}>‹</button>
              <span className="text-[var(--text-secondary)]">Page {page} of {pages}</span>
              <span className="text-[var(--text-muted)] tabular-nums">
                ({pageStart + 1}–{pageStart + boxes.length} of {total})
              </span>
              <button type="button" disabled={page >= pages} onClick={() => void load({ page: page + 1 })}
                aria-label="Next page" className={PAGER_BTN}>›</button>
            </div>
          ) : null}
        </div>

        <div className="flex justify-end">
          <button type="button" className={BTN} onClick={onClose}>Close</button>
        </div>
      </div>
    </RequisitionModal>
  );
}
