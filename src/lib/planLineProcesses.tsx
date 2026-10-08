"use client";

// One plan line's process route inside the "Plans created" panel, in the Plan
// List's process picker: process, floor and SFG per row, with merge, reorder,
// add and remove. Saving writes the route to the plan's steps — the route
// Create Job Card starts from. A line that already has job cards shows its
// job-card chain instead (read-only: changing a plan step would change those
// cards, so that goes through Edit Job Card). A plan that's no longer a draft
// shows its route read-only.

import { useEffect, useState } from "react";
import { friendlyApiError } from "@/lib/apiErrors";
import { stepsText } from "@/lib/createdPlans";
import { FACTORY_TO_WAREHOUSE, FLOORS_BY_FACTORY, type FactoryCode } from "@/lib/planBuilder";
import { WipProcessList, type WipStep } from "@/lib/planJobCardModal";
import { jobCardRoute, planStepChanges, rowsFromSteps, type StepRow } from "@/lib/planStepSync";
import { useUserScope } from "@/lib/user";
import {
  type LineJobCardConfig,
  type PlanLineRow,
  addPlanStep, deletePlanStep, fetchLineJobCardConfig, reorderPlanSteps, updatePlanStep,
} from "@/lib/plans";

// A line with no saved route starts like the job-card wizard: one process to
// pick, then packaging.
const BLANK_ROUTE: StepRow[] = [{ process: "", floor: "" }, { process: "Packaging", floor: "" }];

/** Remount key for a line's route: changes whenever the saved steps or the
 *  line's job cards do, so a reload after saving starts the picker afresh. */
export function routeKey(line: PlanLineRow, index: number): string {
  const steps = (line.steps ?? [])
    .map((s) => `${s.step_id}|${s.step_order}|${s.process_name ?? ""}|${s.floor ?? ""}`)
    .join(",");
  return `${line.plan_line_id ?? `i${index}`}:${line.job_card_count ?? 0}:${steps}`;
}

function floorsFor(warehouse?: string | null): string[] {
  const factory = (Object.keys(FACTORY_TO_WAREHOUSE) as FactoryCode[])
    .find((c) => FACTORY_TO_WAREHOUSE[c] === warehouse);
  return factory ? [...FLOORS_BY_FACTORY[factory]] : [];
}

export function PlanLineProcesses({ line, warehouse, entity, editable, onSaved, onMessage }: {
  line: PlanLineRow;
  warehouse?: string | null;
  entity?: string | null;
  /** A draft plan whose detail (with its steps) loaded. */
  editable: boolean;
  /** After a save attempt (success or failure) — the caller shows the message
   *  and reloads, so the picker shows what the server now holds. */
  onSaved: (message: string) => void;
  onMessage: (message: string | null) => void;
}) {
  const lineId = line.plan_line_id ?? null;
  const article = line.fg_sku_name || "this article";
  const carded = (line.job_card_count ?? 0) > 0;

  // The line's job-card setup: the standard SFG for its article and, once it has
  // job cards, their chain.
  const [cfg, setCfg] = useState<LineJobCardConfig | null>(null);
  const [cfgErr, setCfgErr] = useState<string | null>(null);
  useEffect(() => {
    if (lineId == null) return;
    let alive = true;
    fetchLineJobCardConfig(lineId)
      .then((c) => { if (alive) setCfg(c); })
      .catch((e) => { if (alive) setCfgErr(friendlyApiError(e)); });
    return () => { alive = false; };
  }, [lineId]);

  const scope = useUserScope();
  // What the plan holds now, and where the picker starts: the route as Create
  // Job Card reads it (a lone step gets Packaging after it), or the blank
  // starter route when nothing is saved.
  const [saved] = useState<StepRow[]>(() => rowsFromSteps(line.steps));
  const [start] = useState<StepRow[]>(() => (saved.length ? jobCardRoute(saved) : BLANK_ROUTE));
  const [rows, setRows] = useState<StepRow[]>(start);
  // "saving" while the calls run; "saved" once they've all succeeded — the
  // picker stays locked until the reload brings the new route (and remounts it).
  const [busy, setBusy] = useState<"" | "saving" | "saved">("");

  if (lineId == null) {
    return <span className="text-[var(--text-primary)]">{stepsText(line.steps)}</span>;
  }

  const canon = cfg?.canonical_sfg ?? "";

  if (carded) {
    if (cfg?.exists) {
      const chain = [
        ...(cfg.wip_steps ?? []).map((s) => ({
          process: s.process ?? "", floor: s.floor ?? "", sfg: s.sfg_output ?? "", status: s.status ?? null,
        })),
        { process: cfg.pkg_process ?? "Packaging", floor: cfg.pkg_floor ?? "", sfg: "", status: cfg.pkg_status ?? null },
      ];
      return (
        <div>
          <RouteList items={chain} />
          <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">
            Job cards made — change their processes with Edit Job Card.
          </p>
        </div>
      );
    }
    // Still loading, failed, or (unexpectedly) no chain found: the plan's route.
    const note = cfgErr
      ? `Couldn't load its job cards: ${cfgErr}`
      : cfg ? "Job cards made — change them with Edit Job Card." : "Loading its job cards…";
    return (
      <div>
        <span className="text-[var(--text-primary)]">{stepsText(line.steps)}</span>
        <p className="mt-1 text-[11px] text-[var(--text-muted)]">{note}</p>
      </div>
    );
  }

  if (!editable) {
    // The saved route only — never the blank starter rows. A line taken from the
    // list summary (the plan's detail didn't load) carries no steps at all.
    if (line.steps == null) {
      return <span className="text-[var(--text-muted)]">— (couldn&apos;t load its processes)</span>;
    }
    if (saved.length === 0) {
      return <span className="text-[var(--text-muted)]">No processes saved on this plan line.</span>;
    }
    const route = jobCardRoute(saved);
    return (
      <RouteList
        items={route.map((r, i) => ({ process: r.process, floor: r.floor, sfg: i < route.length - 1 ? canon : "", status: null }))}
      />
    );
  }

  // The picker shows the standard SFG on every process before packaging; it
  // isn't saved on the plan (the job card gets it when it's created).
  const shown: (WipStep & { stepId?: number })[] = rows.map((r, i) => ({
    ...r, sfgOutput: i < rows.length - 1 ? canon : "",
  }));
  const changed = JSON.stringify(rows) !== JSON.stringify(start);   // → Undo
  const unsaved = JSON.stringify(rows) !== JSON.stringify(saved);   // → Save
  const locked = busy !== "";
  const floorsSet = rows.filter((r) => r.floor.trim()).length;

  function onChange(next: WipStep[]) {
    if (locked) return;
    // Rows keep the step they came from (stepId rides along through edits and
    // moves); a merged row is a new one.
    setRows((next as (WipStep & { stepId?: number })[]).map((s) => ({
      process: s.process,
      floor: s.floor,
      ...(s.stepId != null ? { stepId: s.stepId } : {}),
    })));
  }

  function addProcess() {
    if (locked) return;
    // Before the last (packaging) row, as in the job-card wizard.
    setRows((s) => (s.length === 0
      ? [{ process: "", floor: "" }]
      : [...s.slice(0, -1), { process: "", floor: "" }, s[s.length - 1]]));
  }

  async function save() {
    if (lineId == null || locked) return;
    // One row would be read by Create Job Card as that process plus a Packaging
    // stage, not as the Final FG row the picker shows — so keep two or more.
    if (rows.length < 2) {
      onMessage(`Keep at least one process before the Final FG (packaging) row of ${article}.`);
      return;
    }
    if (rows.some((r) => !r.process.trim())) {
      onMessage(`Pick a process for every row of ${article} before saving.`);
      return;
    }
    const savedSteps = [...(line.steps ?? [])]
      .sort((a, b) => (a.step_order ?? Infinity) - (b.step_order ?? Infinity));
    const ch = planStepChanges(savedSteps, rows);
    if (!ch.deletes.length && !ch.patches.length && !ch.adds.length && !ch.reorder) {
      onMessage("Nothing to save.");
      return;
    }
    // The server refuses a floor the user isn't assigned to — say so before any
    // call, rather than part-way through.
    if (!scope.isAdmin && scope.floors.length > 0) {
      const sent = [
        ...ch.patches.map((p) => p.floor),
        ...ch.adds.map((i) => rows[i].floor.trim()),
      ].filter((f): f is string => !!f);
      const blocked = [...new Set(sent.filter((f) => !scope.floors.includes(f)))];
      if (blocked.length) {
        onMessage(`You aren't assigned to ${blocked.join(", ")} — pick one of your floors (${scope.floors.join(", ")}).`);
        return;
      }
    }
    setBusy("saving");
    onMessage(null);
    let stage = "adding the new processes";
    try {
      // Nothing is removed until the rest has gone through, so a failure part-way
      // leaves extra steps, never missing ones. New steps go one at a time (the
      // server numbers them in arrival order); the final order comes last.
      const ids: (number | undefined)[] = rows.map((r, i) => (ch.adds.includes(i) ? undefined : r.stepId));
      for (const i of ch.adds) {
        const res = await addPlanStep(lineId, {
          process_name: rows[i].process.trim(),
          floor: rows[i].floor.trim() || null,
        });
        // The server answers { added, step: { step_id, … } }.
        const step = (res as { step?: { step_id?: number } }).step;
        ids[i] = step?.step_id ?? res.step_id;
      }
      stage = "updating the changed processes";
      await Promise.all(ch.patches.map(({ stepId, ...body }) => updatePlanStep(stepId, body)));
      stage = "removing processes";
      for (const id of ch.deletes) await deletePlanStep(id);
      stage = "saving the order";
      if (ch.reorder) {
        if (ids.some((id) => id == null)) {
          throw new Error("a new process came back without an id");
        }
        await reorderPlanSteps(lineId, ids as number[]);
      }
      setBusy("saved");
      onSaved(`Processes saved for ${article}.`);
    } catch (e) {
      setBusy("");
      onSaved(`Saving the processes of ${article} failed while ${stage}: ${friendlyApiError(e)}. Check its route and save again.`);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-[11px] uppercase tracking-wide font-semibold text-[var(--text-secondary)]">
          Processes
          <span className="ml-1 normal-case font-normal text-[10px] text-[var(--text-muted)]">· last = Final FG</span>
        </span>
        <button
          type="button"
          onClick={addProcess}
          disabled={locked}
          className="h-6 px-2 text-[11px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] inline-flex items-center gap-1 disabled:opacity-50"
        >
          <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Add process
        </button>
      </div>
      {/* Locked while saving and until the reload shows the saved route. */}
      <fieldset disabled={locked} className="m-0 p-0 border-0 min-w-0">
        <WipProcessList
          steps={shown}
          floors={floorsFor(warehouse)}
          onChange={onChange}
          canonicalSfg={canon}
          entity={entity ?? undefined}
          sfgReadOnly
        />
      </fieldset>
      {saved.length === 1 ? (
        <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">
          This plan line has one saved process; Create Job Card adds Packaging after it, as shown. Save to keep it on the plan.
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-[var(--text-muted)]">
          {floorsSet}/{rows.length} floors set{floorsSet < rows.length ? " · every process needs a floor for its job card" : ""}
        </span>
        <div className="flex-1" />
        {changed ? (
          <button
            type="button"
            onClick={() => setRows(start)}
            disabled={locked}
            className="h-7 px-2.5 text-[11px] rounded-[2px] border border-[var(--aws-border)] bg-white text-[var(--aws-link)] hover:border-[var(--aws-navy)] disabled:opacity-50"
          >
            Undo changes
          </button>
        ) : null}
        <button
          type="button"
          onClick={save}
          disabled={!unsaved || locked}
          className="h-7 px-3 text-[11px] rounded-[2px] font-semibold border bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy === "saving" ? "Saving…" : busy === "saved" ? "Saved — refreshing…" : "Save processes"}
        </button>
      </div>
    </div>
  );
}

// A route shown read-only: number, process, floor, SFG and (for job cards) status.
function RouteList({ items }: {
  items: { process: string; floor: string; sfg: string; status: string | null }[];
}) {
  return (
    <ol className="space-y-1">
      {items.map((s, i) => (
        <li
          key={i}
          className={[
            "flex items-start gap-1.5 border rounded px-2 py-1.5 bg-white",
            i === items.length - 1 ? "border-[var(--aws-orange-active)] bg-[#fffaf5]" : "border-[var(--aws-border)]",
          ].join(" ")}
        >
          <span className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full text-white text-[10px] font-bold bg-[var(--aws-navy)]">
            {i + 1}
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-[12px] font-semibold text-[var(--text-primary)] truncate" title={s.process}>
              {s.process || "—"}
            </div>
            <div className="text-[11px] text-[var(--text-secondary)] truncate">
              {s.floor || <span className="text-[var(--aws-error)]">No floor</span>}
              {s.sfg ? <span className="text-[var(--text-muted)]"> · SFG {s.sfg}</span> : null}
            </div>
          </div>
          {i === items.length - 1 ? (
            <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-sm bg-[#fdeee0] text-[#9a5a14] border border-[#f0c79a]">
              Final FG
            </span>
          ) : null}
          {s.status ? (
            <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-sm border border-[var(--aws-border)] text-[var(--text-secondary)] bg-[var(--surface-subtle)]">
              {s.status}
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
