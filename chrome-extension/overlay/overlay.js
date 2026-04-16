/**
 * overlay.js — AntiGravity Chrome Extension — Floating Panel App Logic
 *
 * 5-Phase State Machine:
 *   CONSENT → SETUP → BASELINE → LIVE → REPORT
 *
 * Audio: getDisplayMedia (tab audio, captures both speakers) with getUserMedia fallback.
 * Speaker diarization: manual mode toggle + VAD energy visualization.
 * Backend: FastAPI at configurable URL via chrome.storage / messages.
 * PDF: jsPDF (programmatic drawing, no html2canvas dependency).
 */

'use strict';

// ════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════════

const VERSION = '1.0.0';

const PHASE = {
  CONSENT:  'CONSENT',
  SETUP:    'SETUP',
  BASELINE: 'BASELINE',
  LIVE:     'LIVE',
  REPORT:   'REPORT',
};

const RISK = {
  LOW:    { label: 'Low Risk',    color: '#00e5a0', bg: 'rgba(0,229,160,0.10)',  threshold: 33 },
  MEDIUM: { label: 'Medium Risk', color: '#ffb347', bg: 'rgba(255,179,71,0.10)', threshold: 66 },
  HIGH:   { label: 'High Risk',   color: '#ff4757', bg: 'rgba(255,71,87,0.10)',  threshold: 100 },
};

const BASELINE_QUESTIONS = [
  'Please introduce yourself — tell us your name and something you enjoy outside of work.',
  'What drew you to apply for this position, and what excites you about it?',
];

const CHUNK_INTERVAL_MS    = 8000;   // Send accumulated audio every 8 s
const VAD_TICK_MS          = 100;    // VAD energy check interval
const VAD_SPEECH_THRESHOLD = 18;     // RMS energy threshold for speech detection
const MAX_TIMELINE_ITEMS   = 20;

// ════════════════════════════════════════════════════════════════════════════
// APPLICATION STATE
// ════════════════════════════════════════════════════════════════════════════

const S = {
  // Phase
  phase:             PHASE.CONSENT,
  backendUrl:        'https://safeinterview-1.onrender.com',

  // Session
  sessionId:         null,
  candidateName:     '',
  role:              '',
  sessionStartTime:  null,
  sessionEndTime:    null,

  // Baseline
  baselineQIndex:    0,
  baselineSamples:   [],

  // Audio capture
  displayStream:     null,
  audioCtx:          null,
  analyserNode:      null,
  mediaRecorder:     null,
  isCandidateSpeaking: false,
  audioBuffer:       [],           // MediaRecorder chunks (candidate mode only)

  // WebSocket
  ws:                null,
  wsRetryTimer:      null,

  // Timers
  chunkTimer:        null,
  vadTimer:          null,

  // Integrity events (from content script via postMessage)
  integrityEvents:   [],
  tabSwitchCount:    0,
  focusLossCount:    0,

  // Analysis accumulation
  analysisResults:   [],
  transcriptHistory: [],
  timeline:          [],

  // Live metrics display
  suspicionScore:    0,
  riskLevel:         'LOW',

  // Final
  finalReport:       null,
  isEndingSession:   false,
};

// ════════════════════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════════════════════

async function init() {
  try {
    const cfg = await getConfig();
    S.backendUrl = cfg.backendUrl || 'https://safeinterview-1.onrender.com';
  } catch { /* non-extension context / offline */ }

  window.addEventListener('message', handleParentMessage);
  render();
}

function getConfig() {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'GET_CONFIG' }, (resp) => {
        resolve(resp || {});
      });
    } else {
      resolve({});
    }
  });
}

// ════════════════════════════════════════════════════════════════════════════
// RENDER ENGINE
// ════════════════════════════════════════════════════════════════════════════

function render() {
  const app = document.getElementById('app');
  if (!app) return;

  switch (S.phase) {
    case PHASE.CONSENT:
      app.innerHTML = htmlConsent();
      bindConsent();
      break;
    case PHASE.SETUP:
      app.innerHTML = htmlSetup();
      bindSetup();
      break;
    case PHASE.BASELINE:
      app.innerHTML = htmlBaseline();
      bindBaseline();
      break;
    case PHASE.LIVE:
      app.innerHTML = htmlLive();
      bindLive();
      initLiveSession();
      break;
    case PHASE.REPORT:
      app.innerHTML = htmlReport();
      bindReport();
      break;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PHASE: CONSENT
// ════════════════════════════════════════════════════════════════════════════

function htmlConsent() {
  return `
  <div class="phase-container glass-card phase-consent">
    <div class="logo-header">
      <div class="logo-mark">⚡</div>
      <div>
        <div class="logo-name">AntiGravity</div>
        <div class="logo-sub">Interview Integrity Analyzer</div>
      </div>
    </div>

    <div class="consent-body">
      <div class="consent-icon">🔒</div>
      <h2 class="consent-title">Privacy &amp; Consent</h2>
      <div class="consent-description">
        <p>This tool analyses interview integrity using audio and behavioural signals. It will:</p>
        <ul class="consent-list">
          <li>✅ Capture Google Meet tab audio (both speakers)</li>
          <li>✅ Monitor tab focus / window activity</li>
          <li>✅ Analyse speech patterns &amp; response timing</li>
          <li>✅ Generate a confidential structured report</li>
        </ul>
        <div class="consent-ethics">
          <strong>⚖️ Ethics:</strong> Analysis is behavioural — not accent, language, or cultural style. Obtain candidate consent before use.
        </div>
      </div>

      <label class="consent-checkbox-row">
        <input type="checkbox" id="consent-chk" />
        <span>I understand and confirm candidate consent has been obtained</span>
      </label>

      <button id="consent-btn" class="btn btn-primary btn-full" disabled>
        Begin Session Setup →
      </button>
    </div>
  </div>`;
}

function bindConsent() {
  const chk = document.getElementById('consent-chk');
  const btn = document.getElementById('consent-btn');
  chk.addEventListener('change', () => {
    btn.disabled = !chk.checked;
    btn.classList.toggle('btn-glow', chk.checked);
  });
  btn.addEventListener('click', () => { S.phase = PHASE.SETUP; render(); });
}

// ════════════════════════════════════════════════════════════════════════════
// PHASE: SETUP
// ════════════════════════════════════════════════════════════════════════════

function htmlSetup() {
  return `
  <div class="phase-container glass-card">
    <div class="phase-header">
      <button class="btn-back" id="back-btn">← Back</button>
      <span class="phase-label">Session Setup</span>
      <span class="step-indicator">Step 1 of 3</span>
    </div>

    <div class="setup-content">
      <div class="setup-icon">🎯</div>
      <h2 class="section-title">Configure Session</h2>

      <div class="form-group">
        <label class="form-label" for="cand-name">Candidate Name *</label>
        <input type="text" id="cand-name" class="form-input"
          placeholder="e.g. Jane Smith" value="${esc(S.candidateName)}" autocomplete="off" />
      </div>

      <div class="form-group">
        <label class="form-label" for="cand-role">Role / Position *</label>
        <input type="text" id="cand-role" class="form-input"
          placeholder="e.g. Senior Software Engineer" value="${esc(S.role)}" autocomplete="off" />
      </div>

      <div class="form-group">
        <label class="form-label" for="sess-id">Session ID <span class="label-optional">(auto-generated)</span></label>
        <input type="text" id="sess-id" class="form-input mono"
          placeholder="auto" value="${esc(S.sessionId || '')}" autocomplete="off" />
      </div>

      <div class="backend-indicator" id="be-status">
        <div class="indicator-dot"></div>
        <span>Checking backend…</span>
      </div>

      <button id="setup-btn" class="btn btn-primary btn-full">
        Start Baseline Phase →
      </button>
    </div>
  </div>`;
}

function bindSetup() {
  document.getElementById('back-btn').addEventListener('click', () => { S.phase = PHASE.CONSENT; render(); });
  checkHealth();

  document.getElementById('setup-btn').addEventListener('click', async () => {
    const name   = document.getElementById('cand-name').value.trim();
    const role   = document.getElementById('cand-role').value.trim();
    const sessId = document.getElementById('sess-id').value.trim();

    if (!name || !role) { toast('Please enter candidate name and role.', 'error'); return; }

    const btn = document.getElementById('setup-btn');
    btn.textContent = 'Creating session…';
    btn.disabled    = true;

    try {
      const res = await apiFetch('/sessions/create', {
        method: 'POST',
        body:   JSON.stringify({ candidate_name: name, role, session_id: sessId || undefined }),
      });
      S.sessionId    = res.session_id;
      S.candidateName = name;
      S.role         = role;
      S.phase        = PHASE.BASELINE;
      render();
    } catch (err) {
      toast(`Session error: ${err.message}`, 'error');
      btn.textContent = 'Start Baseline Phase →';
      btn.disabled    = false;
    }
  });
}

async function checkHealth() {
  const el = document.getElementById('be-status');
  if (!el) return;
  try {
    const d = await apiFetch('/health');
    el.innerHTML = `<div class="indicator-dot dot-green"></div><span>Backend online — ${d.service || 'ok'}</span>`;
  } catch {
    el.innerHTML = `<div class="indicator-dot dot-red"></div>
      <span>Backend unreachable — <a href="#" id="opts-link">Open Settings</a></span>`;
    document.getElementById('opts-link')?.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime?.openOptionsPage?.();
    });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PHASE: BASELINE
// ════════════════════════════════════════════════════════════════════════════

let blTimer    = null;
let blSeconds  = 0;
let blChunks   = [];
let blRecorder = null;
let blStream   = null;

function htmlBaseline() {
  const q        = BASELINE_QUESTIONS[S.baselineQIndex];
  const progress = (S.baselineQIndex / BASELINE_QUESTIONS.length) * 100;
  return `
  <div class="phase-container glass-card">
    <div class="phase-header">
      <span class="phase-badge badge-blue">Baseline Phase</span>
      <span class="step-indicator">${S.baselineQIndex + 1} / ${BASELINE_QUESTIONS.length}</span>
    </div>
    <div class="progress-bar-container">
      <div class="progress-bar" style="width:${progress}%"></div>
    </div>

    <div class="baseline-content">
      <div class="baseline-icon">🎙️</div>
      <p class="baseline-instruction">Read this question to the candidate:</p>

      <div class="question-card">
        <p class="question-text">"${esc(q)}"</p>
      </div>

      <div id="bl-record-wrap">
        <button id="bl-start-btn" class="btn btn-record">
          <span class="record-dot"></span>&nbsp; Start Recording Audio
        </button>
        <button id="bl-text-btn" class="btn btn-secondary" style="margin-top: 8px; width: 100%;">
          ⌨️ Type Answer Instead
        </button>
      </div>

      <div id="bl-text-wrap" class="hidden" style="margin-top: 15px;">
        <textarea id="bl-text-input" class="form-input" rows="3" placeholder="Type candidate baseline answer here..."></textarea>
        <button id="bl-submit-text-btn" class="btn btn-primary btn-full" style="margin-top: 8px;">
          Submit Text Answer
        </button>
        <button id="bl-cancel-text-btn" class="btn btn-secondary btn-full" style="margin-top: 8px;">
          Cancel
        </button>
      </div>

      <div id="bl-status" class="baseline-status hidden">
        <div class="recording-indicator">
          <span class="pulse-dot"></span>
          <span id="bl-timer">0:00</span>
          <span>Recording…</span>
        </div>
        <div class="audio-bars" id="bl-bars">
          ${'<div class="audio-bar"></div>'.repeat(14)}
        </div>
        <button id="bl-stop-btn" class="btn btn-danger btn-sm">⏹ Stop &amp; Submit</button>
      </div>

      <div class="baseline-note">
        💡 Aim for a 20–60 second response to build a reliable speech baseline.
      </div>
    </div>
  </div>`;
}

function bindBaseline() {
  document.getElementById('bl-start-btn').addEventListener('click', startBaselineRecording);
  
  const recordWrap = document.getElementById('bl-record-wrap');
  const textWrap = document.getElementById('bl-text-wrap');
  const txtInput = document.getElementById('bl-text-input');
  
  document.getElementById('bl-text-btn').addEventListener('click', () => {
    recordWrap.classList.add('hidden');
    textWrap.classList.remove('hidden');
    txtInput.focus();
  });
  
  document.getElementById('bl-cancel-text-btn').addEventListener('click', () => {
    textWrap.classList.add('hidden');
    recordWrap.classList.remove('hidden');
    txtInput.value = '';
  });
  
  document.getElementById('bl-submit-text-btn').addEventListener('click', () => submitBaselineText(txtInput.value));
}

async function submitBaselineText(text) {
  if (!text.trim()) { toast('Please enter an answer.', 'error'); return; }
  
  document.getElementById('bl-submit-text-btn').textContent = 'Submitting...';
  document.getElementById('bl-submit-text-btn').disabled = true;
  
  try {
    await apiFetch('/baseline', {
      method: 'POST',
      body:   JSON.stringify({
        session_id:     S.sessionId,
        audio_base64:   "",
        question_index: S.baselineQIndex,
        is_text_mode:   true,
        text_input:     text.trim()
      }),
    });

    S.baselineSamples.push({ qIndex: S.baselineQIndex });
    S.baselineQIndex++;

    if (S.baselineQIndex >= BASELINE_QUESTIONS.length) {
      toast('✅ Baseline established! Starting live session…', 'success');
      await sleep(1200);
      S.phase           = PHASE.LIVE;
      S.sessionStartTime = new Date();
      render();
    } else {
      toast('✅ Answer recorded. Next question…', 'success');
      document.getElementById('bl-submit-text-btn').textContent = 'Submit Text Answer';
      document.getElementById('bl-submit-text-btn').disabled = false;
      document.getElementById('bl-text-input').value = '';
      await sleep(700);
      render();
    }
  } catch (err) {
    toast(`Baseline submission failed: ${err.message}`, 'error');
    document.getElementById('bl-submit-text-btn').textContent = 'Submit Text Answer';
    document.getElementById('bl-submit-text-btn').disabled = false;
  }
}

async function startBaselineRecording() {
  try {
    // Use microphone for baseline (less disruptive than screen share for intro)
    blStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 },
    });
  } catch (err) {
    toast(`Mic error: ${err.message}`, 'error');
    return;
  }

  blChunks  = [];
  blSeconds = 0;

  const mime = supportedMime();
  blRecorder = new MediaRecorder(blStream, mime ? { mimeType: mime } : {});
  blRecorder.ondataavailable = (e) => { if (e.data?.size > 0) blChunks.push(e.data); };
  blRecorder.start(500);

  // UI
  document.getElementById('bl-record-wrap').classList.add('hidden');
  document.getElementById('bl-status').classList.remove('hidden');

  blTimer = setInterval(() => {
    blSeconds++;
    const m = Math.floor(blSeconds / 60);
    const s = blSeconds % 60;
    const el = document.getElementById('bl-timer');
    if (el) el.textContent = `${m}:${String(s).padStart(2, '0')}`;
    animateBlBars();
  }, 1000);

  document.getElementById('bl-stop-btn').addEventListener('click', stopBaselineRecording, { once: true });
}

function animateBlBars() {
  document.querySelectorAll('#bl-bars .audio-bar').forEach((b) => {
    b.style.height = `${Math.random() * 22 + 4}px`;
  });
}

async function stopBaselineRecording() {
  clearInterval(blTimer);

  blRecorder.stop();
  blStream.getTracks().forEach((t) => t.stop());
  await new Promise((r) => blRecorder.addEventListener('stop', r, { once: true }));

  toast('Analysing baseline response…', 'info');

  try {
    const blob   = new Blob(blChunks, { type: blChunks[0]?.type || 'audio/webm' });
    const ab     = await blob.arrayBuffer();
    const b64    = arrayBufferToBase64(ab);

    await apiFetch('/baseline', {
      method: 'POST',
      body:   JSON.stringify({
        session_id:     S.sessionId,
        audio_base64:   b64,
        question_index: S.baselineQIndex,
      }),
    });

    S.baselineSamples.push({ qIndex: S.baselineQIndex });
    S.baselineQIndex++;

    if (S.baselineQIndex >= BASELINE_QUESTIONS.length) {
      toast('✅ Baseline established! Starting live session…', 'success');
      await sleep(1200);
      S.phase           = PHASE.LIVE;
      S.sessionStartTime = new Date();
      render();
    } else {
      toast('✅ Answer recorded. Next question…', 'success');
      await sleep(700);
      render();
    }
  } catch (err) {
    toast(`Baseline submission failed: ${err.message}`, 'error');
    render();   // Allow retry
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PHASE: LIVE MONITORING
// ════════════════════════════════════════════════════════════════════════════

function htmlLive() {
  return `
  <div class="live-phase" id="live-root">

    <!-- Header -->
    <div class="live-header">
      <div class="session-info">
        <span class="session-badge">🔴 LIVE</span>
        <span class="session-name">${esc(S.candidateName)}</span>
      </div>
      <div class="header-actions">
        <button class="btn-icon" id="minimise-btn" title="Minimise">−</button>
      </div>
    </div>

    <!-- Risk gauge -->
    <div class="risk-section">
      <div class="risk-gauge-container">
        <canvas id="risk-gauge" width="200" height="110"></canvas>
        <div class="risk-score-overlay">
          <span class="risk-score-value" id="score-val">--</span>
          <span class="risk-score-label" id="risk-lbl">Initialising…</span>
        </div>
      </div>
    </div>

    <!-- Audio capture -->
    <div class="capture-section" id="capture-section">
      <div class="capture-status" id="capture-status">
        <div class="indicator-dot dot-grey"></div>
        <span>Audio not started</span>
      </div>
      <button id="capture-btn" class="btn btn-primary btn-sm">🎙 Start Capture</button>
    </div>

    <!-- Speaker controls (hidden until capture starts) -->
    <div class="speaker-controls hidden" id="speaker-ctrl">
      <p class="speaker-label">Who is speaking?</p>
      <div class="speaker-toggle">
        <button class="speaker-btn active" data-mode="interviewer" id="mode-interviewer">
          👤 Interviewer
        </button>
        <button class="speaker-btn" data-mode="candidate" id="mode-candidate">
          🎯 Candidate
        </button>
      </div>
      <div class="vad-indicator">
        <div class="vad-bars" id="vad-bars">
          ${'<div class="vad-bar"></div>'.repeat(8)}
        </div>
        <span id="vad-label">Silence</span>
      </div>
    </div>

    <!-- Metrics grid -->
    <div class="metrics-grid">
      <div class="metric-card">
        <span class="metric-icon">⏸</span>
        <span class="metric-val" id="m-pauses">--</span>
        <span class="metric-lbl">Pauses</span>
      </div>
      <div class="metric-card">
        <span class="metric-icon">💬</span>
        <span class="metric-val" id="m-fillers">--</span>
        <span class="metric-lbl">Fill/min</span>
      </div>
      <div class="metric-card">
        <span class="metric-icon">🚀</span>
        <span class="metric-val" id="m-wpm">--</span>
        <span class="metric-lbl">WPM</span>
      </div>
      <div class="metric-card">
        <span class="metric-icon">⚠️</span>
        <span class="metric-val" id="m-tabs">${S.tabSwitchCount}</span>
        <span class="metric-lbl">Switches</span>
      </div>
    </div>

    <!-- Transcript -->
    <div class="transcript-section">
      <div class="section-label">Live Transcript</div>
      <div class="transcript-box" id="transcript-box">
        <span class="transcript-placeholder">Waiting for speech…</span>
      </div>
      <div class="live-text-submit" style="margin-top:10px; display:flex; gap:8px;">
        <input type="text" id="live-text-input" class="form-input" style="flex:1;" placeholder="Or type candidate answer…" />
        <button id="live-text-btn" class="btn btn-secondary btn-sm">💬 Send</button>
      </div>
    </div>

    <!-- Timeline -->
    <div class="timeline-section">
      <div class="section-label">Event Log</div>
      <div class="timeline-feed" id="timeline-feed">
        <div class="timeline-item">
          <span class="tl-icon">🎬</span>
          <span class="tl-time">${new Date().toLocaleTimeString()}</span>
          <span class="tl-event">Session started</span>
        </div>
      </div>
    </div>

    <!-- End button -->
    <div class="end-session-area">
      <button id="end-btn" class="btn btn-danger btn-full">
        ⏹ End Session &amp; Generate Report
      </button>
    </div>
  </div>`;
}

function bindLive() {
  document.getElementById('minimise-btn').addEventListener('click', toggleMinimise);
  document.getElementById('capture-btn').addEventListener('click', startAudioCapture);
  document.getElementById('mode-interviewer').addEventListener('click', () => setSpeakerMode('interviewer'));
  document.getElementById('mode-candidate').addEventListener('click',   () => setSpeakerMode('candidate'));
  document.getElementById('end-btn').addEventListener('click', handleEndSession);
  document.getElementById('live-text-btn').addEventListener('click', submitLiveText);
  document.getElementById('live-text-input').addEventListener('keypress', (e) => { if(e.key === 'Enter') submitLiveText(); });
  drawRiskGauge(0);
}

function submitLiveText() {
  const input = document.getElementById('live-text-input');
  const text = input.value.trim();
  if(!text || !S.ws || S.ws.readyState !== WebSocket.OPEN) return;
  
  S.ws.send(JSON.stringify({ type: 'text_answer', text: text }));
  input.value = '';
  tl('Simulated text transcript sent', '💬', 'info');
}

function initLiveSession() {
  tl('Session monitoring active', '📡', 'info');
  connectWebSocket();
}

// ════════════════════════════════════════════════════════════════════════════
// AUDIO CAPTURE (getDisplayMedia → getUserMedia fallback)
// ════════════════════════════════════════════════════════════════════════════

async function startAudioCapture() {
  const btn      = document.getElementById('capture-btn');
  const statusEl = document.getElementById('capture-status');
  if (btn) { btn.textContent = 'Requesting…'; btn.disabled = true; }

  try {
    // ── Primary: capture tab audio via getDisplayMedia ────────────────────
    // Request minimal video so we can get tab audio (required by spec)
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: 1, height: 1, frameRate: 1 },   // minimal video
      audio: {
        echoCancellation:  false,
        noiseSuppression:  false,
        autoGainControl:   false,
        sampleRate:        16000,
      },
      preferCurrentTab: true,  // Chrome hint to pre-select the Meet tab
    });

    // Stop the video track immediately — we only need audio
    stream.getVideoTracks().forEach((t) => t.stop());

    if (stream.getAudioTracks().length === 0) {
      // User picked something without audio sharing enabled
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('No audio track — did you tick "Share tab audio"?');
    }

    onStreamReady(stream, 'Tab audio captured ✓', 'green');
    tl('DisplayMedia capture started (tab audio)', '🎙', 'success');

    // Handle user stopping the share externally
    stream.getAudioTracks()[0].addEventListener('ended', onCaptureStopped);

  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
      toast('Screen share cancelled — falling back to microphone.', 'warning');
      await startMicFallback();
    } else {
      toast(`Capture error: ${err.message}`, 'error');
      if (btn) { btn.textContent = '🎙 Start Capture'; btn.disabled = false; }
    }
  }
}

async function startMicFallback() {
  const statusEl = document.getElementById('capture-status');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 },
    });
    onStreamReady(stream, 'Microphone (fallback)', 'amber');
    tl('Microphone capture started (fallback mode)', '🎤', 'warning');
    // In mic mode default to candidate speaking (single-speaker assumption)
    setSpeakerMode('candidate');
  } catch (err) {
    toast(`Mic access denied: ${err.message}`, 'error');
  }
}

function onStreamReady(stream, label, colorClass) {
  S.displayStream = stream;

  // Audio analysis
  S.audioCtx    = new AudioContext();
  const src     = S.audioCtx.createMediaStreamSource(stream);
  S.analyserNode = S.audioCtx.createAnalyser();
  S.analyserNode.fftSize              = 256;
  S.analyserNode.smoothingTimeConstant = 0.75;
  src.connect(S.analyserNode);

  // MediaRecorder
  const mime = supportedMime();
  S.mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
  S.audioBuffer   = [];

  S.mediaRecorder.ondataavailable = (e) => {
    if (e.data?.size > 0 && S.isCandidateSpeaking) {
      S.audioBuffer.push(e.data);
    }
  };
  S.mediaRecorder.start(500);

  // Start periodic chunk sender
  S.chunkTimer = setInterval(flushAudioChunk, CHUNK_INTERVAL_MS);
  // Start VAD
  startVAD();

  // Update UI
  const statusEl = document.getElementById('capture-status');
  if (statusEl) {
    statusEl.innerHTML = `<div class="indicator-dot dot-${colorClass} pulse"></div><span>${label}</span>`;
  }
  document.getElementById('capture-btn')?.classList.add('hidden');
  document.getElementById('speaker-ctrl')?.classList.remove('hidden');
}

function onCaptureStopped() {
  clearInterval(S.chunkTimer);
  stopVAD();
  toast('Audio capture stopped. Click "End Session" when ready.', 'warning');
  tl('Audio capture stopped by user', '🔇', 'warning');
}

// ════════════════════════════════════════════════════════════════════════════
// SPEAKER MODE & VAD
// ════════════════════════════════════════════════════════════════════════════

function setSpeakerMode(mode) {
  const wasCandidate = S.isCandidateSpeaking;
  S.isCandidateSpeaking = (mode === 'candidate');

  document.querySelectorAll('.speaker-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });

  if (mode === 'candidate') {
    tl('Candidate started answering', '🎯', 'info');
  } else {
    // Flush any remaining candidate audio immediately
    if (wasCandidate && S.audioBuffer.length > 0) flushAudioChunk();
    tl('Interviewer speaking — analysis paused', '👤', 'neutral');
  }
}

function startVAD() {
  if (!S.analyserNode) return;
  const data = new Uint8Array(S.analyserNode.frequencyBinCount);

  S.vadTimer = setInterval(() => {
    if (!S.analyserNode) return;
    S.analyserNode.getByteFrequencyData(data);

    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] ** 2;
    const rms     = Math.sqrt(sum / data.length);
    const speech  = rms > VAD_SPEECH_THRESHOLD;

    updateVAD(rms, speech);
  }, VAD_TICK_MS);
}

function stopVAD() {
  if (S.vadTimer) { clearInterval(S.vadTimer); S.vadTimer = null; }
}

function updateVAD(rms, speech) {
  const bars  = document.querySelectorAll('#vad-bars .vad-bar');
  const label = document.getElementById('vad-label');

  bars.forEach((b) => {
    const h = speech ? Math.random() * Math.min(rms * 2, 36) + 4 : 4;
    b.style.height  = `${h}px`;
    b.style.opacity = speech ? '1' : '0.28';
  });

  if (label) {
    if (speech) {
      label.textContent = S.isCandidateSpeaking ? '🎯 Candidate speaking…' : '👤 Interviewer speaking…';
      label.style.color = S.isCandidateSpeaking ? '#6c63ff' : '#9898c0';
    } else {
      label.textContent = 'Silence';
      label.style.color = '#666';
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// WEBSOCKET
// ════════════════════════════════════════════════════════════════════════════

function connectWebSocket() {
  const wsUrl = S.backendUrl.replace(/^http/, 'ws') + '/ws';
  try {
    S.ws = new WebSocket(wsUrl);

    S.ws.onopen = () => {
      S.ws.send(JSON.stringify({ type: 'session_start', session_id: S.sessionId }));
    };

    S.ws.onmessage = (ev) => {
      try { handleWSMessage(JSON.parse(ev.data)); } catch {}
    };

    S.ws.onerror  = () => {};

    S.ws.onclose  = () => {
      if (S.phase === PHASE.LIVE) {
        S.wsRetryTimer = setTimeout(connectWebSocket, 3500);
      }
    };
  } catch {}
}

function handleWSMessage(data) {
  switch (data.type) {
    case 'transcript': onTranscript(data);     break;
    case 'final':      onFinalAnalysis(data);  break;
    case 'error':      console.warn('[WS]', data.message); break;
  }
}

function onTranscript(data) {
  const text = data.transcript || '';
  if (!text) return;

  const box = document.getElementById('transcript-box');
  if (box) box.innerHTML = `<p class="transcript-text">${esc(text)}</p>`;

  S.transcriptHistory.push({ time: new Date().toLocaleTimeString(), text });
  if (S.transcriptHistory.length > 50) S.transcriptHistory.shift();

  // Live anomaly preview from streaming baseline delta
  if (data.baseline_delta?.has_baseline) {
    const preview = Math.round((data.baseline_delta.baseline_anomaly_score || 0) * 60);
    updateLiveScore(preview);
  }
}

function onFinalAnalysis(data) {
  S.analysisResults.push(data);
  const score = computeLiveScore(data);
  updateLiveScore(score);

  const sm  = data.speech_metrics || {};
  setMetric('m-pauses',  sm.pause_count ?? '--');
  setMetric('m-fillers', sm.filler_count && sm.duration_seconds
    ? ((sm.filler_count / sm.duration_seconds) * 60).toFixed(1) : '--');
  setMetric('m-wpm', sm.speech_rate ? Math.round(sm.speech_rate * 60) : '--');

  const r = score >= 67 ? 'HIGH' : score >= 34 ? 'MEDIUM' : 'LOW';
  tl(`Analysis complete — ${RISK[r].label} (${score})`,
    r === 'HIGH' ? '🔴' : r === 'MEDIUM' ? '🟡' : '🟢', r.toLowerCase());
}

/** Compute a live suspicion score from a single analysis result. */
function computeLiveScore(data) {
  const sim   = (data.semantic_similarity  || 0) * 100;
  const mem   = (data.memorization_score   || 0) * 100;
  const beh   = (data.behavior_score       || 0) * 100;
  const ling  = data.linguistic_features   || {};
  const struc = (ling.structure_rigidity   || 0) * 100;
  const lin2  = (ling.linearity_score      || 0) * 100;

  const bd    = data.baseline_delta || {};
  const ano   = bd.has_baseline ? (bd.baseline_anomaly_score || 0) * 100 : beh * 0.5;

  const originality  = 0.4 * sim + 0.25 * mem + 0.15 * struc + 0.10 * lin2 + 0.10 * beh;
  const behaviorSc   = Math.min(beh * 0.6 + S.tabSwitchCount * 8 + S.focusLossCount * 5, 100);
  return Math.round(0.30 * ano + 0.40 * originality + 0.30 * behaviorSc);
}

function updateLiveScore(score) {
  score = Math.max(0, Math.min(score, 100));
  S.suspicionScore = score;
  const r = score >= 67 ? 'HIGH' : score >= 34 ? 'MEDIUM' : 'LOW';
  S.riskLevel = r;

  const sv = document.getElementById('score-val');
  const sl = document.getElementById('risk-lbl');
  if (sv) sv.textContent = score;
  if (sl) { sl.textContent = RISK[r].label; sl.style.color = RISK[r].color; }
  drawRiskGauge(score);
}

function setMetric(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

// ════════════════════════════════════════════════════════════════════════════
// AUDIO CHUNK FLUSH
// ════════════════════════════════════════════════════════════════════════════

async function flushAudioChunk() {
  if (!S.isCandidateSpeaking || S.audioBuffer.length === 0) return;
  if (!S.ws || S.ws.readyState !== WebSocket.OPEN) return;

  const chunks      = [...S.audioBuffer];
  S.audioBuffer     = [];

  try {
    const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
    const ab   = await blob.arrayBuffer();
    S.ws.send(ab);
  } catch {
    // Re-queue on failure
    S.audioBuffer = [...chunks, ...S.audioBuffer];
  }
}

// ════════════════════════════════════════════════════════════════════════════
// INTEGRITY EVENTS (from content script via window.postMessage)
// ════════════════════════════════════════════════════════════════════════════

function handleParentMessage(ev) {
  const d = ev.data;
  if (!d?.type) return;

  if (d.type === 'integrity_event' && S.phase === PHASE.LIVE) {
    S.integrityEvents.push({ ...d, received_at: new Date().toISOString() });

    if (d.event_type === 'tab_switch') {
      S.tabSwitchCount++;
      setMetric('m-tabs', S.tabSwitchCount);
      tl('Tab switch detected', '⚠️', 'warning');
    } else if (d.event_type === 'focus_loss') {
      S.focusLossCount++;
      tl('Window focus lost', '👁️', 'warning');
    } else if (d.event_type === 'tab_return') {
      tl('Returned to Meet tab', '↩', 'info');
    }

    // Forward to WebSocket
    if (S.ws?.readyState === WebSocket.OPEN) {
      S.ws.send(JSON.stringify(d));
    }
  }
}

function tl(text, icon = '•', type = 'info') {
  const time = new Date().toLocaleTimeString();
  S.timeline.push({ time, text, icon, type });

  const feed = document.getElementById('timeline-feed');
  if (!feed) return;

  const item = document.createElement('div');
  item.className = `timeline-item tl-${type}`;
  item.innerHTML  = `<span class="tl-icon">${icon}</span>
    <span class="tl-time">${time}</span>
    <span class="tl-event">${esc(text)}</span>`;
  feed.insertBefore(item, feed.firstChild);

  while (feed.children.length > MAX_TIMELINE_ITEMS) feed.removeChild(feed.lastChild);
}

// ════════════════════════════════════════════════════════════════════════════
// RISK GAUGE (arc canvas)
// ════════════════════════════════════════════════════════════════════════════

function drawRiskGauge(score) {
  const canvas = document.getElementById('risk-gauge');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H - 14, r = 78;

  ctx.clearRect(0, 0, W, H);

  // Background arc
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, 0);
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth   = 13;
  ctx.lineCap     = 'round';
  ctx.stroke();

  // Colour arc
  const normalized = Math.min(Math.max(score, 0), 100) / 100;
  const endAngle   = Math.PI + normalized * Math.PI;
  const color      = score < 34 ? '#00e5a0' : score < 67 ? '#ffb347' : '#ff4757';

  // Glow
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, endAngle);
  ctx.strokeStyle = color + '30';
  ctx.lineWidth   = 22;
  ctx.lineCap     = 'round';
  ctx.stroke();

  // Main arc
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, endAngle);
  ctx.strokeStyle = color;
  ctx.lineWidth   = 13;
  ctx.lineCap     = 'round';
  ctx.stroke();

  // Range labels
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.font      = '10px Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('0', cx - r - 10, cy + 5);
  ctx.textAlign = 'right';
  ctx.fillText('100', cx + r + 10, cy + 5);
}

// ════════════════════════════════════════════════════════════════════════════
// END SESSION
// ════════════════════════════════════════════════════════════════════════════

async function handleEndSession() {
  if (S.isEndingSession) return;
  S.isEndingSession = true;

  const btn = document.getElementById('end-btn');
  if (btn) { btn.textContent = 'Finalising…'; btn.disabled = true; }

  // Stop recording
  if (S.mediaRecorder?.state !== 'inactive') S.mediaRecorder?.stop();
  // Flush remaining audio
  if (S.audioBuffer.length > 0) await flushAudioChunk();

  // Signal backend done
  if (S.ws?.readyState === WebSocket.OPEN) {
    S.ws.send('DONE');
    await sleep(1800);
  }

  // Clean up
  S.displayStream?.getTracks().forEach((t) => t.stop());
  stopVAD();
  clearInterval(S.chunkTimer);
  S.ws?.close();
  clearTimeout(S.wsRetryTimer);

  S.sessionEndTime = new Date();

  await generateReport();
}

// ════════════════════════════════════════════════════════════════════════════
// REPORT GENERATION
// ════════════════════════════════════════════════════════════════════════════

async function generateReport() {
  try {
    // Attempt backend finalisation
    let backendReport = null;
    try {
      backendReport = await apiFetch(`/sessions/${S.sessionId}/finalize`, {
        method: 'POST',
        body:   JSON.stringify({
          integrity_events: S.integrityEvents,
          analysis_results: S.analysisResults,
        }),
      });
    } catch {}

    S.finalReport = buildReport(backendReport);
    S.phase       = PHASE.REPORT;
    render();
  } catch (err) {
    toast(`Report error: ${err.message}`, 'error');
    S.isEndingSession = false;
  }
}

function buildReport(backendData) {
  const dur = S.sessionStartTime && S.sessionEndTime
    ? Math.round((S.sessionEndTime - S.sessionStartTime) / 1000)
    : 0;
  const results = S.analysisResults;
  const n       = Math.max(results.length, 1);

  const avg = (key) => results.reduce((s, r) => s + (r[key] || 0), 0) / n;
  const avgN = (o, k) => results.reduce((s, r) => s + ((r[o] || {})[k] || 0), 0) / n;

  const sim       = avg('semantic_similarity');
  const mem       = avg('memorization_score');
  const beh       = avg('behavior_score');
  const structure = avgN('linguistic_features', 'structure_rigidity');
  const linearity = avgN('linguistic_features', 'linearity_score');

  const blResults  = results.filter((r) => r.baseline_delta?.has_baseline);
  const anomaly    = blResults.length
    ? blResults.reduce((s, r) => s + (r.baseline_delta?.baseline_anomaly_score || 0), 0) / blResults.length
    : beh * 0.5;

  const tabSwitches = S.integrityEvents.filter((e) => e.event_type === 'tab_switch').length;
  const focusLoss   = S.integrityEvents.filter((e) => e.event_type === 'focus_loss').length;

  const speechShift  = Math.round(anomaly * 100);
  const originality  = Math.round((0.4 * sim + 0.25 * mem + 0.2 * structure + 0.15 * linearity) * 100);
  const tabPenalty   = Math.min(tabSwitches * 8, 50);
  const focusPenalty = Math.min(focusLoss * 5, 30);
  const behaviorComb = Math.round(Math.min(beh * 60 + tabPenalty + focusPenalty, 100));

  // ── Adaptive weights (mirrors backend scoring.py logic) ───────────────────
  const BASE_W = { speech: 0.30, originality: 0.40, behavior: 0.30 };
  const BOOST   = 0.10;
  const STRONG  = 65;
  const w = { ...BASE_W };
  if (speechShift  >= STRONG) w.speech      += BOOST;
  if (originality  >= STRONG) w.originality += BOOST;
  if (behaviorComb >= STRONG) w.behavior    += BOOST;
  const wTotal = w.speech + w.originality + w.behavior;
  const adaptiveWeights = {
    speech:      +(w.speech      / wTotal).toFixed(3),
    originality: +(w.originality / wTotal).toFixed(3),
    behavior:    +(w.behavior    / wTotal).toFixed(3),
  };

  const finalScore = Math.round(
    adaptiveWeights.speech      * speechShift +
    adaptiveWeights.originality * originality +
    adaptiveWeights.behavior    * behaviorComb
  );
  // Use backend thresholds if available, else defaults
  const thLow = backendData?.report?.thresholds_used?.low_max    ?? 30;
  const thMed = backendData?.report?.thresholds_used?.medium_max ?? 65;
  const riskLevel = finalScore >= thMed ? 'HIGH' : finalScore >= thLow ? 'MEDIUM' : 'LOW';

  // ── Signal strength classification (mirrors backend scoring.py) ───────────
  function classifySignal(score) {
    if (score >= 65) return 'Strong';
    if (score >= 35) return 'Moderate';
    return 'Weak';
  }
  const signalStrengths = {
    speech:      classifySignal(speechShift),
    originality: classifySignal(originality),
    behavior:    classifySignal(behaviorComb),
  };

  // ── Confidence score (inter-signal agreement) ─────────────────────────────
  const vals      = [speechShift, originality, behaviorComb];
  const meanVal   = vals.reduce((a, b) => a + b, 0) / 3;
  const variance  = vals.reduce((s, v) => s + (v - meanVal) ** 2, 0) / 3;
  const stdDev    = Math.sqrt(variance);
  const confRaw   = Math.round(Math.max(0, Math.min(100 - stdDev * 1.5, 100)));
  const confLabel = confRaw >= 70 ? 'High' : confRaw >= 45 ? 'Moderate' : 'Low';
  const confExpl  = confRaw >= 70
    ? `${confRaw}% — High agreement across all signals`
    : confRaw >= 45
    ? `${confRaw}% — Moderate agreement; some signals diverge`
    : `${confRaw}% — Low agreement; signals conflict — manual review recommended`;

  const avgPauses  = Math.round(avgN('speech_metrics', 'pause_count'));
  const avgFillers = ((avgN('speech_metrics', 'filler_count') /
    Math.max(avgN('speech_metrics', 'duration_seconds'), 1)) * 60).toFixed(1);
  const avgWPM     = Math.round(avgN('speech_metrics', 'speech_rate') * 60);

  const baselineComparison = blResults.length ? {
    hasBaseline:   true,
    anomalyScore:  anomaly,
    speechRateDelta: avgN('baseline_delta', 'speech_rate_delta'),
    fillerDelta:   avgN('baseline_delta', 'filler_ratio_delta'),
    pauseDelta:    avgN('baseline_delta', 'pause_delta'),
  } : { hasBaseline: false };

  const speechObs  = buildSpeechObs(anomaly, avgFillers, blResults.length > 0);
  const answerObs  = buildAnswerObs(sim, mem, structure);
  const behavObs   = buildBehavObs(tabSwitches, focusLoss);

  const interpretation  = buildInterpretation(finalScore, riskLevel, speechShift, originality, behaviorComb, confLabel);
  const recommendation  = riskLevel === 'HIGH'
    ? 'Re-evaluate with deeper probing. Ask follow-up questions on topics with high similarity. Consider live coding / whiteboard to verify authenticity independently.'
    : riskLevel === 'MEDIUM'
    ? 'Ask targeted follow-up questions. Probe specific technical claims with open-ended questions to verify genuine understanding.'
    : 'No significant integrity concerns detected. Proceed normally with evaluation.';

  return {
    candidateName: S.candidateName,
    role:          S.role,
    sessionId:     S.sessionId,
    startTime:     S.sessionStartTime?.toISOString(),
    endTime:       S.sessionEndTime?.toISOString(),
    durationSeconds: dur,
    finalScore,
    riskLevel,
    speechShift,
    originality,
    behaviorCombined: behaviorComb,
    adaptiveWeights,
    signalStrengths,
    confidenceScore:  confRaw,
    confidenceLabel:  confLabel,
    confidenceExplanation: confExpl,
    avgPauseCount:  avgPauses,
    avgFillerRate:  avgFillers,
    avgWPM,
    baselineComparison,
    semanticSimilarity: Math.round(sim * 100),
    memorization:       Math.round(mem * 100),
    structureScore:     Math.round(structure * 100),
    tabSwitches,
    focusLoss,
    speechObservations:   speechObs,
    answerObservations:   answerObs,
    behaviorObservations: behavObs,
    interpretation,
    recommendation,
    timeline:         S.timeline,
    transcriptSamples: S.transcriptHistory.slice(-5),
    integrityEvents:  S.integrityEvents,
    backendReport:    backendData || null,
    generatedAt:      new Date().toISOString(),
  };
}

function buildSpeechObs(anomaly, avgFillers, hasBaseline) {
  const obs = [];
  if (hasBaseline) {
    if (anomaly > 0.7)       obs.push('Significant deviation from baseline speech patterns detected.');
    else if (anomaly > 0.4)  obs.push('Moderate shift in speech patterns vs. baseline.');
    else                     obs.push('Speech patterns consistent with established baseline.');
  }
  if (parseFloat(avgFillers) < 0.5) obs.push('Unusually low filler word usage — below natural threshold.');
  if (!obs.length) obs.push('Speech patterns appear natural with no obvious anomalies.');
  return obs;
}

function buildAnswerObs(sim, mem, structure) {
  const obs = [];
  if (sim > 0.75)       obs.push('High semantic similarity with known interview answer patterns.');
  else if (sim > 0.5)   obs.push('Moderate similarity to reference answers detected.');
  else                  obs.push('Response content appears original and personally constructed.');
  if (mem > 0.7)        obs.push('Response structure matches AI-generated or memorised patterns.');
  if (structure > 0.65) obs.push('Unusually formal transition phrases suggest structured external source.');
  if (!obs.length)      obs.push('No significant AI-pattern indicators detected.');
  return obs;
}

function buildBehavObs(tabs, focus) {
  const obs = [];
  if (tabs > 5)       obs.push(`Frequent tab switching (${tabs} times) — high suspicion.`);
  else if (tabs > 2)  obs.push(`${tabs} tab switches detected during the session.`);
  else if (tabs === 0) obs.push('No tab switches — candidate maintained focus throughout.');
  if (focus > 3)      obs.push('Window focus lost multiple times — possible second screen usage.');
  return obs;
}

function buildInterpretation(score, risk, speech, orig, beh, confLabel = '') {
  const confNote = confLabel ? ` (Confidence: ${confLabel})` : '';
  if (risk === 'HIGH') {
    const rs = [];
    if (speech > 60) rs.push('deviation from baseline speech patterns');
    if (orig > 60)   rs.push('high similarity to reference patterns');
    if (beh > 60)    rs.push('multiple distraction behaviours');
    return `High risk (${score}/100)${confNote}: combined signals — ${rs.join(', ') || 'multiple anomalies'}. Candidate may not be responding independently.`;
  }
  if (risk === 'MEDIUM') return `Medium risk (${score}/100)${confNote}. Some signals warrant investigation. Review specific areas with follow-up questions.`;
  return `Low risk (${score}/100)${confNote}. Natural speech patterns and genuine responses. No significant integrity concerns.`;
}

// ════════════════════════════════════════════════════════════════════════════
// PHASE: REPORT VIEW
// ════════════════════════════════════════════════════════════════════════════

function htmlReport() {
  const r    = S.finalReport;
  if (!r) return '<div class="phase-container"><p>No report data.</p></div>';

  const ri   = RISK[r.riskLevel];
  const dur  = fmtDuration(r.durationSeconds);
  const blRow = r.baselineComparison?.hasBaseline ? `
    <tr>
      <td>Baseline Anomaly</td>
      <td>${Math.round(r.baselineComparison.anomalyScore * 100)}/100</td>
      <td>${r.baselineComparison.anomalyScore > 0.6 ? '🔴 High' : r.baselineComparison.anomalyScore > 0.3 ? '🟡 Moderate' : '🟢 Normal'}</td>
    </tr>` : '';

  return `
  <div class="report-phase" id="report-root">

    <div class="report-header">
      <div class="report-logo">⚡ AntiGravity</div>
      <div class="report-title-row">
        <h2 class="report-title">Integrity Report</h2>
        <span class="risk-badge risk-${r.riskLevel.toLowerCase()}">${ri.label}</span>
      </div>
    </div>

    <!-- Score hero -->
    <div class="score-hero" style="border-color:${ri.color}33;background:${ri.bg}">
      <div class="score-number" style="color:${ri.color}">${r.finalScore}</div>
      <div class="score-subtitle">Suspicion Score / 100</div>
      <div class="score-breakdown">
        <div class="breakdown-item">
          <span class="breakdown-val">${r.speechShift}</span>
          <span class="breakdown-lbl">Speech <span style="opacity:0.6;font-size:9px">${+(r.adaptiveWeights?.speech*100||30).toFixed(0)}%</span></span>
        </div>
        <div class="breakdown-item">
          <span class="breakdown-val">${r.originality}</span>
          <span class="breakdown-lbl">Originality <span style="opacity:0.6;font-size:9px">${+(r.adaptiveWeights?.originality*100||40).toFixed(0)}%</span></span>
        </div>
        <div class="breakdown-item">
          <span class="breakdown-val">${r.behaviorCombined}</span>
          <span class="breakdown-lbl">Behaviour <span style="opacity:0.6;font-size:9px">${+(r.adaptiveWeights?.behavior*100||30).toFixed(0)}%</span></span>
        </div>
      </div>
    </div>

    <!-- Confidence Score banner -->
    <div class="confidence-banner conf-${(r.confidenceLabel||'low').toLowerCase()}">
      <div class="conf-icon">${r.confidenceLabel==='High'?'✅':r.confidenceLabel==='Moderate'?'⚠️':'🔶'}</div>
      <div class="conf-body">
        <div class="conf-title">Confidence: ${r.confidenceScore ?? '--'}%
          <span class="conf-badge conf-badge-${(r.confidenceLabel||'low').toLowerCase()}">${r.confidenceLabel ?? 'Low'} Agreement</span>
        </div>
        <div class="conf-desc">${esc(r.confidenceExplanation || '')}</div>
      </div>
    </div>

    <!-- Signal strength breakdown -->
    <div class="report-section signal-section">
      <h3 class="section-header">📶 Signal Strength Breakdown</h3>
      <table class="metrics-table">
        <thead><tr><th>Signal</th><th>Score</th><th>Strength</th><th>Weight</th></tr></thead>
        <tbody>
          <tr>
            <td>🎙 Speech Pattern</td>
            <td>${r.speechShift}</td>
            <td><span class="strength-badge strength-${(r.signalStrengths?.speech||'Weak').toLowerCase()}">${r.signalStrengths?.speech||'—'}</span></td>
            <td>${+(r.adaptiveWeights?.speech*100||30).toFixed(0)}%</td>
          </tr>
          <tr>
            <td>🔍 Answer Analysis</td>
            <td>${r.originality}</td>
            <td><span class="strength-badge strength-${(r.signalStrengths?.originality||'Weak').toLowerCase()}">${r.signalStrengths?.originality||'—'}</span></td>
            <td>${+(r.adaptiveWeights?.originality*100||40).toFixed(0)}%</td>
          </tr>
          <tr>
            <td>📊 Behaviour</td>
            <td>${r.behaviorCombined}</td>
            <td><span class="strength-badge strength-${(r.signalStrengths?.behavior||'Weak').toLowerCase()}">${r.signalStrengths?.behavior||'—'}</span></td>
            <td>${+(r.adaptiveWeights?.behavior*100||30).toFixed(0)}%</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Candidate info -->
    <div class="report-meta-grid">
      <div class="meta-item"><span class="meta-label">Candidate</span><span class="meta-val">${esc(r.candidateName)}</span></div>
      <div class="meta-item"><span class="meta-label">Role</span><span class="meta-val">${esc(r.role)}</span></div>
      <div class="meta-item"><span class="meta-label">Duration</span><span class="meta-val">${dur}</span></div>
      <div class="meta-item"><span class="meta-label">Session ID</span><span class="meta-val mono" style="font-size:10px">${esc(r.sessionId)}</span></div>
    </div>

    <div class="report-sections">

      <!-- Behaviour -->
      <div class="report-section">
        <h3 class="section-header">📊 Behaviour Analysis</h3>
        <div class="stat-row">
          <div class="stat-item">
            <span class="stat-val ${r.tabSwitches > 5 ? 'stat-danger' : r.tabSwitches > 2 ? 'stat-warn' : 'stat-ok'}">${r.tabSwitches}</span>
            <span class="stat-lbl">Tab Switches</span>
          </div>
          <div class="stat-item">
            <span class="stat-val ${r.focusLoss > 3 ? 'stat-danger' : 'stat-ok'}">${r.focusLoss}</span>
            <span class="stat-lbl">Focus Losses</span>
          </div>
          <div class="stat-item">
            <span class="stat-val">${dur}</span>
            <span class="stat-lbl">Duration</span>
          </div>
        </div>
        <div class="observations-list">
          ${r.behaviorObservations.map((o) => `<div class="obs-item">• ${esc(o)}</div>`).join('')}
        </div>
      </div>

      <!-- Speech -->
      <div class="report-section">
        <h3 class="section-header">🎙️ Speech Analysis</h3>
        <table class="metrics-table">
          <thead><tr><th>Metric</th><th>Value</th><th>Flag</th></tr></thead>
          <tbody>
            <tr><td>Avg. Pauses</td><td>${r.avgPauseCount}</td>
              <td>${r.avgPauseCount < 2 ? '⚠️ Very low' : '✅ Normal'}</td></tr>
            <tr><td>Fillers/min</td><td>${r.avgFillerRate}</td>
              <td>${parseFloat(r.avgFillerRate) < 0.5 ? '⚠️ Unusual' : '✅ Normal'}</td></tr>
            <tr><td>Speech Rate (WPM)</td><td>${r.avgWPM}</td>
              <td>${r.avgWPM > 180 ? '⚠️ Rapid' : r.avgWPM > 80 ? '✅ Normal' : r.avgWPM > 0 ? '⚠️ Slow' : '—'}</td></tr>
            ${blRow}
          </tbody>
        </table>
        <div class="observations-list">
          ${r.speechObservations.map((o) => `<div class="obs-item">• ${esc(o)}</div>`).join('')}
        </div>
      </div>

      <!-- Answer Analysis -->
      <div class="report-section">
        <h3 class="section-header">🔍 Answer Analysis</h3>
        <div class="stat-row">
          <div class="stat-item">
            <span class="stat-val ${r.semanticSimilarity > 70 ? 'stat-danger' : r.semanticSimilarity > 40 ? 'stat-warn' : 'stat-ok'}">${r.semanticSimilarity}%</span>
            <span class="stat-lbl">Similarity</span>
          </div>
          <div class="stat-item">
            <span class="stat-val ${r.memorization > 70 ? 'stat-danger' : r.memorization > 40 ? 'stat-warn' : 'stat-ok'}">${r.memorization}%</span>
            <span class="stat-lbl">AI Score</span>
          </div>
          <div class="stat-item">
            <span class="stat-val">${r.structureScore}%</span>
            <span class="stat-lbl">Structure</span>
          </div>
        </div>
        <div class="observations-list">
          ${r.answerObservations.map((o) => `<div class="obs-item">• ${esc(o)}</div>`).join('')}
        </div>
      </div>

      <!-- Timeline -->
      <div class="report-section">
        <h3 class="section-header">⏱️ Session Timeline</h3>
        <div class="report-timeline">
          ${r.timeline.slice(-18).map((t) =>
            `<div class="report-tl-item">
               <span class="report-tl-icon">${t.icon}</span>
               <span class="report-tl-time">${t.time}</span>
               <span class="report-tl-text">${esc(t.text)}</span>
             </div>`
          ).join('')}
        </div>
      </div>

      <!-- Interpretation -->
      <div class="report-section">
        <h3 class="section-header">💡 Final Interpretation</h3>
        <div class="interpretation-box" style="border-left-color:${ri.color}">
          <p>${esc(r.interpretation)}</p>
        </div>
      </div>

      <!-- Recommendation -->
      <div class="report-section recommendation-section" style="background:${ri.bg};border-color:${ri.color}33">
        <h3 class="section-header">📋 Recommendation</h3>
        <span class="recommendation-badge risk-${r.riskLevel.toLowerCase()}" style="background:${ri.color}22">
          ${r.riskLevel === 'HIGH' ? '🚨 Re-evaluate with deeper probing'
            : r.riskLevel === 'MEDIUM' ? '⚠️ Ask follow-up questions'
            : '✅ Proceed normally'}
        </span>
        <p class="recommendation-text">${esc(r.recommendation)}</p>
      </div>

      <!-- Reliability Note -->
      <div class="reliability-note">
        <span class="reliability-icon">ℹ️</span>
        <p>This assessment is based on multiple independent signals and should be used as <strong>decision support, not a final judgment</strong>. A high confidence score means signals agree; a low confidence score means signals conflict and manual review is recommended.</p>
      </div>

    </div>

    <!-- Downloads -->
    <div class="download-section">
      <button id="dl-pdf-btn" class="btn btn-primary btn-full">📄 Download PDF Report</button>
      <button id="dl-json-btn" class="btn btn-secondary btn-full">📦 Export JSON</button>
      <button id="new-sess-btn" class="btn btn-ghost btn-full">↩ New Session</button>
    </div>
  </div>`;
}

function bindReport() {
  document.getElementById('dl-pdf-btn') .addEventListener('click', () => downloadPDF(S.finalReport));
  document.getElementById('dl-json-btn').addEventListener('click', () => downloadJSON(S.finalReport));
  document.getElementById('new-sess-btn').addEventListener('click', () => {
    Object.assign(S, {
      phase: PHASE.SETUP, sessionId: null,
      baselineQIndex: 0, baselineSamples: [],
      integrityEvents: [], tabSwitchCount: 0, focusLossCount: 0,
      analysisResults: [], transcriptHistory: [], timeline: [],
      finalReport: null, suspicionScore: 0,
      isCandidateSpeaking: false,
      sessionStartTime: null, sessionEndTime: null,
      displayStream: null, audioBuffer: [],
      isEndingSession: false,
    });
    render();
  });
}

// ════════════════════════════════════════════════════════════════════════════
// PDF EXPORT (jsPDF — 4-page professional report)
// ════════════════════════════════════════════════════════════════════════════

async function downloadPDF(report) {
  const btn = document.getElementById('dl-pdf-btn');
  if (btn) { btn.textContent = 'Generating PDF…'; btn.disabled = true; }

  try {
    if (!window.jspdf) throw new Error('jsPDF library not loaded. Check lib/jspdf.umd.min.js');
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    const PW = 210, PH = 297, M = 18, CW = PW - 2 * M;
    let y = M;

    // ── Colour palette ──────────────────────────────────────────────────
    const riskRgb = {
      HIGH:   [255,  71,  87],
      MEDIUM: [255, 179,  71],
      LOW:    [  0, 229, 160],
    }[report.riskLevel] || [0, 229, 160];

    const ACCENT = [108, 99, 255];
    const DARK   = [ 18,  18,  48];
    const GREY   = [110, 110, 140];

    // ── Helper closures ─────────────────────────────────────────────────
    const rgb = (r, g, b)     => doc.setTextColor(r, g, b);
    const fill = (r, g, b)    => doc.setFillColor(r, g, b);
    const stroke = (r, g, b)  => doc.setDrawColor(r, g, b);

    function rect(x, ry, w, h, color, round = 0) {
      fill(...color);
      round ? doc.roundedRect(x, ry, w, h, round, round, 'F')
            : doc.rect(x, ry, w, h, 'F');
    }

    function h1(text, color = DARK) {
      doc.setFontSize(22); doc.setFont('helvetica', 'bold'); rgb(...color);
      doc.text(text, M, y); y += 9;
    }

    function h2(text) {
      doc.setFontSize(11); doc.setFont('helvetica', 'bold'); rgb(...ACCENT);
      rect(M, y, CW, 6, [240, 240, 255], 2);
      doc.text(text, M + 3, y + 4.5); y += 10;
    }

    function body(text, color = GREY, size = 9) {
      doc.setFontSize(size); doc.setFont('helvetica', 'normal'); rgb(...color);
      const lines = doc.splitTextToSize(text, CW - 4);
      doc.text(lines, M, y);
      y += lines.length * 4.6;
    }

    function divider() {
      stroke(210, 210, 230); doc.setLineWidth(0.25);
      doc.line(M, y, PW - M, y); y += 5;
    }

    function pageBreak() {
      doc.addPage(); y = M;
      // Running header
      doc.setFontSize(8); doc.setFont('helvetica', 'normal'); rgb(...GREY);
      doc.text(`AntiGravity Integrity Report — ${report.candidateName}`, M, 11);
      doc.text(`Session: ${report.sessionId}`, PW - M, 11, { align: 'right' });
      stroke(210, 210, 230); doc.setLineWidth(0.2);
      doc.line(M, 13.5, PW - M, 13.5);
      y = 20;
    }

    function guard(needed = 22) {
      if (y + needed > PH - M) pageBreak();
    }

    // ════════════════════════ PAGE 1: COVER ═══════════════════════════
    rect(0, 0, PW, 7, ACCENT);
    rect(0, 7, PW, 75, [248, 249, 255]);

    doc.setFontSize(10); doc.setFont('helvetica', 'bold'); rgb(...ACCENT);
    doc.text('⚡ AntiGravity', M, 20);
    doc.setFontSize(8); doc.setFont('helvetica', 'normal'); rgb(...GREY);
    doc.text('AI-Powered Interview Integrity Analysis System', M, 26);

    y = 38;
    doc.setFontSize(22); doc.setFont('helvetica', 'bold'); rgb(...DARK);
    doc.text('Interview Integrity', M, y); y += 9;
    doc.text('Analysis Report', M, y); y += 6;
    doc.setFontSize(9); doc.setFont('helvetica', 'normal'); rgb(...GREY);
    doc.text('Confidential — For Interviewer Use Only', M, y); y += 20;

    // Big score panel
    rect(M, y, CW, 48, [250, 250, 255], 4);
    doc.setFontSize(52); doc.setFont('helvetica', 'bold'); rgb(...riskRgb);
    doc.text(String(report.finalScore), M + 14, y + 32);

    doc.setFontSize(16); rgb(...GREY);
    doc.text('/100', M + 44, y + 32);

    const riskStr = report.riskLevel === 'HIGH' ? '🔴 HIGH RISK'
                  : report.riskLevel === 'MEDIUM' ? '🟡 MEDIUM RISK' : '🟢 LOW RISK';
    doc.setFontSize(13); doc.setFont('helvetica', 'bold'); rgb(...riskRgb);
    doc.text(riskStr, M + 90, y + 18);

    doc.setFontSize(9); doc.setFont('helvetica', 'normal'); rgb(...GREY);
    doc.text(`Speech Shift:  ${report.speechShift}/100`,    M + 90, y + 27);
    doc.text(`Originality:   ${report.originality}/100`,    M + 90, y + 34);
    doc.text(`Behaviour:     ${report.behaviorCombined}/100`, M + 90, y + 41);
    y += 54;

    // Candidate info table
    const info = [
      ['Candidate Name', report.candidateName],
      ['Role / Position', report.role],
      ['Session ID',      report.sessionId],
      ['Interview Date',  new Date(report.startTime || Date.now()).toLocaleDateString()],
      ['Duration',        fmtDuration(report.durationSeconds)],
      ['Report Generated', new Date().toLocaleString()],
    ];

    info.forEach(([lbl, val]) => {
      guard(8);
      rect(M, y, 48, 6.5, [238, 238, 250]);
      doc.setFontSize(8); doc.setFont('helvetica', 'bold'); rgb(...GREY);
      doc.text(lbl, M + 2, y + 4.5);
      doc.setFont('helvetica', 'normal'); rgb(...DARK);
      doc.text(String(val), M + 50, y + 4.5);
      y += 7.5;
    });

    // Cover footer
    rect(0, PH - 11, PW, 11, [245, 245, 255]);
    doc.setFontSize(7); doc.setFont('helvetica', 'normal'); rgb(...GREY);
    doc.text(`CONFIDENTIAL — AntiGravity v${VERSION}`, PW / 2, PH - 4, { align: 'center' });

    // ════════════════════════ PAGE 2: BEHAVIOUR + SPEECH ═════════════
    pageBreak();

    h2('SECTION 1 — BEHAVIOUR ANALYSIS');
    const behStats = [
      ['Tab Switches',   report.tabSwitches,      report.tabSwitches > 5 ? riskRgb : report.tabSwitches > 2 ? [255,179,71] : [0,229,160]],
      ['Focus Losses',   report.focusLoss,         report.focusLoss > 3 ? riskRgb : [0,229,160]],
      ['Behaviour Score', `${report.behaviorCombined}/100`, riskRgb],
    ];

    const sw = CW / 3;
    behStats.forEach(([lbl, val, clr], i) => {
      const sx = M + i * sw;
      rect(sx, y, sw - 4, 18, [248, 248, 255], 3);
      doc.setFontSize(15); doc.setFont('helvetica', 'bold'); rgb(...clr);
      doc.text(String(val), sx + (sw - 4) / 2, y + 11, { align: 'center' });
      doc.setFontSize(7); doc.setFont('helvetica', 'normal'); rgb(...GREY);
      doc.text(lbl, sx + (sw - 4) / 2, y + 17, { align: 'center' });
    });
    y += 22;

    doc.setFontSize(9); doc.setFont('helvetica', 'bold'); rgb(...DARK);
    doc.text('Observations:', M, y); y += 5;
    report.behaviorObservations.forEach((o) => {
      guard(8);
      const lines = doc.splitTextToSize(`• ${o}`, CW - 4);
      doc.setFont('helvetica', 'normal'); rgb(...GREY); doc.setFontSize(9);
      doc.text(lines, M + 2, y); y += lines.length * 4.6;
    });

    y += 5; divider();

    h2('SECTION 2 — SPEECH ANALYSIS');

    const speechRows = [
      ['Average Pause Count', report.avgPauseCount,  report.avgPauseCount < 2 ? '⚠ Very low' : '✓ Normal'],
      ['Fillers per Minute',  report.avgFillerRate,   parseFloat(report.avgFillerRate) < 0.5 ? '⚠ Unusual' : '✓ Normal'],
      ['Speech Rate (WPM)',   report.avgWPM,           report.avgWPM > 180 ? '⚠ Rapid' : report.avgWPM > 80 ? '✓ Normal' : '⚠ Slow'],
    ];
    if (report.baselineComparison?.hasBaseline) {
      speechRows.push([
        'Baseline Anomaly',
        `${Math.round(report.baselineComparison.anomalyScore * 100)}/100`,
        report.baselineComparison.anomalyScore > 0.6 ? '🚨 High shift'
          : report.baselineComparison.anomalyScore > 0.3 ? '⚠ Moderate' : '✓ Normal',
      ]);
    }

    const colW = [78, 36, 56];
    rect(M, y, CW, 6.5, [238, 238, 250]);
    ['Metric', 'Value', 'Assessment'].forEach((h, i) => {
      let cx = M + colW.slice(0, i).reduce((a, b) => a + b, 0) + 2;
      doc.setFontSize(8); doc.setFont('helvetica', 'bold'); rgb(...DARK);
      doc.text(h, cx, y + 4.5);
    });
    y += 7.5;

    speechRows.forEach((row, ri) => {
      guard(8);
      if (ri % 2 === 0) rect(M, y, CW, 6, [252, 252, 255]);
      row.forEach((cell, ci) => {
        let cx = M + colW.slice(0, ci).reduce((a, b) => a + b, 0) + 2;
        doc.setFontSize(8); doc.setFont('helvetica', 'normal'); rgb(...DARK);
        doc.text(String(cell), cx, y + 4);
      });
      y += 6.5;
    });

    y += 4;
    doc.setFontSize(9); doc.setFont('helvetica', 'bold'); rgb(...DARK);
    doc.text('Observations:', M, y); y += 5;
    report.speechObservations.forEach((o) => {
      guard(8);
      const lines = doc.splitTextToSize(`• ${o}`, CW - 4);
      doc.setFont('helvetica', 'normal'); rgb(...GREY); doc.setFontSize(9);
      doc.text(lines, M + 2, y); y += lines.length * 4.6;
    });

    // ════════════════════════ PAGE 3: ANSWER + TIMELINE ══════════════
    pageBreak();

    h2('SECTION 3 — ANSWER ANALYSIS');
    const ansStats = [
      ['Semantic Similarity', `${report.semanticSimilarity}%`, report.semanticSimilarity > 70 ? riskRgb : report.semanticSimilarity > 40 ? [255,179,71] : [0,229,160]],
      ['AI Likelihood',       `${report.memorization}%`,       report.memorization > 70 ? riskRgb : report.memorization > 40 ? [255,179,71] : [0,229,160]],
      ['Formal Structure',    `${report.structureScore}%`,     report.structureScore > 60 ? [255,179,71] : [0,229,160]],
    ];

    ansStats.forEach(([lbl, val, clr], i) => {
      const sx = M + i * sw;
      rect(sx, y, sw - 4, 18, [248, 248, 255], 3);
      doc.setFontSize(15); doc.setFont('helvetica', 'bold'); rgb(...clr);
      doc.text(String(val), sx + (sw - 4) / 2, y + 11, { align: 'center' });
      doc.setFontSize(7); doc.setFont('helvetica', 'normal'); rgb(...GREY);
      doc.text(lbl, sx + (sw - 4) / 2, y + 17, { align: 'center' });
    });
    y += 22;

    report.answerObservations.forEach((o) => {
      guard(8);
      const lines = doc.splitTextToSize(`• ${o}`, CW - 4);
      doc.setFont('helvetica', 'normal'); rgb(...GREY); doc.setFontSize(9);
      doc.text(lines, M + 2, y); y += lines.length * 4.6;
    });

    y += 5; divider();
    h2('SECTION 4 — SESSION TIMELINE');

    report.timeline.slice(0, 30).forEach((ev, ei) => {
      guard(7);
      if (ei % 2 === 0) rect(M, y, CW, 6, [252, 252, 255]);
      doc.setFontSize(8); doc.setFont('helvetica', 'bold'); rgb(...DARK);
      doc.text(ev.time || '', M + 2, y + 4);
      doc.setFont('helvetica', 'normal'); rgb(...GREY);
      doc.text(ev.text || '', M + 28, y + 4);
      y += 6.5;
    });

    // ════════════════════════ PAGE 4: INTERPRETATION + RECOMMENDATION ═
    pageBreak();

    h2('SECTION 5 — FINAL INTERPRETATION');
    const scoreComponents = [
      { label: 'Speech Pattern Shift (30%)',         value: report.speechShift,      color: ACCENT },
      { label: 'Answer Originality / AI Score (40%)', value: report.originality,      color: [255, 99, 132] },
      { label: 'Behaviour Tracking (30%)',            value: report.behaviorCombined, color: riskRgb },
    ];

    scoreComponents.forEach(({ label, value, color }) => {
      guard(12);
      doc.setFontSize(8); doc.setFont('helvetica', 'normal'); rgb(...DARK);
      doc.text(label, M, y);
      doc.text(`${value}/100`, PW - M, y, { align: 'right' });
      y += 5;

      rect(M, y, CW, 4, [235, 235, 250], 2);
      const fw = (Math.min(value, 100) / 100) * CW;
      if (fw > 0) rect(M, y, fw, 4, color, 2);
      y += 8;
    });

    y += 4;
    const interpLines = doc.splitTextToSize(report.interpretation, CW - 10);
    const interpH     = interpLines.length * 4.6 + 12;
    guard(interpH);

    doc.setDrawColor(...riskRgb); doc.setLineWidth(2.5);
    doc.line(M, y, M, y + interpH);
    doc.setLineWidth(0.3);
    rect(M + 4, y, CW - 4, interpH, [250, 250, 255]);
    doc.setFontSize(9); doc.setFont('helvetica', 'normal'); rgb(...DARK);
    doc.text(interpLines, M + 8, y + 7);
    y += interpH + 8;

    divider();

    h2('SECTION 6 — RECOMMENDATION');
    const recStr = report.riskLevel === 'HIGH'   ? 'RE-EVALUATE WITH DEEPER PROBING'
                 : report.riskLevel === 'MEDIUM' ? 'ASK FOLLOW-UP QUESTIONS'
                                                 : 'PROCEED NORMALLY';
    rect(M, y, CW, 10, riskRgb, 3);
    doc.setFontSize(11); doc.setFont('helvetica', 'bold'); rgb(255, 255, 255);
    doc.text(recStr, PW / 2, y + 6.5, { align: 'center' });
    y += 14;

    const recLines = doc.splitTextToSize(report.recommendation, CW - 4);
    doc.setFontSize(9); doc.setFont('helvetica', 'normal'); rgb(...DARK);
    doc.text(recLines, M, y); y += recLines.length * 4.6 + 10;

    // Ethics box
    guard(20);
    rect(M, y, CW, 18, [250, 250, 235], 2);
    doc.setFontSize(8); doc.setFont('helvetica', 'bold'); rgb(170, 120, 0);
    doc.text('⚠ Ethics & Bias Notice', M + 3, y + 6);
    const ethText = 'Analysis focuses on behavioural patterns — not accent, language, or cultural style. All findings are supporting evidence, not definitive conclusions.';
    const ethLines = doc.splitTextToSize(ethText, CW - 8);
    doc.setFont('helvetica', 'normal'); rgb(...GREY); doc.setFontSize(8);
    doc.text(ethLines, M + 3, y + 12);
    y += 22;

    // ── Page footers ──────────────────────────────────────────────────
    const total = doc.getNumberOfPages();
    for (let p = 1; p <= total; p++) {
      doc.setPage(p);
      rect(0, PH - 10, PW, 10, [245, 245, 255]);
      doc.setFontSize(7); doc.setFont('helvetica', 'normal'); rgb(...GREY);
      doc.text(`CONFIDENTIAL — AntiGravity v${VERSION} | Page ${p} of ${total}`, PW / 2, PH - 4, { align: 'center' });
    }

    const fname = `AntiGravity_Report_${report.candidateName.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.pdf`;
    doc.save(fname);
    toast('✅ PDF report downloaded!', 'success');

  } catch (err) {
    toast(`PDF error: ${err.message}`, 'error');
    console.error(err);
  } finally {
    if (btn) { btn.textContent = '📄 Download PDF Report'; btn.disabled = false; }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// JSON EXPORT
// ════════════════════════════════════════════════════════════════════════════

function downloadJSON(report) {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href:     url,
    download: `AntiGravity_${report.candidateName.replace(/\s+/g, '_')}_${Date.now()}.json`,
  });
  a.click();
  URL.revokeObjectURL(url);
  toast('JSON exported!', 'success');
}

// ════════════════════════════════════════════════════════════════════════════
// MINIMISE
// ════════════════════════════════════════════════════════════════════════════

let _minimised = false;

function toggleMinimise() {
  _minimised = !_minimised;
  window.parent.postMessage({ type: 'AG_RESIZE', mode: _minimised ? 'minimized' : 'normal' }, '*');
  const btn = document.getElementById('minimise-btn');
  if (btn) btn.textContent = _minimised ? '+' : '−';
}

// ════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ════════════════════════════════════════════════════════════════════════════

async function apiFetch(path, opts = {}) {
  const res = await fetch(S.backendUrl + path, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function fmtDuration(sec) {
  if (!sec || sec < 0) return '0:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toast(message, type = 'info') {
  const existing = document.getElementById('ag-toast');
  if (existing) existing.remove();

  const colors = { success: '#00e5a0', error: '#ff4757', warning: '#ffb347', info: '#6c63ff' };
  const t = document.createElement('div');
  t.id = 'ag-toast';
  Object.assign(t.style, {
    position:    'fixed',
    bottom:      '16px',
    left:        '50%',
    transform:   'translateX(-50%)',
    background:  'rgba(10,10,28,0.97)',
    color:       '#e8e8f8',
    padding:     '10px 18px',
    borderRadius: '10px',
    fontSize:    '12px',
    fontFamily:  'Inter, sans-serif',
    border:      `1px solid ${colors[type] || colors.info}`,
    zIndex:      '9999',
    maxWidth:    '290px',
    textAlign:   'center',
    boxShadow:   '0 6px 24px rgba(0,0,0,0.5)',
    animation:   'slideUp 0.3s ease',
  });
  t.textContent = message;
  document.body.appendChild(t);
  setTimeout(() => t?.remove(), 3500);
}

function supportedMime() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

function arrayBufferToBase64(buffer) {
  const bytes  = new Uint8Array(buffer);
  let binary   = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ════════════════════════════════════════════════════════════════════════════
// BOOT
// ════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', init);
