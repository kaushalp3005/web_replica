"use client";

// Create a Customer Return — sectioned form:
//   1. CR Details        — header fields
//   2. Line Items        — cascading SKU picker (Search/Browse over all_sku) that
//                          auto-fills material_type/category/sub_category/sale_group/uom,
//                          then UOM/Qty/Rate/Value/Carton/Net(+cold) line fields
//   3. Box-wise Weights  — per resolved article: Qty Units → box count, per-box
//                          Conversion(auto)/Net/Gross/Count (+cold Lot/Mark/…),
//                          article net-sum, add/remove
//
// The CR is created exactly ONCE, on submit: POST /{company} (header+lines) then
// PUT /{company}/{cr}/boxes (bulk save). Box CAPTURE only — QR label printing lives
// on the detail page (matches the legacy create screen, where boxes were entered
// but never printed until the edit screen). Creating once removes the double-create
// race and the printed-box renumber hazard.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth, useIsAdmin } from "@/lib/user";
import { createCustomerReturn, bulkSaveBoxes, type CRLineCreate } from "@/lib/customer-returns";
import { CustomerReturnsChrome } from "../_chrome";
import { CompanyToggle, ErrorBanner, useCompany, isColdWarehouse, WAREHOUSES } from "../_shared";
import { BUSINESS_HEAD_OPTIONS, SALES_POC_DROPDOWN_OPTIONS, SALES_POC_OTHER } from "../_fixtures";
import { CustomerReturnLineEditor, emptyCrLine, type CRLineForm } from "../_LineEditor";
import { CustomerReturnBoxSection } from "../_BoxSection";
import {
  type CRBoxForm,
  boxesForArticle,
  addArticleBox,
  recomputeArticleOnUom,
  recomputeArticleOnCarton,
  toBulkItems,
} from "../_boxEngine";

const inputCls = "h-8 rounded border border-[var(--aws-border)] px-2 text-[12px] bg-white w-full";
const labelCls = "text-[11px] text-[var(--text-secondary)]";

const isResolved = (l: CRLineForm) => !!(l.item_description && (l.material_type || l.item_category));

export default function NewCustomerReturnPage() {
  const router = useRouter();
  useRequireAuth(router.replace);
  const isAdmin = useIsAdmin();
  const [company, setCompany] = useCompany();

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

  const [lines, setLines] = useState<CRLineForm[]>([emptyCrLine()]);
  const [boxes, setBoxes] = useState<CRBoxForm[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cold = isColdWarehouse(factoryUnit);
  const uomFor = (article: string) => lines.find((l) => l.item_description === article)?.uom || "";

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
    const article = lines[idx]?.item_description;
    setLines((p) => (p.length <= 1 ? p : p.filter((_, i) => i !== idx)));
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
      // Persist captured boxes for resolved articles (drops orphans of removed lines).
      const valid = new Set(payloadLines.map((l) => l.item_description));
      const validBoxes = boxes.filter((b) => valid.has(b.article_description));
      if (validBoxes.length > 0) {
        await bulkSaveBoxes(company, created.rtv_id, toBulkItems(validBoxes, uomFor), {
          notifyDiscrepancy: false,
          allowClear: true,
        });
      }
      router.push(`/modules/customer-returns/${created.rtv_id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create customer return");
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
          <h1 className="text-[18px] font-bold text-[var(--text-primary)]">New Customer Return</h1>
          <p className="text-[12px] text-[var(--text-secondary)]">Details · line items · box-wise weights. Print labels from the detail page after saving.</p>
        </div>
        <div className="flex-1" />
        <CompanyToggle value={company} onChange={setCompany} />
        <button onClick={() => router.push("/modules/customer-returns")} className="text-[13px] rounded-md border border-[var(--aws-border)] px-3 py-1.5 bg-white">
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="text-[13px] font-semibold rounded-md px-3 py-1.5 bg-[var(--aws-orange)] text-white hover:bg-[var(--aws-orange-hover)] disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Create CR"}
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
            <input value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="Customer name" className={inputCls} />
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
              {SALES_POC_DROPDOWN_OPTIONS.map((p) => (<option key={p} value={p}>{p}</option>))}
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
              {BUSINESS_HEAD_OPTIONS.map((b) => (<option key={b} value={b}>{b}</option>))}
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
        title="Line Items"
        right={
          <button onClick={addLine} className="text-[12px] rounded border border-[var(--aws-border)] px-2 py-1 bg-white hover:border-[var(--aws-orange)]">
            + Add Line
          </button>
        }
        subtitle="Pick an article (Search or Browse), enter line values, then capture box-wise weights below each resolved article."
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
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      </Section>
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
