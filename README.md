# AI Interview Integrity Analyzer

A full-stack real-time web application that analyzes interview responses for possible scripting, memorization, or plagiarism — using speech-to-text, semantic embeddings, LLM evaluation, and behavioral speech analysis.

---

## 🏗️ Project Structure

```
Plagiarism_prototype/
├── backend/
│   ├── main.py          # FastAPI app + WebSocket
│   ├── stt.py           # faster-whisper transcription
│   ├── embeddings.py    # sentence-transformers similarity
│   ├── llm.py           # OpenAI memorization evaluator
│   ├── behavior.py      # speech metrics analysis
│   ├── database.py      # 8 mock Q&A reference answers
│   ├── requirements.txt
│   └── .env.example
└── frontend/
    ├── src/
    │   ├── App.jsx
    │   ├── api.js
    │   └── components/
    │       ├── AudioRecorder.jsx         # Upload + Mic recording
    │       ├── LiveTranscriptViewer.jsx  # Live transcript with cursor
    │       ├── SimilarityGauge.jsx       # Animated SVG gauge
    │       ├── RiskIndicator.jsx         # Verdict + score bars
    │       ├── BehaviorStatsPanel.jsx    # Speech metrics grid
    │       └── MatchedPhrasesHighlighter.jsx  # Highlighted transcript
    ├── tailwind.config.js
    └── vite.config.js
```

---

## 🚀 Setup & Run

### Prerequisites
- **Python 3.10+**
- **Node.js 18+**
- **ffmpeg** (required by faster-whisper for audio format conversion)
  - Windows: `winget install ffmpeg` or download from https://ffmpeg.org/download.html
  - Then add ffmpeg to your PATH

### 1. Backend Setup

```bash
cd backend

# Copy env file
cp .env.example .env

# (Optional) Add your OpenAI API key to .env for real LLM evaluation
# OPENAI_API_KEY=sk-...
# Without it, a heuristic mock evaluator will be used automatically.

# Create virtual environment
python -m venv venv
venv\Scripts\activate       # Windows
# source venv/bin/activate  # macOS/Linux

# Install dependencies
pip install -r requirements.txt

# Start server (downloads Whisper model ~145MB on first run)
uvicorn main:app --reload --port 8000
```

### 2. Frontend Setup

```bash
cd frontend
npm install
npm run dev
```

### 3. Open the App

Navigate to **http://localhost:5173**

---

## 🎯 How It Works

### Pipeline

```
Audio → Whisper STT → sentence-transformers → cosine similarity → embeddings score
                    ↘ OpenAI LLM → memorization score
                    ↘ text analysis → behavioral score
                    → weighted final score → verdict
```

### Scoring Formula
```
final_score = 0.50 × semantic_similarity
            + 0.30 × memorization_score
            + 0.20 × behavior_score
```

### Verdict Thresholds
| Score | Verdict |
|-------|---------|
| ≥ 0.70 | 🚨 Likely Scripted / Plagiarized |
| 0.40–0.70 | ⚠️ Suspicious |
| < 0.40 | ✅ Likely Genuine |

---

## 📡 API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/analyze` | POST | Full analysis of audio file (multipart) |
| `/ws` | WebSocket | Real-time streaming: binary audio chunks → live updates |

### WebSocket Protocol
- **Client → Server**: Binary audio chunks (webm/opus) every 3s
- **Client → Server**: Text `"DONE"` to finalize
- **Server → Client**: JSON `{type, transcript, semantic_similarity, verdict, chunk_index}`
- **Server → Client**: Final JSON with full analysis on `"DONE"`

---

## ⚙️ Configuration

Edit `backend/.env`:

```env
OPENAI_API_KEY=          # Leave blank for mock evaluator
OPENAI_MODEL=gpt-3.5-turbo
WHISPER_MODEL_SIZE=base   # tiny|base|small|medium|large-v3
CORS_ORIGINS=http://localhost:5173
```

---

## 🧪 Testing Scenarios

| Scenario | Expected Result |
|----------|----------------|
| Word-for-word database answer | 🚨 Scripted |
| Paraphrased version of a database answer | ⚠️ Suspicious |
| Completely unrelated original answer | ✅ Genuine |
| Very formal, no filler words | Higher behavior score |
| Casual with "uh", "um", pauses | Lower behavior score |

---

## 🔮 Real-Time Streaming

The live recording mode uses:
1. **MediaRecorder API** — captures mic in 3-second webm chunks
2. **WebSocket** — streams chunks to backend
3. **faster-whisper** — transcribes accumulated audio each chunk
4. **sentence-transformers** — computes live similarity after each update
5. UI updates transcript + gauge in real time

---

## 📦 Key Dependencies

### Backend
- `faster-whisper` — Whisper transcription (CPU-optimized)
- `sentence-transformers` — all-MiniLM-L6-v2 embeddings
- `fastapi` + `uvicorn` — async web framework
- `openai` — LLM evaluation (optional)
- `scikit-learn` — cosine similarity computation

### Frontend
- `react 18` + `vite` — UI framework
- `tailwindcss 3` — styling
- `axios` — HTTP client
- Native WebSocket + MediaRecorder APIs
