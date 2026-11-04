"use client";

// Inner Cold Transfer (doc 11) — relabel lots (old → new) INSIDE one cold store. Not an
// inter-unit transfer: it changes the cold-stock tables directly via POST
// /api/v1/transfer/inner-transfer. The boxes stay in their store: moving boxes to another
// cold store has to be an inter-unit transfer, and the server refuses it (409). Each line
// acts on the lot row the user picked, then on more rows of that row's group at the same
// store (unit, mark, item, lot and inward), and only on boxes that are at the store by
// their latest transfer (or were never on one), and on rows without a box id, which no
// transfer can take. The page caps a line at the lot's cartons and warns when it asks for
// more boxes than the search counts at the store (its available-here count, which leaves
// out rows without a box id; the server counts them and refuses the challan, writing
// nothing, if the boxes are not there). Each line names the cold table of its picked row
// (cfpl / cdpl: row ids repeat across the two), so one challan may hold both. Deleting the
// challan (dashboard) undoes it. Create, or edit (append lines) via ?editChallan=. Reuses
// the shared ColdStockSearch picker + _formParts Card/Field. The stores are the shared site
// table's cold stores (lib/sites) the user is assigned to; Savla Bond is a store of its own.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useRequireAuth, useUserScope } from "@/lib/user";
import { userHasWarehouse } from "@/lib/warehouseScope";
import { COLD_SITES, canonicalSite, sameSite } from "@/lib/sites";
import { TransferChrome } from "../_chrome";
import { Card, Field } from "../_formParts";
import { ColdStockSearch } from "../_ColdStockSearch";
import { coldRowSite } from "../_siteRules";
import { TransferApi, type InnerTransferCreateBody } from "@/lib/transfer";
import { ColdStorageApi, hasBoxlessRows, type ColdStockRecord } from "@/lib/coldStorage";

const REASONS = ["Stock Requirement", "Material Movement", "Inventory Balancing", "Space Management", "Other"];

function todayDMY(): string {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
}
function genICTNo(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `ICT${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}
function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}
// The most a line on a picked lot row can ask for: the cold table's cartons of its group
// (the server moves no more); null when not known.
function lotCartons(r: ColdStockRecord): number | null {
  return r.net_qty_on_cartons != null ? Math.floor(r.net_qty_on_cartons) : null;
}
// How many of its boxes are at the store by their latest transfer: the search's count when
// it was given the store. null when it wasn't, or when the lot shows rows without a box id,
// which the count leaves out although they are relabelled too (the server counts them).
function boxesHere(r: ColdStockRecord): number | null {
  return typeof r.available_here === "number" && !hasBoxlessRows(r) ? Math.floor(r.available_here) : null;
}

interface ICTArticle {
  uid: number;
  stockRecordId: number | null;
  company: string;   // the picked row's cold table (cfpl / cdpl)
  site: string;      // the picked row's cold store ("" when its unit / location names none)
  itemCategory: string; itemDescription: string;
  oldLot: string; perBoxWeight: number;
  maxBoxes: number | null;     // lotCartons: a hard limit
  boxesHere: number | null;    // boxesHere: asking for more needs a confirmation
  quantity: string; newLot: string;
}
const EMPTY: Omit<ICTArticle, "uid"> = {
  stockRecordId: null, company: "", site: "", itemCategory: "", itemDescription: "", oldLot: "",
  perBoxWeight: 0, maxBoxes: null, boxesHere: null, quantity: "0", newLot: "",
};

interface TransferEntry {
  id: number; stockRecordId: number | null; company: string; itemCategory: string; itemDescription: string;
  perBoxWeight: number; quantity: number; oldLot: string; newLot: string;
  newLocation: string;   // saved lines only: an older challan may have moved boxes
  isExisting?: boolean;
}

// The cold store chips. Selected by site, so a challan stored "Savla D39" shows Savla D-39.
// `locked`: the store can't change (an edited challan's, or while new lines are listed).
function StoreChips({ stores, value, onChange, locked }: {
  stores: readonly string[]; value: string; onChange: (v: string) => void; locked: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {stores.map((store) => {
        const sel = sameSite(value, store);
        return (
          <button key={store} type="button" disabled={locked} onClick={() => onChange(sel ? "" : store)}
            className={`px-2.5 py-1 text-[12px] rounded-full border disabled:cursor-default ${locked && !sel ? "opacity-50" : ""} ${sel ? "bg-[var(--aws-navy)] text-white border-[var(--aws-navy)]" : "border-[var(--aws-border)] text-[var(--text-secondary)] hover:border-[var(--aws-navy)]"}`}>
            {store}
          </button>
        );
      })}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<TransferChrome title="Inner Cold Transfer"><div className="py-16 text-center text-[13px] text-[var(--text-secondary)]">Loading…</div></TransferChrome>}>
      <InnerColdTransferForm />
    </Suspense>
  );
}

function InnerColdTransferForm() {
  const router = useRouter();
  const allowed = useRequireAuth(router.replace);
  const searchParams = useSearchParams();
  const editChallan = searchParams.get("editChallan");
  const isEditMode = !!editChallan;
  // The stores this user may relabel in, as the server's warehouse lock has it: every cold
  // store for an admin or a user with no warehouse, else the cold stores assigned.
  const { isAdmin, warehouses: myWarehouses } = useUserScope();
  const unlocked = isAdmin || myWarehouses.length === 0;
  const myStores = useMemo(
    () => (unlocked ? [...COLD_SITES] : COLD_SITES.filter((s) => userHasWarehouse(myWarehouses, s))),
    [unlocked, myWarehouses]);
  // An edited challan's store (its lines were applied there), once loaded; "" otherwise.
  const [challanStore, setChallanStore] = useState("");
  const stores = challanStore ? [challanStore] : myStores;

  // Seeded empty so the initial render is deterministic (genICTNo()/todayDMY() read the
  // wall clock and would mismatch between the SSR render and client hydration). Filled on mount below.
  const [transferNo, setTransferNo] = useState("");
  const [form, setForm] = useState({ transferDate: "", fromWarehouse: "", reason: "", reasonDescription: "" });
  const [articles, setArticles] = useState<ICTArticle[]>([{ uid: 0, ...EMPTY }]);
  const nextUid = useRef(1);
  const [entries, setEntries] = useState<TransferEntry[]>([]);
  const nextEntryId = useRef(1);

  const [submitting, setSubmitting] = useState(false);
  const [editLoading, setEditLoading] = useState(isEditMode);
  const [banner, setBanner] = useState<{ type: "error" | "success"; text: string } | null>(null);

  // ── Edit prefill ──
  useEffect(() => {
    if (!allowed || !editChallan) return;
    let off = false;
    (async () => {
      try {
        const d = await TransferApi.getInnerTransfer(editChallan);
        if (off) return;
        setTransferNo(d.challan_no || genICTNo());
        // The store by its canonical name, so its chip shows selected ("Savla D39" is Savla
        // D-39); a name that is no cold store is kept, and a store has to be picked.
        setChallanStore(COLD_SITES.find((s) => sameSite(s, d.from_warehouse)) ?? "");
        setForm({
          transferDate: d.transfer_date || todayDMY(),
          fromWarehouse: canonicalSite(d.from_warehouse),
          reason: d.reason_code || "",
          reasonDescription: d.remark || "",
        });
        setEntries(d.lines.map((ln) => ({
          id: nextEntryId.current++,
          stockRecordId: ln.stock_record_id,
          company: "",
          itemCategory: ln.item_category || "",
          itemDescription: ln.item_description || "",
          perBoxWeight: ln.quantity ? num(ln.net_weight_kg) / ln.quantity : num(ln.net_weight_kg),
          quantity: ln.quantity,
          oldLot: ln.old_lot_number || "",
          newLot: ln.new_lot_number || "",
          newLocation: ln.new_storage_location || "",
          isExisting: true,
        })));
      } catch (e) {
        if (!off) setBanner({ type: "error", text: e instanceof Error ? e.message : "Failed to load transfer." });
      } finally {
        if (!off) setEditLoading(false);
      }
    })();
    return () => { off = true; };
  }, [allowed, editChallan]);

  // ── Seed clock-derived defaults on the client (avoids the SSR hydration mismatch). ──
  // Edit mode fills these from the loaded transfer; deferred via setTimeout so the
  // setState isn't synchronous in the effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (isEditMode) return;
    const id = setTimeout(() => {
      setTransferNo(genICTNo());
      setForm((f) => ({ ...f, transferDate: todayDMY() }));
    }, 0);
    return () => clearTimeout(id);
  }, [isEditMode]);

  // ── Article ops ──
  const patch = useCallback((uid: number, p: Partial<ICTArticle>) =>
    setArticles((as) => as.map((a) => (a.uid === uid ? { ...a, ...p } : a))), []);
  const addArticle = () => { const uid = nextUid.current++; setArticles((as) => [...as, { uid, ...EMPTY }]); };
  const removeArticle = (uid: number) => setArticles((as) => (as.length > 1 ? as.filter((a) => a.uid !== uid) : as));

  // A picked lot row must be at the challan's store (by its unit, else its storage location).
  // With no store chosen yet, the row's store becomes it.
  const selectStock = (uid: number, r: ColdStockRecord) => {
    const at = coldRowSite(r);
    const store = canonicalSite(form.fromWarehouse);
    if (store && at && !sameSite(at, store)) {
      setBanner({ type: "error", text: `This lot is at ${at}, not ${store}. An inner cold transfer works inside one cold store; moving boxes to another cold store has to be an inter-unit transfer.` });
      return;
    }
    if (!store && at && !myStores.some((s) => sameSite(s, at))) {
      setBanner({ type: "error", text: `This lot is at ${at}, which is not one of your cold stores.` });
      return;
    }
    setArticles((as) => as.map((a) => (a.uid === uid ? {
      ...a,
      stockRecordId: r.id,
      company: r.company || "",
      site: at,
      itemCategory: r.group_name || "",
      itemDescription: r.item_description || "",
      oldLot: r.lot_no ? String(r.lot_no) : "",
      perBoxWeight: num(r.weight_kg),
      maxBoxes: lotCartons(r),
      boxesHere: boxesHere(r),
      quantity: "0", newLot: "",
    } : a)));
    if (!store && at) {
      setForm((f) => (f.fromWarehouse ? f : { ...f, fromWarehouse: at }));
      // The search had no store to count from: ask it again from the store how many of the
      // lot's boxes are there.
      ColdStorageApi.searchStoreStocks({ lot_no: r.lot_no || undefined, q: r.item_description || undefined, store: at, limit: 500 })
        .then((res) => {
          const same = res.results.find((x) => x.id === r.id && x.company === r.company);
          const here = same ? boxesHere(same) : null;
          if (here != null) {
            setArticles((as) => as.map((a) => (a.uid === uid && a.stockRecordId === r.id && a.company === (r.company || "") ? { ...a, boxesHere: here } : a)));
          }
        })
        .catch(() => { /* no count: the server checks on submit */ });
    }
    setBanner(null);
  };

  const addToList = (a: ICTArticle) => {
    if (!a.itemDescription || a.stockRecordId == null) { setBanner({ type: "error", text: "Select a stock lot first." }); return; }
    const qty = Math.floor(num(a.quantity));
    if (qty <= 0) { setBanner({ type: "error", text: "Enter the number of boxes (> 0)." }); return; }
    const store = canonicalSite(form.fromWarehouse) || "this store";
    if (a.site && form.fromWarehouse && !sameSite(a.site, form.fromWarehouse)) {
      setBanner({ type: "error", text: `This lot is at ${a.site}, not ${store}. An inner cold transfer works inside one cold store; moving boxes to another cold store has to be an inter-unit transfer.` });
      return;
    }
    if (a.maxBoxes != null && qty > a.maxBoxes) {
      setBanner({ type: "error", text: `This lot has ${a.maxBoxes} box(es) in the cold stock at ${store}; ask for ${a.maxBoxes} or fewer.` });
      return;
    }
    if (!a.newLot.trim()) { setBanner({ type: "error", text: "New lot number is required." }); return; }
    // More than the search counts at the store: the others are in transit, received
    // elsewhere or written off, unless they are rows without a box id, which the count leaves
    // out. Only the server can tell, so ask before listing the line.
    if (a.boxesHere != null && qty > a.boxesHere && typeof window !== "undefined" && !window.confirm(
      `${a.boxesHere > 0 ? `Only ${a.boxesHere} of this lot's boxes are` : "None of this lot's boxes is"} at ${store} `
      + "by their latest transfer; the rest are in transit, written off as short, or were received at another site, "
      + "unless they are rows without a box id, which stay here and can be relabelled. "
      + `List ${qty} anyway? On submit the server checks each box and, if they are not all at ${store}, `
      + "refuses the challan and changes nothing.")) return;
    const id = nextEntryId.current++;
    setEntries((es) => [...es, {
      id, stockRecordId: a.stockRecordId, company: a.company, itemCategory: a.itemCategory, itemDescription: a.itemDescription,
      perBoxWeight: a.perBoxWeight, quantity: qty, oldLot: a.oldLot, newLot: a.newLot.trim(), newLocation: "",
    }]);
    // Reset the source fields for the next pick on this article.
    patch(a.uid, { stockRecordId: null, company: "", site: "", itemCategory: "", itemDescription: "", oldLot: "", perBoxWeight: 0, maxBoxes: null, boxesHere: null, quantity: "0", newLot: "" });
    setBanner({ type: "success", text: `Staged ${a.itemDescription}: lot ${a.oldLot || "—"} → ${a.newLot.trim()}.` });
  };

  const removeEntry = (id: number) => setEntries((es) => es.filter((e) => e.id !== id));
  const clearNew = () => setEntries((es) => es.filter((e) => e.isExisting));

  const newEntries = useMemo(() => entries.filter((e) => !e.isExisting), [entries]);
  // Only an older challan's saved lines can carry a new location (a move, no longer done).
  const showLocation = entries.some((e) => !!e.newLocation);

  const validate = (): string[] => {
    const e: string[] = [];
    if (!form.fromWarehouse) e.push("Cold store is required");
    if (!form.reason) e.push("Reason is required");
    if (!form.reasonDescription.trim()) e.push("Reason description is required");
    if (!isEditMode && entries.length === 0) e.push("Add at least one transfer entry");
    return e;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBanner(null);
    const errs = validate();
    if (errs.length) { setBanner({ type: "error", text: errs.join(" · ") }); return; }
    // Edit appends only the new lines (existing rows are already saved server-side).
    const toSend = isEditMode ? newEntries : entries;
    if (toSend.length === 0) { setBanner({ type: "error", text: "No new lines to submit." }); return; }
    setSubmitting(true);
    // The store by its canonical name, each line's picked row with its cold table (the
    // server reads the row in that table: ids repeat across cfpl and cdpl), and no new
    // location: the boxes stay in their store.
    const body: InnerTransferCreateBody = {
      header: {
        challan_no: transferNo, transfer_name: form.transferDate, from_warehouse: canonicalSite(form.fromWarehouse),
        remark: form.reasonDescription || form.reason, reason_code: form.reason, transfer_type: "INNER_COLD",
      },
      lines: toSend.map((en) => ({
        stock_record_id: en.stockRecordId, company: en.company || null, item_category: en.itemCategory,
        item_description: en.itemDescription, net_weight: en.perBoxWeight, quantity: en.quantity,
        old_lot_number: en.oldLot, new_lot_number: en.newLot, new_storage_location: null,
      })),
    };
    try {
      const res = await TransferApi.createInnerTransfer(body);
      if (res.errors && res.errors.length > 0) {
        // Backend is atomic (all-or-nothing) — errors mean nothing was applied.
        setBanner({ type: "error", text: `Not submitted: ${res.errors.join(" · ")}` });
        setSubmitting(false);
        return;
      }
      setBanner({ type: "success", text: `${isEditMode ? "Updated" : "Submitted"} — ${res.updated_records} line(s) relabeled.` });
      setTimeout(() => router.push("/modules/transfer"), 1200);
      // Leave submitting=true on success — page navigates away.
    } catch (err) {
      setBanner({ type: "error", text: err instanceof Error ? err.message : "Failed to submit inner cold transfer." });
      setSubmitting(false);
    }
  };

  // No `if (!allowed) return null` gate: useRequireAuth returns true on the server but
  // false on the client's first render, so gating the render on it causes a hydration
  // mismatch. Effects are gated on `allowed`; the hook redirects unauthenticated users.

  return (
    <TransferChrome title={isEditMode ? "Edit Inner Cold Transfer" : "Inner Cold Transfer"}>
      <button onClick={() => router.push("/modules/transfer")}
        className="text-[12px] text-[var(--text-secondary)] hover:underline mb-3">← Back to Transfer dashboard</button>

      <div className="flex flex-wrap items-end justify-between gap-2 mb-4">
        <h1 className="text-[20px] font-semibold text-[var(--text-primary)]">{isEditMode ? "Edit Inner Cold Transfer" : "Inner Cold Transfer"}</h1>
        <span className="text-[12px] text-[var(--text-secondary)]">Transfer No <span className="font-mono text-[var(--text-primary)]">{transferNo}</span></span>
      </div>

      {editLoading && <div className="mb-4 rounded-md p-3 text-[13px] bg-[var(--background)] border border-[var(--aws-border)] text-[var(--text-secondary)]">Loading transfer…</div>}
      {banner && (
        <div className={`mb-4 rounded-md p-3 text-[13px] border ${banner.type === "error" ? "bg-rose-50 border-rose-200 text-rose-700" : "bg-emerald-50 border-emerald-200 text-emerald-700"}`}>{banner.text}</div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4 max-w-5xl">
        {/* Header */}
        <Card title="Transfer details">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Transfer Date" required><input value={form.transferDate} onChange={(e) => setForm({ ...form, transferDate: e.target.value })}
              placeholder="DD-MM-YYYY" className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" /></Field>
            <Field label="Reason" required>
              <select value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}
                className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-white">
                <option value="">Select…</option>{REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </Field>
            <div className="sm:col-span-2">
              <Field label="Cold store" required>
                {/* Fixed for an edited challan, and while lines are listed (they are for this store). */}
                <StoreChips stores={stores} value={form.fromWarehouse} locked={!!challanStore || (newEntries.length > 0 && !!form.fromWarehouse)}
                  onChange={(v) => setForm({ ...form, fromWarehouse: v })} />
              </Field>
              {stores.length === 0 && !editLoading ? (
                <p className="text-[12px] text-rose-700 mt-1.5">
                  Your account is assigned to {myWarehouses.join(", ")}, which is not a cold store, so it cannot relabel cold stock.
                </p>
              ) : (
                <p className="text-[12px] text-[var(--text-secondary)] mt-1.5">
                  An inner cold transfer relabels lots inside one cold store, and the boxes stay where they are.
                  Moving boxes to another cold store has to be an inter-unit transfer (a request, then Scan &amp; send).
                  {challanStore && ` This challan is at ${challanStore}, so its new lines are too.`}
                  {!challanStore && newEntries.length > 0 && !!form.fromWarehouse && " The store stays as it is while lines are listed; Clear New to pick another."}
                </p>
              )}
            </div>
            <div className="sm:col-span-2">
              <Field label="Reason Description" required><textarea value={form.reasonDescription} onChange={(e) => setForm({ ...form, reasonDescription: e.target.value })}
                rows={2} className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md resize-y" /></Field>
            </div>
          </div>
        </Card>

        {/* Article entry */}
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">Articles ({articles.length})</h2>
          <button type="button" onClick={addArticle}
            className="px-2.5 py-1 text-[12px] border border-[var(--aws-navy)] text-[var(--aws-navy)] rounded-md hover:bg-[var(--aws-navy)] hover:text-white">+ Add Article</button>
        </div>
        {articles.map((a) => (
          <Card key={a.uid} title="Relabel a lot" action={articles.length > 1 ? <button type="button" onClick={() => removeArticle(a.uid)} className="text-[12px] text-rose-600 hover:underline">Remove</button> : undefined}>
            <ColdStockSearch onSelect={(r) => selectStock(a.uid, r)} fromWarehouse={form.fromWarehouse} storeOnly />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-3">
              <Field label="Item Category"><input value={a.itemCategory} readOnly className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-[var(--background)]" /></Field>
              <Field label="Item Description"><input value={a.itemDescription} readOnly className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-[var(--background)]" /></Field>
              <Field label="Old Lot Number"><input value={a.oldLot} readOnly className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-[var(--background)] font-mono" /></Field>
              <Field label="Weight / box (kg)"><input value={a.perBoxWeight || 0} readOnly className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-[var(--background)]" /></Field>
              <Field label={`No. of Boxes${a.maxBoxes != null ? ` (max ${a.maxBoxes}${a.boxesHere != null && a.boxesHere < a.maxBoxes ? `; ${a.boxesHere} at the store by their latest transfer` : ""})` : ""}`} required>
                <input type="number" step="1" min="0" value={a.quantity} onWheel={(e) => e.currentTarget.blur()}
                  onChange={(e) => { const n = parseInt(e.target.value, 10) || 0; patch(a.uid, { quantity: String(a.maxBoxes != null ? Math.min(n, a.maxBoxes) : n) }); }}
                  className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" />
              </Field>
              <Field label="Total Weight (kg)"><input value={(num(a.quantity) * a.perBoxWeight).toFixed(3)} readOnly className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-[var(--background)]" /></Field>
              <Field label="New Lot Number" required><input value={a.newLot} onChange={(e) => patch(a.uid, { newLot: e.target.value })}
                placeholder="Enter new lot" className="w-full px-2.5 py-1.5 text-[13px] border border-orange-300 rounded-md font-mono" /></Field>
            </div>
            <div className="mt-3 flex justify-end">
              <button type="button" onClick={() => addToList(a)}
                className="px-3 py-1.5 text-[12px] rounded-md border border-[var(--aws-navy)] text-[var(--aws-navy)] hover:bg-[var(--aws-navy)] hover:text-white">Add to Transfer List</button>
            </div>
          </Card>
        ))}

        {/* Transfer list */}
        <Card title={`Transfer List (${entries.length})`} action={newEntries.length > 0 ? <button type="button" onClick={clearNew} className="text-[12px] text-rose-600 hover:underline">Clear New</button> : undefined}>
          {entries.length === 0 ? (
            <p className="text-[12px] text-[var(--text-secondary)] py-2">No entries yet — pick a lot, set the new lot, and add it to the list.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]">
                  <th className="py-1.5 pr-2">Item</th><th className="py-1.5 pr-2">Old Lot</th><th className="py-1.5 pr-2">New Lot</th>
                  <th className="py-1.5 pr-2 text-right">Boxes</th><th className="py-1.5 pr-2 text-right">Total Wt</th>
                  {showLocation && <th className="py-1.5 pr-2">New Location</th>}<th /></tr></thead>
                <tbody>{entries.map((en) => (
                  <tr key={en.id} className="border-b border-[var(--aws-border)]/40">
                    <td className="py-1.5 pr-2 max-w-[200px] truncate" title={en.itemDescription}>{en.itemDescription}{en.isExisting && <span className="ml-1 text-[10px] px-1 rounded bg-gray-100 text-gray-600">saved</span>}</td>
                    <td className="py-1.5 pr-2 font-mono">{en.oldLot || "—"}</td>
                    <td className="py-1.5 pr-2 font-mono text-orange-600">{en.newLot}</td>
                    <td className="py-1.5 pr-2 text-right">{en.quantity}</td>
                    <td className="py-1.5 pr-2 text-right">{(en.quantity * en.perBoxWeight).toFixed(3)}</td>
                    {showLocation && <td className="py-1.5 pr-2">{en.newLocation || "—"}</td>}
                    <td className="py-1.5 text-right">{!en.isExisting && <button type="button" onClick={() => removeEntry(en.id)} className="text-rose-600 hover:underline">✕</button>}</td>
                  </tr>))}</tbody>
              </table>
            </div>
          )}
        </Card>

        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-[12px] text-[var(--text-secondary)]">
              {isEditMode ? "Edit appends new lines to this challan." : "Relabels the selected cold-stock lots."}
              {form.fromWarehouse && ` The boxes stay at ${canonicalSite(form.fromWarehouse)}.`}
            </span>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => router.push("/modules/transfer")} className="px-3 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md hover:border-[var(--aws-navy)]">Cancel</button>
              <button type="submit" disabled={submitting || (!isEditMode && entries.length === 0)} className="px-4 py-1.5 text-[13px] rounded-md bg-[var(--aws-navy)] text-white hover:opacity-90 disabled:opacity-50">
                {submitting ? "Submitting…" : isEditMode ? `Update${newEntries.length ? ` (+${newEntries.length} new)` : ""}` : "Submit Transfer"}
              </button>
            </div>
          </div>
        </Card>
      </form>
    </TransferChrome>
  );
}
