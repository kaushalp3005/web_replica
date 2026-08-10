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
import { getCustomerReturn, getCrEmailRouting, decideCustomerReturn, bulkSaveBoxes, upsertBox, type CRWithDetails, type CRStatus, type CrEmailRouting } from "@/lib/customer-returns";
import { CustomerReturnsChrome } from "../../_chrome";
import { StatusBadge, CompanyChip, ErrorBanner, InfoBanner, SuccessBanner, useCompanyParam, fmtDate, fmtDateTime, num, isColdWarehouse } from "../../_shared";
import { SAMPLE_CR, type ApprovalAction, ACTION_TO_STATUS } from "../../_fixtures";
import { resolveRecipients, formatActor, EMPTY_ROUTING } from "../../_approvalMatrix";
import { ArticleBoxEditor } from "../../_ArticleBoxEditor";
import { type CRBoxForm, toBulkItems, crBoxToForm } from "../../_boxEngine";
import { printCrLabels } from "../../_labelPrint";

// approve/reject/hold, each with the same accent the backend uses for its email
// action buttons (#27ae60 / #c0392b / #e67e22).
const ACTIONS: { action: ApprovalAction; label: string; bg: string; verb: string }[] = [
  { action: "approve", label: "Approve", bg: "#27ae60", verb: "Approved" },
  { action: "reject", label: "Reject", bg: "#c0392b", verb: "Rejected" },
  { action: "hold", label: "Hold", bg: "#e67e22", verb: "Held" },
];

const IconBox = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-[var(--text-secondary)]" aria-hidden="true">
    <path d="M16.5 9.4 7.5 4.21" /><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><polyline points="3.29 7 12 12 20.71 7" /><line x1="12" x2="12" y1="22" y2="12" />
  </svg>
);

export default function CustomerReturnApprovePage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const crId = decodeURIComponent(params.id);
  useRequireAuth(router.replace);
  const isAdmin = useIsAdmin();
  const company = useCompanyParam();

  const [data, setData] = useState<CRWithDetails | null>(null);
  const [usingSample, setUsingSample] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [status, setStatus] = useState<CRStatus | null>(null);
  const [remark, setRemark] = useState("");
  const [busy, setBusy] = useState<ApprovalAction | null>(null);
  const [decision, setDecision] = useState<string | null>(null);
  const [routing, setRouting] = useState<CrEmailRouting>(EMPTY_ROUTING);
  const [routingError, setRoutingError] = useState(false);

  // Box-wise weight entry, unlocked once the CR is Approved (legacy: /approve was
  // the box-entry screen). Seeded from the CR's existing boxes; same component the
  // create screen uses, just editable here.
  const [boxes, setBoxes] = useState<CRBoxForm[]>([]);
  const [savingBoxes, setSavingBoxes] = useState(false);
  const [boxNotice, setBoxNotice] = useState<string | null>(null);
  const [boxError, setBoxError] = useState<string | null>(null);
  const [printingBoxKey, setPrintingBoxKey] = useState<string | null>(null);
  const [printingRange, setPrintingRange] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setRoutingError(false);
    // Recipient routing is independent of the CR fetch — load it in parallel and
    // don't let a routing failure blank the whole screen.
    getCrEmailRouting().then(setRouting, () => { setRouting(EMPTY_ROUTING); setRoutingError(true); });
    try {
      const cr = await getCustomerReturn(company, crId);
      setData(cr);
      setStatus(cr.status);
      setBoxes((cr.boxes ?? []).map(crBoxToForm));
      setUsingSample(false);
    } catch {
      // Live record not reachable — show the fixture so the stub still demos.
      setData(SAMPLE_CR);
      setStatus(SAMPLE_CR.status);
      setBoxes([]);
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
        <div className="space-y-4">
          <div className="h-8 w-56 rounded bg-[var(--background)] animate-pulse" />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 space-y-4">
              <div className="h-40 rounded-md bg-[var(--background)] animate-pulse" />
              <div className="h-48 rounded-md bg-[var(--background)] animate-pulse" />
            </div>
            <div className="space-y-4">
              <div className="h-28 rounded-md bg-[var(--background)] animate-pulse" />
              <div className="h-40 rounded-md bg-[var(--background)] animate-pulse" />
            </div>
          </div>
        </div>
      </CustomerReturnsChrome>
    );
  }
  if (!data) return null;

  const recipients = resolveRecipients(routing, data);
  // Terminal states can't be re-decided (backend treats them as already-actioned);
  // On Hold is still actionable. Drives whether the decision UI shows at all.
  const alreadyDecided = status === "Approved" || status === "Rejected";
  // Needs SOMEONE who can approve (mapped BH or a standing deputy) + a non-terminal
  // status. A CR with an unmapped BH is still actionable now — the deputies hold the
  // same buttons, which is the point of having them.
  const canDecide = recipients.approvers.length > 0 && !alreadyDecided;
  // Box entry is independent of the approval matrix — available on any real record,
  // regardless of status. Only the fixture fallback (no live CR) can't be edited.
  const boxesUnlocked = !usingSample;
  const isCold = isColdWarehouse(data.factory_unit);
  const totalQty = data.lines.reduce((s, l) => s + num(l.qty), 0);
  const totalValue = data.lines.reduce((s, l) => s + num(l.value), 0);

  async function act(action: ApprovalAction) {
    if (!canDecide) return;
    setBusy(action);
    setDecision(null);
    setError(null);
    try {
      const res = await decideCustomerReturn(company, crId, action, remark || undefined);
      setStatus(res.status);
      if (res.already_actioned) {
        setDecision(`This return was already “${res.status}” — no change applied.`);
      } else {
        const actor = formatActor(routing, (recipients.approver ?? recipients.approvers[0]).email);
        setDecision(
          `Marked “${res.status}” (attributed to ${actor})${remark ? ` · remark: “${remark}”` : ""}. ` +
            `A threaded mail was sent To ${recipients.to.join(", ")} and Cc ${recipients.cc.length} recipient` +
            `${recipients.cc.length === 1 ? "" : "s"} (when SMTP is configured on the server).`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to apply the decision");
    } finally {
      setBusy(null);
    }
  }

  // Persist the box weights (full sync). box_number/article match server rows;
  // allowClear lets an emptied article delete its boxes. QR printing stays on the
  // detail screen, which already mints/reprints labels.
  async function saveBoxes() {
    if (!data) return;
    setSavingBoxes(true);
    setBoxError(null);
    setBoxNotice(null);
    try {
      const uomFor = (article: string) => data.lines.find((l) => l.item_description === article)?.uom?.toString() || "";
      await bulkSaveBoxes(company, crId, toBulkItems(boxes, uomFor), { allowClear: true });
      setBoxNotice(`Saved ${boxes.length} box${boxes.length === 1 ? "" : "es"}. Print QR labels from the detail screen.`);
    } catch (e) {
      setBoxError(e instanceof Error ? e.message : "Failed to save boxes");
    } finally {
      setSavingBoxes(false);
    }
  }

  // Save + print one box, minting/keeping its QR box_id (same path as the detail screen).
  async function handlePrintBox(article: string, boxNumber: number) {
    if (!data || savingBoxes) return;
    const box = boxes.find((b) => b.article_description === article && b.box_number === boxNumber);
    if (!box) return;
    const setPrinting = (v: boolean) =>
      setBoxes((prev) => prev.map((b) => (b.article_description === article && b.box_number === boxNumber ? { ...b, printing: v } : b)));
    setPrintingBoxKey(`${article}#${boxNumber}`);
    setBoxError(null);
    // Freeze this box_number (isCommitted) for the round-trip so a concurrent Qty-Units
    // change or row-Remove can't drop it before the box_id stamp lands.
    setPrinting(true);
    try {
      const res = await upsertBox(company, crId, {
        article_description: box.article_description,
        box_number: box.box_number,
        uom: data.lines.find((l) => l.item_description === article)?.uom?.toString() || undefined,
        conversion: box.conversion || undefined,
        net_weight: box.net_weight || "0",
        gross_weight: box.gross_weight || "0",
        lot_number: box.lot_number || undefined,
        item_mark: box.item_mark || undefined,
        spl_remarks: box.spl_remarks || undefined,
        vakkal: box.vakkal || undefined,
        count: box.count ? parseInt(box.count) : undefined,
      });
      setBoxes((prev) => prev.map((b) => (b.article_description === article && b.box_number === boxNumber ? { ...b, box_id: res.box_id, is_printed: true, printing: false } : b)));
      await printCrLabels({ company, crId, customer: data.customer, rtvDate: data.rtv_date, boxes: [{ ...box, box_id: res.box_id }] });
    } catch (e) {
      setPrinting(false);
      setBoxError(e instanceof Error ? e.message : "Print failed");
    } finally {
      setPrintingBoxKey(null);
    }
  }

  // Reprint every already-printed box of an article within [from, to].
  async function handlePrintRange(article: string, from: number, to: number) {
    if (!data) return;
    const inRange = boxes.filter((b) => b.article_description === article && b.box_id && b.box_number >= from && b.box_number <= to);
    if (inRange.length === 0) {
      setBoxError("No printed boxes in that range — print individual boxes first.");
      return;
    }
    setPrintingRange(true);
    setBoxError(null);
    try {
      await printCrLabels({ company, crId, customer: data.customer, rtvDate: data.rtv_date, boxes: inRange.map((b) => ({ ...b })) });
    } catch (e) {
      setBoxError(e instanceof Error ? e.message : "Print failed");
    } finally {
      setPrintingRange(false);
    }
  }

  return (
    <CustomerReturnsChrome title="Review">
      {/* Page header */}
      <div className="flex items-start gap-3 mb-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-[18px] sm:text-[22px] font-bold tracking-tight text-[var(--text-primary)] break-all">{data.rtv_id}</h1>
            {status && <StatusBadge status={status} />}
            <CompanyChip company={company} />
          </div>
          <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">
            Business-head review · {fmtDate(data.rtv_date)}
          </p>
        </div>
        <div className="flex-1" />
        <Link href={`/modules/customer-returns/${encodeURIComponent(data.rtv_id)}?company=${company}`} className="text-[13px] rounded-md border border-[var(--aws-border)] px-3 py-1.5 bg-white hover:border-[var(--aws-orange)]">
          Open detail
        </Link>
      </div>

      <div className="mb-4">
        {alreadyDecided ? (
          <InfoBanner>
            This customer return has already been <strong>{status}</strong> — no further action is needed here.
            The recipient matrix below shows who was notified.
          </InfoBanner>
        ) : (
          <InfoBanner>
            Approve / Reject / Hold here <strong>persists the decision</strong> and sends the threaded mail to the
            recipient matrix below (the Business Head can also action it from the buttons in that mail). Delivery
            requires SMTP to be configured on the server.
          </InfoBanner>
        )}
      </div>

      {usingSample && (
        <div className="mb-4">
          <ErrorBanner message={`Live record ${crId} could not be loaded for ${company}; showing a sample CR so the review screen still renders.`} />
        </div>
      )}
      {error && <div className="mb-4"><ErrorBanner message={error} /></div>}
      {routingError && <div className="mb-4"><ErrorBanner message="Approval e-mail routing could not be loaded from the server — the recipient matrix is unavailable and the decision buttons are disabled." /></div>}
      {decision && <div className="mb-4"><SuccessBanner message={decision} /></div>}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left: CR info + lines */}
        <div className="lg:col-span-2 space-y-4">
          <section className="bg-white border border-[var(--aws-border)] rounded-md p-4">
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)] mb-3">CR Information</h2>
            <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3 text-[13px]">
              <Info label="Factory Unit" value={data.factory_unit} />
              <Info label="Customer" value={data.customer} />
              <Info label="Invoice No" value={data.invoice_number} />
              <Info label="Challan No" value={data.challan_no} />
              <Info label="Sales POC" value={data.sales_poc} />
              <Info label="Business Head" value={data.business_head} />
              <Info label="Date" value={fmtDate(data.rtv_date)} />
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
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)] mb-3">Approvers</h2>
            {recipients.approvers.length > 0 ? (
              <div className="space-y-2">
                {recipients.approvers.map((a, i) => (
                  <div key={a.email} className="rounded-md border border-[#b6dbb1] bg-[#f4faf5] px-3 py-2.5">
                    <div className="text-[13px] font-semibold text-[var(--text-primary)]">
                      {a.name}
                      <span className="ml-2 text-[11px] font-normal text-[var(--text-secondary)]">
                        {i === 0 && recipients.approver ? "Business Head" : "Deputy"}
                      </span>
                    </div>
                    <div className="text-[12px] text-[var(--text-secondary)] break-all">{a.email}</div>
                  </div>
                ))}
                <p className="text-[11px] text-[var(--text-secondary)]">
                  Each of these receives the Approve / Reject / Hold buttons by mail and WhatsApp, so a return still
                  closes the same day when the Business Head is unavailable. Whoever decides first is the decision;
                  a later click is reported as already actioned.
                </p>
              </div>
            ) : (
              <div className="rounded-md border border-[#ecd9a3] bg-[#fdf6e3] px-3 py-2.5 text-[12px] text-[#8a6d1a]">
                No business head is mapped to an email and no deputy approver is configured, so this return has no mail
                approver and cannot be actioned. Set a mapped Business Head ({data.business_head || "none"} is not in
                the map) on the detail screen first.
              </div>
            )}
          </section>

          {/* Recipient matrix */}
          <section className="bg-white border border-[var(--aws-border)] rounded-md p-4">
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)] mb-1">Notification Matrix</h2>
            <p className="text-[11px] text-[var(--text-secondary)] mb-3">Who the decision mail would reach.</p>
            <RecipientList label="To" emails={recipients.to} approverEmails={recipients.approvers.map((a) => a.email)} />
            <div className="mt-3">
              <RecipientList label={`Cc (${recipients.cc.length})`} emails={recipients.cc} />
            </div>
          </section>

          {/* Decision */}
          <section className="bg-white border border-[var(--aws-border)] rounded-md p-4">
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)] mb-3">Decision</h2>
            <div className="space-y-2 text-[13px] mb-3">
              <Row label="Line Items" value={data.lines.length} />
              <Row label="Total Qty" value={parseFloat(totalQty.toFixed(3)).toLocaleString()} />
              <Row label="Total Value" value={totalValue.toLocaleString()} />
            </div>
            {alreadyDecided ? (
              <p className="text-[12px] text-[var(--text-secondary)]">
                This return has been <span className="font-semibold text-[var(--text-primary)]">{status}</span>. No further action can be taken here.
              </p>
            ) : (
              <>
                <label className="block text-[11px] text-[var(--text-secondary)]">
                  Remark (optional)
                  <textarea value={remark} onChange={(e) => setRemark(e.target.value)} rows={3} className="w-full rounded border border-[var(--aws-border)] px-2 py-1.5 text-[12px] bg-white mt-1 mb-3" />
                </label>
                <div className="flex flex-col gap-2">
                  {ACTIONS.map((a) => (
                    <button
                      key={a.action}
                      onClick={() => act(a.action)}
                      disabled={busy !== null || !canDecide}
                      style={{ backgroundColor: a.bg }}
                      className="text-[13px] font-semibold rounded-md px-3 py-2 text-white disabled:opacity-40 disabled:cursor-not-allowed"
                      title={canDecide ? `Mark ${ACTION_TO_STATUS[a.action]}` : "No mapped approver"}
                    >
                      {busy === a.action ? "Applying…" : a.label}
                    </button>
                  ))}
                </div>
                {!canDecide && (
                  <p className="text-[10px] text-[#8a6d1a] mt-2">Buttons are disabled until a mapped Business Head is set.</p>
                )}
              </>
            )}
          </section>
        </div>
      </div>

      {/* Articles — box-wise weights (independent of the approval decision) */}
      {boxesUnlocked && (
        <section className="mt-4 bg-white border border-[var(--aws-border)] rounded-md p-4">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)] inline-flex items-center gap-1.5">
              <IconBox /> Articles ({data.lines.length})
            </h2>
            <button
              onClick={saveBoxes}
              disabled={savingBoxes}
              className="text-[13px] font-semibold rounded-md px-3 py-1.5 text-white bg-[var(--aws-navy)] disabled:opacity-40"
            >
              {savingBoxes ? "Saving…" : "Save box weights"}
            </button>
          </div>
          <p className="text-[11px] text-[var(--text-secondary)] mb-3">
            Review each article and manage boxes for label printing.
          </p>
          {boxError && <div className="mb-3"><ErrorBanner message={boxError} /></div>}
          {boxNotice && <div className="mb-3"><SuccessBanner message={boxNotice} /></div>}
          <div className="space-y-4">
            {data.lines.map((l) => (
              <ArticleBoxEditor
                key={l.item_description}
                line={l}
                isCold={isCold}
                boxes={boxes}
                onBoxesChange={setBoxes}
                onPrintBox={handlePrintBox}
                printingKey={printingBoxKey}
                onPrintRange={handlePrintRange}
                printingRange={printingRange}
                disabled={savingBoxes}
              />
            ))}
          </div>
        </section>
      )}
    </CustomerReturnsChrome>
  );
}

function RecipientList({ label, emails, approverEmails }: { label: string; emails: string[]; approverEmails?: string[] }) {
  const approvers = new Set((approverEmails ?? []).map((a) => a.toLowerCase()));
  return (
    <div>
      <div className="text-[11px] font-medium text-[var(--text-secondary)] uppercase tracking-wide mb-1.5">{label}</div>
      {emails.length === 0 ? (
        <div className="text-[12px] text-[var(--text-muted)]">—</div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {emails.map((e) => {
            const isApprover = approvers.has(e.toLowerCase());
            return (
              <span
                key={e}
                className={
                  "text-[11px] px-2 py-0.5 rounded border break-all " +
                  (isApprover
                    ? "bg-[#eaf6ed] text-[var(--text-success)] border-[#b6dbb1] font-medium"
                    : "bg-[var(--background)] text-[var(--text-secondary)] border-[var(--aws-border)]")
                }
                title={isApprover ? "Approver — receives the action buttons" : undefined}
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
