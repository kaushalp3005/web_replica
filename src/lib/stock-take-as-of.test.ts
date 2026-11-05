// node src/lib/stock-take-as-of.test.ts
import { clampAsOf, isPastView } from "./stock-take-as-of.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

const TODAY = "2026-11-05";

check("clamp: a past day is kept", clampAsOf("2026-10-28", TODAY), "2026-10-28");
check("clamp: today is kept", clampAsOf(TODAY, TODAY), TODAY);
check("clamp: a typed future day becomes today", clampAsOf("2027-01-01", TODAY), TODAY);
check("clamp: cleared stays cleared", clampAsOf("", TODAY), "");

check("past view: no date is live stock", isPastView("", TODAY), false);
check("past view: today is live stock, so posting stays open", isPastView(TODAY, TODAY), false);
check("past view: yesterday", isPastView("2026-11-04", TODAY), true);
check("past view: compares across a month end", isPastView("2026-10-31", "2026-11-01"), true);
check("past view: compares across a year end", isPastView("2026-12-31", "2027-01-01"), true);

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("stock-take-as-of: all passed");
