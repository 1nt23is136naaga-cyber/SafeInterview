import { useState, useRef, useEffect } from "react";
import { BACKEND_URL, createWebSocket } from "./api";

function BackendStatus() {
  const [status, setStatus] = useState("checking");
  useEffect(() => {
    let active = true;
    const check = () =>
      fetch(`${BACKEND_URL}/health`)
        .then(() => { if (active) setStatus("online"); })
        .catch(() => { if (active) setStatus("offline"); });
    check();
    const id = setInterval(check, 5000);
    return () => { active = false; clearInterval(id); };
  }, []);
  const cfg = {
    online:   "bg-emerald-500/20 text-emerald-400",
    offline:  "bg-red-500/20 text-red-400",
    checking: "bg-gray-500/20 text-gray-400",
  }[status];
  return (
    <div className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold ${cfg}`}>
      <span className={`w-2 h-2 rounded-full ${status === "online" ? "bg-emerald-400 animate-pulse" : status === "offline" ? "bg-red-400" : "bg-gray-400"}`} />
      Backend: {status}
    </div>
  );
}

export default function App() {
  const [sessionId] = useState(() => `sess_${Date.now().toString(36)}`);
  const [phase, setPhase] = useState("idle"); // idle -> baseline -> monitoring
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [metrics, setMetrics] = useState(null);
  const [notification, setNotification] = useState(null);
  const [baselineProgress, setBaselineProgress] = useState(0);
  
  // Media references
  const audioStreamRef = useRef(null);
  const recorderRef = useRef(null);
  const wsRef = useRef(null);

  const notify = (msg, type = "success") => {
    setNotification({ msg, type });
    setTimeout(() => setNotification(null), 5000);
  };

  // Stop everything
  const stopAll = () => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach(t => t.stop());
      audioStreamRef.current = null;
    }
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send("DONE");
      // Keep it open to receive final message?
      setTimeout(() => {
        if (wsRef.current) {
          wsRef.current.close();
          wsRef.current = null;
        }
      }, 5000);
    }
    setIsRecording(false);
  };

  const requestAudioStream = async () => {
    if (audioStreamRef.current) return audioStreamRef.current;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "browser" },
        audio: true
      });
      // We don't need the video track, stop it to save resources
      stream.getVideoTracks().forEach(t => t.stop());
      audioStreamRef.current = stream;
      
      // If the user stops sharing via Chrome UI bar, handle it
      stream.getTracks().forEach(t => {
        t.onended = () => stopAll();
      });

      return stream;
    } catch (err) {
      console.error("Audio capture error:", err);
      alert("Failed to capture tab audio. Please make sure you share the tab with audio enabled.");
      return null;
    }
  };

  const startBaseline = async () => {
    const stream = await requestAudioStream();
    if (!stream) return;

    setPhase("baseline");
    setIsRecording(true);

    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    recorderRef.current = recorder;

    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = async () => {
      setIsRecording(false);
      setBaselineProgress(0);
      const blob = new Blob(chunks, { type: "audio/webm" });
      const base64data = await new Promise(r => {
        const reader = new FileReader();
        reader.onloadend = () => r(reader.result);
        reader.readAsDataURL(blob);
      });

      try {
        await fetch(`${BACKEND_URL}/baseline`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: sessionId,
            audio_base64: base64data,
            question_index: 0
          })
        });
        notify("Vocal signature captured! You're ready to start.", "success");
      } catch (err) {
        console.error(err);
        notify("Failed to save baseline: " + err.message, "error");
      }
    };

    recorder.start();
    
    // Animate progress
    const duration = 30000;
    const interval = 100;
    let elapsed = 0;
    const progressTimer = setInterval(() => {
      elapsed += interval;
      setBaselineProgress(Math.min((elapsed / duration) * 100, 100));
      if (elapsed >= duration) clearInterval(progressTimer);
    }, interval);

    // Auto-stop baseline after 30 seconds
    setTimeout(() => {
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
      setPhase("idle");
    }, duration);
  };

  const startLiveMonitor = async () => {
    const stream = await requestAudioStream();
    if (!stream) return;

    setPhase("monitoring");
    setIsRecording(true);
    setTranscript("");

    wsRef.current = createWebSocket();

    wsRef.current.onopen = () => {
      wsRef.current.send(JSON.stringify({ type: "session_start", session_id: sessionId }));
      
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
      recorderRef.current = recorder;

      recorder.ondataavailable = async (e) => {
        if (e.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
          const buffer = await e.data.arrayBuffer();
          // Sending as length-prefixed bytes if needed, but our backend handles raw bytes if we convert to list or base64 
          // Wait, backend expects {"bytes": [base64_string]} OR binary frames? 
          // Previous App.jsx didn't show WebSocket binary usage clearly.
          // In main.py: `if "bytes" in message` implies JSON with a base64 or array of bytes, OR binary.
          // BUT `message = await websocket.receive()` in FastAPI receives either text or bytes natively.
          // Actually, our previous frontend in AudioRecorder.jsx would do:
          // wait, let's just send JSON or binary. In main.py: `message["bytes"]` implies `receive()` returns a dict `{"bytes": b"..."}` if it's binary, or `{"text": "..."}` if it's text.
          wsRef.current.send(buffer);
        }
      };
      
      // Start recording, chunking every 5 seconds for live analysis
      recorder.start(5000);
    };

    wsRef.current.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "transcript" || data.type === "final") {
          setTranscript(prev => prev + " " + (data.transcript || ""));
          setMetrics(data);
        }
      } catch (e) {
        console.error(e);
      }
    };

    wsRef.current.onclose = () => {
      stopAll();
      setPhase("idle");
    };
  };

  const isBaseline = phase === "baseline";
  const isMonitor = phase === "monitoring";

  return (
    <div className="min-h-screen bg-[#0f0f17] text-white p-5 font-sans">
      <div className="flex justify-between items-center mb-8 border-b border-white/10 pb-4">
        <div>
          <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-indigo-400 to-purple-400">SafeInterview</h1>
          <p className="text-xs text-gray-400">GMeet Analyzer Plugin</p>
        </div>
        <BackendStatus />
      </div>

      {notification && (
        <div className={`mb-4 p-3 rounded-xl text-sm font-medium animate-in slide-in-from-top duration-300 border ${
          notification.type === "success" 
            ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400" 
            : "bg-red-500/10 border-red-500/20 text-red-400"
        }`}>
          {notification.msg}
        </div>
      )}

      <div className="space-y-6">
        <div className="bg-gray-800/40 p-5 rounded-2xl border border-white/5">
          <h2 className="text-lg font-semibold mb-2 flex items-center gap-2">
            1. Capture Baseline
            {isBaseline && <span className="flex h-3 w-3 relative"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span><span className="relative inline-flex rounded-full h-3 w-3 bg-indigo-500"></span></span>}
          </h2>
          <p className="text-sm text-gray-400 mb-4">
            Ask the candidate to introduce themselves. This captures their natural vocal signature (pitch, speed, pauses).
          </p>
          
          {isBaseline && (
            <div className="mb-4 bg-gray-900 h-2 rounded-full overflow-hidden border border-white/5">
              <div 
                className="h-full bg-indigo-500 transition-all duration-100 ease-linear shadow-[0_0_10px_rgba(99,102,241,0.5)]" 
                style={{ width: `${baselineProgress}%` }}
              />
            </div>
          )}

          <button
            onClick={isBaseline ? stopAll : startBaseline}
            disabled={isMonitor}
            className={`w-full py-3 rounded-xl font-bold transition-all shadow-lg ${
              isBaseline 
                ? "bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/50" 
                : "bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white disabled:opacity-50"
            }`}
          >
            {isBaseline ? "Interupt Signature Capture" : "Start Baseline Capture"}
          </button>
        </div>

        <div className="bg-gray-800/40 p-5 rounded-2xl border border-white/5">
          <h2 className="text-lg font-semibold mb-2 flex items-center gap-2">
            2. Live Monitor
            {isMonitor && <span className="flex h-3 w-3 relative"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span><span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span></span>}
          </h2>
          <p className="text-sm text-gray-400 mb-4">
            Start live interview. Detects plagiarism and compares voice tone against the baseline.
          </p>
          <button
            onClick={isMonitor ? stopAll : startLiveMonitor}
            disabled={isBaseline}
            className={`w-full py-3 rounded-xl font-bold transition-all ${
              isMonitor
                ? "bg-red-500/20 text-red-500 hover:bg-red-500/30 border border-red-500/50"
                : "bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50"
            }`}
          >
            {isMonitor ? "Stop Monitoring" : "Start Live Monitoring"}
          </button>
        </div>

        {metrics && (
          <div className="space-y-4 animate-fade-in mt-6">
            <h3 className="text-sm font-bold uppercase tracking-wider text-gray-400 mb-2">Live Analysis</h3>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-gray-900 p-4 rounded-xl border border-white/5 shadow-inner">
                <span className="text-xs text-gray-500 block mb-1">Speaker Identity</span>
                <span className={`text-xl font-bold ${
                    metrics.behavior_delta > 30 ? "text-red-400" : "text-emerald-400"
                  }`}>
                  {metrics.behavior_delta > 30 ? "False Positive" : "Legit"}
                </span>
                <div className="mt-2 h-1 w-full bg-gray-800 rounded-full overflow-hidden">
                  <div 
                    className={`h-full transition-all duration-500 ${metrics.behavior_delta > 30 ? "bg-red-500" : "bg-emerald-500"}`} 
                    style={{ width: `${Math.min(metrics.behavior_delta * 2, 100)}%` }}
                  />
                </div>
              </div>
              
              <div className="bg-gray-900 p-4 rounded-xl border border-white/5">
                <span className="text-xs text-gray-500 block mb-1">Plagiarism Risk</span>
                <span className={`text-xl font-bold ${
                    metrics.semantic_similarity > 0.7 ? "text-red-400" : 
                    metrics.semantic_similarity > 0.4 ? "text-yellow-400" : "text-emerald-400"
                  }`}>
                  {metrics.verdict}
                </span>
                <span className="text-xs text-gray-600 ml-2">{(metrics.semantic_similarity * 100).toFixed(0)}% Match</span>
              </div>
            </div>

            {/* Baseline Delta Details */}
            {metrics.behavior_delta > 30 && (
              <div className="bg-red-500/10 border border-red-500/20 p-3 rounded-xl text-sm text-red-300 mt-4">
                <strong className="block mb-1">Voice deviates from baseline:</strong>
                <p className="text-xs">Behavioral pattern mismatch detected ({metrics.behavior_delta.toFixed(1)}%). Possible scripted reading or third-party interference.</p>
              </div>
            )}

            <div className="bg-gray-900 p-4 rounded-xl border border-white/5 mt-4 max-h-[150px] overflow-y-auto w-full">
              <h4 className="text-xs text-gray-500 font-semibold mb-2 sticky top-0 bg-gray-900">Live Transcript</h4>
              <p className="text-sm text-gray-300 italic">
                {transcript || "Listening..."}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
