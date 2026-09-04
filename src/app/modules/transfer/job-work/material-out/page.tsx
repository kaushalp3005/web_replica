"use client";

// Job Work — Material Out. Raise a delivery challan for material sent to a job worker
// (de-seeding, dicing, cracking, …) and print it. Ported from
// legacy_frontend/app/[company]/transfer/job-work/material-out/page.tsx.
//
// POST /api/v1/job-work/out is implemented (app/modules/job_work). The rest of the
// module — list, detail, edit, material-in — is not, so `isNotBuiltYet` still guards
// those paths and submit reports the gap honestly instead of failing silently.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth, useMe } from "@/lib/user";
import { TransferChrome } from "../../_chrome";
import { JobWorkDC } from "../../_JobWorkDC";
import {
  JobWorkApi, isNotBuiltYet, generateChallanNo,
  JOB_WORK_COMPANY, JOB_WORK_SUB_CATEGORIES,
  type JobWorkLine, type JobWorkParty, type JobWorkCreateBody,
} from "@/lib/jobWork";
// Canonical list — see lib/warehouses.ts. Job work dispatches from a plant only.
import { PLANT_WAREHOUSES as WAREHOUSES } from "@/lib/warehouses";

const UOMS = ["BOX", "CARTON", "KG", "PCS"];
const MATERIAL_TYPES = ["RM", "PM", "FG", "SFG"];

// Standing job workers from the production form. "Other" opens the free-text fields.
const VENDORS: JobWorkParty[] = [
  { name: "UNAZO CORPORATION", address: "SHOP NO-F/54, SECTOR-19, Turbhe, Navi Mumbai, Thane, Maharashtra, 400705", state: "MAHARASHTRA", city: "Thane", pin_code: "400705", contact_company: "9022223701", contact_mobile: "9022223701", email: "trishul@unazoccorp.com", sub_category: "" },
  { name: "Krishnat Kerba Chavan", address: "Shivshakti, SOC, Plot No-104, Room No-255, sec-4, Ghansoli, N.Mumbai 400701", state: "MAHARASHTRA", city: "Thane", pin_code: "400701", contact_company: "9766344318", contact_mobile: "9766344318", email: "krishnatchavan40@gmail.com", sub_category: "De seeding" },
  { name: "AL SAKHI ENTERPRISES", address: "BAGDE, ROOM NO. 1341, INDIRA NAGAR, TURBHE, NAVI MUMBAI, Thane, Maharashtra, 400703", state: "MAHARASHTRA", city: "NAVI MUMBAI", pin_code: "400703", contact_company: "9321792727", contact_mobile: "8850063004", email: "alsakhienterprises27@gmail.com", sub_category: "" },
  { name: "MIE FOODS INDIA PRIVATE LIMITED", address: "N 2301, 23rd Floor, Lodha World One, Senapati Bapat Marg, Upper Worli, Mumbai - 400013", state: "MAHARASHTRA", city: "MUMBAI", pin_code: "400013", contact_company: "7741960810", contact_mobile: "", email: "", sub_category: "" },
  { name: "HAG CORPORATION", address: "E 51, Phase II Market I, Turbhe, Navi Mumbai - 400705 | Factory: Plot No D 10/4, Turbhe MIDC, Navi Mumbai - 400703", state: "MAHARASHTRA", city: "NAVI MUMBAI (TURBHE)", pin_code: "400705", contact_company: "9321161659", contact_mobile: "9321161659", email: "hajigodil@gmail.com", sub_category: "" },
];
const EMPTY_PARTY: JobWorkParty = {
  name: "", address: "", state: "Maharashtra", city: "", pin_code: "",
  contact_company: "", contact_mobile: "", email: "", sub_category: "",
};

// ── Shared chrome (matches the Transfer-In button system) ──
const BTN_BASE =
  "inline-flex items-center justify-center gap-1 rounded font-medium whitespace-nowrap leading-none " +
  "transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--aws-orange)] focus-visible:ring-offset-1";
const BTN_SIZE = { sm: "h-[26px] px-2 text-[11px]", md: "h-8 px-3 text-[12px]" } as const;
const BTN_TONE = {
  neutral: "border border-[var(--aws-border)] bg-white text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] hover:border-[var(--aws-border-strong)]",
  accept: "border border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700 hover:border-emerald-700",
  danger: "border border-rose-300 bg-white text-rose-700 hover:bg-rose-50 hover:border-rose-400",
  brand: "border border-violet-300 bg-white text-violet-700 hover:bg-violet-50 hover:border-violet-400",
} as const;
const btn = (tone: keyof typeof BTN_TONE = "neutral", size: keyof typeof BTN_SIZE = "sm") =>
  `${BTN_BASE} ${BTN_SIZE[size]} ${BTN_TONE[tone]}`;

const TH_CELL = "px-3 py-2 font-semibold whitespace-nowrap border-b border-r border-[var(--aws-border)] last:border-r-0";
const TD_CELL = "px-3 py-1.5 align-middle border-b border-r border-[var(--aws-border)] last:border-r-0";
const INPUT = "w-full border border-[var(--aws-border)] rounded px-2 py-1.5 text-[12px] bg-white focus:outline-none focus:ring-2 focus:ring-[var(--aws-orange)]/30";
const LABEL = "block text-[11px] text-[var(--text-secondary)] mb-1";

function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}
function todayISO(): string { return new Date().toISOString().slice(0, 10); }

// One editable article row. Weight/amount are derived, not typed, so the challan totals
// can never disagree with the lines.
interface Draft {
  uid: number;
  item_description: string;
  material_type: string;
  item_category: string;
  sub_category: string;
  lot_number: string;
  batch_number: string;
  uom: string;
  quantity_boxes: string;
  quantity_kgs: string;
  rate_per_kg: string;
  hsn_sac: string;
  gst_rate: string;
  line_remarks: string;
}
const newDraft = (uid: number): Draft => ({
  uid, item_description: "", material_type: "", item_category: "", sub_category: "",
  lot_number: "", batch_number: "", uom: "BOX", quantity_boxes: "", quantity_kgs: "",
  rate_per_kg: "", hsn_sac: "08041020", gst_rate: "0%", line_remarks: "",
});

export default function JobWorkMaterialOutPage() {
  const router = useRouter();
  // Redirect-only here: this page loads no data, so there is nothing to gate on the result.
  useRequireAuth(router.replace);
  const me = useMe();

  const [challanNo] = useState(generateChallanNo);
  const [header, setHeader] = useState({
    job_work_date: todayISO(),
    from_warehouse: "",
    purpose_of_work: "",
    expected_return_date: "",
    e_way_bill_no: "",
    dispatched_through: "",
    vehicle_no: "",
    driver_name: "",
    authorized_person: "",
    contact_person: "",
    contact_number: "",
    remarks: "",
  });
  const [party, setParty] = useState<JobWorkParty>(EMPTY_PARTY);
  const [vendorOther, setVendorOther] = useState(false);
  const [rows, setRows] = useState<Draft[]>([newDraft(1)]);
  const [uidSeq, setUidSeq] = useState(2);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState<number | null>(null);
  const [showDC, setShowDC] = useState(false);

  const setH = (k: keyof typeof header, v: string) => setHeader((p) => ({ ...p, [k]: v }));
  const setRow = (uid: number, patch: Partial<Draft>) =>
    setRows((p) => p.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
  const addRow = () => { setRows((p) => [...p, newDraft(uidSeq)]); setUidSeq((n) => n + 1); };
  const removeRow = (uid: number) => setRows((p) => (p.length === 1 ? p : p.filter((r) => r.uid !== uid)));

  const onVendor = (name: string) => {
    if (name === "__other") { setVendorOther(true); setParty(EMPTY_PARTY); return; }
    const v = VENDORS.find((x) => x.name === name);
    setVendorOther(false);
    setParty(v ? { ...v } : EMPTY_PARTY);
  };

  // Lines the challan will carry — derived, so totals and the printed document agree.
  const lines: JobWorkLine[] = useMemo(
    () => rows
      .filter((r) => r.item_description.trim() !== "")
      .map((r, i) => ({
        sl_no: i + 1,
        item_description: r.item_description.trim(),
        material_type: r.material_type || null,
        item_category: r.item_category || null,
        sub_category: r.sub_category || party.sub_category || null,
        quantity_kgs: num(r.quantity_kgs),
        quantity_boxes: Math.trunc(num(r.quantity_boxes)),
        rate_per_kg: num(r.rate_per_kg) || null,
        amount: num(r.rate_per_kg) ? Math.round(num(r.rate_per_kg) * num(r.quantity_kgs) * 100) / 100 : null,
        uom: r.uom || null,
        lot_number: r.lot_number || null,
        batch_number: r.batch_number || null,
        line_remarks: r.line_remarks || null,
        hsn_sac: r.hsn_sac || null,
        gst_rate: r.gst_rate || null,
        net_weight: r.quantity_kgs || null,
        total_weight: r.quantity_kgs || null,
      })),
    [rows, party.sub_category],
  );

  const totals = useMemo(() => ({
    lines: lines.length,
    boxes: lines.reduce((s, l) => s + num(l.quantity_boxes), 0),
    kgs: lines.reduce((s, l) => s + num(l.quantity_kgs), 0),
    amount: lines.reduce((s, l) => s + num(l.amount), 0),
  }), [lines]);

  const problems = useMemo(() => {
    const p: string[] = [];
    if (!header.from_warehouse) p.push("From warehouse is required.");
    if (!party.name.trim()) p.push("Job worker is required.");
    if (!header.purpose_of_work.trim()) p.push("Purpose of job work is required.");
    if (lines.length === 0) p.push("Add at least one article.");
    if (lines.some((l) => num(l.quantity_kgs) <= 0)) p.push("Every article needs a quantity in kg.");
    return p;
  }, [header, party, lines]);

  const body = (): JobWorkCreateBody => ({
    header: {
      challan_no: challanNo,
      job_work_date: header.job_work_date,
      from_warehouse: header.from_warehouse,
      to_party: party.name,
      party_address: party.address,
      party_state: party.state,
      party_city: party.city,
      party_pin_code: party.pin_code,
      party_contact_company: party.contact_company,
      party_contact_mobile: party.contact_mobile,
      party_email: party.email,
      sub_category: party.sub_category,
      contact_person: header.contact_person,
      contact_number: header.contact_number,
      purpose_of_work: header.purpose_of_work,
      expected_return_date: header.expected_return_date || null,
      vehicle_no: header.vehicle_no,
      driver_name: header.driver_name,
      authorized_person: header.authorized_person || me?.full_name || me?.email || "",
      remarks: header.remarks,
      e_way_bill_no: header.e_way_bill_no || null,
      dispatched_through: header.dispatched_through || null,
      dispatch_to: party,
      created_by: me?.email ?? null,
      type: "OUT",
    },
    dispatch_to: party,
    line_items: lines,
  });

  const onSave = async () => {
    setError(null); setNotice(null);
    if (problems.length) { setError(problems.join(" · ")); return; }
    setSaving(true);
    try {
      const saved = await JobWorkApi.createOut(body());
      setSavedId(saved.id);
      setNotice(`Challan ${saved.challan_no} saved.`);
    } catch (err) {
      setError(isNotBuiltYet(err)
        ? "Saved nothing — the job-work backend (POST /api/v1/job-work/out) isn't built yet. The challan below is complete and can be printed now."
        : err instanceof Error ? err.message : "Failed to save the challan.");
      setShowDC(true);
    } finally { setSaving(false); }
  };

  // No `if (!allowed) return null` gate: useRequireAuth returns true on the server but
  // false on the client's first render, so gating the render on it hydration-mismatches.

  return (
    <TransferChrome title="Job Work — Material Out">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-[15px] font-semibold">Job Work — Material Out</h1>
            <p className="text-[12px] text-[var(--text-secondary)]">
              Challan <span className="font-mono">{challanNo}</span> · material sent for processing and returnable
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => router.push("/modules/transfer/job-work")} className={btn("neutral", "md")}>← All job work</button>
            <button onClick={() => setShowDC((v) => !v)} className={btn("brand", "md")} aria-expanded={showDC}>
              {showDC ? "Hide challan" : "Preview challan"}
            </button>
            <button onClick={onSave} disabled={saving} className={btn("accept", "md")}>
              {saving ? "Saving…" : "Save challan"}
            </button>
          </div>
        </div>

        {error && <Banner tone="rose">{error}</Banner>}
        {notice && <Banner tone="emerald">{notice}</Banner>}
        {savedId !== null && (
          <Banner tone="emerald">
            Saved.{" "}
            <button className="underline" onClick={() => router.push(`/modules/transfer/job-work/dc/${encodeURIComponent(challanNo)}`)}>
              Open the delivery challan
            </button>
          </Banner>
        )}

        {/* Challan details */}
        <Card title="Challan details">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <L label="Job work date"><input type="date" value={header.job_work_date} onChange={(e) => setH("job_work_date", e.target.value)} className={INPUT} /></L>
            <L label="From warehouse *">
              <select value={header.from_warehouse} onChange={(e) => setH("from_warehouse", e.target.value)} className={INPUT}>
                <option value="">Select…</option>
                {WAREHOUSES.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </L>
            <L label="Expected return date"><input type="date" value={header.expected_return_date} onChange={(e) => setH("expected_return_date", e.target.value)} className={INPUT} /></L>
            <L label="E-way bill no"><input value={header.e_way_bill_no} onChange={(e) => setH("e_way_bill_no", e.target.value)} className={INPUT} placeholder="optional" /></L>
            <L label="Purpose of job work *" span>
              <input value={header.purpose_of_work} onChange={(e) => setH("purpose_of_work", e.target.value)} className={INPUT} placeholder="e.g. De-seeding of dates" />
            </L>
            <L label="Dispatched through"><input value={header.dispatched_through} onChange={(e) => setH("dispatched_through", e.target.value)} className={INPUT} placeholder="transporter" /></L>
            <L label="Vehicle no"><input value={header.vehicle_no} onChange={(e) => setH("vehicle_no", e.target.value)} className={INPUT} /></L>
          </div>
        </Card>

        {/* Job worker */}
        <Card title="Dispatch to (job worker)">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <L label="Job worker *">
              <select value={vendorOther ? "__other" : party.name} onChange={(e) => onVendor(e.target.value)} className={INPUT}>
                <option value="">Select…</option>
                {VENDORS.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
                <option value="__other">Other…</option>
              </select>
            </L>
            <L label="Process / sub-category">
              <select value={party.sub_category ?? ""} onChange={(e) => setParty((p) => ({ ...p, sub_category: e.target.value }))} className={INPUT}>
                <option value="">Select…</option>
                {JOB_WORK_SUB_CATEGORIES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </L>
            <L label="Contact person"><input value={header.contact_person} onChange={(e) => setH("contact_person", e.target.value)} className={INPUT} /></L>
            <L label="Contact number"><input value={header.contact_number} onChange={(e) => setH("contact_number", e.target.value)} className={INPUT} /></L>
            <L label="Address" span>
              <input value={party.address} onChange={(e) => setParty((p) => ({ ...p, address: e.target.value }))}
                className={INPUT} readOnly={!vendorOther && !!party.name} />
            </L>
            <L label="City"><input value={party.city ?? ""} onChange={(e) => setParty((p) => ({ ...p, city: e.target.value }))} className={INPUT} readOnly={!vendorOther && !!party.name} /></L>
            <L label="PIN"><input value={party.pin_code ?? ""} onChange={(e) => setParty((p) => ({ ...p, pin_code: e.target.value }))} className={INPUT} readOnly={!vendorOther && !!party.name} /></L>
          </div>
        </Card>

        {/* Articles */}
        <div className="bg-white border border-[var(--aws-border)] rounded-md">
          <div className="px-4 py-3 border-b border-[var(--aws-border)] flex flex-wrap items-center justify-between gap-2">
            <span className="text-[13px] font-semibold text-violet-700">📦 Articles ({totals.lines})</span>
            <button onClick={addRow} className={btn("brand", "md")}>+ Add article</button>
          </div>
          <div className="p-3">
            <div className="overflow-x-auto border border-[var(--aws-border)] rounded-md">
              <table className="w-full text-[12px] border-separate border-spacing-0">
                <thead className="bg-[var(--surface-subtle)]">
                  <tr className="text-left text-[var(--text-secondary)]">
                    <th className={`${TH_CELL} text-center`}>SL</th>
                    <th className={TH_CELL}>ITEM DESCRIPTION</th>
                    <th className={TH_CELL}>TYPE</th>
                    <th className={TH_CELL}>LOT</th>
                    <th className={TH_CELL}>UOM</th>
                    <th className={`${TH_CELL} text-right`}>BOXES</th>
                    <th className={`${TH_CELL} text-right`}>QTY (KG)</th>
                    <th className={`${TH_CELL} text-right`}>RATE/KG</th>
                    <th className={`${TH_CELL} text-right`}>AMOUNT</th>
                    <th className={`${TH_CELL} text-right`}>ACTION</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const amount = num(r.rate_per_kg) * num(r.quantity_kgs);
                    return (
                      <tr key={r.uid} className="hover:bg-gray-50/50">
                        <td className={`${TD_CELL} text-center text-[var(--text-secondary)]`}>{i + 1}</td>
                        <td className={`${TD_CELL} min-w-[200px]`}>
                          <input value={r.item_description} onChange={(e) => setRow(r.uid, { item_description: e.target.value })} className={INPUT} placeholder="Article name" />
                        </td>
                        <td className={TD_CELL}>
                          <select value={r.material_type} onChange={(e) => setRow(r.uid, { material_type: e.target.value })} className={INPUT}>
                            <option value="">—</option>
                            {MATERIAL_TYPES.map((m) => <option key={m} value={m}>{m}</option>)}
                          </select>
                        </td>
                        <td className={TD_CELL}><input value={r.lot_number} onChange={(e) => setRow(r.uid, { lot_number: e.target.value })} className={`${INPUT} font-mono`} /></td>
                        <td className={TD_CELL}>
                          <select value={r.uom} onChange={(e) => setRow(r.uid, { uom: e.target.value })} className={INPUT}>
                            {UOMS.map((u) => <option key={u} value={u}>{u}</option>)}
                          </select>
                        </td>
                        <td className={TD_CELL}><input type="number" min={0} value={r.quantity_boxes} onChange={(e) => setRow(r.uid, { quantity_boxes: e.target.value })} className={`${INPUT} text-right tabular-nums`} /></td>
                        <td className={TD_CELL}><input type="number" min={0} step="0.001" value={r.quantity_kgs} onChange={(e) => setRow(r.uid, { quantity_kgs: e.target.value })} className={`${INPUT} text-right tabular-nums`} /></td>
                        <td className={TD_CELL}><input type="number" min={0} step="0.01" value={r.rate_per_kg} onChange={(e) => setRow(r.uid, { rate_per_kg: e.target.value })} className={`${INPUT} text-right tabular-nums`} placeholder="opt." /></td>
                        <td className={`${TD_CELL} text-right tabular-nums`}>{amount ? amount.toFixed(2) : "—"}</td>
                        <td className={`${TD_CELL} text-right`}>
                          <button onClick={() => removeRow(r.uid)} disabled={rows.length === 1} className={btn("danger")}>Remove</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Totals */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat tone="bg-blue-50 border-blue-100 text-blue-700" value={String(totals.lines)} label="Articles" />
          <Stat tone="bg-indigo-50 border-indigo-100 text-indigo-700" value={String(totals.boxes)} label="Boxes" />
          <Stat tone="bg-emerald-50 border-emerald-100 text-emerald-700" value={totals.kgs.toFixed(3)} label="Total kg" />
          <Stat tone="bg-amber-50 border-amber-100 text-amber-700" value={totals.amount ? totals.amount.toFixed(2) : "—"} label="Job-work value" />
        </div>

        <Card title="Transport & remarks">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <L label="Driver name"><input value={header.driver_name} onChange={(e) => setH("driver_name", e.target.value)} className={INPUT} /></L>
            <L label="Authorised person"><input value={header.authorized_person} onChange={(e) => setH("authorized_person", e.target.value)} className={INPUT} placeholder={me?.full_name || me?.email || ""} /></L>
            <L label="Remarks" span><input value={header.remarks} onChange={(e) => setH("remarks", e.target.value)} className={INPUT} /></L>
          </div>
        </Card>

        {problems.length > 0 && (
          <Banner tone="amber">Before saving — {problems.join(" · ")}</Banner>
        )}

        {/* Printable challan */}
        {showDC && (
          <div className="space-y-2">
            <div className="flex items-center justify-between dc-no-print">
              <span className="text-[13px] font-semibold">Delivery challan preview</span>
              <button onClick={() => window.print()} className={btn("brand", "md")}>🖨 Print challan</button>
            </div>
            <JobWorkDC
              challanNo={challanNo}
              dated={header.job_work_date}
              fromWarehouse={header.from_warehouse}
              eWayBillNo={header.e_way_bill_no}
              dispatchedThrough={header.dispatched_through}
              motorVehicleNo={header.vehicle_no}
              driverName={header.driver_name}
              authorizedPerson={header.authorized_person || me?.full_name || me?.email || ""}
              purposeOfWork={header.purpose_of_work}
              remarks={header.remarks}
              expectedReturnDate={header.expected_return_date}
              company={JOB_WORK_COMPANY}
              dispatchTo={party}
              lineItems={lines}
            />
          </div>
        )}
      </div>
    </TransferChrome>
  );
}

// ── Small presentational helpers ──
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md">
      <div className="px-4 py-3 border-b border-[var(--aws-border)] text-[13px] font-semibold">{title}</div>
      <div className="p-4">{children}</div>
    </div>
  );
}
function L({ label, span, children }: { label: string; span?: boolean; children: React.ReactNode }) {
  return <label className={span ? "sm:col-span-2" : undefined}><span className={LABEL}>{label}</span>{children}</label>;
}
function Stat({ tone, value, label }: { tone: string; value: string; label: string }) {
  return (
    <div className={`rounded-md p-3 text-center border ${tone}`}>
      <div className="text-[18px] font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] text-[var(--text-secondary)]">{label}</div>
    </div>
  );
}
function Banner({ tone, children }: { tone: "rose" | "emerald" | "amber"; children: React.ReactNode }) {
  const map = {
    rose: "bg-rose-50 border-rose-200 text-rose-800",
    emerald: "bg-emerald-50 border-emerald-200 text-emerald-800",
    amber: "bg-amber-50 border-amber-200 text-amber-900",
  } as const;
  return <div className={`border rounded-md px-3 py-2 text-[12px] dc-no-print ${map[tone]}`}>{children}</div>;
}
