// node src/lib/job-card-unsaved.test.ts
import { unsavedPrompt } from "./job-card-unsaved.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

check("one tab", unsavedPrompt(["Accounting"]),
  "You have unsaved entries on Accounting. Leave without saving them?");
check("two tabs", unsavedPrompt(["Accounting", "Quality"]),
  "You have unsaved entries on Accounting and Quality. Leave without saving them?");
check("three tabs", unsavedPrompt(["Accounting", "Quality", "Remarks"]),
  "You have unsaved entries on Accounting, Quality and Remarks. Leave without saving them?");
check("duplicates once", unsavedPrompt(["Quality", "Quality"]),
  "You have unsaved entries on Quality. Leave without saving them?");
check("none", unsavedPrompt([]), "You have unsaved entries. Leave without saving them?");

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("job-card-unsaved: all checks passed");
