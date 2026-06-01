"use client";

// Browser-print replacement for the Electron raw-TSPL thermal label flow.
// Renders one HTML label per box into a popup window and triggers the
// browser print dialog. No raw-printer / named-printer selection (not
// possible from a browser) — the OS print dialog handles destination.

export interface LabelData {
  transaction_no: string;
  entity: string;
  sku_name: string;
  box_id: string;
  box_number: number;
  net_weight: number | null;
  gross_weight: number | null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function printLabels(labels: LabelData[]): void {
  if (labels.length === 0) return;
  const w = window.open("", "_blank", "width=480,height=640");
  if (!w) return; // popup blocked — caller should surface a message

  const rows = labels
    .map(
      (l) => `
      <div class="lbl">
        <div class="lbl-h">${escapeHtml(l.entity.toUpperCase())} · ${escapeHtml(l.transaction_no)}</div>
        <div class="lbl-sku">${escapeHtml(l.sku_name)}</div>
        <div class="lbl-meta">Box ${l.box_number} · ${escapeHtml(l.box_id)}</div>
        <div class="lbl-w">Net ${l.net_weight ?? "—"} kg · Gross ${l.gross_weight ?? "—"} kg</div>
      </div>`
    )
    .join("");

  w.document.write(`<!doctype html><html><head><title>Labels</title><style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: monospace; }
    .lbl { width: 50mm; padding: 4mm; border: 1px solid #000; margin: 2mm; page-break-inside: avoid; }
    .lbl-h { font-size: 8pt; }
    .lbl-sku { font-weight: bold; font-size: 12pt; margin: 2mm 0; }
    .lbl-meta { font-size: 9pt; }
    .lbl-w { font-size: 9pt; margin-top: 1mm; }
    @media print { .lbl { border: none; } }
  </style></head><body>${rows}</body></html>`);
  w.document.close();
  w.focus();
  w.print();
}
