import { useMemo } from "react";

/**
 * RiskReportCard.jsx — Explainable, recruiter-friendly risk report renderer.
 *
 * Replaces the plain "verdict" string with:
 *   - Risk score gauge
 *   - Color-coded risk label
 *   - Per-signal bar breakdown  
 *   - Eye behavior section
 *   - Baseline delta comparison
 *   - Timeline of integrity events
 *   - Plain English summary + recommendation
 */

const LABEL_CONFIG = {
  GENUINE:   { color: "emerald", emoji: "✅", text: "Genuine" },
  REVIEW:    { color: "yellow",  emoji: "🟡", text: "Low Concern" },
  SUSPICIOUS:{ color: "amber",   emoji: "⚠️", text: "Suspicious" },
  HIGH_RISK: { color: "red",     emoji: "🚨", text: "High Risk" },
};

const CONTRIB_CONFIG = {
  HIGH:     { bar: "bg-red-500",     badge: "bg-red-500/15 text-red-400 border-red-500/20" },
  MEDIUM:   { bar: "bg-amber-500",   badge: "bg-amber-500/15 text-amber-400 border-amber-500/20" },
  LOW:      { bar: "bg-blue-500",    badge: "bg-blue-500/15 text-blue-400 border-blue-500/20" },
  POSITIVE: { bar: "bg-emerald-500", badge: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20" },
};

function RiskGauge({ score = 0 }) {
  const pct  = Math.round(score * 100);
  const hue  = pct < 35 ? 145 : pct < 55 ? 48 : pct < 72 ? 30 : 0;
  const color= `hsl(${hue}, 75%, 55%)`;
  const r    = 54;
  const circ = 2 * Math.PI * r;
  const dash = circ * (1 - score);

  return (
    <div className="flex flex-col items-center">
      <div className="relative w-36 h-36">
        <svg className="w-full h-full -rotate-90" viewBox="0 0 120 120">
          <circle cx="60" cy="60" r={r} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="10" />
          <circle
            cx="60" cy="60" r={r}
            fill="none"
            stroke={color}
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={circ}
            strokeDashoffset={dash}
            style={{ transition: "stroke-dashoffset 1s ease, stroke 1s ease" }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-3xl font-extrabold text-white tabular-nums">{pct}<span className="text-xl">%</span></span>
          <span className="text-xs text-gray-500">Risk Score</span>
        </div>
      </div>
    </div>
  );
}

function SignalBar({ signal }) {
  const cfg  = CONTRIB_CONFIG[signal.contribution] || CONTRIB_CONFIG.LOW;
  const pct  = Math.round(signal.value * 100);
  const isPositive = signal.contribution === "POSITIVE";
  return (
    <div className="py-3 border-b border-white/5 last:border-0">
      <div className="flex items-start justify-between gap-3 mb-2">
        <p className="text-sm text-gray-300 leading-snug flex-1">{signal.human_label}</p>
        <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium shrink-0 ${cfg.badge}`}>
          {isPositive ? "✓ Good" : signal.contribution}
        </span>
      </div>
      {!isPositive && (
        <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-700 ${cfg.bar}`}
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

function SubScore({ label, value, emoji }) {
  const pct = Math.round((value || 0) * 100);
  return (
    <div className="bg-black/20 rounded-xl p-3 border border-white/5 text-center">
      <div className="text-xl mb-1">{emoji}</div>
      <div className="text-white font-bold text-xl tabular-nums">{pct}<span className="text-sm">%</span></div>
      <div className="text-gray-500 text-xs mt-0.5">{label}</div>
    </div>
  );
}

function BaselineDeltaSection({ delta }) {
  if (!delta?.has_baseline) return null;
  const rows = [
    { key: "speech_rate_delta",        label: "Speech Rate",     unit: " wps",  warn: (v) => v > 0.3 },
    { key: "filler_ratio_delta",       label: "Filler Words",    unit: "%",     warn: (v) => v < -0.03, fmt: (v) => (v * 100).toFixed(1) },
    { key: "structure_rigidity_delta", label: "Formality",       unit: "",      warn: (v) => v > 0.15, fmt: (v) => v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2) },
    { key: "personalization_delta",    label: "Personalization", unit: "",      warn: (v) => v < -0.10, fmt: (v) => v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2) },
  ];
  return (
    <div className="mt-5">
      <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">
        Baseline Comparison (Intro → Technical)
      </p>
      <div className="grid grid-cols-2 gap-2">
        {rows.map(({ key, label, unit, warn, fmt }) => {
          const v = delta[key] ?? 0;
          const isWarn = warn(v);
          const display = fmt ? fmt(v) + unit : (v > 0 ? "+" : "") + v.toFixed(2) + unit;
          return (
            <div
              key={key}
              className={`rounded-xl px-3 py-2 border ${isWarn ? "bg-amber-500/8 border-amber-500/25" : "bg-white/[0.02] border-white/8"}`}
            >
              <p className="text-xs text-gray-500">{label}</p>
              <p className={`text-sm font-bold ${isWarn ? "text-amber-400" : "text-gray-300"}`}>
                {display} {isWarn && "⚠"}
              </p>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-gray-600 mt-2">
        Anomaly score: {Math.round((delta.baseline_anomaly_score || 0) * 100)}%
      </p>
    </div>
  );
}

function EyeSection({ eyeScore = 0, eyeExplanations = [] }) {
  const pct = Math.round(eyeScore * 100);
  if (pct === 0 && eyeExplanations.length === 0) return null;
  return (
    <div className="mt-5">
      <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">
        👁 Eye Attention Analysis
      </p>
      <div className="bg-black/20 border border-white/8 rounded-xl p-4">
        <div className="flex items-center gap-3 mb-3">
          <div className="h-2 flex-1 bg-white/5 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-700 ${pct > 60 ? "bg-red-500" : pct > 35 ? "bg-amber-500" : "bg-emerald-500"}`}
              style={{ width: `${Math.min(pct, 100)}%` }}
            />
          </div>
          <span className="text-white text-sm font-bold tabular-nums shrink-0">{pct}%</span>
        </div>
        {eyeExplanations.length > 0 ? (
          <ul className="space-y-1.5">
            {eyeExplanations.map((ex, i) => (
              <li key={i} className="text-xs text-gray-400 flex gap-2">
                <span className="text-amber-400 shrink-0">•</span>
                {ex}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-gray-500">No significant eye attention anomalies detected.</p>
        )}
      </div>
    </div>
  );
}

function Timeline({ events = [] }) {
  if (!events?.length) return null;
  return (
    <div className="mt-5">
      <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">
        📋 Event Timeline
      </p>
      <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
        {events.map((ev, i) => (
          <div key={i} className="flex items-start gap-3 text-xs">
            <span className="font-mono text-gray-600 shrink-0">{ev.time || "--:--"}</span>
            <span className="text-gray-400 flex-1">{ev.note}</span>
            {ev.details && <span className="text-gray-600 shrink-0 text-[10px]">{ev.details}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function RiskReportCard({ result }) {
  if (!result) return null;

  const labelCfg = LABEL_CONFIG[result.risk_label] || LABEL_CONFIG.REVIEW;
  const signals  = result.top_signals || [];

  const recommendationColor = useMemo(() => {
    if (result.recommendation?.includes("Required"))   return "text-red-400 bg-red-500/10 border-red-500/25";
    if (result.recommendation?.includes("Recommended")) return "text-amber-400 bg-amber-500/10 border-amber-500/25";
    if (result.recommendation?.includes("Caution"))    return "text-yellow-400 bg-yellow-500/10 border-yellow-500/25";
    return "text-emerald-400 bg-emerald-500/10 border-emerald-500/25";
  }, [result.recommendation]);

  return (
    <div className="glass-card p-6 animate-fade-in space-y-5">

      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <span className="text-2xl">{labelCfg.emoji}</span>
        <div>
          <h3 className="text-white font-bold text-lg leading-none">{labelCfg.text}</h3>
          <p className="text-gray-500 text-xs mt-0.5">
            Confidence: {Math.round((result.confidence || 0.5) * 100)}%
          </p>
        </div>
        <div className={`ml-auto px-3 py-1.5 rounded-lg border text-xs font-semibold ${recommendationColor}`}>
          {result.recommendation || "Proceed"}
        </div>
      </div>

      {/* ── Risk Gauge + Sub-scores ──────────────────────────────── */}
      <div className="flex flex-col items-center gap-4">
        <RiskGauge score={result.final_score || 0} />
        <div className="grid grid-cols-4 gap-2 w-full">
          <SubScore label="Semantic" value={result.semantic_similarity} emoji="🔍" />
          <SubScore label="Memory"   value={result.memorization_score}  emoji="🧠" />
          <SubScore label="Behavior" value={result.behavior_score}      emoji="📊" />
          <SubScore label="Eye"      value={result.eye_score}           emoji="👁" />
        </div>
      </div>

      {/* ── Plain-English Summary ─────────────────────────────────── */}
      <div className="bg-black/25 border border-white/8 rounded-xl px-4 py-3">
        <p className="text-gray-300 text-sm leading-relaxed">{result.verdict_summary}</p>
      </div>

      {/* ── Top Signals ───────────────────────────────────────────── */}
      {signals.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">
            Contributing Signals
          </p>
          <div>
            {signals.map((s, i) => <SignalBar key={i} signal={s} />)}
          </div>
        </div>
      )}

      {/* ── Eye Attention ─────────────────────────────────────────── */}
      <EyeSection
        eyeScore={result.eye_score || 0}
        eyeExplanations={result.eye_explanations || []}
      />

      {/* ── Baseline Delta ────────────────────────────────────────── */}
      <BaselineDeltaSection delta={result.baseline_delta} />

      {/* ── Timeline ─────────────────────────────────────────────── */}
      <Timeline events={result.timeline_events || result.integrity_events} />
    </div>
  );
}
