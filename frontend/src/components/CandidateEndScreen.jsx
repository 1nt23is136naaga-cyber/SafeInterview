import React from "react";

/**
 * CandidateEndScreen.jsx — Shown to interview candidates after they finish.
 * This ensures they don't see the detailed risk and score reports.
 */
export default function CandidateEndScreen({ candidateName }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#070710] relative overflow-hidden">
      {/* Background blobs */}
      <div className="absolute top-1/4 left-1/4 w-[400px] h-[400px] bg-indigo-600/10 rounded-full blur-[120px] animate-pulse" />
      <div className="absolute bottom-1/4 right-1/4 w-[300px] h-[300px] bg-purple-600/10 rounded-full blur-[100px]" />

      <div className="relative z-10 w-full max-w-lg mx-4 text-center animate-fade-in">
        <div className="mb-8">
          <div className="w-24 h-24 mx-auto mb-6 rounded-full bg-gradient-to-br from-emerald-500/20 to-teal-500/20 border border-emerald-500/30 flex items-center justify-center text-5xl shadow-[0_0_40px_rgba(16,185,129,0.2)]">
            ✅
          </div>
          <h1 className="text-3xl font-bold text-white mb-2">Interview Submitted</h1>
          <p className="text-gray-400 text-lg">
            Great job, {candidateName || "Candidate"}!
          </p>
        </div>

        <div className="bg-white/[0.03] rounded-2xl border border-white/10 p-8 space-y-6">
          <p className="text-gray-300 leading-relaxed">
            Your evaluation data has been securely transmitted to the HR team. Your participation session is now complete.
          </p>

          <div className="pt-4">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-sm font-medium">
              <span>🔒 End-to-end Encrypted</span>
            </div>
          </div>

          <button 
            onClick={() => window.location.href = "/"}
            className="w-full py-4 rounded-xl bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 transition-all"
          >
            Back to Home
          </button>
        </div>

        <p className="mt-8 text-xs text-gray-600 tracking-widest uppercase">
          SafeInterview — Professional Evaluation Portal
        </p>
      </div>
    </div>
  );
}
