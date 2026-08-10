"use client";

// Force-change-password gate.
//
// Shown after login when /me reports must_change_password === true (admins
// hand out a temporary password when they create a user, and the user has
// to set their own before the rest of the app opens).
//
// Three valid arrival paths:
//   1. Login success on src/app/page.tsx — bounced here instead of /modules
//   2. Any authed page's useRequireAuth — redirects here when cached me
//      has must_change_password === true
//   3. Cold boot with a live refresh token where /me still reports the flag
//
// No client-side password validation by product decision (matches the
// forgot-password page; the server takes the password verbatim too).
//
// On success the backend revokes every live session including ours, so we
// have to clear local auth state and send the user back to the login page
// to sign in fresh with the new password.

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import {
  apiFetch,
  AuthError,
  signOut,
  tokenStore,
  userStore,
} from "@/lib/auth";

type Banner = { kind: "error" | "info" | "success"; text: string } | null;

export default function ChangePasswordPage() {
  const router = useRouter();
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const [submitting, setSubmitting] = useState(false);
  const [allowed, setAllowed] = useState(false);

  // Gate the page on its own — we deliberately don't call useRequireAuth
  // because that hook redirects here when must_change_password is true,
  // which would loop. Instead, mirror its checks inline:
  //   • no refresh token → bounce to login
  //   • cached me lacks must_change_password → bounce to /modules (user
  //     landed here in error, e.g. typed the URL after they'd already
  //     changed it)
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!tokenStore.hasRefreshToken() || tokenStore.isRefreshExpired()) {
      router.replace("/");
      return;
    }
    const cached = userStore.load();
    if (cached && cached.must_change_password !== true) {
      router.replace("/modules");
      return;
    }
    setAllowed(true);
  }, [router]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBanner(null);

    if (!oldPassword) {
      setBanner({ kind: "error", text: "Enter your current (temporary) password." });
      return;
    }
    if (!newPassword) {
      setBanner({ kind: "error", text: "Enter a new password." });
      return;
    }

    setSubmitting(true);
    try {
      // Backend contract (server_replica/.../auth/router.py):
      //   POST /api/v1/auth/password/change
      //   body { old_password, new_password, confirm_password }
      // We send confirm_password === new_password because the product
      // decision is to drop the confirmation field from this UI.
      const res = await apiFetch("/api/v1/auth/password/change", {
        method: "POST",
        body: JSON.stringify({
          old_password: oldPassword,
          new_password: newPassword,
          confirm_password: newPassword,
        }),
      });

      if (!res.ok) {
        let envelope: { error?: string; message?: string; details?: { rules?: string[] } } = {};
        try { envelope = await res.json(); } catch { /* not JSON */ }
        const code = envelope.error;
        let text: string;
        if (code === "invalid_old_password") {
          text = "Current password is incorrect.";
        } else if (code === "same_as_old") {
          text = "New password must be different from your current one.";
        } else if (code === "weak_password" && Array.isArray(envelope.details?.rules)) {
          text = `Weak password: ${envelope.details.rules.join("; ")}`;
        } else {
          text = envelope.message || `Couldn't change password (HTTP ${res.status}).`;
        }
        setBanner({ kind: "error", text });
        return;
      }

      // Success — server revoked every session including ours, so the
      // access token in storage is already dead. Wipe local state, show a
      // brief confirmation, then send the user to /modules. The /modules
      // page itself will fail its /me call and bounce to login, which is
      // exactly what we want — the user signs in fresh with the new
      // password.
      setBanner({
        kind: "success",
        text: "Password changed. Please sign in again with your new password.",
      });
      signOut();
      setTimeout(() => router.replace("/"), 900);
    } catch (err) {
      const text =
        err instanceof AuthError
          ? err.envelope.message || "Couldn't change password."
          : err instanceof Error
          ? `Couldn't change password: ${err.message}`
          : "Couldn't change password.";
      setBanner({ kind: "error", text });
    } finally {
      setSubmitting(false);
    }
  }

  function onSignOut() {
    signOut();
    router.replace("/");
  }

  if (!allowed) {
    return (
      <div className="min-h-screen flex flex-col">
        <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-6">
          <BrandMark />
        </header>
        <main className="flex-1 flex justify-center pt-10 px-4">
          <div className="text-[13px] text-[var(--text-secondary)]">Loading…</div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-6">
        <BrandMark />
      </header>

      <main className="flex-1 flex justify-center pt-10 pb-16 px-4">
        <div className="w-full max-w-[420px]">
          <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.3)] px-7 pt-7 pb-6">
            <h1 className="text-[28px] leading-[34px] font-semibold text-[var(--text-primary)] mb-1">
              Set a new password
            </h1>
            <p className="text-[13px] text-[var(--text-secondary)] mb-5">
              Your administrator issued a temporary password. Choose a new one
              to continue. All of your other sessions will be signed out.
            </p>

            {banner && (
              <div
                role={banner.kind === "error" ? "alert" : "status"}
                className={
                  banner.kind === "error"
                    ? "mb-4 border-l-4 border-[var(--aws-error)] bg-[#fdf3f1] text-[var(--text-primary)] text-[13px] px-3 py-2 rounded-sm"
                    : banner.kind === "success"
                    ? "mb-4 border-l-4 border-[#1d8102] bg-[#eaf6ed] text-[var(--text-primary)] text-[13px] px-3 py-2 rounded-sm"
                    : "mb-4 border-l-4 border-[var(--aws-link)] bg-[#f1faff] text-[var(--text-primary)] text-[13px] px-3 py-2 rounded-sm"
                }
              >
                {banner.text}
              </div>
            )}

            <form onSubmit={onSubmit} noValidate>
              <Field
                id="old_password"
                label="Current (temporary) password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={oldPassword}
                onChange={setOldPassword}
                disabled={submitting}
                autoFocus
              />

              <Field
                id="new_password"
                label="New password"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                value={newPassword}
                onChange={setNewPassword}
                disabled={submitting}
              />
              <div className="-mt-3 mb-4 text-[12px]">
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="text-[var(--aws-link)] hover:underline"
                >
                  {showPassword ? "Hide" : "Show"} passwords
                </button>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className={[
                  "w-full mt-1 h-9 rounded-[2px] text-[14px] font-semibold",
                  "text-white border",
                  "shadow-[inset_0_-1px_0_rgba(0,0,0,0.18)]",
                  "transition-colors",
                  submitting
                    ? "bg-[#c98f92] border-[#c98f92] cursor-not-allowed"
                    : "bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] active:bg-[var(--aws-orange-active)]",
                ].join(" ")}
              >
                {submitting ? "Changing password…" : "Change password"}
              </button>
            </form>
          </div>

          <p className="mt-4 text-[12px] leading-[18px] text-[var(--text-secondary)] text-center">
            Not you?{" "}
            <button
              type="button"
              onClick={onSignOut}
              className="text-[var(--aws-link)] hover:underline hover:text-[var(--aws-link-hover)]"
            >
              Sign out
            </button>
          </p>
        </div>
      </main>

      <footer className="border-t border-[var(--aws-border)] bg-white py-3 px-6 text-[11px] text-[var(--text-secondary)] flex flex-wrap justify-center gap-x-4 gap-y-1">
        <a href="#" className="hover:underline">
          Privacy
        </a>
        <span>© {new Date().getFullYear()}</span>
      </footer>
    </div>
  );
}

function Field({
  id,
  label,
  type,
  value,
  onChange,
  disabled,
  autoComplete,
  autoFocus,
}: {
  id: string;
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  autoComplete?: string;
  autoFocus?: boolean;
}) {
  return (
    <div className="mb-4">
      <label
        htmlFor={id}
        className="block text-[13px] font-bold text-[var(--text-primary)] mb-1"
      >
        {label}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        className={[
          "w-full h-9 px-2 text-[14px] rounded-[2px] bg-white",
          "border outline-none transition-shadow",
          "border-[var(--aws-border-strong)] focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]",
          "disabled:bg-[#f4f4f4] disabled:text-[#879596]",
        ].join(" ")}
      />
    </div>
  );
}
