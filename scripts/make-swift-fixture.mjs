#!/usr/bin/env node
// Produce a REAL snapshot for the Swift tests: the actual daemon, the actual proxy, a stand-in for
// Anthropic that answers with the plan's real header shapes. Nothing in the output is typed by
// hand, so the Swift decoder is tested against what the daemon really sends, and a field rename
// in the daemon breaks a Swift test instead of silently blanking the panel.
//
//   node scripts/make-swift-fixture.mjs apps/LayaBar/Tests/LayaBarTests/Fixtures
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "apps/LayaBar/Tests/LayaBarTests/Fixtures");
const REPO = resolve(new URL("..", import.meta.url).pathname);
mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// One window: 5-hour resets in 3h (so it is 2h old), weekly in 4 days.
const now = Date.now();
const R5 = Math.floor(now / 1000) + 3 * 3600;
const R7 = Math.floor(now / 1000) + 4 * 86400;
let util5 = 0.6;
const upstream = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    if (/^\/v1\/models/.test(req.url)) return res.writeHead(200, { "content-type": "application/json" }).end('{"data":[]}');
    res.writeHead(200, {
      "content-type": "application/json",
      "anthropic-ratelimit-unified-5h-utilization": String(util5),
      "anthropic-ratelimit-unified-5h-reset": String(R5),
      "anthropic-ratelimit-unified-5h-status": "allowed",
      "anthropic-ratelimit-unified-7d-utilization": "0.12",
      "anthropic-ratelimit-unified-7d-reset": String(R7),
      "anthropic-ratelimit-unified-7d-status": "allowed",
      "anthropic-ratelimit-unified-7d_oi-utilization": "0.03",
      "anthropic-ratelimit-unified-7d_oi-reset": String(R7),
      "anthropic-ratelimit-unified-7d_oi-status": "allowed",
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
      "anthropic-ratelimit-unified-overage-status": "rejected",
      "anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
    });
    res.end(JSON.stringify({ type: "message", model: "claude-sonnet-5-5", content: [], usage: { input_tokens: 5, output_tokens: 5 } }));
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));

const probe = net.createServer();
await new Promise((r) => probe.listen(0, "127.0.0.1", r));
const control = probe.address().port;
await new Promise((r) => probe.close(r));

const home = mkdtempSync(join(tmpdir(), "laya-fixture-"));
const layaHome = join(home, ".laya-router");
// The sign-in state comes from a stand-in `claude`, never this machine's own: a fixture that
// recorded whoever happened to build it would differ per person and could carry their account.
const claudeState = join(home, "claude-state");
writeFileSync(claudeState, "signed-in");
const daemon = spawn(process.execPath, [join(REPO, "src/daemon.mjs")], {
  env: {
    PATH: process.env.PATH, HOME: home, LAYA_HOME: layaHome, LAYA_TOKEN: "fixture-token", LAYA_CONTROL_PORT: String(control),
    LAYA_CLAUDE_PROXY_PORT: "0", LAYA_CLAUDE_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`, LAYA_PYTHON: "/usr/bin/false",
    LAYA_CLAUDE_BIN: join(REPO, "test/fixtures/fake-claude"), FAKE_CLAUDE_STATE: claudeState, LAYA_ACCOUNT_TICK_MS: "100",
  },
  stdio: "ignore",
});
const call = (action, arg, token = "fixture-token") =>
  new Promise((resolveCall, reject) => {
    const s = net.createConnection({ host: "127.0.0.1", port: control }, () =>
      s.write(JSON.stringify({ id: 1, action, token, ...(arg !== undefined ? { arg } : {}) }) + "\n"));
    let buf = "";
    s.on("data", (c) => { buf += c; if (buf.includes("\n")) { s.end(); resolveCall(JSON.parse(buf.split("\n")[0])); } });
    s.on("error", reject);
    setTimeout(() => reject(new Error("timeout " + action)), 8000);
  });

let proxyPort = 0;
for (let i = 0; i < 120 && !proxyPort; i++) {
  try { proxyPort = (await call("snapshot")).result.engines.claude.port; } catch { /* starting */ }
  if (!proxyPort) await wait(150);
}
if (!proxyPort) throw new Error("daemon never started its proxy");
for (let i = 0; i < 100; i++) {
  if ((await call("snapshot")).result.account?.state === "signed-in") break;
  await wait(100);
}
const ask = async () => { await (await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }) })).text(); await wait(120); };

// a routed turn with usage, so the events feed and spend ledger are populated
await call("event", { kind: "routed", tier: "sonnet", model: "claude-sonnet-5-5", effort: "medium", reason: "laya", prompt: "Add pagination to the users list", ms: 42, confidence: 0.61, usage: { input: 40, cacheWrite: 2000, cacheRead: 30000, output: 300 }, session: "s1" });
util5 = 0.78; await ask();          // crosses 75%
util5 = 0.93; await ask();          // crosses 90%
await call("alerts.test");
const full = await call("snapshot");
const pub = await call("snapshot", undefined, "wrong-token");
if (!full.result?.limits?.windows?.["5h"]) throw new Error("fixture has no limits: " + JSON.stringify(full).slice(0, 200));
if (!(full.result.alerts?.length >= 3)) throw new Error("fixture has too few alerts");
if (full.result.account?.state !== "signed-in") throw new Error("fixture has no account: " + JSON.stringify(full.result.account));
if (/someone@|org-0000|Invented Studio/.test(JSON.stringify(full.result))) throw new Error("fixture carries personal-looking account fields");

// the wire is one JSON object per line, so the fixtures are exactly what the app receives
writeFileSync(join(OUT, "snapshot-full.json"), JSON.stringify(full.result, null, 2));
writeFileSync(join(OUT, "snapshot-public.json"), JSON.stringify(pub.result, null, 2));

// what a daemon from before alerts existed would send: the same snapshot without the new keys
const old = structuredClone(full.result);
delete old.limits; delete old.alerts; delete old.laya; delete old.account;
delete old.prefs.alerts; delete old.prefs.showUsageInMenuBar;
writeFileSync(join(OUT, "snapshot-legacy.json"), JSON.stringify(old, null, 2));

daemon.kill("SIGKILL");
upstream.close();
console.log(JSON.stringify({ wrote: ["snapshot-full.json", "snapshot-public.json", "snapshot-legacy.json"], alerts: full.result.alerts.map((a) => `${a.kind}:${a.threshold ?? "-"}`), windows: Object.keys(full.result.limits.windows) }));
process.exit(0);
