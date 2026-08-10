"use client";

// Forgot-password flow replaces the old "contact admin" path. Two-step:
//   1. Phone → POST /password/reset/send-otp → 60s WhatsApp OTP
//   2. OTP + new password → POST /password/reset/verify → DB row erased,
//      sessions revoked, user can sign in immediately.
//
// No client-side password validation by product decision (2026-05-30) — the
// server takes the password verbatim too.

import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import {
  AuthError,
  sendResetOtp,
  verifyResetOtp,
} from "@/lib/auth";

type Step = "request" | "verify";
type Banner = { kind: "error" | "info" | "success"; text: string } | null;

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("request");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);

  // Countdown timer for the live OTP. Resets on every successful resend.
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (secondsLeft <= 0) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    if (timerRef.current) return;
    timerRef.current = setInterval(() => {
      setSecondsLeft((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [secondsLeft]);

  function describeError(err: unknown, fallback: string): string {
    if (err instanceof AuthError) {
      return err.envelope.message || fallback;
    }
    if (err instanceof Error) {
      return `${fallback}: ${err.message}`;
    }
    return fallback;
  }

  async function onSendOtp(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBanner(null);
    const trimmed = phone.trim();
    if (!trimmed) {
      setBanner({ kind: "error", text: "Enter your phone number." });
      return;
    }
    setSending(true);
    try {
      const r = await sendResetOtp(trimmed);
      setSecondsLeft(r.expires_in_seconds || 60);
      setStep("verify");
      setBanner({
        kind: "info",
        text: "If that phone is registered, an OTP has been sent on WhatsApp.",
      });
    } catch (err) {
      setBanner({
        kind: "error",
        text: describeError(err, "Couldn't send the OTP. Please try again."),
      });
    } finally {
      setSending(false);
    }
  }

  async function onVerifyAndReset(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBanner(null);
    const trimmedPhone = phone.trim();
    const trimmedOtp = otp.trim();
    if (!trimmedOtp) {
      setBanner({ kind: "error", text: "Enter the 6-digit OTP." });
      return;
    }
    if (!newPassword) {
      setBanner({ kind: "error", text: "Enter a new password." });
      return;
    }
    setVerifying(true);
    try {
      await verifyResetOtp(trimmedPhone, trimmedOtp, newPassword);
      setBanner({
        kind: "success",
        text: "Password updated. Redirecting to sign in…",
      });
      // Hand back to the login page — the OTP row is already erased
      // server-side and every live session was revoked.
      setTimeout(() => router.replace("/"), 900);
    } catch (err) {
      setBanner({
        kind: "error",
        text: describeError(err, "OTP could not be verified."),
      });
    } finally {
      setVerifying(false);
    }
  }

  async function onResend() {
    setBanner(null);
    setSending(true);
    try {
      const r = await sendResetOtp(phone.trim());
      // The server upserts on (user_id) so the prior OTP is invalidated;
      // restart the countdown to reflect that.
      setSecondsLeft(r.expires_in_seconds || 60);
      setOtp("");
      setBanner({ kind: "info", text: "A new OTP has been sent." });
    } catch (err) {
      setBanner({
        kind: "error",
        text: describeError(err, "Couldn't resend the OTP."),
      });
    } finally {
      setSending(false);
    }
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
              Reset your password
            </h1>
            <p className="text-[13px] text-[var(--text-secondary)] mb-5">
              {step === "request"
                ? "We'll send a one-time code to the WhatsApp number on file."
                : "Enter the code we sent on WhatsApp and choose a new password."}
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

            {step === "request" ? (
              <form onSubmit={onSendOtp} noValidate>
                <Field
                  id="phone"
                  label="Phone number"
                  type="tel"
                  autoComplete="tel"
                  value={phone}
                  onChange={setPhone}
                  disabled={sending}
                  autoFocus
                  inputMode="tel"
                />
                <button
                  type="submit"
                  disabled={sending}
                  className={[
                    "w-full mt-1 h-9 rounded-[2px] text-[14px] font-semibold",
                    "text-white border",
                    "shadow-[inset_0_-1px_0_rgba(0,0,0,0.18)]",
                    "transition-colors",
                    sending
                      ? "bg-[#c98f92] border-[#c98f92] cursor-not-allowed"
                      : "bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] active:bg-[var(--aws-orange-active)]",
                  ].join(" ")}
                >
                  {sending ? "Sending OTP…" : "Send OTP"}
                </button>
              </form>
            ) : (
              <form onSubmit={onVerifyAndReset} noValidate>
                <div className="mb-4">
                  <label className="block text-[13px] font-bold text-[var(--text-primary)] mb-1">
                    Phone number
                  </label>
                  <p className="text-[13px] text-[var(--text-secondary)] font-mono">
                    {phone}
                    <button
                      type="button"
                      onClick={() => {
                        setStep("request");
                        setOtp("");
                        setSecondsLeft(0);
                        setBanner(null);
                      }}
                      className="ml-2 text-[12px] text-[var(--aws-link)] hover:underline font-sans"
                    >
                      change
                    </button>
                  </p>
                </div>

                <Field
                  id="otp"
                  label="One-time code"
                  type="text"
                  autoComplete="one-time-code"
                  value={otp}
                  onChange={setOtp}
                  disabled={verifying}
                  autoFocus
                  inputMode="numeric"
                />
                <div className="-mt-3 mb-4 text-[12px] text-[var(--text-secondary)] flex items-center justify-between">
                  <span>
                    {secondsLeft > 0
                      ? `Expires in ${secondsLeft}s`
                      : "Code expired — resend below."}
                  </span>
                  <button
                    type="button"
                    onClick={onResend}
                    disabled={sending || secondsLeft > 0}
                    className={[
                      "text-[12px]",
                      sending || secondsLeft > 0
                        ? "text-[var(--text-muted)] cursor-not-allowed"
                        : "text-[var(--aws-link)] hover:underline",
                    ].join(" ")}
                  >
                    Resend OTP
                  </button>
                </div>

                <Field
                  id="new_password"
                  label="New password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={setNewPassword}
                  disabled={verifying}
                />
                <div className="-mt-3 mb-4 text-[12px]">
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="text-[var(--aws-link)] hover:underline"
                  >
                    {showPassword ? "Hide" : "Show"} password
                  </button>
                </div>

                <button
                  type="submit"
                  disabled={verifying}
                  className={[
                    "w-full mt-1 h-9 rounded-[2px] text-[14px] font-semibold",
                    "text-white border",
                    "shadow-[inset_0_-1px_0_rgba(0,0,0,0.18)]",
                    "transition-colors",
                    verifying
                      ? "bg-[#c98f92] border-[#c98f92] cursor-not-allowed"
                      : "bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] active:bg-[var(--aws-orange-active)]",
                  ].join(" ")}
                >
                  {verifying ? "Resetting…" : "Reset password"}
                </button>
              </form>
            )}
          </div>

          <p className="mt-4 text-[12px] leading-[18px] text-[var(--text-secondary)] text-center">
            Remembered it?{" "}
            <button
              type="button"
              onClick={() => router.replace("/")}
              className="text-[var(--aws-link)] hover:underline hover:text-[var(--aws-link-hover)]"
            >
              Back to sign in
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
  inputMode,
}: {
  id: string;
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  autoComplete?: string;
  autoFocus?: boolean;
  inputMode?: "tel" | "text" | "numeric" | "email";
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
        inputMode={inputMode}
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
