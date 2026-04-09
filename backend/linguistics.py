"""
linguistics.py — Linguistic feature extractor for VeritasAI.

Extracts 5 NLP-based signals from a transcript:
  - structure_rigidity    (formal structure markers like "firstly", "in conclusion")
  - lexical_richness      (type-token ratio — high = unusually rich = AI-polished)
  - personalization_score (first-person anecdotes, specific numbers → genuine)
  - semantic_drift        (std-dev of inter-sentence cosine similarity → low = scripted)
  - linearity_score       (inverse of drift — high = perfectly linear = scripted)
"""

import re
import logging
from functools import lru_cache

import numpy as np

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

STRUCTURE_MARKERS = [
    "firstly", "secondly", "thirdly", "fourthly", "lastly", "finally",
    "in conclusion", "to summarize", "in summary", "to conclude",
    "on the other hand", "furthermore", "additionally", "moreover",
    "therefore", "thus", "hence", "consequently", "as a result",
    "in addition", "for instance", "for example", "to illustrate",
    "in contrast", "however", "nevertheless", "nonetheless",
    "having said that", "that being said", "to be more specific",
]

FIRST_PERSON_TOKENS = {
    "i", "my", "mine", "myself", "me", "we", "our", "ours", "ourselves",
}

# Number / date patterns that signal real personal examples
PERSONAL_DETAIL_PATTERN = re.compile(
    r"\b(\d{4}|\d+\s?(year|month|week|day|hour|project|team|client|company)s?|"
    r"january|february|march|april|may|june|july|august|september|october|november|december)\b",
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _tokenize(text: str) -> list[str]:
    return [t.lower() for t in re.findall(r"\b[a-zA-Z']+\b", text)]


def _split_sentences(text: str) -> list[str]:
    raw = re.split(r"(?<=[.!?])\s+", text.strip())
    return [s.strip() for s in raw if len(s.strip()) > 8]


# ---------------------------------------------------------------------------
# Feature extraction
# ---------------------------------------------------------------------------

def extract_linguistic_features(transcript: str, embedding_model=None) -> dict:
    """
    Compute all 5 linguistic signals from a transcript string.

    Args:
        transcript:      The candidate's full response text.
        embedding_model: Optional SentenceTransformer instance for semantic drift.
                         If None, semantic drift is skipped (set to 0.5 / neutral).

    Returns dict with keys:
        structure_rigidity, lexical_richness, personalization_score,
        semantic_drift, linearity_score
    """
    if not transcript or not transcript.strip():
        return _empty_linguistic()

    sentences = _split_sentences(transcript)
    words = _tokenize(transcript)
    word_count = len(words)

    if word_count == 0:
        return _empty_linguistic()

    # ── Signal 1: Structure Rigidity ──────────────────────────────────────
    text_lower = transcript.lower()
    marker_hits = sum(1 for m in STRUCTURE_MARKERS if m in text_lower)
    # Normalize by sentence count (avoid punishing long answers)
    structure_rigidity = min(marker_hits / max(len(sentences), 1), 1.0)

    # ── Signal 2: Lexical Richness (Type-Token Ratio) ─────────────────────
    # Values > 0.85 on short texts saturate — use log-adjusted version
    unique_words = len(set(words))
    # Guiraud's Root TTR (more stable than raw TTR for variable lengths)
    lexical_richness = unique_words / (word_count ** 0.5) if word_count > 0 else 0.0
    # Normalize to 0-1: empirically, 5–12 is natural range; >12 = AI-polished
    lexical_richness_norm = min(lexical_richness / 12.0, 1.0)

    # ── Signal 3: Personalization Score ───────────────────────────────────
    first_person_count = sum(1 for w in words if w in FIRST_PERSON_TOKENS)
    personal_detail_count = len(PERSONAL_DETAIL_PATTERN.findall(transcript))
    # Combine: first-person density + specific detail count
    fp_density = min(first_person_count / max(word_count / 20, 1), 1.0)
    detail_score = min(personal_detail_count / 3.0, 1.0)
    personalization_score = round((0.6 * fp_density + 0.4 * detail_score), 4)

    # ── Signal 4 & 5: Semantic Drift + Linearity ──────────────────────────
    semantic_drift = 0.35      # neutral default (no model)
    linearity_score = 0.65

    if embedding_model is not None and len(sentences) >= 3:
        try:
            embeds = embedding_model.encode(sentences, normalize_embeddings=True)
            inter_sims = [
                float(np.dot(embeds[i], embeds[i + 1]))
                for i in range(len(embeds) - 1)
            ]
            semantic_drift = float(np.std(inter_sims))
            # Low variance = eerily consistent = scripted → high linearity score
            linearity_score = 1.0 - min(semantic_drift * 5.0, 1.0)
        except Exception as exc:
            logger.warning("Semantic drift computation failed: %s", exc)

    # ── Redundancy Proxy ──────────────────────────────────────────────────
    # Check repeated noun phrases (simple 3-gram repetition)
    three_grams = [" ".join(words[i : i + 3]) for i in range(len(words) - 2)]
    if three_grams:
        from collections import Counter
        gram_counts = Counter(three_grams)
        repeated = sum(c - 1 for c in gram_counts.values() if c > 1)
        redundancy_ratio = min(repeated / max(len(three_grams), 1) * 10, 1.0)
    else:
        redundancy_ratio = 0.0

    return {
        "structure_rigidity":   round(structure_rigidity, 4),
        "lexical_richness":     round(lexical_richness_norm, 4),
        "personalization_score": personalization_score,
        "semantic_drift":       round(semantic_drift, 4),
        "linearity_score":      round(linearity_score, 4),
        "redundancy_ratio":     round(redundancy_ratio, 4),
        "sentence_count":       len(sentences),
        "word_count":           word_count,
    }


def _empty_linguistic() -> dict:
    return {
        "structure_rigidity":    0.0,
        "lexical_richness":      0.0,
        "personalization_score": 0.0,
        "semantic_drift":        0.5,
        "linearity_score":       0.5,
        "redundancy_ratio":      0.0,
        "sentence_count":        0,
        "word_count":            0,
    }
