"use client";

// Command-palette item search (Tally "Name of Item" → "List of Stock Items").
// Type-ahead over the article master with live closing beside each match.
// Renders fixtures today; swaps to LedgerApi.searchItems() once the backend
// lands — pass the query + an AbortController.signal there and cancel the
// in-flight request on each keystroke (the debounce below is already in place).

import { useEffect, useMemo, useRef, useState } from "react";
import { SEARCH_DEBOUNCE_MS } from "@/lib/constants";
import { ITEM_SEARCH } from "./_fixtures";
import { fmtQty } from "./_ui";
import type { ItemSearchResult } from "@/lib/ledger";

export function slugifySku(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function highlight(text: string, q: string) {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <em className="not-italic font-bold text-[var(--aws-orange)] bg-[#9a393e1f] rounded px-[2px]">
        {text.slice(i, i + q.length)}
      </em>
      {text.slice(i + q.length)}
    </>
  );
}

export function ItemSearch({
  open, onClose, onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (item: ItemSearchResult) => void;
}) {
  const [raw, setRaw] = useState("");
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // debounce raw → q (mirrors the lookupSku debounce used elsewhere); reset the
  // highlighted row when the committed query changes (done in the timeout
  // callback, not synchronously in the effect body).
  useEffect(() => {
    const t = window.setTimeout(() => { setQ(raw.trim()); setActive(0); }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [raw]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const results = useMemo(() => {
    const needle = q.toLowerCase();
    if (!needle) return ITEM_SEARCH;
    return ITEM_SEARCH.filter(
      (r) =>
        r.particulars.toLowerCase().includes(needle) ||
        (r.item_group ?? "").toLowerCase().includes(needle),
    );
  }, [q]);

  if (!open) return null;

  function commit(idx: number) {
    const item = results[idx];
    if (item) onPick(item);
  }
  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    if (e.key === "Enter") { e.preventDefault(); commit(active); }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-[rgba(6,12,20,.55)] flex items-start justify-center pt-[12vh] px-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-[560px] bg-white border border-[var(--aws-border)] rounded-[13px] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Search items"
      >
        <div className="flex items-center gap-[9px] px-[15px] py-[13px] border-b border-[var(--aws-border)]">
          <span className="text-[var(--text-muted)]">⌕</span>
          <input
            ref={inputRef}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search item by name or group…"
            aria-label="Item name"
            role="combobox"
            aria-expanded
            aria-controls="ledger-item-list"
            aria-activedescendant={results[active] ? `ledger-item-${results[active].sku_id}` : undefined}
            className="flex-1 outline-none text-[15px] text-[var(--text-primary)] bg-transparent"
          />
        </div>
        <div className="font-mono text-[10px] text-[var(--text-muted)] px-[15px] py-[6px] bg-[var(--surface-subtle)] border-b border-[var(--aws-border)] flex justify-between">
          <span>List of Stock Items — {results.length} matches</span>
          <span>filter: name · group</span>
        </div>
        <div id="ledger-item-list" role="listbox" aria-label="Stock items" className="max-h-[300px] overflow-auto p-[5px]">
          {results.length === 0 && (
            <div className="px-[11px] py-4 text-[12.5px] text-[var(--text-muted)]">No items match “{q}”.</div>
          )}
          {results.map((r, i) => (
            <button
              key={r.sku_id}
              id={`ledger-item-${r.sku_id}`}
              role="option"
              aria-selected={i === active}
              type="button"
              onMouseEnter={() => setActive(i)}
              onClick={() => commit(i)}
              className={`w-full flex justify-between gap-[10px] items-center px-[11px] py-[7px] rounded-[8px] text-[12.5px] text-left ${
                i === active ? "bg-[#9a393e14] shadow-[inset_2px_0_0_var(--aws-orange)]" : "hover:bg-[var(--surface-subtle)]"
              }`}
            >
              <span className="text-[var(--text-primary)]">{highlight(r.particulars, q)}</span>
              <span className="font-mono text-[10px] text-[var(--text-muted)] flex gap-[8px] items-center whitespace-nowrap">
                <span className="uppercase">{r.item_type} · {r.item_group}</span>
                <span className={r.closing_qty < 0 ? "text-[var(--aws-error)]" : ""}>
                  {fmtQty(r.closing_qty, 2)} {r.uom_class}
                </span>
              </span>
            </button>
          ))}
        </div>
        <div className="flex gap-[14px] px-[15px] py-[8px] border-t border-[var(--aws-border)] font-mono text-[10px] text-[var(--text-muted)] bg-[var(--surface-subtle)]">
          <span>↑↓ navigate</span><span>↵ open ledger</span><span>esc close</span>
        </div>
      </div>
    </div>
  );
}
