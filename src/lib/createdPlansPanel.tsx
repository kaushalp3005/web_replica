"use client";

// "Plans created" — shown where the "Selected for plan" table was, once Create
// Plan succeeds. One row per new plan in the Plan List's columns (plan, factory,
// type, dates, status, lines, volume, units, created, open); expanding a plan
// lists its articles with their process route. Stock Take table look.

import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import { friendlyApiError } from "@/lib/apiErrors";
import { floorsLabel, planTotals, stepsText } from "@/lib/createdPlans";
import { GRID_HEAD_ROW, GRID_ROW, GRID_TABLE, GRID_TD, GRID_TH, GRID_WRAP } from "@/lib/gridTable";
import {
  type PlanDetail,
  fmtDateRange, fmtPlanDate, fmtPlanKg, fmtPlanUnits, getPlan,
} from "@/lib/plans";

const PLAN_PAGE = "/modules/production/plan-list";
const COLUMNS = 11;

type Loaded = { id: number; plan: PlanDetail | null; error: string | null };

export function CreatedPlansPanel({ planIds, onDismiss }: {
  planIds: number[];
  onDismiss: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded[] | null>(null);
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const key = planIds.join(",");

  // Read each new plan back; one that fails to load still gets a row saying so.
  // Async-IIFE + AbortController — the codebase's fetch-in-effect shape.
  useEffect(() => {
    if (!key) return;
    const ids = key.split(",").map(Number);
    const ctrl = new AbortController();
    void (async () => {
      setLoaded(null);
      const settled = await Promise.allSettled(ids.map((id) => getPlan(id, ctrl.signal)));
      if (ctrl.signal.aborted) return;
      setLoaded(settled.map((r, i) => (r.status === "fulfilled"
        ? { id: ids[i], plan: r.value, error: null }
        : { id: ids[i], plan: null, error: friendlyApiError(r.reason) })));
    })();
    return () => ctrl.abort();
  }, [key]);

  if (planIds.length === 0) return null;

  function toggle(id: number) {
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
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
            · open a plan to approve it or create its job cards
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

      <div className={GRID_WRAP}>
        <div className="overflow-x-auto">
          <table className={`${GRID_TABLE} min-w-[980px]`}>
            <thead>
              <tr className={GRID_HEAD_ROW}>
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
                <th className={GRID_TH} aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {loaded == null ? (
                <tr>
                  <td colSpan={COLUMNS} className={`${GRID_TD} py-6 text-[var(--text-secondary)]`}>
                    Loading the new plan{planIds.length === 1 ? "" : "s"}…
                  </td>
                </tr>
              ) : loaded.map(({ id, plan, error }) => {
                if (!plan) {
                  return (
                    <tr key={id}>
                      <td className={GRID_TD} />
                      <td className={`${GRID_TD} font-medium`}>Plan #{id}</td>
                      <td colSpan={COLUMNS - 3} className={`${GRID_TD} text-[var(--aws-error)] text-[12px]`}>
                        Created, but couldn&apos;t load its details: {error}
                      </td>
                      <td className={GRID_TD}><OpenLink id={id} /></td>
                    </tr>
                  );
                }
                const isOpen = open.has(id);
                const lines = plan.lines ?? [];
                // The plan detail carries no totals — add them up from its lines.
                const totals = planTotals(plan);
                return (
                  <Fragment key={id}>
                    <tr className={`${GRID_ROW} cursor-pointer`} onClick={() => toggle(id)}>
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
                        {plan.plan_name || `Plan #${id}`}
                      </td>
                      <td className={`${GRID_TD} whitespace-nowrap text-[var(--text-secondary)]`}>{plan.warehouse || "—"}</td>
                      <td className={GRID_TD}><TypeBadge type={plan.plan_type} /></td>
                      <td className={`${GRID_TD} whitespace-nowrap text-[var(--text-secondary)]`}>
                        {fmtDateRange(plan.date_from, plan.date_to)}
                      </td>
                      <td className={GRID_TD}><StatusBadge status={plan.status} /></td>
                      <td className={`${GRID_TD} tabular-nums`}>{plan.line_count ?? lines.length}</td>
                      <td className={`${GRID_TD} tabular-nums font-semibold`}>{fmtPlanKg(totals.kg)}</td>
                      <td className={`${GRID_TD} tabular-nums text-[var(--text-secondary)]`}>
                        {totals.units > 0 ? fmtPlanUnits(totals.units) : "—"}
                      </td>
                      <td className={`${GRID_TD} whitespace-nowrap text-[12px] text-[var(--text-secondary)]`}>
                        {plan.created_by ? <span className="block font-medium">{plan.created_by}</span> : null}
                        {fmtPlanDate(plan.created_at)}
                      </td>
                      <td className={GRID_TD} onClick={(e) => e.stopPropagation()}><OpenLink id={id} /></td>
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
                                        <td className={`${GRID_TD} text-[12px]`}>
                                          <span className="text-[var(--text-primary)]">{stepsText(l.steps)}</span>
                                          {floorsLabel(l.steps) ? (
                                            <span className="block text-[11px] text-[var(--text-muted)]">{floorsLabel(l.steps)}</span>
                                          ) : null}
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
    </section>
  );
}

function OpenLink({ id }: { id: number }) {
  return (
    <Link
      href={`${PLAN_PAGE}/${id}`}
      title={`Open plan ${id}`}
      className="h-7 px-2.5 inline-flex items-center gap-1 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[12px] text-[var(--aws-orange)] hover:border-[var(--aws-orange)] whitespace-nowrap"
    >
      Open →
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
