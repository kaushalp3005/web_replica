// node src/lib/plan-steps-lock.test.ts
import { STEPS_LOCKED_FALLBACK, stepsLockOf, stepsLockRefusal } from "./plan-steps-lock.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

const chains = "This article was carded in 2 separate chains, so its steps can't be added, moved or removed here.";
const run = "This article's job cards are part of a merged process run shared with other products.";

// What the server sent for the line.
check("steps may change", stepsLockOf({ steps_locked: null }), null);
check("older server: no field", stepsLockOf({}), null);
check("no line", stepsLockOf(undefined), null);
check("several chains", stepsLockOf({ steps_locked: { reason: "multiple_chains", message: chains } }),
  { reason: "multiple_chains", message: chains });
check("merged run", stepsLockOf({ steps_locked: { reason: "merged_run", message: ` ${run} ` } }),
  { reason: "merged_run", message: run });
check("locked without a sentence", stepsLockOf({ steps_locked: { reason: "merged_run" } }),
  { reason: "merged_run", message: STEPS_LOCKED_FALLBACK });
check("locked, some other shape", stepsLockOf({ steps_locked: true }), { reason: "", message: STEPS_LOCKED_FALLBACK });
check("false is not locked", stepsLockOf({ steps_locked: false }), null);

// Save: refused before anything is sent when it adds, moves or removes a step.
const lock = { reason: "multiple_chains", message: chains };
const none = { deletes: 0, orderChanged: false, newSteps: 0 };
check("step fields only", stepsLockRefusal(lock, none), null);
check("a step removed (merge)", stepsLockRefusal(lock, { ...none, deletes: 1 }), chains);
check("steps moved", stepsLockRefusal(lock, { ...none, orderChanged: true }), chains);
check("a step added", stepsLockRefusal(lock, { ...none, newSteps: 2 }), chains);
check("not locked", stepsLockRefusal(null, { deletes: 1, orderChanged: true, newSteps: 1 }), null);

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("plan-steps-lock: all checks passed");
