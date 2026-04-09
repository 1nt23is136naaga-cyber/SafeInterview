"""
stt.py — Speech-to-Text module using faster-whisper.
Provides a singleton model with thread-safe transcription.
"""

import os
import logging
import tempfile
import threading
from functools import lru_cache
from pathlib import Path

logger = logging.getLogger(__name__)

_model_lock = threading.Lock()
_model_instance = None


def _get_model():
    """Lazy-load and cache the faster-whisper model (thread-safe singleton)."""
    global _model_instance
    if _model_instance is None:
        with _model_lock:
            if _model_instance is None:
                from faster_whisper import WhisperModel
                model_size = os.getenv("WHISPER_MODEL_SIZE", "base")
                logger.info("Loading faster-whisper model: %s", model_size)
                # Use int8 quantization for CPU speed
                _model_instance = WhisperModel(
                    model_size,
                    device="cpu",
                    compute_type="int8",
                )
                logger.info("faster-whisper model loaded.")
    return _model_instance


def transcribe_bytes(audio_bytes: bytes, language: str | None = None) -> dict:
    """
    Transcribe raw audio bytes (webm, wav, mp3, etc.) using faster-whisper.

    Args:
        audio_bytes: Raw audio file content.
        language: Optional ISO 639-1 language code (e.g., 'en'). Auto-detected if None.

    Returns:
        {
            "transcript": str,
            "language": str,
            "duration": float,
        }
    """
    if not audio_bytes:
        return {"transcript": "", "language": "en", "duration": 0.0}

    model = _get_model()

    # Write to a temp file (faster-whisper needs a file path)
    suffix = _detect_suffix(audio_bytes)
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        segments, info = model.transcribe(
            tmp_path,
            language=language,
            beam_size=5,
            vad_filter=True,              # skip silence
            vad_parameters=dict(
                min_silence_duration_ms=300,
            ),
        )

        words = []
        segment_list = []
        for segment in segments:
            words.append(segment.text.strip())
            segment_list.append({
                "start": segment.start,
                "end": segment.end,
                "text": segment.text.strip()
            })

        transcript = " ".join(words).strip()
        duration = info.duration if info.duration else 0.0

        return {
            "transcript": transcript,
            "language": info.language,
            "duration": round(duration, 2),
            "segments": segment_list,
        }
    finally:
        try:
            Path(tmp_path).unlink(missing_ok=True)
        except Exception:
            pass


def _detect_suffix(audio_bytes: bytes) -> str:
    """Guess audio file extension from magic bytes."""
    if audio_bytes[:4] == b"RIFF":
        return ".wav"
    if audio_bytes[:3] == b"ID3" or audio_bytes[:2] == b"\xff\xfb":
        return ".mp3"
    if audio_bytes[:4] == b"fLaC":
        return ".flac"
    # Default to webm (MediaRecorder output)
    return ".webm"
