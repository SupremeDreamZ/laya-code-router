import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDaemonProxy } from "../src/attach.mjs";
import { freePort } from "./helpers.mjs";

// `laya-claude` used to start a private proxy nobody else could see, so the app showed nothing
// from real sessions (measured: 0 events after two real turns). It now joins the daemon's proxy
// when one is running, and quietly falls back to its own when not. These tests use a fake control
// socket that speaks the daemon's wire format, so the rules are pinned without a real daemon.
const homeWith = (run) => {
  const home = mkdtempSync(join(tmpdir(), "laya-attach-"));
  if (run) writeFileSync(join(home, "run.json"), JSON.stringify(run));
  return home;
};

function fakeDaemon({ claude = { running: true, port: 4321 }, onAction, silent = false, garbage = false } = {}) {
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
        seen.push(msg);
        if (silent) return;
        if (garbage) return s.write("not json\n");
        if (msg.action === "snapshot") s.write(JSON.stringify({ id: msg.id, result: { engines: { claude } } }) + "\n");
        else if (msg.action === "engine.start") {
          onAction?.(msg);
          s.write(JSON.stringify({ id: msg.id, result: { running: true, port: 5555 } }) + "\n");
        } else s.write(JSON.stringify({ id: msg.id, error: "unknown" }) + "\n");
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, seen, close: () => server.close() })),
  );
}

test("a running daemon with a live proxy: join it", async (t) => {
  const d = await fakeDaemon();
  t.after(() => d.close());
  const home = homeWith({ port: d.port, token: "tok", pid: process.pid });
  assert.deepEqual(await findDaemonProxy({ home }), { port: 4321, attached: true });
});

test("a running daemon whose proxy is stopped: ask it to start one, then join", async (t) => {
  const d = await fakeDaemon({ claude: { running: false, port: 0 } });
  t.after(() => d.close());
  const home = homeWith({ port: d.port, token: "tok", pid: process.pid });
  const got = await findDaemonProxy({ home });
  assert.deepEqual(got, { port: 5555, attached: true });
  const start = d.seen.find((m) => m.action === "engine.start");
  assert.equal(start.token, "tok", "the start request carries the daemon's own token");
  assert.equal(start.arg.engine, "claude");
});

test("the token is never sent for a read-only look", async (t) => {
  const d = await fakeDaemon();
  t.after(() => d.close());
  await findDaemonProxy({ home: homeWith({ port: d.port, token: "tok", pid: process.pid }) });
  assert.equal(d.seen.find((m) => m.action === "snapshot").token, undefined);
});

test("no run file: nothing to join", async () => {
  assert.equal(await findDaemonProxy({ home: homeWith(null) }), null);
});

test("a run file left behind by a daemon that is gone: nothing to join", async () => {
  const home = homeWith({ port: 1, token: "t", pid: 2 ** 22 + 12345 });
  assert.equal(await findDaemonProxy({ home }), null);
});

test("a live pid but nobody listening on the port: nothing to join", async () => {
  const port = await freePort();
  assert.equal(await findDaemonProxy({ home: homeWith({ port, token: "t", pid: process.pid }) }), null);
});

test("a daemon that accepts the connection and never answers does not hold the launcher up", async (t) => {
  const d = await fakeDaemon({ silent: true });
  t.after(() => d.close());
  const started = Date.now();
  const got = await findDaemonProxy({ home: homeWith({ port: d.port, token: "t", pid: process.pid }), timeoutMs: 300 });
  assert.equal(got, null);
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started}ms`);
});

test("something that is not Laya on that port is not joined", async (t) => {
  const d = await fakeDaemon({ garbage: true });
  t.after(() => d.close());
  assert.equal(await findDaemonProxy({ home: homeWith({ port: d.port, token: "t", pid: process.pid }), timeoutMs: 500 }), null);
});

test("a proxy port outside the valid range is refused", async (t) => {
  const d = await fakeDaemon({ claude: { running: true, port: 99999 } });
  t.after(() => d.close());
  assert.equal(await findDaemonProxy({ home: homeWith({ port: d.port, token: "t", pid: process.pid }) }), null);
});

test("LAYA_NO_DAEMON=1 opts out entirely", async (t) => {
  const d = await fakeDaemon();
  t.after(() => d.close());
  const home = homeWith({ port: d.port, token: "t", pid: process.pid });
  assert.equal(await findDaemonProxy({ home, env: { LAYA_NO_DAEMON: "1" } }), null);
  assert.equal(d.seen.length, 0, "it did not even look");
});

// The earlier stale-file test used a port nobody listens on, so it passed for the wrong reason:
// remove the pid check and it still returned null. This is the case that matters. A run file
// outlives its daemon, the port gets reused, and something live answers there. A dead pid means
// the file is about a daemon that is gone, so nothing on that port is ours to join or to start.
test("a stale run file is not trusted even when something live now answers on its port", async (t) => {
  const d = await fakeDaemon();
  t.after(() => d.close());
  const home = homeWith({ port: d.port, token: "tok", pid: 2 ** 22 + 12345 });
  assert.equal(await findDaemonProxy({ home }), null);
  assert.equal(d.seen.length, 0, "it must not even connect, let alone send a token");
});
