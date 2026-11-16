"use client";

// Replace a tab's DPD with Tally's raw "Group Outstandings" export.
//
// Three steps, nothing written until the last: choose the file(s); "Check
// files" asks the backend what they would change (customers updated, new
// customers to add, customers dropped, ledgers left out, and why); "Replace
// the DPD" asks once more in a confirmation popup, then writes it all in one go.
//
// Either tab takes a Candor Foods (CF) and/or a Candor Dates (CD) file, the
// company ticked for each: a file replaces only its own company's rows in that
// tab, so uploading CF alone again leaves the CD rows as they are. Tally's group
// report names its company, and the backend refuses one in the wrong box. The
// ledger list (one row per customer, with a Sales person column) does not, so
// the box it is in is taken as its company.
//
// New customers — owing, but not in the DPD — are added only when ticked.
// New bills (all dues under 30 days, 5,000 or more) start ticked; the rest are
// the accountant's call, as on the review sheet of the Excel DPD.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { compactInr, formatInr, type DpdSectionKey } from "@/lib/debtors";
import { applyDpdUpload, previewDpdUpload, type DpdUploadFiles, type DpdUploadPlan } from "@/lib/debtor-calls";

const SHEET =
  "m-auto rounded-md bg-white p-0 text-left shadow-[0_8px_32px_rgba(0,28,36,0.28)] backdrop:bg-black/40 scale-100 transition-[opacity,scale] duration-150 ease-out starting:open:opacity-0 starting:open:scale-95 motion-reduce:transition-none";
const SECONDARY =
  "h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] font-medium text-[var(--text-primary)] hover:bg-[var(--surface-subtle)] disabled:opacity-60";
const PRIMARY =
  "h-9 px-4 rounded-[2px] bg-[var(--aws-orange)] text-[13px] font-semibold text-white hover:bg-[var(--aws-orange-hover)] disabled:opacity-60";
const LINK = "text-[12px] font-medium text-[var(--aws-link)] hover:underline disabled:opacity-50";
const H3 = "text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]";

type Step =
  | { at: "choose" }
  | { at: "checking" }
  | { at: "review"; plan: DpdUploadPlan }
  | { at: "applying"; plan: DpdUploadPlan }
  | { at: "done"; plan: DpdUploadPlan };

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

const COMPANIES = [
  { slot: "cf", name: "Candor Foods (CF)" },
  { slot: "cd", name: "Candor Dates (CD)" },
] as const;
const COMPANY_NAME: Record<string, string> = { CF: "Candor Foods (CF)", CD: "Candor Dates (CD)" };

export function UploadDialog({
  open,
  section,
  label,
  onClose,
  onApplied,
}: {
  open: boolean;
  section: DpdSectionKey;
  /** The tab's name, "CD-CF" or "APMC + Non-APMC". */
  label: string;
  onClose: () => void;
  /** The DPD was replaced: reload what is on screen. */
  onApplied: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="dpd-upload-title"
      onClose={onClose}
      className={`${SHEET} w-[95vw] max-w-[46rem] max-h-[92vh] overflow-y-auto`}
    >
      {open ? (
        <UploadFlow key={section} section={section} label={label} onCancel={() => ref.current?.close()} onApplied={onApplied} />
      ) : null}
    </dialog>
  );
}

function UploadFlow({
  section,
  label,
  onCancel,
  onApplied,
}: {
  section: DpdSectionKey;
  label: string;
  onCancel: () => void;
  onApplied: () => void;
}) {
  const id = useId();
  const confirmRef = useRef<HTMLDialogElement>(null);
  const [files, setFiles] = useState<DpdUploadFiles>({});
  const [picked, setPicked] = useState<Record<keyof DpdUploadFiles, boolean>>({ cf: false, cd: false });
  const [step, setStep] = useState<Step>({ at: "choose" });
  const [error, setError] = useState<string | null>(null);
  const [include, setInclude] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    const dialog = confirmRef.current;
    if (!dialog) return;
    if (confirming && !dialog.open) dialog.showModal();
    else if (!confirming && dialog.open) dialog.close();
  }, [confirming]);

  // Unticking a company drops its file, so a chosen file always has its box ticked.
  const hasFiles = Boolean(files.cf || files.cd);
  const busy = step.at === "checking" || step.at === "applying";
  const plan = step.at === "review" || step.at === "applying" || step.at === "done" ? step.plan : null;

  function choose(slot: keyof DpdUploadFiles, file: File | null) {
    setFiles((f) => ({ ...f, [slot]: file }));
    // Different files mean a different plan: check again.
    setStep({ at: "choose" });
    setError(null);
  }

  function pick(slot: keyof DpdUploadFiles, on: boolean) {
    setPicked((p) => ({ ...p, [slot]: on }));
    if (!on) choose(slot, null);
  }

  async function check() {
    setStep({ at: "checking" });
    setError(null);
    try {
      const p = await previewDpdUpload(section, files);
      setInclude(new Set(p.new.filter((n) => n.include_by_default).map((n) => n.party_id)));
      setStep({ at: "review", plan: p });
    } catch (err) {
      setError(err instanceof Error ? err.message : "The files could not be checked.");
      setStep({ at: "choose" });
    }
  }

  async function apply() {
    if (!plan) return;
    setStep({ at: "applying", plan });
    setError(null);
    try {
      const done = await applyDpdUpload(section, files, [...include]);
      setConfirming(false);
      setStep({ at: "done", plan: done });
      onApplied();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The DPD could not be replaced.");
      setStep({ at: "review", plan });
    }
  }

  const companyBox = (slot: keyof DpdUploadFiles, name: string) => (
    <div key={slot} className="rounded-md border border-[var(--aws-border)] px-3 py-2.5">
      <label className="flex items-center gap-2 cursor-pointer text-[12px] font-semibold text-[var(--text-primary)]">
        <input
          type="checkbox"
          checked={picked[slot]}
          disabled={busy}
          onChange={(e) => pick(slot, e.target.checked)}
          className="w-4 h-4 accent-[var(--aws-orange)]"
        />
        {name}
      </label>
      {picked[slot] ? (
        <>
          <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">Replaces the {slot.toUpperCase()} rows of this tab only.</p>
          <input
            type="file"
            aria-label={`${name} file`}
            accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            disabled={busy}
            onChange={(e) => choose(slot, e.target.files?.[0] ?? null)}
            className="mt-2 block w-full text-[12px] text-[var(--text-secondary)] file:mr-3 file:h-8 file:px-3 file:rounded-[2px] file:border file:border-[var(--aws-border-strong)] file:bg-white file:text-[12px] file:font-medium file:text-[var(--text-primary)] hover:file:bg-[var(--surface-subtle)]"
          />
        </>
      ) : (
        <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">Not uploading: its rows stay as they are.</p>
      )}
    </div>
  );

  return (
    <>
      <div className="px-5 pt-5 pb-3 border-b border-[var(--aws-border)]">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--aws-orange)]">Upload Tally export</p>
        <h2 id="dpd-upload-title" className="mt-1 text-[15px] font-semibold leading-[20px] text-[var(--text-primary)]">
          Replace the {label} DPD
        </h2>
        <p className="mt-0.5 text-[12px] leading-[17px] text-[var(--text-secondary)]">
          In Tally: Sundry Debtors → Group Outstandings, with the ageing columns, exported to Excel — the group report,
          or the ledger list with a Sales person column. Nothing changes until you confirm.
        </p>
      </div>

      <div className="px-5 py-4 space-y-4">
        {step.at === "done" ? (
          <Done plan={step.plan} label={label} />
        ) : (
          <>
            <fieldset className="space-y-2">
              <legend className={H3}>Which company&rsquo;s file are you uploading?</legend>
              <p className="text-[11px] leading-[16px] text-[var(--text-muted)]">
                Tick one or both. A ledger list does not name its company, so the box it is in is taken as its company.
                {section === "apmc" ? " A group report needs its APMC groups expanded, so each customer is listed." : ""}
              </p>
              <div className="grid gap-3 sm:grid-cols-2">{COMPANIES.map((c) => companyBox(c.slot, c.name))}</div>
            </fieldset>
            {error ? <p role="alert" className="text-[12px] text-[#b0280e]">{error}</p> : null}
            {step.at === "checking" ? <p role="status" className="text-[12px] text-[var(--text-secondary)]">Reading the files…</p> : null}
            {plan ? <Review plan={plan} include={include} setInclude={setInclude} /> : null}
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 px-5 py-3 border-t border-[var(--aws-border)] bg-[var(--surface-subtle)]">
        {step.at === "done" ? (
          <button type="button" onClick={onCancel} className={PRIMARY}>
            Done
          </button>
        ) : (
          <>
            <button type="button" onClick={onCancel} disabled={step.at === "applying"} className={SECONDARY}>
              Cancel
            </button>
            {plan ? (
              <button type="button" onClick={() => setConfirming(true)} disabled={step.at === "applying"} className={PRIMARY}>
                Replace the DPD…
              </button>
            ) : (
              <button type="button" onClick={check} disabled={!hasFiles || step.at === "checking"} className={PRIMARY}>
                {step.at === "checking" ? "Checking…" : "Check files"}
              </button>
            )}
          </>
        )}
      </div>

      <dialog
        ref={confirmRef}
        aria-labelledby={`${id}-confirm`}
        onClose={() => setConfirming(false)}
        className={`${SHEET} w-[92vw] max-w-[28rem]`}
      >
        {plan && confirming ? (
          <>
            <div className="px-5 pt-5 pb-3 border-b border-[var(--aws-border)]">
              <h2 id={`${id}-confirm`} className="text-[15px] font-semibold leading-[20px] text-[var(--text-primary)]">
                Replace the {label} DPD?
              </h2>
              <p className="mt-0.5 text-[12px] text-[var(--text-secondary)]">
                {plan.files.map((f) => `${f.division}: ${f.period ?? "period not given"}`).join(" · ")}
              </p>
            </div>
            <ul className="px-5 py-4 space-y-1.5 text-[13px] text-[var(--text-primary)]">
              <li><b>{plan.updated.length}</b> customers get this export&rsquo;s figures</li>
              <li><b>{include.size}</b> new customers are added{plan.new.length > include.size ? ` (${plan.new.length - include.size} not ticked are left out)` : ""}</li>
              <li>
                <b>{plan.dropped.length}</b> customers who owe nothing now are taken off
                {plan.dropped.some((d) => d.has_history) ? ` (${plan.dropped.filter((d) => d.has_history).length} with calls keep their history)` : ""}
              </li>
              <li className="pt-1 text-[12px] text-[var(--text-secondary)]">
                Remarks, contact numbers, calls and summaries are kept. The figures being replaced cannot be brought back.
              </li>
              {error ? <li role="alert" className="text-[12px] text-[#b0280e]">{error}</li> : null}
            </ul>
            <div className="flex flex-wrap items-center justify-end gap-2 px-5 py-3 border-t border-[var(--aws-border)] bg-[var(--surface-subtle)]">
              <button type="button" disabled={step.at === "applying"} onClick={() => setConfirming(false)} className={SECONDARY}>
                Go back
              </button>
              <button type="button" disabled={step.at === "applying"} onClick={apply} className={PRIMARY}>
                {step.at === "applying" ? "Replacing…" : "Yes, replace"}
              </button>
            </div>
          </>
        ) : null}
      </dialog>
    </>
  );
}

function Review({
  plan,
  include,
  setInclude,
}: {
  plan: DpdUploadPlan;
  include: Set<string>;
  setInclude: (s: Set<string>) => void;
}) {
  const after = useMemo(
    () =>
      sum(plan.updated.map((u) => u.after.outstanding)) +
      sum(plan.new.filter((n) => include.has(n.party_id)).map((n) => n.amounts.outstanding)),
    [plan, include],
  );
  const toggle = (pid: string) => {
    const next = new Set(include);
    if (next.has(pid)) next.delete(pid);
    else next.add(pid);
    setInclude(next);
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        {plan.files.map((f) => (
          <p key={f.division} className="text-[12px] text-[var(--text-secondary)]">
            <span className="font-semibold text-[var(--text-primary)]">
              {f.company ?? `${COMPANY_NAME[f.division]}, as you ticked: the file does not name its company`}
            </span>
            {`${f.period ? ` · ${f.period}` : ""} · ${f.rows} ledgers · `}
            {f.total_checked ? "adds up to Tally’s Grand Total ✓" : "no Grand Total in the file; every row adds up to its own Pending Bills ✓"}
          </p>
        ))}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Tile label="Updated" value={plan.updated.length} note={compactInr(sum(plan.updated.map((u) => u.after.outstanding)))} />
        <Tile label="New, ticked" value={`${include.size} of ${plan.new.length}`} note={compactInr(sum(plan.new.filter((n) => include.has(n.party_id)).map((n) => n.amounts.outstanding)))} />
        <Tile label="Taken off" value={plan.dropped.length} note={compactInr(sum(plan.dropped.map((d) => d.outstanding_before)))} />
        <Tile label="Left out" value={plan.left_out.length} note="never in the DPD" />
      </div>
      <p className="text-[12px] text-[var(--text-secondary)]">
        After this upload the {plan.files.length > 1 ? "two files' part" : "file's part"} of the DPD comes to{" "}
        <span className="font-semibold text-[var(--text-primary)]">{formatInr(after)}</span>.
      </p>

      {plan.warnings.length > 0 ? (
        <ul className="rounded-[2px] border border-[#e6c47a] bg-[#fdf6e3] px-3 py-2 space-y-1 text-[12px] leading-[17px] text-[#6b4e00]">
          {plan.warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      ) : null}

      {plan.new.length > 0 ? (
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className={H3}>New customers: tick the ones to add</h3>
            <span className="flex gap-3">
              <button type="button" className={LINK} onClick={() => setInclude(new Set(plan.new.map((n) => n.party_id)))}>Tick all</button>
              <button type="button" className={LINK} onClick={() => setInclude(new Set())}>Untick all</button>
            </span>
          </div>
          <ul className="mt-1.5 max-h-[38vh] overflow-y-auto rounded-[2px] border border-[var(--surface-divider)] divide-y divide-[var(--surface-divider)]">
            {plan.new.map((n) => (
              <li key={n.party_id}>
                <label className="flex items-start gap-2.5 px-2.5 py-2 cursor-pointer hover:bg-[var(--surface-subtle)]">
                  <input type="checkbox" checked={include.has(n.party_id)} onChange={() => toggle(n.party_id)} className="mt-0.5 w-4 h-4 accent-[var(--aws-orange)]" />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="text-[13px] font-medium text-[var(--text-primary)] break-words">
                        {n.division ? <span className="text-[var(--text-muted)]">{n.division} · </span> : null}
                        {n.customer}
                      </span>
                      <span className="text-[13px] font-semibold tabular-nums text-[var(--text-primary)]">{formatInr(n.amounts.outstanding)}</span>
                    </span>
                    <span className="block text-[11px] text-[var(--text-muted)]">
                      {[n.sales_person, n.type].filter(Boolean).join(" · ")}
                      {[n.sales_person, n.type].some(Boolean) ? " — " : ""}
                      {n.reason}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Fold title={`Updated (${plan.updated.length})`}>
        {plan.updated.map((u) => (
          <Line key={u.party_id} left={`${u.division ? `${u.division} · ` : ""}${u.customer}`}
                right={`${formatInr(u.before.outstanding)} → ${formatInr(u.after.outstanding)}`} />
        ))}
      </Fold>
      <Fold title={`Taken off (${plan.dropped.length})`}>
        {plan.dropped.map((d) => (
          <Line key={d.party_id} left={`${d.division ? `${d.division} · ` : ""}${d.customer}`}
                right={`${formatInr(d.outstanding_before)}`} note={`${d.why}${d.has_history ? " — has calls, so kept with dues at zero" : ""}`} />
        ))}
      </Fold>
      <Fold title={`Left out (${plan.left_out.length})`}>
        {plan.left_out.map((l, i) => (
          <Line key={`${l.customer}-${i}`} left={`${l.division ? `${l.division} · ` : ""}${l.customer}`} right={formatInr(l.net)} note={l.reason} />
        ))}
      </Fold>
    </div>
  );
}

function Done({ plan, label }: { plan: DpdUploadPlan; label: string }) {
  const r = plan.result;
  return (
    <div role="status" className="space-y-2">
      <p className="text-[14px] font-semibold text-[var(--text-primary)]">The {label} DPD has been replaced.</p>
      {r ? (
        <ul className="text-[13px] text-[var(--text-primary)] space-y-1">
          <li>{r.updated} customers updated</li>
          <li>{r.added} new customers added</li>
          <li>{r.removed} taken off{r.kept_with_history ? `, ${r.kept_with_history} kept with dues at zero because they have calls` : ""}</li>
        </ul>
      ) : null}
      <p className="text-[12px] text-[var(--text-secondary)]">The table now shows the new figures.</p>
    </div>
  );
}

function Tile({ label, value, note }: { label: string; value: number | string; note: string }) {
  return (
    <div className="rounded-md border border-[var(--aws-border)] px-3 py-2">
      <p className="text-[11px] text-[var(--text-secondary)]">{label}</p>
      <p className="text-[16px] font-semibold tabular-nums text-[var(--text-primary)]">{value}</p>
      <p className="text-[11px] text-[var(--text-muted)] truncate">{note}</p>
    </div>
  );
}

function Fold({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="rounded-[2px] border border-[var(--surface-divider)]">
      <summary className="cursor-pointer px-2.5 py-2 text-[12px] font-semibold text-[var(--text-primary)] hover:bg-[var(--surface-subtle)]">{title}</summary>
      <ul className="max-h-[30vh] overflow-y-auto divide-y divide-[var(--surface-divider)] border-t border-[var(--surface-divider)]">{children}</ul>
    </details>
  );
}

function Line({ left, right, note }: { left: string; right: string; note?: string }) {
  return (
    <li className="px-2.5 py-1.5 text-[12px]">
      <span className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="min-w-0 break-words text-[var(--text-primary)]">{left}</span>
        <span className="tabular-nums text-[var(--text-secondary)] whitespace-nowrap">{right}</span>
      </span>
      {note ? <span className="block text-[11px] text-[var(--text-muted)]">{note}</span> : null}
    </li>
  );
}
