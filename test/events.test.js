// The event log: one place to say something happened, one place to hear it,
// and a way to catch up on what you did not hear.
//
// The bugs this exists to catch are silences. A console whose radio dropped
// for a minute used to show a minute-old page until the next nudge, which for
// a lease running out was an hour; a second process would have heard nothing
// at all. So: the catch-up answers from memory, then from the store, and says
// honestly when it cannot; a filter keeps one person's events from another;
// and a follower hears what another process wrote.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codervibes-events-"));
process.env.CODERVIBES_DATA_DIR = dataDir;

const events = await import("../server/events.js");
const { store } = await import("../server/store/index.js");

test.after(async () => {
  await events.flush();
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
test.beforeEach(() => events.reset());

/**
 * Poll until it is true, rather than sleep for as long as it took once.
 *
 * Everything worth waiting for here lands on a tick of the follower or on a
 * store write nobody awaited, and how long either takes is whatever the
 * machine is doing - see the `codervibes-qa` skill.
 */
async function eventually(what, check, { within = 10_000 } = {}) {
  const deadline = Date.now() + within;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`waited ${within}ms for ${what}, and it did not happen`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("an event is heard by whoever is listening, and by nobody who has stopped", () => {
  const heard = [];
  const stop = events.subscribe((event) => heard.push(event.type));
  const only = [];
  const stopOnly = events.subscribe((event) => only.push(event.type), { filter: (event) => event.type === "chat.line" });

  const first = events.publish("chat.line", { repoId: "w1" }, { id: "m1" });
  events.publish("machine.status", { owner: "ann@example.com" }, { status: "up" });
  stop();
  events.publish("chat.line", { repoId: "w1" });
  stopOnly();

  assert.deepEqual(heard, ["chat.line", "machine.status"]);
  assert.deepEqual(only, ["chat.line", "chat.line"], "a filter is applied before the handler, not by it");
  assert.equal(first.repoId, "w1");
  assert.equal(first.agentId, null, "every subject field is present, so a consumer need not guard");
  assert.deepEqual(first.data, { id: "m1" });
});

test("ids sort by time, and a cursor taken before something happened finds it afterwards", async () => {
  const before = events.cursor();
  const a = events.publish("repo.saved", { repoId: "w1" });
  const b = events.publish("repo.saved", { repoId: "w2" });
  assert.ok(a.id < b.id, "later is greater, in the same millisecond too");
  assert.ok(before < a.id, "a cursor is before what comes after it");

  const missed = await events.since(before);
  assert.deepEqual(missed.events.map((event) => event.id), [a.id, b.id]);
  assert.equal(missed.complete, true);

  const nothing = await events.since(b.id);
  assert.deepEqual(nothing.events, []);
  assert.equal(nothing.complete, true, "up to date is complete, not a resync");
});

test("what this process has forgotten, the store still knows - and it says when it does not", async () => {
  const before = events.cursor();
  events.publish("chat.line", { repoId: "w1" }, { id: "m1" });
  events.publish("agent.call", { agentId: "a1" }, { tool: "run_command" });
  events.publish("agent.thinking", { agentId: "a1" }, { thinking: true });
  events.publish("machine.status", { owner: "ann@example.com" }, { status: "down" });
  await events.flush();

  // A new process: nothing in memory.
  events.reset();
  const missed = await events.since(before);
  assert.deepEqual(
    missed.events.map((event) => event.type),
    ["chat.line", "machine.status"],
    "durable ones come back from the store; a tool call or a model call in flight is not worth a write and does not",
  );
  assert.equal(missed.complete, true);
  assert.equal("day" in missed.events[0], false, "the store's own columns stay in the store");

  // A cursor from before the store's memory: honest about it.
  const stale = `${String(Date.now() - events.KEEP_MS - 1000).padStart(14, "0")}-000000-00000000`;
  const tooOld = await events.since(stale);
  assert.equal(tooOld.complete, false, "the consumer should re-read, not trust this");
});

test("what another process wrote is heard here, and what this one wrote is not heard twice", async () => {
  const heard = [];
  const stop = events.subscribe((event) => heard.push([event.type, event.origin]));
  const stopFollowing = events.follow({ everyMs: 20 });

  // Something this process says: heard once, from the bus, not again from the store.
  events.publish("repo.saved", { repoId: "w1" });
  // Something another process wrote straight to the store.
  const at = Date.now() + 1;
  await store.appendEvent({
    id: `${String(at).padStart(14, "0")}-000001-feedface`,
    at,
    type: "chat.line",
    origin: "feedface",
    repoId: "w1",
    agentId: null,
    owner: null,
    users: null,
    data: { id: "m9" },
    day: events.dayOf(at),
    expires: Math.floor((at + events.KEEP_MS) / 1000),
  });
  // The follower reads the store on a 20ms tick, so the other process's line
  // arrives some ticks from now rather than on this line. A fixed wait is a
  // race with whatever else the machine is doing - 120ms was enough alone and
  // not always enough with the rest of the suite writing behind it, which is
  // this file failing about one full run in four. Poll for what is expected
  // instead, so the test is as fast as the machine and as patient as it needs.
  await eventually("the follower to hear what another process wrote", () => heard.length >= 2);
  stopFollowing();
  stop();

  assert.deepEqual(heard, [["repo.saved", events.ORIGIN], ["chat.line", "feedface"]]);
  const caught = await events.since(`${String(at - 1).padStart(14, "0")}-000000-00000000`);
  assert.ok(caught.events.some((event) => event.origin === "feedface"), "and it is in this process's memory for catch-up");
  assert.equal("expires" in caught.events.find((event) => event.origin === "feedface"), false);
});

test("a person hears what they could read, and nothing about anybody else's repo", () => {
  const deps = {
    access: (id, user) => id === "w1" && user === "ann",
    agentOf: (id, user) => id === "a1" && user === "bob",
  };
  const hears = (subject, user) => events.concerns({ ...subject }, user, deps);
  assert.equal(hears({ repoId: "w1" }, "ann"), true);
  assert.equal(hears({ repoId: "w1" }, "bob"), false);
  assert.equal(hears({ agentId: "a1" }, "bob"), true);
  assert.equal(hears({ agentId: "a1" }, "ann"), false);
  assert.equal(hears({ owner: "cal" }, "cal"), true);
  assert.equal(hears({ owner: "cal" }, "ann"), false);
  assert.equal(hears({ users: ["dee"], repoId: "w1" }, "ann"), false, "named users are the whole audience");
  assert.equal(hears({ users: ["dee"] }, "dee"), true);
  assert.equal(hears({}, "anybody"), true, "a whole-registry write is everybody's");
});
