"use client";

// The single data seam for the Inventory Ledger module. Everything the module
// shows is derived from one flat leaf set; this provider supplies it from either
// the built-in FIXTURES or the LIVE backend (GET /api/v1/ledger/leaves), chosen
// by a feature flag + a runtime toggle. Swap the whole module to real data by
// setting NEXT_PUBLIC_LEDGER_LIVE=1 (or flicking the Sample/Live switch).
//
// Hydration-safe: the initial source is the env default on both server and the
// client's first paint; the toggle only changes it after mount. The layout keeps
// this provider mounted across the module's routes, so a chosen source persists
// while navigating group → item → ledger (a full reload resets to the default).

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { LedgerApi } from "@/lib/ledger";
import type { LeafItem } from "@/lib/ledger";
import { LEDGER_LEAVES } from "./_fixtures";

export type LedgerSource = "fixtures" | "live";
const ENV_LIVE = process.env.NEXT_PUBLIC_LEDGER_LIVE === "1";

export interface LedgerData {
  leaves: LeafItem[];
  loading: boolean;
  error: string | null;
  source: LedgerSource;
  setSource: (s: LedgerSource) => void;
  reload: () => void;
}

const Ctx = createContext<LedgerData | null>(null);

export function LedgerDataProvider({ children }: { children: React.ReactNode }) {
  const [source, setSourceState] = useState<LedgerSource>(ENV_LIVE ? "live" : "fixtures");
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
        const res = await LedgerApi.leaves(ac.signal);
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

  const value: LedgerData = source === "live"
    ? { leaves: remote.data ?? [], loading: remote.loading, error: remote.error, source, setSource, reload }
    : { leaves: LEDGER_LEAVES, loading: false, error: null, source, setSource, reload };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLedgerLeaves(): LedgerData {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLedgerLeaves must be used within LedgerDataProvider");
  return v;
}

// ── Loading / error / empty gate ───────────────────────────────────
export function LedgerGate({ children }: { children: React.ReactNode }) {
  const { leaves, loading, error, reload, source } = useLedgerLeaves();
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
  if (source === "live" && leaves.length === 0) {
    return <div className="rounded-[11px] border border-[var(--aws-border)] bg-white p-[14px] font-mono text-[12px] text-[var(--text-muted)]">No ledger data returned. Once the backend is seeded this will populate.</div>;
  }
  return <>{children}</>;
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
