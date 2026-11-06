// node src/lib/job-card-send-on.test.ts
import {
  closeConfirmMessage, completedCardPlan, dispatchPrefill, readDispatchQty, remainingToSendKg,
  SEND_ON_EPS_KG, sendOnTarget,
} from "./job-card-send-on.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

const producer = { output_kind: "WIP", next_job_card_id: 75009889 };
const merged = { output_kind: "SFG", next_job_card_id: null, process_group_id: 7 };
const packaging = { output_kind: "FG", next_job_card_id: null };

// What is left: the server's figure first, else output minus dispatched.
check("server figure", remainingToSendKg({ ...producer, remaining_to_send_kg: 12.346,
  section_5_output: { fg_actual_kg: 100 }, dispatched_to_next_kg: 0 }), 12.346);
check("server says nothing left", remainingToSendKg({ ...producer, remaining_to_send_kg: 0,
  section_5_output: { fg_actual_kg: 100 } }), 0);
check("older server: local figure", remainingToSendKg({ ...producer,
  section_5_output: { fg_actual_kg: "150.25" }, dispatched_to_next_kg: "100" }), 50.25);
check("older server: to the gram", remainingToSendKg({ ...producer,
  section_5_output: { fg_actual_kg: 0.1 + 0.2 }, dispatched_to_next_kg: 0 }), 0.3);
check("under half a gram is nothing", remainingToSendKg({ ...producer, remaining_to_send_kg: 0.0004 }), 0);
check("never below nothing", remainingToSendKg({ ...producer,
  section_5_output: { fg_actual_kg: 90 }, dispatched_to_next_kg: 100 }), 0);
check("one epsilon with the server", SEND_ON_EPS_KG, 0.0005);

// Where it goes.
check("next card", sendOnTarget(producer), { kind: "next", jobCardId: 75009889 });
check("merged run", sendOnTarget(merged), { kind: "group" });
check("last stage", sendOnTarget(packaging), null);
check("FG in a group has nowhere", sendOnTarget({ ...packaging, process_group_id: 7 }), null);

// The completed card's bar: a send-on button only when something is left; CLOSE JC always.
check("30 g left: dispatch (the 50 g tolerance used to hide it)",
  completedCardPlan({ ...producer, remaining_to_send_kg: 0.03 }).send, "dispatch");
check("nothing left: close only", completedCardPlan({ ...producer, remaining_to_send_kg: 0 }).send, null);
check("merged run with output left", completedCardPlan({ ...merged, remaining_to_send_kg: 20 }).send,
  "distribute");
check("last stage never sends", completedCardPlan({ ...packaging, remaining_to_send_kg: 0,
  section_5_output: { fg_actual_kg: 500 } }).send, null);

// CLOSE JC's confirm.
const base = "Close this job card after sign-offs? It will become read-only.";
check("close with kg left names the next card",
  closeConfirmMessage({ ...producer, remaining_to_send_kg: 12.346 }),
  `${base}\n\nClosing sends the remaining 12.346 kg on to job card 75009889.`);
// A merged run's packaging cards may all have finished, so it promises nothing.
check("close on a merged run",
  closeConfirmMessage({ ...merged, remaining_to_send_kg: 20 }),
  `${base}\n\nClosing shares the remaining 20.000 kg across this merged run's packaging cards that are still open; ` +
  "anything that can't be sent stays recorded on this card.");
check("close with nothing left", closeConfirmMessage({ ...producer, remaining_to_send_kg: 0 }), base);
check("close the last stage", closeConfirmMessage({ ...packaging, section_5_output: { fg_actual_kg: 9 } }), base);

// The Dispatch prompt: prefilled DOWN to the gram, capped at what is left.
check("prefill 12.346", dispatchPrefill(12.346), "12.346");
check("prefill never rounds up", dispatchPrefill(12.3469), "12.346");
check("prefill float noise", dispatchPrefill(12.345999999999), "12.346");
check("prefill a whole kg", dispatchPrefill(50), "50.000");
check("the prefill is accepted", readDispatchQty(dispatchPrefill(12.346), 12.346), { qty: 12.346 });
check("the old rounded-up default is refused", "error" in readDispatchQty("12.35", 12.346), true);
check("typed to the gram", readDispatchQty("20.0004", 50), { qty: 20 });
check("over what is left", readDispatchQty("50.001", 50),
  { error: "Only 50.000 kg is left to send on. Enter 50.000 kg or less." });
check("blank", "error" in readDispatchQty("", 50), true);
check("zero", "error" in readDispatchQty("0", 50), true);
check("not a number", "error" in readDispatchQty("abc", 50), true);

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("job-card-send-on: all checks passed");
