import React from 'react';

export default function IntegrityPanel({ events, videoUrl }) {
    if ((!events || events.length === 0) && !videoUrl) return null;

    const formatTime = (ts) => {
        if (!ts) return "Unknown time";
        return new Date(ts).toLocaleTimeString();
    };

    const getIcon = (type) => {
        switch(type) {
            case "copy": return "📋";
            case "paste": return "📥";
            case "tab_switch": return "👁️";
            case "focus_loss": return "🚪";
            case "sys_key_pressed": return "⌨️";
            case "left_fullscreen": return "🖥️";
            case "mouse_left": return "🖱️";
            default: return "⚠️";
        }
    };

    const getMessage = (type) => {
        switch(type) {
            case "copy": return "User copied content to clipboard";
            case "paste": return "User pasted content from clipboard";
            case "tab_switch": return "User switched away from the interview tab";
            case "focus_loss": return "Browser window lost focus (potential Alt-Tab)";
            case "sys_key_pressed": return "System modifier key detected";
            case "left_fullscreen": return "User exited Full Screen mode";
            case "mouse_left": return "Mouse cursor left the interview boundaries";
            default: return "Suspicious activity detected";
        }
    }

    const hasEvents = events && events.length > 0;

    return (
        <div className={`glass-card p-6 animate-slide-up mt-5 border ${hasEvents ? 'border-red-500/30 bg-red-500/5' : 'border-white/5'}`}>
            <h3 className={`font-bold text-lg mb-4 flex items-center gap-2 ${hasEvents ? 'text-red-400' : 'text-gray-300'}`}>
                {hasEvents ? <span className="animate-pulse">🚨</span> : <span>🛡️</span>} 
                {hasEvents ? "Integrity Alerts" : "Session Integrity"}
            </h3>
            
            {hasEvents ? (
                <div className="space-y-2 mb-6 max-h-64 overflow-y-auto pr-2 custom-scrollbar">
                    {events.map((ev, i) => (
                            <div key={i} className="flex flex-col bg-black/40 p-3 rounded-lg border border-red-500/20 hover:border-red-500/40 transition-all duration-300">
                                <div className="flex items-center justify-between gap-3">
                                    <div className="flex items-center gap-3 flex-1 overflow-hidden">
                                        <div className="w-8 h-8 rounded-full bg-red-500/10 flex items-center justify-center text-lg shrink-0">
                                            {getIcon(ev.event_type)}
                                        </div>
                                        <div className="flex-1 truncate">
                                            <p className="text-white text-sm font-medium truncate">{getMessage(ev.event_type)}</p>
                                            <p className="text-red-400 opacity-70 text-[10px] mt-0.5">{ev.event_type.toUpperCase()}</p>
                                        </div>
                                    </div>
                                    <span className="text-gray-500 text-xs font-mono bg-white/5 px-2 py-1 rounded shrink-0">
                                        {formatTime(ev.timestamp)}
                                    </span>
                                </div>
                                {ev.details && (
                                    <div className="mt-2 ml-11 bg-red-950/40 border border-red-500/20 rounded p-2">
                                        <p className="text-red-300 text-xs font-mono font-semibold truncate" title={ev.details}>{ev.details}</p>
                                    </div>
                                )}
                            </div>
                    ))}
                </div>
            ) : (
                <div className="flex items-center gap-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4 mb-6">
                    <span className="text-xl">✅</span>
                    <div>
                        <p className="text-emerald-400 font-medium text-sm">No suspicious behavior detected</p>
                        <p className="text-emerald-400/60 text-xs">Focus and interaction metrics remained stable throughout the session.</p>
                    </div>
                </div>
            )}

            {videoUrl && (
                <div className="mt-4 border-t border-white/10 pt-5">
                    <p className="section-title mb-3 flex items-center gap-2">
                        <span>📹</span> Screen Recording
                    </p>
                    <div className="relative rounded-xl overflow-hidden border border-white/20 shadow-2xl bg-black group">
                        <video 
                            src={videoUrl} 
                            controls 
                            className="w-full aspect-video object-contain"
                            preload="metadata"
                        />
                    </div>
                </div>
            )}

            {/* Keyboard content logging removed — typing speed variance (no content) is tracked internally */}
        </div>
    );
}
