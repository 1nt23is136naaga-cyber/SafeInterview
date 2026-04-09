/**
 * Highlights matched phrases within a transcript text.
 */
function highlightText(text, phrases) {
    if (!phrases || phrases.length === 0) return [{ text, highlight: false }];

    // Build a regex that matches any of the phrases (case-insensitive)
    const escaped = phrases.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const pattern = new RegExp(`(${escaped.join("|")})`, "gi");

    const parts = [];
    let lastIndex = 0;
    let match;

    while ((match = pattern.exec(text)) !== null) {
        if (match.index > lastIndex) {
            parts.push({ text: text.slice(lastIndex, match.index), highlight: false });
        }
        parts.push({ text: match[0], highlight: true });
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
        parts.push({ text: text.slice(lastIndex), highlight: false });
    }
    return parts;
}

export default function MatchedPhrasesHighlighter({ transcript, matchedPhrases = [], matchedQuestion = "" }) {
    if (!transcript) return null;

    const parts = highlightText(transcript, matchedPhrases);
    const hasMatches = matchedPhrases.length > 0;

    return (
        <div className="glass-card p-6 animate-slide-up">
            <p className="section-title">Matched Phrases</p>

            {matchedQuestion && (
                <div className="mb-4 p-3 bg-primary/10 border border-primary/30 rounded-xl">
                    <p className="text-xs text-primary-light font-semibold mb-0.5">Best Matching Question</p>
                    <p className="text-white text-sm">{matchedQuestion}</p>
                </div>
            )}

            {/* Transcript with highlights */}
            <div className="bg-black/30 rounded-xl p-4 text-sm leading-relaxed text-gray-300 border border-white/5 font-mono">
                {parts.map((part, i) =>
                    part.highlight ? (
                        <mark
                            key={i}
                            className="bg-yellow-400/25 text-yellow-200 rounded px-0.5 border-b border-yellow-400/50 not-italic"
                        >
                            {part.text}
                        </mark>
                    ) : (
                        <span key={i}>{part.text}</span>
                    )
                )}
            </div>

            {/* Phrase list */}
            {hasMatches && (
                <div className="mt-4">
                    <p className="text-xs text-gray-500 mb-2">
                        {matchedPhrases.length} phrase{matchedPhrases.length !== 1 ? "s" : ""} matched
                    </p>
                    <div className="flex flex-wrap gap-2">
                        {matchedPhrases.map((phrase, i) => (
                            <span
                                key={i}
                                className="px-2 py-1 bg-yellow-500/15 border border-yellow-500/25 text-yellow-300 rounded-lg text-xs font-mono"
                            >
                                "{phrase}"
                            </span>
                        ))}
                    </div>
                </div>
            )}

            {!hasMatches && (
                <p className="text-gray-500 text-sm mt-2">No exact phrase matches detected.</p>
            )}
        </div>
    );
}
