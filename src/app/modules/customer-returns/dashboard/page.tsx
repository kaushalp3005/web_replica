"use client";

// Customer Returns dashboard — analytics/metrics/grouping. Faithful port of the
// legacy RTV dashboard (legacy-frontend/app/[company]/rtv/dashboard/page.tsx),
// adapted to web_replica idiom: maroon --aws tokens, inline SVG (no lucide),
// native date fmt (no date-fns), no shadcn. Keyed by rtv_id (no numeric id).
//
// Data: fetch ALL CRs (listCustomerReturns, paginated) then hydrate each with
// line details (getCustomerReturn, bounded concurrency) → flatten header×lines to
// RTVRow[]. Stale-while-revalidate localStorage cache paints instantly on revisit.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRequireAuth, useIsAdmin } from "@/lib/user";
import {
  listCustomerReturns,
  getCustomerReturn,
  type CRListItem,
  type CRLine,
  type CRStatus,
} from "@/lib/customer-returns";
import {
  makeRecordSearch,
  parseSearchTerms,
  readDashboardCache,
  writeDashboardCache,
  canonicalize,
  groupByCanonical,
  CUSTOMER_ALIASES,
} from "@/lib/dashboardUtils";
import { getDisplayWarehouseName } from "@/lib/transferBuildSummary";
import { CustomerReturnsChrome } from "../_chrome";
import { CompanyToggle, useCompany, cx, StatusBadge, ErrorBanner, fmtN, fmtV, fmtR } from "../_shared";

// ── formatters (fmtN/fmtV/fmtR come from _shared for module-wide consistency) ──
const num = (v: string | number | null | undefined): number => {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : parseFloat(v);
  return isFinite(n) ? n : 0;
};
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const monthLabel = (d: string | null): string => {
  if (!d) return "Unknown";
  const date = new Date(d);
  return isNaN(date.getTime()) ? "Unknown" : date.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
};
const shortDate = (d: string | null | undefined): string => {
  if (!d) return "";
  const date = new Date(d);
  return isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" });
};
const titleFold = (s: string | null | undefined): string => {
  if (!s) return "";
  const t = String(s).trim();
  return t ? t.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : "";
};
const chipToggle = (set: Set<string>, val: string): Set<string> => {
  const n = new Set(set);
  if (n.has(val)) n.delete(val); else n.add(val);
  return n;
};

// ── inline icons ─────────────────────────────────────────────────────────────
type IconProps = { className?: string };
const S = ({ className, children }: IconProps & { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className ?? "h-4 w-4"} aria-hidden="true">{children}</svg>
);
const IArrowLeft = (p: IconProps) => <S {...p}><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></S>;
const IPackage = (p: IconProps) => <S {...p}><path d="M16.5 9.4 7.5 4.21" /><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><path d="M3.27 6.96 12 12.01l8.73-5.05" /><path d="M12 22.08V12" /></S>;
const ITrend = (p: IconProps) => <S {...p}><path d="M22 7 13.5 15.5 8.5 10.5 2 17" /><path d="M16 7h6v6" /></S>;
const IRupee = (p: IconProps) => <S {...p}><path d="M6 3h12" /><path d="M6 8h12" /><path d="m6 13 8.5 8" /><path d="M6 13h3a5 5 0 0 0 0-10" /></S>;
const IClock = (p: IconProps) => <S {...p}><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></S>;
const ICheck = (p: IconProps) => <S {...p}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><path d="m9 11 3 3L22 4" /></S>;
const IUsers = (p: IconProps) => <S {...p}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></S>;
const IFilter = (p: IconProps) => <S {...p}><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" /></S>;
const IChevDown = (p: IconProps) => <S {...p}><path d="m6 9 6 6 6-6" /></S>;
const IChevRight = (p: IconProps) => <S {...p}><path d="m9 18 6-6-6-6" /></S>;
const IExpand = (p: IconProps) => <S {...p}><path d="m7 15 5 5 5-5" /><path d="m7 9 5-5 5 5" /></S>;
const IRefresh = (p: IconProps) => <S {...p}><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></S>;
const ICopy = (p: IconProps) => <S {...p}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></S>;
const IX = (p: IconProps) => <S {...p}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></S>;
const ISearch = (p: IconProps) => <S {...p}><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></S>;
const ISort = (p: IconProps) => <S {...p}><path d="m3 16 4 4 4-4" /><path d="M7 20V4" /><path d="m21 8-4-4-4 4" /><path d="M17 4v16" /></S>;

// ── types ────────────────────────────────────────────────────────────────────
type ViewMode = "qty" | "value" | "both";
type GroupByKey = "factory_unit" | "customer" | "status" | "material_type" | "item_category" | "month";

const GROUP_OPTIONS: { value: GroupByKey; label: string }[] = [
  { value: "factory_unit", label: "Factory Unit" },
  { value: "customer", label: "Customer" },
  { value: "status", label: "Status" },
  { value: "material_type", label: "Material" },
  { value: "item_category", label: "Category" },
  { value: "month", label: "Month" },
];

const DATE_PRESETS = [
  { label: "Today", fn: () => { const d = ymd(new Date()); return [d, d]; } },
  { label: "This Week", fn: () => { const now = new Date(); const day = now.getDay() === 0 ? 6 : now.getDay() - 1; const start = new Date(now); start.setDate(now.getDate() - day); return [ymd(start), ymd(now)]; } },
  { label: "This Month", fn: () => [ymd(new Date(new Date().getFullYear(), new Date().getMonth(), 1)), ymd(new Date())] },
  { label: "Last Month", fn: () => { const d = new Date(); d.setMonth(d.getMonth() - 1); return [ymd(new Date(d.getFullYear(), d.getMonth(), 1)), ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0))]; } },
  { label: "This FY", fn: () => { const y = new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1; return [`${y}-04-01`, ymd(new Date())]; } },
  { label: "All Time", fn: () => ["", ""] },
];

interface RTVRow {
  rtv_id: string; rtv_date: string | null; factory_unit: string; customer: string;
  status: string; month_label: string;
  material_type: string; item_category: string; sub_category: string; item_description: string;
  uom: string; qty: number; rate: number; value: number; net_weight: number;
}

const RTV_SEARCH_FIELDS: (keyof RTVRow & string)[] = [
  "rtv_id", "customer", "factory_unit", "status", "material_type",
  "item_category", "sub_category", "item_description", "uom", "rtv_date",
];

function seedRow(h: CRListItem): RTVRow {
  return {
    rtv_id: h.rtv_id, rtv_date: h.rtv_date ?? null,
    factory_unit: titleFold(h.factory_unit) || "Unassigned",
    customer: h.customer || "Unknown",
    status: h.status || "Pending", month_label: monthLabel(h.rtv_date || h.created_ts || null),
    material_type: "", item_category: "", sub_category: "", item_description: "",
    uom: "", qty: num(h.total_qty), rate: 0, value: 0, net_weight: 0,
  };
}
function lineToRow(h: CRLine, header: CRListItem): RTVRow {
  return {
    rtv_id: header.rtv_id, rtv_date: header.rtv_date ?? null,
    factory_unit: titleFold(header.factory_unit) || "Unassigned",
    customer: header.customer || "Unknown",
    status: header.status || "Pending", month_label: monthLabel(header.rtv_date || header.created_ts || null),
    material_type: titleFold(h.material_type), item_category: titleFold(h.item_category),
    sub_category: titleFold(h.sub_category), item_description: h.item_description || "",
    uom: h.uom || "", qty: num(h.qty), rate: num(h.rate), value: num(h.value), net_weight: num(h.net_weight),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
export default function CustomerReturnsDashboard() {
  const router = useRouter();
  useRequireAuth(router.replace);
  const isAdmin = useIsAdmin();
  const [company, setCompany] = useCompany();

  // Seed company from the ?company= link param on first load (cold/shared links);
  // the toggle takes over after. Mount-guard + deferred setState = runs once.
  const seededCompany = useRef(false);
  useEffect(() => {
    if (seededCompany.current) return;
    seededCompany.current = true;
    const c = new URLSearchParams(window.location.search).get("company");
    if ((c === "CFPL" || c === "CDPL") && c !== company) queueMicrotask(() => setCompany(c));
  }, [company, setCompany]);

  const [rows, setRows] = useState<RTVRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [selFactory, setSelFactory] = useState<Set<string>>(new Set());
  const [selCustomer, setSelCustomer] = useState<Set<string>>(new Set());
  const [selMaterial, setSelMaterial] = useState<Set<string>>(new Set());
  const [selStatus, setSelStatus] = useState<Set<string>>(new Set());
  const [groupSimilar, setGroupSimilar] = useState(true);
  const [selCanonical, setSelCanonical] = useState<Set<string>>(new Set());

  const [groupBy, setGroupBy] = useState<GroupByKey>("factory_unit");
  const [viewMode, setViewMode] = useState<ViewMode>("both");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [allExpanded, setAllExpanded] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<"value" | "qty" | "count" | "name">("value");
  const [copied, setCopied] = useState(false);
  const [customerPopup, setCustomerPopup] = useState<string | null>(null);
  const [peek, setPeek] = useState<{ rtvId: string; x: number; y: number } | null>(null);

  const cacheKey = `cr-dashboard:cache:v1:${company}`;

  const fetchData = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent ?? false;
    if (silent) setRefreshing(true);
    else { setLoading(true); setError(null); }
    try {
      const headers: CRListItem[] = [];
      let page = 1;
      while (page <= 50) {
        const resp = await listCustomerReturns(company, { page, per_page: 100 });
        headers.push(...resp.records);
        if (resp.records.length < 100 || page >= resp.total_pages) break;
        page++;
      }
      if (!silent) {
        setRows(headers.map(seedRow));
        setLoading(false);
        setLoadingDetails(true);
      }
      // Hydrate line details with bounded concurrency.
      const enriched: RTVRow[] = [];
      let idx = 0;
      const worker = async () => {
        while (idx < headers.length) {
          const h = headers[idx++];
          try {
            const detail = await getCustomerReturn(company, h.rtv_id);
            if (detail.lines?.length) enriched.push(...detail.lines.map((l) => lineToRow(l, h)));
            else enriched.push(seedRow(h));
          } catch { enriched.push(seedRow(h)); }
        }
      };
      await Promise.all(Array.from({ length: 6 }, () => worker()));
      setRows(enriched);
      writeDashboardCache(cacheKey, { rows: enriched });
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : "Failed to load dashboard data");
    } finally {
      if (silent) setRefreshing(false);
      else { setLoading(false); setLoadingDetails(false); }
    }
  }, [company, cacheKey]);

  // Paint from cache on mount/company-change, then revalidate; else cold load.
  useEffect(() => {
    if (!isAdmin) return;
    const cached = readDashboardCache<{ rows: RTVRow[] }>(cacheKey);
    if (cached?.payload?.rows?.length) {
      queueMicrotask(() => { setRows(cached.payload.rows); setLoading(false); fetchData({ silent: true }); });
    } else {
      queueMicrotask(() => fetchData({ silent: false }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company, isAdmin]);

  const activeFilterCount = [dateFrom, dateTo].filter(Boolean).length +
    [selFactory, selMaterial, selStatus].filter((s) => s.size > 0).length +
    (groupSimilar ? (selCanonical.size > 0 ? 1 : 0) + (selCustomer.size > 0 ? 1 : 0) : (selCustomer.size > 0 ? 1 : 0));

  const inDateRange = useCallback((d: string | null): boolean => {
    if (!dateFrom && !dateTo) return true;
    const x = (d || "").slice(0, 10);
    if (dateFrom && x < dateFrom) return false;
    if (dateTo && x > dateTo) return false;
    return true;
  }, [dateFrom, dateTo]);

  const searchTerms = useMemo(() => parseSearchTerms(searchQuery), [searchQuery]);
  const isSearching = searchTerms.length > 0;
  const searchMatch = useMemo(() => makeRecordSearch<RTVRow>(searchQuery, RTV_SEARCH_FIELDS), [searchQuery]);

  const filtered = useMemo(() => rows.filter((r) => {
    if (!inDateRange(r.rtv_date)) return false;
    if (selFactory.size > 0 && !selFactory.has(r.factory_unit)) return false;
    if (groupSimilar) {
      if (selCanonical.size > 0) {
        if (!selCanonical.has(canonicalize(r.customer, CUSTOMER_ALIASES))) return false;
        if (selCustomer.size > 0 && !selCustomer.has(r.customer)) return false;
      }
    } else if (selCustomer.size > 0 && !selCustomer.has(r.customer)) return false;
    if (selMaterial.size > 0 && !selMaterial.has(r.material_type || "")) return false;
    if (selStatus.size > 0 && !selStatus.has(r.status)) return false;
    if (!searchMatch(r)) return false;
    return true;
  }), [rows, inDateRange, selFactory, selCustomer, selCanonical, groupSimilar, selMaterial, selStatus, searchMatch]);

  const cascadedOpts = useMemo(() => {
    const apply = (exclude: string) => rows.filter((r) => {
      if (!inDateRange(r.rtv_date)) return false;
      if (exclude !== "factory" && selFactory.size > 0 && !selFactory.has(r.factory_unit)) return false;
      if (exclude !== "customer" && selCustomer.size > 0 && !selCustomer.has(r.customer)) return false;
      if (exclude !== "material" && selMaterial.size > 0 && !selMaterial.has(r.material_type || "")) return false;
      if (exclude !== "status" && selStatus.size > 0 && !selStatus.has(r.status)) return false;
      return true;
    });
    const countBy = (recs: RTVRow[], f: (r: RTVRow) => string) => {
      const map = new Map<string, Set<string>>();
      for (const r of recs) { const v = f(r); if (!v) continue; if (!map.has(v)) map.set(v, new Set()); map.get(v)!.add(r.rtv_id); }
      return Array.from(map.entries()).map(([name, s]) => ({ name, count: s.size })).sort((a, b) => b.count - a.count);
    };
    const customerRows = apply("customer");
    const canonicalMap = groupByCanonical(customerRows.map((r) => r.customer).filter(Boolean), CUSTOMER_ALIASES);
    const rtvIdByCustomer = new Map<string, Set<string>>();
    for (const r of customerRows) {
      if (!r.customer) continue;
      if (!rtvIdByCustomer.has(r.customer)) rtvIdByCustomer.set(r.customer, new Set());
      rtvIdByCustomer.get(r.customer)!.add(r.rtv_id);
    }
    const canonicalCustomers = Array.from(canonicalMap.entries()).map(([name, variants]) => {
      const ids = new Set<string>();
      for (const v of variants) { const set = rtvIdByCustomer.get(v); if (set) set.forEach((id) => ids.add(id)); }
      return { name, count: ids.size, variants };
    });
    return {
      factories: countBy(apply("factory"), (r) => r.factory_unit),
      customers: countBy(apply("customer"), (r) => r.customer),
      canonicalCustomers,
      materials: countBy(apply("material"), (r) => r.material_type),
      statuses: countBy(apply("status"), (r) => r.status),
    };
  }, [rows, inDateRange, selFactory, selCustomer, selMaterial, selStatus]);

  const kpis = useMemo(() => {
    const rtvIds = new Set(filtered.map((r) => r.rtv_id));
    return {
      total_rtvs: rtvIds.size,
      total_qty: filtered.reduce((s, r) => s + r.qty, 0),
      total_value: filtered.reduce((s, r) => s + r.value, 0),
      total_kg: filtered.reduce((s, r) => s + r.net_weight, 0),
      pending: new Set(filtered.filter((r) => r.status === "Pending").map((r) => r.rtv_id)).size,
      approved: new Set(filtered.filter((r) => r.status === "Approved").map((r) => r.rtv_id)).size,
      customers: new Set(filtered.map((r) => r.customer).filter(Boolean)).size,
    };
  }, [filtered]);

  const groupField = useCallback((r: RTVRow): string => {
    switch (groupBy) {
      case "factory_unit": return r.factory_unit || "Unassigned";
      case "customer": return r.customer || "Unknown";
      case "status": return r.status || "Pending";
      case "material_type": return r.material_type || "N/A";
      case "item_category": return r.item_category || "Uncategorized";
      case "month": return r.month_label || "Unknown";
    }
  }, [groupBy]);

  const summary = useMemo(() => {
    const l2Field = (r: RTVRow): string =>
      groupBy === "item_category" ? (r.sub_category || "General") : (r.item_category || "Uncategorized");

    const l1Map = new Map<string, RTVRow[]>();
    for (const r of filtered) { const g = groupField(r); if (!l1Map.has(g)) l1Map.set(g, []); l1Map.get(g)!.push(r); }

    const data = Array.from(l1Map.entries()).map(([label, records]) => {
      const l2Map = new Map<string, RTVRow[]>();
      for (const r of records) { const k = l2Field(r); if (!l2Map.has(k)) l2Map.set(k, []); l2Map.get(k)!.push(r); }
      const children = Array.from(l2Map.entries()).map(([sl, recs]) => {
        const l3Map = new Map<string, RTVRow[]>();
        for (const r of recs) { const k = r.item_description || "—"; if (!l3Map.has(k)) l3Map.set(k, []); l3Map.get(k)!.push(r); }
        const items = Array.from(l3Map.entries()).map(([item, irecs]) => {
          const iq = irecs.reduce((s, r) => s + r.qty, 0);
          const iv = irecs.reduce((s, r) => s + r.value, 0);
          return {
            item_description: item, material_type: irecs[0]?.material_type || "", uom: irecs[0]?.uom || "",
            total_qty: iq, total_value: iv, total_kg: irecs.reduce((s, r) => s + r.net_weight, 0),
            avg_rate: iq > 0 ? iv / iq : 0, rtv_count: new Set(irecs.map((r) => r.rtv_id)).size, records: irecs,
          };
        }).sort((a, b) => b.total_value - a.total_value);
        const sq = recs.reduce((s, r) => s + r.qty, 0);
        const sv = recs.reduce((s, r) => s + r.value, 0);
        return {
          sub_label: sl, rtv_count: new Set(recs.map((r) => r.rtv_id)).size,
          total_qty: sq, total_value: sv, total_kg: recs.reduce((s, r) => s + r.net_weight, 0),
          avg_rate: sq > 0 ? sv / sq : 0, item_count: new Set(recs.map((r) => r.item_description).filter(Boolean)).size,
          children: items,
        };
      }).sort((a, b) => b.total_value - a.total_value);
      const qty = records.reduce((s, r) => s + r.qty, 0);
      const value = records.reduce((s, r) => s + r.value, 0);
      return {
        group_label: label, rtv_count: new Set(records.map((r) => r.rtv_id)).size,
        total_qty: qty, total_value: value, total_kg: records.reduce((s, r) => s + r.net_weight, 0),
        avg_rate: qty > 0 ? value / qty : 0,
        customer_count: new Set(records.map((r) => r.customer).filter(Boolean)).size,
        pending_count: new Set(records.filter((r) => r.status === "Pending").map((r) => r.rtv_id)).size,
        children,
      };
    });
    const sortFn = (a: typeof data[0], b: typeof data[0]) => {
      switch (sortBy) {
        case "value": return b.total_value - a.total_value;
        case "qty": return b.total_qty - a.total_qty;
        case "count": return b.rtv_count - a.rtv_count;
        case "name": return a.group_label.localeCompare(b.group_label);
      }
    };
    return [...data].sort(sortFn);
  }, [filtered, groupBy, groupField, sortBy]);

  const toggle = (k: string) => setExpanded((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const allKeys = useCallback(() => {
    const keys = new Set<string>();
    summary.forEach((l1) => {
      keys.add(l1.group_label);
      l1.children.forEach((l2) => {
        const k2 = l1.group_label + "|||" + l2.sub_label;
        keys.add(k2);
        l2.children.forEach((l3) => keys.add(k2 + "|||" + l3.item_description));
      });
    });
    return keys;
  }, [summary]);
  const toggleAll = () => {
    if (allExpanded) { setExpanded(new Set()); setAllExpanded(false); return; }
    setExpanded(allKeys()); setAllExpanded(true);
  };
  const searchExpandKeys = useMemo(() => (isSearching ? allKeys() : null), [isSearching, allKeys]);
  const effExpanded = searchExpandKeys ?? expanded;

  const clearFilters = () => {
    setDateFrom(""); setDateTo(""); setSelFactory(new Set()); setSelCustomer(new Set());
    setSelCanonical(new Set()); setSelMaterial(new Set()); setSelStatus(new Set());
  };

  const handleCopy = async () => {
    let periodLine: string;
    if (dateFrom && dateTo) periodLine = dateFrom === dateTo ? `Period: ${shortDate(dateFrom)}` : `Period: ${shortDate(dateFrom)} to ${shortDate(dateTo)}`;
    else if (dateFrom) periodLine = `Period: from ${shortDate(dateFrom)}`;
    else if (dateTo) periodLine = `Period: up to ${shortDate(dateTo)}`;
    else periodLine = "Period: All time";
    const lines = [
      `Customer Returns Summary - ${shortDate(ymd(new Date()))} - ${company}`,
      periodLine, "",
      `Total: ${kpis.total_rtvs} CRs | ${fmtN(kpis.total_qty)} Qty${kpis.total_kg > 0 ? ` | ${fmtN(kpis.total_kg)} Kg` : ""} | ${fmtV(kpis.total_value)}`,
      `Pending: ${kpis.pending} | Approved: ${kpis.approved} | Customers: ${kpis.customers}`, "",
    ];
    summary.forEach((l1) => lines.push(`${l1.group_label}  ${l1.rtv_count} CRs  ${fmtN(l1.total_qty)} Qty${l1.total_kg > 0 ? `  ${fmtN(l1.total_kg)} Kg` : ""}  ${fmtV(l1.total_value)}`));
    try { await navigator.clipboard.writeText(lines.join("\n")); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* clipboard unavailable */ }
  };

  // Dashboard opens the READ-ONLY view (matches legacy dashboard → rtv/[id]); the
  // list opens the editable detail.
  const detailHref = (rtvId: string) => `/modules/customer-returns/${encodeURIComponent(rtvId)}/view?company=${company}`;

  const showVal = (qty: number, value: number) => {
    if (viewMode === "qty") return <span className="tabular-nums">{fmtN(qty)} <span className="text-[10px] text-[var(--text-secondary)]">Qty</span></span>;
    if (viewMode === "value") return <span className="tabular-nums">{fmtV(value)}</span>;
    return <><div className="tabular-nums">{fmtN(qty)} <span className="text-[10px] text-[var(--text-secondary)]">Qty</span></div><div className="text-[10px] text-[var(--text-secondary)] tabular-nums">{fmtV(value)}</div></>;
  };
  const showValKg = (qty: number, value: number, kg: number) => {
    const kgLine = kg > 0 ? <div className="text-[10px] text-[var(--text-secondary)] tabular-nums">{fmtN(kg)} Kg</div> : null;
    if (viewMode === "qty") return <><div className="tabular-nums">{fmtN(qty)} <span className="text-[10px] text-[var(--text-secondary)]">Qty</span></div>{kgLine}</>;
    if (viewMode === "value") return <><div className="tabular-nums">{fmtV(value)}</div>{kgLine}</>;
    return <><div className="tabular-nums">{fmtN(qty)} <span className="text-[10px] text-[var(--text-secondary)]">Qty</span></div>{kgLine}<div className="text-[10px] text-[var(--text-secondary)] tabular-nums">{fmtV(value)}</div></>;
  };

  const openPeek = (e: React.MouseEvent, rtvId: string) => setPeek({ rtvId, x: e.clientX, y: e.clientY });

  if (!isAdmin) {
    return (
      <CustomerReturnsChrome title="Dashboard">
        <section className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)]">
          You don&rsquo;t have access to the Customer Returns module.
        </section>
      </CustomerReturnsChrome>
    );
  }

  const groupLabel = GROUP_OPTIONS.find((g) => g.value === groupBy)?.label;

  return (
    <CustomerReturnsChrome title="Dashboard">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2 min-w-0">
          <Link href={`/modules/customer-returns?company=${company}`} aria-label="Back to list" className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-[var(--background)] text-[var(--text-secondary)] flex-shrink-0">
            <IArrowLeft className="h-4 w-4" />
          </Link>
          <div className="min-w-0">
            <h1 className="text-[18px] sm:text-[22px] font-bold tracking-tight text-[var(--text-primary)]">Customer Returns Summary</h1>
            <p className="text-[12px] text-[var(--text-secondary)]">
              Analytics on customer-return transactions
              {activeFilterCount > 0 && <span className="ml-1.5 text-[var(--aws-orange)]">· {activeFilterCount} filter{activeFilterCount > 1 ? "s" : ""} active</span>}
              {loadingDetails && <span className="ml-1.5 text-[#b45309]">· loading line details…</span>}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <CompanyToggle value={company} onChange={setCompany} />
          <button onClick={() => fetchData({ silent: true })} className="h-8 inline-flex items-center gap-1 text-[12px] rounded-md border border-[var(--aws-border)] px-2.5 bg-white hover:border-[var(--aws-orange)]">
            <IRefresh className={cx("h-3.5 w-3.5", (loading || refreshing || loadingDetails) && "animate-spin")} /><span className="hidden sm:inline">Refresh</span>
          </button>
          <button onClick={handleCopy} className="h-8 inline-flex items-center gap-1 text-[12px] rounded-md border border-[var(--aws-border)] px-2.5 bg-white hover:border-[var(--aws-orange)]">
            <ICopy className="h-3.5 w-3.5" /><span className="hidden sm:inline">{copied ? "Copied!" : "Copy"}</span>
          </button>
        </div>
      </div>

      {error && <div className="mb-4"><ErrorBanner message={error} /></div>}

      {/* KPIs */}
      {!loading && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
          <KPI icon={<IPackage className="h-5 w-5" />} label="Total CRs" value={fmtN(kpis.total_rtvs)} color="bg-blue-100 text-blue-600" />
          <KPI icon={<ITrend className="h-5 w-5" />} label="Total Quantity" value={fmtN(kpis.total_qty)} color="bg-emerald-100 text-emerald-600" />
          <KPI icon={<IRupee className="h-5 w-5" />} label="Total Value" value={fmtV(kpis.total_value)} color="bg-violet-100 text-violet-600" />
          <KPI icon={<IClock className="h-5 w-5" />} label="Pending CRs" value={fmtN(kpis.pending)} amber={kpis.pending > 0} color="bg-amber-100 text-amber-600" />
          <KPI icon={<ICheck className="h-5 w-5" />} label="Approved CRs" value={fmtN(kpis.approved)} color="bg-emerald-100 text-emerald-700" />
          <KPI icon={<IUsers className="h-5 w-5" />} label="Unique Customers" value={fmtN(kpis.customers)} color="bg-cyan-100 text-cyan-600" />
        </div>
      )}

      {/* Filters */}
      {!loading && (
        <div className="bg-white border border-[var(--aws-border)] rounded-md overflow-hidden mb-4">
          {/* Date */}
          <div className="flex flex-wrap items-center gap-2 px-4 py-3 bg-[var(--background)] border-b border-[var(--aws-border)]">
            <IFilter className="h-4 w-4 text-[var(--text-muted)]" />
            <div className="flex items-center gap-1.5 flex-wrap">
              {DATE_PRESETS.map((p) => {
                const [f, t] = p.fn();
                const active = (!dateFrom && !dateTo && p.label === "All Time") || (dateFrom === f && dateTo === t && f !== "");
                return (
                  <button key={p.label} onClick={() => { setDateFrom(f); setDateTo(t); }}
                    className={cx("text-[13px] font-medium px-3 py-1.5 rounded-md border", active ? "bg-[var(--aws-navy)] text-white border-[var(--aws-navy)]" : "bg-white border-[var(--aws-border)] hover:bg-[var(--background)]")}>
                    {p.label}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-2 sm:ml-auto">
              <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} aria-label="From date" className="h-9 rounded border border-[var(--aws-border)] px-2 text-[13px] bg-white" />
              <span className="text-[13px] text-[var(--text-secondary)]">to</span>
              <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} aria-label="To date" className="h-9 rounded border border-[var(--aws-border)] px-2 text-[13px] bg-white" />
            </div>
          </div>

          <ChipRow label="Status" opts={cascadedOpts.statuses} sel={selStatus} onToggle={(v) => setSelStatus(chipToggle(selStatus, v))} activeCls="bg-amber-500 text-white border-amber-500" approvedCls="bg-emerald-600 text-white border-emerald-600" />
          <ChipRow label="Factory" opts={cascadedOpts.factories} sel={selFactory} onToggle={(v) => setSelFactory(chipToggle(selFactory, v))} activeCls="bg-blue-600 text-white border-blue-600" render={getDisplayWarehouseName} />

          {/* Customer (with group-similar toggle) */}
          {(groupSimilar ? cascadedOpts.canonicalCustomers.length > 0 : cascadedOpts.customers.length > 0) && (
            <div className="px-4 py-3 border-b border-[var(--aws-border)]">
              <div className="flex flex-wrap items-start gap-2">
                <div className="flex items-center gap-2 w-[170px] flex-shrink-0 pt-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]">Customer</span>
                  <label className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] cursor-pointer ml-auto">
                    <input type="checkbox" checked={groupSimilar} onChange={(e) => { setGroupSimilar(e.target.checked); if (!e.target.checked) setSelCanonical(new Set()); }} className="accent-[var(--aws-navy)]" />
                    Group similar
                  </label>
                </div>
                <div className="flex flex-wrap gap-1.5 flex-1">
                  {groupSimilar
                    ? cascadedOpts.canonicalCustomers.slice(0, 40).map((c) => {
                        const active = selCanonical.has(c.name);
                        return (
                          <button key={c.name} onClick={() => { setSelCanonical(chipToggle(selCanonical, c.name)); if (active) setSelCustomer(new Set()); }}
                            className={cx("text-[13px] font-medium px-3 py-1.5 rounded-md border", active ? "bg-violet-600 text-white border-violet-600" : "bg-white border-[var(--aws-border)] hover:bg-[var(--background)]")}>
                            {c.name} <span className="text-[11px] opacity-70">({c.count})</span>
                            {c.variants.length > 1 && <span className="text-[10px] ml-1 opacity-60">· {c.variants.length} variants</span>}
                          </button>
                        );
                      })
                    : cascadedOpts.customers.slice(0, 40).map((c) => (
                        <button key={c.name} onClick={() => setSelCustomer(chipToggle(selCustomer, c.name))}
                          className={cx("text-[13px] font-medium px-3 py-1.5 rounded-md border", selCustomer.has(c.name) ? "bg-violet-600 text-white border-violet-600" : "bg-white border-[var(--aws-border)] hover:bg-[var(--background)]")}>
                          {c.name} <span className="text-[11px] opacity-70">({c.count})</span>
                        </button>
                      ))}
                </div>
              </div>
              {/* Variants drill-down: with Group-similar ON and canonical(s) picked,
                  narrow to individual variant names (sets selCustomer, still AND-ed
                  with the canonical filter). */}
              {groupSimilar && selCanonical.size > 0 && (() => {
                const variants = cascadedOpts.canonicalCustomers
                  .filter((c) => selCanonical.has(c.name))
                  .flatMap((c) => c.variants)
                  .filter((v, i, a) => a.indexOf(v) === i);
                if (variants.length <= 1) return null;
                return (
                  <div className="mt-2 ml-[178px] pl-3 border-l-2 border-violet-300 flex flex-wrap gap-1.5">
                    <span className="text-[11px] text-[var(--text-secondary)] self-center">└ Variants:</span>
                    {variants.map((v) => (
                      <button key={v} onClick={() => setSelCustomer(chipToggle(selCustomer, v))}
                        className={cx("text-[12px] px-2.5 py-1 rounded-md border", selCustomer.has(v) ? "bg-violet-600 text-white border-violet-600" : "bg-white border-[var(--aws-border)] hover:bg-[var(--background)]")}>
                        {v}
                      </button>
                    ))}
                  </div>
                );
              })()}
            </div>
          )}

          <ChipRow label="Material" opts={cascadedOpts.materials} sel={selMaterial} onToggle={(v) => setSelMaterial(chipToggle(selMaterial, v))} activeCls="bg-orange-600 text-white border-orange-600" />

          {activeFilterCount > 0 && (
            <div className="px-4 py-2.5 bg-[#fdf3f1]">
              <button onClick={clearFilters} className="text-[13px] font-medium text-[#b1361e] inline-flex items-center gap-1.5 hover:underline">
                <IX className="h-3.5 w-3.5" />Clear all filters ({activeFilterCount})
              </button>
            </div>
          )}
        </div>
      )}

      {/* Group / view / search / sort */}
      {!loading && (
        <div className="flex flex-col gap-2 mb-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex items-center gap-3 flex-wrap">
              <Segmented label="Group" options={GROUP_OPTIONS.map((g) => ({ value: g.value, label: g.label }))} value={groupBy} onChange={(v) => { setGroupBy(v as GroupByKey); setExpanded(new Set()); setAllExpanded(false); }} />
              <Segmented label="View" options={[{ value: "qty", label: "Qty" }, { value: "value", label: "Value (₹)" }, { value: "both", label: "Both" }]} value={viewMode} onChange={(v) => setViewMode(v as ViewMode)} />
            </div>
            <button onClick={toggleAll} className="h-7 inline-flex items-center gap-1 text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
              <IExpand className="h-3.5 w-3.5" />{allExpanded ? "Collapse All" : "Expand All"}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative flex-1 max-w-[300px]">
              <ISearch className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--text-muted)]" />
              <input placeholder="Search within results…" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="h-8 w-full rounded-md border border-[var(--aws-border)] pl-8 pr-7 text-[12px] bg-white" />
              {searchQuery && <button onClick={() => setSearchQuery("")} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"><IX className="h-3 w-3" /></button>}
            </div>
            <div className="flex items-center gap-1">
              <ISort className="h-3.5 w-3.5 text-[var(--text-muted)]" />
              <Segmented options={[{ value: "value", label: "Value" }, { value: "qty", label: "Qty" }, { value: "count", label: "Count" }, { value: "name", label: "A-Z" }]} value={sortBy} onChange={(v) => setSortBy(v as typeof sortBy)} />
            </div>
          </div>
        </div>
      )}

      {/* Summary table */}
      <div className="bg-white border border-[var(--aws-border)] rounded-md overflow-hidden">
        {loading ? (
          <div className="p-4 space-y-2">{Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4"><div className="h-5 w-5 rounded bg-[var(--background)] animate-pulse" /><div className="h-5 flex-1 rounded bg-[var(--background)] animate-pulse" /><div className="h-5 w-20 rounded bg-[var(--background)] animate-pulse" /></div>
          ))}</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <IPackage className="h-10 w-10 text-[var(--text-muted)] mb-3" />
            <p className="text-[13px] font-medium text-[var(--text-primary)]">No CR records found</p>
            <p className="text-[12px] text-[var(--text-secondary)] mt-1">Try adjusting your filters</p>
            {activeFilterCount > 0 && <button onClick={clearFilters} className="mt-3 text-[12px] rounded-md border border-[var(--aws-border)] px-3 py-1.5 bg-white">Clear Filters</button>}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-[var(--aws-border)] bg-[var(--background)] text-[var(--text-secondary)]">
                  <th className="text-left text-[11px] uppercase tracking-wider font-medium px-3 py-2.5 min-w-[240px]">{groupLabel}</th>
                  <th className="text-right text-[11px] uppercase tracking-wider font-medium px-3 py-2.5 w-[60px]">CRs</th>
                  <th className="text-right text-[11px] uppercase tracking-wider font-medium px-3 py-2.5 w-[160px]">{viewMode === "value" ? "Value (₹)" : viewMode === "qty" ? "Qty / Kg" : "Qty / Kg / Value"}</th>
                  <th className="text-right text-[11px] uppercase tracking-wider font-medium px-3 py-2.5 w-[90px] hidden lg:table-cell">Avg Rate</th>
                  <th className="text-right text-[11px] uppercase tracking-wider font-medium px-3 py-2.5 w-[80px] hidden lg:table-cell">Customers</th>
                  <th className="text-right text-[11px] uppercase tracking-wider font-medium px-3 py-2.5 w-[60px] hidden lg:table-cell">Items</th>
                </tr>
              </thead>
              <tbody>
                {summary.map((l1) => {
                  const k1 = l1.group_label; const open1 = effExpanded.has(k1);
                  return (
                    <FragmentRow key={k1}>
                      <tr className="border-b border-[var(--aws-border)] cursor-pointer bg-[var(--aws-navy)] text-white font-semibold" onClick={() => toggle(k1)}>
                        <td className="px-3 py-2.5">
                          <span className="inline-flex items-center gap-1.5">
                            {open1 ? <IChevDown className="h-4 w-4 text-[var(--aws-orange)]" /> : <IChevRight className="h-4 w-4 text-[var(--aws-orange)]" />}
                            {groupBy === "customer" ? (
                              <button onClick={(e) => { e.stopPropagation(); setCustomerPopup(l1.group_label); }} className="hover:underline">{l1.group_label}</button>
                            ) : l1.group_label}
                            {l1.pending_count > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/20 text-amber-200">{l1.pending_count} pending</span>}
                          </span>
                        </td>
                        <td className="text-right px-3 py-2.5 tabular-nums">{l1.rtv_count}</td>
                        <td className="text-right px-3 py-2.5">{showValKg(l1.total_qty, l1.total_value, l1.total_kg)}</td>
                        <td className="text-right px-3 py-2.5 tabular-nums hidden lg:table-cell">{fmtR(l1.avg_rate)}</td>
                        <td className="text-right px-3 py-2.5 tabular-nums hidden lg:table-cell">{l1.customer_count}</td>
                        <td className="text-right px-3 py-2.5 tabular-nums hidden lg:table-cell">{l1.children.reduce((s, c) => s + c.item_count, 0) || l1.children.length}</td>
                      </tr>
                      {open1 && l1.children.map((l2) => {
                        const k2 = k1 + "|||" + l2.sub_label; const open2 = effExpanded.has(k2);
                        return (
                          <FragmentRow key={k2}>
                            <tr className="border-b border-[var(--aws-border)] cursor-pointer bg-[var(--background)] font-medium border-l-[3px] border-l-[var(--aws-orange)]" onClick={() => toggle(k2)}>
                              <td className="px-3 py-2 pl-8"><span className="inline-flex items-center gap-1.5">{open2 ? <IChevDown className="h-3.5 w-3.5" /> : <IChevRight className="h-3.5 w-3.5" />}{l2.sub_label}</span></td>
                              <td className="text-right px-3 py-2 tabular-nums">{l2.rtv_count}</td>
                              <td className="text-right px-3 py-2">{showValKg(l2.total_qty, l2.total_value, l2.total_kg)}</td>
                              <td className="text-right px-3 py-2 tabular-nums hidden lg:table-cell">{fmtR(l2.avg_rate)}</td>
                              <td className="text-right px-3 py-2 tabular-nums hidden lg:table-cell">—</td>
                              <td className="text-right px-3 py-2 tabular-nums hidden lg:table-cell">{l2.item_count}</td>
                            </tr>
                            {open2 && l2.children.map((l3) => {
                              const k3 = k2 + "|||" + l3.item_description; const open3 = effExpanded.has(k3);
                              const rtvMap = new Map<string, { rtv_id: string; rtv_date: string | null; customer: string; factory_unit: string; status: string; qty: number; value: number }>();
                              for (const r of l3.records) {
                                const ex = rtvMap.get(r.rtv_id);
                                if (ex) { ex.qty += r.qty; ex.value += r.value; }
                                else rtvMap.set(r.rtv_id, { rtv_id: r.rtv_id, rtv_date: r.rtv_date, customer: r.customer, factory_unit: r.factory_unit, status: r.status, qty: r.qty, value: r.value });
                              }
                              const l4 = Array.from(rtvMap.values()).sort((a, b) => (b.rtv_date || "").localeCompare(a.rtv_date || ""));
                              return (
                                <FragmentRow key={k3}>
                                  <tr onClick={() => toggle(k3)} className="border-b border-[var(--aws-border)] cursor-pointer bg-[var(--background)]/60 text-[13px]">
                                    <td className="px-3 py-2 pl-14">
                                      <div className="flex items-center gap-2 flex-wrap">
                                        {open3 ? <IChevDown className="h-3 w-3" /> : <IChevRight className="h-3 w-3" />}
                                        <span>{l3.item_description}</span>
                                        {l3.material_type && <span className="text-[10px] px-1 py-0.5 rounded bg-[var(--background)] border border-[var(--aws-border)] text-[var(--text-secondary)]">{l3.material_type}</span>}
                                        {l3.uom && <span className="text-[10px] text-[var(--text-secondary)]">{l3.uom}</span>}
                                        <span className="text-[10px] text-[var(--text-secondary)]">{l4.length} CR{l4.length !== 1 ? "s" : ""}</span>
                                      </div>
                                    </td>
                                    <td className="text-right px-3 py-2 tabular-nums">{l3.rtv_count}</td>
                                    <td className="text-right px-3 py-2">{showValKg(l3.total_qty, l3.total_value, l3.total_kg)}</td>
                                    <td className="text-right px-3 py-2 tabular-nums hidden lg:table-cell">{fmtR(l3.avg_rate)}</td>
                                    <td className="hidden lg:table-cell" /><td className="hidden lg:table-cell" />
                                  </tr>
                                  {open3 && l4.map((tx) => (
                                    <tr key={`${k3}:::${tx.rtv_id}`} className="border-b border-[var(--aws-border)] bg-white text-[12px]">
                                      <td className="px-3 py-1.5 pl-20">
                                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                                          <Link href={detailHref(tx.rtv_id)} onMouseEnter={(e) => openPeek(e, tx.rtv_id)} onMouseLeave={() => setPeek(null)} className="font-medium text-[var(--aws-link)] hover:underline">{tx.rtv_id}</Link>
                                          {tx.rtv_date && <span className="text-[var(--text-secondary)]">{shortDate(tx.rtv_date)}</span>}
                                          {tx.customer && <button onClick={(e) => { e.stopPropagation(); setCustomerPopup(tx.customer); }} className="text-[var(--aws-link)] hover:underline">{tx.customer}</button>}
                                          {tx.factory_unit && <span className="text-[var(--text-secondary)]">{tx.factory_unit}</span>}
                                          <StatusBadge status={tx.status as CRStatus} icon={false} />
                                        </div>
                                      </td>
                                      <td />
                                      <td className="text-right px-3 py-1.5">{showVal(tx.qty, tx.value)}</td>
                                      <td className="text-right px-3 py-1.5 tabular-nums hidden lg:table-cell">{fmtR(tx.qty > 0 ? tx.value / tx.qty : 0)}</td>
                                      <td className="hidden lg:table-cell" /><td className="hidden lg:table-cell" />
                                    </tr>
                                  ))}
                                </FragmentRow>
                              );
                            })}
                          </FragmentRow>
                        );
                      })}
                    </FragmentRow>
                  );
                })}
                {/* Grand total */}
                <tr className="border-t-2 border-[var(--aws-border)] bg-[var(--aws-navy)] text-white font-bold">
                  <td className="px-3 py-2.5">Grand Total</td>
                  <td className="text-right px-3 py-2.5 tabular-nums">{kpis.total_rtvs}</td>
                  <td className="text-right px-3 py-2.5">{showValKg(kpis.total_qty, kpis.total_value, kpis.total_kg)}</td>
                  <td className="text-right px-3 py-2.5 tabular-nums hidden lg:table-cell">{kpis.total_qty > 0 ? fmtR(kpis.total_value / kpis.total_qty) : "—"}</td>
                  <td className="text-right px-3 py-2.5 tabular-nums hidden lg:table-cell">{kpis.customers}</td>
                  <td className="hidden lg:table-cell" />
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* RTV peek (hover) */}
      {peek && (() => {
        const recs = rows.filter((r) => r.rtv_id === peek.rtvId);
        if (recs.length === 0) return null;
        const h = recs[0];
        const tq = recs.reduce((s, r) => s + r.qty, 0);
        const tv = recs.reduce((s, r) => s + r.value, 0);
        const items = new Set(recs.map((r) => r.item_description).filter(Boolean)).size;
        return (
          <div className="fixed z-50 w-72 bg-white border border-[var(--aws-border)] rounded-lg shadow-xl p-3 text-[12px] pointer-events-none"
            style={{ left: Math.min(peek.x + 12, (typeof window !== "undefined" ? window.innerWidth : 1200) - 300), top: peek.y + 12 }}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-[var(--aws-link)]">{h.rtv_id}</span>
              <StatusBadge status={h.status as CRStatus} icon={false} />
            </div>
            <div className="text-[var(--text-secondary)] mt-0.5">{shortDate(h.rtv_date)}</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 mt-2">
              <div><span className="text-[var(--text-secondary)]">Factory:</span> <span className="font-medium">{getDisplayWarehouseName(h.factory_unit)}</span></div>
              <div><span className="text-[var(--text-secondary)]">Customer:</span> <span className="font-medium">{h.customer}</span></div>
            </div>
            <div className="flex justify-between pt-2 mt-2 border-t border-[var(--aws-border)]">
              <span>{items} item{items !== 1 ? "s" : ""}</span>
              <span className="font-medium">{fmtN(tq)} Qty</span>
              <span className="font-semibold">{fmtV(tv)}</span>
            </div>
          </div>
        );
      })()}

      {customerPopup && (
        <CustomerHistoryModal customerName={customerPopup} allRecords={rows} detailHref={detailHref} onClose={() => setCustomerPopup(null)} />
      )}
    </CustomerReturnsChrome>
  );
}

// Fragment wrapper keyed for lists (avoids importing React.Fragment noise).
function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function KPI({ icon, label, value, amber, color }: { icon: React.ReactNode; label: string; value: string; amber?: boolean; color?: string }) {
  return (
    <div className={cx("border rounded-md p-4 bg-white", amber ? "border-amber-300 bg-amber-50/50" : "border-[var(--aws-border)]")}>
      <div className={cx("h-10 w-10 rounded-xl flex items-center justify-center mb-3", color || "bg-[var(--background)] text-[var(--text-secondary)]")}>{icon}</div>
      <p className="text-[11px] uppercase tracking-wider text-[var(--text-secondary)] font-medium">{label}</p>
      <p className={cx("text-[20px] font-bold tabular-nums mt-1 leading-tight", amber && "text-amber-700")}>{value}</p>
    </div>
  );
}

function Segmented<T extends string>({ label, options, value, onChange }: { label?: string; options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      {label && <span className="text-[12px] text-[var(--text-secondary)]">{label}:</span>}
      <div className="flex rounded-lg border border-[var(--aws-border)] overflow-hidden text-[12px]">
        {options.map((o) => (
          <button key={o.value} onClick={() => onChange(o.value)}
            className={cx("px-2.5 py-1.5 whitespace-nowrap", value === o.value ? "bg-[var(--aws-navy)] text-white" : "bg-white hover:bg-[var(--background)]")}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ChipRow({ label, opts, sel, onToggle, activeCls, approvedCls, render }: {
  label: string;
  opts: { name: string; count: number }[];
  sel: Set<string>;
  onToggle: (v: string) => void;
  activeCls: string;
  approvedCls?: string;
  render?: (v: string) => string;
}) {
  if (opts.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-[var(--aws-border)]">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-secondary)] w-[60px] flex-shrink-0">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {opts.map((o) => {
          const active = sel.has(o.name);
          const on = active ? (approvedCls && o.name === "Approved" ? approvedCls : activeCls) : "bg-white border-[var(--aws-border)] hover:bg-[var(--background)]";
          return (
            <button key={o.name} onClick={() => onToggle(o.name)} className={cx("text-[13px] font-medium px-3 py-1.5 rounded-md border", on)}>
              {render ? render(o.name) : o.name} <span className="text-[11px] opacity-70">({o.count})</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CustomerHistoryModal({ customerName, allRecords, detailHref, onClose }: {
  customerName: string; allRecords: RTVRow[]; detailHref: (id: string) => string; onClose: () => void;
}) {
  const [tab, setTab] = useState<"rtvs" | "variants" | "items">("rtvs");
  const canonical = canonicalize(customerName, CUSTOMER_ALIASES);
  const matching = allRecords.filter((r) => canonicalize(r.customer, CUSTOMER_ALIASES) === canonical);
  const rtvIds = Array.from(new Set(matching.map((r) => r.rtv_id)));
  const variants = Array.from(new Set(matching.map((r) => r.customer).filter(Boolean)));
  const totalQty = matching.reduce((s, r) => s + r.qty, 0);
  const totalValue = matching.reduce((s, r) => s + r.value, 0);
  const dates = matching.map((r) => r.rtv_date).filter(Boolean).sort() as string[];

  const rtvMap = new Map<string, { rtv_id: string; rtv_date: string | null; factory: string; customer: string; status: string; qty: number; value: number }>();
  for (const r of matching) {
    const ex = rtvMap.get(r.rtv_id);
    if (ex) { ex.qty += r.qty; ex.value += r.value; }
    else rtvMap.set(r.rtv_id, { rtv_id: r.rtv_id, rtv_date: r.rtv_date, factory: r.factory_unit, customer: r.customer, status: r.status, qty: r.qty, value: r.value });
  }
  const rtvRows = Array.from(rtvMap.values()).sort((a, b) => (b.rtv_date || "").localeCompare(a.rtv_date || ""));
  const variantRows = variants.map((v) => {
    const vr = matching.filter((r) => r.customer === v);
    return { name: v, rtv_count: new Set(vr.map((r) => r.rtv_id)).size, qty: vr.reduce((s, r) => s + r.qty, 0), value: vr.reduce((s, r) => s + r.value, 0) };
  }).sort((a, b) => b.value - a.value);
  const itemMap = new Map<string, { qty: number; value: number; ids: Set<string> }>();
  for (const r of matching) {
    if (!r.item_description) continue;
    if (!itemMap.has(r.item_description)) itemMap.set(r.item_description, { qty: 0, value: 0, ids: new Set() });
    const ex = itemMap.get(r.item_description)!;
    ex.qty += r.qty; ex.value += r.value; ex.ids.add(r.rtv_id);
  }
  const itemRows = Array.from(itemMap.entries()).map(([name, s]) => ({ name, qty: s.qty, value: s.value, rtv_count: s.ids.size })).sort((a, b) => b.value - a.value);

  const TABS: { k: typeof tab; label: string; n: number }[] = [
    { k: "rtvs", label: "CRs", n: rtvIds.length },
    ...(variants.length > 1 ? [{ k: "variants" as const, label: "Variants", n: variants.length }] : []),
    { k: "items", label: "Top Items", n: itemRows.length },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" className="bg-white rounded-lg max-w-3xl w-full max-h-[85vh] overflow-y-auto p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-[15px] font-semibold text-[var(--text-primary)] flex items-center gap-2">
              {canonical}
              {variants.length > 1 && <span className="text-[11px] px-2 py-0.5 rounded bg-violet-100 text-violet-700 font-medium">{variants.length} variants</span>}
            </h2>
            <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">
              {rtvIds.length} CRs · {fmtN(totalQty)} Qty · {fmtV(totalValue)}
              {dates.length > 0 && <> · {shortDate(dates[0])} to {shortDate(dates[dates.length - 1])}</>}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--background)] text-[var(--text-secondary)]"><IX className="h-4 w-4" /></button>
        </div>

        <div className="flex gap-1 mt-3 border-b border-[var(--aws-border)]">
          {TABS.map((t) => (
            <button key={t.k} onClick={() => setTab(t.k)} className={cx("text-[13px] px-3 py-1.5 -mb-px border-b-2", tab === t.k ? "border-[var(--aws-navy)] text-[var(--text-primary)] font-medium" : "border-transparent text-[var(--text-secondary)]")}>
              {t.label} ({t.n})
            </button>
          ))}
        </div>

        <div className="mt-3 overflow-x-auto">
          {tab === "rtvs" && (
            <table className="w-full text-[12px]">
              <thead><tr className="border-b border-[var(--aws-border)] bg-[var(--background)] text-left text-[var(--text-secondary)]">
                <th className="px-2 py-1.5">CR ID</th><th className="px-2 py-1.5">Date</th><th className="px-2 py-1.5">Factory</th><th className="px-2 py-1.5">Customer</th><th className="px-2 py-1.5">Status</th><th className="px-2 py-1.5 text-right">Qty</th><th className="px-2 py-1.5 text-right">Value</th>
              </tr></thead>
              <tbody>{rtvRows.map((r) => (
                <tr key={r.rtv_id} className="border-b border-[var(--aws-border)] last:border-0">
                  <td className="px-2 py-1.5"><Link href={detailHref(r.rtv_id)} onClick={onClose} className="font-medium text-[var(--aws-link)] hover:underline">{r.rtv_id}</Link></td>
                  <td className="px-2 py-1.5">{shortDate(r.rtv_date)}</td>
                  <td className="px-2 py-1.5">{getDisplayWarehouseName(r.factory)}</td>
                  <td className="px-2 py-1.5 truncate max-w-[160px]">{r.customer}</td>
                  <td className="px-2 py-1.5"><StatusBadge status={r.status as CRStatus} icon={false} /></td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{fmtN(r.qty)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-medium">{fmtV(r.value)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
          {tab === "variants" && (
            <table className="w-full text-[12px]">
              <thead><tr className="border-b border-[var(--aws-border)] bg-[var(--background)] text-left text-[var(--text-secondary)]">
                <th className="px-2 py-1.5">Variant</th><th className="px-2 py-1.5 text-right">CRs</th><th className="px-2 py-1.5 text-right">Qty</th><th className="px-2 py-1.5 text-right">Value</th>
              </tr></thead>
              <tbody>{variantRows.map((v) => (
                <tr key={v.name} className="border-b border-[var(--aws-border)] last:border-0">
                  <td className="px-2 py-1.5 font-medium">{v.name}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{v.rtv_count}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{fmtN(v.qty)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-medium">{fmtV(v.value)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
          {tab === "items" && (
            <table className="w-full text-[12px]">
              <thead><tr className="border-b border-[var(--aws-border)] bg-[var(--background)] text-left text-[var(--text-secondary)]">
                <th className="px-2 py-1.5">Item</th><th className="px-2 py-1.5 text-right">CRs</th><th className="px-2 py-1.5 text-right">Qty</th><th className="px-2 py-1.5 text-right">Value</th>
              </tr></thead>
              <tbody>{itemRows.map((it) => (
                <tr key={it.name} className="border-b border-[var(--aws-border)] last:border-0">
                  <td className="px-2 py-1.5">{it.name}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{it.rtv_count}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{fmtN(it.qty)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-medium">{fmtV(it.value)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
