// Floor stock on the job card's "Material allocation and requisition" tab — the
// pure half: which rows appear, and in what order.
//
// The server (GET /api/v1/stock-take/floor-stock) returns everything recorded on
// the job card's own warehouse + floor. The tab lists the job card's BOM articles
// first — each with whatever that floor holds of it, or nothing — and then every
// other item on the floor.
//
// MATCHING IS BY NAME. Stock-take rows carry no SKU id, only the article name, so
// a BOM article and a counted item are the same when their names agree ignoring
// case and surrounding spaces. That is exactly the server's own identity for an
// article (UPPER(BTRIM(item_name))), so the tab and the Stock Take screen agree on
// what one item is. There is deliberately no fuzzy matching: a near-name hit would
// show another article's stock as this one's.
//
// No React / Next imports, so this runs under plain Node for its tests.

/** The fields of a floor-stock row this module reads. */
export type FloorStockLike = {
  item_name: string;
  stock_type: string;
  available_kg: number;
  /** A count of units — pieces for packaging. */
  available_quantity?: number;
  item_type?: string | null;
  item_category?: string | null;
  item_subcategory?: string | null;
};

/** The fields of a job-card BOM line this module reads. `article_type` is an
 *  added FG / SFG article's real type (its item_type is its accounting kind, RM). */
export type BomArticleLike = { material_sku_name: string; item_type?: string | null; article_type?: string | null };

export type BomFloorRow<T> = {
  /** Match key (the article name, trimmed and upper-cased). */
  key: string;
  /** The article name as the BOM spells it. */
  article: string;
  /** RM / SFG / PM … upper-cased; "—" when the BOM line has none. */
  itemType: string;
  /** What this floor holds of the article, Fresh Stock first. Empty = none on this floor. */
  stock: T[];
};

export type FloorStockView<T> = { bom: BomFloorRow<T>[]; other: T[] };

/** An article's identity: the server's UPPER(BTRIM(item_name)). */
export function articleKey(name: string | null | undefined): string {
  return (name ?? "").trim().toUpperCase();
}

// Raw material first — it is what a job card mostly draws from a floor — then
// the intermediate, then packaging. Anything else after those.
const TYPE_RANK: Record<string, number> = { RM: 0, SFG: 1, WIP: 1, PM: 2 };
const rankOf = (t: string) => TYPE_RANK[t] ?? 3;

/** Stock rows of one article: Fresh Stock first, then by stock type. */
export const freshFirst = (a: FloorStockLike, b: FloorStockLike) =>
  Number(b.stock_type === "Fresh Stock") - Number(a.stock_type === "Fresh Stock")
  || a.stock_type.localeCompare(b.stock_type);

/**
 * BOM articles first (RM → SFG → PM, each group in BOM order, repeats dropped),
 * each with its stock on this floor; then every other item on the floor, largest
 * available first.
 */
export function buildFloorStockView<T extends FloorStockLike>(
  items: readonly T[],
  bom: readonly BomArticleLike[],
): FloorStockView<T> {
  const byKey = new Map<string, T[]>();
  for (const it of items) {
    const k = articleKey(it.item_name);
    const list = byKey.get(k);
    if (list) list.push(it);
    else byKey.set(k, [it]);
  }

  const rows: BomFloorRow<T>[] = [];
  const bomOrder = new Map<string, number>();
  for (const line of bom) {
    const k = articleKey(line.material_sku_name);
    if (!k || bomOrder.has(k)) continue;
    bomOrder.set(k, bomOrder.size);
    rows.push({
      key: k,
      article: line.material_sku_name.trim(),
      itemType: articleKey(line.item_type) || "—",
      stock: [...(byKey.get(k) ?? [])].sort(freshFirst),
    });
  }
  rows.sort((a, b) =>
    rankOf(a.itemType) - rankOf(b.itemType) || (bomOrder.get(a.key) ?? 0) - (bomOrder.get(b.key) ?? 0));

  const other = items
    .filter((it) => !bomOrder.has(articleKey(it.item_name)))
    .sort((a, b) => b.available_kg - a.available_kg || a.item_name.localeCompare(b.item_name));

  return { bom: rows, other };
}

// ── Production requirement ────────────────────────────────────────────────────
//
// What the job card needs is its indent lines (job_card_rm_indent_v2 in KGS,
// job_card_pm_indent_v2 in PCS). gross_qty is the required quantity WITH the loss
// allowance — what production will actually draw — so that is the requirement;
// reqd_qty is only the fallback for a line without one. issued_qty is not used:
// nothing writes it today.
//
// It is compared against the floor's FRESH STOCK only — off grade / rejection is
// not usable for production — in the requirement's own unit: kg against the
// available kg, pieces against the counted piece quantity.

/** The fields of a job-card indent line this module reads. */
export type IndentLike = {
  material_sku_name?: string | null;
  item_type?: string | null;
  uom?: string | null;
  gross_qty?: unknown;
  reqd_qty?: unknown;
};

export type Requirement = { qty: number; unit: string };
export type Coverage = { required: number; available: number; unit: string; balance: number };

// `+ 0` turns -0 into 0, so a balance that rounds to nothing is never "-0".
const round3 = (n: number) => Math.round(n * 1000) / 1000 + 0;

function toQty(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Indent units as one spelling each: 'KGS' → 'kg', 'PCS' / 'NOS' → 'pcs'. */
export function normaliseUnit(u: string | null | undefined): string {
  const s = (u ?? "").trim().toLowerCase();
  if (["kg", "kgs", "kilogram", "kilograms"].includes(s)) return "kg";
  if (["pc", "pcs", "piece", "pieces", "no", "nos", "unit", "units"].includes(s)) return "pcs";
  return s;
}

/** The job card's requirement per article (by articleKey), summed across its indent lines. */
export function requirementsByArticle(indents: readonly IndentLike[]): Map<string, Requirement> {
  const out = new Map<string, Requirement>();
  for (const line of indents) {
    const k = articleKey(line.material_sku_name);
    const qty = toQty(line.gross_qty) ?? toQty(line.reqd_qty);
    if (!k || qty == null) continue;
    const unit = normaliseUnit(line.uom);
    const cur = out.get(k);
    if (!cur) out.set(k, { qty: round3(qty), unit });
    // A line in another unit cannot be added to the first; the first unit stands.
    else if (cur.unit === unit) cur.qty = round3(cur.qty + qty);
  }
  return out;
}

/**
 * The floor's Fresh Stock of an article against the job card's requirement for
 * it. `balance` < 0 means short by that much. null when the job card has no
 * requirement for the article (no indent line), so there is nothing to compare.
 */
export function coverage(stock: readonly FloorStockLike[], req: Requirement | undefined): Coverage | null {
  if (!req) return null;
  const byPieces = req.unit === "pcs";
  const available = round3(
    stock
      .filter((s) => s.stock_type === "Fresh Stock")
      .reduce((sum, s) => sum + (byPieces ? (s.available_quantity ?? 0) : s.available_kg), 0),
  );
  return { required: req.qty, available, unit: req.unit, balance: round3(available - req.qty) };
}

// ── Search and filters ────────────────────────────────────────────────────────
//
// For the "Other stock on this floor" list, which can run to a hundred lines. All
// rows are already in the browser, so this filters them in place — no request.

export type FloorStockFilter = { search?: string; type?: string; stockType?: string };

/**
 * Rows matching the search AND both filters, in their original order. The search
 * is split into words and EVERY word must appear — in any order, ignoring case —
 * in the item name, group or sub-group. An empty search or filter matches all.
 */
export function filterFloorStock<T extends FloorStockLike>(items: readonly T[], f: FloorStockFilter): T[] {
  const words = (f.search ?? "").trim().toUpperCase().split(/\s+/).filter(Boolean);
  const type = articleKey(f.type);
  const stockType = (f.stockType ?? "").trim();
  return items.filter((it) => {
    if (type && articleKey(it.item_type) !== type) return false;
    if (stockType && it.stock_type !== stockType) return false;
    if (words.length === 0) return true;
    // Joined with a space: a search word holds no spaces, so it can never match
    // across two fields.
    const text = [it.item_name, it.item_category, it.item_subcategory]
      .map((v) => (v ?? "").toUpperCase())
      .join(" ");
    return words.every((w) => text.includes(w));
  });
}

export type Page<T> = {
  rows: T[];
  /** The page actually shown — clamped into 1..pageCount. */
  page: number;
  pageCount: number;
  /** 1-based position of the first and last row shown; both 0 for an empty list. */
  from: number;
  to: number;
  total: number;
};

/**
 * One page of `items`. A page past the end is the last page, so a search that
 * shrinks the list never strands the reader on an empty page; below 1, or not a
 * number, is page 1. An empty list is one empty page.
 */
export function paginate<T>(items: readonly T[], page: number, pageSize: number): Page<T> {
  const total = items.length;
  const size = Math.max(1, Math.floor(pageSize) || 1);
  const pageCount = Math.max(1, Math.ceil(total / size));
  const current = Math.min(pageCount, Math.max(1, Math.floor(page) || 1));
  const start = (current - 1) * size;
  const rows = items.slice(start, start + size);
  return { rows, page: current, pageCount, from: total ? start + 1 : 0, to: start + rows.length, total };
}

/** The filter choices these rows actually offer: types upper-cased and sorted,
 *  Fresh Stock first among stock types. */
export function floorStockFilterOptions(items: readonly FloorStockLike[]): { types: string[]; stockTypes: string[] } {
  const types = new Set<string>();
  const stockTypes = new Set<string>();
  for (const it of items) {
    const t = articleKey(it.item_type);
    if (t) types.add(t);
    if (it.stock_type) stockTypes.add(it.stock_type);
  }
  return {
    types: [...types].sort(),
    stockTypes: [...stockTypes].sort((a, b) =>
      Number(b === "Fresh Stock") - Number(a === "Fresh Stock") || a.localeCompare(b)),
  };
}
