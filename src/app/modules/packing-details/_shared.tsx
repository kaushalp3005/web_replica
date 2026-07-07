"use client";

// Small presentational helpers shared across the Packing Details pages.

export function LoadingCard() {
  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[var(--text-secondary)]">
      <span className="inline-flex items-center gap-2 text-[13px]">
        <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
        Loading…
      </span>
    </div>
  );
}

export function EmptyCard({ message }: { message: string }) {
  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[13px] text-[var(--text-secondary)]">
      {message}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="text-[12px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-2">
      {message}
    </div>
  );
}

// Live preview of the JSON body that will be embedded as `details`.
export function JsonPreview({ value }: { value: unknown }) {
  return (
    <pre className="mt-2 bg-[var(--surface-subtle)] border border-[var(--surface-divider)] rounded p-2 overflow-x-auto text-[11px] leading-4 text-[var(--text-primary)] font-mono">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

// One-line summary of a details JSON object for the list table.
export function detailSummary(details: Record<string, unknown> | null | undefined): string {
  const keys = details && typeof details === "object" ? Object.keys(details) : [];
  if (keys.length === 0) return "—";
  const preview = keys.slice(0, 3).join(", ");
  const suffix = keys.length > 3 ? "…" : "";
  return `${keys.length} key${keys.length > 1 ? "s" : ""}: ${preview}${suffix}`;
}
