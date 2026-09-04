"use client";

// Transfer-OUT View — read-only detail of one interunit dispatch (doc 09). Header info,
// consolidated item cards (lines deduped by desc+category+pack_size), and per-box cards
// with weight rollups. Pure display — no edit/print/actions. Backed by the existing
// GET /api/v1/transfer/transfers/{id}. (The rebuild returns canonical field names, so no
// dual-key fallbacks; from_cold_unit + per-box source_unit ARE shown — the reference omitted
// them, but the data is in the payload and useful here.)

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { TransferChrome } from "../../_chrome";
import { TransferApi, type TransferDetail, type TransferLine } from "@/lib/transfer";
import { getDisplayWarehouseName } from "@/lib/transferBuildSummary";
import { BoxHistoryModal } from "../../_BoxHistoryModal";
import { EditHeaderPanel } from "../../_EditHeaderPanel";

function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

// The backend fills a blank line uom from all_sku.uom — a NUMERIC pack-weight column — so the
// API hands back strings like "0.000" / "1.000". Those are non-empty, so `l.uom || "—"` never
// fired and printed a pack weight as a unit of measure. Test for a VALID unit instead: the
// vocabulary chk_uom allows plus the legacy values that exist on live rows. Anything that
// parses as a number is not a UOM.
const VALID_UOMS = new Set([
  "KG", "KGS", "PCS", "NOS", "BOX", "BOXES", "CARTON", "CARTONS",
  "BAG", "BAGS", "BUNDLE", "BUNDLES", "ROLL", "ROLLS",
]);
function displayUom(v?: string | null): string {
  const s = (v || "").trim().toUpperCase();
  return VALID_UOMS.has(s) ? s : "—";
}

function formatDate(d?: string | null): string {
  if (!d) return "N/A";
  if (/^\d{2}-\d{2}-\d{4}$/.test(d)) return d;   // backend already emits DD-MM-YYYY
  try {
    return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }).replace(/\//g, "-");
  } catch {
    return d;
  }
}

function statusTone(status?: string | null): string {
  switch ((status || "").toLowerCase()) {
    case "pending": return "bg-amber-100 text-amber-800";
    case "approved": case "accept": return "bg-emerald-100 text-emerald-800";
    case "in transit": return "bg-sky-100 text-sky-800";
    case "partially transferred": case "partiallytransferred": case "partial": return "bg-orange-100 text-orange-800";
    case "completed": case "dispatch": return "bg-sky-100 text-sky-800";
    default: return "bg-gray-100 text-gray-700";
  }
}

type ConsolidatedLine = TransferLine & { _box_count: number };

function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="text-center">
      <div className="text-[18px] font-semibold text-[var(--text-primary)]">{value}</div>
      <div className="text-[11px] text-[var(--text-secondary)]">{label}</div>
    </div>
  );
}

export default function TransferViewPage() {
  const router = useRouter();
  const allowed = useRequireAuth(router.replace);
  const params = useParams<{ transferId: string }>();
  const transferId = params?.transferId;

  const [transfer, setTransfer] = useState<TransferDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // Which box the traceability drawer is open on. box_id alone is ambiguous — the label
  // repeats across inward batches — so the transaction_no travels with it.
  const [histBox, setHistBox] = useState<{ box_id: string; transaction_no?: string | null } | null>(null);

  const load = useCallback(async () => {
    if (!transferId) return;
    setLoading(true);
    setError(null);
    try {
      const r = await TransferApi.getTransfer(Number(transferId));
      setTransfer(r);
    } catch (e) {
      setTransfer(null);
      setError(e instanceof Error ? e.message : "Failed to load transfer");
    } finally {
      setLoading(false);
    }
  }, [transferId]);

  useEffect(() => {
    if (!allowed) return;
    queueMicrotask(() => { load(); });
  }, [allowed, load]);

  // Boxes per LINE id — interunit_transfer_boxes.transfer_line_id is the authoritative
  // link. The Boxes column used to count merged LINES, which is not the same number: an
  // accepted request is one line per article covering many boxes, and a manually-keyed
  // line has no box row at all.
  const boxesByLine = useMemo(() => {
    const m = new Map<number, number>();
    for (const b of transfer?.boxes ?? []) {
      if (b.transfer_line_id == null) continue;
      m.set(b.transfer_line_id, (m.get(b.transfer_line_id) || 0) + 1);
    }
    return m;
  }, [transfer?.boxes]);

  // Consolidate lines by description + category + pack_size + lot + batch (sum qty / net /
  // total). pack_size goes through num() so "25" and "25.000" are one row, not two. Lot and
  // batch are part of the key because the merged row still PRINTS them: keying on description
  // alone kept the FIRST line's lot while summing every lot's quantity into it, so transfer
  // 1613 asserted all 800 boxes came from lot 8065 while the Lot Summary on the same page
  // listed 8065 / 8078 / 8081. Phantom lines (blank / "N/A" description) are dropped first,
  // the same way the Delivery Challan drops them, so both screens describe the same rows.
  const consolidatedLines = useMemo<ConsolidatedLine[]>(() => {
    const map = new Map<string, ConsolidatedLine>();
    for (const l of transfer?.lines ?? []) {
      const desc = (l.item_description || "").trim();
      if (!desc || desc.toUpperCase() === "N/A") continue;
      const key = `${desc.toUpperCase()}__${(l.item_category || "").trim().toUpperCase()}__${num(l.pack_size)}__${(l.lot_number || "").trim().toUpperCase()}__${(l.batch_number || "").trim().toUpperCase()}`;
      const boxCount = boxesByLine.get(l.id) || 0;
      const existing = map.get(key);
      if (existing) {
        existing.quantity = String(num(existing.quantity) + num(l.quantity));
        existing.net_weight = (num(existing.net_weight) + num(l.net_weight)).toFixed(3);
        existing.total_weight = (num(existing.total_weight) + num(l.total_weight)).toFixed(3);
        existing._box_count += boxCount;
      } else {
        map.set(key, { ...l, _box_count: boxCount });
      }
    }
    return Array.from(map.values());
  }, [transfer?.lines, boxesByLine]);

  // "Items" means distinct ARTICLES — the definition the dashboard card the user clicked from
  // uses (query_service: COUNT(DISTINCT item_desc_raw)). Counting display rows made one
  // dispatch report two different item counts on two screens: transfer 335 is a single article
  // weighed into 23 bags, which the dashboard calls 1 item and this tile called 23.
  const itemsCount = useMemo(() => {
    const seen = new Set<string>();
    for (const l of transfer?.lines ?? []) {
      const desc = (l.item_description || "").trim();
      if (!desc || desc.toUpperCase() === "N/A") continue;
      seen.add(desc.toUpperCase());
    }
    return seen.size;
  }, [transfer?.lines]);

  // No `if (!allowed) return null` gate: useRequireAuth returns true on the server but
  // false on the client's first render, so gating the render on it causes a hydration
  // mismatch. The loading/error guards below already protect the body; effects are gated
  // on `allowed` and the hook redirects unauthenticated users.

  const boxes = transfer?.boxes ?? [];
  const grns = transfer?.grn_records ?? [];
  const totalNet = boxes.reduce((s, b) => s + num(b.net_weight), 0);
  // gross_weight is optional end-to-end and defaults to "0.00" rather than null, so gross is
  // known per BOX, never per transfer. Guarding on the aggregate (totalGross > 0) only closed
  // the all-zero case: on a partly-weighed dispatch it still subtracted every box's net from
  // just the weighed boxes' gross, so transfer 1845 printed Total Gross 83.78 kg under Total
  // Net 100.90 kg and Packaging −17.12 kg. Both figures cover the weighed boxes only, and the
  // tiles say how many that is — an unmeasured box must not read as weighing zero.
  const grossBoxes = boxes.filter((b) => num(b.gross_weight) > 0);
  const totalGross = grossBoxes.reduce((s, b) => s + num(b.gross_weight), 0);
  const grossBoxesNet = grossBoxes.reduce((s, b) => s + num(b.net_weight), 0);
  const hasGross = grossBoxes.length > 0;
  const packaging = totalGross - grossBoxesNet;
  const grossScope = hasGross && grossBoxes.length !== boxes.length ? ` (${grossBoxes.length} of ${boxes.length} boxes)` : "";
  // GRN received_boxes is COUNT(tib.id) over the receipt's scanned rows (query_service) —
  // matched or not, on a GRN that may still be Pending. It is not a count of THIS dispatch's
  // cartons, so "received / dispatched" was a ratio between two different sets of physical
  // things (transfer 1891 read 157 / 78; transfer 653, fully received, read 3 / 711). Until
  // the API exposes the reconciled claim (receive_service._claimed_pending_box_ids), the two
  // counts are shown as separate figures and never as a fraction.
  const receivedBoxes = grns.reduce((s, g) => s + (g.received_boxes || 0), 0);
  // Per-lot rollup across boxes. Origin is the first NON-EMPTY unit across the lot's boxes:
  // reading it only when the accumulator was created made the attribution depend on
  // box_number order — transfer 477's lot 185903 printed "—" because its first carton carries
  // no origin while its later ones name Rishi, and transfer 664's identical lot printed
  // "Rishi" purely because its first carton happened to carry it. Names are normalised before
  // dedupe so "rishi cold" and "Rishi" are not two origins.
  const lotSummary = Object.values(
    boxes.reduce<Record<string, { lot: string; origins: Set<string>; count: number; net: number }>>((acc, b) => {
      const lot = b.lot_number || "—";
      if (!acc[lot]) acc[lot] = { lot, origins: new Set<string>(), count: 0, net: 0 };
      const origin = (b.lot_origin_unit || b.source_unit || "").trim();
      if (origin) acc[lot].origins.add(getDisplayWarehouseName(origin) || origin);
      acc[lot].count += 1;
      acc[lot].net += num(b.net_weight);
      return acc;
    }, {}),
  );

  return (
    <TransferChrome title="Transfer-Out View">
      {/* Print stylesheet. Without one, the Print button below handed window.print() the
          whole application — sidebar, nav, the Back link and the buttons themselves.
          Same visibility technique the Delivery Challan uses (this codebase has no
          styled-jsx), scoped to .tv-print so only the detail body reaches paper. */}
      <style dangerouslySetInnerHTML={{ __html: `
        @media print {
          body * { visibility: hidden; }
          .tv-print, .tv-print * { visibility: visible; }
          .tv-print { position: absolute; top: 0; left: 0; width: 100%; }
          .tv-noprint { display: none !important; }
          /* The on-screen tables cap their height and scroll (sticky headers); on paper that
             would silently CLIP every row past the fold. Release both for print. */
          .tv-print .overflow-auto { max-height: none !important; overflow: visible !important; }
          .tv-print thead { position: static !important; }
          body, * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
        }
      ` }} />
      <button onClick={() => router.push("/modules/transfer")}
        className="tv-noprint text-[12px] text-[var(--text-secondary)] hover:underline mb-3">← Back to Transfer dashboard</button>

      {loading ? (
        <div className="py-16 flex items-center justify-center gap-2 text-[13px] text-[var(--text-secondary)]">
          <div className="h-5 w-5 rounded-full border-2 border-[var(--aws-border)] border-t-[var(--aws-navy)] animate-spin" />
          Loading transfer details…
        </div>
      ) : error ? (
        <div className="bg-white border border-rose-200 rounded-md py-10 text-center">
          <div className="text-[13px] text-rose-700">Error: {error}</div>
          <button onClick={() => load()}
            className="mt-3 border border-[var(--aws-border)] bg-white text-[12px] px-3 py-1.5 rounded hover:border-[var(--aws-navy)]">Retry</button>
        </div>
      ) : !transfer ? (
        <div className="bg-white border border-[var(--aws-border)] rounded-md py-10 text-center">
          <div className="text-[13px] text-[var(--text-secondary)]">Transfer not found.</div>
          <button onClick={() => router.push("/modules/transfer")}
            className="mt-3 border border-[var(--aws-border)] bg-white text-[12px] px-3 py-1.5 rounded hover:border-[var(--aws-navy)]">Back to Transfer dashboard</button>
        </div>
      ) : (
        <div className="tv-print space-y-4">
          {/* Header */}
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h1 className="text-[18px] font-semibold text-[var(--text-primary)]">{transfer.challan_no}</h1>
              <div className="text-[12px] text-[var(--text-secondary)]">Transfer OUT{transfer.request_no ? ` — from request ${transfer.request_no}` : ""}</div>
              <div className="text-[13px] font-medium text-[var(--text-primary)] mt-1">
                {getDisplayWarehouseName(transfer.from_warehouse) || "N/A"} <span className="text-[var(--text-secondary)]">→</span> {getDisplayWarehouseName(transfer.to_warehouse) || "N/A"}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${statusTone(transfer.status)}`}>{transfer.status}</span>
              {grns.length === 0 && <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-gray-100 text-gray-600">Not yet received</span>}
              <button onClick={() => setEditing((v) => !v)}
                className="tv-noprint border border-[var(--aws-border)] bg-white text-[12px] px-3 py-1.5 rounded hover:border-[var(--aws-navy)]">
                {editing ? "Close editor" : "Edit details"}
              </button>
              <button onClick={() => router.push(`/modules/transfer/dc/${transferId}`)}
                className="tv-noprint border border-[var(--aws-border)] bg-white text-[12px] px-3 py-1.5 rounded hover:border-[var(--aws-navy)]">Delivery Challan</button>
              <button onClick={() => window.print()}
                className="tv-noprint border border-[var(--aws-border)] bg-white text-[12px] px-3 py-1.5 rounded hover:border-[var(--aws-navy)]">Print</button>
            </div>
          </div>

          {editing && (
            <EditHeaderPanel transfer={transfer}
              onSaved={(updated) => { setTransfer(updated); setEditing(false); }}
              onCancel={() => setEditing(false)} />
          )}

          {transfer.has_variance && (
            <div className="text-[12px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
              ⚠ Weight / box-count variance flagged on this transfer.
            </div>
          )}

          {/* Transfer information */}
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-4 space-y-4">
            <div className="text-[13px] font-semibold text-[var(--text-primary)]">Transfer information</div>
            {(() => {
              const infoRows = ([
                { l: "Transfer Date", v: formatDate(transfer.stock_trf_date) },
                { l: "From", v: getDisplayWarehouseName(transfer.from_warehouse) || "N/A" },
                { l: "To", v: getDisplayWarehouseName(transfer.to_warehouse) || "N/A" },
                transfer.from_cold_unit && { l: "Cold Unit", v: getDisplayWarehouseName(transfer.from_cold_unit) || transfer.from_cold_unit },
                transfer.request_no && { l: "Request No", v: transfer.request_no },
                { l: "Vehicle", v: transfer.vehicle_no || "N/A" },
                transfer.driver_name && { l: "Driver", v: transfer.driver_name },
                transfer.approved_by && { l: "Approval Authority", v: transfer.approved_by },
                transfer.created_by && { l: "Created By", v: transfer.created_by },
                transfer.created_ts && { l: "Created", v: formatDate(transfer.created_ts) },
                transfer.approved_ts && { l: "Approved", v: formatDate(transfer.approved_ts) },
                transfer.reason_code && { l: "Reason", v: transfer.reason_code },
                transfer.remark && { l: "Remark", v: transfer.remark },
              ].filter(Boolean)) as { l: string; v: React.ReactNode }[];
              return (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <tbody>
                      {infoRows.map((r) => (
                        <tr key={r.l} className="border-b border-[var(--aws-border)]/50">
                          <td className="py-1.5 pr-4 text-[var(--text-secondary)] whitespace-nowrap align-top w-40">{r.l}</td>
                          <td className="py-1.5 font-medium text-[var(--text-primary)] break-words">{r.v}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })()}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 max-w-md">
              <div className="bg-sky-50 border border-sky-100 rounded-md p-3 text-center">
                <div className="text-[18px] font-semibold text-sky-700">{itemsCount}</div>
                <div className="text-[11px] text-[var(--text-secondary)]">Items</div>
              </div>
              <div className="bg-emerald-50 border border-emerald-100 rounded-md p-3 text-center">
                <div className="text-[18px] font-semibold text-emerald-700">{boxes.length}</div>
                <div className="text-[11px] text-[var(--text-secondary)]">Boxes Scanned</div>
              </div>
              <div className="bg-teal-50 border border-teal-100 rounded-md p-3 text-center">
                <div className="text-[18px] font-semibold text-teal-700">{grns.length > 0 ? receivedBoxes : "—"}</div>
                <div className="text-[11px] text-[var(--text-secondary)]">Boxes Scanned at Receipt</div>
              </div>
            </div>
          </div>

          {/* Receipts (Transfer-IN) */}
          {grns.length > 0 && (
            <div className="bg-white border border-[var(--aws-border)] rounded-md">
              <div className="px-4 py-3 border-b border-[var(--aws-border)] text-[13px] font-semibold text-[var(--text-primary)]">
                Receipts — Transfer IN ({grns.length})
              </div>
              <div className="p-3 overflow-x-auto">
                <table className="w-full text-[12px] whitespace-nowrap">
                  <thead><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
                    <th className="py-1.5 pr-3">GRN Number</th><th className="pr-3">Status</th><th className="pr-3">Received By</th><th className="pr-3">Received At</th><th className="text-right">Boxes Scanned</th>
                  </tr></thead>
                  <tbody>
                    {grns.map((g) => (
                      <tr key={g.id} className="border-b border-[var(--aws-border)]/50">
                        <td className="py-1.5 pr-3 font-mono text-[var(--text-primary)]">{g.grn_number}</td>
                        <td className="pr-3"><span className={`text-[11px] px-1.5 rounded ${statusTone(g.status)}`}>{g.status}</span></td>
                        <td className="pr-3">{g.received_by || "—"}</td>
                        <td className="pr-3">{formatDate(g.received_at)}</td>
                        <td className="text-right">{g.received_boxes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Items details */}
          {consolidatedLines.length > 0 && (
            <div className="bg-white border border-[var(--aws-border)] rounded-md">
              <div className="px-4 py-3 border-b border-[var(--aws-border)] text-[13px] font-semibold text-[var(--text-primary)]">
                Items Details ({consolidatedLines.length} row{consolidatedLines.length === 1 ? "" : "s"})
              </div>
              {/* max-h + sticky thead: a 167-line dispatch (transfer 1891) scrolled all 15
                  column headings away, and Net Wt / Total Wt / Pack Size are three numeric
                  columns that are indistinguishable once the header is gone. Capping the
                  height also keeps the Lot Summary below reachable without a long scroll. */}
              <div className="p-3 overflow-auto max-h-[560px]">
                <table className="w-full text-[12px] whitespace-nowrap">
                  <thead className="sticky top-0 z-10 bg-white"><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
                    <th className="py-1.5 pr-3">#</th><th className="pr-3">Description</th><th className="pr-3">Type</th><th className="pr-3">Category</th><th className="pr-3">Sub Category</th><th className="pr-3 text-right">Qty</th><th className="pr-3">UOM</th><th className="pr-3 text-right">Pack Size</th><th className="pr-3 text-right">Unit Pack/Count</th><th className="pr-3 text-right">Net Wt</th><th className="pr-3 text-right">Total Wt</th><th className="pr-3">Batch</th><th className="pr-3">Lot</th><th className="pr-3">Vakkal</th><th className="text-right">Boxes</th>
                  </tr></thead>
                  <tbody>
                    {consolidatedLines.map((l, i) => {
                      const isFG = (l.material_type || "").toUpperCase() === "FG";
                      const ups = num(l.unit_pack_size);
                      // pack_size is a per-case UNIT COUNT whenever unit_pack_size carries the
                      // kg-per-unit (create_service._line_weights: FG net = ups × pack_size ×
                      // qty); with unit_pack_size 0 or 1 it is kg per box. It is never grams —
                      // `isFG ? "gm" : "Kg"` printed "16.000 gm" beside that same row's real
                      // net weight of 8.000 kg (transfer 1836).
                      const packIsCount = isFG && ups > 0 && ups !== 1;
                      return (
                        <tr key={i} className="border-b border-[var(--aws-border)]/50 even:bg-[var(--background)]/40">
                          <td className="py-1.5 pr-3">{i + 1}</td>
                          <td className="pr-3 font-medium text-[var(--text-primary)]">{l.item_description}</td>
                          <td className="pr-3">{l.material_type || "—"}</td>
                          <td className="pr-3">{l.item_category || "—"}</td>
                          <td className="pr-3">{l.sub_category || "—"}</td>
                          <td className="pr-3 text-right">{l.quantity || "0"}</td>
                          <td className="pr-3">{displayUom(l.uom)}</td>
                          <td className="pr-3 text-right">{l.pack_size || "0"} {packIsCount ? "/ case" : "Kg"}</td>
                          {/* API numerics are strings: a zero arrives as "0.000", never "0",
                              so `!== "0"` could never match and printed the value it meant to
                              suppress. Parse before comparing. */}
                          <td className="pr-3 text-right">{ups > 0 ? l.unit_pack_size : "—"}</td>
                          <td className="pr-3 text-right">{l.net_weight || "0"} kg</td>
                          <td className="pr-3 text-right">{l.total_weight || "0"} kg</td>
                          <td className="pr-3">{l.batch_number || "—"}</td>
                          <td className="pr-3">{l.lot_number || "—"}</td>
                          <td className="pr-3">{l.vakkal || "—"}</td>
                          <td className="text-right">{l._box_count > 0 ? l._box_count : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Scanned boxes */}
          {boxes.length > 0 ? (
            <div className="bg-white border border-[var(--aws-border)] rounded-md">
              <div className="px-4 py-3 border-b border-[var(--aws-border)] text-[13px] font-semibold text-[var(--text-primary)]">
                Scanned Boxes Details ({boxes.length})
              </div>
              <div className="p-3 overflow-auto max-h-[560px]">
                <table className="w-full text-[12px] whitespace-nowrap">
                  <thead className="sticky top-0 z-10 bg-white"><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
                    <th className="py-1.5 pr-3">Box #</th><th className="pr-3">Status</th><th className="pr-3">Article</th><th className="pr-3">Lot Number</th><th className="pr-3">Box ID</th><th className="pr-3">Batch Number</th><th className="pr-3">Transaction No</th><th className="pr-3">From (cold)</th><th className="pr-3 text-right">Net</th><th className="pr-3 text-right">Gross</th><th className="text-right">Scanned At</th>
                  </tr></thead>
                  <tbody>
                    {boxes.map((b) => (
                      <tr key={b.id} className="border-b border-[var(--aws-border)]/50 even:bg-[var(--background)]/40 hover:bg-[var(--background)]">
                        <td className="py-1.5 pr-3 font-semibold text-[var(--text-primary)]">{b.box_number}</td>
                        <td className="pr-3"><span className="text-[11px] px-1.5 rounded bg-emerald-100 text-emerald-800">Scanned</span></td>
                        <td className="pr-3">{b.article || "N/A"}</td>
                        <td className="pr-3">{b.lot_number || "N/A"}</td>
                        <td className="pr-3 font-mono">
                          {b.box_id
                            ? <button type="button" onClick={() => setHistBox({ box_id: b.box_id!, transaction_no: b.transaction_no })}
                                className="underline decoration-dotted underline-offset-2 hover:text-[var(--aws-navy)]"
                                title="Show this box's history">{b.box_id}</button>
                            : "N/A"}
                        </td>
                        <td className="pr-3">{b.batch_number || "N/A"}</td>
                        <td className="pr-3 font-mono">{b.transaction_no || "N/A"}</td>
                        <td className="pr-3">{b.source_unit ? (getDisplayWarehouseName(b.source_unit) || b.source_unit) : "—"}</td>
                        <td className="pr-3 text-right text-sky-700">{b.net_weight} kg</td>
                        <td className="pr-3 text-right text-violet-700">{b.gross_weight} kg</td>
                        <td className="text-right">{b.created_at ? formatDate(b.created_at) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* Boxes summary */}
              <div className="px-4 py-3 border-t border-[var(--aws-border)] grid grid-cols-2 md:grid-cols-5 gap-3">
                <Tile label="Total Boxes" value={boxes.length} />
                <Tile label="Total Net Weight" value={`${totalNet.toFixed(2)} kg`} />
                <Tile label={`Total Gross Weight${grossScope}`} value={hasGross ? `${totalGross.toFixed(2)} kg` : "—"} />
                <Tile label={`Packaging (Gross−Net)${grossScope}`} value={hasGross ? `${packaging.toFixed(2)} kg` : "—"} />
                <Tile label="Avg Weight/Box" value={`${(boxes.length ? totalNet / boxes.length : 0).toFixed(2)} kg`} />
              </div>
            </div>
          ) : (
            <div className="bg-white border border-[var(--aws-border)] rounded-md py-10 text-center text-[13px] text-[var(--text-secondary)]">
              No boxes scanned for this transfer.
            </div>
          )}

          {/* Lot summary */}
          {lotSummary.length > 0 && (
            <div className="bg-white border border-[var(--aws-border)] rounded-md">
              <div className="px-4 py-3 border-b border-[var(--aws-border)] text-[13px] font-semibold text-[var(--text-primary)]">
                Lot Summary ({lotSummary.length})
              </div>
              <div className="p-3 overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
                    <th className="py-1.5">Lot</th><th>Origin (cold)</th><th className="text-right">Boxes</th><th className="text-right">Net Weight</th>
                  </tr></thead>
                  <tbody>
                    {lotSummary.map((r) => (
                      <tr key={r.lot} className="border-b border-[var(--aws-border)]/50">
                        <td className="py-1.5 font-mono">{r.lot}</td>
                        <td>{r.origins.size === 0 ? "—" : r.origins.size === 1 ? [...r.origins][0] : `Mixed (${r.origins.size})`}</td>
                        <td className="text-right">{r.count}</td>
                        <td className="text-right">{r.net.toFixed(2)} kg</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
      <BoxHistoryModal boxId={histBox?.box_id ?? null} transactionNo={histBox?.transaction_no}
        onClose={() => setHistBox(null)} />
    </TransferChrome>
  );
}
