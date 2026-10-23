// node src/lib/job-card-refresh.test.ts
import { REFRESH_RETRY_MS, refreshFailureView } from "./job-card-refresh.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

// The first load failing: nothing on screen to keep, so the error page.
check("first load fails", refreshFailureView({ loadedBefore: false, notFound: false }), "error-page");
// A refresh failing once the card is on screen (Wi-Fi drop, server blip): keep
// the page — and everything typed in it — and show a retrying strip.
check("refresh fails", refreshFailureView({ loadedBefore: true, notFound: false }), "keep-page");
// The card is gone (deleted elsewhere): that is not a connection problem.
check("card not found", refreshFailureView({ loadedBefore: true, notFound: true }), "error-page");
check("not found on first load", refreshFailureView({ loadedBefore: false, notFound: true }), "error-page");

check("retries every 15 s", REFRESH_RETRY_MS, 15_000);

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("job-card-refresh: all checks passed");
