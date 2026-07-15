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
import {
  listSectionBoxes,
  listSectionBoxesForPrint,
  type PurchaseLine,
  type PurchaseSection,
  type PurchaseBox,
} from "@/lib/purchase-receive";
import { normaliseWarehouseCode } from "@/lib/warehouseScope";
import {
  BOXES_PER_PAGE,
  existingKey,
  type DraftState,
  type DraftBox,
  type ExistingSectionEdit,
  type InwardAction,
  type NewSection,
  type PrintBox,
  type PrintResolver,
} from "./_boxEngine";

const BOX_FETCH_SIZE = 200; // boxes fetched per backend request (lazy chunk)
const BOX_DISPLAY_SIZE = 10; // boxes shown per page in the box table

// Label printing is a cold-storage operation — Print all / Print range are only
// offered when one of these warehouses is selected on the inward's Warehouse field.
const COLD_STORAGE_WAREHOUSES = ["Savla D-34", "Savla D-514", "Rishi", "Supreme", "Eskimo"];
function isColdStorageWarehouse(w: string | null | undefined): boolean {
  const target = normaliseWarehouseCode(w ?? "");
  if (!target) return false;
  return COLD_STORAGE_WAREHOUSES.some((c) => normaliseWarehouseCode(c) === target);
}

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

// Print-all: hands the resolver to the parent, which saves first, then resolves
// (fetching the just-saved boxes) and prints.
function PrintAllButton({ count, resolve, onPrint }: { count: number; resolve: PrintResolver; onPrint: (resolve: PrintResolver) => void }) {
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
function PrintRangeControl({
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
        <div className="absolute right-0 top-full mt-1 z-50 w-56 bg-white border border-[var(--aws-border-strong)] rounded-[2px] shadow-lg p-2.5">
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

// DB box (from the print/list endpoint) → PrintBox.
function purchaseBoxToPrint(b: PurchaseBox, line: PurchaseLine, sectionNumber: number): PrintBox {
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
}) {
  const carton = draft.cartonByLine[line.line_number] ?? "";
  const existingSections = line.sections ?? [];
  const totalExisting = existingSections.reduce((n, s) => n + (s.total_boxes ?? s.box_count ?? s.boxes?.length ?? 0), 0);
  const newForLine = draft.newSections.filter((s) => s.line_number === line.line_number);
  // Label printing (Print all / Range) is gated to cold-storage warehouses.
  const canPrintLabels = isColdStorageWarehouse(draft.header.warehouse);

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
          printedIds={printedIds}
        />
      ))}

      {newForLine.map((sec) => (
        <NewSectionCard key={sec.id} line={line} section={sec} carton={carton} dispatch={dispatch} onPrint={onPrint} canPrint={canPrintLabels} />
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
  printedIds,
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
  printedIds: Set<string>;
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
  const sectionTotal = section.total_boxes ?? section.box_count ?? 0;
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
  }));

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
          {canPrint ? (
            <>
              <PrintAllButton count={sectionTotal} resolve={() => resolvePrint()} onPrint={onPrint} />
              <PrintRangeControl minBox={sectionTotal ? 1 : 0} maxBox={sectionTotal} resolve={resolvePrint} onPrint={onPrint} />
            </>
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
                  onPrintRow={(r) => onPrint(async () => [toPrintBox(r, line, section.section_number)])}
                />
                {displayPages > 1 ? (
                  <div className="flex items-center gap-2 text-[12px] mt-1">
                    <button
                      type="button"
                      disabled={clampedDisplayPage <= 1 || loadingBoxes}
                      onClick={() => setDisplayPage((p) => Math.max(1, p - 1))}
                      className="h-7 px-2 rounded-[2px] border border-[var(--aws-border-strong)] bg-white disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      ‹
                    </button>
                    <span className="text-[var(--text-secondary)]">Page {clampedDisplayPage} of {displayPages}</span>
                    <span className="text-[var(--text-muted)]">
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
              onPrintRow={(r) => onPrint(async () => [toPrintBox(r, line, section.section_number)])}
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
}: {
  line: PurchaseLine;
  section: NewSection;
  carton: string;
  dispatch: React.Dispatch<InwardAction>;
  onPrint: (resolve: PrintResolver) => void;
  canPrint: boolean;
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
            {canPrint ? (
              <div className="flex items-center gap-1.5">
                <PrintAllButton count={total} resolve={() => resolveGen()} onPrint={onPrint} />
                <PrintRangeControl minBox={genMin} maxBox={genMax} resolve={resolveGen} onPrint={onPrint} />
              </div>
            ) : null}
          </div>
          <BoxTable
            rows={rows}
            onField={(idKey, field, value) => dispatch({ type: "setNewBoxField", id: section.id, boxIndex: Number(idKey), field, value, carton })}
            onPrintRow={(r) => onPrint(async () => [toPrintBox(r, line, null)])}
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
function BoxTable({ rows, onField, onPrintRow, greenIds }: { rows: BoxRow[]; onField: (idKey: string | number, field: BoxField, value: string) => void; onPrintRow?: (row: BoxRow) => void; greenIds?: Set<string> }) {
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
            <tr
              key={r.idKey}
              title={greenIds?.has(String(r.idKey)) ? "Saved & printed" : undefined}
              className={["border-b border-[var(--aws-border)] last:border-b-0", greenIds?.has(String(r.idKey)) ? "bg-[#eaf6ed]" : ""].join(" ")}
            >
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
