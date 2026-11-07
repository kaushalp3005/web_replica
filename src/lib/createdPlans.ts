// Display rules for the "Plans created" table that replaces the selection after
// Create Plan. Pure, so they can be tested without a browser (createdPlans.test.ts).

import type { PlanDetail, PlanRow } from "./plans.ts";

type StepLike = {
  step_order?: number | null;
  process_name?: string | null;
  stage?: string | null;
  floor?: string | null;
};

/** A plan line's process route in step order: "Sorting → Roasting → Packaging". */
export function stepsText(steps: StepLike[] | null | undefined): string {
  const names = [...(steps ?? [])]
    .sort((a, b) => (a.step_order ?? Infinity) - (b.step_order ?? Infinity))
    .map((s) => (s.process_name || s.stage || "").trim())
    .filter(Boolean);
  return names.length ? names.join(" → ") : "—";
}

type Qty = number | string | null | undefined;

function num(v: Qty): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/** A plan's total volume (kg) and units. GET /plans-v2/{id} returns the plan
 *  header without the list endpoint's totals, so they are summed from its lines;
 *  totals already on the row (from the list endpoint) are used as they are. */
export function planTotals(plan: {
  total_planned_kg?: Qty;
  total_planned_units?: Qty;
  lines?: { planned_qty_kg?: Qty; planned_qty_units?: Qty }[] | null;
}): { kg: number; units: number } {
  const lines = plan.lines ?? [];
  const kg = plan.total_planned_kg != null && plan.total_planned_kg !== ""
    ? num(plan.total_planned_kg)
    : lines.reduce((s, l) => s + num(l.planned_qty_kg), 0);
  const units = plan.total_planned_units != null && plan.total_planned_units !== ""
    ? num(plan.total_planned_units)
    : lines.reduce((s, l) => s + num(l.planned_qty_units), 0);
  return { kg, units };
}

/** How many of a line's steps have a floor: "2/3 floors" ("" with no steps). */
export function floorsLabel(steps: StepLike[] | null | undefined): string {
  const all = steps ?? [];
  if (all.length === 0) return "";
  return `${all.filter((s) => !!s.floor).length}/${all.length} floors`;
}

/** The Plan List row for exactly this plan. The list endpoint has no plan-id
 *  filter, so the row is fetched with search=<id>, which also matches plans whose
 *  id merely contains those digits (and warehouse / article / customer text). */
export function pickPlanRow(results: PlanRow[] | null | undefined, id: number): PlanRow | null {
  return (results ?? []).find((r) => Number(r.plan_id) === id) ?? null;
}

function idOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** A Plan List-shaped row built from GET /plans-v2/{id}, for when the plan's
 *  list row can't be loaded, so its actions still work: lines_summary comes from
 *  the plan's lines (the detail has no carded_qty_kg, so it's left out) and
 *  line_count from how many lines there are. */
export function planRowFromDetail(detail: PlanDetail): PlanRow {
  const { lines, ...header } = detail;
  const all = lines ?? [];
  return {
    ...header,
    line_count: header.line_count ?? all.length,
    lines_summary: all.map((l) => ({
      plan_line_id: l.plan_line_id ?? null,
      bom_id: idOrNull(l.bom_id),
      fg_sku_name: l.fg_sku_name ?? null,
      customer_name: l.customer_name ?? null,
      planned_qty_kg: l.planned_qty_kg ?? null,
      planned_qty_units: l.planned_qty_units ?? null,
      area: l.area ?? null,
      job_card_count: l.job_card_count ?? null,
    })),
  };
}
