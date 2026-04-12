# AntiGravity — Chrome Extension
## AI-Powered Interview Integrity Analyzer for Google Meet

---

## 📁 Directory Structure

```
chrome-extension/
├── manifest.json           ← Extension manifest (MV3)
├── background.js           ← Service worker (config routing, keep-alive)
├── content.js              ← Injected into meet.google.com — injects overlay + monitors events
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── lib/
│   └── jspdf.umd.min.js   ← jsPDF library (PDF generation, bundled locally)
├── options/
│   ├── options.html        ← Settings page (backend URL config)
│   ├── options.css
│   └── options.js
└── overlay/
    ├── overlay.html        ← Floating panel HTML shell
    ├── overlay.css         ← Dark glassmorphism design system
    └── overlay.js          ← Full 5-phase app logic (1000+ lines)
```

---

## 🚀 Installation (Development Mode)

### Step 1 — Backend
Make sure the FastAPI backend is running:
```bash
cd backend
uvicorn main:app --host 0.0.0.0 --port 8000
```
Or start via `start.bat` from the project root.

### Step 2 — Load Extension in Chrome
1. Open Chrome → navigate to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **"Load unpacked"**
4. Select the `e:\AntiGravity\Audio\chrome-extension` folder
5. The AntiGravity icon (⚡) will appear in the Chrome toolbar

### Step 3 — Configure Backend URL
- Click the ⚡ icon → **Options** (or right-click → Extension Options)
- Set Backend URL to your running backend:
  - Local: `http://localhost:8000`
  - Render: `https://your-app.onrender.com`
- Click **Test** to verify connection, then **Save**

### Step 4 — Use in Google Meet
1. Join a Google Meet call
2. The floating AntiGravity panel appears (bottom-right)
3. Follow the 5-phase workflow:
   - **Consent** → Confirm ethical use
   - **Setup** → Enter candidate name + role → Create session
   - **Baseline** → Record 2 intro answers (builds speech baseline)
   - **Live** → Start audio capture → Use speaker toggle → Monitor in real-time
   - **Report** → End session → Download PDF / JSON

---

## 🎙️ Audio Capture Guide

When you click **"Start Capture"** during the Live phase:

1. A system dialog appears — select **"Chrome Tab"** from the tab options
2. ✅ Make sure to tick **"Share tab audio"** before clicking Share
3. The overlay will confirm capture started

> **Why tab audio?** This captures the mixed Google Meet audio (both interviewer and candidate voices) — giving the AI full context for analysis.

> **Fallback:** If you cancel or your browser doesn't support `getDisplayMedia` audio, the extension falls back to **microphone capture** automatically.

### Speaker Mode (Manual Diarization)
- Toggle between **"👤 Interviewer"** and **"🎯 Candidate"** mode using the speaker buttons
- Only audio marked as **Candidate** is sent to the backend for analysis
- The VAD (voice activity detector) visualizes who is speaking in real-time

---

## 📊 Scoring System

| Component | Weight | Source |
|---|---|---|
| Speech Pattern Shift | 30% | Baseline delta (vs. intro phase) |
| Answer Originality / AI Detection | 40% | Semantic similarity + memorization + linguistic features |
| Behaviour Tracking | 30% | Tab switches + focus loss + behavior score |

| Score | Risk Level | Action |
|---|---|---|
| 0–33 | 🟢 Low | Proceed normally |
| 34–66 | 🟡 Medium | Ask follow-up questions |
| 67–100 | 🔴 High | Re-evaluate with deeper probing |

---

## 📄 PDF Report Sections

1. **Cover** — Candidate info, final score, risk level
2. **Behaviour Analysis** — Tab switches, focus losses, observations
3. **Speech Analysis** — Pauses, fillers, WPM, baseline comparison table
4. **Answer Analysis** — Semantic similarity, AI likelihood, structure score
5. **Session Timeline** — Chronological event log
6. **Final Interpretation** — Score breakdown bars + human-readable explanation
7. **Recommendation** — Actionable guidance for the interviewer

---

## 🔧 Backend New Endpoints (added for extension)

| Method | Path | Description |
|---|---|---|
| `POST` | `/sessions/{id}/event` | Append integrity event (tab switch, etc.) |
| `POST` | `/sessions/{id}/finalize` | Compute final score, persist to Supabase |
| `GET`  | `/sessions/{id}/report` | Retrieve finalised report |

---

## ⚖️ Ethics

- Analysis is strictly behavioural — no accent, language, or cultural judgment
- All audio processing happens on **your own backend** (no third-party AI APIs in the extension)
- Candidate consent banner shown before every session
- Report clearly labelled "supporting evidence, not definitive conclusions"
