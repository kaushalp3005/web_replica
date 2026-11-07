"use client";

// The Create / Edit Job Card wizard, shared by the Plan List page and the SO
// Creation "Plans created" panel: CreateJobCardModal (pick an article → quantity
// & process steps), its WIP process list and read-only materials-per-step view,
// and submitJobCardWizard — what the wizard's Continue does on the server.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { friendlyApiError } from "@/lib/apiErrors";
import {
  type PlanRow,
  type PlanBomLine,
  type PlanBomSummary,
  fetchPlanBom,
  createLineJobCards,
  replaceLineJobCards,
  applyLiveJobCardEdits,
  fetchLineJobCardConfig,
  searchCanonicalSfg,
  fmtPlanKg,
} from "@/lib/plans";
import { FACTORY_TO_WAREHOUSE, FLOORS_BY_FACTORY, type FactoryCode } from "@/lib/planBuilder";
import { PROCESS_OPTIONS } from "@/lib/processCatalog";
import { buildArticleOptions, getLineId, numOr0, round3 } from "@/lib/planRowActions";

// ── Create Job Card modal (scaffold) ───────────────────────────────────
//
// Opened by the per-plan "Create Job Card" button. Lists the plan's articles
// (lines_summary) as a single-select radio checklist. Picking one + Continue
// is where the new per-article job-card flow begins — the downstream steps
// (entering process / floor at the job card) are wired in a follow-up. This is
// the path that will replace Approve once complete.

// What the wizard hands its caller on Continue (see submitJobCardWizard).
export type JobCardWizardPayload = {
  planLineId: number | null;
  qtyKg: string;
  qtyUnits: string;
  wipSteps: WipStep[];
  pkgFloor: string;
  pkgProcess: string;
  mode: "create" | "edit";
  liveEdit: boolean;
  pkgJobCardId: number | null;
  removeReasons: Record<string, string>;
  mergePlanLineIds: number[];   // sibling same-SKU lines to fold (create only)
};

// What the wizard's Continue does on the server: a live edit of a started chain,
// a replace (edit) or a create (optionally folding same-SKU sibling lines). The
// message is the toast the caller shows; ok=false keeps the wizard open.
export async function submitJobCardWizard(
  plan: PlanRow,
  p: JobCardWizardPayload,
): Promise<{ ok: boolean; message: string }> {
  if (p.planLineId == null) {
    return { ok: false, message: "Pick an article first." };
  }
  // Same identity scheme the modal selects with (getLineId).
  const ln = (plan.lines_summary ?? []).find((l, i) => getLineId(l, i) === p.planLineId);
  const article = ln?.fg_sku_name ?? "article";
  const qtyUnits = p.qtyUnits.trim() !== "" ? Number(p.qtyUnits) : null;
  try {
    if (p.liveEdit) {
      // Live (started-chain) edit: send each WIP step with its
      // job_card_id (new rows omit it) + per-removed-card reasons.
      // The server diffs against the existing chain and force-records
      // any removed running stage before cancelling it.
      const r = await applyLiveJobCardEdits(p.planLineId, {
        qty_kg: Number(p.qtyKg),
        qty_units: qtyUnits,
        steps: p.wipSteps.map((s) => ({
          job_card_id: s.jobCardId ?? null,
          process: s.process,
          floor: s.floor,
          sfg_output: s.sfgOutput || null,
        })),
        pkg_floor: p.pkgFloor,
        pkg_process: p.pkgProcess,
        pkg_job_card_id: p.pkgJobCardId,
        remove_reasons: p.removeReasons,
      });
      const bits: string[] = [];
      if (r.added) bits.push(`${r.added} added`);
      if (r.removed) bits.push(`${r.removed} removed`);
      if (r.floors_changed) bits.push(`${r.floors_changed} floor change${r.floors_changed === 1 ? "" : "s"}`);
      if (r.qty_changed) bits.push("qty updated");
      if (r.so_sync?.synced) bits.push("SO synced");
      return { ok: true, message: `Live-edited ${article}${bits.length ? " · " + bits.join(" · ") : ""}.` };
    } else {
      const body = {
        qty_kg: Number(p.qtyKg),
        qty_units: qtyUnits,
        wip_steps: p.wipSteps.map((s) => ({
          process: s.process,
          floor: s.floor,
          sfg_output: s.sfgOutput || null,
        })),
        pkg_floor: p.pkgFloor,
        pkg_process: p.pkgProcess,
      };
      if (p.mode === "edit") {
        const r = await replaceLineJobCards(p.planLineId, body);
        return { ok: true, message: `Updated job cards for ${article} · ${r.count} stage${r.count === 1 ? "" : "s"} re-dispatched.` };
      } else {
        const r = await createLineJobCards(p.planLineId, {
          ...body,
          merge_plan_line_ids: p.mergePlanLineIds,
        });
        const mergedNote = p.mergePlanLineIds.length
          ? ` (merged ${p.mergePlanLineIds.length + 1} SOs)`
          : "";
        return { ok: true, message: `Created ${r.count} job card${r.count === 1 ? "" : "s"} for ${article}${mergedNote} · dispatched to floors.` };
      }
    }
  } catch (e) {
    return { ok: false, message: `${p.mode === "edit" ? "Edit" : "Create"} job card failed: ${friendlyApiError(e)}` };
  }
}

export function CreateJobCardModal({
  plan, intent, onClose, onContinue,
}: {
  plan: PlanRow;
  // "create" opens a fresh / additional (create-another) chain drawing from the
  // remaining balance; "edit" opens the existing chain for the selected article.
  intent: "create" | "edit";
  onClose: () => void;
  onContinue: (payload: JobCardWizardPayload) => Promise<boolean>;
}) {
  // Memoised so articleOptions below only rebuilds when the plan's lines change.
  const lines = useMemo(() => plan.lines_summary ?? [], [plan.lines_summary]);
  // Merge same-(SKU, BOM) un-carded lines into one selectable option (combined
  // qty). `selected` holds the option id = the primary line's id.
  const articleOptions = useMemo(() => buildArticleOptions(lines), [lines]);
  const [step, setStep] = useState<1 | 2>(1);
  const [selected, setSelected] = useState<number | null>(
    articleOptions.length === 1 ? articleOptions[0].id : null,
  );
  const selectedOption = articleOptions.find((o) => o.id === selected) ?? null;
  const [qtyKg, setQtyKg] = useState("");
  const [qtyUnits, setQtyUnits] = useState("");
  // Unified process list. The LAST row is the terminal Final-FG (packaging)
  // stage; rows above it are WIP/SFG producers. All rows are mergeable, so a
  // WIP process can be merged with packing into e.g. "Sorting + Packing".
  // Seed = one blank WIP + one blank Packaging terminal.
  const [wipSteps, setWipSteps] = useState<WipStep[]>(
    [{ process: "", floor: "", sfgOutput: "" }, { process: "Packaging", floor: "", sfgOutput: "" }],
  );

  // BOM of the selected article — drives the read-only per-step RM/PM view.
  const [bom, setBom] = useState<PlanBomSummary | null>(null);
  const [bomLoading, setBomLoading] = useState(false);
  const [bomErr, setBomErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Edit mode: the chosen article already has job cards, so step 2 is prefilled
  // from the existing chain and saving REPLACES it. `editable` is false once a
  // stage has started (then save is blocked). `loadingCfg` covers the prefill
  // fetch behind the Next button.
  const [mode, setMode] = useState<"create" | "edit">("create");
  const [editable, setEditable] = useState(true);
  const [loadingCfg, setLoadingCfg] = useState(false);
  // Live-edit (started chain): floor/qty change anytime, add in the un-started
  // tail, remove with a forced JC-data record. `chainStarted` flips the modal
  // from the un-started full-replace path to the live apply-edits path.
  const [chainStarted, setChainStarted] = useState(false);
  const [pkgJobCardId, setPkgJobCardId] = useState<number | null>(null);
  const [removeReasons, setRemoveReasons] = useState<Record<string, string>>({});
  // Read-only snapshot of the existing job-card chain (edit mode) so the
  // operator SEES the previously-created job cards while editing. Captured from
  // the config fetch and kept separate from the editable wipSteps, so it always
  // reflects the AS-SAVED chain rather than the in-progress edits below it.
  const [existingCards, setExistingCards] = useState<{
    jobCardId: number | null; role: string; process: string;
    floor: string; status: string | null;
  }[]>([]);
  // Canonical SFG name for the selected article (auto-fill, design §5.4).
  const [canonicalSfg, setCanonicalSfg] = useState("");
  const liveEdit = mode === "edit" && chainStarted;

  const selectedLine = lines.find((l, i) => getLineId(l, i) === selected) ?? null;
  const selectedBomId = selectedLine?.bom_id ?? null;

  // Load the full BOM (no 30-line cap) whenever the chosen article changes.
  // Async-IIFE + AbortController is this file's accepted fetch-in-effect shape
  // (avoids the no-sync-setState-in-effect lint). RM SOs / lines without a
  // bom_id resolve to no BOM, so the per-step panel hides itself.
  useEffect(() => {
    const c = new AbortController();
    void (async () => {
      // All setState lives inside the async IIFE — this file's accepted shape
      // for the no-sync-setState-in-effect rule (incl. the no-BOM reset).
      if (selectedBomId == null) {
        setBom(null);
        setBomErr(null);
        setBomLoading(false);
        return;
      }
      setBomLoading(true);
      setBomErr(null);
      try {
        const r = await fetchPlanBom(selectedBomId, { full: true, signal: c.signal });
        if (!c.signal.aborted) setBom(r);
      } catch (e) {
        if (!c.signal.aborted) {
          setBom(null);
          setBomErr(e instanceof Error ? e.message : "Failed to load BOM");
        }
      } finally {
        if (!c.signal.aborted) setBomLoading(false);
      }
    })();
    return () => c.abort();
  }, [selectedBomId]);

  // Floors come from the plan's factory: warehouse → factory code → floor set.
  const factory = (Object.keys(FACTORY_TO_WAREHOUSE) as FactoryCode[])
    .find((c) => FACTORY_TO_WAREHOUSE[c] === plan.warehouse);
  const floors = factory ? [...FLOORS_BY_FACTORY[factory]] : [];

  async function goNext() {
    if (selected == null) return;
    const planLineId = selectedLine?.plan_line_id ?? null;
    if (planLineId != null) {
      // Fetch the line config (cheap even when no cards exist) — it carries the
      // canonical SFG for auto-fill (§5.4) and, when carded, the existing chain.
      setLoadingCfg(true);
      try {
        const cfg = await fetchLineJobCardConfig(planLineId);
        const canon = cfg.canonical_sfg ?? "";
        setCanonicalSfg(canon);
        // Snapshot the existing chain (WIP + packaging card) once — shown in the
        // read-only "Existing job cards" panel for BOTH editing and creating
        // another partial chain.
        const snapshot = cfg.exists
          ? [
              ...(cfg.wip_steps ?? []).map((s, i) => ({
                jobCardId: s.job_card_id ?? null,
                role: `WIP ${i + 1}`,
                process: s.process ?? "",
                floor: s.floor ?? "",
                status: s.status ?? null,
              })),
              ...(cfg.pkg_job_card_id != null
                ? [{
                    jobCardId: cfg.pkg_job_card_id,
                    role: "Packaging",
                    process: cfg.pkg_process ?? "Packaging",
                    floor: cfg.pkg_floor ?? "",
                    status: cfg.pkg_status ?? null,
                  }]
                : []),
            ]
          : [];
        setExistingCards(snapshot);

        if (cfg.exists && intent === "edit") {
          // EDIT the existing chain (save REPLACES it).
          setMode("edit");
          setEditable(cfg.editable !== false);
          setChainStarted(cfg.started === true);
          setPkgJobCardId(cfg.pkg_job_card_id ?? null);
          setRemoveReasons({});
          setQtyKg(cfg.qty_kg != null ? String(cfg.qty_kg) : "");
          setQtyUnits(cfg.qty_units != null ? String(cfg.qty_units) : "");
          setWipSteps([
            ...(cfg.wip_steps ?? []).map((s) => ({
              process: s.process ?? "",
              floor: s.floor ?? "",
              // Auto-fill the canonical SFG for articles that have one
              // (overwrites a prior free-typed value); fall back to the
              // saved value only when there's no canonical. Stays editable.
              sfgOutput: canon || (s.sfg_output ?? ""),
              jobCardId: s.job_card_id ?? null,
              started: s.started === true,
            })),
            // Terminal Final-FG (packaging) row — always last.
            {
              process: cfg.pkg_process ?? "Packaging",
              floor: cfg.pkg_floor ?? "",
              sfgOutput: "",
              jobCardId: cfg.pkg_job_card_id ?? null,
              started: cfg.pkg_started === true,
            },
          ]);
        } else {
          // CREATE a fresh chain, OR "create another" partial chain when cards
          // already exist but the operator chose Create — a NEW chain drawing
          // from the line's remaining balance.
          setMode("create");
          setChainStarted(false);
          // Default qty: create-another → the line's remaining balance; a fresh
          // create → the combined (possibly-merged) option qty.
          const remainingKg = selectedLine
            ? round3(Math.max(0, numOr0(selectedLine.planned_qty_kg) - numOr0(selectedLine.carded_qty_kg)))
            : 0;
          const defKg = cfg.exists
            ? remainingKg
            : (selectedOption && selectedOption.kg > 0 ? selectedOption.kg : 0);
          if (qtyKg === "" && defKg > 0) setQtyKg(String(defKg));
          // Units auto-default only for a fresh create — a partial chain's unit
          // split isn't derivable from kg alone, so the operator enters it.
          if (qtyKg === "" && !cfg.exists && selectedOption && selectedOption.units > 0) {
            setQtyUnits(String(selectedOption.units));
          }
          // Prefill the WIP chain + packaging floor from the config (the existing
          // chain's route when carded, else the plan's snapshot route). Each new
          // chain gets its own steps (jobCardId null).
          if (cfg.wip_steps && cfg.wip_steps.length) {
            setWipSteps([
              ...cfg.wip_steps.map((s) => ({
                process: s.process ?? "",
                floor: s.floor ?? "",
                sfgOutput: canon || (s.sfg_output ?? ""),
                jobCardId: null,
                started: false,
              })),
              // Terminal Final-FG (packaging) row — always last.
              { process: cfg.pkg_process ?? "Packaging", floor: cfg.pkg_floor ?? "", sfgOutput: "", jobCardId: null, started: false },
            ]);
          } else {
            // Fresh chain, no plan steps: seed the first WIP step's SFG output.
            setWipSteps((prev) => prev.map((x, idx) => (idx === 0 && !x.sfgOutput ? { ...x, sfgOutput: canon } : x)));
          }
        }
      } catch {
        setMode("create");   // fall back to a create attempt; the server still guards
        setChainStarted(false);
      } finally {
        setLoadingCfg(false);
      }
    } else {
      setMode("create");
      // Prefill combined qty from the selected option the first time we advance.
      if (qtyKg === "" && selectedOption && selectedOption.kg > 0) {
        setQtyKg(String(selectedOption.kg));
      }
      if (qtyUnits === "" && selectedOption && selectedOption.units > 0) {
        setQtyUnits(String(selectedOption.units));
      }
    }
    setStep(2);
  }

  // Add a WIP process — inserted BEFORE the terminal so the last row stays the
  // Final-FG (packaging) stage.
  function addWipProcess() {
    setWipSteps((s) =>
      s.length === 0
        ? [{ process: "", floor: "", sfgOutput: "" }]
        : [...s.slice(0, -1), { process: "", floor: "", sfgOutput: "" }, s[s.length - 1]],
    );
  }

  // Every row needs a process + floor. The last row IS the terminal Final-FG
  // stage. CREATE allows a single-process route (1 row → one RM→FG card); EDIT
  // still needs ≥2 (the replace path can't collapse a chain to a lone stage).
  const minRows = mode === "create" ? 1 : 2;
  const wipOk = wipSteps.length >= minRows && wipSteps.every((s) => s.process !== "" && s.floor !== "");
  const canCreate = qtyKg.trim() !== "" && Number(qtyKg) > 0 && wipOk;

  // Quantity cap (decision: cap-at-remaining). A carded line's remaining balance
  // is planned − Σ(chain-head qty); a fresh line's cap is the (merged) option
  // qty. On the CREATE path the backend hard-caps at this remaining (returns
  // exceeds_balance), so we block submit here too. EDIT replaces via a separate
  // path and isn't re-capped here. Small tolerance absorbs float rounding.
  const selCardedKg = selectedLine ? numOr0(selectedLine.carded_qty_kg) : 0;
  const selRemainingKg = selectedLine
    ? round3(Math.max(0, numOr0(selectedLine.planned_qty_kg) - selCardedKg))
    : null;
  const isCreateAnother = mode === "create" && selCardedKg > 0;
  const capKg = isCreateAnother
    ? selRemainingKg
    : (selectedOption && selectedOption.kg > 0 ? selectedOption.kg : null);
  const overQty = capKg != null && Number(qtyKg) > capKg + 0.001;
  const overBlocks = mode === "create" && overQty;

  // Create + un-started edit go through the replace path (needs `editable`);
  // a started chain goes through the live apply-edits path (always submittable).
  // Over-remaining on a create is a HARD block (cap-at-remaining).
  const canSubmit =
    canCreate && (mode === "create" || editable || liveEdit) && !overBlocks;

  // Remove a WIP row. A started row force-records its job-card data on the
  // server, so we capture a reason first (the operator must confirm).
  function onRemoveStartedReason(jobCardId: number, reason: string) {
    setRemoveReasons((m) => ({ ...m, [String(jobCardId)]: reason }));
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Create job card"
    >
      <div
        className="bg-white rounded-md shadow-[0_8px_28px_rgba(0,28,36,0.28)] w-full max-w-[460px] max-h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[var(--aws-border)] flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">
              {mode === "edit" ? "Edit Job Card" : "Create Job Card"}
            </h2>
            <p className="text-[11px] text-[var(--text-secondary)] mt-0.5 truncate">
              {plan.plan_name || `Plan #${plan.plan_id}`} · {step === 1 ? "pick an article" : "quantity & steps"}
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

        {step === 1 ? (
          <div className="overflow-y-auto p-2">
            {articleOptions.length === 0 ? (
              <p className="text-[12px] text-[var(--text-muted)] italic p-3">This plan has no articles.</p>
            ) : (
              <ul className="space-y-1">
                {articleOptions.map((opt) => {
                  const id = opt.id;
                  const kg = opt.kg > 0 ? fmtPlanKg(opt.kg) : null;
                  const pcs = opt.units > 0 ? String(opt.units) : null;
                  const checked = selected === id;
                  const merged = opt.count > 1;   // same SKU folded from N SOs
                  return (
                    <li key={id}>
                      <label
                        className={[
                          "flex items-center gap-2.5 px-3 py-2 rounded-sm border cursor-pointer transition-colors",
                          checked
                            ? "border-[var(--aws-orange)] bg-[#fef6e7]"
                            : "border-[var(--aws-border)] hover:border-[var(--aws-navy)]",
                        ].join(" ")}
                      >
                        <input
                          type="radio"
                          name="jc-article"
                          checked={checked}
                          onChange={() => {
                            // Switching article drops the previous article's qty
                            // and edit state so goNext re-resolves from the newly
                            // picked option (create-prefill or edit-prefill).
                            if (selected !== id) {
                              setSelected(id);
                              setQtyKg("");
                              setQtyUnits("");
                              setMode("create");
                              setEditable(true);
                              setChainStarted(false);
                              setPkgJobCardId(null);
                              setRemoveReasons({});
                              setExistingCards([]);
                            }
                          }}
                          className="accent-[var(--aws-orange)]"
                        />
                        <span className="flex-1 min-w-0">
                          <span className="flex items-center gap-1.5 min-w-0">
                            <span className="text-[13px] text-[var(--text-primary)] truncate" title={opt.fgSkuName}>
                              {opt.fgSkuName || "—"}
                            </span>
                            {opt.carded ? (
                              opt.remainingKg > 0.001 ? (
                                <span
                                  className="shrink-0 px-1 py-0.5 text-[9px] font-bold uppercase rounded-[2px] border bg-[#fef6e7] text-[#8a4b00] border-[#f5d9a8]"
                                  title="Partially carded — this much balance is left to create"
                                >
                                  {fmtPlanKg(opt.remainingKg)} kg left
                                </span>
                              ) : (
                                <span className="shrink-0 px-1 py-0.5 text-[9px] font-bold uppercase rounded-[2px] border bg-[#eef7ee] text-[#2e7d32] border-[#bfe0c0]">
                                  Carded
                                </span>
                              )
                            ) : null}
                            {merged ? (
                              <span className="shrink-0 px-1 py-0.5 text-[9px] font-bold uppercase rounded-[2px] border bg-[#eef2fb] text-[#1e5aa0] border-[#c3d4ec]">
                                Merged · {opt.count} SOs
                              </span>
                            ) : null}
                          </span>
                          {(kg != null || pcs != null) ? (
                            <span className="block text-[11px] font-mono text-[var(--text-muted)]">
                              {kg != null ? `${kg} kg` : ""}{kg != null && pcs != null ? " · " : ""}{pcs != null ? `${pcs} pcs` : ""}
                              {merged ? " · combined" : ""}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : (
          <div className="overflow-y-auto p-4 space-y-4">
            <div className="text-[12px]">
              <span className="text-[var(--text-muted)]">Article: </span>
              <span className="font-semibold text-[var(--text-primary)]">{selectedLine?.fg_sku_name ?? "—"}</span>
            </div>

            {mode === "edit" && existingCards.length > 0 ? (
              <div className="rounded-[3px] border border-[var(--aws-border)] bg-[var(--surface-subtle)] p-2.5">
                <div className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-secondary)] mb-1.5">
                  Existing job cards
                </div>
                <ul className="space-y-1">
                  {existingCards.map((c, i) => (
                    <li key={c.jobCardId ?? i} className="flex items-center gap-2 text-[11px]">
                      <span className="font-mono text-[var(--aws-link)] shrink-0">
                        {c.jobCardId != null ? `#${c.jobCardId}` : "—"}
                      </span>
                      <span className="text-[var(--text-muted)] shrink-0">{c.role}</span>
                      <span className="font-medium text-[var(--text-primary)] truncate" title={c.process}>
                        {c.process || "—"}
                      </span>
                      {c.floor ? (
                        <span className="text-[var(--text-muted)] truncate">· {c.floor}</span>
                      ) : null}
                      {c.status ? (
                        <span className="ml-auto shrink-0 px-1.5 py-0.5 rounded-[2px] text-[9px] font-semibold capitalize border border-[var(--aws-border)] bg-white text-[var(--text-secondary)]">
                          {c.status.replace(/_/g, " ")}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <p className="text-[10px] text-[var(--text-muted)] italic mt-1.5">
                  Editing below updates this chain.
                </p>
              </div>
            ) : null}

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">
                  Quantity (kg) <span className="text-[var(--aws-error)]">*</span>
                </span>
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={qtyKg}
                  onChange={(e) => setQtyKg(e.target.value)}
                  placeholder="0"
                  className="w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
                />
              </label>
              <label className="block">
                <span className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">Units (nos)</span>
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={qtyUnits}
                  onChange={(e) => setQtyUnits(e.target.value)}
                  placeholder="0"
                  className="w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
                />
              </label>
            </div>

            {overQty ? (
              <p className="text-[11px] text-[#9a393e] -mt-2">
                {isCreateAnother
                  ? `Only ${fmtPlanKg(capKg!)} kg remaining on this line — reduce the quantity.`
                  : `Quantity exceeds this article's planned ${fmtPlanKg(capKg!)} kg — reduce the quantity.`}
              </p>
            ) : null}

            <div className="space-y-3">
              {/* Unified process list — WIP + terminal packaging together, all
                  mergeable. The LAST row is the Final-FG (packaging) stage. */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[11px] uppercase tracking-wide font-semibold text-[var(--text-secondary)]">
                    Processes <span className="text-[var(--aws-error)]">*</span>
                    <span className="ml-1 normal-case font-normal text-[10px] text-[var(--text-muted)]">· last = Final FG</span>
                  </span>
                  <button
                    type="button"
                    onClick={addWipProcess}
                    className="h-6 px-2 text-[11px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] inline-flex items-center gap-1"
                  >
                    <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    Add process
                  </button>
                </div>
                <WipProcessList
                  steps={wipSteps}
                  floors={floors}
                  onChange={setWipSteps}
                  liveEdit={liveEdit}
                  onRemoveStarted={onRemoveStartedReason}
                  canonicalSfg={canonicalSfg}
                  entity={plan.entity ?? undefined}
                />
              </div>

              {floors.length === 0 ? (
                <p className="text-[10px] text-[var(--text-muted)] italic">
                  No floor list for this warehouse — enter the floor name.
                </p>
              ) : null}
            </div>

            {liveEdit ? (
              <p className="px-2 py-1.5 text-[11px] rounded border text-[#664d03] border-[#ffe69c] bg-[#fff8e6]">
                <strong>Live edit</strong> — some stages have started. You can change floors and
                quantity, and add new processes. Started processes (badged) keep their step but
                can&apos;t be reordered; removing one records its job-card data, then cancels it.
                Quantity changes update the linked sales order.
              </p>
            ) : null}

            {/* BOM per process step (read-only). RM+PM under the first WIP
                step, SFG opening-input under packaging — the operational
                model of how job cards actually issue material. */}
            <MaterialsByStep
              wipSteps={wipSteps}
              bom={bom}
              loading={bomLoading}
              err={bomErr}
              hasBom={selectedBomId != null}
            />
          </div>
        )}

        <div className="px-4 py-3 border-t border-[var(--aws-border)] flex items-center justify-between gap-2">
          {step === 1 ? (
            <>
              <span className="text-[11px] text-[var(--text-muted)] italic">Pick the article to make a job card for.</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={selected == null || loadingCfg}
                  onClick={goNext}
                  className="h-8 px-4 text-[12px] rounded-[2px] font-semibold border bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loadingCfg ? "Loading…" : "Next"}
                </button>
              </div>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setStep(1)}
                className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]"
              >
                Back
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!canSubmit || creating}
                  onClick={async () => {
                    setCreating(true);
                    // Split the unified list: all-but-last = WIP; the last row is
                    // the terminal Final-FG (packaging) stage.
                    const term = wipSteps[wipSteps.length - 1];
                    const wipOnly = wipSteps.slice(0, -1);
                    const ok = await onContinue({
                      planLineId: selected, qtyKg, qtyUnits,
                      wipSteps: wipOnly,
                      pkgFloor: term?.floor ?? "",
                      pkgProcess: term?.process ?? "Packaging",
                      mode, liveEdit,
                      pkgJobCardId: term?.jobCardId ?? pkgJobCardId,
                      removeReasons,
                      // Fold sibling same-SKU lines into this primary — only on a
                      // fresh create of a merged option; empty otherwise.
                      mergePlanLineIds: mode === "create" && selectedOption
                        ? selectedOption.memberIds.filter((m) => m !== selected)
                        : [],
                    });
                    if (ok) onClose();        // success → modal unmounts
                    else setCreating(false);  // failure → stay open (toast shows why)
                  }}
                  className="h-8 px-4 text-[12px] rounded-[2px] font-semibold border bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {creating
                    ? (mode === "edit" ? "Saving…" : "Creating…")
                    : (mode === "edit" ? "Save changes" : "Create Job Card")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// WIP process list — mirrors the planning page's StepsSection logic
// (drag + ↑/↓ reorder, multi-select merge, remove) adapted to the WIP
// { process, floor } shape. Merge joins process names with " + " and keeps a
// floor only when the selected rows agree (conflict → blank, operator re-picks),
// matching planning's mergeCardSteps. State (drag + merge-selection) is local;
// committed changes flow up through onChange.
export type WipStep = {
  process: string;
  floor: string;
  sfgOutput: string;
  // Set when this row maps to an existing job card (live edit). `started` is
  // true once that card has progressed past locked/unlocked — the process can
  // no longer be changed/reordered, only its floor; removal force-records it.
  jobCardId?: number | null;
  started?: boolean;
};

export function WipProcessList({
  steps, floors, onChange, liveEdit = false, onRemoveStarted, canonicalSfg = "", entity, sfgReadOnly = false,
}: {
  steps: WipStep[];
  floors: string[];
  onChange: (next: WipStep[]) => void;
  // Live edit of a started chain: started rows lock their process + reordering
  // (floor stays editable) and removal force-records the job card first.
  liveEdit?: boolean;
  onRemoveStarted?: (jobCardId: number, reason: string) => void;
  // Canonical SFG name for the article — drives the auto-fill placeholder + the
  // non-match warning / "Use canonical" affordance (design §5.4).
  canonicalSfg?: string;
  // Plan entity (cfpl/cdpl) — scopes the SFG catalogue typeahead ranking.
  entity?: string;
  // Show each row's SFG output without letting it be typed — for a plan's
  // route, where the SFG isn't stored and is set when the job card is created.
  // Rows with no SFG output then show none.
  sfgReadOnly?: boolean;
}) {
  // Per-list datalist ids, so two lists on one screen (a plan's route and the
  // job-card wizard) don't read each other's suggestions.
  const uid = useId();
  const sfgListId = `sfg-canon-options-${uid}`;
  const processListId = `process-options-${uid}`;
  const dragFromRef = useRef<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [selectedIdxs, setSelectedIdxs] = useState<Set<number>>(new Set());

  // SFG catalogue typeahead (design §5.4): a single shared <datalist> fed by a
  // debounced search of whichever SFG field is being edited; every SFG input
  // binds to it via list=. Free-text stays allowed.
  const [sfgSuggestions, setSfgSuggestions] = useState<string[]>([]);
  const sfgSearch = useRef<{ t: ReturnType<typeof setTimeout> | null; ctrl: AbortController | null }>({ t: null, ctrl: null });
  function searchSfg(term: string) {
    const s = sfgSearch.current;
    if (s.t) clearTimeout(s.t);
    if (!term.trim()) { setSfgSuggestions([]); return; }
    s.t = setTimeout(() => {
      s.ctrl?.abort();
      const ctrl = new AbortController();
      s.ctrl = ctrl;
      void searchCanonicalSfg(term, entity, 20, ctrl.signal).then((rows) => {
        if (!ctrl.signal.aborted) setSfgSuggestions(rows.map((r) => r.sfg_name));
      });
    }, 250);
  }
  useEffect(() => {
    const s = sfgSearch.current;
    return () => { if (s.t) clearTimeout(s.t); s.ctrl?.abort(); };
  }, []);

  // Merge is one-shot — once the list length changes the indices no longer
  // line up, so clear the selection. Deferred past the effect body to satisfy
  // the no-sync-setState-in-effect rule (same pattern as planning).
  useEffect(() => {
    queueMicrotask(() => setSelectedIdxs(new Set()));
  }, [steps.length]);

  const allSelected = steps.length > 0 && selectedIdxs.size === steps.length;
  const anySelected = selectedIdxs.size > 0;

  function move(from: number, to: number) {
    if (from < 0 || from >= steps.length || to < 0 || to >= steps.length || from === to) return;
    const next = steps.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
  }
  function setField(i: number, patch: Partial<WipStep>) {
    onChange(steps.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  }
  function remove(i: number) {
    if (steps.length <= 1) return;
    const s = steps[i];
    // Removing a running stage force-records its job-card data, then cancels —
    // confirm + capture a reason before dropping the row.
    if (liveEdit && s.started && s.jobCardId != null) {
      const entered = typeof window !== "undefined"
        ? window.prompt(
            `Remove the running process "${s.process || "this stage"}"?\n` +
            "Its job-card data is recorded, then the process is cancelled.\n\nReason:",
            "",
          )
        : "";
      if (entered == null) return;   // operator cancelled the prompt
      onRemoveStarted?.(s.jobCardId, entered.trim() || "Removed via live edit");
    }
    onChange(steps.filter((_, j) => j !== i));
  }
  function toggleSelect(i: number) {
    setSelectedIdxs((prev) => {
      const n = new Set(prev);
      if (n.has(i)) n.delete(i); else n.add(i);
      return n;
    });
  }
  function selectAll(on: boolean) {
    setSelectedIdxs(on ? new Set(steps.map((_, i) => i)) : new Set());
  }
  function merge() {
    const valid = [...selectedIdxs].filter((i) => i >= 0 && i < steps.length).sort((a, b) => a - b);
    if (valid.length < 2) return;
    const picked = valid.map((i) => steps[i]);
    const process = picked.map((p) => p.process || "—").join(" + ");
    const uniqueFloors = new Set(picked.map((p) => p.floor).filter(Boolean));
    const floor = uniqueFloors.size === 1 ? [...uniqueFloors][0] : "";
    // Preserve every distinct SFG output rather than silently keeping only the
    // first — output identity is load-bearing for the SFG seam, so dropping the
    // rest would lose the codes the operator entered. Distinct, in order; the
    // operator can prune the joined value if the merge was a mistake.
    const sfgOutput = [...new Set(picked.map((p) => p.sfgOutput).filter(Boolean))].join(" + ");
    const [firstIdx, ...rest] = valid;
    const next = steps.slice();
    // Remove the trailing merged rows right-to-left so earlier indices stay put,
    // then write the merged step into the first selected slot.
    [...rest].reverse().forEach((i) => next.splice(i, 1));
    next[firstIdx] = { process, floor, sfgOutput };
    setSelectedIdxs(new Set());
    onChange(next);
  }

  const iconBtn = "w-6 h-7 inline-flex items-center justify-center rounded-sm text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] disabled:opacity-30 disabled:cursor-not-allowed";

  return (
    <div>
      {/* Shared SFG catalogue suggestions for every SFG input's `list=`. */}
      <datalist id={sfgListId}>
        {sfgSuggestions.map((name) => <option key={name} value={name} />)}
      </datalist>
      {/* Standard process suggestions — the Process field is type-or-pick, so
          these are hints only; a free-typed process name is allowed. */}
      <datalist id={processListId}>
        {PROCESS_OPTIONS.map((p) => <option key={p} value={p} />)}
      </datalist>
      {/* Process checklist toolbar — a checkbox per process (below) plus
          Select-all + Merge here. Merge stays disabled until 2+ processes are
          checked. Hidden during live edit (started rows must keep their order /
          identity, so merge/reorder is disabled). */}
      {liveEdit ? null : (
      <div className="flex flex-wrap items-center gap-2 mb-1.5 px-2 py-1.5 bg-[var(--surface-subtle)] border border-[var(--aws-border)] rounded">
          <label className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] cursor-pointer">
            <input
              type="checkbox"
              checked={allSelected}
              ref={(el) => { if (el) el.indeterminate = anySelected && !allSelected; }}
              onChange={(e) => selectAll(e.target.checked)}
              className="accent-[var(--aws-orange)]"
            />
            <span>Select all</span>
          </label>
          <span className="text-[11px] text-[var(--text-muted)]">·</span>
          <span className="text-[11px] text-[var(--text-secondary)]">
            <strong className="text-[var(--text-primary)]">{selectedIdxs.size}</strong> selected
          </span>
          <div className="flex-1" />
          <button
            type="button"
            disabled={selectedIdxs.size < 2}
            onClick={merge}
            title="Combine the selected processes into one (names joined with +)"
            className={[
              "h-7 px-2.5 text-[11px] rounded-[2px] font-semibold border inline-flex items-center gap-1.5",
              selectedIdxs.size < 2
                ? "bg-[var(--surface-disabled)] border-[var(--aws-border)] text-[var(--text-disabled)] cursor-not-allowed"
                : "bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white",
            ].join(" ")}
          >
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <polyline points="8 12 3 12 8 7" /><polyline points="16 12 21 12 16 17" /><line x1="3" y1="12" x2="21" y2="12" />
            </svg>
            Merge processes
          </button>
      </div>
      )}

      <ol className="space-y-1.5">
        {steps.map((s, i) => {
          const isDragOver = dragOverIdx === i;
          const rowStarted = liveEdit && s.started === true;
          return (
            <li
              // Not keyed by the process name: typing in the Process box would
              // change the key on every letter and rebuild the row, losing focus.
              key={`${s.jobCardId ?? "row"}-${i}`}
              draggable={!liveEdit}
              onDragStart={(e) => { if (liveEdit) return; dragFromRef.current = i; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i)); }}
              onDragEnd={() => { dragFromRef.current = null; setDragOverIdx(null); }}
              onDragOver={(e) => { if (dragFromRef.current == null) return; e.preventDefault(); setDragOverIdx(i); }}
              onDragLeave={() => setDragOverIdx((c) => (c === i ? null : c))}
              onDrop={(e) => { e.preventDefault(); const from = dragFromRef.current; if (from == null || from === i) return; move(from, i); dragFromRef.current = null; setDragOverIdx(null); }}
              className={[
                "border rounded bg-white px-2 py-1.5",
                i === steps.length - 1 ? "border-[var(--aws-orange-active)] bg-[#fffaf5]" : "",
                isDragOver ? "border-[var(--aws-orange)] bg-[#fdf0f1]" : (i === steps.length - 1 ? "" : "border-[var(--aws-border)]"),
              ].join(" ")}
            >
              {i === steps.length - 1 ? (
                <div className="mb-1">
                  <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-sm bg-[#fdeee0] text-[#9a5a14] border border-[#f0c79a]">
                    Final FG · packaging
                  </span>
                </div>
              ) : null}
              <div className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={selectedIdxs.has(i)}
                  onChange={() => toggleSelect(i)}
                  disabled={rowStarted}
                  title={rowStarted ? "Running stages can't be merged" : "Select to merge"}
                  className="accent-[var(--aws-orange)] shrink-0 disabled:opacity-30"
                />
                {liveEdit ? null : (
                  <span aria-hidden title="Drag to reorder" className="shrink-0 inline-flex items-center justify-center w-4 h-7 text-[var(--text-muted)] cursor-grab active:cursor-grabbing">
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                      <circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" /><circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" /><circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" />
                    </svg>
                  </span>
                )}
                <span className={["shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full text-white text-[10px] font-bold", rowStarted ? "bg-[#1d8102]" : "bg-[var(--aws-navy)]"].join(" ")} title={rowStarted ? "Running" : undefined}>{i + 1}</span>
                {rowStarted ? (
                  <span className="shrink-0 px-1 py-0.5 text-[9px] font-bold uppercase rounded-[2px] border bg-[#eef7ee] text-[#2e7d32] border-[#bfe0c0]" title="This stage has started">
                    Running
                  </span>
                ) : null}
                {/* Process + floor stacked in one aligned column; the process
                    name truncates with … and shows full on hover (title). */}
                <div className="flex-1 min-w-0 space-y-1">
                  <input
                    list={processListId}
                    value={s.process}
                    onChange={(e) => setField(i, { process: e.target.value })}
                    disabled={rowStarted}
                    placeholder="— Process —"
                    autoComplete="off"
                    title={rowStarted ? "Process can't change once started — remove it to replace" : (s.process || undefined)}
                    className="w-full truncate h-7 px-1.5 text-[12px] font-semibold rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] disabled:bg-[var(--surface-subtle)] disabled:text-[var(--text-secondary)]"
                  />
                  {floors.length > 0 ? (
                    <select
                      value={s.floor}
                      onChange={(e) => setField(i, { floor: e.target.value })}
                      title={s.floor || undefined}
                      className="w-full truncate h-7 px-1.5 text-[12px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
                    >
                      <option value="">— Floor —</option>
                      {floors.map((f) => <option key={f} value={f}>{f}</option>)}
                    </select>
                  ) : (
                    <input
                      value={s.floor}
                      onChange={(e) => setField(i, { floor: e.target.value })}
                      placeholder="Floor"
                      className="w-full h-7 px-1.5 text-[12px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
                    />
                  )}
                  {sfgReadOnly ? (
                    s.sfgOutput ? (
                      <input
                        readOnly
                        value={s.sfgOutput}
                        aria-label="SFG output"
                        title={`${s.sfgOutput} — set on the job card when it's created`}
                        className="w-full truncate h-7 px-1.5 text-[12px] rounded-[2px] bg-[var(--surface-subtle)] text-[var(--text-secondary)] border border-[var(--aws-border)] outline-none"
                      />
                    ) : null
                  ) : (
                  <input
                    list={sfgListId}
                    value={s.sfgOutput}
                    onChange={(e) => { setField(i, { sfgOutput: e.target.value }); searchSfg(e.target.value); }}
                    title={s.sfgOutput || undefined}
                    placeholder={canonicalSfg || "SFG output — search catalogue…"}
                    className="w-full truncate h-7 px-1.5 text-[12px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
                  />
                  )}
                  {/* Canonical-SFG affordance (design §5.4): show the catalogue
                      value; warn + offer one-click apply when the typed value
                      diverges, so any drift stays visible and auditable. */}
                  {sfgReadOnly ? null : canonicalSfg ? (
                    s.sfgOutput.trim() === canonicalSfg ? (
                      <span className="block text-[10px] text-[var(--text-success)] truncate" title={canonicalSfg}>
                        ✓ Canonical SFG
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5 text-[10px] text-[var(--text-muted)] min-w-0">
                        <span className="truncate" title={canonicalSfg}>
                          Canonical: {canonicalSfg}
                        </span>
                        <button
                          type="button"
                          onClick={() => setField(i, { sfgOutput: canonicalSfg })}
                          className="shrink-0 text-[var(--aws-link)] hover:underline font-semibold"
                        >
                          Use
                        </button>
                      </span>
                    )
                  ) : null}
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                  <button type="button" onClick={() => move(i, i - 1)} disabled={i === 0 || liveEdit} aria-label="Move up" className={iconBtn}>
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><polyline points="6 15 12 9 18 15" /></svg>
                  </button>
                  <button type="button" onClick={() => move(i, i + 1)} disabled={i === steps.length - 1 || liveEdit} aria-label="Move down" className={iconBtn}>
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                  </button>
                  <button type="button" onClick={() => remove(i)} disabled={steps.length <= 1} aria-label="Remove process" className={[iconBtn, "hover:text-[var(--aws-error)]"].join(" ")}>
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}


// Read-only "Materials per step" — maps the BOM's RM / PM / SFG lines onto the
// job card's process steps using the OPERATIONAL model (how job cards actually
// issue material, per job_card_v2._materialise_indents): ALL RM + PM are issued
// on the FIRST WIP step; intermediate WIP steps consume upstream WIP and issue
// nothing fresh; any SFG opening-input is consumed at the packaging (Final FG)
// step. Reflects the live wipSteps order, so reordering updates which step is
// "first". Renders nothing for articles without a BOM (e.g. RM SOs).
function MaterialsByStep({
  wipSteps, bom, loading, err, hasBom,
}: {
  wipSteps: WipStep[];
  bom: PlanBomSummary | null;
  loading: boolean;
  err: string | null;
  hasBom: boolean;
}) {
  if (!hasBom) return null;
  // Unified list: all but the last are WIP; the last is the terminal packaging.
  const wip = wipSteps.slice(0, -1);
  const term = wipSteps[wipSteps.length - 1];

  const kind = (t: string | null | undefined) => (t ?? "").trim().toLowerCase();
  const allLines = bom?.lines ?? [];
  const rm = allLines.filter((l) => kind(l.item_type) === "rm");
  const pm = allLines.filter((l) => kind(l.item_type) === "pm");
  const sfg = allLines.filter((l) => kind(l.item_type) === "sfg");

  const chip = (t: string | null | undefined) => {
    const k = kind(t);
    const cls =
      k === "rm" ? "bg-[#fef6e7] text-[#8a6d1a] border-[#e8d8a8]"
      : k === "pm" ? "bg-[#eef4fb] text-[var(--aws-navy)] border-[#c9ddf2]"
      : k === "sfg" ? "bg-[#fdeee0] text-[#9a5a14] border-[#f0c79a]"
      : "bg-[var(--surface-subtle)] text-[var(--text-secondary)] border-[var(--aws-border)]";
    return (
      <span className={`shrink-0 px-1 py-0.5 text-[9px] font-bold uppercase rounded-[2px] border ${cls}`}>
        {t || "—"}
      </span>
    );
  };

  // A plain render helper (NOT a nested component) so it doesn't trip the
  // unstable-nested-component rule and never remounts the rows.
  const renderRows = (rows: PlanBomLine[]) =>
    rows.length === 0 ? null : (
      <ul className="mt-1 space-y-0.5">
        {rows.map((l, i) => (
          <li key={`${l.bom_line_id ?? "x"}-${i}`} className="flex items-center gap-1.5 text-[11px]">
            {chip(l.item_type)}
            <span className="flex-1 min-w-0 truncate text-[var(--text-primary)]" title={l.material_sku_name ?? ""}>
              {l.material_sku_name || "—"}
            </span>
            <span className="shrink-0 font-mono text-[var(--text-secondary)]">
              {l.quantity_per_unit != null ? l.quantity_per_unit : "—"}{l.uom ? ` ${l.uom}` : ""}
            </span>
            {l.godown ? <span className="shrink-0 text-[10px] text-[var(--text-muted)]">{l.godown}</span> : null}
          </li>
        ))}
      </ul>
    );

  return (
    <div>
      <span className="text-[11px] uppercase tracking-wide font-semibold text-[var(--text-secondary)]">
        Materials per step
      </span>
      {loading ? (
        <div className="mt-1.5 text-[11px] text-[var(--text-secondary)] flex items-center gap-2 py-1">
          <span className="inline-block w-3 h-3 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
          Loading BOM…
        </div>
      ) : err ? (
        <p className="mt-1.5 px-2 py-1.5 text-[11px] italic rounded border text-[var(--aws-error)] border-[var(--aws-border)] bg-[#fdf0f1]">
          {err}
        </p>
      ) : allLines.length === 0 ? (
        <p className="mt-1.5 px-2 py-1.5 text-[11px] italic rounded border border-dashed border-[var(--aws-border)] bg-[var(--surface-subtle)] text-[var(--text-muted)]">
          No BOM materials configured for this article.
        </p>
      ) : (
        <div className="mt-1.5 space-y-1.5">
          {wip.map((s, i) => (
            <div key={`${s.process}-${i}`} className="border border-[var(--aws-border)] rounded px-2 py-1.5 bg-white">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--text-primary)]">
                <span className="shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full bg-[var(--aws-navy)] text-white text-[9px] font-bold">{i + 1}</span>
                <span className="truncate" title={s.process || undefined}>{s.process || `WIP step ${i + 1}`}</span>
                {s.floor ? <span className="shrink-0 text-[10px] font-normal text-[var(--text-muted)]">· {s.floor}</span> : null}
              </div>
              {i === 0 ? (
                rm.length + pm.length === 0 ? (
                  <p className="mt-1 text-[10px] italic text-[var(--text-muted)]">No RM/PM in this BOM.</p>
                ) : (
                  <>
                    {renderRows(rm)}
                    {renderRows(pm)}
                  </>
                )
              ) : (
                <p className="mt-1 text-[10px] italic text-[var(--text-muted)]">
                  Consumes WIP from the previous stage — no fresh material issued.
                </p>
              )}
            </div>
          ))}

          {/* Terminal Final-FG stage. Multi-stage: consumes the SFG opening
              input. Single-process (no WIP rows): this card IS stage 1, so it
              issues the fresh RM + PM instead — mirror the first-WIP body. */}
          <div className="border border-[var(--aws-border)] rounded px-2 py-1.5 bg-white">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--text-primary)]">
              <span className="shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full bg-[var(--aws-orange)] text-white text-[9px] font-bold">P</span>
              <span className="truncate" title={term?.process || undefined}>{term?.process || "Packaging"}</span>
              {term?.floor ? <span className="shrink-0 text-[10px] font-normal text-[var(--text-muted)]">· {term.floor}</span> : null}
            </div>
            {wip.length === 0 ? (
              rm.length + pm.length === 0 ? (
                <p className="mt-1 text-[10px] italic text-[var(--text-muted)]">No RM/PM in this BOM.</p>
              ) : (
                <>
                  {renderRows(rm)}
                  {renderRows(pm)}
                </>
              )
            ) : sfg.length > 0 ? (
              renderRows(sfg)
            ) : (
              <p className="mt-1 text-[10px] italic text-[var(--text-muted)]">
                Final FG / packing — no opening SFG in this BOM.
              </p>
            )}
          </div>

          <p className="text-[10px] text-[var(--text-muted)] leading-snug">
            RM + PM are issued on the first stage (matching how job cards issue material); any SFG opening input is consumed at packaging.
          </p>
        </div>
      )}
    </div>
  );
}
