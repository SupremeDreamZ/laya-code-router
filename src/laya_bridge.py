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

The model is loaded as soon as the process starts, and the caller is told how that went with
lines that carry an "event" instead of an "id":

  {"event": "loading"}                  the load has begun
  {"event": "ready", "ms": 41210}       the model loaded and answered a real routing request
  {"event": "failed", "error": "..."}   it did not; the next request tries again

Without this the model loaded on the first prompt of the day, and that prompt waited for it.
LAYA_EAGER_LOAD=0 turns it off: the model then loads on the first request, as it used to, and
no event is sent. A caller that does not know these lines ignores them (they have no id).

Two threads. The main one only reads: it echoes each request's id the moment the line arrives and
queues the request, so the caller can always tell a busy model from one that cannot read its input.
A single worker owns the model: it loads it (when eager), answers that first routing request, then
answers the queue in order. One owner means no lock is needed around the model, and a prompt that
arrives mid-load simply waits its turn behind the load.

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
import os
import queue
import sys
import threading
import time

_ROUTER = None
_FORCED = None

# Both threads write to the same two streams, so a line is written whole under one lock and is
# never cut in half by a line from the other thread.
_OUT_LOCK = threading.Lock()


def _send(obj, stream=None):
    """One JSON line, written whole and flushed, so threads cannot interleave their lines."""
    line = json.dumps(obj) + "\n"
    with _OUT_LOCK:
        out = stream or sys.stdout
        out.write(line)
        out.flush()


def _get_router():
    """Load the LAYA Router once per process and keep it warm. Only the worker thread calls this."""
    global _ROUTER, _FORCED
    if _ROUTER is None:
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


DIGEST_LIMIT = 600
DIGEST_EDGE = 300


def task_digest(text):
    """Squash whitespace and fit the prompt in LAYA's token budget.

    A long paste usually carries the ask at the start or at the end, so keep both ends and
    drop the middle rather than cutting everything after the first 600 characters.
    """
    flat = " ".join(str(text).split())
    if len(flat) <= DIGEST_LIMIT:
        return flat
    return f"{flat[:DIGEST_EDGE].rstrip()} [...] {flat[-DIGEST_EDGE:].lstrip()}"


def build_state(payload):
    """Compact state digest: differentiating facts first, within the token budget."""
    task_text = task_digest(payload.get("state", ""))
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


def typed(payload):
    """Answer caller-written typed questions (the guard, the file inspector, compaction).

    `questions` is {id: {type, instructions, criteria?}}. noul takes NO criteria key at all (a
    string there crashes laya 0.3.x), so it is dropped here rather than trusted to every caller.
    """
    state = str(payload.get("state") or "")
    questions = payload.get("questions") or {}
    if not isinstance(questions, dict) or not questions:
        raise ValueError("no questions")
    clean = {}
    for qid, q in questions.items():
        if not isinstance(q, dict) or q.get("type") not in ("noul", "choice", "score"):
            raise ValueError(f"question {qid}: type must be noul, choice or score")
        item = {"type": q["type"], "instructions": str(q.get("instructions") or "")}
        if q["type"] != "noul" and q.get("criteria") is not None:
            item["criteria"] = q["criteria"]
        clean[qid] = item
    response = _get_router().predict(state, clean, model=_FORCED)
    return {"id": payload.get("id"), "answers": response.get("answers", {})}


def handle(payload):
    """Answer one routing request. Raises on any failure; caller reports it."""
    if payload.get("op") == "typed":
        return typed(payload)
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
        # Second routing signal: a yes/no probability that the work needs investigating an
        # unknown cause, weighing design options, or changing several files. The blended
        # score above cannot separate Haiku-shaped work from ordinary work well on its own
        # (AUC 0.82 pooled over 116 labeled prompts); this vetoes the cases it would misplace.
        "needs_judgment": {
            "type": "noul",
            "instructions": (
                "Would doing this correctly require investigating an unknown cause, "
                "weighing design options, or changing several files or modules?"
            ),
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

    def noul_of(qid):
        a = answers.get(qid) or {}
        try:
            return max(0.0, min(float(a["noul"]), 1.0))
        except (KeyError, TypeError, ValueError):
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
            "judgment": noul_of("needs_judgment"),
            "contextSize": min((payload.get("context_tokens") or 0) / 200000, 1.0),
        },
    }


# The request the warm-up answers: a real routing decision, so "ready" means the whole path works.
WARM_REQUEST = {
    "id": None,
    "state": "What is 2 + 2?",
    "current_model": "claude-sonnet-5-5",
    "context_tokens": 1000,
    "models": [{"tier": "sonnet", "id": "claude-sonnet-5-5"}],
}


def warm():
    """Load the model and answer one real routing request. Raises if either step fails."""
    handle(dict(WARM_REQUEST))


def _answer(payload):
    """One request, answered or failed. The caller already has the echo."""
    rid = payload.get("id")
    started = time.time()
    try:
        out = handle(payload)
    except Exception as err:  # noqa: BLE001 — fail-open: any failure keeps the current model
        # The id rides on the error line too, so a failed request never desynchronizes the
        # caller's response matching.
        _send({"id": rid, "error": f"laya failed: {err}"}, sys.stderr)
        return
    out["ms"] = int((time.time() - started) * 1000)
    _send(out)


def _worker(jobs, eager):
    """Owns the model: loads it first when eager, then answers requests in the order they came."""
    if eager:
        _send({"event": "loading"})
        started = time.time()
        try:
            warm()
        except Exception as err:  # noqa: BLE001 — reported; the next request tries the load again
            _send({"event": "failed", "error": f"laya failed: {err}"})
        else:
            _send({"event": "ready", "ms": int((time.time() - started) * 1000)})
    while True:
        payload = jobs.get()
        if payload is None:
            return
        _answer(payload)


def main():
    eager = os.environ.get("LAYA_EAGER_LOAD", "1") != "0"
    jobs = queue.Queue()
    # A daemon thread: if the caller goes away the process must not wait for a model that is
    # still loading.
    threading.Thread(target=_worker, args=(jobs, eager), name="laya-worker", daemon=True).start()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as err:
            _send({"id": None, "error": f"bad request json: {err}"}, sys.stderr)
            continue
        # Echo the id BEFORE the model is involved at all: the caller runs a fast-fail timer on
        # the echo, and the model may be mid-load for a minute. The echo says "I read your line",
        # nothing more.
        _send({"id": payload.get("id")})
        jobs.put(payload)


if "--warm" in sys.argv[1:]:
    # Setup probe: load the model, answer one real routing request, exit 0 only if it worked.
    # Proves the venv, the weights download and the decision path all work before the user
    # ever routes a real turn — a broken install surfaces here, not mid-session.
    warm()
    sys.exit(0)

if __name__ == "__main__":
    main()
