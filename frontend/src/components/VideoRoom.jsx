import { useState, useEffect, useRef, useCallback } from "react";

/**
 * VideoRoom.jsx — Zoom/Meet-inspired 1-on-1 video interview room
 *
 * Uses WebRTC for peer-to-peer video/audio (PRIMARY path).
 * Falls back to WebSocket JPEG frame relay ONLY if WebRTC fails.
 * Signaling is done via the FastAPI WebSocket at /ws/room/{sessionId}.
 *
 * Props:
 *   sessionId      — room ID (same as HR session_id)
 *   role           — "hr" | "candidate"
 *   participantName — display name for this user
 *   onEnd          — callback when the call ends
 */

const ICE_SERVERS = {
  iceServers: [
    // Google STUN
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
    { urls: "stun:stun4.l.google.com:19302" },
    // Cloudflare STUN
    { urls: "stun:stun.cloudflare.com:3478" },
    // Open Relay free TURN servers (fallback for strict NAT)
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
  iceCandidatePoolSize: 10,
};

// ── Utilities ─────────────────────────────────────────────────────────────

function formatDuration(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function useAudioLevel(stream) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!stream) return;
    let ctx, rafId;
    try {
      ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const analyzer = ctx.createAnalyser();
      analyzer.fftSize = 256;
      src.connect(analyzer);
      const data = new Uint8Array(analyzer.frequencyBinCount);
      function tick() {
        analyzer.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        setLevel(avg);
        rafId = requestAnimationFrame(tick);
      }
      tick();
    } catch (_) {}
    return () => {
      cancelAnimationFrame(rafId);
      ctx?.close();
    };
  }, [stream]);
  return level;
}

// ── ControlButton ─────────────────────────────────────────────────────────
function CtrlBtn({ icon, label, onClick, active = true, danger = false, className = "", children }) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`flex flex-col items-center gap-1 px-3 py-2 rounded-2xl transition-all duration-200 text-sm font-medium select-none relative
        ${danger
          ? "bg-red-600 hover:bg-red-500 text-white"
          : active
            ? "bg-white/10 hover:bg-white/20 text-white"
            : "bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 border border-amber-500/40"
        } ${className}`}
    >
      <span className="text-xl">{icon}</span>
      <span className="text-[10px] opacity-80 hidden sm:block">{label}</span>
      {children}
    </button>
  );
}

// ── ConnectionQuality indicator ────────────────────────────────────────────
function ConnectionBadge({ iceState, wsRelay }) {
  if (iceState === "connected" || iceState === "completed") {
    return (
      <div className="flex items-center gap-1.5 text-xs text-emerald-400 font-medium">
        <span className="w-2 h-2 rounded-full bg-emerald-400" />
        Direct P2P
      </div>
    );
  }
  if (wsRelay) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-amber-400 font-medium">
        <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
        Relay Mode
      </div>
    );
  }
  if (iceState === "checking") {
    return (
      <div className="flex items-center gap-1.5 text-xs text-blue-400 font-medium">
        <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
        Connecting…
      </div>
    );
  }
  return null;
}

// ── Main Component ────────────────────────────────────────────────────────
export default function VideoRoom({ sessionId, role, participantName = "You", onEnd }) {
  const localVideoRef  = useRef(null);
  const remoteVideoRef = useRef(null);
  const pcRef          = useRef(null);
  const wsRef          = useRef(null);
  const localStreamRef = useRef(null);
  const makingOfferRef = useRef(false);
  const remoteStreamRef = useRef(null);

  // ── Integrity monitoring refs (candidate only) ────────────────────────
  const integrityEventsRef  = useRef([]);
  const audioRecorderRef    = useRef(null);
  const audioChunksRef      = useRef([]);
  const audioStartTimeRef   = useRef(null);

  const [status, setStatus]           = useState("Connecting…");
  const [peerJoined, setPeerJoined]   = useState(false);
  const [muted, setMuted]             = useState(false);
  const [cameraOff, setCameraOff]     = useState(false);
  const [showChat, setShowChat]       = useState(false);
  const [messages, setMessages]       = useState([]);
  const [chatInput, setChatInput]     = useState("");
  const [duration, setDuration]       = useState(0);
  const [unread, setUnread]           = useState(0);
  const [remoteStream, setRemoteStream] = useState(null);
  const [localStream, setLocalStream]   = useState(null);
  const [peerName, setPeerName]       = useState(role === "hr" ? "Candidate" : "Interviewer");
  const [analysisStatus, setAnalysisStatus] = useState(null);
  const [integrityWarning, setIntegrityWarning] = useState("");

  // ── Video display state ────────────────────────────────────────────────
  // webrtcActive: true when ice state is connected/completed → use <video> element
  // wsRelayActive: true immediately when peer joins, and remains true until WebRTC connects
  const [webrtcActive, setWebrtcActive]   = useState(false);
  const [wsRelayActive, setWsRelayActive] = useState(false);
  const [remoteFrame, setRemoteFrame]     = useState(null);
  const [iceState, setIceState]           = useState("new");
  const frameRelayRef = useRef(null);
  const wsRelayEnabledRef = useRef(false);

  const localLevel  = useAudioLevel(localStream);
  const remoteLevel = useAudioLevel(remoteStream);
  const localSpeaking  = localLevel  > 18;
  const remoteSpeaking = remoteLevel > 18;

  // ── Call timer ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!peerJoined) return;
    const t = setInterval(() => setDuration(d => d + 1), 1000);
    return () => clearInterval(t);
  }, [peerJoined]);

  // ── Integrity monitoring (candidate only) ─────────────────────────────
  useEffect(() => {
    if (role !== "candidate") return;

    const logEvent = (type, detail = "") => {
      const ev = { event_type: type, detail, timestamp: new Date().toISOString() };
      integrityEventsRef.current.push(ev);
      setIntegrityWarning(`⚠️ ${type.replace(/_/g, " ")} detected`);
      setTimeout(() => setIntegrityWarning(""), 3000);
    };

    const onVisChange = () => {
      if (document.visibilityState === "hidden") logEvent("tab_switch", "Tab hidden during interview");
    };
    const onBlur  = () => logEvent("focus_loss", "Window lost focus");
    const onCopy  = () => logEvent("copy",  "Text copied during interview");
    const onPaste = () => logEvent("paste", "Text pasted during interview");
    const onKey = (e) => {
      if ((e.altKey && e.key === "Tab") ||
          (e.ctrlKey && ["c", "v", "a"].includes(e.key.toLowerCase()))) {
        logEvent("sys_key_pressed", `${e.ctrlKey ? "Ctrl" : "Alt"}+${e.key}`);
      }
    };

    document.addEventListener("visibilitychange", onVisChange);
    window.addEventListener("blur", onBlur);
    document.addEventListener("copy", onCopy);
    document.addEventListener("paste", onPaste);
    document.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("visibilitychange", onVisChange);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("paste", onPaste);
      document.removeEventListener("keydown", onKey);
    };
  }, [role]);

  // ── Start audio recording when peer joins (candidate only) ────────────
  useEffect(() => {
    if (role !== "candidate" || !peerJoined || !localStreamRef.current) return;
    if (audioRecorderRef.current) return;

    try {
      const audioStream = new MediaStream(localStreamRef.current.getAudioTracks());
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus" : "audio/webm";
      const recorder = new MediaRecorder(audioStream, { mimeType });
      audioRecorderRef.current = recorder;
      audioChunksRef.current   = [];
      audioStartTimeRef.current = Date.now();

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      recorder.start(3000);
      setAnalysisStatus("recording");
    } catch (err) {
      console.error("[VideoRoom] audio recorder error:", err);
    }
  }, [peerJoined, role]);

  // ── Send via signaling WS ─────────────────────────────────────────────
  const send = useCallback((msg) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      // Don't send huge WS messages if we're connected to prevent WebSocket queue drops
      if (msg.type === "video-frame" && wsRelayEnabledRef.current === false) return;
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  // ── Assign remote srcObject robustly (called multiple times is safe) ──
  const attachRemoteStream = useCallback((rs) => {
    remoteStreamRef.current = rs;
    setRemoteStream(rs);
    // Directly set on the ref if it's already mounted
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = rs;
      remoteVideoRef.current.play().catch(() => {});
    }
  }, []);

  // ── Create RTCPeerConnection ──────────────────────────────────────────
  const createPC = useCallback((stream) => {
    const pc = new RTCPeerConnection(ICE_SERVERS);
    pcRef.current = pc;

    // Add local tracks
    stream.getTracks().forEach(t => pc.addTrack(t, stream));

    // Remote track handling — THIS is where the remote video comes from
    pc.ontrack = (ev) => {
      console.log("[VideoRoom] Remote track received:", ev.track.kind);
      const rs = ev.streams[0];
      if (rs) {
        attachRemoteStream(rs);
      }
    };

    // ICE candidates → relay via signaling
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        send({ type: "ice-candidate", candidate: ev.candidate });
      }
    };

    // ICE connection state — the most reliable indicator of actual media connectivity
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      console.log("[VideoRoom] ICE connection state:", s);
      setIceState(s);

      if (s === "connected" || s === "completed") {
        // WebRTC is working! Use it as primary, disable WS relay
        setWebrtcActive(true);
        setWsRelayActive(false);
        wsRelayEnabledRef.current = false;
        setStatus("Connected ✓");
        setPeerJoined(true);
        // Stop the frame relay to save bandwidth
        if (frameRelayRef.current) {
          clearInterval(frameRelayRef.current);
          frameRelayRef.current = null;
        }
      } else if (s === "failed" || s === "disconnected" || s === "closed") {
        // WebRTC failed or lost — fallback to WS relay
        console.warn("[VideoRoom] WebRTC lost — falling back to WS relay");
        setWebrtcActive(false);
        setWsRelayActive(true);
        wsRelayEnabledRef.current = true;
        if (s === "failed") setStatus("Relay Mode (Direct P2P Unavailable)");
        else if (s === "disconnected") setStatus("Connection interrupted — relaying…");
        else setStatus("Connection closed");
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      console.log("[VideoRoom] Connection state:", s);
      // We do NOT setPeerJoined(false) here, because peerJoined represents 
      // the WebSocket room presence. WebRTC failure is handled by ICE state fallback.
    };

    return pc;
  }, [send, attachRemoteStream]);

  // ── Handle incoming signaling messages ───────────────────────────────
  const pendingCandidatesRef = useRef([]);

  const handleSignal = useCallback(async (msg) => {
    const pc = pcRef.current;
    if (!pc) return;

    if (msg.type === "offer") {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      for (const c of pendingCandidatesRef.current) {
        try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
      }
      pendingCandidatesRef.current = [];
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: "answer", sdp: pc.localDescription });
    } else if (msg.type === "answer") {
      if (pc.signalingState !== "stable") {
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      }
    } else if (msg.type === "ice-candidate") {
      if (pc.remoteDescription) {
        try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch (_) {}
      } else {
        pendingCandidatesRef.current.push(msg.candidate);
      }
    } else if (msg.type === "chat") {
      setMessages(prev => [...prev, { from: msg.from, text: msg.text, ts: Date.now() }]);
      if (!showChat) setUnread(u => u + 1);
    } else if (msg.type === "video-frame") {
      // WS relay frame: only show if WebRTC is NOT working
      if (wsRelayEnabledRef.current) {
        setRemoteFrame(msg.data);
      }
    } else if (msg.type === "peer-joined") {
      setPeerJoined(true);
      // Immediately start relay mode so video works instantly while WebRTC connects
      setWsRelayActive(true);
      wsRelayEnabledRef.current = true;
      setStatus("Peer joined — establishing P2P connection…");
      setPeerName(msg.role === "hr" ? "Interviewer" : "Candidate");
      // HR always creates the offer
      if (role === "hr" && pc.signalingState === "stable" && !makingOfferRef.current) {
        try {
          makingOfferRef.current = true;
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          send({ type: "offer", sdp: pc.localDescription });
        } catch (e) {
          console.error("[VideoRoom] offer error", e);
        } finally {
          makingOfferRef.current = false;
        }
      }
    } else if (msg.type === "peer-left") {
      setPeerJoined(false);
      setWebrtcActive(false);
      setWsRelayActive(false);
      wsRelayEnabledRef.current = false;
      setRemoteFrame(null);
      setStatus("Other participant left");
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    }
  }, [role, send, showChat]);

  // ── Init: get media + connect WebSocket ──────────────────────────────
  useEffect(() => {
    let active = true;

    const init = async () => {
      try {
        setStatus("Requesting camera & microphone…");
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        if (!active) { stream.getTracks().forEach(t => t.stop()); return; }

        localStreamRef.current = stream;
        setLocalStream(stream);

        createPC(stream);

        setStatus("Joining room…");
        const proto = window.location.protocol === "https:" ? "wss" : "ws";
        const host  = window.location.host;
        const wsUrl = `${proto}://${host}/ws/room/${sessionId}?role=${role}`;

        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen  = () => { setStatus("Waiting for other participant…"); };
        ws.onmessage = (ev) => {
          try { handleSignal(JSON.parse(ev.data)); } catch (_) {}
        };
        ws.onerror = () => setStatus("Signaling error — check connection");
        ws.onclose = () => { if (active) setStatus("Disconnected from room"); };

      } catch (err) {
        if (!active) return;
        if (err?.name === "NotAllowedError") {
          setStatus("❌ Camera/mic permission denied");
        } else {
          setStatus(`❌ ${err?.message || "Could not start video"}`);
        }
      }
    };

    init();

    return () => {
      active = false;
      wsRef.current?.close();
      pcRef.current?.close();
      localStreamRef.current?.getTracks().forEach(t => t.stop());
      if (frameRelayRef.current) {
        clearInterval(frameRelayRef.current);
        frameRelayRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, role]);

  // ── WS Video Relay: run aggressively when wsRelayActive is true ───────
  useEffect(() => {
    // Only relay frames when WS relay is explicitly enabled
    if (!peerJoined || !localStream) return;
    if (!wsRelayActive) return;
    if (frameRelayRef.current) return;

    const canvas = document.createElement("canvas");
    canvas.width  = 640;
    canvas.height = 480;
    const ctx = canvas.getContext("2d");

    frameRelayRef.current = setInterval(() => {
      const vid = localVideoRef.current;
      if (!vid || !vid.videoWidth) return;
      try {
        ctx.drawImage(vid, 0, 0, 640, 480);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
        send({ type: "video-frame", data: dataUrl });
      } catch (_) {}
    }, 100); // 10 fps better quality instant fallback

    return () => {
      clearInterval(frameRelayRef.current);
      frameRelayRef.current = null;
    };
  }, [peerJoined, localStream, wsRelayActive, send]);

  // ── Assign local video srcObject when stream is ready ─────────────────
  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  // ── Assign remote video srcObject when stream arrives or ref mounts ───
  // This handles the case where the stream arrives before the DOM element
  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
      remoteVideoRef.current.play().catch(() => {});
    }
  }, [remoteStream]);

  // ── Controls ─────────────────────────────────────────────────────────
  const toggleMute = () => {
    if (!localStreamRef.current) return;
    localStreamRef.current.getAudioTracks().forEach(t => { t.enabled = !t.enabled; });
    setMuted(m => !m);
  };

  const toggleCamera = () => {
    if (!localStreamRef.current) return;
    localStreamRef.current.getVideoTracks().forEach(t => { t.enabled = !t.enabled; });
    setCameraOff(c => !c);
  };

  const sendChat = () => {
    const text = chatInput.trim();
    if (!text) return;
    send({ type: "chat", from: participantName, text });
    setMessages(prev => [...prev, { from: "You", text, ts: Date.now() }]);
    setChatInput("");
  };

  const openChat = () => {
    setShowChat(v => !v);
    setUnread(0);
  };

  const endCall = async () => {
    wsRef.current?.close();
    pcRef.current?.close();
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    if (frameRelayRef.current) {
      clearInterval(frameRelayRef.current);
      frameRelayRef.current = null;
    }

    if (role === "candidate" && audioRecorderRef.current) {
      const recorder = audioRecorderRef.current;

      const submitAudio = async () => {
        setAnalysisStatus("analyzing");
        try {
          const blob = new Blob(audioChunksRef.current, { type: "audio/webm" });
          const durationSec = audioStartTimeRef.current
            ? Math.round((Date.now() - audioStartTimeRef.current) / 1000)
            : duration;

          const form = new FormData();
          form.append("file", blob, "interview_audio.webm");
          form.append("duration", String(durationSec));
          form.append("session_id", sessionId);
          form.append("events_json", JSON.stringify(integrityEventsRef.current));
          form.append("eye_metrics_json", JSON.stringify({}));

          const resp = await fetch("/analyze", { method: "POST", body: form });
          if (resp.ok) {
            const result = await resp.json();
            result.candidate_name = participantName;

            await fetch(`/sessions/${sessionId}/result`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(result),
            });
            setAnalysisStatus("done");
          }
        } catch (err) {
          console.error("[VideoRoom] analysis submit failed:", err);
          setAnalysisStatus("done");
        }
        onEnd?.();
      };

      if (recorder.state === "recording") {
        recorder.onstop = submitAudio;
        recorder.stop();
      } else {
        await submitAudio();
      }
    } else {
      onEnd?.();
    }
  };

  // ── What to show in the remote video area ─────────────────────────────
  // Priority: WebRTC (direct) >> WS relay (fallback) >> Waiting screen
  const isDirectAudioActive = webrtcActive && remoteStream;
  const showWebRtcVideo = webrtcActive && remoteStream;
  const showWsRelay     = !showWebRtcVideo && remoteFrame; // If WebRTC isn't ready or failed, show the JSON frame
  const showWaiting     = !showWebRtcVideo && !showWsRelay;

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 bg-[#0a0a0f] flex flex-col" style={{ zIndex: 9999 }}>
      {/* ── Top Bar ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-5 py-3 bg-black/60 backdrop-blur-sm border-b border-white/8 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg bg-indigo-500/20 border border-indigo-400/40 flex items-center justify-center text-sm">🛡️</div>
          <span className="text-white font-semibold text-sm">SafeInterview</span>
          <span className="text-gray-600 text-xs">·</span>
          <span className="text-gray-400 text-xs font-mono">{sessionId}</span>
        </div>

        <div className="flex items-center gap-4">
          {/* Connection quality badge */}
          {peerJoined && (
            <ConnectionBadge iceState={iceState} wsRelay={wsRelayActive} />
          )}
          {/* Analysis recording indicator (candidate only) */}
          {role === "candidate" && analysisStatus === "recording" && (
            <div className="flex items-center gap-1.5 text-xs text-purple-400 font-medium">
              <span className="w-2 h-2 rounded-full bg-purple-500 animate-pulse" />
              ANALYZING
            </div>
          )}
          {role === "candidate" && analysisStatus === "analyzing" && (
            <div className="flex items-center gap-1.5 text-xs text-amber-400 font-medium">
              <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
              Processing…
            </div>
          )}
          {/* Recording indicator (HR) */}
          {peerJoined && role === "hr" && (
            <div className="flex items-center gap-1.5 text-xs text-red-400 font-medium">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              REC
            </div>
          )}
          {/* Timer */}
          {peerJoined && (
            <span className="font-mono text-sm text-emerald-400">{formatDuration(duration)}</span>
          )}
          {/* Status */}
          <span className="text-xs text-gray-500">{status}</span>
        </div>

        {/* Role badge */}
        <div className={`text-xs px-3 py-1 rounded-full font-medium border ${
          role === "hr"
            ? "bg-indigo-500/15 border-indigo-500/40 text-indigo-300"
            : "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
        }`}>
          {role === "hr" ? "👔 HR Manager" : "🎤 Candidate"}
        </div>
      </div>

      {/* ── Integrity warning flash (candidate) ── */}
      {integrityWarning && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 px-5 py-2.5 rounded-xl bg-red-600/90 backdrop-blur-sm border border-red-500 text-white text-sm font-semibold shadow-lg animate-bounce">
          {integrityWarning}
        </div>
      )}

      {/* ── Main video area ──────────────────────────────────── */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Remote video (fullscreen background) */}
        <div className="flex-1 relative bg-gray-950">

          {/* ── PRIMARY: WebRTC direct video stream ── */}
          {/* Always mounted so srcObject works; visible when webrtcActive */}
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            className={`w-full h-full object-cover absolute inset-0 transition-opacity duration-300 ${showWebRtcVideo ? "opacity-100" : "opacity-0 pointer-events-none"}`}
            style={{ maxHeight: "calc(100vh - 130px)" }}
          />

          {/* ── FALLBACK: WS Relay JPEG frames (only when WebRTC failed) ── */}
          {showWsRelay && (
            <img
              src={remoteFrame}
              alt="Remote participant (relay)"
              className="w-full h-full object-cover absolute inset-0"
              style={{ maxHeight: "calc(100vh - 130px)", imageRendering: "auto" }}
            />
          )}

          {/* ── WAITING / CONNECTING screen ── */}
          {showWaiting && (
            <div className="w-full h-full flex flex-col items-center justify-center gap-6">
              <div className="relative">
                <div className={`w-24 h-24 rounded-full border flex items-center justify-center text-5xl transition-all duration-500 ${
                  peerJoined
                    ? "bg-indigo-500/10 border-indigo-500/30 shadow-[0_0_30px_rgba(99,102,241,0.3)]"
                    : "bg-white/5 border-white/10"
                }`}>
                  {role === "hr" ? "🎤" : "👔"}
                </div>
                <div className={`absolute -bottom-1 -right-1 w-6 h-6 rounded-full border-2 border-gray-950 flex items-center justify-center text-xs ${
                  peerJoined ? "bg-indigo-500 animate-pulse" : "bg-amber-500/80"
                }`}>
                  {peerJoined ? "📡" : "⏳"}
                </div>
              </div>
              <div className="text-center">
                <p className="text-white font-semibold text-lg">
                  {peerJoined
                    ? "Connecting video…"
                    : `Waiting for ${role === "hr" ? "candidate" : "interviewer"}…`}
                </p>
                <p className="text-gray-500 text-sm mt-1">{status}</p>
              </div>
              <div className="flex gap-2">
                {[0, 1, 2].map(i => (
                  <div key={i} className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" style={{ animationDelay: `${i * 0.2}s` }} />
                ))}
              </div>
              {!peerJoined && (
                <div className="mt-2 bg-white/5 border border-white/10 rounded-xl px-5 py-3 text-xs text-gray-400 text-center">
                  <p>Share this session code with the {role === "hr" ? "candidate" : "interviewer"}:</p>
                  <p className="font-mono text-white text-base mt-1 tracking-widest">{sessionId.toUpperCase()}</p>
                </div>
              )}
            </div>
          )}

          {/* Remote participant name tag */}
          {peerJoined && (
            <div className="absolute flex flex-col gap-2 bottom-4 left-4 z-20">
              {showWsRelay && !isDirectAudioActive && (
                <div className="flex items-center gap-1.5 px-3 py-1 bg-amber-500/90 text-black text-xs font-bold rounded-lg shadow-lg">
                  <span className="w-2 h-2 rounded-full bg-black animate-pulse" />
                  Relay Mode (Fallback)
                </div>
              )}
              <div className="flex items-center gap-2 bg-black/60 backdrop-blur-sm px-3 py-1.5 rounded-xl border border-white/10 w-fit">
                <div className={`w-2 h-2 rounded-full ${remoteSpeaking ? "bg-emerald-400 animate-pulse" : "bg-gray-600"}`} />
                <span className="text-white text-sm font-medium">{peerName}</span>
              </div>
            </div>
          )}

          {/* ── Local PiP video (bottom right, always visible) ── */}
          <div className="absolute bottom-4 right-4 w-44 h-32 rounded-2xl overflow-hidden border-2 border-white/20 shadow-2xl bg-gray-900">
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className={`w-full h-full object-cover ${cameraOff ? "opacity-0" : ""}`}
            />
            {cameraOff && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-900">
                <span className="text-3xl">📷</span>
              </div>
            )}
            <div className="absolute bottom-1 left-1 right-1 flex items-center gap-1 bg-black/60 rounded-lg px-2 py-0.5">
              <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${localSpeaking && !muted ? "bg-emerald-400 animate-pulse" : "bg-gray-600"}`} />
              <span className="text-white text-[10px] truncate">{participantName}</span>
              {muted && <span className="text-[9px] text-amber-400 ml-auto">🔇</span>}
            </div>
            {localSpeaking && !muted && (
              <div className="absolute inset-0 rounded-2xl ring-2 ring-emerald-400 pointer-events-none animate-pulse" />
            )}
          </div>
        </div>

        {/* ── Chat sidebar ───────────────────────────────────── */}
        <div className={`shrink-0 bg-black/80 backdrop-blur-md border-l border-white/10 flex flex-col transition-all duration-300 ${showChat ? "w-80" : "w-0 overflow-hidden"}`}>
          {showChat && (
            <>
              <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
                <span className="text-white font-semibold text-sm">💬 Chat</span>
                <button onClick={() => setShowChat(false)} className="text-gray-500 hover:text-white text-lg">×</button>
              </div>

              <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
                {messages.length === 0 ? (
                  <p className="text-gray-600 text-xs text-center mt-8">No messages yet. Say hello! 👋</p>
                ) : (
                  messages.map((m, i) => (
                    <div key={i} className={`flex flex-col ${m.from === "You" ? "items-end" : "items-start"}`}>
                      <span className="text-[10px] text-gray-600 mb-0.5">{m.from}</span>
                      <div className={`px-3 py-2 rounded-2xl text-sm max-w-[85%] break-words ${
                        m.from === "You"
                          ? "bg-indigo-600 text-white"
                          : "bg-white/10 text-gray-200"
                      }`}>
                        {m.text}
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div className="px-4 py-3 border-t border-white/10 flex gap-2">
                <input
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && sendChat()}
                  placeholder="Type a message…"
                  className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-sm outline-none focus:border-indigo-500/60"
                />
                <button
                  onClick={sendChat}
                  disabled={!chatInput.trim()}
                  className="px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 text-white text-sm transition-all"
                >
                  →
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Bottom controls bar ──────────────────────────────── */}
      <div className="shrink-0 bg-black/70 backdrop-blur-md border-t border-white/8 px-6 py-3 flex items-center justify-center gap-3">
        <CtrlBtn
          icon={muted ? "🔇" : "🎤"}
          label={muted ? "Unmute" : "Mute"}
          onClick={toggleMute}
          active={!muted}
        />
        <CtrlBtn
          icon={cameraOff ? "📷" : "📹"}
          label={cameraOff ? "Start Video" : "Stop Video"}
          onClick={toggleCamera}
          active={!cameraOff}
        />
        <CtrlBtn
          icon="💬"
          label="Chat"
          onClick={openChat}
          active={true}
        >
          {unread > 0 && (
            <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white text-[9px] flex items-center justify-center">
              {unread}
            </span>
          )}
        </CtrlBtn>

        <div className="w-px h-8 bg-white/10 mx-2" />
        <CtrlBtn
          icon="📞"
          label={role === "hr" ? "End Interview" : "Leave"}
          onClick={endCall}
          danger
        />
      </div>
    </div>
  );
}
