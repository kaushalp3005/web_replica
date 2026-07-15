"use client";

// Customer Return detail — live. View header/lines/boxes; edit header + lines +
// boxes; enter/print box weights; export label sheet; delete.
//
// Endpoints used (all live Phase 1+2):
//   GET    /{company}/{cr_id}          getCustomerReturn
//   PUT    /{company}/{cr_id}          updateCustomerReturn   (header)
//   PUT    /{company}/{cr_id}/lines    updateCustomerReturnLines
//   PUT    /{company}/{cr_id}/box      upsertBox              (print one box)
//   PUT    /{company}/{cr_id}/boxes    bulkSaveBoxes          (full sync)
//   POST   /box-edit-log               logBoxEdits
//   DELETE /{company}/{cr_id}          deleteCustomerReturn
//
// The status transition (approve/reject/hold) + email is NOT live yet (Phase 3);
// box entry here does not require an approval gate. See ../[id]/approve (stub).

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useRequireAuth, useIsAdmin, useMe } from "@/lib/user";
import {
  getCustomerReturn,
  updateCustomerReturn,
  updateCustomerReturnLines,
  deleteCustomerReturn,
  upsertBox,
  bulkSaveBoxes,
  logBoxEdits,
  type CRWithDetails,
  type CRBox,
  type CRLine,
  type CRHeaderUpdate,
} from "@/lib/customer-returns";
import { CustomerReturnsChrome } from "../_chrome";
import { StatusBadge, ErrorBanner, SuccessBanner, InfoBanner, useCompany, cx, fmtDate, fmtDateTime, num } from "../_shared";
import { printCrLabels } from "../_labelPrint";

interface BoxForm {
  article_description: string;
  box_number: number;
  conversion: string;
  net_weight: string;
  gross_weight: string;
  count: string;
  lot_number: string;
  item_mark: string;
  spl_remarks: string;
  vakkal: string;
  box_id?: string;
  is_printed: boolean;
}

interface LineForm {
  item_description: string;
  material_type: string;
  item_category: string;
  sub_category: string;
  sale_group: string;
  uom: string;
  qty: string;
  rate: string;
  value: string;
  conversion: string;
  net_weight: string;
  carton_weight: string;
  lot_number: string;
  item_mark: string;
  spl_remarks: string;
  vakkal: string;
}

const inputCls = "h-8 rounded border border-[var(--aws-border)] px-2 text-[12px] bg-white w-full";
const roCls = "h-8 rounded border border-[var(--aws-border)] px-2 text-[12px] bg-[var(--background)] w-full";
const labelCls = "text-[11px] text-[var(--text-secondary)]";

function toLineForm(l: CRLine): LineForm {
  return {
    item_description: l.item_description,
    material_type: l.material_type || "",
    item_category: l.item_category || "",
    sub_category: l.sub_category || "",
    sale_group: l.sale_group || "",
    uom: l.uom?.toString() || "",
    qty: l.qty?.toString() || "",
    rate: l.rate?.toString() || "",
    value: l.value?.toString() || "",
    conversion: l.conversion?.toString() || "",
    net_weight: l.net_weight?.toString() || "",
    carton_weight: l.carton_weight?.toString() || "",
    lot_number: l.lot_number || "",
    item_mark: l.item_mark || "",
    spl_remarks: l.spl_remarks || "",
    vakkal: l.vakkal || "",
  };
}

function toBoxForm(b: CRBox): BoxForm {
  return {
    article_description: b.article_description,
    box_number: b.box_number,
    conversion: b.conversion?.toString() || "",
    net_weight: b.net_weight?.toString() || "",
    gross_weight: b.gross_weight?.toString() || "",
    count: b.count?.toString() || "",
    lot_number: b.lot_number || "",
    item_mark: b.item_mark || "",
    spl_remarks: b.spl_remarks || "",
    vakkal: b.vakkal || "",
    box_id: b.box_id || undefined,
    is_printed: !!b.box_id,
  };
}

export default function CustomerReturnDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const crId = decodeURIComponent(params.id);
  useRequireAuth(router.replace);
  const isAdmin = useIsAdmin();
  const me = useMe();
  const [company] = useCompany();

  const [data, setData] = useState<CRWithDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lineForms, setLineForms] = useState<LineForm[]>([]);
  const [boxForms, setBoxForms] = useState<BoxForm[]>([]);
  const [lotSnapshots, setLotSnapshots] = useState<Map<string, string>>(new Map());

  const [deleting, setDeleting] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [printingAll, setPrintingAll] = useState(false);
  const [printingBoxKey, setPrintingBoxKey] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await getCustomerReturn(company, crId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load customer return");
    } finally {
      setLoading(false);
    }
  }, [company, crId]);

  useEffect(() => {
    if (!isAdmin) return;
    // Defer so the first setState isn't synchronous in the effect body.
    queueMicrotask(() => { refresh(); });
  }, [isAdmin, refresh]);

  const lineUom = useCallback(
    (article: string) => num(lineForms.find((l) => l.item_description === article)?.uom),
    [lineForms],
  );
  const lineCarton = useCallback(
    (article: string) => num(lineForms.find((l) => l.item_description === article)?.carton_weight),
    [lineForms],
  );

  function enterEdit() {
    if (!data) return;
    setLineForms(data.lines.map(toLineForm));
    const bf = data.boxes.map(toBoxForm);
    setBoxForms(bf);
    const snap = new Map<string, string>();
    bf.forEach((b) => { if (b.box_id) snap.set(b.box_id, b.lot_number); });
    setLotSnapshots(snap);
    setEditing(true);
    setNotice(null);
  }

  function cancelEdit() {
    setEditing(false);
    setLineForms([]);
    setBoxForms([]);
    setLotSnapshots(new Map());
  }

  function updateLine(idx: number, field: keyof LineForm, value: string) {
    setLineForms((prev) =>
      prev.map((l, i) => {
        if (i !== idx) return l;
        const next = { ...l, [field]: value };
        if (field === "qty" || field === "rate") {
          const qty = num(field === "qty" ? value : l.qty);
          const rate = num(field === "rate" ? value : l.rate);
          if (qty > 0 && rate > 0) next.value = String(qty * rate);
        }
        return next;
      }),
    );
  }

  function updateBox(article: string, boxNumber: number, field: keyof BoxForm, value: string) {
    setBoxForms((prev) =>
      prev.map((b) => {
        if (b.article_description !== article || b.box_number !== boxNumber) return b;
        const next = { ...b, [field]: value };
        if (field === "count") {
          const cnt = num(value);
          const uom = lineUom(article);
          if (cnt > 0 && uom > 0) next.conversion = String(parseFloat((cnt * uom).toFixed(3)));
        }
        if (field === "gross_weight") {
          const carton = lineCarton(article);
          if (carton > 0) next.net_weight = String(Math.max(0, parseFloat((num(value) - carton).toFixed(3))));
        }
        return next;
      }),
    );
  }

  function addBox(article: string) {
    setBoxForms((prev) => {
      const existing = prev.filter((b) => b.article_description === article);
      const uom = lineUom(article);
      return [
        ...prev,
        {
          article_description: article,
          box_number: existing.length + 1,
          conversion: uom > 0 ? String(uom) : "",
          net_weight: "",
          gross_weight: "",
          count: "1",
          lot_number: "",
          item_mark: "",
          spl_remarks: "",
          vakkal: "",
          box_id: undefined,
          is_printed: false,
        },
      ];
    });
  }

  function removeBox(article: string, boxNumber: number) {
    setBoxForms((prev) => {
      const kept = prev.filter((b) => !(b.article_description === article && b.box_number === boxNumber));
      let n = 1;
      return kept.map((b) => (b.article_description === article ? { ...b, box_number: n++ } : b));
    });
  }

  const boxToBulk = (b: BoxForm) => ({
    article_description: b.article_description,
    box_number: b.box_number,
    uom: lineForms.find((l) => l.item_description === b.article_description)?.uom || undefined,
    conversion: b.conversion ?? undefined,
    lot_number: b.lot_number ?? undefined,
    item_mark: b.item_mark ?? undefined,
    spl_remarks: b.spl_remarks ?? undefined,
    vakkal: b.vakkal ?? undefined,
    net_weight: b.net_weight || undefined,
    gross_weight: b.gross_weight || undefined,
    count: b.count ? parseInt(b.count) : undefined,
  });

  async function handleSave() {
    if (!data) return;
    setSaving(true);
    setError(null);
    try {
      // 1. Header
      const header: CRHeaderUpdate = {
        factory_unit: data.factory_unit,
        customer: data.customer,
      };
      // 2. Lines (full replace)
      if (lineForms.length > 0) {
        await updateCustomerReturnLines(
          company,
          crId,
          lineForms.map((l) => ({
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
          })),
        );
      }
      // 3. Boxes (full sync)
      await bulkSaveBoxes(company, crId, boxForms.map(boxToBulk), { allowClear: true });
      // keep header call last & tolerant — header rarely changes here
      await updateCustomerReturn(company, crId, header).catch(() => undefined);

      // 4. Best-effort: log box lot changes for printed boxes
      const changed = boxForms.filter((b) => b.box_id && (lotSnapshots.get(b.box_id) ?? "") !== b.lot_number);
      await Promise.all(
        changed.map((b) =>
          logBoxEdits({
            email_id: me?.email || "unknown",
            box_id: b.box_id!,
            rtv_id: crId,
            changes: [{ field_name: "lot_number", old_value: lotSnapshots.get(b.box_id!) ?? "", new_value: b.lot_number }],
          }).catch(() => undefined),
        ),
      );

      await refresh();
      cancelEdit();
      setNotice("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save changes");
    } finally {
      setSaving(false);
    }
  }

  async function handlePrintBox(article: string, boxNumber: number) {
    const box = boxForms.find((b) => b.article_description === article && b.box_number === boxNumber);
    if (!box) return;
    const key = `${article}#${boxNumber}`;
    setPrintingBoxKey(key);
    setError(null);
    try {
      const res = await upsertBox(company, crId, {
        article_description: box.article_description,
        box_number: box.box_number,
        uom: lineForms.find((l) => l.item_description === article)?.uom || undefined,
        conversion: box.conversion || undefined,
        net_weight: box.net_weight || undefined,
        gross_weight: box.gross_weight || undefined,
        lot_number: box.lot_number || undefined,
        item_mark: box.item_mark || undefined,
        count: box.count ? parseInt(box.count) : undefined,
      });
      // reflect the minted/kept box_id locally
      setBoxForms((prev) =>
        prev.map((b) =>
          b.article_description === article && b.box_number === boxNumber
            ? { ...b, box_id: res.box_id, is_printed: true }
            : b,
        ),
      );
      await printCrLabels({
        company,
        crId,
        customer: data?.customer,
        rtvDate: data?.rtv_date,
        boxes: [{ ...box, box_id: res.box_id }],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Print failed");
    } finally {
      setPrintingBoxKey(null);
    }
  }

  async function handlePrintAll() {
    if (!data) return;
    const printed = data.boxes.filter((b) => b.box_id);
    if (printed.length === 0) {
      setNotice("No printed boxes to reprint yet.");
      return;
    }
    setPrintingAll(true);
    try {
      await printCrLabels({
        company,
        crId,
        customer: data.customer,
        rtvDate: data.rtv_date,
        boxes: printed.map((b) => ({
          box_id: b.box_id,
          box_number: b.box_number,
          article_description: b.article_description,
          net_weight: b.net_weight,
          gross_weight: b.gross_weight,
          count: b.count,
          lot_number: b.lot_number,
          item_mark: b.item_mark,
        })),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Print failed");
    } finally {
      setPrintingAll(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteCustomerReturn(company, crId);
      router.push("/modules/customer-returns");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
      setDeleting(false);
    }
  }

  const totalQty = useMemo(() => (data ? data.lines.reduce((s, l) => s + num(l.qty), 0) : 0), [data]);
  const totalValue = useMemo(() => (data ? data.lines.reduce((s, l) => s + num(l.value), 0) : 0), [data]);

  if (!isAdmin) {
    return (
      <CustomerReturnsChrome title="Detail">
        <section className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)]">
          You don&rsquo;t have access to the Customer Returns module.
        </section>
      </CustomerReturnsChrome>
    );
  }

  if (loading) {
    return (
      <CustomerReturnsChrome title="Detail">
        <div className="p-8 text-[13px] text-[var(--text-secondary)]">Loading…</div>
      </CustomerReturnsChrome>
    );
  }

  if (error && !data) {
    return (
      <CustomerReturnsChrome title="Detail">
        <div className="mb-3"><ErrorBanner message={error} /></div>
        <button onClick={() => router.push("/modules/customer-returns")} className="text-[13px] rounded-md border border-[var(--aws-border)] px-3 py-1.5 bg-white">
          ← Back to list
        </button>
      </CustomerReturnsChrome>
    );
  }
  if (!data) return null;

  const articles = editing ? lineForms.map((l) => l.item_description) : data.lines.map((l) => l.item_description);

  return (
    <CustomerReturnsChrome title={data.rtv_id}>
      {/* Header row */}
      <div className="flex items-start gap-3 mb-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-[18px] font-bold text-[var(--text-primary)] break-all">{data.rtv_id}</h1>
            <StatusBadge status={data.status} />
            <span className="text-[11px] text-[var(--text-secondary)] border border-[var(--aws-border)] rounded px-1.5 py-0.5">{company}</span>
          </div>
          <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">
            Created {fmtDateTime(data.created_ts)}{data.created_by ? ` by ${data.created_by}` : ""}
          </p>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-2 flex-wrap">
          {!editing && (
            <button onClick={enterEdit} className="text-[13px] rounded-md border border-[var(--aws-border)] px-3 py-1.5 bg-white hover:border-[var(--aws-orange)]">
              Edit details / boxes
            </button>
          )}
          {editing && (
            <>
              <button onClick={handleSave} disabled={saving} className="text-[13px] font-semibold rounded-md px-3 py-1.5 bg-[var(--aws-orange)] text-white hover:bg-[var(--aws-orange-hover)] disabled:opacity-50">
                {saving ? "Saving…" : "Save"}
              </button>
              <button onClick={cancelEdit} disabled={saving} className="text-[13px] rounded-md border border-[var(--aws-border)] px-3 py-1.5 bg-white">
                Cancel
              </button>
            </>
          )}
          {!editing && data.boxes.some((b) => b.box_id) && (
            <button onClick={handlePrintAll} disabled={printingAll} className="text-[13px] rounded-md border border-[var(--aws-border)] px-3 py-1.5 bg-white hover:border-[var(--aws-orange)] disabled:opacity-50">
              {printingAll ? "Printing…" : "Print all labels"}
            </button>
          )}
          <Link href={`/modules/customer-returns/${data.rtv_id}/approve`} className="text-[13px] rounded-md border border-[var(--aws-border)] px-3 py-1.5 bg-white hover:border-[var(--aws-orange)]">
            Review / Approve
          </Link>
          {!editing && data.status === "Pending" && (
            <button onClick={() => setShowDelete(true)} className="text-[13px] rounded-md border border-[var(--aws-border)] px-3 py-1.5 bg-white text-[var(--aws-error)]">
              Delete
            </button>
          )}
        </div>
      </div>

      {error && <div className="mb-3"><ErrorBanner message={error} /></div>}
      {notice && <div className="mb-3"><SuccessBanner message={notice} /></div>}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          {/* CR Information */}
          <section className="bg-white border border-[var(--aws-border)] rounded-md p-4">
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)] mb-3">CR Information</h2>
            <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3 text-[13px]">
              <Info label="Factory Unit" value={data.factory_unit} />
              <Info label="Customer" value={data.customer} />
              <Info label="Invoice Number" value={data.invoice_number} />
              <Info label="Challan No" value={data.challan_no} />
              <Info label="DN No" value={data.dn_no} />
              <Info label="Sales POC" value={data.sales_poc} />
              <Info label="Business Head" value={data.business_head} />
              <Info label="CR Date" value={fmtDate(data.rtv_date)} />
              <Info label="Vehicle Number" value={data.vehicle_number} />
              <Info label="Transporter" value={data.transporter_name} />
              <Info label="Driver Name" value={data.driver_name} />
              <Info label="Inward Manager" value={data.inward_manager} />
            </dl>
            {data.remark && (
              <div className="mt-3 pt-3 border-t border-[var(--aws-border)]">
                <Info label="Remark" value={data.remark} />
              </div>
            )}
          </section>

          {/* Lines */}
          <section className="bg-white border border-[var(--aws-border)] rounded-md p-4">
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)] mb-3">
              Line Items ({editing ? lineForms.length : data.lines.length})
            </h2>
            {editing ? (
              <div className="space-y-3">
                {lineForms.map((l, idx) => (
                  <div key={idx} className="border border-dashed border-[var(--aws-border)] rounded-md p-3">
                    <div className="flex items-center gap-2 flex-wrap mb-2">
                      <p className="text-[12px] font-medium text-[var(--text-primary)] break-words">{l.item_description}</p>
                      {l.sale_group && <span className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--aws-border)] bg-[var(--background)] text-[var(--text-secondary)]">Sale Group: {l.sale_group}</span>}
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      <Fld label="UOM"><input value={l.uom} onChange={(e) => updateLine(idx, "uom", e.target.value)} className={inputCls} /></Fld>
                      <Fld label="Qty"><input type="number" step="0.001" value={l.qty} onChange={(e) => updateLine(idx, "qty", e.target.value)} className={inputCls} /></Fld>
                      <Fld label="Rate"><input type="number" step="0.01" value={l.rate} onChange={(e) => updateLine(idx, "rate", e.target.value)} className={inputCls} /></Fld>
                      <Fld label="Value"><input value={l.value} readOnly className={roCls} /></Fld>
                      <Fld label="Carton Wt"><input type="number" step="0.001" value={l.carton_weight} onChange={(e) => updateLine(idx, "carton_weight", e.target.value)} className={inputCls} /></Fld>
                      <Fld label="Net Wt"><input type="number" step="0.001" value={l.net_weight} onChange={(e) => updateLine(idx, "net_weight", e.target.value)} className={inputCls} /></Fld>
                      <Fld label="Lot No"><input value={l.lot_number} onChange={(e) => updateLine(idx, "lot_number", e.target.value)} className={inputCls} /></Fld>
                      <Fld label="Item Mark"><input value={l.item_mark} onChange={(e) => updateLine(idx, "item_mark", e.target.value)} className={inputCls} /></Fld>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-2">
                {data.lines.map((l) => (
                  <div key={l.item_description} className="border border-[var(--aws-border)] rounded-md p-3 bg-[var(--background)]">
                    <p className="text-[13px] font-medium text-[var(--text-primary)] break-words">{l.item_description}</p>
                    <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1.5 text-[12px] mt-1.5">
                      <Info small label="Material" value={l.material_type} />
                      <Info small label="Category" value={l.item_category} />
                      <Info small label="Sub Cat" value={l.sub_category} />
                      <Info small label="Sale Group" value={l.sale_group} />
                      <Info small label="UOM" value={l.uom} />
                      <Info small label="Qty" value={l.qty} />
                      <Info small label="Rate" value={l.rate} />
                      <Info small label="Value" value={l.value} />
                      <Info small label="Net Wt" value={l.net_weight} />
                      <Info small label="Lot" value={l.lot_number} />
                      <Info small label="Item Mark" value={l.item_mark} />
                    </dl>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Boxes */}
          <section className="bg-white border border-[var(--aws-border)] rounded-md p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">Boxes ({editing ? boxForms.length : data.boxes.length})</h2>
            </div>

            {!editing && (
              <div className="mb-3">
                <InfoBanner>
                  Box weights &amp; QR labels are entered here. Approval/email routing is a later phase — box entry is
                  available now.
                </InfoBanner>
              </div>
            )}

            {editing ? (
              <div className="space-y-4">
                {articles.map((article) => {
                  const boxes = boxForms.filter((b) => b.article_description === article);
                  return (
                    <div key={article} className="border border-[var(--aws-border)] rounded-md p-3">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-[12px] font-medium text-[var(--text-primary)] break-words">{article}</p>
                        <button onClick={() => addBox(article)} className="text-[11px] rounded border border-[var(--aws-border)] px-2 py-1 bg-white hover:border-[var(--aws-orange)]">
                          + Add Box
                        </button>
                      </div>
                      {boxes.length === 0 ? (
                        <p className="text-[11px] text-[var(--text-secondary)]">No boxes. Click “Add Box”.</p>
                      ) : (
                        <div className="space-y-2">
                          {boxes.map((b) => {
                            const key = `${article}#${b.box_number}`;
                            return (
                              <div key={key} className="grid grid-cols-2 sm:grid-cols-6 gap-2 items-end border-t border-[var(--aws-border)] pt-2 first:border-t-0 first:pt-0">
                                <Fld label={`Box #${b.box_number}`}>
                                  <input value={b.conversion} readOnly className={roCls} title="Conversion (count × UOM)" />
                                </Fld>
                                <Fld label="Net Wt"><input type="number" step="0.001" value={b.net_weight} onChange={(e) => updateBox(article, b.box_number, "net_weight", e.target.value)} className={inputCls} /></Fld>
                                <Fld label="Gross Wt"><input type="number" step="0.001" value={b.gross_weight} onChange={(e) => updateBox(article, b.box_number, "gross_weight", e.target.value)} className={inputCls} /></Fld>
                                <Fld label="Count"><input type="number" value={b.count} onChange={(e) => updateBox(article, b.box_number, "count", e.target.value)} className={inputCls} /></Fld>
                                <Fld label="Lot"><input value={b.lot_number} onChange={(e) => updateBox(article, b.box_number, "lot_number", e.target.value)} className={inputCls} /></Fld>
                                <div className="flex items-center gap-1">
                                  <button
                                    onClick={() => handlePrintBox(article, b.box_number)}
                                    disabled={printingBoxKey === key}
                                    className="text-[11px] rounded border border-[var(--aws-border)] px-2 py-1.5 bg-white hover:border-[var(--aws-orange)] disabled:opacity-50"
                                    title="Save + print this box"
                                  >
                                    {printingBoxKey === key ? "…" : b.is_printed ? "Reprint" : "Print"}
                                  </button>
                                  <button onClick={() => removeBox(article, b.box_number)} className="text-[11px] text-[var(--aws-error)] px-1" title="Remove box">✕</button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
                <p className="text-[11px] text-[var(--text-secondary)]">
                  “Print” saves that box immediately and mints its QR id. “Save” syncs the full box set (add/update/remove).
                </p>
              </div>
            ) : data.boxes.length === 0 ? (
              <p className="text-[12px] text-[var(--text-secondary)]">No boxes entered yet. Click “Edit details / boxes”.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-[var(--aws-border)] text-left text-[var(--text-secondary)]">
                      <th className="px-2 py-1.5 font-medium">Article</th>
                      <th className="px-2 py-1.5 font-medium">Box #</th>
                      <th className="px-2 py-1.5 font-medium text-right">Conv.</th>
                      <th className="px-2 py-1.5 font-medium text-right">Net</th>
                      <th className="px-2 py-1.5 font-medium text-right">Gross</th>
                      <th className="px-2 py-1.5 font-medium text-right">Count</th>
                      <th className="px-2 py-1.5 font-medium">Lot</th>
                      <th className="px-2 py-1.5 font-medium">QR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.boxes.map((b) => (
                      <tr key={`${b.article_description}#${b.box_number}`} className="border-b border-[var(--aws-border)] last:border-0">
                        <td className="px-2 py-1.5 text-[var(--text-secondary)] truncate max-w-[160px]">{b.article_description}</td>
                        <td className="px-2 py-1.5">{b.box_number}</td>
                        <td className="px-2 py-1.5 text-right">{b.conversion ?? "—"}</td>
                        <td className="px-2 py-1.5 text-right">{b.net_weight ?? "—"}</td>
                        <td className="px-2 py-1.5 text-right">{b.gross_weight ?? "—"}</td>
                        <td className="px-2 py-1.5 text-right">{b.count ?? "—"}</td>
                        <td className="px-2 py-1.5 text-[var(--text-secondary)]">{b.lot_number || "—"}</td>
                        <td className="px-2 py-1.5 text-[var(--text-secondary)]">{b.box_id ? "✓" : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        {/* Summary column */}
        <div className="space-y-4">
          <section className="bg-white border border-[var(--aws-border)] rounded-md p-4">
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)] mb-3">Summary</h2>
            <div className="space-y-2 text-[13px]">
              <Row label="Line Items" value={data.lines.length} />
              <Row label="Boxes" value={data.boxes.length} />
              <div className="border-t border-[var(--aws-border)] my-2" />
              <Row label="Total Qty" value={totalQty} />
              <Row label="Total Value" value={totalValue.toLocaleString()} />
            </div>
          </section>
        </div>
      </div>

      {/* Delete confirm */}
      {showDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={() => !deleting && setShowDelete(false)}>
          <div className="bg-white rounded-lg max-w-md w-full p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">Delete CR</h2>
            <p className="text-[13px] text-[var(--text-secondary)] mt-2">
              Delete <span className="font-medium text-[var(--text-primary)]">{data.rtv_id}</span>? This removes all lines
              and boxes and cannot be undone.
            </p>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setShowDelete(false)} disabled={deleting} className="text-[13px] rounded-md border border-[var(--aws-border)] px-3 py-1.5 bg-white">Cancel</button>
              <button onClick={handleDelete} disabled={deleting} className="text-[13px] rounded-md px-3 py-1.5 bg-[var(--aws-error)] text-white disabled:opacity-50">
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </CustomerReturnsChrome>
  );
}

function Info({ label, value, small }: { label: string; value?: string | number | null; small?: boolean }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="min-w-0">
      <dt className={cx("text-[var(--text-secondary)] uppercase tracking-wide", small ? "text-[10px]" : "text-[11px]")}>{label}</dt>
      <dd className={cx("font-medium text-[var(--text-primary)] break-words", small ? "text-[12px]" : "text-[13px]")}>{value}</dd>
    </div>
  );
}

function Fld({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className={labelCls}>{label}</label>
      {children}
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
