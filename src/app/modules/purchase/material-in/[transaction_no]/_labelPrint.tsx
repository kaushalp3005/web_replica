"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Web label-printing subsystem (replaces the Electron TSPL/thermal path).
//
// Goal: open the browser's / Windows print preview via window.print() on a
// document laid out as one physical label per page (101.6 × 50.8 mm), and stay
// responsive even when THOUSANDS of labels are printed at once.
//
// How it stays fast at scale:
//   1. Nothing is mounted in the live React tree — labels are assembled as an
//      HTML string and written into a hidden <iframe> once (single parse), so
//      the visible app never reflows.
//   2. QR codes are encoded straight to inline <svg> strings (vector, not
//      canvas — thousands of canvases blow memory) with the `qrcode` package —
//      NOT React SSR; renderToStaticMarkup per box was the bottleneck. Built in
//      yielding chunks so the main thread never blocks; a progress callback
//      drives a small UI while they build. print() is only called at 100%.
//   3. Each label is a fixed-size page (`@page size` + `break-after: page`) with
//      `content-visibility:auto` + `contain-intrinsic-size`, so the print
//      preview paginates lazily instead of laying out every page up front.
//
// The QR encodes JSON `{"tx":"…","bi":"…"}` (tx = transaction_no, bi = box_id) —
// a scan yields both the box and its transaction. The RM/production consumption
// lookup (GET /api/v1/production/boxes/{box_id}) reads the box_id, which stays
// trivially extractable via `JSON.parse(value).bi`; keep that parse step when
// wiring the job-card RM scanner's consume flow. See [[candor-qr-and-rm-box-lookup]].
// ─────────────────────────────────────────────────────────────────────────────

import QRCode, { type QRCodeToStringOptions } from "qrcode";
import type { PrintBox } from "./_boxEngine";

export interface LabelJob {
  entity: string;
  transaction_no: string;
  boxes: PrintBox[];
  /** Called as QR/label markup is generated so the caller can show a progress bar. */
  onProgress?: (done: number, total: number) => void;
}

// Label geometry — matches the TSC TDP-210 stock (101.6 × 50.8 mm @ 203 dpi).
const LABEL_W_MM = 101.6;
const LABEL_H_MM = 50.8;
const SKU_MAX = 35; // wrap threshold, mirrors generateTSPL

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

// Two-line SKU wrap identical to the Electron label: break at the last space
// ≤ SKU_MAX (only if that space is past char 10, else hard-cut), then truncate
// the tail to 33 chars + ".." if it still overflows.
function wrapSku(nameRaw: string): [string, string | null] {
  const name = (nameRaw || "").trim();
  if (name.length <= SKU_MAX) return [name, null];
  let cut = name.lastIndexOf(" ", SKU_MAX);
  if (cut <= 10) cut = SKU_MAX;
  const line1 = name.slice(0, cut).trim();
  let line2 = name.slice(cut).trim();
  if (line2.length > SKU_MAX) line2 = line2.slice(0, 33) + "..";
  return [line1, line2 || null];
}

// Weight cell: "<value>kg" or "-" when blank (raw value, no fixed decimals —
// matches the source, which prints whatever was weighed).
function wt(v: string | null | undefined): string {
  const s = (v ?? "").toString().trim();
  return s === "" ? "-" : `${s}kg`;
}

function printDate(): string {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}

// QR encode options — vector SVG string, error-correction M, quiet-zone 2. The
// QR value is JSON {"tx":<transaction_no>,"bi":<box_id>} so a scan carries both;
// bi stays extractable for the RM lookup via JSON.parse(value).bi.
const QR_OPTS: QRCodeToStringOptions = { type: "svg", errorCorrectionLevel: "M", margin: 2, width: 220 };
const NO_QR = `<div class="noqr">No code<br/>Save first</div>`;

// Encode one box's QR to an <svg> string (or the "save first" placeholder for
// not-yet-saved draft boxes with no box_id).
function qrFor(job: LabelJob, box: PrintBox): Promise<string> {
  if (!box.box_id) return Promise.resolve(NO_QR);
  return QRCode.toString(JSON.stringify({ tx: job.transaction_no, bi: box.box_id }), QR_OPTS);
}

// One label = one page. `box_id` may be null for not-yet-saved draft boxes; the
// label then shows "(unsaved)" so the operator knows to Save before relying on
// the code. Saved boxes carry the real DB id. `qrSvg` is pre-encoded by qrFor.
function renderLabel(job: LabelJob, box: PrintBox, dateStr: string, qrSvg: string): string {
  const boxId = box.box_id ?? "";
  const [sku1, sku2] = wrapSku(box.sku_name);
  const entity = escapeHtml((job.entity || "").toUpperCase());
  const idText = boxId ? escapeHtml(boxId) : "(unsaved)";
  const lotText = escapeHtml((box.lot_number ?? "").trim() || "—");
  // Dynamic parts are pre-escaped; box_number is numeric.
  const metricsA = `Box #${box.box_number} · Lot: ${lotText}`;
  const metricsB = `Net: ${escapeHtml(wt(box.net_weight))} | Gross: ${escapeHtml(wt(box.gross_weight))}`;

  return (
    `<div class="label">` +
    `<div class="qr">${qrSvg}</div>` +
    `<div class="txt">` +
    `<div class="entity">${entity}</div>` +
    `<div class="tx">Txn: ${escapeHtml(job.transaction_no)}</div>` +
    `<div class="bid">ID: ${idText}</div>` +
    `<div class="rule"></div>` +
    `<div class="sku">${escapeHtml(sku1)}</div>` +
    (sku2 ? `<div class="sku">${escapeHtml(sku2)}</div>` : "") +
    `<div class="rule"></div>` +
    `<div class="metrics">${metricsA}</div>` +
    `<div class="metrics">${metricsB}</div>` +
    `<div class="date">Date: ${escapeHtml(dateStr)}</div>` +
    `</div>` +
    `</div>`
  );
}

function buildDocument(labelsHtml: string): string {
  // Self-contained document — no app CSS reaches it. `content-visibility:auto`
  // + `contain-intrinsic-size` let the preview paginate lazily; `contain`
  // stops any label from invalidating its siblings' layout.
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>Box labels</title><style>` +
    `@page{size:${LABEL_W_MM}mm ${LABEL_H_MM}mm;margin:0}` +
    `*{margin:0;padding:0;box-sizing:border-box}` +
    `html,body{margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;` +
    `font-family:'Segoe UI',system-ui,-apple-system,Arial,sans-serif;color:#000;background:#fff}` +
    `.label{width:${LABEL_W_MM}mm;height:${LABEL_H_MM}mm;box-sizing:border-box;overflow:hidden;` +
    `border:1px solid #000;` +
    `padding:2mm;display:grid;grid-template-columns:38mm 1fr;column-gap:2mm;align-items:stretch;` +
    `break-after:page;page-break-after:always;break-inside:avoid;page-break-inside:avoid;` +
    `contain:layout style paint;content-visibility:auto;contain-intrinsic-size:${LABEL_W_MM}mm ${LABEL_H_MM}mm}` +
    `.label:last-child{break-after:auto;page-break-after:auto}` +
    `.qr{width:38mm;height:38mm;align-self:center}.qr svg{width:100%;height:100%;display:block}` +
    `.noqr{width:38mm;height:38mm;display:flex;align-items:center;justify-content:center;text-align:center;` +
    `border:1px dashed #999;font-size:8pt;color:#666;line-height:1.3}` +
    `.txt{display:flex;flex-direction:column;justify-content:flex-start;min-width:0;overflow:hidden}` +
    `.entity{font-size:13pt;font-weight:700;line-height:1.1;letter-spacing:.5px}` +
    `.tx{font-size:9pt;font-weight:600;margin-top:1mm;word-break:break-all}` +
    `.bid{font-size:8pt;margin-top:.4mm}` +
    `.rule{border-top:1px solid #000;margin:.8mm 0}` +
    `.sku{font-size:8.5pt;line-height:1.15;word-break:break-word}` +
    `.metrics{font-size:8pt;font-weight:600}` +
    `.date{font-size:7.5pt;margin-top:.4mm}` +
    `</style></head><body>${labelsHtml}</body></html>`
  );
}

const yieldToMain = (): Promise<void> =>
  new Promise((resolve) => {
    // Prefer the Scheduler API where available (Chrome), else fall back to rAF.
    const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (sched?.yield) sched.yield().then(resolve);
    else requestAnimationFrame(() => resolve());
  });

// Assemble the label sheet off the live tree and open the print preview.
// Resolves once print() has been invoked; the hidden iframe self-removes after
// the print dialog closes (afterprint) or a safety timeout.
export async function printLabels(job: LabelJob): Promise<void> {
  const { boxes } = job;
  if (!boxes || boxes.length === 0) return;
  if (typeof window === "undefined") return;

  const dateStr = printDate();
  const CHUNK = 200;
  const parts: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    const qrSvg = await qrFor(job, boxes[i]);
    parts.push(renderLabel(job, boxes[i], dateStr, qrSvg));
    if ((i + 1) % CHUNK === 0) {
      job.onProgress?.(i + 1, boxes.length);
      await yieldToMain(); // keep the app interactive while thousands build
    }
  }
  job.onProgress?.(boxes.length, boxes.length);

  const html = buildDocument(parts.join(""));

  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  Object.assign(iframe.style, {
    position: "fixed",
    right: "0",
    bottom: "0",
    width: "0",
    height: "0",
    border: "0",
    visibility: "hidden",
  } as CSSStyleDeclaration);
  document.body.appendChild(iframe);

  const cw = iframe.contentWindow;
  const cd = iframe.contentDocument;
  if (!cw || !cd) {
    iframe.remove();
    throw new Error("Could not open a print document.");
  }
  cd.open();
  cd.write(html);
  cd.close();

  // Let the iframe lay out + paint before printing (two rAFs = post-paint).
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

  let torn = false;
  const teardown = () => {
    if (torn) return;
    torn = true;
    // Defer so we don't yank the document out from under the print dialog.
    setTimeout(() => iframe.remove(), 300);
  };
  cw.addEventListener("afterprint", teardown);
  // Safety net: some browsers never fire afterprint (or the user cancels early).
  setTimeout(teardown, 120000);

  cw.focus();
  cw.print();
}
