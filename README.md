# laya-code-router

Automatic per-turn model routing for Claude Code and OpenAI Codex, powered by **local LAYA**
(`convaiinnovations/laya`) instead of a hosted decision API. Simple work goes to the fast
tier, difficult work to the strong tier — $0, no API key for routing, nothing sent to any
third-party service for the decision.

Ported from [gargpratyush/jev-router](https://github.com/gargpratyush/jev-router) (MIT): the
hosted TypeSafe Jev HTTP call is replaced with an in-process LAYA sidecar. The launcher,
loopback proxy, sentinel model, per-session state, status line, and Codex commentary
architecture are unchanged; routing never leaves your machine.

| Command | Interface | Authentication | Routing decision |
| --- | --- | --- | --- |
| `laya-claude` | Claude Code | Existing `claude login` | Status line |
| `laya-codex` | OpenAI Codex | Existing `codex login` | Commentary line |

Both commands launch the real upstream CLI. Laya only chooses the model for a fresh user turn.

## Requirements

- Node.js 20.12+
- Python 3.10+ with the `laya` package (`pip install laya`) and its weights
  (`convaiinnovations/laya`, downloaded automatically on first use — ~40s once, then cached)
- At least one supported CLI: [Claude Code](https://code.claude.com/docs/en/setup) or
  [OpenAI Codex](https://developers.openai.com/codex/cli)

Point the launcher at your interpreter if `python3` is not the one with `laya`:

```bash
echo "LAYA_PYTHON=$HOME/laya-venv/bin/python" >> ~/.laya-router.env
```

## Quick start

```bash
npm install -g laya-code-router
laya-claude        # or: laya-codex
```

Routing is on by default and needs no key: the decision model runs locally, so there is no
hosted call to authorize. No Anthropic or OpenAI API key is required when the CLI is already
logged in. Every CLI argument is forwarded:

```bash
laya-claude --resume
laya-claude -p "fix the failing test"
laya-codex resume --last
```

## How it works

Each command starts a loopback proxy and a long-lived LAYA sidecar, launches the real CLI,
and forwards the CLI's existing authorization headers without reading, storing, or modifying
them. The sidecar answers one NDJSON line per routing decision and stays warm for the whole
session, so the model load is paid once.

```text
you -> Claude Code -> laya-claude proxy -> Anthropic
                         |            \
                         +-> LAYA sidecar (local, ~40-50ms warm)

you -> OpenAI Codex -> laya-codex proxy -> OpenAI
                         |            \
                         +-> LAYA sidecar
```

Claude Code uses `ANTHROPIC_BASE_URL`; Codex uses a temporary custom provider with
`requires_openai_auth=true`. Both use `laya-router` as the routing sentinel. Any concrete
model selected by the user passes through unchanged. The user's prompt text goes only to the
local LAYA sidecar — never to a third party.

## Routing policy

One LAYA call per fresh user turn scores three rubrics (task complexity, reasoning required,
tool complexity) on a trivial/ordinary/hard scale. `src/policy.mjs` then applies these rules:

- explicit requests such as `use opus`, `use luna`, or `use strong` win;
- failure, timeout, or a sidecar crash keeps the current model;
- the mean rubric score maps onto a tier deterministically:
  - `>= 0.62` → strong (Opus / `gpt-5.6-sol`)
  - `< 0.18` → fast (Haiku / `gpt-5.6-luna`)
  - between → balanced (Sonnet / `gpt-5.6-terra`)
- low confidence (below `minConfidence`) never downgrades and caps upgrades at the balanced tier;
- large conversations refuse downgrades that would waste more prompt-cache work than they save;
- unavailable tiers step upward rather than silently choosing a weaker model;
- the long tier (Fable / `gpt-6-astra`) is disabled unless `LAYA_ALLOW_FABLE=1`.

### Calibration notes (measured 2026-09-23, M2 Max, default checkpoint)

- LAYA's N-way choice head is **uncalibrated for wide option sets** (7-option confidence
  0.02-0.03, near-flat distribution). The N-way pick is sent for the explanation UI only and
  never drives routing — the score rubric carries the decision.
- The score rubric separates genuinely hard work upward (0.62+: auth redesign, whole-repo
  migration) but does not distinguish trivial from ordinary prompts (both land 0.44-0.51 —
  differences there are noise). The saving comes from the no-router baseline, which pins the
  session at Opus: ordinary work drops to the balanced tier instead of riding Opus all session.
- The confidence gate is calibrated to the observed distribution (0.16-0.44 across classes);
  the upstream 0.3 default would cap nearly every upgrade with this checkpoint.
- `convaiinnovations/laya-typed-decisions` was measured **worse** (classes fully overlap,
  0.54-0.67) and is not the default. A calibrated checkpoint drops in via `LAYA_MODEL`
  without protocol changes.

Tool-loop continuations keep the tier chosen at the start of the turn. Main conversations and
sub-agents are pinned separately. Routing is fail-open: a LAYA failure never blocks the CLI.

## Configuration

| Variable | Effect |
| --- | --- |
| `LAYA_PYTHON` | Python interpreter with the `laya` package (default: `python3`). |
| `LAYA_DISABLE_ROUTING` | Set to `1` to launch the CLI untouched with no proxy or sidecar (routing is on by default). `LAYA_NO_ROUTING=1` is an alias. |
| `LAYA_MODEL` | Force a specific checkpoint repo (HF id) for all decisions. |
| `LAYA_ALLOW_FABLE` | Enables the opt-in long tier. |
| `LAYA_DEBUG` | Logs decisions and rewrites to `~/.laya-claude.log` in interactive sessions. |
| `LAYA_DUMP` | Dumps request bodies for debugging wire-format changes. |
| `LAYA_NO_STATUSLINE` | Disables the injected Claude status line. |
| `LAYA_CODEX_FAST_MODEL` / `LAYA_CODEX_BALANCED_MODEL` / `LAYA_CODEX_STRONG_MODEL` / `LAYA_CODEX_LONG_MODEL` | Codex tier models; defaults to `gpt-5.6-luna` / `gpt-5.6-terra` / `gpt-5.6-sol` / `gpt-6-astra`. |

Existing environment variables have highest precedence, followed by `.env` in the launch
directory, `~/.laya-router.env`, and the legacy `~/.laya-claude.env`.

## Differences from upstream (jev-router)

- The hosted TypeSafe Jev call is replaced with a local LAYA sidecar (Python child process,
  NDJSON line protocol, id-echo handshake). `$0`, no key, nothing leaves the machine.
- The tier decision comes from a deterministic score→tier table, not an N-way model pick
  (LAYA's choice head is uncalibrated on wide sets — see Calibration notes).
- No third-party dependency at runtime: `@typesafe-ai/sdk` is gone; the sidecar is stdlib
  plus `laya`.
- The sidecar is killed when the launcher exits, so no orphaned model processes are left
  behind.

## Development

```bash
npm install
npm test
LAYA_PYTHON=/path/to/laya-venv/bin/python npm run live-routing
node bin/laya-claude.mjs -p "what is 2+2?"
```

The test suite covers shared policy (rubric mapping, overrides, confidence gates, cache
guard, tier substitution), both request formats, model rewriting, capability handling,
settings restoration, Codex authentication forwarding, native model-picker injection, and
decision display. `npm run live-routing` exercises the real local LAYA weights.

## Limitations

* The first decision of a session pays the ~40s model load; the launcher pre-warms the
  sidecar while the CLI starts, so interactive use rarely waits.
* Claude Code and Codex request formats are not public contracts. Use `LAYA_DUMP` to
  diagnose upstream changes.
* The local LAYA checkpoint's score head is only as good as its training — see Calibration
  notes for measured behavior, and re-calibrate when swapping checkpoints via `LAYA_MODEL`.

## License

MIT — inherited from [gargpratyush/jev-router](https://github.com/gargpratyush/jev-router).
