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

// Drop one box and renumber the article's remaining boxes 1..N (keeps order).
export function removeArticleBox(boxes: CRBoxForm[], article: string, boxNumber: number): CRBoxForm[] {
  const kept = boxes.filter((b) => !(b.article_description === article && b.box_number === boxNumber));
  let i = 0;
  return kept.map((b) => (b.article_description === article ? { ...b, box_number: ++i } : b));
}

// Set the article's box count to `desired`: append blanks or drop from the end,
// then renumber 1..desired. Non-article boxes are untouched and keep their order.
export function setArticleBoxCount(
  boxes: CRBoxForm[],
  article: string,
  desired: number,
  uom: string | number,
): CRBoxForm[] {
  if (desired < 0 || isNaN(desired)) return boxes;
  if (desired > MAX_BOXES_PER_ARTICLE) desired = MAX_BOXES_PER_ARTICLE;
  const current = boxesForArticle(boxes, article).length;
  if (desired === current) return boxes;

  if (desired > current) {
    const added: CRBoxForm[] = [];
    for (let i = current; i < desired; i++) added.push(newBox(article, i + 1, uom));
    return [...boxes, ...added];
  }
  // desired < current: remove from the end (highest indices) then renumber.
  let toRemove = current - desired;
  const out = [...boxes];
  for (let i = out.length - 1; i >= 0 && toRemove > 0; i--) {
    if (out[i].article_description === article) { out.splice(i, 1); toRemove--; }
  }
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

  console.log("boxEngine demo: ALL ASSERTIONS PASSED");
}
