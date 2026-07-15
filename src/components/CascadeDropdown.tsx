"use client";

// Searchable single-select dropdown for a cascade level (material type → item
// category → sub category → particulars). Lifted out of sample/_form.tsx so both
// the Sample article picker and the Customer-Returns line editor share one
// implementation. A dropdown menu (not a native <select>) so the open panel can
// list every value and highlight the chosen one; click-away is a transparent
// fixed backdrop beneath the panel (z-10 < z-20) — no document listener, so
// there's no mousedown/click ordering race that could swallow the opening click.

import { useState } from "react";

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M5 10l3.5 3.5L15 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CascadeDropdown({ label, value, options, onChange, disabled, placeholder }: {
  label: string; value: string; options: string[];
  onChange: (v: string) => void; disabled?: boolean; placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  function choose(v: string) { setQuery(""); setOpen(false); onChange(v); }

  const q = query.trim().toLowerCase();
  // De-duplicate — the SKU master can return the same name twice (e.g. two
  // "Cashew Paste" rows), which would collide on the React list key and show a
  // duplicate row. Collapse to distinct values, preserving first-seen order.
  const uniqueOptions = Array.from(new Set(options));
  const filtered = q ? uniqueOptions.filter((o) => o.toLowerCase().includes(q)) : uniqueOptions;
  const shown = filtered.slice(0, 200); // cap the DOM for the (potentially huge) particulars list

  return (
    <div className="relative">
      <span className="block text-[11px] font-semibold text-[var(--text-secondary)] mb-1">{label}</span>
      <button
        type="button" disabled={disabled} onClick={() => setOpen((o) => !o)}
        className={`form-input flex w-full items-center justify-between gap-2 text-left ${value ? "!border-[var(--aws-orange)] text-[var(--text-primary)] font-medium" : "text-[var(--text-muted)]"}`}
      >
        <span className="truncate">{value || placeholder}</span>
        <svg viewBox="0 0 20 20" className={`w-3.5 h-3.5 shrink-0 opacity-60 transition-transform ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M5 7l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <>
          <button
            type="button" aria-hidden tabIndex={-1}
            className="fixed inset-0 z-10 cursor-default" onClick={() => setOpen(false)}
          />
          <div className="absolute z-20 mt-1 w-full bg-white border border-[var(--aws-border-strong)] rounded-[2px] shadow-md">
            <div className="p-1.5 border-b border-[var(--surface-divider)]">
              <input
                autoFocus className="form-input h-7 text-[12px]" placeholder={`Search ${label.toLowerCase()}…`}
                value={query} onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <ul className="max-h-56 overflow-auto py-1">
              {value && (
                <li>
                  <button type="button" onClick={() => choose("")}
                    className="block w-full text-left px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)]">
                    Clear selection
                  </button>
                </li>
              )}
              {shown.map((o) => {
                const sel = o === value;
                return (
                  <li key={o}>
                    <button
                      type="button" onClick={() => choose(o)}
                      className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-[13px] ${sel ? "bg-[var(--surface-subtle)] text-[var(--aws-orange)] font-semibold" : "hover:bg-[var(--surface-subtle)]"}`}
                    >
                      <span className="truncate">{o}</span>
                      {sel && <CheckIcon />}
                    </button>
                  </li>
                );
              })}
              {shown.length === 0 && <li className="px-3 py-2 text-[12px] text-[var(--text-muted)]">{options.length === 0 ? "No options yet." : "No matches."}</li>}
              {filtered.length > shown.length && (
                <li className="px-3 py-1 text-[11px] text-[var(--text-muted)]">+{filtered.length - shown.length} more — keep typing to narrow.</li>
              )}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
