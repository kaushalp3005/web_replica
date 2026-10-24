// node src/lib/job-card-handoff.test.ts
import { distributeSummary, sentOnNote } from "./job-card-handoff.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

// Completing / closing a stage sends its remaining output on (sent_on).
check("nothing sent on", sentOnNote({ completed: true, sent_on: null }), "");
check("no field at all", sentOnNote({ completed: true }), "");
check("sent to the next stage", sentOnNote({ sent_on: { dispatched: true, qty_kg: 50 } }),
  " 50.000 kg not yet dispatched was sent on to the next stage.");
check("shared across a merged run", sentOnNote({ sent_on: { dispatched: true, qty_kg: 20, results: [{}, {}] } }),
  " 20.000 kg not yet dispatched was shared across 2 packaging cards.");
check("the send was refused", sentOnNote({ sent_on: { error: "chain_broken", message: "The next stage of this job card was cancelled" } }),
  " The remaining output was not sent on: The next stage of this job card was cancelled.");
check("not an object", sentOnNote("x"), "");

// Distribute reports what the server did (it used to say "Distributed" regardless).
check("all shared", distributeSummary({ dispatched: true, dispatched_kg: 120, remaining_kg: 0, results: [{}, {}] }),
  "Shared 120.000 kg across 2 packaging cards.");
check("one card", distributeSummary({ dispatched: true, dispatched_kg: 20, remaining_kg: 0, results: [{}] }),
  "Shared 20.000 kg across 1 packaging card.");
check("some left", distributeSummary({ dispatched: true, dispatched_kg: 100, remaining_kg: 0.5, results: [{}, {}] }),
  "Shared 100.000 kg across 2 packaging cards. 0.500 kg is still on this card.");
check("older server without totals", distributeSummary({ dispatched: true, results: [{}, {}] }),
  "Shared the output across 2 packaging cards.");

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("job-card-handoff: all checks passed");
