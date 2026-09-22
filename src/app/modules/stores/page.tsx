"use client";

// Stores module landing. Surfaces the store-side sub-modules the same way the
// Production landing surfaces its own: one card per sub-module, grouped, each
// gated by the role scope AND by the permission the sub-module's API needs.
//
// Today there is one sub-module, Production Indents: the material requests the
// floor sends to the store from a job card's Material allocation tab
// (floor_requisition). Requests are only ever raised from a job card, never on
// the Stores screens. More store-side surfaces (material-in, pending
// allocations) can be listed here later without touching the modules grid.

import { useRouter } from "next/navigation";
import { useRequireAuth, useRequireModuleAccess, useMe, useIsAdmin, useHasPermission } from "@/lib/user";
import { roleNamesOf } from "@/lib/sample-roles";
import { scopeAllowsRoute } from "@/lib/modules";
import { BackLink } from "@/components/BackLink";
import { StoresChrome } from "./_chrome";

type SubModule = {
  title: string;
  description: string;
  group: "Indents";
  route: string;
  implemented: boolean;
};

const SUB_MODULES: SubModule[] = [
  {
    group: "Indents",
    title: "Production Indents",
    description:
      "Material requests sent from job cards' Material allocation tab — every detail in one table, the full request report on hover, issue or cancel.",
    route: "/modules/stores/production-indents",
    implemented: true,
  },
];

const GROUPS = ["Indents"] as const;

export default function StoresLandingPage() {
  const router = useRouter();
  useRequireAuth(router.replace);
  // Deep-link guard for scoped roles (see ROLE_MODULE_SCOPE): a scoped user
  // without a "stores…" entry is bounced to /modules, like every other module.
  // The return is true on the server and on the first client paint (identity
  // not loaded yet) and flips to false only once a denial is known, so gating
  // the body on it is hydration-safe and stops the "no access" panel from
  // flashing its (wrong) advice at a scoped user during the bounce.
  const scopeOk = useRequireModuleAccess("stores", router.replace);
  const isAdmin = useIsAdmin();
  const me = useMe();
  const roles = roleNamesOf(me);
  // UX gate only; the server enforces the real permission on every route.
  // Production Indents lists floor requisitions, so it needs their view grant.
  const canSeeRequests = useHasPermission("production", "floor_requisitions", null, "view");

  function tileAllowed(route: string): boolean {
    if (route === "/modules/stores/production-indents") return canSeeRequests;
    return true;
  }

  function open(m: SubModule) {
    if (m.implemented) router.push(m.route);
    else alert(`"${m.title}" is not yet implemented on the web.`);
  }

  return (
    <StoresChrome>
      <div className="mb-3">
        <BackLink parentHref="/modules" label="modules" />
      </div>
      <div className="mb-6">
        <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">Stores</h1>
        <p className="text-[13px] text-[var(--text-secondary)] mt-1">
          Material the production floor has requested from the store, and where each request stands.
        </p>
      </div>

      {/* A deep-linked user who can see none of the cards gets told why, not an
          empty page. `me === null` (not hydrated yet) still renders nothing, and
          a scoped user being bounced sees nothing either (the advice below is
          about permissions, which is not their problem). */}
      {scopeOk && me !== null && !SUB_MODULES.some((m) => scopeAllowsRoute(roles, isAdmin, m.route.replace("/modules/", "")) && tileAllowed(m.route)) ? (
        <section className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)]">
          You don&rsquo;t have access to anything in the Stores module yet. Ask an administrator for the Floor
          Requisitions view permission, or switch to a different account.
        </section>
      ) : null}

      {scopeOk && GROUPS.map((group) => {
        const items = SUB_MODULES.filter(
          (m) =>
            m.group === group &&
            scopeAllowsRoute(roles, isAdmin, m.route.replace("/modules/", "")) &&
            tileAllowed(m.route),
        );
        if (items.length === 0) return null;
        return (
          <section key={group} className="mb-8">
            <h2 className="text-[11px] uppercase tracking-wide font-bold text-[var(--text-secondary)] mb-3">
              {group}
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {items.map((m) => (
                <button
                  key={m.route}
                  onClick={() => open(m)}
                  className={[
                    "text-left bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-4 transition",
                    m.implemented
                      ? "hover:border-[var(--aws-navy)] hover:shadow-[0_2px_6px_rgba(0,28,36,0.18)]"
                      : "opacity-60",
                  ].join(" ")}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">{m.title}</h3>
                    {!m.implemented ? (
                      <span className="text-[10px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded-sm bg-[var(--surface-disabled)] text-[var(--text-muted)]">
                        Soon
                      </span>
                    ) : null}
                  </div>
                  <p className="text-[12px] text-[var(--text-secondary)]">{m.description}</p>
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </StoresChrome>
  );
}
