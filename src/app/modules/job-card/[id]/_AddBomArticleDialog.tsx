"use client";

// "+ Add article" (Material allocation tab): picks an RM / PM / FG / SFG article
// from the SKU master and adds it to this job card's BOM — every stage of its
// chain — with an optional required qty (pcs for PM, kg for the rest). The BOM
// module is not changed. Adding an article that was removed from this job card
// restores it — the server keeps no required qty or note then, so the dialog
// asks for neither. "Use" on other floor stock opens the same dialog with the
// article already picked (`preset`): it is added by name, the server finding the
// SKU (an FG / SFG added here is RM for accounting — spec Addendum A). Either way
// the article's stock on this floor shows under it.

import { useRef, useState, type FormEvent } from "react";
import { friendlyApiError } from "@/lib/apiErrors";
import { checkQty } from "@/lib/floor-requisition-form";
import { addBomArticle, BomChangeError, type BomChangeResult } from "@/lib/job-card-bom";
import { bomUnit, isUsableType, restoresRemoved, stockOnFloor, type BomChanges } from "@/lib/job-card-bom-rules";
import type { FloorStockItem } from "@/lib/stock-take";
import { ArticlePicker } from "@/app/modules/sample/_form";
import { BTN, BTN_LINK, BTN_PRIMARY, FIELD, RequisitionModal, TEXTAREA } from "@/components/floor-requisitions/RequisitionUi";

type Picked = { sku_id: number; sku_name: string; item_type?: string };

export function AddBomArticleDialog({
  jobCardId, preset, floorItems, place, bomChanges, onClose, onDone,
}: {
  jobCardId: number;
  /** Use on other floor stock: the article, already picked (no picker). */
  preset?: { name: string; itemType: string } | null;
  /** This floor's stock; null = not loaded. */
  floorItems: FloorStockItem[] | null;
  /** "A185 · Mezzanine", or "this floor" when the job card has no place. */
  place: string;
  /** This job card's BOM changes: an article it removed is restored, not added. */
  bomChanges?: BomChanges | null;
  onClose: () => void;
  onDone: (r: BomChangeResult) => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [required, setRequired] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const article = preset
    ? { name: preset.name, itemType: preset.itemType }
    : picked ? { name: picked.sku_name, itemType: picked.item_type ?? "" } : null;
  const type = (article?.itemType ?? "").trim().toUpperCase();
  const typeOk = isUsableType(type);
  const unit = bomUnit(type);
  const restores = !!article && restoresRemoved(bomChanges, article.name);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!article || !typeOk) return;
    let qty: number | null = null;
    if (required.trim() && !restores) {
      const c = checkQty(required, unit);
      if (!c.ok) { setError(c.message); return; }
      qty = c.value;
    }
    // A restore brings the BOM line back as it was: no required qty, no note.
    const rest = restores ? {} : { required_qty: qty, note: note.trim() || null };
    // Use sends the name (+ type hint) and the server finds the SKU; the picker
    // has already resolved one.
    const body = preset
      ? { material_sku_name: preset.name, item_type: preset.itemType.trim().toLowerCase(), ...rest }
      : picked ? { sku_id: picked.sku_id, ...rest } : null;
    if (!body) return;
    setSaving(true);
    setError(null);
    try {
      onDone(await addBomArticle(jobCardId, body));
    } catch (err) {
      setError(err instanceof BomChangeError ? err.message : friendlyApiError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <RequisitionModal title={preset ? "Use on this job card" : "Add article to this job card"} onClose={onClose} initialFocus={cancelRef} wide>
      <form onSubmit={submit} className="flex flex-col gap-3 p-4 text-[13px] text-[var(--text-primary)]">
        <p className="text-[12px] text-[var(--text-secondary)]">
          Adds an article to this job card&apos;s BOM (all its stages). The BOM in the BOM module is not changed.
        </p>
        {article ? (
          <div className="flex flex-col gap-1 border border-[var(--aws-border)] rounded-[2px] px-2.5 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{article.name}</span>
              <span className="rounded border border-[var(--aws-border)] px-1.5 text-[11px] text-[var(--text-secondary)]">{type || "—"}</span>
              {preset ? null : (
                <button type="button" className={BTN_LINK} onClick={() => { setPicked(null); setError(null); }}>Change</button>
              )}
            </div>
            <p className="text-[12px] text-[var(--text-muted)]">{stockOnFloor(floorItems, article.name, place)}</p>
          </div>
        ) : (
          <ArticlePicker onAdd={(s) => { setPicked(s); setError(null); }} restrictItemType={["rm", "pm", "fg", "sfg"]} />
        )}
        {article && !typeOk ? (
          <p role="alert" className="text-[12px] text-[var(--aws-error)]">Only RM, PM, FG and SFG articles can be added.</p>
        ) : null}
        {article && typeOk && restores ? (
          <p className="text-[12px] text-[var(--text-secondary)]">
            Restores {article.name}, removed from this job card.
          </p>
        ) : null}
        {article && typeOk && !restores ? (
          <label className="flex flex-col gap-1 text-[12px] text-[var(--text-secondary)]">
            Required qty ({unit}, optional)
            <input className={`${FIELD} w-40`} inputMode="decimal" value={required} onChange={(e) => setRequired(e.target.value)} />
          </label>
        ) : null}
        {restores ? null : (
          <label className="flex flex-col gap-1 text-[12px] text-[var(--text-secondary)]">
            Note (optional)
            <textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} className={TEXTAREA} />
          </label>
        )}
        {error ? <p role="alert" className="text-[12px] text-[var(--aws-error)]">{error}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button ref={cancelRef} type="button" className={BTN} onClick={onClose}>Cancel</button>
          <button type="submit" className={BTN_PRIMARY} disabled={saving || !article || !typeOk}>
            {restores ? (saving ? "Restoring…" : "Restore") : saving ? "Adding…" : "Add"}
          </button>
        </div>
      </form>
    </RequisitionModal>
  );
}
