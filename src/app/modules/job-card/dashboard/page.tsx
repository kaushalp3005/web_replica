"use client";

// Job Card Summary — admin-only analytics over the v2 job card set.
//
// Shape: load a date window of job cards, hydrate each one's accounting
// detail, convert every quantity to net kg, then group. All aggregation is
// client-side over the loaded window (see _build.ts), which is what lets one
// comparator drive every level of the drill tree.
//
// The governing rule throughout: a number is either right or visibly
// incomplete. Quantities that cannot be converted to kg are counted and
// surfaced, never folded into a total. Metrics that need a permission the
// caller lacks are blanked, never rendered as 0 — a zero reads as real data.
//
// There is no _chrome.tsx for job-card (unlike transfer / customer-returns),
// so the header is inline, matching src/app/modules/job-card/page.tsx.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { BackLink } from "@/components/BackLink";
import { useRequireAuth, useIsAdmin, useHasPermission, useUserScope, useUserInitial } from "@/lib/user";
import { useSessionCache } from "@/lib/session-state";
import { readDashboardCache, writeDashboardCache } from "@/lib/dashboardUtils";
import { fmtKg } from "@/lib/netKg";
import { loadSkuCatalogue, type SkuCatalogue } from "@/lib/skuCatalog";
import { hydrateAll, HYDRATE_CONCURRENCY } from "@/lib/dashboardFetch";
import {
  listAllJobCards, getAccounting,
  type JobCardRow, type JcCounters, type AccountingResponse,
} from "@/lib/jobcard-dashboard";
import {
  buildRecord, buildTree, buildPivot, rollMaterials, rollByproducts,
  zeroMetrics, addRecord, yieldPct, lossPct, dimFansOut,
  DIM_LABELS, JC_CHAIN, PIVOT_COL_CAP, NA,
  type JcRecord, type Metrics, type Dim, type SortKey, type Node,
} from "./_build";

// ── constants ─────────────────────────────────────────────────────────────

type Lens =
  | "overview" | "consumption" | "yield" | "warehouse"
  | "customer" | "balance" | "records" | "pivot";

const LENSES: { key: Lens; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "consumption", label: "Consumption" },
  { key: "yield", label: "Yield & Loss" },
  { key: "warehouse", label: "Warehouse & Floor" },
  { key: "customer", label: "Customer & SO" },
  { key: "balance", label: "Balance & Exceptions" },
  { key: "records", label: "Records" },
  { key: "pivot", label: "Pivot" },
];

/** The group dimension each lens opens on. The user can still change it. */
const LENS_DIM: Record<Lens, Dim> = {
  overview: "process", consumption: "category", yield: "process",
  warehouse: "factory", customer: "customer", balance: "status",
  records: "process", pivot: "process",
};

type WindowKey = "today" | "week" | "month" | "lastmonth" | "3m" | "fy" | "all" | "custom";
const WINDOW_LABELS: Record<WindowKey, string> = {
  today: "Today", week: "Last 7 days", month: "This month", lastmonth: "Last month",
  "3m": "Last 3 months", fy: "This financial year", all: "All time", custom: "Custom range",
};

type DateBasis = "plan_date" | "created_at" | "start_time" | "end_time";
const BASIS_LABELS: Record<DateBasis, string> = {
  plan_date: "Plan date", created_at: "Created date",
  start_time: "Start time", end_time: "End time",
};

const GROUP_DIMS: Dim[] = [
  "process", "stage", "outKind", "status", "category", "factory", "floor",
  "lead", "customer", "month", "entity", "article", "so", "batch",
];

const SORTS: { key: SortKey; label: string }[] = [
  { key: "outputKg", label: "Output kg" },
  { key: "inputKg", label: "Input kg" },
  { key: "consumedKg", label: "Consumed kg" },
  { key: "plannedKg", label: "Planned kg" },
  { key: "offgradeKg", label: "Off-grade kg" },
  { key: "lossPct", label: "Loss %" },
  { key: "yieldPct", label: "Yield %" },
  { key: "unbalanced", label: "Unbalanced" },
  { key: "jcs", label: "Job cards" },
  { key: "timeMin", label: "Run time" },
  { key: "name", label: "Name" },
];

const ENTITIES = ["CFPL", "CDPL"] as const;
type EntityScope = (typeof ENTITIES)[number] | "BOTH";

const RECORDS_PAGE = 50;
const LIST_CACHE = (k: string) => `jc-dash:list:${k}`;

// ── formatting ────────────────────────────────────────────────────────────

const fmtN = (n: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n || 0);
const fmtPct = (p: number | null) => (p == null ? NA : `${p.toFixed(1)}%`);
/** kg under a tonne, tonnes above — the shop floor reads both. */
const fmtWt = (kg: number) => (Math.abs(kg) >= 1000 ? `${(kg / 1000).toFixed(2)} t` : `${fmtKg(kg, 1)} kg`);
const fmtHrs = (min: number) => (min >= 60 ? `${(min / 60).toFixed(1)} h` : `${Math.round(min)} m`);

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

// ── page ──────────────────────────────────────────────────────────────────

export default function JobCardDashboardPage() {
  const router = useRouter();
  const allowed = useRequireAuth(router.replace);
  const isAdmin = useIsAdmin();
  const scope = useUserScope();
  // Accounting sits behind its OWN permission — a user can list every job card
  // and be refused every detail.
  const canAccounting = useHasPermission("production", "job_cards", "accounting", "view");
  // The category dimension comes from all_sku, which is an SO-module read.
  const canSku = useHasPermission("so", null, null, "view");

  // scope + window (persisted)
  const [entity, setEntity] = useSessionCache<EntityScope>("jc-dash:entity", "CFPL");
  const [basis, setBasis] = useSessionCache<DateBasis>("jc-dash:basis", "plan_date");
  const [windowKey, setWindowKey] = useSessionCache<WindowKey>("jc-dash:window", "month");
  const [customFrom, setCustomFrom] = useSessionCache<string>("jc-dash:from", "");
  const [customTo, setCustomTo] = useSessionCache<string>("jc-dash:to", "");

  // view (persisted)
  const [lens, setLens] = useSessionCache<Lens>("jc-dash:lens", "overview");
  const [groupBy, setGroupBy] = useSessionCache<Dim>("jc-dash:groupBy", "process");
  const [sortKey, setSortKey] = useSessionCache<SortKey>("jc-dash:sortKey", "outputKg");
  const [sortDir, setSortDir] = useSessionCache<"asc" | "desc">("jc-dash:sortDir", "desc");
  const [filtersOpen, setFiltersOpen] = useSessionCache<boolean>("jc-dash:filtersOpen", false);
  const [pivotRow, setPivotRow] = useSessionCache<Dim>("jc-dash:pivotRow", "process");
  const [pivotCol, setPivotCol] = useSessionCache<Dim>("jc-dash:pivotCol", "month");

  // filters (persisted)
  const [fProcess, setFProcess] = useSessionCache<string[]>("jc-dash:fProcess", []);
  const [fStatus, setFStatus] = useSessionCache<string[]>("jc-dash:fStatus", []);
  const [fCategory, setFCategory] = useSessionCache<string[]>("jc-dash:fCategory", []);
  const [fFactory, setFFactory] = useSessionCache<string[]>("jc-dash:fFactory", []);
  const [fFloor, setFFloor] = useSessionCache<string[]>("jc-dash:fFloor", []);
  const [fCustomer, setFCustomer] = useSessionCache<string[]>("jc-dash:fCustomer", []);
  const [fOutKind, setFOutKind] = useSessionCache<string[]>("jc-dash:fOutKind", []);
  const [unbalancedOnly, setUnbalancedOnly] = useSessionCache<boolean>("jc-dash:unbal", false);

  // ephemeral
  const [rows, setRows] = useState<JobCardRow[]>([]);
  const [counters, setCounters] = useState<JcCounters | null>(null);
  const [acc, setAcc] = useState<Map<number, AccountingResponse>>(new Map());
  const [cat, setCat] = useState<SkuCatalogue | null>(null);
  const [catLoaded, setCatLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capped, setCapped] = useState(false);
  const [accForbidden, setAccForbidden] = useState(false);
  const [accFailed, setAccFailed] = useState(0);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [copied, setCopied] = useState(false);

  const activeKey = useRef("");

  // ── load ────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!allowed || !isAdmin) return;
    if (!canSku) {
      // No so:view — there is no catalogue to fetch, but the derive step still
      // has to be released. Flip in a microtask so this is not a synchronous
      // setState inside an effect.
      queueMicrotask(() => setCatLoaded(true));
      return;
    }
    const ac = new AbortController();
    loadSkuCatalogue(ac.signal)
      .then(setCat)
      .catch(() => setCat(null))
      .finally(() => setCatLoaded(true));
    return () => ac.abort();
  }, [allowed, isAdmin, canSku]);

  const load = useCallback(async (signal: AbortSignal) => {
    const w = computeWindow(windowKey, customFrom, customTo);
    const key = `${entity}:${basis}:${w.cacheKey}`;
    activeKey.current = key;

    // Paint the last list for this window immediately. Only the list is
    // cached — accounting payloads are far too large for localStorage, so
    // metrics repopulate as hydration lands.
    const cached = readDashboardCache<JobCardRow[]>(LIST_CACHE(key));
    if (cached?.payload?.length) {
      setRows(cached.payload);
      setLoading(false);
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    setError(null);
    setAccForbidden(false);
    setAccFailed(0);
    setProgress(null);

    try {
      const res = await listAllJobCards(
        {
          entity: entity === "BOTH" ? undefined : entity,
          date_field: basis,
          date_from: w.from,
          date_to: w.to,
          sort_by: "plan_date",
          sort_order: "DESC",
        },
        { signal },
      );
      if (activeKey.current !== key) return;   // a newer window won

      setRows(res.rows);
      setCounters(res.counters);
      setCapped(res.capped);
      writeDashboardCache(LIST_CACHE(key), res.rows);
      setLoading(false);

      if (!canAccounting || res.rows.length === 0) {
        setAcc(new Map());
        return;
      }

      const ids = res.rows.map((r) => r.job_card_id);
      setProgress({ done: 0, total: ids.length });
      const h = await hydrateAll<AccountingResponse>(
        ids,
        (id, s) => getAccounting(id, s),
        {
          signal,
          onProgress: (done, total) => {
            if (activeKey.current === key) setProgress({ done, total });
          },
        },
      );
      if (activeKey.current !== key) return;
      setAcc(h.ok);
      setAccForbidden(h.forbidden);
      setAccFailed(h.failed.length);
    } catch (e) {
      if (signal.aborted || activeKey.current !== key) return;
      setError(e instanceof Error ? e.message : "Failed to load job cards.");
      setLoading(false);
    } finally {
      if (activeKey.current === key) { setRefreshing(false); setProgress(null); }
    }
  }, [entity, basis, windowKey, customFrom, customTo, canAccounting]);

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

  // ── derive ──────────────────────────────────────────────────────────────

  const records = useMemo<JcRecord[]>(
    () => (catLoaded ? rows.map((r) => buildRecord(r, acc.get(r.job_card_id), cat, basis)) : []),
    [rows, acc, cat, catLoaded, basis],
  );

  // Cascading options: each chip group ignores its own active filter, so the
  // list of choices reflects what the OTHER filters allow.
  const passes = useCallback((r: JcRecord, except: string): boolean => {
    if (except !== "process" && fProcess.length && !fProcess.includes(r.process)) return false;
    if (except !== "status" && fStatus.length && !fStatus.includes(r.status)) return false;
    if (except !== "category" && fCategory.length && !fCategory.includes(r.category)) return false;
    if (except !== "factory" && fFactory.length && !fFactory.includes(r.factory)) return false;
    if (except !== "floor" && fFloor.length && !fFloor.includes(r.floor)) return false;
    if (except !== "customer" && fCustomer.length && !fCustomer.includes(r.customer)) return false;
    if (except !== "outKind" && fOutKind.length && !fOutKind.includes(r.outKind)) return false;
    if (except !== "unbal" && unbalancedOnly && (!r.hydrated || r.isBalanced)) return false;
    return true;
  }, [fProcess, fStatus, fCategory, fFactory, fFloor, fCustomer, fOutKind, unbalancedOnly]);

  const opts = useMemo(() => {
    const distinct = (get: (r: JcRecord) => string, except: string) => {
      const s = new Set<string>();
      for (const r of records) if (passes(r, except)) { const v = get(r); if (v && v !== NA) s.add(v); }
      return [...s].sort((a, b) => a.localeCompare(b));
    };
    return {
      process: distinct((r) => r.process, "process"),
      status: distinct((r) => r.status, "status"),
      category: distinct((r) => r.category, "category"),
      factory: distinct((r) => r.factory, "factory"),
      floor: distinct((r) => r.floor, "floor"),
      customer: distinct((r) => r.customer, "customer"),
      outKind: distinct((r) => r.outKind, "outKind"),
    };
  }, [records, passes]);

  // Memoise the parsed terms, not a closure over them: the React Compiler
  // cannot preserve a useMemo whose value is a function with an early return.
  const terms = useMemo(
    () => search.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [search],
  );

  const filtered = useMemo(() => {
    const hit = (r: JcRecord) => {
      if (!terms.length) return true;
      const hay = [
        r.number, r.process, r.stage, r.article, r.customer, r.factory, r.floor,
        r.lead, r.status, r.batch, r.category, r.entity, ...r.soNumbers,
      ].join(" ").toLowerCase();
      return terms.every((t) => hay.includes(t));
    };
    return records.filter((r) => passes(r, "") && hit(r));
  }, [records, passes, terms]);

  const kpi = useMemo(() => {
    const m = zeroMetrics();
    for (const r of filtered) addRecord(m, r);
    return m;
  }, [filtered]);

  const chain = useMemo(() => JC_CHAIN[groupBy] ?? [groupBy], [groupBy]);
  const tree = useMemo(
    () => buildTree(filtered, chain, sortKey, sortDir),
    [filtered, chain, sortKey, sortDir],
  );

  const materials = useMemo(() => rollMaterials(filtered), [filtered]);
  const byproducts = useMemo(() => rollByproducts(filtered), [filtered]);
  const pivot = useMemo(
    () => buildPivot(filtered, pivotRow, pivotCol, sortKey),
    [filtered, pivotRow, pivotCol, sortKey],
  );

  const flat = useMemo(
    () => [...filtered].sort((a, b) => (b.planDate || "").localeCompare(a.planDate || "")),
    [filtered],
  );
  const pageCount = Math.max(1, Math.ceil(flat.length / RECORDS_PAGE));
  const pageRows = flat.slice(page * RECORDS_PAGE, (page + 1) * RECORDS_PAGE);

  const activeFilters =
    fProcess.length + fStatus.length + fCategory.length + fFactory.length +
    fFloor.length + fCustomer.length + fOutKind.length + (unbalancedOnly ? 1 : 0);

  const clearFilters = () => {
    setFProcess([]); setFStatus([]); setFCategory([]); setFFactory([]);
    setFFloor([]); setFCustomer([]); setFOutKind([]); setUnbalancedOnly(false); setSearch("");
  };

  const isSearching = terms.length > 0;
  const isOpen = useCallback((k: string) => isSearching || expanded.has(k), [isSearching, expanded]);
  const toggle = useCallback((k: string) => setExpanded((p) => {
    const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n;
  }), []);

  // Metrics that depend on accounting are meaningless without it. Blank them
  // rather than printing 0 — a 0 kg output reads as a real, catastrophic number.
  const accOk = canAccounting && !accForbidden;
  const kgOrBlank = useCallback((v: number) => (accOk ? fmtWt(v) : NA), [accOk]);

  const handleExport = useCallback(() => {
    const head = [
      "Job Card", "Plan Date", "Entity", "Factory", "Floor", "Process", "Stage",
      "Article", "Category", "Customer", "SO", "Status", "Planned kg",
      "Input kg", "Output kg", "Consumed kg", "Off-grade kg", "Loss %", "Balanced", "Not in kg",
    ];
    const esc = (v: unknown) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const body = flat.map((r) => [
      r.number, r.planDate, r.entity, r.factory, r.floor, r.process, r.stage,
      r.article, r.category, r.customer, r.soNumbers.join(" | "), r.status,
      r.plannedKg.toFixed(3),
      accOk ? r.inputKg.toFixed(3) : "", accOk ? r.outputKg.toFixed(3) : "",
      accOk ? r.consumedKg.toFixed(3) : "", accOk ? r.offgradeKg.toFixed(3) : "",
      accOk && r.totalLossPct != null ? r.totalLossPct.toFixed(2) : "",
      accOk ? (r.isBalanced ? "yes" : "NO") : "", r.notInKg || "",
    ].map(esc).join(","));
    const blob = new Blob([[head.join(","), ...body].join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Job_Card_Summary_${iso(new Date())}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [flat, accOk]);

  const handleCopy = useCallback(async () => {
    const lines = [
      `Job Card Summary — ${WINDOW_LABELS[windowKey]} · ${BASIS_LABELS[basis]} · ${entity}`,
      `${fmtN(kpi.jcs)} job cards · ${kgOrBlank(kpi.outputKg)} output · yield ${accOk ? fmtPct(yieldPct(kpi)) : NA}`,
      "",
      ...tree.map((g) => `${g.label}: ${fmtN(g.m.jcs)} JC · ${kgOrBlank(g.m.outputKg)}`),
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard blocked */ }
  }, [windowKey, basis, entity, kpi, tree, accOk, kgOrBlank]);

  // No `if (!allowed) return null`: useRequireAuth is true on the server and
  // false on the client's first render, so gating the render on it causes a
  // hydration mismatch. Effects are gated on it; the body is guarded below.
  if (!isAdmin) {
    return (
      <Shell router={router}>
        <div className="max-w-md mx-auto mt-16 bg-white border border-[var(--aws-border)] rounded-lg p-8 text-center">
          <div className="text-[15px] font-semibold text-[var(--text-primary)]">Access restricted</div>
          <div className="text-[13px] text-[var(--text-secondary)] mt-2">
            The Job Card Summary is available to administrators only.
          </div>
        </div>
      </Shell>
    );
  }

  const dimLabel = DIM_LABELS[groupBy];

  return (
    <Shell router={router}>
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h1 className="text-[20px] font-semibold text-[var(--text-primary)] leading-tight">Job Card Summary</h1>
          <div className="text-[12px] text-[var(--text-secondary)] flex flex-wrap items-center gap-2 mt-0.5">
            <span>{WINDOW_LABELS[windowKey]}</span>
            <span>· {BASIS_LABELS[basis]}</span>
            {refreshing && <span className="text-blue-600">· refreshing…</span>}
            {progress && progress.done < progress.total && (
              <span className="text-blue-600">· hydrating {progress.done}/{progress.total}</span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            value={entity}
            options={[...ENTITIES, "BOTH"] as EntityScope[]}
            labels={{ CFPL: "CFPL", CDPL: "CDPL", BOTH: "Both ⚠" }}
            onChange={(v) => setEntity(v)}
          />
          <select value={basis} onChange={(e) => setBasis(e.target.value as DateBasis)}
            className="px-2 py-1.5 text-[12px] border border-[var(--aws-border)] rounded-md bg-white">
            {(Object.keys(BASIS_LABELS) as DateBasis[]).map((b) => (
              <option key={b} value={b}>{BASIS_LABELS[b]}</option>
            ))}
          </select>
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

      {/* Degraded states — each one names what is missing and what it costs. */}
      {error && <Banner tone="rose">{error}</Banner>}
      {entity === "BOTH" && (
        <Banner tone="amber">
          CFPL and CDPL are separate legal entities. Totals below combine both.
        </Banner>
      )}
      {capped && (
        <Banner tone="amber">
          The window returned more job cards than the page loads. Totals cover only
          what was fetched and are understated — narrow the date range.
        </Banner>
      )}
      {!canAccounting && (
        <Banner tone="amber">
          You do not have <code>production/job_cards/accounting:view</code>. Input,
          output, consumption, yield and balance are blank — not zero.
        </Banner>
      )}
      {canAccounting && accForbidden && (
        <Banner tone="amber">
          Accounting details were refused mid-load. Quantity metrics are blank rather
          than partial.
        </Banner>
      )}
      {accFailed > 0 && (
        <Banner tone="amber">
          {accFailed} of {rows.length} accounting details failed to load. Quantity
          totals are understated by whatever those job cards hold.
        </Banner>
      )}
      {!canSku && (
        <Banner tone="amber">
          You do not have <code>so:view</code>, so the Category dimension is unavailable.
        </Banner>
      )}
      {catLoaded && cat && !cat.packWeights && (
        <Banner tone="amber">
          The SKU bulk endpoint is unavailable, so pack weights are missing. Lines
          measured in pcs / nos cannot be converted and are excluded from kg totals.
        </Banner>
      )}

      {/* Integrity strip — what this view is actually made of. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[var(--text-secondary)]
                      bg-white border border-[var(--aws-border)] rounded-md px-3 py-2 mb-4">
        <span><b className="text-[var(--text-primary)]">{fmtN(rows.length)}</b> job cards loaded</span>
        <span>hydrated <b className="text-[var(--text-primary)]">{fmtN(kpi.hydrated)}</b>/{fmtN(kpi.jcs)}</span>
        <span>concurrency {HYDRATE_CONCURRENCY}</span>
        <span>basis {BASIS_LABELS[basis]}</span>
        <span>scope {scope.isAdmin ? "all warehouses" : `${scope.warehouses.length} warehouse(s)`}</span>
        {kpi.notInKg > 0 && (
          <span className="text-amber-700" title="Rows whose uom could not be converted to kg — excluded from every kg total above.">
            {fmtN(kpi.notInKg)} not in kg
          </span>
        )}
        {cat && cat.ambiguousNames.length > 0 && (
          <span className="text-amber-700" title={cat.ambiguousNames.join(", ")}>
            {cat.ambiguousNames.length} ambiguous SKU{cat.ambiguousNames.length > 1 ? "s" : ""}
          </span>
        )}
        {counters && <span>server counters: {fmtN(counters.total)} total · {fmtN(counters.overdue)} overdue</span>}
      </div>

      {/* KPI band */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
        <Kpi label="Job cards" value={fmtN(kpi.jcs)}
          sub={`${fmtN(kpi.completed)} completed · ${fmtN(kpi.inProgress)} running`} />
        <Kpi label="Planned" value={fmtWt(kpi.plannedKg)} sub={`${fmtN(kpi.locked)} locked`} />
        <Kpi label="Output" value={kgOrBlank(kpi.outputKg)}
          sub={accOk ? `input ${fmtWt(kpi.inputKg)}` : "needs accounting access"} />
        <Kpi label="Yield" value={accOk ? fmtPct(yieldPct(kpi)) : NA}
          sub={accOk ? `loss ${fmtPct(lossPct(kpi))}` : undefined}
          tone={accOk && (yieldPct(kpi) ?? 100) < 85 ? "amber" : undefined} />
        <Kpi label="Unbalanced" value={accOk ? fmtN(kpi.unbalanced) : NA}
          sub={accOk ? `off-grade ${fmtWt(kpi.offgradeKg)}` : undefined}
          tone={accOk && kpi.unbalanced > 0 ? "rose" : undefined} />
      </div>

      {/* Lens tabs */}
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

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            placeholder="Search job card, article, customer, SO…"
            className="w-full pl-3 pr-7 py-1.5 text-[12px] border border-[var(--aws-border)] rounded-md" />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-2 top-1.5 text-[var(--text-secondary)]">✕</button>
          )}
        </div>

        {lens !== "pivot" && lens !== "records" && lens !== "consumption" && (
          <label className="text-[12px] text-[var(--text-secondary)] flex items-center gap-1.5">
            Group
            <select value={groupBy} onChange={(e) => { setGroupBy(e.target.value as Dim); setExpanded(new Set()); }}
              className="px-2 py-1.5 text-[12px] border border-[var(--aws-border)] rounded-md bg-white">
              {GROUP_DIMS.filter((d) => d !== "category" || canSku).map((d) => (
                <option key={d} value={d}>{DIM_LABELS[d]}</option>
              ))}
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
          <ChipRow label="Process" options={opts.process} selected={fProcess} onToggle={mkToggle(fProcess, setFProcess)} />
          <ChipRow label="Status" options={opts.status} selected={fStatus} onToggle={mkToggle(fStatus, setFStatus)} />
          <ChipRow label="Output" options={opts.outKind} selected={fOutKind} onToggle={mkToggle(fOutKind, setFOutKind)} />
          {canSku && <ChipRow label="Category" options={opts.category} selected={fCategory} onToggle={mkToggle(fCategory, setFCategory)} />}
          <ChipRow label="Factory" options={opts.factory} selected={fFactory} onToggle={mkToggle(fFactory, setFFactory)} />
          <ChipRow label="Floor" options={opts.floor} selected={fFloor} onToggle={mkToggle(fFloor, setFFloor)} />
          <ChipRow label="Customer" options={opts.customer} selected={fCustomer} onToggle={mkToggle(fCustomer, setFCustomer)} />
          <div className="flex items-center justify-between pt-1">
            <label className={`flex items-center gap-1.5 text-[12px] ${accOk ? "text-rose-700" : "text-[var(--text-secondary)]"}`}>
              <input type="checkbox" checked={unbalancedOnly} disabled={!accOk}
                onChange={(e) => setUnbalancedOnly(e.target.checked)} />
              Unbalanced only{!accOk && " (needs accounting access)"}
            </label>
            {activeFilters > 0 && (
              <button onClick={clearFilters} className="text-[12px] text-rose-600 hover:underline">Clear all</button>
            )}
          </div>
        </div>
      )}

      {/* Body */}
      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-10 bg-white border border-[var(--aws-border)] rounded-md animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white border border-[var(--aws-border)] rounded-md px-3 py-12 text-center text-[13px] text-[var(--text-secondary)]">
          No job cards in this view.
          {activeFilters > 0 && <button onClick={clearFilters} className="ml-2 text-rose-600 hover:underline">Clear filters</button>}
        </div>
      ) : lens === "records" ? (
        <RecordsTable rows={pageRows} accOk={accOk} page={page} pageCount={pageCount}
          total={flat.length} onPage={setPage} onOpen={(id) => router.push(`/modules/job-card/${id}`)} />
      ) : lens === "consumption" ? (
        <MaterialsTable rolls={materials} accOk={accOk} />
      ) : lens === "balance" ? (
        <BalanceView records={filtered} byproducts={byproducts} accOk={accOk}
          onOpen={(id) => router.push(`/modules/job-card/${id}`)} />
      ) : lens === "pivot" ? (
        <PivotTable pivot={pivot} rowDim={pivotRow} colDim={pivotCol} accOk={accOk} />
      ) : (
        <TreeTable tree={tree} chain={chain} dimLabel={dimLabel} lens={lens} accOk={accOk}
          total={kpi} isOpen={isOpen} onToggle={toggle} fansOut={dimFansOut(groupBy)} />
      )}

      {/* Legend */}
      <div className="mt-4 text-[11px] text-[var(--text-secondary)] leading-relaxed">
        <b>How to read this.</b> Every kg figure is net — quantities in gms are
        divided by 1000, and pcs / nos are multiplied by the pack weight from the
        SKU master. Litres and any SKU without a pack weight cannot be converted, so
        those rows are excluded from kg totals and counted under “not in kg” rather
        than silently added as zero. Yield is output ÷ input and is blank, not 0%,
        when there is no recorded input. Off-grade excludes control samples, balance
        material, wastage and all packaging (<code>pm_*</code>) categories.
        {dimFansOut(groupBy) && " Grouping by sales order lists a job card under every SO it serves, so the column total can exceed the overall total."}
        {" "}Source: <code>/production/job-cards-v2</code> plus per-card{" "}
        <code>/accounting</code>; categories and pack weights from{" "}
        <code>/so/sku-lookup/bulk</code>.
      </div>
    </Shell>
  );
}

// ── helpers ───────────────────────────────────────────────────────────────

const mkToggle = (sel: string[], set: (v: string[]) => void) => (v: string) =>
  set(sel.includes(v) ? sel.filter((x) => x !== v) : [...sel, v]);

// ── sub-components ────────────────────────────────────────────────────────

/** Inline chrome. There is no _chrome.tsx for job-card (unlike transfer /
 *  customer-returns), so this mirrors the header in
 *  src/app/modules/job-card/page.tsx rather than inventing a second look. */
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
          <button onClick={() => router.push("/modules/job-card")} className="hover:underline">Job Cards</button>
          <span>/</span>
          <span className="text-white">Summary</span>
        </nav>
        <div className="flex-1" />
        <button
          onClick={() => router.push("/modules/profile")}
          aria-label="Open profile"
          title="Profile"
          className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]"
        >
          {initial}
        </button>
      </header>
      <main className="flex-1 max-w-[1280px] w-full mx-auto px-4 sm:px-6 py-6">
        <div className="mb-3">
          <BackLink parentHref="/modules/job-card" label="job cards" />
        </div>
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

function Segmented<T extends string>({ value, options, labels, onChange }: {
  value: T; options: T[]; labels: Record<string, string>; onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-[var(--aws-border)] overflow-hidden">
      {options.map((o) => (
        <button key={o} onClick={() => onChange(o)}
          className={`px-2.5 py-1.5 text-[12px] ${
            value === o ? "bg-[var(--aws-navy)] text-white" : "bg-white text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          }`}>
          {labels[o] ?? o}
        </button>
      ))}
    </div>
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

/** The drill tree. One comparator sorts every level because each node carries
 *  its own metrics bag; expansion is keyed by the full path so two nodes with
 *  the same label under different parents stay independent. */
function TreeTable({ tree, chain, dimLabel, lens, accOk, total, isOpen, onToggle, fansOut }: {
  tree: Node[]; chain: Dim[]; dimLabel: string; lens: Lens; accOk: boolean;
  total: Metrics; isOpen: (k: string) => boolean; onToggle: (k: string) => void; fansOut: boolean;
}) {
  const yieldLens = lens === "yield";
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
            <th className="px-2 py-2 font-medium text-right w-16">JCs</th>
            <th className="px-2 py-2 font-medium text-right w-24">Planned</th>
            <th className="px-2 py-2 font-medium text-right w-24">Input</th>
            <th className="px-2 py-2 font-medium text-right w-24">Output</th>
            {yieldLens ? (
              <>
                <th className="px-2 py-2 font-medium text-right w-20">Yield</th>
                <th className="px-2 py-2 font-medium text-right w-20">Loss</th>
              </>
            ) : (
              <>
                <th className="px-2 py-2 font-medium text-right w-24">Off-grade</th>
                <th className="px-2 py-2 font-medium text-right w-20">Unbal.</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {tree.map((nd) => (
            <TreeRows key={nd.key} node={nd} accOk={accOk} yieldLens={yieldLens}
              isOpen={isOpen} onToggle={onToggle} />
          ))}
        </tbody>
        <tfoot>
          <tr className="bg-[var(--background)] font-semibold border-t border-[var(--aws-border)]">
            <td className="px-3 py-2">Total{fansOut && <span className="ml-2 font-normal text-[10px] text-amber-700">rows may double-count across SOs</span>}</td>
            <td className="px-2 py-2 text-right">{fmtN(total.jcs)}</td>
            <td className="px-2 py-2 text-right">{fmtWt(total.plannedKg)}</td>
            <td className="px-2 py-2 text-right">{accOk ? fmtWt(total.inputKg) : NA}</td>
            <td className="px-2 py-2 text-right">{accOk ? fmtWt(total.outputKg) : NA}</td>
            {yieldLens ? (
              <>
                <td className="px-2 py-2 text-right">{accOk ? fmtPct(yieldPct(total)) : NA}</td>
                <td className="px-2 py-2 text-right">{accOk ? fmtPct(lossPct(total)) : NA}</td>
              </>
            ) : (
              <>
                <td className="px-2 py-2 text-right">{accOk ? fmtWt(total.offgradeKg) : NA}</td>
                <td className="px-2 py-2 text-right">{accOk ? fmtN(total.unbalanced) : NA}</td>
              </>
            )}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function TreeRows({ node, accOk, yieldLens, isOpen, onToggle }: {
  node: Node; accOk: boolean; yieldLens: boolean;
  isOpen: (k: string) => boolean; onToggle: (k: string) => void;
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
          <span className="inline-block w-4 text-[var(--text-secondary)]">
            {hasKids ? (open ? "▾" : "▸") : ""}
          </span>
          <span className={node.depth === 0 ? "font-medium text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}>
            {node.label}
          </span>
          {accOk && m.unbalanced > 0 && (
            <span className="ml-2 px-1.5 py-0.5 rounded-full text-[10px] bg-rose-50 text-rose-700">
              {m.unbalanced} unbalanced
            </span>
          )}
          {m.notInKg > 0 && (
            <span className="ml-2 px-1.5 py-0.5 rounded-full text-[10px] bg-amber-50 text-amber-700"
              title="Rows excluded from kg totals — uom could not be converted.">
              {m.notInKg} not in kg
            </span>
          )}
        </td>
        <td className="px-2 py-1.5 text-right text-[var(--text-secondary)]">{fmtN(m.jcs)}</td>
        <td className="px-2 py-1.5 text-right">{fmtWt(m.plannedKg)}</td>
        <td className="px-2 py-1.5 text-right">{accOk ? fmtWt(m.inputKg) : NA}</td>
        <td className="px-2 py-1.5 text-right font-medium">{accOk ? fmtWt(m.outputKg) : NA}</td>
        {yieldLens ? (
          <>
            <td className="px-2 py-1.5 text-right">{accOk ? fmtPct(yieldPct(m)) : NA}</td>
            <td className="px-2 py-1.5 text-right">{accOk ? fmtPct(lossPct(m)) : NA}</td>
          </>
        ) : (
          <>
            <td className="px-2 py-1.5 text-right">{accOk ? fmtWt(m.offgradeKg) : NA}</td>
            <td className="px-2 py-1.5 text-right text-[var(--text-secondary)]">{accOk ? (m.unbalanced || "") : NA}</td>
          </>
        )}
      </tr>
      {open && node.children.map((c) => (
        <TreeRows key={c.key} node={c} accOk={accOk} yieldLens={yieldLens}
          isOpen={isOpen} onToggle={onToggle} />
      ))}
    </>
  );
}

function MaterialsTable({ rolls, accOk }: { rolls: ReturnType<typeof rollMaterials>; accOk: boolean }) {
  if (!accOk) {
    return (
      <div className="bg-white border border-[var(--aws-border)] rounded-md px-3 py-12 text-center text-[13px] text-[var(--text-secondary)]">
        Consumption needs <code>production/job_cards/accounting:view</code>.
      </div>
    );
  }
  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md overflow-x-auto">
      <table className="w-full text-[12px] min-w-[760px]">
        <thead>
          <tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)] bg-[var(--background)]">
            <th className="px-3 py-2 font-medium">Material</th>
            <th className="px-2 py-2 font-medium w-20">Kind</th>
            <th className="px-2 py-2 font-medium w-36">Category</th>
            <th className="px-2 py-2 font-medium text-right w-24">Issued</th>
            <th className="px-2 py-2 font-medium text-right w-24">Consumed</th>
            <th className="px-2 py-2 font-medium text-right w-24">Returned</th>
            <th className="px-2 py-2 font-medium text-right w-16">JCs</th>
          </tr>
        </thead>
        <tbody>
          {rolls.map((r) => (
            <tr key={`${r.material}|${r.kind}`} className="border-b border-[var(--aws-border)]/60">
              <td className="px-3 py-1.5 text-[var(--text-primary)]">
                {r.material}
                {r.notInKg > 0 && (
                  <span className="ml-2 px-1.5 py-0.5 rounded-full text-[10px] bg-amber-50 text-amber-700"
                    title="Lines whose uom could not be converted to kg.">
                    {r.notInKg} not in kg
                  </span>
                )}
              </td>
              <td className="px-2 py-1.5 text-[var(--text-secondary)]">{r.kind}</td>
              <td className="px-2 py-1.5 text-[var(--text-secondary)]">{r.category}</td>
              <td className="px-2 py-1.5 text-right">{fmtWt(r.issuedKg)}</td>
              <td className="px-2 py-1.5 text-right font-medium">{fmtWt(r.consumedKg)}</td>
              <td className="px-2 py-1.5 text-right text-[var(--text-secondary)]">{r.returnKg ? fmtWt(r.returnKg) : ""}</td>
              <td className="px-2 py-1.5 text-right text-[var(--text-secondary)]">{fmtN(r.jcs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BalanceView({ records, byproducts, accOk, onOpen }: {
  records: JcRecord[]; byproducts: ReturnType<typeof rollByproducts>;
  accOk: boolean; onOpen: (id: number) => void;
}) {
  if (!accOk) {
    return (
      <div className="bg-white border border-[var(--aws-border)] rounded-md px-3 py-12 text-center text-[13px] text-[var(--text-secondary)]">
        Balance and byproducts need <code>production/job_cards/accounting:view</code>.
      </div>
    );
  }
  const unbalanced = records.filter((r) => r.hydrated && !r.isBalanced)
    .sort((a, b) => Math.abs(b.balanceDiffKg) - Math.abs(a.balanceDiffKg));
  return (
    <div className="space-y-4">
      <div className="bg-white border border-[var(--aws-border)] rounded-md overflow-x-auto">
        <div className="px-3 py-2 text-[12px] font-medium border-b border-[var(--aws-border)] bg-[var(--background)]">
          Byproducts by category
          <span className="ml-2 font-normal text-[11px] text-[var(--text-secondary)]">
            off-grade excludes control samples, balance material, wastage and pm_*
          </span>
        </div>
        <table className="w-full text-[12px] min-w-[520px]">
          <thead>
            <tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
              <th className="px-3 py-2 font-medium">Category</th>
              <th className="px-2 py-2 font-medium w-24">Off-grade</th>
              <th className="px-2 py-2 font-medium text-right w-28">Quantity</th>
              <th className="px-2 py-2 font-medium text-right w-20">Lines</th>
            </tr>
          </thead>
          <tbody>
            {byproducts.length === 0 ? (
              <tr><td colSpan={4} className="px-3 py-8 text-center text-[var(--text-secondary)]">No byproducts recorded.</td></tr>
            ) : byproducts.map((b) => (
              <tr key={b.category} className="border-b border-[var(--aws-border)]/60">
                <td className="px-3 py-1.5">{b.category}</td>
                <td className="px-2 py-1.5">
                  {b.offgrade
                    ? <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-amber-50 text-amber-700">off-grade</span>
                    : <span className="text-[var(--text-secondary)] text-[11px]">—</span>}
                </td>
                <td className="px-2 py-1.5 text-right font-medium">{fmtWt(b.kg)}</td>
                <td className="px-2 py-1.5 text-right text-[var(--text-secondary)]">{fmtN(b.lines)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-white border border-[var(--aws-border)] rounded-md overflow-x-auto">
        <div className="px-3 py-2 text-[12px] font-medium border-b border-[var(--aws-border)] bg-[var(--background)]">
          Unbalanced job cards ({unbalanced.length})
          <span className="ml-2 font-normal text-[11px] text-[var(--text-secondary)]">
            input − accounted exceeds the BOM tolerance
          </span>
        </div>
        <table className="w-full text-[12px] min-w-[720px]">
          <thead>
            <tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
              <th className="px-3 py-2 font-medium w-32">Job card</th>
              <th className="px-2 py-2 font-medium">Article</th>
              <th className="px-2 py-2 font-medium w-32">Process</th>
              <th className="px-2 py-2 font-medium text-right w-24">Input</th>
              <th className="px-2 py-2 font-medium text-right w-24">Output</th>
              <th className="px-2 py-2 font-medium text-right w-28">Difference</th>
              <th className="px-2 py-2 font-medium text-right w-20">Tol.</th>
            </tr>
          </thead>
          <tbody>
            {unbalanced.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-[var(--text-secondary)]">Every hydrated job card balances.</td></tr>
            ) : unbalanced.map((r) => (
              <tr key={r.id} className="border-b border-[var(--aws-border)]/60">
                <td className="px-3 py-1.5">
                  <button onClick={() => onOpen(r.id)} className="font-mono text-blue-700 hover:underline">{r.number}</button>
                </td>
                <td className="px-2 py-1.5">{r.article}</td>
                <td className="px-2 py-1.5 text-[var(--text-secondary)]">{r.process}</td>
                <td className="px-2 py-1.5 text-right">{fmtWt(r.inputKg)}</td>
                <td className="px-2 py-1.5 text-right">{fmtWt(r.outputKg)}</td>
                <td className="px-2 py-1.5 text-right font-medium text-rose-600">{fmtWt(r.balanceDiffKg)}</td>
                <td className="px-2 py-1.5 text-right text-[var(--text-secondary)]">
                  {r.tolerancePct == null ? NA : `${r.tolerancePct}%`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RecordsTable({ rows, accOk, page, pageCount, total, onPage, onOpen }: {
  rows: JcRecord[]; accOk: boolean; page: number; pageCount: number; total: number;
  onPage: (p: number) => void; onOpen: (id: number) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="bg-white border border-[var(--aws-border)] rounded-md overflow-x-auto">
        <table className="w-full text-[12px] min-w-[1000px]">
          <thead>
            <tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)] bg-[var(--background)]">
              <th className="px-3 py-2 font-medium w-32">Job card</th>
              <th className="px-2 py-2 font-medium w-24">Plan date</th>
              <th className="px-2 py-2 font-medium">Article</th>
              <th className="px-2 py-2 font-medium w-28">Process</th>
              <th className="px-2 py-2 font-medium w-28">Customer</th>
              <th className="px-2 py-2 font-medium w-24">Factory</th>
              <th className="px-2 py-2 font-medium w-24">Status</th>
              <th className="px-2 py-2 font-medium text-right w-24">Planned</th>
              <th className="px-2 py-2 font-medium text-right w-24">Output</th>
              <th className="px-2 py-2 font-medium text-right w-20">Loss</th>
              <th className="px-2 py-2 font-medium text-right w-20">Run</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-[var(--aws-border)]/60 hover:bg-[var(--background)]">
                <td className="px-3 py-1.5">
                  <button onClick={() => onOpen(r.id)} className="font-mono text-blue-700 hover:underline">{r.number}</button>
                  {r.locked && <span className="ml-1.5 text-[10px] text-amber-700">🔒</span>}
                </td>
                <td className="px-2 py-1.5 text-[var(--text-secondary)]">{r.planDate || NA}</td>
                <td className="px-2 py-1.5">
                  {r.article}
                  <span className="ml-1.5 text-[10px] text-[var(--text-secondary)]">{r.category}</span>
                </td>
                <td className="px-2 py-1.5 text-[var(--text-secondary)]">{r.process}</td>
                <td className="px-2 py-1.5 text-[var(--text-secondary)]">{r.customer}</td>
                <td className="px-2 py-1.5 text-[var(--text-secondary)]">{r.factory}</td>
                <td className="px-2 py-1.5">
                  <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-slate-100 text-slate-600">{r.status}</span>
                </td>
                <td className="px-2 py-1.5 text-right">{fmtWt(r.plannedKg)}</td>
                <td className="px-2 py-1.5 text-right font-medium">{accOk && r.hydrated ? fmtWt(r.outputKg) : NA}</td>
                <td className="px-2 py-1.5 text-right">{accOk && r.hydrated ? fmtPct(r.totalLossPct) : NA}</td>
                <td className="px-2 py-1.5 text-right text-[var(--text-secondary)]">{r.timeMin ? fmtHrs(r.timeMin) : NA}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between text-[11px] text-[var(--text-secondary)]">
        <span>{fmtN(total)} job cards · page {page + 1} of {pageCount}</span>
        <div className="flex gap-1">
          <Btn onClick={() => onPage(Math.max(0, page - 1))} disabled={page === 0} label="Prev" />
          <Btn onClick={() => onPage(Math.min(pageCount - 1, page + 1))} disabled={page >= pageCount - 1} label="Next" />
        </div>
      </div>
    </div>
  );
}

function PivotTable({ pivot, rowDim, colDim, accOk }: {
  pivot: ReturnType<typeof buildPivot>; rowDim: Dim; colDim: Dim; accOk: boolean;
}) {
  const cell = (r: string, c: string): Metrics | undefined => pivot.cells.get(`${r} ${c}`);
  const val = (m: Metrics | undefined) => (m ? (accOk ? fmtWt(m.outputKg) : fmtN(m.jcs)) : "");
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
              <th className="px-2 py-2 font-medium text-right whitespace-nowrap">Total</th>
            </tr>
          </thead>
          <tbody>
            {pivot.rows.map((r) => (
              <tr key={r} className="border-b border-[var(--aws-border)]/60">
                <td className="px-3 py-1.5 font-medium text-[var(--text-primary)] sticky left-0 bg-white whitespace-nowrap">{r}</td>
                {pivot.cols.map((c) => (
                  <td key={c} className="px-2 py-1.5 text-right whitespace-nowrap">{val(cell(r, c))}</td>
                ))}
                <td className="px-2 py-1.5 text-right font-medium whitespace-nowrap">{val(pivot.rowTotals.get(r))}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-[var(--background)] font-semibold border-t border-[var(--aws-border)]">
              <td className="px-3 py-2 sticky left-0 bg-[var(--background)]">Total</td>
              {pivot.cols.map((c) => (
                <td key={c} className="px-2 py-2 text-right whitespace-nowrap">{val(pivot.colTotals.get(c))}</td>
              ))}
              <td className="px-2 py-2 text-right whitespace-nowrap">{val(pivot.grand)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="text-[11px] text-[var(--text-secondary)]">
        Cells show {accOk ? "output kg" : "job card count (output needs accounting access)"}.
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
