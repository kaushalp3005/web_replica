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

import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserQRCodeReader } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import { apiFetch, readApiErrorMessage } from "@/lib/auth";
import { friendlyApiError } from "@/lib/apiErrors";

// BarcodeDetector is not in the TS DOM lib yet — declare the slice we use.
type BarcodeDetectorLike = { detect: (s: CanvasImageSource) => Promise<{ rawValue: string }[]> };
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

// Shape returned by POST /api/v1/production/scan-identify.
type IdentifyBox = {
  box_id: string | null;
  transaction_no: string | null;
  item_description: string | null;
  lot_number: string | null;
  net_weight: number | null;
  gross_weight: number | null;
  count: number | string | null;
  status: string | null;
  job_card_number: string | null;
};
type IdentifyResult =
  | { found: true; table: string; company: string | null; matched_by: string; box: IdentifyBox }
  | { found: false; box_id: string | null; transaction_no?: string | null };

type Lookup =
  | { status: "loading" }
  | { status: "ok"; data: IdentifyResult }
  | { status: "err"; error: string };

export function RawMaterialTab({ jcId }: { jcId: number }) {
  // Identify is JC-agnostic (it answers "which table is this box in"), so jcId
  // isn't needed for the lookup itself.
  void jcId;

  const [scanned, setScanned] = useState<string | null>(null);
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [toast, setToast] = useState<{ text: string } | null>(null);
  // The value currently displayed. The scanner re-emits a held QR (~every 1.5s);
  // this guard stops the same code re-toasting — including after a manual ✕ or an
  // auto-dismiss — so the toast doesn't pop back while the code is held.
  const lastShownRef = useRef<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  // Monotonic id per scan: a slow lookup response is dropped if a newer scan
  // superseded it, so the card always reflects the latest code.
  const reqRef = useRef(0);

  const clearToastTimer = useCallback(() => {
    if (toastTimerRef.current != null) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
  }, []);

  // Runs for every fresh QR decode: show the raw value + fire the identify lookup.
  const handleScan = useCallback((value: string) => {
    const v = value.trim();
    if (!v || v === lastShownRef.current) return; // ignore empties + held-QR re-emits
    lastShownRef.current = v;
    setScanned(v);
    setLookup({ status: "loading" });
    setToast({ text: `Scanned: ${v}` });
    clearToastTimer();
    toastTimerRef.current = window.setTimeout(() => setToast(null), TOAST_MS);

    const reqId = ++reqRef.current;
    void (async () => {
      try {
        const res = await apiFetch("/api/v1/production/scan-identify", {
          method: "POST",
          body: JSON.stringify({ value: v }),
        });
        if (reqRef.current !== reqId) return; // superseded by a newer scan
        if (!res.ok) {
          setLookup({ status: "err", error: await readApiErrorMessage(res, "Lookup failed") });
          return;
        }
        const data = (await res.json()) as IdentifyResult;
        if (reqRef.current !== reqId) return;
        setLookup({ status: "ok", data });
      } catch (e) {
        if (reqRef.current !== reqId) return;
        setLookup({ status: "err", error: friendlyApiError(e) });
      }
    })();
  }, [clearToastTimer]);

  const dismissToast = useCallback(() => {
    clearToastTimer();
    setToast(null);
  }, [clearToastTimer]);

  // Clear the pending auto-dismiss timer on unmount.
  useEffect(() => clearToastTimer, [clearToastTimer]);

  return (
    <div className="space-y-4">
      {/* Scanner pinned to the top; a scan identifies the box below. */}
      <QrScanner onResult={handleScan} />

      {toast ? (
        <div
          role="status"
          aria-live="polite"
          className="px-3 py-2 text-[13px] rounded-[2px] border flex items-center justify-between gap-3 bg-[#eaf6ed] border-[#b6dbb1] text-[var(--text-success)]"
        >
          <span className="break-all">{toast.text}</span>
          <button
            type="button"
            onClick={dismissToast}
            aria-label="Dismiss"
            className="shrink-0 text-[15px] leading-none text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            ✕
          </button>
        </div>
      ) : null}

      {scanned ? (
        <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--aws-border)]">
            <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">Scanned QR</h3>
          </div>
          <div className="p-4 space-y-4">
            <div>
              <div className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted)]">Value</div>
              <div className="font-mono text-[13px] text-[var(--text-primary)] break-all">{scanned}</div>
            </div>
            <ScanResult lookup={lookup} />
          </div>
        </div>
      ) : (
        <div className="bg-white border border-dashed border-[var(--aws-border-strong)] rounded-md p-4 text-center text-[12px] text-[var(--text-muted)]">
          Scan a raw-material QR to identify its box.
        </div>
      )}
    </div>
  );
}

// Renders the identify outcome: loading / error / found (table + box) / not-found.
function ScanResult({ lookup }: { lookup: Lookup | null }) {
  if (!lookup || lookup.status === "loading")
    return <div className="text-[12px] text-[var(--text-muted)]">Looking up…</div>;
  if (lookup.status === "err")
    return <div className="text-[12px] text-[var(--text-danger)]">{lookup.error}</div>;

  const r = lookup.data;
  if (!r.found)
    return (
      <div className="text-[12px] text-[var(--text-danger)]">
        Not found in any box table{r.box_id ? ` (${r.box_id})` : ""}.
      </div>
    );

  const b = r.box;
  const rows: [string, string | number | null][] = [
    ["Box ID", b.box_id],
    ["Transaction", b.transaction_no],
    ["Item", b.item_description],
    ["Lot", b.lot_number],
    ["Net wt (kg)", b.net_weight],
    ["Gross wt (kg)", b.gross_weight],
    ["Count", b.count],
    ["Status", b.status],
    ["Job card", b.job_card_number],
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="px-2 py-0.5 rounded-[2px] bg-[#eaf6ed] border border-[#b6dbb1] text-[var(--text-success)] font-semibold">
          Found in {r.table}
        </span>
        {r.company ? (
          <span className="px-2 py-0.5 rounded-[2px] bg-[var(--aws-bg-subtle,#f2f3f3)] border border-[var(--aws-border)] uppercase text-[var(--text-muted)]">
            {r.company}
          </span>
        ) : null}
      </div>
      <dl className="grid grid-cols-[minmax(90px,auto)_1fr] gap-x-4 gap-y-1.5 text-[13px]">
        {rows
          .filter(([, v]) => v !== null && v !== "")
          .map(([label, v]) => (
            <div key={label} className="contents">
              <dt className="text-[var(--text-muted)]">{label}</dt>
              <dd className="text-[var(--text-primary)] break-all">{String(v)}</dd>
            </div>
          ))}
      </dl>
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
  const lastHitRef = useRef<{ value: string; at: number } | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  // Read onResult through a ref so the long-lived decode loop always calls the
  // latest handler without being rebuilt, and can never capture a stale closure.
  const onResultRef = useRef(onResult);
  useEffect(() => { onResultRef.current = onResult; }, [onResult]);

  const [state, setState] = useState<ScanState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [manual, setManual] = useState("");

  const stop = useCallback(() => {
    genRef.current++; // supersede any in-flight start()
    activeRef.current = false;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (flashTimerRef.current != null) {
      window.clearTimeout(flashTimerRef.current);
      flashTimerRef.current = null;
    }
    const s = streamRef.current;
    if (s) {
      s.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    detectorRef.current = null;
    const v = videoRef.current;
    if (v) v.srcObject = null;
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
    const detector = detectorRef.current;
    if (detector) {
      try {
        const codes = await detector.detect(canvas);
        if (!activeRef.current || genRef.current !== gen) return; // torn down mid-detect
        value = codes.length && codes[0].rawValue ? codes[0].rawValue.trim() : "";
      } catch {
        return; // transient detector error — keep scanning
      }
    } else {
      const reader = readerRef.current;
      if (!reader) return;
      try {
        value = reader.decodeFromCanvas(canvas).getText().trim();
      } catch {
        return; // No QR in the ROI this frame (NotFoundException) — keep scanning.
      }
    }
    if (value) {
      const prev = lastHitRef.current;
      // De-dupe rapid repeats of the same code so a held QR doesn't spam.
      if (!prev || prev.value !== value || now - prev.at > 1500) {
        lastHitRef.current = { value, at: now };
        setFlash(true);
        if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current);
        flashTimerRef.current = window.setTimeout(() => setFlash(false), 350);
        onResultRef.current?.(value);
      }
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
    lastHitRef.current = null; // don't let the previous session's dedupe suppress a re-scan
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

  const live = state === "scanning" || state === "starting";

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
                outline: `2px solid ${flash ? "#1d8102" : "var(--aws-orange)"}`,
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
                    style={{ borderColor: flash ? "#1d8102" : "#ffffff" }}
                  />
                ))}
            </div>
          </div>
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
