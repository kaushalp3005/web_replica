"use client";

// Shared "available in a later phase" placeholder for transfer sub-routes that
// Phase 1 doesn't implement yet (create/receive/print/analytics). Keeps every
// dashboard nav target from 404-ing while the real pages land in P2–P5.

import { useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { TransferChrome } from "./_chrome";

export function TransferPlaceholder({ title, phase }: { title: string; phase: string }) {
  const router = useRouter();
  const allowed = useRequireAuth(router.replace);
  if (!allowed) return null;
  return (
    <TransferChrome title={title}>
      <div className="max-w-xl mx-auto text-center py-16">
        <h1 className="text-[20px] font-semibold text-[var(--text-primary)] mb-2">{title}</h1>
        <p className="text-[13px] text-[var(--text-secondary)] mb-6">
          This screen ships in <span className="font-medium">{phase}</span> of the Inter-Unit Transfer rollout.
          The dashboard, lists, hover details, and in-transit tracking are live now.
        </p>
        <button
          onClick={() => router.push("/modules/transfer")}
          className="px-4 py-2 text-[13px] rounded bg-[var(--aws-navy)] text-white hover:opacity-90"
        >
          ← Back to Transfer dashboard
        </button>
      </div>
    </TransferChrome>
  );
}
