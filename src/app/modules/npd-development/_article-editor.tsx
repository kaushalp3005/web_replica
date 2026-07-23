"use client";

// Shared per-article editor for NPD dev job cards (082): one target article's details
// + its own base BOM + trial recipe. Used by the create form (job-cards/new) and the
// detail page's editable Articles card. A card develops one or more of these.

import { useRef, useState } from "react";
import { getBomLines, type DevArticle, type DevArticleInput, type BomOption } from "@/lib/npd-dev";
import { ArticlePicker, UomSelect, BomPicker } from "../sample/_form";

export interface DraftLine {
  sku_id: number | null;
  sku_name: string;
  qty: string;
  uom: string;
  item_type: "rm" | "pm";
  fromBase?: boolean;       // replicated from the base BOM (vs added here)
  is_off_master?: boolean;  // free-typed external/test ingredient (not in master)
  notes?: string;
}

export interface ArticleDraft {
  uid: string;              // stable client id — keys the editor across add/remove
  name: string;
  pcs: string;
  weightPerPiece: string;
  baseBomId: number | null;
  baseBomLabel: string;
  seeding: boolean;
  lines: DraftLine[];
}

const ITEM_TYPES: ("rm" | "pm")[] = ["rm", "pm"];
let _uidSeq = 0;
export const nextUid = () => `a${++_uidSeq}`;
export const emptyArticle = (): ArticleDraft =>
  ({ uid: nextUid(), name: "", pcs: "", weightPerPiece: "", baseBomId: null, baseBomLabel: "", seeding: false, lines: [] });

export function articleQty(a: ArticleDraft): number {
  const p = Number(a.pcs), w = Number(a.weightPerPiece);
  return a.pcs.trim() !== "" && a.weightPerPiece.trim() !== "" && Number.isFinite(p) && Number.isFinite(w)
    ? Number((p * w).toFixed(3)) : 0;
}

// Card needs a title; every article needs a name + a recipe (≥1 line — from a base BOM
// OR built by hand; base BOM is optional) and not mid-seed, and names must be distinct
// (each promotes into its own BOM keyed by name).
export const articlesValid = (rows: ArticleDraft[]) => {
  if (!(rows.length > 0 && rows.every((a) => a.name.trim() !== "" && a.lines.length > 0 && !a.seeding))) return false;
  const names = rows.map((a) => a.name.trim());
  return new Set(names).size === names.length;
};
export const articlesTotalQty = (rows: ArticleDraft[]) => rows.reduce((s, a) => s + articleQty(a), 0);

// Read model (DevArticle from the detail GET) → editable draft.
export function articleToDraft(a: DevArticle): ArticleDraft {
  return {
    uid: nextUid(),
    name: a.name ?? "",
    pcs: a.pcs != null ? String(a.pcs) : "",
    weightPerPiece: a.weight_per_piece != null ? String(a.weight_per_piece) : "",
    baseBomId: a.base_bom_id ?? null,
    baseBomLabel: a.base_bom_name ?? "",
    seeding: false,
    lines: (a.lines ?? []).map((l) => ({
      sku_id: l.sku_id ?? null, sku_name: l.sku_name, qty: String(l.qty ?? ""),
      uom: l.uom, item_type: (l.item_type ?? "rm") as "rm" | "pm",
      // base-cloned lines have no sku_id AND aren't off-master; an external test
      // ingredient also has no sku_id but must NOT be tagged base (else selectBase
      // would drop it on re-select).
      fromBase: l.sku_id == null && !l.is_off_master, is_off_master: l.is_off_master ?? false, notes: l.notes ?? undefined,
    })),
  };
}

// Editable draft → create/replace API payload.
export function draftToInput(a: ArticleDraft): DevArticleInput {
  return {
    name: a.name.trim(),
    pcs: a.pcs ? Number(a.pcs) : undefined,
    weight_per_piece: a.weightPerPiece ? Number(a.weightPerPiece) : undefined,
    base_bom_id: a.baseBomId ?? undefined,
    base_bom_name: a.baseBomLabel || undefined,
    lines: a.lines.map((l, idx) => ({
      sku_id: l.sku_id, sku_name: l.sku_name, qty: Number(l.qty) || 0,
      uom: l.uom, item_type: l.item_type, is_off_master: l.is_off_master ?? false,
      line_order: idx, notes: l.notes || null,
    })),
  };
}

// ── One article: details + its own base BOM + trial recipe ───────────────────
export function ArticleEditor({ index, article, uom, onChange, onLines, onRemove, canRemove }: {
  index: number;
  article: ArticleDraft;
  uom: string;
  onChange: (patch: Partial<ArticleDraft>) => void;
  onLines: (fn: (lines: DraftLine[]) => DraftLine[]) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const [extName, setExtName] = useState("");
  const qty = articleQty(article);
  const baseCount = article.lines.filter((l) => l.fromBase).length;
  const baseSeqRef = useRef(0);

  // Selecting a base BOM replicates its lines into THIS article's recipe (keeping any
  // manually-added lines). Line edits go through onLines (functional) so nothing is
  // dropped; a seq token ignores a stale fetch when the base BOM is re-selected fast.
  async function selectBase(b: BomOption | null) {
    const seq = ++baseSeqRef.current;
    if (!b) {
      onChange({ baseBomId: null, baseBomLabel: "" });
      onLines((lines) => lines.filter((l) => !l.fromBase));
      return;
    }
    onChange({ baseBomId: b.bom_id, baseBomLabel: b.fg_sku_name ?? "", seeding: true });
    try {
      const bl = await getBomLines(b.bom_id);
      if (seq !== baseSeqRef.current) return;   // superseded by a newer base selection
      const baseLines: DraftLine[] = bl.map((x) => ({
        sku_id: null, sku_name: x.material_sku_name, qty: String(x.quantity_per_unit ?? ""),
        uom: x.uom || "kg", item_type: x.item_type === "pm" ? "pm" : "rm", fromBase: true,
      }));
      onLines((lines) => [...baseLines, ...lines.filter((l) => !l.fromBase)]);
      onChange({ seeding: false });
    } catch {
      if (seq !== baseSeqRef.current) return;
      onChange({ baseBomId: null, baseBomLabel: "", seeding: false });
    }
  }

  function addLine(s: { sku_id: number; sku_name: string; item_type?: string }) {
    const t: "rm" | "pm" = s.item_type === "pm" ? "pm" : "rm";
    onLines((lines) => (lines.some((l) => l.sku_id === s.sku_id)
      ? lines : [...lines, { sku_id: s.sku_id, sku_name: s.sku_name, qty: "1", uom: "kg", item_type: t, fromBase: false }]));
  }
  function addExternal() {
    const name = extName.trim();
    if (!name) return;
    onLines((lines) => [...lines, { sku_id: null, sku_name: name, qty: "1", uom: "kg", item_type: "rm", fromBase: false, is_off_master: true }]);
    setExtName("");
  }
  function patchLine(i: number, patch: Partial<DraftLine>) {
    onLines((lines) => lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function removeLine(i: number) {
    onLines((lines) => lines.filter((_, idx) => idx !== i));
  }

  return (
    <div className="border border-[var(--aws-border)] rounded-md p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[11px] w-6 h-6 rounded-full bg-[var(--aws-orange)] text-white font-bold flex items-center justify-center shrink-0">{index + 1}</span>
        <span className="text-[13px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide">Article {index + 1}</span>
        <div className="flex-1" />
        {canRemove && (
          <button type="button" onClick={onRemove} aria-label="Remove article" title="Remove article"
            className="w-7 h-7 flex items-center justify-center rounded-[2px] text-[var(--aws-error)] hover:bg-[#fdf3f1]">✕</button>
        )}
      </div>

      {/* details */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Target product name <span className="text-[var(--aws-error)]">*</span></label>
          <input className="form-input" value={article.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="becomes this article's promoted BOM FG name" />
        </div>
        <div>
          <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Pcs</label>
          <input className="form-input" type="number" min="0" step="1" value={article.pcs}
            onChange={(e) => onChange({ pcs: e.target.value })} onWheel={(e) => e.currentTarget.blur()} placeholder="e.g. 25" />
        </div>
        <div>
          <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Weight per piece (kg)</label>
          <input className="form-input" type="number" min="0" step="0.001" value={article.weightPerPiece}
            onChange={(e) => onChange({ weightPerPiece: e.target.value })} onWheel={(e) => e.currentTarget.blur()} placeholder="e.g. 0.5" />
        </div>
        <div>
          <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Quantity ({uom})</label>
          <input className="form-input bg-[var(--surface-subtle)] cursor-not-allowed" value={qty > 0 ? qty.toLocaleString("en-IN") : "—"} readOnly tabIndex={-1} />
        </div>
      </div>

      {/* base BOM (optional — a shortcut to replicate an existing recipe) */}
      <div className="mt-3">
        <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Base BOM <span className="text-[var(--text-muted)] font-normal normal-case">(optional)</span></label>
        <BomPicker value={article.baseBomId} valueLabel={article.baseBomLabel}
          placeholder="Search or browse a base BOM…" onChange={selectBase} />
        <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">
          {article.seeding ? "Replicating the base recipe…"
            : article.baseBomId != null ? `${baseCount} line(s) replicated into the trial recipe below — add ingredients on top.`
              : "Optional — pick one to replicate its recipe, or build the trial recipe from scratch below."}
        </p>
      </div>

      {/* trial recipe */}
      <div className="mt-3">
        <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Trial recipe</label>
        <div className="space-y-3">
          <ArticlePicker onAdd={addLine} restrictItemType={["rm", "pm"]} />
          <div className="border border-dashed border-[var(--aws-border-strong)] rounded-md p-3 bg-[var(--surface-subtle)]">
            <label className="block text-[11px] font-medium text-[var(--text-secondary)] mb-1">External test ingredient (not in the master)</label>
            <div className="flex items-end gap-2">
              <input className="form-input flex-1" value={extName} placeholder="Type a new ingredient name…"
                onChange={(e) => setExtName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addExternal(); } }} />
              <button type="button" onClick={addExternal} disabled={!extName.trim()}
                className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] disabled:opacity-50 hover:bg-white">Add</button>
            </div>
          </div>
          {article.lines.length === 0 ? (
            <p className="text-[13px] text-[var(--text-muted)]">{article.baseBomId == null ? "Add ingredients above to build the recipe, or pick a base BOM to replicate an existing one." : "This base BOM has no lines — add ingredients to build the recipe."}</p>
          ) : (
            <div className="space-y-2">
              {article.lines.map((l, i) => (
                <div key={l.sku_id ?? `n-${i}`} className="border border-[var(--aws-border)] rounded-md p-3">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="text-[13px] font-medium text-[var(--text-primary)] flex items-center gap-2">
                      {l.sku_name}
                      <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${l.fromBase ? "bg-[var(--surface-subtle)] text-[var(--text-secondary)]" : l.is_off_master ? "bg-[#fff7ed] text-[#c2410c]" : "bg-[#eef2ff] text-[#4338ca]"}`}>{l.fromBase ? "base" : l.is_off_master ? "external" : "added"}</span>
                    </span>
                    <button onClick={() => removeLine(i)} className="text-[12px] text-[var(--aws-error)] hover:underline">Remove</button>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    <label className="text-[11px] text-[var(--text-secondary)]">Qty
                      <input className="form-input mt-0.5" type="number" min="0" step="0.001" value={l.qty}
                        onChange={(e) => patchLine(i, { qty: e.target.value })} />
                    </label>
                    <label className="text-[11px] text-[var(--text-secondary)]">UOM
                      <UomSelect className="mt-0.5" value={l.uom} onChange={(v) => patchLine(i, { uom: v })} />
                    </label>
                    <label className="text-[11px] text-[var(--text-secondary)]">Type
                      <select className="form-input mt-0.5" value={l.item_type} onChange={(e) => patchLine(i, { item_type: e.target.value as "rm" | "pm" })}>
                        {ITEM_TYPES.map((t) => <option key={t} value={t}>{t.toUpperCase()}</option>)}
                      </select>
                    </label>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
