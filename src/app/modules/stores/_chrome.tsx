"use client";

// Shared header/footer chrome for the Stores module and its sub-modules.
// Mirrors production/prod-indents/_chrome.tsx so the navy bar, breadcrumb,
// avatar button and footer read identically to every other module — only the
// breadcrumb ("Modules / Stores / …") and the back target differ.

import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { useUserInitial } from "@/lib/user";
import { BackLink } from "@/components/BackLink";

export interface StoresChromeProps {
  /** Breadcrumb tail. Omit on the Stores landing itself. */
  title?: string;
  /** Show the "‹ Back to stores" link at the top of <main>. */
  showBackToStores?: boolean;
  /** Widen <main> for a many-column table (1600px instead of 1280px). */
  wide?: boolean;
  children: React.ReactNode;
}

export function StoresChrome({ title, showBackToStores, wide, children }: StoresChromeProps) {
  const router = useRouter();
  const initial = useUserInitial();

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-6 gap-4">
        <BrandMark />
        <span className="text-[#d5dbdb] text-[13px] hidden sm:inline">Console</span>
        <nav className="text-[12px] text-[#d5dbdb] hidden md:flex items-center gap-2 ml-2">
          <button onClick={() => router.push("/modules")} className="hover:underline">Modules</button>
          <span>/</span>
          {title ? (
            <>
              <button onClick={() => router.push("/modules/stores")} className="hover:underline">
                Stores
              </button>
              <span>/</span>
              <span className="text-white">{title}</span>
            </>
          ) : (
            <span className="text-white">Stores</span>
          )}
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

      <main className={`flex-1 ${wide ? "max-w-[1600px]" : "max-w-[1280px]"} w-full mx-auto px-4 sm:px-6 py-6`}>
        {showBackToStores ? (
          <div className="mb-3">
            <BackLink parentHref="/modules/stores" label="stores" />
          </div>
        ) : null}
        {children}
      </main>

      <footer className="border-t border-[var(--aws-border)] bg-white py-3 px-6 text-[11px] text-[var(--text-secondary)] flex flex-wrap justify-center gap-x-4 gap-y-1">
        <a href="#" className="hover:underline">Privacy</a>
        <span>© {new Date().getFullYear()}</span>
      </footer>
    </div>
  );
}
