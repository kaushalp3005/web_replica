"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Transfer-In box labels (4" × 2" thermal stock, 101.6 × 50.8 mm).
//
// Third instance of the module-owned label-print pattern — see
// purchase/material-in/[transaction_no]/_labelPrint.tsx and
// customer-returns/_labelPrint.tsx. Same geometry and same plumbing (inline-SVG
// QR, chunked build with yielding, one hidden iframe, afterprint teardown);
// only the label body differs.
//
// Ported from legacy_frontend transfer/transferIn handlePrintQR / handlePrintRange /
// handleBulkPrintQR (ref 1214–1700), which had THREE divergent label templates for the
// same physical sticker — a reprint looked different from the original print. Collapsed
// to one renderer here. Also swapped the legacy canvas dataURL QR for the inline-SVG
// encoder the other two modules use: vector, and thousands of canvases blow memory.
//
// The QR encodes JSON {"tx":…,"bi":…} — the format parseScan() on the receive page and
// the job-card RM scanner both already read.
// ─────────────────────────────────────────────────────────────────────────────

import QRCode, { type QRCodeToStringOptions } from "qrcode";

export interface TransferLabelBox {
  box_id: string;
  transaction_no: string;
  box_number: number;
  item_name: string;
  net_weight: number;
  gross_weight: number;
  lot_number: string;
  /** Marks the sticker with a red ISSUE tag + the reported case pack. */
  has_issue?: boolean;
  issue_case_pack?: string;
}

export interface TransferLabelJob {
  entity: string;
  boxes: TransferLabelBox[];
  onProgress?: (done: number, total: number) => void;
}

const LABEL_W_MM = 101.6;
const LABEL_H_MM = 50.8;
const ITEM_MAX = 35;

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

// Two-line item wrap — same rule as the inward label: break at the last space
// ≤ ITEM_MAX (only if past char 10, else hard-cut), truncating an overlong tail.
function wrapItem(nameRaw: string): [string, string | null] {
  const name = (nameRaw || "").trim();
  if (name.length <= ITEM_MAX) return [name, null];
  let cut = name.lastIndexOf(" ", ITEM_MAX);
  if (cut <= 10) cut = ITEM_MAX;
  const line1 = name.slice(0, cut).trim();
  let line2 = name.slice(cut).trim();
  if (line2.length > ITEM_MAX) line2 = line2.slice(0, 33) + "..";
  return [line1, line2 || null];
}

function printDate(): string {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getFullYear()).slice(-2)}`;
}

const QR_OPTS: QRCodeToStringOptions = { type: "svg", errorCorrectionLevel: "M", margin: 2, width: 220 };

function qrFor(box: TransferLabelBox): Promise<string> {
  return QRCode.toString(JSON.stringify({ tx: box.transaction_no, bi: box.box_id }), QR_OPTS);
}

function renderLabel(job: TransferLabelJob, box: TransferLabelBox, dateStr: string, qrSvg: string): string {
  const [item1, item2] = wrapItem(box.item_name);
  const entity = escapeHtml((job.entity || "").toUpperCase());
  const lotText = escapeHtml((box.lot_number || "").trim().slice(0, 20) || "—");
  const issueTag = box.has_issue ? `<span class="issue">ISSUE</span>` : "";
  const casePack =
    box.has_issue && box.issue_case_pack
      ? `<div class="issueval">Case Pack: ${escapeHtml(box.issue_case_pack)}</div>`
      : "";

  return (
    `<div class="label">` +
    `<div class="qr">${qrSvg}</div>` +
    `<div class="txt">` +
    `<div class="entity">${entity}${issueTag}</div>` +
    `<div class="tx">Txn: ${escapeHtml(box.transaction_no || "—")}</div>` +
    `<div class="bid">ID: ${escapeHtml(box.box_id || "—")}</div>` +
    `<div class="rule"></div>` +
    `<div class="item">${escapeHtml(item1)}</div>` +
    (item2 ? `<div class="item">${escapeHtml(item2)}</div>` : "") +
    `<div class="rule"></div>` +
    `<div class="metrics">Box #${box.box_number} · Net: ${box.net_weight.toFixed(3)}kg</div>` +
    `<div class="metrics">Gross: ${box.gross_weight.toFixed(3)}kg</div>` +
    casePack +
    `<div class="date">Lot: ${lotText} · ${escapeHtml(dateStr)}</div>` +
    `</div>` +
    `</div>`
  );
}

function buildDocument(labelsHtml: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>Transfer box labels</title><style>` +
    `@page{size:${LABEL_W_MM}mm ${LABEL_H_MM}mm;margin:0}` +
    `*{margin:0;padding:0;box-sizing:border-box}` +
    `html,body{margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;` +
    `font-family:'Segoe UI',system-ui,-apple-system,Arial,sans-serif;color:#000;background:#fff}` +
    `.label{width:${LABEL_W_MM}mm;height:${LABEL_H_MM}mm;box-sizing:border-box;overflow:hidden;` +
    `border:1px solid #000;padding:2mm;display:grid;grid-template-columns:38mm 1fr;column-gap:2mm;` +
    `align-items:stretch;break-after:page;page-break-after:always;break-inside:avoid;page-break-inside:avoid;` +
    `contain:layout style paint;content-visibility:auto;contain-intrinsic-size:${LABEL_W_MM}mm ${LABEL_H_MM}mm}` +
    `.label:last-child{break-after:auto;page-break-after:auto}` +
    `.qr{width:38mm;height:38mm;align-self:center}.qr svg{width:100%;height:100%;display:block}` +
    `.txt{display:flex;flex-direction:column;justify-content:flex-start;min-width:0;overflow:hidden}` +
    `.entity{font-size:13pt;font-weight:700;line-height:1.1;letter-spacing:.5px}` +
    `.issue{display:inline-block;margin-left:2mm;padding:0 1mm;border:1px solid #b00;border-radius:1mm;` +
    `background:#fee;color:#b00;font-size:7pt;font-weight:700;vertical-align:middle}` +
    `.tx{font-size:9pt;font-weight:600;margin-top:1mm;word-break:break-all}` +
    `.bid{font-size:8pt;margin-top:.4mm}` +
    `.rule{border-top:1px solid #000;margin:.8mm 0}` +
    `.item{font-size:8.5pt;line-height:1.15;word-break:break-word}` +
    `.metrics{font-size:8pt;font-weight:600}` +
    `.issueval{font-size:7.5pt;font-weight:600;color:#b00}` +
    `.date{font-size:7.5pt;margin-top:.4mm}` +
    `</style></head><body>${labelsHtml}</body></html>`
  );
}

const yieldToMain = (): Promise<void> =>
  new Promise((resolve) => {
    const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (sched?.yield) sched.yield().then(resolve);
    else requestAnimationFrame(() => resolve());
  });

/** Build the label sheet off the live tree and open the print preview. Resolves once
 *  print() has been invoked; the hidden iframe self-removes on afterprint or a timeout. */
export async function printTransferLabels(job: TransferLabelJob): Promise<void> {
  const { boxes } = job;
  if (!boxes || boxes.length === 0) return;
  if (typeof window === "undefined") return;

  const dateStr = printDate();
  const CHUNK = 200;
  const parts: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    parts.push(renderLabel(job, boxes[i], dateStr, await qrFor(boxes[i])));
    if ((i + 1) % CHUNK === 0) {
      job.onProgress?.(i + 1, boxes.length);
      await yieldToMain();
    }
  }
  job.onProgress?.(boxes.length, boxes.length);

  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  Object.assign(iframe.style, {
    position: "fixed", right: "0", bottom: "0", width: "0", height: "0",
    border: "0", visibility: "hidden",
  } as CSSStyleDeclaration);
  document.body.appendChild(iframe);

  const cw = iframe.contentWindow;
  const cd = iframe.contentDocument;
  if (!cw || !cd) {
    iframe.remove();
    throw new Error("Could not open a print document.");
  }
  cd.open();
  cd.write(buildDocument(parts.join("")));
  cd.close();

  // Two rAFs = post-paint, so the preview never opens on an unlaid-out document.
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

  let torn = false;
  const teardown = () => {
    if (torn) return;
    torn = true;
    setTimeout(() => iframe.remove(), 300);
  };
  cw.addEventListener("afterprint", teardown);
  setTimeout(teardown, 120000);

  cw.focus();
  cw.print();
}
