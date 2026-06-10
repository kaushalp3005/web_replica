"use client";

// NPD samples queue — the standalone NPD Development module. Lists
// only NPD requisitions (sample_type=NPD); creation goes through the
// purpose-built NPD form at /modules/npd-development/new. Hydration-safe via a
// `mounted` gate; no sessionStorage seed (this is a secondary list, so a clean
// empty-first render avoids any SSR/client mismatch).

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { useRequireAuth, useUserInitial, useMe } from "@/lib/user";
import { sampleCaps } from "@/lib/sample-roles";
import { listRequisitions, npdReview, WAREHOUSES, type Requisition } from "@/lib/sample";
import { STATUS_STYLES, StatusPill } from "../sample/_shared";

const STATUS_OPTIONS = Object.keys(STATUS_STYLES);

// Module-level so the component isn't re-created each render (React 19
// react-hooks/static-components). Header chrome shared by shell + main view.
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
          <span className="text-white">NPD Development</span>
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

// Per-row NPD actions — approve / reject / hold (SUBMITTED · ON_HOLD) or
// develop (BH_APPROVED). NPD team only; clicks stop row navigation.
function RowActions({ r, canNpd, busy, onApprove, onReject, onHold, onDevelop, onOpen }: {
  r: Requisition; canNpd: boolean; busy: boolean;
  onApprove: () => void; onReject: () => void; onHold: () => void; onDevelop: () => void; onOpen: () => void;
}) {
  if (!canNpd) return <span className="text-[var(--text-muted)]">—</span>;
  const s = r.status;
  const btn = "h-7 px-2.5 rounded-[2px] text-[12px] font-medium disabled:opacity-50";
  if (s === "SUBMITTED" || s === "ON_HOLD") {
    return (
      <div className="flex flex-wrap gap-1.5">
        <button disabled={busy} onClick={(e) => { e.stopPropagation(); onApprove(); }}
          className={`${btn} bg-[var(--aws-orange)] text-white hover:bg-[var(--aws-orange-hover)]`}>Approve</button>
        <button disabled={busy} onClick={(e) => { e.stopPropagation(); onReject(); }}
          className={`${btn} border border-[#f0c7be] bg-[#fdf3f1] text-[#b1361e] hover:bg-[#fbe9e4]`}>Reject</button>
        {s === "SUBMITTED" && (
          <button disabled={busy} onClick={(e) => { e.stopPropagation(); onHold(); }}
            className={`${btn} border border-[#fde68a] bg-[#fef9c3] text-[#854d0e] hover:bg-[#fdf08a]`}>Hold</button>
        )}
      </div>
    );
  }
  // Once a dev job card was started from this request, show Open (to that card).
  if (r.linked_dev_jc_id != null) {
    return (
      <button onClick={(e) => { e.stopPropagation(); onOpen(); }}
        className={`${btn} border border-[var(--aws-border-strong)] bg-white hover:bg-[var(--surface-subtle)]`}>Open</button>
    );
  }
  if (s === "BH_APPROVED") {
    return (
      <button disabled={busy} onClick={(e) => { e.stopPropagation(); onDevelop(); }}
        className={`${btn} border border-[var(--aws-border-strong)] bg-white hover:bg-[var(--surface-subtle)]`}>Develop</button>
    );
  }
  return <span className="text-[var(--text-muted)]">—</span>;
}

// One row of the merged "New NPD sample" menu.
function MenuItem({ title, desc, onClick }: { title: string; desc: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="block w-full text-left px-3 py-2 hover:bg-[var(--surface-subtle)]">
      <span className="block text-[13px] font-medium text-[var(--text-primary)]">{title}</span>
      <span className="block text-[11px] text-[var(--text-muted)]">{desc}</span>
    </button>
  );
}

export default function NpdQueuePage() {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);
  const initial = useUserInitial();
  const me = useMe();
  const caps = useMemo(() => sampleCaps(me), [me]);

  const [status, setStatus] = useState("");
  const [warehouse, setWarehouse] = useState("");
  const [rows, setRows] = useState<Requisition[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);   // "New NPD sample" merged menu
  const [reloadKey, setReloadKey] = useState(0);     // bump to re-fetch after an action
  const [busyId, setBusyId] = useState<number | null>(null);
  const [reviewModal, setReviewModal] = useState<{ id: number; action: "REJECT" | "HOLD"; label: string } | null>(null);
  const [reason, setReason] = useState("");

  const [mounted, setMounted] = useState(false);
  useEffect(() => { queueMicrotask(() => setMounted(true)); }, []);

  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await listRequisitions({ status, sample_type: "NPD", warehouse, limit: 200 });
        if (!cancelled) setRows(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load NPD samples");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [authed, status, warehouse, reloadKey]);

  function openRow(id: number) {
    router.push(`/modules/sample/${id}`);
  }

  // NPD review from the list — approve directly; reject/hold go through the
  // reason modal (the backend requires a reason for those).
  async function runReview(id: number, action: "APPROVE" | "REJECT" | "HOLD", reasonText?: string) {
    setBusyId(id); setError(null);
    try {
      await npdReview(id, action, reasonText);
      setReviewModal(null); setReason("");
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusyId(null);
    }
  }

  if (!mounted) {
    return (
      <Shell initial={initial} router={router}>
        <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[var(--text-secondary)]">
          <span className="inline-flex items-center gap-2 text-[13px]">
            <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
            Loading NPD samples…
          </span>
        </div>
      </Shell>
    );
  }

  return (
    <Shell initial={initial} router={router}>
      <Breadcrumbs items={[{ label: "Modules", href: "/modules" }, { label: "NPD Development" }]} className="mb-3" />
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="min-w-0">
          <h1 className="text-[22px] leading-7 font-semibold text-[var(--text-primary)]">NPD samples</h1>
          <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">{rows.length} shown · new product development</p>
        </div>
        <div className="flex-1" />
        <button
          onClick={() => router.push("/modules/sample/rm-issue-forms")}
          title="Raw material issue / collection forms (Document 015)"
          className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] font-medium hover:bg-[var(--surface-subtle)]"
        >RM forms</button>
        {caps.canRequest && (
          <div className="relative">
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="h-9 px-4 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium hover:bg-[var(--aws-orange-hover)] inline-flex items-center gap-1.5"
            >
              + New NPD sample
              <svg viewBox="0 0 20 20" className={`w-3.5 h-3.5 transition-transform ${menuOpen ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 7l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            {menuOpen && (
              <>
                <button type="button" aria-hidden tabIndex={-1} className="fixed inset-0 z-10 cursor-default" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 z-20 mt-1 w-64 bg-white border border-[var(--aws-border-strong)] rounded-[2px] shadow-md py-1">
                  <MenuItem title="Sample requisition" desc="NPD · Customer trial · Convert" onClick={() => { setMenuOpen(false); router.push("/modules/npd-development/new"); }} />
                  {caps.canNpd && <MenuItem title="Development job card" desc="R&amp;D — build & promote a BOM" onClick={() => { setMenuOpen(false); router.push("/modules/npd-development/job-cards/new"); }} />}
                  <div className="my-1 border-t border-[var(--surface-divider)]" />
                  <MenuItem title="Browse job cards" desc="Open existing development job cards" onClick={() => { setMenuOpen(false); router.push("/modules/npd-development/job-cards"); }} />
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4">
        <select className="form-input !w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
        </select>
        <select className="form-input !w-auto" value={warehouse} onChange={(e) => setWarehouse(e.target.value)} aria-label="Warehouse">
          <option value="">All warehouses</option>
          {WAREHOUSES.map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
        {loading && <span className="self-center text-[12px] text-[var(--text-muted)]">Refreshing…</span>}
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-[#f0c7be] bg-[#fdf3f1] px-3 py-2 text-[13px] text-[#b1361e]">{error}</div>
      )}

      {rows.length === 0 && !loading ? (
        <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[13px] text-[var(--text-secondary)]">
          No NPD samples match these filters.
        </div>
      ) : (
        <>
          {/* Mobile: cards. md+: full-field table. Long values truncate with a
              hover tooltip (title) showing the full text. */}
          <div className="grid grid-cols-1 gap-2 md:hidden">
            {rows.map((r) => (
              <div key={r.id} className="bg-white border border-[var(--aws-border)] rounded-md p-3 hover:border-[var(--aws-orange)]">
                <button type="button" onClick={() => openRow(r.id)} className="block w-full text-left">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-[13px] text-[var(--text-primary)] truncate" title={r.requisition_number}>{r.requisition_number}</span>
                    <StatusPill status={r.status} />
                  </div>
                  <div className="mt-1 text-[12px] text-[var(--text-secondary)] flex flex-wrap gap-x-3 gap-y-0.5">
                    <span title={`Request ID ${r.request_id ?? ""}`}>#{r.request_id ?? "—"}</span>
                    <span>{r.warehouse}</span>
                    {r.quantity != null && <span>Qty {r.quantity}</span>}
                    <span>{(r.created_at ?? "").slice(0, 10)}</span>
                  </div>
                  {r.npd_target_name && (
                    <div className="mt-1 text-[12px] text-[var(--text-secondary)] truncate" title={r.npd_target_name}>Target: {r.npd_target_name}</div>
                  )}
                </button>
                {caps.canNpd && (r.status === "SUBMITTED" || r.status === "ON_HOLD" || r.status === "BH_APPROVED" || r.linked_dev_jc_id != null) && (
                  <div className="mt-2 pt-2 border-t border-[var(--surface-divider)]">
                    <RowActions r={r} canNpd={caps.canNpd} busy={busyId === r.id}
                      onApprove={() => runReview(r.id, "APPROVE")}
                      onReject={() => setReviewModal({ id: r.id, action: "REJECT", label: String(r.request_id ?? r.requisition_number) })}
                      onHold={() => setReviewModal({ id: r.id, action: "HOLD", label: String(r.request_id ?? r.requisition_number) })}
                      onDevelop={() => router.push(`/modules/npd-development/job-cards/new?req=${r.id}`)}
                      onOpen={() => router.push(`/modules/npd-development/job-cards/${r.linked_dev_jc_id}`)} />
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="hidden md:block bg-white border border-[var(--aws-border)] rounded-md overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-[var(--surface-subtle)] text-left text-[12px] text-[var(--text-secondary)]">
                  <th className="px-3 py-2 font-semibold">Request ID</th>
                  <th className="px-3 py-2 font-semibold">Requisition</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 font-semibold">Warehouse</th>
                  <th className="px-3 py-2 font-semibold">Target article</th>
                  <th className="px-3 py-2 font-semibold text-right">Qty</th>
                  <th className="px-3 py-2 font-semibold">Purpose</th>
                  <th className="px-3 py-2 font-semibold">Team</th>
                  <th className="px-3 py-2 font-semibold">Created</th>
                  <th className="px-3 py-2 font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} onClick={() => openRow(r.id)}
                    className="border-t border-[var(--surface-divider)] hover:bg-[var(--surface-subtle)] cursor-pointer">
                    <td className="px-3 py-2 text-[var(--text-secondary)] tabular-nums">{r.request_id ?? "—"}</td>
                    <td className="px-3 py-2 font-medium text-[var(--text-primary)] max-w-[180px] truncate" title={r.requisition_number}>{r.requisition_number}</td>
                    <td className="px-3 py-2"><StatusPill status={r.status} /></td>
                    <td className="px-3 py-2">{r.warehouse}</td>
                    <td className="px-3 py-2 max-w-[200px] truncate" title={r.npd_target_name ?? ""}>{r.npd_target_name ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.quantity ?? "—"}</td>
                    <td className="px-3 py-2 max-w-[160px] truncate" title={r.purpose_tag ?? ""}>{r.purpose_tag ?? "—"}</td>
                    <td className="px-3 py-2 max-w-[160px] truncate" title={r.requestor_team ?? ""}>{r.requestor_team ?? "—"}</td>
                    <td className="px-3 py-2 text-[var(--text-secondary)] whitespace-nowrap">{(r.created_at ?? "").slice(0, 10)}</td>
                    <td className="px-3 py-2">
                      <RowActions r={r} canNpd={caps.canNpd} busy={busyId === r.id}
                        onApprove={() => runReview(r.id, "APPROVE")}
                        onReject={() => setReviewModal({ id: r.id, action: "REJECT", label: String(r.request_id ?? r.requisition_number) })}
                        onHold={() => setReviewModal({ id: r.id, action: "HOLD", label: String(r.request_id ?? r.requisition_number) })}
                        onDevelop={() => router.push(`/modules/npd-development/job-cards/new?req=${r.id}`)}
                        onOpen={() => router.push(`/modules/npd-development/job-cards/${r.linked_dev_jc_id}`)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Reason prompt for reject / hold (approve is direct). */}
      {reviewModal && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-3" onClick={() => setReviewModal(null)}>
          <div className="bg-white rounded-md w-full max-w-md p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[15px] font-semibold mb-1">{reviewModal.action === "REJECT" ? "Reject" : "Hold"} request {reviewModal.label}</h3>
            <label className="block text-[11px] text-[var(--text-secondary)] mt-2">Reason (required)
              <textarea className="form-input mt-0.5 !h-20 py-1.5" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
            </label>
            <div className="flex gap-2 mt-4">
              <button onClick={() => setReviewModal(null)}
                className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] hover:bg-[var(--surface-subtle)]">Cancel</button>
              <div className="flex-1" />
              <button disabled={busyId === reviewModal.id || !reason.trim()}
                onClick={() => runReview(reviewModal.id, reviewModal.action, reason)}
                className="h-9 px-5 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">{busyId === reviewModal.id ? "Working…" : "Confirm"}</button>
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
}
