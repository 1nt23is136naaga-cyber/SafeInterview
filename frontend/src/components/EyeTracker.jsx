import { useEffect, useRef, useState, useCallback } from "react";

/**
 * EyeTracker.jsx — Fixed & Rewritten using @mediapipe/tasks-vision (npm)
 *
 * Uses the official MediaPipe Tasks Vision FaceLandmarker API.
 * Runs entirely in the browser — no raw video is sent to server.
 * Only sends anonymised aggregated feature summaries every reportIntervalMs.
 *
 * Features tracked per frame:
 *  - Gaze zone: left / right / up / center / off
 *  - Blink detection via Eye Aspect Ratio (EAR)
 *  - Head yaw & pitch via face geometry
 *  - Fixation duration in same gaze zone
 *  - Off-screen (face not detected)
 */

// ── MediaPipe 478-landmark indices ─────────────────────────────────────────
// Left eye
const L_OUTER  = 33,  L_INNER  = 133, L_TOP  = 159, L_BOT  = 145;
// Right eye
const R_OUTER  = 263, R_INNER  = 362, R_TOP  = 386, R_BOT  = 374;
// Iris centers (available with outputFacialTransformationMatrixes OR refineLandmarks)
const L_IRIS   = 468, R_IRIS   = 473;
// Head geometry anchors
const NOSE_TIP = 1, CHIN = 152, L_TEMPLE = 234, R_TEMPLE = 454;

function earScore(lm, topI, botI, outerI, innerI) {
  if (!lm[topI]) return 0.3;
  const h = Math.abs(lm[topI].y - lm[botI].y);
  const w = Math.abs(lm[outerI].x - lm[innerI].x) || 0.001;
  return h / w;
}

function classifyGaze(iris, outerX, innerX, topY, botY) {
  const w = Math.abs(outerX - innerX) || 0.001;
  const h = Math.abs(topY - botY) || 0.001;
  const nx = (iris.x - Math.min(outerX, innerX)) / w;
  const ny = (iris.y - Math.min(topY, botY)) / h;
  if (nx < 0.28) return "left";
  if (nx > 0.72) return "right";
  if (ny < 0.28) return "up";
  return "center";
}

function stdDev(arr) {
  if (!arr || arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length);
}

function makeCounters() {
  return {
    frames: 0, left: 0, right: 0, up: 0, center: 0, off: 0,
    blinks: 0, wasBlinking: false,
    fixZone: null, fixSince: null, fixDurations: [],
    yaws: [], pitches: [],
  };
}

// ── Fallback gaze visualisation colors ─────────────────────────────────────
const ZONE_COLOR = {
  center: "#10b981", left: "#f59e0b", right: "#f59e0b",
  up: "#3b82f6", off: "#ef4444",
};

export default function EyeTracker({
  onMetrics,
  onStatus,
  reportIntervalMs = 5000,
  enabled = true,
}) {
  const videoRef    = useRef(null);
  const landmarkerRef = useRef(null);
  const countersRef = useRef(makeCounters());
  const rafRef      = useRef(null);
  const timerRef    = useRef(null);
  const [ready, setReady]       = useState(false);
  const [error, setError]       = useState("");
  const [gazeZone, setGazeZone] = useState("center");
  const [bpm, setBpm]           = useState(0);

  // ── Flush summary to parent ───────────────────────────────────────────────
  const flush = useCallback(() => {
    const c = countersRef.current;
    if (c.frames < 5) return;
    const total = c.frames;
    const minutesFraction = reportIntervalMs / 60000;
    const blinksPerMin    = c.blinks / minutesFraction;
    const avgFixMs        = c.fixDurations.length
      ? c.fixDurations.reduce((a, b) => a + b, 0) / c.fixDurations.length
      : 500;
    const gazeNums = [
      ...Array(c.left).fill(0), ...Array(c.right).fill(1),
      ...Array(c.up).fill(2),   ...Array(c.center).fill(3),
    ];
    const summary = {
      gaze_left_pct:             c.left   / total,
      gaze_right_pct:            c.right  / total,
      gaze_up_pct:               c.up     / total,
      gaze_center_pct:           c.center / total,
      off_screen_pct:            c.off    / total,
      avg_fixation_duration_ms:  avgFixMs,
      blink_rate_per_min:        blinksPerMin,
      gaze_variance:             Math.min(stdDev(gazeNums) / 3, 1),
      head_yaw_std:              stdDev(c.yaws),
      head_pitch_std:            stdDev(c.pitches),
      sample_count:              total,
    };
    onMetrics?.(summary);
    setBpm(Math.round(blinksPerMin));
    countersRef.current = { ...makeCounters(), wasBlinking: c.wasBlinking };
  }, [onMetrics, reportIntervalMs]);

  // ── Process one FaceLandmarker result ─────────────────────────────────────
  const processFrame = useCallback((results) => {
    const c = countersRef.current;
    c.frames++;

    const faces = results?.faceLandmarks;
    if (!faces || faces.length === 0) {
      c.off++;
      setGazeZone("off");
      return;
    }

    const lm = faces[0]; // first face only

    // ── Gaze ─────────────────────────────────────────────────────────────
    // Use iris landmarks if present (FaceLandmarker outputs 478 pts with iris)
    let gaze = "center";
    if (lm[L_IRIS] && lm[R_IRIS]) {
      const lg = classifyGaze(
        lm[L_IRIS], lm[L_OUTER].x, lm[L_INNER].x, lm[L_TOP].y, lm[L_BOT].y
      );
      const rg = classifyGaze(
        lm[R_IRIS], lm[R_OUTER].x, lm[R_INNER].x, lm[R_TOP].y, lm[R_BOT].y
      );
      gaze = (lg === rg) ? lg : "center";
    }
    c[gaze]++;
    setGazeZone(gaze);

    // Fixation
    const now = Date.now();
    if (gaze !== c.fixZone) {
      if (c.fixSince && c.fixZone) c.fixDurations.push(now - c.fixSince);
      c.fixZone = gaze; c.fixSince = now;
    }

    // ── Blink (EAR threshold 0.20) ────────────────────────────────────────
    const ear = (
      earScore(lm, L_TOP, L_BOT, L_OUTER, L_INNER) +
      earScore(lm, R_TOP, R_BOT, R_OUTER, R_INNER)
    ) / 2;
    const blinking = ear < 0.20;
    if (blinking && !c.wasBlinking) c.blinks++;
    c.wasBlinking = blinking;

    // ── Head pose ──────────────────────────────────────────────────────────
    if (lm[NOSE_TIP] && lm[L_TEMPLE] && lm[R_TEMPLE] && lm[CHIN]) {
      const midX  = (lm[L_TEMPLE].x + lm[R_TEMPLE].x) / 2;
      const yaw   = (lm[NOSE_TIP].x - midX) * 200;
      const pitch = (lm[NOSE_TIP].y - lm[CHIN].y) * 100;
      c.yaws.push(yaw);    if (c.yaws.length   > 300) c.yaws.shift();
      c.pitches.push(pitch); if (c.pitches.length > 300) c.pitches.shift();
    }
  }, []);

  // ── Init MediaPipe FaceLandmarker ─────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return;
    let active = true;

    const init = async () => {
      try {
        onStatus?.("Requesting camera…");
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 320, height: 240, facingMode: "user" },
          audio: false,
        });
        if (!active) { stream.getTracks().forEach(t => t.stop()); return; }

        videoRef.current.srcObject = stream;
        await videoRef.current.play();

        onStatus?.("Loading eye model…");

        // Dynamic import from npm package — reliable, no CDN CORS issues
        const { FaceLandmarker, FilesetResolver } = await import(
          "@mediapipe/tasks-vision"
        );

        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm"
        );

        let faceLandmarker;
        try {
          faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath:
                "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
              delegate: "GPU",
            },
            outputFaceBlendshapes: false,
            runningMode: "VIDEO",
            numFaces: 1,
          });
        } catch {
          // GPU delegate failed (common in some browsers) — retry with CPU
          faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath:
                "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
              delegate: "CPU",
            },
            outputFaceBlendshapes: false,
            runningMode: "VIDEO",
            numFaces: 1,
          });
        }

        landmarkerRef.current = faceLandmarker;
        onStatus?.("Eye tracking active ✓");
        setReady(true);
        if (!active) return;

        // ── Inference loop ─────────────────────────────────────────────────
        let lastVideoTime = -1;
        function detectLoop() {
          if (!active || !videoRef.current) return;
          const video = videoRef.current;
          if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
            lastVideoTime = video.currentTime;
            const results = faceLandmarker.detectForVideo(video, Date.now());
            processFrame(results);
          }
          rafRef.current = requestAnimationFrame(detectLoop);
        }
        rafRef.current = requestAnimationFrame(detectLoop);

        // Flush metrics on interval
        timerRef.current = setInterval(flush, reportIntervalMs);

      } catch (err) {
        if (!active) return;
        console.error("[EyeTracker]", err);
        // Properly handle errors where .message may be undefined
        let msg;
        if (err?.name === "NotAllowedError") {
          msg = "Camera access denied — please allow camera permission";
        } else if (err?.name === "NotFoundError") {
          msg = "No camera detected on this device";
        } else if (!navigator.onLine) {
          msg = "Eye model needs internet (first load)";
        } else {
          msg = err?.message || err?.name || "Camera / model unavailable";
        }
        setError(msg);
        onStatus?.(msg);
      }
    };

    init();

    return () => {
      active = false;
      cancelAnimationFrame(rafRef.current);
      clearInterval(timerRef.current);
      if (landmarkerRef.current) {
        try { landmarkerRef.current.close(); } catch (_) {}
        landmarkerRef.current = null;
      }
      if (videoRef.current?.srcObject) {
        videoRef.current.srcObject.getTracks().forEach(t => t.stop());
      }
    };
  }, [enabled, processFrame, flush, onStatus, reportIntervalMs]);

  if (!enabled) return null;

  return (
    <div className="flex items-center gap-3 px-3 py-2 bg-black/30 rounded-xl border border-white/8">
      {/* Hidden video feed for MediaPipe */}
      <video ref={videoRef} className="hidden" width={320} height={240} muted playsInline />

      {/* Gaze indicator dot */}
      <div className="relative w-8 h-8 shrink-0">
        <div className="w-full h-full rounded-full bg-black/40 border border-white/10 flex items-center justify-center text-sm">
          {gazeZone === "off" ? "—" : "👁"}
        </div>
        <div
          className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-black/60 transition-colors duration-300"
          style={{ backgroundColor: ZONE_COLOR[gazeZone] || "#6b7280" }}
        />
      </div>

      <div className="flex-1 min-w-0">
        {error ? (
          <p className="text-xs text-amber-400 truncate">⚠ {error}</p>
        ) : ready ? (
          <div className="space-y-0.5">
            <p className="text-xs text-gray-300 font-medium capitalize">
              Gaze: <span className="text-white">{gazeZone}</span>
              <span className="text-gray-500 ml-2">· {bpm} blinks/min</span>
            </p>
            <p className="text-[10px] text-gray-600">Eye attention active — no video stored</p>
          </div>
        ) : (
          <p className="text-xs text-gray-500 animate-pulse">Initialising eye tracking…</p>
        )}
      </div>

      {/* Status pulse */}
      <div className={`w-2 h-2 rounded-full shrink-0 ${ready ? "bg-emerald-400 animate-pulse" : error ? "bg-amber-500" : "bg-gray-600 animate-pulse"}`} />
    </div>
  );
}
