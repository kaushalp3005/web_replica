"use client";

// Business-head review / approval screen — FIXTURES STUB (API-later).
//
// The CR itself is loaded live (GET is Phase 1), but the approve / reject / hold
// decision + notification email are NOT live yet (backend Phase 3). The decision
// buttons run through mockApplyApproval() and update the status OPTIMISTICALLY
// only — nothing is persisted. When the backend lands, swap mockApplyApproval for
// the real /approve (or updateCustomerReturn status) call; the rest of the screen
// stays. See ../../_fixtures.ts and the port design (§7.5 approval_service).

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useRequireAuth, useIsAdmin } from "@/lib/user";
import { getCustomerReturn, type CRWithDetails, type CRStatus } from "@/lib/customer-returns";
import { CustomerReturnsChrome } from "../../_chrome";
import { StatusBadge, ErrorBanner, InfoBanner, SuccessBanner, useCompany, fmtDate, fmtDateTime, num } from "../../_shared";
import { mockApplyApproval, SAMPLE_CR, type ApprovalAction } from "../../_fixtures";

const ACTIONS: { action: ApprovalAction; label: string; cls: string }[] = [
  { action: "approve", label: "Approve", cls: "bg-[var(--text-success)]" },
  { action: "hold", label: "Hold", cls: "bg-[#6b3fa0]" },
  { action: "reject", label: "Reject", cls: "bg-[var(--aws-error)]" },
];

export default function CustomerReturnApprovePage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const crId = decodeURIComponent(params.id);
  useRequireAuth(router.replace);
  const isAdmin = useIsAdmin();
  const [company] = useCompany();

  const [data, setData] = useState<CRWithDetails | null>(null);
  const [usingSample, setUsingSample] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [status, setStatus] = useState<CRStatus | null>(null);
  const [remark, setRemark] = useState("");
  const [busy, setBusy] = useState<ApprovalAction | null>(null);
  const [decision, setDecision] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const cr = await getCustomerReturn(company, crId);
      setData(cr);
      setStatus(cr.status);
      setUsingSample(false);
    } catch {
      // Live record not reachable — show the fixture so the stub still demos.
      setData(SAMPLE_CR);
      setStatus(SAMPLE_CR.status);
      setUsingSample(true);
    } finally {
      setLoading(false);
    }
  }, [company, crId]);

  useEffect(() => {
    if (!isAdmin) return;
    // Defer so the first setState isn't synchronous in the effect body.
    queueMicrotask(() => { load(); });
  }, [isAdmin, load]);

  async function act(action: ApprovalAction) {
    setBusy(action);
    setDecision(null);
    try {
      const res = await mockApplyApproval(action);
      setStatus(res.status);
      setDecision(
        `Preview only: this CR would be marked “${res.status}”${remark ? ` (remark: ${remark})` : ""}. ` +
          `The approval + email backend isn’t wired yet (Phase 3), so nothing was saved.`,
      );
    } finally {
      setBusy(null);
    }
  }

  if (!isAdmin) {
    return (
      <CustomerReturnsChrome title="Review">
        <section className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)]">
          You don&rsquo;t have access to the Customer Returns module.
        </section>
      </CustomerReturnsChrome>
    );
  }

  if (loading) {
    return (
      <CustomerReturnsChrome title="Review">
        <div className="p-8 text-[13px] text-[var(--text-secondary)]">Loading…</div>
      </CustomerReturnsChrome>
    );
  }
  if (!data) return null;

  const totalQty = data.lines.reduce((s, l) => s + num(l.qty), 0);
  const totalValue = data.lines.reduce((s, l) => s + num(l.value), 0);

  return (
    <CustomerReturnsChrome title="Review">
      <div className="flex items-start gap-3 mb-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-[18px] font-bold text-[var(--text-primary)] break-all">{data.rtv_id}</h1>
            {status && <StatusBadge status={status} />}
          </div>
          <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">
            Business-head review · {data.business_head || "no business head set"}
          </p>
        </div>
        <div className="flex-1" />
        <Link href={`/modules/customer-returns/${data.rtv_id}`} className="text-[13px] rounded-md border border-[var(--aws-border)] px-3 py-1.5 bg-white">
          Open detail
        </Link>
      </div>

      <div className="mb-4">
        <InfoBanner>
          <strong>Preview / stub.</strong> Approve, Reject and Hold are not connected to the backend yet — the approval
          service, signed magic-link email and status transition are a later phase. Decisions here update the status on
          screen only and are not saved.
        </InfoBanner>
      </div>

      {usingSample && (
        <div className="mb-4">
          <ErrorBanner message={`Live record ${crId} could not be loaded for ${company}; showing a sample CR so the review screen still renders.`} />
        </div>
      )}
      {error && <div className="mb-4"><ErrorBanner message={error} /></div>}
      {decision && <div className="mb-4"><SuccessBanner message={decision} /></div>}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <section className="bg-white border border-[var(--aws-border)] rounded-md p-4">
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)] mb-3">CR Information</h2>
            <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3 text-[13px]">
              <Info label="Factory Unit" value={data.factory_unit} />
              <Info label="Customer" value={data.customer} />
              <Info label="Invoice Number" value={data.invoice_number} />
              <Info label="Challan No" value={data.challan_no} />
              <Info label="Sales POC" value={data.sales_poc} />
              <Info label="Business Head" value={data.business_head} />
              <Info label="CR Date" value={fmtDate(data.rtv_date)} />
              <Info label="Created" value={fmtDateTime(data.created_ts)} />
            </dl>
            {data.remark && (
              <div className="mt-3 pt-3 border-t border-[var(--aws-border)]">
                <Info label="Remark" value={data.remark} />
              </div>
            )}
          </section>

          <section className="bg-white border border-[var(--aws-border)] rounded-md p-4">
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)] mb-3">Line Items ({data.lines.length})</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-[var(--aws-border)] text-left text-[var(--text-secondary)]">
                    <th className="px-2 py-1.5 font-medium">Item</th>
                    <th className="px-2 py-1.5 font-medium">UOM</th>
                    <th className="px-2 py-1.5 font-medium text-right">Qty</th>
                    <th className="px-2 py-1.5 font-medium text-right">Rate</th>
                    <th className="px-2 py-1.5 font-medium text-right">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((l) => (
                    <tr key={l.item_description} className="border-b border-[var(--aws-border)] last:border-0">
                      <td className="px-2 py-1.5 break-words max-w-[220px]">{l.item_description}</td>
                      <td className="px-2 py-1.5 text-[var(--text-secondary)]">{l.uom}</td>
                      <td className="px-2 py-1.5 text-right">{l.qty}</td>
                      <td className="px-2 py-1.5 text-right">{l.rate}</td>
                      <td className="px-2 py-1.5 text-right">{l.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        {/* Decision panel */}
        <div className="space-y-4">
          <section className="bg-white border border-[var(--aws-border)] rounded-md p-4">
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)] mb-3">Decision</h2>
            <div className="space-y-2 text-[13px] mb-3">
              <Row label="Line Items" value={data.lines.length} />
              <Row label="Total Qty" value={totalQty} />
              <Row label="Total Value" value={totalValue.toLocaleString()} />
            </div>
            <label className="text-[11px] text-[var(--text-secondary)]">Remark (optional)</label>
            <textarea value={remark} onChange={(e) => setRemark(e.target.value)} rows={3} className="w-full rounded border border-[var(--aws-border)] px-2 py-1.5 text-[12px] bg-white mt-1 mb-3" />
            <div className="flex flex-col gap-2">
              {ACTIONS.map((a) => (
                <button
                  key={a.action}
                  onClick={() => act(a.action)}
                  disabled={busy !== null}
                  className={`text-[13px] font-semibold rounded-md px-3 py-2 text-white disabled:opacity-50 ${a.cls}`}
                >
                  {busy === a.action ? "Applying…" : a.label}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-[var(--text-secondary)] mt-3">
              Wire to the Phase-3 approval endpoint by replacing <code>mockApplyApproval</code> in{" "}
              <code>_fixtures.ts</code>.
            </p>
          </section>
        </div>
      </div>
    </CustomerReturnsChrome>
  );
}

function Info({ label, value }: { label: string; value?: string | number | null }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-[var(--text-secondary)] uppercase tracking-wide">{label}</dt>
      <dd className="text-[13px] font-medium text-[var(--text-primary)] break-words">{value}</dd>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between">
      <span className="text-[var(--text-secondary)]">{label}</span>
      <span className="font-medium text-[var(--text-primary)]">{value}</span>
    </div>
  );
}
