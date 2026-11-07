"use client";

// Shared building blocks for the Transfer-OUT forms (doc 07 transferform + doc 08
// directtransferform): static option lists, the Article/ScannedBox shapes + cascade/
// net-weight helpers, and the small presentational components (Card, Field,
// SearchableSelect, QuickSearch). Kept in one place so both forms stay in lockstep.

import { useEffect, useMemo, useRef, useState } from "react";
import { TransferApi, type CategorialSearchItem, type LookupBox } from "@/lib/transfer";
import { TO_SITES } from "@/lib/sites";
import { articleKey, articleName } from "@/lib/transferBoxMatch";
import { ALL_SITES } from "./_siteRules";

export const UOM_OPTIONS = ["KG", "PCS", "BOX", "BAG", "CARTON"];
// The sites come from the shared site table (lib/sites): a To is any warehouse or cold
// store; a From may also be the legacy "Cold Storage" of an older direct transfer. Whether
// a site is cold is lib/sites isColdSite.
export const FROM_WAREHOUSES = ALL_SITES;
export const TO_WAREHOUSES = TO_SITES;
export const REASONS = ["Stock Requirement", "Material Movement", "Production Need", "Customer Order", "Inventory Balancing", "Other"];
export const VEHICLES = ["MH43BP6885", "MH43BX1881", "MH46BM5987 (Contract Vehicle)"];
export const DRIVERS = ["Tukaram (+919930056340)", "Sachin (8692885298)", "Gopal (+919975887148)"];

export function todayDMY(): string {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
}
export function genTransferNo(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `TRANS${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}

export interface Article {
  uid: number;
  materialType: string; itemCategory: string; subCategory: string; itemDescription: string;
  unitPackSize: string; uom: string; packSize: string; quantity: string; netWeight: string; lotNumber: string;
  // Cold-source identifiers (directtransferform cold mode); absent/empty for warehouse rows.
  // csUnit / csLocation are the picked row's unit and storage location, so the pick takes
  // boxes of that row's store only; csItemMark is its item mark (blank for none), so the
  // pick takes boxes of that mark only. csMaxBoxes is how many of its boxes can go from the
  // From site (the search's available-here count, else its carton count); null = unknown.
  // csCountedHere: csMaxBoxes is the available-here count, which counts an edited
  // transfer's own boxes as in transit on it (the pick does not).
  csCompany?: string; csInwardNo?: string; csUnit?: string; csLocation?: string; csItemMark?: string;
  csMaxBoxes?: number | null; csCountedHere?: boolean;
  entryMode?: "regular" | "cold-storage";
}
export const EMPTY_ARTICLE: Omit<Article, "uid"> = {
  materialType: "", itemCategory: "", subCategory: "", itemDescription: "",
  unitPackSize: "", uom: "", packSize: "1", quantity: "1", netWeight: "0", lotNumber: "",
  csCompany: "", csInwardNo: "", csUnit: "", csLocation: "", csItemMark: "", csMaxBoxes: null, entryMode: "regular",
};

export interface ScannedBox {
  id: number; boxNumber: number; boxId: string; transactionNo: string; article: string;
  lotNumber: string; batchNumber: string; netWeight: string; grossWeight: string;
}

export function calcNetWeight(a: Pick<Article, "materialType" | "quantity" | "packSize" | "unitPackSize">): string {
  const q = parseFloat(a.quantity) || 0;
  const ps = parseFloat(a.packSize) || 0;
  const ups = parseFloat(a.unitPackSize) || 0;
  if (a.materialType.toUpperCase() === "FG") return (ups * ps * q).toFixed(3);
  return (ps * q).toFixed(3);
}

// Apply a field patch with cascade resets + net-weight recompute. A reset only clears a
// downstream field when the SAME patch isn't already setting it (so a bulk set from quick
// search is preserved). Cold articles keep their per-box net_weight (no recompute).
export function patchArticle(prev: Article, patch: Partial<Article>): Article {
  const next: Article = { ...prev, ...patch };
  if ("materialType" in patch) {
    if (!("itemCategory" in patch)) next.itemCategory = "";
    if (!("subCategory" in patch)) next.subCategory = "";
    if (!("itemDescription" in patch)) next.itemDescription = "";
  }
  if ("itemCategory" in patch) {
    if (!("subCategory" in patch)) next.subCategory = "";
    if (!("itemDescription" in patch)) next.itemDescription = "";
  }
  if ("subCategory" in patch && !("itemDescription" in patch)) next.itemDescription = "";
  const isCold = next.entryMode === "cold-storage";
  if (!isCold && ("quantity" in patch || "packSize" in patch || "unitPackSize" in patch || "materialType" in patch || "itemDescription" in patch)) {
    next.netWeight = calcNetWeight(next);
  }
  return next;
}

// ── presentational components ──
export function Card({ title, action, children }: { title?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="bg-white border border-[var(--aws-border)] rounded-lg p-4">
      {(title || action) && (
        <div className="flex items-center justify-between mb-3">
          {title ? <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">{title}</h2> : <span />}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] uppercase tracking-wide text-[var(--text-secondary)] mb-1">{label}{required && <span className="text-rose-500"> *</span>}</span>
      {children}
    </label>
  );
}

// A value the operator can see but not change (a request's locked route, items and reason).
// Empty shows a dash; `multiline` (reason descriptions) wraps the whole text instead of
// clipping it in a small box.
export function ReadOnlyField({ label, value, mono, multiline }: { label: string; value: string; mono?: boolean; multiline?: boolean }) {
  const cls = `w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-[var(--background)] text-[var(--text-primary)]${mono ? " font-mono" : ""}`;
  return (
    <Field label={label}>
      {multiline
        ? <span className={`block min-h-[52px] whitespace-pre-wrap break-words ${cls}`}>{value || <span className="text-[var(--text-secondary)]">—</span>}</span>
        : <input value={value} readOnly placeholder="—" className={cls} />}
    </Field>
  );
}

// Outcome of one camera scan on a Transfer-OUT form (drives the "Scanned QR" result card,
// the transfer-out analogue of the job-card RM tab's ScanResult). "refused" is a box that
// was found but not added because the request doesn't take it (`reason` says why).
// "saving" is a box Scan & send is saving on its transfer; "added" there names the
// transfer it was saved on (`challan`). `label` is the name a Material In box's label
// prints when the box goes by another article (labelName).
export type OutScan =
  | { status: "added"; box_id: string; article: string; lot: string; net: string; tno: string; challan?: string; label?: string }
  | { status: "saving"; box_id: string; article: string; lot: string; tno: string; label?: string }
  | { status: "dup"; box_id: string; tno: string }
  | { status: "refused"; box_id: string; article: string; lot: string; tno: string; reason: string; label?: string }
  | { status: "err"; value: string; error: string };

// The item name a Material In box's label prints (its PO line's Tally name) when the box
// goes by another article (the item-master name it was matched to), so the operator can
// check it against the carton; "" when the two are one name (whitespace and case aside) or
// the box has no Tally name (an IMS box).
export function labelName(box: Pick<LookupBox, "tally_name">, article: string): string {
  const name = articleName(box.tally_name);
  return name && articleKey(name) !== articleKey(article) ? name : "";
}

// Renders the last scan's result below the inline scanner: box added / being saved /
// already scanned / refused / error.
export function ScanAddResult({ scan, onDismiss }: { scan: OutScan; onDismiss: () => void }) {
  const head = (tone: string, label: string) => (
    <div className="flex items-center justify-between gap-2">
      <span className={`text-[12px] px-2 py-0.5 rounded font-semibold ${tone}`}>{label}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="text-[13px] leading-none text-[var(--text-secondary)] hover:text-[var(--text-primary)]">✕</button>
    </div>
  );
  const kv = (rows: [string, React.ReactNode][]) => (
    <dl className="grid grid-cols-[minmax(72px,auto)_1fr] gap-x-4 gap-y-1 text-[12px] mt-2">
      {rows.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-[var(--text-secondary)]">{k}</dt>
          <dd className="text-[var(--text-primary)] font-mono break-all">{v}</dd>
        </div>
      ))}
    </dl>
  );
  let body: React.ReactNode;
  if (scan.status === "added") {
    body = <>{head("bg-emerald-100 text-emerald-800", scan.challan ? "✓ Saved on the transfer" : "✓ Added to dispatch")}
      {kv([["Box ID", scan.box_id], ["Article", scan.article], ["Label", scan.label], ["Txn", scan.tno || "—"], ["Lot", scan.lot || "—"], ["Net", scan.net], ["Transfer", scan.challan]])}</>;
  } else if (scan.status === "saving") {
    body = <>{head("bg-sky-100 text-sky-800", "Saving…")}
      {kv([["Box ID", scan.box_id], ["Article", scan.article], ["Label", scan.label], ["Txn", scan.tno || "—"], ["Lot", scan.lot || "—"]])}</>;
  } else if (scan.status === "dup") {
    body = <>{head("bg-amber-100 text-amber-800", "Already scanned")}
      {kv([["Box ID", scan.box_id], ["Txn", scan.tno || "—"]])}</>;
  } else if (scan.status === "refused") {
    body = <>{head("bg-rose-100 text-rose-800", "✕ Not added")}
      <div className="text-[12px] text-rose-700 mt-1 break-words">{scan.reason}</div>
      {kv([["Box ID", scan.box_id], ["Article", scan.article], ["Label", scan.label], ["Txn", scan.tno || "—"], ["Lot", scan.lot || "—"]])}</>;
  } else {
    body = <>{head("bg-rose-100 text-rose-800", "Scan error")}
      <div className="text-[12px] text-rose-700 mt-1 break-all">{scan.error}</div></>;
  }
  return <div className="bg-white border border-[var(--aws-border)] rounded-md p-3">{body}</div>;
}

export function SearchableSelect({ value, options, onChange, placeholder, disabled }: {
  value: string; options: string[]; onChange: (v: string) => void; placeholder?: string; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const filtered = useMemo(() => { const t = q.trim().toLowerCase(); return t ? options.filter((o) => o.toLowerCase().includes(t)) : options; }, [q, options]);
  return (
    <div className="relative" ref={ref}>
      <button type="button" disabled={disabled} onClick={() => { setOpen((v) => !v); setQ(""); }}
        className={`w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md bg-white text-left flex items-center justify-between gap-2 ${disabled ? "opacity-50 cursor-not-allowed" : "hover:border-[var(--aws-navy)]"}`}>
        <span className={value ? "text-[var(--text-primary)] truncate" : "text-[var(--text-secondary)]"}>{value || placeholder || "Select…"}</span>
        <span className="text-[var(--text-secondary)] shrink-0">▾</span>
      </button>
      {open && !disabled && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-[var(--aws-border)] rounded-md shadow-lg max-h-64 overflow-y-auto">
          <div className="p-1.5 sticky top-0 bg-white border-b border-[var(--aws-border)]">
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="w-full px-2 py-1 text-[12px] border border-[var(--aws-border)] rounded" />
          </div>
          {filtered.length === 0 ? <div className="px-3 py-3 text-[12px] text-[var(--text-secondary)] text-center">No matches</div>
            : filtered.map((o) => <button key={o} type="button" onClick={() => { onChange(o); setOpen(false); }} className={`block w-full text-left px-3 py-1.5 text-[12px] hover:bg-[var(--background)] ${o === value ? "bg-[var(--background)] font-medium" : ""}`}>{o}</button>)}
        </div>
      )}
    </div>
  );
}

export function QuickSearch({ onPick }: { onPick: (it: CategorialSearchItem) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<CategorialSearchItem[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  useEffect(() => {
    const t = q.trim(); if (t.length < 2) return; let off = false;
    const h = setTimeout(async () => {
      try { const r = await TransferApi.categorialSearch(t, 50); if (!off) { setResults(r.items); setOpen(true); } } catch { /* ignore */ }
    }, 300);
    return () => { off = true; clearTimeout(h); };
  }, [q]);
  const onType = (v: string) => { setQ(v); if (v.trim().length < 2) { setResults([]); setOpen(false); } };
  return (
    <div className="relative" ref={ref}>
      <input value={q} onChange={(e) => onType(e.target.value)} onFocus={() => results.length && setOpen(true)}
        placeholder="Quick search item (type 2+ chars)…" className="w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md" />
      {open && results.length > 0 && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-[var(--aws-border)] rounded-md shadow-lg max-h-[60vh] overflow-y-auto">
          {results.map((it) => (
            <button key={`${it.id}-${it.material_type}`} type="button" onClick={() => { onPick(it); setQ(""); setOpen(false); }}
              className="block w-full text-left px-3 py-2 text-[12px] hover:bg-[var(--background)] border-b border-[var(--aws-border)]/40">
              <div className="text-[var(--text-primary)]">{it.item_description}</div>
              <div className="text-[11px] text-[var(--text-secondary)]">{[it.material_type, it.group, it.sub_group].filter(Boolean).join(" · ")}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
