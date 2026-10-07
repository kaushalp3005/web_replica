"use client";

// Debtors Collection — the DPD (days past due) view: what each customer owes,
// split by how long it has been outstanding, in two sections: CD-CF and
// APMC + Non-APMC. Reads the reports through lib/debtors, which for now serves
// JSON converted from the Tally Excel exports (see that file for the swap to
// the backend).
//
// Admin-only, like its tile in lib/modules: scoped roles are bounced by
// useRequireModuleAccess, and any other non-admin gets the no-access panel.
// The section lives in the URL (?section=apmc) so a refresh or a shared link
// opens the same tab.

import { Suspense, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BackLink } from "@/components/BackLink";
import { useIsAdmin, useMe, useRequireAuth, useRequireModuleAccess } from "@/lib/user";
import { compactInr, fetchDpdReport, totalsOf, type DpdReport, type DpdSectionKey } from "@/lib/debtors";
import { DebtorsChrome } from "./_chrome";
import { DpdSection } from "./_DpdSection";
import { SECTIONS, type SectionDef } from "./_sections";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; report: DpdReport }
  | { status: "missing" }
  | { status: "error"; message: string };

const ALL_LOADING = Object.fromEntries(SECTIONS.map((s) => [s.key, { status: "loading" }])) as Record<DpdSectionKey, LoadState>;

/** useSearchParams forces a client bailout, which Next 16 refuses to prerender
 *  outside a Suspense boundary. */
export default function DebtorsCollectionRoute() {
  return (
    <Suspense
      fallback={
        <DebtorsChrome>
          <p className="py-16 text-center text-[13px] text-[var(--text-secondary)]">Loading…</p>
        </DebtorsChrome>
      }
    >
      <DebtorsCollectionScreen />
    </Suspense>
  );
}

function DebtorsCollectionScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const authed = useRequireAuth(router.replace);
  const scopeOk = useRequireModuleAccess("debtors-collection", router.replace);
  const me = useMe();
  const isAdmin = useIsAdmin();
  const active = SECTIONS.find((s) => s.key === params.get("section")) ?? SECTIONS[0];

  const [loads, setLoads] = useState<Record<DpdSectionKey, LoadState>>(ALL_LOADING);
  const [attempt, setAttempt] = useState(0);
  const tabRefs = useRef<Partial<Record<DpdSectionKey, HTMLButtonElement | null>>>({});

  // Both sections load up front: they are small, and the tabs show each total.
  useEffect(() => {
    if (!authed || !isAdmin) return;
    const ctrl = new AbortController();
    for (const s of SECTIONS) {
      fetchDpdReport(s.key, ctrl.signal)
        .then((report) => {
          setLoads((prev) => ({ ...prev, [s.key]: report ? { status: "ready", report } : { status: "missing" } }));
        })
        .catch((err: unknown) => {
          if (ctrl.signal.aborted) return;
          const message = err instanceof Error ? err.message : "Couldn't load the report.";
          setLoads((prev) => ({ ...prev, [s.key]: { status: "error", message } }));
        });
    }
    return () => ctrl.abort();
  }, [authed, isAdmin, attempt]);

  function retry() {
    setLoads(ALL_LOADING);
    setAttempt((n) => n + 1);
  }

  function selectSection(key: DpdSectionKey) {
    const href = key === SECTIONS[0].key ? "/modules/debtors-collection" : `/modules/debtors-collection?section=${key}`;
    router.replace(href, { scroll: false });
  }

  // Tabs pattern: arrow keys move between tabs (and select), Tab leaves the list.
  function onTabKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = SECTIONS[(i + step + SECTIONS.length) % SECTIONS.length];
    selectSection(next.key);
    tabRefs.current[next.key]?.focus();
  }

  return (
    <DebtorsChrome>
      <div className="mb-3">
        <BackLink parentHref="/modules" label="modules" />
      </div>
      <div className="mb-5">
        <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">Debtors Collection</h1>
        <p className="text-[13px] text-[var(--text-secondary)] mt-1">
          DPD view — what each customer owes, by how long it has been outstanding.
        </p>
      </div>

      {!scopeOk ? null : me === null ? (
        <Notice>Checking your access…</Notice>
      ) : !isAdmin ? (
        <Notice>
          You don&rsquo;t have access to the Debtors Collection module. Ask an administrator to grant you access, or
          switch to a different account.
        </Notice>
      ) : (
        <>
          <div role="tablist" aria-label="DPD sections" className="grid grid-cols-2 gap-2 sm:gap-3 mb-4 sm:max-w-[640px]">
            {SECTIONS.map((s, i) => {
              const on = s.key === active.key;
              return (
                <button
                  key={s.key}
                  ref={(el) => {
                    tabRefs.current[s.key] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`dpd-tab-${s.key}`}
                  aria-selected={on}
                  aria-controls="dpd-panel"
                  tabIndex={on ? 0 : -1}
                  onClick={() => selectSection(s.key)}
                  onKeyDown={(e) => onTabKey(e, i)}
                  className={[
                    "text-left rounded-md border bg-white px-3 sm:px-4 py-2.5 transition-[border-color,box-shadow] duration-150",
                    on
                      ? "border-[var(--aws-orange)] shadow-[0_0_0_1px_var(--aws-orange)]"
                      : "border-[var(--aws-border)] hover:border-[var(--aws-border-strong)]",
                  ].join(" ")}
                >
                  <span className={`block text-[13px] sm:text-[14px] font-semibold ${on ? "text-[var(--aws-orange)]" : "text-[var(--text-primary)]"}`}>
                    {s.label}
                  </span>
                  <span className="mt-0.5 block text-[11px] sm:text-[12px] text-[var(--text-secondary)] tabular-nums">
                    <TabSubtitle state={loads[s.key]} />
                  </span>
                </button>
              );
            })}
          </div>

          {/* Keyed by section: a new tab mounts fresh (unfiltered) and fades in. */}
          <div
            key={active.key}
            role="tabpanel"
            id="dpd-panel"
            aria-labelledby={`dpd-tab-${active.key}`}
            className="transition-opacity duration-300 starting:opacity-0 motion-reduce:transition-none"
          >
            <SectionBody state={loads[active.key]} def={active} onRetry={retry} />
          </div>
        </>
      )}
    </DebtorsChrome>
  );
}

function TabSubtitle({ state }: { state: LoadState }) {
  if (state.status === "ready") {
    const t = totalsOf(state.report.parties);
    return (
      <>
        {compactInr(t.pending)} · {t.count} {t.count === 1 ? "party" : "parties"}
      </>
    );
  }
  if (state.status === "loading") return <>Loading…</>;
  if (state.status === "missing") return <>No report yet</>;
  return <>Couldn&rsquo;t load</>;
}

function SectionBody({ state, def, onRetry }: { state: LoadState; def: SectionDef; onRetry: () => void }) {
  if (state.status === "ready") return <DpdSection report={state.report} def={def} />;
  if (state.status === "loading") {
    return <Notice tall>Loading the {def.label} report…</Notice>;
  }
  if (state.status === "missing") {
    return (
      <Notice tall>
        <span className="block font-semibold text-[var(--text-primary)]">No {def.label} report yet</span>
        <span className="block mt-1">Import the DPD Excel export for this section, then reload this page:</span>
        <code className="block mt-2 mx-auto w-fit max-w-full overflow-x-auto rounded bg-[var(--surface-divider)] px-2 py-1 text-[12px] text-[var(--text-primary)]">
          npm run dpd:import -- --{def.key} &quot;&lt;file&gt;&quot;
        </code>
      </Notice>
    );
  }
  return (
    <Notice tall>
      <span className="block text-[var(--aws-error)]">{state.message}</span>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 h-8 px-3 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] font-medium text-[var(--text-primary)] hover:bg-[var(--surface-subtle)]"
      >
        Try again
      </button>
    </Notice>
  );
}

function Notice({ children, tall = false }: { children: React.ReactNode; tall?: boolean }) {
  return (
    <section
      className={`bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)] ${
        tall ? "min-h-[220px] flex flex-col items-center justify-center text-center" : ""
      }`}
    >
      {children}
    </section>
  );
}
