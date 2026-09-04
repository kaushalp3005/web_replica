"use client";

// The single data seam for the Inventory Ledger module. Everything the module
// shows is derived from one flat leaf set; this provider supplies it from either
// the built-in FIXTURES or the LIVE backend (GET /api/v1/ledger/leaves), chosen
// by a feature flag + a runtime toggle. LIVE is the default — set
// NEXT_PUBLIC_LEDGER_LIVE=0 (or flick the Sample/Live switch) to use fixtures.
//
// Hydration-safe: the initial source is the env default on both server and the
// client's first paint; the toggle only changes it after mount. The layout keeps
// this provider mounted across the module's routes, so a chosen source persists
// while navigating group → item → ledger (a full reload resets to the default).

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { LedgerApi } from "@/lib/ledger";
import type { Entity, LeafItem } from "@/lib/ledger";
import { filterLeaves } from "./_tree";
import { LEDGER_LEAVES } from "./_fixtures";

export type LedgerSource = "fixtures" | "live";
export type EntityScope = Entity | "both";
const ENV_LIVE = process.env.NEXT_PUBLIC_LEDGER_LIVE !== "0";

export const ENTITY_LABELS: Record<EntityScope, string> = {
  cfpl: "CFPL", cdpl: "CDPL", both: "Both",
};
export const ENTITY_SCOPES: EntityScope[] = ["cfpl", "cdpl", "both"];
const EMPTY_LEAVES: LeafItem[] = [];

export interface LedgerData {
  /** Leaves for the selected entity — what every view must derive from. */
  leaves: LeafItem[];
  /** Every loaded leaf, before the entity filter. Only for "did the backend
   *  return anything at all?" checks; never build a figure from this. */
  allLeaves: LeafItem[];
  entity: EntityScope;
  setEntity: (e: EntityScope) => void;
  loading: boolean;
  error: string | null;
  source: LedgerSource;
  setSource: (s: LedgerSource) => void;
  reload: () => void;
}

const Ctx = createContext<LedgerData | null>(null);

export function LedgerDataProvider({ children }: { children: React.ReactNode }) {
  const [source, setSourceState] = useState<LedgerSource>(ENV_LIVE ? "live" : "fixtures");
  // The header's CFPL/CDPL/Both selector lives here rather than on the page so
  // the choice survives navigation into the group drill and item hub, and so
  // every view filters the SAME leaf set. Default matches the old page default.
  const [entity, setEntity] = useState<EntityScope>("cfpl");
  const [remote, setRemote] = useState<{ loading: boolean; error: string | null; data: LeafItem[] | null }>({
    loading: false, error: null, data: null,
  });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (source !== "live") return;
    let cancelled = false;
    const ac = new AbortController();
    // setState happens inside the async callback (not synchronously in the effect
    // body), so it doesn't trip react-hooks/set-state-in-effect.
    void (async () => {
      setRemote({ loading: true, error: null, data: null });
      try {
        const res = await LedgerApi.leaves("both", ac.signal);
        if (!cancelled) setRemote({ loading: false, error: null, data: res.data ?? [] });
      } catch (e) {
        if (!cancelled && !ac.signal.aborted) {
          setRemote({ loading: false, error: e instanceof Error ? e.message : "Failed to load ledger data.", data: null });
        }
      }
    })();
    return () => { cancelled = true; ac.abort(); };
  }, [source, reloadKey]);

  const setSource = useCallback((s: LedgerSource) => {
    setSourceState(s);
    try { window.localStorage.setItem("ledger:source", s); } catch { /* storage may be unavailable */ }
  }, []);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  // Memoised so the `remote.data ?? []` fallback doesn't hand a fresh array to
  // the filter below on every render.
  const allLeaves = useMemo(
    () => (source === "live" ? (remote.data ?? EMPTY_LEAVES) : LEDGER_LEAVES),
    [source, remote.data],
  );
  // Applied once, here, so no view can forget it and silently show CFPL+CDPL
  // under a "CFPL" label. Uses the module's normal LeafFilter mechanism.
  const leaves = useMemo(() => filterLeaves(allLeaves, { entity }), [allLeaves, entity]);

  const value: LedgerData = {
    leaves, allLeaves, entity, setEntity,
    loading: source === "live" ? remote.loading : false,
    error: source === "live" ? remote.error : null,
    source, setSource, reload,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLedgerLeaves(): LedgerData {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLedgerLeaves must be used within LedgerDataProvider");
  return v;
}

// ── Loading / error / empty gate ───────────────────────────────────
export function LedgerGate({ children }: { children: React.ReactNode }) {
  const { leaves, allLeaves, entity, loading, error, reload, source } = useLedgerLeaves();
  if (source === "live" && loading) {
    return (
      <div className="flex flex-col gap-[9px]" aria-busy="true" aria-live="polite">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-[38px] rounded-[8px] bg-[var(--surface-subtle)] animate-pulse" />
        ))}
        <span className="font-mono text-[10.5px] text-[var(--text-muted)]">Loading live ledger data…</span>
      </div>
    );
  }
  if (source === "live" && error) {
    return (
      <div className="rounded-[11px] border border-[#dd4a4f66] bg-[#fce8e9] p-[14px] flex flex-col gap-2">
        <b className="text-[var(--aws-error)] text-[13px]">Couldn&rsquo;t load live ledger data</b>
        <span className="font-mono text-[11px] text-[var(--text-secondary)]">{error}</span>
        <button onClick={reload} className="self-start font-mono text-[11px] rounded-[7px] px-[11px] py-[5px] bg-[var(--aws-navy)] text-white">Retry</button>
      </div>
    );
  }
  if (source === "live" && allLeaves.length === 0) {
    return <div className="rounded-[11px] border border-[var(--aws-border)] bg-white p-[14px] font-mono text-[12px] text-[var(--text-muted)]">No ledger data returned. Once the backend is seeded this will populate.</div>;
  }
  // Data loaded, but the entity selector filtered all of it away — say so rather
  // than implying the backend returned nothing.
  if (leaves.length === 0 && allLeaves.length > 0) {
    return <div className="rounded-[11px] border border-[var(--aws-border)] bg-white p-[14px] font-mono text-[12px] text-[var(--text-muted)]">No rows for {ENTITY_LABELS[entity]}. Switch the entity selector to see the other company.</div>;
  }
  return <>{children}</>;
}

// ── CFPL / CDPL / Both selector (for the page header) ──────────────
// Drives the real entity filter in this provider — not a decorative control.
export function LedgerEntityToggle() {
  const { entity, setEntity } = useLedgerLeaves();
  return (
    <div className="inline-flex bg-white border border-[var(--aws-border)] rounded-[8px] p-[2px] gap-[2px]" title="Filter the ledger to one company, or combine both">
      {ENTITY_SCOPES.map((e) => (
        <button
          key={e}
          onClick={() => setEntity(e)}
          aria-pressed={entity === e}
          className={`font-mono text-[11px] px-[11px] py-[4px] rounded-[6px] ${
            entity === e ? "bg-[var(--aws-navy)] text-white font-semibold" : "text-[var(--text-secondary)]"
          }`}
        >{ENTITY_LABELS[e]}</button>
      ))}
    </div>
  );
}

// ── Sample / Live toggle (for the page header) ─────────────────────
export function LedgerSourceToggle() {
  const { source, setSource, loading } = useLedgerLeaves();
  return (
    <div className="inline-flex items-center gap-[6px]" title="Switch between built-in sample data and the live /api/v1/ledger backend">
      {source === "live" && loading && <span className="w-[7px] h-[7px] rounded-full bg-[#c07d09] animate-pulse" aria-label="loading" />}
      <div className="inline-flex bg-white border border-[var(--aws-border)] rounded-[8px] p-[2px] gap-[2px]">
        {(["fixtures", "live"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSource(s)}
            aria-pressed={source === s}
            className={`font-mono text-[11px] px-[10px] py-[4px] rounded-[6px] ${
              source === s ? "bg-[var(--aws-navy)] text-white font-semibold" : "text-[var(--text-secondary)]"
            }`}
          >{s === "fixtures" ? "Sample" : "Live"}</button>
        ))}
      </div>
    </div>
  );
}
