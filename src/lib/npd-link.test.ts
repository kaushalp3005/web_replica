// Exercises the real lib/npd-link rules. No test runner is configured in this project,
// so this runs directly on Node's native TypeScript stripping:
//
//     node src/lib/npd-link.test.ts
//
// A dev job card made from the "Development job card" menu used to have no way to name
// the request it was for (63 of 98 cards), so its request never saw it finish. The
// picker that now links them must offer exactly the requests the server will accept,
// put the ones still waiting for a card first, and say which already have one.

import { todayLocalISO, linkCandidates, linkLabel, LINKABLE_STATUSES, dispatchDateError } from "./npd-link.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

// --- today, as the date input sees it -----------------------------------------------

check("local calendar day, zero-padded",
  todayLocalISO(new Date(2026, 9, 5, 23, 30)), "2026-10-05");

check("early morning is still today, not UTC's yesterday",
  todayLocalISO(new Date(2026, 0, 1, 0, 15)), "2026-01-01");

// --- which requests can be linked ---------------------------------------------------

type Row = Parameters<typeof linkCandidates>[0][number];
const row = (o: Partial<Row>): Row => ({
  id: 1, request_id: 11111111, sample_type: "NPD", status: "BH_APPROVED",
  created_at: "2026-10-01T05:00:00Z", npd_target_name: "Date Bites", ...o,
} as Row);

const rows: Row[] = [
  row({ id: 1, request_id: 10000001, created_at: "2026-09-01T00:00:00Z" }),
  row({ id: 2, request_id: 10000002, created_at: "2026-10-01T00:00:00Z", linked_dev_jc_id: 555 }),
  row({ id: 3, request_id: 10000003, created_at: "2026-10-10T00:00:00Z" }),
  row({ id: 4, request_id: 10000004, sample_type: "BASIS_RM" }),
  row({ id: 5, request_id: 10000005, status: "CLOSED" }),
  row({ id: 6, request_id: 10000006, status: "CANCELLED" }),
  row({ id: 7, request_id: 10000007, sample_type: "TRIAL", status: "SUBMITTED", created_at: "2026-08-01T00:00:00Z" }),
];

check("only open NPD / TRIAL requests, unlinked first, newest first within each",
  linkCandidates(rows).map((r) => r.id), [3, 1, 7, 2]);

check("the statuses offered are the open ones the server accepts",
  LINKABLE_STATUSES, ["SUBMITTED", "ON_HOLD", "BH_APPROVED", "IN_PRODUCTION", "PACKING", "READY_FOR_DISPATCH"]);

// --- how a request reads in the picker ---------------------------------------------

check("number, target and customer",
  linkLabel(row({ request_id: 33461896, npd_target_name: "Roasted salted cashew",
                  company_name: "More Retail Pvt Ltd" })),
  "33461896 · Roasted salted cashew · More Retail Pvt Ltd");

check("a multi-article request says how many more",
  linkLabel(row({ request_id: 14396401, npd_target_name: "Classic Date Bites",
                  npd_targets: [{ name: "a" }, { name: "b" }, { name: "c" }],
                  company_name: "Marico Ltd" })),
  "14396401 · Classic Date Bites +2 more · Marico Ltd");

check("falls back to the customer when there is no company",
  linkLabel(row({ request_id: 1, npd_target_name: "X", company_name: null, customer_name: "Vivek" })),
  "1 · X · Vivek");

check("one that already has a card says so",
  linkLabel(row({ request_id: 2, npd_target_name: "Y", linked_dev_jc_id: 555 })),
  "2 · Y · already has job card 555");

// --- the expected dispatch date ------------------------------------------------------
// 18670297 was raised on 10-Oct dated 27-Aug, so it was overdue (and chased) from day one.

check("a past date is refused", dispatchDateError("2026-08-27", null, "2026-10-10"),
  "Expected dispatch date can't be before today");
check("today is fine", dispatchDateError("2026-10-10", null, "2026-10-10"), null);
check("blank is fine (the date is optional)", dispatchDateError("", null, "2026-10-10"), null);
check("an edit leaving an old date untouched is fine",
  dispatchDateError("2026-09-04", "2026-09-04", "2026-10-10"), null);
check("an edit moving it into the past is refused",
  dispatchDateError("2026-10-01", "2026-10-25", "2026-10-10"), "Expected dispatch date can't be before today");

if (failures) { console.error(`${failures} failed`); process.exit(1); }
console.log("npd-link: all checks passed");
