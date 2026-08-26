"use client";

// Production Indents sub-module — the ONE screen that surfaces both indent
// families side by side as tabs. They share nothing but this page: separate
// tables, separate lifecycles, separate permission trees (see lib/indents.ts).
//
//   Tab A "Production (FG/SFG)" → production_indent, maker-checker.
//        draft → submitted → approved → internal_jc_created → fulfilled
//                                                          (+ cancelled)
//   Tab B "Purchase (RM/PM)"    → purchase_indent, raise → ack → PO.
//        draft → raised → acknowledged → po_created → received (+ cancelled)
//
// Filtering is SERVER-SIDE — every filter is a fetch dependency. The filter bar
// is shared across both tabs; only the status vocabulary re-scopes to the
// active tab (the two lifecycles do not overlap), so switching tabs clears it.
//
// Two behaviours worth knowing before editing:
//   • The four production transitions answer { updated: false } with HTTP 200
//     when the row was NOT in the expected state. That is a STALE VIEW, not an
//     error — we say so and refetch instead of throwing a red banner.
//   • POST /production-indents answers 409 when an open indent already exists
//     for the same item + SO. That one is surfaced INLINE in the create form
//     (the operator has to change the item or the SO), never as a toast.
//
// Out of scope this iteration:
//   • Mobile stacked-card rendering (the table scrolls horizontally instead)
//   • purchase_indent `source` filter (indent_source) — lib supports it, no UI
//   • Bulk send / on-material-received (deliberately unrouted on the server)

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth, useRequireModuleAccess, useHasPermission, useMe } from "@/lib/user";
import { friendlyApiError } from "@/lib/apiErrors";
import { ProdIndentsChrome } from "./_chrome";
import {
  type ProductionIndentRow,
  type PurchaseIndentRow,
  type IndentPagination,
  type IndentFilters,
  type IndentTransitionResult,
  type ProductionIndentCreateBody,
  type PurchaseIndentEditBody,
  ProductionIndentDuplicateError,
  PRODUCTION_INDENT_STATUSES,
  PURCHASE_INDENT_STATUSES,
  listProductionIndents,
  createProductionIndent,
  submitProductionIndent,
  approveProductionIndent,
  returnProductionIndent,
  cancelProductionIndent,
  createInternalOrder,
  listPurchaseIndents,
  editPurchaseIndent,
  sendPurchaseIndent,
  acknowledgePurchaseIndent,
  linkPurchaseIndentToPo,
  indentStatusLabel,
  isIndentTerminal,
  fmtIndentQty,
  fmtIndentDate,
  fmtIndentDateTime,
} from "@/lib/indents";

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

type TabKey = "production" | "purchase";
type ProdAction = "submit" | "approve" | "return" | "cancel" | "internal_order";
type PurAction = "send" | "acknowledge" | "link_po" | "edit";

// Only one drawer can be open, and its family decides both the field list and
// the action set — a discriminated union keeps row + action type-locked.
type DrawerState =
  | { tab: "production"; row: ProductionIndentRow; action: ProdAction | null }
  | { tab: "purchase"; row: PurchaseIndentRow; action: PurAction | null }
  | null;

// UX-only gates. The server still enforces the real permission (see
// require_permission on every route); these just hide what would 403.
interface Perms {
  prodView: boolean;
  prodCreate: boolean;
  prodApprove: boolean;
  purView: boolean;
  purEdit: boolean;
  purSend: boolean;
  purAck: boolean;
  purLinkPo: boolean;
}

const ENTITY_OPTS = [
  { v: "", label: "All entities" },
  { v: "cfpl", label: "CFPL" },
  { v: "cdpl", label: "CDPL" },
];

// Two status maps, deliberately NOT merged — the vocabularies belong to
// different lifecycles and a shared map would silently colour the wrong thing.
// Unknown values fall through to the neutral style (purchase_indent.status has
// no DB check constraint, so anything can arrive).
const PROD_STATUS_STYLES: Record<string, string> = {
  draft: "text-[var(--aws-link)] bg-[#eaf3ff] border-[#bbd9f3]",
  submitted: "text-[#664d03] bg-[#fff8e6] border-[#ffe69c]",
  approved: "text-[#1d8102] bg-[#eaf6ed] border-[#b6dbb1]",
  internal_jc_created: "text-[#5752c4] bg-[#f0eef8] border-[#d2cef0]",
  fulfilled: "text-[#1d8102] bg-[#eaf6ed] border-[#b6dbb1]",
  cancelled: "text-[var(--text-muted)] bg-[var(--surface-subtle)] border-[var(--aws-border)]",
};
const PUR_STATUS_STYLES: Record<string, string> = {
  draft: "text-[var(--aws-link)] bg-[#eaf3ff] border-[#bbd9f3]",
  raised: "text-[#664d03] bg-[#fff8e6] border-[#ffe69c]",
  acknowledged: "text-[#1d8102] bg-[#eaf6ed] border-[#b6dbb1]",
  po_created: "text-[#5752c4] bg-[#f0eef8] border-[#d2cef0]",
  received: "text-[#1d8102] bg-[#eaf6ed] border-[#b6dbb1]",
  cancelled: "text-[var(--text-muted)] bg-[var(--surface-subtle)] border-[var(--aws-border)]",
};

const BTN_PRIMARY =
  "h-8 px-3 text-[12px] rounded-[2px] font-semibold border bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white disabled:opacity-50 disabled:cursor-not-allowed";
const BTN_GREEN =
  "h-8 px-3 text-[12px] rounded-[2px] font-semibold border bg-[#1d8102] border-[#176a02] hover:bg-[#176a02] text-white disabled:opacity-50 disabled:cursor-not-allowed";
const BTN_GHOST =
  "h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[var(--text-primary)] hover:border-[var(--aws-navy)] disabled:opacity-50 disabled:cursor-not-allowed";
const BTN_ROW =
  "h-6 px-2 text-[11px] rounded-sm border border-[var(--aws-border-strong)] bg-white text-[var(--aws-link)] hover:border-[var(--aws-navy)] disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap";
const INPUT =
  "w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]";

// ── Drawer field maps ────────────────────────────────────────────────────
//
// The drawer shows EVERY column of the selected row. These lists give the
// known columns a human label and a stable order; anything the server adds
// later still renders, via the "extra keys" pass in <DetailDrawer>.

interface FieldDef { key: string; label: string }

const PROD_FIELDS: FieldDef[] = [
  { key: "prod_indent_id", label: "Indent ID" },
  { key: "id", label: "Row ID" },
  { key: "status", label: "Status" },
  { key: "entity", label: "Entity" },
  { key: "item_description", label: "Item" },
  { key: "item_category", label: "Category" },
  { key: "sub_category", label: "Sub category" },
  { key: "material_type", label: "Material type" },
  { key: "uom", label: "UOM" },
  { key: "required_qty", label: "Required qty" },
  { key: "available_qty", label: "Available qty" },
  { key: "shortfall_qty", label: "Shortfall qty" },
  { key: "triggered_by_job_card", label: "Triggered by JC" },
  { key: "triggered_by_so", label: "Triggered by SO" },
  { key: "customer_name", label: "Customer" },
  { key: "maker_user", label: "Maker" },
  { key: "checker_user", label: "Checker" },
  { key: "checker_comment", label: "Checker comment" },
  { key: "linked_internal_order", label: "Internal order" },
  { key: "linked_internal_jc", label: "Internal JC" },
  { key: "cancel_reason", label: "Cancel reason" },
  { key: "created_at", label: "Created" },
  { key: "approved_at", label: "Approved" },
  { key: "fulfilled_at", label: "Fulfilled" },
];

const PUR_FIELDS: FieldDef[] = [
  { key: "indent_number", label: "Indent number" },
  { key: "indent_id", label: "Row ID" },
  { key: "status", label: "Status" },
  { key: "entity", label: "Entity" },
  { key: "material_sku_name", label: "Material" },
  { key: "required_qty_kg", label: "Required qty (kg)" },
  { key: "shortfall_qty_kg", label: "Shortfall qty (kg)" },
  { key: "allocated_qty_kg", label: "Allocated qty (kg)" },
  { key: "required_by_date", label: "Required by" },
  { key: "priority", label: "Priority" },
  { key: "indent_source", label: "Source" },
  { key: "customer_name", label: "Customer" },
  { key: "so_reference", label: "SO reference" },
  { key: "plan_line_id", label: "Plan line" },
  { key: "job_card_id", label: "Job card" },
  { key: "triggered_by_batch", label: "Triggered by batch" },
  { key: "store_allocation_id", label: "Store allocation" },
  { key: "po_reference", label: "PO reference" },
  { key: "acknowledged_by", label: "Acknowledged by" },
  { key: "acknowledged_at", label: "Acknowledged at" },
  { key: "allocated_by", label: "Allocated by" },
  { key: "allocated_at", label: "Allocated at" },
  { key: "insufficient_reason", label: "Insufficient reason" },
  { key: "cascade_from_indent_id", label: "Cascaded from" },
  { key: "cascade_reason", label: "Cascade reason" },
  { key: "cascade_event_id", label: "Cascade event" },
  { key: "cancelled_at", label: "Cancelled at" },
  { key: "cancelled_reason", label: "Cancelled reason" },
  { key: "created_at", label: "Created" },
];

// ── Page ─────────────────────────────────────────────────────────────────

export default function ProdIndentsPage() {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);
  useRequireModuleAccess("production/prod-indents", router.replace);
  // `me` only tells us whether identity has hydrated yet — useHasPermission
  // returns false while it is null, and we must not flash "no permission" at
  // an operator who simply hasn't loaded yet.
  const me = useMe();

  const perms: Perms = {
    prodView: useHasPermission("production", "production_indents", null, "view"),
    prodCreate: useHasPermission("production", "production_indents", null, "create"),
    prodApprove: useHasPermission("production", "production_indents", "approve", "create"),
    purView: useHasPermission("production", "indents", null, "view"),
    purEdit: useHasPermission("production", "indents", null, "edit"),
    purSend: useHasPermission("production", "indents", "send", "create"),
    purAck: useHasPermission("production", "indents", "acknowledge", "create"),
    purLinkPo: useHasPermission("production", "indents", "link_po", "create"),
  };

  const [tab, setTab] = useState<TabKey>("production");

  // Filters (shared across both tabs; `status` re-scopes per tab)
  const [entity, setEntity] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  // Bumped after every successful mutation so the fetch effect refires even
  // when no filter changed (the operator is usually already on page 1).
  const [reloadKey, setReloadKey] = useState(0);

  // Data
  const [prodRows, setProdRows] = useState<ProductionIndentRow[]>([]);
  const [purRows, setPurRows] = useState<PurchaseIndentRow[]>([]);
  const [pagination, setPagination] = useState<IndentPagination>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // UI
  const [toast, setToast] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [createOpen, setCreateOpen] = useState(false);
  // Key of the mutation currently in flight ("<id>:<action>"), so only the
  // clicked button spins and the rest of the row stays interactive.
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const canViewTab = tab === "production" ? perms.prodView : perms.purView;
  // Only assert a denial once identity has actually loaded.
  const denied = me !== null && !canViewTab;
  const rangeInverted = !!dateFrom && !!dateTo && dateFrom > dateTo;

  // Debounce the search box; every change resets to page 1 so a stale page
  // beyond the new result set is never requested.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!authed || denied) return;
    const c = new AbortController();
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const filters: IndentFilters = {
          entity: entity || undefined,
          status: status || undefined,
          search: debouncedSearch || undefined,
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
          page,
          page_size: PAGE_SIZE,
        };
        if (tab === "production") {
          const resp = await listProductionIndents(filters, c.signal);
          if (c.signal.aborted) return;
          setProdRows(resp.results ?? []);
          setPagination(resp.pagination ?? {});
        } else {
          const resp = await listPurchaseIndents(filters, c.signal);
          if (c.signal.aborted) return;
          setPurRows(resp.results ?? []);
          setPagination(resp.pagination ?? {});
        }
      } catch (e) {
        if (c.signal.aborted) return;
        setError(friendlyApiError(e));
      } finally {
        if (!c.signal.aborted) setLoading(false);
      }
    })();
    return () => c.abort();
  }, [authed, denied, tab, entity, status, debouncedSearch, dateFrom, dateTo, page, reloadKey]);

  const reload = useCallback(() => {
    setPage(1);
    setReloadKey((k) => k + 1);
  }, []);

  const onPage = useCallback((p: number) => setPage(p), []);

  function changeTab(next: TabKey) {
    if (next === tab) return;
    setTab(next);
    // The two lifecycles share no status values — carrying one over would
    // silently return zero rows.
    setStatus("");
    setPage(1);
    setDrawer(null);
    setActionError(null);
  }

  function clearAllFilters() {
    setEntity("");
    setStatus("");
    setSearch("");
    setDateFrom("");
    setDateTo("");
    setPage(1);
  }

  const anyFilterActive = !!entity || !!status || !!search || !!dateFrom || !!dateTo;

  // ── Mutations ──────────────────────────────────────────────────────────
  //
  // `updated: false` (HTTP 200) means the UPDATE's status guard did not match:
  // the row moved on under us. Say so, refetch, and do NOT raise an error.

  function afterTransition(res: IndentTransitionResult, expected: string, done: string) {
    if (res.updated) setToast(done);
    else setToast(`This indent is no longer in ${expected} state — the list has been refreshed.`);
    setDrawer(null);
    reload();
  }

  async function runProdAction(
    row: ProductionIndentRow,
    kind: ProdAction,
    input: { comment?: string; reason?: string } = {},
  ) {
    const id = row.prod_indent_id;
    setBusy(`${id}:${kind}`);
    setActionError(null);
    try {
      if (kind === "internal_order") {
        const r = await createInternalOrder(id);
        setToast(
          `Internal order ${r.internal_order_id} and job card ${r.internal_jc_id} created` +
            (r.bom_found ? "." : " — no BOM match, components were not exploded."),
        );
        setDrawer(null);
        reload();
        return;
      }
      const res =
        kind === "submit"
          ? await submitProductionIndent(id)
          : kind === "approve"
            ? await approveProductionIndent(id, input.comment ?? "")
            : kind === "return"
              ? await returnProductionIndent(id, input.comment ?? "")
              : await cancelProductionIndent(id, input.reason ?? "");
      const expected =
        kind === "submit" ? "draft" : kind === "cancel" ? "an open" : "submitted";
      const done =
        kind === "submit"
          ? `Indent ${id} submitted for approval.`
          : kind === "approve"
            ? `Indent ${id} approved.`
            : kind === "return"
              ? `Indent ${id} returned to the maker.`
              : `Indent ${id} cancelled.`;
      afterTransition(res, expected, done);
    } catch (e) {
      setActionError(friendlyApiError(e));
    } finally {
      setBusy(null);
    }
  }

  async function runPurAction(
    row: PurchaseIndentRow,
    kind: PurAction,
    input: { po?: string; patch?: PurchaseIndentEditBody } = {},
  ) {
    const id = row.indent_id;
    const label = row.indent_number || `#${id}`;
    setBusy(`${id}:${kind}`);
    setActionError(null);
    try {
      const res =
        kind === "send"
          ? await sendPurchaseIndent(id)
          : kind === "acknowledge"
            ? await acknowledgePurchaseIndent(id)
            : kind === "link_po"
              ? await linkPurchaseIndentToPo(id, input.po ?? "")
              : await editPurchaseIndent(id, input.patch ?? {});
      const expected =
        kind === "send" ? "draft" : kind === "acknowledge" ? "raised" : kind === "link_po" ? "acknowledged" : "draft";
      const done =
        kind === "send"
          ? `Indent ${label} sent to purchase.`
          : kind === "acknowledge"
            ? `Indent ${label} acknowledged.`
            : kind === "link_po"
              ? `Indent ${label} linked to PO ${input.po}.`
              : `Indent ${label} updated.`;
      // These four route through indent_manager, whose refusals the router
      // normalises to {updated:false} — isNotUpdated also catches the raw
      // {error:...} shape, so a refused write can never toast as a success.
      afterTransition({ updated: !isNotUpdated(res) }, expected, done);
    } catch (e) {
      setActionError(friendlyApiError(e));
    } finally {
      setBusy(null);
    }
  }

  const rowCount = tab === "production" ? prodRows.length : purRows.length;
  const showRefreshBar = loading && rowCount > 0;

  return (
    <ProdIndentsChrome title="Production Indents" showBackToProduction>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-baseline gap-3 min-w-0">
          <h1 className="text-[20px] leading-[24px] font-semibold text-[var(--text-primary)]">
            Production Indents
          </h1>
          <p className="hidden lg:inline text-[12px] text-[var(--text-muted)] truncate">
            FG/SFG maker-checker indents and RM/PM shortage indents to purchase.
          </p>
        </div>
        {tab === "production" && perms.prodCreate ? (
          <button type="button" className={BTN_PRIMARY} onClick={() => setCreateOpen(true)}>
            Raise indent
          </button>
        ) : null}
      </div>

      <FilterBar
        entity={entity}
        onEntity={(v) => { setEntity(v); setPage(1); }}
        status={status}
        statusOptions={tab === "production" ? PRODUCTION_INDENT_STATUSES : PURCHASE_INDENT_STATUSES}
        onStatus={(v) => { setStatus(v); setPage(1); }}
        search={search}
        onSearch={setSearch}
        dateFrom={dateFrom}
        onDateFrom={(v) => { setDateFrom(v); setPage(1); }}
        dateTo={dateTo}
        onDateTo={(v) => { setDateTo(v); setPage(1); }}
        rangeInverted={rangeInverted}
        anyFilterActive={anyFilterActive}
        onClear={clearAllFilters}
      />

      <div className="flex gap-[2px] border-b border-[var(--aws-border)] overflow-x-auto mb-3" role="tablist">
        <TabBtn label="Production (FG/SFG)" active={tab === "production"} onClick={() => changeTab("production")} />
        <TabBtn label="Purchase (RM/PM)" active={tab === "purchase"} onClick={() => changeTab("purchase")} />
      </div>

      {toast ? (
        <div className="mb-3 px-3 py-2 rounded-sm border border-[var(--aws-border)] bg-[#f1faff] text-[12px] text-[var(--text-primary)] flex items-center justify-between gap-2">
          <span>{toast}</span>
          <button onClick={() => setToast(null)} className="text-[var(--aws-link)] hover:underline">
            Dismiss
          </button>
        </div>
      ) : null}

      {actionError ? (
        <div className="mb-3 px-3 py-2 rounded-sm border border-[#e6bcbe] bg-[#fdf0f1] text-[12px] text-[#9a393e] flex items-center justify-between gap-2">
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)} className="text-[var(--aws-link)] hover:underline">
            Dismiss
          </button>
        </div>
      ) : null}

      <div
        aria-hidden
        className={[
          "h-0.5 rounded-full overflow-hidden transition-opacity duration-150 mb-2",
          showRefreshBar ? "opacity-100" : "opacity-0",
        ].join(" ")}
      >
        <div className="h-full bg-[var(--aws-orange)] animate-pulse" />
      </div>

      {denied ? (
        <Centered>You do not have permission to view these indents.</Centered>
      ) : loading && rowCount === 0 ? (
        <Centered>Loading indents…</Centered>
      ) : error ? (
        <Centered tone="error">{error}</Centered>
      ) : rowCount === 0 ? (
        <Centered>
          {anyFilterActive ? "No indents match your filters." : "No indents have been raised yet."}
        </Centered>
      ) : (
        <>
          <div
            aria-busy={loading}
            className={loading ? "opacity-70 transition-opacity" : "transition-opacity"}
          >
            {tab === "production" ? (
              <ProductionTable
                rows={prodRows}
                perms={perms}
                busy={busy}
                onOpen={(row, action) => setDrawer({ tab: "production", row, action: action ?? null })}
                onRun={runProdAction}
              />
            ) : (
              <PurchaseTable
                rows={purRows}
                perms={perms}
                busy={busy}
                onOpen={(row, action) => setDrawer({ tab: "purchase", row, action: action ?? null })}
                onRun={runPurAction}
              />
            )}
          </div>
          <Pagination pg={pagination} onPage={onPage} loading={loading} />
        </>
      )}

      {drawer ? (
        <DetailDrawer
          state={drawer}
          perms={perms}
          busy={busy}
          onClose={() => setDrawer(null)}
          onSetAction={(a) =>
            setDrawer((cur) =>
              cur === null
                ? cur
                : cur.tab === "production"
                  ? { ...cur, action: a as ProdAction | null }
                  : { ...cur, action: a as PurAction | null },
            )
          }
          onRunProd={runProdAction}
          onRunPur={runPurAction}
        />
      ) : null}

      {createOpen ? (
        <CreateIndentModal
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            setToast(`Indent ${id} created as a draft.`);
            reload();
          }}
        />
      ) : null}
    </ProdIndentsChrome>
  );
}

// A guarded UPDATE that matched nothing comes back as {updated:false}; the
// routes are typed `unknown` so we sniff the shape defensively.
//
// The second clause is not redundant. indent_manager predates the purchase
// routes and refuses with {"error": "not_draft" | "invalid_status" |
// "no_fields"}; the router now normalises that to {updated:false} (see
// _indent_result), but testing ONLY for `updated` is precisely the bug that
// let a refused write render as a green success toast — so we keep detecting
// the raw shape too, and any future service that leaks it is caught here
// rather than silently reported as done.
function isNotUpdated(r: unknown): boolean {
  if (!r || typeof r !== "object") return false;
  const o = r as { updated?: unknown; error?: unknown };
  if ("updated" in o && o.updated === false) return true;
  return "error" in o && !!o.error;
}

// ── Filter bar ───────────────────────────────────────────────────────────

interface FilterBarProps {
  entity: string;
  onEntity: (v: string) => void;
  status: string;
  statusOptions: readonly string[];
  onStatus: (v: string) => void;
  search: string;
  onSearch: (v: string) => void;
  dateFrom: string;
  onDateFrom: (v: string) => void;
  dateTo: string;
  onDateTo: (v: string) => void;
  rangeInverted: boolean;
  anyFilterActive: boolean;
  onClear: () => void;
}

function FilterBar(p: FilterBarProps) {
  return (
    <div className="border-b border-[var(--aws-border)] mb-3 pb-3 flex flex-wrap items-end gap-2">
      <div className="relative flex-1 min-w-[160px] sm:min-w-[200px] sm:max-w-[260px]">
        <span className="block text-[10px] uppercase tracking-wide text-[var(--text-secondary)] font-semibold mb-0.5">
          Search
        </span>
        <svg
          viewBox="0 0 24 24"
          className="absolute left-2 top-[22px] w-3.5 h-3.5 text-[var(--text-muted)]"
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
          value={p.search}
          onChange={(e) => p.onSearch(e.target.value)}
          placeholder="Indent, item, customer…"
          className={`${INPUT} pl-7`}
        />
      </div>

      <LabeledSelect label="Entity" value={p.entity} onChange={p.onEntity}>
        {ENTITY_OPTS.map((o) => (
          <option key={o.v || "all"} value={o.v}>
            {o.label}
          </option>
        ))}
      </LabeledSelect>

      <LabeledSelect label="Status" value={p.status} onChange={p.onStatus}>
        <option value="">All statuses</option>
        {p.statusOptions.map((s) => (
          <option key={s} value={s}>
            {indentStatusLabel(s)}
          </option>
        ))}
      </LabeledSelect>

      <label className="block">
        <span className="block text-[10px] uppercase tracking-wide text-[var(--text-secondary)] font-semibold mb-0.5">
          Date from
        </span>
        <input
          type="date"
          value={p.dateFrom}
          onChange={(e) => p.onDateFrom(e.target.value)}
          aria-invalid={p.rangeInverted}
          className={p.rangeInverted ? `${INPUT} border-[var(--aws-error)]` : INPUT}
        />
      </label>

      <label className="block">
        <span className="block text-[10px] uppercase tracking-wide text-[var(--text-secondary)] font-semibold mb-0.5">
          Date to
        </span>
        <input
          type="date"
          value={p.dateTo}
          onChange={(e) => p.onDateTo(e.target.value)}
          aria-invalid={p.rangeInverted}
          className={p.rangeInverted ? `${INPUT} border-[var(--aws-error)]` : INPUT}
        />
      </label>

      {p.anyFilterActive ? (
        <button
          type="button"
          onClick={p.onClear}
          className="h-8 px-2.5 text-[11px] rounded-full border border-[var(--aws-border)] text-[var(--text-secondary)] bg-white hover:border-[var(--aws-error)] hover:text-[var(--aws-error)] flex items-center gap-1"
        >
          <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
          Clear
        </button>
      ) : null}

      {p.rangeInverted ? (
        <p className="basis-full text-[11px] text-[var(--aws-error)]">
          “Date from” is after “Date to” — no rows can match this range.
        </p>
      ) : null}
    </div>
  );
}

function LabeledSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-[10px] uppercase tracking-wide text-[var(--text-secondary)] font-semibold mb-0.5">
        {label}
      </span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={INPUT}>
        {children}
      </select>
    </label>
  );
}

function TabBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`text-[12.5px] px-3 py-2 whitespace-nowrap border-b-2 -mb-px ${
        active
          ? "text-[var(--text-primary)] font-semibold border-[var(--aws-orange)]"
          : "text-[var(--text-secondary)] border-transparent hover:text-[var(--text-primary)]"
      }`}
    >
      {label}
    </button>
  );
}

// ── Shared table furniture ───────────────────────────────────────────────

function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={[
        "px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)]",
        right ? "text-right" : "text-left",
      ].join(" ")}
    >
      {children}
    </th>
  );
}

function StatusPill({ status, family }: { status?: string | null; family: TabKey }) {
  const s = (status || "").toLowerCase();
  const styles = family === "production" ? PROD_STATUS_STYLES : PUR_STATUS_STYLES;
  const cls = styles[s] ?? "text-[var(--text-secondary)] bg-[#f4f4f4] border-[#d5dbdb]";
  return (
    <span
      className={["inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-sm border whitespace-nowrap", cls].join(" ")}
    >
      {indentStatusLabel(status)}
    </span>
  );
}

function Centered({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
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

function TableShell({ head, children }: { head: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md overflow-hidden mb-4">
      <div className="overflow-x-auto">
        <table className="w-full text-[12px] border-collapse">
          <thead className="bg-[var(--surface-subtle)] text-[var(--text-primary)]">
            <tr className="border-b border-[var(--aws-border)]">{head}</tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  );
}

// ── Production tab ───────────────────────────────────────────────────────

interface ProductionTableProps {
  rows: ProductionIndentRow[];
  perms: Perms;
  busy: string | null;
  onOpen: (row: ProductionIndentRow, action?: ProdAction) => void;
  onRun: (row: ProductionIndentRow, kind: ProdAction) => void;
}

function ProductionTable({ rows, perms, busy, onOpen, onRun }: ProductionTableProps) {
  return (
    <TableShell
      head={
        <>
          <Th>Indent</Th>
          <Th>Item</Th>
          <Th>Type</Th>
          <Th right>Required</Th>
          <Th right>Available</Th>
          <Th right>Shortfall</Th>
          <Th>Triggered by</Th>
          <Th>Customer</Th>
          <Th>Maker</Th>
          <Th>Checker</Th>
          <Th>Status</Th>
          <Th>Created</Th>
          <Th />
        </>
      }
    >
      {rows.map((row) => {
        const s = (row.status || "").toLowerCase();
        const id = row.prod_indent_id;
        const uom = row.uom || "kg";
        return (
          <tr
            key={id}
            className="border-b border-[var(--aws-border)] hover:bg-[var(--surface-subtle)] cursor-pointer"
            onClick={(e) => {
              if ((e.target as HTMLElement).closest("button")) return;
              onOpen(row);
            }}
          >
            <td className="px-2.5 py-1.5 font-mono whitespace-nowrap">{id}</td>
            <td className="px-2.5 py-1.5 max-w-[220px] truncate" title={row.item_description ?? ""}>
              {row.item_description || "—"}
            </td>
            <td className="px-2.5 py-1.5">
              <span className="inline-block text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-sm border text-[var(--text-secondary)] bg-[#f4f4f4] border-[#d5dbdb]">
                {row.material_type || "—"}
              </span>
            </td>
            <td className="px-2.5 py-1.5 text-right font-mono whitespace-nowrap">
              {fmtIndentQty(row.required_qty)} {uom}
            </td>
            <td className="px-2.5 py-1.5 text-right font-mono whitespace-nowrap">
              {fmtIndentQty(row.available_qty)}
            </td>
            <td className="px-2.5 py-1.5 text-right font-mono whitespace-nowrap">
              {fmtIndentQty(row.shortfall_qty)}
            </td>
            <td className="px-2.5 py-1.5 whitespace-nowrap">
              {row.triggered_by_job_card || row.triggered_by_so || "—"}
            </td>
            <td className="px-2.5 py-1.5 max-w-[140px] truncate" title={row.customer_name ?? ""}>
              {row.customer_name || "—"}
            </td>
            <td className="px-2.5 py-1.5 whitespace-nowrap">{row.maker_user || "—"}</td>
            <td className="px-2.5 py-1.5 whitespace-nowrap">{row.checker_user || "—"}</td>
            <td className="px-2.5 py-1.5">
              <StatusPill status={row.status} family="production" />
            </td>
            <td className="px-2.5 py-1.5 whitespace-nowrap">{fmtIndentDate(row.created_at)}</td>
            <td className="px-2.5 py-1.5">
              <div className="flex items-center justify-end gap-1">
                {perms.prodCreate && s === "draft" ? (
                  <button
                    type="button"
                    className={BTN_ROW}
                    disabled={busy === `${id}:submit`}
                    onClick={() => onRun(row, "submit")}
                  >
                    {busy === `${id}:submit` ? "Submitting…" : "Submit"}
                  </button>
                ) : null}
                {perms.prodApprove && s === "submitted" ? (
                  <>
                    <button type="button" className={BTN_ROW} onClick={() => onOpen(row, "approve")}>
                      Approve
                    </button>
                    <button type="button" className={BTN_ROW} onClick={() => onOpen(row, "return")}>
                      Return
                    </button>
                  </>
                ) : null}
                {/* create-internal-order needs plain `create`; cancel needs
                    `approve.create`. They read backwards from the button
                    labels, so match the router, not the intuition. */}
                {perms.prodCreate && s === "approved" ? (
                  <button
                    type="button"
                    className={BTN_ROW}
                    disabled={busy === `${id}:internal_order`}
                    onClick={() => onRun(row, "internal_order")}
                  >
                    {busy === `${id}:internal_order` ? "Creating…" : "Internal order"}
                  </button>
                ) : null}
                {perms.prodApprove && !isIndentTerminal(s) ? (
                  <button type="button" className={BTN_ROW} onClick={() => onOpen(row, "cancel")}>
                    Cancel
                  </button>
                ) : null}
              </div>
            </td>
          </tr>
        );
      })}
    </TableShell>
  );
}

// ── Purchase tab ─────────────────────────────────────────────────────────

interface PurchaseTableProps {
  rows: PurchaseIndentRow[];
  perms: Perms;
  busy: string | null;
  onOpen: (row: PurchaseIndentRow, action?: PurAction) => void;
  onRun: (row: PurchaseIndentRow, kind: PurAction) => void;
}

function PurchaseTable({ rows, perms, busy, onOpen, onRun }: PurchaseTableProps) {
  return (
    <TableShell
      head={
        <>
          <Th>Indent no.</Th>
          <Th>Material</Th>
          <Th right>Required kg</Th>
          <Th>Required by</Th>
          <Th right>Priority</Th>
          <Th>Source</Th>
          <Th>Customer</Th>
          <Th>PO ref</Th>
          <Th>Acknowledged by</Th>
          <Th>Status</Th>
          <Th>Created</Th>
          <Th />
        </>
      }
    >
      {rows.map((row) => {
        const s = (row.status || "").toLowerCase();
        const id = row.indent_id;
        return (
          <tr
            key={id}
            className="border-b border-[var(--aws-border)] hover:bg-[var(--surface-subtle)] cursor-pointer"
            onClick={(e) => {
              if ((e.target as HTMLElement).closest("button")) return;
              onOpen(row);
            }}
          >
            <td className="px-2.5 py-1.5 font-mono whitespace-nowrap">{row.indent_number || `#${id}`}</td>
            <td className="px-2.5 py-1.5 max-w-[220px] truncate" title={row.material_sku_name ?? ""}>
              {row.material_sku_name || "—"}
            </td>
            <td className="px-2.5 py-1.5 text-right font-mono whitespace-nowrap">
              {fmtIndentQty(row.required_qty_kg)}
            </td>
            <td className="px-2.5 py-1.5 whitespace-nowrap">{fmtIndentDate(row.required_by_date)}</td>
            <td className="px-2.5 py-1.5 text-right font-mono">{row.priority ?? "—"}</td>
            <td className="px-2.5 py-1.5 whitespace-nowrap">{row.indent_source || "—"}</td>
            <td className="px-2.5 py-1.5 max-w-[140px] truncate" title={row.customer_name ?? ""}>
              {row.customer_name || "—"}
            </td>
            <td className="px-2.5 py-1.5 whitespace-nowrap">{row.po_reference || "—"}</td>
            <td className="px-2.5 py-1.5 whitespace-nowrap">{row.acknowledged_by || "—"}</td>
            <td className="px-2.5 py-1.5">
              <StatusPill status={row.status} family="purchase" />
            </td>
            <td className="px-2.5 py-1.5 whitespace-nowrap">{fmtIndentDate(row.created_at)}</td>
            <td className="px-2.5 py-1.5">
              <div className="flex items-center justify-end gap-1">
                {perms.purEdit && s === "draft" ? (
                  <button type="button" className={BTN_ROW} onClick={() => onOpen(row, "edit")}>
                    Edit
                  </button>
                ) : null}
                {perms.purSend && s === "draft" ? (
                  <button
                    type="button"
                    className={BTN_ROW}
                    disabled={busy === `${id}:send`}
                    onClick={() => onRun(row, "send")}
                  >
                    {busy === `${id}:send` ? "Sending…" : "Send"}
                  </button>
                ) : null}
                {perms.purAck && s === "raised" ? (
                  <button
                    type="button"
                    className={BTN_ROW}
                    disabled={busy === `${id}:acknowledge`}
                    onClick={() => onRun(row, "acknowledge")}
                  >
                    {busy === `${id}:acknowledge` ? "Working…" : "Acknowledge"}
                  </button>
                ) : null}
                {perms.purLinkPo && s === "acknowledged" ? (
                  <button type="button" className={BTN_ROW} onClick={() => onOpen(row, "link_po")}>
                    Link PO
                  </button>
                ) : null}
              </div>
            </td>
          </tr>
        );
      })}
    </TableShell>
  );
}

// ── Pagination ───────────────────────────────────────────────────────────

function Pagination({
  pg,
  onPage,
  loading,
}: {
  pg: IndentPagination;
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
  if (endPage - startPage + 1 < maxVisible) startPage = Math.max(1, endPage - maxVisible + 1);
  const pageNums: number[] = [];
  for (let i = startPage; i <= endPage; i++) pageNums.push(i);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-1 py-2 text-[11px]">
      <span className="text-[var(--text-secondary)]">
        Showing {start}–{end} of {total} indents
      </span>
      <div className="flex items-center gap-1">
        <PageBtn disabled={page <= 1 || loading} onClick={() => onPage(page - 1)} aria="Previous">
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
        <PageBtn disabled={page >= totalPages || loading} onClick={() => onPage(page + 1)} aria="Next">
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
  children: React.ReactNode;
  onClick: () => void;
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

// ── Detail drawer (slide-over) ───────────────────────────────────────────
//
// There is no reusable drawer in this codebase; this mirrors the shell of
// plan-list's DispatchModal (header / scrolling body / footer, click-outside
// close, stopPropagation on the panel) but docks it to the right edge.

interface DrawerProps {
  state: NonNullable<DrawerState>;
  perms: Perms;
  busy: string | null;
  onClose: () => void;
  onSetAction: (a: string | null) => void;
  onRunProd: (
    row: ProductionIndentRow,
    kind: ProdAction,
    input?: { comment?: string; reason?: string },
  ) => void;
  onRunPur: (
    row: PurchaseIndentRow,
    kind: PurAction,
    input?: { po?: string; patch?: PurchaseIndentEditBody },
  ) => void;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Escape-to-close plus the focus contract `aria-modal="true"` promises.
 *
 * Declaring aria-modal without managing focus is worse than not declaring it:
 * a screen reader announces a dialog and hides the rest of the page from its
 * virtual cursor, while Tab keeps walking the table *behind* the overlay — so
 * the user is told they are in a dialog they cannot reach. This moves focus
 * in, keeps Tab inside, and puts focus back where it came from on close, so
 * the row the operator was working on is still current after the dialog goes.
 */
function useDialogFocus(onClose: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Captured before we steal focus; restored on unmount.
    const restoreTo = document.activeElement as HTMLElement | null;
    const panel = ref.current;
    // Focus the panel itself rather than the first control: the first control
    // in the drawer is "Close", and landing there invites dismissing the thing
    // you just opened. The panel carries tabIndex={-1} to accept this.
    panel?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !ref.current) return;
      const items = Array.from(
        ref.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      // Wrap at both ends. Also catches focus sitting on the panel itself,
      // where neither branch would otherwise fire.
      if (e.shiftKey && (active === first || active === ref.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      restoreTo?.focus?.();
    };
  }, [onClose]);

  return ref;
}

function DetailDrawer({ state, perms, busy, onClose, onSetAction, onRunProd, onRunPur }: DrawerProps) {
  const panelRef = useDialogFocus(onClose);

  const isProd = state.tab === "production";
  const row: Record<string, unknown> = state.row;
  const title = isProd
    ? state.row.prod_indent_id
    : state.row.indent_number || `Indent #${state.row.indent_id}`;
  const fields = isProd ? PROD_FIELDS : PUR_FIELDS;
  const known = new Set(fields.map((f) => f.key));
  const extras = Object.keys(row).filter((k) => !known.has(k));
  const rowKey = isProd ? state.row.prod_indent_id : String(state.row.indent_id);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="indent-drawer-title"
        className="bg-white h-full w-full max-w-[560px] shadow-[0_8px_32px_rgba(0,28,36,0.28)] flex flex-col outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[var(--aws-border)] flex items-start justify-between gap-2 shrink-0">
          <div className="min-w-0">
            <h2 id="indent-drawer-title" className="text-[14px] font-semibold text-[var(--text-primary)] font-mono truncate">
              {title}
            </h2>
            <div className="mt-1 flex items-center gap-2">
              <StatusPill status={state.row.status} family={state.tab} />
              <span className="text-[11px] text-[var(--text-secondary)]">
                {isProd ? "Production indent (FG/SFG)" : "Purchase indent (RM/PM)"}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 w-7 h-7 inline-flex items-center justify-center rounded-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-subtle)]"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="overflow-y-auto p-4 space-y-4 flex-1">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12px] bg-[var(--surface-subtle)] border border-[var(--aws-border)] rounded p-2.5">
            {fields.map((f) => (
              <KV key={f.key} label={f.label} value={displayValue(f.key, row[f.key])} />
            ))}
          </dl>

          {extras.length > 0 ? (
            <div>
              <p className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)] mb-1">
                Other fields
              </p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12px] bg-[var(--surface-subtle)] border border-[var(--aws-border)] rounded p-2.5">
                {extras.map((k) => (
                  <KV key={k} label={k} value={displayValue(k, row[k])} />
                ))}
              </dl>
            </div>
          ) : null}
        </div>

        <div className="px-4 py-3 border-t border-[var(--aws-border)] shrink-0">
          {state.tab === "production" ? (
            <ProdActionBar
              // Remounting on row/action change resets the comment + reason
              // inputs without a state-syncing effect.
              key={`${rowKey}:${state.action ?? "none"}`}
              row={state.row}
              action={state.action}
              perms={perms}
              busy={busy}
              onSetAction={onSetAction}
              onRun={onRunProd}
              onClose={onClose}
            />
          ) : (
            <PurActionBar
              key={`${rowKey}:${state.action ?? "none"}`}
              row={state.row}
              action={state.action}
              perms={perms}
              busy={busy}
              onSetAction={onSetAction}
              onRun={onRunPur}
              onClose={onClose}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="uppercase tracking-wide font-semibold text-[var(--text-muted)] text-[9px] leading-[12px]">
        {label}
      </div>
      <div className="text-[12px] leading-[16px] text-[var(--text-primary)] break-words">{value}</div>
    </div>
  );
}

// Renders any column value as text. Timestamps and the one DATE column get
// their formatters; unmodelled objects fall back to JSON so nothing is hidden.
function displayValue(key: string, v: unknown): string {
  if (v == null || v === "") return "—";
  if (key === "required_by_date") return fmtIndentDate(String(v));
  if (key.endsWith("_at")) return fmtIndentDateTime(String(v));
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "string" || typeof v === "number") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ── Drawer action bars ───────────────────────────────────────────────────

function ProdActionBar({
  row,
  action,
  perms,
  busy,
  onSetAction,
  onRun,
  onClose,
}: {
  row: ProductionIndentRow;
  action: ProdAction | null;
  perms: Perms;
  busy: string | null;
  onSetAction: (a: string | null) => void;
  onRun: (row: ProductionIndentRow, kind: ProdAction, input?: { comment?: string; reason?: string }) => void;
  onClose: () => void;
}) {
  const [comment, setComment] = useState("");
  const [reason, setReason] = useState("");
  const s = (row.status || "").toLowerCase();
  const id = row.prod_indent_id;
  const inFlight = busy !== null && busy.startsWith(`${id}:`);

  if (action === "approve" || action === "return") {
    const approving = action === "approve";
    return (
      <div className="space-y-2">
        <label className="block">
          <span className="block text-[10px] uppercase tracking-wide text-[var(--text-secondary)] font-semibold mb-0.5">
            Checker comment {approving ? "(optional)" : "(required)"}
          </span>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={2}
            placeholder={approving ? "Why this is approved…" : "What the maker must fix…"}
            className="w-full px-2 py-1.5 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
          />
        </label>
        <p className="text-[11px] text-[var(--text-muted)]">
          The checker name is recorded from your signed-in account.
        </p>
        <div className="flex items-center justify-end gap-2">
          <button type="button" className={BTN_GHOST} onClick={() => onSetAction(null)}>
            Back
          </button>
          <button
            type="button"
            className={approving ? BTN_GREEN : BTN_PRIMARY}
            disabled={inFlight || (!approving && !comment.trim())}
            onClick={() => onRun(row, action, { comment: comment.trim() })}
          >
            {inFlight ? "Working…" : approving ? "Approve indent" : "Return to maker"}
          </button>
        </div>
      </div>
    );
  }

  if (action === "cancel") {
    return (
      <div className="space-y-2">
        <label className="block">
          <span className="block text-[10px] uppercase tracking-wide text-[var(--text-secondary)] font-semibold mb-0.5">
            Cancellation reason (required)
          </span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="Why this indent is being cancelled…"
            className="w-full px-2 py-1.5 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
          />
        </label>
        <div className="flex items-center justify-end gap-2">
          <button type="button" className={BTN_GHOST} onClick={() => onSetAction(null)}>
            Back
          </button>
          <button
            type="button"
            className={BTN_PRIMARY}
            disabled={inFlight || !reason.trim()}
            onClick={() => onRun(row, "cancel", { reason: reason.trim() })}
          >
            {inFlight ? "Cancelling…" : "Cancel indent"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <button type="button" className={BTN_GHOST} onClick={onClose}>
        Close
      </button>
      {perms.prodCreate && s === "draft" ? (
        <button type="button" className={BTN_PRIMARY} disabled={inFlight} onClick={() => onRun(row, "submit")}>
          {inFlight ? "Working…" : "Submit for approval"}
        </button>
      ) : null}
      {perms.prodApprove && s === "submitted" ? (
        <>
          <button type="button" className={BTN_GHOST} onClick={() => onSetAction("return")}>
            Return
          </button>
          <button type="button" className={BTN_GREEN} onClick={() => onSetAction("approve")}>
            Approve
          </button>
        </>
      ) : null}
      {/* Gates match router.py: create-internal-order = production_indents
          .create, cancel = production_indents.approve.create. */}
      {perms.prodCreate && s === "approved" ? (
        <button
          type="button"
          className={BTN_GREEN}
          disabled={inFlight}
          onClick={() => onRun(row, "internal_order")}
        >
          {inFlight ? "Working…" : "Create internal order"}
        </button>
      ) : null}
      {perms.prodApprove && !isIndentTerminal(s) ? (
        <button type="button" className={BTN_GHOST} onClick={() => onSetAction("cancel")}>
          Cancel indent
        </button>
      ) : null}
    </div>
  );
}

function PurActionBar({
  row,
  action,
  perms,
  busy,
  onSetAction,
  onRun,
  onClose,
}: {
  row: PurchaseIndentRow;
  action: PurAction | null;
  perms: Perms;
  busy: string | null;
  onSetAction: (a: string | null) => void;
  onRun: (row: PurchaseIndentRow, kind: PurAction, input?: { po?: string; patch?: PurchaseIndentEditBody }) => void;
  onClose: () => void;
}) {
  const [po, setPo] = useState(row.po_reference ?? "");
  const [qty, setQty] = useState(row.required_qty_kg == null ? "" : String(row.required_qty_kg));
  const [byDate, setByDate] = useState(row.required_by_date ?? "");
  const [priority, setPriority] = useState(row.priority == null ? "" : String(row.priority));
  const s = (row.status || "").toLowerCase();
  const id = row.indent_id;
  const inFlight = busy !== null && busy.startsWith(`${id}:`);

  if (action === "link_po") {
    return (
      <div className="space-y-2">
        <label className="block">
          <span className="block text-[10px] uppercase tracking-wide text-[var(--text-secondary)] font-semibold mb-0.5">
            PO reference (required)
          </span>
          <input value={po} onChange={(e) => setPo(e.target.value)} placeholder="PO number" className={INPUT} />
        </label>
        <div className="flex items-center justify-end gap-2">
          <button type="button" className={BTN_GHOST} onClick={() => onSetAction(null)}>
            Back
          </button>
          <button
            type="button"
            className={BTN_PRIMARY}
            disabled={inFlight || !po.trim()}
            onClick={() => onRun(row, "link_po", { po: po.trim() })}
          >
            {inFlight ? "Linking…" : "Link PO"}
          </button>
        </div>
      </div>
    );
  }

  if (action === "edit") {
    const patch: PurchaseIndentEditBody = {};
    if (qty.trim() && Number(qty) !== Number(row.required_qty_kg)) patch.required_qty_kg = Number(qty);
    if (byDate && byDate !== row.required_by_date) patch.required_by_date = byDate;
    if (priority.trim() && Number(priority) !== row.priority) patch.priority = Number(priority);
    const numbersValid =
      (!qty.trim() || Number.isFinite(Number(qty))) && (!priority.trim() || Number.isFinite(Number(priority)));
    const dirty = Object.keys(patch).length > 0;
    return (
      <div className="space-y-2">
        <div className="grid grid-cols-3 gap-2">
          <label className="block">
            <span className="block text-[10px] uppercase tracking-wide text-[var(--text-secondary)] font-semibold mb-0.5">
              Required kg
            </span>
            <input
              type="number"
              step="0.001"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              className={`${INPUT} no-spinner`}
            />
          </label>
          <label className="block">
            <span className="block text-[10px] uppercase tracking-wide text-[var(--text-secondary)] font-semibold mb-0.5">
              Required by
            </span>
            <input type="date" value={byDate} onChange={(e) => setByDate(e.target.value)} className={INPUT} />
          </label>
          <label className="block">
            <span className="block text-[10px] uppercase tracking-wide text-[var(--text-secondary)] font-semibold mb-0.5">
              Priority
            </span>
            <input
              type="number"
              step="1"
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              className={`${INPUT} no-spinner`}
            />
          </label>
        </div>
        {!numbersValid ? (
          <p className="text-[11px] text-[var(--aws-error)]">Quantity and priority must be numbers.</p>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          <button type="button" className={BTN_GHOST} onClick={() => onSetAction(null)}>
            Back
          </button>
          <button
            type="button"
            className={BTN_PRIMARY}
            disabled={inFlight || !dirty || !numbersValid}
            onClick={() => onRun(row, "edit", { patch })}
          >
            {inFlight ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <button type="button" className={BTN_GHOST} onClick={onClose}>
        Close
      </button>
      {perms.purEdit && s === "draft" ? (
        <button type="button" className={BTN_GHOST} onClick={() => onSetAction("edit")}>
          Edit
        </button>
      ) : null}
      {perms.purSend && s === "draft" ? (
        <button type="button" className={BTN_PRIMARY} disabled={inFlight} onClick={() => onRun(row, "send")}>
          {inFlight ? "Sending…" : "Send to purchase"}
        </button>
      ) : null}
      {perms.purAck && s === "raised" ? (
        <button type="button" className={BTN_GREEN} disabled={inFlight} onClick={() => onRun(row, "acknowledge")}>
          {inFlight ? "Working…" : "Acknowledge"}
        </button>
      ) : null}
      {perms.purLinkPo && s === "acknowledged" ? (
        <button type="button" className={BTN_PRIMARY} onClick={() => onSetAction("link_po")}>
          Link PO
        </button>
      ) : null}
    </div>
  );
}

// ── Create form (production indents only) ────────────────────────────────

function CreateIndentModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (prodIndentId: string) => void;
}) {
  const [item, setItem] = useState("");
  const [materialType, setMaterialType] = useState("FG");
  const [uom, setUom] = useState("kg");
  const [requiredQty, setRequiredQty] = useState("");
  const [availableQty, setAvailableQty] = useState("");
  const [shortfallQty, setShortfallQty] = useState("");
  const [jobCard, setJobCard] = useState("");
  const [so, setSo] = useState("");
  const [customer, setCustomer] = useState("");
  const [entity, setEntity] = useState("cfpl");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // 409 duplicate: the operator must change the item or the SO, so this stays
  // beside those two fields and the form stays open.
  const [dupError, setDupError] = useState<string | null>(null);

  const panelRef = useDialogFocus(onClose);

  const qtyValid = requiredQty.trim() !== "" && Number.isFinite(Number(requiredQty)) && Number(requiredQty) > 0;
  const canSave = item.trim() !== "" && qtyValid && !saving;

  async function submit() {
    setSaving(true);
    setFormError(null);
    setDupError(null);
    try {
      const body: ProductionIndentCreateBody = {
        item_description: item.trim(),
        material_type: materialType,
        uom: uom.trim() || "kg",
        required_qty: Number(requiredQty),
        entity,
      };
      if (availableQty.trim()) body.available_qty = Number(availableQty);
      if (shortfallQty.trim()) body.shortfall_qty = Number(shortfallQty);
      if (jobCard.trim()) body.triggered_by_job_card = jobCard.trim();
      if (so.trim()) body.triggered_by_so = so.trim();
      if (customer.trim()) body.customer_name = customer.trim();
      const res = await createProductionIndent(body);
      onCreated(res.prod_indent_id);
    } catch (e) {
      if (e instanceof ProductionIndentDuplicateError) setDupError(e.message);
      else setFormError(friendlyApiError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-indent-title"
        className="bg-white rounded-md shadow-[0_8px_32px_rgba(0,28,36,0.28)] w-full max-w-[560px] flex flex-col max-h-[90vh] outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-5 pb-3 border-b border-[var(--aws-border)] flex items-start justify-between gap-3">
          <div>
            <h2 id="create-indent-title" className="text-[15px] font-semibold text-[var(--text-primary)]">
              Raise production indent
            </h2>
            <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">
              Created as a draft. Your signed-in account is recorded as the maker.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-[20px] leading-none text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex-1 space-y-3">
          <Field label="Item description (required)">
            <input
              value={item}
              onChange={(e) => setItem(e.target.value)}
              placeholder="FG / SFG article"
              className={INPUT}
              aria-invalid={!!dupError}
            />
          </Field>

          <div className="grid grid-cols-3 gap-3">
            <Field label="Material type">
              <select value={materialType} onChange={(e) => setMaterialType(e.target.value)} className={INPUT}>
                <option value="FG">FG</option>
                <option value="SFG">SFG</option>
              </select>
            </Field>
            <Field label="UOM">
              <input value={uom} onChange={(e) => setUom(e.target.value)} className={INPUT} />
            </Field>
            <Field label="Entity">
              <select value={entity} onChange={(e) => setEntity(e.target.value)} className={INPUT}>
                <option value="cfpl">CFPL</option>
                <option value="cdpl">CDPL</option>
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Field label="Required qty (required)">
              <input
                type="number"
                step="0.01"
                value={requiredQty}
                onChange={(e) => setRequiredQty(e.target.value)}
                className={`${INPUT} no-spinner`}
              />
            </Field>
            <Field label="Available qty">
              <input
                type="number"
                step="0.01"
                value={availableQty}
                onChange={(e) => setAvailableQty(e.target.value)}
                className={`${INPUT} no-spinner`}
              />
            </Field>
            <Field label="Shortfall qty">
              <input
                type="number"
                step="0.01"
                value={shortfallQty}
                onChange={(e) => setShortfallQty(e.target.value)}
                className={`${INPUT} no-spinner`}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Triggered by job card">
              <input value={jobCard} onChange={(e) => setJobCard(e.target.value)} className={INPUT} />
            </Field>
            <Field label="Triggered by SO">
              <input
                value={so}
                onChange={(e) => setSo(e.target.value)}
                className={INPUT}
                aria-invalid={!!dupError}
              />
            </Field>
          </div>

          <Field label="Customer name">
            <input value={customer} onChange={(e) => setCustomer(e.target.value)} className={INPUT} />
          </Field>

          {dupError ? (
            <p className="px-2 py-1.5 text-[11px] rounded border text-[#9a393e] border-[#e6bcbe] bg-[#fdf0f1]">
              {dupError} Change the item description or the SO reference to continue.
            </p>
          ) : null}
          {!qtyValid && requiredQty.trim() !== "" ? (
            <p className="text-[11px] text-[var(--aws-error)]">Required qty must be a number greater than zero.</p>
          ) : null}
          {formError ? <p className="text-[11px] text-[var(--aws-error)]">{formError}</p> : null}
        </div>

        <div className="px-5 py-3 border-t border-[var(--aws-border)] flex justify-end gap-2 shrink-0">
          <button type="button" className={BTN_GHOST} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={BTN_PRIMARY} disabled={!canSave} onClick={() => void submit()}>
            {saving ? "Creating…" : "Create indent"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[10px] uppercase tracking-wide text-[var(--text-secondary)] font-semibold mb-0.5">
        {label}
      </span>
      {children}
    </label>
  );
}
