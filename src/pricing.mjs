// What a routed token costs, so the app can show what the router saved against "everything on
// the strongest model". Prices are per million tokens, from
// platform.claude.com/docs/en/about-claude/pricing (checked 2026-09-30). They are list prices:
// a subscription plan does not bill per token, so every figure built on them is an estimate of
// API-equivalent cost, and the app labels it that way.

/** [input, 5m cache write, 1h cache write, cache read, output] in USD per MTok. */
const TIER_PRICES = {
  haiku: [1, 1.25, 2, 0.1, 5],
  sonnet: [2, 2.5, 4, 0.2, 10],
  opus: [4, 5, 8, 0.2, 20],
  fable: [10, 12.5, 20, 0.25, 50],
};

/** Older versions the account may still serve inside a tier, which cost more than the 5.5s. */
const MODEL_PRICES = [
  [/claude-opus-(?:4|5(?![-.]?5))/, [5, 6.25, 10, 0.5, 25]],
  [/claude-sonnet-4/, [3, 3.75, 6, 0.3, 15]],
];

export function pricesFor(model, tier) {
  for (const [re, prices] of MODEL_PRICES) if (re.test(model ?? "")) return prices;
  return TIER_PRICES[tier] ?? null;
}

/**
 * Dollar cost of one response's usage. `cacheWrite1h` is the part of the cache writes billed at
 * the 1-hour rate; the rest of `cacheWrite` is the 5-minute rate.
 */
export function costOf(usage, prices) {
  if (!prices) return 0;
  const [input, write5m, write1h, read, output] = prices;
  const w1h = Math.min(usage.cacheWrite1h ?? 0, usage.cacheWrite ?? 0);
  const w5m = (usage.cacheWrite ?? 0) - w1h;
  return (
    ((usage.input ?? 0) * input +
      w5m * write5m +
      w1h * write1h +
      (usage.cacheRead ?? 0) * read +
      (usage.output ?? 0) * output) /
    1e6
  );
}
