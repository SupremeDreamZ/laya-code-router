// A running total of what routed turns cost against what the same tokens would have cost on the
// baseline model, read from the usage the API itself reports on each response. Nothing here is
// guessed: a turn whose usage could not be read is counted as a request with no cost.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import zlib from "node:zlib";
import { dirname, join } from "node:path";
import { costOf, pricesFor } from "./pricing.mjs";
import { HOME_DIR } from "./prefs.mjs";

export const USAGE_FILE = () => join(HOME_DIR(), "usage.json");
const KEEP_DAYS = 120;
const BLANK_TIER = () => ({ n: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0 });

// Every model the "savings are measured against" setting can name. Each turn's baseline is kept
// under all of them, so changing the setting re-prices history instead of only future turns.
const BASELINES = ["sonnet", "opus", "fable"];
const DEFAULT_BASELINE = "opus";
const BLANK_BASE = () => Object.fromEntries(BASELINES.map((b) => [b, 0]));
const BLANK_DAY = () => ({ n: 0, cost: 0, byTier: {}, base: BLANK_BASE(), legacy: 0 });

const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * The compressions this process can read back, in the order a client may offer them. zstd is left
 * out on purpose: Node 20 (still supported here) has no zstd decoder, and a response the tap
 * cannot read is a turn with no cost.
 */
const READABLE = ["gzip", "deflate", "br"];

/**
 * What to tell the API it may use, given what the client offered: the client's own list cut down
 * to what can be read here. The client only ever receives an encoding it said it accepts, so this
 * is always safe for it. Undefined means "offer nothing", which is an uncompressed reply.
 */
export function readableEncodings(offer) {
  // String() is enough for a header Node hands over as an array: it joins with a comma.
  const raw = String(offer ?? "");
  const accepted = [];
  let star = false;
  for (const part of raw.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";").map((x) => x.trim());
    if (!name) continue;
    const q = params.map((p) => /^q=([\d.]+)$/.exec(p)?.[1]).find((v) => v !== undefined);
    if (q !== undefined && Number(q) === 0) continue; // "gzip;q=0" means "not acceptable"
    if (name === "*") star = true;
    else accepted.push(name === "x-gzip" ? "gzip" : name);
  }
  const out = star ? READABLE : READABLE.filter((e) => accepted.includes(e));
  const ordered = star ? out : accepted.filter((e, i) => READABLE.includes(e) && accepted.indexOf(e) === i);
  return ordered.length ? ordered.join(", ") : undefined;
}

/**
 * A stream that undoes a response's compression, for reading a copy of it. null: nothing to undo.
 * undefined: an encoding that cannot be read here.
 *
 * A response cut short ends in an `error` from the decoder, but only after every byte that did
 * arrive has been decoded and delivered (checked: a gzip stream missing its trailer yields all of
 * its data, then Z_BUF_ERROR). The caller settles on that error, so a turn interrupted
 * mid-answer still reports what it had used.
 */
export function decoderFor(encoding) {
  const name = String(Array.isArray(encoding) ? encoding[0] : encoding ?? "").trim().toLowerCase();
  switch (name) {
    case "":
    case "identity":
      return null;
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip();
    case "deflate":
      return zlib.createInflate();
    case "br":
      return zlib.createBrotliDecompress();
    default:
      return undefined;
  }
}

/**
 * Reads token usage out of a response. The Messages stream reports input on `message_start`
 * and the final output count on `message_delta`; a non-streaming response carries one `usage`.
 * Feed it raw chunks; it buffers partial lines and stops holding memory after `end()`.
 */
export function createUsageTap(onUsage) {
  let buf = "";
  let usage = null;
  let model = null;
  let json = "";
  let jsonMode = null;
  const take = (u) => {
    if (!u || typeof u !== "object") return;
    usage ??= { input: 0, cacheWrite: 0, cacheRead: 0, cacheWrite1h: 0, output: 0 };
    if (Number.isFinite(u.input_tokens)) usage.input = u.input_tokens;
    if (Number.isFinite(u.cache_creation_input_tokens)) usage.cacheWrite = u.cache_creation_input_tokens;
    if (Number.isFinite(u.cache_read_input_tokens)) usage.cacheRead = u.cache_read_input_tokens;
    if (Number.isFinite(u.cache_creation?.ephemeral_1h_input_tokens)) usage.cacheWrite1h = u.cache_creation.ephemeral_1h_input_tokens;
    if (Number.isFinite(u.output_tokens)) usage.output = u.output_tokens;
  };
  const line = (text) => {
    if (!text.startsWith("data:")) return;
    try {
      const evt = JSON.parse(text.slice(5));
      if (evt.type === "message_start") {
        model = evt.message?.model ?? model;
        take(evt.message?.usage);
      } else if (evt.type === "message_delta") take(evt.usage);
    } catch {
      // A partial or non-JSON data line; the next chunk completes it or it is noise.
    }
  };
  return {
    push(chunk, contentType = "") {
      if (jsonMode === null) jsonMode = /application\/json/i.test(contentType);
      const text = chunk.toString("utf8");
      if (jsonMode) {
        if (json.length < 4e6) json += text;
        return;
      }
      buf += text;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        line(buf.slice(0, i).trim());
        buf = buf.slice(i + 1);
      }
      if (buf.length > 1e6) buf = "";
    },
    end() {
      if (jsonMode) {
        try {
          const body = JSON.parse(json);
          model = body.model ?? model;
          take(body.usage);
        } catch {
          // Not a usage-bearing JSON body.
        }
      } else if (buf.trim()) line(buf.trim());
      buf = json = "";
      if (usage) onUsage({ usage, model });
    },
  };
}

export function createLedger({ file = USAGE_FILE(), now = Date.now, baselineTier = () => "opus" } = {}) {
  let data = { days: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && typeof parsed.days === "object") data = parsed;
  } catch {
    // First run, or an unreadable file: start empty rather than refuse to run.
  }
  const chosen = () => {
    const b = baselineTier();
    return BASELINES.includes(b) ? b : DEFAULT_BASELINE;
  };
  /**
   * A day's baseline under the current setting. A day recorded before per-baseline totals existed
   * has only the single figure it was priced at, which cannot be re-priced and is kept as it was;
   * turns recorded since then move with the setting.
   */
  const baselineOf = (day) => (day.base ? (day.legacy ?? 0) + (day.base[chosen()] ?? 0) : day.baseline);
  let timer = null;
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      renameSync(tmp, file);
      chmodSync(file, 0o600);
    } catch {
      // The running totals are a convenience; a full disk must not break routing.
    }
  };
  const schedule = () => {
    timer ??= setTimeout(flush, 2000);
    timer.unref?.();
  };
  const prune = () => {
    const keys = Object.keys(data.days).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete data.days[k];
  };

  return {
    /**
     * @param {{tier: string, model: string, usage: object, routed?: boolean}} entry
     * `routed` false means the router did not choose this turn (paused, or background work);
     * its baseline is its own cost, so it can never inflate the savings figure.
     */
    record({ tier, model, usage, routed = true }) {
      const at = now();
      const day = (data.days[dayKey(at)] ??= BLANK_DAY());
      if (!day.base) {
        // A day that began before per-baseline totals existed: what it holds so far stays as it
        // was recorded, and only the turns from here on are kept under every baseline.
        day.legacy = day.baseline;
        day.base = BLANK_BASE();
      }
      const cost = costOf(usage, pricesFor(model, tier));
      // A turn the router did not choose saves nothing; one that it did is measured against each
      // candidate, and never below what it actually cost (a Fable turn against Sonnet is not a
      // negative saving).
      for (const b of BASELINES) {
        const priced = routed ? costOf(usage, pricesFor(null, b)) : cost;
        day.base[b] += Math.max(priced, cost);
      }
      const t = (day.byTier[tier] ??= BLANK_TIER());
      t.n += 1;
      t.input += usage.input ?? 0;
      t.cacheWrite += usage.cacheWrite ?? 0;
      t.cacheRead += usage.cacheRead ?? 0;
      t.output += usage.output ?? 0;
      t.cost += cost;
      day.n += 1;
      day.cost += cost;
      prune();
      schedule();
    },
    /** Totals for today, the last `days` days (oldest first), and everything kept. */
    snapshot(days = 7) {
      const at = now();
      const found = data.days[dayKey(at)];
      const today = found ? { ...found, baseline: baselineOf(found) } : { n: 0, cost: 0, baseline: 0, byTier: {} };
      const series = [];
      for (let i = days - 1; i >= 0; i--) {
        const key = dayKey(at - i * 86400000);
        const d = data.days[key];
        series.push({ date: key, n: d?.n ?? 0, cost: d?.cost ?? 0, baseline: d ? baselineOf(d) : 0 });
      }
      const all = Object.values(data.days).reduce(
        (a, d) => ({ n: a.n + d.n, cost: a.cost + d.cost, baseline: a.baseline + baselineOf(d) }),
        { n: 0, cost: 0, baseline: 0 },
      );
      return { today, series, all };
    },
    reset() {
      data = { days: {} };
      flush();
    },
    flush,
  };
}
