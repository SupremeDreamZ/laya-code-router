import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `laya-claude` should join the background app's proxy. Run for real, against a stand-in for
// Claude Code that reports what it was launched with, and a fake daemon speaking the wire format.
const REPO = new URL("..", import.meta.url).pathname;
const LAUNCHER = join(REPO, "bin", "laya-claude.mjs");

function fakeDaemon(proxyPort) {
  const seen = [];
  const server = net.createServer((s) => {
    let buf = "";
    s.on("error", () => {});
    s.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        seen.push(msg.action);
        s.write(JSON.stringify({ id: msg.id, result: { engines: { claude: { running: true, port: proxyPort } } } }) + "\n");
      }
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ port: server.address().port, seen, close: () => server.close() })));
}

/** A home directory, a stand-in `claude`, and a way to run the launcher against them. */
function world({ daemon } = {}) {
  const home = mkdtempSync(join(tmpdir(), "laya-launch-"));
  const layaHome = join(home, ".laya-router");
  mkdirSync(layaHome, { recursive: true });
  const bin = join(home, "bin");
  mkdirSync(bin);
  const claude = join(bin, "claude");
  writeFileSync(claude, '#!/bin/sh\necho "BASE=$ANTHROPIC_BASE_URL"\necho "ARGS=$*"\n');
  chmodSync(claude, 0o755);
  if (daemon) writeFileSync(join(layaHome, "run.json"), JSON.stringify({ port: daemon.port, token: "tok", pid: process.pid, startedAt: Date.now(), root: REPO }));
  const launch = (extraEnv = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [LAUNCHER], {
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: home,
          LAYA_HOME: layaHome,
          LAYA_PYTHON: "/usr/bin/false",
          LAYA_NO_STATUSLINE: "1",
          ...extraEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`launcher hung. stdout:\n${out}\nstderr:\n${err}`));
      }, 20000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        const base = /^BASE=(.*)$/m.exec(out)?.[1];
        const args = /^ARGS=(.*)$/m.exec(out)?.[1] ?? "";
        resolve({ code, base, args, out, err });
      });
    });
  return { home, launch };
}

const sessionSettings = (args) => {
  const file = /--settings (\S+)/.exec(args)?.[1];
  return file ? JSON.parse(readFileSync(file, "utf8")) : null;
};

test("with the app running, a session joins its proxy and starts none of its own", async (t) => {
  const d = await fakeDaemon(4321);
  t.after(() => d.close());
  const w = world({ daemon: d });
  const r = await w.launch();
  assert.equal(r.code, 0, r.err);
  assert.equal(r.base, "http://127.0.0.1:4321");
  assert.equal(sessionSettings(r.args)?.env?.ANTHROPIC_BASE_URL, "http://127.0.0.1:4321", "the pinned session settings agree");
});

test("with no app running, the launcher behaves as it always did: a private proxy", async () => {
  const r = await world().launch();
  assert.equal(r.code, 0, r.err);
  assert.match(r.base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(r.base, "http://127.0.0.1:4321");
});

test("LAYA_NO_DAEMON=1 keeps a session private even while the app is running", async (t) => {
  const d = await fakeDaemon(4321);
  t.after(() => d.close());
  const r = await world({ daemon: d }).launch({ LAYA_NO_DAEMON: "1" });
  assert.equal(r.code, 0, r.err);
  assert.notEqual(r.base, "http://127.0.0.1:4321");
  assert.deepEqual(d.seen, [], "the app was not even asked");
});

test("a run file left by an app that has gone does not strand the session", async () => {
  const w = world();
  writeFileSync(join(w.home, ".laya-router", "run.json"), JSON.stringify({ port: 9, token: "t", pid: 2 ** 22 + 99, startedAt: 1, root: "/" }));
  const r = await w.launch();
  assert.equal(r.code, 0, r.err);
  assert.match(r.base, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test("routing switched off means no proxy at all, exactly as before", async (t) => {
  const d = await fakeDaemon(4321);
  t.after(() => d.close());
  const r = await world({ daemon: d }).launch({ LAYA_DISABLE_ROUTING: "1" });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.base, "", "no base URL is set when routing is off");
  assert.deepEqual(d.seen, []);
});
