// node src/lib/createdPlans.test.ts
import { floorsLabel, planTotals, stepsText } from "./createdPlans.ts";

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

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("createdPlans: all checks passed");
