"use client";

// Plan List page — mirrors
// frontend_replica/src/modules/production/plan-list/* (review approved
// plans and their job-card chains). Operators filter by entity / status /
// type / date range / search, then approve drafts or cancel them with a
// reason.
//
// Out of scope this iteration:
//   • Row-click navigation to plan detail (separate page; not yet ported)
//   • Per-plan job-card landing after approve (would deep-link to job-card list)
//   • Date range picker (date_from/date_to query support is in the lib;
//     just no UI yet — easy to add)
//   • Plan name edit / re-revision flow

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { BrandMark } from "@/components/BrandMark";
import { useRouter } from "next/navigation";
import { useRequireAuth, useUserInitial, useRequireModuleAccess } from "@/lib/user";
import { friendlyApiError } from "@/lib/apiErrors";
import { BackLink } from "@/components/BackLink";
import {
  type PlanRow,
  type PlanRowLineSummary,
  type PlanPagination,
  type PlanDetail,
  type PlanLineRow,
  type PlanStepRow,
  listPlans,
  getPlan,
  fmtPlanKg,
  fmtPlanUnits,
  fmtPlanDate,
  fmtDateRange,
} from "@/lib/plans";
import { classifyProcess, STAGE_FINAL_FG } from "@/lib/processCatalog";
// The per-plan actions (Create / Edit Job Card, Open, Dispatch, Merge process)
// and their dialogs are shared with SO Creation's "Plans created" panel.
import { DispatchModal, MergeActionBar, MergeProcessModal, RowActions } from "@/lib/planActions";
import { CreateJobCardModal, submitJobCardWizard } from "@/lib/planJobCardModal";
import { planRowFlags } from "@/lib/planRowActions";

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

type Entity = "" | "cfpl" | "cdpl";
type StatusKey = "draft" | "approved" | "executed" | "cancelled";
type PlanTypeKey = "daily" | "weekly";
// Warehouse filter values match the values stored in
// production_plan_v2.warehouse (canonical hyphenated form). The chip
// labels use the shorter factory-code form ("W202", "A185") that
// operators see elsewhere in the app. Empty string = "All".
type WarehouseKey = "" | "W-202" | "A-185";
const WAREHOUSE_OPTS: { v: Exclude<WarehouseKey, "">; label: string }[] = [
  { v: "W-202", label: "W202" },
  { v: "A-185", label: "A185" },
];

const STATUS_OPTS: { v: StatusKey; label: string }[] = [
  { v: "draft",     label: "Draft" },
  { v: "approved",  label: "Approved" },
  { v: "executed",  label: "Executed" },
  { v: "cancelled", label: "Cancelled" },
];
const TYPE_OPTS: { v: PlanTypeKey; label: string }[] = [
  { v: "daily",  label: "Daily" },
  { v: "weekly", label: "Weekly" },
];

// ── Page ──────────────────────────────────────────────────────────────────

export default function PlanListPage() {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);
  useRequireModuleAccess("production/plan-list", router.replace);
  const initial = useUserInitial();

  // Filter state
  const [entity, setEntity] = useState<Entity>("");
  const [warehouse, setWarehouse] = useState<WarehouseKey>("");
  const [status, setStatus] = useState<StatusKey[]>([]);
  const [planType, setPlanType] = useState<PlanTypeKey[]>([]);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  // Bump after a successful mutation (approve / cancel) to force the
  // fetch effect to refire even when no other dependency changed. The
  // previous reload() called setPage(1), which was a no-op when the
  // operator was already on page 1 — React saw an identical state value
  // and skipped the re-render, so the cleared rows[] never re-populated
  // and the list looked empty until a manual filter change.
  const [reloadKey, setReloadKey] = useState(0);

  // Data state
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [pagination, setPagination] = useState<PlanPagination>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // UI state
  const [toast, setToast] = useState<string | null>(null);
  const [expandedPlanId, setExpandedPlanId] = useState<number | null>(null);
  // Create-Job-Card flow (scaffold). Opening sets the target plan; the modal
  // lets the operator pick ONE of the plan's articles (radio). The actual
  // job-card creation (entering process/floor at the JC) is wired in a later
  // step — for now Continue just confirms the pick. This is the path that will
  // replace Approve once the full flow lands.
  const [jcPlan, setJcPlan] = useState<PlanRow | null>(null);
  // Which intent the Create/Edit Job Card modal opened with: "create" starts a
  // fresh / additional (create-another) chain, "edit" opens the existing chain.
  const [jcIntent, setJcIntent] = useState<"create" | "edit">("create");
  const [dispatchPlan, setDispatchPlan] = useState<PlanRow | null>(null);
  // Cross-product process merge: which plans are checked for merging, and
  // whether the merge wizard is open.
  const [selectedPlanIds, setSelectedPlanIds] = useState<Set<number>>(new Set());
  const [mergeOpen, setMergeOpen] = useState(false);

  // Debounce search; bump page back to 1 on every change so a stale page
  // beyond the new result set isn't requested.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  // Stable fingerprints for the array filters so the fetch effect doesn't
  // re-fire on identical array re-allocations.
  const statusKey = status.join("|");
  const typeKey = planType.join("|");

  useEffect(() => {
    if (!authed) return;
    const c = new AbortController();
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const resp = await listPlans(
          {
            entity,
            warehouse: warehouse || undefined,
            status,
            plan_type: planType,
            search: debouncedSearch || undefined,
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
      } finally {
        if (!c.signal.aborted) setLoading(false);
      }
    })();
    return () => c.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, entity, warehouse, statusKey, typeKey, debouncedSearch, page, reloadKey]);

  const resetForFilterChange = useCallback(() => setPage(1), []);

  function changeEntity(v: Entity) {
    setEntity(v);
    resetForFilterChange();
  }

  function toggleWarehouse(v: Exclude<WarehouseKey, "">) {
    // Single-select chip group — click the active chip to clear it.
    setWarehouse((cur) => (cur === v ? "" : v));
    resetForFilterChange();
  }

  function toggleStatus(v: StatusKey) {
    setStatus((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]));
    resetForFilterChange();
  }

  function toggleType(v: PlanTypeKey) {
    setPlanType((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]));
    resetForFilterChange();
  }

  function clearAllFilters() {
    setEntity("");
    setWarehouse("");
    setStatus([]);
    setPlanType([]);
    setSearch("");
    resetForFilterChange();
  }

  // Reload after a successful approve / cancel. Bumping reloadKey
  // forces the fetch effect to refire even when no other dep changed
  // (e.g. operator already on page 1). Resetting page to 1 here is
  // intentional — after a status change the operator usually wants to
  // see the newly-affected plan, which most likely sits at the top of
  // the canonical sort.
  function reload() {
    setPage(1);
    setReloadKey((k) => k + 1);
  }

  // Summary derived client-side from the current page.
  const summary = useMemo(() => {
    const counts = { draft: 0, approved: 0, executed: 0, cancelled: 0 };
    for (const r of rows) {
      const s = (r.status ?? "").toLowerCase();
      if (s in counts) counts[s as keyof typeof counts] += 1;
    }
    return { ...counts, total: pagination.total ?? rows.length };
  }, [rows, pagination.total]);

  const anyFilterActive = !!entity || !!warehouse || status.length > 0 || planType.length > 0 || !!debouncedSearch;

  // Stable handlers so the memoized row components below don't see new
  // function identities on every parent render — without these, every
  // chip click / search keystroke would invalidate React.memo on every
  // row and the table would re-render in full.  router is mutable across
  // renders but its `push` reference is stable in app-router.
  const onToggleExpand = useCallback((p: PlanRow) => {
    setExpandedPlanId((c) => (c === p.plan_id ? null : p.plan_id));
  }, []);
  const onOpen = useCallback((p: PlanRow) => {
    router.push(`/modules/production/plan-list/${p.plan_id}`);
  }, [router]);
  const onDispatch = useCallback((p: PlanRow) => setDispatchPlan(p), []);
  const onPage = useCallback((p: number) => setPage(p), []);
  const onToggleSelect = useCallback((p: PlanRow) => {
    setSelectedPlanIds((cur) => {
      const next = new Set(cur);
      if (next.has(p.plan_id)) next.delete(p.plan_id);
      else next.add(p.plan_id);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelectedPlanIds(new Set()), []);

  // Surface a thin, non-blocking progress bar whenever a fetch is in
  // flight AND we already have rows on screen (the rows-empty case is
  // handled by the centred "Loading plans…" panel below). Without this
  // strip, filter / pagination clicks felt unresponsive — the click
  // landed, but nothing visually changed until the network round-trip
  // completed.
  const showRefreshBar = loading && rows.length > 0;

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <PageHeader initial={initial} router={router} />

      <main className="flex-1 max-w-[1400px] w-full mx-auto px-4 sm:px-6 py-6">
        <div className="mb-3">
          <BackLink parentHref="/modules/production" label="production" />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-baseline gap-3 min-w-0">
            <h1 className="text-[20px] leading-[24px] font-semibold text-[var(--text-primary)]">Plan List</h1>
            <p className="hidden lg:inline text-[12px] text-[var(--text-muted)] truncate">
              Approved + draft plans · filter by entity, status, or type.
            </p>
          </div>
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <EntitySelector value={entity} onChange={changeEntity} />
          </div>
        </div>

        {/* Filter toolbar — search + warehouse + status + type + clear.
            Each chip group wraps onto its own row on narrow screens via
            flex-wrap so phones don't get a horizontal scrollbar. */}
        <div className="border-b border-[var(--aws-border)] mb-3 pb-3 flex flex-wrap items-center gap-1.5">
          <SearchInput value={search} onChange={setSearch} />
          <div className="flex items-center gap-1 ml-1 flex-wrap">
            <span className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)] mr-1 hidden sm:inline">Warehouse</span>
            {WAREHOUSE_OPTS.map((o) => (
              <FilterChip
                key={o.v}
                label={o.label}
                active={warehouse === o.v}
                onClick={() => toggleWarehouse(o.v)}
              />
            ))}
          </div>
          <div className="flex items-center gap-1 ml-1 flex-wrap">
            <span className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)] mr-1 hidden sm:inline">Status</span>
            {STATUS_OPTS.map((o) => (
              <FilterChip
                key={o.v}
                label={o.label}
                active={status.includes(o.v)}
                onClick={() => toggleStatus(o.v)}
                tone={STATUS_TONE[o.v]}
              />
            ))}
          </div>
          <div className="flex items-center gap-1 ml-1 flex-wrap">
            <span className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)] mr-1 hidden sm:inline">Type</span>
            {TYPE_OPTS.map((o) => (
              <FilterChip
                key={o.v}
                label={o.label}
                active={planType.includes(o.v)}
                onClick={() => toggleType(o.v)}
              />
            ))}
          </div>
          {anyFilterActive ? (
            <button
              onClick={clearAllFilters}
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

        {/* Compact summary chip row — one strip, not a card grid. */}
        <SummaryStrip summary={summary} />

        {selectedPlanIds.size >= 1 ? (
          <MergeActionBar
            count={selectedPlanIds.size}
            onClear={clearSelection}
            onMerge={() => setMergeOpen(true)}
          />
        ) : null}

        {toast ? (
          <div className="mb-3 px-3 py-2 rounded-sm border border-[var(--aws-border)] bg-[#f1faff] text-[12px] text-[var(--text-primary)] flex items-center justify-between gap-2">
            <span>{toast}</span>
            <button onClick={() => setToast(null)} className="text-[var(--aws-link)] hover:underline">
              Dismiss
            </button>
          </div>
        ) : null}

        {/* Thin animated bar — instant feedback for chip / pagination
            clicks while the fetch is still in flight. CSS-only; cheap. */}
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
          <Centered>Loading plans…</Centered>
        ) : error ? (
          <Centered tone="error">{error}</Centered>
        ) : rows.length === 0 ? (
          <Centered>No plans match your filters.</Centered>
        ) : (
          <>
            <div
              aria-busy={loading}
              className={loading ? "opacity-70 transition-opacity" : "transition-opacity"}
            >
              <PlansList
                rows={rows}
                expandedPlanId={expandedPlanId}
                selectedPlanIds={selectedPlanIds}
                onToggleSelect={onToggleSelect}
                onToggleExpand={onToggleExpand}
                onOpen={onOpen}
                onCreateJobCard={(p, ci) => { setJcIntent(ci); setJcPlan(p); }}
                onDispatch={onDispatch}
              />
            </div>
            <Pagination pg={pagination} onPage={onPage} loading={loading} />
          </>
        )}
      </main>


      {jcPlan ? (
        <CreateJobCardModal
          plan={jcPlan}
          intent={jcIntent}
          onClose={() => setJcPlan(null)}
          onContinue={async (p) => {
            // The API calls + toast text live in submitJobCardWizard (shared
            // with SO Creation). "Pick an article first." returns before the
            // toast is cleared, as it always has.
            if (p.planLineId != null) setToast(null);
            const r = await submitJobCardWizard(jcPlan, p);
            setToast(r.message);
            if (r.ok) reload();
            return r.ok;
          }}
        />
      ) : null}

      {dispatchPlan ? (
        <DispatchModal
          plan={dispatchPlan}
          onClose={() => setDispatchPlan(null)}
          onToast={setToast}
        />
      ) : null}

      {mergeOpen ? (
        <MergeProcessModal
          planIds={[...selectedPlanIds]}
          onClose={() => setMergeOpen(false)}
          onDone={(msg) => {
            setToast(msg);
            setMergeOpen(false);
            clearSelection();
            reload();
          }}
        />
      ) : null}

      <Footer />
    </div>
  );
}

// ── Chrome ────────────────────────────────────────────────────────────────

function PageHeader({ initial, router }: { initial: string; router: ReturnType<typeof useRouter> }) {
  return (
    <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-6 gap-4">
      <BrandMark />
      <span className="text-[#d5dbdb] text-[13px] hidden sm:inline">Console</span>
      <nav className="text-[12px] text-[#d5dbdb] hidden md:flex items-center gap-2 ml-2">
        <button onClick={() => router.push("/modules")} className="hover:underline">Modules</button>
        <span>/</span>
        <button onClick={() => router.push("/modules/production")} className="hover:underline">Production</button>
        <span>/</span>
        <span className="text-white">Plan List</span>
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
  );
}

function Footer() {
  return (
    <footer className="border-t border-[var(--aws-border)] bg-white py-3 px-6 text-[11px] text-[var(--text-secondary)] flex flex-wrap justify-center gap-x-4 gap-y-1">
      <a href="#" className="hover:underline">Privacy</a>
      <span>© {new Date().getFullYear()}</span>
    </footer>
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

// ── Entity selector ──────────────────────────────────────────────────────

function EntitySelector({ value, onChange }: { value: Entity; onChange: (v: Entity) => void }) {
  const opts: { v: Entity; label: string }[] = [
    { v: "",     label: "All" },
    { v: "cfpl", label: "CFPL" },
    { v: "cdpl", label: "CDPL" },
  ];
  return (
    <div className="flex items-center bg-white border border-[var(--aws-border-strong)] rounded-[2px] overflow-hidden">
      {opts.map((o, i) => (
        <button
          key={o.v || "all"}
          onClick={() => onChange(o.v)}
          className={[
            "h-8 px-3 text-[12px] font-medium transition-colors",
            i > 0 ? "border-l border-[var(--aws-border)]" : "",
            value === o.v
              ? "bg-[var(--aws-navy)] text-white"
              : "bg-white text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)]",
          ].join(" ")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Search input ─────────────────────────────────────────────────────────

function SearchInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative flex-1 min-w-[160px] sm:min-w-[200px] sm:max-w-[260px]">
      <svg
        viewBox="0 0 24 24"
        className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]"
        fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search plans…"
        className="w-full h-7 pl-7 pr-2 text-[12px] rounded-[2px] bg-white border border-[var(--aws-border)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
      />
    </div>
  );
}

// ── Status tone palette ─────────────────────────────────────────────────

const STATUS_TONE: Record<StatusKey, "blue" | "green" | "purple" | "neutral"> = {
  draft:     "blue",
  approved:  "green",
  executed:  "purple",
  cancelled: "neutral",
};

function FilterChip({
  label, active, onClick, tone,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  tone?: "blue" | "green" | "purple" | "neutral";
}) {
  // Tinted active state per-tone; otherwise a neutral selected state.
  const activeCls = tone === "green"   ? "bg-[#eaf6ed] border-[#b6dbb1] text-[#1d8102]"
                  : tone === "purple"  ? "bg-[#f0eef8] border-[#d2cef0] text-[#5752c4]"
                  : tone === "neutral" ? "bg-[var(--surface-subtle)] border-[var(--aws-border)] text-[var(--text-secondary)]"
                  : tone === "blue"    ? "bg-[#eaf3ff] border-[#bbd9f3] text-[var(--aws-link)]"
                                       : "bg-[var(--aws-navy)] border-[var(--aws-navy)] text-white";
  return (
    <button
      onClick={onClick}
      className={[
        "h-7 px-2.5 text-[12px] rounded-full border transition-colors",
        active ? activeCls : "bg-white border-[var(--aws-border)] text-[var(--text-primary)] hover:border-[var(--aws-navy)]",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

// ── Summary strip ───────────────────────────────────────────────────────

function SummaryStrip({
  summary,
}: {
  summary: { total: number; draft: number; approved: number; executed: number; cancelled: number };
}) {
  const items = [
    { label: "Total",     value: summary.total,     tone: "neutral" as const },
    { label: "Draft",     value: summary.draft,     tone: "blue"    as const },
    { label: "Approved",  value: summary.approved,  tone: "green"   as const },
    { label: "Executed",  value: summary.executed,  tone: "purple"  as const },
    { label: "Cancelled", value: summary.cancelled, tone: "neutral" as const },
  ];
  const dotCls = (t: "neutral" | "blue" | "green" | "purple") =>
    t === "blue"   ? "bg-[var(--aws-link)]" :
    t === "green"  ? "bg-[#1d8102]" :
    t === "purple" ? "bg-[#5752c4]" :
                     "bg-[var(--text-muted)]";
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mb-3 text-[12px]">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <span className={["inline-block w-1.5 h-1.5 rounded-full", dotCls(it.tone)].join(" ")} />
          <span className="text-[var(--text-muted)]">{it.label}</span>
          <span className="font-semibold text-[var(--text-primary)]">{it.value}</span>
        </span>
      ))}
    </div>
  );
}

// ── Plans list (table + mobile cards) ────────────────────────────────────

function PlansList({
  rows, expandedPlanId, selectedPlanIds, onToggleSelect,
  onToggleExpand, onOpen, onCreateJobCard, onDispatch,
}: {
  rows: PlanRow[];
  expandedPlanId: number | null;
  selectedPlanIds: Set<number>;
  onToggleSelect: (p: PlanRow) => void;
  onToggleExpand: (p: PlanRow) => void;
  onOpen:    (p: PlanRow) => void;
  onCreateJobCard: (p: PlanRow, intent: "create" | "edit") => void;
  onDispatch: (p: PlanRow) => void;
}) {
  // The handlers are passed through verbatim — the row components apply
  // the per-row binding internally.  Wrapping callbacks here with an
  // inline `() => onOpen(r)` would mint a new function identity per
  // row per render and defeat React.memo on the rows.
  return (
    <>
      {/* Mobile (< md): stacked cards */}
      <div className="md:hidden space-y-2 mb-3">
        {rows.map((r) => (
          <PlanMobileCard
            key={r.plan_id}
            row={r}
            expanded={expandedPlanId === r.plan_id}
            selected={selectedPlanIds.has(r.plan_id)}
            onToggleSelect={onToggleSelect}
            onToggleExpand={onToggleExpand}
            onOpen={onOpen}
            onCreateJobCard={onCreateJobCard}
            onDispatch={onDispatch}
          />
        ))}
      </div>

      {/* md+: table */}
      <div className="hidden md:block bg-white border border-[var(--aws-border)] rounded-md overflow-hidden mb-4">
        <div className="overflow-x-auto">
          <table className="w-full text-[12px] border-collapse">
            <thead className="bg-[var(--surface-subtle)] text-[var(--text-primary)]">
              <tr className="border-b border-[var(--aws-border)]">
                <Th />
                <Th />
                <Th>Plan</Th>
                <Th>Type</Th>
                <Th>Date range</Th>
                <Th>Status</Th>
                <Th right>Lines</Th>
                <Th right>Volume</Th>
                <Th right>Units</Th>
                <Th>Created</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <PlanRowDesktop
                  key={r.plan_id}
                  row={r}
                  expanded={expandedPlanId === r.plan_id}
                  selected={selectedPlanIds.has(r.plan_id)}
                  onToggleSelect={onToggleSelect}
                  onToggleExpand={onToggleExpand}
                  onOpen={onOpen}
                  onCreateJobCard={onCreateJobCard}
                  onDispatch={onDispatch}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// ── Article + qty summary (inline, under each plan row) ──────────────────
//
// Server returns up to 20 line summaries per plan in `lines_summary`.  We
// surface the first three inline so the operator can scan plans by their
// FG SKU + kg without expanding the row.  When the plan has more lines,
// a "+N more" hint nudges them to click expand for the full picture.

function ArticleSummary({
  summary, totalLineCount,
}: {
  summary?: PlanRowLineSummary[] | null;
  totalLineCount?: number | null;
}) {
  if (!summary || summary.length === 0) return null;
  const SHOW = 3;
  const shown = summary.slice(0, SHOW);
  const known = summary.length;
  const total = typeof totalLineCount === "number" ? totalLineCount : known;
  const remainder = Math.max(0, total - shown.length);
  return (
    <ul className="mt-1 space-y-0.5 text-[11px] leading-[14px] text-[var(--text-secondary)]">
      {shown.map((l, i) => {
        const kg = l.planned_qty_kg != null ? fmtPlanKg(l.planned_qty_kg) : null;
        const pcs = l.planned_qty_units != null && l.planned_qty_units !== ""
          ? String(l.planned_qty_units)
          : null;
        return (
          <li
            key={l.plan_line_id ?? `${i}-${l.fg_sku_name ?? ""}`}
            className="flex items-baseline gap-1.5 min-w-0"
            title={l.fg_sku_name ?? ""}
          >
            <span className="truncate text-[var(--text-primary)]">
              {l.fg_sku_name || "—"}
            </span>
            <span className="shrink-0 font-mono text-[var(--text-muted)] whitespace-nowrap">
              {kg != null ? `${kg} kg` : ""}
              {kg != null && pcs != null ? " · " : ""}
              {pcs != null ? `${pcs} pcs` : ""}
            </span>
          </li>
        );
      })}
      {remainder > 0 ? (
        <li className="text-[10px] text-[var(--text-muted)] italic">
          + {remainder} more line{remainder === 1 ? "" : "s"}
        </li>
      ) : null}
    </ul>
  );
}

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

// React.memo so each row only re-renders when its own props change.
// Without this, every search keystroke / chip click / pagination tick
// re-renders the entire ~50-row table — even when nothing about a
// given row's data changed.  Parent-supplied callbacks are stabilised
// with useCallback so this memo isn't busted by new function identities.
const PlanRowDesktop = memo(function PlanRowDesktop({
  row, expanded, selected, onToggleSelect, onToggleExpand, onOpen, onCreateJobCard, onDispatch,
}: {
  row: PlanRow;
  expanded: boolean;
  selected: boolean;
  onToggleSelect: (p: PlanRow) => void;
  onToggleExpand: (p: PlanRow) => void;
  onOpen: (p: PlanRow) => void;
  onCreateJobCard: (p: PlanRow, intent: "create" | "edit") => void;
  onDispatch: (p: PlanRow) => void;
}) {
  // Any article already carded ⇒ the row's action is "Edit Job Card".
  // anyCarded → this plan has ≥1 carded line (show Edit). anyRemaining → some
  // line still has balance to card, incl. any un-carded line (show Create).
  // A partially-carded plan shows BOTH buttons side by side.
  const { anyCarded, anyRemaining } = planRowFlags(row);
  // Memoise the row-bound adapters so the per-row buttons / rowclick
  // don't churn their own listeners on every render either.
  const handleToggle = useCallback(() => onToggleExpand(row), [onToggleExpand, row]);
  const handleOpen = useCallback(() => onOpen(row), [onOpen, row]);
  const handleCreateJobCard = useCallback(
    (intent: "create" | "edit") => onCreateJobCard(row, intent),
    [onCreateJobCard, row],
  );
  const handleDispatch = useCallback(() => onDispatch(row), [onDispatch, row]);
  return (
    <>
    <tr
      className={[
        "border-b border-[var(--aws-border)] hover:bg-[var(--surface-subtle)] cursor-pointer",
        expanded ? "bg-[var(--surface-subtle)]" : "",
      ].join(" ")}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        handleToggle();
      }}
    >
      <td
        className="px-2 py-1.5 w-[28px]"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(row)}
          aria-label={`Select ${row.plan_name || `Plan #${row.plan_id}`} to merge`}
          className="accent-[var(--aws-orange)] cursor-pointer align-middle"
        />
      </td>
      <td className="px-2 py-1.5 w-[24px] text-[var(--text-secondary)]">
        <button
          type="button"
          aria-label={expanded ? "Collapse plan" : "Expand plan"}
          onClick={(e) => { e.stopPropagation(); handleToggle(); }}
          className="inline-flex items-center justify-center w-5 h-5 rounded-sm hover:bg-white"
        >
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2} style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform .15s" }}>
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </td>
      <td className="px-2.5 py-1.5 min-w-[180px] max-w-[360px]">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="font-medium text-[var(--text-primary)]">
            {row.plan_name || `Plan #${row.plan_id}`}
          </span>
          {row.revision_number != null && row.revision_number > 1 ? (
            <span className="text-[9px] uppercase font-bold tracking-wide text-[var(--text-secondary)] bg-[var(--surface-subtle)] border border-[var(--aws-border)] rounded-sm px-1 py-0">
              rev {row.revision_number}
            </span>
          ) : null}
        </div>
        {row.warehouse ? (
          <div className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted)] mt-0.5">
            {row.warehouse}
          </div>
        ) : null}
        <ArticleSummary
          summary={row.lines_summary}
          totalLineCount={row.line_count ?? null}
        />
      </td>
      <td className="px-2.5 py-1.5">
        <TypeBadge type={row.plan_type} />
      </td>
      <td className="px-2.5 py-1.5 text-[var(--text-secondary)] whitespace-nowrap">
        {fmtDateRange(row.date_from, row.date_to)}
      </td>
      <td className="px-2.5 py-1.5">
        <StatusBadge status={row.status} />
      </td>
      <td className="px-2.5 py-1.5 text-right font-mono">{row.line_count ?? 0}</td>
      <td className="px-2.5 py-1.5 text-right whitespace-nowrap">
        <span className="font-semibold">{fmtPlanKg(row.total_planned_kg)} kg</span>
      </td>
      <td className="px-2.5 py-1.5 text-right whitespace-nowrap font-mono text-[var(--text-secondary)]">
        {row.total_planned_units != null ? `${fmtPlanUnits(row.total_planned_units)} pcs` : "—"}
      </td>
      <td className="px-2.5 py-1.5 text-[var(--text-muted)] whitespace-nowrap text-[11px]">
        {row.created_by ? (
          <span className="block text-[var(--text-secondary)] font-medium truncate max-w-[140px]" title={row.created_by}>
            {row.created_by}
          </span>
        ) : null}
        {fmtPlanDate(row.created_at)}
      </td>
      <td className="px-2.5 py-1.5 text-right">
        <RowActions
          anyCarded={anyCarded}
          anyRemaining={anyRemaining}
          onOpen={handleOpen}
          onCreateJobCard={handleCreateJobCard}
          onDispatch={handleDispatch}
        />
      </td>
    </tr>
    {expanded ? (
      <tr className="border-b border-[var(--aws-border)] bg-[var(--surface-subtle)]">
        <td colSpan={11} className="px-3 py-3">
          <PlanInlinePreview planId={row.plan_id} onOpen={handleOpen} />
        </td>
      </tr>
    ) : null}
    </>
  );
});

const PlanMobileCard = memo(function PlanMobileCard({
  row, expanded, selected, onToggleSelect, onToggleExpand, onOpen, onCreateJobCard, onDispatch,
}: {
  row: PlanRow;
  expanded: boolean;
  selected: boolean;
  onToggleSelect: (p: PlanRow) => void;
  onToggleExpand: (p: PlanRow) => void;
  onOpen: (p: PlanRow) => void;
  onCreateJobCard: (p: PlanRow, intent: "create" | "edit") => void;
  onDispatch: (p: PlanRow) => void;
}) {
  // anyCarded → this plan has ≥1 carded line (show Edit). anyRemaining → some
  // line still has balance to card, incl. any un-carded line (show Create).
  // A partially-carded plan shows BOTH buttons side by side.
  const { anyCarded, anyRemaining } = planRowFlags(row);
  const handleToggle = useCallback(() => onToggleExpand(row), [onToggleExpand, row]);
  const handleOpen = useCallback(() => onOpen(row), [onOpen, row]);
  const handleCreateJobCard = useCallback(
    (intent: "create" | "edit") => onCreateJobCard(row, intent),
    [onCreateJobCard, row],
  );
  const handleDispatch = useCallback(() => onDispatch(row), [onDispatch, row]);
  return (
    <div
      className="bg-white border border-[var(--aws-border)] rounded-md overflow-hidden cursor-pointer hover:border-[var(--aws-navy)]"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        handleToggle();
      }}
    >
      <div className="px-2.5 py-2">
        <div className="flex items-center justify-between gap-2 mb-1">
          <div className="min-w-0 flex items-center gap-1.5 flex-wrap">
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggleSelect(row)}
              onClick={(e) => e.stopPropagation()}
              aria-label={`Select ${row.plan_name || `Plan #${row.plan_id}`} to merge`}
              className="shrink-0 accent-[var(--aws-orange)] cursor-pointer"
            />
            <button
              type="button"
              aria-label={expanded ? "Collapse" : "Expand"}
              onClick={(e) => { e.stopPropagation(); handleToggle(); }}
              className="shrink-0 inline-flex items-center justify-center w-5 h-5 -ml-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2} style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform .15s" }}>
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
            <span className="text-[13px] font-semibold text-[var(--text-primary)] truncate">
              {row.plan_name || `Plan #${row.plan_id}`}
            </span>
            {row.revision_number != null && row.revision_number > 1 ? (
              <span className="text-[9px] uppercase font-bold tracking-wide text-[var(--text-secondary)] bg-[var(--surface-subtle)] border border-[var(--aws-border)] rounded-sm px-1 py-0">
                rev {row.revision_number}
              </span>
            ) : null}
          </div>
          <StatusBadge status={row.status} />
        </div>
        <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5 text-[11px] mb-1.5">
          <TypeBadge type={row.plan_type} />
          {row.warehouse ? (
            <span className="text-[var(--text-muted)] font-mono text-[10px]">{row.warehouse}</span>
          ) : null}
          <span className="text-[var(--text-muted)]">{fmtDateRange(row.date_from, row.date_to)}</span>
        </div>
        <div className="flex items-center flex-wrap gap-x-3 gap-y-0.5 text-[11px] mb-1.5">
          <span><span className="text-[var(--text-muted)]">Lines</span> <strong>{row.line_count ?? 0}</strong></span>
          <span><span className="text-[var(--text-muted)]">Volume</span> <strong>{fmtPlanKg(row.total_planned_kg)} kg</strong></span>
          {row.total_planned_units != null ? (
            <span><span className="text-[var(--text-muted)]">Units</span> <strong>{fmtPlanUnits(row.total_planned_units)} pcs</strong></span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-muted)] mb-1.5">
          <span className="uppercase tracking-wide font-semibold">Created</span>
          {row.created_by ? <span className="text-[var(--text-secondary)] font-medium truncate max-w-[160px]" title={row.created_by}>{row.created_by}</span> : null}
          <span>· {fmtPlanDate(row.created_at)}</span>
        </div>
        <ArticleSummary
          summary={row.lines_summary}
          totalLineCount={row.line_count ?? null}
        />
        <div className="flex items-center gap-2 mt-2">
          <RowActions
            anyCarded={anyCarded}
          anyRemaining={anyRemaining}
            onOpen={handleOpen}
            onCreateJobCard={handleCreateJobCard}
            onDispatch={handleDispatch}
          />
        </div>
      </div>
      {expanded ? (
        <div className="border-t border-[var(--aws-border)] px-2.5 py-3 bg-[var(--surface-subtle)]">
          <PlanInlinePreview planId={row.plan_id} onOpen={handleOpen} />
        </div>
      ) : null}
    </div>
  );
});

// ── Inline preview (shown when a row is expanded) ──────────────────────
//
// Lazy-loads via GET /plans-v2/{id} and surfaces a compact summary: header
// audit metadata + lines table (or stacked cards on mobile) + per-line
// floor + step counts. Mirrors the same lazy + cancel pattern used by the
// Planning page's DetailPanel so it survives rapid expand/collapse.

function PlanInlinePreview({
  planId, onOpen,
}: {
  planId: number;
  onOpen: () => void;
}) {
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const c = new AbortController();
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const d = await getPlan(planId, c.signal);
        if (!c.signal.aborted) setDetail(d);
      } catch (e) {
        if (!c.signal.aborted) setError(friendlyApiError(e));
      } finally {
        if (!c.signal.aborted) setLoading(false);
      }
    })();
    return () => c.abort();
  }, [planId]);

  if (loading) {
    return (
      <p className="text-[11px] text-[var(--text-secondary)] flex items-center gap-2">
        <span className="inline-block w-3 h-3 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
        Loading plan…
      </p>
    );
  }
  if (error) return <p className="text-[11px] text-[var(--aws-error)]">{error}</p>;
  if (!detail) return null;

  const lines = detail.lines ?? [];

  return (
    <div className="space-y-3">
      {/* Compact KV grid for plan-level audit data */}
      <dl className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-x-4 gap-y-1.5 text-[12px]">
        <PreviewKV label="Plan ID"     value={`#${detail.plan_id}`} mono />
        <PreviewKV label="Entity"      value={detail.entity?.toUpperCase()} />
        <PreviewKV label="Plan date"   value={detail.plan_date ? fmtPlanDate(detail.plan_date) : undefined} />
        <PreviewKV label="Created by"  value={detail.created_by} />
        <PreviewKV label="Created at"  value={detail.created_at ? fmtPlanDate(detail.created_at) : undefined} />
        {detail.approved_at ? (
          <PreviewKV
            label="Approved"
            value={`${detail.approved_by ?? "—"} · ${fmtPlanDate(detail.approved_at)}`}
          />
        ) : null}
      </dl>

      {/* Lines preview — mobile cards / desktop table */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)]">
            Lines · {lines.length}
          </span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onOpen(); }}
            className="text-[11px] text-[var(--aws-link)] hover:underline inline-flex items-center gap-1"
          >
            Open approval workspace
            <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </button>
        </div>
        {lines.length === 0 ? (
          <p className="text-[11px] text-[var(--text-muted)] italic">No lines on this plan.</p>
        ) : (
          <PreviewLinesList lines={lines.slice(0, 6)} />
        )}
        {lines.length > 6 ? (
          <p className="text-[10px] text-[var(--text-muted)] mt-1">
            Showing first 6 of {lines.length} lines · open the approval workspace to see all.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function PreviewKV({ label, value, mono }: { label: string; value?: string | number | null; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="uppercase tracking-wide font-semibold text-[var(--text-muted)] text-[9px] leading-[12px]">
        {label}
      </div>
      <div className={["text-[12px] leading-[16px] text-[var(--text-primary)] truncate", mono ? "font-mono" : ""].join(" ")}>
        {value == null || value === "" ? "—" : value}
      </div>
    </div>
  );
}

// A plan step is a "packing" step when its stored stage reads as packing, or —
// for older rows without a stage token — when the process classifies as the
// terminal FG/packaging bucket. Everything else is a WIP process. This mirrors
// the backend's is_packing_stage tokenisation (job_card_v2.py).
function isPackingStep(s: PlanStepRow): boolean {
  const stage = (s.stage || "").toLowerCase();
  if (stage.includes("pack")) return true;
  return classifyProcess(s.process_name).stageBucket === STAGE_FINAL_FG;
}

// One labelled stage group (WIP processes / Packing) rendered as ordered rows of
// "process — floor", matching the Create-Job-Card wizard's stage layout so the
// expanded plan row reads the same as the job-card view.
function StageGroup({
  label, tone, steps,
}: {
  label: string;
  tone: "wip" | "pack";
  steps: PlanStepRow[];
}) {
  if (steps.length === 0) return null;
  const dot = tone === "pack" ? "bg-[#9a393e]" : "bg-[var(--aws-orange-active)]";
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-0.5">
        <span className={["inline-block w-1.5 h-1.5 rounded-full", dot].join(" ")} />
        <span className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)]">{label}</span>
        <span className="text-[10px] text-[var(--text-muted)]">· {steps.length}</span>
      </div>
      <ol className="space-y-0.5">
        {steps.map((s, i) => (
          <li
            key={s.step_id ?? `${label}-${i}`}
            className="flex items-baseline gap-2 text-[11px] leading-[15px] pl-3"
          >
            <span className="font-mono text-[10px] text-[var(--text-muted)] w-4 shrink-0 text-right">{i + 1}.</span>
            <span className="text-[var(--text-primary)] truncate" title={s.process_name ?? ""}>
              {s.process_name || "—"}
            </span>
            <span className="text-[var(--text-muted)]">·</span>
            <span className={s.floor ? "text-[var(--text-secondary)]" : "text-[var(--text-muted)] italic"}>
              {s.floor || "floor not set"}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// Per-line process route grouped into WIP processes + Packing — the same shape
// the operator sees in Create/Edit Job Card.
function LineStageBreakdown({ steps }: { steps?: PlanStepRow[] | null }) {
  const ordered = [...(steps ?? [])].sort(
    (a, b) => (a.step_order ?? 0) - (b.step_order ?? 0),
  );
  if (ordered.length === 0) {
    return <p className="text-[10px] text-[var(--text-muted)] italic mt-1">No process route on this line yet.</p>;
  }
  const wip = ordered.filter((s) => !isPackingStep(s));
  const pack = ordered.filter((s) => isPackingStep(s));
  return (
    <div className="mt-1.5 space-y-1.5">
      <StageGroup label="WIP processes" tone="wip" steps={wip} />
      <StageGroup label="Packing" tone="pack" steps={pack} />
    </div>
  );
}

// Makes it unambiguous whether a line's process route is just a plan template
// or has real job cards behind it — answers the "why do steps show with no job
// cards?" confusion directly on each line.
function JobCardCountBadge({ count }: { count?: number | null }) {
  if (count == null) return null;
  const made = count > 0;
  return (
    <span
      className={[
        "inline-block text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-sm border whitespace-nowrap",
        made
          ? "text-[#1d8102] bg-[#eaf6ed] border-[#b6dbb1]"
          : "text-[var(--text-muted)] bg-[var(--surface-subtle)] border-[var(--aws-border)]",
      ].join(" ")}
    >
      {made ? `${count} job card${count === 1 ? "" : "s"}` : "no job cards"}
    </span>
  );
}

// Lines preview — stacked cards at every width so each line can show its full
// WIP → Packing breakdown (not just a step count).
function PreviewLinesList({ lines }: { lines: PlanLineRow[] }) {
  return (
    <ul className="space-y-1.5">
      {lines.map((l) => (
        <li key={l.plan_line_id} className="border border-[var(--aws-border)] rounded bg-white px-2.5 py-2">
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div className="min-w-0">
              <div className="text-[12px] font-semibold text-[var(--text-primary)] truncate" title={l.fg_sku_name ?? ""}>
                {l.fg_sku_name || "—"}
              </div>
              <div className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted)] truncate">
                {l.customer_name || "—"}
              </div>
              <div className="mt-1">
                <JobCardCountBadge count={l.job_card_count} />
              </div>
            </div>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] justify-end">
              <span className="font-semibold whitespace-nowrap">{fmtPlanKg(l.planned_qty_kg)} kg</span>
              {l.planned_qty_units != null ? (
                <span className="text-[var(--text-muted)] whitespace-nowrap">{fmtPlanUnits(l.planned_qty_units)} pcs</span>
              ) : null}
              {l.area ? <span className="text-[var(--text-secondary)] whitespace-nowrap">@ {l.area}</span> : null}
              {l.deadline_date ? <span className="text-[var(--text-muted)] whitespace-nowrap">· {fmtPlanDate(l.deadline_date)}</span> : null}
            </div>
          </div>
          <LineStageBreakdown steps={l.steps} />
        </li>
      ))}
    </ul>
  );
}

// ── Badges ───────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status?: string | null }) {
  const s = (status || "draft").toLowerCase();
  const styles: Record<string, string> = {
    draft:     "text-[var(--aws-link)] bg-[#eaf3ff] border-[#bbd9f3]",
    approved:  "text-[#1d8102] bg-[#eaf6ed] border-[#b6dbb1]",
    executed:  "text-[#5752c4] bg-[#f0eef8] border-[#d2cef0]",
    cancelled: "text-[var(--text-muted)] bg-[var(--surface-subtle)] border-[var(--aws-border)]",
  };
  const cls = styles[s] ?? "text-[var(--text-secondary)] bg-[#f4f4f4] border-[#d5dbdb]";
  return (
    <span className={["inline-block text-[10px] font-semibold capitalize px-1.5 py-0.5 rounded-sm border", cls].join(" ")}>
      {s}
    </span>
  );
}

function TypeBadge({ type }: { type?: string | null }) {
  const t = (type || "daily").toLowerCase();
  const cls = t === "weekly"
    ? "text-[#9a393e] bg-[#fbeced] border-[#e6bcbe]"
    : "text-[var(--text-secondary)] bg-[var(--surface-subtle)] border-[var(--aws-border)]";
  return (
    <span className={["inline-block text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-sm border", cls].join(" ")}>
      {t}
    </span>
  );
}

// ── Pagination ──────────────────────────────────────────────────────────

function Pagination({
  pg, onPage, loading,
}: {
  pg: PlanPagination;
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
        Showing {start}–{end} of {total} plans
      </span>
      <div className="flex items-center gap-1">
        <PageBtn disabled={page <= 1 || loading} onClick={() => onPage(page - 1)} aria="Previous">‹</PageBtn>
        {startPage > 1 ? (
          <>
            <PageBtn onClick={() => onPage(1)}>{1}</PageBtn>
            {startPage > 2 ? <span className="px-1 text-[var(--text-muted)]">…</span> : null}
          </>
        ) : null}
        {pageNums.map((p) => (
          <PageBtn key={p} active={p === page} onClick={() => onPage(p)}>{p}</PageBtn>
        ))}
        {endPage < totalPages ? (
          <>
            {endPage < totalPages - 1 ? <span className="px-1 text-[var(--text-muted)]">…</span> : null}
            <PageBtn onClick={() => onPage(totalPages)}>{totalPages}</PageBtn>
          </>
        ) : null}
        <PageBtn disabled={page >= totalPages || loading} onClick={() => onPage(page + 1)} aria="Next">›</PageBtn>
      </div>
    </div>
  );
}

function PageBtn({
  children, onClick, disabled, active, aria,
}: {
  children: React.ReactNode;
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

