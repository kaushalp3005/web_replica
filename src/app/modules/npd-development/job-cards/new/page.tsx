"use client";

// New standalone NPD development job card. Pure R&D — no sample requisition.
// A base BOM is MANDATORY: selecting it replicates its recipe into the trial
// recipe, which the operator then extends with RM ingredients. The trial recipe
// is therefore "base BOM + additions" — never a separate, divergent BOM link.
// Saving creates a DRAFT; development is started and closed (which promotes the
// recipe into a live BOM) from the detail page.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { Breadcrumbs, NPD_DEV_ROOT } from "@/components/Breadcrumbs";
import { useRequireAuth, useUserInitial } from "@/lib/user";
import { WAREHOUSES, getRequisition, type Warehouse } from "@/lib/sample";
import { createDevJobCard, getBomLines, type DevLine, type BomOption } from "@/lib/npd-dev";
import { FormSection, ReviewRow, ArticlePicker, UomSelect, BomPicker } from "../../../sample/_form";

interface DraftLine {
  sku_id: number | null;
  sku_name: string;
  qty: string;
  uom: string;
  item_type: "rm" | "pm";
  fromBase?: boolean;       // replicated from the base BOM (vs added here)
  is_off_master?: boolean;  // free-typed external/test ingredient (not in master)
  notes?: string;
}

const ITEM_TYPES: ("rm" | "pm")[] = ["rm", "pm"];

export default function NewDevJobCardPage() {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);
  const initial = useUserInitial();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [warehouse, setWarehouse] = useState<Warehouse | "">("");
  // Target product name mirrors Title until the operator edits it manually.
  const [fgSkuName, setFgSkuName] = useState("");
  const [fgTouched, setFgTouched] = useState(false);
  const [baseBomId, setBaseBomId] = useState<number | null>(null);
  const [baseBomLabel, setBaseBomLabel] = useState<string>("");
  const [seeding, setSeeding] = useState(false);
  const [pcs, setPcs] = useState("");
  const [weightPerPiece, setWeightPerPiece] = useState("");
  const [uom, setUom] = useState("kg");
  const [extName, setExtName] = useState("");   // free-typed external test ingredient
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<number | null>(null);
  const [linkedReq, setLinkedReq] = useState<string | null>(null);   // request label this card was started from
  const [linkedReqId, setLinkedReqId] = useState<number | null>(null);   // request id (back-links the card)

  // When opened from an approved request's "Develop" button (?req=<id>), prefill
  // the header from that requisition (target product → title, warehouse, qty,
  // description). The base BOM + recipe are still authored here.
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const reqId = new URLSearchParams(window.location.search).get("req");
      if (!reqId) return;
      setLinkedReqId(Number(reqId));
      getRequisition(Number(reqId)).then((req) => {
        if (cancelled) return;
        if (req.npd_target_name) setTitle(req.npd_target_name);
        if (req.warehouse) setWarehouse(req.warehouse as Warehouse);
        if (req.pcs != null) setPcs(String(req.pcs));
        if (req.weight_per_piece != null) setWeightPerPiece(String(req.weight_per_piece));
        // Description moved off purpose_note → description; fall back for legacy rows.
        const desc = req.description ?? req.purpose_note;
        if (desc) setDescription(desc);
        setLinkedReq(String(req.request_id ?? req.id));
      }).catch(() => { /* leave the form blank on lookup failure */ });
    });
    return () => { cancelled = true; };
  }, []);

  // What the Target product field shows / sends: the manual value once touched,
  // otherwise the live Title.
  const effectiveFgName = (fgTouched ? fgSkuName : title).trim();
  const baseCount = lines.filter((l) => l.fromBase).length;
  const addedCount = lines.length - baseCount;
  // Target qty is derived = pcs × weight per piece (kg) — same as the requisition.
  const pcsNum = Number(pcs), wppNum = Number(weightPerPiece);
  const targetQtyNum = (pcs.trim() !== "" && weightPerPiece.trim() !== "" && Number.isFinite(pcsNum) && Number.isFinite(wppNum))
    ? Number((pcsNum * wppNum).toFixed(3)) : 0;
  // Base BOM is mandatory — the trial recipe is built on top of it.
  const canCreate = !!title.trim() && baseBomId != null && !seeding;

  // Selecting a base BOM replicates its lines into the trial recipe. Re-selecting
  // swaps the base-derived lines but keeps anything added here; clearing it
  // removes only the base-derived lines.
  async function selectBase(b: BomOption | null) {
    setError(null);
    setBaseBomId(b ? b.bom_id : null);
    setBaseBomLabel(b?.fg_sku_name ?? "");
    if (!b) {
      setLines((prev) => prev.filter((l) => !l.fromBase));
      return;
    }
    setSeeding(true);
    try {
      const bl = await getBomLines(b.bom_id);
      const baseLines: DraftLine[] = bl.map((x) => ({
        sku_id: null, sku_name: x.material_sku_name, qty: String(x.quantity_per_unit ?? ""),
        uom: x.uom || "kg", item_type: x.item_type === "pm" ? "pm" : "rm", fromBase: true,
      }));
      setLines((prev) => [...baseLines, ...prev.filter((l) => !l.fromBase)]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load base BOM recipe");
      setBaseBomId(null); setBaseBomLabel("");
    } finally {
      setSeeding(false);
    }
  }

  function addLine(s: { sku_id: number; sku_name: string; item_type?: string }) {
    if (lines.some((l) => l.sku_id === s.sku_id)) return;
    const t: "rm" | "pm" = s.item_type === "pm" ? "pm" : "rm";
    setLines((prev) => [...prev, { sku_id: s.sku_id, sku_name: s.sku_name, qty: "1", uom: "kg", item_type: t, fromBase: false }]);
  }
  // Free-typed external/test ingredient not in the SKU master — recorded as
  // off-master (no inventory posting).
  function addExternal() {
    const name = extName.trim();
    if (!name) return;
    setLines((prev) => [...prev, { sku_id: null, sku_name: name, qty: "1", uom: "kg", item_type: "rm", fromBase: false, is_off_master: true }]);
    setExtName("");
  }
  function patchLine(i: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function removeLine(i: number) {
    setLines((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function save() {
    if (!canCreate) return;
    setSaving(true); setError(null);
    try {
      let id = savedId;
      if (id == null) {
        const wireLines: DevLine[] = lines.map((l, idx) => ({
          sku_id: l.sku_id, sku_name: l.sku_name, qty: Number(l.qty) || 0,
          uom: l.uom, item_type: l.item_type, is_off_master: l.is_off_master ?? false,
          line_order: idx, notes: l.notes || null,
        }));
        const jc = await createDevJobCard({
          title: title.trim(),
          description: description || undefined,
          warehouse: warehouse || undefined,
          base_bom_id: baseBomId ?? undefined,
          fg_sku_name: effectiveFgName || undefined,
          pcs: pcsNum || undefined,
          weight_per_piece: wppNum || undefined,
          target_qty: targetQtyNum || undefined,
          uom: uom || undefined,
          source_requisition_id: linkedReqId ?? undefined,
          // The trial recipe (base lines + additions) is sent explicitly — no
          // server-side clone, so the operator's edits to the base lines stick.
          clone_from_base: false,
          lines: wireLines,
        });
        id = jc.id;
        setSavedId(id);
      }
      router.push(`/modules/npd-development/job-cards/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create job card");
      setSaving(false);
    }
  }

  // Hydration gate: on SSR useRequireAuth returns true (no token store), but the
  // first client render starts authed=false — a bare early-return made the server
  // HTML and the first client paint diverge (the duplicated/ghost screen). Hold the
  // redirect until after mount so SSR and the first client paint are identical.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { queueMicrotask(() => setMounted(true)); }, []);

  if (mounted && !authed) return null;

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-4 sm:px-6 gap-4">
        <BrandMark />
        <nav className="text-[12px] text-[#d5dbdb] hidden sm:flex items-center gap-2 ml-2">
          <button onClick={() => router.push("/modules/npd-development")} className="hover:underline">NPD Development</button>
          <span>/</span>
          <button onClick={() => router.push("/modules/npd-development/job-cards")} className="hover:underline">Job cards</button>
          <span>/</span><span className="text-white">New</span>
        </nav>
        <div className="flex-1" />
        <button onClick={() => router.push("/modules/profile")} aria-label="Profile"
          className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]">{initial}</button>
      </header>

      <main className="flex-1 max-w-[820px] w-full mx-auto px-4 sm:px-6 py-6">
        <Breadcrumbs items={[...NPD_DEV_ROOT, { label: "Job cards", href: "/modules/npd-development/job-cards" }, { label: "New" }]} className="mb-3" />
        <h1 className="text-[20px] font-semibold text-[var(--text-primary)] mb-1">New development job card</h1>
        {linkedReq
          ? <p className="mb-4 text-[12px] text-[var(--text-secondary)]">Prefilled from approved request <span className="font-medium text-[var(--text-primary)]">{linkedReq}</span> — pick a base BOM and build the trial recipe.</p>
          : <div className="mb-4" />}

        {error && <div className="mb-4 rounded-md border border-[#f0c7be] bg-[#fdf3f1] px-3 py-2 text-[13px] text-[#b1361e]">{error}</div>}

        {/* 1 · Development details */}
        <FormSection n={1} title="Development details">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Title <span className="text-[var(--aws-error)]">*</span></label>
              <input className="form-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Masala peanut v2" />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Target product name (optional)</label>
              <input className="form-input"
                value={fgTouched ? fgSkuName : title}
                onChange={(e) => { setFgTouched(true); setFgSkuName(e.target.value); }}
                placeholder="becomes the promoted BOM's FG name" />
              <p className="mt-1 text-[11px] text-[var(--text-muted)]">{fgTouched ? "Edited manually." : "Mirrors the title — type to override."}</p>
            </div>
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Warehouse (optional)</label>
              <select className="form-input" value={warehouse} onChange={(e) => setWarehouse(e.target.value as Warehouse)}>
                <option value="">—</option>
                {WAREHOUSES.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Pcs</label>
              <input className="form-input" type="number" min="0" step="1" value={pcs}
                onChange={(e) => setPcs(e.target.value)} placeholder="e.g. 25" />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Weight per piece (kg)</label>
              <input className="form-input" type="number" min="0" step="0.001" value={weightPerPiece}
                onChange={(e) => setWeightPerPiece(e.target.value)} placeholder="e.g. 0.5" />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Quantity (kg)</label>
              <input className="form-input bg-[var(--surface-subtle)] cursor-not-allowed" value={targetQtyNum > 0 ? targetQtyNum.toLocaleString("en-IN") : "—"} readOnly tabIndex={-1} />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">UOM</label>
              <UomSelect value={uom} onChange={setUom} />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Description (optional)</label>
              <input className="form-input" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
          </div>
        </FormSection>

        {/* 2 · Base recipe */}
        <FormSection n={2} title="Base recipe">
          <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Base BOM <span className="text-[var(--aws-error)]">*</span></label>
          <BomPicker
            value={baseBomId} valueLabel={baseBomLabel}
            placeholder="Search or browse a base BOM…"
            onChange={selectBase} />
          <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">
            {seeding
              ? "Replicating the base recipe…"
              : baseBomId != null
                ? `${baseCount} line(s) replicated into the trial recipe below — add your ingredients on top.`
                : "Required — its recipe is copied into the trial recipe, which you then build on."}
          </p>
        </FormSection>

        {/* 3 · Trial recipe = base BOM lines (replicated) + RM additions */}
        <FormSection n={3} title="Trial recipe">
          <p className="text-[12px] text-[var(--text-muted)] mb-3">
            Replicated from the base BOM{baseBomLabel ? ` (${baseBomLabel})` : ""}; add raw-material or packaging ingredients on top.
          </p>
          <div className="space-y-4">
            <ArticlePicker onAdd={addLine} restrictItemType={["rm", "pm"]} />
            {/* External / test ingredient — free typed, not in the master */}
            <div className="border border-dashed border-[var(--aws-border-strong)] rounded-md p-3 bg-[var(--surface-subtle)]">
              <label className="block text-[11px] font-medium text-[var(--text-secondary)] mb-1">External test ingredient (not in the master)</label>
              <div className="flex items-end gap-2">
                <input className="form-input flex-1" value={extName} placeholder="Type a new ingredient name…"
                  onChange={(e) => setExtName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addExternal(); } }} />
                <button type="button" onClick={addExternal} disabled={!extName.trim()}
                  className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] disabled:opacity-50 hover:bg-white">Add</button>
              </div>
              <p className="mt-1 text-[10px] text-[var(--text-muted)]">External ingredient used (not in above master).</p>
            </div>
            {lines.length === 0 ? (
              <p className="text-[13px] text-[var(--text-muted)]">{baseBomId == null ? "Select a base BOM above to replicate its recipe here." : "This base BOM has no lines — add ingredients to build the recipe."}</p>
            ) : (
              <div className="space-y-2">
                {lines.map((l, i) => (
                  <div key={l.sku_id ?? `n-${i}`} className="border border-[var(--aws-border)] rounded-md p-3">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="text-[13px] font-medium text-[var(--text-primary)] flex items-center gap-2">
                        {l.sku_name}
                        <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${l.fromBase ? "bg-[var(--surface-subtle)] text-[var(--text-secondary)]" : l.is_off_master ? "bg-[#fff7ed] text-[#c2410c]" : "bg-[#eef2ff] text-[#4338ca]"}`}>{l.fromBase ? "base" : l.is_off_master ? "external" : "added"}</span>
                      </span>
                      <button onClick={() => removeLine(i)} className="text-[12px] text-[var(--aws-error)] hover:underline">Remove</button>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      <label className="text-[11px] text-[var(--text-secondary)]">Qty
                        <input className="form-input mt-0.5" type="number" min="0" step="0.001" value={l.qty}
                          onChange={(e) => patchLine(i, { qty: e.target.value })} />
                      </label>
                      <label className="text-[11px] text-[var(--text-secondary)]">UOM
                        <UomSelect className="mt-0.5" value={l.uom} onChange={(v) => patchLine(i, { uom: v })} />
                      </label>
                      <label className="text-[11px] text-[var(--text-secondary)]">Type
                        <select className="form-input mt-0.5" value={l.item_type} onChange={(e) => patchLine(i, { item_type: e.target.value as "rm" | "pm" })}>
                          {ITEM_TYPES.map((t) => <option key={t} value={t}>{t.toUpperCase()}</option>)}
                        </select>
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </FormSection>

        {/* 4 · Review */}
        <FormSection n={4} title="Review">
          <dl className="space-y-1.5 text-[13px]">
            <ReviewRow label="Title" value={title || "—"} />
            <ReviewRow label="Target product" value={effectiveFgName ? `${effectiveFgName}${fgTouched ? "" : " (from title)"}` : "—"} />
            <ReviewRow label="Warehouse" value={warehouse || "—"} />
            <ReviewRow label="Pcs" value={pcs || "—"} />
            <ReviewRow label="Weight per piece" value={weightPerPiece ? `${weightPerPiece} kg` : "—"} />
            <ReviewRow label="Target qty" value={targetQtyNum > 0 ? `${targetQtyNum} ${uom}` : "—"} />
            <ReviewRow label="Base BOM" value={baseBomId != null ? `${baseBomLabel ? `${baseBomLabel} ` : ""}#${baseBomId}` : "— (required)"} />
            <ReviewRow label="Recipe lines" value={lines.length === 0 ? "—" : `${lines.length} (${baseCount} base + ${addedCount} added)`} />
          </dl>
        </FormSection>

        {/* Actions */}
        <div className="flex items-center gap-2 mt-5">
          <button onClick={() => router.push("/modules/npd-development/job-cards")}
            className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] text-[13px] bg-white hover:bg-[var(--surface-subtle)]">Cancel</button>
          <div className="flex-1" />
          <button disabled={saving || !canCreate} onClick={save}
            className="h-9 px-5 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">{saving ? "Creating…" : "Create draft"}</button>
        </div>
      </main>
    </div>
  );
}
