"use client";

// "Plans created" — shown where the "Selected for plan" table was, once Create
// Plan succeeds. One row per new plan in the Plan List's columns (select, plan,
// factory, type, dates, status, lines, volume, units, created) with the Plan
// List's actions: Create / Edit Job Card, Open and Dispatch on each plan, and
// Merge process across the ticked plans. Expanding a plan lists its articles
// with their process route in the Plan List's process picker (process, floor,
// SFG; saved to the plan). Stock Take table look.

import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { friendlyApiError } from "@/lib/apiErrors";
import { pickPlanRow, planRowFromDetail, planTotals } from "@/lib/createdPlans";
import { GRID_HEAD_ROW, GRID_ROW, GRID_TABLE, GRID_TD, GRID_TH, GRID_WRAP } from "@/lib/gridTable";
import { DispatchModal, MergeActionBar, MergeProcessModal, RowActions } from "@/lib/planActions";
import { CreateJobCardModal, submitJobCardWizard } from "@/lib/planJobCardModal";
import { PlanLineProcesses, routeKey } from "@/lib/planLineProcesses";
import { planRowFlags } from "@/lib/planRowActions";
import {
  type PlanDetail,
  type PlanLineRow,
  type PlanRow,
  fmtDateRange, fmtPlanDate, fmtPlanKg, fmtPlanUnits, getPlan, listPlans,
} from "@/lib/plans";

const PLAN_PAGE = "/modules/production/plan-list";
const COLUMNS = 12;

// One new plan. Its Plan List row (lines_summary with each line's job cards and
// carded qty, plus the totals) drives the columns and the buttons; its detail
// (lines with their steps) feeds the expanded articles table. With neither, the
// row says why.
type Loaded = { id: number; row: PlanRow | null; detail: PlanDetail | null; error: string | null };

async function loadPlan(id: number, signal: AbortSignal): Promise<Loaded> {
  // The list endpoint has no plan-id filter; search=<id> matches the plan id
  // (among other text) and pickPlanRow keeps the exact one.
  const [listed, detailed] = await Promise.allSettled([
    listPlans({ search: String(id), page_size: 50 }, signal),
    getPlan(id, signal),
  ]);
  const detail = detailed.status === "fulfilled" ? detailed.value : null;
  const listRow = listed.status === "fulfilled" ? pickPlanRow(listed.value.results, id) : null;
  // No list row (say it's outside the search page) — the detail stands in.
  const row = listRow ?? (detail ? planRowFromDetail(detail) : null);
  if (row) return { id, row, detail, error: null };
  // Only reachable when the detail failed too.
  return { id, row: null, detail: null, error: friendlyApiError(detailed.status === "rejected" ? detailed.reason : null) };
}

// The list row's article summary in the detail's line shape, for the expanded
// table when only the list row loaded (no deadline or process route then).
function summaryLines(row: PlanRow): PlanLineRow[] {
  return (row.lines_summary ?? []).map((l) => ({
    plan_line_id: l.plan_line_id ?? undefined,
    fg_sku_name: l.fg_sku_name,
    customer_name: l.customer_name,
    planned_qty_kg: l.planned_qty_kg,
    planned_qty_units: l.planned_qty_units,
    area: l.area,
    job_card_count: l.job_card_count,
  }));
}

export function CreatedPlansPanel({ planIds, onDismiss }: {
  planIds: number[];
  onDismiss: () => void;
}) {
  if (planIds.length === 0) return null;
  // Keyed by the plan ids, so a new Create Plan starts the panel afresh: no
  // ticked plans, expanded rows, message or open dialog carried over.
  const key = planIds.join(",");
  return <PlansCreated key={key} planIds={planIds} onDismiss={onDismiss} />;
}

function PlansCreated({ planIds, onDismiss }: {
  planIds: number[];
  onDismiss: () => void;
}) {
  const router = useRouter();
  const [loaded, setLoaded] = useState<Loaded[] | null>(null);
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  // Plans ticked for Merge process — the Plan List's selection.
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [toast, setToast] = useState<string | null>(null);
  // Bumped after a job-card create / edit or a merge so the rows read their job
  // cards again (Create / Edit buttons, lines and totals follow).
  const [reloadKey, setReloadKey] = useState(0);
  const [jcPlan, setJcPlan] = useState<PlanRow | null>(null);
  const [jcIntent, setJcIntent] = useState<"create" | "edit">("create");
  const [dispatchPlan, setDispatchPlan] = useState<PlanRow | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const idsKey = planIds.join(",");

  // Read each new plan back; one that fails to load still gets a row saying so.
  // A reload keeps the current rows on screen until the fresh ones arrive.
  // Async-IIFE + AbortController — the codebase's fetch-in-effect shape.
  useEffect(() => {
    const ids = idsKey.split(",").map(Number);
    const ctrl = new AbortController();
    void (async () => {
      const next = await Promise.all(ids.map((id) => loadPlan(id, ctrl.signal)));
      if (!ctrl.signal.aborted) setLoaded(next);
    })();
    return () => ctrl.abort();
  }, [idsKey, reloadKey]);

  function reload() {
    setReloadKey((k) => k + 1);
  }

  function toggle(id: number) {
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  function toggleSelect(id: number) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  return (
    <section className="mb-3" aria-label="Plans created">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-sm bg-[#1d8102] text-white text-[10px] font-bold shrink-0">
            {planIds.length}
          </span>
          <span className="text-[11px] uppercase tracking-wide font-bold text-[var(--text-secondary)]">
            Plan{planIds.length === 1 ? "" : "s"} created
          </span>
          <span className="text-[11px] text-[var(--text-muted)] hidden md:inline truncate">
            · create job cards, merge processes or dispatch here, or open a plan to approve it
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link
            href={PLAN_PAGE}
            className="h-7 px-2.5 inline-flex items-center text-[11px] rounded-full border border-[var(--aws-border)] text-[var(--aws-link)] bg-white hover:border-[var(--aws-navy)]"
          >
            Plan List
          </Link>
          <button
            type="button"
            onClick={onDismiss}
            className="h-7 px-2.5 text-[11px] rounded-full border border-[var(--aws-border)] text-[var(--text-secondary)] bg-white hover:border-[var(--aws-navy)]"
          >
            Done
          </button>
        </div>
      </div>

      {selected.size >= 1 ? (
        <MergeActionBar
          count={selected.size}
          onClear={clearSelection}
          onMerge={() => setMergeOpen(true)}
        />
      ) : null}

      {toast ? (
        <div className="mb-3 px-3 py-2 rounded-sm border border-[var(--aws-border)] bg-[#f1faff] text-[12px] text-[var(--text-primary)] flex items-center justify-between gap-2">
          <span>{toast}</span>
          <button type="button" onClick={() => setToast(null)} className="text-[var(--aws-link)] hover:underline">
            Dismiss
          </button>
        </div>
      ) : null}

      <div className={GRID_WRAP}>
        <div className="overflow-x-auto">
          <table className={`${GRID_TABLE} min-w-[1200px]`}>
            <thead>
              <tr className={GRID_HEAD_ROW}>
                <th className={GRID_TH} aria-label="Select to merge" />
                <th className={GRID_TH} aria-label="Expand" />
                <th className={GRID_TH}>Plan</th>
                <th className={GRID_TH}>Factory</th>
                <th className={GRID_TH}>Type</th>
                <th className={GRID_TH}>Date range</th>
                <th className={GRID_TH}>Status</th>
                <th className={GRID_TH}>Lines</th>
                <th className={GRID_TH}>Volume (kg)</th>
                <th className={GRID_TH}>Units</th>
                <th className={GRID_TH}>Created</th>
                <th className={GRID_TH}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loaded == null ? (
                <tr>
                  <td colSpan={COLUMNS} className={`${GRID_TD} py-6 text-[var(--text-secondary)]`}>
                    Loading the new plan{planIds.length === 1 ? "" : "s"}…
                  </td>
                </tr>
              ) : loaded.map(({ id, row, detail, error }) => {
                if (!row) {
                  return (
                    <tr key={id}>
                      <td className={GRID_TD} />
                      <td className={GRID_TD} />
                      <td className={`${GRID_TD} font-medium`}>Plan #{id}</td>
                      <td colSpan={COLUMNS - 4} className={`${GRID_TD} text-[var(--aws-error)] text-[12px]`}>
                        Created, but couldn&apos;t load its details: {error}
                      </td>
                      <td className={GRID_TD}><OpenLink id={id} /></td>
                    </tr>
                  );
                }
                const isOpen = open.has(id);
                // The expanded articles: the detail's lines (with their process
                // route), else the list row's article summary.
                const lines = detail?.lines ?? summaryLines(row);
                // The list row's totals; a row built from the detail has none,
                // so they're added up from its lines.
                const totals = planTotals({ ...row, lines });
                const { anyCarded, anyRemaining } = planRowFlags(row);
                // A draft plan's routes can be changed here; that needs its
                // saved steps, so only once its detail has loaded.
                const editable = detail != null && (row.status || "draft").toLowerCase() === "draft";
                return (
                  <Fragment key={id}>
                    <tr
                      className={`${GRID_ROW} cursor-pointer`}
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest("button, input, a")) return;
                        toggle(id);
                      }}
                    >
                      <td className={GRID_TD} onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selected.has(id)}
                          onChange={() => toggleSelect(id)}
                          aria-label={`Select ${row.plan_name || `Plan #${row.plan_id}`} to merge`}
                          className="accent-[var(--aws-orange)] cursor-pointer align-middle"
                        />
                      </td>
                      <td className={GRID_TD}>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); toggle(id); }}
                          aria-expanded={isOpen}
                          aria-label={isOpen ? `Hide the articles of plan ${id}` : `Show the articles of plan ${id}`}
                          className="inline-flex items-center justify-center w-5 h-5 text-[var(--text-secondary)] rounded-sm hover:bg-white"
                        >
                          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2}
                            style={{ transform: isOpen ? "rotate(90deg)" : "none", transition: "transform .15s" }}>
                            <polyline points="9 18 15 12 9 6" />
                          </svg>
                        </button>
                      </td>
                      <td className={`${GRID_TD} font-medium text-[var(--text-primary)]`}>
                        {row.plan_name || `Plan #${id}`}
                      </td>
                      <td className={`${GRID_TD} whitespace-nowrap text-[var(--text-secondary)]`}>{row.warehouse || "—"}</td>
                      <td className={GRID_TD}><TypeBadge type={row.plan_type} /></td>
                      <td className={`${GRID_TD} whitespace-nowrap text-[var(--text-secondary)]`}>
                        {fmtDateRange(row.date_from, row.date_to)}
                      </td>
                      <td className={GRID_TD}><StatusBadge status={row.status} /></td>
                      <td className={`${GRID_TD} tabular-nums`}>{row.line_count ?? lines.length}</td>
                      <td className={`${GRID_TD} tabular-nums font-semibold`}>{fmtPlanKg(totals.kg)}</td>
                      <td className={`${GRID_TD} tabular-nums text-[var(--text-secondary)]`}>
                        {totals.units > 0 ? fmtPlanUnits(totals.units) : "—"}
                      </td>
                      <td className={`${GRID_TD} whitespace-nowrap text-[12px] text-[var(--text-secondary)]`}>
                        {row.created_by ? <span className="block font-medium">{row.created_by}</span> : null}
                        {fmtPlanDate(row.created_at)}
                      </td>
                      <td className={`${GRID_TD} whitespace-nowrap`} onClick={(e) => e.stopPropagation()}>
                        <RowActions
                          anyCarded={anyCarded}
                          anyRemaining={anyRemaining}
                          onOpen={() => router.push(`${PLAN_PAGE}/${id}`)}
                          onCreateJobCard={(intent) => { setJcIntent(intent); setJcPlan(row); }}
                          onDispatch={() => setDispatchPlan(row)}
                        />
                      </td>
                    </tr>
                    {isOpen ? (
                      <tr>
                        <td colSpan={COLUMNS} className={`${GRID_TD} bg-[#fafafa] p-3`}>
                          {lines.length === 0 ? (
                            <p className="text-[12px] text-[var(--text-muted)] italic">No articles on this plan.</p>
                          ) : (
                            <div className={GRID_WRAP}>
                              <div className="overflow-x-auto">
                                <table className={GRID_TABLE}>
                                  <thead>
                                    <tr className={GRID_HEAD_ROW}>
                                      <th className={GRID_TH}>Article</th>
                                      <th className={GRID_TH}>Customer</th>
                                      <th className={GRID_TH}>Qty (kg)</th>
                                      <th className={GRID_TH}>Pcs</th>
                                      <th className={GRID_TH}>Deadline</th>
                                      <th className={GRID_TH}>Processes</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {lines.map((l, i) => (
                                      <tr key={l.plan_line_id ?? i} className={GRID_ROW}>
                                        <td className={`${GRID_TD} text-[var(--text-primary)]`}>{l.fg_sku_name || "—"}</td>
                                        <td className={`${GRID_TD} text-[var(--text-secondary)]`}>{l.customer_name || "—"}</td>
                                        <td className={`${GRID_TD} tabular-nums`}>{fmtPlanKg(l.planned_qty_kg)}</td>
                                        <td className={`${GRID_TD} tabular-nums text-[var(--text-secondary)]`}>
                                          {l.planned_qty_units != null ? fmtPlanUnits(l.planned_qty_units) : "—"}
                                        </td>
                                        <td className={`${GRID_TD} whitespace-nowrap`}>{fmtPlanDate(l.deadline_date)}</td>
                                        <td className={`${GRID_TD} text-[12px] text-left align-top min-w-[440px]`}>
                                          <PlanLineProcesses
                                            key={routeKey(l, i)}
                                            line={l}
                                            warehouse={row.warehouse}
                                            entity={row.entity}
                                            editable={editable}
                                            onSaved={(m) => { setToast(m); reload(); }}
                                            onMessage={setToast}
                                          />
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {jcPlan ? (
        <CreateJobCardModal
          plan={jcPlan}
          intent={jcIntent}
          onClose={() => setJcPlan(null)}
          onContinue={async (p) => {
            // As on the Plan List: "Pick an article first." returns before the
            // last message is cleared.
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
          planIds={[...selected]}
          onClose={() => setMergeOpen(false)}
          onDone={(msg) => {
            setToast(msg);
            setMergeOpen(false);
            clearSelection();
            reload();
          }}
        />
      ) : null}
    </section>
  );
}

// The Plan List's "Open" for a plan whose details couldn't be loaded.
function OpenLink({ id }: { id: number }) {
  return (
    <Link
      href={`${PLAN_PAGE}/${id}`}
      title="Open approval workspace"
      className="h-7 px-2.5 text-[11px] rounded-[2px] border border-[var(--aws-border)] bg-white text-[var(--aws-link)] hover:border-[var(--aws-navy)] inline-flex items-center gap-1"
    >
      Open
      <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
        <line x1="5" y1="12" x2="19" y2="12" />
        <polyline points="12 5 19 12 12 19" />
      </svg>
    </Link>
  );
}

// Status and type badges — the same look as the Plan List's.
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
