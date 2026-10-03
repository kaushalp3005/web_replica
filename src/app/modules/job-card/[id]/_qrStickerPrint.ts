"use client";

// Job card box stickers — a 25.4mm x 25.4mm (1in x 1in) SQUARE sticker carrying
// the box's QR code and nothing else: no text, no border. Every sticker printed
// from a job card comes through here:
//   • Manual print / 🖨 reprint (RM boxes, _RmManualPrint): QR {"tx": job card no,
//     "bi": box id} — the same value Material-In's sticker encodes;
//   • Boxes by batch (SFG/WIP boxes, _SfgProducedBoxes): QR of the bare box_id,
//     the value the SFG scan-in reads.
// The caller passes the exact QR values; this only lays them out and prints.
//
// Same print machinery as the Material-In label print: assemble an HTML string
// off the live React tree, write once into a hidden <iframe>, print via cw.print().
// `@page size` + break-after:page lay out one physical sticker per page. The
// printer's label stock must be set to 25.4 x 25.4 mm, printed at 100% scale.

import QRCode, { type QRCodeToStringOptions } from "qrcode";

const STICKER_MM = 25.4; // 1 inch square
const QR_MM = 23.4;      // ~1mm of blank label round the QR's own 2-module quiet zone

// Vector SVG, error-correction M, quiet zone 2 — as Material-In's sticker.
const QR_OPTS: QRCodeToStringOptions = { type: "svg", errorCorrectionLevel: "M", margin: 2, width: 220 };

const yieldToMain = (): Promise<void> =>
  new Promise((resolve) => {
    const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (sched?.yield) sched.yield().then(resolve);
    else requestAnimationFrame(() => resolve());
  });

function buildDocument(stickersHtml: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>Box stickers</title><style>` +
    `@page{size:${STICKER_MM}mm ${STICKER_MM}mm;margin:0}` +
    `*{margin:0;padding:0;box-sizing:border-box}` +
    `html,body{margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;background:#fff}` +
    `.sticker{width:${STICKER_MM}mm;height:${STICKER_MM}mm;display:flex;align-items:center;justify-content:center;` +
    `overflow:hidden;break-after:page;page-break-after:always;break-inside:avoid;page-break-inside:avoid;` +
    `contain:layout style paint;content-visibility:auto;contain-intrinsic-size:${STICKER_MM}mm ${STICKER_MM}mm}` +
    `.sticker:last-child{break-after:auto;page-break-after:auto}` +
    `.qr{width:${QR_MM}mm;height:${QR_MM}mm}.qr svg{width:100%;height:100%;display:block}` +
    `</style></head><body>${stickersHtml}</body></html>`
  );
}

// One QR-only sticker per value, then the print preview. Blank values are
// skipped. Resolves once print() has been invoked; the hidden iframe
// self-removes after the print dialog closes (afterprint) or a safety timeout.
export async function printQrStickers(values: string[]): Promise<void> {
  if (typeof window === "undefined") return;
  const list = (values ?? []).map((v) => String(v ?? "").trim()).filter(Boolean);
  if (list.length === 0) return;

  const CHUNK = 200;
  const parts: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const qrSvg = await QRCode.toString(list[i], QR_OPTS);
    parts.push(`<div class="sticker"><div class="qr">${qrSvg}</div></div>`);
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
