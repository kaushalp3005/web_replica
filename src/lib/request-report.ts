// Stores → Production Indents request report — the pure half: how long each step
// of a material request took, how the issued quantity compares with the request,
// and where the hover card goes next to its table row.
//
// No imports, so it runs under plain Node for its test:
//     node src/lib/request-report.test.ts

/** "3 d 4 h", "2 h 15 m", "12 m", "under a minute" from `fromIso` to `toMs`.
 *  null when either end is missing or unreadable, or the span is negative
 *  (a clock skew must not print "-5 m"). */
export function formatSpan(fromIso: string | null | undefined, toMs: number | null | undefined): string | null {
  if (!fromIso || toMs == null || !Number.isFinite(toMs)) return null;
  const from = Date.parse(fromIso);
  if (Number.isNaN(from)) return null;
  const ms = toMs - from;
  if (ms < 0) return null;
  const min = Math.floor(ms / 60000);
  if (min < 1) return "under a minute";
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d > 0) return h > 0 ? `${d} d ${h} h` : `${d} d`;
  if (h > 0) return m > 0 ? `${h} h ${m} m` : `${h} h`;
  return `${m} m`;
}

/** formatSpan between two timestamps; null unless both are readable. */
export function spanBetween(fromIso: string | null | undefined, toIso: string | null | undefined): string | null {
  if (!toIso) return null;
  const to = Date.parse(toIso);
  return Number.isNaN(to) ? null : formatSpan(fromIso, to);
}

export type IssuedDelta =
  | { kind: "same" }
  | { kind: "less" | "more"; amount: number };

/** Issued against requested, to the gram (3 decimals) so float noise such as
 *  0.1 + 0.2 never reads "0.000 kg more". null until something was issued. */
export function issuedDelta(issued: number | null | undefined, requested: number): IssuedDelta | null {
  if (issued == null || !Number.isFinite(issued)) return null;
  const diff = Math.round((issued - requested) * 1000) / 1000;
  if (diff === 0) return { kind: "same" };
  return diff < 0 ? { kind: "less", amount: -diff } : { kind: "more", amount: diff };
}

export interface Placement {
  left: number;
  top: number;
}

/** Where the report card goes for a row spanning anchorTop..anchorBottom (viewport
 *  px), opened with the pointer at pointerX. Below the row when it fits, else
 *  above it. When neither fits (a short window), beside the pointer — right of
 *  it if there is room, else left — centred on the row, so the card covers the
 *  row's far side but never the spot being pointed at. Always at least `margin`
 *  from every edge, as far as the card's own size allows. */
export function placeReport(a: {
  anchorTop: number;
  anchorBottom: number;
  pointerX: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  gap?: number;
  margin?: number;
}): Placement {
  const gap = a.gap ?? 6;
  const margin = a.margin ?? 8;
  const clampLeft = (x: number) => Math.max(margin, Math.min(x, a.viewportWidth - a.width - margin));
  const clampTop = (y: number) => Math.max(margin, Math.min(y, a.viewportHeight - a.height - margin));
  // Below or above: start a little left of the pointer so the card reads as belonging to it.
  if (a.anchorBottom + gap + a.height <= a.viewportHeight - margin) {
    return { left: clampLeft(a.pointerX - 48), top: a.anchorBottom + gap };
  }
  if (a.anchorTop - gap - a.height >= margin) {
    return { left: clampLeft(a.pointerX - 48), top: a.anchorTop - gap - a.height };
  }
  const side = 16;
  const top = clampTop((a.anchorTop + a.anchorBottom) / 2 - a.height / 2);
  if (a.pointerX + side + a.width <= a.viewportWidth - margin) return { left: a.pointerX + side, top };
  return { left: Math.max(margin, a.pointerX - side - a.width), top };
}
