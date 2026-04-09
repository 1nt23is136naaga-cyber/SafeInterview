"""
baseline.py — Candidate speech baseline capture + delta engine for VeritasAI.

Flow:
  1. During intro phase (2 non-technical questions), capture BaselineProfile.
  2. For every technical answer, compute BaselineDelta.
  3. BaselineDelta feeds directly into the ensemble feature vector.

Key insight: comparing a candidate against THEMSELVES eliminates demographic
bias (accent, nervousness, speaking style) that plagues absolute thresholds.
"""

import logging
from dataclasses import dataclass, asdict, field
from typing import Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Intro questions — low-pressure, no technical content
# ---------------------------------------------------------------------------

INTRO_QUESTIONS = [
    "Please introduce yourself — tell us your name and something you enjoy outside of work.",
    "What drew you to apply for this position, and what excites you about it?",
]


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class BaselineProfile:
    """Natural speaking signature captured during the intro phase."""
    # Acoustic
    speech_rate: float = 0.0          # words per minute
    true_speech_rate: float = 0.0
    silence_ratio: float = 0.0
    pause_count_per_min: float = 0.0
    # Linguistic
    filler_ratio: float = 0.0
    structure_rigidity: float = 0.0
    personalization_score: float = 0.0
    lexical_richness: float = 0.0
    # Derived
    sample_count: int = 0             # how many intro answers contributed


@dataclass
class BaselineDelta:
    """Deviation of a single technical answer from the candidate's baseline."""
    speech_rate_delta: float = 0.0          # + = faster (suspicious if large)
    silence_ratio_delta: float = 0.0        # - = less silence (suspicious)
    pause_delta: float = 0.0               # - = fewer pauses (suspicious)
    filler_ratio_delta: float = 0.0         # - = fewer fillers (suspicious)
    structure_rigidity_delta: float = 0.0   # + = more formal (suspicious)
    personalization_delta: float = 0.0      # - = less personal (suspicious)
    lexical_richness_delta: float = 0.0     # + = richer vocab (suspicious)
    baseline_anomaly_score: float = 0.0     # composite 0-1
    has_baseline: bool = False


# ---------------------------------------------------------------------------
# Core functions
# ---------------------------------------------------------------------------

def build_baseline(intro_results: list[dict]) -> BaselineProfile:
    """
    Build a BaselineProfile by averaging feature dicts from intro-phase analyses.

    Args:
        intro_results: list of dicts returned by _full_analysis for intro questions.
                       Each dict must contain speech_metrics + linguistic features.

    Returns:
        BaselineProfile averaged across all intro answers.
    """
    if not intro_results:
        logger.warning("No intro results provided — baseline will be empty.")
        return BaselineProfile()

    def _avg(key: str, sub: str | None = None) -> float:
        vals = []
        for r in intro_results:
            try:
                blob = r.get(sub, r) if sub else r
                vals.append(float(blob.get(key, 0.0)))
            except (TypeError, AttributeError):
                pass
        return sum(vals) / len(vals) if vals else 0.0

    duration_total = sum(
        r.get("speech_metrics", {}).get("duration_seconds", 30.0)
        for r in intro_results
    )
    pause_total = sum(
        r.get("speech_metrics", {}).get("pause_count", 0)
        for r in intro_results
    )
    pause_per_min = (pause_total / max(duration_total / 60.0, 0.01))

    profile = BaselineProfile(
        speech_rate=          _avg("speech_rate",       "speech_metrics"),
        true_speech_rate=     _avg("true_speech_rate",  "speech_metrics"),
        silence_ratio=        _avg("silence_ratio",     "speech_metrics"),
        pause_count_per_min=  round(pause_per_min, 3),
        filler_ratio=         _avg("filler_ratio",      "speech_metrics"),
        structure_rigidity=   _avg("structure_rigidity"),
        personalization_score=_avg("personalization_score"),
        lexical_richness=     _avg("lexical_richness"),
        sample_count=         len(intro_results),
    )

    logger.info(
        "Baseline built from %d samples | WPM=%.1f filler=%.3f rigidity=%.3f",
        profile.sample_count,
        profile.speech_rate * 60,
        profile.filler_ratio,
        profile.structure_rigidity,
    )
    return profile


def compute_baseline_delta(
    baseline: BaselineProfile,
    answer_features: dict,
    speech_metrics: dict,
) -> BaselineDelta:
    """
    Compare a technical answer's features against the candidate's baseline.

    Args:
        baseline:        The BaselineProfile captured during intro.
        answer_features: Dict from extract_linguistic_features().
        speech_metrics:  Dict from analyze_behavior().

    Returns:
        BaselineDelta with per-signal deltas and a composite anomaly score.
    """
    if baseline.sample_count == 0:
        return BaselineDelta(has_baseline=False)

    # ── Raw deltas (answer value - baseline value) ────────────────────────
    sr_delta    = speech_metrics.get("speech_rate", 0.0) - baseline.speech_rate
    sil_delta   = speech_metrics.get("silence_ratio", 0.0) - baseline.silence_ratio
    dur_sec     = max(speech_metrics.get("duration_seconds", 30.0), 1.0)
    p_per_min   = speech_metrics.get("pause_count", 0) / (dur_sec / 60.0)
    pause_delta = p_per_min - baseline.pause_count_per_min
    fill_delta  = speech_metrics.get("filler_ratio", 0.0) - baseline.filler_ratio
    rig_delta   = answer_features.get("structure_rigidity", 0.0) - baseline.structure_rigidity
    pers_delta  = answer_features.get("personalization_score", 0.0) - baseline.personalization_score
    lex_delta   = answer_features.get("lexical_richness", 0.0) - baseline.lexical_richness

    # ── Anomaly contributions (each component 0–1, higher = more suspicious) ─
    # 1. Speech rate spike (relative)
    rate_anomaly = min(abs(sr_delta) / max(baseline.speech_rate, 0.5) * 0.5, 1.0)

    # 2. Filler drop (genuine speakers don't suddenly stop saying "um")
    filler_anomaly = min(max(-fill_delta, 0.0) * 8.0, 1.0)

    # 3. Structural formality spike (was casual, now textbook)
    rigidity_anomaly = min(max(rig_delta, 0.0) * 2.5, 1.0)

    # 4. Personalization drop (was personal, now generic)
    person_anomaly = min(max(-pers_delta, 0.0) * 2.0, 1.0)

    # 5. Silence drop (less thinking = reading from source)
    silence_anomaly = min(max(-sil_delta, 0.0) * 4.0, 1.0)

    composite = round(
        0.25 * rate_anomaly
        + 0.30 * filler_anomaly
        + 0.20 * rigidity_anomaly
        + 0.15 * person_anomaly
        + 0.10 * silence_anomaly,
        4,
    )

    return BaselineDelta(
        speech_rate_delta=      round(sr_delta, 4),
        silence_ratio_delta=    round(sil_delta, 4),
        pause_delta=            round(pause_delta, 4),
        filler_ratio_delta=     round(fill_delta, 4),
        structure_rigidity_delta=round(rig_delta, 4),
        personalization_delta=  round(pers_delta, 4),
        lexical_richness_delta= round(lex_delta, 4),
        baseline_anomaly_score= composite,
        has_baseline=           True,
    )


def baseline_to_feature_dict(delta: BaselineDelta) -> dict:
    """Convert a BaselineDelta to a flat dict for the feature vector."""
    return asdict(delta)
