"use client";

// Box sections for one PO line. Ports po-receiving.js:
//   • existing sections (DB): editable lot/mfg/exp + per-box gross/net/lot/count,
//     a per-section Update (PUT /boxes) and an Add-Boxes panel (POST /boxes).
//     Boxes are loaded LAZILY when a section is expanded (GET /{txn}/boxes,
//     paginated 200) — not shipped in the initial PO detail.
//   • new sections (draft): Add Section → fields → Generate Boxes → paginated
//     box table (100/page) → Remove.
// Net auto-calc (net = gross − carton) is handled in the reducer. Per-box and
// bulk print buttons route to a pluggable `onPrint(boxes)` handler; Print-all /
// Range fetch the boxes from GET /{txn}/boxes/print (all, or a box_number range).

import { useCallback, useEffect, useRef, useState } from "react";
import { useHasPermission, useHasRole } from "@/lib/user";
import {
  listSectionBoxes,
  listSectionBoxesForPrint,
  newClientKey,
  type PurchaseLine,
  type PurchaseSection,
  type PurchaseBox,
} from "@/lib/purchase-receive";
import {
  BOXES_PER_PAGE,
  computeNet,
  existingKey,
  type DraftState,
  type DraftBox,
  type ExistingSectionEdit,
  type InwardAction,
  type NewSection,
  type PrintBox,
  type PrintResolver,
} from "./_boxEngine";
import { printsColdLabels } from "./_warehouses";

const BOX_FETCH_SIZE = 200; // boxes fetched per backend request (lazy chunk)
const BOX_DISPLAY_SIZE = 10; // boxes shown per page in the box table

// The box table, its print controls and SecField are exported for Stores →
// Production Indents' manual sticker print, which reuses this box format.
export type BoxField = "gross_weight" | "net_weight" | "lot_number" | "count";
// idKey: an existing box's box_id, or a draft box's index. boxId: a draft box's
// id once it is saved on its own (print / Update).
export type BoxRow = { idKey: string | number; box_number: number; gross_weight: string; net_weight: string; lot_number: string; count: string; boxId?: string | null };

// The box a row's print / Update / Delete acts on. The page saves, updates or
// deletes just that box (createOneBox / updateOneBox / deleteOneBox).
export type BoxTarget =
  | { kind: "existing"; line: PurchaseLine; sectionNumber: number; boxId: string; row: BoxRow }
  | { kind: "panel"; line: PurchaseLine; sectionNumber: number; key: string; index: number; box: DraftBox }
  | { kind: "new"; line: PurchaseLine; section: NewSection; index: number; box: DraftBox };
export interface BoxActions {
  print: (t: BoxTarget) => void; // save (create or update) that box, then print its label
  save: (t: BoxTarget) => void; // the row menu's Update / Save box
  remove: (t: BoxTarget) => Promise<boolean>; // the row menu's Delete; true once the box is gone
}

function rowSaved(r: BoxRow): boolean {
  return typeof r.idKey === "string" || !!r.boxId;
}

// The box table's editable columns, defined once: the same list drives the table
// cells (md and up) and the labelled card fields (below md), so a box can never
// lose a field on a phone.
const BOX_FIELDS: { field: BoxField; label: string; type: string; step?: string; placeholder?: string; width: string }[] = [
  { field: "gross_weight", label: "Gross Wt (kg)", type: "number", step: "0.001", placeholder: "0.000", width: "w-28" },
  { field: "net_weight", label: "Net Wt (kg)", type: "number", step: "0.001", placeholder: "0.000", width: "w-28" },
  { field: "lot_number", label: "LOT", type: "text", width: "w-32" },
  { field: "count", label: "Count", type: "number", step: "1", placeholder: "0", width: "w-20" },
];

// ── Print helpers ─────────────────────────────────────────────────────────────
export function PrinterIcon({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 6 2 18 2 18 9" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="8" />
    </svg>
  );
}

// Print-all: hands the resolver to the parent, which saves first, then resolves
// (fetching the just-saved boxes) and prints.
export function PrintAllButton({ count, resolve, onPrint }: { count: number; resolve: PrintResolver; onPrint: (resolve: PrintResolver) => void }) {
  return (
    <button
      type="button"
      onClick={() => count > 0 && onPrint(resolve)}
      disabled={count === 0}
      title="Save & print all boxes"
      className="h-7 px-2 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[#2c5fa8] hover:text-[#2c5fa8] inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <PrinterIcon /> {`Print all (${count})`}
    </button>
  );
}

// Print a box-number sub-range (From #–To #). Ports the Electron print-range-group.
// `resolve(from, to)` returns the PrintBoxes for the range (fetched for existing
// sections; filtered locally for draft sections).
export function PrintRangeControl({
  minBox,
  maxBox,
  resolve,
  onPrint,
}: {
  minBox: number;
  maxBox: number;
  resolve: (from?: number, to?: number) => Promise<PrintBox[]>;
  onPrint: (resolve: PrintResolver) => void;
}) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function toggle() {
    setOpen((v) => {
      const next = !v;
      if (next) {
        // Default the range to the full span; the user narrows it.
        setFrom(minBox ? String(minBox) : "");
        setTo(maxBox ? String(maxBox) : "");
      }
      return next;
    });
  }

  function doPrint() {
    const f = parseInt(from, 10);
    const t = parseInt(to, 10);
    let lo = Number.isFinite(f) ? f : undefined;
    let hi = Number.isFinite(t) ? t : undefined;
    if (lo != null && hi != null && lo > hi) {
      const tmp = lo;
      lo = hi;
      hi = tmp;
    }
    // Parent saves first, then resolves the range (fetching the just-saved boxes).
    onPrint(() => resolve(lo, hi));
    setOpen(false);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={maxBox === 0}
        onClick={toggle}
        title="Print a box-number range"
        className="h-7 px-2 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[#2c5fa8] hover:text-[#2c5fa8] inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <PrinterIcon /> Range
      </button>
      {open ? (
        // max-w keeps the popover inside the viewport on a phone, whatever the
        // button it hangs off is doing; it is well under w-56 from sm up.
        <div className="absolute right-0 top-full mt-1 z-50 w-56 max-w-[calc(100vw-2rem)] bg-white border border-[var(--aws-border-strong)] rounded-[2px] shadow-lg p-2.5">
          <div className="text-[11px] text-[var(--text-secondary)] mb-1.5">
            Print boxes #{minBox}–#{maxBox}
          </div>
          <div className="flex items-center gap-1.5 mb-2">
            <input
              type="number"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              aria-label="From box number"
              className="w-16 h-7 px-1.5 text-[12px] font-mono rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e]"
            />
            <span className="text-[11px] text-[var(--text-muted)]">to</span>
            <input
              type="number"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              aria-label="To box number"
              className="w-16 h-7 px-1.5 text-[12px] font-mono rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e]"
            />
          </div>
          <button
            type="button"
            onClick={doPrint}
            className="w-full h-7 text-[12px] rounded-[2px] bg-[var(--aws-navy)] text-white hover:bg-[#002244] inline-flex items-center justify-center gap-1"
          >
            <PrinterIcon /> Print range
          </button>
        </div>
      ) : null}
    </div>
  );
}

function draftBoxToPrint(b: DraftBox, line: PurchaseLine): PrintBox {
  return {
    box_id: b.box_id ?? null, // a box saved on its own already has its id for the QR
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

// DB box (from the print/list endpoint, or a box just saved on its own) → PrintBox.
export function purchaseBoxToPrint(b: PurchaseBox, line: PurchaseLine, sectionNumber: number): PrintBox {
  return {
    box_id: b.box_id,
    box_number: b.box_number,
    net_weight: b.net_weight != null ? String(b.net_weight) : "",
    gross_weight: b.gross_weight != null ? String(b.gross_weight) : "",
    lot_number: b.lot_number ?? "",
    count: b.count != null ? String(b.count) : "",
    line_number: line.line_number,
    section_number: sectionNumber,
    sku_name: line.sku_name ?? line.particulars ?? "",
  };
}

export function SectionEditor({
  line,
  draft,
  dispatch,
  transactionNo,
  onUpdateSection,
  onAddBoxesToSection,
  busy,
  onPrint,
  printedIds,
  boxActions,
}: {
  line: PurchaseLine;
  draft: DraftState;
  dispatch: React.Dispatch<InwardAction>;
  transactionNo: string;
  onUpdateSection: (line: PurchaseLine, sectionNumber: number) => void;
  onAddBoxesToSection: (line: PurchaseLine, sectionNumber: number) => void;
  busy: string | null;
  onPrint: (resolve: PrintResolver) => void;
  printedIds: Set<string>;
  boxActions: BoxActions;
}) {
  // Permission gates (UX only — server enforces). Adding boxes/sections →
  // material_in/create; updating existing boxes → material_in/edit.
  const canAddBoxes = useHasPermission("purchase", "material_in", null, "create");
  const canUpdateBoxes = useHasPermission("purchase", "material_in", null, "edit");

  const carton = draft.cartonByLine[line.line_number] ?? "";
  const existingSections = line.sections ?? [];
  const totalExisting = existingSections.reduce((n, s) => n + (s.total_boxes ?? s.box_count ?? s.boxes?.length ?? 0), 0);
  const newForLine = draft.newSections.filter((s) => s.line_number === line.line_number);
  // Print all is gated to the cold stores, under any spelling of the inward's
  // Warehouse ("Savla D-34" counts as Savla D-39).
  const canPrintLabels = printsColdLabels(draft.header.warehouse);
  // Print range: admins and inventory managers only, at any warehouse
  // (useHasRole is true for admins too).
  const canPrintRange = useHasRole("inventory_manager");

  function addSection() {
    const id = `${line.line_number}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    dispatch({ type: "addSection", line: line.line_number, id, clientKey: newClientKey() });
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wide font-bold text-[var(--text-muted)]">
          Box Sections
          {totalExisting ? ` (${totalExisting} existing in ${existingSections.length} section${existingSections.length !== 1 ? "s" : ""})` : ""}
        </span>
        {canAddBoxes ? (
          <button
            type="button"
            onClick={addSection}
            className="h-7 px-2 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] inline-flex items-center gap-1"
          >
            + Add Section
          </button>
        ) : null}
      </div>

      {existingSections.map((sec) => (
        <ExistingSectionCard
          key={sec.section_number}
          line={line}
          section={sec}
          transactionNo={transactionNo}
          edit={draft.existing[existingKey(line.line_number, sec.section_number)]}
          addBoxesRows={draft.addBoxes[existingKey(line.line_number, sec.section_number)]?.boxes ?? null}
          carton={carton}
          dispatch={dispatch}
          onUpdate={onUpdateSection}
          onAddBoxes={onAddBoxesToSection}
          busy={busy}
          onPrint={onPrint}
          canPrint={canPrintLabels}
          canPrintRange={canPrintRange}
          canAddBoxes={canAddBoxes}
          canUpdateBoxes={canUpdateBoxes}
          printedIds={printedIds}
          boxActions={boxActions}
        />
      ))}

      {newForLine.map((sec) => (
        <NewSectionCard key={sec.id} line={line} section={sec} carton={carton} dispatch={dispatch} onPrint={onPrint} canPrint={canPrintLabels} canPrintRange={canPrintRange}
          boxActions={boxActions} canAddBoxes={canAddBoxes} printedIds={printedIds} />
      ))}

      {existingSections.length === 0 && newForLine.length === 0 ? (
        <p className="text-[12px] text-[var(--text-muted)] italic">No box sections yet — click “Add Section”.</p>
      ) : null}
    </div>
  );
}

// ── Existing section (from DB) — boxes lazy-loaded + paginated on expand ──────
function ExistingSectionCard({
  line,
  section,
  transactionNo,
  edit,
  addBoxesRows,
  carton,
  dispatch,
  onUpdate,
  onAddBoxes,
  busy,
  onPrint,
  canPrint,
  canPrintRange,
  canAddBoxes,
  canUpdateBoxes,
  printedIds,
  boxActions,
}: {
  line: PurchaseLine;
  section: PurchaseSection;
  transactionNo: string;
  edit?: ExistingSectionEdit;
  addBoxesRows: DraftBox[] | null;
  carton: string;
  dispatch: React.Dispatch<InwardAction>;
  onUpdate: (line: PurchaseLine, sectionNumber: number) => void;
  onAddBoxes: (line: PurchaseLine, sectionNumber: number) => void;
  busy: string | null;
  onPrint: (resolve: PrintResolver) => void;
  canPrint: boolean;
  canPrintRange: boolean;
  canAddBoxes: boolean;
  canUpdateBoxes: boolean;
  printedIds: Set<string>;
  boxActions: BoxActions;
}) {
  const [boxesOpen, setBoxesOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addCount, setAddCount] = useState("");

  // Lazy box loading. `chunk` is the currently-loaded backend page (≤ FETCH_SIZE);
  // the table shows DISPLAY_SIZE boxes per display page over the whole section.
  const [chunk, setChunk] = useState<PurchaseBox[] | null>(null);
  const [chunkPage, setChunkPage] = useState(1);
  const [boxTotal, setBoxTotal] = useState<number>(section.total_boxes ?? section.box_count ?? 0);
  const [displayPage, setDisplayPage] = useState(1);
  const [loadingBoxes, setLoadingBoxes] = useState(false);
  const [boxErr, setBoxErr] = useState<string | null>(null);

  const key = existingKey(line.line_number, section.section_number);
  // The server's count: starts from the PO and is refreshed whenever the boxes
  // reload (after a box is deleted, say).
  const sectionTotal = boxTotal;
  const uKey = `u:${line.line_number}:${section.section_number}`;
  const aKey = `a:${line.line_number}:${section.section_number}`;
  const e: ExistingSectionEdit = edit ?? { lot_number: "", manufacturing_date: "", expiry_date: "", boxes: {} };

  const loadChunk = useCallback(
    async (cPage: number) => {
      setLoadingBoxes(true);
      setBoxErr(null);
      try {
        const r = await listSectionBoxes(transactionNo, line.line_number, section.section_number, { page: cPage, pageSize: BOX_FETCH_SIZE });
        setChunk(r.boxes);
        setBoxTotal(r.total);
        setChunkPage(r.page);
        // Seed the box-edit state so the fetched boxes are editable + saveable.
        dispatch({ type: "hydrateSectionBoxes", key, boxes: r.boxes });
      } catch (ex) {
        setBoxErr(ex instanceof Error ? ex.message : "Failed to load boxes");
      } finally {
        setLoadingBoxes(false);
      }
    },
    [transactionNo, line.line_number, section.section_number, key, dispatch],
  );

  // Invalidate the box cache whenever the PO is reloaded (after a save/refresh
  // the `section` object identity changes and the reducer edit-state was reset).
  useEffect(() => {
    setChunk(null);
    setChunkPage(1);
    setDisplayPage(1);
    setBoxErr(null);
    setBoxTotal(section.total_boxes ?? section.box_count ?? 0);
  }, [section]);

  // Two-level pagination: the table shows BOX_DISPLAY_SIZE boxes per page, while
  // the backend is fetched BOX_FETCH_SIZE at a time — so paging within a loaded
  // chunk is instant and only sections beyond the fetch size make another request.
  const displayPages = Math.max(1, Math.ceil(boxTotal / BOX_DISPLAY_SIZE));
  const clampedDisplayPage = Math.min(displayPage, displayPages);
  const neededChunk = Math.floor(((clampedDisplayPage - 1) * BOX_DISPLAY_SIZE) / BOX_FETCH_SIZE) + 1;
  const displayStart = (clampedDisplayPage - 1) * BOX_DISPLAY_SIZE;
  const offsetInChunk = displayStart - (chunkPage - 1) * BOX_FETCH_SIZE;
  const pageBoxes = chunk && offsetInChunk >= 0 ? chunk.slice(offsetInChunk, offsetInChunk + BOX_DISPLAY_SIZE) : [];

  // Fetch the needed chunk on open, or when the display page crosses into a
  // not-yet-loaded chunk.
  useEffect(() => {
    if (!boxesOpen || loadingBoxes || boxErr) return;
    if (chunk === null || chunkPage !== neededChunk) void loadChunk(neededChunk);
  }, [boxesOpen, chunk, chunkPage, neededChunk, loadingBoxes, boxErr, loadChunk]);

  const rows: BoxRow[] = pageBoxes.map((b) => {
    const be = e.boxes[b.box_id];
    return {
      idKey: b.box_id,
      box_number: b.box_number,
      gross_weight: be?.gross_weight ?? (b.gross_weight != null ? String(b.gross_weight) : ""),
      net_weight: be?.net_weight ?? (b.net_weight != null ? String(b.net_weight) : ""),
      lot_number: be?.lot_number ?? (b.lot_number ?? ""),
      count: be?.count ?? (b.count != null ? String(b.count) : ""),
    };
  });

  const addRows: BoxRow[] = (addBoxesRows ?? []).map((b, i) => ({
    idKey: i, box_number: b.box_number, gross_weight: b.gross_weight, net_weight: b.net_weight, lot_number: b.lot_number, count: b.count,
    boxId: b.box_id,
  }));

  // One box at a time. An existing box is its box_id; a panel box is its index.
  const existingTarget = (r: BoxRow): BoxTarget =>
    ({ kind: "existing", line, sectionNumber: section.section_number, boxId: String(r.idKey), row: r });
  const panelTarget = (r: BoxRow): BoxTarget | null => {
    const box = addBoxesRows?.[Number(r.idKey)];
    return box ? { kind: "panel", line, sectionNumber: section.section_number, key, index: Number(r.idKey), box } : null;
  };
  async function deleteExisting(r: BoxRow) {
    // Gone on the server: reload this page of boxes so the table and the count follow.
    if (await boxActions.remove(existingTarget(r))) void loadChunk(neededChunk);
  }

  // Fetch boxes for printing (all, or a box_number range) from the print endpoint.
  const resolvePrint = useCallback(
    async (from?: number, to?: number): Promise<PrintBox[]> => {
      const r = await listSectionBoxesForPrint(transactionNo, line.line_number, section.section_number, { fromBox: from, toBox: to });
      return r.boxes.map((b) => purchaseBoxToPrint(b, line, section.section_number));
    },
    [transactionNo, line, section.section_number],
  );

  return (
    <div className="border border-[var(--aws-border)] rounded-[2px] p-2.5 bg-[var(--surface-subtle)]">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-[12px] font-semibold text-[var(--text-primary)]">Section {section.section_number}</span>
        <div className="flex items-center gap-1.5">
          {canAddBoxes ? (
            <button
              type="button"
              onClick={() => setAddOpen((v) => !v)}
              className="h-7 px-2 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]"
            >
              + Add Boxes
            </button>
          ) : null}
          {canUpdateBoxes ? (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => onUpdate(line, section.section_number)}
              className="h-7 px-2 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy === uKey ? "Updating…" : "Update"}
            </button>
          ) : null}
          {canPrint ? (
            <PrintAllButton count={sectionTotal} resolve={() => resolvePrint()} onPrint={onPrint} />
          ) : null}
          {canPrintRange ? (
            <PrintRangeControl minBox={sectionTotal ? 1 : 0} maxBox={sectionTotal} resolve={resolvePrint} onPrint={onPrint} />
          ) : null}
          <span className="text-[11px] text-[var(--text-muted)]">{sectionTotal} box{sectionTotal !== 1 ? "es" : ""}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-2">
        <SecField label="LOT Number" value={e.lot_number} mono onChange={(v) => dispatch({ type: "setExistingSectionField", key, field: "lot_number", value: v })} />
        <SecField label="MFG Date" type="date" value={e.manufacturing_date} onChange={(v) => dispatch({ type: "setExistingSectionField", key, field: "manufacturing_date", value: v })} />
        <SecField label="EXP Date" type="date" value={e.expiry_date} onChange={(v) => dispatch({ type: "setExistingSectionField", key, field: "expiry_date", value: v })} />
      </div>

      {sectionTotal > 0 ? (
        <div>
          <button
            type="button"
            onClick={() => setBoxesOpen((v) => !v)}
            aria-expanded={boxesOpen}
            className="text-[12px] text-[var(--aws-link)] hover:underline inline-flex items-center gap-1 mb-1"
          >
            <span className={["text-[10px] transition-transform inline-block", boxesOpen ? "rotate-90" : ""].join(" ")} aria-hidden>▸</span>
            {sectionTotal} box{sectionTotal !== 1 ? "es" : ""}
          </button>
          {boxesOpen ? (
            boxErr ? (
              <p className="text-[11px] text-[var(--aws-error)]">
                {boxErr}{" "}
                <button type="button" onClick={() => loadChunk(neededChunk)} className="underline">Retry</button>
              </p>
            ) : loadingBoxes && pageBoxes.length === 0 ? (
              <p className="text-[11px] text-[var(--text-muted)] italic">Loading boxes…</p>
            ) : (
              <>
                <BoxTable
                  rows={rows}
                  greenIds={printedIds}
                  onField={(idKey, field, value) => dispatch({ type: "setExistingBoxField", key, boxId: String(idKey), field, value, carton })}
                  onPrintRow={(r) => boxActions.print(existingTarget(r))}
                  onUpdateRow={canUpdateBoxes ? (r) => boxActions.save(existingTarget(r)) : undefined}
                  onDeleteRow={canUpdateBoxes ? (r) => void deleteExisting(r) : undefined}
                />
                {displayPages > 1 ? (
                  <div className="flex flex-wrap items-center gap-2 text-[12px] mt-1">
                    <button
                      type="button"
                      disabled={clampedDisplayPage <= 1 || loadingBoxes}
                      onClick={() => setDisplayPage((p) => Math.max(1, p - 1))}
                      className="h-7 px-2 rounded-[2px] border border-[var(--aws-border-strong)] bg-white disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      ‹
                    </button>
                    <span className="text-[var(--text-secondary)]">Page {clampedDisplayPage} of {displayPages}</span>
                    <span className="hidden sm:inline text-[var(--text-muted)]">
                      (Box {displayStart + 1}–{Math.min(displayStart + BOX_DISPLAY_SIZE, boxTotal)} of {boxTotal})
                    </span>
                    <button
                      type="button"
                      disabled={clampedDisplayPage >= displayPages || loadingBoxes}
                      onClick={() => setDisplayPage((p) => Math.min(displayPages, p + 1))}
                      className="h-7 px-2 rounded-[2px] border border-[var(--aws-border-strong)] bg-white disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      ›
                    </button>
                    {loadingBoxes ? <span className="text-[var(--text-muted)]">loading…</span> : null}
                  </div>
                ) : null}
              </>
            )
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
              onClick={() => dispatch({ type: "genAddBoxes", key, line, sectionNumber: section.section_number, count: parseInt(addCount, 10) || 0, clientKey: newClientKey() })}
              className="h-7 px-2 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]"
            >
              Generate
            </button>
            {canAddBoxes ? (
              <button
                type="button"
                disabled={busy !== null || addRows.length === 0}
                onClick={() => onAddBoxes(line, section.section_number)}
                className="h-7 px-2 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {busy === aKey ? "Saving…" : "Save New Boxes"}
              </button>
            ) : null}
          </div>
          {addRows.length ? (
            <BoxTable
              rows={addRows}
              greenIds={printedIds}
              onField={(idKey, field, value) => dispatch({ type: "setAddBoxField", key, boxIndex: Number(idKey), field, value, carton })}
              onPrintRow={(r) => { const t = panelTarget(r); if (t) boxActions.print(t); }}
              onUpdateRow={canAddBoxes ? (r) => { const t = panelTarget(r); if (t) boxActions.save(t); } : undefined}
              onDeleteRow={(r) => { const t = panelTarget(r); if (t) void boxActions.remove(t); }}
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
  canPrint,
  canPrintRange,
  boxActions,
  canAddBoxes,
  printedIds,
}: {
  line: PurchaseLine;
  section: NewSection;
  carton: string;
  dispatch: React.Dispatch<InwardAction>;
  onPrint: (resolve: PrintResolver) => void;
  canPrint: boolean;
  canPrintRange: boolean;
  boxActions: BoxActions;
  canAddBoxes: boolean;
  printedIds: Set<string>;
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
    boxId: b.box_id,
  }));

  // One box at a time: a draft box is its index in the section.
  const newTarget = (r: BoxRow): BoxTarget | null => {
    const box = generated?.[Number(r.idKey)];
    return box ? { kind: "new", line, section, index: Number(r.idKey), box } : null;
  };

  const genMin = generated && generated.length ? generated[0].box_number : 0;
  const genMax = generated && generated.length ? generated[generated.length - 1].box_number : 0;

  // Draft boxes live client-side — resolve the range locally (no fetch).
  async function resolveGen(from?: number, to?: number): Promise<PrintBox[]> {
    let bs = generated ?? [];
    if (from != null || to != null) {
      bs = bs.filter((b) => (from == null || b.box_number >= from) && (to == null || b.box_number <= to));
    }
    return bs.map((b) => draftBoxToPrint(b, line));
  }

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

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-2">
        <SecField label="Number of Boxes" type="number" mono value={section.box_count} placeholder="e.g. 100" onChange={(v) => dispatch({ type: "setNewSectionField", id: section.id, field: "box_count", value: v })} />
        <SecField label="Gross Weight (kg)" type="number" mono value={section.gross_weight} placeholder="per box, e.g. 25.5" onChange={(v) => dispatch({ type: "setNewSectionField", id: section.id, field: "gross_weight", value: v })} />
        <SecField label="LOT Number" mono value={section.lot_number} placeholder="LOT-…" onChange={(v) => dispatch({ type: "setNewSectionField", id: section.id, field: "lot_number", value: v })} />
        <SecField label="MFG Date" type="date" value={section.mfg_date} onChange={(v) => dispatch({ type: "setNewSectionField", id: section.id, field: "mfg_date", value: v })} />
        <SecField label="EXP Date" type="date" value={section.exp_date} onChange={(v) => dispatch({ type: "setNewSectionField", id: section.id, field: "exp_date", value: v })} />
      </div>
      {section.gross_weight ? (
        <p className="text-[11px] text-[var(--text-secondary)] mb-2">
          {computeNet(section.gross_weight, carton)
            ? <>Each box: gross <span className="font-mono">{section.gross_weight}</span> kg, net{" "}
                <span className="font-mono font-semibold text-[var(--text-primary)]">{computeNet(section.gross_weight, carton)}</span> kg
                {carton ? <> (less <span className="font-mono">{carton}</span> kg Empty Carton + Laminate)</> : <> (no Empty Carton + Laminate entered for this article)</>}
              </>
            : <span className="text-[var(--aws-error)]">Gross must be more than the Empty Carton + Laminate ({carton || 0} kg).</span>}
        </p>
      ) : null}

      {generated ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wide text-[var(--text-muted)]">Generated Boxes ({total})</span>
            {canPrint || canPrintRange ? (
              <div className="flex items-center gap-1.5">
                {canPrint ? <PrintAllButton count={total} resolve={() => resolveGen()} onPrint={onPrint} /> : null}
                {canPrintRange ? <PrintRangeControl minBox={genMin} maxBox={genMax} resolve={resolveGen} onPrint={onPrint} /> : null}
              </div>
            ) : null}
          </div>
          <BoxTable
            rows={rows}
            greenIds={printedIds}
            onField={(idKey, field, value) => dispatch({ type: "setNewBoxField", id: section.id, boxIndex: Number(idKey), field, value, carton })}
            onPrintRow={(r) => { const t = newTarget(r); if (t) boxActions.print(t); }}
            onUpdateRow={canAddBoxes ? (r) => { const t = newTarget(r); if (t) boxActions.save(t); } : undefined}
            onDeleteRow={(r) => { const t = newTarget(r); if (t) void boxActions.remove(t); }}
          />
          {totalPages > 1 ? (
            <div className="flex flex-wrap items-center gap-2 text-[12px]">
              <button type="button" disabled={page <= 1} onClick={() => dispatch({ type: "setNewSectionPage", id: section.id, page: page - 1 })}
                className="h-7 px-2 rounded-[2px] border border-[var(--aws-border-strong)] bg-white disabled:opacity-50 disabled:cursor-not-allowed">‹</button>
              <span className="text-[var(--text-secondary)]">Page {page} of {totalPages}</span>
              <span className="hidden sm:inline text-[var(--text-muted)]">(Box {start + 1}–{end} of {total})</span>
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
export function SecField({
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
        // Always controlled: a draft held over a hot reload can lack a newer field.
        value={value ?? ""}
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
// Two layouts over ONE set of rows: the table from md up, and a card per box
// below it, so a phone never drags the columns sideways. Each row's state and its
// controls are built once below and rendered by both, so the two always carry
// the same values, handlers and tooltips. Per row: a ⋮ menu beside the box number
// (Update / Delete that one box) and, after Count, the print button.
export function BoxTable({
  rows, onField, onPrintRow, greenIds, onUpdateRow, onDeleteRow,
}: {
  rows: BoxRow[];
  onField: (idKey: string | number, field: BoxField, value: string) => void;
  onPrintRow?: (row: BoxRow) => void;
  greenIds?: Set<string>;
  onUpdateRow?: (row: BoxRow) => void;
  onDeleteRow?: (row: BoxRow) => void;
}) {
  const inputCls = "w-full h-6 px-1 text-[12px] font-mono rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e]";
  const th = "px-2 py-1 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] whitespace-nowrap";
  // A card's field label reads as its table column header does.
  const cardLabel = "flex flex-col gap-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)]";
  const hasMenu = !!(onUpdateRow || onDeleteRow);

  const views = rows.map((r) => ({
    row: r,
    green: (greenIds?.has(String(r.idKey)) ?? false) || (!!r.boxId && (greenIds?.has(r.boxId) ?? false)),
    fields: BOX_FIELDS.map((f) => ({
      field: f.field,
      label: f.label,
      width: f.width,
      input: (
        <input
          type={f.type}
          step={f.step}
          value={r[f.field]}
          placeholder={f.placeholder}
          onChange={(e) => onField(r.idKey, f.field, e.target.value)}
          className={inputCls}
        />
      ),
    })),
    menu: hasMenu ? <RowMenu row={r} onUpdate={onUpdateRow} onDelete={onDeleteRow} /> : null,
    printButton: onPrintRow ? (
      <button
        type="button"
        title="Save this box and print its label"
        aria-label={`Print box ${r.box_number}`}
        onClick={() => onPrintRow(r)}
        className="p-1 rounded hover:bg-[#eaf0fb] text-[var(--text-secondary)] hover:text-[#2c5fa8]"
      >
        <PrinterIcon size={11} />
      </button>
    ) : null,
  }));

  return (
    <div>
      <div className="hidden md:block overflow-x-auto rounded-[2px] border border-[var(--aws-border)] bg-white">
        <table className="w-full text-[12px] border-collapse">
          <thead className="bg-[var(--surface-subtle)]">
            <tr className="border-b border-[var(--aws-border)]">
              <th className={th}>Box #</th>
              {BOX_FIELDS.map((f) => <th key={f.field} className={th}>{f.label}</th>)}
              {onPrintRow ? <th className={[th, "w-8"].join(" ")} aria-label="Print" /> : null}
            </tr>
          </thead>
          <tbody>
            {views.map((v) => (
              <tr
                key={v.row.idKey}
                title={v.green ? "Saved & printed" : undefined}
                className={["border-b border-[var(--aws-border)] last:border-b-0", v.green ? "bg-[#eaf6ed]" : ""].join(" ")}
              >
                <td className="px-2 py-1 font-mono text-[var(--text-muted)] whitespace-nowrap">
                  <span className="inline-flex items-center gap-1">{v.row.box_number}{v.menu}</span>
                </td>
                {v.fields.map((f) => <td key={f.field} className={`px-2 py-1 ${f.width}`}>{f.input}</td>)}
                {v.printButton ? <td className="px-1.5 py-1">{v.printButton}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Below md: one card per box, same controls as the row above. */}
      <ul className="md:hidden space-y-2">
        {views.map((v) => (
          <li
            key={v.row.idKey}
            title={v.green ? "Saved & printed" : undefined}
            className={["border border-[var(--aws-border)] rounded-[2px] p-2.5", v.green ? "bg-[#eaf6ed]" : "bg-white"].join(" ")}
          >
            <div className="flex items-start justify-between gap-2">
              <span className="inline-flex items-center gap-1 font-mono text-[12px] font-semibold text-[var(--text-primary)]">
                Box #{v.row.box_number}{v.menu}
              </span>
              {v.printButton}
            </div>
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              {v.fields.map((f) => (
                <label key={f.field} className={cardLabel}>
                  {f.label}
                  {f.input}
                </label>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// The ⋮ beside a box number: Update (Save box, for one not saved yet) and Delete,
// for that box only. The menu is fixed-positioned so the table's horizontal
// scroll box can't clip it; it closes on a click elsewhere, Escape, scroll or resize.
function RowMenu({ row, onUpdate, onDelete }: { row: BoxRow; onUpdate?: (r: BoxRow) => void; onDelete?: (r: BoxRow) => void }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pos) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !btn.current?.contains(t)) setPos(null);
    };
    const close = () => setPos(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPos(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [pos]);

  const saved = rowSaved(row);
  function toggle() {
    if (pos) {
      setPos(null);
      return;
    }
    const r = btn.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 168)) });
  }
  const item = "block w-full text-left px-3 py-1.5 text-[12px] font-sans hover:bg-[var(--surface-subtle)]";

  return (
    <>
      <button
        ref={btn}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={!!pos}
        aria-label={`Box ${row.box_number} actions`}
        title="Update or delete this box"
        className="w-5 h-5 inline-flex items-center justify-center rounded hover:bg-[var(--surface-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
      >
        <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden>
          <circle cx="12" cy="5" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="12" cy="19" r="2" />
        </svg>
      </button>
      {pos ? (
        <div
          ref={menu}
          role="menu"
          style={{ top: pos.top, left: pos.left }}
          className="fixed z-40 w-40 bg-white border border-[var(--aws-border-strong)] rounded-[2px] shadow-lg py-1"
        >
          {onUpdate ? (
            <button
              type="button"
              role="menuitem"
              className={`${item} text-[var(--text-primary)]`}
              title={saved ? "Save this box's changes — no other box is touched" : "Save this box now — no other box is touched"}
              onClick={() => {
                setPos(null);
                onUpdate(row);
              }}
            >
              {saved ? "Update" : "Save box"}
            </button>
          ) : null}
          {onDelete ? (
            <button
              type="button"
              role="menuitem"
              className={`${item} text-[var(--aws-error)]`}
              title="Delete this box — no other box is touched"
              onClick={() => {
                setPos(null);
                onDelete(row);
              }}
            >
              Delete
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
