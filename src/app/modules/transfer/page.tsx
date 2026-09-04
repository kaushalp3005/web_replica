"use client";

// Inter-Unit Transfer dashboard — replica of the production 5-tab transfer
// dashboard (server_replica/data/transfer-module-docs/01-transfer-dashboard.md).
// Phase 1: lists + stat cards + per-tab search/warehouse filter + pagination +
// delete actions + navigation. The ChallanHoverCard and PendingTransfersModal
// are layered in by P6 (this file exposes the `pendingOpen` state they hook).

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth, useMe, useUserScope } from "@/lib/user";
import { TransferChrome } from "./_chrome";
import {
  TransferApi,
  type TransferRequest,
  type TransferListItem,
  type TransferInRecord,
  type InnerColdChallan,
} from "@/lib/transfer";
import { ChallanHoverCard, type HoverLine } from "./_ChallanHoverCard";
import { PendingTransfersModal } from "./_PendingTransfersModal";
import { transferHoverData, transferInHoverData } from "./_hoverData";
import { ALL_WAREHOUSES, displayWarehouse } from "@/lib/warehouses";

const PER_PAGE = 15;
// Requests stay a bulk fetch: the set is small and the Pending stat card counts
// across the WHOLE set, not the filtered page.
const FILTER_FETCH_SIZE = 500;
// Transfer Out / Transfer In / Incoming are server-filtered and server-paginated.
// They used to pull the full set (per_page=1000, the endpoint cap) and filter in
// the browser — which silently truncated once the table passed 1000 rows, and made
// every request aggregate the whole lines/boxes tables server-side.
// Incoming Material has no pagination bar of its own, so it takes a larger page.
const INCOMING_FETCH_SIZE = 200;
// Cheapest way to read a COUNT: ask for one row and use the envelope's `total`.
// Keeps the stat cards showing the unfiltered totals while the lists are filtered.
const COUNT_ONLY = 1;
// Typing shouldn't fire a request per keystroke now that search hits the server.
const SEARCH_DEBOUNCE_MS = 350;

function normWh(s: string | null | undefined): string {
  return (s || "").trim().toLowerCase();
}
// Does `filter` match any candidate value? Splits comma-lists (a cold transfer
// may carry "Rishi, Savla D-39") and compares normalized.
function whHit(filter: string, ...vals: (string | null | undefined)[]): boolean {
  const f = normWh(filter);
  return vals.some((v) => (v || "").split(",").some((part) => normWh(part) === f));
}
// Direction-aware warehouse match: "from" checks only the source column(s),
// "to" only the destination, "all" either. "all" filter matches everything.
type WhDir = "all" | "from" | "to";
function warehouseMatchesDir(
  filter: string, dir: WhDir,
  fromVals: (string | null | undefined)[], toVals: (string | null | undefined)[],
): boolean {
  if (filter === "all") return true;
  if (dir === "from") return whHit(filter, ...fromVals);
  if (dir === "to") return whHit(filter, ...toVals);
  return whHit(filter, ...fromVals) || whHit(filter, ...toVals);
}
function searchMatch(query: string, fields: (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => (f || "").toLowerCase().includes(q));
}

// ── Date helper ──
// The range inputs are <input type="date">, so they hold ISO "YYYY-MM-DD"; the
// API's from_date/to_date take "DD-MM-YYYY" (_convert_date). Only the Transfer
// Out / Transfer In ranges are sent — Requests still filters in the browser.
function isoToDMY(iso: string): string | undefined {
  const p = (iso || "").split("-");
  return p.length === 3 ? `${p[2]}-${p[1]}-${p[0]}` : undefined;
}

// Search is a server round-trip now, so hold off until typing pauses. The input
// stays fully controlled — only the value the effects depend on is delayed.
function useDebounced<T>(value: T, ms = SEARCH_DEBOUNCE_MS): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}
// Display formatter for transfer dates: pass through DD-MM-YYYY (the backend's
// strftime format), reformat anything else, 'N/A' for empty. Mirrors the
// reference dashboard's formatDate.
function formatDate(d?: string | null): string {
  const s = (d || "").trim();
  if (!s) return "N/A";
  if (/^\d{2}-\d{2}-\d{4}$/.test(s)) return s;
  const dt = new Date(s);
  return isNaN(dt.getTime()) ? s : dt.toLocaleDateString("en-GB").replace(/\//g, "-");
}

type TabKey = "request" | "transferout" | "transferin" | "innercold" | "details";

const TABS: { key: TabKey; label: string; short: string }[] = [
  { key: "request", label: "Requests", short: "Req" },
  { key: "transferout", label: "Transfer Out", short: "Out" },
  { key: "transferin", label: "Transfer In", short: "In" },
  { key: "innercold", label: "Inner Cold", short: "Cold" },
  { key: "details", label: "All Transfers", short: "All" },
];

// ── Small presentational helpers ──────────────────────────────────────────
function StatCard({ label, value, tone, onClick }: {
  label: string; value: number | string; tone: string; onClick?: () => void;
}) {
  const clickable = !!onClick;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      className={`text-left bg-white border border-[var(--aws-border)] rounded-md p-3 shadow-[0_1px_1px_rgba(0,28,36,0.12)] ${clickable ? "hover:border-[var(--aws-navy)] cursor-pointer" : "cursor-default"}`}
    >
      <div className="text-[11px] uppercase tracking-wide text-[var(--text-secondary)]">{label}</div>
      <div className={`text-[20px] font-semibold ${tone}`}>{value}</div>
    </button>
  );
}

function PaginationBar({ page, totalPages, total, onPage }: {
  page: number; totalPages: number; total: number; onPage: (p: number) => void;
}) {
  if (totalPages <= 1) return null;
  const from = (page - 1) * PER_PAGE + 1;
  const to = Math.min(page * PER_PAGE, total);
  return (
    <div className="flex items-center justify-between mt-3 text-[12px] text-[var(--text-secondary)]">
      <span>Showing {from}-{to} of {total}</span>
      <div className="flex items-center gap-2">
        <button onClick={() => onPage(page - 1)} disabled={page <= 1}
          className="px-2 py-1 border border-[var(--aws-border)] rounded disabled:opacity-40">Prev</button>
        <span>{page}/{totalPages}</span>
        <button onClick={() => onPage(page + 1)} disabled={page >= totalPages}
          className="px-2 py-1 border border-[var(--aws-border)] rounded disabled:opacity-40">Next</button>
      </div>
    </div>
  );
}

function EmptyState({ msg }: { msg: string }) {
  return <div className="py-10 text-center text-[13px] text-[var(--text-secondary)]">{msg}</div>;
}
function LoadingSkeleton() {
  return (
    <div className="py-6 space-y-2 animate-pulse">
      {[0, 1, 2, 3].map((i) => <div key={i} className="h-8 bg-[var(--aws-border)]/40 rounded" />)}
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  Pending: "bg-amber-100 text-amber-800",
  Dispatch: "bg-sky-100 text-sky-800",
  Partial: "bg-orange-100 text-orange-800",
  Received: "bg-emerald-100 text-emerald-800",
  Completed: "bg-emerald-100 text-emerald-800",
  Rejected: "bg-rose-100 text-rose-800",
};
function StatusBadge({ status }: { status?: string | null }) {
  const s = status || "—";
  const tone = STATUS_TONE[s] || "bg-slate-100 text-slate-700";
  return <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium ${tone}`}>{s}</span>;
}

// Fully-ruled table cells. The other lists get by on row rules because they run
// five or six wide; the Transfer-IN grid carries ten columns of short strings,
// where a missing vertical rule lets a value drift into its neighbour's column.
// Requires `border-collapse` on the <table> or the rules double up.
//
// Pair with GRID_WRAP and a per-table `min-w-[…]`: the min-width forces the
// horizontal scroll on the wrapper rather than letting the columns compress
// "VAIBHAV KUMKAR" into a four-line stack that breaks row alignment.
const GRID_TABLE = "w-full text-[12px] border-collapse border border-[var(--aws-border)]";
const GRID_WRAP = "hidden md:block overflow-x-auto";
const GRID_TH = "border border-[var(--aws-border)] px-2 py-2 font-medium whitespace-nowrap";
const GRID_TD = "border border-[var(--aws-border)] px-2 py-1.5 align-middle";

// Verbatim mirrors of the sets in server_replica/app/modules/transfer/permissions.py.
// Held as named constants rather than inline `email === "..."` chains because the
// same four addresses were repeated across three gates, and the last time one of
// them gained a person (digamber.sawant@, who stands behind b.hrithik@ on every
// route in the reference backend) the inline copies here were the ones missed.
// Hrithik is listed first in each: he is the primary, Digamber the second pair of
// hands, and the ordering is the only place that distinction is recorded.
const MUTATE_EMAILS = new Set([
  "yash@candorfoods.in",
  "b.hrithik@candorfoods.in",
  "digamber.sawant@candorfoods.in",
]);
// `hrithik@` (no `b.`) is what the reference has always keyed this one gate on and
// is almost certainly stale — kept verbatim so the button matches what the API
// will actually accept. Widening it is a permissions decision, not a mirror.
const INNER_COLD_DELETE_EMAILS = new Set([
  "hrithik@candorfoods.in",
  "yash@candorfoods.in",
  "digamber.sawant@candorfoods.in",
]);

export default function TransferDashboardPage() {
  const router = useRouter();
  const allowed = useRequireAuth(router.replace);
  const me = useMe();
  const email = (me?.email || "").toLowerCase();
  // These MIRROR server_replica/app/modules/transfer/permissions.py. They were a
  // single `canDelete = email === yash`, which is neither of the three gates the
  // API actually applies: an admin got no Delete button on any tab even though
  // every one of those endpoints would have accepted the call. A hidden button
  // for an allowed action reads as a broken screen, so keep these in step.
  const roleName = (me?.role_name || "").toLowerCase();
  const isAdminUser = me?.is_admin === true;
  // assert_can_delete_request / assert_can_delete_transfer → _is_standard_mutator.
  const canDelete = isAdminUser || roleName === "admin" || roleName === "developer"
    || MUTATE_EMAILS.has(email);
  // assert_can_delete_transfer_in — stricter, and NOT satisfied by the role alone.
  const canDeleteTransferIn = isAdminUser || email === "yash@candorfoods.in";
  // assert_can_delete_inner_cold.
  const canDeleteInnerCold = isAdminUser || INNER_COLD_DELETE_EMAILS.has(email);
  const canCancel = isAdminUser || MUTATE_EMAILS.has(email);

  // Warehouse dropdown: admins filter across all sites; a scoped user only sees
  // its own warehouse(s) (and the filter is hidden entirely when there's nothing
  // to choose between — its data is already scoped server-side).
  const { isAdmin, warehouses: userWarehouses } = useUserScope();
  const warehouseOptions = isAdmin ? ALL_WAREHOUSES : userWarehouses;
  const showWarehouseFilter = isAdmin || userWarehouses.length > 1;

  // Hydration-safe: render a cache-free shell on the server/first paint, then
  // flip `mounted` so client-only data effects run (avoids SSR mismatch).
  const [mounted, setMounted] = useState(false);
  // Defer the flip past the synchronous effect body (react-hooks/set-state-in-effect),
  // matching the pattern in lib/user.ts::useRequireAuth.
  useEffect(() => { queueMicrotask(() => setMounted(true)); }, []);

  const [activeTab, setActiveTab] = useState<TabKey>("request");
  const [warehouseFilter, setWarehouseFilter] = useState("all");
  // Which column the warehouse filter applies to: From, To, or both.
  const [warehouseDir, setWarehouseDir] = useState<WhDir>("all");
  // Requests status filter — defaults to Pending; "Transferred" = accepted/done.
  const [requestStatus, setRequestStatus] = useState<"Pending" | "Transferred" | "All">("Pending");
  // Transfer-Out has 3 statuses; Transfer-In has 2. Each is an individual filter
  // (+ "all"), plus a date range. Default "all".
  const [transferStatus, setTransferStatus] = useState<"all" | "Dispatch" | "Partial" | "Received">("all");
  const [transferInStatus, setTransferInStatus] = useState<"all" | "Pending" | "Received">("all");
  const [transferDateFrom, setTransferDateFrom] = useState("");
  const [transferDateTo, setTransferDateTo] = useState("");
  const [transferInDateFrom, setTransferInDateFrom] = useState("");
  const [transferInDateTo, setTransferInDateTo] = useState("");

  // Per-tab data. Requests stay a bulk client-side set; the other four lists are
  // each a server-filtered, server-paginated page — so they carry their own
  // total_pages rather than deriving one from an array length.
  const [requests, setRequests] = useState<TransferRequest[]>([]);
  const [requestsTotal, setRequestsTotal] = useState(0);

  const [transfers, setTransfers] = useState<TransferListItem[]>([]);
  const [transfersFiltered, setTransfersFiltered] = useState(0);
  const [transfersTP, setTransfersTP] = useState(1);

  // All Transfers is deliberately UNFILTERED (parity with production), so it
  // cannot share the Transfer-Out page any more — it gets its own fetch.
  const [allTransfers, setAllTransfers] = useState<TransferListItem[]>([]);
  const [allTransfersTotal, setAllTransfersTotal] = useState(0);
  const [allTransfersTP, setAllTransfersTP] = useState(1);

  // Dispatched transfer-OUTs with no GRN started. Previously derived by
  // anti-joining the full transfers list against the full GRN list in the
  // browser; now `awaiting_grn=true` server-side, which is what makes paginating
  // those two lists safe.
  const [incoming, setIncoming] = useState<TransferListItem[]>([]);
  // The envelope's COUNT behind the same awaiting_grn filter. `incoming.length` is
  // capped at INCOMING_FETCH_SIZE, so the panel reported "Incoming Material (200)"
  // while 222 dispatches were awaiting receipt — and the surplus has no Transfer In
  // button anywhere, since the panel has no pagination bar of its own.
  const [incomingTotal, setIncomingTotal] = useState(0);

  const [transferIns, setTransferIns] = useState<TransferInRecord[]>([]);
  const [transferInsFiltered, setTransferInsFiltered] = useState(0);
  const [transferInsTP, setTransferInsTP] = useState(1);

  const [innerCold, setInnerCold] = useState<InnerColdChallan[]>([]);
  const [inTransitCount, setInTransitCount] = useState(0);

  // Stat-card totals, fetched unfiltered (per_page=1, read the envelope's
  // `total`). Kept separate from the list totals so the cards keep reporting the
  // whole set while the list below them is filtered.
  const [transfersTotal, setTransfersTotal] = useState(0);
  const [transferInsTotal, setTransferInsTotal] = useState(0);

  const [requestsPage, setRequestsPage] = useState(1);
  const [transfersPage, setTransfersPage] = useState(1);
  const [allTransfersPage, setAllTransfersPage] = useState(1);
  const [transferInsPage, setTransferInsPage] = useState(1);
  const [innerColdPage, setInnerColdPage] = useState(1);
  const [innerColdTP, setInnerColdTP] = useState(1);
  // The envelope's total, as every other list here keeps. Passing innerCold.length
  // put the two halves of "Showing X-Y of N" on different row sets: PaginationBar
  // derives `to` from `total`, so page 2 rendered "Showing 16-15 of 15".
  const [innerColdTotal, setInnerColdTotal] = useState(0);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingOpen, setPendingOpen] = useState(false);

  // Search boxes. The debounced copies are what the fetch effects depend on.
  const [requestSearch, setRequestSearch] = useState("");
  const [transferOutSearch, setTransferOutSearch] = useState("");
  const [transferInSearch, setTransferInSearch] = useState("");
  const transferOutQuery = useDebounced(transferOutSearch);
  const transferInQuery = useDebounced(transferInSearch);

  const fail = (e: unknown, fallback: string) =>
    setError(e instanceof Error ? e.message : fallback);

  // Requests are few — fetch the whole (server-scoped) set once and do status /
  // warehouse / search filtering + pagination client-side. This keeps the stat
  // cards (total + pending) stable regardless of the active status filter.
  const loadRequests = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await TransferApi.getRequests({ page: 1, per_page: FILTER_FETCH_SIZE });
      setRequests(r.records); setRequestsTotal(r.total);
    } catch (e) { fail(e, "Failed to load requests."); }
    finally { setLoading(false); }
  }, []);

  // Every filter below is a query param now, so each of these fetches exactly one
  // page. The shared filters (warehouse + direction) are spread in from one place
  // to keep the four calls consistent.
  const whParams = useMemo(() => ({
    warehouse: warehouseFilter === "all" ? undefined : warehouseFilter,
    warehouse_dir: warehouseDir,
  }), [warehouseFilter, warehouseDir]);

  const loadTransfers = useCallback(async (page: number) => {
    setLoading(true); setError(null);
    try {
      const r = await TransferApi.getTransfers({
        page, per_page: PER_PAGE, ...whParams,
        search: transferOutQuery.trim() || undefined,
        status: transferStatus === "all" ? undefined : transferStatus,
        from_date: isoToDMY(transferDateFrom), to_date: isoToDMY(transferDateTo),
      });
      setTransfers(r.records); setTransfersFiltered(r.total);
      setTransfersTP(Math.max(1, r.total_pages));
      return r.records.length;
    } catch (e) { fail(e, "Failed to load transfers."); return 0; }
    finally { setLoading(false); }
  }, [whParams, transferOutQuery, transferStatus, transferDateFrom, transferDateTo]);

  // Unfiltered by design — the All Transfers tab mirrors production, which shows
  // every record regardless of the filter bar.
  const loadAllTransfers = useCallback(async (page: number) => {
    setLoading(true); setError(null);
    try {
      const r = await TransferApi.getTransfers({ page, per_page: PER_PAGE });
      setAllTransfers(r.records); setAllTransfersTotal(r.total);
      setAllTransfersTP(Math.max(1, r.total_pages));
    } catch (e) { fail(e, "Failed to load transfers."); }
    finally { setLoading(false); }
  }, []);

  const loadIncoming = useCallback(async () => {
    setError(null);
    try {
      const r = await TransferApi.getTransfers({
        page: 1, per_page: INCOMING_FETCH_SIZE, awaiting_grn: true, ...whParams,
        search: transferInQuery.trim() || undefined,
        from_date: isoToDMY(transferInDateFrom), to_date: isoToDMY(transferInDateTo),
      });
      setIncoming(r.records); setIncomingTotal(r.total);
    } catch (e) { fail(e, "Failed to load incoming material."); }
  }, [whParams, transferInQuery, transferInDateFrom, transferInDateTo]);

  const loadTransferIns = useCallback(async (page: number) => {
    setLoading(true); setError(null);
    try {
      const r = await TransferApi.getTransferIns({
        page, per_page: PER_PAGE, ...whParams,
        search: transferInQuery.trim() || undefined,
        status: transferInStatus === "all" ? undefined : transferInStatus,
        from_date: isoToDMY(transferInDateFrom), to_date: isoToDMY(transferInDateTo),
      });
      setTransferIns(r.records); setTransferInsFiltered(r.total);
      setTransferInsTP(Math.max(1, r.total_pages));
      return r.records.length;
    } catch (e) { fail(e, "Failed to load transfer INs."); return 0; }
    finally { setLoading(false); }
  }, [whParams, transferInQuery, transferInStatus, transferInDateFrom, transferInDateTo]);

  // Stat cards report the UNFILTERED totals, so they can't read the list
  // envelopes any more. per_page=1 makes this a COUNT with one row attached.
  const loadStatTotals = useCallback(async () => {
    try {
      const [out, ins] = await Promise.all([
        TransferApi.getTransfers({ page: 1, per_page: COUNT_ONLY }),
        TransferApi.getTransferIns({ page: 1, per_page: COUNT_ONLY }),
      ]);
      setTransfersTotal(out.total); setTransferInsTotal(ins.total);
    } catch { /* keep prior totals on error */ }
  }, []);

  const loadInnerCold = useCallback(async (page: number) => {
    setLoading(true); setError(null);
    try {
      const r = await TransferApi.getInnerColdList({ page, per_page: PER_PAGE });
      setInnerCold(r.records); setInnerColdTotal(r.total);
      setInnerColdTP(r.total_pages); setInnerColdPage(page);
    } catch (e) { fail(e, "Failed to load inner cold transfers."); }
    finally { setLoading(false); }
  }, []);

  const loadInTransitCount = useCallback(async () => {
    try {
      const r = await TransferApi.getPendingStock();
      // `r.total` is len(records) in pending_service — grouped pending-stock rows, not
      // transfers. Sat beside Requests / Transfers Out / Transfers In (all true header
      // COUNTs) it read as a transfer count and was inflated by every transfer whose
      // rows disagree on company/site: 312 shown for 283 transfers actually in transit.
      // Count what the modal this card opens lists.
      setInTransitCount(new Set(r.records.map((p) => p.transfer_out_id)).size);
    } catch { /* keep prior count on error */ }
  }, []);

  const ready = mounted && allowed && isAdmin;

  // Requests (bulk) + the unfiltered stat totals, once on mount.
  useEffect(() => {
    if (!ready) return;
    queueMicrotask(() => { loadRequests(); loadStatTotals(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // In-transit count once on mount (P6 also refreshes it on pending-modal close).
  useEffect(() => {
    if (!ready) return;
    queueMicrotask(() => loadInTransitCount());
  }, [ready, loadInTransitCount]);

  // ── Server-side list fetches ──
  // Each list refetches when its own page or any of its filters change; the
  // loaders close over the filters, so a filter edit changes their identity and
  // re-runs the effect. Fetches are gated on the active tab so switching tabs
  // does not fan out four requests.
  useEffect(() => {
    if (!ready || (activeTab !== "transferout" && activeTab !== "transferin")) return;
    queueMicrotask(() => loadTransfers(transfersPage));
  }, [ready, activeTab, transfersPage, loadTransfers]);

  useEffect(() => {
    if (!ready || activeTab !== "details") return;
    queueMicrotask(() => loadAllTransfers(allTransfersPage));
  }, [ready, activeTab, allTransfersPage, loadAllTransfers]);

  useEffect(() => {
    if (!ready || activeTab !== "transferin") return;
    queueMicrotask(() => { loadTransferIns(transferInsPage); loadIncoming(); });
  }, [ready, activeTab, transferInsPage, loadTransferIns, loadIncoming]);

  useEffect(() => {
    if (!ready || activeTab !== "innercold") return;
    queueMicrotask(() => loadInnerCold(innerColdPage));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, activeTab, innerColdPage]);

  // NOTE ON PAGE RESET: changing a filter must return to page 1 — page 7 of the
  // old result set is usually past the end of the new one. That reset happens in
  // the filter CONTROLS (status buttons, DateRange, SearchBox, WarehouseSelect),
  // not in an effect here: an effect would fire the fetch once for the stale page
  // and again after the reset, doubling every request.

  // ── Client-side filtered views ──
  const filteredRequests = useMemo(() => requests.filter((r) =>
    (requestStatus === "All" || r.status === requestStatus) &&
    warehouseMatchesDir(warehouseFilter, warehouseDir, [r.from_warehouse], [r.to_warehouse]) &&
    searchMatch(requestSearch, [r.request_no, r.from_warehouse, r.to_warehouse, r.request_date, r.status])
  ), [requests, requestStatus, warehouseFilter, warehouseDir, requestSearch]);

  // Client-side pagination for the Requests tab (clamped so reducing the filter
  // never strands you on an empty page).
  const requestsTP = Math.max(1, Math.ceil(filteredRequests.length / PER_PAGE));
  const reqPage = Math.min(requestsPage, requestsTP);
  const pagedRequests = filteredRequests.slice((reqPage - 1) * PER_PAGE, reqPage * PER_PAGE);

  const pendingRequests = useMemo(
    () => requests.filter((r) => r.status === "Pending").length, [requests]);

  // Transfer Out / All / Transfer In arrive pre-filtered and pre-paged, so
  // `transfers`, `allTransfers` and `transferIns` ARE the current page. Only the
  // page number is clamped, for the window between a filter shrinking the result
  // set and the refetch landing.
  const toPage = Math.min(transfersPage, transfersTP);
  const allPage = Math.min(allTransfersPage, allTransfersTP);
  const tiPage = Math.min(transferInsPage, transferInsTP);

  // ── Delete handlers ──
  const confirmDelete = (msg: string) => typeof window !== "undefined" && window.confirm(msg);

  const onDeleteRequest = async (id: number) => {
    if (!confirmDelete("Delete this request?")) return;
    try { await TransferApi.deleteRequest(id); await loadRequests(); }
    catch (e) { fail(e, "Failed to delete request."); }
  };
  // After a server-paginated delete the current page may no longer exist (you
  // removed the only row on the last page), so step back rather than leaving an
  // empty table. The loaders return their row count for exactly this.
  const stepBackIfEmpty = (count: number, page: number, setPage: (p: number) => void) => {
    if (count === 0 && page > 1) setPage(page - 1);
  };

  const onDeleteTransfer = async (id: number) => {
    if (!confirmDelete("Delete this transfer?")) return;
    try {
      await TransferApi.deleteTransfer(id);
      stepBackIfEmpty(await loadTransfers(toPage), toPage, setTransfersPage);
      if (activeTab === "details") await loadAllTransfers(allPage);
      // The row count changed, so the unfiltered stat cards are now stale.
      await Promise.all([loadStatTotals(), loadInTransitCount()]);
    } catch (e) { fail(e, "Failed to delete transfer."); }
  };
  const onDeleteTransferIn = async (id: number) => {
    if (!confirmDelete("Delete this transfer-in?")) return;
    try {
      await TransferApi.deleteTransferIn(id);
      stepBackIfEmpty(await loadTransferIns(tiPage), tiPage, setTransferInsPage);
      // Deleting a GRN leaves its transfer-out with no receipt, so it becomes
      // Incoming Material again. That used to fall out of the client-side
      // anti-join for free; with the filter server-side it must be refetched.
      await Promise.all([loadIncoming(), loadStatTotals()]);
    } catch (e) { fail(e, "Failed to delete transfer-in."); }
  };
  const onDeleteInnerCold = async (challanNo: string) => {
    if (!confirmDelete("Delete this inner-cold transfer?")) return;
    try { await TransferApi.deleteInnerCold(challanNo); await loadInnerCold(innerColdPage); }
    catch (e) { fail(e, "Failed to delete inner cold transfer."); }
  };

  const go = (path: string) => router.push(`/modules/transfer${path}`);

  // No `if (!allowed) return null` gate: useRequireAuth returns true on the server but
  // false on the client's first render, so gating the render on it causes a hydration
  // mismatch. The `isAdmin` guard below already protects the body; effects are gated on
  // `allowed` and the hook redirects unauthenticated users.

  if (!isAdmin) {
    return (
      <TransferChrome title="Inter-Unit Transfer">
        <h1 className="text-[20px] font-semibold text-[var(--text-primary)] mb-3">Inter-Unit Transfer</h1>
        <section className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)]">
          You don&rsquo;t have access to the Inter-Unit Transfer module. Ask an administrator to grant you access, or switch to a different account.
        </section>
      </TransferChrome>
    );
  }

  const resetListPages = () => { setRequestsPage(1); setTransfersPage(1); setTransferInsPage(1); };

  const WarehouseSelect = !showWarehouseFilter ? null : (
    <>
      <select
        value={warehouseFilter}
        onChange={(e) => { setWarehouseFilter(e.target.value); resetListPages(); }}
        className="border border-[var(--aws-border)] rounded px-2 py-1 text-[12px] bg-white"
      >
        <option value="all">All warehouses</option>
        {warehouseOptions.map((c) => <option key={c} value={c}>{displayWarehouse(c)}</option>)}
      </select>
      <select
        value={warehouseDir}
        disabled={warehouseFilter === "all"}
        onChange={(e) => { setWarehouseDir(e.target.value as WhDir); resetListPages(); }}
        title="Match the selected warehouse against the From column, the To column, or both"
        className="border border-[var(--aws-border)] rounded px-2 py-1 text-[12px] bg-white disabled:opacity-50"
      >
        <option value="all">From & To</option>
        <option value="from">From</option>
        <option value="to">To</option>
      </select>
    </>
  );

  const segBtn = (active: boolean) =>
    `px-3 py-1 text-[12px] rounded border ${active ? "bg-[var(--aws-navy)] text-white border-[var(--aws-navy)]" : "border-[var(--aws-border)] hover:border-[var(--aws-navy)]"}`;

  const RequestStatusFilter = (
    <div className="flex gap-1">
      {(["Pending", "Transferred", "All"] as const).map((s) => (
        <button key={s} onClick={() => { setRequestStatus(s); setRequestsPage(1); }} className={segBtn(requestStatus === s)}>
          {s}
        </button>
      ))}
    </div>
  );

  const TransferStatusFilter = (
    <div className="flex gap-1">
      {([["all", "All"], ["Dispatch", "Dispatch"], ["Partial", "Partial"], ["Received", "Received"]] as const).map(([v, label]) => (
        <button key={v} onClick={() => { setTransferStatus(v); setTransfersPage(1); }} className={segBtn(transferStatus === v)}>
          {label}
        </button>
      ))}
    </div>
  );

  const TransferInStatusFilter = (
    <div className="flex gap-1">
      {([["all", "All"], ["Pending", "Pending"], ["Received", "Received"]] as const).map(([v, label]) => (
        <button key={v} onClick={() => { setTransferInStatus(v); setTransferInsPage(1); }} className={segBtn(transferInStatus === v)}>
          {label}
        </button>
      ))}
    </div>
  );

  // Reusable From–To date range. resetPage runs on change so pagination resets.
  const DateRange = (
    from: string, setFrom: (v: string) => void,
    to: string, setTo: (v: string) => void, resetPage: () => void,
  ) => (
    <div className="flex items-center gap-1">
      <input type="date" value={from} aria-label="From date"
        onChange={(e) => { setFrom(e.target.value); resetPage(); }}
        className="border border-[var(--aws-border)] rounded px-1.5 py-1 text-[12px]" />
      <span className="text-[var(--text-secondary)] text-[12px]">–</span>
      <input type="date" value={to} aria-label="To date"
        onChange={(e) => { setTo(e.target.value); resetPage(); }}
        className="border border-[var(--aws-border)] rounded px-1.5 py-1 text-[12px]" />
      {(from || to) && (
        <button onClick={() => { setFrom(""); setTo(""); resetPage(); }}
          className="text-[11px] text-[var(--text-secondary)] underline ml-0.5">clear</button>
      )}
    </div>
  );

  // `resetPage` fires on every keystroke rather than on the debounced value, so
  // the page is already 1 by the time the debounced fetch runs.
  const SearchBox = (
    value: string, setValue: (v: string) => void, placeholder: string,
    resetPage?: () => void,
  ) => (
    <div className="relative">
      <input
        value={value} placeholder={placeholder}
        onChange={(e) => { setValue(e.target.value); resetPage?.(); }}
        className="border border-[var(--aws-border)] rounded px-2 py-1 text-[12px] w-full sm:w-64"
      />
      {value && (
        <button onClick={() => { setValue(""); resetPage?.(); }} aria-label="Clear search"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--text-secondary)]">×</button>
      )}
    </div>
  );

  return (
    <TransferChrome title="Inter-Unit Transfer">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h1 className="text-[20px] font-semibold text-[var(--text-primary)]">Inter-Unit Transfer</h1>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setPendingOpen(true)}
            className="px-3 py-1.5 text-[12px] border border-[var(--aws-border)] rounded hover:border-[var(--aws-navy)]">Pending Transfers</button>
          <button onClick={() => go("/dashboard")}
            className="px-3 py-1.5 text-[12px] border border-[var(--aws-border)] rounded hover:border-[var(--aws-navy)]">View Summary</button>
          <button onClick={() => go("/job-work")}
            className="px-3 py-1.5 text-[12px] border border-[var(--aws-border)] rounded hover:border-[var(--aws-navy)]">Job Work</button>
          <button onClick={() => go("/request")}
            className="px-3 py-1.5 text-[12px] rounded bg-[var(--aws-navy)] text-white hover:opacity-90">New Request</button>
        </div>
      </div>

      {error && (
        <div className="mb-3 text-[12px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-2">{error}</div>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 mb-4">
        <StatCard label="Requests" value={requestsTotal} tone="text-[var(--text-primary)]" />
        <StatCard label="Pending" value={pendingRequests} tone="text-amber-600" />
        <StatCard label="Transfers Out" value={transfersTotal} tone="text-violet-700" />
        <StatCard label="Transfers In" value={transferInsTotal} tone="text-teal-700" />
        <StatCard label="In Transit" value={inTransitCount} tone="text-orange-600" onClick={() => setPendingOpen(true)} />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[var(--aws-border)] overflow-x-auto mb-3">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setActiveTab(t.key)}
            className={`px-3 py-2 text-[12px] whitespace-nowrap border-b-2 -mb-px ${activeTab === t.key ? "border-[var(--aws-navy)] text-[var(--text-primary)] font-semibold" : "border-transparent text-[var(--text-secondary)]"}`}>
            <span className="hidden sm:inline">{t.label}</span>
            <span className="sm:hidden">{t.short}</span>
          </button>
        ))}
      </div>

      {loading ? <LoadingSkeleton /> : (
        <>
          {/* Requests */}
          {activeTab === "request" && (
            <Section
              filterBar={<>{RequestStatusFilter}{SearchBox(requestSearch, setRequestSearch, "Search requests…", () => setRequestsPage(1))}{WarehouseSelect}</>}
              empty={filteredRequests.length === 0}
              emptyMsg="No requests found."
              pagination={<PaginationBar page={reqPage} totalPages={requestsTP} total={filteredRequests.length} onPage={setRequestsPage} />}
            >
              <table className="hidden md:table w-full text-[12px]">
                <thead><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
                  <th className="py-2">Request No</th><th>From</th><th>To</th><th>Date</th><th>Status</th><th></th>
                </tr></thead>
                <tbody>
                  {pagedRequests.map((r) => (
                    <tr key={r.id} className="border-b border-[var(--aws-border)]/50">
                      <td className="py-2 font-medium">
                        <ChallanHoverCard label={r.request_no} from={r.from_warehouse} to={r.to_warehouse}
                          reason={r.status} lines={requestHoverLines(r)} />
                      </td>
                      <td>{r.from_warehouse}</td><td>{r.to_warehouse}</td>
                      <td>{r.request_date}</td><td><StatusBadge status={r.status} /></td>
                      <td className="text-right whitespace-nowrap">
                        <RowBtn onClick={() => go(`/request/${r.id}`)}>View</RowBtn>
                        <RowBtn disabled={r.status?.toLowerCase() !== "pending"}
                          onClick={() => go(`/transferform?requestId=${r.id}`)}>Accept</RowBtn>
                        {canDelete && <RowBtn danger onClick={() => onDeleteRequest(r.id)}>Delete</RowBtn>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="md:hidden space-y-2">
                {pagedRequests.map((r) => (
                  <Card key={r.id}>
                    <CardHead title={r.request_no} status={r.status} />
                    <CardRow>{r.from_warehouse} → {r.to_warehouse} · {r.request_date}</CardRow>
                    <CardActions>
                      <RowBtn onClick={() => go(`/request/${r.id}`)}>View</RowBtn>
                      <RowBtn disabled={r.status?.toLowerCase() !== "pending"} onClick={() => go(`/transferform?requestId=${r.id}`)}>Accept</RowBtn>
                      {canDelete && <RowBtn danger onClick={() => onDeleteRequest(r.id)}>Delete</RowBtn>}
                    </CardActions>
                  </Card>
                ))}
              </div>
            </Section>
          )}

          {/* Transfer Out */}
          {activeTab === "transferout" && (
            <Section
              filterBar={<>{TransferStatusFilter}
                {DateRange(transferDateFrom, setTransferDateFrom, transferDateTo, setTransferDateTo, () => setTransfersPage(1))}
                {SearchBox(transferOutSearch, setTransferOutSearch, "Search transfers…", () => setTransfersPage(1))}{WarehouseSelect}
                <button onClick={() => go("/directtransferform")}
                  className="px-3 py-1 text-[12px] rounded bg-[var(--aws-navy)] text-white">Direct Transfer Out</button></>}
              empty={transfers.length === 0}
              emptyMsg="No transfers found."
              pagination={<PaginationBar page={toPage} totalPages={transfersTP} total={transfersFiltered} onPage={setTransfersPage} />}
            >
              <TransferTable rows={transfers} go={go} canDelete={canDelete} onDelete={onDeleteTransfer} showActions />
              <TransferCards rows={transfers} go={go} canDelete={canDelete} onDelete={onDeleteTransfer} showActions />
            </Section>
          )}

          {/* Transfer In */}
          {activeTab === "transferin" && (
            <>
            {/* Filters / search / actions stay at the top of the tab. Search, date and
                warehouse filter BOTH lists below; the All/Pending/Received segment
                applies to the GRN records. */}
            <div className="flex flex-wrap items-center gap-2 mb-3">
              {TransferInStatusFilter}
              {DateRange(transferInDateFrom, setTransferInDateFrom, transferInDateTo, setTransferInDateTo, () => setTransferInsPage(1))}
              {SearchBox(transferInSearch, setTransferInSearch, "Search…", () => setTransferInsPage(1))}{WarehouseSelect}
            </div>

            <IncomingMaterial rows={incoming} total={incomingTotal} go={go} />

            <div className="bg-white border border-[var(--aws-border)] rounded-md">
              <div className="px-4 py-3 border-b border-[var(--aws-border)] flex items-center justify-between gap-2">
                <span className="text-[13px] font-semibold text-[var(--text-primary)]">
                  Transfer-In Records ({transferInsFiltered})
                </span>
                {/* Deleting a GRN or finishing a receive elsewhere changes this
                    list without anything on this page knowing. */}
                <button type="button" onClick={() => { loadTransferIns(tiPage); loadIncoming(); }}
                  className="text-[12px] px-2 py-1 border border-[var(--aws-border)] rounded hover:border-[var(--aws-navy)]">
                  Refresh
                </button>
              </div>
              <div className="p-3">
            <Section
              empty={transferIns.length === 0}
              emptyMsg="No transfer-ins found."
              pagination={<PaginationBar page={tiPage} totalPages={transferInsTP} total={transferInsFiltered} onPage={setTransferInsPage} />}
            >
              {/* Full GRN grid: who received it and in what condition are the two
                  facts an operator scans this list for, and neither was shown. */}
              <div className={GRID_WRAP}>
              <table className={`${GRID_TABLE} min-w-[980px]`}>
                <thead><tr className="text-left text-[var(--text-secondary)]">
                  <th className={GRID_TH}>GRN No</th>
                  <th className={GRID_TH}>Transfer Out</th>
                  <th className={GRID_TH}>Status</th>
                  <th className={GRID_TH}>From</th>
                  <th className={GRID_TH}>To</th>
                  <th className={GRID_TH}>Received By</th>
                  <th className={GRID_TH}>Condition</th>
                  <th className={GRID_TH}>Boxes</th>
                  <th className={GRID_TH}>Date</th>
                  <th className={`${GRID_TH} text-right`}>Action</th>
                </tr></thead>
                <tbody>
                  {transferIns.map((ti) => (
                    <tr key={ti.id} className="hover:bg-gray-50/50">
                      <td className={`${GRID_TD} font-medium`}>
                        {/* summary:true — the card renders article+lot groups, and a
                            GRN in this list can hold 800 boxes. */}
                        <ChallanHoverCard label={ti.grn_number} from={ti.from_warehouse} to={ti.receiving_warehouse}
                          fetchLines={() => TransferApi.getTransferIn(ti.id, { summary: true }).then(transferInHoverData)} />
                      </td>
                      <td className={`${GRID_TD} whitespace-nowrap`}>{ti.transfer_out_no || "—"}</td>
                      <td className={GRID_TD}><StatusBadge status={ti.status} /></td>
                      <td className={`${GRID_TD} whitespace-nowrap`}>{ti.from_warehouse ? displayWarehouse(ti.from_warehouse) : "—"}</td>
                      <td className={`${GRID_TD} whitespace-nowrap`}>{displayWarehouse(ti.receiving_warehouse)}</td>
                      <td className={GRID_TD}>{ti.received_by || "—"}</td>
                      <td className={GRID_TD}><ConditionBadge condition={ti.box_condition} /></td>
                      <td className={GRID_TD}><BoxesBadge count={ti.total_boxes_scanned} /></td>
                      {/* grn_date, not created_at: the receipt date is the one that
                          reconciles against the sender's challan. */}
                      <td className={`${GRID_TD} whitespace-nowrap`}>{formatDate(ti.grn_date)}</td>
                      <td className={`${GRID_TD} text-right whitespace-nowrap`}>
                        {ti.status?.toLowerCase() === "pending" &&
                          <RowBtn onClick={() => go(`/transferIn?resume=${encodeURIComponent(ti.transfer_out_no)}`)}>Resume</RowBtn>}
                        <RowBtn onClick={() => go(`/transferIn/${ti.id}`)}>View</RowBtn>
                        {canDeleteTransferIn && <RowBtn danger onClick={() => onDeleteTransferIn(ti.id)}>Delete</RowBtn>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              <div className="md:hidden space-y-2">
                {transferIns.map((ti) => (
                  <Card key={ti.id}>
                    <CardHead title={ti.grn_number} status={ti.status} />
                    <CardRow>
                      {ti.transfer_out_no || "—"} · {ti.from_warehouse ? displayWarehouse(ti.from_warehouse) : "—"} → {displayWarehouse(ti.receiving_warehouse)}
                    </CardRow>
                    <CardRow>{ti.received_by || "—"} · {formatDate(ti.grn_date)}</CardRow>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <ConditionBadge condition={ti.box_condition} />
                      <BoxesBadge count={ti.total_boxes_scanned} />
                    </div>
                    <CardActions>
                      {ti.status?.toLowerCase() === "pending" &&
                        <RowBtn onClick={() => go(`/transferIn?resume=${encodeURIComponent(ti.transfer_out_no)}`)}>Resume</RowBtn>}
                      <RowBtn onClick={() => go(`/transferIn/${ti.id}`)}>View</RowBtn>
                      {canDeleteTransferIn && <RowBtn danger onClick={() => onDeleteTransferIn(ti.id)}>Delete</RowBtn>}
                    </CardActions>
                  </Card>
                ))}
              </div>
            </Section>
              </div>
            </div>
            </>
          )}

          {/* Inner Cold */}
          {activeTab === "innercold" && (
            <Section
              filterBar={<button onClick={() => go("/innercoldtransfer")}
                className="px-3 py-1 text-[12px] rounded bg-[var(--aws-navy)] text-white">New Transfer</button>}
              empty={innerCold.length === 0}
              emptyMsg="No inner cold transfers found."
              pagination={<PaginationBar page={innerColdPage} totalPages={innerColdTP} total={innerColdTotal} onPage={loadInnerCold} />}
            >
              <table className="hidden md:table w-full text-[12px]">
                <thead><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
                  <th className="py-2">Challan</th><th>Date</th><th>From</th><th>Lines</th><th>Boxes</th><th>Status</th><th></th>
                </tr></thead>
                <tbody>
                  {innerCold.map((c) => (
                    <tr key={c.challan_no} className="border-b border-[var(--aws-border)]/50">
                      <td className="py-2 font-medium">
                        <ChallanHoverCard label={c.challan_no || "—"} from={c.from_warehouse} to={c.from_warehouse}
                          reason={c.reason_code} lines={innerColdHoverLines(c)} />
                      </td>
                      <td>{c.transfer_date}</td><td>{c.from_warehouse}</td>
                      <td>{c.line_count}</td><td>{c.total_boxes ?? "—"}</td>
                      <td><StatusBadge status={c.status} /></td>
                      <td className="text-right whitespace-nowrap">
                        <RowBtn onClick={() => go(`/innercoldtransfer?editChallan=${encodeURIComponent(c.challan_no || "")}`)}>Edit</RowBtn>
                        {canDeleteInnerCold && c.challan_no &&
                          <RowBtn danger onClick={() => onDeleteInnerCold(c.challan_no!)}>Delete</RowBtn>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="md:hidden space-y-2">
                {innerCold.map((c) => (
                  <Card key={c.challan_no}>
                    <CardHead title={c.challan_no || "—"} status={c.status} />
                    <CardRow>{c.from_warehouse} · {c.line_count} lines · {c.total_boxes ?? "—"} boxes</CardRow>
                    <CardActions>
                      <RowBtn onClick={() => go(`/innercoldtransfer?editChallan=${encodeURIComponent(c.challan_no || "")}`)}>Edit</RowBtn>
                      {canDeleteInnerCold && c.challan_no &&
                        <RowBtn danger onClick={() => onDeleteInnerCold(c.challan_no!)}>Delete</RowBtn>}
                    </CardActions>
                  </Card>
                ))}
              </div>
            </Section>
          )}

          {/* All Transfers — its own unfiltered server-paginated fetch. It can no
              longer share `transfers`, which is now the FILTERED Transfer-Out page. */}
          {activeTab === "details" && (
            <Section empty={allTransfers.length === 0} emptyMsg="No transfers found."
              pagination={<PaginationBar page={allPage} totalPages={allTransfersTP} total={allTransfersTotal} onPage={setAllTransfersPage} />}>
              <TransferTable rows={allTransfers} go={go} canDelete={false} onDelete={onDeleteTransfer} showActions={false} />
              <TransferCards rows={allTransfers} go={go} canDelete={false} onDelete={onDeleteTransfer} showActions={false} />
            </Section>
          )}
        </>
      )}

      <PendingTransfersModal
        open={pendingOpen}
        onClose={() => { setPendingOpen(false); loadInTransitCount(); }}
        canCancel={canCancel}
      />
    </TransferChrome>
  );
}

// Map a request's article lines to hover-card lines.
function requestHoverLines(r: TransferRequest): HoverLine[] {
  return r.lines.map((l) => ({
    name: l.item_description, qty: l.quantity, weightKg: l.net_weight, lot: l.lot_number,
  }));
}
// Map an inner-cold challan's relabel lines to hover-card lines.
function innerColdHoverLines(c: InnerColdChallan): HoverLine[] {
  return c.lines.map((l) => ({
    name: l.item_description || "—", qty: l.quantity,
    weightKg: l.net_weight_kg, lotFrom: l.old_lot_number, lotTo: l.new_lot_number,
    sourceUnit: l.new_storage_location,
  }));
}

// ── Row/section building blocks ──────────────────────────────────────────
function RowBtn({ children, onClick, disabled, danger, primary }: {
  children: React.ReactNode; onClick?: () => void; disabled?: boolean; danger?: boolean; primary?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={`ml-1 px-2 py-0.5 text-[11px] border rounded disabled:opacity-40 ${
        danger ? "border-rose-300 text-rose-700 hover:bg-rose-50"
          : primary ? "border-[var(--aws-navy)] bg-[var(--aws-navy)] text-white hover:opacity-90"
            : "border-[var(--aws-border)] hover:border-[var(--aws-navy)]"}`}>
      {children}
    </button>
  );
}

function Section({ filterBar, children, empty, emptyMsg, pagination }: {
  filterBar?: React.ReactNode; children: React.ReactNode; empty: boolean; emptyMsg: string; pagination?: React.ReactNode;
}) {
  return (
    <div>
      {filterBar && <div className="flex flex-wrap items-center gap-2 mb-3">{filterBar}</div>}
      {empty ? <EmptyState msg={emptyMsg} /> : children}
      {!empty && pagination}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="border border-[var(--aws-border)] rounded-md p-3 bg-white">{children}</div>;
}
function CardHead({ title, status }: { title: string; status?: string | null }) {
  return <div className="flex items-center justify-between mb-1"><span className="font-medium text-[13px]">{title}</span><StatusBadge status={status} /></div>;
}
function CardRow({ children }: { children: React.ReactNode }) {
  return <div className="text-[12px] text-[var(--text-secondary)]">{children}</div>;
}
function CardActions({ children }: { children: React.ReactNode }) {
  return <div className="mt-2 flex flex-wrap gap-1">{children}</div>;
}
// Items + total-qty badge pair shown in the Transfer-Out "Items/Boxes" column,
// mirroring the reference dashboard.
// Three separate facts, each under its own label. The column is headed Items/Boxes
// but the second badge used to be `total_qty` — the SUM of line quantities — so a
// boxes-headed column held a different quantity and contradicted the hover card
// opened from the same row (transfer 1891: "Qty: 231" against 78 boxes). `boxes_count`
// is the backend's own COUNT(DISTINCT COALESCE(box_id, id::text)) and was being
// dropped on the floor; 74 transfers have boxes_count <> total_qty.
function ItemsBadges({ items, boxes, qty }: { items: number; boxes: number; qty: number }) {
  return (
    <span className="inline-flex items-center gap-1 flex-wrap">
      <span className="px-1.5 py-0.5 rounded text-[11px] bg-blue-50 text-blue-700 border border-blue-200">
        {items} Item{items !== 1 ? "s" : ""}
      </span>
      <span className="px-1.5 py-0.5 rounded text-[11px] bg-violet-50 text-violet-700 border border-violet-200">
        {boxes || 0} Box{boxes === 1 ? "" : "es"}
      </span>
      <span className="px-1.5 py-0.5 rounded text-[11px] bg-amber-50 text-amber-700 border border-amber-200">
        Qty: {qty || 0}
      </span>
    </span>
  );
}

// Box-condition pill for the Transfer-IN list. Same three values the receive
// screen offers (Good / Damaged / Partial) and the same tones the GRN detail
// page uses, so a row reads identically wherever the operator meets it.
function ConditionBadge({ condition }: { condition?: string | null }) {
  const v = (condition || "").toLowerCase();
  const tone = v === "good" ? "bg-emerald-100 text-emerald-800"
    : v === "damaged" ? "bg-rose-100 text-rose-800"
      : v === "partial" ? "bg-amber-100 text-amber-800"
        : "bg-slate-100 text-slate-700";
  return <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium ${tone}`}>{condition || "N/A"}</span>;
}

// Scanned-box count as a pill. A bare number in a ten-column grid reads as a
// quantity of anything; the unit has to travel with it.
function BoxesBadge({ count }: { count: number }) {
  return (
    <span className="inline-block px-1.5 py-0.5 rounded text-[11px] whitespace-nowrap bg-violet-50 text-violet-700 border border-violet-200">
      {count} Box{count === 1 ? "" : "es"}
    </span>
  );
}

function TransferTable({ rows, go, canDelete, onDelete, showActions }: {
  rows: TransferListItem[]; go: (p: string) => void; canDelete: boolean; onDelete: (id: number) => void; showActions: boolean;
}) {
  return (
    <div className={GRID_WRAP}>
      <table className={`${GRID_TABLE} min-w-[860px]`}>
        <thead><tr className="text-left text-[var(--text-secondary)]">
          <th className={GRID_TH}>Challan</th>
          <th className={GRID_TH}>Status</th>
          <th className={GRID_TH}>Route</th>
          <th className={GRID_TH}>Date</th>
          <th className={GRID_TH}>Vehicle</th>
          <th className={GRID_TH}>Items / Boxes / Qty</th>
          <th className={`${GRID_TH} text-right`}>Action</th>
        </tr></thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} className="hover:bg-gray-50/50">
              <td className={`${GRID_TD} font-medium`}>
                <ChallanHoverCard label={t.challan_no} from={displayWarehouse(t.from_warehouse)} to={displayWarehouse(t.to_warehouse)}
                  fetchLines={() => TransferApi.getTransfer(t.id).then(transferHoverData)} />
              </td>
              <td className={GRID_TD}><StatusBadge status={t.status} /></td>
              <td className={`${GRID_TD} whitespace-nowrap`}>{displayWarehouse(t.from_warehouse)} → {displayWarehouse(t.to_warehouse)}</td>
              <td className={`${GRID_TD} whitespace-nowrap`}>{formatDate(t.stock_trf_date)}</td>
              <td className={GRID_TD}>
                {t.vehicle_no || "—"}
                {t.driver_name && <span className="block text-[11px] text-[var(--text-secondary)]">{t.driver_name}</span>}
              </td>
              <td className={GRID_TD}><ItemsBadges items={t.items_count} boxes={t.boxes_count} qty={t.total_qty} /></td>
              <td className={`${GRID_TD} text-right whitespace-nowrap`}>
                <RowBtn onClick={() => go(`/view/${t.id}`)}>View</RowBtn>
                {showActions && <RowBtn disabled={["received", "completed"].includes((t.status || "").toLowerCase())}
                  onClick={() => go(`/directtransferform?editId=${t.id}`)}>Edit</RowBtn>}
                <RowBtn onClick={() => go(`/dc/${t.id}`)}>DC</RowBtn>
                {showActions && canDelete && <RowBtn danger onClick={() => onDelete(t.id)}>Delete</RowBtn>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Incoming Material — dispatched transfer-OUTs awaiting receipt. "Material In"
// opens the interactive receive page (/transferIn?resume=<challan>) pre-loaded
// with that transfer-out's details.
function IncomingMaterial({ rows, total, go }: { rows: TransferListItem[]; total: number; go: (p: string) => void }) {
  if (rows.length === 0) return null;
  const receive = (t: TransferListItem) => go(`/transferIn?resume=${encodeURIComponent(t.challan_no)}`);
  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md mb-4">
      <div className="px-4 py-3 border-b border-[var(--aws-border)] flex items-center justify-between">
        <span className="text-[13px] font-semibold text-[var(--text-primary)]">
          Incoming Material ({total > rows.length ? `showing ${rows.length} of ${total}` : total || rows.length})
        </span>
        <span className="text-[11px] text-[var(--text-secondary)]">
          Dispatched transfers awaiting receipt
          {total > rows.length && " — narrow the filters to reach the rest"}
        </span>
      </div>
      <table className="hidden md:table w-full text-[12px]">
        <thead><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
          <th className="px-4 py-2">Challan</th><th>Route</th><th>Date</th><th>Vehicle</th><th>Items / Boxes / Qty</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} className="border-b border-[var(--aws-border)]/50">
              <td className="px-4 py-2 font-mono font-medium">{t.challan_no}</td>
              <td className="whitespace-nowrap">{displayWarehouse(t.from_warehouse)} → {displayWarehouse(t.to_warehouse)}</td>
              <td>{formatDate(t.stock_trf_date)}</td>
              <td>{t.vehicle_no || "—"}</td>
              <td><ItemsBadges items={t.items_count} boxes={t.boxes_count} qty={t.total_qty} /></td>
              <td><StatusBadge status={t.status} /></td>
              <td className="text-right whitespace-nowrap">
                <RowBtn onClick={() => go(`/view/${t.id}`)}>View</RowBtn>
                <RowBtn primary onClick={() => receive(t)}>Transfer In</RowBtn>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="md:hidden p-3 space-y-2">
        {rows.map((t) => (
          <div key={t.id} className="border border-[var(--aws-border)] rounded-md p-2">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[12px] font-medium">{t.challan_no}</span>
              <StatusBadge status={t.status} />
            </div>
            <div className="text-[11px] text-[var(--text-secondary)]">
              {displayWarehouse(t.from_warehouse)} → {displayWarehouse(t.to_warehouse)} · {formatDate(t.stock_trf_date)}
            </div>
            <div className="mt-1"><ItemsBadges items={t.items_count} boxes={t.boxes_count} qty={t.total_qty} /></div>
            <div className="mt-2 flex flex-wrap gap-1">
              <RowBtn onClick={() => go(`/view/${t.id}`)}>View</RowBtn>
              <RowBtn primary onClick={() => receive(t)}>Transfer In</RowBtn>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TransferCards({ rows, go, canDelete, onDelete, showActions }: {
  rows: TransferListItem[]; go: (p: string) => void; canDelete: boolean; onDelete: (id: number) => void; showActions: boolean;
}) {
  return (
    <div className="md:hidden space-y-2">
      {rows.map((t) => (
        <Card key={t.id}>
          <CardHead title={t.challan_no} status={t.status} />
          <CardRow>{displayWarehouse(t.from_warehouse)} → {displayWarehouse(t.to_warehouse)} · {formatDate(t.stock_trf_date)}{t.vehicle_no ? ` · ${t.vehicle_no}` : ""}</CardRow>
          <div className="mt-1"><ItemsBadges items={t.items_count} boxes={t.boxes_count} qty={t.total_qty} /></div>
          <CardActions>
            <RowBtn onClick={() => go(`/view/${t.id}`)}>View</RowBtn>
            {showActions && <RowBtn disabled={["received", "completed"].includes((t.status || "").toLowerCase())}
              onClick={() => go(`/directtransferform?editId=${t.id}`)}>Edit</RowBtn>}
            <RowBtn onClick={() => go(`/dc/${t.id}`)}>DC</RowBtn>
            {showActions && canDelete && <RowBtn danger onClick={() => onDelete(t.id)}>Delete</RowBtn>}
          </CardActions>
        </Card>
      ))}
    </div>
  );
}
