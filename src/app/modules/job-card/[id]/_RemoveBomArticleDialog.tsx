"use client";

// The ✕ on a BOM article (Material allocation tab): removes it from this job
// card's BOM — every stage of its chain — or, for an article added to the job
// card, undoes that add. The BOM module is not changed. A refusal (figures saved,
// finished job card …) shows here with the server's message.

import { useRef, useState, type FormEvent } from "react";
import { friendlyApiError } from "@/lib/apiErrors";
import { BomChangeError, removeBomArticle, type BomChangeResult } from "@/lib/job-card-bom";
import { BTN, BTN_PRIMARY, RequisitionModal, TEXTAREA } from "@/components/floor-requisitions/RequisitionUi";

export function RemoveBomArticleDialog({
  jobCardId, article, added, openRequisitionIds, onClose, onDone,
}: {
  jobCardId: number;
  article: string;
  /** An article added to this job card: the ✕ undoes the add. */
  added: boolean;
  openRequisitionIds: number[];
  onClose: () => void;
  onDone: (r: BomChangeResult) => void;
}) {
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onDone(await removeBomArticle(jobCardId, { material_sku_name: article, note: note.trim() || null }));
    } catch (err) {
      setError(err instanceof BomChangeError ? err.message : friendlyApiError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <RequisitionModal title={added ? "Undo added article" : "Remove from this job card"} onClose={onClose} initialFocus={noteRef}>
      <form onSubmit={submit} className="flex flex-col gap-3 p-4 text-[13px] text-[var(--text-primary)]">
        <p>
          {added
            ? <>Take <strong>{article}</strong> off this job card&apos;s BOM (all its stages)?</>
            : <>Remove <strong>{article}</strong> from this job card&apos;s BOM (all its stages)?</>}{" "}
          The BOM in the BOM module is not changed.
        </p>
        {openRequisitionIds.length ? (
          <p className="text-[12px] text-[var(--text-secondary)]">
            {openRequisitionIds.map((id) => `Request #${id}`).join(", ")} stay{openRequisitionIds.length === 1 ? "s" : ""} open;
            Stores can still issue {openRequisitionIds.length === 1 ? "it" : "them"}.
          </p>
        ) : null}
        <label className="flex flex-col gap-1 text-[12px] text-[var(--text-secondary)]">
          Note (optional)
          <textarea ref={noteRef} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} className={TEXTAREA} />
        </label>
        {error ? <p role="alert" className="text-[12px] text-[var(--aws-error)]">{error}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={BTN} onClick={onClose}>Keep it</button>
          <button type="submit" className={BTN_PRIMARY} disabled={saving}>
            {saving ? "Removing…" : added ? "Undo add" : "Remove"}
          </button>
        </div>
      </form>
    </RequisitionModal>
  );
}
