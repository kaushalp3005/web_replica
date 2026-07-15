"use client";

// Customer-Returns line editor — a faithful port of the legacy RTVLineEditor.
// Two modes to resolve a line to an all_sku item:
//   • Search — one debounced global typeahead over the SKU master by name.
//   • Browse — four dependent dropdowns (material type → item category →
//     sub category → particulars).
// Either way, picking an item auto-fills material_type / item_category /
// sub_category / sale_group / uom (exactly what the legacy editor filled), then
// exposes the editable numeric grid (UOM, Total Qty, Rate, Value[auto], Carton
// Weight, Net Weight[= UOM × Total Qty]) plus the cold-only fields when the
// factory unit is a cold store.
//
// Data source is the LIVE cascade GET /api/v1/so/sku-lookup via lookupSku
// (all_sku master) — the same endpoint the Sample ArticlePicker uses. The
// dropdown primitive is the shared CascadeDropdown component.

import { useEffect, useRef, useState } from "react";
import { lookupSku, type SkuLookupResponse } from "@/lib/so";
import { CascadeDropdown } from "@/components/CascadeDropdown";
import { cx, num } from "./_shared";

export interface CRLineForm {
  material_type: string;
  item_category: string;
  sub_category: string;
  item_description: string;
  sale_group: string;
  uom: string;
  qty: string;
  rate: string;
  value: string;
  conversion: string;
  carton_weight: string;
  net_weight: string;
  lot_number: string;
  item_mark: string;
  spl_remarks: string;
  vakkal: string;
}

export function emptyCrLine(): CRLineForm {
  return {
    material_type: "", item_category: "", sub_category: "", item_description: "",
    sale_group: "", uom: "", qty: "", rate: "", value: "", conversion: "",
    carton_weight: "", net_weight: "", lot_number: "", item_mark: "",
    spl_remarks: "", vakkal: "",
  };
}

// value = qty × rate; net_weight = UOM × qty (3dp) — the legacy line rules.
// Returns the derived fields to fold into a patch.
function derive(line: CRLineForm, patch: Partial<CRLineForm>): Partial<CRLineForm> {
  const next = { ...line, ...patch };
  const out: Partial<CRLineForm> = { ...patch };
  if ("qty" in patch || "rate" in patch) {
    const q = num(next.qty), r = num(next.rate);
    out.value = q > 0 && r > 0 ? String(q * r) : next.value;
  }
  if ("qty" in patch || "uom" in patch) {
    const u = num(next.uom), q = num(next.qty);
    out.net_weight = u > 0 && q > 0 ? String(parseFloat((u * q).toFixed(3))) : "";
  }
  return out;
}

const labelCls = "text-[11px] text-[var(--text-secondary)]";

export function CustomerReturnLineEditor({
  line, index, isCold, onChange, onRemove, removable = true,
}: {
  line: CRLineForm;
  index: number;
  isCold: boolean;
  onChange: (index: number, patch: Partial<CRLineForm>) => void;
  onRemove?: (index: number) => void;
  removable?: boolean;
}) {
  const isResolved = !!(line.item_description && (line.material_type || line.item_category));
  const [mode, setMode] = useState<"search" | "browse">("search");

  // Search-tab state
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);

  // Browse-tab cascade options (item_types / item_groups / sub_groups / particulars)
  const [opts, setOpts] = useState<NonNullable<SkuLookupResponse["options"]>>({});
  const [loading, setLoading] = useState(false);
  const ctrl = useRef<AbortController | null>(null);

  // Patch helper that also folds in derived value/net_weight.
  const patch = (p: Partial<CRLineForm>) => onChange(index, derive(line, p));

  // Browse cascade options refresh whenever a level changes (input mode only).
  useEffect(() => {
    if (isResolved || mode !== "browse") return;
    const c = new AbortController();
    ctrl.current = c;
    queueMicrotask(() => {
      if (c.signal.aborted) return;
      setLoading(true);
      lookupSku(
        {
          item_type: line.material_type || undefined,
          item_group: line.item_category || undefined,
          sub_group: line.sub_category || undefined,
        },
        c.signal,
      ).then(
        (r) => { if (!c.signal.aborted) { setOpts(r.options ?? {}); setLoading(false); } },
        () => { if (!c.signal.aborted) setLoading(false); },
      );
    });
    return () => c.abort();
  }, [isResolved, mode, line.material_type, line.item_category, line.sub_category]);

  // Debounced global search over the SKU master (Search tab).
  useEffect(() => {
    if (isResolved || mode !== "search") return;
    const q = query.trim();
    let cancelled = false;
    const t = setTimeout(() => {
      queueMicrotask(() => {
        if (cancelled) return;
        if (q.length < 2) { setResults([]); setSearching(false); return; }
        setSearching(true);
        lookupSku({ search: q }).then(
          (r) => { if (!cancelled) { setResults(Array.from(new Set(r.options?.particulars ?? [])).slice(0, 50)); setSearching(false); } },
          () => { if (!cancelled) setSearching(false); },
        );
      });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [isResolved, mode, query]);

  // Resolve a picked particulars name to its full item and auto-fill the line.
  async function resolve(name: string) {
    if (!name) return;
    setBusy(true);
    try {
      const r = await lookupSku({
        particulars: name,
        item_type: line.material_type || undefined,
        item_group: line.item_category || undefined,
        sub_group: line.sub_category || undefined,
      });
      const sel = r.selected_item;
      onChange(index, {
        item_description: sel?.particulars ?? name,
        material_type: sel?.item_type ?? line.material_type,
        item_category: sel?.item_group ?? line.item_category,
        sub_category: sel?.sub_group ?? line.sub_category,
        sale_group: sel?.sale_group ?? "",
        ...(sel?.uom != null ? { uom: String(sel.uom) } : {}),
      });
      setQuery("");
      setResults([]);
    } catch {
      // resolution failed — leave the picker as-is so the operator can retry
    } finally {
      setBusy(false);
    }
  }

  function changeSelection() {
    onChange(index, {
      item_description: "", material_type: "", item_category: "",
      sub_category: "", sale_group: "",
    });
    setOpts({});
    setQuery("");
    setResults([]);
    setMode("search");
  }

  return (
    <div className="border border-[var(--aws-border)] rounded-md bg-[var(--surface-subtle)] p-3 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium text-[var(--text-secondary)]">Line {index + 1}</span>
          {isResolved && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border bg-[#eaf6ed] text-[var(--text-success)] border-[#b6dbb1]">Matched</span>
          )}
        </div>
        {removable && onRemove && (
          <button type="button" onClick={() => onRemove(index)} className="text-[11px] text-[var(--aws-error)] hover:underline">Remove</button>
        )}
      </div>

      {isResolved ? (
        <div className="space-y-3">
          {/* Matched summary */}
          <div className="flex items-start justify-between gap-2 rounded-md border border-[#b6dbb1] bg-[#eaf6ed] px-3 py-2">
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-[var(--text-primary)] break-words">{line.item_description}</p>
              <div className="flex flex-wrap gap-1 mt-1">
                {line.material_type && <span className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--aws-border)] bg-white uppercase">{line.material_type}</span>}
                {line.item_category && <span className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--aws-border)] bg-white">{line.item_category}</span>}
                {line.sub_category && <span className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--aws-border)] bg-white">{line.sub_category}</span>}
              </div>
            </div>
            <button type="button" onClick={changeSelection} className="text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex-shrink-0">Change</button>
          </div>

          {/* Read-only category grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <RO label="Material Type" value={line.material_type} />
            <RO label="Category" value={line.item_category} />
            <RO label="Sub Category" value={line.sub_category} />
            <RO label="Sale Group" value={line.sale_group} />
          </div>

          {/* Editable numeric grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <Num label="UOM" step="0.01" value={line.uom} onChange={(v) => patch({ uom: v })} />
            <Num label="Total Qty (Units/Kgs)" value={line.qty} onChange={(v) => patch({ qty: v })} />
            <Num label="Rate" step="0.01" value={line.rate} onChange={(v) => patch({ rate: v })} />
            <RO label="Value (auto)" value={line.value || "—"} />
            <Num label="Carton Weight" step="0.001" value={line.carton_weight} onChange={(v) => patch({ carton_weight: v })} />
            <RO label="Net Weight (UOM × Qty)" value={line.net_weight || "—"} />
          </div>

          {/* Cold-only fields */}
          {isCold && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-[var(--aws-border)]">
              <Txt label="Lot No" value={line.lot_number} onChange={(v) => patch({ lot_number: v })} />
              <Txt label="Item Mark" value={line.item_mark} onChange={(v) => patch({ item_mark: v })} />
              <Txt label="Spl. Remarks" value={line.spl_remarks} onChange={(v) => patch({ spl_remarks: v })} />
              <Txt label="Vakkal" value={line.vakkal} onChange={(v) => patch({ vakkal: v })} />
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {/* Mode toggle */}
          <div className="inline-flex rounded-[2px] border border-[var(--aws-border-strong)] overflow-hidden">
            {(["search", "browse"] as const).map((t, i) => (
              <button
                key={t} type="button" onClick={() => setMode(t)} disabled={busy}
                className={cx(
                  "px-3 h-7 text-[12px]",
                  i > 0 && "border-l border-[var(--aws-border-strong)]",
                  mode === t ? "bg-[var(--aws-orange)] text-white font-medium" : "bg-white text-[var(--text-secondary)]",
                )}
              >
                {t === "search" ? "Search" : "Browse"}
              </button>
            ))}
          </div>

          {mode === "search" ? (
            <div>
              <input
                autoFocus className="form-input" value={query} onChange={(e) => setQuery(e.target.value)}
                placeholder="Search items by name…"
              />
              {(query.trim().length >= 2 || searching) && (
                <ul className="mt-1 max-h-56 overflow-auto border border-[var(--aws-border)] rounded-[2px] bg-white">
                  {searching && <li className="px-3 py-2 text-[12px] text-[var(--text-muted)]">Searching…</li>}
                  {!searching && results.map((name) => (
                    <li key={name}>
                      <button type="button" disabled={busy} onClick={() => resolve(name)}
                        className="block w-full text-left px-3 py-1.5 text-[13px] hover:bg-[var(--surface-subtle)] disabled:opacity-50">{name}</button>
                    </li>
                  ))}
                  {!searching && query.trim().length >= 2 && results.length === 0 && (
                    <li className="px-3 py-2 text-[12px] text-[var(--text-muted)]">No matching items.</li>
                  )}
                </ul>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
              <CascadeDropdown label="Material type" value={line.material_type} options={opts.item_types ?? []} disabled={busy}
                placeholder="Select material type…"
                onChange={(v) => patch({ material_type: v, item_category: "", sub_category: "", item_description: "", sale_group: "" })} />
              <CascadeDropdown label="Item category" value={line.item_category} options={opts.item_groups ?? []} disabled={busy || !line.material_type}
                placeholder="Select item category…"
                onChange={(v) => patch({ item_category: v, sub_category: "", item_description: "", sale_group: "" })} />
              <CascadeDropdown label="Sub category" value={line.sub_category} options={opts.sub_groups ?? []} disabled={busy || !line.item_category}
                placeholder="Select sub category…"
                onChange={(v) => patch({ sub_category: v, item_description: "", sale_group: "" })} />
              <CascadeDropdown label="Item description" value={line.item_description} options={opts.particulars ?? []} disabled={busy || !line.sub_category}
                placeholder={loading ? "Loading…" : "Select item…"} onChange={resolve} />
            </div>
          )}

          {/* Numeric fields — always visible while resolving */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <Num label="UOM" step="0.01" value={line.uom} onChange={(v) => patch({ uom: v })} />
            <Num label="Total Qty (Units/Kgs)" value={line.qty} onChange={(v) => patch({ qty: v })} />
            <Num label="Rate" step="0.01" value={line.rate} onChange={(v) => patch({ rate: v })} />
            <RO label="Value (auto)" value={line.value || "—"} />
            <Num label="Carton Weight" step="0.001" value={line.carton_weight} onChange={(v) => patch({ carton_weight: v })} />
            <RO label="Net Weight (UOM × Qty)" value={line.net_weight || "—"} />
          </div>
        </div>
      )}
    </div>
  );
}

function RO({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <label className={labelCls}>{label}</label>
      <div className="h-8 rounded border border-[var(--aws-border)] px-2 text-[12px] bg-[var(--background)] flex items-center text-[var(--text-primary)] truncate">{value || "—"}</div>
    </div>
  );
}

function Num({ label, value, step, onChange }: { label: string; value: string; step?: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <label className={labelCls}>{label}</label>
      <input type="number" step={step} value={value} onChange={(e) => onChange(e.target.value)}
        onWheel={(e) => e.currentTarget.blur()}
        className="h-8 rounded border border-[var(--aws-border)] px-2 text-[12px] bg-white w-full" />
    </div>
  );
}

function Txt({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <label className={labelCls}>{label}</label>
      <input value={value} onChange={(e) => onChange(e.target.value)}
        className="h-8 rounded border border-[var(--aws-border)] px-2 text-[12px] bg-white w-full" />
    </div>
  );
}
