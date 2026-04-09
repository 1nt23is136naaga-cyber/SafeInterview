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

def _load_sessions():
    """Load persisted sessions from disk into memory."""
    global _hr_sessions
    if os.path.exists(SESSIONS_FILE):
        try:
            with open(SESSIONS_FILE, "r", encoding="utf-8") as f:
                _hr_sessions = json.load(f)
            logger.info("Loaded %d persisted sessions from disk.", len(_hr_sessions))
        except Exception as e:
            logger.warning("Could not load sessions.json: %s", e)

def _save_sessions():
    """Persist current sessions to disk."""
    try:
        with open(SESSIONS_FILE, "w", encoding="utf-8") as f:
            json.dump(_hr_sessions, f, indent=2, default=str)
    except Exception as e:
        logger.warning("Could not save sessions.json: %s", e)



# ---------------------------------------------------------------------------
# Lifespan: warm up models on startup
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Load persisted sessions before warming models
    _load_sessions()
    logger.info("Warming up models…")
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

# CORS — open in public mode, restricted in local mode
_public_mode = os.getenv("PUBLIC_MODE", "false").lower() == "true"
origins = ["*"] if _public_mode else [o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=not _public_mode,   # credentials + wildcard not allowed together
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
    audio_base64: str
    question_index: int = 0


class BaselineResponse(BaseModel):
    session_id: str
    sample_count: int
    status: str


class ResumeUploadResponse(BaseModel):
    resume_text: str
    questions: list[str]


class ResumeVerifyRequest(BaseModel):
    audio_base64: str
    question: str
    resume_text: str


class ResumeVerifyResponse(BaseModel):
    transcript: str
    legitimacy_score: float
    verdict: str
    explanation: str


# ---------------------------------------------------------------------------
# Core analysis pipeline
# ---------------------------------------------------------------------------

async def _full_analysis(
    audio_bytes: bytes,
    duration: float | None = None,
    events: list = None,
    session_id: str = "",
    eye_metrics_raw: dict = None,
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
    from report import build_risk_report
    from eye_tracking import compute_eye_behavior_score, parse_eye_event, EyeMetricsSummary
    from embeddings import _get_model as get_embed_model

    if events is None:
        events = []

    loop = asyncio.get_event_loop()

    # 1 ── Transcribe ──────────────────────────────────────────────────────
    stt_result = await loop.run_in_executor(None, transcribe_bytes, audio_bytes)
    transcript = stt_result["transcript"]
    audio_duration = duration or stt_result.get("duration", 30.0)

    if not transcript.strip():
        raise ValueError("Could not transcribe audio. Please check audio quality.")

    # 2 ── Semantic similarity ─────────────────────────────────────────────
    sim_result = await loop.run_in_executor(None, compute_similarity, transcript)

    # 3 ── LLM evaluation ────────────────────────────────────────────────
    llm_result = await evaluate_response(transcript, sim_result["matched_question"])

    # 4 ── Behavioral analysis ─────────────────────────────────────────────
    behavior_result = await loop.run_in_executor(
        None,
        analyze_behavior,
        transcript,
        audio_duration,
        stt_result.get("segments"),
        events,
        audio_bytes,          # pass raw bytes for acoustic analysis
    )

    # 5 ── Linguistic features ─────────────────────────────────────────────
    embed_model = await loop.run_in_executor(None, get_embed_model)
    linguistic_features = await loop.run_in_executor(
        None, extract_linguistic_features, transcript, embed_model
    )

    # 6 ── Eye behavior ───────────────────────────────────────────────────
    eye_score_obj = None
    eye_score = 0.0
    eye_explanations: list[str] = []
    if eye_metrics_raw:
        try:
            eye_summary = parse_eye_event(eye_metrics_raw)
            eye_score_obj = compute_eye_behavior_score(eye_summary)
            if eye_score_obj.reliable:
                eye_score = eye_score_obj.eye_score
                eye_explanations = eye_score_obj.human_explanation
        except Exception as exc:
            logger.warning("Eye tracking scoring failed: %s", exc)

    # 7 ── Baseline delta ─────────────────────────────────────────────────
    baseline_delta: dict = {"has_baseline": False, "baseline_anomaly_score": 0.0}
    if session_id and session_id in _baseline_store:
        stored = _baseline_store[session_id]
        bp = BaselineProfile(**stored)
        from baseline import compute_baseline_delta as cbd
        delta_obj = cbd(bp, linguistic_features, behavior_result)
        baseline_delta = asdict(delta_obj)
    
    # Eye baseline delta
    eye_baseline_delta: dict = {}
    if session_id and session_id in _eye_baseline_store and eye_score_obj:
        b_eye = _eye_baseline_store[session_id]
        eye_baseline_delta = _compute_eye_delta(b_eye, eye_metrics_raw or {})

    # 8 ── Build Risk Report ───────────────────────────────────────────────
    # Eye contributes 10% to the total risk (non-dominant but informative)
    eye_contribution = eye_score * 0.10

    report = build_risk_report(
        transcript=          transcript,
        semantic_similarity= sim_result["semantic_similarity"],
        memorization_score=  llm_result["memorization_score"],
        memorization_explanation=llm_result["explanation"],
        speech_metrics=      behavior_result,
        linguistic_features= linguistic_features,
        baseline_delta=      baseline_delta,
        integrity_events=    events,
        matched_question=    sim_result["matched_question"],
        matched_phrases=     sim_result["matched_phrases"],
        all_scores=          sim_result["all_scores"],
    )

    # Blend eye score into final
    final_risk = round(min(report.risk_score + eye_contribution, 1.0), 4)

    return {
        # Core identifiers
        "transcript":           transcript,
        "matched_question":     sim_result["matched_question"],
        "matched_phrases":      sim_result["matched_phrases"],
        "all_scores":           sim_result["all_scores"],
        # Sub-scores (for gauges)
        "semantic_similarity":  report.semantic_similarity,
        "memorization_score":   report.memorization_score,
        "behavior_score":       report.behavior_score,
        "eye_score":            eye_score,
        # Computed totals
        "final_score":          final_risk,
        "risk_label":           report.risk_label,
        "confidence":           report.confidence,
        "recommendation":       report.recommendation,
        # Explainability
        "verdict_summary":      report.verdict_summary,
        "top_signals":          [asdict(s) for s in report.top_signals],
        "eye_explanations":     eye_explanations,
        "eye_baseline_delta":   eye_baseline_delta,
        # Raw metrics
        "speech_metrics":       behavior_result,
        "linguistic_features":  linguistic_features,
        "baseline_delta":       baseline_delta,
        # Events
        "integrity_events":     events,
        "timeline_events":      report.timeline_events,
        # Legacy fields for existing UI compatibility
        "verdict":              report.risk_label,
        "memorization_explanation": llm_result["explanation"],
    }


def _compute_eye_delta(baseline_eye: dict, current_eye: dict) -> dict:
    """Simple delta between baseline and current eye metrics."""
    keys = ["off_screen_pct", "blink_rate_per_min", "gaze_variance",
            "gaze_left_pct", "gaze_right_pct"]
    return {
        f"delta_{k}": round(float(current_eye.get(k, 0)) - float(baseline_eye.get(k, 0)), 4)
        for k in keys
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


# ---------------------------------------------------------------------------
# WebRTC Signaling — /ws/room/{session_id}?role=hr|candidate
# ---------------------------------------------------------------------------

from fastapi import WebSocket, WebSocketDisconnect

@app.websocket("/ws/room/{session_id}")
async def video_room_signaling(ws: WebSocket, session_id: str, role: str = "candidate"):
    """
    WebRTC signaling relay for 1-on-1 video interview rooms.
    Relays: SDP offer/answer, ICE candidates, chat messages, peer join/leave.
    """
    await ws.accept()

    # Register this peer in the room
    if session_id not in _video_rooms:
        _video_rooms[session_id] = {}
    _video_rooms[session_id][role] = ws
    other = "hr" if role == "candidate" else "candidate"

    logger.info("[VideoRoom] %s joined room %s", role, session_id)

    try:
        # If the other peer is already waiting, notify BOTH sides
        if other in _video_rooms.get(session_id, {}):
            # Tell the already-waiting peer that this new peer joined
            try:
                await _video_rooms[session_id][other].send_json({
                    "type": "peer-joined",
                    "role": role,
                })
            except Exception:
                pass
            # CRITICAL FIX: Also tell the NEW joiner that the other peer is already present
            # Without this, if HR joins after candidate, HR never knows candidate is waiting
            try:
                await ws.send_json({
                    "type": "peer-joined",
                    "role": other,
                })
            except Exception:
                pass

        # Relay loop
        while True:
            try:
                msg = await ws.receive_json()
            except Exception:
                break

            # Pass offer / answer / ice-candidate / chat directly to the other peer
            if other in _video_rooms.get(session_id, {}):
                try:
                    await _video_rooms[session_id][other].send_json(msg)
                except Exception:
                    pass

    except WebSocketDisconnect:
        pass
    finally:
        # Clean up this peer from the room
        if session_id in _video_rooms and role in _video_rooms[session_id]:
            del _video_rooms[session_id][role]
        if session_id in _video_rooms and not _video_rooms[session_id]:
            del _video_rooms[session_id]

        # Notify the other peer that this one left
        if session_id in _video_rooms and other in _video_rooms[session_id]:
            try:
                await _video_rooms[session_id][other].send_json({
                    "type": "peer-left",
                    "role": role,
                })
            except Exception:
                pass

        logger.info("[VideoRoom] %s left room %s", role, session_id)



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
    _save_sessions()  # Persist immediately
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
    _save_sessions()  # Persist immediately
    return {"status": "updated"}


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
            eye_metrics_raw=eye_metrics_raw,
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

    try:
        raw = payload.audio_base64
        if "," in raw:
            raw = raw.split(",")[1]
        audio_bytes = base64.b64decode(raw)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 audio.")

    loop = asyncio.get_event_loop()
    stt_result = await loop.run_in_executor(None, transcribe_bytes, audio_bytes)
    transcript = stt_result.get("transcript", "")

    speech_metrics = await loop.run_in_executor(
        None, analyze_behavior, transcript,
        stt_result.get("duration", 30.0), stt_result.get("segments"), None
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


@app.post("/baseline/eye")
async def capture_eye_baseline(session_id: str, eye_data: dict):
    """Store eye tracking baseline metrics from the intro phase."""
    _eye_baseline_store[session_id] = eye_data
    return {"status": "eye_baseline_stored"}


@app.post("/upload-video")
async def upload_video(file: UploadFile = File(...)):
    """Accept a screen recording webm/mp4 and save (flagged sessions only)."""
    if file.content_type and not file.content_type.startswith("video/"):
        raise HTTPException(status_code=400, detail="Must be a video file")

    ext = ".webm" if "webm" in (file.content_type or "") else ".mp4"
    filename = f"screen_{uuid.uuid4().hex[:8]}{ext}"
    filepath = os.path.join("uploads", filename)

    with open(filepath, "wb") as f:
        shutil.copyfileobj(file.file, f)

    return {"url": f"/uploads/{filename}"}


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
    eye_metrics_accumulator: list[dict] = []

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
                        similarity = sim_result["semantic_similarity"]
                        await websocket.send_json({
                            "type":               "transcript",
                            "transcript":          transcript,
                            "semantic_similarity": similarity,
                            "verdict":             _compute_live_verdict(similarity),
                            "chunk_index":         chunk_index,
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
                            # Merge accumulated eye frames into a single summary
                            merged_eye = _merge_eye_frames(eye_metrics_accumulator)
                            result = await _full_analysis(
                                bytes(audio_buffer),
                                events=session_events,
                                session_id=session_id,
                                eye_metrics_raw=merged_eye,
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
                        elif msg_type == "eye_metrics":
                            # Accumulate eye frame summaries (NOT raw frames)
                            eye_metrics_accumulator.append(data)
                        elif msg_type == "eye_baseline":
                            if session_id:
                                _eye_baseline_store[session_id] = data
                        elif msg_type == "session_start":
                            session_id = data.get("session_id", "")
                            logger.info("Session identified: %s", session_id)
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
        logger.info("WebSocket closed. Chunks: %d", chunk_index)


def _merge_eye_frames(frames: list[dict]) -> dict | None:
    """Average accumulated eye metric frames into a single summary dict."""
    if not frames:
        return None
    keys = [
        "gaze_left_pct", "gaze_right_pct", "gaze_up_pct", "gaze_center_pct",
        "off_screen_pct", "avg_fixation_duration_ms", "blink_rate_per_min",
        "gaze_variance", "head_yaw_std", "head_pitch_std",
    ]
    merged = {}
    for k in keys:
        vals = [float(f.get(k, 0)) for f in frames if k in f]
        merged[k] = sum(vals) / len(vals) if vals else 0.0
    merged["sample_count"] = sum(int(f.get("sample_count", 1)) for f in frames)
    return merged


# ---------------------------------------------------------------------------
# Resume verification endpoints (unchanged from v1)
# ---------------------------------------------------------------------------

@app.post("/upload-resume", response_model=ResumeUploadResponse)
async def upload_resume(file: UploadFile = File(...)):
    from resume_verify import parse_resume_to_text, generate_questions
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF resumes are supported.")
    try:
        content = await file.read()
        resume_text = await parse_resume_to_text(content)
        questions   = await generate_questions(resume_text)
        return ResumeUploadResponse(resume_text=resume_text, questions=questions)
    except Exception as e:
        logger.error("Failed to process resume: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/verify-resume-answer", response_model=ResumeVerifyResponse)
async def verify_resume_answer(payload: ResumeVerifyRequest):
    from stt import transcribe_bytes
    from resume_verify import evaluate_resume_answer
    import base64
    try:
        raw = payload.audio_base64
        if "," in raw:
            raw = raw.split(",")[1]
        audio_bytes = base64.b64decode(raw)
        loop = asyncio.get_event_loop()
        stt_result = await loop.run_in_executor(None, transcribe_bytes, audio_bytes)
        transcript = stt_result.get("transcript", "")
        if not transcript.strip():
            return ResumeVerifyResponse(
                transcript="",
                legitimacy_score=0.0,
                verdict="Fake/Exaggerated",
                explanation="No recognisable speech detected. Could not verify claims.",
            )
        evaluation = await evaluate_resume_answer(transcript, payload.question, payload.resume_text)
        return ResumeVerifyResponse(
            transcript=       transcript,
            legitimacy_score= evaluation["legitimacy_score"],
            verdict=          evaluation["verdict"],
            explanation=      evaluation["explanation"],
        )
    except Exception as e:
        logger.error("Failed to verify resume answer: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Static file serving + SPA catch-all (public / production mode)
# ---------------------------------------------------------------------------

@app.get("/{full_path:path}", include_in_schema=False)
async def spa_catch_all(full_path: str):
    """
    1. If dist/full_path exists as a real file → serve it (JS, CSS, images).
    2. Otherwise → serve dist/index.html for SPA client-side routing.
    3. If dist doesn't exist at all → 404 (dev mode uses Vite directly).
    """
    dist = os.path.normpath(_dist)
    index_html = os.path.join(dist, "index.html")

    if not os.path.isfile(index_html):
        raise HTTPException(status_code=404, detail="Frontend not built. Run: npm run build")

    # Try exact file match first (assets, favicon, etc.)
    candidate = os.path.normpath(os.path.join(dist, full_path))
    # Security: make sure we don't escape dist/
    if candidate.startswith(dist) and os.path.isfile(candidate):
        return FileResponse(candidate)

    # SPA fallback — let React Router handle the route
    return FileResponse(index_html, media_type="text/html")
