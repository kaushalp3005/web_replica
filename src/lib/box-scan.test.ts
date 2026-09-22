// Exercises lib/box-scan. No test runner is configured in this project, so this
// runs directly on Node's native TypeScript stripping:
//
//     node src/lib/box-scan.test.ts

import {
  checkBoxesForPrint, checkPrintDetail, nextBoxNumber, parseBoxQr, printedLabel, renumberDrafts, renumberedMessage,
  rmArticleOptions, storedMessage, storesRefLabel, type PrintedRef, type StoresRef,
} from "./box-scan.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

// ── what a sticker's QR stands for ──
check("warehouse label gives its box id and transaction",
  parseBoxQr('{"tx":"TR-2026-0042","bi":"BX-17"}'), { code: "BX-17", transaction_no: "TR-2026-0042" });
check("label values are trimmed",
  parseBoxQr('  {"tx":" TR-1 ","bi":" BX-9 "}  '), { code: "BX-9", transaction_no: "TR-1" });
check("label without a transaction", parseBoxQr('{"bi":"BX-3"}'), { code: "BX-3", transaction_no: null });
check("blank transaction reads as none", parseBoxQr('{"tx":"  ","bi":"BX-3"}'), { code: "BX-3", transaction_no: null });
check("a bare id is the box id", parseBoxQr("  12345678  "), { code: "12345678", transaction_no: null });
check("JSON without bi is taken as it reads", parseBoxQr('{"x":1}'), { code: '{"x":1}', transaction_no: null });
check("a JSON number is a bare id", parseBoxQr("42"), { code: "42", transaction_no: null });
check("a label with a blank bi has no box id", parseBoxQr('{"tx":"TR-1","bi":"  "}').code, "");
check("empty scan has no box id", parseBoxQr("   ").code, "");

// ── a manually printed box ──
check("net only",
  checkPrintDetail({ netW: "12.5", grossW: "", count: "" }),
  { ok: true, detail: { net_weight: 12.5, gross_weight: null, count: null } });
check("all three",
  checkPrintDetail({ netW: " 12.5 ", grossW: "13.25", count: "40" }),
  { ok: true, detail: { net_weight: 12.5, gross_weight: 13.25, count: 40 } });
check("gross equal to net is fine",
  checkPrintDetail({ netW: "5", grossW: "5", count: "0" }),
  { ok: true, detail: { net_weight: 5, gross_weight: 5, count: 0 } });
check("net is required", checkPrintDetail({ netW: "  ", grossW: "", count: "" }),
  { ok: false, message: "Enter the net weight." });
check("zero net is refused", checkPrintDetail({ netW: "0", grossW: "", count: "" }),
  { ok: false, message: "Net wt must be more than 0." });
check("text net is refused", checkPrintDetail({ netW: "abc", grossW: "", count: "" }),
  { ok: false, message: "Net wt must be more than 0." });
check("infinite net is refused", checkPrintDetail({ netW: "Infinity", grossW: "", count: "" }),
  { ok: false, message: "Net wt must be more than 0." });
check("negative gross is refused", checkPrintDetail({ netW: "1", grossW: "-2", count: "" }),
  { ok: false, message: "Gross wt must be a number, 0 or more." });
check("gross below net is refused", checkPrintDetail({ netW: "10", grossW: "9.999", count: "" }),
  { ok: false, message: "Gross wt can't be less than net wt." });
check("a fractional count is refused", checkPrintDetail({ netW: "1", grossW: "", count: "2.5" }),
  { ok: false, message: "Count must be a whole number, 0 or more." });
check("a negative count is refused", checkPrintDetail({ netW: "1", grossW: "", count: "-1" }),
  { ok: false, message: "Count must be a whole number, 0 or more." });

// ── the next box number ──
check("first box", nextBoxNumber([]), 1);
check("after the highest", nextBoxNumber([3, 1, 7]), 8);
check("blanks are ignored", nextBoxNumber([null, 2, undefined]), 3);

// ── a set of boxes to print ──
const box = (n: number, gross: string, net: string, count = "") =>
  ({ box_number: n, gross_weight: gross, net_weight: net, count });
check("good boxes are read",
  checkBoxesForPrint([box(1, "12", "11.5", "4"), box(2, "", "10")]),
  { ok: true, boxes: [
    { box_number: 1, net_weight: 11.5, gross_weight: 12, count: 4 },
    { box_number: 2, net_weight: 10, gross_weight: null, count: null },
  ] });
check("nothing to print", checkBoxesForPrint([]), { ok: false, message: "No boxes to print." });
check("each bad box is named",
  checkBoxesForPrint([box(1, "12", "11"), box(2, "", ""), box(5, "4", "5")]),
  { ok: false, message: "Box 2: Enter the net weight. Box 5: Gross wt can't be less than net wt." });
check("a long list of bad boxes is cut short",
  checkBoxesForPrint([box(1, "", ""), box(2, "", ""), box(3, "", ""), box(4, "", ""), box(5, "", "")]),
  { ok: false, message: "Box 1: Enter the net weight. Box 2: Enter the net weight. Box 3: Enter the net weight. …and 2 more boxes." });
check("one more bad box reads singular",
  checkBoxesForPrint([box(1, "", ""), box(2, "", ""), box(3, "", ""), box(4, "", "0")]),
  { ok: false, message: "Box 1: Enter the net weight. Box 2: Enter the net weight. Box 3: Enter the net weight. …and 1 more box." });

// ── a box Stores sent for this job card ──
const printed = { requisition_id: 123, box_number: 4, source: "printed" };
const scanned = { requisition_id: 123, box_number: null, source: "scanned" };
check("a printed box names its request and box", storesRefLabel(printed), "Sent by Stores · Request #123 · Box 4");
check("a scanned box has no box number", storesRefLabel(scanned), "Sent by Stores · Request #123");
check("a missing box number reads as none",
  storesRefLabel({ requisition_id: 9 } as StoresRef), "Sent by Stores · Request #9");
check("no Stores record, no line", storesRefLabel(null), null);
check("an older server sends no Stores key", storesRefLabel(undefined), null);
check("stored from a Stores request", storedMessage("BX-17", printed), "Stored BX-17 · from Stores request #123");
check("stored, not from Stores", storedMessage("BX-17", null), "Stored BX-17");
check("stored, no Stores key", storedMessage("BX-17", undefined), "Stored BX-17");

// ── a box printed on the job card's Raw Material tab ──
check("a printed box names its box number",
  printedLabel({ box_number: 4, lot_number: "LOT-7" }), "Printed on this job card · Box 4");
check("a printed box without a number",
  printedLabel({ box_number: null, lot_number: null }), "Printed on this job card");
check("a missing box number reads as none",
  printedLabel({ lot_number: null } as PrintedRef), "Printed on this job card");
check("not printed here, no line", printedLabel(null), null);
check("an older server sends no printed key", printedLabel(undefined), null);

// ── the job card's RM articles offered as quick picks ──
const line = (name: string | null | undefined, type: string | null | undefined) =>
  ({ material_sku_name: name, item_type: type });
check("only RM lines, in BOM order",
  rmArticleOptions([line("Cashew W320", "RM"), line("Pouch 500g", "PM"), line("Almond", "rm"), line("Mix", "SFG")]),
  ["Cashew W320", "Almond"]);
check("RM in any case or spacing",
  rmArticleOptions([line("A", " Rm "), line("B", "rM")]), ["A", "B"]);
check("names are trimmed and blanks dropped",
  rmArticleOptions([line("  Cashew  ", "RM"), line("   ", "RM"), line(null, "RM"), line(undefined, "RM")]),
  ["Cashew"]);
check("a line without a type is not RM", rmArticleOptions([line("Cashew", null), line("Almond", undefined)]), []);
check("repeats are dropped, first spelling kept",
  rmArticleOptions([line("Cashew W320", "RM"), line("cashew w320 ", "rm"), line("Almond", "RM"), line("CASHEW W320", "RM")]),
  ["Cashew W320", "Almond"]);
check("no BOM lines, no picks", rmArticleOptions([]), []);

// ── Box #s the job card already used, renumbered in the draft ──
const row = (n: number, gross = "", lot = "") => ({ box_number: n, gross_weight: gross, lot_number: lot });
const section = (id: number, boxes: ReturnType<typeof row>[] | null) => ({ id, box_count: "", boxes });
check("the rest of a range printed first: the box left over moves past them",
  renumberDrafts([section(1, [row(1, "10.5", "L-1")])], 11),
  [section(1, [row(11, "10.5", "L-1")])]);
check("every row still to print is renumbered, in order across the sections, keeping what was typed",
  renumberDrafts([section(1, [row(3, "4"), row(4, "5")]), section(2, null), section(3, [row(9, "", "L-9")])], 13),
  [section(1, [row(13, "4"), row(14, "5")]), section(2, null), section(3, [row(15, "", "L-9")])]);
check("no drafts, nothing changes", renumberDrafts([section(1, null)], 5), [section(1, null)]);
const before = [section(1, [row(1)])];
renumberDrafts(before, 7);
check("the sections given are left as they were", before, [section(1, [row(1)])]);

check("one taken box",
  renumberedMessage([1], 11),
  "Box number 1 is already used on this job card, so the boxes still to print now start at Box 11. Print them again.");
check("a few taken boxes",
  renumberedMessage([3, 4], 13),
  "Box numbers 3, 4 are already used on this job card, so the boxes still to print now start at Box 13. Print them again.");
check("a long list of taken boxes is cut short",
  renumberedMessage([1, 2, 3, 4, 5], 21),
  "Box numbers 1, 2, 3 and 2 more are already used on this job card, so the boxes still to print now start at Box 21. Print them again.");
check("the taken boxes not named",
  renumberedMessage([], 8),
  "Some box numbers are already used on this job card, so the boxes still to print now start at Box 8. Print them again.");

if (failures) { console.error(`${failures} failed`); process.exit(1); }
console.log("box-scan: all checks passed");
