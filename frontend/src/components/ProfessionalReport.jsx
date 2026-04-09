import React from 'react';

export default function ProfessionalReport({ result, session, assessmentType }) {
  if (!result) return null;

  const getRiskColor = (label) => {
    switch (label) {
      case 'HIGH_RISK': return 'bg-red-50 text-red-700 border-red-200';
      case 'SUSPICIOUS': return 'bg-orange-50 text-orange-700 border-orange-200';
      case 'REVIEW': return 'bg-yellow-50 text-yellow-700 border-yellow-200';
      default: return 'bg-green-50 text-green-700 border-green-200';
    }
  };

  const formatPercent = (val) => `${Math.round((val || 0) * 100)}%`;

  return (
    <div className="absolute top-0 left-0 w-full overflow-hidden h-0 pointer-events-none z-[-1]">
      <div id="pdf-export-container" className="w-[1000px] bg-white text-black p-12 font-sans">
        
        {/* Header */}
        <div className="border-b-4 border-indigo-600 pb-6 mb-8 flex justify-between items-end">
          <div>
            <h1 className="text-4xl font-extrabold text-gray-900 mb-2">Behavioral & Integrity Report</h1>
            <p className="text-gray-500 font-medium text-lg">Detailed Assessment for: <span className="font-bold text-indigo-700">{session?.candidate_name || result?.candidate_name || "Candidate"}</span></p>
          </div>
          <div className="text-right">
            <p className="text-sm font-bold text-gray-400 uppercase tracking-wider">Generated</p>
            <p className="text-lg font-semibold text-gray-800">{new Date().toLocaleString()}</p>
          </div>
        </div>

        {/* Top summary section */}
        <div className={`p-8 rounded-xl mb-8 border-2 ${getRiskColor(result.risk_label || result.verdict)}`}>
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm uppercase tracking-wide font-bold opacity-60 mb-1">Final Risk Classification</p>
              <h2 className="text-4xl font-black">
                {result.risk_label ? result.risk_label.replace('_', ' ') : result.verdict}
              </h2>
            </div>
            <div className="flex gap-4">
              <div className="text-center bg-white/60 backdrop-blur px-6 py-4 rounded-xl border border-black/10">
                <p className="text-xs uppercase tracking-wide font-bold opacity-60 mb-1">Risk Score</p>
                <p className="text-3xl font-black">{(result.risk_score * 100 || result.final_score * 100 || 0).toFixed(0)}%</p>
              </div>
              <div className="text-center bg-white/60 backdrop-blur px-6 py-4 rounded-xl border border-black/10">
                <p className="text-xs uppercase tracking-wide font-bold opacity-60 mb-1">AI Confidence</p>
                <p className="text-3xl font-black">{formatPercent(result.confidence || 0.95)}</p>
              </div>
            </div>
          </div>
          <p className="text-lg font-medium opacity-90 leading-relaxed border-t border-black/10 pt-4">
            {result.verdict_summary || "Automated analysis completed. Please review detailed metrics below."}
          </p>
        </div>

        {/* Primary Metrics Grid */}
        <div className="grid grid-cols-4 gap-4 mb-8">
          {[
            { label: 'Semantic/Plagiarism Match', val: result.semantic_similarity },
            { label: 'Memory / Scripting', val: result.memorization_score },
            { label: 'Baseline Structure', val: result.speech_metrics?.behavior_score || result.behavior_score },
            { label: 'Linguistic Rigidity', val: result.top_signals?.find(s => s.signal_name === 'structure_rigidity')?.value },
          ].map((m, i) => (
            m.val !== undefined && (
              <div key={i} className="bg-gray-50 p-5 rounded-xl border border-gray-200">
                <p className="text-xs text-gray-500 uppercase font-bold mb-2 h-8">{m.label}</p>
                <span className="text-3xl font-bold text-gray-900">{formatPercent(m.val)}</span>
              </div>
            )
          ))}
        </div>

        {/* Top Risk Signals */}
        {result.top_signals && result.top_signals.length > 0 && (
          <div className="mb-8">
            <h3 className="text-2xl font-bold text-gray-900 border-b-2 border-gray-100 pb-3 mb-4">Behavioral Signals Detected</h3>
            <div className="space-y-3">
              {result.top_signals.map((sig, idx) => (
                <div key={idx} className="flex items-start gap-4 p-4 rounded-lg bg-gray-50 border border-gray-100">
                  <div className={`px-3 py-1 rounded text-xs font-bold ${
                    sig.contribution === 'HIGH' ? 'bg-red-100 text-red-800' :
                    sig.contribution === 'MEDIUM' ? 'bg-orange-100 text-orange-800' :
                    'bg-green-100 text-green-800'
                  }`}>
                    {sig.contribution}
                  </div>
                  <div>
                    <h4 className="font-bold text-gray-800">{sig.human_label}</h4>
                    <p className="text-sm text-gray-500 mt-1 uppercase tracking-wide">Signal: {sig.signal_name.replace(/_/g, ' ')}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Proctoring Timeline / Integrity Violations */}
        <div className="mb-8 page-break-inside-avoid">
          <h3 className="text-2xl font-bold text-gray-900 border-b-2 border-gray-100 pb-3 mb-4">System Proctoring Logs</h3>
          
          {(result.timeline_events && result.timeline_events.length > 0) || (result.integrity_events && result.integrity_events.length > 0) ? (
            <div className="bg-white border border-rose-200 rounded-xl overflow-hidden">
              <table className="w-full text-left text-sm">
                <thead className="bg-rose-50 text-rose-800">
                  <tr>
                    <th className="px-5 py-3 font-semibold">Time / Type</th>
                    <th className="px-5 py-3 font-semibold">Event Target</th>
                    <th className="px-5 py-3 font-semibold">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rose-100 text-gray-700">
                  {(result.timeline_events || result.integrity_events).map((evt, idx) => (
                    <tr key={idx} className="hover:bg-rose-50">
                      <td className="px-5 py-4 font-bold text-rose-900 whitespace-nowrap">
                        {evt.time || new Date(evt.timestamp).toLocaleTimeString()}<br/>
                        <span className="text-xs font-medium text-rose-600">{(evt.event || evt.event_type).toUpperCase()}</span>
                      </td>
                      <td className="px-5 py-4 font-medium">{evt.note || evt.event_type.replace(/_/g, ' ')}</td>
                      <td className="px-5 py-4 text-gray-600">{evt.details || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
             <div className="p-6 bg-green-50 border border-green-200 rounded-xl">
              <h3 className="text-green-800 font-bold mb-1">No Proctoring Violations</h3>
              <p className="text-green-700 text-sm">Candidate maintained window focus and fullscreen throughout the session.</p>
            </div>
          )}
        </div>

        {/* Interview Transcript & Speech */}
        {result.transcript && (
          <div className="mb-8">
            <h3 className="text-2xl font-bold text-gray-900 border-b-2 border-gray-100 pb-3 mb-4">Speech Transcription</h3>
            <div className="bg-gray-50 border border-gray-200 p-8 rounded-xl relative shadow-[inset_0_2px_10px_rgba(0,0,0,0.02)]">
              <p className="text-gray-800 text-lg leading-loose whitespace-pre-wrap break-words">{result.transcript}</p>
            </div>
          </div>
        )}

        {/* Recommendation Box */}
        {result.recommendation && (
          <div className="p-8 bg-gray-900 text-white rounded-xl mb-4 text-center">
            <p className="text-gray-400 uppercase tracking-widest font-bold text-xs mb-2">Automated Policy Recommendation</p>
            <h2 className="text-2xl font-bold">{result.recommendation}</h2>
          </div>
        )}

        {/* Footer Details */}
        <div className="text-center text-gray-400 text-xs mt-12 pt-6 border-t border-gray-200">
          Generated automatically by SafeInterview Assessment System • System ID: {Math.random().toString(36).substring(2, 10).toUpperCase()}
        </div>
      </div>
    </div>
  );
}
