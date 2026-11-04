"use client";

// In-transit ("Pending Stock") modal. Mirrors components/transfer/
// PendingTransfersModal.tsx: portal to <body>, ESC + backdrop close, totals bar,
// warehouse chips, and a gated Cancel action per row. Opening it only reads the list;
// the sync (backfill) runs on demand, from its "Sync in-transit records" button (the
// users who may cancel), and says what it did.
// Record only: the list is the transfer module's own in-transit records. The sync
// only adds missing ones for dispatched transfers (not for boxes that went on since or
// that IMS took in), and Cancel deletes the transfer and its in-transit rows (freeing
// its boxes for another transfer); neither changes the stock tables, which IMS keeps.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  TransferApi, type BackfillResult, type PendingTransferRecord, type PendingStockResponse,
} from "@/lib/transfer";
import { canonicalSite, sameSite } from "@/lib/sites";
import { ChallanHoverCard } from "./_ChallanHoverCard";
import { transferHoverData } from "./_hoverData";
import { GRID_TABLE } from "./_grid";
import { siteOptions } from "./_siteRules";

function fmtDate(s?: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString();
}

// What a sync did, in a line.
function syncSummary(r: BackfillResult): string {
  if (r.error) return `Sync did not run: ${r.error}.`;
  const parked = (r.boxes_parked_from_cold ?? 0) + (r.boxes_parked_from_warehouse ?? 0) + (r.boxes_parked_without_source ?? 0);
  const skipped = [
    r.boxes_skipped_sent_on ? `${r.boxes_skipped_sent_on} went on on a newer transfer` : "",
    r.boxes_skipped_received ? `${r.boxes_skipped_received} were received in IMS` : "",
  ].filter(Boolean).join(", ");
  return `Sync done: ${parked} box(es) recorded in transit${skipped ? `; not recorded: ${skipped}` : ""}.`;
}

export function PendingTransfersModal({
  open, onClose, canCancel,
}: {
  open: boolean;
  onClose: () => void;
  canCancel: boolean;
}) {
  const [data, setData] = useState<PendingStockResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [fromChip, setFromChip] = useState<string | null>(null);
  const [toChip, setToChip] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const justOpened = useRef(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const r = await TransferApi.getPendingStock();
      setData(r);
    } catch {
      setBanner("Could not load pending stock.");
    } finally {
      setLoading(false);
    }
  }, []);

  // On open: load the list (read only; the sync is the button below).
  useEffect(() => {
    if (!open || justOpened.current) return;
    justOpened.current = true;
    queueMicrotask(() => { setBanner(null); void loadData(); });
  }, [open, loadData]);

  // Reset the one-shot load guard when the modal closes.
  useEffect(() => { if (!open) justOpened.current = false; }, [open]);

  // On demand: record in-transit rows for dispatched transfers that have none, copying
  // their boxes' details (stock is not changed), then reload. A failed sync is non-fatal
  // — banner it and load the list anyway (doc §12).
  const onSync = async () => {
    setSyncing(true);
    try {
      setBanner(syncSummary(await TransferApi.backfillPendingStock()));
    } catch (e) {
      setBanner(`Sync failed (${e instanceof Error ? e.message : "error"}) — refreshing data anyway…`);
    } finally {
      setSyncing(false);
    }
    await loadData();
  };

  // ESC to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const onCancelTransfer = async (rec: PendingTransferRecord) => {
    if (typeof window !== "undefined" && !window.confirm(`Cancel transfer ${rec.transfer_out_challan_no}? The transfer is deleted and its boxes come off the in-transit list, free to go on another transfer; if it was sent from a request, the request goes back to Ready to Send. Stock is not changed here.`)) return;
    try {
      await TransferApi.deleteTransfer(rec.transfer_out_id);
      await loadData();
    } catch (e) {
      setBanner(e instanceof Error ? e.message : "Cancel failed.");
    }
  };

  if (!open || typeof document === "undefined") return null;

  // Chips and rows are compared as sites (lib/sites): "A-185" and "A185", or "ESKIMO" and
  // "Eskimo", are one chip, and it picks every row of that site.
  const records = (data?.records ?? []).filter((r) =>
    (!search || r.transfer_out_challan_no.toLowerCase().includes(search.toLowerCase())) &&
    (!fromChip || sameSite(r.from_site, fromChip)) &&
    (!toChip || sameSite(r.to_site, toChip))
  );
  const totalBoxes = records.reduce((s, r) => s + (r.total_boxes || 0), 0);
  const totalKg = records.reduce((s, r) => s + (r.total_kg || 0), 0);
  const fromChips = siteOptions(data?.filter_options.from_sites ?? []);
  const toChips = siteOptions(data?.filter_options.to_sites ?? []);

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 p-4 overflow-auto"
      onClick={onClose}>
      <div className="bg-white rounded-md shadow-xl w-full max-w-5xl mt-8" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--aws-border)]">
          <h2 className="text-[15px] font-semibold">Pending Transfers (In Transit)</h2>
          <button onClick={onClose} aria-label="Close" className="text-[var(--text-secondary)] text-[18px]">×</button>
        </div>

        {banner && <div className="mx-4 mt-3 text-[12px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">{banner}</div>}

        {/* Filters */}
        <div className="px-4 py-3 flex flex-wrap items-center gap-2">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search challan…"
            className="border border-[var(--aws-border)] rounded px-2 py-1 text-[12px] w-full sm:w-56" />
          <ChipRow label="From" chips={fromChips} active={fromChip} onPick={setFromChip} />
          <ChipRow label="To" chips={toChips} active={toChip} onPick={setToChip} />
          {(search || fromChip || toChip) && (
            <button onClick={() => { setSearch(""); setFromChip(null); setToChip(null); }}
              className="text-[11px] underline text-[var(--text-secondary)]">Clear filters</button>
          )}
          {canCancel && (
            <button onClick={() => void onSync()} disabled={syncing || loading}
              title="Record in-transit rows for dispatched transfers that have none"
              className="ml-auto px-2 py-1 text-[11px] border border-[var(--aws-border)] rounded hover:border-[var(--aws-navy)] disabled:opacity-50">
              {syncing ? "Syncing…" : "Sync in-transit records"}
            </button>
          )}
        </div>

        {/* Totals */}
        <div className="px-4 pb-2 flex gap-4 text-[12px] text-[var(--text-secondary)]">
          <span><b className="text-[var(--text-primary)]">{records.length}</b> transfers</span>
          <span><b className="text-[var(--text-primary)]">{totalBoxes}</b> boxes</span>
          <span><b className="text-[var(--text-primary)]">{totalKg.toFixed(1)}</b> kg</span>
        </div>

        <div className="px-4 pb-4 overflow-auto max-h-[60vh]">
          {loading ? (
            <div className="py-8 text-center text-[13px] text-[var(--text-secondary)]">Loading…</div>
          ) : records.length === 0 ? (
            <div className="py-8 text-center text-[13px] text-[var(--text-secondary)]">No in-transit transfers.</div>
          ) : (
            <table className={GRID_TABLE}>
              <thead><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
                <th className="py-2">Date</th><th>Challan</th><th>From → To</th><th>Boxes</th><th>Cartons</th><th>Weight</th><th>Dispatched By</th><th>Status</th><th></th>
              </tr></thead>
              <tbody>
                {records.map((r, idx) => (
                  // One transfer_out can yield multiple pending rows (the backend
                  // groups by the full site/company/storage-type tuple), so the
                  // id alone isn't unique — compose with the route + index.
                  <tr key={`${r.transfer_out_id}-${r.from_site ?? ""}-${r.to_site ?? ""}-${idx}`}
                    className="border-b border-[var(--aws-border)]/50 align-top">
                    <td className="py-2">{fmtDate(r.dispatched_at)}</td>
                    <td>
                      <ChallanHoverCard
                        label={r.transfer_out_challan_no}
                        from={canonicalSite(r.from_site)} to={canonicalSite(r.to_site)}
                        fetchLines={() => TransferApi.getTransfer(r.transfer_out_id).then(transferHoverData)}
                      />
                    </td>
                    <td>{canonicalSite(r.from_site)} → {canonicalSite(r.to_site)}
                      <div className="text-[10px] text-[var(--text-secondary)]">{r.from_storage_type} → {r.to_storage_type}</div>
                    </td>
                    <td>{r.total_boxes}{r.unallocated_boxes ? <span className="ml-1 text-rose-600">({r.unallocated_boxes} short)</span> : null}</td>
                    <td>{r.total_cartons}</td>
                    <td>{r.total_kg.toFixed(1)}</td>
                    <td>{r.dispatched_by}</td>
                    <td>
                      {/* Partial is set when the transfer is sent (fewer boxes than its
                          request asks for), never by a receipt. */}
                      <span title={r.header_status === "Partial" ? "Fewer boxes than the request asks for" : undefined}
                        className={`px-1.5 py-0.5 rounded text-[10px] ${r.header_status === "Partial" ? "bg-amber-100 text-amber-800" : "bg-sky-100 text-sky-800"}`}>
                        {r.header_status === "Partial" ? "Partial" : r.status}
                      </span>
                      {r.updated_ts && <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] bg-violet-100 text-violet-800">Edited</span>}
                    </td>
                    <td className="text-right">
                      {canCancel && (
                        <button onClick={() => onCancelTransfer(r)}
                          className="px-2 py-0.5 text-[11px] border border-rose-300 text-rose-700 rounded hover:bg-rose-50">Cancel</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ChipRow({ label, chips, active, onPick }: {
  label: string; chips: string[]; active: string | null; onPick: (v: string | null) => void;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="flex items-center gap-1 flex-wrap">
      <span className="text-[10px] uppercase text-[var(--text-secondary)]">{label}</span>
      {chips.map((c) => (
        <button key={c} onClick={() => onPick(active === c ? null : c)}
          className={`px-1.5 py-0.5 rounded text-[11px] border ${active === c ? "bg-[var(--aws-navy)] text-white border-[var(--aws-navy)]" : "border-[var(--aws-border)]"}`}>
          {c}
        </button>
      ))}
    </div>
  );
}
