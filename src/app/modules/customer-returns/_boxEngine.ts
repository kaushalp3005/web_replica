// Box-wise weight-capture engine for Customer Returns — pure logic, no React.
// Ports the legacy new/page.tsx box rules verbatim so the New CR captures boxes
// exactly like the source:
//   • conversion = round3(count × UOM)         (per box; count defaults to 1)
//   • net_weight = round3(max(0, gross − carton))  (only when the article has a carton weight)
//   • Qty Units drives the number of boxes for an article (add blanks / drop from
//     the end + renumber 1..N)
//   • typed net/gross is rounded to 3 decimals when it has more
//   • article "Net Wt (box sum)" = Σ box net_weight (the actual returned weight)
//
// Boxes are keyed by (article_description, box_number). The engine returns new
// arrays (immutable) so callers just setState(engineFn(...)).

import type { CRBulkBoxItem } from "@/lib/customer-returns";

export interface CRBoxForm {
  article_description: string;
  box_number: number;
  conversion: string;
  net_weight: string;
  gross_weight: string;
  count: string;
  lot_number: string;
  item_mark: string;
  spl_remarks: string;
  vakkal: string;
  box_id?: string; // set once the box is printed/saved
  is_printed: boolean;
}

const n = (v: string | number | null | undefined): number => {
  const x = typeof v === "number" ? v : parseFloat(v ?? "");
  return isNaN(x) ? 0 : x;
};

export const round3 = (x: number): number => parseFloat(x.toFixed(3));

// conversion = count × uom, 3dp; "" when either is non-positive (matches legacy).
export function conv(count: string | number, uom: string | number): string {
  const c = n(count), u = n(uom);
  return c > 0 && u > 0 ? String(round3(c * u)) : "";
}

// net = max(0, gross − carton), 3dp. Only meaningful when carton > 0.
export function netFromGross(gross: string | number, carton: string | number): string {
  const g = n(gross), c = n(carton);
  return String(round3(Math.max(0, g - c)));
}

// Upper bound on boxes per article — a typed/pasted huge "Qty Units" must not
// eagerly materialize millions of objects and freeze the tab.
export const MAX_BOXES_PER_ARTICLE = 500;

export function boxesForArticle(boxes: CRBoxForm[], article: string): CRBoxForm[] {
  return boxes.filter((b) => b.article_description === article);
}

export function articleNetSum(boxes: CRBoxForm[], article: string): number {
  return round3(boxesForArticle(boxes, article).reduce((s, b) => s + n(b.net_weight), 0));
}

export function newBox(article: string, boxNumber: number, uom: string | number): CRBoxForm {
  return {
    article_description: article,
    box_number: boxNumber,
    conversion: conv("1", uom),
    net_weight: "",
    gross_weight: "",
    count: "1",
    lot_number: "",
    item_mark: "",
    spl_remarks: "",
    vakkal: "",
    box_id: undefined,
    is_printed: false,
  };
}

export function addArticleBox(boxes: CRBoxForm[], article: string, uom: string | number): CRBoxForm[] {
  const next = boxesForArticle(boxes, article).length + 1;
  return [...boxes, newBox(article, next, uom)];
}

// A box is "committed" once it has a QR box_id (printed/saved). Its box_number is
// its DB identity (bulk_save matches rows by article_description + box_number), so
// it must never be removed or renumbered by the box-count controls.
const isCommitted = (b: CRBoxForm): boolean => b.is_printed || !!b.box_id;

// Drop one box. Committed (printed) boxes are frozen in the DB — removing one is a
// no-op. Remaining boxes renumber 1..N only while NONE is committed (keeps the
// create flow contiguous); once any box is printed, all box_numbers are pinned.
export function removeArticleBox(boxes: CRBoxForm[], article: string, boxNumber: number): CRBoxForm[] {
  const target = boxes.find((b) => b.article_description === article && b.box_number === boxNumber);
  if (!target || isCommitted(target)) return boxes;
  const kept = boxes.filter((b) => !(b.article_description === article && b.box_number === boxNumber));
  if (boxesForArticle(kept, article).some(isCommitted)) return kept;
  let i = 0;
  return kept.map((b) => (b.article_description === article ? { ...b, box_number: ++i } : b));
}

// Set the article's box count to `desired`. Growing appends new boxes above the
// current high-water box_number (never colliding with a committed one). Shrinking
// drops only UNPRINTED boxes, highest number first — committed boxes are the floor
// (qty can't go below the printed count, even at 0) and keep their identities.
// Renumbering to 1..N happens only when the article has no committed box.
export function setArticleBoxCount(
  boxes: CRBoxForm[],
  article: string,
  desired: number,
  uom: string | number,
): CRBoxForm[] {
  if (desired < 0 || isNaN(desired)) return boxes;
  if (desired > MAX_BOXES_PER_ARTICLE) desired = MAX_BOXES_PER_ARTICLE;
  const mine = boxesForArticle(boxes, article);
  const current = mine.length;
  if (desired === current) return boxes;

  if (desired > current) {
    const maxNum = mine.reduce((m, b) => Math.max(m, b.box_number), 0);
    const added: CRBoxForm[] = [];
    for (let i = 0; i < desired - current; i++) added.push(newBox(article, maxNum + 1 + i, uom));
    return [...boxes, ...added];
  }
  // Shrink: remove unprinted boxes from the end (highest number first); never a
  // committed one, so the effective floor is the printed count.
  let toRemove = current - desired;
  const anyCommitted = mine.some(isCommitted);
  const out = [...boxes];
  for (let i = out.length - 1; i >= 0 && toRemove > 0; i--) {
    const b = out[i];
    if (b.article_description === article && !isCommitted(b)) { out.splice(i, 1); toRemove--; }
  }
  if (anyCommitted) return out; // box_numbers are frozen once anything is printed
  let num = 0;
  return out.map((b) => (b.article_description === article ? { ...b, box_number: ++num } : b));
}

// Update one field of one box, applying the legacy derived-field rules:
//   • net_weight/gross_weight typed with >3 decimals → rounded to 3dp
//   • count changed        → conversion = count × uom
//   • gross_weight changed → net_weight = gross − carton  (only when carton > 0)
export function updateBoxField(
  boxes: CRBoxForm[],
  article: string,
  boxNumber: number,
  field: keyof CRBoxForm,
  value: string,
  ctx: { uom: string | number; carton: string | number },
): CRBoxForm[] {
  let v = value;
  if ((field === "net_weight" || field === "gross_weight") && value !== "") {
    const parts = value.split(".");
    if (parts[1] && parts[1].length > 3 && !isNaN(parseFloat(value))) v = String(round3(parseFloat(value)));
  }
  return boxes.map((b) => {
    if (!(b.article_description === article && b.box_number === boxNumber)) return b;
    const next = { ...b, [field]: v } as CRBoxForm;
    if (field === "count") next.conversion = conv(v, ctx.uom);
    if (field === "gross_weight" && n(ctx.carton) > 0) next.net_weight = netFromGross(v, ctx.carton);
    return next;
  });
}

// Recompute an article's box conversions when the line UOM changes.
export function recomputeArticleOnUom(boxes: CRBoxForm[], article: string, uom: string | number): CRBoxForm[] {
  return boxes.map((b) => (b.article_description === article ? { ...b, conversion: conv(b.count, uom) } : b));
}

// Stamp a lot number onto an article's boxes whose box_number is in [from, to].
// Apply repeatedly for multiple ranges. (Legacy LotRangeDedicator.)
export function applyLotToRange(boxes: CRBoxForm[], article: string, from: number, to: number, lot: string): CRBoxForm[] {
  return boxes.map((b) =>
    b.article_description === article && b.box_number >= from && b.box_number <= to ? { ...b, lot_number: lot } : b,
  );
}

// Bulk-fill every box of an article with the provided net/gross/count (blank =
// leave as-is). Runs each through updateBoxField so gross→net and count→conv
// cascade; net is applied last so an explicit net overrides the gross-derived one.
export function bulkFillArticle(
  boxes: CRBoxForm[],
  article: string,
  patch: { net_weight?: string; gross_weight?: string; count?: string },
  ctx: { uom: string | number; carton: string | number },
): CRBoxForm[] {
  let out = boxes;
  for (const b of boxesForArticle(boxes, article)) {
    if (patch.count) out = updateBoxField(out, article, b.box_number, "count", patch.count, ctx);
    if (patch.gross_weight) out = updateBoxField(out, article, b.box_number, "gross_weight", patch.gross_weight, ctx);
    if (patch.net_weight) out = updateBoxField(out, article, b.box_number, "net_weight", patch.net_weight, ctx);
  }
  return out;
}

// Recompute an article's box net weights when the line carton weight changes.
// Only rewrites boxes that have a gross weight (leaves manual nets otherwise).
export function recomputeArticleOnCarton(boxes: CRBoxForm[], article: string, carton: string | number): CRBoxForm[] {
  if (n(carton) <= 0) return boxes;
  return boxes.map((b) =>
    b.article_description === article && n(b.gross_weight) > 0
      ? { ...b, net_weight: netFromGross(b.gross_weight, carton) }
      : b,
  );
}

// Serialize to the bulk-save contract. `uomFor` supplies each article's line UOM.
export function toBulkItems(boxes: CRBoxForm[], uomFor: (article: string) => string): CRBulkBoxItem[] {
  return boxes.map((b) => ({
    article_description: b.article_description,
    box_number: b.box_number,
    uom: uomFor(b.article_description) || undefined,
    conversion: b.conversion || undefined,
    lot_number: b.lot_number || undefined,
    item_mark: b.item_mark || undefined,
    spl_remarks: b.spl_remarks || undefined,
    vakkal: b.vakkal || undefined,
    net_weight: b.net_weight || undefined,
    gross_weight: b.gross_weight || undefined,
    count: b.count ? parseInt(b.count) : undefined,
  }));
}

// ── Runnable self-check (ponytail: one assert-based demo for the box math) ──
// Run:  npx tsx src/app/modules/customer-returns/_boxEngine.ts
export function demo(): void {
  const assert = (c: boolean, m: string) => { if (!c) throw new Error("boxEngine demo failed: " + m); };

  assert(conv("2", "12") === "24", "conversion 2*12");
  assert(conv("1", "12.5") === "12.5", "conversion 1*12.5");
  assert(conv("0", "12") === "", "conversion 0 count");
  assert(netFromGross("10.2567", "0.4") === "9.857", "net = gross-carton 3dp");
  assert(netFromGross("0.3", "0.4") === "0", "net floors at 0");

  let bx: CRBoxForm[] = [];
  bx = setArticleBoxCount(bx, "APPLE", 3, "12");
  assert(boxesForArticle(bx, "APPLE").length === 3, "3 boxes created");
  assert(bx[0].conversion === "12" && bx[0].count === "1", "default conv=1*uom");
  assert(bx.map((b) => b.box_number).join(",") === "1,2,3", "numbered 1..3");

  bx = updateBoxField(bx, "APPLE", 2, "gross_weight", "10.5", { uom: "12", carton: "0.5" });
  assert(bx[1].net_weight === "10", "gross-carton net on box 2");
  bx = updateBoxField(bx, "APPLE", 1, "net_weight", "9.12345", { uom: "12", carton: "0" });
  assert(bx[0].net_weight === "9.123", "typed net rounded to 3dp");
  bx = updateBoxField(bx, "APPLE", 3, "count", "2", { uom: "12", carton: "0" });
  assert(bx[2].conversion === "24", "count change recomputes conversion");

  assert(articleNetSum(bx, "APPLE") === round3(10 + 9.123), "net sum");

  // add a second article, ensure setCount only touches its own article + renumbers
  bx = addArticleBox(bx, "PEAR", "5");
  bx = setArticleBoxCount(bx, "APPLE", 1, "12");
  assert(boxesForArticle(bx, "APPLE").length === 1, "APPLE shrunk to 1");
  assert(boxesForArticle(bx, "PEAR").length === 1, "PEAR untouched");
  assert(boxesForArticle(bx, "APPLE")[0].box_number === 1, "APPLE renumbered to 1");

  bx = recomputeArticleOnUom(bx, "APPLE", "6");
  assert(boxesForArticle(bx, "APPLE")[0].conversion === "6", "uom change recomputes conv (count 1)");

  // box-count clamp: a huge desired count is capped, not materialized whole.
  const clamped = setArticleBoxCount([], "Z", 9_999_999, "1");
  assert(boxesForArticle(clamped, "Z").length === MAX_BOXES_PER_ARTICLE, "box count clamped to MAX");

  // lot-range: only boxes 2..3 get the lot.
  let lot = setArticleBoxCount([], "M", 4, "1");
  lot = applyLotToRange(lot, "M", 2, 3, "L9");
  assert(lot.map((b) => b.lot_number).join(",") === ",L9,L9,", "lot applied to [2,3] only");

  // printed boxes are frozen: qty can't drop below them (even at 0) and their
  // numbers don't shift; grow adds above the high-water; remove is a no-op.
  let pr = setArticleBoxCount([], "P", 3, "10");
  pr = pr.map((b) => (b.box_number === 2 ? { ...b, box_id: "X", is_printed: true } : b));
  pr = setArticleBoxCount(pr, "P", 0, "10");
  const pmine = boxesForArticle(pr, "P");
  assert(pmine.length === 1 && pmine[0].box_number === 2 && pmine[0].is_printed, "printed box survives qty=0, number frozen");
  pr = setArticleBoxCount(pr, "P", 2, "10");
  assert(boxesForArticle(pr, "P").length === 2, "grow re-adds one unprinted box");
  assert(boxesForArticle(pr, "P").some((b) => b.box_number === 2 && b.is_printed), "printed #2 still pinned after grow");
  assert(boxesForArticle(pr, "P").some((b) => b.box_number > 2 && !b.is_printed), "new box numbered above high-water");
  assert(boxesForArticle(removeArticleBox(pr, "P", 2), "P").some((b) => b.box_number === 2 && b.is_printed), "removeArticleBox no-ops on a printed box");

  // bulk fill: gross fills net via carton; explicit net wins; count sets conv.
  let bf = setArticleBoxCount([], "N", 2, "10");
  bf = bulkFillArticle(bf, "N", { gross_weight: "5", count: "3" }, { uom: "10", carton: "1" });
  assert(bf.every((b) => b.net_weight === "4" && b.conversion === "30"), "bulk gross→net & count→conv");
  bf = bulkFillArticle(bf, "N", { net_weight: "2.5" }, { uom: "10", carton: "1" });
  assert(bf.every((b) => b.net_weight === "2.5"), "bulk explicit net overrides");

  console.log("boxEngine demo: ALL ASSERTIONS PASSED");
}
