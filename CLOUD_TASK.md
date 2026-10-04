# Cloud task: model fallback when a tier is rate-limited

Read `README.md` and the existing tests first. Run the suite with `LAYA_HOME="" npm test` (835 tests, all pass on master).

## Problem
When the plan's Opus (or Sonnet) allowance is exhausted, Anthropic answers `429 rate_limit_error` for that model. LAYA still routes to the capped model, so the user gets a dead turn even though another tier (e.g. Haiku) would answer. Verified 2026-10-04: Opus and Sonnet returned 429 while Haiku answered through the same proxy and token.

## Do
1. In the proxy, when the upstream returns 429 for a routed (not user-pinned) request, retry once on the next lower available tier (Opus -> Sonnet -> Haiku), adjusting the body the same way normal routing does (thinking/effort removed for tiers that don't take them). Remember a capped tier for a cooldown (respect `retry-after` / `anthropic-ratelimit-*-reset` headers when present, else a sensible default) so later turns skip it without a wasted request. Log the fallback as an event with a clear reason.
2. Never fall back when the user pinned a model (manual), and never upward.
3. Streaming: only fall back if no bytes have been sent to the client yet.
4. Tests for: 429 then success on lower tier, pinned model gets no fallback, cooldown skip, cooldown expiry, streaming already started.
5. Full suite green. Update README briefly.
Rules: no secrets in code or logs. Work on branch `cloud/rate-limit-fallback`; commit as you go; write REPORT.md; last commit message starts with `[CLOUD DONE]` (or `[CLOUD BLOCKED]` with the reason); push the branch. Do not touch master.
