const VERDICTS = {
    SCRIPTED: {
        emoji: "🚨",
        label: "Likely Scripted / Plagiarized",
        description: "The response shows strong indicators of memorization or plagiarism — high semantic similarity, scripted delivery, and minimal natural speech patterns.",
        bg: "bg-red-500/10",
        border: "border-red-500/40",
        text: "text-red-400",
        bar: "bg-red-500",
        glow: "shadow-red-500/20",
    },
    SUSPICIOUS: {
        emoji: "⚠️",
        label: "Suspicious",
        description: "The response shows moderate signs of preparation or rehearsal. May be a well-practiced answer based on memorized material.",
        bg: "bg-yellow-500/10",
        border: "border-yellow-500/40",
        text: "text-yellow-400",
        bar: "bg-yellow-500",
        glow: "shadow-yellow-500/20",
    },
    GENUINE: {
        emoji: "✅",
        label: "Likely Genuine",
        description: "The response appears spontaneous and original, with natural speech patterns and low similarity to known scripted answers.",
        bg: "bg-emerald-500/10",
        border: "border-emerald-500/40",
        text: "text-emerald-400",
        bar: "bg-emerald-500",
        glow: "shadow-emerald-500/20",
    },
};

function ScoreBar({ label, value, color }) {
    const pct = Math.round(value * 100);
    return (
        <div className="space-y-1">
            <div className="flex justify-between items-center text-xs">
                <span className="text-gray-400">{label}</span>
                <span className="text-white font-mono font-medium">{pct}%</span>
            </div>
            <div className="h-2 bg-white/5 rounded-full overflow-hidden">
                <div
                    className={`h-full rounded-full transition-all duration-1000 ${color}`}
                    style={{ width: `${pct}%` }}
                />
            </div>
        </div>
    );
}

export default function RiskIndicator({ result }) {
    if (!result) return null;

    const v = VERDICTS[result.verdict] || VERDICTS.GENUINE;

    return (
        <div className={`glass-card p-6 border ${v.border} ${v.bg} shadow-xl ${v.glow} animate-slide-up`}>
            <p className="section-title">Verdict</p>

            {/* Main verdict */}
            <div className="flex items-center gap-3 mb-5">
                <span className="text-4xl">{v.emoji}</span>
                <div>
                    <h3 className={`text-xl font-bold ${v.text}`}>{v.label}</h3>
                    <p className="text-gray-400 text-sm mt-0.5">{v.description}</p>
                </div>
            </div>

            {/* Score breakdown */}
            <div className="space-y-3 pt-4 border-t border-white/5">
                <ScoreBar label="Semantic Similarity" value={result.semantic_similarity} color={v.bar} />
                <ScoreBar label="Memorization Score" value={result.memorization_score} color={v.bar} />
                <ScoreBar label="Behavior Score" value={result.behavior_score} color={v.bar} />
                <div className="h-px bg-white/5 my-1" />
                <ScoreBar label="Final Risk Score" value={result.final_score} color={v.bar} />
            </div>

            {/* LLM explanation */}
            {result.memorization_explanation && (
                <div className="mt-4 p-3 bg-black/20 rounded-xl border border-white/5">
                    <p className="text-xs font-semibold text-gray-400 mb-1">🤖 AI Analysis</p>
                    <p className="text-gray-300 text-sm leading-relaxed">{result.memorization_explanation}</p>
                </div>
            )}
        </div>
    );
}
