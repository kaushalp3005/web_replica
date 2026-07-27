"use client";

// Create a Customer Return — sectioned form (faithful to the legacy create screen):
//   1. CR Details        — header fields
//   2. Line Items        — cascading SKU picker (Search/Browse over all_sku) that
//                          auto-fills material_type/category/sub_category/sale_group/uom,
//                          then UOM/Qty/Rate/Value/Carton/Net(+cold) line fields
//   3. Box-wise Weights  — LOCKED here (banner). Weights & QR labels unlock only after
//                          mail approval, on the edit screen; shown read-only for
//                          continuity. The CR is saved with 0 boxes.
//
// Submit = "Send for Approval": POST /{company} (header + lines, NO boxes), leaving the
// CR "Pending" = awaiting Business-Head approval (the `submitting` flag stays set through
// the redirect, so it can't double-submit). Legacy also fired a threaded BH mail
// (…/send-for-approval); the live backend has no such endpoint — a documented stub.

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth, useIsAdmin, useMe } from "@/lib/user";
import { createCustomerReturn, sendCustomerReturnForApproval, listCustomerReturns, getCrEmailRouting, type CRLineCreate, type CrEmailRouting } from "@/lib/customer-returns";
import { CustomerReturnsChrome } from "../_chrome";
import { CompanyToggle, ErrorBanner, ConfirmDialog, useCompany, isColdWarehouse, WAREHOUSES } from "../_shared";
import { SALES_POC_OTHER } from "../_fixtures";
import { EMPTY_ROUTING } from "../_approvalMatrix";
import { CustomerReturnLineEditor, emptyCrLine, type CRLineForm } from "../_LineEditor";
import { CustomerReturnBoxSection } from "../_BoxSection";
import {
  type CRBoxForm,
  boxesForArticle,
  addArticleBox,
  recomputeArticleOnUom,
  recomputeArticleOnCarton,
} from "../_boxEngine";

const inputCls = "h-8 rounded border border-[var(--aws-border)] px-2 text-[12px] bg-white w-full";
const labelCls = "text-[11px] text-[var(--text-secondary)]";

const isResolved = (l: CRLineForm) => !!(l.item_description && (l.material_type || l.item_category));

export default function NewCustomerReturnPage() {
  const router = useRouter();
  useRequireAuth(router.replace);
  const isAdmin = useIsAdmin();
  const me = useMe();
  const [company, setCompany] = useCompany();

  // Seed company from ?company= on first load (cold/shared links); the toggle
  // takes over after. Mount-guard + deferred setState = runs once.
  const seededCompany = useRef(false);
  useEffect(() => {
    if (seededCompany.current) return;
    seededCompany.current = true;
    const c = new URLSearchParams(window.location.search).get("company");
    if ((c === "CFPL" || c === "CDPL") && c !== company) queueMicrotask(() => setCompany(c));
  }, [company, setCompany]);

  // Known-customer suggestions for the Customer datalist (legacy getCustomers).
  const [customers, setCustomers] = useState<string[]>([]);
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    listCustomerReturns(company, { per_page: 100 }).then(
      (r) => { if (!cancelled) setCustomers(Array.from(new Set(r.records.map((x) => x.customer).filter(Boolean))).sort()); },
      () => {},
    );
    return () => { cancelled = true; };
  }, [company, isAdmin]);

  // Business-Head / Sales-POC dropdown names come from the DB routing (the same
  // source as the approve screen's recipient matrix) — no hardcoded name lists.
  const [routing, setRouting] = useState<CrEmailRouting>(EMPTY_ROUTING);
  useEffect(() => {
    let cancelled = false;
    getCrEmailRouting().then((r) => { if (!cancelled) setRouting(r); }, () => {});
    return () => { cancelled = true; };
  }, []);
  const businessHeadOptions = routing.business_head.map((x) => x.name);
  const salesPocDropdown = [...routing.sales_poc.map((x) => x.name).sort((a, b) => a.localeCompare(b)), SALES_POC_OTHER];

  // Header
  const [factoryUnit, setFactoryUnit] = useState("");
  const [customer, setCustomer] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [challanNo, setChallanNo] = useState("");
  const [dnNo, setDnNo] = useState("");
  const [salesPoc, setSalesPoc] = useState("");
  const [salesPocOtherName, setSalesPocOtherName] = useState("");
  const [salesPocOtherEmail, setSalesPocOtherEmail] = useState("");
  const [businessHead, setBusinessHead] = useState("");
  const [vehicleNumber, setVehicleNumber] = useState("");
  const [transporterName, setTransporterName] = useState("");
  const [driverName, setDriverName] = useState("");
  const [inwardManager, setInwardManager] = useState("");
  const [remark, setRemark] = useState("");

  // Inward Manager defaults to the logged-in user's profile name (fetched from
  // the profile, editable). Seeded once, and only while the field is still empty
  // so a manual entry is never clobbered.
  const seededInward = useRef(false);
  useEffect(() => {
    if (seededInward.current) return;
    const name = me?.full_name?.trim();
    if (!name) return;
    seededInward.current = true;
    queueMicrotask(() => setInwardManager((prev) => prev || name));
  }, [me]);

  const [lines, setLines] = useState<CRLineForm[]>([emptyCrLine()]);
  const [boxes, setBoxes] = useState<CRBoxForm[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDiscard, setShowDiscard] = useState(false);

  const cold = isColdWarehouse(factoryUnit);

  // Box-wise entry is LOCKED on the create screen (legacy parity) — weights & QR
  // unlock only after mail approval, on the edit screen. The CR is saved with 0 boxes.
  const boxesLocked = true;

  // Patch a line. Rejects resolving to an article already used by another line
  // (the line PK is (rtv_id, item_description); two lines sharing an article would
  // collide on the backend and share one ambiguous box set). Cascades UOM/carton
  // changes into that article's boxes and seeds a default box the first time an
  // article resolves (legacy behaviour).
  function patchLine(idx: number, patch: Partial<CRLineForm>) {
    if ("item_description" in patch && patch.item_description) {
      const dup = lines.some((l, i) => i !== idx && l.item_description === patch.item_description);
      if (dup) {
        setError(`"${patch.item_description}" is already on another line — combine the quantities instead.`);
        return;
      }
    }
    const prevArticle = lines[idx]?.item_description ?? "";
    const nextLine = { ...lines[idx], ...patch };
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
    setBoxes((prev) => {
      let bx = prev;
      const articleChanged = "item_description" in patch && patch.item_description !== prevArticle;
      if (articleChanged && prevArticle) bx = bx.filter((b) => b.article_description !== prevArticle);
      const article = nextLine.item_description;
      if ("uom" in patch && article) bx = recomputeArticleOnUom(bx, article, nextLine.uom);
      if ("carton_weight" in patch && article) bx = recomputeArticleOnCarton(bx, article, nextLine.carton_weight);
      if (articleChanged && article && boxesForArticle(bx, article).length === 0) {
        bx = addArticleBox(bx, article, nextLine.uom);
      }
      return bx;
    });
  }

  const addLine = () => setLines((p) => [...p, emptyCrLine()]);
  const removeLine = (idx: number) => {
    if (lines.length <= 1) return; // keep at least one line — gate line + box removal together (legacy parity)
    const article = lines[idx]?.item_description;
    setLines((p) => p.filter((_, i) => i !== idx));
    if (article) setBoxes((b) => b.filter((x) => x.article_description !== article));
  };

  function mapLines(): CRLineCreate[] {
    return lines
      .filter((l) => l.item_description.trim())
      .map((l) => ({
        material_type: l.material_type || "RM",
        item_category: l.item_category || "",
        sub_category: l.sub_category || "",
        item_description: l.item_description,
        sale_group: l.sale_group || undefined,
        uom: l.uom || "0",
        qty: l.qty || "0",
        rate: l.rate || "0",
        value: l.value || "0",
        conversion: l.uom || undefined, // legacy: line conversion = uom
        net_weight: l.net_weight || "0",
        carton_weight: l.carton_weight || "0",
        lot_number: l.lot_number || undefined,
        item_mark: l.item_mark || undefined,
        spl_remarks: l.spl_remarks || undefined,
        vakkal: l.vakkal || undefined,
      }));
  }

  async function handleSubmit() {
    if (submitting) return; // re-entry guard: create exactly once
    setError(null);
    if (!factoryUnit.trim() || !customer.trim()) {
      setError("Factory Unit and Customer are required.");
      return;
    }
    const payloadLines = mapLines();
    if (payloadLines.length === 0) {
      setError("Add at least one line item — pick an article via Search or Browse.");
      return;
    }
    setSubmitting(true);
    try {
      // Create header + lines with NO boxes — box-wise weights are captured on the
      // edit screen after approval (legacy locks boxes on create). `submitting` stays
      // true through the redirect below, so this can't double-submit.
      const created = await createCustomerReturn(company, {
        company,
        header: {
          factory_unit: factoryUnit,
          customer,
          invoice_number: invoiceNumber || undefined,
          challan_no: challanNo || undefined,
          dn_no: dnNo || undefined,
          sales_poc: (salesPoc === SALES_POC_OTHER ? salesPocOtherName : salesPoc) || undefined,
          sales_poc_email: (salesPoc === SALES_POC_OTHER ? salesPocOtherEmail : "") || undefined,
          business_head: businessHead || undefined,
          remark: remark || undefined,
          vehicle_number: vehicleNumber || undefined,
          transporter_name: transporterName || undefined,
          driver_name: driverName || undefined,
          inward_manager: inwardManager || undefined,
        },
        lines: payloadLines,
      });
      // Fire the threaded Business-Head approval mail (the BH's copy carries the
      // Approve/Reject/Hold magic-link buttons). Best-effort: a missing SMTP config
      // just no-ops server-side, and the CR is already saved (Pending), so a send
      // failure must not block the redirect.
      await sendCustomerReturnForApproval(company, created.rtv_id).catch(() => undefined);
      router.push(`/modules/customer-returns/${created.rtv_id}?company=${company}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send for approval");
      setSubmitting(false); // stay on the form so the operator can retry
    }
  }

  if (!isAdmin) {
    return (
      <CustomerReturnsChrome title="New">
        <section className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)]">
          You don&rsquo;t have access to the Customer Returns module.
        </section>
      </CustomerReturnsChrome>
    );
  }

  return (
    <CustomerReturnsChrome title="New">
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div>
          <h1 className="text-[18px] sm:text-[22px] font-bold tracking-tight text-[var(--text-primary)]">New Customer Return</h1>
          <p className="text-[12px] text-[var(--text-secondary)]">Enter header + line items, then send for approval. Box-wise weights &amp; QR labels unlock on the CR after approval.</p>
        </div>
        <div className="flex-1" />
        <CompanyToggle value={company} onChange={setCompany} />
        <button onClick={() => setShowDiscard(true)} disabled={submitting} className="text-[13px] rounded-md border border-[var(--aws-border)] px-3 py-1.5 bg-white disabled:opacity-50">
          Discard
        </button>
        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="text-[13px] font-semibold rounded-md px-3 py-1.5 bg-[var(--aws-orange)] text-white hover:bg-[var(--aws-orange-hover)] disabled:opacity-50"
        >
          {submitting ? "Sending…" : "Send for Approval"}
        </button>
      </div>

      {error && <div className="mb-3"><ErrorBanner message={error} /></div>}

      {/* ── Section 1 · CR Details ─────────────────────────────────────────── */}
      <Section n={1} title="CR Details">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <div className="space-y-1">
            <label className={labelCls}>Factory Unit <span className="text-[var(--aws-error)]">*</span></label>
            <select value={factoryUnit} onChange={(e) => setFactoryUnit(e.target.value)} className={inputCls}>
              <option value="">Select…</option>
              {WAREHOUSES.map((w) => (<option key={w} value={w}>{w}</option>))}
            </select>
          </div>
          <div className="space-y-1">
            <label className={labelCls}>Customer <span className="text-[var(--aws-error)]">*</span></label>
            <input value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="Customer name" list="cr-customer-list" className={inputCls} />
            <datalist id="cr-customer-list">
              {customers.map((c) => (<option key={c} value={c} />))}
            </datalist>
          </div>
          <div className="space-y-1">
            <label className={labelCls}>Invoice Number</label>
            <input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} className={inputCls} />
          </div>
          <div className="space-y-1">
            <label className={labelCls}>Challan No</label>
            <input value={challanNo} onChange={(e) => setChallanNo(e.target.value)} className={inputCls} />
          </div>
          <div className="space-y-1">
            <label className={labelCls}>DN No</label>
            <input value={dnNo} onChange={(e) => setDnNo(e.target.value)} className={inputCls} />
          </div>
          <div className="space-y-1">
            <label className={labelCls}>Sales POC</label>
            <select value={salesPoc} onChange={(e) => setSalesPoc(e.target.value)} className={inputCls}>
              <option value="">Select…</option>
              {salesPocDropdown.map((p) => (<option key={p} value={p}>{p}</option>))}
            </select>
            {salesPoc === SALES_POC_OTHER && (
              <div className="space-y-1 pt-1">
                <input value={salesPocOtherName} onChange={(e) => setSalesPocOtherName(e.target.value)} placeholder="POC name" className={inputCls} />
                <input type="email" value={salesPocOtherEmail} onChange={(e) => setSalesPocOtherEmail(e.target.value)} placeholder="poc@example.com (mail CC)" className={inputCls} />
              </div>
            )}
          </div>
          <div className="space-y-1">
            <label className={labelCls}>Business Head</label>
            <select value={businessHead} onChange={(e) => setBusinessHead(e.target.value)} className={inputCls}>
              <option value="">—</option>
              {businessHeadOptions.map((b) => (<option key={b} value={b}>{b}</option>))}
            </select>
          </div>
          <div className="space-y-1">
            <label className={labelCls}>Vehicle Number</label>
            <input value={vehicleNumber} onChange={(e) => setVehicleNumber(e.target.value)} className={inputCls} />
          </div>
          <div className="space-y-1">
            <label className={labelCls}>Transporter</label>
            <input value={transporterName} onChange={(e) => setTransporterName(e.target.value)} className={inputCls} />
          </div>
          <div className="space-y-1">
            <label className={labelCls}>Driver Name</label>
            <input value={driverName} onChange={(e) => setDriverName(e.target.value)} className={inputCls} />
          </div>
          <div className="space-y-1">
            <label className={labelCls}>Inward Manager</label>
            <input value={inwardManager} onChange={(e) => setInwardManager(e.target.value)} className={inputCls} />
          </div>
        </div>
        <div className="space-y-1 mt-3">
          <label className={labelCls}>Remark</label>
          <textarea value={remark} onChange={(e) => setRemark(e.target.value)} rows={2} className="w-full rounded border border-[var(--aws-border)] px-2 py-1.5 text-[12px] bg-white" />
        </div>
      </Section>

      {/* ── Section 2 · Line Items + Section 3 · Box-wise Weights (per line) ── */}
      <Section
        n={2}
        title={`Line Items (${lines.length})`}
        right={
          <button onClick={addLine} className="text-[12px] rounded border border-[var(--aws-border)] px-2 py-1 bg-white hover:border-[var(--aws-orange)]">
            + Add Line
          </button>
        }
        subtitle="Pick an article (Search or Browse) and enter line values. Box-wise weights are locked until the CR is approved."
      >
        <div className="space-y-4">
          {lines.map((line, idx) => (
            <div key={idx} className="space-y-0">
              <CustomerReturnLineEditor
                line={line}
                index={idx}
                isCold={cold}
                onChange={patchLine}
                onRemove={removeLine}
                removable={lines.length > 1}
              />
              {isResolved(line) && (
                <div className="ml-0 sm:ml-3 border-l-2 border-[var(--aws-orange)]/30 pl-3">
                  <div className="flex items-center gap-2 mt-1">
                    <span className="w-4 h-4 rounded-full bg-[var(--aws-navy)] text-white text-[9px] font-bold flex items-center justify-center">3</span>
                    <span className="text-[12px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide">Box-wise weights</span>
                  </div>
                  <CustomerReturnBoxSection
                    article={line.item_description}
                    uom={line.uom}
                    carton={line.carton_weight}
                    isCold={cold}
                    boxes={boxes}
                    onBoxesChange={setBoxes}
                    locked={boxesLocked}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      </Section>

      {showDiscard && (
        <ConfirmDialog
          title="Discard changes?"
          confirmLabel="Discard"
          onCancel={() => setShowDiscard(false)}
          onConfirm={() => router.push("/modules/customer-returns")}
        >
          Your unsaved changes will be lost.
        </ConfirmDialog>
      )}
    </CustomerReturnsChrome>
  );
}

function Section({ n, title, subtitle, right, children }: {
  n: number; title: string; subtitle?: string; right?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section className="bg-white border border-[var(--aws-border)] rounded-md p-4 mb-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <span className="w-5 h-5 rounded-full bg-[var(--aws-orange)] text-white text-[11px] font-bold flex items-center justify-center">{n}</span>
          <h2 className="text-[13px] font-semibold text-[var(--text-primary)] uppercase tracking-wide">{title}</h2>
        </div>
        {right}
      </div>
      {subtitle && <p className="text-[12px] text-[var(--text-secondary)] mb-3 -mt-1">{subtitle}</p>}
      {children}
    </section>
  );
}
