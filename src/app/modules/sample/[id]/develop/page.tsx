"use client";

// NPD development surface for a requisition — kept OFF the clean request view.
// The NPD team opens this from the request's "Develop" button to author the
// draft BOM and promote it to a live BOM. Gated to NPD/TRIAL requisitions and
// NPD-authorized users.

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { Breadcrumbs, NPD_DEV_ROOT } from "@/components/Breadcrumbs";
import { useRequireAuth, useUserInitial, useMe } from "@/lib/user";
import { sampleCaps } from "@/lib/sample-roles";
import { getRequisition, type Requisition } from "@/lib/sample";
import { StatusPill, TYPE_LABEL } from "../../_shared";
import { NpdSection } from "../_npd-section";

export default function DevelopRequisitionPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const authed = useRequireAuth(router.replace);
  const initial = useUserInitial();
  const me = useMe();
  const caps = sampleCaps(me);

  const [req, setReq] = useState<Requisition | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setReq(await getRequisition(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (!authed || !Number.isFinite(id)) return;
    queueMicrotask(() => { void refresh(); });
  }, [authed, id, refresh]);

  if (!authed) return null;

  const isNpd = req != null && (req.sample_type === "NPD" || req.sample_type === "TRIAL");

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-4 sm:px-6 gap-4">
        <BrandMark />
        <nav className="text-[12px] text-[#d5dbdb] hidden sm:flex items-center gap-2 ml-2">
          <button onClick={() => router.push("/modules/sample")} className="hover:underline">Sample</button>
          <span>/</span>
          <button onClick={() => router.push(`/modules/sample/${id}`)} className="hover:underline">{req?.request_id ?? id}</button>
          <span>/</span><span className="text-white">Develop</span>
        </nav>
        <div className="flex-1" />
        <button onClick={() => router.push("/modules/profile")} aria-label="Profile"
          className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]">{initial}</button>
      </header>

      <main className="flex-1 max-w-[980px] w-full mx-auto px-4 sm:px-6 py-6">
        <Breadcrumbs items={[
          ...NPD_DEV_ROOT,
          { label: req?.request_id != null ? String(req.request_id) : String(id), href: `/modules/sample/${id}` },
          { label: "Develop" },
        ]} className="mb-3" />

        {error && <div className="mb-4 rounded-md border border-[#f0c7be] bg-[#fdf3f1] px-3 py-2 text-[13px] text-[#b1361e]">{error}</div>}

        {loading || !req ? (
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[13px] text-[var(--text-secondary)]">
            {loading ? "Loading…" : "Not found."}
          </div>
        ) : !isNpd ? (
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)]">
            Development applies only to NPD / Customer-trial requests.
          </div>
        ) : !caps.canNpd ? (
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)]">
            Only the NPD team can develop this request. You can view the request from the breadcrumb above.
          </div>
        ) : (
          <div className="space-y-5">
            {/* Request context */}
            <section className="bg-white border border-[var(--aws-border)] rounded-md p-4">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-[18px] font-semibold text-[var(--text-primary)]">{req.request_id ?? id}</h1>
                <StatusPill status={req.status} />
                <span className="text-[12px] px-2 py-0.5 rounded bg-[var(--surface-divider)] text-[var(--text-secondary)]">{TYPE_LABEL[req.sample_type] ?? req.sample_type}</span>
                {req.npd_target_name && <span className="text-[13px] text-[var(--text-secondary)]">Target: <span className="font-medium text-[var(--text-primary)]">{req.npd_target_name}</span></span>}
              </div>
            </section>

            <NpdSection req={req} caps={caps} onChange={refresh} />
          </div>
        )}
      </main>
    </div>
  );
}
