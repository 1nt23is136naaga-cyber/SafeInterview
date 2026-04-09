import axios from "axios";

export const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || (import.meta.env.DEV ? "" : "http://localhost:8000");

const api = axios.create({
    baseURL: BACKEND_URL,
    timeout: 600000, // 10 minutes
});



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
    // If VITE_BACKEND_URL is set (e.g. https://api.example.com), use it.
    // Otherwise fall back to current window location (for local dev or if hosted together).
    let backendBase = import.meta.env.VITE_BACKEND_URL;
    
    if (backendBase) {
        // Ensure https -> wss transformation
        const wsUrl = backendBase.replace(/^http/, "ws");
        return new WebSocket(`${wsUrl}/ws`);
    } else {
        const wsProtocol = window.location.protocol === "https:" ? "wss" : "ws";
        const wsHost = import.meta.env.DEV ? "localhost:8000" : window.location.host;
        return new WebSocket(`${wsProtocol}://${wsHost}/ws`);
    }
}

