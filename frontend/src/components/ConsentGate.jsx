import { useState, useEffect } from "react";

/**
 * ConsentGate.jsx — Professional System & Permissions Check
 * 
 * Focuses on professional environment readiness rather than data collection details.
 * Asks for Microphone and Camera access as standard interview requirements.
 */

export default function ConsentGate({ onAccept, onDecline, candidateName = "" }) {
  const [agreed, setAgreed] = useState(false);
  const [checking, setChecking] = useState(false);

  const handleAccept = () => {
    if (!agreed) return;
    // We default eye tracking to true in background since we shouldn't mention it explicitly now
    onAccept({ eyeTrackingEnabled: true });
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-[#070710]">
      <div className="max-w-xl w-full animate-fade-in">
        
        {/* Header */}
        <div className="text-center mb-10">
          <div className="w-20 h-20 rounded-3xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-4xl mx-auto mb-6 shadow-[0_0_40px_rgba(99,102,241,0.15)]">
            🛡️
          </div>
          <h1 className="text-3xl font-extrabold text-white mb-3">
            System Check
          </h1>
          <p className="text-gray-400 text-sm leading-relaxed max-w-sm mx-auto">
            VeritasAI uses advanced intelligence to ensure a fair and structured evaluation process.
          </p>
        </div>

        {/* Requirements Card */}
        <div className="bg-white/[0.03] border border-white/10 rounded-3xl p-8 mb-8">
          <h2 className="text-white font-bold text-lg mb-6 flex items-center gap-2">
            Interview Requirements
          </h2>
          
          <div className="space-y-6">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center text-xl shrink-0">🎤</div>
              <div>
                <p className="text-white font-semibold text-sm">Microphone Access</p>
                <p className="text-xs text-gray-500 mt-1">Required for verbal response analysis and communication evaluation.</p>
              </div>
            </div>

            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center text-xl shrink-0">📹</div>
              <div>
                <p className="text-white font-semibold text-sm">Camera Access</p>
                <p className="text-xs text-gray-500 mt-1">Required for professional presence and attention monitoring during the session.</p>
              </div>
            </div>

            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center text-xl shrink-0">🖥️</div>
              <div>
                <p className="text-white font-semibold text-sm">Screen Monitoring</p>
                <p className="text-xs text-gray-500 mt-1">Session integrity is maintained through active environment monitoring.</p>
              </div>
            </div>
          </div>

          <div className="mt-8 pt-8 border-t border-white/5">
            <div 
              className="flex items-start gap-3 cursor-pointer group"
              onClick={() => setAgreed(!agreed)}
            >
              <div className={`w-5 h-5 rounded border-2 flex items-center justify-center mt-0.5 shrink-0 transition-all ${
                agreed ? "bg-indigo-500 border-indigo-500" : "border-white/20 bg-transparent group-hover:border-white/40"
              }`}>
                {agreed && <span className="text-white text-xs font-bold">✓</span>}
              </div>
              <p className="text-sm text-gray-400 leading-relaxed select-none">
                I understand that this session will be monitored for professional integrity and I grant the necessary system permissions.
              </p>
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-4">
          <button
            onClick={onDecline}
            className="flex-1 py-4 rounded-2xl border border-white/10 text-gray-500 hover:text-white hover:bg-white/5 transition-all text-sm font-semibold"
          >
            Cancel
          </button>
          <button
            onClick={handleAccept}
            disabled={!agreed || checking}
            className={`flex-[2] py-4 rounded-2xl font-bold text-sm transition-all ${
              agreed
                ? "bg-indigo-600 hover:bg-indigo-500 text-white shadow-[0_0_30px_rgba(99,102,241,0.3)]"
                : "bg-white/5 text-gray-600 cursor-not-allowed"
            }`}
          >
            {checking ? "Verifying..." : "Start Interview"}
          </button>
        </div>

        <p className="text-center text-gray-600 text-[10px] mt-8 uppercase tracking-widest font-medium">
          Secure · Professional · Encrypted
        </p>
      </div>
    </div>
  );
}
