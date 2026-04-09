"""
behavior.py — Behavioral speech analysis module (v2 — VeritasAI).

Changes from v1:
  - Added extract_acoustic_features() using librosa (pitch, energy variance)
  - Added detect_corrections() (mid-sentence self-corrections)
  - Added compute_pause_variance() (std-dev of pause durations from segments)
  - Retained all existing: speech_rate, true_speech_rate, filler_ratio, etc.
  - Removed: no changes to integrity penalty logic (kept from v1)
"""

import io
import re
import logging
from dataclasses import dataclass, asdict

import numpy as np

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

FILLER_WORDS = {
    "uh", "um", "like", "you know", "basically", "literally",
    "actually", "so", "well", "right", "okay", "i mean",
    "kind of", "sort of", "you see", "hmm", "er", "ah",
}

CORRECTION_MARKERS = [
    "i mean", "actually", "sorry", "let me rephrase", "what i meant",
    "or rather", "to be more precise", "let me correct", "scratch that",
]


# ---------------------------------------------------------------------------
# Data schemas
# ---------------------------------------------------------------------------

@dataclass
class SpeechMetrics:
    speech_rate: float
    true_speech_rate: float
    pause_count: int
    pause_variance: float      # NEW: std-dev of pause durations (seconds)
    silence_ratio: float
    filler_count: int
    filler_ratio: float
    correction_count: int      # NEW
    correction_rate: float     # NEW
    word_count: int
    duration_seconds: float
    behavior_score: float
    # Acoustic (populated only when audio_bytes provided)
    pitch_variance: float      # NEW
    energy_variance: float     # NEW


# ---------------------------------------------------------------------------
# Acoustic features (requires audio bytes)
# ---------------------------------------------------------------------------

def extract_acoustic_features(audio_bytes: bytes) -> dict:
    """
    Compute pitch and energy variance from raw audio bytes using librosa.
    Safe to call — returns zeros if librosa is unavailable or audio is corrupt.

    Returns:
        {"pitch_variance": float, "energy_variance": float}
    """
    try:
        import librosa
        y, sr = librosa.load(io.BytesIO(audio_bytes), sr=16000, mono=True)

        # Pitch (fundamental frequency) using YIN algorithm
        f0 = librosa.yin(y, fmin=60, fmax=400, sr=sr)
        f0_voiced = f0[f0 > 0]
        pitch_variance = float(np.std(f0_voiced)) if len(f0_voiced) > 10 else 0.0

        # Energy (RMS)
        rms = librosa.feature.rms(y=y)[0]
        energy_variance = float(np.std(rms))

        return {
            "pitch_variance":  round(pitch_variance, 4),
            "energy_variance": round(energy_variance, 6),
        }
    except ImportError:
        logger.debug("librosa not installed — skipping acoustic feature extraction")
        return {"pitch_variance": 0.0, "energy_variance": 0.0}
    except Exception as exc:
        logger.warning("Acoustic feature extraction failed: %s", exc)
        return {"pitch_variance": 0.0, "energy_variance": 0.0}


# ---------------------------------------------------------------------------
# Main behavioral analysis
# ---------------------------------------------------------------------------

def analyze_behavior(
    transcript: str,
    duration_seconds: float,
    segments: list = None,
    events: list = None,
    audio_bytes: bytes = None,
) -> dict:
    """
    Analyse a transcript for behavioural signals of scripted/memorised delivery.

    Args:
        transcript:       Whisper transcription string.
        duration_seconds: Total audio clip length.
        segments:         Whisper word/segment timestamps (optional).
        events:           Integrity events list (copy/paste, tab switches).
        audio_bytes:      Raw audio bytes for acoustic analysis (optional).

    Returns:
        Dict compatible with SpeechMetrics + acoustic fields.
    """
    if not transcript.strip() or duration_seconds <= 0:
        return _empty_metrics(duration_seconds)

    text_lower = transcript.lower()
    words = re.findall(r"\b\w+\b", text_lower)
    word_count = len(words)

    speech_rate = word_count / duration_seconds if duration_seconds > 0 else 0.0

    # ── Pause analysis from Whisper segments ─────────────────────────────
    pause_durations: list[float] = []
    if segments and len(segments) > 1:
        true_speech_time = sum(seg["end"] - seg["start"] for seg in segments)
        for i in range(1, len(segments)):
            gap = segments[i]["start"] - segments[i - 1]["end"]
            if gap >= 0.4:
                pause_durations.append(gap)
        pause_count = len(pause_durations)
    else:
        true_speech_time = duration_seconds
        # Fallback: count punctuation-derived pauses
        pause_markers = re.findall(r"[,;\.]{1}|\.\.\.", transcript)
        pause_count = len(pause_markers) + sum(
            1 for s in re.split(r"[.!?]+", transcript)
            if len(s.strip().split()) <= 2 and s.strip()
        )

    true_speech_time = max(true_speech_time, 0.1)
    silence_time = max(0.0, duration_seconds - true_speech_time)
    silence_ratio = silence_time / duration_seconds if duration_seconds > 0 else 0.0
    true_speech_rate = word_count / true_speech_time

    # Pause variance (key signal: low variance = unnaturally metronomic)
    pause_variance = float(np.std(pause_durations)) if len(pause_durations) >= 2 else 0.5

    # ── Filler words ──────────────────────────────────────────────────────
    filler_count = sum(
        len(re.findall(r"\b" + re.escape(f) + r"\b", text_lower))
        for f in FILLER_WORDS
    )
    filler_ratio = filler_count / max(word_count, 1)

    # ── Self-corrections ──────────────────────────────────────────────────
    correction_count = sum(text_lower.count(m) for m in CORRECTION_MARKERS)
    correction_rate = correction_count / max(word_count / 50, 1)

    # ── Acoustic features (optional) ─────────────────────────────────────
    acoustic = extract_acoustic_features(audio_bytes) if audio_bytes else {
        "pitch_variance": 0.0, "energy_variance": 0.0
    }
    pitch_variance = acoustic["pitch_variance"]

    # ── Behavior Score (0–1, higher = more scripted) ──────────────────────
    rate_score     = _normalize(true_speech_rate, low=1.5, high=4.0)
    filler_score   = 1.0 - min(filler_ratio * 8.0, 1.0)
    silence_penalty= 1.0 - _normalize(silence_ratio, low=0.05, high=0.25)

    # NEW: Forensic Speech Analysis (Originality Check)
    # Human speech has natural pitch jitter and rhythmic variance.
    # 1. Monotone Detection (Pitch Variance)
    # Threshold < 15.0 is highly suspicious for reading or synthetic voice.
    pitch_monotone_score = 1.0 - _normalize(pitch_variance if pitch_variance > 0 else 30.0, low=5.0, high=25.0)
    
    # 2. Metronomic Rhythm (Pause Variance)
    # Threshold < 0.3 means the pauses are too consistent (likely a teleprompter).
    rhythm_scripted_score = 1.0 - _normalize(pause_variance, low=0.1, high=0.6)

    # Weighted blend (Higher weights for forensic features)
    base_behavior_score = (
        0.15 * rate_score
        + 0.15 * filler_score
        + 0.15 * silence_penalty
        + 0.30 * pitch_monotone_score
        + 0.25 * rhythm_scripted_score
    )

    # ── Integrity penalty from events ─────────────────────────────────────
    integrity_penalty = 0.0
    if events:
        for ev in events:
            ev_type = ev.get("event_type")
            if ev_type in ("copy", "paste"):
                integrity_penalty += 0.20
            elif ev_type in ("tab_switch", "focus_loss"):
                integrity_penalty += 0.10
            elif ev_type == "sys_key_pressed":
                integrity_penalty += 0.05
        integrity_penalty = min(integrity_penalty, 0.50)

    behavior_score = round(min(base_behavior_score + integrity_penalty, 1.0), 4)

    return asdict(SpeechMetrics(
        speech_rate=       round(speech_rate, 3),
        true_speech_rate=  round(true_speech_rate, 3),
        pause_count=       pause_count,
        pause_variance=    round(pause_variance, 4),
        silence_ratio=     round(silence_ratio, 4),
        filler_count=      filler_count,
        filler_ratio=      round(filler_ratio, 4),
        correction_count=  correction_count,
        correction_rate=   round(min(correction_rate, 1.0), 4),
        word_count=        word_count,
        duration_seconds=  round(duration_seconds, 2),
        behavior_score=    behavior_score,
        pitch_variance=    acoustic["pitch_variance"],
        energy_variance=   acoustic["energy_variance"],
    ))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _normalize(value: float, low: float, high: float) -> float:
    """Clamp and normalize a value to [0, 1]."""
    if high == low:
        return 0.0
    return min(max((value - low) / (high - low), 0.0), 1.0)


def _empty_metrics(duration_seconds: float) -> dict:
    return asdict(SpeechMetrics(
        speech_rate=0.0, true_speech_rate=0.0, pause_count=0,
        pause_variance=0.5, silence_ratio=0.0, filler_count=0,
        filler_ratio=0.0, correction_count=0, correction_rate=0.0,
        word_count=0, duration_seconds=duration_seconds,
        behavior_score=0.0, pitch_variance=0.0, energy_variance=0.0,
    ))
