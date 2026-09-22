// Exercises lib/request-report. No test runner is configured in this project, so
// this runs directly on Node's native TypeScript stripping:
//
//     node src/lib/request-report.test.ts

import { formatSpan, issuedDelta, placeReport, spanBetween } from "./request-report.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

const RAISED = "2026-09-15T08:35:00+00:00";
const at = (iso: string) => Date.parse(iso);

// ── spans ──
check("under a minute", formatSpan(RAISED, at("2026-09-15T08:35:59+00:00")), "under a minute");
check("minutes only", formatSpan(RAISED, at("2026-09-15T08:47:30+00:00")), "12 m");
check("whole hours drop the minutes", formatSpan(RAISED, at("2026-09-15T10:35:00+00:00")), "2 h");
check("hours and minutes", formatSpan(RAISED, at("2026-09-15T10:50:00+00:00")), "2 h 15 m");
check("days and hours", formatSpan(RAISED, at("2026-09-18T12:40:00+00:00")), "3 d 4 h");
check("whole days drop the hours", formatSpan(RAISED, at("2026-09-17T08:35:00+00:00")), "2 d");
check("offsets are honoured (IST end, UTC start)", formatSpan(RAISED, at("2026-09-15T15:05:00+05:30")), "1 h");
check("negative span is not shown", formatSpan(RAISED, at("2026-09-15T08:00:00+00:00")), null);
check("missing start", formatSpan(null, at(RAISED)), null);
check("missing end", formatSpan(RAISED, null), null);
check("unreadable start", formatSpan("not a date", at(RAISED)), null);
check("NaN end", formatSpan(RAISED, Number.NaN), null);
check("between two timestamps", spanBetween(RAISED, "2026-09-15T09:20:00+00:00"), "45 m");
check("between: end missing", spanBetween(RAISED, null), null);
check("between: end unreadable", spanBetween(RAISED, "soon"), null);

// ── issued against requested ──
check("nothing issued yet", issuedDelta(null, 10), null);
check("issued exactly", issuedDelta(88.2, 88.2), { kind: "same" });
check("float noise is not a difference", issuedDelta(0.1 + 0.2, 0.3), { kind: "same" });
check("issued less", issuedDelta(80, 88.2), { kind: "less", amount: 8.2 });
check("issued more", issuedDelta(1000, 960), { kind: "more", amount: 40 });
check("sub-gram difference rounds away", issuedDelta(10.0004, 10), { kind: "same" });
check("a gram is a difference", issuedDelta(10.001, 10), { kind: "more", amount: 0.001 });

// ── card placement ── viewport 1280 x 800, card 480 x 300
const base = { width: 480, height: 300, viewportWidth: 1280, viewportHeight: 800 };
check("below the row when it fits",
  placeReport({ ...base, anchorTop: 100, anchorBottom: 140, pointerX: 400 }), { left: 352, top: 146 });
check("above the row when below does not fit",
  placeReport({ ...base, anchorTop: 600, anchorBottom: 640, pointerX: 400 }), { left: 352, top: 294 });
check("neither fits: right of the pointer, centred on the row",
  placeReport({ ...base, height: 700, anchorTop: 300, anchorBottom: 340, pointerX: 400 }), { left: 416, top: 8 });
check("neither fits, row low on screen: centred then kept inside",
  placeReport({ ...base, height: 500, anchorTop: 400, anchorBottom: 440, pointerX: 400 }), { left: 416, top: 170 });
check("neither fits, pointer on the right: left of the pointer",
  placeReport({ ...base, height: 700, anchorTop: 300, anchorBottom: 340, pointerX: 1000 }), { left: 504, top: 8 });
check("neither fits, no room either side: left margin",
  placeReport({ ...base, width: 1000, height: 700, anchorTop: 300, anchorBottom: 340, pointerX: 500 }), { left: 8, top: 8 });
check("taller than the viewport: top margin",
  placeReport({ ...base, height: 900, anchorTop: 300, anchorBottom: 340, pointerX: 400 }), { left: 416, top: 8 });
check("pointer near the right edge: kept inside",
  placeReport({ ...base, anchorTop: 100, anchorBottom: 140, pointerX: 1270 }), { left: 792, top: 146 });
check("pointer near the left edge: margin",
  placeReport({ ...base, anchorTop: 100, anchorBottom: 140, pointerX: 10 }), { left: 8, top: 146 });
check("card wider than the viewport: left margin wins",
  placeReport({ ...base, width: 1400, anchorTop: 100, anchorBottom: 140, pointerX: 600 }), { left: 8, top: 146 });
check("exactly fits below (bottom edge at the margin)",
  placeReport({ ...base, anchorTop: 446, anchorBottom: 486, pointerX: 400 }), { left: 352, top: 492 });

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("request-report: all checks passed");
