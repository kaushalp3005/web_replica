"use client";

// Manual print on the Raw Material tab — Stores' Manual print
// (stores/production-indents/_ManualPrint) for boxes that have no sticker,
// saved straight to this job card.
//
// Article (this job card's BOM RM articles as quick picks, or any other from
// stock take's catalogue picker; starts empty) and Material-In's empty carton
// weight, then Stores' own sections (SectionCard): Number of Boxes + LOT Number →
// Generate Boxes → Material-In's box table (Gross / Net / LOT / Count, net =
// gross − carton), printed per box, all, or a range. Generated rows are a draft.
// Printing checks them (lib/box-scan), saves them through /box-scans/print — the
// server mints each box in sfg_box (item_type 'rm') and records it in jc_box_scan
// for this job card, no Stores request involved — then prints Material-In's
// sticker with the returned id, QR {"tx": job card no, "bi": box id}. Printed
// rows leave the draft and appear in the tab's list. "Box #" numbers run on past
// every box already printed for the job card; when the server says some are taken
// (printed out of order, or boxes minted elsewhere meanwhile) the rows still to
// print are renumbered past them. The picker's Off grade choice is not kept:
// jc_box_scan has no stock type.

import { useRef, useState } from "react";
import { clamp3, computeNet, type PrintBox, type PrintResolver } from "@/app/modules/purchase/material-in/[transaction_no]/_boxEngine";
import { printLabels } from "@/app/modules/purchase/material-in/[transaction_no]/_labelPrint";
import { SecField, type BoxField, type BoxRow } from "@/app/modules/purchase/material-in/[transaction_no]/_SectionEditor";
import {
  emptySection, SectionCard, SMALL_BTN, stickerFor, type DraftRow, type Message, type Section, type StickerBox,
} from "@/app/modules/stores/production-indents/_ManualPrint";
import { BTN, FIELD } from "@/components/floor-requisitions/RequisitionUi";
import { NewArticleDialog } from "@/components/stock-take/NewArticleDialog";
import { checkBoxesForPrint, nextBoxNumber, renumberDrafts, renumberedMessage } from "@/lib/box-scan";
import {
  BoxPrintError, printJobCardBoxes, type JobCardBoxPrintResult, type JobCardPrintBoxLine,
} from "@/lib/job-card-box-print";

// More RM articles than this show as a select rather than a row of buttons.
const QUICK_PICK_MAX = 6;

const PICK_BTN = "min-h-7 px-2 py-0.5 text-left text-[12px] rounded-[2px] border break-words";
const PICK_OFF = "border-[var(--aws-border-strong)] bg-white text-[var(--text-primary)] hover:border-[var(--aws-navy)]";
const PICK_ON = "border-[var(--aws-navy)] bg-[var(--aws-navy)] text-white font-semibold";

/** Material-In's stickers for boxes printed on this job card: QR {"tx": job card no, "bi": box id}. */
export function printJobCardStickers(
  jc: { entity: string | null; job_card_number: string | null },
  boxes: StickerBox[],
): Promise<void> {
  return printLabels({ entity: jc.entity ?? "", transaction_no: jc.job_card_number ?? "", boxes: boxes.map(stickerFor) });
}

export function RmManualPrint({
  jcId, rmArticles, nextNumber, onSaved, onStale, onMessage,
}: {
  jcId: number;
  /** This job card's BOM RM articles, offered as quick picks. */
  rmArticles: string[];
  /** The job card's next free "Box #" (from the server), so a draft never reuses
   *  one; null until the job card's boxes have loaded. */
  nextNumber: number | null;
  /** Boxes were saved: the tab reloads its list. */
  onSaved: () => void;
  /** The server refused box numbers already used: reload so nextNumber catches up. */
  onStale: () => void;
  onMessage: (m: Message) => void;
}) {
  const otherRef = useRef<HTMLButtonElement>(null);
  const [article, setArticle] = useState("");
  const [picking, setPicking] = useState(false);
  const [carton, setCarton] = useState("");
  const [sections, setSections] = useState<Section[]>(() => [emptySection(1)]);
  const nextSectionId = useRef(2);
  const printingRef = useRef(false);
  const [printing, setPrinting] = useState(false);
  // Highest Box # this card has printed. Numbering does not wait for the list
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
      onMessage({ kind: "err", text: "Wait for the job card's boxes to load, then Generate." });
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
      sku_name: article,
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
    const name = article.trim();
    if (!name) {
      onMessage({ kind: "err", text: "Choose the article first." });
      return;
    }
    const picked = await resolve();
    const checked = checkBoxesForPrint(picked);
    if (!checked.ok) {
      onMessage({ kind: "err", text: checked.message });
      return;
    }
    // checked.boxes is `picked`, in order, read as numbers; LOT is per box.
    const lines: JobCardPrintBoxLine[] = checked.boxes.map((c, i) => ({
      ...c, lot_number: picked[i].lot_number.trim() || null,
    }));
    printingRef.current = true;
    setPrinting(true);
    try {
      let result: JobCardBoxPrintResult;
      try {
        result = await printJobCardBoxes(jcId, { article: name, boxes: lines });
      } catch (e) {
        if (e instanceof BoxPrintError && e.code === "box_number_taken") {
          // The rows keep their weights and LOT under new numbers, past every box
          // the job card has; the list reloads so nextNumber catches up.
          const next = e.details.next_box_number;
          if (typeof next === "number" && Number.isInteger(next) && next >= 1) {
            const first = nextBoxNumber([next - 1, savedHigh]);
            const taken = Array.isArray(e.details.box_numbers)
              ? e.details.box_numbers.filter((n): n is number => typeof n === "number")
              : [];
            setSections((prev) => renumberDrafts(prev, first));
            onMessage({ kind: "err", text: renumberedMessage(taken, first) });
          } else {
            onMessage({ kind: "err", text: e.message });
          }
          onStale();
          return;
        }
        onMessage({ kind: "err", text: e instanceof Error ? e.message : String(e) });
        return;
      }
      const saved = result.boxes;
      setSavedHigh((h) => Math.max(h, ...saved.map((b) => b.box_number)));
      onSaved();
      dropPrinted(new Set(saved.map((b) => b.box_number)));
      const n = saved.length;
      try {
        await printJobCardStickers(result, saved);
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
    queueMicrotask(() => otherRef.current?.focus());
  }

  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md p-3 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">Manual print</h3>
          <p className="text-[11px] text-[var(--text-muted)]">
            For boxes without a sticker. Each box is saved to this job card when its sticker prints, and added to the list below.
          </p>
        </div>
        {printing ? <span className="shrink-0 text-[12px] text-[var(--text-secondary)]">Printing…</span> : null}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold text-[var(--text-primary)]">Article</span>
        <div className="flex items-start justify-between gap-2 rounded-[2px] border border-[var(--aws-border)] bg-[#fafafa] px-2 py-1.5">
          <span className={`min-w-0 break-words text-[13px] ${article ? "text-[var(--text-primary)]" : "italic text-[var(--text-muted)]"}`}>
            {article || "No article chosen"}
          </span>
          <button ref={otherRef} type="button" className={`${BTN} h-7 shrink-0`} onClick={() => setPicking(true)}>
            Other article…
          </button>
        </div>
        {/* This job card's RM articles: a button each, or a select when there are many. */}
        {rmArticles.length > QUICK_PICK_MAX ? (
          <select
            value={rmArticles.includes(article) ? article : ""}
            onChange={(e) => { if (e.target.value) setArticle(e.target.value); }}
            aria-label="This job card's RM articles"
            className={`${FIELD} w-full`}
          >
            <option value="">This job card&apos;s RM articles…</option>
            {rmArticles.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        ) : rmArticles.length > 0 ? (
          <div role="group" aria-label="This job card's RM articles" className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-[var(--text-muted)]">This job card&apos;s RM:</span>
            {rmArticles.map((name) => (
              <button
                key={name}
                type="button"
                aria-pressed={article === name}
                onClick={() => setArticle(name)}
                className={`${PICK_BTN} ${article === name ? PICK_ON : PICK_OFF}`}
              >
                {name}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {/* One field: it takes the whole row on a phone, where a half column leaves
          its label three lines deep, and keeps its half column from sm up. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
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
            setArticle(a.item_name.trim());
            closePicker();
          }}
        />
      ) : null}
    </div>
  );
}
