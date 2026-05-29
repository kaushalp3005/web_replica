"use client";

// Job card detail. Two fetches run in parallel: the full detail row from
// /job-cards-v2/{id} (rich sectioned payload — header + rm_indents + pm_indents
// + outputs + shift_log + sign_offs + bom_lines + consumption_lines + qc) and
// the stage chain from /job-cards-v2/{id}/chain.
//
// The Accounting + Quality forms below mirror the Android tabs:
//   OutputAccountingFragment → POST /outputs (single big body)
//   QualityFragment          → chained POSTs per check type
// Field set + categories + computed Process Loss % match the fragments line
// for line so the operator sees the same form on web as on mobile.

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { apiFetch, signOut, userStore } from "@/lib/auth";
import { useRequireAuth, useUserInitial } from "@/lib/user";
import { BALANCE_TOLERANCE_KG, WEIGHT_SAMPLE_COUNT } from "@/lib/constants";

// ── Types ─────────────────────────────────────────────────────────────────

type ChainStep = {
  job_card_id: number;
  job_card_number: string | null;
  step_number: number;
  process_name: string | null;
  stage: string | null;
  factory: string | null;
  floor: string | null;
  status: string | null;
  input_kind: string | null;
  output_kind: string | null;
  planned_qty_kg: number | null;
  carried_qty_kg: number | null;
  dispatched_to_next_kg: number | null;
  prev_job_card_id: number | null;
  next_job_card_id: number | null;
  start_time: string | null;
  end_time: string | null;
  is_current: boolean;
};

// Field names match the actual /job-cards-v2/{id} response — see
// job_card_v2.get_job_card. The sectioned shape (section_1_product etc.) is
// the v1-compat mirror the Android detail screen reads from.
type BomLine = {
  bom_line_id: number | null;
  line_number?: number | null;
  material_sku_name: string;
  item_type: string | null; // 'RM' | 'PM'
  uom?: string | null;
  quantity_per_unit?: number | null;
  loss_pct?: number | null;
  godown?: string | null;
};

type IndentLine = {
  bom_line_id?: number | null;
  material_sku_name?: string | null;
  required_qty?: number | string | null;
  issued_qty?: number | string | null;
  consumed_qty?: number | string | null;
  uom?: string | null;
  status?: string | null;
  [k: string]: unknown;
};

type ConsumptionLine = {
  consumption_id?: number | null;
  bom_line_id?: number | null;
  material_sku_name?: string | null;
  input_kind?: string | null;
  uom?: string | null;
  issued_qty?: number | string | null;
  actual_consumed_qty?: number | string | null;
  return_qty?: number | string | null;
  variance?: number | string | null;
  remarks?: string | null;
};

type BalanceMaterialRow = {
  balance_id?: number | null;
  bom_line_id?: number | null;
  material_id?: number | null;
  material_name?: string | null;
  balance_type?: string | null;
  qty_kg?: number | string | null;
  remarks?: string | null;
};

type ByproductRow = {
  byproduct_id?: number | null;
  category?: string | null;
  qty_kg?: number | string | null;
  uom?: string | null;
  remarks?: string | null;
};

type AnnexureRow = Record<string, unknown>;

type JobCardDetail = {
  job_card_id: number;
  job_card_number: string | null;
  status: string | null;
  fg_sku_name: string | null;
  customer_name: string | null;
  batch_number: string | null;
  planned_qty_kg: number | string | null;
  planned_qty_units: number | string | null;
  uom: string | null;
  factory: string | null;
  floor: string | null;
  entity: string | null;
  stage: string | null;
  process_name: string | null;
  step_number: number | null;
  plan_id: number | null;
  input_kind: string | null;
  output_kind: string | null;
  start_time: string | null;
  end_time: string | null;
  total_time_min: number | string | null;
  assigned_to_team_leader: string | null;
  team_members: string[] | null;
  // Lock + chain navigation. Needed by ActionBar to decide whether to render
  // START vs DISPATCH-TO-NEXT vs CLOSE, mirroring JobCardDetailActivity.updateActionButton.
  is_locked?: boolean | null;
  force_unlocked?: boolean | null;
  next_job_card_id?: number | null;
  prev_job_card_id?: number | null;
  dispatched_to_next_kg?: number | string | null;
  so_numbers?: string[] | null;
  primary_so_number?: string | null;

  section_1_product?: {
    so_numbers?: string[] | null;
    so_number?: string | null;
    so_date?: string | null;
    business_unit?: string | null;
    pack_size_kg?: number | null;
    bom_version?: number | null;
    net_wt_per_unit_kg?: number | null;
    expected_units?: number | null;
    batch_size_kg?: number | null;
    [k: string]: unknown;
  };
  section_5_output?: {
    fg_actual_kg?: number | string | null;
    fg_actual_units?: number | null;
    process_loss_kg?: number | string | null;
    rm_consumed_kg?: number | string | null;
    yield_pct?: number | string | null;
    created_at?: string | null;
  } | null;

  rm_indents?: IndentLine[];
  pm_indents?: IndentLine[];
  outputs?: Array<Record<string, unknown>>;
  shift_log?: Array<Record<string, unknown>>;
  sign_offs?: Array<Record<string, unknown>>;
  bom_lines?: BomLine[];
  consumption_lines?: ConsumptionLine[];
  balance_materials?: BalanceMaterialRow[];
  byproducts?: ByproductRow[];
  qc?: Record<string, unknown> | null;

  annexure_a_b_metal_detection?: AnnexureRow[];
  annexure_b_weight_checks?: AnnexureRow[];
  annexure_c_environment?: AnnexureRow[];
  annexure_d_loss_reconciliation?: AnnexureRow[];
  annexure_e_remarks?: AnnexureRow[];
};

// Tab order + labels mirror JobCardPagerAdapter.TAB_TITLES on Android:
//   Stage Chain · Overview · Output & Accounting · Quality · Sign-offs · Remarks
// Materials + Shifts (which existed on the web prototype) intentionally don't
// have Android counterparts; the equivalent info lives inside Accounting
// (BOM articles, consumption) and the toolbar/header time strip respectively.
type TabKey = "chain" | "overview" | "accounting" | "quality" | "signoffs" | "remarks";

const TABS: { key: TabKey; label: string }[] = [
  { key: "chain",      label: "Stage Chain" },
  { key: "overview",   label: "Overview" },
  { key: "accounting", label: "Output & Accounting" },
  { key: "quality",    label: "Quality" },
  { key: "signoffs",   label: "Sign-offs" },
  { key: "remarks",    label: "Remarks" },
];

const STATUS_STYLES: Record<string, { bg: string; fg: string; ring: string }> = {
  locked:            { bg: "#fdf3f1", fg: "#b1361e", ring: "#f0c7be" },
  unlocked:          { bg: "#f4f4f4", fg: "#414d5c", ring: "#d5dbdb" },
  assigned:          { bg: "#fef3e6", fg: "#a35200", ring: "#f5d6a8" },
  material_received: { bg: "#eaf3ff", fg: "#0073bb", ring: "#bbd9f3" },
  in_progress:       { bg: "#eaf3ff", fg: "#0073bb", ring: "#bbd9f3" },
  completed:         { bg: "#eaf6ed", fg: "#1d8102", ring: "#b6dbb1" },
  closed:            { bg: "#f0eef8", fg: "#5752c4", ring: "#d2cef0" },
  cancelled:         { bg: "#f4f4f4", fg: "#687078", ring: "#d5dbdb" },
};

// Rejection / Off-grade categories — mirror OutputAccountingFragment.REJ_KEYS
// / REJ_LABELS. "control_sample" reroutes to balance_materials, the rest go
// to byproducts on save.
const REJECTION_OPTIONS: { value: string; label: string }[] = [
  { value: "",                label: "— Select —" },
  { value: "tukda",           label: "Tukda (Broken)" },
  { value: "damaged",         label: "Damaged" },
  { value: "black_stained",   label: "Black Stained" },
  { value: "without_shell",   label: "Without Shell / Kernels" },
  { value: "empty_shells",    label: "Empty Shells" },
  { value: "dust",            label: "Dust" },
  { value: "rejection",       label: "Rejection" },
  { value: "control_sample",  label: "Control Sample (QC)" },
  { value: "other",           label: "Other" },
];

const METAL_CHECK_TYPES: { value: string; label: string }[] = [
  { value: "pre_packaging",  label: "Pre-packaging" },
  { value: "post_packaging", label: "Post-packaging" },
];

const ENV_PARAMS: { key: string; label: string }[] = [
  { key: "brine_salinity", label: "Brine Salinity" },
  { key: "temp",           label: "Temperature" },
  { key: "humidity",       label: "Humidity" },
  { key: "magnet",         label: "Magnet Check" },
];

// Aliased from @/lib/constants.WEIGHT_SAMPLE_COUNT — kept as a const here
// so the JSX label stays short ("Samples ({WEIGHT_SAMPLES})").
const WEIGHT_SAMPLES = WEIGHT_SAMPLE_COUNT;

function fmtStatus(s?: string | null): string {
  return (s || "").replace(/_/g, " ");
}
function fmtKg(v: number | string | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = typeof v === "number" ? v : parseFloat(v);
  if (Number.isNaN(n)) return "—";
  return `${n.toLocaleString("en-IN")} kg`;
}
function fmtNum(v: number | string | null | undefined, digits = 2): string {
  if (v == null || v === "") return "—";
  const n = typeof v === "number" ? v : parseFloat(v);
  if (Number.isNaN(n)) return "—";
  return n.toFixed(digits);
}
function fmtDateTime(iso?: string | null): string {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
function num(v: string | null | undefined): number {
  if (v == null) return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function JobCardDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const jcId = Number(params?.id);

  const [detail, setDetail] = useState<JobCardDetail | null>(null);
  const [chain, setChain] = useState<ChainStep[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("chain");
  const initial = useUserInitial();

  // Manual reload counter — bumped from inside the tab content (Save Output,
  // Sign-off, etc.) to re-fetch detail + chain without remounting the page.
  // The fetch effect treats every change to `reloadKey` as "do another pass".
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((k) => k + 1);

  // Boot-time auth gate — drops the inline tokenStore check that used to
  // live at the top of the fetch effect.
  const authed = useRequireAuth(router.replace);

  // Fetch effect: depends directly on jcId + reloadKey so the same
  // anti-loop reasoning as the listing applies — no useCallback indirection,
  // no fresh function reference per render. AbortController cancels the
  // in-flight pair if the operator jumps to a different JC mid-flight; the
  // signal is also forwarded to fetch so the network request itself stops.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!authed) return;
    if (!Number.isFinite(jcId)) {
      // Defer past the synchronous effect body to satisfy the
      // react-hooks/set-state-in-effect rule.
      queueMicrotask(() => {
        setError("Invalid job card id.");
        setLoading(false);
      });
      return;
    }

    const controller = new AbortController();
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        // Detail first — if it 404s, we never bother downloading the chain.
        const detailRes = await apiFetch(
          `/api/v1/production/job-cards-v2/${jcId}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (detailRes.status === 401) return; // apiFetch already redirected
        if (detailRes.status === 404) { setError("Job card not found."); return; }
        if (!detailRes.ok) throw new Error(`Detail HTTP ${detailRes.status}`);

        const chainRes = await apiFetch(
          `/api/v1/production/job-cards-v2/${jcId}/chain`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (chainRes.status === 401) return;
        if (!chainRes.ok) throw new Error(`Chain HTTP ${chainRes.status}`);

        const detailJson = (await detailRes.json()) as JobCardDetail;
        const chainJson  = (await chainRes.json())  as ChainStep[];
        if (controller.signal.aborted) return;
        setDetail(detailJson);
        setChain(chainJson);
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Failed to load job card");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [jcId, router, reloadKey, authed]);

  function onLogout() {
    signOut();
    router.replace("/");
  }

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-6 gap-4">
        <span className="text-white font-bold tracking-tight text-[17px] flex items-baseline">
          aws
          <span className="inline-block w-[4px] h-[4px] rounded-full bg-[var(--aws-orange)] ml-[1px]" />
        </span>
        <span className="text-[#d5dbdb] text-[13px] hidden sm:inline">Console</span>
        <nav className="text-[12px] text-[#d5dbdb] hidden md:flex items-center gap-2 ml-2">
          <button onClick={() => router.push("/modules")} className="hover:underline">Modules</button>
          <span>/</span>
          <button onClick={() => router.push("/modules/job-card")} className="hover:underline">Job Cards</button>
          <span>/</span>
          <span className="text-white">{detail?.job_card_number ?? jcId}</span>
        </nav>
        <div className="flex-1" />
        <button
          onClick={onLogout}
          aria-label="Sign out"
          className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]"
        >
          {initial}
        </button>
      </header>

      <main className="flex-1 max-w-[1280px] w-full mx-auto px-4 sm:px-6 py-6">
        {/* Back row — router.back() preserves the listing's in-memory state
            via the session-storage cache (lib/jc-list-cache.ts) so filters,
            scroll position, and fetched rows survive the round trip. Falls
            back to a fresh listing route push when there's no history entry
            (operator opened the detail URL directly via deep link). */}
        <div className="mb-3">
          <button
            type="button"
            onClick={() => {
              if (typeof window !== "undefined" && window.history.length > 1) {
                router.back();
              } else {
                router.push("/modules/job-card");
              }
            }}
            className="inline-flex items-center gap-1.5 h-7 px-2 -ml-2 text-[12px] text-[var(--aws-link)] hover:underline"
            aria-label="Back to job cards"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="19" y1="12" x2="5" y2="12" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
            Back to job cards
          </button>
        </div>
        {loading && !detail ? (
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[var(--text-secondary)]">
            <span className="inline-flex items-center gap-2 text-[13px]">
              <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
              Loading job card…
            </span>
          </div>
        ) : error ? (
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-8 text-center">
            <p className="text-[var(--aws-error)] text-[14px] font-semibold mb-2">{error}</p>
            <button onClick={() => router.push("/modules/job-card")} className="text-[12px] text-[var(--aws-link)] hover:underline">
              Back to job cards
            </button>
          </div>
        ) : detail ? (
          <>
            <PageHeader
              detail={detail}
              chain={chain}
              onJump={(id) => router.push(`/modules/job-card/${id}`)}
              onReload={reload}
            />
            <ActionBar detail={detail} onReload={reload} />
            <TabStrip value={tab} onChange={setTab} />
            <TabPanel
              detail={detail}
              chain={chain}
              tab={tab}
              onReload={reload}
              onJumpJc={(id) => router.push(`/modules/job-card/${id}`)}
            />
          </>
        ) : null}
      </main>

      <footer className="border-t border-[var(--aws-border)] bg-white py-3 px-6 text-[11px] text-[var(--text-secondary)] flex flex-wrap justify-center gap-x-4 gap-y-1">
        <a href="#" className="hover:underline">Terms of Use</a>
        <a href="#" className="hover:underline">Privacy</a>
        <span>© {new Date().getFullYear()}</span>
      </footer>
    </div>
  );
}

// ── Page header ───────────────────────────────────────────────────────────

function PageHeader({
  detail, chain, onJump, onReload,
}: {
  detail: JobCardDetail;
  chain: ChainStep[];
  onJump: (id: number) => void;
  onReload: () => void;
}) {
  const style = STATUS_STYLES[detail.status ?? ""] ?? STATUS_STYLES.unlocked;
  const jcNum = detail.job_card_number || `JC-${detail.job_card_id}`;
  const sos = detail.section_1_product?.so_numbers ?? detail.so_numbers ?? [];
  const soDisplay = sos.length === 0 ? "—" : sos.length === 1 ? sos[0] : `${sos[0]} +${sos.length - 1}`;

  // Chain nav — find the current step's neighbours so we can render
  // ‹ Prev | Step X of Y | Next › the same way as the Android toolbar.
  const curIdx = chain.findIndex((c) => c.is_current);
  const cur = curIdx >= 0 ? chain[curIdx] : null;
  const prevStep = curIdx > 0 ? chain[curIdx - 1] : null;
  const nextStep = curIdx >= 0 && curIdx + 1 < chain.length ? chain[curIdx + 1] : null;

  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-5 mb-4">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="font-mono text-[12px] text-[var(--aws-link)] font-semibold mb-1" title={jcNum}>{jcNum}</div>
          <h1 className="text-[22px] leading-[26px] font-semibold text-[var(--text-primary)]" title={detail.fg_sku_name ?? ""}>
            {detail.fg_sku_name || "—"}
          </h1>
          <p className="text-[13px] text-[var(--text-secondary)] mt-1">{detail.customer_name || "—"}</p>

          {/* Chain nav row — only when the JC is part of a chain. */}
          {cur && chain.length > 1 ? (
            <div className="flex items-center gap-2 mt-2 text-[12px]">
              {prevStep ? (
                <button
                  type="button"
                  onClick={() => onJump(prevStep.job_card_id)}
                  className="text-[var(--aws-orange)] font-bold hover:underline"
                  title={prevStep.process_name ?? ""}
                >
                  ‹ Prev
                </button>
              ) : (
                <span className="text-[var(--text-disabled)]">‹ Prev</span>
              )}
              <span className="text-[var(--text-secondary)]">
                Step {cur.step_number} of {chain.length}
              </span>
              {nextStep ? (
                <button
                  type="button"
                  onClick={() => onJump(nextStep.job_card_id)}
                  className="text-[var(--aws-orange)] font-bold hover:underline"
                  title={nextStep.process_name ?? ""}
                >
                  Next ›
                </button>
              ) : (
                <span className="text-[var(--text-disabled)]">Next ›</span>
              )}
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span
            className="inline-block text-[11px] font-semibold px-2 py-1 rounded-sm capitalize"
            style={{ background: style.bg, color: style.fg, border: `1px solid ${style.ring}` }}
          >
            {fmtStatus(detail.status) || "—"}
          </span>
          <OverflowMenu detail={detail} onReload={onReload} />
        </div>
      </div>
      <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-x-4 gap-y-2 text-[12px]">
        <HeaderMeta label="SO" value={soDisplay} title={sos.join(", ")} />
        <HeaderMeta label="Batch" value={detail.batch_number || "—"} />
        <HeaderMeta label="Qty" value={fmtKg(detail.planned_qty_kg)} />
        <HeaderMeta label="Plant" value={detail.factory || "—"} />
        <HeaderMeta label="Floor" value={detail.floor || "—"} />
        <HeaderMeta label="Plan" value={detail.plan_id ? `#${detail.plan_id}` : "—"} />
      </dl>
    </div>
  );
}

function HeaderMeta({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0">
      <dt className="uppercase tracking-wide font-semibold text-[var(--text-muted)] text-[10px]">{label}</dt>
      <dd className="text-[13px] text-[var(--text-primary)] truncate" title={title ?? value}>{value}</dd>
    </div>
  );
}

// ── Action bar ───────────────────────────────────────────────────────────
//
// Mirrors JobCardDetailActivity.updateActionButton — a single context-
// sensitive button driven by status + lock + chain position:
//   assigned/material_received & !locked  → START          → PUT /start
//   in_progress                           → COMPLETE        → PUT /complete
//   completed & has next & remaining > 0  → DISPATCH TO NEXT→ POST /dispatch-to-next
//   completed & no remaining              → CLOSE JC        → PUT /close
//   anything else                         → bar hidden
// Each action runs a window.confirm step before firing — matches the Android
// AlertDialog. Dispatch additionally collects the qty via window.prompt so
// the operator can choose how much to push to the next stage.
function ActionBar({ detail, onReload }: { detail: JobCardDetail; onReload: () => void }) {
  const [busy, setBusy] = useState(false);
  const status = detail.status ?? "";
  const isLocked = !!detail.is_locked && !detail.force_unlocked;

  async function callAction(opts: {
    confirmTitle: string;
    confirmMessage: string;
    method: "PUT" | "POST" | "DELETE";
    path: string;
    body?: unknown;
    okMessage: string;
  }) {
    if (!window.confirm(`${opts.confirmTitle}\n\n${opts.confirmMessage}`)) return;
    setBusy(true);
    try {
      const res = await apiFetch(opts.path, {
        method: opts.method,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      if (!res.ok) {
        let detailText: string;
        try { detailText = await res.text(); } catch { detailText = `HTTP ${res.status}`; }
        throw new Error(detailText || `HTTP ${res.status}`);
      }
      window.alert(opts.okMessage);
      onReload();
    } catch (e) {
      window.alert(`Failed: ${e instanceof Error ? e.message : "unknown error"}`);
    } finally {
      setBusy(false);
    }
  }

  // Decide which button to show.
  let label: string | null = null;
  let onClick: (() => void) | null = null;

  if ((status === "assigned" || status === "material_received") && !isLocked) {
    label = "START";
    onClick = () => callAction({
      confirmTitle: "Start Production",
      confirmMessage: "Start production for this job card? The timer will begin recording.",
      method: "PUT",
      path: `/api/v1/production/job-cards-v2/${detail.job_card_id}/start`,
      okMessage: "Production started — timer running.",
    });
  } else if (status === "in_progress") {
    label = "COMPLETE";
    onClick = () => callAction({
      confirmTitle: "Complete Production",
      confirmMessage: "Mark this job card as completed? End time will be recorded.",
      method: "PUT",
      path: `/api/v1/production/job-cards-v2/${detail.job_card_id}/complete`,
      okMessage: "Production completed.",
    });
  } else if (status === "completed") {
    const fgKg = num(String(detail.section_5_output?.fg_actual_kg ?? 0));
    const sentKg = num(String(detail.dispatched_to_next_kg ?? 0));
    const remaining = fgKg - sentKg;
    if (detail.next_job_card_id && remaining > 0.0001) {
      label = "DISPATCH TO NEXT";
      onClick = () => {
        const qtyStr = window.prompt(
          `Dispatch to next stage\n\nRemaining: ${remaining.toFixed(2)} kg\nEnter qty to dispatch (kg):`,
          remaining.toFixed(2),
        );
        if (qtyStr == null) return;
        const qty = parseFloat(qtyStr);
        if (!Number.isFinite(qty) || qty <= 0) {
          window.alert("Qty must be a positive number.");
          return;
        }
        if (qty > remaining + 0.0001) {
          window.alert(`Qty exceeds remaining (${remaining.toFixed(2)} kg).`);
          return;
        }
        void callAction({
          confirmTitle: "Dispatch to next stage",
          confirmMessage: `Push ${qty.toFixed(2)} kg to the next stage?`,
          method: "POST",
          path: `/api/v1/production/job-cards-v2/${detail.job_card_id}/dispatch-to-next`,
          body: { qty_kg: qty },
          okMessage: "Dispatched.",
        });
      };
    } else {
      label = "CLOSE JC";
      onClick = () => callAction({
        confirmTitle: "Close Job Card",
        confirmMessage: "Close this job card after sign-offs? It will become read-only.",
        method: "PUT",
        path: `/api/v1/production/job-cards-v2/${detail.job_card_id}/close`,
        okMessage: "Job card closed.",
      });
    }
  }

  if (!label || !onClick) return null;

  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] px-4 py-2 mb-4 flex justify-end">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className={[
          "h-9 px-4 rounded-[2px] text-[13px] font-bold border tracking-wide",
          busy
            ? "bg-[#f2c399] border-[#f2c399] cursor-not-allowed text-[var(--text-primary)]"
            : "bg-gradient-to-b from-[#f7dfa5] to-[#f0c14b] border-[#a88734] hover:from-[#f5d78e] hover:to-[#eeb933] text-[var(--text-primary)]",
        ].join(" ")}
      >
        {busy ? "Working…" : label}
      </button>
    </div>
  );
}

// ── Overflow ⋮ menu ──────────────────────────────────────────────────────
//
// Mirrors JobCardDetailActivity.showHeaderMenu — items appear conditionally:
//   Edit header        ↦ when status NOT in {completed, closed, cancelled}
//   Close JC           ↦ when status == completed
//   Force unlock       ↦ when is_locked && is_admin
//   Cancel JC          ↦ when status in {locked, unlocked, assigned}
//   Manage Quality rows↦ always editable
// Force unlock + Cancel collect a reason via window.prompt; Edit header /
// Manage Quality rows open elaborate dialogs on Android (multi-field forms);
// the web stubs surface an explanatory alert until those screens land.
function OverflowMenu({ detail, onReload }: { detail: JobCardDetail; onReload: () => void }) {
  const [open, setOpen] = useState(false);
  const me = userStore.load();
  const isAdmin = !!me?.is_admin;
  const status = detail.status ?? "";

  const editable    = status !== "completed" && status !== "closed" && status !== "cancelled";
  const cancellable = status === "locked" || status === "unlocked" || status === "assigned";
  const closeable   = status === "completed";
  const showForceUnlock = !!detail.is_locked && isAdmin;

  const items: { label: string; enabled: boolean; onClick: () => void }[] = [];
  items.push({
    label: "Edit header",
    enabled: editable,
    onClick: () => window.alert("Edit header dialog is not implemented on web yet. Use the Android app to edit header fields."),
  });
  if (closeable) {
    items.push({
      label: "Close JC",
      enabled: true,
      onClick: () => closeJc(),
    });
  }
  if (showForceUnlock) {
    items.push({
      label: "Force unlock",
      enabled: true,
      onClick: () => forceUnlockJc(),
    });
  }
  if (cancellable) {
    items.push({
      label: "Cancel JC",
      enabled: true,
      onClick: () => cancelJc(),
    });
  }
  items.push({
    label: "Manage Quality rows",
    enabled: editable,
    onClick: () => window.alert("Manage Quality rows dialog is not implemented on web yet. Use the Quality tab to add rows, or the Android app to edit/delete existing ones."),
  });

  async function callApi(method: "PUT" | "POST" | "DELETE", path: string, body: unknown, okMsg: string) {
    try {
      const res = await apiFetch(path, { method, body: body !== undefined ? JSON.stringify(body) : undefined });
      if (!res.ok) {
        let detailText: string;
        try { detailText = await res.text(); } catch { detailText = `HTTP ${res.status}`; }
        throw new Error(detailText || `HTTP ${res.status}`);
      }
      window.alert(okMsg);
      onReload();
    } catch (e) {
      window.alert(`Failed: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }

  function closeJc() {
    if (!window.confirm("Close Job Card\n\nClose this job card after sign-offs? It will become read-only.")) return;
    void callApi("PUT", `/api/v1/production/job-cards-v2/${detail.job_card_id}/close`, undefined, "Job card closed.");
  }
  function forceUnlockJc() {
    const authority = window.prompt("Force unlock — authority (e.g. plant manager name):", me?.full_name ?? "");
    if (authority == null || !authority.trim()) return;
    const reason = window.prompt("Force unlock — reason:");
    if (reason == null || !reason.trim()) return;
    void callApi(
      "PUT",
      `/api/v1/production/job-cards-v2/${detail.job_card_id}/force-unlock`,
      { authority: authority.trim(), reason: reason.trim() },
      "Job card force-unlocked.",
    );
  }
  function cancelJc() {
    const reason = window.prompt("Cancel Job Card — reason:");
    if (reason == null || !reason.trim()) return;
    if (!window.confirm(`Cancel Job Card?\n\n"${reason.trim()}"`)) return;
    void callApi(
      "DELETE",
      `/api/v1/production/job-cards-v2/${detail.job_card_id}`,
      { reason: reason.trim() },
      "Job card cancelled.",
    );
  }

  // Close the menu on outside click.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      const t = e.target as HTMLElement;
      if (!t.closest("[data-overflow-menu]")) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div className="relative" data-overflow-menu>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-7 h-7 rounded-sm hover:bg-[var(--surface-divider)] text-[var(--text-secondary)] flex items-center justify-center"
        aria-label="More actions"
        title="More actions"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
          <circle cx="12" cy="5"  r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="12" cy="19" r="2" />
        </svg>
      </button>
      {open ? (
        <div
          className={[
            // Anchored right (the trigger sits at the right of the page
            // header), but capped at viewport width minus a small margin so
            // the panel breaks to the narrower wrapped width rather than
            // bleeding off the screen when the viewport is too narrow to
            // fit 200px. Tall menus scroll vertically.
            "absolute right-0 z-10 mt-1 w-[200px] max-w-[calc(100vw-1rem)]",
            "max-h-[60vh] overflow-y-auto",
            "bg-white border border-[var(--aws-border)] rounded-md shadow-[0_4px_12px_rgba(0,28,36,0.18)] p-1",
          ].join(" ")}
        >
          {items.map((it, i) => (
            <button
              key={i}
              type="button"
              disabled={!it.enabled}
              onClick={() => { setOpen(false); it.onClick(); }}
              className={[
                "w-full text-left px-2 py-1.5 text-[13px] rounded-sm",
                it.enabled ? "text-[var(--text-primary)] hover:bg-[var(--surface-disabled)]" : "text-[var(--text-disabled)] cursor-not-allowed",
              ].join(" ")}
            >
              {it.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── Stage Chain tab ───────────────────────────────────────────────────────
//
// Mirrors StageChainFragment on Android — a vertical list of every step on
// this JC's plan line. Each entry shows step number, process, stage, status,
// and the qty handoffs (carried in / dispatched out) so the operator can see
// where the material is in the chain at a glance. The current step is
// non-clickable; the others jump to their own detail page.

function StageChainTab({ chain, onJump }: { chain: ChainStep[]; onJump: (id: number) => void }) {
  if (chain.length === 0) {
    return (
      <Panel>
        <EmptyHint>No stage chain available for this job card.</EmptyHint>
      </Panel>
    );
  }
  return (
    <Panel title={`Stage chain · ${chain.length} ${chain.length === 1 ? "step" : "steps"}`}>
      <ol className="space-y-2">
        {chain.map((step) => (
          <li key={step.job_card_id}>
            <button
              type="button"
              disabled={step.is_current}
              onClick={() => onJump(step.job_card_id)}
              className={[
                "w-full text-left rounded-md border p-3 transition",
                step.is_current
                  ? "border-[var(--aws-orange)] bg-[#fef3e6] cursor-default ring-1 ring-[var(--aws-orange)]"
                  : "border-[var(--aws-border)] bg-white hover:border-[var(--aws-navy)] hover:shadow-[0_1px_4px_rgba(0,28,36,0.15)]",
              ].join(" ")}
            >
              <div className="flex items-center gap-3 mb-1">
                <span
                  className={[
                    "inline-flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-bold shrink-0",
                    step.is_current ? "bg-[var(--aws-orange)] text-white" : "bg-[var(--surface-divider)] text-[var(--text-secondary)]",
                  ].join(" ")}
                >
                  {step.step_number}
                </span>
                <div className="flex-1 min-w-0">
                  <div className={["text-[14px] truncate", step.is_current ? "font-semibold text-[var(--text-primary)]" : "text-[var(--text-primary)]"].join(" ")}>
                    {step.process_name || "—"}
                  </div>
                  <div className="text-[12px] text-[var(--text-muted)] truncate">
                    {step.stage || "—"} · {step.input_kind || "?"} → {step.output_kind || "?"} · {step.floor || "—"}
                  </div>
                </div>
                <StatusPill status={step.status} />
              </div>
              <dl className="grid grid-cols-3 gap-x-3 text-[11px] mt-2">
                <Inline label="Planned" value={fmtKg(step.planned_qty_kg)} />
                <Inline label="Carried in" value={fmtKg(step.carried_qty_kg)} />
                <Inline label="Dispatched" value={fmtKg(step.dispatched_to_next_kg)} />
              </dl>
            </button>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function Inline({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <span className="uppercase tracking-wide font-semibold text-[var(--text-muted)] text-[10px] mr-1">{label}</span>
      <span className="text-[12px] text-[var(--text-primary)]">{value}</span>
    </div>
  );
}

function StatusPill({ status, small }: { status: string | null; small?: boolean }) {
  const style = STATUS_STYLES[status ?? ""] ?? STATUS_STYLES.unlocked;
  return (
    <span
      className={["inline-block font-semibold rounded-sm capitalize", small ? "text-[10px] px-1.5 py-0" : "text-[11px] px-2 py-0.5"].join(" ")}
      style={{ background: style.bg, color: style.fg, border: `1px solid ${style.ring}` }}
    >
      {fmtStatus(status) || "—"}
    </span>
  );
}

// ── Tab strip + panel ─────────────────────────────────────────────────────

function TabStrip({ value, onChange }: { value: TabKey; onChange: (t: TabKey) => void }) {
  return (
    <div className="border-b border-[var(--aws-border)] mb-4 flex gap-1 overflow-x-auto">
      {TABS.map((t) => {
        const active = t.key === value;
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            className={["px-4 py-2 text-[13px] font-medium whitespace-nowrap border-b-2 -mb-px transition", active ? "border-[var(--aws-orange)] text-[var(--text-primary)]" : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"].join(" ")}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function TabPanel({
  detail, chain, tab, onReload, onJumpJc,
}: {
  detail: JobCardDetail;
  chain: ChainStep[];
  tab: TabKey;
  onReload: () => void;
  onJumpJc: (id: number) => void;
}) {
  switch (tab) {
    case "chain":      return <StageChainTab chain={chain} onJump={onJumpJc} />;
    case "overview":   return <OverviewTab detail={detail} chain={chain} onReload={onReload} />;
    case "accounting": return <AccountingTab detail={detail} onReload={onReload} />;
    case "quality":    return <QualityTab detail={detail} onReload={onReload} />;
    case "signoffs":   return <SignOffsTab detail={detail} onReload={onReload} />;
    case "remarks":    return <RemarksTab detail={detail} onReload={onReload} />;
  }
}

// ── Read-only tabs ────────────────────────────────────────────────────────

function Panel({ children, title, action }: { children: React.ReactNode; title?: string; action?: React.ReactNode }) {
  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-5 mb-4">
      {title || action ? (
        <div className="flex items-center justify-between mb-3">
          {title ? <h3 className="text-[12px] uppercase tracking-wide font-semibold text-[var(--text-secondary)]">{title}</h3> : <span />}
          {action ?? null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

function KV({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="uppercase tracking-wide font-semibold text-[var(--text-muted)] text-[10px]">{label}</div>
      <div className={`text-[13px] text-[var(--text-primary)] truncate ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <p className="text-[12px] text-[var(--text-muted)] italic">{children}</p>;
}

function OverviewTab({ detail, chain, onReload }: { detail: JobCardDetail; chain: ChainStep[]; onReload: () => void }) {
  const sec = detail.section_1_product ?? {};
  const completedSteps = chain.filter((c) => c.status === "completed" || c.status === "closed").length;
  return (
    <>
      <Panel title="Sales order">
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3">
          <KV label="SO #" value={sec.so_number || detail.primary_so_number || "—"} />
          <KV label="SO Date" value={sec.so_date || "—"} />
          <KV label="Business unit" value={sec.business_unit || "—"} />
          <KV label="BOM version" value={sec.bom_version != null ? String(sec.bom_version) : "—"} />
        </dl>
      </Panel>
      <Panel title="Stage progress">
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3">
          <KV label="This step" value={`Step ${detail.step_number ?? "—"} · ${detail.process_name || "—"}`} />
          <KV label="Stage" value={detail.stage || "—"} />
          <KV label="Chain progress" value={`${completedSteps} / ${chain.length} completed`} />
          <KV label="Time on JC" value={detail.total_time_min ? `${detail.total_time_min} min` : "—"} />
        </dl>
      </Panel>
      <TeamPanel detail={detail} onReload={onReload} />
    </>
  );
}

// Mirrors OverviewFragment's Team card + Assign/Edit dialog. The button
// disappears outside the assignable status range (unlocked / assigned /
// material_received / in_progress) and the title flips between
// "Assign Team" and "Edit Team" depending on whether a leader is already
// recorded. POSTs {team_leader, team_members[]} to /job-cards-v2/{id}/assign.
function TeamPanel({ detail, onReload }: { detail: JobCardDetail; onReload: () => void }) {
  const status = detail.status ?? "";
  const canAssign =
    status === "unlocked" || status === "assigned" ||
    status === "material_received" || status === "in_progress";
  const hasTeam = !!(detail.assigned_to_team_leader && detail.assigned_to_team_leader.trim());
  const buttonLabel = hasTeam ? "Edit Team" : "Assign Team";

  const [open, setOpen] = useState(false);
  const [leader, setLeader] = useState(detail.assigned_to_team_leader ?? "");
  const [members, setMembers] = useState<string[]>(detail.team_members ?? []);
  const [pending, setPending] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  // Re-sync local state when the detail reloads (e.g. after a successful
  // POST /assign refetches the JC). Deferred past the synchronous effect
  // body — the react-hooks/set-state-in-effect rule (correctly) flags an
  // immediate setState as a cascading render.
  useEffect(() => {
    queueMicrotask(() => {
      setLeader(detail.assigned_to_team_leader ?? "");
      setMembers(detail.team_members ?? []);
    });
  }, [detail.assigned_to_team_leader, detail.team_members]);

  function addPending() {
    // Mirror the Android chip input: a comma-separated paste like
    // "asha, bilal, charu" turns into three chips, not one giant chip.
    const parts = pending.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) setMembers((m) => [...m, ...parts]);
    setPending("");
  }

  function removeMember(idx: number) {
    setMembers((m) => m.filter((_, i) => i !== idx));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);
    const trimmedLeader = leader.trim();
    if (!trimmedLeader) {
      setFeedback({ kind: "err", msg: "Team leader is required." });
      return;
    }
    // Drain any pending name the operator typed but didn't press
    // Enter / comma on — Android does the same to avoid silently dropping it.
    const trailing = pending.trim();
    const finalMembers = trailing ? [...members, trailing] : members;

    setSubmitting(true);
    try {
      const res = await apiFetch(`/api/v1/production/job-cards-v2/${detail.job_card_id}/assign`, {
        method: "PUT",
        body: JSON.stringify({
          team_leader: trimmedLeader,
          team_members: finalMembers.length > 0 ? finalMembers : null,
        }),
      });
      if (!res.ok) {
        let txt: string;
        try { txt = await res.text(); } catch { txt = `HTTP ${res.status}`; }
        throw new Error(txt || `HTTP ${res.status}`);
      }
      setFeedback({ kind: "ok", msg: hasTeam ? "Team updated." : "Team assigned." });
      setOpen(false);
      setPending("");
      onReload();
    } catch (err) {
      setFeedback({ kind: "err", msg: err instanceof Error ? err.message : "Assign failed." });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Panel
      title="Team"
      action={
        canAssign ? (
          <button
            type="button"
            onClick={() => { setOpen((v) => !v); setFeedback(null); }}
            className="h-7 px-3 rounded-[2px] text-[12px] font-semibold border bg-gradient-to-b from-[#f7dfa5] to-[#f0c14b] border-[#a88734] hover:from-[#f5d78e] hover:to-[#eeb933] text-[var(--text-primary)]"
          >
            {open ? "Cancel" : buttonLabel}
          </button>
        ) : null
      }
    >
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3 mb-3">
        <KV label="Team leader" value={detail.assigned_to_team_leader || "—"} />
        <KV
          label="Team members"
          value={detail.team_members && detail.team_members.length > 0 ? detail.team_members.join(", ") : "—"}
        />
        <KV label="Started" value={fmtDateTime(detail.start_time)} />
        <KV label="Ended" value={fmtDateTime(detail.end_time)} />
      </dl>

      {open ? (
        <form onSubmit={onSubmit} className="border-t border-[var(--aws-border)] pt-3 mt-2">
          <h4 className="text-[13px] font-semibold text-[var(--text-primary)] mb-3">
            {hasTeam ? "Edit Team" : "Assign Team"}
          </h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <FormText label="Team leader" value={leader} onChange={setLeader} disabled={submitting} placeholder="Leader's full name" />
            <div>
              <FormLabel>Add team member</FormLabel>
              <div className="flex gap-2">
                <input
                  type="text"
                  className={inputCls}
                  value={pending}
                  onChange={(e) => setPending(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      addPending();
                    }
                  }}
                  disabled={submitting}
                  placeholder="Name, then Enter or comma"
                />
                <button
                  type="button"
                  onClick={addPending}
                  disabled={submitting || !pending.trim()}
                  className="h-8 px-3 text-[12px] font-semibold rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] disabled:opacity-50"
                >
                  Add
                </button>
              </div>
            </div>
          </div>
          {members.length > 0 ? (
            <div className="flex flex-wrap gap-2 mb-3">
              {members.map((m, i) => (
                <span key={i} className="inline-flex items-center gap-1 bg-[#eaf3ff] border border-[#bbd9f3] text-[#0073bb] text-[12px] rounded-full px-2 py-0.5">
                  {m}
                  <button
                    type="button"
                    onClick={() => removeMember(i)}
                    disabled={submitting}
                    className="ml-1 leading-none hover:text-[var(--aws-error)]"
                    aria-label={`Remove ${m}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="text-[12px] text-[var(--text-muted)] italic mb-3">No members added yet.</p>
          )}
          <FormFooter feedback={feedback} submitting={submitting} submitLabel={hasTeam ? "Save Changes" : "Assign"} />
        </form>
      ) : null}
    </Panel>
  );
}

// Materials + Shifts tabs intentionally absent — Android has no equivalents.
// RM/PM info lives inside Accounting (BOM articles); the shift timer lives
// in the header time strip / overflow actions.

// ── Remarks tab — list + add ──────────────────────────────────────────────
//
// Mirrors RemarksFragment on Android: shows every annexure_e remark and lets
// the operator append a new one. v2 backend takes { remark_type, content,
// recorded_by? } on POST /remarks. remark_type is one of:
//   observation / deviation / corrective_action
// (Same enum as the Android RemarkRequest model — server-enforced.)

const REMARK_TYPES: { value: string; label: string }[] = [
  { value: "observation",        label: "Observation" },
  { value: "deviation",          label: "Deviation" },
  { value: "corrective_action", label: "Corrective action" },
];

function RemarksTab({ detail, onReload }: { detail: JobCardDetail; onReload: () => void }) {
  const rows = detail.annexure_e_remarks ?? [];
  const [remarkType, setRemarkType] = useState<string>("observation");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);
    if (!content.trim()) {
      setFeedback({ kind: "err", msg: "Remark content is required." });
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch(`/api/v1/production/job-cards-v2/${detail.job_card_id}/remarks`, {
        method: "POST",
        body: JSON.stringify({ remark_type: remarkType, content: content.trim() }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setFeedback({ kind: "ok", msg: "Remark added." });
      setContent("");
      onReload();
    } catch (e2) {
      setFeedback({ kind: "err", msg: e2 instanceof Error ? e2.message : "Failed to add remark." });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Panel title={`Remarks · ${rows.length}`}>
        {rows.length === 0 ? (
          <EmptyHint>No remarks recorded yet.</EmptyHint>
        ) : (
          <RowTable
            rows={rows}
            columns={[
              { key: "recorded_at",  label: "When", render: (v) => fmtDateTime(String(v ?? "")) },
              { key: "remark_type",  label: "Type", render: (v) => String(v ?? "").replace(/_/g, " ") },
              { key: "content",      label: "Content" },
              { key: "recorded_by",  label: "By" },
            ]}
          />
        )}
      </Panel>
      <Panel title="Add remark">
        <form onSubmit={onSubmit}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <FormSelect label="Type" value={remarkType} onChange={setRemarkType} disabled={submitting} options={REMARK_TYPES} />
          </div>
          <FormText label="Content" value={content} onChange={setContent} disabled={submitting} />
          <FormFooter feedback={feedback} submitting={submitting} submitLabel="Add remark" />
        </form>
      </Panel>
    </>
  );
}

// Per the 2026-05 ops decision (see SignoffsFragment docstring), only the
// Production Head sign-off gates JC close. Floor In-Charge and QC Inspector
// roles still exist server-side but neither is collected here. The Sign
// button is gated by JC status: disabled until "completed", hidden once
// already signed.
const SIGNOFF_ROLE = "production_head";

function SignOffsTab({ detail, onReload }: { detail: JobCardDetail; onReload: () => void }) {
  const rows = detail.sign_offs ?? [];
  const headEntry = rows.find((r) => {
    const role = String(r["role"] ?? "");
    // Match the canonical role first, then the legacy slot names that some
    // older JCs were signed under (production_manager / warehouse_incharge),
    // mirroring Section6Signoffs.getProductionHead on Android.
    return role === SIGNOFF_ROLE || role === "production_manager" || role === "warehouse_incharge";
  });
  const signedBy = headEntry ? String(headEntry["signed_by"] ?? "") : "";
  const signedAt = headEntry ? String(headEntry["signed_at"] ?? "") : "";
  const isSigned = !!signedBy.trim();
  const status = detail.status ?? "";
  const canSign = status === "completed";

  const me = userStore.load();
  const defaultName = me?.full_name?.trim() ?? "";

  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  async function promptAndSign() {
    const name = window.prompt("Sign off as Production Head — your name:", defaultName);
    if (name == null) return;
    if (!name.trim()) {
      setFeedback({ kind: "err", msg: "Name is required." });
      return;
    }
    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await apiFetch(`/api/v1/production/job-cards-v2/${detail.job_card_id}/sign-off`, {
        method: "POST",
        // SignOffRequest field is `signed_by_name` (NOT `signed_by`) — backend
        // ignores unknown fields silently, so sending the wrong key would
        // discard the operator's typed name and fall back to the JWT user.
        body: JSON.stringify({ role: SIGNOFF_ROLE, signed_by_name: name.trim() }),
      });
      if (!res.ok) {
        let txt: string;
        try { txt = await res.text(); } catch { txt = `HTTP ${res.status}`; }
        throw new Error(txt || `HTTP ${res.status}`);
      }
      setFeedback({ kind: "ok", msg: "Signed." });
      onReload();
    } catch (err) {
      setFeedback({ kind: "err", msg: err instanceof Error ? err.message : "Sign-off failed." });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Panel title="Production Head">
        <div
          className={[
            "rounded-md border p-4",
            isSigned ? "bg-[#eaf6ed] border-[#b6dbb1]" : "bg-[var(--surface-subtle)] border-[var(--aws-border)]",
          ].join(" ")}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              {isSigned ? (
                <>
                  <div className="text-[14px] font-semibold text-[var(--text-success)]">{signedBy}</div>
                  {signedAt ? (
                    <div className="text-[11px] text-[var(--text-secondary)] mt-0.5">Signed {fmtDateTime(signedAt)}</div>
                  ) : null}
                </>
              ) : (
                <>
                  <div className="text-[14px] font-semibold text-[var(--text-secondary)]">Pending sign-off</div>
                  <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
                    {canSign
                      ? "Production has been completed — ready to sign."
                      : "Production must be completed before sign-off."}
                  </div>
                </>
              )}
            </div>
            {!isSigned ? (
              <button
                type="button"
                onClick={promptAndSign}
                disabled={!canSign || submitting}
                className={[
                  "h-8 px-3 rounded-[2px] text-[12px] font-semibold border",
                  !canSign || submitting
                    ? "bg-[var(--surface-disabled)] border-[var(--aws-border)] text-[var(--text-disabled)] cursor-not-allowed"
                    : "bg-gradient-to-b from-[#f7dfa5] to-[#f0c14b] border-[#a88734] hover:from-[#f5d78e] hover:to-[#eeb933] text-[var(--text-primary)]",
                ].join(" ")}
              >
                {submitting ? "Signing…" : "Sign"}
              </button>
            ) : null}
          </div>
        </div>
        {feedback ? (
          <p className={["mt-3 text-[12px]", feedback.kind === "ok" ? "text-[var(--text-success)]" : "text-[var(--aws-error)]"].join(" ")}>
            {feedback.msg}
          </p>
        ) : null}
      </Panel>

      {rows.length > 0 ? (
        <Panel title={`All sign-offs · ${rows.length}`}>
          <RowTable
            rows={rows}
            columns={[
              { key: "role",      label: "Role" },
              { key: "signed_by", label: "Signed by" },
              { key: "signed_at", label: "Signed at", render: (v) => fmtDateTime(String(v ?? "")) },
              { key: "notes",     label: "Notes" },
            ]}
          />
        </Panel>
      ) : null}
    </>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
//  ACCOUNTING TAB — mirrors OutputAccountingFragment exactly.
//
//  Single Save Output POST → /job-cards-v2/{id}/outputs with body shape from
//  OutputV2Request.java:
//    fg_actual_kg, fg_actual_units, fg_expected_kg, fg_expected_units,
//    rm_consumed[], pm_consumed[], process_loss_kg, byproducts[],
//    balance_materials[]
//
//  Layout:
//    Card 1 (FG Output) — expected (RO), RM issued (RO), actual (units/kg),
//                         consumption (one input per RM+PM BOM line),
//                         rejection rows (dynamic, "+ Add another"),
//                         process loss + computed loss %, extra-giveaway
//                         (final stage only).
//    Card 2 (Balance Material) — one row per BOM article, defaults to 0.
//    Card 3 (Accounting Summary) — read-only reconciliation.
// ═════════════════════════════════════════════════════════════════════════════

type RejectionRow = { category: string; bomLineId: number | null; materialName: string; qty: string; remarks: string };

function AccountingTab({ detail, onReload }: { detail: JobCardDetail; onReload: () => void }) {
  // ── Catalogue: every RM+PM article on the BOM. Primary source is the
  // backend's bom_lines (surfaced on every stage); fallback is the per-JC
  // indent rows (rm_indents + pm_indents) — same fallback the Java code
  // uses when bom_lines is empty.
  const articles: { bom_line_id: number | null; material_sku_name: string; item_type: string; uom: string }[] =
    useMemo(() => {
      const bom = detail.bom_lines ?? [];
      if (bom.length > 0) {
        return bom.map((b) => ({
          bom_line_id: b.bom_line_id,
          material_sku_name: b.material_sku_name,
          item_type: b.item_type || "RM",
          uom: b.uom || "kg",
        }));
      }
      const out: { bom_line_id: number | null; material_sku_name: string; item_type: string; uom: string }[] = [];
      for (const r of detail.rm_indents ?? []) out.push({ bom_line_id: r.bom_line_id ?? null, material_sku_name: r.material_sku_name ?? "Unknown", item_type: "RM", uom: r.uom || "kg" });
      for (const p of detail.pm_indents ?? []) out.push({ bom_line_id: p.bom_line_id ?? null, material_sku_name: p.material_sku_name ?? "Unknown", item_type: "PM", uom: p.uom || "kg" });
      return out;
    }, [detail]);

  // ── Initial state — prefilled from section_5_output the same way the
  // Android OutputAccountingFragment.populateDataInner does it. The
  // useEffect below re-syncs whenever those backend values change, so a
  // successful save followed by an onReload() also refreshes the form
  // (otherwise the operator would see stale empty values after re-mount
  // with cached props vs. the actual saved record).
  const fgKgFromServer    = detail.section_5_output?.fg_actual_kg    != null ? String(detail.section_5_output.fg_actual_kg)    : "";
  const fgUnitsFromServer = detail.section_5_output?.fg_actual_units != null ? String(detail.section_5_output.fg_actual_units) : "";
  const lossFromServer    = detail.section_5_output?.process_loss_kg != null ? String(detail.section_5_output.process_loss_kg) : "";

  const [fgActualUnits, setFgActualUnits] = useState(fgUnitsFromServer);
  const [fgActualKg,    setFgActualKg]    = useState(fgKgFromServer);
  const [processLoss,   setProcessLoss]   = useState(lossFromServer);

  // Re-sync on detail reload. Matches Android: every detail observer fire
  // re-prefills the EditTexts. Deferred past the effect body so the
  // react-hooks/set-state-in-effect rule doesn't fire on the cascading
  // setStates.
  useEffect(() => {
    queueMicrotask(() => {
      setFgActualKg(fgKgFromServer);
      setFgActualUnits(fgUnitsFromServer);
      setProcessLoss(lossFromServer);
    });
  }, [fgKgFromServer, fgUnitsFromServer, lossFromServer]);
  const [extraGiveawayBom,  setExtraGiveawayBom]  = useState("");
  const [extraGiveawayQty,  setExtraGiveawayQty]  = useState("");

  // One consumption qty per BOM article. Empty string ⇒ not recorded;
  // 0 is a valid explicit zero. (Backend skips zero/empty on save.)
  const [consumption, setConsumption] = useState<Record<string, string>>({});
  // One balance qty per BOM article. Defaults to 0 on save when blank —
  // the operator's explicit ask per the Android comment.
  const [balance, setBalance] = useState<Record<string, string>>({});
  const [rejections, setRejections] = useState<RejectionRow[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  // Helpers ─────────────────────────────────────────────────────────────────
  const expectedUnits = detail.section_1_product?.expected_units ?? null;
  const expectedKg    = detail.section_1_product?.batch_size_kg ?? null;
  const netWtPerUnit  = detail.section_1_product?.net_wt_per_unit_kg ?? null;

  // RM Issued (kg): sum of rm_indents.issued_qty. Stages 2+ stay at 0
  // because RM is only issued on stage 1 — same accounting as the Android.
  const rmIssuedKg = useMemo(() => {
    return (detail.rm_indents ?? []).reduce((acc, r) => acc + num(String(r.issued_qty ?? 0)), 0);
  }, [detail.rm_indents]);

  // Auto-fill kg when the operator enters units (Android: autoCalcFgActualKg).
  function onChangeUnits(v: string) {
    setFgActualUnits(v);
    if (netWtPerUnit && netWtPerUnit > 0) {
      const u = parseInt(v, 10);
      if (Number.isFinite(u)) setFgActualKg((u * netWtPerUnit).toFixed(2));
    }
  }

  const processLossPct = useMemo(() => {
    const pl = num(processLoss);
    if (rmIssuedKg <= 0 || !pl) return null;
    return (pl / rmIssuedKg) * 100;
  }, [processLoss, rmIssuedKg]);

  // Accounting Summary computed totals ─────────────────────────────────────
  const summary = useMemo(() => {
    const rejTotal = rejections.reduce((acc, r) => acc + (r.category !== "control_sample" ? num(r.qty) : 0), 0);
    const ctrlSample = rejections.reduce((acc, r) => acc + (r.category === "control_sample" ? num(r.qty) : 0), 0);
    const balTotal = Object.values(balance).reduce((acc, v) => acc + num(v), 0);
    const offgradeTotal = rejTotal; // off-grade = sum of non-control_sample rejections
    const fgOutKg = num(fgActualKg);
    const lossKg  = num(processLoss);
    const totalAccounted = fgOutKg + lossKg + balTotal + offgradeTotal + ctrlSample;
    const balanceDiff = rmIssuedKg > 0 ? rmIssuedKg - totalAccounted : null;
    const isBalanced = balanceDiff != null ? Math.abs(balanceDiff) < BALANCE_TOLERANCE_KG : null;
    const totalLossPct = rmIssuedKg > 0 ? ((lossKg + offgradeTotal + ctrlSample) / rmIssuedKg) * 100 : null;
    return {
      fgOutKg, lossKg, balTotal, offgradeTotal, ctrlSample,
      processLossPct, totalLossPct, balanceDiff, isBalanced,
    };
  }, [fgActualKg, processLoss, processLossPct, balance, rejections, rmIssuedKg]);

  // Rejection row mutators ─────────────────────────────────────────────────
  function addRejection() {
    setRejections((rs) => [...rs, { category: "", bomLineId: null, materialName: "", qty: "", remarks: "" }]);
  }
  function updateRejection(i: number, patch: Partial<RejectionRow>) {
    setRejections((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }
  function removeRejection(i: number) {
    setRejections((rs) => rs.filter((_, j) => j !== i));
  }

  // Submit ─────────────────────────────────────────────────────────────────
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);

    // null vs 0 distinction:
    //   - blank input → null (operator hasn't recorded yet)
    //   - typed "0"   → 0 (legitimate zero-output batch)
    // The previous `num(fgActualKg) || null` dropped a legitimate 0
    // because `0 || null` is null. Check the string for emptiness first.
    const body: Record<string, unknown> = {
      fg_actual_kg:      fgActualKg.trim()    === "" ? null : num(fgActualKg),
      fg_actual_units:   fgActualUnits.trim() === "" ? null : parseInt(fgActualUnits, 10),
      fg_expected_kg:    expectedKg,
      fg_expected_units: expectedUnits,
      // Backend's _coerce_float treats empty string and 0 the same, so it
      // is safe to default a blank process loss to 0 here.
      process_loss_kg:   processLoss.trim()   === "" ? 0    : num(processLoss),
    };

    // Per-line consumption — split RM vs PM by article.item_type.
    const rmCons: Array<Record<string, unknown>> = [];
    const pmCons: Array<Record<string, unknown>> = [];
    for (const a of articles) {
      const key = a.bom_line_id != null ? `b${a.bom_line_id}` : `n${a.material_sku_name}`;
      const v = num(consumption[key]);
      if (v <= 0) continue;
      const entry = { bom_line_id: a.bom_line_id, material_sku_name: a.material_sku_name, consumed_qty: v, uom: a.uom };
      if (a.item_type === "PM") pmCons.push(entry); else rmCons.push(entry);
    }
    body.rm_consumed = rmCons;
    body.pm_consumed = pmCons;

    // Rejections → split: control_sample reroutes to balance_materials,
    // others go to byproducts. Same routing as Android.
    const byproducts: Array<Record<string, unknown>> = [];
    const balanceMaterials: Array<Record<string, unknown>> = [];
    for (const r of rejections) {
      const q = num(r.qty);
      if (!r.category || q <= 0) continue;
      if (r.category === "control_sample") {
        balanceMaterials.push({ bom_line_id: r.bomLineId, balance_type: "control_sample", material_name: r.materialName || "Unknown", qty_kg: q, remarks: r.remarks || null });
      } else {
        byproducts.push({ category: r.category, qty_kg: q, remarks: r.remarks || null });
      }
    }
    body.byproducts = byproducts;

    // Balance materials: one entry per BOM article (empty → 0), balance_type="returned".
    for (const a of articles) {
      const key = a.bom_line_id != null ? `b${a.bom_line_id}` : `n${a.material_sku_name}`;
      const v = balance[key]?.trim() === "" ? 0 : num(balance[key]);
      balanceMaterials.push({ bom_line_id: a.bom_line_id, balance_type: "returned", material_name: a.material_sku_name, qty_kg: v, remarks: null });
    }

    // Extra giveaway (final stage only)
    const isFinalStage = isFinalStageJc(detail);
    if (isFinalStage) {
      const extraKg = num(extraGiveawayQty);
      if (extraKg > 0) {
        const a = articles.find((x) => (x.bom_line_id != null ? `b${x.bom_line_id}` : `n${x.material_sku_name}`) === extraGiveawayBom);
        balanceMaterials.push({ bom_line_id: a?.bom_line_id ?? null, balance_type: "extra_given", material_name: a?.material_sku_name ?? "Unknown", qty_kg: extraKg, remarks: null });
      }
    }
    body.balance_materials = balanceMaterials;

    setSubmitting(true);
    try {
      const res = await apiFetch(`/api/v1/production/job-cards-v2/${detail.job_card_id}/outputs`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok || (data && (data as { error?: string }).error)) {
        const msg = (data && ((data as { message?: string }).message || (data as { error?: string }).error)) || `HTTP ${res.status}`;
        throw new Error(String(msg));
      }
      setFeedback({ kind: "ok", msg: "Output saved." });
      onReload();
    } catch (err) {
      setFeedback({ kind: "err", msg: err instanceof Error ? err.message : "Failed to save output." });
    } finally {
      setSubmitting(false);
    }
  }

  const isFinalStage = isFinalStageJc(detail);

  return (
    <form onSubmit={onSubmit}>
      {/* ── FG Output ───────────────────────────────────────────────────── */}
      <Panel title="FG Output">
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3 mb-4">
          <KV label="FG Expected Units" value={expectedUnits != null ? String(expectedUnits) : "—"} />
          <KV label="FG Expected Kg"    value={fmtKg(expectedKg)} />
          <KV label="RM Issued (kg)"    value={fmtKg(rmIssuedKg)} />
        </dl>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          <FormNumber label="FG Actual Units" value={fgActualUnits} onChange={onChangeUnits} disabled={submitting} />
          <FormNumber label="FG Actual Kg"    value={fgActualKg}    onChange={setFgActualKg}    disabled={submitting} />
        </div>

        {/* Material Consumption — one row per BOM article */}
        <SubsectionLabel>Material Consumption</SubsectionLabel>
        {articles.length === 0 ? (
          <EmptyHint>No BOM articles attached to this job card.</EmptyHint>
        ) : (
          <div className="space-y-2 mb-4">
            {articles.map((a) => {
              const key = a.bom_line_id != null ? `b${a.bom_line_id}` : `n${a.material_sku_name}`;
              return (
                <div key={key} className="grid grid-cols-12 gap-2 items-center">
                  <div className="col-span-7 text-[13px] text-[var(--text-primary)] truncate" title={a.material_sku_name}>
                    {a.material_sku_name} <span className="text-[var(--text-muted)] text-[11px]">({a.item_type})</span>
                  </div>
                  <input
                    type="number" step="any" placeholder={`Qty (${a.uom})`}
                    className={`${inputCls} col-span-3`}
                    value={consumption[key] ?? ""}
                    onChange={(e) => setConsumption((c) => ({ ...c, [key]: e.target.value }))}
                    disabled={submitting}
                  />
                  <span className="col-span-2 text-[11px] text-[var(--text-muted)]">{a.uom}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* Rejection / Off-grade — dynamic rows */}
        <SubsectionLabel>Rejection / Off-grade</SubsectionLabel>
        {rejections.length === 0 ? (
          <EmptyHint>No rejection entries. Click + Add another to record one.</EmptyHint>
        ) : (
          <div className="space-y-2 mb-2">
            {rejections.map((r, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 items-start">
                <select
                  className={`${inputCls} col-span-3`}
                  value={r.category}
                  onChange={(e) => updateRejection(i, { category: e.target.value })}
                  disabled={submitting}
                >
                  {REJECTION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <select
                  className={`${inputCls} col-span-4`}
                  value={r.bomLineId != null ? `b${r.bomLineId}` : (r.materialName ? `n${r.materialName}` : "")}
                  onChange={(e) => {
                    const v = e.target.value;
                    const a = articles.find((x) => (x.bom_line_id != null ? `b${x.bom_line_id}` : `n${x.material_sku_name}`) === v);
                    updateRejection(i, { bomLineId: a?.bom_line_id ?? null, materialName: a?.material_sku_name ?? "" });
                  }}
                  disabled={submitting}
                >
                  <option value="">— Article —</option>
                  {articles.map((a) => {
                    const v = a.bom_line_id != null ? `b${a.bom_line_id}` : `n${a.material_sku_name}`;
                    return <option key={v} value={v}>{a.material_sku_name}</option>;
                  })}
                </select>
                <input
                  type="number" step="any" placeholder="Qty (kg)"
                  className={`${inputCls} col-span-2`}
                  value={r.qty}
                  onChange={(e) => updateRejection(i, { qty: e.target.value })}
                  disabled={submitting}
                />
                <input
                  type="text" placeholder="Remarks"
                  className={`${inputCls} col-span-2`}
                  value={r.remarks}
                  onChange={(e) => updateRejection(i, { remarks: e.target.value })}
                  disabled={submitting}
                />
                <button
                  type="button"
                  onClick={() => removeRejection(i)}
                  disabled={submitting}
                  className="col-span-1 h-8 text-[12px] text-[var(--aws-error)] hover:underline"
                  title="Remove row"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={addRejection}
          disabled={submitting}
          className="text-[12px] text-[var(--aws-link)] hover:underline mb-4"
        >
          + Add another
        </button>

        {/* Process Loss + computed % */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
          <FormNumber label="Process Loss (kg)" value={processLoss} onChange={setProcessLoss} disabled={submitting} />
          <div>
            <FormLabel>Process Loss %</FormLabel>
            <div className={`${inputCls} bg-[var(--surface-subtle)] flex items-center`}>
              {processLossPct != null ? `${processLossPct.toFixed(2)}%` : "—"}
            </div>
          </div>
        </div>

        {/* Extra Giveaway — final stage only */}
        {isFinalStage ? (
          <>
            <SubsectionLabel className="mt-4">Extra Giveaway</SubsectionLabel>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <FormSelect
                label="Article"
                value={extraGiveawayBom}
                onChange={setExtraGiveawayBom}
                disabled={submitting}
                options={[
                  { value: "", label: "— Article —" },
                  ...articles.map((a) => ({
                    value: a.bom_line_id != null ? `b${a.bom_line_id}` : `n${a.material_sku_name}`,
                    label: a.material_sku_name,
                  })),
                ]}
              />
              <FormNumber label="Qty (kg)" value={extraGiveawayQty} onChange={setExtraGiveawayQty} disabled={submitting} />
            </div>
          </>
        ) : null}
      </Panel>

      {/* ── Balance Material ────────────────────────────────────────────── */}
      <Panel title="Balance Material">
        {articles.length === 0 ? (
          <EmptyHint>No BOM articles attached to this job card.</EmptyHint>
        ) : (
          <div className="space-y-2">
            {articles.map((a) => {
              const key = a.bom_line_id != null ? `b${a.bom_line_id}` : `n${a.material_sku_name}`;
              return (
                <div key={key} className="grid grid-cols-12 gap-2 items-center">
                  <div className="col-span-8 text-[13px] text-[var(--text-primary)] truncate" title={a.material_sku_name}>
                    {a.material_sku_name} <span className="text-[var(--text-muted)] text-[11px]">({a.item_type})</span>
                  </div>
                  <input
                    type="number" step="any" placeholder="0"
                    className={`${inputCls} col-span-3`}
                    value={balance[key] ?? ""}
                    onChange={(e) => setBalance((b) => ({ ...b, [key]: e.target.value }))}
                    disabled={submitting}
                  />
                  <span className="col-span-1 text-[11px] text-[var(--text-muted)]">{a.uom}</span>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      {/* ── Accounting Summary ──────────────────────────────────────────── */}
      <Panel title="Accounting Summary">
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
          <KV label="FG Output (kg)"      value={fmtNum(summary.fgOutKg)} />
          <KV label="Process Loss"        value={fmtNum(summary.lossKg)} />
          <KV label="Balance Material"    value={fmtNum(summary.balTotal)} />
          <KV label="Off-grade Total"     value={fmtNum(summary.offgradeTotal)} />
          <KV label="Control Sample"      value={fmtNum(summary.ctrlSample)} />
          <KV label="Process Loss %"      value={summary.processLossPct != null ? `${summary.processLossPct.toFixed(2)}%` : "—"} />
          <KV label="Total Loss %"        value={summary.totalLossPct != null ? `${summary.totalLossPct.toFixed(2)}%` : "—"} />
          <KV label="Balance Difference"  value={summary.balanceDiff != null ? `${summary.balanceDiff.toFixed(2)} kg` : "—"} />
          <KV
            label="Is Balanced"
            value={
              summary.isBalanced == null ? "—" :
              summary.isBalanced
                ? <span className="text-[var(--text-success)] font-semibold">Yes</span>
                : <span className="text-[var(--aws-error)] font-semibold">No</span>
            }
          />
        </dl>
      </Panel>

      <FormFooter feedback={feedback} submitting={submitting} submitLabel="SAVE OUTPUT" />
    </form>
  );
}

function isFinalStageJc(d: JobCardDetail): boolean {
  // Final stage = output_kind == 'FG'. The Android version computes this via
  // total_stages == step_number, but output_kind is a clean proxy that
  // doesn't require the chain length.
  return (d.output_kind || "").toUpperCase() === "FG";
}

function SubsectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`text-[11px] uppercase tracking-wide font-semibold text-[var(--text-secondary)] mt-2 mb-2 ${className ?? ""}`}>
      {children}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
//  QUALITY TAB — mirrors QualityFragment exactly.
//
//  Five sections:
//    1. Metal Detection records (read-only list)
//    2. Add Metal Check form        → POST /metal-detection (button per click)
//    3. Weight Checks (target/tolerance + 20 samples; net/gross/leak)
//    4. Environment (4 fixed params)
//    5. QC Sample Consumed (sample weight)
//    6. QC Verification (passed + findings)
//
//  Bottom Save Quality dispatches chained POSTs:
//    weight samples (one per sample) → environment params (one per param)
//    → QC verification (as a remark on v2: addRemark with structured content)
// ═════════════════════════════════════════════════════════════════════════════

function QualityTab({ detail, onReload }: { detail: JobCardDetail; onReload: () => void }) {
  const metalRecords = detail.annexure_a_b_metal_detection ?? [];
  const envRecords   = detail.annexure_c_environment ?? [];

  // ── Metal Detection (single-add form) ──────────────────────────────────
  const [mdCheckType, setMdCheckType] = useState<string>(METAL_CHECK_TYPES[1].value); // post_packaging default
  const [mdFe, setMdFe] = useState<boolean | null>(null);
  const [mdNfe, setMdNfe] = useState<boolean | null>(null);
  const [mdSs, setMdSs] = useState<boolean | null>(null);
  const [mdSeal, setMdSeal] = useState<boolean | null>(null);
  const [mdWt, setMdWt] = useState<boolean | null>(null);
  const [mdFailed, setMdFailed] = useState("");
  const [mdDough, setMdDough] = useState("");
  const [mdOven, setMdOven] = useState("");
  const [mdBaking, setMdBaking] = useState("");
  const [mdRemarks, setMdRemarks] = useState("");
  const [addingMetal, setAddingMetal] = useState(false);

  // ── Weight Checks ──────────────────────────────────────────────────────
  const [targetWt, setTargetWt] = useState("");
  const [tolerance, setTolerance] = useState("");
  const [samples, setSamples] = useState(
    Array.from({ length: WEIGHT_SAMPLES }, () => ({ net: "", gross: "", leak: false })),
  );
  function updateSample(i: number, patch: Partial<{ net: string; gross: string; leak: boolean }>) {
    setSamples((arr) => arr.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  }

  // ── Environment ────────────────────────────────────────────────────────
  const [envValues, setEnvValues] = useState<Record<string, string>>({});

  // ── QC Sample Consumed ────────────────────────────────────────────────
  const [qcSampleGm, setQcSampleGm] = useState("");

  // ── QC Verification ────────────────────────────────────────────────────
  const [qcPassed, setQcPassed] = useState<boolean | null>(null);
  const [qcFindings, setQcFindings] = useState("");

  const [savingQuality, setSavingQuality] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  // ── Add metal-check (standalone POST) ──────────────────────────────────
  async function addMetalCheck() {
    setFeedback(null);
    const body: Record<string, unknown> = {
      check_type: mdCheckType || "post_packaging",
      failed_units: mdFailed ? parseInt(mdFailed, 10) : 0,
    };
    if (mdFe  !== null) body.fe_pass  = mdFe;
    if (mdNfe !== null) body.nfe_pass = mdNfe;
    if (mdSs  !== null) body.ss_pass  = mdSs;
    if (mdRemarks.trim()) body.remarks = mdRemarks.trim();
    // Seal/Wt/Dough/Oven/Baking aren't on the v2 schema (see comment in
    // QualityFragment.saveMetalDetection). Captured in the form for parity
    // but not transmitted on v2.

    setAddingMetal(true);
    try {
      const res = await apiFetch(`/api/v1/production/job-cards-v2/${detail.job_card_id}/metal-detection`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setFeedback({ kind: "ok", msg: "Metal check saved." });
      // Reset just the metal form
      setMdFe(null); setMdNfe(null); setMdSs(null); setMdSeal(null); setMdWt(null);
      setMdFailed(""); setMdDough(""); setMdOven(""); setMdBaking(""); setMdRemarks("");
      onReload();
    } catch (e) {
      setFeedback({ kind: "err", msg: e instanceof Error ? e.message : "Failed to save metal check." });
    } finally {
      setAddingMetal(false);
    }
  }

  // ── Save Quality (chained) ─────────────────────────────────────────────
  // Mirrors saveQuality → submitWeightChecksChained → submitEnvironmentChained
  // → saveQcVerificationChained from QualityFragment.java. Each phase POSTs
  // one row at a time and surfaces a "saving X of N" progress hint between
  // requests. A failure mid-chain aborts and leaves earlier successful
  // writes intact on the server (operator can retry the failed phase).
  async function saveQuality() {
    setFeedback(null);
    setSavingQuality(true);
    try {
      // ── Weight samples ─────────────────────────────────────────────
      const samplesToSend = samples
        .map((s, i) => ({ idx: i + 1, ...s }))
        .filter((s) => s.net.trim() !== "" || s.gross.trim() !== "");
      for (let k = 0; k < samplesToSend.length; k++) {
        setProgress(`Saving sample ${k + 1} of ${samplesToSend.length}…`);
        const s = samplesToSend[k];
        const body: Record<string, unknown> = {
          sample_number: s.idx,
          leak_test_pass: !!s.leak,
        };
        if (s.net.trim())   body.net_weight   = parseFloat(s.net);
        if (s.gross.trim()) body.gross_weight = parseFloat(s.gross);
        const res = await apiFetch(`/api/v1/production/job-cards-v2/${detail.job_card_id}/weight-checks`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`Sample ${s.idx} failed: HTTP ${res.status}`);
      }

      // ── Environment params ────────────────────────────────────────
      // EnvironmentAddRequest.value is `str | None` on the backend — same
      // as the Android EnvironmentRequest.Param.value field — so we send
      // the raw operator input as a string instead of parsing to float.
      // Brine salinity / temperature etc. are sometimes recorded as
      // ranges ("18-22") that wouldn't survive parseFloat.
      const envEntries = Object.entries(envValues).filter(([, v]) => v.trim() !== "");
      for (let k = 0; k < envEntries.length; k++) {
        const [paramKey, val] = envEntries[k];
        setProgress(`Saving environment ${k + 1} of ${envEntries.length}…`);
        const body: Record<string, unknown> = {
          parameter_name: paramKey,
          value: val.trim(),
        };
        const res = await apiFetch(`/api/v1/production/job-cards-v2/${detail.job_card_id}/environment`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`Environment "${paramKey}" failed: HTTP ${res.status}`);
      }

      // ── QC Verification (recorded as a remark on v2) ──────────────
      const hasFindings = qcFindings.trim().length > 0;
      const failed = qcPassed === false;
      if (hasFindings || failed) {
        setProgress("Finalising QC verification…");
        const remark = `[QC verdict: ${failed ? "FAIL" : qcPassed ? "PASS" : "—"}] ${hasFindings ? qcFindings.trim() : "(no findings recorded)"}`;
        const body = {
          remark_type: failed ? "deviation" : "corrective_action",
          content: remark,
        };
        const res = await apiFetch(`/api/v1/production/job-cards-v2/${detail.job_card_id}/remarks`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`QC verdict remark failed: HTTP ${res.status}`);
      }

      setFeedback({ kind: "ok", msg: "Quality saved." });
      onReload();
    } catch (e) {
      setFeedback({ kind: "err", msg: e instanceof Error ? e.message : "Failed to save quality." });
    } finally {
      setProgress(null);
      setSavingQuality(false);
    }
  }

  return (
    <>
      {/* ── 1. Metal Detection records ──────────────────────────────────── */}
      <Panel title={`Metal Detection · ${metalRecords.length} record${metalRecords.length === 1 ? "" : "s"}`}>
        {metalRecords.length === 0 ? (
          <EmptyHint>No metal-detection checks recorded yet.</EmptyHint>
        ) : (
          <RowTable
            rows={metalRecords}
            columns={[
              { key: "recorded_at",  label: "When", render: (v) => fmtDateTime(String(v ?? "")) },
              { key: "check_type",   label: "Type" },
              { key: "fe_pass",      label: "Fe",  render: (v) => renderPass(v) },
              { key: "nfe_pass",     label: "NFe", render: (v) => renderPass(v) },
              { key: "ss_pass",      label: "SS",  render: (v) => renderPass(v) },
              { key: "failed_units", label: "Failed" },
              { key: "remarks",      label: "Remarks" },
            ]}
          />
        )}
      </Panel>

      {/* ── 2. Add Metal Check ──────────────────────────────────────────── */}
      <Panel title="Add Metal Check">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-3">
          <FormSelect label="Check type" value={mdCheckType} onChange={setMdCheckType} disabled={addingMetal} options={METAL_CHECK_TYPES} />
        </div>
        <div className="grid grid-cols-3 gap-3 mb-3">
          <FormCheckbox label="Fe"  value={mdFe}  onChange={setMdFe}  disabled={addingMetal} />
          <FormCheckbox label="NFe" value={mdNfe} onChange={setMdNfe} disabled={addingMetal} />
          <FormCheckbox label="SS"  value={mdSs}  onChange={setMdSs}  disabled={addingMetal} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
          <FormNumber label="Failed units" value={mdFailed} onChange={setMdFailed} disabled={addingMetal} />
          <FormCheckbox label="Seal Check" value={mdSeal} onChange={setMdSeal} disabled={addingMetal} />
          <FormCheckbox label="Wt Check"   value={mdWt}   onChange={setMdWt}   disabled={addingMetal} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
          <FormNumber label="Dough Temp (°C)"  value={mdDough}  onChange={setMdDough}  disabled={addingMetal} />
          <FormNumber label="Oven Temp (°C)"   value={mdOven}   onChange={setMdOven}   disabled={addingMetal} />
          <FormNumber label="Baking Temp (°C)" value={mdBaking} onChange={setMdBaking} disabled={addingMetal} />
        </div>
        <FormText label="Remarks" value={mdRemarks} onChange={setMdRemarks} disabled={addingMetal} />
        <div className="mt-3 flex items-center justify-end">
          <button
            type="button"
            onClick={addMetalCheck}
            disabled={addingMetal}
            className={[
              "h-8 px-3 rounded-[2px] text-[13px] font-semibold border",
              addingMetal
                ? "bg-[#f2c399] border-[#f2c399] cursor-not-allowed text-[var(--text-primary)]"
                : "bg-gradient-to-b from-[#f7dfa5] to-[#f0c14b] border-[#a88734] hover:from-[#f5d78e] hover:to-[#eeb933] text-[var(--text-primary)]",
            ].join(" ")}
          >
            {addingMetal ? "Saving…" : "Add metal check"}
          </button>
        </div>
      </Panel>

      {/* ── 3. Weight Checks ────────────────────────────────────────────── */}
      <Panel title="Weight Checks">
        <p className="text-[11px] text-[var(--text-muted)] italic mb-3">
          Target weight and tolerance are operator-reference only — the v2
          backend stores the samples but not the target/tolerance header.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
          <FormNumber label="Target wt (g)" value={targetWt} onChange={setTargetWt} disabled={savingQuality} />
          <FormNumber label="Tolerance (±g)" value={tolerance} onChange={setTolerance} disabled={savingQuality} />
        </div>
        <SubsectionLabel>Samples ({WEIGHT_SAMPLES})</SubsectionLabel>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead className="text-[10px] uppercase text-[var(--text-muted)]">
              <tr>
                <th className="text-left px-2 py-1">#</th>
                <th className="text-left px-2 py-1">Net (g)</th>
                <th className="text-left px-2 py-1">Gross (g)</th>
                <th className="text-left px-2 py-1">Leak pass</th>
              </tr>
            </thead>
            <tbody>
              {samples.map((s, i) => (
                <tr key={i} className="border-b border-[var(--aws-border)]">
                  <td className="px-2 py-1 text-[var(--text-secondary)]">{i + 1}</td>
                  <td className="px-2 py-1">
                    <input type="number" step="any" className={inputCls} value={s.net} onChange={(e) => updateSample(i, { net: e.target.value })} disabled={savingQuality} />
                  </td>
                  <td className="px-2 py-1">
                    <input type="number" step="any" className={inputCls} value={s.gross} onChange={(e) => updateSample(i, { gross: e.target.value })} disabled={savingQuality} />
                  </td>
                  <td className="px-2 py-1">
                    <input type="checkbox" className="accent-[var(--aws-orange)] w-4 h-4" checked={s.leak} onChange={(e) => updateSample(i, { leak: e.target.checked })} disabled={savingQuality} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* ── 4. Environment ──────────────────────────────────────────────── */}
      <Panel title={`Environment · ${envRecords.length} previous reading${envRecords.length === 1 ? "" : "s"}`}>
        {envRecords.length > 0 ? (
          <div className="mb-3">
            <RowTable
              rows={envRecords}
              columns={[
                { key: "recorded_at",    label: "When", render: (v) => fmtDateTime(String(v ?? "")) },
                { key: "parameter_name", label: "Parameter" },
                { key: "value",          label: "Value" },
                { key: "unit",           label: "Unit" },
              ]}
            />
          </div>
        ) : null}
        <SubsectionLabel>New readings</SubsectionLabel>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {ENV_PARAMS.map((p) => (
            <FormText
              key={p.key}
              label={p.label}
              value={envValues[p.key] ?? ""}
              onChange={(v) => setEnvValues((m) => ({ ...m, [p.key]: v }))}
              disabled={savingQuality}
              placeholder="value"
            />
          ))}
        </div>
      </Panel>

      {/* ── 5. QC Sample Consumed ──────────────────────────────────────── */}
      <Panel title="QC Sample Consumed">
        <p className="text-[11px] text-[var(--text-muted)] italic mb-3">
          Operator-reference only — the v2 backend doesn&apos;t persist this
          field. Recorded for parity with the Android form.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <FormNumber label="Sample weight (g)" value={qcSampleGm} onChange={setQcSampleGm} disabled={savingQuality} placeholder="e.g. 50" />
        </div>
      </Panel>

      {/* ── 6. QC Verification ──────────────────────────────────────────── */}
      <Panel title="QC Verification">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
          <FormCheckbox label="QC Passed" value={qcPassed} onChange={setQcPassed} disabled={savingQuality} />
        </div>
        <FormText label="Findings / remarks" value={qcFindings} onChange={setQcFindings} disabled={savingQuality} />
      </Panel>

      {/* ── Save Quality ────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 mb-6">
        <button
          type="button"
          onClick={saveQuality}
          disabled={savingQuality}
          className={[
            "h-9 px-4 rounded-[2px] text-[13px] font-bold border tracking-wide",
            savingQuality
              ? "bg-[#f2c399] border-[#f2c399] cursor-not-allowed text-[var(--text-primary)]"
              : "bg-gradient-to-b from-[#f7dfa5] to-[#f0c14b] border-[#a88734] hover:from-[#f5d78e] hover:to-[#eeb933] text-[var(--text-primary)]",
          ].join(" ")}
        >
          {savingQuality ? "Saving…" : "SAVE QUALITY"}
        </button>
        {progress ? (
          <span className="text-[12px] text-[var(--text-secondary)]">{progress}</span>
        ) : feedback ? (
          <span className={["text-[12px]", feedback.kind === "ok" ? "text-[var(--text-success)]" : "text-[var(--aws-error)]"].join(" ")}>
            {feedback.msg}
          </span>
        ) : null}
      </div>
    </>
  );
}

function renderPass(v: unknown): React.ReactNode {
  if (v === true || v === "true") return <span className="text-[var(--text-success)] font-semibold">Pass</span>;
  if (v === false || v === "false") return <span className="text-[var(--aws-error)] font-semibold">Fail</span>;
  return "—";
}

// ── Form primitives ───────────────────────────────────────────────────────

function FormLabel({ children }: { children: React.ReactNode }) {
  return <span className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">{children}</span>;
}

const inputCls =
  "w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#00a1c9] focus:shadow-[0_0_0_1px_#00a1c9] disabled:bg-[var(--surface-disabled)] disabled:text-[#879596]";

function FormText({ label, value, onChange, disabled, placeholder }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; placeholder?: string }) {
  return (
    <label className="block">
      <FormLabel>{label}</FormLabel>
      <input type="text" className={inputCls} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} placeholder={placeholder} />
    </label>
  );
}
function FormNumber({ label, value, onChange, disabled, placeholder }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; placeholder?: string }) {
  return (
    <label className="block">
      <FormLabel>{label}</FormLabel>
      <input type="number" step="any" className={inputCls} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} placeholder={placeholder} />
    </label>
  );
}
function FormSelect({ label, value, onChange, disabled, options }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; options: { value: string; label: string }[] }) {
  return (
    <label className="block">
      <FormLabel>{label}</FormLabel>
      <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function FormCheckbox({ label, value, onChange, disabled }: { label: string; value: boolean | null; onChange: (v: boolean | null) => void; disabled?: boolean }) {
  // Three-state Pass / Fail / —. Matches the Android tri-state captured by
  // the various pass checkboxes (cbFePass etc.) where null means "not
  // recorded" rather than "fail".
  function cycle() {
    if (value === null) onChange(true);
    else if (value === true) onChange(false);
    else onChange(null);
  }
  const display = value === null ? "—" : value ? "Pass" : "Fail";
  const color =
    value === null ? "bg-white text-[var(--text-secondary)]" :
    value ? "bg-[#eaf6ed] text-[var(--text-success)] border-[#b6dbb1]" :
    "bg-[#fdf3f1] text-[#b1361e] border-[#f0c7be]";
  return (
    <div className="block">
      <FormLabel>{label}</FormLabel>
      <button type="button" onClick={cycle} disabled={disabled} className={["w-full h-8 px-2 text-[13px] rounded-[2px] border text-left", color].join(" ")}>
        {display}
      </button>
    </div>
  );
}

function FormFooter({ feedback, submitting, submitLabel }: { feedback: { kind: "ok" | "err"; msg: string } | null; submitting: boolean; submitLabel: string }) {
  return (
    <div className="mt-2 mb-6 flex items-center gap-3">
      <button
        type="submit"
        disabled={submitting}
        className={[
          "h-9 px-4 rounded-[2px] text-[13px] font-bold border tracking-wide",
          submitting
            ? "bg-[#f2c399] border-[#f2c399] cursor-not-allowed text-[var(--text-primary)]"
            : "bg-gradient-to-b from-[#f7dfa5] to-[#f0c14b] border-[#a88734] hover:from-[#f5d78e] hover:to-[#eeb933] text-[var(--text-primary)]",
        ].join(" ")}
      >
        {submitting ? "Saving…" : submitLabel}
      </button>
      {feedback ? (
        <span className={["text-[12px]", feedback.kind === "ok" ? "text-[var(--text-success)]" : "text-[var(--aws-error)]"].join(" ")}>
          {feedback.msg}
        </span>
      ) : null}
    </div>
  );
}

// ── Row table ─────────────────────────────────────────────────────────────

type Column = {
  key: string;
  label: string;
  render?: (v: unknown, row: Record<string, unknown>) => React.ReactNode;
};

function RowTable({ rows, columns }: { rows: Array<Record<string, unknown>>; columns: Column[] }) {
  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-[13px] border-collapse">
        <thead className="bg-[var(--surface-subtle)]">
          <tr className="border-b border-[var(--aws-border)]">
            {columns.map((c) => (
              <th key={c.key} className="px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-[var(--text-secondary)] whitespace-nowrap">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-[var(--aws-border)]">
              {columns.map((c) => {
                const raw = row[c.key];
                const display = c.render ? c.render(raw, row) : raw == null || raw === "" ? "—" : String(raw);
                return (
                  <td key={c.key} className="px-3 py-2 align-top max-w-[260px] truncate" title={typeof display === "string" ? display : undefined}>
                    {display}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
