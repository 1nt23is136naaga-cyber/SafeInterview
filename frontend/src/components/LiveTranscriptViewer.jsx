import { useEffect, useRef } from "react";

export default function LiveTranscriptViewer({ transcript, liveUpdate, isAnalyzing }) {
    const bottomRef = useRef(null);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [transcript, liveUpdate?.transcript]);

    const displayText = transcript || liveUpdate?.transcript || "";
    const isEmpty = !displayText;

    return (
        <div className="glass-card p-6 animate-fade-in">
            <div className="flex items-center justify-between mb-4">
                <p className="section-title mb-0">Transcript</p>
                {liveUpdate && (
                    <span className="flex items-center gap-1.5 text-xs text-primary-light">
                        <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                        Live
                    </span>
                )}
                {isAnalyzing && !liveUpdate && (
                    <span className="flex items-center gap-1.5 text-xs text-gray-400">
                        <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                        </svg>
                        Transcribing…
                    </span>
                )}
            </div>

            <div
                className="bg-black/30 rounded-xl border border-white/5 p-4 min-h-[140px] max-h-64 overflow-y-auto"
            >
                {isEmpty ? (
                    <div className="flex flex-col items-center justify-center h-28 gap-2 text-center">
                        {isAnalyzing ? (
                            <>
                                <div className="flex gap-1">
                                    {[0, 1, 2].map((i) => (
                                        <div
                                            key={i}
                                            className="w-2 h-2 rounded-full bg-primary animate-bounce"
                                            style={{ animationDelay: `${i * 0.15}s` }}
                                        />
                                    ))}
                                </div>
                                <p className="text-gray-500 text-sm">Transcribing audio…</p>
                            </>
                        ) : (
                            <>
                                <span className="text-3xl opacity-30">🎙️</span>
                                <p className="text-gray-500 text-sm">Transcript will appear here</p>
                            </>
                        )}
                    </div>
                ) : (
                    <p className="text-gray-200 text-sm leading-relaxed font-mono whitespace-pre-wrap">
                        {displayText}
                        {liveUpdate && (
                            <span className="inline-block w-0.5 h-4 bg-primary ml-0.5 animate-pulse align-text-bottom" />
                        )}
                    </p>
                )}
                <div ref={bottomRef} />
            </div>

            {displayText && (
                <div className="flex items-center justify-between mt-2 text-xs text-gray-500">
                    <span>{displayText.split(/\s+/).filter(Boolean).length} words</span>
                    {liveUpdate?.semantic_similarity != null && (
                        <span className="text-primary-light">
                            Live similarity: {Math.round(liveUpdate.semantic_similarity * 100)}%
                        </span>
                    )}
                </div>
            )}
        </div>
    );
}
