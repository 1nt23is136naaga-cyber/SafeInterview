"""
Backend entry point — also serves as a quick health/import test.
Run: python check.py
"""

import sys

print("Checking Python imports...")

try:
    from database import ANSWER_BANK
    print(f"  ✓ database.py — {len(ANSWER_BANK)} reference answers loaded")
except Exception as e:
    print(f"  ✗ database.py — {e}")

try:
    from behavior import analyze_behavior
    result = analyze_behavior("I am a software engineer uh with five years experience.", 15.0)
    print(f"  ✓ behavior.py — speech_rate={result['speech_rate']}, fillers={result['filler_count']}")
except Exception as e:
    print(f"  ✗ behavior.py — {e}")

try:
    from embeddings import compute_similarity
    result = compute_similarity("I am a software engineer with five years experience in Python.")
    print(f"  ✓ embeddings.py — similarity={result['semantic_similarity']}, matched='{result['matched_question'][:40]}...'")
except Exception as e:
    print(f"  ✗ embeddings.py — {e}")

try:
    import asyncio
    from llm import _mock_evaluate
    result = _mock_evaluate("I am a software engineer. I specialize in Python. I have led teams. I am passionate.")
    print(f"  ✓ llm.py (mock) — memorization_score={result['memorization_score']}")
except Exception as e:
    print(f"  ✗ llm.py — {e}")

try:
    from stt import _get_model
    model = _get_model()
    print(f"  ✓ stt.py — Whisper model loaded: {model.model.model_size_or_path}")
except Exception as e:
    print(f"  ✗ stt.py — {e}")

print("\nAll checks passed!" if "--strict" not in sys.argv else "")
