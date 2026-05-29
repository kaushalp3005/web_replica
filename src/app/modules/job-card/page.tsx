"use client";

// Replicates frontend_replica/src/modules/production/job-cards/* — entity
// buttons, summary cards, search + status filter, paginated table, status
// badges, issuance bar. Backed by GET /api/v1/production/job-cards-v2.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, signOut } from "@/lib/auth";
import { useRequireAuth, useUserInitial, useUserScope } from "@/lib/user";
import { JC_LIST_PAGE_SIZE, SEARCH_DEBOUNCE_MS } from "@/lib/constants";
import {
  loadListCache,
  saveListCache,
  patchListCache,
  type CachedRow,
  type JcListCache,
} from "@/lib/jc-list-cache";

type JobCardRow = {
  job_card_id: number;
  job_card_number?: string | null;
  fg_sku_name?: string | null;
  customer_name?: string | null;
  // v2 stores planned qty (kg + units); the v1 frontend referred to this as
  // batch_size_kg — kept the alias here in case a v1 row sneaks through.
  planned_qty_kg?: number | string | null;
  batch_size_kg?: number | string | null;
  stage?: string | null;
  floor?: string | null;
  factory?: string | null;
  assigned_to_team_leader?: string | null;
  // v2 has no issuance %; v1 frontend exposed it. Treat as optional.
  issuance_pct?: number | string | null;
  status?: string | null;
  entity?: string | null;
  plan_id?: number | null;
  // Aggregated SO numbers for this JC's plan line — backend returns
  // ARRAY_AGG(DISTINCT so_header.so_number). May be null when no SO is
  // linked (manual job cards, scratch plans, etc.).
  so_numbers?: string[] | null;
};

type Pagination = {
  page?: number;
  page_size?: number;
  total?: number;
  total_pages?: number;
};

type ListResponse = {
  results?: JobCardRow[];
  pagination?: Pagination;
  filter_options?: { customers?: string[] };
};

// /job-cards-v2/search returns the same row shape but no pagination block —
// it's deliberately unpaginated; the service caps at hard_cap and tells the
// caller via `capped` so the UI can prompt the user to narrow the query.
type SearchResponse = {
  results?: JobCardRow[];
  total?: number;
  capped?: boolean;
  hard_cap?: number;
};

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "locked", label: "Locked" },
  { value: "unlocked", label: "Unlocked" },
  { value: "assigned", label: "Assigned" },
  { value: "material_received", label: "Material Received" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
  { value: "closed", label: "Closed" },
  { value: "cancelled", label: "Cancelled" },
];

// PAGE_SIZE lives in @/lib/constants as JC_LIST_PAGE_SIZE; aliased here so
// the rest of the file reads more naturally (`PAGE_SIZE` matches the
// pagination-bar variable conventions).
const PAGE_SIZE = JC_LIST_PAGE_SIZE;

// Status → AWS-console-leaning badge palette. Keeps the same status-pill
// vocabulary as the original frontend (locked/red, in-progress/blue, etc.).
const STATUS_STYLES: Record<string, { bg: string; fg: string; ring: string }> = {
  locked: { bg: "#fdf3f1", fg: "#b1361e", ring: "#f0c7be" },
  unlocked: { bg: "#f4f4f4", fg: "#414d5c", ring: "#d5dbdb" },
  assigned: { bg: "#fef3e6", fg: "#a35200", ring: "#f5d6a8" },
  material_received: { bg: "#eaf3ff", fg: "#0073bb", ring: "#bbd9f3" },
  in_progress: { bg: "#eaf3ff", fg: "#0073bb", ring: "#bbd9f3" },
  completed: { bg: "#eaf6ed", fg: "#1d8102", ring: "#b6dbb1" },
  closed: { bg: "#f0eef8", fg: "#5752c4", ring: "#d2cef0" },
  cancelled: { bg: "#f4f4f4", fg: "#687078", ring: "#d5dbdb" },
};

function fmtStatus(s?: string | null): string {
  return (s || "").replace(/_/g, " ");
}

function fmtBatch(v: number | string | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = typeof v === "number" ? v : parseFloat(v);
  if (Number.isNaN(n)) return "—";
  return `${n.toLocaleString("en-IN")} kg`;
}

// JC numbers are long alphanumeric strings (e.g. JC-CFPL-2025-0001234).
// Cards have less horizontal real estate than table rows, so show a compact
// suffix view; the full number remains available via the title tooltip.
function shortJc(full: string): string {
  if (full.length <= 12) return full;
  const tail = full.slice(-8);
  return `…${tail}`;
}

// A plan line can bundle multiple SOs; the card has room for one cell. Show
// the first SO with a "+N" suffix to signal there are more, and pass the
// full comma-separated list as a tooltip via the Meta `title` override.
function formatSo(arr: string[] | null | undefined): { display: string; tooltip: string } {
  if (!arr || arr.length === 0) return { display: "—", tooltip: "" };
  if (arr.length === 1) return { display: arr[0], tooltip: arr[0] };
  return { display: `${arr[0]} +${arr.length - 1}`, tooltip: arr.join(", ") };
}

export default function JobCardListingPage() {
  const router = useRouter();

  // ── Initial state — hydrate from the session cache when present so
  // returning from the detail page lands the operator on the exact same
  // filtered view they left, without a network round-trip. The cache lives
  // in sessionStorage (lib/jc-list-cache.ts) and is scoped to the tab.
  //
  // CRITICAL: `useState` lazy init runs ONCE on mount. We deliberately do
  // not call loadListCache() on every render — each call returns a fresh
  // object reference, which would invalidate the load-effect's dep array
  // every render → fetch → setState → re-render → fetch → … request storm.
  const [cache] = useState<JcListCache | null>(() =>
    typeof window !== "undefined" ? loadListCache() : null,
  );

  const [rows, setRows] = useState<JobCardRow[]>(cache?.rows ?? []);
  const [pagination, setPagination] = useState<Pagination>(cache?.pagination ?? {});
  // If we have a cache, skip the initial load — don't even render the
  // spinner; the operator's previous list is already on screen.
  const [loading, setLoading] = useState(!cache);
  const [error, setError] = useState<string | null>(null);

  const [entity, setEntity] = useState<"" | "cfpl" | "cdpl">(
    (cache?.entity as "" | "cfpl" | "cdpl" | undefined) ?? "",
  );
  const [factory, setFactory] = useState<"" | "W-202" | "A-185">(
    (cache?.factory as "" | "W-202" | "A-185" | undefined) ?? "",
  );
  const [statusFilter, setStatusFilter] = useState<string[]>(cache?.statusFilter ?? []);
  const [search, setSearch] = useState(cache?.search ?? "");
  const [debouncedSearch, setDebouncedSearch] = useState(cache?.search ?? "");
  const [page, setPage] = useState(cache?.page ?? 1);
  const initial = useUserInitial();
  const userScope = useUserScope();
  // Populated only when we hit /search; null when we hit the paginated list.
  const [searchMeta, setSearchMeta] = useState<{
    total: number;
    capped: boolean;
    hardCap: number;
  } | null>(cache?.searchMeta ?? null);

  // Skip the first fetch if we hydrated from cache — the rows the operator
  // last saw are already on screen. Any filter change after this point will
  // trigger a normal refetch via the load() effect below.
  const hasHydratedFromCache = useRef(!!cache);

  // Debounce the search box like the original. Also resets the page so
  // the fetch effect doesn't ask for an out-of-range page after the
  // result set shrinks. setPage(1) is a no-op when page is already 1.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  // Filter-change handlers: paired with setPage(1) so the fetch effect
  // fires exactly once with the new filter + page-1. The earlier "watch
  // filters in a useEffect, then setPage(1)" approach fired the fetch
  // twice — once with the OLD page and once with page 1 — because the
  // page-reset effect ran in a separate commit. setPage(1) when page is
  // already 1 is a no-op (React bails out on Object.is-equal primitives).
  function changeEntity(v: typeof entity) {
    setEntity(v);
    setPage(1);
  }
  function changeFactory(v: typeof factory) {
    setFactory(v);
    setPage(1);
  }
  function changeStatus(next: string[]) {
    setStatusFilter(next);
    setPage(1);
  }

  // Single fetch effect. Depends directly on the filter primitives instead
  // of going through a useCallback — that indirection was creating a new
  // `load` reference whenever its inner setStates changed React state, and
  // because `load` was in the effect's dep array, the effect kept re-firing
  // → fetch → setState → re-render → new `load` reference → fetch again.
  //
  // The effect now runs only when an actual filter value (or page) changes.
  // The AbortController cancels any in-flight fetch from a previous render
  // so a slow request doesn't stomp on the result of a newer one when the
  // operator changes filters quickly.
  // Boot-time auth gate. The hook redirects when no usable refresh token
  // is present and stashes the current path so login can bounce back.
  // Returns false during the brief window between the redirect being
  // scheduled and the navigation completing; we use it to skip the fetch.
  const authed = useRequireAuth(router.replace);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!authed) return;
    // First mount with cache hydration: skip the fetch entirely; rows are
    // already on screen. Subsequent runs (after a filter change) clear the
    // flag and refetch normally.
    if (hasHydratedFromCache.current) {
      hasHydratedFromCache.current = false;
      const y = cache?.scrollY ?? 0;
      if (y > 0) {
        // Two RAFs — first paints the rows, second lets layout settle so
        // window.scrollTo lands on the right offset.
        requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, y)));
      }
      return;
    }

    const controller = new AbortController();
    void (async () => {
      setLoading(true);
      setError(null);
      // Free-text search routes through the unpaginated /search endpoint;
      // when the search box is empty we hit the paginated list instead.
      const useSearch = !!debouncedSearch;
      const params = new URLSearchParams();
      if (entity) params.set("entity", entity);
      if (factory) params.set("factory", factory);
      if (statusFilter.length) params.set("status", statusFilter.join(","));
      if (useSearch) {
        params.set("q", debouncedSearch);
      } else {
        params.set("page", String(page));
        params.set("page_size", String(PAGE_SIZE));
      }
      const path = useSearch
        ? `/api/v1/production/job-cards-v2/search`
        : `/api/v1/production/job-cards-v2`;
      try {
        const res = await apiFetch(`${path}?${params}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        // 401 is intercepted by apiFetch globally — it triggers signOut()
        // and a hard redirect to "/". Just bail out of this fetch.
        if (res.status === 401) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (useSearch) {
          const data = (await res.json()) as SearchResponse;
          if (controller.signal.aborted) return;
          const nextRows = data.results ?? [];
          const nextMeta = { total: data.total ?? 0, capped: !!data.capped, hardCap: data.hard_cap ?? 0 };
          setRows(nextRows);
          setPagination({});
          setSearchMeta(nextMeta);
          saveListCache({
            entity, factory, statusFilter, search: debouncedSearch, page,
            rows: nextRows as unknown as CachedRow[],
            pagination: undefined,
            searchMeta: nextMeta,
            scrollY: 0,
          });
        } else {
          const data = (await res.json()) as ListResponse;
          if (controller.signal.aborted) return;
          const nextRows = data.results ?? [];
          const nextPagination = data.pagination ?? {};
          setRows(nextRows);
          setPagination(nextPagination);
          setSearchMeta(null);
          saveListCache({
            entity, factory, statusFilter, search: debouncedSearch, page,
            rows: nextRows as unknown as CachedRow[],
            pagination: nextPagination,
            searchMeta: null,
            scrollY: 0,
          });
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Failed to load job cards");
        setRows([]);
        setPagination({});
        setSearchMeta(null);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [entity, factory, statusFilter, debouncedSearch, page, router, cache, authed]);

  function toggleStatus(s: string) {
    // Wraps changeStatus so the page-reset stays atomic with the toggle.
    changeStatus(
      statusFilter.includes(s)
        ? statusFilter.filter((x) => x !== s)
        : [...statusFilter, s],
    );
  }

  // Avatar initial + scope come from the shared hooks in lib/user — both
  // read the same cached MeResponse so no per-page effect is needed.

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-6 gap-4">
        <span className="text-white font-bold tracking-tight text-[17px] flex items-baseline">
          aws
          <span className="inline-block w-[4px] h-[4px] rounded-full bg-[var(--aws-orange)] ml-[1px]" />
        </span>
        <span className="text-[#d5dbdb] text-[13px] hidden sm:inline">Console</span>
        <nav className="text-[12px] text-[#d5dbdb] hidden md:flex items-center gap-2 ml-2">
          <button onClick={() => router.push("/modules")} className="hover:underline">
            Modules
          </button>
          <span>/</span>
          <span className="text-white">Job Cards</span>
        </nav>
        <div className="flex-1" />
        <button
          onClick={() => { signOut(); router.replace("/"); }}
          aria-label="Sign out"
          className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]"
        >
          {initial}
        </button>
      </header>

      <main className="flex-1 max-w-[1280px] w-full mx-auto px-4 sm:px-6 py-6">
        <div className="flex flex-wrap items-end justify-between gap-4 mb-5">
          <div>
            <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">
              Job Cards
            </h1>
            <p className="text-[13px] text-[var(--text-secondary)] mt-1">
              Track job card lifecycle across the factory floor
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <ChipGroup
              label="Entity"
              value={entity}
              options={[
                { value: "", label: "All" },
                { value: "cfpl", label: "CFPL" },
                { value: "cdpl", label: "CDPL" },
              ]}
              onChange={(v) => changeEntity(v as typeof entity)}
            />
            <ChipGroup
              label="Plant"
              value={factory}
              options={[
                { value: "", label: "All" },
                { value: "W-202", label: "W-202" },
                { value: "A-185", label: "A-185" },
              ]}
              onChange={(v) => changeFactory(v as typeof factory)}
            />
          </div>
        </div>

        {!userScope.isAdmin && userScope.warehouses.length > 0 ? (
          <div className="mb-4 border border-[var(--aws-border)] bg-[#f1faff] text-[12px] text-[var(--text-primary)] px-3 py-2 rounded-sm flex items-center gap-2">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#0073bb" strokeWidth={2}>
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="13" />
              <circle cx="12" cy="16" r="0.6" fill="#0073bb" />
            </svg>
            <span>
              Your account is scoped to{" "}
              <strong>{userScope.warehouses.join(", ")}</strong>. Job cards for
              other plants are hidden by the server.
            </span>
          </div>
        ) : null}

        <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] mb-5 p-3 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[220px]">
            <svg
              viewBox="0 0 24 24"
              className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search JC#, SKU, customer, batch…"
              className="w-full h-8 pl-7 pr-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#00a1c9] focus:shadow-[0_0_0_1px_#00a1c9]"
            />
          </div>
          <StatusMultiSelect
            value={statusFilter}
            onToggle={toggleStatus}
            onClear={() => changeStatus([])}
          />
        </div>

        {loading && rows.length === 0 ? (
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[var(--text-secondary)]">
            <span className="inline-flex items-center gap-2 text-[13px]">
              <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
              Loading job cards…
            </span>
          </div>
        ) : error ? (
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-8 text-center text-[var(--aws-error)] text-[13px]">
            {error}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            entity={entity}
            factory={factory}
            statusFilter={statusFilter}
            search={debouncedSearch}
            userScope={userScope}
            onClear={() => {
              // Clear all filters at once — setPage(1) only fires once
              // (React bails subsequent same-value calls).
              setEntity("");
              setFactory("");
              setStatusFilter([]);
              setSearch("");
              setPage(1);
            }}
          />
        ) : (
          <>
            {searchMeta ? (
              <div
                className={[
                  "mb-3 px-3 py-2 rounded-sm border text-[12px] flex items-center gap-2",
                  searchMeta.capped
                    ? "border-[var(--aws-error)] bg-[#fdf3f1] text-[var(--text-primary)]"
                    : "border-[var(--aws-border)] bg-[#f1faff] text-[var(--text-primary)]",
                ].join(" ")}
              >
                <span>
                  <strong>{searchMeta.total}</strong> match
                  {searchMeta.total === 1 ? "" : "es"} for &ldquo;
                  {debouncedSearch}&rdquo;
                </span>
                {searchMeta.capped ? (
                  <span className="text-[var(--aws-error)]">
                    · capped at {searchMeta.hardCap} — narrow your query for more
                  </span>
                ) : null}
              </div>
            ) : null}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {rows.map((jc) => (
                <JobCard key={jc.job_card_id} jc={jc} />
              ))}
            </div>
          </>
        )}

        {pagination.total ? (
          <div className="mt-4 bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] overflow-hidden">
            <PaginationBar
              pg={pagination}
              onPage={(p) => setPage(p)}
              loading={loading}
            />
          </div>
        ) : null}
      </main>

      <footer className="border-t border-[var(--aws-border)] bg-white py-3 px-6 text-[11px] text-[var(--text-secondary)] flex flex-wrap justify-center gap-x-4 gap-y-1">
        <a href="#" className="hover:underline">Terms of Use</a>
        <a href="#" className="hover:underline">Privacy</a>
        <span>© {new Date().getFullYear()}</span>
      </footer>
    </div>
  );
}

function JobCard({ jc }: { jc: JobCardRow }) {
  const router = useRouter();
  const status = jc.status ?? "";
  const style = STATUS_STYLES[status] ?? {
    bg: "#f4f4f4",
    fg: "#414d5c",
    ring: "#d5dbdb",
  };
  const jcNum = jc.job_card_number || `JC-${jc.job_card_id}`;
  const jcShort = shortJc(jcNum);
  // v2 returns planned_qty_kg; v1 returns batch_size_kg — accept either.
  const qty = jc.planned_qty_kg ?? jc.batch_size_kg;
  const plant = jc.factory ?? "—";
  const so = formatSo(jc.so_numbers);

  return (
    <button
      type="button"
      onClick={() => {
        // Stash the current scrollY into the cache so coming back from
        // detail lands the operator at the same row they clicked, not at
        // the top of the list. The cache row data was already saved by
        // the last successful fetch.
        patchListCache({ scrollY: typeof window !== "undefined" ? window.scrollY : 0 });
        router.push(`/modules/job-card/${jc.job_card_id}`);
      }}
      className="text-left bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-4 hover:border-[var(--aws-navy)] hover:shadow-[0_2px_6px_rgba(0,28,36,0.18)] transition focus:outline-none focus:border-[#00a1c9] focus:shadow-[0_0_0_2px_#00a1c9]"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <span
          className="font-mono text-[12px] font-semibold text-[var(--aws-link)] truncate"
          title={jcNum}
        >
          {jcShort}
        </span>
        <span
          className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-sm capitalize whitespace-nowrap"
          style={{
            background: style.bg,
            color: style.fg,
            border: `1px solid ${style.ring}`,
          }}
        >
          {fmtStatus(status) || "—"}
        </span>
      </div>

      <div
        className="text-[14px] font-semibold text-[var(--text-primary)] truncate"
        title={jc.fg_sku_name ?? ""}
      >
        {jc.fg_sku_name || "—"}
      </div>
      <div
        className="text-[12px] text-[var(--text-secondary)] truncate mb-3"
        title={jc.customer_name ?? ""}
      >
        {jc.customer_name || "—"}
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
        <Meta label="Plant" value={plant} />
        <Meta label="Floor" value={jc.floor || "—"} />
        <Meta label="Stage" value={jc.stage || "—"} />
        <Meta label="Qty" value={fmtBatch(qty)} />
        <Meta label="Assigned" value={jc.assigned_to_team_leader || "—"} />
        <Meta label="SO" value={so.display} title={so.tooltip} />
      </dl>
    </button>
  );
}

function ChipGroup({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] uppercase tracking-wide text-[var(--text-secondary)] font-semibold mr-1">
        {label}
      </span>
      {options.map((opt) => (
        <button
          key={opt.value || "all"}
          onClick={() => onChange(opt.value)}
          className={[
            "h-7 px-3 text-[12px] rounded-full border transition-colors",
            value === opt.value
              ? "bg-[var(--aws-navy)] text-white border-[var(--aws-navy)]"
              : "bg-white text-[var(--text-primary)] border-[var(--aws-border-strong)] hover:border-[var(--aws-navy)]",
          ].join(" ")}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function EmptyState({
  entity,
  factory,
  statusFilter,
  search,
  userScope,
  onClear,
}: {
  entity: string;
  factory: string;
  statusFilter: string[];
  search: string;
  userScope: { isAdmin: boolean; warehouses: string[] };
  onClear: () => void;
}) {
  const active: string[] = [];
  if (entity) active.push(`entity=${entity}`);
  if (factory) active.push(`plant=${factory}`);
  if (statusFilter.length) active.push(`status=${statusFilter.join(",")}`);
  if (search) active.push(`search="${search}"`);
  const hasFilters = active.length > 0;

  // If the user is scoped to specific factories AND they're filtering to a
  // factory outside that scope, the server returned 0 rows because of the
  // scope intersection — flag that explicitly.
  const factoryOutOfScope =
    factory &&
    !userScope.isAdmin &&
    userScope.warehouses.length > 0 &&
    !userScope.warehouses.includes(factory);

  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[var(--text-secondary)]">
      <p className="font-semibold text-[14px] mb-1">No job cards found</p>
      {factoryOutOfScope ? (
        <p className="text-[12px] text-[var(--aws-error)] mb-2">
          Plant <strong>{factory}</strong> is outside your assignment (
          {userScope.warehouses.join(", ")}). Ask an admin to add the plant to
          your account.
        </p>
      ) : hasFilters ? (
        <p className="text-[12px] mb-2">
          No job cards match: <span className="font-mono">{active.join(" · ")}</span>
        </p>
      ) : !userScope.isAdmin && userScope.warehouses.length > 0 ? (
        <p className="text-[12px] mb-2">
          No job cards on the plants assigned to you (
          {userScope.warehouses.join(", ")}).
        </p>
      ) : (
        <p className="text-[12px] mb-2">There are no job cards yet.</p>
      )}
      {hasFilters ? (
        <button
          onClick={onClear}
          className="mt-2 h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]"
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
}

function Meta({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  // Override the tooltip when the visible value is an elided summary (e.g.
  // SO "ABC +2" → tooltip "ABC, DEF, GHI"). Defaults to `value` otherwise.
  title?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="uppercase tracking-wide font-semibold text-[var(--text-muted)] text-[10px]">
        {label}
      </dt>
      <dd
        className="text-[12px] text-[var(--text-primary)] truncate"
        title={title ?? value}
      >
        {value}
      </dd>
    </div>
  );
}

function StatusMultiSelect({
  value,
  onToggle,
  onClear,
}: {
  value: string[];
  onToggle: (s: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);
  const label =
    value.length === 0
      ? "All Statuses"
      : value.length === 1
        ? STATUS_OPTIONS.find((o) => o.value === value[0])?.label ?? value[0]
        : `${value.length} statuses`;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="h-8 px-3 text-[13px] bg-white border border-[var(--aws-border-strong)] rounded-[2px] hover:border-[var(--aws-navy)] flex items-center gap-2"
      >
        <span>{label}</span>
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open ? (
        <div
          className={[
            // Positioning: on small viewports the toolbar wraps the trigger
            // to its own row at the left edge, so anchor LEFT and let the
            // panel extend right; from sm+ the trigger sits at the right of
            // the toolbar so anchor RIGHT and let it extend left. Either
            // way, `max-w-[calc(100vw-1rem)]` keeps the panel inside the
            // viewport — when 220px would overflow it breaks below the
            // edge into the narrower wrapped width.
            "absolute z-10 mt-1 w-[220px] max-w-[calc(100vw-1rem)]",
            "left-0 sm:left-auto sm:right-0",
            // Long status lists scroll vertically rather than running off
            // the bottom of the viewport.
            "max-h-[60vh] overflow-y-auto",
            "bg-white border border-[var(--aws-border)] rounded-md shadow-[0_4px_12px_rgba(0,28,36,0.18)] p-1",
          ].join(" ")}
        >
          {STATUS_OPTIONS.map((opt) => {
            const selected = value.includes(opt.value);
            return (
              <label
                key={opt.value}
                className="flex items-center gap-2 px-2 py-1.5 text-[13px] hover:bg-[#f4f4f4] rounded-sm cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => onToggle(opt.value)}
                  className="accent-[var(--aws-orange)]"
                />
                {opt.label}
              </label>
            );
          })}
          {value.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                onClear();
                setOpen(false);
              }}
              className="w-full mt-1 px-2 py-1 text-[12px] text-[var(--aws-link)] hover:underline text-left"
            >
              Clear selection
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PaginationBar({
  pg,
  onPage,
  loading,
}: {
  pg: Pagination;
  onPage: (p: number) => void;
  loading: boolean;
}) {
  const page = pg.page ?? 1;
  const totalPages = pg.total_pages ?? 1;
  const total = pg.total ?? 0;
  const pageSize = pg.page_size ?? PAGE_SIZE;
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(page * pageSize, total);

  if (totalPages <= 1) return null;

  const maxVisible = 5;
  let startPage = Math.max(1, page - Math.floor(maxVisible / 2));
  const endPage = Math.min(totalPages, startPage + maxVisible - 1);
  if (endPage - startPage + 1 < maxVisible) {
    startPage = Math.max(1, endPage - maxVisible + 1);
  }

  const pageNums: number[] = [];
  for (let i = startPage; i <= endPage; i++) pageNums.push(i);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-t border-[var(--aws-border)] bg-[var(--surface-subtle)]">
      <span className="text-[12px] text-[var(--text-secondary)]">
        Showing {start}–{end} of {total} job cards
      </span>
      <div className="flex items-center gap-1">
        <PageBtn disabled={page <= 1 || loading} onClick={() => onPage(page - 1)} ariaLabel="Previous">
          ‹
        </PageBtn>
        {startPage > 1 ? (
          <>
            <PageBtn onClick={() => onPage(1)}>{1}</PageBtn>
            {startPage > 2 ? <span className="px-1 text-[#879596]">…</span> : null}
          </>
        ) : null}
        {pageNums.map((p) => (
          <PageBtn key={p} active={p === page} onClick={() => onPage(p)}>
            {p}
          </PageBtn>
        ))}
        {endPage < totalPages ? (
          <>
            {endPage < totalPages - 1 ? <span className="px-1 text-[#879596]">…</span> : null}
            <PageBtn onClick={() => onPage(totalPages)}>{totalPages}</PageBtn>
          </>
        ) : null}
        <PageBtn disabled={page >= totalPages || loading} onClick={() => onPage(page + 1)} ariaLabel="Next">
          ›
        </PageBtn>
      </div>
    </div>
  );
}

function PageBtn({
  children,
  onClick,
  disabled,
  active,
  ariaLabel,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={[
        "min-w-[28px] h-7 px-2 text-[12px] rounded-sm border",
        active
          ? "bg-[var(--aws-navy)] text-white border-[var(--aws-navy)]"
          : "bg-white text-[var(--text-primary)] border-[var(--aws-border-strong)] hover:border-[var(--aws-navy)]",
        disabled ? "opacity-50 cursor-not-allowed hover:border-[var(--aws-border-strong)]" : "",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
