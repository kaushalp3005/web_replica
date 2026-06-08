"use client";

// SO Creation main page. Mirrors
// frontend_replica/src/modules/production/so-creation/index.html +
// so-creation.js + the shared so-view.js library. Three top-level flows:
//
//   1. Method picker (Upload / Manual / Update via Excel)
//   2. File upload (xlsx/xls, max 50 MB) — auto-syncs fulfillment after
//   3. SO listing with search + status chips + date range + sort + paginate

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { useSeesCost } from "@/lib/cost-gate";
import { friendlyApiError } from "@/lib/apiErrors";
import {
  type GstStatus,
  type GstRecon,
  type SoFilterOptions,
  type SoListQuery,
  type SoListResponse,
  type SoRow,
  type SoLine,
  type SoLineEntry,
  fetchSoExport,
  listSos,
  syncFulfillment,
  uploadSoBook,
} from "@/lib/so";
import {
  loadSoListCache,
  saveSoListCache,
  type SoListCache,
} from "@/lib/so-list-cache";
import { BackLink } from "@/components/BackLink";
import { SoChrome } from "./_chrome";

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

type StatusChip = "all" | "ok" | "mismatch" | "warning" | "unmatched";
type SortBy = "so_number" | "so_date" | "gst_status" | "customer_name" | "company";
type SortOrder = "asc" | "desc";

// ── helpers ──────────────────────────────────────────────────────────────

function fmtDate(d?: string | null): string {
  if (!d) return "—";
  try { return new Date(d).toLocaleDateString(); } catch { return d; }
}

function fmtNum(v: number | string | null | undefined, digits = 2): string {
  if (v == null || v === "") return "—";
  const n = typeof v === "number" ? v : parseFloat(v);
  if (Number.isNaN(n)) return "—";
  return n.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// Normalise to a flat [{ line, gst_recon }] array regardless of which wire
// shape the backend sent — list endpoint wraps lines as
// SoLineEntry[] = [{ line, gst_recon }], detail endpoint sends a flat
// SoLine[]. Returning a uniform shape lets the renderer stay simple.
type NormalisedLineEntry = { line: SoLine; gst_recon?: SoLineEntry["gst_recon"] };
function normaliseLines(raw: SoRow["lines"]): NormalisedLineEntry[] {
  if (!raw || raw.length === 0) return [];
  // Detect: if the first element has a `line` key, it's the wrapper shape.
  const first = raw[0] as unknown;
  if (first && typeof first === "object" && "line" in (first as Record<string, unknown>)) {
    return (raw as SoLineEntry[]).map((e) => ({ line: e.line, gst_recon: e.gst_recon ?? undefined }));
  }
  return (raw as SoLine[]).map((l) => ({ line: l, gst_recon: undefined }));
}

// Advanced filter spec — mirrors so-view.js.advFields exactly. The
// `optionKey` is what /view returns inside `filter_options`; the wire
// `key` is what the listing query accepts. Backend ORs the comma-
// separated values within a key and ANDs across keys.
const ADV_FIELDS: { key: keyof SoListQuery; label: string; optionKey: keyof SoFilterOptions }[] = [
  { key: "company",              label: "Company",        optionKey: "companies" },
  { key: "customer_name",        label: "Customer",       optionKey: "customer_names" },
  { key: "common_customer_name", label: "Common Name",    optionKey: "common_customer_names" },
  { key: "voucher_type",         label: "Voucher Type",   optionKey: "voucher_types" },
  { key: "item_category",        label: "Item Category",  optionKey: "item_categories" },
  { key: "sub_category",         label: "Sub Category",   optionKey: "sub_categories" },
  { key: "uom",                  label: "UOM",            optionKey: "uoms" },
  { key: "grp_code",             label: "GRP Code",       optionKey: "grp_codes" },
  { key: "rate_type",            label: "Rate Type",      optionKey: "rate_types" },
  { key: "item_type",            label: "Item Type",      optionKey: "item_types" },
  { key: "sales_group",          label: "Sales Group",    optionKey: "sales_groups" },
  { key: "match_source",         label: "Match Source",   optionKey: "match_sources" },
  { key: "line_status",          label: "Line Status",    optionKey: "statuses" },
];

function serialiseAdvFilters(filters: Record<string, Set<string>>): Partial<SoListQuery> {
  const out: Record<string, string> = {};
  for (const [k, set] of Object.entries(filters)) {
    if (set.size === 0) continue;
    out[k] = [...set].join(",");
  }
  return out as Partial<SoListQuery>;
}

function advFilterKey(filters: Record<string, Set<string>>): string {
  // Stable hash used as a single useEffect dep so the fetch re-runs on any
  // chip toggle. Sorted to be order-independent.
  const parts: string[] = [];
  for (const k of Object.keys(filters).sort()) {
    parts.push(`${k}=${[...filters[k]].sort().join("|")}`);
  }
  return parts.join("&");
}

function countAdvFilters(filters: Record<string, Set<string>>): number {
  let n = 0;
  for (const s of Object.values(filters)) n += s.size;
  return n;
}

// Export column spec — mirrors so-view.js._exportColumns (28 columns).
// `get` reads from the SO header and the line+gst envelope.
//
// `gated: true` marks cost-bearing columns (C12) — dropped from the CSV
// when the operator's role can't see ₹. The `*_amount` and `rate_inr`
// fields appear in the backend `COST_BEARING_FIELDS` set, so omitting
// them client-side matches what the API would have stripped anyway and
// keeps the exported CSV honest for deny-list roles.
type ExportCol = {
  key: string;
  label: string;
  gated?: boolean;
  get: (so: SoRow, line?: SoLine, gst?: GstRecon | null) => string | number | null | undefined;
};
const EXPORT_COLUMNS: ExportCol[] = [
  { key: "so_number",            label: "SO Number",         get: (so) => so.so_number },
  { key: "so_date",              label: "Date",              get: (so) => so.so_date },
  { key: "customer_name",        label: "Customer",          get: (so) => so.customer_name },
  { key: "common_customer_name", label: "Common Name",       get: (so) => so.common_customer_name },
  { key: "company",              label: "Company",           get: (so) => so.company },
  { key: "voucher_type",         label: "Voucher Type",      get: (so) => so.voucher_type },
  { key: "sku_name",             label: "SKU Name",          get: (_so, l) => l?.sku_name },
  { key: "item_category",        label: "Category",          get: (_so, l) => l?.item_category },
  { key: "sub_category",         label: "Sub Category",      get: (_so, l) => l?.sub_category },
  { key: "uom",                  label: "UOM",               get: (_so, l) => l?.uom },
  { key: "quantity",             label: "Pack Count",        get: (_so, l) => l?.quantity },
  { key: "rate_inr",             label: "Rate",              gated: true, get: (_so, l) => l?.rate_inr },
  { key: "amount_inr",           label: "Amount",            gated: true, get: (_so, l) => l?.amount_inr },
  { key: "igst_amount",          label: "IGST",              gated: true, get: (_so, l) => l?.igst_amount },
  { key: "sgst_amount",          label: "SGST",              gated: true, get: (_so, l) => l?.sgst_amount },
  { key: "cgst_amount",          label: "CGST",              gated: true, get: (_so, l) => l?.cgst_amount },
  { key: "total_amount_inr",     label: "Total",             gated: true, get: (_so, l) => l?.total_amount_inr },
  { key: "apmc_amount",          label: "APMC",              gated: true, get: (_so, l) => l?.apmc_amount },
  { key: "packing_amount",       label: "Packing",           gated: true, get: (_so, l) => l?.packing_amount },
  { key: "freight_amount",       label: "Freight",           gated: true, get: (_so, l) => l?.freight_amount },
  { key: "processing_amount",    label: "Processing",        gated: true, get: (_so, l) => l?.processing_amount },
  { key: "item_type",            label: "Item Type",         get: (_so, l) => l?.item_type },
  { key: "item_description",     label: "Item Description",  get: (_so, l) => l?.item_description },
  { key: "sales_group",          label: "Sales Group",       get: (_so, l) => l?.sales_group },
  { key: "grp_code",             label: "GRP Code",          get: (_so, l) => l?.grp_code },
  { key: "rate_type",            label: "Rate Type",         get: (_so, l) => l?.rate_type },
  { key: "line_status",          label: "Line Status",       get: (_so, l) => l?.status },
  { key: "gst_status",           label: "GST Status",        get: (_so, _l, g) => g?.status },
];

function csvCell(v: unknown): string {
  if (v == null) return "";
  let s = String(v);
  // RFC 4180 quoting — wrap in quotes if there's a comma / quote / newline.
  if (/[",\r\n]/.test(s)) {
    s = `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildExportCsv(sos: SoRow[], seesCost: boolean): string {
  // Filter gated columns out for deny-list roles (C12) — the resulting
  // CSV has no rate / amount / tax columns at all, matching what the
  // backend would have stripped if the export path were proxied
  // through `strip_cost_fields`.
  const cols = EXPORT_COLUMNS.filter((c) => !c.gated || seesCost);
  const rows: string[] = [];
  rows.push(cols.map((c) => csvCell(c.label)).join(","));
  for (const so of sos) {
    const entries = normaliseLines(so.lines);
    if (entries.length === 0) {
      // SOs with no lines still get a header-only row so they're not lost.
      rows.push(cols.map((c) => csvCell(c.get(so))).join(","));
      continue;
    }
    for (const { line, gst_recon } of entries) {
      rows.push(cols.map((c) => csvCell(c.get(so, line, gst_recon ?? null))).join(","));
    }
  }
  // Leading BOM so Excel detects UTF-8 instead of mojibake'ing currency
  // symbols and accented characters.
  return "﻿" + rows.join("\r\n");
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const STATUS_PALETTE: Record<string, { fg: string; bg: string; ring: string }> = {
  ok:        { fg: "var(--text-success)", bg: "#eaf6ed", ring: "#b6dbb1" },
  mismatch:  { fg: "#b1361e",             bg: "#fdf3f1", ring: "#f0c7be" },
  warning:   { fg: "#9a393e",             bg: "#fbeced", ring: "#e6bcbe" },
  unmatched: { fg: "var(--text-muted)",   bg: "var(--surface-disabled)", ring: "var(--aws-border)" },
};

// ── Page ─────────────────────────────────────────────────────────────────

export default function SoCreationPage() {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);
  // C12 cost-metric UI gate. Threaded into the export, the per-line
  // card, and the per-line section components below. Deny-list roles
  // (team_leader, qc_inspector, floor_manager, viewer) get no ₹ chrome
  // anywhere on this page.
  const { seesCost } = useSeesCost();

  // Method picker visibility — once the operator commits to upload, hide it.
  const [showMethods, setShowMethods] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);

  // ── Cache hydration ────────────────────────────────────────────────────
  //
  // Lazy init runs ONCE on mount — calling loadSoListCache() in every
  // useState() factory below is safe because each factory only runs once.
  // We resolve once and pass the same snapshot to each useState so they
  // all agree on the source of truth.
  //
  // Same anti-loop reasoning as jc-list-cache (see app/modules/job-card/
  // page.tsx:137): no per-render loads, no fresh object references that
  // would invalidate effect deps and cause request storms.
  const [cache] = useState<SoListCache | null>(() =>
    typeof window !== "undefined" ? loadSoListCache() : null,
  );

  // Hydration guard. The cache above is sessionStorage-only, so seeding render
  // state from it diverges between the server (cache-less) and the client's
  // first render → hydration mismatch. Render a cache-free shell until mounted,
  // then reveal the hydrated UI (deferred setState avoids the
  // react-hooks/set-state-in-effect lint).
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    queueMicrotask(() => setMounted(true));
  }, []);

  // Filters / sort / pagination ──────────────────────────────────────────
  const [search, setSearch] = useState(cache?.search ?? "");
  // debouncedSearch hydrates from the same key — after a settled debounce
  // these always agree, so on rehydration we want the fetch to fire with
  // the cached query immediately, not wait 300ms after mount.
  const [debouncedSearch, setDebouncedSearch] = useState(cache?.search ?? "");
  const [status, setStatus] = useState<StatusChip>(cache?.status ?? "all");
  const [dateFrom, setDateFrom] = useState<string>(cache?.dateFrom ?? "");
  const [dateTo, setDateTo] = useState<string>(cache?.dateTo ?? "");
  // Advanced multi-select filters. Each key maps to a Set of allowed values
  // joined with commas before going on the wire — backend AND-s across keys
  // and OR-s within a single key, matching so-view.js `syncAdvFiltersToQuery`.
  // Cache stores arrays; rehydrate as Sets here.
  const [advFilters, setAdvFilters] = useState<Record<string, Set<string>>>(() => {
    if (!cache?.advFilters) return {};
    const out: Record<string, Set<string>> = {};
    for (const [k, arr] of Object.entries(cache.advFilters)) {
      out[k] = new Set(arr);
    }
    return out;
  });
  const [sortBy, setSortBy] = useState<SortBy>(cache?.sortBy ?? "so_date");
  const [sortOrder, setSortOrder] = useState<SortOrder>(cache?.sortOrder ?? "asc");
  const [page, setPage] = useState(cache?.page ?? 1);

  const [data, setData] = useState<SoListResponse | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  // Upload state ─────────────────────────────────────────────────────────
  const [uploading, setUploading] = useState(false);
  const [uploadFileName, setUploadFileName] = useState("");
  const [uploadMsg, setUploadMsg] = useState<{ kind: "ok" | "warn" | "err"; text: string } | null>(null);

  // Expanded SOs (inline detail rows) ────────────────────────────────────
  const [expanded, setExpanded] = useState<Set<number>>(() =>
    new Set(cache?.expanded ?? []),
  );

  // Debounce search ──────────────────────────────────────────────────────
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  // Stable fingerprint of the advanced-filter state — the fetch effect
  // depends on this scalar instead of the Set map so the deps array stays
  // statically analysable for react-hooks/exhaustive-deps.
  const advKey = advFilterKey(advFilters);

  // Fingerprint of the expanded-rows Set for the cache-save effect dep
  // array. Sorted so equal-membership sets fingerprint identically.
  const expandedKey = useMemo(
    () => [...expanded].sort((a, b) => a - b).join(","),
    [expanded],
  );

  // Persist the listing state on any change. Snapshot pattern (write the
  // whole shape every time) rather than incremental writes — sessionStorage
  // is local and the payload is small. advFilters Sets are dehydrated to
  // arrays for JSON; the lazy init above rehydrates them on next mount.
  useEffect(() => {
    const advArrays: Record<string, string[]> = {};
    for (const [k, set] of Object.entries(advFilters)) advArrays[k] = [...set];
    saveSoListCache({
      search,
      status,
      dateFrom,
      dateTo,
      advFilters: advArrays,
      sortBy,
      sortOrder,
      page,
      expanded: [...expanded],
    });
    // advKey + expandedKey are the stable fingerprints of advFilters /
    // expanded — they re-fire the effect when membership changes without
    // wiring the Set objects into the dep array (which would trip the
    // exhaustive-deps rule).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, status, dateFrom, dateTo, advKey, sortBy, sortOrder, page, expandedKey]);

  // Fetch effect ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!authed) return;
    const controller = new AbortController();
    void (async () => {
      setListLoading(true);
      setListError(null);
      try {
        const resp = await listSos(
          {
            page,
            page_size: PAGE_SIZE,
            search: debouncedSearch || undefined,
            status: status === "all" ? undefined : (status as GstStatus),
            sort_by: sortBy,
            sort_order: sortOrder,
            date_from: dateFrom || undefined,
            date_to: dateTo || undefined,
            ...serialiseAdvFilters(advFilters),
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setData(resp);
      } catch (e) {
        if (controller.signal.aborted) return;
        setListError(friendlyApiError(e));
        setData(null);
      } finally {
        if (!controller.signal.aborted) setListLoading(false);
      }
    })();
    return () => controller.abort();
    // advKey is the stable string fingerprint of advFilters declared above
    // so the effect re-runs whenever the operator toggles a chip without
    // wiring the Set map itself into the dep array (which would trip the
    // exhaustive-deps rule).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, page, debouncedSearch, status, sortBy, sortOrder, dateFrom, dateTo, advKey]);

  // Status chip change resets page. Same as filter changes in the listing.
  function changeStatus(s: StatusChip) {
    setStatus(s);
    setPage(1);
  }

  // Sort toggle: 3-way for so_date, 2-way for everything else.
  function changeSort(col: SortBy) {
    if (col === "so_date") {
      // asc → desc → gst_status asc → back to asc
      if (sortBy === "so_date" && sortOrder === "asc") { setSortOrder("desc"); return; }
      if (sortBy === "so_date" && sortOrder === "desc") { setSortBy("gst_status"); setSortOrder("asc"); return; }
      setSortBy("so_date"); setSortOrder("asc"); return;
    }
    if (sortBy === col) { setSortOrder(sortOrder === "asc" ? "desc" : "asc"); return; }
    setSortBy(col); setSortOrder("asc");
  }

  // File upload ──────────────────────────────────────────────────────────
  async function onFileChosen(file: File) {
    if (!/\.xlsx?$/i.test(file.name)) {
      setUploadMsg({ kind: "err", text: "Only .xlsx / .xls files are accepted." });
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setUploadMsg({ kind: "err", text: "File too large — maximum 50 MB." });
      return;
    }
    setUploading(true);
    setUploadFileName(file.name);
    setUploadMsg(null);
    try {
      const r = await uploadSoBook(file);
      const total = r.summary?.total_sos ?? 0;
      setUploadMsg({ kind: "ok", text: `Processed ${total} Sales Order${total === 1 ? "" : "s"}.` });
      // Auto-sync fulfillment. Non-fatal on failure.
      try {
        const sd = await syncFulfillment();
        const synced = sd.synced ?? sd.summary?.synced ?? 0;
        if (synced > 0) {
          setUploadMsg({ kind: "ok", text: `Processed ${total} SO${total === 1 ? "" : "s"} · synced ${synced} fulfillment line${synced === 1 ? "" : "s"}.` });
        }
      } catch {
        setUploadMsg({ kind: "warn", text: `Upload OK — fulfillment sync failed. Open Fulfillment and click Sync.` });
      }
      // Refresh listing.
      setPage(1);
      // Force the fetch effect to re-run via a key bump using a setter
      // that's already a dep — bumping `dateFrom` to itself is a no-op so
      // we re-trigger by resetting status to all (operator likely wants
      // to see new rows anyway).
      setStatus("all");
    } catch (e) {
      setUploadMsg({ kind: "err", text: friendlyApiError(e) });
    } finally {
      setUploading(false);
    }
  }

  function toggleExpanded(soId: number) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(soId)) next.delete(soId); else next.add(soId);
      return next;
    });
  }
  function expandAll() {
    const all = (data?.sales_orders ?? []).map((r) => r.so_id).filter((id): id is number => id != null);
    setExpanded(new Set(all));
  }
  function collapseAll() { setExpanded(new Set()); }

  async function onExport(only?: "mismatch" | "warning") {
    try {
      const resp = await fetchSoExport({
        search: debouncedSearch || undefined,
        status: only ?? (status === "all" ? undefined : (status as GstStatus)),
        sort_by: sortBy,
        sort_order: sortOrder,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
        ...serialiseAdvFilters(advFilters),
      });
      const sos = resp.sales_orders ?? [];
      if (sos.length === 0) {
        setUploadMsg({ kind: "warn", text: "No Sales Orders match the current filters." });
        return;
      }
      const csv = buildExportCsv(sos, seesCost);
      const suffix = only ? `-${only === "mismatch" ? "mismatches" : "warnings"}` : "";
      downloadBlob(
        new Blob([csv], { type: "text/csv;charset=utf-8;" }),
        `sales-orders${suffix}-${new Date().toISOString().slice(0, 10)}.csv`,
      );
      setUploadMsg({ kind: "ok", text: `Exported ${sos.length} Sales Order${sos.length === 1 ? "" : "s"}.` });
    } catch (e) {
      setUploadMsg({ kind: "err", text: `Export failed: ${friendlyApiError(e)}` });
    }
  }

  if (!mounted) {
    return (
      <SoChrome title="SO Creation">
        <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[var(--text-secondary)]">
          <span className="inline-flex items-center gap-2 text-[13px]">
            <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
            Loading sales orders…
          </span>
        </div>
      </SoChrome>
    );
  }

  return (
    <SoChrome title="SO Creation">
      <div className="mb-3">
        <BackLink parentHref="/modules/production" label="production" />
      </div>
      <div className="mb-5">
        <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">SO Creation</h1>
        <p className="text-[13px] text-[var(--text-secondary)] mt-1">
          Create Sales Orders manually or upload a Sales Register file.
        </p>
      </div>

      {showMethods ? (
        <MethodPicker
          onUpload={() => { setShowMethods(false); setUploadOpen(true); }}
          onManual={() => router.push("/modules/production/so-creation/manual")}
        />
      ) : null}

      {uploadOpen ? (
        <UploadZone
          uploading={uploading}
          fileName={uploadFileName}
          message={uploadMsg}
          onChosen={onFileChosen}
          onCancel={() => {
            // Close the drop zone, restore the method picker, and wipe any
            // stale feedback so the next entry starts clean. Disabled while
            // an upload is in-flight (button is hidden in that case).
            setUploadOpen(false);
            setShowMethods(true);
            setUploadMsg(null);
            setUploadFileName("");
          }}
        />
      ) : null}

      <Toolbar
        search={search}
        onSearch={setSearch}
        status={status}
        onStatus={changeStatus}
        summary={data?.summary}
        dateFrom={dateFrom}
        dateTo={dateTo}
        onDateChange={(from, to) => { setDateFrom(from); setDateTo(to); setPage(1); }}
        advFilters={advFilters}
        onAdvToggle={(field, value) => {
          setAdvFilters((m) => {
            const next: Record<string, Set<string>> = { ...m };
            const set = new Set(next[field] ?? []);
            if (set.has(value)) set.delete(value); else set.add(value);
            if (set.size === 0) delete next[field];
            else next[field] = set;
            return next;
          });
          setPage(1);
        }}
        onAdvClear={() => { setAdvFilters({}); setPage(1); }}
        onClearAllFilters={() => {
          setSearch("");
          setStatus("all");
          setDateFrom("");
          setDateTo("");
          setAdvFilters({});
          setPage(1);
        }}
        filterOptions={data?.filter_options}
        onExport={onExport}
        onRefresh={() => { setExpanded(new Set()); setPage(1); }}
      />

      {(data?.sales_orders?.length ?? 0) > 0 ? (
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[11px] text-[var(--text-muted)]">
            {expanded.size > 0
              ? `${expanded.size} expanded`
              : `${data?.sales_orders?.length ?? 0} SOs on this page`}
          </span>
          <button
            type="button"
            onClick={expanded.size > 0 ? collapseAll : expandAll}
            className="h-7 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]"
          >
            {expanded.size > 0 ? "Collapse all" : "Expand all"}
          </button>
        </div>
      ) : null}

      <SoTable
        rows={data?.sales_orders ?? []}
        loading={listLoading}
        error={listError}
        sortBy={sortBy}
        sortOrder={sortOrder}
        onSort={changeSort}
        expanded={expanded}
        onToggle={toggleExpanded}
        seesCost={seesCost}
        onEditHeader={(soId) => router.push(`/modules/production/so-creation/manual-update/${soId}?section=header`)}
        onEditLines={(soId) => router.push(`/modules/production/so-creation/manual-update/${soId}?section=lines`)}
      />

      <Pagination
        page={data?.page ?? page}
        totalPages={data?.total_pages ?? 1}
        total={data?.total ?? 0}
        pageSize={data?.page_size ?? PAGE_SIZE}
        onPage={(p) => setPage(p)}
        loading={listLoading}
      />
    </SoChrome>
  );
}

// ── Method picker ────────────────────────────────────────────────────────

function MethodPicker({
  onUpload, onManual,
}: { onUpload: () => void; onManual: () => void }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
      <MethodCard
        title="Upload Excel"
        desc="Upload a Sales Register .xlsx file to bulk-process Sales Orders and run GST reconciliation."
        onClick={onUpload}
      />
      <MethodCard
        title="Create Manually"
        desc="Enter SO header details and line items step by step with a guided form."
        onClick={onManual}
      />
    </div>
  );
}

function MethodCard({ title, desc, onClick }: { title: string; desc: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-4 hover:border-[var(--aws-navy)] hover:shadow-[0_2px_6px_rgba(0,28,36,0.18)] transition focus:outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_2px_#9a393e]"
    >
      <div className="text-[14px] font-semibold text-[var(--text-primary)] mb-1">{title}</div>
      <p className="text-[12px] text-[var(--text-secondary)]">{desc}</p>
    </button>
  );
}

// ── Upload zone ──────────────────────────────────────────────────────────

function UploadZone({
  uploading, fileName, message, onChosen, onCancel,
}: {
  uploading: boolean;
  fileName: string;
  message: { kind: "ok" | "warn" | "err"; text: string } | null;
  onChosen: (file: File) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  return (
    <div className="mb-5">
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault(); setDrag(false);
          const f = e.dataTransfer.files?.[0];
          if (f) onChosen(f);
        }}
        className={[
          "relative bg-white border-2 border-dashed rounded-md p-6 text-center cursor-pointer transition",
          drag ? "border-[var(--aws-orange)] bg-[#fbeced]" : "border-[var(--aws-border-strong)] hover:border-[var(--aws-navy)]",
        ].join(" ")}
      >
        {/* Close affordance — hidden while an upload is in-flight (cancelling
            mid-POST would leave the backend half-processed). stopPropagation
            prevents the click from also opening the file-picker. */}
        {!uploading ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onCancel(); }}
            aria-label="Cancel upload"
            title="Cancel"
            className="absolute top-2 right-2 w-7 h-7 flex items-center justify-center rounded-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-divider)] focus:outline-none focus:ring-2 focus:ring-[#9a393e]"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        ) : null}
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onChosen(f);
            e.target.value = "";
          }}
        />
        <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" className="mx-auto text-[var(--text-muted)] mb-2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        <p className="text-[14px] font-semibold text-[var(--text-primary)]">Drop your Sales Register here</p>
        <p className="text-[12px] text-[var(--text-secondary)] mt-1">
          or click to browse — <strong>.xlsx / .xls</strong>, max 50 MB
        </p>
      </div>
      {uploading ? (
        <div className="mt-2 text-[12px] text-[var(--text-secondary)] flex items-center gap-2">
          <span className="inline-block w-3 h-3 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
          Processing {fileName} …
        </div>
      ) : null}
      {message ? (
        <p
          className={[
            "mt-2 text-[12px]",
            message.kind === "ok"   ? "text-[var(--text-success)]" :
            message.kind === "warn" ? "text-[#9a393e]" :
                                       "text-[var(--aws-error)]",
          ].join(" ")}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}

// ── Toolbar ──────────────────────────────────────────────────────────────

function Toolbar({
  search, onSearch, status, onStatus, summary,
  dateFrom, dateTo, onDateChange,
  advFilters, onAdvToggle, onAdvClear,
  onClearAllFilters,
  filterOptions,
  onExport, onRefresh,
}: {
  search: string;
  onSearch: (v: string) => void;
  status: StatusChip;
  onStatus: (s: StatusChip) => void;
  summary?: import("@/lib/so").SoSummary;
  dateFrom: string;
  dateTo: string;
  onDateChange: (from: string, to: string) => void;
  advFilters: Record<string, Set<string>>;
  onAdvToggle: (field: string, value: string) => void;
  onAdvClear: () => void;
  onClearAllFilters: () => void;
  filterOptions?: SoFilterOptions;
  onExport: (only?: "mismatch" | "warning") => void;
  onRefresh: () => void;
}) {
  const [dateOpen, setDateOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);

  const advCount = countAdvFilters(advFilters);
  const dateActive = !!dateFrom || !!dateTo;
  const statusActive = status !== "all";
  const searchActive = search.trim().length > 0;
  const hasAnyFilter = advCount > 0 || dateActive || statusActive || searchActive;

  const chips: { value: StatusChip; label: string; count?: number; tone?: string }[] = [
    { value: "all",       label: "All" },
    { value: "ok",        label: "OK",        count: summary?.so_ok,        tone: "var(--text-success)" },
    { value: "mismatch",  label: "Mismatch",  count: summary?.so_mismatch,  tone: "#b1361e" },
    { value: "warning",   label: "Warning",   count: summary?.so_warning,   tone: "#9a393e" },
    { value: "unmatched", label: "Unmatched", count: summary?.so_unmatched, tone: "var(--text-muted)" },
  ];

  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] mb-4 p-3 flex flex-wrap items-center gap-2">
      <div className="relative flex-1 min-w-[220px]">
        <svg viewBox="0 0 24 24" className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search SO number, customer…"
          className="w-full h-8 pl-7 pr-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
        />
      </div>
      {chips.map((c) => (
        <button
          key={c.value}
          type="button"
          onClick={() => onStatus(c.value)}
          className={[
            "h-8 px-3 text-[12px] rounded-full border transition-colors flex items-center gap-1.5",
            status === c.value
              ? "bg-[var(--aws-navy)] text-white border-[var(--aws-navy)]"
              : "bg-white text-[var(--text-primary)] border-[var(--aws-border-strong)] hover:border-[var(--aws-navy)]",
          ].join(" ")}
          title={c.label}
        >
          {c.count != null ? (
            <span
              className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] rounded-full font-bold"
              style={{
                background: status === c.value ? "rgba(255,255,255,0.18)" : "var(--surface-disabled)",
                color: status === c.value ? "white" : (c.tone ?? "var(--text-secondary)"),
              }}
            >
              {c.count}
            </span>
          ) : null}
          {c.label}
        </button>
      ))}

      {/* Clear-filters pill — only when something is active. Mirrors the
          original "✕ Clear filters" affordance from index.html. */}
      {hasAnyFilter ? (
        <button
          type="button"
          onClick={onClearAllFilters}
          className="h-8 px-3 text-[12px] rounded-full border border-[var(--aws-error)] text-[var(--aws-error)] bg-[#fdf3f1] hover:bg-[#f8dde1] flex items-center gap-1.5"
          title={`${advCount + (dateActive ? 1 : 0) + (statusActive ? 1 : 0) + (searchActive ? 1 : 0)} active filter${advCount + (dateActive ? 1 : 0) + (statusActive ? 1 : 0) + (searchActive ? 1 : 0) === 1 ? "" : "s"}`}
        >
          <span>✕</span> Clear filters
        </button>
      ) : null}

      {/* Advanced filter */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setAdvOpen((v) => !v)}
          className={[
            "h-8 px-3 text-[12px] rounded-[2px] border flex items-center gap-1.5",
            advCount > 0
              ? "border-[var(--aws-orange)] text-[var(--aws-orange)] bg-[#fbeced]"
              : "border-[var(--aws-border-strong)] bg-white text-[var(--text-primary)] hover:border-[var(--aws-navy)]",
          ].join(" ")}
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
          </svg>
          Advanced
          {advCount > 0 ? (
            <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] rounded-full font-bold bg-[var(--aws-orange)] text-white">
              {advCount}
            </span>
          ) : null}
        </button>
        {advOpen ? (
          <AdvancedFilterPanel
            options={filterOptions}
            filters={advFilters}
            onToggle={onAdvToggle}
            onClear={onAdvClear}
            onClose={() => setAdvOpen(false)}
          />
        ) : null}
      </div>

      {/* Date filter */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setDateOpen((v) => !v)}
          className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] flex items-center gap-1.5"
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2}>
            <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
          </svg>
          {dateFrom || dateTo ? `${dateFrom || "…"} → ${dateTo || "…"}` : "Date"}
        </button>
        {dateOpen ? (
          <div className="absolute right-0 z-10 mt-1 bg-white border border-[var(--aws-border)] rounded-md shadow-[0_4px_12px_rgba(0,28,36,0.18)] p-3 w-[260px]">
            <label className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">From</label>
            <input type="date" value={dateFrom} onChange={(e) => onDateChange(e.target.value, dateTo)} className="w-full h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] mb-2" />
            <label className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">To</label>
            <input type="date" value={dateTo} onChange={(e) => onDateChange(dateFrom, e.target.value)} className="w-full h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] mb-3" />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => { onDateChange("", ""); setDateOpen(false); }} className="h-7 px-2 text-[12px] text-[var(--aws-link)] hover:underline">Clear</button>
              <button type="button" onClick={() => setDateOpen(false)} className="h-7 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]">Apply</button>
            </div>
          </div>
        ) : null}
      </div>

      {/* Export */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setExportOpen((v) => !v)}
          className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] flex items-center gap-1.5"
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Export
        </button>
        {exportOpen ? (
          <div className="absolute right-0 z-10 mt-1 bg-white border border-[var(--aws-border)] rounded-md shadow-[0_4px_12px_rgba(0,28,36,0.18)] p-1 w-[200px]">
            <button type="button" onClick={() => { setExportOpen(false); onExport(); }} className="w-full text-left px-2 py-1.5 text-[13px] hover:bg-[var(--surface-disabled)] rounded-sm">Export All</button>
            <button type="button" onClick={() => { setExportOpen(false); onExport("mismatch"); }} className="w-full text-left px-2 py-1.5 text-[13px] hover:bg-[var(--surface-disabled)] rounded-sm">Mismatches only</button>
            <button type="button" onClick={() => { setExportOpen(false); onExport("warning"); }} className="w-full text-left px-2 py-1.5 text-[13px] hover:bg-[var(--surface-disabled)] rounded-sm">Warnings only</button>
          </div>
        ) : null}
      </div>

      <button
        type="button"
        onClick={onRefresh}
        className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] flex items-center gap-1.5"
      >
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2}>
          <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
        Refresh
      </button>
    </div>
  );
}

// ── Advanced filter panel ────────────────────────────────────────────────
//
// Mirrors so-view.js.buildAdvPanel — 13 sections (one per field), each
// rendered as multi-select chips populated from /view's filter_options.
// A header search filters chips by label or value; the footer shows the
// active count and a Clear All button.

function AdvancedFilterPanel({
  options, filters, onToggle, onClear, onClose,
}: {
  options?: SoFilterOptions;
  filters: Record<string, Set<string>>;
  onToggle: (field: string, value: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  const lcQ = q.trim().toLowerCase();
  const count = countAdvFilters(filters);

  return (
    <div
      ref={ref}
      className="absolute right-0 z-20 mt-1 w-[min(360px,calc(100vw-1rem))] max-h-[60vh] overflow-y-auto bg-white border border-[var(--aws-border)] rounded-md shadow-[0_4px_12px_rgba(0,28,36,0.18)] p-3"
    >
      <div className="relative mb-3">
        <svg viewBox="0 0 24 24" className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          autoFocus
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search filters…"
          className="w-full h-8 pl-7 pr-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
        />
      </div>

      {ADV_FIELDS.map((f) => {
        const optsRaw = (options?.[f.optionKey] ?? []).filter(Boolean);
        if (optsRaw.length === 0) return null;
        const sorted = [...optsRaw].sort();
        const fieldMatch = !lcQ || f.label.toLowerCase().includes(lcQ);
        const filtered = sorted.filter((v) => fieldMatch || v.toLowerCase().includes(lcQ));
        if (filtered.length === 0) return null;
        const selected = filters[f.key as string] ?? new Set<string>();
        return (
          <div key={String(f.key)} className="mb-3 last:mb-0">
            <div className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)] mb-1.5">
              {f.label}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {filtered.map((v) => {
                const checked = selected.has(v);
                return (
                  <button
                    key={v}
                    type="button"
                    onClick={() => onToggle(String(f.key), v)}
                    title={v}
                    className={[
                      "h-6 px-2 text-[11px] rounded-full border transition-colors flex items-center gap-1 max-w-[200px] truncate",
                      checked
                        ? "bg-[var(--aws-orange)] border-[var(--aws-orange)] text-white"
                        : "bg-white border-[var(--aws-border)] text-[var(--text-primary)] hover:border-[var(--aws-navy)]",
                    ].join(" ")}
                  >
                    {checked ? <span aria-hidden>✓</span> : null}
                    <span className="truncate">{v}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      <div className="border-t border-[var(--aws-border)] pt-2 mt-2 flex items-center justify-between">
        <span className="text-[11px] text-[var(--text-muted)]">
          {count > 0 ? `${count} filter${count === 1 ? "" : "s"} active` : "No filters active"}
        </span>
        <button
          type="button"
          onClick={() => { onClear(); }}
          disabled={count === 0}
          className="h-7 px-2 text-[11px] text-[var(--aws-link)] hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Clear All
        </button>
      </div>
    </div>
  );
}

// ── Table ────────────────────────────────────────────────────────────────

function SoTable({
  rows, loading, error, sortBy, sortOrder, onSort,
  expanded, onToggle, seesCost, onEditHeader, onEditLines,
}: {
  rows: SoRow[];
  loading: boolean;
  error: string | null;
  sortBy: SortBy;
  sortOrder: SortOrder;
  onSort: (col: SortBy) => void;
  expanded: Set<number>;
  onToggle: (soId: number) => void;
  // C12 cost-metric flag — propagated down to the per-line cards so
  // ₹ values vanish for deny-list roles. Stored at the table level so
  // both the mobile-card branch and the desktop-table branch read the
  // same value.
  seesCost: boolean;
  onEditHeader: (soId: number) => void;
  onEditLines: (soId: number) => void;
}) {
  return (
    <>
      {/* ── Mobile (< md): stacked cards ─────────────────────────────
          The desktop table has eight whitespace-nowrap columns that won't
          shrink below ~640 px. On phones we drop the table entirely and
          render each SO as a vertical card with the same drill-in
          affordances. The expanded detail uses the same SoLineDetail
          renderer as desktop so per-line cards work identically. */}
      <div className="md:hidden space-y-2">
        {loading && rows.length === 0 ? (
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-8 text-center text-[var(--text-secondary)]">
            <span className="inline-flex items-center gap-2 text-[13px]">
              <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
              Loading Sales Orders…
            </span>
          </div>
        ) : error ? (
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-center text-[var(--aws-error)] text-[13px]">{error}</div>
        ) : rows.length === 0 ? (
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-8 text-center text-[var(--text-secondary)]">
            <p className="font-semibold text-[14px] mb-1">No Sales Orders</p>
            <p className="text-[12px]">No SOs match your current filters.</p>
          </div>
        ) : (
          rows.map((row, i) => (
            <SoMobileCard
              key={row.so_id ?? row.so_number ?? `m-${i}`}
              row={row}
              isOpen={row.so_id != null && expanded.has(row.so_id)}
              onToggle={() => row.so_id != null && onToggle(row.so_id)}
              seesCost={seesCost}
              onEditHeader={() => row.so_id != null && onEditHeader(row.so_id)}
              onEditLines={() => row.so_id != null && onEditLines(row.so_id)}
            />
          ))
        )}
      </div>

      {/* ── md+ desktop table ───────────────────────────────────────── */}
      <div className="hidden md:block bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-[13px] border-collapse">
          <thead className="bg-[var(--surface-subtle)] text-[var(--text-primary)]">
            <tr className="border-b border-[var(--aws-border)]">
              <Th width={32}>{null}</Th>
              <Th sortable col="so_number" sortBy={sortBy} order={sortOrder} onSort={onSort}>SO Number</Th>
              <Th sortable col="so_date" sortBy={sortBy} order={sortOrder} onSort={onSort}>Date</Th>
              <Th sortable col="customer_name" sortBy={sortBy} order={sortOrder} onSort={onSort}>Customer</Th>
              <Th sortable col="company" sortBy={sortBy} order={sortOrder} onSort={onSort}>Company</Th>
              <Th>Lines</Th>
              <Th>GST</Th>
              <Th width={60}>{null}</Th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 ? (
              <tr><td colSpan={8} className="px-3 py-10 text-center text-[var(--text-secondary)]">
                <span className="inline-flex items-center gap-2"><span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />Loading Sales Orders…</span>
              </td></tr>
            ) : error ? (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-[var(--aws-error)] text-[13px]">{error}</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={8} className="px-3 py-12 text-center text-[var(--text-secondary)]">
                <p className="font-semibold text-[14px] mb-1">No Sales Orders</p>
                <p className="text-[12px]">No SOs match your current filters.</p>
              </td></tr>
            ) : (
              rows.map((row, i) => {
                const isOpen = row.so_id != null && expanded.has(row.so_id);
                // Stable key fallback: when neither so_id nor so_number is
                // present (shouldn't happen for backend rows, but the type
                // allows it), use the index so React still has a unique
                // key without us calling an impure function during render.
                return (
                  <SoTableRow
                    key={row.so_id ?? row.so_number ?? `idx-${i}`}
                    row={row}
                    isOpen={!!isOpen}
                    onToggle={() => row.so_id != null && onToggle(row.so_id)}
                    seesCost={seesCost}
                    onEditHeader={() => row.so_id != null && onEditHeader(row.so_id)}
                    onEditLines={() => row.so_id != null && onEditLines(row.so_id)}
                  />
                );
              })
            )}
          </tbody>
        </table>
      </div>
      </div>
    </>
  );
}

// ── Mobile SO card ───────────────────────────────────────────────────────
//
// Stacked layout for screens narrower than `md`. The desktop table's eight
// columns of fixed-width whitespace-nowrap text don't fit. This collapses
// the same data into one card per SO with a tap-to-expand affordance.

function SoMobileCard({
  row, isOpen, onToggle, seesCost, onEditHeader, onEditLines,
}: {
  row: SoRow;
  isOpen: boolean;
  onToggle: () => void;
  seesCost: boolean;
  onEditHeader: () => void;
  onEditLines: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const customer = row.common_customer_name || row.customer_name || "—";
  const accentStatus: keyof typeof STATUS_PALETTE =
    (row.gst_mismatch ?? 0) > 0 ? "mismatch" :
    (row.gst_warning  ?? 0) > 0 ? "warning"  :
    (row.gst_ok       ?? 0) > 0 ? "ok"       : "unmatched";
  const palette = STATUS_PALETTE[accentStatus] ?? STATUS_PALETTE.unmatched;
  return (
    <div
      className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] overflow-hidden"
      style={isOpen ? { borderLeft: `3px solid ${palette.fg}` } : undefined}
    >
      <div className="p-3 flex items-start gap-2">
        <button
          type="button"
          onClick={onToggle}
          className="w-6 h-6 mt-0.5 rounded-sm border border-[var(--aws-border-strong)] text-[var(--text-secondary)] flex items-center justify-center hover:border-[var(--aws-navy)] shrink-0"
          aria-label={isOpen ? "Collapse" : "Expand"}
        >
          {isOpen ? "−" : "+"}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="font-mono text-[12px] font-semibold text-[var(--aws-link)] truncate" title={row.so_number ?? ""}>
              {row.so_number || "—"}
            </span>
            <span className="text-[11px] text-[var(--text-muted)] shrink-0">{fmtDate(row.so_date)}</span>
          </div>
          <p className="text-[13px] text-[var(--text-primary)] truncate" title={customer}>{customer}</p>
          <div className="flex items-center justify-between gap-2 mt-1">
            <span className="text-[11px] text-[var(--text-muted)]">
              {row.company || "—"} · {row.total_lines ?? row.line_count ?? row.lines?.length ?? 0} line{(row.total_lines ?? 0) === 1 ? "" : "s"}
            </span>
            <div className="shrink-0"><GstSegBar row={row} /></div>
          </div>
        </div>
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="p-1 rounded hover:bg-[var(--surface-divider)] text-[var(--text-secondary)]"
            aria-label="Edit"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
          </button>
          {menuOpen ? (
            <div className="absolute right-0 z-10 mt-1 w-[160px] bg-white border border-[var(--aws-border)] rounded-md shadow-[0_4px_12px_rgba(0,28,36,0.18)] p-1">
              <button type="button" onClick={() => { setMenuOpen(false); onEditHeader(); }} className="w-full text-left px-2 py-1.5 text-[13px] hover:bg-[var(--surface-disabled)] rounded-sm">Edit Header</button>
              <button type="button" onClick={() => { setMenuOpen(false); onEditLines(); }} className="w-full text-left px-2 py-1.5 text-[13px] hover:bg-[var(--surface-disabled)] rounded-sm">Edit Lines</button>
            </div>
          ) : null}
        </div>
      </div>
      {isOpen ? (
        <div className="border-t border-[var(--aws-border)] p-3 bg-[var(--surface-subtle)]">
          <SoLineDetail row={row} seesCost={seesCost} />
        </div>
      ) : null}
    </div>
  );
}

function Th({
  children, sortable, col, sortBy, order, onSort, width,
}: {
  children: React.ReactNode;
  sortable?: boolean;
  col?: SortBy;
  sortBy?: SortBy;
  order?: SortOrder;
  onSort?: (c: SortBy) => void;
  width?: number;
}) {
  const active = sortable && col && sortBy === col;
  return (
    <th
      style={width ? { width } : undefined}
      onClick={sortable && col && onSort ? () => onSort(col) : undefined}
      className={[
        "px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-[var(--text-secondary)] whitespace-nowrap",
        sortable ? "cursor-pointer select-none hover:text-[var(--text-primary)]" : "",
      ].join(" ")}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {active ? (
          <span className="text-[10px] text-[var(--aws-orange)]">{order === "asc" ? "▲" : "▼"}</span>
        ) : null}
      </span>
    </th>
  );
}

function SoTableRow({
  row, isOpen, onToggle, seesCost, onEditHeader, onEditLines,
}: {
  row: SoRow;
  isOpen: boolean;
  onToggle: () => void;
  seesCost: boolean;
  onEditHeader: () => void;
  onEditLines: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  // Expanded-row accent — derive a single status from the per-status
  // counts the backend ships. Any mismatch trumps a warning, which trumps
  // OK; if none of the three has volume we fall back to "unmatched".
  const accentStatus: keyof typeof STATUS_PALETTE =
    (row.gst_mismatch ?? 0) > 0 ? "mismatch" :
    (row.gst_warning  ?? 0) > 0 ? "warning"  :
    (row.gst_ok       ?? 0) > 0 ? "ok"       : "unmatched";
  const palette = STATUS_PALETTE[accentStatus] ?? STATUS_PALETTE.unmatched;
  return (
    <>
      <tr className="border-b border-[var(--aws-border)] hover:bg-[var(--surface-subtle)]">
        <td className="px-3 py-2 align-top">
          <button
            type="button"
            onClick={onToggle}
            className="w-5 h-5 rounded-sm border border-[var(--aws-border-strong)] text-[var(--text-secondary)] flex items-center justify-center hover:border-[var(--aws-navy)]"
            aria-label={isOpen ? "Collapse" : "Expand"}
          >
            {isOpen ? "−" : "+"}
          </button>
        </td>
        <td className="px-3 py-2 font-mono text-[12px] text-[var(--aws-link)] whitespace-nowrap">{row.so_number || "—"}</td>
        <td className="px-3 py-2 whitespace-nowrap">{fmtDate(row.so_date)}</td>
        <td
          className="px-3 py-2 max-w-[220px] truncate"
          title={row.customer_name ?? ""}
        >
          {/* The Electron view shows the common customer when present and
              falls back to the raw customer_name otherwise — operators
              recognise the canonical name faster than the per-PO variant. */}
          {row.common_customer_name || row.customer_name || "—"}
        </td>
        <td className="px-3 py-2 whitespace-nowrap">{row.company || "—"}</td>
        <td className="px-3 py-2 whitespace-nowrap">{row.total_lines ?? row.line_count ?? row.lines?.length ?? 0}</td>
        <td className="px-3 py-2"><GstSegBar row={row} /></td>
        <td className="px-3 py-2 relative">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="p-1 rounded hover:bg-[var(--surface-divider)] text-[var(--text-secondary)]"
            aria-label="Edit"
            title="Edit"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
          </button>
          {menuOpen ? (
            <div className="absolute right-0 z-10 mt-1 w-[170px] bg-white border border-[var(--aws-border)] rounded-md shadow-[0_4px_12px_rgba(0,28,36,0.18)] p-1">
              <button type="button" onClick={() => { setMenuOpen(false); onEditHeader(); }} className="w-full text-left px-2 py-1.5 text-[13px] hover:bg-[var(--surface-disabled)] rounded-sm">Edit Header</button>
              <button type="button" onClick={() => { setMenuOpen(false); onEditLines(); }} className="w-full text-left px-2 py-1.5 text-[13px] hover:bg-[var(--surface-disabled)] rounded-sm">Edit Lines</button>
            </div>
          ) : null}
        </td>
      </tr>
      {isOpen ? (
        <tr className="border-b border-[var(--aws-border)] bg-[var(--surface-subtle)]">
          <td colSpan={8} className="px-3 py-3" style={{ borderLeft: `3px solid ${palette.fg}` }}>
            <SoLineDetail row={row} seesCost={seesCost} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function GstSegBar({ row }: { row: SoRow }) {
  // Mirrors so-view.js._renderGstSegBar — three coloured segments sized
  // by the share of OK / Warning / Mismatch within total_lines, with a
  // short label and a tooltip detailing the per-status counts.
  const total = row.total_lines ?? 0;
  if (total <= 0) return <span className="text-[var(--text-muted)]">—</span>;

  const ok    = row.gst_ok       ?? 0;
  const warn  = row.gst_warning  ?? 0;
  const err   = row.gst_mismatch ?? 0;
  // Anything not OK / Warn / Mismatch is treated as Unmatched in the bar.
  const unmatched = Math.max(0, total - ok - warn - err);

  const okPct       = (ok        / total) * 100;
  const warnPct     = (warn      / total) * 100;
  const errPct      = (err       / total) * 100;
  const unmatchedPct = (unmatched / total) * 100;

  const parts: string[] = [];
  if (ok)        parts.push(`${ok} OK`);
  if (warn)      parts.push(`${warn} Warn`);
  if (err)       parts.push(`${err} Err`);
  if (unmatched) parts.push(`${unmatched} —`);
  const label =
    parts.length === 0 ? "—" :
    ok === total ? "All OK" :
    parts.join(" · ");
  const tooltip =
    `${ok} OK / ${warn} Warning / ${err} Mismatch` +
    (unmatched ? ` / ${unmatched} Unmatched` : "");

  return (
    <div className="flex flex-col gap-1" title={tooltip}>
      <div className="flex h-1.5 w-[120px] rounded-full overflow-hidden bg-[var(--surface-divider)]">
        {okPct        > 0 ? <span style={{ width: `${okPct}%`,        background: "var(--text-success)" }} /> : null}
        {warnPct      > 0 ? <span style={{ width: `${warnPct}%`,      background: "#9a393e" }} /> : null}
        {errPct       > 0 ? <span style={{ width: `${errPct}%`,       background: "#b1361e" }} /> : null}
        {unmatchedPct > 0 ? <span style={{ width: `${unmatchedPct}%`, background: "var(--text-muted)" }} /> : null}
      </div>
      <span className="text-[10px] text-[var(--text-muted)] tabular-nums">{label}</span>
    </div>
  );
}

function SoLineDetail({ row, seesCost }: { row: SoRow; seesCost: boolean }) {
  // Backend ships the list endpoint's `lines` as [{ line, gst_recon }] but
  // the detail endpoint ships a flat SoLine[]. normaliseLines() collapses
  // both into a single shape so the column readers don't have to branch.
  const entries = normaliseLines(row.lines);
  const meta: { label: string; value: string }[] = [
    { label: "Common customer", value: row.common_customer_name || "—" },
    { label: "Voucher type",    value: row.voucher_type || "—" },
    { label: "Total lines",     value: String(row.total_lines ?? entries.length) },
    { label: "GST OK / Warn / Err", value: `${row.gst_ok ?? 0} / ${row.gst_warning ?? 0} / ${row.gst_mismatch ?? 0}` },
  ];
  return (
    <>
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-[11px] mb-3">
        {meta.map((m) => (
          <div key={m.label} className="min-w-0">
            <dt className="uppercase tracking-wide font-semibold text-[var(--text-muted)] text-[10px]">{m.label}</dt>
            <dd className="text-[12px] text-[var(--text-primary)] truncate" title={m.value}>{m.value}</dd>
          </div>
        ))}
      </dl>
      {entries.length === 0 ? (
        <p className="text-[12px] text-[var(--text-muted)] italic">No line items.</p>
      ) : (
        <div className="space-y-2">
          {entries.map(({ line, gst_recon }, i) => (
            <LineCard key={line.so_line_id ?? line.line_number ?? i} line={line} gst={gst_recon ?? null} seesCost={seesCost} />
          ))}
        </div>
      )}
    </>
  );
}

// ── Per-line card — collapsible article expansion ────────────────────────
//
// Mirrors so-view.js renderLineDetails → line-card → 4 sections:
//   1. Line Item Details
//   2. Quantity & Pricing
//   3. Master Match Info (with match-score bar)
//   4. GST Reconciliation (+ Excel-vs-Master compare table + checks),
//      or "No GST Reconciliation" when gst_recon is null.

function LineCard({ line, gst, seesCost }: { line: SoLine; gst: GstRecon | null; seesCost: boolean }) {
  const [open, setOpen] = useState(false);
  const status = (gst?.status ?? line.gst_status ?? (gst ? "ok" : "unmatched")) as string;
  const palette = STATUS_PALETTE[status] ?? STATUS_PALETTE.unmatched;
  const isUnmatched = line.match_score == null || line.match_source == null;

  return (
    <div
      className={[
        "bg-white border rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.10)] overflow-hidden",
        isUnmatched ? "border-[var(--text-muted)]" : "border-[var(--aws-border)]",
      ].join(" ")}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-3 py-2 flex items-center gap-3 hover:bg-[var(--surface-subtle)]"
        aria-expanded={open}
      >
        <span className="inline-flex items-center justify-center w-6 h-6 rounded-sm bg-[var(--surface-divider)] text-[11px] font-bold text-[var(--text-secondary)] shrink-0">
          {line.line_number ?? "?"}
        </span>
        <span
          className={[
            "flex-1 min-w-0 truncate text-[13px]",
            isUnmatched ? "text-[var(--text-muted)] italic" : "text-[var(--text-primary)]",
          ].join(" ")}
          title={line.sku_name ?? ""}
        >
          {line.sku_name || "Unnamed Article"}
          {isUnmatched ? <span className="ml-2 text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted)]">Unmatched</span> : null}
        </span>
        {/* C12: deny-list roles never see the ₹ chip on the row header.
            The status chip + line title still anchor the layout, so
            hiding this doesn't break the row alignment. */}
        {seesCost ? (
          <span className="text-[12px] font-mono tabular-nums text-[var(--text-secondary)] shrink-0">
            ₹{fmtNum(line.total_amount_inr)}
          </span>
        ) : null}
        <span
          className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-sm capitalize shrink-0"
          style={{ background: palette.bg, color: palette.fg, border: `1px solid ${palette.ring}` }}
        >
          {String(status).replace(/_/g, " ")}
        </span>
        <span className={["text-[var(--text-muted)] transition-transform shrink-0", open ? "rotate-90" : ""].join(" ")} aria-hidden>▸</span>
      </button>

      {open ? (
        <div className="border-t border-[var(--aws-border)] p-3 bg-[var(--surface-subtle)] space-y-3">
          <LineItemSection line={line} />
          {/* PricingSection retains Pack Count, Quantity (Kg), and
              Rate Type for all roles; the ₹ cells are gated inside the
              component via `seesCost` so deny-list roles still get the
              operational metrics without any cost chrome. */}
          <PricingSection line={line} seesCost={seesCost} />
          <MatchSection line={line} />
          {gst ? <GstSection line={line} gst={gst} seesCost={seesCost} /> : <NoGstSection />}
        </div>
      ) : null}
    </div>
  );
}

// ── Sections ─────────────────────────────────────────────────────────────

function SectionShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md p-3">
      <div className="text-[11px] uppercase tracking-wide font-semibold text-[var(--text-secondary)] mb-2">
        {title}
      </div>
      {children}
    </div>
  );
}

function KV({ label, value, mono, accent }: { label: string; value: React.ReactNode; mono?: boolean; accent?: "ok" | "warn" | "err" }) {
  const colour =
    accent === "ok"   ? "text-[var(--text-success)]" :
    accent === "warn" ? "text-[#9a393e]" :
    accent === "err"  ? "text-[#b1361e]" :
                        "text-[var(--text-primary)]";
  return (
    <div className="min-w-0">
      <div className="uppercase tracking-wide font-semibold text-[var(--text-muted)] text-[10px]">{label}</div>
      <div className={["text-[12px] truncate", mono ? "font-mono" : "", colour].join(" ")} title={typeof value === "string" ? value : undefined}>{value}</div>
    </div>
  );
}

function LineItemSection({ line }: { line: SoLine }) {
  return (
    <SectionShell title="Line Item Details">
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-2">
        <KV label="SO Line ID"     value={line.so_line_id ?? "—"} mono />
        <KV label="Line Number"    value={line.line_number ?? "—"} mono />
        <KV label="SKU Name"       value={line.sku_name || "—"} />
        <KV label="Item Category"  value={line.item_category || "—"} />
        <KV label="Sub Category"   value={line.sub_category || "—"} />
        <KV label="UOM"            value={line.uom || "—"} mono />
        <KV label="GRP Code"       value={line.grp_code || "—"} />
        <KV label="Status"         value={line.status || "—"} />
      </dl>
    </SectionShell>
  );
}

function PricingSection({ line, seesCost }: { line: SoLine; seesCost: boolean }) {
  // The Pack Count, Quantity (Kg), and Rate Type fields are operational
  // (not currency) and stay visible for every role. The remaining cells
  // are all currency amounts — they're gated by `seesCost`. The grid
  // auto-collapses cleanly because every KV is the same shape, so the
  // narrower 3-cell view for deny-list roles still aligns at md+.
  return (
    <SectionShell title={seesCost ? "Quantity & Pricing" : "Quantity"}>
      <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-3 gap-y-2">
        <KV label="Pack Count"          value={fmtNum(line.quantity)}        mono />
        <KV label="Quantity (Kg)"       value={fmtNum(line.quantity_units)}  mono />
        <KV label="Rate Type"           value={line.rate_type || "—"} />
        {seesCost ? (
          <>
            <KV label="Rate (INR)"          value={fmtCur(line.rate_inr)}        mono />
            <KV label="Amount (INR)"        value={fmtCur(line.amount_inr)}      mono />
            <KV label="IGST Amount"         value={fmtCur(line.igst_amount)}     mono />
            <KV label="SGST Amount"         value={fmtCur(line.sgst_amount)}     mono />
            <KV label="CGST Amount"         value={fmtCur(line.cgst_amount)}     mono />
            <KV label="APMC Amount"         value={fmtCur(line.apmc_amount)}     mono />
            <KV label="Packing Amount"      value={fmtCur(line.packing_amount)}  mono />
            <KV label="Freight Amount"      value={fmtCur(line.freight_amount)}  mono />
            <KV label="Processing Amount"   value={fmtCur(line.processing_amount)} mono />
            <KV label="Total Amount (INR)"  value={fmtCur(line.total_amount_inr)} mono accent="ok" />
          </>
        ) : null}
      </dl>
    </SectionShell>
  );
}

function MatchSection({ line }: { line: SoLine }) {
  const score = typeof line.match_score === "number" ? line.match_score : null;
  const pct = score != null ? Math.max(0, Math.min(1, score)) * 100 : 0;
  const tone =
    score == null    ? { cls: "bg-[var(--text-muted)]",    color: "text-[var(--text-muted)]",   label: "—" } :
    pct  >= 90       ? { cls: "bg-[var(--text-success)]",  color: "text-[var(--text-success)]", label: "Excellent" } :
    pct  >= 75       ? { cls: "bg-[#9a393e]",              color: "text-[#9a393e]",             label: "Good" } :
    pct  >= 50       ? { cls: "bg-[#9a393e]",              color: "text-[#9a393e]",             label: "Fair" } :
                       { cls: "bg-[#b1361e]",              color: "text-[#b1361e]",             label: "Weak" };
  return (
    <SectionShell title="Master Match Info">
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-2">
        <KV label="Item Type"        value={line.item_type || "—"} accent={line.item_type === "rm" || line.item_type === "pm" ? "warn" : undefined} />
        <KV label="Item Description" value={line.item_description || "—"} />
        <KV label="Sales Group"      value={line.sales_group || "—"} />
        <KV label="Match Source"     value={line.match_source || "—"} />
      </dl>
      <div className="mt-3">
        <div className="uppercase tracking-wide font-semibold text-[var(--text-muted)] text-[10px] mb-1">Match Score</div>
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1.5 bg-[var(--surface-divider)] rounded-full overflow-hidden">
            <div className={["h-full rounded-full", tone.cls].join(" ")} style={{ width: `${pct}%` }} />
          </div>
          <span className={["text-[11px] font-semibold tabular-nums", tone.color].join(" ")}>
            {score != null ? `${pct.toFixed(1)}% — ${tone.label}` : "—"}
          </span>
        </div>
      </div>
    </SectionShell>
  );
}

function GstSection({ line, gst, seesCost }: { line: SoLine; gst: GstRecon; seesCost: boolean }) {
  const status = String(gst.status ?? "unmatched");
  const palette = STATUS_PALETTE[status] ?? STATUS_PALETTE.unmatched;
  const diff = parseFloat(String(gst.gst_difference ?? 0));
  return (
    <>
      <SectionShell title="GST Reconciliation">
        <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-3 gap-y-2">
          <KV
            label="Recon Status"
            value={
              <span className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-sm capitalize" style={{ background: palette.bg, color: palette.fg, border: `1px solid ${palette.ring}` }}>
                {status.replace(/_/g, " ")}
              </span>
            }
          />
          {/* GST RATES (0.18 = 18%) are dimensionless percentages — they
              stay visible for every role. The corresponding AMOUNT cells
              are currency-denominated, so they vanish for deny-list
              roles. The grid auto-reflows because every cell is the same
              shape, so dropping cells doesn't break alignment. */}
          <KV label="Expected GST Rate"   value={fmtRate(gst.expected_gst_rate)} mono />
          <KV label="Actual GST Rate"     value={fmtRate(gst.actual_gst_rate)}   mono />
          {seesCost ? <KV label="Expected GST Amount" value={fmtCur(gst.expected_gst_amount)} mono /> : null}
          {seesCost ? <KV label="Actual GST Amount"   value={fmtCur(gst.actual_gst_amount)}   mono /> : null}
          {seesCost ? <KV label="GST Difference"      value={fmtCur(gst.gst_difference)}      mono accent={Math.abs(diff) > 0.01 ? "err" : undefined} /> : null}
          <KV label="GST Type"            value={gst.gst_type || "—"} mono />
        </dl>
      </SectionShell>

      <SectionShell title="Excel vs Master Comparison">
        <div className="overflow-x-auto">
          <table className="w-full text-[12px] border-collapse">
            <thead className="bg-[var(--surface-subtle)]">
              <tr className="border-b border-[var(--aws-border)]">
                <th className="px-2 py-1 text-left">Field</th>
                <th className="px-2 py-1 text-left">From Excel</th>
                <th className="px-2 py-1 text-center" />
                <th className="px-2 py-1 text-left">From Master</th>
              </tr>
            </thead>
            <tbody>
              <CompareRow label="Article Name"  excel={line.sku_name}      master={gst.matched_item_description} />
              <CompareRow label="Item Category" excel={line.item_category} master={gst.matched_item_category} />
              <CompareRow label="Sub Category"  excel={line.sub_category}  master={gst.matched_sub_category} />
              <CompareRow label="UOM"           excel={line.uom}           master={gst.matched_uom != null ? String(gst.matched_uom) : null} verdict={gst.uom_match} />
              <CompareRow label="Sales Group"   excel={line.sales_group}   master={gst.matched_sales_group} />
              <CompareRow label="Item Type"     excel={line.item_type}     master={gst.matched_item_type} />
              <CompareRow label="GST Rate"      excel={gst.actual_gst_rate}   master={gst.expected_gst_rate}   format="rate" />
              {/* GST Amount comparison is currency-denominated → gated. */}
              {seesCost ? (
                <CompareRow label="GST Amount"    excel={gst.actual_gst_amount} master={gst.expected_gst_amount} format="cur" />
              ) : null}
            </tbody>
          </table>
        </div>
      </SectionShell>

      <SectionShell title="GST Validation Checks">
        <ValidationChecks line={line} gst={gst} seesCost={seesCost} />
        {gst.notes ? (
          <div className="mt-3 pt-3 border-t border-[var(--aws-border)]">
            <div className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted)] mb-1">Notes</div>
            {String(gst.notes).split(";").map((n) => n.trim()).filter(Boolean).map((n, i) => (
              <p key={i} className="text-[12px] text-[var(--text-secondary)] mt-1">• {n}</p>
            ))}
          </div>
        ) : null}
      </SectionShell>
    </>
  );
}

function NoGstSection() {
  return (
    <div className="bg-white border border-dashed border-[var(--text-muted)] rounded-md p-3">
      <div className="text-[11px] uppercase tracking-wide font-semibold text-[var(--text-muted)]">
        No GST Reconciliation
      </div>
      <p className="text-[12px] text-[var(--text-muted)] mt-1 italic">Article was not matched in the master, so no reconciliation was run.</p>
    </div>
  );
}

function CompareRow({
  label, excel, master, format, verdict,
}: {
  label: string;
  excel: number | string | null | undefined;
  master: number | string | null | undefined;
  format?: "rate" | "cur";
  // Explicit verdict from the server-side reconciliation. When supplied it
  // overrides the local string-or-number compare — important for fields
  // like UOM where the Excel label ("PCS") and the master factor (1.0)
  // are intentionally different shapes and a naive compare would always
  // read as a mismatch. null = check was skipped server-side (⚠).
  verdict?: boolean | null;
}) {
  const fmt = (v: number | string | null | undefined): string => {
    if (v == null || v === "") return "";
    return format === "rate" ? fmtRate(v) :
           format === "cur"  ? fmtCur(v)  :
                               String(v);
  };
  const eD = fmt(excel);
  const mD = fmt(master);
  let cls: "pass" | "fail" | "warn" = "warn";
  if (verdict !== undefined) {
    // null → warn (server skipped the check, e.g. missing master row);
    // true → pass; false → fail.
    cls = verdict === true ? "pass" : verdict === false ? "fail" : "warn";
  } else if (excel == null || master == null) {
    cls = "warn";
  } else {
    const nE = parseFloat(String(excel));
    const nM = parseFloat(String(master));
    const same = (!Number.isNaN(nE) && !Number.isNaN(nM))
      ? Math.abs(nE - nM) < 0.01
      : String(excel).toLowerCase() === String(master).toLowerCase();
    cls = same ? "pass" : "fail";
  }
  const icon = cls === "pass" ? "✓" : cls === "fail" ? "✗" : "⚠";
  const tone =
    cls === "pass" ? "text-[var(--text-success)]" :
    cls === "fail" ? "text-[#b1361e]" :
                     "text-[#9a393e]";
  return (
    <tr className="border-b border-[var(--aws-border)]">
      <td className="px-2 py-1 font-semibold text-[var(--text-secondary)]">{label}</td>
      <td className="px-2 py-1 max-w-[200px] truncate" title={eD}>{eD || <span className="text-[var(--text-muted)] italic">null</span>}</td>
      <td className={["px-2 py-1 text-center font-bold", tone].join(" ")}>{icon}</td>
      <td className="px-2 py-1 max-w-[200px] truncate" title={mD}>{mD || <span className="text-[var(--text-muted)] italic">null</span>}</td>
    </tr>
  );
}

function ValidationChecks({ line, gst, seesCost }: { line: SoLine; gst: GstRecon; seesCost: boolean }) {
  type Check = { pass: boolean; warn: boolean; text: React.ReactNode };
  const checks: Check[] = [];
  if (gst.expected_gst_rate != null) {
    const same = Math.abs(parseFloat(String(gst.expected_gst_rate ?? 0)) - parseFloat(String(gst.actual_gst_rate ?? 0))) < 0.01;
    checks.push({ pass: same, warn: false, text: <>GST Rate — Expected <strong>{fmtRate(gst.expected_gst_rate)}</strong>, Actual <strong>{fmtRate(gst.actual_gst_rate)}</strong></> });
  }
  if (gst.gst_type_valid != null) {
    checks.push({ pass: !!gst.gst_type_valid, warn: false, text: <>GST Type — <strong>{gst.gst_type || "—"}</strong> {gst.gst_type_valid ? "(valid)" : "(IGST and SGST/CGST both non-zero)"}</> });
  }
  // The SGST/CGST equality and the Amount+GST=Total checks both inline
  // ₹ values, so we drop the rows entirely for deny-list roles instead
  // of rendering a check string with the cost numbers stripped (which
  // would read as nonsense — "SGST   equals CGST  ").
  if (seesCost && gst.sgst_cgst_equal != null) {
    checks.push({ pass: !!gst.sgst_cgst_equal, warn: false, text: <>SGST/CGST Equal — SGST <strong>{fmtCur(line.sgst_amount)}</strong>, CGST <strong>{fmtCur(line.cgst_amount)}</strong></> });
  }
  if (seesCost && gst.total_with_gst_valid != null) {
    checks.push({ pass: !!gst.total_with_gst_valid, warn: false, text: <>Total — Amount (<strong>{fmtCur(line.amount_inr)}</strong>) + GST (<strong>{fmtCur(gst.actual_gst_amount)}</strong>) = Total (<strong>{fmtCur(line.total_amount_inr)}</strong>) {gst.total_with_gst_valid ? "— Matched" : "— Mismatch"}</> });
  }
  if (gst.uom_match != null) {
    checks.push({ pass: !!gst.uom_match, warn: !gst.uom_match, text: <>UOM — Excel <strong>{line.uom || "—"}</strong> vs Master <strong>{gst.matched_uom != null ? String(gst.matched_uom) : "—"}</strong> {gst.uom_match ? "— Matched" : "— Mismatch"}</> });
  }
  if (gst.item_type_flag) {
    const ft = gst.item_type_flag === "RM_SOLD" ? "Raw Material being sold" : "Packaging Material being sold";
    checks.push({ pass: false, warn: true, text: <>Item Type Flag — <strong>{gst.item_type_flag}</strong>: {ft}</> });
  } else if (gst.item_type_flag === null && gst.matched_item_type === "fg") {
    checks.push({ pass: true, warn: false, text: <>Item Type — <strong>FG</strong> (Finished Good) — OK</> });
  }

  if (checks.length === 0) return <p className="text-[12px] text-[var(--text-muted)] italic">No validation checks ran for this line.</p>;

  return (
    <div className="space-y-1.5">
      {checks.map((c, i) => {
        const icon = c.pass ? "✓" : c.warn ? "⚠" : "✗";
        const tone = c.pass ? "text-[var(--text-success)]" : c.warn ? "text-[#9a393e]" : "text-[#b1361e]";
        return (
          <div key={i} className="flex items-start gap-2 text-[12px]">
            <span className={["font-bold w-4 shrink-0", tone].join(" ")}>{icon}</span>
            <span className="text-[var(--text-primary)]">{c.text}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Numeric formatters used by the line cards ────────────────────────────

function fmtCur(v: number | string | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = typeof v === "number" ? v : parseFloat(v);
  if (Number.isNaN(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtRate(v: number | string | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = typeof v === "number" ? v : parseFloat(v);
  if (Number.isNaN(n)) return "—";
  // Rates land as 0.18 (= 18%) from the backend.
  return `${(n * 100).toFixed(2)}%`;
}

// ── Pagination ───────────────────────────────────────────────────────────

// Pagination + its page-button stay hoisted outside the page component so
// every render doesn't recreate the inner Btn (which would reset its state
// and trip react-hooks/static-components).
function PageBtn({
  p, label, active, disabled, onPage, loading,
}: {
  p: number; label: React.ReactNode; active?: boolean; disabled?: boolean;
  onPage: (p: number) => void; loading: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onPage(p)}
      disabled={!!disabled || loading}
      className={[
        "min-w-[28px] h-7 px-2 text-[12px] rounded-sm border",
        active
          ? "bg-[var(--aws-navy)] text-white border-[var(--aws-navy)]"
          : "bg-white text-[var(--text-primary)] border-[var(--aws-border-strong)] hover:border-[var(--aws-navy)]",
        disabled ? "opacity-50 cursor-not-allowed" : "",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

function Pagination({
  page, totalPages, total, pageSize, onPage, loading,
}: {
  page: number; totalPages: number; total: number; pageSize: number;
  onPage: (p: number) => void; loading: boolean;
}) {
  if (totalPages <= 1) return null;
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(page * pageSize, total);
  const max = 5;
  let from = Math.max(1, page - Math.floor(max / 2));
  const to = Math.min(totalPages, from + max - 1);
  if (to - from + 1 < max) from = Math.max(1, to - max + 1);
  const pages: number[] = [];
  for (let i = from; i <= to; i++) pages.push(i);
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
      <span className="text-[12px] text-[var(--text-secondary)]">Showing {start}–{end} of {total} SOs</span>
      <div className="flex items-center gap-1">
        <PageBtn p={page - 1} label="‹" disabled={page <= 1} onPage={onPage} loading={loading} />
        {from > 1 ? <PageBtn p={1} label={1} onPage={onPage} loading={loading} /> : null}
        {from > 2 ? <span className="px-1 text-[var(--text-muted)]">…</span> : null}
        {pages.map((p) => <PageBtn key={p} p={p} label={p} active={p === page} onPage={onPage} loading={loading} />)}
        {to < totalPages - 1 ? <span className="px-1 text-[var(--text-muted)]">…</span> : null}
        {to < totalPages ? <PageBtn p={totalPages} label={totalPages} onPage={onPage} loading={loading} /> : null}
        <PageBtn p={page + 1} label="›" disabled={page >= totalPages} onPage={onPage} loading={loading} />
      </div>
    </div>
  );
}

// Suppress the unused-warning for `useMemo` import (kept for future filter
// derivations) by referencing it once.
void useMemo;
