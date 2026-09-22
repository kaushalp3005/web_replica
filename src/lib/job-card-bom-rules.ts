// Per-job-card BOM changes — the pure half (no React / Next imports, so it runs
// under plain Node for its tests). The server applies the changes to the job
// card's bom_lines (server_replica jc_bom_changes.py); this file only reads the
// `bom_changes` block that comes with them. Spec:
// server_replica/docs/superpowers/specs/2026-09-21-job-card-bom-changes-design.md

import { articleKey, freshFirst, type FloorStockLike, type IndentLike } from "./floorStock.ts";

/** An added FG / SFG article is RM for accounting (its bom_line says item_type
 *  'rm', article_type 'fg'/'sfg'); bom_changes carries the real type. */
export type BomItemType = "rm" | "pm" | "fg" | "sfg";

type BomChangeBase = {
  change_id: number;
  material_sku_name: string;
  item_type: BomItemType;
  note: string | null;
  changed_by: string;
  changed_at: string;
  made_on_job_card_number: string;
};

export type RemovedBomChange = BomChangeBase & {
  /** The article is no longer on the BOM module's list for this job card. */
  not_on_bom: boolean;
};

export type AddedBomChange = BomChangeBase & {
  sku_id: number;
  required_qty: number | null;
  required_unit: "kg" | "pcs" | null;
  /** The BOM module's list has since gained this article; the add no longer shows. */
  superseded: boolean;
};

export type BomChanges = {
  /** The job card's first stage card — the changes cover every stage of its chain. */
  scope_job_card_id: number;
  removed: RemovedBomChange[];
  added: AddedBomChange[];
};

/** Whether the server has applied changes to bom_lines. When it has, an empty
 *  bom_lines is really empty (everything removed) — never fall back to indents. */
export function hasBomChanges(c: BomChanges | null | undefined): boolean {
  return !!c && (c.removed.length > 0 || c.added.length > 0);
}

/** The lines requirementsByArticle reads: the indent lines, minus those an added
 *  article's required qty overrides, plus each added article's required qty. An
 *  added figure REPLACES an indent figure (requirementsByArticle would sum them). */
export function requirementIndents(
  indents: readonly IndentLike[],
  changes: BomChanges | null | undefined,
): IndentLike[] {
  const added = (changes?.added ?? []).filter((a) => !a.superseded && a.required_qty != null && a.required_qty > 0);
  if (added.length === 0) return [...indents];
  const keys = new Set(added.map((a) => articleKey(a.material_sku_name)));
  const out: IndentLike[] = indents.filter((i) => !keys.has(articleKey(i.material_sku_name)));
  for (const a of added) {
    out.push({
      material_sku_name: a.material_sku_name,
      item_type: a.item_type.toUpperCase(),
      uom: a.required_unit === "pcs" ? "PCS" : "KGS",
      gross_qty: a.required_qty,
      reqd_qty: a.required_qty,
    });
  }
  return out;
}

/** Only RM and PM BOM-module lines can be removed; SFG is the seam a later stage
 *  consumes. An added article of any type can be removed (undo add). */
export function isRemovableType(itemType: string | null | undefined): boolean {
  const t = (itemType ?? "").trim().toUpperCase();
  return t === "RM" || t === "PM";
}

/** An added article's required-qty unit. */
export function bomUnit(itemType: string | null | undefined): "kg" | "pcs" {
  return (itemType ?? "").trim().toUpperCase() === "PM" ? "pcs" : "kg";
}

/** Whether adding `name` restores it: it was removed from this job card and the
 *  BOM module still lists it. The server then only undoes the removal — a
 *  required qty or note sent with it is not kept. A removal the BOM module has
 *  since dropped (not_on_bom) is added afresh instead. */
export function restoresRemoved(changes: BomChanges | null | undefined, name: string): boolean {
  const key = articleKey(name);
  return !!key && (changes?.removed ?? []).some((r) => !r.not_on_bom && articleKey(r.material_sku_name) === key);
}

/** Types that can be added to a job card (+ Add article, Use on other stock). */
export function isUsableType(itemType: string | null | undefined): boolean {
  const t = (itemType ?? "").trim().toUpperCase();
  return t === "RM" || t === "PM" || t === "FG" || t === "SFG";
}

const KG = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const PCS = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

/** An article's stock on this floor, for the Add dialog. `items` null = not loaded.
 *  Pieces show only on PM rows, as on the tab (stock-take units on other lines
 *  are unreliable), and only when they round to a whole piece. */
export function stockOnFloor(
  items: readonly FloorStockLike[] | null | undefined,
  name: string,
  place: string,
): string {
  if (items == null) return "Floor stock not loaded";
  const key = articleKey(name);
  const rows = items.filter((it) => articleKey(it.item_name) === key).sort(freshFirst);
  if (rows.length === 0) return `None on ${place}`;
  return `On ${place}: ` + rows.map((r) => {
    const pcs = bomUnit(r.item_type) === "pcs" ? Math.round(r.available_quantity ?? 0) : 0;
    return `${r.stock_type} ${KG.format(r.available_kg)} kg${pcs !== 0 ? ` (${PCS.format(pcs)} pcs)` : ""}`;
  }).join(" · ");
}
