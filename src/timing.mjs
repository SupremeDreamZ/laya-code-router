// The waits a person with a slower machine may need to change, read in one place.
//
// Each has a default in `THRESHOLDS`. The environment variable replaces it. A value is read only if
// it is plain digits (or a whole number) inside a sane range. `Number()` alone would also take "1e3",
// "0x10" and "+5", and turn an array or an object into a number, and a value Node cannot hold as a
// timer becomes a 1 ms timer, which would fail every decision at once.
import { THRESHOLDS } from "./config.mjs";

function read(raw, fallback, min, max) {
  let ms;
  if (typeof raw === "number") ms = raw;
  else if (typeof raw === "string" && /^\d+$/.test(raw.trim())) ms = Number(raw.trim());
  else return fallback;
  return Number.isSafeInteger(ms) && ms >= min && ms <= max ? ms : fallback;
}

/** The longest a prompt waits for a routing decision. LAYA_DEADLINE_MS, 1 s to 10 min. */
export function deadlineMs(raw = process.env.LAYA_DEADLINE_MS) {
  return read(raw, THRESHOLDS.layaDeadlineMs, 1000, 10 * 60_000);
}

/** The longest a prompt waits while the model is still loading. LAYA_LOAD_DEADLINE_MS, 1 s to 10 min. */
export function loadDeadlineMs(raw = process.env.LAYA_LOAD_DEADLINE_MS) {
  return read(raw, THRESHOLDS.loadDeadlineMs, 1000, 10 * 60_000);
}

/** How long a model may take to load before a missed deadline replaces it. LAYA_LOAD_GIVE_UP_MS, 1 s to 1 h. */
export function loadGiveUpMs(raw = process.env.LAYA_LOAD_GIVE_UP_MS) {
  return read(raw, THRESHOLDS.loadGiveUpMs, 1000, 60 * 60_000);
}
