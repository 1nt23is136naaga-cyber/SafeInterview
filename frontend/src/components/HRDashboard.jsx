import { useState, useEffect, useRef, useCallback } from "react";
import { BACKEND_URL } from "../api";
import RiskReportCard from "./RiskReportCard";
import ProfessionalReport from "./ProfessionalReport";
import html2pdf from "html2pdf.js";

/**
 * HRDashboard.jsx — Full HR management panel for VeritasAI.
 * 
 * Features:
 *  - Stats overview (total sessions, avg risk, flagged)
 *  - Session list with live status indicator
 *  - Session creation (generates a session code for candidates)
 *  - Click any session to expand and view full RiskReportCard
 *  - Real-time session monitoring (polls /sessions endpoint)
 */

const RISK_COLOR = {
  GENUINE:   { text: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/25", dot: "bg-emerald-400" },
  REVIEW:    { text: "text-yellow-400",  bg: "bg-yellow-500/10 border-yellow-500/25",   dot: "bg-yellow-400" },
  SUSPICIOUS:{ text: "text-amber-400",   bg: "bg-amber-500/10 border-amber-500/25",     dot: "bg-amber-400" },
  HIGH_RISK: { text: "text-red-400",     bg: "bg-red-500/10 border-red-500/25",         dot: "bg-red-400" },
};

function StatCard({ icon, label, value, sub, accent = "indigo" }) {
  const accentMap = {
    indigo: "from-indigo-500/15 to-indigo-500/5 border-indigo-500/25 text-indigo-400",
    emerald:"from-emerald-500/15 to-emerald-500/5 border-emerald-500/25 text-emerald-400",
    amber:  "from-amber-500/15 to-amber-500/5 border-amber-500/25 text-amber-400",
    red:    "from-red-500/15 to-red-500/5 border-red-500/25 text-red-400",
  };
  return (
    <div className={`bg-gradient-to-br ${accentMap[accent]} rounded-2xl border p-5`}>
      <div className="text-2xl mb-2">{icon}</div>
      <div className="text-3xl font-extrabold text-white tabular-nums">{value}</div>
      <div className="text-sm font-medium mt-1">{label}</div>
      {sub && <div className="text-xs text-gray-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function SessionRow({ session, onClick, isActive }) {
  const rc = RISK_COLOR[session.risk_label] || RISK_COLOR.REVIEW;
  const riskPct = Math.round((session.final_score || 0) * 100);
  const date = session.created_at
    ? new Date(session.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })
    : "—";
  return (
    <div
      onClick={onClick}
      className={`glass-card px-5 py-4 cursor-pointer transition-all duration-200 group ${
        isActive ? "border-indigo-500/50 bg-indigo-500/5" : "hover:border-white/15"
      }`}
    >
      <div className="flex items-center gap-4">
        {/* Avatar */}
        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-500/30 to-purple-500/30 border border-white/15 flex items-center justify-center text-lg shrink-0">
          {session.candidate_name?.[0]?.toUpperCase() || "C"}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-white font-semibold text-sm truncate">{session.candidate_name || "Anonymous"}</p>
            {session.live && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30 font-medium flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" /> Live
              </span>
            )}
          </div>
          <p className="text-gray-500 text-xs mt-0.5">{date} · {session.session_id}</p>
        </div>

        {/* Risk badge */}
        {session.risk_label && (
          <div className={`px-3 py-1.5 rounded-xl border text-xs font-bold flex items-center gap-1.5 shrink-0 ${rc.bg}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${rc.dot}`} />
            <span className={rc.text}>{riskPct}%</span>
          </div>
        )}

        {/* Copy Link */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            const url = `${window.location.origin}/?session_id=${session.session_id}`;
            navigator.clipboard.writeText(url);
            alert("Interview Link Copied to Clipboard!");
          }}
          className="p-2 rounded-lg bg-white/5 hover:bg-indigo-500/20 text-gray-400 hover:text-indigo-400 transition-all border border-transparent hover:border-indigo-500/30"
          title="Copy Interview Link"
        >
          🔗
        </button>

        {/* Chevron */}
        <span className={`text-gray-600 group-hover:text-white transition-all text-sm ${isActive ? "rotate-90" : ""}`}>▶</span>
      </div>
    </div>
  );
}

function CreateSessionModal({ onClose, onCreate }) {
  const [name, setName]     = useState("");
  const [role, setRole]     = useState("Software Engineer");
  const [loading, setLoading] = useState(false);
  const [code, setCode]     = useState("");

  const handleCreate = async () => {
    if (!name.trim()) return;
    setLoading(true);
    try {
      const res = await fetch(`${BACKEND_URL}/sessions/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidate_name: name, role }),
      });
      const data = await res.json();
      setCode(data.session_id);
      onCreate(data);
    } catch {
      // Fallback: generate locally
      const sid = `sess_${Date.now().toString(36)}`;
      setCode(sid);
      onCreate({ session_id: sid, candidate_name: name, role, created_at: new Date().toISOString() });
    }
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-[#0d0d1a] border border-white/15 rounded-2xl p-8 max-w-md w-full shadow-2xl animate-fade-in">
        <h3 className="text-xl font-bold text-white mb-6">Create Interview Session</h3>

        {code ? (
          <div className="text-center space-y-4">
            <div className="text-5xl">✅</div>
            <div className="bg-black/40 rounded-xl px-4 py-3 border border-white/10">
              <p className="text-xs text-gray-500 mb-1">Session Code</p>
              <p className="font-mono text-indigo-400 font-bold text-lg tracking-wider">{code}</p>
            </div>
            <button 
              onClick={() => {
                const url = `${window.location.origin}/?session_id=${code}`;
                navigator.clipboard.writeText(url);
                alert("Interview Link Copied!");
              }}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-white/5 border border-white/10 text-gray-300 hover:text-white transition-all"
            >
              🔗 Copy Interview Link
            </button>
            <p className="text-xs text-gray-500">
              Share this link with the candidate. They will join the meeting directly.
            </p>
            <button onClick={onClose} className="w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm transition-all">
              Done
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="text-xs text-gray-400 font-medium mb-1.5 block">Candidate Name</label>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Priya Sharma"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white text-sm outline-none focus:border-indigo-500/60 transition-all"
                onKeyDown={e => e.key === "Enter" && handleCreate()}
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 font-medium mb-1.5 block">Role Applied For</label>
              <input
                value={role}
                onChange={e => setRole(e.target.value)}
                placeholder="e.g. Software Engineer"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white text-sm outline-none focus:border-indigo-500/60 transition-all"
              />
            </div>
            <div className="flex gap-3 pt-2">
              <button onClick={onClose} className="flex-1 py-3 rounded-xl border border-white/10 text-gray-400 hover:text-white text-sm transition-all">
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!name.trim() || loading}
                className="flex-1 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-bold text-sm transition-all"
              >
                {loading ? "Creating…" : "Create Session"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function HRDashboard({ user, onLogout, onJoinMeeting }) {
  const [sessions, setSessions]         = useState([]);
  const [activeSession, setActiveSession] = useState(null);
  const [showCreate, setShowCreate]     = useState(false);
  const [loading, setLoading]           = useState(true);
  const [activeTab, setActiveTab]       = useState("sessions"); // sessions | analytics
  const pollRef                         = useRef(null);

  const handleDownloadPDF = async () => {
    const el = document.getElementById("pdf-export-container") || document.getElementById("report-content");
    if (!el) return;
    document.documentElement.classList.add("pdf-exporting");
    try {
      await html2pdf().set({
        margin: 0.5, filename: `VeritasAI_Report_${activeSession?.candidate_name?.replace(/\s+/g, '_') || 'Session'}_${new Date().toISOString().slice(0, 10)}.pdf`,
        image: { type: "jpeg", quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: "in", format: "letter", orientation: "portrait" },
      }).from(el).save();
    } finally {
      document.documentElement.classList.remove("pdf-exporting");
    }
  };

  // Load sessions from backend
  const loadSessions = useCallback(async () => {
    try {
      const res  = await fetch(`${BACKEND_URL}/sessions`);
      const data = await res.json();
      setSessions(data.sessions || []);
    } catch {
      // If backend doesn't have sessions endpoint yet, show empty state
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSessions();
    pollRef.current = setInterval(loadSessions, 8000);
    return () => clearInterval(pollRef.current);
  }, [loadSessions]);

  const handleCreate = (newSession) => {
    setSessions(prev => [{ ...newSession, risk_label: null, final_score: 0 }, ...prev]);
  };

  // Stats
  const total     = sessions.length;
  const flagged   = sessions.filter(s => ["HIGH_RISK","SUSPICIOUS"].includes(s.risk_label)).length;
  const avgRisk   = total ? Math.round(sessions.reduce((a, s) => a + (s.final_score || 0), 0) / total * 100) : 0;
  const live      = sessions.filter(s => s.live).length;

  return (
    <div className="min-h-screen bg-[#070710] flex flex-col">
      {/* ── Top Nav ─────────────────────────────────────────────── */}
      <header className="border-b border-white/8 bg-black/30 backdrop-blur-sm sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-6 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center text-base">🛡️</div>
            <div>
              <span className="text-white font-bold text-base">SafeInterview</span>
              <span className="text-gray-600 text-xs ml-2">HR Portal</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-indigo-500/10 border border-indigo-500/25 text-xs text-indigo-300 font-medium">
              👔 HR Manager
            </div>
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition-all shadow-[0_0_20px_rgba(99,102,241,0.3)]"
            >
              + New Session
            </button>
            <button
              onClick={onLogout}
              className="px-3 py-2 rounded-xl border border-white/10 hover:border-white/20 text-gray-400 hover:text-white text-xs transition-all"
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 py-8 space-y-8">
        {/* ── Stats Row ──────────────────────────────────────────── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard icon="📋" label="Total Sessions" value={total} accent="indigo" />
          <StatCard icon="🔴" label="Flagged" value={flagged} sub="Review required" accent="red" />
          <StatCard icon="📊" label="Avg Risk" value={`${avgRisk}%`} accent={avgRisk > 60 ? "amber" : "emerald"} />
          <StatCard icon="🔴" label="Live Now" value={live} sub="Active sessions" accent={live > 0 ? "amber" : "indigo"} />
        </div>

        {/* ── Tab Bar ────────────────────────────────────────────── */}
        <div className="flex gap-1 bg-white/[0.03] rounded-xl p-1 w-fit border border-white/8">
          {["sessions", "analytics"].map(t => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              className={`px-5 py-2 rounded-lg text-sm font-medium transition-all capitalize ${
                activeTab === t
                  ? "bg-indigo-600 text-white shadow-lg"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* ── Sessions Tab ───────────────────────────────────────── */}
        {activeTab === "sessions" && (
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
            {/* Session list */}
            <div className="lg:col-span-2 space-y-2">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-white font-bold text-lg">Interview Sessions</h2>
                <span className="text-xs text-gray-500">{total} total</span>
              </div>
              {loading ? (
                <div className="space-y-2">
                  {[...Array(3)].map((_, i) => (
                    <div key={i} className="glass-card px-5 py-4 animate-pulse">
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 rounded-full bg-white/5" />
                        <div className="flex-1 space-y-2">
                          <div className="h-3 bg-white/5 rounded w-32" />
                          <div className="h-2 bg-white/5 rounded w-20" />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : sessions.length === 0 ? (
                <div className="glass-card px-6 py-12 text-center">
                  <div className="text-4xl mb-3 opacity-30">📋</div>
                  <p className="text-gray-400 text-sm font-medium">No sessions yet</p>
                  <p className="text-gray-600 text-xs mt-1">Create a session to invite candidates</p>
                  <button
                    onClick={() => setShowCreate(true)}
                    className="mt-5 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition-all"
                  >
                    + Create First Session
                  </button>
                </div>
              ) : (
                sessions.map(s => (
                  <SessionRow
                    key={s.session_id}
                    session={s}
                    isActive={activeSession?.session_id === s.session_id}
                    onClick={() => setActiveSession(activeSession?.session_id === s.session_id ? null : s)}
                  />
                ))
              )}
            </div>

            {/* Session detail */}
            <div className="lg:col-span-3">
              {activeSession ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-white font-bold text-lg">{activeSession.candidate_name || "Candidate"}</h2>
                    <div className="flex gap-2">
                      {activeSession.risk_label && (
                        <button
                          onClick={handleDownloadPDF}
                          className="text-indigo-400 hover:text-indigo-300 text-sm font-semibold flex items-center gap-1 bg-indigo-500/10 px-3 py-1.5 rounded-lg border border-indigo-500/20 transition-all"
                        >
                          📄 Download PDF
                        </button>
                      )}
                      <button
                        onClick={() => setActiveSession(null)}
                        className="text-gray-500 hover:text-white text-sm px-2"
                      >
                        ✕ Close
                      </button>
                    </div>
                  </div>
                  {activeSession.risk_label ? (
                    <>
                      <ProfessionalReport result={activeSession.result || activeSession} session={activeSession} />
                      <RiskReportCard result={activeSession.result || activeSession} />
                    </>
                  ) : (
                    <div className="glass-card p-8 text-center">
                      <div className="text-4xl mb-3">⏳</div>
                      <p className="text-gray-300 font-medium">Session pending</p>
                      <p className="text-gray-500 text-sm mt-1">
                        Results will appear here once the candidate completes the interview.
                      </p>
                      <div className="mt-4 bg-black/30 rounded-xl p-4 text-left">
                        <p className="text-xs text-gray-500 mb-1">Session Code</p>
                        <p className="font-mono text-indigo-400 font-bold">{activeSession.session_id}</p>
                        <p className="text-xs text-gray-600 mt-1">Share this with the candidate</p>
                      </div>
                      {/* Join Video Call */}
                      <button
                        onClick={() => onJoinMeeting?.(activeSession)}
                        className="mt-5 w-full py-3 rounded-2xl bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white font-bold text-sm transition-all shadow-lg shadow-indigo-500/20 flex items-center justify-center gap-2"
                      >
                        <span className="text-lg">🎥</span>
                        Start Video Interview
                      </button>
                      <p className="text-xs text-gray-600 mt-2">Candidate must join using the session code above</p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="glass-card p-10 text-center h-full flex flex-col items-center justify-center min-h-[400px]">
                  <div className="text-5xl mb-4 opacity-20">👆</div>
                  <p className="text-gray-400 font-medium">Select a session</p>
                  <p className="text-gray-600 text-sm mt-1">Click any session on the left to view details</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Analytics Tab ──────────────────────────────────────── */}
        {activeTab === "analytics" && (
          <div className="glass-card p-10 text-center">
            <div className="text-5xl mb-4">📊</div>
            <p className="text-white font-bold text-lg mb-2">Analytics Dashboard</p>
            <p className="text-gray-400 text-sm max-w-sm mx-auto mb-6">
              Aggregate risk trends, session comparison charts, and model accuracy tracking.
              Available after collecting 10+ sessions.
            </p>
            {/* Mini risk distribution */}
            {sessions.length > 0 && (
              <div className="max-w-md mx-auto space-y-3 text-left">
                {["GENUINE","REVIEW","SUSPICIOUS","HIGH_RISK"].map(label => {
                  const count = sessions.filter(s => s.risk_label === label).length;
                  const pct   = total > 0 ? count / total : 0;
                  const rc    = RISK_COLOR[label];
                  return (
                    <div key={label} className="flex items-center gap-3">
                      <span className={`text-xs font-medium w-24 shrink-0 ${rc.text}`}>{label.replace("_", " ")}</span>
                      <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${rc.dot}`} style={{ width: `${pct * 100}%`, transition: "width 1s ease" }} />
                      </div>
                      <span className="text-xs text-gray-500 w-8 text-right">{count}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </main>

      {/* Create session modal */}
      {showCreate && (
        <CreateSessionModal
          onClose={() => setShowCreate(false)}
          onCreate={(s) => { handleCreate(s); setShowCreate(false); }}
        />
      )}
    </div>
  );
}
