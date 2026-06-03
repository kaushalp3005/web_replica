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

import { useCallback, useEffect, useMemo, useState } from "react";
import { BrandMark } from "@/components/BrandMark";
import { useRouter } from "next/navigation";
import { userStore } from "@/lib/auth";
import { useRequireAuth, useUserInitial } from "@/lib/user";
import { BackLink } from "@/components/BackLink";
import {
  type PlanRow,
  type PlanPagination,
  type PlanDetail,
  type PlanLineRow,
  listPlans,
  approvePlan,
  cancelPlan,
  getPlan,
  fmtPlanKg,
  fmtPlanDate,
  fmtDateRange,
} from "@/lib/plans";

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

type Entity = "" | "cfpl" | "cdpl";
type StatusKey = "draft" | "approved" | "executed" | "cancelled";
type PlanTypeKey = "daily" | "weekly";

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
  const initial = useUserInitial();

  // Filter state
  const [entity, setEntity] = useState<Entity>("");
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
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [expandedPlanId, setExpandedPlanId] = useState<number | null>(null);

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
        setError(e instanceof Error ? e.message : "Failed to load plans");
      } finally {
        if (!c.signal.aborted) setLoading(false);
      }
    })();
    return () => c.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, entity, statusKey, typeKey, debouncedSearch, page, reloadKey]);

  const resetForFilterChange = useCallback(() => setPage(1), []);

  function changeEntity(v: Entity) {
    setEntity(v);
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

  async function doApprove(planId: number) {
    const me = userStore.load();
    const approvedBy = me?.full_name?.trim() || me?.phone || "user";
    setBusy(true);
    setToast(null);
    try {
      const r = await approvePlan(planId, { approved_by: approvedBy });
      const jcCount = (r.job_cards?.lines || [])
        .reduce((n, ln) => n + (ln.job_card_ids?.length || 0), 0);
      const alreadyExisted = r.job_cards?.error === "job_cards_already_exist";
      const msg = jcCount > 0
        ? `Plan approved · ${jcCount} job card${jcCount === 1 ? "" : "s"} generated`
        : alreadyExisted
          ? `Plan approved · job cards already exist (${r.job_cards?.count ?? "?"})`
          : "Plan approved";
      setToast(msg);
      setConfirm(null);
      reload();
    } catch (e) {
      setToast(`Approve failed: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setBusy(false);
    }
  }

  async function doCancel(planId: number, reason: string) {
    setBusy(true);
    setToast(null);
    try {
      await cancelPlan(planId, { reason: reason.trim() });
      setToast("Plan cancelled · reserved fulfillment qty released.");
      setConfirm(null);
      reload();
    } catch (e) {
      setToast(`Cancel failed: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setBusy(false);
    }
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

  const anyFilterActive = !!entity || status.length > 0 || planType.length > 0 || !!debouncedSearch;

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

        {/* Filter toolbar — search + status pills + type pills + clear */}
        <div className="border-b border-[var(--aws-border)] mb-3 pb-3 flex flex-wrap items-center gap-1.5">
          <SearchInput value={search} onChange={setSearch} />
          <div className="flex items-center gap-1 ml-1">
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
          <div className="flex items-center gap-1 ml-1">
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

        {toast ? (
          <div className="mb-3 px-3 py-2 rounded-sm border border-[var(--aws-border)] bg-[#f1faff] text-[12px] text-[var(--text-primary)] flex items-center justify-between gap-2">
            <span>{toast}</span>
            <button onClick={() => setToast(null)} className="text-[var(--aws-link)] hover:underline">
              Dismiss
            </button>
          </div>
        ) : null}

        {loading && rows.length === 0 ? (
          <Centered>Loading plans…</Centered>
        ) : error ? (
          <Centered tone="error">{error}</Centered>
        ) : rows.length === 0 ? (
          <Centered>No plans match your filters.</Centered>
        ) : (
          <>
            <PlansList
              rows={rows}
              expandedPlanId={expandedPlanId}
              onToggleExpand={(p) => setExpandedPlanId((c) => (c === p.plan_id ? null : p.plan_id))}
              onApprove={(p) => setConfirm({ kind: "approve", plan: p })}
              onCancel={(p) => setConfirm({ kind: "cancel", plan: p })}
              onOpen={(p) => router.push(`/modules/production/plan-list/${p.plan_id}`)}
            />
            <Pagination pg={pagination} onPage={(p) => setPage(p)} loading={loading} />
          </>
        )}
      </main>

      {confirm ? (
        <ConfirmDialog
          state={confirm}
          busy={busy}
          onApprove={doApprove}
          onCancel={doCancel}
          onDismiss={() => setConfirm(null)}
        />
      ) : null}

      <Footer />
    </div>
  );
}

// ── Confirm state ─────────────────────────────────────────────────────────

type ConfirmState =
  | { kind: "approve"; plan: PlanRow }
  | { kind: "cancel";  plan: PlanRow };

function ConfirmDialog({
  state, busy, onApprove, onCancel, onDismiss,
}: {
  state: ConfirmState;
  busy: boolean;
  onApprove: (planId: number) => void;
  onCancel:  (planId: number, reason: string) => void;
  onDismiss: () => void;
}) {
  const [reason, setReason] = useState("");
  const planLabel = state.plan.plan_name || `Plan #${state.plan.plan_id}`;
  return (
    <div
      className="fixed inset-0 z-30 bg-black/40 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onDismiss(); }}
    >
      <div className="w-full max-w-md bg-white border border-[var(--aws-border)] rounded-md shadow-[0_8px_24px_rgba(0,28,36,0.25)]">
        <div className="px-4 py-3 border-b border-[var(--aws-border)] flex items-center justify-between">
          <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">
            {state.kind === "approve" ? "Approve plan" : "Cancel plan"}
          </h3>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Close"
            className="w-7 h-7 inline-flex items-center justify-center rounded-sm text-[var(--text-muted)] hover:bg-[var(--surface-subtle)]"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="px-4 py-4">
          <p className="text-[13px] text-[var(--text-primary)] mb-1">
            <strong>{planLabel}</strong>
          </p>
          <p className="text-[12px] text-[var(--text-secondary)] mb-3">
            {state.plan.warehouse ? `${state.plan.warehouse} · ` : ""}
            {state.plan.line_count ?? 0} line{state.plan.line_count === 1 ? "" : "s"}
            {state.plan.total_planned_kg ? ` · ${fmtPlanKg(state.plan.total_planned_kg)} kg` : ""}
          </p>
          {state.kind === "approve" ? (
            <p className="text-[12px] text-[var(--text-secondary)]">
              Approving locks the plan and auto-generates per-floor job cards from the BOM process route.
              This cannot be reverted directly — to void an approved plan, cancel each generated job card.
            </p>
          ) : (
            <>
              <p className="text-[12px] text-[var(--text-secondary)] mb-2">
                Cancellation releases the reserved fulfillment quantity back to pending. Only valid while the plan is in <strong>draft</strong>.
              </p>
              <label className="block">
                <span className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">Reason</span>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  placeholder="Why is this plan being cancelled?"
                  className="w-full px-2 py-1.5 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] resize-none"
                />
              </label>
            </>
          )}
        </div>
        <div className="px-4 py-3 border-t border-[var(--aws-border)] flex justify-end gap-2">
          <button
            type="button"
            onClick={onDismiss}
            disabled={busy}
            className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] disabled:opacity-50"
          >
            Dismiss
          </button>
          {state.kind === "approve" ? (
            <button
              type="button"
              onClick={() => onApprove(state.plan.plan_id)}
              disabled={busy}
              className="h-8 px-4 text-[12px] rounded-[2px] font-semibold border bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white disabled:opacity-50"
            >
              {busy ? "Approving…" : "Approve"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onCancel(state.plan.plan_id, reason)}
              disabled={busy}
              className="h-8 px-4 text-[12px] rounded-[2px] font-semibold border border-[var(--aws-error)] bg-white text-[var(--aws-error)] hover:bg-[#fdf3f1] disabled:opacity-50"
            >
              {busy ? "Cancelling…" : "Cancel plan"}
            </button>
          )}
        </div>
      </div>
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
  rows, expandedPlanId, onToggleExpand, onApprove, onCancel, onOpen,
}: {
  rows: PlanRow[];
  expandedPlanId: number | null;
  onToggleExpand: (p: PlanRow) => void;
  onApprove: (p: PlanRow) => void;
  onCancel:  (p: PlanRow) => void;
  onOpen:    (p: PlanRow) => void;
}) {
  return (
    <>
      {/* Mobile (< md): stacked cards */}
      <div className="md:hidden space-y-2 mb-3">
        {rows.map((r) => (
          <PlanMobileCard
            key={r.plan_id}
            row={r}
            expanded={expandedPlanId === r.plan_id}
            onToggleExpand={() => onToggleExpand(r)}
            onApprove={() => onApprove(r)}
            onCancel={() => onCancel(r)}
            onOpen={() => onOpen(r)}
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
                <Th>Plan</Th>
                <Th>Type</Th>
                <Th>Date range</Th>
                <Th>Status</Th>
                <Th right>Lines</Th>
                <Th right>Volume</Th>
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
                  onToggleExpand={() => onToggleExpand(r)}
                  onApprove={() => onApprove(r)}
                  onCancel={() => onCancel(r)}
                  onOpen={() => onOpen(r)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
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

function PlanRowDesktop({
  row, expanded, onToggleExpand, onApprove, onCancel, onOpen,
}: {
  row: PlanRow;
  expanded: boolean;
  onToggleExpand: () => void;
  onApprove: () => void;
  onCancel: () => void;
  onOpen: () => void;
}) {
  const isDraft = (row.status ?? "").toLowerCase() === "draft";
  return (
    <>
    <tr
      className={[
        "border-b border-[var(--aws-border)] hover:bg-[var(--surface-subtle)] cursor-pointer",
        expanded ? "bg-[var(--surface-subtle)]" : "",
      ].join(" ")}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        onToggleExpand();
      }}
    >
      <td className="px-2 py-1.5 w-[24px] text-[var(--text-secondary)]">
        <button
          type="button"
          aria-label={expanded ? "Collapse plan" : "Expand plan"}
          onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
          className="inline-flex items-center justify-center w-5 h-5 rounded-sm hover:bg-white"
        >
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2} style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform .15s" }}>
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </td>
      <td className="px-2.5 py-1.5 min-w-[180px]">
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
      <td className="px-2.5 py-1.5 text-[var(--text-muted)] whitespace-nowrap text-[11px]">
        {fmtPlanDate(row.created_at)}
      </td>
      <td className="px-2.5 py-1.5 text-right">
        <RowActions
          isDraft={isDraft}
          onApprove={onApprove}
          onCancel={onCancel}
          onOpen={onOpen}
        />
      </td>
    </tr>
    {expanded ? (
      <tr className="border-b border-[var(--aws-border)] bg-[var(--surface-subtle)]">
        <td colSpan={9} className="px-3 py-3">
          <PlanInlinePreview planId={row.plan_id} onOpen={onOpen} />
        </td>
      </tr>
    ) : null}
    </>
  );
}

function PlanMobileCard({
  row, expanded, onToggleExpand, onApprove, onCancel, onOpen,
}: {
  row: PlanRow;
  expanded: boolean;
  onToggleExpand: () => void;
  onApprove: () => void;
  onCancel: () => void;
  onOpen: () => void;
}) {
  const isDraft = (row.status ?? "").toLowerCase() === "draft";
  return (
    <div
      className="bg-white border border-[var(--aws-border)] rounded-md overflow-hidden cursor-pointer hover:border-[var(--aws-navy)]"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        onToggleExpand();
      }}
    >
      <div className="px-2.5 py-2">
        <div className="flex items-center justify-between gap-2 mb-1">
          <div className="min-w-0 flex items-center gap-1.5 flex-wrap">
            <button
              type="button"
              aria-label={expanded ? "Collapse" : "Expand"}
              onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
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
        <div className="flex items-center gap-3 text-[11px] mb-2">
          <span><span className="text-[var(--text-muted)]">Lines</span> <strong>{row.line_count ?? 0}</strong></span>
          <span><span className="text-[var(--text-muted)]">Volume</span> <strong>{fmtPlanKg(row.total_planned_kg)} kg</strong></span>
        </div>
        <div className="flex items-center gap-2">
          <RowActions
            isDraft={isDraft}
            onApprove={onApprove}
            onCancel={onCancel}
            onOpen={onOpen}
          />
        </div>
      </div>
      {expanded ? (
        <div className="border-t border-[var(--aws-border)] px-2.5 py-3 bg-[var(--surface-subtle)]">
          <PlanInlinePreview planId={row.plan_id} onOpen={onOpen} />
        </div>
      ) : null}
    </div>
  );
}

function RowActions({
  isDraft, onApprove, onCancel, onOpen,
}: {
  isDraft: boolean;
  onApprove: () => void;
  onCancel: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="inline-flex items-center gap-1.5">
      {isDraft ? (
        <>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onApprove(); }}
            className="h-7 px-2.5 text-[11px] rounded-[2px] font-semibold border bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onCancel(); }}
            className="h-7 px-2.5 text-[11px] rounded-[2px] border border-[var(--aws-border)] bg-white text-[var(--aws-error)] hover:border-[var(--aws-error)]"
          >
            Cancel
          </button>
        </>
      ) : null}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onOpen(); }}
        title="Open approval workspace"
        className="h-7 px-2.5 text-[11px] rounded-[2px] border border-[var(--aws-border)] bg-white text-[var(--aws-link)] hover:border-[var(--aws-navy)] inline-flex items-center gap-1"
      >
        Open
        <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
      </button>
    </div>
  );
}

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
        if (!c.signal.aborted) setError(e instanceof Error ? e.message : "Failed to load plan");
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

function PreviewLinesList({ lines }: { lines: PlanLineRow[] }) {
  return (
    <>
      {/* Mobile (< sm): stacked rows */}
      <ul className="sm:hidden space-y-1.5">
        {lines.map((l) => (
          <li key={l.plan_line_id} className="border border-[var(--aws-border)] rounded bg-white px-2 py-1.5">
            <div className="text-[12px] font-semibold text-[var(--text-primary)] truncate" title={l.fg_sku_name ?? ""}>
              {l.fg_sku_name || "—"}
            </div>
            <div className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted)] truncate">
              {l.customer_name || "—"}
            </div>
            <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] mt-1">
              <span className="font-semibold">{fmtPlanKg(l.planned_qty_kg)} kg</span>
              {l.planned_qty_units != null ? <span className="text-[var(--text-muted)]">{l.planned_qty_units} pcs</span> : null}
              {l.area ? <span className="text-[var(--text-secondary)]">@ {l.area}</span> : null}
              {l.deadline_date ? <span className="text-[var(--text-muted)]">· {fmtPlanDate(l.deadline_date)}</span> : null}
              {l.steps && l.steps.length > 0 ? (
                <span className="text-[10px] font-semibold text-[var(--text-secondary)] bg-[var(--surface-subtle)] border border-[var(--aws-border)] rounded-sm px-1 py-0">
                  {l.steps.length} steps
                </span>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {/* sm+: table */}
      <div className="hidden sm:block bg-white border border-[var(--aws-border)] rounded overflow-hidden">
        <table className="w-full text-[11px] border-collapse">
          <thead className="bg-[var(--surface-subtle)] text-[var(--text-muted)]">
            <tr>
              <th className="px-2 py-1 text-left text-[10px] font-bold uppercase tracking-wide">FG SKU</th>
              <th className="px-2 py-1 text-left text-[10px] font-bold uppercase tracking-wide">Customer</th>
              <th className="px-2 py-1 text-right text-[10px] font-bold uppercase tracking-wide">Qty (kg)</th>
              <th className="px-2 py-1 text-right text-[10px] font-bold uppercase tracking-wide">Pcs</th>
              <th className="px-2 py-1 text-left text-[10px] font-bold uppercase tracking-wide">Floor / Area</th>
              <th className="px-2 py-1 text-left text-[10px] font-bold uppercase tracking-wide">Deadline</th>
              <th className="px-2 py-1 text-right text-[10px] font-bold uppercase tracking-wide">Steps</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const stepsWithFloor = (l.steps ?? []).filter((s) => !!s.floor).length;
              return (
                <tr key={l.plan_line_id} className="border-t border-[var(--aws-border)]">
                  <td className="px-2 py-1 max-w-[220px] truncate" title={l.fg_sku_name ?? ""}>{l.fg_sku_name || "—"}</td>
                  <td className="px-2 py-1 max-w-[180px] truncate" title={l.customer_name ?? ""}>{l.customer_name || "—"}</td>
                  <td className="px-2 py-1 text-right font-mono">{fmtPlanKg(l.planned_qty_kg)}</td>
                  <td className="px-2 py-1 text-right font-mono">{l.planned_qty_units ?? "—"}</td>
                  <td className="px-2 py-1 text-[var(--text-secondary)]">{l.area || "—"}</td>
                  <td className="px-2 py-1 text-[var(--text-secondary)] whitespace-nowrap">
                    {l.deadline_date ? fmtPlanDate(l.deadline_date) : "—"}
                  </td>
                  <td className="px-2 py-1 text-right font-mono">
                    {l.steps?.length ?? 0}
                    {stepsWithFloor > 0 ? <span className="text-[10px] text-[var(--text-muted)] ml-1">({stepsWithFloor} floored)</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
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

