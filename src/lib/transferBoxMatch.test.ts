// Exercises lib/transferBoxMatch. No test runner is configured in this project, so this
// runs directly on Node's native TypeScript stripping:
//
//     node src/lib/transferBoxMatch.test.ts

import {
  articleKey, boxRefusal, isRealBox, lineQty, lotKey, matchBoxes, refusalText, refuseNewBox, refusedBoxes,
  type MatchBox, type MatchLine,
} from "./transferBoxMatch.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

const box = (boxId: string, article: string, lot = ""): MatchBox => ({ boxId, article, lot });
const line = (article: string, qty: number, lot = ""): MatchLine => ({ article, lot, qty });

// ── names, lots, qty ──
check("article names: whitespace collapsed, upper-cased", articleKey("  Cashew   W320\tsplit "), "CASHEW W320 SPLIT");
check("article name missing", articleKey(null), "");
check("lots trimmed, case kept", lotKey(" lot-7a "), "lot-7a");
check("qty is whole boxes", [lineQty("3"), lineQty("3.9"), lineQty("0"), lineQty(""), lineQty(null), lineQty(2)], [3, 3, 0, 0, 0, 2]);

// ── real boxes ──
check("a box with id and transaction is real", isRealBox({ boxId: "B-1", transactionNo: "TR-1" }), true);
check("DIRECT is not a box", isRealBox({ boxId: "B-1", transactionNo: " DIRECT " }), false);
check("no box id is not a box", isRealBox({ boxId: " ", transactionNo: "TR-1" }), false);

// ── matching ──
check("names match however spaced or cased",
  matchBoxes([line("Cashew W320", 2)], [box("1", "cashew  w320"), box("2", " CASHEW W320 ")]),
  { taken: [2], leftover: [] });
check("a lot line takes its lot first, the any-lot line the rest",
  matchBoxes([line("A", 1), line("A", 1, "L1")], [box("1", "A", "L1"), box("2", "A", "L2")]),
  { taken: [1, 1], leftover: [] });
check("a lot line refuses another lot",
  matchBoxes([line("A", 2, "L1")], [box("1", "A", "L1"), box("2", "A", "L2")]),
  { taken: [1], leftover: [1] });
check("a line takes at most its qty; the later box is left over",
  matchBoxes([line("A", 1)], [box("1", "A"), box("2", "A")]),
  { taken: [1], leftover: [1] });
check("each box counts once across lines",
  matchBoxes([line("A", 1, "L1"), line("A", 1, "L1")], [box("1", "A", "L1"), box("2", "A", "L1"), box("3", "A", "L1")]),
  { taken: [1, 1], leftover: [2] });
check("an article not on the request is left over",
  matchBoxes([line("A", 3)], [box("1", "B")]),
  { taken: [0], leftover: [0] });

// ── refusals ──
const lines = [line("Cashew W320", 2), line("Almond", 1, "L1"), line("Almond", 1, "L2")];
check("not on the request",
  boxRefusal(lines, box("B-9", "Raisin"), "REQ-1"),
  "Box B-9 is Raisin, which is not on request REQ-1.");
check("not on the request: the box's article named with whitespace collapsed",
  boxRefusal(lines, box("B-9", " cashew  w321 "), "REQ-1"),
  "Box B-9 is cashew w321, which is not on request REQ-1.");
check("another lot",
  boxRefusal(lines, box("B-9", "ALMOND", "L3"), "REQ-1"),
  "Box B-9 is lot L3; request REQ-1 asks for lot L1, L2 of Almond.");
check("no lot where the request asks for one",
  boxRefusal(lines, box("B-9", "Almond"), "REQ-1"),
  "Box B-9 is lot (none); request REQ-1 asks for lot L1, L2 of Almond.");
check("over the qty",
  boxRefusal(lines, box("B-9", "cashew w320", "X"), "REQ-1"),
  "Request REQ-1 asks for 2 box(es) of Cashew W320; all are already on this dispatch.");
check("over the qty of a lot line",
  boxRefusal([line("Almond", 1, "L1")], box("B-9", "Almond", "L1"), "REQ-1"),
  "Request REQ-1 asks for 1 box(es) of Almond; all are already on this dispatch.");
check("the request's article named with whitespace collapsed",
  boxRefusal([line(" Almond  Raw ", 1)], box("B-9", "ALMOND RAW"), "REQ-1"),
  "Request REQ-1 asks for 1 box(es) of Almond Raw; all are already on this dispatch.");

// ── several refusals as one message (the server's 409) ──
check("one refusal as it is", refusalText(["Box 1 is B, which is not on request R."]), "Box 1 is B, which is not on request R.");
check("several as sentences, repeats kept",
  refusalText(["Request R asks for 1 box(es) of A; all are already on this dispatch.",
    "Request R asks for 1 box(es) of A; all are already on this dispatch.", "No stop"]),
  "Request R asks for 1 box(es) of A; all are already on this dispatch. "
    + "Request R asks for 1 box(es) of A; all are already on this dispatch. No stop.");
check("the first 10, then how many more",
  refusalText(Array.from({ length: 13 }, (_, i) => `M${i}.`)),
  "M0. M1. M2. M3. M4. M5. M6. M7. M8. M9. And 3 more.");

// ── a new box against the boxes already on the dispatch ──
const onList = [box("1", "Cashew W320", "X"), box("2", "Almond", "L1")];
check("a box the request still has room for", refuseNewBox(lines, onList, box("3", "Cashew W320", "Y"), "REQ-1"), null);
check("a box over the qty",
  refuseNewBox(lines, [...onList, box("3", "Cashew W320")], box("4", "Cashew W320"), "REQ-1"),
  "Request REQ-1 asks for 2 box(es) of Cashew W320; all are already on this dispatch.");
check("a lot box once its line is full",
  refuseNewBox(lines, onList, box("3", "Almond", "L1"), "REQ-1"),
  "Request REQ-1 asks for 1 box(es) of Almond; all are already on this dispatch.");
check("a box of the other lot line still fits", refuseNewBox(lines, onList, box("3", "Almond", "L2"), "REQ-1"), null);
check("boxes already left over don't count against a new one",
  refuseNewBox([line("A", 1)], [box("1", "B"), box("2", "B")], box("3", "A"), "REQ-1"), null);

// ── every refused box of a dispatch ──
check("each box the request doesn't take, by index",
  refusedBoxes([line("A", 1)], [box("1", "A"), box("2", "B"), box("3", "A")], "REQ-1"),
  [{ index: 1, message: "Box 2 is B, which is not on request REQ-1." },
    { index: 2, message: "Request REQ-1 asks for 1 box(es) of A; all are already on this dispatch." }]);
check("none refused", refusedBoxes([line("A", 2)], [box("1", "a"), box("2", "A ")], "REQ-1"), []);

if (failures) { console.error(`${failures} failed`); process.exit(1); }
console.log("transferBoxMatch: all checks passed");
