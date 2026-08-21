// What goes ON a dev job-card outpass / delivery challan.
//
// Pulled out of the print page so the rule that decides the LINES and the QUANTITIES is
// testable on its own: an outpass authorizes stock to leave the building, and a doc that
// lists the wrong quantity — or lists a part twice across two docs — is a real inventory
// discrepancy, not a cosmetic bug.
//
// Deliberately dependency-free (no JSX, no React, no path aliases) so it can be exercised
// directly. Structural types only — the page passes DevJobCard / DevDispatch straight in.

export interface OutpassLine {
  desc: string;
  qty: number;
  uom: string;
}

export interface OutpassArticle {
  article_id?: number | null;
  name?: string | null;
  output_qty?: number | string | null;
  output_uom?: string | null;
}

export interface OutpassDispatch {
  dispatch_id: number;
  article_id?: number | null;
  seq: number;
  qty: number | string;
  uom?: string | null;
  recipient?: string | null;
  dispatched_at?: string | null;
}

export interface OutpassInput {
  jcId: number;
  /** ?dispatch=<a,b,c> — the parts this document covers, in the order they were chosen. */
  selectedIds: number[];
  /** ?merge=1 — every article's FULL finalized output, one line each. */
  mergeAll: boolean;
  articles: OutpassArticle[];
  dispatches: OutpassDispatch[];
  fgSkuName?: string | null;
  title?: string | null;
  outputQty?: number | string | null;
  outputUom?: string | null;
  cardUom?: string | null;
  dispatchRecipient?: string | null;
  closedAt?: string | null;
  dispatchedAt?: string | null;
}

/** A quantity totalled within ONE unit label. */
export interface OutpassTotal {
  uom: string;
  qty: number;
}

export interface OutpassDoc {
  /** Resolved ledger rows, in selection order. Unknown ids are dropped. */
  selected: OutpassDispatch[];
  items: OutpassLine[];
  /** One subtotal per distinct unit on the document, in line order. */
  totals: OutpassTotal[];
  /** True when the lines carry more than one unit label — the single `totalQty` below
   *  is then not a figure anyone can act on, and `totalLabel` must be printed instead. */
  mixedUnits: boolean;
  /** Print-ready: "0.48 kg", or "0.05 kg + 0.08 g" when the units differ. */
  totalLabel: string;
  /** Numeric sum across every line. Meaningful ONLY when `mixedUnits` is false. */
  totalQty: number;
  /** `<jc>` full output · `<jc>-<seq>` one part · `<jc>-<seq>+<seq>` a chosen set. */
  outpassNo: string;
  date: string;
  recipient: string;
}

const n = (v: unknown): number => Number(v) || 0;
const day = (v?: string | null): string => (v ?? "").slice(0, 10);

export function buildOutpass(i: OutpassInput): OutpassDoc {
  // Resolve the selection against THIS card's ledger. An id that isn't on the card is
  // dropped rather than faked — a document must never claim a movement with no goods
  // issue behind it.
  const selected = i.selectedIds
    .map((id) => i.dispatches.find((d) => Number(d.dispatch_id) === id))
    .filter((d): d is OutpassDispatch => !!d);
  const one = selected.length === 1 ? selected[0] : null;

  const articleOf = (d: OutpassDispatch) =>
    d.article_id != null ? i.articles.find((a) => a.article_id === d.article_id) ?? null : null;
  const cardUom = i.outputUom || i.cardUom || "kg";

  // A set of parts is ONE document covering all of them, sub-numbered with every seq it
  // carries — unambiguous against the single-part outpasses, and impossible to mistake
  // for the full-output one.
  const outpassNo = selected.length > 1
    ? `${i.jcId}-${selected.map((d) => d.seq).join("+")}`
    : one ? `${i.jcId}-${one.seq}`
    : String(i.jcId);

  const artItems: OutpassLine[] = i.articles
    .filter((a) => a.article_id != null && n(a.output_qty) > 0)
    .map((a) => ({ desc: a.name ?? "—", qty: n(a.output_qty), uom: a.output_uom || cardUom }));

  // Each selected part at ITS OWN quantity and unit (084 lets a part carry a different
  // unit from its balance), labelled with its sub-number so a merged doc reconciles
  // line-by-line against the ledger it was printed from.
  const selectedItems: OutpassLine[] = selected.map((d) => {
    const a = articleOf(d);
    return {
      desc: `${a?.name || i.fgSkuName || i.title || "—"} (part ${i.jcId}-${d.seq})`,
      qty: n(d.qty),
      uom: d.uom || a?.output_uom || cardUom,
    };
  });

  const oneArticle = one ? articleOf(one) : null;
  const items: OutpassLine[] =
    i.mergeAll && artItems.length > 0 ? artItems
    : selected.length > 1 ? selectedItems
    : [{
        desc: oneArticle?.name || i.fgSkuName || i.title || "—",
        qty: n(one ? one.qty : i.outputQty),
        uom: one?.uom || oneArticle?.output_uom || cardUom,
      }];

  // Dated by the LAST part on the document — the movement it authorizes is complete only
  // once every selected part has gone out.
  const lastPartDay = selected.map((d) => day(d.dispatched_at)).filter(Boolean).sort().at(-1);
  const date = lastPartDay || day(one?.dispatched_at) || day(i.closedAt) || day(i.dispatchedAt) || "—";

  // Parts can go out with different drivers; name them all rather than picking one.
  const names = [...new Set(selected.map((d) => (d.recipient ?? "").trim()).filter(Boolean))];
  const recipient = selected.length > 1
    ? (names.join(", ") || "—")
    : (one?.recipient || i.dispatchRecipient || "—");

  // Totals are per UNIT LABEL, never one number across all of them. A part carries its
  // own uom (084) and the quantity is deliberately NOT unit-converted — the label rides
  // along for the goods issue and the outpass. So lines reading "0.05 kg" and "0.08 g"
  // can share a document, and printing their arithmetic sum under a hardcoded "(kg)" is
  // a figure nobody can reconcile against the goods issues behind it.
  const totals = sumByUom(items);
  const mixedUnits = totals.length > 1;
  // Rounded at the source, not left to the caller: summing 0.08 + 0.4 in binary floating
  // point gives 0.48000000000000004, and a challan total is a figure someone reconciles
  // against a goods issue. Quantities in this module are entered at step 0.001, so three
  // decimals is the domain's precision, not an arbitrary cut.
  const totalQty = round3(items.reduce((s, it) => s + it.qty, 0));
  return { selected, items, totals, mixedUnits, totalLabel: formatTotals(totals),
           totalQty, outpassNo, date, recipient };
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Group quantities by unit label, preserving the order the units first appear in. */
export function sumByUom(rows: { qty: number | string; uom?: string | null }[],
                         fallbackUom = "kg"): OutpassTotal[] {
  const out: OutpassTotal[] = [];
  for (const r of rows) {
    const uom = r.uom || fallbackUom;
    const hit = out.find((t) => t.uom === uom);
    if (hit) hit.qty = round3(hit.qty + n(r.qty));
    else out.push({ uom, qty: round3(n(r.qty)) });
  }
  return out;
}

/** "0.48 kg", or "0.05 kg + 0.08 g" across units. */
export function formatTotals(totals: OutpassTotal[], fmt?: (v: number) => string): string {
  if (totals.length === 0) return "—";
  const f = fmt ?? ((v: number) => String(v));
  return totals.map((t) => `${f(t.qty)} ${t.uom}`).join(" + ");
}

/** `?dispatch=` accepts one id or a comma-separated selection. */
export function parseDispatchIds(raw: string | null): number[] {
  return (raw ?? "")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((v) => Number.isFinite(v) && v > 0);
}
