"use client";

// Rich per-article box editor — the legacy "Articles" card. Header (tags +
// UOM/Rate/Value/Carton, read-only here), Qty Units + Net Wt (box sum), an
// "Assign Lot Numbers to Box Ranges" dropdown, bulk-fill, print range, a box
// search, and per-box rows (conv/net/gross/count/lot + print/remove/add). All box
// math is delegated to _boxEngine. Line pricing stays read-only (it's edited on
// the detail screen); this card is for capturing box weights + labels after the
// CR is approved. Native <details> gives the dropdown/menu with no extra JS.

import { useState } from "react";
import {
  type CRBoxForm,
  MAX_BOXES_PER_ARTICLE,
  boxesForArticle,
  articleNetSum,
  setArticleBoxCount,
  addArticleBox,
  removeArticleBox,
  updateBoxField,
  applyLotToRange,
  bulkFillArticle,
} from "./_boxEngine";

export interface ArticleBoxLine {
  item_description: string;
  material_type?: string | null;
  item_category?: string | null;
  sub_category?: string | null;
  uom?: string | number | null;
  rate?: string | number | null;
  value?: string | number | null;
  carton_weight?: string | number | null;
}

const str = (v: string | number | null | undefined) => (v === null || v === undefined ? "" : String(v));
const inCls = "h-8 rounded border border-[var(--aws-border)] px-2 text-[12px] bg-white w-full";
const roCls = "h-8 rounded border border-[var(--aws-border)] px-2 text-[12px] bg-[var(--background)] w-full flex items-center text-[var(--text-primary)]";
const lblCls = "text-[11px] text-[var(--text-secondary)]";
const rangeCls = "h-8 w-24 rounded border border-[var(--aws-border)] px-2 text-[12px] bg-white";

const IconTag = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
    <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" /><circle cx="7.5" cy="7.5" r=".5" fill="currentColor" />
  </svg>
);
const IconPrinter = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
    <path d="M6 9V2h12v7" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="8" rx="1" />
  </svg>
);
const IconChevronLeft = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>;
const IconChevronRight = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>;

const BOX_PAGE_SIZE = 200; // window the box rows so a huge article (500 boxes) stays responsive (detail-page parity)

export function ArticleBoxEditor({
  line, isCold, boxes, onBoxesChange, onPrintBox, printingKey, onPrintRange, printingRange, disabled,
}: {
  line: ArticleBoxLine;
  isCold: boolean;
  boxes: CRBoxForm[];
  onBoxesChange: (next: CRBoxForm[]) => void;
  onPrintBox?: (article: string, boxNumber: number) => void;
  printingKey?: string | null;
  onPrintRange?: (article: string, from: number, to: number) => void;
  printingRange?: boolean;
  // Freeze the whole card (e.g. while a submit/save round-trip is in flight) so no box
  // state changes between the click and the navigation — a native <fieldset disabled>.
  disabled?: boolean;
}) {
  const article = line.item_description;
  const uom = str(line.uom);
  const carton = str(line.carton_weight);
  const ctx = { uom, carton };
  const mine = boxesForArticle(boxes, article);
  const printedCount = mine.filter((b) => b.is_printed || !!b.box_id).length;

  const [bulk, setBulk] = useState({ net_weight: "", gross_weight: "", count: "" });
  const [range, setRange] = useState({ from: "", to: "", lot: "" });
  const [pr, setPr] = useState({ from: "", to: "" });
  const [query, setQuery] = useState("");
  const [active, setActive] = useState("");
  const [page, setPage] = useState(1);

  const setCount = (v: string) => {
    if (v !== "" && (isNaN(parseInt(v)) || parseInt(v) < 0)) return;
    onBoxesChange(setArticleBoxCount(boxes, article, v === "" ? 0 : parseInt(v), uom));
  };
  const setField = (bn: number, field: keyof CRBoxForm, value: string) =>
    onBoxesChange(updateBoxField(boxes, article, bn, field, value, ctx));

  const applyBulk = () => {
    if (!bulk.net_weight && !bulk.gross_weight && !bulk.count) return;
    onBoxesChange(bulkFillArticle(boxes, article, bulk, ctx));
  };
  const applyRange = () => {
    const f = parseInt(range.from || "1");
    const t = parseInt(range.to || String(mine.length));
    if (!range.lot.trim() || Number.isNaN(f) || Number.isNaN(t) || f > t) return;
    onBoxesChange(applyLotToRange(boxes, article, f, t, range.lot.trim()));
    setRange({ from: "", to: "", lot: "" });
  };

  // Box search: match on box_number (exact) or lot substring, applied on Go/Enter.
  const shown = active
    ? mine.filter((b) => String(b.box_number) === active || b.lot_number.toLowerCase().includes(active.toLowerCase()))
    : mine;

  // Window the rows at 200/page. safePage clamps when the list shrinks (search,
  // remove) so the page index never points past the end.
  const totalPages = Math.max(1, Math.ceil(shown.length / BOX_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageBoxes = shown.slice((safePage - 1) * BOX_PAGE_SIZE, safePage * BOX_PAGE_SIZE);

  return (
    <fieldset disabled={disabled} className="border border-[var(--aws-border)] rounded-md p-4 space-y-3 min-w-0 disabled:opacity-70">
      {/* Header: article name + tags */}
      <div>
        <p className="text-[14px] font-medium text-[var(--text-primary)] break-words">{article}</p>
        {(line.material_type || line.item_category || line.sub_category) && (
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {[line.material_type, line.item_category, line.sub_category].filter(Boolean).map((t, i) => (
              <span key={i} className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--aws-border)] bg-white text-[var(--text-secondary)]">{t}</span>
            ))}
          </div>
        )}
      </div>

      {/* Line summary — read-only (line pricing is edited on the detail screen) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Fld label="UOM"><div className={roCls}>{str(line.uom) || "—"}</div></Fld>
        <Fld label="Rate"><div className={roCls}>{str(line.rate) || "—"}</div></Fld>
        <Fld label="Value"><div className={roCls}>{str(line.value) || "—"}</div></Fld>
        <Fld label="Carton Wt"><div className={roCls}>{str(line.carton_weight) || "—"}</div></Fld>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Fld label="Qty Units (boxes)">
          <input type="number" min={0} max={MAX_BOXES_PER_ARTICLE} step={1} value={mine.length} onChange={(e) => setCount(e.target.value)} className={inCls} />
        </Fld>
        <Fld label="Net Wt (box sum)"><div className={roCls}>{articleNetSum(boxes, article) || "—"}</div></Fld>
      </div>

      {printedCount > 0 && (
        <p className="text-[10px] text-[var(--text-secondary)] -mt-1">
          {printedCount} printed box{printedCount === 1 ? "" : "es"} locked in the database — kept even if Qty Units is lowered to 0.
        </p>
      )}

      <div className="border-t border-[var(--aws-border)]" />

      {/* Assign lot numbers to box ranges (native disclosure) */}
      <details className="group">
        <summary className="cursor-pointer inline-flex items-center gap-1.5 text-[12px] font-medium rounded border border-[var(--aws-orange)] text-[var(--aws-orange)] px-2.5 py-1.5 select-none list-none [&::-webkit-details-marker]:hidden">
          <IconTag /> Assign Lot Numbers to Box Ranges
          <span className="text-[10px] transition-transform group-open:rotate-180">▾</span>
        </summary>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="space-y-0.5 block"><span className={lblCls}>From</span><input type="number" min="1" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} className="h-8 w-20 rounded border border-[var(--aws-border)] px-2 text-[12px] bg-white" /></label>
          <label className="space-y-0.5 block"><span className={lblCls}>To</span><input type="number" min="1" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} className="h-8 w-20 rounded border border-[var(--aws-border)] px-2 text-[12px] bg-white" /></label>
          <label className="space-y-0.5 block"><span className={lblCls}>Lot No</span><input value={range.lot} onChange={(e) => setRange((r) => ({ ...r, lot: e.target.value }))} className="h-8 w-32 rounded border border-[var(--aws-border)] px-2 text-[12px] bg-white" /></label>
          <button type="button" onClick={applyRange} className="h-8 text-[12px] rounded border border-[var(--aws-border)] px-2.5 bg-white hover:border-[var(--aws-orange)]">Apply</button>
        </div>
      </details>

      {/* Bulk fill */}
      <div className="flex flex-wrap items-center gap-2 rounded border border-dashed border-[var(--aws-border)] p-2">
        <span className="text-[11px] font-medium text-[var(--text-secondary)]">Bulk fill boxes:</span>
        <input type="number" step="0.001" placeholder="Net wt" aria-label="Bulk net weight" value={bulk.net_weight} onChange={(e) => setBulk((b) => ({ ...b, net_weight: e.target.value }))} className={rangeCls} />
        <input type="number" step="0.001" placeholder="Gross wt" aria-label="Bulk gross weight" value={bulk.gross_weight} onChange={(e) => setBulk((b) => ({ ...b, gross_weight: e.target.value }))} className={rangeCls} />
        <input type="number" step="1" placeholder="Count" aria-label="Bulk count" value={bulk.count} onChange={(e) => setBulk((b) => ({ ...b, count: e.target.value }))} className={rangeCls} />
        <button type="button" onClick={applyBulk} className="h-8 text-[12px] rounded border border-[var(--aws-border)] px-2.5 bg-white hover:border-[var(--aws-orange)]">Apply to all</button>
      </div>

      {/* Print range (only when the parent wires printing) */}
      {onPrintRange && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">Print range:</span>
          <input type="number" min="1" placeholder="From" aria-label="Print from box" value={pr.from} onChange={(e) => setPr((p) => ({ ...p, from: e.target.value }))} className="h-8 w-20 rounded border border-[var(--aws-border)] px-2 text-[12px] bg-white" />
          <input type="number" min="1" placeholder="To" aria-label="Print to box" value={pr.to} onChange={(e) => setPr((p) => ({ ...p, to: e.target.value }))} className="h-8 w-20 rounded border border-[var(--aws-border)] px-2 text-[12px] bg-white" />
          <button type="button" onClick={() => onPrintRange(article, parseInt(pr.from || "1"), parseInt(pr.to || "999999"))} disabled={printingRange} className="h-8 text-[12px] rounded border border-[var(--aws-border)] px-2.5 bg-white hover:border-[var(--aws-orange)] disabled:opacity-50">{printingRange ? "…" : "Print range"}</button>
        </div>
      )}

      <div className="border-t border-[var(--aws-border)]" />

      {/* Boxes header: count + search + add */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-medium text-[var(--text-primary)]">Boxes ({mine.length})</span>
        <form onSubmit={(e) => { e.preventDefault(); setActive(query.trim()); }} className="flex items-center gap-1">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Box # or lot #" aria-label="Search boxes" className="h-8 w-36 rounded border border-[var(--aws-border)] px-2 text-[12px] bg-white" />
          <button type="submit" className="h-8 text-[12px] rounded border border-[var(--aws-border)] px-2.5 bg-white hover:border-[var(--aws-orange)]">Go</button>
          {active && <button type="button" onClick={() => { setQuery(""); setActive(""); }} className="h-8 text-[12px] text-[var(--text-secondary)] px-1">Clear</button>}
        </form>
        <div className="flex-1" />
        <button type="button" onClick={() => onBoxesChange(addArticleBox(boxes, article, uom))} className="h-8 text-[12px] rounded border border-[var(--aws-border)] px-2.5 bg-white hover:border-[var(--aws-orange)]">+ Add Box</button>
      </div>

      {mine.length === 0 ? (
        <p className="text-[12px] text-[var(--text-secondary)]">No boxes yet — set Qty Units or “Add Box”.</p>
      ) : shown.length === 0 ? (
        <p className="text-[12px] text-[var(--text-secondary)]">No boxes match “{active}”.</p>
      ) : (
        <div className="space-y-2">
          {pageBoxes.map((b) => {
            const key = `${article}#${b.box_number}`;
            return (
              <div key={key} className="grid grid-cols-2 sm:grid-cols-[auto_1fr_1fr_1fr_4rem_1fr_auto] gap-2 items-center rounded border border-[var(--aws-border)] p-2">
                <div className="col-span-2 sm:col-span-1 flex items-center gap-1 text-[12px] font-medium text-[var(--text-primary)]">
                  #{b.box_number}
                  <details className="relative">
                    <summary className="cursor-pointer list-none px-1 text-[var(--text-secondary)] select-none [&::-webkit-details-marker]:hidden" aria-label={`Box ${b.box_number} options`}>⋮</summary>
                    <div className="absolute left-0 z-10 mt-1 min-w-[150px] rounded border border-[var(--aws-border)] bg-white shadow-md py-1">
                      {b.is_printed || b.box_id ? (
                        <span className="block px-3 py-1.5 text-[11px] text-[var(--text-muted)]">Printed — locked in DB</span>
                      ) : (
                        <button type="button" onClick={() => onBoxesChange(removeArticleBox(boxes, article, b.box_number))} className="block w-full text-left px-3 py-1.5 text-[12px] text-[var(--aws-error)] hover:bg-[var(--background)]">Remove box</button>
                      )}
                    </div>
                  </details>
                  {b.is_printed && <span className="text-[9px] px-1 rounded bg-[#eaf6ed] text-[var(--text-success)] border border-[#b6dbb1]">✓</span>}
                </div>
                <LabeledMobile label="Conv."><div className={roCls} title="count × UOM">{b.conversion || "—"}</div></LabeledMobile>
                <LabeledMobile label="Net wt"><input type="number" step="0.001" value={b.net_weight} onChange={(e) => setField(b.box_number, "net_weight", e.target.value)} onWheel={(e) => e.currentTarget.blur()} placeholder="Net wt" aria-label="Net weight" className={inCls} /></LabeledMobile>
                <LabeledMobile label="Gross wt"><input type="number" step="0.001" value={b.gross_weight} onChange={(e) => setField(b.box_number, "gross_weight", e.target.value)} onWheel={(e) => e.currentTarget.blur()} placeholder="Gross wt" aria-label="Gross weight" className={inCls} /></LabeledMobile>
                <LabeledMobile label="Count"><input type="number" step="1" value={b.count} onChange={(e) => setField(b.box_number, "count", e.target.value)} onWheel={(e) => e.currentTarget.blur()} placeholder="Count" aria-label="Count" className={inCls} /></LabeledMobile>
                <LabeledMobile label="Lot #"><input value={b.lot_number} onChange={(e) => setField(b.box_number, "lot_number", e.target.value)} placeholder="Lot #" aria-label="Lot number" className={inCls} /></LabeledMobile>
                <div className="col-span-2 sm:col-span-1 flex items-center justify-end gap-1">
                  {onPrintBox && (
                    <button type="button" onClick={() => onPrintBox(article, b.box_number)} disabled={printingKey === key} aria-label={b.is_printed ? `Reprint box ${b.box_number}` : `Save and print box ${b.box_number}`} title={b.is_printed ? "Reprint QR label" : "Save + print this box"} className="h-8 w-8 inline-flex items-center justify-center rounded border border-[var(--aws-border)] bg-white hover:border-[var(--aws-orange)] disabled:opacity-50 text-[var(--text-secondary)]">
                      {printingKey === key ? "…" : <IconPrinter />}
                    </button>
                  )}
                  <button type="button" onClick={() => onBoxesChange(addArticleBox(boxes, article, uom))} title="Add box" aria-label="Add box" className="h-8 w-8 inline-flex items-center justify-center rounded border border-[var(--aws-border)] bg-white hover:border-[var(--aws-orange)] text-[var(--aws-orange)] text-[16px] leading-none">+</button>
                </div>
                {isCold && (
                  <div className="col-span-2 sm:col-span-7 grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
                    <LabeledMobile label="Item Mark"><input value={b.item_mark} onChange={(e) => setField(b.box_number, "item_mark", e.target.value)} placeholder="Item Mark" aria-label="Item mark" className={inCls} /></LabeledMobile>
                    <LabeledMobile label="Spl. Remarks"><input value={b.spl_remarks} onChange={(e) => setField(b.box_number, "spl_remarks", e.target.value)} placeholder="Spl. Remarks" aria-label="Special remarks" className={inCls} /></LabeledMobile>
                    <LabeledMobile label="Vakkal"><input value={b.vakkal} onChange={(e) => setField(b.box_number, "vakkal", e.target.value)} placeholder="Vakkal" aria-label="Vakkal" className={inCls} /></LabeledMobile>
                  </div>
                )}
              </div>
            );
          })}
          {totalPages > 1 && (
            <div className="flex flex-wrap items-center justify-between gap-2 pt-3 mt-1 border-t border-[var(--aws-border)] text-[12px]">
              <span className="text-[var(--text-secondary)]">
                Showing {(safePage - 1) * BOX_PAGE_SIZE + 1}–{Math.min(safePage * BOX_PAGE_SIZE, shown.length)} of {shown.length}{active ? " matching" : ""} boxes
              </span>
              <div className="flex items-center gap-1">
                <button type="button" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} aria-label="Previous page" className="h-7 w-7 inline-flex items-center justify-center rounded border border-[var(--aws-border)] bg-white disabled:opacity-40"><IconChevronLeft /></button>
                <span className="px-1 text-[var(--text-secondary)]">Page {safePage} / {totalPages}</span>
                <button type="button" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)} aria-label="Next page" className="h-7 w-7 inline-flex items-center justify-center rounded border border-[var(--aws-border)] bg-white disabled:opacity-40"><IconChevronRight /></button>
              </div>
            </div>
          )}
        </div>
      )}
    </fieldset>
  );
}

function Fld({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="space-y-1 block min-w-0">
      <span className={lblCls}>{label}</span>
      {children}
    </label>
  );
}

// Label shows only on mobile; on ≥sm the input placeholder names the field
// (matches the compact desktop row in the reference screenshot).
function LabeledMobile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1 min-w-0">
      <label className="text-[10px] text-[var(--text-secondary)] sm:hidden block">{label}</label>
      {children}
    </div>
  );
}
