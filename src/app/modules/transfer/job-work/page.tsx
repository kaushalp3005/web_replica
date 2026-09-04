"use client";

// Job Work — landing. Lists material-out challans with search/status filter and routes to
// the Material Out form and each challan's delivery challan. Ported from
// legacy_frontend/app/[company]/transfer/job-work/page.tsx.
//
// FRONTEND-FIRST: GET /api/v1/job-work/list does not exist yet, so the list renders an
// explicit "backend not built" state rather than an error — the New Material Out path
// works regardless, since the form and challan are entirely client-side up to submit.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { TransferChrome } from "../_chrome";
import { JobWorkApi, isNotBuiltYet, type JobWorkRecord } from "@/lib/jobWork";

const BTN =
  "inline-flex items-center justify-center gap-1 rounded font-medium whitespace-nowrap leading-none h-8 px-3 text-[12px] " +
  "transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--aws-orange)] focus-visible:ring-offset-1";
const BTN_NEUTRAL = `${BTN} border border-[var(--aws-border)] bg-white text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] hover:border-[var(--aws-border-strong)]`;
const BTN_BRAND = `${BTN} border border-violet-300 bg-white text-violet-700 hover:bg-violet-50 hover:border-violet-400`;
const TH_CELL = "px-3 py-2 font-semibold whitespace-nowrap border-b border-r border-[var(--aws-border)] last:border-r-0";
const TD_CELL = "px-3 py-1.5 align-middle border-b border-r border-[var(--aws-border)] last:border-r-0";

const STATUS_TONE: Record<string, string> = {
  sent: "bg-blue-100 text-blue-800",
  partial: "bg-amber-100 text-amber-800",
  closed: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-rose-100 text-rose-800",
};

function fmt(d?: string | null): string {
  if (!d) return "—";
  try {
    const p = new Date(d);
    return Number.isNaN(p.getTime()) ? String(d) : p.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
  } catch { return String(d); }
}
function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

export default function JobWorkLandingPage() {
  const router = useRouter();
  const allowed = useRequireAuth(router.replace);

  const [records, setRecords] = useState<JobWorkRecord[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notBuilt, setNotBuilt] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null); setNotBuilt(false);
    try {
      const res = await JobWorkApi.list({ search: search.trim() || undefined, status: status || undefined, per_page: 50 });
      setRecords(res.records ?? []);
    } catch (err) {
      if (isNotBuiltYet(err)) setNotBuilt(true);
      else setError(err instanceof Error ? err.message : "Failed to load job-work records.");
      setRecords([]);
    } finally { setLoading(false); }
  }, [search, status]);

  // Deferred to a microtask so the synchronous setLoading inside load() doesn't run in the
  // effect body — same pattern as transferIn's resume effect and useRequireAuth itself.
  useEffect(() => {
    if (!allowed) return;
    queueMicrotask(() => { void load(); });
  }, [allowed, load]);

  // No `if (!allowed) return null` gate — that hydration-mismatches (useRequireAuth is
  // true on the server, false on the client's first render). Only the load effect is gated.

  return (
    <TransferChrome title="Job Work">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-[15px] font-semibold">Job Work</h1>
            <p className="text-[12px] text-[var(--text-secondary)]">
              Material sent out for processing and returned against a delivery challan
            </p>
          </div>
          <button onClick={() => router.push("/modules/transfer/job-work/material-out")} className={BTN_BRAND}>
            + New Material Out
          </button>
        </div>

        {/* Filters */}
        <div className="bg-white border border-[var(--aws-border)] rounded-md p-3 flex flex-wrap items-end gap-3">
          <label className="text-[11px] text-[var(--text-secondary)]">
            <span className="block mb-1">Search</span>
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void load(); }}
              placeholder="Challan no or job worker…"
              className="w-64 border border-[var(--aws-border)] rounded px-2 py-1.5 text-[12px] bg-white" />
          </label>
          <label className="text-[11px] text-[var(--text-secondary)]">
            <span className="block mb-1">Status</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)}
              className="w-40 border border-[var(--aws-border)] rounded px-2 py-1.5 text-[12px] bg-white">
              <option value="">All</option>
              <option value="sent">Sent</option>
              <option value="partial">Partially returned</option>
              <option value="closed">Closed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </label>
          <button onClick={() => void load()} disabled={loading} className={BTN_NEUTRAL}>
            {loading ? "Loading…" : "Apply"}
          </button>
        </div>

        {error && <div className="border border-rose-200 bg-rose-50 text-rose-800 rounded-md px-3 py-2 text-[12px]">{error}</div>}

        {notBuilt && (
          <div className="border border-amber-200 bg-amber-50 rounded-md px-4 py-3 text-[12px] text-amber-900 space-y-1">
            <div className="font-semibold">Job-work backend not built yet</div>
            <p>
              <code className="font-mono">GET /api/v1/job-work/list</code> does not exist in server_replica.
              The list will populate once the module lands — the contract it must implement is in{" "}
              <code className="font-mono">src/lib/jobWork.ts</code>.
            </p>
            <p>Creating a Material Out challan and printing it works now; only saving needs the backend.</p>
          </div>
        )}

        {/* Records */}
        <div className="bg-white border border-[var(--aws-border)] rounded-md">
          <div className="px-4 py-3 border-b border-[var(--aws-border)] text-[13px] font-semibold text-violet-700">
            📄 Material Out challans ({records.length})
          </div>
          <div className="p-3">
            <div className="overflow-x-auto border border-[var(--aws-border)] rounded-md">
              <table className="w-full text-[12px] border-separate border-spacing-0">
                <thead className="bg-[var(--surface-subtle)]">
                  <tr className="text-left text-[var(--text-secondary)]">
                    <th className={TH_CELL}>CHALLAN NO</th>
                    <th className={TH_CELL}>DATE</th>
                    <th className={TH_CELL}>JOB WORKER</th>
                    <th className={TH_CELL}>PROCESS</th>
                    <th className={TH_CELL}>FROM</th>
                    <th className={`${TH_CELL} text-right`}>ARTICLES</th>
                    <th className={`${TH_CELL} text-right`}>TOTAL KG</th>
                    <th className={TH_CELL}>STATUS</th>
                    <th className={`${TH_CELL} text-right`}>ACTION</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((r) => (
                    <tr key={r.id} className="hover:bg-gray-50/50">
                      <td className={`${TD_CELL} font-mono`}>{r.challan_no}</td>
                      <td className={TD_CELL}>{fmt(r.job_work_date)}</td>
                      <td className={`${TD_CELL} max-w-[220px] truncate`}>{r.to_party || "—"}</td>
                      <td className={TD_CELL}>{r.sub_category || "—"}</td>
                      <td className={TD_CELL}>{r.from_warehouse || "—"}</td>
                      <td className={`${TD_CELL} text-right tabular-nums`}>{r.lines?.length ?? 0}</td>
                      <td className={`${TD_CELL} text-right tabular-nums`}>
                        {(r.lines ?? []).reduce((s, l) => s + num(l.quantity_kgs), 0).toFixed(3)}
                      </td>
                      <td className={TD_CELL}>
                        <span className={`text-[11px] px-1.5 py-0.5 rounded font-medium ${STATUS_TONE[r.status] ?? "bg-gray-100 text-gray-700"}`}>
                          {r.status}
                        </span>
                      </td>
                      <td className={`${TD_CELL} text-right`}>
                        <button onClick={() => router.push(`/modules/transfer/job-work/dc/${encodeURIComponent(r.challan_no)}`)}
                          className={BTN_NEUTRAL}>Challan</button>
                      </td>
                    </tr>
                  ))}
                  {records.length === 0 && (
                    <tr>
                      <td className={`${TD_CELL} text-center text-[var(--text-secondary)] py-6`} colSpan={9}>
                        {loading ? "Loading…" : notBuilt ? "Nothing to show until the backend lands." : "No job-work challans found."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </TransferChrome>
  );
}
