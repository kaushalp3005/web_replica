"use client";

// Packing Details — list page. Batch/article filters, a records table with
// row actions (view/edit, delete), a "New" CTA, and a collapsible encrypted-
// batch lookup panel (mint token → fetch by token). Mirrors the QC pages'
// shell: PackingChrome + useRequireAuth + the `mounted` hydration gate.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { BackLink } from "@/components/BackLink";
import {
  type PackingDetail,
  listPackingDetails,
  deletePackingDetail,
  mintBatchToken,
  fetchByEncryptedBatch,
} from "@/lib/packing-details";
import { PackingChrome } from "./_chrome";
import { LoadingCard, EmptyCard, ErrorBanner, fmtDate, detailSummary } from "./_shared";

export default function PackingDetailsPage(): React.JSX.Element {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);

  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    queueMicrotask(() => setMounted(true));
  }, []);

  const [items, setItems] = useState<PackingDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter inputs vs applied filters (Apply commits the inputs).
  const [batchInput, setBatchInput] = useState("");
  const [articleInput, setArticleInput] = useState("");
  const [applied, setApplied] = useState<{ batch_code?: string; article_name?: string }>({});

  useEffect(() => {
    if (!mounted || !authed) return;
    const c = new AbortController();
    // setState lives inside the async IIFE (not the effect body) — mirrors the
    // qc/parameters pattern and keeps react-hooks/set-state-in-effect quiet.
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await listPackingDetails({ ...applied, limit: 200 });
        if (c.signal.aborted) return;
        setItems(res);
      } catch (e) {
        if (c.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Failed to load packing details");
        setItems([]);
      } finally {
        if (!c.signal.aborted) setLoading(false);
      }
    })();
    return () => c.abort();
  }, [mounted, authed, applied]);

  async function onDelete(id: number) {
    if (typeof window !== "undefined" && !window.confirm(`Delete packing detail #${id}? This cannot be undone.`)) {
      return;
    }
    setError(null);
    try {
      await deletePackingDetail(id);
      setItems((prev) => prev.filter((p) => p.packing_id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete packing detail");
    }
  }

  if (!mounted) {
    return (
      <PackingChrome title="Packing Details">
        <LoadingCard />
      </PackingChrome>
    );
  }
  if (!authed) return <></>;

  return (
    <PackingChrome title="Packing Details">
      <div className="mb-3">
        <BackLink parentHref="/modules" label="Modules" />
      </div>

      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">Packing Details</h1>
          <p className="text-[13px] text-[var(--text-secondary)] mt-1">
            Batch-level packing records. Each record carries a free-form details body built from blocks.
          </p>
        </div>
        <button
          onClick={() => router.push("/modules/packing-details/new")}
          className="h-9 px-4 rounded bg-[var(--aws-orange)] text-white text-[13px] font-medium hover:bg-[var(--aws-orange-hover)] whitespace-nowrap"
        >
          + New packing detail
        </button>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <div>
          <label className="block text-[11px] text-[var(--text-secondary)] mb-1">Batch code</label>
          <input value={batchInput} onChange={(e) => setBatchInput(e.target.value)} placeholder="e.g. B-001" className="form-input w-[180px]" />
        </div>
        <div>
          <label className="block text-[11px] text-[var(--text-secondary)] mb-1">Article name</label>
          <input value={articleInput} onChange={(e) => setArticleInput(e.target.value)} placeholder="e.g. Roasted Almonds 200g" className="form-input w-[240px]" />
        </div>
        <button
          onClick={() => setApplied({ batch_code: batchInput.trim() || undefined, article_name: articleInput.trim() || undefined })}
          className="h-9 px-4 rounded border border-[var(--aws-border-strong)] bg-white text-[13px] font-medium hover:bg-[var(--surface-subtle)]"
        >
          Apply
        </button>
        <button
          onClick={() => {
            setBatchInput("");
            setArticleInput("");
            setApplied({});
          }}
          className="h-9 px-3 rounded text-[13px] text-[var(--aws-link)] hover:underline"
        >
          Clear
        </button>
      </div>

      {error && (
        <div className="mb-3">
          <ErrorBanner message={error} />
        </div>
      )}

      {loading ? (
        <LoadingCard />
      ) : items.length === 0 ? (
        <EmptyCard message="No packing details found." />
      ) : (
        <div className="overflow-x-auto bg-white border border-[var(--aws-border)] rounded">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-[var(--surface-subtle)] text-left text-[12px] font-semibold text-[var(--text-secondary)]">
                <th className="px-3 py-2">ID</th>
                <th className="px-3 py-2">Batch</th>
                <th className="px-3 py-2">Article</th>
                <th className="px-3 py-2">Details</th>
                <th className="px-3 py-2">Created by</th>
                <th className="px-3 py-2">Created</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.packing_id} className="border-t border-[var(--surface-divider)] hover:bg-[var(--surface-subtle)]">
                  <td className="px-3 py-2 font-medium">{p.packing_id}</td>
                  <td className="px-3 py-2">{p.batch_code}</td>
                  <td className="px-3 py-2">{p.article_name}</td>
                  <td className="px-3 py-2 text-[var(--text-secondary)]">{detailSummary(p.details)}</td>
                  <td className="px-3 py-2 text-[var(--text-secondary)]">{p.created_by ?? "—"}</td>
                  <td className="px-3 py-2 text-[var(--text-secondary)]">{fmtDate(p.created_at)}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button
                      onClick={() => router.push(`/modules/packing-details/${p.packing_id}`)}
                      className="px-2 py-0.5 text-[11px] border border-[var(--aws-border)] rounded hover:border-[var(--aws-orange)]"
                    >
                      View / Edit
                    </button>
                    <button
                      onClick={() => onDelete(p.packing_id)}
                      className="ml-2 px-2 py-0.5 text-[11px] border border-rose-300 text-rose-700 rounded hover:bg-rose-50"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <EncryptedBatchPanel />
    </PackingChrome>
  );
}

// ── Encrypted batch lookup panel ────────────────────────────────────────────
function EncryptedBatchPanel() {
  const [open, setOpen] = useState(false);
  const [batch, setBatch] = useState("");
  const [token, setToken] = useState("");
  const [results, setResults] = useState<PackingDetail[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function mint() {
    setBusy(true);
    setErr(null);
    setResults(null);
    try {
      const r = await mintBatchToken(batch.trim());
      setToken(r.batch_token);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to mint token");
    } finally {
      setBusy(false);
    }
  }

  async function fetchIt() {
    setBusy(true);
    setErr(null);
    setResults(null);
    try {
      const r = await fetchByEncryptedBatch(token.trim());
      setResults(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to fetch by token");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8 border border-[var(--aws-border)] rounded bg-white">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
      >
        <span className="text-[13px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide">
          Encrypted batch lookup
        </span>
        <span className="text-[var(--text-muted)]">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-[var(--surface-divider)] pt-3">
          <p className="text-[12px] text-[var(--text-secondary)]">
            Mint an AES-256-GCM token for a batch, then fetch its records via the encrypted endpoint — the
            plaintext batch never travels, only the token.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className="block text-[11px] text-[var(--text-secondary)] mb-1">Batch code</label>
              <input value={batch} onChange={(e) => setBatch(e.target.value)} placeholder="B-001" className="form-input w-[200px]" />
            </div>
            <button
              onClick={mint}
              disabled={busy || !batch.trim()}
              className="h-9 px-4 rounded border border-[var(--aws-border-strong)] bg-white text-[13px] font-medium hover:bg-[var(--surface-subtle)] disabled:opacity-40"
            >
              Mint token
            </button>
          </div>

          {token && (
            <div>
              <label className="block text-[11px] text-[var(--text-secondary)] mb-1">Batch token</label>
              <div className="flex flex-wrap gap-2">
                <input
                  readOnly
                  value={token}
                  onFocus={(e) => e.currentTarget.select()}
                  className="form-input flex-1 min-w-[220px] font-mono text-[11px]"
                />
                <button
                  onClick={() => navigator.clipboard?.writeText(token)}
                  className="h-9 px-3 rounded border border-[var(--aws-border-strong)] bg-white text-[12px] hover:bg-[var(--surface-subtle)]"
                >
                  Copy
                </button>
                <button
                  onClick={fetchIt}
                  disabled={busy}
                  className="h-9 px-4 rounded bg-[var(--aws-orange)] text-white text-[13px] font-medium hover:bg-[var(--aws-orange-hover)] disabled:opacity-40"
                >
                  Fetch by token
                </button>
              </div>
            </div>
          )}

          {err && <ErrorBanner message={err} />}

          {results && (
            <div className="text-[12px]">
              <p className="text-[var(--text-secondary)] mb-1">{results.length} record(s) returned:</p>
              <pre className="bg-[var(--surface-subtle)] border border-[var(--surface-divider)] rounded p-2 overflow-x-auto text-[11px] font-mono">
                {JSON.stringify(results, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
