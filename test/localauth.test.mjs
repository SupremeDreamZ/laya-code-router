// The local placeholder key: only the exact placeholder is swapped for the machine's long-lived
// token; real keys and bearer tokens pass through untouched; a missing token is reported, not
// guessed.
import test from "node:test";
import assert from "node:assert/strict";
import { applyLocalAuth, localToken, resetLocalTokenCache, LOCAL_KEY, OAUTH_BETA } from "../src/localauth.mjs";

const env = {};
const read = () => "tok-123";

test("placeholder x-api-key becomes a bearer token with the oauth beta", () => {
  resetLocalTokenCache();
  const h = { "x-api-key": LOCAL_KEY, "anthropic-beta": "foo" };
  assert.equal(applyLocalAuth(h, { env, read }), "applied");
  assert.equal(h["x-api-key"], undefined);
  assert.equal(h.authorization, "Bearer tok-123");
  assert.equal(h["anthropic-beta"], `foo,${OAUTH_BETA}`);
});

test("placeholder bearer is also accepted, beta not duplicated", () => {
  resetLocalTokenCache();
  const h = { authorization: `Bearer ${LOCAL_KEY}`, "anthropic-beta": OAUTH_BETA };
  assert.equal(applyLocalAuth(h, { env, read }), "applied");
  assert.equal(h.authorization, "Bearer tok-123");
  assert.equal(h["anthropic-beta"], OAUTH_BETA);
});

test("a real key or a real bearer token is left exactly as sent", () => {
  resetLocalTokenCache();
  const a = { "x-api-key": "sk-ant-real" };
  assert.equal(applyLocalAuth(a, { env, read }), "none");
  assert.deepEqual(a, { "x-api-key": "sk-ant-real" });
  const b = { authorization: "Bearer claude-code-token" };
  assert.equal(applyLocalAuth(b, { env, read }), "none");
  assert.deepEqual(b, { authorization: "Bearer claude-code-token" });
});

test("no token set up reports missing and leaves headers alone", () => {
  resetLocalTokenCache();
  const h = { "x-api-key": LOCAL_KEY };
  assert.equal(applyLocalAuth(h, { env, read: () => null }), "missing");
  assert.equal(h["x-api-key"], LOCAL_KEY);
  assert.equal(h.authorization, undefined);
});

test("LAYA_OAUTH_TOKEN wins over the Keychain, and the Keychain read is cached", () => {
  resetLocalTokenCache();
  assert.equal(localToken({ env: { LAYA_OAUTH_TOKEN: "from-env" }, read: () => "kc" }), "from-env");
  let reads = 0;
  const counting = () => { reads++; return "kc"; };
  assert.equal(localToken({ env: {}, read: counting, now: 1000 }), "kc");
  assert.equal(localToken({ env: {}, read: counting, now: 2000 }), "kc");
  assert.equal(reads, 1);
});
