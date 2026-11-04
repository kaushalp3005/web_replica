"use client";

// Transfer OUT — Scan & send (doc 07). Loads an interunit request (?requestId=) and shows
// its route, reason and EVERY line read-only: once the inventory manager has approved a
// request its route, items, quantities and reason are locked (the server takes the lines
// and the remark from the request). Save on scan: the operator fills in the transfer
// information (vehicle, driver, approval authority), then ingests the physical boxes
// (camera/QR: an IMS BE-/TR- code or an ERP Material In label; or entered by box number
// or by box ID, each with its transaction no), and every box the request takes is saved
// at once (POST /api/v1/transfer/requests/{id}/scan). The first box creates the transfer,
// dated today, and marks the request Transferred; each later box is added to it. Only
// scanned boxes are in transit: the transfer is Dispatch once its boxes reach the
// request's qty, Partial until then. Record only: each box's stock row (kept by IMS, or
// its ERP Material In box) is read and copied onto the transfer as In Transit, never
// deducted. A box is refused when it is scanned, and not added (the reason shown in the
// scan result and the banner): by the lookup (409) when its latest transfer has not left
// it at the request's From site — still in transit, received at another site, or written
// off as short (a box received at this site can be sent on); here when the request
// doesn't take it — its article is not on the request, it is another lot than the line
// asks for, or the line's qty is already scanned (lib/transferBoxMatch, the server's
// rule); and by the save (409), which checks all of these again. Saves run one at a
// time in scan order, so each check counts the boxes saved before it. The list is the
// transfer's boxes as saved: ✕ takes a box off (taking off the last one cancels the
// transfer and puts the request back in Ready to Send), and a box's weights and the
// transfer information save as they are changed.
// Feedback via inline banner (no toast lib in web_replica).
// Only an Approved request may be started (the store accepted it and an inventory manager
// approved it — backend migration 121). A Transferred one is continued while its transfer
// is still out (Dispatch / Partial, nothing received): opening it here again, or "Scan
// more" on the transfer list, shows its saved boxes and adds to them.
//
// Scope note vs the reference 3053-line page: the legacy TX/CONS inward QR format is
// unsupported (no inward module here).

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { TransferChrome } from "../_chrome";
import { QrScanBox } from "@/components/QrScanBox";
import {
  Card, Field, ReadOnlyField, ScanAddResult,
  labelName, todayDMY, genTransferNo,
  VEHICLES, DRIVERS,
  type Article, type ScannedBox, type OutScan,
} from "../_formParts";
import { isColdSite } from "@/lib/sites";
import {
  REQUEST_STATUS,
  TransferApi,
  isStoreHeld,
  type BoxLookupResult,
  type LookupBox,
  type TransferDetail,
  type TransferRequest,
  type TransportBody,
} from "@/lib/transfer";
import { getDisplayWarehouseName } from "@/lib/transferBuildSummary";
import {
  isRealBox, lineQty, matchBoxes, refuseNewBox,
  type MatchBox, type MatchLine,
} from "@/lib/transferBoxMatch";

// Company is only a hint — the lookup endpoints search both cfpl + cdpl.
const COMPANY = "cfpl";

// The request's lines and a scanned box as the box match reads them (one rule for the
// scan-time refusal and the "Items from request" tracker).
const matchLines = (as: Article[]): MatchLine[] =>
  as.map((a) => ({ article: a.itemDescription, lot: a.lotNumber, qty: lineQty(a.quantity) }));
const matchBox = (b: ScannedBox): MatchBox => ({ boxId: b.boxId, article: b.article, lot: b.lotNumber });
const REQUEST_NOT_LOADED = "Wait for the request to load before scanning boxes.";
const REQUEST_LOAD_FAILED = "The request could not be loaded; reload the page.";
const TRANSPORT_MISSING = "Fill in vehicle number, driver name and approval authority before scanning.";
// A transfer still out, which Scan & send adds boxes to (the server refuses one that has
// been received meanwhile).
const OPEN_STATUSES = new Set(["Dispatch", "Partial"]);

// A box on the list, saved on the transfer: netWeight / grossWeight are its inputs as
// typed, savedNet / savedGross what the transfer holds (a refused change goes back to them).
type ListBox = ScannedBox & { savedNet: string; savedGross: string };
// The request's transfer while it is out, as the last save left it (boxCount: real boxes).
type OpenTransfer = { id: number; challanNo: string; status: string; boxCount: number };
type TransportForm = { vehicle: string; vehicleOther: string; driver: string; driverOther: string; approval: string };
const EMPTY_TRANSPORT: TransportForm = { vehicle: "", vehicleOther: "", driver: "", driverOther: "", approval: "" };
const TRANSPORT_LABEL: Record<keyof TransportBody, string> = {
  vehicle_no: "Vehicle number", driver_name: "Driver name", approved_by: "Approval authority",
};
const TRANSPORT_FIELDS = Object.keys(TRANSPORT_LABEL) as (keyof TransportBody)[];
// Fields named in a sentence: "driver name", "driver name and approval authority".
function fieldNames(fields: (keyof TransportBody)[]): string {
  const names = fields.map((f) => TRANSPORT_LABEL[f].toLowerCase());
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] ?? "";
}

// A real box's dedup key: `${boxId}|${tno}`, trimmed ("" without both).
function boxKey(boxId: string, tno: string): string {
  const id = boxId.trim(), t = tno.trim();
  return id && t ? `${id}|${t}` : "";
}
// The manual entry: a box number or a box ID (the ID its label prints), with its
// transaction no.
const EMPTY_MANUAL = { boxNumber: "", boxId: "", transactionNo: "" };
// A weight as the inputs hold it, and as a number (blank reads as 0, as a save sends it).
const weightText = (v: string | number | null | undefined) => (v === null || v === undefined || v === "" ? "0" : String(v));
const kg = (s: string) => parseFloat(s) || 0;
// Focus moving between a box's net and gross inputs (both carry data-weights = its id).
const samePair = (to: EventTarget | null, id: number) => to instanceof HTMLElement && to.dataset.weights === String(id);

// The transport as the form holds it: a listed vehicle / driver is picked, any other is
// "Other" with its text.
function transportForm(t: TransportBody): TransportForm {
  const pick = (val: string, list: string[]) =>
    list.includes(val) ? { sel: val, other: "" } : (val ? { sel: "Other", other: val } : { sel: "", other: "" });
  const v = pick(t.vehicle_no, VEHICLES), d = pick(t.driver_name, DRIVERS);
  return { vehicle: v.sel, vehicleOther: v.other, driver: d.sel, driverOther: d.other, approval: t.approved_by };
}
// The transport the form holds, as the server takes it.
function resolveTransport(f: TransportForm): TransportBody {
  return {
    vehicle_no: f.vehicle === "Other" ? f.vehicleOther.trim() : f.vehicle,
    driver_name: f.driver === "Other" ? f.driverOther.trim() : f.driver,
    approved_by: f.approval.trim(),
  };
}
function transportBlank(f: TransportForm): boolean {
  const t = resolveTransport(f);
  return !t.vehicle_no || !t.driver_name || !t.approved_by;
}

// A save's failure as the operator reads it: the server's message, or — when the server
// could not be reached (fetch throws a TypeError) — that it may not have gone through.
function failText(e: unknown, fallback: string): string {
  if (e instanceof TypeError) return "Could not reach the server, so this may not have been saved. Reload the page to see what was saved.";
  return e instanceof Error && e.message ? e.message : fallback;
}

// Why a loaded request can't be scanned (yet, or any more): one message per status.
// Rejected names the stage that rejected it and that stage's reason (a request rejected
// before migration 121 has neither, only the legacy reject_reason). A Transferred request
// gets here only when its transfer is no longer out: `receivedOn` is that transfer's
// challan (it has been received), null when it no longer exists.
function requestNotice(r: TransferRequest, receivedOn: string | null): { tone: "wait" | "stop"; text: string } {
  const no = r.request_no;
  const from = getDisplayWarehouseName(r.from_warehouse) || "the supplying warehouse";
  const held = (reason?: string | null) => (reason || "").trim().replace(/\.+$/, "") || "no reason given";
  switch (r.status) {
    case REQUEST_STATUS.PENDING:
      if (isStoreHeld(r)) {
        return { tone: "wait", text: `Request ${no} is on hold by the store: ${held(r.store_hold_reason)}. It can be scanned and sent once the store has accepted it and the inventory manager has approved it.` };
      }
      return { tone: "wait", text: `Request ${no} is waiting for the ${from} store team to accept it. It can be scanned and sent once the store has accepted it and the inventory manager has approved it.` };
    case REQUEST_STATUS.ACCEPTED:
      return { tone: "wait", text: `Request ${no} was accepted by the store and is waiting for the inventory manager (or substitute) to approve it. It can be scanned and sent once approved.` };
    case REQUEST_STATUS.ON_HOLD:
      return { tone: "wait", text: `Request ${no} is waiting for the inventory manager's decision (on hold: ${held(r.manager_hold_reason)}). It can be scanned and sent once approved.` };
    case REQUEST_STATUS.REJECTED: {
      const byStore = r.store_decision === "Rejected";
      const stage = byStore ? "the store" : r.manager_decision === "Rejected" ? "the inventory manager" : "";
      const reason = ((byStore ? r.store_reject_reason : r.manager_reject_reason) || r.reject_reason || "").trim().replace(/\.+$/, "");
      return { tone: "stop", text: `Request ${no} was rejected${stage ? ` by ${stage}` : ""}${reason ? `: ${reason}` : ""}. It cannot be scanned and sent.` };
    }
    case REQUEST_STATUS.TRANSFERRED:
      return { tone: "stop", text: receivedOn
        ? `Request ${no} was sent on transfer ${receivedOn}, which has been received; no more boxes can be added.`
        : `Request ${no} is marked Transferred but its transfer no longer exists.` };
    default:
      return { tone: "wait", text: `Request ${no} is ${r.status}. It can be scanned and sent once the store has accepted it and the inventory manager has approved it.` };
  }
}

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
  // The loaded request.
  const [request, setRequest] = useState<TransferRequest | null>(null);
  const [requestLoading, setRequestLoading] = useState(!!requestId);
  // Why the loaded request can't be scanned (yet, or any more); null when it can.
  const [notice, setNotice] = useState<{ tone: "wait" | "stop"; text: string } | null>(null);
  // The request's transfer while it is out: none until the first box is saved. Queued saves
  // read it through the ref; putTransfer keeps the two in step.
  const [transfer, setTransfer] = useState<OpenTransfer | null>(null);
  const transferRef = useRef<OpenTransfer | null>(null);
  const putTransfer = useCallback((t: OpenTransfer | null) => { transferRef.current = t; setTransfer(t); }, []);
  // Scanning starts a transfer for an Approved request and adds to a Transferred one's
  // transfer while that is out.
  const canSend = !!request && (request.status === REQUEST_STATUS.APPROVED
    || (request.status === REQUEST_STATUS.TRANSFERRED && !!transfer));

  // Seeded empty so the initial render is deterministic: genTransferNo()/todayDMY() read
  // the wall clock and would mismatch between the SSR render and client hydration
  // (timezone / minute drift). Filled on mount below; the scan that creates the transfer
  // sends them, read through draftRef.
  const [transferNo, setTransferNo] = useState("");
  const draftRef = useRef({ transferNo: "", transferDate: "" });
  // Everything except transferDate comes from the request and is read-only.
  const [form, setForm] = useState({
    requestNo: "", requestDate: "", transferDate: "", fromWarehouse: "", toWarehouse: "",
    reasonDescription: "",
  });
  // The transfer information. Queued saves read it through the ref (putTransport keeps the
  // two in step); savedTransportRef is the transfer's as saved, which a refused change
  // goes back to.
  const [transport, setTransport] = useState<TransportForm>(EMPTY_TRANSPORT);
  const transportRef = useRef<TransportForm>(EMPTY_TRANSPORT);
  const putTransport = useCallback((t: TransportForm) => { transportRef.current = t; setTransport(t); }, []);
  const savedTransportRef = useRef<TransportBody>({ vehicle_no: "", driver_name: "", approved_by: "" });
  // The "Other" vehicle / driver text boxes, which take the cursor when Other is picked.
  const vehicleOtherRef = useRef<HTMLInputElement>(null);
  const driverOtherRef = useRef<HTMLInputElement>(null);
  // The request's lines, locked: one read-only article per line.
  const [articles, setArticles] = useState<Article[]>([]);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set([0]));
  // List row ids. Never reused, so a queued save that names a row finds that box or none.
  const boxCounter = useRef(1);
  // Synchronous dedup of real boxes by `${boxId}|${tno}`: the boxes on the list and those
  // being looked up or saved. A flag set inside a setState updater can't be read reliably,
  // so we track keys in a ref.
  const scannedKeysRef = useRef<Set<string>>(new Set());
  // The loaded request as a scan checks a box against it: its number, From site (sent to the
  // lookups, which judge the box's last transfer from it) and lines. Null until it loads, so
  // a box scanned before then is refused instead of looked up against nothing.
  const requestRef = useRef<{ no: string; from: string; lines: MatchLine[] } | null>(null);
  // Set when the request failed to load: it never will, so a scan says so instead of "wait".
  const requestFailedRef = useRef(false);

  // The transfer's boxes as saved, in the order they were saved.
  const [scannedBoxes, setScannedBoxes] = useState<ListBox[]>([]);
  // The list as of the last change, read by the scan-time check and the queued saves: they
  // run before React re-renders. Every change goes through putBoxes, which keeps it and the
  // state in step.
  const boxesRef = useRef<ListBox[]>([]);
  const putBoxes = useCallback((next: ListBox[]) => { boxesRef.current = next; setScannedBoxes(next); }, []);
  // Rows being taken off the transfer: their ✕ and weights are greyed meanwhile.
  const busyRef = useRef(new Set<number>());
  const [busyIds, setBusyIds] = useState<ReadonlySet<number>>(() => new Set());
  const setBusy = useCallback((ids: number[], on: boolean) => {
    ids.forEach((id) => { if (on) busyRef.current.add(id); else busyRef.current.delete(id); });
    setBusyIds(new Set(busyRef.current));
  }, []);
  // Rows whose weights are being saved: their weight inputs wait for the answer, so a
  // further change is checked against, and a refused one goes back to, what was saved.
  const [weighing, setWeighing] = useState<ReadonlySet<number>>(() => new Set());
  const markWeighing = useCallback((id: number, on: boolean) => setWeighing((s) => {
    const n = new Set(s);
    if (on) n.add(id); else n.delete(id);
    return n;
  }), []);

  // Every save — a scanned box, a box taken off, weights, the transfer information — runs
  // one at a time in the order it was asked for (scans in scan order): each scan's check
  // counts the boxes saved before it, and the server gets the boxes in the list's order.
  // `saving` counts the saves waiting or running (pendingRef too, for the handlers).
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingRef = useRef(0);
  const [saving, setSaving] = useState(0);
  const enqueue = useCallback((task: () => Promise<void>) => {
    pendingRef.current++;
    setSaving((n) => n + 1);
    queueRef.current = queueRef.current
      .then(task)
      .catch(() => { /* a save shows its own failure; the next one still runs */ })
      .finally(() => { pendingRef.current--; setSaving((n) => n - 1); });
  }, []);
  // Done is waiting for the saves under way before it leaves.
  const [finishing, setFinishing] = useState(false);

  const [manualBox, setManualBox] = useState(EMPTY_MANUAL);
  const [scanInfo, setScanInfo] = useState<OutScan | null>(null);
  const [banner, setBannerState] = useState<{ type: "error" | "success"; text: string } | null>(null);
  // Failures shown so far: Done stays on the page when a save it waited for fails.
  const failuresRef = useRef(0);
  const setBanner = useCallback((b: { type: "error" | "success"; text: string } | null) => {
    if (b?.type === "error") failuresRef.current++;
    setBannerState(b);
  }, []);
  // A failed change to a box on the list / to the transfer information, shown by the list /
  // that card as well as in the banner above the form, which may be scrolled out of view.
  const [boxesNote, setBoxesNote] = useState<string | null>(null);
  const [transportNote, setTransportNote] = useState<string | null>(null);
  const [coldPopup, setColdPopup] = useState<string | null>(null);

  // ── Seed clock-derived defaults on the client (avoids the SSR hydration mismatch). ──
  // Deferred via setTimeout so the setState isn't synchronous in the effect body
  // (react-hooks/set-state-in-effect). A new transfer is dated today; the request keeps
  // its own date (set by the prefill below).
  useEffect(() => {
    const id = setTimeout(() => {
      const no = genTransferNo(), date = todayDMY();
      draftRef.current = { transferNo: no, transferDate: date };
      setTransferNo(no);
      setForm((f) => ({ ...f, transferDate: f.transferDate || date }));
    }, 0);
    return () => clearTimeout(id);
  }, []);

  // No unsaved-changes prompt: every box is saved when it is scanned. Only a save still
  // under way asks before the tab is closed or reloaded.
  useEffect(() => {
    if (!saving) return;
    const hold = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", hold);
    return () => window.removeEventListener("beforeunload", hold);
  }, [saving]);

  // Show the request's transfer as saved — its boxes are the list (and the dedup keys), its
  // transport the transfer information — or no transfer (an empty list). It can run while
  // saves are queued: the keys held by scans waiting to be saved stay, and a box already
  // on the list keeps its row id, which a queued removal or weight save names it by.
  const showTransfer = useCallback((t: TransferDetail | null) => {
    const listed = new Map(boxesRef.current.map((b) => [boxKey(b.boxId, b.transactionNo), b.id]));
    listed.forEach((_, k) => scannedKeysRef.current.delete(k));
    if (!t) {
      putTransfer(null); putBoxes([]);
      setForm((f) => ({ ...f, transferDate: draftRef.current.transferDate || f.transferDate }));
      return;
    }
    const rows = t.boxes
      .filter((b) => isRealBox({ boxId: b.box_id || "", transactionNo: b.transaction_no || "" }))
      .map((b, i): ListBox => {
        const boxId = b.box_id || "", tno = b.transaction_no || "", key = boxKey(boxId, tno);
        scannedKeysRef.current.add(key);
        const net = weightText(b.net_weight), gross = weightText(b.gross_weight);
        return {
          id: listed.get(key) ?? boxCounter.current++, boxNumber: b.box_number ?? i + 1, boxId, transactionNo: tno,
          article: b.article || "", lotNumber: b.lot_number || "", batchNumber: b.batch_number || "",
          netWeight: net, grossWeight: gross, savedNet: net, savedGross: gross,
        };
      });
    putBoxes(rows);
    putTransfer({ id: t.id, challanNo: t.challan_no, status: t.status, boxCount: rows.length });
    savedTransportRef.current = { vehicle_no: t.vehicle_no || "", driver_name: t.driver_name || "", approved_by: t.approved_by || "" };
    putTransport(transportForm(savedTransportRef.current));
    setForm((f) => ({ ...f, transferDate: t.stock_trf_date || f.transferDate }));
  }, [putBoxes, putTransfer, putTransport]);

  // ── Load the request, and the transfer it was sent on ──
  // A Transferred request is continued while its transfer is out (Dispatch / Partial and
  // no receipt started); otherwise the notice says why nothing can be scanned. `stale`
  // says the page no longer wants the answer. True when the request was shown.
  const load = useCallback(async (stale: () => boolean): Promise<boolean> => {
    try {
      const req = await TransferApi.getRequest(Number(requestId));
      const sent = req.status === REQUEST_STATUS.TRANSFERRED && req.transfer_id != null
        ? await TransferApi.getTransfer(req.transfer_id) : null;
      if (stale()) return false;
      const norm = (v?: string | null) => (!v || v === "N/A" ? "" : v);
      setForm((f) => ({
        ...f,
        requestNo: req.request_no || "",
        requestDate: req.request_date || "",
        fromWarehouse: norm(req.from_warehouse),
        toWarehouse: norm(req.to_warehouse),
        reasonDescription: req.reason_description || "",
      }));
      const arts: Article[] = req.lines.map((l, i) => ({
        uid: i,
        materialType: norm(l.material_type), itemCategory: norm(l.item_category),
        subCategory: norm(l.sub_category), itemDescription: norm(l.item_description),
        unitPackSize: l.unit_pack_size || "", uom: norm(l.uom),
        packSize: l.pack_size || "1", quantity: l.quantity || "1",
        netWeight: l.net_weight || "0", lotNumber: l.lot_number || "",
      }));
      setArticles(arts);
      // Named as the server's refusals name it: its request_no, else its id.
      const no = req.request_no || String(req.id);
      requestRef.current = { no, from: norm(req.from_warehouse), lines: matchLines(arts) };
      requestFailedRef.current = false;
      const open = sent && OPEN_STATUSES.has(sent.status) && !sent.grn_records?.length ? sent : null;
      showTransfer(open);
      setRequest(req);
      if (open) {
        setNotice(null);
        setBanner({ type: "success", text: `Request ${no} was sent on transfer ${open.challan_no} (${open.status}), which is still out: scan more of its boxes to add them. Each box is saved as soon as it is scanned.` });
      } else if (req.status === REQUEST_STATUS.APPROVED) {
        setNotice(null);
        setBanner({ type: "success", text: `Request ${no} loaded. Its route, items, quantities and reason are locked. Fill in the transfer information, then scan the boxes you send: each box is saved as soon as it is scanned.` });
      } else {
        // A request that can't be scanned gets its notice instead.
        setNotice(requestNotice(req, sent ? sent.challan_no : null));
        setBanner(null);
      }
      return true;
    } catch (e) {
      if (stale()) return false;
      requestFailedRef.current = true;
      setBanner({ type: "error", text: e instanceof Error ? e.message : "Failed to load request." });
      return false;
    } finally {
      if (!stale()) setRequestLoading(false);
    }
  }, [requestId, setBanner, showTransfer]);

  // Deferred past the synchronous effect body (react-hooks/set-state-in-effect), as the
  // transfer list does.
  useEffect(() => {
    if (!allowed || !requestId) return;
    let off = false;
    queueMicrotask(() => { if (!off) void load(() => off); });
    return () => { off = true; };
  }, [allowed, requestId, load]);

  const toggle = (uid: number) => setExpanded((s) => { const n = new Set(s); if (n.has(uid)) n.delete(uid); else n.add(uid); return n; });

  // ── Box ingestion: every accepted scan is saved ──
  // A scan refused before it is looked up or saved: shown in the result card by the entry
  // fields as well as the banner above the form, which may be scrolled out of view.
  const scanError = useCallback((value: string, msg: string) => {
    setBanner({ type: "error", text: msg });
    setScanInfo({ status: "err", value, error: msg });
  }, [setBanner]);

  // A scan before the request has loaded is refused here, not looked up: the lookup needs
  // the request's From site. Once the load has failed it says to reload instead of to wait.
  const requestNotLoaded = useCallback((value: string) => {
    scanError(value, requestFailedRef.current ? REQUEST_LOAD_FAILED : REQUEST_NOT_LOADED);
  }, [scanError]);

  // One scan. Refused on screen before the request has loaded, and — before the transfer
  // exists — with the transfer information incomplete. Then: dedup → lookup (with the
  // request's From) → the request's check (refuseNewBox, as the server applies it) → save
  // (scanBox). The lookup starts at once; the check and the save wait in the queue behind
  // the boxes scanned before it. A box joins the list only when its save succeeds; on a
  // refusal its dedup keys are released so it can be scanned again. `preKey` is the box's
  // key when the scan names it, `fallbackTno` the transaction no it names, `onSaved` what
  // follows a save.
  const scanAndSave = useCallback((value: string, preKey: string, fallbackTno: string,
    lookup: (from: string) => Promise<BoxLookupResult>, onSaved?: () => void) => {
    const req = requestRef.current;
    if (!req) { requestNotLoaded(value); return; }
    if (!transferRef.current && transportBlank(transportRef.current)) { scanError(value, TRANSPORT_MISSING); return; }
    // The keys this scan holds in the dedup set, released when it is refused (one the list
    // holds by then, the box saved meanwhile on another screen, stays).
    const held: string[] = [];
    const release = () => {
      const listed = new Set(boxesRef.current.map((x) => boxKey(x.boxId, x.transactionNo)));
      held.forEach((k) => { if (!listed.has(k)) scannedKeysRef.current.delete(k); });
    };
    const dup = (boxId: string, tno: string) => {
      setBanner({ type: "error", text: `Box ${boxId} / ${tno} already scanned.` });
      setScanInfo({ status: "dup", box_id: boxId, tno });
    };
    if (preKey) {
      if (scannedKeysRef.current.has(preKey)) { const [id, t] = preKey.split("|"); dup(id, t); return; }
      scannedKeysRef.current.add(preKey); held.push(preKey);
    }
    const found = lookup(req.from);
    found.catch(() => { /* answered in the queue below */ });
    enqueue(async () => {
      let b: LookupBox;
      try {
        b = (await found).box;
      } catch (e) {
        // The server's own text, e.g. a 409 "Box … is already on challan … (in transit)" or
        // "… was received at … on challan …; send it from …".
        release();
        scanError(value, failText(e, "Box not found."));
        return;
      }
      const boxId = (b.box_id || "").trim();
      const tno = (b.transaction_no || fallbackTno || "").trim();
      const key = boxKey(boxId, tno);
      if (key && !held.includes(key)) {
        if (scannedKeysRef.current.has(key)) { release(); dup(boxId, tno); return; }
        scannedKeysRef.current.add(key); held.push(key);
      }
      const article = b.item_description || b.article_description || "";
      const lot = b.lot_number || "";
      const label = labelName(b, article);
      const refusal = refuseNewBox(req.lines, boxesRef.current.map(matchBox), { boxId, article, lot }, req.no);
      if (refusal) {
        release();
        setBanner({ type: "error", text: refusal });
        setScanInfo({ status: "refused", box_id: boxId, article, lot, tno, reason: refusal, label });
        return;
      }
      // The transfer may have been cancelled since the scan: this box then starts a new one.
      if (!transferRef.current && transportBlank(transportRef.current)) { release(); scanError(value, TRANSPORT_MISSING); return; }
      setScanInfo({ status: "saving", box_id: boxId, article, lot, tno, label });
      const known = transferRef.current;
      const sentTransport = resolveTransport(transportRef.current);
      const id = boxCounter.current++;
      try {
        const res = await TransferApi.scanBox(Number(requestId), {
          header: {
            challan_no: draftRef.current.transferNo || null,
            stock_trf_date: draftRef.current.transferDate || null,
            ...sentTransport,
          },
          box: {
            box_number: typeof b.box_number === "number" ? b.box_number : id,
            box_id: boxId || null, article, lot_number: lot || null,
            batch_number: b.batch_number || null, transaction_no: tno || null,
            net_weight: (Number(b.net_weight) || 0).toFixed(3),
            gross_weight: (Number(b.gross_weight) || 0).toFixed(3),
          },
        });
        // The box as the transfer stores it.
        const s = res.box;
        const net = weightText(s.net_weight), gross = weightText(s.gross_weight);
        const row: ListBox = {
          id, boxNumber: s.box_number ?? id, boxId: s.box_id ?? boxId, transactionNo: s.transaction_no ?? tno,
          article: s.article ?? article, lotNumber: s.lot_number ?? lot, batchNumber: s.batch_number ?? "",
          netWeight: net, grossWeight: gross, savedNet: net, savedGross: gross,
        };
        const savedKey = boxKey(row.boxId, row.transactionNo);
        held.forEach((k) => { if (k !== savedKey) scannedKeysRef.current.delete(k); });
        if (savedKey) scannedKeysRef.current.add(savedKey);
        if (known ? known.id === res.transfer_id : res.created) {
          putBoxes([...boxesRef.current, row]);
          putTransfer({ id: res.transfer_id, challanNo: res.challan_no, status: res.status, boxCount: res.box_count });
          if (res.created) savedTransportRef.current = sentTransport;
          setBanner(null);
        } else {
          // Saved on a transfer this page did not know of (started on another screen, or an
          // earlier answer lost on the way): show that transfer as saved, this box included.
          await load(() => false);
        }
        setScanInfo({ status: "added", box_id: row.boxId, article: row.article, lot: row.lotNumber, net, tno: row.transactionNo, challan: res.challan_no, label: labelName(b, row.article) });
        onSaved?.();
      } catch (e) {
        // The server's refusal (409: the request doesn't take the box, it isn't at the From
        // site, it is already on the transfer, or the transfer has been received): not added.
        // Unreachable, the save may have gone through, so that reads as an error instead.
        release();
        const msg = failText(e, "Failed to save the box.");
        if (e instanceof TypeError) { scanError(value, msg); return; }
        setBanner({ type: "error", text: msg });
        setScanInfo({ status: "refused", box_id: boxId, article, lot, tno, reason: msg, label });
      }
    });
  }, [enqueue, load, putBoxes, putTransfer, requestId, requestNotLoaded, scanError, setBanner]);

  // Manual entry: by box ID when one is typed (a Material In box's number starts again in
  // each lot section of its PO, its box ID never repeats), else by box number; either with
  // its transaction no, trimmed. The fields clear once the box is saved, unless something
  // else has been typed meanwhile.
  const handleManualBoxFetch = () => {
    const typed = manualBox;
    const boxId = typed.boxId.trim(), tno = typed.transactionNo.trim();
    const clear = () => setManualBox((m) => (m.boxNumber === typed.boxNumber && m.boxId === typed.boxId
      && m.transactionNo === typed.transactionNo ? EMPTY_MANUAL : m));
    if (boxId) {
      if (!tno) { setBanner({ type: "error", text: "Enter the transaction no with the box ID." }); return; }
      scanAndSave(`${boxId} / ${tno}`, boxKey(boxId, tno), tno,
        (from) => TransferApi.boxLookupById(COMPANY, boxId, tno, from), clear);
      return;
    }
    const num = parseInt(typed.boxNumber, 10);
    if (!num || !tno) { setBanner({ type: "error", text: "Box number (or box ID) and transaction no are required." }); return; }
    if (boxesRef.current.some((x) => x.boxNumber === num && x.transactionNo.trim() === tno)) {
      setBanner({ type: "error", text: `Box #${num} of ${tno} is already in the list. If this is another box with that number (Material In numbers the boxes of each lot section from 1), enter its box ID instead.` }); return;
    }
    // Held by its number until the lookup names its box id.
    scanAndSave(`${num} / ${tno}`, boxKey(`#${num}`, tno), tno,
      (from) => TransferApi.boxLookupByNumber(COMPANY, num, tno, from), clear);
  };
  // Enter in any of the manual fields fetches the box.
  const fetchOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); handleManualBoxFetch(); }
  };

  const handleQRScan = useCallback((text: string) => {
    let parsed: { tx?: string; bi?: string } | null = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    if (!parsed || !parsed.tx || !parsed.bi) {
      scanError(text, "Unrecognised QR format (expected a box QR label).");
      return;
    }
    const tx = String(parsed.tx), bi = String(parsed.bi);
    scanAndSave(text, boxKey(bi, tx), tx, (from) => (tx.startsWith("BE-")
      ? TransferApi.bulkEntryBoxLookup(COMPANY, bi, tx, from)
      : TransferApi.boxLookupById(COMPANY, bi, tx, from)));
  }, [scanAndSave, scanError]);

  // ── Boxes on the transfer ──
  // The transfer was cancelled (its last box taken off): the page goes back to its fresh
  // state — no transfer, an empty list, a new transfer no — and reads the request again,
  // now back in Ready to Send. The transfer information stays as typed for the next one.
  const transferCancelled = async (t: OpenTransfer, requestStatus: string) => {
    showTransfer(null);
    const no = genTransferNo();
    draftRef.current = { ...draftRef.current, transferNo: no };
    setTransferNo(no);
    setRequest((r) => (r ? { ...r, status: requestStatus } : r));
    setScanInfo(null); setBoxesNote(null); setTransportNote(null);
    const reqNo = requestRef.current?.no ?? "";
    if (await load(() => false)) {
      setBanner({ type: "success", text: `Transfer ${t.challanNo} was cancelled and request ${reqNo} is back in Ready to Send. Scan a box to start a new transfer.` });
    }
  };

  // ✕ (one box) and Clear All (`all`) take boxes off the transfer. Taking off its last box
  // cancels the transfer (the server deletes it and puts the request back to Approved), so
  // that asks first, as Clear All always does. A box stays on the list until the server
  // has taken it off.
  const removeBoxes = (rows: ListBox[], all: boolean) => {
    const t = transferRef.current;
    if (!t || !rows.length) return;
    if (!all && rows.some((r) => busyRef.current.has(r.id))) return;
    const left = boxesRef.current.filter((b) => !busyRef.current.has(b.id)).length;
    const reqNo = requestRef.current?.no ?? form.requestNo;
    if ((all || left <= rows.length) && !window.confirm(
      `Removing the last box cancels transfer ${t.challanNo} and puts request ${reqNo} back in Ready to Send.`)) return;
    const ids = rows.map((r) => r.id);
    setBusy(ids, true);
    enqueue(async () => {
      try {
        const cur = transferRef.current;
        if (!cur) return; // cancelled meanwhile
        const res = await TransferApi.removeTransferBoxes(cur.id, all
          ? { all: true }
          : { boxes: rows.map((r) => ({ box_id: r.boxId, transaction_no: r.transactionNo })) });
        if (res.cancelled) { await transferCancelled(cur, res.request_status || REQUEST_STATUS.APPROVED); return; }
        const gone = new Set(ids);
        boxesRef.current.forEach((b) => { if (gone.has(b.id)) scannedKeysRef.current.delete(boxKey(b.boxId, b.transactionNo)); });
        putBoxes(boxesRef.current.filter((b) => !gone.has(b.id)));
        putTransfer({ ...cur, status: res.status, boxCount: res.box_count });
        setBoxesNote(null);
      } catch (e) {
        const msg = failText(e, "Failed to remove the box.");
        setBanner({ type: "error", text: msg }); setBoxesNote(msg);
      } finally {
        setBusy(ids, false);
      }
    });
  };

  const typeWeight = (id: number, patch: Partial<Pick<ListBox, "netWeight" | "grossWeight">>) =>
    putBoxes(boxesRef.current.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  // A box's weights save when focus leaves its pair of inputs with a change (moving from
  // net to gross doesn't save, so a net raised above the old gross can have its gross
  // raised too). The edit form's rule is checked first: net may not exceed gross (a box
  // whose gross is unknown is saved as 0, so only a gross above 0 counts). A refused or
  // failed save puts the saved weights back. The box's weight inputs wait for the answer.
  const saveWeights = (id: number) => {
    const b = boxesRef.current.find((x) => x.id === id);
    if (!b || !transferRef.current) return;
    const net = kg(b.netWeight), gross = kg(b.grossWeight);
    const putSaved = () => putBoxes(boxesRef.current.map((x) => (x.id === id ? { ...x, netWeight: x.savedNet, grossWeight: x.savedGross } : x)));
    if (Math.abs(net - kg(b.savedNet)) < 1e-9 && Math.abs(gross - kg(b.savedGross)) < 1e-9) {
      if (b.netWeight !== b.savedNet || b.grossWeight !== b.savedGross) putSaved(); // retyped, not changed
      return;
    }
    const fail = (msg: string) => { putSaved(); setBanner({ type: "error", text: msg }); setBoxesNote(msg); };
    const name = b.boxId || b.boxNumber;
    if (net < 0 || gross < 0) { fail(`Box ${name}: a weight can't be negative.`); return; }
    if (gross > 0 && net > gross + 1e-6) { fail(`Box ${name}: net weight exceeds gross`); return; }
    markWeighing(id, true);
    enqueue(async () => {
      try {
        const cur = transferRef.current;
        if (!cur || !boxesRef.current.some((x) => x.id === id)) return; // cancelled or taken off meanwhile
        const s = await TransferApi.updateTransferBoxWeights(cur.id, {
          box_id: b.boxId, transaction_no: b.transactionNo,
          net_weight: Number(net.toFixed(3)), gross_weight: Number(gross.toFixed(3)),
        });
        const sn = weightText(s.net_weight ?? net), sg = weightText(s.gross_weight ?? gross);
        putBoxes(boxesRef.current.map((x) => (x.id === id
          ? { ...x, savedNet: sn, savedGross: sg, netWeight: sn, grossWeight: sg } : x)));
        setBoxesNote(null);
      } catch (e) {
        fail(failText(e, "Failed to save the weights."));
      } finally {
        markWeighing(id, false);
      }
    });
  };

  // ── Transfer information ──
  // Before the transfer exists it is only held here: the scan that creates the transfer
  // sends it (a change made while that scan is being saved waits behind it, and is then
  // saved on the transfer it created). After, a change saves at once — a list choice when
  // picked, typed text when its field is left — sending the form's three values, so a
  // transfer saved without one can be completed here. A blank value is not sent: the
  // message shows and the saved value comes back, as it does when the server refuses the
  // change. A change while another of the three is blank is kept, and saved with it once
  // that one is filled in.
  const restoreTransport = (fields: (keyof TransportBody)[]) => {
    const s = transportForm(savedTransportRef.current);
    let next = transportRef.current;
    for (const f of fields) {
      next = f === "vehicle_no" ? { ...next, vehicle: s.vehicle, vehicleOther: s.vehicleOther }
        : f === "driver_name" ? { ...next, driver: s.driver, driverOther: s.driverOther }
          : { ...next, approval: s.approval };
    }
    putTransport(next);
  };
  const transportFailed = (fields: (keyof TransportBody)[], msg: string) => {
    restoreTransport(fields); setBanner({ type: "error", text: msg }); setTransportNote(msg);
  };
  // Whether the form's change to `field` is to be saved: not when it is unchanged, blank
  // (the saved value comes back) or another of the three is blank (it stays as typed).
  const transportReady = (field: keyof TransportBody): boolean => {
    const body = resolveTransport(transportRef.current);
    if (!transferRef.current || body[field] === savedTransportRef.current[field]) return false;
    if (!body[field]) { transportFailed([field], `${TRANSPORT_LABEL[field]} can't be blank, so the saved one is kept.`); return false; }
    const blank = TRANSPORT_FIELDS.filter((f) => !body[f]);
    if (blank.length) {
      const msg = `Fill in ${fieldNames(blank)} too: the transfer information is saved once all three are filled in.`;
      setBanner({ type: "error", text: msg }); setTransportNote(msg);
      return false;
    }
    return true;
  };
  // The queued save: the form as it is by then, so a later change goes too, and a field
  // blank by then (its "Other" text still being typed) goes as saved, left to its own save.
  const sendTransport = async () => {
    const cur = transferRef.current, typed = resolveTransport(transportRef.current), saved = savedTransportRef.current;
    const body: TransportBody = {
      vehicle_no: typed.vehicle_no || saved.vehicle_no,
      driver_name: typed.driver_name || saved.driver_name,
      approved_by: typed.approved_by || saved.approved_by,
    };
    const changed = TRANSPORT_FIELDS.filter((f) => body[f] !== saved[f]);
    if (!cur || !changed.length || TRANSPORT_FIELDS.some((f) => !body[f])) return;
    try {
      const r = await TransferApi.updateTransferTransport(cur.id, body);
      savedTransportRef.current = { vehicle_no: r.vehicle_no, driver_name: r.driver_name, approved_by: r.approved_by };
      setTransportNote(null);
    } catch (e) {
      transportFailed(changed, failText(e, "Failed to save the transfer information."));
    }
  };
  const saveTransport = (field: keyof TransportBody) => {
    if (transferRef.current) { if (transportReady(field)) enqueue(sendTransport); return; }
    // No transfer yet: held for the scan that creates it, unless a scan is being saved,
    // which sent the values from before this change.
    if (pendingRef.current) enqueue(async () => { if (transportReady(field)) await sendTransport(); });
  };
  // A vehicle / driver picked from its list. "Other" saves its text when it has some, else
  // its text box takes the cursor: leaving that box empty keeps the saved one.
  const pickTransport = (field: "vehicle_no" | "driver_name", sel: string) => {
    const cur = transportRef.current;
    putTransport(field === "vehicle_no" ? { ...cur, vehicle: sel } : { ...cur, driver: sel });
    const other = field === "vehicle_no" ? cur.vehicleOther : cur.driverOther;
    if (sel === "Other" && !other.trim()) {
      const box = field === "vehicle_no" ? vehicleOtherRef : driverOtherRef;
      setTimeout(() => box.current?.focus(), 0);
      return;
    }
    saveTransport(field);
  };

  // ── Derived totals ──
  const totals = useMemo(() => {
    const net = scannedBoxes.reduce((s, b) => s + kg(b.netWeight), 0);
    const gross = scannedBoxes.reduce((s, b) => s + kg(b.grossWeight), 0);
    return { count: scannedBoxes.length, net, gross };
  }, [scannedBoxes]);
  const requestedNet = useMemo(
    () => articles.reduce((s, a) => s + (parseFloat(a.netWeight) || 0), 0), [articles]);
  // The boxes the request asks for: the transfer is Dispatch once it holds this many.
  const ordered = useMemo(() => articles.reduce((s, a) => s + lineQty(a.quantity), 0), [articles]);
  // Items from request: ordered vs scanned per request line, counted from the boxes in the
  // list, so taking a box off takes it off the count again. Boxes are matched by the same
  // rule as the scan-time refusal and the server (lib/transferBoxMatch): a line with a lot
  // takes boxes of its article AND lot first, then a line without one takes boxes of its
  // article with any lot; each box counts for one line, up to the line's ordered qty. A box
  // no line takes is never added, so every box in the list is counted on a line here.
  const tracker = useMemo(() => {
    const { taken } = matchBoxes(matchLines(articles), scannedBoxes.map(matchBox));
    return articles.map((a, i) => ({
      itemDescription: a.itemDescription, lotNumber: a.lotNumber.trim(),
      quantity: lineQty(a.quantity), scannedCount: taken[i],
    }));
  }, [articles, scannedBoxes]);

  // The route is the request's own site strings, so judge them by the site table: any
  // spelling of a cold store ("savla d39", "ESKIMO", "Savla Bond") is cold.
  const isColdInvolved = isColdSite(form.fromWarehouse) || isColdSite(form.toWarehouse);

  // Done: back to the list. Every box is already saved. A save still under way — leaving a
  // weight or a typed field for Done saves it — is waited for, and when one fails the page
  // stays to show why. A cold route first shows the transfer's cold summary (its OK goes
  // back).
  const done = async () => {
    if (pendingRef.current) {
      const failures = failuresRef.current;
      setFinishing(true);
      while (pendingRef.current) await queueRef.current;
      setFinishing(false);
      if (failuresRef.current !== failures) return;
    }
    const t = transferRef.current;
    if (isColdInvolved && t) {
      setColdPopup([
        `Transfer ${t.challanNo} (${t.status})`,
        `From ${form.fromWarehouse} → ${form.toWarehouse}`,
        `Vehicle ${savedTransportRef.current.vehicle_no}`,
        "", ...boxesRef.current.map((b) => `${b.article} — lot ${b.lotNumber || "—"}`),
      ].join("\n"));
      return;
    }
    router.push("/modules/transfer");
  };
  // ← Transfer: only a save still under way asks first.
  const leave = () => {
    if (saving && !window.confirm("A box is still being saved. Leave now and you won't see whether it went through?")) return;
    router.push("/modules/transfer");
  };

  // No `if (!allowed) return null` gate: useRequireAuth returns true on the server but
  // false on the client's first render, so gating the render on it causes a hydration
  // mismatch. Effects are gated on `allowed`; the hook redirects unauthenticated users.

  // Every field here is the request's, so without one there is nothing to send.
  if (!requestId) {
    return (
      <TransferChrome title="Transfer OUT">
        <button onClick={() => router.push("/modules/transfer")}
          className="text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] mb-3">← Transfer</button>
        <div className="rounded-md p-3 text-[13px] border bg-amber-50 border-amber-200 text-amber-800">
          Every transfer starts from a request. Open this from an approved request: Requests → Scan &amp; send.
        </div>
      </TransferChrome>
    );
  }

  const inputCls = "w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md";

  return (
    <TransferChrome title="Transfer OUT">
      <button onClick={leave}
        className="text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] mb-3">← Transfer</button>

      <div className="flex flex-wrap items-end justify-between gap-2 mb-4">
        <h1 className="text-[20px] font-semibold text-[var(--text-primary)]">Transfer OUT</h1>
        <span className="flex flex-wrap items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
          Transfer No <span className="font-mono text-[var(--text-primary)]">{transfer?.challanNo || transferNo}</span>
          {transfer && <><StatusChip status={transfer.status} /><span>{transfer.boxCount} of {ordered} boxes saved</span></>}
        </span>
      </div>

      {requestLoading && <div className="mb-4 rounded-md p-3 text-[13px] bg-[var(--background)] border border-[var(--aws-border)] text-[var(--text-secondary)]">Loading request…</div>}
      {notice && (
        <div className={`mb-4 rounded-md p-3 text-[13px] border ${notice.tone === "stop" ? "bg-rose-50 border-rose-200 text-rose-700" : "bg-amber-50 border-amber-200 text-amber-800"}`}>
          {notice.text}
        </div>
      )}
      {banner && (
        <div className={`mb-4 rounded-md p-3 text-[13px] border ${banner.type === "error" ? "bg-rose-50 border-rose-200 text-rose-700" : "bg-emerald-50 border-emerald-200 text-emerald-700"}`}>
          {banner.text}
        </div>
      )}

      <div className="space-y-4 max-w-4xl">
        {/* Request / header card — the request's own values, read-only */}
        <Card title="Request details">
          <p className="text-[12px] text-[var(--text-secondary)] mb-3">
            From the request: its route, items, quantities and reason are locked once the inventory manager has approved it. Only the boxes you send are entered here, and each is saved as soon as it is scanned.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <ReadOnlyField label="Request No" value={form.requestNo} mono />
            <ReadOnlyField label="Request Date" value={form.requestDate} />
            <ReadOnlyField label="From (Supplying)" value={getDisplayWarehouseName(form.fromWarehouse)} />
            <ReadOnlyField label="To (Requesting)" value={getDisplayWarehouseName(form.toWarehouse)} />
            <ReadOnlyField label="Transfer Date" value={form.transferDate} />
            <div />
            <div className="sm:col-span-2">
              <ReadOnlyField label="Reason Description" value={form.reasonDescription} multiline />
            </div>
          </div>
        </Card>

        {/* Transport — needed before the first box, which creates the transfer with it */}
        <Card title="Transfer information">
          <p className="text-[12px] text-[var(--text-secondary)] mb-3">
            {transfer
              ? <>Saved on transfer <span className="font-mono">{transfer.challanNo}</span>. A change is saved straight away: a choice from a list when you pick it, typed text when you leave the field.</>
              : "Fill these in before scanning: the first box scanned creates the transfer with them."}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Vehicle Number" required>
              <select value={transport.vehicle} onChange={(e) => pickTransport("vehicle_no", e.target.value)}
                className={`${inputCls} bg-white`}>
                <option value="">Select…</option>{VEHICLES.map((v) => <option key={v} value={v}>{v}</option>)}<option value="Other">Other</option>
              </select>
              {transport.vehicle === "Other" && <input ref={vehicleOtherRef} value={transport.vehicleOther}
                onChange={(e) => putTransport({ ...transportRef.current, vehicleOther: e.target.value })}
                onBlur={() => saveTransport("vehicle_no")}
                placeholder="Enter vehicle no" className={`mt-1.5 ${inputCls}`} />}
            </Field>
            <Field label="Driver Name" required>
              <select value={transport.driver} onChange={(e) => pickTransport("driver_name", e.target.value)}
                className={`${inputCls} bg-white`}>
                <option value="">Select…</option>{DRIVERS.map((d) => <option key={d} value={d}>{d}</option>)}<option value="Other">Other</option>
              </select>
              {transport.driver === "Other" && <input ref={driverOtherRef} value={transport.driverOther}
                onChange={(e) => putTransport({ ...transportRef.current, driverOther: e.target.value })}
                onBlur={() => saveTransport("driver_name")}
                placeholder="Enter driver name" className={`mt-1.5 ${inputCls}`} />}
            </Field>
            <Field label="Approval Authority" required>
              <input value={transport.approval}
                onChange={(e) => putTransport({ ...transportRef.current, approval: e.target.value })}
                onBlur={() => saveTransport("approved_by")}
                className={inputCls} />
            </Field>
          </div>
          {transportNote && <p className="mt-2 text-[12px] text-rose-700">{transportNote}</p>}
        </Card>

        {/* Box ingestion — each accepted box is saved on the transfer at once */}
        <Card title="Scan / add boxes">
          {request && !canSend ? (
            <p className="text-[12px] text-[var(--text-secondary)] py-2">No boxes can be scanned for this request (see the notice above).</p>
          ) : (
            <div className="space-y-3">
              <p className="text-[12px] text-[var(--text-secondary)]">
                {transfer
                  ? <>Every box you scan is saved on transfer <span className="font-mono">{transfer.challanNo}</span> straight away.</>
                  : "Every box you scan is saved straight away: the first one creates the transfer and marks the request Transferred."}
              </p>
              {/* Inline always-on scanner — same card as the job-card RM tab. */}
              <QrScanBox title="Scan box QR"
                idleHint="Start the camera and centre a box QR to save it on the transfer."
                onResult={handleQRScan} />
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
          )}
        </Card>

        {/* Articles — the request's lines, locked (no add / remove / edit) */}
        <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">Articles ({articles.length})</h2>
        {articles.map((a, idx) => (
          <ArticleSection key={a.uid} index={idx} data={a} open={expanded.has(a.uid)} onToggle={() => toggle(a.uid)} />
        ))}

        {/* Items from request */}
        {tracker.length > 0 && (
          <Card title="Items from request">
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
                  <th className="py-1.5 pr-3">Item</th><th className="py-1.5 pr-3">Lot</th><th className="py-1.5 pr-3 text-right">Ordered</th>
                  <th className="py-1.5 pr-3 text-right">Scanned</th><th className="py-1.5 text-right">Pending</th></tr></thead>
                <tbody>
                  {tracker.map((it, i) => (
                    <tr key={i} className="border-b border-[var(--aws-border)]/40">
                      <td className="py-1.5 pr-3 text-[var(--text-primary)]">{it.itemDescription}</td>
                      <td className="py-1.5 pr-3">{it.lotNumber || "Any"}</td>
                      <td className="py-1.5 pr-3 text-right">{it.quantity}</td>
                      <td className="py-1.5 pr-3 text-right">{it.scannedCount}</td>
                      <td className={`py-1.5 text-right ${Math.max(it.quantity - it.scannedCount, 0) > 0 ? "text-amber-600" : "text-emerald-600"}`}>{Math.max(it.quantity - it.scannedCount, 0)}</td>
                    </tr>))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[12px] text-[var(--text-secondary)]">Only boxes the request asks for can be scanned: a box of another item or lot, or one more than a line&apos;s quantity, is refused and not added. Only scanned boxes are sent: the transfer stays Partial while any are pending.</p>
          </Card>
        )}

        {/* Boxes on the transfer, as saved */}
        <Card title={`Scanned boxes (${totals.count})`} action={scannedBoxes.length && transfer
          ? <button type="button" onClick={() => removeBoxes(boxesRef.current, true)} className="text-[12px] text-rose-600 hover:underline">Clear All</button>
          : undefined}>
          {scannedBoxes.length === 0 ? (
            <p className="text-[12px] text-[var(--text-secondary)] py-2">No boxes yet — scan a box QR or fetch one by box number or box ID.</p>
          ) : (
            <>
              <p className="text-[12px] text-[var(--text-secondary)] mb-2">
                Each box here is saved on the transfer. ✕ takes a box off it (taking off the last one cancels the transfer); a changed weight is saved when you leave the box&apos;s weights.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
                    <th className="py-1.5 pr-2">#</th><th className="py-1.5 pr-2">Box ID</th><th className="py-1.5 pr-2">Txn</th>
                    <th className="py-1.5 pr-2">Article</th><th className="py-1.5 pr-2">Lot</th>
                    <th className="py-1.5 pr-2 text-right">Net</th><th className="py-1.5 pr-2 text-right">Gross</th><th /></tr></thead>
                  <tbody>{scannedBoxes.map((b) => {
                    const busy = busyIds.has(b.id);
                    const weightInput = (field: "netWeight" | "grossWeight") => (
                      <input value={b[field]} type="number" step="any" data-weights={b.id} disabled={busy || weighing.has(b.id)}
                        onWheel={(e) => e.currentTarget.blur()}
                        onChange={(e) => typeWeight(b.id, { [field]: e.target.value })}
                        onBlur={(e) => { if (!samePair(e.relatedTarget, b.id)) saveWeights(b.id); }}
                        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                        className="w-20 px-1.5 py-1 text-[12px] text-right border border-[var(--aws-border)] rounded" />
                    );
                    return (
                      <tr key={b.id} className={`border-b border-[var(--aws-border)]/40 hover:bg-[var(--background)] ${busy ? "opacity-50" : ""}`}>
                        <td className="py-1 pr-2">{b.boxNumber}</td>
                        <td className="py-1 pr-2 font-mono">{b.boxId || "—"}</td>
                        <td className="py-1 pr-2 font-mono">{b.transactionNo}</td>
                        <td className="py-1 pr-2 max-w-[180px] truncate" title={b.article}>{b.article}</td>
                        <td className="py-1 pr-2">{b.lotNumber || "—"}</td>
                        <td className="py-1 pr-2 text-right">{weightInput("netWeight")}</td>
                        <td className="py-1 pr-2 text-right">{weightInput("grossWeight")}</td>
                        <td className="py-1 text-right"><button type="button" disabled={busy} onClick={() => removeBoxes([b], false)}
                          title="Take this box off the transfer" className="text-rose-600 hover:underline disabled:opacity-50">✕</button></td>
                      </tr>
                    );
                  })}</tbody>
                  <tfoot><tr className="font-medium text-[var(--text-primary)]">
                    <td className="py-1.5" colSpan={5}>Totals</td>
                    <td className="py-1.5 pr-2 text-right">{totals.net.toFixed(3)}</td>
                    <td className="py-1.5 pr-2 text-right">{totals.gross.toFixed(3)}</td><td /></tr></tfoot>
                </table>
              </div>
            </>
          )}
          {boxesNote && <p className="mt-2 text-[12px] text-rose-700">{boxesNote}</p>}
        </Card>

        {/* Weight comparison */}
        {articles.length > 0 && (
          <Card title="Weight comparison">
            <div className="flex flex-wrap gap-6 text-[13px]">
              <div><span className="text-[var(--text-secondary)]">Requested net: </span><span className="font-medium">{requestedNet.toFixed(3)} kg</span></div>
              <div><span className="text-[var(--text-secondary)]">Actual (scanned) net: </span><span className="font-medium">{totals.net.toFixed(3)} kg</span></div>
              <div><span className="text-[var(--text-secondary)]">Δ: </span><span className={`font-medium ${Math.abs(requestedNet - totals.net) > 0.001 ? "text-amber-600" : "text-emerald-600"}`}>{(totals.net - requestedNet).toFixed(3)} kg</span></div>
            </div>
          </Card>
        )}

        {/* Done — nothing is left to submit: every box was saved when it was scanned */}
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-[12px] text-[var(--text-secondary)]">
              {transfer
                ? <>Transfer <span className="font-mono text-[var(--text-primary)]">{transfer.challanNo}</span> is <StatusChip status={transfer.status} /> with {transfer.boxCount} of {ordered} boxes saved. It is Dispatch once all the boxes the request asks for are scanned, Partial until then.</>
                : "Every scanned box is saved straight away, so there is nothing to submit: the first box creates the transfer."}
              {saving > 0 && <span className="ml-1 text-sky-700">Saving…</span>}
            </span>
            <button type="button" onClick={() => void done()} disabled={finishing}
              title={saving > 0 ? "Goes back once the save has finished." : undefined}
              className="px-4 py-1.5 text-[13px] rounded-md bg-[var(--aws-navy)] text-white hover:opacity-90 disabled:opacity-50">
              {saving > 0 ? "Saving…" : "Done"}
            </button>
          </div>
        </Card>
      </div>

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

// A transfer's status as the transfer list shows it: Dispatch, or Partial while it holds
// fewer boxes than its request asks for.
function StatusChip({ status }: { status: string }) {
  const tone = status === "Partial" ? "bg-orange-100 text-orange-800" : "bg-sky-100 text-sky-800";
  return <span className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-medium ${tone}`}>{status}</span>;
}

// ── Article section: one request line, read-only (locked once the request is approved) ──
function ArticleSection({ index, data, open, onToggle }: {
  index: number; data: Article; open: boolean; onToggle: () => void;
}) {
  return (
    <section className="bg-white border border-[var(--aws-border)] rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 cursor-pointer hover:bg-[var(--background)]" onClick={onToggle}>
        <span className="inline-block w-4 text-[var(--text-secondary)]">{open ? "▾" : "▸"}</span>
        <span className="text-[12px] font-semibold text-[var(--text-primary)] shrink-0">Article {index + 1}</span>
        <span className="text-[12px] text-[var(--text-secondary)] truncate flex-1">
          · {data.itemDescription || "—"} · {data.materialType || "—"} · {data.quantity || "0"} {data.uom} · {data.netWeight} kg{data.lotNumber ? ` · lot ${data.lotNumber}` : ""}
        </span>
      </div>
      {open && (
        <div className="px-4 pb-4 pt-1 border-t border-[var(--aws-border)]">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
            <ReadOnlyField label="Material Type" value={data.materialType} />
            <ReadOnlyField label="Category" value={data.itemCategory} />
            <ReadOnlyField label="Sub Category" value={data.subCategory} />
            <ReadOnlyField label="Item Description" value={data.itemDescription} />
            <ReadOnlyField label="Unit Pack Size / Count" value={data.unitPackSize} />
            <ReadOnlyField label="UOM" value={data.uom} />
            <ReadOnlyField label="Case Pack / Box Wt." value={data.packSize} />
            <ReadOnlyField label="Quantity (Box/Bags)" value={data.quantity} />
            <ReadOnlyField label="Net Weight (Kg)" value={data.netWeight} />
            <ReadOnlyField label="Lot Number" value={data.lotNumber} mono />
          </div>
        </div>
      )}
    </section>
  );
}
