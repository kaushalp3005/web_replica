"use client";

// Business-head review / approval screen.
//
// The recipient MATRIX (who the Approve/Reject/Hold mail reaches, and who is
// allowed to decide) is REAL — computed by resolveRecipients() from the same
// email maps the backend uses (see ../../_approvalMatrix.ts, ported verbatim
// from shared/email_notifier.py). Only the SEND + PERSIST are stubbed: the
// decision runs through mockApplyApproval() and updates status on screen only.
// When the Phase-3 /approve endpoint lands, swap mockApplyApproval for the real
// call; the whole matrix panel stays as-is.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useRequireAuth, useIsAdmin } from "@/lib/user";
import { getCustomerReturn, type CRWithDetails, type CRStatus } from "@/lib/customer-returns";
import { CustomerReturnsChrome } from "../../_chrome";
import { StatusBadge, ErrorBanner, InfoBanner, SuccessBanner, useCompany, fmtDate, fmtDateTime, num } from "../../_shared";
import { mockApplyApproval, SAMPLE_CR, type ApprovalAction, ACTION_TO_STATUS } from "../../_fixtures";
import { resolveRecipients, formatActor } from "../../_approvalMatrix";

// approve/reject/hold, each with the same accent the backend uses for its email
// action buttons (#27ae60 / #c0392b / #e67e22).
const ACTIONS: { action: ApprovalAction; label: string; bg: string; verb: string }[] = [
  { action: "approve", label: "Approve", bg: "#27ae60", verb: "Approved" },
  { action: "reject", label: "Reject", bg: "#c0392b", verb: "Rejected" },
  { action: "hold", label: "Hold", bg: "#e67e22", verb: "held" },
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
    queueMicrotask(() => { load(); });
  }, [isAdmin, load]);

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

  const recipients = resolveRecipients(data);
  const canDecide = !!recipients.approver; // no mapped BH -> no mail approver
  const totalQty = data.lines.reduce((s, l) => s + num(l.qty), 0);
  const totalValue = data.lines.reduce((s, l) => s + num(l.value), 0);

  async function act(action: ApprovalAction) {
    if (!canDecide) return;
    setBusy(action);
    setDecision(null);
    try {
      const res = await mockApplyApproval(action);
      setStatus(res.status);
      const actor = formatActor(recipients.approver!.email);
      const verb = ACTIONS.find((a) => a.action === action)!.verb;
      setDecision(
        `Preview: this return would be marked “${res.status}”. ${verb} by: ${actor}` +
          `${remark ? ` · remark: “${remark}”` : ""}. ` +
          `A threaded mail would go To ${recipients.to.join(", ")} and Cc ${recipients.cc.length} recipient` +
          `${recipients.cc.length === 1 ? "" : "s"}. Nothing was saved — the approval + email backend is Phase 3.`,
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <CustomerReturnsChrome title="Review">
      {/* Page header */}
      <div className="flex items-start gap-3 mb-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-[18px] font-bold text-[var(--text-primary)] break-all">{data.rtv_id}</h1>
            {status && <StatusBadge status={status} />}
          </div>
          <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">
            Business-head review · {fmtDate(data.rtv_date)}
          </p>
        </div>
        <div className="flex-1" />
        <Link href={`/modules/customer-returns/${data.rtv_id}`} className="text-[13px] rounded-md border border-[var(--aws-border)] px-3 py-1.5 bg-white hover:border-[var(--aws-orange)]">
          Open detail
        </Link>
      </div>

      <div className="mb-4">
        <InfoBanner>
          <strong>Preview / stub.</strong> The recipient matrix below is computed from the live email maps, but the
          decision is not sent or saved yet — Approve/Reject/Hold update the status on screen only (backend Phase 3).
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
        {/* Left: CR info + lines */}
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
              <Info label="Created By" value={data.created_by} />
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

        {/* Right: approval matrix + decision */}
        <div className="space-y-4">
          {/* Approver */}
          <section className="bg-white border border-[var(--aws-border)] rounded-md p-4">
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)] mb-3">Approver</h2>
            {recipients.approver ? (
              <div className="rounded-md border border-[#b6dbb1] bg-[#f4faf5] px-3 py-2.5">
                <div className="text-[13px] font-semibold text-[var(--text-primary)]">{recipients.approver.name}</div>
                <div className="text-[12px] text-[var(--text-secondary)] break-all">{recipients.approver.email}</div>
                <div className="text-[11px] text-[var(--text-secondary)] mt-1.5">
                  Only the mapped Business Head receives the Approve / Reject / Hold buttons by mail — the decision is
                  attributed to this address.
                </div>
              </div>
            ) : (
              <div className="rounded-md border border-[#ecd9a3] bg-[#fdf6e3] px-3 py-2.5 text-[12px] text-[#8a6d1a]">
                No business head is mapped to an email, so this return has no mail approver and cannot be actioned.
                Set a mapped Business Head ({data.business_head || "none"} is not in the map) on the detail screen first.
              </div>
            )}
          </section>

          {/* Recipient matrix */}
          <section className="bg-white border border-[var(--aws-border)] rounded-md p-4">
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)] mb-1">Notification Matrix</h2>
            <p className="text-[11px] text-[var(--text-secondary)] mb-3">Who the decision mail would reach.</p>
            <RecipientList label="To" emails={recipients.to} approverEmail={recipients.approver?.email} />
            <div className="mt-3">
              <RecipientList label={`Cc (${recipients.cc.length})`} emails={recipients.cc} />
            </div>
          </section>

          {/* Decision */}
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
                  disabled={busy !== null || !canDecide}
                  style={{ backgroundColor: a.bg }}
                  className="text-[13px] font-semibold rounded-md px-3 py-2 text-white disabled:opacity-40 disabled:cursor-not-allowed"
                  title={canDecide ? `Mark ${ACTION_TO_STATUS[a.action]} (preview)` : "No mapped approver"}
                >
                  {busy === a.action ? "Applying…" : a.label}
                </button>
              ))}
            </div>
            {!canDecide && (
              <p className="text-[10px] text-[#8a6d1a] mt-2">Buttons are disabled until a mapped Business Head is set.</p>
            )}
          </section>
        </div>
      </div>
    </CustomerReturnsChrome>
  );
}

function RecipientList({ label, emails, approverEmail }: { label: string; emails: string[]; approverEmail?: string }) {
  return (
    <div>
      <div className="text-[11px] font-medium text-[var(--text-secondary)] uppercase tracking-wide mb-1.5">{label}</div>
      {emails.length === 0 ? (
        <div className="text-[12px] text-[var(--text-muted)]">—</div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {emails.map((e) => {
            const isApprover = approverEmail && e.toLowerCase() === approverEmail.toLowerCase();
            return (
              <span
                key={e}
                className={
                  "text-[11px] px-2 py-0.5 rounded border break-all " +
                  (isApprover
                    ? "bg-[#eaf6ed] text-[var(--text-success)] border-[#b6dbb1] font-medium"
                    : "bg-[var(--background)] text-[var(--text-secondary)] border-[var(--aws-border)]")
                }
                title={isApprover ? "Approver (Business Head)" : undefined}
              >
                {isApprover ? "★ " : ""}{e}
              </span>
            );
          })}
        </div>
      )}
    </div>
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
