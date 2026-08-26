"use client";

// BOM module — one screen, one job: show every bill of materials as a single
// rolled-up row, and let an operator open any row IN PLACE to see the whole
// thing without losing their place in the list.
//
// Two structural rules this file is built around; breaking either one silently
// corrupts the screen rather than crashing it, so they are called out here:
//
//  1. bom_line and bom_process_route are NEVER nested into one another.
//     bom_header → bom_line and bom_header → bom_process_route are both real
//     FKs on bom_id, but bom_line ↔ bom_process_route share no FK and no join
//     key — they are related only through free text written by two different
//     ingest paths (bom_line.consumed_at_stage = 'Final FG (opening RM)' from
//     master_ingest.py vs bom_process_route.practical_operation =
//     'Roast & Flavour/Salt' from bar_line_service.py, and stage slugs like
//     'packing' / 'create_wip'). So the detail panel renders the lines as a
//     flat table with consumed_at_stage / process_stage as PLAIN COLUMNS, and
//     the route as its own ordered strip beside it. Any attempt to bucket
//     lines under steps would drop the unmatched ones and mis-file the rest —
//     on exactly the malformed BOMs this screen exists to find.
//
//  2. The aggregate endpoint uses LEFT JOIN LATERAL, so a BOM with zero lines
//     and/or zero route steps still comes back with zeros. The UI must honour
//     that: an expanded BOM with no children shows an explicit "No lines on
//     this BOM" / "No process route steps" row, never a blank table that reads
//     as "still loading".
//
// Detail is fetched lazily on first expand and cached in component state by
// bom_id, so collapsing and re-expanding costs nothing. Multiple rows can be
// open at once — hence a Set of ids, not a single expandedId.

import { memo, useCallback, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { BackLink } from "@/components/BackLink";
import { useRequireAuth, useUserInitial, useHasPermission, useMe } from "@/lib/user";
import { friendlyApiError } from "@/lib/apiErrors";
import {
  listBomAggregate,
  getBomDetail,
  type BomAggregateRow,
  type BomDetail,
  type BomLineRow,
  type BomPagination,
  type BomRouteStep,
} from "@/lib/bom";

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;
const DASH = "—";

// Number of columns in the collapsed grid. The expanded detail row spans all
// of them; if a column is added above, this MUST move with it or the detail
// panel stops filling the row.
const GRID_COLS = 15;

// Fully-ruled table cells, per the Transfer-IN grid precedent. This table runs
// fifteen columns of short numbers, where a missing vertical rule lets a value
// drift into its neighbour's column and be read against the wrong header.
// Requires `border-collapse` on the <table> or the rules double up.
//
// The min-width is what forces the horizontal scroll onto the WRAPPER instead
// of letting the columns compress a long FG SKU into a four-line stack that
// breaks row alignment. The wrapper also carries overflow-y + a max height so
// the sticky header has a scroll container to stick inside; without the height
// cap, `sticky top-0` has nothing to stick to and the header scrolls away with
// the page.
const GRID_WRAP = "overflow-x-auto overflow-y-auto max-h-[72vh]";
const GRID_TABLE = "w-full min-w-[1240px] text-[12px] border-collapse border border-[var(--aws-border)] bg-white";
const GRID_TD = "border border-[var(--aws-border)] px-2 py-1.5 align-middle";
const GRID_TD_NUM = `${GRID_TD} text-right font-mono tabular-nums whitespace-nowrap`;
// Sticky + its own background: with `border-collapse: collapse` the <thead>'s
// background does not paint under the cells, so the tint has to live on the th.
// The box-shadow redraws the bottom rule, which collapse drops while scrolled.
const GRID_TH_BASE =
  "border border-[var(--aws-border)] px-2 py-2 text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)] whitespace-nowrap sticky top-0 z-10 bg-[var(--surface-subtle)] shadow-[0_1px_0_var(--aws-border)]";

// Nested (detail) table — same ruling, one step lighter in padding.
const SUB_TABLE = "w-full min-w-[1400px] text-[11px] border-collapse border border-[var(--aws-border)] bg-white";
const SUB_TH =
  "border border-[var(--aws-border)] px-2 py-1.5 text-[9px] font-bold uppercase tracking-wide text-[var(--text-muted)] whitespace-nowrap bg-[var(--surface-subtle)] text-left";
const SUB_TD = "border border-[var(--aws-border)] px-2 py-1 align-top";
const SUB_TD_NUM = `${SUB_TD} text-right font-mono tabular-nums whitespace-nowrap`;
// The rowspan'd BOM-level cells get a tint + top alignment so it reads as a
// gutter describing the whole block rather than a value on the first line.
const SUB_TD_SPAN = `${SUB_TD} bg-[#fbfbfb] whitespace-nowrap text-[var(--text-secondary)]`;

type ActiveFilter = "all" | "active" | "inactive";
type ItemTypeFilter = "" | "rm" | "pm";
type EntityFilter = "" | "cfpl" | "cdpl";

// Per-BOM detail cache entry. Held in state (not a ref) so resolving a fetch
// re-renders the one row that was waiting on it.
type DetailState = { detail?: BomDetail; loading: boolean; error?: string };

export default function BomModulePage() {
  const router = useRouter();
  const initial = useUserInitial();
  // Called for its redirect side-effect; its return also gates the fetch so we
  // don't fire an authed request before the token check has run.
  const authed = useRequireAuth(router.replace);

  // `me` is null on SSR and until the cached snapshot loads (one microtask).
  // Treat that window as "resolving" rather than as a denial — otherwise the
  // access-denied panel flashes on every load. Both branches are
  // hydration-stable: server and first client paint agree on `me === null`.
  const me = useMe();
  const canView = useHasPermission("bom", null, null, "view");

  // ── Filters ──────────────────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [itemGroup, setItemGroup] = useState("");
  const [customer, setCustomer] = useState("");
  const [entity, setEntity] = useState<EntityFilter>("");
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>("all");
  const [itemType, setItemType] = useState<ItemTypeFilter>("");
  const [page, setPage] = useState(1);

  // All three free-text boxes share one debounce so typing in two of them in
  // quick succession costs one request, not two.
  const [debounced, setDebounced] = useState({ search: "", itemGroup: "", customer: "" });
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced({ search: search.trim(), itemGroup: itemGroup.trim(), customer: customer.trim() });
      // A stale page beyond the new result set would come back empty.
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search, itemGroup, customer]);

  // ── Data ─────────────────────────────────────────────────────────────────
  const [rows, setRows] = useState<BomAggregateRow[]>([]);
  const [pagination, setPagination] = useState<BomPagination>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Scalar fingerprint of the debounced text so the fetch effect isn't re-run
  // by the new object identity setDebounced hands back each tick.
  //
  // JSON.stringify, not join("|"): "|" is a legal character in every one of
  // these three values, so joining on it lets distinct filter states collide.
  // ("a|b", "c", "d") and ("a", "b", "c|d") both flatten to "a|b|c|d" — the
  // dep never changes, the effect never re-runs, and the grid keeps showing
  // the PREVIOUS filter's rows while the inputs show the new one. Stringify
  // escapes the values, so no combination can alias another.
  const textFp = JSON.stringify([debounced.search, debounced.itemGroup, debounced.customer]);

  useEffect(() => {
    if (!authed || !canView) return;
    const c = new AbortController();
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const resp = await listBomAggregate(
          {
            search: debounced.search || undefined,
            entity: entity || undefined,
            item_group: debounced.itemGroup || undefined,
            customer_name: debounced.customer || undefined,
            // Tri-state: `undefined` means "don't send the param at all", which
            // is what returns both. `false` is a real filter (inactive only),
            // so this cannot be a truthiness test.
            is_active: activeFilter === "all" ? undefined : activeFilter === "active",
            item_type: itemType || undefined,
            page,
            page_size: PAGE_SIZE,
          },
          c.signal,
        );
        if (c.signal.aborted) return;
        setRows(resp.results ?? []);
        setPagination(resp.pagination ?? {});
      } catch (e) {
        if (c.signal.aborted) return;
        setError(friendlyApiError(e));
        setRows([]);
        setPagination({});
      } finally {
        if (!c.signal.aborted) setLoading(false);
      }
    })();
    return () => c.abort();
    // textFp is the stable stand-in for the three debounced strings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, canView, textFp, entity, activeFilter, itemType, page]);

  // ── Expansion + lazy detail cache ────────────────────────────────────────
  // A Set, not a single id: several BOMs are routinely compared side by side.
  // The cache is keyed by bom_id and deliberately outlives both pagination and
  // filter changes, so paging away and back does not refetch.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [detailCache, setDetailCache] = useState<Map<number, DetailState>>(new Map());

  const fetchDetail = useCallback(async (bomId: number) => {
    // Yield first so no setState fires synchronously inside a useEffect body
    // (react-hooks/set-state-in-effect is an error in this repo).
    await Promise.resolve();
    setDetailCache((prev) => {
      const next = new Map(prev);
      next.set(bomId, { loading: true });
      return next;
    });
    try {
      const detail = await getBomDetail(bomId);
      setDetailCache((prev) => {
        const next = new Map(prev);
        next.set(bomId, { detail, loading: false });
        return next;
      });
    } catch (e: unknown) {
      // Scoped to this one bom_id — a BOM whose detail 500s must not blank the
      // list or the other open rows.
      setDetailCache((prev) => {
        const next = new Map(prev);
        next.set(bomId, { loading: false, error: friendlyApiError(e) });
        return next;
      });
    }
  }, []);

  const expandedKey = Array.from(expanded)
    .sort((a, b) => a - b)
    .join(",");

  // Fetch on first expand only: a row is requested when it has NO cache entry
  // at all. Retry-on-failure is driven by COLLAPSING (which drops the failed
  // entry, below) rather than by testing for `error` here — because this
  // effect re-runs on every membership change, so an `error` guard re-fires
  // the request for every still-open failed row each time an UNRELATED row is
  // expanded. Three failed rows left open would then re-hammer a known-failing
  // endpoint on every toggle, and it contradicts the row's own retry hint.
  useEffect(() => {
    for (const id of expanded) {
      if (!detailCache.has(id)) void fetchDetail(id);
    }
    // Membership changes only; detailCache is this effect's own output.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedKey]);

  const onToggleExpand = useCallback((bomId: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(bomId)) {
        next.delete(bomId);
        // Collapsing a FAILED row clears it, so re-expanding refetches — this
        // is what makes "Collapse and re-expand the row to retry." true. A
        // successful entry is kept so paging away and back stays free.
        setDetailCache((prevCache) => {
          const entry = prevCache.get(bomId);
          if (!entry || !entry.error || entry.detail) return prevCache;
          const nextCache = new Map(prevCache);
          nextCache.delete(bomId);
          return nextCache;
        });
      } else {
        next.add(bomId);
      }
      return next;
    });
  }, []);

  const onPage = useCallback((p: number) => {
    setPage(p);
  }, []);

  function resetPage() {
    setPage(1);
  }

  function clearFilters() {
    setSearch("");
    setItemGroup("");
    setCustomer("");
    setEntity("");
    setActiveFilter("all");
    setItemType("");
    setPage(1);
  }

  const anyFilter =
    search !== "" ||
    itemGroup !== "" ||
    customer !== "" ||
    entity !== "" ||
    activeFilter !== "all" ||
    itemType !== "";

  // Thin progress strip: instant feedback for a filter/page click while the
  // previous result set is still on screen.
  const showRefreshBar = loading && rows.length > 0;

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <PageHeader initial={initial} onNavigate={router.push} />

      <main className="flex-1 max-w-[1400px] w-full mx-auto px-4 sm:px-6 py-6 min-w-0">
        <div className="mb-3">
          <BackLink parentHref="/modules" label="modules" />
        </div>

        <div className="mb-4 flex flex-wrap items-baseline gap-3">
          <h1 className="text-[20px] leading-[24px] font-semibold text-[var(--text-primary)]">BOM</h1>
          <p className="hidden lg:inline text-[12px] text-[var(--text-muted)]">
            One row per bill of materials · expand for lines and the process route.
          </p>
        </div>

        {!me ? (
          <Centered>Checking your access…</Centered>
        ) : !canView ? (
          <section className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)]">
            You don&rsquo;t have access to the BOM module. Ask an administrator to grant you access, or
            switch to a different account.
          </section>
        ) : (
          <>
            <FilterBar
              search={search}
              onSearch={setSearch}
              itemGroup={itemGroup}
              onItemGroup={setItemGroup}
              customer={customer}
              onCustomer={setCustomer}
              entity={entity}
              onEntity={(v) => {
                setEntity(v);
                resetPage();
              }}
              activeFilter={activeFilter}
              onActiveFilter={(v) => {
                setActiveFilter(v);
                resetPage();
              }}
              itemType={itemType}
              onItemType={(v) => {
                setItemType(v);
                resetPage();
              }}
              anyFilter={anyFilter}
              onClear={clearFilters}
            />

            <div
              aria-hidden
              className={[
                "h-0.5 rounded-full overflow-hidden transition-opacity duration-150 mb-2",
                showRefreshBar ? "opacity-100" : "opacity-0",
              ].join(" ")}
            >
              <div className="h-full bg-[var(--aws-orange)] animate-pulse" />
            </div>

            {loading && rows.length === 0 ? (
              <Centered>Loading BOMs…</Centered>
            ) : error ? (
              <Centered tone="error">{error}</Centered>
            ) : rows.length === 0 ? (
              <Centered>
                {anyFilter ? "No BOMs match your filters." : "No BOMs have been loaded yet."}
              </Centered>
            ) : (
              <>
                <div
                  aria-busy={loading}
                  className={loading ? "opacity-70 transition-opacity" : "transition-opacity"}
                >
                  <BomTable
                    rows={rows}
                    expanded={expanded}
                    detailCache={detailCache}
                    onToggleExpand={onToggleExpand}
                  />
                </div>
                <Pagination pg={pagination} onPage={onPage} loading={loading} />
              </>
            )}
          </>
        )}
      </main>

      <Footer />
    </div>
  );
}

// ── Chrome ─────────────────────────────────────────────────────────────────

function PageHeader({ initial, onNavigate }: { initial: string; onNavigate: (href: string) => void }) {
  return (
    <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-6 gap-4">
      <BrandMark />
      <span className="text-[#d5dbdb] text-[13px] hidden sm:inline">Console</span>
      <nav className="text-[12px] text-[#d5dbdb] hidden md:flex items-center gap-2 ml-2">
        <button onClick={() => onNavigate("/modules")} className="hover:underline">
          Modules
        </button>
        <span>/</span>
        <span className="text-white">BOM</span>
      </nav>
      <div className="flex-1" />
      <button
        onClick={() => onNavigate("/modules/profile")}
        aria-label="Open profile"
        title="Profile"
        className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]"
      >
        {initial}
      </button>
    </header>
  );
}

function Footer() {
  return (
    <footer className="border-t border-[var(--aws-border)] bg-white py-3 px-6 text-[11px] text-[var(--text-secondary)] flex flex-wrap justify-center gap-x-4 gap-y-1">
      <a href="#" className="hover:underline">
        Privacy
      </a>
      <span>© {new Date().getFullYear()}</span>
    </footer>
  );
}

function Centered({ children, tone }: { children: ReactNode; tone?: "error" }) {
  return (
    <div
      className={[
        "bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[13px]",
        tone === "error" ? "text-[var(--aws-error)]" : "text-[var(--text-secondary)]",
      ].join(" ")}
    >
      {children}
    </div>
  );
}

// ── Filter bar ─────────────────────────────────────────────────────────────

function FilterBar(props: {
  search: string;
  onSearch: (v: string) => void;
  itemGroup: string;
  onItemGroup: (v: string) => void;
  customer: string;
  onCustomer: (v: string) => void;
  entity: EntityFilter;
  onEntity: (v: EntityFilter) => void;
  activeFilter: ActiveFilter;
  onActiveFilter: (v: ActiveFilter) => void;
  itemType: ItemTypeFilter;
  onItemType: (v: ItemTypeFilter) => void;
  anyFilter: boolean;
  onClear: () => void;
}) {
  return (
    <div className="border-b border-[var(--aws-border)] mb-3 pb-3 flex flex-wrap items-end gap-2">
      <SearchInput value={props.search} onChange={props.onSearch} />

      <TextFilter
        label="Item group"
        value={props.itemGroup}
        onChange={props.onItemGroup}
        placeholder="e.g. Snacks"
      />
      <TextFilter
        label="Customer"
        value={props.customer}
        onChange={props.onCustomer}
        placeholder="Customer name"
      />

      <SelectFilter
        label="Entity"
        value={props.entity}
        onChange={(v) => props.onEntity(v as EntityFilter)}
        options={[
          { v: "", label: "All" },
          { v: "cfpl", label: "CFPL" },
          { v: "cdpl", label: "CDPL" },
        ]}
      />
      <SelectFilter
        label="Status"
        value={props.activeFilter}
        onChange={(v) => props.onActiveFilter(v as ActiveFilter)}
        options={[
          { v: "all", label: "All" },
          { v: "active", label: "Active" },
          { v: "inactive", label: "Inactive" },
        ]}
      />
      <SelectFilter
        label="Line type"
        value={props.itemType}
        onChange={(v) => props.onItemType(v as ItemTypeFilter)}
        options={[
          { v: "", label: "All" },
          { v: "rm", label: "Has RM" },
          { v: "pm", label: "Has PM" },
        ]}
      />

      {props.anyFilter ? (
        <button
          type="button"
          onClick={props.onClear}
          className="h-7 px-2.5 text-[11px] rounded-full border border-[var(--aws-border)] text-[var(--text-secondary)] bg-white hover:border-[var(--aws-error)] hover:text-[var(--aws-error)] flex items-center gap-1"
        >
          <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
          Clear
        </button>
      ) : null}
    </div>
  );
}

function SearchInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor="bom-search" className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)]">
        Search
      </label>
      <div className="relative min-w-[180px] sm:min-w-[220px]">
        <svg
          viewBox="0 0 24 24"
          className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          aria-hidden
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          id="bom-search"
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="FG SKU, customer…"
          className="w-full h-7 pl-7 pr-2 text-[12px] rounded-[2px] bg-white border border-[var(--aws-border)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
        />
      </div>
    </div>
  );
}

function TextFilter({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const id = `bom-filter-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)]">
        {label}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-7 w-[150px] px-2 text-[12px] rounded-[2px] bg-white border border-[var(--aws-border)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
      />
    </div>
  );
}

function SelectFilter({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { v: string; label: string }[];
}) {
  const id = `bom-select-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)]">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-[120px] px-1.5 text-[12px] rounded-[2px] bg-white border border-[var(--aws-border)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
      >
        {options.map((o) => (
          <option key={o.v || "__all"} value={o.v}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// ── Collapsed grid ─────────────────────────────────────────────────────────

function Th({ children, right }: { children: ReactNode; right?: boolean }) {
  return <th scope="col" className={`${GRID_TH_BASE} ${right ? "text-right" : "text-left"}`}>{children}</th>;
}

function BomTable({
  rows,
  expanded,
  detailCache,
  onToggleExpand,
}: {
  rows: BomAggregateRow[];
  expanded: Set<number>;
  detailCache: Map<number, DetailState>;
  onToggleExpand: (bomId: number) => void;
}) {
  return (
    <div className={GRID_WRAP}>
      <table className={GRID_TABLE}>
        <caption className="sr-only">
          Bills of materials, one row per BOM, with rolled-up line and process-route figures.
          Expand a row for its full line detail and process route.
        </caption>
        <thead>
          <tr>
            <Th>
              <span className="sr-only">Expand</span>
            </Th>
            <Th>FG SKU</Th>
            <Th>Customer</Th>
            <Th right>Ver</Th>
            <Th>Active</Th>
            <Th>Entity</Th>
            <Th>Item group</Th>
            <Th right>Pack size</Th>
            <Th right>RM</Th>
            <Th right>PM</Th>
            <Th right>Lines</Th>
            <Th right>Σ Qty</Th>
            <Th right>Steps</Th>
            <Th right>Σ Std min</Th>
            <Th right>Loss %</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <BomRow
              key={row.bom_id}
              row={row}
              isOpen={expanded.has(row.bom_id)}
              state={detailCache.get(row.bom_id)}
              onToggleExpand={onToggleExpand}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// memo so a keystroke in the filter bar doesn't re-render fifty rows plus every
// open detail panel. The parent's callback is stabilised with useCallback.
const BomRow = memo(function BomRow({
  row,
  isOpen,
  state,
  onToggleExpand,
}: {
  row: BomAggregateRow;
  isOpen: boolean;
  state: DetailState | undefined;
  onToggleExpand: (bomId: number) => void;
}) {
  const label = text(row.fg_sku_name) === DASH ? `BOM ${row.bom_id}` : text(row.fg_sku_name);
  const toggle = () => onToggleExpand(row.bom_id);

  return (
    <>
      <tr
        className={[
          "cursor-pointer hover:bg-[var(--surface-subtle)]",
          isOpen ? "bg-[var(--surface-subtle)]" : "",
        ].join(" ")}
        onClick={(e) => {
          // Let the chevron's own click handler run; don't double-toggle.
          if ((e.target as HTMLElement).closest("button")) return;
          toggle();
        }}
      >
        <td className={`${GRID_TD} w-[30px] text-center`}>
          <button
            type="button"
            aria-expanded={isOpen}
            aria-label={`${isOpen ? "Collapse" : "Expand"} details for ${label}`}
            onClick={(e) => {
              e.stopPropagation();
              toggle();
            }}
            className="inline-flex items-center justify-center w-5 h-5 rounded-sm text-[var(--text-secondary)] hover:bg-white hover:text-[var(--aws-navy)]"
          >
            <svg
              viewBox="0 0 24 24"
              width="11"
              height="11"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden
              style={{ transform: isOpen ? "rotate(90deg)" : "none", transition: "transform .15s" }}
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </td>
        <td className={`${GRID_TD} max-w-[300px]`}>
          <span className="block truncate font-medium text-[var(--text-primary)]" title={label}>
            {label}
          </span>
        </td>
        <td className={`${GRID_TD} max-w-[200px]`}>
          <span className="block truncate" title={text(row.customer_name)}>
            {text(row.customer_name)}
          </span>
        </td>
        <td className={GRID_TD_NUM}>{int(row.version)}</td>
        <td className={`${GRID_TD} text-center`}>
          <ActiveChip active={row.is_active} />
        </td>
        <td className={`${GRID_TD} uppercase whitespace-nowrap`}>{text(row.entity)}</td>
        <td className={`${GRID_TD} max-w-[180px]`}>
          <span className="block truncate" title={text(row.item_group)}>
            {text(row.item_group)}
          </span>
        </td>
        <td className={GRID_TD_NUM}>{num(row.pack_size_kg, 3)}</td>
        <td className={GRID_TD_NUM}>{int(row.rm_count)}</td>
        <td className={GRID_TD_NUM}>{int(row.pm_count)}</td>
        <td className={GRID_TD_NUM}>
          {/* A zero here is the whole point of the LEFT JOIN LATERAL: a header
              with no lines is a broken BOM, not a missing row. Flag it. */}
          {toNum(row.line_count) === 0 ? (
            <span className="text-[var(--aws-error)] font-semibold" title="This BOM has no lines">
              0
            </span>
          ) : (
            int(row.line_count)
          )}
        </td>
        <td className={GRID_TD_NUM} title="Σ quantity_per_unit — mixed UOMs, indicative only">
          {num(row.total_qty_per_unit, 3)}
        </td>
        <td className={GRID_TD_NUM}>
          {toNum(row.step_count) === 0 ? (
            <span className="text-[var(--aws-error)] font-semibold" title="This BOM has no process route">
              0
            </span>
          ) : (
            int(row.step_count)
          )}
        </td>
        <td className={GRID_TD_NUM}>{num(row.total_std_time_min, 1)}</td>
        <td className={GRID_TD_NUM} title="Simple (unweighted) mean of bom_line.loss_pct">
          {pct(row.avg_line_loss_pct, 2)}
        </td>
      </tr>

      {isOpen ? (
        <tr>
          <td
            colSpan={GRID_COLS}
            className="border border-[var(--aws-border)] bg-[var(--surface-subtle)] p-0"
            style={{ borderLeft: "3px solid var(--aws-orange)" }}
          >
            <div className="px-3 py-3">
              <BomDetailPanel row={row} label={label} state={state} />
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
});

function ActiveChip({ active }: { active?: boolean | null }) {
  if (active == null) return <span className="text-[var(--text-muted)]">{DASH}</span>;
  const cls = active
    ? "text-[var(--text-success)] bg-[#eaf6ed] border-[#b6dbb1]"
    : "text-[var(--text-secondary)] bg-[var(--surface-subtle)] border-[var(--aws-border)]";
  return (
    <span className={`inline-block text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-sm border ${cls}`}>
      {active ? "Yes" : "No"}
    </span>
  );
}

// ── Expanded detail ────────────────────────────────────────────────────────

function BomDetailPanel({
  row,
  label,
  state,
}: {
  row: BomAggregateRow;
  label: string;
  state: DetailState | undefined;
}) {
  if (state?.loading) {
    return (
      <div className="py-3 text-[12px] text-[var(--text-secondary)] flex items-center justify-center gap-2">
        <span
          aria-hidden
          className="inline-block w-3 h-3 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin"
        />
        Loading BOM {row.bom_id} detail…
      </div>
    );
  }
  if (state?.error) {
    // Scoped to this row — the list and every other open row are untouched.
    return (
      <p role="alert" className="text-[var(--aws-error)] text-[12px] py-2">
        Could not load detail for {label}: {state.error} Collapse and re-expand the row to retry.
      </p>
    );
  }
  if (!state?.detail) {
    return <p className="text-[var(--text-muted)] italic text-[12px] py-2">Detail will appear here once loaded.</p>;
  }

  const { header, lines, route } = state.detail;

  return (
    <div className="flex flex-col gap-3">
      <HeaderStrip row={row} header={header} />

      <section>
        <h3 className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)] mb-1.5">
          Process route
        </h3>
        <RouteStrip steps={route} label={label} />
      </section>

      <section className="min-w-0">
        <h3 className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)] mb-1.5">
          Lines ({lines.length})
        </h3>
        <BomLinesTable row={row} header={header} lines={lines} label={label} />
      </section>
    </div>
  );
}

// Small KV strip for the header facts that don't warrant a rowspan'd column.
function HeaderStrip({ row, header }: { row: BomAggregateRow; header: Record<string, unknown> }) {
  const godowns = Array.isArray(row.distinct_godowns) ? row.distinct_godowns : [];
  const items: { k: string; v: ReactNode }[] = [
    { k: "BOM id", v: String(row.bom_id) },
    { k: "Sub group", v: text(header.sub_group ?? row.sub_group) },
    { k: "Business unit", v: text(header.business_unit) },
    { k: "Factory", v: text(header.factory) },
    { k: "Output UOM", v: text(header.output_uom ?? row.output_uom) },
    { k: "Effective", v: `${date(row.effective_from)} → ${date(row.effective_to)}` },
    { k: "Shelf life", v: text(header.shelf_life_days) },
    { k: "Process category", v: text(header.process_category) },
    { k: "Godowns", v: godowns.length ? godowns.join(", ") : DASH },
    {
      k: "Off-grade lines",
      v: row.has_offgrade_lines ? (
        <span className="text-[var(--aws-orange)] font-semibold">Yes</span>
      ) : (
        "No"
      ),
    },
    { k: "Σ Qty RM", v: num(row.total_qty_rm, 3) },
    { k: "Σ Qty PM", v: num(row.total_qty_pm, 3) },
    { k: "Route loss", v: pct(row.total_route_loss_pct, 2) },
    { k: "Other lines", v: int(row.other_count) },
  ];
  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-1.5 text-[11px]">
      {items.map((it) => (
        <div key={it.k} className="min-w-0">
          <dt className="text-[9px] uppercase tracking-wide font-bold text-[var(--text-muted)]">{it.k}</dt>
          <dd className="text-[var(--text-primary)]">{it.v}</dd>
        </div>
      ))}
    </dl>
  );
}

// The route is rendered as its own ordered strip — NOT as a parent of the
// lines. See the file header: there is no join key between the two tables.
function RouteStrip({ steps, label }: { steps: BomRouteStep[]; label: string }) {
  if (!steps.length) {
    return (
      <p className="text-[11px] italic text-[var(--text-secondary)] border border-dashed border-[var(--aws-border)] rounded-sm px-2 py-1.5 bg-white">
        No process route steps on this BOM.
      </p>
    );
  }
  return (
    <ol
      aria-label={`Process route for ${label}`}
      className="flex flex-wrap items-center gap-x-1 gap-y-1.5"
    >
      {steps.map((s, i) => {
        const name = text(s.process_name) === DASH ? text(s.practical_operation) : text(s.process_name);
        const hint = [
          text(s.stage) !== DASH ? `stage: ${text(s.stage)}` : null,
          text(s.practical_operation) !== DASH ? `operation: ${text(s.practical_operation)}` : null,
          text(s.machine_type) !== DASH ? `machine: ${text(s.machine_type)}` : null,
          toNum(s.std_time_min) != null ? `${num(s.std_time_min, 1)} min` : null,
          toNum(s.loss_pct) != null ? `loss ${pct(s.loss_pct, 2)}` : null,
        ]
          .filter((x): x is string => x != null)
          .join(" · ");
        return (
          <li key={s.route_id ?? i} className="flex items-center gap-1">
            <span
              title={hint || undefined}
              className="inline-flex items-center gap-1.5 rounded-sm border border-[var(--aws-border)] bg-white px-2 py-1"
            >
              <span className="font-mono text-[10px] text-[var(--text-muted)]">{int(s.step_number ?? i + 1)}</span>
              <span className="text-[11px] font-medium text-[var(--text-primary)]">{name}</span>
              {toNum(s.std_time_min) != null ? (
                <span className="font-mono text-[10px] text-[var(--text-muted)]">{num(s.std_time_min, 1)}m</span>
              ) : null}
            </span>
            {i < steps.length - 1 ? (
              <span aria-hidden className="text-[var(--text-muted)] text-[11px]">
                →
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

// Number of line-level columns in the nested table. Used by the "no lines"
// placeholder's colSpan; must move with the <thead> below.
const LINE_COLS = 11;

// Nested line table.
//
// WHY ROWSPAN RATHER THAN REPEATING THE VALUE
// FG SKU, customer, version, entity and pack size are properties of the BOM,
// not of any one line. Repeating them on every line row would read as though
// each material carried its own pack size, which is wrong. A spanned cell says
// "this belongs to the BOM, not the row" without a word of explanation.
//
// Rows after the first legitimately contain FEWER <td>s — the spanned cells
// from row 0 already occupy those grid slots. That is how rowspan works; it is
// not a missing cell.
function BomLinesTable({
  row,
  header,
  lines,
  label,
}: {
  row: BomAggregateRow;
  header: Record<string, unknown>;
  lines: BomLineRow[];
  label: string;
}) {
  // The zero-line case still renders one row (carrying the BOM gutter plus an
  // explicit message), so the span is at least 1.
  const n = Math.max(lines.length, 1);

  return (
    <div className="overflow-x-auto">
      <table className={SUB_TABLE}>
        <caption className="text-left text-[10px] text-[var(--text-muted)] pb-1">
          Lines for {label} — BOM-level fields span all line rows.
        </caption>
        <thead>
          <tr>
            <th scope="col" className={SUB_TH}>FG SKU</th>
            <th scope="col" className={SUB_TH}>Customer</th>
            <th scope="col" className={SUB_TH}>Ver</th>
            <th scope="col" className={SUB_TH}>Entity</th>
            <th scope="col" className={SUB_TH}>Pack size</th>
            <th scope="col" className={`${SUB_TH} text-right`}>#</th>
            <th scope="col" className={SUB_TH}>Material</th>
            <th scope="col" className={SUB_TH}>Type</th>
            <th scope="col" className={`${SUB_TH} text-right`}>Qty / unit</th>
            <th scope="col" className={SUB_TH}>UOM</th>
            <th scope="col" className={`${SUB_TH} text-right`}>Loss %</th>
            <th scope="col" className={SUB_TH}>Godown</th>
            <th scope="col" className={`${SUB_TH} text-right`}>Unit rate ₹</th>
            <th scope="col" className={SUB_TH}>Staging method</th>
            <th scope="col" className={SUB_TH}>Consumed at stage</th>
            <th scope="col" className={SUB_TH}>Process stage</th>
          </tr>
        </thead>
        <tbody>
          {lines.length === 0 ? (
            <tr>
              <BomSpanCells row={row} header={header} n={n} />
              <td colSpan={LINE_COLS} className={`${SUB_TD} italic text-[var(--text-secondary)]`}>
                No lines on this BOM.
              </td>
            </tr>
          ) : (
            lines.map((l, i) => (
              <tr key={l.bom_line_id ?? i} className="hover:bg-[var(--surface-subtle)]">
                {i === 0 ? <BomSpanCells row={row} header={header} n={n} /> : null}
                <td className={SUB_TD_NUM}>{int(l.line_number ?? i + 1)}</td>
                <td className={`${SUB_TD} max-w-[280px]`}>
                  <span className="block truncate" title={text(l.material_sku_name)}>
                    {text(l.material_sku_name)}
                  </span>
                </td>
                <td className={`${SUB_TD} uppercase whitespace-nowrap`}>
                  <ItemTypeChip value={l.item_type} />
                </td>
                <td className={SUB_TD_NUM}>{num(l.quantity_per_unit, 4)}</td>
                <td className={`${SUB_TD} whitespace-nowrap`}>{text(l.uom)}</td>
                <td className={SUB_TD_NUM}>{pct(l.loss_pct, 2)}</td>
                <td className={`${SUB_TD} whitespace-nowrap`}>{text(l.godown)}</td>
                <td className={SUB_TD_NUM}>{num(l.unit_rate_inr, 2)}</td>
                <td className={`${SUB_TD} whitespace-nowrap`}>{text(l.staging_method)}</td>
                {/* consumed_at_stage and process_stage are FREE TEXT from the
                    master ingest. They are shown as plain columns and are never
                    used to bucket a line under a route step — the two tables
                    share no vocabulary. */}
                <td className={`${SUB_TD} max-w-[220px]`}>
                  <span className="block truncate" title={text(l.consumed_at_stage)}>
                    {text(l.consumed_at_stage)}
                  </span>
                </td>
                <td className={`${SUB_TD} max-w-[200px]`}>
                  <span className="block truncate" title={text(l.process_stage)}>
                    {text(l.process_stage)}
                  </span>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// The five BOM-level cells, emitted once on the first line row with rowSpan={n}.
// Kept as one fragment component so the zero-line placeholder row and the
// mapped rows can never drift apart in column count.
function BomSpanCells({
  row,
  header,
  n,
}: {
  row: BomAggregateRow;
  header: Record<string, unknown>;
  n: number;
}) {
  return (
    <>
      <td className={`${SUB_TD_SPAN} max-w-[260px]`} rowSpan={n}>
        <span className="block truncate font-medium text-[var(--text-primary)]" title={text(row.fg_sku_name)}>
          {text(row.fg_sku_name)}
        </span>
      </td>
      <td className={`${SUB_TD_SPAN} max-w-[180px]`} rowSpan={n}>
        <span className="block truncate" title={text(row.customer_name)}>
          {text(row.customer_name)}
        </span>
      </td>
      <td className={`${SUB_TD_SPAN} text-right font-mono tabular-nums`} rowSpan={n}>
        {int(header.version ?? row.version)}
      </td>
      <td className={`${SUB_TD_SPAN} uppercase`} rowSpan={n}>
        {text(header.entity ?? row.entity)}
      </td>
      <td className={`${SUB_TD_SPAN} text-right font-mono tabular-nums`} rowSpan={n}>
        {num(header.pack_size_kg ?? row.pack_size_kg, 3)}
      </td>
    </>
  );
}

function ItemTypeChip({ value }: { value?: string | null }) {
  const t = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!t) return <span className="text-[var(--text-muted)]">{DASH}</span>;
  const cls =
    t === "rm"
      ? "text-[#1d8102] bg-[#eaf6ed] border-[#b6dbb1]"
      : t === "pm"
        ? "text-[#0972d3] bg-[#f1faff] border-[#b8dcf0]"
        : "text-[var(--text-secondary)] bg-[var(--surface-subtle)] border-[var(--aws-border)]";
  return (
    <span className={`inline-block text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-sm border ${cls}`}>
      {t}
    </span>
  );
}

// ── Pagination ─────────────────────────────────────────────────────────────

function Pagination({
  pg,
  onPage,
  loading,
}: {
  pg: BomPagination;
  onPage: (p: number) => void;
  loading: boolean;
}) {
  const page = pg.page ?? 1;
  const totalPages = pg.total_pages ?? 1;
  const total = pg.total ?? 0;
  const pageSize = pg.page_size ?? PAGE_SIZE;
  if (totalPages <= 1) return null;
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(page * pageSize, total);

  const maxVisible = 5;
  let startPage = Math.max(1, page - Math.floor(maxVisible / 2));
  const endPage = Math.min(totalPages, startPage + maxVisible - 1);
  if (endPage - startPage + 1 < maxVisible) {
    startPage = Math.max(1, endPage - maxVisible + 1);
  }
  const pageNums: number[] = [];
  for (let i = startPage; i <= endPage; i++) pageNums.push(i);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-1 py-2 text-[11px]">
      <span className="text-[var(--text-secondary)]">
        Showing {start}–{end} of {total} BOMs
      </span>
      <div className="flex items-center gap-1">
        <PageBtn disabled={page <= 1 || loading} onClick={() => onPage(page - 1)} aria="Previous page">
          ‹
        </PageBtn>
        {startPage > 1 ? (
          <>
            <PageBtn onClick={() => onPage(1)}>{1}</PageBtn>
            {startPage > 2 ? <span className="px-1 text-[var(--text-muted)]">…</span> : null}
          </>
        ) : null}
        {pageNums.map((p) => (
          <PageBtn key={p} active={p === page} onClick={() => onPage(p)}>
            {p}
          </PageBtn>
        ))}
        {endPage < totalPages ? (
          <>
            {endPage < totalPages - 1 ? <span className="px-1 text-[var(--text-muted)]">…</span> : null}
            <PageBtn onClick={() => onPage(totalPages)}>{totalPages}</PageBtn>
          </>
        ) : null}
        <PageBtn disabled={page >= totalPages || loading} onClick={() => onPage(page + 1)} aria="Next page">
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
  aria,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  aria?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={aria}
      aria-current={active ? "page" : undefined}
      className={[
        "min-w-[24px] h-6 px-1.5 text-[11px] rounded-sm border",
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

// ── Coercion + formatters ──────────────────────────────────────────────────
//
// Every NUMERIC column and every SUM()/AVG() over one arrives from asyncpg as a
// Decimal, and lands on the wire as either a JSON number or a string depending
// on the serializer. So nothing here may assume `typeof v === "number"`, and
// `header` is a `Record<string, unknown>` with no narrowing at all — hence the
// `unknown` parameter types rather than `any`.

function toNum(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Free-form value → display string, `—` when empty/absent. */
function text(v: unknown): string {
  if (v == null) return DASH;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : DASH;
  if (Array.isArray(v)) {
    const parts = v.map((x) => (x == null ? "" : String(x))).filter((x) => x !== "");
    return parts.length ? parts.join(", ") : DASH;
  }
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? DASH : t;
  }
  return DASH;
}

function int(v: unknown): string {
  const n = toNum(v);
  if (n == null) return DASH;
  return Math.round(n).toLocaleString("en-IN");
}

function num(v: unknown, dp: number): string {
  const n = toNum(v);
  if (n == null) return DASH;
  return n.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: dp });
}

function pct(v: unknown, dp: number): string {
  const n = toNum(v);
  // NULL is not zero here: a BOM with no lines has no average line loss, and
  // rendering that as "0.00%" would claim a loss-free BOM.
  if (n == null) return DASH;
  return `${n.toFixed(dp)}%`;
}

/** `YYYY-MM-DD` (or an ISO timestamp) → `DD Mon YYYY`. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function date(v: unknown): string {
  if (typeof v !== "string") return DASH;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
  if (!m) return v.trim() || DASH;
  const mon = MONTHS[Number(m[2]) - 1];
  if (!mon) return v.trim();
  return `${m[3]} ${mon} ${m[1]}`;
}
