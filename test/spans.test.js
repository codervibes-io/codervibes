// Where the spans go once they have ended.
//
// A page asking "what did this agent just do" reads memory; a page asking
// "what happened in that session yesterday" reads the store; and both
// questions get one answer, merged, without duplicates. The store is written
// in batches because a busy hour is thousands of spans and one write each is
// how a store bill happens.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codervibes-spans-"));
process.env.CODERVIBES_DATA_DIR = dataDir;
process.env.CODERVIBES_STORE = "json";

const { withSpan, retroSpan } = await import("../server/telemetry.js");
const spans = await import("../server/spans.js");
const { store } = await import("../server/store/index.js");
const { RING_SIZE, BATCH_SIZE, KEEP_MS, spanInternals } = spans;

test.beforeEach(async () => {
  spanInternals.reset();
  await fs.rm(path.join(dataDir, ".codervibes-spans.json"), { force: true });
});
test.after(() => fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

/** One finished span, with the ids a page reads by. */
const emit = (attrs = {}, { at = Date.now(), ms = 10 } = {}) =>
  retroSpan({ name: "tool.call", startTime: at, endTime: at + ms, attrs: { "cv.tool.name": "read_file", ...attrs } });

test("a finished span is in memory at once, and in the store a moment later", async () => {
  emit({ "cv.session.id": "ses_1", "cv.agent.id": "a1" });
  assert.equal(spanInternals.ring.length, 1);
  assert.equal(spanInternals.pending().length, 1, "waiting for the batch, not written yet");
  assert.equal(spanInternals.ring[0].expires, Math.floor((spanInternals.ring[0].at + KEEP_MS) / 1000), "the store's TTL is stamped here");

  await spans.flush();
  assert.equal(spanInternals.pending().length, 0);
  const stored = await store.loadSpans({ session: "ses_1" });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].attrs["cv.agent.id"], "a1");
});

test("a batch is written when it fills, without waiting for the timer", async () => {
  const now = Date.now();
  for (let i = 0; i < BATCH_SIZE; i += 1) emit({ "cv.session.id": "ses_full" }, { at: now + i });
  // The write is in flight, not waited for; give it a tick.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(spanInternals.pending().length, 0, "the full batch went out on its own");
  assert.equal((await store.loadSpans({ session: "ses_full", limit: 1000 })).length, BATCH_SIZE);
});

test("memory holds the last few thousand and no more", () => {
  for (let i = 0; i < RING_SIZE + 10; i += 1) spans.record({ id: `${i}-x`, at: i, ms: 0, attrs: {} });
  assert.equal(spanInternals.ring.length, RING_SIZE);
  assert.equal(spanInternals.ring[0].id, "10-x", "the oldest went first");
});

test("a read merges memory and the store, once each, oldest first", async () => {
  emit({ "cv.session.id": "ses_m" }, { at: 3000 });
  await spans.flush();
  // Still in memory *and* now in the store; and one more that is memory only.
  emit({ "cv.session.id": "ses_m" }, { at: 1000 });
  const timeline = await spans.forSession("ses_m");
  assert.deepEqual(timeline.map((span) => span.at), [1000, 3000]);
  assert.equal(new Set(timeline.map((span) => span.id)).size, 2, "the span in both places is listed once");
});

test("a read that outgrows the limit keeps the most recent", async () => {
  const now = Date.now();
  for (let i = 0; i < 6; i += 1) emit({ "cv.task.id": "t_lim" }, { at: now + 100 * (i + 1) });
  await spans.flush();
  const some = await spans.forTask("t_lim", { limit: 4 });
  assert.deepEqual(some.map((span) => span.at - now), [300, 400, 500, 600]);
});

test("a span past its keep-by is not written, and not read back", async () => {
  emit({ "cv.session.id": "ses_old" }, { at: Date.now() - KEEP_MS - 60_000 });
  emit({ "cv.session.id": "ses_old" }, { at: Date.now() });
  await spans.flush();
  assert.equal((await store.loadSpans({ session: "ses_old" })).length, 1, "the store keeps thirty days");
  assert.equal((await spans.forSession("ses_old")).length, 2, "memory is memory; it holds what it heard");
});

test("a trace is one call and everything under it", async () => {
  let ids = null;
  await withSpan("tool.call", { "cv.tool.name": "github_open_pull", "cv.session.id": "ses_t" }, async () => {
    await withSpan("connector.call", { "cv.connector.id": "github" }, async () => {});
  });
  ids = spanInternals.ring.map((span) => span.trace);
  assert.equal(new Set(ids).size, 1);
  const found = await spans.forTrace(ids[0]);
  // Both started in the same millisecond, so the order between them is not
  // a promise; that the child names the parent is.
  assert.deepEqual(found.map((span) => span.name).sort(), ["connector.call", "tool.call"]);
  const parent = found.find((span) => span.name === "tool.call");
  assert.equal(found.find((span) => span.name === "connector.call").parent, parent.span);
});

test("what one agent did recently is answered from memory alone", () => {
  emit({ "cv.agent.id": "a_recent" }, { at: 10 });
  emit({ "cv.agent.id": "a_other" }, { at: 20 });
  emit({ "cv.agent.id": "a_recent" }, { at: 30 });
  const mine = spans.forAgent("a_recent");
  assert.deepEqual(mine.map((span) => span.at), [10, 30]);
  assert.deepEqual(spans.forAgent("a_recent", { limit: 1 }).map((span) => span.at), [30]);
});

test("a store that cannot be written loses nothing in memory and does not throw", async () => {
  const original = store.appendSpans;
  const warned = [];
  const warn = console.warn;
  console.warn = (line) => warned.push(line);
  store.appendSpans = async () => { throw new Error("disk full"); };
  try {
    emit({ "cv.session.id": "ses_bad" });
    await spans.flush();
  } finally {
    store.appendSpans = original;
    console.warn = warn;
  }
  assert.equal(spanInternals.ring.length, 1);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /could not store 1 spans: disk full/);
});

test("a store that cannot be read still answers from memory", async () => {
  const original = store.loadSpans;
  const warn = console.warn;
  console.warn = () => {};
  store.loadSpans = async () => { throw new Error("unreachable"); };
  try {
    emit({ "cv.session.id": "ses_ro" });
    const found = await spans.forSession("ses_ro");
    assert.equal(found.length, 1);
  } finally {
    store.loadSpans = original;
    console.warn = warn;
  }
});

test("a span shown to somebody who does not own it keeps its counts and loses everything else", () => {
  const span = {
    id: "1-abc", session: "ses_x", name: "tool.call", at: 1, ms: 2, ok: false,
    attrs: { "cv.tool.name": "read_file", "cv.tool.ok": false, "cv.sandbox.ms": 40, "cv.agent.name": "Nomad", "cv.file.path": "/etc/passwd", "cv.error": "no such file" },
  };
  const shown = spans.countsOnly(span);
  assert.deepEqual(shown.attrs, { "cv.tool.name": "read_file", "cv.tool.ok": false, "cv.sandbox.ms": 40, "cv.agent.name": "Nomad" });
  assert.equal(shown.ok, false, "the outcome is a count");
  assert.deepEqual(span.attrs["cv.file.path"], "/etc/passwd", "the span itself is untouched");
  // The list is what may be shown: an attribute nobody has vetted is private.
  assert.ok(!spans.COUNTABLE_ATTRS.has("cv.file.path"));
});

test("a span put back from the store is in memory once, and never written again", async () => {
  spanInternals.reset();
  const span = { id: "2-def", session: "ses_back", name: "tool.call", at: 2, ms: 1, ok: true, attrs: {} };
  assert.equal(spans.remember(span), true);
  assert.equal(spans.remember(span), false, "already here");
  assert.equal(spanInternals.ring.length, 1);
  assert.equal(spanInternals.pending().length, 0, "nothing waiting for the store");
});
