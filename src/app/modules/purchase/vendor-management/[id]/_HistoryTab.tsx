"use client";

// History pane (spec §3F) — op filter, timeline entries with from→to diff
// tables, and revert (update/approve only) with the migration-030 /
// history_not_found / forbidden error branches.

import { useEffect, useState } from "react";
import {
  listVendorHistory,
  revertHistory,
  VendorApiError,
  type VendorHistoryEntry,
  type VendorHistoryListResponse,
} from "@/lib/vendor";
import {
  Badge,
  CARD_CLS,
  errMsg,
  fmtDate,
  GHOST_BTN,
  INPUT_CLS,
  LABEL_CLS,
  Modal,
  PRIMARY_BTN,
  SECONDARY_BTN,
  SELECT_CLS,
  type ShowToast,
} from "./_shared";

const OP_OPTIONS = [
  { value: "", label: "All operations" },
  { value: "create", label: "create" },
  { value: "update", label: "update" },
  { value: "approve", label: "approve" },
  { value: "delete", label: "delete" },
  { value: "revert", label: "revert" },
];

function formatDiffValue(v: unknown): string {
  if (v === null) return "∅";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v != null && typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

export function HistoryTab({
  vendorId,
  active,
  reloadNonce,
  showToast,
  onReloadVendor,
}: {
  vendorId: string;
  active: boolean;
  reloadNonce: number;
  showToast: ShowToast;
  onReloadVendor: () => Promise<void>;
}): React.JSX.Element {
  const [entries, setEntries] = useState<VendorHistoryEntry[]>([]);
  const [opFilter, setOpFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [errText, setErrText] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [revertTarget, setRevertTarget] = useState<VendorHistoryEntry | null>(null);

  // Lazy-load on first activation; re-fetch on op-filter change, Refresh, or a
  // parent-signalled reload (e.g. after an edit while this tab is open).
  useEffect(() => {
    if (!active) return;
    let live = true;
    (async () => {
      setLoading(true);
      setErrText(null);
      try {
        const data = await listVendorHistory(vendorId, opFilter || undefined, { page: 1, pageSize: 50 });
        const raw: unknown = data;
        const list: VendorHistoryEntry[] = Array.isArray(raw)
          ? (raw as VendorHistoryEntry[])
          : ((raw as VendorHistoryListResponse).entries ??
            (raw as { items?: VendorHistoryEntry[] }).items ??
            []);
        if (live) setEntries(list);
      } catch (e) {
        if (!live) return;
        setEntries([]);
        if (e instanceof VendorApiError && (e.status === 404 || e.code === "endpoint_not_found")) {
          setErrText("History endpoint not available yet — apply migration 030 and restart the server.");
        } else {
          setErrText(`Couldn't load history — ${errMsg(e, "unknown error")}`);
        }
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [active, vendorId, opFilter, refreshTick, reloadNonce]);

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">Change history</h3>
        <Badge tone="neutral">{entries.length}</Badge>
        <div className="flex-1" />
        <select value={opFilter} onChange={(e) => setOpFilter(e.target.value)} aria-label="Filter by operation" className={SELECT_CLS}>
          {OP_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button type="button" className={GHOST_BTN} onClick={() => setRefreshTick((t) => t + 1)}>
          Refresh
        </button>
      </div>

      {loading ? (
        <div className={`${CARD_CLS} p-6 text-center text-[13px] text-[var(--text-secondary)]`}>
          <span className="inline-flex items-center gap-2">
            <span className="inline-block w-3.5 h-3.5 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
            Loading history…
          </span>
        </div>
      ) : errText ? (
        <div className={`${CARD_CLS} p-6 text-[13px] text-[var(--aws-error)]`} role="alert">
          {errText}
        </div>
      ) : entries.length === 0 ? (
        <div className={`${CARD_CLS} p-6 text-center`}>
          <div className="text-[14px] font-semibold text-[var(--text-primary)]">No history yet</div>
          <div className="text-[12px] text-[var(--text-secondary)] mt-1">Changes to this vendor will appear here.</div>
        </div>
      ) : (
        <div className="space-y-3">
          {entries.map((e) => (
            <HistoryEntryCard key={e.history_id} entry={e} onRevert={setRevertTarget} />
          ))}
        </div>
      )}

      {revertTarget && (
        <RevertModal
          vendorId={vendorId}
          entry={revertTarget}
          showToast={showToast}
          onClose={() => setRevertTarget(null)}
          onReverted={async () => {
            setRevertTarget(null);
            await onReloadVendor();
            setRefreshTick((t) => t + 1);
          }}
        />
      )}
    </div>
  );
}

// ── Timeline entry ───────────────────────────────────────────────────────────

function HistoryEntryCard({
  entry,
  onRevert,
}: {
  entry: VendorHistoryEntry;
  onRevert?: (entry: VendorHistoryEntry) => void;
}): React.JSX.Element {
  const op = (entry.operation || "update").toLowerCase();
  const when = fmtDate(entry.changed_at);
  const by = entry.changed_by || "system";
  const source = entry.source;
  const showSource = !!source && source !== "manual";
  const canRevert = op === "update" || op === "approve";

  const diff = entry.diff || {};
  const fields = Object.keys(diff);

  return (
    <article className={`${CARD_CLS} p-4`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-[var(--text-primary)] capitalize">{op}</span>
        {showSource ? <Badge tone="neutral">{source}</Badge> : null}
        <span className="text-[12px] text-[var(--text-secondary)]">· {when}</span>
        <span className="text-[12px] text-[var(--text-muted)]">· {by}</span>
        {entry.reason ? <span className="text-[12px] text-[var(--text-secondary)] italic">· &ldquo;{entry.reason}&rdquo;</span> : null}
        {onRevert && canRevert ? (
          <>
            <span className="flex-1" />
            <button type="button" className={GHOST_BTN} onClick={() => onRevert(entry)}>
              Revert this change
            </button>
          </>
        ) : null}
      </div>

      <div className="mt-3">
        {fields.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)]">
                  <th className="px-2 py-1 font-semibold">Field</th>
                  <th className="px-2 py-1 font-semibold">Previous</th>
                  <th className="px-2 py-1 font-semibold">New</th>
                </tr>
              </thead>
              <tbody>
                {fields.map((k) => (
                  <tr key={k} className="border-t border-[var(--aws-border)]">
                    <td className="px-2 py-1 text-[var(--text-secondary)]">{k}</td>
                    <td className="px-2 py-1 font-mono text-[var(--text-primary)] break-all">{formatDiffValue(diff[k]?.from)}</td>
                    <td className="px-2 py-1 font-mono text-[var(--text-primary)] break-all">{formatDiffValue(diff[k]?.to)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : op === "create" ? (
          <p className="text-[12px] text-[var(--text-secondary)]">Initial creation via {source || "system"}.</p>
        ) : (
          <p className="text-[12px] text-[var(--text-muted)]">No field-level changes recorded.</p>
        )}
      </div>
    </article>
  );
}

// ── Revert modal ─────────────────────────────────────────────────────────────

function RevertModal({
  vendorId,
  entry,
  showToast,
  onClose,
  onReverted,
}: {
  vendorId: string;
  entry: VendorHistoryEntry;
  showToast: ShowToast;
  onClose: () => void;
  onReverted: () => Promise<void>;
}): React.JSX.Element {
  const [reason, setReason] = useState("");
  const [reverting, setReverting] = useState(false);

  async function handleRevert() {
    if (reverting) return;
    setReverting(true);
    try {
      await revertHistory(vendorId, entry.history_id, reason.trim() || null);
      showToast("Reverted — refreshing…", "ok");
      await onReverted();
    } catch (e) {
      const code = e instanceof VendorApiError ? e.code : null;
      if (code === "forbidden") showToast("Only admins can revert history.", "error");
      else if (code === "history_not_found") showToast("History entry was deleted.", "error");
      else showToast(`Couldn't revert — ${errMsg(e, "unknown error")}`, "error");
    } finally {
      setReverting(false);
    }
  }

  const footer = (
    <>
      <button type="button" className={SECONDARY_BTN} onClick={onClose} disabled={reverting}>
        Cancel
      </button>
      <button type="button" className={PRIMARY_BTN} onClick={() => void handleRevert()} disabled={reverting}>
        {reverting ? "Reverting…" : "Revert"}
      </button>
    </>
  );

  return (
    <Modal title="Revert to this snapshot" onClose={onClose} size="md" titleId="vd-revert-title" footer={footer}>
      <p className="text-[12px] text-[var(--text-secondary)] mb-3 leading-relaxed">
        This applies the snapshot&rsquo;s previous state as a fresh patch. The current state is preserved in history —
        nothing is destroyed.
      </p>
      {/* Preview: the same entry card with the revert action stripped. */}
      <HistoryEntryCard entry={entry} />
      <div className="mt-4">
        <label htmlFor="rv-reason" className={LABEL_CLS}>
          Why are you reverting?
        </label>
        <input
          id="rv-reason"
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className={`${INPUT_CLS} w-full`}
        />
      </div>
    </Modal>
  );
}
