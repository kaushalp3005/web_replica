"use client";

// Transfer OUT — Accept Request (doc 07). Pre-fills header + first line from an
// interunit request (?requestId=), lets the operator add articles and ingest the
// physical boxes (manual entry + camera/QR: BE-/TR- formats), capture transport,
// then POSTs to /api/v1/transfer/transfers. Created as Dispatch (or Partial when
// boxes < ordered qty); source stock is parked In-Transit and the request flips to
// Transferred. Feedback via inline banner (no toast lib in web_replica).
//
// Scope notes vs the reference 3053-line page:
//  • line-level lot IS sent (the reference dropped it — gotcha #4); our backend
//    park_lines uses it, so keeping it is strictly more correct.
//  • the legacy TX/CONS inward QR format is unsupported (no inward module here).

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { TransferChrome } from "../_chrome";
import { QrScanBox } from "@/components/QrScanBox";
import {
  Card, Field, SearchableSelect, QuickSearch, ScanAddResult,
  EMPTY_ARTICLE, patchArticle, todayDMY, genTransferNo,
  UOM_OPTIONS, FROM_WAREHOUSES, TO_WAREHOUSES, REASONS, VEHICLES, DRIVERS, COLD_STORAGE_WAREHOUSES,
  type Article, type ScannedBox, type OutScan,
} from "../_formParts";
import {
  TransferApi,
  type CategorialSearchItem,
  type TransferBoxCreateInput,
  type TransferLineCreateInput,
  type LookupBox,
} from "@/lib/transfer";
import { friendlyApiError } from "@/lib/apiErrors";

// Company is only a hint — the lookup endpoints search both cfpl + cdpl.
const COMPANY = "cfpl";

interface LoadedItem { itemDescription: string; quantity: number }

export default function Page() {
  return (
    <Suspense fallback={<TransferChrome title="Transfer OUT"><div className="py-16 text-center text-[13px] text-[var(--text-secondary)]">Loading…</div></TransferChrome>}>
      <TransferOutForm />
    </Suspense>
  );
}

function TransferOutForm() {
  const router = useRouter();
  const allowed = useRequireAuth(router.replace);
  const searchParams = useSearchParams();
  const requestId = searchParams.get("requestId");

  // Seeded empty so the initial render is deterministic: genTransferNo()/todayDMY() read
  // the wall clock and would mismatch between the SSR render and client hydration
  // (timezone / minute drift). Filled on mount below.
  const [transferNo, setTransferNo] = useState("");
  const [form, setForm] = useState({
    requestNo: "", requestDate: "", fromWarehouse: "", toWarehouse: "",
    reason: "", reasonDescription: "",
  });
  const [transport, setTransport] = useState({
    vehicle: "", vehicleOther: "", driver: "", driverOther: "", approval: "",
  });
  const [articles, setArticles] = useState<Article[]>([{ uid: 0, ...EMPTY_ARTICLE }]);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set([0]));
  const nextUid = useRef(1);
  const boxCounter = useRef(1);
  // Synchronous dedup of real (non-DIRECT) boxes by `${boxId}|${tno}` — a flag set
  // inside a setState updater can't be read reliably, so we track keys in a ref.
  const scannedKeysRef = useRef<Set<string>>(new Set());

  const [scannedBoxes, setScannedBoxes] = useState<ScannedBox[]>([]);
  const [loadedItems, setLoadedItems] = useState<LoadedItem[]>([]);
  const [materialTypes, setMaterialTypes] = useState<string[]>([]);

  const [manualBox, setManualBox] = useState({ boxNumber: "", transactionNo: "" });
  const [scanInfo, setScanInfo] = useState<OutScan | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [banner, setBanner] = useState<{ type: "error" | "success"; text: string } | null>(null);
  const [coldPopup, setColdPopup] = useState<string | null>(null);

  // ── Material types on mount ──
  useEffect(() => {
    if (!allowed) return;
    let off = false;
    TransferApi.categorialDropdown({}).then((d) => { if (!off) setMaterialTypes(d.options.material_types); }).catch(() => {});
    return () => { off = true; };
  }, [allowed]);

  // ── Seed clock-derived defaults on the client (avoids the SSR hydration mismatch). ──
  // Deferred via setTimeout so the setState isn't synchronous in the effect body
  // (react-hooks/set-state-in-effect). requestDate is seeded only when there's no
  // requestId — the request prefill effect sets it from the loaded request otherwise.
  useEffect(() => {
    const id = setTimeout(() => {
      setTransferNo(genTransferNo());
      if (!requestId) setForm((f) => ({ ...f, requestDate: todayDMY() }));
    }, 0);
    return () => clearTimeout(id);
  }, [requestId]);

  // ── Prefill from request ──
  useEffect(() => {
    if (!allowed || !requestId) return;
    let off = false;
    (async () => {
      try {
        const req = await TransferApi.getRequest(Number(requestId));
        if (off) return;
        const norm = (v?: string | null) => (!v || v === "N/A" ? "" : v);
        setForm((f) => ({
          ...f,
          requestNo: req.request_no || "",
          requestDate: req.request_date || f.requestDate,
          fromWarehouse: norm(req.from_warehouse),
          toWarehouse: norm(req.to_warehouse),
          reason: "",  // operator must re-pick
          reasonDescription: req.reason_description || "",
        }));
        // EVERY request line becomes an editable article. Loading only lines[0] meant the
        // submit payload — which is built from this array — carried one line, so accepting
        // a 5-line request dispatched one item and silently dropped four. The read-only
        // "Items from Request" panel below still lists them all, which is exactly what made
        // the loss invisible: the screen showed five, the payload had one.
        if (req.lines.length) {
          nextUid.current = req.lines.length;
          setArticles(req.lines.map((l, i) => ({
            uid: i,
            materialType: norm(l.material_type), itemCategory: norm(l.item_category),
            subCategory: norm(l.sub_category), itemDescription: norm(l.item_description),
            unitPackSize: l.unit_pack_size || "", uom: norm(l.uom),
            packSize: l.pack_size || "1", quantity: l.quantity || "1",
            netWeight: l.net_weight || "0", lotNumber: l.lot_number || "",
            vakkal: "", batchNumber: "",
          })));
          // Only the first stays open; the rest collapse so a long request is still workable.
          setExpanded(new Set([0]));
        }
        setLoadedItems(req.lines.map((l) => ({
          itemDescription: l.item_description, quantity: parseFloat(l.quantity) || 0,
        })));
        setBanner({
          type: "success",
          text: `Request ${req.request_no} loaded — ${req.lines.length} item(s) auto-filled.`,
        });
      } catch (e) {
        if (!off) setBanner({ type: "error", text: e instanceof Error ? e.message : "Failed to load request." });
      }
    })();
    return () => { off = true; };
  }, [allowed, requestId]);

  // ── Article ops ──
  const patchArt = useCallback((uid: number, patch: Partial<Article>) =>
    setArticles((as) => as.map((a) => (a.uid === uid ? patchArticle(a, patch) : a))), []);
  const addArticle = () => {
    const uid = nextUid.current++;
    setArticles((as) => [...as, { uid, ...EMPTY_ARTICLE }]);
    setExpanded((s) => new Set(s).add(uid));
  };
  const removeArticle = (uid: number) =>
    setArticles((as) => (as.length > 1 ? as.filter((a) => a.uid !== uid) : as));
  const toggle = (uid: number) => setExpanded((s) => { const n = new Set(s); if (n.has(uid)) n.delete(uid); else n.add(uid); return n; });

  // ── Box ingestion ──
  const appendBox = useCallback((b: LookupBox, fallbackTno: string) => {
    const boxId = (b.box_id || "").trim();
    const tno = (b.transaction_no || fallbackTno || "").trim();
    const key = boxId && tno ? `${boxId}|${tno}` : "";
    if (key && scannedKeysRef.current.has(key)) {
      setBanner({ type: "error", text: `Box ${boxId} / ${tno} already scanned.` });
      setScanInfo({ status: "dup", box_id: boxId, tno });
      return;
    }
    if (key) scannedKeysRef.current.add(key);
    const article = b.item_description || b.article_description || "";
    const net = b.net_weight != null ? String(b.net_weight) : "0";
    const id = boxCounter.current++;  // computed outside the updater (StrictMode-safe)
    setScannedBoxes((boxes) => [...boxes, {
      id,
      boxNumber: typeof b.box_number === "number" ? b.box_number : id,
      boxId, transactionNo: tno, article,
      vakkal: "",   // no source box table carries a vakkal; it is keyed on the article
      lotNumber: b.lot_number || "", batchNumber: b.batch_number || "",
      netWeight: net,
      grossWeight: b.gross_weight != null ? String(b.gross_weight) : "0",
    }]);
    setBanner(null);
    setScanInfo({ status: "added", box_id: boxId, article, lot: b.lot_number || "", net, tno });
  }, []);

  const handleManualBoxFetch = async () => {
    const num = parseInt(manualBox.boxNumber, 10);
    const tno = manualBox.transactionNo.trim();
    if (!num || !tno) { setBanner({ type: "error", text: "Box number and transaction no are required." }); return; }
    if (scannedBoxes.some((x) => x.boxNumber === num && x.transactionNo === tno)) {
      setBanner({ type: "error", text: "That box is already in the list." }); return;
    }
    try {
      const res = await TransferApi.boxLookupByNumber(COMPANY, num, tno);
      appendBox(res.box, tno);
      setManualBox({ boxNumber: "", transactionNo: "" });
    } catch (e) {
      setBanner({ type: "error", text: e instanceof Error ? e.message : "Box not found." });
    }
  };

  const handleQRScan = useCallback(async (text: string): Promise<boolean> => {
    try {
      let parsed: { tx?: string; bi?: string } | null = null;
      try { parsed = JSON.parse(text); } catch { /* not JSON */ }
      if (parsed && parsed.tx && parsed.bi) {
        const tx = String(parsed.tx), bi = String(parsed.bi);
        // One call for every QR format. box-lookup-by-id already unions boxes_v2,
        // bulk_entry_boxes AND rtv_boxes and resolves on the (box_id, transaction_no)
        // pair, so BE- needed no branch of its own — bulk-entry-box-lookup is the same
        // search with the other two sources switched off. Routing on the prefix only
        // added a way for the two paths to drift.
        const res = await TransferApi.boxLookupById(COMPANY, bi, tx);
        appendBox(res.box, tx);
        return true;
      }
      { const msg = "Unrecognised QR format (expected a TR-, BE- or CR- box code).";
        setBanner({ type: "error", text: msg }); setScanInfo({ status: "err", value: text, error: msg }); }
      return false;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "QR lookup failed.";
      setBanner({ type: "error", text: msg }); setScanInfo({ status: "err", value: text, error: msg });
      return false;
    }
  }, [appendBox]);

  const addArticleToList = (a: Article) => {
    const qty = Math.max(1, Math.floor(parseFloat(a.quantity) || 0));
    if (!a.itemDescription) { setBanner({ type: "error", text: "Pick an item before adding to the list." }); return; }
    if (a.materialType.toUpperCase() === "FG" && (parseFloat(a.unitPackSize) || 0) <= 0) {
      setBanner({ type: "error", text: "FG articles need a unit pack size before adding." }); return;
    }
    const totalNet = parseFloat(a.netWeight) || 0;
    const perBox = qty ? (totalNet / qty) : totalNet;
    const add: ScannedBox[] = [];
    for (let i = 0; i < qty; i++) {
      const id = boxCounter.current++;  // ids computed outside the updater (StrictMode-safe)
      add.push({
        id, boxNumber: id, boxId: "", vakkal: "",
        transactionNo: "DIRECT", article: a.itemDescription, lotNumber: a.lotNumber,
        batchNumber: "", netWeight: perBox.toFixed(3), grossWeight: perBox.toFixed(3),
      });
    }
    setScannedBoxes((boxes) => [...boxes, ...add]);
    setBanner({ type: "success", text: `Added ${qty} ${a.itemDescription} entr${qty === 1 ? "y" : "ies"} to the list.` });
  };

  const updateScannedBox = (id: number, patch: Partial<ScannedBox>) =>
    setScannedBoxes((boxes) => boxes.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  const removeBox = (id: number) => setScannedBoxes((boxes) => {
    const b = boxes.find((x) => x.id === id);
    if (b && b.boxId && b.transactionNo) scannedKeysRef.current.delete(`${b.boxId}|${b.transactionNo}`);
    return boxes.filter((x) => x.id !== id);
  });
  const clearAllBoxes = () => { scannedKeysRef.current.clear(); setScannedBoxes([]); boxCounter.current = 1; };

  // ── Derived totals ──
  // scannedBoxes holds TWO populations: real boxes (scan/fetch) and DIRECT rows that
  // addArticleToList synthesises from an article's own typed net. Only the non-DIRECT rows
  // persist as interunit_transfer_boxes (buildPayload filters on the same predicate), so
  // anything that says "scanned" counts only those. Counting both made the card read
  // "Scanned boxes (67)" and Δ 0.000 kg in emerald — a "matches" verdict measured against the
  // very articles the DIRECT rows were derived from, with no box scanned and none sent.
  // net/gross stay over every listed row: they total the rows the table actually prints.
  const totals = useMemo(() => {
    const net = scannedBoxes.reduce((s, b) => s + (parseFloat(b.netWeight) || 0), 0);
    const gross = scannedBoxes.reduce((s, b) => s + (parseFloat(b.grossWeight) || 0), 0);
    const scanned = scannedBoxes.filter((b) => b.transactionNo !== "DIRECT");
    const scannedNet = scanned.reduce((s, b) => s + (parseFloat(b.netWeight) || 0), 0);
    return { net, gross, scannedNet, scannedCount: scanned.length, manualCount: scannedBoxes.length - scanned.length };
  }, [scannedBoxes]);
  // Per-item counts are DERIVED from the list, never accumulated alongside it: the old
  // increment-only counter was never decremented by removeBox and was left untouched by
  // clearAllBoxes, so Pending read as satisfied (emerald) while the removed boxes were still
  // outstanding — and it contradicted the Partial status the backend computes from the
  // payload the form actually sends.
  const scannedByItem = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of scannedBoxes) {
      const k = b.article.trim().toUpperCase();
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  }, [scannedBoxes]);
  const requestedNet = useMemo(
    () => articles.reduce((s, a) => s + (parseFloat(a.netWeight) || 0), 0), [articles]);

  const resolvedVehicle = transport.vehicle === "Other" ? transport.vehicleOther.trim() : transport.vehicle;
  const resolvedDriver = transport.driver === "Other" ? transport.driverOther.trim() : transport.driver;
  const isColdInvolved = COLD_STORAGE_WAREHOUSES.has(form.fromWarehouse) || COLD_STORAGE_WAREHOUSES.has(form.toWarehouse);

  // ── Validation ──
  const validate = (): string[] => {
    const e: string[] = [];
    if (!form.fromWarehouse) e.push("From warehouse is required");
    if (!form.toWarehouse) e.push("To warehouse is required");
    if (form.fromWarehouse && form.toWarehouse && form.fromWarehouse === form.toWarehouse) e.push("From and To warehouse must differ");
    if (!form.reason) e.push("Reason is required");
    if (!form.reasonDescription.trim()) e.push("Reason description is required");
    if (!resolvedVehicle) e.push("Vehicle number is required");
    if (!resolvedDriver) e.push("Driver name is required");
    if (!transport.approval.trim()) e.push("Approval authority is required");
    articles.forEach((a, i) => {
      const n = i + 1;
      if (!a.materialType) e.push(`Article ${n}: material type required`);
      if (!a.itemCategory) e.push(`Article ${n}: category required`);
      if (!a.subCategory) e.push(`Article ${n}: sub category required`);
      if (!a.itemDescription) e.push(`Article ${n}: item description required`);
      // A blank quantity used to skip this check entirely, and the two sides then disagreed:
      // calcNetWeight read it as 0 and displayed Net Weight 0.000, while buildPayload read it
      // as 1 — the backend then recomputed net from pack_size × 1 and stored a weight the form
      // never showed. It is a required physical count (park_lines parks one row per unit).
      const q = parseFloat(a.quantity);
      if (!Number.isInteger(q) || q < 1) e.push(`Article ${n}: quantity must be a whole number ≥ 1`);
      // Legacy made the vakkal mark mandatory whenever cold storage is on either leg —
      // it is what the receiving unit matches physical cartons against.
      if (isColdInvolved && !a.vakkal.trim()) e.push(`Article ${n}: vakkal is required for cold transfers`);
    });
    return e;
  };

  const buildPayload = () => {
    // Gross per article, summed over the boxes that will actually persist (same non-DIRECT
    // predicate as `boxes` below — a DIRECT row carries the article's own net copied into
    // grossWeight, so counting it would report net as gross all over again). A description
    // shared by two articles is left out: a box cannot be attributed to one of them, and
    // splitting it would put the same physical gross on both lines.
    const ambiguous = new Set<string>();
    const seenDesc = new Set<string>();
    for (const a of articles) {
      const k = a.itemDescription.trim().toUpperCase();
      if (seenDesc.has(k)) ambiguous.add(k); else seenDesc.add(k);
    }
    const grossByArticle = new Map<string, number>();
    for (const b of scannedBoxes) {
      if (b.transactionNo === "DIRECT") continue;
      const k = b.article.trim().toUpperCase();
      grossByArticle.set(k, (grossByArticle.get(k) || 0) + (parseFloat(b.grossWeight) || 0));
    }
    const lines: TransferLineCreateInput[] = articles.map((a) => {
      const net = parseFloat(a.netWeight) || 0;
      const key = a.itemDescription.trim().toUpperCase();
      // total_weight is unambiguously the GROSS everywhere it is read back (the dashboard's
      // gross KPI, transferBuildSummary, transferIn's per-box gross, park_lines' per-unit
      // gross). It was sent as a copy of net_weight, so every dispatch this form created
      // recorded zero tare. Use the scanned boxes' gross instead, falling back to net when the
      // line ships with no scanned box or only part of it was scanned — gross is never
      // below net, and net is the honest floor when no gross was captured.
      const gross = ambiguous.has(key) ? 0 : (grossByArticle.get(key) || 0);
      return {
        material_type: a.materialType, item_category: a.itemCategory, sub_category: a.subCategory,
        item_description: a.itemDescription,
        // qty is a box/bag count — send a positive integer string (backend does int(qty));
        // validate() has already rejected a blank or fractional quantity.
        quantity: String(Math.max(1, Math.floor(parseFloat(a.quantity) || 1))), uom: a.uom || "",
        pack_size: a.packSize || "0", unit_pack_size: a.unitPackSize || null,
        net_weight: a.netWeight || "0", total_weight: (gross > net ? gross : net).toFixed(3),
        batch_number: a.batchNumber || null, lot_number: a.lotNumber || null, vakkal: a.vakkal || null,
      };
    });
    // DIRECT (manually-keyed) entries have no physical box_id — they ship as lines only,
    // never as interunit_transfer_boxes rows (the backend parks their stock via park_lines).
    // Persisting them as boxes surfaced empty box_ids as "N/A" in the view. (Legacy parity.)
    const boxes: TransferBoxCreateInput[] = scannedBoxes.filter((b) => b.transactionNo !== "DIRECT").map((b) => ({
      box_number: b.boxNumber, box_id: b.boxId || null, article: b.article,
      lot_number: b.lotNumber || null, batch_number: b.batchNumber || null,
      transaction_no: b.transactionNo || null,
      net_weight: (parseFloat(b.netWeight) || 0).toFixed(3),
      gross_weight: (parseFloat(b.grossWeight) || 0).toFixed(3),
    }));
    return {
      header: {
        challan_no: transferNo, stock_trf_date: form.requestDate,
        from_warehouse: form.fromWarehouse, to_warehouse: form.toWarehouse,
        vehicle_no: resolvedVehicle, driver_name: resolvedDriver || null,
        approved_by: transport.approval.trim() || null,
        remark: form.reasonDescription || form.reason, reason_code: form.reason,
      },
      lines, boxes: boxes.length ? boxes : undefined,
      request_id: requestId ? Number(requestId) : null,
    };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBanner(null);
    const errs = validate();
    if (errs.length) {
      setBanner({ type: "error", text: errs.join(" · ") });
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
      return;
    }
    setSubmitting(true);
    try {
      const res = await TransferApi.createTransfer(buildPayload());
      if (isColdInvolved) {
        const lines = (scannedBoxes.length ? scannedBoxes.map((b) => `${b.article} — lot ${b.lotNumber || "—"}`)
          : articles.map((a) => `${a.itemDescription} × ${a.quantity}`));
        setColdPopup([
          `Transfer ${res.challan_no} (${res.status})`,
          `From ${form.fromWarehouse} → ${form.toWarehouse}`,
          `Vehicle ${resolvedVehicle}`,
          "", ...lines,
        ].join("\n"));
      } else {
        setBanner({ type: "success", text: `Transfer ${res.challan_no} created (${res.status}).` });
        setTimeout(() => router.push("/modules/transfer"), 1200);
      }
      // Deliberately leave submitting=true on success: the page navigates away (or the
      // cold popup takes over), so the Submit button stays disabled and a second click
      // can't POST the same challan_no twice. (The backend now rejects a repeat with a
      // 409 rather than a unique-violation 500, but the disabled button is still the
      // first line of defence.)
    } catch (err) {
      // friendlyApiError, not err.message — see directtransferform.
      setBanner({ type: "error", text: friendlyApiError(err) });
      setSubmitting(false);
    }
  };

  // No `if (!allowed) return null` gate: useRequireAuth returns true on the server but
  // false on the client's first render, so gating the render on it causes a hydration
  // mismatch. Effects are gated on `allowed`; the hook redirects unauthenticated users.

  return (
    <TransferChrome title="Transfer OUT">
      <button onClick={() => router.push("/modules/transfer")}
        className="text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] mb-3">← Transfer</button>

      <div className="flex flex-wrap items-end justify-between gap-2 mb-4">
        <h1 className="text-[20px] font-semibold text-[var(--text-primary)]">Transfer OUT</h1>
        <span className="text-[12px] text-[var(--text-secondary)]">Transfer No <span className="font-mono text-[var(--text-primary)]">{transferNo}</span></span>
      </div>

      {banner && (
        <div className={`mb-4 rounded-md p-3 text-[13px] border ${banner.type === "error" ? "bg-rose-50 border-rose-200 text-rose-700" : "bg-emerald-50 border-emerald-200 text-emerald-700"}`}>
          {banner.text}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4 max-w-4xl">
        {/* Request / header card */}
        <Card title="Request details">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Request No"><input value={form.requestNo} readOnly placeholder="(direct transfer)"
              className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-[var(--background)] font-mono" /></Field>
            <Field label="Request Date" required><input value={form.requestDate} onChange={(e) => setForm({ ...form, requestDate: e.target.value })}
              placeholder="DD-MM-YYYY" className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" /></Field>
            <Field label="From (Requesting)" required>
              <select value={form.fromWarehouse} onChange={(e) => setForm({ ...form, fromWarehouse: e.target.value })}
                className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-white">
                <option value="">Select…</option>{FROM_WAREHOUSES.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </Field>
            <Field label="To (Supplying)" required>
              <select value={form.toWarehouse} onChange={(e) => setForm({ ...form, toWarehouse: e.target.value })}
                className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-white">
                <option value="">Select…</option>{TO_WAREHOUSES.filter((w) => w !== form.fromWarehouse).map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </Field>
            <Field label="Reason" required>
              <select value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}
                className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-white">
                <option value="">Select…</option>{REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </Field>
            <div />
            <div className="sm:col-span-2">
              <Field label="Reason Description" required>
                <textarea value={form.reasonDescription} onChange={(e) => setForm({ ...form, reasonDescription: e.target.value })}
                  rows={2} className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md resize-y" />
              </Field>
            </div>
          </div>
        </Card>

        {/* Box ingestion */}
        <Card title="Scan / add boxes">
          <div className="space-y-3">
            {/* Inline always-on scanner — same card as the job-card RM tab. */}
            <QrScanBox title="Scan box QR"
              idleHint="Start the camera and centre a box QR to add it to the dispatch."
              onResult={(v) => { void handleQRScan(v); }} />
            {scanInfo && <ScanAddResult scan={scanInfo} onDismiss={() => setScanInfo(null)} />}
            <div className="flex flex-wrap items-end gap-3">
              <span className="text-[12px] text-[var(--text-secondary)]">or enter manually:</span>
              <div className="flex items-end gap-2">
                <Field label="Box Number"><input value={manualBox.boxNumber} type="number" onWheel={(e) => e.currentTarget.blur()}
                  onChange={(e) => setManualBox({ ...manualBox, boxNumber: e.target.value })}
                  className="w-28 px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" /></Field>
                <Field label="Transaction No"><input value={manualBox.transactionNo}
                  onChange={(e) => setManualBox({ ...manualBox, transactionNo: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleManualBoxFetch(); } }}
                  className="w-44 px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" /></Field>
                <button type="button" onClick={handleManualBoxFetch}
                  className="px-3 py-1.5 text-[13px] rounded-md bg-[var(--aws-navy)] text-white hover:opacity-90">Fetch Box</button>
              </div>
            </div>
          </div>
        </Card>

        {/* Transport */}
        <Card title="Transfer information">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Vehicle Number" required>
              <select value={transport.vehicle} onChange={(e) => setTransport({ ...transport, vehicle: e.target.value })}
                className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-white">
                <option value="">Select…</option>{VEHICLES.map((v) => <option key={v} value={v}>{v}</option>)}<option value="Other">Other</option>
              </select>
              {transport.vehicle === "Other" && <input value={transport.vehicleOther} onChange={(e) => setTransport({ ...transport, vehicleOther: e.target.value })}
                placeholder="Enter vehicle no" className="mt-1.5 w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" />}
            </Field>
            <Field label="Driver Name" required>
              <select value={transport.driver} onChange={(e) => setTransport({ ...transport, driver: e.target.value })}
                className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-white">
                <option value="">Select…</option>{DRIVERS.map((d) => <option key={d} value={d}>{d}</option>)}<option value="Other">Other</option>
              </select>
              {transport.driver === "Other" && <input value={transport.driverOther} onChange={(e) => setTransport({ ...transport, driverOther: e.target.value })}
                placeholder="Enter driver name" className="mt-1.5 w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" />}
            </Field>
            <Field label="Approval Authority" required>
              <input value={transport.approval} onChange={(e) => setTransport({ ...transport, approval: e.target.value })}
                className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" />
            </Field>
          </div>
        </Card>

        {/* Articles */}
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">Articles ({articles.length})</h2>
          <button type="button" onClick={addArticle}
            className="px-2.5 py-1 text-[12px] border border-[var(--aws-navy)] text-[var(--aws-navy)] rounded-md hover:bg-[var(--aws-navy)] hover:text-white">+ Add Article</button>
        </div>
        {articles.map((a, idx) => (
          <ArticleSection key={a.uid} index={idx} data={a} open={expanded.has(a.uid)} materialTypes={materialTypes}
            canRemove={articles.length > 1} isCold={isColdInvolved} onToggle={() => toggle(a.uid)} onRemove={() => removeArticle(a.uid)}
            onPatch={(p) => patchArt(a.uid, p)} onAddToList={() => addArticleToList(a)} />
        ))}

        {/* Items from request */}
        {loadedItems.length > 0 && (
          <Card title="Items from request">
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
                  <th className="py-1.5 pr-3">Item</th><th className="py-1.5 pr-3 text-right">Ordered</th>
                  <th className="py-1.5 pr-3 text-right">Scanned</th><th className="py-1.5 text-right">Pending</th></tr></thead>
                <tbody>{loadedItems.map((it, i) => {
                  const scanned = scannedByItem.get(it.itemDescription.trim().toUpperCase()) || 0;
                  const pending = Math.max(it.quantity - scanned, 0);
                  return (
                  <tr key={i} className="border-b border-[var(--aws-border)]/40">
                    <td className="py-1.5 pr-3 text-[var(--text-primary)]">{it.itemDescription}</td>
                    <td className="py-1.5 pr-3 text-right">{it.quantity}</td>
                    <td className="py-1.5 pr-3 text-right">{scanned}</td>
                    <td className={`py-1.5 text-right ${pending > 0 ? "text-amber-600" : "text-emerald-600"}`}>{pending}</td>
                  </tr>);
                })}</tbody>
              </table>
            </div>
          </Card>
        )}

        {/* Scanned boxes */}
        <Card title={`Scanned boxes (${totals.scannedCount})${totals.manualCount ? ` + ${totals.manualCount} manual` : ""}`} action={scannedBoxes.length ? <button type="button" onClick={clearAllBoxes} className="text-[12px] text-rose-600 hover:underline">Clear All</button> : undefined}>
          {scannedBoxes.length === 0 ? (
            <p className="text-[12px] text-[var(--text-secondary)] py-2">No boxes yet — scan, fetch, or use “Add to list” on an article.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
                  <th className="py-1.5 pr-2">#</th><th className="py-1.5 pr-2">Box ID</th><th className="py-1.5 pr-2">Txn</th>
                  <th className="py-1.5 pr-2">Article</th><th className="py-1.5 pr-2">Lot</th>
                  <th className="py-1.5 pr-2 text-right">Net</th><th className="py-1.5 pr-2 text-right">Gross</th><th /></tr></thead>
                <tbody>{scannedBoxes.map((b) => (
                  <tr key={b.id} className="border-b border-[var(--aws-border)]/40 hover:bg-[var(--background)]">
                    <td className="py-1 pr-2">{b.boxNumber}</td>
                    <td className="py-1 pr-2 font-mono">{b.boxId || (b.transactionNo === "DIRECT" ? "—" : "")}</td>
                    <td className="py-1 pr-2 font-mono">{b.transactionNo}</td>
                    <td className="py-1 pr-2 max-w-[180px] truncate" title={b.article}>{b.article}</td>
                    <td className="py-1 pr-2">{b.lotNumber || "—"}</td>
                    <td className="py-1 pr-2 text-right"><input value={b.netWeight} type="number" step="any" onWheel={(e) => e.currentTarget.blur()}
                      onChange={(e) => updateScannedBox(b.id, { netWeight: e.target.value })}
                      className="w-20 px-1.5 py-1 text-[12px] text-right border border-[var(--aws-border)] rounded" /></td>
                    <td className="py-1 pr-2 text-right"><input value={b.grossWeight} type="number" step="any" onWheel={(e) => e.currentTarget.blur()}
                      onChange={(e) => updateScannedBox(b.id, { grossWeight: e.target.value })}
                      className="w-20 px-1.5 py-1 text-[12px] text-right border border-[var(--aws-border)] rounded" /></td>
                    <td className="py-1 text-right"><button type="button" onClick={() => removeBox(b.id)} className="text-rose-600 hover:underline">✕</button></td>
                  </tr>))}</tbody>
                <tfoot><tr className="font-medium text-[var(--text-primary)]">
                  <td className="py-1.5" colSpan={5}>Totals</td>
                  <td className="py-1.5 pr-2 text-right">{totals.net.toFixed(3)}</td>
                  <td className="py-1.5 pr-2 text-right">{totals.gross.toFixed(3)}</td><td /></tr></tfoot>
              </table>
            </div>
          )}
        </Card>

        {/* Weight comparison */}
        {loadedItems.length > 0 && (
          <Card title="Weight comparison">
            <div className="flex flex-wrap gap-6 text-[13px]">
              <div><span className="text-[var(--text-secondary)]">Requested net: </span><span className="font-medium">{requestedNet.toFixed(3)} kg</span></div>
              {/* scannedNet, not the whole list: DIRECT rows are derived FROM these same
                  articles' net weights, so comparing against them made Δ read 0.000 kg
                  "matches" without a single box having been scanned. */}
              <div><span className="text-[var(--text-secondary)]">Actual (scanned) net: </span><span className="font-medium">{totals.scannedCount ? `${totals.scannedNet.toFixed(3)} kg` : "not scanned yet"}</span></div>
              <div><span className="text-[var(--text-secondary)]">Δ: </span>{totals.scannedCount
                ? <span className={`font-medium ${Math.abs(requestedNet - totals.scannedNet) > 0.001 ? "text-amber-600" : "text-emerald-600"}`}>{(totals.scannedNet - requestedNet).toFixed(3)} kg</span>
                : <span className="font-medium text-[var(--text-secondary)]">— no boxes scanned</span>}</div>
            </div>
          </Card>
        )}

        {/* Submit */}
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-[12px] text-[var(--text-secondary)]">Saved as <span className="font-medium text-sky-600">Dispatch</span> (or Partial if scanned boxes &lt; ordered qty).</span>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => router.back()} className="px-3 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md hover:border-[var(--aws-navy)]">Cancel</button>
              <button type="submit" disabled={submitting} className="px-4 py-1.5 text-[13px] rounded-md bg-[var(--aws-navy)] text-white hover:opacity-90 disabled:opacity-50">
                {submitting ? "Submitting…" : "Submit Transfer"}
              </button>
            </div>
          </div>
        </Card>
      </form>

      {coldPopup && (
        <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg w-full max-w-md p-4">
            <h3 className="text-[14px] font-semibold text-[var(--text-primary)] mb-2">Cold transfer summary</h3>
            <pre className="text-[12px] bg-[var(--background)] border border-[var(--aws-border)] rounded-md p-3 whitespace-pre-wrap max-h-72 overflow-y-auto">{coldPopup}</pre>
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={() => navigator.clipboard?.writeText(coldPopup)}
                className="px-3 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md hover:border-[var(--aws-navy)]">Copy</button>
              <button type="button" onClick={() => { setColdPopup(null); router.push("/modules/transfer"); }}
                className="px-4 py-1.5 text-[13px] rounded-md bg-[var(--aws-navy)] text-white hover:opacity-90">OK</button>
            </div>
          </div>
        </div>
      )}
    </TransferChrome>
  );
}

// ── Article section (cascading dropdowns + quick search + add-to-list) ─────────
function ArticleSection({ index, data, open, materialTypes, canRemove, isCold, onToggle, onRemove, onPatch, onAddToList }: {
  index: number; data: Article; open: boolean; materialTypes: string[]; canRemove: boolean;
  // Cold on either leg — vakkal is expected on the line when cold is involved.
  isCold: boolean;
  onToggle: () => void; onRemove: () => void; onPatch: (p: Partial<Article>) => void; onAddToList: () => void;
}) {
  const [opt, setOpt] = useState<{ categories: string[]; subs: string[]; descriptions: string[]; uoms: (number | null)[] }>(
    { categories: [], subs: [], descriptions: [], uoms: [] });

  useEffect(() => {
    if (!data.materialType) return; let off = false;
    TransferApi.categorialDropdown({ material_type: data.materialType })
      .then((d) => { if (!off) setOpt((o) => ({ ...o, categories: d.options.item_categories })); }).catch(() => {});
    return () => { off = true; };
  }, [data.materialType]);
  useEffect(() => {
    if (!data.materialType || !data.itemCategory) return; let off = false;
    TransferApi.categorialDropdown({ material_type: data.materialType, item_category: data.itemCategory })
      .then((d) => { if (!off) setOpt((o) => ({ ...o, subs: d.options.sub_categories })); }).catch(() => {});
    return () => { off = true; };
  }, [data.materialType, data.itemCategory]);
  useEffect(() => {
    if (!data.materialType || !data.itemCategory || !data.subCategory) return; let off = false;
    TransferApi.categorialDropdown({ material_type: data.materialType, item_category: data.itemCategory, sub_category: data.subCategory })
      .then((d) => { if (!off) setOpt((o) => ({ ...o, descriptions: d.options.item_descriptions, uoms: d.options.uom_values })); }).catch(() => {});
    return () => { off = true; };
  }, [data.materialType, data.itemCategory, data.subCategory]);

  const selectDescription = (desc: string) => {
    const i = opt.descriptions.indexOf(desc); const uom = i >= 0 ? opt.uoms[i] : null;
    onPatch(uom != null ? { itemDescription: desc, unitPackSize: String(uom) } : { itemDescription: desc });
  };
  const applySearchItem = (it: CategorialSearchItem) => onPatch({
    materialType: it.material_type || "", itemCategory: it.group || "", subCategory: it.sub_group || "",
    itemDescription: it.item_description || "", unitPackSize: it.uom != null ? String(it.uom) : data.unitPackSize,
  });
  const addQty = Math.max(1, Math.floor(parseFloat(data.quantity) || 0));

  return (
    <section className="bg-white border border-[var(--aws-border)] rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 cursor-pointer hover:bg-[var(--background)]" onClick={onToggle}>
        <span className="inline-block w-4 text-[var(--text-secondary)]">{open ? "▾" : "▸"}</span>
        <span className="text-[12px] font-semibold text-[var(--text-primary)] shrink-0">Article {index + 1}</span>
        <span className="text-[12px] text-[var(--text-secondary)] truncate flex-1">
          {data.itemDescription ? <>· {data.itemDescription} · {data.materialType || "—"} · {data.quantity || "0"} {data.uom} · {data.netWeight} kg</> : <span className="italic">New article — not yet filled</span>}
        </span>
        {canRemove && <button type="button" onClick={(e) => { e.stopPropagation(); onRemove(); }} className="text-[12px] text-rose-600 hover:underline shrink-0">Remove</button>}
      </div>
      {open && (
        <div className="px-4 pb-4 pt-1 border-t border-[var(--aws-border)]">
          <div className="mt-3"><QuickSearch onPick={applySearchItem} /></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
            <Field label="Material Type" required><SearchableSelect value={data.materialType} options={materialTypes} onChange={(v) => onPatch({ materialType: v })} placeholder="Select…" /></Field>
            <Field label="Category" required><SearchableSelect value={data.itemCategory} options={opt.categories} disabled={!data.materialType} onChange={(v) => onPatch({ itemCategory: v })} placeholder={data.materialType ? "Select…" : "Pick material first"} /></Field>
            <Field label="Sub Category" required><SearchableSelect value={data.subCategory} options={opt.subs} disabled={!data.itemCategory} onChange={(v) => onPatch({ subCategory: v })} placeholder={data.itemCategory ? "Select…" : "Pick category first"} /></Field>
            <Field label="Item Description" required><SearchableSelect value={data.itemDescription} options={opt.descriptions} disabled={!data.subCategory} onChange={selectDescription} placeholder={data.subCategory ? "Select…" : "Pick sub category first"} /></Field>
            <Field label="Unit Pack Size / Count"><input type="number" step="any" min="0" value={data.unitPackSize} onWheel={(e) => e.currentTarget.blur()} onChange={(e) => onPatch({ unitPackSize: e.target.value })} className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" /></Field>
            <Field label="UOM"><select value={data.uom} onChange={(e) => onPatch({ uom: e.target.value })} className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-white"><option value="">—</option>{UOM_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}</select></Field>
            <Field label="Case Pack / Box Wt."><input type="number" step="any" min="0" value={data.packSize} onWheel={(e) => e.currentTarget.blur()} onChange={(e) => onPatch({ packSize: e.target.value })} className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" /></Field>
            <Field label="Quantity (Box/Bags)"><input type="number" step="any" min="0" value={data.quantity} onWheel={(e) => e.currentTarget.blur()} onChange={(e) => onPatch({ quantity: e.target.value })} className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" /></Field>
            <Field label="Net Weight (Kg)"><input type="number" step="any" min="0" value={data.netWeight} onWheel={(e) => e.currentTarget.blur()} onChange={(e) => onPatch({ netWeight: e.target.value })} className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" /></Field>
            <Field label="Lot Number (optional)"><input value={data.lotNumber} onChange={(e) => onPatch({ lotNumber: e.target.value })} className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" /></Field>
            <Field label="Batch Number (optional)"><input value={data.batchNumber} onChange={(e) => onPatch({ batchNumber: e.target.value })} className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" /></Field>
            {/* Cold destinations carry a vakkal mark; the challan prints it and the receiving unit matches cartons against it. */}
            <Field label={isCold ? "Vakkal *" : "Vakkal (optional)"}><input value={data.vakkal} onChange={(e) => onPatch({ vakkal: e.target.value })} className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" /></Field>
          </div>
          <div className="mt-3 flex justify-end">
            <button type="button" onClick={onAddToList} className="px-3 py-1.5 text-[12px] rounded-md border border-[var(--aws-navy)] text-[var(--aws-navy)] hover:bg-[var(--aws-navy)] hover:text-white">Add to list ({addQty} {addQty === 1 ? "box" : "boxes"})</button>
          </div>
        </div>
      )}
    </section>
  );
}

