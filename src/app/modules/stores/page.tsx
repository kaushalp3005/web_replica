"use client";

// Stores module landing. Mirrors the flat (ungrouped) sub-module card pattern
// from purchase/page.tsx rather than production/page.tsx's grouped variant —
// Stores has a single sub-module today, so GROUPS would be ceremony. Introduce
// grouping if/when this grid grows past a handful of cards.

import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { BackLink } from "@/components/BackLink";
import { useRequireAuth, useUserInitial, useIsAdmin, useMe } from "@/lib/user";
import { roleNamesOf } from "@/lib/sample-roles";
import { scopeAllowsRoute } from "@/lib/modules";

type SubModule = { title: string; description: string; route: string };

const SUB_MODULES: SubModule[] = [
  { title: "Indent", description: "Material indents raised to Stores — contents to be defined.", route: "/modules/stores/indent" },
];

export default function StoresLandingPage() {
  const router = useRouter();
  const initial = useUserInitial();
  // Call for its redirect side-effect only. Do NOT gate render on its return —
  // it is true on the server but false on the client's first paint, which would
  // cause a hydration mismatch (see inventory-ledger/page.tsx). The isAdmin gate
  // below is hydration-stable (false on server + client-first-render).
  useRequireAuth(router.replace);
  const isAdmin = useIsAdmin();

  // Per-sub-tile scope, same pattern as purchase/page.tsx. Inert while the
  // Stores tile is adminOnly (no scoped role reaches it), but keeps the grid
  // honest the moment store_head is added to ROLE_MODULE_SCOPE.
  const roles = roleNamesOf(useMe());
  const visible = SUB_MODULES.filter(
    (m) => scopeAllowsRoute(roles, isAdmin, m.route.replace("/modules/", "")),
  );

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-6 gap-4">
        <BrandMark />
        <span className="text-[#d5dbdb] text-[13px] hidden sm:inline">Console</span>
        <nav className="text-[12px] text-[#d5dbdb] hidden md:flex items-center gap-2 ml-2">
          <button onClick={() => router.push("/modules")} className="hover:underline">Modules</button>
          <span>/</span>
          <span className="text-white">Stores</span>
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
          <BackLink parentHref="/modules" label="modules" />
        </div>

        {!isAdmin ? (
          <>
            <h1 className="text-[20px] font-semibold text-[var(--text-primary)] mb-3">Stores</h1>
            <section className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)]">
              You don&rsquo;t have access to the Stores module. Ask an administrator to grant you access, or switch to a different account.
            </section>
          </>
        ) : (
          <>
            <div className="mb-6">
              <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">Stores</h1>
              <p className="text-[13px] text-[var(--text-secondary)] mt-1">
                Stores department workspace.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {visible.map((m) => (
                <button
                  key={m.route}
                  onClick={() => router.push(m.route)}
                  className="text-left bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-4 transition hover:border-[var(--aws-navy)] hover:shadow-[0_2px_6px_rgba(0,28,36,0.18)]"
                >
                  <h2 className="text-[14px] font-semibold text-[var(--text-primary)] mb-1">{m.title}</h2>
                  <p className="text-[12px] text-[var(--text-secondary)]">{m.description}</p>
                </button>
              ))}
            </div>
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
