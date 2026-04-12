"""
main.py — FastAPI application entry point (VeritasAI v2).

Routes:
  GET  /health              → Health check
  POST /analyze             → Full analysis of uploaded audio (multipart)
  POST /baseline            → Analyse an intro-phase answer and store baseline
  GET  /baseline/{session}  → Retrieve baseline profile for a session
  POST /upload-resume       → Parse PDF resume + generate questions
  POST /verify-resume-answer→ Score resume-based verbal answer
  POST /upload-video        → Accept and store screen recording chunk
  WS   /ws                  → Real-time streaming: audio + events → live scores

Privacy changes (v2):
  - Keyboard content is no longer stored or processed.
  - Eye metrics are received as anonymised feature summaries only (no raw video).
  - Consent timestamp is logged per session.
"""

import asyncio
import json
import logging
import os
import shutil
import uuid
from contextlib import asynccontextmanager
from dataclasses import asdict

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

load_dotenv()
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# In-memory baseline store: session_id → BaselineProfile dict
_baseline_store: dict[str, dict] = {}

# In-memory eye baseline store: session_id → EyeMetricsSummary dict
_eye_baseline_store: dict[str, dict] = {}

# In-memory HR session store: session_id → session metadata + results
_hr_sessions: dict[str, dict] = {}

# In-memory video room store: session_id → {role: WebSocket}
_video_rooms: dict[str, dict[str, "WebSocket"]] = {}

# ── Persistent session storage ───────────────────────────────────────────
SESSIONS_FILE = os.path.join(os.path.dirname(__file__), "sessions.json")

from supabase_client import save_session_db, load_sessions_db

async def _load_sessions_async():
    """Load persisted sessions from Supabase into memory."""
    global _hr_sessions
    db_sessions = await load_sessions_db()
    if db_sessions:
        _hr_sessions.update(db_sessions)
        logger.info("Loaded %d sessions from Supabase.", len(db_sessions))
    else:
        # Fallback to local file if it exists and DB failed/is empty
        if os.path.exists(SESSIONS_FILE):
            try:
                with open(SESSIONS_FILE, "r", encoding="utf-8") as f:
                    local_data = json.load(f)
                    _hr_sessions.update(local_data)
                logger.info("Loaded %d sessions from local sessions.json fallback.", len(local_data))
            except Exception as e:
                logger.warning("Could not load local fallback: %s", e)

async def _save_session_async(session_id: str):
    """Persist a single session to Supabase."""
    if session_id in _hr_sessions:
        await save_session_db(session_id, _hr_sessions[session_id])
    
    # Also keep local backup for safety
    try:
        with open(SESSIONS_FILE, "w", encoding="utf-8") as f:
            json.dump(_hr_sessions, f, indent=2, default=str)
    except Exception:
        pass



# ---------------------------------------------------------------------------
# Lifespan: warm up models on startup
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Load persisted sessions before warming models
    await _load_sessions_async()
    
    logger.info("Warming up models & syncing cloud bank…")
    
    # 1. Sync question bank from Supabase
    from embeddings import sync_bank_db
    try:
        await sync_bank_db()
    except Exception as e:
        logger.error(f"Initial cloud bank sync failed: {e}")

    # 2. Warm up other models
    loop = asyncio.get_event_loop()
    await asyncio.gather(
        loop.run_in_executor(None, _warm_stt),
        loop.run_in_executor(None, _warm_embeddings),
    )
    logger.info("All models ready.")
    yield


def _warm_stt():
    from stt import _get_model as get_whisper
    get_whisper()


def _warm_embeddings():
    from embeddings import _get_model, _get_answer_embeddings
    _get_model()
    _get_answer_embeddings()


# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(
    title="VeritasAI — AI Interview Evaluation Platform",
    version="2.0.0",
    lifespan=lifespan,
)

# CORS — restricted in local mode, configured in production via env 
_public_mode = os.getenv("PUBLIC_MODE", "false").lower() == "true"
_cors_origins = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
origins = ["*"] if _public_mode else [o.strip() for o in _cors_origins.split(",")]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

os.makedirs("uploads", exist_ok=True)
app.mount("/uploads", StaticFiles(directory="uploads"), name="uploads")

# Path to the Vite production build
_dist = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")


# ---------------------------------------------------------------------------
# Pydantic request/response models
# ---------------------------------------------------------------------------

class AnalyzeRequest(BaseModel):
    session_id: str = ""


class BaselineRequest(BaseModel):
    session_id: str
    audio_base64: str = ""
    question_index: int = 0
    text_input: str = None
    is_text_mode: bool = False


class BaselineResponse(BaseModel):
    session_id: str
    sample_count: int
    status: str



# ---------------------------------------------------------------------------
# Core analysis pipeline
# ---------------------------------------------------------------------------

async def _full_analysis(
    audio_bytes: bytes,
    duration: float | None = None,
    events: list = None,
    session_id: str = "",
) -> dict:
    """
    Full multimodal pipeline: STT → semantics → LLM → behavior →
    linguistics → eye → baseline delta → risk report.
    """
    from stt import transcribe_bytes
    from embeddings import compute_similarity
    from behavior import analyze_behavior
    from llm import evaluate_response
    from linguistics import extract_linguistic_features
    from baseline import compute_baseline_delta, BaselineProfile, BaselineDelta
    from embeddings import _get_model as get_embed_model

    if events is None:
        events = []

    loop = asyncio.get_event_loop()

    # 1 ── Transcribe
    stt_result = await loop.run_in_executor(None, transcribe_bytes, audio_bytes)
    transcript = stt_result["transcript"]
    audio_duration = duration or stt_result.get("duration", 30.0)

    if not transcript.strip():
        raise ValueError("Could not transcribe audio. Please check audio quality.")

    # 2 ── Semantic similarity
    sim_result = await loop.run_in_executor(None, compute_similarity, transcript)

    # 3 ── LLM evaluation
    llm_result = await evaluate_response(transcript, sim_result["matched_question"])

    # 4 ── Behavioral analysis
    behavior_result = await loop.run_in_executor(
        None,
        analyze_behavior,
        transcript,
        audio_duration,
        stt_result.get("segments"),
        events,
        audio_bytes,
    )

    # 5 ── Linguistic features
    embed_model = await loop.run_in_executor(None, get_embed_model)
    linguistic_features = await loop.run_in_executor(
        None, extract_linguistic_features, transcript, embed_model
    )

    # 7 ── Baseline delta
    baseline_delta: dict = {"has_baseline": False, "baseline_anomaly_score": 0.0}
    if session_id and session_id in _baseline_store:
        stored = _baseline_store[session_id]
        bp = BaselineProfile(**stored)
        from baseline import compute_baseline_delta as cbd
        delta_obj = cbd(bp, linguistic_features, behavior_result)
        baseline_delta = asdict(delta_obj)

    return {
        # Core identifiers
        "transcript":           transcript,
        "matched_question":     sim_result["matched_question"],
        "matched_phrases":      sim_result["matched_phrases"],
        "all_scores":           sim_result["all_scores"],
        # Sub-scores
        "semantic_similarity":  sim_result["semantic_similarity"],
        "memorization_score":   llm_result["memorization_score"],
        "behavior_score":       behavior_result["behavior_score"],
        # Raw metrics
        "speech_metrics":       behavior_result,
        "linguistic_features":  linguistic_features,
        "baseline_delta":       baseline_delta,
        "integrity_events":     events,
    }


def _compute_live_verdict(similarity: float) -> str:
    if similarity >= 0.70:
        return "HIGH_RISK"
    if similarity >= 0.40:
        return "SUSPICIOUS"
    return "GENUINE"


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    return {"status": "ok", "service": "SafeInterview v2", "version": "2.0.0"}


# ── HR Session Management ─────────────────────────────────────────────────

class CreateSessionRequest(BaseModel):
    candidate_name: str
    role: str = "Software Engineer"
    session_id: str = ""


@app.post("/sessions/create")
async def create_session(payload: CreateSessionRequest):
    """HR creates a new interview session for a candidate."""
    sid = payload.session_id or f"sess_{uuid.uuid4().hex[:10]}"
    session_data = {
        "session_id":     sid,
        "candidate_name": payload.candidate_name,
        "role":           payload.role,
        "created_at":     __import__("datetime").datetime.utcnow().isoformat(),
        "status":         "pending",
        "live":           False,
        "risk_label":     None,
        "final_score":    0.0,
        "result":         None,
    }
    _hr_sessions[sid] = session_data
    logger.info("Session created: %s for %s", sid, payload.candidate_name)
    await _save_session_async(sid)  # Persist immediately to Supabase
    return session_data


@app.get("/sessions")
async def list_sessions():
    """HR retrieves all interview sessions with their latest results."""
    sessions = sorted(
        _hr_sessions.values(),
        key=lambda s: s.get("created_at", ""),
        reverse=True,
    )
    return {"sessions": sessions, "total": len(sessions)}


@app.get("/sessions/{session_id}")
async def get_session(session_id: str):
    """Get a single session's full result."""
    if session_id not in _hr_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    return _hr_sessions[session_id]


@app.patch("/sessions/{session_id}/result")
async def update_session_result(session_id: str, result: dict):
    """Candidate interview completed — store results against HR session."""
    if session_id not in _hr_sessions:
        # Auto-create if candidate used a code without pre-registration
        _hr_sessions[session_id] = {
            "session_id": session_id,
            "candidate_name": result.get("candidate_name", "Anonymous"),
            "role": "Unknown",
            "created_at": __import__("datetime").datetime.utcnow().isoformat(),
        }
    _hr_sessions[session_id].update({
        "status":      "completed",
        "live":        False,
        "risk_label":  result.get("risk_label"),
        "final_score": result.get("final_score", 0.0),
        "result":      result,
        "completed_at":__import__("datetime").datetime.utcnow().isoformat(),
    })
    await _save_session_async(session_id)  # Persist immediately to Supabase
    return {"status": "updated"}


# ── Chrome Extension endpoints ─────────────────────────────────────────────

class FinalizeRequest(BaseModel):
    integrity_events: list = []
    analysis_results: list = []


@app.post("/sessions/{session_id}/event")
async def append_integrity_event(session_id: str, event: dict):
    """Append a single discrete integrity event (tab-switch, paste, etc.) to a session."""
    if session_id not in _hr_sessions:
        _hr_sessions[session_id] = {
            "session_id": session_id,
            "candidate_name": "Anonymous",
            "created_at": __import__("datetime").datetime.utcnow().isoformat(),
        }
    session = _hr_sessions[session_id]
    if "integrity_events" not in session:
        session["integrity_events"] = []
    session["integrity_events"].append({
        **event,
        "received_at": __import__("datetime").datetime.utcnow().isoformat(),
    })
    return {"status": "appended", "event_count": len(session["integrity_events"])}


@app.post("/sessions/{session_id}/finalize")
async def finalize_session(session_id: str, payload: FinalizeRequest):
    """
    Finalise an interview session: compute weighted suspicion score and persist to Supabase.
    Called by the Chrome Extension when the interviewer ends the session.
    """
    import datetime
    from report import compute_final_score

    if session_id not in _hr_sessions:
        _hr_sessions[session_id] = {
            "session_id":     session_id,
            "candidate_name": "Anonymous",
            "created_at":     datetime.datetime.utcnow().isoformat(),
        }

    report = compute_final_score(payload.analysis_results, payload.integrity_events)

    _hr_sessions[session_id].update({
        "status":           "completed",
        "live":             False,
        "risk_label":       report["risk_level"],
        "final_score":      report["final_score"],
        "result":           report,
        "integrity_events": payload.integrity_events,
        "analysis_results": payload.analysis_results,
        "completed_at":     datetime.datetime.utcnow().isoformat(),
    })

    await _save_session_async(session_id)
    logger.info(
        "Session finalised: %s  score=%.1f  risk=%s",
        session_id, report["final_score"], report["risk_level"],
    )

    return {
        "status":      "finalized",
        "session_id":  session_id,
        "final_score": report["final_score"],
        "risk_level":  report["risk_level"],
        "report":      report,
    }


@app.get("/sessions/{session_id}/report")
async def get_session_report(session_id: str):
    """Return the finalised structured report for a completed session."""
    if session_id not in _hr_sessions:
        raise HTTPException(status_code=404, detail="Session not found.")

    session = _hr_sessions[session_id]
    result  = session.get("result")

    if not result:
        raise HTTPException(
            status_code=404,
            detail="Report not yet generated. Call POST /sessions/{id}/finalize first.",
        )

    return {
        "session_id":     session_id,
        "candidate_name": session.get("candidate_name"),
        "role":           session.get("role"),
        "final_score":    session.get("final_score"),
        "risk_level":     session.get("risk_label"),
        "report":         result,
    }


# ── Threshold management ───────────────────────────────────────────────────

@app.get("/thresholds")
async def get_thresholds():
    """Return the current risk-level thresholds from thresholds.json."""
    from scoring import load_thresholds
    return load_thresholds()


class ThresholdUpdateRequest(BaseModel):
    low_max:    int
    medium_max: int


@app.post("/thresholds")
async def update_thresholds(payload: ThresholdUpdateRequest):
    """
    Update the risk-level thresholds persisted in thresholds.json.
    low_max and medium_max must satisfy: 0 < low_max < medium_max < 100.
    """
    from scoring import save_thresholds
    try:
        saved = save_thresholds({"low_max": payload.low_max, "medium_max": payload.medium_max})
        logger.info("Thresholds updated: low_max=%d medium_max=%d", payload.low_max, payload.medium_max)
        return {"status": "updated", "thresholds": saved}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ── Validation / Test Mode ─────────────────────────────────────────────────

@app.post("/validate")
async def run_validation_suite():
    """
    Run the built-in validation suite against 5 canonical scenarios.
    Compares system outputs against expected risk levels and confidence ranges.
    Useful for threshold calibration and regression testing.
    """
    from validation import run_validation
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, run_validation)
    logger.info(
        "Validation complete: %d/%d passed",
        result["passed"], result["total"]
    )
    return result


@app.post("/analyze")
async def analyze_audio(
    file: UploadFile = File(...),
    duration: float = Form(default=0.0),
    session_id: str = Form(default=""),
    events_json: str = Form(default="[]"),
    eye_metrics_json: str = Form(default="{}"),
):
    """Accept an uploaded audio file and return a full risk analysis."""
    if file.content_type and not any(
        ct in file.content_type for ct in ["audio", "video", "octet-stream"]
    ):
        raise HTTPException(status_code=400, detail="File must be an audio file.")

    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty file uploaded.")

    # Parse optional integrity events and eye metrics
    try:
        events = json.loads(events_json) if events_json else []
    except Exception:
        events = []
    try:
        eye_metrics_raw = json.loads(eye_metrics_json) if eye_metrics_json else None
        if eye_metrics_raw == {}:
            eye_metrics_raw = None
    except Exception:
        eye_metrics_raw = None

    try:
        result = await _full_analysis(
            audio_bytes,
            duration or None,
            events=events,
            session_id=session_id,
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.exception("Analysis failed")
        raise HTTPException(status_code=500, detail=f"Analysis error: {str(e)}")


@app.post("/baseline", response_model=BaselineResponse)
async def capture_baseline(payload: BaselineRequest):
    """
    Process an intro-phase answer and accumulate it into the session baseline.
    Call this for each intro question answer before the main interview begins.
    """
    import base64
    from stt import transcribe_bytes
    from behavior import analyze_behavior
    from linguistics import extract_linguistic_features
    from baseline import build_baseline, BaselineProfile
    from embeddings import _get_model as get_embed_model

    loop = asyncio.get_event_loop()
    
    if payload.is_text_mode and payload.text_input:
        transcript = payload.text_input
        audio_bytes = None
        # Approximate duration mapping (2.5 words per sec = ~150wpm)
        duration = max(1.0, len(transcript.split()) / 2.5)
        stt_result = {"transcript": transcript, "duration": duration, "segments": None}
    else:
        try:
            raw = payload.audio_base64
            if "," in raw:
                raw = raw.split(",")[1]
            audio_bytes = base64.b64decode(raw)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid base64 audio.")
            
        stt_result = await loop.run_in_executor(None, transcribe_bytes, audio_bytes)
    
    transcript = stt_result.get("transcript", "")
    duration = stt_result.get("duration", 30.0)

    speech_metrics = await loop.run_in_executor(
        None, analyze_behavior, transcript, duration, stt_result.get("segments"), None, None if audio_bytes is None else audio_bytes
    )

    embed_model = await loop.run_in_executor(None, get_embed_model)
    ling = await loop.run_in_executor(None, extract_linguistic_features, transcript, embed_model)

    # Accumulate into store
    existing = _baseline_store.get(payload.session_id, [])
    if not isinstance(existing, list):
        existing = [existing]

    # Build partial result for baseline builder
    partial = {**ling, "speech_metrics": speech_metrics}
    existing.append(partial)

    # Rebuild profile from all accumulated samples
    profile = build_baseline(existing)
    import dataclasses
    _baseline_store[payload.session_id] = dataclasses.asdict(profile)

    logger.info("Baseline updated for session %s (sample %d)", payload.session_id, profile.sample_count)

    return BaselineResponse(
        session_id=   payload.session_id,
        sample_count= profile.sample_count,
        status=       "baseline_updated",
    )



# ---------------------------------------------------------------------------
# WebSocket — Real-time streaming
# ---------------------------------------------------------------------------

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """
    WebSocket for real-time interview streaming.

    Client → Server:
      Binary frames:  raw audio chunk bytes
      Text "DONE":    end of recording signal
      Text JSON:
        type=integrity_event → behavioural event (tab switch, paste, etc.)
        type=eye_metrics     → anonymised eye feature summary (NO raw video)
        type=eye_baseline    → intro-phase eye baseline
        type=session_start   → carry session_id for baseline lookup

    Server → Client:
      JSON LiveUpdate after each chunk
      JSON final result on "DONE"
    """
    await websocket.accept()
    logger.info("WebSocket connection opened.")

    audio_buffer   = bytearray()
    chunk_index    = 0
    last_transcript= ""
    session_events = []
    session_id     = ""

    try:
        while True:
            message = await websocket.receive()

            # ── Binary: raw audio chunk ───────────────────────────────────
            if "bytes" in message and message["bytes"]:
                chunk_bytes = message["bytes"]
                audio_buffer.extend(chunk_bytes)
                chunk_index += 1

                loop = asyncio.get_event_loop()
                from stt import transcribe_bytes
                from embeddings import compute_similarity

                try:
                    stt_result = await loop.run_in_executor(
                        None, transcribe_bytes, bytes(audio_buffer)
                    )
                    transcript = stt_result["transcript"]
                    if transcript and transcript != last_transcript:
                        last_transcript = transcript
                        sim_result = await loop.run_in_executor(
                            None, compute_similarity, transcript
                        )
                        from behavior import analyze_behavior
                        from linguistics import extract_linguistic_features
                        from baseline import compute_baseline_delta, BaselineProfile
                        from embeddings import _get_model as get_embed_model

                        behavior_result = await loop.run_in_executor(
                            None, analyze_behavior, transcript, stt_result.get("duration", 30.0), stt_result.get("segments"), None, bytes(audio_buffer)
                        )
                        embed_model = await loop.run_in_executor(None, get_embed_model)
                        linguistic_features = await loop.run_in_executor(
                            None, extract_linguistic_features, transcript, embed_model
                        )
                        
                        live_baseline_delta = {}
                        if session_id and session_id in _baseline_store:
                            bp = BaselineProfile(**_baseline_store[session_id])
                            delta_obj = compute_baseline_delta(bp, linguistic_features, behavior_result)
                            import dataclasses
                            live_baseline_delta = dataclasses.asdict(delta_obj)

                        await websocket.send_json({
                            "type":               "transcript",
                            "transcript":          transcript,
                            "semantic_similarity": sim_result["similarity"],
                            "verdict":             sim_result.get("verdict", "Unknown"),
                            "chunk_index":         chunk_index,
                            "baseline_delta":      live_baseline_delta,
                        })
                    else:
                        await websocket.send_json({"type": "heartbeat", "chunk_index": chunk_index})
                except Exception as e:
                    logger.warning("Chunk transcription error: %s", e)
                    await websocket.send_json({"type": "error", "message": str(e), "chunk_index": chunk_index})

            # ── Text: control / event messages ────────────────────────────
            elif "text" in message:
                text = message["text"]
                if text == "DONE":
                    logger.info("DONE signal — running full analysis.")
                    if audio_buffer:
                        try:
                            result = await _full_analysis(
                                bytes(audio_buffer),
                                events=session_events,
                                session_id=session_id,
                            )
                            await websocket.send_json({"type": "final", **result})
                        except Exception as e:
                            logger.exception("Final analysis error")
                            await websocket.send_json({"type": "error", "message": str(e)})
                    break
                else:
                    try:
                        data = json.loads(text)
                        msg_type = data.get("type")
                        if msg_type == "integrity_event":
                            session_events.append(data)
                        elif msg_type == "session_start":
                            session_id = data.get("session_id", "")
                            logger.info("Session identified: %s", session_id)
                        elif msg_type == "text_answer":
                            transcript = data.get("text", "")
                            if transcript and transcript != last_transcript:
                                last_transcript = transcript
                                loop = asyncio.get_event_loop()
                                from embeddings import compute_similarity
                                sim_result = await loop.run_in_executor(
                                    None, compute_similarity, transcript
                                )
                                from behavior import analyze_behavior
                                from linguistics import extract_linguistic_features
                                from baseline import compute_baseline_delta, BaselineProfile
                                from embeddings import _get_model as get_embed_model

                                duration = max(1.0, len(transcript.split()) / 2.5)
                                behavior_result = await loop.run_in_executor(
                                    None, analyze_behavior, transcript, duration, None, None, None
                                )
                                embed_model = await loop.run_in_executor(None, get_embed_model)
                                linguistic_features = await loop.run_in_executor(
                                    None, extract_linguistic_features, transcript, embed_model
                                )
                                
                                live_baseline_delta = {}
                                if session_id and session_id in _baseline_store:
                                    bp = BaselineProfile(**_baseline_store[session_id])
                                    delta_obj = compute_baseline_delta(bp, linguistic_features, behavior_result)
                                    import dataclasses
                                    live_baseline_delta = dataclasses.asdict(delta_obj)

                                await websocket.send_json({
                                    "type":               "transcript",
                                    "transcript":          transcript,
                                    "semantic_similarity": sim_result["similarity"],
                                    "verdict":             sim_result.get("verdict", "Unknown"),
                                    "chunk_index":         chunk_index,
                                    "baseline_delta":      live_baseline_delta,
                                })
                    except json.JSONDecodeError:
                        pass

    except WebSocketDisconnect:
        logger.info("WebSocket disconnected.")
    except Exception as e:
        logger.exception("WebSocket error: %s", e)
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
    finally:
        pass


# ---------------------------------------------------------------------------
# Static file serving + SPA catch-all (public / production mode)
# ---------------------------------------------------------------------------

@app.get("/", include_in_schema=False)
async def api_root():
    return {"status": "ok", "message": "SafeInterview API is running. Point your frontend to this URL."}
