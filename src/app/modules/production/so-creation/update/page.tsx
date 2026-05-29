"use client";

// SO Update via Excel. Mirrors
// frontend_replica/src/modules/production/so-creation/so-update.html +
// so-update.js. Operator uploads a revised .xlsx, backend returns a
// per-SO diff payload, operator selects which SOs to actually apply,
// then confirms — backend writes the changes for the selected so_ids.

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import {
  confirmSoUpdate,
  previewSoUpdate,
  type SoLineChange,
  type SoUpdateChange,
  type SoUpdatePreviewItem,
  type SoUpdatePreviewResponse,
} from "@/lib/so";
import { SoChrome } from "../_chrome";

export default function SoUpdatePage() {
  const router = useRouter();
  useRequireAuth(router.replace);

  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<SoUpdatePreviewResponse | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  async function onFileChosen(file: File) {
    if (!/\.xlsx?$/i.test(file.name)) { setError("Only .xlsx / .xls files are accepted."); return; }
    if (file.size > 50 * 1024 * 1024) { setError("File too large — max 50 MB."); return; }
    setError(null); setSuccess(null);
    setUploading(true);
    try {
      const p = await previewSoUpdate(file);
      setPreview(p);
      // All SOs with changes selected by default — same as so-update.js.
      setSelected(new Set((p.changes ?? []).map((c) => c.so_id)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Preview failed.");
      setPreview(null);
    } finally {
      setUploading(false);
    }
  }

  function toggle(soId: number) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(soId)) next.delete(soId); else next.add(soId);
      return next;
    });
  }
  function selectAll() {
    setSelected(new Set((preview?.changes ?? []).map((c) => c.so_id)));
  }
  function selectNone() { setSelected(new Set()); }

  async function onConfirm() {
    if (!preview) return;
    if (selected.size === 0) { setError("Select at least one SO to update."); return; }
    setError(null);
    setConfirming(true);
    try {
      const r = await confirmSoUpdate(preview.file_hash, [...selected]);
      setSuccess(`Updated ${r.updated_count ?? selected.size} SO${selected.size === 1 ? "" : "s"}.`);
      setPreview(null);
      setSelected(new Set());
      setTimeout(() => router.push("/modules/production/so-creation"), 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed.");
    } finally {
      setConfirming(false);
    }
  }

  function reset() {
    setPreview(null); setSelected(new Set()); setError(null); setSuccess(null);
  }

  return (
    <SoChrome title="Update via Excel" showBackToSoCreation>
      <div className="mb-5">
        <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">Update SOs via Excel</h1>
        <p className="text-[13px] text-[var(--text-secondary)] mt-1">
          Upload a revised Sales Register to preview what would change. Nothing is written until you confirm.
        </p>
      </div>

      {preview == null ? (
        <div className="mb-5">
          <div
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) void onFileChosen(f); }}
            className={[
              "bg-white border-2 border-dashed rounded-md p-6 text-center cursor-pointer transition",
              drag ? "border-[var(--aws-orange)] bg-[#fef3e6]" : "border-[var(--aws-border-strong)] hover:border-[var(--aws-navy)]",
            ].join(" ")}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFileChosen(f); e.target.value = ""; }}
            />
            <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" className="mx-auto text-[var(--text-muted)] mb-2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <p className="text-[14px] font-semibold text-[var(--text-primary)]">Drop your updated Sales Register here</p>
            <p className="text-[12px] text-[var(--text-secondary)] mt-1">or click to browse — <strong>.xlsx / .xls</strong></p>
          </div>
          {uploading ? (
            <div className="mt-2 text-[12px] text-[var(--text-secondary)] flex items-center gap-2">
              <span className="inline-block w-3 h-3 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
              Building preview…
            </div>
          ) : null}
          {error ? <p className="mt-2 text-[12px] text-[var(--aws-error)]">{error}</p> : null}
          {success ? <p className="mt-2 text-[12px] text-[var(--text-success)]">{success}</p> : null}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            <Summary label="In File"    value={preview.total_in_file   ?? 0} />
            <Summary label="Unchanged" value={preview.unchanged_count ?? 0} />
            <Summary label="Changed"   value={preview.changed_count   ?? 0} accent="#a35200" />
            <Summary label="Not Found" value={preview.not_found_so_numbers?.length ?? 0} accent="#b1361e" />
          </div>

          {preview.not_found_so_numbers && preview.not_found_so_numbers.length > 0 ? (
            <div className="bg-[#fdf3f1] border border-[#f0c7be] rounded-md p-3 mb-4">
              <div className="text-[12px] font-semibold text-[#b1361e] mb-1">SOs not found in the database</div>
              <div className="text-[12px] text-[var(--text-secondary)] font-mono">
                {preview.not_found_so_numbers.join(", ")}
              </div>
            </div>
          ) : null}

          {(preview.changes?.length ?? 0) > 0 ? (
            <>
              <div className="mb-3 flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <button type="button" onClick={selectAll}  disabled={confirming} className="h-7 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]">Select all</button>
                  <button type="button" onClick={selectNone} disabled={confirming} className="h-7 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]">Clear</button>
                  <button type="button" onClick={reset}      disabled={confirming} className="h-7 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]">Re-upload</button>
                </div>
                <span className="text-[12px] text-[var(--text-secondary)]">
                  <strong>{selected.size}</strong> of {preview.changes?.length ?? 0} selected
                </span>
              </div>

              <div className="space-y-3 mb-5">
                {(preview.changes ?? []).map((item) => (
                  <ChangeCard
                    key={item.so_id}
                    item={item}
                    checked={selected.has(item.so_id)}
                    onToggle={() => toggle(item.so_id)}
                    disabled={confirming}
                  />
                ))}
              </div>

              <div className="sticky bottom-0 bg-white border border-[var(--aws-border)] rounded-md shadow-[0_-2px_6px_rgba(0,28,36,0.10)] p-3 flex items-center justify-between gap-3 mb-6">
                <span className="text-[13px] text-[var(--text-secondary)]"><strong>{selected.size}</strong> of {preview.changes?.length ?? 0} selected</span>
                <div className="flex items-center gap-3">
                  {error ? <span className="text-[12px] text-[var(--aws-error)]">{error}</span> : null}
                  {success ? <span className="text-[12px] text-[var(--text-success)]">{success}</span> : null}
                  <button
                    type="button"
                    onClick={onConfirm}
                    disabled={confirming || selected.size === 0}
                    className={[
                      "h-9 px-4 rounded-[2px] text-[13px] font-bold border tracking-wide",
                      confirming || selected.size === 0
                        ? "bg-[#f2c399] border-[#f2c399] cursor-not-allowed text-[var(--text-primary)]"
                        : "bg-gradient-to-b from-[#f7dfa5] to-[#f0c14b] border-[#a88734] hover:from-[#f5d78e] hover:to-[#eeb933] text-[var(--text-primary)]",
                    ].join(" ")}
                  >
                    {confirming ? "Updating…" : "Confirm update"}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[var(--text-secondary)]">
              <p className="font-semibold text-[14px] mb-1">No changes detected</p>
              <p className="text-[12px]">The uploaded file matches the SOs already in the database.</p>
              <button type="button" onClick={reset} className="mt-3 h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]">
                Re-upload
              </button>
            </div>
          )}
        </>
      )}
    </SoChrome>
  );
}

function Summary({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md p-3" style={accent ? { borderLeft: `3px solid ${accent}` } : undefined}>
      <div className="text-[11px] uppercase tracking-wide font-semibold text-[var(--text-secondary)]">{label}</div>
      <div className="text-[22px] font-semibold text-[var(--text-primary)] mt-1 leading-none">{value}</div>
    </div>
  );
}

function ChangeCard({
  item, checked, onToggle, disabled,
}: { item: SoUpdatePreviewItem; checked: boolean; onToggle: () => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const headerCount = item.header_changes?.length ?? 0;
  const modified = (item.line_changes ?? []).filter((c) => c.change_type === "modified").length;
  const added    = (item.line_changes ?? []).filter((c) => c.change_type === "added").length;
  const removed  = (item.line_changes ?? []).filter((c) => c.change_type === "removed").length;

  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)]">
      <div className="p-3 flex items-center gap-3">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          disabled={disabled}
          className="accent-[var(--aws-orange)] w-4 h-4"
          aria-label={`Select SO ${item.so_number}`}
        />
        <div className="flex-1 min-w-0">
          <div className="font-mono text-[12px] text-[var(--aws-link)] font-semibold truncate" title={item.so_number ?? ""}>
            {item.so_number ?? `SO #${item.so_id}`}
          </div>
          <div className="text-[11px] text-[var(--text-secondary)] mt-0.5 flex flex-wrap gap-2">
            {headerCount > 0 ? <Badge tone="warning">{headerCount} header change{headerCount === 1 ? "" : "s"}</Badge> : null}
            {modified > 0 ? <Badge tone="info">{modified} modified</Badge> : null}
            {added > 0 ? <Badge tone="ok">{added} added</Badge> : null}
            {removed > 0 ? <Badge tone="err">{removed} removed</Badge> : null}
          </div>
        </div>
        <button type="button" onClick={() => setOpen((v) => !v)} className="h-7 px-2 text-[12px] text-[var(--aws-link)] hover:underline">
          {open ? "Hide" : "Details"}
        </button>
      </div>
      {open ? (
        <div className="border-t border-[var(--aws-border)] p-3 bg-[var(--surface-subtle)]">
          {headerCount > 0 ? (
            <Diff title="Header changes" rows={item.header_changes ?? []} />
          ) : null}
          {(item.line_changes ?? []).map((lc, i) => (
            <LineChange key={i} change={lc} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone: "ok" | "warning" | "info" | "err" }) {
  const palette: Record<typeof tone, { bg: string; fg: string; ring: string }> = {
    ok:      { bg: "#eaf6ed", fg: "var(--text-success)", ring: "#b6dbb1" },
    warning: { bg: "#fef3e6", fg: "#a35200", ring: "#f5d6a8" },
    info:    { bg: "#eaf3ff", fg: "var(--aws-link)", ring: "#bbd9f3" },
    err:     { bg: "#fdf3f1", fg: "#b1361e", ring: "#f0c7be" },
  };
  const p = palette[tone];
  return (
    <span className="inline-block text-[10px] px-1.5 py-0.5 rounded-sm capitalize" style={{ background: p.bg, color: p.fg, border: `1px solid ${p.ring}` }}>
      {children}
    </span>
  );
}

function Diff({ title, rows }: { title: string; rows: SoUpdateChange[] }) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="text-[11px] uppercase tracking-wide font-semibold text-[var(--text-secondary)] mb-1">{title}</div>
      <table className="w-full text-[12px] border-collapse">
        <thead className="bg-white">
          <tr className="border-b border-[var(--aws-border)]">
            <th className="px-2 py-1 text-left">Field</th>
            <th className="px-2 py-1 text-left">Current</th>
            <th className="px-2 py-1 text-left">→</th>
            <th className="px-2 py-1 text-left">New</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-[var(--aws-border)] bg-white">
              <td className="px-2 py-1 font-semibold">{r.field}</td>
              <td className="px-2 py-1 text-[var(--text-muted)]">{String(r.old_value ?? "—")}</td>
              <td className="px-2 py-1 text-[var(--text-muted)]">→</td>
              <td className="px-2 py-1">{String(r.new_value ?? "—")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LineChange({ change }: { change: SoLineChange }) {
  return (
    <div className="mt-3 first:mt-0">
      <div className="text-[11px] uppercase tracking-wide font-semibold text-[var(--text-secondary)] mb-1">
        Line {change.line_number ?? "—"} · {change.sku_name || "—"} · <Badge tone={change.change_type === "added" ? "ok" : change.change_type === "removed" ? "err" : "info"}>{change.change_type}</Badge>
      </div>
      {(change.changes ?? []).length > 0 ? <Diff title="Field diff" rows={change.changes ?? []} /> : null}
    </div>
  );
}
