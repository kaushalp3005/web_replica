// node src/lib/job-card-edit.test.ts
import {
  MIN_PROCESS_ROWS, addProcessBlocked, cardFinished, chainFinishedNote, editsInPlace, planAllowsJobCardEdit,
  removeBlocked,
} from "./job-card-edit.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

// One card is a whole chain (raw material straight to finished goods).
check("one row is enough", MIN_PROCESS_ROWS, 1);

// Which plans show Edit Job Card.
check("approved plan", planAllowsJobCardEdit("approved"), true);
check("draft plan", planAllowsJobCardEdit("draft"), true);
check("cancelled plan", planAllowsJobCardEdit("Cancelled"), false);
check("executed plan", planAllowsJobCardEdit(" executed "), false);
check("no status", planAllowsJobCardEdit(null), true);

// Rebuild or change in place.
check("fresh chain is rebuilt", editsInPlace({ started: false, editable: true }), false);
check("started chain in place", editsInPlace({ started: true, editable: false }), true);
check("can't be rebuilt: in place", editsInPlace({ started: false, editable: false }), true);
check("old server, no flags", editsInPlace({}), false);

// Finished cards.
check("completed is finished", cardFinished("completed"), true);
check("closed is finished", cardFinished("closed"), true);
check("cancelled is finished", cardFinished("cancelled"), true);
check("running is not", cardFinished("in_progress"), false);
check("no status is not", cardFinished(null), false);

// Add process: only before a last card still waiting for the stage before it.
const pkg = (status: string) => ({ process: "Packaging", jobCardId: 3, started: status !== "locked" && status !== "unlocked", status });
check("rebuild: always", addProcessBlocked(false, [{ process: "Packaging", jobCardId: 3, status: "in_progress" }]), null);
check("packing waits", addProcessBlocked(true, [{ process: "Roasting", jobCardId: 1, status: "in_progress" }, pkg("locked")],
  { firstJobCardId: 1 }), null);
check("packing released by the last dispatch",
  addProcessBlocked(true, [{ process: "Roasting", jobCardId: 1, status: "completed" }, pkg("unlocked")], { firstJobCardId: 1 }),
  "Packaging has already received material — a process can't be added before it.");
check("running one-card chain",
  addProcessBlocked(true, [{ process: "Sorting + Packing", jobCardId: 1, started: true, status: "in_progress" }],
    { firstJobCardId: 1 }),
  "Sorting + Packing has already received material — a process can't be added before it.");
check("no status known: blocked", addProcessBlocked(true, [{ process: "", jobCardId: 3 }]),
  "The last process has already received material — a process can't be added before it.");
// A one-card chain released to its floor has received nothing: say what it is.
const released = "Packing is the chain's first stage and is already released to its floor, so a process can't be added "
  + "before it. Ask an admin to cancel that job card, then create the job cards again with the new process.";
check("released one-card chain",
  addProcessBlocked(true, [{ process: "Packing", jobCardId: 1, status: "unlocked" }], { firstJobCardId: 1 }), released);
check("released one-card chain with a team on it",
  addProcessBlocked(true, [{ process: "Packing", jobCardId: 1, started: true, status: "assigned" }], { firstJobCardId: 1 }),
  released);
check("released, but not the first card: it has material",
  addProcessBlocked(true, [{ process: "Roasting", jobCardId: 1, status: "completed" }, pkg("unlocked")], { firstJobCardId: 1 }),
  "Packaging has already received material — a process can't be added before it.");

// Remove.
const live = { inPlace: true, firstJobCardId: 1 };
const chain = [
  { process: "Roasting", jobCardId: 1, started: true, status: "in_progress" },
  { process: "Sorting", jobCardId: 2, started: false, status: "locked" },
  { process: "", jobCardId: null },
  { process: "Packaging", jobCardId: 3, started: false, status: "locked" },
];
const stop = (p: string) => `${p} has started. Use Stop process on its job card — it sends on what was made first.`;
check("the only row", removeBlocked(0, [chain[3]], live), "A job card needs at least one process.");
check("the only row, rebuild too", removeBlocked(0, [chain[3]], { inPlace: false }), "A job card needs at least one process.");
check("rebuild: any row of two", removeBlocked(1, chain.slice(0, 2), { inPlace: false }), null);
check("rebuild: even the last", removeBlocked(3, chain, { inPlace: false }), null);
check("in place: the last stays", removeBlocked(3, chain, live), "The last process makes the finished goods, so it stays.");
check("in place: started first stage", removeBlocked(0, chain, live), stop("Roasting"));
check("in place: first stage with its material in",
  removeBlocked(0, [{ ...chain[0], status: "material_received" }, chain[3]], live), stop("Roasting"));
check("in place: waiting stage", removeBlocked(1, chain, live), null);
check("in place: a new row", removeBlocked(2, chain, live), null);
check("in place: finished stage",
  removeBlocked(0, [{ process: "Roasting", jobCardId: 1, started: true, status: "completed" }, chain[3]], live),
  "Roasting has finished, so it stays.");

// The first saved card, not yet drawn on: it goes, team or not, unless it holds
// material or the floor has asked for material for it.
const first = (extra: object) => [{ process: "Roasting", jobCardId: 1, ...extra }, chain[3]];
const requested = "The floor has asked for material for Roasting. Cancel that requisition if store hasn't issued "
  + "anything on it yet, then remove the process here — or ask an admin to cancel this job card.";
check("in place: first stage with a team on it", removeBlocked(0, first({ started: true, status: "assigned" }), live), null);
check("in place: first stage with a team on it, material asked for",
  removeBlocked(0, first({ started: true, status: "assigned", hasRequisition: true }), live), requested);
check("in place: first stage with a team on it, holding material",
  removeBlocked(0, first({ started: true, status: "assigned", holdsMaterial: true }), live),
  "Roasting already has material on it, so it can't be removed. Keep it in the chain so that material is worked.");
check("in place: first stage the floor asked material for",
  removeBlocked(0, first({ started: false, status: "unlocked", hasRequisition: true }), live), requested);
check("in place: released first stage, nothing asked", removeBlocked(0, first({ started: false, status: "unlocked" }), live), null);
// "First" is the saved chain's first card, wherever the row now sits.
check("in place: first by the saved chain",
  removeBlocked(1, [{ process: "", jobCardId: null }, { process: "Roasting", jobCardId: 1, status: "unlocked",
    hasRequisition: true }, chain[3]], live),
  requested);
check("in place: a requisition on a later card isn't the first stage's",
  removeBlocked(1, [chain[0], { process: "Sorting", jobCardId: 2, status: "locked", hasRequisition: true }, chain[3]], live),
  null);

// Later saved cards.
const after = (extra: object) => [{ process: "Roasting", jobCardId: 1, started: true, status: "completed" },
  { process: "Sorting", jobCardId: 2, ...extra }, chain[3]];
check("in place: a later running stage is stopped, not removed",
  removeBlocked(1, after({ started: true, status: "in_progress" }), live), stop("Sorting"));
check("in place: a later stage with its material in",
  removeBlocked(1, after({ started: true, status: "material_received" }), live), stop("Sorting"));
const received = "Sorting has already received material from the stage before, so it can't be removed. "
  + "Keep it in the chain so that material is worked.";
check("in place: released by a dispatch", removeBlocked(1, after({ status: "unlocked", holdsMaterial: true }), live), received);
check("in place: a team on what it received",
  removeBlocked(1, after({ started: true, status: "assigned", holdsMaterial: true }), live), received);
check("in place: waiting with nothing", removeBlocked(1, after({ status: "locked" }), live), null);
check("in place: older server, no flags", removeBlocked(1, after({ status: "unlocked" }), live), null);
check("in place: an unknown started status is stopped",
  removeBlocked(1, after({ started: true, status: "paused" }), live), stop("Sorting"));

// Every card finished: nothing can change.
check("all finished", chainFinishedNote([{ status: "completed" }, { status: "closed" }]),
  "Every stage of this chain has finished, so nothing on it can change. Plan any more as a new job card.");
check("one still running", chainFinishedNote([{ status: "completed" }, { status: "in_progress" }]), null);
check("nothing saved", chainFinishedNote([]), null);

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("job-card-edit: all checks passed");
