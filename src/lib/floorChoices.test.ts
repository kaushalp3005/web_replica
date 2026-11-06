// node src/lib/floorChoices.test.ts
import {
  allowedFloorsFor, canonicalFloor, chainFloorProblems, finishedCardMoved, floorChoicesFor, floorScopeNote,
  liveEditTouched, prefillFloor, productionFloors, stepCarded, stepFloorTouched, touchedFloors,
} from "./floorChoices.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

const admin = { isAdmin: true, floors: ["Roasting Area"] };
const open = { isAdmin: false, floors: [] as string[] };
const leader = { isAdmin: false, floors: ["roasting area ", "Terrace"] };   // odd-cased legacy grant
const elsewhere = { isAdmin: false, floors: ["Terrace"] };

// The factory's floors.
check("by any spelling of the code", productionFloors("a-185").length, 9);
check("no store floors", productionFloors("W-202").includes("Store"), false);
check("unknown factory", productionFloors("F53"), []);
check("declared spelling", canonicalFloor("A-185", " fg STORE "), "FG store");
check("not listed: as typed", canonicalFloor("F53", " Bay 2 "), "Bay 2");
check("prefill: declared spelling", prefillFloor("A-185", "roasting area"), "Roasting Area");
check("prefill: a saved card's spelling", prefillFloor("A-185", "Roasting Area", ["roasting area"]), "roasting area");
check("prefill: not a production floor here", prefillFloor("A-185", "A185 Cold"), "");
check("prefill: no list", prefillFloor("F53", "Bay 2"), "Bay 2");

// Whose floors.
check("admin: all", allowedFloorsFor(admin, "A185").length, 9);
check("no grants: all", allowedFloorsFor(open, "A185").length, 9);
check("grants ignore case", allowedFloorsFor(leader, "A-185"), ["Roasting Area"]);
check("no floors here", allowedFloorsFor(elsewhere, "A-185"), []);
check("no factory", allowedFloorsFor(leader, undefined), []);
// Planners (plans › approve) get every floor of the factory, as in the pop-ups.
check("planner: every floor", allowedFloorsFor(leader, "A-185", { anyFloorInFactory: true }).length, 9);
check("planner with no floors here: every floor", allowedFloorsFor(elsewhere, "A-185", { anyFloorInFactory: true }).length, 9);
check("not a planner: own floors", allowedFloorsFor(leader, "A-185", { anyFloorInFactory: false }), ["Roasting Area"]);

// The picker.
const leaderChoices = floorChoicesFor(leader, "A-185");
check("own floor enabled", leaderChoices.find((c) => c.value === "Roasting Area"),
  { value: "Roasting Area", disabled: false, reason: null, saved: false });
check("other floor greyed", leaderChoices.find((c) => c.value === "Sorting Area"),
  { value: "Sorting Area", disabled: true, reason: "not your floor", saved: false });
check("planner: none greyed",
  floorChoicesFor(leader, "A-185", { anyFloorInFactory: true }).filter((c) => c.disabled).length, 0);
const withSaved = floorChoicesFor(leader, "A-185", { saved: "sorting area" });
check("saved floor kept as stored, enabled", withSaved.find((c) => c.saved),
  { value: "sorting area", disabled: false, reason: null, saved: true });
check("…in its place, not twice", withSaved.filter((c) => c.value.toUpperCase() === "SORTING AREA").length, 1);
check("a saved floor the list lacks comes first",
  floorChoicesFor(leader, "A-185", { saved: ["A185 Cold", null, ""] })[0],
  { value: "A185 Cold", disabled: false, reason: null, saved: true });
check("no list: only saved", floorChoicesFor(leader, "F53", { saved: "Bay 2" }).map((c) => c.value), ["Bay 2"]);

// What a change touches.
check("insert anywhere touches the new floor only",
  touchedFloors(["Roasting Area", "FG store"], ["Sorting Area", "roasting area", "FG store"]), ["Sorting Area"]);
check("reorder touches nothing", touchedFloors(["A", "B"], ["B", "A"]), []);
check("one card fewer", touchedFloors(["A", "A"], ["A"]), ["A"]);
check("new chain: every floor", touchedFloors([], ["A", "B", "a"]), ["A", "B"]);

const saved = [
  { jobCardId: 1, floor: "Roasting Area", status: "in_progress" },
  { jobCardId: 2, floor: "sorting area", status: "locked" },
  { jobCardId: 3, floor: "FG store", status: "completed" },
  { jobCardId: 4, floor: "FFS Packing Area", status: "locked" },
];
check("quantity only: nothing", liveEditTouched(saved, [
  { jobCardId: 1, floor: "Roasting Area" }, { jobCardId: 2, floor: "Sorting Area" },
  { jobCardId: 3, floor: "FG store" }, { jobCardId: 4, floor: "FFS Packing Area" },
]), []);
check("moved, added, removed", liveEditTouched(saved, [
  { jobCardId: 1, floor: "Mezzanine" }, { jobCardId: null, floor: "Printing Area" },
  { jobCardId: 3, floor: "Terrace" },            // finished: refused on its own (finishedCardMoved)
  { jobCardId: 4, floor: "" },                   // blank: unchanged
]), ["Mezzanine", "Roasting Area", "Printing Area", "sorting area"]);

// A finished card stays where it is: the server refuses the whole save (card_finished).
const savedNamed = saved.map((c) => ({ ...c, process: `Stage ${c.jobCardId}` }));
check("finished card moved", finishedCardMoved(savedNamed, [
  { jobCardId: 1, floor: "Mezzanine" }, { jobCardId: 3, floor: "Terrace" },
]), { jobCardId: 3, message: "Stage 3 is completed, so it stays on FG store. Put its floor back to save the other changes." });
check("finished card, same floor any case", finishedCardMoved(savedNamed, [{ jobCardId: 3, floor: " fg STORE" }]), null);
check("finished card, blank floor keeps it", finishedCardMoved(savedNamed, [{ jobCardId: 3, floor: "" }]), null);
check("a running card may move", finishedCardMoved(savedNamed, [{ jobCardId: 1, floor: "Mezzanine" }]), null);
check("a new row is no card", finishedCardMoved(savedNamed, [{ jobCardId: null, floor: "Terrace" }]), null);
check("finished card with no name or floor",
  finishedCardMoved([{ jobCardId: 9, floor: null, status: "closed" }], [{ jobCardId: 9, floor: "Terrace" }])?.message,
  "Job card 9 is closed, so it stays on its floor. Put its floor back to save the other changes.");

// Plan Detail: whether a step's job cards move with its floor.
check("step with waiting cards", stepCarded({ carded: true }, false), true);
check("step whose cards have started", stepCarded({ carded: false }, true), false);
check("older server: the line decides", stepCarded({}, true), true);
check("older server, no cards", stepCarded({}, false), false);
check("no such step", stepCarded(undefined, true), true);

// Plan Detail: the floors a step's new floor touches, as PUT /plans-v2/steps/{id}
// checks them — the floors its waiting cards leave, then the new floor.
const step = (floor: string | null, card_floors?: (string | null)[], carded?: boolean) =>
  ({ floor, ...(card_floors ? { card_floors } : {}), ...(carded != null ? { carded } : {}) });
check("cleared step, its card still on Sorting",
  stepFloorTouched(step(null, ["Sorting Area"]), "Roasting Area", true), ["Sorting Area", "Roasting Area"]);
check("card already moved to the new floor",
  stepFloorTouched(step("Sorting Area", ["Roasting Area"]), "Roasting Area", true), ["Roasting Area"]);
check("no waiting cards", stepFloorTouched(step("Sorting Area", []), "Roasting Area", true), ["Roasting Area"]);
check("same floor, other case, no card moves", stepFloorTouched(step("Sorting Area", []), "sorting area", true), []);
check("cards already there", stepFloorTouched(step("Sorting Area", ["sorting area"]), "Sorting Area", true), []);
check("a card on another floor moves, step unchanged",
  stepFloorTouched(step("Sorting Area", ["Mezzanine", "Sorting Area"]), "Sorting Area", true),
  ["Mezzanine", "Sorting Area"]);
check("a card with no floor moves onto it",
  stepFloorTouched(step("Roasting Area", [null]), "roasting area", true), ["roasting area"]);
check("blank clears the step and checks nothing", stepFloorTouched(step("Sorting Area", ["Sorting Area"]), " ", true), []);
check("older server: carded step", stepFloorTouched(step("Sorting Area", undefined, true), "Roasting Area", false),
  ["Roasting Area", "Sorting Area"]);
check("older server: no waiting cards", stepFloorTouched(step("Sorting Area", undefined, false), "Roasting Area", true),
  ["Roasting Area"]);
check("older server: the line decides", stepFloorTouched(step("Sorting Area"), "Roasting Area", true),
  ["Roasting Area", "Sorting Area"]);
check("older server: same floor", stepFloorTouched(step("Sorting Area", undefined, true), "sorting area", true), []);
check("no such step", stepFloorTouched(undefined, "Roasting Area", true), ["Roasting Area"]);
// A save that also adds, moves or removes a step sends that first, and its
// resync puts the waiting cards back on the step's floor before this PUT.
check("structural save: the step's floor too",
  stepFloorTouched(step("Sorting Area", ["Roasting Area"]), "Roasting Area", true, { structuralFirst: true }),
  ["Roasting Area", "Sorting Area"]);
check("structural save, no waiting cards",
  stepFloorTouched(step("Sorting Area", []), "Roasting Area", true, { structuralFirst: true }), ["Roasting Area"]);
check("structural save, cleared step",
  stepFloorTouched(step(null, ["Sorting Area"]), "Roasting Area", true, { structuralFirst: true }),
  ["Sorting Area", "Roasting Area"]);
check("structural save, older server",
  stepFloorTouched(step("Sorting Area", undefined, true), "Roasting Area", true, { structuralFirst: true }),
  ["Roasting Area", "Sorting Area"]);

// The check before Save.
const sorry = chainFloorProblems(leader, "A-185", ["Sorting Area", "roasting area", "sorting area", "FG store"]);
check("names each floor once", sorry?.floors, ["Sorting Area", "FG store"]);
check("and says what to do", sorry?.message,
  "Sorting Area and FG store are not your floors, so you can't put work there or take it off. " +
  "Your floors in A-185: Roasting Area. Use one of those, or ask a planner to make this change.");
check("none of yours here", chainFloorProblems(elsewhere, "A-185", ["Sorting Area"])?.message,
  "Sorting Area is not one of your floors, so you can't put work there or take it off. " +
  "None of your floors are in A-185. Ask a planner to make this change, or an admin to add the floor to your profile.");
check("planner passes", chainFloorProblems(leader, "A-185", ["Sorting Area"], { anyFloorInFactory: true }), null);
check("admin passes", chainFloorProblems(admin, "A-185", ["Sorting Area"]), null);
check("own floors pass", chainFloorProblems(leader, "A-185", ["Roasting Area"]), null);

// The "your floors" line.
check("note: no limit", floorScopeNote(open, "A-185"), "No floor restriction on your profile, so all 9 floors of A-185 are listed.");
check("note: planner", floorScopeNote(leader, "A-185", { anyFloorInFactory: true }),
  "You can approve plans, so you can plan any of the 9 floors of A-185.");
check("note: limited", floorScopeNote(leader, "A-185"),
  "From your profile — 1 of the 9 floors of A-185 is yours: Roasting Area. The others are greyed out; ask a planner to put work there.");
check("note: no list", floorScopeNote(leader, "F53"), null);

if (failures) { console.error(`${failures} failed`); process.exit(1); }
console.log("floorChoices: all checks passed");
