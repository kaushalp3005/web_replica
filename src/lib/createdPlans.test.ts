// node src/lib/createdPlans.test.ts
import { floorsLabel, pickPlanRow, planRowFromDetail, planTotals, stepsText } from "./createdPlans.ts";
import { planRowFlags } from "./planRowActions.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

// A plan line's process route, in step order.
const steps = [
  { step_order: 3, process_name: "Packaging", floor: "Packing Floor" },
  { step_order: 1, process_name: "Sorting", floor: "Sorting Area" },
  { step_order: 2, process_name: null, stage: "Roasting", floor: null },
];
check("processes in step order", stepsText(steps), "Sorting → Roasting → Packaging");
check("no steps", stepsText([]), "—");
check("missing list", stepsText(undefined), "—");
check("a step with no name", stepsText([{ step_order: 1 }]), "—");

// How many of those steps already have a floor.
check("floors set", floorsLabel(steps), "2/3 floors");
check("no steps, nothing to say", floorsLabel([]), "");
check("all set", floorsLabel([{ floor: "A" }, { floor: "B" }]), "2/2 floors");

// A plan's volume and units. GET /plans-v2/{id} returns the plan header without
// the list endpoint's totals, so they are added up from its lines (which come
// back as numbers or numeric strings).
const detail = { lines: [
  { planned_qty_kg: "1100.000", planned_qty_units: 100000 },
  { planned_qty_kg: 2.5, planned_qty_units: "300" },
  { planned_qty_kg: null, planned_qty_units: null },
] };
check("summed from the lines", planTotals(detail), { kg: 1102.5, units: 100300 });
check("the list endpoint's totals win when present",
      planTotals({ ...detail, total_planned_kg: "999", total_planned_units: 5 }), { kg: 999, units: 5 });
check("no lines", planTotals({ lines: [] }), { kg: 0, units: 0 });
check("no line list at all", planTotals({}), { kg: 0, units: 0 });

// A new plan's Plan List row is fetched with search=<id>, which also returns
// plans whose id merely contains those digits — only the exact id counts.
const searched = [
  { plan_id: 381449201, plan_name: "Longer id" },
  { plan_id: 38144920, plan_name: "This plan" },
  { plan_id: 138144920, plan_name: "Prefixed id" },
];
check("the exact plan among near matches", pickPlanRow(searched, 38144920)?.plan_name, "This plan");
check("a near match is not the plan", pickPlanRow(searched, 3814492), null);
check("no results", pickPlanRow([], 38144920), null);
check("no result list at all", pickPlanRow(undefined, 38144920), null);

// When the list row can't be loaded, the plan detail stands in for it so the
// row's buttons still work: its lines become lines_summary (no carded_qty_kg in
// the detail) and line_count is how many lines it has.
const planDetail = {
  plan_id: 42,
  plan_name: "W202 daily",
  warehouse: "W-202",
  status: "draft",
  lines: [
    {
      plan_line_id: 7, plan_id: 42, fg_sku_name: "Chia Seeds 1kg", customer_name: "Acme",
      planned_qty_kg: "100.000", planned_qty_units: 10, area: "Roasting", deadline_date: "2026-10-10",
      job_card_count: 0, bom_id: 3, steps: [{ step_order: 1, process_name: "Sorting" }],
    },
    { plan_line_id: 8, fg_sku_name: "Flax 500g", planned_qty_kg: 20, bom_id: "5" },
  ],
};
check("a list row built from the detail", planRowFromDetail(planDetail), {
  plan_id: 42,
  plan_name: "W202 daily",
  warehouse: "W-202",
  status: "draft",
  line_count: 2,
  lines_summary: [
    {
      plan_line_id: 7, bom_id: 3, fg_sku_name: "Chia Seeds 1kg", customer_name: "Acme",
      planned_qty_kg: "100.000", planned_qty_units: 10, area: "Roasting", job_card_count: 0,
    },
    {
      plan_line_id: 8, bom_id: 5, fg_sku_name: "Flax 500g", customer_name: null,
      planned_qty_kg: 20, planned_qty_units: null, area: null, job_card_count: null,
    },
  ],
});
check("a line count already on the detail is kept",
      planRowFromDetail({ plan_id: 1, line_count: 9, lines: [] }).line_count, 9);
check("a detail with no line list", planRowFromDetail({ plan_id: 1 }),
      { plan_id: 1, line_count: 0, lines_summary: [] });
check("a fresh plan built from its detail still offers Create Job Card",
      planRowFlags(planRowFromDetail(planDetail)), { anyCarded: false, anyRemaining: true });

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("createdPlans: all checks passed");
