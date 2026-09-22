// Pure helper for ArticlePicker (app/modules/sample/_form.tsx), kept out of the
// .tsx so Node can test it (article-picker.test.ts).

export type ArticlePick = {
  tab: "search" | "browse";
  /** The picked particulars name. */
  name: string;
  /** The one allowed item type, when the picker is restricted to one. */
  singleType: string | null;
  /** Search tab: the allowed type the picked result came back under (null = unscoped). */
  resultType: string | null;
  /** Browse-tab cascade state. Switching tabs does not reset it. */
  itemType: string;
  itemGroup: string;
  subGroup: string;
};

export type ArticleLookupFilters = {
  particulars: string;
  item_type?: string;
  item_group?: string;
  sub_group?: string;
};

/** The sku-lookup filters that resolve a picked name to one SKU.
 *
 *  Search tab: the result's own type pins it (else the single allowed type).
 *  The Browse tab's leftover filters are left out: they would override that
 *  type, match nothing, and let sku-lookup fall back to a name-only match of any
 *  type, e.g. an FG of the same name.
 *  Browse tab: the chosen type, category and sub category. */
export function pickLookupFilters(p: ArticlePick): ArticleLookupFilters {
  if (p.tab === "search") {
    const itemType = p.resultType || p.singleType || undefined;
    return itemType ? { particulars: p.name, item_type: itemType } : { particulars: p.name };
  }
  const out: ArticleLookupFilters = { particulars: p.name };
  const itemType = p.itemType || p.singleType;
  if (itemType) out.item_type = itemType;
  if (p.itemGroup) out.item_group = p.itemGroup;
  if (p.subGroup) out.sub_group = p.subGroup;
  return out;
}

/** Browse's Material type choices. Unrestricted: what sku-lookup offers.
 *  Restricted: every allowed type, sorted — sku-lookup leaves SFG out unless
 *  item_type 'sfg' is asked for, and narrows its list to the chosen type. */
export function browseTypeOptions(
  serverTypes: readonly string[] | undefined,
  allowed: readonly string[] | null,
): string[] {
  if (!allowed) return [...(serverTypes ?? [])];
  return [...new Set(allowed)].sort();
}

export type SearchResult = {
  name: string;
  /** The allowed type the name came back under; null for an unscoped search. */
  type: string | null;
  /** The name came back under several allowed types: show which one this is. */
  showType: boolean;
};

/** Search results from one sku-lookup per allowed type (`types[i]` answered
 *  `lists[i]`), or one unscoped lookup (`types` [undefined]). One entry per name,
 *  or per (name, type) when a name is several allowed types (a floor item that
 *  is both FG and SFG), those entries side by side, so each SKU can be picked. */
export function searchResults(
  types: readonly (string | undefined)[],
  lists: readonly (readonly string[])[],
  limit = 50,
): SearchResult[] {
  const byName = new Map<string, (string | null)[]>();
  lists.forEach((names, i) => {
    const type = types[i] || null;
    for (const n of names) {
      const seen = byName.get(n);
      if (!seen) byName.set(n, [type]);
      else if (!seen.includes(type)) seen.push(type);
    }
  });
  const out: SearchResult[] = [];
  for (const [name, ts] of byName) {
    for (const type of ts) out.push({ name, type, showType: ts.length > 1 });
  }
  return out.slice(0, limit);
}
