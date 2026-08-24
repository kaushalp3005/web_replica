// Box-scan rollups shared by the job-card Raw Material and Accounting tabs.
//
// Both tabs summarise the same GET /job-cards-v2/{id}/box-scans payload: Raw
// Material shows "RM issued (per article)" under the scanner, Accounting shows
// the scanned figure beside each BOM line. They were separate implementations of
// the same sum, which is how two views of one number drift apart, so the rollup
// lives here once.
//
// TWO THINGS ABOUT THE SCAN DATA THAT ARE EASY TO GET WRONG:
//
// 1. `article` is not one field with one meaning. box_scan_service._identify
//    resolves it per source: an SFG box gives fg_sku_name (or sfg_code), a PO
//    box gives po_line.sku_name, and a box the scanner can't resolve carries
//    whatever free text the operator typed. So an article string matching a BOM
//    material_sku_name is likely but never guaranteed — hence matchIssues()
//    returns the leftovers instead of dropping them.
//
// 2. `batch_id` on a scan is NOT the accounting batch. For an SFG box it is
//    sfg_box.batch_id, i.e. the batch that PRODUCED that box upstream; for a PO
//    box and for manual entries it is null outright. Scoping a rollup by the
//    Accounting tab's selected batch would therefore be wrong AND would blank
//    every PO-sourced raw material. These rollups are per job card.

/** The subset of a scan row these rollups need. */
export type ScanLike = {
  article: string | null;
  net_weight: number | null;
};

/** Scanned net weight and box count for one article, across the whole JC. */
export type ArticleIssue = {
  article: string;
  net_weight: number;
  boxes: number;
};

/** Scans with a blank/absent article group under this label. */
export const BLANK_ARTICLE = "—";

/**
 * Sum scanned net weights per article, heaviest first.
 *
 * Blank articles group under BLANK_ARTICLE rather than being discarded: a box
 * with weight but no name still represents material that physically arrived,
 * and hiding it would make the totals disagree with the scan list above it.
 */
export function rollupByArticle(scans: readonly ScanLike[]): ArticleIssue[] {
  const m = new Map<string, ArticleIssue>();
  for (const s of scans) {
    const key = (s.article ?? "").trim() || BLANK_ARTICLE;
    const cur = m.get(key) ?? { article: key, net_weight: 0, boxes: 0 };
    cur.net_weight += Number(s.net_weight) || 0;
    cur.boxes += 1;
    m.set(key, cur);
  }
  return [...m.values()].sort((a, b) => b.net_weight - a.net_weight);
}

export type IssueMatch = {
  /** article -> issue, for the names that ARE on the BOM. */
  matched: Map<string, ArticleIssue>;
  /**
   * Everything scanned that no BOM line claims. Surfaced in the UI rather than
   * dropped, so a mistyped article reads as "scanned but not on this BOM"
   * instead of the line silently showing a dash.
   */
  unmatched: ArticleIssue[];
};

/**
 * Split rollups into those that correspond to a BOM material and those that do
 * not. Matching is exact on the trimmed string — deliberately not fuzzy, since
 * collapsing e.g. "Raisin 1kg" and "Raisin 5kg" into one line is a harder
 * mistake to notice than an extra row saying a scan went unmatched.
 */
export function matchIssues(
  issues: readonly ArticleIssue[],
  bomMaterialNames: readonly string[],
): IssueMatch {
  const known = new Set(bomMaterialNames.map((n) => (n ?? "").trim()));
  const matched = new Map<string, ArticleIssue>();
  const unmatched: ArticleIssue[] = [];
  for (const i of issues) {
    if (i.article !== BLANK_ARTICLE && known.has(i.article)) matched.set(i.article, i);
    else unmatched.push(i);
  }
  return { matched, unmatched };
}
