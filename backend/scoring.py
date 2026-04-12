"""
scoring.py — Adaptive scoring engine for AntiGravity SafeInterview.

Provides:
  - classify_signal_strength()  → "Weak" | "Moderate" | "Strong"
  - compute_adaptive_weights()  → dynamically adjust component weights
  - compute_confidence_score()  → 0–100 inter-signal agreement score
  - get_risk_level()            → reads from configurable thresholds.json
  - load_thresholds() / save_thresholds()
"""

import json
import logging
import os
import math
from datetime import datetime

logger = logging.getLogger(__name__)

_THRESHOLDS_FILE = os.path.join(os.path.dirname(__file__), "thresholds.json")

# ---------------------------------------------------------------------------
# Default thresholds (overridden by thresholds.json)
# ---------------------------------------------------------------------------

_DEFAULT_THRESHOLDS = {
    "low_max": 30,
    "medium_max": 65,
    "last_updated": datetime.utcnow().isoformat(),
    "version": 1,
}

# ---------------------------------------------------------------------------
# Threshold management
# ---------------------------------------------------------------------------

def load_thresholds() -> dict:
    """Load thresholds from thresholds.json, falling back to defaults."""
    try:
        if os.path.exists(_THRESHOLDS_FILE):
            with open(_THRESHOLDS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            # Validate required keys
            if "low_max" in data and "medium_max" in data:
                return data
    except Exception as e:
        logger.warning("Could not load thresholds.json: %s — using defaults.", e)
    return dict(_DEFAULT_THRESHOLDS)


def save_thresholds(thresholds: dict) -> dict:
    """
    Persist updated thresholds to thresholds.json.

    Args:
        thresholds: dict with at least 'low_max' and 'medium_max' (0–100 integers).

    Returns:
        The saved thresholds dict.

    Raises:
        ValueError: if thresholds are invalid.
    """
    low  = int(thresholds.get("low_max", 30))
    med  = int(thresholds.get("medium_max", 65))

    if not (0 < low < med < 100):
        raise ValueError(
            f"Invalid thresholds: low_max={low} must be < medium_max={med} and both in 1–99."
        )

    updated = {
        "low_max":      low,
        "medium_max":   med,
        "last_updated": datetime.utcnow().isoformat(),
        "version":      thresholds.get("version", 1) + 1,
        "description":  "Risk level thresholds: 0–low_max=LOW, low_max–medium_max=MEDIUM, medium_max–100=HIGH",
    }
    with open(_THRESHOLDS_FILE, "w", encoding="utf-8") as f:
        json.dump(updated, f, indent=2)
    return updated


# ---------------------------------------------------------------------------
# Risk level
# ---------------------------------------------------------------------------

def get_risk_level(score: float, thresholds: dict | None = None) -> str:
    """
    Map a final score (0–100) to a risk label using configurable thresholds.

    Args:
        score:      Final suspicion score 0–100.
        thresholds: Optional thresholds dict. Loaded from file if not provided.

    Returns:
        "LOW" | "MEDIUM" | "HIGH"
    """
    t = thresholds or load_thresholds()
    low_max = t.get("low_max", 30)
    med_max = t.get("medium_max", 65)

    if score >= med_max:
        return "HIGH"
    if score >= low_max:
        return "MEDIUM"
    return "LOW"


# ---------------------------------------------------------------------------
# Signal strength classification
# ---------------------------------------------------------------------------

# Boundaries for each signal component (score 0–100)
_SIGNAL_BOUNDARIES = {
    "default": {"weak_max": 35, "strong_min": 65},
}


def classify_signal_strength(score: float, domain: str = "default") -> str:
    """
    Classify a 0–100 sub-score into Weak / Moderate / Strong.

    Args:
        score:  The sub-score (0–100).
        domain: Domain key for custom boundaries (currently 'default' for all).

    Returns:
        "Weak" | "Moderate" | "Strong"
    """
    bounds = _SIGNAL_BOUNDARIES.get(domain, _SIGNAL_BOUNDARIES["default"])
    weak_max   = bounds["weak_max"]
    strong_min = bounds["strong_min"]

    if score >= strong_min:
        return "Strong"
    if score >= weak_max:
        return "Moderate"
    return "Weak"


def classify_all_signals(sub_scores: dict) -> dict:
    """
    Classify all three sub-scores into signal strength labels.

    Args:
        sub_scores: {"speech_shift": float, "originality": float, "behavior": float}

    Returns:
        {"speech": str, "originality": str, "behavior": str}
    """
    return {
        "speech":      classify_signal_strength(sub_scores.get("speech_shift", 0)),
        "originality": classify_signal_strength(sub_scores.get("originality",  0)),
        "behavior":    classify_signal_strength(sub_scores.get("behavior",     0)),
    }


# ---------------------------------------------------------------------------
# Adaptive weights
# ---------------------------------------------------------------------------

_BASE_WEIGHTS = {
    "speech":      0.30,
    "originality": 0.40,
    "behavior":    0.30,
}

# Boost applied when a signal is dominant (score ≥ threshold)
_STRONG_THRESHOLD = 65.0
_BOOST_AMOUNT     = 0.10


def compute_adaptive_weights(sub_scores: dict) -> dict:
    """
    Compute adaptive component weights based on signal dominance.

    Rules:
      - Start from base weights (speech=30%, originality=40%, behavior=30%)
      - If any component score ≥ 65, boost it by +10 percentage points
      - Re-normalise so all weights sum to exactly 1.0

    Args:
        sub_scores: {"speech_shift": float, "originality": float, "behavior": float}

    Returns:
        {"speech": float, "originality": float, "behavior": float}  (sum == 1.0)
    """
    w = dict(_BASE_WEIGHTS)

    speech_score = sub_scores.get("speech_shift", 0.0)
    orig_score   = sub_scores.get("originality",  0.0)
    behav_score  = sub_scores.get("behavior",     0.0)

    if speech_score >= _STRONG_THRESHOLD:
        w["speech"] += _BOOST_AMOUNT
    if orig_score >= _STRONG_THRESHOLD:
        w["originality"] += _BOOST_AMOUNT
    if behav_score >= _STRONG_THRESHOLD:
        w["behavior"] += _BOOST_AMOUNT

    # Normalise
    total = sum(w.values())
    if total > 0:
        w = {k: round(v / total, 4) for k, v in w.items()}

    return w


def apply_adaptive_weights(sub_scores: dict, weights: dict) -> float:
    """
    Compute the weighted final score using adaptive weights.

    Args:
        sub_scores: {"speech_shift": float, "originality": float, "behavior": float}
        weights:    Adaptive weights dict from compute_adaptive_weights()

    Returns:
        Weighted score (0–100), rounded to 1 decimal place.
    """
    raw = (
        weights["speech"]      * sub_scores.get("speech_shift", 0.0)
        + weights["originality"] * sub_scores.get("originality",  0.0)
        + weights["behavior"]    * sub_scores.get("behavior",     0.0)
    )
    return round(max(0.0, min(raw, 100.0)), 1)


# ---------------------------------------------------------------------------
# Confidence score
# ---------------------------------------------------------------------------

def compute_confidence_score(sub_scores: dict) -> dict:
    """
    Compute how much the three signals agree with each other.

    High agreement (all signals pointing in the same direction) → high confidence.
    Conflicting signals → low confidence.

    Formula:
        signal_values = [speech_shift, originality, behavior]
        mean          = average(signal_values)
        std_dev       = population standard deviation
        agreement_penalty = std_dev * 1.5   (max penalty ~75 for full spread 0–100)
        raw_confidence    = 100 - agreement_penalty
        confidence        = clamp(raw_confidence, 0, 100)

    Returns:
        {
          "confidence_score": int (0–100),
          "confidence_label": "High" | "Moderate" | "Low",
          "confidence_explanation": str,
        }
    """
    values = [
        sub_scores.get("speech_shift", 0.0),
        sub_scores.get("originality",  0.0),
        sub_scores.get("behavior",     0.0),
    ]

    n    = len(values)
    mean = sum(values) / n
    variance  = sum((v - mean) ** 2 for v in values) / n
    std_dev   = math.sqrt(variance)

    # Penalty increases with disagreement between signals
    agreement_penalty = std_dev * 1.5
    raw_confidence    = 100.0 - agreement_penalty
    confidence        = int(round(max(0.0, min(raw_confidence, 100.0))))

    if confidence >= 70:
        label = "High"
        explanation = (
            f"Confidence: {confidence}% — High agreement across all signals. "
            "Speech, originality, and behavioural signals are consistent with each other."
        )
    elif confidence >= 45:
        label = "Moderate"
        explanation = (
            f"Confidence: {confidence}% — Moderate agreement. Some signals diverge; "
            "treat the risk score as an indicator, not a definitive judgment."
        )
    else:
        label = "Low"
        explanation = (
            f"Confidence: {confidence}% — Low agreement across signals. "
            "One or more signals conflict significantly. "
            "Manual review of the session timeline is strongly recommended."
        )

    return {
        "confidence_score":       confidence,
        "confidence_label":       label,
        "confidence_explanation": explanation,
    }
