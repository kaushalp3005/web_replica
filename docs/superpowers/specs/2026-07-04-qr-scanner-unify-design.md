# QR Scanner Unification — `qr-scanner` (nimiq), drop `@zxing`

**Date:** 2026-07-04
**App:** `linux_replica/web_replica` (Next.js 16.2.6 — non-standard; see app `AGENTS.md`)
**Status:** Approved design, pre-implementation

## Summary

Replace the two independent `@zxing`-based QR scanners in this app with a single
shared decode core built on **`qr-scanner`** (nimiq, v1.4.2). The job-card page's
inline scanner additionally renders the **decoded value + a session scan history**
directly below the camera (filling today's empty "Raw-material details will appear
here" placeholder). All QR decoding stays **100% client-side** — no image or scan
data is sent to the backend.

## Goals

- One QR decode engine (`qr-scanner`) shared by both scanners.
- Job-card inline scanner shows **raw decoded value + scan history** below the camera.
- Remove `@zxing/browser` and `@zxing/library` from the app entirely (lightest
  QR-only footprint; `qr-scanner`'s worker is an inlined Blob URL).
- Preserve existing consumer interfaces so the 3 transfer pages and `job-card/[id]/page.tsx`
  need **zero edits**.

## Non-goals / out of scope

- No backend changes. The backend never decodes QR (it only *generates* labels via
  Python `qrcode`, and receives already-decoded `box_id`s). Nothing here touches it.
- No change to the transfer business logic (`onScan` handlers, box lookups) — only
  the decode engine behind the modal swaps.
- `qrcode.react` stays (it renders/generates QR labels; unrelated to scanning).
- No new component test harness (this app has only `dev`/`build`/`start`/`lint`).

## Current state (what exists today)

Two separate `@zxing` scanners:

1. **Shared transfer modal** — `src/app/modules/transfer/_QRScanner.tsx`, exports
   `QRScanner({ onScan, onClose, title?, hint? })`. A full-screen modal. Decodes with
   native `BarcodeDetector` when present, else ZXing. Consumed by:
   - `transfer/directtransferform/page.tsx` (import L13, use L548) — default title/hint
   - `transfer/transferform/page.tsx` (import L19, use L548) — default title/hint
   - `transfer/transferIn/page.tsx` (import L30, use L658) — custom `title`/`hint`
2. **Job-card inline scanner** — local `QrScanner` in
   `src/app/modules/job-card/[id]/_RawMaterialTab.tsx` (L54), rendered by
   `RawMaterialTab({ jcId })` (L36, scanner at L44), which is mounted as the
   `"rawmaterial"` tab from `job-card/[id]/page.tsx` (import L39, use L2294). Decodes
   with ZXing `BrowserQRCodeReader.decodeFromCanvas` over a centred ROI crop. The area
   below the camera is a placeholder: "Raw-material details will appear here."

`@zxing` import sites (all removed by this work): `_QRScanner.tsx` L21–L22,
`_RawMaterialTab.tsx` L23.

## Architecture

### New shared core — `src/components/qr/`

- **`useQrScanner.ts`** — hook that owns the `qr-scanner` lifecycle against a caller-provided
  `videoRef`:
  - Dynamic `import("qr-scanner")` (client-only) so nothing SSR-evaluates browser globals.
  - `new QrScanner(video, onResult, { preferredCamera: "environment", maxScansPerSecond,
    calculateScanRegion, returnDetailedScanResult: true })`, then `start()`; `stop()` +
    `destroy()` on unmount so the camera fully releases.
  - **2s per-value cooldown** (ports today's `COOLDOWN_MS`) — `qr-scanner` throttles by
    rate, not by repeated value, so we dedupe identical consecutive decodes ourselves.
  - Exposes camera-error state (device-aware messages, ported from today's
    `cameraErrorMessage`) so the view can fall back to manual paste.
  - Returns `{ error }` and invokes an `onDecode(text) => boolean | void | Promise<...>`
    callback supplied by the view/wrapper.
- **`QrScanView.tsx`** — presentational scan surface (no modal chrome, no history):
  - Renders `<video>` (owned by the hook) + the existing green ROI overlay (corner
    brackets, animated scan-line, dimmed surround) + a latest-scan result bar that
    reflects `onDecode`'s boolean result (green ok / red not-usable).
  - Renders the **manual-paste fallback** (textarea + "Add scanned code") when the
    camera is unavailable — preserved from today's `_QRScanner`.
  - Props: `onDecode(text) => boolean | void | Promise<boolean | void>`, `title?`, `hint?`.
- **`ScanHistory.tsx`** — the "data below" panel:
  - Props: `items: { value: string; at: number }[]`.
  - Renders the latest value prominently + a newest-first list (value + local time).
  - Deduping/ordering is done by the owner; this component is pure display.

### Rewired consumers (internals only)

- **`transfer/_QRScanner.tsx`** — becomes modal chrome (fixed overlay, title bar, close,
  backdrop-click close) wrapping `<QrScanView onDecode={onScan} title={title} hint={hint} />`.
  The exported signature `QRScanner({ onScan, onClose, title?, hint? })` is **unchanged**,
  so all 3 transfer pages keep working with no edits. Keeps only the latest-scan bar (the
  transfer forms already list added boxes, so no history panel here).
- **`_RawMaterialTab.tsx`** — the inline `QrScanner` becomes
  `<QrScanView onDecode={append} />`; `append` applies the 2s dedupe and pushes
  `{ value, at }` into local `history` state. The placeholder `<div>` is replaced by
  `<ScanHistory items={history} />`. `RawMaterialTab({ jcId })` signature unchanged.

### Dependency changes — `package.json`

- Remove `@zxing/browser` (^0.2.0) and `@zxing/library` (^0.22.0).
- Add `qr-scanner` (^1.4.2).
- Keep `qrcode.react`.
- Reinstall so the lockfile updates.

## Data flow

Camera frame → `qr-scanner` inlined-Blob worker decodes QR → `onResult(text)` (hook) →
2s per-value dedupe → `onDecode(text)`:
- **Job-card:** append `{ value, at: Date.now() }` to `history` state → `ScanHistory`
  re-renders below. No network.
- **Transfer:** call the page's existing `onScan(text)` (unchanged business logic).

No QR payload is ever POSTed for decoding; decode is entirely in-browser.

## Error handling

- Camera denied / none / insecure context → `qr-scanner` `start()` rejects → hook sets a
  device-aware error message → `QrScanView` shows the manual-paste fallback (operator can
  still enter a code).
- No-QR-in-frame → `qr-scanner` `onDecodeError` fires continuously; ignored (normal).
- Worker/Blob failure (e.g. strict CSP without `worker-src blob:`) → surfaced as a camera
  error with the manual fallback. CSP is verified before implementation (see below).

## Non-standard Next.js 16 considerations

Per this app's `AGENTS.md`, the relevant `node_modules/next/dist/docs/` guides are read
**before writing code**. Specifically:
- Client-component + dynamic `import()` of a browser-only lib (no SSR evaluation).
- Confirm the inlined-Blob worker needs no bundler worker config under this Next/Turbopack
  version, and that no app-level CSP blocks `worker-src blob:` / `script-src blob:`.

## Verification (no unit-test harness in this app)

1. `npm install` succeeds; lockfile shows `qr-scanner`, no `@zxing/*`.
2. `npm run build` (typecheck passes) and `npm run lint` clean.
3. `grep -r "@zxing" src` → **no matches**.
4. Run the dev server:
   - Job-card page → Raw Material tab: camera opens, scanning a QR shows the decoded value
     and a growing history below; manual-paste fallback works when camera is denied.
   - A transfer page (e.g. transferIn): the modal still opens, scans, and adds boxes exactly
     as before (custom title/hint preserved on transferIn).

## Net blast radius

- **Rewrite (2):** `_QRScanner.tsx`, `_RawMaterialTab.tsx`
- **New (3):** `components/qr/useQrScanner.ts`, `QrScanView.tsx`, `ScanHistory.tsx`
- **Edit (1):** `package.json`
- **Untouched (4):** the 3 transfer pages + `job-card/[id]/page.tsx` (unchanged interfaces)
