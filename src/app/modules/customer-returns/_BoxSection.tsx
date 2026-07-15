"use client";

// Box-wise weight capture for ONE article's boxes (a resolved line). Ports the
// legacy New-CR box grid: a "Qty Units" control that sets the number of boxes,
// per-box Conversion (auto = count × UOM), Net Wt, Gross Wt, Count (+ cold-only
// Lot/Item Mark/Spl/Vakkal), the article "Net Wt (box sum)", add/remove, and a
// per-box Print (mints the QR label). All box math lives in _boxEngine.

import {
  type CRBoxForm,
  MAX_BOXES_PER_ARTICLE,
  boxesForArticle,
  articleNetSum,
  setArticleBoxCount,
  addArticleBox,
  removeArticleBox,
  updateBoxField,
} from "./_boxEngine";

const inputCls = "h-8 rounded border border-[var(--aws-border)] px-2 text-[12px] bg-white w-full";
const roCls = "h-8 rounded border border-[var(--aws-border)] px-2 text-[12px] bg-[var(--background)] w-full flex items-center text-[var(--text-primary)]";
const labelCls = "text-[11px] text-[var(--text-secondary)]";

export function CustomerReturnBoxSection({
  article, uom, carton, isCold, boxes, onBoxesChange, onPrint, printingKey, disabled,
}: {
  article: string;
  uom: string;
  carton: string;
  isCold: boolean;
  boxes: CRBoxForm[];
  onBoxesChange: (next: CRBoxForm[]) => void;
  onPrint?: (article: string, boxNumber: number) => void;
  printingKey?: string | null;
  disabled?: boolean;
}) {
  const mine = boxesForArticle(boxes, article);
  const ctx = { uom, carton };

  const setCount = (v: string) => {
    if (v !== "" && (isNaN(parseInt(v)) || parseInt(v) < 0)) return;
    onBoxesChange(setArticleBoxCount(boxes, article, v === "" ? 0 : parseInt(v), uom));
  };
  const setField = (boxNumber: number, field: keyof CRBoxForm, value: string) =>
    onBoxesChange(updateBoxField(boxes, article, boxNumber, field, value, ctx));

  return (
    <div className="mt-3 pt-3 border-t border-[var(--aws-border)] space-y-3">
      {/* Controls */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label className={labelCls}>Qty Units <span className="text-[var(--text-muted)]">(boxes)</span></label>
          <input
            type="number" min={0} max={MAX_BOXES_PER_ARTICLE} step={1} value={mine.length}
            onChange={(e) => setCount(e.target.value)}
            disabled={disabled}
            className="h-8 rounded border border-[var(--aws-border)] px-2 text-[12px] bg-white w-24"
          />
        </div>
        <div className="space-y-1">
          <label className={labelCls}>Net Wt <span className="text-[var(--text-muted)]">(box sum)</span></label>
          <div className="h-8 rounded border border-[var(--aws-border)] px-2 text-[12px] bg-[var(--background)] w-28 flex items-center text-[var(--text-primary)]">
            {articleNetSum(boxes, article) || "—"}
          </div>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => onBoxesChange(addArticleBox(boxes, article, uom))}
          disabled={disabled}
          className="h-8 text-[12px] rounded border border-[var(--aws-border)] px-2.5 bg-white hover:border-[var(--aws-orange)] disabled:opacity-50"
        >
          + Add Box
        </button>
      </div>

      {mine.length === 0 ? (
        <p className="text-[12px] text-[var(--text-secondary)]">No boxes yet — set Qty Units or “Add Box”.</p>
      ) : (
        <div className="space-y-2">
          {/* Column headers (desktop) */}
          <div className="hidden sm:grid grid-cols-[3rem_1fr_1fr_1fr_4rem_auto] gap-2 text-[10px] uppercase tracking-wide text-[var(--text-secondary)] px-1">
            <span>Box</span><span>Conv.</span><span>Net Wt</span><span>Gross Wt</span><span>Count</span><span></span>
          </div>
          {mine.map((b) => {
            const key = `${article}#${b.box_number}`;
            return (
              <div key={key} className="rounded border border-[var(--aws-border)] p-2 space-y-2">
                <div className="grid grid-cols-2 sm:grid-cols-[3rem_1fr_1fr_1fr_4rem_auto] gap-2 items-center">
                  <div className="text-[12px] font-medium text-[var(--text-primary)] flex items-center gap-1">
                    #{b.box_number}
                    {b.is_printed && <span className="text-[9px] px-1 py-px rounded bg-[#eaf6ed] text-[var(--text-success)] border border-[#b6dbb1]">✓</span>}
                  </div>
                  <FieldMobile label="Conv."><div className={roCls} title="count × UOM">{b.conversion || "—"}</div></FieldMobile>
                  <FieldMobile label="Net Wt"><input type="number" step="0.001" value={b.net_weight} onChange={(e) => setField(b.box_number, "net_weight", e.target.value)} onWheel={(e) => e.currentTarget.blur()} disabled={disabled} className={inputCls} /></FieldMobile>
                  <FieldMobile label="Gross Wt"><input type="number" step="0.001" value={b.gross_weight} onChange={(e) => setField(b.box_number, "gross_weight", e.target.value)} onWheel={(e) => e.currentTarget.blur()} disabled={disabled} className={inputCls} /></FieldMobile>
                  <FieldMobile label="Count"><input type="number" step="1" value={b.count} onChange={(e) => setField(b.box_number, "count", e.target.value)} onWheel={(e) => e.currentTarget.blur()} disabled={disabled} className={inputCls} /></FieldMobile>
                  <div className="flex items-center justify-end gap-1 col-span-2 sm:col-span-1">
                    {onPrint && (
                      <button
                        type="button" onClick={() => onPrint(article, b.box_number)}
                        disabled={disabled || printingKey === key}
                        className="h-8 text-[11px] rounded border border-[var(--aws-border)] px-2 bg-white hover:border-[var(--aws-orange)] disabled:opacity-50"
                        title="Save + print this box's QR label"
                      >
                        {printingKey === key ? "…" : b.is_printed ? "Reprint" : "Print"}
                      </button>
                    )}
                    <button
                      type="button" onClick={() => onBoxesChange(removeArticleBox(boxes, article, b.box_number))}
                      disabled={disabled}
                      className="h-8 w-8 text-[12px] text-[var(--aws-error)] rounded border border-[var(--aws-border)] bg-white disabled:opacity-50"
                      title="Remove box"
                    >
                      ✕
                    </button>
                  </div>
                </div>

                {/* Cold-only per-box fields */}
                {isCold && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
                    <FieldMobile label="Lot No"><input value={b.lot_number} onChange={(e) => setField(b.box_number, "lot_number", e.target.value)} disabled={disabled} className={inputCls} /></FieldMobile>
                    <FieldMobile label="Item Mark"><input value={b.item_mark} onChange={(e) => setField(b.box_number, "item_mark", e.target.value)} disabled={disabled} className={inputCls} /></FieldMobile>
                    <FieldMobile label="Spl. Remarks"><input value={b.spl_remarks} onChange={(e) => setField(b.box_number, "spl_remarks", e.target.value)} disabled={disabled} className={inputCls} /></FieldMobile>
                    <FieldMobile label="Vakkal"><input value={b.vakkal} onChange={(e) => setField(b.box_number, "vakkal", e.target.value)} disabled={disabled} className={inputCls} /></FieldMobile>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Renders the label above the control on mobile; the label collapses (sr-only)
// on ≥sm where the column header row already names the field.
function FieldMobile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1 min-w-0">
      <label className="text-[10px] text-[var(--text-secondary)] sm:hidden block">{label}</label>
      {children}
    </div>
  );
}
