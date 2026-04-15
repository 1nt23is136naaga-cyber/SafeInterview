/**
 * server.js — SafeInterview Plagiarism Checker
 * Uses Copyleaks REST API v3 + localtunnel for public webhook
 *
 * On startup:
 *   1. Opens a localtunnel to expose port 3100 publicly
 *   2. Uses that public URL as the Copyleaks webhook endpoint
 *   3. Copyleaks fires POST /webhook/{STATUS}/{scanId} when done
 *   4. Frontend polls GET /result/:scanId
 */

require("dotenv").config();

const express   = require("express");
const cors      = require("cors");
const rateLimit = require("express-rate-limit");
const { v4: uuidv4 } = require("uuid");
const axios     = require("axios");
const localtunnel = require("localtunnel");

const app  = express();
const PORT = process.env.PORT || 3100;

let PUBLIC_URL = ""; // set after tunnel opens

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.static("public"));

const checkLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many requests. Please wait a moment." },
});

// ─── State ────────────────────────────────────────────────────────────────────
const scanResults = new Map();

let _token = null;
let _tokenExpiry = 0;

// ─── Copyleaks helpers ────────────────────────────────────────────────────────
async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;
  const { data } = await axios.post(
    "https://id.copyleaks.com/v3/account/login/api",
    { email: process.env.COPYLEAKS_EMAIL, key: process.env.COPYLEAKS_API_KEY },
    { headers: { "Content-Type": "application/json" }, timeout: 15000 }
  );
  _token = data.access_token;
  _tokenExpiry = Date.now() + 47 * 60 * 60 * 1000;
  console.log("✅ Copyleaks token refreshed.");
  return _token;
}

async function submitText(token, scanId, text) {
  const base64 = Buffer.from(text, "utf-8").toString("base64");
  const webhookUrl = `${PUBLIC_URL}/webhook/{STATUS}/${scanId}`;

  await axios.put(
    `https://api.copyleaks.com/v3/education/submit/file/${scanId}`,
    {
      base64,
      filename: "answer.txt",
      properties: {
        sandbox: false,
        webhooks: { status: webhookUrl },
        filters: {
          minorChangesEnabled: true,
          relatedMeaningEnabled: true,
          identicalEnabled: true,
        },
      },
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 20000,
    }
  );

  console.log(`📤 Scan ${scanId} submitted. Webhook: ${webhookUrl}`);
}

/** Export the full report for a completed scan */
async function exportReport(token, scanId) {
  const exportId = `exp${uuidv4().replace(/-/g, "").substring(0, 12)}`;
  const webhookUrl = `${PUBLIC_URL}/export-done/${scanId}`;

  await axios.post(
    `https://api.copyleaks.com/v3/education/${scanId}/export/${exportId}`,
    {
      completionWebhook: webhookUrl,
      maxRetries: 2,
      results: {
        internet: [{ id: 0, verb: "get", endpoint: "/internet" }],
        score: { verb: "get", endpoint: "/score" },
      },
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    }
  );
}

function classifyScore(pct) {
  if (pct >= 50) return "copied";
  if (pct >= 20) return "suspicious";
  return "original";
}

function extractPct(payload) {
  // From Copyleaks export score endpoint
  const s = payload?.results?.score || payload?.score || payload;
  if (!s) return 0;
  const identical = (s.identicalWords ?? s.IdenticalWords ?? 0) * 100;
  const minor     = (s.minorChangedWords ?? s.MinorChangedWords ?? 0) * 100;
  const related   = (s.relatedMeaningWords ?? s.RelatedMeaningWords ?? 0) * 100;
  return Math.min(Math.round(identical + minor + related), 100);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /check-text → submit text to Copyleaks
 */
app.post("/check-text", checkLimiter, async (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== "string") return res.status(400).json({ error: "'text' is required." });
  const trimmed = text.trim();
  if (trimmed.length < 30)    return res.status(400).json({ error: "Text must be at least 30 characters." });
  if (trimmed.length > 25000) return res.status(400).json({ error: "Text exceeds 25,000 character limit." });

  const hasCredentials =
    process.env.COPYLEAKS_EMAIL && !process.env.COPYLEAKS_EMAIL.startsWith("your_") &&
    process.env.COPYLEAKS_API_KEY && !process.env.COPYLEAKS_API_KEY.startsWith("your_");

  // Generate a scan ID safe for Copyleaks (alphanumeric only, max 36 chars)
  const scanId = "si" + uuidv4().replace(/-/g, "").substring(0, 20);

  if (!hasCredentials || !PUBLIC_URL) {
    const score   = localHeuristicScore(trimmed);
    const verdict = classifyScore(score);
    scanResults.set(scanId, { status: "ready", score, verdict });
    return res.json({ scanId, message: "Demo mode — no API key or tunnel.", demo: true });
  }

  try {
    const token = await getToken();
    scanResults.set(scanId, { status: "pending" });
    await submitText(token, scanId, trimmed);
    return res.json({ scanId, message: "Scan submitted. Waiting for Copyleaks…", demo: false });
  } catch (err) {
    const msg = err?.response?.data
      ? JSON.stringify(err.response.data)
      : err.message;
    console.error("Submit error:", msg);
    return res.status(502).json({ error: `Copyleaks error: ${msg}` });
  }
});

/**
 * GET /result/:scanId → poll result
 */
app.get("/result/:scanId", (req, res) => {
  const result = scanResults.get(req.params.scanId);
  if (!result) return res.status(404).json({ error: "Scan not found." });
  return res.json(result);
});

/**
 * POST /webhook/:status/:scanId
 * Called by Copyleaks when a scan completes.
 * status = "completed" | "error" | "credits-checks-failed"
 */
app.post("/webhook/:status/:scanId", async (req, res) => {
  res.sendStatus(200); // always ACK first (Copyleaks requires fast response)

  const { status, scanId } = req.params;
  const payload = req.body;
  console.log(`📨 Webhook [${status}] for ${scanId}:`, JSON.stringify(payload).substring(0, 300));

  if (status === "error" || status === "credits-checks-failed") {
    scanResults.set(scanId, { status: "error", message: `Copyleaks: ${status}` });
    return;
  }

  if (status === "completed") {
    // Extract score from webhook payload
    // Copyleaks sends: { results: { score: { identicalWords, minorChangedWords, relatedMeaningWords } } }
    const pct     = extractPct(payload);
    const verdict = classifyScore(pct);
    scanResults.set(scanId, { status: "ready", score: pct, verdict });
    console.log(`✅ ${scanId}: ${pct}% → ${verdict}`);

    // If score is still 0, try triggering export to get full report
    if (pct === 0) {
      try {
        const token = await getToken();
        await exportReport(token, scanId);
        console.log(`📦 Export triggered for ${scanId}`);
      } catch (e) {
        console.warn("Export trigger failed:", e?.response?.data || e.message);
      }
    }
  }
});

/**
 * POST /export-done/:scanId
 * Fired by Copyleaks when export completes — holds the score endpoint data
 */
app.post("/export-done/:scanId", async (req, res) => {
  res.sendStatus(200);
  const { scanId } = req.params;
  const payload    = req.body;
  console.log(`📊 Export done for ${scanId}:`, JSON.stringify(payload).substring(0, 400));

  // The export completion payload has endpoint data for each requested field
  // Score endpoint: payload.score or payload.results.score
  if (payload?.score || payload?.results?.score) {
    const pct     = extractPct(payload);
    const verdict = classifyScore(pct);
    scanResults.set(scanId, { status: "ready", score: pct, verdict });
    console.log(`✅ Export score ${scanId}: ${pct}% → ${verdict}`);
  }
});

/**
 * GET /health
 */
app.get("/health", async (req, res) => {
  const configured = !!(process.env.COPYLEAKS_EMAIL && !process.env.COPYLEAKS_EMAIL.startsWith("your_"));
  let tokenOk = false;
  if (configured) { try { await getToken(); tokenOk = true; } catch {} }
  return res.json({
    status: "ok",
    service: "SafeInterview Plagiarism Checker",
    copyleaksConfigured: configured,
    tokenValid: tokenOk,
    tunnelUrl: PUBLIC_URL || "(not ready)",
    mode: configured && PUBLIC_URL ? "live" : "demo",
  });
});

// ─── Local heuristic fallback ─────────────────────────────────────────────────
function localHeuristicScore(text) {
  let score = 0;
  const lower = text.toLowerCase();
  const phrases = [
    "in conclusion","furthermore","it is important to note","as mentioned above",
    "in summary","the purpose of this","according to","it can be argued",
    "in recent years","studies have shown","it is widely accepted","as stated by",
    "one of the most","first and foremost","last but not least","on the other hand",
  ];
  score += Math.min(phrases.filter(p => lower.includes(p)).length * 7, 35);
  const words = text.split(/\s+/).filter(Boolean);
  const ratio = new Set(words.map(w => w.toLowerCase().replace(/[^a-z]/g,""))).size / Math.max(words.length, 1);
  if (ratio < 0.40) score += 30; else if (ratio < 0.52) score += 15;
  if (/\(\d{4}\)|\[\d+\]|et al\.|ibid\./i.test(text)) score += 20;
  const sents = text.split(/[.!?]+/).filter(s => s.trim());
  const avg = sents.reduce((s,x) => s + x.split(/\s+/).length, 0) / Math.max(sents.length, 1);
  if (avg > 30) score += 15; else if (avg > 22) score += 7;
  return Math.min(Math.round(score), 100);
}

// ─── Start server + tunnel ────────────────────────────────────────────────────
app.listen(PORT, async () => {
  const configured = !!(process.env.COPYLEAKS_EMAIL && !process.env.COPYLEAKS_EMAIL.startsWith("your_"));

  console.log(`\n🚀 SafeInterview Plagiarism Checker`);
  console.log(`   Local: http://localhost:${PORT}`);

  if (configured) {
    console.log("   🔗 Opening localtunnel for Copyleaks webhooks...");
    try {
      const tunnel = await localtunnel({ port: PORT });
      PUBLIC_URL = tunnel.url;
      console.log(`   ✅ Public URL: ${PUBLIC_URL}`);
      console.log(`   🔗 Webhook base: ${PUBLIC_URL}/webhook/{STATUS}/{scanId}`);

      tunnel.on("error", (err) => {
        console.warn("⚠️  Tunnel error:", err.message, "— retrying...");
      });
      tunnel.on("close", () => {
        console.warn("⚠️  Tunnel closed. Webhooks will not work until server is restarted.");
        PUBLIC_URL = "";
      });
    } catch (tunnelErr) {
      console.warn("⚠️  Could not open localtunnel:", tunnelErr.message);
      console.warn("   Falling back to demo mode.");
    }
  }

  const mode = configured && PUBLIC_URL
    ? "🟢 Live (Copyleaks REST v3 + localtunnel)"
    : "🟡 Demo (local heuristic)";
  console.log(`   Mode: ${mode}\n`);
});
