"""
embeddings.py — Semantic similarity module using sentence-transformers.
Uses all-MiniLM-L6-v2 for fast, high-quality sentence embeddings.
"""

import re
import logging
from functools import lru_cache
from typing import Optional

import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.metrics.pairwise import cosine_similarity

# We will now load the bank dynamically from Supabase
_CURRENT_BANK = []

logger = logging.getLogger(__name__)

MODEL_NAME = "all-MiniLM-L6-v2"


@lru_cache(maxsize=1)
def _get_model() -> SentenceTransformer:
    """Load and cache the sentence transformer model (singleton)."""
    logger.info("Loading sentence transformer model: %s", MODEL_NAME)
    return SentenceTransformer(MODEL_NAME)


@lru_cache(maxsize=1)
def _get_answer_embeddings():
    """Pre-compute embeddings for the current bank."""
    if not _CURRENT_BANK:
        logger.warning("Embeddings requested but bank is empty. Call sync_bank_db() first.")
        return np.array([])
    model = _get_model()
    texts = [entry["answer"] for entry in _CURRENT_BANK]
    logger.info("Pre-computing embeddings for %d reference answers from cloud bank.", len(texts))
    return model.encode(texts, normalize_embeddings=True)

async def sync_bank_db():
    """Fetch the latest question bank from Supabase and refresh embeddings."""
    global _CURRENT_BANK
    from supabase_client import get_questions_db
    _CURRENT_BANK = await get_questions_db()
    _get_answer_embeddings.cache_clear()
    _get_answer_embeddings()
    logger.info("Question bank synced and embeddings refreshed.")



def compute_similarity(transcript: str) -> dict:
    """
    Compare a transcript against the reference answer bank using
    cosine similarity on sentence embeddings.

    Args:
        transcript: The candidate's transcribed response.

    Returns:
        {
            "semantic_similarity": float,     # 0–1
            "matched_question": str,
            "matched_answer": str,
            "matched_phrases": list[str],
            "all_scores": list[dict],
        }
    """
    if not transcript or not transcript.strip():
        return _empty_result()

    model = _get_model()
    answer_embeddings = _get_answer_embeddings()

    # Encode transcript
    transcript_embedding = model.encode(
        [transcript.strip()], normalize_embeddings=True
    )

    # Cosine similarity against all reference answers
    similarities = cosine_similarity(transcript_embedding, answer_embeddings)[0]

    best_idx = int(np.argmax(similarities))
    best_score = float(similarities[best_idx])

    all_scores = [
        {
            "question": _CURRENT_BANK[i]["question"],
            "score": round(float(similarities[i]), 4),
            "category": _CURRENT_BANK[i].get("category", "technical"),
        }
        for i in range(len(_CURRENT_BANK))
    ]
    all_scores.sort(key=lambda x: x["score"], reverse=True)

    matched_entry = _CURRENT_BANK[best_idx]
    matched_phrases = _extract_matched_phrases(transcript, matched_entry["answer"])

    return {
        "semantic_similarity": round(best_score, 4),
        "matched_question": matched_entry["question"],
        "matched_answer": matched_entry["answer"],
        "matched_phrases": matched_phrases,
        "all_scores": all_scores[:5],  # top 5
    }


def _extract_matched_phrases(transcript: str, reference: str, min_words: int = 3) -> list[str]:
    """
    Find overlapping n-gram phrases between transcript and reference answer.
    Returns a list of matched phrase strings.
    """
    def ngrams(text: str, n: int) -> set[str]:
        tokens = re.findall(r"\b\w+\b", text.lower())
        return {" ".join(tokens[i : i + n]) for i in range(len(tokens) - n + 1)}

    matched = []
    for n in range(6, min_words - 1, -1):  # try 6-grams down to 3-grams
        t_grams = ngrams(transcript, n)
        r_grams = ngrams(reference, n)
        overlaps = t_grams & r_grams
        for phrase in sorted(overlaps):
            # Avoid sub-phrase duplicates
            if not any(phrase in existing for existing in matched):
                matched.append(phrase)

    return matched[:10]  # limit output


def _empty_result() -> dict:
    return {
        "semantic_similarity": 0.0,
        "matched_question": "",
        "matched_answer": "",
        "matched_phrases": [],
        "all_scores": [],
    }
