// "Select all articles" for one SO row on the SO Creation list. Pure helpers so
// the rules can be tested without a browser (selectAll.test.ts); the page wires
// them to the plan-builder.

export type SelectAllState = "none" | "some" | "all";

export type SelectAllClick =
  | { action: "add"; ids: number[] }
  | { action: "clear"; ids: number[] };

/** The SO's articles that can be selected: lines carrying a so_line_id (the
 *  fulfillment lookup is keyed on it), each once, in line order. */
export function selectableLineIds(lines: { so_line_id?: number | null }[]): number[] {
  const ids: number[] = [];
  for (const l of lines) {
    if (l.so_line_id != null && !ids.includes(l.so_line_id)) ids.push(l.so_line_id);
  }
  return ids;
}

/** How much of this SO is in the page-wide selection. */
export function selectAllState(ids: number[], selected: Set<number>): SelectAllState {
  const picked = ids.filter((id) => selected.has(id)).length;
  if (picked === 0) return "none";
  return picked === ids.length ? "all" : "some";
}

/** A click clears this SO when all of it is selected; otherwise it adds only
 *  the articles not yet selected, so ticked ones are not looked up again. */
export function selectAllClick(ids: number[], selected: Set<number>): SelectAllClick {
  if (ids.length > 0 && selectAllState(ids, selected) === "all") return { action: "clear", ids };
  return { action: "add", ids: ids.filter((id) => !selected.has(id)) };
}

/** One fulfillment row per article from a batched lookup — the first, as the
 *  single-article checkbox takes results[0]. */
export function firstRowPerLine<T extends { so_line_id?: number | null }>(rows: T[]): Map<number, T> {
  const out = new Map<number, T>();
  for (const r of rows) {
    if (r.so_line_id != null && !out.has(r.so_line_id)) out.set(r.so_line_id, r);
  }
  return out;
}
