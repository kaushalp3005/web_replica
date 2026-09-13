"use client";

// Stock adjustment ledger — the audit view.
//
// Read-only. stocktake_transactions blocks UPDATE and DELETE at the database
// level, so there is nothing to edit here; a correction is a new balancing row
// posted from the adjust screen.
//
// Two reads back this page, and they share one filter set on the server:
//   • the table  — paged, 200 per page
//   • the export — every matching row, unpaginated, as .xlsx
// That sharing is the point. An export filtered differently from the screen it
// was launched from would hand someone a spreadsheet that disagrees with what
// they were reading, and nothing on the file would reveal it.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { BackLink } from "@/components/BackLink";
import { useRequireAuth, useUserInitial, useHasPermission } from "@/lib/user";
import {
  downloadLedgerExcel,
  fetchLedger,
  fetchStockTakeFilterOptions,
  formatNumber,
  type LedgerFilters,
  type LedgerPage,
  type StockOperation,
  type StockTypeName,
  verifyAdjustments,
  type StockTakeFilterOptions,
} from "@/lib/stock-take";

const PAGE_SIZE = 200;

const FIELD =
  "h-9 w-full px-3 text-[14px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]";
const LABEL = "block text-[12px] font-medium text-[var(--text-primary)] mb-1";
const CELL = "border border-[var(--aws-border)] px-3 py-2 text-center";

/** ISO timestamp -> "03 Sep 2026, 14:32" in the reader's own zone. */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())} ${M[d.getMonth()]} ${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** useSearchParams forces a client bailout, which Next 16 refuses to prerender
 *  outside a Suspense boundary. Same split as the adjust screen. */
export default function LedgerPageRoute() {
  return (
    <Suspense fallback={<p className="p-6 text-[13px] text-[var(--text-secondary)]">Loading…</p>}>
      <LedgerScreen />
    </Suspense>
  );
}

function LedgerScreen() {
  const router = useRouter();
  const initial = useUserInitial();
  useRequireAuth(router.replace);
  const canView = useHasPermission("stock_take");
  // A separate action from `create`: the stock_take role posts adjustments and
  // stock_take_verification signs them off, so nobody approves their own work.
  const canVerify = useHasPermission("stock_take", null, null, "verify");
  const [verifying, setVerifying] = useState(false);
  const params = useSearchParams();

  const [options, setOptions] = useState<StockTakeFilterOptions | null>(null);
  const [warehouse, setWarehouse] = useState(params.get("warehouse") ?? "");
  const [location, setLocation] = useState(params.get("floor") ?? "");
  // Two article filters, and they ask different questions. `itemName` is one
  // article exactly — it only arrives by deep link (?item=), and is shown as a
  // removable line so nobody is left wondering why the screen is narrow.
  // `itemSearch` is the box, a substring.
  const [itemName, setItemName] = useState(params.get("item") ?? "");
  const [itemSearch, setItemSearch] = useState(params.get("q") ?? "");
  const [stockType, setStockType] = useState<"" | StockTypeName>("");
  const [operation, setOperation] = useState<"" | StockOperation>("");
  const [mode, setMode] = useState<"range" | "day">("range");
  const [day, setDay] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const [data, setData] = useState<LedgerPage | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const filters: LedgerFilters = useMemo(() => ({
    warehouse: warehouse || undefined,
    location: location || undefined,
    itemName: itemName || undefined,
    itemSearch: itemSearch || undefined,
    stockType: stockType || undefined,
    operation: operation || undefined,
    date: mode === "day" ? (day || undefined) : undefined,
    dateFrom: mode === "range" ? (from || undefined) : undefined,
    dateTo: mode === "range" ? (to || undefined) : undefined,
  }), [warehouse, location, itemName, itemSearch, stockType, operation, mode, day, from, to]);

  useEffect(() => {
    if (!canView) return;
    const c = new AbortController();
    fetchStockTakeFilterOptions(c.signal).then(setOptions).catch(() => {});
    return () => c.abort();
  }, [canView]);

  const reqId = useRef(0);
  const load = useCallback((signal?: AbortSignal) => {
    const id = ++reqId.current;
    fetchLedger({ ...filters, page, pageSize: PAGE_SIZE }, signal).then(
      (d) => { if (id === reqId.current) { setData(d); setError(null); } },
      (e: Error) => {
        if (id !== reqId.current || e.name === "AbortError") return;
        setError(e.message); setData(null);
      },
    );
  }, [filters, page]);

  useEffect(() => {
    if (!canView) return;
    const c = new AbortController();
    load(c.signal);
    return () => c.abort();
  }, [load, canView]);

  // Derived, so no setState runs inside an effect body.
  const loading = !data && !error;

  /** Any filter change invalidates the page number — page 3 of the old result
   *  set is meaningless against the new one. Applied at the event. */
  function change(fn: () => void) { fn(); setPage(1); setData(null); setError(null); }

  // A sign-off is per DAY — one row per article/place/day carries it — so a
  // range filter has no single day to sign. Rather than quietly signing today
  // while a range is on screen, the button names the day it will act on.
  const verifyDay = mode === "day" && day ? day : "";

  async function onVerify() {
    setVerifying(true); setNote(null); setError(null);
    try {
      // Sign off exactly what is on screen: the day and place currently
      // filtered. Sending no day would default to today, which is not
      // necessarily the day being looked at.
      const res = await verifyAdjustments({
        day: verifyDay || undefined,
        warehouse: warehouse || undefined,
        floorName: location || undefined,
      });
      setNote(res.verified_count === 0
        ? "Nothing left to verify — every adjustment in view is already signed off."
        : `Verified ${res.verified_count} adjustment${res.verified_count === 1 ? "" : "s"} as ${res.verified_by}.`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Verify failed");
    } finally {
      setVerifying(false);
    }
  }

  async function onExport() {
    setBusy(true); setNote(null); setError(null);
    try {
      const rows = await downloadLedgerExcel(filters);
      setNote(`Downloaded ${formatNumber(rows, 0)} transaction${rows === 1 ? "" : "s"}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setBusy(false);
    }
  }

  const rows = data?.transactions ?? [];
  const net = rows.reduce((s, t) => s + (t.operation === "ADDITION" ? 1 : -1) * (t.qty_kg ?? 0), 0);

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
          <span className="text-white">Transactions</span>
        </nav>
        <div className="flex-1" />
        <button onClick={() => router.push("/modules/profile")} aria-label="Open profile"
                className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]">
          {initial}
        </button>
      </header>

      <main className="flex-1 max-w-[1400px] w-full mx-auto px-4 sm:px-6 py-6">
        <div className="mb-3"><BackLink parentHref="/modules/stock-take" label="stock take" /></div>

        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">Stock transactions</h1>
            <p className="text-[13px] text-[var(--text-secondary)] mt-1">
              Every addition and subtraction recorded between physical counts. Entries are final — a correction is a new balancing entry.
            </p>
          </div>
          {canVerify && (
            <button onClick={onVerify} disabled={verifying || !canView}
                    title={verifyDay
                      ? `Sign off every adjustment on ${verifyDay}${warehouse ? ` in ${warehouse}` : ""}${location ? ` · ${location}` : ""}`
                      : "Sign off today's adjustments. Pick a single day above to sign off a different one."}
                    className="h-9 px-4 rounded-[2px] border border-[#1d7324] text-[#1d7324] text-[14px] font-medium disabled:opacity-40 hover:bg-[#f0f7f0]">
              {verifying ? "Verifying…" : verifyDay ? `Verify ${verifyDay}` : "Verify today"}
            </button>
          )}
          <button onClick={onExport} disabled={busy || !canView}
                  className="h-9 px-4 rounded-[2px] bg-[var(--aws-orange)] text-white text-[14px] font-medium disabled:opacity-40 hover:bg-[var(--aws-orange-hover)]">
            {busy ? "Preparing…" : "Download Excel"}
          </button>
        </div>

        {!canView && (
          <section className="bg-white border border-[var(--aws-border)] rounded-md p-6 mb-4 text-[13px] text-[var(--text-secondary)]">
            You don&rsquo;t have access to the Stock Take module. Ask an administrator for the Stock Take role.
          </section>
        )}
        {note && <section className="bg-white border border-[#1d7324] rounded-md p-3 mb-4 text-[13px] text-[#1d7324]">{note}</section>}
        {error && <section className="bg-white border border-[#d13212] rounded-md p-4 mb-4 text-[13px] text-[#d13212]">{error}</section>}

        <section className="bg-white border border-[var(--aws-border)] rounded-md p-4 mb-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
            <div>
              <label className={LABEL} htmlFor="w">Warehouse</label>
              <select id="w" className={FIELD} value={warehouse} onChange={(e) => change(() => setWarehouse(e.target.value))}>
                <option value="">All warehouses</option>
                {(options?.warehouses ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            <div>
              <label className={LABEL} htmlFor="f">Floor</label>
              <select id="f" className={FIELD} value={location} onChange={(e) => change(() => setLocation(e.target.value))}>
                <option value="">All floors</option>
                {(options?.floors ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            <div>
              <label className={LABEL} htmlFor="i">Article</label>
              <input id="i" className={FIELD} value={itemSearch} placeholder="Search by name"
                     onChange={(e) => change(() => setItemSearch(e.target.value))} />
            </div>
            <div>
              <label className={LABEL} htmlFor="st">Stock type</label>
              <select id="st" className={FIELD} value={stockType}
                      onChange={(e) => change(() => setStockType(e.target.value as "" | StockTypeName))}>
                <option value="">Both</option>
                <option value="Fresh Stock">Fresh Stock</option>
                <option value="Off Grade/Rejection">Off Grade / Rejection</option>
              </select>
            </div>
            <div>
              <label className={LABEL} htmlFor="o">Operation</label>
              <select id="o" className={FIELD} value={operation}
                      onChange={(e) => change(() => setOperation(e.target.value as "" | StockOperation))}>
                <option value="">Both</option>
                <option value="ADDITION">Additions only</option>
                <option value="SUBTRACTION">Subtractions only</option>
              </select>
            </div>
          </div>

          {itemName && (
            <p className="mt-3 text-[12px] text-[var(--text-secondary)]">
              Showing one article exactly: <span className="font-medium text-[var(--text-primary)]">{itemName}</span>
              {" — "}
              <button onClick={() => change(() => setItemName(""))}
                      className="underline hover:text-[var(--aws-orange)]">show all articles</button>
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div className="inline-flex rounded-[2px] border border-[var(--aws-border-strong)] overflow-hidden">
              {(["range", "day"] as const).map((m) => (
                <button key={m} onClick={() => change(() => setMode(m))}
                        className={`px-3 h-9 text-[13px] ${mode === m ? "bg-[var(--aws-navy)] text-white" : "bg-white hover:bg-[#fafafa]"}`}>
                  {m === "range" ? "Date range" : "Single date"}
                </button>
              ))}
            </div>
            {mode === "day" ? (
              <div>
                <label className={LABEL} htmlFor="d">Date</label>
                <input id="d" type="date" className={FIELD} value={day} onChange={(e) => change(() => setDay(e.target.value))} />
              </div>
            ) : (
              <>
                <div>
                  <label className={LABEL} htmlFor="df">From</label>
                  <input id="df" type="date" className={FIELD} value={from} onChange={(e) => change(() => setFrom(e.target.value))} />
                </div>
                <div>
                  <label className={LABEL} htmlFor="dt">To</label>
                  <input id="dt" type="date" className={FIELD} value={to} onChange={(e) => change(() => setTo(e.target.value))} />
                </div>
                <p className="text-[11px] text-[var(--text-muted)] pb-2">Either end may be left blank.</p>
              </>
            )}
            <div className="flex-1" />
            <button onClick={() => change(() => {
              setWarehouse(""); setLocation(""); setItemName(""); setItemSearch("");
              setStockType(""); setOperation("");
              setDay(""); setFrom(""); setTo("");
            })} className="h-9 px-3 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] hover:border-[var(--aws-orange)]">
              Clear filters
            </button>
          </div>
        </section>

        {data && (
          <p className="text-[13px] text-[var(--text-secondary)] mb-2">
            {formatNumber(data.pagination.total, 0)} transaction{data.pagination.total === 1 ? "" : "s"} match.
            {" "}Net on this page:{" "}
            <span className={`font-medium ${net > 0 ? "text-[#1d7324]" : net < 0 ? "text-[#a8500a]" : ""}`}>
              {net > 0 ? "+" : ""}{formatNumber(net)} kg
            </span>
            {data.pagination.total > data.pagination.page_size && " — the Excel download covers every matching row, not just this page."}
          </p>
        )}

        {/* Desktop: bordered grid. */}
        <div className="hidden md:block bg-white border border-[var(--aws-border)] rounded-md overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px] border-collapse">
              <thead>
                <tr className="bg-[#fafafa]">
                  {["Txn", "When", "Warehouse", "Floor", "Article", "Stock type", "Units", "Qty (kg)", "Reason", "By", "Verified"].map((h) => (
                    <th key={h} scope="col" className={`${CELL} font-semibold text-[var(--text-primary)] whitespace-nowrap`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan={11} className="px-3 py-8 text-center text-[var(--text-secondary)]">Loading…</td></tr>}
                {!loading && rows.length === 0 && (
                  <tr><td colSpan={10} className="px-3 py-8 text-center text-[var(--text-secondary)]">No transactions match these filters.</td></tr>
                )}
                {rows.map((t) => (
                  <tr key={t.txn_id} className="hover:bg-[#fafafa]">
                    <td className={`${CELL} text-[var(--text-muted)] whitespace-nowrap tabular-nums`}>
                      #{t.txn_code}
                      {t.is_reversal && <div className="text-[10px] text-[var(--text-secondary)]">reverses #{t.reverses_txn_code}</div>}
                    </td>
                    <td className={`${CELL} whitespace-nowrap`}>{formatWhen(t.created_at)}</td>
                    <td className={CELL}>{t.warehouse}</td>
                    <td className={CELL}>{t.location}</td>
                    <td className={`${CELL} text-[var(--text-primary)]`}>{t.item_name}</td>
                    <td className={`${CELL} whitespace-nowrap`}>
                      <span className={`text-[11px] px-1.5 py-0.5 rounded-sm ${
                        t.stock_type === "Fresh Stock" ? "bg-[#eaf6ec] text-[#1d7324]" : "bg-[#fdf0e6] text-[#a8500a]"}`}>
                        {t.stock_type}
                      </span>
                    </td>
                    <td className={`${CELL} tabular-nums`}>{formatNumber(t.units ?? 0, 0)}</td>
                    <td className={`${CELL} tabular-nums font-medium ${t.operation === "ADDITION" ? "text-[#1d7324]" : "text-[#a8500a]"}`}>
                      {t.operation === "ADDITION" ? "+" : "−"}{formatNumber(t.qty_kg ?? 0)}
                    </td>
                    <td className={CELL}>{t.reason}</td>
                    <td className={`${CELL} whitespace-nowrap text-[var(--text-secondary)]`}>{t.created_by}</td>
                    <td className={`${CELL} whitespace-nowrap`}>
                      {t.verified ? (
                        <span className="text-[#1d7324]" title={t.verified_at ? `${t.verified_by} · ${formatWhen(t.verified_at)}` : undefined}>
                          ✓ {t.verified_by}
                        </span>
                      ) : (
                        <span className="text-[var(--aws-orange)]">Not verified</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Mobile: one card per transaction. */}
        <div className="md:hidden space-y-3">
          {loading && <p className="text-[13px] text-[var(--text-secondary)] py-6 text-center">Loading…</p>}
          {!loading && rows.length === 0 && (
            <p className="text-[13px] text-[var(--text-secondary)] py-6 text-center">No transactions match these filters.</p>
          )}
          {rows.map((t) => (
            <div key={`m-${t.txn_id}`} className="bg-white border border-[var(--aws-border)] rounded-md p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[14px] font-medium text-[var(--text-primary)]">{t.item_name}</p>
                  <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">{t.warehouse} · {t.location}</p>
                </div>
                <span className={`text-[15px] font-semibold shrink-0 tabular-nums ${t.operation === "ADDITION" ? "text-[#1d7324]" : "text-[#a8500a]"}`}>
                  {t.operation === "ADDITION" ? "+" : "−"}{formatNumber(t.qty_kg ?? 0)} kg
                </span>
              </div>
              <p className="text-[12px] text-[var(--text-secondary)] mt-2">{t.reason}</p>
              <p className="text-[11px] text-[var(--text-muted)] mt-2">
                #{t.txn_code}{t.is_reversal && ` · reverses #${t.reverses_txn_code}`} · {formatWhen(t.created_at)} · {t.created_by}
              </p>
            </div>
          ))}
        </div>

        {data && data.pagination.total_pages > 1 && (
          <div className="bg-white border border-[var(--aws-border)] rounded-md mt-3 flex items-center justify-between gap-3 px-3 py-2 text-[12px] text-[var(--text-secondary)]">
            <span>Page {data.pagination.page} of {data.pagination.total_pages} · {PAGE_SIZE} per page</span>
            <span className="flex gap-2">
              <button onClick={() => { setPage((p) => Math.max(1, p - 1)); setData(null); }}
                      disabled={data.pagination.page <= 1}
                      className="h-7 px-3 rounded-[2px] border border-[var(--aws-border-strong)] bg-white disabled:opacity-40 hover:border-[var(--aws-orange)]">Previous</button>
              <button onClick={() => { setPage((p) => p + 1); setData(null); }}
                      disabled={data.pagination.page >= data.pagination.total_pages}
                      className="h-7 px-3 rounded-[2px] border border-[var(--aws-border-strong)] bg-white disabled:opacity-40 hover:border-[var(--aws-orange)]">Next</button>
            </span>
          </div>
        )}
      </main>

      <footer className="border-t border-[var(--aws-border)] bg-white py-3 px-6 text-[11px] text-[var(--text-secondary)] flex justify-center gap-4">
        <a href="#" className="hover:underline">Privacy</a>
        <span>© {new Date().getFullYear()}</span>
      </footer>
    </div>
  );
}
