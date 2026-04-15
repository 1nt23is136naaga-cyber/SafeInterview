"""
stt.py — Speech-to-Text using OpenAI Whisper API (whisper-1 model).

Primary engine: OpenAI Whisper API (cloud, highest accuracy).
Features:
  - Handles Indian accents well (Whisper is trained on diverse speech)
  - Auto-removes most filler words via post-processing
  - Returns segments/timestamps via verbose_json response format
  - File chunking for audio > 24 MB
  - Thread-safe for use with FastAPI's run_in_executor

Internal usage (called by /analyze WebSocket pipeline):
  transcribe_bytes(audio_bytes, language=None) -> dict

Public endpoint usage (called by /transcribe):
  transcribe_upload(audio_bytes, filename, language=None) -> dict
"""

import io
import os
import re
import logging
import tempfile
import threading
from pathlib import Path

logger = logging.getLogger(__name__)

# ── Constants ──────────────────────────────────────────────────────────────────

WHISPER_MODEL    = "whisper-1"
MAX_BYTES        = 24 * 1024 * 1024   # 24 MB (OpenAI limit is 25 MB; leave headroom)
CHUNK_DURATION_S = 600                # 10-minute chunks for long audio

# Filler words / disfluencies to strip from final transcript.
# Whisper already suppresses many, but these catch stragglers.
_FILLER_PATTERN = re.compile(
    r"\b(uh+|um+|hmm+|mhm+|erm+|uhh+|umm+|ahh?|err+|like,? you know|you know,?|"
    r"i mean,?|basically,?|literally,?|right\?|okay so|so yeah|yeah so)\b[,.]?",
    re.IGNORECASE,
)

_MULTI_SPACE = re.compile(r"  +")

# ── OpenAI client (lazy singleton) ────────────────────────────────────────────

_client_lock     = threading.Lock()
_openai_client   = None


def _get_client():
    """Return a cached openai.OpenAI client. Raises if key is missing."""
    global _openai_client
    if _openai_client is None:
        with _client_lock:
            if _openai_client is None:
                from openai import OpenAI
                api_key = os.getenv("OPENAI_API_KEY", "").strip()
                if not api_key:
                    raise RuntimeError(
                        "OPENAI_API_KEY is not set. "
                        "Add it to your .env or environment variables."
                    )
                _openai_client = OpenAI(api_key=api_key)
                logger.info("OpenAI client initialised (Whisper API).")
    return _openai_client


# ── Text post-processing ──────────────────────────────────────────────────────

def _clean_transcript(text: str) -> str:
    """
    Remove filler words, fix spacing, ensure proper sentence capitalisation.
    Whisper already handles punctuation well; this is a lightweight pass.
    """
    if not text:
        return ""

    # Strip filler words
    text = _FILLER_PATTERN.sub("", text)

    # Collapse multiple spaces
    text = _MULTI_SPACE.sub(" ", text).strip()

    # Capitalise first letter after sentence-ending punctuation
    text = re.sub(
        r"([.!?]\s+)([a-z])",
        lambda m: m.group(1) + m.group(2).upper(),
        text,
    )

    # Capitalise the very first character
    if text:
        text = text[0].upper() + text[1:]

    return text


# ── Core transcription ────────────────────────────────────────────────────────

def _transcribe_file_obj(file_obj, filename: str = "audio.webm", language: str | None = None) -> dict:
    """
    Call OpenAI Whisper API on an in-memory file object.
    Returns raw API response as a dict.
    """
    client = _get_client()

    kwargs = {
        "model":           WHISPER_MODEL,
        "file":            file_obj,
        "response_format": "verbose_json",  # gives segments + language + duration
        "temperature":     0.0,             # deterministic output
        "timestamp_granularities": ["segment"],
    }
    if language:
        kwargs["language"] = language

    logger.info("Calling OpenAI Whisper API (model=%s, file=%s)…", WHISPER_MODEL, filename)
    result = client.audio.transcriptions.create(**kwargs)
    return result


def _build_response(api_result) -> dict:
    """
    Normalise OpenAI Whisper verbose_json response into our standard schema:
    {
        "transcript":  str,
        "language":    str,
        "duration":    float,
        "confidence":  float | None,   # avg log-prob if available
        "segments":    list[dict],      # [{start, end, text}]
        "timestamps":  list[dict],      # alias of segments (per output spec)
    }
    """
    raw_text    = getattr(api_result, "text", "") or ""
    language    = getattr(api_result, "language", "en") or "en"
    duration    = getattr(api_result, "duration", 0.0) or 0.0
    raw_segs    = getattr(api_result, "segments", None) or []

    # Build clean segment list
    segments = []
    avg_logprob_total = 0.0
    for seg in raw_segs:
        seg_text  = getattr(seg, "text", "") or ""
        cleaned   = _clean_transcript(seg_text)
        avg_lp    = getattr(seg, "avg_logprob", None)
        if avg_lp is not None:
            avg_logprob_total += avg_lp
        segments.append({
            "start": round(getattr(seg, "start", 0.0), 2),
            "end":   round(getattr(seg, "end",   0.0), 2),
            "text":  cleaned,
        })

    # Confidence: convert avg log-prob → 0–1 probability (approximate)
    confidence = None
    if raw_segs:
        mean_lp    = avg_logprob_total / len(raw_segs)
        import math
        confidence = round(min(1.0, math.exp(mean_lp)), 4)

    # Clean full transcript (re-join from cleaned segments if available)
    if segments:
        clean_text = " ".join(s["text"] for s in segments if s["text"]).strip()
    else:
        clean_text = _clean_transcript(raw_text)

    return {
        "transcript": clean_text,
        "language":   language,
        "duration":   round(float(duration), 2),
        "confidence": confidence,
        "segments":   segments,
        "timestamps": segments,   # alias — same data, named per output spec
    }


# ── Public API ────────────────────────────────────────────────────────────────

def transcribe_bytes(audio_bytes: bytes, language: str | None = None) -> dict:
    """
    Transcribe raw audio bytes via OpenAI Whisper API.
    Used internally by the /analyze and WebSocket pipelines.

    Args:
        audio_bytes: Raw audio bytes (webm/wav/mp3/m4a/flac).
        language: Optional ISO 639-1 code, e.g. 'en'. Auto-detected if None.

    Returns:
        Standard transcription dict (see _build_response).
    """
    if not audio_bytes:
        return {
            "transcript": "", "language": "en", "duration": 0.0,
            "confidence": None, "segments": [], "timestamps": [],
        }

    suffix   = _detect_suffix(audio_bytes)
    filename = f"audio{suffix}"

    # If file is small enough, send directly
    if len(audio_bytes) <= MAX_BYTES:
        file_obj = io.BytesIO(audio_bytes)
        file_obj.name = filename
        result = _transcribe_file_obj(file_obj, filename=filename, language=language)
        return _build_response(result)

    # Chunked path for large files
    logger.info("Audio > 24 MB — chunking before upload (%d bytes).", len(audio_bytes))
    return _transcribe_chunked(audio_bytes, suffix=suffix, language=language)


def transcribe_upload(audio_bytes: bytes, original_filename: str = "audio.webm",
                      language: str | None = None) -> dict:
    """
    Transcribe an uploaded audio file.
    Identical to transcribe_bytes but preserves the original filename for
    better MIME-type inference on the API side.
    """
    if not audio_bytes:
        return {
            "transcript": "", "language": "en", "duration": 0.0,
            "confidence": None, "segments": [], "timestamps": [],
        }

    if len(audio_bytes) <= MAX_BYTES:
        file_obj = io.BytesIO(audio_bytes)
        file_obj.name = original_filename
        result = _transcribe_file_obj(file_obj, filename=original_filename, language=language)
        return _build_response(result)

    suffix = Path(original_filename).suffix or _detect_suffix(audio_bytes)
    logger.info("Large upload — chunking (%d bytes).", len(audio_bytes))
    return _transcribe_chunked(audio_bytes, suffix=suffix, language=language)


# ── Chunking (for audio > 24 MB) ─────────────────────────────────────────────

def _transcribe_chunked(audio_bytes: bytes, suffix: str = ".webm",
                        language: str | None = None) -> dict:
    """
    Split large audio into ~10-min chunks using pydub (if available) or
    a simple byte-split fallback, transcribe each, then merge results.
    """
    try:
        from pydub import AudioSegment  # optional dependency
        return _pydub_chunk_transcribe(audio_bytes, suffix, language)
    except ImportError:
        logger.warning("pydub not installed — using byte-split chunking (less accurate).")
        return _byte_split_transcribe(audio_bytes, suffix, language)


def _pydub_chunk_transcribe(audio_bytes: bytes, suffix: str,
                             language: str | None) -> dict:
    """Chunk via pydub (accurate silence-aware splits)."""
    from pydub import AudioSegment
    import io as _io

    seg    = AudioSegment.from_file(_io.BytesIO(audio_bytes), format=suffix.lstrip("."))
    chunk_ms = CHUNK_DURATION_S * 1000
    chunks = [seg[i: i + chunk_ms] for i in range(0, len(seg), chunk_ms)]

    all_segments: list[dict] = []
    full_texts:   list[str]  = []
    offset = 0.0

    for idx, chunk in enumerate(chunks):
        buf = _io.BytesIO()
        chunk.export(buf, format="mp3")   # mp3 is compact + universally supported
        buf.seek(0)
        buf.name = f"chunk_{idx}.mp3"

        logger.info("Transcribing chunk %d/%d…", idx + 1, len(chunks))
        result  = _transcribe_file_obj(buf, filename=buf.name, language=language)
        partial = _build_response(result)

        full_texts.append(partial["transcript"])
        for s in partial["segments"]:
            all_segments.append({
                "start": round(s["start"] + offset, 2),
                "end":   round(s["end"]   + offset, 2),
                "text":  s["text"],
            })
        offset += chunk.duration_seconds

    return {
        "transcript": " ".join(full_texts).strip(),
        "language":   "en",
        "duration":   round(offset, 2),
        "confidence": None,   # merged chunks — confidence not meaningful
        "segments":   all_segments,
        "timestamps": all_segments,
    }


def _byte_split_transcribe(audio_bytes: bytes, suffix: str,
                            language: str | None) -> dict:
    """Naive byte-split fallback when pydub is unavailable."""
    n_chunks = (len(audio_bytes) + MAX_BYTES - 1) // MAX_BYTES
    chunk_size = MAX_BYTES
    all_texts: list[str] = []

    for i in range(n_chunks):
        chunk  = audio_bytes[i * chunk_size: (i + 1) * chunk_size]
        buf    = io.BytesIO(chunk)
        buf.name = f"chunk_{i}{suffix}"
        result = _transcribe_file_obj(buf, filename=buf.name, language=language)
        partial = _build_response(result)
        all_texts.append(partial["transcript"])

    return {
        "transcript": " ".join(all_texts).strip(),
        "language":   "en",
        "duration":   0.0,
        "confidence": None,
        "segments":   [],
        "timestamps": [],
    }


# ── Utility ───────────────────────────────────────────────────────────────────

def _detect_suffix(audio_bytes: bytes) -> str:
    """Guess file extension from magic bytes."""
    if audio_bytes[:4] == b"RIFF":
        return ".wav"
    if audio_bytes[:3] == b"ID3" or audio_bytes[:2] == b"\xff\xfb":
        return ".mp3"
    if audio_bytes[:4] == b"fLaC":
        return ".flac"
    if audio_bytes[4:8] in (b"ftyp", b"moov"):
        return ".m4a"
    return ".webm"   # MediaRecorder default
