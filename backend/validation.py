"""
validation.py — Validation / Test Mode for AntiGravity SafeInterview.

Provides:
  - VALIDATION_SCENARIOS: 5 canonical test cases with expected outputs
  - run_validation(): executes all scenarios and returns pass/fail + deltas
  - Exposed via POST /validate (gated by DEV_MODE=true)

Scenarios:
  1. Genuine — natural, original answer, no events
  2. Scripted — word-for-word database match, high similarity
  3. Suspicious behavior — many tab switches + focus losses
  4. Mixed signals — high semantic match but natural speech
  5. Borderline — moderate scores across all components
"""

import logging
from typing import Any

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Canonical test scenarios
# ─────────────────────────────────────────────────────────────────────────────

VALIDATION_SCENARIOS: list[dict] = [
    {
        "id":          "genuine_response",
        "name":        "Genuine Candidate Response",
        "description": "Natural, personalised, conversational answer with fillers and pauses.",
        "analysis_results": [
            {
                "semantic_similarity": 0.12,
                "memorization_score":  0.08,
                "behavior_score":      0.18,
                "linguistic_features": {
                    "structure_rigidity":    0.10,
                    "linearity_score":       0.15,
                    "lexical_richness":      0.60,
                    "redundancy_ratio":      0.05,
                    "personalization_score": 0.75,
                },
                "baseline_delta": {
                    "has_baseline":          True,
                    "baseline_anomaly_score": 0.08,
                },
            }
        ],
        "integrity_events": [],
        "expected": {
            "risk_level":            "LOW",
            "confidence_label_in":   ["High", "Moderate"],
            "final_score_max":       35,
        },
    },
    {
        "id":          "scripted_response",
        "name":        "Scripted / Memorised Response",
        "description": "Near-verbatim match to reference answer bank, formal structure, no fillers.",
        "analysis_results": [
            {
                "semantic_similarity": 0.90,
                "memorization_score":  0.85,
                "behavior_score":      0.78,
                "linguistic_features": {
                    "structure_rigidity":    0.82,
                    "linearity_score":       0.88,
                    "lexical_richness":      0.72,
                    "redundancy_ratio":      0.30,
                    "personalization_score": 0.12,
                },
                "baseline_delta": {
                    "has_baseline":          True,
                    "baseline_anomaly_score": 0.80,
                },
            }
        ],
        "integrity_events": [],
        "expected": {
            "risk_level":            "HIGH",
            "confidence_label_in":   ["High", "Moderate"],
            "final_score_min":       67,
        },
    },
    {
        "id":          "behavioral_anomaly",
        "name":        "Suspicious Behaviour Only",
        "description": "Natural speech but heavy tab-switching and focus loss suggesting external assistance.",
        "analysis_results": [
            {
                "semantic_similarity": 0.30,
                "memorization_score":  0.22,
                "behavior_score":      0.20,
                "linguistic_features": {
                    "structure_rigidity":    0.20,
                    "linearity_score":       0.25,
                    "lexical_richness":      0.50,
                    "redundancy_ratio":      0.10,
                    "personalization_score": 0.65,
                },
                "baseline_delta": {
                    "has_baseline":          False,
                    "baseline_anomaly_score": 0.0,
                },
            }
        ],
        "integrity_events": [
            {"event_type": "tab_switch"}  for _ in range(8)
        ] + [
            {"event_type": "focus_loss"} for _ in range(4)
        ],
        "expected": {
            "risk_level":            "MEDIUM",
            "confidence_label_in":   ["Low", "Moderate"],
        },
    },
    {
        "id":          "mixed_signals",
        "name":        "Mixed Signals (High Similarity, Natural Speech)",
        "description": "High semantic match but speech patterns remain natural — possible topic overlap.",
        "analysis_results": [
            {
                "semantic_similarity": 0.76,
                "memorization_score":  0.40,
                "behavior_score":      0.22,
                "linguistic_features": {
                    "structure_rigidity":    0.30,
                    "linearity_score":       0.35,
                    "lexical_richness":      0.58,
                    "redundancy_ratio":      0.12,
                    "personalization_score": 0.55,
                },
                "baseline_delta": {
                    "has_baseline":          True,
                    "baseline_anomaly_score": 0.30,
                },
            }
        ],
        "integrity_events": [],
        "expected": {
            "risk_level":            "MEDIUM",
            "confidence_label_in":   ["Low", "Moderate", "High"],   # computed scores may still be numerically close
        },
    },
    {
        "id":          "borderline_response",
        "name":        "Borderline Response",
        "description": "All signals at moderate level — system should return MEDIUM with moderate confidence.",
        "analysis_results": [
            {
                "semantic_similarity": 0.50,
                "memorization_score":  0.50,
                "behavior_score":      0.50,
                "linguistic_features": {
                    "structure_rigidity":    0.45,
                    "linearity_score":       0.50,
                    "lexical_richness":      0.50,
                    "redundancy_ratio":      0.20,
                    "personalization_score": 0.45,
                },
                "baseline_delta": {
                    "has_baseline":          True,
                    "baseline_anomaly_score": 0.50,
                },
            }
        ],
        "integrity_events": [
            {"event_type": "tab_switch"},
            {"event_type": "tab_switch"},
        ],
        "expected": {
            "risk_level":         "MEDIUM",
            "confidence_label_in": ["Moderate", "High"],
            "final_score_min":    30,
            "final_score_max":    75,
        },
    },
]


# ─────────────────────────────────────────────────────────────────────────────
# Validation runner
# ─────────────────────────────────────────────────────────────────────────────

def run_validation() -> dict:
    """
    Execute all canonical validation scenarios through compute_final_score()
    and compare outputs against expected values.

    Returns:
        {
            "total": int,
            "passed": int,
            "failed": int,
            "results": list[ScenarioResult],
            "summary": str,
        }
    """
    from report import compute_final_score

    results = []
    passed  = 0
    failed  = 0

    for scenario in VALIDATION_SCENARIOS:
        sid    = scenario["id"]
        exp    = scenario["expected"]

        try:
            report = compute_final_score(
                scenario["analysis_results"],
                scenario["integrity_events"],
            )
        except Exception as e:
            logger.error("Scenario %s raised exception: %s", sid, e)
            results.append({
                "scenario_id":   sid,
                "scenario_name": scenario["name"],
                "status":        "ERROR",
                "error":         str(e),
            })
            failed += 1
            continue

        checks = []
        ok = True

        # Check 1: risk level
        if "risk_level" in exp:
            match = report["risk_level"] == exp["risk_level"]
            checks.append({
                "field":    "risk_level",
                "expected": exp["risk_level"],
                "got":      report["risk_level"],
                "pass":     match,
            })
            if not match:
                ok = False

        # Check 2: confidence label
        if "confidence_label_in" in exp:
            conf_label = report.get("confidence_label", "")
            match = conf_label in exp["confidence_label_in"]
            checks.append({
                "field":    "confidence_label",
                "expected": exp["confidence_label_in"],
                "got":      conf_label,
                "pass":     match,
            })
            if not match:
                ok = False

        # Check 3: final_score_min
        if "final_score_min" in exp:
            match = report["final_score"] >= exp["final_score_min"]
            checks.append({
                "field":    "final_score_min",
                "expected": f">= {exp['final_score_min']}",
                "got":      report["final_score"],
                "pass":     match,
            })
            if not match:
                ok = False

        # Check 4: final_score_max
        if "final_score_max" in exp:
            match = report["final_score"] <= exp["final_score_max"]
            checks.append({
                "field":    "final_score_max",
                "expected": f"<= {exp['final_score_max']}",
                "got":      report["final_score"],
                "pass":     match,
            })
            if not match:
                ok = False

        status = "PASS" if ok else "FAIL"
        if ok:
            passed += 1
        else:
            failed += 1

        results.append({
            "scenario_id":   sid,
            "scenario_name": scenario["name"],
            "description":   scenario["description"],
            "status":        status,
            "final_score":   report["final_score"],
            "risk_level":    report["risk_level"],
            "confidence_score":  report.get("confidence_score"),
            "confidence_label":  report.get("confidence_label"),
            "adaptive_weights":  report.get("adaptive_weights"),
            "signal_strengths":  report.get("signal_strengths"),
            "checks":        checks,
        })

        logger.info(
            "[VALIDATE] %s → %s | score=%.1f risk=%s confidence=%s%%",
            sid, status, report["final_score"], report["risk_level"],
            report.get("confidence_score", "?"),
        )

    total    = len(VALIDATION_SCENARIOS)
    summary  = f"{passed}/{total} scenarios passed."
    if failed:
        summary += f" ⚠️ {failed} scenario(s) failed — review thresholds or weights."

    return {
        "total":   total,
        "passed":  passed,
        "failed":  failed,
        "results": results,
        "summary": summary,
    }
