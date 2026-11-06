// node src/lib/job-card-sfg.test.ts
import { memberPieces, mergeProcessRows, seedStandardSfg, sfgFeedIndex, type SfgRow } from "./job-card-sfg.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

const STD = "Roasted Almonds";
type Row = SfgRow & { jobCardId?: number; uid?: string };
const row = (process: string, sfgOutput = "", extra: Partial<Row> = {}): Row => ({ process, floor: "Roasting Area", sfgOutput, ...extra });
const sfgs = (rows: { sfgOutput: string }[]) => rows.map((r) => r.sfgOutput);

// Which row feeds packing.
check("feed of three rows", sfgFeedIndex(3), 1);
check("feed of two rows", sfgFeedIndex(2), 0);
check("one-card chain has none", sfgFeedIndex(1), -1);

// A plan route with no SFGs: only the last process before packing gets the standard.
const route = [row("Sorting"), row("Roasting"), row("Salting"), row("Packaging")];
const seeded = seedStandardSfg(route, STD);
check("plan route: last process only", sfgs(seeded), ["", "", STD, ""]);
check("plan route: marked as filled in", seeded.map((r) => r.sfgAuto === true), [false, false, true, false]);
check("two rows: the one process", sfgs(seedStandardSfg([row("Roasting"), row("Packaging")], STD)), [STD, ""]);
check("one-card chain: nothing", sfgs(seedStandardSfg([row("Sorting + Packing")], STD)), [""]);
check("no standard SFG: rows untouched", sfgs(seedStandardSfg(route, "")), ["", "", "", ""]);
check("standard is trimmed", sfgs(seedStandardSfg([row("Roasting"), row("Packaging")], `  ${STD} `)), [STD, ""]);

// Edit keeps what was saved, the standard one never replaces it.
const saved = [row("Sorting", "Sorted Almonds"), row("Roasting", "Almond Roast 2"), row("Packaging")];
check("edit: saved SFGs kept", sfgs(seedStandardSfg(saved, STD)), ["Sorted Almonds", "Almond Roast 2", ""]);
check("edit: blank last process filled", sfgs(seedStandardSfg([row("Sorting", "Sorted Almonds"), row("Roasting"), row("Packaging")], STD)),
  ["Sorted Almonds", STD, ""]);
check("edit: an earlier saved standard stays", sfgs(seedStandardSfg([row("Sorting", STD), row("Roasting", STD), row("Packaging")], STD)),
  [STD, STD, ""]);

// Started cards keep their saved SFG (live edit), even blank.
check("started last process stays blank",
  sfgs(seedStandardSfg([row("Sorting", "", { started: true }), row("Roasting", "", { started: true }), row("Packaging")], STD)),
  ["", "", ""]);
check("started card's code stays",
  sfgs(seedStandardSfg([row("Roasting", "SFG0042", { started: true }), row("Packaging")], STD)), ["SFG0042", ""]);

// The filled-in standard follows the last process.
const added = [seeded[0], seeded[1], seeded[2], row(""), seeded[3]];      // Add process before packing
check("add process: standard moves to the new last process", sfgs(seedStandardSfg(added, STD)), ["", "", "", STD, ""]);
const typed = [row("Sorting"), row("Roasting", "Almond Roast 2"), row(""), row("Packaging")];
check("add process: a typed SFG stays where it is", sfgs(seedStandardSfg(typed, STD)), ["", "Almond Roast 2", STD, ""]);
const moved = [seeded[2], seeded[0], seeded[1], seeded[3]];               // Salting moved to the top
check("move: standard follows the last process", sfgs(seedStandardSfg(moved, STD)), ["", "", STD, ""]);
const removed = [seeded[0], seeded[1], seeded[3]];                        // Salting removed
check("remove: the new last process gets it", sfgs(seedStandardSfg(removed, STD)), ["", STD, ""]);
check("remove down to one card: dropped", sfgs(seedStandardSfg([{ ...seeded[2], process: "Packaging" }], STD)), [""]);
check("article without a standard: an old fill is dropped",
  sfgs(seedStandardSfg([row("Roasting", "Old", { sfgAuto: true }), row("Packaging")], "")), ["", ""]);

// Merging processes keeps the later one's SFG; never "A + B".
const two = [row("Roasting", "Roasted Almonds"), row("Salting", "Salted Almonds"), row("Packaging")];
const merged = mergeProcessRows(two, [1, 0]);
check("merge: names joined, later SFG", merged.map((r) => [r.process, r.sfgOutput]),
  [["Roasting + Salting", "Salted Almonds"], ["Packaging", ""]]);
check("merge: never joins SFGs", merged.some((r) => r.sfgOutput.includes(" + ")), false);
check("merge: blank later step keeps the earlier one",
  sfgs(mergeProcessRows([row("Roasting", "Roasted Almonds"), row("Salting"), row("Packaging")], [0, 1])), ["Roasted Almonds", ""]);
check("merge: none had one", sfgs(mergeProcessRows([row("Roasting"), row("Salting"), row("Packaging")], [0, 1])), ["", ""]);
check("merge: floors that differ go blank",
  mergeProcessRows([row("Roasting"), { ...row("Salting"), floor: "Sorting Area" }, row("Packaging")], [0, 1])[0].floor, "");
check("merge: non-adjacent rows",
  mergeProcessRows([row("Sorting", "A"), row("Roasting", "B"), row("Salting", "C"), row("Packaging")], [0, 2])
    .map((r) => [r.process, r.sfgOutput]),
  [["Sorting + Salting", "C"], ["Roasting", "B"], ["Packaging", ""]]);
check("merge: one row is no merge", sfgs(mergeProcessRows(two, [1])), sfgs(two));
check("merge: drops the saved card", "jobCardId" in mergeProcessRows([row("A", "", { jobCardId: 5 }), row("B"), row("P")], [0, 1])[0], false);
// The pop-up keys each row by its own uid: the rules keep it on every row they
// pass through, and the merged row (a new process) has none, so it gets its own.
check("seed keeps each row's key",
  seedStandardSfg([row("Roasting", "", { uid: "r1" }), row("Packaging", "", { uid: "r2" })], STD).map((r) => r.uid), ["r1", "r2"]);
check("merge keeps the other rows' keys",
  mergeProcessRows([row("A", "", { uid: "r1" }), row("B", "", { uid: "r2" }), row("P", "", { uid: "r3" })], [0, 1])
    .map((r) => (r as Row).uid ?? null),
  [null, "r3"]);
// Merged into packing: the filled-in standard is taken off the finished-goods row.
const intoPacking = seedStandardSfg(mergeProcessRows(seedStandardSfg([row("Roasting"), row("Packaging")], STD), [0, 1]), STD);
check("merge into packing: standard dropped", [intoPacking.length, intoPacking[0].sfgOutput], [1, ""]);
// Merging the last two processes: the merged one is now last, it keeps the standard.
const lastTwo = seedStandardSfg(mergeProcessRows(seeded, [1, 2]), STD);
check("merge last two: standard on the merged process", sfgs(lastTwo), ["", STD, ""]);

// Pieces per product of a merged run.
check("planned kg: planned pieces", memberPieces(400, 100, 100), 400);
check("kg edited: scaled", memberPieces(400, 100, 80), 320);
check("scaled rounds to whole pieces", memberPieces(400, 100, 33.3), 133);
check("rounds half up", memberPieces(3, 2, 1), 2);
check("fractional planned pieces kept as planned", memberPieces(12.5, 50, 50), 12.5);
check("no planned pieces", memberPieces(null, 100, 80), null);
check("zero planned pieces", memberPieces(0, 100, 80), null);
check("no planned kg to scale by", memberPieces(400, null, 80), null);
check("no kg entered", memberPieces(400, 100, 0), null);
check("rounds to none", memberPieces(1, 100, 10), null);

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("job-card-sfg: all checks passed");
