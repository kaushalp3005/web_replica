"use client";

// Cold-storage stock picker for the Direct Transfer OUT form (doc 08 §4) and the Inner Cold
// Transfer. Debounced search of cold lots (both companies' tables), with a per-row "+N in
// transit" hover that fetches pending-by-lot. Selecting a row hands the full record up; the
// parent fills the cold article fields and (on Add to list) FIFO-picks unique box_ids of
// that row via ColdStorageApi.pickBoxes.
//
// Note: cartons are cold_stocks as IMS keeps it. The transfer module is record only:
// dispatch copies a box onto the transfer and never removes it from cold_stocks, so boxes
// in transit or received elsewhere are counted here too; the hover lists the ones in
// transit. Given the From site (`fromWarehouse`), each lot also shows how many of its boxes
// can go from there by their latest transfer: one never on a transfer, or received and
// acknowledged at that site, can; one in transit, written off as short or received at
// another site cannot. The pick applies the same rule from the same site, and the server
// checks it again when the transfer is saved (409). A row without a box id is no box a
// dispatch can take, so it is not counted there either; an inner cold transfer
// (`storeOnly`) relabels such rows too, so its count leaves them to the server. With a store
// chosen, the inner cold search reads that store's lots (by unit, then storage location),
// so older lots of other stores never push them out of the result limit.

import { useEffect, useRef, useState } from "react";
import { ColdStorageApi, hasBoxlessRows, type ColdStockRecord } from "@/lib/coldStorage";
import { TransferApi, type PendingByLotResult } from "@/lib/transfer";
import { displaySite, sameSite } from "@/lib/sites";
import { coldRowSite } from "./_siteRules";

export function ColdStockSearch({ onSelect, fromWarehouse, storeOnly }: {
  onSelect: (r: ColdStockRecord) => void;
  // The site the boxes would go from; the search then counts the boxes available there.
  fromWarehouse?: string | null;
  // Only lots at that site can be selected (the Inner Cold Transfer, which stays inside one
  // cold store); a lot at another cold store says where it is instead.
  storeOnly?: boolean;
}) {
  const [lot, setLot] = useState("");
  const [desc, setDesc] = useState("");
  const [results, setResults] = useState<ColdStockRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const site = (fromWarehouse || "").trim();
  useEffect(() => {
    // All setState lives inside the (async) debounce callback so none runs synchronously
    // in the effect body (react-hooks/set-state-in-effect).
    let off = false;
    const h = setTimeout(async () => {
      const l = lot.trim(), d = desc.trim();
      if (!l && !d) { if (!off) { setResults([]); setErr(null); setLoading(false); } return; }
      setLoading(true); setErr(null);
      try {
        // The field is labelled "Item / Group" — use the backend's combined `q` param
        // (item_description OR group_name OR lot) so a group-name search actually matches.
        const terms = { lot_no: l || undefined, q: d || undefined };
        const r = storeOnly && site
          ? await ColdStorageApi.searchStoreStocks({ ...terms, store: site })
          : await ColdStorageApi.searchStocks({ ...terms, from_warehouse: site || undefined });
        if (!off) setResults(r.results);
      } catch (e) {
        if (!off) { setResults([]); setErr(e instanceof Error ? e.message : "Search failed."); }
      } finally {
        if (!off) setLoading(false);
      }
    }, 400);
    return () => { off = true; clearTimeout(h); };
  }, [lot, desc, site, storeOnly]);

  return (
    <div className="border border-[var(--aws-border)] rounded-md p-3 bg-[var(--background)]">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
        <label className="block">
          <span className="block text-[11px] uppercase tracking-wide text-[var(--text-secondary)] mb-1">Lot Number</span>
          <div className="relative">
            <input value={lot} onChange={(e) => setLot(e.target.value)} placeholder="Search lot…"
              className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" />
            {lot && <button type="button" onClick={() => setLot("")} className="absolute right-2 top-1.5 text-[var(--text-secondary)]">✕</button>}
          </div>
        </label>
        <label className="block">
          <span className="block text-[11px] uppercase tracking-wide text-[var(--text-secondary)] mb-1">Item / Group</span>
          <div className="relative">
            <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Search item / group…"
              className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" />
            {desc && <button type="button" onClick={() => setDesc("")} className="absolute right-2 top-1.5 text-[var(--text-secondary)]">✕</button>}
          </div>
        </label>
      </div>

      {loading && <p className="text-[12px] text-[var(--text-secondary)] py-2">Searching…</p>}
      {err && <p className="text-[12px] text-rose-600 py-2">{err}</p>}
      {!loading && !err && (lot.trim() || desc.trim()) && results.length === 0 && (
        <p className="text-[12px] text-[var(--text-secondary)] py-2">No cold stock found.</p>
      )}

      {results.length > 0 && (
        <div className="overflow-x-auto max-h-72 overflow-y-auto">
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 bg-[var(--background)]">
              <tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
                <th className="py-1.5 pr-2">Inward</th><th className="py-1.5 pr-2">Unit</th>
                <th className="py-1.5 pr-2">Item</th><th className="py-1.5 pr-2">Mark</th>
                <th className="py-1.5 pr-2">Lot</th><th className="py-1.5 pr-2 text-right">Cartons</th>
                <th className="py-1.5 pr-2 text-right">Wt</th><th className="py-1.5 pr-2">Co</th><th />
              </tr>
            </thead>
            <tbody>
              {results.map((r) => {
                const at = coldRowSite(r);
                const elsewhere = storeOnly && site && at && !sameSite(at, site) ? at : "";
                return (
                  <tr key={`${r.company}-${r.id}-${r.lot_no}-${r.inward_no}`} className={`border-b border-[var(--aws-border)]/40 ${elsewhere ? "text-[var(--text-secondary)]" : "hover:bg-white"}`}>
                    <td className="py-1 pr-2 whitespace-nowrap">{r.inward_dt || "—"}</td>
                    <td className="py-1 pr-2" title={[r.unit, r.storage_location].filter(Boolean).join(" / ")}>{at || r.unit || r.storage_location || "—"}</td>
                    <td className="py-1 pr-2 max-w-[160px] truncate" title={r.item_description || ""}>{r.item_description}</td>
                    <td className="py-1 pr-2">{r.item_mark || "—"}</td>
                    <td className="py-1 pr-2 font-mono">{r.lot_no || "—"}</td>
                    <td className="py-1 pr-2 text-right"><CartonCellWithPending record={r} site={site} storeOnly={!!storeOnly} /></td>
                    <td className="py-1 pr-2 text-right">{r.weight_kg ?? "—"}</td>
                    <td className="py-1 pr-2 uppercase">{r.company || "—"}</td>
                    <td className="py-1 pr-2 text-right">
                      {elsewhere ? (
                        <span className="text-[11px] whitespace-nowrap" title={`This lot is at ${elsewhere}, not ${site}.`}>at {elsewhere}</span>
                      ) : (
                        <button type="button" onClick={() => onSelect(r)}
                          className="px-2 py-0.5 text-[11px] rounded border border-[var(--aws-navy)] text-[var(--aws-navy)] hover:bg-[var(--aws-navy)] hover:text-white">Select</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Dedupe pending-by-lot lookups across the (up to 50) result rows + repeat searches:
// one shared in-flight Promise per lot|item|company key, so a search fires at most one
// request per distinct lot rather than ~50 parallel ones.
const _pendingCache = new Map<string, Promise<PendingByLotResult>>();
function fetchPendingByLot(lot?: string | null, item?: string | null, company?: string | null) {
  const key = `${lot || ""}|${item || ""}|${company || ""}`;
  let p = _pendingCache.get(key);
  if (!p) {
    p = TransferApi.pendingByLot({ lot_no: lot || undefined, item_description: item || undefined, from_company: company || undefined });
    _pendingCache.set(key, p);
    p.catch(() => _pendingCache.delete(key)); // a failed lookup shouldn't be cached
  }
  return p;
}

function CartonCellWithPending({ record, site, storeOnly }: { record: ColdStockRecord; site: string; storeOnly: boolean }) {
  const [pending, setPending] = useState<PendingByLotResult | null>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const available = record.net_qty_on_cartons ?? 0;
  // Given a From site: the boxes that can go from there, out of the cold table's count. Not
  // for an inner cold lot that shows rows without a box id: those stay in the store and are
  // relabelled too, but are not counted (the server counts them on submit).
  const boxless = hasBoxlessRows(record);
  const here = typeof record.available_here === "number" && !(storeOnly && boxless) ? record.available_here : null;
  const where = displaySite(site) || "this site";
  const why = storeOnly
    ? `${here} of the ${available} boxes in the cold table are at ${where} by their latest transfer; the others are in transit, written off as short, or were received at another site — or are rows without a box id, which stay here and can be relabelled (the server counts them on submit).`
    : `${here} of the ${available} boxes in the cold table can go from ${where}; the others are in transit, written off as short, or were received at another site${boxless ? ", or are rows without a box id, which a dispatch can't take box by box" : ""}.`;

  useEffect(() => {
    let off = false;
    fetchPendingByLot(record.lot_no, record.item_description, record.company)
      .then((r) => { if (!off) setPending(r); }).catch(() => {});
    return () => { off = true; };
  }, [record.lot_no, record.item_description, record.company]);

  const inTransit = pending?.pending_cartons ?? 0;
  return (
    <span className="relative inline-flex items-center gap-1"
      onMouseEnter={() => { if (inTransit > 0) { if (timer.current) clearTimeout(timer.current); setOpen(true); } }}
      onMouseLeave={() => { timer.current = setTimeout(() => setOpen(false), 150); }}>
      {here === null || here === available ? <span>{available}</span> : (
        <span title={why}>
          <span className={here > 0 ? "" : "text-rose-600"}>{here}</span>
          <span className="text-[10px] text-[var(--text-secondary)]"> of {available}</span>
        </span>
      )}
      {inTransit > 0 && (
        <span className="text-[10px] px-1 rounded bg-amber-100 text-amber-700 cursor-help">+{inTransit} in transit</span>
      )}
      {open && pending && pending.transfers.length > 0 && (
        <div className="absolute right-0 bottom-full mb-1 z-[60] w-72 bg-white border border-[var(--aws-border)] rounded-md shadow-lg p-2 text-left">
          <div className="text-[11px] font-semibold text-[var(--text-primary)] mb-1">In transit ({inTransit} cartons)</div>
          {pending.transfers.map((t) => (
            <div key={t.transfer_out_id} className="border-b border-[var(--aws-border)]/40 py-1 last:border-0">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[11px]">{t.challan_no}</span>
                <span className={`text-[10px] px-1 rounded ${t.transfer_status === "Partial" ? "bg-amber-100 text-amber-700" : "bg-sky-100 text-sky-700"}`}>
                  {t.transfer_status || "Dispatch"}{t.has_variance ? " ⚠" : ""}{t.updated_ts ? " ✎" : ""}
                </span>
              </div>
              <div className="text-[10px] text-[var(--text-secondary)]">
                {t.from_site} → {t.to_site} · {t.cartons} ctn · {t.weight_kg} kg
                {t.vehicle_no ? ` · ${t.vehicle_no}` : ""}{t.dispatched_by ? ` · ${t.dispatched_by}` : ""}
              </div>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
