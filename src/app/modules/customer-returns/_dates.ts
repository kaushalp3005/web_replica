// Customer-Returns dates, read and shown in IST (Asia/Kolkata) whatever the
// browser's own time zone — the warehouse works to IST, and so do the CR ids
// (CR-YYYYMMDDHHMMSS), the server's date filters and the Excel export.
//
// The API sends every timestamp with its offset ("2026-10-19T02:00:00+05:30"). An
// offset-less one is a legacy naive value holding UTC (the _rtv_* columns), never
// local time — `new Date()` would read it as the browser's clock and show it 5h30m
// early. A bare "YYYY-MM-DD" (a date input, a preset bound) is an IST calendar day.
// Plain .ts with no imports so node can run the test next to it:
//
//     node src/app/modules/customer-returns/_dates.test.ts

export const CR_TIME_ZONE = "Asia/Kolkata";
const IST_OFFSET_MIN = 330; // IST is UTC+05:30 all year (no DST)
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

// YYYY-MM-DD, optionally followed by a time ("T" or a space), fractional seconds and
// an offset (Z, ±HH, ±HHMM, ±HH:MM). An offset is only read when a time is given.
const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** An API timestamp as a Date, or null when it is missing or not ISO-8601. */
export function parseCrTimestamp(v: string | null | undefined): Date | null {
  const m = ISO_RE.exec((v ?? "").trim());
  if (!m) return null;
  const [, ys, mos, ds, hs, mis, ss, frac, tz] = m;
  const y = +ys, mo = +mos, d = +ds;
  const h = hs ? +hs : 0, mi = mis ? +mis : 0, s = ss ? +ss : 0;
  const ms = frac ? +frac.slice(0, 3).padEnd(3, "0") : 0;
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null;
  if (new Date(Date.UTC(y, mo - 1, d)).getUTCMonth() !== mo - 1) return null; // 30 Feb, 31 Sep…
  let offsetMin = 0; // with a time and no offset: legacy naive, UTC
  if (!hs) offsetMin = IST_OFFSET_MIN; // a bare date: that IST calendar day, from IST midnight
  else if (tz && tz.toUpperCase() !== "Z") {
    const digits = tz.slice(1).replace(":", "");
    offsetMin = (tz[0] === "-" ? -1 : 1) * (+digits.slice(0, 2) * 60 + (digits.length > 2 ? +digits.slice(2, 4) : 0));
  }
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms) - offsetMin * MINUTE_MS);
}

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: CR_TIME_ZONE });
const DATE_FMT = fmt({ day: "2-digit", month: "short", year: "numeric" });
const DATE_TIME_FMT = fmt({ day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const SHORT_DATE_FMT = fmt({ day: "2-digit", month: "short", year: "2-digit" });
const MONTH_FMT = fmt({ month: "short", year: "numeric" });

const fmtWith = (f: Intl.DateTimeFormat) => (v: string | null | undefined): string => {
  const d = parseCrTimestamp(v);
  return d ? f.format(d) : "";
};

/** "19 Oct 2026" — the IST day of an API timestamp; "" when missing or unreadable. */
export const fmtCrDate = fmtWith(DATE_FMT);
/** "19 Oct 2026, 02:00" — IST date and time; "" when missing or unreadable. */
export const fmtCrDateTime = fmtWith(DATE_TIME_FMT);
/** "19 Oct 26" — the dashboard's compact IST date; "" when missing or unreadable. */
export const fmtCrShortDate = fmtWith(SHORT_DATE_FMT);
/** "Oct 2026" — the IST month a timestamp falls in (dashboard buckets); "" when missing. */
export const crMonthLabel = fmtWith(MONTH_FMT);

/** The IST calendar day of an instant, "YYYY-MM-DD". */
export function istYmd(d: Date): string {
  const t = new Date(d.getTime() + IST_OFFSET_MIN * MINUTE_MS);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** The IST calendar day of an API timestamp, "YYYY-MM-DD"; "" when missing or unreadable. */
export function crIstYmd(v: string | null | undefined): string {
  const d = parseCrTimestamp(v);
  return d ? istYmd(d) : "";
}

/** Today in IST, "YYYY-MM-DD". */
export function istToday(now: Date = new Date()): string {
  return istYmd(now);
}

/** Today in IST as a file-name stamp, "YYYYMMDD" (the export's customer_returns_{co}_{stamp}.xlsx). */
export function istStamp(now: Date = new Date()): string {
  return istYmd(now).replace(/-/g, "");
}

/** "DD/MM/YY" for a box label: the IST day of the CR's date, or of today while the
 *  CR has none yet (the create page prints before the header is read back). */
export function fmtCrLabelDate(v: string | null | undefined, now: Date = new Date()): string {
  const d = v ? parseCrTimestamp(v) : now;
  if (!d) return "";
  const [y, m, day] = istYmd(d).split("-");
  return `${day}/${m}/${y.slice(-2)}`;
}

export type CrDatePreset = "today" | "thisWeek" | "thisMonth" | "lastMonth" | "thisFy" | "all";

/** A dashboard preset as an inclusive [from, to] of IST days ("YYYY-MM-DD"; ["", ""]
 *  for all time). Calendar arithmetic runs on UTC-midnight Dates that stand for IST
 *  days, never on today's own Date: setMonth(-1) on 31 Oct gives "31 Sep" = 1 Oct, so
 *  the old Last Month returned the current month on 31 Oct, 31 Dec and 29-31 Mar. */
export function crPresetRange(preset: CrDatePreset, now: Date = new Date()): [string, string] {
  const today = istYmd(now);
  const [y, m, d] = today.split("-").map(Number);
  const day = (utcMs: number) => new Date(utcMs).toISOString().slice(0, 10);
  switch (preset) {
    case "today":
      return [today, today];
    case "thisWeek": { // Monday to today
      const base = Date.UTC(y, m - 1, d);
      return [day(base - ((new Date(base).getUTCDay() + 6) % 7) * DAY_MS), today];
    }
    case "thisMonth":
      return [`${y}-${pad2(m)}-01`, today];
    case "lastMonth": // Date.UTC rolls month -1 back into December; day 0 is the month before's last day
      return [day(Date.UTC(y, m - 2, 1)), day(Date.UTC(y, m - 1, 0))];
    case "thisFy": // the Indian financial year starts on 1 April
      return [`${m >= 4 ? y : y - 1}-04-01`, today];
    case "all":
      return ["", ""];
  }
}
