"use client";

// Manual print in the Scan material dialog — Purchase → Material-In's box
// sections, for boxes that have no sticker.
//
// Article (stock take's new-article picker; starts as the requested material)
// and Material-In's empty carton weight, then sections: Number of Boxes + LOT
// Number → Generate Boxes → Material-In's own box table (Gross / Net / LOT /
// Count, net = gross − carton as there), printed per box, all, or a range.
// Generated rows are a draft. Printing checks them (lib/box-scan), saves them
// through /boxes/print — the server mints each box in sfg_box (item_type 'rm')
// and records it on the request — then prints Material-In's sticker with the
// returned id, QR {"tx": request no, "bi": box id}. Printed rows leave the draft
// and appear in the dialog's list. "Box #" numbers run on past every box already
// on the request. MFG / EXP dates are left out: the sticker doesn't carry them.

import { useRef, useState } from "react";
import { clamp3, computeNet, type PrintBox, type PrintResolver } from "@/app/modules/purchase/material-in/[transaction_no]/_boxEngine";
import { printLabels } from "@/app/modules/purchase/material-in/[transaction_no]/_labelPrint";
import {
  BoxTable, PrintAllButton, PrintRangeControl, SecField, type BoxField, type BoxRow,
} from "@/app/modules/purchase/material-in/[transaction_no]/_SectionEditor";
import { BTN } from "@/components/floor-requisitions/RequisitionUi";
import { NewArticleDialog } from "@/components/stock-take/NewArticleDialog";
import { checkBoxesForPrint, nextBoxNumber } from "@/lib/box-scan";
import {
  printRequisitionBoxes, RequisitionConflictError, type FloorRequisition, type PrintBoxLine, type RequisitionBox,
} from "@/lib/floor-requisitions";

const BOXES_PER_PAGE = 10;
export const FRESH_STOCK = "Fresh Stock";

// Exported with SectionCard for the job card's Raw Material tab, which prints the same way.
export type Message = { kind: "ok" | "err"; text: string };
export type DraftRow = { box_number: number; gross_weight: string; net_weight: string; lot_number: string; count: string };
export type Section = { id: number; box_count: string; lot_number: string; boxes: DraftRow[] | null; page: number };

export function emptySection(id: number): Section {
  return { id, box_count: "", lot_number: "", boxes: null, page: 1 };
}

export const SMALL_BTN =
  "h-7 px-2 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] " +
  "inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed";

export function OffGradeTag({ stockType }: { stockType: string | null }) {
  if (!stockType || stockType === FRESH_STOCK) return null;
  return <span className="ml-1.5 text-[11px] font-semibold text-[#a8500a]">Off grade</span>;
}

/** What a sticker reads from a stored box. */
export type StickerBox = Pick<
  RequisitionBox, "box_code" | "box_number" | "net_weight" | "gross_weight" | "lot_number" | "count" | "article"
>;

/** Material-In's sticker for a stored box: QR {"tx": request no, "bi": box id}.
 *  The job card's Raw Material tab prints its own boxes with it too. */
export function stickerFor(b: StickerBox): PrintBox {
  return {
    box_id: b.box_code,
    box_number: b.box_number ?? 0,
    net_weight: b.net_weight != null ? b.net_weight.toFixed(3) : "",
    gross_weight: b.gross_weight != null ? b.gross_weight.toFixed(3) : "",
    lot_number: b.lot_number ?? "",
    count: b.count != null ? String(b.count) : "",
    line_number: 0,
    section_number: null,
    sku_name: b.article,
  };
}

export function printStickers(r: FloorRequisition, boxes: RequisitionBox[]): Promise<void> {
  return printLabels({ entity: r.warehouse, transaction_no: String(r.requisition_id), boxes: boxes.map(stickerFor) });
}

export function ManualPrint({
  requisition, nextNumber, onSaved, onStale, onMessage,
}: {
  requisition: FloorRequisition;
  /** The request's next free "Box #" (from the server), so a draft never reuses
   *  one; null until the request's boxes have loaded. */
  nextNumber: number | null;
  onSaved: (boxes: RequisitionBox[]) => void;
  /** The server refused box numbers someone else took: reload so nextNumber catches up. */
  onStale: () => void;
  onMessage: (m: Message) => void;
}) {
  const r = requisition;
  const changeRef = useRef<HTMLButtonElement>(null);
  const [article, setArticle] = useState({ name: r.material_sku_name, stock_type: FRESH_STOCK });
  const [picking, setPicking] = useState(false);
  const [carton, setCarton] = useState("");
  const [sections, setSections] = useState<Section[]>(() => [emptySection(1)]);
  const nextSectionId = useRef(2);
  const printingRef = useRef(false);
  const [printing, setPrinting] = useState(false);
  // Highest Box # this dialog has printed. Numbering does not wait for the list
  // reload that follows a print (it may be slow, or fail) to catch up.
  const [savedHigh, setSavedHigh] = useState(0);

  const updateSection = (id: number, fn: (s: Section) => Section) =>
    setSections((prev) => prev.map((s) => (s.id === id ? fn(s) : s)));

  function addSection() {
    const id = nextSectionId.current++;
    setSections((prev) => [...prev, emptySection(id)]);
  }

  function generate(sec: Section) {
    const n = Number(sec.box_count.trim());
    if (!Number.isInteger(n) || n < 1) {
      onMessage({ kind: "err", text: "Enter the number of boxes (a whole number, 1 or more), then Generate." });
      return;
    }
    if (nextNumber == null) {
      onMessage({ kind: "err", text: "Wait for the request's boxes to load, then Generate." });
      return;
    }
    const start = nextBoxNumber([
      nextNumber - 1, savedHigh, ...sections.flatMap((s) => (s.boxes ?? []).map((b) => b.box_number)),
    ]);
    const boxes: DraftRow[] = Array.from({ length: n }, (_, i) => ({
      box_number: start + i, gross_weight: "", net_weight: "", lot_number: sec.lot_number.trim(), count: "",
    }));
    updateSection(sec.id, (s) => ({ ...s, boxes, page: 1 }));
  }

  // As Material-In's setNewBoxField: weights capped at 3 decimals, and a gross
  // entry recomputes net from the carton weight.
  function setBoxField(sectionId: number, boxNumber: number, field: BoxField, value: string) {
    const v = field === "gross_weight" || field === "net_weight" ? clamp3(value) : value;
    updateSection(sectionId, (s) => ({
      ...s,
      boxes: (s.boxes ?? []).map((b) => {
        if (b.box_number !== boxNumber) return b;
        const next = { ...b, [field]: v };
        return field === "gross_weight" ? { ...next, net_weight: computeNet(v, carton) } : next;
      }),
    }));
  }

  // As Material-In's setCarton: every box's net is recomputed from its gross.
  function changeCarton(value: string) {
    const c = clamp3(value);
    setCarton(c);
    setSections((prev) => prev.map((s) => (s.boxes
      ? { ...s, boxes: s.boxes.map((b) => ({ ...b, net_weight: computeNet(b.gross_weight, c) })) }
      : s)));
  }

  // A draft row as Material-In's print payload — no box id until it is saved.
  function toPrintBox(b: DraftRow | BoxRow): PrintBox {
    return {
      box_id: null,
      box_number: b.box_number,
      net_weight: b.net_weight,
      gross_weight: b.gross_weight,
      lot_number: b.lot_number,
      count: b.count,
      line_number: 0,
      section_number: null,
      sku_name: article.name,
    };
  }

  // Printed rows leave the draft; a section whose rows are all printed goes back
  // to its fields (LOT kept) so it can generate again.
  function dropPrinted(numbers: Set<number>) {
    setSections((prev) => prev.map((s) => {
      if (!s.boxes) return s;
      const left = s.boxes.filter((b) => !numbers.has(b.box_number));
      return left.length ? { ...s, boxes: left } : { ...s, boxes: null, box_count: "", page: 1 };
    }));
  }

  async function handlePrint(resolve: PrintResolver) {
    if (printingRef.current) return;
    const picked = await resolve();
    const checked = checkBoxesForPrint(picked);
    if (!checked.ok) {
      onMessage({ kind: "err", text: checked.message });
      return;
    }
    // checked.boxes is `picked`, in order, read as numbers; LOT is per box.
    const lines: PrintBoxLine[] = checked.boxes.map((c, i) => ({
      ...c, lot_number: picked[i].lot_number.trim() || null,
    }));
    printingRef.current = true;
    setPrinting(true);
    try {
      let saved: RequisitionBox[];
      try {
        saved = (await printRequisitionBoxes(r.requisition_id, {
          article: article.name, stock_type: article.stock_type, boxes: lines,
        })).boxes;
      } catch (e) {
        onMessage({ kind: "err", text: e instanceof Error ? e.message : String(e) });
        if (e instanceof RequisitionConflictError && e.code === "box_number_taken") onStale();
        return;
      }
      setSavedHigh((h) => Math.max(h, ...saved.map((b) => b.box_number ?? 0)));
      onSaved(saved);
      dropPrinted(new Set(saved.flatMap((b) => (b.box_number != null ? [b.box_number] : []))));
      const n = saved.length;
      try {
        await printStickers(r, saved);
        onMessage({ kind: "ok", text: `Saved and printed ${n} sticker${n === 1 ? "" : "s"}.` });
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        onMessage({
          kind: "err",
          text: `Saved ${n} box${n === 1 ? "" : "es"}, but the print window didn't open (${why}). Print them with 🖨 in the list.`,
        });
      }
    } finally {
      printingRef.current = false;
      setPrinting(false);
    }
  }

  function closePicker() {
    setPicking(false);
    queueMicrotask(() => changeRef.current?.focus());
  }

  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md p-3 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">Manual print</h3>
          <p className="text-[11px] text-[var(--text-muted)]">
            For boxes without a sticker. Each box is saved when its sticker prints, and added to the list below.
          </p>
        </div>
        {printing ? <span className="shrink-0 text-[12px] text-[var(--text-secondary)]">Printing…</span> : null}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold text-[var(--text-primary)]">Article</span>
        <div className="flex items-start justify-between gap-2 rounded-[2px] border border-[var(--aws-border)] bg-[#fafafa] px-2 py-1.5">
          <span className="min-w-0 break-words text-[13px] text-[var(--text-primary)]">
            {article.name}
            <OffGradeTag stockType={article.stock_type} />
          </span>
          <button ref={changeRef} type="button" className={`${BTN} h-7 shrink-0`} onClick={() => setPicking(true)}>
            Change
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <SecField label="Empty Carton + Laminate (kg)" type="number" mono value={carton} placeholder="0.000" onChange={changeCarton} />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] uppercase tracking-wide font-bold text-[var(--text-muted)]">Box Sections</span>
          <button type="button" onClick={addSection} className={SMALL_BTN}>+ Add Section</button>
        </div>
        {sections.map((sec, i) => (
          <SectionCard
            key={sec.id}
            index={i}
            section={sec}
            onField={(field, value) => updateSection(sec.id, (s) => ({ ...s, [field]: value }))}
            onGenerate={() => generate(sec)}
            onRemove={() => setSections((prev) => prev.filter((s) => s.id !== sec.id))}
            onPage={(page) => updateSection(sec.id, (s) => ({ ...s, page }))}
            onBoxField={(boxNumber, field, value) => setBoxField(sec.id, boxNumber, field, value)}
            toPrintBox={toPrintBox}
            onPrint={(resolve) => void handlePrint(resolve)}
          />
        ))}
        {sections.length === 0 ? (
          <p className="text-[12px] text-[var(--text-muted)] italic">No box sections yet — click “+ Add Section”.</p>
        ) : null}
      </div>

      {picking ? (
        <NewArticleDialog
          title="Choose the article"
          intro="Search the catalogue, browse by category, or enter an article that isn't in it."
          onCancel={closePicker}
          onPick={(a) => {
            setArticle({ name: a.item_name, stock_type: a.stock_type });
            closePicker();
          }}
        />
      ) : null}
    </div>
  );
}

// One section — Material-In's NewSectionCard, without MFG / EXP.
export function SectionCard({
  index, section, onField, onGenerate, onRemove, onPage, onBoxField, toPrintBox, onPrint,
}: {
  index: number;
  section: Section;
  onField: (field: "box_count" | "lot_number", value: string) => void;
  onGenerate: () => void;
  onRemove: () => void;
  onPage: (page: number) => void;
  onBoxField: (boxNumber: number, field: BoxField, value: string) => void;
  toPrintBox: (b: DraftRow | BoxRow) => PrintBox;
  onPrint: (resolve: PrintResolver) => void;
}) {
  const generated = section.boxes;
  const total = generated?.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / BOXES_PER_PAGE));
  const page = Math.min(Math.max(1, section.page), totalPages);
  const start = (page - 1) * BOXES_PER_PAGE;
  const end = Math.min(start + BOXES_PER_PAGE, total);
  const rows: BoxRow[] = (generated ?? []).slice(start, end).map((b) => ({ idKey: b.box_number, ...b }));
  const genMin = generated?.[0]?.box_number ?? 0;
  const genMax = generated?.[total - 1]?.box_number ?? 0;

  async function resolveRange(from?: number, to?: number): Promise<PrintBox[]> {
    return (generated ?? [])
      .filter((b) => (from == null || b.box_number >= from) && (to == null || b.box_number <= to))
      .map(toPrintBox);
  }

  return (
    <div className="border border-dashed border-[var(--aws-border-strong)] rounded-[2px] p-2.5">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-[12px] font-semibold text-[var(--text-primary)]">Section {index + 1}</span>
        <div className="flex items-center gap-1.5">
          <button type="button" disabled={!!generated} onClick={onGenerate} className={SMALL_BTN}>
            {generated ? "Generated" : "Generate Boxes"}
          </button>
          <button
            type="button"
            onClick={onRemove}
            title="Remove section"
            aria-label={`Remove section ${index + 1}`}
            className="h-7 w-7 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-error)] hover:text-[var(--aws-error)]"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-2">
        <SecField label="Number of Boxes" type="number" mono value={section.box_count} placeholder="e.g. 10" onChange={(v) => onField("box_count", v)} />
        <SecField label="LOT Number" mono value={section.lot_number} placeholder="LOT-…" onChange={(v) => onField("lot_number", v)} />
      </div>

      {generated ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wide text-[var(--text-muted)]">Generated Boxes ({total})</span>
            <div className="flex items-center gap-1.5">
              <PrintAllButton count={total} resolve={() => resolveRange()} onPrint={onPrint} />
              <PrintRangeControl minBox={genMin} maxBox={genMax} resolve={resolveRange} onPrint={onPrint} />
            </div>
          </div>
          <BoxTable
            rows={rows}
            onField={(idKey, field, value) => onBoxField(Number(idKey), field, value)}
            onPrintRow={(row) => onPrint(async () => [toPrintBox(row)])}
          />
          {totalPages > 1 ? (
            // The box range is the first thing to go on a phone, where the four
            // parts no longer fit on one line.
            <div className="flex flex-wrap items-center gap-2 text-[12px]">
              <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page"
                className="h-7 px-2 rounded-[2px] border border-[var(--aws-border-strong)] bg-white disabled:opacity-50 disabled:cursor-not-allowed">‹</button>
              <span className="text-[var(--text-secondary)]">Page {page} of {totalPages}</span>
              <span className="hidden sm:inline text-[var(--text-muted)]">(Box {start + 1}–{end} of {total})</span>
              <button type="button" disabled={page >= totalPages} onClick={() => onPage(page + 1)} aria-label="Next page"
                className="h-7 px-2 rounded-[2px] border border-[var(--aws-border-strong)] bg-white disabled:opacity-50 disabled:cursor-not-allowed">›</button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
