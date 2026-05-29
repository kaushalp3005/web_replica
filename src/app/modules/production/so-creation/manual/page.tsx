"use client";

// Manual SO creation. Mirrors
// frontend_replica/src/modules/production/so-creation/manual-entry.html
// + manual-entry.js. Header form + N line items (shared SoLineEditor),
// validates before submit, POSTs /api/v1/so/create.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { createSo, COMPANY_OPTIONS, VOUCHER_TYPE_OPTIONS } from "@/lib/so";
import { SoChrome } from "../_chrome";
import { SoLineEditor, emptyLine, lineToWire, type LineRow } from "../_SoLineForm";

interface HeaderForm {
  so_number: string;
  so_date: string;
  customer_name: string;
  common_customer_name: string;
  company: string;
  voucher_type: string;
}

const EMPTY_HEADER: HeaderForm = {
  so_number: "",
  so_date: "",
  customer_name: "",
  common_customer_name: "",
  company: "",
  voucher_type: "",
};

export default function ManualSoEntryPage() {
  const router = useRouter();
  useRequireAuth(router.replace);

  const [header, setHeader] = useState<HeaderForm>(EMPTY_HEADER);
  const [lines, setLines] = useState<LineRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  function setHeaderField<K extends keyof HeaderForm>(k: K, v: HeaderForm[K]) {
    setHeader((h) => ({ ...h, [k]: v }));
  }

  function addLine() {
    setLines((ls) => [...ls, { ...emptyLine(), line_number: ls.length + 1 }]);
  }
  function updateLine(i: number, next: LineRow) {
    setLines((ls) => ls.map((l, j) => (j === i ? next : l)));
  }
  function removeLine(i: number) {
    setLines((ls) => ls.filter((_, j) => j !== i).map((l, j) => ({ ...l, line_number: j + 1 })));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);

    // Header validation (mirrors manual-entry.js)
    for (const k of ["so_number", "so_date", "customer_name", "common_customer_name", "company", "voucher_type"] as const) {
      if (!header[k].trim()) {
        setFeedback({ kind: "err", msg: `Header field "${k.replace(/_/g, " ")}" is required.` });
        return;
      }
    }
    if (lines.length === 0) {
      setFeedback({ kind: "err", msg: "Add at least one line item." });
      return;
    }
    // Per-line validation
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!l.sku_name.trim()) { setFeedback({ kind: "err", msg: `Line ${i + 1}: Particulars is required.` }); return; }
      if (!l.quantity.trim()) { setFeedback({ kind: "err", msg: `Line ${i + 1}: Pack count is required.` }); return; }
      if (!l.rate_inr.trim()) { setFeedback({ kind: "err", msg: `Line ${i + 1}: Rate is required.` }); return; }
    }

    setSubmitting(true);
    try {
      await createSo({
        so_number: header.so_number.trim(),
        so_date: header.so_date,
        customer_name: header.customer_name.trim(),
        common_customer_name: header.common_customer_name.trim(),
        company: header.company,
        voucher_type: header.voucher_type,
        lines: lines.map(lineToWire),
      });
      setFeedback({ kind: "ok", msg: "Sales Order created." });
      // Navigate back to the listing so the new SO shows up.
      router.push("/modules/production/so-creation");
    } catch (e2) {
      setFeedback({ kind: "err", msg: e2 instanceof Error ? e2.message : "Create failed." });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SoChrome title="Manual Entry" showBackToSoCreation>
      <div className="mb-5">
        <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">Create SO Manually</h1>
        <p className="text-[13px] text-[var(--text-secondary)] mt-1">
          Enter the SO header and add line items step by step.
        </p>
      </div>

      <form onSubmit={onSubmit}>
        <section className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-5 mb-4">
          <h2 className="text-[12px] uppercase tracking-wide font-semibold text-[var(--text-secondary)] mb-3">SO Header</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <Field label="SO Number *"           value={header.so_number}            onChange={(v) => setHeaderField("so_number", v)} />
            <Field label="SO Date *"             value={header.so_date}              onChange={(v) => setHeaderField("so_date", v)} type="date" />
            <Field label="Customer Name *"       value={header.customer_name}        onChange={(v) => setHeaderField("customer_name", v)} />
            <Field label="Common Customer *"     value={header.common_customer_name} onChange={(v) => setHeaderField("common_customer_name", v)} />
            <Selector label="Company *"          value={header.company}              options={COMPANY_OPTIONS as unknown as string[]}      onChange={(v) => setHeaderField("company", v)} />
            <Selector label="Voucher Type *"     value={header.voucher_type}         options={VOUCHER_TYPE_OPTIONS as unknown as string[]} onChange={(v) => setHeaderField("voucher_type", v)} />
          </div>
        </section>

        <section className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-[12px] uppercase tracking-wide font-semibold text-[var(--text-secondary)]">Line Items</h2>
            <button
              type="button"
              onClick={addLine}
              disabled={submitting}
              className="h-7 px-3 rounded-[2px] text-[12px] font-semibold border bg-gradient-to-b from-[#f7dfa5] to-[#f0c14b] border-[#a88734] hover:from-[#f5d78e] hover:to-[#eeb933] text-[var(--text-primary)] disabled:opacity-50"
            >
              + Add line
            </button>
          </div>
          {lines.length === 0 ? (
            <div className="bg-white border border-dashed border-[var(--aws-border-strong)] rounded-md p-8 text-center text-[var(--text-muted)] text-[12px]">
              No line items added yet. Click <strong>Add line</strong> to start.
            </div>
          ) : (
            lines.map((l, i) => (
              <SoLineEditor
                key={i}
                line={l}
                index={i}
                onChange={(next) => updateLine(i, next)}
                onRemove={() => removeLine(i)}
                disabled={submitting}
              />
            ))
          )}
        </section>

        <div className="flex items-center gap-3 mb-8">
          <button
            type="button"
            onClick={() => router.push("/modules/production/so-creation")}
            disabled={submitting}
            className="h-9 px-3 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] disabled:opacity-50"
          >
            Cancel
          </button>
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
            {submitting ? "Submitting…" : "Submit Sales Order"}
          </button>
          {feedback ? (
            <span className={["text-[12px]", feedback.kind === "ok" ? "text-[var(--text-success)]" : "text-[var(--aws-error)]"].join(" ")}>
              {feedback.msg}
            </span>
          ) : null}
        </div>
      </form>
    </SoChrome>
  );
}

const headerInputCls =
  "w-full h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#00a1c9] focus:shadow-[0_0_0_1px_#00a1c9]";

function Field({
  label, value, onChange, type = "text",
}: { label: string; value: string; onChange: (v: string) => void; type?: "text" | "date" }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">{label}</span>
      <input type={type} className={headerInputCls} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function Selector({
  label, value, options, onChange,
}: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-semibold text-[var(--text-primary)] mb-1">{label}</span>
      <select className={headerInputCls} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— Select —</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}
