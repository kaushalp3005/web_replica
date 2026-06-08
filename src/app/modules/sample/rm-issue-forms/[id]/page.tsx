"use client";

// RM Issue / Collection Form detail (Document 015). The Store approves a
// SUBMITTED form, then issues it — entering issued_qty + lot_no per line, which
// fires the 265 Goods Issue (own-only) on the backend. Print renders Doc 015.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { Breadcrumbs, SAMPLE_ROOT } from "@/components/Breadcrumbs";
import { useRequireAuth, useUserInitial, useMe } from "@/lib/user";
import { sampleCaps } from "@/lib/sample-roles";
import {
  getRmForm, approveRmForm, issueRmForm, cancelRmForm, printRmFormBlob,
  type RmForm, type RmIssueResult,
} from "@/lib/rm-issue-form";
import { RmFormStatusPill } from "../../_shared";

interface IssueRow { id: number; issued_qty: string; lot_no: string }

function num(v: number | string | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n.toLocaleString("en-IN") : String(v);
}

export default function RmFormDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const authed = useRequireAuth(router.replace);
  const initial = useUserInitial();
  const me = useMe();
  const caps = useMemo(() => sampleCaps(me), [me]);

  const [form, setForm] = useState<RmForm | null>(null);
  const [issueRows, setIssueRows] = useState<Record<number, IssueRow>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const f = await getRmForm(id);
      setForm(f);
      const rows: Record<number, IssueRow> = {};
      for (const ln of f.lines ?? []) {
        if (ln.id == null) continue;
        rows[ln.id] = {
          id: ln.id,
          issued_qty: String(ln.issued_qty ?? (ln.ownership === "CUSTOMER" ? "" : ln.reqd_qty ?? "")),
          lot_no: ln.lot_no ?? "",
        };
      }
      setIssueRows(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load form");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (!authed || !Number.isFinite(id)) return;
    queueMicrotask(() => { void load(); });
  }, [authed, id, load]);

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Action failed"); }
    finally { setBusy(false); }
  }, [load]);

  function recordIssue() {
    const issued: RmIssueResult[] = Object.values(issueRows).map((r) => ({
      line_id: r.id, issued_qty: Number(r.issued_qty) || 0, lot_no: r.lot_no || null,
    }));
    run(() => issueRmForm(id, issued));
  }
  function cancelForm() {
    const reason = window.prompt("Reason for cancelling this RM issue form?");
    if (reason == null) return;
    run(() => cancelRmForm(id, reason || "cancelled"));
  }
  async function printForm() {
    setBusy(true); setError(null);
    try {
      const blob = await printRmFormBlob(id);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Print failed");
    } finally {
      setBusy(false);
    }
  }

  if (!authed) return null;

  const editable = form?.status === "APPROVED" && caps.canInventory;

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-4 sm:px-6 gap-4">
        <BrandMark />
        <nav className="text-[12px] text-[#d5dbdb] hidden sm:flex items-center gap-2 ml-2">
          <button onClick={() => router.push("/modules/sample/rm-issue-forms")} className="hover:underline">RM Issue Forms</button>
          <span>/</span><span className="text-white">{form?.form_number ?? id}</span>
        </nav>
        <div className="flex-1" />
        <button onClick={() => router.push("/modules/profile")} aria-label="Profile"
          className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]">{initial}</button>
      </header>

      <main className="flex-1 max-w-[900px] w-full mx-auto px-4 sm:px-6 py-6">
        <Breadcrumbs items={[...SAMPLE_ROOT, { label: "RM forms", href: "/modules/sample/rm-issue-forms" }, { label: form?.form_number ?? String(id) }]} className="mb-3" />
        {error && <div className="mb-4 rounded-md border border-[#f0c7be] bg-[#fdf3f1] px-3 py-2 text-[13px] text-[#b1361e]">{error}</div>}

        {loading || !form ? (
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[13px] text-[var(--text-secondary)]">{loading ? "Loading…" : "Not found."}</div>
        ) : (
          <div className="space-y-5">
            <section className="bg-white border border-[var(--aws-border)] rounded-md p-4">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-[20px] font-semibold text-[var(--text-primary)] font-mono">{form.form_number}</h1>
                <RmFormStatusPill status={form.status} />
                {form.issue_mat_doc_id && <span className="text-[12px] text-[var(--text-success)]">GI {form.issue_mat_doc_id}</span>}
              </div>
              <dl className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-y-2 gap-x-4 text-[13px]">
                <Field label="Trial" value={form.trial_name ?? "—"} />
                <Field label="Product" value={form.product_name ?? "—"} />
                <Field label="Customer" value={form.customer_name ?? "Internal Use"} />
                <Field label="Purpose" value={form.purpose_tag ?? "—"} />
                <Field label="Created" value={(form.created_at ?? "").slice(0, 10)} />
              </dl>
              {form.status === "CANCELLED" && form.cancellation_reason && (
                <p className="mt-2 text-[12px] text-[var(--aws-error)]">Cancelled — {form.cancellation_reason}</p>
              )}
            </section>

            {/* Actions */}
            <div className="flex flex-wrap gap-2">
              {form.status === "SUBMITTED" && caps.canInventory && (
                <button disabled={busy} onClick={() => run(() => approveRmForm(id))}
                  className="h-9 px-4 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">Approve</button>
              )}
              {editable && (
                <button disabled={busy} onClick={recordIssue}
                  className="h-9 px-4 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">Record issue & post GI</button>
              )}
              {form.status !== "DRAFT" && (
                <button disabled={busy} onClick={printForm}
                  className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] disabled:opacity-50 hover:bg-[var(--surface-subtle)]">Print (Doc 015)</button>
              )}
              {!["ISSUED", "CLOSED", "CANCELLED"].includes(form.status) && caps.canNpd && (
                <button disabled={busy} onClick={cancelForm}
                  className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] disabled:opacity-50 hover:bg-[var(--surface-subtle)]">Cancel</button>
              )}
            </div>

            {/* Lines */}
            <section className="bg-white border border-[var(--aws-border)] rounded-md p-4">
              <h2 className="text-[13px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide mb-3">Raw materials</h2>
              {(form.lines?.length ?? 0) === 0 ? (
                <p className="text-[13px] text-[var(--text-muted)]">No material lines.</p>
              ) : (
                <table className="w-full text-[13px]">
                  <thead><tr className="text-left text-[12px] text-[var(--text-secondary)]">
                    <th className="py-1.5 font-semibold">Material</th>
                    <th className="py-1.5 font-semibold">Own/Cust</th>
                    <th className="py-1.5 font-semibold text-right">Reqd</th>
                    <th className="py-1.5 font-semibold text-right">Issued</th>
                    <th className="py-1.5 font-semibold">Lot</th>
                    <th className="py-1.5 font-semibold">UOM</th>
                  </tr></thead>
                  <tbody>
                    {form.lines!.map((ln) => {
                      const row = ln.id != null ? issueRows[ln.id] : undefined;
                      const cust = ln.ownership === "CUSTOMER";
                      return (
                        <tr key={ln.id ?? ln.sku_name} className="border-t border-[var(--surface-divider)]">
                          <td className="py-1.5">{ln.sku_name}{ln.location ? <span className="text-[var(--text-muted)]"> · {ln.location}</span> : null}</td>
                          <td className="py-1.5">{cust ? <span className="text-[var(--aws-error)]">CUSTOMER</span> : "OWN"}</td>
                          <td className="py-1.5 text-right">{num(ln.reqd_qty)}</td>
                          <td className="py-1.5 text-right">
                            {editable && !cust && row ? (
                              <input className="form-input !h-7 !w-24 text-right" type="number" step="0.001" value={row.issued_qty}
                                onChange={(e) => setIssueRows((p) => ({ ...p, [ln.id!]: { ...p[ln.id!], issued_qty: e.target.value } }))} />
                            ) : (cust ? "—" : num(ln.issued_qty))}
                          </td>
                          <td className="py-1.5">
                            {editable && !cust && row ? (
                              <input className="form-input !h-7 !w-28" value={row.lot_no}
                                onChange={(e) => setIssueRows((p) => ({ ...p, [ln.id!]: { ...p[ln.id!], lot_no: e.target.value } }))} />
                            ) : (ln.lot_no ?? "—")}
                          </td>
                          <td className="py-1.5">{ln.uom}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              {editable && <p className="mt-2 text-[11px] text-[var(--text-muted)]">Customer-supplied lines are recorded only — no stock is issued for them.</p>}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-[11px] text-[var(--text-muted)]">{label}</dt><dd className="text-[var(--text-primary)]">{value}</dd></div>;
}
