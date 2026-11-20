"use client";

// Pending Orders dashboard: the "Pending orders - Floor wise plan" sheet as a
// screen. Per SO line, ordered − invoiced = pending (invoices come from SO
// Creation's Sales Register upload). Filters sit in one row above everything;
// the KPI tiles and the four bar charts describe exactly the rows in the
// table below, and clicking a bar filters by it. Money columns only appear for
// roles that may see cost (the server leaves them out otherwise).

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth, useRequireModuleAccess, useHasPermission } from "@/lib/user";
import { friendlyApiError } from "@/lib/apiErrors";
import { downloadPendingOrders } from "@/lib/so";
import {
  AGEING_ORDER,
  fetchPendingOrders,
  formatCell,
  isNumericColumn,
  num,
  type PendingOrdersResponse,
  type PendingRow,
} from "@/lib/pendingOrders";
import { SoChrome } from "../_chrome";

// One hue for every bar: each chart compares magnitudes of one measure.
const BAR = "#2a78d6";
const BAR_MUTED = "#c3c2b7";
const PAGE_SIZE = 100;
const NOT_PLANNED = "Not planned";

type Status = "pending" | "partly" | "not_dispatched" | "dispatched" | "all";
type Measure = "value" | "kg" | "lines";
type Filters = { company: string; packed: string; floor: string; ageing: string; customer: string };
const NO_FILTERS: Filters = { company: "", packed: "", floor: "", ageing: "", customer: "" };

const STATUS_LABEL: Record<Status, string> = {
  pending: "Pending",
  partly: "Partly dispatched",
  not_dispatched: "Not dispatched",
  dispatched: "Fully dispatched",
  all: "All lines",
};

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const pendingOf = (r: PendingRow) => num(r["Pending Qty."]);
const sentOf = (r: PendingRow) => num(r["Dispatch Qty."]);

function statusOk(r: PendingRow, s: Status): boolean {
  const p = pendingOf(r), d = sentOf(r);
  if (s === "pending") return p > 0;
  if (s === "partly") return p > 0 && d > 0;
  if (s === "not_dispatched") return p > 0 && d === 0;
  if (s === "dispatched") return p === 0;
  return true;
}

function measureOf(r: PendingRow, m: Measure): number {
  if (m === "value") return num(r["Pending Value"]);
  if (m === "kg") return num(r["Total Kg"]);
  return 1;
}

function fmtMeasure(v: number, m: Measure): string {
  if (m === "value") {
    return v >= 1e7 ? `₹${(v / 1e7).toLocaleString("en-IN", { maximumFractionDigits: 2 })} cr`
      : v >= 1e5 ? `₹${(v / 1e5).toLocaleString("en-IN", { maximumFractionDigits: 1 })} L`
        : `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
  }
  if (m === "kg") {
    return v >= 1000 ? `${(v / 1000).toLocaleString("en-IN", { maximumFractionDigits: 1 })} t`
      : `${v.toLocaleString("en-IN", { maximumFractionDigits: 0 })} kg`;
  }
  return `${v.toLocaleString("en-IN")} line${v === 1 ? "" : "s"}`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export default function PendingOrdersPage() {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);
  useRequireModuleAccess("production/so-creation", router.replace);
  const canView = useHasPermission("so", null, null, "view");

  // The last finished load, tagged with the reload it answered: loading is
  // "the current reload hasn't answered yet", and the previous data stays on
  // screen meanwhile.
  const [reloadKey, setReloadKey] = useState(0);
  const [result, setResult] = useState<{ key: number; data: PendingOrdersResponse | null; error: string | null }>(
    { key: -1, data: null, error: null });
  const data = result.data;
  const loading = result.key !== reloadKey;
  const error = result.key === reloadKey ? result.error : null;

  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>("pending");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [measurePick, setMeasure] = useState<Measure>("value");
  // Roles that may not see cost get no value column, so no value measure.
  const measure: Measure = data && !data.sees_cost && measurePick === "value" ? "kg" : measurePick;
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 } | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadMsg, setDownloadMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // The page number belongs to one set of filters: change them and it is 1 again.
  const filterKey = JSON.stringify([status, filters, query, sort]);
  const [pager, setPager] = useState({ key: filterKey, page: 1 });
  const page = pager.key === filterKey ? pager.page : 1;
  const setPage = (fn: (p: number) => number) => setPager({ key: filterKey, page: fn(page) });

  useEffect(() => {
    if (!authed) return;
    const c = new AbortController();
    fetchPendingOrders(c.signal)
      .then((d) => setResult({ key: reloadKey, data: d, error: null }))
      .catch((e) => {
        if (!c.signal.aborted) setResult((r) => ({ key: reloadKey, data: r.data, error: friendlyApiError(e) }));
      });
    return () => c.abort();
  }, [authed, reloadKey]);

  // Search waits for a pause in typing: 6,000+ rows are filtered on each change.
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim().toLowerCase()), 200);
    return () => clearTimeout(t);
  }, [search]);

  const options = useMemo(() => {
    const rows = data?.rows ?? [];
    const distinct = (col: string) =>
      [...new Set(rows.map((r) => str(r[col])).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    return { company: distinct("Company"), packed: distinct("Packed to be"), floor: distinct("Floor") };
  }, [data]);

  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    return all.filter((r) => {
      if (!statusOk(r, status)) return false;
      if (filters.company && str(r["Company"]) !== filters.company) return false;
      if (filters.packed && (str(r["Packed to be"]) || NOT_PLANNED) !== filters.packed) return false;
      if (filters.floor && (str(r["Floor"]) || NOT_PLANNED) !== filters.floor) return false;
      if (filters.ageing && str(r["Ageing Days"]) !== filters.ageing) return false;
      if (filters.customer && str(r["Customer Name"]) !== filters.customer) return false;
      if (query) {
        const hay = `${str(r["SO No"])} ${str(r["PO No"])} ${str(r["Customer Name"])} ${str(r["Description"])} ${str(r["Invoice No."])}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });
  }, [data, status, filters, query]);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const { col, dir } = sort;
    const numeric = isNumericColumn(col);
    return [...rows].sort((a, b) => {
      const x = a[col], y = b[col];
      if (x === undefined && y === undefined) return 0;
      if (x === undefined) return 1;            // blanks last either way
      if (y === undefined) return -1;
      return (numeric ? num(x) - num(y) : str(x).localeCompare(str(y))) * dir;
    });
  }, [rows, sort]);

  const kpi = useMemo(() => {
    let pendingValue = 0, sentValue = 0, kg = 0, noKg = 0, partly = 0, over20 = 0, over20Value = 0;
    for (const r of rows) {
      pendingValue += num(r["Pending Value"]);
      sentValue += num(r["Dispatch Value"]);
      if (r["Total Kg"] === undefined) { if (pendingOf(r) > 0) noKg += 1; } else kg += num(r["Total Kg"]);
      if (pendingOf(r) > 0 && sentOf(r) > 0) partly += 1;
      if (str(r["Ageing Days"]) === ">20" && pendingOf(r) > 0) { over20 += 1; over20Value += num(r["Pending Value"]); }
    }
    return { pendingValue, sentValue, kg, noKg, partly, over20, over20Value };
  }, [rows]);

  // What the saved invoices did to every SO line, whatever the filters: the
  // default "Pending" view hides fully dispatched lines, so without this the
  // effect of saving a Sales Register isn't visible anywhere.
  const overall = useMemo(() => {
    let full = 0, partly = 0, none = 0, invoiced = 0;
    for (const r of data?.rows ?? []) {
      const p = pendingOf(r), d = sentOf(r);
      if (p <= 0) full += 1; else if (d > 0) partly += 1; else none += 1;
      invoiced += num(r["Dispatch Value"]);
    }
    return { full, partly, none, invoiced };
  }, [data]);

  const groups = useMemo(() => {
    const by = (key: (r: PendingRow) => string) => {
      const m = new Map<string, { value: number; lines: number; kg: number }>();
      for (const r of rows) {
        const k = key(r);
        const g = m.get(k) ?? { value: 0, lines: 0, kg: 0 };
        g.value += measureOf(r, measure);
        g.lines += 1;
        g.kg += num(r["Total Kg"]);
        m.set(k, g);
      }
      return m;
    };
    const ranked = (m: Map<string, { value: number; lines: number; kg: number }>, top: number) =>
      [...m.entries()].sort((a, b) => b[1].value - a[1].value).slice(0, top)
        .map(([label, g]) => ({ label, ...g }));
    const ageing = by((r) => str(r["Ageing Days"]) || "—");
    return {
      ageing: AGEING_ORDER.filter((b) => ageing.has(b)).map((b) => ({ label: b, ...ageing.get(b)! })),
      packed: ranked(by((r) => str(r["Packed to be"]) || NOT_PLANNED), 6),
      floor: ranked(by((r) => str(r["Floor"]) || NOT_PLANNED), 8),
      customer: ranked(by((r) => str(r["Customer Name"]) || "—"), 10),
    };
  }, [rows, measure]);

  const toggle = (key: keyof Filters, value: string) =>
    setFilters((f) => ({ ...f, [key]: f[key] === value ? "" : value }));

  async function onDownload() {
    setDownloading(true);
    setDownloadMsg(null);
    try {
      const n = await downloadPendingOrders();
      setDownloadMsg({ kind: "ok", text: `Downloaded · ${n.toLocaleString("en-IN")} pending SO lines.` });
    } catch (e) {
      setDownloadMsg({ kind: "err", text: `Download failed: ${friendlyApiError(e)}` });
    } finally {
      setDownloading(false);
    }
  }

  const anyFilter = Object.values(filters).some(Boolean) || !!query || status !== "pending";
  const cols = data?.columns ?? [];
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const shown = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const inv = data?.invoices;

  return (
    <SoChrome title="Pending Orders" showBackToSoCreation>
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div className="min-w-0">
          <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">Pending Orders</h1>
          <p className="text-[13px] text-[var(--text-secondary)] mt-1">
            Per SO line: ordered − invoiced = pending, in the Pending orders sheet&apos;s columns
            {data ? ` · as of ${fmtDate(data.as_of)}` : ""}.
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            disabled={loading}
            className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[var(--text-primary)] hover:border-[var(--aws-navy)] disabled:opacity-50"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
          {canView ? (
            <button
              type="button"
              onClick={onDownload}
              disabled={downloading}
              title="The Pending orders sheet as Excel: every line still pending (not the filters on this screen)"
              className="h-8 px-3 text-[12px] rounded-[2px] font-semibold border bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white disabled:opacity-50"
            >
              {downloading ? "Preparing…" : "Download Excel"}
            </button>
          ) : null}
        </div>
      </div>
      {downloadMsg ? (
        <p role="status" className={["-mt-2 mb-3 text-[12px]", downloadMsg.kind === "ok"
          ? "text-[var(--text-success)]" : "text-[var(--aws-error)]"].join(" ")}>{downloadMsg.text}</p>
      ) : null}

      {inv ? (
        <div className={["mb-4 px-3 py-2 text-[12px] rounded-sm border",
          inv.invoices ? "border-[var(--aws-border)] bg-white text-[var(--text-secondary)]"
            : "border-[#ffe69c] bg-[#fff8e6] text-[#664d03]"].join(" ")}>
          {!inv.tables ? "The invoice tables aren't set up yet, so nothing counts as dispatched."
            : inv.invoices ? <>Dispatch comes from <strong className="text-[var(--text-primary)]">{inv.invoices.toLocaleString("en-IN")}</strong> saved
              invoices ({fmtDate(inv.first_date)} – {fmtDate(inv.last_date)}), {inv.lines_on_so_line.toLocaleString("en-IN")} items tied to an SO line.
              Of the {data?.so_lines.toLocaleString("en-IN")} SO lines: <strong className="text-[var(--text-primary)]">{overall.full.toLocaleString("en-IN")}</strong> fully
              dispatched, {overall.partly.toLocaleString("en-IN")} partly, {overall.none.toLocaleString("en-IN")} with no invoice yet
              {data?.sees_cost ? <> · {fmtMeasure(overall.invoiced, "value")} invoiced against them</> : null}.
              SOs dispatched before {fmtDate(inv.first_date)} still count as pending until that period&apos;s Sales Register is saved.</>
              : <>No invoices saved yet, so every line counts as not dispatched. Upload and Save the Sales Register on SO Creation.</>}
        </div>
      ) : null}

      {error ? (
        <div className="mb-4 px-3 py-2 text-[12px] rounded-sm border border-[var(--aws-error)] text-[var(--aws-error)] bg-white">
          Couldn&apos;t load pending orders: {error}
        </div>
      ) : null}

      {/* Filters: one row above the tiles and charts. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search SO / PO / customer / article / invoice"
          aria-label="Search"
          className="h-8 w-[280px] max-w-full px-2 text-[12px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[var(--aws-navy)]"
        />
        <div role="group" aria-label="Status" className="inline-flex rounded-[2px] border border-[var(--aws-border-strong)] overflow-hidden">
          {(Object.keys(STATUS_LABEL) as Status[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              aria-pressed={status === s}
              className={["h-8 px-2.5 text-[12px] border-r last:border-r-0 border-[var(--aws-border-strong)]",
                status === s ? "bg-[var(--aws-navy)] text-white" : "bg-white text-[var(--text-primary)] hover:bg-[var(--surface-subtle)]"].join(" ")}
            >
              {STATUS_LABEL[s]}
            </button>
          ))}
        </div>
        <Select label="Company" value={filters.company} options={options.company} onChange={(v) => setFilters((f) => ({ ...f, company: v }))} />
        <Select label="Packed to be" value={filters.packed} options={[...options.packed, NOT_PLANNED]} onChange={(v) => setFilters((f) => ({ ...f, packed: v }))} />
        <Select label="Floor" value={filters.floor} options={[...options.floor, NOT_PLANNED]} onChange={(v) => setFilters((f) => ({ ...f, floor: v }))} />
        <Select label="Ageing" value={filters.ageing} options={[...AGEING_ORDER]} onChange={(v) => setFilters((f) => ({ ...f, ageing: v }))} />
        {filters.customer ? (
          <button type="button" onClick={() => setFilters((f) => ({ ...f, customer: "" }))}
            className="h-8 px-2.5 text-[12px] rounded-[2px] border border-[var(--aws-navy)] bg-[#f1f4f9] text-[var(--text-primary)] max-w-[260px] truncate"
            title="Clear the customer filter">
            Customer: {filters.customer} ✕
          </button>
        ) : null}
        {anyFilter ? (
          <button type="button"
            onClick={() => { setFilters(NO_FILTERS); setSearch(""); setStatus("pending"); }}
            className="h-8 px-2 text-[12px] text-[var(--aws-link)] hover:underline">
            Clear filters
          </button>
        ) : null}
      </div>

      {loading && !data ? (
        <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[13px] text-[var(--text-secondary)]">
          Loading pending orders…
        </div>
      ) : data ? (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-2 mb-4">
            <Stat label="SO lines" value={rows.length.toLocaleString("en-IN")}
              sub={`of ${data.so_lines.toLocaleString("en-IN")} · ${kpi.partly.toLocaleString("en-IN")} partly dispatched`} />
            {data.sees_cost ? (
              <Stat label="Pending value" value={fmtMeasure(kpi.pendingValue, "value")}
                sub={`${fmtMeasure(kpi.sentValue, "value")} already invoiced on these lines`} />
            ) : null}
            <Stat label="Pending weight" value={fmtMeasure(kpi.kg, "kg")}
              sub={kpi.noKg ? `${kpi.noKg.toLocaleString("en-IN")} pending lines without kg` : "every pending line has kg"} />
            <Stat label="Over 20 days" value={kpi.over20.toLocaleString("en-IN")}
              sub={data.sees_cost ? `${fmtMeasure(kpi.over20Value, "value")} pending` : "pending lines ordered > 20 days ago"} />
            <Stat label="Customers" value={new Set(rows.map((r) => str(r["Customer Name"]))).size.toLocaleString("en-IN")}
              sub={`${new Set(rows.map((r) => str(r["SO No"]))).size.toLocaleString("en-IN")} SOs`} />
          </div>

          <div className="mb-2 flex items-center gap-2 text-[12px] text-[var(--text-secondary)]">
            <span>Charts show</span>
            <div role="group" aria-label="Chart measure" className="inline-flex rounded-[2px] border border-[var(--aws-border-strong)] overflow-hidden">
              {(["value", "kg", "lines"] as Measure[]).filter((m) => m !== "value" || data.sees_cost).map((m) => (
                <button key={m} type="button" onClick={() => setMeasure(m)} aria-pressed={measure === m}
                  className={["h-7 px-2.5 border-r last:border-r-0 border-[var(--aws-border-strong)]",
                    measure === m ? "bg-[var(--aws-navy)] text-white" : "bg-white text-[var(--text-primary)] hover:bg-[var(--surface-subtle)]"].join(" ")}>
                  {m === "value" ? "Pending value" : m === "kg" ? "Pending kg" : "Lines"}
                </button>
              ))}
            </div>
            <span className="hidden sm:inline">· click a bar to filter by it</span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-4">
            <BarCard title="By ageing" note="days since the order" rows={groups.ageing} measure={measure}
              active={filters.ageing} onPick={(l) => toggle("ageing", l)} />
            <BarCard title="By factory (Packed to be)" note="from the linked plan's packing card" rows={groups.packed}
              measure={measure} active={filters.packed} onPick={(l) => toggle("packed", l)} />
            <BarCard title="By floor" note="top 8" rows={groups.floor} measure={measure}
              active={filters.floor} onPick={(l) => toggle("floor", l)} />
            <BarCard title="Top customers" note="top 10" rows={groups.customer} measure={measure}
              active={filters.customer} onPick={(l) => toggle("customer", l)} />
          </div>

          <div className="bg-white border border-[var(--aws-border)] rounded-md">
            <div className="px-3 py-2 flex flex-wrap items-center gap-2 border-b border-[var(--aws-border)] text-[12px] text-[var(--text-secondary)]">
              <span>
                <strong className="text-[var(--text-primary)]">{sorted.length.toLocaleString("en-IN")}</strong> rows ·{" "}
                {STATUS_LABEL[status].toLowerCase()} · {cols.length} columns
              </span>
              <span className="ml-auto flex items-center gap-2">
                <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
                  className="h-7 px-2 rounded-[2px] border border-[var(--aws-border-strong)] bg-white disabled:opacity-40">‹ Prev</button>
                <span>Page {page} of {pages}</span>
                <button type="button" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}
                  className="h-7 px-2 rounded-[2px] border border-[var(--aws-border-strong)] bg-white disabled:opacity-40">Next ›</button>
              </span>
            </div>
            <div className="max-h-[70vh] overflow-auto">
              <table className="text-[12px] border-collapse">
                <thead className="sticky top-0 z-10">
                  <tr>
                    {cols.map((c) => {
                      const on = sort?.col === c;
                      return (
                        <th key={c} scope="col"
                          aria-sort={on ? (sort!.dir === 1 ? "ascending" : "descending") : "none"}
                          className="bg-[#ffff00] border border-[#c9c9a0] px-2 py-1.5 font-semibold text-[var(--text-primary)] whitespace-nowrap text-left">
                          <button type="button" className="inline-flex items-center gap-1 hover:underline"
                            onClick={() => setSort((s) => (s?.col === c ? (s.dir === 1 ? { col: c, dir: -1 } : null) : { col: c, dir: 1 }))}>
                            {c}{on ? (sort!.dir === 1 ? " ▲" : " ▼") : ""}
                          </button>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {shown.length === 0 ? (
                    <tr><td colSpan={cols.length} className="px-3 py-6 text-center text-[var(--text-secondary)]">No SO lines match these filters.</td></tr>
                  ) : shown.map((r) => (
                    <tr key={r.so_line_id}
                      className={["hover:bg-[#f4f8fd]", pendingOf(r) === 0 ? "text-[var(--text-muted)]" : "text-[var(--text-primary)]"].join(" ")}>
                      {cols.map((c) => (
                        <td key={c}
                          className={["border border-[var(--aws-border)] px-2 py-1 whitespace-nowrap",
                            isNumericColumn(c) ? "text-right tabular-nums" : "",
                            c === "Description" || c === "Customer Name" || c === "Invoice No." || c === "Remark"
                              ? "max-w-[280px] truncate" : ""].join(" ")}
                          title={c === "Description" || c === "Customer Name" || c === "Invoice No." || c === "Remark" ? str(r[c]) : undefined}>
                          {formatCell(c, r[c])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}
    </SoChrome>
  );
}

function Select({ label, value, options, onChange }: {
  label: string; value: string; options: string[]; onChange: (v: string) => void;
}) {
  return (
    <label className="inline-flex items-center gap-1 text-[12px] text-[var(--text-secondary)]">
      <span className="sr-only">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}
        className={["h-8 px-2 text-[12px] rounded-[2px] bg-white border outline-none max-w-[200px]",
          value ? "border-[var(--aws-navy)] text-[var(--text-primary)]" : "border-[var(--aws-border-strong)] text-[var(--text-secondary)]"].join(" ")}>
        <option value="">{label}: all</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 bg-white border border-[var(--aws-border)] rounded-md px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wide font-semibold text-[var(--text-muted)]">{label}</div>
      <div className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)] tabular-nums truncate" title={value}>{value}</div>
      {sub ? <div className="text-[11px] text-[var(--text-secondary)] truncate" title={sub}>{sub}</div> : null}
    </div>
  );
}

// Horizontal bars, one hue, on one baseline: value at the tip, a tooltip on
// hover / focus with the lines and kg behind it, and a click filters by it
// (the picked bar stays blue, the others go gray).
function BarCard({ title, note, rows, measure, active, onPick }: {
  title: string;
  note?: string;
  rows: { label: string; value: number; lines: number; kg: number }[];
  measure: Measure;
  active: string;
  onPick: (label: string) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(0, ...rows.map((r) => r.value));
  return (
    <section className="bg-white border border-[var(--aws-border)] rounded-md p-3 min-w-0">
      <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">
        {title}{note ? <span className="ml-1.5 font-normal text-[11px] text-[var(--text-muted)]">· {note}</span> : null}
      </h2>
      {rows.length === 0 ? (
        <p className="mt-3 text-[12px] text-[var(--text-secondary)]">Nothing to show for these filters.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {rows.map((r, i) => {
            const share = max > 0 ? r.value / max : 0;
            const dim = !!active && active !== r.label;
            return (
              <li key={r.label} className="relative">
                <button
                  type="button"
                  onClick={() => onPick(r.label)}
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover((h) => (h === i ? null : h))}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover((h) => (h === i ? null : h))}
                  aria-pressed={active === r.label}
                  aria-label={`${r.label}: ${fmtMeasure(r.value, measure)}, ${r.lines} lines`}
                  className="w-full grid grid-cols-[minmax(0,9.5rem)_1fr] sm:grid-cols-[minmax(0,13rem)_1fr] items-center gap-2 py-0.5 text-left rounded-sm hover:bg-[#f4f8fd] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--aws-navy)]"
                >
                  <span className="truncate text-[12px] text-[var(--text-primary)]" title={r.label}>{r.label}</span>
                  <span className="flex items-center gap-2 min-w-0">
                    <span
                      className="h-[14px] rounded-r-[4px] shrink-0 transition-colors"
                      style={{ width: `${Math.max(share * 78, r.value > 0 ? 1 : 0)}%`, background: dim ? BAR_MUTED : BAR }}
                    />
                    <span className="text-[11px] text-[var(--text-secondary)] tabular-nums whitespace-nowrap">
                      {fmtMeasure(r.value, measure)}
                    </span>
                  </span>
                </button>
                {hover === i ? (
                  <div role="tooltip"
                    className="pointer-events-none absolute z-20 right-0 -top-1 -translate-y-full bg-white border border-[var(--aws-border-strong)] rounded-sm shadow-md px-2.5 py-1.5 text-[11px] whitespace-nowrap">
                    <div className="font-semibold text-[13px] text-[var(--text-primary)] tabular-nums">{fmtMeasure(r.value, measure)}</div>
                    <div className="text-[var(--text-secondary)]">{r.label}</div>
                    <div className="text-[var(--text-secondary)] tabular-nums">
                      {r.lines.toLocaleString("en-IN")} lines · {fmtMeasure(r.kg, "kg")}
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
