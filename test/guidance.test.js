// How much a person had to steer, counted on the session it steered.
//
// The signals are caught where they already happen - the wake bell, a
// retry, a task moved, a turn asked - and each lands on the actor's live
// session as a count. What these prove is that the right session counts
// the right thing, that an agent with no live session counts nothing, and
// that nothing said is on the record.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codervibes-guidance-"));
process.env.CODERVIBES_DATA_DIR = dataDir;
process.env.CODERVIBES_STORE = "json";

const sessions = await import("../server/sessions.js");
const guidance = await import("../server/guidance.js");
const sessionEvents = await import("../server/session-events.js");
const { wake } = await import("../server/wake.js");
const { sessionInternals } = sessions;

test.beforeEach(() => sessionInternals.reset());
test.after(() => fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

const scout = { id: "a-scout", name: "Scout" };
const nomad = { id: "a-nomad", name: "Nomad" };
const room = { "w1": [scout, nomad] };
const agentsIn = (repoId) => room[repoId] ?? [];
const open = (agent, extra = {}) =>
  sessions.open({ kind: "resident", owner: "yoav", actor: { kind: "agent", ...agent }, repoId: "w1", ...extra });
const steering = (session) => sessions.guidanceOf(session);

test("a room line counts on the agents it addresses, and only on those with a live session", () => {
  const live = open(scout);
  // Nomad has no session: the line wakes it, and the session that wake
  // produces starts clean.
  const counted = guidance.noteLine("w1", { text: "@Scout and @Nomad: stop and report", user: "yoav" }, { agentsIn });
  assert.deepEqual(counted, [scout.id]);
  assert.equal(steering(live).humanLines, 1);

  // A line to nobody in particular is overheard, not steering.
  assert.deepEqual(guidance.noteLine("w1", { text: "hm, the build is slow", user: "yoav" }, { agentsIn }), []);
  assert.equal(steering(live).humanLines, 1);

  // @agents and @all are to everybody who is there.
  assert.deepEqual(guidance.noteLine("w1", { text: "@agents pause", user: "yoav" }, { agentsIn }), [scout.id]);
  assert.equal(steering(live).humanLines, 2);

  // An agent's line is not a person steering, whoever it names.
  assert.deepEqual(guidance.noteLine("w1", { text: "@Scout done", agent: nomad }, { agentsIn }), []);
  assert.equal(steering(live).humanLines, 2);
});

test("the private line counts on that agent alone", () => {
  const live = open(scout);
  const other = open(nomad);
  assert.deepEqual(guidance.noteLine("agent:a-scout", { text: "try the other branch", user: "yoav" }, { agentsIn }), [scout.id]);
  assert.equal(steering(live).humanLines, 1);
  assert.equal(steering(other).humanLines, 0);
  assert.deepEqual(guidance.noteLine("agent:a-nobody", { text: "hello?", user: "yoav" }, { agentsIn }), []);
});

test("the bell is where the lines are heard, and a watcher that stops hears no more", () => {
  const live = open(scout);
  const stop = guidance.watchGuidance({ agentsIn });
  wake("w1", { message: { text: "Scout, look at the failing test", user: "yoav" } });
  wake("agent:a-scout", { message: { text: "and the other one", user: "yoav" } });
  // Rings that carry no line - a task, a poll - count nothing and break nothing.
  wake("w1");
  wake("agent:a-scout", { task: "t1" });
  assert.equal(steering(live).humanLines, 2);
  stop();
  wake("w1", { message: { text: "Scout, one more", user: "yoav" } });
  assert.equal(steering(live).humanLines, 2);
});

test("a retry counts on the agent that failed, a move on the one it came to", () => {
  const failed = open(scout);
  const moved = open(nomad);
  assert.equal(guidance.retried({ to: { id: scout.id, name: "Scout" } })?.id, failed.id);
  assert.equal(steering(failed).retries, 1);
  assert.equal(guidance.retried({ to: { id: "a-gone" } }), null, "an agent with no session is not being steered");
  assert.equal(guidance.movedTo(nomad.id)?.id, moved.id);
  assert.equal(steering(moved).followUps, 1);
  assert.equal(steering(moved).retries, 0);
  assert.equal(steering(failed).followUps, 0);
});

test("asking the assistant is a line, and every ask after the first is also a follow-up", () => {
  const talk = sessions.open({ kind: "assistant", owner: "yoav", actor: { kind: "assistant", id: "assistant", name: "Assistant" }, repoId: "w1" });
  guidance.asked(talk.id);
  assert.deepEqual([steering(talk).humanLines, steering(talk).followUps], [1, 0]);
  guidance.asked(talk.id);
  guidance.asked(talk.id);
  assert.deepEqual([steering(talk).humanLines, steering(talk).followUps], [3, 2]);
  assert.equal(guidance.asked("ses_0000000000000000"), null);
});

test("a prompt through the one door is a turn, a line, and a follow-up after the first", () => {
  const live = open(scout);
  // The session is marked running from the moment it opens, so the state
  // the door reads is set here rather than assumed.
  sessionEvents.append(live.id, "platform.status", { status: "idle" });
  guidance.prompted(live.id);
  assert.equal(live.counts.turns, 1);
  assert.deepEqual([steering(live).humanLines, steering(live).followUps, steering(live).interrupts], [1, 0, 0]);
  sessionEvents.append(live.id, "platform.status", { status: "idle" });
  guidance.prompted(live.id);
  assert.equal(live.counts.turns, 2);
  assert.deepEqual([steering(live).humanLines, steering(live).followUps, steering(live).interrupts], [2, 1, 0]);
  assert.equal(guidance.prompted("ses_0000000000000000"), null);
});

test("a prompt over a running turn is the person cutting the agent off, and a cancel is the same cut", () => {
  const live = open(scout);
  sessionEvents.append(live.id, "platform.status", { status: "idle" });
  guidance.prompted(live.id);
  sessionEvents.append(live.id, "platform.status", { status: "running" });
  guidance.prompted(live.id);
  assert.equal(steering(live).interrupts, 1, "typed over a turn that was still running");
  assert.equal(steering(live).followUps, 1, "and still a follow-up: the person is steering");
  guidance.cancelled(live.id);
  assert.equal(steering(live).interrupts, 2, "Stop is the same cut, said with a button");
  assert.equal(live.counts.turns, 2, "a cancel begins no turn");
  assert.equal(guidance.cancelled("ses_0000000000000000"), null);
});

test("the words are counted where they are said: a room line is not counted twice by the door", () => {
  const live = open(scout);
  sessionEvents.append(live.id, "platform.status", { status: "idle" });
  // What acp.js does for a prompt it posts into the room: the turn and the
  // follow-up are the door's, the line is the bell's.
  guidance.prompted(live.id, { line: false });
  guidance.noteLine("agent:a-scout", { text: "try the other branch", user: "yoav" }, { agentsIn });
  assert.equal(live.counts.turns, 1);
  assert.equal(steering(live).humanLines, 1, "one line said once");
});

test("the clock is the person's while the agent waits, and nothing is charged for a turn that never idled", () => {
  const live = open(scout);
  const idleAt = Date.now() - 60_000;
  sessionEvents.append(live.id, "platform.status", { status: "idle" }, { at: idleAt });
  guidance.prompted(live.id, { at: idleAt + 60_000 });
  assert.equal(live.counts.personMs, 60_000);
  assert.equal(live.counts.agentMs, 0, "the door never charges the agent");
});

test("nothing said is on the record", () => {
  const live = open(scout);
  guidance.noteLine("agent:a-scout", { text: "the password is hunter2", user: "yoav" }, { agentsIn });
  assert.doesNotMatch(JSON.stringify(live), /hunter2|yoav@/);
});
