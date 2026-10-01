// Shared by the tests that run a real daemon. Kept out of any one test file so each timing
// decision (how long to wait, what "ready" means) is made once.
import net from "node:net";

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A port the OS says is free right now. Picking one by dice can land on a real daemon (8790/8791). */
export async function freePort() {
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

/**
 * Polls until `check()` (sync or async) returns something truthy, and returns it; fails with `what`
 * after `ms`. Under load a daemon takes seconds, not milliseconds, to come up, so tests wait for the
 * thing they need rather than for a guessed interval.
 */
export async function waitFor(check, what, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await check();
      if (v) return v;
    } catch {
      // not yet
    }
    await wait(100);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
}

/** One request to a running daemon's control socket. Resolves with the parsed reply line. */
export function callDaemon(port, action, { arg, token = "t", ms = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host: "127.0.0.1", port }, () =>
      s.write(JSON.stringify({ id: 1, action, ...(token ? { token } : {}), ...(arg !== undefined ? { arg } : {}) }) + "\n"));
    let buf = "";
    const timer = setTimeout(() => { s.destroy(); reject(new Error(`timeout ${action}`)); }, ms);
    s.on("data", (c) => {
      buf += c;
      if (buf.includes("\n")) {
        clearTimeout(timer);
        s.end();
        resolve(JSON.parse(buf.split("\n")[0]));
      }
    });
    s.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * Subscribes the way the menu-bar app does and collects what the daemon pushes, each snapshot
 * passed through `pick`. The app never polls: anything that changes but is not pushed reaches it
 * late or never, which a test that asks for a fresh snapshot cannot see.
 */
export function subscribe(t, port, pick = (snapshot) => snapshot, token = "t") {
  const pushed = [];
  const sock = net.createConnection({ host: "127.0.0.1", port }, () =>
    sock.write(JSON.stringify({ id: 1, action: "subscribe", token }) + "\n"));
  sock.on("error", () => {});
  t.after(() => sock.destroy());
  let buf = "";
  sock.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const m = JSON.parse(line);
        if (m.event) pushed.push(pick(m.event));
      } catch {
        // not a snapshot
      }
    }
  });
  return pushed;
}
