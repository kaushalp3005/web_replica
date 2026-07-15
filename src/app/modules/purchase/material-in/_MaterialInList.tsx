"use client";

// Material In listing component.
// Adapted from po-creation/_listing.tsx — same UI chrome (toolbar, entity chips,
// advanced filter, date, export, sort, 7-window pagination, desktop table +
// mobile cards), but with a trimmed column set, an Articles column that lazily
// fetches per-row PO lines (mirroring send-intimation.js's articles cell), no
// delete action, and a Send button placeholder per row.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  type PoListItem,
  type PoLineOut,
  type PoListQuery,
  type ReceiptSummary,
  listPos,
  getPoLines,
  getReceiptSummary,
  fetchAllPosForExport,
  buildPoXlsx,
  downloadBlob,
  fmtNum,
  PO_EXPORT_COLUMNS,
} from "@/lib/po";
import {
  type ArrivalItem,
  type ArrivalSummaryItem,
  type QcArrivalState,
  type QcTxnStatus,
  listArrivals,
  arrivalsSummary,
} from "@/lib/qc";
import { SendIntimationModal } from "./_SendIntimationModal";

// ── QC status helpers ─────────────────────────────────────────────────────────

// ── Section grouping (Today / Pending / Completed) ─────────────────────────────
// The listing is split into three sections for the receiving desk:
//   • Today's PO   — po_date is today (local), whatever its QC status
//   • Pending PO   — not yet completed (pending arrival or arrived), not dated today
//   • Completed PO — QC completed, not dated today
// The partition is mutually exclusive with Today taking priority (a PO dated
// today shows under Today regardless of status). It is decided SERVER-SIDE via
// the `section` list param, and each section is fetched + paginated independently
// (page_size 20), so counts and pages are accurate over the whole dataset.

type GroupKey = "today" | "pending" | "completed";

const GROUP_META: { key: GroupKey; label: string; accent: string; bg: string }[] = [
  { key: "today",     label: "Today's PO",   accent: "var(--aws-orange)",   bg: "#fff5ec" },
  { key: "pending",   label: "Pending PO",   accent: "#9a5b00",             bg: "#fbf3e7" },
  { key: "completed", label: "Completed PO", accent: "var(--text-success)", bg: "#eef7f0" },
];

// Backend page size for each section.
const SECTION_PAGE_SIZE = 20;

// Per-section fetch state (one backend page at a time).
type SectionState = {
  items: PoListItem[];
  total: number;
  page: number;
  totalPages: number;
  loading: boolean;
  loaded: boolean; // has completed at least one fetch (success or error)
  error: string | null;
};

function loadingSection(): SectionState {
  return { items: [], total: 0, page: 1, totalPages: 1, loading: true, loaded: false, error: null };
}

// Local YYYY-MM-DD for "today" — built from local date parts so it doesn't drift
// a day vs a naive UTC toISOString() near midnight.
function todayYmd(): string {
  const d = new Date();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

// Map a single arrival qc_state to its display label.
const QC_STATE_LABEL: Record<QcArrivalState, string> = {
  arrived: "Arrived",
  in_qc: "In QC",
  accepted: "Accepted",
  rejected: "Rejected",
};

// "Least-done" ordering used to summarise a line that has multiple arrivals
// in differing states — we surface the least-progressed state plus a count.
const QC_STATE_RANK: Record<QcArrivalState, number> = {
  arrived: 0,
  in_qc: 1,
  rejected: 2,
  accepted: 3,
};

// ── Public interface ─────────────────────────────────────────────────────────

export interface MaterialInListProps {
  query: PoListQuery;
  onQueryChange: (patch: Partial<PoListQuery>) => void;
  search: string;
  onSearch: (v: string) => void;
  expanded: Set<string>;
  onToggleExpand: (txn: string) => void;
}

// Columns sortable in the backend whitelist that are shown in this view.
const SORTABLE_COLS = ["po_number", "vendor_supplier_name", "transaction_no"] as const;

export function MaterialInList(props: MaterialInListProps): React.JSX.Element {
  const { query, onQueryChange, search, onSearch, expanded, onToggleExpand } = props;
  const router = useRouter();

  // ── Per-section state (each section fetched + paginated independently) ──────
  const [sections, setSections] = useState<Record<GroupKey, SectionState>>(() => ({
    today: loadingSection(),
    pending: loadingSection(),
    completed: loadingSection(),
  }));
  const [refetchNonce, setRefetchNonce] = useState(0);
  // "today" boundary — computed once (local date), sent to the backend so the
  // today/pending/completed split matches the user's calendar day.
  const [today] = useState(() => todayYmd());

  // ── Send intimation modal ──────────────────────────────────────────────────
  const [sendTxn, setSendTxn] = useState<string | null>(null);

  // Per-txn lines cache — shared between the Articles column summary AND the
  // expanded detail panel. Map<txn, {lines?, loading, error?}>
  // Stored in state (not a plain ref) so the component re-renders when resolved.
  const [linesCache, setLinesCache] = useState<
    Map<string, { lines?: PoLineOut[]; loading: boolean; error?: string }>
  >(new Map());

  // ── QC status: per-transaction summary (badge + filter) ────────────────────
  // Map<txn, ArrivalSummaryItem>. A txn ABSENT from this map = "pending_arrival".
  const [qcSummary, setQcSummary] = useState<Map<string, ArrivalSummaryItem>>(new Map());

  // ── QC status: per-txn arrivals cache (expansion per-article status) ───────
  // Mirrors linesCache. Map<txn, {arrivals?, loading, error?}>
  const [arrivalsCache, setArrivalsCache] = useState<
    Map<string, { arrivals?: ArrivalItem[]; loading: boolean; error?: string }>
  >(new Map());

  // ── Receipt summary cache (received-vs-ordered per line, lazy on expand) ────
  const [receiptCache, setReceiptCache] = useState<
    Map<string, { summary?: ReceiptSummary; loading: boolean; error?: string }>
  >(new Map());

  // ── Collapsed sections (Today / Pending / Completed) ───────────────────────
  const [collapsedGroups, setCollapsedGroups] = useState<Set<GroupKey>>(new Set());
  function toggleGroup(k: GroupKey) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }

  // ── Fetch fingerprint (base filters + sort, excluding pagination) ──────────
  // Section pages are independent, so the shared page/page_size are NOT part of
  // the fingerprint that triggers a full three-section reload.
  const baseQueryFp = JSON.stringify(
    Object.entries(query)
      .filter(([k, v]) => k !== "page" && k !== "page_size" && v !== "" && v != null)
      .sort(([a], [b]) => a.localeCompare(b)),
  );

  // Latest query in a ref so loadSectionPage (stable) can read the current
  // filters without being recreated on every keystroke.
  const queryRef = useRef(query);
  queryRef.current = query;

  // Fetch one section's page (page_size 20). Section membership (today / pending
  // / completed) is decided server-side via the `section` + `today_date` params.
  const loadSectionPage = useCallback(
    async (key: GroupKey, page: number, signal?: AbortSignal) => {
      setSections((prev) => ({ ...prev, [key]: { ...prev[key], loading: true, error: null } }));
      // Carry the toolbar's filters + sort; drive pagination per section.
      const base: PoListQuery = { ...queryRef.current };
      delete base.page;
      delete base.page_size;
      try {
        const resp = await listPos(
          { ...base, section: key, today_date: today, page, page_size: SECTION_PAGE_SIZE },
          signal,
        );
        if (signal?.aborted) return;
        setSections((prev) => ({
          ...prev,
          [key]: {
            items: resp.items,
            total: resp.total,
            page: resp.page,
            totalPages: resp.total_pages,
            loading: false,
            loaded: true,
            error: null,
          },
        }));
      } catch (e) {
        if (signal?.aborted || (e instanceof Error && e.name === "AbortError")) return;
        setSections((prev) => ({
          ...prev,
          [key]: {
            ...prev[key],
            loading: false,
            loaded: true,
            error: e instanceof Error ? e.message : "Failed to load POs",
          },
        }));
      }
    },
    [today],
  );

  // Reload all three sections (page 1) whenever the base filters/sort change.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const controller = new AbortController();
    setSections({ today: loadingSection(), pending: loadingSection(), completed: loadingSection() });
    (["today", "pending", "completed"] as GroupKey[]).forEach((k) => {
      void loadSectionPage(k, 1, controller.signal);
    });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseQueryFp, refetchNonce, loadSectionPage]);

  // ── Lazy line fetch ────────────────────────────────────────────────────────
  const fetchLines = useCallback(async (txn: string) => {
    // Yield first so no setState fires synchronously inside a useEffect body
    // (avoids react-hooks/set-state-in-effect).
    await Promise.resolve();
    setLinesCache((prev) => {
      const next = new Map(prev);
      next.set(txn, { loading: true });
      return next;
    });
    try {
      const r = await getPoLines(txn);
      setLinesCache((prev) => {
        const next = new Map(prev);
        next.set(txn, { lines: r.lines, loading: false });
        return next;
      });
    } catch (e: unknown) {
      setLinesCache((prev) => {
        const next = new Map(prev);
        next.set(txn, {
          loading: false,
          error: e instanceof Error ? e.message : "Failed to load articles",
        });
        return next;
      });
    }
  }, []);

  // ── Lazy arrivals fetch (per-txn QC arrivals for the expansion) ───────────
  const fetchArrivals = useCallback(async (txn: string) => {
    // Same yield trick as fetchLines — defer so no setState fires synchronously
    // inside a useEffect body (avoids react-hooks/set-state-in-effect).
    await Promise.resolve();
    setArrivalsCache((prev) => {
      const next = new Map(prev);
      next.set(txn, { loading: true });
      return next;
    });
    try {
      const arrivals = await listArrivals(txn);
      setArrivalsCache((prev) => {
        const next = new Map(prev);
        next.set(txn, { arrivals, loading: false });
        return next;
      });
    } catch (e: unknown) {
      setArrivalsCache((prev) => {
        const next = new Map(prev);
        next.set(txn, {
          loading: false,
          error: e instanceof Error ? e.message : "Failed to load QC status",
        });
        return next;
      });
    }
  }, []);

  // ── Lazy receipt-summary fetch (received-vs-ordered for the expansion) ─────
  const fetchReceipt = useCallback(async (txn: string) => {
    await Promise.resolve();
    setReceiptCache((prev) => {
      const next = new Map(prev);
      next.set(txn, { loading: true });
      return next;
    });
    try {
      const summary = await getReceiptSummary(txn);
      setReceiptCache((prev) => {
        const next = new Map(prev);
        next.set(txn, { summary, loading: false });
        return next;
      });
    } catch (e: unknown) {
      setReceiptCache((prev) => {
        const next = new Map(prev);
        next.set(txn, {
          loading: false,
          error: e instanceof Error ? e.message : "Failed to load receipt summary",
        });
        return next;
      });
    }
  }, []);

  // ── Fetch articles for visible rows (Articles column) ─────────────────────
  // All rows across the three section pages currently on screen — drives the
  // per-row QC summary + article-line fetches.
  const allVisible = [
    ...sections.today.items,
    ...sections.pending.items,
    ...sections.completed.items,
  ];
  const rowKeysFp = allVisible.map((r) => r.transaction_no).join(",");

  // ── Per-transaction QC summary fetch (badge + filter) ─────────────────────
  // After the listing loads, fetch the QC rollup for ALL visible txns in one
  // call (mirrors the post-load linesCache effect). AbortController guards
  // setState; we defer with Promise.resolve() to dodge set-state-in-effect.
  useEffect(() => {
    if (allVisible.length === 0) return;
    const txns = allVisible.map((r) => r.transaction_no).filter((t): t is string => !!t);
    if (txns.length === 0) return;
    const controller = new AbortController();
    void (async () => {
      await Promise.resolve();
      try {
        const items = await arrivalsSummary(txns, controller.signal);
        if (controller.signal.aborted) return;
        setQcSummary((prev) => {
          const next = new Map(prev);
          for (const it of items) next.set(it.transaction_no, it);
          return next;
        });
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e instanceof Error && e.name === "AbortError") return;
        // Non-fatal: leave the prior summary in place; rows fall back to
        // "pending_arrival" when a txn is absent. No surfaced error here.
      }
    })();
    return () => controller.abort();
    // rowKeysFp changes when the page/filters change; qcSummary is derived output
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowKeysFp, refetchNonce]);
  useEffect(() => {
    if (allVisible.length === 0) return;
    for (const row of allVisible) {
      const txn = row.transaction_no;
      if (!txn) continue;
      const entry = linesCache.get(txn);
      // Fetch if not started yet; retry if previously errored and row is re-visible
      if (!entry) {
        void fetchLines(txn);
      }
    }
    // rowKeysFp changes when the page/filters change; linesCache is derived output
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowKeysFp]);

  // ── Fetch articles for expanded rows (expansion panel) ────────────────────
  // When a row is expanded and we don't yet have its lines (or a previous fetch
  // errored), kick off the fetch so errors are retryable on re-expand.
  useEffect(() => {
    for (const txn of expanded) {
      const entry = linesCache.get(txn);
      if (!entry || (!entry.loading && entry.error && !entry.lines)) {
        void fetchLines(txn);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Array.from(expanded).sort().join(",")]);

  // ── Fetch receipt summary for expanded rows (received vs PO quantity) ─────
  // Same retry-on-re-expand semantics as the lines/arrivals effects above.
  useEffect(() => {
    for (const txn of expanded) {
      const entry = receiptCache.get(txn);
      if (!entry || (!entry.loading && entry.error && !entry.summary)) {
        void fetchReceipt(txn);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Array.from(expanded).sort().join(",")]);

  // ── Fetch QC arrivals for expanded rows (per-article QC status) ───────────
  // Same retry-on-re-expand semantics as the lines effect above.
  useEffect(() => {
    for (const txn of expanded) {
      const entry = arrivalsCache.get(txn);
      if (!entry || (!entry.loading && entry.error && !entry.arrivals)) {
        void fetchArrivals(txn);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Array.from(expanded).sort().join(",")]);

  // ── Sort helper ────────────────────────────────────────────────────────────
  function currentSort(): { col: string; dir: "asc" | "desc" } {
    const s = query.sort ?? "po_date:desc";
    const [col, dir] = s.split(":");
    return { col: col ?? "po_date", dir: (dir as "asc" | "desc") ?? "desc" };
  }

  function handleSort(col: string) {
    if (!(SORTABLE_COLS as readonly string[]).includes(col)) return;
    const { col: activeCol, dir } = currentSort();
    const newDir = activeCol === col ? (dir === "asc" ? "desc" : "asc") : "asc";
    onQueryChange({ sort: `${col}:${newDir}`, page: 1 });
  }

  // ── Open send intimation modal for a row ───────────────────────────────────
  // Ensures lines are loaded before opening; if not yet fetched, triggers fetch.
  function handleSendClick(txn: string) {
    const entry = linesCache.get(txn);
    if (!entry) {
      void fetchLines(txn);
    }
    setSendTxn(txn);
  }

  // Compute modal props when sendTxn is set
  const sendRow = sendTxn ? (allVisible.find((r) => r.transaction_no === sendTxn) ?? null) : null;
  const sendLinesState = sendTxn ? linesCache.get(sendTxn) : undefined;

  // ── Aggregate load/error state across the three sections ───────────────────
  const anyLoaded = sections.today.loaded || sections.pending.loaded || sections.completed.loaded;
  const anyLoading = sections.today.loading || sections.pending.loading || sections.completed.loading;
  const firstError = sections.today.error ?? sections.pending.error ?? sections.completed.error ?? null;

  return (
    <div>
      <MaterialInToolbar
        query={query}
        onQueryChange={onQueryChange}
        search={search}
        onSearch={onSearch}
        onRefresh={() => setRefetchNonce((n) => n + 1)}
      />

      {/* Dashboard sections (Today / Pending / Completed) */}
      {!anyLoaded && anyLoading ? (
        <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[var(--text-secondary)]">
          <span className="inline-flex items-center gap-2 text-[13px]">
            <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
            Loading Purchase Orders…
          </span>
        </div>
      ) : !anyLoaded && firstError ? (
        <div className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-center text-[var(--aws-error)] text-[13px]">{firstError}</div>
      ) : (
        <>
          {/* KPI strip — one tile per section; click a tile to collapse/expand it */}
          <div className="grid grid-cols-3 gap-2 sm:gap-3 mb-4">
            {GROUP_META.map((g) => {
              const sec = sections[g.key];
              return (
                <button
                  key={g.key}
                  type="button"
                  onClick={() => toggleGroup(g.key)}
                  title={collapsedGroups.has(g.key) ? `Expand ${g.label}` : `Collapse ${g.label}`}
                  className="text-left bg-white border border-[var(--aws-border)] rounded-md p-3 shadow-[0_1px_1px_rgba(0,28,36,0.18)] hover:shadow-[0_2px_6px_rgba(0,28,36,0.14)] transition-shadow"
                  style={{ borderTop: `3px solid ${g.accent}` }}
                >
                  <div className="text-[10px] sm:text-[11px] uppercase tracking-wide font-bold truncate" style={{ color: g.accent }}>{g.label}</div>
                  <div className="text-[24px] sm:text-[28px] font-semibold text-[var(--text-primary)] leading-tight mt-0.5 tabular-nums">
                    {sec.loading && !sec.loaded ? (
                      <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin align-middle" />
                    ) : (
                      sec.total
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Section panels */}
          {GROUP_META.map((g) => (
            <SectionPanel
              key={g.key}
              meta={g}
              section={sections[g.key]}
              sort={currentSort()}
              onSort={handleSort}
              collapsed={collapsedGroups.has(g.key)}
              onToggle={() => toggleGroup(g.key)}
              onPage={(p) => void loadSectionPage(g.key, p)}
              onRetry={() => void loadSectionPage(g.key, sections[g.key].page)}
              expanded={expanded}
              onToggleExpand={onToggleExpand}
              onSendClick={handleSendClick}
              onInward={(txn) => router.push(`/modules/purchase/material-in/${encodeURIComponent(txn)}`)}
              linesCache={linesCache}
              qcSummary={qcSummary}
              arrivalsCache={arrivalsCache}
              receiptCache={receiptCache}
            />
          ))}
        </>
      )}

      {/* Send intimation modal */}
      {sendTxn && sendRow ? (
        sendLinesState?.loading ? (
          /* Lines still fetching — show a lightweight inline loader in the modal position */
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="bg-white rounded-md shadow-[0_8px_32px_rgba(0,28,36,0.28)] w-full max-w-md p-8 text-center text-[var(--text-secondary)]">
              <span className="inline-flex items-center gap-2 text-[13px]">
                <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
                Loading articles…
              </span>
            </div>
          </div>
        ) : sendLinesState?.error || (sendLinesState?.lines?.length ?? 0) === 0 ? (
          /* Lines failed to load (or none) — don't open an empty send form */
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setSendTxn(null)}>
            <div className="bg-white rounded-md shadow-[0_8px_32px_rgba(0,28,36,0.28)] w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
              <p className="text-[13px] text-[var(--aws-error)] mb-4">
                {sendLinesState?.error ?? "No articles on this PO — nothing to send."}
              </p>
              <div className="flex justify-end gap-2">
                {sendLinesState?.error ? (
                  <button type="button" onClick={() => fetchLines(sendTxn)} className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]">Retry</button>
                ) : null}
                <button type="button" onClick={() => setSendTxn(null)} className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]">Close</button>
              </div>
            </div>
          </div>
        ) : (
          <SendIntimationModal
            transactionNo={sendTxn}
            poNumber={sendRow.po_number ?? ""}
            vendor={sendRow.vendor_supplier_name ?? ""}
            articles={(sendLinesState?.lines ?? []).map((l) => ({
              line_number: l.line_number,
              name: l.sku_name || l.particulars || "—",
            }))}
            onClose={() => setSendTxn(null)}
          />
        )
      ) : null}
    </div>
  );
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

function MaterialInToolbar({
  query, onQueryChange, search, onSearch, onRefresh,
}: {
  query: PoListQuery;
  onQueryChange: (patch: Partial<PoListQuery>) => void;
  search: string;
  onSearch: (v: string) => void;
  onRefresh: () => void;
}) {
  const [dateOpen, setDateOpen] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  const entity = query.entity ?? "";
  const dateActive = !!(query.po_date_from || query.po_date_to);
  const advCount = [
    query.vendor_supplier_name_contains,
    query.order_reference_no_contains,
    query.narration_contains,
    query.supplier_id,
    query.voucher_type,
  ].filter((v) => v && v.length > 0).length;

  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] mb-4 p-3 flex flex-wrap items-center gap-2">
      {/* Search box */}
      <div className="relative flex-1 min-w-[220px]">
        <svg viewBox="0 0 24 24" className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search PO number…"
          className="w-full h-8 pl-7 pr-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
        />
      </div>

      {/* Entity chips */}
      {(
        [
          { value: "", label: "All entities" },
          { value: "cfpl", label: "CFPL" },
          { value: "cdpl", label: "CDPL" },
        ] as const
      ).map((c) => (
        <button
          key={c.value}
          type="button"
          onClick={() => onQueryChange({ entity: c.value, page: 1 })}
          className={[
            "h-8 px-3 text-[12px] rounded-full border transition-colors",
            entity === c.value
              ? "bg-[var(--aws-navy)] text-white border-[var(--aws-navy)]"
              : "bg-white text-[var(--text-primary)] border-[var(--aws-border-strong)] hover:border-[var(--aws-navy)]",
          ].join(" ")}
        >
          {c.label}
        </button>
      ))}

      {/* Advanced filter */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setAdvOpen((v) => !v)}
          className={[
            "h-8 px-3 text-[12px] rounded-[2px] border flex items-center gap-1.5",
            advCount > 0
              ? "border-[var(--aws-orange)] text-[var(--aws-orange)] bg-[#fbeced]"
              : "border-[var(--aws-border-strong)] bg-white text-[var(--text-primary)] hover:border-[var(--aws-navy)]",
          ].join(" ")}
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
          </svg>
          Advanced
          {advCount > 0 ? (
            <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] rounded-full font-bold bg-[var(--aws-orange)] text-white">
              {advCount}
            </span>
          ) : null}
        </button>
        {advOpen ? (
          <AdvancedFilterPanel
            query={query}
            onApply={(patch) => { onQueryChange({ ...patch, page: 1 }); setAdvOpen(false); }}
            onClose={() => setAdvOpen(false)}
          />
        ) : null}
      </div>

      {/* Date filter */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setDateOpen((v) => !v)}
          className={[
            "h-8 px-3 text-[12px] rounded-[2px] border flex items-center gap-1.5",
            dateActive
              ? "border-[var(--aws-orange)] text-[var(--aws-orange)] bg-[#fbeced]"
              : "border-[var(--aws-border-strong)] bg-white text-[var(--text-primary)] hover:border-[var(--aws-navy)]",
          ].join(" ")}
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2}>
            <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
          </svg>
          {dateActive ? `${query.po_date_from || "…"} → ${query.po_date_to || "…"}` : "Date"}
        </button>
        {dateOpen ? (
          <DatePanel
            dateFrom={query.po_date_from ?? ""}
            dateTo={query.po_date_to ?? ""}
            onApply={(from, to) => { onQueryChange({ po_date_from: from, po_date_to: to, page: 1 }); setDateOpen(false); }}
            onClose={() => setDateOpen(false)}
          />
        ) : null}
      </div>

      {/* Export */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setExportOpen((v) => !v)}
          className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] flex items-center gap-1.5"
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Export
        </button>
        {exportOpen ? (
          <ExportMenu
            query={query}
            onClose={() => setExportOpen(false)}
          />
        ) : null}
      </div>

      {/* Refresh */}
      <button
        type="button"
        onClick={onRefresh}
        className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] flex items-center gap-1.5"
      >
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2}>
          <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
        Refresh
      </button>
    </div>
  );
}

// ── Advanced Filter Panel ─────────────────────────────────────────────────────

const ADV_FIELDS: { key: keyof PoListQuery; label: string; placeholder: string }[] = [
  { key: "vendor_supplier_name_contains", label: "Vendor name contains", placeholder: "e.g. acme" },
  { key: "order_reference_no_contains",   label: "Order ref contains",   placeholder: "e.g. REF-9912" },
  { key: "narration_contains",            label: "Narration contains",   placeholder: "e.g. urgent" },
  { key: "supplier_id",                   label: "Supplier ID (exact)",  placeholder: "e.g. 4471" },
  { key: "voucher_type",                  label: "Voucher type (exact)", placeholder: "e.g. PURCH" },
];

function AdvancedFilterPanel({
  query, onApply, onClose,
}: {
  query: PoListQuery;
  onApply: (patch: Partial<PoListQuery>) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of ADV_FIELDS) init[f.key as string] = (query[f.key] as string | undefined) ?? "";
    return init;
  });

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  function apply() {
    const patch: Partial<PoListQuery> = {};
    for (const f of ADV_FIELDS) {
      (patch as Record<string, string>)[f.key as string] = draft[f.key as string] ?? "";
    }
    onApply(patch);
  }

  function clear() {
    const empty: Record<string, string> = {};
    for (const f of ADV_FIELDS) empty[f.key as string] = "";
    setDraft(empty);
    const patch: Partial<PoListQuery> = {};
    for (const f of ADV_FIELDS) {
      (patch as Record<string, string>)[f.key as string] = "";
    }
    onApply(patch);
  }

  const activeCount = Object.values(draft).filter((v) => v.length > 0).length;

  return (
    <div
      ref={ref}
      className="absolute right-0 z-20 mt-1 w-[min(320px,calc(100vw-1rem))] bg-white border border-[var(--aws-border)] rounded-md shadow-[0_4px_12px_rgba(0,28,36,0.18)] p-3"
    >
      <div className="text-[11px] uppercase tracking-wide font-bold text-[var(--text-muted)] mb-2">Advanced Filters</div>
      {ADV_FIELDS.map((f) => {
        const inputId = `mi-adv-filter-${f.key as string}`;
        return (
          <div key={f.key as string} className="mb-2">
            <label htmlFor={inputId} className="block text-[11px] font-semibold text-[var(--text-primary)] mb-0.5">{f.label}</label>
            <input
              id={inputId}
              type="text"
              value={draft[f.key as string] ?? ""}
              placeholder={f.placeholder}
              onChange={(e) => setDraft((d) => ({ ...d, [f.key as string]: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter") apply(); }}
              className="w-full h-7 px-2 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]"
            />
          </div>
        );
      })}
      <div className="border-t border-[var(--aws-border)] pt-2 mt-1 flex items-center justify-between">
        <span className="text-[11px] text-[var(--text-muted)]">
          {activeCount > 0 ? `${activeCount} filter${activeCount === 1 ? "" : "s"} active` : "No filters active"}
        </span>
        <div className="flex gap-2">
          <button type="button" onClick={clear} disabled={activeCount === 0} className="h-7 px-2 text-[11px] text-[var(--aws-link)] hover:underline disabled:opacity-50 disabled:cursor-not-allowed">Clear</button>
          <button type="button" onClick={apply} className="h-7 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]">Apply</button>
        </div>
      </div>
    </div>
  );
}

// ── Date Panel ────────────────────────────────────────────────────────────────

function DatePanel({
  dateFrom, dateTo, onApply, onClose,
}: {
  dateFrom: string;
  dateTo: string;
  onApply: (from: string, to: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [from, setFrom] = useState(dateFrom);
  const [to, setTo] = useState(dateTo);
  const [rangeErr, setRangeErr] = useState("");

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  function apply() {
    if (from && to && from > to) {
      setRangeErr("From date must be on or before To date.");
      return;
    }
    setRangeErr("");
    onApply(from, to);
  }

  return (
    <div
      ref={ref}
      className="absolute right-0 z-10 mt-1 bg-white border border-[var(--aws-border)] rounded-md shadow-[0_4px_12px_rgba(0,28,36,0.18)] p-3 w-[260px]"
    >
      <label htmlFor="mi-date-from" className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">From</label>
      <input
        id="mi-date-from"
        type="date"
        value={from}
        onChange={(e) => { setFrom(e.target.value); setRangeErr(""); }}
        className="w-full h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] mb-2"
      />
      <label htmlFor="mi-date-to" className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">To</label>
      <input
        id="mi-date-to"
        type="date"
        value={to}
        onChange={(e) => { setTo(e.target.value); setRangeErr(""); }}
        className="w-full h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] mb-2"
      />
      {rangeErr ? <p className="text-[11px] text-[var(--aws-error)] mb-2">{rangeErr}</p> : null}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => { onApply("", ""); }} className="h-7 px-2 text-[12px] text-[var(--aws-link)] hover:underline">Clear</button>
        <button type="button" onClick={apply} className="h-7 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]">Apply</button>
      </div>
    </div>
  );
}

// ── Export Menu ───────────────────────────────────────────────────────────────

function ExportMenu({ query, onClose }: { query: PoListQuery; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"idle" | "selective">("idle");
  const [checkedCols, setCheckedCols] = useState<Set<string>>(
    () => new Set(PO_EXPORT_COLUMNS.map((c) => c.key as string)),
  );
  const [colSearch, setColSearch] = useState("");
  const [exportState, setExportState] = useState<{ kind: "loading" | "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  async function doExport(cols: typeof PO_EXPORT_COLUMNS) {
    setExportState({ kind: "loading", text: "Exporting…" });
    try {
      const items = await fetchAllPosForExport(query);
      if (items.length === 0) {
        setExportState({ kind: "err", text: "No data to export." });
        return;
      }
      const blob = buildPoXlsx(items, cols);
      downloadBlob(blob, `material-in-export-${new Date().toISOString().slice(0, 10)}.xlsx`);
      setExportState({ kind: "ok", text: `Exported ${items.length} PO${items.length === 1 ? "" : "s"}.` });
    } catch (e) {
      setExportState({ kind: "err", text: e instanceof Error ? e.message : "Export failed" });
    }
  }

  const filteredCols = PO_EXPORT_COLUMNS.filter(
    (c) => !colSearch || c.label.toLowerCase().includes(colSearch.toLowerCase()),
  );

  const allChecked = PO_EXPORT_COLUMNS.every((c) => checkedCols.has(c.key as string));

  if (mode === "selective") {
    return (
      <div
        ref={ref}
        className="absolute right-0 z-20 mt-1 w-[260px] bg-white border border-[var(--aws-border)] rounded-md shadow-[0_4px_12px_rgba(0,28,36,0.18)] p-3"
      >
        <div className="text-[11px] uppercase tracking-wide font-bold text-[var(--text-muted)] mb-2">Select Columns</div>
        <input
          type="search"
          value={colSearch}
          onChange={(e) => setColSearch(e.target.value)}
          placeholder="Filter columns…"
          className="w-full h-7 px-2 mb-2 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e]"
        />
        <div className="mb-2">
          <label className="flex items-center gap-2 text-[12px] text-[var(--text-primary)] cursor-pointer hover:bg-[var(--surface-subtle)] px-1 py-0.5 rounded-sm">
            <input
              type="checkbox"
              checked={allChecked}
              onChange={(e) => {
                if (e.target.checked) setCheckedCols(new Set(PO_EXPORT_COLUMNS.map((c) => c.key as string)));
                else setCheckedCols(new Set());
              }}
            />
            Toggle All
          </label>
        </div>
        <div className="max-h-[200px] overflow-y-auto space-y-0.5 mb-2">
          {filteredCols.map((c) => (
            <label key={c.key as string} className="flex items-center gap-2 text-[12px] text-[var(--text-primary)] cursor-pointer hover:bg-[var(--surface-subtle)] px-1 py-0.5 rounded-sm">
              <input
                type="checkbox"
                checked={checkedCols.has(c.key as string)}
                onChange={(e) => {
                  setCheckedCols((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(c.key as string); else next.delete(c.key as string);
                    return next;
                  });
                }}
              />
              {c.label}
            </label>
          ))}
        </div>
        {exportState ? (
          <p className={["text-[11px] mb-2", exportState.kind === "ok" ? "text-[var(--text-success)]" : exportState.kind === "err" ? "text-[var(--aws-error)]" : "text-[var(--text-secondary)]"].join(" ")}>
            {exportState.text}
          </p>
        ) : null}
        <div className="flex gap-2 justify-end border-t border-[var(--aws-border)] pt-2">
          <button type="button" onClick={() => setMode("idle")} className="h-7 px-2 text-[12px] text-[var(--aws-link)] hover:underline">Back</button>
          <button
            type="button"
            disabled={checkedCols.size === 0 || exportState?.kind === "loading"}
            onClick={() => {
              const cols = PO_EXPORT_COLUMNS.filter((c) => checkedCols.has(c.key as string));
              void doExport(cols);
            }}
            className="h-7 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Export
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className="absolute right-0 z-10 mt-1 bg-white border border-[var(--aws-border)] rounded-md shadow-[0_4px_12px_rgba(0,28,36,0.18)] p-1 w-[210px]"
    >
      {exportState ? (
        <p className={["text-[11px] px-2 py-1", exportState.kind === "ok" ? "text-[var(--text-success)]" : exportState.kind === "err" ? "text-[var(--aws-error)]" : "text-[var(--text-secondary)]"].join(" ")}>
          {exportState.text}
        </p>
      ) : null}
      <button
        type="button"
        disabled={exportState?.kind === "loading"}
        onClick={() => void doExport(PO_EXPORT_COLUMNS)}
        className="w-full text-left px-2 py-1.5 text-[13px] hover:bg-[var(--surface-disabled)] rounded-sm disabled:opacity-50"
      >
        Direct — all columns
      </button>
      <button
        type="button"
        onClick={() => setMode("selective")}
        className="w-full text-left px-2 py-1.5 text-[13px] hover:bg-[var(--surface-disabled)] rounded-sm"
      >
        Selective — choose columns
      </button>
    </div>
  );
}

// ── Th ────────────────────────────────────────────────────────────────────────

function Th({
  children, sortable, col, sort, onSort, width,
}: {
  children: React.ReactNode;
  sortable?: boolean;
  col?: string;
  sort?: { col: string; dir: "asc" | "desc" };
  onSort?: (c: string) => void;
  width?: number;
}) {
  const active = sortable && col && sort && sort.col === col;
  return (
    <th
      style={width ? { width } : undefined}
      onClick={sortable && col && onSort ? () => onSort(col) : undefined}
      className={[
        "px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-[var(--text-secondary)] whitespace-nowrap",
        sortable ? "cursor-pointer select-none hover:text-[var(--text-primary)]" : "",
      ].join(" ")}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {active ? (
          <span className="text-[10px] text-[var(--aws-orange)]">{sort?.dir === "asc" ? "▲" : "▼"}</span>
        ) : null}
      </span>
    </th>
  );
}

// ── Entity pill ───────────────────────────────────────────────────────────────

function EntityPill({ entity }: { entity?: string | null }) {
  if (!entity) return <span className="text-[var(--text-muted)]">—</span>;
  const upper = entity.toUpperCase();
  const bg = upper === "CFPL" ? "#eaf6ed" : upper === "CDPL" ? "#eaf0fb" : "var(--surface-disabled)";
  const fg = upper === "CFPL" ? "var(--text-success)" : upper === "CDPL" ? "#2c5fa8" : "var(--text-secondary)";
  const border = upper === "CFPL" ? "#b6dbb1" : upper === "CDPL" ? "#2c5fa822" : "var(--aws-border)";
  return (
    <span
      className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-sm"
      style={{ background: bg, color: fg, border: `1px solid ${border}` }}
    >
      {upper}
    </span>
  );
}

// ── QC status pill (per-transaction) ──────────────────────────────────────────
// Pending arrival (grey) / Arrived (amber/blue) / Completed (green). For
// Completed, also reflect accepted/rejected counts from the summary.

function QcTxnBadge({ summary }: { summary?: ArrivalSummaryItem }) {
  const status: QcTxnStatus = summary ? summary.status : "pending_arrival";
  if (status === "pending_arrival") {
    return (
      <span
        className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-sm whitespace-nowrap"
        style={{ background: "var(--surface-disabled)", color: "var(--text-secondary)", border: "1px solid var(--aws-border)" }}
      >
        Pending arrival
      </span>
    );
  }
  if (status === "arrived") {
    return (
      <span
        className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-sm whitespace-nowrap"
        style={{ background: "#fbe7d6", color: "#9a5b00", border: "1px solid #f0cfa0" }}
        title={summary ? `${summary.awaiting} awaiting · ${summary.in_qc} in QC · ${summary.accepted}✓ ${summary.rejected}✗` : undefined}
      >
        Arrived
      </span>
    );
  }
  // completed
  const accepted = summary?.accepted ?? 0;
  const rejected = summary?.rejected ?? 0;
  return (
    <span
      className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-sm whitespace-nowrap"
      style={{ background: "#eaf6ed", color: "var(--text-success)", border: "1px solid #b6dbb1" }}
      title={`Completed · ${accepted} accepted · ${rejected} rejected`}
    >
      {`Completed · ${accepted}✓ ${rejected}✗`}
    </span>
  );
}

// ── QC status pill (per-article, inside the expansion) ────────────────────────
// Pending arrival / Arrived / In QC / Accepted / Rejected. When a line has
// multiple arrivals in differing states, show the least-progressed state + count.

const QC_ARTICLE_STYLE: Record<QcArrivalState, { bg: string; fg: string; border: string }> = {
  arrived:  { bg: "#fbe7d6", fg: "#9a5b00",                border: "#f0cfa0" },
  in_qc:    { bg: "#eaf0fb", fg: "#2c5fa8",                border: "#c3d4f0" },
  accepted: { bg: "#eaf6ed", fg: "var(--text-success)",   border: "#b6dbb1" },
  rejected: { bg: "#fbeced", fg: "var(--aws-error)",      border: "#f0c0c4" },
};

function QcArticleBadge({ states }: { states: QcArrivalState[] }) {
  if (states.length === 0) {
    return (
      <span
        className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-sm whitespace-nowrap"
        style={{ background: "var(--surface-disabled)", color: "var(--text-secondary)", border: "1px solid var(--aws-border)" }}
      >
        Pending arrival
      </span>
    );
  }
  // Pick the least-done state to summarise; show a count when mixed.
  const least = [...states].sort((a, b) => QC_STATE_RANK[a] - QC_STATE_RANK[b])[0];
  const uniform = states.every((s) => s === states[0]);
  const style = QC_ARTICLE_STYLE[least];
  const label = QC_STATE_LABEL[least];
  return (
    <span
      className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-sm whitespace-nowrap"
      style={{ background: style.bg, color: style.fg, border: `1px solid ${style.border}` }}
      title={uniform ? `${states.length} arrival(s): ${label}` : `${states.length} arrivals · ${states.map((s) => QC_STATE_LABEL[s]).join(", ")}`}
    >
      {label}
      {states.length > 1 ? <span className="ml-1 opacity-70">×{states.length}</span> : null}
    </span>
  );
}

// Match a PO line to its arrivals. PoLineOut has no sku_id, so match by article
// name (line's sku_name||particulars vs arrival sku_name), case-insensitive.
function arrivalsForLine(line: PoLineOut, arrivals: ArrivalItem[]): QcArrivalState[] {
  const lineName = (line.sku_name || line.particulars || "").trim().toLowerCase();
  if (!lineName) return [];
  return arrivals
    .filter((a) => (a.sku_name || "").trim().toLowerCase() === lineName)
    .map((a) => a.qc_state);
}

// ── Articles column cell ──────────────────────────────────────────────────────
// Mirrors send-intimation.js's paintPoArticleCell: shows first 2 names + "+N more".

function ArticlesSummary({
  linesState,
}: {
  linesState?: { lines?: PoLineOut[]; loading: boolean; error?: string };
}) {
  if (!linesState || linesState.loading) {
    return <span className="text-[var(--text-muted)] text-[12px]">…</span>;
  }
  if (linesState.error) {
    return <span className="text-[var(--text-muted)] text-[12px]">—</span>;
  }
  const lines = linesState.lines ?? [];
  if (lines.length === 0) {
    return <span className="text-[var(--text-muted)] italic text-[12px]">No articles</span>;
  }
  const names = lines.map((l) => l.sku_name || l.particulars || "—");
  const head = names.slice(0, 2).join(", ");
  const more = names.length > 2 ? names.length - 2 : 0;
  return (
    <span
      className="text-[12px] text-[var(--text-primary)]"
      title={names.join(" · ")}
    >
      {head}
      {more > 0 ? (
        <span className="text-[var(--text-muted)] ml-1">+{more} more</span>
      ) : null}
    </span>
  );
}

// ── Action buttons (view + send — no delete) ──────────────────────────────────

function ActionBtns({
  onToggle, onSend, onInward, isOpen,
}: {
  onToggle: () => void;
  onSend: () => void;
  onInward: () => void;
  isOpen: boolean;
}) {
  return (
    <div className="flex items-center gap-1">
      {/* Eye / view */}
      <button
        type="button"
        onClick={onToggle}
        title={isOpen ? "Collapse" : "Expand"}
        aria-label={isOpen ? "Collapse" : "Expand"}
        className="p-1 rounded hover:bg-[var(--surface-divider)] text-[var(--text-secondary)]"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2}>
          {isOpen
            ? <><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /><line x1="1" y1="1" x2="23" y2="23" /></>
            : <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></>
          }
        </svg>
      </button>
      {/* Inward (right arrow) — open box-wise receiving for this transaction */}
      <button
        type="button"
        onClick={onInward}
        title="Open inward entry"
        aria-label="Open inward entry"
        className="p-1 rounded hover:bg-[#eaf0fb] text-[var(--text-secondary)] hover:text-[#2c5fa8]"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
        </svg>
      </button>
      {/* Send intimation */}
      <button
        type="button"
        onClick={onSend}
        title="Send intimation"
        aria-label="Send intimation"
        className="p-1 rounded hover:bg-[#eaf0fb] text-[var(--text-secondary)] hover:text-[#2c5fa8]"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <line x1="22" y1="2" x2="11" y2="13" />
          <polygon points="22 2 15 22 11 13 2 9 22 2" />
        </svg>
      </button>
    </div>
  );
}

// ── Section panel (dashboard card: Today / Pending / Completed) ───────────────
// A self-contained card: a coloured header bar (title + count + collapse toggle)
// over its own responsive body — a desktop table and a mobile card stack for the
// rows in that section. Empty sections still render (with a hint) so the three
// dashboard cards stay put.

type GroupMeta = { key: GroupKey; label: string; accent: string; bg: string };

type LinesState = { lines?: PoLineOut[]; loading: boolean; error?: string };
type ArrivalsState = { arrivals?: ArrivalItem[]; loading: boolean; error?: string };
type ReceiptState = { summary?: ReceiptSummary; loading: boolean; error?: string };

function SectionPanel({
  meta, section, sort, onSort, collapsed, onToggle, onPage, onRetry,
  expanded, onToggleExpand, onSendClick, onInward,
  linesCache, qcSummary, arrivalsCache, receiptCache,
}: {
  meta: GroupMeta;
  section: SectionState;
  sort: { col: string; dir: "asc" | "desc" };
  onSort: (col: string) => void;
  collapsed: boolean;
  onToggle: () => void;
  onPage: (page: number) => void;
  onRetry: () => void;
  expanded: Set<string>;
  onToggleExpand: (txn: string) => void;
  onSendClick: (txn: string) => void;
  onInward: (txn: string) => void;
  linesCache: Map<string, LinesState>;
  qcSummary: Map<string, ArrivalSummaryItem>;
  arrivalsCache: Map<string, ArrivalsState>;
  receiptCache: Map<string, ReceiptState>;
}) {
  const rows = section.items;
  return (
    <section className="mb-4 bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] overflow-hidden">
      {/* Header bar */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left"
        style={{ background: meta.bg, borderLeft: `4px solid ${meta.accent}` }}
      >
        <span className="inline-flex items-center gap-2">
          <span className={["text-[10px] text-[var(--text-muted)] transition-transform inline-block", collapsed ? "" : "rotate-90"].join(" ")} aria-hidden>▸</span>
          <span className="w-2 h-2 rounded-full inline-block" style={{ background: meta.accent }} aria-hidden />
          <span className="text-[13px] font-bold uppercase tracking-wide" style={{ color: meta.accent }}>{meta.label}</span>
          {section.loading ? (
            <span className="inline-block w-3 h-3 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" aria-hidden />
          ) : null}
        </span>
        <span className="inline-flex items-center justify-center min-w-[24px] h-[20px] px-2 text-[11px] rounded-full font-bold text-white" style={{ background: meta.accent }}>{section.total}</span>
      </button>

      {collapsed ? null : section.error ? (
        <div className="px-3 py-6 text-center border-t border-[var(--aws-border)]">
          <p className="text-[12px] text-[var(--aws-error)] mb-2">{section.error}</p>
          <button type="button" onClick={onRetry} className="h-7 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]">Retry</button>
        </div>
      ) : section.loading && rows.length === 0 ? (
        <div className="px-3 py-6 text-center text-[12px] text-[var(--text-secondary)] border-t border-[var(--aws-border)]">
          <span className="inline-flex items-center gap-2">
            <span className="inline-block w-3.5 h-3.5 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
            Loading…
          </span>
        </div>
      ) : rows.length === 0 ? (
        <div className="px-3 py-6 text-center text-[12px] text-[var(--text-muted)] border-t border-[var(--aws-border)]">
          No POs in this section.
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto border-t border-[var(--aws-border)]">
            <table className="w-full text-[13px] border-collapse">
              <thead className="bg-[var(--surface-subtle)] text-[var(--text-primary)]">
                <tr className="border-b border-[var(--aws-border)]">
                  <Th width={32}>{null}</Th>
                  <Th sortable col="transaction_no" sort={sort} onSort={onSort}>Transaction No</Th>
                  <Th>Entity</Th>
                  <Th sortable col="po_number" sort={sort} onSort={onSort}>PO Number</Th>
                  <Th sortable col="vendor_supplier_name" sort={sort} onSort={onSort}>Vendor</Th>
                  <Th>Articles</Th>
                  <Th>QC Status</Th>
                  <Th width={72}>{null}</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const txn = row.transaction_no;
                  return (
                    <MaterialInTableRow
                      key={txn || `idx-${meta.key}-${i}`}
                      row={row}
                      isOpen={expanded.has(txn)}
                      onToggle={() => onToggleExpand(txn)}
                      onSend={() => onSendClick(txn)}
                      onInward={() => onInward(txn)}
                      linesState={linesCache.get(txn)}
                      qcSummaryItem={qcSummary.get(txn)}
                      arrivalsState={arrivalsCache.get(txn)}
                      receiptState={receiptCache.get(txn)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden p-2 space-y-2 border-t border-[var(--aws-border)]">
            {rows.map((row, i) => {
              const txn = row.transaction_no;
              return (
                <MaterialInMobileCard
                  key={txn || `m-${meta.key}-${i}`}
                  row={row}
                  isOpen={expanded.has(txn)}
                  onToggle={() => onToggleExpand(txn)}
                  onSend={() => onSendClick(txn)}
                  onInward={() => onInward(txn)}
                  linesState={linesCache.get(txn)}
                  qcSummaryItem={qcSummary.get(txn)}
                  arrivalsState={arrivalsCache.get(txn)}
                  receiptState={receiptCache.get(txn)}
                />
              );
            })}
          </div>

          {/* Per-section pagination (page_size 20, backend-driven) */}
          {section.totalPages > 1 ? (
            <div className="px-3 pb-3 border-t border-[var(--aws-border)]">
              <MiPagination
                page={section.page}
                totalPages={section.totalPages}
                total={section.total}
                pageSize={SECTION_PAGE_SIZE}
                onPage={onPage}
                loading={section.loading}
              />
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

// ── Table Row + Detail ─────────────────────────────────────────────────────────

function MaterialInTableRow({
  row, isOpen, onToggle, onSend, onInward, linesState, qcSummaryItem, arrivalsState, receiptState,
}: {
  row: PoListItem;
  isOpen: boolean;
  onToggle: () => void;
  onSend: () => void;
  onInward: () => void;
  linesState?: { lines?: PoLineOut[]; loading: boolean; error?: string };
  qcSummaryItem?: ArrivalSummaryItem;
  arrivalsState?: { arrivals?: ArrivalItem[]; loading: boolean; error?: string };
  receiptState?: ReceiptState;
}) {
  return (
    <>
      <tr
        className="border-b border-[var(--aws-border)] hover:bg-[var(--surface-subtle)] cursor-pointer"
        onClick={onToggle}
      >
        <td className="px-3 py-2 align-middle">
          <span className={["text-[10px] text-[var(--text-muted)] transition-transform inline-block", isOpen ? "rotate-90" : ""].join(" ")} aria-hidden>▸</span>
        </td>
        <td className="px-3 py-2 font-mono text-[12px] text-[var(--aws-link)] whitespace-nowrap">
          {row.transaction_no || "—"}
        </td>
        <td className="px-3 py-2 whitespace-nowrap"><EntityPill entity={row.entity} /></td>
        <td className="px-3 py-2 font-mono text-[12px] whitespace-nowrap">
          {row.po_number || "—"}
        </td>
        <td className="px-3 py-2 max-w-[220px] truncate" title={row.vendor_supplier_name ?? ""}>
          {row.vendor_supplier_name || "—"}
        </td>
        <td className="px-3 py-2 max-w-[240px]">
          <ArticlesSummary linesState={linesState} />
        </td>
        <td className="px-3 py-2 whitespace-nowrap">
          <QcTxnBadge summary={qcSummaryItem} />
        </td>
        <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
          <ActionBtns onToggle={onToggle} onSend={onSend} onInward={onInward} isOpen={isOpen} />
        </td>
      </tr>
      {isOpen ? (
        <tr className="border-b border-[var(--aws-border)] bg-[var(--surface-subtle)]">
          <td colSpan={8} className="px-3 py-3" style={{ borderLeft: "3px solid var(--aws-orange)" }}>
            <MaterialInDetailPanel key={row.transaction_no} linesState={linesState} arrivalsState={arrivalsState} receiptState={receiptState} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

// ── Mobile Card ───────────────────────────────────────────────────────────────

function MaterialInMobileCard({
  row, isOpen, onToggle, onSend, onInward, linesState, qcSummaryItem, arrivalsState, receiptState,
}: {
  row: PoListItem;
  isOpen: boolean;
  onToggle: () => void;
  onSend: () => void;
  onInward: () => void;
  linesState?: { lines?: PoLineOut[]; loading: boolean; error?: string };
  qcSummaryItem?: ArrivalSummaryItem;
  arrivalsState?: { arrivals?: ArrivalItem[]; loading: boolean; error?: string };
  receiptState?: ReceiptState;
}) {
  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] overflow-hidden">
      <div className="p-3 flex items-start gap-2">
        {/* Expand toggle */}
        <button
          type="button"
          onClick={onToggle}
          className="w-6 h-6 mt-0.5 rounded-sm border border-[var(--aws-border-strong)] text-[var(--text-secondary)] flex items-center justify-center hover:border-[var(--aws-navy)] shrink-0"
          aria-label={isOpen ? "Collapse" : "Expand"}
        >
          {isOpen ? "−" : "+"}
        </button>
        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Row 1: Transaction No + Entity pill */}
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <span className="font-mono text-[12px] font-semibold text-[var(--aws-link)] truncate">
              {row.transaction_no || "—"}
            </span>
            <EntityPill entity={row.entity} />
          </div>
          {/* Row 2: PO Number */}
          <p className="text-[11px] text-[var(--text-muted)] mb-0.5">
            PO: <span className="font-mono text-[var(--text-primary)]">{row.po_number || "—"}</span>
          </p>
          {/* Row 3: Vendor */}
          <p className="text-[13px] text-[var(--text-primary)] truncate mb-1" title={row.vendor_supplier_name ?? ""}>
            {row.vendor_supplier_name || "—"}
          </p>
          {/* Row 4: Articles summary */}
          <div className="text-[12px] text-[var(--text-secondary)]">
            <ArticlesSummary linesState={linesState} />
          </div>
          {/* Row 5: QC status badge */}
          <div className="mt-1">
            <QcTxnBadge summary={qcSummaryItem} />
          </div>
        </div>
        {/* Actions */}
        <div className="shrink-0">
          <ActionBtns onToggle={onToggle} onSend={onSend} onInward={onInward} isOpen={isOpen} />
        </div>
      </div>
      {/* Expanded detail */}
      {isOpen ? (
        <div className="border-t border-[var(--aws-border)] p-3 bg-[var(--surface-subtle)]">
          <MaterialInDetailPanel key={row.transaction_no} linesState={linesState} arrivalsState={arrivalsState} receiptState={receiptState} />
        </div>
      ) : null}
    </div>
  );
}

// ── Detail Panel — Articles + Received-vs-PO quantity breakdown ───────────────

function MaterialInDetailPanel({
  linesState, arrivalsState, receiptState,
}: {
  linesState?: { lines?: PoLineOut[]; loading: boolean; error?: string };
  arrivalsState?: { arrivals?: ArrivalItem[]; loading: boolean; error?: string };
  receiptState?: ReceiptState;
}) {
  const lines = linesState?.lines ?? [];

  return (
    <div className="space-y-3 text-[12px]">
      {/* Articles (ordered) + per-article QC status */}
      <div className="space-y-1">
        <div className="text-[11px] uppercase tracking-wide font-bold text-[var(--text-muted)]">
          Articles{lines.length ? ` (${lines.length})` : ""}
        </div>
        {linesState?.loading ? (
          <div className="py-2 text-[var(--text-secondary)] flex items-center gap-2">
            <span className="inline-block w-3 h-3 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
            Loading articles…
          </div>
        ) : linesState?.error ? (
          <p className="text-[var(--aws-error)] py-1">{linesState.error}</p>
        ) : !linesState ? (
          <p className="text-[var(--text-muted)] italic py-1">Articles will appear here once loaded.</p>
        ) : lines.length === 0 ? (
          <p className="text-[var(--text-muted)] italic py-1">No articles on this PO.</p>
        ) : (
          <div className="overflow-x-auto rounded-[2px] border border-[var(--aws-border)]">
            <table className="w-auto text-[12px] border-collapse">
              <thead className="bg-[var(--surface-subtle)]">
                <tr className="border-b border-[var(--aws-border)]">
                  <th className="px-3 py-1 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] w-8">#</th>
                  <th className="px-3 py-1 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">Article</th>
                  <th className="px-3 py-1 text-right text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] whitespace-nowrap">Pack</th>
                  <th className="px-3 py-1 text-right text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] whitespace-nowrap">Weight</th>
                  <th className="px-3 py-1 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] whitespace-nowrap">QC Status</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.line_number ?? i} className="border-b border-[var(--aws-border)] last:border-b-0 hover:bg-[var(--surface-subtle)]">
                    <td className="px-3 py-1 text-[var(--text-muted)]">{l.line_number ?? i + 1}</td>
                    <td className="px-3 py-1 max-w-[420px] truncate" title={l.sku_name || l.particulars || ""}>
                      {l.sku_name || l.particulars || "—"}
                    </td>
                    <td className="px-3 py-1 text-right font-mono tabular-nums whitespace-nowrap">{fmtNum(l.pack_count)}</td>
                    <td className="px-3 py-1 text-right font-mono tabular-nums whitespace-nowrap">{fmtNum(l.po_weight)}</td>
                    <td className="px-3 py-1 whitespace-nowrap">
                      {arrivalsState?.loading ? (
                        <span className="text-[var(--text-muted)] text-[11px]">…</span>
                      ) : arrivalsState?.error ? (
                        <span className="text-[var(--text-muted)] text-[11px]">—</span>
                      ) : (
                        <QcArticleBadge states={arrivalsForLine(l, arrivalsState?.arrivals ?? [])} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Received vs PO quantity — drives the Completed status */}
      <ReceiptBreakdown receiptState={receiptState} />
    </div>
  );
}

// ── Received vs PO quantity breakdown ─────────────────────────────────────────
// Per line: received (net weight / count from weighed boxes) vs the ordered PO
// quantity, with a Matched/Short badge. A PO is "Completed" when every line
// matches on both weight and count — the same rule the backend section filter
// applies (po_query._FULLY_RECEIVED_PREDICATE).

function ReceiptBreakdown({ receiptState }: { receiptState?: ReceiptState }) {
  const summary = receiptState?.summary;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="text-[11px] uppercase tracking-wide font-bold text-[var(--text-muted)]">
          Received vs PO Quantity
        </div>
        {summary ? (
          summary.completed ? (
            <span className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-sm" style={{ background: "#eaf6ed", color: "var(--text-success)", border: "1px solid #b6dbb1" }}>
              Completed · fully received
            </span>
          ) : (
            <span className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-sm" style={{ background: "#fbf3e7", color: "#9a5b00", border: "1px solid #f0cfa0" }}>
              Not fully received
            </span>
          )
        ) : null}
      </div>
      {receiptState?.loading ? (
        <div className="py-2 text-[var(--text-secondary)] flex items-center gap-2">
          <span className="inline-block w-3 h-3 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
          Loading receipt…
        </div>
      ) : receiptState?.error ? (
        <p className="text-[var(--aws-error)] py-1">{receiptState.error}</p>
      ) : !summary ? (
        <p className="text-[var(--text-muted)] italic py-1">Receipt details will appear here once loaded.</p>
      ) : summary.lines.length === 0 ? (
        <p className="text-[var(--text-muted)] italic py-1">No article lines on this PO.</p>
      ) : (
        <div className="overflow-x-auto rounded-[2px] border border-[var(--aws-border)]">
          <table className="w-auto text-[12px] border-collapse">
            <thead className="bg-[var(--surface-subtle)]">
              <tr className="border-b border-[var(--aws-border)]">
                <th className="px-3 py-1 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] w-8">#</th>
                <th className="px-3 py-1 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">Article</th>
                <th className="px-3 py-1 text-right text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] whitespace-nowrap">Recv Wt / PO Wt</th>
                <th className="px-3 py-1 text-right text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] whitespace-nowrap">Recv Cnt / PO Cnt</th>
                <th className="px-3 py-1 text-right text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] whitespace-nowrap">Boxes</th>
                <th className="px-3 py-1 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)] whitespace-nowrap">Match</th>
              </tr>
            </thead>
            <tbody>
              {summary.lines.map((l, i) => (
                <tr key={l.line_number ?? i} className="border-b border-[var(--aws-border)] last:border-b-0 hover:bg-[var(--surface-subtle)]">
                  <td className="px-3 py-1 text-[var(--text-muted)]">{l.line_number ?? i + 1}</td>
                  <td className="px-3 py-1 max-w-[360px] truncate" title={l.sku_name || l.particulars || ""}>
                    {l.sku_name || l.particulars || "—"}
                  </td>
                  <td className={["px-3 py-1 text-right font-mono tabular-nums whitespace-nowrap", l.weight_matched ? "" : "text-[var(--aws-error)] font-semibold"].join(" ")}>
                    {fmtNum(l.received_weight)} / {l.ordered_weight != null ? fmtNum(l.ordered_weight) : "—"}
                  </td>
                  <td className={["px-3 py-1 text-right font-mono tabular-nums whitespace-nowrap", l.count_matched ? "" : "text-[var(--aws-error)] font-semibold"].join(" ")}>
                    {fmtNum(l.received_count)} / {l.ordered_count != null ? fmtNum(l.ordered_count) : "—"}
                  </td>
                  <td className="px-3 py-1 text-right font-mono tabular-nums whitespace-nowrap text-[var(--text-secondary)]">{fmtNum(l.received_boxes)}</td>
                  <td className="px-3 py-1 whitespace-nowrap">
                    {l.matched ? (
                      <span className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-sm" style={{ background: "#eaf6ed", color: "var(--text-success)", border: "1px solid #b6dbb1" }}>Matched</span>
                    ) : (
                      <span className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-sm" style={{ background: "#fbeced", color: "var(--aws-error)", border: "1px solid #f0c0c4" }}>Short</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Pagination ────────────────────────────────────────────────────────────────

function PageBtn({
  p, label, active, disabled, onPage, loading,
}: {
  p: number; label: React.ReactNode; active?: boolean; disabled?: boolean;
  onPage: (p: number) => void; loading: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onPage(p)}
      disabled={!!disabled || loading}
      className={[
        "min-w-[28px] h-7 px-2 text-[12px] rounded-sm border",
        active
          ? "bg-[var(--aws-navy)] text-white border-[var(--aws-navy)]"
          : "bg-white text-[var(--text-primary)] border-[var(--aws-border-strong)] hover:border-[var(--aws-navy)]",
        disabled ? "opacity-50 cursor-not-allowed" : "",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

function MiPagination({
  page, totalPages, total, pageSize, onPage, loading,
}: {
  page: number; totalPages: number; total: number; pageSize: number;
  onPage: (p: number) => void; loading: boolean;
}) {
  if (total === 0 || totalPages <= 1) return null;
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(page * pageSize, total);
  const max = 7;
  let from = Math.max(1, page - Math.floor(max / 2));
  const to = Math.min(totalPages, from + max - 1);
  if (to - from + 1 < max) from = Math.max(1, to - max + 1);
  const pages: number[] = [];
  for (let i = from; i <= to; i++) pages.push(i);

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
      <span className="text-[12px] text-[var(--text-secondary)]">
        Showing {start}–{end} of {total} PO{total === 1 ? "" : "s"}
      </span>
      <div className="flex items-center gap-1">
        <PageBtn p={page - 1} label="‹" disabled={page <= 1} onPage={onPage} loading={loading} />
        {from > 1 ? <PageBtn p={1} label={1} onPage={onPage} loading={loading} /> : null}
        {from > 2 ? <span className="px-1 text-[var(--text-muted)]">…</span> : null}
        {pages.map((p) => <PageBtn key={p} p={p} label={p} active={p === page} onPage={onPage} loading={loading} />)}
        {to < totalPages - 1 ? <span className="px-1 text-[var(--text-muted)]">…</span> : null}
        {to < totalPages ? <PageBtn p={totalPages} label={totalPages} onPage={onPage} loading={loading} /> : null}
        <PageBtn p={page + 1} label="›" disabled={page >= totalPages} onPage={onPage} loading={loading} />
      </div>
    </div>
  );
}
