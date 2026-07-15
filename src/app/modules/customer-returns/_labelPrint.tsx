"use client";

// Customer-Returns box label printing. Mirrors the purchase material-in label
// subsystem (src/app/modules/purchase/material-in/[transaction_no]/_labelPrint.tsx):
// assemble labels as an HTML string off the live React tree, write them into a
// hidden <iframe>, and open the browser/Windows print preview via window.print().
//
// The QR encodes the BARE box_id so a scan feeds straight into the RM/production
// box lookup (GET /api/v1/production/boxes/{box_id}) — same convention as the
// purchase labels. See [[candor-qr-and-rm-box-lookup]].

import { renderToStaticMarkup } from "react-dom/server";
import { QRCodeSVG } from "qrcode.react";

export interface CrLabelBox {
  box_id?: string | null;
  box_number: number;
  article_description: string;
  net_weight?: string | null;
  gross_weight?: string | null;
  count?: number | string | null;
  lot_number?: string | null;
  item_mark?: string | null;
}

export interface CrLabelJob {
  company: string;
  crId: string;
  customer?: string | null;
  rtvDate?: string | null;
  boxes: CrLabelBox[];
  onProgress?: (done: number, total: number) => void;
}

const LABEL_W_MM = 101.6;
const LABEL_H_MM = 50.8;

function escapeHtml(s: string | number): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

function wt(v: string | null | undefined): string {
  const s = (v ?? "").toString().trim();
  return s === "" ? "—" : `${s}kg`;
}

function fmtDate(v: string | null | undefined): string {
  if (!v) {
    const d = new Date();
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getFullYear()).slice(-2)}`;
  }
  const d = new Date(v);
  if (isNaN(d.getTime())) return "";
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getFullYear()).slice(-2)}`;
}

function renderLabel(job: CrLabelJob, box: CrLabelBox): string {
  const boxId = box.box_id ?? "";
  const qrSvg = boxId
    ? renderToStaticMarkup(
        <QRCodeSVG value={boxId} size={220} level="M" marginSize={2} bgColor="#ffffff" fgColor="#000000" />,
      )
    : `<div class="noqr">No code<br/>Print first</div>`;
  const idText = boxId ? escapeHtml(boxId) : "(unprinted)";
  const lot = escapeHtml([box.lot_number, box.item_mark].filter(Boolean).join(" · ") || "—");
  const countLine = box.count != null && String(box.count).trim() !== "" ? `Count: ${escapeHtml(box.count)}` : "";
  return (
    `<div class="label">` +
    `<div class="qr">${qrSvg}</div>` +
    `<div class="txt">` +
    `<div class="entity">${escapeHtml((job.company || "").toUpperCase())}</div>` +
    `<div class="tx">CR: ${escapeHtml(job.crId)}</div>` +
    `<div class="bid">ID: ${idText}</div>` +
    `<div class="rule"></div>` +
    `<div class="sku">${escapeHtml(box.article_description)}</div>` +
    `<div class="rule"></div>` +
    `<div class="metrics">Box #${escapeHtml(box.box_number)} · Net: ${escapeHtml(wt(box.net_weight))} | Gross: ${escapeHtml(wt(box.gross_weight))}</div>` +
    (countLine ? `<div class="metrics">${countLine}</div>` : "") +
    `<div class="lot">Lot: ${lot}</div>` +
    `<div class="date">Date: ${escapeHtml(fmtDate(job.rtvDate))}</div>` +
    `</div>` +
    `</div>`
  );
}

function buildDocument(labelsHtml: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>CR box labels</title><style>` +
    `@page{size:${LABEL_W_MM}mm ${LABEL_H_MM}mm;margin:0}` +
    `*{margin:0;padding:0;box-sizing:border-box}` +
    `html,body{margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;` +
    `font-family:'Segoe UI',system-ui,-apple-system,Arial,sans-serif;color:#000;background:#fff}` +
    `.label{width:${LABEL_W_MM}mm;height:${LABEL_H_MM}mm;box-sizing:border-box;overflow:hidden;border:1px solid #000;` +
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
    `.lot{font-size:7.5pt;margin-top:.4mm}` +
    `.date{font-size:7.5pt;margin-top:.2mm}` +
    `</style></head><body>${labelsHtml}</body></html>`
  );
}

const yieldToMain = (): Promise<void> =>
  new Promise((resolve) => {
    const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (sched?.yield) sched.yield().then(resolve);
    else requestAnimationFrame(() => resolve());
  });

export async function printCrLabels(job: CrLabelJob): Promise<void> {
  const boxes = job.boxes.filter((b) => b.box_id); // only printed boxes carry a scannable id
  if (boxes.length === 0) return;
  if (typeof window === "undefined") return;

  const CHUNK = 150;
  const parts: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    parts.push(renderLabel(job, boxes[i]));
    if ((i + 1) % CHUNK === 0) {
      job.onProgress?.(i + 1, boxes.length);
      await yieldToMain();
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
