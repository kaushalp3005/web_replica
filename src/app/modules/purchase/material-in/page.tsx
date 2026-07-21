"use client";

// Material In page — read-only PO listing with per-row article summaries and
// Send intimation action. Part of the Purchase module.
//
// Owns query/search/expanded state and renders MaterialInList.
// No upload zone, no entity selector, no preview/commit, no result banner.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { type PoListQuery } from "@/lib/po";
import { BackLink } from "@/components/BackLink";
import { PurchaseChrome } from "../_chrome";
import { MaterialInList } from "./_MaterialInList";
import { WalkInIntimationModal } from "./_WalkInIntimationModal";

// ── Constants ─────────────────────────────────────────────────────────────────

const SEARCH_DEBOUNCE_MS = 300;

const DEFAULT_QUERY: PoListQuery = {
  sort: "po_date:desc",
  page: 1,
  page_size: 50,
  entity: "",
};

// ── Page ──────────────────────────────────────────────────────────────────────

export default function MaterialInPage(): React.JSX.Element {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);

  // ── Hydration guard (SSR/client match) ────────────────────────────────────
  // No sessionStorage cache for this page — simple mount guard avoids
  // any potential SSR/client mismatch if state is later extended.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    queueMicrotask(() => setMounted(true));
  }, []);

  // ── Listing state (controlled) ────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState<PoListQuery>(DEFAULT_QUERY);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [walkInOpen, setWalkInOpen] = useState(false);

  // ── Debounce search → query.po_number_contains ────────────────────────────
  const isFirstSearch = useRef(true);
  useEffect(() => {
    if (isFirstSearch.current) { isFirstSearch.current = false; return; }
    const t = setTimeout(() => {
      setQuery((prev) => ({ ...prev, po_number_contains: search.trim(), page: 1 }));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  // ── Listing callbacks ─────────────────────────────────────────────────────

  function handleQueryChange(patch: Partial<PoListQuery>) {
    setQuery((prev) => {
      const resetPage = patch.page === undefined ? { page: 1 } : {};
      return { ...prev, ...patch, ...resetPage };
    });
  }

  function handleToggleExpand(txn: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(txn)) next.delete(txn); else next.add(txn);
      return next;
    });
  }

  // ── Loading shell (pre-mount) ─────────────────────────────────────────────
  if (!mounted) {
    return (
      <PurchaseChrome title="Material In">
        <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[var(--text-secondary)]">
          <span className="inline-flex items-center gap-2 text-[13px]">
            <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
            Loading…
          </span>
        </div>
      </PurchaseChrome>
    );
  }

  if (!authed) return <></>;

  return (
    <PurchaseChrome title="Material In">
      {/* Back link */}
      <div className="mb-3">
        <BackLink parentHref="/modules/purchase" label="Purchase" />
      </div>

      {/* Page header */}
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">
            Material In
          </h1>
          <p className="text-[13px] text-[var(--text-secondary)] mt-1">
            Browse purchase orders by article and send arrival intimations.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setWalkInOpen(true)}
          className="h-9 px-4 text-[13px] rounded-[2px] bg-[var(--aws-orange)] text-white font-semibold hover:bg-[var(--aws-orange-hover)] whitespace-nowrap shrink-0 inline-flex items-center gap-2"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
          Send Purchase Intimation
        </button>
      </div>

      {/* Listing */}
      <MaterialInList
        query={query}
        onQueryChange={handleQueryChange}
        search={search}
        onSearch={setSearch}
        expanded={expanded}
        onToggleExpand={handleToggleExpand}
      />

      {walkInOpen ? <WalkInIntimationModal onClose={() => setWalkInOpen(false)} /> : null}
    </PurchaseChrome>
  );
}
