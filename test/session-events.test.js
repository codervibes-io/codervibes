// The per-session log: what a session said and did, in order, readable
// from where the reader left off.
//
// A page draws a transcript from it, so the test cares about three things
// the transcript needs: the order is total and never goes backwards, an
// entry holds only what its kind declares (a page must not be able to draw
// a field the writer never meant to publish), and a reader gets one copy
// of everything whether it comes from memory or the store.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codervibes-session-events-"));
process.env.CODERVIBES_DATA_DIR = dataDir;
process.env.CODERVIBES_STORE = "json";

const events = await import("../server/events.js");
const log = await import("../server/session-events.js");
const { store } = await import("../server/store/index.js");
const { KINDS, MAX_TEXT, RING_SIZE, BATCH_SIZE, FLUSH_MS, KEEP_MS, sessionEventInternals } = log;

const file = path.join(dataDir, ".codervibes-session-events.json");
// Small "at" values read well but expired decades ago as far as the store is
// concerned; every time in here is this moment plus a little.
const T = Date.now();

test.beforeEach(async () => {
  sessionEventInternals.reset();
  await fs.rm(file, { force: true });
});
test.after(() => fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

/** Poll until it is true, rather than sleep for as long as it took once. */
async function eventually(what, check, { within = 5_000 } = {}) {
  const deadline = Date.now() + within;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`waited ${within}ms for ${what}, and it did not happen`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("an entry is in memory at once, stamped with a seq and an expiry, and in the store a moment later", async () => {
  const entry = log.append("ses_1", "agent_message_chunk", { text: "Reading the tests." }, { at: T });
  assert.equal(entry.session, "ses_1");
  assert.equal(entry.seq, T, "the seq is the time when nothing is ahead of it");
  assert.equal(entry.text, "Reading the tests.");
  assert.equal(entry.expires, Math.floor((T + KEEP_MS) / 1000));
  assert.equal(sessionEventInternals.pending().length, 1, "waiting for the batch");

  await log.flush();
  assert.equal(sessionEventInternals.pending().length, 0);
  const stored = await store.loadSessionEvents({ session: "ses_1" });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].text, "Reading the tests.");
});

test("seqs are strictly increasing on a session, even for two entries in the same millisecond or one reported late", () => {
  const a = log.append("ses_2", "agent_message_chunk", { text: "a" }, { at: T + 5000 });
  const b = log.append("ses_2", "agent_message_chunk", { text: "b" }, { at: T + 5000 });
  const c = log.append("ses_2", "agent_message_chunk", { text: "c" }, { at: T + 4000 });
  assert.deepEqual([a.seq, b.seq, c.seq], [T + 5000, T + 5001, T + 5002]);
  assert.equal(c.at, T + 4000, "the time it happened is kept as given; only the order is ours");
  const other = log.append("ses_3", "agent_message_chunk", { text: "d" }, { at: T + 4000 });
  assert.equal(other.seq, T + 4000, "sessions do not share a clock");
});

test("an entry keeps only what its kind declares", () => {
  const call = log.append("ses_4", "tool_call", {
    toolCallId: "c1",
    title: "read src/index.js",
    tool: "read_file",
    toolKind: "read",
    status: "nonsense",
    task: "t1",
    input: { path: "src/index.js" },
    rawArguments: "secret",
  });
  assert.deepEqual(Object.keys(call).sort(), ["at", "expires", "kind", "seq", "session", "status", "task", "title", "tool", "toolCallId", "toolKind"]);
  assert.equal(call.status, "in_progress", "an unknown status becomes the default for a fresh call");
  assert.equal(call.input, undefined, "the input never lands on the log");

  const status = log.append("ses_4", "platform.status", { status: "bogus", task: "t1", extra: 1 });
  assert.equal(status.status, "running");
  assert.equal(status.extra, undefined);

  const prompt = log.append("ses_4", "platform.prompt", { by: { kind: "person", id: "u1", name: "Yoav", email: "x@y" }, text: "stop" });
  assert.deepEqual(prompt.by, { kind: "person", id: "u1", name: "Yoav" });
  assert.equal(prompt.delivery, "turn-boundary");

  assert.equal(log.append("ses_4", "not_a_kind", {}), null, "an unknown kind is refused, not stored as nothing");
  assert.equal(log.append("", "tool_call", {}), null);
});

test("a chunk longer than a page would draw is cut, with a mark", () => {
  const entry = log.append("ses_5", "agent_thought_chunk", { text: "x".repeat(MAX_TEXT + 100) });
  assert.equal(entry.text.length, MAX_TEXT);
  assert.ok(entry.text.endsWith("…"));
});

test("every kind is one ACP session/update kind or a platform kind", () => {
  for (const kind of KINDS) assert.ok(/^[a-z_]+$/.test(kind) || kind.startsWith("platform."), kind);
  assert.ok(KINDS.includes("agent_message_chunk") && KINDS.includes("tool_call") && KINDS.includes("platform.status"));
});

test("a tool's ACP kind comes from its name, the gateway's and a harness's alike, and only names that exist are matched", async () => {
  const { toolKindOf } = log;
  assert.equal(toolKindOf("read_file"), "read");
  assert.equal(toolKindOf("mcp__codervibes__repo_info"), "read");
  assert.equal(toolKindOf("Bash"), "execute");
  assert.equal(toolKindOf("run_command"), "execute");
  assert.equal(toolKindOf("WebFetch"), "fetch");
  assert.equal(toolKindOf("send_message"), "other");
  // The gateway's tool list is the only list; a name that left it is not
  // kept alive in here as a special case.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../server/session-events.js", import.meta.url), "utf8");
  for (const gone of ["workspace_info", "control_service", "open_preview", "list_services", "service_logs", "apply_manifest", "push_to_workspace"]) {
    assert.doesNotMatch(source, new RegExp(gone), `${gone} is no tool of ours`);
  }
});

test("since() reads from memory when the reader is inside the ring, and from the store when it is not", async () => {
  for (let i = 1; i <= 5; i += 1) log.append("ses_6", "agent_message_chunk", { text: `${i}` }, { at: T + i });
  const fresh = await log.since("ses_6", T + 3);
  assert.deepEqual(fresh.map((e) => e.text), ["4", "5"]);

  // Push the first entries out of the ring, without writing them.
  for (let i = 6; i <= RING_SIZE + 5; i += 1) log.append("ses_6", "agent_message_chunk", { text: `${i}` }, { at: T + i });
  assert.equal(sessionEventInternals.rings.get("ses_6")[0].text, "6", "the oldest left memory");
  const beforeFlush = await log.since("ses_6", 0, { limit: 3 });
  assert.deepEqual(beforeFlush.map((e) => e.text), ["6", "7", "8"], "before the store has them, memory is all there is");

  await log.flush();
  const fromStart = await log.since("ses_6", 0, { limit: 3 });
  assert.deepEqual(fromStart.map((e) => e.text), ["1", "2", "3"], "after the write the store fills the gap");
  const all = await log.since("ses_6", 0, { limit: 1000 });
  assert.equal(all.length, RING_SIZE + 5);
  assert.equal(new Set(all.map((e) => e.seq)).size, all.length, "no entry twice");
  for (let i = 1; i < all.length; i += 1) assert.ok(all[i].seq > all[i - 1].seq, "oldest first");

  // The ring has entries the store has not, and the reader is behind the ring: both are merged.
  log.append("ses_6", "agent_message_chunk", { text: "new" }, { at: T + RING_SIZE + 6 });
  const tail = await log.since("ses_6", T + 2, { limit: 1000 });
  assert.equal(tail.at(-1).text, "new");
  assert.equal(tail.length, RING_SIZE + 4);
});

test("a batch is written when it fills, without waiting for the timer", async () => {
  for (let i = 0; i < BATCH_SIZE; i += 1) log.append("ses_7", "agent_message_chunk", { text: "." }, { at: T + i });
  // The write is in flight, not waited for. A fixed tick is a race with
  // whatever else is queued on the store - 50ms was not always enough under
  // the whole suite - so poll, and poll for less than the timer, because the
  // point of the test is that the batch went out without it.
  await eventually(
    "the full batch to go out on its own",
    async () => (await store.loadSessionEvents({ session: "ses_7", limit: 1000 })).length === BATCH_SIZE,
    { within: FLUSH_MS / 2 },
  );
  assert.equal(sessionEventInternals.pending().length, 0);
});

test("the last platform.status is the session's turn; last() finds the latest of a kind", () => {
  assert.equal(log.turnOf("ses_8"), null);
  log.append("ses_8", "platform.status", { status: "running", task: "t1" }, { at: T + 10 });
  log.append("ses_8", "agent_message_chunk", { text: "hi" }, { at: T + 11 });
  log.append("ses_8", "tool_call", { toolCallId: "c1", tool: "run_command" }, { at: T + 12 });
  assert.deepEqual(log.turnOf("ses_8"), { status: "running", since: T + 10, task: "t1" });
  assert.equal(log.last("ses_8").kind, "tool_call");
  assert.equal(log.last("ses_8", "agent_message_chunk").text, "hi");
  log.append("ses_8", "platform.status", { status: "finished" }, { at: T + 20 });
  assert.equal(log.turnOf("ses_8").status, "finished");
  log.forget("ses_8");
  assert.equal(log.turnOf("ses_8"), null);
  assert.equal(log.last("ses_8"), null);
});

test("an append rings the subscribers and nudges the event stream, with ids only and nothing stored", async () => {
  const heard = [];
  const stop = log.subscribe((entry) => heard.push(entry.kind), { session: "ses_9" });
  const nudged = [];
  const stopEvents = events.subscribe((event) => nudged.push(event));
  log.append("ses_9", "agent_message_chunk", { text: "the words" });
  log.append("ses_other", "agent_message_chunk", { text: "elsewhere" });
  stop();
  stopEvents();
  assert.deepEqual(heard, ["agent_message_chunk"], "a session-scoped subscriber hears only its session");
  const nudge = nudged.find((event) => event.type === "session.event");
  assert.ok(nudge, "the stream heard a nudge");
  assert.deepEqual(nudge.data, { sessionId: "ses_9", seq: nudge.data.seq, kind: "agent_message_chunk" });
  assert.equal(JSON.stringify(nudge).includes("the words"), false, "the text is not on the nudge");
  const stored = (await store.loadEvents?.({ limit: 50 })) ?? [];
  assert.equal(stored.some((event) => event.type === "session.event"), false, "the nudge is not in the event store");
});

test("publicView keeps names, kinds and sizes and drops every word", () => {
  const chunk = log.publicView(log.append("ses_10", "agent_message_chunk", { text: "private words" }));
  assert.deepEqual(Object.keys(chunk).sort(), ["at", "chars", "kind", "seq", "session"]);
  assert.equal(chunk.chars, 13);

  const call = log.publicView(log.append("ses_10", "tool_call", { toolCallId: "c", title: "read /etc/passwd", tool: "read_file", toolKind: "read" }));
  assert.equal(call.tool, "read_file");
  assert.equal(call.title, undefined, "a title may quote a path");

  const prompt = log.publicView(log.append("ses_10", "platform.prompt", { by: { kind: "person", id: "u", name: "Yoav" }, text: "do it" }));
  assert.deepEqual(prompt.by, { kind: "person" });
  assert.equal(prompt.text, undefined);
  assert.equal(prompt.chars, 5);

  const update = log.publicView(log.append("ses_10", "tool_call_update", { toolCallId: "c", status: "failed", ms: 12, detail: "stack trace" }));
  assert.equal(update.ms, 12);
  assert.equal(update.detail, undefined);
});

test("the json store keeps a session's log in order, after a seq, and drops what has expired", async () => {
  const gone = Math.floor(Date.now() / 1000) - 10;
  await store.appendSessionEvents([
    { session: "s", seq: 3, at: 3, kind: "agent_message_chunk", text: "c", expires: gone + 1000 },
    { session: "s", seq: 1, at: 1, kind: "agent_message_chunk", text: "a", expires: gone + 1000 },
    { session: "t", seq: 2, at: 2, kind: "agent_message_chunk", text: "other", expires: gone + 1000 },
    { session: "s", seq: 2, at: 2, kind: "agent_message_chunk", text: "b", expires: gone },
  ]);
  assert.deepEqual((await store.loadSessionEvents({ session: "s" })).map((e) => e.text), ["a", "c"]);
  assert.deepEqual((await store.loadSessionEvents({ session: "s", since: 1 })).map((e) => e.text), ["c"]);
  assert.deepEqual(await store.loadSessionEvents({}), []);
});
