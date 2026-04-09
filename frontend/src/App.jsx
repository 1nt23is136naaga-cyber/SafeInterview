import { useState, useEffect, useCallback, useRef } from "react";
import AudioRecorder from "./components/AudioRecorder";
import LiveTranscriptViewer from "./components/LiveTranscriptViewer";
import SimilarityGauge from "./components/SimilarityGauge";
import BehaviorStatsPanel from "./components/BehaviorStatsPanel";
import MatchedPhrasesHighlighter from "./components/MatchedPhrasesHighlighter";
import IntegrityPanel from "./components/IntegrityPanel";
import LoginScreen from "./components/LoginScreen";
import WarningOverlay from "./components/WarningOverlay";
import ResumeVerification from "./components/ResumeVerification";
import ConsentGate from "./components/ConsentGate";
import EyeTracker from "./components/EyeTracker";
import RiskReportCard from "./components/RiskReportCard";
import HRDashboard from "./components/HRDashboard";
import VideoRoom from "./components/VideoRoom";
import CandidateEndScreen from "./components/CandidateEndScreen";
import { uploadVideo, BACKEND_URL } from "./api";
import html2pdf from "html2pdf.js";
import ProfessionalReport from "./components/ProfessionalReport";

// ── Session ID ─────────────────────────────────────────────────────────────
const generateSessionId = () =>
  `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

// ── BackendStatus dot ─────────────────────────────────────────────────────
function BackendStatus() {
  const [status, setStatus] = useState("checking");
  useEffect(() => {
    let active = true;
    const check = () =>
      fetch(`${BACKEND_URL}/health`)
        .then(() => { if (active) setStatus("online"); })
        .catch(() => { if (active) setStatus("offline"); });
    check();
    const id = setInterval(check, 6000);
    return () => { active = false; clearInterval(id); };
  }, []);
  const cfg = {
    online:   "bg-emerald-500/10 border-emerald-500/30 text-emerald-400",
    offline:  "bg-red-500/10 border-red-500/30 text-red-400",
    checking: "bg-gray-500/10 border-gray-500/30 text-gray-400",
  }[status];
  const dot = { online: "bg-emerald-400 animate-pulse", offline: "bg-red-400", checking: "bg-gray-400 animate-pulse" }[status];
  return (
    <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border ${cfg}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      {status === "online" ? "Live" : status === "offline" ? "Offline" : "…"}
    </div>
  );
}

// ── Candidate App Header ───────────────────────────────────────────────────
function CandidateHeader({ isRecording, onEndMeeting, candidateName }) {
  return (
    <header className="border-b border-white/5 bg-black/30 backdrop-blur-sm sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-6 py-3.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center text-base">🛡️</div>
          <div>
            <span className="text-white font-bold text-base">SafeInterview</span>
            <span className="text-gray-600 text-xs ml-2">Interview</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {candidateName && (
            <span className="hidden sm:block text-xs text-gray-500">
              🎤 {candidateName}
            </span>
          )}
          {isRecording && (
            <button
              onClick={onEndMeeting}
              className="flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white font-bold px-4 py-2 rounded-xl transition-all text-sm border border-red-500 shadow-[0_0_15px_rgba(220,38,38,0.3)]"
            >
              <span className="w-2 h-2 rounded-full bg-white animate-pulse" /> End
            </button>
          )}
          <BackendStatus />
        </div>
      </div>
    </header>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────
export default function App() {
  // ── Auth state ─────────────────────────────────────────────────────────
  const [userRole, setUserRole]             = useState(null); // "hr" | "candidate" | null
  const [user, setUser]                     = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  // ── Video room state ────────────────────────────────────────────────────
  const [videoRoomSession, setVideoRoomSession] = useState(null); // {sessionId, role, name}

  // ── Consent ────────────────────────────────────────────────────────────
  const [consentGiven, setConsentGiven]     = useState(false);
  const [eyeEnabled, setEyeEnabled]         = useState(false);

  // ── Session ID ─────────────────────────────────────────────────────────────
  const sessionIdRef                        = useRef(null);
  const [assessmentType, setAssessmentType] = useState(null);
  const [hasStarted, setHasStarted]         = useState(false);
  const [isSessionDone, setIsSessionDone]   = useState(false);
  const [candidateInfo, setCandidateInfo]   = useState(null);

  // ── Parse URL for legit link ───────────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sid = params.get("session_id");
    if (sid) {
      sessionIdRef.current = sid;
      // If we have a session ID, we assume it's a pre-made interview
      setAssessmentType("interview");
      
      // Try to fetch candidate info from HR record
      fetch(`${BACKEND_URL}/sessions/${sid}`).then(r => r.json()).then(data => {
        if (data && data.candidate_name) {
          setCandidateInfo(data);
        }
      }).catch(() => {});
    } else {
      sessionIdRef.current = generateSessionId();
    }
  }, []);

  // ── Result state ───────────────────────────────────────────────────────
  const [result, setResult]                 = useState(null);
  const [liveUpdate, setLiveUpdate]         = useState(null);
  const [isAnalyzing, setIsAnalyzing]       = useState(false);
  const [isRecording, setIsRecording]       = useState(false);

  // ── Integrity monitoring ───────────────────────────────────────────────
  const [warningMessage, setWarningMessage] = useState("");
  const globalEventsRef                     = useRef([]);

  // ── Screen recording ───────────────────────────────────────────────────
  const screenStreamRef                     = useRef(null);
  const screenRecorderRef                   = useRef(null);
  const screenChunksRef                     = useRef([]);

  // ── Eye tracking ───────────────────────────────────────────────────────
  const eyeMetricsBufferRef                 = useRef([]);
  const wsRef                               = useRef(null);

  // ── AudioRecorder stop trigger ─────────────────────────────────────────
  const stopRecordingRef                    = useRef(null);

  // ── LOGIN ──────────────────────────────────────────────────────────────
  const handleLoginSuccess = async ({ role, credential }) => {
    setUserRole(role);
    setUser(credential);

    if (role === "hr") {
      // HR skips screen share — go straight to dashboard
      setIsAuthenticated(true);
      return;
    }

    // Candidate: require screen recording
    try {
      let stream;
      if (window.electronAPI) {
        const src = await window.electronAPI.getScreenSource();
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: src.id } },
        });
      } else {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { displaySurface: "monitor", frameRate: { ideal: 30 } },
          audio: false,
        });
        const settings = stream.getVideoTracks()[0]?.getSettings() || {};
        if (settings.displaySurface && settings.displaySurface !== "monitor") {
          stream.getTracks().forEach(t => t.stop());
          // Reject so we fall into catch 
          throw new Error("Wrong display surface. Please choose 'Entire Screen'.");
        }
      }
      const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
        ? "video/webm;codecs=vp9" : "video/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      screenRecorderRef.current = recorder;
      screenStreamRef.current = stream;
      screenChunksRef.current = [];
      recorder.ondataavailable = e => { if (e.data.size > 0) screenChunksRef.current.push(e.data); };
      recorder.start(1000);
      setIsAuthenticated(true);
    } catch (err) {
      if (err.name === "NotAllowedError") {
        alert("Screen recording permission required. Please allow access to continue.");
      } else {
        alert("Unable to start screen recording: " + err.message);
      }
      // If we fail, undo the login state so they aren't stuck on "Entering..."
      setUserRole(null);
      setUser(null);
    }
  };

  const handleLogout = () => {
    setIsAuthenticated(false);
    setUserRole(null);
    setUser(null);
    setConsentGiven(false);
    setEyeEnabled(false);
    setResult(null);
    setLiveUpdate(null);
    setHasStarted(false);
    setIsSessionDone(false);
    setAssessmentType(null);
    sessionIdRef.current = generateSessionId();
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(t => t.stop());
      screenStreamRef.current = null;
    }
  };

  // ── Eye metrics handler ────────────────────────────────────────────────
  const handleEyeMetrics = useCallback((summary) => {
    eyeMetricsBufferRef.current.push(summary);
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "eye_metrics", ...summary }));
    }
  }, []);

  // ── Start assessment fullscreen ────────────────────────────────────────
  const startAssessment = async () => {
    try {
      if (window.electronAPI) window.electronAPI.enterAssessment();
      else if (document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      }
      setHasStarted(true);
      globalEventsRef.current = [];
    } catch {
      alert("Please allow full-screen mode to begin the assessment.");
    }
  };

  // ── Integrity monitoring ───────────────────────────────────────────────
  const handleViolation = useCallback((msg, eventType, details = null) => {
    if (!hasStarted || isSessionDone) return;
    globalEventsRef.current.push({ event_type: eventType, timestamp: Date.now(), details });
    setWarningMessage(msg);
  }, [hasStarted, isSessionDone]);

  const dismissWarning = async () => {
    try {
      if (window.electronAPI) window.electronAPI.enterAssessment();
      else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    } catch { /* ignore */ }
    setWarningMessage("");
  };

  useEffect(() => {
    if (!hasStarted || isSessionDone || userRole !== "candidate") return;
    const onBlur = () => handleViolation("Browser lost focus", "focus_loss");
    const onVisChange = () => { if (document.hidden) handleViolation("Tab switch detected", "tab_switch"); };
    const onFsChange  = () => { if (!document.fullscreenElement) handleViolation("Exited fullscreen", "left_fullscreen"); };
    const onPaste     = () => handleViolation("Paste event detected", "paste");
    const onMouseLeave = e => {
      if (e.clientY <= 0 || e.clientX <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight)
        handleViolation("Mouse left window", "mouse_left");
    };
    // Typing speed variance — no content
    let lastKeyTime = null;
    const keyIntervals = [];
    const onKeyDown = () => {
      const now = Date.now();
      if (lastKeyTime) keyIntervals.push(now - lastKeyTime);
      lastKeyTime = now;
      if (keyIntervals.length >= 20) {
        const mean = keyIntervals.reduce((a, b) => a + b, 0) / keyIntervals.length;
        const sd   = Math.sqrt(keyIntervals.reduce((a, b) => a + (b - mean) ** 2, 0) / keyIntervals.length);
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "integrity_event", event_type: "typing_variance", details: { std_dev_ms: Math.round(sd) } }));
        }
        keyIntervals.length = 0;
      }
    };
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisChange);
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("paste", onPaste);
    document.addEventListener("mouseleave", onMouseLeave);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisChange);
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("paste", onPaste);
      document.removeEventListener("mouseleave", onMouseLeave);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [hasStarted, isSessionDone, userRole, handleViolation]);

  // ── Session complete ───────────────────────────────────────────────────
  const handleSessionComplete = async () => {
    setIsSessionDone(true);
    setWarningMessage("");
    if (window.electronAPI) { window.electronAPI.exitAssessment(); window.electronAPI.endMeeting(); }
    else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});

    if (screenRecorderRef.current && screenRecorderRef.current.state !== "inactive") {
      screenRecorderRef.current.onstop = async () => {
        const blob = new Blob(screenChunksRef.current, { type: "video/webm" });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement("a");
        a.href = url; a.download = `session-${new Date().toISOString().slice(0, 10)}.webm`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        try {
          const res = await uploadVideo(blob);
          setResult(prev => prev ? { ...prev, video_url: res.url } : null);
        } catch { setResult(prev => prev ? { ...prev, video_url: url } : null); }
        if (screenStreamRef.current) { screenStreamRef.current.getTracks().forEach(t => t.stop()); screenStreamRef.current = null; }
        screenChunksRef.current = [];
      };
      screenRecorderRef.current.stop();
    }
    globalEventsRef.current = [];
  };

  // POST result to HR session record
  const handleResult = useCallback(async (r) => {
    setResult(r);
    setLiveUpdate(null);
    if (r && sessionIdRef.current) {
      try {
        await fetch(`${BACKEND_URL}/sessions/${sessionIdRef.current}/result`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(r),
        });
      } catch { /* non-critical */ }
    }
  }, []);

  const handleReset = () => {
    setResult(null); setLiveUpdate(null); setIsAnalyzing(false);
    setIsSessionDone(false); setHasStarted(false); setAssessmentType(null);
    sessionIdRef.current = generateSessionId();
  };

  const handleDownloadPDF = async () => {
    const el = document.getElementById("pdf-export-container") || document.getElementById("report-content");
    if (!el) return;
    await html2pdf().set({
      margin: 0.5, filename: `VeritasAI_Report_${new Date().toISOString().slice(0, 10)}.pdf`,
      image: { type: "jpeg", quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: "in", format: "letter", orientation: "portrait" },
    }).from(el).save();
  };

  // ══════════════════════════════════════════════════════════════════════
  // RENDER GATES
  // ══════════════════════════════════════════════════════════════════════

  // 1 ── Login
  if (!isAuthenticated) {
    return <LoginScreen onLoginSuccess={handleLoginSuccess} />;
  }

  // 1b ── Active video room (HR or candidate)
  if (videoRoomSession) {
    return (
      <VideoRoom
        sessionId={videoRoomSession.sessionId}
        role={videoRoomSession.role}
        participantName={videoRoomSession.name}
        onEnd={() => {
          setVideoRoomSession(null);
          if (videoRoomSession.role === "candidate") handleLogout();
        }}
      />
    );
  }

  // 2 ── HR Dashboard
  if (userRole === "hr") {
    return (
      <HRDashboard
        user={user}
        onLogout={handleLogout}
        onJoinMeeting={(session) => {
          setVideoRoomSession({
            sessionId: session.session_id,
            role: "hr",
            name: "HR Manager",
          });
        }}
      />
    );
  }

  // 3 ── Candidate: Consent gate
  if (!consentGiven) {
    return (
      <ConsentGate
        onAccept={(opts) => {
          setEyeEnabled(opts.eyeTrackingEnabled ?? true);
          setConsentGiven(true);
          // If they joined via a session link/code — route directly to video room
          const sid = sessionIdRef.current;
          const isLinkedSession = new URLSearchParams(window.location.search).get("session_id") || null;
          if (sid && isLinkedSession) {
            setVideoRoomSession({
              sessionId: sid,
              role: "candidate",
              name: candidateInfo?.candidate_name || "Candidate",
            });
          }
        }}
        onDecline={handleLogout}
      />
    );
  }

  // 4 ── Candidate: Assessment type selection
  if (!assessmentType) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-[#070710]">
        <div className="max-w-3xl w-full">
          <div className="text-center mb-10 animate-fade-in">
            <div className="w-16 h-16 rounded-2xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-3xl mx-auto mb-4">🎤</div>
            <h2 className="text-3xl font-extrabold text-white mb-2">Select Your Round</h2>
            <p className="text-gray-400 text-sm">Choose the interview type for this session.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {[
              { type: "interview", icon: "🎤", title: "Live Interview", desc: "Multimodal real-time AI analysis — speech, NLP, eye attention, and baseline comparison." },
              { type: "resume",   icon: "📄", title: "Resume Verification", desc: "AI-driven question round that validates your resume claims through voice answers." },
            ].map(({ type, icon, title, desc }) => (
              <button key={type} onClick={() => setAssessmentType(type)}
                className="glass-card p-8 text-left group hover:border-indigo-400/40 hover:-translate-y-1 transition-all duration-300">
                <div className="text-3xl mb-4">{icon}</div>
                <h3 className="text-xl font-bold text-white mb-2">{title}</h3>
                <p className="text-gray-400 text-sm leading-relaxed">{desc}</p>
                <div className="mt-6 flex items-center gap-2 text-indigo-400 text-sm font-semibold opacity-0 group-hover:opacity-100 transition-all">
                  Select <span>→</span>
                </div>
              </button>
            ))}
          </div>
          <div className="mt-6 text-center">
            <button onClick={handleLogout} className="text-gray-600 hover:text-white text-xs underline">Back to Login</button>
          </div>
        </div>
      </div>
    );
  }

  // 5 ── Candidate: Environment check before interview starts
  if (assessmentType === "interview" && !hasStarted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#070710] p-4">
        <div className="glass-card p-10 max-w-md w-full text-center animate-fade-in">
          <div className="text-5xl mb-5">⚙️</div>
          <h2 className="text-2xl font-bold text-white mb-3">Meeting Setup</h2>
          <p className="text-gray-400 text-sm mb-6 leading-relaxed">
            {candidateInfo 
              ? `Welcome ${candidateInfo.candidate_name}. Please ensure your environment is ready for the ${candidateInfo.role} evaluation.`
              : "Verifying your system environment for the upcoming evaluation."}
          </p>
          <div className="bg-indigo-500/8 border border-indigo-500/25 rounded-xl p-4 mb-5 text-left">
            <p className="text-indigo-400 font-semibold text-sm mb-1">📋 Protocol</p>
            <p className="text-indigo-300/80 text-xs leading-relaxed">
              For a shared and fair evaluation, please use <strong>"Entire Screen"</strong> when prompted for screen sharing.
            </p>
          </div>
          <button onClick={startAssessment}
            className="w-full py-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-base transition-all shadow-[0_0_20px_rgba(99,102,241,0.35)] mb-3">
            Join Meeting
          </button>
          {!sessionIdRef.current?.startsWith("sess_") && (
             <button onClick={() => setAssessmentType(null)} className="text-gray-500 hover:text-white text-xs underline">
              Go back
            </button>
          )}
        </div>
      </div>
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // 6 ── MAIN INTERVIEW VIEW
  // ── Candidate Completion View (Restriction) ──
  if (isSessionDone && userRole !== "hr") {
    return <CandidateEndScreen candidateName={candidateInfo?.candidate_name} />;
  }

  const liveVerdict    = liveUpdate?.verdict;
  const liveSimilarity = liveUpdate?.semantic_similarity ?? 0;

  return (
    <div className="min-h-screen bg-[#070710]">
      <WarningOverlay isVisible={!!warningMessage} message={warningMessage} onDismiss={dismissWarning} />
      <CandidateHeader isRecording={isRecording} onEndMeeting={() => stopRecordingRef.current?.()} />

      <main id="report-content" className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
        {/* Only show professional report container if result exists AND user is authorized */}
        {result && (userRole === "hr" || !isSessionDone) && <ProfessionalReport result={result} />}

        {assessmentType === "resume" ? (
          <ResumeVerification onComplete={() => setAssessmentType(null)} />
        ) : (
          <>
            {/* Hero */}
            <div className={`mb-6 text-center ${isSessionDone ? "hidden" : ""}`}>
              <h2 className="text-3xl font-extrabold text-white mb-1">
                Live{" "}
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-purple-400">
                  Interview Analysis
                </span>
              </h2>
              <p className="text-gray-500 text-sm">Multimodal evaluation — speech · NLP · eye attention · baseline</p>
              {/* EyeTracker inline status */}
              {eyeEnabled && hasStarted && (
                <div className="mt-3 flex justify-center">
                  <EyeTracker
                    enabled={eyeEnabled && !isSessionDone}
                    onMetrics={handleEyeMetrics}
                    onStatus={msg => console.log("[Eye]", msg)}
                    reportIntervalMs={5000}
                  />
                </div>
              )}
            </div>

            {/* Main grid */}
            <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
              {/* Left Column */}
              <div className="xl:col-span-3 space-y-5">
                <AudioRecorder
                  onLiveUpdate={setLiveUpdate}
                  onResult={handleResult}
                  onAnalyzing={setIsAnalyzing}
                  onSessionComplete={handleSessionComplete}
                  onRecordingStateChange={setIsRecording}
                  stopRecordingRef={stopRecordingRef}
                  sessionId={sessionIdRef.current}
                  globalEventsRef={globalEventsRef}
                  eyeMetricsBufferRef={eyeMetricsBufferRef}
                  wsRef={wsRef}
                />
                
                {/* Live Transcript */}
                <LiveTranscriptViewer transcript={result?.transcript} liveUpdate={liveUpdate} isAnalyzing={isAnalyzing} />
                
                {/* Detailed Result Components — Restricted to HR after session */}
                {result && (userRole === "hr" || !isSessionDone) && (
                  <>
                    <MatchedPhrasesHighlighter
                      transcript={result.transcript}
                      matchedPhrases={result.matched_phrases}
                      matchedQuestion={result.matched_question}
                    />
                    <BehaviorStatsPanel metrics={result.speech_metrics} verdict={result.verdict} />
                    <IntegrityPanel events={result.integrity_events} videoUrl={result.video_url} />
                  </>
                )}
              </div>

              {/* Right Column */}
              <div className="xl:col-span-2 space-y-5">
                {/* Results and Scores — Restricted to HR after session */}
                {result ? (
                  (userRole === "hr" || !isSessionDone) && <RiskReportCard result={result} />
                ) : (
                  <div className="glass-card p-6">
                    <div className="flex justify-center mb-5">
                      <SimilarityGauge
                        score={liveSimilarity}
                        verdict={liveVerdict ?? (isAnalyzing ? "ANALYZING" : "GENUINE")}
                        label={liveUpdate ? "Live Similarity" : "Awaiting…"}
                      />
                    </div>
                    {!liveUpdate && !isAnalyzing && (
                      <p className="text-center text-gray-600 text-sm">Start recording to begin analysis</p>
                    )}
                  </div>
                )}

                {/* Top matches — Restricted to HR after session */}
                {result?.all_scores?.length > 0 && (userRole === "hr" || !isSessionDone) && (
                  <div className="glass-card p-5 animate-slide-up">
                    <p className="section-title mb-4">Top Similarity Matches</p>
                    <div className="space-y-3">
                      {result.all_scores.slice(0, 4).map((s, i) => (
                        <div key={i} className="flex items-center gap-3">
                          <div className="flex-1 min-w-0">
                            <p className="text-gray-300 text-xs truncate">{s.question}</p>
                            <div className="mt-1 h-1.5 bg-white/5 rounded-full overflow-hidden">
                              <div className="h-full rounded-full bg-indigo-500 transition-all duration-700"
                                style={{ width: `${Math.round(s.score * 100)}%` }} />
                            </div>
                          </div>
                          <span className="text-white text-xs font-mono font-bold tabular-nums shrink-0">
                            {Math.round(s.score * 100)}%
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Actions (HR Only) */}
                {result && !isAnalyzing && userRole === "hr" && (
                  <div className="space-y-3">
                    <button onClick={handleDownloadPDF}
                      className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-bold px-5 py-3 rounded-xl transition-all shadow-[0_0_20px_rgba(99,102,241,0.3)] text-sm">
                      📄 Download PDF Report
                    </button>
                    <button onClick={handleReset} className="btn-ghost w-full justify-center text-sm">
                      🔄 New Session
                    </button>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </main>

      <footer className="mt-16 border-t border-white/5 py-5 text-center text-gray-600 text-xs">
        SafeInterview v2 · Behaviour-based interview intelligence · All decisions require human review
      </footer>
    </div>
  );
}
