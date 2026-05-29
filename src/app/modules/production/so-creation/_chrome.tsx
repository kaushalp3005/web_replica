"use client";

// Shared header/footer chrome for every SO Creation sub-page. Keeps the
// AWS navy bar, breadcrumb, avatar sign-out, and a single "← Back to SO
// Creation" affordance consistent across the four pages.

import { useRouter } from "next/navigation";
import { signOut } from "@/lib/auth";
import { useUserInitial } from "@/lib/user";

export interface ChromeProps {
  /** Page title shown in the breadcrumb's final segment. */
  title: string;
  /** Show the "← Back to SO Creation" button at the top of <main>. */
  showBackToSoCreation?: boolean;
  children: React.ReactNode;
}

export function SoChrome({ title, showBackToSoCreation, children }: ChromeProps) {
  const router = useRouter();
  const initial = useUserInitial();

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-6 gap-4">
        <span className="text-white font-bold tracking-tight text-[17px] flex items-baseline">
          aws
          <span className="inline-block w-[4px] h-[4px] rounded-full bg-[var(--aws-orange)] ml-[1px]" />
        </span>
        <span className="text-[#d5dbdb] text-[13px] hidden sm:inline">Console</span>
        <nav className="text-[12px] text-[#d5dbdb] hidden md:flex items-center gap-2 ml-2">
          <button onClick={() => router.push("/modules")} className="hover:underline">Modules</button>
          <span>/</span>
          <button onClick={() => router.push("/modules/production")} className="hover:underline">
            Production
          </button>
          <span>/</span>
          {title === "SO Creation" ? (
            <span className="text-white">SO Creation</span>
          ) : (
            <>
              <button onClick={() => router.push("/modules/production/so-creation")} className="hover:underline">
                SO Creation
              </button>
              <span>/</span>
              <span className="text-white">{title}</span>
            </>
          )}
        </nav>
        <div className="flex-1" />
        <button
          onClick={() => { signOut(); router.replace("/"); }}
          aria-label="Sign out"
          className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]"
        >
          {initial}
        </button>
      </header>

      <main className="flex-1 max-w-[1280px] w-full mx-auto px-4 sm:px-6 py-6">
        {showBackToSoCreation ? (
          <div className="mb-3">
            <button
              type="button"
              onClick={() => {
                if (typeof window !== "undefined" && window.history.length > 1) router.back();
                else router.push("/modules/production/so-creation");
              }}
              className="inline-flex items-center gap-1.5 h-7 px-2 -ml-2 text-[12px] text-[var(--aws-link)] hover:underline"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <line x1="19" y1="12" x2="5" y2="12" />
                <polyline points="12 19 5 12 12 5" />
              </svg>
              Back to SO Creation
            </button>
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
