"use client";

// Manual PO Entry — Task 3.3
// Assembles header fields, line form, sections/boxes, label printing, and submit.
// Payload mirrors frontend_replica/src/modules/purchase/po-creation/manual-entry.js
// lines 968–1031.

import React, { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { createPo } from "@/lib/po";
import { BackLink } from "@/components/BackLink";
import { PurchaseChrome } from "../../_chrome";
import { LineForm, EMPTY_LINE, type ManualLine } from "./_LineForm";
import { printLabels, type LabelData } from "./_LabelDialog";

// ── Internal types ────────────────────────────────────────────────────────────

interface ManualSection {
  id: number;
  box_count: string;
  lot_number: string;
  mfg_date: string;
  exp_date: string;
}

interface ManualBox {
  id: number;
  box_number: number;
  net_weight: string;
  gross_weight: string;
  lot_number: string;
  count: string;
}

// Per-line section+box state
interface LineSectionState {
  sections: ManualSection[];
  // boxes keyed by section id
  boxMap: Record<number, ManualBox[]>;
}

// Keyed line entry for stable removal
interface LineEntry {
  id: number;
  line: ManualLine;
}

// ── Shared Tailwind class fragments ──────────────────────────────────────────

const INPUT_CLS =
  "h-8 w-full px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[var(--text-primary)] focus:outline-none focus:border-[var(--aws-navy)] placeholder:text-[var(--text-muted)]";

const SELECT_CLS =
  "h-8 w-full px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[var(--text-primary)] focus:outline-none focus:border-[var(--aws-navy)]";

const LABEL_CLS = "block text-[11px] text-[var(--text-muted)] mb-0.5 truncate";

const BTN_SM =
  "h-7 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] text-[var(--text-secondary)] bg-white hover:bg-[var(--aws-surface,#f8f8f8)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

const BTN_PRIMARY =
  "h-8 px-4 text-[13px] font-semibold rounded-[2px] bg-[var(--aws-navy)] text-white hover:bg-[var(--aws-navy-hover,#1a3a5c)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Monotonically increasing id counter — avoids array-index keys. */
function makeIdGen(): () => number {
  let n = 0;
  return () => ++n;
}

/** Mirror of manual-entry.js generateTransactionNo (line 907). Returns `TR-YYYYMMDDHHMMSS`. */
function generateTransactionNo(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `TR-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

// Global id generators (stable across re-renders via ref, initialized once)
const gLineId = makeIdGen();
const gSectionId = makeIdGen();
const gBoxId = makeIdGen();

function makeEmptyLineEntry(): LineEntry {
  return { id: gLineId(), line: { ...EMPTY_LINE } };
}

function makeSection(): ManualSection {
  return { id: gSectionId(), box_count: "", lot_number: "", mfg_date: "", exp_date: "" };
}

function makeLineSectionState(): LineSectionState {
  return { sections: [], boxMap: {} };
}

/** Generate boxes 1..N for a section. */
function generateBoxes(n: number): ManualBox[] {
  const result: ManualBox[] = [];
  for (let i = 1; i <= n; i++) {
    result.push({ id: gBoxId(), box_number: i, net_weight: "", gross_weight: "", lot_number: "", count: "" });
  }
  return result;
}

// ── Field wrapper ─────────────────────────────────────────────────────────────

function Field({
  label,
  children,
  className = "",
  error,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
  error?: string;
}): React.JSX.Element {
  return (
    <div className={className}>
      <label className={LABEL_CLS}>
        {label}
        {children}
        {error ? <p className="text-[11px] text-[var(--aws-error,#c2483c)] mt-0.5">{error}</p> : null}
      </label>
    </div>
  );
}

// ── SectionEditor ─────────────────────────────────────────────────────────────

interface SectionEditorProps {
  lineIndex: number;
  secIndex: number;
  section: ManualSection;
  boxes: ManualBox[];
  entity: string;
  skuName: string;
  onSectionChange: (updated: ManualSection) => void;
  onGenerateBoxes: () => void;
  onBoxChange: (boxId: number, updated: ManualBox) => void;
  onRemoveSection: () => void;
}

function SectionEditor({
  lineIndex,
  secIndex,
  section,
  boxes,
  entity,
  skuName,
  onSectionChange,
  onGenerateBoxes,
  onBoxChange,
  onRemoveSection,
}: SectionEditorProps): React.JSX.Element {
  const [popupHint, setPopupHint] = useState(false);

  function handlePrint(): void {
    if (boxes.length === 0) return;
    const txNo = generateTransactionNo();
    const base = String(Date.now()).slice(-8);
    const labels: LabelData[] = boxes.map((b, bi) => ({
      transaction_no: txNo,
      entity: entity || "CFPL",
      sku_name: skuName || "(unknown SKU)",
      box_id: `${base}-${bi + 1}`,
      box_number: b.box_number,
      net_weight: b.net_weight ? parseFloat(b.net_weight) : null,
      gross_weight: b.gross_weight ? parseFloat(b.gross_weight) : null,
    }));
    printLabels(labels);
    setPopupHint(true);
  }

  return (
    <div className="mt-2 ml-3 border-l-2 border-[var(--aws-border-strong)] pl-3">
      {/* Section header */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wide">
          Section {secIndex + 1} (Line {lineIndex + 1})
        </span>
        <button type="button" onClick={onRemoveSection} className={BTN_SM} aria-label="Remove section">
          Remove section
        </button>
      </div>

      {/* Section fields */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
        <Field label="Box Count">
          <input
            type="number"
            min={1}
            className={INPUT_CLS}
            placeholder="e.g. 10"
            value={section.box_count}
            onChange={(e) => onSectionChange({ ...section, box_count: e.target.value })}
          />
        </Field>
        <Field label="Lot Number">
          <input
            type="text"
            className={INPUT_CLS}
            placeholder="LOT-XXXX"
            value={section.lot_number}
            onChange={(e) => onSectionChange({ ...section, lot_number: e.target.value })}
          />
        </Field>
        <Field label="Mfg Date">
          <input
            type="date"
            className={INPUT_CLS}
            value={section.mfg_date}
            onChange={(e) => onSectionChange({ ...section, mfg_date: e.target.value })}
          />
        </Field>
        <Field label="Exp Date">
          <input
            type="date"
            className={INPUT_CLS}
            value={section.exp_date}
            onChange={(e) => onSectionChange({ ...section, exp_date: e.target.value })}
          />
        </Field>
      </div>

      {/* Generate boxes button */}
      <div className="flex items-center gap-2 mb-2">
        <button
          type="button"
          onClick={onGenerateBoxes}
          disabled={!section.box_count || parseInt(section.box_count) <= 0}
          className={BTN_SM}
        >
          Generate {section.box_count ? parseInt(section.box_count) || 0 : 0} boxes
        </button>
        {boxes.length > 0 && (
          <button type="button" onClick={handlePrint} className={BTN_SM}>
            Print labels ({boxes.length})
          </button>
        )}
      </div>
      {popupHint && (
        <p className="text-[11px] text-[var(--text-muted)] mb-2">
          If nothing opened, allow popups for this site.
        </p>
      )}

      {/* Box rows */}
      {boxes.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px] border-collapse">
            <thead>
              <tr className="bg-[var(--aws-surface,#f4f4f4)]">
                <th className="px-2 py-1 text-left border border-[var(--aws-border-strong)] font-medium text-[var(--text-muted)]">Box #</th>
                <th className="px-2 py-1 text-left border border-[var(--aws-border-strong)] font-medium text-[var(--text-muted)]">Gross Wt (kg)</th>
                <th className="px-2 py-1 text-left border border-[var(--aws-border-strong)] font-medium text-[var(--text-muted)]">Net Wt (kg)</th>
                <th className="px-2 py-1 text-left border border-[var(--aws-border-strong)] font-medium text-[var(--text-muted)]">Lot Number</th>
                <th className="px-2 py-1 text-left border border-[var(--aws-border-strong)] font-medium text-[var(--text-muted)]">Count</th>
              </tr>
            </thead>
            <tbody>
              {boxes.map((box) => (
                <tr key={box.id}>
                  <td className="px-2 py-1 border border-[var(--aws-border-strong)] font-mono text-[var(--text-secondary)]">
                    {box.box_number}
                  </td>
                  <td className="px-1 py-0.5 border border-[var(--aws-border-strong)]">
                    <input
                      type="number"
                      step="0.001"
                      className="h-7 w-full px-1.5 text-[12px] font-mono border-0 outline-none bg-transparent focus:bg-white focus:border focus:border-[var(--aws-navy)] rounded-[1px]"
                      placeholder="0.000"
                      value={box.gross_weight}
                      onChange={(e) => onBoxChange(box.id, { ...box, gross_weight: e.target.value })}
                    />
                  </td>
                  <td className="px-1 py-0.5 border border-[var(--aws-border-strong)]">
                    <input
                      type="number"
                      step="0.001"
                      className="h-7 w-full px-1.5 text-[12px] font-mono border-0 outline-none bg-transparent focus:bg-white focus:border focus:border-[var(--aws-navy)] rounded-[1px]"
                      placeholder="0.000"
                      value={box.net_weight}
                      onChange={(e) => onBoxChange(box.id, { ...box, net_weight: e.target.value })}
                    />
                  </td>
                  <td className="px-1 py-0.5 border border-[var(--aws-border-strong)]">
                    <input
                      type="text"
                      className="h-7 w-full px-1.5 text-[12px] font-mono border-0 outline-none bg-transparent focus:bg-white focus:border focus:border-[var(--aws-navy)] rounded-[1px]"
                      value={box.lot_number}
                      onChange={(e) => onBoxChange(box.id, { ...box, lot_number: e.target.value })}
                    />
                  </td>
                  <td className="px-1 py-0.5 border border-[var(--aws-border-strong)]">
                    <input
                      type="number"
                      step="1"
                      className="h-7 w-full px-1.5 text-[12px] font-mono border-0 outline-none bg-transparent focus:bg-white focus:border focus:border-[var(--aws-navy)] rounded-[1px]"
                      placeholder="0"
                      value={box.count}
                      onChange={(e) => onBoxChange(box.id, { ...box, count: e.target.value })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Main page component ───────────────────────────────────────────────────────

export default function ManualPoEntryPage(): React.JSX.Element {
  const router = useRouter();
  useRequireAuth(router.replace);

  // ── Header state ──────────────────────────────────────────────────────────
  const [entity, setEntity] = useState<string>("cfpl");
  const [poDate, setPoDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [poNumber, setPoNumber] = useState<string>("");
  const [voucherType, setVoucherType] = useState<string>("");
  const [orderRef, setOrderRef] = useState<string>("");
  const [vendor, setVendor] = useState<string>("");

  // ── Lines state ───────────────────────────────────────────────────────────
  const [lineEntries, setLineEntries] = useState<LineEntry[]>(() => [makeEmptyLineEntry()]);

  // ── Per-line sections + boxes ─────────────────────────────────────────────
  // Keyed by line entry id
  const [sectionStateMap, setSectionStateMap] = useState<Record<number, LineSectionState>>({});

  // ── Validation errors ─────────────────────────────────────────────────────
  const [errors, setErrors] = useState<{ entity?: string; poNumber?: string; lines?: string }>({});

  // ── Submit state ──────────────────────────────────────────────────────────
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // ── Line helpers ──────────────────────────────────────────────────────────

  function addLine(): void {
    setLineEntries((prev) => [...prev, makeEmptyLineEntry()]);
  }

  function updateLine(id: number, updated: ManualLine): void {
    setLineEntries((prev) =>
      prev.map((e) => (e.id === id ? { ...e, line: updated } : e))
    );
  }

  function removeLine(id: number): void {
    setLineEntries((prev) => prev.filter((e) => e.id !== id));
    setSectionStateMap((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  // ── Section helpers (keyed by line entry id) ──────────────────────────────

  function setLineSectionState(lineId: number, updater: (prev: LineSectionState) => LineSectionState): void {
    setSectionStateMap((prev) => ({
      ...prev,
      [lineId]: updater(prev[lineId] ?? makeLineSectionState()),
    }));
  }

  function addSection(lineId: number): void {
    setLineSectionState(lineId, (prev) => ({
      ...prev,
      sections: [...prev.sections, makeSection()],
    }));
  }

  function updateSection(lineId: number, secId: number, updated: ManualSection): void {
    setLineSectionState(lineId, (prev) => ({
      ...prev,
      sections: prev.sections.map((s) => (s.id === secId ? updated : s)),
    }));
  }

  function removeSection(lineId: number, secId: number): void {
    setLineSectionState(lineId, (prev) => {
      const boxMap = { ...prev.boxMap };
      delete boxMap[secId];
      return { sections: prev.sections.filter((s) => s.id !== secId), boxMap };
    });
  }

  function doGenerateBoxes(lineId: number, section: ManualSection): void {
    const n = parseInt(section.box_count) || 0;
    if (n <= 0) return;
    setLineSectionState(lineId, (prev) => ({
      ...prev,
      boxMap: { ...prev.boxMap, [section.id]: generateBoxes(n) },
    }));
  }

  function updateBox(lineId: number, secId: number, boxId: number, updated: ManualBox): void {
    setLineSectionState(lineId, (prev) => ({
      ...prev,
      boxMap: {
        ...prev.boxMap,
        [secId]: (prev.boxMap[secId] ?? []).map((b) => (b.id === boxId ? updated : b)),
      },
    }));
  }

  // ── Validation ────────────────────────────────────────────────────────────

  function validate(): boolean {
    const errs: typeof errors = {};
    if (!entity) errs.entity = "Entity is required";
    if (!poNumber.trim()) errs.poNumber = "PO Number is required";
    const hasLine = lineEntries.some((e) => e.line.skuName.trim() !== "");
    if (!hasLine) errs.lines = "At least one line must have a SKU / Particulars filled in";
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  // ── Submit ────────────────────────────────────────────────────────────────

  async function handleSubmit(): Promise<void> {
    // Validate before acquiring any guard so the guard is never left set on validation failure.
    if (!validate()) return;
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    setSuccessMsg(null);

    // base is computed once; boxSeq increments globally across all lines/sections/boxes
    // so every box in the whole payload receives a unique id: base-1, base-2, …
    const base = String(Date.now()).slice(-8);
    let boxSeq = 0;

    const payloadLines = lineEntries.map((entry, i) => {
      const l = entry.line;
      const lss = sectionStateMap[entry.id] ?? makeLineSectionState();

      const sections = lss.sections.map((sec) => {
        const boxes = lss.boxMap[sec.id] ?? [];
        return {
          line_number: i + 1,
          box_count: parseInt(sec.box_count) || boxes.length,
          lot_number: sec.lot_number || null,
          manufacturing_date: sec.mfg_date || null,
          expiry_date: sec.exp_date || null,
          boxes: boxes.map((b) => ({
            box_id: `${base}-${++boxSeq}`,
            box_number: b.box_number,
            net_weight: b.net_weight ? parseFloat(b.net_weight) : null,
            gross_weight: b.gross_weight ? parseFloat(b.gross_weight) : null,
            lot_number: b.lot_number || null,
            count: b.count ? parseInt(b.count) : null,
          })),
        };
      });

      return {
        line_number: i + 1,
        sku_name: l.skuName,
        particulars: l.skuId ? l.skuName : null,
        item_category: l.itemGroup || null,
        sub_category: l.subGroup || null,
        item_type: l.itemType || null,
        sales_group: l.salesGroup || null,
        uom: l.uom || null,
        pack_count: l.packCount ? parseFloat(l.packCount) : null,
        po_weight: l.poWeight ? parseFloat(l.poWeight) : null,
        rate: l.rate ? parseFloat(l.rate) : null,
        amount: l.amount ? parseFloat(l.amount) : null,
        gst_rate: l.gstRate ? parseFloat(l.gstRate) : null,
        match_score: l.skuId ? 1.0 : null,
        match_source: l.skuId ? "all_sku" : null,
        sgst_amount: l.sgst ? parseFloat(l.sgst) : null,
        cgst_amount: l.cgst ? parseFloat(l.cgst) : null,
        igst_amount: l.igst ? parseFloat(l.igst) : null,
        sections,
      };
    });

    // Header totals (mirror manual-entry.js lines 1026–1030)
    const totalAmount = payloadLines.reduce((s, l) => s + (l.amount ?? 0), 0);
    const sgstAmount = payloadLines.reduce((s, l) => s + (l.sgst_amount ?? 0), 0);
    const cgstAmount = payloadLines.reduce((s, l) => s + (l.cgst_amount ?? 0), 0);
    const igstAmount = payloadLines.reduce((s, l) => s + (l.igst_amount ?? 0), 0);
    const grossTotal = totalAmount + sgstAmount + cgstAmount + igstAmount;

    const payload: Record<string, unknown> = {
      transaction_no: generateTransactionNo(),
      entity,
      po_date: poDate || null,
      po_number: poNumber,
      voucher_type: voucherType || null,
      order_reference_no: orderRef.trim() || null,
      vendor_supplier_name: vendor.trim() || null,
      lines: payloadLines,
      total_amount: totalAmount,
      sgst_amount: sgstAmount,
      cgst_amount: cgstAmount,
      igst_amount: igstAmount,
      gross_total: grossTotal,
    };

    try {
      await createPo(payload);
      setSuccessMsg(`Purchase Order ${poNumber} created`);
      // Navigate after a short delay so the user sees the success message
      setTimeout(() => {
        router.push("/modules/purchase/po-creation");
      }, 1200);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to create Purchase Order";
      setSubmitError(msg);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <PurchaseChrome title="Manual Entry">
      {/* Back link */}
      <BackLink parentHref="/modules/purchase/po-creation" label="PO Upload" />

      {/* Page heading */}
      <div className="mt-1 mb-5">
        <h1 className="text-[22px] font-semibold text-[var(--text-primary)]">Manual PO Entry</h1>
        <p className="text-[13px] text-[var(--text-muted)] mt-0.5">
          Fill in header details, add SKU lines, attach sections/boxes, then submit.
        </p>
      </div>

      {/* ── Header form ── */}
      <section className="bg-white border border-[var(--aws-border-strong)] rounded-[3px] p-4 mb-5">
        <h2 className="text-[13px] font-semibold text-[var(--text-secondary)] mb-3">PO Header</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Field label="Entity *" error={errors.entity}>
            <select
              className={SELECT_CLS + (errors.entity ? " border-[var(--aws-error,#c2483c)]" : "")}
              value={entity}
              onChange={(e) => { setEntity(e.target.value); setErrors((p) => ({ ...p, entity: undefined })); }}
            >
              <option value="cfpl">CFPL</option>
              <option value="cdpl">CDPL</option>
            </select>
          </Field>

          <Field label="PO Date">
            <input
              type="date"
              className={INPUT_CLS}
              value={poDate}
              onChange={(e) => setPoDate(e.target.value)}
            />
          </Field>

          <Field label="PO Number *" error={errors.poNumber}>
            <input
              type="text"
              className={INPUT_CLS + (errors.poNumber ? " border-[var(--aws-error,#c2483c)]" : "")}
              placeholder="e.g. PO-2024-001"
              value={poNumber}
              onChange={(e) => { setPoNumber(e.target.value); setErrors((p) => ({ ...p, poNumber: undefined })); }}
            />
          </Field>

          <Field label="Voucher Type">
            <input
              type="text"
              className={INPUT_CLS}
              placeholder="e.g. Purchase"
              value={voucherType}
              onChange={(e) => setVoucherType(e.target.value)}
            />
          </Field>

          <Field label="Order Reference">
            <input
              type="text"
              className={INPUT_CLS}
              placeholder="Order ref no."
              value={orderRef}
              onChange={(e) => setOrderRef(e.target.value)}
            />
          </Field>

          <Field label="Vendor / Supplier">
            <input
              type="text"
              className={INPUT_CLS}
              placeholder="Vendor name"
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
            />
          </Field>
        </div>
      </section>

      {/* ── Lines ── */}
      <section className="mb-5">
        <h2 className="text-[13px] font-semibold text-[var(--text-secondary)] mb-2">
          Lines
          {errors.lines && (
            <span className="ml-2 text-[12px] font-normal text-[var(--aws-error,#c2483c)]">
              {errors.lines}
            </span>
          )}
        </h2>

        {lineEntries.map((entry, i) => {
          const lss = sectionStateMap[entry.id] ?? makeLineSectionState();

          return (
            <div key={entry.id} className="mb-4">
              {/* LineForm handles the SKU cascade + numeric fields */}
              <LineForm
                line={entry.line}
                index={i}
                onChange={(updated) => updateLine(entry.id, updated)}
                onRemove={() => removeLine(entry.id)}
              />

              {/* Sections for this line */}
              <div className="mt-1">
                {lss.sections.map((sec, si) => (
                  <SectionEditor
                    key={sec.id}
                    lineIndex={i}
                    secIndex={si}
                    section={sec}
                    boxes={lss.boxMap[sec.id] ?? []}
                    entity={entity}
                    skuName={entry.line.skuName}
                    onSectionChange={(updated) => updateSection(entry.id, sec.id, updated)}
                    onGenerateBoxes={() => doGenerateBoxes(entry.id, sec)}
                    onBoxChange={(boxId, updated) => updateBox(entry.id, sec.id, boxId, updated)}
                    onRemoveSection={() => removeSection(entry.id, sec.id)}
                  />
                ))}

                <button
                  type="button"
                  onClick={() => addSection(entry.id)}
                  className={BTN_SM + " mt-2 text-[11px]"}
                >
                  + Add section (Line {i + 1})
                </button>
              </div>
            </div>
          );
        })}

        <button type="button" onClick={addLine} className={BTN_SM}>
          + Add line
        </button>
      </section>

      {/* ── Submit area ── */}
      <div className="border-t border-[var(--aws-border-strong)] pt-4 flex flex-col gap-3">
        {successMsg && (
          <div className="px-3 py-2 text-[13px] rounded-[2px] bg-[var(--aws-success-bg,#d4edda)] text-[var(--aws-success,#1a6632)] border border-[var(--aws-success,#1a6632)]">
            {successMsg}
          </div>
        )}
        {submitError && (
          <div className="px-3 py-2 text-[13px] rounded-[2px] bg-[var(--aws-error-bg,#fde8e8)] text-[var(--aws-error,#c2483c)] border border-[var(--aws-error,#c2483c)]">
            {submitError}
          </div>
        )}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting || !!successMsg}
            className={BTN_PRIMARY}
          >
            {submitting ? "Submitting…" : "Submit Purchase Order"}
          </button>
          <button
            type="button"
            onClick={() => router.push("/modules/purchase/po-creation")}
            className={BTN_SM}
            disabled={submitting}
          >
            Cancel
          </button>
        </div>
      </div>
    </PurchaseChrome>
  );
}
