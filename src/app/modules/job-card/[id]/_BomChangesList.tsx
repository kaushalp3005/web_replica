"use client";

// "Changes on this job card": the articles removed from this job card's BOM
// (Restore), added articles the BOM module has since gained ("now on the BOM",
// Undo), and removed articles the BOM no longer lists. Collapsed by default.

import { useId, useState } from "react";
import { friendlyApiError } from "@/lib/apiErrors";
import { formatWhen } from "@/lib/floor-requisition-form";
import { BomChangeError, undoBomChange, type BomChangeResult } from "@/lib/job-card-bom";
import type { BomChanges } from "@/lib/job-card-bom-rules";
import { BTN_LINK } from "@/components/floor-requisitions/RequisitionUi";

type Item = { id: number; article: string; type: string; who: string; when: string; card: string;
  note: string | null; mark: string | null; action: "Restore" | "Undo" | null };

export function BomChangesList({
  jobCardId, changes, canEdit, onChanged,
}: {
  jobCardId: number;
  changes: BomChanges | null | undefined;
  canEdit: boolean;
  onChanged: (r: BomChangeResult) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const items: Item[] = [
    ...(changes?.removed ?? []).map((c) => ({
      id: c.change_id, article: c.material_sku_name, type: c.item_type.toUpperCase(), who: c.changed_by,
      when: c.changed_at, card: c.made_on_job_card_number, note: c.note,
      mark: c.not_on_bom ? "Removed · no longer on the BOM" : "Removed", action: "Restore" as const,
    })),
    ...(changes?.added ?? []).filter((c) => c.superseded).map((c) => ({
      id: c.change_id, article: c.material_sku_name, type: c.item_type.toUpperCase(), who: c.changed_by,
      when: c.changed_at, card: c.made_on_job_card_number, note: c.note,
      mark: "Added · now on the BOM", action: "Undo" as const,
    })),
  ];
  if (items.length === 0) return null;

  async function undo(changeId: number) {
    setBusy(changeId);
    setError(null);
    try {
      onChanged(await undoBomChange(jobCardId, changeId));
    } catch (err) {
      setError(err instanceof BomChangeError ? err.message : friendlyApiError(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-3 border-t border-[var(--aws-border)] pt-2">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls={id}
        className="inline-flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
        <span aria-hidden className={`inline-block text-[10px] transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
        Changes on this job card ({items.length})
      </button>
      {open ? (
        <ul id={id} className="mt-2 space-y-1.5 text-[12px]">
          {items.map((it) => (
            <li key={it.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="min-w-0 break-words font-medium text-[var(--text-primary)]">{it.article}</span>
              <span className="text-[var(--text-secondary)]">{it.type} · {it.mark}</span>
              <span className="text-[var(--text-muted)]">by {it.who}, {formatWhen(it.when)}, on {it.card}</span>
              {it.note ? <span className="text-[var(--text-muted)] italic">“{it.note}”</span> : null}
              {canEdit && it.action ? (
                <button type="button" className={BTN_LINK} disabled={busy !== null} onClick={() => void undo(it.id)}>
                  {busy === it.id ? "…" : it.action}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p role="alert" className="mt-1 text-[12px] text-[var(--aws-error)]">{error}</p> : null}
    </div>
  );
}
