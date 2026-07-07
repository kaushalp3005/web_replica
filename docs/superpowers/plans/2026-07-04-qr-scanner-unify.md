# QR Scanner Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace both `@zxing` QR scanners in `linux_replica/web_replica` with one shared `qr-scanner` (nimiq) core, and show the decoded value + scan history below the job-card scanner.

**Architecture:** A `useQrScanner` hook owns the `qr-scanner` lifecycle (dynamic import, ROI scan region, per-value cooldown, camera-error → manual fallback). `QrScanView` is the shared camera surface. The transfer modal and the job-card inline scanner both render `QrScanView`; the job-card page adds a `ScanHistory` panel. `@zxing` is removed entirely.

**Tech Stack:** Next.js 16.2.6 (non-standard build — see app `AGENTS.md`), React 19, TypeScript, Tailwind v4, `qr-scanner` ^1.4.2.

## Global Constraints

- **Non-standard Next.js 16.2.6.** Per `linux_replica/web_replica/AGENTS.md`: "Read the relevant guide in `node_modules/next/dist/docs/` before writing any code." Do this in Task 1.
- **All QR decoding is client-side.** No backend changes. No `fetch` added for decoding.
- **Preserve consumer interfaces exactly:** `QRScanner({ onScan, onClose, title?, hint? })` and `RawMaterialTab({ jcId })`. The 3 transfer pages and `job-card/[id]/page.tsx` must NOT be edited.
- **Dependencies:** remove `@zxing/browser` (^0.2.0) and `@zxing/library` (^0.22.0); add `qr-scanner` (^1.4.2); keep `qrcode.react` (^4.2.0).
- **Single ROI ratio `0.62`** drives BOTH `qr-scanner`'s `calculateScanRegion` and the on-screen overlay box, so "what you frame is what's decoded."
- **`onDecode` contract:** `(text: string) => boolean | void | Promise<boolean | void>`. Returning `false` marks the scan "not usable" (red bar); anything else is "ok" (green bar).
- **No git repo** (`web_replica` is not under version control): there are NO commit steps. Each task ends with a lint/build/grep checkpoint instead.
- **No unit-test harness** (scripts are only `dev`/`build`/`start`/`lint`): verification is `npm run lint`, `npm run build` (typecheck), `grep`, and manual dev-server runs.

---

### Task 1: Pre-flight — read Next.js 16 docs, confirm alias & CSP

**Files:**
- Read: `linux_replica/web_replica/node_modules/next/dist/docs/` (relevant guides)
- Read: `linux_replica/web_replica/tsconfig.json`
- Read: `linux_replica/web_replica/next.config.*` and any `middleware.ts` / headers config

**Interfaces:**
- Produces: (a) the import style for shared files — the `@/*` path alias if present, else the correct relative path; (b) confirmation that no CSP blocks `worker-src blob:` / `script-src blob:` (qr-scanner builds its worker from a Blob URL).

- [ ] **Step 1: Read the client-component + dynamic-import guidance**

Read whichever of these exist under `node_modules/next/dist/docs/`: client components, `"use client"`, dynamic `import()` / lazy loading, and any "web workers" note. Confirm a browser-only lib loaded via `await import("qr-scanner")` inside a `"use client"` component is the supported pattern in this version (no SSR evaluation of browser globals).

- [ ] **Step 2: Resolve the import alias**

Run: `cat tsconfig.json` (look at `compilerOptions.paths`).
- If `"@/*"` maps to `src/*` (or similar), shared files import as `@/components/qr/...`.
- If there is NO alias, use relative imports. From `src/app/modules/transfer/_QRScanner.tsx` and `src/app/modules/job-card/[id]/_RawMaterialTab.tsx` the path to `src/components/qr/` differs — compute each precisely (e.g. `../../../components/qr/QrScanView` from `transfer/`, `../../../../components/qr/QrScanView` from `job-card/[id]/`).

Record the exact import specifier to use in Tasks 3–5.

- [ ] **Step 3: Confirm CSP allows a Blob worker**

Search config for a Content-Security-Policy: `grep -rin "Content-Security-Policy\|worker-src\|script-src" next.config.* middleware.ts src 2>/dev/null`.
- If no CSP is set → nothing to do.
- If a CSP exists and lacks `worker-src blob:` (falling back to a restrictive `script-src`) → note that `worker-src blob:` must be added; include that edit in Task 6. If unsure, defer — the manual run in Task 5 will reveal a blocked worker.

- [ ] **Step 4: Checkpoint**

No code changed. Confirm you have: the import specifier, and a yes/no on CSP needing a `worker-src blob:` addition. Proceed.

---

### Task 2: Add the `qr-scanner` dependency

**Files:**
- Modify: `linux_replica/web_replica/package.json` (dependencies)

Keep `@zxing/*` for now so the app still builds while the shared core is added; `@zxing` is removed only in Task 6, after both consumers stop importing it.

- [ ] **Step 1: Add the dependency**

In `package.json` `dependencies`, add `"qr-scanner": "^1.4.2"` (keep `@zxing/browser`, `@zxing/library`, `qrcode.react` as-is for now):

```json
  "dependencies": {
    "@zxing/browser": "^0.2.0",
    "@zxing/library": "^0.22.0",
    "next": "16.2.6",
    "qr-scanner": "^1.4.2",
    "qrcode.react": "^4.2.0",
    "react": "19.2.4",
    "react-dom": "19.2.4"
  },
```

- [ ] **Step 2: Install**

Run: `npm install`
Expected: completes; `node_modules/qr-scanner/` present.

- [ ] **Step 3: Verify install + baseline build still green**

Run: `npm ls qr-scanner` → shows `qr-scanner@1.4.2`.
Run: `npm run build`
Expected: PASS (no source changed yet).

- [ ] **Step 4: Checkpoint** — dependency present, build green. Proceed.

---

### Task 3: Create the shared QR core (`src/components/qr/`)

**Files:**
- Create: `linux_replica/web_replica/src/components/qr/useQrScanner.ts`
- Create: `linux_replica/web_replica/src/components/qr/QrScanView.tsx`
- Create: `linux_replica/web_replica/src/components/qr/ScanHistory.tsx`

**Interfaces:**
- Produces:
  - `useQrScanner(onDecode: QrDecodeHandler): { videoRef: RefObject<HTMLVideoElement|null>; error: string | null; lastScan: { text: string; ok: boolean } | null }`
  - `type QrDecodeHandler = (text: string) => boolean | void | Promise<boolean | void>`
  - `QrScanView({ onDecode: QrDecodeHandler; hint?: string })`
  - `ScanHistory({ items: ScanItem[] })`, `type ScanItem = { value: string; at: number }`

- [ ] **Step 1: Create `useQrScanner.ts`**

```ts
"use client";

// Shared QR decode lifecycle built on `qr-scanner` (nimiq). Owns a <video> ref,
// starts the camera on mount, decodes a centred ROI, dedupes repeats within a 2s
// window, and exposes a device-aware camera error so the view can offer a manual
// paste fallback. Auto-starts on mount and fully releases the camera on unmount,
// so callers control the camera by mounting/unmounting the consuming view.

import { useEffect, useRef, useState } from "react";
import type QrScanner from "qr-scanner";

const COOLDOWN_MS = 2000;
// Centred square scan region as a fraction of the smaller video dimension. The
// same ratio drives the on-screen overlay box in QrScanView, so the framed area
// is exactly the decoded area.
export const ROI_RATIO = 0.62;

export type QrDecodeHandler = (text: string) => boolean | void | Promise<boolean | void>;

function cameraErrorMessage(e: unknown): string {
  const name = (e as { name?: string })?.name || "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError")
    return "Camera permission denied — allow camera access and retry.";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError")
    return "No camera found on this device.";
  if (name === "SecurityError")
    return "Camera needs a secure context (HTTPS or localhost).";
  return e instanceof Error ? e.message : "Could not access the camera.";
}

export function useQrScanner(onDecode: QrDecodeHandler) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lastRef = useRef<{ value: string; at: number }>({ value: "", at: 0 });
  // Keep the latest handler without re-running the effect (which would restart the camera).
  const onDecodeRef = useRef(onDecode);
  onDecodeRef.current = onDecode;

  const [error, setError] = useState<string | null>(null);
  const [lastScan, setLastScan] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let scanner: QrScanner | null = null;

    (async () => {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        setError("Camera unavailable. Open this page over HTTPS (or localhost) on a device with a camera.");
        return;
      }
      const { default: QrScannerCtor } = await import("qr-scanner");
      if (cancelled) return;
      const video = videoRef.current;
      if (!video) return;

      const handle = async (raw: string) => {
        const value = raw.trim();
        if (!value) return;
        const now = Date.now();
        if (value === lastRef.current.value && now - lastRef.current.at < COOLDOWN_MS) return;
        lastRef.current = { value, at: now };
        let ok = true;
        try { ok = (await onDecodeRef.current(value)) !== false; } catch { ok = false; }
        if (!cancelled) setLastScan({ text: value, ok });
      };

      scanner = new QrScannerCtor(
        video,
        (result) => { void handle(result.data); },
        {
          onDecodeError: () => { /* no QR in frame — normal, ignore */ },
          preferredCamera: "environment",
          maxScansPerSecond: 8,
          returnDetailedScanResult: true,
          calculateScanRegion: (v) => {
            const side = Math.round(Math.min(v.videoWidth, v.videoHeight) * ROI_RATIO);
            const down = Math.min(side, 512);
            return {
              x: Math.round((v.videoWidth - side) / 2),
              y: Math.round((v.videoHeight - side) / 2),
              width: side,
              height: side,
              downScaledWidth: down,
              downScaledHeight: down,
            };
          },
        },
      );

      try {
        await scanner.start();
        if (cancelled) { scanner.stop(); scanner.destroy(); scanner = null; }
      } catch (e) {
        if (!cancelled) setError(cameraErrorMessage(e));
      }
    })();

    return () => {
      cancelled = true;
      scanner?.stop();
      scanner?.destroy();
    };
  }, []);

  return { videoRef, error, lastScan };
}
```

- [ ] **Step 2: Create `QrScanView.tsx`**

Use the import specifier resolved in Task 1 for `./useQrScanner` (same folder → relative `./useQrScanner` is always correct here).

```tsx
"use client";

// Shared camera scan surface: live video + centred ROI overlay (dimmed surround,
// corner brackets, sweeping scan-line) + a latest-scan result bar. When the camera
// is unavailable it renders a paste-the-QR fallback so an operator can still enter a
// code. Emits every accepted decode via onDecode. No modal chrome, no history — those
// are the caller's concern.

import { useState } from "react";
import { useQrScanner, ROI_RATIO, type QrDecodeHandler } from "./useQrScanner";

export function QrScanView({
  onDecode,
  hint = "Align the QR inside the box.",
}: {
  onDecode: QrDecodeHandler;
  hint?: string;
}) {
  const { videoRef, error, lastScan } = useQrScanner(onDecode);
  const [manual, setManual] = useState("");

  if (error) {
    return (
      <div className="space-y-2">
        <p className="text-[12px] text-rose-600">{error} — paste the QR text instead:</p>
        <textarea
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          rows={3}
          placeholder="Paste QR contents…"
          className="w-full px-2.5 py-1.5 text-[12px] border border-[var(--aws-border)] rounded-md font-mono"
        />
        <button
          type="button"
          onClick={() => { const v = manual.trim(); if (v) { void onDecode(v); setManual(""); } }}
          className="w-full px-3 py-1.5 text-[13px] rounded-md bg-[var(--aws-navy)] text-white hover:opacity-90"
        >
          Add scanned code
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="relative mx-auto w-full max-w-[460px] aspect-square overflow-hidden rounded-lg bg-black">
        <video ref={videoRef} muted playsInline className="absolute inset-0 h-full w-full object-cover" />
        <div className="pointer-events-none absolute inset-0">
          <div
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-md"
            style={{ width: `${ROI_RATIO * 100}%`, height: `${ROI_RATIO * 100}%`, boxShadow: "0 0 0 9999px rgba(0,0,0,0.5)" }}
          >
            <div className="absolute inset-0 rounded-md border border-emerald-400/50" />
            <span className="absolute -left-px -top-px h-6 w-6 rounded-tl-md border-l-4 border-t-4 border-emerald-400" />
            <span className="absolute -right-px -top-px h-6 w-6 rounded-tr-md border-r-4 border-t-4 border-emerald-400" />
            <span className="absolute -bottom-px -left-px h-6 w-6 rounded-bl-md border-b-4 border-l-4 border-emerald-400" />
            <span className="absolute -bottom-px -right-px h-6 w-6 rounded-br-md border-b-4 border-r-4 border-emerald-400" />
            <div
              className="absolute left-[8%] right-[8%] h-[2px] bg-emerald-400 shadow-[0_0_8px_2px_rgba(52,211,153,0.7)]"
              style={{ animation: "qrroi-scan 2.2s ease-in-out infinite" }}
            />
          </div>
        </div>
        {lastScan && (
          <div className={`absolute inset-x-0 bottom-0 px-3 py-1.5 ${lastScan.ok ? "bg-emerald-500/95" : "bg-rose-500/95"}`}>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-white/90">
              {lastScan.ok ? "✓ Scanned" : "✕ Not a usable code"}
            </p>
            <p className="truncate font-mono text-[12px] text-white" title={lastScan.text}>{lastScan.text}</p>
          </div>
        )}
      </div>
      <p className="mt-2 text-[12px] text-[var(--text-secondary)] text-center">{hint}</p>
    </>
  );
}
```

- [ ] **Step 3: Create `ScanHistory.tsx`**

```tsx
"use client";

// "Data below" panel for the job-card scanner: the latest decoded value shown
// prominently, plus a newest-first list of earlier scans this session (value +
// local time). Pure display — dedupe/ordering is the caller's job.

export type ScanItem = { value: string; at: number };

export function ScanHistory({ items }: { items: ScanItem[] }) {
  if (items.length === 0) {
    return (
      <div className="bg-white border border-dashed border-[var(--aws-border-strong)] rounded-md p-4 text-center text-[12px] text-[var(--text-muted)]">
        Scanned QR data will appear here.
      </div>
    );
  }
  const [latest, ...rest] = items;
  const fmt = (at: number) => new Date(at).toLocaleTimeString();
  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md p-3 sm:p-4 space-y-3">
      <div>
        <span className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted)]">Latest scan</span>
        <div className="mt-1 font-mono text-[14px] text-[var(--text-primary)] break-all">{latest.value}</div>
        <div className="text-[11px] text-[var(--text-muted)]">{fmt(latest.at)}</div>
      </div>
      {rest.length > 0 && (
        <div className="border-t border-[var(--aws-border)] pt-2">
          <span className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted)]">
            History ({rest.length})
          </span>
          <ul className="mt-1 divide-y divide-[var(--aws-border)]">
            {rest.map((it, i) => (
              <li key={`${it.at}-${i}`} className="flex items-center justify-between gap-3 py-1.5">
                <span className="font-mono text-[12px] text-[var(--text-primary)] break-all">{it.value}</span>
                <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{fmt(it.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Verify the CSS vars exist**

Run: `grep -n "aws-border-strong\|text-secondary\|surface-subtle\|aws-navy" src/app/globals.css`
Expected: `--aws-border`, `--aws-border-strong`, `--aws-navy`, `--text-primary`, `--text-secondary`, `--text-muted` are defined. If `--text-secondary` is absent, use `--text-muted` in `QrScanView`'s hint line. (All of these are already used by the current `_QRScanner.tsx` / `_RawMaterialTab.tsx`, so they should exist.)

- [ ] **Step 5: Typecheck + lint the new files**

Run: `npm run build`  → Expected: PASS (new files are valid; not yet imported).
Run: `npm run lint`   → Expected: clean.

- [ ] **Step 6: Checkpoint** — 3 shared files compile & lint. Proceed.

---

### Task 4: Rewire the transfer modal to `QrScanView`

**Files:**
- Modify (full rewrite): `linux_replica/web_replica/src/app/modules/transfer/_QRScanner.tsx`

**Interfaces:**
- Consumes: `QrScanView` from Task 3.
- Produces: `QRScanner({ onScan, onClose, title?, hint? })` — **unchanged signature** (the 3 transfer pages depend on it).

- [ ] **Step 1: Replace the file contents**

Use the import specifier from Task 1 for `QrScanView` (from `transfer/` that is `../../../components/qr/QrScanView` with no alias, or `@/components/qr/QrScanView` with the alias).

```tsx
"use client";

// Modal wrapper around the shared QrScanView. Renders the overlay chrome (title,
// close, backdrop-click-to-close) and forwards decodes to onScan. Decoding is fully
// client-side (qr-scanner). Closing unmounts QrScanView, which releases the camera.

import { QrScanView } from "@/components/qr/QrScanView"; // ← use the specifier resolved in Task 1

export function QRScanner({
  onScan,
  onClose,
  title = "Scan box QR",
  hint = "Align the box QR inside the green box.",
}: {
  onScan: (text: string) => boolean | void | Promise<boolean | void>;
  onClose: () => void;
  title?: string;
  hint?: string;
}) {
  return (
    <div className="fixed inset-0 z-[100] bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg w-full max-w-sm overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--aws-border)]">
          <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">{title}</h3>
          <button onClick={onClose} className="text-[13px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">✕</button>
        </div>
        <div className="p-4">
          <QrScanView onDecode={onScan} hint={hint} />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Confirm no other exports were used**

Run: `grep -rn "_QRScanner\|from \"../_QRScanner\"\|from \"../../transfer/_QRScanner\"" src` — every import should be the named `QRScanner`. (Verified: 3 transfer pages import `{ QRScanner }`.) No page edits needed.

- [ ] **Step 3: Typecheck + lint**

Run: `npm run build`  → Expected: PASS. (`@zxing` is now unused in this file but still imported by `_RawMaterialTab.tsx`, and the dep is still installed, so the build stays green.)
Run: `npm run lint`   → Expected: clean.

- [ ] **Step 4: Manual smoke (transfer)**

Run: `npm run dev`, open a transfer page (e.g. `/modules/transfer/transferIn`), open the scanner. Expected: modal opens with camera + green ROI box; scanning a QR (or the paste fallback) fires the existing add-box flow exactly as before; `transferIn` still shows its custom title "Scan box to receive".

- [ ] **Step 5: Checkpoint** — transfer modal on `qr-scanner`, signature preserved. Proceed.

---

### Task 5: Rewire the job-card scanner + show data below

**Files:**
- Modify (full rewrite): `linux_replica/web_replica/src/app/modules/job-card/[id]/_RawMaterialTab.tsx`

**Interfaces:**
- Consumes: `QrScanView` (Task 3), `ScanHistory` + `ScanItem` (Task 3).
- Produces: `RawMaterialTab({ jcId })` — **unchanged signature** (`job-card/[id]/page.tsx` depends on it).

- [ ] **Step 1: Replace the file contents**

Use the import specifier from Task 1 (from `job-card/[id]/` that is `../../../../components/qr/...` with no alias, or `@/components/qr/...` with the alias).

```tsx
"use client";

// Raw Material tab — a camera QR scanner over the shared qr-scanner core, with the
// decoded value + a session scan history shown directly below. Decoding is fully
// client-side; nothing is sent to the backend. The camera is gated behind Start/Stop:
// QrScanView auto-starts on mount, so toggling `active` mounts/unmounts it and thus
// acquires/releases the camera.

import { useCallback, useState } from "react";
import { QrScanView } from "@/components/qr/QrScanView";      // ← specifier from Task 1
import { ScanHistory, type ScanItem } from "@/components/qr/ScanHistory";

export function RawMaterialTab({ jcId }: { jcId: number }) {
  // jcId is accepted for parity with the other tabs and future raw-material content.
  void jcId;
  const [active, setActive] = useState(false);
  const [history, setHistory] = useState<ScanItem[]>([]);

  const append = useCallback((value: string) => {
    setHistory((prev) => [{ value, at: Date.now() }, ...prev]);
  }, []);

  return (
    <div className="space-y-4">
      <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">Scan Raw Material QR</h3>
          {active ? (
            <button
              type="button"
              onClick={() => setActive(false)}
              className="h-8 px-3 rounded-[2px] text-[12px] font-semibold border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] text-[var(--text-primary)]"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setActive(true)}
              className="h-8 px-3 rounded-[2px] text-[12px] font-semibold border border-[var(--aws-orange-active)] bg-[var(--aws-orange)] hover:bg-[var(--aws-orange-hover)] text-white"
            >
              Start camera
            </button>
          )}
        </div>

        {active ? (
          <QrScanView onDecode={append} hint="Centre a QR code inside the box." />
        ) : (
          <div className="relative mx-auto w-full max-w-[460px] aspect-square overflow-hidden rounded-lg bg-black">
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
              <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="#d5dbdb" strokeWidth={1.6}>
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <line x1="14" y1="14" x2="21" y2="14" />
                <line x1="14" y1="17.5" x2="21" y2="17.5" />
                <line x1="14" y1="21" x2="21" y2="21" />
              </svg>
              <p className="text-[12px] text-[#d5dbdb] max-w-[260px]">Start the camera and centre a QR code inside the box.</p>
            </div>
          </div>
        )}
      </div>

      {/* "Show the data below": decoded value + session scan history. */}
      <ScanHistory items={history} />
    </div>
  );
}
```

- [ ] **Step 2: Confirm `@zxing` is now gone from source**

Run: `grep -rn "@zxing" src`
Expected: **no matches** (both `_QRScanner.tsx` and `_RawMaterialTab.tsx` no longer import it).

- [ ] **Step 3: Typecheck + lint**

Run: `npm run build`  → Expected: PASS.
Run: `npm run lint`   → Expected: clean.

- [ ] **Step 4: Manual smoke (job-card — the target page)**

Run: `npm run dev`, open `/modules/job-card/<id>` → Raw Material tab.
Expected: "Start camera" shows the black idle viewport; clicking it opens the camera with the green ROI box; scanning QR codes appends them — the latest value shows prominently and earlier scans list below with timestamps; "Stop" releases the camera. Deny camera permission → the paste fallback appears and still adds a value to the history.

- [ ] **Step 5: Checkpoint** — job-card scanner on `qr-scanner` with data-below; no `@zxing` in source. Proceed.

---

### Task 6: Drop `@zxing`, final verification

**Files:**
- Modify: `linux_replica/web_replica/package.json` (remove `@zxing/*`)
- Modify (only if Task 1 flagged it): CSP config to add `worker-src blob:`

- [ ] **Step 1: Remove the dependencies**

Delete the `@zxing/browser` and `@zxing/library` lines from `package.json` `dependencies`. Result:

```json
  "dependencies": {
    "next": "16.2.6",
    "qr-scanner": "^1.4.2",
    "qrcode.react": "^4.2.0",
    "react": "19.2.4",
    "react-dom": "19.2.4"
  },
```

- [ ] **Step 2: Reinstall**

Run: `npm install`
Expected: completes; `npm ls @zxing/browser` → "(empty)" / not found.

- [ ] **Step 3: Apply CSP fix if Task 1 flagged one**

Only if Task 1 Step 3 found a CSP without `worker-src blob:`: add `worker-src 'self' blob:` (and `blob:` to `script-src` if the worker is blocked) to that CSP directive. Otherwise skip.

- [ ] **Step 4: Full verification**

Run: `grep -rn "@zxing" src package.json` → **no matches**.
Run: `npm run build` → PASS.
Run: `npm run lint`  → clean.
Run: `npm run dev` and re-confirm BOTH flows in one session: a transfer page modal scans/adds a box; the job-card Raw Material tab scans and shows the value + history below. Watch the devtools console for a blocked-worker CSP error (should be none).

- [ ] **Step 5: Checkpoint** — `@zxing` fully removed, both scanners on `qr-scanner`, all green. Done.

---

## Self-Review

**Spec coverage:**
- One shared `qr-scanner` engine → Task 3 (`useQrScanner`), consumed in Tasks 4–5. ✅
- Job-card raw value + scan history below → Task 5 (`append` + `ScanHistory`). ✅
- Remove `@zxing/browser` + `@zxing/library` → Task 6. ✅
- Preserve consumer interfaces (no edits to 3 transfer pages + `job-card/[id]/page.tsx`) → Tasks 4 (Step 2) & 5 keep `QRScanner` / `RawMaterialTab` signatures. ✅
- Client-side only, no backend → no `fetch` anywhere in the new code. ✅
- Keep `qrcode.react` → untouched in Tasks 2 & 6. ✅
- Single ROI ratio drives region + overlay → `ROI_RATIO` exported from `useQrScanner`, reused by `QrScanView`. ✅
- Non-standard Next.js docs read first → Task 1. ✅
- No unit tests / no git → verification via lint/build/grep/manual; no commit steps. ✅

**Placeholder scan:** No TBD/TODO; every code step shows full content; the only deferred item is the conditional CSP edit, which is explicitly gated on a Task 1 finding. ✅

**Type consistency:** `QrDecodeHandler` is defined once in `useQrScanner.ts` and imported by `QrScanView`; the transfer `onScan` and job-card `append` both conform. `ScanItem` defined in `ScanHistory.tsx`, imported by `_RawMaterialTab.tsx`. `ROI_RATIO` defined once, imported by `QrScanView`. `useQrScanner` returns `{ videoRef, error, lastScan }` — exactly what `QrScanView` destructures. ✅
