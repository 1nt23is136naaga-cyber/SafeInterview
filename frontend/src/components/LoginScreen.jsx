import { useState, useEffect } from "react";
import { GoogleLogin } from "@react-oauth/google";

/**
 * LoginScreen.jsx — Role-based login for VeritasAI.
 * 
 * Step 1: Select role (HR Manager OR Interview Candidate)
 * Step 2: Login via Google or Demo mode
 * 
 * The selected role is passed back via onLoginSuccess({ role, credential })
 */

const ROLES = [
  {
    id: "hr",
    icon: "👔",
    title: "HR Manager",
    subtitle: "Create sessions, monitor candidates, view results",
    gradient: "from-indigo-500/20 to-purple-500/20",
    border: "border-indigo-500/40",
    activeBorder: "border-indigo-400",
    glow: "shadow-[0_0_30px_rgba(99,102,241,0.25)]",
    badge: "bg-indigo-500/15 text-indigo-300",
  },
  {
    id: "candidate",
    icon: "🎤",
    title: "Interview Candidate",
    subtitle: "Attend your scheduled interview session",
    gradient: "from-emerald-500/20 to-teal-500/20",
    border: "border-emerald-500/40",
    activeBorder: "border-emerald-400",
    glow: "shadow-[0_0_30px_rgba(16,185,129,0.25)]",
    badge: "bg-emerald-500/15 text-emerald-300",
  },
];

export default function LoginScreen({ onLoginSuccess }) {
  const [selectedRole, setSelectedRole] = useState(null);
  const [isLoggingIn, setIsLoggingIn]   = useState(false);
  const [hasSessionLink, setHasSessionLink] = useState(false);
  const [sessionCode, setSessionCode]   = useState("");
  const [showCodeInput, setShowCodeInput] = useState(false);

  // Auto-select candidate if link contains session_id
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("session_id")) {
      setSelectedRole("candidate");
      setHasSessionLink(true);
    }
  }, []);

  const handleLogin = (credential) => {
    if (!selectedRole) return;
    setIsLoggingIn(true);
    onLoginSuccess({ role: selectedRole, credential });
  };

  // Join via typed session code
  const handleJoinWithCode = () => {
    const code = sessionCode.trim();
    if (!code) return;
    // Inject code into URL so App.jsx picks it up via the existing URL-param logic
    const newUrl = `${window.location.origin}/?session_id=${encodeURIComponent(code)}`;
    window.history.replaceState(null, '', `/?session_id=${encodeURIComponent(code)}`);
    setHasSessionLink(true);
    setIsLoggingIn(true);
    onLoginSuccess({ role: "candidate", credential: { mock: true } });
  };

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden bg-[#070710]">
      {/* Animated background blobs */}
      <div className="absolute top-1/4 left-1/4 w-[500px] h-[500px] bg-indigo-600/10 rounded-full blur-[150px] animate-pulse" />
      <div className="absolute bottom-1/4 right-1/4 w-[400px] h-[400px] bg-purple-600/10 rounded-full blur-[150px]" style={{ animationDelay: "1s" }} />
      <div className="absolute top-1/2 left-1/2 w-[300px] h-[300px] bg-emerald-600/8 rounded-full blur-[120px]" />

      <div className="relative z-10 w-full max-w-lg mx-4 animate-fade-in">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="relative inline-block mb-5">
            <div className="w-20 h-20 mx-auto rounded-3xl bg-gradient-to-br from-indigo-500/30 to-purple-500/30 border border-white/20 flex items-center justify-center text-4xl shadow-[0_0_40px_rgba(99,102,241,0.3)]">
              🧠
            </div>
            <div className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-emerald-500 border-2 border-[#070710] flex items-center justify-center">
              <div className="w-2 h-2 rounded-full bg-white animate-pulse" />
            </div>
          </div>
          <h1 className="text-3xl font-extrabold text-white tracking-tight mb-1">
            {hasSessionLink ? "Joining Interview" : "SafeInterview"}
          </h1>
          <p className="text-gray-400 text-sm">
            {hasSessionLink ? "Professional Evaluation Portal" : "Secure · Intelligent · Fair"}
          </p>
        </div>

        {/* Role Cards — Hidden if joining via link */}
        {!hasSessionLink && (
          <div className="mb-6">
            <p className="text-center text-xs text-gray-500 uppercase tracking-widest mb-4 font-medium">
              Who are you?
            </p>
            <div className="grid grid-cols-2 gap-3">
              {ROLES.map((role) => {
                const isActive = selectedRole === role.id;
                return (
                  <button
                    key={role.id}
                    onClick={() => setSelectedRole(role.id)}
                    className={`relative p-5 rounded-2xl border-2 text-left transition-all duration-300 group bg-gradient-to-br ${role.gradient} ${
                      isActive
                        ? `${role.activeBorder} ${role.glow} scale-[1.02]`
                        : `${role.border} hover:scale-[1.01] hover:${role.activeBorder}`
                    }`}
                  >
                    {isActive && (
                      <div className="absolute top-2.5 right-2.5 w-4 h-4 rounded-full bg-white flex items-center justify-center">
                        <div className="w-2 h-2 rounded-full bg-gray-900" />
                      </div>
                    )}
                    <div className="text-3xl mb-3">{role.icon}</div>
                    <p className="text-white font-bold text-sm leading-tight">{role.title}</p>
                    <p className="text-gray-400 text-xs mt-1 leading-relaxed">{role.subtitle}</p>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Login Panel — shown after role selection or if link used */}
        <div className={`overflow-hidden transition-all duration-500 ${selectedRole ? "max-h-[560px] opacity-100" : "max-h-0 opacity-0"}`}>
          <div className="bg-white/[0.03] rounded-2xl border border-white/10 p-6 space-y-4">

            {/* Role badge — only show if not pre-selected via link */}
            {selectedRole && !hasSessionLink && (
              <div className="flex items-center gap-2 mb-2">
                <span className={`text-xs px-3 py-1 rounded-full font-medium border ${ROLES.find(r => r.id === selectedRole)?.badge} ${ROLES.find(r => r.id === selectedRole)?.border}`}>
                  {ROLES.find(r => r.id === selectedRole)?.icon}{" "}
                  Logging in as {ROLES.find(r => r.id === selectedRole)?.title}
                </span>
              </div>
            )}

            {hasSessionLink && (
              <p className="text-center text-indigo-400 text-xs font-semibold uppercase tracking-wider">
                Pre-Arranged Meeting Detected
              </p>
            )}

            {/* ── Session Code Entry (candidates only, no existing link) ── */}
            {selectedRole === "candidate" && !hasSessionLink && (
              <div className="space-y-2">
                <button
                  onClick={() => setShowCodeInput(v => !v)}
                  className="w-full flex items-center justify-between px-4 py-2.5 rounded-xl bg-emerald-500/8 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/15 transition-all text-sm font-medium"
                >
                  <span>🔑 Have a session code?</span>
                  <span className={`transition-transform duration-200 ${showCodeInput ? "rotate-180" : ""}`}>▾</span>
                </button>

                <div className={`overflow-hidden transition-all duration-300 ${showCodeInput ? "max-h-24 opacity-100" : "max-h-0 opacity-0"}`}>
                  <div className="flex gap-2 pt-1">
                    <input
                      value={sessionCode}
                      onChange={e => setSessionCode(e.target.value.toUpperCase())}
                      onKeyDown={e => e.key === "Enter" && handleJoinWithCode()}
                      placeholder="e.g. SESS_A1B2C3"
                      className="flex-1 bg-black/30 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm font-mono outline-none focus:border-emerald-500/50 transition-all placeholder:text-gray-600 tracking-wider"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button
                      onClick={handleJoinWithCode}
                      disabled={!sessionCode.trim()}
                      className="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-30 text-white text-sm font-bold transition-all shrink-0"
                    >
                      Join
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Divider */}
            <div className="relative flex items-center">
              <div className="flex-grow border-t border-white/10" />
              <span className="mx-4 text-gray-600 text-xs uppercase tracking-wider">or</span>
              <div className="flex-grow border-t border-white/10" />
            </div>

            {/* Google Login */}
            <div className="flex justify-center">
              <GoogleLogin
                onSuccess={(cred) => handleLogin(cred)}
                onError={() => console.log("Google login failed")}
                theme="outline"
                size="large"
                shape="pill"
                text="continue_with"
              />
            </div>

            {/* Divider */}
            <div className="relative flex items-center">
              <div className="flex-grow border-t border-white/10" />
              <span className="mx-4 text-gray-600 text-xs uppercase tracking-wider">or</span>
              <div className="flex-grow border-t border-white/10" />
            </div>

            {/* Demo login */}
            <button
              onClick={() => handleLogin({ mock: true })}
              disabled={isLoggingIn}
              className="w-full py-3 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white text-sm font-medium transition-all"
            >
              {isLoggingIn ? "Entering…" : "Demo Login (No Google Account)"}
            </button>
          </div>
        </div>

        {/* Prompt if no role selected */}
        {!selectedRole && (
          <p className="text-center text-gray-600 text-xs mt-4">
            ↑ Select your role above to continue
          </p>
        )}

        {/* Footer note */}
        <div className="mt-6 text-center">
          <p className="text-xs text-gray-600">
            safeinterview.com · All sessions encrypted · Privacy compliant
          </p>
        </div>
      </div>
    </div>
  );
}
