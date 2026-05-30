"use client";

// Admin landing — Users / Roles & Permissions / Permissions tabs.
// Mirrors frontend_replica/src/admin/admin.js (1199-line vanilla JS page)
// using React state + the silent-refresh apiFetch wrapper.
//
// Scope decisions for the port:
//   • Single-role UX (auth_user.role_id is single-FK on the server).
//   • Scope edits use PUT /users/{id}/scope; user header edits go through
//     PUT /users/{id} (allowlist-gated on the server).
//   • Reset-password is the IAM v1 admin endpoint
//     (POST /users/{id}/reset-password) — same as the source admin.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { BackLink } from "@/components/BackLink";
import { useRequireAuth, useUserInitial } from "@/lib/user";
import { userStore } from "@/lib/auth";
import {
  AdminRole,
  AdminUser,
  CreateUserPayload,
  ENTITY_OPTIONS,
  EditUserPayload,
  WAREHOUSE_OPTIONS,
  adminResetPassword,
  createRole,
  createUser,
  deactivateUser,
  editUser,
  floorsAvailable,
  fmtAdminDate,
  generateTempPassword,
  getRolePermissions,
  listPermissions,
  listRoles,
  listUsers,
  replaceUserScope,
  setRolePermissions,
  userEntities,
  userFloors,
  userIsAdmin,
  userPrimaryRoleName,
  userWarehouses,
} from "@/lib/admin-api";

type TabKey = "users" | "roles";

export default function AdminPage() {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);
  const initial = useUserInitial();

  const [me, setMe] = useState(() => (typeof window !== "undefined" ? userStore.load() : null));
  useEffect(() => {
    queueMicrotask(() => setMe(userStore.load()));
  }, [authed]);

  // Block non-admins inline — `useRequireAuth` only checks for ANY active
  // session; admin-only gating lives here so a non-admin who manually
  // navigates to /modules/admin sees an explanation rather than 401s on
  // every list call.
  const isAdmin = !!me?.is_admin;

  const [tab, setTab] = useState<TabKey>("users");

  // Shared role list — Users tab needs it for the role dropdown, Roles tab
  // is the source of truth, Permissions tab doesn't use it. Loaded once
  // and refreshed when a role mutation happens.
  const [roles, setRoles] = useState<AdminRole[]>([]);
  const refreshRoles = useCallback(async () => {
    try {
      setRoles(await listRoles());
    } catch {
      setRoles([]);
    }
  }, []);

  useEffect(() => {
    if (!authed || !isAdmin) return;
    // Deferred past the sync effect body so the react-hooks/set-state-
    // in-effect rule stays happy. The fetch inside still awaits normally.
    queueMicrotask(() => { void refreshRoles(); });
  }, [authed, isAdmin, refreshRoles]);

  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // Auto-dismiss toast after 3s so it doesn't pile up across mutations.
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(t);
  }, [toast]);

  if (!authed) return null;

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-6 gap-4">
        <BrandMark />
        <span className="text-[#d5dbdb] text-[13px] hidden sm:inline">Console</span>
        <nav className="text-[12px] text-[#d5dbdb] hidden md:flex items-center gap-2 ml-2">
          <button onClick={() => router.push("/modules")} className="hover:underline">Modules</button>
          <span>/</span>
          <span className="text-white">Admin</span>
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

      <main className="flex-1 max-w-[1280px] w-full mx-auto px-4 sm:px-6 py-6">
        <div className="mb-3">
          <BackLink parentHref="/modules" label="modules" />
        </div>

        <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">Admin</h1>
        <p className="text-[13px] text-[var(--text-secondary)] mt-1 mb-4">
          Manage users, roles, and the permission catalog. All actions require admin privileges.
        </p>

        {!isAdmin ? (
          <section className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)]">
            You don&rsquo;t have admin access. Ask an administrator to grant you the admin role, or
            switch to a different account.
          </section>
        ) : (
          <>
            <div className="flex gap-1 border-b border-[var(--aws-border)] mb-4">
              <TabButton active={tab === "users"} onClick={() => setTab("users")}>Users</TabButton>
              <TabButton active={tab === "roles"} onClick={() => setTab("roles")}>Roles &amp; Permissions</TabButton>
            </div>

            {tab === "users" && (
              <UsersTab
                roles={roles}
                onToast={setToast}
                currentUserId={me?.user_id ?? null}
              />
            )}
            {tab === "roles" && (
              <RolesTab
                roles={roles}
                onRolesChange={refreshRoles}
                onToast={setToast}
              />
            )}
          </>
        )}
      </main>

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

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
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

// ══════════════════════════════════════════════════════════════════════
//  USERS TAB
// ══════════════════════════════════════════════════════════════════════

type ToastFn = (t: { kind: "ok" | "err"; text: string }) => void;

function UsersTab({
  roles,
  onToast,
  currentUserId,
}: {
  roles: AdminRole[];
  onToast: ToastFn;
  // Thread the current admin's id through so we can refuse self-disable
  // without forcing the operator into a 401-and-redirect dead end. The
  // backend's deactivate-user route doesn't currently gate this, so the
  // guard lives here.
  currentUserId: string | undefined | null;
}) {
  const router = useRouter();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const [userModalOpen, setUserModalOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AdminUser | null>(null);

  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listUsers();
      setUsers(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load users");
      setUsers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { queueMicrotask(() => { void refresh(); }); }, [refresh]);

  // Debounce search to keep the table cheap when typing — 250ms matches the
  // legacy admin.js timer so the perceived feel is identical.
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search.trim().toLowerCase()), 250);
    return () => window.clearTimeout(t);
  }, [search]);

  const filtered = useMemo(() => {
    if (!debouncedSearch) return users;
    return users.filter((u) =>
      (u.full_name ?? "").toLowerCase().includes(debouncedSearch) ||
      (u.phone ?? "").toLowerCase().includes(debouncedSearch) ||
      (u.email ?? "").toLowerCase().includes(debouncedSearch) ||
      userPrimaryRoleName(u).toLowerCase().includes(debouncedSearch),
    );
  }, [users, debouncedSearch]);

  async function onDeactivate(u: AdminUser) {
    if (currentUserId != null && String(u.user_id) === String(currentUserId)) {
      onToast({ kind: "err", text: "You can't disable your own account. Ask another admin." });
      return;
    }
    if (!window.confirm("Disable this user? All their sessions will be revoked.")) return;
    try {
      await deactivateUser(u.user_id);
      onToast({ kind: "ok", text: "User disabled" });
      void refresh();
    } catch (e) {
      onToast({ kind: "err", text: e instanceof Error ? e.message : "Disable failed" });
    }
  }

  async function onReactivate(u: AdminUser) {
    try {
      await editUser(u.user_id, { is_active: true, status: "active" });
      onToast({ kind: "ok", text: "User activated" });
      void refresh();
    } catch (e) {
      onToast({ kind: "err", text: e instanceof Error ? e.message : "Activate failed" });
    }
  }

  return (
    <section>
      {/* Toolbar */}
      <div className="flex flex-wrap gap-2 mb-3 items-center">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search users…"
          className="h-9 px-3 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] flex-1 min-w-[200px]"
        />
        <button
          onClick={() => { setEditTarget(null); setUserModalOpen(true); }}
          className="h-9 px-4 text-[13px] font-semibold rounded-[2px] bg-[var(--aws-orange)] border border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white inline-flex items-center gap-2"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
          Create User
        </button>
      </div>

      {/* Users table — viewport-fitting layout
          ─────────────────────────────────────
          No horizontal scroll on purpose. Wide columns (Entity / Factory /
          Floors / Last Login) collapse to `hidden md:table-cell` so a
          phone-width viewport sees only Name / Phone / Role / Status /
          Actions. The hidden data is still on the user detail page one
          tap away. `table-fixed + w-full` plus column widths on the
          actions cell keep the layout deterministic at every breakpoint. */}
      <div className="bg-white border border-[var(--aws-border)] rounded-md overflow-hidden">
        <table className="w-full text-[12px] text-left table-fixed">
          <thead className="bg-[var(--surface-subtle)] text-[var(--text-muted)] uppercase tracking-wide font-semibold">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2 hidden sm:table-cell">Phone</th>
              <th className="px-3 py-2 hidden sm:table-cell">Role</th>
              <th className="px-3 py-2 hidden lg:table-cell">Entity</th>
              <th className="px-3 py-2 hidden lg:table-cell">Factory</th>
              <th className="px-3 py-2 hidden xl:table-cell">Floors</th>
              <th className="px-3 py-2 hidden md:table-cell">Status</th>
              <th className="px-3 py-2 hidden xl:table-cell">Last Login</th>
              <th className="px-3 py-2 w-[110px] sm:w-[160px]">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-[var(--text-muted)]">Loading…</td></tr>
            ) : error ? (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-[var(--aws-error)]">{error}</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-[var(--text-muted)]">No users found</td></tr>
            ) : filtered.map((u) => {
              const admin = userIsAdmin(u);
              const active = u.is_active !== false;
              const ents = admin ? ["all"] : userEntities(u);
              const whs = admin ? ["all"] : userWarehouses(u);
              const flrs = admin ? ["all"] : userFloors(u);
              return (
                <tr key={u.user_id} className="border-t border-[var(--aws-border)] hover:bg-[var(--surface-subtle)]">
                  <td className="px-3 py-2 min-w-0">
                    <button
                      onClick={() => router.push(`/modules/admin/users/${u.user_id}`)}
                      className="text-[var(--aws-link)] hover:underline font-semibold text-[13px] truncate block max-w-full text-left"
                    >
                      {u.full_name || "—"}
                    </button>
                    {/* On small viewports the phone + role columns are
                        hidden, so surface them as a compact sub-line under
                        the name. Keeps the dense-list affordance without
                        forcing scroll. */}
                    <div className="text-[10px] text-[var(--text-muted)] truncate sm:hidden">
                      {u.phone || "—"}
                      {userPrimaryRoleName(u) && ` · ${userPrimaryRoleName(u)}`}
                      {admin && " · Admin"}
                    </div>
                    {u.email && <div className="text-[10px] text-[var(--text-muted)] truncate hidden sm:block">{u.email}</div>}
                  </td>
                  <td className="px-3 py-2 font-mono text-[12px] hidden sm:table-cell truncate">{u.phone || "—"}</td>
                  <td className="px-3 py-2 hidden sm:table-cell">
                    <span className="inline-block text-[10px] uppercase tracking-wide font-bold bg-[#eaf3ff] text-[#0f4c81] rounded-sm px-1.5 py-0.5">
                      {userPrimaryRoleName(u) || "—"}
                    </span>
                    {admin && (
                      <span className="ml-1 inline-block text-[9px] uppercase tracking-wide font-bold bg-[#fef3e6] text-[#a35200] rounded-sm px-1 py-0.5">
                        Admin
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 hidden lg:table-cell"><ChipList items={ents} /></td>
                  <td className="px-3 py-2 hidden lg:table-cell"><ChipList items={whs} /></td>
                  <td className="px-3 py-2 hidden xl:table-cell">
                    {admin ? <ChipList items={["all"]} /> : (
                      flrs.length > 0
                        ? <span title={flrs.join(", ")} className="inline-block text-[10px] bg-[var(--surface-subtle)] border border-[var(--aws-border)] rounded-sm px-1.5 py-0.5">{flrs.length} floor{flrs.length === 1 ? "" : "s"}</span>
                        : <span className="text-[10px] italic text-[var(--text-muted)]">all</span>
                    )}
                  </td>
                  <td className="px-3 py-2 hidden md:table-cell whitespace-nowrap">
                    <span className={["inline-block w-2 h-2 rounded-full mr-1", active ? "bg-[#1d8102]" : "bg-[#a8a8a8]"].join(" ")} />
                    {active ? "Active" : "Inactive"}
                  </td>
                  <td className="px-3 py-2 text-[var(--text-secondary)] whitespace-nowrap hidden xl:table-cell">{fmtAdminDate(u.last_login_at)}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1 justify-end">
                      <ActionBtn onClick={() => router.push(`/modules/admin/users/${u.user_id}`)}>View</ActionBtn>
                      <ActionBtn onClick={() => { setEditTarget(u); setUserModalOpen(true); }}>Edit</ActionBtn>
                      <ActionBtn variant="warning" onClick={() => setResetTarget(u)}>Reset</ActionBtn>
                      {active
                        ? <ActionBtn variant="danger" onClick={() => onDeactivate(u)}>Disable</ActionBtn>
                        : <ActionBtn variant="ok" onClick={() => onReactivate(u)}>Enable</ActionBtn>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Create / Edit modal */}
      {userModalOpen && (
        <UserModal
          mode={editTarget ? "edit" : "create"}
          user={editTarget}
          roles={roles}
          onClose={() => { setUserModalOpen(false); setEditTarget(null); }}
          onSaved={() => {
            setUserModalOpen(false);
            setEditTarget(null);
            void refresh();
            onToast({ kind: "ok", text: editTarget ? "User updated" : "User created" });
          }}
          onError={(msg) => onToast({ kind: "err", text: msg })}
        />
      )}

      {/* Reset password modal */}
      {resetTarget && (
        <ResetPasswordModal
          user={resetTarget}
          onClose={() => setResetTarget(null)}
          onDone={() => { setResetTarget(null); onToast({ kind: "ok", text: "Password reset" }); }}
          onError={(msg) => onToast({ kind: "err", text: msg })}
        />
      )}
    </section>
  );
}

function ChipList({ items }: { items: string[] }) {
  if (items.length === 1 && items[0] === "all") {
    return <span className="text-[10px] italic text-[var(--text-muted)]">all</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((it, i) => (
        <span key={`${it}-${i}`} className="text-[10px] bg-[var(--surface-subtle)] border border-[var(--aws-border)] rounded-sm px-1.5 py-0.5">{it}</span>
      ))}
    </div>
  );
}

function ActionBtn({
  children,
  onClick,
  variant = "default",
}: {
  children: React.ReactNode;
  onClick: () => void;
  variant?: "default" | "warning" | "danger" | "ok";
}) {
  const cls = {
    default: "bg-white border-[var(--aws-border)] text-[var(--text-primary)] hover:bg-[var(--surface-subtle)]",
    warning: "bg-[#fef3e6] border-[#f5d6a8] text-[#a35200] hover:bg-[#fce7c5]",
    danger: "bg-[#fdf3f1] border-[var(--aws-error)] text-[var(--aws-error)] hover:bg-[#fae6e1]",
    ok: "bg-[#eaf6ed] border-[#b6dbb1] text-[#1d8102] hover:bg-[#d6efdb]",
  }[variant];
  return (
    <button
      type="button"
      onClick={onClick}
      className={["text-[10px] font-semibold rounded-[2px] border px-2 py-1", cls].join(" ")}
    >
      {children}
    </button>
  );
}

// ── Create / Edit user modal ─────────────────────────────────────────────

function UserModal({
  mode,
  user,
  roles,
  onClose,
  onSaved,
  onError,
}: {
  mode: "create" | "edit";
  user: AdminUser | null;
  roles: AdminRole[];
  onClose: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [fullName, setFullName] = useState(user?.full_name ?? "");
  const [phone, setPhone] = useState(user?.phone ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [password, setPassword] = useState("");
  const [roleId, setRoleId] = useState<number | "">(user?.role_id ?? "");
  const [entities, setEntities] = useState<string[]>(() => (user ? userEntities(user) : []));
  const [warehouses, setWarehouses] = useState<string[]>(() => (user ? userWarehouses(user) : []));
  const [floors, setFloors] = useState<string[]>(() => (user ? userFloors(user) : []));
  const [active, setActive] = useState(user ? user.is_active !== false : true);
  const [busy, setBusy] = useState(false);

  // When the warehouse selection changes, drop any floors that no longer
  // belong to a selected warehouse. Matches the legacy `_modalRefreshFloors`.
  const availableFloors = useMemo(() => floorsAvailable(warehouses), [warehouses]);
  useEffect(() => {
    queueMicrotask(() => {
      setFloors((prev) => prev.filter((f) => availableFloors.includes(f)));
    });
  }, [availableFloors]);

  function toggle<T extends string>(list: T[], setList: (v: T[]) => void, value: T) {
    setList(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }

  async function onSave() {
    if (!fullName.trim()) return onError("Name is required");
    if (roleId === "" || roleId === undefined) return onError("Select a role");

    const role = roles.find((r) => r.role_id === Number(roleId));
    const roleCode = role?.role_name;
    if (!roleCode) return onError("Selected role has no code");

    setBusy(true);
    try {
      if (mode === "create") {
        if (!phone.trim()) { onError("Phone is required"); return; }
        if (!password) { onError("Password is required"); return; }
        const payload: CreateUserPayload = {
          phone: phone.trim(),
          password,
          full_name: fullName.trim(),
          email: email.trim() || null,
          role_codes: [roleCode],
          entities,
          warehouses,
          floors,
          must_change_password: true,
        };
        await createUser(payload);
      } else if (user) {
        // Header fields (full_name, email, status, role_id) go through PUT /users/{id}.
        const newStatus: "active" | "suspended" = active ? "active" : "suspended";
        const patch: EditUserPayload = {
          full_name: fullName.trim(),
          email: email.trim() || null,
          status: newStatus,
        };
        if (Number(roleId) !== user.role_id) patch.role_id = Number(roleId);
        await editUser(user.user_id, patch);

        // Scope is a separate endpoint (PUT /users/{id}/scope). Only call it
        // when something actually changed so we don't trigger a needless
        // write or accidentally clear a field the admin didn't touch.
        const before = {
          entities: [...userEntities(user)].sort(),
          warehouses: [...userWarehouses(user)].sort(),
          floors: [...userFloors(user)].sort(),
        };
        const after = {
          entities: [...entities].sort(),
          warehouses: [...warehouses].sort(),
          floors: [...floors].sort(),
        };
        const changed =
          JSON.stringify(before.entities) !== JSON.stringify(after.entities) ||
          JSON.stringify(before.warehouses) !== JSON.stringify(after.warehouses) ||
          JSON.stringify(before.floors) !== JSON.stringify(after.floors);
        if (changed) {
          await replaceUserScope(user.user_id, { entities, warehouses, floors });
        }
      }
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div className="bg-white rounded-md w-full max-w-[640px] max-h-[90vh] overflow-y-auto p-5">
        <h3 className="text-[16px] font-semibold mb-4">{mode === "create" ? "Create User" : "Edit User"}</h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
          <Field label="Full Name *">
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} className="form-input" autoFocus />
          </Field>
          <Field label="Phone *">
            <input value={phone} onChange={(e) => setPhone(e.target.value)} disabled={mode === "edit"} className="form-input disabled:bg-[#f4f4f4]" />
          </Field>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
          <Field label="Email">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="form-input" />
          </Field>
          <Field label="Entity (select one or both)">
            <ChipGroup
              options={ENTITY_OPTIONS}
              selected={entities}
              onToggle={(v) => toggle(entities, setEntities, v)}
            />
          </Field>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
          <Field label="Role *">
            <select
              value={roleId}
              onChange={(e) => setRoleId(e.target.value ? Number(e.target.value) : "")}
              className="form-input"
            >
              <option value="">— Select Role —</option>
              {roles.map((r) => (
                <option key={r.role_id} value={r.role_id}>
                  {r.role_name}{r.is_admin ? " (Admin)" : ""}
                </option>
              ))}
            </select>
          </Field>
          {mode === "create" && (
            <Field label="Password *">
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Any password — server takes verbatim"
                autoComplete="new-password"
                className="form-input"
              />
            </Field>
          )}
        </div>

        <Field label="Factory / Warehouse (empty = all)">
          <ChipGroup
            options={WAREHOUSE_OPTIONS}
            selected={warehouses}
            onToggle={(v) => toggle(warehouses, setWarehouses, v)}
          />
        </Field>

        <Field label="Floor / Area (filtered by warehouses; empty = all in those warehouses)">
          {availableFloors.length === 0 ? (
            <div className="text-[11px] text-[var(--text-muted)] italic">Select a warehouse to enable floors.</div>
          ) : (
            <ChipGroup
              options={availableFloors.map((f) => ({ value: f, label: f }))}
              selected={floors}
              onToggle={(v) => toggle(floors, setFloors, v)}
            />
          )}
        </Field>

        {mode === "edit" && (
          <label className="flex items-center gap-2 mt-3 text-[13px] cursor-pointer">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="w-4 h-4 accent-[var(--aws-orange)]" />
            Active
          </label>
        )}

        <div className="flex justify-end gap-2 mt-5 pt-3 border-t border-[var(--aws-border)]">
          <ModalBtn onClick={onClose}>Cancel</ModalBtn>
          <ModalBtn variant="primary" onClick={onSave} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </ModalBtn>
        </div>
      </div>
    </ModalOverlay>
  );
}

// ── Reset password modal ─────────────────────────────────────────────────

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

  async function onReset() {
    if (!pw || pw.length < 1) { onError("Enter a temporary password"); return; }
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
    <ModalOverlay onClose={phase === "success" ? onDone : onClose}>
      <div className="bg-white rounded-md w-full max-w-[460px] p-5">
        {phase === "input" ? (
          <>
            <h3 className="text-[16px] font-semibold">Reset password</h3>
            <p className="text-[12px] text-[var(--text-secondary)] mt-1 mb-4">
              Set a temporary password for <strong>{user.full_name || `user #${user.user_id}`}</strong>. The user will be required to change it on next sign-in. <strong>All their active sessions will be revoked.</strong>
            </p>

            <Field label="Temporary password *">
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
                <button type="button" onClick={() => setReveal((v) => !v)} className="h-9 px-3 text-[12px] border border-[var(--aws-border-strong)] rounded-[2px]" title="Show / hide">
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
            </Field>

            <div className="flex justify-end gap-2 mt-5">
              <ModalBtn onClick={onClose}>Cancel</ModalBtn>
              <ModalBtn variant="warning" onClick={onReset} disabled={busy}>
                {busy ? "Resetting…" : "Reset password"}
              </ModalBtn>
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
              <ModalBtn variant="primary" onClick={onDone}>Done</ModalBtn>
            </div>
          </>
        )}
      </div>
    </ModalOverlay>
  );
}

// ══════════════════════════════════════════════════════════════════════
//  ROLES & PERMISSIONS TAB
// ══════════════════════════════════════════════════════════════════════

interface PermTreeRow {
  permission_id: number;
  action: string;
  description: string;
}
type PermTree = Record<string, Record<string, Record<string, PermTreeRow[]>>>;

function RolesTab({
  roles,
  onRolesChange,
  onToast,
}: {
  roles: AdminRole[];
  onRolesChange: () => Promise<void>;
  onToast: ToastFn;
}) {
  const [selectedRoleId, setSelectedRoleId] = useState<number | null>(null);
  const [tree, setTree] = useState<PermTree>({});
  const [granted, setGranted] = useState<Set<number>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [scope, setScope] = useState({ entities: "", warehouses: "", floors: "" });
  const [saving, setSaving] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const selectedRole = roles.find((r) => r.role_id === selectedRoleId) ?? null;

  async function loadPermsForRole(roleId: number) {
    try {
      // Read the flat list to synthesise the tree (matches admin.js since the
      // server's /permissions/hierarchy endpoint exists but returns the same
      // info in a different shape; flat list keeps our render loop simpler).
      const flat = await listPermissions();
      const next: PermTree = {};
      for (const p of flat) {
        const mod = p.module;
        const sub = p.sub_module || "_root";
        const subsub = p.sub_sub_module || "_root";
        next[mod] = next[mod] ?? {};
        next[mod][sub] = next[mod][sub] ?? {};
        next[mod][sub][subsub] = next[mod][sub][subsub] ?? [];
        next[mod][sub][subsub].push({
          permission_id: p.permission_id,
          action: p.action,
          description: p.description ?? "",
        });
      }
      setTree(next);

      const r = await getRolePermissions(roleId);
      const ids = new Set<number>((r.permissions ?? []).map((x) => x.permission_id));
      setGranted(ids);
      // Server returns scope on the role row OR on each permission row.
      // We surface the role-level scope here as the "default" for new
      // permission grants — matches the source admin's behaviour.
      const roleScope = {
        entities: (r.role.allowed_entities ?? []).join(", "),
        warehouses: (r.role.allowed_warehouses ?? []).join(", "),
        floors: (r.role.allowed_floors ?? []).join(", "),
      };
      setScope(roleScope);
    } catch (e) {
      onToast({ kind: "err", text: e instanceof Error ? e.message : "Failed to load role permissions" });
      setTree({});
      setGranted(new Set());
      setScope({ entities: "", warehouses: "", floors: "" });
    }
  }

  useEffect(() => {
    if (selectedRoleId == null) return;
    queueMicrotask(() => { void loadPermsForRole(selectedRoleId); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRoleId]);

  function togglePerm(pid: number) {
    setGranted((prev) => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });
  }

  function parseList(s: string): string[] | null {
    const t = s.trim();
    if (!t) return null;
    return t.split(",").map((p) => p.trim()).filter(Boolean);
  }

  async function onSavePerms() {
    if (selectedRoleId == null) return;
    setSaving(true);
    try {
      await setRolePermissions(selectedRoleId, {
        permission_ids: Array.from(granted),
        allowed_entities: parseList(scope.entities),
        allowed_warehouses: parseList(scope.warehouses),
        allowed_floors: parseList(scope.floors),
      });
      onToast({ kind: "ok", text: "Permissions saved" });
      void onRolesChange();
    } catch (e) {
      onToast({ kind: "err", text: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[13px] font-semibold">Roles</span>
        <div className="flex-1" />
        <button
          onClick={() => setCreateOpen(true)}
          className="h-9 px-4 text-[13px] font-semibold rounded-[2px] bg-[var(--aws-orange)] border border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white inline-flex items-center gap-2"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
          Create Role
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-4">
        {roles.length === 0 ? (
          <div className="col-span-full text-[13px] text-[var(--text-muted)] py-8 text-center">No roles defined</div>
        ) : roles.map((r) => (
          <button
            key={r.role_id}
            onClick={() => setSelectedRoleId(r.role_id)}
            className={[
              "text-left bg-white border rounded-md p-3 transition",
              selectedRoleId === r.role_id
                ? "border-[var(--aws-orange)] shadow-[0_2px_8px_rgba(0,28,36,0.15)]"
                : "border-[var(--aws-border)] hover:border-[var(--aws-orange)]",
            ].join(" ")}
          >
            <div className="text-[13px] font-semibold">
              {r.role_name}
              {r.is_admin && <span className="ml-1 text-[10px] text-[#a35200] font-bold">(Admin)</span>}
            </div>
            <div className="text-[11px] text-[var(--text-secondary)] mt-0.5 line-clamp-2">{r.description || "No description"}</div>
            <div className="text-[10px] text-[var(--text-muted)] mt-2">{r.permission_count ?? 0} permissions</div>
          </button>
        ))}
      </div>

      {selectedRole && (
        <div className="bg-white border border-[var(--aws-border)] rounded-md p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-[13px] font-semibold">
              Permissions for: <span className="text-[var(--aws-orange)]">{selectedRole.role_name}</span>
            </span>
            <div className="flex-1" />
            <ModalBtn variant="primary" onClick={onSavePerms} disabled={saving}>
              {saving ? "Saving…" : "Save Permissions"}
            </ModalBtn>
          </div>

          <div className="bg-[var(--surface-subtle)] border border-[var(--aws-border)] rounded-md p-3 mb-3">
            <div className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-secondary)] mb-2">
              Access Scope Restrictions
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <ScopeField label="Allowed Entities" placeholder="e.g. cfpl, cdpl" value={scope.entities} onChange={(v) => setScope((s) => ({ ...s, entities: v }))} />
              <ScopeField label="Allowed Floors" placeholder="e.g. 1st Floor" value={scope.floors} onChange={(v) => setScope((s) => ({ ...s, floors: v }))} />
              <ScopeField label="Allowed Warehouses" placeholder="e.g. W-202" value={scope.warehouses} onChange={(v) => setScope((s) => ({ ...s, warehouses: v }))} />
            </div>
            <p className="text-[10px] text-[var(--text-muted)] mt-2">Comma-separated. Empty = no restriction at this level.</p>
          </div>

          <PermissionTree tree={tree} granted={granted} collapsed={collapsed} onToggleCollapsed={(mod) => {
            setCollapsed((prev) => {
              const next = new Set(prev);
              if (next.has(mod)) next.delete(mod);
              else next.add(mod);
              return next;
            });
          }} onTogglePerm={togglePerm} />
        </div>
      )}

      {createOpen && (
        <RoleModal
          onClose={() => setCreateOpen(false)}
          onSaved={async () => {
            setCreateOpen(false);
            onToast({ kind: "ok", text: "Role created" });
            await onRolesChange();
          }}
          onError={(msg) => onToast({ kind: "err", text: msg })}
        />
      )}
    </section>
  );
}

function ScopeField({ label, placeholder, value, onChange }: { label: string; placeholder: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block text-[10px] text-[var(--text-muted)] mb-0.5">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="form-input"
      />
    </div>
  );
}

function PermissionTree({
  tree,
  granted,
  collapsed,
  onToggleCollapsed,
  onTogglePerm,
}: {
  tree: PermTree;
  granted: Set<number>;
  collapsed: Set<string>;
  onToggleCollapsed: (mod: string) => void;
  onTogglePerm: (pid: number) => void;
}) {
  const mods = Object.keys(tree).sort();
  if (mods.length === 0) {
    return <div className="text-[13px] text-[var(--text-muted)] py-6 text-center">No permissions defined</div>;
  }
  return (
    <div className="space-y-2">
      {mods.map((mod) => {
        let total = 0;
        let checked = 0;
        for (const sub of Object.values(tree[mod])) {
          for (const subsub of Object.values(sub)) {
            for (const a of subsub) {
              total++;
              if (granted.has(a.permission_id)) checked++;
            }
          }
        }
        const isCollapsed = collapsed.has(mod);
        return (
          <div key={mod} className="border border-[var(--aws-border)] rounded-md">
            <button
              onClick={() => onToggleCollapsed(mod)}
              className="w-full flex items-center gap-2 px-3 py-2 text-left bg-[var(--surface-subtle)] hover:bg-[var(--aws-border)]"
            >
              <svg
                viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2}
                className={["transition-transform", isCollapsed ? "" : "rotate-180"].join(" ")}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
              <span className="text-[12px] font-semibold">{mod}</span>
              <span className="ml-auto text-[10px] text-[var(--text-muted)] font-normal">{checked}/{total}</span>
            </button>
            {!isCollapsed && (
              <div className="px-3 py-2 space-y-2">
                {Object.entries(tree[mod]).map(([sub, subsubs]) => (
                  Object.entries(subsubs).map(([subsub, actions]) => {
                    const label = sub === "_root" ? "" : (subsub === "_root" ? sub : `${sub} > ${subsub}`);
                    return (
                      <div key={`${sub}-${subsub}`}>
                        {label && <div className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted)] mb-1">{label}</div>}
                        <div className="flex flex-wrap gap-1.5">
                          {actions.map((a) => (
                            <label key={a.permission_id} className="inline-flex items-center gap-1 text-[11px] cursor-pointer bg-white border border-[var(--aws-border)] rounded-sm px-1.5 py-0.5 hover:border-[var(--aws-orange)]">
                              <input
                                type="checkbox"
                                checked={granted.has(a.permission_id)}
                                onChange={() => onTogglePerm(a.permission_id)}
                                className="w-3 h-3 accent-[var(--aws-orange)]"
                              />
                              <span className="font-mono">{a.action}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    );
                  })
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RoleModal({
  onClose,
  onSaved,
  onError,
}: {
  onClose: () => void;
  onSaved: () => Promise<void> | void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSave() {
    if (!name.trim()) return onError("Role name is required");
    setBusy(true);
    try {
      await createRole({ role_name: name.trim(), description: desc.trim(), is_admin: isAdmin });
      await onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div className="bg-white rounded-md w-full max-w-[460px] p-5">
        <h3 className="text-[16px] font-semibold mb-4">Create Role</h3>
        <Field label="Role Name *">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Store Manager" className="form-input" autoFocus />
        </Field>
        <Field label="Description">
          <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Brief description" className="form-input" />
        </Field>
        <label className="flex items-center gap-2 mt-2 text-[13px] cursor-pointer">
          <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} className="w-4 h-4 accent-[var(--aws-orange)]" />
          Admin role (full access)
        </label>
        <div className="flex justify-end gap-2 mt-5">
          <ModalBtn onClick={onClose}>Cancel</ModalBtn>
          <ModalBtn variant="primary" onClick={onSave} disabled={busy}>{busy ? "Saving…" : "Save"}</ModalBtn>
        </div>
      </div>
    </ModalOverlay>
  );
}

// PERMISSIONS TAB was removed (2026-05-30 product decision). The catalog
// is still managed via the Roles & Permissions tab's per-role checkbox
// tree; standalone CRUD on permissions / modules lives only on the
// server-side admin API (POST /api/v1/auth/permissions/create, etc.) for
// callers that need it.
// ══════════════════════════════════════════════════════════════════════
//  Reusable bits
// ══════════════════════════════════════════════════════════════════════

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <label className="block text-[12px] font-semibold mb-1">{label}</label>
      {children}
    </div>
  );
}

function ChipGroup({
  options,
  selected,
  onToggle,
}: {
  options: { value: string; label: string }[];
  selected: string[];
  onToggle: (v: string) => void;
}) {
  if (options.length === 0) {
    return <div className="text-[11px] italic text-[var(--text-muted)]">— no options —</div>;
  }
  return (
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
  );
}

function ModalBtn({
  children,
  onClick,
  variant = "default",
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  variant?: "default" | "primary" | "warning";
  disabled?: boolean;
}) {
  const cls = {
    default: "bg-white border border-[var(--aws-border-strong)] text-[var(--text-primary)] hover:bg-[var(--surface-subtle)]",
    primary: "bg-[var(--aws-orange)] border border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white",
    warning: "bg-[#fef3e6] border border-[#f5d6a8] text-[#a35200] hover:bg-[#fce7c5]",
  }[variant];
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={[
        "h-9 px-4 text-[13px] font-semibold rounded-[2px] disabled:opacity-50 disabled:cursor-not-allowed",
        cls,
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function ModalOverlay({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      ref={overlayRef}
      onMouseDown={(e) => { if (e.target === overlayRef.current) onClose(); }}
      className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4"
    >
      {children}
    </div>
  );
}
