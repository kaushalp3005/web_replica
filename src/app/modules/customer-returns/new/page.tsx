"use client";

// Create a Customer Return — sectioned form (faithful to the legacy create screen):
//   1. CR Details        — header fields
//   2. Line Items        — cascading SKU picker (Search/Browse over all_sku) that
//                          auto-fills material_type/category/sub_category/sale_group/uom,
//                          then UOM/Qty/Rate/Value/Carton/Net(+cold) line fields
//   3. Box-wise Weights  — the full ArticleBoxEditor (identical to the approve screen):
//                          Qty Units, Assign-Lot ranges, bulk-fill, per-box net/gross/
//                          count/lot, and PRINT. Printing a box creates the CR on demand
//                          (so the box gets a real box_id) and mints its QR label. Box
//                          entry is NOT gated on approval.
//
// Submit = "Send for Approval": ensure the CR exists (create, or UPDATE header+lines if
// a print already created it), bulk-save the boxes, then fire the threaded BH mail. The
// createdId/createPromise refs keep it to exactly one CR across prints + retries. Starts
// "Pending" = awaiting Business-Head approval.

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth, useIsAdmin, useMe } from "@/lib/user";
import { createCustomerReturn, updateCustomerReturn, updateCustomerReturnLines, deleteCustomerReturn, sendCustomerReturnForApproval, bulkSaveBoxes, upsertBox, listCustomerReturns, getCrEmailRouting, type CRLineCreate, type CRHeaderCreate, type CrEmailRouting } from "@/lib/customer-returns";
import { CustomerReturnsChrome } from "../_chrome";
import { CompanyToggle, ErrorBanner, ConfirmDialog, useCompany, isColdWarehouse, WAREHOUSES } from "../_shared";
import { SALES_POC_OTHER } from "../_fixtures";
import { EMPTY_ROUTING } from "../_approvalMatrix";
import { CustomerReturnLineEditor, emptyCrLine, type CRLineForm } from "../_LineEditor";
import { ArticleBoxEditor } from "../_ArticleBoxEditor";
import { printCrLabels } from "../_labelPrint";
import {
  type CRBoxForm,
  boxesForArticle,
  addArticleBox,
  recomputeArticleOnUom,
  recomputeArticleOnCarton,
  toBulkItems,
  isCommitted,
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
  // Stable per-line React keys: removing a mid-list line must not slide one line's
  // transient editor state (box search/pagination/bulk-fill inputs) onto the next
  // (React reconciles by key, not array index). Kept in lock-step with `lines` at
  // add/remove. Deterministic seed [0] avoids any SSR/hydration key mismatch; the
  // counter only advances inside client event handlers.
  const [lineKeys, setLineKeys] = useState<number[]>([0]);
  const nextLineKey = useRef(1);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDiscard, setShowDiscard] = useState(false);
  const [printingBoxKey, setPrintingBoxKey] = useState<string | null>(null);
  const [printingRange, setPrintingRange] = useState(false);
  // Once the CR is created its id sticks — a later box-save/mail/print failure (or a
  // retry) reuses the SAME record instead of duplicating. createPromiseRef dedupes an
  // in-flight create so two quick box-print clicks can't mint two CRs.
  const createdIdRef = useRef<string | null>(null);
  const createPromiseRef = useRef<Promise<string | null> | null>(null);
  // Mirrors createdIdRef as state for RENDER (a ref can't be read during render): the
  // company toggle disables and the Discard copy changes once the CR exists. The ref
  // stays the synchronous source of truth for the create-dedup in ensureCreated.
  const [createdId, setCreatedId] = useState<string | null>(null);

  const cold = isColdWarehouse(factoryUnit);

  // Does this article have a committed (printed / in-flight) box? Such a box is a real
  // DB row with a physical label, so its line's article is locked here.
  const hasCommitted = (article: string) => !!article && boxes.some((b) => b.article_description === article && isCommitted(b));

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
    const articleChanged = "item_description" in patch && patch.item_description !== prevArticle;
    // A printed box locks its line's article — changing it would orphan the physical
    // label (and submit's allowClear would then delete the committed box).
    if (articleChanged && prevArticle && hasCommitted(prevArticle)) {
      setError(`"${prevArticle}" has printed boxes locked in the database — remove or reprint them on the detail screen instead of changing the article.`);
      return;
    }
    const nextLine = { ...lines[idx], ...patch };
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
    setBoxes((prev) => {
      let bx = prev;
      if (articleChanged && prevArticle) bx = bx.filter((b) => b.article_description !== prevArticle);
      const article = nextLine.item_description;
      if ("uom" in patch && article) bx = recomputeArticleOnUom(bx, article, nextLine.uom);
      if ("carton_weight" in patch && article) bx = recomputeArticleOnCarton(bx, article, nextLine.carton_weight);
      // Seed a default box only when the line is fully resolved (same gate the box
      // editor renders under) — a degenerate lookup (item_description but no
      // material_type/category) must not leave an invisible box that still saves.
      if (articleChanged && article && isResolved(nextLine) && boxesForArticle(bx, article).length === 0) {
        bx = addArticleBox(bx, article, nextLine.uom);
      }
      return bx;
    });
  }

  const addLine = () => {
    setLines((p) => [...p, emptyCrLine()]);
    setLineKeys((k) => [...k, nextLineKey.current++]);
  };
  const removeLine = (idx: number) => {
    if (lines.length <= 1) return; // keep at least one line — gate line + box removal together (legacy parity)
    const article = lines[idx]?.item_description;
    if (article && hasCommitted(article)) {
      setError(`"${article}" has printed boxes locked in the database — remove it on the detail screen instead.`);
      return;
    }
    setLines((p) => p.filter((_, i) => i !== idx));
    setLineKeys((k) => k.filter((_, i) => i !== idx));
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

  // Validate + assemble the create/update payload. setError + return null if invalid.
  function buildPayload(): { header: CRHeaderCreate; lines: CRLineCreate[] } | null {
    if (!factoryUnit.trim() || !customer.trim()) {
      setError("Factory Unit and Customer are required.");
      return null;
    }
    const payloadLines = mapLines();
    if (payloadLines.length === 0) {
      setError("Add at least one line item — pick an article via Search or Browse.");
      return null;
    }
    return {
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
    };
  }

  // Create the CR (header + lines) exactly once, even under concurrent print clicks:
  // createdIdRef holds the id after success; createPromiseRef dedupes an in-flight
  // create so two quick prints can't mint two CRs. Returns null (after setError) when
  // the form isn't yet valid to create.
  async function ensureCreated(): Promise<string | null> {
    if (createdIdRef.current) return createdIdRef.current;
    if (createPromiseRef.current) return createPromiseRef.current;
    const payload = buildPayload();
    if (!payload) return null;
    const p = (async () => {
      const created = await createCustomerReturn(company, { company, ...payload });
      createdIdRef.current = created.rtv_id;
      setCreatedId(created.rtv_id); // pin the company toggle — every later write is namespaced
      return created.rtv_id;
    })();
    createPromiseRef.current = p;
    try {
      return await p;
    } catch (e) {
      createPromiseRef.current = null; // let a later attempt retry the create
      throw e;
    }
  }

  // Save + print ONE box: ensure the CR exists (so the box gets a real box_id), upsert
  // the box, mark it printed in state, then mint its QR label. Same path as detail/approve.
  async function handlePrintBox(article: string, boxNumber: number) {
    if (submitting) return; // never mint a box mid-submit — allowClear would delete it
    const box = boxes.find((b) => b.article_description === article && b.box_number === boxNumber);
    if (!box) return;
    const setPrinting = (v: boolean) =>
      setBoxes((prev) => prev.map((b) => (b.article_description === article && b.box_number === boxNumber ? { ...b, printing: v } : b)));
    setPrintingBoxKey(`${article}#${boxNumber}`);
    setError(null);
    // Freeze this box_number for the whole print (isCommitted) so a Qty-Units change or
    // row-Remove can't drop it before the post-upsert box_id stamp lands on it.
    setPrinting(true);
    try {
      const crId = await ensureCreated();
      if (!crId) { setPrinting(false); return; } // invalid form — error already surfaced
      const res = await upsertBox(company, crId, {
        article_description: box.article_description,
        box_number: box.box_number,
        uom: lines.find((l) => l.item_description === article)?.uom || undefined,
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
      await printCrLabels({ company, crId, customer, rtvDate: null, boxes: [{ ...box, box_id: res.box_id }] });
    } catch (e) {
      setPrinting(false); // failed print → box is unfrozen and removable again
      setError(e instanceof Error ? e.message : "Print failed");
    } finally {
      setPrintingBoxKey(null);
    }
  }

  // Reprint every already-printed box of an article within [from, to] (needs box_ids →
  // the CR already exists once anything here is printed).
  async function handlePrintRange(article: string, from: number, to: number) {
    if (submitting) return;
    const inRange = boxes.filter((b) => b.article_description === article && b.box_id && b.box_number >= from && b.box_number <= to);
    if (inRange.length === 0) {
      setError("No printed boxes in that range — print individual boxes first.");
      return;
    }
    setPrintingRange(true);
    setError(null);
    try {
      await printCrLabels({ company, crId: createdIdRef.current || "", customer, rtvDate: null, boxes: inRange.map((b) => ({ ...b })) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Print failed");
    } finally {
      setPrintingRange(false);
    }
  }

  async function handleSubmit() {
    if (submitting) return; // re-entry guard
    setError(null);
    const payload = buildPayload();
    if (!payload) return;
    setSubmitting(true);
    try {
      // "Pre-existed" = created by anything other than THIS submit — resolved OR still
      // in flight from a box-print (createdIdRef is only set after that create resolves).
      const existed = !!createdIdRef.current || !!createPromiseRef.current;
      const crId = await ensureCreated();
      if (!crId) { setSubmitting(false); return; }
      // If the CR pre-existed (a print created it), sync the latest header + lines so
      // edits made after that print aren't lost. A fresh create already used the current
      // payload, so no update is needed on that path. Optional header fields are sent as
      // raw strings ("" for cleared) — payload.header's `|| undefined` would JSON-omit a
      // blank, and the backend's exclude_none would then keep the stale print-time value.
      if (existed) {
        await updateCustomerReturn(company, crId, {
          factory_unit: factoryUnit,
          customer,
          invoice_number: invoiceNumber,
          challan_no: challanNo,
          dn_no: dnNo,
          sales_poc: salesPoc === SALES_POC_OTHER ? salesPocOtherName : salesPoc,
          sales_poc_email: salesPoc === SALES_POC_OTHER ? salesPocOtherEmail : "",
          business_head: businessHead,
          remark,
          vehicle_number: vehicleNumber,
          transporter_name: transporterName,
          driver_name: driverName,
          inward_manager: inwardManager,
        });
        await updateCustomerReturnLines(company, crId, payload.lines);
      }
      // Persist the box-wise weights (0 boxes → nothing to save). allowClear syncs
      // deletions; printed boxes are always in the payload, so none are dropped.
      const items = toBulkItems(boxes, (article) => lines.find((l) => l.item_description === article)?.uom || "");
      if (items.length > 0) await bulkSaveBoxes(company, crId, items, { allowClear: true });
      // Threaded Business-Head approval mail — best-effort (no-op if SMTP unset).
      await sendCustomerReturnForApproval(company, crId).catch(() => undefined);
      router.push(`/modules/customer-returns/${crId}?company=${company}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send for approval");
      setSubmitting(false); // stay on the form so the operator can retry (same CR)
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
          <p className="text-[12px] text-[var(--text-secondary)]">Enter header, line items, and box-wise weights, then send for approval.</p>
        </div>
        <div className="flex-1" />
        <CompanyToggle value={company} onChange={setCompany} disabled={!!createdId || submitting || !!printingBoxKey || printingRange} />
        <button onClick={() => setShowDiscard(true)} disabled={submitting || !!printingBoxKey || printingRange} className="text-[13px] rounded-md border border-[var(--aws-border)] px-3 py-1.5 bg-white disabled:opacity-50">
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
        subtitle="Pick an article (Search or Browse), enter line values, then capture box-wise weights below."
      >
        <div className="space-y-4">
          {lines.map((line, idx) => (
            <div key={lineKeys[idx]} className="space-y-0">
              <CustomerReturnLineEditor
                line={line}
                index={idx}
                isCold={cold}
                onChange={patchLine}
                onRemove={removeLine}
                removable={lines.length > 1}
                articleLocked={hasCommitted(line.item_description)}
              />
              {isResolved(line) && (
                <div className="mt-2">
                  <ArticleBoxEditor
                    line={line}
                    isCold={cold}
                    boxes={boxes}
                    onBoxesChange={setBoxes}
                    onPrintBox={handlePrintBox}
                    printingKey={printingBoxKey}
                    onPrintRange={handlePrintRange}
                    printingRange={printingRange}
                    disabled={submitting}
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
          onConfirm={async () => {
            // Resolve an in-flight print-create too (createdIdRef isn't set until it
            // resolves) so Discard never leaves the CR it kicked off undeleted.
            let id = createdIdRef.current;
            if (!id && createPromiseRef.current) {
              try { id = await createPromiseRef.current; } catch { /* create failed — nothing to delete */ }
            }
            // If a box was printed the CR is already saved (Pending) with real box_ids —
            // delete it so Discard doesn't leave an orphaned live record behind.
            if (id) {
              try {
                await deleteCustomerReturn(company, id);
              } catch (e) {
                setError(e instanceof Error ? e.message : "Failed to delete the created return");
                setShowDiscard(false);
                return;
              }
            }
            router.push("/modules/customer-returns");
          }}
        >
          {createdId
            ? `${createdId} was already created and box labels were printed. Discarding deletes it — the printed labels are no longer valid and must be thrown away.`
            : "Your unsaved changes will be lost."}
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
