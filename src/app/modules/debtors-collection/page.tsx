"use client";

// Debtors Collection — the DPD (days past due) view: what each customer owes,
// split by how long it has been outstanding, in two sections: CD-CF and
// APMC + Non-APMC. The parties come from the collections backend's database
// (lib/debtor-calls loadDpdReport) and from nowhere else.
//
// Admin-only, like its tile in lib/modules: scoped roles are bounced by
// useRequireModuleAccess, and any other non-admin gets the no-access panel.
// The section lives in the URL (?section=apmc) so a refresh or a shared link
// opens the same tab.

import { Suspense, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BackLink } from "@/components/BackLink";
import { useIsAdmin, useMe, useRequireAuth, useRequireModuleAccess } from "@/lib/user";
import { compactInr, totalsOf, type DpdParty, type DpdReport, type DpdSectionKey } from "@/lib/debtors";
import { loadDpdReport } from "@/lib/debtor-calls";
import { DebtorsChrome } from "./_chrome";
import { DpdSection } from "./_DpdSection";
import { UploadDialog } from "./_UploadDialog";
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
  // The tab whose Tally export is being uploaded; null when the upload is closed.
  const [uploading, setUploading] = useState<SectionDef | null>(null);
  const tabRefs = useRef<Partial<Record<DpdSectionKey, HTMLButtonElement | null>>>({});

  // Both sections load up front: they are small, and the tabs show each total.
  useEffect(() => {
    if (!authed || !isAdmin) return;
    const ctrl = new AbortController();
    for (const s of SECTIONS) {
      loadDpdReport(s.key, ctrl.signal)
        .then((report) => {
          setLoads((prev) => ({ ...prev, [s.key]: report ? { status: "ready", report } : { status: "missing" } }));
        })
        .catch((err: unknown) => {
          if (ctrl.signal.aborted) return;
          const message = err instanceof Error ? err.message : "Couldn't load the parties from the database.";
          setLoads((prev) => ({ ...prev, [s.key]: { status: "error", message } }));
        });
    }
    return () => ctrl.abort();
  }, [authed, isAdmin, attempt]);

  function retry() {
    setLoads(ALL_LOADING);
    setAttempt((n) => n + 1);
  }

  // A party edited on the screen (its contact number) is already saved in the
  // database; this swaps it into what is on screen, so nothing needs reloading.
  function replaceParty(section: DpdSectionKey, before: DpdParty, after: DpdParty) {
    setLoads((prev) => {
      const state = prev[section];
      if (state.status !== "ready") return prev;
      const parties = state.report.parties.map((p) => (p === before ? after : p));
      return { ...prev, [section]: { status: "ready", report: { ...state.report, parties } } };
    });
  }

  // Not router.replace: this page is prerendered with no query, so after it is
  // opened on ?section=apmc the router still takes the bare address for the one
  // it is on, and replacing to it (the CD-CF tab) did nothing in production —
  // the tab could not be clicked. history.replaceState changes the address
  // without a server round trip, and Next keeps useSearchParams in step with it.
  function selectSection(key: DpdSectionKey) {
    const href = key === SECTIONS[0].key ? "/modules/debtors-collection" : `/modules/debtors-collection?section=${key}`;
    window.history.replaceState(null, "", href);
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
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">Debtors Collection</h1>
          <p className="text-[13px] text-[var(--text-secondary)] mt-1">
            DPD view — what each customer owes, by how long it has been outstanding.
          </p>
        </div>
        {scopeOk && isAdmin ? (
          <button type="button" onClick={() => setUploading(active)} aria-haspopup="dialog" className="inline-flex items-center gap-2 h-9 px-3.5 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] font-semibold text-[var(--text-primary)] hover:bg-[var(--surface-subtle)]">
            <UploadIcon />
            Upload {active.label} from Tally
          </button>
        ) : null}
      </div>
      <UploadDialog
        open={uploading !== null}
        section={uploading?.key ?? active.key}
        label={uploading?.label ?? active.label}
        onClose={() => setUploading(null)}
        onApplied={retry}
      />

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
            <SectionBody
              onUpload={() => setUploading(active)}
              state={loads[active.key]}
              def={active}
              onRetry={retry}
              onPartyChange={(before, after) => replaceParty(active.key, before, after)}
            />
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

function SectionBody({
  state,
  def,
  onRetry,
  onUpload,
  onPartyChange,
}: {
  state: LoadState;
  def: SectionDef;
  onRetry: () => void;
  onUpload: () => void;
  onPartyChange: (before: DpdParty, after: DpdParty) => void;
}) {
  if (state.status === "ready") return <DpdSection report={state.report} def={def} onPartyChange={onPartyChange} />;
  if (state.status === "loading") {
    return <Notice tall>Loading the {def.label} report…</Notice>;
  }
  if (state.status === "missing") {
    return (
      <Notice tall>
        <span className="block font-semibold text-[var(--text-primary)]">No {def.label} report yet</span>
        <span className="block mt-1">
          Upload the {def.label} Group Outstandings export from Tally to build it.
        </span>
        <button type="button" onClick={onUpload} className="mt-3 inline-flex items-center gap-2 h-9 px-3.5 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] font-semibold text-[var(--text-primary)] hover:bg-[var(--surface-subtle)]">
          <UploadIcon />
          Upload {def.label} from Tally
        </button>
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

function UploadIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="w-4 h-4">
      <path d="M8 10.5V2.5M4.5 6 8 2.5 11.5 6M2.5 10.5v2.5a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5v-2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
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
