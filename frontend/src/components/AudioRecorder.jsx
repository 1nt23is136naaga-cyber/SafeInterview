import { useState, useRef, useCallback, useEffect } from "react";
import { createWebSocket, analyzeAudio } from "../api";

const CHUNK_INTERVAL_MS = 3000;

/**
 * AudioRecorder — handles both file upload and real-time mic recording.
 * Exposes live analysis updates via onLiveUpdate and final result via onResult.
 */
export default function AudioRecorder({ onLiveUpdate, onResult, onAnalyzing, onSessionComplete, onRecordingStateChange, stopRecordingRef, sessionId, globalEventsRef, eyeMetricsBufferRef, wsRef }) {
    const [isRecording, setIsRecording] = useState(false);
    const [recordingTime, setRecordingTime] = useState(0);
    const [status, setStatus] = useState("idle"); // "idle" | "recording" | "processing" | "error"
    const [errorMsg, setErrorMsg] = useState("");
    const [waveformBars, setWaveformBars] = useState(Array(32).fill(4));


    const mediaRecorderRef = useRef(null);
    const localWsRef = useRef(null);
    const streamRef = useRef(null);

    const timerRef = useRef(null);
    const chunkTimerRef = useRef(null);
    const startTimeRef = useRef(null);
    const analyserRef = useRef(null);
    const animFrameRef = useRef(null);

    // Expose stopRecording to parent (App.jsx) via ref so End Meeting can trigger it
    useEffect(() => {
        if (stopRecordingRef) {
            stopRecordingRef.current = stopRecording;
        }
    });

    // Modifier key detection only (no content logged)
    useEffect(() => {
        if (!isRecording) return;
        const handleKeyDown = (e) => {
            if ((e.altKey && e.key === "Tab") || e.key === "Alt" || e.key === "Meta") {
                if (localWsRef.current && localWsRef.current.readyState === WebSocket.OPEN) {
                    localWsRef.current.send(JSON.stringify({
                        type: "integrity_event",
                        event_type: "sys_key_pressed",
                        details: `Modifier: ${e.key}`,
                        timestamp: Date.now()
                    }));
                }
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [isRecording]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            stopAllMedia();
        };
    }, []);

    function stopAllMedia() {
        if (timerRef.current) clearInterval(timerRef.current);
        if (chunkTimerRef.current) clearInterval(chunkTimerRef.current);
        if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
        if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
        if (localWsRef.current && localWsRef.current.readyState === WebSocket.OPEN) {
            localWsRef.current.close();
        }
    }

    // Animate waveform using AnalyserNode
    function animateWaveform(analyser) {
        const data = new Uint8Array(analyser.frequencyBinCount);
        const step = Math.floor(data.length / 32);

        function frame() {
            analyser.getByteFrequencyData(data);
            const bars = Array.from({ length: 32 }, (_, i) => {
                const val = data[i * step] || 0;
                return Math.max(4, Math.round((val / 255) * 60));
            });
            setWaveformBars(bars);
            animFrameRef.current = requestAnimationFrame(frame);
        }
        animFrameRef.current = requestAnimationFrame(frame);
    }



    // ── Mic Recording ────────────────────────────────────────────────────────

    async function startRecording() {
        setErrorMsg("");
        onLiveUpdate(null);
        onResult(null);

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;

            // Set up analyser for waveform
            const ctx = new AudioContext();
            const source = ctx.createMediaStreamSource(stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);
            analyserRef.current = analyser;
            animateWaveform(analyser);

            // Open WebSocket
            const ws = createWebSocket();
            localWsRef.current = ws;
            // Expose to App.jsx for eye metrics forwarding
            if (wsRef) wsRef.current = ws;

            ws.onopen = () => {
                setStatus("recording");
                setIsRecording(true);
                if (onRecordingStateChange) onRecordingStateChange(true);
                startTimeRef.current = Date.now();

                // Identify session to backend
                if (sessionId) {
                    ws.send(JSON.stringify({ type: "session_start", session_id: sessionId }));
                }

                timerRef.current = setInterval(() => {
                    setRecordingTime(Math.floor((Date.now() - startTimeRef.current) / 1000));
                }, 1000);
            };

            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === "transcript") {
                        onLiveUpdate(data);
                    } else if (data.type === "final") {
                        onResult(data);
                        onAnalyzing(false);
                    } else if (data.type === "error") {
                        console.warn("WS error:", data.message);
                    }
                } catch (e) {
                    console.error("WS parse error", e);
                }
            };

            ws.onerror = (e) => {
                setErrorMsg("WebSocket error. Ensure backend is running.");
                stopRecording();
            };

            ws.onclose = () => {
                if (isRecording) stopRecording();
            };

            // MediaRecorder — send chunks every 3s
            const recorder = new MediaRecorder(stream, {
                mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
                    ? "audio/webm;codecs=opus"
                    : "audio/webm",
            });
            mediaRecorderRef.current = recorder;

            recorder.ondataavailable = async (e) => {
                if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) {
                    const buffer = await e.data.arrayBuffer();
                    ws.send(buffer);
                }
            };

            recorder.start(CHUNK_INTERVAL_MS);

        } catch (err) {
            if (err.name === "NotAllowedError") {
                setErrorMsg("Microphone permission denied. Please allow mic access.");
            } else {
                setErrorMsg(`Could not start recording: ${err.message}`);
            }
            setStatus("idle");
        }
    }

    function stopRecording() {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
            mediaRecorderRef.current.stop();
        }
        if (timerRef.current) clearInterval(timerRef.current);
        if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
        if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());

        setWaveformBars(Array(32).fill(4));
        setIsRecording(false);
        if (onRecordingStateChange) onRecordingStateChange(false);
        setStatus("processing");
        onAnalyzing(true);

        // Signal backend to finalize 
        setTimeout(async () => {
            if (localWsRef.current && localWsRef.current.readyState === WebSocket.OPEN) {
                localWsRef.current.send("DONE");
            }
            if (onSessionComplete) onSessionComplete();
        }, 500);
    }

    const formatTime = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

    return (
        <div className="glass-card p-6 animate-fade-in">
            <p className="section-title">Audio Input</p>

            <div className="space-y-5 mt-4">
                    {/* Waveform */}
                    <div className="flex items-center justify-center gap-[2px] h-16 px-4 bg-black/20 rounded-xl overflow-hidden">
                        {waveformBars.map((h, i) => (
                            <div
                                key={i}
                                className={`w-1.5 rounded-full transition-all duration-75 ${isRecording ? "bg-primary" : "bg-white/20"
                                    }`}
                                style={{ height: `${h}px` }}
                            />
                        ))}
                    </div>

                    {/* Timer */}
                    <div className="text-center">
                        <span className={`text-4xl font-mono font-bold tabular-nums ${isRecording ? "text-primary" : "text-gray-500"}`}>
                            {formatTime(recordingTime)}
                        </span>
                        {isRecording && (
                            <div className="flex items-center justify-center gap-2 mt-1">
                                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                                <span className="text-red-400 text-sm font-medium">Recording</span>
                            </div>
                        )}
                        {status === "processing" && (
                            <p className="text-primary-light text-sm mt-1 animate-pulse">Processing your recording…</p>
                        )}
                    </div>

                    {/* Buttons */}
                    <div className="flex gap-3">
                        {!isRecording ? (
                            <button
                                onClick={startRecording}
                                disabled={status === "processing"}
                                className="btn-primary flex-1 justify-center"
                            >
                                <span>🎙️</span> Start Recording
                            </button>
                        ) : (
                            <button onClick={stopRecording} className="btn-danger flex-1 justify-center">
                                <span>⏹️</span> Stop & Analyze
                            </button>
                        )}
                    </div>
                </div>

            {/* Error */}
            {errorMsg && (
                <div className="mt-4 p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-sm flex items-start gap-2">
                    <span className="mt-0.5">⚠️</span>
                    <span>{errorMsg}</span>
                </div>
            )}
        </div>
    );
}
