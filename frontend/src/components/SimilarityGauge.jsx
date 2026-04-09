import { useEffect, useRef } from "react";

const VERDICT_CONFIG = {
    SCRIPTED: { color: "#ef4444", glow: "rgba(239,68,68,0.3)", label: "Likely Scripted" },
    SUSPICIOUS: { color: "#f59e0b", glow: "rgba(245,158,11,0.3)", label: "Suspicious" },
    GENUINE: { color: "#10b981", glow: "rgba(16,185,129,0.3)", label: "Likely Genuine" },
    ANALYZING: { color: "#7c3aed", glow: "rgba(124,58,237,0.3)", label: "Analyzing…" },
};

const SIZE = 180;
const STROKE = 14;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export default function SimilarityGauge({ score = 0, verdict = "ANALYZING", label = "Final Score" }) {
    const circleRef = useRef(null);
    const config = VERDICT_CONFIG[verdict] || VERDICT_CONFIG.ANALYZING;
    const pct = Math.max(0, Math.min(1, score));
    const offset = CIRCUMFERENCE * (1 - pct);
    const percentage = Math.round(pct * 100);

    useEffect(() => {
        if (circleRef.current) {
            circleRef.current.style.transition = "stroke-dashoffset 1s cubic-bezier(0.4,0,0.2,1)";
            circleRef.current.style.strokeDashoffset = offset;
        }
    }, [offset]);

    return (
        <div className="flex flex-col items-center gap-3 animate-fade-in">
            <p className="section-title">{label}</p>

            <div className="relative" style={{ width: SIZE, height: SIZE }}>
                {/* Glow */}
                <div
                    className="absolute inset-0 rounded-full opacity-30 transition-all duration-1000"
                    style={{
                        boxShadow: `0 0 40px 15px ${config.glow}`,
                    }}
                />

                <svg width={SIZE} height={SIZE} className="rotate-[-90deg]">
                    {/* Background track */}
                    <circle
                        cx={SIZE / 2}
                        cy={SIZE / 2}
                        r={RADIUS}
                        fill="none"
                        stroke="rgba(255,255,255,0.07)"
                        strokeWidth={STROKE}
                    />
                    {/* Progress arc */}
                    <circle
                        ref={circleRef}
                        cx={SIZE / 2}
                        cy={SIZE / 2}
                        r={RADIUS}
                        fill="none"
                        stroke={config.color}
                        strokeWidth={STROKE}
                        strokeLinecap="round"
                        strokeDasharray={CIRCUMFERENCE}
                        strokeDashoffset={CIRCUMFERENCE}
                        style={{ filter: `drop-shadow(0 0 8px ${config.color})` }}
                    />
                </svg>

                {/* Centre text */}
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span
                        className="text-3xl font-bold tabular-nums transition-all duration-1000"
                        style={{ color: config.color }}
                    >
                        {percentage}%
                    </span>
                    <span className="text-xs text-gray-400 mt-0.5">risk score</span>
                </div>
            </div>

            {/* Sub-scores */}
        </div>
    );
}
