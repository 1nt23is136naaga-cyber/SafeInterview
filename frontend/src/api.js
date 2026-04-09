import axios from "axios";

export const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || (import.meta.env.DEV ? "" : "http://localhost:8000");

const api = axios.create({
    baseURL: BACKEND_URL,
    timeout: 600000, // 10 minutes
});

/**
 * Upload an audio file for full analysis.
 * @param {File} audioFile
 * @param {number} durationSeconds
 * @returns {Promise<AnalysisResult>}
 */
export async function analyzeAudio(audioFile, durationSeconds = 0) {
    const form = new FormData();
    form.append("file", audioFile);
    form.append("duration", String(durationSeconds));

    const response = await api.post("/analyze", form, {
        headers: { "Content-Type": "multipart/form-data" },
    });
    return response.data;
}

/**
 * Health check
 */
export async function healthCheck() {
    const response = await api.get("/health");
    return response.data;
}

/**
 * Create a WebSocket connection to the streaming endpoint.
 * @returns {WebSocket}
 */
export function createWebSocket() {
    let wsUrl = "";
    if (import.meta.env.VITE_BACKEND_URL) {
        wsUrl = import.meta.env.VITE_BACKEND_URL.replace(/^http/, "ws");
        return new WebSocket(`${wsUrl}/ws`);
    } else {
        const wsProtocol = window.location.protocol === "https:" ? "wss" : "ws";
        const wsHost = import.meta.env.DEV ? "localhost:8000" : window.location.host;
        return new WebSocket(`${wsProtocol}://${wsHost}/ws`);
    }
}

/**
 * Upload screen recording video.
 * @param {Blob} videoBlob
 * @returns {Promise<string>}
 */
export async function uploadVideo(videoBlob) {
    const form = new FormData();
    form.append("file", videoBlob, "screen_recording.webm");

    const response = await api.post("/upload-video", form, {
        headers: { "Content-Type": "multipart/form-data" },
    });
    return response.data;
}

/**
 * Upload a resume PDF and get analysis + questions.
 * @param {File} resumeFile
 */
export async function uploadResume(resumeFile) {
    const form = new FormData();
    form.append("file", resumeFile);
    const response = await api.post("/upload-resume", form, {
        headers: { "Content-Type": "multipart/form-data" },
    });
    return response.data;
}

/**
 * Verify a resume answer via audio base64.
 * @param {string} audioBase64
 * @param {string} question
 * @param {string} resumeText
 */
export async function verifyResumeAnswer(audioBase64, question, resumeText) {
    const response = await api.post("/verify-resume-answer", {
        audio_base64: audioBase64,
        question: question,
        resume_text: resumeText,
    });
    return response.data;
}
