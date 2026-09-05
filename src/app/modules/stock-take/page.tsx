"use client";

// Stock Take module landing — read-only stock view. Each article is carried
// forward from its OWN most recent physical count, so one page spans many count
// dates; that is why every row shows when it was last counted.
//
// Rows come from `stocktake_entries`, written by the separate Stock Take app.
// This page never writes: counting, drafts, verification and the result sheet all
// stay in that app. What the console adds is a manager-facing answer to "what did
// the last count find", with the same filters the Stock Take review screens use.
//
// The "as of" date is resolved server-side UNDER the filters, so picking a
// warehouse shows that warehouse's own last count day, not a blank page for a day
// it was not counted on. The date is echoed in the header for exactly that reason.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { BackLink } from "@/components/BackLink";
import { useRequireAuth, useUserInitial, useIsAdmin } from "@/lib/user";
import {
  fetchLatestStock,
  fetchStockTakeFilterOptions,
  formatDate,
  formatNumber,
  type LatestStockResponse,
  type StockTakeFilterOptions,
} from "@/lib/stock-take";

const PAGE_SIZE = 50;

type SortKey = "itemName" | "itemType" | "category" | "totalQuantity" | "totalWeight"
  | "entryCount" | "lastCounted";

const COLUMNS: { key: SortKey | null; label: string; numeric?: boolean }[] = [
  { key: "itemName", label: "Item" },
  { key: "itemType", label: "Type" },
  { key: "category", label: "Group" },
  { key: null, label: "Stock type" },
  { key: "totalQuantity", label: "Qty", numeric: true },
  { key: null, label: "Counted (kg)", numeric: true },
  { key: null, label: "Adjusted (kg)", numeric: true },
  { key: "totalWeight", label: "Current (kg)", numeric: true },
  { key: "entryCount", label: "Entries", numeric: true },
  // Most stock here was last counted weeks ago, so the age of a figure is part
  // of the figure. Sortable, because "what am I least sure about" is a real question.
  { key: "lastCounted", label: "Last counted" },
  // Row action. No sort key — it is a link, not data.
  { key: null, label: "", numeric: false },
];

/** How a count date reads once it is weeks old.
 *
 * Deliberately not red: stale here is the NORMAL state, not an error. Most
 * articles are last counted weeks ago because that is how often a floor gets
 * counted, and colouring 1600 rows as alarms would train people to ignore it.
 * The age is stated plainly and the colour only steps back once past a month.
 */
function LastCounted({ date, days }: { date: string | null; days: number | null }) {
  if (!date) {
    return <span className="text-[11px] text-[#a8500a]">never counted</span>;
  }
  const old = days !== null && days > 30;
  return (
    <span className={`whitespace-nowrap ${old ? "text-[var(--text-muted)]" : "text-[var(--text-secondary)]"}`}>
      {formatDate(date)}
      {days !== null && (
        <span className="ml-1 text-[10px]">
          {days === 0 ? "(today)" : days === 1 ? "(1 day)" : `(${days} days)`}
        </span>
      )}
    </span>
  );
}

/** Deep-link to the adjust screen scoped to one article.
 *
 *  stock_type travels with the name because it is half the row's identity —
 *  Fresh Stock and Off Grade/Rejection are separate rows and separate balances.
 *  Warehouse/floor are only forwarded when the operator has actually filtered to
 *  one; otherwise the aggregate spans several and the adjust screen must ask. */
function adjustHref(
  it: { item_name: string; stock_type: string },
  warehouse: string,
  floorName: string,
): string {
  const p = new URLSearchParams({ item: it.item_name, stockType: it.stock_type });
  if (warehouse) p.set("warehouse", warehouse);
  if (floorName) p.set("floor", floorName);
  return `/modules/stock-take/adjust?${p}`;
}

export default function StockTakeLandingPage() {
  const router = useRouter();
  const initial = useUserInitial();
  // Call for its redirect side-effect only. Do NOT gate render on its return —
  // it is true on the server but false on the client's first paint, which would
  // cause a hydration mismatch (see inventory-ledger/page.tsx). The isAdmin gate
  // below is hydration-stable (false on server + client-first-render).
  useRequireAuth(router.replace);
  const isAdmin = useIsAdmin();

  const [data, setData] = useState<LatestStockResponse | null>(null);
  const [options, setOptions] = useState<StockTakeFilterOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [warehouse, setWarehouse] = useState("");
  const [floorName, setFloorName] = useState("");
  const [itemType, setItemType] = useState("");
  const [stockType, setStockType] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<SortKey>("totalWeight");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  // Debounce the search box so a typed word is one request, not one per keypress.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  /** Single entry point for every control that changes the query.
   *
   *  Paging and the loading flag are updated HERE, at the event, rather than in
   *  an effect reacting to the change. Two reasons: page 4 of the old result set
   *  is meaningless against the new one, and a synchronous setState inside an
   *  effect body cascades an extra render (react-hooks/set-state-in-effect). */
  function changeQuery(apply: () => void, opts: { keepPage?: boolean } = {}) {
    apply();
    if (!opts.keepPage) setPage(1);
    setLoading(true);
    setError(null);
  }

  const query = useMemo(
    () => ({
      warehouse: warehouse ? [warehouse] : undefined,
      floorName: floorName ? [floorName] : undefined,
      itemType: itemType ? [itemType] : undefined,
      stockType: stockType ? [stockType] : undefined,
      search: debouncedSearch || undefined,
      page,
      pageSize: PAGE_SIZE,
      sortBy,
      sortOrder,
    }),
    [warehouse, floorName, itemType, stockType, debouncedSearch, page, sortBy, sortOrder],
  );

  // Guards against out-of-order responses: a slow early request must not
  // overwrite the result of a later one the user is actually waiting on.
  const reqId = useRef(0);

  const load = useCallback(
    (signal: AbortSignal) => {
      // No setState before the fetch: the loading flag is raised by changeQuery at
      // the originating event, and is true on first mount by initial state.
      const id = ++reqId.current;
      fetchLatestStock(query, signal)
        .then((d) => { if (id === reqId.current) { setData(d); setError(null); } })
        .catch((e: Error) => {
          if (id === reqId.current && e.name !== "AbortError") { setError(e.message); setData(null); }
        })
        .finally(() => { if (id === reqId.current) setLoading(false); });
    },
    [query],
  );

  useEffect(() => {
    if (!isAdmin) return;
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [isAdmin, load]);

  useEffect(() => {
    if (!isAdmin) return;
    const ctrl = new AbortController();
    // Filter options failing is not worth an error banner — the dropdowns just
    // stay empty and every other control keeps working.
    fetchStockTakeFilterOptions(ctrl.signal).then(setOptions).catch(() => {});
    return () => ctrl.abort();
  }, [isAdmin]);

  function toggleSort(key: SortKey) {
    changeQuery(() => {
      if (sortBy === key) setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
      else { setSortBy(key); setSortOrder(key === "itemName" ? "asc" : "desc"); }
    });
  }

  const totals = data?.totals;
  const hasRows = (data?.items.length ?? 0) > 0;

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-6 gap-4">
        <BrandMark />
        <span className="text-[#d5dbdb] text-[13px] hidden sm:inline">Console</span>
        <nav className="text-[12px] text-[#d5dbdb] hidden md:flex items-center gap-2 ml-2">
          <button onClick={() => router.push("/modules")} className="hover:underline">Modules</button>
          <span>/</span>
          <span className="text-white">Stock Take</span>
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
          <BackLink parentHref="/modules" label="modules" />
        </div>

        {!isAdmin ? (
          <>
            <h1 className="text-[20px] font-semibold text-[var(--text-primary)] mb-3">Stock Take</h1>
            <section className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)]">
              You don&rsquo;t have access to the Stock Take module. Ask an administrator to grant you access, or switch to a different account.
            </section>
          </>
        ) : (
          <>
            <div className="mb-5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">Stock Take</h1>
              {data?.as_of_date && (
                <span className="text-[12px] font-medium px-2 py-0.5 rounded-sm bg-[#eaf3ff] text-[#9a393e]">
                  As of {formatDate(data.as_of_date)}
                </span>
              )}
              <div className="flex-1" />
              <button
                onClick={() => router.push("/modules/stock-take/adjust")}
                className="h-8 px-3 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium hover:bg-[var(--aws-orange-hover)]"
              >
                Adjust stock
              </button>
              {/* Carries the active warehouse/floor through, so the ledger opens
                  scoped to whatever the operator was already looking at. */}
              <button
                onClick={() => {
                  const p = new URLSearchParams();
                  if (warehouse) p.set("warehouse", warehouse);
                  if (floorName) p.set("floor", floorName);
                  const qs = p.toString();
                  router.push(`/modules/stock-take/transactions${qs ? `?${qs}` : ""}`);
                }}
                className="h-8 px-3 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] font-medium hover:border-[var(--aws-orange)]"
              >
                Show transactions
              </button>
              <p className="w-full text-[13px] text-[var(--text-secondary)] mt-1">
                Each article at its own most recent physical count, plus adjustments posted since that count. Counting happens in the Stock Take app; adjustments are recorded here.
              </p>
            </div>

            {/* Totals. Rendered before the table so the headline numbers survive a
                filter change without the table jumping under the cursor. */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
              {[
                { label: "Items", value: totals ? formatNumber(totals.items, 0) : "—" },
                { label: "Counted (kg)", value: totals ? formatNumber(totals.counted_weight) : "—" },
                {
                  label: "Adjustments (kg)",
                  value: totals
                    ? `${totals.net_adjustment_kg > 0 ? "+" : ""}${formatNumber(totals.net_adjustment_kg)}`
                    : "—",
                },
                { label: "Current stock (kg)", value: totals ? formatNumber(totals.total_weight) : "—" },
              ].map((s) => (
                <div key={s.label} className="bg-white border border-[var(--aws-border)] rounded-md p-4">
                  <div className="text-[11px] uppercase tracking-wide text-[var(--text-secondary)]">{s.label}</div>
                  <div className="text-[20px] font-semibold text-[var(--text-primary)] mt-1 tabular-nums">{s.value}</div>
                </div>
              ))}
            </div>

            <div className="bg-white border border-[var(--aws-border)] rounded-md mb-5 p-4 flex flex-wrap gap-3">
              <input
                type="search"
                value={search}
                onChange={(e) => changeQuery(() => setSearch(e.target.value))}
                placeholder="Search item, group, warehouse, floor"
                aria-label="Search stock take items"
                className="flex-1 min-w-[220px] h-9 px-3 text-[14px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
              />
              {([
                ["Warehouse", warehouse, setWarehouse, options?.warehouses],
                ["Floor", floorName, setFloorName, options?.floors],
                ["Type", itemType, setItemType, options?.item_types],
                ["Stock type", stockType, setStockType, options?.stock_types],
              ] as const).map(([label, value, set, opts]) => (
                <select
                  key={label}
                  value={value}
                  onChange={(e) => changeQuery(() => set(e.target.value))}
                  aria-label={label}
                  className="h-9 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e]"
                >
                  <option value="">{label}: all</option>
                  {(opts ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ))}
            </div>

            {error && (
              <section className="bg-white border border-[#d13212] rounded-md p-4 mb-5 text-[13px] text-[#d13212]">
                Couldn&rsquo;t load stock take data: {error}
              </section>
            )}

            {/* Desktop: a fully bordered grid. Hidden below md, where the card
                list below takes over — a 9-column numeric table is unusable on a
                phone no matter how much it scrolls sideways. */}
            <div className="hidden md:block bg-white border border-[var(--aws-border)] rounded-md overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-[13px] border-collapse">
                  <thead>
                    <tr className="bg-[#fafafa]">
                      {COLUMNS.map((c) => (
                        <th
                          key={c.label}
                          scope="col"
                          className="border border-[var(--aws-border)] px-3 py-2 font-semibold text-[var(--text-primary)] whitespace-nowrap text-center"
                        >
                          {c.key ? (
                            <button
                              onClick={() => toggleSort(c.key!)}
                              className="hover:text-[var(--aws-orange)] inline-flex items-center gap-1"
                              aria-label={`Sort by ${c.label}`}
                            >
                              {c.label}
                              {sortBy === c.key && <span aria-hidden>{sortOrder === "asc" ? "▲" : "▼"}</span>}
                            </button>
                          ) : c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {loading && !data && (
                      <tr><td colSpan={COLUMNS.length} className="px-3 py-8 text-center text-[var(--text-secondary)]">Loading…</td></tr>
                    )}
                    {!loading && !error && !hasRows && (
                      <tr>
                        <td colSpan={COLUMNS.length} className="px-3 py-8 text-center text-[var(--text-secondary)]">
                          {data?.as_of_date === null
                            ? "No stock take data is available. If no filters are set, the server may be pointed at a database that has no stock take tables."
                            : "No items on this page."}
                        </td>
                      </tr>
                    )}
                    {data?.items.map((it) => (
                      <tr key={`${it.item_name}|${it.stock_type}`} className="hover:bg-[#fafafa]">
                        <td className="border border-[var(--aws-border)] px-3 py-2 text-center text-[var(--text-primary)]">{it.item_name}</td>
                        <td className="border border-[var(--aws-border)] px-3 py-2 text-center text-[var(--text-secondary)] whitespace-nowrap">{it.item_type || "—"}</td>
                        <td className="border border-[var(--aws-border)] px-3 py-2 text-center text-[var(--text-secondary)]">{it.item_category || "—"}</td>
                        <td className="border border-[var(--aws-border)] px-3 py-2 text-center whitespace-nowrap">
                          <span className={`text-[11px] px-1.5 py-0.5 rounded-sm ${
                            it.stock_type === "Fresh Stock" ? "bg-[#eaf6ec] text-[#1d7324]" : "bg-[#fdf0e6] text-[#a8500a]"
                          }`}>
                            {it.stock_type}
                          </span>
                        </td>
                        <td className="border border-[var(--aws-border)] px-3 py-2 text-center tabular-nums">{formatNumber(it.total_quantity, 0)}</td>
                        <td className="border border-[var(--aws-border)] px-3 py-2 text-center tabular-nums text-[var(--text-secondary)]">{formatNumber(it.counted_weight)}</td>
                        <td className={`border border-[var(--aws-border)] px-3 py-2 text-center tabular-nums ${it.net_adjustment_kg > 0 ? "text-[#1d7324]" : it.net_adjustment_kg < 0 ? "text-[#a8500a]" : "text-[var(--text-muted)]"}`}>
                          {it.net_adjustment_kg === 0 ? "—" : `${it.net_adjustment_kg > 0 ? "+" : ""}${formatNumber(it.net_adjustment_kg)}`}
                          {it.transaction_count > 0 && (
                            <span className="ml-1 text-[10px] text-[var(--text-muted)]">({it.transaction_count})</span>
                          )}
                        </td>
                        <td className="border border-[var(--aws-border)] px-3 py-2 text-center tabular-nums font-medium">{formatNumber(it.total_weight)}</td>
                        <td className="border border-[var(--aws-border)] px-3 py-2 text-center tabular-nums text-[var(--text-secondary)]">
                          {it.entry_count === 0
                            ? <span className="text-[10px] text-[#a8500a]">not counted</span>
                            : it.entry_count}
                        </td>
                        <td className="border border-[var(--aws-border)] px-3 py-2 text-center text-[12px]">
                          <LastCounted date={it.last_counted_date} days={it.days_since_count} />
                        </td>
                        <td className="border border-[var(--aws-border)] px-2 py-2 text-center">
                          <button
                            onClick={() => router.push(adjustHref(it, warehouse, floorName))}
                            title={`Adjust ${it.item_name}`}
                            aria-label={`Adjust ${it.item_name}`}
                            className="h-7 w-7 inline-flex items-center justify-center rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[var(--aws-orange)] hover:border-[var(--aws-orange)]"
                          >
                            →
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Mobile: one card per row. The desktop grid has nine columns, six of
                them numeric — horizontally scrolling that on a phone hides exactly
                the comparison the table exists to make. */}
            <div className="md:hidden space-y-3">
              {loading && !data && (
                <p className="text-[13px] text-[var(--text-secondary)] py-6 text-center">Loading…</p>
              )}
              {!loading && !error && !hasRows && (
                <p className="text-[13px] text-[var(--text-secondary)] py-6 text-center">
                  {data?.as_of_date === null
                    ? "No stock take data is available. If no filters are set, the server may be pointed at a database that has no stock take tables."
                    : "No items on this page."}
                </p>
              )}
              {data?.items.map((it) => (
                <div key={`m-${it.item_name}|${it.stock_type}`}
                     className="bg-white border border-[var(--aws-border)] rounded-md p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[14px] font-medium text-[var(--text-primary)]">{it.item_name}</p>
                      <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">
                        {[it.item_type, it.item_category].filter(Boolean).join(" · ") || "—"}
                      </p>
                    </div>
                    <button
                      onClick={() => router.push(adjustHref(it, warehouse, floorName))}
                      title={`Adjust ${it.item_name}`}
                      aria-label={`Adjust ${it.item_name}`}
                      className="h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[var(--aws-orange)]"
                    >
                      →
                    </button>
                  </div>

                  <div className="mt-2">
                    <span className={`text-[11px] px-1.5 py-0.5 rounded-sm ${
                      it.stock_type === "Fresh Stock" ? "bg-[#eaf6ec] text-[#1d7324]" : "bg-[#fdf0e6] text-[#a8500a]"
                    }`}>
                      {it.stock_type}
                    </span>
                    {it.entry_count === 0 && (
                      <span className="ml-2 text-[10px] text-[#a8500a]">not counted</span>
                    )}
                  </div>

                  <dl className="mt-3 grid grid-cols-3 gap-2 text-[12px]">
                    <div>
                      <dt className="text-[var(--text-muted)]">Counted</dt>
                      <dd className="tabular-nums text-[var(--text-secondary)]">{formatNumber(it.counted_weight)}</dd>
                    </div>
                    <div>
                      <dt className="text-[var(--text-muted)]">Adjusted</dt>
                      <dd className={`tabular-nums ${it.net_adjustment_kg > 0 ? "text-[#1d7324]" : it.net_adjustment_kg < 0 ? "text-[#a8500a]" : "text-[var(--text-muted)]"}`}>
                        {it.net_adjustment_kg === 0
                          ? "—"
                          : `${it.net_adjustment_kg > 0 ? "+" : ""}${formatNumber(it.net_adjustment_kg)}`}
                        {it.transaction_count > 0 && (
                          <span className="ml-1 text-[10px] text-[var(--text-muted)]">({it.transaction_count})</span>
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[var(--text-muted)]">Current</dt>
                      <dd className="tabular-nums font-medium text-[var(--text-primary)]">{formatNumber(it.total_weight)}</dd>
                    </div>
                  </dl>
                  {/* Full width under the figures: on a phone the age of the count
                      matters as much as the number, and it does not fit the grid. */}
                  <p className="mt-2 text-[11px] text-[var(--text-muted)]">
                    Last counted <LastCounted date={it.last_counted_date} days={it.days_since_count} />
                  </p>
                </div>
              ))}
            </div>

            <div className="bg-white border border-[var(--aws-border)] rounded-md mt-3">
              {data && data.pagination.total_pages > 1 && (
                <div className="flex items-center justify-between gap-3 px-3 py-2 text-[12px] text-[var(--text-secondary)]">
                  <span>
                    Page {data.pagination.page} of {data.pagination.total_pages} · {formatNumber(data.pagination.total, 0)} items
                  </span>
                  <span className="flex gap-2">
                    <button
                      onClick={() => changeQuery(() => setPage((p) => Math.max(1, p - 1)), { keepPage: true })}
                      disabled={data.pagination.page <= 1 || loading}
                      className="h-7 px-3 rounded-[2px] border border-[var(--aws-border-strong)] bg-white disabled:opacity-40 hover:border-[var(--aws-orange)]"
                    >
                      Previous
                    </button>
                    <button
                      onClick={() => changeQuery(() => setPage((p) => p + 1), { keepPage: true })}
                      disabled={data.pagination.page >= data.pagination.total_pages || loading}
                      className="h-7 px-3 rounded-[2px] border border-[var(--aws-border-strong)] bg-white disabled:opacity-40 hover:border-[var(--aws-orange)]"
                    >
                      Next
                    </button>
                  </span>
                </div>
              )}
            </div>
          </>
        )}
      </main>

      <footer className="border-t border-[var(--aws-border)] bg-white py-3 px-6 text-[11px] text-[var(--text-secondary)] flex flex-wrap justify-center gap-x-4 gap-y-1">
        <a href="#" className="hover:underline">Privacy</a>
        <span>© {new Date().getFullYear()}</span>
      </footer>
    </div>
  );
}
