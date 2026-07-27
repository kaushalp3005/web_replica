"use client";

// Customer Return detail — faithful port of the legacy detail page
// (legacy-frontend/app/[company]/customer-returns/[id]/page.tsx): back arrow +
// status(icon) header, CR Information, Line Items (read: full field grid +
// per-article Print range; edit: line fields + cold fields + inline box entry),
// Boxes (read-only table + mobile cards + per-box Reprint + 200/page pagination),
// Summary, delete. Wired to the LIVE endpoints that mirror the legacy /rtv routes,
// keyed by rtv_id (the CR- string; the live backend has no numeric id).
//
// Endpoints (live Phase 1+2):
//   GET    /{company}/{cr_id}          getCustomerReturn
//   PUT    /{company}/{cr_id}          updateCustomerReturn   (header)
//   PUT    /{company}/{cr_id}/lines    updateCustomerReturnLines
//   PUT    /{company}/{cr_id}/box      upsertBox              (print one box)
//   PUT    /{company}/{cr_id}/boxes    bulkSaveBoxes          (full sync)
//   POST   /box-edit-log               logBoxEdits
//   DELETE /{company}/{cr_id}          deleteCustomerReturn
//
// Live adaptation of the legacy split: the legacy detail page defers box-weight
// ENTRY to /approve (its box-entry screen). The live /approve is the stubbed
// approval-matrix preview, so box entry lives HERE in edit mode and is not gated
// on approval (the live approve/email flow is Phase 3).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { ErrorBanner, SuccessBanner, InfoBanner, ConfirmDialog, StatusBadge, CompanyChip, CrHeaderGrid, useCompanyParam, cx, fmtDateTime, num, isColdWarehouse } from "../_shared";
import { printCrLabels } from "../_labelPrint";

// ── Inline SVG icons (lucide look; no lucide dep in web_replica) ──────────────
type IconProps = { className?: string };
const S = ({ className, children }: IconProps & { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className ?? "h-3.5 w-3.5"} aria-hidden="true">{children}</svg>
);
const IconArrowLeft = (p: IconProps) => <S {...p}><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></S>;
const IconFile = (p: IconProps) => <S {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></S>;
const IconPackage = (p: IconProps) => <S {...p}><path d="M16.5 9.4 7.5 4.21" /><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><polyline points="3.29 7 12 12 20.71 7" /><line x1="12" x2="12" y1="22" y2="12" /></S>;
const IconArchive = (p: IconProps) => <S {...p}><rect width="20" height="5" x="2" y="3" rx="1" /><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" /><path d="M10 12h4" /></S>;
const IconPrinter = (p: IconProps) => <S {...p}><path d="M6 9V2h12v7" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="8" rx="1" /></S>;
const IconTrash = (p: IconProps) => <S {...p}><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></S>;
const IconChevronLeft = (p: IconProps) => <S {...p}><path d="m15 18-6-6 6-6" /></S>;
const IconChevronRight = (p: IconProps) => <S {...p}><path d="m9 18 6-6-6-6" /></S>;
const IconSpinner = (p: IconProps) => <S className={p.className ?? "h-3.5 w-3.5 animate-spin"}><path d="M21 12a9 9 0 1 1-6.219-8.56" /></S>;

const BOX_PAGE_SIZE = 200; // window the read-only box list so large CRs open fast (legacy parity)

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
const rangeInputCls = "h-7 w-20 rounded border border-[var(--aws-border)] px-2 text-[12px] bg-white";

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

// CRBox -> the label-print box shape (shared by reprint one / range / all).
const toLabelBox = (b: CRBox) => ({
  box_id: b.box_id ?? undefined,
  box_number: b.box_number,
  article_description: b.article_description,
  net_weight: b.net_weight,
  gross_weight: b.gross_weight,
  count: b.count,
  lot_number: b.lot_number,
  item_mark: b.item_mark,
});

export default function CustomerReturnDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const crId = decodeURIComponent(params.id);
  useRequireAuth(router.replace);
  const isAdmin = useIsAdmin();
  const me = useMe();
  const company = useCompanyParam();

  const [data, setData] = useState<CRWithDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lineForms, setLineForms] = useState<LineForm[]>([]);
  const [boxForms, setBoxForms] = useState<BoxForm[]>([]);
  const [lotSnapshots, setLotSnapshots] = useState<Map<string, string>>(new Map());
  // Per-article highest box_number ever used this edit session (incl. removed) —
  // so a re-add never reuses a freed number and silently merges into a live row.
  const boxHighWater = useRef<Record<string, number>>({});

  const [deleting, setDeleting] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [printingAll, setPrintingAll] = useState(false);
  const [printingBoxKey, setPrintingBoxKey] = useState<string | null>(null); // edit-mode per-box print
  const [printingBoxId, setPrintingBoxId] = useState<string | null>(null); // read-mode reprint
  const [printingRange, setPrintingRange] = useState<string | null>(null);
  const [printRange, setPrintRange] = useState<Record<string, { from: string; to: string }>>({});
  const [boxPage, setBoxPage] = useState(1);

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
    // Seed box-number high-water from the loaded boxes.
    const hw: Record<string, number> = {};
    bf.forEach((b) => { hw[b.article_description] = Math.max(hw[b.article_description] ?? 0, b.box_number); });
    boxHighWater.current = hw;
    setEditing(true);
    setNotice(null);
  }

  function cancelEdit() {
    setEditing(false);
    setLineForms([]);
    setBoxForms([]);
    setLotSnapshots(new Map());
    boxHighWater.current = {};
  }

  function updateLine(idx: number, field: keyof LineForm, value: string) {
    setLineForms((prev) =>
      prev.map((l, i) => {
        if (i !== idx) return l;
        // qty column is INTEGER server-side — floor typed qty so the shown value
        // and the persisted value agree (no silent 10.5 -> 10 truncation on save).
        let v = value;
        if (field === "qty" && value !== "") {
          const t = Math.trunc(num(value));
          v = Number.isFinite(t) ? String(t) : "";
        }
        const next = { ...l, [field]: v };
        if (field === "qty" || field === "rate") {
          const qty = num(field === "qty" ? v : l.qty);
          const rate = num(field === "rate" ? value : l.rate);
          // Recompute on every change (Value is read-only): clearing/zeroing an
          // operand resets Value to "0" instead of leaving a stale product.
          next.value = qty > 0 && rate > 0 ? String(qty * rate) : "0";
        }
        return next;
      }),
    );
  }

  // Cold-warehouse convenience (legacy cascadeArticleField): a line-level cold
  // field cascades to the line AND every one of that article's boxes at once.
  function updateColdArticleField(idx: number, field: "lot_number" | "item_mark" | "spl_remarks" | "vakkal", value: string) {
    updateLine(idx, field, value);
    const article = lineForms[idx]?.item_description;
    if (!article) return;
    setBoxForms((prev) => prev.map((b) => (b.article_description === article ? { ...b, [field]: value } : b)));
  }

  // Bulk lot allocation (legacy LotRangeDedicator applyLotRanges): stamp a lot
  // number onto an article's boxes whose box_number is within [from, to].
  function applyLotRange(article: string, from: number, to: number, lot: string) {
    setBoxForms((prev) =>
      prev.map((b) => (b.article_description === article && b.box_number >= from && b.box_number <= to ? { ...b, lot_number: lot } : b)),
    );
  }

  function updateBox(article: string, boxNumber: number, field: keyof BoxForm, value: string) {
    setBoxForms((prev) =>
      prev.map((b) => {
        if (b.article_description !== article || b.box_number !== boxNumber) return b;
        // Round typed net/gross to 3dp — the backend types weights Decimal(18,3)
        // and rejects >3 decimals with a 422 that fails the whole save/print.
        let v = value;
        if ((field === "net_weight" || field === "gross_weight") && value !== "") {
          const parts = value.split(".");
          if (parts[1] && parts[1].length > 3 && !isNaN(parseFloat(value))) v = String(parseFloat(parseFloat(value).toFixed(3)));
        }
        const next = { ...b, [field]: v };
        if (field === "count") {
          const cnt = num(v);
          const uom = lineUom(article);
          if (cnt > 0 && uom > 0) next.conversion = String(parseFloat((cnt * uom).toFixed(3)));
        }
        if (field === "gross_weight") {
          const carton = lineCarton(article);
          if (carton > 0) next.net_weight = String(Math.max(0, parseFloat((num(v) - carton).toFixed(3))));
        }
        return next;
      }),
    );
  }

  function addBox(article: string) {
    const existing = boxForms.filter((b) => b.article_description === article);
    // High-water numbering: one past the highest number EVER used this session
    // (including removed boxes), never a plain max(existing)+1. Reusing a number
    // freed by removing the top box would make the server UPDATE (merge into) that
    // box's still-live DB row instead of delete+insert — so the "new" box would
    // silently inherit the removed box's box_id and weights.
    const nextNum = Math.max(boxHighWater.current[article] ?? 0, ...existing.map((b) => b.box_number), 0) + 1;
    boxHighWater.current[article] = nextNum;
    const uom = lineUom(article);
    setBoxForms((prev) => [
      ...prev,
      {
        article_description: article,
        box_number: nextNum,
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
    ]);
  }

  function removeBox(article: string, boxNumber: number) {
    // Do NOT renumber the survivors. box_number is the server's identity key
    // (bulk_save_boxes matches rows by (article_description, box_number) and never
    // receives box_id), so renumbering would slide each saved box's box_id onto a
    // different box's data and delete a real box_id — desyncing printed QR labels.
    // Dropping just this box makes the server delete exactly the removed
    // (article, box_number) row and keep every other box_id intact.
    setBoxForms((prev) => prev.filter((b) => !(b.article_description === article && b.box_number === boxNumber)));
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
      // 1. Header (rarely changes here; tolerant)
      const header: CRHeaderUpdate = { factory_unit: data.factory_unit, customer: data.customer };
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

  // Edit-mode: save + print a single box, minting/keeping its box_id.
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
      setBoxForms((prev) =>
        prev.map((b) =>
          b.article_description === article && b.box_number === boxNumber ? { ...b, box_id: res.box_id, is_printed: true } : b,
        ),
      );
      // Seed the lot snapshot for the freshly-minted box_id so a later Save only
      // logs a lot change if the lot is edited AFTER this print (not "" -> current).
      setLotSnapshots((prev) => new Map(prev).set(res.box_id, box.lot_number));
      await printCrLabels({ company, crId, customer: data?.customer, rtvDate: data?.rtv_date, boxes: [{ ...box, box_id: res.box_id }] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Print failed");
    } finally {
      setPrintingBoxKey(null);
    }
  }

  // Read-mode: reprint one already-printed box's QR label.
  async function handleReprintLabel(box: CRBox) {
    if (!data || !box.box_id) return;
    setPrintingBoxId(box.box_id);
    setError(null);
    try {
      await printCrLabels({ company, crId, customer: data.customer, rtvDate: data.rtv_date, boxes: [toLabelBox(box)] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Print failed");
    } finally {
      setPrintingBoxId(null);
    }
  }

  // Read-mode: reprint every printed box of an article within [from, to].
  async function printArticleRange(article: string) {
    if (!data) return;
    const r = printRange[article];
    const from = parseInt(r?.from || "1");
    const to = parseInt(r?.to || "999999");
    if (Number.isNaN(from) || Number.isNaN(to)) return;
    const boxes = data.boxes.filter((b) => b.article_description === article && b.box_id && b.box_number >= from && b.box_number <= to);
    if (boxes.length === 0) { setNotice("No printed boxes in that range."); return; }
    setPrintingRange(article);
    setError(null);
    try {
      await printCrLabels({ company, crId, customer: data.customer, rtvDate: data.rtv_date, boxes: boxes.map(toLabelBox) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Print failed");
    } finally {
      setPrintingRange(null);
    }
  }

  async function handlePrintAll() {
    if (!data) return;
    const printed = data.boxes.filter((b) => b.box_id);
    if (printed.length === 0) { setNotice("No printed boxes to reprint yet."); return; }
    setPrintingAll(true);
    setError(null);
    try {
      await printCrLabels({ company, crId, customer: data.customer, rtvDate: data.rtv_date, boxes: printed.map(toLabelBox) });
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
      router.push(`/modules/customer-returns?company=${company}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
      setDeleting(false);
      setShowDelete(false);
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
        <div className="space-y-4">
          <div className="h-8 w-56 rounded bg-[var(--background)] animate-pulse" />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 space-y-4">
              <div className="h-40 rounded-md bg-[var(--background)] animate-pulse" />
              <div className="h-60 rounded-md bg-[var(--background)] animate-pulse" />
            </div>
            <div className="h-40 rounded-md bg-[var(--background)] animate-pulse" />
          </div>
        </div>
      </CustomerReturnsChrome>
    );
  }

  if (error && !data) {
    return (
      <CustomerReturnsChrome title="Detail">
        <div className="mb-3"><ErrorBanner message={error} /></div>
        <Link href={`/modules/customer-returns?company=${company}`} className="inline-block text-[13px] rounded-md border border-[var(--aws-border)] px-3 py-1.5 bg-white">
          ← Back to list
        </Link>
      </CustomerReturnsChrome>
    );
  }
  if (!data) return null;

  const isCold = isColdWarehouse(data.factory_unit);
  const hasBoxes = data.boxes.length > 0;
  const hasPrinted = data.boxes.some((b) => b.box_id);
  const articles = editing ? lineForms.map((l) => l.item_description) : data.lines.map((l) => l.item_description);

  const totalBoxPages = Math.max(1, Math.ceil(data.boxes.length / BOX_PAGE_SIZE));
  const safeBoxPage = Math.min(Math.max(1, boxPage), totalBoxPages);
  const pageBoxes = data.boxes.slice((safeBoxPage - 1) * BOX_PAGE_SIZE, safeBoxPage * BOX_PAGE_SIZE);

  const setRange = (article: string, key: "from" | "to", value: string) =>
    setPrintRange((p) => ({ ...p, [article]: { ...(p[article] ?? { from: "", to: "" }), [key]: value } }));

  return (
    <CustomerReturnsChrome title={data.rtv_id}>
      {/* Header */}
      <div className="flex items-start gap-2 mb-4">
        <Link href={`/modules/customer-returns?company=${company}`} aria-label="Back to list" className="h-8 w-8 mt-0.5 inline-flex items-center justify-center rounded-md hover:bg-[var(--background)] text-[var(--text-secondary)] flex-shrink-0">
          <IconArrowLeft className="h-4 w-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-[18px] sm:text-[22px] font-bold tracking-tight text-[var(--text-primary)] break-all">{data.rtv_id}</h1>
            <StatusBadge status={data.status} />
            <CompanyChip company={company} />
          </div>
          <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">
            Created {fmtDateTime(data.created_ts)}
          </p>
        </div>
      </div>

      {/* Action row */}
      <div className="flex flex-wrap items-center gap-2 mb-4 pl-10">
        {!editing && (
          <button onClick={enterEdit} className="h-8 text-[13px] rounded-md border border-[var(--aws-border)] px-3 bg-white hover:border-[var(--aws-orange)]">
            Edit details / boxes
          </button>
        )}
        {editing && (
          <>
            <button onClick={handleSave} disabled={saving} className="h-8 inline-flex items-center gap-1.5 text-[13px] font-semibold rounded-md px-3 bg-[var(--aws-orange)] text-white hover:bg-[var(--aws-orange-hover)] disabled:opacity-50">
              {saving && <IconSpinner className="h-3.5 w-3.5 animate-spin" />}{saving ? "Saving…" : "Save"}
            </button>
            <button onClick={cancelEdit} disabled={saving} className="h-8 text-[13px] rounded-md border border-[var(--aws-border)] px-3 bg-white">Cancel</button>
          </>
        )}
        {!editing && hasPrinted && (
          <button onClick={handlePrintAll} disabled={printingAll} className="h-8 inline-flex items-center gap-1.5 text-[13px] rounded-md border border-[var(--aws-border)] px-3 bg-white hover:border-[var(--aws-orange)] disabled:opacity-50">
            {printingAll ? <IconSpinner className="h-3.5 w-3.5 animate-spin" /> : <IconPrinter className="h-3.5 w-3.5" />}
            Print all labels
          </button>
        )}
        {!editing && (
          <Link href={`/modules/customer-returns/${encodeURIComponent(data.rtv_id)}/approve?company=${company}`} className="h-8 inline-flex items-center text-[13px] rounded-md border border-[var(--aws-border)] px-3 bg-white hover:border-[var(--aws-orange)]">
            Review
          </Link>
        )}
        {!editing && data.status === "Pending" && (
          <button onClick={() => setShowDelete(true)} className="h-8 inline-flex items-center gap-1.5 text-[13px] rounded-md border border-[var(--aws-border)] px-3 bg-white text-[var(--aws-error)]">
            <IconTrash className="h-3.5 w-3.5" /> Delete
          </button>
        )}
      </div>

      {error && <div className="mb-3"><ErrorBanner message={error} /></div>}
      {notice && <div className="mb-3"><SuccessBanner message={notice} /></div>}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          {/* CR Information */}
          <section className="bg-white border border-[var(--aws-border)] rounded-md p-4">
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-1.5">
              <IconFile className="h-4 w-4 text-[var(--text-secondary)]" /> CR Information
            </h2>
            <CrHeaderGrid cr={data} />
          </section>

          {/* Line Items */}
          <section className="bg-white border border-[var(--aws-border)] rounded-md p-4">
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-1.5">
              <IconPackage className="h-4 w-4 text-[var(--text-secondary)]" /> Line Items ({editing ? lineForms.length : data.lines.length})
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
                      <Fld label="Total Qty (Units)"><input type="number" step="1" min="0" value={l.qty} onChange={(e) => updateLine(idx, "qty", e.target.value)} className={inputCls} /></Fld>
                      <Fld label="Rate"><input type="number" step="0.01" value={l.rate} onChange={(e) => updateLine(idx, "rate", e.target.value)} className={inputCls} /></Fld>
                      <Fld label="Value"><input value={l.value} readOnly className={roCls} /></Fld>
                      <Fld label="Carton Wt"><input type="number" step="0.001" value={l.carton_weight} onChange={(e) => updateLine(idx, "carton_weight", e.target.value)} className={inputCls} /></Fld>
                      <Fld label="Net Wt"><input type="number" step="0.001" value={l.net_weight} onChange={(e) => updateLine(idx, "net_weight", e.target.value)} className={inputCls} /></Fld>
                      {isCold && (
                        <>
                          <Fld label="Lot No"><input value={l.lot_number} onChange={(e) => updateColdArticleField(idx, "lot_number", e.target.value)} className={inputCls} /></Fld>
                          <Fld label="Item Mark"><input value={l.item_mark} onChange={(e) => updateColdArticleField(idx, "item_mark", e.target.value)} className={inputCls} /></Fld>
                          <Fld label="Spl. Remarks"><input value={l.spl_remarks} onChange={(e) => updateColdArticleField(idx, "spl_remarks", e.target.value)} className={inputCls} /></Fld>
                          <Fld label="Vakkal"><input value={l.vakkal} onChange={(e) => updateColdArticleField(idx, "vakkal", e.target.value)} className={inputCls} /></Fld>
                        </>
                      )}
                    </div>
                    {isCold && (
                      <LotAllocator
                        boxCount={boxForms.filter((b) => b.article_description === l.item_description).length}
                        onApply={(from, to, lot) => applyLotRange(l.item_description, from, to, lot)}
                      />
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-2">
                {data.lines.map((l) => {
                  const articleHasPrinted = data.boxes.some((b) => b.article_description === l.item_description && b.box_id);
                  return (
                    <div key={l.item_description} className="border border-[var(--aws-border)] rounded-md p-3 bg-[var(--background)]">
                      <p className="text-[13px] font-medium text-[var(--text-primary)] break-words">{l.item_description}</p>
                      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1.5 text-[12px] mt-1.5">
                        <Info small label="Material Type" value={l.material_type} />
                        <Info small label="Item Category" value={l.item_category} />
                        <Info small label="Sub Category" value={l.sub_category} />
                        <Info small label="Sale Group" value={l.sale_group} />
                        <Info small label="UOM" value={l.uom} />
                        <Info small label="Total Qty (Units)" value={l.qty} />
                        <Info small label="Rate" value={l.rate} />
                        <Info small label="Value" value={l.value} />
                        <Info small label="Carton Weight" value={l.carton_weight} />
                        <Info small label="Net Weight" value={l.net_weight} />
                        <Info small label="Lot No" value={l.lot_number} />
                        <Info small label="Item Mark" value={l.item_mark} />
                        <Info small label="Spl. Remarks" value={l.spl_remarks} />
                        <Info small label="Vakkal" value={l.vakkal} />
                      </dl>
                      {/* Per-article Print range (only when this article has printed boxes) */}
                      {articleHasPrinted && (
                        <div className="flex flex-wrap items-end gap-2 pt-2 mt-2 border-t border-[var(--aws-border)]">
                          <span className="text-[11px] font-medium text-[var(--text-secondary)]">Print range:</span>
                          <input type="number" min="1" placeholder="From" aria-label="Print range from box number" value={printRange[l.item_description]?.from || ""} onChange={(e) => setRange(l.item_description, "from", e.target.value)} className={rangeInputCls} />
                          <input type="number" min="1" placeholder="To" aria-label="Print range to box number" value={printRange[l.item_description]?.to || ""} onChange={(e) => setRange(l.item_description, "to", e.target.value)} className={rangeInputCls} />
                          <button
                            onClick={() => printArticleRange(l.item_description)}
                            disabled={printingRange === l.item_description}
                            className="h-7 inline-flex items-center gap-1 text-[12px] rounded border border-[var(--aws-border)] px-2 bg-white hover:border-[var(--aws-orange)] disabled:opacity-50"
                          >
                            {printingRange === l.item_description ? <IconSpinner className="h-3 w-3 animate-spin" /> : <IconPrinter className="h-3 w-3" />}
                            Print range
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Boxes */}
          <section className="bg-white border border-[var(--aws-border)] rounded-md p-4">
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-1.5">
              <IconArchive className="h-4 w-4 text-[var(--text-secondary)]" /> Boxes ({editing ? boxForms.length : data.boxes.length})
            </h2>

            {!editing && (
              <div className="mb-3">
                <InfoBanner>
                  Box weights &amp; QR labels are entered in <strong>Edit details / boxes</strong>. Approval/email routing is a
                  later phase — box entry is available now.
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
                        <button onClick={() => addBox(article)} className="text-[11px] rounded border border-[var(--aws-border)] px-2 py-1 bg-white hover:border-[var(--aws-orange)]">+ Add Box</button>
                      </div>
                      {boxes.length === 0 ? (
                        <p className="text-[11px] text-[var(--text-secondary)]">No boxes. Click “Add Box”.</p>
                      ) : (
                        <div className="space-y-2">
                          {boxes.map((b) => {
                            const key = `${article}#${b.box_number}`;
                            return (
                              <div key={key} className="grid grid-cols-2 sm:grid-cols-6 gap-2 items-end border-t border-[var(--aws-border)] pt-2 first:border-t-0 first:pt-0">
                                <Fld label={`Box #${b.box_number}`}><input value={b.conversion} readOnly className={roCls} title="Conversion (count × UOM)" /></Fld>
                                <Fld label="Net Wt"><input type="number" step="0.001" value={b.net_weight} onChange={(e) => updateBox(article, b.box_number, "net_weight", e.target.value)} className={inputCls} /></Fld>
                                <Fld label="Gross Wt"><input type="number" step="0.001" value={b.gross_weight} onChange={(e) => updateBox(article, b.box_number, "gross_weight", e.target.value)} className={inputCls} /></Fld>
                                <Fld label="Count"><input type="number" value={b.count} onChange={(e) => updateBox(article, b.box_number, "count", e.target.value)} className={inputCls} /></Fld>
                                <Fld label="Lot"><input value={b.lot_number} onChange={(e) => updateBox(article, b.box_number, "lot_number", e.target.value)} className={inputCls} /></Fld>
                                <div className="flex items-center gap-1">
                                  <button onClick={() => handlePrintBox(article, b.box_number)} disabled={printingBoxKey === key} className="text-[11px] rounded border border-[var(--aws-border)] px-2 py-1.5 bg-white hover:border-[var(--aws-orange)] disabled:opacity-50" title="Save + print this box">
                                    {printingBoxKey === key ? "…" : b.is_printed ? "Reprint" : "Print"}
                                  </button>
                                  <button onClick={() => removeBox(article, b.box_number)} aria-label={`Remove box ${b.box_number}`} className="text-[11px] text-[var(--aws-error)] px-1" title="Remove box">✕</button>
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
            ) : !hasBoxes ? (
              <p className="text-[12px] text-[var(--text-secondary)]">No boxes entered yet. Click “Edit details / boxes”.</p>
            ) : (
              <>
                {/* Desktop table */}
                <div className="hidden sm:block overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="border-b border-[var(--aws-border)] bg-[var(--background)] text-left text-[var(--text-secondary)]">
                        <th className="px-2 py-1.5 font-medium">Article</th>
                        <th className="px-2 py-1.5 font-medium">Box #</th>
                        <th className="px-2 py-1.5 font-medium text-right">Conv.</th>
                        <th className="px-2 py-1.5 font-medium text-right">Net Wt</th>
                        <th className="px-2 py-1.5 font-medium text-right">Gross Wt</th>
                        <th className="px-2 py-1.5 font-medium text-right">Count</th>
                        <th className="px-2 py-1.5 font-medium">Lot</th>
                        <th className="px-2 py-1.5 font-medium text-center w-[56px]">Print</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageBoxes.map((b) => (
                        <tr key={`${b.article_description}#${b.box_number}`} className="border-b border-[var(--aws-border)] last:border-0">
                          <td className="px-2 py-1.5 text-[var(--text-secondary)] truncate max-w-[160px]">{b.article_description}</td>
                          <td className="px-2 py-1.5">{b.box_number}</td>
                          <td className="px-2 py-1.5 text-right">{b.conversion ?? "—"}</td>
                          <td className="px-2 py-1.5 text-right">{b.net_weight ?? "—"}</td>
                          <td className="px-2 py-1.5 text-right">{b.gross_weight ?? "—"}</td>
                          <td className="px-2 py-1.5 text-right">{b.count ?? "—"}</td>
                          <td className="px-2 py-1.5 text-[var(--text-secondary)]">{b.lot_number || "—"}</td>
                          <td className="px-2 py-1.5 text-center">
                            {b.box_id ? (
                              <button onClick={() => handleReprintLabel(b)} disabled={printingBoxId === b.box_id} aria-label={`Reprint box ${b.box_number}`} title="Reprint QR label" className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--background)] text-[var(--text-secondary)] disabled:opacity-50">
                                {printingBoxId === b.box_id ? <IconSpinner className="h-3.5 w-3.5 animate-spin" /> : <IconPrinter className="h-3.5 w-3.5" />}
                              </button>
                            ) : (
                              <span className="text-[var(--text-muted)]">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Mobile cards */}
                <div className="sm:hidden space-y-2">
                  {pageBoxes.map((b) => (
                    <div key={`${b.article_description}#${b.box_number}`} className="p-2.5 border border-[var(--aws-border)] rounded-md bg-[var(--background)] space-y-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-[12px] font-medium text-[var(--text-primary)] truncate">{b.article_description}</p>
                          <p className="text-[11px] text-[var(--text-secondary)]">Box #{b.box_number}</p>
                        </div>
                        {b.box_id && (
                          <button onClick={() => handleReprintLabel(b)} disabled={printingBoxId === b.box_id} aria-label={`Reprint box ${b.box_number}`} title="Reprint QR label" className="h-7 w-7 inline-flex items-center justify-center rounded text-[var(--text-secondary)] disabled:opacity-50 flex-shrink-0">
                            {printingBoxId === b.box_id ? <IconSpinner className="h-3.5 w-3.5 animate-spin" /> : <IconPrinter className="h-3.5 w-3.5" />}
                          </button>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
                        {b.conversion && <div><span className="text-[var(--text-secondary)]">Conv:</span> {b.conversion}</div>}
                        <div><span className="text-[var(--text-secondary)]">Net:</span> {b.net_weight ?? "—"} kg</div>
                        <div><span className="text-[var(--text-secondary)]">Gross:</span> {b.gross_weight ?? "—"} kg</div>
                        {b.count != null && <div><span className="text-[var(--text-secondary)]">Count:</span> {b.count}</div>}
                        {b.lot_number && <div><span className="text-[var(--text-secondary)]">Lot:</span> {b.lot_number}</div>}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Box pagination */}
                {totalBoxPages > 1 && (
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-3 mt-2 border-t border-[var(--aws-border)] text-[12px]">
                    <span className="text-[var(--text-secondary)]">
                      Showing {(safeBoxPage - 1) * BOX_PAGE_SIZE + 1}–{Math.min(safeBoxPage * BOX_PAGE_SIZE, data.boxes.length)} of {data.boxes.length} boxes
                    </span>
                    <div className="flex items-center gap-1">
                      <button disabled={safeBoxPage <= 1} onClick={() => setBoxPage(safeBoxPage - 1)} aria-label="Previous page" className="h-7 w-7 inline-flex items-center justify-center rounded border border-[var(--aws-border)] bg-white disabled:opacity-40">
                        <IconChevronLeft className="h-4 w-4" />
                      </button>
                      <span className="px-1 text-[var(--text-secondary)]">Page {safeBoxPage} / {totalBoxPages}</span>
                      <button disabled={safeBoxPage >= totalBoxPages} onClick={() => setBoxPage(safeBoxPage + 1)} aria-label="Next page" className="h-7 w-7 inline-flex items-center justify-center rounded border border-[var(--aws-border)] bg-white disabled:opacity-40">
                        <IconChevronRight className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        </div>

        {/* Summary */}
        <div className="space-y-4">
          <section className="bg-white border border-[var(--aws-border)] rounded-md p-4">
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)] mb-3">Summary</h2>
            <div className="space-y-2 text-[13px]">
              <Row label="Line Items" value={data.lines.length} />
              <Row label="Boxes" value={data.boxes.length} />
              <div className="border-t border-[var(--aws-border)] my-2" />
              <Row label="Total Qty" value={parseFloat(totalQty.toFixed(3)).toLocaleString()} />
              <Row label="Total Value" value={totalValue.toLocaleString()} />
            </div>
          </section>
        </div>
      </div>

      {/* Delete confirm */}
      {showDelete && (
        <ConfirmDialog
          title="Delete CR"
          confirmLabel="Delete"
          busy={deleting}
          busyLabel="Deleting…"
          onCancel={() => setShowDelete(false)}
          onConfirm={handleDelete}
        >
          Are you sure you want to delete <span className="font-medium text-[var(--text-primary)]">{data.rtv_id}</span>? This
          will remove all lines and boxes. This action cannot be undone.
        </ConfirmDialog>
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
  // <label> WRAPS the control so the association is implicit (no htmlFor/id
  // wiring needed) — each edit input gets a real accessible name.
  return (
    <label className="space-y-1 block">
      <span className={labelCls}>{label}</span>
      {children}
    </label>
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

// Cold-warehouse bulk lot allocator (reconstruction of the legacy LotRangeDedicator):
// stamp a lot number onto this article's boxes in a [from, to] box-number range.
// Apply repeatedly for multiple ranges. Hidden until the article has boxes.
function LotAllocator({ boxCount, onApply }: { boxCount: number; onApply: (from: number, to: number, lot: string) => void }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [lot, setLot] = useState("");
  if (boxCount === 0) return null;
  const apply = () => {
    const f = parseInt(from || "1");
    const t = parseInt(to || String(boxCount));
    if (!lot.trim() || Number.isNaN(f) || Number.isNaN(t) || f > t) return;
    onApply(f, t, lot.trim());
    setLot("");
  };
  return (
    <div className="mt-2 pt-2 border-t border-[var(--aws-border)] flex flex-wrap items-end gap-2">
      <span className="text-[11px] font-medium text-[var(--text-secondary)] self-center">Bulk lot by box range:</span>
      <label className="space-y-0.5 block"><span className={labelCls}>From</span><input type="number" min="1" value={from} onChange={(e) => setFrom(e.target.value)} className={rangeInputCls} /></label>
      <label className="space-y-0.5 block"><span className={labelCls}>To</span><input type="number" min="1" value={to} onChange={(e) => setTo(e.target.value)} className={rangeInputCls} /></label>
      <label className="space-y-0.5 block"><span className={labelCls}>Lot No</span><input value={lot} onChange={(e) => setLot(e.target.value)} className="h-7 w-28 rounded border border-[var(--aws-border)] px-2 text-[12px] bg-white" /></label>
      <button type="button" onClick={apply} className="h-7 text-[12px] rounded border border-[var(--aws-border)] px-2.5 bg-white hover:border-[var(--aws-orange)]">Apply to boxes</button>
    </div>
  );
}
