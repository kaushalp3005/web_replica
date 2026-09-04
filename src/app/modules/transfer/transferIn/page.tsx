"use client";

// Transfer In (Receive / GRN) — UI replicated from the reference page
// deploy/frontend/app/[company]/transfer/transferIn/page.tsx (the "Article Entries"
// view: Find Transfer → route → Box & Article Acknowledgement → Start Camera Scan →
// Article Entries table). Adapted to the rebuild's Tailwind theme (the reference's
// shadcn/ui + lucide + sonner + qrcode stack is not present here).
//
// "Entries" unify the two source shapes: when the transfer carries scanned boxes,
// each box is one entry; otherwise each line is expanded into `qty` entries (one per
// box) with a synthetic LINE-<lineId>-<n> box_id so per-entry acknowledge still works.
//
// ───────────────────────── FUNCTION BLOCKS ─────────────────────────
// WIRED:  doSearch · ensurePending · onAck/onAckAll/onUnack · openIssue/submitIssue ·
//         onConfirm(finalize) · handleReopen · handleCloseWithShortage · handleEditReceipt ·
//         onScanDetected (camera QR → match+acknowledge, else /production/scan-identify —
//         built to mirror the job-card RM tab _RawMaterialTab.tsx scan pattern) ·
//         handleGenerateQRs        ref:1369–1394   (TR- txn + epoch box-id minting) ·
//         handlePrintQR            ref:1214–1366   (acknowledge-then-print, one label) ·
//         handlePrintRange         ref:1396–1450   (per-article reprint, no acknowledge) ·
//         handleBulkPrintQR        ref:1526–1700   (range batch-acknowledge + one sheet).
//         Labels render through ../_labelPrint (shared 4"×2" renderer).
// STBR reconciliation              ref:2839–2871  — WIRED (backend built 2026-08-19).
//   acknowledge re-points the parked pending_transfer_stock row at the sticker that
//   actually arrived, so a relabelled carton still posts at finalize. Statuses seen
//   here: "matched" (no change), "copied" (relabelled), "noop" (nothing to reconcile).
//   Rejections arrive as HTTP, not as a status — 409 duplicate, 422 conflict.
//   Series auto-propagation stays disabled server-side, so propagated_count is 0.
// ────────────────────────────────────────────────────────────────────

import { Fragment, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useRequireAuth, useMe } from "@/lib/user";
import { TransferChrome } from "../_chrome";
import { TransferApi, type TransferDetail, type AcknowledgeBoxInput, type BoxReconciliation,
  type BulkTransferInBox, type PendingBoxRow, type TransferInBox } from "@/lib/transfer";
import { getDisplayWarehouseName } from "@/lib/transferBuildSummary";
import { QrScanBox } from "@/components/QrScanBox";
import { apiFetch, readApiErrorMessage } from "@/lib/auth";
import { friendlyApiError } from "@/lib/apiErrors";
import { printTransferLabels, type TransferLabelBox } from "../_labelPrint";

function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}
function str(v: unknown): string { return v == null ? "" : String(v); }
function round3(n: number): number { return Math.round(n * 1000) / 1000; }
// A figure that was actually RECORDED, or null. `x || fallback` is the wrong test
// wherever zero is a legal reading: a box received empty stores 0 (9 GRN rows carry
// net 0.00, and GRN 402 records five at 0.00 with remarks "NO STOCK RECEIVED"), and
// a truthiness fallback silently swapped a different quantity back in for it.
function finiteOrNull(v: unknown): number | null {
  if (v == null || String(v).trim() === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

// Entity printed on the label. Matches the `COMPANY` hint the sibling transfer pages use
// (transferform / innercoldtransfer / directtransferform) — lookups search both cfpl+cdpl.
const LABEL_ENTITY = "CFPL";

// Mirror server_replica/app/modules/transfer/permissions.py. digamber.sawant@
// stands behind b.hrithik@ on both — the pairing every route in the reference
// backend already has; hrithik first as the primary.
const ACK_EMAILS = new Set(["yash@candorfoods.in", "b.hrithik@candorfoods.in", "sunil.jasoria@candorfoods.in",
  "digamber.sawant@candorfoods.in"]);
const COLD_SITES = new Set(["cold storage", "rishi", "savla d-39", "savla d-514", "supreme", "eskimo"]);
const REOPEN_EMAILS = new Set(["b.hrithik@candorfoods.in", "digamber.sawant@candorfoods.in"]);

type IssueData = { net_weight: string; gross_weight: string; qty: string; remarks: string };
const EMPTY_ISSUE: IssueData = { net_weight: "", gross_weight: "", qty: "", remarks: "" };

// One receivable unit. From a scanned box, or one expanded unit of a line.
// `extra` marks a box the GRN holds that the challan never declared — a receipt
// the row list would otherwise not show at all.
type Entry = {
  sr: number; key: string; box_id: string; out_box_id: number | null; synthetic: boolean;
  article: string; transaction_no: string; case_pack: string;
  net_weight: number; gross_weight: number; lot_number: string; batch_number: string;
  extra?: boolean;
};

// Articles are compared loosely: buildEntries writes "—" for a line with no
// description, while a saved box carries "". They are the same bucket.
// The subset of a saved GRN box the row list needs.
// `is_matched` / `issue` are here because a REPRINT needs them. Without them a
// label reprinted after the GRN closed silently lost its red ISSUE tag and Case
// Pack line — the weights were right, so nothing looked broken; the carton just
// stopped being marked as disputed.
type ReceivedBox = Pick<TransferInBox,
  "box_id" | "article" | "transaction_no" | "lot_number" | "batch_number" |
  "net_weight" | "gross_weight" | "is_matched" | "issue">;

// Every STBR status that means "the parked row was re-pointed at a different
// sticker". `copied` is what this backend emits — its park is non-destructive, so a
// relabel never moves source stock and never produces the `overridden` the
// source-mutating reference used. The older names stay listed so historical rows
// still count. Module scope: a Set rebuilt per render would break the memo below.
const RELABEL_STATUSES = new Set([
  "copied", "overridden", "overridden_no_source", "fungible_swap",
]);

function artKey(s: string | null | undefined): string {
  const v = (s || "").trim().toLowerCase();
  return v === "—" ? "" : v;
}

// Fold the GRN's SAVED boxes into the challan's expected rows.
//
// Without this the two never meet. buildEntries gives a quantity-only line a
// synthetic `LINE-<line>-<n>` id; the real ids are minted client-side and — per
// handleGenerateQRs — live in component state only, so Resume comes back with
// `acked` full of persisted ids and `entries` full of synthetic ones. Nothing
// matches, and the per-article chip reads 0/N however many boxes were received.
//
// Each saved box claims the first free placeholder of its article and hands over
// its real box id, transaction and weights. A box with no placeholder left is an
// over-receipt: appended, flagged, and visible rather than merely counted.
function mergeReceived(list: Entry[], received: ReceivedBox[]): Entry[] {
  if (!received.length) return list;
  const byBoxId = new Map<string, Entry>();
  for (const e of list) if (e.box_id) byBoxId.set(e.box_id, e);
  const free = new Map<string, Entry[]>();
  for (const e of list) {
    if (!e.synthetic) continue;
    const k = artKey(e.article);
    const a = free.get(k); if (a) a.push(e); else free.set(k, [e]);
  }
  const patch = new Map<string, Entry>();
  const extras: Entry[] = [];
  for (const b of received) {
    const bid = b.box_id || "";
    if (!bid) continue;
    // A box the row list ALREADY carries. Its entry still holds the CHALLAN's
    // weights, so a figure the receipt recorded - a bulk-print gross of net + empty
    // carton, or a re-weigh - never reached the cells or the weight tiles, and the
    // screen reported the dispatched figure for the life of the receipt.
    const hit = byBoxId.get(bid);
    if (hit) {
      const hitNet = finiteOrNull(b.net_weight);
      const hitGross = finiteOrNull(b.gross_weight);
      if (hitNet != null || hitGross != null) {
        patch.set(hit.key, {
          ...hit,
          net_weight: hitNet ?? hit.net_weight,
          gross_weight: hitGross ?? hit.gross_weight,
        });
      }
      continue;
    }
    const slot = free.get(artKey(b.article))?.shift();
    const common = {
      box_id: bid, transaction_no: b.transaction_no || "", synthetic: false,
      lot_number: b.lot_number || slot?.lot_number || "",
      batch_number: b.batch_number || slot?.batch_number || "",
    };
    if (slot) {
      patch.set(slot.key, {
        ...slot, ...common,
        // Present-and-finite, not truthy: `num(x) || slot.x` cannot tell "the receipt
        // recorded no weight" from "the receipt recorded zero", so a box received
        // empty printed the challan's per-unit weight instead of the 0 the GRN holds.
        net_weight: finiteOrNull(b.net_weight) ?? slot.net_weight,
        gross_weight: finiteOrNull(b.gross_weight) ?? slot.gross_weight,
      });
    } else {
      extras.push({
        sr: 0, key: `RX-${bid}`, out_box_id: null, case_pack: "", extra: true,
        article: b.article || "—", ...common,
        net_weight: num(b.net_weight), gross_weight: num(b.gross_weight),
      });
    }
  }
  if (!patch.size && !extras.length) return list;
  return [...list.map((e) => patch.get(e.key) ?? e), ...extras]
    .map((e, i) => ({ ...e, sr: i + 1 }));
}

// The identity create_service parks on: article upper-cased + trimmed, lot trimmed.
// Must stay in step with it — see buildEntries. The lot is normalised the same way
// the article is: a lot that differs only in case is the same lot.
function artCover(s: string | null | undefined): string { return (s || "").trim().toUpperCase(); }
function lotCover(s: string | null | undefined): string { return (s || "").trim().toUpperCase(); }

// The id reversal_service.park_lines invents for a quantity-only unit.
const LINE_SENTINEL = /^LINE-(\d+)-\d+$/;

function buildEntries(t: TransferDetail | null, parked: PendingBoxRow[] = []): Entry[] {
  if (!t) return [];
  const out: Entry[] = [];
  let sr = 0;
  const realBoxes = (t.boxes ?? []).filter((b) => !!b.box_id);
  for (const b of realBoxes) {
    sr += 1;
    out.push({
      sr, key: String(b.id), box_id: b.box_id!, out_box_id: b.id, synthetic: false,
      article: b.article || "—", transaction_no: b.transaction_no || "", case_pack: "",
      net_weight: num(b.net_weight), gross_weight: num(b.gross_weight),
      lot_number: b.lot_number || "", batch_number: b.batch_number || "",
    });
  }

  // A dispatch can MIX scanned boxes with quantity-only lines — cartons scanned for
  // some materials, a typed quantity for others. This used to `return out` after the
  // box loop, so on a mixed dispatch every quantity-only line vanished: it could not
  // be acknowledged, issued or printed, the per-article chips read "all resolved" on
  // the boxes alone, and Confirm Receipt deleted the line's parked in-transit rows
  // with the GRN recording nothing for that material.
  //
  // WHICH lines still need expanding is answered by the PARKED rows, not by a guess.
  // pending_transfer_stock IS the declaration — create_service parked exactly one row
  // per box the dispatch committed, and _claimed_pending_box_ids resolves the receipt
  // against those same rows — so a line expands into exactly the number of
  // "LINE-<lineId>-<n>" sentinels the dispatch parked for it, and not at all when the
  // dispatch parked real box ids only.
  //
  // The old rule pooled on (article, lot) but compared the lot VERBATIM while
  // normalising the article. A dispatch box carries the lot enriched from source
  // stock; the line carries the lot as typed, usually blank. Transfer 1816 is the
  // shape: 84 boxes of 'Black Chia Seeds' lot 'CF110326' against one line
  // 'BLACK CHIA SEEDS' lot '' — judged uncovered, expanded into 84 phantom units on
  // top of the 84 real boxes, so the screen read "Article Entries (168)" and both
  // weight tiles read exactly double (4204.22 kg against a real 2102.11). The backend
  // never agreed: its own `covered` map is built from the REQUEST payload, where both
  // sides were blank, so it parked one row per box and _declared_box_count then
  // refused box #85 with a 409 — that receipt could never be completed.
  // Units of a line that are ALREADY listed above as a real box row. create_service parks a
  // LINE- sentinel per unit even when that line also has box rows behind it — a dispatch
  // keyed one row per unit writes both (transfer 1904: 58 'ART-n' box rows AND 58 sentinels
  // for the same 58 units) — so expanding the sentinels wholesale rendered the whole
  // dispatch twice, with both weight tiles doubled: 1904 read 116 rows / 619.602 kg against
  // 58 rows / 309.800 kg of stock. 37 of the 283 in-transit dispatches are that shape.
  // Subtract what is already on screen; transfer_line_id is set on every live box row.
  const boxedByLine = new Map<number, number>();
  for (const b of realBoxes) {
    if (b.transfer_line_id == null) continue;
    boxedByLine.set(b.transfer_line_id, (boxedByLine.get(b.transfer_line_id) ?? 0) + 1);
  }
  const sentinels = new Map<string, number>();
  let parkedReal = 0;
  for (const p of parked) {
    const m = LINE_SENTINEL.exec(p.box_id || "");
    if (m) sentinels.set(m[1], (sentinels.get(m[1]) ?? 0) + 1);
    else if (p.box_id) parkedReal += 1;
  }
  const haveDeclaration = sentinels.size > 0 || parkedReal > 0;

  // Legacy fallback only — a transfer dispatched before pending_transfer_stock, or a
  // parked fetch that failed. Pool per article, each line consuming ONE box, and treat
  // a BLANK lot on either side as matching any lot so an enriched box lot cannot
  // orphan its own line.
  //
  // The pool counts only the RENDERABLE boxes, which is the one place this
  // deliberately departs from create_service: that builds `covered` from box_input
  // before any box_id filter, so a box with a blank box_id suppresses its line's
  // parked rows. Dispatch 67639269 is exactly that — 20 boxes, every box_id blank,
  // 20 lines — and counting them here would cover all 20 lines while none of the
  // boxes can render, leaving the screen completely empty. A box with no id is not
  // scannable, ackable or printable, so it cannot stand in for its line; erring
  // toward a visible row is the whole point of this function. The cost is the
  // inverse case — a synthetic row whose line the backend did cover, so there is no
  // parked row to claim — where acking it still records the receipt on the GRN and
  // deletes nothing. Invisible material is the failure worth avoiding.
  const pool = new Map<string, string[]>();
  for (const b of realBoxes) {
    const k = artCover(b.article);
    const arr = pool.get(k);
    if (arr) arr.push(lotCover(b.lot_number)); else pool.set(k, [lotCover(b.lot_number)]);
  }
  const takeCover = (article: string | null | undefined, lot: string | null | undefined): boolean => {
    const arr = pool.get(artCover(article));
    if (!arr || !arr.length) return false;
    const want = lotCover(lot);
    const i = want === "" ? 0 : arr.findIndex((v) => v === want || v === "");
    if (i < 0) return false;
    arr.splice(i, 1);
    return true;
  };

  // line flow: expand each box-less line into one entry per unit the dispatch parked.
  for (const l of t.lines ?? []) {
    // Evaluated for EVERY line, before any skip, because create_service decrements its
    // `covered` map for every line too — a line that consumes a box must consume it here.
    const boxBacked = haveDeclaration ? false : takeCover(l.item_description, l.lot_number);
    // park_lines skips a line with no article or qty <= 0 and truncates with int(qty),
    // so such a line has NO parked row to claim: a receivable row for one records a GRN
    // box that claims nothing and holds the progress counter below n/n, putting Confirm
    // Receipt out of reach. Transfer 712 alone carries 43 of them (five with a blank
    // description, which rendered as an 'N/A' article group). Counted for the operator
    // by `unshippable` instead of being handed out as receivable rows.
    const units = Math.trunc(num(l.quantity));
    if (units <= 0 || !(l.item_description || "").trim()) continue;
    const q = haveDeclaration
      ? Math.max((sentinels.get(String(l.id)) ?? 0) - (boxedByLine.get(l.id) ?? 0), 0)
      : (boxBacked ? 0 : units);
    if (q <= 0) continue;   // box-backed — rendered above, or already off the bridge
    // Round at the step park_lines rounds — round(total/qty, 3) per unit — so the rows
    // on screen ARE the rows on the bridge, and the weight tiles, which sum these, add
    // up to the printed column. Reducing over unrounded per-unit values put transfer
    // 712 (1723 rows) 0.097 kg away from its own Net Wt tile.
    const perNet = round3(num(l.net_weight) / units);
    const perGross = round3(num(l.total_weight) / units);
    for (let n = 1; n <= q; n++) {
      sr += 1;
      out.push({
        sr, key: `L${l.id}-${n}`, box_id: `LINE-${l.id}-${n}`, out_box_id: null, synthetic: true,
        article: l.item_description || "—", transaction_no: "", case_pack: str(l.pack_size),
        net_weight: perNet, gross_weight: perGross,
        lot_number: l.lot_number || "", batch_number: l.batch_number || "",
      });
    }
  }
  return out;
}

// ── Client-side QR id minting (reference handleGenerateQRs, ref 1369–1394) ──
// Mirrors the backend's inward generate_box_ids so a printed sticker is indistinguishable
// from one the server would have issued: transaction "TR-<YYYYMMDDHHMMSS>", box_id
// "<last 8 digits of epoch ms>-<box number>".
// SESSION-ONLY, same as the reference: the ids live in component state, so a page reload
// loses them and those entries fall back to their synthetic keys. Print before reloading.
function genTransactionNo(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `TR-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
const genBoxIdBase = (): string => String(Date.now()).slice(-8);

// Fold minted ids back into the entries so every downstream consumer — the acked/issues
// maps, toAck, the scan matcher, the table cells — sees one box_id. Keyed on `e.key`
// (stable, derived from the line/box row id) rather than box_id, which is what changes.
// `txByKey` is per row. One shared transaction was wrong: rows of a dispatch can
// legitimately carry different ones (two operators on the same challan, or a
// session that minted a fresh TR- after a failed rehydrate), and stamping the
// newest onto every row made a reprint encode a QR that did not match the sticker
// already on the carton. `txNo` is only the fallback for rows with no stored one.
function applyGeneratedIds(
  list: Entry[], gen: Record<string, string>, txNo: string,
  txByKey: Record<string, string> = {},
): Entry[] {
  if (!txNo && Object.keys(gen).length === 0) return list;
  return list.map((e) => {
    const bid = gen[e.key];
    if (!bid) return e;
    return {
      ...e, box_id: bid, synthetic: false,
      transaction_no: txByKey[e.key] || txNo || e.transaction_no,
    };
  });
}

// A box may only be printed once it carries a real id pair. Synthetic LINE-<line>-<n>
// placeholders exist so per-entry acknowledge works; putting one on a physical sticker
// would produce a code that resolves to nothing on any later scan.
function isPrintable(e: Entry): boolean {
  return !!e.box_id && !e.box_id.startsWith("LINE-") && !!e.transaction_no;
}

// Reference gating (ref 2344–2350): a box that already carries BOTH a transaction_no and a
// box_id came off the line with a physical sticker — acknowledge it, don't reprint. Only
// boxes missing either need Print QR, which mints, acknowledges and prints in one go.
//
// NOTE this means "carries ids", NOT "the server recorded it". Those are different
// questions and conflating them is a trap: minting alone makes this true, so it
// cannot decide whether a box still needs acknowledging. See printLane.
function hasExistingQRData(e: Entry): boolean {
  return !e.synthetic && !!e.transaction_no && !!e.box_id;
}

// Which print control a row gets. Keyed on whether the SERVER holds a row for the
// box, never on whether ids exist.
//
//   "print"   mint (if needed) -> save -> acknowledge -> print
//   "reprint" fetch the stored row -> print, no acknowledge
//   "none"    a box that arrived from dispatch already stickered: legacy shows
//             Acknowledge only, so reprinting would issue a duplicate sticker.
//
// Gating on hasExistingQRData instead put a row into the reprint lane the moment
// an id was minted — which meant a FAILED acknowledge silently relabelled the
// button, and the operator's retry printed a sticker for a box the server had
// refused to record. One press of "Generate QR ID's" did the same to every row on
// the transfer. `mintedHere` is what separates "we just made this id up" from
// "this box came off the truck wearing one".
function printLane(
  e: Entry, recorded: boolean, mintedHere: boolean,
): "print" | "reprint" | "none" {
  if (recorded) return isPrintable(e) ? "reprint" : "none";
  return mintedHere || !hasExistingQRData(e) ? "print" : "none";
}

// Entry -> the bulk receipt's box shape. Note what is NOT here: article,
// batch_number, lot_number and transaction_no. The bulk endpoint resolves those
// from the dispatch row itself, so sending our copy could only ever overwrite the
// challan with something staler. `out_box_id` IS sent - it is the claim path that
// survives a relabel, and dropping it strands the carton In Transit.
// Correct the client-derived checklist against the dispatch's PARKED rows.
//
// buildEntries reconstructs what was dispatched from the Transfer OUT detail, and
// for quantity-only lines it has to guess which are box-backed by pooling on
// (article, lot). GET /pending-stock/boxes/by-transfer-out returns what
// create_service ACTUALLY parked - the same rows finalize claims against - so where
// the two disagree, the parked row is right.
//
// Deliberately conservative: this only FILLS IN a missing `out_box_id`, it does not
// rebuild the list. buildEntries carries a lot of hard-won handling (mixed
// dispatches, blank box_ids, over-receipts) that a wholesale swap would drop.
// Supplying the dispatch id matters on its own - it is what lets a relabelled
// carton still claim its parked row on POST /transfer-in.
function reconcileWithParked(list: Entry[], parked: PendingBoxRow[]): Entry[] {
  if (!parked.length) return list;
  const byBoxId = new Map<string, PendingBoxRow>();
  for (const p of parked) if (p.box_id) byBoxId.set(p.box_id, p);
  return list.map((e) => {
    if (e.out_box_id != null) return e;
    const p = byBoxId.get(e.box_id);
    if (!p || p.dispatch_box_id == null) return e;
    return { ...e, out_box_id: p.dispatch_box_id };
  });
}

// The jsonb an issue is stored as. The keys are the ones the data actually carries —
// over 291 stored issues: remarks 291, case_pack 288, net_weight 288, total_weight 288,
// `gross_weight` and `qty` ZERO — so writing our own names produced rows neither this
// screen nor the GRN detail page could read back. Present-not-truthy, so a recorded 0
// (a box that arrived empty) survives instead of being dropped from the payload.
function issuePayload(issue: IssueData): Record<string, string> {
  return {
    remarks: issue.remarks || "",
    ...(issue.net_weight !== "" ? { net_weight: issue.net_weight } : {}),
    ...(issue.gross_weight !== "" ? { total_weight: issue.gross_weight } : {}),
    ...(issue.qty !== "" ? { case_pack: issue.qty } : {}),
  };
}

function toBulk(e: Entry, matched: boolean, issue?: IssueData): BulkTransferInBox {
  const net = issue && issue.net_weight !== "" ? num(issue.net_weight) : e.net_weight;
  const gross = issue && issue.gross_weight !== "" ? num(issue.gross_weight) : e.gross_weight;
  return {
    box_id: e.box_id,
    dispatch_box_id: e.out_box_id,
    net_weight: net,
    gross_weight: gross,
    is_matched: matched,
    issue: matched || !issue ? null : issuePayload(issue),
  };
}

function toAck(e: Entry, matched: boolean, issue?: IssueData): AcknowledgeBoxInput {
  const net = issue && issue.net_weight !== "" ? num(issue.net_weight) : e.net_weight;
  const gross = issue && issue.gross_weight !== "" ? num(issue.gross_weight) : e.gross_weight;
  return {
    box_id: e.box_id, transfer_out_box_id: e.out_box_id, article: e.article,
    batch_number: e.batch_number, lot_number: e.lot_number, transaction_no: e.transaction_no,
    net_weight: net, gross_weight: gross, is_matched: matched, scan_source: "manual",
    issue: matched || !issue ? null : issuePayload(issue),
  };
}

// The RECEIVED weight of one row: the figure the operator recorded on an issue when
// there is one, else the dispatched figure. The NET WT / TOTAL WT columns and the
// weight tiles must both come from here — they used to differ, the columns showing
// the correction and the tiles summing the challan, so GRN 842 printed a row at
// 320.000 kg over a Net Wt tile counting 10.02 kg for that same box.
function effNet(e: Entry, issues: Map<string, IssueData>): number {
  return finiteOrNull(issues.get(e.box_id)?.net_weight) ?? e.net_weight;
}
function effGross(e: Entry, issues: Map<string, IssueData>): number {
  return finiteOrNull(issues.get(e.box_id)?.gross_weight) ?? e.gross_weight;
}

function Chip({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={`text-[11px] px-1.5 py-0.5 rounded font-medium ${tone}`}>{children}</span>;
}

// Article Entries grid chrome. Every cell carries its own padding + right divider so
// neighbouring columns can never read as one value (TOTAL WT/LOT rendered as "1.000123456"
// and CASE PACK/QTY as "0.0001 BOX" when the cells had no padding or rules between them).
// border-separate (not collapse) is deliberate: with collapsed borders the sticky <thead>
// loses its rules as soon as the body scrolls under it.
const TH_CELL = "px-3 py-2 font-semibold whitespace-nowrap border-b border-r border-[var(--aws-border)] last:border-r-0";
const TD_CELL = "px-3 py-1.5 align-middle border-b border-r border-[var(--aws-border)] last:border-r-0";

// Button system for the Article Entries card. Every control is a real button with a
// fixed height and hit area — the row actions used to be a mix of dotted-underline text
// links (Print QR, Undo) and thin bordered boxes, which read as three different things.
// Tones follow the semantics the rest of the page already uses: emerald = received,
// rose = issue, violet = the Article Entries accent.
const BTN_BASE =
  "inline-flex items-center justify-center gap-1 rounded font-medium whitespace-nowrap leading-none " +
  "transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 " +
  // Full-strength brand ring with a 1px offset. No /40 alpha here on purpose: Tailwind v4
  // silently drops the opacity modifier on a bare var() colour, so it would render solid anyway.
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--aws-orange)] focus-visible:ring-offset-1";
const BTN_SIZE = {
  sm: "h-[26px] px-2 text-[11px]",   // dense desktop table rows
  md: "h-8 px-3 text-[12px]",        // mobile cards + inline issue form
} as const;
const BTN_TONE = {
  neutral: "border border-[var(--aws-border)] bg-white text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] hover:border-[var(--aws-border-strong)]",
  accept:  "border border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700 hover:border-emerald-700",
  danger:  "border border-rose-300 bg-white text-rose-700 hover:bg-rose-50 hover:border-rose-400",
  dangerSolid: "border border-rose-600 bg-rose-600 text-white hover:bg-rose-700 hover:border-rose-700",
  brand:   "border border-violet-300 bg-white text-violet-700 hover:bg-violet-50 hover:border-violet-400",
} as const;
function btn(tone: keyof typeof BTN_TONE = "neutral", size: keyof typeof BTN_SIZE = "sm") {
  return `${BTN_BASE} ${BTN_SIZE[size]} ${BTN_TONE[tone]}`;
}

// POST /api/v1/production/scan-identify response — shared shape with the job-card RM tab.
type IdentifyBox = {
  box_id: string | null; transaction_no: string | null; item_description: string | null;
  lot_number: string | null; net_weight: number | null; gross_weight: number | null;
  count: number | string | null; status: string | null; job_card_number: string | null;
};
type IdentifyFound = { found: true; table: string; company: string | null; matched_by: string; box: IdentifyBox };
type IdentifyResult = IdentifyFound | { found: false; box_id: string | null; transaction_no?: string | null };

// Outcome of one camera scan in the receive flow (drives the "Scanned QR" result card).
type ScanOutcome =
  | { status: "loading"; value: string }
  | { status: "matched"; value: string; entry: Entry }        // expected on this transfer → acknowledged
  | { status: "already"; value: string; entry: Entry }        // expected here → already acknowledged
  | { status: "foreign"; value: string; identify: IdentifyFound } // real box, not on this transfer
  | { status: "unknown"; value: string; box_id: string }      // not found in any box table
  | { status: "err"; value: string; error: string };

// Pull a box_id (and optional txn) out of a scanned QR: JSON {tx,bi|box_id} or plain sticker text.
function parseScan(text: string): { box_id: string; transaction_no: string } {
  const raw = text.trim();
  try {
    const o = JSON.parse(raw);
    return { box_id: String(o.bi ?? o.box_id ?? o.boxId ?? raw), transaction_no: String(o.tx ?? o.transaction_no ?? "") };
  } catch { return { box_id: raw, transaction_no: "" }; }
}

function ReceiveInner() {
  const router = useRouter();
  const allowed = useRequireAuth(router.replace);
  const me = useMe();
  const searchParams = useSearchParams();
  const resumeNo = searchParams.get("resume");

  const email = (me?.email || "").toLowerCase();
  const canAcknowledge = me?.is_admin === true || ACK_EMAILS.has(email);
  const canReopen = me?.is_admin === true || REOPEN_EMAILS.has(email);
  const receivedBy = me?.full_name || me?.email || "web";

  const [transferNumber, setTransferNumber] = useState("");
  const [transferData, setTransferData] = useState<TransferDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [boxCondition, setBoxCondition] = useState("Good");
  const [conditionRemarks, setConditionRemarks] = useState("");

  const [pendingHeaderId, setPendingHeaderId] = useState<number | null>(null);
  const [acked, setAcked] = useState<Set<string>>(new Set());
  // The GRN's persisted boxes, kept so the row list can show what was actually
  // received — not just how many were counted. See mergeReceived.
  const [received, setReceived] = useState<ReceivedBox[]>([]);
  const [issues, setIssues] = useState<Map<string, IssueData>>(new Map());
  const [issueOpen, setIssueOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<IssueData>(EMPTY_ISSUE);
  const [busy, setBusy] = useState(false);
  const [doneGrn, setDoneGrn] = useState<string | null>(null);
  const [receivedHeaderId, setReceivedHeaderId] = useState<number | null>(null);
  const [showShortage, setShowShortage] = useState(false);
  const [shortageReason, setShortageReason] = useState("");
  const [showEdit, setShowEdit] = useState(false);
  const [editForm, setEditForm] = useState({ grn_number: "", box_condition: "Good", condition_remarks: "" });
  const [scan, setScan] = useState<ScanOutcome | null>(null);
  // Monotonic id per scan: a slow identify response is dropped once a newer scan supersedes it.
  const scanReqRef = useRef(0);

  // ── QR / label state ──
  const [inwardTxNo, setInwardTxNo] = useState("");             // minted TR- transaction
  const [genBoxIds, setGenBoxIds] = useState<Record<string, string>>({}); // entry.key -> box_id
  const [genTxByKey, setGenTxByKey] = useState<Record<string, string>>({}); // entry.key -> TR-
  // The rehydrate GET is the one call whose failure must NOT be silent: an empty
  // result is indistinguishable from "nothing minted yet", and the recovery an
  // operator reaches for (Generate QR ID's / Print QR) UPSERTS over ids their
  // cartons are already wearing. When this is set, minting is refused.
  const [qrLoadFailed, setQrLoadFailed] = useState(false);
  const [printingKey, setPrintingKey] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkFrom, setBulkFrom] = useState("1");
  const [bulkTo, setBulkTo] = useState("");
  const [cartonWt, setCartonWt] = useState<Record<string, string>>({}); // article -> empty carton kg
  const [bulkBusy, setBulkBusy] = useState(false);

  // ── STBR reconciliation log — what the server reported per acknowledge, keyed by the
  // box_id we sent. Drives the "↻ Reconciled" row badge and the summary panel.
  // server_replica returns status "noop" for everything until P8b-2 lands, so this stays
  // empty against the current backend and the UI simply shows nothing. No wiring changes
  // needed when the real STBR ships — the contract is already the one it will return.
  const [recon, setRecon] = useState<Map<string, BoxReconciliation>>(new Map());

  const resetReceiveState = () => {
    setPendingHeaderId(null); setAcked(new Set()); setIssues(new Map()); setReceived([]);
    setIssueOpen(null); setDoneGrn(null); setReceivedHeaderId(null); setShowShortage(false);
    setInwardTxNo(""); setGenBoxIds({}); setCartonWt({}); setBulkOpen(false);
    setGenTxByKey({}); setQrLoadFailed(false);
    setRecon(new Map());
  };

  // ── FUNCTION BLOCK: doSearch (WIRED) ──
  const doSearch = useCallback(async (no: string) => {
    const q = no.trim();
    if (!q) return;
    setLoading(true); setError(null); setNotice(null); setTransferData(null); resetReceiveState();
    try {
      const t = await TransferApi.getTransferByNumber(q);
      if (!t) { setError(`No transfer found for "${q}".`); return; }
      setTransferData(t);
      try {
        const pend = await TransferApi.getPendingByTransferOut(t.id);
        if (pend.exists && pend.header) {
          if ((pend.header.status || "").toLowerCase() === "received") {
            // Already received → offer Re-open (don't adopt its boxes as in-progress).
            setReceivedHeaderId(pend.header.id);
          } else {
            // Pending → resume: adopt the acknowledged / issued boxes.
            setPendingHeaderId(pend.header.id);
            const a = new Set<string>(); const iss = new Map<string, IssueData>();
            for (const b of pend.header.boxes) {
              if (!b.box_id) continue;
              a.add(b.box_id);
              if (b.is_matched === false) {
                const i = parseIssueObj(b.issue) || {};
                // Read the keys the payload actually carries. `i.gross_weight` and
                // `i.qty` appear in ZERO of the 291 stored issues — str(undefined) is
                // "", so the truthiness fallback downstream substituted the CHALLAN's
                // gross for the recorded one (GRN 842 box 45234442-1: 10.660 shown
                // against a recorded 320.00) and re-submitting the pre-filled form
                // then wrote that challan figure back over the GRN.
                iss.set(b.box_id, {
                  net_weight: str(i.net_weight),
                  gross_weight: str(i.total_weight ?? i.gross_weight),
                  qty: str(i.case_pack ?? i.qty),
                  remarks: str(i.remarks),
                });
              }
            }
            setAcked(a); setIssues(iss);
            setReceived(pend.header.boxes.filter((b) => !!b.box_id));
          }
        }
      } catch { /* resume best-effort */ }
      // Rehydrate the minted QR ids. These used to live in component state only,
      // so a reload dropped them and every sticker already on a carton pointed at
      // an id the DB had never heard of. Keyed on the DISPATCH, not the GRN, so
      // they come back even when no receipt has been started.
      try {
        const qr = await TransferApi.getQrIds(t.id);
        if (qr.transaction_no) setInwardTxNo(qr.transaction_no);
        if (Object.keys(qr.box_ids).length) setGenBoxIds(qr.box_ids);
        if (qr.transactions && Object.keys(qr.transactions).length) setGenTxByKey(qr.transactions);
      } catch {
        // NOT best-effort. An empty rehydrate looks exactly like "nothing has been
        // minted yet", so the operator prints fresh ids over stickers already on
        // cartons — and persistQrIds upserts, so the originals are gone. Say so,
        // and refuse to mint until a reload succeeds.
        setQrLoadFailed(true);
        setError("Could not load this transfer's saved QR ids. Printing is disabled "
          + "so existing stickers are not overwritten — reload to try again.");
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Search failed."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (!allowed || !resumeNo) return;
    queueMicrotask(() => { setTransferNumber(resumeNo); doSearch(resumeNo); });
  }, [allowed, resumeNo, doSearch]);

  // The dispatch's parked in-transit rows. Advisory: a failure here must not block
  // receiving, so it degrades to the client-derived checklist alone.
  //
  // Cached WITH the dispatch id it was fetched for, and read back only when the two
  // still agree. That is what keeps the previous dispatch's boxes off the screen
  // while a new one loads — without a synchronous reset in the effect body, which
  // would cost a cascading render on every search.
  const transferOutId = transferData?.id;
  const [parkedCache, setParkedCache] = useState<{ id: number; boxes: PendingBoxRow[] }>(
    { id: 0, boxes: [] });
  useEffect(() => {
    if (!transferOutId) return;
    let live = true;
    TransferApi.getPendingBoxes(transferOutId)
      .then((r) => { if (live) setParkedCache({ id: transferOutId, boxes: r.boxes ?? [] }); })
      .catch(() => { if (live) setParkedCache({ id: transferOutId, boxes: [] }); });
    return () => { live = false; };
  }, [transferOutId]);
  const parked = useMemo(
    () => (transferOutId && parkedCache.id === transferOutId ? parkedCache.boxes : []),
    [transferOutId, parkedCache],
  );

  const entries = useMemo(
    () => reconcileWithParked(
      mergeReceived(
        applyGeneratedIds(buildEntries(transferData, parked), genBoxIds, inwardTxNo, genTxByKey), received),
      parked),
    [transferData, genBoxIds, inwardTxNo, genTxByKey, received, parked],
  );

  // The checklist the operator sees vs the rows finalize will actually claim. A
  // mismatch is not an error - a relabel or a quantity-only line legitimately
  // diverges - but it is worth surfacing before someone confirms a receipt.
  //
  // Compared LIKE WITH LIKE. A parked LINE-<line>-<n> sentinel never equals the id
  // this screen mints, and applyGeneratedIds replaces the synthetic id the moment
  // anything is printed — so an id-level comparison reported routine minting as drift
  // ("187 in transit not listed" on transfer 1721, where nothing is missing at all).
  // receive_service._claimed_pending_box_ids resolves sentinels by ARTICLE; so does
  // this. Both directions are reported now: a parked row no row on screen accounts
  // for, and a row on screen with no parked row — only the second means finalize will
  // claim nothing for a box the operator just acknowledged.
  const parkedDrift = useMemo(() => {
    if (!parked.length || !entries.length) return { unlisted: 0, unbacked: 0 };
    const parkedIds = new Set(parked.map((p) => p.box_id).filter(Boolean));
    const parkedDispatchIds = new Set(
      parked.map((p) => p.dispatch_box_id).filter((v): v is number => v != null));
    const shown = new Set(entries.map((e) => e.box_id));
    // A real parked sticker no row carries is genuine drift, id for id.
    let unlisted = parked.filter(
      (p) => p.box_id && !LINE_SENTINEL.test(p.box_id) && !shown.has(p.box_id)).length;
    const supply = new Map<string, number>();
    for (const p of parked) {
      if (!p.box_id || !LINE_SENTINEL.test(p.box_id)) continue;
      const k = artKey(p.article);
      supply.set(k, (supply.get(k) ?? 0) + 1);
    }
    const demand = new Map<string, number>();
    for (const e of entries) {
      // Claim paths 1 and 2: the same box_id, or the dispatch row behind it.
      if (parkedIds.has(e.box_id)) continue;
      if (e.out_box_id != null && parkedDispatchIds.has(e.out_box_id)) continue;
      const k = artKey(e.article);
      demand.set(k, (demand.get(k) ?? 0) + 1);
    }
    let unbacked = 0;
    for (const [k, n] of supply) unlisted += Math.max(n - (demand.get(k) ?? 0), 0);
    for (const [k, n] of demand) unbacked += Math.max(n - (supply.get(k) ?? 0), 0);
    return { unlisted, unbacked };
  }, [parked, entries]);

  // Lines the dispatch could not ship: park_lines skips a line with no article or
  // qty <= 0, so nothing was parked for them and buildEntries hands out no receivable
  // row. Counted so they are visible rather than merely absent.
  const unshippable = useMemo(
    () => (transferData?.lines ?? []).filter(
      (l) => Math.trunc(num(l.quantity)) <= 0 || !(l.item_description || "").trim()).length,
    [transferData]);
  // Boxes the GRN holds beyond what the challan declared. The API now refuses
  // these at scan time, so a non-zero count is historical data.
  const overReceipt = useMemo(() => entries.filter((e) => e.extra).length, [entries]);
  const byArticle = useMemo(() => {
    const m = new Map<string, Entry[]>();
    for (const e of entries) { const a = m.get(e.article); if (a) a.push(e); else m.set(e.article, [e]); }
    return Array.from(m.entries());
  }, [entries]);
  const totals = useMemo(() => ({
    // Scanned cartons — the SAME population the acknowledgement card header counts. A
    // box row with no box_id cannot be rendered, scanned or acknowledged, so counting
    // it here made this tile disagree with the card directly above it.
    boxes: (transferData?.boxes ?? []).filter((b) => !!b.box_id).length,
    entries: entries.length,
    // Reduce over the same expression the NET WT / TOTAL WT columns print — see effNet.
    net: entries.reduce((s, e) => s + effNet(e, issues), 0),
    gross: entries.reduce((s, e) => s + effGross(e, issues), 0),
  }), [transferData, entries, issues]);

  // Resolved ROWS, not resolved ids. A dispatch can carry several box rows sharing one
  // box_id (transfer 450: 220 rows over 51 distinct ids); acknowledging one tints every
  // sibling green but adds a single member to `acked`, so acked.size/entries.length
  // could never reach n/n and Confirm Receipt was disabled forever.
  const resolved = entries.filter((e) => acked.has(e.box_id)).length;
  const issueCount = entries.filter((e) => issues.has(e.box_id)).length;
  const pendingCount = Math.max(entries.length - resolved, 0);
  const allResolved = entries.length > 0 && resolved === entries.length;
  const isCold = !!transferData?.from_cold_unit ||
    (transferData ? COLD_SITES.has((transferData.from_warehouse || "").trim().toLowerCase()) : false);
  const boxCount = (transferData?.boxes ?? []).filter((b) => !!b.box_id).length;

  // What Close-with-shortage ACTUALLY writes off: every pending_transfer_stock row
  // still 'In Transit' once this GRN has claimed what it can — close_with_shortage
  // deletes exactly those. `pendingCount` is un-green ROWS on a client-side
  // reconstruction, an unrelated population: transfer 712 renders 1723 rows against 4
  // parked, so the button offered to write off 1611 boxes that do not exist, while
  // transfer 1721 understated it (168 offered, 187 parked). Mirrors
  // _claimed_pending_box_ids — box_id, then the dispatch row, then a LINE- sentinel of
  // the same article. null means `parked` never loaded: say so rather than name a
  // number for a destructive action that will not use it.
  const writeOffCount = useMemo(() => {
    if (!parked.length) return null;
    const live = new Set(parked.map((p) => p.box_id).filter(Boolean));
    const byDispatch = new Map<number, string>();
    for (const p of parked) {
      if (p.dispatch_box_id != null && p.box_id) byDispatch.set(p.dispatch_box_id, p.box_id);
    }
    const claimed = new Set<string>();
    const need = new Map<string, number>();
    const seen = new Set<string>();
    for (const e of entries) {
      // Per box_id, not per row: sibling rows sharing an id are one GRN box.
      if (!acked.has(e.box_id) || seen.has(e.box_id)) continue;
      seen.add(e.box_id);
      if (live.has(e.box_id)) { claimed.add(e.box_id); continue; }
      const mapped = e.out_box_id != null ? byDispatch.get(e.out_box_id) : undefined;
      if (mapped) { claimed.add(mapped); continue; }
      const k = artKey(e.article);
      need.set(k, (need.get(k) ?? 0) + 1);
    }
    if (need.size) {
      const sentinels = new Map<string, string[]>();
      for (const p of [...parked].sort((a, b) => (a.box_id || "").localeCompare(b.box_id || ""))) {
        const bid = p.box_id || "";
        if (!LINE_SENTINEL.test(bid) || claimed.has(bid)) continue;
        const k = artKey(p.article);
        const arr = sentinels.get(k); if (arr) arr.push(bid); else sentinels.set(k, [bid]);
      }
      for (const [k, n] of need) {
        for (const bid of (sentinels.get(k) ?? []).slice(0, n)) claimed.add(bid);
      }
    }
    return Math.max(parked.length - claimed.size, 0);
  }, [parked, entries, acked]);

  // ── FUNCTION BLOCK: ensurePending (WIRED) ──
  const ensurePending = useCallback(async (): Promise<number> => {
    if (pendingHeaderId) return pendingHeaderId;
    if (!transferData) throw new Error("No transfer loaded.");
    const hdr = await TransferApi.createPendingTransferIn({
      transfer_out_id: transferData.id, grn_number: `GRN-${transferData.challan_no}`,
      receiving_warehouse: transferData.to_warehouse, received_by: receivedBy,
      box_condition: boxCondition, condition_remarks: conditionRemarks,
    });
    setPendingHeaderId(hdr.id);
    if (hdr.boxes?.length) setAcked(new Set(hdr.boxes.map((b) => b.box_id).filter(Boolean) as string[]));
    return hdr.id;
  }, [pendingHeaderId, transferData, receivedBy, boxCondition, conditionRemarks]);

  // ── FUNCTION BLOCK: STBR capture (WIRED — reference ref:746–781) ──
  // Record a non-noop reconciliation against the box_id we sent, and say what happened.
  // Silent when the server reports "noop"/"matched" — nothing was swapped.
  const captureRecon = (sentBoxId: string, rec: BoxReconciliation | null | undefined) => {
    if (!rec?.status || rec.status === "noop" || rec.status === "matched") return;
    const entry: BoxReconciliation = { ...rec, actual_box_id: sentBoxId };
    setRecon((p) => new Map(p).set(sentBoxId, entry));
    const orig = rec.original_box_id || "—";
    const sib = rec.propagated_count ? ` (+${rec.propagated_count} sibling${rec.propagated_count === 1 ? "" : "s"} auto-mapped)` : "";
    setNotice(rec.status === "propagated"
      ? `Series remap: ${orig} → ${sentBoxId}${sib}`
      : `Reconciled: ${orig} → ${sentBoxId}${sib}`);
  };

  // STBR rejects arrive as HTTP errors, not as a reconciliation status: 409 when the box was
  // already received elsewhere, 422 when no pending slot matches it (reference ref:783–790).
  const ackErrorText = (err: unknown, fallback: string): string => {
    const msg = err instanceof Error ? err.message : "";
    if (/\b409\b|already acknowledged|duplicate/i.test(msg)) {
      return "Duplicate scan — this box was already received on another transfer.";
    }
    if (/\b422\b|reconciliation conflict|no matching slot/i.test(msg)) {
      return `Reconciliation conflict — ${msg || "no matching in-transit slot for this box"}.`;
    }
    return msg || fallback;
  };

  // ── FUNCTION BLOCK: onAck / onAckAll / onUnack (WIRED) ──
  // The server closes a GRN as soon as an acknowledge completes its dispatch, so
  // the screen can find itself already Received without ever pressing Confirm.
  const afterAutoFinalize = async () => {
    const grn = `GRN-${transferData?.challan_no || transferNumber}`;
    setNotice(null);
    setDoneGrn(grn);
    setTimeout(() => router.push("/modules/transfer"), 1800);
  };

  const onAck = async (e: Entry): Promise<boolean> => {
    setBusy(true); setError(null);
    try {
      const hid = await ensurePending();
      const res = await TransferApi.acknowledgeBox(hid, toAck(e, true));
      captureRecon(e.box_id, res?.reconciliation);
      setAcked((p) => new Set(p).add(e.box_id));
      setIssues((p) => { const n = new Map(p); n.delete(e.box_id); return n; });
      // This box completed the dispatch and the server closed the GRN. Offering
      // Confirm now would 400 ("not in Pending status").
      if (res?.auto_finalized) await afterAutoFinalize();
      return true;
    } catch (err) { setError(ackErrorText(err, "Acknowledge failed.")); return false; }
    finally { setBusy(false); }
  };
  const onAckAll = async () => {
    setBusy(true); setError(null);
    try {
      const hid = await ensurePending();
      const todo = entries.filter((e) => !acked.has(e.box_id));
      if (todo.length) {
        const res = await TransferApi.acknowledgeBatch(hid, todo.map((e) => toAck(e, true)));
        // Only mark the boxes the server actually accepted. Marking every entry
        // regardless flipped `allResolved` true and unlocked Confirm Receipt while
        // the rejected boxes were never written to the GRN.
        if (res.conflicts?.length) {
          setError(`${res.conflicts.length} entr(ies) had conflicts and were NOT acknowledged.`);
          const bad = new Set(
            res.conflicts.map((c) => (c as { box_id?: string })?.box_id).filter(Boolean) as string[]);
          setAcked((p) => {
            const n = new Set(p);
            todo.forEach((e) => { if (!bad.has(e.box_id)) n.add(e.box_id); });
            return n;
          });
        } else {
          setAcked((p) => { const n = new Set(p); todo.forEach((e) => n.add(e.box_id)); return n; });
        }
        if (res.auto_finalized) await afterAutoFinalize();
      }
    } catch (err) { setError(err instanceof Error ? err.message : "Acknowledge-all failed."); }
    finally { setBusy(false); }
  };
  const onUnack = async (e: Entry) => {
    setBusy(true); setError(null);
    try {
      if (pendingHeaderId) await TransferApi.unacknowledgeBox(pendingHeaderId, e.box_id);
      setAcked((p) => { const n = new Set(p); n.delete(e.box_id); return n; });
      setIssues((p) => { const n = new Map(p); n.delete(e.box_id); return n; });
    } catch (err) { setError(err instanceof Error ? err.message : "Un-acknowledge failed."); }
    finally { setBusy(false); }
  };

  // ── FUNCTION BLOCK: handleGenerateQRs (WIRED) — reference ref:1369–1394 ──
  // Mints one TR- transaction for the session plus a box_id per entry that lacks a real
  // one. Already-acknowledged entries are SKIPPED: their box_id is the key the server row
  // and the local acked/issues maps share, so re-minting mid-session would orphan both.
  // Write the minted ids to the DB before anything shows them or prints them.
  // Not a receipt and no stock effect — acknowledge stays the only event that
  // says a box arrived. This exists so a reload cannot orphan a sticker.
  const persistQrIds = useCallback(async (tx: string, minted: Record<string, string>) => {
    const assignments = Object.entries(minted).map(([entry_key, box_id]) => ({ entry_key, box_id }));
    if (!assignments.length || !transferData) return;
    // Refuse rather than overwrite. We do not know what is already stored, so
    // minting here would upsert over ids the cartons may already be wearing.
    if (qrLoadFailed) {
      throw new Error("This transfer's saved QR ids could not be loaded. Reload before "
        + "printing, or existing stickers will be overwritten.");
    }
    await TransferApi.saveQrIds({
      transfer_out_id: transferData.id, transaction_no: tx, assignments,
    });
    setGenTxByKey((p) => {
      const n = { ...p };
      for (const k of Object.keys(minted)) n[k] = tx;
      return n;
    });
  }, [transferData, qrLoadFailed]);

  const handleGenerateQRs = async () => {
    const targets = entries.filter(
      (e) => !genBoxIds[e.key] && !acked.has(e.box_id) && !issues.has(e.box_id) && !hasExistingQRData(e),
    );
    if (!targets.length) {
      setNotice("Every entry that needs a QR id already has one.");
      return;
    }
    const tx = inwardTxNo || genTransactionNo();
    const base = genBoxIdBase();
    const minted: Record<string, string> = {};
    for (const e of targets) minted[e.key] = `${base}-${e.sr}`;
    setBusy(true);
    try {
      // Save FIRST. Showing an id in the TXN / BOX ID column before it is stored
      // is the failure this whole change exists to remove.
      await persistQrIds(tx, minted);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the QR ids — none were assigned.");
      return;
    } finally { setBusy(false); }
    setInwardTxNo(tx); setGenBoxIds((p) => ({ ...p, ...minted })); setError(null);
    setNotice(`${targets.length} QR id${targets.length === 1 ? "" : "s"} assigned and saved — TX ${tx}. Print per row, or use Bulk print.`);
  };

  // Mint ids on demand for entries that still carry a synthetic LINE- placeholder, so the
  // print buttons work on first click instead of gating behind "Generate QR ID's" (which
  // stays as the bulk pre-assign that fills the TXN / BOX ID columns ahead of printing).
  // Returns the effective entries — state updates are queued, so `entries` is still stale
  // in this tick and the caller must use what comes back for both acknowledge and label.
  // An entry already acknowledged under a non-printable id is returned untouched: re-minting
  // would orphan the server row keyed on the old id. The caller reports those.
  // Async because it now PERSISTS before returning: a throw here aborts the
  // caller's print, so an operator is never handed a sticker whose id the
  // database has not stored.
  const mintIds = async (targets: Entry[]): Promise<{ ready: Entry[]; locked: Entry[] }> => {
    const tx = inwardTxNo || genTransactionNo();
    const base = genBoxIdBase();
    const minted: Record<string, string> = {};
    const ready: Entry[] = [];
    const locked: Entry[] = [];
    for (const e of targets) {
      if (isPrintable(e)) { ready.push(e); continue; }
      if (acked.has(e.box_id) || issues.has(e.box_id)) { locked.push(e); continue; }
      const bid = genBoxIds[e.key] || `${base}-${e.sr}`;
      minted[e.key] = bid;
      ready.push({ ...e, box_id: bid, transaction_no: tx, synthetic: false });
    }
    if (Object.keys(minted).length) {
      await persistQrIds(tx, minted);
      if (!inwardTxNo) setInwardTxNo(tx);
      setGenBoxIds((p) => ({ ...p, ...minted }));
    }
    return { ready, locked };
  };

  // Label payload for one entry. Issue-reported weights win over the dispatched ones so a
  // reprint after an issue carries what was actually received (reference ref:1254–1258).
  const labelOf = (e: Entry): TransferLabelBox => {
    const iss = issues.get(e.box_id);
    return {
      box_id: e.box_id,
      transaction_no: e.transaction_no,
      box_number: e.sr,
      item_name: e.article,
      net_weight: effNet(e, issues),
      gross_weight: effGross(e, issues),
      lot_number: e.lot_number,
      has_issue: !!iss,
      issue_case_pack: iss ? e.case_pack : "",
    };
  };

  // ── FUNCTION BLOCK: handlePrintQR (WIRED) — reference ref:1214–1366 ──
  // Acknowledge FIRST, print second, and abort the print if the acknowledge fails — never
  // hand an operator a sticker for a box the server did not record.
  const handlePrintQR = async (e: Entry, opts?: { skipAcknowledge?: boolean }) => {
    setPrintingKey(e.key); setError(null);
    try {
      const { ready, locked } = await mintIds([e]);
      if (locked.length) {
        setError(`Box #${e.sr} was acknowledged before it had a printable QR id. Undo it, then Print QR.`);
        return;
      }
      const target = ready[0];
      const needsAck = !opts?.skipAcknowledge && canAcknowledge
        && !acked.has(target.box_id) && !issues.has(target.box_id);
      if (needsAck && !(await onAck(target))) return;   // onAck already surfaced the error
      await printTransferLabels({ entity: LABEL_ENTITY, boxes: [labelOf(target)] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to print the QR label.");
    } finally {
      setPrintingKey(null);
    }
  };

  // `recorded` is the server's answer, not the screen's guess: acked/issues are
  // populated from the GRN's saved boxes on load and on every acknowledge.
  const laneOf = (e: Entry) =>
    printLane(e, acked.has(e.box_id) || issues.has(e.box_id), !!genBoxIds[e.key]);

  // Read one saved box straight from the server so a reprint carries what the DB
  // holds rather than whatever this tab has in memory. Deliberately does NOT touch
  // component state: reprinting must not change what the screen thinks is
  // acknowledged. Returns null when the box has no saved row yet, in which case
  // the caller falls back to the on-screen values.
  const fetchSavedBox = useCallback(async (boxId: string): Promise<ReceivedBox | null> => {
    if (!transferData) return null;
    const pend = await TransferApi.getPendingByTransferOut(transferData.id);
    if (!pend.exists || !pend.header) return null;
    return pend.header.boxes.find((b) => b.box_id === boxId) || null;
  }, [transferData]);

  // ── FUNCTION BLOCK: handleReprintQR ──
  // The "sticker fell off / smudged / printer jammed" path for a box whose ids are
  // ALREADY saved. Fetches the stored row and prints it; never acknowledges, so it
  // is safe on a box that is already received and on a GRN that is already closed.
  //
  // Before the ids were persisted this could not exist: a reprint after a reload
  // had nothing to reprint FROM. The per-article "Reprint all" was the only route,
  // which meant re-running a whole article to recover one label.
  const handleReprintQR = async (e: Entry) => {
    setPrintingKey(e.key); setError(null);
    try {
      const saved = await fetchSavedBox(e.box_id);
      const base = labelOf(e);
      // A Received GRN never rehydrates the `issues` map, so `base.has_issue` is
      // false for every box on a closed receipt. The stored row is the authority:
      // is_matched === false IS the issue flag, and the weights it carries are
      // already the corrected ones (toAck persisted them).
      const savedIssue = saved ? parseIssueObj(saved.issue) : null;
      const savedHasIssue = saved ? saved.is_matched === false : false;
      const box: TransferLabelBox = saved
        ? {
            ...base,
            box_id: saved.box_id,
            transaction_no: saved.transaction_no || base.transaction_no,
            lot_number: saved.lot_number || base.lot_number,
            net_weight: num(saved.net_weight ?? base.net_weight),
            gross_weight: num(saved.gross_weight ?? base.gross_weight),
            has_issue: savedHasIssue || base.has_issue,
            issue_case_pack: (savedHasIssue || base.has_issue)
              ? (str(savedIssue?.case_pack) || e.case_pack) : "",
          }
        : base;
      await printTransferLabels({ entity: LABEL_ENTITY, boxes: [box] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reprint the QR label.");
    } finally {
      setPrintingKey(null);
    }
  };

  // ── FUNCTION BLOCK: handlePrintRange (WIRED) — reference ref:1396–1450 ──
  // Reprint every printable box of one article. Deliberately does NOT acknowledge: this is
  // the "sticker fell off / smudged" path for boxes that are already recorded.
  const handlePrintRange = async (article: string, items: Entry[]) => {
    const boxes = items.filter(isPrintable).map(labelOf);
    if (!boxes.length) {
      // Reprint deliberately does not mint or acknowledge — it reissues labels for boxes
      // that already have ids. Printing a freshly-minted id here would put a sticker on a
      // box the server has no record of.
      setError(`Nothing to reprint for “${article}” yet — use Print QR on a row (or Generate QR ID's) to assign ids first.`);
      return;
    }
    setPrintingKey(article); setError(null);
    try {
      await printTransferLabels({ entity: LABEL_ENTITY, boxes });
      setNotice(`Reprinted ${boxes.length} label${boxes.length === 1 ? "" : "s"} for ${article}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reprint labels.");
    } finally {
      setPrintingKey(null);
    }
  };

  // ── FUNCTION BLOCK: handleBulkPrintQR (WIRED) — reference ref:1526–1700 ──
  // One batch acknowledge for a box-number range, then a single print sheet. Gross weight is
  // recomputed as net + the article's empty-carton weight when one is entered, matching the
  // reference — that adjusted gross is what gets acknowledged, not just what gets printed.
  const handleBulkPrintQR = async () => {
    const from = Math.max(1, parseInt(bulkFrom, 10) || 1);
    const to = Math.min(entries.length, parseInt(bulkTo, 10) || entries.length);
    if (from > to) { setError("Invalid box range."); return; }

    for (const [article, v] of Object.entries(cartonWt)) {
      if (v.trim() === "") continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) { setError(`Invalid empty-carton weight for ${article}.`); return; }
    }

    const grossOf = (e: Entry) => {
      const extra = Number(cartonWt[e.article] ?? "");
      return Number.isFinite(extra) && extra > 0 ? round3(e.net_weight + extra) : e.gross_weight;
    };

    setBulkBusy(true); setError(null);
    try {
      // mintIds is INSIDE the try: it persists, so it can reject. Left outside,
      // a failed save escaped as an unhandled rejection — nothing printed (the
      // invariant held) but the operator got no error, bulkBusy never cleared,
      // and the dialog just sat there inviting repeated presses.
      const inRange = entries.filter((e) => e.sr >= from && e.sr <= to);
      const { ready: printable, locked } = await mintIds(inRange);
      if (!printable.length) {
        setError(locked.length
          ? `All ${locked.length} box(es) in that range were acknowledged before they had printable QR ids. Undo them first.`
          : "No boxes in that range.");
        return;
      }
      const todo = printable.filter((e) => !acked.has(e.box_id) && !issues.has(e.box_id));
      if (canAcknowledge && todo.length) {
        const hid = await ensurePending();
        const res = await TransferApi.acknowledgeBatch(
          hid,
          todo.map((e) => ({ ...toAck(e, true), gross_weight: grossOf(e) })),
        );
        if (res.conflicts?.length) {
          setError(`${res.conflicts.length} entr(ies) had conflicts — labels not printed.`);
          return;
        }
        setAcked((p) => { const n = new Set(p); todo.forEach((e) => n.add(e.box_id)); return n; });
      }
      await printTransferLabels({
        entity: LABEL_ENTITY,
        boxes: printable.map((e) => ({ ...labelOf(e), gross_weight: grossOf(e) })),
      });
      setNotice(`${printable.length} label${printable.length === 1 ? "" : "s"} sent to the printer (boxes ${from}–${to}).`);
      setBulkOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bulk print failed.");
    } finally {
      setBulkBusy(false);
    }
  };

  // ── FUNCTION BLOCK: openIssue / submitIssue (WIRED) ──
  const openIssue = (e: Entry) => {
    setDraft(issues.get(e.box_id) || { ...EMPTY_ISSUE, net_weight: String(e.net_weight), gross_weight: String(e.gross_weight) });
    setIssueOpen(e.box_id);
  };
  const submitIssue = async (e: Entry) => {
    setBusy(true); setError(null);
    try {
      const hid = await ensurePending();
      const res = await TransferApi.acknowledgeBox(hid, toAck(e, false, draft));
      captureRecon(e.box_id, res?.reconciliation);
      setAcked((p) => new Set(p).add(e.box_id));
      setIssues((p) => new Map(p).set(e.box_id, draft));
      setIssueOpen(null);
    } catch (err) { setError(ackErrorText(err, "Flagging issue failed.")); }
    finally { setBusy(false); }
  };

  // ── FUNCTION BLOCK: onReceiveAll (WIRED) ── bulk one-shot receipt
  // Collapses ensurePending + acknowledgeBatch + finalize into ONE atomic call.
  // Only offered on a clean slate (no pending header, nothing acknowledged): once
  // a scan session is under way the server refuses a bulk receipt for that
  // dispatch, and rightly so - it would merge into the GRN already in progress.
  const canReceiveAll = !pendingHeaderId && !receivedHeaderId &&
    acked.size === 0 && entries.length > 0;

  const onReceiveAll = async () => {
    if (!transferData) return;
    setBusy(true); setError(null);
    try {
      const result = await TransferApi.createTransferIn({
        transfer_out_id: transferData.id,
        grn_number: `GRN-${transferData.challan_no}`,
        receiving_warehouse: transferData.to_warehouse,
        box_condition: boxCondition,
        condition_remarks: conditionRemarks,
        scanned_boxes: entries.map((e) => toBulk(e, !issues.has(e.box_id), issues.get(e.box_id))),
      });
      // Same short-receipt handling as onConfirm: a partial post stays Pending and
      // must not be reported as done.
      if (result.remaining_in_transit > 0) {
        setNotice(
          `Posted ${result.boxes_posted} box(es). ${result.remaining_in_transit} still in transit — ` +
          `the receipt stays Pending. Acknowledge the rest, or use Close with shortage to write them off.`);
        await doSearch(transferData.challan_no || transferNumber);
        return;
      }
      setDoneGrn(result.grn_number);
      setTimeout(() => router.push("/modules/transfer"), 1800);
    } catch (err) {
      // 409 carries a `conflicts` list naming the boxes that were refused; nothing
      // was written, so the operator can fix and retry - or fall back to scanning.
      setError(ackErrorText(err, "Bulk receipt failed — nothing was recorded."));
    } finally { setBusy(false); }
  };

  // ── FUNCTION BLOCK: onConfirm (WIRED) ──
  const onConfirm = async () => {
    setBusy(true); setError(null);
    try {
      const hid = await ensurePending();
      const result = await TransferApi.finalizeTransferIn(hid, { box_condition: boxCondition, condition_remarks: conditionRemarks });
      // A short receipt posts what arrived and stays Pending. Reporting it as done
      // and navigating away would hide a shortfall that is still on the bridge.
      if (result.remaining_in_transit > 0) {
        setNotice(
          `Posted ${result.boxes_posted} box(es). ${result.remaining_in_transit} still in transit — ` +
          `the receipt stays Pending. Acknowledge the rest, or use Close with shortage to write them off.`);
        await doSearch(transferData?.challan_no || transferNumber);
        return;
      }
      setDoneGrn(result.grn_number);
      setTimeout(() => router.push("/modules/transfer"), 1800);
    } catch (err) { setError(err instanceof Error ? err.message : "Confirm receipt failed."); }
    finally { setBusy(false); }
  };

  // ── FUNCTION BLOCK: handleReopen (WIRED) ── reverse a Received GRN → Pending
  const handleReopen = async () => {
    if (!receivedHeaderId) return;
    setBusy(true); setError(null);
    try {
      await TransferApi.reopenTransferIn(receivedHeaderId);
      setNotice("Receipt re-opened — stock moved back to in-transit. Re-acknowledge to correct.");
      await doSearch(transferData?.challan_no || transferNumber);
    } catch (e) { setError(e instanceof Error ? e.message : "Re-open failed."); }
    finally { setBusy(false); }
  };

  // ── FUNCTION BLOCK: handleCloseWithShortage (WIRED) ── receive acked boxes, write off the rest
  const handleCloseWithShortage = async () => {
    setBusy(true); setError(null);
    try {
      const hid = await ensurePending();
      const result = await TransferApi.closeTransferInWithShortage(hid, shortageReason || undefined);
      setShowShortage(false);
      setDoneGrn(result.grn_number);
      setTimeout(() => router.push("/modules/transfer"), 1800);
    } catch (e) { setError(e instanceof Error ? e.message : "Close with shortage failed."); }
    finally { setBusy(false); }
  };

  // ── FUNCTION BLOCK: handleEditReceipt (WIRED, header fields) ──
  // Loads the GRN's current header to prefill, then PUTs the edit. Per-box edits
  // are supported by the backend; this dialog exposes the header fields.
  const handleEditOpen = async () => {
    if (!receivedHeaderId) return;
    setBusy(true); setError(null);
    try {
      const g = await TransferApi.getTransferIn(receivedHeaderId);
      setEditForm({ grn_number: g.grn_number || "", box_condition: g.box_condition || "Good", condition_remarks: g.condition_remarks || "" });
      setShowEdit(true);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load the receipt to edit."); }
    finally { setBusy(false); }
  };
  const handleEditSubmit = async () => {
    if (!receivedHeaderId) return;
    setBusy(true); setError(null);
    try {
      await TransferApi.editTransferIn(receivedHeaderId, {
        grn_number: editForm.grn_number || undefined,
        box_condition: editForm.box_condition || undefined,
        condition_remarks: editForm.condition_remarks || undefined,
      });
      setShowEdit(false);
      setNotice("Receipt updated.");
      await doSearch(transferData?.challan_no || transferNumber);
    } catch (e) { setError(e instanceof Error ? e.message : "Edit failed."); }
    finally { setBusy(false); }
  };

  // ── FUNCTION BLOCK: onScanDetected (camera QR) — BUILT (mirrors job-card RM _RawMaterialTab) ──
  // 1) Parse a box_id (+ optional txn) from the QR — JSON {tx,bi|box_id} or a plain sticker.
  // 2) If it's a box EXPECTED on this transfer → acknowledge it (green bar), show its details.
  // 3) Otherwise call /production/scan-identify (the universal box-identify used by the RM tab)
  //    so the operator sees WHAT they scanned and why it isn't here (red bar).
  // A monotonic scanReqRef drops a stale identify response once a newer scan supersedes it.
  const onScanDetected = async (text: string): Promise<boolean> => {
    const { box_id } = parseScan(text);
    const reqId = ++scanReqRef.current;
    setScan({ status: "loading", value: box_id });

    // Expected on this transfer? (real, non-synthetic boxes only — synthetic line units have no QR)
    const entry = entries.find((e) => !e.synthetic && e.box_id === box_id);
    if (entry) {
      if (acked.has(entry.box_id)) { setScan({ status: "already", value: box_id, entry }); return true; }
      const ok = await onAck(entry);
      if (scanReqRef.current === reqId) setScan(ok ? { status: "matched", value: box_id, entry } : { status: "err", value: box_id, error: "Acknowledge failed." });
      return ok;
    }

    // Not on this transfer — identify what it actually is (job-card RM scan-identify pattern).
    try {
      const res = await apiFetch("/api/v1/production/scan-identify", { method: "POST", body: JSON.stringify({ value: text }) });
      if (scanReqRef.current !== reqId) return false;
      if (!res.ok) { setScan({ status: "err", value: box_id, error: await readApiErrorMessage(res, "Lookup failed") }); return false; }
      const data = (await res.json()) as IdentifyResult;
      if (scanReqRef.current !== reqId) return false;
      setScan(data.found ? { status: "foreign", value: box_id, identify: data } : { status: "unknown", value: box_id, box_id });
      return false;
    } catch (e) {
      if (scanReqRef.current === reqId) setScan({ status: "err", value: box_id, error: friendlyApiError(e) });
      return false;
    }
  };

  // No `if (!allowed) return null` gate: useRequireAuth returns true on the server but
  // false on the client's first render, so gating the render on it causes a hydration
  // mismatch. Effects are gated on `allowed`; the hook redirects unauthenticated users.

  const fromName = transferData ? (transferData.from_cold_unit || getDisplayWarehouseName(transferData.from_warehouse) || transferData.from_warehouse) : "";
  const toName = transferData ? (getDisplayWarehouseName(transferData.to_warehouse) || transferData.to_warehouse) : "";
  const isReceived = (transferData?.status || "").toLowerCase() === "received";
  const stateOf = (e: Entry) => issues.has(e.box_id) ? "issue" : acked.has(e.box_id) ? "ok" : "pending";
  const reconOf = (e: Entry) => recon.get(e.box_id);
  const reconTitle = (r: BoxReconciliation) =>
    `Originally: ${r.original_box_id || "—"} → Scanned: ${r.actual_box_id || "—"}`
    + (r.propagated_count ? ` · +${r.propagated_count} sibling${r.propagated_count === 1 ? "" : "s"} auto-mapped` : "")
    + ` · ${r.status}`;

  // STBR roll-up across every acknowledge in this session (reference ref:2839–2871).
  const reconSummary = useMemo(() => {
    const all = Array.from(recon.values());
    const overrides = all.filter((r) => RELABEL_STATUSES.has(r.status || "")).length;
    const propagations = all.filter((r) => r.status === "propagated").length;
    const siblings = all.reduce((s, r) => s + (r.propagated_count || 0), 0);
    return { overrides, propagations, siblings, total: overrides + propagations + siblings };
  }, [recon]);

  return (
    <TransferChrome title="Transfer In (Receive)">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-2 mb-4">
        <div>
          <h1 className="text-[18px] font-semibold text-[var(--text-primary)]">Transfer IN</h1>
          <div className="text-[12px] text-[var(--text-secondary)]">Receive incoming stock transfers</div>
        </div>
        <div className="flex items-center gap-2">
          {canReopen && isReceived && (
            <button onClick={handleReopen} disabled={busy || !receivedHeaderId} className="border border-amber-300 text-amber-700 text-[12px] px-3 py-1.5 rounded hover:bg-amber-50 disabled:opacity-40">Re-open receipt</button>
          )}
          {canReopen && isReceived && (
            <button onClick={handleEditOpen} disabled={busy || !receivedHeaderId} className="border border-[var(--aws-border)] text-[12px] px-3 py-1.5 rounded hover:border-[var(--aws-navy)] disabled:opacity-40">Edit receipt</button>
          )}
          <button onClick={() => router.push("/modules/transfer")} className="text-[12px] text-[var(--text-secondary)] hover:underline">← Back</button>
        </div>
      </div>

      {notice && (
        <div className="mb-3 text-[12px] text-sky-800 bg-sky-50 border border-sky-200 rounded px-3 py-2 flex items-center justify-between">
          <span>{notice}</span><button onClick={() => setNotice(null)} className="text-sky-700">✕</button>
        </div>
      )}

      {error && (
        <div className="mb-3 text-[12px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-2">{error}</div>
      )}

      {doneGrn ? (
        <div className="py-12 text-center">
          <div className="text-[15px] font-semibold text-emerald-700 mb-1">Receipt confirmed — {doneGrn}</div>
          <div className="text-[12px] text-[var(--text-secondary)]">Stock posted to destination. Returning to the dashboard…</div>
        </div>
      ) : loading && !transferData ? (
        <div className="space-y-3">{[0, 1, 2].map((i) => <div key={i} className="h-24 bg-white border border-[var(--aws-border)] rounded-md animate-pulse" />)}</div>
      ) : !transferData ? (
        <div className="bg-white border border-[var(--aws-border)] rounded-md py-12 text-center">
          <div className="text-[13px] font-medium text-[var(--text-primary)]">No Transfer Loaded</div>
          <div className="text-[12px] text-[var(--text-secondary)] mt-1">Search a dispatched transfer by its challan number to begin receiving.</div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Route */}
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-4 flex flex-wrap items-center gap-3">
            <Chip tone="bg-blue-50 text-blue-800 border border-blue-200">{fromName}</Chip>
            <span className="text-[var(--text-secondary)]">→</span>
            <Chip tone="bg-teal-50 text-teal-800 border border-teal-200">{toName}</Chip>
            <span className="ml-auto text-[11px] px-2 py-0.5 rounded border border-[var(--aws-border)] font-mono">{transferData.challan_no}</span>
            {isCold && <Chip tone="bg-sky-100 text-sky-800">Cold storage</Chip>}
            {pendingHeaderId && <Chip tone="bg-amber-100 text-amber-800">Receiving (GRN #{pendingHeaderId})</Chip>}
          </div>

          {/* Box & Article Acknowledgement */}
          <div className="bg-white border border-[var(--aws-border)] rounded-md">
            <div className="px-4 py-3 border-b border-[var(--aws-border)] flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-[13px] font-semibold text-[var(--text-primary)]">📦 Box &amp; Article Acknowledgement</div>
                <div className="text-[11px] text-[var(--text-secondary)]">{transferData.challan_no} — {boxCount} boxes, {byArticle.length} article(s)</div>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <Chip tone="bg-emerald-50 text-emerald-700 border border-emerald-200">{resolved} resolved</Chip>
                {issueCount > 0 && <Chip tone="bg-rose-50 text-rose-700 border border-rose-200">{issueCount} issue(s)</Chip>}
                {pendingCount > 0 && <Chip tone="bg-amber-50 text-amber-700 border border-amber-200">{pendingCount} pending</Chip>}
              </div>
            </div>
            {!canAcknowledge && (
              <div className="px-4 py-2 text-[11px] text-amber-800 bg-amber-50">You are not authorized to receive transfers — viewing only.</div>
            )}
            {canAcknowledge && (
              <div className="p-3 space-y-2">
                {canReceiveAll && (
                  <>
                    <button onClick={onReceiveAll} disabled={busy}
                      className="w-full py-2 text-[13px] rounded border border-violet-300 text-violet-700 hover:bg-violet-50 disabled:opacity-40">
                      ⚡ Receive All in One Step ({entries.length})
                    </button>
                    <p className="text-[10px] text-[var(--text-secondary)] text-center">
                      Records the GRN and posts every box at once. All-or-nothing — use
                      Acknowledge All instead if you need to scan in stages.
                    </p>
                  </>
                )}
                <button onClick={onAckAll} disabled={busy || allResolved}
                  className="w-full py-2 text-[13px] rounded border border-emerald-300 text-emerald-700 hover:bg-emerald-50 disabled:opacity-40">
                  ✓ Acknowledge All ({entries.length})
                </button>
              </div>
            )}
          </div>

          {/* Inline camera scanner — same always-on card as the job-card RM tab. Each
              decode routes through onScanDetected (match+acknowledge, else identify). */}
          {canAcknowledge && (
            <QrScanBox
              title="Scan box to receive"
              idleHint="Start the camera and centre a box QR to acknowledge it."
              onResult={(v) => { void onScanDetected(v); }}
            />
          )}

          {/* Last-scan result — mirrors the job-card RM tab's "Scanned QR" card. */}
          {scan && <ScanReceiptResult scan={scan} onDismiss={() => setScan(null)} />}

          {/* Article Entries */}
          <div className="bg-white border border-[var(--aws-border)] rounded-md">
            <div className="px-4 py-3 border-b border-[var(--aws-border)] flex flex-wrap items-center justify-between gap-2">
              <span className="text-[13px] font-semibold text-violet-700">📄 Article Entries ({entries.length})</span>
              <div className="flex items-center gap-2">
                {overReceipt > 0 && (
                  <Chip tone="bg-rose-50 text-rose-700 border border-rose-200">
                    ⚠ {overReceipt} over challan
                  </Chip>
                )}
                {parkedDrift.unlisted > 0 && (
                  <Chip tone="bg-sky-50 text-sky-700 border border-sky-200">
                    {parkedDrift.unlisted} in transit not listed
                  </Chip>
                )}
                {parkedDrift.unbacked > 0 && (
                  <Chip tone="bg-amber-50 text-amber-700 border border-amber-200">
                    {parkedDrift.unbacked} with no in-transit row
                  </Chip>
                )}
                {unshippable > 0 && (
                  <Chip tone="bg-slate-100 text-slate-700 border border-slate-200">
                    {unshippable} line(s) not shipped
                  </Chip>
                )}
                <Chip tone="bg-amber-50 text-amber-700 border border-amber-200">{resolved}/{entries.length}</Chip>
                {canAcknowledge && (
                  <button onClick={onAckAll} disabled={busy || allResolved} className={btn("neutral", "md")}>✓ Acknowledge All</button>
                )}
                <button onClick={() => void handleGenerateQRs()} disabled={busy} className={btn("brand", "md")}>🖨 Generate QR ID&apos;s</button>
                <button onClick={() => setBulkOpen((v) => !v)} disabled={busy} className={btn("neutral", "md")}
                  aria-expanded={bulkOpen}>🖨 Bulk print…</button>
              </div>
            </div>

            {/* Bulk print — box-number range + per-article empty-carton weight. Batch
                acknowledges the range, then prints every label in one sheet. */}
            {bulkOpen && (
              <div className="px-4 py-3 border-b border-[var(--aws-border)] bg-[var(--surface-subtle)] space-y-3">
                <div className="flex flex-wrap items-end gap-3">
                  <label className="text-[11px] text-[var(--text-secondary)]">
                    <span className="block mb-1">From box</span>
                    <input type="number" min={1} max={entries.length} value={bulkFrom}
                      onChange={(ev) => setBulkFrom(ev.target.value)}
                      className="w-24 border border-[var(--aws-border)] rounded px-2 py-1 text-[12px] bg-white" />
                  </label>
                  <label className="text-[11px] text-[var(--text-secondary)]">
                    <span className="block mb-1">To box</span>
                    <input type="number" min={1} max={entries.length} value={bulkTo}
                      placeholder={String(entries.length)}
                      onChange={(ev) => setBulkTo(ev.target.value)}
                      className="w-24 border border-[var(--aws-border)] rounded px-2 py-1 text-[12px] bg-white" />
                  </label>
                  <button onClick={() => void handleBulkPrintQR()}
                    disabled={bulkBusy || busy || qrLoadFailed} className={btn("brand", "md")}>
                    {bulkBusy ? "Printing…" : "🖨 Acknowledge & print range"}
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {byArticle.map(([article]) => (
                    <label key={article} className="text-[11px] text-[var(--text-secondary)]">
                      <span className="block mb-1 truncate">Empty carton kg — {article}</span>
                      <input type="number" min={0} step="0.001" value={cartonWt[article] ?? ""}
                        placeholder="optional"
                        onChange={(ev) => setCartonWt((p) => ({ ...p, [article]: ev.target.value }))}
                        className="w-full border border-[var(--aws-border)] rounded px-2 py-1 text-[12px] bg-white" />
                    </label>
                  ))}
                </div>
                <p className="text-[11px] text-[var(--text-secondary)]">
                  When set, gross weight is recomputed as net + empty carton — and that adjusted
                  gross is what gets acknowledged, not just what gets printed.
                </p>
              </div>
            )}

            {byArticle.map(([article, items]) => {
              const aResolved = items.filter((e) => acked.has(e.box_id)).length;
              // A box is a row with a DISPATCHED CARTON behind it (out_box_id =
              // interunit_transfer_boxes.id). Calling every row a box let transfer 1721
              // — which has zero scanned cartons — print article headers of "134 boxes",
              // "50 boxes", "3 boxes" beside a Scanned Boxes tile of 0 and an
              // acknowledgement card reading "0 boxes". One screen, three box counts.
              const aBoxes = items.filter((e) => e.out_box_id != null).length;
              const aUnits = items.length - aBoxes;
              return (
                <div key={article} className="border-b border-[var(--aws-border)]/50 last:border-b-0">
                  <div className="px-4 py-2 bg-violet-50/40 flex items-center justify-between gap-2">
                    <span className="text-[12px] font-semibold text-violet-800 truncate max-w-[320px]">{article}</span>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] text-[var(--text-secondary)]">
                        {aBoxes > 0 && `${aBoxes} box${aBoxes === 1 ? "" : "es"}`}
                        {aBoxes > 0 && aUnits > 0 && " · "}
                        {aUnits > 0 && `${aUnits} unit${aUnits === 1 ? "" : "s"}`}
                      </span>
                      <Chip tone="bg-amber-50 text-amber-700 border border-amber-200">{aResolved}/{items.length}</Chip>
                      {/* Reprint — no acknowledge; for stickers that were lost or smudged. */}
                      <button onClick={() => handlePrintRange(article, items)}
                        disabled={printingKey === article || !items.some(isPrintable)}
                        title={items.some(isPrintable)
                          ? `Reprint all ${items.length} labels — no acknowledge`
                          : "Nothing to reprint yet — Print QR assigns the ids"}
                        className={btn("neutral")}>
                        {printingKey === article ? "Printing…" : "🖨 Reprint all"}
                      </button>
                    </div>
                  </div>

                  {/* Desktop table — reference columns */}
                  <div className="hidden md:block p-3">
                    <div className="overflow-x-auto max-h-[460px] border border-[var(--aws-border)] rounded-md">
                      <table className="w-full text-[12px] border-separate border-spacing-0">
                        <thead className="sticky top-0 z-10 bg-[var(--surface-subtle)]">
                          <tr className="text-left text-[var(--text-secondary)]">
                            <th className={`${TH_CELL} text-center`}>SR NO</th><th className={TH_CELL}>ITEM NAME</th><th className={TH_CELL}>TRANSACTION NO</th><th className={TH_CELL}>BOX ID</th>
                            <th className={`${TH_CELL} text-right`}>CASE PACK</th><th className={`${TH_CELL} text-right`}>QTY</th>
                            <th className={`${TH_CELL} text-right`}>NET WT</th><th className={`${TH_CELL} text-right`}>TOTAL WT</th><th className={TH_CELL}>LOT</th><th className={`${TH_CELL} text-right`}>ACTION</th>
                          </tr>
                        </thead>
                        <tbody>
                          {items.map((e) => {
                            const st = stateOf(e);
                            const iss = issues.get(e.box_id);
                            return (
                              <Fragment key={e.key}>
                                <tr className={st === "ok" ? "bg-emerald-50/40" : st === "issue" ? "bg-rose-50/30" : "hover:bg-gray-50/50"}>
                                  <td className={`${TD_CELL} text-center text-[var(--text-secondary)]`}>{e.sr}</td>
                                  <td className={`${TD_CELL} max-w-[220px] truncate`}>
                                    {e.article}
                                    {/* A box the challan never declared. Counting it in
                                        the header chip is not enough — the operator has
                                        to be able to see WHICH row is the extra. */}
                                    {e.extra && (
                                      <span className="ml-1 px-1 py-0.5 rounded text-[10px] bg-rose-100 text-rose-700 align-middle"
                                        title="Received but not declared on the challan">
                                        over challan
                                      </span>
                                    )}
                                  </td>
                                  <td className={`${TD_CELL} font-mono text-[11px] text-[var(--text-secondary)]`}>{e.synthetic ? "—" : (e.transaction_no || "—")}</td>
                                  <td className={`${TD_CELL} font-mono text-[11px]`}>
                                    {e.synthetic ? "—" : e.box_id}
                                    {reconOf(e) && (
                                      <span
                                        title={reconTitle(reconOf(e)!)}
                                        className="ml-1 inline-flex items-center align-middle text-[9px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded px-1 py-0.5 cursor-help">
                                        ↻ Reconciled
                                      </span>
                                    )}
                                  </td>
                                  <td className={`${TD_CELL} text-right tabular-nums`}>{e.case_pack || "—"}</td>
                                  <td className={`${TD_CELL} text-right text-blue-700 whitespace-nowrap`}>1 <span className="text-[var(--text-secondary)]">BOX</span></td>
                                  <td className={`${TD_CELL} text-right tabular-nums ${finiteOrNull(iss?.net_weight) != null ? "text-rose-700 font-medium" : ""}`}>{effNet(e, issues).toFixed(3)}</td>
                                  <td className={`${TD_CELL} text-right tabular-nums ${finiteOrNull(iss?.gross_weight) != null ? "text-rose-700 font-medium" : ""}`}>{effGross(e, issues).toFixed(3)}</td>
                                  <td className={`${TD_CELL} font-mono text-[11px] text-[var(--text-secondary)]`}>{e.lot_number || "—"}</td>
                                  <td className={`${TD_CELL} whitespace-nowrap`}>
                                    <div className="flex items-center justify-end gap-1.5">
                                      {/* Lane is decided by whether the SERVER holds this box —
                                          see printLane. Print QR is acknowledge-gated because it
                                          mints and acknowledges; Reprint is a read plus a print,
                                          so a view-only operator can still replace a lost sticker. */}
                                      {laneOf(e) === "print" && canAcknowledge && (
                                        <button onClick={() => void handlePrintQR(e)}
                                          disabled={printingKey === e.key || busy || qrLoadFailed}
                                          title="Assign a QR id if needed, acknowledge, and print this label"
                                          className={btn("neutral")}>
                                          {printingKey === e.key ? "Printing…" : "🖨 Print QR"}
                                        </button>
                                      )}
                                      {laneOf(e) === "reprint" && (
                                        <button onClick={() => void handleReprintQR(e)}
                                          disabled={printingKey === e.key || busy}
                                          title="Re-read this box from the database and print its label again"
                                          className={btn("neutral")}>
                                          {printingKey === e.key ? "Printing…" : "🖨 Reprint QR"}
                                        </button>
                                      )}
                                      {!canAcknowledge ? (st !== "pending"
                                        ? <Chip tone="bg-emerald-100 text-emerald-800">Done</Chip>
                                        : <span className="text-[var(--text-secondary)]">—</span>)
                                        : st === "pending" ? (
                                          <>
                                            <button onClick={() => onAck(e)} disabled={busy} className={btn("accept")}>Acknowledge</button>
                                            <button onClick={() => openIssue(e)} disabled={busy} className={btn("danger")}>⚠ Issue</button>
                                          </>
                                        ) : (
                                          <>
                                            {st === "issue" && <button onClick={() => openIssue(e)} disabled={busy} className={btn("danger")}>Edit issue</button>}
                                            <button onClick={() => onUnack(e)} disabled={busy} className={btn("neutral")}>↩ Undo</button>
                                          </>
                                        )}
                                    </div>
                                  </td>
                                </tr>
                                {issueOpen === e.box_id && (
                                  <tr className="bg-rose-50/60"><td colSpan={10} className="px-4 py-3 border-b border-[var(--aws-border)]">
                                    <IssueForm draft={draft} setDraft={setDraft} busy={busy} onCancel={() => setIssueOpen(null)} onSubmit={() => submitIssue(e)} />
                                  </td></tr>
                                )}
                              </Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Mobile cards */}
                  <div className="md:hidden p-3 space-y-2">
                    {items.map((e) => {
                      const st = stateOf(e);
                      return (
                        <div key={e.key} className={`border rounded p-2 ${st === "ok" ? "border-emerald-200 bg-emerald-50/40" : st === "issue" ? "border-rose-200 bg-rose-50/30" : "border-[var(--aws-border)]"}`}>
                          <div className="flex items-center justify-between gap-1.5">
                            <span className="text-[12px] font-medium truncate max-w-[200px]">#{e.sr} {e.article}</span>
                            <div className="flex items-center gap-1">
                              {reconOf(e) && (
                                <span title={reconTitle(reconOf(e)!)}
                                  className="text-[9px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded px-1 py-0.5 whitespace-nowrap">↻ Reconciled</span>
                              )}
                              {st === "ok" ? <Chip tone="bg-emerald-100 text-emerald-800">OK</Chip> : st === "issue" ? <Chip tone="bg-rose-100 text-rose-800">Issue</Chip> : <Chip tone="bg-amber-100 text-amber-800">Pending</Chip>}
                            </div>
                          </div>
                          <div className="text-[11px] text-[var(--text-secondary)] mt-0.5">
                            Case {e.case_pack || "—"} · Net {effNet(e, issues).toFixed(3)} · Total {effGross(e, issues).toFixed(3)} · Lot {e.lot_number || "—"}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {canAcknowledge && (st === "pending" ? (
                              <>
                                <button onClick={() => onAck(e)} disabled={busy} className={btn("accept", "md")}>Acknowledge</button>
                                <button onClick={() => openIssue(e)} disabled={busy} className={btn("danger", "md")}>⚠ Issue</button>
                              </>
                            ) : (
                              <>
                                {st === "issue" && <button onClick={() => openIssue(e)} disabled={busy} className={btn("danger", "md")}>Edit issue</button>}
                                <button onClick={() => onUnack(e)} disabled={busy} className={btn("neutral", "md")}>↩ Undo</button>
                              </>
                            ))}
                            {/* Same lanes and the same gates as desktop: Print QR needs
                                acknowledge rights, Reprint does not. */}
                            {laneOf(e) === "print" && canAcknowledge && (
                              <button onClick={() => void handlePrintQR(e)}
                                disabled={printingKey === e.key || busy || qrLoadFailed}
                                className={btn("neutral", "md")}>
                                {printingKey === e.key ? "Printing…" : "🖨 Print QR"}
                              </button>
                            )}
                            {laneOf(e) === "reprint" && (
                              <button onClick={() => void handleReprintQR(e)}
                                disabled={printingKey === e.key || busy} className={btn("neutral", "md")}>
                                {printingKey === e.key ? "Printing…" : "🖨 Reprint QR"}
                              </button>
                            )}
                          </div>
                          {issueOpen === e.box_id && (
                            <div className="mt-2"><IssueForm draft={draft} setDraft={setDraft} busy={busy} onCancel={() => setIssueOpen(null)} onSubmit={() => submitIssue(e)} /></div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Totals */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-md p-3 text-center border bg-blue-50 border-blue-100 text-blue-700"><div className="text-[18px] font-semibold">{totals.entries}</div><div className="text-[11px] text-[var(--text-secondary)]">Total Entries</div></div>
            <div className="rounded-md p-3 text-center border bg-indigo-50 border-indigo-100 text-indigo-700"><div className="text-[18px] font-semibold">{totals.boxes}</div><div className="text-[11px] text-[var(--text-secondary)]">Scanned Boxes</div></div>
            <div className="rounded-md p-3 text-center border bg-emerald-50 border-emerald-100 text-emerald-700"><div className="text-[18px] font-semibold">{totals.net.toFixed(2)}</div><div className="text-[11px] text-[var(--text-secondary)]">Net Wt (kg)</div></div>
            <div className="rounded-md p-3 text-center border bg-amber-50 border-amber-100 text-amber-700"><div className="text-[18px] font-semibold">{totals.gross.toFixed(2)}</div><div className="text-[11px] text-[var(--text-secondary)]">Gross Wt (kg)</div></div>
          </div>

          {/* Condition Assessment */}
          <div className="bg-white border border-[var(--aws-border)] rounded-md">
            <div className="px-4 py-3 border-b border-[var(--aws-border)] text-[13px] font-semibold text-[var(--text-primary)]">Condition Assessment</div>
            <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <select value={boxCondition} onChange={(e) => setBoxCondition(e.target.value)} className="border border-[var(--aws-border)] rounded px-2 py-1.5 text-[12px]">
                <option>Good</option><option>Damaged</option><option>Partial</option>
              </select>
              <input value={conditionRemarks} onChange={(e) => setConditionRemarks(e.target.value)} placeholder="Condition remarks (optional)…" className="border border-[var(--aws-border)] rounded px-2 py-1.5 text-[12px]" />
            </div>
          </div>

          {/* STBR Reconciliation Summary — only once a swap has actually happened. */}
          {reconSummary.total > 0 && (
            <div className="bg-white border border-[var(--aws-border)] border-l-[3px] border-l-amber-400 rounded-md p-4">
              <div className="flex items-start gap-2">
                <span className="text-amber-700 text-[15px] leading-none mt-0.5" aria-hidden="true">↻</span>
                <div className="min-w-0 space-y-1">
                  <div className="text-[12px] font-semibold text-amber-900">
                    STBR Reconciliation Summary — {reconSummary.total} box-id swap{reconSummary.total === 1 ? "" : "s"} applied
                  </div>
                  <div className="text-[11px] text-amber-800 flex flex-wrap gap-x-3 gap-y-0.5">
                    {reconSummary.overrides > 0 && <span>Scan-time overrides: <b>{reconSummary.overrides}</b></span>}
                    {reconSummary.propagations > 0 && <span>Series propagations: <b>{reconSummary.propagations}</b></span>}
                    {reconSummary.siblings > 0 && <span>Siblings auto-mapped: <b>{reconSummary.siblings}</b></span>}
                  </div>
                  <div className="text-[11px] text-[var(--text-secondary)]">
                    Hover a <span className="inline-flex items-center text-[9px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded px-1 py-0.5 mx-0.5">↻ Reconciled</span>
                    badge to see Originally → Scanned. These swaps are applied server-side at scan time;
                    the boxes you received are the ones now recorded.
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Confirm */}
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-4 space-y-2">
            <button onClick={onConfirm} disabled={busy || !canAcknowledge || !allResolved}
              className="w-full py-2 text-[13px] rounded bg-emerald-600 text-white disabled:bg-[var(--aws-navy)] disabled:opacity-40">
              {busy ? "Working…" : allResolved ? "Confirm Receipt — All Items Acknowledged" : `Acknowledge all items to continue (${resolved}/${entries.length})`}
            </button>
            {canAcknowledge && pendingHeaderId && resolved > 0 && writeOffCount !== 0 && (
              <button onClick={() => setShowShortage(true)} disabled={busy}
                className="w-full py-2 text-[13px] rounded border border-amber-300 text-amber-700 hover:bg-amber-50 disabled:opacity-40">
                {writeOffCount == null
                  ? "Close with shortage — in-transit count unavailable"
                  : `Close with shortage — write off ${writeOffCount} in-transit box(es)`}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Close-with-shortage dialog */}
      {showShortage && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-md max-w-md w-full p-4">
            <div className="text-[14px] font-semibold text-amber-800 mb-1">Close with shortage</div>
            <p className="text-[12px] text-[var(--text-secondary)] mb-3">
              Receive {resolved} acknowledged item(s) and write off{" "}
              {writeOffCount == null ? "every box still in transit" : `${writeOffCount} box(es) still in transit`}.
              The GRN is marked Received.
            </p>
            <input value={shortageReason} onChange={(e) => setShortageReason(e.target.value)}
              placeholder="Shortage reason (optional)…"
              className="w-full border border-[var(--aws-border)] rounded px-2 py-1.5 text-[12px] mb-3" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowShortage(false)} disabled={busy} className="px-3 py-1.5 text-[12px] rounded border border-[var(--aws-border)]">Cancel</button>
              <button onClick={handleCloseWithShortage} disabled={busy} className="px-3 py-1.5 text-[12px] rounded bg-amber-600 text-white disabled:opacity-40">Close &amp; write off {writeOffCount ?? "?"}</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit-receipt dialog (header fields; per-box edit is backend-supported) */}
      {showEdit && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-md max-w-md w-full p-4 space-y-3">
            <div className="text-[14px] font-semibold text-[var(--text-primary)]">Edit receipt</div>
            <div>
              <div className="text-[11px] text-[var(--text-secondary)] mb-0.5">GRN Number</div>
              <input value={editForm.grn_number} onChange={(e) => setEditForm({ ...editForm, grn_number: e.target.value })}
                className="w-full border border-[var(--aws-border)] rounded px-2 py-1.5 text-[12px]" />
            </div>
            <div>
              <div className="text-[11px] text-[var(--text-secondary)] mb-0.5">Box Condition</div>
              <select value={editForm.box_condition} onChange={(e) => setEditForm({ ...editForm, box_condition: e.target.value })}
                className="w-full border border-[var(--aws-border)] rounded px-2 py-1.5 text-[12px]">
                <option>Good</option><option>Damaged</option><option>Partial</option>
              </select>
            </div>
            <div>
              <div className="text-[11px] text-[var(--text-secondary)] mb-0.5">Condition Remarks</div>
              <input value={editForm.condition_remarks} onChange={(e) => setEditForm({ ...editForm, condition_remarks: e.target.value })}
                placeholder="Remarks…" className="w-full border border-[var(--aws-border)] rounded px-2 py-1.5 text-[12px]" />
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowEdit(false)} disabled={busy} className="px-3 py-1.5 text-[12px] rounded border border-[var(--aws-border)]">Cancel</button>
              <button onClick={handleEditSubmit} disabled={busy} className="px-3 py-1.5 text-[12px] rounded bg-[var(--aws-navy)] text-white disabled:opacity-40">Save changes</button>
            </div>
          </div>
        </div>
      )}

    </TransferChrome>
  );
}

// jsonb issue may arrive as object or string.
function parseIssueObj(issue: unknown): Record<string, unknown> | null {
  if (!issue) return null;
  if (typeof issue === "string") { try { return JSON.parse(issue); } catch { return null; } }
  return issue as Record<string, unknown>;
}

// Renders one scan outcome (mirrors job-card RM _RawMaterialTab.tsx ScanResult): the box was
// on this transfer and got acknowledged / was already done, or it's a real box from elsewhere
// (identify), an unknown code, or an error. Overwritten by the next scan; ✕ dismisses it.
function ScanReceiptResult({ scan, onDismiss }: { scan: ScanOutcome; onDismiss: () => void }) {
  const head = (tone: string, label: string) => (
    <div className="flex items-center justify-between gap-2">
      <span className={`text-[12px] px-2 py-0.5 rounded font-semibold ${tone}`}>{label}</span>
      <button onClick={onDismiss} aria-label="Dismiss" className="text-[13px] leading-none text-[var(--text-secondary)] hover:text-[var(--text-primary)]">✕</button>
    </div>
  );
  const kv = (rows: [string, React.ReactNode][]) => (
    <dl className="grid grid-cols-[minmax(84px,auto)_1fr] gap-x-4 gap-y-1 text-[12px] mt-2">
      {rows.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-[var(--text-secondary)]">{k}</dt>
          <dd className="text-[var(--text-primary)] font-mono break-all">{v}</dd>
        </div>
      ))}
    </dl>
  );

  let body: React.ReactNode;
  if (scan.status === "loading") {
    body = <div className="text-[12px] text-[var(--text-secondary)]">Looking up {scan.value}…</div>;
  } else if (scan.status === "matched") {
    const e = scan.entry;
    body = <>{head("bg-emerald-100 text-emerald-800", "✓ Acknowledged")}
      {kv([["Box ID", e.box_id], ["Article", e.article], ["Txn", e.transaction_no || "—"], ["Lot", e.lot_number || "—"], ["Net", e.net_weight.toFixed(3)], ["Gross", e.gross_weight.toFixed(3)]])}</>;
  } else if (scan.status === "already") {
    const e = scan.entry;
    body = <>{head("bg-sky-100 text-sky-800", "Already acknowledged")}{kv([["Box ID", e.box_id], ["Article", e.article]])}</>;
  } else if (scan.status === "foreign") {
    const b = scan.identify.box;
    body = <>{head("bg-amber-100 text-amber-800", "Not part of this transfer")}
      <div className="text-[11px] text-[var(--text-secondary)] mt-1">Real box, but not dispatched on this transfer — found in {scan.identify.table}{scan.identify.company ? ` (${scan.identify.company})` : ""}.</div>
      {kv([["Box ID", b.box_id], ["Item", b.item_description], ["Txn", b.transaction_no], ["Lot", b.lot_number], ["Net", b.net_weight], ["Gross", b.gross_weight], ["Status", b.status], ["Job card", b.job_card_number]])}</>;
  } else if (scan.status === "unknown") {
    body = <>{head("bg-rose-100 text-rose-800", "Unknown box")}
      <div className="text-[12px] text-rose-700 mt-1">Not found in any box table ({scan.box_id}).</div></>;
  } else {
    body = <>{head("bg-rose-100 text-rose-800", "Scan error")}
      <div className="text-[12px] text-rose-700 mt-1">{scan.error}</div></>;
  }
  return <div className="bg-white border border-[var(--aws-border)] rounded-md p-3">{body}</div>;
}

function IssueForm({ draft, setDraft, busy, onCancel, onSubmit }: {
  draft: IssueData; setDraft: (d: IssueData) => void; busy: boolean; onCancel: () => void; onSubmit: () => void;
}) {
  const field = (label: string, key: keyof IssueData, ph: string) => (
    <div>
      <div className="text-[10px] text-rose-700 mb-0.5">{label}</div>
      <input value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} placeholder={ph}
        className="w-full border border-rose-200 rounded px-2 py-1 text-[12px] bg-white" />
    </div>
  );
  return (
    <div className="space-y-2">
      <div className="text-[11px] font-medium text-rose-700">Report Issue (received quantities differ)</div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {field("Actual Net Wt", "net_weight", "kg")}
        {field("Actual Gross Wt", "gross_weight", "kg")}
        {field("Actual Qty", "qty", "units")}
        {field("Remarks", "remarks", "short / damaged / extra…")}
      </div>
      <div className="flex gap-2">
        <button onClick={onCancel} disabled={busy} className={btn("neutral", "md")}>Cancel</button>
        <button onClick={onSubmit} disabled={busy} className={btn("dangerSolid", "md")}>Submit Issue</button>
      </div>
    </div>
  );
}

export default function TransferInReceivePage() {
  return (
    <Suspense fallback={null}>
      <ReceiveInner />
    </Suspense>
  );
}
