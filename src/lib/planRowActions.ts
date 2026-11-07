// Pure rules behind a plan's actions (Create / Edit Job Card and the job-card
// wizard's article options). Shared by the Plan List page and the SO Creation
// "Plans created" panel; tested without a browser (planRowActions.test.ts).

import type { PlanRow, PlanRowLineSummary } from "./plans.ts";

// Canonical line identity for the Create-Job-Card flow. A plan line SHOULD
// carry a plan_line_id, but the summary type allows null/undefined; when it's
// missing we fall back to the row's array index. Every site (initial radio
// selection, the selectedLine lookup, the radio key, AND the parent's
// onContinue lookup) MUST use this same scheme — mixing `?? 0` / `?? i` /
// `?? null` resolves the wrong (or no) line when plan_line_id is absent.
export function getLineId(line: PlanRowLineSummary, index: number): number {
  return line.plan_line_id ?? index;
}

export function numOr0(v: number | string | null | undefined): number {
  if (v == null || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Round to 3 dp (matches production_plan_line_v2's numeric(,3)) so a summed
// merged quantity doesn't carry binary-float noise like 450.79999999.
export const round3 = (n: number): number => Math.round(n * 1000) / 1000;

// A step-1 article option. UN-CARDED lines with the SAME (SKU, BOM) collapse into
// ONE option carrying the COMBINED qty and every line id, so the create call can
// fold the siblings into one job-card chain server-side (both SO numbers ride
// along). Carded lines — and lines with no plan_line_id — stay individual.
export type ArticleOption = {
  id: number;           // selection id = primary (first) line's plan_line_id
  fgSkuName: string;
  kg: number;           // combined planned qty
  units: number;
  carded: boolean;
  remainingKg: number;  // kg still un-carded on this line (= kg for a fresh option)
  memberIds: number[];  // all plan_line_ids folded here (length > 1 => merged)
  count: number;        // # of lines/SOs merged
};

export function buildArticleOptions(lines: PlanRowLineSummary[]): ArticleOption[] {
  const opts: ArticleOption[] = [];
  const seen = new Set<string>();
  const mergeKey = (l: PlanRowLineSummary) =>
    `${(l.fg_sku_name ?? "").trim().toLowerCase()} ${l.bom_id ?? ""}`;
  lines.forEach((l, i) => {
    const carded = (l.job_card_count ?? 0) > 0;
    // Only un-carded lines that carry a real plan_line_id can be merged.
    if (carded || l.plan_line_id == null) {
      opts.push({
        id: getLineId(l, i), fgSkuName: l.fg_sku_name ?? "",
        kg: numOr0(l.planned_qty_kg), units: numOr0(l.planned_qty_units),
        carded,
        remainingKg: round3(Math.max(0, numOr0(l.planned_qty_kg) - numOr0(l.carded_qty_kg))),
        memberIds: [getLineId(l, i)], count: 1,
      });
      return;
    }
    const key = mergeKey(l);
    if (seen.has(key)) return;   // already emitted this SKU+BOM group
    seen.add(key);
    const grp = lines.filter(
      (x) => (x.job_card_count ?? 0) === 0 && x.plan_line_id != null && mergeKey(x) === key,
    );
    const grpKg = round3(grp.reduce((s, g) => s + numOr0(g.planned_qty_kg), 0));
    opts.push({
      id: grp[0].plan_line_id as number,
      fgSkuName: grp[0].fg_sku_name ?? "",
      kg: grpKg,
      units: round3(grp.reduce((s, g) => s + numOr0(g.planned_qty_units), 0)),
      carded: false,
      remainingKg: grpKg,   // fresh/merged option — nothing carded yet
      memberIds: grp.map((g) => g.plan_line_id as number),
      count: grp.length,
    });
  });
  return opts;
}

/** Which job-card buttons a plan row shows. anyCarded → this plan has ≥1 carded
 *  line (show Edit). anyRemaining → some line still has balance to card, incl.
 *  any un-carded line (show Create). A partially-carded plan shows BOTH buttons
 *  side by side. */
export function planRowFlags(row: Pick<PlanRow, "lines_summary">): { anyCarded: boolean; anyRemaining: boolean } {
  const lines = row.lines_summary ?? [];
  const anyCarded = lines.some((l) => (l.job_card_count ?? 0) > 0);
  const anyRemaining = lines.some(
    (l) => (l.job_card_count ?? 0) === 0
      || numOr0(l.planned_qty_kg) - numOr0(l.carded_qty_kg) > 0.001,
  );
  return { anyCarded, anyRemaining };
}
