"use client";

// Inter-Unit Transfer dashboard — replica of the production 5-tab transfer
// dashboard (server_replica/data/transfer-module-docs/01-transfer-dashboard.md).
// Phase 1: lists + stat cards + per-tab search/warehouse filter + pagination +
// delete actions + navigation. The ChallanHoverCard and PendingTransfersModal
// are layered in by P6 (this file exposes the `pendingOpen` state they hook).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useHasPermission, useRequireAuth, useMe, useUserScope } from "@/lib/user";
import { userHasWarehouse } from "@/lib/warehouseScope";
import { canonicalSite, displaySite } from "@/lib/sites";
import { TransferChrome } from "./_chrome";
import { ALL_SITES, siteMatches, siteOptions } from "./_siteRules";
import {
  REQUEST_STATUS,
  TransferApi,
  isInTransitStatus,
  isStoreHeld,
  type TransferRequest,
  type TransferListItem,
  type TransferInRecord,
  type InnerColdChallan,
} from "@/lib/transfer";
import { ChallanHoverCard, type HoverLine } from "./_ChallanHoverCard";
import { PendingTransfersModal } from "./_PendingTransfersModal";
import { transferHoverData, transferInHoverData } from "./_hoverData";
import { GRID_TABLE, GRID_WRAP } from "./_grid";

const PER_PAGE = 15;
const FILTER_FETCH_SIZE = 500;
// Transfer Out / Transfer In are filtered (status/date/warehouse) client-side, so
// we pull the full server-scoped set up to the endpoint cap (le=1000).
const LIST_FETCH_SIZE = 1000;

// Sites are shown, offered and compared by the shared site table (lib/sites): a row stored
// "Warehouse A185", "A-185" or "D-39" shows as A185 / Savla D-39 and matches that filter.
function displayWarehouse(code: string | null | undefined): string {
  return canonicalSite(code);
}
// Does `filter` match any candidate value? Splits comma-lists (a cold transfer
// may carry "Rishi, Savla D-39") and compares sites.
function whHit(filter: string, ...vals: (string | null | undefined)[]): boolean {
  return siteMatches(filter, ...vals);
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
// Site columns as a search reads them: as stored and by canonical name, so a search for
// "Savla D-39" finds a row stored "D-39" (each name of a comma list too).
function siteFields(...vals: (string | null | undefined)[]): string[] {
  return vals.flatMap((v) => (v ? [v, ...v.split(",").map((part) => canonicalSite(part))] : []));
}

// ── Date helpers for client-side range filtering ──
// stock_trf_date / request_date come back "DD-MM-YYYY"; grn_date is an ISO
// datetime. Both normalize to "YYYY-MM-DD" so lexicographic compare = chronological.
function dmyToISO(d?: string | null): string {
  const p = (d || "").split("-");
  return p.length === 3 ? `${p[2]}-${p[1]}-${p[0]}` : "";
}
function isoDay(d?: string | null): string {
  const s = String(d || "");
  return s.length >= 10 ? s.slice(0, 10) : "";
}
function inDateRange(day: string, from: string, to: string): boolean {
  if (!from && !to) return true;
  if (!day) return false;
  return (!from || day >= from) && (!to || day <= to);
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
  // IMS's older statuses of a transfer still in transit (IMS shows Completed as Dispatch).
  Completed: "bg-sky-100 text-sky-800",
  "In Transit": "bg-sky-100 text-sky-800",
  Rejected: "bg-rose-100 text-rose-800",
  // Request flow (backend migration 121)
  Accepted: "bg-sky-100 text-sky-800",
  "On Hold": "bg-orange-100 text-orange-800",
  Approved: "bg-emerald-100 text-emerald-800",
  Transferred: "bg-slate-100 text-slate-700",
};
function StatusBadge({ status }: { status?: string | null }) {
  const s = status || "—";
  const tone = STATUS_TONE[s] || "bg-slate-100 text-slate-700";
  return <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium ${tone}`}>{s}</span>;
}

export default function TransferDashboardPage() {
  const router = useRouter();
  const allowed = useRequireAuth(router.replace);
  const me = useMe();
  const email = (me?.email || "").toLowerCase();

  // Warehouse dropdown: admins filter across all sites; a scoped user only sees
  // its own warehouse(s) (and the filter is hidden entirely when there's nothing
  // to choose between — its data is already scoped server-side).
  const { isAdmin, warehouses: userWarehouses } = useUserScope();
  // Request flow (backend migration 121): the supplying store accepts / rejects a request
  // and scans and sends it once approved; an inventory manager approves / rejects
  // it in between. Either opens the module; everyone else still needs admin.
  const canAcceptRequests = useHasPermission("transfer", "requests", null, "accept");
  const canApproveRequests = useHasPermission("transfer", "requests", null, "approve");
  const canOpen = isAdmin || canAcceptRequests || canApproveRequests;
  // Deleting requests, transfers, receipts and inner cold challans, cancelling an
  // in-transit transfer and the in-transit sync: admins and inventory managers (holders
  // of the approve permission), as the server checks it.
  const canDelete = isAdmin || canApproveRequests === true;
  // One option per site, by canonical name (shown by its display name): a user granted
  // "D-39" and "Savla D-39" has one option, Savla D-39.
  const warehouseOptions = isAdmin ? [...ALL_SITES] : siteOptions(userWarehouses);
  const showWarehouseFilter = isAdmin || warehouseOptions.length > 1;

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
  // Requests status filter — defaults to Open (not yet transferred or rejected).
  const [requestStatus, setRequestStatus] = useState<RequestFilter>("Open");
  // Transfer-Out has 3 statuses; Transfer-In has 2. Each is an individual filter
  // (+ "all"), plus a date range. Default "all".
  const [transferStatus, setTransferStatus] = useState<"all" | "Dispatch" | "Partial" | "Received">("all");
  const [transferInStatus, setTransferInStatus] = useState<"all" | "Pending" | "Received">("all");
  const [transferDateFrom, setTransferDateFrom] = useState("");
  const [transferDateTo, setTransferDateTo] = useState("");
  const [transferInDateFrom, setTransferInDateFrom] = useState("");
  const [transferInDateTo, setTransferInDateTo] = useState("");

  // Per-tab data
  const [requests, setRequests] = useState<TransferRequest[]>([]);
  const [requestsTotal, setRequestsTotal] = useState(0);
  const [transfers, setTransfers] = useState<TransferListItem[]>([]);
  const [transfersTotal, setTransfersTotal] = useState(0);
  const [transferIns, setTransferIns] = useState<TransferInRecord[]>([]);
  const [transferInsTotal, setTransferInsTotal] = useState(0);
  const [innerCold, setInnerCold] = useState<InnerColdChallan[]>([]);
  const [inTransitCount, setInTransitCount] = useState(0);

  // Per-tab pagination (Transfer-Out & All share `transfersPage`). Requests are
  // small + fully loaded, so they're filtered + paginated client-side.
  const [requestsPage, setRequestsPage] = useState(1);
  const [transfersPage, setTransfersPage] = useState(1);
  const [transferInsPage, setTransferInsPage] = useState(1);
  const [innerColdPage, setInnerColdPage] = useState(1);
  const [innerColdTP, setInnerColdTP] = useState(1);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Not an error: a request step found nothing to do because the request had already
  // moved on (answered by someone else, in another tab or another channel).
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingOpen, setPendingOpen] = useState(false);
  // Requests with a step under way. The pre-check makes a step wait on the server before
  // its dialog, so a double-click would otherwise run it twice (two dialogs, two POSTs).
  // The ref is the guard; `busyIds` greys that row's buttons meanwhile.
  const inFlight = useRef(new Set<number>());
  const [busyIds, setBusyIds] = useState<ReadonlySet<number>>(() => new Set());

  // Search boxes
  const [requestSearch, setRequestSearch] = useState("");
  const [transferOutSearch, setTransferOutSearch] = useState("");
  const [transferInSearch, setTransferInSearch] = useState("");

  // The notice lives as long as the error: both go when a list reloads or an error shows.
  const fail = (e: unknown, fallback: string) => {
    setNotice(null); setError(e instanceof Error ? e.message : fallback);
  };

  // Requests are few — fetch the whole (server-scoped) set once and do status /
  // warehouse / search filtering + pagination client-side. This keeps the stat
  // cards (total + pending) stable regardless of the active status filter.
  // True when the list was reloaded.
  const loadRequests = useCallback(async (): Promise<boolean> => {
    setLoading(true); setError(null); setNotice(null);
    try {
      const r = await TransferApi.getRequests({ page: 1, per_page: FILTER_FETCH_SIZE });
      setRequests(r.records); setRequestsTotal(r.total);
      return true;
    } catch (e) { fail(e, "Failed to load requests."); return false; }
    finally { setLoading(false); }
  }, []);

  // Like requests: fetch the whole (server-scoped) set once, then filter
  // (status / warehouse / search) + paginate client-side so the stat cards stay
  // stable regardless of the active status filter. True when the list was reloaded.
  const loadTransfers = useCallback(async (): Promise<boolean> => {
    setLoading(true); setError(null); setNotice(null);
    try {
      const r = await TransferApi.getTransfers({ page: 1, per_page: LIST_FETCH_SIZE });
      setTransfers(r.records); setTransfersTotal(r.total);
      return true;
    } catch (e) { fail(e, "Failed to load transfers."); return false; }
    finally { setLoading(false); }
  }, []);

  const loadTransferIns = useCallback(async () => {
    setLoading(true); setError(null); setNotice(null);
    try {
      const r = await TransferApi.getTransferIns({ page: 1, per_page: LIST_FETCH_SIZE });
      setTransferIns(r.records); setTransferInsTotal(r.total);
    } catch (e) { fail(e, "Failed to load transfer INs."); }
    finally { setLoading(false); }
  }, []);

  const loadInnerCold = useCallback(async (page: number) => {
    setLoading(true); setError(null); setNotice(null);
    try {
      const r = await TransferApi.getInnerColdList({ page, per_page: PER_PAGE });
      setInnerCold(r.records); setInnerColdTP(r.total_pages); setInnerColdPage(page);
    } catch (e) { fail(e, "Failed to load inner cold transfers."); }
    finally { setLoading(false); }
  }, []);

  const loadInTransitCount = useCallback(async () => {
    try {
      const r = await TransferApi.getPendingStock();
      setInTransitCount(r.total);
    } catch { /* keep prior count on error */ }
  }, []);

  // Populate the lists + stat cards once on mount. All status/warehouse/search
  // filtering + pagination is client-side over these (server-scoped) sets, so no
  // refetch is needed when a filter changes.
  useEffect(() => {
    if (!mounted || !allowed || !canOpen) return;
    queueMicrotask(() => {
      loadTransfers();
      loadRequests();
      loadTransferIns();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, allowed, canOpen]);

  // In-transit count once on mount (P6 also refreshes it on pending-modal close).
  useEffect(() => {
    if (!mounted || !allowed || !canOpen) return;
    queueMicrotask(() => loadInTransitCount());
  }, [mounted, allowed, canOpen, loadInTransitCount]);

  // Lazy-load Inner Cold the first time its tab opens.
  useEffect(() => {
    if (!mounted || !allowed || !canOpen) return;
    if (activeTab === "innercold" && innerCold.length === 0) queueMicrotask(() => loadInnerCold(1));
  }, [activeTab, mounted, allowed, canOpen, innerCold.length, loadInnerCold]);

  // ── Client-side filtered views ──
  const filteredRequests = useMemo(() => requests.filter((r) =>
    requestMatchesFilter(r, requestStatus) &&
    warehouseMatchesDir(warehouseFilter, warehouseDir, [r.from_warehouse], [r.to_warehouse]) &&
    searchMatch(requestSearch, [r.request_no, ...siteFields(r.from_warehouse, r.to_warehouse), r.request_date, r.status])
  ), [requests, requestStatus, warehouseFilter, warehouseDir, requestSearch]);

  // Client-side pagination for the Requests tab (clamped so reducing the filter
  // never strands you on an empty page).
  const requestsTP = Math.max(1, Math.ceil(filteredRequests.length / PER_PAGE));
  const reqPage = Math.min(requestsPage, requestsTP);
  const pagedRequests = filteredRequests.slice((reqPage - 1) * PER_PAGE, reqPage * PER_PAGE);

  const filteredTransfers = useMemo(() => transfers.filter((t) =>
    (transferStatus === "all" || t.status === transferStatus) &&
    inDateRange(dmyToISO(t.stock_trf_date), transferDateFrom, transferDateTo) &&
    warehouseMatchesDir(warehouseFilter, warehouseDir, [t.from_warehouse, t.from_cold_unit], [t.to_warehouse]) &&
    searchMatch(transferOutSearch, [
      t.challan_no, ...siteFields(t.from_warehouse, t.to_warehouse, t.from_cold_unit),
      t.stock_trf_date, t.status, t.vehicle_no, t.lot_numbers_text,
    ])
  ), [transfers, transferStatus, transferDateFrom, transferDateTo, warehouseFilter, warehouseDir, transferOutSearch]);

  // A GRN's From side is the dispatch's From and, for a cold dispatch, its units.
  const filteredTransferIns = useMemo(() => transferIns.filter((ti) =>
    (transferInStatus === "all" || ti.status === transferInStatus) &&
    inDateRange(isoDay(ti.grn_date), transferInDateFrom, transferInDateTo) &&
    warehouseMatchesDir(warehouseFilter, warehouseDir, [ti.from_warehouse, ti.from_cold_unit], [ti.receiving_warehouse]) &&
    searchMatch(transferInSearch, [
      ti.grn_number, ti.transfer_out_no, ...siteFields(ti.receiving_warehouse, ti.from_warehouse, ti.from_cold_unit),
      ti.received_by, ti.status, ti.grn_date,
    ])
  ), [transferIns, transferInStatus, transferInDateFrom, transferInDateTo, warehouseFilter, warehouseDir, transferInSearch]);

  // ── Incoming Material: dispatched transfer-OUTs that have no GRN started yet.
  //    A created transfer-out shows here automatically; once receiving begins it
  //    moves to the GRN list below (Resume), and once finalized it shows there as
  //    Received. "Material In" opens the interactive receive page for that transfer.
  //    IMS's older Completed / In Transit transfers are still in transit (the server's
  //    rule), and once IMS is closed only this list receives them.
  const grnOutIds = useMemo(
    () => new Set(transferIns.map((ti) => ti.transfer_out_id)), [transferIns]);
  const filteredIncoming = useMemo(() => transfers.filter((t) => {
    const s = (t.status || "").trim().toLowerCase();
    return s !== "received" && !grnOutIds.has(t.id) &&
      inDateRange(dmyToISO(t.stock_trf_date), transferInDateFrom, transferInDateTo) &&
      warehouseMatchesDir(warehouseFilter, warehouseDir, [t.from_warehouse, t.from_cold_unit], [t.to_warehouse]) &&
      searchMatch(transferInSearch, [
        t.challan_no, ...siteFields(t.from_warehouse, t.to_warehouse, t.from_cold_unit), t.stock_trf_date, t.vehicle_no,
      ]);
  }), [transfers, grnOutIds, transferInDateFrom, transferInDateTo, warehouseFilter, warehouseDir, transferInSearch]);

  // ── Ready to Send: approved requests the supplying store has not scanned and sent
  //    yet. Shown above the transfer list on the Transfer Out tab; once sent, the
  //    request turns Transferred and its dispatch joins the list below.
  const readyToSend = useMemo(() => requests.filter((r) =>
    r.status === REQUEST_STATUS.APPROVED &&
    warehouseMatchesDir(warehouseFilter, warehouseDir, [r.from_warehouse], [r.to_warehouse]) &&
    searchMatch(transferOutSearch, [r.request_no, ...siteFields(r.from_warehouse, r.to_warehouse), r.request_date, r.manager_decided_by])
  ), [requests, warehouseFilter, warehouseDir, transferOutSearch]);

  const pendingRequests = useMemo(
    () => requests.filter((r) => r.status === REQUEST_STATUS.PENDING).length, [requests]);
  const awaitingApproval = useMemo(
    () => requests.filter((r) => r.status === REQUEST_STATUS.ACCEPTED).length, [requests]);

  // Client-side pagination for the filtered Transfer-Out / Transfer-In tabs and
  // the (unfiltered) All-Transfers tab. Pages are clamped so a shrinking filter
  // never strands you on an empty page.
  const transfersTP = Math.max(1, Math.ceil(filteredTransfers.length / PER_PAGE));
  const toPage = Math.min(transfersPage, transfersTP);
  const pagedTransfers = filteredTransfers.slice((toPage - 1) * PER_PAGE, toPage * PER_PAGE);

  const allTransfersTP = Math.max(1, Math.ceil(transfers.length / PER_PAGE));
  const allPage = Math.min(transfersPage, allTransfersTP);
  const pagedAllTransfers = transfers.slice((allPage - 1) * PER_PAGE, allPage * PER_PAGE);

  const transferInsTP = Math.max(1, Math.ceil(filteredTransferIns.length / PER_PAGE));
  const tiPage = Math.min(transferInsPage, transferInsTP);
  const pagedTransferIns = filteredTransferIns.slice((tiPage - 1) * PER_PAGE, tiPage * PER_PAGE);

  // ── Delete handlers ──
  const confirmDelete = (msg: string) => typeof window !== "undefined" && window.confirm(msg);

  // A request may be deleted only while Pending (nobody has decided on it) or once
  // Rejected, and edited only while Pending by the person who raised it or an admin; the
  // server refuses the rest (409 / 403), these only decide which buttons show.
  const canDeleteRequest = (r: TransferRequest) =>
    canDelete && ([REQUEST_STATUS.PENDING, REQUEST_STATUS.REJECTED] as string[]).includes(r.status || REQUEST_STATUS.PENDING);
  const canEditRequest = (r: TransferRequest) =>
    (r.status || REQUEST_STATUS.PENDING) === REQUEST_STATUS.PENDING
    && (isAdmin || (!!email && (r.created_by || "").trim().toLowerCase() === email));

  const onDeleteRequest = async (id: number) => {
    if (!confirmDelete("Delete this request? This can't be undone.")) return;
    try { await TransferApi.deleteRequest(id); await loadRequests(); }
    catch (e) { fail(e, "Failed to delete request."); }
  };
  // A deleted transfer's request goes back to Approved (Ready to Send) on the server.
  const onDeleteTransfer = async (id: number) => {
    if (!confirmDelete("Delete this transfer? Its boxes come off the in-transit list, and if it was sent from a request, the request goes back to Ready to Send.")) return;
    try { await TransferApi.deleteTransfer(id); await loadTransfers(); await loadInTransitCount(); await loadRequests(); }
    catch (e) { fail(e, "Failed to delete transfer."); }
  };
  const onDeleteTransferIn = async (id: number) => {
    if (!confirmDelete("Delete this transfer-in?")) return;
    try { await TransferApi.deleteTransferIn(id); await loadTransferIns(); }
    catch (e) { fail(e, "Failed to delete transfer-in."); }
  };
  // Deleting an inner cold challan undoes it: its cold-stock rows get their old lots and
  // values back. The server refuses (409, shown here) when one of them has changed since.
  const onDeleteInnerCold = async (challanNo: string) => {
    if (!confirmDelete(`Delete inner cold transfer ${challanNo}? Its changes to cold stock are undone: the boxes go back to their old lots.`)) return;
    try { await TransferApi.deleteInnerCold(challanNo); await loadInnerCold(innerColdPage); }
    catch (e) { fail(e, "Failed to delete inner cold transfer."); }
  };

  // ── Request flow (migration 121) ──
  const askReason = (question: string): string | null => {
    const r = typeof window === "undefined" ? null : window.prompt(`${question}\n\nReason:`);
    if (r === null) return null;
    if (!r.trim()) { setError("A reason is needed."); return null; }
    return r.trim();
  };
  // Run one request's step, ignoring further clicks on that request until it is done.
  const oneAtATime = async (r: TransferRequest, step: () => Promise<void>) => {
    if (inFlight.current.has(r.id)) return;
    inFlight.current.add(r.id); setBusyIds(new Set(inFlight.current));
    try { await step(); }
    finally { inFlight.current.delete(r.id); setBusyIds(new Set(inFlight.current)); }
  };
  // Reload what the request's move touched: the requests, and once it has been scanned
  // and sent, the transfers and the in-transit count as well. True when all reloaded.
  const reloadAfter = async (fresh: TransferRequest | null): Promise<boolean> => {
    const ok = await loadRequests();
    if (fresh?.status !== REQUEST_STATUS.TRANSFERRED) return ok;
    const sent = await loadTransfers();
    await loadInTransitCount();
    return ok && sent;
  };
  // Before a request step, re-read the request from the server: if its status has moved
  // on since the list was loaded (someone else answered it, in another tab or another
  // channel), there is nothing to do. Say so and refresh rather than act on a stale row.
  const stillAt = async (r: TransferRequest): Promise<boolean> => {
    setError(null); setNotice(null);
    let fresh: TransferRequest;
    try { fresh = await TransferApi.getRequest(r.id); }
    catch (e) {
      // fetch throws a TypeError when the server cannot be reached. Anything else is the
      // server's answer about this request (a deleted one is not found), so the list is
      // refreshed under the message.
      if (e instanceof TypeError) {
        setError(`Could not reach the server to check request ${r.request_no}, so nothing was done. Try again.`);
      } else {
        await loadRequests();
        setError(`Could not check request ${r.request_no} (${e instanceof Error ? e.message : "unknown error"}), so nothing was done.`);
      }
      return false;
    }
    if (sameStatus(fresh, r)) return true;
    const reloaded = await reloadAfter(fresh);
    setNotice(alreadyDone(fresh, reloaded));
    return false;
  };
  // A refused step reloads too. If the request moved on in the meantime, that is the
  // reason and it is not an error; otherwise show the server's message. Both are set
  // after the reload, which clears them.
  // `target` is the stage the step takes the request to (requestStage: a status, or
  // STORE_HELD for the store's hold, which leaves it Pending).
  const runRequestStep = async (r: TransferRequest, target: string, step: () => Promise<unknown>, fallback: string) => {
    try { await step(); await loadRequests(); }
    catch (e) {
      const fresh = await TransferApi.getRequest(r.id).catch(() => null);
      const reloaded = await reloadAfter(fresh);
      if (fresh && !sameStatus(fresh, r)) {
        // Moved by this user to where this step was taking it: the step went through and
        // only its answer was lost on the way back, so it is done, not refused.
        if (!(requestStage(fresh) === target && email && decidedBy(fresh) === email)) setNotice(alreadyDone(fresh, reloaded));
      } else fail(e, fallback);
    }
  };
  const S = REQUEST_STATUS;
  const requestActions: RequestActions = {
    canStore: canAcceptRequests, canApprove: canApproveRequests, myEmail: email,
    isAdmin, myWarehouses: userWarehouses, busyIds,
    onAccept: (r) => oneAtATime(r, async () => {
      if (!(await stillAt(r))) return;
      if (!confirmDelete(`Accept request ${r.request_no}? It then goes to the inventory manager to approve or reject.`)) return;
      await runRequestStep(r, S.ACCEPTED, () => TransferApi.acceptRequest(r.id), "Failed to accept the request.");
    }),
    onStoreHold: (r) => oneAtATime(r, async () => {
      if (!(await stillAt(r))) return;
      const reason = askReason(`Put request ${r.request_no} on hold? It stays with the store, which can still accept or reject it.`);
      if (reason) await runRequestStep(r, STORE_HELD, () => TransferApi.storeHoldRequest(r.id, reason), "Failed to put the request on hold.");
    }),
    onStoreReject: (r) => oneAtATime(r, async () => {
      if (!(await stillAt(r))) return;
      const reason = askReason(`Reject request ${r.request_no}? It will be closed.`);
      if (reason) await runRequestStep(r, S.REJECTED, () => TransferApi.storeRejectRequest(r.id, reason), "Failed to reject the request.");
    }),
    onApprove: (r) => oneAtATime(r, async () => {
      if (!(await stillAt(r))) return;
      if (!confirmDelete(`Approve request ${r.request_no}? The store team can then scan and send it.`)) return;
      await runRequestStep(r, S.APPROVED, () => TransferApi.approveRequest(r.id), "Failed to approve the request.");
    }),
    onHold: (r) => oneAtATime(r, async () => {
      if (!(await stillAt(r))) return;
      const reason = askReason(`Put request ${r.request_no} on hold? It can still be approved or rejected later.`);
      if (reason) await runRequestStep(r, S.ON_HOLD, () => TransferApi.holdRequest(r.id, reason), "Failed to put the request on hold.");
    }),
    onReject: (r) => oneAtATime(r, async () => {
      if (!(await stillAt(r))) return;
      const reason = askReason(`Reject request ${r.request_no}? It will be closed.`);
      if (reason) await runRequestStep(r, S.REJECTED, () => TransferApi.rejectRequest(r.id, reason), "Failed to reject the request.");
    }),
    onSend: (r) => oneAtATime(r, async () => {
      if (await stillAt(r)) go(`/transferform?requestId=${r.id}`);
    }),
  };

  const go = (path: string) => router.push(`/modules/transfer${path}`);

  // No `if (!allowed) return null` gate: useRequireAuth returns true on the server but
  // false on the client's first render, so gating the render on it causes a hydration
  // mismatch. The `canOpen` guard below already protects the body; effects are gated on
  // `allowed` and the hook redirects unauthenticated users.

  if (!canOpen) {
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
        {warehouseOptions.map((c) => <option key={c} value={c}>{displaySite(c)}</option>)}
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
    <div className="flex flex-wrap gap-1">
      {REQUEST_FILTERS.map((s) => (
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

  const SearchBox = (value: string, setValue: (v: string) => void, placeholder: string) => (
    <div className="relative">
      <input
        value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder}
        className="border border-[var(--aws-border)] rounded px-2 py-1 text-[12px] w-full sm:w-64"
      />
      {value && (
        <button onClick={() => setValue("")} aria-label="Clear search"
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
          <button onClick={() => go("/request")}
            className="px-3 py-1.5 text-[12px] rounded bg-[var(--aws-navy)] text-white hover:opacity-90">New Request</button>
        </div>
      </div>

      {error && (
        <div className="mb-3 text-[12px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-2">{error}</div>
      )}
      {notice && (
        <div className="mb-3 text-[12px] text-sky-800 bg-sky-50 border border-sky-200 rounded px-3 py-2">{notice}</div>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-4">
        <StatCard label="Requests" value={requestsTotal} tone="text-[var(--text-primary)]" />
        <StatCard label="Pending" value={pendingRequests} tone="text-amber-600"
          onClick={() => { setActiveTab("request"); setRequestStatus(REQUEST_STATUS.PENDING); setRequestsPage(1); }} />
        <StatCard label="Awaiting Approval" value={awaitingApproval} tone="text-sky-700"
          onClick={() => { setActiveTab("request"); setRequestStatus(REQUEST_STATUS.ACCEPTED); setRequestsPage(1); }} />
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
              filterBar={<>{RequestStatusFilter}{SearchBox(requestSearch, setRequestSearch, "Search requests…")}{WarehouseSelect}</>}
              empty={filteredRequests.length === 0}
              emptyMsg="No requests found."
              pagination={<PaginationBar page={reqPage} totalPages={requestsTP} total={filteredRequests.length} onPage={setRequestsPage} />}
            >
              <div className={GRID_WRAP}>
              <table className={GRID_TABLE}>
                <thead><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
                  <th className="py-2">Request No</th><th>From</th><th>To</th><th>Date</th><th>Status</th><th></th>
                </tr></thead>
                <tbody>
                  {pagedRequests.map((r) => (
                    <tr key={r.id} className="border-b border-[var(--aws-border)]/50">
                      <td className="py-2 font-medium">
                        <ChallanHoverCard label={r.request_no} from={displayWarehouse(r.from_warehouse)} to={displayWarehouse(r.to_warehouse)}
                          reason={r.status} lines={requestHoverLines(r)} />
                      </td>
                      <td>{displayWarehouse(r.from_warehouse)}</td><td>{displayWarehouse(r.to_warehouse)}</td>
                      <td>{r.request_date}</td>
                      <td><StatusBadge status={r.status} /><RequestNote r={r} /><OwnRequestNote r={r} actions={requestActions} /></td>
                      <td className="text-right whitespace-nowrap">
                        <RequestButtons r={r} actions={requestActions} />
                        <RowBtn onClick={() => go(`/request/${r.id}`)}>View</RowBtn>
                        {canEditRequest(r) && <RowBtn onClick={() => go(`/request?editId=${r.id}`)}>Edit</RowBtn>}
                        {canDeleteRequest(r) && <RowBtn danger onClick={() => onDeleteRequest(r.id)}>Delete</RowBtn>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              <div className="md:hidden space-y-2">
                {pagedRequests.map((r) => (
                  <Card key={r.id}>
                    <CardHead title={r.request_no} status={r.status} />
                    <CardRow>{displayWarehouse(r.from_warehouse)} → {displayWarehouse(r.to_warehouse)} · {r.request_date}</CardRow>
                    <RequestNote r={r} />
                    <OwnRequestNote r={r} actions={requestActions} />
                    <CardActions>
                      <RequestButtons r={r} actions={requestActions} />
                      <RowBtn onClick={() => go(`/request/${r.id}`)}>View</RowBtn>
                      {canEditRequest(r) && <RowBtn onClick={() => go(`/request?editId=${r.id}`)}>Edit</RowBtn>}
                      {canDeleteRequest(r) && <RowBtn danger onClick={() => onDeleteRequest(r.id)}>Delete</RowBtn>}
                    </CardActions>
                  </Card>
                ))}
              </div>
            </Section>
          )}

          {/* Transfer Out */}
          {activeTab === "transferout" && (
            <>
            {/* Filters stay at the top of the tab. Search and the warehouse filter apply
                to both lists below; the status segment and dates apply to the transfers. */}
            <div className="flex flex-wrap items-center gap-2 mb-3">
              {TransferStatusFilter}
              {DateRange(transferDateFrom, setTransferDateFrom, transferDateTo, setTransferDateTo, () => setTransfersPage(1))}
              {SearchBox(transferOutSearch, setTransferOutSearch, "Search transfers…")}{WarehouseSelect}
            </div>

            <ReadyToSend rows={readyToSend} actions={requestActions} go={go} />

            <Section
              empty={filteredTransfers.length === 0}
              emptyMsg="No transfers found."
              pagination={<PaginationBar page={toPage} totalPages={transfersTP} total={filteredTransfers.length} onPage={setTransfersPage} />}
            >
              <TransferTable rows={pagedTransfers} go={go} canDelete={canDelete} onDelete={onDeleteTransfer} showActions receipts={grnOutIds} />
              <TransferCards rows={pagedTransfers} go={go} canDelete={canDelete} onDelete={onDeleteTransfer} showActions receipts={grnOutIds} />
            </Section>
            </>
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
              {SearchBox(transferInSearch, setTransferInSearch, "Search…")}{WarehouseSelect}
            </div>

            <IncomingMaterial rows={filteredIncoming} go={go} />

            <div className="bg-white border border-[var(--aws-border)] rounded-md">
              <div className="px-4 py-3 border-b border-[var(--aws-border)] text-[13px] font-semibold text-[var(--text-primary)]">
                Transfer-In Records ({filteredTransferIns.length})
              </div>
              <div className="p-3">
            <Section
              empty={filteredTransferIns.length === 0}
              emptyMsg="No transfer-ins found."
              pagination={<PaginationBar page={tiPage} totalPages={transferInsTP} total={filteredTransferIns.length} onPage={setTransferInsPage} />}
            >
              <div className={GRID_WRAP}>
              <table className={GRID_TABLE}>
                <thead><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
                  <th className="py-2">GRN</th><th>Transfer Out</th><th>From</th><th>Receiving</th><th>Boxes</th><th>Status</th><th></th>
                </tr></thead>
                <tbody>
                  {pagedTransferIns.map((ti) => (
                    <tr key={ti.id} className="border-b border-[var(--aws-border)]/50">
                      <td className="py-2 font-medium">
                        <ChallanHoverCard label={ti.grn_number} from={displayWarehouse(ti.from_warehouse)} to={displayWarehouse(ti.receiving_warehouse)}
                          fetchLines={() => TransferApi.getTransferIn(ti.id).then(transferInHoverData)} />
                      </td>
                      <td>{ti.transfer_out_no}</td><td>{displayWarehouse(ti.from_warehouse) || "—"}</td>
                      <td>{displayWarehouse(ti.receiving_warehouse)}</td><td>{ti.total_boxes_scanned}</td>
                      <td><StatusBadge status={ti.status} /></td>
                      <td className="text-right whitespace-nowrap">
                        {ti.status?.toLowerCase() === "pending" &&
                          <RowBtn onClick={() => go(`/transferIn?resume=${encodeURIComponent(ti.transfer_out_no)}`)}>Resume</RowBtn>}
                        <RowBtn onClick={() => go(`/transferIn/${ti.id}`)}>View</RowBtn>
                        {canDelete && <RowBtn danger onClick={() => onDeleteTransferIn(ti.id)}>Delete</RowBtn>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              <div className="md:hidden space-y-2">
                {pagedTransferIns.map((ti) => (
                  <Card key={ti.id}>
                    <CardHead title={ti.grn_number} status={ti.status} />
                    <CardRow>{ti.transfer_out_no} · {displayWarehouse(ti.receiving_warehouse)} · {ti.total_boxes_scanned} boxes</CardRow>
                    <CardActions>
                      <RowBtn onClick={() => go(`/transferIn/${ti.id}`)}>View</RowBtn>
                      {canDelete && <RowBtn danger onClick={() => onDeleteTransferIn(ti.id)}>Delete</RowBtn>}
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
              pagination={<PaginationBar page={innerColdPage} totalPages={innerColdTP} total={innerCold.length} onPage={loadInnerCold} />}
            >
              <div className={GRID_WRAP}>
              <table className={GRID_TABLE}>
                <thead><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
                  <th className="py-2">Challan</th><th>Date</th><th>From</th><th>Lines</th><th>Boxes</th><th>Status</th><th></th>
                </tr></thead>
                <tbody>
                  {innerCold.map((c) => (
                    <tr key={c.challan_no} className="border-b border-[var(--aws-border)]/50">
                      <td className="py-2 font-medium">
                        <ChallanHoverCard label={c.challan_no || "—"} from={displayWarehouse(c.from_warehouse)} to={displayWarehouse(c.from_warehouse)}
                          reason={c.reason_code} lines={innerColdHoverLines(c)} />
                      </td>
                      <td>{c.transfer_date}</td><td>{displayWarehouse(c.from_warehouse)}</td>
                      <td>{c.line_count}</td><td>{c.total_boxes ?? "—"}</td>
                      <td><StatusBadge status={c.status} /></td>
                      <td className="text-right whitespace-nowrap">
                        <RowBtn onClick={() => go(`/innercoldtransfer?editChallan=${encodeURIComponent(c.challan_no || "")}`)}>Edit</RowBtn>
                        {canDelete && c.challan_no &&
                          <RowBtn danger onClick={() => onDeleteInnerCold(c.challan_no!)}>Delete</RowBtn>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              <div className="md:hidden space-y-2">
                {innerCold.map((c) => (
                  <Card key={c.challan_no}>
                    <CardHead title={c.challan_no || "—"} status={c.status} />
                    <CardRow>{displayWarehouse(c.from_warehouse)} · {c.line_count} lines · {c.total_boxes ?? "—"} boxes</CardRow>
                    <CardActions>
                      <RowBtn onClick={() => go(`/innercoldtransfer?editChallan=${encodeURIComponent(c.challan_no || "")}`)}>Edit</RowBtn>
                      {canDelete && c.challan_no &&
                        <RowBtn danger onClick={() => onDeleteInnerCold(c.challan_no!)}>Delete</RowBtn>}
                    </CardActions>
                  </Card>
                ))}
              </div>
            </Section>
          )}

          {/* All Transfers (shares `transfers`, unfiltered) */}
          {activeTab === "details" && (
            <Section empty={transfers.length === 0} emptyMsg="No transfers found."
              pagination={<PaginationBar page={allPage} totalPages={allTransfersTP} total={transfers.length} onPage={setTransfersPage} />}>
              <TransferTable rows={pagedAllTransfers} go={go} canDelete={false} onDelete={onDeleteTransfer} showActions={false} />
              <TransferCards rows={pagedAllTransfers} go={go} canDelete={false} onDelete={onDeleteTransfer} showActions={false} />
            </Section>
          )}
        </>
      )}

      <PendingTransfersModal
        open={pendingOpen}
        onClose={() => { setPendingOpen(false); loadInTransitCount(); }}
        canCancel={canDelete}
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

// ── Request flow (backend migrations 121, 127) ───────────────────────────
// Pending → Accepted (store) → Approved (inventory manager) → Transferred (the store
// scans and sends). Rejected ends it: the store rejects a Pending request, the inventory
// manager an Accepted or On Hold one. The store may hold a Pending request (it stays
// Pending, marked held) and an inventory manager an Accepted one (it turns On Hold).
// "Open" = everything still in progress.
const REQUEST_FILTERS = ["Open", "Pending", "Accepted", "On Hold", "Approved", "Transferred", "Rejected", "All"] as const;
type RequestFilter = (typeof REQUEST_FILTERS)[number];

function requestMatchesFilter(r: TransferRequest, f: RequestFilter): boolean {
  if (f === "All") return true;
  if (f === "Open") return r.status !== REQUEST_STATUS.TRANSFERRED && r.status !== REQUEST_STATUS.REJECTED;
  return r.status === f;
}

type RequestActions = {
  canStore: boolean; canApprove: boolean; myEmail: string;
  isAdmin: boolean; myWarehouses: string[]; busyIds: ReadonlySet<number>;
  onAccept: (r: TransferRequest) => void; onStoreHold: (r: TransferRequest) => void;
  onStoreReject: (r: TransferRequest) => void;
  onApprove: (r: TransferRequest) => void; onHold: (r: TransferRequest) => void;
  onReject: (r: TransferRequest) => void;
  onSend: (r: TransferRequest) => void;
};

// The stage a request is at: its status, or STORE_HELD for a Pending one the store has
// put on hold (still Pending on the server, but a hold made elsewhere must not look like
// nothing changed).
const STORE_HELD = "Pending (held by the store)";
function requestStage(r: TransferRequest): string {
  return isStoreHeld(r) ? STORE_HELD : (r.status || REQUEST_STATUS.PENDING);
}
// Has the request kept the stage this row was showing? A NULL status reads as Pending,
// as the server treats it.
function sameStatus(fresh: TransferRequest, shown: TransferRequest): boolean {
  return requestStage(fresh) === requestStage(shown);
}
// The email of whoever moved the request to its current stage ("" for none).
function decidedBy(r: TransferRequest): string {
  const S = REQUEST_STATUS;
  const by =
    isStoreHeld(r) || r.status === S.ACCEPTED || (r.status === S.REJECTED && r.manager_decision !== "Rejected")
      ? r.store_decided_by
      : r.status === S.ON_HOLD || r.status === S.APPROVED || r.status === S.REJECTED ? r.manager_decided_by
        : null;
  return (by || "").trim().toLowerCase();
}
// What already happened to a request whose row was stale, for the notice.
function alreadyDone(r: TransferRequest, refreshed: boolean): string {
  const S = REQUEST_STATUS;
  const what =
    isStoreHeld(r) ? `put on hold by ${r.store_decided_by || "the store"}`
      : r.status === S.ACCEPTED ? `accepted by ${r.store_decided_by || "the store"}`
        : r.status === S.ON_HOLD ? `put on hold by ${r.manager_decided_by || "an inventory manager"}`
          : r.status === S.APPROVED ? `approved by ${r.manager_decided_by || "an inventory manager"}`
            : r.status === S.REJECTED && r.manager_decision === "Rejected" ? `rejected by ${r.manager_decided_by || "an inventory manager"}`
              : r.status === S.REJECTED ? `rejected by ${r.store_decided_by || "the store"}`
                : r.status === S.TRANSFERRED ? "scanned and sent"
                  : r.status === S.PENDING || !r.status ? "taken off hold (it is waiting for the store again)"
                    : `now ${r.status}`;
  return `Request ${r.request_no} was already ${what}, so nothing was done.${refreshed ? " The list has been refreshed." : ""}`;
}
// Nobody decides a request they raised or accepted (the server refuses it too).
// Compared as the server compares them: trimmed, case-insensitive, and an account
// with no email is the "unknown" the server records for it on a request. Such an
// account cannot be told apart from another one, so it gets the server's own wording.
function ownRequestReason(r: TransferRequest, myEmail: string): string | null {
  const mine = myEmail.trim();
  const me = mine || "unknown";
  const raised = (r.created_by || "").trim().toLowerCase() === me;
  const accepted = (r.store_decided_by || "").trim().toLowerCase() === me;
  if (!mine && (raised || accepted)) {
    return "Your account has no email address, so it cannot be told apart from the account that " +
      "raised or accepted this request: an inventory manager whose account has an email " +
      "address has to approve or reject it";
  }
  if (raised) return "You raised this request, so another inventory manager has to approve or reject it";
  if (accepted) return "You accepted this request for the store, so another inventory manager has to approve or reject it";
  return null;
}

// Warehouse lock: a store user tied to warehouses answers and sends only the requests
// to be sent from one of them, compared as sites (the grant "D-39" is "Savla D-39",
// "A185" is "Warehouse A185"), as the server compares them. Admins, and users with no
// warehouse, handle any.
function suppliesFromMySite(r: TransferRequest, a: RequestActions): boolean {
  return a.isAdmin || a.myWarehouses.length === 0 || userHasWarehouse(a.myWarehouses, r.from_warehouse);
}
// The supplying store scans and sends an Approved request.
function canSendRequest(r: TransferRequest, a: RequestActions): boolean {
  return a.canStore && r.status === REQUEST_STATUS.APPROVED && suppliesFromMySite(r, a);
}

// What this user may do with a request now. The server enforces the same rules
// (warehouse, and nobody approves a request they raised or accepted).
function RequestButtons({ r, actions: a }: { r: TransferRequest; actions: RequestActions }) {
  const status = r.status || REQUEST_STATUS.PENDING;
  const busy = a.busyIds.has(r.id);
  if (a.canStore && suppliesFromMySite(r, a) && status === REQUEST_STATUS.PENDING) {
    // A request the store has held can still be accepted or rejected, not held again.
    return (
      <>
        <RowBtn primary disabled={busy} onClick={() => a.onAccept(r)}>Accept</RowBtn>
        {!isStoreHeld(r) && <RowBtn disabled={busy} onClick={() => a.onStoreHold(r)}>Hold</RowBtn>}
        <RowBtn danger disabled={busy} onClick={() => a.onStoreReject(r)}>Reject</RowBtn>
      </>
    );
  }
  if (a.canApprove && (status === REQUEST_STATUS.ACCEPTED || status === REQUEST_STATUS.ON_HOLD)) {
    // An approver who raised or accepted the request still sees the buttons, greyed
    // with the reason (OwnRequestNote shows it too), so the request does not look stuck.
    // An On Hold request can be approved or rejected, not held again.
    const own = ownRequestReason(r, a.myEmail);
    return (
      <>
        <RowBtn primary disabled={!!own || busy} title={own} onClick={() => a.onApprove(r)}>Approve</RowBtn>
        {status === REQUEST_STATUS.ACCEPTED &&
          <RowBtn disabled={!!own || busy} title={own} onClick={() => a.onHold(r)}>Hold</RowBtn>}
        <RowBtn danger disabled={!!own || busy} title={own} onClick={() => a.onReject(r)}>Reject</RowBtn>
      </>
    );
  }
  if (canSendRequest(r, a)) {
    return <RowBtn primary disabled={busy} onClick={() => a.onSend(r)}>Scan &amp; send</RowBtn>;
  }
  return null;
}

// Why RequestButtons greyed Approve / Reject, under the status badge: in the action
// cell the sentence split the buttons and widened the column. Capped so it wraps.
function OwnRequestNote({ r, actions: a }: { r: TransferRequest; actions: RequestActions }) {
  const decidable = r.status === REQUEST_STATUS.ACCEPTED || r.status === REQUEST_STATUS.ON_HOLD;
  const own = a.canApprove && decidable ? ownRequestReason(r, a.myEmail) : null;
  if (!own) return null;
  return <span className="block max-w-[18rem] text-[11px] mt-0.5 text-[var(--text-secondary)]">{own}.</span>;
}

// Who moved the request to where it is, and why, under its status badge.
function RequestNote({ r }: { r: TransferRequest }) {
  let text: string | null = null;
  let tone = "text-[var(--text-secondary)]";
  if (isStoreHeld(r)) {
    text = `On hold by the store (${r.store_decided_by || "store"}): ${r.store_hold_reason || "—"}`; tone = "text-orange-700";
  } else if (r.status === REQUEST_STATUS.ON_HOLD) {
    text = `On hold by ${r.manager_decided_by || "inventory manager"}: ${r.manager_hold_reason || "—"}`; tone = "text-orange-700";
  } else if (r.status === REQUEST_STATUS.ACCEPTED) {
    text = `Accepted by ${r.store_decided_by || "store"}`;
  } else if (r.status === REQUEST_STATUS.APPROVED) {
    text = `Approved by ${r.manager_decided_by || "inventory manager"}`; tone = "text-emerald-700";
  } else if (r.status === REQUEST_STATUS.REJECTED && r.manager_decision === "Rejected") {
    text = `Rejected by ${r.manager_decided_by || "inventory manager"}: ${r.manager_reject_reason || "—"}`; tone = "text-rose-700";
  } else if (r.status === REQUEST_STATUS.REJECTED && r.store_decision === "Rejected") {
    text = `Rejected by ${r.store_decided_by || "store"}: ${r.store_reject_reason || "—"}`; tone = "text-rose-700";
  } else if (r.status === REQUEST_STATUS.REJECTED) {
    // Rejected before migration 121: only the legacy reject_reason, which the backend
    // still returns.
    text = `Rejected: ${r.reject_reason || "—"}`; tone = "text-rose-700";
  }
  if (!text) return null;
  return <span className={`block text-[11px] mt-0.5 ${tone}`}>{text}</span>;
}

// ── Row/section building blocks ──────────────────────────────────────────
function RowBtn({ children, onClick, disabled, danger, primary, title }: {
  children: React.ReactNode; onClick?: () => void; disabled?: boolean; danger?: boolean; primary?: boolean;
  title?: string | null;
}) {
  return (
    <button onClick={onClick} disabled={disabled} title={title ?? undefined}
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
function ItemsBadges({ items, qty }: { items: number; qty: number }) {
  return (
    <span className="inline-flex items-center gap-1 flex-wrap">
      <span className="px-1.5 py-0.5 rounded text-[11px] bg-blue-50 text-blue-700 border border-blue-200">
        {items} Item{items !== 1 ? "s" : ""}
      </span>
      <span className="px-1.5 py-0.5 rounded text-[11px] bg-amber-50 text-amber-700 border border-amber-200">
        Qty: {qty || 0}
      </span>
    </span>
  );
}

// Scan & send saves each box as it is scanned, so a request's transfer that is still out
// (Dispatch / Partial) can be reopened there to scan more of the request's boxes. The
// server refuses one that has been received meanwhile.
function canScanMore(t: TransferListItem): boolean {
  return t.request_id != null && (t.status === "Dispatch" || t.status === "Partial");
}
function scanMorePath(t: TransferListItem): string {
  return `/transferform?requestId=${t.request_id}`;
}

// The Edit form saves only a transfer still out, as the server allows (else 409): an
// in-transit status (Dispatch / Partial, or IMS's older In Transit / Completed) and no
// receipt begun (`receipts`: the transfer-OUT ids with a GRN).
const NO_RECEIPTS: ReadonlySet<number> = new Set();
function canEdit(t: TransferListItem, receipts: ReadonlySet<number>): boolean {
  return isInTransitStatus(t.status) && !receipts.has(t.id);
}

function TransferTable({ rows, go, canDelete, onDelete, showActions, receipts = NO_RECEIPTS }: {
  rows: TransferListItem[]; go: (p: string) => void; canDelete: boolean; onDelete: (id: number) => void; showActions: boolean;
  receipts?: ReadonlySet<number>;
}) {
  return (
    <div className={GRID_WRAP}>
    <table className={GRID_TABLE}>
      <thead><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
        <th className="py-2">Challan</th><th>Status</th><th>Route</th><th>Date</th><th>Vehicle</th><th>Items/Boxes</th><th></th>
      </tr></thead>
      <tbody>
        {rows.map((t) => (
          <tr key={t.id} className="border-b border-[var(--aws-border)]/50">
            <td className="py-2 font-medium">
              <ChallanHoverCard label={t.challan_no} from={displayWarehouse(t.from_warehouse)} to={displayWarehouse(t.to_warehouse)}
                fetchLines={() => TransferApi.getTransfer(t.id).then(transferHoverData)} />
            </td>
            <td><StatusBadge status={t.status} /></td>
            <td className="whitespace-nowrap">{displayWarehouse(t.from_warehouse)} → {displayWarehouse(t.to_warehouse)}</td>
            <td>{formatDate(t.stock_trf_date)}</td>
            <td>
              {t.vehicle_no || "—"}
              {t.driver_name && <span className="block text-[11px] text-[var(--text-secondary)]">{t.driver_name}</span>}
            </td>
            <td><ItemsBadges items={t.items_count} qty={t.total_qty} /></td>
            <td className="text-right whitespace-nowrap">
              <RowBtn onClick={() => go(`/view/${t.id}`)}>View</RowBtn>
              {showActions && canScanMore(t) && <RowBtn onClick={() => go(scanMorePath(t))}>Scan more</RowBtn>}
              {showActions && <RowBtn disabled={!canEdit(t, receipts)}
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
function IncomingMaterial({ rows, go }: { rows: TransferListItem[]; go: (p: string) => void }) {
  if (rows.length === 0) return null;
  const receive = (t: TransferListItem) => go(`/transferIn?resume=${encodeURIComponent(t.challan_no)}`);
  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md mb-4">
      <div className="px-4 py-3 border-b border-[var(--aws-border)] flex items-center justify-between">
        <span className="text-[13px] font-semibold text-[var(--text-primary)]">Incoming Material ({rows.length})</span>
        <span className="text-[11px] text-[var(--text-secondary)]">Dispatched transfers awaiting receipt</span>
      </div>
      <div className={`${GRID_WRAP} p-3`}>
      <table className={GRID_TABLE}>
        <thead><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
          <th>Challan</th><th>Route</th><th>Date</th><th>Vehicle</th><th>Items/Boxes</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} className="border-b border-[var(--aws-border)]/50">
              <td className="font-mono font-medium">{t.challan_no}</td>
              <td className="whitespace-nowrap">{displayWarehouse(t.from_warehouse)} → {displayWarehouse(t.to_warehouse)}</td>
              <td>{formatDate(t.stock_trf_date)}</td>
              <td>{t.vehicle_no || "—"}</td>
              <td><ItemsBadges items={t.items_count} qty={t.total_qty} /></td>
              <td><StatusBadge status={t.status} /></td>
              <td className="text-right whitespace-nowrap">
                <RowBtn onClick={() => go(`/view/${t.id}`)}>View</RowBtn>
                <RowBtn primary onClick={() => receive(t)}>Transfer In</RowBtn>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
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
            <div className="mt-1"><ItemsBadges items={t.items_count} qty={t.total_qty} /></div>
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

// Ready to Send — requests an inventory manager has approved that the supplying store
// has not scanned and sent yet. Scan & send opens the dispatch form for the request
// (/transferform?requestId=…), shown only to the store of the supplying warehouse.
function ReadyToSend({ rows, actions: a, go }: {
  rows: TransferRequest[]; actions: RequestActions; go: (p: string) => void;
}) {
  if (rows.length === 0) return null;
  const qty = (r: TransferRequest) => r.lines.reduce((s, l) => s + (Number(l.quantity) || 0), 0);
  const approved = (r: TransferRequest) =>
    [r.manager_decided_by, r.manager_decided_at ? formatDate(r.manager_decided_at) : null].filter(Boolean).join(" · ") || "—";
  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md mb-4">
      <div className="px-4 py-3 border-b border-[var(--aws-border)] flex items-center justify-between">
        <span className="text-[13px] font-semibold text-[var(--text-primary)]">Ready to Send ({rows.length})</span>
        <span className="text-[11px] text-[var(--text-secondary)]">Approved requests waiting to be scanned and sent</span>
      </div>
      <div className={`${GRID_WRAP} p-3`}>
      <table className={GRID_TABLE}>
        <thead><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
          <th>Request</th><th>Route</th><th>Request Date</th><th>Items</th><th>Approved by</th><th></th>
        </tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-[var(--aws-border)]/50">
              <td className="font-medium">
                <ChallanHoverCard label={r.request_no} from={displayWarehouse(r.from_warehouse)} to={displayWarehouse(r.to_warehouse)}
                  reason={r.reason_description} lines={requestHoverLines(r)} />
              </td>
              <td className="whitespace-nowrap">{displayWarehouse(r.from_warehouse)} → {displayWarehouse(r.to_warehouse)}</td>
              <td>{formatDate(r.request_date)}</td>
              <td><ItemsBadges items={r.lines.length} qty={qty(r)} /></td>
              <td>{approved(r)}</td>
              <td className="text-right whitespace-nowrap">
                <RowBtn onClick={() => go(`/request/${r.id}`)}>View</RowBtn>
                {canSendRequest(r, a) && <RowBtn primary disabled={a.busyIds.has(r.id)} onClick={() => a.onSend(r)}>Scan &amp; send</RowBtn>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <div className="md:hidden p-3 space-y-2">
        {rows.map((r) => (
          <div key={r.id} className="border border-[var(--aws-border)] rounded-md p-2">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[12px] font-medium">{r.request_no}</span>
              <StatusBadge status={r.status} />
            </div>
            <div className="text-[11px] text-[var(--text-secondary)]">
              {displayWarehouse(r.from_warehouse)} → {displayWarehouse(r.to_warehouse)} · {formatDate(r.request_date)}
            </div>
            <div className="text-[11px] text-[var(--text-secondary)]">Approved by {approved(r)}</div>
            <div className="mt-1"><ItemsBadges items={r.lines.length} qty={qty(r)} /></div>
            <div className="mt-2 flex flex-wrap gap-1">
              <RowBtn onClick={() => go(`/request/${r.id}`)}>View</RowBtn>
              {canSendRequest(r, a) && <RowBtn primary disabled={a.busyIds.has(r.id)} onClick={() => a.onSend(r)}>Scan &amp; send</RowBtn>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TransferCards({ rows, go, canDelete, onDelete, showActions, receipts = NO_RECEIPTS }: {
  rows: TransferListItem[]; go: (p: string) => void; canDelete: boolean; onDelete: (id: number) => void; showActions: boolean;
  receipts?: ReadonlySet<number>;
}) {
  return (
    <div className="md:hidden space-y-2">
      {rows.map((t) => (
        <Card key={t.id}>
          <CardHead title={t.challan_no} status={t.status} />
          <CardRow>{displayWarehouse(t.from_warehouse)} → {displayWarehouse(t.to_warehouse)} · {formatDate(t.stock_trf_date)}{t.vehicle_no ? ` · ${t.vehicle_no}` : ""}</CardRow>
          <div className="mt-1"><ItemsBadges items={t.items_count} qty={t.total_qty} /></div>
          <CardActions>
            <RowBtn onClick={() => go(`/view/${t.id}`)}>View</RowBtn>
            {showActions && canScanMore(t) && <RowBtn onClick={() => go(scanMorePath(t))}>Scan more</RowBtn>}
            {showActions && <RowBtn disabled={!canEdit(t, receipts)}
              onClick={() => go(`/directtransferform?editId=${t.id}`)}>Edit</RowBtn>}
            <RowBtn onClick={() => go(`/dc/${t.id}`)}>DC</RowBtn>
            {showActions && canDelete && <RowBtn danger onClick={() => onDelete(t.id)}>Delete</RowBtn>}
          </CardActions>
        </Card>
      ))}
    </div>
  );
}
