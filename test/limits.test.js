// The guardrails. These are the rules that decide how much one person can
// spend, so they are worth pinning down precisely.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LIMITS, LimitError, ConcurrencyGate, RateLimiter, SpendWindow, tokenEquivalents, short, truncate, describeLimits,
} from "../server/limits.js";

test("every limit has a positive default", () => {
  for (const [name, value] of Object.entries(LIMITS)) {
    assert.equal(typeof value, "number", `${name} should be a number`);
    assert.ok(value > 0, `${name} should default to something above zero`);
  }
});

test("describeLimits names the one that costs money", () => {
  const text = describeLimits().join("\n");
  // The ceiling on sandboxes used to be the one standing between a loop and
  // a bill. This app boots none, so what is left that spends its money is
  // inference on its own key - and a limit nobody can see at boot is a limit
  // nobody remembers exists.
  assert.doesNotMatch(text, /sandboxes/);
  assert.match(text, /repos\s+\d+\/user/);
  assert.match(text, /agents\s+\d+ concurrent/);
  assert.match(text, /tokens\s+1\.5M\/hour per agent, 10M\/day in all/);
});

test("a model call's cost is one number, in input tokens, whatever kind they were", () => {
  // The ratios every current model is priced at: output five times input,
  // a cache write a quarter over, a cache read a tenth.
  assert.equal(tokenEquivalents({ input: 1000 }), 1000);
  assert.equal(tokenEquivalents({ output: 1000 }), 5000);
  assert.equal(tokenEquivalents({ cacheWrite: 1000 }), 1250);
  assert.equal(tokenEquivalents({ cacheRead: 1000 }), 100);
  // A typical cached step: most of the prompt read from the cache.
  assert.equal(tokenEquivalents({ input: 200, cacheRead: 80_000, cacheWrite: 1_500, output: 400 }), 200 + 8000 + 1875 + 2000);
  assert.equal(tokenEquivalents(), 0);
  assert.equal(short(1_500_000), "1.5M");
  assert.equal(short(10_000_000), "10M");
  assert.equal(short(250_000), "250k");
});

test("SpendWindow lets the call that crosses the line through and refuses the next", () => {
  const window = new SpendWindow(100, 60_000, "tokens per minute");
  const t0 = 1_000_000;
  window.check("a", t0);
  window.add("a", 60, t0);
  window.check("a", t0 + 1);
  window.add("a", 60, t0 + 1); // 120: over, but this call was already made
  assert.throws(() => window.check("a", t0 + 2), (err) => {
    assert.ok(err instanceof LimitError);
    assert.equal(err.status, 429);
    assert.match(err.message, /Spend limit: 100 tokens per minute\. 120 spent so far/);
    assert.match(err.message, /in 1 minute/);
    return true;
  });
  // Another key is another budget.
  window.check("b", t0 + 2);
  // The window slides: once the first entry is out, there is room again.
  window.check("a", t0 + 60_000);
  assert.equal(window.total("a", t0 + 60_000), 60);
  window.sweep(t0 + 120_002);
  assert.equal(window.total("a", t0 + 120_002), 0);
  // No limit, no accounting.
  const unlimited = new SpendWindow(0, 60_000, "nothing");
  unlimited.add("a", 1e9);
  unlimited.check("a");
});

test("ConcurrencyGate admits up to the limit and then refuses", () => {
  const gate = new ConcurrencyGate(2, "turns");
  const first = gate.enter("ada@example.com");
  const second = gate.enter("ada@example.com");

  assert.throws(() => gate.enter("ada@example.com"), LimitError);

  // A different person is not affected by someone else's usage.
  const other = gate.enter("grace@example.com");

  first();
  gate.enter("ada@example.com")(); // a slot came free
  second();
  other();
});

test("releasing twice does not free a slot that was never taken", () => {
  const gate = new ConcurrencyGate(1, "turns");
  const release = gate.enter("ada@example.com");
  release();
  release(); // the abort handler and the finally block both fire
  gate.enter("ada@example.com"); // still only one slot
  assert.throws(() => gate.enter("ada@example.com"), LimitError);
});

test("a gate with no limit lets everything through", () => {
  const gate = new ConcurrencyGate(0, "turns");
  for (let i = 0; i < 50; i++) gate.enter("ada@example.com");
});

test("RateLimiter counts within the window and forgets outside it", () => {
  const limiter = new RateLimiter(3, 60_000, "turns");
  const start = 1_000_000;

  limiter.check("ada", start);
  limiter.check("ada", start + 1);
  limiter.check("ada", start + 2);
  assert.throws(() => limiter.check("ada", start + 3), LimitError);

  // Someone else has their own budget.
  limiter.check("grace", start + 3);

  // Past the window, the earlier hits no longer count.
  limiter.check("ada", start + 60_001);
});

test("RateLimiter says how long to wait", () => {
  const limiter = new RateLimiter(1, 3_600_000, "turns");
  limiter.check("ada", 0);
  assert.throws(
    () => limiter.check("ada", 1_000),
    (err) => err instanceof LimitError && /minute/.test(err.message),
  );
});

test("RateLimiter.sweep drops keys that have gone quiet", () => {
  const limiter = new RateLimiter(5, 1_000, "turns");
  limiter.check("ada", 0);
  assert.equal(limiter.hits.size, 1);
  limiter.sweep(5_000);
  assert.equal(limiter.hits.size, 0);
});

test("truncate keeps short output and marks long output", () => {
  assert.equal(truncate("hello", 100), "hello");
  const long = truncate("x".repeat(500), 100);
  assert.equal(long.length < 200, true);
  assert.match(long, /truncated at 100 bytes of 500/);
});

test("truncate copes with the shapes a failed command returns", () => {
  assert.equal(truncate(undefined), "");
  assert.equal(truncate(null), "");
  assert.equal(truncate(Buffer.from("hi")), "hi");
});
