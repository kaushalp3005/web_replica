"use client";

// Raw Material tab — sits beside "Stage Chain" on the job card detail page.
// Top of the tab is a camera QR scanner with a region-of-interest (ROI) box.
// Scanning a sticker identifies the box: it POSTs the raw QR to
// /api/v1/production/scan-identify, which routes by structure — JSON
// {"tx","bi"} → warehouse/cold tables by (box_id, transaction_no); a bare id →
// sfg_box by carton_id; either miss → exhaustive scan of every box table — and
// returns which table the box lives in plus its details, shown in the card below.
//
// ROI design (why this is responsive on every device):
//   • The viewport is a SQUARE container and the video uses object-cover, so a
//     landscape/portrait camera is scaled-to-fill and centred.
//   • Both regions are a PROPORTION of the frame (never a fixed pixel count), so
//     they hold on a 480p phone and a 1080p webcam and survive any orientation:
//       – the on-screen box the operator aims at is ROI_RATIO × the square, and
//       – the crop actually handed to the decoder is a LARGER, centred
//         DECODE_RATIO × min(videoWidth, videoHeight).
//   • The decode crop is deliberately larger than the visible box so a QR the
//     operator lines up to fill the box keeps its mandatory white QUIET ZONE
//     inside the crop. If the crop is flush to (or cuts into) the QR — which is
//     exactly what happens when someone holds the code close to "fill" a
//     box-sized crop — the finder patterns are clipped and the decoder returns
//     NotFound on every frame, so nothing is ever read. (This mirrors the
//     known-good transfer scanner, which decodes 0.9 while its box is 0.7.) The
//     trade-off is that a QR sitting just OUTSIDE the dimmed box (in the
//     0.62–0.9 ring) can still decode — accepted for reliable reads.
//
// Decoding prefers the native BarcodeDetector when the browser exposes it
// (fast + robust; Android/ChromeOS/macOS) and falls back to ZXing —
// BrowserQRCodeReader.decodeFromCanvas with the TRY_HARDER hint — everywhere
// else (Chrome/Firefox on Windows & Linux, Safari). Either way we feed the
// decoder ONLY the centred ROI canvas, never the whole frame.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { BrowserQRCodeReader } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import { apiFetch, readApiErrorMessage } from "@/lib/auth";
import { friendlyApiError } from "@/lib/apiErrors";

// BarcodeDetector is not in the TS DOM lib yet — declare the slice we use.
// boundingBox lets us land the AR tap-target ON the detected QR (when present).
type DetectedCode = { rawValue: string; boundingBox?: { x: number; y: number; width: number; height: number } };
type BarcodeDetectorLike = { detect: (s: CanvasImageSource) => Promise<DetectedCode[]> };
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike;

// Fraction of the smaller frame dimension occupied by the scan box. Kept as a
// ratio (not pixels) so the ROI is identical in proportion on a 480p phone and
// a 1080p webcam, and so it survives any viewport/orientation change.
const ROI_RATIO = 0.62;
// Fraction of the smaller frame dimension actually cropped for DECODING. Kept
// deliberately larger than ROI_RATIO so a QR framed to fill the on-screen box
// retains its white quiet zone (and a little overfill tolerance) inside the
// crop — decoders fail when the symbol reaches the crop edge with no margin.
// Same intent as the transfer scanner's DECODE_FRACTION (0.9) > box (0.7).
const DECODE_RATIO = 0.9;
// Cap the decode bitmap so the decoder stays fast on high-res cameras: the ROI
// crop is scaled into a square of at most this many px before decoding.
const DECODE_MAX_PX = 512;
// Throttle decode passes. Decoding every animation frame (~60/s) is wasteful;
// ~8/s is plenty responsive for a QR while keeping the CPU cool on mobile.
const DECODE_INTERVAL_MS = 120;
// How long the "Scanned: …" toast stays up before auto-dismissing.
const TOAST_MS = 3500;
// How long the "QR breaking" capture burst plays before the scanner re-arms.
// Kept ~1s (fast, Paytm-style) per the ops ask — long enough to read, short
// enough not to slow the next scan.
const BREAK_MS = 1000;
// How long the armed highlight survives after the QR was last decoded. A short
// grace absorbs a dropped frame or two; once the code leaves the view for
// longer than this, the scanner disarms so a stale highlight can't be tapped.
const MISS_GRACE_MS = 450;

// A stored raw-material box scan (jc_box_scan), as returned by the box-scans list.
type BoxScan = {
  box_id: string | null;
  sfg_box_id: string | null;
  transaction_no: string | null;
  article: string | null;
  net_weight: number | null;
  gross_weight: number | null;
  count: number | null;
  scanned_at: string | null;
};
type ScanTotals = { boxes: number; net_weight: number; gross_weight: number; count: number };
type Toast = { kind: "ok" | "err"; text: string } | null;

export function RawMaterialTab({ jcId }: { jcId: number }) {
  const [boxes, setBoxes] = useState<BoxScan[]>([]);
  const [totals, setTotals] = useState<ScanTotals | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [count, setCount] = useState(""); // units for the NEXT scan (blank → the box's own count)
  const [toast, setToast] = useState<Toast>(null);
  const [busy, setBusy] = useState<string | null>(null); // box id mid-delete
  // Guards a double-tap double-submit while a store round-trip is in flight.
  const inFlightRef = useRef(false);
  const toastTimerRef = useRef<number | null>(null);

  const flashToast = useCallback((t: { kind: "ok" | "err"; text: string }) => {
    setToast(t);
    if (toastTimerRef.current != null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/v1/production/job-cards-v2/${jcId}/box-scans`);
      if (res.ok) {
        const data = (await res.json()) as { scans?: BoxScan[]; totals?: ScanTotals };
        setBoxes(data.scans ?? []);
        setTotals(data.totals ?? null);
      }
    } catch {
      /* keep the last good list */
    } finally {
      setLoadingList(false);
    }
  }, [jcId]);

  useEffect(() => {
    // Deferred past the synchronous effect body so react-hooks/set-state-in-effect
    // stays happy (refresh() setStates). Same idiom the detail page's fetch uses.
    queueMicrotask(() => { void refresh(); });
  }, [refresh]);
  useEffect(() => () => { if (toastTimerRef.current != null) window.clearTimeout(toastTimerRef.current); }, []);

  // A scan STORES the box against this JC (upsert). RM labels are a bare box id
  // or JSON {"tx","bi"} — send the bare id; the server matches po_box.box_id and
  // resolves the article + weights from the box itself.
  const handleScan = useCallback((value: string) => {
    const raw = value.trim();
    if (!raw || inFlightRef.current) return;
    let code = raw;
    try {
      const j = JSON.parse(raw);
      if (j && typeof j.bi === "string") code = j.bi.trim();
    } catch {
      /* not JSON — a bare box id */
    }
    const n = Number(count);
    const units = count.trim() !== "" && Number.isFinite(n) ? n : undefined;
    inFlightRef.current = true;
    void (async () => {
      try {
        const res = await apiFetch(`/api/v1/production/job-cards-v2/${jcId}/box-scans`, {
          method: "POST",
          body: JSON.stringify(units != null ? { code, count: units } : { code }),
        });
        if (!res.ok) {
          flashToast({ kind: "err", text: await readApiErrorMessage(res, `Couldn't store ${code}`) });
          return;
        }
        flashToast({ kind: "ok", text: `Stored ${code}` });
        await refresh();
      } catch (e) {
        flashToast({ kind: "err", text: friendlyApiError(e) });
      } finally {
        inFlightRef.current = false;
      }
    })();
  }, [jcId, count, flashToast, refresh]);

  const deleteBox = useCallback(async (code: string) => {
    setBusy(code);
    try {
      const res = await apiFetch(
        `/api/v1/production/job-cards-v2/${jcId}/box-scans/${encodeURIComponent(code)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        flashToast({ kind: "err", text: await readApiErrorMessage(res, "Delete failed") });
        return;
      }
      flashToast({ kind: "ok", text: `Removed ${code}` });
      await refresh();
    } catch (e) {
      flashToast({ kind: "err", text: friendlyApiError(e) });
    } finally {
      setBusy(null);
    }
  }, [jcId, flashToast, refresh]);

  return (
    <div className="space-y-4">
      <QrScanner onResult={handleScan} />

      {/* Units count applied to the NEXT scan — blank uses the box's own count. */}
      <div className="flex items-center gap-2">
        <label htmlFor="rm-count" className="text-[12px] text-[var(--text-muted)]">Count (units in box)</label>
        <input
          id="rm-count"
          type="number"
          min={0}
          inputMode="numeric"
          value={count}
          onChange={(e) => setCount(e.target.value)}
          placeholder="auto"
          className="h-8 w-24 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[var(--aws-navy)] text-[var(--text-primary)]"
        />
      </div>

      {toast ? (
        <div
          role="status"
          aria-live="polite"
          className={`px-3 py-2 text-[13px] rounded-[2px] border flex items-center justify-between gap-3 ${
            toast.kind === "ok"
              ? "bg-[#eaf6ed] border-[#b6dbb1] text-[var(--text-success)]"
              : "bg-[#fdecea] border-[#f5c6c2] text-[var(--text-danger)]"
          }`}
        >
          <span className="break-all">{toast.text}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="Dismiss"
            className="shrink-0 text-[15px] leading-none text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            ✕
          </button>
        </div>
      ) : null}

      {/* Stored raw-material boxes for this job card — ✕ removes one box. */}
      <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--aws-border)] flex items-center justify-between gap-2">
          <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">Scanned raw-material boxes</h3>
          {totals ? (
            <span className="text-[12px] text-[var(--text-muted)]">
              {totals.boxes} box{totals.boxes === 1 ? "" : "es"} · {totals.net_weight.toFixed(3)} kg · {totals.count} units
            </span>
          ) : null}
        </div>

        {loadingList ? (
          <div className="p-4 text-[12px] text-[var(--text-muted)]">Loading…</div>
        ) : boxes.length === 0 ? (
          <div className="p-4 text-center text-[12px] text-[var(--text-muted)]">
            Scan a raw-material QR to add its box.
          </div>
        ) : (
          <ul className="divide-y divide-[var(--aws-border)]">
            {boxes.map((b) => {
              const code = b.box_id ?? b.sfg_box_id ?? "";
              return (
                <li key={code} className="px-4 py-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-mono text-[13px] text-[var(--text-primary)] break-all">{code}</div>
                    <div className="text-[12px] text-[var(--text-muted)] break-all">
                      {b.article ?? "—"}{b.transaction_no ? ` · ${b.transaction_no}` : ""}
                    </div>
                    <div className="text-[12px] text-[var(--text-secondary)] mt-0.5">
                      {b.net_weight != null ? `${Number(b.net_weight).toFixed(3)} kg net` : "— net"}
                      {b.gross_weight != null ? ` · ${Number(b.gross_weight).toFixed(3)} kg gross` : ""}
                      {b.count != null ? ` · ${b.count} units` : ""}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void deleteBox(code)}
                    disabled={busy === code || !code}
                    aria-label={`Remove box ${code}`}
                    title="Remove this box"
                    className="shrink-0 h-7 w-7 flex items-center justify-center rounded-[2px] border border-[var(--aws-border-strong)] text-[var(--text-muted)] hover:border-[var(--text-danger)] hover:text-[var(--text-danger)] disabled:opacity-50"
                  >
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── AR tap-to-capture ───────────────────────────────────────────────────────
// Instead of auto-recording the instant a QR decodes, the scanner ARMS: it
// highlights the live QR and waits for the operator to tap it. The tap records
// the value and plays a fast (~1s) Paytm-style "QR breaking" burst.

type Rect = { left: number; top: number; width: number; height: number }; // % of the square viewport

// The aiming box as a viewport-% rect — the fallback capture target when the
// decoder can't hand back a QR bounding box (the ZXing path).
const ROI_RECT: Rect = {
  left: 50 - ROI_RATIO * 50,
  top: 50 - ROI_RATIO * 50,
  width: ROI_RATIO * 100,
  height: ROI_RATIO * 100,
};

// Map a QR bounding box (decode-canvas px, side = `target`) to a viewport-% rect.
// The decode crop is a CENTRED DECODE_RATIO×min(frame) square shown under
// object-cover, so it occupies exactly DECODE_RATIO of the square viewport,
// centred — a clean linear remap with no per-device pixel math.
function rectFromBox(box: { x: number; y: number; width: number; height: number }, target: number): Rect {
  const pos = (v: number) => (0.5 + (v / target - 0.5) * DECODE_RATIO) * 100;
  const size = (v: number) => (v / target) * DECODE_RATIO * 100;
  const w = Math.max(size(box.width), 22); // floor the size so the tap target stays easy to hit
  const h = Math.max(size(box.height), 22);
  const cx = pos(box.x) + size(box.width) / 2;
  const cy = pos(box.y) + size(box.height) / 2;
  return {
    left: Math.min(Math.max(cx - w / 2, 0), 100 - w),
    top: Math.min(Math.max(cy - h / 2, 0), 100 - h),
    width: w,
    height: h,
  };
}

// Keyframes for the break burst — injected once (React allows a raw <style>).
const QR_ANIM_CSS = `
@keyframes qrShard { to { transform: translate(var(--dx), var(--dy)) rotate(var(--rot)) scale(.25); opacity: 0; } }
@keyframes qrRing  { from { transform: scale(.7); opacity: .9 } to { transform: scale(1.7); opacity: 0 } }
@keyframes qrCheck { 0% { transform: scale(0); opacity: 0 } 55% { transform: scale(1.15); opacity: 1 } 100% { transform: scale(1); opacity: 1 } }
@keyframes qrFlash { from { opacity: .6 } to { opacity: 0 } }
`;

// A fast QR "shatter": a grid of tiles bursts outward + a ring + a check, ~1s.
const BURST_GRID = 5;
function QrBreakBurst({ rect }: { rect: Rect }) {
  const cells: Array<readonly [number, number]> = [];
  for (let r = 0; r < BURST_GRID; r++) for (let c = 0; c < BURST_GRID; c++) cells.push([r, c] as const);
  return (
    <div
      className="pointer-events-none absolute z-20"
      style={{ left: `${rect.left}%`, top: `${rect.top}%`, width: `${rect.width}%`, height: `${rect.height}%` }}
    >
      <div
        className="absolute inset-0 rounded-lg"
        style={{ boxShadow: "0 0 0 3px #1d8102", animation: "qrRing 700ms ease-out forwards" }}
      />
      {cells.map(([r, c]) => {
        const dx = c - (BURST_GRID - 1) / 2;
        const dy = r - (BURST_GRID - 1) / 2;
        const rot = ((r * BURST_GRID + c) % 2 ? 1 : -1) * (120 + ((r * BURST_GRID + c) % 3) * 60);
        const dist = Math.abs(dx) + Math.abs(dy);
        const style: CSSProperties & Record<string, string | number> = {
          left: `${(c * 100) / BURST_GRID}%`,
          top: `${(r * 100) / BURST_GRID}%`,
          width: `${100 / BURST_GRID}%`,
          height: `${100 / BURST_GRID}%`,
          "--dx": `${dx * 150}%`,
          "--dy": `${dy * 150}%`,
          "--rot": `${rot}deg`,
          animation: `qrShard 700ms cubic-bezier(.4,0,.2,1) ${dist * 22}ms forwards`,
        };
        return (
          <div key={`${r}-${c}`} className="absolute" style={style}>
            <div
              className="absolute inset-[7%] rounded-[1px]"
              style={{ background: (r + c) % 2 === 0 ? "#334155" : "#0f172a" }}
            />
          </div>
        );
      })}
      <div className="absolute inset-0 flex items-center justify-center" style={{ animation: "qrCheck 500ms ease-out 120ms both" }}>
        <div className="flex items-center justify-center rounded-full" style={{ width: "38%", height: "38%", background: "#1d8102" }}>
          <svg viewBox="0 0 24 24" width="58%" height="58%" fill="none" stroke="#fff" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 13l4 4L19 7" />
          </svg>
        </div>
      </div>
    </div>
  );
}

type ScanState = "idle" | "starting" | "scanning" | "error";

// Friendly, device-aware camera failure message from a DOMException name.
function cameraErrorMessage(name: string | undefined): string {
  if (name === "NotAllowedError" || name === "PermissionDeniedError")
    return "Camera permission denied. Allow camera access and try again.";
  if (name === "SecurityError")
    return "Camera needs a secure context (open this page over HTTPS or localhost).";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError")
    return "No camera found on this device.";
  return "Could not start the camera. Check permissions and try again.";
}

function QrScanner({ onResult }: { onResult?: (value: string) => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null); // offscreen decode buffer
  const streamRef = useRef<MediaStream | null>(null);
  const readerRef = useRef<BrowserQRCodeReader | null>(null);
  const detectorRef = useRef<BarcodeDetectorLike | null>(null); // native decoder when available
  const rafRef = useRef<number | null>(null);
  const activeRef = useRef(false); // true while the scan loop should keep re-arming
  // Bumped by every start() AND stop(). A start captures its value and bails
  // after each await if it changed, so a Stop (or a newer Start) during the
  // getUserMedia/play windows can neither resurrect a superseded session nor
  // leak a camera track. The scan loop and decodeOnce re-check it too.
  const genRef = useRef(0);
  const lastDecodeRef = useRef<number>(0);
  const lastHitAtRef = useRef<number>(0); // performance.now() of the last successful decode
  // De-dupes setPending: only re-render the armed overlay when the QR's value or
  // (rounded) position actually changes, so a held code doesn't churn state.
  const pendingKeyRef = useRef<string | null>(null);
  // True only while the ~1s break burst is playing: freezes decoding so the
  // frozen shatter isn't disturbed and the scanner can't re-arm mid-animation.
  const capturingRef = useRef(false);
  const captureTimerRef = useRef<number | null>(null);
  // Read onResult through a ref so the long-lived decode loop always calls the
  // latest handler without being rebuilt, and can never capture a stale closure.
  const onResultRef = useRef(onResult);
  useEffect(() => { onResultRef.current = onResult; }, [onResult]);

  const [state, setState] = useState<ScanState>("idle");
  const [error, setError] = useState<string | null>(null);
  // A decoded-but-not-yet-recorded QR (armed, awaiting the operator's tap) and
  // the in-flight capture burst. Recording happens ONLY on tap.
  const [pending, setPending] = useState<{ value: string; rect: Rect } | null>(null);
  const [capture, setCapture] = useState<{ value: string; rect: Rect } | null>(null);
  const [manual, setManual] = useState("");

  const stop = useCallback(() => {
    genRef.current++; // supersede any in-flight start()
    activeRef.current = false;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (captureTimerRef.current != null) {
      window.clearTimeout(captureTimerRef.current);
      captureTimerRef.current = null;
    }
    const s = streamRef.current;
    if (s) {
      s.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    detectorRef.current = null;
    const v = videoRef.current;
    if (v) v.srcObject = null;
    capturingRef.current = false;
    pendingKeyRef.current = null;
    setPending(null);
    setCapture(null);
    setState("idle");
  }, []);

  // One decode pass: draw ONLY the centred decode crop into the offscreen canvas,
  // then decode that crop. QRs outside the crop never reach the decoder. The
  // animation loop (see start) calls this every frame; the time gate below
  // throttles the actual decoding to DECODE_INTERVAL_MS.
  const decodeOnce = useCallback(async () => {
    const v = videoRef.current;
    const canvas = canvasRef.current;
    if (!v || !canvas || v.readyState < 2) return;
    if (capturingRef.current) return; // frozen while the break burst plays

    const now = performance.now();
    if (now - lastDecodeRef.current < DECODE_INTERVAL_MS) return;
    lastDecodeRef.current = now;

    const vw = v.videoWidth;
    const vh = v.videoHeight;
    if (!vw || !vh) return;

    // Crop a centred DECODE_RATIO × min(vw,vh) square — a PROPORTION of the frame
    // (square viewport + object-cover ⇒ the fill axis is min(vw,vh), centred).
    // It is larger than the on-screen ROI_RATIO box so a QR lined up to fill the
    // box keeps its quiet-zone margin inside the crop (see DECODE_RATIO note).
    const side = Math.round(Math.min(vw, vh) * DECODE_RATIO);
    const sx = Math.round((vw - side) / 2);
    const sy = Math.round((vh - side) / 2);
    const target = Math.min(side, DECODE_MAX_PX);

    // The crop size derives from the fixed stream resolution, so this only
    // reallocates the backing store on the first frame; drawImage overwrites the
    // whole canvas each pass, so no manual clear is needed.
    if (canvas.width !== target) { canvas.width = target; canvas.height = target; }
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(v, sx, sy, side, side, 0, 0, target, target);

    // Decode ONLY the ROI canvas: native BarcodeDetector when present, else ZXing.
    // Both throw / return empty when there's no QR in the crop — keep scanning.
    const gen = genRef.current; // detect() below is async — bail if superseded
    let value = "";
    let box: { x: number; y: number; width: number; height: number } | undefined;
    const detector = detectorRef.current;
    if (detector) {
      try {
        const codes = await detector.detect(canvas);
        if (!activeRef.current || genRef.current !== gen) return; // torn down mid-detect
        const hit = codes.length ? codes[0] : null;
        value = hit?.rawValue ? hit.rawValue.trim() : "";
        if (hit?.boundingBox) {
          box = { x: hit.boundingBox.x, y: hit.boundingBox.y, width: hit.boundingBox.width, height: hit.boundingBox.height };
        }
      } catch {
        return; // transient detector error — keep scanning
      }
    } else {
      const reader = readerRef.current;
      if (!reader) return;
      try {
        value = reader.decodeFromCanvas(canvas).getText().trim();
      } catch {
        value = ""; // No QR in the ROI this frame — fall through to miss handling.
      }
    }
    if (value) {
      // ARM, don't record: highlight the QR (on its bounding box when the decoder
      // gives one, else the aiming box) and wait for the operator's tap. De-dupe
      // so a held code doesn't re-render the overlay every pass.
      lastHitAtRef.current = now;
      if (capturingRef.current) return; // a detect() that resolved after a tap — don't re-arm
      const rect = box ? rectFromBox(box, target) : ROI_RECT;
      const key = `${value}@${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)}`;
      if (pendingKeyRef.current !== key) {
        pendingKeyRef.current = key;
        setPending({ value, rect });
      }
    } else if (pendingKeyRef.current !== null && now - lastHitAtRef.current > MISS_GRACE_MS) {
      // The QR left the frame (no decode for a beat) — disarm so the stale
      // highlight can't be tapped and the box tracks the camera in real time.
      pendingKeyRef.current = null;
      setPending(null);
    }
  }, []);

  const start = useCallback(async () => {
    setError(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      // getUserMedia is gated to secure contexts (HTTPS or localhost).
      setState("error");
      setError("Camera unavailable. Open this page over HTTPS (or localhost) on a device with a camera.");
      return;
    }
    const myGen = ++genRef.current; // this session's token; stop()/a newer start() bump it
    setState("starting");

    // Build the decoder BEFORE opening the camera, so a decoder-construction
    // failure can never strand a live camera stream. Prefer native
    // BarcodeDetector (fast + robust); fall back to a hinted ZXing reader that
    // still decodes marginal captures (glare/moire/soft focus off a screen).
    try {
      const Ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
      detectorRef.current = Ctor ? new Ctor({ formats: ["qr_code"] }) : null;
    } catch {
      detectorRef.current = null; // unsupported format / vendor quirk → use ZXing
    }
    if (!detectorRef.current && !readerRef.current) {
      try {
        readerRef.current = new BrowserQRCodeReader(
          new Map<DecodeHintType, unknown>([
            [DecodeHintType.TRY_HARDER, true],
            [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]],
          ]),
        );
      } catch {
        setState("error");
        setError("Could not initialise the QR decoder on this browser.");
        return;
      }
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } }, // prefer the rear camera
        audio: false,
      });
    } catch (e) {
      if (genRef.current !== myGen) return; // superseded during the grant — nothing acquired
      setState("error");
      setError(cameraErrorMessage((e as { name?: string })?.name));
      return;
    }

    // Superseded (Stop / newer Start) or unmounted during the grant window?
    // Release the just-acquired stream BEFORE taking ownership so it can't leak.
    const v = videoRef.current;
    if (genRef.current !== myGen) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    if (!v) {
      stream.getTracks().forEach((t) => t.stop());
      setState("idle");
      return;
    }

    streamRef.current = stream;
    v.srcObject = stream;
    try {
      await v.play();
    } catch {
      if (genRef.current !== myGen) {
        // Superseded mid-play (teardown aborted the element) — release and bail.
        stream.getTracks().forEach((t) => t.stop());
        if (streamRef.current === stream) streamRef.current = null;
        return;
      }
      // A genuine play() failure — surface it and release the camera instead of
      // sitting on a black "scanning" preview that never decodes.
      stream.getTracks().forEach((t) => t.stop());
      if (streamRef.current === stream) streamRef.current = null;
      v.srcObject = null;
      setState("error");
      setError("Could not start the camera preview. Check permissions and try again.");
      return;
    }
    if (genRef.current !== myGen) { // superseded while play() was resolving
      stream.getTracks().forEach((t) => t.stop());
      if (streamRef.current === stream) streamRef.current = null;
      v.srcObject = null;
      return;
    }

    setState("scanning");
    lastDecodeRef.current = 0;
    pendingKeyRef.current = null; // don't let the previous session's dedupe suppress a re-arm
    capturingRef.current = false;
    setPending(null);
    setCapture(null);
    activeRef.current = true;

    // Await each pass before re-arming so async BarcodeDetector decodes don't
    // stack; stop re-arming once torn down (activeRef) or superseded (genRef).
    const runLoop = async () => {
      await decodeOnce();
      if (activeRef.current && genRef.current === myGen) {
        rafRef.current = requestAnimationFrame(() => void runLoop());
      }
    };
    rafRef.current = requestAnimationFrame(() => void runLoop());
  }, [decodeOnce]);

  // Stop the stream + RAF loop on unmount (e.g. switching away from this tab).
  useEffect(() => stop, [stop]);

  // Record on tap + play the break burst. Fires onResult immediately so the box
  // lookup runs while the ~1s animation plays; re-arms when it ends.
  const doCapture = useCallback((value: string, rect: Rect) => {
    if (capturingRef.current) return;
    capturingRef.current = true;
    setCapture({ value, rect });
    setPending(null);
    onResultRef.current?.(value);
    if (captureTimerRef.current != null) window.clearTimeout(captureTimerRef.current);
    captureTimerRef.current = window.setTimeout(() => {
      capturingRef.current = false;
      pendingKeyRef.current = null; // let the next (or same) QR re-arm
      setCapture(null);
      setPending(null); // re-arm only on a fresh detect, never a stale one
    }, BREAK_MS);
  }, []);

  const live = state === "scanning" || state === "starting";
  const armed = pending != null;

  const submitManual = () => {
    const m = manual.trim();
    if (!m) return;
    onResultRef.current?.(m);
    setManual("");
  };

  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">Scan Raw Material QR</h3>
        {live ? (
          <button
            type="button"
            onClick={stop}
            className="h-8 px-3 rounded-[2px] text-[12px] font-semibold border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] text-[var(--text-primary)]"
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void start()}
            className="h-8 px-3 rounded-[2px] text-[12px] font-semibold border border-[var(--aws-orange-active)] bg-[var(--aws-orange)] hover:bg-[var(--aws-orange-hover)] text-white"
          >
            {state === "error" ? "Retry camera" : "Start camera"}
          </button>
        )}
      </div>

      {/* Square viewport — full width, centred, capped so it doesn't dominate a
          desktop. w-full keeps it fluid on phones; the square aspect makes the
          ROI math orientation-proof. */}
      <div className="relative mx-auto w-full max-w-[460px] aspect-square overflow-hidden rounded-lg bg-black">
        <video
          ref={videoRef}
          muted
          playsInline
          className="absolute inset-0 h-full w-full object-cover"
        />

        {/* ROI box + dimmed surround. Rendered only while live so the idle
            state stays clean. The box is 62% of the SQUARE viewport on both
            axes — a pure proportion, so it scales with any screen. The large
            spread box-shadow dims everything outside the ROI. */}
        {live ? (
          <div className="pointer-events-none absolute inset-0">
            <div
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-lg"
              style={{
                width: `${ROI_RATIO * 100}%`,
                height: `${ROI_RATIO * 100}%`,
                boxShadow: "0 0 0 9999px rgba(0,0,0,0.45)",
                outline: `2px solid ${armed ? "#1d8102" : "var(--aws-orange)"}`,
                transition: "outline-color 120ms ease",
              }}
            >
              {/* Corner ticks for a clear "align here" affordance. */}
              {(["left-0 top-0 border-l-2 border-t-2", "right-0 top-0 border-r-2 border-t-2",
                 "left-0 bottom-0 border-l-2 border-b-2", "right-0 bottom-0 border-r-2 border-b-2"] as const)
                .map((pos) => (
                  <span
                    key={pos}
                    className={`absolute h-5 w-5 ${pos}`}
                    style={{ borderColor: armed ? "#1d8102" : "#ffffff" }}
                  />
                ))}
            </div>
          </div>
        ) : null}

        {/* Armed: highlight the live QR and capture ON TAP. Nothing records until
            the operator taps — a full-viewport target keeps it easy to hit. */}
        {live && pending && !capture ? (
          <>
            {/* Invisible tap target over the QR — no on-screen box. It tracks the
                code live (position updates each frame) and disarms when it leaves;
                clicks off the code do nothing. */}
            <button
              type="button"
              onClick={() => doCapture(pending.value, pending.rect)}
              aria-label="Tap the QR to record it"
              className="absolute z-10 cursor-pointer border-0 bg-transparent p-0"
              style={{
                left: `${pending.rect.left}%`,
                top: `${pending.rect.top}%`,
                width: `${pending.rect.width}%`,
                height: `${pending.rect.height}%`,
              }}
            />
            <span className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-[#1d8102] px-3 py-1 text-[12px] font-semibold text-white shadow">
              Tap the QR to record
            </span>
          </>
        ) : null}

        {/* Capture burst — the fast QR "break" that plays once recorded. */}
        {live && capture ? (
          <>
            <QrBreakBurst rect={capture.rect} />
            <div className="pointer-events-none absolute inset-0 z-10 bg-white" style={{ animation: "qrFlash 500ms ease-out forwards" }} />
          </>
        ) : null}

        {/* Idle / error overlay covering the black viewport. */}
        {!live ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
            <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="#d5dbdb" strokeWidth={1.6}>
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <line x1="14" y1="14" x2="21" y2="14" />
              <line x1="14" y1="17.5" x2="21" y2="17.5" />
              <line x1="14" y1="21" x2="21" y2="21" />
            </svg>
            <p className="text-[12px] text-[#d5dbdb] max-w-[260px]">
              {error ?? "Start the camera and centre a QR code inside the box."}
            </p>
          </div>
        ) : null}
      </div>

      {/* Offscreen decode buffer. */}
      <canvas ref={canvasRef} className="hidden" />

      {/* Break-burst keyframes (mounted once). */}
      <style>{QR_ANIM_CSS}</style>

      {/* Manual fallback when the camera can't be used (permission denied, no
          camera, or an insecure context) so the operator can still enter a code. */}
      {state === "error" ? (
        <div className="mt-3">
          <label className="block text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted)] mb-1">
            Or enter the QR contents manually
          </label>
          <div className="flex gap-2">
            <input
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitManual(); }}
              placeholder="Paste or type the code"
              className="h-8 flex-1 min-w-0 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[var(--aws-navy)] text-[var(--text-primary)]"
            />
            <button
              type="button"
              onClick={submitManual}
              className="h-8 px-3 rounded-[2px] text-[12px] font-semibold border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] text-[var(--text-primary)]"
            >
              Use code
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
