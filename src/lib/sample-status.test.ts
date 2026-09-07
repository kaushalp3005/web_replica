// Exercises the real lib/sample-status rule. No test runner is configured in this project,
// so this runs directly on Node's native TypeScript stripping:
//
//     node src/lib/sample-status.test.ts
//
// The six buckets are computed SERVER-side, in the SQL behind list_requisitions, so the
// filter can be a WHERE and pagination stays honest. What lives here is the client's
// fallback: rows come back from a sessionStorage cache that may have been written before
// display_status existed, and a queue row with a blank pill reads as broken. The fallback
// can reproduce every bucket except Partial and Dispatched-by-quantity, which need the
// dispatch ledger the client has never seen — so it stops at In process rather than
// guessing, and a guess in that direction would tell someone stock had shipped.

import { displayStatusOf, isDisplayStatus, DISPLAY_STATUS_LABEL, DISPLAY_STATUS_FILTERS } from "./sample-status.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

// --- the server's answer wins ------------------------------------------------

check("server value is used as-is",
  displayStatusOf({ status: "BH_APPROVED", display_status: "PARTIAL" }), "PARTIAL");

check("server value wins even when the raw status suggests otherwise",
  displayStatusOf({ status: "ON_HOLD", display_status: "DISPATCHED" }), "DISPATCHED");

check("a blank server value falls back rather than rendering empty",
  displayStatusOf({ status: "SUBMITTED", display_status: "" }), "PENDING");

// --- the cache fallback ------------------------------------------------------

for (const [raw, want] of [
  ["DRAFT", "PENDING"], ["SUBMITTED", "PENDING"],
  ["ON_HOLD", "HOLD"],
  ["CANCELLED", "CANCELLED"], ["BH_REJECTED", "CANCELLED"],
  ["GATE_PASS_ISSUED", "DISPATCHED"], ["CLOSED", "DISPATCHED"],
  ["BH_APPROVED", "IN_PROCESS"], ["IN_PRODUCTION", "IN_PROCESS"],
  ["PACKING", "IN_PROCESS"], ["READY_FOR_DISPATCH", "IN_PROCESS"],
  // Neither is a quantity claim: INTERNALLY_DISPATCHED means stock left without a gate
  // pass, PARTIALLY_CONVERTED means the request was split into children. The client
  // cannot tell how much shipped, so it must not say.
  ["INTERNALLY_DISPATCHED", "IN_PROCESS"], ["PARTIALLY_CONVERTED", "IN_PROCESS"],
] as const) {
  check(`fallback ${raw}`, displayStatusOf({ status: raw }), want);
}

check("an unknown status falls back to Pending, not blank",
  displayStatusOf({ status: "SOMETHING_NEW" }), "PENDING");
check("a missing status falls back to Pending",
  displayStatusOf({}), "PENDING");
check("case is normalised", displayStatusOf({ status: "on_hold" }), "HOLD");

// --- labels + filters --------------------------------------------------------

check("every bucket has a label",
  Object.keys(DISPLAY_STATUS_LABEL).sort(),
  ["CANCELLED", "DISPATCHED", "HOLD", "IN_PROCESS", "PARTIAL", "PENDING"]);

check("the labels read as the user asked",
  [DISPLAY_STATUS_LABEL.PENDING, DISPLAY_STATUS_LABEL.IN_PROCESS,
   DISPLAY_STATUS_LABEL.HOLD, DISPLAY_STATUS_LABEL.PARTIAL,
   DISPLAY_STATUS_LABEL.DISPATCHED],
  ["Pending", "In process", "Hold", "Partial", "Dispatched"]);

check("the filter offers every bucket, so nothing is unreachable",
  DISPLAY_STATUS_FILTERS.map((f) => f.value).sort(),
  ["CANCELLED", "DISPATCHED", "HOLD", "IN_PROCESS", "PARTIAL", "PENDING"]);

check("the filter sends the bucket verbatim — the server matches on these exact strings",
  DISPLAY_STATUS_FILTERS.every((f) => f.value === f.value.toUpperCase()), true);

// --- the queue's remembered filter -------------------------------------------
// sample-list-cache persists the filter in sessionStorage. Before this change it held a
// RAW status; sending one of those as a display bucket matches nothing, so anyone with a
// stale tab would open the queue to an empty list and no clue why.

check("a remembered display bucket survives", isDisplayStatus("PARTIAL"), true);
check("a remembered RAW status is rejected", isDisplayStatus("BH_APPROVED"), false);
check("an empty filter is not a bucket", isDisplayStatus(""), false);
check("undefined is not a bucket", isDisplayStatus(undefined), false);
check("lowercase is accepted", isDisplayStatus("partial"), true);

console.log(failures === 0 ? "sample-status: all checks passed" : `${failures} failure(s)`);
if (failures) process.exit(1);
