"use client";

// Shared header/footer chrome for Customer-Returns sub-pages. Maroon bar
// (--aws-navy is maroon), breadcrumb (Modules / Customer Returns / <title>),
// avatar, footer — mirrors TransferChrome / QcChrome.

import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { useUserInitial } from "@/lib/user";

export function CustomerReturnsChrome({ title, children }: { title: string; children: React.ReactNode }) {
  const router = useRouter();
  const initial = useUserInitial();
  const isRoot = title === "Customer Returns";

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-6 gap-4">
        <BrandMark />
        <span className="text-[#d5dbdb] text-[13px] hidden sm:inline">Console</span>
        <nav className="text-[12px] text-[#d5dbdb] hidden md:flex items-center gap-2 ml-2">
          <button onClick={() => router.push("/modules")} className="hover:underline">Modules</button>
          <span>/</span>
          {isRoot ? (
            <span className="text-white">Customer Returns</span>
          ) : (
            <>
              <button onClick={() => router.push("/modules/customer-returns")} className="hover:underline">
                Customer Returns
              </button>
              <span>/</span>
              <span className="text-white">{title}</span>
            </>
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

      <main className="flex-1 max-w-[1280px] w-full mx-auto px-4 sm:px-6 py-6">{children}</main>

      <footer className="border-t border-[var(--aws-border)] bg-white py-3 px-6 text-[11px] text-[var(--text-secondary)] flex flex-wrap justify-center gap-x-4 gap-y-1">
        <a href="#" className="hover:underline">Privacy</a>
        <span suppressHydrationWarning>© {new Date().getFullYear()}</span>
      </footer>
    </div>
  );
}
