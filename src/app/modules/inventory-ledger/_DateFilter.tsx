"use client";

// Entry-date filter, ported from the Stock Take app's DatePillSelector:
// a Multi / Range / Month mode switch, month pills, quick ranges, day pills
// carrying a dot when that day has documents, and a shift split.
//
// THREE THINGS THAT WORK DIFFERENTLY HERE THAN IN THE FLOOR APP
//
// 1. THE WINDOW IS SERVER-SIDE. A ledger leaf is an aggregate — there is no date
//    on it — so this cannot filter rows already in the browser. Changing the
//    selection refetches /leaves with the window applied before the GROUP BY.
//
// 2. MULTI SENDS THE EXACT DAYS, NOT THEIR SPAN. Ticking the 6th, the 19th and
//    the 29th and sending from=6&to=29 would include the 174 days between them.
//    Measured live: 109,290 kg becomes 3,121,931 kg. So ?day= is repeated.
//
// 3. THE SHIFT IS DATA ENTRY, NOT THE WAREHOUSE FLOOR. entry_date carries no
//    time at all (0 of 1,647 rows), so the split can only come from created_at —
//    when the document was keyed in. It is labelled that way rather than as a
//    shift, because it is not one. The 14:00 cutoff is IST: read raw, 1,570 of
//    1,599 documents land in the morning; converted, 584.

import { useMemo, useState } from "react";
import type { LedgerActivityDay, LedgerShift } from "@/lib/ledger";
import { useLedgerLeaves, ALL_TIME, type DateWindow } from "./_LedgerData";

type Mode = "multi" | "range" | "month";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pillCls = (on: boolean, muted = false) =>
  `font-mono text-[11px] px-[10px] py-[4px] rounded-[7px] border transition-colors ${
    on ? "bg-[var(--aws-navy)] text-white border-[var(--aws-navy)] font-semibold"
       : muted ? "bg-white text-[var(--text-muted)] border-[var(--aws-border)] opacity-45 cursor-not-allowed"
               : "bg-white text-[var(--text-secondary)] border-[var(--aws-border)] hover:border-[var(--aws-orange)]"
  }`;

/** ISO day string in Asia/Kolkata — the business day, not the browser's.
 *
 *  Only ever called after mount (every caller is gated on `activity`, which is
 *  null until the fetch lands), so it cannot desync SSR from hydration. */
function istToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function monthKey(iso: string): string { return iso.slice(0, 7); }
function dayNum(iso: string): number { return Number(iso.slice(8, 10)); }

/** Every day of a month as ISO strings, so empty days still get a (dead) pill —
 *  a gap in the strip is information: nothing was received that day. */
function daysInMonth(key: string): string[] {
  const [y, m] = key.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: last }, (_, i) => `${key}-${String(i + 1).padStart(2, "0")}`);
}

function dowOf(iso: string): string {
  return DOW[new Date(`${iso}T00:00:00Z`).getUTCDay()];
}

/** Which days the current window actually covers, for the shift counts. */
function coveredDays(w: DateWindow, all: LedgerActivityDay[]): LedgerActivityDay[] {
  if (w.days?.length) {
    const set = new Set(w.days);
    return all.filter((d) => set.has(d.date));
  }
  if (w.from && w.to) return all.filter((d) => d.date >= w.from! && d.date <= w.to!);
  return all;
}

export function LedgerDateFilter() {
  const { dateWindow, setDateWindow, activity, source } = useLedgerLeaves();
  const [mode, setMode] = useState<Mode>("range");
  // null means "not chosen yet"; the newest month with data stands in.
  const [pickedMonth, setPickedMonth] = useState<string | null>(null);
  // Range mode is two clicks; this holds the first one.
  const [anchor, setAnchor] = useState<string | null>(null);

  const withData = useMemo(
    () => new Map((activity?.days ?? []).map((d) => [d.date, d])), [activity]);

  const months = useMemo(() => {
    const seen = new Set((activity?.days ?? []).map((d) => monthKey(d.date)));
    return [...seen].sort();
  }, [activity]);

  if (source !== "live") {
    return (
      <p className="font-mono text-[10.5px] text-[var(--text-muted)]">
        Sample data carries no dates — switch to Live to filter by entry date.
      </p>
    );
  }
  if (!activity) {
    return (
      <div className="h-[92px] rounded-[9px] bg-[var(--surface-subtle)] animate-pulse"
           aria-busy="true" aria-label="Loading available dates" />
    );
  }
  if (!activity.days.length) {
    return (
      <p className="font-mono text-[10.5px] text-[var(--text-muted)]">
        No inward documents to filter.
      </p>
    );
  }

  // Derived after the early returns, so `months` is known to be populated.
  const month = pickedMonth ?? (months.length ? months[months.length - 1] : null);
  const covered = coveredDays(dateWindow, activity.days);
  const am = covered.reduce((s, d) => s + d.am, 0);
  const pm = covered.reduce((s, d) => s + d.pm, 0);
  const cut = activity.shift_cutoff_hour;
  const active = Boolean(dateWindow.from || dateWindow.days?.length);

  const apply = (patch: Partial<DateWindow>) =>
    setDateWindow({ ...dateWindow, from: null, to: null, days: null, ...patch });

  function pickDay(iso: string) {
    if (!withData.has(iso)) return; // a day with nothing on it is not selectable
    if (mode === "multi") {
      const set = new Set(dateWindow.days ?? []);
      if (set.has(iso)) set.delete(iso); else set.add(iso);
      // Deselecting the last day means all time, not "nothing" — the server
      // rejects an empty set precisely so this cannot invert silently.
      apply({ days: set.size ? [...set].sort() : null });
      return;
    }
    if (mode === "range") {
      if (!anchor) { setAnchor(iso); apply({ from: iso, to: iso }); return; }
      const [lo, hi] = anchor <= iso ? [anchor, iso] : [iso, anchor];
      setAnchor(null);
      apply({ from: lo, to: hi });
      return;
    }
    apply({ from: iso, to: iso }); // month mode: a day click still narrows
  }

  function pickMonth(key: string) {
    setPickedMonth(key);
    if (mode !== "month") return;
    const inMonth = activity!.days.filter((d) => monthKey(d.date) === key).map((d) => d.date);
    if (inMonth.length) apply({ from: inMonth[0], to: inMonth[inMonth.length - 1] });
  }

  const today = istToday();
  const QUICK: { label: string; win: Partial<DateWindow> }[] = [
    { label: "Today", win: { from: today, to: today } },
    { label: "This week", win: { from: addDays(today, -6), to: today } },
    { label: "This month", win: { from: `${monthKey(today)}-01`, to: today } },
    { label: "Last 7 days", win: { from: addDays(today, -6), to: today } },
  ];

  const strip = month ? daysInMonth(month) : [];
  const selected = new Set(dateWindow.days ?? []);
  const inRange = (iso: string) =>
    Boolean(dateWindow.from && dateWindow.to && iso >= dateWindow.from && iso <= dateWindow.to);

  return (
    <div className="flex flex-col gap-[9px]">
      <div className="rounded-[9px] border border-[var(--aws-border)] bg-white p-[10px] flex flex-col gap-[8px]">
        {/* mode + months */}
        <div className="flex flex-wrap items-center gap-[6px]">
          <div className="inline-flex bg-[var(--surface-subtle)] rounded-[7px] p-[2px] gap-[2px]">
            {(["multi", "range", "month"] as Mode[]).map((m) => (
              <button key={m} type="button" aria-pressed={mode === m}
                      onClick={() => { setMode(m); setAnchor(null); }}
                      className={`font-mono text-[11px] px-[10px] py-[4px] rounded-[6px] ${
                        mode === m ? "bg-[var(--aws-navy)] text-white font-semibold"
                                   : "text-[var(--text-secondary)]"}`}>
                {m === "multi" ? "Multi" : m === "range" ? "Range" : "Month"}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-[5px]">
            {months.map((k) => (
              <button key={k} type="button" onClick={() => pickMonth(k)}
                      aria-pressed={month === k}
                      className={pillCls(month === k)}>
                {MONTHS[Number(k.slice(5, 7)) - 1]}
                <span className="ml-[3px] opacity-60">{k.slice(2, 4)}</span>
              </button>
            ))}
          </div>
        </div>

        {/* quick ranges */}
        <div className="flex flex-wrap gap-[5px] items-center">
          {QUICK.map((q) => (
            <button key={q.label} type="button" onClick={() => { setMode("range"); setAnchor(null); apply(q.win); }}
                    className={pillCls(dateWindow.from === q.win.from && dateWindow.to === q.win.to)}>
              {q.label}
            </button>
          ))}
          {active && (
            <button type="button" onClick={() => { setAnchor(null); setDateWindow({ ...ALL_TIME, shift: dateWindow.shift }); }}
                    className={pillCls(false)}>All time</button>
          )}
          <span className="font-mono text-[10.5px] text-[var(--text-muted)] ml-auto">
            {active
              ? `${covered.length} day${covered.length === 1 ? "" : "s"} · ${am + pm} documents`
              : `all ${activity.days.length} days · ${am + pm} documents`}
          </span>
        </div>

        {/* day pills for the chosen month */}
        <div className="flex flex-wrap gap-[5px]">
          {strip.map((iso) => {
            const has = withData.has(iso);
            const on = mode === "multi" ? selected.has(iso) : inRange(iso);
            return (
              <button
                key={iso}
                type="button"
                disabled={!has}
                onClick={() => pickDay(iso)}
                aria-pressed={on}
                title={has ? `${iso} · ${withData.get(iso)!.docs} documents` : `${iso} · nothing received`}
                className={`${pillCls(on, !has)} flex flex-col items-center leading-tight min-w-[38px] py-[3px]`}
              >
                <span className="text-[9px] opacity-70">{dowOf(iso)}</span>
                <span className="text-[12px] font-semibold">{dayNum(iso)}</span>
                {/* The dot is the whole point of the strip: it says which days
                    are worth clicking before you click them. */}
                <span className={`w-[4px] h-[4px] rounded-full mt-[2px] ${
                  has ? (on ? "bg-white" : "bg-[#1d8102]") : "bg-transparent"}`} />
              </button>
            );
          })}
        </div>
        {mode === "range" && anchor && (
          <p className="font-mono text-[10.5px] text-[var(--aws-orange)]">
            Range start {anchor} — pick the end day.
          </p>
        )}
      </div>

      {/* shift */}
      <div className="flex flex-wrap items-center gap-[6px]">
        <span className="font-mono text-[9.5px] uppercase tracking-wide text-[var(--text-muted)]">
          Keyed in
        </span>
        {([["all", "Full day", am + pm],
           ["am", `Before ${cut}:00`, am],
           ["pm", `${cut}:00 or later`, pm]] as [LedgerShift, string, number][])
          .map(([k, label, n]) => (
            <button key={k} type="button" aria-pressed={dateWindow.shift === k}
                    onClick={() => setDateWindow({ ...dateWindow, shift: k })}
                    className={pillCls(dateWindow.shift === k)}>
              {label}
              <span className="ml-[5px] px-[5px] py-[1px] rounded-[4px] bg-black/10">{n}</span>
            </button>
          ))}
        {/* Said plainly, because "shift" would be a claim about the warehouse
            floor and this is a claim about when someone typed. */}
        <span className="font-mono text-[10px] text-[var(--text-muted)]">
          entry timestamp (IST), not goods-receipt time
        </span>
      </div>
    </div>
  );
}
