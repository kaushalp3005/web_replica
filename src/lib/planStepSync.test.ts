// node src/lib/planStepSync.test.ts
import { jobCardRoute, planStepChanges, rowsFromSteps } from "./planStepSync.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

// A line's saved steps become editor rows in step order, keeping each step's id.
const saved = [
  { step_id: 12, step_order: 2, process_name: "Packing", floor: "FG store" },
  { step_id: 11, step_order: 1, process_name: "Create WIP: Roasting", floor: null },
];
check("rows in step order with their ids", rowsFromSteps(saved), [
  { process: "Create WIP: Roasting", floor: "", stepId: 11 },
  { process: "Packing", floor: "FG store", stepId: 12 },
]);
check("a step with no name falls back to its stage",
      rowsFromSteps([{ step_id: 1, step_order: 1, process_name: null, stage: "roasting" }]),
      [{ process: "roasting", floor: "", stepId: 1 }]);
check("no steps", rowsFromSteps(undefined), []);

const ordered = [
  { step_id: 11, process_name: "Create WIP: Roasting", floor: null },
  { step_id: 12, process_name: "Packing", floor: "FG store" },
];
const none = { deletes: [], patches: [], adds: [], reorder: false };

check("nothing changed", planStepChanges(ordered, rowsFromSteps(ordered)), none);

// Picking a floor (or a new process) patches just that step; a cleared floor is
// sent as null; process names are compared trimmed.
check("floor picked", planStepChanges(ordered, [
  { process: "Create WIP: Roasting", floor: "Roasting Area", stepId: 11 },
  { process: "Packing ", floor: "FG store", stepId: 12 },
]), { ...none, patches: [{ stepId: 11, floor: "Roasting Area" }] });
check("process changed, floor cleared", planStepChanges(ordered, [
  { process: "Roasting", floor: "", stepId: 11 },
  { process: "Packing", floor: "", stepId: 12 },
]), { ...none, patches: [{ stepId: 11, process_name: "Roasting" }, { stepId: 12, floor: null }] });

// A process added before the last (packaging) row is appended by the server,
// so the line is reordered afterwards.
check("added in the middle", planStepChanges(ordered, [
  { process: "Create WIP: Roasting", floor: "", stepId: 11 },
  { process: "Sorting", floor: "Sorting Area" },
  { process: "Packing", floor: "FG store", stepId: 12 },
]), { ...none, adds: [1], reorder: true });
check("added at the end needs no reorder", planStepChanges(ordered, [
  { process: "Create WIP: Roasting", floor: "", stepId: 11 },
  { process: "Packing", floor: "FG store", stepId: 12 },
  { process: "Labelling", floor: "" },
]), { ...none, adds: [2] });

check("removed", planStepChanges(ordered, [
  { process: "Packing", floor: "FG store", stepId: 12 },
]), { ...none, deletes: [11] });
check("moved", planStepChanges(ordered, [
  { process: "Packing", floor: "FG store", stepId: 12 },
  { process: "Create WIP: Roasting", floor: "", stepId: 11 },
]), { ...none, reorder: true });

// Merging two rows gives one new row (no id): both old steps go, one is added.
check("merged", planStepChanges(ordered, [
  { process: "Create WIP: Roasting + Packing", floor: "FG store" },
]), { ...none, deletes: [11, 12], adds: [0] });

// A row whose id isn't one of the line's steps (or repeats one) is treated as new.
check("unknown or repeated id is new", planStepChanges(ordered, [
  { process: "Create WIP: Roasting", floor: "", stepId: 11 },
  { process: "Packing", floor: "FG store", stepId: 11 },
  { process: "X", floor: "", stepId: 99 },
]), { deletes: [12], patches: [], adds: [1, 2], reorder: false });

// Create Job Card reads a one-step route as that process then Packaging on the
// same floor; the picker shows a one-step route the same way.
check("one step gets packaging after it",
      jobCardRoute([{ process: "Sorting", floor: "Sorting Area", stepId: 5 }]),
      [{ process: "Sorting", floor: "Sorting Area", stepId: 5 }, { process: "Packaging", floor: "Sorting Area" }]);
check("two or more steps unchanged", jobCardRoute(rowsFromSteps(ordered)), rowsFromSteps(ordered));
check("no steps unchanged", jobCardRoute([]), []);

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("planStepSync: all checks passed");
