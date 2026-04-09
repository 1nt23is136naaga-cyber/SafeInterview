import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    headers: {
      // Required for SharedArrayBuffer / MediaPipe WASM multi-threading
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    proxy: {
      "/analyze":              "http://localhost:8000",
      "/health":               "http://localhost:8000",
      "/upload-video":         "http://localhost:8000",
      "/upload-resume":        "http://localhost:8000",
      "/verify-resume-answer": "http://localhost:8000",
      "/uploads":              "http://localhost:8000",
      "/sessions":             "http://localhost:8000",
      "/baseline":             "http://localhost:8000",
      "/ws": {
        target: "ws://localhost:8000",
        ws: true,
      },
    },
  },
  optimizeDeps: {
    // MediaPipe tasks-vision ships its own WASM — exclude from pre-bundling
    exclude: ["@mediapipe/tasks-vision"],
  },
});
