"use client";

// Profile page — landing for the operator's avatar click. Surfaces the
// cached MeResponse fields the rest of the app reads from (full_name,
// phone, email, role, allowed warehouses + floors, is_admin flag) and
// carries the destructive sign-out action separately so the avatar tap is
// no longer a one-click logout footgun.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  fetchMe,
  signOut,
  userStore,
  type MeResponse,
} from "@/lib/auth";
import { useRequireAuth, useUserInitial, initialFromName } from "@/lib/user";
import { BackLink } from "@/components/BackLink";

export default function ProfilePage() {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);
  const initial = useUserInitial();
  const [me, setMe] = useState<MeResponse | null>(null);

  useEffect(() => {
    if (!authed) return;
    if (typeof window === "undefined") return;
    // Show the cached snapshot immediately for a snappy paint, then refresh
    // from /me in the background. The cache covers the common case (back
    // from a module page after a recent login); the background refresh
    // covers the cold-start case (operator lands here from a bookmark or
    // deep link, cache is empty, must_change_password / scope changed
    // server-side since the last visit).
    queueMicrotask(() => setMe(userStore.load()));
    let cancelled = false;
    void (async () => {
      try {
        const fresh = await fetchMe();
        if (!cancelled) {
          userStore.save(fresh);
          setMe(fresh);
        }
      } catch {
        // Either the network failed or /me returned 401 — apiFetch will
        // have already redirected to "/" on a terminal envelope, so we
        // don't have to do anything here. Cached view stays on screen.
      }
    })();
    return () => { cancelled = true; };
  }, [authed]);

  // Type-safe view of the warehouses + floors aliases the backend uses on
  // /me. Same shape lib/user.ts reads. Roles were dropped from the panel by
  // product decision (2026-05-30) — /me still carries them but the profile
  // surface only renders the warehouse + floor scope.
  const warehouses = (me as unknown as { warehouses?: string[] } | null)?.warehouses ?? [];
  const floors = (me as unknown as { floors?: string[] } | null)?.floors ?? [];
  const fullName = me?.full_name?.trim() || "—";
  const phone = me?.phone?.trim() || "—";
  const email = (me?.email as string | undefined)?.trim() || "—";
  const isAdmin = !!me?.is_admin;
  const mustChange = !!me?.must_change_password;
  const status = me?.status || "—";

  function onSignOut() {
    // Confirmation gate — the destructive action lives off the avatar now,
    // but a stray click on the red button still ends the session and
    // discards any unsaved form drafts. Make the user say yes explicitly.
    if (typeof window === "undefined") return;
    const ok = window.confirm(
      "Sign out of this device?\n\nAny unsaved form drafts on the SO creation pages will be discarded.",
    );
    if (!ok) return;
    signOut();
    router.replace("/");
  }

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
          <span className="text-white">Profile</span>
        </nav>
        <div className="flex-1" />
        {/* The avatar in the corner stays here for visual consistency, but
            it no longer fires sign-out — that lives only on this page now. */}
        <span
          aria-hidden
          className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center"
        >
          {initial}
        </span>
      </header>

      <main className="flex-1 max-w-[900px] w-full mx-auto px-4 sm:px-6 py-6">
        <div className="mb-3">
          <BackLink parentHref="/modules" label="modules" />
        </div>

        <h1 className="text-[20px] leading-[24px] font-semibold text-[var(--text-primary)] mb-1">
          Profile
        </h1>
        <p className="text-[12px] text-[var(--text-secondary)] mb-4">
          Account details and access scope for your sign-in.
        </p>

        {/* ── Identity card ──────────────────────────────────────────── */}
        <section className="bg-white border border-[var(--aws-border)] rounded-md overflow-hidden mb-4">
          <div className="px-4 py-4 flex items-center gap-3 border-b border-[var(--aws-border)]">
            <span className="w-12 h-12 rounded-full bg-[var(--aws-orange)] text-white text-[20px] font-bold flex items-center justify-center shrink-0">
              {initialFromName(fullName)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[16px] font-semibold text-[var(--text-primary)] truncate">
                {fullName}
              </div>
              <div className="flex items-center gap-2 text-[11px] mt-0.5">
                {isAdmin ? (
                  <span className="inline-block text-[10px] uppercase tracking-wide font-bold text-[#1d8102] bg-[#eaf6ed] border border-[#b6dbb1] rounded-sm px-1.5 py-0.5">
                    Admin
                  </span>
                ) : null}
                <span className="text-[var(--text-muted)] capitalize">{status}</span>
              </div>
            </div>
          </div>

          {/* ── Contact + role grid ───────────────────────────────── */}
          <dl className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-[var(--aws-border)] border-b border-[var(--aws-border)]">
            <ProfileKV label="Phone" value={phone} mono />
            <ProfileKV label="Email" value={email} />
          </dl>

          {/* ── Access scope ──────────────────────────────────────── */}
          <div className="px-4 py-3">
            <div className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)] mb-2">
              Access scope
            </div>
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-[12px]">
              <ScopeKV label="Warehouses" items={warehouses.length === 0 ? ["All"] : warehouses} />
              <ScopeKV label="Floors" items={floors.length === 0 ? ["All"] : floors} />
            </dl>
          </div>
        </section>

        {mustChange ? (
          <section className="bg-[#fbeced] border border-[#e6bcbe] rounded-md px-4 py-3 mb-4 flex items-start gap-2 text-[12px]">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="text-[#9a393e] shrink-0 mt-0.5">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="13" />
              <circle cx="12" cy="16" r="0.6" fill="currentColor" />
            </svg>
            <span>
              <strong className="text-[#9a393e]">Password change required.</strong>{" "}
              An admin has flagged your account for a password reset.{" "}
              <button
                type="button"
                onClick={() => router.push("/forgot-password")}
                className="text-[var(--aws-link)] hover:underline"
              >
                Reset it via WhatsApp OTP
              </button>
              .
            </span>
          </section>
        ) : null}

        {/* ── Sign out — destructive action, visually separated ───── */}
        <section className="bg-white border border-[var(--aws-border)] rounded-md p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-[var(--text-primary)]">Sign out</div>
              <p className="text-[11px] text-[var(--text-secondary)] mt-0.5">
                Ends your session on this device. Any unsaved form drafts on the SO creation pages will be discarded.
              </p>
            </div>
            <button
              type="button"
              onClick={onSignOut}
              className="h-9 px-4 text-[12px] rounded-[2px] border border-[var(--aws-error)] bg-white text-[var(--aws-error)] hover:bg-[#fdf3f1] font-semibold inline-flex items-center gap-2"
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              Sign out
            </button>
          </div>
        </section>
      </main>

      <footer className="border-t border-[var(--aws-border)] bg-white py-3 px-6 text-[11px] text-[var(--text-secondary)] flex flex-wrap justify-center gap-x-4 gap-y-1">
        <a href="#" className="hover:underline">Privacy</a>
        <span>© {new Date().getFullYear()}</span>
      </footer>
    </div>
  );
}

function ProfileKV({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="px-4 py-3">
      <dt className="uppercase tracking-wide font-semibold text-[var(--text-muted)] text-[9px] leading-[12px] mb-0.5">
        {label}
      </dt>
      <dd className={["text-[13px] text-[var(--text-primary)] truncate", mono ? "font-mono" : ""].join(" ")}>
        {value}
      </dd>
    </div>
  );
}

function ScopeKV({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="min-w-0">
      <dt className="uppercase tracking-wide font-semibold text-[var(--text-muted)] text-[9px] leading-[12px] mb-1">
        {label}
      </dt>
      <dd className="flex flex-wrap gap-1">
        {items.map((it, i) => (
          <span
            key={`${it}-${i}`}
            className="text-[10px] text-[var(--text-secondary)] bg-[var(--surface-subtle)] border border-[var(--aws-border)] rounded-sm px-1.5 py-0.5"
          >
            {it}
          </span>
        ))}
      </dd>
    </div>
  );
}
