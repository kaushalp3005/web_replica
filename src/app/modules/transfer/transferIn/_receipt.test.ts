// Exercises the receive page's receipt matching (_receipt). No test runner is configured in
// this project, so this runs directly on Node's native TypeScript stripping:
//
//     node src/app/modules/transfer/transferIn/_receipt.test.ts

import { acknowledgedEntries, acknowledges, conflictedKeys, sharesBoxId, type ReceiptEntry } from "./_receipt.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

// Two boxes of one transfer share box id B-7 under two transactions (P2-13); a third box,
// and two entries expanded from a line (no box row, no transaction).
const E: ReceiptEntry[] = [
  { key: "11", box_id: "B-7", transaction_no: "TR-1", out_box_id: 11 },
  { key: "12", box_id: "B-7", transaction_no: "TR-2", out_box_id: 12 },
  { key: "13", box_id: "B-9", transaction_no: "TR-1", out_box_id: 13 },
  { key: "L5-1", box_id: "LINE-5-1", transaction_no: "", out_box_id: null },
  { key: "L5-2", box_id: "LINE-5-2", transaction_no: "", out_box_id: null },
];
const keys = (rows: Parameters<typeof acknowledgedEntries>[1]) => [...acknowledgedEntries(E, rows).keys()];

// ── one box of two sharing a box id ──
check("the row naming its box row acknowledges that box only",
  keys([{ box_id: "B-7", transaction_no: "TR-1", transfer_out_box_id: 11 }]), ["11"]);
check("by box id and transaction: the other box of the same box id is not acknowledged",
  keys([{ box_id: "B-7", transaction_no: "TR-2" }]), ["12"]);
check("both boxes acknowledged: both entries", keys([
  { box_id: "B-7", transaction_no: "TR-1", transfer_out_box_id: 11 },
  { box_id: "B-7", transaction_no: "TR-2", transfer_out_box_id: 12 },
]), ["11", "12"]);
check("a row naming the twin's box row does not acknowledge this one",
  acknowledges({ box_id: "B-7", transaction_no: "TR-2", transfer_out_box_id: 12 }, E[0]), false);
check("a row naming a box row acknowledges it whatever box id it was scanned under",
  keys([{ box_id: "B-900", transaction_no: "TR-9", transfer_out_box_id: 13 }]), ["13"]);

// ── the server's other matches ──
check("a row without a transaction acknowledges by box id (every box of that id)",
  keys([{ box_id: "B-7", transaction_no: "" }]), ["11", "12"]);
check("trimmed on both sides", keys([{ box_id: " B-9 ", transaction_no: " TR-1 " }]), ["13"]);
check("IMS's original box id (a swapped box) with the transaction",
  keys([{ box_id: "B-900", original_box_id: "B-9", transaction_no: "TR-1" }]), ["13"]);
check("another transaction under the same box id is another box",
  keys([{ box_id: "B-9", transaction_no: "TR-5" }]), []);
check("a box that is not on the transfer acknowledges nothing", keys([{ box_id: "X-1", transaction_no: "TR-1" }]), []);
check("line entries by their synthetic box id", keys([{ box_id: "LINE-5-2", transaction_no: null }]), ["L5-2"]);
check("no rows, nothing acknowledged", keys([]), []);
check("the row is kept with its entry (issues are read from it)",
  acknowledgedEntries(E, [{ box_id: "B-9", transaction_no: "TR-1", transfer_out_box_id: 13 }]).get("13")?.transfer_out_box_id, 13);

// ── acknowledge-all conflicts and un-acknowledge ──
check("a batch conflict names one box of the two", [...conflictedKeys(E, [{ box_id: "B-7", transaction_no: " TR-2" }])], ["12"]);
check("no conflicts", [...conflictedKeys(E, [])], []);
check("B-7 is shared, B-9 and line entries are not", E.map((e) => sharesBoxId(E, e)), [true, true, false, false, false]);

if (failures) { console.error(`${failures} failed`); process.exit(1); }
console.log("receipt matching: all checks passed");
