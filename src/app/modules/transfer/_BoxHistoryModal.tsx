"use client";

// Box traceability drawer — GET /api/v1/transfer/box-history/{box_id}.
//
// Why this exists: park_boxes stopped deleting the source row, so "is it still in
// cold_stocks?" no longer answers "is this box available?". The ledger does, and this is
// where an operator can see it. `summary.available` is the headline; the timeline is how
// the box got there.
//
// Portal + ESC + backdrop close, matching _PendingTransfersModal.

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { TransferApi, type BoxHistory } from "@/lib/transfer";
import { friendlyApiError } from "@/lib/apiErrors";

const KIND_STYLE: Record<string, { dot: string; label: string }> = {
  transfer_out: { dot: "bg-sky-500", label: "Dispatched" },
  transfer_in: { dot: "bg-emerald-500", label: "Received" },
  disposition: { dot: "bg-amber-500", label: "Left source" },
};

function fmt(when?: string | null): string {
  if (!when) return "—";
  const d = new Date(when);
  return Number.isNaN(d.getTime()) ? when : d.toLocaleString();
}

export function BoxHistoryModal({
  boxId, transactionNo, onClose,
}: {
  boxId: string | null;
  transactionNo?: string | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<BoxHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!boxId) return;
    setLoading(true);
    setError(null);
    // Clear here rather than in the effect body: opening the drawer on a second box must
    // not show the first box's timeline while the new fetch is in flight.
    setData(null);
    try {
      setData(await TransferApi.boxHistory(boxId, transactionNo));
    } catch (e) {
      setData(null);
      setError(friendlyApiError(e));
    } finally {
      setLoading(false);
    }
  }, [boxId, transactionNo]);

  useEffect(() => {
    if (!boxId) return;
    queueMicrotask(() => { load(); });
  }, [boxId, load]);

  useEffect(() => {
    if (!boxId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [boxId, onClose]);

  if (!boxId || typeof document === "undefined") return null;

  const s = data?.summary;
  const body = (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
      onClick={onClose}>
      <div className="mt-10 w-full max-w-2xl rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-[var(--aws-border)] px-4 py-3">
          <div>
            <div className="text-[13px] font-semibold text-[var(--text-primary)]">Box history</div>
            <div className="font-mono text-[12px] text-[var(--text-secondary)]">
              {boxId}{transactionNo ? ` · ${transactionNo}` : ""}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="text-[15px] leading-none text-[var(--text-secondary)] hover:text-[var(--text-primary)]">✕</button>
        </div>

        <div className="px-4 py-3">
          {loading && <div className="py-8 text-center text-[13px] text-[var(--text-secondary)]">Loading history…</div>}
          {error && !loading && (
            <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">{error}</div>
          )}
          {data && !loading && (
            <>
              {/* The headline: a row in cold_stocks is no longer proof of availability. */}
              <div className={`mb-3 rounded px-3 py-2 text-[12px] ${s!.available
                ? "border border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border border-amber-200 bg-amber-50 text-amber-900"}`}>
                {s!.available
                  ? "Available — no live dispatch or disposition against this box."
                  : `Not available — ${s!.in_transit > 0 ? "currently in transit" : "has an active disposition"}.`}
              </div>

              <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {([
                  ["In cold storage", s!.in_cold_stocks],
                  ["In warehouse", s!.in_warehouse],
                  ["In returns", s!.in_returns],
                  ["In transit", s!.in_transit],
                  ["Dispatches", s!.dispatch_events],
                  ["Receipts", s!.receipt_events],
                  ["Ledger events", s!.disposition_events],
                  ["Active dispositions", s!.active_dispositions],
                ] as [string, number][]).map(([label, v]) => (
                  <div key={label} className="rounded border border-[var(--aws-border)] px-2 py-1.5 text-center">
                    <div className="text-[15px] font-semibold text-[var(--text-primary)]">{v}</div>
                    <div className="text-[10px] text-[var(--text-secondary)]">{label}</div>
                  </div>
                ))}
              </div>

              <div className="mb-1 text-[12px] font-semibold text-[var(--text-primary)]">
                Timeline ({data.timeline.length})
              </div>
              {data.timeline.length === 0 ? (
                <div className="py-6 text-center text-[12px] text-[var(--text-secondary)]">
                  No recorded movement for this box.
                </div>
              ) : (
                <ol className="space-y-2">
                  {data.timeline.map((e, i) => {
                    const st = KIND_STYLE[e.kind] || { dot: "bg-gray-400", label: e.kind };
                    return (
                      <li key={`${e.kind}-${e.row_id ?? i}`} className="flex gap-2">
                        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${st.dot}`} />
                        <div className="min-w-0">
                          <div className="text-[12px] text-[var(--text-primary)]">
                            <span className="font-medium">{st.label}</span> — {e.summary}
                          </div>
                          <div className="text-[11px] text-[var(--text-secondary)]">{fmt(e.when)}</div>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
  return createPortal(body, document.body);
}
