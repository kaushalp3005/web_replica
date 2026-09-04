"use client";

// Sample Summary — admin-only analytics over sample requisitions.
//
// The list endpoint caps at 200 rows and returns a bare array with no total,
// so this pages through it (listAllRequisitions) rather than taking one slice
// and reporting a confidently short number. Articles only arrive on the detail
// GET, so pipeline and ageing render immediately from the list while the
// quantity columns fill in as hydration lands.
//
// Same governing rule as the Job Card Summary: a number is either right or
// visibly incomplete. Unconvertible quantities are counted, not zeroed.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { BackLink } from "@/components/BackLink";
import { useRequireAuth, useIsAdmin, useHasPermission, useUserInitial } from "@/lib/user";
import { useSessionCache } from "@/lib/session-state";
import { readDashboardCache, writeDashboardCache } from "@/lib/dashboardUtils";
import { fmtKg } from "@/lib/netKg";
import { loadSkuCatalogue, type SkuCatalogue } from "@/lib/skuCatalog";
import { hydrateAll, HYDRATE_CONCURRENCY } from "@/lib/dashboardFetch";
import { listAllRequisitions, getRequisition, type Requisition } from "@/lib/sample";
import {
  buildReq, buildTree, buildPivot, rollArticles,
  zeroMetrics, addReq, fulfilPct, avgAge,
  DIM_LABELS, SAMPLE_CHAIN, PIVOT_COL_CAP, NA,
  type ReqRecord, type Metrics, type Dim, type SortKey, type Node,
} from "./_build";

type Lens =
  | "overview" | "pipeline" | "articles" | "customer"
  | "billing" | "npd" | "records" | "pivot";

const LENSES: { key: Lens; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "pipeline", label: "Pipeline & Ageing" },
  { key: "articles", label: "Articles & Issue" },
  { key: "customer", label: "Customer & Purpose" },
  { key: "billing", label: "Billing" },
  { key: "npd", label: "NPD & Conversion" },
  { key: "records", label: "Records" },
  { key: "pivot", label: "Pivot" },
];

const LENS_DIM: Record<Lens, Dim> = {
  overview: "status", pipeline: "ageBand", articles: "type", customer: "customer",
  billing: "type", npd: "type", records: "status", pivot: "status",
};

type WindowKey = "today" | "week" | "month" | "lastmonth" | "3m" | "fy" | "all" | "custom";
const WINDOW_LABELS: Record<WindowKey, string> = {
  today: "Today", week: "Last 7 days", month: "This month", lastmonth: "Last month",
  "3m": "Last 3 months", fy: "This financial year", all: "All time", custom: "Custom range",
};

const GROUP_DIMS: Dim[] = [
  "status", "type", "warehouse", "requestor", "purpose",
  "customer", "company", "month", "salesPoc", "ageBand",
];

const SORTS: { key: SortKey; label: string }[] = [
  { key: "reqs", label: "Requisitions" },
  { key: "open", label: "Open" },
  { key: "requiredKg", label: "Required kg" },
  { key: "issuedKg", label: "Issued kg" },
  { key: "fulfilPct", label: "Fulfilment %" },
  { key: "avgAge", label: "Avg age" },
  { key: "aged30", label: "Over 30 days" },
  { key: "amount", label: "Amount" },
  { key: "lines", label: "Article lines" },
  { key: "name", label: "Name" },
];

const RECORDS_PAGE = 50;
const LIST_CACHE = (k: string) => `sample-dash:list:${k}`;

const fmtN = (n: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n || 0);
const fmtPct = (p: number | null) => (p == null ? NA : `${p.toFixed(1)}%`);
const fmtWt = (kg: number) => (Math.abs(kg) >= 1000 ? `${(kg / 1000).toFixed(2)} t` : `${fmtKg(kg, 1)} kg`);
const fmtDays = (d: number | null) => (d == null ? NA : `${d.toFixed(0)}d`);
const fmtMoney = (v: number) =>
  v ? `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(v)}` : NA;

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function computeWindow(key: WindowKey, from: string, to: string): { cacheKey: string; from?: string; to?: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (key) {
    case "today": return { cacheKey: "today", from: iso(now), to: iso(now) };
    case "week": return { cacheKey: "week", from: iso(new Date(y, m, now.getDate() - 6)) };
    case "month": return { cacheKey: "month", from: iso(new Date(y, m, 1)) };
    case "lastmonth": return { cacheKey: "lastmonth", from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
    case "3m": return { cacheKey: "3m", from: iso(new Date(y, m - 2, 1)) };
    case "fy": return { cacheKey: "fy", from: iso(m >= 3 ? new Date(y, 3, 1) : new Date(y - 1, 3, 1)) };
    case "all": return { cacheKey: "all" };
    case "custom": return { cacheKey: `custom:${from}:${to}`, from: from || undefined, to: to || undefined };
  }
}

export default function SampleDashboardPage() {
  const router = useRouter();
  const allowed = useRequireAuth(router.replace);
  const isAdmin = useIsAdmin();
  const canSku = useHasPermission("so", null, null, "view");

  const [windowKey, setWindowKey] = useSessionCache<WindowKey>("sample-dash:window", "3m");
  const [customFrom, setCustomFrom] = useSessionCache<string>("sample-dash:from", "");
  const [customTo, setCustomTo] = useSessionCache<string>("sample-dash:to", "");
  const [lens, setLens] = useSessionCache<Lens>("sample-dash:lens", "overview");
  const [groupBy, setGroupBy] = useSessionCache<Dim>("sample-dash:groupBy", "status");
  const [sortKey, setSortKey] = useSessionCache<SortKey>("sample-dash:sortKey", "reqs");
  const [sortDir, setSortDir] = useSessionCache<"asc" | "desc">("sample-dash:sortDir", "desc");
  const [filtersOpen, setFiltersOpen] = useSessionCache<boolean>("sample-dash:filtersOpen", false);
  const [pivotRow, setPivotRow] = useSessionCache<Dim>("sample-dash:pivotRow", "type");
  const [pivotCol, setPivotCol] = useSessionCache<Dim>("sample-dash:pivotCol", "status");

  const [fType, setFType] = useSessionCache<string[]>("sample-dash:fType", []);
  const [fStatus, setFStatus] = useSessionCache<string[]>("sample-dash:fStatus", []);
  const [fWarehouse, setFWarehouse] = useSessionCache<string[]>("sample-dash:fWarehouse", []);
  const [fRequestor, setFRequestor] = useSessionCache<string[]>("sample-dash:fRequestor", []);
  const [fPurpose, setFPurpose] = useSessionCache<string[]>("sample-dash:fPurpose", []);
  const [fCustomer, setFCustomer] = useSessionCache<string[]>("sample-dash:fCustomer", []);
  const [openOnly, setOpenOnly] = useSessionCache<boolean>("sample-dash:openOnly", false);

  const [rows, setRows] = useState<Requisition[]>([]);
  const [details, setDetails] = useState<Map<number, Requisition>>(new Map());
  const [cat, setCat] = useState<SkuCatalogue | null>(null);
  const [catLoaded, setCatLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capped, setCapped] = useState(false);
  const [failed, setFailed] = useState(0);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [copied, setCopied] = useState(false);
  // Frozen per load so ageing is stable while the user reads the page —
  // otherwise every re-render would nudge the day counts.
  const [now, setNow] = useState<number>(0);

  const activeKey = useRef("");

  useEffect(() => {
    if (!allowed || !isAdmin) return;
    if (!canSku) { queueMicrotask(() => setCatLoaded(true)); return; }
    const ac = new AbortController();
    loadSkuCatalogue(ac.signal)
      .then(setCat)
      .catch(() => setCat(null))
      .finally(() => setCatLoaded(true));
    return () => ac.abort();
  }, [allowed, isAdmin, canSku]);

  const load = useCallback(async (signal: AbortSignal) => {
    const w = computeWindow(windowKey, customFrom, customTo);
    const key = w.cacheKey;
    activeKey.current = key;

    const cached = readDashboardCache<Requisition[]>(LIST_CACHE(key));
    if (cached?.payload?.length) {
      setRows(cached.payload);
      setLoading(false);
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);
    setFailed(0);
    setProgress(null);

    try {
      const res = await listAllRequisitions({ date_from: w.from, date_to: w.to });
      if (activeKey.current !== key) return;

      setRows(res.rows);
      setCapped(res.capped);
      setNow(Date.now());
      writeDashboardCache(LIST_CACHE(key), res.rows);
      setLoading(false);

      if (res.rows.length === 0) { setDetails(new Map()); return; }

      const ids = res.rows.map((r) => r.id);
      setProgress({ done: 0, total: ids.length });
      const h = await hydrateAll<Requisition>(
        ids,
        (id, s) => getRequisition(id, s),
        {
          signal,
          onProgress: (done, total) => {
            if (activeKey.current === key) setProgress({ done, total });
          },
        },
      );
      if (activeKey.current !== key) return;
      setDetails(h.ok);
      setFailed(h.failed.length);
    } catch (e) {
      if (signal.aborted || activeKey.current !== key) return;
      setError(e instanceof Error ? e.message : "Failed to load requisitions.");
      setLoading(false);
    } finally {
      if (activeKey.current === key) { setRefreshing(false); setProgress(null); }
    }
  }, [windowKey, customFrom, customTo]);

  useEffect(() => {
    if (!allowed || !isAdmin) return;
    const ac = new AbortController();
    queueMicrotask(() => { void load(ac.signal); });
    return () => ac.abort();
  }, [allowed, isAdmin, load]);

  const refresh = useCallback(() => {
    const ac = new AbortController();
    setRefreshing(true);
    void load(ac.signal);
  }, [load]);

  const records = useMemo<ReqRecord[]>(
    () => (catLoaded && now ? rows.map((r) => buildReq(r, details.get(r.id), cat, now)) : []),
    [rows, details, cat, catLoaded, now],
  );

  const passes = useCallback((r: ReqRecord, except: string): boolean => {
    if (except !== "type" && fType.length && !fType.includes(r.type)) return false;
    if (except !== "status" && fStatus.length && !fStatus.includes(r.status)) return false;
    if (except !== "warehouse" && fWarehouse.length && !fWarehouse.includes(r.warehouse)) return false;
    if (except !== "requestor" && fRequestor.length && !fRequestor.includes(r.requestor)) return false;
    if (except !== "purpose" && fPurpose.length && !fPurpose.includes(r.purpose)) return false;
    if (except !== "customer" && fCustomer.length && !fCustomer.includes(r.customer)) return false;
    if (except !== "open" && openOnly && !r.open) return false;
    return true;
  }, [fType, fStatus, fWarehouse, fRequestor, fPurpose, fCustomer, openOnly]);

  const opts = useMemo(() => {
    const distinct = (get: (r: ReqRecord) => string, except: string) => {
      const s = new Set<string>();
      for (const r of records) if (passes(r, except)) { const v = get(r); if (v && v !== NA) s.add(v); }
      return [...s].sort((a, b) => a.localeCompare(b));
    };
    return {
      type: distinct((r) => r.type, "type"),
      status: distinct((r) => r.status, "status"),
      warehouse: distinct((r) => r.warehouse, "warehouse"),
      requestor: distinct((r) => r.requestor, "requestor"),
      purpose: distinct((r) => r.purpose, "purpose"),
      customer: distinct((r) => r.customer, "customer"),
    };
  }, [records, passes]);

  const terms = useMemo(
    () => search.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [search],
  );

  const filtered = useMemo(() => {
    const hit = (r: ReqRecord) => {
      if (!terms.length) return true;
      const hay = [
        r.handle, r.type, r.status, r.warehouse, r.requestor, r.salesPoc,
        r.purpose, r.customer, r.company, ...r.articles.map((a) => a.sku),
      ].join(" ").toLowerCase();
      return terms.every((t) => hay.includes(t));
    };
    return records.filter((r) => passes(r, "") && hit(r));
  }, [records, passes, terms]);

  const kpi = useMemo(() => {
    const m = zeroMetrics();
    for (const r of filtered) addReq(m, r);
    return m;
  }, [filtered]);

  const chain = useMemo(() => SAMPLE_CHAIN[groupBy] ?? [groupBy], [groupBy]);
  const tree = useMemo(() => buildTree(filtered, chain, sortKey, sortDir), [filtered, chain, sortKey, sortDir]);
  const articles = useMemo(() => rollArticles(filtered), [filtered]);
  const pivot = useMemo(() => buildPivot(filtered, pivotRow, pivotCol, sortKey), [filtered, pivotRow, pivotCol, sortKey]);

  const flat = useMemo(
    () => [...filtered].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")),
    [filtered],
  );
  const pageCount = Math.max(1, Math.ceil(flat.length / RECORDS_PAGE));
  const pageRows = flat.slice(page * RECORDS_PAGE, (page + 1) * RECORDS_PAGE);

  const activeFilters =
    fType.length + fStatus.length + fWarehouse.length + fRequestor.length +
    fPurpose.length + fCustomer.length + (openOnly ? 1 : 0);

  const clearFilters = () => {
    setFType([]); setFStatus([]); setFWarehouse([]); setFRequestor([]);
    setFPurpose([]); setFCustomer([]); setOpenOnly(false); setSearch("");
  };

  const isSearching = terms.length > 0;
  const isOpen = useCallback((k: string) => isSearching || expanded.has(k), [isSearching, expanded]);
  const toggle = useCallback((k: string) => setExpanded((p) => {
    const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n;
  }), []);

  const handleExport = useCallback(() => {
    const head = [
      "Request", "Created", "Type", "Status", "Warehouse", "Requestor", "Sales POC",
      "Purpose", "Company", "Customer", "Age (d)", "Required kg", "Issued kg",
      "Lines", "Returnable", "Non-returnable", "Paid", "Amount", "Dev JC", "Not in kg",
    ];
    const esc = (v: unknown) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const body = flat.map((r) => [
      r.handle, r.createdAt, r.type, r.status, r.warehouse, r.requestor, r.salesPoc,
      r.purpose, r.company, r.customer, r.open ? r.ageDays : "",
      r.hydrated ? r.requiredKg.toFixed(3) : "", r.hydrated ? r.issuedKg.toFixed(3) : "",
      r.hydrated ? r.lines : "",
      r.returnable ? "yes" : "", r.nonReturnable ? "yes" : "", r.paid ? "yes" : "",
      r.amount || "", r.linkedDevJc ?? "", r.notInKg || "",
    ].map(esc).join(","));
    const blob = new Blob([[head.join(","), ...body].join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Sample_Summary_${iso(new Date())}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [flat]);

  const handleCopy = useCallback(async () => {
    const lines = [
      `Sample Summary — ${WINDOW_LABELS[windowKey]}`,
      `${fmtN(kpi.reqs)} requisitions · ${fmtN(kpi.open)} open · avg age ${fmtDays(avgAge(kpi))} · fulfilment ${fmtPct(fulfilPct(kpi))}`,
      "",
      ...tree.map((g) => `${g.label}: ${fmtN(g.m.reqs)} req · ${fmtN(g.m.open)} open`),
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard blocked */ }
  }, [windowKey, kpi, tree]);

  if (!isAdmin) {
    return (
      <Shell router={router}>
        <div className="max-w-md mx-auto mt-16 bg-white border border-[var(--aws-border)] rounded-lg p-8 text-center">
          <div className="text-[15px] font-semibold text-[var(--text-primary)]">Access restricted</div>
          <div className="text-[13px] text-[var(--text-secondary)] mt-2">
            The Sample Summary is available to administrators only.
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell router={router}>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h1 className="text-[20px] font-semibold text-[var(--text-primary)] leading-tight">Sample Summary</h1>
          <div className="text-[12px] text-[var(--text-secondary)] flex flex-wrap items-center gap-2 mt-0.5">
            <span>{WINDOW_LABELS[windowKey]}</span>
            <span>· by created date</span>
            {refreshing && <span className="text-blue-600">· refreshing…</span>}
            {progress && progress.done < progress.total && (
              <span className="text-blue-600">· hydrating {progress.done}/{progress.total}</span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={windowKey} onChange={(e) => setWindowKey(e.target.value as WindowKey)}
            className="px-2 py-1.5 text-[12px] border border-[var(--aws-border)] rounded-md bg-white">
            {(Object.keys(WINDOW_LABELS) as WindowKey[]).map((k) => (
              <option key={k} value={k}>{WINDOW_LABELS[k]}</option>
            ))}
          </select>
          <Btn onClick={refresh} disabled={loading || refreshing} label="Refresh" />
          <Btn onClick={handleCopy} label={copied ? "Copied" : "Copy"} />
          <Btn onClick={handleExport} label="Export" />
        </div>
      </div>

      {windowKey === "custom" && (
        <div className="flex items-center gap-2 mb-3 text-[12px]">
          <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)}
            className="px-2 py-1 border border-[var(--aws-border)] rounded-md" />
          <span className="text-[var(--text-secondary)]">to</span>
          <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)}
            className="px-2 py-1 border border-[var(--aws-border)] rounded-md" />
        </div>
      )}

      {error && <Banner tone="rose">{error}</Banner>}
      {capped && (
        <Banner tone="amber">
          The window returned more requisitions than the walk fetches. Totals cover
          only what was loaded and are understated — narrow the date range.
        </Banner>
      )}
      {failed > 0 && (
        <Banner tone="amber">
          {failed} of {rows.length} requisition details failed to load. Article
          quantities are understated by whatever those requests hold.
        </Banner>
      )}
      {!canSku && (
        <Banner tone="amber">
          You do not have <code>so:view</code>, so article categories fall back to
          the line&apos;s own pack size where present.
        </Banner>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[var(--text-secondary)]
                      bg-white border border-[var(--aws-border)] rounded-md px-3 py-2 mb-4">
        <span><b className="text-[var(--text-primary)]">{fmtN(rows.length)}</b> requisitions loaded</span>
        <span>hydrated <b className="text-[var(--text-primary)]">{fmtN(kpi.hydrated)}</b>/{fmtN(kpi.reqs)}</span>
        <span>concurrency {HYDRATE_CONCURRENCY}</span>
        <span>paged at 200/request</span>
        {kpi.notInKg > 0 && (
          <span className="text-amber-700" title="Article lines whose uom could not be converted to kg — excluded from every kg total.">
            {fmtN(kpi.notInKg)} not in kg
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
        <Kpi label="Requisitions" value={fmtN(kpi.reqs)}
          sub={`${fmtN(kpi.done)} closed · ${fmtN(kpi.dead)} rejected`} />
        <Kpi label="Open" value={fmtN(kpi.open)}
          sub={`${fmtN(kpi.onHold)} on hold`} tone={kpi.open > 0 ? "amber" : undefined} />
        <Kpi label="Avg age" value={fmtDays(avgAge(kpi))}
          sub={`${fmtN(kpi.aged30)} over 30 days`}
          tone={kpi.aged30 > 0 ? "rose" : undefined} />
        <Kpi label="Fulfilment" value={fmtPct(fulfilPct(kpi))}
          sub={`${fmtWt(kpi.issuedKg)} of ${fmtWt(kpi.requiredKg)}`} />
        <Kpi label="Late dispatch" value={fmtN(kpi.lateCount)}
          sub={kpi.lateCount ? `${fmtN(kpi.lateDaysSum)} days total` : "none confirmed late"}
          tone={kpi.lateCount > 0 ? "amber" : undefined} />
      </div>

      <div className="flex flex-wrap gap-1 mb-3 border-b border-[var(--aws-border)]">
        {LENSES.map((l) => (
          <button key={l.key}
            onClick={() => { setLens(l.key); setGroupBy(LENS_DIM[l.key]); setExpanded(new Set()); setPage(0); }}
            className={`px-3 py-1.5 text-[12px] -mb-px border-b-2 ${
              lens === l.key
                ? "border-[var(--aws-navy)] text-[var(--aws-navy)] font-medium"
                : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}>
            {l.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-2">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            placeholder="Search request, customer, article…"
            className="w-full pl-3 pr-7 py-1.5 text-[12px] border border-[var(--aws-border)] rounded-md" />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-2 top-1.5 text-[var(--text-secondary)]">✕</button>
          )}
        </div>

        {lens !== "pivot" && lens !== "records" && lens !== "articles" && (
          <label className="text-[12px] text-[var(--text-secondary)] flex items-center gap-1.5">
            Group
            <select value={groupBy} onChange={(e) => { setGroupBy(e.target.value as Dim); setExpanded(new Set()); }}
              className="px-2 py-1.5 text-[12px] border border-[var(--aws-border)] rounded-md bg-white">
              {GROUP_DIMS.map((d) => <option key={d} value={d}>{DIM_LABELS[d]}</option>)}
            </select>
          </label>
        )}

        {lens === "pivot" && (
          <>
            <label className="text-[12px] text-[var(--text-secondary)] flex items-center gap-1.5">
              Rows
              <select value={pivotRow} onChange={(e) => setPivotRow(e.target.value as Dim)}
                className="px-2 py-1.5 text-[12px] border border-[var(--aws-border)] rounded-md bg-white">
                {GROUP_DIMS.map((d) => <option key={d} value={d}>{DIM_LABELS[d]}</option>)}
              </select>
            </label>
            <label className="text-[12px] text-[var(--text-secondary)] flex items-center gap-1.5">
              Cols
              <select value={pivotCol} onChange={(e) => setPivotCol(e.target.value as Dim)}
                className="px-2 py-1.5 text-[12px] border border-[var(--aws-border)] rounded-md bg-white">
                {GROUP_DIMS.map((d) => <option key={d} value={d}>{DIM_LABELS[d]}</option>)}
              </select>
            </label>
          </>
        )}

        <label className="text-[12px] text-[var(--text-secondary)] flex items-center gap-1.5">
          Sort
          <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="px-2 py-1.5 text-[12px] border border-[var(--aws-border)] rounded-md bg-white">
            {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
        <button onClick={() => setSortDir(sortDir === "desc" ? "asc" : "desc")}
          title={sortDir === "desc" ? "Descending" : "Ascending"}
          className="px-2 py-1.5 text-[12px] border border-[var(--aws-border)] rounded-md bg-white">
          {sortDir === "desc" ? "▼" : "▲"}
        </button>

        <button onClick={() => setFiltersOpen(!filtersOpen)}
          className={`px-2.5 py-1.5 text-[12px] rounded-md border ${
            activeFilters
              ? "border-[var(--aws-navy)] text-[var(--aws-navy)] font-medium"
              : "border-[var(--aws-border)] text-[var(--text-secondary)]"
          }`}>
          Filters{activeFilters ? ` (${activeFilters})` : ""} {filtersOpen ? "▴" : "▾"}
        </button>
      </div>

      {filtersOpen && (
        <div className="bg-white border border-[var(--aws-border)] rounded-md p-3 mb-3 space-y-2">
          <ChipRow label="Type" options={opts.type} selected={fType} onToggle={mkToggle(fType, setFType)} />
          <ChipRow label="Status" options={opts.status} selected={fStatus} onToggle={mkToggle(fStatus, setFStatus)} />
          <ChipRow label="Warehouse" options={opts.warehouse} selected={fWarehouse} onToggle={mkToggle(fWarehouse, setFWarehouse)} />
          <ChipRow label="Requestor" options={opts.requestor} selected={fRequestor} onToggle={mkToggle(fRequestor, setFRequestor)} />
          <ChipRow label="Purpose" options={opts.purpose} selected={fPurpose} onToggle={mkToggle(fPurpose, setFPurpose)} />
          <ChipRow label="Customer" options={opts.customer} selected={fCustomer} onToggle={mkToggle(fCustomer, setFCustomer)} />
          <div className="flex items-center justify-between pt-1">
            <label className="flex items-center gap-1.5 text-[12px] text-amber-700">
              <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />
              Open only
            </label>
            {activeFilters > 0 && (
              <button onClick={clearFilters} className="text-[12px] text-rose-600 hover:underline">Clear all</button>
            )}
          </div>
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-10 bg-white border border-[var(--aws-border)] rounded-md animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white border border-[var(--aws-border)] rounded-md px-3 py-12 text-center text-[13px] text-[var(--text-secondary)]">
          No requisitions in this view.
          {activeFilters > 0 && <button onClick={clearFilters} className="ml-2 text-rose-600 hover:underline">Clear filters</button>}
        </div>
      ) : lens === "records" ? (
        <RecordsTable rows={pageRows} page={page} pageCount={pageCount} total={flat.length}
          onPage={setPage} onOpen={(id) => router.push(`/modules/sample/${id}`)} />
      ) : lens === "articles" ? (
        <ArticlesTable rolls={articles} hydrated={kpi.hydrated} total={kpi.reqs} />
      ) : lens === "billing" ? (
        <BillingView records={filtered} kpi={kpi} onOpen={(id) => router.push(`/modules/sample/${id}`)} />
      ) : lens === "npd" ? (
        <NpdView records={filtered} onOpen={(id) => router.push(`/modules/sample/${id}`)} />
      ) : lens === "pivot" ? (
        <PivotTable pivot={pivot} rowDim={pivotRow} colDim={pivotCol} />
      ) : (
        <TreeTable tree={tree} chain={chain} dimLabel={DIM_LABELS[groupBy]}
          pipeline={lens === "pipeline"} total={kpi} isOpen={isOpen} onToggle={toggle} />
      )}

      <div className="mt-4 text-[11px] text-[var(--text-secondary)] leading-relaxed">
        <b>How to read this.</b> The list endpoint caps at 200 rows per request and
        returns no total, so this pages through it — a single request would have
        silently reported whatever fit. Article quantities come from the per-request
        detail and appear as hydration completes; a requisition not yet hydrated
        contributes to counts but not to kg. Kg figures are net, using each line&apos;s
        own pack size where it has one and the SKU master otherwise; anything
        unconvertible is counted under “not in kg” rather than added as zero.
        Age counts days since creation for <i>open</i> requests only — a closed
        request is finished, not old. Fulfilment is issued ÷ required, blank when
        nothing was requested.
      </div>
    </Shell>
  );
}

const mkToggle = (sel: string[], set: (v: string[]) => void) => (v: string) =>
  set(sel.includes(v) ? sel.filter((x) => x !== v) : [...sel, v]);

// ── sub-components ────────────────────────────────────────────────────────

function Shell({ children, router }: { children: React.ReactNode; router: ReturnType<typeof useRouter> }) {
  const initial = useUserInitial();
  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-6 gap-4">
        <BrandMark />
        <span className="text-[#d5dbdb] text-[13px] hidden sm:inline">Console</span>
        <nav className="text-[12px] text-[#d5dbdb] hidden md:flex items-center gap-2 ml-2">
          <button onClick={() => router.push("/modules")} className="hover:underline">Modules</button>
          <span>/</span>
          <button onClick={() => router.push("/modules/sample")} className="hover:underline">Sample</button>
          <span>/</span>
          <span className="text-white">Summary</span>
        </nav>
        <div className="flex-1" />
        <button onClick={() => router.push("/modules/profile")} aria-label="Open profile" title="Profile"
          className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]">
          {initial}
        </button>
      </header>
      <main className="flex-1 max-w-[1280px] w-full mx-auto px-4 sm:px-6 py-6">
        <div className="mb-3"><BackLink parentHref="/modules/sample" label="sample" /></div>
        {children}
      </main>
    </div>
  );
}

function Btn({ onClick, label, disabled }: { onClick: () => void; label: string; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="px-2.5 py-1.5 text-[12px] border border-[var(--aws-border)] rounded-md bg-white hover:border-[var(--aws-navy)] disabled:opacity-50">
      {label}
    </button>
  );
}

function Banner({ tone, children }: { tone: "amber" | "rose"; children: React.ReactNode }) {
  const c = tone === "rose"
    ? "bg-rose-50 border-rose-200 text-rose-700"
    : "bg-amber-50 border-amber-200 text-amber-800";
  return <div className={`mb-3 border rounded-md px-3 py-2 text-[12px] ${c}`}>{children}</div>;
}

function Kpi({ label, value, sub, tone }: {
  label: string; value: string; sub?: string; tone?: "amber" | "rose";
}) {
  const vt = tone === "amber" ? "text-amber-600" : tone === "rose" ? "text-rose-600" : "text-[var(--text-primary)]";
  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-lg px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-[var(--text-secondary)]">{label}</div>
      <div className={`text-[22px] font-semibold leading-tight mt-1 ${vt}`}>{value}</div>
      {sub && <div className="text-[11px] text-[var(--text-secondary)] mt-0.5">{sub}</div>}
    </div>
  );
}

function ChipRow({ label, options, selected, onToggle }: {
  label: string; options: string[]; selected: string[]; onToggle: (v: string) => void;
}) {
  if (!options.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-[var(--text-secondary)] w-[70px] shrink-0">{label}</span>
      {options.map((o) => (
        <button key={o} onClick={() => onToggle(o)}
          className={`px-2 py-0.5 text-[11px] rounded-full border ${
            selected.includes(o)
              ? "bg-[var(--aws-navy)] text-white border-[var(--aws-navy)]"
              : "border-[var(--aws-border)] text-[var(--text-secondary)] hover:border-[var(--aws-navy)]"
          }`}>
          {o}
        </button>
      ))}
    </div>
  );
}

function TreeTable({ tree, chain, dimLabel, pipeline, total, isOpen, onToggle }: {
  tree: Node[]; chain: Dim[]; dimLabel: string; pipeline: boolean;
  total: Metrics; isOpen: (k: string) => boolean; onToggle: (k: string) => void;
}) {
  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md overflow-x-auto">
      <table className="w-full text-[12px] min-w-[820px]">
        <thead>
          <tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)] bg-[var(--background)]">
            <th className="px-3 py-2 font-medium">
              {dimLabel}
              <span className="ml-1.5 font-normal text-[10px]">
                → {chain.slice(1).map((d) => DIM_LABELS[d]).join(" → ")}
              </span>
            </th>
            <th className="px-2 py-2 font-medium text-right w-16">Reqs</th>
            <th className="px-2 py-2 font-medium text-right w-16">Open</th>
            {pipeline ? (
              <>
                <th className="px-2 py-2 font-medium text-right w-20">Avg age</th>
                <th className="px-2 py-2 font-medium text-right w-20">&gt;30d</th>
                <th className="px-2 py-2 font-medium text-right w-20">Late</th>
              </>
            ) : (
              <>
                <th className="px-2 py-2 font-medium text-right w-24">Required</th>
                <th className="px-2 py-2 font-medium text-right w-24">Issued</th>
                <th className="px-2 py-2 font-medium text-right w-20">Fulfil</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {tree.map((nd) => (
            <TreeRows key={nd.key} node={nd} pipeline={pipeline} isOpen={isOpen} onToggle={onToggle} />
          ))}
        </tbody>
        <tfoot>
          <tr className="bg-[var(--background)] font-semibold border-t border-[var(--aws-border)]">
            <td className="px-3 py-2">Total</td>
            <td className="px-2 py-2 text-right">{fmtN(total.reqs)}</td>
            <td className="px-2 py-2 text-right">{fmtN(total.open)}</td>
            {pipeline ? (
              <>
                <td className="px-2 py-2 text-right">{fmtDays(avgAge(total))}</td>
                <td className="px-2 py-2 text-right">{fmtN(total.aged30)}</td>
                <td className="px-2 py-2 text-right">{fmtN(total.lateCount)}</td>
              </>
            ) : (
              <>
                <td className="px-2 py-2 text-right">{fmtWt(total.requiredKg)}</td>
                <td className="px-2 py-2 text-right">{fmtWt(total.issuedKg)}</td>
                <td className="px-2 py-2 text-right">{fmtPct(fulfilPct(total))}</td>
              </>
            )}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function TreeRows({ node, pipeline, isOpen, onToggle }: {
  node: Node; pipeline: boolean; isOpen: (k: string) => boolean; onToggle: (k: string) => void;
}) {
  const open = isOpen(node.key);
  const hasKids = node.children.length > 0;
  const m = node.m;
  return (
    <>
      <tr
        className={`border-b border-[var(--aws-border)]/60 ${hasKids ? "cursor-pointer hover:bg-[var(--background)]" : ""} ${node.depth > 0 ? "bg-[var(--background)]/30" : ""}`}
        onClick={hasKids ? () => onToggle(node.key) : undefined}
      >
        <td className="px-3 py-1.5" style={{ paddingLeft: 12 + node.depth * 18 }}>
          <span className="inline-block w-4 text-[var(--text-secondary)]">{hasKids ? (open ? "▾" : "▸") : ""}</span>
          <span className={node.depth === 0 ? "font-medium text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}>
            {node.label}
          </span>
          {m.onHold > 0 && (
            <span className="ml-2 px-1.5 py-0.5 rounded-full text-[10px] bg-amber-50 text-amber-700">{m.onHold} on hold</span>
          )}
          {m.notInKg > 0 && (
            <span className="ml-2 px-1.5 py-0.5 rounded-full text-[10px] bg-amber-50 text-amber-700"
              title="Article lines excluded from kg totals — uom could not be converted.">
              {m.notInKg} not in kg
            </span>
          )}
        </td>
        <td className="px-2 py-1.5 text-right text-[var(--text-secondary)]">{fmtN(m.reqs)}</td>
        <td className="px-2 py-1.5 text-right">{m.open || ""}</td>
        {pipeline ? (
          <>
            <td className="px-2 py-1.5 text-right">{fmtDays(avgAge(m))}</td>
            <td className="px-2 py-1.5 text-right text-rose-600">{m.aged30 || ""}</td>
            <td className="px-2 py-1.5 text-right text-[var(--text-secondary)]">{m.lateCount || ""}</td>
          </>
        ) : (
          <>
            <td className="px-2 py-1.5 text-right">{fmtWt(m.requiredKg)}</td>
            <td className="px-2 py-1.5 text-right font-medium">{fmtWt(m.issuedKg)}</td>
            <td className="px-2 py-1.5 text-right">{fmtPct(fulfilPct(m))}</td>
          </>
        )}
      </tr>
      {open && node.children.map((c) => (
        <TreeRows key={c.key} node={c} pipeline={pipeline} isOpen={isOpen} onToggle={onToggle} />
      ))}
    </>
  );
}

function ArticlesTable({ rolls, hydrated, total }: {
  rolls: ReturnType<typeof rollArticles>; hydrated: number; total: number;
}) {
  return (
    <div className="space-y-2">
      {hydrated < total && (
        <div className="text-[11px] text-amber-700">
          {fmtN(total - hydrated)} requisition{total - hydrated > 1 ? "s" : ""} not yet
          hydrated — their article lines are not counted below.
        </div>
      )}
      <div className="bg-white border border-[var(--aws-border)] rounded-md overflow-x-auto">
        <table className="w-full text-[12px] min-w-[760px]">
          <thead>
            <tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)] bg-[var(--background)]">
              <th className="px-3 py-2 font-medium">Article</th>
              <th className="px-2 py-2 font-medium w-28">Role</th>
              <th className="px-2 py-2 font-medium w-36">Category</th>
              <th className="px-2 py-2 font-medium text-right w-24">Required</th>
              <th className="px-2 py-2 font-medium text-right w-24">Issued</th>
              <th className="px-2 py-2 font-medium text-right w-20">Fulfil</th>
              <th className="px-2 py-2 font-medium text-right w-16">Reqs</th>
            </tr>
          </thead>
          <tbody>
            {rolls.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-[var(--text-secondary)]">No article lines loaded yet.</td></tr>
            ) : rolls.map((r) => (
              <tr key={`${r.sku}|${r.role}`} className="border-b border-[var(--aws-border)]/60">
                <td className="px-3 py-1.5">
                  {r.sku}
                  {r.notInKg > 0 && (
                    <span className="ml-2 px-1.5 py-0.5 rounded-full text-[10px] bg-amber-50 text-amber-700"
                      title="Lines whose uom could not be converted to kg.">{r.notInKg} not in kg</span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-[var(--text-secondary)]">{r.role}</td>
                <td className="px-2 py-1.5 text-[var(--text-secondary)]">{r.category}</td>
                <td className="px-2 py-1.5 text-right">{fmtWt(r.requiredKg)}</td>
                <td className="px-2 py-1.5 text-right font-medium">{fmtWt(r.issuedKg)}</td>
                <td className="px-2 py-1.5 text-right">
                  {r.requiredKg > 0 ? fmtPct((r.issuedKg / r.requiredKg) * 100) : NA}
                </td>
                <td className="px-2 py-1.5 text-right text-[var(--text-secondary)]">{fmtN(r.reqs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BillingView({ records, kpi, onOpen }: {
  records: ReqRecord[]; kpi: Metrics; onOpen: (id: number) => void;
}) {
  // Only NPD / TRIAL carry the billing checklist; showing every other type here
  // would imply an obligation that does not exist for them.
  const billable = records.filter((r) => r.isNpd);
  const missing = billable.filter((r) => !r.billingSet);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Billable (NPD/Trial)" value={fmtN(billable.length)} sub={`of ${fmtN(kpi.reqs)} in view`} />
        <Kpi label="Returnable" value={fmtN(kpi.returnableCount)} sub={`${fmtN(kpi.nonReturnableCount)} non-returnable`} />
        <Kpi label="Paid" value={fmtN(kpi.paidCount)} sub={fmtMoney(kpi.amount)} />
        <Kpi label="Checklist missing" value={fmtN(missing.length)}
          tone={missing.length ? "rose" : undefined}
          sub="neither returnable nor non-returnable" />
      </div>

      <div className="bg-white border border-[var(--aws-border)] rounded-md overflow-x-auto">
        <div className="px-3 py-2 text-[12px] font-medium border-b border-[var(--aws-border)] bg-[var(--background)]">
          Billing checklist
          <span className="ml-2 font-normal text-[11px] text-[var(--text-secondary)]">
            NPD and Trial only — returnable and non-returnable are mutually exclusive
          </span>
        </div>
        <table className="w-full text-[12px] min-w-[760px]">
          <thead>
            <tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
              <th className="px-3 py-2 font-medium w-28">Request</th>
              <th className="px-2 py-2 font-medium w-20">Type</th>
              <th className="px-2 py-2 font-medium">Customer</th>
              <th className="px-2 py-2 font-medium w-24">Returnable</th>
              <th className="px-2 py-2 font-medium w-28">Non-returnable</th>
              <th className="px-2 py-2 font-medium w-16">Paid</th>
              <th className="px-2 py-2 font-medium text-right w-24">Amount</th>
            </tr>
          </thead>
          <tbody>
            {billable.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-[var(--text-secondary)]">No NPD or Trial requisitions in this view.</td></tr>
            ) : billable.map((r) => (
              <tr key={r.id} className={`border-b border-[var(--aws-border)]/60 ${!r.billingSet ? "bg-rose-50/40" : ""}`}>
                <td className="px-3 py-1.5">
                  <button onClick={() => onOpen(r.id)} className="font-mono text-blue-700 hover:underline">{r.handle}</button>
                </td>
                <td className="px-2 py-1.5 text-[var(--text-secondary)]">{r.type}</td>
                <td className="px-2 py-1.5">{r.customer}</td>
                <td className="px-2 py-1.5">{r.returnable ? "yes" : ""}</td>
                <td className="px-2 py-1.5">{r.nonReturnable ? "yes" : ""}</td>
                <td className="px-2 py-1.5">{r.paid ? "yes" : ""}</td>
                <td className="px-2 py-1.5 text-right font-medium">{fmtMoney(r.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NpdView({ records, onOpen }: { records: ReqRecord[]; onOpen: (id: number) => void }) {
  const npd = records.filter((r) => r.isNpd);
  const withJc = npd.filter((r) => r.linkedDevJc);
  const converted = npd.filter((r) => r.convertedToExternal || r.convertedFrom);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="NPD / Trial" value={fmtN(npd.length)} />
        <Kpi label="With dev job card" value={fmtN(withJc.length)}
          sub={npd.length ? fmtPct((withJc.length / npd.length) * 100) : undefined} />
        <Kpi label="Converted" value={fmtN(converted.length)} sub="to or from an external request" />
        <Kpi label="Gate passes" value={fmtN(npd.filter((r) => r.linkedGatePass).length)} />
      </div>

      <div className="bg-white border border-[var(--aws-border)] rounded-md overflow-x-auto">
        <table className="w-full text-[12px] min-w-[860px]">
          <thead>
            <tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)] bg-[var(--background)]">
              <th className="px-3 py-2 font-medium w-28">Request</th>
              <th className="px-2 py-2 font-medium w-20">Type</th>
              <th className="px-2 py-2 font-medium w-32">Status</th>
              <th className="px-2 py-2 font-medium">Customer</th>
              <th className="px-2 py-2 font-medium text-right w-20">Targets</th>
              <th className="px-2 py-2 font-medium text-right w-24">Target kg</th>
              <th className="px-2 py-2 font-medium w-24">Dev JC</th>
              <th className="px-2 py-2 font-medium w-24">Gate pass</th>
            </tr>
          </thead>
          <tbody>
            {npd.length === 0 ? (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-[var(--text-secondary)]">No NPD or Trial requisitions in this view.</td></tr>
            ) : npd.map((r) => (
              <tr key={r.id} className="border-b border-[var(--aws-border)]/60">
                <td className="px-3 py-1.5">
                  <button onClick={() => onOpen(r.id)} className="font-mono text-blue-700 hover:underline">{r.handle}</button>
                </td>
                <td className="px-2 py-1.5 text-[var(--text-secondary)]">{r.type}</td>
                <td className="px-2 py-1.5">
                  <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-slate-100 text-slate-600">{r.status}</span>
                </td>
                <td className="px-2 py-1.5">{r.customer}</td>
                <td className="px-2 py-1.5 text-right text-[var(--text-secondary)]">{r.hydrated ? (r.npdTargets || "") : NA}</td>
                <td className="px-2 py-1.5 text-right">{r.targetKg ? fmtWt(r.targetKg) : NA}</td>
                <td className="px-2 py-1.5 font-mono text-[11px] text-[var(--text-secondary)]">{r.linkedDevJc ?? NA}</td>
                <td className="px-2 py-1.5 font-mono text-[11px] text-[var(--text-secondary)]">{r.linkedGatePass ?? NA}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RecordsTable({ rows, page, pageCount, total, onPage, onOpen }: {
  rows: ReqRecord[]; page: number; pageCount: number; total: number;
  onPage: (p: number) => void; onOpen: (id: number) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="bg-white border border-[var(--aws-border)] rounded-md overflow-x-auto">
        <table className="w-full text-[12px] min-w-[1000px]">
          <thead>
            <tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)] bg-[var(--background)]">
              <th className="px-3 py-2 font-medium w-28">Request</th>
              <th className="px-2 py-2 font-medium w-24">Created</th>
              <th className="px-2 py-2 font-medium w-20">Type</th>
              <th className="px-2 py-2 font-medium w-32">Status</th>
              <th className="px-2 py-2 font-medium">Customer</th>
              <th className="px-2 py-2 font-medium w-28">Requestor</th>
              <th className="px-2 py-2 font-medium text-right w-16">Age</th>
              <th className="px-2 py-2 font-medium text-right w-24">Required</th>
              <th className="px-2 py-2 font-medium text-right w-24">Issued</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-[var(--aws-border)]/60 hover:bg-[var(--background)]">
                <td className="px-3 py-1.5">
                  <button onClick={() => onOpen(r.id)} className="font-mono text-blue-700 hover:underline">{r.handle}</button>
                </td>
                <td className="px-2 py-1.5 text-[var(--text-secondary)]">{r.createdAt || NA}</td>
                <td className="px-2 py-1.5 text-[var(--text-secondary)]">{r.type}</td>
                <td className="px-2 py-1.5">
                  <span className={`px-1.5 py-0.5 rounded-full text-[10px] ${
                    r.dead ? "bg-rose-50 text-rose-700"
                      : r.done ? "bg-emerald-50 text-emerald-700"
                        : r.status === "ON_HOLD" ? "bg-amber-50 text-amber-700"
                          : "bg-slate-100 text-slate-600"
                  }`}>{r.status}</span>
                </td>
                <td className="px-2 py-1.5">{r.customer}</td>
                <td className="px-2 py-1.5 text-[var(--text-secondary)]">{r.requestor}</td>
                <td className={`px-2 py-1.5 text-right ${r.ageDays > 30 ? "text-rose-600 font-medium" : "text-[var(--text-secondary)]"}`}>
                  {r.open ? `${r.ageDays}d` : NA}
                </td>
                <td className="px-2 py-1.5 text-right">{r.hydrated ? fmtWt(r.requiredKg) : NA}</td>
                <td className="px-2 py-1.5 text-right font-medium">{r.hydrated ? fmtWt(r.issuedKg) : NA}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between text-[11px] text-[var(--text-secondary)]">
        <span>{fmtN(total)} requisitions · page {page + 1} of {pageCount}</span>
        <div className="flex gap-1">
          <Btn onClick={() => onPage(Math.max(0, page - 1))} disabled={page === 0} label="Prev" />
          <Btn onClick={() => onPage(Math.min(pageCount - 1, page + 1))} disabled={page >= pageCount - 1} label="Next" />
        </div>
      </div>
    </div>
  );
}

function PivotTable({ pivot, rowDim, colDim }: {
  pivot: ReturnType<typeof buildPivot>; rowDim: Dim; colDim: Dim;
}) {
  const cell = (r: string, c: string): Metrics | undefined => pivot.cells.get(`${r} ${c}`);
  const val = (m: Metrics | undefined) => (m ? fmtN(m.reqs) : "");
  return (
    <div className="space-y-2">
      <div className="bg-white border border-[var(--aws-border)] rounded-md overflow-x-auto">
        <table className="text-[12px] min-w-full">
          <thead>
            <tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)] bg-[var(--background)]">
              <th className="px-3 py-2 font-medium sticky left-0 bg-[var(--background)] z-10">
                {DIM_LABELS[rowDim]} \ {DIM_LABELS[colDim]}
              </th>
              {pivot.cols.map((c) => (
                <th key={c} className="px-2 py-2 font-medium text-right whitespace-nowrap">{c}</th>
              ))}
              <th className="px-2 py-2 font-medium text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {pivot.rows.map((r) => (
              <tr key={r} className="border-b border-[var(--aws-border)]/60">
                <td className="px-3 py-1.5 font-medium text-[var(--text-primary)] sticky left-0 bg-white whitespace-nowrap">{r}</td>
                {pivot.cols.map((c) => (
                  <td key={c} className="px-2 py-1.5 text-right">{val(cell(r, c))}</td>
                ))}
                <td className="px-2 py-1.5 text-right font-medium">{val(pivot.rowTotals.get(r))}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-[var(--background)] font-semibold border-t border-[var(--aws-border)]">
              <td className="px-3 py-2 sticky left-0 bg-[var(--background)]">Total</td>
              {pivot.cols.map((c) => (
                <td key={c} className="px-2 py-2 text-right">{val(pivot.colTotals.get(c))}</td>
              ))}
              <td className="px-2 py-2 text-right">{val(pivot.grand)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="text-[11px] text-[var(--text-secondary)]">
        Cells show requisition counts.
        {pivot.droppedCols > 0 && (
          <span className="text-amber-700">
            {" "}{pivot.droppedCols} further column{pivot.droppedCols > 1 ? "s" : ""} not shown —
            the matrix caps at {PIVOT_COL_CAP}; the Total column still counts every one of them.
          </span>
        )}
      </div>
    </div>
  );
}
