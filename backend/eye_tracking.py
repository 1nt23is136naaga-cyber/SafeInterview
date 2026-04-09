"""
eye_tracking.py — Eye behavior scoring module for VeritasAI.

Receives pre-processed eye metrics from the browser (MediaPipe FaceMesh runs
client-side to avoid storing raw video). Only anonymised feature summaries
are sent to the backend.

Features computed client-side and received here:
  gaze_left_pct, gaze_right_pct, gaze_up_pct, gaze_center_pct
  avg_fixation_duration_ms, blink_rate_per_min
  gaze_variance, off_screen_pct, head_yaw_std, head_pitch_std

Privacy: No raw frames or video are ever received or stored.
"""

from __future__ import annotations
import logging
from dataclasses import dataclass, asdict

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Thresholds (calibrated against natural speaker distributions)
# ---------------------------------------------------------------------------

# Gaze
OFF_SCREEN_THRESHOLD        = 0.35   # >35% off-screen = flag
GAZE_DIRECTIONAL_BIAS       = 0.40   # >40% in single direction = flag
FIXATION_DURATION_HIGH_MS   = 3000   # >3s same gaze = flag (reading)
GAZE_VARIANCE_LOW           = 0.02   # <0.02 std = unnaturally still gaze

# Blink (healthy range: 12–20/min; reading: 3–8/min; stress: > 25/min)
BLINK_RATE_LOW_THRESHOLD    = 8.0    # < 8/min = possibly reading
BLINK_RATE_HIGH_THRESHOLD   = 30.0   # > 30/min = stress or anxiety

# Weights in the eye behavior score (must sum to 1.0)
WEIGHTS = {
    "off_screen":         0.25,
    "directional_bias":   0.20,
    "fixation_duration":  0.20,
    "gaze_variance":      0.15,
    "blink_rate":         0.10,
    "head_movement":      0.10,
}


# ---------------------------------------------------------------------------
# Data structure
# ---------------------------------------------------------------------------

@dataclass
class EyeMetricsSummary:
    """Anonymised eye feature summary received from the frontend."""
    gaze_left_pct:           float = 0.0   # 0–1
    gaze_right_pct:          float = 0.0
    gaze_up_pct:             float = 0.0
    gaze_center_pct:         float = 0.0
    off_screen_pct:          float = 0.0
    avg_fixation_duration_ms:float = 500.0
    blink_rate_per_min:      float = 15.0
    gaze_variance:           float = 0.10
    head_yaw_std:            float = 5.0   # degrees std dev
    head_pitch_std:          float = 5.0
    sample_count:            int   = 0     # frames analysed


@dataclass
class EyeBehaviorScore:
    """Output of the eye behavior analysis."""
    eye_score:               float = 0.0   # 0–1, higher = more suspicious
    off_screen_signal:       float = 0.0
    directional_bias_signal: float = 0.0
    fixation_signal:         float = 0.0
    blink_signal:            float = 0.0
    variance_signal:         float = 0.0
    head_movement_signal:    float = 0.0
    dominant_gaze:           str   = "center"
    human_explanation:       list[str] = None
    reliable:                bool  = True  # False if too few frames

    def __post_init__(self):
        if self.human_explanation is None:
            self.human_explanation = []


# ---------------------------------------------------------------------------
# Main scorer
# ---------------------------------------------------------------------------

def compute_eye_behavior_score(metrics: EyeMetricsSummary) -> EyeBehaviorScore:
    """
    Compute a weighted 0–1 eye behavior risk score from the eye feature summary.

    Designed to:
      - Not penalise natural glances away
      - Be robust to nervous blinking
      - Only flag consistent, pattern-level anomalies
    """
    if metrics.sample_count < 50:
        logger.info("Too few eye frames (%d) — marking eye score as unreliable.", metrics.sample_count)
        return EyeBehaviorScore(reliable=False)

    explanations: list[str] = []

    # ── 1. Off-screen attention ───────────────────────────────────────────
    off_screen_raw = min(metrics.off_screen_pct, 1.0)
    # Apply soft threshold — up to 15% is normal (thinking, note-check)
    off_screen_signal = max((off_screen_raw - 0.15) / 0.85, 0.0)
    if off_screen_raw > OFF_SCREEN_THRESHOLD:
        explanations.append(
            f"Candidate's attention was off-screen for {round(off_screen_raw * 100)}% of the response"
        )

    # ── 2. Directional gaze bias ─────────────────────────────────────────
    gaze_vals = {
        "left":  metrics.gaze_left_pct,
        "right": metrics.gaze_right_pct,
        "up":    metrics.gaze_up_pct,
    }
    dominant = max(gaze_vals, key=gaze_vals.get)
    dominant_val = gaze_vals[dominant]
    # Bias signal: only flags if >40% consistently in one direction
    directional_bias_signal = max((dominant_val - 0.25) / 0.75, 0.0)
    if dominant_val > GAZE_DIRECTIONAL_BIAS:
        explanations.append(
            f"Frequent gaze shifted towards {dominant} side "
            f"({round(dominant_val * 100)}% of response time) — "
            f"may indicate reading from an off-screen source"
        )

    # ── 3. Fixation duration ──────────────────────────────────────────────
    # Long fixations (reading a text) vs short natural scanning
    fix_ms = metrics.avg_fixation_duration_ms
    fixation_signal = min(max((fix_ms - 1000) / (FIXATION_DURATION_HIGH_MS - 1000), 0.0), 1.0)
    if fix_ms > FIXATION_DURATION_HIGH_MS:
        explanations.append(
            f"High average fixation duration ({round(fix_ms / 1000, 1)}s) — "
            f"consistent with reading rather than spontaneous recall"
        )

    # ── 4. Blink rate ─────────────────────────────────────────────────────
    bpm = metrics.blink_rate_per_min
    if bpm < BLINK_RATE_LOW_THRESHOLD:
        # Low blink = focused reading
        blink_signal = (BLINK_RATE_LOW_THRESHOLD - bpm) / BLINK_RATE_LOW_THRESHOLD
        if bpm < 6:
            explanations.append(
                f"Very low blink rate ({round(bpm, 1)}/min) — "
                f"below normal resting rate, consistent with focused reading"
            )
    elif bpm > BLINK_RATE_HIGH_THRESHOLD:
        # High blink = anxiety (contributes less — not a cheating signal)
        blink_signal = min((bpm - BLINK_RATE_HIGH_THRESHOLD) / 30.0, 0.5) * 0.4
    else:
        blink_signal = 0.0

    # ── 5. Gaze variance ─────────────────────────────────────────────────
    # Natural speakers have varied eye movement; scripted reading = rigid
    gaze_var = metrics.gaze_variance
    variance_signal = max((GAZE_VARIANCE_LOW - gaze_var) / GAZE_VARIANCE_LOW, 0.0)
    if gaze_var < GAZE_VARIANCE_LOW:
        explanations.append(
            f"Unusually low gaze variance — eye movement is rigidly fixed, "
            f"atypical for spontaneous thought"
        )

    # ── 6. Head movement ─────────────────────────────────────────────────
    # Very low head movement = stiff/reading; very high = distracted
    head_total_std = (metrics.head_yaw_std + metrics.head_pitch_std) / 2
    # Flag abnormally low head movement (< 2° std)
    if head_total_std < 2.0:
        head_movement_signal = (2.0 - head_total_std) / 2.0
    else:
        head_movement_signal = 0.0

    # ── Composite score ───────────────────────────────────────────────────
    eye_score = (
        WEIGHTS["off_screen"]       * off_screen_signal
        + WEIGHTS["directional_bias"] * directional_bias_signal
        + WEIGHTS["fixation_duration"]* fixation_signal
        + WEIGHTS["blink_rate"]       * blink_signal
        + WEIGHTS["gaze_variance"]    * variance_signal
        + WEIGHTS["head_movement"]    * head_movement_signal
    )
    eye_score = round(min(eye_score, 1.0), 4)

    return EyeBehaviorScore(
        eye_score=               eye_score,
        off_screen_signal=       round(off_screen_signal, 4),
        directional_bias_signal= round(directional_bias_signal, 4),
        fixation_signal=         round(fixation_signal, 4),
        blink_signal=            round(blink_signal, 4),
        variance_signal=         round(variance_signal, 4),
        head_movement_signal=    round(head_movement_signal, 4),
        dominant_gaze=           dominant,
        human_explanation=       explanations,
        reliable=                True,
    )


def parse_eye_event(data: dict) -> EyeMetricsSummary:
    """Parse a 'eye_metrics' WebSocket event dict into EyeMetricsSummary."""
    return EyeMetricsSummary(
        gaze_left_pct=           float(data.get("gaze_left_pct", 0.0)),
        gaze_right_pct=          float(data.get("gaze_right_pct", 0.0)),
        gaze_up_pct=             float(data.get("gaze_up_pct", 0.0)),
        gaze_center_pct=         float(data.get("gaze_center_pct", 0.0)),
        off_screen_pct=          float(data.get("off_screen_pct", 0.0)),
        avg_fixation_duration_ms=float(data.get("avg_fixation_duration_ms", 500.0)),
        blink_rate_per_min=      float(data.get("blink_rate_per_min", 15.0)),
        gaze_variance=           float(data.get("gaze_variance", 0.1)),
        head_yaw_std=            float(data.get("head_yaw_std", 5.0)),
        head_pitch_std=          float(data.get("head_pitch_std", 5.0)),
        sample_count=            int(data.get("sample_count", 0)),
    )
