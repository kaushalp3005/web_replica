"use client";

// Box sections for one PO line. Ports po-receiving.js:
//   • existing sections (DB): editable lot/mfg/exp + per-box gross/net/lot/count,
//     a per-section Update (PUT /boxes) and an Add-Boxes panel (POST /boxes)   [renderLines 188-245, 876-1126]
//   • new sections (draft): Add Section → fields → Generate Boxes → paginated
//     box table (100/page) → Remove                                            [305-517]
// Net auto-calc (net = gross − carton) is handled in the reducer. Per-box and
// bulk print buttons route to a pluggable `onPrint(boxes)` handler.

import { useState } from "react";
import type { PurchaseLine, PurchaseSection } from "@/lib/purchase-receive";
import {
  BOXES_PER_PAGE,
  existingKey,
  type DraftState,
  type DraftBox,
  type ExistingSectionEdit,
  type InwardAction,
  type NewSection,
  type PrintBox,
} from "./_boxEngine";

type BoxField = "gross_weight" | "net_weight" | "lot_number" | "count";
type BoxRow = { idKey: string | number; box_number: number; gross_weight: string; net_weight: string; lot_number: string; count: string };

// ── Print helpers ─────────────────────────────────────────────────────────────
function PrinterIcon({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 6 2 18 2 18 9" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="8" />
    </svg>
  );
}

function PrintAllButton({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={count === 0}
      title="Print all boxes"
      className="h-7 px-2 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[#2c5fa8] hover:text-[#2c5fa8] inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <PrinterIcon /> Print all ({count})
    </button>
  );
}

function toPrintBox(row: BoxRow, line: PurchaseLine, sectionNumber: number | null): PrintBox {
  return {
    box_id: typeof row.idKey === "string" ? row.idKey : null,
    box_number: row.box_number,
    net_weight: row.net_weight,
    gross_weight: row.gross_weight,
    lot_number: row.lot_number,
    count: row.count,
    line_number: line.line_number,
    section_number: sectionNumber,
    sku_name: line.sku_name ?? line.particulars ?? "",
  };
}

function draftBoxToPrint(b: DraftBox, line: PurchaseLine): PrintBox {
  return {
    box_id: null,
    box_number: b.box_number,
    net_weight: b.net_weight,
    gross_weight: b.gross_weight,
    lot_number: b.lot_number,
    count: b.count,
    line_number: line.line_number,
    section_number: null,
    sku_name: line.sku_name ?? line.particulars ?? "",
  };
}

export function SectionEditor({
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
  const carton = draft.cartonByLine[line.line_number] ?? "";
  const existingSections = line.sections ?? [];
  const totalExisting = existingSections.reduce((n, s) => n + (s.boxes?.length ?? 0), 0);
  const newForLine = draft.newSections.filter((s) => s.line_number === line.line_number);

  function addSection() {
    const id = `${line.line_number}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    dispatch({ type: "addSection", line: line.line_number, id });
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wide font-bold text-[var(--text-muted)]">
          Box Sections
          {totalExisting ? ` (${totalExisting} existing in ${existingSections.length} section${existingSections.length !== 1 ? "s" : ""})` : ""}
        </span>
        <button
          type="button"
          onClick={addSection}
          className="h-7 px-2 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] inline-flex items-center gap-1"
        >
          + Add Section
        </button>
      </div>

      {existingSections.map((sec) => (
        <ExistingSectionCard
          key={sec.section_number}
          line={line}
          section={sec}
          edit={draft.existing[existingKey(line.line_number, sec.section_number)]}
          addBoxesRows={draft.addBoxes[existingKey(line.line_number, sec.section_number)]?.boxes ?? null}
          carton={carton}
          dispatch={dispatch}
          onUpdate={onUpdateSection}
          onAddBoxes={onAddBoxesToSection}
          busy={busy}
          onPrint={onPrint}
        />
      ))}

      {newForLine.map((sec) => (
        <NewSectionCard key={sec.id} line={line} section={sec} carton={carton} dispatch={dispatch} onPrint={onPrint} />
      ))}

      {existingSections.length === 0 && newForLine.length === 0 ? (
        <p className="text-[12px] text-[var(--text-muted)] italic">No box sections yet — click “Add Section”.</p>
      ) : null}
    </div>
  );
}

// ── Existing section (from DB) ────────────────────────────────────────────────
function ExistingSectionCard({
  line,
  section,
  edit,
  addBoxesRows,
  carton,
  dispatch,
  onUpdate,
  onAddBoxes,
  busy,
  onPrint,
}: {
  line: PurchaseLine;
  section: PurchaseSection;
  edit?: ExistingSectionEdit;
  addBoxesRows: DraftBox[] | null;
  carton: string;
  dispatch: React.Dispatch<InwardAction>;
  onUpdate: (line: PurchaseLine, sectionNumber: number) => void;
  onAddBoxes: (line: PurchaseLine, sectionNumber: number) => void;
  busy: string | null;
  onPrint: (boxes: PrintBox[]) => void;
}) {
  const [boxesOpen, setBoxesOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addCount, setAddCount] = useState("");
  const key = existingKey(line.line_number, section.section_number);
  const boxes = section.boxes ?? [];
  const uKey = `u:${line.line_number}:${section.section_number}`;
  const aKey = `a:${line.line_number}:${section.section_number}`;
  const e: ExistingSectionEdit = edit ?? { lot_number: "", manufacturing_date: "", expiry_date: "", boxes: {} };

  const rows: BoxRow[] = boxes.map((b) => {
    const be = e.boxes[b.box_id] ?? { gross_weight: "", net_weight: "", lot_number: "", count: "" };
    return { idKey: b.box_id, box_number: b.box_number, gross_weight: be.gross_weight, net_weight: be.net_weight, lot_number: be.lot_number, count: be.count };
  });

  const addRows: BoxRow[] = (addBoxesRows ?? []).map((b, i) => ({
    idKey: i, box_number: b.box_number, gross_weight: b.gross_weight, net_weight: b.net_weight, lot_number: b.lot_number, count: b.count,
  }));

  return (
    <div className="border border-[var(--aws-border)] rounded-[2px] p-2.5 bg-[var(--surface-subtle)]">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-[12px] font-semibold text-[var(--text-primary)]">Section {section.section_number}</span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setAddOpen((v) => !v)}
            className="h-7 px-2 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]"
          >
            + Add Boxes
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => onUpdate(line, section.section_number)}
            className="h-7 px-2 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy === uKey ? "Updating…" : "Update"}
          </button>
          <PrintAllButton count={rows.length} onClick={() => onPrint(rows.map((r) => toPrintBox(r, line, section.section_number)))} />
          <span className="text-[11px] text-[var(--text-muted)]">{boxes.length} box{boxes.length !== 1 ? "es" : ""}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-2">
        <SecField label="LOT Number" value={e.lot_number} mono onChange={(v) => dispatch({ type: "setExistingSectionField", key, field: "lot_number", value: v })} />
        <SecField label="MFG Date" type="date" value={e.manufacturing_date} onChange={(v) => dispatch({ type: "setExistingSectionField", key, field: "manufacturing_date", value: v })} />
        <SecField label="EXP Date" type="date" value={e.expiry_date} onChange={(v) => dispatch({ type: "setExistingSectionField", key, field: "expiry_date", value: v })} />
      </div>

      {boxes.length ? (
        <div>
          <button
            type="button"
            onClick={() => setBoxesOpen((v) => !v)}
            aria-expanded={boxesOpen}
            className="text-[12px] text-[var(--aws-link)] hover:underline inline-flex items-center gap-1 mb-1"
          >
            <span className={["text-[10px] transition-transform inline-block", boxesOpen ? "rotate-90" : ""].join(" ")} aria-hidden>▸</span>
            Box #{boxes[0].box_number}{boxes.length > 1 ? ` – #${boxes[boxes.length - 1].box_number}` : ""}
          </button>
          {boxesOpen ? (
            <BoxTable
              rows={rows}
              onField={(idKey, field, value) => dispatch({ type: "setExistingBoxField", key, boxId: String(idKey), field, value, carton })}
              onPrintRow={(r) => onPrint([toPrintBox(r, line, section.section_number)])}
            />
          ) : null}
        </div>
      ) : null}

      {addOpen ? (
        <div className="mt-2 border-t border-[var(--aws-border)] pt-2">
          <div className="flex items-end gap-2 mb-2">
            <label className="text-[11px] font-semibold text-[var(--text-primary)]">
              Count
              <input
                type="number"
                min="1"
                step="1"
                value={addCount}
                onChange={(ev) => setAddCount(ev.target.value)}
                placeholder="e.g. 50"
                className="block w-24 h-7 px-1.5 mt-0.5 text-[12px] font-mono rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e]"
              />
            </label>
            <button
              type="button"
              onClick={() => dispatch({ type: "genAddBoxes", key, line, sectionNumber: section.section_number, count: parseInt(addCount, 10) || 0 })}
              className="h-7 px-2 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]"
            >
              Generate
            </button>
            <button
              type="button"
              disabled={busy !== null || addRows.length === 0}
              onClick={() => onAddBoxes(line, section.section_number)}
              className="h-7 px-2 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy === aKey ? "Saving…" : "Save New Boxes"}
            </button>
          </div>
          {addRows.length ? (
            <BoxTable
              rows={addRows}
              onField={(idKey, field, value) => dispatch({ type: "setAddBoxField", key, boxIndex: Number(idKey), field, value, carton })}
              onPrintRow={(r) => onPrint([toPrintBox(r, line, section.section_number)])}
            />
          ) : (
            <p className="text-[11px] text-[var(--text-muted)] italic">Enter a count and click Generate.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ── New section (draft only, persisted on Save / generate) ────────────────────
function NewSectionCard({
  line,
  section,
  carton,
  dispatch,
  onPrint,
}: {
  line: PurchaseLine;
  section: NewSection;
  carton: string;
  dispatch: React.Dispatch<InwardAction>;
  onPrint: (boxes: PrintBox[]) => void;
}) {
  const generated = section.boxes;
  const total = generated?.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / BOXES_PER_PAGE));
  const page = Math.min(Math.max(1, section.page), totalPages);
  const start = (page - 1) * BOXES_PER_PAGE;
  const end = Math.min(start + BOXES_PER_PAGE, total);

  const rows: BoxRow[] = (generated ?? []).slice(start, end).map((b, j) => ({
    idKey: start + j,
    box_number: b.box_number,
    gross_weight: b.gross_weight,
    net_weight: b.net_weight,
    lot_number: b.lot_number,
    count: b.count,
  }));

  return (
    <div className="border border-dashed border-[var(--aws-border-strong)] rounded-[2px] p-2.5">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-[12px] font-semibold text-[var(--text-primary)]">New Section</span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={!!generated}
            onClick={() => dispatch({ type: "generateBoxes", id: section.id, line })}
            className="h-7 px-2 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {generated ? "Generated" : "Generate Boxes"}
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: "removeSection", id: section.id })}
            title="Remove section"
            aria-label="Remove section"
            className="h-7 w-7 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-error)] hover:text-[var(--aws-error)]"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
        <SecField label="Number of Boxes" type="number" mono value={section.box_count} placeholder="e.g. 100" onChange={(v) => dispatch({ type: "setNewSectionField", id: section.id, field: "box_count", value: v })} />
        <SecField label="LOT Number" mono value={section.lot_number} placeholder="LOT-…" onChange={(v) => dispatch({ type: "setNewSectionField", id: section.id, field: "lot_number", value: v })} />
        <SecField label="MFG Date" type="date" value={section.mfg_date} onChange={(v) => dispatch({ type: "setNewSectionField", id: section.id, field: "mfg_date", value: v })} />
        <SecField label="EXP Date" type="date" value={section.exp_date} onChange={(v) => dispatch({ type: "setNewSectionField", id: section.id, field: "exp_date", value: v })} />
      </div>

      {generated ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wide text-[var(--text-muted)]">Generated Boxes ({total})</span>
            <PrintAllButton count={total} onClick={() => onPrint((generated ?? []).map((b) => draftBoxToPrint(b, line)))} />
          </div>
          <BoxTable
            rows={rows}
            onField={(idKey, field, value) => dispatch({ type: "setNewBoxField", id: section.id, boxIndex: Number(idKey), field, value, carton })}
            onPrintRow={(r) => onPrint([toPrintBox(r, line, null)])}
          />
          {totalPages > 1 ? (
            <div className="flex items-center gap-2 text-[12px]">
              <button type="button" disabled={page <= 1} onClick={() => dispatch({ type: "setNewSectionPage", id: section.id, page: page - 1 })}
                className="h-7 px-2 rounded-[2px] border border-[var(--aws-border-strong)] bg-white disabled:opacity-50 disabled:cursor-not-allowed">‹</button>
              <span className="text-[var(--text-secondary)]">Page {page} of {totalPages}</span>
              <span className="text-[var(--text-muted)]">(Box {start + 1}–{end} of {total})</span>
              <button type="button" disabled={page >= totalPages} onClick={() => dispatch({ type: "setNewSectionPage", id: section.id, page: page + 1 })}
                className="h-7 px-2 rounded-[2px] border border-[var(--aws-border-strong)] bg-white disabled:opacity-50 disabled:cursor-not-allowed">›</button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ── Small labelled field ──────────────────────────────────────────────────────
function SecField({
  label,
  value,
  onChange,
  type = "text",
  mono,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  mono?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-0.5 text-[11px] font-semibold text-[var(--text-primary)]">
      {label}
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={[
          "h-7 px-1.5 text-[12px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]",
          mono ? "font-mono" : "",
        ].join(" ")}
      />
    </label>
  );
}

// ── Shared editable box table ─────────────────────────────────────────────────
function BoxTable({ rows, onField, onPrintRow }: { rows: BoxRow[]; onField: (idKey: string | number, field: BoxField, value: string) => void; onPrintRow?: (row: BoxRow) => void }) {
  const inputCls = "w-full h-6 px-1 text-[12px] font-mono rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e]";
  const th = "px-2 py-1 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] whitespace-nowrap";
  return (
    <div className="overflow-x-auto rounded-[2px] border border-[var(--aws-border)] bg-white">
      <table className="w-full text-[12px] border-collapse">
        <thead className="bg-[var(--surface-subtle)]">
          <tr className="border-b border-[var(--aws-border)]">
            {onPrintRow ? <th className={[th, "w-8"].join(" ")} aria-label="Print" /> : null}
            <th className={th}>Box #</th>
            <th className={th}>Gross Wt (kg)</th>
            <th className={th}>Net Wt (kg)</th>
            <th className={th}>LOT</th>
            <th className={th}>Count</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.idKey} className="border-b border-[var(--aws-border)] last:border-b-0">
              {onPrintRow ? (
                <td className="px-1.5 py-1">
                  <button
                    type="button"
                    title="Print this box"
                    aria-label="Print box"
                    onClick={() => onPrintRow(r)}
                    className="p-1 rounded hover:bg-[#eaf0fb] text-[var(--text-secondary)] hover:text-[#2c5fa8]"
                  >
                    <PrinterIcon size={11} />
                  </button>
                </td>
              ) : null}
              <td className="px-2 py-1 font-mono text-[var(--text-muted)] whitespace-nowrap">{r.box_number}</td>
              <td className="px-2 py-1 w-28"><input type="number" step="0.001" value={r.gross_weight} placeholder="0.000" onChange={(e) => onField(r.idKey, "gross_weight", e.target.value)} className={inputCls} /></td>
              <td className="px-2 py-1 w-28"><input type="number" step="0.001" value={r.net_weight} placeholder="0.000" onChange={(e) => onField(r.idKey, "net_weight", e.target.value)} className={inputCls} /></td>
              <td className="px-2 py-1 w-32"><input type="text" value={r.lot_number} onChange={(e) => onField(r.idKey, "lot_number", e.target.value)} className={inputCls} /></td>
              <td className="px-2 py-1 w-20"><input type="number" step="1" value={r.count} placeholder="0" onChange={(e) => onField(r.idKey, "count", e.target.value)} className={inputCls} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
