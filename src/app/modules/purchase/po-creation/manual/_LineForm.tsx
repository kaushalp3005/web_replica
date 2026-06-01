"use client";

// Manual-entry line form — Task 3.1
// One row per PO line. Provides cascading SKU lookup (Item Type → Item Group →
// Sub Group → Particulars) backed by skuLookup from @/lib/po.  All numeric
// fields are kept as raw strings in state; coercion happens at submit time in
// the parent page.

import React, { useEffect, useRef, useState } from "react";
import { skuLookup, type SkuLookupResponse } from "@/lib/po";

// ── Public types ──────────────────────────────────────────────────────────────

export interface ManualLine {
  skuId: number | null;
  skuName: string;
  itemType: string;
  itemGroup: string;
  subGroup: string;
  salesGroup: string;
  uom: string;
  packCount: string;
  poWeight: string;
  rate: string;
  amount: string;
  gstRate: string;
  sgst: string;
  cgst: string;
  igst: string;
}

export const EMPTY_LINE: ManualLine = {
  skuId: null,
  skuName: "",
  itemType: "",
  itemGroup: "",
  subGroup: "",
  salesGroup: "",
  uom: "",
  packCount: "",
  poWeight: "",
  rate: "",
  amount: "",
  gstRate: "",
  sgst: "",
  cgst: "",
  igst: "",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Compute poWeight = packCount * uom (as numeric). Returns "" if either
 *  value is non-numeric or empty so we never clobber a manual entry. */
function computePoWeight(packCount: string, uom: string): string {
  const pc = parseFloat(packCount);
  const u = parseFloat(uom);
  if (!Number.isFinite(pc) || !Number.isFinite(u) || packCount === "" || uom === "") {
    return "";
  }
  return String(pc * u);
}

// ── Shared input / label styles ───────────────────────────────────────────────

const INPUT_CLS =
  "h-8 w-full px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[var(--text-primary)] focus:outline-none focus:border-[var(--aws-navy)] placeholder:text-[var(--text-muted)]";

const SELECT_CLS =
  "h-8 w-full px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[var(--text-primary)] focus:outline-none focus:border-[var(--aws-navy)]";

const LABEL_CLS = "block text-[11px] text-[var(--text-muted)] mb-0.5 truncate";

// ── Field wrapper ─────────────────────────────────────────────────────────────

function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={className}>
      <label className={LABEL_CLS}>{label}</label>
      {children}
    </div>
  );
}

// ── LineForm ──────────────────────────────────────────────────────────────────

export function LineForm(props: {
  line: ManualLine;
  index: number;
  onChange: (l: ManualLine) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const { line, index, onChange, onRemove } = props;

  // Latest SKU lookup options — local to this row.
  const [options, setOptions] = useState<SkuLookupResponse["options"]>({});

  // Guard against setting state after unmount.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // AbortController for the latest in-flight lookup.
  const abortRef = useRef<AbortController | null>(null);

  /** Cancel any running lookup and start a new one. */
  function runLookup(params: Parameters<typeof skuLookup>[0]): void {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    void skuLookup(params, ctrl.signal).then((resp) => {
      if (!mountedRef.current || ctrl.signal.aborted) return;
      if (resp.options) setOptions(resp.options);
    }).catch((err: unknown) => {
      if (err instanceof Error && err.name === "AbortError") return;
      // Silent fail — cascade selects degrade gracefully to empty lists.
    });
  }

  // ── On mount: populate top-level item_types ───────────────────────────────
  // Run once at mount; no dep changes needed.
  useEffect(() => {
    runLookup({});
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // ── Cascade handlers ──────────────────────────────────────────────────────

  function handleItemTypeChange(itemType: string): void {
    onChange({
      ...line,
      itemType,
      itemGroup: "",
      subGroup: "",
      salesGroup: "",
      skuName: "",
      skuId: null,
    });
    runLookup({ item_type: itemType });
  }

  function handleItemGroupChange(itemGroup: string): void {
    onChange({ ...line, itemGroup, subGroup: "", salesGroup: "", skuName: "", skuId: null });
    runLookup({ item_type: line.itemType, item_group: itemGroup });
  }

  function handleSubGroupChange(subGroup: string): void {
    onChange({ ...line, subGroup, salesGroup: "", skuName: "", skuId: null });
    runLookup({ item_type: line.itemType, item_group: line.itemGroup, sub_group: subGroup });
  }

  /** Selecting a particular resolves a master SKU and fills all derived fields. */
  function handleParticularsChange(particulars: string): void {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    void skuLookup({ particulars }, ctrl.signal).then((resp) => {
      if (!mountedRef.current || ctrl.signal.aborted) return;
      if (resp.options) setOptions(resp.options);

      const si = resp.selected_item;
      if (!si) {
        // No master hit — just store the free text.
        onChange({ ...line, skuName: particulars, skuId: null });
        return;
      }

      const newUom = String(si.uom ?? "");
      const newGstRate = String(si.gst ?? "");
      const newPackCount = line.packCount;
      // Recompute poWeight with potentially new uom.
      const newPoWeight =
        newUom !== "" ? computePoWeight(newPackCount, newUom) || line.poWeight : line.poWeight;

      onChange({
        ...line,
        skuId: si.sku_id != null ? Number(si.sku_id) : null,
        skuName: si.particulars ?? particulars,
        uom: newUom,
        gstRate: newGstRate,
        itemType: si.item_type ?? line.itemType,
        itemGroup: si.item_group ?? line.itemGroup,
        subGroup: si.sub_group ?? line.subGroup,
        // NOTE: selected_item uses `sale_group` (singular); options uses `sales_groups` (plural).
        salesGroup: si.sale_group ?? line.salesGroup,
        poWeight: newPoWeight,
      });
    }).catch((err: unknown) => {
      if (err instanceof Error && err.name === "AbortError") return;
    });
  }

  // ── Simple field handlers ─────────────────────────────────────────────────

  function handlePackCountChange(packCount: string): void {
    const newPoWeight = computePoWeight(packCount, line.uom) || line.poWeight;
    // Only overwrite poWeight when both fields are numeric and produce a valid result.
    const pc = parseFloat(packCount);
    const u = parseFloat(line.uom);
    const poWeight =
      Number.isFinite(pc) && Number.isFinite(u) && packCount !== "" && line.uom !== ""
        ? newPoWeight
        : line.poWeight;
    onChange({ ...line, packCount, poWeight });
  }

  function handleUomChange(uom: string): void {
    const pc = parseFloat(line.packCount);
    const u = parseFloat(uom);
    const poWeight =
      Number.isFinite(pc) && Number.isFinite(u) && line.packCount !== "" && uom !== ""
        ? computePoWeight(line.packCount, uom)
        : line.poWeight;
    onChange({ ...line, uom, poWeight });
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const itemTypes = options?.item_types ?? [];
  const itemGroups = options?.item_groups ?? [];
  const subGroups = options?.sub_groups ?? [];
  // options.sales_groups (plural) — cascade options for Sales Group dropdown
  const salesGroups = options?.sales_groups ?? [];
  const particularsOpts = options?.particulars ?? [];

  // Unique datalist id per row
  const datalistId = `particulars-dl-${index}`;

  return (
    <div className="bg-white border border-[var(--aws-border-strong)] rounded-[3px] p-3 mb-2">
      {/* Row header */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-[12px] font-semibold text-[var(--text-secondary)]">
          Line {index + 1}
        </span>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove line ${index + 1}`}
          className="h-6 px-2 text-[11px] rounded-[2px] border border-[var(--aws-border-strong)] text-[var(--text-muted)] hover:border-[var(--aws-error,#c2483c)] hover:text-[var(--aws-error,#c2483c)] transition-colors"
        >
          Remove
        </button>
      </div>

      {/* Cascade group: Item Type / Item Group / Sub Group / Particulars */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
        <Field label="Item Type">
          <select
            className={SELECT_CLS}
            value={line.itemType}
            onChange={(e) => handleItemTypeChange(e.target.value)}
          >
            <option value="">— select —</option>
            {itemTypes.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </Field>

        <Field label="Item Group">
          <select
            className={SELECT_CLS}
            value={line.itemGroup}
            onChange={(e) => handleItemGroupChange(e.target.value)}
            disabled={itemGroups.length === 0}
          >
            <option value="">— select —</option>
            {itemGroups.map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
        </Field>

        <Field label="Sub Group">
          <select
            className={SELECT_CLS}
            value={line.subGroup}
            onChange={(e) => handleSubGroupChange(e.target.value)}
            disabled={subGroups.length === 0}
          >
            <option value="">— select —</option>
            {subGroups.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </Field>

        <Field label="Sales Group">
          <select
            className={SELECT_CLS}
            value={line.salesGroup}
            onChange={(e) => onChange({ ...line, salesGroup: e.target.value })}
            disabled={salesGroups.length === 0}
          >
            <option value="">— select —</option>
            {salesGroups.map((sg) => (
              <option key={sg} value={sg}>{sg}</option>
            ))}
          </select>
        </Field>
      </div>

      {/* Particulars (searchable via datalist) + SKU Name free-text */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
        <Field label="Particulars">
          <>
            <datalist id={datalistId}>
              {particularsOpts.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
            <input
              type="text"
              list={datalistId}
              className={INPUT_CLS}
              placeholder="Search / select particular…"
              value={line.skuName}
              onChange={(e) => {
                const val = e.target.value;
                // Check if the typed value exactly matches a known particular → trigger lookup.
                if (particularsOpts.includes(val)) {
                  handleParticularsChange(val);
                } else {
                  // Free text — keep skuId null, just update skuName.
                  onChange({ ...line, skuName: val, skuId: null });
                }
              }}
              onBlur={(e) => {
                // On blur: if value matches a particular, resolve the master item.
                const val = e.target.value.trim();
                if (val && particularsOpts.includes(val)) {
                  handleParticularsChange(val);
                }
              }}
            />
          </>
        </Field>

        <Field label="UOM">
          <input
            type="text"
            className={INPUT_CLS}
            placeholder="e.g. 0.025"
            value={line.uom}
            onChange={(e) => handleUomChange(e.target.value)}
          />
        </Field>
      </div>

      {/* Numeric fields */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-2">
        <Field label="Pack Count">
          <input
            type="number"
            className={INPUT_CLS}
            placeholder="0"
            value={line.packCount}
            onChange={(e) => handlePackCountChange(e.target.value)}
          />
        </Field>

        <Field label="PO Weight">
          <input
            type="number"
            className={INPUT_CLS}
            placeholder="auto"
            value={line.poWeight}
            onChange={(e) => onChange({ ...line, poWeight: e.target.value })}
          />
        </Field>

        <Field label="Rate">
          <input
            type="number"
            className={INPUT_CLS}
            placeholder="0.00"
            value={line.rate}
            onChange={(e) => onChange({ ...line, rate: e.target.value })}
          />
        </Field>

        <Field label="Amount">
          <input
            type="number"
            className={INPUT_CLS}
            placeholder="0.00"
            value={line.amount}
            onChange={(e) => onChange({ ...line, amount: e.target.value })}
          />
        </Field>

        <Field label="GST Rate %">
          <input
            type="number"
            className={INPUT_CLS}
            placeholder="0"
            value={line.gstRate}
            onChange={(e) => onChange({ ...line, gstRate: e.target.value })}
          />
        </Field>

        {/* placeholder col on mobile */}
        <div className="hidden sm:block" />
      </div>

      {/* Tax fields */}
      <div className="grid grid-cols-3 gap-2">
        <Field label="SGST">
          <input
            type="number"
            className={INPUT_CLS}
            placeholder="0.00"
            value={line.sgst}
            onChange={(e) => onChange({ ...line, sgst: e.target.value })}
          />
        </Field>

        <Field label="CGST">
          <input
            type="number"
            className={INPUT_CLS}
            placeholder="0.00"
            value={line.cgst}
            onChange={(e) => onChange({ ...line, cgst: e.target.value })}
          />
        </Field>

        <Field label="IGST">
          <input
            type="number"
            className={INPUT_CLS}
            placeholder="0.00"
            value={line.igst}
            onChange={(e) => onChange({ ...line, igst: e.target.value })}
          />
        </Field>
      </div>

      {/* SKU ID badge (shown when a master item is resolved) */}
      {line.skuId != null ? (
        <div className="mt-2 text-[11px] text-[var(--text-muted)]">
          SKU ID: <span className="font-mono font-semibold text-[var(--text-secondary)]">{line.skuId}</span>
        </div>
      ) : null}
    </div>
  );
}
