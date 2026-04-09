"""
llm.py — LLM-based answer evaluation module.
Uses OpenAI (gpt-3.5-turbo) to detect memorization/scripting.
Falls back to a heuristic mock when no API key is configured.
"""

import os
import logging
import re

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are an expert interview analyst specializing in detecting scripted or memorized responses.
You will receive a candidate's interview answer and must assess how scripted or memorized it sounds.
Consider: unnaturally smooth delivery cues in text, overly formal structure, absence of hesitation markers,
perfect grammar, suspiciously complete sentences, or textbook-style phrasing.
Respond ONLY with valid JSON in this exact format:
{"memorization_score": <float 0.0–1.0>, "explanation": "<one or two sentences>"}
- 0.0 = clearly spontaneous, natural
- 1.0 = clearly scripted / memorized verbatim"""

USER_PROMPT_TEMPLATE = """Evaluate this interview answer:

\"\"\"{transcript}\"\"\"

Question context (if matched): {question}

Return ONLY valid JSON."""


async def evaluate_response(transcript: str, matched_question: str = "") -> dict:
    """
    Use an LLM to score how memorized/scripted the response sounds.

    Returns:
        {"memorization_score": float, "explanation": str}
    """
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        logger.warning("OPENAI_API_KEY not set — using heuristic mock evaluation.")
        return _mock_evaluate(transcript)

    try:
        return await _openai_evaluate(transcript, matched_question, api_key)
    except Exception as exc:
        logger.error("LLM evaluation failed: %s — falling back to mock.", exc)
        return _mock_evaluate(transcript)


async def _openai_evaluate(transcript: str, matched_question: str, api_key: str) -> dict:
    from openai import AsyncOpenAI

    model = os.getenv("OPENAI_MODEL", "gpt-3.5-turbo")
    client = AsyncOpenAI(api_key=api_key)

    user_prompt = USER_PROMPT_TEMPLATE.format(
        transcript=transcript[:1500],  # token budget
        question=matched_question or "unknown",
    )

    response = await client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.2,
        max_tokens=200,
    )

    raw = response.choices[0].message.content.strip()
    return _parse_llm_response(raw)


def _parse_llm_response(raw: str) -> dict:
    """Parse and validate LLM JSON output."""
    try:
        import json
        # Extract JSON even if surrounded by markdown fences
        match = re.search(r"\{.*\}", raw, re.DOTALL)
        if match:
            data = json.loads(match.group())
            score = float(data.get("memorization_score", 0.5))
            explanation = str(data.get("explanation", "No explanation provided."))
            return {
                "memorization_score": round(max(0.0, min(1.0, score)), 4),
                "explanation": explanation,
            }
    except Exception as exc:
        logger.error("Failed to parse LLM response: %s | raw=%s", exc, raw)
    return {"memorization_score": 0.5, "explanation": "Could not parse LLM response."}


def _mock_evaluate(transcript: str) -> dict:
    """
    Heuristic-based mock evaluation when no LLM is available.
    Scores based on text signals of scripted delivery.
    """
    if not transcript.strip():
        return {"memorization_score": 0.0, "explanation": "Empty transcript."}

    words = transcript.split()
    word_count = len(words)

    # Signal 1: Perfect capitalization + punctuation = scripted
    sentences = re.split(r"[.!?]", transcript)
    well_formed = sum(
        1 for s in sentences if s.strip() and s.strip()[0].isupper()
    )
    structure_score = well_formed / max(len(sentences), 1)

    # Signal 2: Absence of fillers
    filler_pattern = r"\b(uh|um|like|you know|basically|i mean|kind of)\b"
    filler_count = len(re.findall(filler_pattern, transcript.lower()))
    filler_absence_score = 1.0 - min(filler_count / max(word_count * 0.05, 1), 1.0)

    # Signal 3: Unusually long, complete answer
    length_score = min(word_count / 150, 1.0)

    # Signal 4: Avg sentence length (very long sentences = scripted)
    avg_sent_len = word_count / max(len(sentences), 1)
    sentence_score = min(avg_sent_len / 30, 1.0)

    score = (
        0.35 * structure_score
        + 0.35 * filler_absence_score
        + 0.15 * length_score
        + 0.15 * sentence_score
    )
    score = round(max(0.0, min(1.0, score)), 4)

    if score > 0.7:
        explanation = "The response appears highly structured with perfect grammar and no hesitation markers — typical of a memorized answer."
    elif score > 0.4:
        explanation = "The response shows some signs of preparation but also natural elements. Could be a well-practiced answer."
    else:
        explanation = "The response contains natural hesitation and informal language, suggesting a spontaneous, genuine reply."

    return {"memorization_score": score, "explanation": explanation}
