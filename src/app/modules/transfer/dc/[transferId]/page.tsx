"use client";

// Delivery Challan print page (doc 10). Loads one transfer by id and renders the printable
// DeliveryChallan (which auto-fires window.print). No chrome, no buttons — a pure document.
// Backed by the existing GET /api/v1/transfer/transfers/{id}.

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { TransferApi, type TransferDetail } from "@/lib/transfer";
import { DeliveryChallan } from "./_DeliveryChallan";

function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

export default function DCPage() {
  const router = useRouter();
  const allowed = useRequireAuth(router.replace);
  const params = useParams<{ transferId: string }>();
  const transferId = params?.transferId;

  const [transfer, setTransfer] = useState<TransferDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!transferId) { setLoading(false); return; }
    setLoading(true);
    try {
      setTransfer(await TransferApi.getTransfer(Number(transferId)));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transfer not found");
      setTransfer(null);
    } finally {
      setLoading(false);
    }
  }, [transferId]);

  useEffect(() => {
    if (!allowed) return;
    queueMicrotask(() => { load(); });
  }, [allowed, load]);

  // No `if (!allowed) return null` gate: useRequireAuth returns true on the server but
  // false on the client's first render, so gating the render on it causes a hydration
  // mismatch. The loading/error guards below already protect the body; effects are gated
  // on `allowed` and the hook redirects unauthenticated users.
  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-[13px] text-[var(--text-secondary)]">Loading DC…</div>;
  }
  if (error || !transfer) {
    return <div className="min-h-screen flex items-center justify-center text-[13px] text-rose-600">Error: {error || "Transfer not found"}</div>;
  }

  // The challan body drops phantom rows (blank / "N/A" description) before it consolidates,
  // so summing EVERY line put the TOTAL row's Qty over a different row set than the column it
  // sits under — transfer 1100 printed 1+550+2+6+8 = 567 and totalled 568 (line 59230, blank
  // description, qty 1). Total exactly the rows that get printed.
  const totalQty = transfer.lines.reduce((s, l) => {
    const desc = (l.item_description || "").trim();
    if (!desc || desc.toUpperCase() === "N/A") return s;
    return s + num(l.quantity);
  }, 0);

  return (
    <DeliveryChallan
      dcNumber={transfer.challan_no || transfer.request_no || "N/A"}
      requestDate={transfer.stock_trf_date || ""}
      fromWarehouse={transfer.from_warehouse || ""}
      toWarehouse={transfer.to_warehouse || ""}
      vehicleNumber={transfer.vehicle_no || "N/A"}
      driverName={transfer.driver_name || "N/A"}
      approvalAuthority={transfer.approved_by || "N/A"}
      reasonDescription={transfer.remark || transfer.reason_code || "N/A"}
      items={transfer.lines}
      // The real box rows — "No. of Boxes" is counted from these via transfer_line_id,
      // not from lines.length (an accepted request is one line per article covering many
      // boxes; a manually-keyed line has none).
      boxes={transfer.boxes}
      // Lines that shipped without a scanned carton park one "In Transit" unit each.
      // Without these the Boxes column printed "—" for a vehicle carrying ten units.
      parkedUnits={transfer.parked_units ?? []}
      totalQtyRequired={totalQty}
      isPartial={(transfer.status || "").toLowerCase() === "partial"}
    />
  );
}
