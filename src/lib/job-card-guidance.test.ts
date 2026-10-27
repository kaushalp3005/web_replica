// node src/lib/job-card-guidance.test.ts
import {
  lifecycleHint, refusalCode, savedButOpenNote, upstreamCard, upstreamLabel, waitingText,
} from "./job-card-guidance.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

const chain = [
  { job_card_id: 101, job_card_number: "PLAN-7-L1-S1", step_number: 1, process_name: "Sorting", status: "in_progress" },
  { job_card_id: 102, job_card_number: "PLAN-7-L1-S2", step_number: 2, process_name: "Roasting", status: "locked" },
];

// Which card a locked card waits on.
const up = upstreamCard(chain, { prev_job_card_id: 101, step_number: 2 });
check("by prev_job_card_id", up, { jobCardId: 101, number: "PLAN-7-L1-S1", process: "Sorting", status: "in_progress" });
check("by step when the link is missing", upstreamCard(chain, { prev_job_card_id: null, step_number: 2 })?.jobCardId, 101);
check("a first stage waits on nothing", upstreamCard(chain, { prev_job_card_id: null, step_number: 1 }), null);
check("a link the chain doesn't list, on step 1", upstreamCard(chain, { prev_job_card_id: 999, step_number: 1 }), null);
check("label", upstreamLabel(up!), "job card PLAN-7-L1-S1 (Sorting, in progress)");
check("label without a number", upstreamLabel({ jobCardId: 5, number: null, process: null, status: null }), "job card 5");
check("waiting, named", waitingText(up),
  "Waiting on job card PLAN-7-L1-S1 (Sorting, in progress) to send its material. This card unlocks by itself when it does.");
check("waiting, unknown", waitingText(null),
  "Waiting on the previous stage to send its material. This card unlocks by itself when it does.");

// The strip above the tabs before START.
check("locked: no 'assign a team and START' as the first instruction",
  lifecycleHint({ status: "locked", locked: true, lockedReason: "awaiting_previous_stage", upstream: up }),
  { title: "Waiting on the previous stage.",
    body: "Waiting on job card PLAN-7-L1-S1 (Sorting, in progress) to send its material. This card unlocks by itself when it does. Then assign a team on the Overview tab and press START." });
check("locked for another reason",
  lifecycleHint({ status: "unlocked", locked: true, lockedReason: "qc_hold", upstream: null })?.title,
  "Job card is locked.");
check("ready, no team yet",
  lifecycleHint({ status: "unlocked", locked: false, lockedReason: null, upstream: null })?.body,
  "Assign a team on the Overview tab, then press START to enable Output, Accounting, Quality and Remarks.");
check("team assigned",
  lifecycleHint({ status: "assigned", locked: false, lockedReason: null, upstream: null })?.body,
  "Press START above to enable Output, Accounting, Quality and Remarks.");
check("started: nothing", lifecycleHint({ status: "in_progress", locked: false, lockedReason: null, upstream: null }), null);
check("locked mid-run: the tabs say it", lifecycleHint({ status: "in_progress", locked: true, lockedReason: "qc_hold", upstream: null }), null);

// "Output saved" that leaves the batch open says so.
check("no permission", savedButOpenNote({ batchOpen: true, completionAttempted: false, canComplete: false, fgKg: 10 }),
  "Output saved. The batch is still open: completing it needs the Complete permission — ask a supervisor to open this batch and press Save.");
check("no FG kg", savedButOpenNote({ batchOpen: true, completionAttempted: false, canComplete: true, fgKg: 0 }),
  "Output saved. The batch is still open: enter the FG kg produced, then Save again to complete it.");
check("completion tried: its own message", savedButOpenNote({ batchOpen: true, completionAttempted: true, canComplete: true, fgKg: 10 }), null);
check("closed batch", savedButOpenNote({ batchOpen: false, completionAttempted: false, canComplete: false, fgKg: 0 }), null);

// Refusal codes.
check("detail code", refusalCode({ detail: { error: "missing_sign_offs", missing: ["production_head"] } }), "missing_sign_offs");
check("top-level code", refusalCode({ error: "unbalanced" }), "unbalanced");
check("text detail", refusalCode({ detail: "JC is already closed" }), null);
check("not an object", refusalCode(null), null);

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("job-card-guidance: all checks passed");
