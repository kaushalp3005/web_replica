"use client";

// Browse-by-drill-down picker for a material / article: the same four
// dependent dropdowns the Sample / PO / Customer-Returns article pickers use
// (material type → item category → sub category → particulars), over the same
// endpoint (/api/v1/so/sku-lookup) and the same CascadeDropdown primitive, so
// an operator who knows that picker finds nothing new here.
//
// Shared by the BOM module form and the plan-builder's inline BOM editor on
// SO Creation. It complements the SearchSelect type-ahead rather than replacing
// it: search is faster when the name is known; browse is how you find an
// article whose name you don't. Picking a particular resolves it through a
// second lookup to get its canonical name and item_type, then hands both up —
// the form sets the line's rm/pm/sfg from the type when it is one of those.
//
// Rendered through a portal into document.body, OUTSIDE the BOM <form>: the
// cascade's own search boxes are plain inputs, and Enter in one of them would
// otherwise submit the whole BOM.
//
// Material type offers rm / pm / sfg / fg explicitly. sku-lookup leaves sfg out
// of its own type list unless asked, and fg must stay available because hamper
// BOMs carry finished goods as rm components.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CascadeDropdown } from "@/components/CascadeDropdown";
import { lookupSku, type SkuLookupResponse } from "@/lib/so";

export type BrowsedMaterial = {
  particulars: string;
  item_type: string | null;
  sku_id: number | null;
};

const TYPE_OPTIONS = ["rm", "pm", "sfg", "fg"];

export function MaterialBrowser({
  initialType,
  lineLabel,
  onPick,
  onClose,
}: {
  /** The line's current type; browsing starts scoped to it. */
  initialType?: string;
  lineLabel: string;
  onPick: (m: BrowsedMaterial) => void;
  onClose: () => void;
}) {
  const [itemType, setItemType] = useState(() =>
    initialType && TYPE_OPTIONS.includes(initialType) ? initialType : "",
  );
  const [itemGroup, setItemGroup] = useState("");
  const [subGroup, setSubGroup] = useState("");
  const [particulars, setParticulars] = useState("");
  const [opts, setOpts] = useState<NonNullable<SkuLookupResponse["options"]>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  // Options refresh whenever an upstream key changes. Deferred to a microtask
  // (react-hooks/set-state-in-effect); cleanup aborts the in-flight request so
  // a fast operator never sees stale options land.
  useEffect(() => {
    const c = new AbortController();
    ctrl.current = c;
    queueMicrotask(() => {
      if (c.signal.aborted) return;
      setLoading(true);
      lookupSku(
        { item_type: itemType || undefined, item_group: itemGroup || undefined, sub_group: subGroup || undefined },
        c.signal,
      ).then(
        (r) => {
          if (c.signal.aborted) return;
          setOpts(r.options ?? {});
          setError(null);
          setLoading(false);
        },
        (e: unknown) => {
          if (c.signal.aborted) return;   // superseded, not failed
          setOpts({});
          setError(e instanceof Error ? e.message : "Couldn't load the article master");
          setLoading(false);
        },
      );
    });
    return () => c.abort();
  }, [itemType, itemGroup, subGroup]);

  // Close on Escape — the cascade panels handle their own click-away.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The particulars option only carries a name; resolve it to its sku_id and
  // canonical type through a second lookup pinned to the chosen filters.
  async function choose(name: string) {
    setParticulars(name);
    if (!name) return;
    setBusy(true);
    try {
      const r = await lookupSku({
        particulars: name,
        item_type: itemType || undefined,
        item_group: itemGroup || undefined,
        sub_group: subGroup || undefined,
      });
      const sel = r.selected_item;
      onPick({
        particulars: sel?.particulars ?? name,
        item_type: sel?.item_type ?? (itemType || null),
        sku_id: sel?.sku_id != null ? Number(sel.sku_id) : null,
      });
    } catch {
      // The name is still a valid pick; only the type confirmation failed.
      onPick({ particulars: name, item_type: itemType || null, sku_id: null });
    } finally {
      setBusy(false);
    }
  }

  const count = opts.particulars?.length ?? 0;

  if (typeof document === "undefined") return null;
  // Width is clamped inline as well as by max-w: the card must fit a phone
  // viewport whatever utilities the CSS build happens to contain.
  return createPortal(
    <div className="fixed inset-0 z-[70] overflow-y-auto overflow-x-hidden bg-black/40">
      <div className="flex min-h-full items-start justify-center p-3 sm:py-10">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="bom-browse-title"
        className="w-full min-w-0 max-w-[980px] bg-white rounded-lg shadow-xl border border-[var(--aws-border)]"
        style={{ maxWidth: "min(980px, calc(100vw - 24px))" }}
      >
        <header className="flex items-start justify-between gap-3 px-5 py-3 border-b border-[var(--aws-border)]">
          <div className="min-w-0">
            <h2 id="bom-browse-title" className="text-[15px] font-semibold text-[var(--text-primary)]">
              Browse articles
            </h2>
            <p className="text-[11px] text-[var(--text-secondary)] break-words">
              For {lineLabel} · narrow with the dropdowns, then pick a particular.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--surface-subtle)] text-[var(--text-secondary)]"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        {/* min-h so an open cascade panel (max-h-56) never pokes out of the card.
            The four dropdowns go 1 → 2 → 4 across as the viewport allows; each
            cell is min-w-0 so a long category name can never widen the card. */}
        <div className="px-4 sm:px-5 py-4 min-h-[340px] min-w-0">
          {error ? (
            <p role="alert" className="mb-3 text-[12px] text-[var(--aws-error)]">
              Couldn&apos;t load the article master — {error}
            </p>
          ) : null}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 min-w-0">
            <div className="min-w-0">
            <CascadeDropdown
              label="Material type"
              value={itemType}
              options={TYPE_OPTIONS}
              disabled={busy}
              placeholder="Any type…"
              onChange={(v) => {
                setItemType(v);
                setItemGroup("");
                setSubGroup("");
                setParticulars("");
              }}
            />
            </div>
            <div className="min-w-0">
            <CascadeDropdown
              label="Item category"
              value={itemGroup}
              options={opts.item_groups ?? []}
              disabled={busy}
              placeholder="Select item category…"
              onChange={(v) => {
                setItemGroup(v);
                setSubGroup("");
                setParticulars("");
              }}
            />
            </div>
            <div className="min-w-0">
            <CascadeDropdown
              label="Sub category"
              value={subGroup}
              options={opts.sub_groups ?? []}
              disabled={busy}
              placeholder="Select sub category…"
              onChange={(v) => {
                setSubGroup(v);
                setParticulars("");
              }}
            />
            </div>
            <div className="min-w-0">
            <CascadeDropdown
              label="Particulars"
              value={particulars}
              options={opts.particulars ?? []}
              disabled={busy || loading}
              placeholder={loading ? "Loading…" : busy ? "Picking…" : "Select article…"}
              onChange={choose}
            />
            </div>
          </div>
          <p className="mt-3 text-[11px] text-[var(--text-muted)] break-words">
            {loading
              ? "Loading options…"
              : `${count.toLocaleString("en-IN")} article${count === 1 ? "" : "s"} match the current filters` +
                (itemType ? "" : " (SFG articles appear once a material type is chosen)") +
                ". Picking one also sets the line's type when it is RM, PM or SFG."}
          </p>
        </div>

        <footer className="flex items-center justify-end gap-2 px-4 sm:px-5 py-3 border-t border-[var(--aws-border)]">
          <button
            type="button"
            onClick={onClose}
            className="text-[13px] rounded-md px-3 py-1.5 bg-white border border-[var(--aws-border-strong)] text-[var(--text-primary)] hover:border-[var(--aws-navy)]"
          >
            Cancel
          </button>
        </footer>
      </div>
      </div>
    </div>,
    document.body,
  );
}
