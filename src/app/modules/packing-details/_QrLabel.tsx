"use client";

// QR label for a packing record. Mints the AES-GCM batch token (authed), builds
// the public landing URL, renders a scannable QR, and prints an isolated label.
// Scanning opens the candorfoods.in (Wix) page, which calls the backend's
// public /packing-details/public/scan endpoint to show this batch's blocks.

import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { mintBatchToken } from "@/lib/packing-details";
import { ErrorBanner } from "./_shared";

// Public landing page base (Wix). Override per-env with NEXT_PUBLIC_QR_LANDING_URL;
// the encrypted batch token is appended as ?t=<token>.
const LANDING_BASE =
  process.env.NEXT_PUBLIC_QR_LANDING_URL || "https://www.candorfoods.in/packing";

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string),
  );
}

export function QrLabel({ batchCode, articleName }: { batchCode: string; articleName: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const { batch_token } = await mintBatchToken(batchCode);
      const sep = LANDING_BASE.includes("?") ? "&" : "?";
      setUrl(`${LANDING_BASE}${sep}t=${encodeURIComponent(batch_token)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate QR");
    } finally {
      setBusy(false);
    }
  }

  function printLabel() {
    if (!url) return;
    // qrcode.react renders a self-contained <svg> (inline viewBox + paths), so
    // its outerHTML prints correctly in an isolated window — no global CSS.
    const svg = document.querySelector("#packing-qr-svg svg");
    if (!svg) return;
    const w = window.open("", "_blank", "width=460,height=620");
    if (!w) return;
    w.document.write(
      `<!doctype html><html><head><meta charset="utf-8"><title>Packing QR — ${escapeHtml(batchCode)}</title>` +
        `<style>*{margin:0;padding:0;box-sizing:border-box}` +
        `body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;text-align:center;padding:28px}` +
        `.qr{width:280px;height:280px;margin:0 auto}.qr svg{width:100%;height:100%}` +
        `.code{font-size:20px;font-weight:700;margin-top:16px;letter-spacing:.5px}` +
        `.art{font-size:13px;color:#444;margin-top:4px}.hint{font-size:10px;color:#999;margin-top:14px}` +
        `@media print{@page{margin:8mm}}</style></head><body>` +
        `<div class="qr">${svg.outerHTML}</div>` +
        `<div class="code">${escapeHtml(batchCode)}</div>` +
        `<div class="art">${escapeHtml(articleName)}</div>` +
        `<div class="hint">Scan to view packing details</div>` +
        `<script>window.onload=function(){window.focus();window.print();setTimeout(function(){window.close()},400)}<\/script>` +
        `</body></html>`,
    );
    w.document.close();
  }

  return (
    <section className="mt-8 border border-[var(--aws-border)] rounded bg-white p-4">
      <h2 className="text-[13px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide mb-1">QR label</h2>
      <p className="text-[12px] text-[var(--text-secondary)] mb-3">
        Encodes <span className="font-mono">{LANDING_BASE}?t=&lt;encrypted batch token&gt;</span>. Scanning opens the
        public page that shows this batch&apos;s block details.
      </p>
      {!url ? (
        <button
          onClick={generate}
          disabled={busy}
          className="h-9 px-4 rounded bg-[var(--aws-orange)] text-white text-[13px] font-medium hover:bg-[var(--aws-orange-hover)] disabled:opacity-40"
        >
          {busy ? "Generating…" : "Generate QR"}
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-5">
          <div id="packing-qr-svg" className="p-3 bg-white border border-[var(--surface-divider)] rounded">
            <QRCodeSVG value={url} size={168} level="M" marginSize={2} />
          </div>
          <div className="min-w-[200px]">
            <div className="text-[16px] font-semibold text-[var(--text-primary)]">{batchCode}</div>
            <div className="text-[12px] text-[var(--text-secondary)]">{articleName}</div>
            <div className="mt-3 flex gap-2">
              <button
                onClick={printLabel}
                className="h-9 px-4 rounded bg-[var(--aws-orange)] text-white text-[13px] font-medium hover:bg-[var(--aws-orange-hover)]"
              >
                Print label
              </button>
              <button
                onClick={generate}
                disabled={busy}
                className="h-9 px-3 rounded border border-[var(--aws-border-strong)] bg-white text-[13px] hover:bg-[var(--surface-subtle)]"
              >
                Regenerate
              </button>
            </div>
            <div className="mt-2 text-[10px] text-[var(--text-muted)] break-all font-mono">{url}</div>
          </div>
        </div>
      )}
      {error && (
        <div className="mt-3">
          <ErrorBanner message={error} />
        </div>
      )}
    </section>
  );
}
