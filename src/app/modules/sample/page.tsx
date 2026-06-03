"use client";

// Sample requisition queue (checklist B4). Hydration-safe: state seeds from a
// tab-scoped sessionStorage cache via lazy-init, but the first render emits a
// cache-free shell behind the `mounted` gate so SSR and the client's first
// paint match (see lib/sample-list-cache.ts and the JC list page this mirrors).

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { BackLink } from "@/components/BackLink";
import { useRequireAuth, useUserInitial, useMe } from "@/lib/user";
import { sampleCaps } from "@/lib/sample-roles";
import { listRequisitions, type Requisition } from "@/lib/sample";
import { loadSampleListCache, saveSampleListCache } from "@/lib/sample-list-cache";
import { STATUS_STYLES, TYPE_LABEL, StatusPill } from "./_shared";

const STATUS_OPTIONS = Object.keys(STATUS_STYLES);
const TYPE_OPTIONS = Object.keys(TYPE_LABEL);

// Module-level so the component isn't re-created on every render (React 19
// react-hooks/static-components). Header chrome shared by the shell + main view.
function Shell({ initial, router, children }: {
  initial: string;
  router: ReturnType<typeof useRouter>;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-4 sm:px-6 gap-4">
        <BrandMark />
        <span className="text-[#d5dbdb] text-[13px] hidden sm:inline">Console</span>
        <nav className="text-[12px] text-[#d5dbdb] hidden md:flex items-center gap-2 ml-2">
          <button onClick={() => router.push("/modules")} className="hover:underline">Modules</button>
          <span>/</span>
          <span className="text-white">Sample</span>
        </nav>
        <div className="flex-1" />
        <button
          onClick={() => router.push("/modules/profile")}
          aria-label="Open profile" title="Profile"
          className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]"
        >{initial}</button>
      </header>
      <main className="flex-1 max-w-[1280px] w-full mx-auto px-4 sm:px-6 py-6">{children}</main>
    </div>
  );
}

export default function SampleQueuePage() {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);
  const initial = useUserInitial();
  const me = useMe();
  const caps = useMemo(() => sampleCaps(me), [me]);

  const [cache] = useState(() => loadSampleListCache());
  const [status, setStatus] = useState(() => cache?.status ?? "");
  const [sampleType, setSampleType] = useState(() => cache?.sampleType ?? "");
  const [entity, setEntity] = useState(() => cache?.entity ?? "");
  const [rows, setRows] = useState<Requisition[]>(() => cache?.rows ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [mounted, setMounted] = useState(false);
  useEffect(() => { queueMicrotask(() => setMounted(true)); }, []);

  // Seed-then-refresh: cached rows paint instantly, the fetch keeps them fresh.
  const firstRun = useRef(true);
  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    (async () => {
      // On the very first run, if we hydrated rows from cache, skip the
      // spinner so the cached list stays visible while we refresh silently.
      if (!(firstRun.current && (cache?.rows?.length ?? 0) > 0)) setLoading(true);
      firstRun.current = false;
      setError(null);
      try {
        const data = await listRequisitions({ status, sample_type: sampleType, entity, limit: 200 });
        if (cancelled) return;
        setRows(data);
        saveSampleListCache({ status, sampleType, entity, rows: data, scrollY: 0 });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load requisitions");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [authed, status, sampleType, entity, cache]);

  function openRow(id: number) {
    router.push(`/modules/sample/${id}`);
  }

  if (!mounted) {
    return (
      <Shell initial={initial} router={router}>
        <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[var(--text-secondary)]">
          <span className="inline-flex items-center gap-2 text-[13px]">
            <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
            Loading sample requisitions…
          </span>
        </div>
      </Shell>
    );
  }

  return (
    <Shell initial={initial} router={router}>
      <BackLink parentHref="/modules" label="Modules" className="mb-3" />
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="min-w-0">
          <h1 className="text-[22px] leading-7 font-semibold text-[var(--text-primary)]">Sample Requisitions</h1>
          <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">{rows.length} shown</p>
        </div>
        <div className="flex-1" />
        {caps.canRequest && (
          <button
            onClick={() => router.push("/modules/sample/new")}
            className="h-9 px-4 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium hover:bg-[var(--aws-orange-hover)]"
          >+ New requisition</button>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4">
        <select className="form-input !w-auto" value={sampleType} onChange={(e) => setSampleType(e.target.value)} aria-label="Sample type">
          <option value="">All types</option>
          {TYPE_OPTIONS.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
        <select className="form-input !w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
        </select>
        <select className="form-input !w-auto" value={entity} onChange={(e) => setEntity(e.target.value)} aria-label="Entity">
          <option value="">All entities</option>
          <option value="cfpl">CFPL</option>
          <option value="cdpl">CDPL</option>
        </select>
        {loading && <span className="self-center text-[12px] text-[var(--text-muted)]">Refreshing…</span>}
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-[#f0c7be] bg-[#fdf3f1] px-3 py-2 text-[13px] text-[#b1361e]">{error}</div>
      )}

      {rows.length === 0 && !loading ? (
        <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[13px] text-[var(--text-secondary)]">
          No requisitions match these filters.
        </div>
      ) : (
        <>
          {/* Mobile: cards. md+: table. (responsive — hide columns via layout swap, not overflow.) */}
          <div className="grid grid-cols-1 gap-2 md:hidden">
            {rows.map((r) => (
              <button key={r.id} onClick={() => openRow(r.id)}
                className="text-left bg-white border border-[var(--aws-border)] rounded-md p-3 hover:border-[var(--aws-orange)]">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-[13px] text-[var(--text-primary)]">{r.requisition_number}</span>
                  <StatusPill status={r.status} />
                </div>
                <div className="mt-1 text-[12px] text-[var(--text-secondary)] flex flex-wrap gap-x-3">
                  <span>{TYPE_LABEL[r.sample_type] ?? r.sample_type}</span>
                  <span className="uppercase">{r.entity}</span>
                  <span>{(r.created_at ?? "").slice(0, 10)}</span>
                </div>
              </button>
            ))}
          </div>

          <div className="hidden md:block bg-white border border-[var(--aws-border)] rounded-md overflow-hidden">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-[var(--surface-subtle)] text-left text-[12px] text-[var(--text-secondary)]">
                  <th className="px-3 py-2 font-semibold">Requisition</th>
                  <th className="px-3 py-2 font-semibold">Type</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 font-semibold">Entity</th>
                  <th className="px-3 py-2 font-semibold">Created</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} onClick={() => openRow(r.id)}
                    className="border-t border-[var(--surface-divider)] hover:bg-[var(--surface-subtle)] cursor-pointer">
                    <td className="px-3 py-2 font-medium text-[var(--text-primary)]">{r.requisition_number}</td>
                    <td className="px-3 py-2">{TYPE_LABEL[r.sample_type] ?? r.sample_type}</td>
                    <td className="px-3 py-2"><StatusPill status={r.status} /></td>
                    <td className="px-3 py-2 uppercase">{r.entity}</td>
                    <td className="px-3 py-2 text-[var(--text-secondary)]">{(r.created_at ?? "").slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Shell>
  );
}
