"use client";

// Customer-Returns list / index — a faithful port of the legacy-frontend list
// page (app/[company]/customer-returns/page.tsx): icon status-tabs, the rich
// CR-No hover card, the full desktop column set + per-row actions, mobile cards,
// pagination and the delete dialog. Wired to the LIVE endpoints, which mirror the
// legacy /rtv routes 1:1 (list/delete/export) — keyed by rtv_id (the CR- string)
// since the live backend has no numeric id. web_replica idiom: maroon --aws
// tokens, inline SVG icons (no lucide), native date fmt (no date-fns), apiFetch.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRequireAuth, useIsAdmin } from "@/lib/user";
import { getDisplayWarehouseName } from "@/lib/transferBuildSummary";
import {
  listCustomerReturns,
  deleteCustomerReturn,
  exportCustomerReturns,
  toApiDate,
  CR_READ_ONLY,
  type CRListItem,
  type CRStatus,
} from "@/lib/customer-returns";
import { CustomerReturnsChrome } from "./_chrome";
import { CompanyToggle, StatusBadge, ErrorBanner, ConfirmDialog, useCompany, cx, fmtDate, fmtDateTime } from "./_shared";

const PER_PAGE = 20;

// ── Inline SVG icons (lucide look; no lucide dep in web_replica) ──────────────
type IconProps = { className?: string };
const S = ({ className, children }: IconProps & { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className ?? "h-3.5 w-3.5"} aria-hidden="true">{children}</svg>
);
const IconAll = (p: IconProps) => <S {...p}><path d="M3 2v6h6" /><path d="M3 13a9 9 0 1 0 3-7.7L3 8" /></S>;
const IconClock = (p: IconProps) => <S {...p}><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></S>;
const IconCheckCircle = (p: IconProps) => <S {...p}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><path d="m9 11 3 3L22 4" /></S>;
const IconCheckCheck = (p: IconProps) => <S {...p}><path d="M18 6 7 17l-5-5" /><path d="m22 10-7.5 7.5L13 16" /></S>;
const IconSearch = (p: IconProps) => <S {...p}><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></S>;
const IconDownload = (p: IconProps) => <S {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" /></S>;
const IconX = (p: IconProps) => <S {...p}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></S>;
const IconChevronLeft = (p: IconProps) => <S {...p}><path d="m15 18-6-6 6-6" /></S>;
const IconChevronRight = (p: IconProps) => <S {...p}><path d="m9 18 6-6-6-6" /></S>;
const IconEye = (p: IconProps) => <S {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></S>;
const IconPencil = (p: IconProps) => <S {...p}><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></S>;
const IconTrash = (p: IconProps) => <S {...p}><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></S>;
const IconSpinner = (p: IconProps) => <S {...(p.className ? p : { className: "h-3.5 w-3.5 animate-spin" })}><path d="M21 12a9 9 0 1 1-6.219-8.56" /></S>;

const STATUS_TABS: { label: string; value: CRStatus | "all"; Icon: (p: IconProps) => React.ReactElement; color: string }[] = [
  { label: "All", value: "all", Icon: IconAll, color: "text-[var(--text-primary)]" },
  { label: "Pending", value: "Pending", Icon: IconClock, color: "text-[#b45309]" },
  { label: "Approved", value: "Approved", Icon: IconCheckCircle, color: "text-[var(--text-success)]" },
  { label: "Submitted", value: "Submitted", Icon: IconCheckCheck, color: "text-[#2c5fa8]" },
];

// ── CR No hover card — pastel roll-up shown on hover (mouse) / tap (touch) ─────
function toneChip(tone: "blue" | "sky" | "emerald" | "amber" | "gray" | "violet") {
  const map = {
    blue: "bg-blue-50 text-blue-700 border-blue-200",
    sky: "bg-sky-50 text-sky-700 border-sky-200",
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    gray: "bg-gray-50 text-gray-700 border-gray-200",
    violet: "bg-violet-50 text-violet-700 border-violet-200",
  };
  return `text-[10px] font-medium px-1.5 py-0.5 rounded border ${map[tone]}`;
}

function CustomerReturnCard({ item }: { item: CRListItem }) {
  return (
    <div
      className="w-full rounded-2xl overflow-hidden text-xs max-h-[480px] flex flex-col"
      style={{
        background: "linear-gradient(135deg, #eff6ff 0%, #ffffff 45%, #faf5ff 100%)",
        boxShadow: "0 20px 40px -10px rgba(79,70,229,0.22), 0 8px 16px -4px rgba(236,72,153,0.14), 0 0 0 1px rgba(147,197,253,0.45)",
      }}
    >
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-blue-100/60">
        <div className="flex items-center justify-between gap-2">
          <p className="font-semibold text-[13px] text-gray-800">{item.rtv_id}</p>
          <StatusBadge status={item.status} />
        </div>
        <p className="text-[10px] text-gray-500 mt-0.5">
          {fmtDate(item.rtv_date)}
          {item.customer ? ` · ${item.customer}` : ""}
        </p>
      </div>

      <div className="px-3 py-2.5 space-y-2 overflow-y-auto flex-1">
        {/* Parties / unit */}
        {(item.customer || item.factory_unit || item.business_head || item.conversion) && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {item.customer && <span className={toneChip("gray")}><span className="opacity-60">Customer:</span> {item.customer}</span>}
            {item.factory_unit && <span className={toneChip("blue")}><span className="opacity-60">Unit:</span> {getDisplayWarehouseName(item.factory_unit)}</span>}
            {item.business_head && <span className={toneChip("violet")}><span className="opacity-60">Head:</span> {item.business_head}</span>}
            {item.conversion && item.conversion !== "0" && <span className={toneChip("amber")}><span className="opacity-60">Conv:</span> {item.conversion}</span>}
          </div>
        )}

        {/* Metrics */}
        <div className="flex flex-wrap items-center gap-2 pt-1.5 border-t border-blue-100/50 text-[11px]">
          <span className="text-gray-500">Items: <span className="font-semibold text-gray-700">{item.items_count}</span></span>
          <span className="text-gray-500">Boxes: <span className="font-semibold text-gray-700">{item.boxes_count}</span></span>
          {item.total_qty != null && <span className="text-gray-500">Qty: <span className="font-semibold text-gray-700">{item.total_qty}</span></span>}
          {item.total_net_weight != null && <span className="text-gray-500">Net: <span className="font-semibold text-gray-700">{item.total_net_weight} kg</span></span>}
        </div>

        {/* Transport / handling */}
        {(item.vehicle_number || item.transporter_name || item.driver_name || item.inward_manager) && (
          <div className="pt-1.5 border-t border-blue-100/50 flex flex-wrap gap-1">
            {item.vehicle_number && <span className={toneChip("sky")}><span className="opacity-60">Vehicle:</span> {item.vehicle_number}</span>}
            {item.transporter_name && <span className={toneChip("sky")}><span className="opacity-60">Transporter:</span> {item.transporter_name}</span>}
            {item.driver_name && <span className={toneChip("sky")}><span className="opacity-60">Driver:</span> {item.driver_name}</span>}
            {item.inward_manager && <span className={toneChip("blue")}><span className="opacity-60">Inward Mgr:</span> {item.inward_manager}</span>}
          </div>
        )}

        {/* Footer */}
        {(item.created_by || item.created_ts || item.updated_at) && (
          <div className="pt-1.5 border-t border-blue-100/50 space-y-0.5 text-[10px]">
            {item.created_by && (
              <div className="flex justify-between gap-2"><span className="text-gray-600">Created by</span><span className="font-medium text-gray-800">{item.created_by}</span></div>
            )}
            {item.created_ts && (
              <div className="flex justify-between gap-2"><span className="text-gray-600">Created</span><span className="font-medium text-gray-800">{fmtDateTime(item.created_ts)}</span></div>
            )}
            {item.updated_at && (
              <div className="flex justify-between gap-2"><span className="text-gray-600">Updated</span><span className="font-medium text-gray-800">{fmtDateTime(item.updated_at)}</span></div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CustomerReturnHoverPortal({ item }: { item: CRListItem }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; maxHeight: number }>({ left: 0, maxHeight: 480 });
  const [isTouch, setIsTouch] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);

  const CARD_WIDTH = 360;
  const MARGIN = 8;
  const GAP = 6;
  const cardId = `cr-hovercard-${item.rtv_id}`;

  // Devices without a real mouse (hover: none) get tap-to-open instead of hover.
  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia) {
      queueMicrotask(() => setIsTouch(!window.matchMedia("(hover: hover)").matches));
    }
  }, []);

  const computePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = rect.left;
    if (left + CARD_WIDTH > vw - MARGIN) left = Math.max(MARGIN, vw - CARD_WIDTH - MARGIN);
    if (left < MARGIN) left = MARGIN;

    const spaceAbove = rect.top - MARGIN;
    const spaceBelow = vh - rect.bottom - MARGIN;
    const maxHeight = Math.min(480, spaceAbove >= spaceBelow ? spaceAbove - GAP : spaceBelow - GAP);

    if (spaceAbove >= spaceBelow && spaceAbove >= 100) setPos({ bottom: vh - rect.top + GAP, left, maxHeight });
    else setPos({ top: rect.bottom + GAP, left, maxHeight });
  }, []);

  const open = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    computePosition();
    setShow(true);
  }, [computePosition]);

  const scheduleClose = useCallback(() => { hideTimer.current = setTimeout(() => setShow(false), 180); }, []);
  const cancelClose = useCallback(() => { if (hideTimer.current) clearTimeout(hideTimer.current); }, []);

  // While open: close on outside tap (touch) and on scroll/resize (both modes).
  useEffect(() => {
    if (!show) return;
    const onPointerDown = (e: Event) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (document.getElementById(cardId)?.contains(t)) return;
      setShow(false);
    };
    // Capture-phase catches scrolls from descendants too; ignore scrolls that
    // originate inside the (overflow-y:auto) card body so it doesn't self-dismiss.
    const onScrollResize = (e: Event) => {
      if (e.type === "scroll" && document.getElementById(cardId)?.contains(e.target as Node)) return;
      setShow(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScrollResize, true);
    window.addEventListener("resize", onScrollResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScrollResize, true);
      window.removeEventListener("resize", onScrollResize);
    };
  }, [show, cardId]);

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={() => { if (!isTouch) open(); }}
        onMouseLeave={() => { if (!isTouch) scheduleClose(); }}
        onClick={() => { if (isTouch) { if (show) setShow(false); else open(); } }}
        className="font-medium cursor-pointer underline-offset-2 hover:underline text-[var(--aws-link)]"
      >
        {item.rtv_id}
      </span>
      {show && typeof document !== "undefined" && createPortal(
        <div
          id={cardId}
          onMouseEnter={() => { if (!isTouch) cancelClose(); }}
          onMouseLeave={() => { if (!isTouch) scheduleClose(); }}
          style={{
            position: "fixed",
            ...(pos.bottom !== undefined ? { bottom: pos.bottom } : { top: pos.top }),
            left: pos.left,
            width: Math.min(CARD_WIDTH, window.innerWidth - MARGIN * 2),
            maxHeight: pos.maxHeight,
            zIndex: 9999,
            overflowY: "auto",
            borderRadius: "1rem",
          }}
        >
          <CustomerReturnCard item={item} />
        </div>,
        document.body,
      )}
    </>
  );
}

export default function CustomerReturnsListPage() {
  const router = useRouter();
  useRequireAuth(router.replace);
  const isAdmin = useIsAdmin();
  const [company, setCompany] = useCompany();

  const [records, setRecords] = useState<CRListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<CRStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [page, setPage] = useState(1);

  const [deleteTarget, setDeleteTarget] = useState<CRListItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // Monotonic request id — only the newest load() is allowed to commit, so a slow
  // in-flight fetch that resolves after a newer one can't overwrite fresher data.
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const myId = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await listCustomerReturns(company, {
        page,
        per_page: PER_PAGE,
        status: statusFilter === "all" ? undefined : statusFilter,
        customer: search || undefined,
        from_date: toApiDate(fromDate),
        to_date: toApiDate(toDate),
        sort_by: "created_ts",
        sort_order: "desc",
      });
      if (myId !== seqRef.current) return; // a newer load started — drop this stale response
      setRecords(res.records);
      setTotal(res.total);
    } catch (e) {
      if (myId !== seqRef.current) return;
      setError(e instanceof Error ? e.message : "Failed to load customer returns");
      setRecords([]);
      setTotal(0);
    } finally {
      if (myId === seqRef.current) setLoading(false);
    }
  }, [company, page, statusFilter, search, fromDate, toDate]);

  useEffect(() => {
    if (!isAdmin) return;
    const t = setTimeout(load, 350); // debounce search/filter typing
    return () => clearTimeout(t);
  }, [isAdmin, load]);

  useEffect(() => {
    queueMicrotask(() => setPage(1));
  }, [company, statusFilter, search, fromDate, toDate]);

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const hasFilters = !!(search || fromDate || toDate || statusFilter !== "all");
  // Read-only phase: the eye/View link goes to the read-only /view page (the
  // editable detail + approve pages write, so they're not linked here).
  const detailHref = (r: CRListItem) =>
    `/modules/customer-returns/${encodeURIComponent(r.rtv_id)}${CR_READ_ONLY ? "/view" : ""}?company=${company}`;
  const approveHref = (r: CRListItem) => `/modules/customer-returns/${encodeURIComponent(r.rtv_id)}/approve?company=${company}`;

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteCustomerReturn(company, deleteTarget.rtv_id);
      setDeleteTarget(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
      setDeleteTarget(null); // close the modal so the error banner isn't hidden behind the overlay
    } finally {
      setDeleting(false);
    }
  }

  async function handleDownload() {
    setDownloading(true);
    try {
      const blob = await exportCustomerReturns(company, {
        status: statusFilter === "all" ? undefined : statusFilter,
        customer: search || undefined,
        from_date: toApiDate(fromDate),
        to_date: toApiDate(toDate),
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `rtv_${company}_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed");
    } finally {
      setDownloading(false);
    }
  }

  const clearFilters = () => {
    setSearch("");
    setFromDate("");
    setToDate("");
    setStatusFilter("all");
  };

  if (!isAdmin) {
    return (
      <CustomerReturnsChrome title="Customer Returns">
        <h1 className="text-[20px] font-semibold text-[var(--text-primary)] mb-3">Customer Returns</h1>
        <section className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)]">
          You don&rsquo;t have access to the Customer Returns module. Ask an administrator to grant you access, or
          switch to a different account.
        </section>
      </CustomerReturnsChrome>
    );
  }

  return (
    <CustomerReturnsChrome title="Customer Returns">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-[18px] sm:text-[22px] font-bold tracking-tight text-[var(--text-primary)]">Customer Returns</h1>
          <p className="text-[12px] text-[var(--text-secondary)] mt-0.5 hidden sm:block">Manage customer return entries and approvals</p>
        </div>
        <div className="flex-1" />
        <CompanyToggle value={company} onChange={setCompany} />
        <Link
          href={`/modules/customer-returns/dashboard?company=${company}`}
          className="inline-flex items-center gap-1.5 text-[12px] font-medium rounded-md border border-[var(--aws-border)] px-3 py-1.5 bg-white hover:border-[var(--aws-orange)]"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M3 3v18h18" /><rect x="7" y="10" width="3" height="8" /><rect x="12" y="6" width="3" height="12" /><rect x="17" y="13" width="3" height="5" /></svg>
          <span className="hidden xs:inline">Dashboard</span>
        </Link>
        {CR_READ_ONLY ? (
          <span
            title="Customer Returns is read-only in CFERP — create in IMS"
            className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--text-secondary)] border border-[var(--aws-border)] rounded-md px-3 py-1.5"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3.5 w-3.5"><path d="M18 8h1a4 4 0 0 1 0 8h-1M6 8H5a4 4 0 0 0 0 8h1M8 12h8" /></svg>
            Read-only
          </span>
        ) : (
          <Link
            href={`/modules/customer-returns/new?company=${company}`}
            className="inline-flex items-center gap-1.5 text-[12px] font-semibold bg-[var(--aws-orange)] text-white rounded-md px-3 py-1.5 hover:bg-[var(--aws-orange-hover)]"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4"><path d="M12 5v14M5 12h14" /></svg>
            New CR
          </Link>
        )}
      </div>

      {/* Status tabs */}
      <div className="flex gap-1 p-1 bg-[var(--background)] border border-[var(--aws-border)] rounded-lg w-fit mb-3 overflow-x-auto">
        {STATUS_TABS.map((tab) => {
          const active = statusFilter === tab.value;
          return (
            <button
              key={tab.value}
              onClick={() => setStatusFilter(tab.value)}
              aria-pressed={active}
              className={cx(
                "flex items-center gap-1.5 px-3 py-1.5 text-[12px] sm:text-[13px] font-medium rounded-md whitespace-nowrap transition-colors",
                active ? "bg-white shadow-sm text-[var(--text-primary)]" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
              )}
            >
              <tab.Icon className={cx("h-3.5 w-3.5", active && tab.color)} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Search & filters */}
      <div className="flex flex-col gap-2 mb-3">
        <div className="relative w-full">
          <IconSearch className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--text-muted)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by customer…"
            className="w-full h-9 rounded-md border border-[var(--aws-border)] pl-9 pr-3 text-[13px] bg-white"
          />
        </div>
        <div className="flex items-center gap-2">
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-9 flex-1 min-w-0 rounded-md border border-[var(--aws-border)] px-2 text-[13px] bg-white" />
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-9 flex-1 min-w-0 rounded-md border border-[var(--aws-border)] px-2 text-[13px] bg-white" />
          <button
            onClick={handleDownload}
            disabled={downloading}
            aria-label="Download"
            className="h-9 inline-flex items-center gap-1 rounded-md border border-[var(--aws-border)] px-3 text-[13px] bg-white hover:border-[var(--aws-orange)] disabled:opacity-50 flex-shrink-0"
          >
            {downloading ? <IconSpinner className="h-3.5 w-3.5 animate-spin" /> : <IconDownload className="h-3.5 w-3.5" />}
            <span className="hidden sm:inline">Download</span>
          </button>
          {hasFilters && (
            <button onClick={clearFilters} aria-label="Clear filters" className="h-9 inline-flex items-center gap-1 rounded-md px-3 text-[13px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex-shrink-0">
              <IconX className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Clear</span>
            </button>
          )}
        </div>
      </div>

      {error && <div className="mb-3"><ErrorBanner message={error} /></div>}

      {/* Table / cards */}
      <div className="bg-white border border-[var(--aws-border)] rounded-md overflow-hidden">
        {loading ? (
          <div className="p-4 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4">
                <div className="h-4 w-28 rounded bg-[var(--background)] animate-pulse" />
                <div className="h-4 w-20 rounded bg-[var(--background)] animate-pulse" />
                <div className="h-5 w-16 rounded-full bg-[var(--background)] animate-pulse" />
                <div className="h-4 flex-1 rounded bg-[var(--background)] animate-pulse" />
                <div className="h-8 w-20 rounded bg-[var(--background)] animate-pulse" />
              </div>
            ))}
          </div>
        ) : records.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-14 text-center px-4">
            <div className="h-12 w-12 rounded-full bg-[var(--background)] flex items-center justify-center mb-3 text-[var(--text-muted)]">
              <IconAll className="h-6 w-6" />
            </div>
            <p className="text-[13px] font-medium text-[var(--text-primary)]">No CR entries found</p>
            <p className="text-[12px] text-[var(--text-secondary)] mt-1">{hasFilters ? "Try adjusting your filters" : "Create your first CR entry"}</p>
          </div>
        ) : (
          <>
            {/* Desktop */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-[var(--aws-border)] bg-[var(--background)] text-left text-[var(--text-secondary)]">
                    <th className="px-4 py-2.5 font-medium">CR No</th>
                    <th className="px-4 py-2.5 font-medium">Date</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 font-medium">Customer</th>
                    <th className="px-4 py-2.5 font-medium hidden lg:table-cell">Business Head</th>
                    <th className="px-4 py-2.5 font-medium hidden lg:table-cell">Factory Unit</th>
                    <th className="px-4 py-2.5 font-medium hidden lg:table-cell">Items</th>
                    <th className="px-4 py-2.5 font-medium hidden lg:table-cell">Net Wt (kg)</th>
                    <th className="px-4 py-2.5 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((item) => (
                    <tr key={item.rtv_id} className="border-b border-[var(--aws-border)] last:border-0 hover:bg-[var(--background)] transition-colors">
                      <td className="px-4 py-3"><CustomerReturnHoverPortal item={item} /></td>
                      <td className="px-4 py-3 text-[var(--text-secondary)]">{fmtDate(item.rtv_date)}</td>
                      <td className="px-4 py-3"><StatusBadge status={item.status} /></td>
                      <td className="px-4 py-3 text-[var(--text-secondary)] truncate max-w-[200px]">{item.customer || "—"}</td>
                      <td className="px-4 py-3 hidden lg:table-cell text-[var(--text-secondary)]">{item.business_head || "—"}</td>
                      <td className="px-4 py-3 hidden lg:table-cell text-[var(--text-secondary)]">{getDisplayWarehouseName(item.factory_unit) || "—"}</td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        <span className="text-[11px] font-medium px-2 py-0.5 rounded bg-[var(--background)] border border-[var(--aws-border)] text-[var(--text-secondary)]">{item.items_count} items</span>
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell text-[var(--text-secondary)]">{item.total_net_weight} kg</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <Link href={detailHref(item)} title="View detail" aria-label={`View ${item.rtv_id}`} className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--background)] text-[var(--text-secondary)]">
                            <IconEye className="h-3.5 w-3.5" />
                          </Link>
                          {!CR_READ_ONLY && item.status === "Pending" && (
                            <>
                              <Link href={approveHref(item)} title="Review / edit" aria-label={`Review ${item.rtv_id}`} className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--background)] text-[var(--text-secondary)]">
                                <IconPencil className="h-3.5 w-3.5" />
                              </Link>
                              <button onClick={() => setDeleteTarget(item)} title="Delete" aria-label={`Delete ${item.rtv_id}`} className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--background)] text-[var(--aws-error)]">
                                <IconTrash className="h-3.5 w-3.5" />
                              </button>
                            </>
                          )}
                          {!CR_READ_ONLY && (
                            <Link
                              href={approveHref(item)}
                              className="ml-1 h-7 inline-flex items-center gap-1 rounded-md border border-[var(--aws-border)] px-2 text-[12px] bg-white hover:border-[var(--aws-orange)]"
                            >
                              <IconCheckCircle className="h-3 w-3" />
                              Review
                            </Link>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile */}
            <div className="md:hidden divide-y divide-[var(--aws-border)]">
              {records.map((item) => (
                <div key={item.rtv_id} className="p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[13px] truncate"><CustomerReturnHoverPortal item={item} /></div>
                      <p className="text-[11px] text-[var(--text-secondary)]">
                        {fmtDate(item.rtv_date)}{item.customer ? ` · ${item.customer}` : ""}
                      </p>
                    </div>
                    <StatusBadge status={item.status} />
                  </div>
                  <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-[var(--text-secondary)]">
                    <span>{item.items_count} items</span>
                    <span>·</span>
                    <span>Net Wt: {item.total_net_weight} kg</span>
                    {item.factory_unit && (<><span>·</span><span>{getDisplayWarehouseName(item.factory_unit)}</span></>)}
                  </div>
                  <div className="flex items-center gap-1 pt-1">
                    <Link href={detailHref(item)} className="h-7 flex-1 inline-flex items-center justify-center gap-1 rounded-md text-[12px] text-[var(--text-secondary)] hover:bg-[var(--background)]">
                      <IconEye className="h-3 w-3" /> View
                    </Link>
                    {!CR_READ_ONLY && (
                      <Link href={approveHref(item)} className="h-7 flex-1 inline-flex items-center justify-center gap-1 rounded-md border border-[var(--aws-border)] text-[12px] bg-white">
                        <IconCheckCircle className="h-3 w-3" />
                        Review
                      </Link>
                    )}
                    {!CR_READ_ONLY && item.status === "Pending" && (
                      <button onClick={() => setDeleteTarget(item)} aria-label={`Delete ${item.rtv_id}`} className="h-7 w-7 inline-flex items-center justify-center rounded text-[var(--aws-error)] flex-shrink-0">
                        <IconTrash className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3">
          <p className="text-[12px] text-[var(--text-secondary)]">Page {page} of {totalPages} ({total} total)</p>
          <div className="flex gap-1">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page" className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-[var(--aws-border)] bg-white disabled:opacity-40">
              <IconChevronLeft className="h-4 w-4" />
            </button>
            <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} aria-label="Next page" className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-[var(--aws-border)] bg-white disabled:opacity-40">
              <IconChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {deleteTarget && (
        <ConfirmDialog
          title="Delete CR"
          confirmLabel="Delete"
          busy={deleting}
          busyLabel="Deleting…"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={handleDelete}
        >
          Are you sure you want to delete <span className="font-medium text-[var(--text-primary)]">{deleteTarget.rtv_id}</span>? This
          will remove all lines and boxes. This action cannot be undone.
        </ConfirmDialog>
      )}
    </CustomerReturnsChrome>
  );
}
