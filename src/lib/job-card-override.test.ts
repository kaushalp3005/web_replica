// node src/lib/job-card-override.test.ts
import { cleanReason, completeAnywayPrompt, MIN_REASON_LEN, readOverrideOffer } from "./job-card-override.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

// A reason must say something — the server's rule (balance_override.MIN_REASON_LEN).
check("min length matches the server", MIN_REASON_LEN, 5);
check("blank", cleanReason("   "), null);
check("too short", cleanReason("ok"), null);
check("missing", cleanReason(null), null);
check("trimmed", cleanReason("  Scale recalibrated  "), "Scale recalibrated");

// A refused COMPLETE / batch close comes back through the error envelope, extra
// fields under `details` (request_context.http_exception_handler).
const envelope = {
  error: "unbalanced",
  message: "Batch 2 doesn't balance: it is off by 0.313 kg, and 0.100 kg is allowed.",
  request_id: "r1",
  details: { balance_difference_qty: -0.3126, allowed_difference_kg: 0.1, override_available: true },
};
check("envelope with the override on offer", readOverrideOffer(envelope), {
  code: "unbalanced",
  message: "Batch 2 doesn't balance: it is off by 0.313 kg, and 0.100 kg is allowed.",
  overrideAvailable: true,
});
check("envelope without it", readOverrideOffer({ ...envelope, details: { override_available: false } }).overrideAvailable, false);

// A batch completion that was saved but not completed is a 200 with
// completion_blocked carrying the flag directly.
check("completion_blocked", readOverrideOffer({
  error: "unbalanced", message: "Output saved, but…", override_available: true,
}), { code: "unbalanced", message: "Output saved, but…", overrideAvailable: true });

check("not an object", readOverrideOffer("boom"), { code: null, message: null, overrideAvailable: false });
check("flag must be literally true", readOverrideOffer({ error: "unbalanced", details: { override_available: "yes" } }).overrideAvailable, false);

check("prompt text", completeAnywayPrompt("Batch 2 doesn't balance."),
  "Batch 2 doesn't balance.\n\nYou can complete it anyway. Type the reason (at least 5 characters) — it is recorded on the job card:");

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("job-card-override: all checks passed");
