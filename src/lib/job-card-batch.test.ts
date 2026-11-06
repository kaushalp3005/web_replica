// node src/lib/job-card-batch.test.ts
import { cancelBatchConfirm, cancelBatchOffered, openBatchConfirm, openBatchOffered } from "./job-card-batch.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

// A card being worked: anyone with overview › start.
check("assigned", openBatchOffered("assigned", false), true);
check("material received", openBatchOffered("material_received", false), true);
check("in progress", openBatchOffered("in_progress", false), true);

// Not before it is assigned.
check("locked", openBatchOffered("locked", false), false);
check("unlocked", openBatchOffered("unlocked", true), false);
check("no status", openBatchOffered(null, true), false);

// A completed card: only an admin, for a missed batch.
check("completed, not an admin", openBatchOffered("completed", false), false);
check("completed, admin", openBatchOffered("completed", true), true);

// Closed or cancelled: never, the server always refuses.
check("closed", openBatchOffered("closed", false), false);
check("closed, admin", openBatchOffered("closed", true), false);
check("cancelled, admin", openBatchOffered("cancelled", true), false);

// The Open Batch confirm: on a completed card (an admin's missed batch) it says
// that Close JC now waits for this batch.
check("confirm, running card", openBatchConfirm("in_progress", ""), "Open a new batch?");
check("confirm, named", openBatchConfirm("assigned", "Lot 7"), 'Open a new batch named "Lot 7"?');
check("confirm, completed card", openBatchConfirm("completed", ""),
  "Open a new batch on this completed job card?\n\n"
  + "Close JC will wait until this batch is completed or cancelled.");
check("confirm, completed card, named", openBatchConfirm("completed", "Lot 7"),
  'Open a new batch named "Lot 7" on this completed job card?\n\n'
  + "Close JC will wait until this batch is completed or cancelled.");

// Cancel batch: an open batch with no output saved on it (the server cancels
// only an empty one). The caller also needs overview › close.
const empty = { status: "open", produced_qty_kg: null, fg_actual_kg: null };
check("open, empty", cancelBatchOffered(empty), true);
check("open, produced saved", cancelBatchOffered({ ...empty, produced_qty_kg: "0.000" }), false);
check("open, FG kg saved", cancelBatchOffered({ ...empty, fg_actual_kg: 12 }), false);
check("open, an output row on it", cancelBatchOffered(empty, { hasOutputRows: true }), false);
check("open, boxes printed for it", cancelBatchOffered(empty, { boxes: 3 }), false);
check("open, no boxes", cancelBatchOffered(empty, { boxes: 0 }), true);
check("closed", cancelBatchOffered({ ...empty, status: "closed" }), false);
check("cancelled", cancelBatchOffered({ ...empty, status: "cancelled" }), false);
check("older row, figures absent", cancelBatchOffered({ status: "open" }), true);
check("cancel confirm", cancelBatchConfirm("Lot 7"),
  'Cancel batch "Lot 7"? It has no output, so nothing else changes. This can\'t be undone.');

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("job-card-batch: all checks passed");
