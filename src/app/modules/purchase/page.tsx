"use client";

// Purchase module landing. Mirrors production/page.tsx card pattern.
// PO Upload is the purchase entry point on the web.

import { useRouter } from "next/navigation";
import { useRequireAuth, useHasRole, useHasPermission, useMe, useIsAdmin } from "@/lib/user";
import { roleNamesOf } from "@/lib/sample-roles";
import { scopeAllowsRoute } from "@/lib/modules";
import { BackLink } from "@/components/BackLink";
import { PurchaseChrome } from "./_chrome";

type SubModule = { title: string; description: string; route: string };

const SUB_MODULES: SubModule[] = [
  { title: "PO Upload", description: "Upload a PO workbook (.xlsx), preview SKU matches and duplicates, then commit. Browse, filter, and export existing purchase orders.", route: "/modules/purchase/po-creation" },
  { title: "Material In", description: "Browse received purchase orders by article and send arrival intimations.", route: "/modules/purchase/material-in" },
  { title: "Vendor Management", description: "Onboard a new vendor by dropping their compliance documents — extraction auto-fills every tab, then commits vendor, banking, documents and contracts in one transaction.", route: "/modules/purchase/vendor-management" },
];

export default function PurchaseLandingPage() {
  const router = useRouter();
  useRequireAuth(router.replace);
  // Admins, purchase managers, stores (Material-In) clerks and inventory
  // managers may use the Purchase module. useHasRole returns true for admins
  // too. Keep this role list in sync with the Purchase tile in lib/modules.tsx
  // (ROLE_MODULE_SCOPE for the scoped roles, allowedRoles for inventory_manager).
  // Call every hook unconditionally (|| short-circuits, which would make the
  // later calls conditional and violate the rules of hooks), then combine.
  const isPurchaseManager = useHasRole("purchase_manager");
  const isStoreHead = useHasRole("store_head");
  const isInventoryManager = useHasRole("inventory_manager");
  const canAccess = isPurchaseManager || isStoreHead || isInventoryManager;

  // Each sub-tile shows only to a user holding the permission its screen works
  // with, so a role sees exactly what it was granted (admins pass every check).
  const canPoUpload = useHasPermission("purchase", "po", null, "create");
  const canMaterialIn = useHasPermission("purchase", "material_in", null, "view");
  const canVendors = useHasPermission("vendor", "master", null, "view");
  const permitted: Record<string, boolean> = {
    "/modules/purchase/po-creation": canPoUpload,
    "/modules/purchase/material-in": canMaterialIn,
    "/modules/purchase/vendor-management": canVendors,
  };

  // Per-sub-tile scope too, same pattern as production/page.tsx: a role scoped
  // to a sub-route (store_head → "purchase/material-in") reaches the tile but
  // only its own screens.
  const isAdmin = useIsAdmin();
  const roles = roleNamesOf(useMe());
  const visible = SUB_MODULES.filter(
    (m) => permitted[m.route] && scopeAllowsRoute(roles, isAdmin, m.route.replace("/modules/", "")),
  );

  return (
    <PurchaseChrome title="Purchase">
      <div className="mb-3">
        <BackLink parentHref="/modules" label="modules" />
      </div>
      <div className="mb-6">
        <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">Purchase</h1>
        <p className="text-[13px] text-[var(--text-secondary)] mt-1">
          Upload, review, filter, and export purchase orders.
        </p>
      </div>
      {!canAccess ? (
        <section className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)]">
          You don&rsquo;t have access to the Purchase module. Ask an administrator to grant you access, or switch to a different account.
        </section>
      ) : (
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
      )}
    </PurchaseChrome>
  );
}
