"use client";

// A plan's action buttons and the dialogs behind them, shared by the Plan List
// page and the SO Creation "Plans created" panel: the per-plan RowActions
// (Create / Edit Job Card, Open, Dispatch), the cross-plan "Merge process" bar
// + wizard, and the Dispatch dialog. The Create / Edit Job Card wizard lives in
// planJobCardModal.tsx.

import { useEffect, useState } from "react";
import { friendlyApiError } from "@/lib/apiErrors";
import {
  type PlanRow,
  validateProcessMerge,
  createMergedProcessRun,
  type ProcessMergeGroup,
  type ProcessMergeValidation,
  fetchLineDispatchInfo,
  createLineDispatch,
  type LineDispatchInfo,
  type DispatchBatch,
  fmtPlanKg,
  fmtPlanUnits,
} from "@/lib/plans";

export function RowActions({
  anyCarded, anyRemaining, onOpen, onCreateJobCard, onDispatch,
}: {
  anyCarded: boolean;
  anyRemaining: boolean;
  onOpen: () => void;
  onCreateJobCard: (intent: "create" | "edit") => void;
  onDispatch: () => void;
}) {
  return (
    <div className="inline-flex items-center gap-1.5">
      {/* Create / Edit Job Card — the per-article flow. A plan with balance left
          shows Create (start a fresh / additional partial chain); a plan with
          any carded line shows Edit. A partially-carded plan shows BOTH, so the
          operator can card the next portion or edit what exists. */}
      {anyRemaining ? (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onCreateJobCard("create"); }}
          title="Create a job card from one of this plan's articles (fresh, or an additional partial chain for the remaining balance)"
          className="h-7 px-2.5 text-[11px] rounded-[2px] font-semibold border bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white inline-flex items-center gap-1"
        >
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Create Job Card
        </button>
      ) : null}
      {anyCarded ? (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onCreateJobCard("edit"); }}
          title="Edit this plan's existing job cards"
          className={[
            "h-7 px-2.5 text-[11px] rounded-[2px] font-semibold border inline-flex items-center gap-1",
            // When Create is also shown, Edit becomes the secondary (outline)
            // button so the primary Create action stays visually dominant.
            anyRemaining
              ? "bg-white border-[var(--aws-border)] text-[var(--aws-link)] hover:border-[var(--aws-navy)]"
              : "bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white",
          ].join(" ")}
        >
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
          Edit Job Card
        </button>
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
      {/* Dispatch to — only meaningful once an article's packaging stage is
          done; the modal/server confirm readiness per batch. */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDispatch(); }}
        title="Dispatch a completed packaging batch (notify billing / operations / stores)"
        className="h-7 px-2.5 text-[11px] rounded-[2px] border border-[var(--aws-border)] bg-white text-[#1d8102] hover:border-[#1d8102] inline-flex items-center gap-1"
      >
        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <rect x="1" y="3" width="15" height="13" /><polygon points="16 8 20 8 23 11 23 16 16 16 16 8" /><circle cx="5.5" cy="18.5" r="2.5" /><circle cx="18.5" cy="18.5" r="2.5" />
        </svg>
        Dispatch
      </button>
    </div>
  );
}

// ── Cross-product process merge ─────────────────────────────────────────
//
// Select several plans that share factory + floor + raw-material articles, then
// merge them into ONE shared process job card (summed qty) whose output feeds
// each product's own packaging card. Backed by validateProcessMerge (eligibility
// grouping, server-authoritative) + createMergedProcessRun.

export function MergeActionBar({ count, onClear, onMerge }: {
  count: number; onClear: () => void; onMerge: () => void;
}) {
  const ready = count >= 2;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 px-3 py-2 rounded-md border border-[var(--aws-orange-active)] bg-[#fff8f0]">
      <span className="text-[12px] font-semibold text-[var(--text-primary)]">
        {count} plan{count === 1 ? "" : "s"} selected
      </span>
      <span className="text-[11px] text-[var(--text-muted)]">
        {ready
          ? "Merge products that share factory + floor + raw materials into one process run."
          : "Select at least 2 plans to merge their process."}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <button type="button" onClick={onClear}
          className="h-7 px-2.5 text-[11px] rounded-[2px] border border-[var(--aws-border)] bg-white text-[var(--aws-link)] hover:border-[var(--aws-navy)]">
          Clear
        </button>
        <button type="button" onClick={onMerge} disabled={!ready}
          className="h-7 px-3 text-[11px] rounded-[2px] font-semibold border inline-flex items-center gap-1 bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white disabled:opacity-50 disabled:cursor-not-allowed">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 3v6a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3" /><line x1="12" y1="15" x2="12" y2="21" />
          </svg>
          Merge process
        </button>
      </div>
    </div>
  );
}

type MergeMemberDraft = {
  plan_line_id: number;
  fg_sku_name: string | null;
  planned_qty_kg: number | null;
  qty_kg: string;
  pkg_floor: string;
  pkg_process: string;
};

const MERGE_INP =
  "h-8 px-2 text-[12px] rounded-[2px] bg-white border border-[var(--aws-border)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]";

export function MergeProcessModal({ planIds, onClose, onDone }: {
  planIds: number[];
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [val, setVal] = useState<ProcessMergeValidation | null>(null);
  const [loadingVal, setLoadingVal] = useState(true);
  const [valErr, setValErr] = useState<string | null>(null);
  const [chosenIdx, setChosenIdx] = useState<number>(-1);
  const [procSteps, setProcSteps] = useState<{ process: string; floor: string }[]>([]);
  const [sharedSfg, setSharedSfg] = useState("");
  const [members, setMembers] = useState<MergeMemberDraft[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Selection is frozen while the modal is open, so validate once on mount.
  // (loadingVal starts true; we only flip it in the async callbacks, keeping
  // the effect body free of synchronous setState.)
  const idsKey = planIds.join(",");
  useEffect(() => {
    let alive = true;
    validateProcessMerge(planIds)
      .then((v) => {
        if (!alive) return;
        setVal(v);
        if (v.groups.length === 1) chooseGroup(0, v);
      })
      .catch((e) => { if (alive) setValErr(friendlyApiError(e)); })
      .finally(() => { if (alive) setLoadingVal(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  const group: ProcessMergeGroup | null =
    val && chosenIdx >= 0 ? val.groups[chosenIdx] ?? null : null;

  // Seed the shared-process + per-member drafts from the chosen group's key.
  function chooseGroup(idx: number, v?: ProcessMergeValidation) {
    const source = v ?? val;
    const g = source?.groups[idx];
    setChosenIdx(idx);
    if (!g) return;
    // Pre-fill the shared process from the products' actual planned steps
    // (drop packaging — that stays per-product). Seed from the first member;
    // they share RM + floor so their process is the same. Fall back to blank.
    const first = g.members[0]?.steps ?? [];
    const wip = first.filter((s) => (s.stage || "").toLowerCase() !== "packaging");
    const seed = wip.length ? wip : first.slice(0, Math.max(0, first.length - 1));
    setProcSteps(seed.length
      ? seed.map((s) => ({ process: s.process_name || "", floor: s.floor || g.key.floor }))
      : [{ process: "", floor: g.key.floor }]);
    const slug = (g.key.rm_articles[0] || "wip").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
    setSharedSfg(`SFG-${slug}`);
    setMembers(g.members.map((m) => ({
      plan_line_id: m.plan_line_id,
      fg_sku_name: m.fg_sku_name,
      planned_qty_kg: m.planned_qty_kg,
      qty_kg: m.planned_qty_kg != null ? String(m.planned_qty_kg) : "",
      pkg_floor: g.key.floor,
      pkg_process: "Packaging",
    })));
  }

  const mergedQty = members.reduce((s, m) => s + (Number(m.qty_kg) || 0), 0);
  const procOk = procSteps.length >= 1 && procSteps.every((s) => s.process.trim() && s.floor.trim());
  const membersOk = members.length >= 2 && members.every((m) => m.pkg_floor.trim() && Number(m.qty_kg) > 0);

  async function submit() {
    if (!group) return;
    setSubmitting(true);
    setErr(null);
    try {
      const res = await createMergedProcessRun({
        plan_line_ids: members.map((m) => m.plan_line_id),
        wip_steps: procSteps.map((s, i) => ({
          process: s.process.trim(),
          floor: s.floor.trim(),
          // Only the LAST shared step produces the group SFG the packaging consumes.
          sfg_output: i === procSteps.length - 1 ? (sharedSfg.trim() || null) : null,
        })),
        per_member: members.map((m) => ({
          plan_line_id: m.plan_line_id,
          pkg_floor: m.pkg_floor.trim(),
          pkg_process: m.pkg_process.trim() || "Packaging",
          qty_kg: Number(m.qty_kg),
          qty_units: null,
        })),
      });
      onDone(`Merged ${res.packaging.length} products into one process run · ${res.merged_qty_kg} kg · ${res.count} job cards.`);
    } catch (e) {
      setErr(friendlyApiError(e));
    } finally {
      setSubmitting(false);
    }
  }

  const btnPrimary = "h-8 px-3 text-[12px] rounded-[2px] font-semibold border bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white disabled:opacity-50 disabled:cursor-not-allowed";
  const btnGhost = "h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border)] bg-white text-[var(--aws-link)] hover:border-[var(--aws-navy)]";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-[720px] max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-[var(--aws-border)] flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">Merge process</h2>
            <p className="text-[11px] text-[var(--text-muted)]">One shared process card (merged qty) → each product keeps its own packaging.</p>
          </div>
          <div className="flex items-center gap-1 text-[11px] shrink-0">
            {[1, 2, 3].map((n) => (
              <span key={n} className={[
                "w-6 h-6 inline-flex items-center justify-center rounded-full font-semibold",
                step === n ? "bg-[var(--aws-orange)] text-white"
                  : step > n ? "bg-[#e6f4ea] text-[#1d8102]" : "bg-[var(--surface-subtle)] text-[var(--text-muted)]",
              ].join(" ")}>{n}</span>
            ))}
          </div>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex-1 text-[12px]">
          {/* STEP 1 — eligibility review */}
          {step === 1 ? (
            loadingVal ? (
              <p className="text-[var(--text-muted)]">Checking which products can merge…</p>
            ) : valErr ? (
              <p className="text-[var(--aws-error)]">{valErr}</p>
            ) : (
              <div className="space-y-3">
                {(val?.groups.length ?? 0) === 0 ? (
                  <p className="text-[var(--text-secondary)]">No products in your selection share a factory + floor + raw-material set, so nothing can be merged.</p>
                ) : (
                  <>
                    <p className="text-[11px] text-[var(--text-muted)]">Pick a group of products to run as one shared process:</p>
                    {val!.groups.map((g, idx) => (
                      <label key={idx} className={[
                        "block rounded-md border p-3 cursor-pointer",
                        chosenIdx === idx ? "border-[var(--aws-orange-active)] bg-[#fff8f0]" : "border-[var(--aws-border)] hover:border-[var(--aws-navy)]",
                      ].join(" ")}>
                        <div className="flex items-start gap-2">
                          <input type="radio" name="merge-group" checked={chosenIdx === idx} onChange={() => chooseGroup(idx)} className="mt-0.5 accent-[var(--aws-orange)]" />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                              <span className="font-semibold text-[var(--text-primary)] uppercase">{g.key.factory}</span>
                              <span className="text-[var(--text-muted)]">· {g.key.entity}</span>
                              <span className="text-[var(--text-muted)]">· floor {g.key.floor}</span>
                              {g.key.rm_articles.map((a) => (
                                <span key={a} className="px-1.5 py-0.5 rounded-full bg-[#eef2ff] text-[#4338ca] text-[10px]">{a}</span>
                              ))}
                            </div>
                            <ul className="mt-1.5 space-y-1">
                              {g.members.map((m) => (
                                <li key={m.plan_line_id} className="text-[11px]">
                                  <div className="flex items-baseline justify-between gap-2">
                                    <span className="truncate text-[var(--text-primary)] flex items-center gap-1">
                                      {m.fg_sku_name || "—"}
                                      {m.carded ? (
                                        <span className="px-1 py-0 rounded-sm text-[9px] uppercase font-bold tracking-wide bg-[#fff4e5] text-[#b45309] border border-[#fde68a]" title="Already has un-started job cards — the merge will rebuild them">rebuild</span>
                                      ) : null}
                                    </span>
                                    <span className="font-mono text-[var(--text-muted)] shrink-0">{m.planned_qty_kg ?? 0} kg</span>
                                  </div>
                                  {m.steps && m.steps.length ? (
                                    <div className="flex flex-wrap items-center gap-1 mt-0.5">
                                      {m.steps.map((s, si) => (
                                        <span key={si} className="inline-flex items-center gap-1">
                                          {si > 0 ? <span className="text-[var(--text-muted)]">→</span> : null}
                                          <span className={[
                                            "px-1.5 py-0.5 rounded-full text-[10px]",
                                            (s.stage || "").toLowerCase() === "packaging"
                                              ? "bg-[#f5f3ff] text-[#6d28d9]"
                                              : "bg-[var(--surface-subtle)] text-[var(--text-secondary)]",
                                          ].join(" ")} title={s.floor || ""}>{s.process_name || "—"}</span>
                                        </span>
                                      ))}
                                    </div>
                                  ) : (
                                    <div className="mt-0.5 text-[10px] text-[var(--text-muted)] italic">no process steps planned</div>
                                  )}
                                </li>
                              ))}
                            </ul>
                            <div className="mt-1 text-[10px] text-[var(--text-muted)]">{g.members.length} products · {g.total_qty_kg} kg combined</div>
                          </div>
                        </div>
                      </label>
                    ))}
                  </>
                )}
                {val && val.ineligible.length > 0 ? (
                  <div className="mt-2 rounded-md border border-[var(--aws-border)] bg-[var(--surface-subtle)] p-3">
                    <div className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted)] mb-1">Cannot merge ({val.ineligible.length})</div>
                    <ul className="space-y-0.5">
                      {val.ineligible.map((m) => (
                        <li key={m.plan_line_id} className="flex items-baseline justify-between gap-2 text-[11px] text-[var(--text-secondary)]">
                          <span className="truncate">{m.fg_sku_name || `Line ${m.plan_line_id}`}</span>
                          <span className="shrink-0 text-[var(--text-muted)] italic">{m.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            )
          ) : null}

          {/* STEP 2 — shared process config */}
          {step === 2 && group ? (
            <div className="space-y-4">
              <div className="text-[11px] text-[var(--text-muted)]">
                Shared process for <strong className="text-[var(--text-primary)]">{group.members.length}</strong> products on floor <strong className="text-[var(--text-primary)]">{group.key.floor}</strong> · combined <strong className="text-[var(--text-primary)]">{mergedQty} kg</strong>.
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-secondary)] mb-1">Process steps · last step produces the shared SFG</div>
                <div className="space-y-2">
                  {procSteps.map((s, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input value={s.process} placeholder="Process (e.g. Roasting)" className={`flex-1 ${MERGE_INP}`}
                        onChange={(e) => setProcSteps((ps) => ps.map((x, j) => j === i ? { ...x, process: e.target.value } : x))} />
                      <input value={s.floor} placeholder="Floor" className={`flex-1 ${MERGE_INP}`}
                        onChange={(e) => setProcSteps((ps) => ps.map((x, j) => j === i ? { ...x, floor: e.target.value } : x))} />
                      {procSteps.length > 1 ? (
                        <button type="button" aria-label="Remove step" className="w-7 h-7 rounded-sm border border-[var(--aws-border)] text-[var(--text-muted)] hover:text-[var(--aws-error)]"
                          onClick={() => setProcSteps((ps) => ps.filter((_, j) => j !== i))}>×</button>
                      ) : null}
                    </div>
                  ))}
                </div>
                <button type="button" className="mt-2 text-[11px] text-[var(--aws-link)] hover:underline"
                  onClick={() => setProcSteps((ps) => [...ps, { process: "", floor: group.key.floor }])}>+ Add process step</button>
              </div>
              <label className="block">
                <span className="block text-[10px] uppercase tracking-wide font-semibold text-[var(--text-secondary)] mb-1">Shared SFG code (roasted/processed intermediate)</span>
                <input value={sharedSfg} onChange={(e) => setSharedSfg(e.target.value)} placeholder="e.g. SFG-CHIA" className={`w-full ${MERGE_INP}`} />
                <span className="block text-[10px] text-[var(--text-muted)] mt-0.5">Each packaging stage consumes this code from the shared process output.</span>
              </label>
            </div>
          ) : null}

          {/* STEP 3 — per-product packaging review */}
          {step === 3 && group ? (
            <div className="space-y-3">
              <div className="text-[11px] text-[var(--text-muted)]">Each product keeps its own packaging card. Confirm qty + packaging floor per product.</div>
              <div className="grid grid-cols-[1fr_84px_1fr_1fr] gap-2 text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted)] px-1">
                <span>Product</span><span className="text-right">Qty (kg)</span><span>Pkg floor</span><span>Pkg process</span>
              </div>
              {members.map((m, i) => (
                <div key={m.plan_line_id} className="grid grid-cols-[1fr_84px_1fr_1fr] gap-2 items-center">
                  <span className="truncate text-[var(--text-primary)]" title={m.fg_sku_name || ""}>{m.fg_sku_name || "—"}</span>
                  <input value={m.qty_kg} inputMode="decimal" className={`text-right ${MERGE_INP}`}
                    onChange={(e) => setMembers((ms) => ms.map((x, j) => j === i ? { ...x, qty_kg: e.target.value } : x))} />
                  <input value={m.pkg_floor} className={MERGE_INP}
                    onChange={(e) => setMembers((ms) => ms.map((x, j) => j === i ? { ...x, pkg_floor: e.target.value } : x))} />
                  <input value={m.pkg_process} className={MERGE_INP}
                    onChange={(e) => setMembers((ms) => ms.map((x, j) => j === i ? { ...x, pkg_process: e.target.value } : x))} />
                </div>
              ))}
              <div className="text-right text-[11px] font-semibold text-[var(--text-primary)]">Merged process qty: {mergedQty} kg</div>
            </div>
          ) : null}

          {err ? <p className="mt-3 text-[11px] text-[var(--aws-error)]">{err}</p> : null}
        </div>

        <div className="px-5 py-3 border-t border-[var(--aws-border)] flex items-center justify-between gap-2">
          <button type="button" onClick={onClose} className={btnGhost}>Cancel</button>
          <div className="flex items-center gap-2">
            {step > 1 ? (
              <button type="button" className={btnGhost} onClick={() => setStep((s) => (s - 1) as 1 | 2 | 3)}>Back</button>
            ) : null}
            {step < 3 ? (
              <button type="button" className={btnPrimary}
                disabled={step === 1 ? !group : !procOk}
                onClick={() => setStep((s) => (s + 1) as 1 | 2 | 3)}>Next</button>
            ) : (
              <button type="button" className={btnPrimary} disabled={!membersOk || submitting} onClick={submit}>
                {submitting ? "Merging…" : "Create merged run"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Dispatch modal ─────────────────────────────────────────────────────────
//
// Opened by the per-plan "Dispatch" button. Per article: pick an article, pick a
// PACKAGING batch (the batch selector is sourced from the packaging/Final-FG job
// card only — never another WIP process), enter no. of boxes + customer location
// + optional transport, then Send. The server emails To billing/candor_operations
// /store_head, CC business_head/operations_head/inventory_manager/production_manager
// with the job-card body and records it. Boxes + customer location + transport are
// operator-entered (no stored source).

export function DispatchModal({
  plan, onClose, onToast,
}: {
  plan: PlanRow;
  onClose: () => void;
  onToast: (msg: string | null) => void;
}) {
  const lines = plan.lines_summary ?? [];
  const [selectedLineId, setSelectedLineId] = useState<number | null>(
    lines.length === 1 ? (lines[0].plan_line_id ?? null) : null,
  );
  const [info, setInfo] = useState<LineDispatchInfo | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(false);
  const [infoErr, setInfoErr] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<number | null>(null);
  const [numBoxes, setNumBoxes] = useState("");
  const [customerLocation, setCustomerLocation] = useState("");
  const [vehicleNumber, setVehicleNumber] = useState("");
  const [transporter, setTransporter] = useState("");
  const [transportLocation, setTransportLocation] = useState("");
  const [sending, setSending] = useState(false);

  // Default a batch selection to the packaging stage's batches — prefer the
  // latest CLOSED batch (produced FG ready to dispatch), else the last batch.
  function defaultBatch(batches: DispatchBatch[]): number | null {
    if (!batches.length) return null;
    const closed = batches.filter((b) => (b.status || "").toLowerCase() === "closed");
    const pick = (closed.length ? closed : batches)[(closed.length ? closed : batches).length - 1];
    return pick.batch_id ?? null;
  }

  // Load the packaging job-card + batches whenever the chosen article changes.
  useEffect(() => {
    const c = new AbortController();
    void (async () => {
      if (selectedLineId == null) {
        setInfo(null); setInfoErr(null); setLoadingInfo(false); setBatchId(null);
        return;
      }
      setLoadingInfo(true); setInfoErr(null);
      try {
        const d = await fetchLineDispatchInfo(selectedLineId);
        if (c.signal.aborted) return;
        setInfo(d);
        setBatchId(d.exists ? defaultBatch(d.batches ?? []) : null);
        setCustomerLocation("");
      } catch (e) {
        if (!c.signal.aborted) { setInfo(null); setInfoErr(friendlyApiError(e)); }
      } finally {
        if (!c.signal.aborted) setLoadingInfo(false);
      }
    })();
    return () => c.abort();
  }, [selectedLineId]);

  const batch = (info?.batches ?? []).find((b) => b.batch_id === batchId) ?? null;
  const canSend = selectedLineId != null && info?.exists === true && batchId != null && !sending;

  async function send() {
    if (selectedLineId == null || batchId == null) return;
    setSending(true);
    onToast(null);
    try {
      const r = await createLineDispatch(selectedLineId, {
        batch_id: batchId,
        num_boxes: numBoxes.trim() !== "" ? Number(numBoxes) : null,
        customer_location: customerLocation.trim() || null,
        vehicle_number: vehicleNumber.trim() || null,
        transporter: transporter.trim() || null,
        transport_location: transportLocation.trim() || null,
      });
      const who = [...(r.to ?? []), ...(r.cc ?? [])].length;
      onToast(
        r.email_sent
          ? `Dispatch sent for ${info?.fg_sku_name ?? "article"} · emailed ${who} recipient${who === 1 ? "" : "s"}.`
          : `Dispatch recorded for ${info?.fg_sku_name ?? "article"} (no email — SMTP off or no recipients assigned).`,
      );
      onClose();
    } catch (e) {
      onToast(`Dispatch failed: ${friendlyApiError(e)}`);
      setSending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Dispatch"
    >
      <div
        className="bg-white rounded-md shadow-[0_8px_28px_rgba(0,28,36,0.28)] w-full max-w-[480px] max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[var(--aws-border)] flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">Dispatch to</h2>
            <p className="text-[11px] text-[var(--text-secondary)] mt-0.5 truncate">
              {plan.plan_name || `Plan #${plan.plan_id}`} · packaging → billing / operations / stores
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 w-7 h-7 inline-flex items-center justify-center rounded-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-subtle)]"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="overflow-y-auto p-4 space-y-4">
          {/* Article picker (per article) */}
          <div>
            <span className="block text-[11px] uppercase tracking-wide font-semibold text-[var(--text-secondary)] mb-1.5">Article</span>
            {lines.length === 0 ? (
              <p className="text-[12px] text-[var(--text-muted)] italic">This plan has no articles.</p>
            ) : (
              <ul className="space-y-1">
                {lines.map((l, i) => {
                  const id = l.plan_line_id ?? null;
                  const disabled = id == null;
                  const checked = selectedLineId === id && id != null;
                  return (
                    <li key={id ?? `idx-${i}`}>
                      <label className={[
                        "flex items-center gap-2.5 px-3 py-2 rounded-sm border transition-colors",
                        disabled ? "opacity-50 cursor-not-allowed border-[var(--aws-border)]"
                          : checked ? "border-[#1d8102] bg-[#eef7ee] cursor-pointer"
                          : "border-[var(--aws-border)] hover:border-[var(--aws-navy)] cursor-pointer",
                      ].join(" ")}>
                        <input
                          type="radio"
                          name="dispatch-article"
                          checked={checked}
                          disabled={disabled}
                          onChange={() => { if (id != null) { setSelectedLineId(id); } }}
                          className="accent-[#1d8102]"
                        />
                        <span className="flex-1 min-w-0">
                          <span className="text-[13px] text-[var(--text-primary)] truncate block" title={l.fg_sku_name ?? ""}>
                            {l.fg_sku_name || "—"}
                          </span>
                          {(l.job_card_count ?? 0) > 0 ? (
                            <span className="text-[10px] text-[var(--text-muted)]">has job cards</span>
                          ) : (
                            <span className="text-[10px] text-[var(--aws-error)]">no job cards yet</span>
                          )}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {selectedLineId == null ? null : loadingInfo ? (
            <p className="text-[11px] text-[var(--text-secondary)] flex items-center gap-2">
              <span className="inline-block w-3 h-3 border-2 border-[var(--aws-border-strong)] border-t-[#1d8102] rounded-full animate-spin" />
              Loading packaging job card…
            </p>
          ) : infoErr ? (
            <p className="text-[11px] text-[var(--aws-error)]">{infoErr}</p>
          ) : info && !info.exists ? (
            <p className="px-2 py-1.5 text-[11px] rounded border text-[#9a393e] border-[var(--aws-border)] bg-[#fdf0f1]">
              This article has no packaging job card yet — dispatch becomes available once its packaging stage exists.
            </p>
          ) : info && info.exists ? (
            <>
              {!info.packaging_completed ? (
                <p className="px-2 py-1.5 text-[11px] rounded border text-[#664d03] border-[#ffe69c] bg-[#fff8e6]">
                  Packaging stage is not marked complete yet ({info.packaging_status}). You can still dispatch a closed batch.
                </p>
              ) : null}

              {/* Batch selector — packaging stage only, defaults to the latest closed batch */}
              <label className="block">
                <span className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">
                  Packaging batch (phase) <span className="text-[var(--aws-error)]">*</span>
                </span>
                {(info.batches ?? []).length === 0 ? (
                  <p className="text-[11px] text-[var(--text-muted)] italic">No packaging batches yet.</p>
                ) : (
                  <select
                    value={batchId ?? ""}
                    onChange={(e) => setBatchId(e.target.value ? Number(e.target.value) : null)}
                    className="w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#1d8102] focus:shadow-[0_0_0_1px_#1d8102]"
                  >
                    {(info.batches ?? []).map((b) => (
                      <option key={b.batch_id} value={b.batch_id}>
                        Batch {b.batch_number}{b.status ? ` · ${b.status}` : ""} — {fmtPlanKg(b.qty_kg)} kg{b.qty_units ? ` / ${fmtPlanUnits(b.qty_units)} pcs` : ""}
                      </option>
                    ))}
                  </select>
                )}
              </label>

              {/* Auto-filled job card details (read-only) */}
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px] bg-[var(--surface-subtle)] border border-[var(--aws-border)] rounded p-2.5">
                <DispatchKV label="Job card" value={info.job_card_number} mono />
                <DispatchKV label="Phase / batch" value={batch ? `#${batch.batch_number}` : undefined} />
                <DispatchKV label="Qty (kg)" value={batch ? `${fmtPlanKg(batch.qty_kg)} kg` : undefined} />
                <DispatchKV label="Qty (units)" value={batch && batch.qty_units ? `${fmtPlanUnits(batch.qty_units)} pcs` : "—"} />
                <DispatchKV label="Warehouse" value={info.warehouse} />
                <DispatchKV label="Floor" value={info.floor} />
                <DispatchKV label="Customer" value={info.customer_name} />
              </dl>

              {/* Operator-entered (no stored source) */}
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">No. of boxes</span>
                  <input
                    type="number" min="0" step="1" value={numBoxes}
                    onChange={(e) => setNumBoxes(e.target.value)} placeholder="0"
                    className="w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#1d8102] focus:shadow-[0_0_0_1px_#1d8102]"
                  />
                </label>
                <label className="block">
                  <span className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">Customer location</span>
                  <input
                    value={customerLocation} onChange={(e) => setCustomerLocation(e.target.value)}
                    placeholder="City / ship-to"
                    className="w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#1d8102] focus:shadow-[0_0_0_1px_#1d8102]"
                  />
                </label>
              </div>

              <div>
                <span className="block text-[11px] uppercase tracking-wide font-semibold text-[var(--text-secondary)] mb-1.5">Transport (optional)</span>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <input value={vehicleNumber} onChange={(e) => setVehicleNumber(e.target.value)} placeholder="Vehicle number"
                    className="w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#1d8102] focus:shadow-[0_0_0_1px_#1d8102]" />
                  <input value={transporter} onChange={(e) => setTransporter(e.target.value)} placeholder="Transporter"
                    className="w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#1d8102] focus:shadow-[0_0_0_1px_#1d8102]" />
                  <input value={transportLocation} onChange={(e) => setTransportLocation(e.target.value)} placeholder="Location"
                    className="w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#1d8102] focus:shadow-[0_0_0_1px_#1d8102]" />
                </div>
              </div>

              <p className="text-[10px] text-[var(--text-muted)]">
                To: billing · candor operations · stores. CC: business heads · operation head · inventory manager · production manager.
              </p>
            </>
          ) : null}
        </div>

        <div className="px-4 py-3 border-t border-[var(--aws-border)] flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSend}
            onClick={send}
            className="h-8 px-4 text-[12px] rounded-[2px] font-semibold border bg-[#1d8102] border-[#176a02] hover:bg-[#176a02] text-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {sending ? "Sending…" : "Send dispatch"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DispatchKV({ label, value, mono }: { label: string; value?: string | number | null; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="uppercase tracking-wide font-semibold text-[var(--text-muted)] text-[9px] leading-[12px]">{label}</div>
      <div className={["text-[12px] leading-[16px] text-[var(--text-primary)] truncate", mono ? "font-mono" : ""].join(" ")}>
        {value == null || value === "" ? "—" : value}
      </div>
    </div>
  );
}
