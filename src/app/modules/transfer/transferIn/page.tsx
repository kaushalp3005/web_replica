"use client";

// Transfer In (Receive / GRN) — doc 02. P8a shell + P8c core wiring: search a
// transfer-out, acknowledge its boxes into a pending GRN, and Confirm Receipt
// (finalize → posts stock). Backed by the rollback-verified receive endpoints.
//
// Deferred (large / device-dependent / power-user): camera QR scanning, thermal
// label printing, edit/reopen dialogs, manual cold-storage item entry, the lot
// dedicator, STBR box-id reconciliation, and the create_transfer_in fallback.

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useRequireAuth, useMe } from "@/lib/user";
import { TransferChrome } from "../_chrome";
import {
  TransferApi, type TransferDetail, type TransferBox, type AcknowledgeBoxInput,
} from "@/lib/transfer";

function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

const ACK_EMAILS = new Set([
  "yash@candorfoods.in", "b.hrithik@candorfoods.in", "sunil.jasoria@candorfoods.in",
]);

function toAck(b: TransferBox): AcknowledgeBoxInput {
  return {
    box_id: b.box_id || "",
    transfer_out_box_id: b.id,
    article: b.article,
    batch_number: b.batch_number,
    lot_number: b.lot_number,
    transaction_no: b.transaction_no,
    net_weight: b.net_weight != null ? num(b.net_weight) : null,
    gross_weight: b.gross_weight != null ? num(b.gross_weight) : null,
    is_matched: true,
  };
}

function ReceiveInner() {
  const router = useRouter();
  const allowed = useRequireAuth(router.replace);
  const me = useMe();
  const searchParams = useSearchParams();
  const resumeNo = searchParams.get("resume");

  const email = (me?.email || "").toLowerCase();
  const canAcknowledge = me?.is_admin === true || ACK_EMAILS.has(email);
  const receivedBy = me?.full_name || me?.email || "web";

  const [transferNumber, setTransferNumber] = useState("");
  const [transferData, setTransferData] = useState<TransferDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [boxCondition, setBoxCondition] = useState("Good");
  const [conditionRemarks, setConditionRemarks] = useState("");

  const [pendingHeaderId, setPendingHeaderId] = useState<number | null>(null);
  const [acked, setAcked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [doneGrn, setDoneGrn] = useState<string | null>(null);

  const resetReceiveState = () => { setPendingHeaderId(null); setAcked(new Set()); setDoneGrn(null); };

  const doSearch = useCallback(async (no: string) => {
    const q = no.trim();
    if (!q) return;
    setLoading(true); setError(null); setTransferData(null); resetReceiveState();
    try {
      const t = await TransferApi.getTransferByNumber(q);
      if (!t) { setError(`No transfer found for "${q}".`); return; }
      setTransferData(t);
      // Detect/resume an in-progress GRN for this transfer-out.
      try {
        const pend = await TransferApi.getPendingByTransferOut(t.id);
        if (pend.exists && pend.header) {
          setPendingHeaderId(pend.header.id);
          setAcked(new Set(pend.header.boxes.map((b) => b.box_id).filter(Boolean)));
        }
      } catch { /* resume detection is best-effort */ }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!allowed || !resumeNo) return;
    queueMicrotask(() => { setTransferNumber(resumeNo); doSearch(resumeNo); });
  }, [allowed, resumeNo, doSearch]);

  const ackableBoxes = useMemo(
    () => (transferData?.boxes ?? []).filter((b) => !!b.box_id), [transferData]);

  const totals = useMemo(() => {
    const lines = transferData?.lines ?? [];
    const boxes = transferData?.boxes ?? [];
    return {
      boxes: boxes.length,
      qty: lines.reduce((s, l) => s + num(l.quantity), 0),
      net: lines.reduce((s, l) => s + num(l.net_weight), 0),
      gross: boxes.reduce((s, b) => s + num(b.gross_weight), 0),
    };
  }, [transferData]);

  const allMatched = ackableBoxes.length > 0 && acked.size === ackableBoxes.length;

  const ensurePending = useCallback(async (): Promise<number> => {
    if (pendingHeaderId) return pendingHeaderId;
    if (!transferData) throw new Error("No transfer loaded.");
    const hdr = await TransferApi.createPendingTransferIn({
      transfer_out_id: transferData.id,
      grn_number: `GRN-${transferData.challan_no}`,
      receiving_warehouse: transferData.to_warehouse,
      received_by: receivedBy,
      box_condition: boxCondition,
      condition_remarks: conditionRemarks,
    });
    setPendingHeaderId(hdr.id);
    // Adopt any boxes already on the (possibly resumed) header.
    if (hdr.boxes?.length) setAcked(new Set(hdr.boxes.map((b) => b.box_id).filter(Boolean)));
    return hdr.id;
  }, [pendingHeaderId, transferData, receivedBy, boxCondition, conditionRemarks]);

  const onAckBox = async (b: TransferBox) => {
    if (!b.box_id) return;
    setBusy(true); setError(null);
    try {
      const hid = await ensurePending();
      await TransferApi.acknowledgeBox(hid, toAck(b));
      setAcked((prev) => new Set(prev).add(b.box_id!));
    } catch (e) { setError(e instanceof Error ? e.message : "Acknowledge failed."); }
    finally { setBusy(false); }
  };

  const onAckAll = async () => {
    setBusy(true); setError(null);
    try {
      const hid = await ensurePending();
      const todo = ackableBoxes.filter((b) => !acked.has(b.box_id!));
      if (todo.length) {
        const res = await TransferApi.acknowledgeBatch(hid, todo.map(toAck));
        if (res.conflicts?.length) setError(`${res.conflicts.length} box(es) had conflicts.`);
      }
      setAcked(new Set(ackableBoxes.map((b) => b.box_id!)));
    } catch (e) { setError(e instanceof Error ? e.message : "Acknowledge-all failed."); }
    finally { setBusy(false); }
  };

  const onUnack = async (b: TransferBox) => {
    if (!pendingHeaderId || !b.box_id) return;
    setBusy(true); setError(null);
    try {
      await TransferApi.unacknowledgeBox(pendingHeaderId, b.box_id);
      setAcked((prev) => { const next = new Set(prev); next.delete(b.box_id!); return next; });
    } catch (e) { setError(e instanceof Error ? e.message : "Un-acknowledge failed."); }
    finally { setBusy(false); }
  };

  const onConfirm = async () => {
    setBusy(true); setError(null);
    try {
      const hid = await ensurePending();
      const result = await TransferApi.finalizeTransferIn(hid, {
        box_condition: boxCondition, condition_remarks: conditionRemarks,
      });
      setDoneGrn(result.grn_number);
      setTimeout(() => router.push("/modules/transfer"), 1800);
    } catch (e) { setError(e instanceof Error ? e.message : "Confirm receipt failed."); }
    finally { setBusy(false); }
  };

  if (!allowed) return null;

  const isCold = !!transferData?.from_cold_unit;

  return (
    <TransferChrome title="Transfer In (Receive)">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-[18px] font-semibold text-[var(--text-primary)]">Transfer In</h1>
        <button onClick={() => router.push("/modules/transfer")}
          className="text-[12px] text-[var(--text-secondary)] hover:underline">← Back</button>
      </div>

      {/* Find transfer */}
      <div className="bg-white border border-[var(--aws-border)] rounded-md p-4 mb-4">
        <div className="text-[12px] font-medium text-[var(--text-primary)] mb-2">Find Transfer</div>
        <div className="flex gap-2">
          <input
            value={transferNumber}
            onChange={(e) => setTransferNumber(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") doSearch(transferNumber); }}
            placeholder="Enter transfer / challan number…"
            className="border border-[var(--aws-border)] rounded px-2 py-1.5 text-[13px] flex-1"
          />
          <button onClick={() => doSearch(transferNumber)} disabled={loading || !transferNumber.trim()}
            className="px-4 py-1.5 text-[13px] rounded bg-[var(--aws-navy)] text-white disabled:opacity-40">
            {loading ? "Searching…" : "Search"}
          </button>
        </div>
        {error && <div className="mt-2 text-[12px] text-rose-700">{error}</div>}
      </div>

      {doneGrn ? (
        <div className="py-12 text-center">
          <div className="text-[15px] font-semibold text-emerald-700 mb-1">Receipt confirmed — {doneGrn}</div>
          <div className="text-[12px] text-[var(--text-secondary)]">Stock posted to destination. Returning to the dashboard…</div>
        </div>
      ) : !transferData ? (
        <div className="py-12 text-center text-[13px] text-[var(--text-secondary)]">
          Search a dispatched transfer by its challan number to begin receiving.
        </div>
      ) : (
        <div className="space-y-4">
          {/* Route info */}
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-4 flex flex-wrap items-center gap-3">
            <span className="text-[13px] font-medium">{transferData.from_cold_unit || transferData.from_warehouse}</span>
            <span className="text-[var(--text-secondary)]">→</span>
            <span className="text-[13px] font-medium">{transferData.to_warehouse}</span>
            <span className="ml-auto text-[11px] px-2 py-0.5 rounded border border-[var(--aws-border)]">{transferData.challan_no}</span>
            {isCold && <span className="text-[11px] px-2 py-0.5 rounded bg-sky-100 text-sky-800">Cold storage</span>}
            {pendingHeaderId && <span className="text-[11px] px-2 py-0.5 rounded bg-amber-100 text-amber-800">Receiving (GRN #{pendingHeaderId})</span>}
          </div>

          {/* Box acknowledgement (when box-level data exists) */}
          {ackableBoxes.length > 0 ? (
            <div className="bg-white border border-[var(--aws-border)] rounded-md">
              <div className="px-4 py-3 border-b border-[var(--aws-border)] flex items-center justify-between">
                <span className="text-[13px] font-semibold text-[var(--text-primary)]">
                  Box Acknowledgement — {acked.size}/{ackableBoxes.length}
                </span>
                {canAcknowledge && (
                  <button onClick={onAckAll} disabled={busy || allMatched}
                    className="px-3 py-1 text-[12px] rounded border border-[var(--aws-border)] hover:border-[var(--aws-navy)] disabled:opacity-40">
                    Acknowledge All
                  </button>
                )}
              </div>
              {!canAcknowledge && (
                <div className="px-4 py-2 text-[11px] text-amber-800 bg-amber-50">
                  You are not authorized to receive transfers — viewing only.
                </div>
              )}
              <table className="hidden md:table w-full text-[12px]">
                <thead><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]/50">
                  <th className="px-4 py-1.5">Box ID</th><th>Article</th><th>Lot</th><th className="text-right">Net Wt</th><th className="text-center">State</th>
                </tr></thead>
                <tbody>
                  {ackableBoxes.map((b) => {
                    const isAck = acked.has(b.box_id!);
                    return (
                      <tr key={b.id} className={`border-b border-[var(--aws-border)]/40 ${isAck ? "bg-emerald-50/40" : ""}`}>
                        <td className="px-4 py-1.5 font-mono">{b.box_id}</td>
                        <td>{b.article}</td>
                        <td className="font-mono">{b.lot_number || "—"}</td>
                        <td className="text-right">{b.net_weight}</td>
                        <td className="text-center">
                          {!canAcknowledge ? (isAck ? <span className="text-emerald-700">Acknowledged</span> : "—")
                            : isAck ? (
                              <button onClick={() => onUnack(b)} disabled={busy}
                                className="text-emerald-700 underline decoration-dotted">Acknowledged</button>
                            ) : (
                              <button onClick={() => onAckBox(b)} disabled={busy}
                                className="px-2 py-0.5 text-[11px] rounded border border-[var(--aws-border)] hover:border-[var(--aws-navy)]">Acknowledge</button>
                            )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="md:hidden p-3 space-y-2">
                {ackableBoxes.map((b) => {
                  const isAck = acked.has(b.box_id!);
                  return (
                    <div key={b.id} className={`border rounded p-2 ${isAck ? "border-emerald-200 bg-emerald-50/40" : "border-[var(--aws-border)]"}`}>
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-[12px]">{b.box_id}</span>
                        {canAcknowledge && (isAck
                          ? <button onClick={() => onUnack(b)} disabled={busy} className="text-[11px] text-emerald-700 underline decoration-dotted">Acknowledged</button>
                          : <button onClick={() => onAckBox(b)} disabled={busy} className="text-[11px] px-2 py-0.5 rounded border border-[var(--aws-border)]">Acknowledge</button>)}
                      </div>
                      <div className="text-[11px] text-[var(--text-secondary)]">{b.article} · Lot {b.lot_number || "—"} · Net {b.net_weight}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="bg-white border border-[var(--aws-border)] rounded-md">
              <div className="px-4 py-3 border-b border-[var(--aws-border)] text-[13px] font-semibold text-[var(--text-primary)]">
                Items to receive ({transferData.lines.length})
              </div>
              <table className="w-full text-[12px]">
                <thead><tr className="text-left text-[var(--text-secondary)] border-b border-[var(--aws-border)]/50">
                  <th className="px-4 py-1.5">Item</th><th>Qty</th><th className="text-right">Net Wt</th><th>Lot</th>
                </tr></thead>
                <tbody>
                  {transferData.lines.map((l) => (
                    <tr key={l.id} className="border-b border-[var(--aws-border)]/40">
                      <td className="px-4 py-1.5">{l.item_description}</td><td>{l.quantity}</td>
                      <td className="text-right">{l.net_weight}</td><td className="font-mono">{l.lot_number || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="px-4 py-2 text-[11px] text-[var(--text-secondary)]">
                This transfer has no box-level data; box-by-box receiving isn’t available (line-level receive is a later pass).
              </div>
            </div>
          )}

          {/* Totals */}
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
            <div><div className="text-[18px] font-semibold">{totals.boxes}</div><div className="text-[11px] text-[var(--text-secondary)]">Total Boxes</div></div>
            <div><div className="text-[18px] font-semibold">{totals.qty}</div><div className="text-[11px] text-[var(--text-secondary)]">Total Qty</div></div>
            <div><div className="text-[18px] font-semibold">{totals.net.toFixed(2)}</div><div className="text-[11px] text-[var(--text-secondary)]">Net Wt (kg)</div></div>
            <div><div className="text-[18px] font-semibold">{totals.gross.toFixed(2)}</div><div className="text-[11px] text-[var(--text-secondary)]">Gross Wt (kg)</div></div>
          </div>

          {/* Condition assessment */}
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-4">
            <div className="text-[12px] font-medium text-[var(--text-primary)] mb-2">Condition Assessment</div>
            <div className="flex flex-wrap gap-3">
              <select value={boxCondition} onChange={(e) => setBoxCondition(e.target.value)}
                className="border border-[var(--aws-border)] rounded px-2 py-1 text-[12px]">
                <option>Good</option><option>Damaged</option><option>Partial</option>
              </select>
              <input value={conditionRemarks} onChange={(e) => setConditionRemarks(e.target.value)}
                placeholder="Condition remarks…"
                className="border border-[var(--aws-border)] rounded px-2 py-1 text-[12px] flex-1 min-w-[200px]" />
            </div>
          </div>

          {/* Confirm */}
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-4">
            <button onClick={onConfirm} disabled={busy || !canAcknowledge || !allMatched}
              className="w-full py-2 text-[13px] rounded bg-[var(--aws-navy)] text-white disabled:opacity-40">
              {busy ? "Working…" : "Confirm Receipt"}
            </button>
            {!allMatched && ackableBoxes.length > 0 && (
              <p className="mt-2 text-[11px] text-[var(--text-secondary)] text-center">
                Acknowledge all {ackableBoxes.length} boxes to enable Confirm.
              </p>
            )}
          </div>
        </div>
      )}
    </TransferChrome>
  );
}

export default function TransferInReceivePage() {
  return (
    <Suspense fallback={null}>
      <ReceiveInner />
    </Suspense>
  );
}
