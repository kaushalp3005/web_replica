// node src/lib/plan-outcome.test.ts
import { approveSummary, planReleaseNote, retireSummary } from "./plan-outcome.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

// Approve says what it made, and that carded articles were left alone.
check("cards made", approveSummary({ approved: true, job_card_count: 5, articles_carded: 2 }),
  "Plan approved · 5 job cards made for 2 articles");
check("one card", approveSummary({ job_card_count: 1, articles_carded: 1 }),
  "Plan approved · 1 job card made for 1 article");
check("some already carded", approveSummary({ job_card_count: 3, articles_carded: 1, articles_already_carded: 2 }),
  "Plan approved · 3 job cards made for 1 article · 2 articles already had job cards");
check("all already carded", approveSummary({ job_card_count: 0, articles_carded: 0, articles_already_carded: 3 }),
  "Plan approved · every article already had job cards");
check("older server", approveSummary({ approved: true }), "Plan approved");

// Cancel / delete say what went with the plan and what the SO got back.
check("cancel with cards", retireSummary({ job_cards_cancelled: 6, released: { kg: 120, units: 480 } }, "cancelled"),
  "Plan cancelled · 6 job cards cancelled with it · 120.000 kg is pending on the sales order again");
check("draft, no cards", retireSummary({ job_cards_cancelled: 0, released: { kg: 45.5, units: 0 } }, "cancelled"),
  "Plan cancelled · 45.500 kg is pending on the sales order again");
check("no SO link", retireSummary({ job_cards_cancelled: 1, released: { kg: 0, units: 0 } }, "deleted"),
  "Plan deleted · 1 job card cancelled with it · nothing was reserved on a sales order");
check("not an object", retireSummary(null, "cancelled"),
  "Plan cancelled · nothing was reserved on a sales order");

// Carding the last article: approved only for someone who may approve plans.
check("approved", planReleaseNote("approved"), " · every article is carded, so the plan is now approved.");
check("waits", planReleaseNote("awaits_approval"),
  " · every article is carded; the plan now waits for a planner to approve it.");
check("nothing", planReleaseNote(undefined), "");
check("merge, per plan", planReleaseNote({ "4101": "approved", "4102": "awaits_approval" }),
  " · every article is carded, so plan 4101 is now approved; every article is carded; plan 4102 now waits for a planner to approve it.");

if (failures) { console.error(`${failures} failed`); process.exit(1); }
console.log("plan-outcome: all passed");
