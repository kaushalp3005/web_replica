"use client";

// One PO line as a collapsible card: read-only purchase data (from the Purchase
// team) + the editable Stores carton weight. Box sections (Task 7-9) mount in
// the marked slot. Ports the per-line markup of po-receiving.js renderLines
// (lines 247-302), minus printing.

import { useState } from "react";
import { fmtNum } from "@/lib/po";
import type { PurchaseLine } from "@/lib/purchase-receive";
import { clamp3, type DraftState, type InwardAction, type PrintBox } from "./_boxEngine";
import { SectionEditor } from "./_SectionEditor";

export function LineCard({
  line,
  draft,
  dispatch,
  onUpdateSection,
  onAddBoxesToSection,
  busy,
  onPrint,
}: {
  line: PurchaseLine;
  draft: DraftState;
  dispatch: React.Dispatch<InwardAction>;
  onUpdateSection: (line: PurchaseLine, sectionNumber: number) => void;
  onAddBoxesToSection: (line: PurchaseLine, sectionNumber: number) => void;
  busy: string | null;
  onPrint: (boxes: PrintBox[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const carton = draft.cartonByLine[line.line_number] ?? "";

  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md mb-2 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={`mi-line-content-${line.line_number}`}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-[var(--surface-subtle)]"
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-sm bg-[var(--surface-disabled)] text-[11px] font-mono text-[var(--text-secondary)]">{line.line_number}</span>
          <span className="text-[13px] font-medium text-[var(--text-primary)] truncate">{line.sku_name || "Unnamed"}</span>
        </span>
        <span className="flex items-center gap-2 shrink-0">
          <span className="text-[12px] text-[var(--text-secondary)] whitespace-nowrap">{fmtNum(line.pack_count)} pcs</span>
          <span className={["text-[10px] text-[var(--text-muted)] transition-transform inline-block", open ? "rotate-90" : ""].join(" ")} aria-hidden>▸</span>
        </span>
      </button>

      {open ? (
        <div id={`mi-line-content-${line.line_number}`} className="border-t border-[var(--aws-border)] p-3 space-y-3">
          <div>
            <div className="text-[11px] uppercase tracking-wide font-bold text-[var(--text-muted)] mb-2">Purchase Data (read-only)</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
              <RoCell label="SKU" value={line.sku_name || "—"} />
              <RoCell label="Matched" value={line.particulars || "—"} />
              <RoCell label="Category" value={line.item_category || "—"} />
              <RoCell label="Type" value={line.item_type || "—"} />
              <RoCell label="UOM" value={line.uom || "—"} mono />
              <RoCell label="Pack Count" value={fmtNum(line.pack_count)} mono />
              <RoCell label="PO Weight" value={line.po_weight != null ? `${line.po_weight.toFixed(3)} kg` : "—"} mono />
            </div>
          </div>

          <div>
            <div className="text-[11px] uppercase tracking-wide font-bold text-[var(--text-muted)] mb-2">Stores Data (editable)</div>
            <div className="max-w-[260px]">
              <label htmlFor={`mi-carton-${line.line_number}`} className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">Empty Carton + Laminate (kg)</label>
              <input
                id={`mi-carton-${line.line_number}`}
                type="number"
                step="0.001"
                value={carton}
                placeholder="0.000"
                onChange={(e) => dispatch({ type: "setCarton", line: line.line_number, value: clamp3(e.target.value) })}
                className="w-full h-8 px-2 text-[13px] font-mono rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
              />
            </div>
          </div>

          <SectionEditor
            line={line}
            draft={draft}
            dispatch={dispatch}
            onUpdateSection={onUpdateSection}
            onAddBoxesToSection={onAddBoxesToSection}
            busy={busy}
            onPrint={onPrint}
          />
        </div>
      ) : null}
    </div>
  );
}

function RoCell({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)]">{label}</span>
      <span className={["text-[12px] text-[var(--text-primary)] truncate", mono ? "font-mono" : ""].join(" ")} title={value}>{value}</span>
    </div>
  );
}
