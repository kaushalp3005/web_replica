// The Parties table as an Excel workbook, built in the browser (xlsx-js-style,
// loaded only when someone exports). It exports the rows the table is showing —
// a filtered table gives a filtered workbook — in the table's order, with the
// figures and calls read fresh from the database at that moment.
//
//   Parties          one row per party: the table's columns, remarks, contact
//                    number, calls made, last call, latest promise, and every
//                    call summary (newest first) in one cell
//   Call summaries   one row per summary the calling agent wrote
//   Calls            one row per call, with the conversation turn by turn
//
// Styled like the project's other exports (lib/po.ts): dark header with gold
// text, striped rows, a filter on every column. Amounts use the same number
// format as the accountant's DPD workbook. (No frozen header: this version of
// xlsx-js-style writes no sheet panes, so a "!freeze" setting is ignored.)
//
// Every cell gets its own style object. The writer adds a cell's number format
// to the style object it is given, so a shared one would carry a date format
// from one cell into the next (a 96-second call read as 5 Apr 1900).

import { AGE_BUCKETS, type DpdParty, type DpdSectionKey } from "@/lib/debtors";
import { dispositionLabel, fetchDpdExport, type DpdExportParty } from "@/lib/debtor-calls";
import type { DimensionDef } from "./_sections";

type Style = Record<string, unknown>;
interface Cell {
  v: string | number;
  t?: "s" | "n";
  z?: string;
  f?: string;
  s: Style;
}

const AMOUNT = '_ * #,##0_ ;_ * \\-#,##0_ ;_ * "-"??_ ;_ @_ ';
const WHEN = "dd mmm yyyy hh:mm";
const DAY = "dd mmm yyyy";
const CELL_LIMIT = 32000;                 // Excel holds 32,767 characters in a cell

const HEAD: Style = {
  fill: { fgColor: { rgb: "1A1A25" } },
  font: { bold: true, color: { rgb: "C8AA6E" }, sz: 11 },
  alignment: { horizontal: "center", vertical: "center", wrapText: true },
  border: { bottom: { style: "thin", color: { rgb: "3A3A4A" } } },
};
const BODY: Style = { font: { sz: 10 }, alignment: { vertical: "top" } };
const ZEBRA: Style = { ...BODY, fill: { fgColor: { rgb: "F2F2F2" } } };
const WRAP = (base: Style): Style => ({ ...base, alignment: { vertical: "top", wrapText: true } });
const TOTAL: Style = { font: { sz: 10, bold: true }, border: { top: { style: "thin", color: { rgb: "3A3A4A" } } } };

const STATUS: Record<string, string> = {
  connected: "Connected", no_answer: "No answer", busy: "Busy", failed: "Could not be placed",
  unknown: "No result received", initiated: "In progress",
};

/** "2026-10-12T11:32:05+05:30" (already IST) or "2026-10-12" -> an Excel date serial; null if unreadable. */
function excelDate(iso: string | null | undefined): number | null {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(iso) : null;
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
  return (ms - Date.UTC(1899, 11, 30)) / 86_400_000;
}

const rupees = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const day = (iso: string | null) => {
  const n = excelDate(iso);
  return n === null ? "" : new Date(Date.UTC(1899, 11, 30) + n * 86_400_000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};
const fit = (text: string) => (text.length > CELL_LIMIT ? `${text.slice(0, CELL_LIMIT)}\n… (cut here: an Excel cell holds no more)` : text);
const outcome = (status: string | null, disposition: string | null) =>
  [status ? STATUS[status] ?? status : null, disposition ? dispositionLabel(disposition) : null].filter(Boolean).join(" — ");
const promiseText = (amount: number | null, date: string | null) =>
  [amount !== null && amount !== undefined ? rupees(amount) : null, date ? `by ${day(date)}` : null].filter(Boolean).join(" ");

interface Column<T> {
  label: string;
  value: (row: T) => string | number | null;
  kind?: "amount" | "when" | "day" | "count" | "wrap";
  width?: number;
}

function sheet<T>(XLSX: typeof import("xlsx-js-style"), rows: T[], columns: Column<T>[], totals = false) {
  const data: Cell[][] = [columns.map((c) => ({ v: c.label, t: "s", s: { ...HEAD } }))];
  rows.forEach((row, i) => {
    const base = i % 2 === 1 ? ZEBRA : BODY;
    data.push(
      columns.map((c) => {
        const value = c.value(row);
        const style = (): Style => (c.kind === "wrap" ? WRAP(base) : { ...base });
        if (value === null || value === "") return { v: "", t: "s", s: style() };
        if (typeof value === "number") {
          const z = c.kind === "amount" ? AMOUNT : c.kind === "when" ? WHEN : c.kind === "day" ? DAY : "0";
          return { v: value, t: "n", z, s: style() };
        }
        return { v: fit(value), t: "s", s: style() };
      }),
    );
  });
  if (totals && rows.length > 0) {
    // The figure is written too, so a viewer that does not calculate still shows it;
    // SUBTOTAL keeps it right when the sheet is filtered in Excel.
    const last = rows.length + 1;
    data.push(
      columns.map((c, ci) => {
        if (ci === 0) return { v: `Total · ${rows.length} ${rows.length === 1 ? "party" : "parties"}`, t: "s", s: { ...TOTAL } };
        if (c.kind !== "amount") return { v: "", t: "s", s: { ...TOTAL } };
        const col = XLSX.utils.encode_col(ci);
        const sum = rows.reduce((s, r) => s + (Number(c.value(r)) || 0), 0);
        return { v: Math.round(sum * 100) / 100, t: "n", z: AMOUNT, f: `SUBTOTAL(9,${col}2:${col}${last})`, s: { ...TOTAL } };
      }),
    );
  }
  const ws = XLSX.utils.aoa_to_sheet(data as unknown as unknown[][]) as Record<string, unknown>;
  ws["!cols"] = columns.map((c, i) => {
    if (c.width) return { wch: c.width };
    const longest = Math.max(c.label.length, ...data.slice(1).map((r) => String(r[i]?.v ?? "").length));
    return { wch: Math.min(Math.max(longest + 2, 10), c.kind === "amount" ? 16 : 44) };
  });
  ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: columns.length - 1 } }) };
  return ws;
}

/**
 * Build the workbook for the rows the table is showing and save it.
 * @returns how many parties went into it
 */
export async function exportPartiesToExcel({
  section,
  label,
  dimensions,
  rows,
  filtered,
}: {
  section: DpdSectionKey;
  /** The tab's name, for the file name. */
  label: string;
  dimensions: readonly DimensionDef[];
  /** The parties the table is showing, in its order. */
  rows: readonly DpdParty[];
  filtered: boolean;
}): Promise<number> {
  const [XLSX, fresh] = await Promise.all([import("xlsx-js-style"), fetchDpdExport(section)]);
  const byId = new Map(fresh.map((p) => [p.party_id, p]));
  const parties = rows.map((r) => byId.get(r.id)).filter((p): p is DpdExportParty => p !== undefined);

  // The tab's own columns: CD - CF and Sales person, or Type and Broker.
  const DIM_COLUMN: Record<string, keyof DpdExportParty> = { division: "cd_cf", salesPerson: "sales_person", type: "type", broker: "broker" };
  const dims = dimensions.map((d) => ({ label: d.label, key: DIM_COLUMN[d.field] }));
  const who = <T extends { party: DpdExportParty }>(): Column<T>[] => [
    { label: "Customer", value: (x) => x.party.customer, width: 40 },
    ...dims.map((d) => ({ label: d.label, value: (x: T) => (x.party[d.key] as string | null) ?? null })),
  ];
  const realCalls = (p: DpdExportParty) => p.calls.filter((c) => !c.is_test);
  const promised = (p: DpdExportParty) => p.calls.find((c) => c.promise_date || c.promise_amount !== null);

  const partyRows = parties.map((party) => ({ party }));
  const partiesSheet = sheet(XLSX, partyRows, [
    ...who<{ party: DpdExportParty }>(),
    { label: "Outstanding", value: (x) => x.party.outstanding, kind: "amount" },
    ...AGE_BUCKETS.map((b) => ({
      label: b.label,
      kind: "amount" as const,
      value: (x: { party: DpdExportParty }) =>
        x.party[({ lt30: "below_30_days", d30to60: "days_30_to_60", d60to90: "days_60_to_90", gt90: "above_90_days" } as const)[b.key]],
    })),
    { label: "Remarks", value: (x) => x.party.remarks, kind: "wrap", width: 36 },
    { label: "Contact number", value: (x) => x.party.contact_number, width: 24 },
    { label: "Calls made", value: (x) => realCalls(x.party).length, kind: "count" },
    { label: "Last call", value: (x) => excelDate(realCalls(x.party)[0]?.created_at), kind: "when", width: 18 },
    { label: "Last call outcome", value: (x) => { const c = realCalls(x.party)[0]; return c ? outcome(c.status, c.disposition) : null; }, width: 30 },
    { label: "Latest promise", value: (x) => { const c = promised(x.party); return c ? promiseText(c.promise_amount, c.promise_date) : null; }, width: 26 },
    {
      label: "Call summaries (newest first)",
      kind: "wrap",
      width: 70,
      value: (x) => x.party.call_summary.map((s) => `${day(s.date)}${s.is_test ? " (test call)" : ""}: ${s.summary}`).join("\n\n") || null,
    },
  ], true);

  const summaryRows = parties.flatMap((party) => party.call_summary.map((s) => ({ party, s })));
  const summariesSheet = sheet(XLSX, summaryRows, [
    ...who<{ party: DpdExportParty; s: DpdExportParty["call_summary"][number] }>(),
    { label: "When (IST)", value: (x) => excelDate(x.s.at), kind: "when", width: 18 },
    { label: "Outcome", value: (x) => outcome(x.s.status, x.s.disposition), width: 30 },
    { label: "Promise date", value: (x) => excelDate(x.s.promise_date), kind: "day", width: 14 },
    { label: "Promise amount", value: (x) => x.s.promise_amount, kind: "amount" },
    { label: "Test call", value: (x) => (x.s.is_test ? "Yes" : "") },
    { label: "Summary", value: (x) => x.s.summary, kind: "wrap", width: 80 },
  ]);

  const callRows = parties.flatMap((party) => party.calls.map((c) => ({ party, c })));
  const callsSheet = sheet(XLSX, callRows, [
    ...who<{ party: DpdExportParty; c: DpdExportParty["calls"][number] }>(),
    { label: "When (IST)", value: (x) => excelDate(x.c.created_at), kind: "when", width: 18 },
    { label: "Outcome", value: (x) => outcome(x.c.status, x.c.disposition), width: 30 },
    { label: "Duration (sec)", value: (x) => (x.c.duration_sec !== null ? Math.round(x.c.duration_sec) : null), kind: "count" },
    { label: "Promise", value: (x) => promiseText(x.c.promise_amount, x.c.promise_date) || null, width: 24 },
    { label: "Test call", value: (x) => (x.c.is_test ? "Yes" : "") },
    {
      label: "Conversation",
      kind: "wrap",
      width: 90,
      value: (x) =>
        (x.c.conversation ?? [])
          .map((t) => `${t.role === "agent" ? "Agent" : "Customer"}: ${t.en_text || t.indic_text || ""}`.trim())
          .join("\n") || null,
    },
  ]);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, partiesSheet as never, "Parties");
  XLSX.utils.book_append_sheet(wb, summariesSheet as never, "Call summaries");
  XLSX.utils.book_append_sheet(wb, callsSheet as never, "Calls");
  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  XLSX.writeFile(wb, `Debtors DPD - ${label} - ${today}${filtered ? " (filtered)" : ""}.xlsx`);
  return parties.length;
}
