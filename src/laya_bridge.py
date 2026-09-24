#!/usr/bin/env python3
"""LAYA decision sidecar for laya-code-router.

Replaces the hosted TypeSafe Jev HTTP call from the original jev-router with a local
LAYA (convaiinnovations/laya) inference call. $0, no key, runs on Apple Silicon MPS.

Line protocol: one JSON request per line on stdin, one JSON response per line on
stdout (NDJSON). The sidecar is a long-lived child spawned by the launcher for the
whole CLI session, so the ~40s model load is paid once and routing stays warm
(~35-50ms per decision on MPS). A malformed line or any LAYA failure produces a
{"error": ...} line on stderr; the JS layer reads that as "keep the current model" —
routing must never block a prompt.

Request (one line):

  {
    "state": "<fresh user prompt>",
    "current_model": "haiku",            // tier active in the session
    "context_tokens": 6200,              // approximate conversation size
    "models": [                          // exact models available to the account
      {"id": "claude-haiku-4-5-20251001", "tier": "haiku", "description": "..."},
      {"id": "claude-sonnet-5", "tier": "sonnet", "description": "..."}
    ]
  }

Response (one line):

  {
    "answers": {
      "task_complexity": {"type": "score", "score": 1.4, "confidence": 0.62, ...},
      "reasoning_required": {...},
      "tool_complexity": {...},
      "model_tier": {"type": "choice", "choice": "sonnet", "confidence": 0.58, ...}
    },
    "probabilities": {"haiku": 0.31, "sonnet": 0.42, "opus": 0.27},
    "choice": "sonnet",
    "confidence": 0.58,
    "request": {"state": {"request": "...", "session": {...}, "environment": {...}}},
    "response": { ...raw LAYA payload... },
    "metrics": {
      "taskComplexity": 0.16, "reasoningRequired": 0.22,
      "toolComplexity": 0.11, "contextSize": 0.03
    },
    "ms": 41
  }

Design notes (verified against laya 0.3.4 on 2026-09-22/23):

* The choice head is UNCALIBRATED for wide option sets (7-option confidence 0.02-0.03,
  near-flat distribution — 0.002 gaps are noise). The per-turn tier pick is therefore a
  THREE-level score question (fast/balanced/strong) instead of an N-way choice: score
  heads stay spread on narrow rubrics, and the JS policy layer maps the expected score
  to a tier deterministically. The N-way choice is still emitted (model_tier) for the
  explanation UI, but the policy layer ignores it for routing.
* Score questions take a LIST of level strings as criteria; noul takes NO criteria key
  (a string criteria crashes render_options); choice criteria are a dict.
* instructions must exist even if empty — LAYA's converter crashes on absent keys.
* Long states (>~500 chars) truncate at 512 tokens and saturate the score head, so the
  state digest is kept short and leads with the differentiating facts.
* LAYA_MODEL=<hf-repo-id> forces a specific checkpoint (e.g. convaiinnovations/laya-typed-decisions).
* Any failure exits non-zero with a JSON error on stderr; the JS layer keeps the current model.
"""

import json
import sys
import time

_ROUTER = None
_FORCED = None


def _get_router():
    """Load the LAYA Router once per process and keep it warm."""
    global _ROUTER, _FORCED
    if _ROUTER is None:
        import os

        from laya import Router

        override = os.environ.get("LAYA_MODEL", "").strip()
        if override:
            # LAYA_MODEL names a checkpoint repo (HF id or a name registered here).
            _ROUTER = Router(models={"laya": override})
            _FORCED = "laya"
        else:
            _ROUTER = Router()
            _FORCED = None
    return _ROUTER


# Heuristic stakes detection (architecture §5A.4): high-stakes tasks must route to the
# strongest tier, never the cheapest, even when a cheap one would "work".
HIGH_STAKES_MARKERS = (
    "arbitrat", "highest-stakes", "high stakes", "final review", "release decision",
    "disagree", "dispute", "conflict", "irreversib", "critical",
    "redesign", "complex multi-module", "security audit",
)


def stakes(text):
    """Classify the task's stakes from its text: high / elevated / normal."""
    low = text.lower()
    hits = sum(1 for m in HIGH_STAKES_MARKERS if m in low)
    if hits >= 2:
        return "high"
    return "elevated" if hits == 1 else "normal"


def build_state(payload):
    """Compact state digest: differentiating facts first, within the token budget."""
    task_text = " ".join(str(payload.get("state", "")).split())[:600]
    risk = stakes(task_text)
    if risk == "high":
        routing_rule = (
            "STAKES: HIGH — this is a high-stakes or final-arbitration task. Route to "
            "the strongest available model regardless of cost; never the cheapest tier."
        )
    elif risk == "elevated":
        routing_rule = (
            "STAKES: ELEVATED — some complexity present. Prefer a stronger model when "
            "quality justifies the cost."
        )
    else:
        routing_rule = (
            "STAKES: NORMAL — routine task. Choose the cheapest model that clears the "
            "quality bar; escalate only if genuinely hard."
        )
    return (
        f"Task: {task_text or 'general request'}. "
        f"Signals: current_tier={payload.get('current_model', 'unknown')}, "
        f"context_tokens={payload.get('context_tokens', 0)}, "
        f"available_models={[m.get('id', '') for m in payload.get('models', [])]}. "
        f"{routing_rule}"
    )


def handle(payload):
    """Answer one routing request. Raises on any failure; caller reports it."""
    models = payload.get("models") or []
    if not models:
        raise ValueError("no models available")

    router = _get_router()
    state = build_state(payload)
    questions = {
        # Primary routing signal: a 3-level score rubric. Score heads stay spread on
        # narrow rubrics (verified 2026-09-22); the JS policy maps the expected score
        # to a tier deterministically instead of trusting an N-way argmax.
        "task_complexity": {
            "type": "score",
            "instructions": (
                "How complex is the coding task overall, including ambiguity, scope, "
                "and blast radius?"
            ),
            "criteria": [
                "trivial: mechanical or purely factual work",
                "ordinary: bounded day-to-day engineering",
                "hard: hard reasoning, ambiguity, or high blast radius",
            ],
        },
        "reasoning_required": {
            "type": "score",
            "instructions": (
                "How much reasoning is required to complete the request correctly "
                "in one pass?"
            ),
            "criteria": [
                "none: run one obvious command",
                "some: implement a specified function or fix an understood local bug",
                "extensive: unknown-cause debugging, cross-module design, or migrations",
            ],
        },
        "tool_complexity": {
            "type": "score",
            "instructions": (
                "How complex is the tool use required, from no tools to many "
                "coordinated or stateful operations?"
            ),
            "criteria": [
                "none: no tools",
                "some: one or two tool calls",
                "many: coordinated or stateful multi-step tool use",
            ],
        },
        # Explanation-only N-way pick over the account's exact models. Emitted for
        # the explanation UI; NOT used for routing (uncalibrated on wide sets).
        "model_tier": {
            "type": "choice",
            "instructions": (
                "Pick the cheapest exact model that can fully complete this coding "
                "request in one pass, without retrying on a stronger model."
            ),
            "criteria": {
                m.get("id", f"model{i}"): m.get("description") or m.get("id", "")
                for i, m in enumerate(models)
            },
        },
    }
    response = router.predict(state, questions, model=_FORCED)
    answers = response.get("answers", {})

    def score_of(qid):
        a = answers.get(qid) or {}
        try:
            return max(0.0, min(float(a.get("score", 0)) / 2.0, 1.0))
        except (TypeError, ValueError):
            return None

    # Primary confidence signal: the mean of the three score-question confidences. The
    # N-way choice confidence is uncalibrated on wide sets and is NOT used for routing.
    confs = [
        answers[q]["confidence"]
        for q in ("task_complexity", "reasoning_required", "tool_complexity")
        if isinstance(answers.get(q), dict)
    ]
    try:
        conf_mean = round(sum(float(c) for c in confs) / len(confs), 4) if confs else None
    except (TypeError, ValueError):
        conf_mean = None

    # N-way probabilities over tiers, for the explanation UI and debugging.
    tier_probs = {}
    mt = answers.get("model_tier") or {}
    for m in models:
        mid = m.get("id", "")
        tier_probs[m.get("tier", mid)] = round(
            float((mt.get("probabilities") or {}).get(mid, 0)), 4
        )

    return {
        "id": payload.get("id"),
        "answers": answers,
        "probabilities": tier_probs,
        "choice": mt.get("choice"),
        "confidence": conf_mean,
        "request": {
            "state": {
                "request": payload.get("state", ""),
                "session": {
                    "current_model": payload.get("current_model", ""),
                    "context_tokens": payload.get("context_tokens", 0),
                },
                "environment": {"available_models": [m.get("id", "") for m in models]},
            }
        },
        "response": response,
        "metrics": {
            "taskComplexity": score_of("task_complexity"),
            "reasoningRequired": score_of("reasoning_required"),
            "toolComplexity": score_of("tool_complexity"),
            "contextSize": min((payload.get("context_tokens") or 0) / 200000, 1.0),
        },
    }


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as err:
            print(json.dumps({"id": None, "error": f"bad request json: {err}"}), file=sys.stderr)
            sys.stderr.flush()
            continue
        rid = payload.get("id")
        # Echo the id BEFORE running the model: the caller runs a fast-fail timer on the
        # echo, so a sidecar that loaded weights lazily would be killed mid-load on every
        # cold start. The echo is the readiness signal; the model load happens once, on
        # the first request, inside the caller's long deadline.
        print(json.dumps({"id": rid}))
        sys.stdout.flush()
        started = time.time()
        try:
            out = handle(payload)
        except Exception as err:  # noqa: BLE001 — fail-open: any failure keeps the current model
            # The id rides on the error line too, so a failed request never desynchronizes
            # the caller's response matching.
            print(json.dumps({"id": rid, "error": f"laya failed: {err}"}), file=sys.stderr)
            sys.stderr.flush()
            continue
        out["ms"] = int((time.time() - started) * 1000)
        print(json.dumps(out))
        sys.stdout.flush()


if __name__ == "__main__":
    main()
