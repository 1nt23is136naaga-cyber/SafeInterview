function StatCard({ icon, label, value, sub, color = "text-white" }) {
    return (
        <div className="bg-black/20 rounded-xl p-4 border border-white/5 hover:border-white/10 transition-colors">
            <div className="flex items-center gap-2 mb-2">
                <span className="text-lg">{icon}</span>
                <span className="text-xs text-gray-400 font-medium">{label}</span>
            </div>
            <div className={`text-2xl font-bold tabular-nums ${color}`}>{value}</div>
            {sub && <div className="text-xs text-gray-500 mt-0.5">{sub}</div>}
        </div>
    );
}

export default function BehaviorStatsPanel({ metrics, verdict }) {
    if (!metrics) return null;

    const verdictColor = {
        SCRIPTED: "text-red-400",
        SUSPICIOUS: "text-yellow-400",
        GENUINE: "text-emerald-400",
    }[verdict] || "text-white";

    return (
        <div className="glass-card p-6 animate-slide-up">
            <p className="section-title">Behavioral Analysis</p>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <StatCard
                    icon="⚡"
                    label="True Speech Rate"
                    value={`${metrics.true_speech_rate?.toFixed(1)} wps`}
                    sub={
                        (metrics.true_speech_rate || 0) > 3.5
                            ? "↑ Fast (suspicious)"
                            : (metrics.true_speech_rate || 0) > 2.0
                                ? "Normal range"
                                : "↓ Slow pace"
                    }
                    color={(metrics.true_speech_rate || 0) > 3.5 ? "text-red-400" : "text-emerald-400"}
                />
                <StatCard
                    icon="💬"
                    label="Filler Words"
                    value={metrics.filler_count ?? 0}
                    sub={`${((metrics.filler_ratio || 0) * 100).toFixed(1)}% ratio`}
                    color={metrics.filler_count === 0 ? "text-red-400" : "text-emerald-400"}
                />
                <StatCard
                    icon="⏸️"
                    label="Pause Markers"
                    value={metrics.pause_count ?? 0}
                    sub={metrics.pause_count < 3 ? "Few pauses (suspicious)" : "Natural pausing"}
                    color={metrics.pause_count < 3 ? "text-red-400" : "text-emerald-400"}
                />
                <StatCard
                    icon="📝"
                    label="Word Count"
                    value={metrics.word_count ?? 0}
                    sub="total words"
                />
                <StatCard
                    icon="⏱️"
                    label="Duration"
                    value={`${metrics.duration_seconds?.toFixed(0)}s`}
                    sub="response length"
                />
                <StatCard
                    icon="🎯"
                    label="Behavior Score"
                    value={`${((metrics.behavior_score || 0) * 100).toFixed(0)}%`}
                    sub="scripted likelihood"
                    color={verdictColor}
                />
            </div>

            {/* Interpretation */}
            <div className="mt-4 p-3 bg-black/20 rounded-xl border border-white/5 text-sm text-gray-400 leading-relaxed">
                <span className="font-semibold text-gray-300">Interpretation: </span>
                {metrics.filler_count === 0 && metrics.speech_rate > 3
                    ? "No filler words and high speech rate strongly suggest a rehearsed, memorized delivery."
                    : metrics.filler_count > 3 && metrics.speech_rate < 2.5
                        ? "Presence of filler words and measured pace suggest a natural, spontaneous response."
                        : "Mixed behavioral signals — response shows elements of both preparation and natural delivery."}
            </div>
        </div>
    );
}
