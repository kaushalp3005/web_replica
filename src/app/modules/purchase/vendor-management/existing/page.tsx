"use client";

// Vendor Management · Existing Vendors (list + filters + search + pagination) —
// web port of the Electron renderer
// frontend_replica/src/modules/purchase/vendor-management/existing-vendors/existing-vendors.js.
//
// Two list endpoints, same enriched row shape (is_approved, has_primary_banking,
// counts.{documents,contracts,banking}), both sorted approved-first:
//   GET /api/v1/vendors/paged      — paginated browse (page_size pinned 200)
//   GET /api/v1/vendors/search?q=  — direct-DB search when the operator types
//                                    ≥2 chars; one round-trip, capped at 1000.
// The mode flips automatically on the search box: ≥2 chars → search, else list.
//
// Approve (POST /{id}/approve) and Delete (DELETE /{id}, soft) are inline row
// actions. "View" (detail drill-in) is the next page to be ported.

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { BackLink } from "@/components/BackLink";
import { PurchaseChrome } from "../../_chrome";
import {
  VENDOR_STATUS,
  getLookups,
  listVendorsPaged,
  searchVendors,
  approveVendor,
  deleteVendor,
  getLookupLabel,
  VendorApiError,
  type VendorListRow,
  type LookupRow,
} from "@/lib/vendor";

// ── Config ─────────────────────────────────────────────────────────────────

const HUB_HREF = "/modules/purchase/vendor-management";
const NEW_HREF = "/modules/purchase/vendor-management/new";
const CATEGORY_LOOKUP = "CATEGORY_CODE";
const PAGE_SIZE = 200; // pinned server-side by /paged; mirrored for pagination math
const COLSPAN = 9;

const APPROVAL_OPTIONS = [
  { value: "", label: "Any approval" },
  { value: "approved", label: "Approved" },
  { value: "pending", label: "Pending" },
] as const;

const INPUT_CLS =
  "h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] bg-white disabled:opacity-50";
const CARD_CLS =
  "bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)]";
const GHOST_BTN =
  "h-7 px-2.5 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] disabled:opacity-50 disabled:cursor-not-allowed";

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ExistingVendorsPage(): React.JSX.Element {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);

  // Hydration gate — hold the auth branch until after mount so the SSR HTML and
  // the first client paint are byte-identical (mirrors the wizard / list pages).
  const [mounted, setMounted] = useState(false);
  useEffect(() => { queueMicrotask(() => setMounted(true)); }, []);

  // Filters + search
  const [statusFilter, setStatusFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [approvalFilter, setApprovalFilter] = useState("");
  const [searchInput, setSearchInput] = useState(""); // raw box value
  const [searchQuery, setSearchQuery] = useState(""); // debounced, ≥2 chars or ""

  // Data
  const [vendors, setVendors] = useState<VendorListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [page, setPage] = useState(1);
  const [truncated, setTruncated] = useState(false);
  const [categories, setCategories] = useState<LookupRow[]>([]);

  // Status
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // `error`/`errorCode` are LOAD-time failures only — they drive the table
  // empty-state. `actionError` is approve/delete failures — surfaced in the top
  // strip only, so a failed row action never blanks the already-loaded list.
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const mode: "list" | "search" = searchQuery ? "search" : "list";

  // ── Category dropdown (populate once, reused for label resolution) ──
  useEffect(() => {
    if (!authed) return;
    let live = true;
    (async () => {
      const rows = await getLookups(CATEGORY_LOOKUP);
      if (live) setCategories(rows);
    })();
    return () => { live = false; };
  }, [authed]);

  // ── Debounce search box → searchQuery (mode switch happens via `mode`) ──
  useEffect(() => {
    const t = setTimeout(() => {
      const v = searchInput.trim();
      setSearchQuery(v.length >= 2 ? v : "");
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  // ── Fetch + render on any query change ──
  useEffect(() => {
    if (!authed || !mounted) return;
    const ac = new AbortController();
    let live = true;
    (async () => {
      // setState is deferred past the effect body (queueMicrotask) so it isn't a
      // synchronous set-state-in-effect; matches the repo convention.
      queueMicrotask(() => { if (live) { setLoading(true); setError(null); setErrorCode(null); setActionError(null); } });
      try {
        if (searchQuery) {
          const data = await searchVendors({
            q: searchQuery,
            status: statusFilter || undefined,
            category_code_id: categoryFilter || undefined,
            approval: approvalFilter || undefined,
            signal: ac.signal,
          });
          if (!live) return;
          setVendors(data.vendors ?? []);
          setTotal(data.total_returned ?? (data.vendors?.length ?? 0));
          setTruncated(!!data.truncated);
        } else {
          const data = await listVendorsPaged({
            status: statusFilter || undefined,
            category_code_id: categoryFilter || undefined,
            approval: approvalFilter || undefined,
            page,
            signal: ac.signal,
          });
          if (!live) return;
          setVendors(data.vendors ?? []);
          setTotal(data.total ?? (data.vendors?.length ?? 0));
          setPageSize(data.page_size ?? PAGE_SIZE);
          setTruncated(false);
        }
      } catch (err) {
        if (!live || ac.signal.aborted) return;
        setVendors([]);
        setTotal(0);
        setTruncated(false);
        if (err instanceof VendorApiError) {
          setError(err.message);
          setErrorCode(err.code);
        } else {
          setError("Failed to load vendors");
          setErrorCode(null);
        }
      } finally {
        if (live && !ac.signal.aborted) setLoading(false);
      }
    })();
    return () => { live = false; ac.abort(); };
  }, [authed, mounted, statusFilter, categoryFilter, approvalFilter, searchQuery, page, reloadKey]);

  // ── Clamp page after a mutation shrinks the result set ──
  // Deleting/approving the last row of the last page re-fetches the SAME `page`,
  // which the backend answers with an empty slice (offset ≥ total). Snap back to
  // the last valid page so the operator isn't stranded on a blank out-of-range
  // page with the pagination bar hidden. queueMicrotask keeps this off the
  // synchronous effect path (repo's set-state-in-effect convention).
  useEffect(() => {
    const tp = Math.max(1, Math.ceil(total / (pageSize || PAGE_SIZE)));
    if (mode === "list" && !loading && page > tp) {
      queueMicrotask(() => setPage(tp));
    }
  }, [mode, loading, page, total, pageSize]);

  // ── Actions ──
  function clearFilters() {
    setStatusFilter("");
    setCategoryFilter("");
    setApprovalFilter("");
    setSearchInput("");
    setSearchQuery("");
    setPage(1);
    setInfo(null);
    setActionError(null);
    setError(null);
    setErrorCode(null);
  }

  // Stable callbacks so the memoized rows below aren't re-rendered on every
  // keystroke into the search box (which only changes `searchInput`).
  const onView = useCallback((vendorId: string) => {
    // Detail drill-in is the next page to be ported; keep the action discoverable
    // without a dead 404 link.
    void vendorId;
    setActionError(null);
    setInfo("Vendor detail view is the next page to be ported — this page covers browse, approve and delete.");
  }, []);

  const handleApprove = useCallback(async (vendorId: string) => {
    if (!window.confirm("Approve this vendor for purchase?")) return;
    setBusyId(vendorId);
    setActionError(null);
    setInfo(null);
    try {
      await approveVendor(vendorId);
      setInfo("Vendor approved.");
      setReloadKey((k) => k + 1);
    } catch (err) {
      setActionError(err instanceof VendorApiError ? err.message : "Couldn't approve vendor");
    } finally {
      setBusyId(null);
    }
  }, []);

  const handleDelete = useCallback(async (vendorId: string) => {
    if (!window.confirm("Delete this vendor? This soft-deletes the row; only an admin can restore it.")) return;
    setBusyId(vendorId);
    setActionError(null);
    setInfo(null);
    try {
      await deleteVendor(vendorId);
      setInfo("Vendor deleted.");
      setReloadKey((k) => k + 1);
    } catch (err) {
      setActionError(err instanceof VendorApiError ? err.message : "Couldn't delete vendor");
    } finally {
      setBusyId(null);
    }
  }, []);

  // ── Derived summary counts (over the rows currently in view) ──
  // Memoized so a search keystroke (searchInput change) doesn't re-run four O(n)
  // passes over an up-to-1000-row result set.
  const { active, inactive, blacklisted, approved } = useMemo(() => ({
    active: vendors.filter((v) => v.status === "active").length,
    inactive: vendors.filter((v) => v.status === "inactive").length,
    blacklisted: vendors.filter((v) => v.status === "blacklisted").length,
    approved: vendors.filter((v) => v.is_approved ?? !!v.approved_at).length,
  }), [vendors]);
  const totalPages = Math.max(1, Math.ceil(total / (pageSize || PAGE_SIZE)));

  // ── Hydration shell ──
  if (!mounted) {
    return (
      <PurchaseChrome title="Vendor Management">
        <div className={`${CARD_CLS} p-10 text-center text-[var(--text-secondary)]`}>
          <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
        </div>
      </PurchaseChrome>
    );
  }
  if (!authed) return <></>;

  const forbidden = errorCode === "forbidden";

  return (
    <PurchaseChrome title="Vendor Management">
      <div className="mb-3">
        <BackLink parentHref={HUB_HREF} label="Vendor Management" />
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-5">
        <div>
          <p className="text-[11px] uppercase tracking-wide font-semibold text-[var(--text-muted)]">Vendor Management</p>
          <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">Existing Vendors</h1>
          <p className="text-[13px] text-[var(--text-secondary)] mt-1">
            Vendor master — search, filter, and manage compliance, banking and contracts.
          </p>
        </div>
        <button
          type="button"
          onClick={() => router.push(NEW_HREF)}
          className="shrink-0 h-9 px-4 text-[13px] font-semibold rounded-[2px] bg-[var(--aws-navy)] text-white hover:brightness-95 flex items-center gap-2"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Add Vendor
        </button>
      </div>

      {/* Feedback strips. Load/forbidden errors live in the table body (below);
          the top strip is reserved for row-action (approve/delete) errors so the
          same message is never rendered/announced twice. */}
      {actionError && (
        <p role="alert" aria-live="assertive" className="mb-3 text-[12px] text-[var(--aws-error)] bg-[#fdf3f1] border border-[#f5c6bc] rounded px-3 py-2">
          {actionError}
        </p>
      )}
      {info && (
        <div role="status" aria-live="polite" className="mb-3 flex items-start gap-2 text-[12px] text-[var(--text-success)] bg-[#eaf6ed] border border-[#b6dbb1] rounded px-3 py-2">
          <span className="flex-1">{info}</span>
          <button type="button" onClick={() => setInfo(null)} className="text-[16px] leading-none opacity-60 hover:opacity-100" aria-label="Dismiss">×</button>
        </div>
      )}

      {/* Summary KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
        <SummaryCard
          label={mode === "search" ? "Search results" : "In view (this page)"}
          value={vendors.length}
          sub={mode === "search"
            ? (truncated ? `first ${total} matches` : `${total} match${total === 1 ? "" : "es"}`)
            : `of ${total} total`}
          accent="var(--aws-navy)"
        />
        <SummaryCard label="Active" value={active} accent="#1a8a4c" />
        <SummaryCard label="Approved" value={approved} sub="SCM-Head signoff" accent="var(--aws-orange)" />
        <SummaryCard label="Inactive" value={inactive} accent="#b7791f" />
        <SummaryCard label="Blacklisted" value={blacklisted} accent="var(--aws-error)" />
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative flex-1 min-w-[220px]">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8"
            className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden>
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search vendor name… (≥2 chars)"
            aria-label="Search vendors by name"
            className={`${INPUT_CLS} w-full !pl-7`}
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          aria-label="Filter by status"
          className={INPUT_CLS}
        >
          <option value="">All status</option>
          {VENDOR_STATUS.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
        </select>
        <select
          value={approvalFilter}
          onChange={(e) => { setApprovalFilter(e.target.value); setPage(1); }}
          aria-label="Filter by approval state"
          className={INPUT_CLS}
        >
          {APPROVAL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select
          value={categoryFilter}
          onChange={(e) => { setCategoryFilter(e.target.value); setPage(1); }}
          aria-label="Filter by category"
          className={INPUT_CLS}
        >
          <option value="">All categories</option>
          {categories.map((c) => <option key={c.lookup_id} value={c.lookup_id}>{c.label || c.code}</option>)}
        </select>
        <button type="button" onClick={clearFilters} className={GHOST_BTN}>Clear</button>
      </div>

      {/* Search-mode banner */}
      {mode === "search" && (
        <div role="status" className="mb-3 text-[12px] text-[var(--text-secondary)] bg-[var(--surface-subtle)] border border-[var(--aws-border)] rounded px-3 py-2">
          {truncated
            ? <>Showing the first <strong>{vendors.length}</strong> matches — refine the search to narrow it down.</>
            : <>Search results · <strong>{vendors.length}</strong> match{vendors.length === 1 ? "" : "es"} for &ldquo;<strong>{searchQuery}</strong>&rdquo;</>}
        </div>
      )}

      {/* Table */}
      <div className={`${CARD_CLS} overflow-hidden`}>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="bg-[var(--surface-subtle)] text-left text-[11px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">
                <Th>Name</Th>
                <Th>Supplier code</Th>
                <Th>Status</Th>
                <Th>Category</Th>
                <Th>City / State</Th>
                <Th>Contact</Th>
                <Th title="Documents · Contracts · Banking">Records</Th>
                <Th>Approved</Th>
                <Th className="w-[150px]">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <EmptyRow>
                  <span role="status" aria-live="polite" className="inline-flex items-center gap-2 text-[var(--text-secondary)]">
                    <span className="inline-block w-3.5 h-3.5 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
                    Loading vendors…
                  </span>
                </EmptyRow>
              ) : forbidden ? (
                <EmptyRow>
                  <div className="py-6">
                    <div className="text-[14px] font-semibold text-[var(--text-primary)]">Access denied</div>
                    <div className="text-[12px] text-[var(--text-secondary)] mt-1">You don&rsquo;t have permission to view vendors.</div>
                  </div>
                </EmptyRow>
              ) : error ? (
                <EmptyRow>
                  <div className="py-6 text-[13px] text-[var(--aws-error)]" role="alert">{error}</div>
                </EmptyRow>
              ) : vendors.length === 0 ? (
                <EmptyRow>
                  <div className="py-8" role="status">
                    <div className="text-[14px] font-semibold text-[var(--text-primary)]">
                      {mode === "search" ? "No matching vendors" : "No vendors yet"}
                    </div>
                    <div className="text-[12px] text-[var(--text-secondary)] mt-1 mb-3">
                      {mode === "search"
                        ? `Nothing matched “${searchQuery}”. Try a different term or clear filters.`
                        : "Add a vendor to start tracking compliance, banking and contracts."}
                    </div>
                    {mode !== "search" && (
                      <button type="button" onClick={() => router.push(NEW_HREF)}
                        className="h-8 px-4 text-[12px] font-semibold rounded-[2px] bg-[var(--aws-navy)] text-white hover:brightness-95">
                        Add Vendor
                      </button>
                    )}
                  </div>
                </EmptyRow>
              ) : (
                vendors.map((v) => (
                  <VendorRow
                    key={v.vendor_id}
                    row={v}
                    categories={categories}
                    busy={busyId === v.vendor_id}
                    onView={onView}
                    onApprove={handleApprove}
                    onDelete={handleDelete}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination (list mode only). `page > 1` keeps a Prev control available
          as an escape hatch even if a mutation transiently leaves page out of range. */}
      {mode === "list" && !loading && !error && (totalPages > 1 || page > 1) && (
        <div className="flex items-center justify-center gap-3 mt-4">
          <button type="button" className={GHOST_BTN} disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>‹ Prev</button>
          <span className="text-[12px] text-[var(--text-secondary)]">Page {page} of {totalPages} · {total} vendors</span>
          <button type="button" className={GHOST_BTN} disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next ›</button>
        </div>
      )}
    </PurchaseChrome>
  );
}

// ── Memoized vendor row ──────────────────────────────────────────────────────
// Only re-renders when its own props change (row ref, categories, or busy),
// so typing into the search box doesn't reconcile the whole (up-to-1000-row)
// table. Handlers are stabilized with useCallback in the parent.
interface VendorRowProps {
  row: VendorListRow;
  categories: LookupRow[];
  busy: boolean;
  onView: (vendorId: string) => void;
  onApprove: (vendorId: string) => void;
  onDelete: (vendorId: string) => void;
}

const VendorRow = memo(function VendorRow(
  { row: v, categories, busy, onView, onApprove, onDelete }: VendorRowProps,
): React.JSX.Element {
  const isApproved = v.is_approved ?? !!v.approved_at;
  const category = getLookupLabel(categories, typeof v.category_code_id === "string" ? v.category_code_id : null) || "—";
  const cityState = cityStateOf(v);
  const contact = strOf(v.contact_person) || strOf(v.mobile) || strOf(v.email) || "—";
  return (
    <tr className="border-t border-[var(--aws-border)] hover:bg-[var(--surface-subtle)]">
      <Td>
        <span className="font-semibold text-[var(--text-primary)]">{v.name || "—"}</span>
        {v.is_msme ? <Pill tone="info">MSME</Pill> : null}
      </Td>
      <Td className="font-mono text-[12px]">{strOf(v.supplier_code) || "—"}</Td>
      <Td><StatusBadge status={v.status} /></Td>
      <Td>{category}</Td>
      <Td>{cityState}</Td>
      <Td className="max-w-[180px] truncate" title={contact}>{contact}</Td>
      <Td><CountChips counts={v.counts} /></Td>
      <Td>
        {isApproved
          ? <Badge tone="success">Approved</Badge>
          : <Badge tone="neutral">Pending</Badge>}
        {!isApproved && v.has_primary_banking === false && (
          <Pill tone="warning" title="No active primary banking row — required for approval">No bank</Pill>
        )}
      </Td>
      <Td>
        <div className="flex flex-wrap gap-1">
          <button type="button" className={GHOST_BTN} onClick={() => onView(v.vendor_id)} title="Open detail">View</button>
          {!isApproved && (
            <button type="button" className={GHOST_BTN} disabled={busy}
              onClick={() => onApprove(v.vendor_id)} title="SCM-Head approval">
              {busy ? "…" : "Approve"}
            </button>
          )}
          <button type="button"
            className="h-7 px-2.5 text-[12px] rounded-[2px] border border-[#f5c6bc] text-[var(--aws-error)] bg-white hover:bg-[#fdf3f1] disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={busy} onClick={() => onDelete(v.vendor_id)} title="Soft-delete">
            {busy ? "…" : "Delete"}
          </button>
        </div>
      </Td>
    </tr>
  );
});

// ── Presentational helpers ───────────────────────────────────────────────────

function Th({ children, className = "", title }: { children?: React.ReactNode; className?: string; title?: string }): React.JSX.Element {
  return <th title={title} className={`px-3 py-2 font-semibold whitespace-nowrap ${className}`}>{children}</th>;
}

function Td({ children, className = "", title }: { children?: React.ReactNode; className?: string; title?: string }): React.JSX.Element {
  return <td title={title} className={`px-3 py-2 align-middle text-[var(--text-primary)] ${className}`}>{children}</td>;
}

function EmptyRow({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <tr><td colSpan={COLSPAN} className="px-3 py-6 text-center">{children}</td></tr>;
}

function SummaryCard({ label, value, sub, accent }: { label: string; value: number; sub?: string; accent: string }): React.JSX.Element {
  return (
    <article className={`${CARD_CLS} p-3 border-l-[3px]`} style={{ borderLeftColor: accent }}>
      <div className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)]">{label}</div>
      <div className="text-[22px] leading-[26px] font-semibold text-[var(--text-primary)] mt-0.5">{value}</div>
      {sub && <div className="text-[11px] text-[var(--text-secondary)] mt-0.5">{sub}</div>}
    </article>
  );
}

function StatusBadge({ status }: { status: string }): React.JSX.Element {
  if (status === "active") return <Badge tone="success">Active</Badge>;
  if (status === "inactive") return <Badge tone="warning">Inactive</Badge>;
  if (status === "blacklisted") return <Badge tone="danger">Blacklisted</Badge>;
  return <Badge tone="neutral">{status || "—"}</Badge>;
}

// De-facto badge palette used across web_replica list pages (bg / fg / border trios).
type Tone = "success" | "warning" | "danger" | "neutral" | "info";
const TONE_CLS: Record<Tone, string> = {
  success: "bg-[#eaf6ed] text-[var(--text-success)] border border-[#b6dbb1]",
  warning: "bg-[#fbe7d6] text-[#9a5b00] border border-[#f0cfa0]",
  danger: "bg-[#fbeced] text-[var(--aws-error)] border border-[#f0c0c4]",
  neutral: "bg-[var(--surface-disabled)] text-[var(--text-secondary)] border border-[var(--aws-border)]",
  info: "bg-[#eaf0fb] text-[#2c5fa8] border border-[#c3d4f0]",
};

function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }): React.JSX.Element {
  return <span className={`inline-flex items-center h-5 px-2 text-[11px] font-semibold rounded-[2px] ${TONE_CLS[tone]}`}>{children}</span>;
}

function Pill({ tone, children, title }: { tone: Tone; children: React.ReactNode; title?: string }): React.JSX.Element {
  return <span title={title} className={`inline-flex items-center h-4 px-1.5 ml-1.5 text-[9px] font-bold uppercase tracking-wide rounded-full ${TONE_CLS[tone]}`}>{children}</span>;
}

function CountChips({ counts }: { counts?: { documents?: number; contracts?: number; banking?: number } }): React.JSX.Element {
  const c = counts || {};
  const d = Number(c.documents || 0);
  const k = Number(c.contracts || 0);
  const b = Number(c.banking || 0);
  const chip = (n: number, label: string, icon: string) => (
    <span title={label} aria-label={`${n} ${label}`}
      className="inline-flex items-center gap-0.5 text-[11px] text-[var(--text-secondary)]" style={{ opacity: n > 0 ? 1 : 0.45 }}>
      <span aria-hidden>{icon}</span>{n}
    </span>
  );
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      {chip(d, "Documents", "📄")}
      {chip(k, "Contracts", "📜")}
      {chip(b, "Banking rows", "🏦")}
    </span>
  );
}

// ── Row-field coercers (VendorListRow carries extra columns as `unknown`) ──
function strOf(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
function cityStateOf(v: VendorListRow): string {
  const city = strOf(v.city);
  const state = strOf(v.state);
  if (!city && !state) return "—";
  return `${city}${city && state ? ", " : ""}${state}`;
}
