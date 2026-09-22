// Exercises lib/job-card-boxing. No test runner is configured in this project,
// so this runs directly on Node's native TypeScript stripping:
//
//     node src/lib/job-card-boxing.test.ts

import { boxingState, rollupBoxesByBatch, type BoxingBatch, type BoxingBatchRow } from "./job-card-boxing.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

const batch = (o: Partial<BoxingBatchRow> & { batch_id: number }): BoxingBatchRow => ({
  batch_number: null, status: "closed", produced_qty_kg: null, input_qty_kg: null, planned_qty_kg: null, ...o,
});
const entry = (o: Partial<BoxingBatch> & { batch_id: number | null }): BoxingBatch => ({
  boxes: 0, printed: 0, net_kg: 0, ...o,
});

// ── nothing to go on ──
check("no batches", boxingState([], []),
  { ready: false, reason: "No batches on this job card yet.", remainingKg: 0, unprinted: 0 });
check("only cancelled batches read as no batches",
  boxingState([batch({ batch_id: 81, batch_number: 1, status: "cancelled" })], []),
  { ready: false, reason: "No batches on this job card yet.", remainingKg: 0, unprinted: 0 });

// ── an open batch blocks first ──
check("an open batch is named by its batch number",
  boxingState([batch({ batch_id: 81, batch_number: 2, status: "open" })], []),
  { ready: false, reason: "Batch 2 is still open.", remainingKg: 0, unprinted: 0 });
check("a batch without a number is named by its id",
  boxingState([batch({ batch_id: 81, status: "open" })], []),
  { ready: false, reason: "Batch 81 is still open.", remainingKg: 0, unprinted: 0 });
check("an open batch wins over a closed batch's own problems",
  boxingState(
    [batch({ batch_id: 81, batch_number: 1, produced_qty_kg: 100 }), batch({ batch_id: 82, batch_number: 2, status: "open" })],
    [entry({ batch_id: 81, boxes: 1, printed: 1, net_kg: 100 })],
  ).reason, "Batch 2 is still open.");
check("a cancelled batch never blocks",
  boxingState(
    [batch({ batch_id: 81, batch_number: 1, produced_qty_kg: 10 }), batch({ batch_id: 82, batch_number: 2, status: "cancelled" })],
    [entry({ batch_id: 81, boxes: 2, printed: 2, net_kg: 10 })],
  ), { ready: true, reason: null, remainingKg: 0, unprinted: 0 });

// ── a closed batch with no accounted quantity ──
check("no cap at all",
  boxingState([batch({ batch_id: 81, batch_number: 1 })], [entry({ batch_id: 81, boxes: 1, printed: 1, net_kg: 5 })]),
  { ready: false, reason: "Batch 1 has no accounted quantity.", remainingKg: 0, unprinted: 0 });
check("a zero cap is no cap",
  boxingState([batch({ batch_id: 81, batch_number: 1, produced_qty_kg: 0, input_qty_kg: 0 })], []).reason,
  "Batch 1 has no accounted quantity.");
check("produced wins over input and planned",
  boxingState(
    [batch({ batch_id: 81, batch_number: 1, produced_qty_kg: 10, input_qty_kg: 900, planned_qty_kg: 900 })],
    [entry({ batch_id: 81, boxes: 1, printed: 1, net_kg: 10 })],
  ).ready, true);
check("input is used when produced is missing",
  boxingState(
    [batch({ batch_id: 81, batch_number: 1, input_qty_kg: 10, planned_qty_kg: 900 })],
    [entry({ batch_id: 81, boxes: 1, printed: 1, net_kg: 10 })],
  ).ready, true);
check("planned is the last resort",
  boxingState(
    [batch({ batch_id: 81, batch_number: 1, planned_qty_kg: 10 })],
    [entry({ batch_id: 81, boxes: 1, printed: 1, net_kg: 10 })],
  ).ready, true);

// ── material still to box ──
check("a short batch says how much is left",
  boxingState(
    [batch({ batch_id: 81, batch_number: 1, produced_qty_kg: 100 })],
    [entry({ batch_id: 81, boxes: 4, printed: 4, net_kg: 87.5 })],
  ),
  { ready: false, reason: "Batch 1 still has 12.5 kg to box.", remainingKg: 12.5, unprinted: 0 });
check("a batch with no boxes at all is short by its whole cap",
  boxingState([batch({ batch_id: 81, batch_number: 1, produced_qty_kg: 100 })], []).reason,
  "Batch 1 still has 100 kg to box.");
check("the shortfall trims trailing zeros",
  boxingState(
    [batch({ batch_id: 81, batch_number: 1, produced_qty_kg: 100 })],
    [entry({ batch_id: 81, boxes: 1, printed: 1, net_kg: 97.8755 })],
  ).reason, "Batch 1 still has 2.124 kg to box.");
check("within tolerance is not short",
  boxingState(
    [batch({ batch_id: 81, batch_number: 1, produced_qty_kg: 100 })],
    [entry({ batch_id: 81, boxes: 1, printed: 1, net_kg: 99.5 })],
  ), { ready: true, reason: null, remainingKg: 0.5, unprinted: 0 });
check("a caller can widen the tolerance",
  boxingState(
    [batch({ batch_id: 81, batch_number: 1, produced_qty_kg: 100 })],
    [entry({ batch_id: 81, boxes: 1, printed: 1, net_kg: 98 })],
    2,
  ).ready, true);
check("over-boxing is never short",
  boxingState(
    [batch({ batch_id: 81, batch_number: 1, produced_qty_kg: 100 })],
    [entry({ batch_id: 81, boxes: 1, printed: 1, net_kg: 104 })],
  ), { ready: true, reason: null, remainingKg: 0, unprinted: 0 });
check("one batch's surplus doesn't cover another's shortfall",
  boxingState(
    [batch({ batch_id: 81, batch_number: 1, produced_qty_kg: 100 }), batch({ batch_id: 82, batch_number: 2, produced_qty_kg: 100 })],
    [entry({ batch_id: 81, boxes: 1, printed: 1, net_kg: 130 }), entry({ batch_id: 82, boxes: 1, printed: 1, net_kg: 90 })],
  ),
  { ready: false, reason: "Batch 2 still has 10 kg to box.", remainingKg: 10, unprinted: 0 });
check("the earliest short batch is the one named",
  boxingState(
    [batch({ batch_id: 81, batch_number: 1, produced_qty_kg: 100 }), batch({ batch_id: 82, batch_number: 2, produced_qty_kg: 100 })],
    [entry({ batch_id: 81, boxes: 1, printed: 1, net_kg: 40 }), entry({ batch_id: 82, boxes: 1, printed: 1, net_kg: 50 })],
  ),
  { ready: false, reason: "Batch 1 still has 60 kg to box.", remainingKg: 110, unprinted: 0 });

// ── boxes still to print ──
check("unprinted boxes block",
  boxingState(
    [batch({ batch_id: 81, batch_number: 1, produced_qty_kg: 100 })],
    [entry({ batch_id: 81, boxes: 5, printed: 2, net_kg: 100 })],
  ),
  { ready: false, reason: "3 boxes are not printed yet.", remainingKg: 0, unprinted: 3 });
check("one unprinted box reads singular",
  boxingState(
    [batch({ batch_id: 81, batch_number: 1, produced_qty_kg: 100 })],
    [entry({ batch_id: 81, boxes: 5, printed: 4, net_kg: 100 })],
  ).reason, "1 box is not printed yet.");
check("an unlinked box counts too",
  boxingState(
    [batch({ batch_id: 81, batch_number: 1, produced_qty_kg: 100 })],
    [entry({ batch_id: 81, boxes: 5, printed: 5, net_kg: 100 }), entry({ batch_id: null, boxes: 1, printed: 0, net_kg: 3 })],
  ),
  { ready: false, reason: "1 box is not printed yet.", remainingKg: 0, unprinted: 1 });
check("a cancelled batch's boxes are not counted",
  boxingState(
    [batch({ batch_id: 81, batch_number: 1, produced_qty_kg: 100 }), batch({ batch_id: 82, batch_number: 2, status: "cancelled" })],
    [entry({ batch_id: 81, boxes: 5, printed: 5, net_kg: 100 }), entry({ batch_id: 82, boxes: 2, printed: 0, net_kg: 9 })],
  ), { ready: true, reason: null, remainingKg: 0, unprinted: 0 });

// ── nothing printed at all ──
check("a closed, fully-boxed batch with no box rows",
  boxingState([batch({ batch_id: 81, batch_number: 1, produced_qty_kg: 0.2 })], []),
  { ready: false, reason: "No boxes have been printed yet.", remainingKg: 0.2, unprinted: 0 });

// ── ready ──
check("everything boxed and printed",
  boxingState(
    [batch({ batch_id: 81, batch_number: 1, produced_qty_kg: 60 }), batch({ batch_id: 82, batch_number: 2, produced_qty_kg: 40 })],
    [entry({ batch_id: 81, boxes: 3, printed: 3, net_kg: 60 }), entry({ batch_id: 82, boxes: 2, printed: 2, net_kg: 40.25 })],
  ), { ready: true, reason: null, remainingKg: 0, unprinted: 0 });

// ── what `printed` means, as the server counts it ──
// sfg_box_service._is_printed counts every box past PENDING, cancelled ones
// aside — so a box the next stage has already scanned in (status RECEIVED)
// still counts as printed. Were it to count only status 'PRINTED', printed
// would fall below boxes as the output moved downstream and this job card
// could never be offered as completed: its boxes are no longer editable, so
// nothing could ever print them again.
check("a box the next stage has received is still printed",
  boxingState(
    [batch({ batch_id: 81, batch_number: 1, produced_qty_kg: 100 })],
    [entry({ batch_id: 81, boxes: 5, printed: 5, net_kg: 100 })],
  ), { ready: true, reason: null, remainingKg: 0, unprinted: 0 });
check("and the two sides count it the same way",
  rollupBoxesByBatch([
    { batch_id: 81, net_weight: 20, status: "RECEIVED" },
    { batch_id: 81, net_weight: 20, status: "PRINTED" },
  ]),
  [{ batch_id: 81, boxes: 2, printed: 2, net_kg: 40 }]);

// ── the fallback rollup, for a server that sends no by_batch ──
check("boxes group by batch, printed counts everything past pending",
  rollupBoxesByBatch([
    { batch_id: 81, net_weight: 10.5, status: "PRINTED" },
    { batch_id: 81, net_weight: "4.25", status: "PENDING" },
    { batch_id: 81, net_weight: 5, status: "CONSUMED" },
    { batch_id: 82, net_weight: 3, status: "pending" },
    { batch_id: null, net_weight: 2, status: "DISPATCHED" },
  ]),
  [
    { batch_id: 81, boxes: 3, printed: 2, net_kg: 19.75 },
    { batch_id: 82, boxes: 1, printed: 0, net_kg: 3 },
    { batch_id: null, boxes: 1, printed: 1, net_kg: 2 },
  ]);
check("a cancelled box is neither boxed nor waiting to print",
  rollupBoxesByBatch([
    { batch_id: 81, net_weight: 10, status: "PRINTED" },
    { batch_id: 81, net_weight: 9, status: "CANCELLED" },
  ]),
  [{ batch_id: 81, boxes: 1, printed: 1, net_kg: 10 }]);
check("a missing batch and a missing weight",
  rollupBoxesByBatch([{ net_weight: null, status: "PRINTED" }]),
  [{ batch_id: null, boxes: 1, printed: 1, net_kg: 0 }]);
check("nothing in, nothing out", rollupBoxesByBatch([]), []);

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("job-card-boxing: all checks passed");
