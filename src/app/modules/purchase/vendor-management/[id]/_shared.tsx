"use client";

// Vendor Detail — shared primitives (modal skeleton, toast, confirm, selects,
// display helpers, badges, file chips, expiry cell). Extracted so the five tab
// files stay focused on their own behaviour. Styling mirrors the existing
// vendor-management/existing page and the Material-In modal skeleton.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  dash,
  fmtVendorDate,
  s3UrlBasename,
  s3UrlsToArray,
  VendorApiError,
  type LookupRow,
} from "@/lib/vendor";

// ── Reusable class idioms (match the surrounding pages) ──────────────────────

export const CARD_CLS =
  "bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)]";
export const INPUT_CLS =
  "h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] bg-white disabled:opacity-50";
export const SELECT_CLS = INPUT_CLS;
export const GHOST_BTN =
  "h-7 px-2.5 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] disabled:opacity-50 disabled:cursor-not-allowed";
export const PRIMARY_BTN =
  "h-8 px-4 text-[13px] rounded-[2px] border border-[var(--aws-navy)] bg-[var(--aws-navy)] text-white hover:bg-[#0e2847] disabled:opacity-50 disabled:cursor-not-allowed";
export const SECONDARY_BTN =
  "h-8 px-4 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] disabled:opacity-50 disabled:cursor-not-allowed";
export const PRIMARY_DANGER_BTN =
  "h-8 px-4 text-[13px] rounded-[2px] border border-[var(--aws-error)] bg-[var(--aws-error)] text-white hover:brightness-95 disabled:opacity-50 disabled:cursor-not-allowed";
export const DANGER_BTN =
  "h-7 px-2.5 text-[12px] rounded-[2px] border border-[#f5c6bc] text-[var(--aws-error)] bg-white hover:bg-[#fdf3f1] disabled:opacity-50 disabled:cursor-not-allowed";
export const LABEL_CLS = "block text-[11px] font-semibold text-[var(--text-primary)] mb-1";

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** yyyy-mm-dd (timestamps collapse to date); null → "—"; unparseable → raw. */
export const fmtDate = fmtVendorDate;

/** Coerce an unknown column value to a lookup id (string) or null. */
export function asId(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** Coerce an unknown column value to a display string. */
export function asStr(v: unknown): string {
  return v == null ? "" : String(v);
}

/** First 10 chars — trims a datetime down to a <input type="date"> value. */
export function slice10(v: unknown): string {
  return v == null ? "" : String(v).slice(0, 10);
}

/** Friendly message from any thrown error. */
export function errMsg(e: unknown, fallback: string): string {
  if (e instanceof VendorApiError) return e.message || fallback;
  if (e instanceof Error) return e.message || fallback;
  return fallback;
}

// ── Badges (de-facto palette shared across web_replica list pages) ───────────

export type Tone = "success" | "warning" | "danger" | "neutral" | "info";
const TONE_CLS: Record<Tone, string> = {
  success: "bg-[#eaf6ed] text-[var(--text-success)] border border-[#b6dbb1]",
  warning: "bg-[#fbe7d6] text-[#9a5b00] border border-[#f0cfa0]",
  danger: "bg-[#fbeced] text-[var(--aws-error)] border border-[#f0c0c4]",
  neutral: "bg-[var(--surface-disabled)] text-[var(--text-secondary)] border border-[var(--aws-border)]",
  info: "bg-[#eaf0fb] text-[#2c5fa8] border border-[#c3d4f0]",
};

export function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }): React.JSX.Element {
  return (
    <span className={`inline-flex items-center h-5 px-2 text-[11px] font-semibold rounded-[2px] ${TONE_CLS[tone]}`}>
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: unknown }): React.JSX.Element {
  const s = typeof status === "string" ? status : "";
  if (s === "active") return <Badge tone="success">Active</Badge>;
  if (s === "inactive") return <Badge tone="warning">Inactive</Badge>;
  if (s === "blacklisted") return <Badge tone="danger">Blacklisted</Badge>;
  return <Badge tone="neutral">{s || "—"}</Badge>;
}

export function ApprovalBadge({ approvedAt }: { approvedAt: unknown }): React.JSX.Element {
  if (approvedAt) return <Badge tone="success">Approved · {fmtDate(approvedAt)}</Badge>;
  return <Badge tone="neutral">Pending approval</Badge>;
}

// ── Overview display row + card ──────────────────────────────────────────────

export function InfoRow({
  label,
  value,
  mono,
  node,
}: {
  label: string;
  value?: unknown;
  mono?: boolean;
  node?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-[minmax(0,130px)_1fr] gap-3 py-[5px] border-b border-[var(--aws-border)] last:border-0 items-baseline">
      <dt className="text-[11px] text-[var(--text-muted)]">{label}</dt>
      <dd className={`text-[12px] text-[var(--text-primary)] break-words ${mono ? "font-mono" : ""}`}>
        {node ?? dash(value)}
      </dd>
    </div>
  );
}

export function InfoCard({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className={`${CARD_CLS} p-4`}>
      <h3 className="text-[12px] font-bold uppercase tracking-wide text-[var(--text-secondary)] mb-2">{title}</h3>
      <dl>{children}</dl>
    </section>
  );
}

// ── Selects ──────────────────────────────────────────────────────────────────

/** <select> fed by LookupRow[]. Leading "—" clears the value. */
export function LookupSelect({
  id,
  value,
  onChange,
  rows,
  disabled,
  className,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  rows: LookupRow[];
  disabled?: boolean;
  className?: string;
}): React.JSX.Element {
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={className ?? `${SELECT_CLS} w-full`}
    >
      <option value="">—</option>
      {(rows || []).map((r) => (
        <option key={r.lookup_id} value={r.lookup_id}>
          {r.label || r.code || r.lookup_id}
        </option>
      ))}
    </select>
  );
}

/** <select> fed by a hardcoded {code,label}[] enum (VENDOR_STATUS / DOC_TYPE …). */
export function CodeSelect({
  id,
  value,
  onChange,
  options,
  leadingDash,
  disabled,
  className,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly { code: string; label: string }[];
  leadingDash?: boolean;
  disabled?: boolean;
  className?: string;
}): React.JSX.Element {
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={className ?? `${SELECT_CLS} w-full`}
    >
      {leadingDash ? <option value="">—</option> : null}
      {options.map((o) => (
        <option key={o.code} value={o.code}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ── File chips (s3_urls CSV → external-link chips) ───────────────────────────

export function FileChips({ csv }: { csv: unknown }): React.JSX.Element {
  const urls = s3UrlsToArray(typeof csv === "string" ? csv : "");
  if (urls.length === 0) return <span className="text-[var(--text-muted)]">—</span>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {urls.map((u, i) => {
        const label = s3UrlBasename(u, `file ${i + 1}`);
        const httpish = /^https?:\/\//i.test(u);
        const cls =
          "inline-flex items-center max-w-[190px] truncate h-5 px-1.5 text-[11px] rounded-[2px] border border-[var(--aws-border)] bg-[var(--surface-subtle)]";
        return httpish ? (
          <a
            key={i}
            href={u}
            target="_blank"
            rel="noopener noreferrer"
            title={u}
            className={`${cls} text-[var(--aws-link)] hover:underline`}
          >
            {label}
          </a>
        ) : (
          <span key={i} title={u} className={`${cls} text-[var(--text-secondary)]`}>
            {label}
          </span>
        );
      })}
    </span>
  );
}

// ── Expiry badge (valid_to → expired / warning / plain) ──────────────────────

export function ExpiryCell({ value }: { value: unknown }): React.JSX.Element {
  if (value == null || value === "") return <span className="text-[var(--text-muted)]">—</span>;
  const ts = new Date(String(value)).getTime();
  if (Number.isNaN(ts)) return <span>{String(value)}</span>;
  const ymd = fmtDate(value);
  const days = Math.round((ts - Date.now()) / 86400000);
  if (days < 0) return <Badge tone="danger">{ymd} · expired</Badge>;
  if (days <= 30) return <Badge tone="warning">{ymd} · {days}d</Badge>;
  return <span className="text-[var(--text-primary)]">{ymd}</span>;
}

// ── Modal skeleton (overlay, Escape / click-outside close) ───────────────────

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  size = "md",
  titleId = "vd-modal-title",
}: {
  title: string;
  subtitle?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "md" | "lg";
  titleId?: string;
}): React.JSX.Element {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const maxW = size === "lg" ? "max-w-3xl" : "max-w-xl";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`bg-white rounded-md shadow-[0_8px_32px_rgba(0,28,36,0.28)] w-full ${maxW} flex flex-col max-h-[90vh]`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-5 pb-3 border-b border-[var(--aws-border)] flex items-start justify-between gap-3">
          <div>
            <h2 id={titleId} className="text-[15px] font-semibold text-[var(--text-primary)]">
              {title}
            </h2>
            {subtitle ? <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">{subtitle}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-[20px] leading-none text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            ×
          </button>
        </div>
        <div className="px-5 py-4 overflow-y-auto flex-1">{children}</div>
        {footer ? (
          <div className="px-5 py-3 border-t border-[var(--aws-border)] flex justify-end gap-2 shrink-0">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}

// ── Confirm modal + promise-based hook (replaces window.confirm) ─────────────

export interface ConfirmOpts {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
}
export type Confirm = (opts: ConfirmOpts) => Promise<boolean>;

function ConfirmModal({
  opts,
  onSettle,
}: {
  opts: ConfirmOpts;
  onSettle: (v: boolean) => void;
}): React.JSX.Element {
  return (
    <Modal
      title={opts.title}
      onClose={() => onSettle(false)}
      size="md"
      titleId="vd-confirm-title"
      footer={
        <>
          <button type="button" className={SECONDARY_BTN} onClick={() => onSettle(false)}>
            Cancel
          </button>
          <button
            type="button"
            className={opts.danger ? PRIMARY_DANGER_BTN : PRIMARY_BTN}
            onClick={() => onSettle(true)}
          >
            {opts.confirmLabel ?? "Confirm"}
          </button>
        </>
      }
    >
      <p className="text-[13px] text-[var(--text-primary)] leading-relaxed">{opts.message}</p>
    </Modal>
  );
}

export function useConfirm(): { confirm: Confirm; confirmElement: React.ReactNode } {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback<Confirm>(
    (opts) => new Promise<boolean>((resolve) => setState({ ...opts, resolve })),
    [],
  );
  const settle = useCallback((v: boolean) => {
    setState((s) => {
      s?.resolve(v);
      return null;
    });
  }, []);
  const confirmElement = state ? <ConfirmModal opts={state} onSettle={settle} /> : null;
  return { confirm, confirmElement };
}

// ── Toast (fixed bottom-right pill) ──────────────────────────────────────────

export type ToastKind = "ok" | "error" | "info";
export interface ToastState {
  id: number;
  kind: ToastKind;
  msg: string;
}
export type ShowToast = (msg: string, kind?: ToastKind) => void;

export function useToast(): { toast: ToastState | null; showToast: ShowToast; clearToast: () => void } {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback<ShowToast>((msg, kind = "ok") => {
    if (timer.current) clearTimeout(timer.current);
    const id = Date.now();
    setToast({ id, kind, msg });
    timer.current = setTimeout(() => setToast((t) => (t && t.id === id ? null : t)), 3600);
  }, []);
  const clearToast = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setToast(null);
  }, []);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return { toast, showToast, clearToast };
}

export function Toast({ toast, onClose }: { toast: ToastState | null; onClose: () => void }): React.JSX.Element | null {
  if (!toast) return null;
  const cls =
    toast.kind === "error"
      ? "bg-[#fbeced] text-[var(--aws-error)] border-[#f0c0c4]"
      : toast.kind === "info"
        ? "bg-[#eaf0fb] text-[#2c5fa8] border-[#c3d4f0]"
        : "bg-[#eaf6ed] text-[var(--text-success)] border-[#b6dbb1]";
  return (
    <div className="fixed bottom-4 right-4 z-[60] max-w-sm">
      <div
        role="status"
        aria-live="polite"
        className={`flex items-start gap-2 rounded-[3px] border px-3 py-2 text-[12px] shadow-[0_4px_16px_rgba(0,28,36,0.22)] ${cls}`}
      >
        <span className="flex-1">{toast.msg}</span>
        <button
          type="button"
          onClick={onClose}
          className="opacity-60 hover:opacity-100 text-[15px] leading-none"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}
