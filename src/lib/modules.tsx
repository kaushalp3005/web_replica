// Mirrors com.candor.ims.ui.modules.ModulesActivity#MODULES — kept hardcoded
// because the server's /api/v1/auth/modules endpoint is admin-only.

import type { ComponentType, SVGProps } from "react";

export interface ModuleItem {
  title: string;
  description: string;
  badge: string;
  stat: string;
  route: string;
  implemented?: boolean;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
}

function PurchaseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 2-1.5L21 8H7" />
      <circle cx="9" cy="20" r="1.4" />
      <circle cx="17" cy="20" r="1.4" />
    </svg>
  );
}

function ProductionIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 20V10l5 3V10l5 3V8l8 4v8z" />
      <path d="M3 20h18" />
      <path d="M7 17h2M12 17h2M17 17h2" />
    </svg>
  );
}

function JobCardIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 3v3h8V3" />
      <path d="M8 11h8" />
      <path d="M8 15h6" />
      <path d="M8 19h4" />
    </svg>
  );
}

export const MODULES: ModuleItem[] = [
  {
    title: "Purchase",
    description:
      "Manage Purchase Orders, receive materials, track vendor deliveries, and handle box-level inventory with thermal label printing.",
    badge: "Core",
    stat: "PO Creation & Receiving",
    route: "purchase",
    Icon: PurchaseIcon,
  },
  {
    title: "Production",
    description:
      "Plan production, manage job cards, track fulfillment, handle MRP, indents, inventory, and day-end operations.",
    badge: "Core",
    stat: "Full Production Suite",
    route: "production",
    implemented: true,
    Icon: ProductionIcon,
  },
  {
    title: "Job Card",
    description:
      "Create, issue, and track shop-floor job cards. Record operation status, output, downtime, and operator entries against active production plans.",
    badge: "Shop floor",
    stat: "Track & manage job cards",
    route: "job-card",
    implemented: true,
    Icon: JobCardIcon,
  },
];
