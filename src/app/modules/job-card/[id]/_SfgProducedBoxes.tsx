"use client";

// Produced-boxes manager for the SFG Boxes tab — the Material-In "Box Sections"
// analogue (_SectionEditor.tsx), adapted to the SFG data model. Saved boxes are
// GROUPED BY BATCH (job_card_batch_v2 link) into expandable cards. Each card:
//   • editable box table (Gross / Net / Batch / Count) + per-section Update
//     (PUT /wip-boxes) — only PRINTED boxes are editable; received ones are locked;
//   • an "+ Add Boxes" panel (Count → Generate → Save New Boxes → POST /wip-boxes)
//     that appends more boxes to that batch (the backend counter continues);
//   • Print all + Print range (From#–To#) + per-box print, via the client-side
//     QR sticker printer;
//   • pagination (10 boxes/page).
// The parent already fetches ALL boxes, so grouping + pagination are client-side.

import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, readApiErrorMessage } from "@/lib/auth";
import { friendlyApiError } from "@/lib/apiErrors";
import { printSfgBoxLabels } from "./_sfgBoxLabelPrint";

const DISPLAY = 10; // boxes shown per page in a group

export type BatchOpt = {
  batch_id: number; batch_label: string | null; batch_number: number; status: string;
  // Accounting weights (from GET /batches → job_card_batch_v2). The cap a batch's
  // box net must not exceed is the first of these that is set and > 0.
  produced_qty_kg?: number | string | null;
  input_qty_kg?: number | string | null;
  planned_qty_kg?: number | string | null;
};
function batchOptLabel(b: BatchOpt): string {
  return b.batch_label?.trim() || `Batch ${b.batch_number}`;
}
// The accounting kg a batch's boxes must not exceed (produced → input → planned,
// first > 0); null when the batch has no accounting weight yet (no cap).
function batchCapKg(opt?: BatchOpt): number | null {
  if (!opt) return null;
  for (const v of [opt.produced_qty_kg, opt.input_qty_kg, opt.planned_qty_kg]) {
    const n = v == null ? 0 : Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}
// Matches the backend WEIGHT_TOLERANCE_KG (scale-rounding slack).
const WEIGHT_TOLERANCE_KG = 0.5;

export type ProducedBox = {
  box_id: string;
  sfg_code: string | null;
  fg_sku_name?: string | null;
  net_weight: number | string;
  gross_weight: number | string | null;
  batch_code?: string | null;
  batch_id?: number | null;
  units?: number | null;
  status: string;
};

// Per-JC box counter parsed from the carton_id "<base>-<counter>" — used as the
// stable "Box #" for display and print-range filtering.
function boxNum(id: string): number {
  return parseInt(id.split("-")[1] ?? "", 10) || 0;
}
function numStr(v: number | string | null | undefined): string {
  return v == null || v === "" ? "" : String(v);
}

// ── shared styles (mirror _SfgBoxCreate) ──────────────────────────────────────
const cellInput =
  "w-full h-6 px-1 text-[12px] font-mono rounded-[2px] border border-[var(--aws-border-strong)] " +
  "outline-none focus:border-[#9a393e] disabled:bg-[var(--surface-subtle)] disabled:text-[var(--text-muted)]";
const th =
  "px-2 py-1 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] whitespace-nowrap";
const smallBtn =
  "h-7 px-2 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white " +
  "hover:border-[var(--aws-navy)] disabled:opacity-50 disabled:cursor-not-allowed";

function NumInput({ className = "", ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input {...rest} type="number" className={`${className} no-spinner`} onWheel={(e) => e.currentTarget.blur()} />
  );
}

function PrinterIcon({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 6 2 18 2 18 9" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="8" />
    </svg>
  );
}

type BatchGroup = { key: string; batchId: number | null; label: string; boxes: ProducedBox[] };
type BoxEdit = { gross: string; net: string; batchId: string; count: string };
type AddRow = { box_number: number; gross: string; net: string; count: string };

export function SfgProducedBoxes({
  jcId, boxes, batches, changedKeys, onReload, focusBatchId, onFocusConsumed,
}: {
  jcId: number;
  boxes: ProducedBox[];
  batches: BatchOpt[];
  changedKeys?: Set<string>;   // "box:<id>.<field>" keys that were ever edited → red
  onReload: () => void;
  // One-shot cross-tab focus: when set, the matching batch card opens + scrolls
  // into view, then calls onFocusConsumed to clear it (see Accounting "Print QR").
  focusBatchId?: number | null;
  onFocusConsumed?: () => void;
}) {
  // ONE section per accounting batch (from the JC's batch list), whether or not it
  // has boxes yet — a blank batch still shows a card with an add-boxes prompt. Boxes
  // bucket into their batch; a box whose batch isn't in the list (stale) still gets
  // its own card, and orphan (no-batch, legacy) boxes get an "Unlinked" card.
  const groups = useMemo<BatchGroup[]>(() => {
    const byBatch = new Map<number, ProducedBox[]>();
    const orphan: ProducedBox[] = [];
    for (const b of boxes) {
      const bid = b.batch_id ?? null;
      if (bid == null) { orphan.push(b); continue; }
      const arr = byBatch.get(bid);
      if (arr) arr.push(b); else byBatch.set(bid, [b]);
    }
    const out: BatchGroup[] = [];
    for (const opt of [...batches].sort((a, b) => a.batch_number - b.batch_number)) {
      out.push({ key: String(opt.batch_id), batchId: opt.batch_id, label: batchOptLabel(opt), boxes: byBatch.get(opt.batch_id) ?? [] });
      byBatch.delete(opt.batch_id);
    }
    for (const [bid, arr] of byBatch) {
      out.push({ key: String(bid), batchId: bid, label: arr[0]?.batch_code?.trim() || `Batch ${bid}`, boxes: arr });
    }
    if (orphan.length) out.push({ key: "none", batchId: null, label: "Unlinked (no batch)", boxes: orphan });
    return out;
  }, [boxes, batches]);

  if (groups.length === 0) {
    return <div className="text-[12px] text-[var(--text-muted)] italic">No batches yet — create one in the Accounting tab, then boxes can be added per batch here.</div>;
  }
  return (
    <div className="space-y-2">
      {groups.map((g) => (
        <BatchGroupCard
          key={g.key}
          jcId={jcId}
          group={g}
          batches={batches}
          changedKeys={changedKeys}
          onReload={onReload}
          focused={focusBatchId != null && g.batchId === focusBatchId}
          onFocusConsumed={onFocusConsumed}
        />
      ))}
    </div>
  );
}

function BatchGroupCard({
  jcId, group, batches, changedKeys, onReload, focused, onFocusConsumed,
}: {
  jcId: number;
  group: BatchGroup;
  batches: BatchOpt[];
  changedKeys?: Set<string>;
  onReload: () => void;
  focused?: boolean;
  onFocusConsumed?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const [edits, setEdits] = useState<Record<string, BoxEdit>>({});
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState<null | "update" | "add">(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Add-boxes panel.
  const [addOpen, setAddOpen] = useState(false);
  const [addCount, setAddCount] = useState("");
  const [addTare, setAddTare] = useState("");
  const [addRows, setAddRows] = useState<AddRow[] | null>(null);

  // Print-range popover.
  const [rangeOpen, setRangeOpen] = useState(false);
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");

  // Cross-tab focus (Accounting "Print QR"): scroll this card into view, expand it,
  // open the add panel, then clear the parent's one-shot focus. scrollIntoView is a
  // plain DOM side-effect; the setState trio is deferred (queueMicrotask idiom) to
  // satisfy react-hooks/set-state-in-effect. The `focused` guard keeps it one-shot.
  useEffect(() => {
    if (!focused) return;
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    queueMicrotask(() => {
      setOpen(true);
      setAddOpen(true);   // Print QR lands ready to add/print boxes for this batch.
      onFocusConsumed?.();
    });
  }, [focused, onFocusConsumed]);

  const gboxes = group.boxes;
  const total = gboxes.length;
  const totalPages = Math.max(1, Math.ceil(total / DISPLAY));
  const clampedPage = Math.min(page, totalPages);
  const start = (clampedPage - 1) * DISPLAY;
  const pageBoxes = gboxes.slice(start, start + DISPLAY);
  const nums = gboxes.map((b) => boxNum(b.box_id));
  const minNum = nums.length ? Math.min(...nums) : 0;
  const maxNum = nums.length ? Math.max(...nums) : 0;

  // Accounting weight cap for this batch, current Σ box net (with pending edits),
  // and the Σ that a pending "Add Boxes" draft would push it to.
  const capOpt = group.batchId != null ? batches.find((x) => x.batch_id === group.batchId) : undefined;
  const capKg = batchCapKg(capOpt);
  const sumNet = gboxes.reduce((s, b) => s + (Number(edits[b.box_id]?.net ?? b.net_weight) || 0), 0);
  const addNet = (addRows ?? []).reduce((s, r) => s + (Number(r.net) || 0), 0);
  const overCap = capKg != null && sumNet > capKg + WEIGHT_TOLERANCE_KG;
  const addOverCap = capKg != null && sumNet + addNet > capKg + WEIGHT_TOLERANCE_KG;

  const rowVal = (b: ProducedBox, field: keyof BoxEdit): string => {
    const e = edits[b.box_id];
    if (e) return e[field];
    if (field === "gross") return numStr(b.gross_weight);
    if (field === "net") return numStr(b.net_weight);
    if (field === "batchId") return b.batch_id != null ? String(b.batch_id) : "";
    return b.units != null ? String(b.units) : "";
  };

  const seed = (b: ProducedBox): BoxEdit => ({
    gross: numStr(b.gross_weight),
    net: numStr(b.net_weight),
    batchId: b.batch_id != null ? String(b.batch_id) : "",
    count: b.units != null ? String(b.units) : "",
  });

  const setBoxField = (b: ProducedBox, field: keyof BoxEdit, value: string) => {
    setEdits((prev) => ({ ...prev, [b.box_id]: { ...(prev[b.box_id] ?? seed(b)), [field]: value } }));
  };

  // Build the PUT payload item for one box: its current values (edit overlay, else
  // the box's own values via seed — so an unedited box still saves its FULL state
  // and nothing is erased). markPrinted flips PENDING → PRINTED server-side.
  const buildItem = (b: ProducedBox, markPrinted: boolean) => {
    const e = edits[b.box_id] ?? seed(b);
    const bid = e.batchId ? Number(e.batchId) : null;
    const opt = bid != null ? batches.find((x) => x.batch_id === bid) : undefined;
    // batch_code follows the SELECTED batch's name. When we can't resolve a name
    // (batches list not loaded / partial) but the box is still linked, keep its
    // existing batch_code — don't wipe it. Only a genuine unlink clears it.
    const batch_code = bid == null ? null : (opt ? batchOptLabel(opt) : (b.batch_code ?? null));
    return {
      box_id: b.box_id,
      net_weight: Number(e.net),
      gross_weight: e.gross.trim() === "" ? null : Number(e.gross),
      batch_id: bid,
      batch_code,
      units: e.count.trim() === "" ? null : Number(e.count),
      mark_printed: markPrinted,
    };
  };

  const isEditable = (b: ProducedBox) => b.status === "PENDING" || b.status === "PRINTED";

  async function doUpdate() {
    // Save the edited (editable) boxes — status unchanged; only the print action
    // flips to PRINTED. Only rows the operator actually touched are sent.
    const payload = gboxes
      .filter((b) => isEditable(b) && edits[b.box_id])
      .map((b) => buildItem(b, false))
      .filter((b) => Number.isFinite(b.net_weight) && b.net_weight > 0);
    if (payload.length === 0) { setMsg({ kind: "err", text: "No edited boxes with a valid net weight to update." }); return; }
    if (payload.some((p) => p.batch_id == null)) { setMsg({ kind: "err", text: "Every box must be linked to a batch — pick a batch for the box(es) you cleared." }); return; }
    if (overCap) { setMsg({ kind: "err", text: `This batch's box net (${sumNet.toFixed(3)} kg) exceeds its accounting ${capKg} kg. Reduce weights first.` }); return; }
    setBusy("update");
    setMsg(null);
    try {
      const res = await apiFetch(`/api/v1/production/job-cards-v2/${jcId}/wip-boxes`, {
        method: "PUT", body: JSON.stringify({ boxes: payload }),
      });
      if (!res.ok) { setMsg({ kind: "err", text: await readApiErrorMessage(res, "Update failed") }); return; }
      const data = (await res.json()) as { updated?: unknown[]; skipped?: { box_id: string }[] };
      const nUp = data.updated?.length ?? 0;
      const nSk = data.skipped?.length ?? 0;
      setEdits({});
      setMsg({ kind: "ok", text: `Updated ${nUp} box(es)${nSk ? ` · ${nSk} skipped (locked)` : ""}.` });
      onReload();
    } catch (e) {
      setMsg({ kind: "err", text: friendlyApiError(e) });
    } finally {
      setBusy(null);
    }
  }

  // Print action: persist each editable box's current data AND flip it to PRINTED,
  // then print the labels. Boxes default to PENDING at creation; a box becomes
  // PRINTED only here. Locked (received/consumed) boxes just print, no save.
  async function saveAndPrint(boxesToPrint: ProducedBox[]) {
    if (boxesToPrint.length === 0) return;
    // Label data (QR + printable details) from each box's EFFECTIVE values
    // (edit overlay via buildItem), so a just-edited box prints its new values.
    const labels = boxesToPrint.map((b) => {
      const it = buildItem(b, false);
      return {
        box_id: b.box_id,
        batch: it.batch_code ?? group.label ?? null,
        article: b.fg_sku_name ?? null,
        sfg: b.sfg_code ?? null,
        net: it.net_weight,
        gross: it.gross_weight,
        count: it.units,
      };
    });
    const payload = boxesToPrint
      .filter(isEditable)
      .map((b) => buildItem(b, true))
      .filter((b) => Number.isFinite(b.net_weight) && b.net_weight > 0);
    if (payload.some((p) => p.batch_id == null)) { setMsg({ kind: "err", text: "Every box must be linked to a batch before printing." }); return; }
    setBusy("update");
    setMsg(null);
    try {
      if (payload.length > 0) {
        const res = await apiFetch(`/api/v1/production/job-cards-v2/${jcId}/wip-boxes`, {
          method: "PUT", body: JSON.stringify({ boxes: payload }),
        });
        if (!res.ok) { setMsg({ kind: "err", text: await readApiErrorMessage(res, "Save before print failed") }); return; }
      }
      await printSfgBoxLabels(labels);
      if (payload.length > 0) {
        // Drop the saved boxes' edit overlay so the reloaded server values show.
        const saved = new Set(payload.map((p) => p.box_id));
        setEdits((prev) => { const n = { ...prev }; for (const id of saved) delete n[id]; return n; });
        onReload();
      }
    } catch (e) {
      setMsg({ kind: "err", text: friendlyApiError(e) });
    } finally {
      setBusy(null);
    }
  }

  function genAdd() {
    const n = parseInt(addCount, 10);
    if (!Number.isFinite(n) || n < 1) return;
    setAddRows(Array.from({ length: n }, (_, i) => ({ box_number: i + 1, gross: "", net: "", count: "" })));
  }
  function setAddField(idx: number, field: "gross" | "net" | "count", value: string) {
    setAddRows((prev) => {
      if (!prev) return prev;
      const t = Number(addTare) || 0;
      return prev.map((r, j) => {
        if (j !== idx) return r;
        if (field === "gross") {
          const g = Number(value);
          const net = Number.isFinite(g) ? Math.max(0, Math.round((g - t) * 1000) / 1000) : 0;
          return { ...r, gross: value, net: value === "" ? "" : String(net) };
        }
        return { ...r, [field]: value };
      });
    });
  }
  async function doAdd() {
    const rows = (addRows ?? [])
      .map((r) => ({
        net_weight: Number(r.net),
        gross_weight: r.gross.trim() === "" ? null : Number(r.gross),
        batch_id: group.batchId,
        batch_code: group.batchId != null ? group.label : null,
        units: r.count.trim() === "" ? null : Number(r.count),
      }))
      .filter((r) => Number.isFinite(r.net_weight) && r.net_weight > 0);
    if (rows.length === 0) { setMsg({ kind: "err", text: "Enter at least one box with net weight > 0." }); return; }
    if (addOverCap) { setMsg({ kind: "err", text: `Adding these boxes pushes this batch to ${(sumNet + addNet).toFixed(3)} kg, over its accounting ${capKg} kg.` }); return; }
    setBusy("add");
    setMsg(null);
    try {
      const res = await apiFetch(`/api/v1/production/job-cards-v2/${jcId}/wip-boxes`, {
        method: "POST", body: JSON.stringify({ boxes: rows, expected_net_kg: null }),
      });
      if (!res.ok) { setMsg({ kind: "err", text: await readApiErrorMessage(res, "Could not add boxes") }); return; }
      const data = (await res.json()) as { box_ids?: string[] };
      setAddRows(null); setAddCount(""); setAddOpen(false);
      setMsg({ kind: "ok", text: `Added ${data.box_ids?.length ?? rows.length} box(es).` });
      onReload();
    } catch (e) {
      setMsg({ kind: "err", text: friendlyApiError(e) });
    } finally {
      setBusy(null);
    }
  }

  function printRange() {
    const f = parseInt(rangeFrom, 10);
    const t = parseInt(rangeTo, 10);
    let lo = Number.isFinite(f) ? f : minNum;
    let hi = Number.isFinite(t) ? t : maxNum;
    if (lo > hi) { const tmp = lo; lo = hi; hi = tmp; }
    const inRange = gboxes.filter((b) => { const n = boxNum(b.box_id); return n >= lo && n <= hi; });
    setRangeOpen(false);
    void saveAndPrint(inRange);
  }

  return (
    <div ref={cardRef} className="border border-[var(--aws-border)] rounded-[2px] p-2.5 bg-[var(--surface-subtle)] scroll-mt-2">
      <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="text-[12px] font-semibold text-[var(--text-primary)] inline-flex items-center gap-1.5"
        >
          <span className={["text-[10px] transition-transform inline-block", open ? "rotate-90" : ""].join(" ")} aria-hidden>▸</span>
          {group.label}
          <span className="text-[11px] font-normal text-[var(--text-muted)]">· {total} box{total !== 1 ? "es" : ""}</span>
          {capKg != null ? (
            <span className={`text-[11px] font-normal ${overCap ? "text-[#b1361e] font-semibold" : "text-[var(--text-muted)]"}`}>
              · Σ net {sumNet.toFixed(3)} / {capKg.toFixed(3)} kg
            </span>
          ) : null}
        </button>
        <div className="flex items-center gap-1.5 flex-wrap">
          <button type="button" className={smallBtn} disabled={group.batchId == null}
            title={group.batchId == null ? "Unlinked boxes — assign each a batch (Batch column → Update) before adding more" : undefined}
            onClick={() => { setAddOpen((v) => !v); setOpen(true); }}>+ Add Boxes</button>
          <button type="button" className={smallBtn} disabled={busy !== null || Object.keys(edits).length === 0 || overCap} onClick={() => void doUpdate()}>
            {busy === "update" ? "Updating…" : "Update"}
          </button>
          <button
            type="button" onClick={() => void saveAndPrint(gboxes)} disabled={total === 0 || busy !== null}
            title="Print all boxes in this batch (saves + marks printed)"
            className="h-7 px-2 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[#2c5fa8] hover:text-[#2c5fa8] inline-flex items-center gap-1 disabled:opacity-50"
          >
            <PrinterIcon /> Print all ({total})
          </button>
          <div className="relative">
            <button
              type="button" disabled={total === 0} onClick={() => { setRangeOpen((v) => !v); setRangeFrom(String(minNum)); setRangeTo(String(maxNum)); }}
              title="Print a box-number range"
              className="h-7 px-2 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[#2c5fa8] hover:text-[#2c5fa8] inline-flex items-center gap-1 disabled:opacity-50"
            >
              <PrinterIcon /> Range
            </button>
            {rangeOpen ? (
              <div className="absolute right-0 top-full mt-1 z-50 w-56 bg-white border border-[var(--aws-border-strong)] rounded-[2px] shadow-lg p-2.5">
                <div className="text-[11px] text-[var(--text-secondary)] mb-1.5">Print boxes #{minNum}–#{maxNum}</div>
                <div className="flex items-center gap-1.5 mb-2">
                  <NumInput value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} aria-label="From box number"
                    className="w-16 h-7 px-1.5 text-[12px] font-mono rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e]" />
                  <span className="text-[11px] text-[var(--text-muted)]">to</span>
                  <NumInput value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} aria-label="To box number"
                    className="w-16 h-7 px-1.5 text-[12px] font-mono rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e]" />
                </div>
                <button type="button" onClick={printRange}
                  className="w-full h-7 text-[12px] rounded-[2px] bg-[var(--aws-navy)] text-white hover:bg-[#002244] inline-flex items-center justify-center gap-1">
                  <PrinterIcon /> Print range
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {msg ? (
        <div className={[
          "text-[11px] px-2 py-1 rounded mb-2 border",
          msg.kind === "ok" ? "bg-[#eaf6ed] border-[#b6dbb1] text-[#1d8102]" : "bg-[#fdf3f1] border-[#f0c7be] text-[#b1361e]",
        ].join(" ")}>{msg.text}</div>
      ) : null}

      {open && total > 0 ? (
        <>
          <div className="overflow-x-auto rounded-[2px] border border-[var(--aws-border)] bg-white">
            <table className="w-full text-[12px] border-collapse">
              <thead className="bg-[var(--surface-subtle)]">
                <tr className="border-b border-[var(--aws-border)]">
                  <th className={`${th} w-8`} aria-label="Print" />
                  <th className={th}>Box #</th>
                  <th className={th}>Box ID</th>
                  <th className={th}>SFG</th>
                  <th className={th}>Gross Wt (kg)</th>
                  <th className={th}>Net Wt (kg)</th>
                  <th className={th}>Batch</th>
                  <th className={th}>Count</th>
                  <th className={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {pageBoxes.map((b) => {
                  const locked = !isEditable(b); // PENDING/PRINTED editable; received/consumed locked
                  // A field ever edited (per the JC edit log) gets a light-red input.
                  const red = (field: string) =>
                    changedKeys?.has(`box:${b.box_id}.${field}`) ? " bg-[#fbeced]" : "";
                  return (
                    <tr key={b.box_id} className={"border-b border-[var(--aws-border)] last:border-b-0" + (b.status === "PRINTED" ? " bg-[#eaf6ed]" : "")}>
                      <td className="px-1.5 py-1">
                        <button type="button" title="Print this box (saves it + marks printed)" aria-label="Print box"
                          disabled={busy !== null} onClick={() => void saveAndPrint([b])}
                          className="p-1 rounded hover:bg-[#eaf0fb] text-[var(--text-secondary)] hover:text-[#2c5fa8] disabled:opacity-50 disabled:cursor-not-allowed">
                          <PrinterIcon size={11} />
                        </button>
                      </td>
                      <td className="px-2 py-1 font-mono text-[var(--text-muted)] whitespace-nowrap">{boxNum(b.box_id)}</td>
                      <td className="px-2 py-1 font-mono text-[var(--aws-link)] font-semibold whitespace-nowrap">{b.box_id}</td>
                      <td className="px-2 py-1 whitespace-nowrap">{b.fg_sku_name || b.sfg_code || "—"}</td>
                      <td className="px-2 py-1 w-28">
                        <NumInput step="0.001" inputMode="decimal" placeholder="0.000" disabled={locked}
                          className={cellInput + red("gross_weight")} value={rowVal(b, "gross")} onChange={(e) => setBoxField(b, "gross", e.target.value)} />
                      </td>
                      <td className="px-2 py-1 w-28">
                        <NumInput step="0.001" inputMode="decimal" placeholder="0.000" disabled={locked}
                          className={cellInput + red("net_weight")} value={rowVal(b, "net")} onChange={(e) => setBoxField(b, "net", e.target.value)} />
                      </td>
                      <td className="px-2 py-1 w-40">
                        <select className={cellInput + red("batch_code")} value={rowVal(b, "batchId")} disabled={locked}
                          onChange={(e) => setBoxField(b, "batchId", e.target.value)}>
                          <option value="">— Select batch —</option>
                          {batches.map((bt) => (
                            <option key={bt.batch_id} value={String(bt.batch_id)}>{batchOptLabel(bt)}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-2 py-1 w-20">
                        <NumInput step="1" inputMode="numeric" placeholder="0" disabled={locked}
                          className={cellInput + red("units")} value={rowVal(b, "count")} onChange={(e) => setBoxField(b, "count", e.target.value)} />
                      </td>
                      <td className="px-2 py-1 capitalize whitespace-nowrap">{(b.status || "—").toLowerCase()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {totalPages > 1 ? (
            <div className="flex items-center gap-2 text-[12px] mt-1.5">
              <button type="button" className={smallBtn} disabled={clampedPage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>‹</button>
              <span className="text-[var(--text-secondary)]">Page {clampedPage} of {totalPages}</span>
              <span className="text-[var(--text-muted)]">(Box {start + 1}–{Math.min(start + DISPLAY, total)} of {total})</span>
              <button type="button" className={smallBtn} disabled={clampedPage >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>›</button>
            </div>
          ) : null}
        </>
      ) : null}

      {open && total === 0 ? (
        <div className="text-[12px] text-[var(--text-muted)] italic mb-2">No boxes in this batch yet — add boxes below.</div>
      ) : null}

      {addOpen || (open && total === 0) ? (
        <div className="mt-2 border-t border-[var(--aws-border)] pt-2">
          <div className="flex flex-wrap items-end gap-2 mb-2">
            <label className="text-[11px] font-semibold text-[var(--text-primary)]">
              Empty Carton / Tare (kg)
              <NumInput step="0.001" inputMode="decimal" placeholder="0.000" value={addTare}
                onChange={(e) => setAddTare(e.target.value)}
                className="block w-28 h-7 px-1.5 mt-0.5 text-[12px] font-mono rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e]" />
            </label>
            <label className="text-[11px] font-semibold text-[var(--text-primary)]">
              Number of Boxes
              <NumInput step="1" inputMode="numeric" min="1" value={addCount} placeholder="e.g. 50"
                onChange={(e) => setAddCount(e.target.value)}
                className="block w-24 h-7 px-1.5 mt-0.5 text-[12px] font-mono rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e]" />
            </label>
            <button type="button" className={smallBtn} disabled={!(parseInt(addCount, 10) >= 1)} onClick={genAdd}>Generate</button>
            <button type="button" className={smallBtn} disabled={busy !== null || !addRows?.length || addOverCap} onClick={() => void doAdd()}>
              {busy === "add" ? "Saving…" : "Save New Boxes"}
            </button>
          </div>
          {addRows?.length ? (
            <div className="overflow-x-auto rounded-[2px] border border-[var(--aws-border)] bg-white">
              <table className="w-full text-[12px] border-collapse">
                <thead className="bg-[var(--surface-subtle)]">
                  <tr className="border-b border-[var(--aws-border)]">
                    <th className={th}>Box #</th>
                    <th className={th}>Gross Wt (kg)</th>
                    <th className={th}>Net Wt (kg)</th>
                    <th className={th}>Count</th>
                  </tr>
                </thead>
                <tbody>
                  {addRows.map((r, idx) => (
                    <tr key={r.box_number} className="border-b border-[var(--aws-border)] last:border-b-0">
                      <td className="px-2 py-1 font-mono text-[var(--text-muted)] whitespace-nowrap">{r.box_number}</td>
                      <td className="px-2 py-1 w-28"><NumInput step="0.001" inputMode="decimal" placeholder="0.000" className={cellInput} value={r.gross} onChange={(e) => setAddField(idx, "gross", e.target.value)} /></td>
                      <td className="px-2 py-1 w-28"><NumInput step="0.001" inputMode="decimal" placeholder="0.000" className={cellInput} value={r.net} onChange={(e) => setAddField(idx, "net", e.target.value)} /></td>
                      <td className="px-2 py-1 w-20"><NumInput step="1" inputMode="numeric" placeholder="0" className={cellInput} value={r.count} onChange={(e) => setAddField(idx, "count", e.target.value)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-[11px] text-[var(--text-muted)] italic">
              Enter a count and click Generate. New boxes join <strong>{group.label}</strong>.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
