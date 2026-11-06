"use client";

// Create / edit form for one BOM — the write half of the BOM module screen.
//
// One component, two modes:
//   create  → POST  /api/v1/bom            every field sent; at least one line
//   edit    → PATCH /api/v1/bom/{bom_id}   ONLY what changed is sent
//
// Edit sends a DIFF on purpose. The server treats "key present" as "write this
// column", so spreading the whole header back would (a) list every column in
// the response's changes.header_fields, hiding what the operator actually
// touched, and (b) overwrite columns a concurrent editor changed that this
// operator never looked at. Lines and route are each sent whole, but only once
// that section has been touched: the server matches lines by bom_line_id
// (updated in place, so job-card indents keep pointing at the same line),
// inserts the ones without an id and deletes the rest. A line a job card still
// references cannot be deleted — the server answers 409 `line_referenced`
// naming it and rolls the whole save back, which this form shows verbatim.
//
// Pickers. Material is a type-ahead over all_sku (/api/v1/bom/lookups/
// materials) that also sets the line's rm/pm/sfg from the article's type, with
// a Browse button beside it that opens the four-dropdown cascade every other
// article picker in the app uses (components/MaterialBrowser). Process is a type-ahead
// over the process names other BOMs already use (/lookups/processes) that fills
// the stage slug. Both keep free text: all_sku lags Tally for new articles, and
// a new process name is legitimate.
//
// Same two structural rules as page.tsx: lines and the route are edited as two
// INDEPENDENT lists (they share no key, so there is nothing to nest), and a BOM
// can never be saved with zero lines.

import { useId, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import {
  createBom,
  searchBomMaterials,
  searchBomProcesses,
  updateBom,
  type BomCreateResponse,
  type BomDetail,
  type BomEntity,
  type BomItemType,
  type BomMaterialOption,
  type BomProcessOption,
  type BomStagingMethod,
  type BomUpdateResponse,
} from "@/lib/bom";
import {
  GODOWN_SUGGESTIONS,
  ITEM_TYPES,
  LINE_STAGE_SUGGESTIONS,
  STAGING,
  UOM_SUGGESTIONS,
  asText as s,
  buildCreatePayload,
  buildUpdatePayload,
  headerDraft,
  lineDraft,
  materialPatch,
  moveByKey,
  processPatch,
  stepDraft,
  validate,
  type HeaderDraft,
  type LineDraft,
  type StepDraft,
} from "@/lib/bom-form";
import { friendlyApiError } from "@/lib/apiErrors";
import { SearchSelect } from "@/components/SearchSelect";
import { MaterialBrowser, type BrowsedMaterial } from "@/components/MaterialBrowser";

export type BomFormMode = { mode: "create" } | { mode: "edit"; bomId: number; detail: BomDetail };

export type BomFormResult =
  | { kind: "created"; res: BomCreateResponse }
  | { kind: "updated"; res: BomUpdateResponse };

// Drafts, payload mapping and validation live in lib/bom-form.ts (tested by
// lib/bom-form.test.ts); this file is only the rendering and the wiring.

// ── Component ──────────────────────────────────────────────────────────────

const INPUT =
  "h-7 w-full px-2 text-[12px] rounded-[2px] bg-white border border-[var(--aws-border)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] disabled:bg-[var(--surface-subtle)]";
const CELL =
  "h-6 w-full px-1.5 text-[11px] rounded-[2px] bg-white border border-[var(--aws-border)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]";
const TH =
  "border border-[var(--aws-border)] px-1.5 py-1 text-[9px] font-bold uppercase tracking-wide text-[var(--text-muted)] whitespace-nowrap bg-[var(--surface-subtle)] text-left";
const TD = "border border-[var(--aws-border)] px-1 py-0.5 align-middle";
const BTN_PRIMARY =
  "text-[13px] font-semibold rounded-md px-3 py-1.5 bg-[var(--aws-orange)] text-white hover:bg-[var(--aws-orange-hover)] disabled:opacity-50";
const BTN_SECONDARY =
  "text-[13px] rounded-md px-3 py-1.5 bg-white border border-[var(--aws-border-strong)] text-[var(--text-primary)] hover:border-[var(--aws-navy)] disabled:opacity-50";
const BTN_SMALL =
  "h-6 px-2 text-[11px] rounded-sm border border-[var(--aws-border-strong)] bg-white text-[var(--text-primary)] hover:border-[var(--aws-navy)] disabled:opacity-40";
const ICON_BTN =
  "inline-flex items-center justify-center w-5 h-5 rounded-sm text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] hover:text-[var(--aws-navy)] disabled:opacity-30 disabled:hover:bg-transparent";

export function BomForm(props: BomFormMode & { onClose: () => void; onSaved: (r: BomFormResult) => void }) {
  const isEdit = props.mode === "edit";
  const original = props.mode === "edit" ? props.detail : undefined;

  const [header, setHeader] = useState<HeaderDraft>(() => headerDraft(original?.header));
  const [lines, setLines] = useState<LineDraft[]>(() =>
    original ? original.lines.map((l) => lineDraft(l)) : [lineDraft()],
  );
  const [route, setRoute] = useState<StepDraft[]>(() => (original ? original.route.map((r) => stepDraft(r)) : []));
  // Whole-section dirty flags: on PATCH a section is sent only if touched, so
  // an untouched line set is never rewritten (and never renumbered).
  const [linesDirty, setLinesDirty] = useState(false);
  const [routeDirty, setRouteDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Line key the Browse cascade is open for (null = closed).
  const [browseFor, setBrowseFor] = useState<number | null>(null);

  // <datalist> ids for the free-text cells that have a known vocabulary.
  const uomListId = useId();
  const godownListId = useId();
  const stageListId = useId();
  // A line's "process stage" usually names one of THIS BOM's processes, so the
  // route's names lead the suggestions, followed by the common stored values.
  const stageSuggestions = Array.from(
    new Set([...route.map((st) => st.process_name.trim()).filter(Boolean), ...LINE_STAGE_SUGGESTIONS]),
  );

  const setH = <K extends keyof HeaderDraft>(k: K, v: HeaderDraft[K]) => setHeader((p) => ({ ...p, [k]: v }));

  const patchLine = (key: number, patch: Partial<LineDraft>) => {
    setLinesDirty(true);
    setLines((p) => p.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };
  const addLine = () => {
    setLinesDirty(true);
    setLines((p) => [...p, lineDraft()]);
  };
  const removeLine = (key: number) => {
    setLinesDirty(true);
    setLines((p) => p.filter((l) => l.key !== key));
  };
  const moveLine = (key: number, dir: -1 | 1) => {
    setLinesDirty(true);
    setLines((p) => moveByKey(p, key, dir));
  };

  const patchStep = (key: number, patch: Partial<StepDraft>) => {
    setRouteDirty(true);
    setRoute((p) => p.map((st) => (st.key === key ? { ...st, ...patch } : st)));
  };
  const addStep = () => {
    setRouteDirty(true);
    setRoute((p) => [...p, stepDraft()]);
  };
  const removeStep = (key: number) => {
    setRouteDirty(true);
    setRoute((p) => p.filter((st) => st.key !== key));
  };
  const moveStep = (key: number, dir: -1 | 1) => {
    setRouteDirty(true);
    setRoute((p) => moveByKey(p, key, dir));
  };

  // Picking an article fills the name and, when all_sku knows the type as
  // rm/pm/sfg, the line type too. An fg pick (a hamper component) keeps the
  // type the operator chose — the server will not accept 'fg' on a line.
  const applyMaterial = (key: number, particulars: string, itemType: unknown) =>
    patchLine(key, materialPatch(particulars, itemType));
  const pickMaterial = (key: number, o: BomMaterialOption) => applyMaterial(key, o.particulars, o.item_type);
  const pickBrowsed = (m: BrowsedMaterial) => {
    if (browseFor != null) applyMaterial(browseFor, m.particulars, m.item_type);
    setBrowseFor(null);
  };
  const browseLine = browseFor != null ? lines.find((l) => l.key === browseFor) : undefined;
  const browseIndex = browseLine ? lines.indexOf(browseLine) : -1;

  // Picking a known process fills the stage slug other BOMs store for it,
  // unless the operator already typed one.
  const pickProcess = (st: StepDraft, o: BomProcessOption) => patchStep(st.key, processPatch(st, o));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = validate(header, lines, route);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (props.mode === "create") {
        const res = await createBom(buildCreatePayload(header, lines, route));
        props.onSaved({ kind: "created", res });
        return;
      }

      // Only what changed — header diff, is_active if toggled, and each
      // collection only if touched. See buildUpdatePayload in lib/bom-form.ts.
      const patch = buildUpdatePayload(props.detail.header, header, lines, route, { linesDirty, routeDirty });
      if (patch === null) {
        setError("Nothing has changed.");
        return;
      }
      const res = await updateBom(props.bomId, patch);
      props.onSaved({ kind: "updated", res });
    } catch (err) {
      setError(friendlyApiError(err));
    } finally {
      setSaving(false);
    }
  }

  const title = props.mode === "edit" ? `Edit BOM ${props.bomId}` : "New BOM";
  const subtitle =
    props.mode === "edit"
      ? `${s(props.detail.header.fg_sku_name) || "—"} · version ${s(props.detail.header.version) || "—"}`
      : "Header, lines and processes are saved together.";

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto overflow-x-hidden bg-black/40 px-3 py-6">
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="bom-form-title"
        onSubmit={submit}
        onKeyDown={blockEnterSubmit}
        noValidate
        className="mx-auto w-full min-w-0 max-w-[1160px] bg-white rounded-lg shadow-xl border border-[var(--aws-border)]"
        style={{ maxWidth: "min(1160px, calc(100vw - 24px))" }}
      >
        <header className="flex items-start justify-between gap-3 px-5 py-3 border-b border-[var(--aws-border)]">
          <div className="min-w-0">
            <h2 id="bom-form-title" className="text-[15px] font-semibold text-[var(--text-primary)]">
              {title}
            </h2>
            <p className="text-[11px] text-[var(--text-secondary)] truncate">{subtitle}</p>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Close"
            className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--surface-subtle)] text-[var(--text-secondary)]"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        {/* Shared suggestion lists for the free-text cells below. */}
        <datalist id={uomListId}>
          {UOM_SUGGESTIONS.map((u) => (
            <option key={u} value={u} />
          ))}
        </datalist>
        <datalist id={godownListId}>
          {GODOWN_SUGGESTIONS.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
        <datalist id={stageListId}>
          {stageSuggestions.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>

        <div className="px-5 py-4 flex flex-col gap-5">
          {error ? (
            <p role="alert" className="text-[12px] text-[var(--aws-error)] border border-[var(--aws-error)] bg-[#fff5f5] rounded-md px-3 py-2">
              {error}
            </p>
          ) : null}

          <Section title="Identity">
            <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-4 gap-x-3 gap-y-2">
              <Field label="FG SKU name" required wide>
                <input className={INPUT} value={header.fg_sku_name} onChange={(e) => setH("fg_sku_name", e.target.value)} placeholder="e.g. ROASTED CASHEW 100G" autoFocus={!isEdit} />
              </Field>
              <Field label="Entity">
                <select className={INPUT} value={header.entity} onChange={(e) => setH("entity", e.target.value as "" | BomEntity)}>
                  <option value="">—</option>
                  <option value="cfpl">CFPL</option>
                  <option value="cdpl">CDPL</option>
                </select>
              </Field>
              <Field label="Pack size (kg)">
                <input className={INPUT} inputMode="decimal" value={header.pack_size_kg} onChange={(e) => setH("pack_size_kg", e.target.value)} placeholder="0.100" />
              </Field>
              <Field label="Customer" hint="Blank = generic BOM">
                <input className={INPUT} value={header.customer_name} onChange={(e) => setH("customer_name", e.target.value)} />
              </Field>
              <Field label="Customer code">
                <input className={INPUT} value={header.customer_code} onChange={(e) => setH("customer_code", e.target.value)} />
              </Field>
              <Field label="Output UOM">
                <input className={INPUT} list={uomListId} value={header.output_uom} onChange={(e) => setH("output_uom", e.target.value)} placeholder="kg" />
              </Field>
              {isEdit ? (
                <Field label="Status">
                  <label className="h-7 flex items-center gap-2 text-[12px] text-[var(--text-primary)]">
                    <input type="checkbox" checked={header.is_active} onChange={(e) => setH("is_active", e.target.checked)} />
                    Active
                  </label>
                </Field>
              ) : null}
            </div>
          </Section>

          <Section title="Classification & routing">
            <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-4 gap-x-3 gap-y-2">
              <Field label="Item group">
                <input className={INPUT} value={header.item_group} onChange={(e) => setH("item_group", e.target.value)} />
              </Field>
              <Field label="Sub group">
                <input className={INPUT} value={header.sub_group} onChange={(e) => setH("sub_group", e.target.value)} />
              </Field>
              <Field label="Process category">
                <input className={INPUT} value={header.process_category} onChange={(e) => setH("process_category", e.target.value)} />
              </Field>
              <Field label="Business unit">
                <input className={INPUT} value={header.business_unit} onChange={(e) => setH("business_unit", e.target.value)} />
              </Field>
              <Field label="Factory">
                <input className={INPUT} value={header.factory} onChange={(e) => setH("factory", e.target.value)} />
              </Field>
              <Field label="Floors" hint="Comma-separated">
                <input className={INPUT} value={header.floors} onChange={(e) => setH("floors", e.target.value)} placeholder="Floor 1, Floor 2" />
              </Field>
              <Field label="Machines" hint="Comma-separated">
                <input className={INPUT} value={header.machines} onChange={(e) => setH("machines", e.target.value)} />
              </Field>
              <Field label="Bar line process">
                <input className={INPUT} value={header.bar_line_process} onChange={(e) => setH("bar_line_process", e.target.value)} />
              </Field>
            </div>
          </Section>

          <Section title="Commercial & validity">
            <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-4 gap-x-3 gap-y-2">
              <Field label="Shelf life (days)">
                <input className={INPUT} inputMode="numeric" value={header.shelf_life_days} onChange={(e) => setH("shelf_life_days", e.target.value)} />
              </Field>
              <Field label="GST rate (%)">
                <input className={INPUT} inputMode="decimal" value={header.gst_rate} onChange={(e) => setH("gst_rate", e.target.value)} />
              </Field>
              <Field label="HSN / SAC">
                <input className={INPUT} value={header.hsn_sac} onChange={(e) => setH("hsn_sac", e.target.value)} />
              </Field>
              <Field label="Inventory group">
                <input className={INPUT} value={header.inventory_group} onChange={(e) => setH("inventory_group", e.target.value)} />
              </Field>
              <Field label="Balance tolerance" hint="Fraction: 0.001 = 0.1 %. Blank keeps the default.">
                <input className={INPUT} inputMode="decimal" value={header.allowed_balance_tolerance_pct} onChange={(e) => setH("allowed_balance_tolerance_pct", e.target.value)} placeholder="0.001" />
              </Field>
              <Field label="Effective from" hint={isEdit ? undefined : "Blank = today"}>
                <input className={INPUT} type="date" value={header.effective_from} onChange={(e) => setH("effective_from", e.target.value)} />
              </Field>
              <Field label="Effective to" hint="Blank = no expiry">
                <input className={INPUT} type="date" value={header.effective_to} onChange={(e) => setH("effective_to", e.target.value)} />
              </Field>
              <Field label="Notes" wide>
                <input className={INPUT} value={header.notes} onChange={(e) => setH("notes", e.target.value)} />
              </Field>
            </div>
          </Section>

          <Section
            title={`Lines (${lines.length})`}
            right={
              <button type="button" onClick={addLine} className={BTN_SMALL}>
                + Add line
              </button>
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1500px] text-[11px] border-collapse border border-[var(--aws-border)] bg-white">
                <thead>
                  <tr>
                    <th scope="col" className={`${TH} text-right`}>#</th>
                    <th scope="col" className={TH} title="Type to search the article master (all_sku); pick a row or keep what you typed">Material</th>
                    <th scope="col" className={TH}>Type</th>
                    <th scope="col" className={TH}>Qty / unit</th>
                    <th scope="col" className={TH}>UOM</th>
                    <th scope="col" className={TH}>Loss %</th>
                    <th scope="col" className={TH}>Godown</th>
                    <th scope="col" className={TH}>Off-grade</th>
                    <th scope="col" className={TH}>OG max %</th>
                    <th scope="col" className={TH}>Unit rate ₹</th>
                    <th scope="col" className={TH} title="Which process consumes this line — suggestions come from the processes below">Process stage</th>
                    <th scope="col" className={TH}>Staging</th>
                    <th scope="col" className={TH}>Consumed at stage</th>
                    <th scope="col" className={TH}>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {lines.length === 0 ? (
                    <tr>
                      <td colSpan={14} className={`${TD} py-2 italic text-[var(--aws-error)]`}>
                        A BOM needs at least one line.
                      </td>
                    </tr>
                  ) : (
                    lines.map((l, i) => (
                      <tr key={l.key}>
                        <td className={`${TD} text-right font-mono text-[var(--text-muted)] whitespace-nowrap w-[44px]`} title={l.bom_line_id != null ? `bom_line_id ${l.bom_line_id}` : "new line"}>
                          {i + 1}
                          {l.bom_line_id == null && isEdit ? <span className="ml-0.5 text-[var(--aws-orange)]" aria-label="new line">*</span> : null}
                        </td>
                        <td className={`${TD} min-w-[300px]`}>
                          <div className="flex items-center gap-1">
                            <div className="min-w-0 flex-1">
                              <SearchSelect<BomMaterialOption>
                                value={l.material_sku_name}
                                onChange={(v) => patchLine(l.key, { material_sku_name: v })}
                                onPick={(o) => pickMaterial(l.key, o)}
                                load={(q, signal) => searchBomMaterials(q, { limit: 25 }, signal)}
                                getKey={(o) => String(o.sku_id)}
                                getLabel={(o) => o.particulars}
                                renderOption={(o) => (
                                  <>
                                    <span className="truncate">{o.particulars}</span>
                                    <span className="ml-auto shrink-0 font-mono text-[10px] uppercase text-[var(--text-muted)]">
                                      {s(o.item_type) || "—"}
                                      {o.item_group ? ` · ${o.item_group}` : ""}
                                    </span>
                                  </>
                                )}
                                className={CELL}
                                placeholder="Type to search all_sku…"
                                ariaLabel={`Line ${i + 1} material`}
                                emptyText="No article matches — the text you typed will be saved as is."
                                menuWidth={520}
                              />
                            </div>
                            {/* Browse: type → category → sub category → article. */}
                            <button
                              type="button"
                              onClick={() => setBrowseFor(l.key)}
                              title="Browse the article master: material type → item category → sub category → article"
                              aria-label={`Browse articles for line ${i + 1}`}
                              className={`${ICON_BTN} shrink-0 border border-[var(--aws-border)] bg-white`}
                            >
                              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
                                <line x1="4" y1="6" x2="20" y2="6" />
                                <line x1="4" y1="12" x2="20" y2="12" />
                                <line x1="4" y1="18" x2="20" y2="18" />
                              </svg>
                            </button>
                          </div>
                        </td>
                        <td className={`${TD} w-[70px]`}>
                          <select className={CELL} value={l.item_type} onChange={(e) => patchLine(l.key, { item_type: e.target.value as BomItemType })} aria-label={`Line ${i + 1} type`}>
                            {ITEM_TYPES.map((t) => (
                              <option key={t} value={t}>{t.toUpperCase()}</option>
                            ))}
                          </select>
                        </td>
                        <td className={`${TD} w-[90px]`}>
                          <input className={`${CELL} text-right font-mono`} inputMode="decimal" value={l.quantity_per_unit} onChange={(e) => patchLine(l.key, { quantity_per_unit: e.target.value })} aria-label={`Line ${i + 1} quantity per unit`} />
                        </td>
                        <td className={`${TD} w-[60px]`}>
                          <input className={CELL} list={uomListId} value={l.uom} onChange={(e) => patchLine(l.key, { uom: e.target.value })} placeholder="kg" aria-label={`Line ${i + 1} UOM`} />
                        </td>
                        <td className={`${TD} w-[70px]`}>
                          <input className={`${CELL} text-right font-mono`} inputMode="decimal" value={l.loss_pct} onChange={(e) => patchLine(l.key, { loss_pct: e.target.value })} aria-label={`Line ${i + 1} loss percent`} />
                        </td>
                        <td className={`${TD} w-[110px]`}>
                          <input className={CELL} list={godownListId} value={l.godown} onChange={(e) => patchLine(l.key, { godown: e.target.value })} placeholder="Factory" aria-label={`Line ${i + 1} godown`} />
                        </td>
                        <td className={`${TD} w-[60px] text-center`}>
                          <input type="checkbox" checked={l.can_use_offgrade} onChange={(e) => patchLine(l.key, { can_use_offgrade: e.target.checked })} aria-label={`Line ${i + 1} can use off-grade`} />
                        </td>
                        <td className={`${TD} w-[70px]`}>
                          <input className={`${CELL} text-right font-mono`} inputMode="decimal" value={l.offgrade_max_pct} onChange={(e) => patchLine(l.key, { offgrade_max_pct: e.target.value })} aria-label={`Line ${i + 1} off-grade max percent`} />
                        </td>
                        <td className={`${TD} w-[90px]`}>
                          <input className={`${CELL} text-right font-mono`} inputMode="decimal" value={l.unit_rate_inr} onChange={(e) => patchLine(l.key, { unit_rate_inr: e.target.value })} aria-label={`Line ${i + 1} unit rate`} />
                        </td>
                        <td className={`${TD} w-[150px]`}>
                          <input className={CELL} list={stageListId} value={l.process_stage} onChange={(e) => patchLine(l.key, { process_stage: e.target.value })} placeholder="e.g. Packing" aria-label={`Line ${i + 1} process stage`} />
                        </td>
                        <td className={`${TD} w-[100px]`}>
                          <select className={CELL} value={l.staging_method} onChange={(e) => patchLine(l.key, { staging_method: e.target.value as "" | BomStagingMethod })} aria-label={`Line ${i + 1} staging method`}>
                            <option value="">—</option>
                            {STAGING.map((m) => (
                              <option key={m} value={m}>{m}</option>
                            ))}
                          </select>
                        </td>
                        <td className={`${TD} min-w-[170px]`}>
                          <input className={CELL} value={l.consumed_at_stage} onChange={(e) => patchLine(l.key, { consumed_at_stage: e.target.value })} aria-label={`Line ${i + 1} consumed at stage`} />
                        </td>
                        <td className={`${TD} whitespace-nowrap w-[72px]`}>
                          <RowButtons
                            label={`line ${i + 1}`}
                            first={i === 0}
                            last={i === lines.length - 1}
                            onUp={() => moveLine(l.key, -1)}
                            onDown={() => moveLine(l.key, 1)}
                            onRemove={() => removeLine(l.key)}
                          />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <p className="mt-1.5 text-[10px] text-[var(--text-muted)]">
              Material searches the article master as you type (↓ to open, Enter to pick), or use ☰ to browse it by type → category → sub category; picking an RM / PM / SFG article sets the Type. Order here becomes the line number. Quantities are per ONE unit of FG.
              {isEdit ? " * marks a line that will be inserted; a line a job card already uses cannot be removed." : ""}
            </p>
          </Section>

          <Section
            title={`Processes (${route.length})`}
            right={
              <button type="button" onClick={addStep} className={BTN_SMALL}>
                + Add process
              </button>
            }
          >
            {route.length === 0 ? (
              <p className="text-[11px] italic text-[var(--text-secondary)] border border-dashed border-[var(--aws-border)] rounded-sm px-2 py-1.5">
                No processes on this BOM&rsquo;s route{isEdit && routeDirty ? " — saving will clear the route" : ""}. Use &ldquo;+ Add process&rdquo; to add one.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1300px] text-[11px] border-collapse border border-[var(--aws-border)] bg-white">
                  <thead>
                    <tr>
                      <th scope="col" className={`${TH} text-right`}>#</th>
                      <th scope="col" className={TH} title="Type to search the processes other BOMs use, or enter a new one">Process</th>
                      <th scope="col" className={TH}>Stage slug</th>
                      <th scope="col" className={TH}>Std min</th>
                      <th scope="col" className={TH}>Loss %</th>
                      <th scope="col" className={TH}>QC check</th>
                      <th scope="col" className={TH}>Machine</th>
                      <th scope="col" className={TH}>Operation</th>
                      <th scope="col" className={TH}>Bucket</th>
                      <th scope="col" className={TH}>In kind</th>
                      <th scope="col" className={TH}>Out kind</th>
                      <th scope="col" className={TH}>In code</th>
                      <th scope="col" className={TH}>Out code</th>
                      <th scope="col" className={TH}>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {route.map((st, i) => (
                      <tr key={st.key}>
                        <td className={`${TD} text-right font-mono text-[var(--text-muted)] w-[40px]`}>{i + 1}</td>
                        <td className={`${TD} min-w-[220px]`}>
                          <SearchSelect<BomProcessOption>
                            value={st.process_name}
                            onChange={(v) => patchStep(st.key, { process_name: v })}
                            onPick={(o) => pickProcess(st, o)}
                            load={(q, signal) => searchBomProcesses(q, signal)}
                            getKey={(o) => o.process_name}
                            getLabel={(o) => o.process_name}
                            renderOption={(o) => (
                              <>
                                <span className="truncate">{o.process_name}</span>
                                <span className="ml-auto shrink-0 font-mono text-[10px] text-[var(--text-muted)]">
                                  {o.boms} BOM{o.boms === 1 ? "" : "s"}
                                  {o.stage ? ` · ${o.stage}` : ""}
                                </span>
                              </>
                            )}
                            className={CELL}
                            placeholder="Type or ↓ to list processes…"
                            ariaLabel={`Process ${i + 1} name`}
                            minChars={0}
                            emptyText="No existing process matches — a new name is fine."
                            menuWidth={420}
                          />
                        </td>
                        <td className={`${TD} w-[120px]`}>
                          <input className={`${CELL} font-mono`} value={st.stage} onChange={(e) => patchStep(st.key, { stage: e.target.value })} placeholder="auto" aria-label={`Process ${i + 1} stage slug`} />
                        </td>
                        <td className={`${TD} w-[70px]`}>
                          <input className={`${CELL} text-right font-mono`} inputMode="decimal" value={st.std_time_min} onChange={(e) => patchStep(st.key, { std_time_min: e.target.value })} aria-label={`Process ${i + 1} standard minutes`} />
                        </td>
                        <td className={`${TD} w-[70px]`}>
                          <input className={`${CELL} text-right font-mono`} inputMode="decimal" value={st.loss_pct} onChange={(e) => patchStep(st.key, { loss_pct: e.target.value })} aria-label={`Process ${i + 1} loss percent`} />
                        </td>
                        <td className={`${TD} w-[120px]`}>
                          <input className={CELL} value={st.qc_check} onChange={(e) => patchStep(st.key, { qc_check: e.target.value })} aria-label={`Process ${i + 1} QC check`} />
                        </td>
                        <td className={`${TD} w-[110px]`}>
                          <input className={CELL} value={st.machine_type} onChange={(e) => patchStep(st.key, { machine_type: e.target.value })} aria-label={`Process ${i + 1} machine type`} />
                        </td>
                        <td className={`${TD} w-[130px]`}>
                          <input className={CELL} value={st.practical_operation} onChange={(e) => patchStep(st.key, { practical_operation: e.target.value })} aria-label={`Process ${i + 1} practical operation`} />
                        </td>
                        <td className={`${TD} w-[100px]`}>
                          <input className={CELL} value={st.stage_bucket} onChange={(e) => patchStep(st.key, { stage_bucket: e.target.value })} placeholder="Final FG" aria-label={`Process ${i + 1} stage bucket`} />
                        </td>
                        <td className={`${TD} w-[70px]`}>
                          <input className={CELL} value={st.input_kind} onChange={(e) => patchStep(st.key, { input_kind: e.target.value })} placeholder="RM" aria-label={`Process ${i + 1} input kind`} />
                        </td>
                        <td className={`${TD} w-[70px]`}>
                          <input className={CELL} value={st.output_kind} onChange={(e) => patchStep(st.key, { output_kind: e.target.value })} placeholder="FG" aria-label={`Process ${i + 1} output kind`} />
                        </td>
                        <td className={`${TD} w-[90px]`}>
                          <input className={`${CELL} font-mono`} value={st.input_code} onChange={(e) => patchStep(st.key, { input_code: e.target.value })} aria-label={`Process ${i + 1} input code`} />
                        </td>
                        <td className={`${TD} w-[90px]`}>
                          <input className={`${CELL} font-mono`} value={st.output_code} onChange={(e) => patchStep(st.key, { output_code: e.target.value })} aria-label={`Process ${i + 1} output code`} />
                        </td>
                        <td className={`${TD} whitespace-nowrap w-[72px]`}>
                          <RowButtons
                            label={`process ${i + 1}`}
                            first={i === 0}
                            last={i === route.length - 1}
                            onUp={() => moveStep(st.key, -1)}
                            onDown={() => moveStep(st.key, 1)}
                            onRemove={() => removeStep(st.key)}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-1.5 text-[10px] text-[var(--text-muted)]">
              Order here is the route sequence. Pick a process other BOMs use (↓ lists them) or type a new one; the stage slug is derived from the name when blank.
            </p>
          </Section>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 border-t border-[var(--aws-border)]">
          <p className="text-[11px] text-[var(--text-muted)] max-w-[640px]">
            {isEdit
              ? "Only the fields you changed are sent. Existing lines keep their ids."
              : "RM / PM lines that are not in the Tally BOM sheet may be removed by the next Tally refresh."}
          </p>
          <div className="flex items-center gap-2 ml-auto">
            <button type="button" onClick={props.onClose} disabled={saving} className={BTN_SECONDARY}>
              Cancel
            </button>
            <button type="submit" disabled={saving} className={BTN_PRIMARY}>
              {saving ? "Saving…" : isEdit ? "Save changes" : "Create BOM"}
            </button>
          </div>
        </footer>
      </form>

      {browseLine ? (
        <MaterialBrowser
          key={browseLine.key}
          initialType={browseLine.item_type}
          lineLabel={`line ${browseIndex + 1}${browseLine.material_sku_name.trim() ? ` (${browseLine.material_sku_name.trim()})` : ""}`}
          onPick={pickBrowsed}
          onClose={() => setBrowseFor(null)}
        />
      ) : null}
    </div>
  );
}

// Enter in a text box (not a button, not the submit control) is swallowed so
// a keystroke in the lines table cannot save a half-edited BOM. The pickers
// handle Enter themselves before it reaches here.
function blockEnterSubmit(e: KeyboardEvent<HTMLFormElement>) {
  if (e.key !== "Enter") return;
  const el = e.target as HTMLElement | null;
  if (el && el.tagName === "INPUT" && (el as HTMLInputElement).type !== "submit") e.preventDefault();
}

function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <h3 className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)]">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  hint,
  required,
  wide,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-1 min-w-0 ${wide ? "sm:col-span-2" : ""}`}>
      <span className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)]">
        {label}
        {required ? <span className="text-[var(--aws-error)]"> *</span> : null}
      </span>
      {children}
      {hint ? <span className="text-[10px] text-[var(--text-muted)]">{hint}</span> : null}
    </label>
  );
}

function RowButtons({
  label,
  first,
  last,
  onUp,
  onDown,
  onRemove,
}: {
  label: string;
  first: boolean;
  last: boolean;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-0.5">
      <button type="button" onClick={onUp} disabled={first} aria-label={`Move ${label} up`} className={ICON_BTN}>
        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
          <polyline points="6 15 12 9 18 15" />
        </svg>
      </button>
      <button type="button" onClick={onDown} disabled={last} aria-label={`Move ${label} down`} className={ICON_BTN}>
        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <button type="button" onClick={onRemove} aria-label={`Remove ${label}`} title={`Remove ${label}`} className={`${ICON_BTN} hover:text-[var(--aws-error)]`}>
        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" aria-hidden>
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </span>
  );
}
