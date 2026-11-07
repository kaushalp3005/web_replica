"use client";

// Direct Transfer OUT (doc 08) — EDIT an existing dispatch via ?editId=. Creating one with
// no request is no longer allowed: every transfer starts from a request the store accepted
// and an inventory manager approved (backend migration 121), so the create mode only
// explains where to go. Only this screen stops a direct transfer: the server checks the
// request of a transfer that carries one and still takes a transfer that carries none.
// Reuses the shared form parts (_formParts) + QR scanner; adds
// a per-article Cold-Storage stock picker (cold-source dispatch) and the edit prefill. The
// picker counts and picks a lot's boxes by the same rule from this transfer's From, at the
// picked row's own store and of its item mark, leaving out the boxes already on the list.
// A box is scanned by its QR (an IMS BE-/TR- code or an ERP Material In label) or entered
// by box number or box ID with its transaction no. Sites are compared and shown by the
// shared site table (lib/sites): "A185" and "Warehouse A185" are one site.
// Create → POST /transfers; Edit → PUT /transfers/{id} (stamps edited_at). Record only: on
// submit the boxes are recorded In-Transit on the transfer (each box's stock row, cold or
// warehouse, kept by IMS, or its ERP Material In box, is read and copied, never deducted),
// and a box taken off the list just leaves the transfer (nothing is put back into
// stock). A box whose latest transfer has not left it at this transfer's From site (still
// in transit, received at another site, or written off as short; a box received at the
// From site can be sent on) is refused by the lookup (409, shown in the scan result and
// the banner) and by the server on save; this transfer's own boxes can be taken off and
// scanned back on.
// A transfer sent from a request stays locked to it: the route, reason and items come
// from the request (the server rebuilds the lines from it, keeps its request_id and
// refuses another route with a 409), so only its boxes and transport can change here.
// Its boxes must be ones the request takes (lib/transferBoxMatch, the server's rule): a
// scanned box of another article or lot, or over a line's qty, is refused and not added,
// and one an older dispatch was saved with is marked and must be removed before a save.
// It keeps at least one box. It shows the request's own lines and reason text (what a
// save writes) and says so when an older dispatch was saved with other items, or on
// another route (it can't be re-saved). The reason code is optional for every transfer.
// A transfer without a request keeps its route unless an admin edits it (the server
// refuses anyone else with a 409), so for anyone else its route shows read only.
// Only a transfer still in transit can be edited (the server refuses the rest, 409): one
// whose status is not an in-transit one (lib/transfer isInTransitStatus) or whose receipt
// has begun opens read only, saying why.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useRequireAuth, useUserScope } from "@/lib/user";
import { TransferChrome } from "../_chrome";
import { QrScanBox } from "@/components/QrScanBox";
import { ColdStockSearch } from "../_ColdStockSearch";
import {
  Card, Field, ReadOnlyField, SearchableSelect, QuickSearch,
  EMPTY_ARTICLE, patchArticle, todayDMY, genTransferNo,
  UOM_OPTIONS, FROM_WAREHOUSES, TO_WAREHOUSES, REASONS, VEHICLES, DRIVERS,
  ScanAddResult, labelName, type Article, type ScannedBox, type OutScan,
} from "../_formParts";
import {
  TransferApi, isInTransitStatus,
  type CategorialSearchItem, type LookupBox, type RequestLine, type TransferDetail,
  type TransferBoxCreateInput, type TransferLineCreateInput,
} from "@/lib/transfer";
import { getDisplayWarehouseName } from "@/lib/transferBuildSummary";
import { canonicalSite, displaySite, isColdSite, sameSite } from "@/lib/sites";
import { ColdStorageApi, type ColdStockRecord } from "@/lib/coldStorage";
import { pickExclude, withSite } from "../_siteRules";
import {
  NO_BOX_MESSAGE, articleKey, isRealBox, lineQty, lotKey, matchBoxes, refusalText, refuseNewBox, refusedBoxes,
  type MatchBox, type MatchLine,
} from "@/lib/transferBoxMatch";

const COMPANY = "cfpl"; // hint only — lookups search both cfpl + cdpl
// The manual entry: a box number or a box ID (the ID its label prints), with its
// transaction no.
const EMPTY_MANUAL = { boxNumber: "", boxId: "", transactionNo: "" };
// A real box's dedup key: `${boxId}|${tno}`, trimmed ("" without both), as Scan & send
// keys its list. Every add to, check of and delete from scannedKeysRef goes through it.
function boxKey(boxId: string, tno: string): string {
  const id = boxId.trim(), t = tno.trim();
  return id && t ? `${id}|${t}` : "";
}

// A line of a request's transfer: the request's line (or the transfer's saved one when
// the request can't be read — a TransferLine has the same fields).
type RequestItem = Pick<RequestLine, "id" | "material_type" | "item_category" | "sub_category" | "item_description"
  | "quantity" | "uom" | "pack_size" | "unit_pack_size" | "net_weight" | "lot_number">;

// Lines as item + lot + whole qty, order-free: two lists with the same key hold the same items.
const linesKey = (ls: RequestItem[]) => ls
  .map((l) => `${(l.item_description || "").trim().toUpperCase()}|${(l.lot_number || "").trim()}|${Math.floor(parseFloat(l.quantity) || 0)}`)
  .sort().join("\n");

// A request's lines and a box as the box match reads them (one rule for the scan-time
// refusal, the boxes marked on load and the Scanned column).
const matchLines = (ls: RequestItem[]): MatchLine[] =>
  ls.map((l) => ({ article: l.item_description || "", lot: l.lot_number || "", qty: lineQty(l.quantity) }));
const matchBox = (b: ScannedBox): MatchBox => ({ boxId: b.boxId, article: b.article, lot: b.lotNumber });
// The boxes a save sends as boxes: a DIRECT entry ships as a line only.
const sentBoxes = (bs: ScannedBox[]) => bs.filter((b) => b.transactionNo !== "DIRECT");

// Why a loaded transfer can't be edited, or null when it can: the server saves an edit only
// while the transfer is in transit — an in-transit status and no receipt begun (else 409).
function notEditable(t: TransferDetail): string | null {
  const to = canonicalSite(t.to_warehouse) || "its destination";
  const grn = (t.grn_records ?? [])[0];
  if (grn) {
    const done = (grn.status || "").trim().toLowerCase() === "received";
    return `Transfer ${t.challan_no} ${done ? "has been received" : "is being received"} at ${to} (GRN ${grn.grn_number}), so it can't be edited.`;
  }
  if (!isInTransitStatus(t.status)) return `Transfer ${t.challan_no} is ${t.status || "not in transit"}, so it can't be edited.`;
  return null;
}

// A real box this transfer was loaded with, by what a cold pick of its lot matches.
type OwnBox = { key: string; article: string; lot: string };

export default function Page() {
  return (
    <Suspense fallback={<TransferChrome title="Transfer OUT"><div className="py-16 text-center text-[13px] text-[var(--text-secondary)]">Loading…</div></TransferChrome>}>
      <DirectTransferForm />
    </Suspense>
  );
}

function DirectTransferForm() {
  const router = useRouter();
  const allowed = useRequireAuth(router.replace);
  // Only an admin may change the route of a transfer without a request (the server's
  // update_transfer refuses anyone else with a 409); for anyone else it shows read only.
  const { isAdmin } = useUserScope();
  const searchParams = useSearchParams();
  const editId = searchParams.get("editId");
  const isEditMode = !!editId;

  // Seeded empty (not genTransferNo()/todayDMY()) so the initial render is deterministic:
  // reading the wall clock here would differ between the SSR render and client hydration
  // (timezone / minute drift) and throw a hydration mismatch. Filled on mount below.
  const [transferNo, setTransferNo] = useState("");
  const [form, setForm] = useState({
    requestNo: "", requestDate: "", fromWarehouse: "", toWarehouse: "", reason: "", reasonDescription: "",
  });
  const [transport, setTransport] = useState({ vehicle: "", vehicleOther: "", driver: "", driverOther: "", approval: "" });
  const [articles, setArticles] = useState<Article[]>([{ uid: 0, ...EMPTY_ARTICLE }]);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set([0]));
  const nextUid = useRef(1);
  const boxCounter = useRef(1);
  // The real boxes on the list, by boxKey: a box stored with stray spaces in its ID is the
  // same box as its trimmed ID (what the Box ID field, a QR and the server use).
  const scannedKeysRef = useRef<Set<string>>(new Set());
  // The real boxes this transfer was loaded with, by `${box_id}|${tno}` (QR; also trimmed,
  // for the manual Box ID) and `#${box_number}|${tno}` (manual entry by number, only where
  // the saved number is the box's real one; otherwise the fetch asks the lookup). The
  // lookups judge a box by its latest transfer and don't know which one is being edited,
  // so they refuse this transfer's own boxes with a 409 (on it, in transit); one taken off
  // the list and scanned or fetched again is put back from here instead (the server leaves
  // this transfer out on an edit).
  const ownBoxesRef = useRef<Map<string, LookupBox>>(new Map());
  // The same boxes for the cold pick's limit: the search counts this transfer's boxes as in
  // transit on it, but one taken off the list can be picked again (the pick leaves this
  // transfer out), so those of the picked lot are added to the search's count.
  const [ownBoxes, setOwnBoxes] = useState<OwnBox[]>([]);
  // Why the loaded transfer can't be edited (received, or its receipt begun), else null:
  // the form is then shown read only.
  const [lockedReason, setLockedReason] = useState<string | null>(null);
  // A request-originated transfer's request (null for one without). The server never
  // changes it on an edit; while it is set the route, reason and items are locked to
  // that request and its lines (`requestLines`) are what ships.
  const [existingRequestId, setExistingRequestId] = useState<number | null>(null);
  const [requestLines, setRequestLines] = useState<RequestItem[]>([]);
  // How an older dispatch differs from its request: the request's route when it was sent
  // on another one (a save is refused with a 409), and whether its saved items differ (a
  // save replaces them with the request's).
  const [requestDrift, setRequestDrift] = useState<{ route: string | null; lines: boolean }>({ route: null, lines: false });
  const fromRequest = existingRequestId != null;
  // A request's transfer as a scan checks a box against it: the request's number and lines
  // (set with them on load; null for a transfer without a request). Such a transfer keeps
  // at least one box, as a Scan & send dispatch needs one (the server refuses a save with none).
  const requestRef = useRef<{ no: string; lines: MatchLine[] } | null>(null);

  const [scannedBoxes, setScannedBoxes] = useState<ScannedBox[]>([]);
  // The list as of the last change, read by the scan-time check: two lookups can resolve
  // before React re-renders, and the second must count the first one's box. Every change
  // goes through putBoxes, which keeps it and the state in step.
  const boxesRef = useRef<ScannedBox[]>([]);
  const putBoxes = useCallback((next: ScannedBox[]) => { boxesRef.current = next; setScannedBoxes(next); }, []);
  const [materialTypes, setMaterialTypes] = useState<string[]>([]);
  const [manualBox, setManualBox] = useState(EMPTY_MANUAL);
  const [scanInfo, setScanInfo] = useState<OutScan | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [editLoading, setEditLoading] = useState(isEditMode);
  const [banner, setBanner] = useState<{ type: "error" | "success"; text: string } | null>(null);
  const [coldPopup, setColdPopup] = useState<string | null>(null);

  // Any spelling of a cold site ("Rishi Cold", "D-39", "Cold Storage") shows the cold picker.
  const isColdFrom = isColdSite(form.fromWarehouse);

  // ── Material types on mount ──
  useEffect(() => {
    if (!allowed) return;
    let off = false;
    TransferApi.categorialDropdown({}).then((d) => { if (!off) setMaterialTypes(d.options.material_types); }).catch(() => {});
    return () => { off = true; };
  }, [allowed]);

  // ── Seed clock-derived defaults on the client (avoids the SSR hydration mismatch). ──
  // Edit mode fills these from the loaded transfer, so only seed for a fresh create.
  // Deferred via setTimeout so the setState isn't synchronous in the effect body
  // (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (isEditMode) return;
    const id = setTimeout(() => {
      setTransferNo(genTransferNo());
      setForm((f) => ({ ...f, requestDate: todayDMY() }));
    }, 0);
    return () => clearTimeout(id);
  }, [isEditMode]);

  // ── Edit prefill ──
  useEffect(() => {
    if (!allowed || !editId) return;
    let off = false;
    (async () => {
      try {
        const t = await TransferApi.getTransfer(Number(editId));
        // A request's transfer is shown as a save writes it: the request's lines and reason
        // text, no reason code. If the request can't be read, its saved lines are shown.
        const req = t.request_id != null ? await TransferApi.getRequest(t.request_id).catch(() => null) : null;
        if (off) return;
        const norm = (v?: string | null) => (!v || v === "N/A" ? "" : v);
        const presetOrOther = (val: string, list: string[]) =>
          list.includes(val) ? { sel: val, other: "" } : (val ? { sel: "Other", other: val } : { sel: "", other: "" });
        setTransferNo(t.challan_no || genTransferNo());
        setLockedReason(notEditable(t));
        setExistingRequestId(t.request_id ?? null);
        const reqLines: RequestItem[] = t.request_id != null ? (req ? req.lines : t.lines) : [];
        setRequestLines(reqLines);
        // Named as the server's refusals name it: its request_no, else its id.
        requestRef.current = t.request_id != null
          ? { no: t.request_no || req?.request_no || String(t.request_id), lines: matchLines(reqLines) }
          : null;
        if (req) {
          // Compared as the server compares them: as sites, so A185 == A-185 == Warehouse A185.
          const sameRoute = sameSite(norm(t.from_warehouse), req.from_warehouse)
            && sameSite(norm(t.to_warehouse), req.to_warehouse);
          setRequestDrift({
            route: sameRoute ? null : `${getDisplayWarehouseName(req.from_warehouse)} → ${getDisplayWarehouseName(req.to_warehouse)}`,
            lines: linesKey(t.lines) !== linesKey(req.lines),
          });
        }
        // The stored route by canonical name, so the selects show it ("Rishi Cold" is the Rishi
        // option; a name the site table doesn't know is kept and offered as it is), and a save
        // writes the canonical name.
        setForm({
          requestNo: t.request_no || req?.request_no || "", requestDate: t.stock_trf_date || todayDMY(),
          fromWarehouse: canonicalSite(norm(t.from_warehouse)), toWarehouse: canonicalSite(norm(t.to_warehouse)),
          reason: t.request_id != null ? "" : t.reason_code || "",
          reasonDescription: (req ? req.reason_description : t.remark) || "",
        });
        const v = presetOrOther(t.vehicle_no || "", VEHICLES);
        const d = presetOrOther(t.driver_name || "", DRIVERS);
        setTransport({ vehicle: v.sel, vehicleOther: v.other, driver: d.sel, driverOther: d.other, approval: t.approved_by || "" });
        const l0 = t.lines[0];
        if (l0) {
          setArticles([{
            uid: 0, materialType: norm(l0.material_type), itemCategory: norm(l0.item_category),
            subCategory: norm(l0.sub_category), itemDescription: norm(l0.item_description),
            unitPackSize: l0.unit_pack_size || "", uom: norm(l0.uom), packSize: l0.pack_size || "1",
            quantity: l0.quantity || "1", netWeight: l0.net_weight || "0", lotNumber: l0.lot_number || "",
            entryMode: "regular",
          }]);
        }
        // Prefer real box rows; else rebuild from lines as DIRECT (line-only) entries —
        // except for a request's transfer, whose lines are the request's and ship as they are.
        if (t.boxes.length) {
          const owned: OwnBox[] = [];
          for (const b of t.boxes) {
            const tno = b.transaction_no || "";
            if (!b.box_id || !tno || tno === "DIRECT") continue;
            owned.push({ key: `${b.box_id.trim()}|${tno.trim()}`, article: b.article || "", lot: b.lot_number || "" });
            const own: LookupBox = {
              box_id: b.box_id, transaction_no: tno, box_number: b.box_number,
              article_description: b.article, item_description: b.article,
              lot_number: b.lot_number, batch_number: b.batch_number,
              net_weight: parseFloat(b.net_weight) || 0, gross_weight: parseFloat(b.gross_weight) || 0,
            };
            ownBoxesRef.current.set(`${b.box_id}|${tno}`, own);
            ownBoxesRef.current.set(`${b.box_id.trim()}|${tno.trim()}`, own);
            // Only when the saved number is the box's real one: its box_id's numeric suffix
            // (the server's cold lookup rule). A cold pick saves the list's running counter.
            const suffix = /-([0-9]{1,9})$/.exec(b.box_id);
            if (b.box_number != null && suffix && Number(suffix[1]) === b.box_number) {
              ownBoxesRef.current.set(`#${b.box_number}|${tno}`, own);
            }
          }
          setOwnBoxes(owned);
          putBoxes(t.boxes.map((b, i) => {
            const tno = b.transaction_no || "";
            const key = tno === "DIRECT" ? "" : boxKey(b.box_id || "", tno);
            if (key) scannedKeysRef.current.add(key);
            return {
              id: i + 1, boxNumber: b.box_number ?? i + 1, boxId: b.box_id || "", transactionNo: tno,
              article: b.article || "", lotNumber: b.lot_number || "", batchNumber: b.batch_number || "",
              netWeight: String(b.net_weight ?? "0"), grossWeight: String(b.gross_weight ?? "0"),
            };
          }));
          boxCounter.current = t.boxes.length + 1;
        } else if (t.request_id == null) {
          putBoxes(t.lines.map((l, i) => ({
            id: i + 1, boxNumber: i + 1, boxId: "", transactionNo: "DIRECT", article: l.item_description,
            lotNumber: l.lot_number || "", batchNumber: "", netWeight: String(l.net_weight ?? "0"),
            grossWeight: String(l.total_weight ?? l.net_weight ?? "0"),
          })));
          boxCounter.current = t.lines.length + 1;
        }
      } catch (e) {
        if (!off) setBanner({ type: "error", text: e instanceof Error ? e.message : "Failed to load transfer." });
      } finally {
        if (!off) setEditLoading(false);
      }
    })();
    return () => { off = true; };
  }, [allowed, editId, putBoxes]);

  // Changing From away from a cold warehouse resets any cold articles to regular; to
  // another cold site it keeps the picked lots but drops their counts, which were for the
  // old From (done in the handler, not an effect, to avoid cascading setState-in-effect).
  const changeFromWarehouse = (value: string) => {
    setForm((f) => ({ ...f, fromWarehouse: value }));
    const cold = isColdSite(value);
    setArticles((as) => as.map((a) => (a.entryMode !== "cold-storage" ? a
      : cold ? { ...a, csMaxBoxes: null, csCountedHere: false }
        : { ...a, entryMode: "regular", csCompany: "", csInwardNo: "", csUnit: "", csLocation: "", csItemMark: "", csMaxBoxes: null, csCountedHere: false })));
  };

  // ── Article ops ──
  const patchArt = useCallback((uid: number, patch: Partial<Article>) =>
    setArticles((as) => as.map((a) => (a.uid === uid ? patchArticle(a, patch) : a))), []);
  const addArticle = () => {
    const uid = nextUid.current++;
    setArticles((as) => [...as, { uid, ...EMPTY_ARTICLE }]);
    setExpanded((s) => new Set(s).add(uid));
  };
  const removeArticle = (uid: number) => setArticles((as) => (as.length > 1 ? as.filter((a) => a.uid !== uid) : as));
  const toggle = (uid: number) => setExpanded((s) => { const n = new Set(s); if (n.has(uid)) n.delete(uid); else n.add(uid); return n; });
  const setMode = (uid: number, mode: "regular" | "cold-storage") =>
    setArticles((as) => as.map((a) => (a.uid === uid
      ? (mode === "regular"
        ? { ...a, entryMode: "regular", csCompany: "", csInwardNo: "", csUnit: "", csLocation: "", csItemMark: "", csMaxBoxes: null, csCountedHere: false }
        : { ...a, entryMode: "cold-storage" })
      : a)));

  // ── Box ingestion (shared with transferform) ──
  // On a request's transfer a box is added only when the request takes it
  // (lib/transferBoxMatch, the rule the server applies on save); otherwise the reason is
  // shown and nothing is added. Returns whether the box was added.
  const appendBox = useCallback((b: LookupBox, fallbackTno: string): boolean => {
    const boxId = (b.box_id || "").trim();
    const tno = (b.transaction_no || fallbackTno || "").trim();
    const key = boxKey(boxId, tno);
    if (key && scannedKeysRef.current.has(key)) {
      setBanner({ type: "error", text: `Box ${boxId} / ${tno} already scanned.` });
      setScanInfo({ status: "dup", box_id: boxId, tno });
      return false;
    }
    const article = b.item_description || b.article_description || "";
    const lot = b.lot_number || "";
    const label = labelName(b, article);
    const req = requestRef.current;
    const refusal = req
      && refuseNewBox(req.lines, sentBoxes(boxesRef.current).map(matchBox), { boxId, article, lot }, req.no);
    if (refusal) {
      setBanner({ type: "error", text: refusal });
      setScanInfo({ status: "refused", box_id: boxId, article, lot, tno, reason: refusal, label });
      return false;
    }
    if (key) scannedKeysRef.current.add(key);
    const net = b.net_weight != null ? String(b.net_weight) : "0";
    const id = boxCounter.current++;
    putBoxes([...boxesRef.current, {
      id, boxNumber: typeof b.box_number === "number" ? b.box_number : id, boxId, transactionNo: tno, article,
      lotNumber: lot, batchNumber: b.batch_number || "",
      netWeight: net,
      grossWeight: b.gross_weight != null ? String(b.gross_weight) : "0",
    }]);
    setBanner(null);
    setScanInfo({ status: "added", box_id: boxId, article, lot, net, tno, label });
    return true;
  }, [putBoxes]);

  // Manual entry: by box ID when one is typed (a Material In box's number starts again in
  // each lot section of its PO, its box ID never repeats), else by box number; either with
  // its transaction no, trimmed. One of this transfer's own boxes is put back from
  // ownBoxesRef. By number that own box may not be the one meant (the server, which would
  // refuse a number two Material In boxes carry, is not asked), so the banner names it and
  // points to the Box ID field, as Scan & send's "already in the list" does. The lookups
  // judge a box by its latest transfer from this transfer's From site: one received there
  // can be sent on, one in transit or received elsewhere is refused (409).
  const handleManualBoxFetch = async () => {
    const boxId = manualBox.boxId.trim(), tno = manualBox.transactionNo.trim();
    const num = parseInt(manualBox.boxNumber, 10);
    if (boxId && !tno) { setBanner({ type: "error", text: "Enter the transaction no with the box ID." }); return; }
    if (!boxId && (!num || !tno)) { setBanner({ type: "error", text: "Box number (or box ID) and transaction no are required." }); return; }
    const own = ownBoxesRef.current.get(boxId ? `${boxId}|${tno}` : `#${num}|${tno}`);
    if (own) {
      const ownId = (own.box_id || "").trim();
      const listed = scannedKeysRef.current.has(boxKey(ownId, own.transaction_no || tno));
      const added = appendBox(own, tno);
      if (added) setManualBox(EMPTY_MANUAL);
      if (!boxId && added) {
        setBanner({ type: "success", text: `Box #${num} of ${tno} is this transfer's own box ${ownId}, now back on the list. If you meant another box with that number (Material In numbers the boxes of each lot section from 1), take it off and enter that box's ID instead.` });
      } else if (!boxId && listed) {
        setBanner({ type: "error", text: `Box #${num} of ${tno} (${ownId}) is already in the list. If this is another box with that number (Material In numbers the boxes of each lot section from 1), enter its box ID instead.` });
      }
      return;
    }
    try {
      const res = boxId
        ? await TransferApi.boxLookupById(COMPANY, boxId, tno, form.fromWarehouse)
        : await TransferApi.boxLookupByNumber(COMPANY, num, tno, form.fromWarehouse);
      if (appendBox(res.box, tno)) setManualBox(EMPTY_MANUAL);
    } catch (e) {
      // The server's own text, e.g. a 409 "Box … is already on challan … (in transit)" or
      // "… was received at … on challan …; send it from …". Shown in the result card by
      // the entry fields as well as the banner above the form, which may be scrolled out
      // of view.
      const msg = e instanceof Error ? e.message : "Box not found.";
      setBanner({ type: "error", text: msg });
      setScanInfo({ status: "err", value: `${boxId || num} / ${tno}`, error: msg });
    }
  };
  // Enter in any of the manual fields fetches the box (the fields sit inside the form, so
  // without this Enter would submit the whole transfer).
  const fetchOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); void handleManualBoxFetch(); }
  };

  // Returns whether the code was added, so the scanner shows green (added) / rose
  // (unrecognised, duplicate or refused) feedback. The scanner stays open so the operator
  // can scan box after box and read each result in the green bar; they dismiss it with ✕.
  const fromWarehouse = form.fromWarehouse;
  const handleQRScan = useCallback(async (text: string): Promise<boolean> => {
    try {
      let parsed: { tx?: string; bi?: string } | null = null;
      try { parsed = JSON.parse(text); } catch { /* not JSON */ }
      if (parsed && parsed.tx && parsed.bi) {
        const tx = String(parsed.tx), bi = String(parsed.bi);
        const own = ownBoxesRef.current.get(`${bi}|${tx}`);
        if (own) return appendBox(own, tx);
        const res = tx.startsWith("BE-")
          ? await TransferApi.bulkEntryBoxLookup(COMPANY, bi, tx, fromWarehouse)
          : await TransferApi.boxLookupById(COMPANY, bi, tx, fromWarehouse);
        return appendBox(res.box, tx);
      }
      { const msg = "Unrecognised QR format (expected a box QR label).";
        setBanner({ type: "error", text: msg }); setScanInfo({ status: "err", value: text, error: msg }); }
      return false;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "QR lookup failed.";
      setBanner({ type: "error", text: msg }); setScanInfo({ status: "err", value: text, error: msg });
      return false;
    }
  }, [appendBox, fromWarehouse]);

  // Cold-stock select → fill the article's cold fields (read-only item/weight + cs identifiers).
  // The most that can be sent is the search's count of the lot's boxes that can go from this
  // From site (available_here), else the cold table's count.
  const handleSelectCold = (uid: number, r: ColdStockRecord) => {
    const here = typeof r.available_here === "number";
    const max = here ? Math.floor(r.available_here as number)
      : r.net_qty_on_cartons != null ? Math.ceil(r.net_qty_on_cartons) : null;
    setArticles((as) => as.map((a) => (a.uid === uid ? {
      ...a, entryMode: "cold-storage" as const,
      itemCategory: r.group_name || a.itemCategory, itemDescription: r.item_description || "",
      lotNumber: r.lot_no || "", netWeight: r.weight_kg != null ? String(r.weight_kg) : "0",
      quantity: "0", csCompany: r.company || "", csInwardNo: r.inward_no || "",
      csUnit: r.unit || "", csLocation: r.storage_location || "", csItemMark: r.item_mark || "",
      csMaxBoxes: max, csCountedHere: here,
    } : a)));
  };

  // The most boxes of a cold article's lot a pick can return: the search's count from the
  // From site, plus, when it is that count, this transfer's own boxes of the lot that are
  // off the list (the search holds them in transit on this transfer; the pick, which leaves
  // the edited transfer out, can take them again). An upper bound: the pick returns what
  // can really go, and says so when it is fewer. null = unknown.
  const coldMax = (a: Article): number | null => {
    if (a.csMaxBoxes == null) return null;
    if (!a.csCountedHere) return a.csMaxBoxes;
    const listed = new Set(scannedBoxes.map((b) => `${b.boxId.trim()}|${b.transactionNo.trim()}`));
    const art = articleKey(a.itemDescription), lot = lotKey(a.lotNumber);
    const off = ownBoxes.filter((o) => articleKey(o.article) === art && lotKey(o.lot) === lot && !listed.has(o.key)).length;
    return a.csMaxBoxes + off;
  };

  const addArticleToList = async (a: Article) => {
    if (!a.itemDescription) { setBanner({ type: "error", text: "Pick an item before adding to the list." }); return; }
    const isCold = a.entryMode === "cold-storage";
    const qty = Math.max(1, Math.floor(parseFloat(a.quantity) || 0));

    if (isCold) {
      // csInwardNo may legitimately be "" (cold rows with a NULL inward_no — pick_boxes
      // matches via COALESCE); csCompany + lotNumber are the real "selected" markers.
      if (!a.lotNumber || !a.csCompany) { setBanner({ type: "error", text: "Select a cold lot before adding." }); return; }
      const from = displaySite(form.fromWarehouse) || "this From site";
      const max = coldMax(a);
      if (max != null && qty > max) {
        setBanner({ type: "error", text: max > 0
          ? `Only ${max} box(es) of lot ${a.lotNumber} can be sent from ${from}.`
          : `No box of lot ${a.lotNumber} can be sent from ${from}: each is in transit, written off as short, or was received at another site.` });
        return;
      }
      // The pick judges each box by its latest transfer as a dispatch from this From takes
      // it (this transfer's own boxes don't count on an edit), keeps to the picked row's unit,
      // storage location and item mark (blank included, as the search groups them), and
      // leaves out the boxes already on the list, so a second "Add to list" of the same lot
      // takes the next free boxes.
      let picked;
      try {
        picked = await ColdStorageApi.pickBoxes({
          company: a.csCompany, item_description: a.itemDescription, lot_no: a.lotNumber, inward_no: a.csInwardNo || "", qty,
          unit: a.csUnit || "", storage_location: a.csLocation || "", item_mark: a.csItemMark || "",
          from_warehouse: form.fromWarehouse, transfer_id: editId ? Number(editId) : null,
          exclude: pickExclude(boxesRef.current, a.itemDescription, a.lotNumber),
        });
      } catch (e) {
        setBanner({ type: "error", text: e instanceof Error ? e.message : "Could not pick boxes." }); return;
      }
      const boxes = picked.boxes || [];
      if (boxes.length < qty) {
        setBanner({ type: "error", text: `Only ${boxes.length} more box(es) of lot ${a.lotNumber} can be sent from ${from} (asked for ${qty}): the others are on this list already, in transit, written off as short, or were received at another site.` });
        return;
      }
      const ids = new Set(boxes.map((b) => b.box_id));
      if (ids.size < boxes.length) { setBanner({ type: "error", text: "Cold pick returned duplicate box ids — aborting to avoid inventory loss." }); return; }
      const add: ScannedBox[] = [];
      for (const b of boxes) {
        const key = boxKey(b.box_id || "", b.transaction_no || "");
        if (key && scannedKeysRef.current.has(key)) continue;
        if (key) scannedKeysRef.current.add(key);
        const id = boxCounter.current++;
        add.push({
          id, boxNumber: id, boxId: b.box_id || "", transactionNo: b.transaction_no || "",
          article: a.itemDescription, lotNumber: a.lotNumber, batchNumber: "",
          netWeight: String(b.weight_kg ?? "0"), grossWeight: String(b.weight_kg ?? "0"),
        });
      }
      if (add.length === 0) {
        // The pick leaves out the listed boxes, so this is only a guard against an answer
        // that came back with them anyway. Tell the operator instead of a green "0".
        setBanner({ type: "error", text: "Those boxes are already on the list." });
        return;
      }
      putBoxes([...boxesRef.current, ...add]);
      setBanner({ type: "success", text: `Added ${add.length} cold box(es) for ${a.itemDescription}.` });
      return;
    }

    // Regular (warehouse / manual) → DIRECT line-only boxes.
    if (a.materialType.toUpperCase() === "FG" && (parseFloat(a.unitPackSize) || 0) <= 0) {
      setBanner({ type: "error", text: "FG articles need a unit pack size before adding." }); return;
    }
    const totalNet = parseFloat(a.netWeight) || 0;
    const perBox = qty ? totalNet / qty : totalNet;
    const add: ScannedBox[] = [];
    for (let i = 0; i < qty; i++) {
      const id = boxCounter.current++;
      add.push({ id, boxNumber: id, boxId: "", transactionNo: "DIRECT", article: a.itemDescription, lotNumber: a.lotNumber, batchNumber: "", netWeight: perBox.toFixed(3), grossWeight: perBox.toFixed(3) });
    }
    putBoxes([...boxesRef.current, ...add]);
    setBanner({ type: "success", text: `Added ${qty} ${a.itemDescription} entr${qty === 1 ? "y" : "ies"} to the list.` });
  };

  const updateScannedBox = (id: number, patch: Partial<ScannedBox>) =>
    putBoxes(boxesRef.current.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  const removeBox = (id: number) => {
    const b = boxesRef.current.find((x) => x.id === id);
    const key = b && b.transactionNo !== "DIRECT" ? boxKey(b.boxId, b.transactionNo) : "";
    if (key) scannedKeysRef.current.delete(key);
    putBoxes(boxesRef.current.filter((x) => x.id !== id));
  };
  const clearAllBoxes = () => { scannedKeysRef.current.clear(); putBoxes([]); boxCounter.current = 1; };

  // ── Derived ──
  const totals = useMemo(() => {
    const net = scannedBoxes.reduce((s, b) => s + (parseFloat(b.netWeight) || 0), 0);
    const gross = scannedBoxes.reduce((s, b) => s + (parseFloat(b.grossWeight) || 0), 0);
    return { count: scannedBoxes.length, net, gross };
  }, [scannedBoxes]);

  const resolvedVehicle = transport.vehicle === "Other" ? transport.vehicleOther.trim() : transport.vehicle;
  const resolvedDriver = transport.driver === "Other" ? transport.driverOther.trim() : transport.driver;
  // A request's transfer carries the request's own site strings, so judge them by the site
  // table: any spelling of a cold site is cold.
  const isColdInvolved = isColdSite(form.fromWarehouse) || isColdSite(form.toWarehouse);
  // The stored From / To stay selectable when the lists don't offer them.
  const fromOptions = withSite(FROM_WAREHOUSES, form.fromWarehouse);
  const toOptions = withSite(TO_WAREHOUSES, form.toWarehouse).filter((w) => !sameSite(w, form.fromWarehouse));

  // A request's transfer, by the rule the scan-time refusal and the server use: how many
  // boxes each request line takes (the Scanned column), and the boxes the request takes
  // none of. A scan never adds such a box, so only an older dispatch saved with one has
  // them; they are marked and a save is refused until they are removed.
  const requestMatch = useMemo(() => {
    if (!fromRequest) return { taken: [] as number[], refused: [] as { id: number; message: string }[] };
    const lines = matchLines(requestLines), sent = sentBoxes(scannedBoxes), boxes = sent.map(matchBox);
    return {
      taken: matchBoxes(lines, boxes).taken,
      refused: refusedBoxes(lines, boxes, form.requestNo || String(existingRequestId))
        .map((r) => ({ id: sent[r.index].id, message: r.message })),
    };
  }, [fromRequest, requestLines, scannedBoxes, form.requestNo, existingRequestId]);
  const refusedIds = new Set(requestMatch.refused.map((r) => r.id));
  // One per refused box, repeats kept, as the server lists them.
  const refusedMessages = requestMatch.refused.map((r) => r.message);
  // A request's transfer keeps at least one real box (the server refuses a save with none,
  // as it refuses a Scan & send dispatch); one without a request at least one entry.
  const hasBox = fromRequest ? scannedBoxes.some(isRealBox) : scannedBoxes.length > 0;
  const noBoxMessage = fromRequest ? NO_BOX_MESSAGE
    : "Add at least one box (scan, fetch, cold-pick, or add an article to the list)";

  // The reason code is optional. A request's transfer takes its reason and items from the
  // request (read-only here), so it needs no reason description.
  const validate = (): string[] => {
    const e: string[] = [];
    if (requestDrift.route) e.push(`This dispatch is not on its request's route (${requestDrift.route}) and can't be re-saved`);
    if (!form.fromWarehouse) e.push("From warehouse is required");
    if (!form.toWarehouse) e.push("To warehouse is required");
    // One site by any spelling ("A185" / "Warehouse A185"), as the server checks it.
    if (sameSite(form.fromWarehouse, form.toWarehouse)) e.push("From and To warehouse must differ");
    if (!fromRequest && !form.reasonDescription.trim()) e.push("Reason description is required");
    if (!resolvedVehicle) e.push("Vehicle number is required");
    if (!resolvedDriver) e.push("Driver name is required");
    if (!transport.approval.trim()) e.push("Approval authority is required");
    if (!hasBox) e.push(noBoxMessage);
    // Listed as the server's 409 lists them: the first 10, then "And <n> more.".
    if (refusedMessages.length) e.push(refusalText(refusedMessages));
    // A box whose gross is unknown arrives (and is sent) as 0, so only a gross above 0 is
    // checked — the same rule as Scan & send.
    scannedBoxes.forEach((b) => {
      const gross = parseFloat(b.grossWeight) || 0;
      if (gross > 0 && (parseFloat(b.netWeight) || 0) > gross + 1e-6) e.push(`Box ${b.boxNumber}: net weight exceeds gross`);
    });
    return e;
  };

  const buildPayload = () => {
    // A request's transfer sends the request's lines — the server rebuilds them from the
    // request and ignores these, but the body needs at least one. Otherwise one line per
    // box (doc 08), so the lines mirror what shipped.
    const lines: TransferLineCreateInput[] = fromRequest && requestLines.length > 0
      ? requestLines.map((l) => ({
        material_type: l.material_type || "", item_category: l.item_category || "", sub_category: l.sub_category || "",
        item_description: l.item_description || "", quantity: l.quantity || "1", uom: l.uom || "",
        pack_size: l.pack_size || "0", unit_pack_size: l.unit_pack_size || null,
        net_weight: l.net_weight || "0", total_weight: l.net_weight || "0",
        batch_number: null, lot_number: l.lot_number || null, vakkal: null,
      }))
      : scannedBoxes.map((b) => ({
        material_type: "RM", item_category: "", sub_category: "", item_description: b.article,
        quantity: "1", uom: "", pack_size: "0", unit_pack_size: null,
        net_weight: (parseFloat(b.netWeight) || 0).toFixed(3), total_weight: (parseFloat(b.grossWeight) || 0).toFixed(3),
        batch_number: b.batchNumber || null, lot_number: b.lotNumber || null, vakkal: null,
      }));
    // DIRECT (manually-keyed) entries have no physical box_id — they ship as lines only,
    // never as interunit_transfer_boxes rows (the backend records them in transit via
    // park_lines, without touching stock).
    // Persisting them as boxes surfaced empty box_ids as "N/A" in the view. (Legacy parity.)
    const boxes: TransferBoxCreateInput[] = scannedBoxes.filter((b) => b.transactionNo !== "DIRECT").map((b) => ({
      box_number: b.boxNumber, box_id: b.boxId || null, article: b.article,
      lot_number: b.lotNumber || null, batch_number: b.batchNumber || null, transaction_no: b.transactionNo || null,
      net_weight: (parseFloat(b.netWeight) || 0).toFixed(3), gross_weight: (parseFloat(b.grossWeight) || 0).toFixed(3),
    }));
    return {
      header: {
        challan_no: transferNo, stock_trf_date: form.requestDate, from_warehouse: form.fromWarehouse,
        to_warehouse: form.toWarehouse, vehicle_no: resolvedVehicle, driver_name: resolvedDriver || null,
        approved_by: transport.approval.trim() || null, remark: form.reasonDescription || form.reason,
        // Optional; a request's transfer has none (the server writes NULL for it).
        reason_code: fromRequest ? null : form.reason || null,
      },
      // The transfer's own request, never another one (the server keeps it on an edit).
      lines, boxes, request_id: existingRequestId,
    };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (lockedReason) return;
    setBanner(null);
    const errs = validate();
    // The banner sits above the form, so errors (a server 409 included) scroll back up to it.
    if (errs.length) { setBanner({ type: "error", text: errs.join(" · ") }); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    setSubmitting(true);
    try {
      const payload = buildPayload();
      const res = isEditMode ? await TransferApi.updateTransfer(Number(editId), payload) : await TransferApi.createTransfer(payload);
      if (isColdInvolved) {
        setColdPopup([
          `Transfer ${res.challan_no} (${res.status})`, `From ${form.fromWarehouse} → ${form.toWarehouse}`,
          `Vehicle ${resolvedVehicle}`, "", ...scannedBoxes.map((b) => `${b.article} — lot ${b.lotNumber || "—"}`),
        ].join("\n"));
      } else {
        setBanner({ type: "success", text: `Transfer ${res.challan_no} ${isEditMode ? "updated" : "created"} (${res.status}).` });
        setTimeout(() => router.push("/modules/transfer"), 1200);
      }
      // Leave submitting=true on success (page navigates away / cold popup blocks) so a
      // second click can't duplicate the dispatch.
    } catch (err) {
      setBanner({ type: "error", text: err instanceof Error ? err.message : "Failed to submit transfer." });
      window.scrollTo({ top: 0, behavior: "smooth" });
      setSubmitting(false);
    }
  };

  // Render the shell regardless of `allowed`: useRequireAuth returns true on the server
  // but false on the client's first render, so gating the render on it makes the SSR HTML
  // differ from the first client render → hydration mismatch. Effects stay gated on
  // `allowed` and the hook redirects unauthenticated users.

  if (!isEditMode) {
    return (
      <TransferChrome title="Transfer OUT">
        <button onClick={() => router.push("/modules/transfer")}
          className="text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] mb-3">← Transfer</button>
        <section className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)]">
          Direct transfers are no longer used. Every transfer starts from a request: the store team of the
          supplying warehouse accepts it, the inventory manager approves it, and then the store scans and sends
          it from Requests → Scan &amp; send.
        </section>
      </TransferChrome>
    );
  }

  return (
    <TransferChrome title={isEditMode ? "Edit Transfer OUT" : "Transfer OUT"}>
      <button onClick={() => router.push("/modules/transfer")}
        className="text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] mb-3">← Transfer</button>

      <div className="flex flex-wrap items-end justify-between gap-2 mb-4">
        <h1 className="text-[20px] font-semibold text-[var(--text-primary)]">{isEditMode ? "Edit Transfer OUT" : "Direct Transfer OUT"}</h1>
        <span className="text-[12px] text-[var(--text-secondary)]">Transfer No <span className="font-mono text-[var(--text-primary)]">{transferNo}</span></span>
      </div>

      {editLoading && <div className="mb-4 rounded-md p-3 text-[13px] bg-[var(--background)] border border-[var(--aws-border)] text-[var(--text-secondary)]">Loading transfer…</div>}
      {banner && (
        <div className={`mb-4 rounded-md p-3 text-[13px] border ${banner.type === "error" ? "bg-rose-50 border-rose-200 text-rose-700" : "bg-emerald-50 border-emerald-200 text-emerald-700"}`}>{banner.text}</div>
      )}
      {fromRequest && requestDrift.route && (
        <div className="mb-4 rounded-md p-3 text-[13px] border bg-rose-50 border-rose-200 text-rose-700">
          This transfer was sent {getDisplayWarehouseName(form.fromWarehouse)} → {getDisplayWarehouseName(form.toWarehouse)}, but request{" "}
          {form.requestNo || `#${existingRequestId}`} was approved for {requestDrift.route}. A transfer from a request has to keep
          the request&apos;s route, so this older dispatch can&apos;t be re-saved here.
        </div>
      )}

      {lockedReason && (
        <div className="mb-4 rounded-md p-3 text-[13px] border bg-amber-50 border-amber-200 text-amber-800">
          {lockedReason} It is shown read only; <button type="button" onClick={() => router.push(`/modules/transfer/view/${editId}`)}
            className="underline">view it</button> for its details and receipt.
        </div>
      )}

      {/* Nothing to edit until the transfer is loaded (a request's transfer is locked). A
          transfer that can't be edited is shown with every field and button disabled. */}
      {!editLoading && (
      <form onSubmit={handleSubmit} className="max-w-4xl">
        <fieldset disabled={!!lockedReason} className="space-y-4 min-w-0">
        <Card title="Transfer details">
          {fromRequest && (
            <p className="text-[12px] text-[var(--text-secondary)] mb-3">
              Items and quantities come from request <span className="font-mono text-[var(--text-primary)]">{form.requestNo || `#${existingRequestId}`}</span>;
              {" "}its route and reason are locked. Only the boxes (and transport) can change.
            </p>
          )}
          {!fromRequest && !isAdmin && (
            <p className="text-[12px] text-[var(--text-secondary)] mb-3">
              Only an admin can change the route (From and To) of a transfer sent without a request.
            </p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Request No"><input value={form.requestNo} readOnly placeholder="(direct transfer)"
              className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-[var(--background)] font-mono" /></Field>
            <Field label="Transfer Date" required><input value={form.requestDate} onChange={(e) => setForm({ ...form, requestDate: e.target.value })}
              placeholder="DD-MM-YYYY" className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" /></Field>
            {fromRequest ? (
              <>
                <ReadOnlyField label="From (Supplying)" value={getDisplayWarehouseName(form.fromWarehouse)} />
                <ReadOnlyField label="To (Requesting)" value={getDisplayWarehouseName(form.toWarehouse)} />
                {/* The request's reason text; a request's dispatch carries no reason code. */}
                <div className="sm:col-span-2">
                  <ReadOnlyField label="Reason Description" value={form.reasonDescription} multiline />
                </div>
              </>
            ) : (
              <>
                {isAdmin ? (
                  <>
                    <Field label="From (Supplying)" required>
                      <select value={form.fromWarehouse} onChange={(e) => changeFromWarehouse(e.target.value)}
                        className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-white">
                        <option value="">Select…</option>{fromOptions.map((w) => <option key={w} value={w}>{w}</option>)}
                      </select>
                    </Field>
                    <Field label="To (Requesting)" required>
                      <select value={form.toWarehouse} onChange={(e) => setForm({ ...form, toWarehouse: e.target.value })}
                        className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-white">
                        <option value="">Select…</option>{toOptions.map((w) => <option key={w} value={w}>{w}</option>)}
                      </select>
                    </Field>
                  </>
                ) : (
                  <>
                    <ReadOnlyField label="From (Supplying)" value={getDisplayWarehouseName(form.fromWarehouse)} />
                    <ReadOnlyField label="To (Requesting)" value={getDisplayWarehouseName(form.toWarehouse)} />
                  </>
                )}
                <Field label="Reason">
                  <select value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}
                    className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-white">
                    <option value="">— None —</option>{REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </Field>
                <div />
                <div className="sm:col-span-2">
                  <Field label="Reason Description" required>
                    <textarea value={form.reasonDescription} onChange={(e) => setForm({ ...form, reasonDescription: e.target.value })}
                      rows={2} className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md resize-y" />
                  </Field>
                </div>
              </>
            )}
          </div>
        </Card>

        <Card title="Scan / add boxes">
          <div className="space-y-3">
            {/* Inline always-on scanner — same card as the job-card RM tab. */}
            <QrScanBox title="Scan box QR"
              idleHint="Start the camera and centre a box QR to add it to the dispatch."
              onResult={(v) => { void handleQRScan(v); }} />
            {scanInfo && <ScanAddResult scan={scanInfo} onDismiss={() => setScanInfo(null)} />}
            <div className="flex flex-wrap items-end gap-3">
              <span className="text-[12px] text-[var(--text-secondary)]">or enter manually:</span>
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Box Number"><input value={manualBox.boxNumber} type="number" onWheel={(e) => e.currentTarget.blur()}
                  onChange={(e) => setManualBox({ ...manualBox, boxNumber: e.target.value })}
                  onKeyDown={fetchOnEnter}
                  className="w-28 px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" /></Field>
                <Field label="Box ID"><input value={manualBox.boxId}
                  onChange={(e) => setManualBox({ ...manualBox, boxId: e.target.value })}
                  onKeyDown={fetchOnEnter}
                  className="w-36 px-2.5 py-1.5 text-[13px] font-mono border border-[var(--aws-border)] rounded-md" /></Field>
                <Field label="Transaction No"><input value={manualBox.transactionNo}
                  onChange={(e) => setManualBox({ ...manualBox, transactionNo: e.target.value })}
                  onKeyDown={fetchOnEnter}
                  className="w-44 px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" /></Field>
                <button type="button" onClick={handleManualBoxFetch}
                  className="px-3 py-1.5 text-[13px] rounded-md bg-[var(--aws-navy)] text-white hover:opacity-90">Fetch Box</button>
              </div>
            </div>
            <p className="text-[11px] text-[var(--text-secondary)]">
              Type the box number or the box ID, and the transaction no, as the box&apos;s label prints them. With a box ID filled in, the box number is not used.
            </p>
          </div>
        </Card>

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

        {fromRequest ? (
          // A request's items, read-only: no article editor and no "Add to list" (the
          // server ships the request's lines and would drop line-only entries anyway).
          <Card title={`Items from request (${requestLines.length})`}>
            {requestLines.length === 0 ? (
              <p className="text-[12px] text-[var(--text-secondary)] py-2">No items on this transfer.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
                    <th className="py-1.5 pr-3">Item</th><th className="py-1.5 pr-3">Lot</th>
                    <th className="py-1.5 pr-3 text-right">Qty</th><th className="py-1.5 pr-3 text-right">Scanned</th>
                    <th className="py-1.5 pr-3">UOM</th><th className="py-1.5 text-right">Net (kg)</th></tr></thead>
                  <tbody>{requestLines.map((l, i) => (
                    <tr key={l.id} className="border-b border-[var(--aws-border)]/40">
                      <td className="py-1.5 pr-3 text-[var(--text-primary)]">{l.item_description}</td>
                      <td className="py-1.5 pr-3">{l.lot_number || "—"}</td>
                      <td className="py-1.5 pr-3 text-right">{l.quantity}</td>
                      <td className="py-1.5 pr-3 text-right">{requestMatch.taken[i] ?? 0}</td>
                      <td className="py-1.5 pr-3">{l.uom || "—"}</td>
                      <td className="py-1.5 text-right">{l.net_weight}</td>
                    </tr>))}</tbody>
                </table>
              </div>
            )}
            {requestDrift.lines && (
              <p className="mt-2 text-[12px] text-amber-700">
                This transfer was saved with other items or quantities. These are the request&apos;s; saving replaces the saved items with them.
              </p>
            )}
            <p className="mt-2 text-[12px] text-[var(--text-secondary)]">Only boxes the request asks for can be scanned: a box of another item or lot, or one more than a line&apos;s quantity, is refused and not added.</p>
          </Card>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">Articles ({articles.length})</h2>
              <button type="button" onClick={addArticle}
                className="px-2.5 py-1 text-[12px] border border-[var(--aws-navy)] text-[var(--aws-navy)] rounded-md hover:bg-[var(--aws-navy)] hover:text-white">+ Add Article</button>
            </div>
            {articles.map((a, idx) => (
              <DirectArticleSection key={a.uid} index={idx} data={a} open={expanded.has(a.uid)} materialTypes={materialTypes}
                canRemove={articles.length > 1} isColdFrom={isColdFrom} fromWarehouse={form.fromWarehouse} maxBoxes={coldMax(a)}
                onToggle={() => toggle(a.uid)} onRemove={() => removeArticle(a.uid)} onPatch={(p) => patchArt(a.uid, p)}
                onSetMode={(m) => setMode(a.uid, m)} onSelectCold={(r) => handleSelectCold(a.uid, r)} onAddToList={() => addArticleToList(a)} />
            ))}
          </>
        )}

        <Card title={`Scanned boxes (${totals.count})`} action={scannedBoxes.length ? <button type="button" onClick={clearAllBoxes} className="text-[12px] text-rose-600 hover:underline">Clear All</button> : undefined}>
          {scannedBoxes.length === 0 ? (
            <p className="text-[12px] text-[var(--text-secondary)] py-2">{fromRequest ? "No boxes yet — scan a box QR or fetch one by box number or box ID." : "No boxes yet — scan, fetch, cold-pick, or use “Add to list”."}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
                  <th className="py-1.5 pr-2">#</th><th className="py-1.5 pr-2">Box ID</th><th className="py-1.5 pr-2">Txn</th>
                  <th className="py-1.5 pr-2">Article</th><th className="py-1.5 pr-2">Lot</th>
                  <th className="py-1.5 pr-2 text-right">Net</th><th className="py-1.5 pr-2 text-right">Gross</th><th /></tr></thead>
                <tbody>{scannedBoxes.map((b) => (
                  <tr key={b.id} className={`border-b border-[var(--aws-border)]/40 ${refusedIds.has(b.id) ? "bg-rose-50 text-rose-700" : "hover:bg-[var(--background)]"}`}>
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
          {refusedMessages.length > 0 && (
            <div className="mt-2 text-[12px] text-rose-700">
              <p>The boxes marked in red are not ones the request takes; this dispatch was saved with them before its boxes had to match the request. Remove them before saving:</p>
              <ul className="mt-1 list-disc pl-5">{requestMatch.refused.map((r) => <li key={r.id}>{r.message}</li>)}</ul>
            </div>
          )}
        </Card>

        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            {hasBox
              ? <span className="text-[12px] text-[var(--text-secondary)]">Saved as <span className="font-medium text-sky-600">Dispatch</span> (or Partial if scanned boxes &lt; ordered qty).</span>
              : <span className="text-[12px] text-amber-700">{noBoxMessage}</span>}
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => router.back()} className="px-3 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md hover:border-[var(--aws-navy)]">Cancel</button>
              <button type="submit" disabled={submitting || !!lockedReason || !!requestDrift.route || !hasBox} title={lockedReason || (hasBox ? undefined : noBoxMessage)}
                className="px-4 py-1.5 text-[13px] rounded-md bg-[var(--aws-navy)] text-white hover:opacity-90 disabled:opacity-50">
                {submitting ? "Submitting…" : isEditMode ? "Update Transfer" : "Submit Transfer"}
              </button>
            </div>
          </div>
        </Card>
        </fieldset>
      </form>
      )}

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

// ── Article section: regular grid OR cold-storage picker (per-article toggle) ──
function DirectArticleSection({ index, data, open, materialTypes, canRemove, isColdFrom, fromWarehouse, maxBoxes, onToggle, onRemove, onPatch, onSetMode, onSelectCold, onAddToList }: {
  index: number; data: Article; open: boolean; materialTypes: string[]; canRemove: boolean; isColdFrom: boolean;
  fromWarehouse: string;
  // The most boxes of the picked cold lot that can go (the form's coldMax); null = unknown.
  maxBoxes: number | null;
  onToggle: () => void; onRemove: () => void; onPatch: (p: Partial<Article>) => void;
  onSetMode: (m: "regular" | "cold-storage") => void; onSelectCold: (r: ColdStockRecord) => void; onAddToList: () => void;
}) {
  const isCold = data.entryMode === "cold-storage";
  const [opt, setOpt] = useState<{ categories: string[]; subs: string[]; descriptions: string[]; uoms: (number | null)[] }>(
    { categories: [], subs: [], descriptions: [], uoms: [] });

  useEffect(() => {
    if (isCold || !data.materialType) return; let off = false;
    TransferApi.categorialDropdown({ material_type: data.materialType })
      .then((d) => { if (!off) setOpt((o) => ({ ...o, categories: d.options.item_categories })); }).catch(() => {});
    return () => { off = true; };
  }, [isCold, data.materialType]);
  useEffect(() => {
    if (isCold || !data.materialType || !data.itemCategory) return; let off = false;
    TransferApi.categorialDropdown({ material_type: data.materialType, item_category: data.itemCategory })
      .then((d) => { if (!off) setOpt((o) => ({ ...o, subs: d.options.sub_categories })); }).catch(() => {});
    return () => { off = true; };
  }, [isCold, data.materialType, data.itemCategory]);
  useEffect(() => {
    if (isCold || !data.materialType || !data.itemCategory || !data.subCategory) return; let off = false;
    TransferApi.categorialDropdown({ material_type: data.materialType, item_category: data.itemCategory, sub_category: data.subCategory })
      .then((d) => { if (!off) setOpt((o) => ({ ...o, descriptions: d.options.item_descriptions, uoms: d.options.uom_values })); }).catch(() => {});
    return () => { off = true; };
  }, [isCold, data.materialType, data.itemCategory, data.subCategory]);

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
        <span className="text-[12px] font-semibold text-[var(--text-primary)] shrink-0">Article {index + 1}{isCold ? " · cold" : ""}</span>
        <span className="text-[12px] text-[var(--text-secondary)] truncate flex-1">
          {data.itemDescription ? <>· {data.itemDescription} · {data.quantity || "0"} {data.uom} · {data.netWeight} kg</> : <span className="italic">New article — not yet filled</span>}
        </span>
        {canRemove && <button type="button" onClick={(e) => { e.stopPropagation(); onRemove(); }} className="text-[12px] text-rose-600 hover:underline shrink-0">Remove</button>}
      </div>
      {open && (
        <div className="px-4 pb-4 pt-1 border-t border-[var(--aws-border)]">
          {isColdFrom && (
            <div className="mt-3">
              <button type="button" onClick={() => onSetMode(isCold ? "regular" : "cold-storage")}
                className="px-2.5 py-1 text-[12px] border border-[var(--aws-border)] rounded-md hover:border-[var(--aws-navy)]">
                {isCold ? "Switch to Manual Entry" : "Switch to Cold Storage"}
              </button>
            </div>
          )}

          {isCold ? (
            <div className="mt-3 space-y-3">
              <ColdStockSearch onSelect={onSelectCold} fromWarehouse={fromWarehouse} />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Item Description"><input value={data.itemDescription} readOnly className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-[var(--background)]" /></Field>
                <Field label="Lot Number" required><input value={data.lotNumber} readOnly className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-[var(--background)] font-mono" /></Field>
                <Field label={`No. of Boxes${maxBoxes != null ? ` (max ${maxBoxes})` : ""}`} required>
                  <input type="number" step="1" min="0" value={data.quantity} onWheel={(e) => e.currentTarget.blur()}
                    onChange={(e) => { const n = parseInt(e.target.value, 10) || 0; onPatch({ quantity: String(maxBoxes != null ? Math.min(n, maxBoxes) : n) }); }}
                    className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" /></Field>
                <Field label="UOM" required>
                  <select value={data.uom} onChange={(e) => onPatch({ uom: e.target.value })} className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-white">
                    <option value="">—</option>{UOM_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select></Field>
                <Field label="Weight per box (Kg)"><input value={data.netWeight} readOnly className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-[var(--background)]" /></Field>
              </div>
            </div>
          ) : (
            <>
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
              </div>
            </>
          )}

          <div className="mt-3 flex justify-end">
            <button type="button" onClick={onAddToList} className="px-3 py-1.5 text-[12px] rounded-md border border-[var(--aws-navy)] text-[var(--aws-navy)] hover:bg-[var(--aws-navy)] hover:text-white">
              Add to list ({addQty} {addQty === 1 ? "box" : "boxes"})
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
