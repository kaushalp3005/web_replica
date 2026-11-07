"use client";

// The Customer Return form — sectioned, faithful to the legacy create screen — in two
// modes:
//   * create (new/page.tsx): a blank form;
//   * edit ([id]/edit/page.tsx): an undecided return (Pending / On Hold) loaded in
//     full, so anything entered wrong can be corrected: the header, the business
//     head, the factory unit, the lines (add, remove, change an article) and the
//     boxes. A decided return is not edited here: the server refuses it (409
//     already_decided), and the page says so and links back to the return, where an
//     approved one still takes boxes.
//
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
// A save is one request, all saved or none (a refusal part-way no longer leaves the
// header saved and the boxes not):
// Create: "Send for Approval" creates the CR with its lines and boxes in one go — or,
// if a print already created it, saves its header, lines and boxes in one go and
// sends it (saveCustomerReturn with send) — then requests approval (the threaded mail
// + WhatsApp to the Business Head and the deputies) and opens the detail screen, which
// shows once what that request actually achieved — a failed send is shown in red
// there, with its own Send for approval to retry. The createdId / createPromise refs
// keep it to exactly one CR across prints + retries. Starts "Pending" = awaiting
// approval. Once a print has created it, the screen says so, names it in every error,
// and warns before leaving: it is a saved return not yet sent for approval.
// Edit: "Save" saves the header, lines and boxes; when that changes the figures of a
// return already sent for approval, the server sends it again with them (the old
// links stop working). "Save & send for approval" sends it whatever changed. Cancel
// leaves without saving (boxes printed meanwhile are already saved, as on create);
// leaving with unsaved changes asks first.
// A line whose article has printed boxes keeps its article and can't be removed: its
// labels are on cartons.

import { useState, useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRequireAuth, useIsAdmin, useMe } from "@/lib/user";
import { sessionSave } from "@/lib/session-state";
import { createCustomerReturn, saveCustomerReturn, deleteCustomerReturn, sendCustomerReturnForApproval, upsertBox, listCustomerReturns, getCrEmailRouting, getCustomerReturn, CRApiError, type Company, type CRLine, type CRLineCreate, type CRHeaderCreate, type CRHeaderUpdate, type CRSaveResponse, type CrEmailRouting } from "@/lib/customer-returns";
import { CustomerReturnsChrome } from "./_chrome";
import { CompanyToggle, ErrorBanner, ConfirmDialog, useCompany, isColdWarehouse, WAREHOUSES } from "./_shared";
import { SALES_POC_OTHER } from "./_fixtures";
import { EMPTY_ROUTING } from "./_approvalMatrix";
import { crStatusLabel, isUndecided, sendErrorNotice, sendNoticeKey, sendOutcomeNotice, type SendNotice } from "./_approvalFlow";
import { CustomerReturnLineEditor, emptyCrLine, type CRLineForm } from "./_LineEditor";
import { ArticleBoxEditor } from "./_ArticleBoxEditor";
import { printCrLabels } from "./_labelPrint";
import {
  type CRBoxForm,
  boxesForArticle,
  addArticleBox,
  crBoxToForm,
  recomputeArticleOnUom,
  recomputeArticleOnCarton,
  toBulkItems,
  isCommitted,
} from "./_boxEngine";

const inputCls = "h-8 rounded border border-[var(--aws-border)] px-2 text-[12px] bg-white w-full";
const labelCls = "text-[11px] text-[var(--text-secondary)]";

const isResolved = (l: CRLineForm) => !!(l.item_description && (l.material_type || l.item_category));

const str = (v: string | number | null | undefined) => (v === null || v === undefined ? "" : String(v));

// A saved line as the line editor holds it.
function crLineToForm(l: CRLine): CRLineForm {
  return {
    material_type: str(l.material_type), item_category: str(l.item_category),
    sub_category: str(l.sub_category), item_description: str(l.item_description),
    sale_group: str(l.sale_group), uom: str(l.uom), qty: str(l.qty), rate: str(l.rate),
    value: str(l.value), conversion: str(l.conversion), carton_weight: str(l.carton_weight),
    net_weight: str(l.net_weight), lot_number: str(l.lot_number), item_mark: str(l.item_mark),
    spl_remarks: str(l.spl_remarks), vakkal: str(l.vakkal),
  };
}

// A dropdown's options, keeping a saved value the list no longer offers (a business
// head who lost the role, a unit since renamed) so it shows and can be changed.
const withCurrent = (options: string[], current: string) =>
  current && !options.includes(current) ? [current, ...options] : options;

export function CustomerReturnForm({ edit }: { edit?: { id: string; company: Company } }) {
  const router = useRouter();
  useRequireAuth(router.replace);
  const isAdmin = useIsAdmin();
  const me = useMe();
  const [pickedCompany, setCompany] = useCompany();
  const editId = edit?.id;
  const editCompany = edit?.company;
  // Edit: the return's own company, fixed. Create: the toggle.
  const company: Company = editCompany ?? pickedCompany;

  // Seed company from ?company= on first load (cold/shared links); the toggle
  // takes over after. Mount-guard + deferred setState = runs once. Create only.
  const seededCompany = useRef(false);
  useEffect(() => {
    if (seededCompany.current || editId) return;
    seededCompany.current = true;
    const c = new URLSearchParams(window.location.search).get("company");
    if ((c === "CFPL" || c === "CDPL") && c !== pickedCompany) queueMicrotask(() => setCompany(c));
  }, [editId, pickedCompany, setCompany]);

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
  // Only a business head with an e-mail on file can approve (the server refuses the rest).
  const businessHeadOptions = withCurrent(routing.business_head.filter((x) => x.email.trim()).map((x) => x.name), businessHead);
  const factoryUnitOptions = withCurrent([...WAREHOUSES], factoryUnit);

  // Inward Manager defaults to the logged-in user's profile name (fetched from
  // the profile, editable). Seeded once, and only while the field is still empty
  // so a manual entry is never clobbered. Create only: an edit keeps what was saved.
  const seededInward = useRef(false);
  useEffect(() => {
    if (seededInward.current || editId) return;
    const name = me?.full_name?.trim();
    if (!name) return;
    seededInward.current = true;
    queueMicrotask(() => setInwardManager((prev) => prev || name));
  }, [me, editId]);

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
  // in-flight create so two quick box-print clicks can't mint two CRs. In edit mode
  // both hold the loaded return from the start.
  const createdIdRef = useRef<string | null>(null);
  const createPromiseRef = useRef<Promise<string | null> | null>(null);
  // Mirrors createdIdRef as state for RENDER (a ref can't be read during render): the
  // company toggle disables and the Discard copy changes once the CR exists. The ref
  // stays the synchronous source of truth for the create-dedup in ensureCreated.
  const [createdId, setCreatedId] = useState<string | null>(null);
  // Set just before a navigation the screen makes itself (after a save, on Discard), so
  // the leave-page warning below doesn't ask about it.
  const leavingRef = useRef(false);

  // Edit mode: the saved return, loaded once.
  const [loading, setLoading] = useState(!!editId);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savedStatus, setSavedStatus] = useState<string | null>(null);
  const [rtvDate, setRtvDate] = useState<string | null>(null);
  // The box-set fingerprint this form is working from (edit: as loaded; create: none
  // until the first print). Sent with each print and the final save, moved on by each
  // successful one, so a save over boxes changed on another page is refused.
  const boxVersionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!editId || !editCompany || !isAdmin) return;
    let cancelled = false;
    Promise.all([getCustomerReturn(editCompany, editId), getCrEmailRouting().catch(() => null)]).then(
      ([cr, rt]) => {
        if (cancelled) return;
        setFactoryUnit(str(cr.factory_unit));
        setCustomer(str(cr.customer));
        setInvoiceNumber(str(cr.invoice_number));
        setChallanNo(str(cr.challan_no));
        setDnNo(str(cr.dn_no));
        // A listed sales person is picked by name; anyone else is "Other" with the
        // name and mail address as saved.
        const poc = str(cr.sales_poc);
        const listed = (rt?.sales_poc ?? []).some((x) => x.name === poc);
        if (poc && listed && !cr.sales_poc_email) {
          setSalesPoc(poc);
        } else if (poc || cr.sales_poc_email) {
          setSalesPoc(SALES_POC_OTHER);
          setSalesPocOtherName(poc);
          setSalesPocOtherEmail(str(cr.sales_poc_email));
        }
        setBusinessHead(str(cr.business_head));
        setVehicleNumber(str(cr.vehicle_number));
        setTransporterName(str(cr.transporter_name));
        setDriverName(str(cr.driver_name));
        setInwardManager(str(cr.inward_manager));
        setRemark(str(cr.remark));
        const loadedLines = cr.lines.length ? cr.lines.map(crLineToForm) : [emptyCrLine()];
        setLines(loadedLines);
        setLineKeys(loadedLines.map((_, i) => i));
        nextLineKey.current = loadedLines.length;
        setBoxes(cr.boxes.map(crBoxToForm));
        boxVersionRef.current = cr.box_version ?? null;
        createdIdRef.current = cr.rtv_id;
        setCreatedId(cr.rtv_id);
        setSavedStatus(cr.status);
        setRtvDate(cr.rtv_date ?? null);
        setLoading(false);
      },
      (e) => {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : "Failed to load customer return");
        setLoading(false);
      },
    );
    return () => { cancelled = true; };
  }, [editId, editCompany, isAdmin]);

  const cold = isColdWarehouse(factoryUnit);
  const detailHref = (id: string) => `/modules/customer-returns/${encodeURIComponent(id)}?company=${company}`;

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
      setError(`"${prevArticle}" already has printed box labels, so its article can't be changed. Add the right article as a new line; if this one shouldn't be on the return at all, delete the return and enter it again.`);
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
      setError(`"${article}" already has printed box labels, so its line can't be removed. If it shouldn't be on the return at all, delete the return and enter it again.`);
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
    if (!businessHead.trim()) {
      setError("Pick a business head: they approve the return.");
      return null;
    }
    const payloadLines = mapLines();
    if (payloadLines.length === 0) {
      setError("Add at least one line item — pick an article via Search or Browse.");
      return null;
    }
    // Quantity is a whole number, and no figure is negative (the server refuses the
    // same, rather than cutting 2.5 to 2 as it used to).
    for (const l of payloadLines) {
      if (!/^\d+$/.test(String(l.qty).trim())) {
        setError(`Quantity of ${l.item_description} must be a whole number (${l.qty}).`);
        return null;
      }
      if (!(Number(l.rate) >= 0)) {
        setError(`Rate of ${l.item_description} must be a number, not negative (${l.rate}).`);
        return null;
      }
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

  // The header as a save sends it: every field as a raw string ("" for cleared) —
  // buildPayload's `|| undefined` would JSON-omit a blank, and the server, which leaves
  // an omitted field as it was, would then keep the stale value.
  function headerFields(): CRHeaderUpdate {
    return {
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
    };
  }

  // A customer's invoice or challan already on another return: the server names those
  // returns (409 duplicate_invoice); a second return from one invoice can be real (goods
  // sent back in two lots), so ask, and save again with the confirmation.
  async function confirmingDuplicate<T>(save: (allowDuplicate: boolean) => Promise<T>): Promise<T> {
    try {
      return await save(false);
    } catch (e) {
      if (e instanceof CRApiError && e.code === "duplicate_invoice" &&
          window.confirm(`${e.message}\n\nSave this return anyway, as a further return from it?`)) {
        return save(true);
      }
      throw e;
    }
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
      const created = await confirmingDuplicate((allow) =>
        createCustomerReturn(company, { company, ...payload }, { allowDuplicateInvoice: allow }));
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
        box_id: box.box_id || undefined,
        base_version: boxVersionRef.current ?? undefined,
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
      boxVersionRef.current = res.box_version ?? boxVersionRef.current;
      await printCrLabels({ company, crId, customer, rtvDate, boxes: [{ ...box, box_id: res.box_id }] });
    } catch (e) {
      setPrinting(false); // failed print → box is unfrozen and removable again
      setError(withSavedId(e instanceof Error ? e.message : "Print failed"));
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
      await printCrLabels({ company, crId: createdIdRef.current || "", customer, rtvDate, boxes: inRange.map((b) => ({ ...b })) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Print failed");
    } finally {
      setPrintingRange(false);
    }
  }

  // An error on the New screen once a print has saved the return names it: it is a
  // real Pending return now, on the list, not yet sent for approval.
  function withSavedId(message: string): string {
    const id = createdIdRef.current;
    if (editId || !id) return message;
    return `${message.trim().replace(/\.$/, "")}. ${id} is saved as Pending and not yet sent for approval: ` +
      "Send for Approval sends it, Discard deletes it.";
  }

  // What a save achieved, for the detail screen to show once.
  function savedNotice(res: CRSaveResponse, send: boolean): SendNotice {
    const n = res.reprint?.length ?? 0;
    const reprint = n
      ? ` ${n} printed label${n === 1 ? " shows" : "s show"} old values (${res.reprint!.map((b) => b.box_id).join(", ")}): ` +
        `reprint ${n === 1 ? "it" : "them"} with Reprint all.`
      : "";
    const approval = res.approval;
    if (approval) {
      const sent = approval.reason === "already_decided"
        ? sendErrorNotice(approval.message ?? "it was decided meanwhile", false)
        : sendOutcomeNotice(approval);
      if (send) return { tone: sent.tone, text: sent.text + reprint };
      const lead = sent.tone === "error"
        ? "Saved. Its figures changed, but sending it for approval again failed. "
        : "Saved. Its figures changed, so it was sent for approval again with them; the earlier links no longer work. ";
      return { tone: sent.tone, text: lead + sent.text + reprint };
    }
    if (res.figures_changed) {
      return { tone: "success", text: "Saved. Its figures changed; no approval request is recorded for it, so send it for approval when it's ready." + reprint };
    }
    return { tone: "success", text: "Saved." + reprint };
  }

  // send: request approval after saving (create always does; an edit may just save).
  async function handleSubmit(send: boolean) {
    if (submitting) return; // re-entry guard
    setError(null);
    const payload = buildPayload();
    if (!payload) return;
    setSubmitting(true);
    // Printed boxes are always in the list, so a save never drops one; an unprinted box
    // left out (removed here) is removed.
    const items = toBulkItems(boxes, (article) => lines.find((l) => l.item_description === article)?.uom || "");
    try {
      // The return already exists when a print created it (or is creating it now: the
      // create is awaited, never duplicated) or it is being edited.
      let crId = createdIdRef.current;
      if (!crId && createPromiseRef.current) crId = await createPromiseRef.current;
      let notice: SendNotice;
      if (crId) {
        // Header, lines and boxes in one request, all saved or none; the server sends it
        // for approval after, when asked (or on its own when the figures of a return
        // already sent changed).
        const id = crId;
        const res = await confirmingDuplicate((allow) => saveCustomerReturn(company, id, {
          header: headerFields(),
          lines: payload.lines,
          boxes: items,
          base_version: boxVersionRef.current,
          send,
        }, { allowDuplicateInvoice: allow }));
        boxVersionRef.current = res.box_version ?? boxVersionRef.current;
        notice = savedNotice(res, send);
      } else {
        // New: the header, lines and boxes in one create, then the approval request. The
        // return is saved either way, so a failed request still opens the detail screen —
        // with what happened, in red, and its Send for approval button to retry — rather
        // than being silently dropped.
        const created = await confirmingDuplicate((allow) =>
          createCustomerReturn(company, { company, ...payload, boxes: items.length ? items : undefined }, { allowDuplicateInvoice: allow }));
        crId = created.rtv_id;
        createdIdRef.current = crId;
        setCreatedId(crId);
        try {
          notice = sendOutcomeNotice(await sendCustomerReturnForApproval(company, crId));
        } catch (e) {
          notice = sendErrorNotice(e instanceof Error ? e.message : "Failed to send for approval");
        }
      }
      leavingRef.current = true;
      sessionSave(sendNoticeKey(company, crId), notice);
      router.push(detailHref(crId));
    } catch (e) {
      // Nothing of this save was written (it is one request): stay on the form so the
      // operator can correct it and retry (the same CR).
      const message = e instanceof Error ? e.message : send ? "Failed to send for approval" : "Failed to save changes";
      setError(withSavedId(createdIdRef.current && !editId ? `These changes weren't saved: ${message}` : message));
      setSubmitting(false);
    }
  }

  // Leaving with work not saved asks first — a reload, closing the tab, or a link in
  // the app. On the New screen that is anything entered, and above all a return a
  // print has already saved but nobody has sent for approval; on Edit, any change
  // since it was loaded. (A successful save, or Discard, navigates without asking.)
  const formState = useMemo(
    () => JSON.stringify([factoryUnit, customer, invoiceNumber, challanNo, dnNo, salesPoc, salesPocOtherName,
      salesPocOtherEmail, businessHead, vehicleNumber, transporterName, driverName, inwardManager, remark, lines,
      boxes.map((b) => ({ ...b, printing: undefined }))]),
    [factoryUnit, customer, invoiceNumber, challanNo, dnNo, salesPoc, salesPocOtherName, salesPocOtherEmail,
      businessHead, vehicleNumber, transporterName, driverName, inwardManager, remark, lines, boxes],
  );
  const [loadedState, setLoadedState] = useState<string | null>(null);
  useEffect(() => {
    if (editId && !loading && !loadError && loadedState === null) queueMicrotask(() => setLoadedState(formState));
  }, [editId, loading, loadError, loadedState, formState]);
  const entered = !!(factoryUnit || customer.trim() || invoiceNumber.trim() || challanNo.trim() ||
    lines.some((l) => l.item_description));
  const unsaved = editId ? loadedState !== null && formState !== loadedState : entered || !!createdId;
  const leaveMessage = editId
    ? `Your changes to ${editId} aren't saved. Leave anyway?`
    : createdId
      ? `${createdId} is saved as Pending but not sent for approval, and your latest changes aren't saved. ` +
        "Leave anyway? It stays on the list as Pending until it is sent or deleted."
      : "This customer return isn't saved. Leave anyway?";
  useEffect(() => {
    if (!unsaved) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (leavingRef.current) return;
      e.preventDefault();
      e.returnValue = ""; // older browsers need it set to show their prompt
    };
    // In-app links (the chrome, the breadcrumbs): asked before the router sees the click.
    const onClick = (e: MouseEvent) => {
      if (leavingRef.current || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const to = new URL(a.href, window.location.href);
      if (to.origin !== window.location.origin) return;
      if (to.pathname === window.location.pathname && to.search === window.location.search) return;
      if (!window.confirm(leaveMessage)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [unsaved, leaveMessage]);

  const title = editId ?? "New";
  if (!isAdmin) {
    return (
      <CustomerReturnsChrome title={title}>
        <section className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)]">
          You don&rsquo;t have access to the Customer Returns module.
        </section>
      </CustomerReturnsChrome>
    );
  }

  if (editId && (loading || loadError || (savedStatus !== null && !isUndecided(savedStatus)))) {
    return (
      <CustomerReturnsChrome title={title}>
        {loading ? (
          <div className="h-40 rounded-md bg-[var(--background)] animate-pulse" />
        ) : (
          <div className="space-y-3">
            <ErrorBanner
              message={loadError ?? `${editId} is already “${crStatusLabel(savedStatus)}”, so its details and lines can't be changed.`}
            />
            <Link href={detailHref(editId)} className="inline-block text-[13px] rounded-md border border-[var(--aws-border)] px-3 py-1.5 bg-white">
              ← Back to {editId}
            </Link>
          </div>
        )}
      </CustomerReturnsChrome>
    );
  }

  const busy = submitting || !!printingBoxKey || printingRange;
  return (
    <CustomerReturnsChrome title={title}>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div>
          <h1 className="text-[18px] sm:text-[22px] font-bold tracking-tight text-[var(--text-primary)]">
            {editId ? `Edit ${editId}` : "New Customer Return"}
          </h1>
          <p className="text-[12px] text-[var(--text-secondary)]">
            {editId
              ? "Correct the details, business head, lines and box-wise weights. An article with printed box labels can't be changed or removed."
              : "Enter header, line items, and box-wise weights, then send for approval."}
          </p>
        </div>
        <div className="flex-1" />
        <CompanyToggle value={company} onChange={setCompany} disabled={!!createdId || busy} />
        <button onClick={() => setShowDiscard(true)} disabled={busy} className="text-[13px] rounded-md border border-[var(--aws-border)] px-3 py-1.5 bg-white disabled:opacity-50">
          {editId ? "Cancel" : "Discard"}
        </button>
        {editId && (
          <button
            onClick={() => handleSubmit(false)}
            disabled={submitting}
            className="text-[13px] font-semibold rounded-md border border-[var(--aws-orange)] text-[var(--aws-orange)] px-3 py-1.5 bg-white disabled:opacity-50"
          >
            {submitting ? "Saving…" : "Save"}
          </button>
        )}
        <button
          onClick={() => handleSubmit(true)}
          disabled={submitting}
          className="text-[13px] font-semibold rounded-md px-3 py-1.5 bg-[var(--aws-orange)] text-white hover:bg-[var(--aws-orange-hover)] disabled:opacity-50"
        >
          {submitting ? "Sending…" : editId ? "Save & send for approval" : "Send for Approval"}
        </button>
      </div>

      {!editId && createdId && (
        <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
          Saved as <span className="font-semibold">{createdId}</span> (Pending) when its first box was printed. It
          isn&rsquo;t sent for approval until you press Send for Approval; Discard deletes it.
        </div>
      )}
      {error && <div className="mb-3"><ErrorBanner message={error} /></div>}

      {/* ── Section 1 · CR Details ─────────────────────────────────────────── */}
      <Section n={1} title="CR Details">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <div className="space-y-1">
            <label className={labelCls}>Factory Unit <span className="text-[var(--aws-error)]">*</span></label>
            <select value={factoryUnit} onChange={(e) => setFactoryUnit(e.target.value)} className={inputCls}>
              <option value="">Select…</option>
              {factoryUnitOptions.map((w) => (<option key={w} value={w}>{w}</option>))}
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
          title={editId ? "Discard your changes?" : "Discard changes?"}
          confirmLabel="Discard"
          onCancel={() => setShowDiscard(false)}
          onConfirm={async () => {
            if (editId) { leavingRef.current = true; router.push(detailHref(editId)); return; } // the return stays as saved
            // Resolve an in-flight print-create too (createdIdRef isn't set until it
            // resolves) so Discard never leaves the CR it kicked off undeleted.
            let id = createdIdRef.current;
            if (!id && createPromiseRef.current) {
              try { id = await createPromiseRef.current; } catch { /* create failed — nothing to delete */ }
            }
            // If a box was printed (or a send failed) the CR is already saved, Pending —
            // delete it so Discard doesn't leave an orphaned live record behind. It was
            // never sent for approval from here, so the approvers aren't mailed about it.
            if (id) {
              try {
                await deleteCustomerReturn(company, id, { notify: false });
              } catch (e) {
                setError(e instanceof Error ? e.message : "Failed to delete the created return");
                setShowDiscard(false);
                return;
              }
            }
            leavingRef.current = true;
            router.push("/modules/customer-returns");
          }}
        >
          {editId
            ? `Your changes to ${editId} will be lost. Box labels you printed here are already saved on it.`
            : createdId
              ? `${createdId} is already saved. Discarding deletes it, and any box labels printed for it are no longer valid and must be thrown away.`
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
