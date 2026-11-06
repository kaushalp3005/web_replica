"use client";

// Type-ahead combobox for a table cell: a plain text input that stays free
// text, plus a listbox of server suggestions the operator can pick from.
//
// Shared by the BOM module form and the plan-builder's inline BOM editor.
//
// Why the listbox is a PORTAL: the BOM form's line and route tables sit inside
// `overflow-x-auto` wrappers, and an absolutely-positioned menu inside one is
// clipped at the table's edge — the first three suggestions show and the rest
// are cut off with no scrollbar. So the menu renders into document.body with
// `position: fixed` at the input's current rectangle, and closes on any scroll
// or resize rather than trying to track the input around.
//
// Free text is kept on purpose. all_sku is incomplete (new articles land in
// Tally first) and the process list is just "what other BOMs used", so the
// value the operator typed is what gets saved unless they pick a suggestion.
// `onChange` fires on every keystroke; `onPick` only when a row is chosen.

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { SEARCH_DEBOUNCE_MS } from "@/lib/constants";

type Rect = { top: number; left: number; width: number; maxHeight: number };

export function SearchSelect<T>({
  value,
  onChange,
  onPick,
  load,
  getKey,
  getLabel,
  renderOption,
  className,
  placeholder,
  ariaLabel,
  minChars = 1,
  emptyText = "No matches",
  menuWidth = 420,
}: {
  value: string;
  onChange: (text: string) => void;
  onPick: (option: T) => void;
  /** Fetch suggestions for a query. Called debounced; abort the previous one. */
  load: (q: string, signal: AbortSignal) => Promise<T[]>;
  getKey: (option: T) => string;
  getLabel: (option: T) => string;
  renderOption?: (option: T) => ReactNode;
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
  /** Query length below which nothing is fetched. 0 = fetch on open with an empty query. */
  minChars?: number;
  emptyText?: string;
  menuWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const [rect, setRect] = useState<Rect | null>(null);
  const [searched, setSearched] = useState<string | null>(null);   // last query answered
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Only search after the operator TYPES (or asks with ArrowDown). Mounting a
  // row with an existing value must not fire a request per line.
  const wantRef = useRef(false);
  const listId = useId();

  // The menu wants `menuWidth` but is clamped to the viewport: on a phone it
  // shrinks to the screen and slides left so its right edge stays visible, and
  // its height is capped to what remains below the input.
  function place() {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(Math.max(r.width, menuWidth), vw - 16);
    const left = Math.max(8, Math.min(r.left, vw - width - 8));
    const maxHeight = Math.max(120, Math.min(260, vh - r.bottom - 12));
    setRect({ top: r.bottom + 2, left, width, maxHeight });
  }

  async function run(q: string) {
    abortRef.current?.abort();
    if (q.length < minChars) {
      setOptions([]);
      setSearched(null);
      setLoading(false);
      return;
    }
    const c = new AbortController();
    abortRef.current = c;
    setLoading(true);
    setFailed(null);
    try {
      const rows = await load(q, c.signal);
      if (c.signal.aborted) return;
      setOptions(rows);
      setSearched(q);
      setActive(rows.length ? 0 : -1);
      place();
    } catch (e: unknown) {
      if (c.signal.aborted) return;
      setOptions([]);
      setFailed(e instanceof Error ? e.message : "Lookup failed");
    } finally {
      if (!c.signal.aborted) setLoading(false);
    }
  }

  // Debounced fetch on typing. All state changes happen inside the timeout
  // callback, never synchronously in the effect body.
  useEffect(() => {
    if (!open || !wantRef.current) return;
    const t = window.setTimeout(() => {
      void run(value.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
    // run() closes over props that are stable for the life of the cell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, open]);

  // The menu is fixed-positioned, so any scroll or resize would leave it
  // floating away from its input. Close instead of chasing it.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  useEffect(() => () => abortRef.current?.abort(), []);

  function pick(opt: T) {
    abortRef.current?.abort();
    setOpen(false);
    setOptions([]);
    setSearched(null);
    onPick(opt);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) {
        wantRef.current = true;
        setOpen(true);
        place();
        void run(value.trim());
        return;
      }
      if (options.length) setActive((a) => (a + 1) % options.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (options.length) setActive((a) => (a <= 0 ? options.length - 1 : a - 1));
    } else if (e.key === "Enter") {
      if (open && active >= 0 && options[active] !== undefined) {
        e.preventDefault();
        pick(options[active]);
      } else if (open) {
        // Keep the free text; just dismiss the menu. Let the form submit
        // only when no menu is showing.
        e.preventDefault();
        setOpen(false);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    }
  }

  const showMenu = open && rect != null && (loading || failed != null || options.length > 0 || searched != null);
  const activeId = active >= 0 && options[active] !== undefined ? `${listId}-${active}` : undefined;

  return (
    <>
      <input
        ref={inputRef}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showMenu}
        aria-controls={listId}
        aria-activedescendant={activeId}
        aria-label={ariaLabel}
        className={className}
        placeholder={placeholder}
        value={value}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          wantRef.current = true;
          if (!open) {
            setOpen(true);
            place();
          }
          onChange(e.target.value);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // Let a click on an option land first (its mousedown keeps focus
          // here via preventDefault, so this only fires on a real blur).
          window.setTimeout(() => setOpen(false), 120);
        }}
      />
      {showMenu && typeof document !== "undefined"
        ? createPortal(
            <ul
              id={listId}
              role="listbox"
              aria-label={ariaLabel ? `${ariaLabel} suggestions` : "Suggestions"}
              style={{ position: "fixed", top: rect.top, left: rect.left, width: rect.width, maxHeight: rect.maxHeight, zIndex: 60 }}
              className="overflow-y-auto rounded-sm border border-[var(--aws-border-strong)] bg-white shadow-lg text-[11px]"
            >
              {loading && options.length === 0 ? (
                <li className="px-2 py-1.5 text-[var(--text-muted)] italic">Searching…</li>
              ) : null}
              {failed ? (
                <li role="alert" className="px-2 py-1.5 text-[var(--aws-error)]">{failed}</li>
              ) : null}
              {!loading && !failed && options.length === 0 && searched != null ? (
                <li className="px-2 py-1.5 text-[var(--text-muted)] italic">{emptyText}</li>
              ) : null}
              {options.map((o, i) => (
                <li
                  key={getKey(o)}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(o)}
                  className={[
                    "flex items-center gap-2 px-2 py-1 cursor-pointer whitespace-nowrap",
                    i === active ? "bg-[var(--surface-subtle)] text-[var(--aws-navy)]" : "text-[var(--text-primary)]",
                  ].join(" ")}
                >
                  {renderOption ? renderOption(o) : <span className="truncate">{getLabel(o)}</span>}
                </li>
              ))}
            </ul>,
            document.body,
          )
        : null}
    </>
  );
}
