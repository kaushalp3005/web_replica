"use client";

// Admin · User Detail — mirrors frontend_replica/src/admin/user-detail/.
// Three panes the backend can support today:
//   • Profile — read-only header + contact + status
//   • Scope — edit allowed entities / warehouses / floors
//   • Sessions — note: backend exposes /sessions only for the calling user;
//     admins viewing another user's sessions need the IAM v1 admin-sessions
//     endpoint which isn't shipped yet. We surface a placeholder explaining
//     that, mirroring the legacy admin user-detail's "mock data" banner.
//
// The Reset password action lives in the header so the action surfaces
// straight from the user header without backtracking to the list.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { BackLink } from "@/components/BackLink";
import { useRequireAuth, useUserInitial, initialFromName } from "@/lib/user";
import { userStore } from "@/lib/auth";
import {
  AdminUser,
  ENTITY_OPTIONS,
  WAREHOUSE_OPTIONS,
  adminResetPassword,
  deactivateUser,
  editUser,
  floorsAvailable,
  fmtAdminDate,
  generateTempPassword,
  getUser,
  replaceUserScope,
  userEntities,
  userFloors,
  userPrimaryRoleName,
  userWarehouses,
} from "@/lib/admin-api";

type Pane = "profile" | "scope" | "sessions";

export default function UserDetailPage() {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);
  const initial = useUserInitial();
  const params = useParams<{ userId: string }>();
  const userId = params?.userId ?? "";

  const [me, setMe] = useState(() => (typeof window !== "undefined" ? userStore.load() : null));
  useEffect(() => {
    queueMicrotask(() => setMe(userStore.load()));
  }, [authed]);
  const isAdmin = !!me?.is_admin;

  const [user, setUser] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [pane, setPane] = useState<Pane>("profile");
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [resetOpen, setResetOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      setUser(await getUser(userId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load user");
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (!authed || !isAdmin) return;
    queueMicrotask(() => { void refresh(); });
  }, [authed, isAdmin, refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(t);
  }, [toast]);

  async function onDeactivate() {
    if (!user) return;
    // Guard against self-disable — the backend doesn't gate this, and
    // disabling yourself would immediately invalidate the session that's
    // showing this page, leaving the operator stranded on a 401.
    if (me?.user_id != null && String(user.user_id) === String(me.user_id)) {
      setToast({ kind: "err", text: "You can't disable your own account. Ask another admin." });
      return;
    }
    if (!window.confirm("Disable this user? All their sessions will be revoked.")) return;
    try {
      await deactivateUser(user.user_id);
      setToast({ kind: "ok", text: "User disabled" });
      void refresh();
    } catch (e) {
      setToast({ kind: "err", text: e instanceof Error ? e.message : "Disable failed" });
    }
  }

  async function onReactivate() {
    if (!user) return;
    try {
      await editUser(user.user_id, { is_active: true, status: "active" });
      setToast({ kind: "ok", text: "User activated" });
      void refresh();
    } catch (e) {
      setToast({ kind: "err", text: e instanceof Error ? e.message : "Activate failed" });
    }
  }

  // Hydration gate: on SSR useRequireAuth returns true (no token store), but the
  // first client render starts authed=false — a bare early-return made the server
  // HTML and the first client paint diverge (the duplicated/ghost screen). Hold the
  // redirect until after mount so SSR and the first client paint are identical.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { queueMicrotask(() => setMounted(true)); }, []);

  if (mounted && !authed) return null;

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-6 gap-4">
        <BrandMark />
        <span className="text-[#d5dbdb] text-[13px] hidden sm:inline">Console</span>
        <nav className="text-[12px] text-[#d5dbdb] hidden md:flex items-center gap-2 ml-2">
          <button onClick={() => router.push("/modules")} className="hover:underline">Modules</button>
          <span>/</span>
          <button onClick={() => router.push("/modules/admin")} className="hover:underline">Admin</button>
          <span>/</span>
          <span className="text-white truncate max-w-[200px]">{user?.full_name ?? `User ${userId}`}</span>
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

      <main className="flex-1 max-w-[1100px] w-full mx-auto px-4 sm:px-6 py-6">
        <div className="mb-3">
          <BackLink parentHref="/modules/admin" label="admin" />
        </div>

        {!isAdmin ? (
          <section className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)]">
            Admin access required.
          </section>
        ) : loading ? (
          <div className="text-[13px] text-[var(--text-muted)] py-10 text-center">Loading…</div>
        ) : error || !user ? (
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--aws-error)]">
            {error || "User not found"}
          </div>
        ) : (
          <>
            <UserHeader
              user={user}
              onReset={() => setResetOpen(true)}
              onDeactivate={onDeactivate}
              onReactivate={onReactivate}
            />

            <div className="flex gap-1 border-b border-[var(--aws-border)] mt-4 mb-4">
              <PaneTab active={pane === "profile"} onClick={() => setPane("profile")}>Profile</PaneTab>
              <PaneTab active={pane === "scope"} onClick={() => setPane("scope")}>Scope</PaneTab>
              <PaneTab active={pane === "sessions"} onClick={() => setPane("sessions")}>Sessions</PaneTab>
            </div>

            {pane === "profile" && <ProfilePane user={user} />}
            {pane === "scope" && (
              <ScopePane
                user={user}
                onSaved={() => { setToast({ kind: "ok", text: "Scope updated" }); void refresh(); }}
                onError={(msg) => setToast({ kind: "err", text: msg })}
              />
            )}
            {pane === "sessions" && <SessionsPane />}
          </>
        )}
      </main>

      {resetOpen && user && (
        <ResetPasswordModal
          user={user}
          onClose={() => setResetOpen(false)}
          onDone={() => { setResetOpen(false); setToast({ kind: "ok", text: "Password reset" }); }}
          onError={(msg) => setToast({ kind: "err", text: msg })}
        />
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-[420px]">
          <div
            role={toast.kind === "err" ? "alert" : "status"}
            className={[
              "px-4 py-2 rounded-md shadow-[0_2px_8px_rgba(0,28,36,0.25)] text-[13px] font-semibold",
              toast.kind === "err"
                ? "bg-[#fdf3f1] border border-[var(--aws-error)] text-[var(--aws-error)]"
                : "bg-[#eaf6ed] border border-[#b6dbb1] text-[#1d8102]",
            ].join(" ")}
          >
            {toast.text}
          </div>
        </div>
      )}

      <footer className="border-t border-[var(--aws-border)] bg-white py-3 px-6 text-[11px] text-[var(--text-secondary)] flex flex-wrap justify-center gap-x-4 gap-y-1">
        <a href="#" className="hover:underline">Privacy</a>
        <span>© {new Date().getFullYear()}</span>
      </footer>
    </div>
  );
}

function PaneTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={[
        "px-4 py-2 text-[13px] font-semibold border-b-2 -mb-px",
        active
          ? "text-[var(--text-primary)] border-[var(--aws-orange)]"
          : "text-[var(--text-secondary)] border-transparent hover:text-[var(--text-primary)]",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

// ── Header card ──────────────────────────────────────────────────────────

function UserHeader({
  user,
  onReset,
  onDeactivate,
  onReactivate,
}: {
  user: AdminUser;
  onReset: () => void;
  onDeactivate: () => void;
  onReactivate: () => void;
}) {
  const active = user.is_active !== false;
  const status = user.status ?? (active ? "active" : "disabled");
  return (
    <section className="bg-white border border-[var(--aws-border)] rounded-md px-4 py-4 flex items-center gap-3">
      <span className="w-12 h-12 rounded-full bg-[var(--aws-orange)] text-white text-[20px] font-bold flex items-center justify-center shrink-0">
        {initialFromName(user.full_name ?? "")}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[16px] font-semibold text-[var(--text-primary)] truncate">
          {user.full_name || "—"}
        </div>
        <div className="flex items-center flex-wrap gap-2 text-[11px] mt-0.5">
          <span className="text-[var(--text-muted)] font-mono">{user.phone || "—"}</span>
          {user.email && <span className="text-[var(--text-muted)] truncate">{user.email}</span>}
          {userPrimaryRoleName(user) && (
            <span className="inline-block text-[10px] uppercase tracking-wide font-bold bg-[#eaf3ff] text-[#0f4c81] rounded-sm px-1.5 py-0.5">
              {userPrimaryRoleName(user)}
            </span>
          )}
          {user.is_admin && (
            <span className="inline-block text-[10px] uppercase tracking-wide font-bold bg-[#fef3e6] text-[#a35200] rounded-sm px-1.5 py-0.5">
              Admin
            </span>
          )}
          <span className="text-[var(--text-muted)] capitalize">{status}</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button onClick={onReset} className="h-8 px-3 text-[12px] font-semibold rounded-[2px] border border-[#f5d6a8] bg-[#fef3e6] text-[#a35200] hover:bg-[#fce7c5]">
          Reset password
        </button>
        {active ? (
          <button onClick={onDeactivate} className="h-8 px-3 text-[12px] font-semibold rounded-[2px] border border-[var(--aws-error)] bg-white text-[var(--aws-error)] hover:bg-[#fdf3f1]">
            Disable
          </button>
        ) : (
          <button onClick={onReactivate} className="h-8 px-3 text-[12px] font-semibold rounded-[2px] border border-[#b6dbb1] bg-[#eaf6ed] text-[#1d8102] hover:bg-[#d6efdb]">
            Enable
          </button>
        )}
      </div>
    </section>
  );
}

// ── Profile pane ─────────────────────────────────────────────────────────

function ProfilePane({ user }: { user: AdminUser }) {
  const status = user.status ?? (user.is_active === false ? "disabled" : "active");
  return (
    <section className="bg-white border border-[var(--aws-border)] rounded-md p-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-[13px]">
        <KV label="User ID" value={String(user.user_id)} mono />
        <KV label="Phone" value={user.phone || "—"} mono />
        <KV label="Email" value={user.email || "—"} />
        <KV label="Status" value={status} cap />
        <KV label="Must change password" value={user.must_change_password ? "Yes" : "No"} />
        <KV label="Created" value={fmtAdminDate(user.created_at)} />
        <KV label="Last login" value={fmtAdminDate(user.last_login_at)} />
        <KV label="Password changed" value={fmtAdminDate(user.password_changed_at)} />
      </div>
    </section>
  );
}

function KV({ label, value, mono, cap }: { label: string; value: string; mono?: boolean; cap?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted)] mb-0.5">{label}</div>
      <div className={["text-[13px] text-[var(--text-primary)] truncate", mono && "font-mono", cap && "capitalize"].filter(Boolean).join(" ")}>{value}</div>
    </div>
  );
}

// ── Scope pane ───────────────────────────────────────────────────────────

function ScopePane({
  user,
  onSaved,
  onError,
}: {
  user: AdminUser;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [entities, setEntities] = useState<string[]>(() => userEntities(user));
  const [warehouses, setWarehouses] = useState<string[]>(() => userWarehouses(user));
  const [floors, setFloors] = useState<string[]>(() => userFloors(user));
  const [busy, setBusy] = useState(false);

  const available = useMemo(() => floorsAvailable(warehouses), [warehouses]);
  useEffect(() => {
    queueMicrotask(() => {
      setFloors((prev) => prev.filter((f) => available.includes(f)));
    });
  }, [available]);

  function toggle<T extends string>(list: T[], setList: (v: T[]) => void, value: T) {
    setList(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }

  async function onSave() {
    setBusy(true);
    try {
      await replaceUserScope(user.user_id, { entities, warehouses, floors });
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bg-white border border-[var(--aws-border)] rounded-md p-4">
      <h3 className="text-[14px] font-semibold mb-3">Access scope</h3>
      <p className="text-[11px] text-[var(--text-muted)] mb-4">
        Empty selection = no restriction at the user level (role-permission scope still applies).
      </p>

      <ScopeChips label="Entities" options={ENTITY_OPTIONS} selected={entities} onToggle={(v) => toggle(entities, setEntities, v)} />
      <ScopeChips label="Warehouses" options={WAREHOUSE_OPTIONS} selected={warehouses} onToggle={(v) => toggle(warehouses, setWarehouses, v)} />
      <div className="mt-3">
        <div className="text-[12px] font-semibold mb-1">Floors</div>
        {available.length === 0 ? (
          <div className="text-[11px] italic text-[var(--text-muted)]">Select a warehouse to enable floors.</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {available.map((f) => {
              const on = floors.includes(f);
              return (
                <label key={f} className={[
                  "inline-flex items-center gap-1 text-[12px] cursor-pointer rounded-sm px-2 py-1 border",
                  on
                    ? "bg-[#fef3e6] border-[var(--aws-orange)] text-[var(--text-primary)]"
                    : "bg-white border-[var(--aws-border)] text-[var(--text-secondary)] hover:border-[var(--aws-orange)]",
                ].join(" ")}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => toggle(floors, setFloors, f)}
                    className="w-3 h-3 accent-[var(--aws-orange)]"
                  />
                  <span>{f}</span>
                </label>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex justify-end mt-5">
        <button
          onClick={onSave}
          disabled={busy}
          className="h-9 px-4 text-[13px] font-semibold rounded-[2px] bg-[var(--aws-orange)] border border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save scope"}
        </button>
      </div>
    </section>
  );
}

function ScopeChips({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onToggle: (v: string) => void;
}) {
  return (
    <div className="mt-3">
      <div className="text-[12px] font-semibold mb-1">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const on = selected.includes(o.value);
          return (
            <label key={o.value} className={[
              "inline-flex items-center gap-1 text-[12px] cursor-pointer rounded-sm px-2 py-1 border",
              on
                ? "bg-[#fef3e6] border-[var(--aws-orange)] text-[var(--text-primary)]"
                : "bg-white border-[var(--aws-border)] text-[var(--text-secondary)] hover:border-[var(--aws-orange)]",
            ].join(" ")}>
              <input
                type="checkbox"
                checked={on}
                onChange={() => onToggle(o.value)}
                className="w-3 h-3 accent-[var(--aws-orange)]"
              />
              <span>{o.label}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

// ── Sessions pane (placeholder until admin sessions endpoint ships) ──────

function SessionsPane() {
  return (
    <section className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)]">
      <div className="text-[14px] font-semibold mb-2 text-[var(--text-primary)]">Sessions</div>
      <p>
        Viewing another user&rsquo;s sessions requires the admin sessions endpoint, which isn&rsquo;t shipped yet.
        Admin-side session revocation works via the <strong>Reset password</strong> action above —
        that endpoint already revokes every live refresh token for the target user.
      </p>
    </section>
  );
}

// ── Reset password modal (same UX as the admin landing) ──────────────────

function ResetPasswordModal({
  user,
  onClose,
  onDone,
  onError,
}: {
  user: AdminUser;
  onClose: () => void;
  onDone: () => void;
  onError: (msg: string) => void;
}) {
  const [pw, setPw] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<"input" | "success">("input");
  const [revoked, setRevoked] = useState(0);
  const [copyState, setCopyState] = useState<"idle" | "ok">("idle");

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function onReset() {
    if (!pw) { onError("Enter a temporary password"); return; }
    setBusy(true);
    try {
      const r = await adminResetPassword(user.user_id, pw);
      setRevoked(r.revoked_count);
      setReveal(true);
      setPhase("success");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Reset failed");
    } finally {
      setBusy(false);
    }
  }

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(pw);
      setCopyState("ok");
      window.setTimeout(() => setCopyState("idle"), 2000);
    } catch {
      onError("Copy failed; select and copy manually");
    }
  }

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4"
    >
      <div className="bg-white rounded-md w-full max-w-[460px] p-5">
        {phase === "input" ? (
          <>
            <h3 className="text-[16px] font-semibold">Reset password</h3>
            <p className="text-[12px] text-[var(--text-secondary)] mt-1 mb-4">
              Set a temporary password for <strong>{user.full_name || `user #${user.user_id}`}</strong>. The user will be required to change it on next sign-in. <strong>All their active sessions will be revoked.</strong>
            </p>
            <label className="block text-[12px] font-semibold mb-1">Temporary password *</label>
            <div className="flex gap-1">
              <input
                type={reveal ? "text" : "password"}
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                placeholder="Enter or generate a password"
                autoComplete="new-password"
                autoFocus
                className="form-input flex-1"
              />
              <button type="button" onClick={() => setReveal((v) => !v)} className="h-9 px-3 text-[12px] border border-[var(--aws-border-strong)] rounded-[2px]">
                {reveal ? "Hide" : "Show"}
              </button>
              <button
                type="button"
                onClick={() => { setPw(generateTempPassword()); setReveal(true); }}
                className="h-9 px-3 text-[12px] font-semibold border border-[var(--aws-border-strong)] rounded-[2px] bg-[var(--surface-subtle)]"
              >
                Generate
              </button>
            </div>
            <p className="text-[11px] text-[var(--text-muted)] mt-1">No complexity rules — server takes whatever you type.</p>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={onClose} className="h-9 px-4 text-[13px] font-semibold rounded-[2px] bg-white border border-[var(--aws-border-strong)] hover:bg-[var(--surface-subtle)]">
                Cancel
              </button>
              <button
                onClick={onReset}
                disabled={busy}
                className="h-9 px-4 text-[13px] font-semibold rounded-[2px] bg-[#fef3e6] border border-[#f5d6a8] text-[#a35200] hover:bg-[#fce7c5] disabled:opacity-50"
              >
                {busy ? "Resetting…" : "Reset password"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="text-[#1d8102] mb-2">
              <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth={2.5}><polyline points="20 6 9 17 4 12" /></svg>
            </div>
            <h3 className="text-[16px] font-semibold">Password reset</h3>
            <p className="text-[12px] text-[var(--text-secondary)] mt-1 mb-3">
              Share this temporary password with the user securely. <strong>It will not be shown again.</strong>
            </p>
            <div className="flex gap-2 items-center mb-2 bg-[var(--surface-subtle)] border border-[var(--aws-border)] rounded-md px-3 py-2">
              <code className="font-mono text-[14px] flex-1 break-all">{pw}</code>
              <button onClick={onCopy} className="h-7 px-3 text-[12px] font-semibold bg-[var(--aws-orange)] text-white rounded-[2px]">
                {copyState === "ok" ? "Copied ✓" : "Copy"}
              </button>
            </div>
            <p className="text-[11px] text-[var(--text-muted)]">
              {revoked > 0 ? `${revoked} active session${revoked === 1 ? "" : "s"} revoked.` : "All active sessions revoked."}
            </p>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={onDone} className="h-9 px-4 text-[13px] font-semibold rounded-[2px] bg-[var(--aws-orange)] border border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white">
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
