"use client";

// Walk-in Purchase Intimation modal — opened from the Material In page header.
// Records a NO-PO arrival: articles are browsed/searched from the GLOBAL SKU
// master via the shared ArticlePicker. POSTs to /api/v1/po/walk-in-intimation,
// which records the arrival under a generated WI-* transaction id and notifies QC.

import { useEffect, useState } from "react";
import { sendWalkInIntimation, type WalkInIntimationResult } from "@/lib/po";
import { ArticlePicker } from "@/app/modules/sample/_form";

type PickedItem = { sku_id: number; sku_name: string };

export function WalkInIntimationModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const titleId = "walkin-intimation-title";

  const [items, setItems] = useState<PickedItem[]>([]);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<WalkInIntimationResult | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Add an article from the picker, de-duped on sku_id.
  function addItem(s: { sku_id: number; sku_name: string }) {
    setItems((prev) => (prev.some((p) => p.sku_id === s.sku_id) ? prev : [...prev, { sku_id: s.sku_id, sku_name: s.sku_name }]));
  }
  function removeItem(skuId: number) {
    setItems((prev) => prev.filter((p) => p.sku_id !== skuId));
  }

  const canSend = !sending && items.length > 0;

  async function handleSend() {
    if (!canSend) return;
    setSending(true);
    setSendError(null);
    setResult(null);
    try {
      const res = await sendWalkInIntimation({ items: items.map((i) => ({ sku_id: i.sku_id, sku_name: i.sku_name })) });
      setResult(res);
    } catch (e) {
      setSendError(e instanceof Error ? e.message : "Failed to send intimation");
    } finally {
      setSending(false);
    }
  }

  // ── Result summary (mirrors SendIntimationModal) ──────────────────────────────
  function renderResult(r: WalkInIntimationResult) {
    const sentCount = r.recipients.filter((rec) => rec.status === "sent").length;
    const failedRecipients = r.recipients.filter((rec) => rec.status !== "sent");
    return (
      <div className="mt-4 space-y-2 text-[13px]">
        <div className="flex items-start gap-2 rounded-[2px] border border-[#b6dbb1] bg-[#eaf6ed] px-3 py-2 text-[var(--text-success)]">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} className="mt-0.5 shrink-0">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span>
            Arrival recorded as <span className="font-mono font-semibold">{r.transaction_no}</span>.{" "}
            {sentCount > 0 ? `Notified ${sentCount} QC recipient${sentCount === 1 ? "" : "s"}.` : "QC will pick it up from the arrivals list."}
          </span>
        </div>
        {failedRecipients.length > 0 ? (
          <div className="rounded-[2px] border border-[var(--aws-border)] bg-[var(--surface-subtle)] px-3 py-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--text-muted)] mb-1">Delivery issues</p>
            {failedRecipients.map((rec, i) => (
              <p key={i} className="text-[var(--aws-error)] text-[12px]">{rec.role} ({rec.phone}): {rec.error ?? rec.status}</p>
            ))}
          </div>
        ) : null}
        {r.skipped.length > 0 ? (
          <div className="rounded-[2px] border border-[var(--aws-border)] bg-[var(--surface-subtle)] px-3 py-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--text-muted)] mb-1">Skipped</p>
            {r.skipped.map((s, i) => (
              <p key={i} className="text-[var(--text-secondary)] text-[12px]">
                {s.reason === "whatsapp_disabled"
                  ? "WhatsApp is disabled on the server."
                  : s.reason === "no_qc_recipients"
                  ? "No QC recipients found."
                  : `${s.role}: ${s.reason}`}
              </p>
            ))}
          </div>
        ) : null}
        {r.errors.length > 0 ? (
          <div className="rounded-[2px] border border-[var(--aws-error)] bg-[#fdf0f0] px-3 py-2">
            {r.errors.map((err, i) => (
              <p key={i} className="text-[var(--aws-error)] text-[12px]">{err}</p>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  const locked = sending || !!result;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-white rounded-md shadow-[0_8px_32px_rgba(0,28,36,0.28)] w-full max-w-2xl flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-3 border-b border-[var(--aws-border)]">
          <h2 id={titleId} className="text-[15px] font-semibold text-[var(--text-primary)]">Send Purchase Intimation</h2>
          <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">
            Walk-in arrival (no PO) — pick articles from the SKU master and notify QC.
          </p>
        </div>

        {/* Scrollable body */}
        <div className="px-5 py-4 overflow-y-auto flex-1">
          {/* Article picker (global SKU master — search + browse) */}
          {!result ? (
            <div className="mb-3">
              <label className="block text-[11px] font-bold uppercase tracking-wide text-[var(--text-secondary)] mb-1.5">
                Add Articles
              </label>
              <ArticlePicker onAdd={addItem} />
            </div>
          ) : null}

          {/* Selected articles */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[11px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">
                Selected Articles ({items.length})
              </label>
            </div>
            <div className="max-h-[280px] overflow-y-auto rounded-[2px] border border-[var(--aws-border)] divide-y divide-[var(--aws-border)]">
              {items.length === 0 ? (
                <p className="px-3 py-2 text-[12px] text-[var(--text-muted)] italic">No articles yet — search or browse above to add.</p>
              ) : (
                items.map((it) => (
                  <div key={it.sku_id} className="flex items-center justify-between gap-2 px-3 py-2 text-[13px]">
                    <span className="truncate" title={it.sku_name}>{it.sku_name}</span>
                    {!locked ? (
                      <button
                        type="button"
                        onClick={() => removeItem(it.sku_id)}
                        aria-label={`Remove ${it.sku_name}`}
                        className="shrink-0 text-[16px] leading-none text-[var(--text-muted)] hover:text-[var(--aws-error)]"
                      >
                        ×
                      </button>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </div>

          {sendError ? (
            <div className="mt-3 rounded-[2px] border border-[var(--aws-error)] bg-[#fdf0f0] px-3 py-2 text-[13px] text-[var(--aws-error)]">
              {sendError}
            </div>
          ) : null}

          {result ? renderResult(result) : null}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[var(--aws-border)] flex justify-end gap-2 shrink-0">
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            className="h-8 px-4 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] disabled:opacity-50"
          >
            {result ? "Close" : "Cancel"}
          </button>
          {!result ? (
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={!canSend}
              className="h-8 px-4 text-[13px] rounded-[2px] border border-[var(--aws-navy)] bg-[var(--aws-navy)] text-white hover:bg-[#0e2847] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {sending ? <span className="inline-block w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" /> : null}
              {sending ? "Sending…" : "Send Intimation"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
