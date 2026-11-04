// node src/app/modules/customer-returns/_dates.test.ts
import {
  crIstYmd, crMonthLabel, crPresetRange, fmtCrDate, fmtCrDateTime, fmtCrLabelDate, fmtCrShortDate,
  istStamp, istToday, parseCrTimestamp,
} from "./_dates.ts";

// Run as a browser far from India would: everything below must still come out in IST.
process.env.TZ = "America/Los_Angeles";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}
const at = (iso: string) => new Date(iso); // an instant, always written with its offset here
const ms = (v: string | null | undefined) => parseCrTimestamp(v)?.getTime() ?? null;

// A CR raised at 02:00 IST on 19 Oct 2026 is 2026-10-18 20:30 UTC.
const RAISED = Date.UTC(2026, 9, 18, 20, 30);

// ── parse ──────────────────────────────────────────────────────────────────
check("an offset timestamp is that instant", ms("2026-10-19T02:00:00+05:30"), RAISED);
check("a naive timestamp is UTC, not the browser's clock", ms("2026-10-18T20:30:00"), RAISED);
check("IMS text with a space and microseconds is UTC", ms("2026-10-18 20:30:00.123456"), RAISED + 123);
check("every offset spelling",
  ["2026-10-18T20:30:00Z", "2026-10-18T20:30:00+00:00", "2026-10-18T20:30:00+0000", "2026-10-18 20:30:00+00",
    "2026-10-18T17:30:00-03:00", "2026-10-19T02:00+05:30"].map(ms),
  Array(6).fill(RAISED));
check("a bare date is that IST day from IST midnight", ms("2026-10-19"), Date.UTC(2026, 9, 18, 18, 30));
check("missing or unreadable is null",
  [null, undefined, "", "  ", "garbage", "19-10-2026", "2026-02-30T00:00:00", "2026-13-01", "2026-10-19T25:00:00"].map(ms),
  Array(9).fill(null));

// ── format (IST, whatever the browser's zone) ──────────────────────────────
check("date of an offset and of a naive value", [fmtCrDate("2026-10-19T02:00:00+05:30"), fmtCrDate("2026-10-18T20:30:00")],
  ["19 Oct 2026", "19 Oct 2026"]);
check("date-time of an offset and of a naive value",
  [fmtCrDateTime("2026-10-19T02:00:00+05:30"), fmtCrDateTime("2026-10-18T20:30:00.123456")],
  ["19 Oct 2026, 02:00", "19 Oct 2026, 02:00"]);
check("a 12:58 IST create shows 12:58, not 07:28", fmtCrDateTime("2026-10-19T07:28:00"), "19 Oct 2026, 12:58");
check("short date, of a timestamp and of a date input", [fmtCrShortDate("2026-10-18T20:30:00"), fmtCrShortDate("2026-10-19")],
  ["19 Oct 26", "19 Oct 26"]);
check("missing formats as empty", [fmtCrDate(null), fmtCrDateTime(""), fmtCrShortDate("garbage"), crMonthLabel(undefined)],
  ["", "", "", ""]);

// ── IST days and months ────────────────────────────────────────────────────
check("the IST day of a timestamp", [crIstYmd("2026-10-18T20:30:00"), crIstYmd("2026-10-19T02:00:00+05:30"), crIstYmd(null)],
  ["2026-10-19", "2026-10-19", ""]);
check("the IST day starts at 18:30 UTC", [crIstYmd("2026-10-18T18:29:59Z"), crIstYmd("2026-10-18T18:30:00Z")],
  ["2026-10-18", "2026-10-19"]);
check("month buckets are IST months", [crMonthLabel("2026-10-31T19:00:00"), crMonthLabel("2026-10-31T18:00:00+00:00")],
  ["Nov 2026", "Oct 2026"]);
check("today and the file stamp are IST", [istToday(at("2026-10-18T20:30:00Z")), istStamp(at("2026-10-18T20:30:00Z"))],
  ["2026-10-19", "20261019"]);

// ── box labels ─────────────────────────────────────────────────────────────
check("a label shows the IST day of the CR date", fmtCrLabelDate("2026-10-18T20:30:00"), "19/10/26");
check("an undated label shows today in IST", fmtCrLabelDate(null, at("2026-10-18T20:30:00Z")), "19/10/26");
check("an unreadable CR date prints blank", fmtCrLabelDate("garbage"), "");

// ── dashboard presets ──────────────────────────────────────────────────────
const preset = (p: Parameters<typeof crPresetRange>[0], iso: string) => crPresetRange(p, at(iso));
check("Last Month on 31 Oct is September", preset("lastMonth", "2026-10-31T10:00:00+05:30"), ["2026-09-01", "2026-09-30"]);
check("Last Month on 31 Dec is November", preset("lastMonth", "2026-12-31T10:00:00+05:30"), ["2026-11-01", "2026-11-30"]);
check("Last Month on 29-31 Mar is February",
  ["2027-03-29", "2027-03-30", "2027-03-31"].map((d) => preset("lastMonth", `${d}T10:00:00+05:30`)),
  Array(3).fill(["2027-02-01", "2027-02-28"]));
check("Last Month in a leap March", preset("lastMonth", "2028-03-31T10:00:00+05:30"), ["2028-02-01", "2028-02-29"]);
check("Last Month in January is last December", preset("lastMonth", "2027-01-15T10:00:00+05:30"), ["2026-12-01", "2026-12-31"]);
check("Last Month just after IST midnight on 1 Nov is October",
  preset("lastMonth", "2026-10-31T19:00:00Z"), ["2026-10-01", "2026-10-31"]);
check("Today at 02:00 IST is the IST day", preset("today", "2026-10-18T20:30:00Z"), ["2026-10-19", "2026-10-19"]);
check("This Week runs Monday to today",
  [preset("thisWeek", "2026-10-21T10:00:00+05:30"), preset("thisWeek", "2026-10-25T23:00:00+05:30"), preset("thisWeek", "2026-10-19T00:10:00+05:30")],
  [["2026-10-19", "2026-10-21"], ["2026-10-19", "2026-10-25"], ["2026-10-19", "2026-10-19"]]);
check("This Month", preset("thisMonth", "2026-10-18T20:30:00Z"), ["2026-10-01", "2026-10-19"]);
check("This FY starts on 1 April",
  [preset("thisFy", "2026-10-19T10:00:00+05:30"), preset("thisFy", "2027-03-31T10:00:00+05:30"), preset("thisFy", "2027-03-31T19:00:00Z")],
  [["2026-04-01", "2026-10-19"], ["2026-04-01", "2027-03-31"], ["2027-04-01", "2027-04-01"]]);
check("All Time", preset("all", "2026-10-19T10:00:00+05:30"), ["", ""]);

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("customer-returns dates: all passed");
