// Builds ChallanHoverCard data from a transfer/transfer-in detail. Mirrors the
// production groupBoxesByItem / groupLinesByItem aggregation (group by item+lot,
// sum qty/weight, resolve cold source unit with a fallback to the header unit) — but over
// BOTH sources at once, so a partially scanned dispatch is never rendered as a subset.

import type { HoverData, HoverLine } from "./_ChallanHoverCard";
import type { TransferDetail, TransferInDetail } from "@/lib/transfer";

function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

// One entry per item+lot, driven by the LINES and enriched with the box rows attributed to
// them (interunit_transfer_boxes.transfer_line_id). Choosing one source or the other on
// `boxes.length` rendered a PARTIALLY scanned dispatch as a subset with nothing saying so:
// transfer 1891 showed 14 groups / 78 boxes / 862.00 kg of a dispatch that actually holds
// 17 items / 231 units / 1800.000 kg — 52% of the weight simply absent (74 transfers are in
// that state). The lines are the complete record, so grouping on them makes the card account
// for 100% of the dispatch by construction.
//
// Two quantities, two fields, because they are not the same thing: `qty` is the scanned box
// count and `lineQty` the unit quantity the lines record. Both are taken from the MERGED group,
// never per line: box rows land on whichever sibling line the dispatch screen was on, so one
// line of transfer 881 holds all 590 boxes while its 589 siblings hold none, and per-line
// arithmetic would count those 589 units a second time as if they were unscanned.
function groupDispatchByItem(
  boxes: TransferDetail["boxes"], lines: TransferDetail["lines"], fallbackUnit?: string | null,
): HoverLine[] {
  const boxesByLine = new Map<number, { n: number; unit: string | null }>();
  for (const b of boxes) {
    if (b.transfer_line_id == null) continue;
    const cur = boxesByLine.get(b.transfer_line_id);
    const unit = b.lot_origin_unit || b.source_unit || b.source_storage || null;
    if (cur) { cur.n += 1; cur.unit = cur.unit || unit; }
    else boxesByLine.set(b.transfer_line_id, { n: 1, unit });
  }
  const map = new Map<string, HoverLine & { _w: number; _q: number; _b: number }>();
  for (const l of lines) {
    const lot = l.lot_number || "";
    const key = `${l.item_description}||${lot}`;
    const bx = boxesByLine.get(l.id);
    const cur = map.get(key);
    if (cur) {
      cur._q += num(l.quantity); cur._w += num(l.net_weight); cur._b += bx ? bx.n : 0;
      cur.sourceUnit = cur.sourceUnit || bx?.unit || null;
    } else {
      map.set(key, {
        name: l.item_description, qty: null, lineQty: null, weightKg: 0, lot: lot || null,
        sourceUnit: bx?.unit || fallbackUnit || null,
        _q: num(l.quantity), _w: num(l.net_weight), _b: bx ? bx.n : 0,
      });
    }
  }
  // Rounded once, at the end — a sum of rounded box weights would not add up to the
  // dispatch weight the list row shows.
  return [...map.values()].map(({ _w, _q, _b, ...rest }) => ({
    ...rest,
    qty: _b > 0 ? _b : null,
    // The line quantity, shown whenever it is not simply the box count — two independently
    // true figures rather than a subtraction. `_q - _b` would have to clamp at zero (43
    // dispatches have a group holding more boxes than that group's own quantity, the same
    // lopsided attribution as above) and the card would then stop adding up to the dispatch.
    lineQty: _q !== _b ? _q : null,
    weightKg: +_w.toFixed(2),
  }));
}

export function transferHoverData(d: TransferDetail): HoverData {
  const fallback = d.from_cold_unit;
  const lines = groupDispatchByItem(d.boxes, d.lines, fallback);
  const meta = [];
  if (d.vehicle_no) meta.push({ label: "Vehicle", value: d.vehicle_no });
  if (d.driver_name) meta.push({ label: "Driver", value: d.driver_name });
  if (d.has_variance) meta.push({ label: "Variance", value: "yes", tone: "warn" as const });
  return { lines, meta };
}

export function transferInHoverData(d: TransferInDetail): HoverData {
  const meta = [];
  if (d.received_by) meta.push({ label: "Received by", value: d.received_by });
  if (d.box_condition) meta.push({ label: "Condition", value: d.box_condition });
  meta.push({ label: "Status", value: d.status });

  // Summary mode: the server already grouped by article+lot. Preferred — the
  // browser-side grouping below only exists for callers holding a full detail.
  if (d.lines?.length) {
    return {
      lines: d.lines.map((l) => ({
        name: l.article || "(unmatched)",
        qty: l.box_count,
        weightKg: +num(l.net_weight).toFixed(2),
        lot: l.lot_number || null,
      })),
      meta,
    };
  }

  const map = new Map<string, HoverLine & { _w: number }>();
  for (const b of d.boxes) {
    const lot = b.lot_number || "";
    const key = `${b.article || ""}||${lot}`;
    const cur = map.get(key);
    if (cur) {
      cur.qty = (cur.qty as number) + 1;
      cur._w += num(b.net_weight);
      cur.weightKg = +cur._w.toFixed(2);
    } else {
      map.set(key, { name: b.article || "(unmatched)", qty: 1, _w: num(b.net_weight), weightKg: +num(b.net_weight).toFixed(2), lot: lot || null });
    }
  }
  const lines = [...map.values()].map(({ _w, ...rest }) => { void _w; return rest; });
  return { lines, meta };
}
