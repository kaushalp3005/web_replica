"use client";

// Inline, always-on camera QR scanner — a live preview card that continuously decodes
// a centred ROI and fires `onResult(value)` for each fresh code (de-duped so a held QR
// doesn't spam). Prefers the native BarcodeDetector, falls back to a hinted ZXing reader.
//
// ponytail: extracted verbatim from job-card/[id]/_RawMaterialTab.tsx's `QrScanner` so
// transfer-in / transfer-out get the exact same scanning UX. The RM-tab copy is left in
// place to avoid churning that working screen — if you touch this decoder, fold both here.

import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserQRCodeReader } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";

// BarcodeDetector is not in the TS DOM lib yet — declare the slice we use.
type BarcodeDetectorLike = { detect: (s: CanvasImageSource) => Promise<{ rawValue: string }[]> };
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike;

// Fraction of the smaller frame dimension occupied by the scan box. Kept as a
// ratio (not pixels) so the ROI is identical in proportion on a 480p phone and
// a 1080p webcam, and so it survives any viewport/orientation change.
const ROI_RATIO = 0.62;
// Fraction of the smaller frame dimension actually cropped for DECODING. Kept
// deliberately larger than ROI_RATIO so a QR framed to fill the on-screen box
// retains its white quiet zone (and a little overfill tolerance) inside the crop.
const DECODE_RATIO = 0.9;
// Cap the decode bitmap so the decoder stays fast on high-res cameras.
const DECODE_MAX_PX = 512;
// Throttle decode passes (~8/s) — plenty responsive while keeping mobile CPU cool.
const DECODE_INTERVAL_MS = 120;

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

export function QrScanBox({
  onResult,
  title = "Scan QR",
  idleHint = "Start the camera and centre a QR code inside the box.",
}: {
  onResult?: (value: string) => void;
  title?: string;
  idleHint?: string;
}) {
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
    const side = Math.round(Math.min(vw, vh) * DECODE_RATIO);
    const sx = Math.round((vw - side) / 2);
    const sy = Math.round((vh - side) / 2);
    const target = Math.min(side, DECODE_MAX_PX);

    if (canvas.width !== target) { canvas.width = target; canvas.height = target; }
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(v, sx, sy, side, side, 0, 0, target, target);

    // Decode ONLY the ROI canvas: native BarcodeDetector when present, else ZXing.
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
      setState("error");
      setError("Camera unavailable. Open this page over HTTPS (or localhost) on a device with a camera.");
      return;
    }
    const myGen = ++genRef.current; // this session's token; stop()/a newer start() bump it
    setState("starting");

    // Build the decoder BEFORE opening the camera, so a decoder-construction
    // failure can never strand a live camera stream.
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
        stream.getTracks().forEach((t) => t.stop());
        if (streamRef.current === stream) streamRef.current = null;
        return;
      }
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

  // Stop the stream + RAF loop on unmount (e.g. leaving the page/tab).
  useEffect(() => stop, [stop]);

  const live = state === "scanning" || state === "starting";

  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">{title}</h3>
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

      {/* Square viewport — full width, centred, capped so it doesn't dominate a desktop. */}
      <div className="relative mx-auto w-full max-w-[460px] aspect-square overflow-hidden rounded-lg bg-black">
        <video
          ref={videoRef}
          muted
          playsInline
          className="absolute inset-0 h-full w-full object-cover"
        />

        {/* ROI box + dimmed surround, only while live. Box is ROI_RATIO of the square viewport. */}
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
              {error ?? idleHint}
            </p>
          </div>
        ) : null}
      </div>

      {/* Offscreen decode buffer. */}
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
