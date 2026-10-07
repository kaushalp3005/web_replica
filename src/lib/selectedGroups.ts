// Grouping for the "Selected for plan" table: selected articles are shown under
// their SO (one row per SO with its article count; expand to see the articles).
// Pure helpers so the rules can be tested without a browser (selectedGroups.test.ts).

export type SoGroup<T> = {
  key: string;
  soNumber: string | null;
  customer: string | null;
  rows: T[];
};

export type FactorySummary = { label: string; tone: "set" | "partial" | "none" };

/** Group rows by SO number, SOs in the order they were first selected and rows
 *  in selection order within each. Rows without an SO number share one group. */
export function groupBySo<T extends { so_number?: string | null; customer_name?: string | null }>(
  rows: T[],
): SoGroup<T>[] {
  const groups = new Map<string, SoGroup<T>>();
  for (const r of rows) {
    const so = (r.so_number ?? "").trim() || null;
    const key = `so:${so ?? ""}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, soNumber: so, customer: null, rows: [] };
      groups.set(key, g);
    }
    if (!g.customer && r.customer_name) g.customer = r.customer_name;
    g.rows.push(r);
  }
  return Array.from(groups.values());
}

/** The earliest yyyy-mm-dd among the given dates ("" when there are none). */
export function earliestDate(dates: (string | null | undefined)[]): string {
  let best = "";
  for (const d of dates) {
    const day = d ? String(d).slice(0, 10) : "";
    if (day && (!best || day < best)) best = day;
  }
  return best;
}

/** A qty typed into a table cell. Blank or junk clears it (the card falls back to
 *  the pending default); a value above `max` — what is still pending — is
 *  capped at it, so nobody can over-plan. No cap when `max` is 0 or absent. */
export function parseQtyInput(raw: string, max?: number | null): number | undefined {
  if (raw === "") return undefined;
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return undefined;
  return max != null && max > 0 && n > max ? max : n;
}

/** What a qty cell shows. While it is being edited: exactly what was typed (a
 *  cleared cell stays blank until it is left). Otherwise the operator's own
 *  figure, else the WHOLE pending qty — blank only when nothing is pending. */
export function cellText(draft: string | null, value: number | undefined, fallback: number | null): string {
  if (draft != null) return draft;
  if (value != null) return String(value);
  return fallback != null ? String(fallback) : "";
}

/** The factory an article goes to without asking: the only one the account has
 *  access to. With several (or none) there is no default — nobody guesses. */
export function onlyFactory<F extends string>(allowed: F[]): F | undefined {
  return allowed.length === 1 ? allowed[0] : undefined;
}

/** The SO row's dropdown value: the factory every article is on, else "". */
export function commonFactory(factories: (string | null | undefined)[]): string {
  if (factories.length === 0 || factories.some((f) => !f)) return "";
  return new Set(factories).size === 1 ? (factories[0] as string) : "";
}

/** What the SO row says about its articles' factories (each article needs one). */
export function factorySummary(factories: (string | null | undefined)[]): FactorySummary {
  const set = factories.filter((f): f is string => !!f);
  if (set.length === 0) return { label: "Not set", tone: "none" };
  if (set.length < factories.length) return { label: `${set.length}/${factories.length} set`, tone: "partial" };
  return new Set(set).size === 1 ? { label: set[0], tone: "set" } : { label: "Mixed", tone: "set" };
}
