"use client";

// Customer Return detail — faithful port of the legacy detail page
// (legacy-frontend/app/[company]/customer-returns/[id]/page.tsx): back arrow +
// status(icon) header, CR Information, Line Items (full field grid + per-article
// Print range), Boxes (read-only table + mobile cards + per-box Reprint + 200/page
// pagination), Summary, delete. Wired to the LIVE endpoints that mirror the legacy
// /rtv routes, keyed by rtv_id (the CR- string; the live backend has no numeric id).
//
// What can change depends on the status (editScope, ../_approvalFlow.ts — the
// server's rule): an undecided return is corrected in full on its Edit page
// ([id]/edit, the New screen's form: header, business head, lines, boxes); an
// approved one only gets boxes, in this page's inline "Edit boxes"; a rejected one
// nothing. Delete is offered only while undecided.
//
// Endpoints (live Phase 1+2):
//   GET    /{company}/{cr_id}          getCustomerReturn
//   PUT    /{company}/{cr_id}/box      upsertBox              (print one box)
//   PUT    /{company}/{cr_id}/boxes    bulkSaveBoxes          (full sync)
//   DELETE /{company}/{cr_id}          deleteCustomerReturn
//   POST   /{company}/{cr_id}/send-for-approval  sendCustomerReturnForApproval
//
// Live adaptation of the legacy split: the legacy detail page defers box-weight
// ENTRY to /approve (its box-entry screen). Here box entry lives in edit mode and is
// not gated on approval. "Send for approval" (Pending / On Hold only) sends — or
// re-sends — the approval mail + WhatsApp and shows what actually went out; the New
// screen leaves the outcome of its own send here as a one-shot notice. While it is
// undecided the page also says what the approvers were last sent: when, and whether
// the return still has those figures (its earlier links stop working once it hasn't),
// or that no request is recorded — a return a New screen saved and never sent.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useRequireAuth, useIsAdmin } from "@/lib/user";
import { sessionClear, sessionLoad } from "@/lib/session-state";
import {
  CR_READ_ONLY,
  getCustomerReturn,
  deleteCustomerReturn,
  upsertBox,
  bulkSaveBoxes,
  sendCustomerReturnForApproval,
  type CRWithDetails,
  type CRApprovalRequest,
  type CRBox,
  type CRLine,
} from "@/lib/customer-returns";
import { CustomerReturnsChrome } from "../_chrome";
import { ErrorBanner, SuccessBanner, InfoBanner, ConfirmDialog, StatusBadge, CompanyChip, CrHeaderGrid, useCompanyParam, cx, fmtDateTime, num } from "../_shared";
import { printCrLabels } from "../_labelPrint";
import { crBoxToForm, isCommitted, type CRBoxForm } from "../_boxEngine";
import { editScope, isUndecided, sendErrorNotice, sendNoticeKey, sendOutcomeNotice, type SendNotice } from "../_approvalFlow";

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
  const company = useCompanyParam();

  const [data, setData] = useState<CRWithDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lineForms, setLineForms] = useState<LineForm[]>([]);
  const [boxForms, setBoxForms] = useState<CRBoxForm[]>([]);
  // Printed boxes whose label shows a value the last save changed (box_service records
  // the change itself, and lists them): offered for reprint until printed.
  const [reprintIds, setReprintIds] = useState<string[]>([]);
  const [reprinting, setReprinting] = useState(false);
  // Per-article highest box_number ever used this edit session (incl. removed) —
  // so a re-add never reuses a freed number and silently merges into a live row.
  const boxHighWater = useRef<Record<string, number>>({});
  // The box-set fingerprint this edit started from; sent with each print and save, and
  // moved on by each successful one (box_service: a write from an out-of-date page is refused).
  const boxVersion = useRef<string | null>(null);

  const [deleting, setDeleting] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [printingAll, setPrintingAll] = useState(false);
  const [printingBoxKey, setPrintingBoxKey] = useState<string | null>(null); // edit-mode per-box print
  const [printingBoxId, setPrintingBoxId] = useState<string | null>(null); // read-mode reprint
  const [printingRange, setPrintingRange] = useState<string | null>(null);
  const [printRange, setPrintRange] = useState<Record<string, { from: string; to: string }>>({});
  const [boxPage, setBoxPage] = useState(1);
  // Send for approval: the confirm dialog, the request, and what it achieved.
  const [showSend, setShowSend] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendNotice, setSendNotice] = useState<SendNotice | null>(null);

  // One-shot: the New screen leaves the outcome of its send for this page to show
  // (tab-scoped sessionStorage). It is read on mount and shown in every view, the
  // load-error view too; the stored copy is dropped only once the return has loaded,
  // so a failed load — then a reload — still shows a send that did not go out.
  useEffect(() => {
    queueMicrotask(() => {
      const left = sessionLoad<SendNotice>(sendNoticeKey(company, crId));
      if (left && typeof left.text === "string" && left.tone in SEND_NOTICE_STYLE) setSendNotice(left);
    });
  }, [company, crId]);
  useEffect(() => {
    if (data) sessionClear(sendNoticeKey(company, crId));
  }, [data, company, crId]);
  // Dismissing drops the stored copy too (it is still there after a failed load).
  const dismissSendNotice = () => {
    setSendNotice(null);
    sessionClear(sendNoticeKey(company, crId));
  };

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

  // Re-read the return without the loading skeleton. An edit starts from the return
  // as it is now, not as this page loaded it: a box printed since (in an edit that was
  // then cancelled, or on another page) must be in the list, or the edit would re-use
  // its number. Cancel re-reads too, so the page shows such a box.
  async function reload(): Promise<CRWithDetails | null> {
    try {
      const fresh = await getCustomerReturn(company, crId);
      setData(fresh);
      return fresh;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load customer return");
      return null;
    }
  }

  async function enterEdit() {
    if (!data) return;
    setError(null);
    const fresh = await reload();
    if (!fresh) return;
    setLineForms(fresh.lines.map(toLineForm));
    const bf = fresh.boxes.map(crBoxToForm);
    boxVersion.current = fresh.box_version ?? null;
    setBoxForms(bf);
    // Seed box-number high-water from the loaded boxes.
    const hw: Record<string, number> = {};
    bf.forEach((b) => { hw[b.article_description] = Math.max(hw[b.article_description] ?? 0, b.box_number); });
    boxHighWater.current = hw;
    setEditing(true);
    setNotice(null);
  }

  function clearEdit() {
    setEditing(false);
    setLineForms([]);
    setBoxForms([]);
    boxHighWater.current = {};
    boxVersion.current = null;
  }

  function cancelEdit() {
    clearEdit();
    void reload();
  }

  function updateBox(article: string, boxNumber: number, field: keyof CRBoxForm, value: string) {
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
    // A printed / in-flight box is committed in the DB with a physical label — never
    // remove it (Save's allow_clear would delete the row and orphan the label).
    const target = boxForms.find((b) => b.article_description === article && b.box_number === boxNumber);
    if (target && isCommitted(target)) return;
    // Do NOT renumber the survivors. box_number is the server's identity key
    // (bulk_save_boxes matches rows by (article_description, box_number) and never
    // receives box_id), so renumbering would slide each saved box's box_id onto a
    // different box's data and delete a real box_id — desyncing printed QR labels.
    // Dropping just this box makes the server delete exactly the removed
    // (article, box_number) row and keep every other box_id intact.
    setBoxForms((prev) => prev.filter((b) => !(b.article_description === article && b.box_number === boxNumber)));
  }

  const boxToBulk = (b: CRBoxForm) => ({
    article_description: b.article_description,
    box_number: b.box_number,
    box_id: b.box_id || undefined, // the label this page knows it has (server checks it)
    uom: lineForms.find((l) => l.item_description === b.article_description)?.uom || undefined,
    conversion: b.conversion ?? undefined,
    lot_number: b.lot_number ?? undefined,
    item_mark: b.item_mark ?? undefined,
    spl_remarks: b.spl_remarks ?? undefined,
    vakkal: b.vakkal ?? undefined,
    net_weight: b.net_weight || "0", // blank = explicit clear → 0 (not "keep stale")
    gross_weight: b.gross_weight || "0",
    count: b.count ? parseInt(b.count) : undefined,
  });

  async function handleSave() {
    if (!data) return;
    setSaving(true);
    setError(null);
    try {
      // Inline editing is boxes only: an undecided return's header and lines are
      // corrected on its Edit page, and a decided one's are locked (409 already_decided).
      // The server records what changed on each printed box, and lists the ones whose
      // label now shows old values.
      const res = await bulkSaveBoxes(company, crId, boxForms.map(boxToBulk), { allowClear: true, baseVersion: boxVersion.current });
      const stale = (res.reprint ?? []).map((b) => b.box_id);

      await refresh();
      clearEdit();
      setReprintIds(stale);
      setNotice(stale.length
        ? `Saved. ${stale.length} printed label${stale.length === 1 ? " shows" : "s show"} old values (${stale.join(", ")}): reprint ${stale.length === 1 ? "it" : "them"} and put the new label on the carton.`
        : "Saved.");
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
    const setPrinting = (v: boolean) =>
      setBoxForms((prev) => prev.map((b) => (b.article_description === article && b.box_number === boxNumber ? { ...b, printing: v } : b)));
    setPrintingBoxKey(key);
    setError(null);
    // Freeze the box (isCommitted) for the round-trip so a concurrent Remove can't drop
    // it before the box_id stamp lands.
    setPrinting(true);
    try {
      const res = await upsertBox(company, crId, {
        article_description: box.article_description,
        box_number: box.box_number,
        box_id: box.box_id || undefined,
        base_version: boxVersion.current ?? undefined,
        uom: lineForms.find((l) => l.item_description === article)?.uom || undefined,
        conversion: box.conversion || undefined,
        net_weight: box.net_weight || "0",
        gross_weight: box.gross_weight || "0",
        lot_number: box.lot_number || undefined,
        item_mark: box.item_mark || undefined,
        spl_remarks: box.spl_remarks || undefined,
        vakkal: box.vakkal || undefined,
        count: box.count ? parseInt(box.count) : undefined,
      });
      setBoxForms((prev) =>
        prev.map((b) =>
          b.article_description === article && b.box_number === boxNumber ? { ...b, box_id: res.box_id, is_printed: true, printing: false } : b,
        ),
      );
      boxVersion.current = res.box_version ?? boxVersion.current;
      await printCrLabels({ company, crId, customer: data?.customer, rtvDate: data?.rtv_date, boxes: [{ ...box, box_id: res.box_id }] });
    } catch (e) {
      setPrinting(false); // failed print → box unfrozen again
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

  // Reprint the labels the last save made out of date, with the values now saved.
  async function handleReprintChanged() {
    if (!data || reprintIds.length === 0) return;
    const boxes = data.boxes.filter((b) => b.box_id && reprintIds.includes(b.box_id));
    setReprinting(true);
    setError(null);
    try {
      await printCrLabels({ company, crId, customer: data.customer, rtvDate: data.rtv_date, boxes: boxes.map(toLabelBox) });
      setReprintIds([]);
      setNotice(`Sent ${boxes.length} label${boxes.length === 1 ? "" : "s"} to print.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Print failed");
    } finally {
      setReprinting(false);
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

  // (Re-)send the approval mail + WhatsApp and show what actually went out.
  async function handleSendForApproval() {
    setSending(true);
    setSendNotice(null);
    try {
      setSendNotice(sendOutcomeNotice(await sendCustomerReturnForApproval(company, crId)));
      // The request it now records (when, by whom), for the note under the notice.
      getCustomerReturn(company, crId).then(setData, () => {});
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to send for approval";
      // A refusal (e.g. decided meanwhile) can't be retried: re-read the status so the
      // button — and the retry hint — stay only while a retry can work.
      let retry = true;
      try {
        const fresh = await getCustomerReturn(company, crId);
        setData(fresh);
        retry = isUndecided(fresh.status);
      } catch { /* keep the hint — the CR could not be re-read */ }
      setSendNotice(sendErrorNotice(message, retry));
    } finally {
      setSending(false);
      setShowSend(false);
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
        {sendNotice && <div className="mb-3"><SendNoticeBanner notice={sendNotice} onDismiss={dismissSendNotice} /></div>}
        <div className="mb-3"><ErrorBanner message={error} /></div>
        <Link href={`/modules/customer-returns?company=${company}`} className="inline-block text-[13px] rounded-md border border-[var(--aws-border)] px-3 py-1.5 bg-white">
          ← Back to list
        </Link>
      </CustomerReturnsChrome>
    );
  }
  if (!data) return null;

  // Undecided: header, lines and boxes; approved: boxes only; rejected: nothing.
  const scope = editScope(data.status);
  const editLabel = scope === "all" ? "Edit" : "Edit boxes";
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
        {!editing && scope === "all" && (
          <Link
            href={`/modules/customer-returns/${encodeURIComponent(data.rtv_id)}/edit?company=${company}`}
            title="Correct the details, business head, lines and boxes"
            className="h-8 inline-flex items-center text-[13px] rounded-md border border-[var(--aws-border)] px-3 bg-white hover:border-[var(--aws-orange)]"
          >
            Edit
          </Link>
        )}
        {!editing && scope === "boxes" && (
          <button
            onClick={enterEdit}
            title="Decided: its articles, quantities and rates are locked; boxes can still be entered."
            className="h-8 text-[13px] rounded-md border border-[var(--aws-border)] px-3 bg-white hover:border-[var(--aws-orange)]"
          >
            Edit boxes
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
        {!editing && !CR_READ_ONLY && isUndecided(data.status) && (
          <button
            onClick={() => setShowSend(true)}
            disabled={sending}
            title="Send the Approve / Reject / Hold request to the Business Head and the deputy approvers (mail + WhatsApp)"
            className="h-8 inline-flex items-center gap-1.5 text-[13px] rounded-md border border-[var(--aws-border)] px-3 bg-white hover:border-[var(--aws-orange)] disabled:opacity-50"
          >
            {sending && <IconSpinner className="h-3.5 w-3.5 animate-spin" />}
            Send for approval
          </button>
        )}
        {!editing && isUndecided(data.status) && (
          <button onClick={() => setShowDelete(true)} className="h-8 inline-flex items-center gap-1.5 text-[13px] rounded-md border border-[var(--aws-border)] px-3 bg-white text-[var(--aws-error)]">
            <IconTrash className="h-3.5 w-3.5" /> Delete
          </button>
        )}
      </div>

      {!sendNotice && isUndecided(data.status) && <ApprovalRequestNote request={data.approval_request ?? null} />}
      {sendNotice && <div className="mb-3"><SendNoticeBanner notice={sendNotice} onDismiss={dismissSendNotice} /></div>}
      {error && <div className="mb-3"><ErrorBanner message={error} /></div>}
      {notice && <div className="mb-3"><SuccessBanner message={notice} /></div>}
      {reprintIds.length > 0 && (
        <div className="mb-3">
          <button
            type="button"
            onClick={handleReprintChanged}
            disabled={reprinting}
            className="h-8 inline-flex items-center gap-1.5 text-[13px] rounded-md border border-[var(--aws-orange)] px-3 bg-white font-medium disabled:opacity-50"
          >
            {reprinting ? <IconSpinner className="h-3.5 w-3.5 animate-spin" /> : <IconPrinter className="h-3.5 w-3.5" />}
            {reprinting ? "Printing…" : `Reprint ${reprintIds.length} label${reprintIds.length === 1 ? "" : "s"}`}
          </button>
        </div>
      )}

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
          </section>

          {/* Boxes */}
          <section className="bg-white border border-[var(--aws-border)] rounded-md p-4">
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-1.5">
              <IconArchive className="h-4 w-4 text-[var(--text-secondary)]" /> Boxes ({editing ? boxForms.length : data.boxes.length})
            </h2>

            {!editing && (
              <div className="mb-3">
                <InfoBanner>
                  {scope === "none" ? (
                    <>This return was rejected, so its boxes can&rsquo;t be changed.</>
                  ) : (
                    <>
                      Box weights &amp; QR labels are entered in <strong>{editLabel}</strong>. Box entry doesn&rsquo;t
                      wait for the approval.
                    </>
                  )}
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
              <p className="text-[12px] text-[var(--text-secondary)]">
                {scope === "none" ? "No boxes were entered." : `No boxes entered yet. Click “${editLabel}”.`}
              </p>
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
          Delete <span className="font-medium text-[var(--text-primary)]">{data.rtv_id}</span> with all its lines and boxes?
          {hasPrinted && (
            <> Its {data.boxes.filter((b) => b.box_id).length} printed box label(s) will no longer be valid and must be thrown away.</>
          )}{" "}
          The approvers are told it was deleted, and a copy is kept in the deletion record. This can&rsquo;t be undone here.
        </ConfirmDialog>
      )}

      {/* Send-for-approval confirm */}
      {showSend && (
        <ConfirmDialog
          title="Send for approval?"
          confirmLabel="Send"
          danger={false}
          busy={sending}
          busyLabel="Sending…"
          onCancel={() => setShowSend(false)}
          onConfirm={handleSendForApproval}
        >
          The Business Head and the deputy approvers get the Approve / Reject / Hold request for{" "}
          <span className="font-medium text-[var(--text-primary)]">{data.rtv_id}</span> by mail and WhatsApp — all but
          whoever raised it, who gets a copy instead. Anyone who already has it gets it again; the first decision taken
          stands.
        </ConfirmDialog>
      )}
    </CustomerReturnsChrome>
  );
}

// What the approvers were last sent, on an undecided return (the server's latest
// recorded request): amber when the return no longer has those figures, or when no
// request is recorded at all.
function ApprovalRequestNote({ request }: { request: CRApprovalRequest | null }) {
  if (request && request.figures_current) {
    return (
      <p className="mb-3 text-[12px] text-[var(--text-secondary)]">
        Sent for approval {fmtDateTime(request.sent_at)}{request.sent_by ? ` by ${request.sent_by}` : ""}.
      </p>
    );
  }
  return (
    <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
      {request
        ? `Its figures changed after it was last sent for approval (${fmtDateTime(request.sent_at)}), so the links ` +
          "the approvers have no longer work. Send it for approval again."
        : "No approval request is recorded for it, so it may never have been sent for approval. Send it when it's ready."}
    </div>
  );
}

// What Send for approval achieved: green (everything went out), amber (only part of
// it), red (no approver was reached — retry with Send for approval).
const SEND_NOTICE_STYLE: Record<SendNotice["tone"], string> = {
  success: "border-[#b6dbb1] bg-[#eaf6ed] text-[var(--text-success)]",
  warning: "border-[#ecd9a3] bg-[#fdf6e3] text-[#8a6d1a]",
  error: "border-[#f0c7be] bg-[#fdf3f1] text-[#b1361e]",
};

function SendNoticeBanner({ notice, onDismiss }: { notice: SendNotice; onDismiss: () => void }) {
  return (
    <div
      role={notice.tone === "success" ? "status" : "alert"}
      className={cx("flex items-start gap-2 rounded-md border px-3 py-2 text-[13px]", SEND_NOTICE_STYLE[notice.tone])}
    >
      <span className="flex-1 break-words">{notice.text}</span>
      <button onClick={onDismiss} aria-label="Dismiss" className="flex-shrink-0 px-1 leading-none opacity-70 hover:opacity-100">
        ✕
      </button>
    </div>
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
