"use client";

// Planning page — replicates
// frontend_replica/src/modules/production/fulfillment/* (the SO Fulfillment
// flow) on the new web stack. Operators see open SO demand grouped by SO,
// filter by entity / customer / SO / article, expand rows for detail,
// inline-edit deadlines, select rows, and create a plan from the selection.
//
// Out of scope this iteration (deferred to follow-ups; types live in
// @/lib/fulfillment so the wires don't have to be re-derived):
//   • BOM override modal (GET/PUT bom-override)
//   • Floor stock modal (GET/PUT floor-stock)
//   • Carryforward action
//   • WebSocket fulfillment.* live updates
//   • System health dot (the dot renders, but it's not polling /health)

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrandMark } from "@/components/BrandMark";
import { useRouter } from "next/navigation";
import { useRequireAuth, useUserInitial, useUserScope, type UserScope } from "@/lib/user";
import { PROCESS_OPTIONS, canonProcess, stageFromProcess } from "@/lib/processCatalog";
import { BackLink } from "@/components/BackLink";
import {
  type FulfillmentRow,
  type FulfillmentFilterOptions,
  type FulfillmentDetail,
  type FulfillmentDetailRow,
  type Pagination,
  listFulfillments,
  fetchFulfillmentFilterOptions,
  syncFulfillmentNow,
  fetchFulfillmentDetail,
  reviseFulfillment,
  createPlan,
  fmtKg,
  fmtUnits,
  fmtDeadline,
  deadlineTone,
} from "@/lib/fulfillment";

const PAGE_SIZE = 50;

type Entity = "" | "cfpl" | "cdpl";

// ── Factory + floor masters ─────────────────────────────────────────────
//
// Hard-coded per business rules (mirrors fulfillment.js:1234-1242). The
// canonical place for these is a backend master in a later iteration; for
// now the values match the Electron client byte-for-byte so plans created
// here look identical downstream.

const FACTORY_TO_WAREHOUSE = { W202: "W-202", A185: "A-185" } as const;
type FactoryCode = keyof typeof FACTORY_TO_WAREHOUSE;

const FLOORS_BY_FACTORY: Record<FactoryCode, readonly string[]> = {
  W202: [
    "Lower Basement", "Upper Basement",
    "First Floor", "First Floor Mezz",
    "Second Floor", "Second Floor Mezz",
    "Terrace",
  ],
  A185: [
    "Roasting Area", "Mezzanine", "Sorting Area", "Printing Area",
    "Dmart Production Area", "Dmart Packing Area",
    "Cheese Floor", "FG store", "FFS Packing Area",
  ],
};

// Intersect the master with the user's scope. Admin or empty scope ⇒ no
// restriction. Mirrors fulfillment.js:1264 / 1271.
function allowedFactoryCodes(scope: UserScope): FactoryCode[] {
  const all = Object.keys(FACTORY_TO_WAREHOUSE) as FactoryCode[];
  if (scope.isAdmin) return all;
  if (!scope.warehouses.length) return all;
  return all.filter((code) => scope.warehouses.includes(FACTORY_TO_WAREHOUSE[code]));
}

function allowedFloorsFor(scope: UserScope, factory: FactoryCode | undefined): string[] {
  if (!factory) return [];
  const base = FLOORS_BY_FACTORY[factory] ?? [];
  if (scope.isAdmin) return [...base];
  if (!scope.floors.length) return [...base];
  return base.filter((fl) => scope.floors.includes(fl));
}

// ── Per-card configuration (Selected Articles panel) ────────────────────

interface PlanStep {
  process_name: string | null;
  stage: string | null;
  floor: string | null;
  std_time_min: number | null;
  loss_pct: number | null;
}

// Operator overrides that flow into the plan body on Create Plan.
// `steps` are seeded from the BOM's process_routes on first expand and can
// be reordered + assigned a floor by the operator.
interface CardOverride {
  qty_kg?: number;
  qty_units?: number;
  deadline_date?: string;        // YYYY-MM-DD
  factory?: FactoryCode;
  steps?: PlanStep[];
  stepsLoaded?: boolean;
  stepsLoading?: boolean;
  bomNote?: string | null;
  bomId?: number | null;
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function PlanningPage() {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);
  const initial = useUserInitial();
  const scope = useUserScope();
  const factoryOpts = useMemo(() => allowedFactoryCodes(scope), [scope]);

  // Filter state
  const [entity, setEntity] = useState<Entity>("");
  const [customer, setCustomer] = useState<string[]>([]);
  const [soNumber, setSoNumber] = useState<string[]>([]);
  const [article, setArticle] = useState<string[]>([]);

  // Data state
  const [rows, setRows] = useState<FulfillmentRow[]>([]);
  const [pagination, setPagination] = useState<Pagination>({});
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Cross-filtered dropdown options
  const [filterOpts, setFilterOpts] = useState<FulfillmentFilterOptions>({});

  // UI state
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  // Per-card overrides for the selected-articles panel: each entry can hold
  // a custom qty_kg, qty_units, and deadline_date that replace the row's
  // defaults when the operator hits Create Plan. Mirrors `cardCfgMap` in
  // frontend_replica/.../fulfillment.js:1228. Factory + steps configuration
  // is intentionally deferred — that's a much larger sub-feature.
  const [cardCfg, setCardCfg] = useState<Map<number, CardOverride>>(new Map());
  // Snapshot of every selected article's row data, keyed by fulfillment_id.
  // Decouples the Selected Articles panel from the LIST view's `rows` —
  // filters that remove an article from the list don't strip the card
  // from the panel, and a re-selection later won't lose any qty / factory
  // / step work the operator did earlier. Populated on selection, dropped
  // on deselection / Clear all / entity change.
  const [selectedRowsCache, setSelectedRowsCache] = useState<Map<number, FulfillmentRow>>(new Map());
  const [expandedCardId, setExpandedCardId] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [creatingPlan, setCreatingPlan] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Stable string fingerprints of array filters so effects don't re-fire on
  // every render-equal-but-reference-different value.
  const customerKey = customer.join("|");
  const soNumberKey = soNumber.join("|");
  const articleKey = article.join("|");

  // ── Load filter options (cross-filtered) ────────────────────────────────
  useEffect(() => {
    if (!authed) return;
    const c = new AbortController();
    void (async () => {
      try {
        const opts = await fetchFulfillmentFilterOptions(
          { entity, customer, so_number: soNumber, article },
          c.signal,
        );
        if (!c.signal.aborted) setFilterOpts(opts);
      } catch { /* ignore — toolbar just shows last good values */ }
    })();
    return () => c.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, entity, customerKey, soNumberKey, articleKey]);

  // ── Load fulfillments ───────────────────────────────────────────────────
  useEffect(() => {
    if (!authed) return;
    const c = new AbortController();
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const resp = await listFulfillments(
          {
            entity,
            customer,
            so_number: soNumber,
            article,
            page,
            page_size: PAGE_SIZE,
          },
          c.signal,
        );
        if (c.signal.aborted) return;
        const incoming = sortByDeadline(resp.results ?? []);
        // Page 1 replaces; subsequent pages append.
        setRows((prev) => (page === 1 ? incoming : sortByDeadline([...prev, ...incoming])));
        setPagination(resp.pagination ?? {});
      } catch (e) {
        if (c.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!c.signal.aborted) setLoading(false);
      }
    })();
    return () => c.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, entity, customerKey, soNumberKey, articleKey, page]);

  // Operator-stated: changing entity must NOT wipe in-flight plan work.
  // The list view re-fetches with the new entity scope automatically
  // (the fetch effect depends on `entity`), but the operator's
  // Selected Articles panel — selectedIds, cardCfg, selectedRowsCache,
  // expandedCardId — stays intact. They can flip CFPL ↔ CDPL while
  // composing a multi-entity plan without losing their qty / factory
  // / step / floor work.
  //
  // Page is reset to 1 because the LIST itself flips to the new
  // entity's fulfillments; that's a list-surface reset only.
  function changeEntity(v: Entity) {
    setEntity(v);
    setPage(1);
    setExpandedId(null);
  }
  const resetForFilterChange = useCallback(() => {
    // Filter change only resets the LIST surface — selected cards in the
    // panel must keep their cached row data + per-card overrides. This is
    // what makes `selectedRowsCache` necessary: server-side filtering
    // removes the underlying `rows` entries for unselected filter values,
    // and without the cache the cards would disappear from the panel.
    setPage(1);
    setExpandedId(null);
  }, []);

  function clearAllFilters() {
    setCustomer([]);
    setSoNumber([]);
    setArticle([]);
    resetForFilterChange();
  }

  const hasMore = useMemo(() => {
    const p = pagination.page ?? 1;
    const tp = pagination.total_pages ?? 1;
    return p < tp;
  }, [pagination]);

  // ── Build SO groups in stable input order ───────────────────────────────
  const groupedDisplay = useMemo(() => buildGroups(rows), [rows]);

  // ── Sync ────────────────────────────────────────────────────────────────
  async function onSync() {
    setSyncing(true);
    setToast(null);
    try {
      const r = await syncFulfillmentNow(entity || undefined);
      const synced = r.synced ?? r.summary?.synced ?? 0;
      setToast(synced ? `Synced ${synced} line${synced === 1 ? "" : "s"}.` : "Sync complete.");
      // Refresh list.
      setPage(1);
      // Trigger a refetch by toggling a dummy — easier: re-set page (no-op when 1)
      // and rely on the existing fetch effect. We can also bump page even if 1
      // is the same; React bails out. Instead, invalidate by clearing rows.
      setRows([]);
    } catch (e) {
      setToast(`Sync failed: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setSyncing(false);
    }
  }

  // ── Inline deadline edit ────────────────────────────────────────────────
  const [editingDeadlineId, setEditingDeadlineId] = useState<number | null>(null);

  async function saveDeadline(id: number, newDate: string) {
    if (!newDate) { setToast("Pick a date first."); return; }
    try {
      await reviseFulfillment(id, { new_date: newDate, reason: "Set by planner" });
      setToast("Deadline updated.");
      setEditingDeadlineId(null);
      // Patch the row locally so we don't refetch the world.
      setRows((prev) => prev.map((r) =>
        r.fulfillment_id === id ? { ...r, delivery_deadline: newDate } : r,
      ));
    } catch (e) {
      setToast(`Revise failed: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }

  // ── Selection / Create plan ─────────────────────────────────────────────
  function toggleSelection(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        // Drop the per-card override, collapse the card if it was expanded,
        // and drop the row from the cache so the panel stops rendering it.
        setCardCfg((m) => {
          if (!m.has(id)) return m;
          const nm = new Map(m);
          nm.delete(id);
          return nm;
        });
        setExpandedCardId((c) => (c === id ? null : c));
        setSelectedRowsCache((m) => {
          if (!m.has(id)) return m;
          const nm = new Map(m);
          nm.delete(id);
          return nm;
        });
      } else {
        next.add(id);
        // Snapshot the row data so the card survives a filter change that
        // removes this article from the list view.
        const row = rows.find((r) => r.fulfillment_id === id);
        if (row) {
          setSelectedRowsCache((m) => {
            const nm = new Map(m);
            nm.set(id, row);
            return nm;
          });
        }
      }
      return next;
    });
  }

  function clearAllSelection() {
    setSelectedIds(new Set());
    setCardCfg(new Map());
    setSelectedRowsCache(new Map());
    setExpandedCardId(null);
  }

  function patchCardOverride(id: number, patch: Partial<CardOverride>) {
    setCardCfg((m) => {
      const nm = new Map(m);
      const cur = nm.get(id) ?? {};
      const merged = { ...cur, ...patch };
      // Drop empty entries so the map stays small.
      const isEmpty =
        merged.qty_kg == null &&
        merged.qty_units == null &&
        (merged.deadline_date == null || merged.deadline_date === "");
      if (isEmpty) nm.delete(id); else nm.set(id, merged);
      return nm;
    });
  }

  function resetCardOverride(id: number) {
    setCardCfg((m) => {
      if (!m.has(id)) return m;
      const nm = new Map(m);
      nm.delete(id);
      return nm;
    });
  }

  // Reorder a card's step list (operator drags / clicks up-down). Both
  // indices are checked against the current array length so a stale UI
  // event can't silently corrupt state.
  function moveCardStep(id: number, fromIdx: number, toIdx: number) {
    setCardCfg((m) => {
      const cur = m.get(id);
      if (!cur?.steps) return m;
      if (
        fromIdx < 0 || fromIdx >= cur.steps.length ||
        toIdx   < 0 || toIdx   >= cur.steps.length ||
        fromIdx === toIdx
      ) return m;
      const next = cur.steps.slice();
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      const nm = new Map(m);
      nm.set(id, { ...cur, steps: next });
      return nm;
    });
  }

  function setCardStepFloor(id: number, idx: number, floor: string | null) {
    setCardCfg((m) => {
      const cur = m.get(id);
      if (!cur?.steps || idx < 0 || idx >= cur.steps.length) return m;
      const next = cur.steps.slice();
      next[idx] = { ...next[idx], floor };
      const nm = new Map(m);
      nm.set(id, { ...cur, steps: next });
      return nm;
    });
  }

  // Append a blank step at the end. The operator picks a process name
  // (or leaves it blank for later), assigns a floor, and optionally
  // edits std_time_min / loss_pct via the existing per-step UI. The
  // step inherits no defaults from the BOM — it's a true add.
  function addCardStep(id: number) {
    setCardCfg((m) => {
      const cur = m.get(id) ?? {};
      const next: PlanStep[] = [
        ...(cur.steps ?? []),
        {
          process_name: null,
          stage: null,
          floor: null,
          std_time_min: null,
          loss_pct: null,
        },
      ];
      const nm = new Map(m);
      nm.set(id, { ...cur, steps: next });
      return nm;
    });
  }

  // Change a single step's process_name. Canon'd through canonProcess()
  // so picking "De-Seeding" out of the dropdown stores it as the
  // canonical "De-seeding". stage auto-derives from the chosen process
  // because job_card_v2.stage is NOT NULL — keeping them in sync here
  // means the downstream JC creation doesn't 500 when a custom-added
  // step makes it to /approve.
  function setCardStepProcess(id: number, idx: number, name: string | null) {
    setCardCfg((m) => {
      const cur = m.get(id);
      if (!cur?.steps || idx < 0 || idx >= cur.steps.length) return m;
      const canoned = canonProcess(name);
      const next = cur.steps.slice();
      next[idx] = {
        ...next[idx],
        process_name: canoned,
        stage: stageFromProcess(canoned),
      };
      const nm = new Map(m);
      nm.set(id, { ...cur, steps: next });
      return nm;
    });
  }

  // Remove a single step from a card. Bounded by 1 so the operator can't
  // accidentally empty the step list — if they really want to start over
  // they can use Refresh which reloads the BOM defaults.
  function removeCardStep(id: number, idx: number) {
    setCardCfg((m) => {
      const cur = m.get(id);
      if (!cur?.steps || idx < 0 || idx >= cur.steps.length) return m;
      if (cur.steps.length <= 1) return m;
      const next = cur.steps.slice();
      next.splice(idx, 1);
      const nm = new Map(m);
      nm.set(id, { ...cur, steps: next });
      return nm;
    });
  }

  // Combine a set of selected step indices into a single step. Mirrors
  // fulfillment.js:1883 mergeSelected:
  //   • process_name  → joined with " + " so the operator can still tell
  //                     which sub-processes rolled up
  //   • stage         → keep the first selected (concat is too noisy)
  //   • floor         → first non-null wins; conflict → null so the
  //                     operator picks deliberately
  //   • std_time_min  → SUM (steps run sequentially after the merge)
  //   • loss_pct      → MAX (summing can overshoot 100% for two lossy steps)
  //
  // The merged step takes the FIRST selected slot; remaining selections are
  // dropped. Returns silently if fewer than 2 valid indices were passed —
  // the toolbar already guards the button state.
  function mergeCardSteps(id: number, idxs: number[]) {
    setCardCfg((m) => {
      const cur = m.get(id);
      if (!cur?.steps) return m;
      const sorted = [...new Set(idxs)].sort((a, b) => a - b);
      const valid = sorted.filter((i) => i >= 0 && i < cur.steps!.length);
      if (valid.length < 2) return m;

      const picked = valid.map((i) => cur.steps![i]);
      const floors = picked.map((s) => s.floor).filter((f): f is string => !!f);
      const uniqueFloors = new Set(floors);
      const mergedFloor = uniqueFloors.size === 1 ? [...uniqueFloors][0] : null;
      const anyTime = picked.some((s) => Number.isFinite(Number(s.std_time_min)));
      const totalTime = anyTime
        ? picked.reduce(
            (acc, s) =>
              acc + (Number.isFinite(Number(s.std_time_min)) ? Number(s.std_time_min) : 0),
            0,
          )
        : null;
      const anyLoss = picked.some((s) => Number.isFinite(Number(s.loss_pct)));
      const maxLoss = anyLoss
        ? picked.reduce(
            (acc, s) =>
              Number.isFinite(Number(s.loss_pct)) ? Math.max(acc, Number(s.loss_pct)) : acc,
            0,
          )
        : null;

      const merged: PlanStep = {
        process_name: picked.map((s) => s.process_name || "—").join(" + "),
        stage: picked[0].stage ?? null,
        floor: mergedFloor,
        std_time_min: totalTime,
        loss_pct: maxLoss,
      };

      const [firstIdx, ...restIdxs] = valid;
      const next = cur.steps.slice();
      // Remove trailing duplicates first (right-to-left so earlier indices
      // remain stable while we splice).
      [...restIdxs].reverse().forEach((i) => next.splice(i, 1));
      next[firstIdx] = merged;

      const nm = new Map(m);
      nm.set(id, { ...cur, steps: next });
      return nm;
    });
  }

  // Changing factory invalidates floors that aren't valid for the new one.
  // Mirrors fulfillment.js:1704 — quietly drop any floor that's no longer
  // in the allowed set rather than surface a confusing toast.
  function setCardFactory(id: number, factory: FactoryCode | undefined) {
    setCardCfg((m) => {
      const cur = m.get(id) ?? {};
      const allowed = factory ? new Set(allowedFloorsFor(scope, factory)) : null;
      let steps = cur.steps;
      if (steps && allowed) {
        steps = steps.map((s) =>
          s.floor && !allowed.has(s.floor) ? { ...s, floor: null } : s,
        );
      } else if (steps && factory === undefined) {
        // Factory cleared → no floors are valid until a factory is picked.
        steps = steps.map((s) => (s.floor ? { ...s, floor: null } : s));
      }
      const nm = new Map(m);
      nm.set(id, { ...cur, factory, steps });
      return nm;
    });
  }

  // Fetch the BOM's process_routes ONCE per card and snapshot them as
  // editable PlanSteps. Cached via stepsLoaded so re-expanding the card
  // doesn't re-fetch. Mirrors fulfillment.js:1736 ensureStepsLoaded().
  //
  // `force=true` is the refresh path: clears the existing steps + loaded
  // flags FIRST so the fetch always runs. Used by the per-card refresh
  // button when the operator wants to undo a step-removal by reloading
  // the BOM defaults. Floor / time / loss assignments on the affected
  // card are lost (that's the point of refresh); other cards keep their
  // state because each card's cfg is independent.
  async function ensureStepsLoaded(id: number, force = false) {
    const cur = cardCfg.get(id);
    if (!force && (cur?.stepsLoaded || cur?.stepsLoading)) return;
    setCardCfg((m) => {
      const nm = new Map(m);
      const prev = m.get(id) ?? {};
      nm.set(id, {
        ...prev,
        stepsLoading: true,
        ...(force ? { steps: undefined, stepsLoaded: false, bomNote: null } : {}),
      });
      return nm;
    });
    try {
      const data = await fetchFulfillmentDetail(id);
      const routes = data.bom?.process_routes ?? [];
      const sorted = [...routes].sort(
        (a, b) => (a.step_number ?? 0) - (b.step_number ?? 0),
      );
      const steps: PlanStep[] = sorted.map((r) => ({
        process_name: r.process_name ?? null,
        stage: r.stage ?? null,
        floor: null,
        std_time_min: r.std_time_min ?? null,
        loss_pct: r.loss_pct ?? null,
      }));
      setCardCfg((m) => {
        const nm = new Map(m);
        const prev = m.get(id) ?? {};
        nm.set(id, {
          ...prev,
          steps,
          stepsLoaded: true,
          stepsLoading: false,
          bomNote: data.bom?.bom_note ?? null,
          bomId: data.bom?.bom_id ?? null,
        });
        return nm;
      });
    } catch (e) {
      setCardCfg((m) => {
        const nm = new Map(m);
        const prev = m.get(id) ?? {};
        nm.set(id, {
          ...prev,
          steps: [],
          stepsLoaded: true,
          stepsLoading: false,
          bomNote: `Failed to load BOM: ${e instanceof Error ? e.message : "unknown"}`,
        });
        return nm;
      });
    }
  }

  // Reload a single card's steps from the BOM, leaving every other card's
  // state alone. Used by the per-card refresh button when the operator
  // wants to recover after removing a step by mistake.
  function refreshCardSteps(id: number) {
    void ensureStepsLoaded(id, true);
  }

  async function onCreatePlan() {
    if (selectedIds.size === 0) {
      setToast("Select at least one article.");
      return;
    }
    // Server's PlanV2Create requires `entity` as a non-null scalar — the
    // "All" entity selector can't create plans because a plan is scoped to
    // one entity (CFPL or CDPL). Tell the operator explicitly.
    if (!entity) {
      setToast("Pick an entity (CFPL or CDPL) before creating a plan.");
      return;
    }
    // Factory consistency: every selected card must have a factory set, and
    // all of them must agree (a plan is scoped to one warehouse). Mirrors
    // fulfillment.js:1976-1993.
    const selectedRows = rows.filter((r) => selectedIds.has(r.fulfillment_id));
    const factories = new Set<FactoryCode>();
    let missingFactory = 0;
    for (const r of selectedRows) {
      const f = cardCfg.get(r.fulfillment_id)?.factory;
      if (!f) missingFactory += 1; else factories.add(f);
    }
    if (missingFactory > 0) {
      setToast(`Pick a factory for ${missingFactory} card${missingFactory === 1 ? "" : "s"} before creating the plan.`);
      return;
    }
    if (factories.size > 1) {
      setToast(`All selected articles must use the same factory (got: ${[...factories].join(", ")}).`);
      return;
    }
    const chosenFactory = [...factories][0];
    const warehouse = FACTORY_TO_WAREHOUSE[chosenFactory];

    // Client-side qty validation — saves a 400 round-trip and points at
    // the offending SKU. Mirrors the same check at fulfillment.js:2003.
    const validationErrs: string[] = [];
    for (const r of selectedRows) {
      const cfg = cardCfg.get(r.fulfillment_id) ?? {};
      const pendKg = toNum(r.pending_qty_kg);
      const pendUnits = r.pending_qty_units != null ? toNum(r.pending_qty_units) : null;
      const reqKg = cfg.qty_kg != null && cfg.qty_kg > 0 ? cfg.qty_kg : pendKg;
      const reqUnits = cfg.qty_units != null && cfg.qty_units > 0 ? cfg.qty_units : (pendUnits ?? 0);
      if (reqKg <= 0) {
        validationErrs.push(`${r.fg_sku_name}: qty must be > 0 (pending is ${fmtKg(pendKg)} kg)`);
        continue;
      }
      if (reqKg > pendKg + 0.001) {
        validationErrs.push(`${r.fg_sku_name}: requested ${fmtKg(reqKg)} kg > pending ${fmtKg(pendKg)} kg`);
      } else if (pendUnits != null && reqUnits > pendUnits + 0.001) {
        validationErrs.push(`${r.fg_sku_name}: requested ${fmtUnits(reqUnits)} pcs > pending ${fmtUnits(pendUnits)} pcs`);
      }
    }
    if (validationErrs.length) {
      setToast(
        `${validationErrs[0]}${validationErrs.length > 1 ? ` (+${validationErrs.length - 1} more)` : ""}`,
      );
      return;
    }

    setCreatingPlan(true);
    setToast(null);
    try {
      // Use the operator's LOCAL date for plan_date — toISOString() returns
      // UTC, which silently rolls over to tomorrow's date when an IST
      // operator hits Create after ~18:30 UTC (= 00:00 IST). Building the
      // YYYY-MM-DD string from local Date getters avoids the cross-midnight
      // off-by-one without pulling in a date library.
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const lines = selectedRows.map((r) => {
        const cfg = cardCfg.get(r.fulfillment_id) ?? {};
        const defaultKg = toNum(r.pending_qty_kg);
        const defaultUnits = toNum(r.pending_qty_units);
        const qtyKg = cfg.qty_kg != null && cfg.qty_kg > 0 ? cfg.qty_kg : defaultKg;
        const qtyUnitsRaw = cfg.qty_units != null && cfg.qty_units > 0
          ? cfg.qty_units
          : defaultUnits;
        const deadline = cfg.deadline_date && cfg.deadline_date !== ""
          ? cfg.deadline_date
          : (r.delivery_deadline ? String(r.delivery_deadline).slice(0, 10) : null);

        // Steps the operator configured. Only forward when at least one
        // step has a floor — otherwise the server snapshots from
        // bom_process_route on its own, which is the cleaner default.
        const userSteps = cfg.steps?.filter(Boolean) ?? [];
        const anyFloored = userSteps.some((s) => !!s.floor);
        const stepsPayload = anyFloored
          ? userSteps.map((s) => ({
              process_name: s.process_name,
              stage: s.stage,
              floor: s.floor || null,
              std_time_min: s.std_time_min,
              loss_pct: s.loss_pct,
            }))
          : undefined;
        // Surface the first floored step's floor on the line-level `area`
        // column so non-step-aware readers see something useful.
        const firstFloored = userSteps.find((s) => !!s.floor);

        return {
          fg_sku_name: r.fg_sku_name ?? "",
          customer_name: r.customer_name ?? null,
          planned_qty_kg: qtyKg,
          planned_qty_units: qtyUnitsRaw > 0 ? Math.round(qtyUnitsRaw) : Math.max(1, Math.round(qtyKg)),
          linked_so_fulfillment_ids: [r.fulfillment_id],
          deadline_date: deadline ?? undefined,
          ...(stepsPayload ? { steps: stepsPayload } : {}),
          ...(firstFloored?.floor ? { area: firstFloored.floor } : {}),
        };
      });
      // Plan window: date_to is the latest per-line deadline (or today if
      // none exist). Backend's CHECK enforces date_to >= date_from.
      const deadlines = lines
        .map((l) => l.deadline_date)
        .filter((d): d is string => !!d)
        .sort();
      const latest = deadlines.length ? deadlines[deadlines.length - 1] : today;
      const dateTo = latest >= today ? latest : today;
      // `lines` is typed structurally above; CreatePlanLine accepts the
      // optional `steps` + `area` we may have attached. Casting through
      // CreatePlanBody keeps the per-line union honest.
      const resp = await createPlan({
        entity,
        warehouse,
        plan_type: "daily",
        plan_date: today,
        date_from: today,
        date_to: dateTo,
        lines,
      });
      setToast(resp.plan_id ? `Plan ${resp.plan_id} created.` : "Plan created.");
      clearAllSelection();
    } catch (e) {
      setToast(`Create plan failed: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setCreatingPlan(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <PageHeader initial={initial} router={router} />

      <main
        className={[
          "flex-1 max-w-[1400px] w-full mx-auto px-4 sm:px-6 py-6",
          // When the mobile sticky CTA is visible (selection present), pad
          // the bottom so the last card isn't hidden under the bar.
          selectedIds.size > 0 ? "pb-24 md:pb-6" : "",
        ].join(" ")}
      >
        <div className="mb-3">
          <BackLink parentHref="/modules/production" label="production" />
        </div>

        {/* Compact header — title + actions on a single row at md+, the
            descriptive subtitle drops to the second row only on desktop.
            Eyebrow chip + verbose subtitle removed to tighten the page
            entry; the breadcrumb already says "Modules / Production /
            Planning". */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-baseline gap-3 min-w-0">
            <h1 className="text-[20px] leading-[24px] font-semibold text-[var(--text-primary)] flex items-center gap-2">
              Planning
              <span
                className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--text-success)]"
                title="System health (not polling /health yet)"
              />
            </h1>
            <p className="hidden lg:inline text-[12px] text-[var(--text-muted)] truncate">
              Open demand by entity · set deadlines · build plans.
            </p>
          </div>
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <EntitySelector value={entity} onChange={changeEntity} />
            <button
              onClick={onSync}
              disabled={syncing}
              className="h-8 px-2.5 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] flex items-center gap-1.5 disabled:opacity-50"
              title="Sync fulfillment data from SAP"
            >
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2}>
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
              <span className="hidden sm:inline">{syncing ? "Syncing…" : "Sync"}</span>
            </button>
            <button
              onClick={onCreatePlan}
              disabled={creatingPlan || selectedIds.size === 0}
              className="hidden md:inline-flex h-8 px-3 text-[12px] rounded-[2px] font-semibold border bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white disabled:opacity-50 disabled:cursor-not-allowed items-center gap-1.5"
            >
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2}>
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              {creatingPlan
                ? "Creating…"
                : selectedIds.size > 0
                  ? `Create Plan · ${selectedIds.size}`
                  : "Create Plan"}
            </button>
          </div>
        </div>

        <FilterToolbar
          customer={customer}
          soNumber={soNumber}
          article={article}
          options={filterOpts}
          onCustomerChange={(v) => { setCustomer(v); resetForFilterChange(); }}
          onSoNumberChange={(v) => { setSoNumber(v); resetForFilterChange(); }}
          onArticleChange={(v) => { setArticle(v); resetForFilterChange(); }}
          onClearAll={clearAllFilters}
        />

        <SelectedArticlesPanel
          selectedIds={selectedIds}
          rowsCache={selectedRowsCache}
          cardCfg={cardCfg}
          expandedCardId={expandedCardId}
          scope={scope}
          factoryOpts={factoryOpts}
          onToggleExpand={(id) => {
            setExpandedCardId((c) => (c === id ? null : id));
            // Fire-and-forget; the function early-returns if the BOM is
            // already loaded or in flight. Idempotent on repeat expand.
            void ensureStepsLoaded(id);
          }}
          onPatch={patchCardOverride}
          onReset={resetCardOverride}
          onRemove={(id) => toggleSelection(id)}
          onClearAll={clearAllSelection}
          onSetFactory={setCardFactory}
          onSetStepFloor={setCardStepFloor}
          onSetStepProcess={setCardStepProcess}
          onMoveStep={moveCardStep}
          onMergeSteps={mergeCardSteps}
          onAddStep={addCardStep}
          onRemoveStep={removeCardStep}
          onRefreshSteps={refreshCardSteps}
        />

        {toast ? (
          <div className="mb-3 px-3 py-2 rounded-sm border border-[var(--aws-border)] bg-[#f1faff] text-[12px] text-[var(--text-primary)] flex items-center justify-between gap-2">
            <span>{toast}</span>
            <button onClick={() => setToast(null)} className="text-[var(--aws-link)] hover:underline">Dismiss</button>
          </div>
        ) : null}

        {loading && rows.length === 0 ? (
          <Centered>Loading fulfillment…</Centered>
        ) : error ? (
          <Centered tone="error">{error}</Centered>
        ) : groupedDisplay.length === 0 ? (
          <Centered>No fulfillment records match your filters.</Centered>
        ) : (
          <FulfillmentTable
            groups={groupedDisplay}
            openGroups={openGroups}
            onToggleGroup={(soNum) => {
              setOpenGroups((prev) => {
                const next = new Set(prev);
                if (next.has(soNum)) next.delete(soNum); else next.add(soNum);
                return next;
              });
            }}
            expandedId={expandedId}
            onExpand={(id) => setExpandedId((prev) => (prev === id ? null : id))}
            selectedIds={selectedIds}
            onToggleSelection={toggleSelection}
            editingDeadlineId={editingDeadlineId}
            onStartEditDeadline={(id) => setEditingDeadlineId(id)}
            onCancelEditDeadline={() => setEditingDeadlineId(null)}
            onSaveDeadline={saveDeadline}
          />
        )}

        {hasMore ? (
          <div className="text-center py-4">
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={loading}
              className="h-8 px-4 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] disabled:opacity-50"
            >
              {loading ? "Loading…" : "Load more"}
            </button>
          </div>
        ) : null}
      </main>

      {/* Mobile sticky CTA — fixed at viewport bottom when at least one
          article is checked. Reuses onCreatePlan so it picks up factory +
          steps validation just like the desktop header button. */}
      {selectedIds.size > 0 ? (
        <div className="md:hidden fixed bottom-0 left-0 right-0 z-20 bg-white border-t border-[var(--aws-border)] shadow-[0_-2px_8px_rgba(0,28,36,0.12)] px-4 py-3 flex items-center gap-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold text-[var(--text-primary)] truncate">
              {selectedIds.size} article{selectedIds.size === 1 ? "" : "s"} selected
            </div>
            <div className="text-[11px] text-[var(--text-muted)] truncate">
              {entity ? `Entity: ${entity.toUpperCase()}` : "Pick an entity to plan"}
            </div>
          </div>
          <button
            onClick={onCreatePlan}
            disabled={creatingPlan}
            className="h-10 px-5 text-[13px] rounded-[2px] font-semibold border bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={2}>
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            {creatingPlan ? "Creating…" : "Create Plan"}
          </button>
        </div>
      ) : null}

      <Footer />
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function toNum(v: number | string | null | undefined): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function sortByDeadline(rs: FulfillmentRow[]): FulfillmentRow[] {
  return [...rs].sort((a, b) => {
    const aD = a.delivery_deadline;
    const bD = b.delivery_deadline;
    if (!aD && !bD) return 0;
    if (!aD) return 1;
    if (!bD) return -1;
    return new Date(aD).getTime() - new Date(bD).getTime();
  });
}

interface SoGroup {
  // null = "loose" row (no SO grouping)
  soNumber: string | null;
  rows: FulfillmentRow[];
}

function buildGroups(rs: FulfillmentRow[]): SoGroup[] {
  const seen = new Set<string>();
  const groups: SoGroup[] = [];
  for (const r of rs) {
    const so = r.so_number && r.so_number !== "--" ? r.so_number : null;
    if (!so) { groups.push({ soNumber: null, rows: [r] }); continue; }
    if (seen.has(so)) continue;
    seen.add(so);
    groups.push({ soNumber: so, rows: rs.filter((x) => x.so_number === so) });
  }
  return groups;
}

// ── Chrome ───────────────────────────────────────────────────────────────

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
        <span className="text-white">Planning</span>
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

// ── Entity selector (segmented control) ─────────────────────────────────

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

// ── Filter toolbar ───────────────────────────────────────────────────────

function FilterToolbar({
  customer, soNumber, article, options,
  onCustomerChange, onSoNumberChange, onArticleChange, onClearAll,
}: {
  customer: string[]; soNumber: string[]; article: string[];
  options: FulfillmentFilterOptions;
  onCustomerChange: (v: string[]) => void;
  onSoNumberChange: (v: string[]) => void;
  onArticleChange: (v: string[]) => void;
  onClearAll: () => void;
}) {
  const anyActive = customer.length + soNumber.length + article.length > 0;
  const activeCount = customer.length + soNumber.length + article.length;
  return (
    <div className="border-b border-[var(--aws-border)] mb-3 pb-3 flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)] mr-1 hidden sm:inline">
        Filter
      </span>
      <MultiSelect
        triggerLabel="All Customers"
        selectedLabel="customer"
        selectedLabelPlural="customers"
        options={options.customers ?? []}
        value={customer}
        onChange={onCustomerChange}
        placeholder="Search customer…"
      />
      <MultiSelect
        triggerLabel="All SOs"
        selectedLabel="SO"
        selectedLabelPlural="SOs"
        options={options.so_numbers ?? []}
        value={soNumber}
        onChange={onSoNumberChange}
        placeholder="Search SO number…"
      />
      <MultiSelect
        triggerLabel="All Articles"
        selectedLabel="article"
        selectedLabelPlural="articles"
        options={options.articles ?? []}
        value={article}
        onChange={onArticleChange}
        placeholder="Search article…"
      />
      {anyActive ? (
        <button
          onClick={onClearAll}
          className="h-7 px-2.5 text-[11px] rounded-full border border-[var(--aws-border)] text-[var(--aws-error)] bg-white hover:bg-[#fdf3f1] hover:border-[var(--aws-error)] flex items-center gap-1"
          title={`${activeCount} active filter${activeCount === 1 ? "" : "s"}`}
        >
          <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
          Clear
        </button>
      ) : null}
    </div>
  );
}

function MultiSelect({
  triggerLabel, selectedLabel, selectedLabelPlural,
  options, value, onChange, placeholder,
}: {
  triggerLabel: string;
  selectedLabel: string;
  selectedLabelPlural: string;
  options: string[];
  value: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const visible = useMemo(() => {
    const lc = q.trim().toLowerCase();
    if (!lc) return options;
    return options.filter((o) => o.toLowerCase().includes(lc));
  }, [q, options]);

  function toggle(v: string) {
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  }

  const label = value.length === 0
    ? triggerLabel
    : value.length === 1
      ? value[0]
      : `${value.length} ${selectedLabelPlural}`;

  // Reuse selectedLabel singular when count is exactly one — avoids the
  // awkward "1 customers" plural fallback.
  const renderedLabel = value.length === 1 ? `1 ${selectedLabel}` : label;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={[
          "h-7 px-2.5 text-[12px] rounded-[2px] flex items-center gap-1.5 border transition-colors",
          value.length > 0
            ? "bg-[#eaf3ff] border-[#bbd9f3] text-[var(--aws-link)] hover:border-[var(--aws-navy)]"
            : "bg-white border-[var(--aws-border)] text-[var(--text-primary)] hover:border-[var(--aws-navy)]",
        ].join(" ")}
      >
        <span>{value.length === 0 ? triggerLabel : renderedLabel}</span>
        {value.length > 0 ? (
          <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 text-[10px] rounded-full bg-[var(--aws-navy)] text-white font-bold">
            {value.length}
          </span>
        ) : null}
        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open ? (
        <div className="absolute z-10 mt-1 w-[260px] max-w-[calc(100vw-1rem)] bg-white border border-[var(--aws-border)] rounded-md shadow-[0_4px_12px_rgba(0,28,36,0.18)] p-2">
          <input
            autoFocus
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={placeholder}
            className="w-full h-8 px-2 mb-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
          />
          <div className="max-h-[280px] overflow-y-auto">
            {visible.length === 0 ? (
              <p className="text-[12px] text-[var(--text-muted)] italic p-2">No matches.</p>
            ) : visible.map((opt) => {
              const checked = value.includes(opt);
              return (
                <label
                  key={opt}
                  className="flex items-center gap-2 px-2 py-1.5 text-[13px] hover:bg-[#f4f4f4] rounded-sm cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(opt)}
                    className="accent-[var(--aws-orange)]"
                  />
                  <span className="truncate" title={opt}>{opt}</span>
                </label>
              );
            })}
          </div>
          {value.length > 0 ? (
            <button
              type="button"
              onClick={() => onChange([])}
              className="w-full mt-1 px-2 py-1 text-[12px] text-[var(--aws-link)] hover:underline text-left"
            >
              Clear selection
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ── Table ────────────────────────────────────────────────────────────────

function FulfillmentTable({
  groups, openGroups, onToggleGroup,
  expandedId, onExpand,
  selectedIds, onToggleSelection,
  editingDeadlineId, onStartEditDeadline, onCancelEditDeadline, onSaveDeadline,
}: {
  groups: SoGroup[];
  openGroups: Set<string>;
  onToggleGroup: (soNum: string) => void;
  expandedId: number | null;
  onExpand: (id: number) => void;
  selectedIds: Set<number>;
  onToggleSelection: (id: number) => void;
  editingDeadlineId: number | null;
  onStartEditDeadline: (id: number) => void;
  onCancelEditDeadline: () => void;
  onSaveDeadline: (id: number, newDate: string) => void;
}) {
  return (
    <>
      {/* Mobile (< md): stacked cards. The desktop table has nine columns of
          fixed-width content; on phones we render each row as a card and
          collapse the SO group into a header card with expandable children.
          Both layouts share the same expandedId / selectedIds state, so
          interactions are continuous across viewport breakpoints. */}
      <div className="md:hidden space-y-2 mb-4">
        {groups.map((g, gi) => {
          if (g.soNumber == null) {
            const r = g.rows[0];
            return (
              <MobileDataCard
                key={`ml-${r.fulfillment_id}-${gi}`}
                row={r}
                inGroup={false}
                expanded={expandedId === r.fulfillment_id}
                onExpand={() => onExpand(r.fulfillment_id)}
                selected={selectedIds.has(r.fulfillment_id)}
                onToggleSelection={() => onToggleSelection(r.fulfillment_id)}
                editing={editingDeadlineId === r.fulfillment_id}
                onStartEditDeadline={() => onStartEditDeadline(r.fulfillment_id)}
                onCancelEditDeadline={onCancelEditDeadline}
                onSaveDeadline={onSaveDeadline}
              />
            );
          }
          return (
            <MobileGroupCard
              key={`mg-${g.soNumber}`}
              group={g}
              isOpen={openGroups.has(g.soNumber)}
              onToggleGroup={() => onToggleGroup(g.soNumber as string)}
              expandedId={expandedId}
              onExpand={onExpand}
              selectedIds={selectedIds}
              onToggleSelection={onToggleSelection}
              editingDeadlineId={editingDeadlineId}
              onStartEditDeadline={onStartEditDeadline}
              onCancelEditDeadline={onCancelEditDeadline}
              onSaveDeadline={onSaveDeadline}
            />
          );
        })}
      </div>

      {/* md+ desktop table */}
      <div className="hidden md:block bg-white border border-[var(--aws-border)] rounded-md overflow-hidden mb-4">
      <div className="overflow-x-auto">
        <table className="w-full text-[12px] border-collapse">
          <thead className="bg-[var(--surface-subtle)] text-[var(--text-primary)]">
            <tr className="border-b border-[var(--aws-border)]">
              <th className="px-2 py-1.5 w-[28px]" />
              <th className="px-1 py-1.5 w-[20px]" />
              <th className="px-2.5 py-1.5 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)]">Customer</th>
              <th className="px-2.5 py-1.5 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)]">SO</th>
              <th className="px-2.5 py-1.5 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)]">FG SKU</th>
              <th className="px-2.5 py-1.5 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)]">Pending</th>
              <th className="px-2.5 py-1.5 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)]">Deadline</th>
              <th className="px-2.5 py-1.5 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)]">Status</th>
              <th className="px-2.5 py-1.5 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)]" />
            </tr>
          </thead>
          <tbody>
            {groups.map((g, gi) => {
              if (g.soNumber == null) {
                // Loose (ungrouped) row.
                const r = g.rows[0];
                return (
                  <DataRowBlock
                    key={`l-${r.fulfillment_id}-${gi}`}
                    row={r}
                    inGroup={false}
                    expanded={expandedId === r.fulfillment_id}
                    onExpand={() => onExpand(r.fulfillment_id)}
                    selected={selectedIds.has(r.fulfillment_id)}
                    onToggleSelection={() => onToggleSelection(r.fulfillment_id)}
                    editing={editingDeadlineId === r.fulfillment_id}
                    onStartEditDeadline={() => onStartEditDeadline(r.fulfillment_id)}
                    onCancelEditDeadline={onCancelEditDeadline}
                    onSaveDeadline={onSaveDeadline}
                  />
                );
              }
              const isOpen = openGroups.has(g.soNumber);
              return (
                <GroupBlock
                  key={g.soNumber}
                  group={g}
                  isOpen={isOpen}
                  onToggleGroup={() => onToggleGroup(g.soNumber as string)}
                  expandedId={expandedId}
                  onExpand={onExpand}
                  selectedIds={selectedIds}
                  onToggleSelection={onToggleSelection}
                  editingDeadlineId={editingDeadlineId}
                  onStartEditDeadline={onStartEditDeadline}
                  onCancelEditDeadline={onCancelEditDeadline}
                  onSaveDeadline={onSaveDeadline}
                />
              );
            })}
          </tbody>
        </table>
      </div>
      </div>
    </>
  );
}

// ── Selected articles panel ──────────────────────────────────────────────
//
// Sits between the filter toolbar and the table when there's at least one
// row checked. Each selected article gets a compact card; tapping a card
// expands its qty / deadline editor. Edits flow back through the parent's
// cardCfg map and are read by onCreatePlan when the operator hits Create
// Plan in the header.
//
// Responsive layout — single column on phones, 2 cols at sm, 3 at lg. The
// expanded card spans the full row width via grid `col-span-full` so the
// form has room to breathe without forcing the others narrower.

function SelectedArticlesPanel({
  selectedIds, rowsCache, cardCfg, expandedCardId, scope, factoryOpts,
  onToggleExpand, onPatch, onReset, onRemove, onClearAll,
  onSetFactory, onSetStepFloor, onSetStepProcess, onMoveStep, onMergeSteps,
  onAddStep,
  onRemoveStep, onRefreshSteps,
}: {
  selectedIds: Set<number>;
  rowsCache: Map<number, FulfillmentRow>;
  cardCfg: Map<number, CardOverride>;
  expandedCardId: number | null;
  scope: UserScope;
  factoryOpts: FactoryCode[];
  onToggleExpand: (id: number) => void;
  onPatch: (id: number, patch: Partial<CardOverride>) => void;
  onReset: (id: number) => void;
  onRemove: (id: number) => void;
  onClearAll: () => void;
  onSetFactory: (id: number, factory: FactoryCode | undefined) => void;
  onSetStepFloor: (id: number, idx: number, floor: string | null) => void;
  onSetStepProcess: (id: number, idx: number, name: string | null) => void;
  onMoveStep: (id: number, from: number, to: number) => void;
  onMergeSteps: (id: number, idxs: number[]) => void;
  onAddStep: (id: number) => void;
  onRemoveStep: (id: number, idx: number) => void;
  onRefreshSteps: (id: number) => void;
}) {
  // Cards rendered in selection order via the snapshot cache so a filter
  // change that removes an article from the LIST below doesn't strip the
  // card from the panel. Set insertion order is preserved across ES2015+.
  const ids = Array.from(selectedIds);
  const selectedRows = ids
    .map((id) => rowsCache.get(id))
    .filter((r): r is FulfillmentRow => !!r);

  if (selectedRows.length === 0) return null;

  return (
    <section className="mb-3" aria-label="Selected articles">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-sm bg-[var(--aws-orange)] text-white text-[10px] font-bold shrink-0">
            {selectedIds.size}
          </span>
          <span className="text-[11px] uppercase tracking-wide font-bold text-[var(--text-secondary)]">
            Selected for plan
          </span>
          <span className="text-[11px] text-[var(--text-muted)] hidden md:inline truncate">
            · tap a card to customise qty, deadline, factory, or floor
          </span>
        </div>
        <button
          type="button"
          onClick={onClearAll}
          className="h-7 px-2.5 text-[11px] rounded-full border border-[var(--aws-border)] text-[var(--text-secondary)] bg-white hover:border-[var(--aws-error)] hover:text-[var(--aws-error)]"
        >
          Clear
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
        {selectedRows.map((r) => (
          <SelectedCard
            key={r.fulfillment_id}
            row={r}
            cfg={cardCfg.get(r.fulfillment_id) ?? {}}
            isExpanded={expandedCardId === r.fulfillment_id}
            scope={scope}
            factoryOpts={factoryOpts}
            onToggleExpand={() => onToggleExpand(r.fulfillment_id)}
            onPatch={(patch) => onPatch(r.fulfillment_id, patch)}
            onReset={() => onReset(r.fulfillment_id)}
            onRemove={() => onRemove(r.fulfillment_id)}
            onSetFactory={(f) => onSetFactory(r.fulfillment_id, f)}
            onSetStepFloor={(idx, floor) => onSetStepFloor(r.fulfillment_id, idx, floor)}
            onSetStepProcess={(idx, name) => onSetStepProcess(r.fulfillment_id, idx, name)}
            onMoveStep={(from, to) => onMoveStep(r.fulfillment_id, from, to)}
            onMergeSteps={(idxs) => onMergeSteps(r.fulfillment_id, idxs)}
            onAddStep={() => onAddStep(r.fulfillment_id)}
            onRemoveStep={(idx) => onRemoveStep(r.fulfillment_id, idx)}
            onRefreshSteps={() => onRefreshSteps(r.fulfillment_id)}
          />
        ))}
      </div>
    </section>
  );
}

function SelectedCard({
  row, cfg, isExpanded, scope, factoryOpts,
  onToggleExpand, onPatch, onReset, onRemove,
  onSetFactory, onSetStepFloor, onSetStepProcess, onMoveStep, onMergeSteps,
  onAddStep, onRemoveStep, onRefreshSteps,
}: {
  row: FulfillmentRow;
  cfg: CardOverride;
  isExpanded: boolean;
  scope: UserScope;
  factoryOpts: FactoryCode[];
  onToggleExpand: () => void;
  onPatch: (patch: Partial<CardOverride>) => void;
  onReset: () => void;
  onRemove: () => void;
  onSetFactory: (factory: FactoryCode | undefined) => void;
  onSetStepFloor: (idx: number, floor: string | null) => void;
  onSetStepProcess: (idx: number, name: string | null) => void;
  onMoveStep: (from: number, to: number) => void;
  onMergeSteps: (idxs: number[]) => void;
  onAddStep: () => void;
  onRemoveStep: (idx: number) => void;
  onRefreshSteps: () => void;
}) {
  const defaultKg = toNum(row.pending_qty_kg);
  const defaultUnits = toNum(row.pending_qty_units);
  const defaultDeadline = row.delivery_deadline ? String(row.delivery_deadline).slice(0, 10) : "";

  const qtyKg = cfg.qty_kg ?? defaultKg;
  const qtyUnits = cfg.qty_units ?? defaultUnits;
  const deadline = cfg.deadline_date ?? defaultDeadline;
  const factory = cfg.factory;
  const steps = cfg.steps ?? [];
  const allowedFloors = useMemo(() => allowedFloorsFor(scope, factory), [scope, factory]);
  const flooredCount = steps.filter((s) => !!s.floor).length;

  // Per-unit kg derived from the SO line's own pending qtys — this is
  // the same ratio that ultimately lives in all_sku.uom for the
  // canonical SKU, so using it here keeps qty (pcs) and qty (kg) on
  // the planning card linked the same way R2 specifies.
  //
  // Operator typing into pcs → kg auto-computes; typing kg → pcs
  // auto-computes. Either field still accepts a direct manual value
  // (operator can override the link by editing the other field
  // immediately after).
  const skuUomKg: number | null =
    defaultUnits > 0 && defaultKg > 0
      ? defaultKg / defaultUnits
      : null;

  function patchQtyUnits(n: number | undefined) {
    if (n == null || !Number.isFinite(n)) {
      onPatch({ qty_units: undefined, qty_kg: undefined });
      return;
    }
    if (skuUomKg != null) {
      onPatch({ qty_units: n, qty_kg: Number((n * skuUomKg).toFixed(3)) });
    } else {
      onPatch({ qty_units: n });
    }
  }
  function patchQtyKg(n: number | undefined) {
    if (n == null || !Number.isFinite(n)) {
      onPatch({ qty_kg: undefined, qty_units: undefined });
      return;
    }
    if (skuUomKg != null && skuUomKg > 0) {
      onPatch({ qty_kg: n, qty_units: Math.round(n / skuUomKg) });
    } else {
      onPatch({ qty_kg: n });
    }
  }

  const customised =
    cfg.qty_kg != null || cfg.qty_units != null ||
    (cfg.deadline_date != null && cfg.deadline_date !== "") ||
    cfg.factory != null ||
    flooredCount > 0;

  const sku = row.fg_sku_name || "—";

  return (
    <div
      className={[
        "relative bg-white border rounded-md transition-colors",
        // Left accent strip when customised — quieter than the full crimson border.
        customised && !isExpanded
          ? "border-[var(--aws-border)] border-l-[3px] border-l-[var(--aws-orange)]"
          : isExpanded
            ? "border-[var(--aws-orange)] shadow-[0_2px_8px_rgba(154,57,62,0.08)] sm:col-span-2 lg:col-span-3"
            : "border-[var(--aws-border)] hover:border-[var(--aws-navy)]",
      ].join(" ")}
    >
      {/* ── Compact header row ─────────────────────────────────────── */}
      <div className="flex items-center gap-1.5 p-2">
        <button
          type="button"
          onClick={onToggleExpand}
          aria-expanded={isExpanded}
          aria-label={isExpanded ? "Collapse" : "Expand"}
          className="shrink-0 inline-flex items-center justify-center w-6 h-6 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-subtle)] rounded-sm"
        >
          <svg
            viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2}
            style={{ transform: isExpanded ? "rotate(90deg)" : "none", transition: "transform .15s" }}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onToggleExpand}
          className="flex-1 min-w-0 text-left"
        >
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted)] truncate">
            <span className="truncate" title={row.customer_name ?? ""}>{row.customer_name || "—"}</span>
            {row.so_number ? (
              <>
                <span className="opacity-50">·</span>
                <span className="font-mono normal-case tracking-normal text-[var(--aws-link)]">{row.so_number}</span>
              </>
            ) : null}
          </div>
          <div className="text-[13px] font-semibold text-[var(--text-primary)] truncate leading-tight" title={sku}>
            {sku}
          </div>
          <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5 mt-1 text-[11px]">
            <span className="font-semibold text-[var(--text-primary)]">
              {fmtKg(qtyKg)} kg
            </span>
            {qtyUnits > 0 ? (
              <span className="text-[var(--text-muted)]">{fmtUnits(qtyUnits)} pcs</span>
            ) : null}
            {deadline ? (
              <span className={[
                "px-1.5 py-0 rounded-sm border font-medium",
                deadlineTone(deadline) === "overdue" ? "text-[#b1361e] bg-[#fdf3f1] border-[#f0c7be]"
                : deadlineTone(deadline) === "soon"    ? "text-[#9a393e] bg-[#fbeced] border-[#e6bcbe]"
                                                       : "text-[var(--text-secondary)] bg-white border-[var(--aws-border)]",
              ].join(" ")}>
                {fmtDeadline(deadline)}
              </span>
            ) : null}
            {factory ? (
              <span className="px-1.5 py-0 rounded-sm border border-[#bbd9f3] bg-[#eaf3ff] text-[var(--aws-link)] font-semibold">
                {factory}
              </span>
            ) : null}
            {cfg.stepsLoaded && steps.length > 0 ? (
              <span
                className={[
                  "px-1.5 py-0 rounded-sm border font-medium",
                  flooredCount === steps.length
                    ? "text-[#1d8102] bg-[#eaf6ed] border-[#b6dbb1]"
                    : "text-[var(--text-secondary)] bg-[var(--surface-subtle)] border-[var(--aws-border)]",
                ].join(" ")}
              >
                {flooredCount}/{steps.length} floors
              </span>
            ) : null}
          </div>
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove from selection"
          title="Remove"
          className="shrink-0 w-9 h-9 sm:w-6 sm:h-6 flex items-center justify-center rounded-sm text-[var(--text-muted)] hover:text-[var(--aws-error)] hover:bg-[var(--surface-subtle)]"
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* ── Expanded editor ──────────────────────────────────────── */}
      {isExpanded ? (
        <div className="border-t border-[var(--aws-border)] p-3 bg-white rounded-b-md">
          {/* Row 1: quantity + deadline */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
            <NumberField
              label="Pack count (pcs)"
              value={cfg.qty_units ?? ""}
              placeholder={defaultUnits > 0 ? String(Math.round(defaultUnits)) : "—"}
              onChange={patchQtyUnits}
            />
            <NumberField
              label="Quantity (kg)"
              value={cfg.qty_kg ?? ""}
              placeholder={defaultKg > 0 ? String(defaultKg) : "—"}
              onChange={patchQtyKg}
            />
            <label className="block">
              <span className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">Deadline</span>
              <input
                type="date"
                value={cfg.deadline_date ?? defaultDeadline}
                onChange={(e) => onPatch({ deadline_date: e.target.value || undefined })}
                className="w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
              />
            </label>
          </div>

          {/* Row 2: factory selector */}
          <div className="mb-3">
            <label className="block">
              <span className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">
                Factory <span className="text-[var(--aws-error)]">*</span>
              </span>
              <select
                value={factory ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  onSetFactory(v === "" ? undefined : (v as FactoryCode));
                }}
                className="w-full sm:w-[220px] h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
              >
                <option value="">— Pick factory —</option>
                {factoryOpts.map((f) => (
                  <option key={f} value={f}>
                    {f} ({FACTORY_TO_WAREHOUSE[f]})
                  </option>
                ))}
              </select>
            </label>
            {factoryOpts.length === 0 ? (
              <p className="mt-1 text-[11px] text-[var(--aws-error)]">
                No factories are assigned to your account. Ask an admin to grant warehouse access.
              </p>
            ) : null}
          </div>

          {/* Row 3: process steps. Loads lazily from the BOM via
              ensureStepsLoaded() in the parent — we just render what's in
              cfg.steps and let the parent fire the fetch on expand. */}
          <StepsSection
            stepsLoaded={!!cfg.stepsLoaded}
            stepsLoading={!!cfg.stepsLoading}
            steps={steps}
            allowedFloors={allowedFloors}
            factory={factory}
            bomNote={cfg.bomNote}
            onSetStepFloor={onSetStepFloor}
            onSetStepProcess={onSetStepProcess}
            onMoveStep={onMoveStep}
            onMergeSteps={onMergeSteps}
            onAddStep={onAddStep}
            onRemoveStep={onRemoveStep}
            onRefreshSteps={onRefreshSteps}
          />

          {/* Row 4: actions */}
          <div className="flex flex-wrap gap-2 justify-end mt-3">
            {customised ? (
              <button
                type="button"
                onClick={onReset}
                className="h-7 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]"
              >
                Reset to default
              </button>
            ) : null}
            <button
              type="button"
              onClick={onToggleExpand}
              className="h-7 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]"
            >
              Done
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Steps section ──────────────────────────────────────────────────────
//
// HTML5 drag-and-drop reorder + accessible ↑/↓ buttons for keyboard and
// touch. Floor dropdown per step pulls from `allowedFloors` (the factory's
// floor set intersected with the user's auth scope). Empty = "any floor".
//
// State lives in the parent; we only emit move + setFloor events back up.

function StepsSection({
  stepsLoaded, stepsLoading, steps, allowedFloors, factory, bomNote,
  onSetStepFloor, onSetStepProcess, onMoveStep, onMergeSteps,
  onAddStep, onRemoveStep, onRefreshSteps,
}: {
  stepsLoaded: boolean;
  stepsLoading: boolean;
  steps: PlanStep[];
  allowedFloors: string[];
  factory: FactoryCode | undefined;
  bomNote: string | null | undefined;
  onSetStepFloor: (idx: number, floor: string | null) => void;
  onSetStepProcess: (idx: number, name: string | null) => void;
  onMoveStep: (from: number, to: number) => void;
  onMergeSteps: (idxs: number[]) => void;
  onAddStep: () => void;
  onRemoveStep: (idx: number) => void;
  onRefreshSteps: () => void;
}) {
  // Drag state stays local — the parent only sees committed reorders.
  const dragFromRef = useRef<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  // Merge-checkbox selection state. Lives entirely in the section (merge
  // is one-shot — once applied, the indices shift and the selection is no
  // longer meaningful). Auto-clears whenever the step list length changes,
  // matching the post-merge re-render behavior of frontend_replica's DOM-
  // backed selection.
  const [selectedIdxs, setSelectedIdxs] = useState<Set<number>>(new Set());
  useEffect(() => {
    // Deferred past the sync effect body so the
    // react-hooks/set-state-in-effect rule stays happy — matches the
    // queueMicrotask pattern used elsewhere in this codebase.
    queueMicrotask(() => setSelectedIdxs(new Set()));
  }, [steps.length]);

  function toggleSelect(i: number) {
    setSelectedIdxs((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }
  function selectAll(on: boolean) {
    setSelectedIdxs(on ? new Set(steps.map((_, i) => i)) : new Set());
  }
  function fireMerge() {
    if (selectedIdxs.size < 2) return;
    const idxs = [...selectedIdxs];
    setSelectedIdxs(new Set());
    onMergeSteps(idxs);
  }

  const mergeable = steps.length >= 2;
  const allSelected = mergeable && selectedIdxs.size === steps.length;
  const anySelected = selectedIdxs.size > 0;

  if (stepsLoading) {
    return (
      <div className="text-[12px] text-[var(--text-secondary)] flex items-center gap-2 py-2">
        <span className="inline-block w-3 h-3 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
        Loading process steps from BOM…
      </div>
    );
  }
  if (!stepsLoaded) {
    return null;
  }
  // Empty-state hint shown inline above the (empty) step list when no
  // BOM route exists. The manual "Add step" button below is the operator's
  // path forward in this case — keep it reachable for every article so
  // the workflow is uniform whether or not a BOM route is configured.
  const emptyHint = steps.length === 0
    ? (bomNote
        ? bomNote
        : "No BOM process route found for this SKU — use “Add step” below to build the route manually.")
    : null;

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1.5 px-0.5">
        <span className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)]">
          Process steps · {steps.length}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-[var(--text-muted)] hidden md:inline">
            Drag to reorder · × to remove
          </span>
          <button
            type="button"
            onClick={onRefreshSteps}
            title="Reload the BOM process route for this article (other articles aren't affected)"
            className="inline-flex items-center gap-1 h-6 px-1.5 text-[10px] rounded-[2px] border border-[var(--aws-border)] bg-white hover:border-[var(--aws-navy)] text-[var(--text-secondary)]"
          >
            <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            Refresh
          </button>
        </div>
      </div>

      {/* ── Merge toolbar — only when there are 2+ steps. Mirrors
          fulfillment.js:1393. Select-all + count hint + Merge button.
          Wraps to two rows on phones via flex-wrap; CTA stays usable. */}
      {mergeable ? (
        <div className="flex flex-wrap items-center gap-2 mb-1.5 px-2 py-1.5 bg-[var(--surface-subtle)] border border-[var(--aws-border)] rounded">
          <label className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] cursor-pointer">
            <input
              type="checkbox"
              checked={allSelected}
              ref={(el) => {
                if (el) el.indeterminate = anySelected && !allSelected;
              }}
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
            onClick={fireMerge}
            title="Combine the selected steps into a single step · time SUM, name joined with +"
            className={[
              "h-7 px-2.5 text-[11px] rounded-[2px] font-semibold border inline-flex items-center gap-1.5",
              selectedIdxs.size < 2
                ? "bg-[var(--surface-disabled)] border-[var(--aws-border)] text-[var(--text-disabled)] cursor-not-allowed"
                : "bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white",
            ].join(" ")}
          >
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <polyline points="8 12 3 12 8 7" />
              <polyline points="16 12 21 12 16 17" />
              <line x1="3" y1="12" x2="21" y2="12" />
            </svg>
            Merge selected
          </button>
        </div>
      ) : null}

      {emptyHint ? (
        <p
          className={
            "mb-1.5 px-2 py-1.5 text-[11px] italic rounded border " + (
              bomNote
                ? "text-[var(--aws-error)] border-[var(--aws-border)] bg-[#fdf0f1]"
                : "text-[var(--text-muted)] border-dashed border-[var(--aws-border)] bg-[var(--surface-subtle)]"
            )
          }
        >
          {emptyHint}
        </p>
      ) : null}

      <ol className="space-y-1">
        {steps.map((s, i) => {
          const isDragOver = dragOverIdx === i;
          return (
            <li
              key={`${s.process_name ?? ""}-${i}`}
              draggable
              onDragStart={(e) => {
                dragFromRef.current = i;
                e.dataTransfer.effectAllowed = "move";
                // Some browsers require setData for the drag to fire.
                e.dataTransfer.setData("text/plain", String(i));
              }}
              onDragEnd={() => {
                dragFromRef.current = null;
                setDragOverIdx(null);
              }}
              onDragOver={(e) => {
                if (dragFromRef.current == null) return;
                e.preventDefault();
                setDragOverIdx(i);
              }}
              onDragLeave={() => {
                setDragOverIdx((cur) => (cur === i ? null : cur));
              }}
              onDrop={(e) => {
                e.preventDefault();
                const from = dragFromRef.current;
                if (from == null || from === i) return;
                onMoveStep(from, i);
                dragFromRef.current = null;
                setDragOverIdx(null);
              }}
              className={[
                "border rounded bg-white px-2 py-1.5 flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-2",
                isDragOver
                  ? "border-[var(--aws-orange)] bg-[#fdf0f1]"
                  : "border-[var(--aws-border)]",
              ].join(" ")}
            >
              {/* Row 1 on phones / left half on sm+: checkbox · handle · num · name. */}
              <div className="flex items-center gap-2 flex-1 min-w-0">
                {/* Merge-selection checkbox — only when 2+ steps. */}
                {mergeable ? (
                  <label
                    className="shrink-0 inline-flex items-center justify-center w-7 h-7 -m-1 cursor-pointer"
                    title="Select to merge"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={selectedIdxs.has(i)}
                      onChange={() => toggleSelect(i)}
                      className="accent-[var(--aws-orange)]"
                    />
                  </label>
                ) : null}
                <span
                  aria-hidden
                  title="Drag to reorder"
                  className="shrink-0 inline-flex items-center justify-center w-7 h-7 -m-1 text-[var(--text-muted)] cursor-grab active:cursor-grabbing touch-none"
                >
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                    <circle cx="9"  cy="6"  r="1.4" />
                    <circle cx="15" cy="6"  r="1.4" />
                    <circle cx="9"  cy="12" r="1.4" />
                    <circle cx="15" cy="12" r="1.4" />
                    <circle cx="9"  cy="18" r="1.4" />
                    <circle cx="15" cy="18" r="1.4" />
                  </svg>
                </span>
                <span className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full bg-[var(--aws-navy)] text-white text-[10px] font-bold">
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  {/* Process picker: canonical PROCESS_OPTIONS values plus
                      a synthetic option for any BOM-supplied name that
                      isn't in the catalog (defensive — keeps legacy
                      values visible instead of silently resetting). */}
                  {(() => {
                    const current = s.process_name ?? "";
                    const inCatalog =
                      current === "" ||
                      PROCESS_OPTIONS.some(
                        (p) => p.toLowerCase() === current.toLowerCase(),
                      );
                    return (
                      <select
                        value={current}
                        onChange={(e) => onSetStepProcess(i, e.target.value || null)}
                        title="Pick the process for this step"
                        className="w-full h-7 px-1.5 text-[12px] font-semibold rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] text-[var(--text-primary)]"
                      >
                        <option value="">— Process —</option>
                        {!inCatalog && current ? (
                          <option value={current}>
                            {current} (custom)
                          </option>
                        ) : null}
                        {PROCESS_OPTIONS.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                    );
                  })()}
                  <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-muted)] flex-wrap mt-0.5">
                    {s.stage ? <span>{s.stage}</span> : null}
                    {s.std_time_min != null ? <span>· {s.std_time_min} min</span> : null}
                    {s.loss_pct != null && s.loss_pct > 0 ? <span>· {s.loss_pct}% loss</span> : null}
                  </div>
                </div>
              </div>
              {/* Row 2 on phones / right half on sm+: floor select + up/down.
                  Floor flexes to fill the row on phones, fixed width on sm+. */}
              <div className="flex items-center gap-2 sm:shrink-0">
                <select
                  value={s.floor ?? ""}
                  onChange={(e) => onSetStepFloor(i, e.target.value || null)}
                  disabled={!factory}
                  title={!factory ? "Pick a factory first" : "Assign a floor"}
                  className="h-9 sm:h-7 flex-1 sm:flex-none sm:w-[180px] px-2 text-[12px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] disabled:bg-[var(--surface-disabled)] disabled:text-[var(--text-disabled)]"
                >
                  <option value="">{factory ? "— Any floor —" : "— Pick factory —"}</option>
                  {allowedFloors.map((fl) => (
                    <option key={fl} value={fl}>{fl}</option>
                  ))}
                </select>
                <div className="flex items-center gap-0.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => onMoveStep(i, i - 1)}
                    disabled={i === 0}
                    aria-label="Move step up"
                    className="w-9 h-9 sm:w-7 sm:h-7 inline-flex items-center justify-center rounded-sm text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 15 12 9 18 15" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => onMoveStep(i, i + 1)}
                    disabled={i === steps.length - 1}
                    aria-label="Move step down"
                    className="w-9 h-9 sm:w-7 sm:h-7 inline-flex items-center justify-center rounded-sm text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                  {/* Remove this step. Disabled when only one step remains
                      — a card needs at least one row; "start over" is what
                      the per-card Refresh button is for. */}
                  <button
                    type="button"
                    onClick={() => onRemoveStep(i)}
                    disabled={steps.length <= 1}
                    aria-label="Remove step"
                    title={steps.length <= 1 ? "At least one step is required" : "Remove this step"}
                    className="w-9 h-9 sm:w-7 sm:h-7 inline-flex items-center justify-center rounded-sm text-[var(--text-muted)] hover:text-[var(--aws-error)] hover:bg-[var(--surface-subtle)] disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {/* Append a fresh blank step. Operator picks a process from the
          dropdown and (optionally) a floor. The step inherits no BOM
          defaults — it's a true insertion. */}
      <div className="mt-2 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onAddStep}
          className="inline-flex items-center gap-1 h-7 px-2.5 text-[11px] font-semibold rounded-[2px] border border-dashed border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-orange)] hover:text-[var(--aws-orange)] text-[var(--text-secondary)]"
        >
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Add step
        </button>
        {bomNote && steps.length > 0 ? (
          <p className="text-[11px] text-[var(--text-muted)] italic">{bomNote}</p>
        ) : null}
      </div>
    </div>
  );
}

// Small numeric input that flips undefined ↔ number through a string field.
// Empty string clears the override (returns undefined to parent).
function NumberField({
  label, value, placeholder, onChange,
}: {
  label: string;
  value: number | string;
  placeholder?: string;
  onChange: (n: number | undefined) => void;
}) {
  const display = value === undefined || value === null ? "" : String(value);
  return (
    <label className="block">
      <span className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">{label}</span>
      <input
        type="number"
        min={0}
        step="any"
        inputMode="decimal"
        value={display}
        placeholder={placeholder}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") { onChange(undefined); return; }
          const n = parseFloat(raw);
          onChange(Number.isFinite(n) ? n : undefined);
        }}
        className="w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
      />
    </label>
  );
}

// ── Mobile cards (< md) ──────────────────────────────────────────────────

function MobileGroupCard({
  group, isOpen, onToggleGroup,
  expandedId, onExpand,
  selectedIds, onToggleSelection,
  editingDeadlineId, onStartEditDeadline, onCancelEditDeadline, onSaveDeadline,
}: {
  group: SoGroup;
  isOpen: boolean;
  onToggleGroup: () => void;
  expandedId: number | null;
  onExpand: (id: number) => void;
  selectedIds: Set<number>;
  onToggleSelection: (id: number) => void;
  editingDeadlineId: number | null;
  onStartEditDeadline: (id: number) => void;
  onCancelEditDeadline: () => void;
  onSaveDeadline: (id: number, newDate: string) => void;
}) {
  const count = group.rows.length;
  const totalKg = group.rows.reduce((s, a) => s + toNum(a.pending_qty_kg), 0);
  const dates = group.rows.map((a) => a.delivery_deadline).filter((x): x is string => !!x).sort();
  const earliest = dates[0] ?? null;
  const customer = group.rows[0]?.customer_name || "—";
  const statuses = new Set(group.rows.map((a) => a.status || "open"));
  const statusLabel = statuses.size === 1 ? [...statuses][0] : "mixed";
  const inPlanCount = group.rows.filter((a) => a.is_planned).length;

  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md overflow-hidden">
      <button
        type="button"
        onClick={onToggleGroup}
        className="w-full text-left px-2.5 py-2 bg-[var(--surface-subtle)] flex items-start gap-2 hover:bg-[#eef3f5]"
      >
        <svg
          viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
          strokeWidth={2} className="mt-1 shrink-0 text-[var(--text-secondary)]"
          style={{ transform: isOpen ? "rotate(90deg)" : "none", transition: "transform .15s" }}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted)]">
            <span className="font-mono normal-case tracking-normal text-[var(--aws-link)] font-semibold">{group.soNumber}</span>
            <span className="opacity-50">·</span>
            <span>{count} article{count > 1 ? "s" : ""}</span>
          </div>
          <p className="text-[13px] text-[var(--text-primary)] truncate leading-tight" title={customer}>{customer}</p>
          <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5 mt-1 text-[11px]">
            <span className="font-semibold text-[var(--text-primary)]">{fmtKg(totalKg)} kg</span>
            {earliest ? <DeadlineBadge iso={earliest} /> : null}
            <StatusPill status={statusLabel} />
            {inPlanCount > 0 ? (
              <span className="text-[10px] font-semibold text-[#1d8102] bg-[#eaf6ed] border border-[#b6dbb1] rounded-sm px-1.5 py-0">
                {inPlanCount}/{count} planned
              </span>
            ) : null}
          </div>
        </div>
      </button>
      {isOpen ? (
        <div className="border-t border-[var(--aws-border)] p-1.5 space-y-1.5 bg-[var(--background)]">
          {group.rows.map((r) => (
            <MobileDataCard
              key={r.fulfillment_id}
              row={r}
              inGroup
              expanded={expandedId === r.fulfillment_id}
              onExpand={() => onExpand(r.fulfillment_id)}
              selected={selectedIds.has(r.fulfillment_id)}
              onToggleSelection={() => onToggleSelection(r.fulfillment_id)}
              editing={editingDeadlineId === r.fulfillment_id}
              onStartEditDeadline={() => onStartEditDeadline(r.fulfillment_id)}
              onCancelEditDeadline={onCancelEditDeadline}
              onSaveDeadline={onSaveDeadline}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MobileDataCard({
  row, inGroup, expanded, onExpand,
  selected, onToggleSelection,
  editing, onStartEditDeadline, onCancelEditDeadline, onSaveDeadline,
}: {
  row: FulfillmentRow;
  inGroup: boolean;
  expanded: boolean;
  onExpand: () => void;
  selected: boolean;
  onToggleSelection: () => void;
  editing: boolean;
  onStartEditDeadline: () => void;
  onCancelEditDeadline: () => void;
  onSaveDeadline: (id: number, newDate: string) => void;
}) {
  const sku = row.fg_sku_name || "—";
  return (
    <div
      className={[
        "bg-white border rounded-md overflow-hidden transition-colors",
        selected
          ? "border-[var(--aws-orange)] border-l-[3px] border-l-[var(--aws-orange)]"
          : "border-[var(--aws-border)]",
      ].join(" ")}
    >
      <div
        className="px-2 py-2 flex items-start gap-1 cursor-pointer hover:bg-[var(--surface-subtle)]"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("button, input, label, a, select")) return;
          onExpand();
        }}
      >
        {/* Bigger tap target around the checkbox — the 16px native input
            is below the comfortable thumb target; the surrounding label
            absorbs taps within a 36px box without changing the visuals. */}
        <label
          className="shrink-0 inline-flex items-center justify-center w-9 h-9 -m-1 cursor-pointer"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelection}
            className="accent-[var(--aws-orange)]"
          />
        </label>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onExpand(); }}
          aria-label={expanded ? "Collapse" : "Expand"}
          className="shrink-0 inline-flex items-center justify-center w-9 h-9 -m-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          <svg
            viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
            strokeWidth={2}
            style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform .15s" }}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          {/* Customer + SO header: hidden for in-group rows because the parent
              group card already carries that information. */}
          {!inGroup ? (
            <div className="flex items-center gap-2 mb-0.5 flex-wrap">
              <span className="text-[12px] text-[var(--text-primary)] truncate" title={row.customer_name ?? ""}>
                {row.customer_name || "—"}
              </span>
              {row.so_number ? (
                <span className="font-mono text-[11px] text-[var(--aws-link)] shrink-0">{row.so_number}</span>
              ) : null}
            </div>
          ) : (
            <div className="text-[10px] text-[var(--text-muted)] mb-0.5">↳ article</div>
          )}
          <p className="text-[13px] font-semibold text-[var(--text-primary)] mb-1 break-words" title={sku}>{sku}</p>
          <div className="flex items-center flex-wrap gap-2 mb-1">
            <span className="text-[12px] font-semibold text-[var(--text-primary)]">{fmtKg(row.pending_qty_kg)} kg</span>
            {toNum(row.pending_qty_units) > 0 ? (
              <span className="text-[11px] text-[var(--text-muted)]">{fmtUnits(row.pending_qty_units)} pcs</span>
            ) : null}
            <StatusPill status={row.status} />
            {row.is_planned ? (
              <span className="text-[10px] font-semibold text-[#1d8102] bg-[#eaf6ed] border border-[#b6dbb1] rounded-sm px-1.5 py-0.5">
                In Plan
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] font-semibold">Deadline</span>
            <DeadlineCell
              row={row}
              editing={editing}
              onStartEdit={onStartEditDeadline}
              onCancelEdit={onCancelEditDeadline}
              onSave={(date) => onSaveDeadline(row.fulfillment_id, date)}
            />
          </div>
        </div>
      </div>
      {expanded ? (
        <div className="border-t border-[var(--aws-border)] p-3 bg-[var(--surface-subtle)]">
          <DetailPanel fulfillmentId={row.fulfillment_id} />
        </div>
      ) : null}
    </div>
  );
}

function GroupBlock({
  group, isOpen, onToggleGroup,
  expandedId, onExpand,
  selectedIds, onToggleSelection,
  editingDeadlineId, onStartEditDeadline, onCancelEditDeadline, onSaveDeadline,
}: {
  group: SoGroup;
  isOpen: boolean;
  onToggleGroup: () => void;
  expandedId: number | null;
  onExpand: (id: number) => void;
  selectedIds: Set<number>;
  onToggleSelection: (id: number) => void;
  editingDeadlineId: number | null;
  onStartEditDeadline: (id: number) => void;
  onCancelEditDeadline: () => void;
  onSaveDeadline: (id: number, newDate: string) => void;
}) {
  const count = group.rows.length;
  const totalKg = group.rows.reduce((s, a) => s + toNum(a.pending_qty_kg), 0);
  const totalUnits = group.rows.reduce((s, a) => s + toNum(a.pending_qty_units), 0);
  const dates = group.rows.map((a) => a.delivery_deadline).filter((x): x is string => !!x).sort();
  const earliest = dates[0] ?? null;
  const customer = group.rows[0]?.customer_name || "—";
  const statuses = new Set(group.rows.map((a) => a.status || "open"));
  const statusLabel = statuses.size === 1 ? [...statuses][0] : "mixed";
  const inPlanCount = group.rows.filter((a) => a.is_planned).length;

  return (
    <>
      <tr
        className="border-b border-[var(--aws-border)] bg-[var(--surface-subtle)] cursor-pointer hover:bg-[#eef3f5]"
        onClick={onToggleGroup}
      >
        <td className="px-2 py-1.5" />
        <td className="px-1 py-1.5 text-[var(--text-secondary)]">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2} style={{ transform: isOpen ? "rotate(90deg)" : "none", transition: "transform .15s" }}>
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </td>
        <td className="px-2.5 py-1.5 truncate max-w-[200px] font-medium" title={customer}>{customer}</td>
        <td className="px-2.5 py-1.5 font-mono text-[11px] text-[var(--aws-link)]">{group.soNumber}</td>
        <td className="px-2.5 py-1.5 text-[11px] text-[var(--text-muted)]">{count} article{count > 1 ? "s" : ""}</td>
        <td className="px-2.5 py-1.5">
          <span className="font-semibold">{fmtKg(totalKg)} kg</span>
          {totalUnits > 0 ? <span className="text-[10px] text-[var(--text-muted)] ml-1.5">{fmtUnits(totalUnits)} pcs</span> : null}
        </td>
        <td className="px-2.5 py-1.5">
          {earliest ? <DeadlineBadge iso={earliest} /> : <span className="text-[var(--text-muted)]">—</span>}
        </td>
        <td className="px-2.5 py-1.5"><StatusPill status={statusLabel} /></td>
        <td className="px-2.5 py-1.5">
          {inPlanCount > 0 ? (
            <span className="text-[10px] font-semibold text-[#1d8102] bg-[#eaf6ed] border border-[#b6dbb1] rounded-sm px-1.5 py-0.5">
              {inPlanCount}/{count} planned
            </span>
          ) : null}
        </td>
      </tr>
      {isOpen ? group.rows.map((r) => (
        <DataRowBlock
          key={r.fulfillment_id}
          row={r}
          inGroup
          expanded={expandedId === r.fulfillment_id}
          onExpand={() => onExpand(r.fulfillment_id)}
          selected={selectedIds.has(r.fulfillment_id)}
          onToggleSelection={() => onToggleSelection(r.fulfillment_id)}
          editing={editingDeadlineId === r.fulfillment_id}
          onStartEditDeadline={() => onStartEditDeadline(r.fulfillment_id)}
          onCancelEditDeadline={onCancelEditDeadline}
          onSaveDeadline={onSaveDeadline}
        />
      )) : null}
    </>
  );
}

function DataRowBlock({
  row, inGroup, expanded, onExpand,
  selected, onToggleSelection,
  editing, onStartEditDeadline, onCancelEditDeadline, onSaveDeadline,
}: {
  row: FulfillmentRow;
  inGroup: boolean;
  expanded: boolean;
  onExpand: () => void;
  selected: boolean;
  onToggleSelection: () => void;
  editing: boolean;
  onStartEditDeadline: () => void;
  onCancelEditDeadline: () => void;
  onSaveDeadline: (id: number, newDate: string) => void;
}) {
  const skuFull = row.fg_sku_name || "—";
  const skuShort = skuFull.length > 32 ? skuFull.slice(0, 32) + "…" : skuFull;
  return (
    <>
      <tr
        className={[
          "border-b border-[var(--aws-border)] hover:bg-[var(--surface-subtle)] cursor-pointer",
          selected ? "bg-[#eaf3ff]" : "",
        ].join(" ")}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("button, input, label, a, select")) return;
          onExpand();
        }}
      >
        <td className="px-2 py-1.5">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelection}
            onClick={(e) => e.stopPropagation()}
            className="accent-[var(--aws-orange)]"
          />
        </td>
        <td className="px-1 py-1.5 text-[var(--text-secondary)]">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2} style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform .15s" }}>
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </td>
        {inGroup ? (
          <td className="px-2.5 py-1.5 text-[var(--text-muted)]">↳</td>
        ) : (
          <td className="px-2.5 py-1.5 truncate max-w-[200px]" title={row.customer_name ?? ""}>{row.customer_name || "—"}</td>
        )}
        {inGroup ? (
          <td className="px-2.5 py-1.5" />
        ) : (
          <td className="px-2.5 py-1.5 font-mono text-[11px] text-[var(--aws-link)]">{row.so_number || "—"}</td>
        )}
        <td className="px-2.5 py-1.5 truncate max-w-[280px]" title={skuFull}>{skuShort}</td>
        <td className="px-2.5 py-1.5">
          <span className="font-semibold">{fmtKg(row.pending_qty_kg)} kg</span>
          {toNum(row.pending_qty_units) > 0 ? <span className="text-[10px] text-[var(--text-muted)] ml-1.5">{fmtUnits(row.pending_qty_units)} pcs</span> : null}
        </td>
        <td className="px-2.5 py-1.5">
          <DeadlineCell
            row={row}
            editing={editing}
            onStartEdit={onStartEditDeadline}
            onCancelEdit={onCancelEditDeadline}
            onSave={(date) => onSaveDeadline(row.fulfillment_id, date)}
          />
        </td>
        <td className="px-2.5 py-1.5"><StatusPill status={row.status} /></td>
        <td className="px-2.5 py-1.5">
          {row.is_planned ? (
            <span className="text-[10px] font-semibold text-[#1d8102] bg-[#eaf6ed] border border-[#b6dbb1] rounded-sm px-1.5 py-0.5">
              In Plan
            </span>
          ) : null}
        </td>
      </tr>
      {expanded ? (
        <tr className="border-b border-[var(--aws-border)] bg-[var(--surface-subtle)]">
          <td colSpan={9} className="px-4 py-3">
            <DetailPanel fulfillmentId={row.fulfillment_id} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function DeadlineCell({
  row, editing, onStartEdit, onCancelEdit, onSave,
}: {
  row: FulfillmentRow;
  editing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: (date: string) => void;
}) {
  const [val, setVal] = useState<string>(() => row.delivery_deadline?.slice(0, 10) ?? "");
  useEffect(() => {
    // Re-sync the date input when the parent row refreshes (e.g. after a
    // successful revise patches delivery_deadline in place). Deferred past
    // the sync effect body so the react-hooks/set-state-in-effect rule
    // stays happy — matches the queueMicrotask pattern used elsewhere in
    // this codebase (see lib/user.ts and the job-card detail page).
    queueMicrotask(() => setVal(row.delivery_deadline?.slice(0, 10) ?? ""));
  }, [row.delivery_deadline]);

  if (editing) {
    return (
      <div className="inline-flex items-center gap-1">
        <input
          type="date"
          autoFocus
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          className="h-7 px-1.5 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e]"
        />
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onSave(val); }}
          className="h-7 px-2 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--text-success)] text-[var(--text-success)]"
        >✓</button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onCancelEdit(); }}
          className="h-7 px-2 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-error)] text-[var(--aws-error)]"
        >✕</button>
      </div>
    );
  }
  if (row.delivery_deadline) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onStartEdit(); }}
        title="Click to change deadline"
        className="text-left"
      >
        <DeadlineBadge iso={row.delivery_deadline} />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onStartEdit(); }}
      className="inline-flex items-center gap-1 h-7 px-2 text-[12px] rounded-[2px] border border-dashed border-[var(--aws-border-strong)] text-[var(--text-secondary)] hover:border-[var(--aws-navy)] hover:text-[var(--text-primary)]"
    >
      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
      </svg>
      Set deadline
    </button>
  );
}

function DeadlineBadge({ iso }: { iso: string }) {
  const tone = deadlineTone(iso);
  const cls = tone === "overdue" ? "text-[#b1361e] bg-[#fdf3f1] border-[#f0c7be]"
            : tone === "soon"    ? "text-[#9a393e] bg-[#fbeced] border-[#e6bcbe]"
            : tone === "ok"      ? "text-[var(--text-primary)] bg-white border-[var(--aws-border)]"
                                  : "text-[var(--text-muted)] bg-white border-[var(--aws-border)]";
  return (
    <span className={["inline-block text-[11px] font-semibold px-2 py-0.5 rounded-sm border", cls].join(" ")}>
      {fmtDeadline(iso)}
    </span>
  );
}

function StatusPill({ status }: { status?: string | null }) {
  const s = (status || "open").toLowerCase();
  const styles: Record<string, string> = {
    open:      "text-[#9a393e] bg-[#eaf3ff] border-[#bbd9f3]",
    partial:   "text-[#9a393e] bg-[#fbeced] border-[#e6bcbe]",
    fulfilled: "text-[#1d8102] bg-[#eaf6ed] border-[#b6dbb1]",
    mixed:     "text-[#5752c4] bg-[#f0eef8] border-[#d2cef0]",
  };
  const cls = styles[s] ?? "text-[var(--text-secondary)] bg-[#f4f4f4] border-[#d5dbdb]";
  return (
    <span className={["inline-block text-[11px] font-semibold capitalize px-2 py-0.5 rounded-sm border", cls].join(" ")}>
      {s}
    </span>
  );
}

// ── Detail panel (lazy-loaded) ──────────────────────────────────────────

function DetailPanel({ fulfillmentId }: { fulfillmentId: number }) {
  const [detail, setDetail] = useState<FulfillmentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const c = new AbortController();
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const d = await fetchFulfillmentDetail(fulfillmentId, c.signal);
        if (!c.signal.aborted) setDetail(d);
      } catch (e) {
        if (!c.signal.aborted) setError(e instanceof Error ? e.message : "Detail load failed");
      } finally {
        if (!c.signal.aborted) setLoading(false);
      }
    })();
    return () => c.abort();
  }, [fulfillmentId]);

  if (loading) {
    return <p className="text-[12px] text-[var(--text-secondary)]">Loading detail…</p>;
  }
  if (error) {
    return <p className="text-[12px] text-[var(--aws-error)]">{error}</p>;
  }
  if (!detail) return null;

  // Server nests the fulfillment row under `detail.fulfillment`; field names
  // mirror the LIST row (original_qty_kg, order_status, delivery_deadline).
  const f = detail.fulfillment ?? ({} as FulfillmentDetailRow);
  const logs = detail.revision_log ?? [];

  return (
    <div>
      {/* Two sub-sections: meta + quantities. Splitting them visually gives
          a clearer scan path than one big 14-cell grid. */}
      <DetailSection title="Order">
        <dl className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-x-4 gap-y-1.5 text-[12px]">
          <KV label="Customer"        value={f.customer_name} />
          <KV label="SO Number"       value={f.so_number} mono />
          <KV label="FG SKU"          value={f.fg_sku_name} />
          <KV label="Entity"          value={f.entity} />
          <KV label="FY"              value={f.financial_year} mono />
          <KV label="Status"          value={f.order_status} />
          <KV label="Deadline"        value={f.delivery_deadline ? fmtDeadline(f.delivery_deadline) : "—"} />
          <KV label="In plan"         value={f.is_planned ? `#${f.plan_line_id ?? "?"}` : "No"} />
        </dl>
      </DetailSection>
      <DetailSection title="Quantities" className="mt-3">
        <dl className="grid grid-cols-3 sm:grid-cols-6 gap-x-4 gap-y-1.5 text-[12px]">
          <KV label="Original kg"   value={fmtKg(f.original_qty_kg)} />
          <KV label="Produced kg"   value={fmtKg(f.produced_qty_kg)} />
          <KV label="Dispatched kg" value={fmtKg(f.dispatched_qty_kg)} />
          <KV label="Planned kg"    value={fmtKg(f.planned_qty_kg)} />
          <KV label="Pending kg"    value={fmtKg(f.pending_qty_kg)} />
          <KV label="Pending pcs"   value={fmtUnits(f.pending_qty_units)} />
        </dl>
      </DetailSection>
      {logs.length > 0 ? (
        <div className="mt-4">
          <h4 className="text-[11px] uppercase tracking-wide font-semibold text-[var(--text-secondary)] mb-1">
            Revision log
          </h4>

          {/* Mobile (< sm): stacked entries — a 5-column table won't fit
              inside the narrow mobile card and would scroll horizontally. */}
          <ul className="sm:hidden space-y-2">
            {logs.slice(0, 8).map((l, i) => (
              <li key={i} className="border-t border-[var(--aws-border)] pt-1.5">
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <span className="text-[11px] font-semibold text-[var(--text-primary)]">{l.revision_type ?? "—"}</span>
                  <span className="font-mono text-[10px] text-[var(--text-muted)] shrink-0">
                    {l.revised_at ? fmtDeadline(l.revised_at) : "—"}
                  </span>
                </div>
                <div className="text-[11px] text-[var(--text-primary)]">
                  {l.old_value ?? "—"} → {l.new_value ?? "—"}
                </div>
                {l.reason ? (
                  <div className="text-[11px] text-[var(--text-secondary)] mt-0.5">{l.reason}</div>
                ) : null}
                <div className="text-[10px] text-[var(--text-muted)] mt-0.5">by {l.revised_by ?? "—"}</div>
              </li>
            ))}
          </ul>

          {/* sm+: table */}
          <table className="hidden sm:table w-full text-[11px] border-collapse">
            <thead className="bg-[var(--surface-subtle)] text-[var(--text-secondary)]">
              <tr>
                <th className="px-2 py-1 text-left">When</th>
                <th className="px-2 py-1 text-left">Type</th>
                <th className="px-2 py-1 text-left">Old → New</th>
                <th className="px-2 py-1 text-left">Reason</th>
                <th className="px-2 py-1 text-left">By</th>
              </tr>
            </thead>
            <tbody>
              {logs.slice(0, 8).map((l, i) => (
                <tr key={i} className="border-t border-[var(--aws-border)]">
                  <td className="px-2 py-1 whitespace-nowrap font-mono text-[10px] text-[var(--text-muted)]">
                    {l.revised_at ? fmtDeadline(l.revised_at) : "—"}
                  </td>
                  <td className="px-2 py-1">{l.revision_type ?? "—"}</td>
                  <td className="px-2 py-1">{l.old_value ?? "—"} → {l.new_value ?? "—"}</td>
                  <td className="px-2 py-1 truncate max-w-[280px]" title={l.reason ?? ""}>
                    {l.reason ?? "—"}
                  </td>
                  <td className="px-2 py-1">{l.revised_by ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {logs.length > 8 ? (
            <p className="text-[10px] text-[var(--text-muted)] mt-1">
              Showing first 8 of {logs.length} revisions.
            </p>
          ) : null}
        </div>
      ) : null}
      <p className="text-[11px] text-[var(--text-muted)] italic mt-3">
        BOM override and floor-stock override modals are not yet wired up on web.
        Use the Electron client for those flows.
      </p>
    </div>
  );
}

function DetailSection({
  title, className, children,
}: {
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={className}>
      <div className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)] mb-1.5">
        {title}
      </div>
      {children}
    </section>
  );
}

function KV({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
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
