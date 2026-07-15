"use client";

// SFG/WIP box QR sticker printing — the SAME client-side method as the Material-In
// label print (purchase/material-in/[transaction_no]/_labelPrint.tsx):
//   • the QR is rendered as a vector <svg> via qrcode.react + renderToStaticMarkup
//     (NOT a raster) — so it's crisp at any size and avoids the fpdf 1-bit-PNG
//     shear the backend PDF path hit;
//   • labels are assembled as an HTML string off the live React tree and written
//     once into a hidden <iframe>, then printed via cw.print();
//   • `@page size` + break-after:page lay out one physical label per page, and
//     content-visibility:auto paginates the preview lazily for large batches.
//
// Each sticker is a 2in x 2in page containing ONLY the QR of the box_id — no text.
// The QR encodes the bare box_id string (e.g. "48213307-1"), which is exactly what
// the SFG scan-in (POST …/scan-sfg-boxes) reads.

import { renderToStaticMarkup } from "react-dom/server";
import { QRCodeSVG } from "qrcode.react";

const LABEL_MM = 50.8; // 2 inch, square
const QR_MM = 46;      // QR box within the label (leaves a ~2.4mm physical quiet margin)

const yieldToMain = (): Promise<void> =>
  new Promise((resolve) => {
    const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (sched?.yield) sched.yield().then(resolve);
    else requestAnimationFrame(() => resolve());
  });

function buildDocument(labelsHtml: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>SFG box labels</title><style>` +
    `@page{size:${LABEL_MM}mm ${LABEL_MM}mm;margin:0}` +
    `*{margin:0;padding:0;box-sizing:border-box}` +
    `html,body{margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;background:#fff}` +
    `.label{width:${LABEL_MM}mm;height:${LABEL_MM}mm;display:flex;align-items:center;justify-content:center;` +
    `border:1px solid #000;box-sizing:border-box;` +
    `break-after:page;page-break-after:always;break-inside:avoid;page-break-inside:avoid;` +
    `contain:layout style paint;content-visibility:auto;contain-intrinsic-size:${LABEL_MM}mm ${LABEL_MM}mm}` +
    `.label:last-child{break-after:auto;page-break-after:auto}` +
    `.qr{width:${QR_MM}mm;height:${QR_MM}mm}.qr svg{width:100%;height:100%;display:block}` +
    `</style></head><body>${labelsHtml}</body></html>`
  );
}

// Assemble the 2in QR-only sticker sheet off the live tree and open the print
// preview. Resolves once print() has been invoked; the hidden iframe self-removes
// after the print dialog closes (afterprint) or a safety timeout.
export async function printSfgBoxLabels(boxIds: Array<string | number>): Promise<void> {
  if (typeof window === "undefined") return;
  const ids = boxIds.map((v) => String(v ?? "").trim()).filter(Boolean);
  if (ids.length === 0) return;

  const CHUNK = 150;
  const parts: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    const qrSvg = renderToStaticMarkup(
      <QRCodeSVG value={ids[i]} size={220} level="M" marginSize={2} bgColor="#ffffff" fgColor="#000000" />,
    );
    parts.push(`<div class="label"><div class="qr">${qrSvg}</div></div>`);
    if ((i + 1) % CHUNK === 0) await yieldToMain(); // keep the app interactive at scale
  }

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
    setTimeout(() => iframe.remove(), 300);
  };
  cw.addEventListener("afterprint", teardown);
  setTimeout(teardown, 120000); // safety net if afterprint never fires

  cw.focus();
  cw.print();
}
