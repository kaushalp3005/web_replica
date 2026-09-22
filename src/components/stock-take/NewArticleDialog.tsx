"use client";

// Stock take's "add an article not in this list" picker: Search, Browse (type →
// category → sub category → article) or Not in catalogue, plus the Off grade
// line. Moved here from stock-take/adjust so Stores → Production Indents' manual
// sticker print picks articles the same way; the title and intro default to
// stock take's wording.
//
// Escape closes only this picker. It is opened over other dialogs (the Scan
// material dialog) that close on Escape and trap Tab from a document listener,
// so while it is open this one takes both keys in the capture phase and stops
// them there; Tab still moves focus as usual.

import { useEffect, useRef, useState } from "react";
import { lookupSku, type SkuLookupResponse } from "@/lib/so";

const FIELD =
  "h-9 w-full px-3 text-[14px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] disabled:bg-[#f5f5f5] disabled:text-[var(--text-secondary)]";
const LABEL = "block text-[12px] font-medium text-[var(--text-primary)] mb-1";

/** all_sku.particulars has NO UNIQUE constraint and 23 names are genuinely
 *  duplicated (same text, different sku_id — a re-imported block), so every list
 *  built from the catalogue must be deduped before it becomes React keys.
 *  Rendering them raw produced "two children with the same key" for each one.
 *  Selection is unaffected: choose() resolves by particulars and the server
 *  already picks a single sku_id for an ambiguous name. */
const uniq = (xs?: string[]): string[] => Array.from(new Set(xs ?? []));

/** The article chosen, with the four descriptors the catalogue (or the operator) gave. */
export interface PickedArticle {
  item_name: string;
  material_type: string;
  item_category: string;
  item_subcategory: string;
  /** "Fresh Stock", or "Off Grade/Rejection" for the article's off-grade line. */
  stock_type: string;
  sku_id: number | null;
  /** True when entered under Not in catalogue. */
  is_new_article: boolean;
}

/** For stock the floor holds that has never been counted here.
 *
 *  Search and Browse mirror the legacy RTVLineEditor over /api/v1/so/sku-lookup;
 *  the third path is free entry, which RTV has no equivalent for. All four
 *  descriptors are required — the Stock Take app's own custom-item path sends
 *  blanks and its backend stamps GENERAL/OTHER over them, losing what the
 *  operator chose. */
export function NewArticleDialog({
  onCancel, onPick,
  title = "Add an article not in this list",
  intro = "For stock on your floor that has never been counted here.",
}: {
  onCancel: () => void; onPick: (a: PickedArticle) => void;
  title?: string; intro?: string;
}) {
  const [tab, setTab] = useState<"search" | "browse" | "free">("search");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<string[]>([]);
  const [opts, setOpts] = useState<NonNullable<SkuLookupResponse["options"]>>({});
  const [itemType, setItemType] = useState("");
  const [group, setGroup] = useState("");
  const [sub, setSub] = useState("");
  const [free, setFree] = useState({ name: "", type: "", cat: "", sub: "" });
  const [err, setErr] = useState<string | null>(null);
  // Off grade is a SEPARATE LINE for the same article, not a property of it:
  // identity is the name plus the stock type, and 233 articles already exist as
  // both. So this picks which of the two lines the posting lands on.
  const [offGrade, setOffGrade] = useState(false);
  const stockType = offGrade ? "Off Grade/Rejection" : "Fresh Stock";
  const boxRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef(onCancel);
  useEffect(() => { cancelRef.current = onCancel; }, [onCancel]);

  // Focus starts inside the picker; Escape closes the picker alone, and Tab is
  // kept from a dialog underneath (its trap would pull focus behind the picker).
  useEffect(() => {
    boxRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Tab") { e.stopImmediatePropagation(); return; }
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      cancelRef.current();
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => {
    if (tab !== "search" || q.trim().length < 2) return;
    const c = new AbortController();
    const t = setTimeout(() => {
      lookupSku({ search: q.trim() }, c.signal).then(
        (r) => { setHits(r.options?.particulars ?? []); setErr(null); },
        (e: Error) => { if (!c.signal.aborted) setErr(e.message); },
      );
    }, 300);
    return () => { clearTimeout(t); c.abort(); };
  }, [q, tab]);

  useEffect(() => {
    const c = new AbortController();
    lookupSku(
      { item_type: itemType || undefined, item_group: group || undefined, sub_group: sub || undefined },
      c.signal,
    ).then((r) => setOpts(r.options ?? {}), () => {});
    return () => c.abort();
  }, [itemType, group, sub]);

  // Derived rather than cleared in the effect — a short query shows nothing
  // without a setState in the guard (react-hooks/set-state-in-effect).
  const visibleHits = q.trim().length >= 2 ? uniq(hits) : [];

  async function choose(name: string) {
    const r = await lookupSku({ particulars: name });
    const s = r.selected_item;
    if (!s) return;
    onPick({
      item_name: String(s.particulars ?? "").trim(),
      material_type: String(s.item_type ?? ""),
      item_category: String(s.item_group ?? ""),
      item_subcategory: String(s.sub_group ?? ""),
      stock_type: stockType,
      sku_id: s.sku_id != null ? Number(s.sku_id) : null,
      is_new_article: false,
    });
  }

  const freeOk = free.name.trim() && free.type.trim() && free.cat.trim() && free.sub.trim();

  return (
    <div className="fixed inset-0 bg-black/45 flex items-stretch md:items-center justify-center md:p-4 z-50"
         onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      {/* Full screen below md, the same centred 560px card from md up. The
          picker is taller than a phone once the results list or the soft
          keyboard is up, so the body scrolls rather than being clipped with
          Cancel/Continue out of reach. */}
      <div ref={boxRef} tabIndex={-1}
           className="bg-white md:rounded-md w-full md:max-w-[560px] flex flex-col max-h-screen md:max-h-[90vh] overflow-hidden outline-none"
           role="dialog" aria-modal="true" aria-label={title}>
        <div className="overflow-y-auto p-4 sm:p-5">
          <h3 className="text-[16px] font-semibold text-[var(--text-primary)] mb-1">{title}</h3>
          <p className="text-[12px] text-[var(--text-secondary)] mb-3">{intro}</p>

          <label className="flex flex-wrap sm:flex-nowrap items-center gap-x-2 gap-y-1 mb-3 text-[13px] text-[var(--text-primary)] cursor-pointer select-none">
            <input type="checkbox" checked={offGrade} onChange={(e) => setOffGrade(e.target.checked)}
                   className="h-4 w-4 accent-[#a8500a]" />
            <span>Off grade / rejection</span>
            <span className="basis-full sm:basis-auto text-[11px] text-[var(--text-secondary)]">
              — records against the article&rsquo;s off-grade line, keeping the same name
            </span>
          </label>

          <div className="flex w-full sm:inline-flex sm:w-auto rounded-[2px] border border-[var(--aws-border-strong)] overflow-hidden mb-3">
            {(["search", "browse", "free"] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)}
                      className={`flex-1 sm:flex-none whitespace-nowrap px-2 sm:px-3 h-8 text-[13px] ${tab === t ? "bg-[var(--aws-navy)] text-white" : "bg-white hover:bg-[#fafafa]"}`}>
                {t === "search" ? "Search" : t === "browse" ? "Browse" : "Not in catalogue"}
              </button>
            ))}
          </div>

          {err && <p className="mb-2 text-[12px] text-[#d13212]">{err}</p>}

          {tab === "search" && (
            <>
              <input className={FIELD} value={q} onChange={(e) => setQ(e.target.value)}
                     placeholder="Type at least 2 characters" aria-label="Search articles" />
              {visibleHits.length > 0 && (
                <ul className="mt-2 max-h-56 overflow-y-auto border border-[var(--aws-border)] rounded-[2px] divide-y divide-[var(--aws-border)]">
                  {visibleHits.slice(0, 50).map((n) => (
                    <li key={n}>
                      <button onClick={() => choose(n)} className="w-full text-left px-3 py-2 text-[13px] hover:bg-[#fafafa]">{n}</button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {tab === "browse" && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div>
                  <label className={LABEL}>Material type</label>
                  <select className={FIELD} value={itemType}
                          onChange={(e) => { setItemType(e.target.value); setGroup(""); setSub(""); }}>
                    <option value="">All</option>
                    {uniq(opts.item_types).map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                <div>
                  <label className={LABEL}>Category</label>
                  <select className={FIELD} value={group}
                          onChange={(e) => { setGroup(e.target.value); setSub(""); }}>
                    <option value="">All</option>
                    {uniq(opts.item_groups).map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                <div>
                  <label className={LABEL}>Sub category</label>
                  <select className={FIELD} value={sub} onChange={(e) => setSub(e.target.value)}>
                    <option value="">All</option>
                    {uniq(opts.sub_groups).map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
              </div>
              <div className="mt-3">
                <label className={LABEL}>Article</label>
                <select className={FIELD} value="" onChange={(e) => { if (e.target.value) void choose(e.target.value); }}>
                  <option value="">Select an article…</option>
                  {uniq(opts.particulars).map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            </>
          )}

          {tab === "free" && (
            <>
              <div className="mb-2">
                <label className={LABEL}>Article name</label>
                <input className={FIELD} value={free.name} onChange={(e) => setFree({ ...free, name: e.target.value })} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div>
                  <label className={LABEL}>Material type</label>
                  <input className={FIELD} list="dl-type" value={free.type}
                         onChange={(e) => setFree({ ...free, type: e.target.value })} />
                  <datalist id="dl-type">{uniq(opts.item_types).map((o) => <option key={o} value={o} />)}</datalist>
                </div>
                <div>
                  <label className={LABEL}>Category</label>
                  <input className={FIELD} list="dl-cat" value={free.cat}
                         onChange={(e) => setFree({ ...free, cat: e.target.value })} />
                  <datalist id="dl-cat">{uniq(opts.item_groups).map((o) => <option key={o} value={o} />)}</datalist>
                </div>
                <div>
                  <label className={LABEL}>Sub category</label>
                  <input className={FIELD} list="dl-sub" value={free.sub}
                         onChange={(e) => setFree({ ...free, sub: e.target.value })} />
                  <datalist id="dl-sub">{uniq(opts.sub_groups).map((o) => <option key={o} value={o} />)}</datalist>
                </div>
              </div>
              <p className="text-[11px] text-[var(--text-muted)] mt-2">All four are required and stored exactly as entered.</p>
            </>
          )}

          <div className="flex gap-2 justify-end mt-4">
            <button onClick={onCancel} className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[14px]">Cancel</button>
            {tab === "free" && (
              <button disabled={!freeOk}
                      onClick={() => onPick({
                        item_name: free.name.trim(), material_type: free.type.trim(),
                        item_category: free.cat.trim(), item_subcategory: free.sub.trim(),
                        stock_type: stockType, sku_id: null, is_new_article: true,
                      })}
                      className="h-9 px-4 rounded-[2px] bg-[var(--aws-orange)] text-white text-[14px] font-medium disabled:opacity-40">
                Continue
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
