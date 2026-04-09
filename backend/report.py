"""
report.py — RiskReport builder for VeritasAI.

Assembles all extracted features into an explainable, recruiter-friendly
risk report. This replaces the single 'verdict' string with a full
structured analysis that HR can act on and defend.
"""

from __future__ import annotations
import logging
from dataclasses import dataclass, field
from typing import Literal

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Output schemas (Pydantic-compatible via dataclasses for speed)
# ---------------------------------------------------------------------------

RiskLabel = Literal["GENUINE", "REVIEW", "SUSPICIOUS", "HIGH_RISK"]
Contribution = Literal["HIGH", "MEDIUM", "LOW", "POSITIVE"]


@dataclass
class RiskSignal:
    signal_name: str        # internal key
    human_label: str        # recruiter-friendly one-liner
    value: float            # raw value
    threshold: float        # threshold that was crossed
    contribution: Contribution
    direction: str = ""     # "↑ above normal" / "↓ below normal"


@dataclass
class RiskReport:
    risk_score: float
    risk_label: RiskLabel
    confidence: float
    verdict_summary: str
    top_signals: list[RiskSignal]
    timeline_events: list[dict]
    recommendation: str
    baseline_delta: dict
    # Sub-scores for the gauge display
    semantic_similarity: float = 0.0
    memorization_score: float = 0.0
    behavior_score: float = 0.0
    # Transcript
    transcript: str = ""
    matched_question: str = ""
    matched_phrases: list[str] = field(default_factory=list)
    all_scores: list[dict] = field(default_factory=list)
    speech_metrics: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Thresholds for signal firing
# ---------------------------------------------------------------------------

THRESHOLDS = {
    "semantic_similarity":     0.65,
    "memorization_score":      0.60,
    "behavior_score":          0.60,
    "structure_rigidity":      0.45,
    "linearity_score":         0.70,
    "lexical_richness":        0.70,
    "pause_variance_low":      0.15,   # below this = suspicious (unnaturally even)
    "filler_ratio_low":        0.02,   # below this = suspicious (too clean)
    "baseline_anomaly_score":  0.40,
    "tab_switch_count":        1,
    "copy_paste_count":        1,
    "correction_rate_low":     0.01,   # below this AND high score = suspicious
}

WEIGHT_MAP = {
    "semantic_similarity":    0.22,
    "memorization_score":     0.18,
    "structure_rigidity":     0.12,
    "linearity_score":        0.10,
    "baseline_anomaly_score": 0.12,
    "behavior_score":         0.10,
    "tab_switch_count":       0.08,
    "copy_paste_count":       0.08,
}


# ---------------------------------------------------------------------------
# Main builder
# ---------------------------------------------------------------------------

def build_risk_report(
    transcript: str,
    semantic_similarity: float,
    memorization_score: float,
    memorization_explanation: str,
    speech_metrics: dict,
    linguistic_features: dict,
    baseline_delta: dict,
    integrity_events: list[dict],
    matched_question: str,
    matched_phrases: list[str],
    all_scores: list[dict],
) -> RiskReport:
    """
    Assembles all module outputs into a single explainable RiskReport.
    """

    # ── 1. Gather all signal values ───────────────────────────────────────
    behavior_score    = speech_metrics.get("behavior_score", 0.0)
    structure_rig     = linguistic_features.get("structure_rigidity", 0.0)
    linearity         = linguistic_features.get("linearity_score", 0.5)
    lex_richness      = linguistic_features.get("lexical_richness", 0.5)
    personalization   = linguistic_features.get("personalization_score", 0.5)
    filler_ratio      = speech_metrics.get("filler_ratio", 0.05)
    pause_count       = speech_metrics.get("pause_count", 5)
    duration          = max(speech_metrics.get("duration_seconds", 30.0), 1.0)
    pause_per_min     = pause_count / (duration / 60.0)
    baseline_anomaly  = baseline_delta.get("baseline_anomaly_score", 0.0)
    has_baseline      = baseline_delta.get("has_baseline", False)

    tab_switches      = sum(1 for e in integrity_events if e.get("event_type") == "tab_switch")
    focus_losses      = sum(1 for e in integrity_events if e.get("event_type") == "focus_loss")
    copy_pastes       = sum(1 for e in integrity_events if e.get("event_type") in ("copy", "paste"))

    # ── 2. Compute weighted risk score ────────────────────────────────────
    raw_score = (
        WEIGHT_MAP["semantic_similarity"]    * semantic_similarity
        + WEIGHT_MAP["memorization_score"]   * memorization_score
        + WEIGHT_MAP["structure_rigidity"]   * structure_rig
        + WEIGHT_MAP["linearity_score"]      * linearity
        + WEIGHT_MAP["baseline_anomaly_score"] * baseline_anomaly
        + WEIGHT_MAP["behavior_score"]       * behavior_score
        + WEIGHT_MAP["tab_switch_count"]     * min(tab_switches / 3.0, 1.0)
        + WEIGHT_MAP["copy_paste_count"]     * min(copy_pastes / 2.0, 1.0)
    )
    risk_score = round(min(raw_score, 1.0), 4)

    # ── 3. Confidence estimate ─────────────────────────────────────────────
    # Confidence grows with signal agreement
    signals_elevated = sum([
        semantic_similarity > THRESHOLDS["semantic_similarity"],
        memorization_score  > THRESHOLDS["memorization_score"],
        structure_rig       > THRESHOLDS["structure_rigidity"],
        linearity           > THRESHOLDS["linearity_score"],
        behavior_score      > THRESHOLDS["behavior_score"],
        tab_switches        >= THRESHOLDS["tab_switch_count"],
    ])
    confidence = round(0.40 + signals_elevated * 0.10, 2)
    confidence = min(confidence, 0.97)

    # ── 4. Risk label ──────────────────────────────────────────────────────
    if risk_score >= 0.72:
        risk_label    = "HIGH_RISK"
        recommendation = "Human Review Required"
    elif risk_score >= 0.52:
        risk_label    = "SUSPICIOUS"
        recommendation = "Human Review Recommended"
    elif risk_score >= 0.35:
        risk_label    = "REVIEW"
        recommendation = "Proceed with Caution"
    else:
        risk_label    = "GENUINE"
        recommendation = "Proceed"

    # ── 5. Build signal list ───────────────────────────────────────────────
    signals: list[RiskSignal] = []

    if semantic_similarity > THRESHOLDS["semantic_similarity"]:
        signals.append(RiskSignal(
            signal_name="semantic_similarity",
            human_label=f"Answer closely matches known scripted responses ({round(semantic_similarity*100)}% similarity)",
            value=semantic_similarity,
            threshold=THRESHOLDS["semantic_similarity"],
            contribution="HIGH",
            direction="↑ above threshold",
        ))

    if structure_rig > THRESHOLDS["structure_rigidity"]:
        signals.append(RiskSignal(
            signal_name="structure_rigidity",
            human_label="Formal transitional markers detected ('firstly', 'furthermore', 'in conclusion')",
            value=structure_rig,
            threshold=THRESHOLDS["structure_rigidity"],
            contribution="HIGH" if structure_rig > 0.65 else "MEDIUM",
        ))

    if linearity > THRESHOLDS["linearity_score"]:
        signals.append(RiskSignal(
            signal_name="linearity_score",
            human_label="Unnaturally consistent idea flow — no natural topic drift or self-correction",
            value=linearity,
            threshold=THRESHOLDS["linearity_score"],
            contribution="HIGH" if linearity > 0.85 else "MEDIUM",
        ))

    if pause_per_min < 2.0 and duration > 20:
        signals.append(RiskSignal(
            signal_name="pause_variance",
            human_label=f"Very low pause frequency ({round(pause_per_min, 1)}/min) — unnaturally fluent delivery",
            value=pause_per_min,
            threshold=2.0,
            contribution="HIGH",
            direction="↓ below normal",
        ))

    if filler_ratio < THRESHOLDS["filler_ratio_low"] and duration > 20:
        signals.append(RiskSignal(
            signal_name="filler_ratio",
            human_label="Near-zero filler words ('um', 'uh') — atypical for spontaneous speech",
            value=filler_ratio,
            threshold=THRESHOLDS["filler_ratio_low"],
            contribution="MEDIUM",
            direction="↓ below normal",
        ))

    if personalization < 0.20 and duration > 20:
        signals.append(RiskSignal(
            signal_name="personalization_score",
            human_label="Very few first-person examples or specific personal details",
            value=personalization,
            threshold=0.20,
            contribution="MEDIUM",
            direction="↓ below normal",
        ))

    if has_baseline and baseline_anomaly > THRESHOLDS["baseline_anomaly_score"]:
        filler_d = baseline_delta.get("filler_ratio_delta", 0.0)
        rate_d   = baseline_delta.get("speech_rate_delta", 0.0)
        signals.append(RiskSignal(
            signal_name="baseline_anomaly",
            human_label=(
                f"Major shift from candidate's own intro baseline: "
                f"fillers {'dropped' if filler_d < 0 else 'rose'} by {abs(round(filler_d*100))}%, "
                f"speech rate {'↑' if rate_d > 0 else '↓'} {abs(round(rate_d, 2))} words/sec"
            ),
            value=baseline_anomaly,
            threshold=THRESHOLDS["baseline_anomaly_score"],
            contribution="HIGH" if baseline_anomaly > 0.60 else "MEDIUM",
        ))

    if tab_switches >= THRESHOLDS["tab_switch_count"]:
        signals.append(RiskSignal(
            signal_name="tab_switch_count",
            human_label=f"{tab_switches} browser focus loss event(s) detected during the answer",
            value=float(tab_switches),
            threshold=float(THRESHOLDS["tab_switch_count"]),
            contribution="HIGH" if tab_switches >= 3 else "MEDIUM",
        ))

    if copy_pastes >= THRESHOLDS["copy_paste_count"]:
        signals.append(RiskSignal(
            signal_name="copy_paste",
            human_label=f"{copy_pastes} copy/paste event(s) detected — potential external text injection",
            value=float(copy_pastes),
            threshold=float(THRESHOLDS["copy_paste_count"]),
            contribution="HIGH",
        ))

    # Positive signals (low risk indicators)
    if filler_ratio > 0.05:
        signals.append(RiskSignal(
            signal_name="filler_ratio_positive",
            human_label=f"Natural filler word usage ({round(filler_ratio*100, 1)}%) — consistent with genuine speech",
            value=filler_ratio,
            threshold=0.04,
            contribution="POSITIVE",
        ))

    # Sort: negatives first (HIGH → MEDIUM), then positives
    order = {"HIGH": 0, "MEDIUM": 1, "LOW": 2, "POSITIVE": 3}
    signals.sort(key=lambda s: order.get(s.contribution, 9))

    # ── 6. Build timeline ──────────────────────────────────────────────────
    timeline = []
    for ev in integrity_events:
        ts_ms = ev.get("timestamp", 0)
        secs  = int(ts_ms / 1000) % 3600
        label = f"{secs // 60:02d}:{secs % 60:02d}"
        ev_type = ev.get("event_type", "unknown")
        notes = {
            "tab_switch":   "Browser focus lost",
            "focus_loss":   "Window focus lost",
            "copy":         "Copy event detected",
            "paste":        "Paste event detected",
            "mouse_left":   "Mouse cursor left interview bounds",
            "left_fullscreen": "Exited fullscreen mode",
        }
        timeline.append({
            "time":     label,
            "event":    ev_type,
            "note":     notes.get(ev_type, ev_type),
            "details":  ev.get("details", ""),
        })

    # ── 7. Plain-English summary ───────────────────────────────────────────
    high_signals = [s for s in signals if s.contribution == "HIGH"]
    if risk_score >= 0.72:
        verdict_summary = (
            f"High integrity concern detected. The candidate's response triggers "
            f"{len(high_signals)} high-severity signal(s): "
            + ", ".join(s.human_label.split("—")[0].strip() for s in high_signals[:2])
            + ". Human review of the recording is strongly recommended before any hiring decision."
        )
    elif risk_score >= 0.52:
        verdict_summary = (
            f"Moderate concern detected. The response shows signs of preparation above typical levels. "
            + (f"Baseline comparison indicates a notable shift in speaking style. " if has_baseline and baseline_anomaly > 0.4 else "")
            + "A brief follow-up question to probe depth is recommended."
        )
    elif risk_score >= 0.35:
        verdict_summary = (
            "Mild indicators present. The response is mostly natural but exhibits some structured phrasing. "
            "This may reflect thorough preparation rather than external assistance."
        )
    else:
        verdict_summary = (
            "No significant integrity concerns detected. The response contains natural hesitation, "
            "filler words, and personal examples consistent with genuine, spontaneous speech."
        )

    return RiskReport(
        risk_score=       risk_score,
        risk_label=       risk_label,
        confidence=       confidence,
        verdict_summary=  verdict_summary,
        top_signals=      signals[:7],
        timeline_events=  timeline,
        recommendation=   recommendation,
        baseline_delta=   baseline_delta,
        semantic_similarity= semantic_similarity,
        memorization_score=  memorization_score,
        behavior_score=      behavior_score,
        transcript=          transcript,
        matched_question=    matched_question,
        matched_phrases=     matched_phrases,
        all_scores=          all_scores,
        speech_metrics=      speech_metrics,
    )
