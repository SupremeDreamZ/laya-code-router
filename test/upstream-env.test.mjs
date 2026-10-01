import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
// Imported FIRST on purpose. bin/laya-claude.mjs imports proxy.mjs statically and only then
// calls process.loadEnvFile(~/.laya-router.env), so anything proxy.mjs reads from the
// environment at import time never sees a value that lives in an env file.
import { startProxy } from "../src/proxy.mjs";

test("LAYA_CLAUDE_UPSTREAM set after import (the env-file path) still selects the upstream", async () => {
  const seen = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"id":"msg_1","type":"message","model":"claude-sonnet-4-6"}');
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));

  const previous = process.env.LAYA_CLAUDE_UPSTREAM;
  process.env.LAYA_CLAUDE_UPSTREAM = `http://127.0.0.1:${stub.address().port}`;
  const { port, close } = await startProxy(); // no explicit upstreamURL: the default must honour the env
  try {
    // A concrete (non-sentinel) model passes straight through, so this needs no sidecar.
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-test" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
    });
    await res.text();
    assert.equal(seen.length, 1, "the stub configured through LAYA_CLAUDE_UPSTREAM should have received the request");
    assert.equal(seen[0].url, "/v1/messages");
  } finally {
    close();
    stub.close();
    if (previous === undefined) delete process.env.LAYA_CLAUDE_UPSTREAM;
    else process.env.LAYA_CLAUDE_UPSTREAM = previous;
  }
});
