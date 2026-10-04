// Local sign-in for clients other than Claude Code (for example the Hermes desktop app).
//
// Claude Code sends its own authorization and the proxy forwards it untouched. Other local apps
// either hold their own copy of the Claude login, which rotates its refresh token and logs the
// other copy out, or have no Claude login at all. Instead, such an app sends the placeholder key
// `laya-local`, and the proxy swaps it for one long-lived token that only this machine holds:
// the token `claude setup-token` issues (about a year, never refreshed, so nothing gets rotated
// out from under anyone). The token lives in the macOS Keychain item `laya-router-token`, or in
// LAYA_OAUTH_TOKEN for a launcher that sets it. It is read when needed, cached briefly, and never
// written to a log or an event.
//
// Only the exact placeholder triggers the swap. Any real key or bearer token a client sends is
// forwarded exactly as before, and the proxy only listens on loopback.
import { execFileSync } from "node:child_process";

export const LOCAL_KEY = "laya-local";
export const KEYCHAIN_SERVICE = "laya-router-token";
export const OAUTH_BETA = "oauth-2025-04-20";
const CACHE_MS = 5 * 60 * 1000;

let cached = { token: null, at: 0 };

function fromKeychain() {
  try {
    const out = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** The local token, or null when none is set up. `read` is injectable for tests. */
export function localToken({ env = process.env, read = fromKeychain, now = Date.now() } = {}) {
  if (env.LAYA_OAUTH_TOKEN) return env.LAYA_OAUTH_TOKEN.trim() || null;
  if (cached.token && now - cached.at < CACHE_MS) return cached.token;
  const token = read();
  cached = { token, at: now };
  return token;
}

export function resetLocalTokenCache() {
  cached = { token: null, at: 0 };
}

function mergeBeta(existing, add) {
  const list = String(existing ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!list.includes(add)) list.push(add);
  return list.join(",");
}

/**
 * Rewrite `headers` in place when the client sent the local placeholder.
 * Returns "none" (not a local request), "applied", or "missing" (placeholder sent, no token set up).
 */
export function applyLocalAuth(headers, opts = {}) {
  const key = headers["x-api-key"];
  const bearer = String(headers["authorization"] ?? "");
  const isLocal = key === LOCAL_KEY || bearer === `Bearer ${LOCAL_KEY}`;
  if (!isLocal) return "none";
  const token = localToken(opts);
  if (!token) return "missing";
  delete headers["x-api-key"];
  headers["authorization"] = `Bearer ${token}`;
  headers["anthropic-beta"] = mergeBeta(headers["anthropic-beta"], OAUTH_BETA);
  return "applied";
}

export const MISSING_MESSAGE =
  "LAYA has no local sign-in yet. Run `laya-auth-setup` once in a terminal (it runs `claude setup-token` and saves the token to the Keychain), then try again.";
