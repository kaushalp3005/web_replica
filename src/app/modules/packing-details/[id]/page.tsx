"use client";

// Packing Details — view / edit / delete a single record. Loads by id, hydrates
// the block editor from the stored details JSON, saves via PATCH, deletes via
// DELETE. Mirrors the sample [id] page's useParams pattern.

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { BackLink } from "@/components/BackLink";
import {
  type PackingDetail,
  getPackingDetail,
  updatePackingDetail,
  deletePackingDetail,
} from "@/lib/packing-details";
import { PackingChrome } from "../_chrome";
import { LoadingCard, ErrorBanner, JsonPreview, fmtDate } from "../_shared";
import { BlockEditor, blocksToDetails, blocksError, detailsToBlocks, type Block } from "../_BlockEditor";
import { QrLabel } from "../_QrLabel";

export default function PackingDetailPage(): React.JSX.Element {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const authed = useRequireAuth(router.replace);

  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    queueMicrotask(() => setMounted(true));
  }, []);

  const [record, setRecord] = useState<PackingDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Editable form state.
  const [batchCode, setBatchCode] = useState("");
  const [articleName, setArticleName] = useState("");
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const preview = useMemo(() => blocksToDetails(blocks), [blocks]);

  useEffect(() => {
    if (!mounted || !authed) return;
    const c = new AbortController();
    // All setState calls live inside the async IIFE (not the effect body) so
    // react-hooks/set-state-in-effect stays quiet — matches qc/parameters.
    void (async () => {
      if (!Number.isFinite(id)) {
        setError("Invalid packing id.");
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const r = await getPackingDetail(id);
        if (c.signal.aborted) return;
        setRecord(r);
        setBatchCode(r.batch_code);
        setArticleName(r.article_name);
        setBlocks(detailsToBlocks(r.details));
      } catch (e) {
        if (c.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Failed to load packing detail");
      } finally {
        if (!c.signal.aborted) setLoading(false);
      }
    })();
    return () => c.abort();
  }, [mounted, authed, id]);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    if (!batchCode.trim()) return setError("Batch code is required.");
    if (!articleName.trim()) return setError("Article name is required.");
    const be = blocksError(blocks);
    if (be) return setError(be);

    setSaving(true);
    try {
      const updated = await updatePackingDetail(id, {
        batch_code: batchCode.trim(),
        article_name: articleName.trim(),
        details: blocksToDetails(blocks),
      });
      setRecord(updated);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update packing detail");
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (typeof window !== "undefined" && !window.confirm(`Delete packing detail #${id}? This cannot be undone.`)) {
      return;
    }
    setError(null);
    setDeleting(true);
    try {
      await deletePackingDetail(id);
      router.push("/modules/packing-details");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete packing detail");
      setDeleting(false);
    }
  }

  if (!mounted) {
    return (
      <PackingChrome title="Detail">
        <LoadingCard />
      </PackingChrome>
    );
  }
  if (!authed) return <></>;

  return (
    <PackingChrome title={record ? `#${record.packing_id}` : "Detail"}>
      <div className="mb-3">
        <BackLink parentHref="/modules/packing-details" label="Packing Details" />
      </div>

      {loading ? (
        <LoadingCard />
      ) : error && !record ? (
        <ErrorBanner message={error} />
      ) : record ? (
        <>
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">
                Packing detail #{record.packing_id}
              </h1>
              <p className="text-[12px] text-[var(--text-secondary)] mt-1">
                Created by {record.created_by ?? "—"} · {fmtDate(record.created_at)} · Updated {fmtDate(record.updated_at)}
              </p>
            </div>
            <button
              onClick={onDelete}
              disabled={deleting}
              className="h-9 px-4 rounded border border-rose-300 text-rose-700 text-[13px] font-medium hover:bg-rose-50 disabled:opacity-40 whitespace-nowrap"
            >
              {deleting ? "Deleting…" : "Delete"}
            </button>
          </div>

          <form onSubmit={onSave} className="max-w-[860px] space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1">
                  Batch code <span className="text-[var(--aws-error)]">*</span>
                </label>
                <input value={batchCode} onChange={(e) => setBatchCode(e.target.value)} className="form-input" />
              </div>
              <div>
                <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1">
                  Article name <span className="text-[var(--aws-error)]">*</span>
                </label>
                <input value={articleName} onChange={(e) => setArticleName(e.target.value)} className="form-input" />
              </div>
            </div>

            <div>
              <h2 className="text-[13px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide mb-2">
                Details (blocks)
              </h2>
              <BlockEditor blocks={blocks} onChange={setBlocks} />
              <div className="mt-3">
                <span className="text-[11px] text-[var(--text-muted)]">Embedded JSON body</span>
                <JsonPreview value={preview} />
              </div>
            </div>

            {error && <ErrorBanner message={error} />}
            {saved && !error && (
              <div className="text-[12px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-3 py-2">
                Saved.
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={saving}
                className="h-9 px-4 rounded bg-[var(--aws-orange)] text-white text-[13px] font-medium hover:bg-[var(--aws-orange-hover)] disabled:opacity-40"
              >
                {saving ? "Saving…" : "Save changes"}
              </button>
              <button
                type="button"
                onClick={() => router.push("/modules/packing-details")}
                className="h-9 px-4 rounded border border-[var(--aws-border-strong)] bg-white text-[13px] font-medium hover:bg-[var(--surface-subtle)]"
              >
                Back to list
              </button>
            </div>
          </form>

          {/* QR uses the SAVED batch code (what the public scan looks up),
              not the unsaved form value. */}
          <QrLabel batchCode={record.batch_code} articleName={record.article_name} />
        </>
      ) : null}
    </PackingChrome>
  );
}
