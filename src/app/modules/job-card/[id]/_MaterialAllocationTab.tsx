"use client";

// Material allocation and requisition — sits between "Stage Chain" and "Raw
// Material" on the job card detail page.
//
// Shows what is available on the job card's own floor, from the Stock Take
// module (GET /api/v1/stock-take/floor-stock over new_stock_entries): each
// article's latest count on that floor plus the adjustments posted there since —
// the same figure the Stock Take screen shows. The job card's BOM articles come
// first, each against the job card's production requirement (its RM / PM indent
// lines) — "short by" or "covered" — and every other item on the floor follows
// in a collapsed section with its own search, type / stock-type filters and
// pages of OTHER_PAGE_SIZE rows.
// The Request column raises a floor requisition for an article
// (lib/floor-requisitions): store issues it from Production → Floor Requisitions
// and the floor marks it received. Nothing here moves stock.
// Requests this job card has raised are listed under the BOM articles
// (_JobCardRequisitions), where the floor marks issued ones received.
//
// The BOM articles list is the job card's own BOM: the BOM module's lines minus
// articles removed from this job card, plus articles added to it
// (job_card_bom_change, spec 2026-09-21). ✕ removes an RM/PM article (or undoes
// an added one of any type); + Add article adds one; "Changes on this job card"
// lists removals with Restore. The list and its controls do not depend on floor
// stock; only the stock cells do. An added FG / SFG article is RM for accounting
// (its line's item_type) but shows its real type (article_type) here. "Use" on
// an RM / PM / FG / SFG row of other stock opens the Add dialog with that item
// picked (spec Addendum A).
//
// Layout: bordered tables (the Stock Take screen's cell borders) from the md
// breakpoint up; below it the same rows become stacked bordered cards, so a phone
// never has to scroll a six-column table sideways.
//
// Matching a BOM article to a counted item, and the requirement arithmetic, are
// in lib/floorStock.ts. Reading it needs the Stock Take view permission, the same
// as the Stock Take screen; without it the tab says so instead of showing numbers.

import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { friendlyApiError } from "@/lib/apiErrors";
import {
  articleKey, buildFloorStockView, coverage, filterFloorStock, floorStockFilterOptions,
  paginate, requirementsByArticle,
  type BomArticleLike, type Coverage, type IndentLike, type Requirement,
} from "@/lib/floorStock";
import {
  fetchFloorStock, formatNumber, type FloorStockItem, type FloorStockResponse,
} from "@/lib/stock-take";
import { useHasPermission, useMe } from "@/lib/user";
import { normaliseWarehouseCode } from "@/lib/warehouseScope";
import { BTN, StatusTag } from "@/components/floor-requisitions/RequisitionUi";
import {
  formatQty, requestStateByArticle, requisitionUnit, type ArticleRequests,
} from "@/lib/floor-requisition-form";
import { listFloorRequisitions, type FloorRequisition } from "@/lib/floor-requisitions";
import type { BomChangeResult } from "@/lib/job-card-bom";
import {
  hasBomChanges, isRemovableType, isUsableType, requirementIndents, type BomChanges,
} from "@/lib/job-card-bom-rules";
import { RequestDialog } from "./_RequestDialog";
import { JobCardRequisitions } from "./_JobCardRequisitions";
import { AddBomArticleDialog } from "./_AddBomArticleDialog";
import { BomChangesList } from "./_BomChangesList";
import { RemoveBomArticleDialog } from "./_RemoveBomArticleDialog";

const CARD =
  "bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-3 sm:p-4 mb-4";
const HEADING = "text-[12px] uppercase tracking-wide font-semibold text-[var(--text-secondary)]";
const TABLE = "w-full text-[12px] border-collapse";
const TH =
  "border border-[var(--aws-border)] bg-[#fafafa] px-2.5 py-2 text-left text-[10px] font-bold uppercase " +
  "tracking-wide text-[var(--text-secondary)] whitespace-nowrap";
const TD = "border border-[var(--aws-border)] px-2.5 py-2 align-top";
const HINT = "text-[12px] text-[var(--text-muted)] italic";
const PAGE_BTN =
  "h-7 px-2.5 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[12px] " +
  "hover:border-[var(--aws-navy)] disabled:opacity-50 disabled:cursor-not-allowed";

// Rows per page of "Other stock on this floor".
const OTHER_PAGE_SIZE = 100;

/** A quantity in its unit: kg to 3 dp, pieces as whole numbers. */
function qty(n: number, unit: string): string {
  if (unit === "pcs") return `${formatNumber(n, 0)} pcs`;
  return `${formatNumber(n, 3)} ${unit || "kg"}`;
}

function Available({ s, pieces }: { s: FloorStockItem; pieces: boolean }) {
  const negative = s.available_kg < 0;
  return (
    <span className={`font-mono tabular-nums ${negative ? "text-[var(--text-danger)] font-semibold" : "text-[var(--text-primary)]"}`}>
      {formatNumber(s.available_kg, 3)} kg
      {pieces && s.available_quantity !== 0 ? (
        <span className="text-[var(--text-secondary)]"> · {formatNumber(s.available_quantity, 0)} pcs</span>
      ) : null}
    </span>
  );
}

function StockTypeTag({ type }: { type: string }) {
  const fresh = type === "Fresh Stock";
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap ${
      fresh ? "bg-[#eaf6ed] text-[var(--text-success)]" : "bg-[#fdf3f1] text-[#b1361e]"
    }`}>{type}</span>
  );
}

function Required({ req }: { req: Requirement | undefined }) {
  if (!req) {
    return <span className="text-[var(--text-muted)]" title="This job card has no indent line for this article">—</span>;
  }
  return <span className="font-mono tabular-nums whitespace-nowrap text-[var(--text-primary)]">{qty(req.qty, req.unit)}</span>;
}

/** Available Fresh Stock against the requirement: short by / covered. */
function CoverageNote({ c }: { c: Coverage | null }) {
  if (!c) return <span className="text-[var(--text-muted)]">—</span>;
  const short = c.balance < 0;
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span className={`font-semibold whitespace-normal lg:whitespace-nowrap ${short ? "text-[var(--text-danger)]" : "text-[var(--text-success)]"}`}>
        {short ? `Short by ${qty(-c.balance, c.unit)}`
          : c.balance === 0 ? "Exactly covered"
          : `Covered · ${qty(c.balance, c.unit)} spare`}
      </span>
      <span className="text-[11px] text-[var(--text-muted)]">
        Fresh stock {qty(c.available, c.unit)} of {qty(c.required, c.unit)}
      </span>
    </span>
  );
}

/** One article as a bordered card — the below-md form of a table row group. */
function ArticleCard({
  title, itemType, stock, stockKnown = true, pieces, requirement, action,
}: {
  title: ReactNode;
  itemType: string;
  stock: FloorStockItem[];
  /** False while there is no floor stock to show (no place, no access, not loaded). */
  stockKnown?: boolean;
  pieces: boolean;
  /** Only BOM articles carry a requirement; `undefined` leaves those lines out. */
  requirement?: { req: Requirement | undefined; cover: Coverage | null };
  /** The Request / ✕ controls for BOM articles, or Use for other stock, when the viewer may use them. */
  action?: ReactNode;
}) {
  return (
    <li className="border border-[var(--aws-border)] rounded-[2px] bg-white p-2.5">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 break-words text-[13px] font-medium text-[var(--text-primary)]">{title}</span>
        <span className="shrink-0 rounded border border-[var(--aws-border)] px-1.5 text-[11px] text-[var(--text-secondary)]">
          {itemType}
        </span>
      </div>
      {requirement ? (
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
          <dt className="text-[var(--text-muted)]">Required</dt>
          <dd><Required req={requirement.req} /></dd>
          <dt className="text-[var(--text-muted)]">Against it</dt>
          <dd><CoverageNote c={requirement.cover} /></dd>
        </dl>
      ) : null}
      {stock.length === 0 ? (
        <p className={`mt-1.5 ${HINT}`}>{stockKnown ? "None on this floor" : "Floor stock: —"}</p>
      ) : (
        <dl className="mt-1.5 space-y-1.5">
          {stock.map((s) => (
            <div
              key={s.stock_type}
              className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-[var(--aws-border)] pt-1.5 text-[12px]"
            >
              <dt className="text-[var(--text-muted)]">Stock type</dt>
              <dd><StockTypeTag type={s.stock_type} /></dd>
              <dt className="text-[var(--text-muted)]">Available</dt>
              <dd className="break-words"><Available s={s} pieces={pieces} /></dd>
            </div>
          ))}
        </dl>
      )}
      {action ? <div className="mt-2 border-t border-[var(--aws-border)] pt-2">{action}</div> : null}
    </li>
  );
}

/** The Request column: the article's open request, or a Request button with the
 *  newest earlier request's status above it. */
function RequestCell({
  state, disabled, onRequest,
}: {
  state: ArticleRequests<FloorRequisition> | undefined;
  disabled: boolean;
  onRequest: () => void;
}) {
  const open = state?.open ?? null;
  if (open) {
    return (
      <span className="inline-flex flex-col gap-1">
        <span className="font-mono text-[12px] text-[var(--text-primary)]">#{open.requisition_id}</span>
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <StatusTag status="raised" />
          <span className="font-mono tabular-nums whitespace-nowrap">{formatQty(open.requested_qty, open.requested_unit)}</span>
        </span>
      </span>
    );
  }
  const latest = state?.latest ?? null;
  return (
    <span className="inline-flex flex-col items-start gap-1">
      {latest ? (
        <span className="inline-flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
          <span className="font-mono">#{latest.requisition_id}</span>
          <StatusTag status={latest.status} />
          <span className="font-mono tabular-nums whitespace-nowrap">
            {formatQty(latest.issued_qty ?? latest.requested_qty, latest.requested_unit)}
          </span>
        </span>
      ) : null}
      <button type="button" className={BTN} disabled={disabled} onClick={onRequest}>Request</button>
    </span>
  );
}

/** Marks an article added to this job card (job_card_bom_change), not on the BOM module's list. */
function AddedTag() {
  return (
    <span className="ml-1.5 inline-block rounded bg-[#e8f1fb] px-1.5 py-0.5 text-[10px] font-semibold text-[#0b5cad] align-middle"
      title="Added to this job card; not on the BOM module's list">Added</span>
  );
}

const isPm = (t: string | null | undefined) => (t ?? "").trim().toUpperCase() === "PM";

export function MaterialAllocationTab({
  jobCardId,
  warehouse,
  floor,
  bomLines,
  indents,
  bomChanges,
  onReload,
}: {
  /** The job card's 8-digit id — what its floor requisitions are raised against. */
  jobCardId: number;
  /** The job card's plant as the job card spells it ("W-202"). */
  warehouse: string | null;
  floor: string | null;
  /** The job card's effective BOM: the BOM module's lines with this job card's changes applied. */
  bomLines: BomArticleLike[];
  /** The production requirement: the job card's RM / PM indent lines, typed RM / PM. */
  indents: IndentLike[];
  /** This job card's BOM changes (removed / added articles); null before migration 115. */
  bomChanges?: BomChanges | null;
  /** Re-fetches the job card after a BOM change, so every tab sees the new list. */
  onReload: () => void;
}) {
  // useHasPermission is false until the profile has loaded, so "no access" is
  // only said once `me` is known — otherwise every user sees it flash first.
  const me = useMe();
  const canView = useHasPermission("stock_take");
  const wh = normaliseWarehouseCode(warehouse);
  const fl = (floor ?? "").trim();

  const [data, setData] = useState<FloorStockResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0); // bumped by Retry
  // Everything that is NOT on the BOM starts collapsed: the BOM articles are what
  // the job card is about, and a floor can hold a hundred other lines.
  const [otherOpen, setOtherOpen] = useState(false);
  const otherId = useId();
  // Search and filters for that list. Kept while it is collapsed, so hiding and
  // re-opening it does not lose what the operator narrowed it to.
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [stockTypeFilter, setStockTypeFilter] = useState("");
  const [otherPage, setOtherPage] = useState(1);
  // Floor requisitions this job card has raised. The Request column shows each
  // article's open one; the requisitions section lists them all.
  const canViewReqs = useHasPermission("production", "floor_requisitions", null, "view");
  const canRaise = useHasPermission("production", "floor_requisitions", null, "create");
  const [reqs, setReqs] = useState<FloorRequisition[] | null>(null);
  const [reqsErr, setReqsErr] = useState<string | null>(null);
  const [reqsAttempt, setReqsAttempt] = useState(0); // bumped after every change
  const [requestingKey, setRequestingKey] = useState<string | null>(null);
  // Per-job-card BOM changes: ✕ on an RM / PM row (or an added one), + Add
  // article below the table, Use on other stock.
  const canEditBom = useHasPermission("production", "job_cards", "overview", "start");
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Use on other stock: the Add dialog with this item already picked.
  const [using, setUsing] = useState<{ name: string; itemType: string } | null>(null);

  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    setErr(null);
    try {
      const d = await fetchFloorStock({ warehouse: wh, floor: fl }, signal);
      if (!signal.aborted) setData(d);
    } catch (e) {
      if (!signal.aborted) setErr(friendlyApiError(e));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [wh, fl]);

  useEffect(() => {
    if (!canView || !wh || !fl) return;
    const ctrl = new AbortController();
    // Deferred past the synchronous effect body (react-hooks/set-state-in-effect),
    // the same queueMicrotask idiom the page's other loaders use.
    queueMicrotask(() => { void load(ctrl.signal); });
    return () => ctrl.abort();
  }, [canView, wh, fl, load, attempt]);

  useEffect(() => {
    // A job card with no plant/floor has nowhere to raise a requisition
    // against, so there is nothing to fetch here either.
    if (!canViewReqs || !wh || !fl) return;
    const ctrl = new AbortController();
    queueMicrotask(() => {
      listFloorRequisitions({ jobCardId, pageSize: 500 }, ctrl.signal)
        .then((p) => { if (!ctrl.signal.aborted) { setReqs(p.items); setReqsErr(null); } })
        .catch((e: unknown) => { if (!ctrl.signal.aborted) setReqsErr(friendlyApiError(e)); });
    });
    return () => ctrl.abort();
  }, [canViewReqs, wh, fl, jobCardId, reqsAttempt]);
  const reloadReqs = useCallback(() => setReqsAttempt((n) => n + 1), []);
  const closeRequest = useCallback(() => setRequestingKey(null), []);
  const reqState = useMemo(() => requestStateByArticle(reqs ?? []), [reqs]);
  // After any BOM change the page re-fetches the job card, so every tab sees the
  // new list; this job card's requests are re-read too (the server leaves open
  // ones open).
  const onBomChanged = useCallback<(r: BomChangeResult) => void>(() => {
    setRemovingKey(null);
    setAdding(false);
    setUsing(null);
    onReload();
    reloadReqs();
  }, [onReload, reloadReqs]);

  // The BOM lines are the article list; a job card without them falls back to its
  // indent lines — the same fallback the Accounting tab's article catalogue uses.
  // With BOM changes the server has already built the list (and done that
  // fallback itself), so an empty list then means every article was removed.
  // An added FG / SFG line is typed 'rm' (its accounting kind); the Type column
  // shows its real type.
  const articles = useMemo<BomArticleLike[]>(
    () => (bomLines.length || hasBomChanges(bomChanges)
      ? bomLines.map((l) => ({ ...l, item_type: l.article_type ?? l.item_type }))
      : indents.map((i) => ({ material_sku_name: i.material_sku_name ?? "", item_type: i.item_type }))),
    [bomLines, indents, bomChanges],
  );
  // An added article's required qty replaces its indent figure (never summed).
  const requirements = useMemo(
    () => requirementsByArticle(requirementIndents(indents, bomChanges)),
    [indents, bomChanges],
  );
  // Articles added to this job card that still show (not superseded by the BOM).
  const addedKeys = useMemo(
    () => new Set((bomChanges?.added ?? []).filter((a) => !a.superseded).map((a) => articleKey(a.material_sku_name))),
    [bomChanges],
  );
  const view = useMemo(
    () => buildFloorStockView(data?.items ?? [], articles),
    [data, articles],
  );
  const bomRows = useMemo(
    () => view.bom.map((r) => {
      const req = requirements.get(r.key);
      // No verdict without floor stock: "short by" the whole requirement would be wrong.
      return { ...r, req, cover: data ? coverage(r.stock, req) : null, pieces: isPm(r.itemType) || req?.unit === "pcs" };
    }),
    [view, requirements, data],
  );
  const otherOptions = useMemo(() => floorStockFilterOptions(view.other), [view]);
  const otherShown = useMemo(
    () => filterFloorStock(view.other, { search, type: typeFilter, stockType: stockTypeFilter }),
    [view, search, typeFilter, stockTypeFilter],
  );
  // Paged AFTER filtering, so the pages are pages of what the search found.
  const otherPageView = useMemo(
    () => paginate(otherShown, otherPage, OTHER_PAGE_SIZE),
    [otherShown, otherPage],
  );
  const filtering = search.trim() !== "" || typeFilter !== "" || stockTypeFilter !== "";

  // A job card with no plant / floor still shows its BOM articles and their
  // controls; only floor stock and requests need a place.
  const hasPlace = !!wh && !!fl;
  if (!canView && !me) {
    return (
      <div className={CARD}><p className={HINT}>Loading floor stock…</p></div>
    );
  }
  // No early return for !canView here: the requisitions section (below)
  // must still render for a viewer without Stock Take access — receiving is
  // often a different role than counting stock. The explanation is shown in
  // the BOM articles card instead, above the list.

  const onFloorCount = bomRows.filter((r) => r.stock.length > 0).length;
  const shortCount = bomRows.filter((r) => r.cover && r.cover.balance < 0).length;
  // Wait for this job card's requisitions before offering Request, so an open one
  // shows instead of a second button. If that load failed, Request stays usable:
  // the server's one-open-request rule still stops a duplicate.
  const requestDisabled = canViewReqs && reqs === null && reqsErr === null;
  const requestingRow = requestingKey ? bomRows.find((r) => r.key === requestingKey) ?? null : null;
  const requestCell = (key: string) => (
    <RequestCell state={reqState.get(key)} disabled={requestDisabled} onRequest={() => setRequestingKey(key)} />
  );
  // The Actions column: Request (needs a place) and the ✕ (RM / PM rows, and
  // any added article — removing one undoes the add).
  const showActions = (canRaise && hasPlace) || canEditBom;
  const removable = (r: (typeof bomRows)[number]) =>
    canEditBom && (isRemovableType(r.itemType) || addedKeys.has(r.key));
  const hasActions = (r: (typeof bomRows)[number]) => (canRaise && hasPlace) || removable(r);
  const actionsCell = (r: (typeof bomRows)[number]) => (
    <span className="inline-flex flex-wrap items-start gap-2">
      {canRaise && hasPlace ? requestCell(r.key) : null}
      {removable(r) ? (
        <button
          type="button"
          className="h-8 w-8 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[14px] leading-none text-[var(--text-secondary)] hover:border-[var(--aws-error)] hover:text-[var(--aws-error)]"
          aria-label={`Remove ${r.article} from this job card`}
          title="Remove from this job card's BOM"
          onClick={() => setRemovingKey(r.key)}
        >
          ✕
        </button>
      ) : null}
    </span>
  );
  // Use on other stock (RM / PM / FG / SFG rows): opens the Add dialog with the item picked.
  const stockUseButton = (s: FloorStockItem) => (
    <button
      type="button"
      className={BTN}
      aria-label={`Use ${s.item_name} on this job card`}
      onClick={() => setUsing({ name: s.item_name, itemType: s.item_type ?? "" })}
    >
      Use
    </button>
  );
  const closeAdd = () => { setAdding(false); setUsing(null); };
  const pager = otherPageView.pageCount > 1 ? (
    <nav aria-label="Other stock pages" className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
      <span className="text-[var(--text-secondary)]">
        {otherPageView.from}–{otherPageView.to} of {otherPageView.total}
      </span>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className={PAGE_BTN}
          disabled={otherPageView.page <= 1}
          onClick={() => setOtherPage(otherPageView.page - 1)}
        >
          ‹ Prev
        </button>
        <span className="px-1 whitespace-nowrap text-[var(--text-secondary)]">
          Page {otherPageView.page} of {otherPageView.pageCount}
        </span>
        <button
          type="button"
          className={PAGE_BTN}
          disabled={otherPageView.page >= otherPageView.pageCount}
          onClick={() => setOtherPage(otherPageView.page + 1)}
        >
          Next ›
        </button>
      </div>
    </nav>
  ) : null;

  return (
    <div>
      {hasPlace ? (
        <div className={CARD}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 mb-1">
            <h3 className="text-[13px] font-semibold text-[var(--text-primary)] break-words">
              Stock on {wh} · {fl}
            </h3>
            {data ? (
              <span className="text-[12px] text-[var(--text-secondary)]">
                {data.items.length} item{data.items.length !== 1 ? "s" : ""} on this floor
                {bomRows.length ? ` · ${onFloorCount} of ${bomRows.length} BOM articles here` : ""}
                {shortCount ? (
                  <span className="font-semibold text-[var(--text-danger)]"> · {shortCount} short of requirement</span>
                ) : null}
              </span>
            ) : null}
          </div>
          <p className="text-[12px] text-[var(--text-secondary)]">
            Available = the latest stock-take count on this floor plus adjustments posted here since.
            Required = this job card&apos;s indent quantity including loss, compared against Fresh Stock only.
            Counts made in the Stock Take app appear once they sync.
          </p>
        </div>
      ) : null}

      {/* The BOM articles card always renders: the list, the ✕, + Add article and
          the changes list come from bomLines / bomChanges; only the stock cells
          wait for floor stock, and say "—" (with the reason above) without it. */}
      <div className={CARD}>
        <h4 className={`${HEADING} mb-2`}>BOM articles ({bomRows.length})</h4>
        {!hasPlace ? (
          <p className={`${HINT} mb-2`}>This job card has no plant or floor, so floor stock and requests are not available here.</p>
        ) : !canView && me ? (
          <p className={`${HINT} mb-2`}>Floor stock comes from the Stock Take module, which you don&apos;t have access to. Ask an admin for the Stock Take view permission.</p>
        ) : err ? (
          <p className="mb-2 text-[12px] text-[var(--aws-error)]">
            {err}{" "}
            <button type="button" onClick={() => setAttempt((n) => n + 1)} className="underline">Retry</button>
          </p>
        ) : loading && !data ? (
          <p className={`${HINT} mb-2`}>Loading floor stock…</p>
        ) : null}
        {bomRows.length === 0 ? (
          <p className={HINT}>No BOM articles on this job card.</p>
        ) : (
          <>
            {/* From md up the table, below it the ArticleCard stack. The table
                wants ~880px, so a 768px tablet still scrolls it sideways: the
                Article column is pinned (sticky left-0) so the name a row
                belongs to stays in view. Its backgrounds are the ones those
                cells already show, so nothing looks different at any width. */}
            <div className="hidden md:block overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr>
                    <th className={`${TH} sticky left-0 z-10`}>Article</th>
                    <th className={TH}>Type</th>
                    <th className={`${TH} text-right`}>Required</th>
                    <th className={TH}>Stock type</th>
                    <th className={`${TH} text-right`}>Available</th>
                    <th className={TH}>Against requirement</th>
                    {showActions ? <th className={TH}>Actions</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {bomRows.map((r) => {
                    // Name, type, requirement and the verdict belong to the ARTICLE, so they
                    // span all its stock-type rows; stock type and available are per row.
                    const span = Math.max(1, r.stock.length);
                    const lead = (
                      <>
                        <td rowSpan={span} className={`${TD} sticky left-0 z-10 bg-white text-[var(--text-primary)]`}>
                          {r.article}{addedKeys.has(r.key) ? <AddedTag /> : null}
                        </td>
                        <td rowSpan={span} className={`${TD} whitespace-nowrap`}>{r.itemType}</td>
                        <td rowSpan={span} className={`${TD} text-right`}><Required req={r.req} /></td>
                      </>
                    );
                    const verdict = <td rowSpan={span} className={TD}><CoverageNote c={r.cover} /></td>;
                    const actions = showActions ? <td rowSpan={span} className={TD}>{actionsCell(r)}</td> : null;
                    if (r.stock.length === 0) {
                      // Without floor stock (no place, no access, not loaded) the
                      // stock cells are one "—"; with it, the article is not here.
                      return (
                        <tr key={r.key}>
                          {lead}
                          <td className={`${TD} text-[var(--text-muted)]${data ? " italic" : ""}`} colSpan={2}>
                            {data ? "None on this floor" : "—"}
                          </td>
                          {verdict}
                          {actions}
                        </tr>
                      );
                    }
                    return r.stock.map((s, i) => (
                      <tr key={`${r.key}|${s.stock_type}`}>
                        {i === 0 ? lead : null}
                        <td className={TD}><StockTypeTag type={s.stock_type} /></td>
                        <td className={`${TD} text-right whitespace-nowrap`}><Available s={s} pieces={r.pieces} /></td>
                        {i === 0 ? verdict : null}
                        {i === 0 ? actions : null}
                      </tr>
                    ));
                  })}
                </tbody>
              </table>
            </div>
            <ul className="md:hidden space-y-2">
              {bomRows.map((r) => (
                <ArticleCard
                  key={r.key}
                  title={<>{r.article}{addedKeys.has(r.key) ? <AddedTag /> : null}</>}
                  itemType={r.itemType}
                  stock={r.stock}
                  stockKnown={!!data}
                  pieces={r.pieces}
                  requirement={{ req: r.req, cover: r.cover }}
                  action={hasActions(r) ? actionsCell(r) : undefined}
                />
              ))}
            </ul>
          </>
        )}
        {canEditBom ? (
          <div className="mt-3">
            <button type="button" className={BTN} onClick={() => setAdding(true)}>+ Add article</button>
          </div>
        ) : null}
        <BomChangesList jobCardId={jobCardId} changes={bomChanges} canEdit={canEditBom} onChanged={onBomChanged} />
      </div>

      {canViewReqs && hasPlace ? (
        <JobCardRequisitions rows={reqs} error={reqsErr} onRetry={reloadReqs} onChanged={reloadReqs} />
      ) : null}

      {canView && data ? (
        <div className={CARD}>
          <button
            type="button"
            onClick={() => setOtherOpen((v) => !v)}
            aria-expanded={otherOpen}
            aria-controls={otherId}
            className="w-full flex items-center justify-between gap-2 text-left"
          >
            <span className={`inline-flex items-center gap-1.5 ${HEADING}`}>
              <span aria-hidden className={`inline-block text-[10px] transition-transform ${otherOpen ? "rotate-90" : ""}`}>▸</span>
              Other stock on this floor ({filtering ? `${otherShown.length} of ${view.other.length}` : view.other.length})
            </span>
            <span className="shrink-0 text-[12px] text-[var(--aws-link)]">{otherOpen ? "Hide" : "Show"}</span>
          </button>
          {otherOpen ? (
            <div id={otherId} className="mt-3">
              {view.other.length === 0 ? (
                <p className={HINT}>Nothing else is recorded on this floor.</p>
              ) : (
                <>
                  {/* Search + filters: stacked full-width on a phone, one wrapping row from sm up. */}
                  <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                    <input
                      type="search"
                      value={search}
                      onChange={(e) => { setSearch(e.target.value); setOtherPage(1); }}
                      placeholder="Search item or group"
                      aria-label="Search other stock"
                      className="h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[var(--aws-navy)] text-[var(--text-primary)] w-full sm:w-auto sm:flex-1 sm:min-w-[220px]"
                    />
                    <div className="flex gap-2">
                      <select
                        value={typeFilter}
                        onChange={(e) => { setTypeFilter(e.target.value); setOtherPage(1); }}
                        aria-label="Filter by type"
                        className="h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[var(--aws-navy)] text-[var(--text-primary)] flex-1 sm:flex-none"
                      >
                        <option value="">Type: all</option>
                        {otherOptions.types.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <select
                        value={stockTypeFilter}
                        onChange={(e) => { setStockTypeFilter(e.target.value); setOtherPage(1); }}
                        aria-label="Filter by stock type"
                        className="h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[var(--aws-navy)] text-[var(--text-primary)] flex-1 sm:flex-none"
                      >
                        <option value="">Stock type: all</option>
                        {otherOptions.stockTypes.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                    {filtering ? (
                      <div className="flex items-center gap-3 text-[12px] text-[var(--text-secondary)]">
                        <span>Showing {otherShown.length} of {view.other.length}</span>
                        <button
                          type="button"
                          onClick={() => { setSearch(""); setTypeFilter(""); setStockTypeFilter(""); setOtherPage(1); }}
                          className="text-[var(--aws-link)] underline"
                        >
                          Clear
                        </button>
                      </div>
                    ) : null}
                  </div>
                  {otherShown.length === 0 ? (
                    <p className={HINT}>No items match this search or these filters.</p>
                  ) : (
                    <>
                      {pager ? <div className="mb-2">{pager}</div> : null}
                      <div className="hidden md:block overflow-x-auto">
                        <table className={TABLE}>
                          <thead>
                            <tr>
                              <th className={TH}>Item</th>
                              <th className={TH}>Type</th>
                              <th className={TH}>Stock type</th>
                              <th className={`${TH} text-right`}>Available</th>
                              {canEditBom ? <th className={TH}>Actions</th> : null}
                            </tr>
                          </thead>
                          <tbody>
                            {otherPageView.rows.map((s) => (
                              <tr key={`${articleKey(s.item_name)}|${s.stock_type}`}>
                                <td className={`${TD} text-[var(--text-primary)]`}>{s.item_name}</td>
                                <td className={`${TD} whitespace-nowrap`}>{(s.item_type ?? "").toUpperCase() || "—"}</td>
                                <td className={TD}><StockTypeTag type={s.stock_type} /></td>
                                <td className={`${TD} text-right whitespace-nowrap`}><Available s={s} pieces={isPm(s.item_type)} /></td>
                                {canEditBom ? (
                                  <td className={TD}>{isUsableType(s.item_type) ? stockUseButton(s) : null}</td>
                                ) : null}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <ul className="md:hidden space-y-2">
                        {otherPageView.rows.map((s) => (
                          <ArticleCard
                            key={`${articleKey(s.item_name)}|${s.stock_type}`}
                            title={s.item_name}
                            itemType={(s.item_type ?? "").toUpperCase() || "—"}
                            stock={[s]}
                            pieces={isPm(s.item_type)}
                            action={canEditBom && isUsableType(s.item_type) ? stockUseButton(s) : undefined}
                          />
                        ))}
                      </ul>
                      {pager ? <div className="mt-3">{pager}</div> : null}
                    </>
                  )}
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {requestingRow && hasPlace ? (
        <RequestDialog
          jobCardId={jobCardId}
          place={`${wh} · ${fl}`}
          article={requestingRow.article}
          itemType={requestingRow.itemType}
          unit={requisitionUnit(requestingRow.req?.unit, requestingRow.itemType)}
          cover={requestingRow.cover}
          onClose={closeRequest}
          onRaised={() => { setRequestingKey(null); reloadReqs(); }}
        />
      ) : null}
      {removingKey ? (() => {
        const row = bomRows.find((r) => r.key === removingKey);
        if (!row) return null;
        // This card's open request; the server's response lists every open
        // request on the chain, and the tab reloads after it.
        const open = reqState.get(removingKey)?.open;
        return (
          <RemoveBomArticleDialog
            jobCardId={jobCardId}
            article={row.article}
            added={addedKeys.has(row.key)}
            openRequisitionIds={open ? [open.requisition_id] : []}
            onClose={() => setRemovingKey(null)}
            onDone={onBomChanged}
          />
        );
      })() : null}
      {adding || using ? (
        <AddBomArticleDialog
          jobCardId={jobCardId}
          preset={using}
          floorItems={data?.items ?? null}
          place={hasPlace ? `${wh} · ${fl}` : "this floor"}
          bomChanges={bomChanges}
          onClose={closeAdd}
          onDone={onBomChanged}
        />
      ) : null}
    </div>
  );
}
