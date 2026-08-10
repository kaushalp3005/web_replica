"use client";

// Packing Details — create page. batch_code + article_name + a block-built
// details JSON body, with a live JSON preview of what will be embedded.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { BackLink } from "@/components/BackLink";
import { createPackingDetail } from "@/lib/packing-details";
import { PackingChrome } from "../_chrome";
import { LoadingCard, ErrorBanner, JsonPreview } from "../_shared";
import { BlockEditor, blocksToDetails, blocksError, type Block } from "../_BlockEditor";

export default function NewPackingDetailPage(): React.JSX.Element {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);

  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    queueMicrotask(() => setMounted(true));
  }, []);

  const [batchCode, setBatchCode] = useState("");
  const [articleName, setArticleName] = useState("");
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preview = useMemo(() => blocksToDetails(blocks), [blocks]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!batchCode.trim()) return setError("Batch code is required.");
    if (!articleName.trim()) return setError("Article name is required.");
    const be = blocksError(blocks);
    if (be) return setError(be);

    setSaving(true);
    try {
      const created = await createPackingDetail({
        batch_code: batchCode.trim(),
        article_name: articleName.trim(),
        details: blocksToDetails(blocks),
      });
      router.push(`/modules/packing-details/${created.packing_id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create packing detail");
      setSaving(false);
    }
  }

  if (!mounted) {
    return (
      <PackingChrome title="New">
        <LoadingCard />
      </PackingChrome>
    );
  }
  if (!authed) return <></>;

  return (
    <PackingChrome title="New">
      <div className="mb-3">
        <BackLink parentHref="/modules/packing-details" label="Packing Details" />
      </div>

      <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">New packing detail</h1>
      <p className="text-[13px] text-[var(--text-secondary)] mt-1 mb-5">
        Add the batch and article, then build the details body from blocks.
      </p>

      <form onSubmit={onSubmit} className="max-w-[860px] space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1">
              Batch code <span className="text-[var(--aws-error)]">*</span>
            </label>
            <input value={batchCode} onChange={(e) => setBatchCode(e.target.value)} placeholder="B-001" className="form-input" />
          </div>
          <div>
            <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1">
              Article name <span className="text-[var(--aws-error)]">*</span>
            </label>
            <input value={articleName} onChange={(e) => setArticleName(e.target.value)} placeholder="Roasted Almonds 200g" className="form-input" />
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

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={saving}
            className="h-9 px-4 rounded bg-[var(--aws-orange)] text-white text-[13px] font-medium hover:bg-[var(--aws-orange-hover)] disabled:opacity-40"
          >
            {saving ? "Saving…" : "Create"}
          </button>
          <button
            type="button"
            onClick={() => router.push("/modules/packing-details")}
            className="h-9 px-4 rounded border border-[var(--aws-border-strong)] bg-white text-[13px] font-medium hover:bg-[var(--surface-subtle)]"
          >
            Cancel
          </button>
        </div>
      </form>
    </PackingChrome>
  );
}
