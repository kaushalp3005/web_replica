"use client";

// SFG/WIP box label printing — a 101.6mm x 50.8mm (4in x 2in) LANDSCAPE sticker:
//   • LEFT half  = the scannable QR of the bare box_id (the exact value the SFG
//     scan-in POST …/scan-sfg-boxes reads), rendered as a crisp vector <svg>
//     via qrcode.react + renderToStaticMarkup (not a raster).
//   • RIGHT half = human-readable box details — Batch, Article, SFG, Net wt,
//     Gross wt, Count. Batch + Article are BOLD and large; a long Article name
//     wraps onto extra lines automatically (overflow-wrap:break-word).
//
// Same print machinery as the Material-In label print: assemble an HTML string
// off the live React tree, write once into a hidden <iframe>, print via cw.print().
// `@page size` + break-after:page lay out one physical label per page.

import { renderToStaticMarkup } from "react-dom/server";
import { QRCodeSVG } from "qrcode.react";

const LABEL_W_MM = 101.6; // 4 inch — landscape width
const LABEL_H_MM = 50.8;  // 2 inch — height
const QR_MM = 46;         // QR box inside the left 50.8mm half (~2.4mm quiet margin)

export type SfgBoxLabel = {
  box_id: string;                 // QR payload (bare carton id, e.g. "48213307-1")
  batch?: string | null;          // batch name / number (bold, big)
  article?: string | null;        // article / FG name (bold, big, wraps)
  sfg?: string | null;            // SFG code / name
  net?: number | string | null;   // net weight (kg)
  gross?: number | string | null; // gross weight (kg)
  count?: number | string | null; // units in the box
};

const yieldToMain = (): Promise<void> =>
  new Promise((resolve) => {
    const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (sched?.yield) sched.yield().then(resolve);
    else requestAnimationFrame(() => resolve());
  });

// HTML-escape text that goes into the label markup (article/batch/sfg are
// free-typed and may contain &, <, >, ").
function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
// Format a weight/count: up to 3 dp, trailing zeros trimmed; em-dash when absent.
function num(v: number | string | null | undefined, unit = ""): string {
  if (v == null || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${Number(n.toFixed(3))}${unit}`;
}

function buildDocument(labelsHtml: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>SFG box labels</title><style>` +
    `@page{size:${LABEL_W_MM}mm ${LABEL_H_MM}mm;margin:0}` +
    `*{margin:0;padding:0;box-sizing:border-box}` +
    `html,body{margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;` +
    `background:#fff;color:#000;font-family:Arial,Helvetica,sans-serif}` +
    `.label{width:${LABEL_W_MM}mm;height:${LABEL_H_MM}mm;display:flex;align-items:stretch;` +
    `border:1px solid #000;box-sizing:border-box;` +
    `break-after:page;page-break-after:always;break-inside:avoid;page-break-inside:avoid;` +
    `contain:layout style paint;content-visibility:auto;contain-intrinsic-size:${LABEL_W_MM}mm ${LABEL_H_MM}mm}` +
    `.label:last-child{break-after:auto;page-break-after:auto}` +
    // Left half — QR, exactly the 50.8mm square (matches the old sticker size).
    `.qrhalf{flex:0 0 ${LABEL_H_MM}mm;height:${LABEL_H_MM}mm;display:flex;align-items:center;` +
    `justify-content:center;border-right:1px solid #000}` +
    `.qr{width:${QR_MM}mm;height:${QR_MM}mm}.qr svg{width:100%;height:100%;display:block}` +
    // Right half — details, vertically centred.
    `.txt{flex:1;min-width:0;padding:1.2mm 2mm;display:flex;flex-direction:column;` +
    `justify-content:space-evenly;overflow:hidden}` +
    `.head{display:flex;flex-direction:column;gap:0.4mm}` +      // Batch + Article, kept tight together
    `.batch{font-weight:700;font-size:4.8mm;line-height:1.04;word-break:break-word}` +
    `.article,.sfg{font-weight:700;font-size:4mm;line-height:1.08;overflow-wrap:break-word;word-break:break-word}` +
    `.meta{font-size:3.4mm;line-height:1.1;word-break:break-word}` +
    `</style></head><body>${labelsHtml}</body></html>`
  );
}

// Assemble the 4in x 2in sticker sheet off the live tree and open the print
// preview. Resolves once print() has been invoked; the hidden iframe self-removes
// after the print dialog closes (afterprint) or a safety timeout.
export async function printSfgBoxLabels(boxes: SfgBoxLabel[]): Promise<void> {
  if (typeof window === "undefined") return;
  const list = (boxes ?? []).filter((b) => b && String(b.box_id ?? "").trim());
  if (list.length === 0) return;

  const CHUNK = 120;
  const parts: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    const qrSvg = renderToStaticMarkup(
      <QRCodeSVG value={String(b.box_id).trim()} size={220} level="M" marginSize={2} bgColor="#ffffff" fgColor="#000000" />,
    );
    parts.push(
      `<div class="label">` +
        `<div class="qrhalf"><div class="qr">${qrSvg}</div></div>` +
        `<div class="txt">` +
          `<div class="head">` +
            (b.batch ? `<div class="batch">${esc(b.batch)}</div>` : "") +
            (b.article ? `<div class="article">${esc(b.article)}</div>` : "") +
          `</div>` +
          (b.sfg ? `<div class="sfg">SFG: ${esc(b.sfg)}</div>` : "") +
          `<div class="meta">Net: ${num(b.net, " kg")}</div>` +
          `<div class="meta">Gross: ${num(b.gross, " kg")}</div>` +
          `<div class="meta">Count: ${num(b.count)}</div>` +
        `</div>` +
      `</div>`,
    );
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
