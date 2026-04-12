"""
report.py — Final report score computation engine (AntiGravity / SafeInterview v3).

What's new in v3:
  - Adaptive weights (speech/originality/behavior boost when signal is dominant)
  - Confidence score (0–100 inter-signal agreement)
  - Signal strength classification (Weak / Moderate / Strong per component)
  - Configurable risk thresholds via thresholds.json
  - Enhanced report dict with confidence_score, signal_strengths, adaptive_weights,
    thresholds_used, and a reliability_note

Components:
  Speech Pattern Shift    — Deviation from candidate's own baseline.
  Answer Originality      — Semantic similarity + memorisation + linguistic AI signals.
  Behaviour Tracking      — Behavior score + tab-switch / focus-loss penalties.

Risk Thresholds (configurable):
  Default: 0–30=LOW  |  31–65=MEDIUM  |  66–100=HIGH
"""

import logging
from statistics import mean
from typing import Optional

from scoring import (
    load_thresholds,
    get_risk_level,
    compute_adaptive_weights,
    apply_adaptive_weights,
    classify_all_signals,
    compute_confidence_score,
)

logger = logging.getLogger(__name__)

_RELIABILITY_NOTE = (
    "This assessment is based on three independent signals (speech pattern shift, "
    "answer originality, and behavioural tracking) and should be used as decision support, "
    "not a final judgment. A high confidence score means signals agree; a low confidence "
    "score means signals conflict and manual review is recommended."
)


# ─────────────────────────────────────────────────────────────────────────────
# Main scoring function
# ─────────────────────────────────────────────────────────────────────────────

def compute_final_score(
    analysis_results: list[dict],
    integrity_events: list[dict],
) -> dict:
    """
    Compute the adaptive weighted final suspicion score from all session data.

    Args:
        analysis_results: List of result dicts from _full_analysis() for each candidate answer.
        integrity_events: List of integrity event dicts (tab_switch, focus_loss, etc.)

    Returns:
        Structured report dict with:
          final_score, risk_level, sub_scores, component_details,
          confidence_score, confidence_label, confidence_explanation,
          signal_strengths, adaptive_weights, thresholds_used,
          reliability_note, observations, interpretation, recommendation.
    """
    if not analysis_results:
        return _empty_report()

    thresholds = load_thresholds()

    # ── Helpers ──────────────────────────────────────────────────────────────
    def avg(key: str) -> float:
        vals = [float(r[key]) for r in analysis_results if r.get(key) is not None]
        return mean(vals) if vals else 0.0

    def avg_nested(outer: str, inner: str) -> float:
        vals = [
            float((r.get(outer) or {}).get(inner, 0.0))
            for r in analysis_results
            if (r.get(outer) or {}).get(inner) is not None
        ]
        return mean(vals) if vals else 0.0

    # ── Component 1: Speech Pattern Shift ────────────────────────────────────
    baseline_results = [
        r for r in analysis_results
        if (r.get("baseline_delta") or {}).get("has_baseline")
    ]
    if baseline_results:
        baseline_anomaly = mean(
            float(r["baseline_delta"]["baseline_anomaly_score"])
            for r in baseline_results
        )
    else:
        # Fallback: use raw behavior_score as proxy (halved)
        baseline_anomaly = avg("behavior_score") * 0.5

    speech_shift_score = round(min(baseline_anomaly * 100, 100), 1)

    # ── Component 2: Answer Originality / AI Detection ────────────────────────
    semantic_sim = avg("semantic_similarity")
    memorization = avg("memorization_score")
    structure    = avg_nested("linguistic_features", "structure_rigidity")
    linearity    = avg_nested("linguistic_features", "linearity_score")
    lexical      = avg_nested("linguistic_features", "lexical_richness")
    redundancy   = avg_nested("linguistic_features", "redundancy_ratio")

    originality_raw = (
        0.40 * semantic_sim
        + 0.25 * memorization
        + 0.15 * structure
        + 0.10 * linearity
        + 0.05 * lexical
        + 0.05 * redundancy
    )
    originality_score = round(min(originality_raw * 100, 100), 1)

    # ── Component 3: Behaviour Tracking ──────────────────────────────────────
    behavior_raw = avg("behavior_score")

    tab_switches  = sum(1 for e in integrity_events if e.get("event_type") == "tab_switch")
    focus_losses  = sum(1 for e in integrity_events if e.get("event_type") == "focus_loss")

    tab_penalty   = min(tab_switches * 0.08, 0.50)
    focus_penalty = min(focus_losses * 0.05, 0.30)

    behavior_combined = min(behavior_raw * 0.60 + tab_penalty + focus_penalty, 1.0)
    behavior_score    = round(behavior_combined * 100, 1)

    # ── Adaptive Weights + Weighted Final Score ────────────────────────────────
    sub_scores_raw = {
        "speech_shift": speech_shift_score,
        "originality":  originality_score,
        "behavior":     behavior_score,
    }

    adaptive_weights = compute_adaptive_weights(sub_scores_raw)
    final_score      = apply_adaptive_weights(sub_scores_raw, adaptive_weights)

    # ── Risk Level (configurable thresholds) ─────────────────────────────────
    risk_level = get_risk_level(final_score, thresholds)

    # ── Signal Strength Classification ────────────────────────────────────────
    signal_strengths = classify_all_signals(sub_scores_raw)

    # ── Confidence Score ──────────────────────────────────────────────────────
    confidence_data = compute_confidence_score(sub_scores_raw)

    # ── Observations ─────────────────────────────────────────────────────────
    observations = _build_observations(
        baseline_anomaly, semantic_sim, memorization,
        structure, tab_switches, focus_losses, len(baseline_results) > 0,
    )

    # ── Interpretation & Recommendation ──────────────────────────────────────
    interpretation = _build_interpretation(
        final_score, risk_level, speech_shift_score, originality_score, behavior_score,
        confidence_data["confidence_label"],
    )
    recommendation = _build_recommendation(risk_level, confidence_data["confidence_label"])

    return {
        # ── Core scores ──
        "final_score":   final_score,
        "risk_level":    risk_level,
        "sub_scores": {
            "speech_shift": speech_shift_score,
            "originality":  originality_score,
            "behavior":     behavior_score,
        },
        # ── Confidence ──
        "confidence_score":       confidence_data["confidence_score"],
        "confidence_label":       confidence_data["confidence_label"],
        "confidence_explanation": confidence_data["confidence_explanation"],
        # ── Signal strength ──
        "signal_strengths": signal_strengths,
        # ── Adaptive weights ──
        "adaptive_weights": adaptive_weights,
        # ── Thresholds used ──
        "thresholds_used": {
            "low_max":    thresholds.get("low_max", 30),
            "medium_max": thresholds.get("medium_max", 65),
        },
        # ── Reliability ──
        "reliability_note": _RELIABILITY_NOTE,
        # ── Granular breakdown ──
        "component_details": {
            "baseline_anomaly":    round(baseline_anomaly * 100, 1),
            "has_baseline":        len(baseline_results) > 0,
            "baseline_samples":    len(baseline_results),
            "semantic_similarity": round(semantic_sim * 100, 1),
            "memorization_score":  round(memorization * 100, 1),
            "structure_rigidity":  round(structure * 100, 1),
            "linearity_score":     round(linearity * 100, 1),
            "lexical_richness":    round(lexical * 100, 1),
            "behavior_raw":        round(behavior_raw * 100, 1),
            "tab_switches":        tab_switches,
            "focus_losses":        focus_losses,
            "tab_penalty_pct":     round(tab_penalty * 100, 1),
            "focus_penalty_pct":   round(focus_penalty * 100, 1),
            "total_answers":       len(analysis_results),
        },
        "observations":    observations,
        "interpretation":  interpretation,
        "recommendation":  recommendation,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _build_observations(
    baseline_anomaly: float,
    semantic_sim: float,
    memorization: float,
    structure: float,
    tab_switches: int,
    focus_losses: int,
    has_baseline: bool,
) -> list[str]:
    obs = []

    if has_baseline:
        if baseline_anomaly > 0.7:
            obs.append("Significant deviation from baseline speech patterns detected.")
        elif baseline_anomaly > 0.4:
            obs.append("Moderate shift in speech patterns compared to baseline.")
        else:
            obs.append("Speech patterns remain consistent with established baseline.")

    if semantic_sim > 0.75:
        obs.append("High semantic similarity with known interview answer patterns.")
    elif semantic_sim > 0.50:
        obs.append("Moderate similarity to reference answers detected.")
    else:
        obs.append("Response content appears original and personally constructed.")

    if memorization > 0.70:
        obs.append("Response structure matches memorised or AI-generated patterns.")
    if structure > 0.60:
        obs.append("Unusually formal transition phrases suggest structured external source.")

    if tab_switches > 5:
        obs.append(f"Frequent tab switching ({tab_switches} switches) — high suspicion.")
    elif tab_switches > 2:
        obs.append(f"{tab_switches} tab switches observed during the session.")
    elif tab_switches == 0:
        obs.append("No tab switches detected — candidate maintained focus throughout.")

    if focus_losses > 3:
        obs.append("Window focus lost multiple times — possible second screen usage.")

    if not obs:
        obs.append("No significant anomalies detected. Speech patterns appear natural.")

    return obs


def _build_interpretation(
    score: float,
    risk: str,
    speech: float,
    originality: float,
    behavior: float,
    confidence_label: str,
) -> str:
    conf_note = (
        f" (Confidence: {confidence_label} — signals {'agree' if confidence_label in ('High','Moderate') else 'conflict'}.)"
    )
    if risk == "HIGH":
        reasons = []
        if speech > 60:      reasons.append("deviation from baseline speech patterns")
        if originality > 60: reasons.append("high similarity to reference patterns")
        if behavior > 60:    reasons.append("multiple distraction behaviours")
        suffix = ": " + ", ".join(reasons) if reasons else ""
        return (
            f"High risk assessment ({score}/100) due to combined signals{suffix}.{conf_note} "
            "The combination of these factors suggests the candidate may not be "
            "responding independently."
        )
    if risk == "MEDIUM":
        return (
            f"Medium risk assessment ({score}/100).{conf_note} Some signals warrant further "
            "investigation. Consider targeted follow-up questions in areas where "
            "elevated scores were detected."
        )
    return (
        f"Low risk assessment ({score}/100).{conf_note} Candidate demonstrates natural speech "
        "patterns, appropriate hesitation, and personalised responses. No significant "
        "integrity concerns detected."
    )


def _build_recommendation(risk: str, confidence_label: str) -> str:
    low_conf_suffix = (
        " Note: confidence is low due to conflicting signals — exercise additional caution."
        if confidence_label == "Low" else ""
    )
    if risk == "HIGH":
        return (
            "Re-evaluate with deeper probing. Ask follow-up questions on specific topics "
            "where high similarity was detected. Consider an alternative assessment format "
            f"(live coding, whiteboard) to verify knowledge authenticity independently.{low_conf_suffix}"
        )
    if risk == "MEDIUM":
        return (
            "Ask targeted follow-up questions in areas where speech patterns shifted or "
            "similarity was elevated. Probe specific technical claims with open-ended "
            f"questions to verify genuine understanding.{low_conf_suffix}"
        )
    return (
        "Candidate demonstrates natural speech patterns and genuine responses. "
        f"No significant integrity concerns detected. Proceed normally with evaluation.{low_conf_suffix}"
    )


def _empty_report() -> dict:
    return {
        "final_score":            0.0,
        "risk_level":             "LOW",
        "sub_scores":             {"speech_shift": 0, "originality": 0, "behavior": 0},
        "confidence_score":       0,
        "confidence_label":       "Low",
        "confidence_explanation": "No data available to assess confidence.",
        "signal_strengths":       {"speech": "Weak", "originality": "Weak", "behavior": "Weak"},
        "adaptive_weights":       {"speech": 0.30, "originality": 0.40, "behavior": 0.30},
        "thresholds_used":        {"low_max": 30, "medium_max": 65},
        "reliability_note":       _RELIABILITY_NOTE,
        "component_details":      {},
        "observations":           ["No analysis data available — session may have been too short."],
        "interpretation":         "Insufficient data to compute a suspicion score.",
        "recommendation":         "Unable to assess. Please ensure audio was captured during the session.",
    }
