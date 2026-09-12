"use client";

// Adjust stock — the operator's working screen.
//
// Shape: pick where you are (from YOUR profile access), see the stock that is
// actually there, and hit + or − on the row you are changing. Picking an article
// out of a catalogue first was the wrong default — on a floor you are almost
// always adjusting something already counted, and the row already carries the
// classification, so the catalogue picker is reserved for the genuinely new
// article case behind an explicit button.
//
// Rows come from /latest-stock, which is netted: counted at the last count plus
// adjustments posted since. So the "Current" column is what the operator should
// be reconciling against, not the raw count.
//
// Warehouse and floor come from /scope, which derives them from the token — an
// empty grant means "no restriction" (auth_schema.sql:35), so an unrestricted
// user is offered every location stock exists at rather than being locked out.
//
// Every post is FINAL: stocktake_transactions blocks UPDATE and DELETE at the
// database level. Corrections are new balancing rows.

import { Fragment, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { BackLink } from "@/components/BackLink";
import { useRequireAuth, useUserInitial, useHasPermission } from "@/lib/user";
import { lookupSku, type SkuLookupResponse } from "@/lib/so";
import {
  createStockTransaction,
  fetchLatestStock,
  fetchStockTakeScope,
  formatDate,
  formatNumber,
  fetchStockBalance,
  listStockTransactions,
  verifyAdjustments,
  type LatestStockResponse,
  type StockTakeItem,
  type StockOperation,
  type StockTakeScope,
  type StockTransaction,
} from "@/lib/stock-take";

/** Identity of one table row — item plus stock type, the same pair the aggregate
 *  groups on. Fresh Stock and Off Grade/Rejection are separate rows. */
const rowKey = (i: { item_name: string; stock_type: string }) => `${i.item_name}|${i.stock_type}`;

/** "2026-09-03T14:32:10+00:00" -> "03 Sep, 14:32", in the reader's own zone. */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())} ${M[d.getMonth()]}, ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const PAGE_SIZE = 200;

const FIELD =
  "h-9 w-full px-3 text-[14px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] disabled:bg-[#f5f5f5] disabled:text-[var(--text-secondary)]";
const LABEL = "block text-[12px] font-medium text-[var(--text-primary)] mb-1";

/** all_sku.particulars has NO UNIQUE constraint and 23 names are genuinely
 *  duplicated (same text, different sku_id — a re-imported block), so every list
 *  built from the catalogue must be deduped before it becomes React keys.
 *  Rendering them raw produced "two children with the same key" for each one.
 *  Selection is unaffected: choose() resolves by particulars and the server
 *  already picks a single sku_id for an ambiguous name. */
const uniq = (xs?: string[]): string[] => Array.from(new Set(xs ?? []));

/** What the dialog is acting on — an existing row, or a brand-new article. */
interface Target {
  item_name: string;
  material_type: string;
  item_category: string;
  item_subcategory: string;
  stock_type: string;
  sku_id: number | null;
  is_new_article: boolean;
  /** Netted current stock, so an overdraw can be warned about. Null when new. */
  available_kg: number | null;
}

/** useSearchParams() forces a client-side bailout, and Next 16 refuses to
 *  prerender a page containing one unless it sits under a Suspense boundary
 *  ("missing-suspense-with-csr-bailout"). The other pages in this app that read
 *  search params are dynamic [id] routes, so they never hit this — a static
 *  route like /modules/stock-take/adjust does. Hence the split: this default
 *  export supplies the boundary, and the real screen is the inner component. */
export default function StockAdjustPage() {
  return (
    <Suspense fallback={<p className="p-6 text-[13px] text-[var(--text-secondary)]">Loading…</p>}>
      <StockAdjustScreen />
    </Suspense>
  );
}

function StockAdjustScreen() {
  const router = useRouter();
  const initial = useUserInitial();
  useRequireAuth(router.replace);
  // `create`, not `view`: this page exists to post adjustments, so read-only
  // access to it would be a form whose only button 403s.
  const canPost = useHasPermission("stock_take", null, null, "create");
  // A different action from `create` on purpose: whoever posts an adjustment
  // must not be the one who signs it off. See 108_stock_take_verification_role.sql.
  const canVerify = useHasPermission("stock_take", null, null, "verify");
  const [verifyBusy, setVerifyBusy] = useState<string | null>(null);

  // Deep link from the stock list's row arrow: ?item=&stockType=&warehouse=&floor=
  // The article is a FOCUS, not a filter on the request — the list is still
  // fetched for the whole location so the operator keeps their bearings, and the
  // banner offers a way out.
  const params = useSearchParams();
  const focusItem = params.get("item") ?? "";
  const focusStockType = params.get("stockType") ?? "";
  const linkWarehouse = params.get("warehouse") ?? "";
  const linkFloor = params.get("floor") ?? "";

  const [scope, setScope] = useState<StockTakeScope | null>(null);
  const [scopeErr, setScopeErr] = useState<string | null>(null);
  const [warehouse, setWarehouse] = useState("");
  const [location, setLocation] = useState("");

  const [data, setData] = useState<LatestStockResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // Per-row transaction breakdown. Netting collapses several postings into one
  // number, which hides "I entered 10 twice" — so each row can be expanded to
  // show the individual entries behind its Adjusted figure.
  const [expanded, setExpanded] = useState<string | null>(null);
  const [txns, setTxns] = useState<Record<string, StockTransaction[]>>({});
  const [txnBusy, setTxnBusy] = useState<string | null>(null);

  // Floors of the SELECTED warehouse. Before this the Floor list held every
  // warehouse's floors at once, so someone on W202 was offered A185's areas and
  // the server rejected the post. Falls back to the flat list when the server is
  // an older build that does not send the per-warehouse map.
  const floorOptions = useMemo<string[]>(() => {
    if (!scope) return [];
    const byWh = scope.floors_by_warehouse;
    if (!byWh) return scope.floors;
    if (!warehouse) return scope.floors;
    return byWh[warehouse] ?? [];
  }, [scope, warehouse]);

  const [target, setTarget] = useState<Target | null>(null);
  const [operation, setOperation] = useState<StockOperation>("ADDITION");
  const [showNew, setShowNew] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  // ── Scope ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!canPost) return;
    const c = new AbortController();
    fetchStockTakeScope(c.signal).then(
      (s) => {
        setScope(s);
        // A linked warehouse/floor wins, but only if the caller may actually use
        // it — the server would reject anything else, so offering it would just
        // produce a 403 on submit.
        const wh = s.warehouses.find((w) => w.toUpperCase() === linkWarehouse.toUpperCase().replace(/-/g, ""));
        const pinnedWh = wh ?? (s.warehouses.length === 1 ? s.warehouses[0] : "");
        if (pinnedWh) setWarehouse(pinnedWh);
        // Resolve the floor within the warehouse that was actually pinned, so a
        // deep link cannot select a floor belonging to a different building.
        const inWh = (pinnedWh ? s.floors_by_warehouse?.[pinnedWh] : undefined) ?? s.floors;
        const fl = inWh.find((f) => f.trim().toUpperCase() === linkFloor.trim().toUpperCase());
        if (fl) setLocation(fl);
        else if (pinnedWh && inWh.length === 1) setLocation(inWh[0]);
      },
      (e: Error) => { if (e.name !== "AbortError") setScopeErr(e.message); },
    );
    return () => c.abort();
    // The link params are real dependencies: arriving from a different row must
    // re-resolve which warehouse/floor gets pinned, not reuse the first one.
  }, [linkWarehouse, linkFloor, canPost]);

  // ── Stock at the chosen place ────────────────────────────────────────────
  const reqId = useRef(0);
  const load = useCallback((signal?: AbortSignal) => {
    if (!warehouse || !location) return;
    const id = ++reqId.current;
    // No setState before the fetch — `loading` is derived below instead, so this
    // effect never cascades a render (react-hooks/set-state-in-effect).
    fetchLatestStock(
      { warehouse: [warehouse], floorName: [location], pageSize: PAGE_SIZE, sortBy: "itemName", sortOrder: "asc" },
      signal,
    ).then(
      (d) => { if (id === reqId.current) { setData(d); setError(null); } },
      (e: Error) => {
        if (id !== reqId.current || e.name === "AbortError") return;
        setError(e.message); setData(null);
      },
    );
  }, [warehouse, location]);

  useEffect(() => {
    const c = new AbortController();
    load(c.signal);
    return () => c.abort();
  }, [load]);

  // Derived, not tracked: a place is chosen but no data has arrived and nothing
  // failed. Changing warehouse/floor clears `data`, which flips this back on.
  const loading = Boolean(warehouse && location && !data && !error);

  // A focus narrows to exactly one article (name + stock type, the row's real
  // identity); the search box narrows by substring. Focus is dismissible.
  const [focusCleared, setFocusCleared] = useState(false);
  const focused = Boolean(focusItem) && !focusCleared;

  const rows = useMemo(() => {
    const all = data?.items ?? [];
    if (focused) {
      const n = focusItem.trim().toUpperCase();
      return all.filter((i) =>
        i.item_name.trim().toUpperCase() === n
        && (!focusStockType || i.stock_type === focusStockType));
    }
    const q = search.trim().toUpperCase();
    return q ? all.filter((i) => i.item_name.toUpperCase().includes(q)) : all;
  }, [data, search, focused, focusItem, focusStockType]);

  function toggleExpand(item: StockTakeItem) {
    const key = rowKey(item);
    if (expanded === key) { setExpanded(null); return; }
    setExpanded(key);
    if (txns[key]) return;
    setTxnBusy(key);
    listStockTransactions({ warehouse, location, itemName: item.item_name, pageSize: 200 })
      .then(
        (r) => setTxns((prev) => ({
          ...prev,
          // The ledger endpoint filters by item and place but not by stock type,
          // so the split is applied here — otherwise a Fresh row would show the
          // Off Grade postings too.
          [key]: r.transactions.filter((t) => t.stock_type === item.stock_type),
        })),
        () => setTxns((prev) => ({ ...prev, [key]: [] })),
      )
      .finally(() => setTxnBusy(null));
  }

  /** Adopt the existing line when the picked article is already stocked here.
   *
   *  ASKS THE SERVER rather than scanning `rows`. `rows` is the filtered,
   *  first-page view — narrowed by the search box and by a ?item= deep link, and
   *  capped at PAGE_SIZE — so a local scan reports "new" for any article the
   *  user is not currently looking at. GET /balance answers for exactly one
   *  article + stock type + place, which is the same identity the server's
   *  upsert uses: UPPER(BTRIM(item_name)) plus stock_type.
   *
   *  Getting this wrong was never destructive — the upsert merges the posting
   *  either way — but it left the overdraw guard inert and recorded
   *  "new article" in the ledger for something counted here for months.
   *
   *  On failure the pick still proceeds: an unreachable balance lookup is not a
   *  reason to block an adjustment, and the server merges correctly regardless. */
  async function reconcile(t: Target): Promise<Target> {
    if (!warehouse || !location) return t;
    try {
      const bal = await fetchStockBalance({
        itemName: t.item_name, stockType: t.stock_type,
        warehouse, location,
      });
      if (bal.uncounted && bal.available_kg === 0) return t;
      return {
        ...t,
        is_new_article: false,
        // What makes the overdraw guard work on an appended article.
        available_kg: bal.available_kg,
      };
    } catch {
      return t;
    }
  }

  function openFor(item: StockTakeItem, op: StockOperation) {
    setTarget({
      item_name: item.item_name,
      material_type: item.item_type ?? "",
      item_category: item.item_category ?? "",
      item_subcategory: item.item_subcategory ?? "",
      stock_type: item.stock_type,
      sku_id: null,
      is_new_article: false,
      available_kg: item.total_weight,
    });
    setOperation(op);
  }

  // No permission is just another reason the form cannot open, so it rides the
  // branch that already exists rather than adding a second denial path.
  async function onVerifyRow(it: StockTakeItem) {
    const key = rowKey(it);
    setVerifyBusy(key); setFlash(null); setError(null);
    try {
      const res = await verifyAdjustments({
        warehouse, floorName: location,
        itemName: it.item_name, stockType: it.stock_type,
      });
      setFlash(res.verified_count === 0
        ? `${it.item_name} was already signed off.`
        : `Verified ${it.item_name} — ${res.verified_count} row${res.verified_count === 1 ? "" : "s"} as ${res.verified_by}.`);
      // Re-read rather than patching local state: the sign-off lives on the
      // adjustment row, and the expanded breakdown reads it back from there.
      load();
      if (expanded === key) { setExpanded(null); }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Verify failed");
    } finally {
      setVerifyBusy(null);
    }
  }

  const blocked = !canPost || (scope && !scope.can_post);

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-6 gap-4">
        <BrandMark />
        <span className="text-[#d5dbdb] text-[13px] hidden sm:inline">Console</span>
        <nav className="text-[12px] text-[#d5dbdb] hidden md:flex items-center gap-2 ml-2">
          <button onClick={() => router.push("/modules")} className="hover:underline">Modules</button>
          <span>/</span>
          <button onClick={() => router.push("/modules/stock-take")} className="hover:underline">Stock Take</button>
          <span>/</span>
          <span className="text-white">Adjust stock</span>
        </nav>
        <div className="flex-1" />
        <button
          onClick={() => router.push("/modules/profile")}
          aria-label="Open profile"
          className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]"
        >
          {initial}
        </button>
      </header>

      <main className="flex-1 max-w-[1280px] w-full mx-auto px-4 sm:px-6 py-6">
        <div className="mb-3"><BackLink parentHref="/modules/stock-take" label="stock take" /></div>

        <div className="mb-5">
          <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">Adjust stock</h1>
          <p className="text-[13px] text-[var(--text-secondary)] mt-1">
            Add to or subtract from the stock on your floor.{" "}
            <span className="font-medium text-[var(--text-primary)]">Entries are final</span> — to correct one, post a balancing entry.
          </p>
        </div>

        {flash && (
          <section className="bg-white border border-[#1d7324] rounded-md p-3 mb-5 text-[13px] text-[#1d7324]">{flash}</section>
        )}
        {scopeErr && (
          <section className="bg-white border border-[#d13212] rounded-md p-4 mb-5 text-[13px] text-[#d13212]">
            Couldn&rsquo;t load your access scope: {scopeErr}
          </section>
        )}

        {blocked ? (
          <section className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)]">
            {!canPost ? (
              <>You don&rsquo;t have access to post stock adjustments. Ask an administrator for the Stock Take role.</>
            ) : scope!.blocked_reason === "no_stock_data" ? (
              <>
                No stock-take locations are available on this server. Its database has no stock take
                data &mdash; check which database <code>DATABASE_URL</code> points at. This is a server
                configuration issue, not a permissions one.
              </>
            ) : scope!.blocked_reason === "no_floor_access" ? (
              <>You have no floor assigned, so a stock transaction can&rsquo;t be attributed to a location. Ask an administrator to set your floor access.</>
            ) : (
              <>You have no warehouse assigned. Ask an administrator to set your warehouse access.</>
            )}
          </section>
        ) : scope ? (
          <>
            {/* ── Where. Straight from your profile access scope. ───────────── */}
            <section className="bg-white border border-[var(--aws-border)] rounded-md p-4 mb-5">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className={LABEL} htmlFor="wh">Warehouse</label>
                  <select id="wh" className={FIELD} value={warehouse}
                          disabled={scope.warehouses.length === 1}
                          onChange={(e) => {
                            const w = e.target.value;
                            setWarehouse(w);
                            setData(null);
                            // The old floor may not exist in the new warehouse.
                            // Pin it when there is only one, else clear it —
                            // never leave a floor selected that this warehouse
                            // does not have.
                            const next = scope.floors_by_warehouse?.[w] ?? scope.floors;
                            setLocation(next.length === 1 ? next[0] : "");
                          }}>
                    <option value="">Select…</option>
                    {scope.warehouses.map((w) => <option key={w} value={w}>{w}</option>)}
                  </select>
                </div>
                <div>
                  <label className={LABEL} htmlFor="loc">Floor</label>
                  <select id="loc" className={FIELD} value={location}
                          disabled={!warehouse || floorOptions.length === 1}
                          onChange={(e) => { setLocation(e.target.value); setData(null); }}>
                    <option value="">{warehouse ? "Select…" : "Choose a warehouse first"}</option>
                    {floorOptions.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
                <div>
                  <label className={LABEL} htmlFor="q">Find an item</label>
                  <input id="q" className={FIELD} type="search" value={search}
                         onChange={(e) => setSearch(e.target.value)} placeholder="Filter the list below" />
                </div>
              </div>
              <p className="mt-2 text-[11px] text-[var(--text-muted)]">
                {!warehouse
                  ? `Your profile covers ${scope.warehouses.length} warehouse${scope.warehouses.length === 1 ? "" : "s"} — choose one to see its floors.`
                  : scope.floors_unrestricted
                    ? `No floor restriction on your profile, so all ${floorOptions.length} floor${floorOptions.length === 1 ? "" : "s"} of ${warehouse} are listed.`
                    : `From your profile access — ${floorOptions.length} floor${floorOptions.length === 1 ? "" : "s"} assigned to you in ${warehouse}.`}
              </p>
            </section>

            {focused && (
              <section className="bg-white border border-[var(--aws-orange)] rounded-md p-3 mb-3 text-[13px] flex items-center justify-between gap-3">
                <span className="text-[var(--text-primary)]">
                  Showing <span className="font-medium">{focusItem}</span>
                  {focusStockType && <> ({focusStockType})</>} only.
                </span>
                <button onClick={() => setFocusCleared(true)}
                        className="text-[12px] text-[var(--aws-orange)] hover:underline shrink-0">
                  Show all stock here
                </button>
              </section>
            )}

            {error && (
              <section className="bg-white border border-[#d13212] rounded-md p-4 mb-5 text-[13px] text-[#d13212]">{error}</section>
            )}

            {/* ── Existing stock ───────────────────────────────────────────── */}
            <div className="flex items-center justify-between gap-3 mb-2">
              <p className="text-[13px] text-[var(--text-secondary)]">
                {data?.as_of_date
                  ? <>Stock here as of <span className="font-medium text-[var(--text-primary)]">{formatDate(data.as_of_date)}</span>, including adjustments since.</>
                  : warehouse && location ? "No counted stock at this location yet." : "Choose a warehouse and floor."}
              </p>
              <button onClick={() => setShowNew(true)} disabled={!warehouse || !location}
                      className="h-8 px-3 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] disabled:opacity-40 hover:border-[var(--aws-orange)]">
                + New article
              </button>
            </div>

            <div className="bg-white border border-[var(--aws-border)] rounded-md overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-[13px] border-collapse">
                  <thead>
                    <tr className="bg-[#fafafa]">
                      {["Item", "Type", "Group", "Stock type", "Counted (kg)", "Adjusted (kg)", "Current (kg)", "Action"].map((h) => (
                        <th key={h} scope="col"
                            className="border border-[var(--aws-border)] px-3 py-2 font-semibold text-[var(--text-primary)] whitespace-nowrap text-center">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {loading && (
                      <tr><td colSpan={8} className="px-3 py-8 text-center text-[var(--text-secondary)]">Loading…</td></tr>
                    )}
                    {!loading && rows.length === 0 && (
                      <tr><td colSpan={8} className="px-3 py-8 text-center text-[var(--text-secondary)]">
                        {!warehouse || !location ? "Choose a warehouse and floor to see its stock."
                          : focused ? `${focusItem} has no stock at ${warehouse} · ${location}. Pick another floor, or use “+ New article” to record it here.`
                          : search ? `Nothing matches “${search}”. Use “+ New article” if it has never been counted here.`
                          : "No stock counted here. Use “+ New article” to record something."}
                      </td></tr>
                    )}
                    {!loading && rows.map((it) => (
                      <Fragment key={rowKey(it)}>
                      <tr className="hover:bg-[#fafafa]">
                        <td className="border border-[var(--aws-border)] px-3 py-2 text-center text-[var(--text-primary)]">{it.item_name}</td>
                        <td className="border border-[var(--aws-border)] px-3 py-2 text-center text-[var(--text-secondary)] whitespace-nowrap">{it.item_type || "—"}</td>
                        <td className="border border-[var(--aws-border)] px-3 py-2 text-center text-[var(--text-secondary)]">{it.item_category || "—"}</td>
                        <td className="border border-[var(--aws-border)] px-3 py-2 text-center whitespace-nowrap">
                          <span className={`text-[11px] px-1.5 py-0.5 rounded-sm ${
                            it.stock_type === "Fresh Stock" ? "bg-[#eaf6ec] text-[#1d7324]" : "bg-[#fdf0e6] text-[#a8500a]"}`}>
                            {it.stock_type}
                          </span>
                        </td>
                        <td className="border border-[var(--aws-border)] px-3 py-2 text-center tabular-nums text-[var(--text-secondary)]">{formatNumber(it.counted_weight)}</td>
                        <td className={`border border-[var(--aws-border)] px-3 py-2 text-center tabular-nums ${it.net_adjustment_kg > 0 ? "text-[#1d7324]" : it.net_adjustment_kg < 0 ? "text-[#a8500a]" : "text-[var(--text-muted)]"}`}>
                          {it.transaction_count > 0 ? (
                            // Netting collapses N postings into one figure. The count
                            // makes that visible and the row expands to the detail.
                            <button onClick={() => toggleExpand(it)}
                                    aria-expanded={expanded === rowKey(it)}
                                    className="inline-flex items-center gap-1 hover:underline">
                              <span aria-hidden>{expanded === rowKey(it) ? "▾" : "▸"}</span>
                              {`${it.net_adjustment_kg > 0 ? "+" : ""}${formatNumber(it.net_adjustment_kg)}`}
                              <span className="text-[10px] text-[var(--text-muted)]">
                                ({it.transaction_count} {it.transaction_count === 1 ? "entry" : "entries"})
                              </span>
                            </button>
                          ) : "—"}
                        </td>
                        <td className="border border-[var(--aws-border)] px-3 py-2 text-center tabular-nums font-medium">{formatNumber(it.total_weight)}</td>
                        <td className="border border-[var(--aws-border)] px-3 py-2">
                          <div className="flex gap-1 justify-center">
                            <button onClick={() => openFor(it, "ADDITION")} title={`Add to ${it.item_name}`}
                                    aria-label={`Add to ${it.item_name}`}
                                    className="h-7 w-7 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[#1d7324] font-bold hover:border-[#1d7324]">+</button>
                            <button onClick={() => openFor(it, "SUBTRACTION")} title={`Subtract from ${it.item_name}`}
                                    aria-label={`Subtract from ${it.item_name}`}
                                    className="h-7 w-7 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[#a8500a] font-bold hover:border-[#a8500a]">−</button>
                            {it.verified ? (
                              // The point of the indicator: before this, a
                              // successful verify changed nothing on screen, so
                              // a working button looked broken.
                              <span className="inline-flex items-center h-7 px-2 text-[11px] font-medium text-[#1d7324]"
                                    title={`Verified by ${it.verified_by ?? "—"}${it.verified_at ? ` · ${formatWhen(it.verified_at)}` : ""}`}>
                                ✓ Verified
                              </span>
                            ) : canVerify ? (
                              <button onClick={() => onVerifyRow(it)}
                                      disabled={verifyBusy === rowKey(it)}
                                      title={`Sign off ${it.item_name} here — its counted figure and any adjustments, whatever day they fall on`}
                                      aria-label={`Verify ${it.item_name}`}
                                      className="h-7 px-2 rounded-[2px] border border-[#1d7324] bg-white text-[#1d7324] text-[11px] font-medium disabled:opacity-40 hover:bg-[#f0f7f0]">
                                {verifyBusy === rowKey(it) ? "…" : "Verify"}
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>

                      {expanded === rowKey(it) && (
                        <tr className="border-b border-[var(--aws-border)] bg-[#fbfbfb]">
                          <td colSpan={8} className="px-3 py-3">
                            {txnBusy === rowKey(it) ? (
                              <p className="text-[12px] text-[var(--text-secondary)]">Loading entries…</p>
                            ) : (txns[rowKey(it)] ?? []).length === 0 ? (
                              <p className="text-[12px] text-[var(--text-secondary)]">No entries found for this item here.</p>
                            ) : (
                              <table className="w-full text-[12px]">
                                <thead>
                                  <tr className="text-[var(--text-secondary)]">
                                    <th className="text-left font-medium py-1 pr-3">Txn</th>
                                    <th className="text-left font-medium py-1 pr-3">When</th>
                                    <th className="text-right font-medium py-1 pr-3">Units</th>
                                    <th className="text-right font-medium py-1 pr-3">Qty (kg)</th>
                                    <th className="text-left font-medium py-1 pr-3">Reason</th>
                                    <th className="text-left font-medium py-1 pr-3">By</th>
                                    <th className="text-left font-medium py-1">Verified</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {(txns[rowKey(it)] ?? []).map((t) => (
                                    <tr key={t.txn_id} className="border-t border-[var(--aws-border)]">
                                      <td className="py-1 pr-3 text-[var(--text-muted)] tabular-nums">
                                        #{t.txn_code}
                                        {t.is_reversal && (
                                          <span className="ml-1 text-[10px] px-1 rounded-sm bg-[#eee] text-[var(--text-secondary)]">
                                            reverses #{t.reverses_txn_code}
                                          </span>
                                        )}
                                      </td>
                                      <td className="py-1 pr-3 whitespace-nowrap">{formatWhen(t.created_at)}</td>
                                      <td className="py-1 pr-3 text-right tabular-nums">{formatNumber(t.units ?? 0, 0)}</td>
                                      <td className={`py-1 pr-3 text-right tabular-nums font-medium ${t.operation === "ADDITION" ? "text-[#1d7324]" : "text-[#a8500a]"}`}>
                                        {t.operation === "ADDITION" ? "+" : "−"}{formatNumber(t.qty_kg ?? 0)}
                                      </td>
                                      <td className="py-1 pr-3">{t.reason}</td>
                                      <td className="py-1 pr-3 whitespace-nowrap text-[var(--text-secondary)]">{t.created_by}</td>
                                      <td className="py-1 whitespace-nowrap">
                                        {t.verified ? (
                                          <span className="text-[#1d7324]"
                                                title={t.verified_at ? `${t.verified_by} · ${formatWhen(t.verified_at)}` : undefined}>
                                            ✓ {t.verified_by}
                                          </span>
                                        ) : (
                                          <span className="text-[var(--aws-orange)]">Not verified</span>
                                        )}
                                      </td>
                                    </tr>
                                  ))}
                                  <tr className="border-t border-[var(--aws-border-strong)]">
                                    <td colSpan={3} className="py-1 pr-3 text-right font-medium">Net</td>
                                    <td className="py-1 pr-3 text-right tabular-nums font-semibold">
                                      {it.net_adjustment_kg > 0 ? "+" : ""}{formatNumber(it.net_adjustment_kg)}
                                    </td>
                                    <td colSpan={3} className="py-1 text-[var(--text-muted)]">
                                      {formatNumber(it.counted_weight)} counted → {formatNumber(it.total_weight)} current
                                    </td>
                                  </tr>
                                </tbody>
                              </table>
                            )}
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        ) : (
          <p className="text-[13px] text-[var(--text-secondary)]">Loading…</p>
        )}
      </main>

      {target && (
        <AdjustDialog
          target={target}
          operation={operation}
          warehouse={warehouse}
          location={location}
          onCancel={() => setTarget(null)}
          onPosted={(msg) => {
            // A deep link can pin the view to one article AND one stock type
            // (?item=&stockType=). Posting off grade against a Fresh-pinned view
            // writes a row that filter excludes, so the work lands and vanishes —
            // the same "nothing happened" the verify button had. Drop the focus
            // when what was just posted would not survive it.
            if (focused && focusStockType && target.stock_type !== focusStockType) {
              setFocusCleared(true);
            }
            setTarget(null); setFlash(msg);
            // The breakdown for this row is now stale; drop it so a re-expand refetches.
            setTxns((prev) => { const n = { ...prev }; delete n[rowKey(target)]; return n; });
            load();
          }}
        />
      )}

      {showNew && (
        <NewArticleDialog
          onCancel={() => setShowNew(false)}
          onPick={(t) => {
            setShowNew(false);
            setOperation("ADDITION");
            // Show the dialog immediately, then fill in the existing balance when
            // the lookup lands — waiting on a round trip before opening would
            // make every pick feel slow for the sake of one field.
            setTarget(t);
            reconcile(t).then((r) => setTarget((cur) =>
              cur && cur.item_name === t.item_name && cur.stock_type === t.stock_type ? r : cur));
          }}
        />
      )}

      <footer className="border-t border-[var(--aws-border)] bg-white py-3 px-6 text-[11px] text-[var(--text-secondary)] flex justify-center gap-4">
        <a href="#" className="hover:underline">Privacy</a>
        <span>© {new Date().getFullYear()}</span>
      </footer>
    </div>
  );
}

/** Units + quantity, and the reason the ledger requires.
 *
 *  Reason is not optional: stocktake_transactions declares it NOT NULL with a
 *  CHECK(btrim(reason) <> ''), so a blank one is rejected by the database, not
 *  merely by this form. It is kept to one line so the action stays quick. */
function AdjustDialog({ target, operation, warehouse, location, onCancel, onPosted }: {
  target: Target; operation: StockOperation; warehouse: string; location: string;
  onCancel: () => void; onPosted: (msg: string) => void;
}) {
  const [units, setUnits] = useState("");
  const [qtyKg, setQtyKg] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const qty = Number(qtyKg);
  const isSub = operation === "SUBTRACTION";
  const overdrawn = isSub && target.available_kg != null && qty > 0 && qty > target.available_kg;
  const ok = Number(units) > 0 && qty > 0 && reason.trim().length > 0 && !busy;

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const r = await createStockTransaction({
        item_name: target.item_name,
        sku_id: target.sku_id,
        is_new_article: target.is_new_article,
        material_type: target.material_type,
        item_category: target.item_category,
        item_subcategory: target.item_subcategory,
        stock_type: target.stock_type,
        units: Number(units),
        qty_kg: qty,
        operation,
        reason: reason.trim(),
        warehouse,
        location,
      });
      onPosted(
        `Transaction #${r.transaction.txn_code} posted — ${target.item_name} is now ${formatNumber(r.balance_after_kg)} kg.`
        + (r.overdrawn ? " The balance is now negative and will need reconciling." : ""),
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not post the transaction");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/45 flex items-center justify-center p-4 z-50"
         onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="bg-white rounded-md w-full max-w-[440px] p-5" role="dialog" aria-modal="true">
        <h3 className="text-[16px] font-semibold text-[var(--text-primary)]">
          {isSub ? "Subtract from" : "Add to"} stock
        </h3>
        <p className="text-[13px] text-[var(--text-primary)] mt-1">{target.item_name}</p>
        <p className="text-[12px] text-[var(--text-secondary)]">
          {[target.material_type, target.item_category, target.item_subcategory].filter(Boolean).join(" · ")}
          {" · "}
          {/* Coloured, not plain text: off grade is a different line for the same
              article, and posting to the wrong one is invisible afterwards. */}
          <span className={`px-1.5 py-0.5 rounded-sm text-[11px] ${
            target.stock_type === "Fresh Stock"
              ? "bg-[#eaf6ec] text-[#1d7324]" : "bg-[#fdf0e6] text-[#a8500a] font-medium"}`}>
            {target.stock_type}
          </span>
        </p>
        <p className="text-[12px] text-[var(--text-secondary)] mt-1">
          {warehouse} · {location}
          {target.available_kg != null && <> — currently <span className="font-medium text-[var(--text-primary)]">{formatNumber(target.available_kg)} kg</span></>}
          {target.is_new_article
            ? <> — <span className="text-[#a8500a]">new article, never counted here</span></>
            : target.available_kg != null
              ? <> — <span className="text-[#1d7324]">appending to the existing line</span></>
              : null}
        </p>

        <div className="grid grid-cols-2 gap-3 mt-4">
          <div>
            <label className={LABEL} htmlFor="u">Units</label>
            <input id="u" className={FIELD} type="number" min="0" step="any" autoFocus
                   value={units} onChange={(e) => setUnits(e.target.value)} placeholder="e.g. 12" />
          </div>
          <div>
            <label className={LABEL} htmlFor="q">Quantity (kg)</label>
            <input id="q" className={FIELD} type="number" min="0" step="any"
                   value={qtyKg} onChange={(e) => setQtyKg(e.target.value)} placeholder="e.g. 250.5" />
          </div>
        </div>

        <div className="mt-3">
          <label className={LABEL} htmlFor="r">Reason (required)</label>
          <input id="r" className={FIELD} value={reason} onChange={(e) => setReason(e.target.value)}
                 placeholder="Why is this being adjusted?" />
        </div>

        {overdrawn && (
          <p className="mt-3 text-[12px] text-[#a8500a] bg-[#fdf0e6] border border-[#a8500a] rounded-[2px] px-3 py-2">
            This subtracts {formatNumber(qty)} kg from {formatNumber(target.available_kg!)} kg. It will still be
            recorded, and the balance will go negative.
          </p>
        )}
        {err && <p className="mt-3 text-[12px] text-[#d13212]">{err}</p>}

        <p className="text-[11px] text-[var(--text-muted)] mt-3">
          Units and kg are both recorded as entered; neither is calculated from the other.
          This entry cannot be edited or deleted afterwards.
        </p>

        <div className="flex gap-2 justify-end mt-4">
          <button onClick={onCancel}
                  className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[14px]">Cancel</button>
          <button onClick={submit} disabled={!ok}
                  className="h-9 px-4 rounded-[2px] bg-[var(--aws-orange)] text-white text-[14px] font-medium disabled:opacity-40 hover:bg-[var(--aws-orange-hover)]">
            {busy ? "Posting…" : isSub ? "Post subtraction" : "Post addition"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** For stock the floor holds that has never been counted here.
 *
 *  Search and Browse mirror the legacy RTVLineEditor over /api/v1/so/sku-lookup;
 *  the third path is free entry, which RTV has no equivalent for. All four
 *  descriptors are required — the Stock Take app's own custom-item path sends
 *  blanks and its backend stamps GENERAL/OTHER over them, losing what the
 *  operator chose. */
function NewArticleDialog({ onCancel, onPick }: {
  onCancel: () => void; onPick: (t: Target) => void;
}) {
  const [tab, setTab] = useState<"search" | "browse" | "free">("search");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<string[]>([]);
  const [opts, setOpts] = useState<NonNullable<SkuLookupResponse["options"]>>({});
  const [itemType, setItemType] = useState("");
  const [group, setGroup] = useState("");
  const [sub, setSub] = useState("");
  const [free, setFree] = useState({ name: "", type: "", cat: "", sub: "" });
  const [err, setErr] = useState<string | null>(null);
  // Off grade is a SEPARATE LINE for the same article, not a property of it:
  // identity is the name plus the stock type, and 233 articles already exist as
  // both. So this picks which of the two lines the posting lands on.
  const [offGrade, setOffGrade] = useState(false);
  const stockType = offGrade ? "Off Grade/Rejection" : "Fresh Stock";

  useEffect(() => {
    if (tab !== "search" || q.trim().length < 2) return;
    const c = new AbortController();
    const t = setTimeout(() => {
      lookupSku({ search: q.trim() }, c.signal).then(
        (r) => { setHits(r.options?.particulars ?? []); setErr(null); },
        (e: Error) => { if (!c.signal.aborted) setErr(e.message); },
      );
    }, 300);
    return () => { clearTimeout(t); c.abort(); };
  }, [q, tab]);

  useEffect(() => {
    const c = new AbortController();
    lookupSku(
      { item_type: itemType || undefined, item_group: group || undefined, sub_group: sub || undefined },
      c.signal,
    ).then((r) => setOpts(r.options ?? {}), () => {});
    return () => c.abort();
  }, [itemType, group, sub]);

  // Derived rather than cleared in the effect — a short query shows nothing
  // without a setState in the guard (react-hooks/set-state-in-effect).
  const visibleHits = q.trim().length >= 2 ? uniq(hits) : [];

  async function choose(name: string) {
    const r = await lookupSku({ particulars: name });
    const s = r.selected_item;
    if (!s) return;
    onPick({
      item_name: String(s.particulars ?? "").trim(),
      material_type: String(s.item_type ?? ""),
      item_category: String(s.item_group ?? ""),
      item_subcategory: String(s.sub_group ?? ""),
      stock_type: stockType,
      sku_id: s.sku_id != null ? Number(s.sku_id) : null,
      is_new_article: false,
      available_kg: null,
    });
  }

  const freeOk = free.name.trim() && free.type.trim() && free.cat.trim() && free.sub.trim();

  return (
    <div className="fixed inset-0 bg-black/45 flex items-center justify-center p-4 z-50"
         onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="bg-white rounded-md w-full max-w-[560px] p-5" role="dialog" aria-modal="true">
        <h3 className="text-[16px] font-semibold text-[var(--text-primary)] mb-1">Add an article not in this list</h3>
        <p className="text-[12px] text-[var(--text-secondary)] mb-3">
          For stock on your floor that has never been counted here.
        </p>

        <label className="flex items-center gap-2 mb-3 text-[13px] text-[var(--text-primary)] cursor-pointer select-none">
          <input type="checkbox" checked={offGrade} onChange={(e) => setOffGrade(e.target.checked)}
                 className="h-4 w-4 accent-[#a8500a]" />
          <span>Off grade / rejection</span>
          <span className="text-[11px] text-[var(--text-secondary)]">
            — records against the article&rsquo;s off-grade line, keeping the same name
          </span>
        </label>

        <div className="inline-flex rounded-[2px] border border-[var(--aws-border-strong)] overflow-hidden mb-3">
          {(["search", "browse", "free"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
                    className={`px-3 h-8 text-[13px] ${tab === t ? "bg-[var(--aws-navy)] text-white" : "bg-white hover:bg-[#fafafa]"}`}>
              {t === "search" ? "Search" : t === "browse" ? "Browse" : "Not in catalogue"}
            </button>
          ))}
        </div>

        {err && <p className="mb-2 text-[12px] text-[#d13212]">{err}</p>}

        {tab === "search" && (
          <>
            <input className={FIELD} value={q} onChange={(e) => setQ(e.target.value)}
                   placeholder="Type at least 2 characters" aria-label="Search articles" />
            {visibleHits.length > 0 && (
              <ul className="mt-2 max-h-56 overflow-y-auto border border-[var(--aws-border)] rounded-[2px] divide-y divide-[var(--aws-border)]">
                {visibleHits.slice(0, 50).map((n) => (
                  <li key={n}>
                    <button onClick={() => choose(n)} className="w-full text-left px-3 py-2 text-[13px] hover:bg-[#fafafa]">{n}</button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {tab === "browse" && (
          <>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className={LABEL}>Material type</label>
                <select className={FIELD} value={itemType}
                        onChange={(e) => { setItemType(e.target.value); setGroup(""); setSub(""); }}>
                  <option value="">All</option>
                  {uniq(opts.item_types).map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
              <div>
                <label className={LABEL}>Category</label>
                <select className={FIELD} value={group}
                        onChange={(e) => { setGroup(e.target.value); setSub(""); }}>
                  <option value="">All</option>
                  {uniq(opts.item_groups).map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
              <div>
                <label className={LABEL}>Sub category</label>
                <select className={FIELD} value={sub} onChange={(e) => setSub(e.target.value)}>
                  <option value="">All</option>
                  {uniq(opts.sub_groups).map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
            </div>
            <div className="mt-3">
              <label className={LABEL}>Article</label>
              <select className={FIELD} value="" onChange={(e) => { if (e.target.value) void choose(e.target.value); }}>
                <option value="">Select an article…</option>
                {uniq(opts.particulars).map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          </>
        )}

        {tab === "free" && (
          <>
            <div className="mb-2">
              <label className={LABEL}>Article name</label>
              <input className={FIELD} value={free.name} onChange={(e) => setFree({ ...free, name: e.target.value })} />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className={LABEL}>Material type</label>
                <input className={FIELD} list="dl-type" value={free.type}
                       onChange={(e) => setFree({ ...free, type: e.target.value })} />
                <datalist id="dl-type">{uniq(opts.item_types).map((o) => <option key={o} value={o} />)}</datalist>
              </div>
              <div>
                <label className={LABEL}>Category</label>
                <input className={FIELD} list="dl-cat" value={free.cat}
                       onChange={(e) => setFree({ ...free, cat: e.target.value })} />
                <datalist id="dl-cat">{uniq(opts.item_groups).map((o) => <option key={o} value={o} />)}</datalist>
              </div>
              <div>
                <label className={LABEL}>Sub category</label>
                <input className={FIELD} list="dl-sub" value={free.sub}
                       onChange={(e) => setFree({ ...free, sub: e.target.value })} />
                <datalist id="dl-sub">{uniq(opts.sub_groups).map((o) => <option key={o} value={o} />)}</datalist>
              </div>
            </div>
            <p className="text-[11px] text-[var(--text-muted)] mt-2">All four are required and stored exactly as entered.</p>
          </>
        )}

        <div className="flex gap-2 justify-end mt-4">
          <button onClick={onCancel} className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[14px]">Cancel</button>
          {tab === "free" && (
            <button disabled={!freeOk}
                    onClick={() => onPick({
                      item_name: free.name.trim(), material_type: free.type.trim(),
                      item_category: free.cat.trim(), item_subcategory: free.sub.trim(),
                      stock_type: stockType, sku_id: null, is_new_article: true, available_kg: null,
                    })}
                    className="h-9 px-4 rounded-[2px] bg-[var(--aws-orange)] text-white text-[14px] font-medium disabled:opacity-40">
              Continue
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
