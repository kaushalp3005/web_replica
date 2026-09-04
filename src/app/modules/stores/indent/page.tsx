"use client";

// Stores › Indent. Scaffold only — chrome, auth/admin gate and page frame are
// in place; the actual contents are still to be specified.
//
// When they are, note that src/lib/indents.ts is already a complete typed
// client (list/get/create + every lifecycle transition) for BOTH backend indent
// families, and currently has no importers:
//   · production_indent (PRDI-*, FG/SFG, maker-checker) — /production-indents
//   · purchase_indent  (IND-*, RM/PM shortage → Purchase) — /indents
// A third concept exists that neither covers: the per-job-card RM/PM indent
// LINES auto-materialised from the BOM at job-card creation, which Stores
// approves/rejects via GET /store/pending-allocations + POST /store/decide.

import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { BackLink } from "@/components/BackLink";
import { useRequireAuth, useUserInitial, useIsAdmin } from "@/lib/user";

export default function StoresIndentPage() {
  const router = useRouter();
  const initial = useUserInitial();
  // Redirect side-effect only — never gate render on its return (hydration).
  // See the note in ../page.tsx.
  useRequireAuth(router.replace);
  const isAdmin = useIsAdmin();

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-6 gap-4">
        <BrandMark />
        <span className="text-[#d5dbdb] text-[13px] hidden sm:inline">Console</span>
        <nav className="text-[12px] text-[#d5dbdb] hidden md:flex items-center gap-2 ml-2">
          <button onClick={() => router.push("/modules")} className="hover:underline">Modules</button>
          <span>/</span>
          <button onClick={() => router.push("/modules/stores")} className="hover:underline">Stores</button>
          <span>/</span>
          <span className="text-white">Indent</span>
        </nav>
        <div className="flex-1" />
        <button
          onClick={() => router.push("/modules/profile")}
          aria-label="Open profile"
          title="Profile"
          className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]"
        >
          {initial}
        </button>
      </header>

      <main className="flex-1 max-w-[1280px] w-full mx-auto px-4 sm:px-6 py-6">
        <div className="mb-3">
          <BackLink parentHref="/modules/stores" label="Stores" />
        </div>

        {!isAdmin ? (
          <>
            <h1 className="text-[20px] font-semibold text-[var(--text-primary)] mb-3">Indent</h1>
            <section className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)]">
              You don&rsquo;t have access to the Stores module. Ask an administrator to grant you access, or switch to a different account.
            </section>
          </>
        ) : (
          <>
            <div className="mb-6">
              <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">Indent</h1>
              <p className="text-[13px] text-[var(--text-secondary)] mt-1">
                Material indents raised to Stores.
              </p>
            </div>

            <section className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-8 text-center">
              <p className="text-[13px] text-[var(--text-secondary)]">
                Nothing here yet — the Indent view hasn&rsquo;t been configured.
              </p>
            </section>
          </>
        )}
      </main>

      <footer className="border-t border-[var(--aws-border)] bg-white py-3 px-6 text-[11px] text-[var(--text-secondary)] flex flex-wrap justify-center gap-x-4 gap-y-1">
        <a href="#" className="hover:underline">Privacy</a>
        <span>© {new Date().getFullYear()}</span>
      </footer>
    </div>
  );
}
