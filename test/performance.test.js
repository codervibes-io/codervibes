// What came of the work, and what it took - the arithmetic behind the
// Performance page, tested over made-up sessions so the table it will draw
// is known to be right before there is a table.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cv-performance-"));
process.env.CODERVIBES_STORE = "json";
process.env.CODERVIBES_DATA_DIR = dataDir;
process.env.CODERVIBES_TOKEN_SECRET = "performance-tests";
test.after(() => fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

const perf = await import("../server/performance.js");
const { mainModelOf } = await import("../server/sessions.js");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-04T12:00:00Z");

let n = 0;
/** A session, with only what the arithmetic reads. */
function session({ actor = "a1", name = "Ada", owner = "ada", kind = "resident", harness = null, startedAt = NOW - DAY, pulls = [], taskIds = [], guidance = {}, autonomy = {}, cost = 0, tokens = 0, models = [], modelTokens = null, machine = null, state = "ended", counts: wrote = {}, edits = null, filesTouched = 0 } = {}) {
  n += 1;
  return {
    id: `ses_${n}`,
    kind,
    owner,
    actor: { kind: "agent", id: actor, name },
    harness,
    startedAt,
    lastSeenAt: startedAt + 60_000,
    state,
    counts: {
      cost,
      tokens,
      ...(modelTokens ? { modelTokens } : {}),
      ...autonomy,
      ...wrote,
      guidance: { humanLines: 0, followUps: 0, retries: 0, failedTools: 0, reviewRounds: 0, interrupts: 0, ...guidance },
    },
    ...(edits ? { edits } : {}),
    filesTouched,
    models,
    machine,
    pulls,
    taskIds,
    outcome: null,
  };
}
const pull = (id, state, extra = {}) => ({ id, number: Number(id.split("#")[1]), state, changesRequested: 0, openedAt: new Date(NOW - DAY).toISOString(), ...extra });
/** A task record, as agent-tasks.js writes one, with only what the arithmetic reads. */
const task = (id, state, extra = {}) => ({
  id,
  state,
  createdAt: new Date(NOW - DAY).toISOString(),
  acceptedAt: new Date(NOW - DAY).toISOString(),
  updatedAt: new Date(NOW - DAY).toISOString(),
  ...extra,
});

// ------------------------------------------------------------- outcomes

test("the outcome is the best of the session's pull requests, and nothing without one", () => {
  assert.equal(perf.outcomeOf(session()), "none");
  assert.equal(perf.outcomeOf(session({ pulls: [pull("o/r#1", "open")] })), "open");
  assert.equal(perf.outcomeOf(session({ pulls: [pull("o/r#1", "closed"), pull("o/r#2", "merged")] })), "merged");
  assert.equal(perf.outcomeOf(session({ pulls: [pull("o/r#1", "closed")] })), "closed");
  // A stored record with an outcome and no pull summaries still says it.
  assert.equal(perf.outcomeOf({ ...session(), outcome: "merged" }), "merged");
});

test("the store's pull record wins over the session's summary of it, and links by session id", () => {
  const s = session({ pulls: [pull("o/r#1", "open")] });
  const records = [{ id: "o/r#1", state: "merged", sessionIds: [s.id], reviews: [{ state: "changes_requested" }, { state: "approved" }] }];
  assert.equal(perf.outcomeOf(s, records), "merged");
  assert.deepEqual(perf.pullsOf(s, records).map((p) => p.id), ["o/r#1"], "one entry, not two");
  assert.equal(perf.roundsOf(perf.pullsOf(s, records)[0]), 1, "rounds from the reviews when there is no summary count");
  const other = [{ id: "o/r#9", state: "merged", sessionIds: ["ses_someone_else"] }];
  assert.equal(perf.outcomeOf(s, other), "open", "another session's pull request is not this one's");
});

// ------------------------------------------------------------- friction

test("friction is points for steering, and the penalty is bounded", () => {
  assert.equal(perf.friction(session()).points, 0);
  const steered = session({ guidance: { humanLines: 3, followUps: 1, retries: 1, reviewRounds: 1, failedTools: 4 } });
  const f = perf.friction(steered);
  assert.equal(f.lines, 4);
  assert.equal(f.points, 4 + 2 * 2 + 1);
  assert.equal(perf.penaltyOf(steered), 9 / 20);
  const hopeless = session({ guidance: { humanLines: 200 } });
  assert.equal(perf.penaltyOf(hopeless), perf.MAX_PENALTY);
  assert.equal(perf.friction({ counts: {} }).points, 0, "a record from before the counts existed");
});

// ---------------------------------------------------------------- score

test("a finished task is 1, one still going runs out over two weeks, an abandoned one is 0, and friction comes off but not below 0", () => {
  const at = { now: NOW };
  assert.equal(perf.score(session({ pulls: [pull("o/r#1", "merged")] }), [], at), 1);
  assert.equal(perf.score(session({ pulls: [pull("o/r#1", "closed")] }), [], at), 0);
  assert.equal(perf.score(session(), [], at), 0);

  const fresh = perf.score(session({ pulls: [pull("o/r#1", "open", { openedAt: new Date(NOW).toISOString() })] }), [], at);
  assert.ok(Math.abs(fresh - 0.3) < 1e-9, `a just-opened pull request is worth 0.3, got ${fresh}`);
  const week = perf.score(session({ pulls: [pull("o/r#1", "open", { openedAt: new Date(NOW - 7 * DAY).toISOString() })] }), [], at);
  assert.ok(Math.abs(week - 0.15) < 1e-9, `half gone after a week, got ${week}`);
  const stale = perf.score(session({ pulls: [pull("o/r#1", "open", { openedAt: new Date(NOW - 30 * DAY).toISOString() })] }), [], at);
  // The store keeps the time in milliseconds, and that is the same day.
  assert.equal(perf.score(session({ pulls: [pull("o/r#1", "open", { openedAt: NOW - 7 * DAY })] }), [], at), week, "a millisecond time is read like an ISO one");
  assert.equal(stale, 0);

  const hardWon = perf.score(session({ pulls: [pull("o/r#1", "merged")], guidance: { humanLines: 40 } }), [], at);
  assert.equal(hardWon, 1 - perf.MAX_PENALTY, "a merge is still a merge");
  const steeredNowhere = perf.score(session({ guidance: { humanLines: 40 } }), [], at);
  assert.equal(steeredNowhere, 0, "not a debt");
});

// ----------------------------------------------------------------- rank

test("rows are per agent, count a shared pull request once, and are ordered by score", () => {
  const sessions = [
    session({ actor: "a1", name: "Ada", pulls: [pull("o/r#1", "merged")], cost: 100, guidance: { humanLines: 2 } }),
    session({ actor: "a1", name: "Ada", pulls: [pull("o/r#1", "merged")], cost: 50, guidance: { humanLines: 1 } }),
    session({ actor: "a1", name: "Ada", pulls: [pull("o/r#2", "open")], cost: 20 }),
    session({ actor: "a2", name: "Bob", pulls: [pull("o/r#3", "closed")], cost: 300 }),
    session({ actor: "a2", name: "Bob", pulls: [pull("o/r#4", "merged", { changesRequested: 3 })], cost: 300 }),
    session({ actor: "a3", name: "Cy", cost: 5 }),
    session({ actor: "a4", name: "Old", startedAt: NOW - 40 * DAY, pulls: [pull("o/r#5", "merged")] }),
  ];
  const { rows, medianRate } = perf.rank(sessions, [], { by: "agents", range: "30d", now: NOW });
  assert.deepEqual(rows.map((row) => row.name), ["Ada", "Bob", "Cy"], "the old session is outside the range");

  const ada = rows[0];
  assert.equal(ada.sessions, 3);
  assert.equal(ada.tasks, 2, "the pull request two sessions worked on is one task");
  assert.equal(ada.finished, 1);
  assert.equal(ada.rate, 0.5);
  assert.equal(ada.rounds, 1, "first time");
  assert.equal(ada.lines, 3);
  assert.equal(ada.linesPerTask, 1.5, "over the tasks it took, not the ones that landed");
  assert.equal(ada.cost, 170);
  assert.equal(ada.costPerTask, 85);

  const bob = rows[1];
  assert.equal(bob.finished, 1);
  assert.equal(bob.unfinished, 1);
  assert.equal(bob.rounds, 4, "three times back, then in");
  assert.equal(bob.costPerTask, 300);

  const cy = rows[2];
  assert.equal(cy.tasks, 0);
  assert.equal(cy.rate, null, "a session nobody asked a piece of work of is not a rate of zero");
  assert.equal(cy.costPerTask, null);
  assert.equal(medianRate, 0.5);
});

test("effective is finishing at least one at no worse than the installation's median rate", () => {
  const sessions = [
    session({ actor: "a1", name: "Ada", pulls: [pull("o/r#1", "merged"), pull("o/r#2", "merged"), pull("o/r#3", "open")] }),
    session({ actor: "a2", name: "Bob", pulls: [pull("o/r#4", "merged"), pull("o/r#5", "closed"), pull("o/r#6", "closed"), pull("o/r#7", "closed")] }),
    session({ actor: "a3", name: "Cy" }),
  ];
  const { rows, medianRate } = perf.rank(sessions, [], { by: "agents", now: NOW });
  const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
  assert.equal(medianRate, (2 / 3 + 1 / 4) / 2, "over the rows that took something");
  assert.equal(byName.Ada.effective, true);
  assert.equal(byName.Bob.effective, false, "a quarter finished, under the median");
  assert.equal(byName.Cy.effective, false, "nothing finished");

  // With a third rate in the middle, the middle one is the bar and meets it.
  sessions.push(session({ actor: "a4", name: "Di", pulls: [pull("o/r#8", "merged"), pull("o/r#9", "closed")] }));
  const again = Object.fromEntries(perf.rank(sessions, [], { by: "agents", now: NOW }).rows.map((row) => [row.name, row]));
  assert.equal(again.Di.effective, true);
  assert.equal(again.Bob.effective, false);
});

test("a single row that finished something is effective: the median is its own rate", () => {
  const { rows } = perf.rank([session({ pulls: [pull("o/r#1", "merged"), pull("o/r#2", "closed")] })], [], { now: NOW });
  assert.equal(rows[0].effective, true);
});

test("grouping by harness, by person and by session", () => {
  const sessions = [
    session({ actor: "a1", owner: "ada", harness: { id: "h1", kind: "claude-code", name: "Claude Code" }, kind: "harness", pulls: [pull("o/r#1", "merged")] }),
    session({ actor: "a2", owner: "ada", pulls: [pull("o/r#2", "merged")] }),
    session({ actor: "a3", owner: "bob", kind: "external", harness: null }),
  ];
  const harnesses = perf.rank(sessions, [], { by: "harnesses", now: NOW }).rows;
  assert.deepEqual(harnesses.map((row) => [row.key, row.name]), [["agentd", "agentd"], ["h1", "Claude Code"], ["external", "external"]], "tied on everything, so by name");
  const users = perf.rank(sessions, [], { by: "users", now: NOW }).rows;
  assert.deepEqual(users.map((row) => [row.key, row.sessions, row.finished]), [["ada", 2, 2], ["bob", 1, 0]]);
  const each = perf.rank(sessions, [], { by: "sessions", now: NOW }).rows;
  assert.equal(each.length, 3);
  assert.ok(each.every((row) => row.key.startsWith("ses_")));
});

test("a session row carries what the Performance page filters by; the grouped rows do not", () => {
  const sessions = [
    session({ actor: "a1", name: "Nomad", owner: "ada", harness: { id: "h1", kind: "claude-code", name: "Claude Code" }, kind: "harness", startedAt: NOW - DAY }),
    session({ actor: "a2", name: "Scout", owner: "bob", startedAt: NOW - 2 * DAY }),
  ];
  const each = perf.rank(sessions, [], { by: "sessions", now: NOW }).rows;
  const byKey = new Map(each.map((row) => [row.key, row]));
  assert.deepEqual(byKey.get(sessions[0].id).actor, { id: "a1", name: "Nomad" });
  assert.deepEqual(byKey.get(sessions[0].id).harness, { id: "h1", kind: "claude-code", name: "Claude Code" });
  assert.equal(byKey.get(sessions[0].id).owner, "ada");
  assert.equal(byKey.get(sessions[0].id).startedAt, NOW - DAY);
  // A resident with no harness record ran in the loop, and the filter chip needs a kind to stand on.
  assert.deepEqual(byKey.get(sessions[1].id).harness, { id: "agentd", kind: "agentd", name: "agentd" });
  for (const by of ["agents", "harnesses", "users"]) {
    const row = perf.rank(sessions, [], { by, now: NOW }).rows[0];
    assert.ok(!("actor" in row) && !("harness" in row) && !("owner" in row), `${by} rows are aggregates`);
  }
});

test("ties: opening something that was closed still beats opening nothing, and the rest is by name", () => {
  const sessions = [
    session({ actor: "b", name: "Bee", startedAt: NOW - DAY }),
    session({ actor: "a", name: "Ant", startedAt: NOW - DAY }),
    session({ actor: "c", name: "Cat", pulls: [pull("o/r#1", "closed")] }),
  ];
  const { rows } = perf.rank(sessions, [], { now: NOW });
  assert.deepEqual(rows.map((row) => row.name), ["Cat", "Ant", "Bee"]);
});

// ----------------------------------------------------------------- tasks

test("an agent that never opens a pull request is ranked on the tasks it was handed", () => {
  // The bug this measure exists for: a triage agent that files issues and
  // answers questions used to be a row of noughts, because it had opened
  // nothing to merge. Both of these did three pieces of work and finished
  // two; only one of them wrote pull requests.
  const tasks = [task("t1", "done"), task("t2", "done"), task("t3", "failed")];
  const triage = [
    session({ actor: "a1", name: "Triage", taskIds: ["t1"] }),
    session({ actor: "a1", name: "Triage", taskIds: ["t2"] }),
    session({ actor: "a1", name: "Triage", taskIds: ["t3"] }),
  ];
  const writer = [
    session({ actor: "a2", name: "Writer", pulls: [pull("o/r#1", "merged")] }),
    session({ actor: "a2", name: "Writer", pulls: [pull("o/r#2", "merged")] }),
    session({ actor: "a2", name: "Writer", pulls: [pull("o/r#3", "closed")] }),
  ];
  const { rows } = perf.rank([...triage, ...writer], [], { by: "agents", now: NOW, tasks });
  const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
  assert.equal(byName.Triage.tasks, 3);
  assert.equal(byName.Triage.finished, 2);
  assert.equal(byName.Triage.rate, 2 / 3);
  assert.deepEqual(
    [byName.Triage.tasks, byName.Triage.finished, byName.Triage.rate],
    [byName.Writer.tasks, byName.Writer.finished, byName.Writer.rate],
    "the same work, counted the same, whether or not it went through a pull request",
  );
  assert.equal(byName.Triage.effective, true, "and it can be effective, which it never could before");
});

test("a task record is the verdict; a pull request is only what stands in when there is none", () => {
  const at = { now: NOW };
  const tasks = [task("t1", "done"), task("t2", "failed"), task("t3", "accepted"), task("t4", "declined")];
  assert.equal(perf.score(session({ taskIds: ["t1"] }), [], { tasks, ...at }), 1);
  assert.equal(perf.score(session({ taskIds: ["t2"] }), [], { tasks, ...at }), 0, "failed is not finished");
  assert.equal(perf.score(session({ taskIds: ["t4"] }), [], { tasks, ...at }), 0, "nor is declined");
  assert.ok(perf.score(session({ taskIds: ["t3"] }), [], { tasks, ...at }) > 0, "accepted is still going, and worth something");

  // The record wins over the pull request: a task marked done by an agent
  // whose pull request is still open is done - the person who took the
  // work said so, and that is the stronger statement.
  const both = session({ taskIds: ["t1"], pulls: [pull("o/r#1", "open")] });
  assert.equal(perf.verdictOf(both, [], tasks), "done");
  assert.equal(perf.score(both, [], { tasks, ...at }), 1);

  // A task id the caller has no record for is not a verdict at all, so the
  // pull request stands in as it did before - a session mid-flight whose
  // task has not been written yet must not read as a failure.
  const unknown = session({ taskIds: ["t9"], pulls: [pull("o/r#2", "merged")] });
  assert.equal(perf.verdictOf(unknown, [], tasks), "done");
});

test("a session nobody asked a piece of work of is a session and not a task", () => {
  const rows = perf.rank([session({ cost: 400 }), session({ cost: 100, pulls: [pull("o/r#1", "merged")] })], [], {
    by: "agents",
    now: NOW,
  }).rows;
  assert.equal(rows[0].sessions, 2);
  assert.equal(rows[0].tasks, 1, "the question-and-answer session is not work that can be said to have landed");
  assert.equal(rows[0].finished, 1);
  assert.equal(rows[0].rate, 1, "and it does not drag the rate down to a half");
  assert.equal(rows[0].costPerTask, 500, "but every penny it spent is still in the cost of the task that did land");
});

test("two sessions on one task are one task, and the retries are its rounds", () => {
  const tasks = [task("t1", "done", { attempt: 3, retryOf: "t0" })];
  const { rows } = perf.rank(
    [session({ taskIds: ["t1"] }), session({ taskIds: ["t1"] })],
    [],
    { by: "agents", now: NOW, tasks },
  );
  assert.equal(rows[0].sessions, 2);
  assert.equal(rows[0].tasks, 1, "the task two sessions worked on is one task");
  assert.equal(rows[0].finished, 1);
  assert.equal(rows[0].rounds, 3, "the third attempt is the one that landed");
});

// ------------------------------------------------------------ comparing

test("the model a session is credited with is the one it spent its tokens on, not the first to answer", () => {
  // The bug this refuses. Claude Code opens a session with a small call to
  // Haiku of its own - a title, a quota check - before the person's work
  // reaches the model they picked, so Haiku is the first name on nearly
  // every session's list. Reading `models[0]`, which is what every surface
  // here used to do, credited Haiku with the work on fifty-two of the
  // fifty-five sessions on this installation that had a model at all: the
  // model split named Haiku for a day of Opus, and the provider grouping
  // stood on the same wrong pick.
  const claudeCode = {
    models: ["claude-haiku-4-5-20251001", "claude-opus-5"],
    modelTokens: { "claude-haiku-4-5-20251001": 4_200, "claude-opus-5": 15_800_000 },
  };
  assert.equal(mainModelOf(session(claudeCode)), "claude-opus-5", "the model that spent the tokens");
  // And that is the name the model split draws its line under.
  const split = perf.trend([session({ ...claudeCode, startedAt: NOW - 2 * 60 * 60 * 1000 })], [], { range: "24h", now: NOW }).splits.model;
  assert.deepEqual(split.map((series) => series.name), ["claude-opus-5"], "the line is the model that did the work");

  // Across vendors it decides the provider too: a session that opened on a
  // gateway and did its work on Anthropic is Anthropic's.
  const crossed = session({ models: ["gpt-5-nano", "claude-opus-5"], modelTokens: { "gpt-5-nano": 900, "claude-opus-5": 2_000_000 } });
  assert.deepEqual(perf.groupOf(crossed, "provider"), { key: "anthropic", name: "Anthropic" });

  // A record written before the tokens were kept by model still has its
  // list, and the first name is the best guess there is - the old
  // behaviour, kept for the history it is the only answer for.
  assert.equal(mainModelOf(session({ models: ["gpt-5", "claude-opus-5"] })), "gpt-5", "no per-model tokens: the list's first, as before");
  // And a session that reported no model is not guessed at.
  assert.equal(mainModelOf(session()), null);
  assert.deepEqual(perf.groupOf(session(), "provider"), { key: "unknown", name: "Not reported" });
  // A tie does not depend on the order an object was built in.
  assert.equal(mainModelOf(session({ models: ["b-2", "a-1"], modelTokens: { "b-2": 500, "a-1": 500 } })), "a-1");
  // Tokens nobody spent do not win: a model that answered and used nothing
  // loses to one that used something, whatever order they are in.
  assert.equal(mainModelOf(session({ models: ["a-1", "b-2"], modelTokens: { "a-1": 0, "b-2": 12 } })), "b-2");
});

test("a session is grouped by its heaviest model's vendor, its harness kind, where it ran, and whose it was", () => {
  const labels = { harnessLabel: (kind) => ({ "claude-code": "Claude Code", agentd: "CoderVibes loop" })[kind] ?? kind };
  const s = session({
    owner: "ada", kind: "harness", harness: { id: "h1", kind: "claude-code", name: "mine" },
    models: ["claude-sonnet-5", "gpt-5"], machine: { id: "e2b:sb-1", name: "sb-1", host: "e2b" },
  });
  assert.deepEqual(perf.groupOf(s, "provider"), { key: "anthropic", name: "Anthropic" }, "one vendor, once, even for a session that called two");
  assert.deepEqual(perf.groupOf(s, "harness", labels), { key: "claude-code", name: "Claude Code" });
  assert.deepEqual(perf.groupOf(s, "sandbox"), { key: "e2b", name: "e2b sandbox" });
  assert.deepEqual(perf.groupOf(s, "user"), { key: "ada", name: "ada" });
  // A model the catalogue does not list still has a family; one nobody serves is named as itself.
  assert.deepEqual(perf.groupOf(session({ models: ["gpt-6-preview"] }), "provider"), { key: "openai", name: "OpenAI" });
  assert.deepEqual(perf.groupOf(session({ models: ["mystery-9"] }), "provider"), { key: "model:mystery-9", name: "mystery-9" });
  // Work whose session said nothing still gets a group, named - the
  // charts leave that group out (below), but nothing is thrown away here.
  assert.deepEqual(perf.groupOf(session(), "provider"), { key: perf.UNREPORTED, name: "Not reported" });
  assert.deepEqual(perf.groupOf(session(), "sandbox"), { key: perf.UNREPORTED, name: "Not reported" });
  assert.deepEqual(perf.groupOf(session({ machine: { id: "laptop:mbp", name: "mbp", host: "laptop" } }), "sandbox"), { key: "laptop", name: "Laptop" });
  assert.deepEqual(perf.groupOf(session({ kind: "resident" }), "harness", labels), { key: "agentd", name: "CoderVibes loop" });
  assert.throws(() => perf.groupOf(session(), "colour"), /Not a dimension/);
  assert.deepEqual(perf.DIMENSIONS, ["provider", "harness", "sandbox", "user", "work"]);
});

test("interventions are every time a person stepped in - a cut short included - and never a tool failure the agent recovered from", () => {
  assert.equal(perf.interventionsOf(session({ guidance: { humanLines: 2, followUps: 1, reviewRounds: 1, failedTools: 9, retries: 3, interrupts: 2 } })), 9);
  assert.equal(perf.interventionsOf({ counts: {} }), 0, "a record from before the signals existed");
});

test("the comparison gives each option the five figures per task, timed from start to the moment it landed", () => {
  const HOUR = 60 * 60 * 1000;
  // Anthropic: three sessions, two of them a task, both finished. One
  // merged after two hours with one line said to it, one after four hours
  // with three interventions; the third was asked for nothing, so it is a
  // session here and not a task - its tokens and cost still count, because
  // they were still spent.
  const a1 = session({ models: ["claude-sonnet-5"], tokens: 1000, cost: 100, startedAt: NOW - 10 * HOUR, pulls: [pull("o/r#1", "merged")], guidance: { humanLines: 1 } });
  const a2 = session({ models: ["claude-opus-5"], tokens: 3000, cost: 500, startedAt: NOW - 20 * HOUR, pulls: [pull("o/r#2", "merged")], guidance: { humanLines: 2, reviewRounds: 1 } });
  const a3 = session({ models: ["claude-sonnet-5"], tokens: 500, cost: 30, startedAt: NOW - 5 * HOUR });
  // OpenAI: one task, open, cheap.
  const o1 = session({ models: ["gpt-5-mini"], tokens: 200, cost: 5, startedAt: NOW - 3 * HOUR, pulls: [pull("o/r#3", "open")] });
  // The store's records carry the merge time; the sessions' own summaries do not.
  const records = [
    { id: "o/r#1", number: 1, state: "merged", sessionIds: [a1.id], mergedAt: NOW - 8 * HOUR, changesRequested: 0 },
    { id: "o/r#2", number: 2, state: "merged", sessionIds: [a2.id], mergedAt: new Date(NOW - 16 * HOUR).toISOString(), changesRequested: 1 },
  ];
  const { rows } = perf.compare([a1, a2, a3, o1], records, { dimension: "provider", now: NOW });
  assert.deepEqual(rows.map((row) => row.name), ["Anthropic", "OpenAI"], "most tasks first, whatever the figure");
  const [anthropic, openai] = rows;
  assert.equal(anthropic.sessions, 3);
  assert.equal(anthropic.tasks, 2, "the session nobody asked a piece of work of is not a task");
  assert.equal(anthropic.finished, 2);
  assert.equal(anthropic.closureRate, 1);
  assert.equal(anthropic.tokens, 4500, "every session's tokens, task or not");
  assert.equal(anthropic.tokensPerTask, 2250);
  assert.equal(anthropic.cost, 630);
  assert.equal(anthropic.costPerTask, 315, "what it spent, over the work it was actually asked for");
  assert.equal(anthropic.timeToClosure, 3 * HOUR, "the median of two and four hours");
  assert.equal(anthropic.timed, 2);
  assert.equal(anthropic.interventions, 2, "the mean of 1 and 3, over the sessions that finished something");
  assert.equal(openai.closureRate, 0);
  assert.equal(openai.tasks, 1);
  assert.equal(openai.timeToClosure, null, "nothing finished, so no time to it");
  assert.equal(openai.interventions, null);
  assert.equal(openai.costPerTask, 5);
  // A merged pull request with no merge time is finished but is not timed.
  const untimed = perf.compare([a1], [{ id: "o/r#1", number: 1, state: "merged", sessionIds: [a1.id] }], { dimension: "provider", now: NOW }).rows[0];
  assert.equal(untimed.finished, 1);
  assert.equal(untimed.timed, 0);
  assert.equal(untimed.timeToClosure, null);
  // Outside the range is outside the comparison.
  assert.deepEqual(perf.compare([session({ startedAt: NOW - 40 * DAY })], [], { range: "30d", now: NOW }).rows, []);
});

test("compareAll answers every dimension at once, with the range's totals", () => {
  const sessions = [
    session({ owner: "ada", models: ["claude-sonnet-5"], pulls: [pull("o/r#1", "merged")], machine: { id: "e2b:x", name: "x", host: "e2b" } }),
    session({ owner: "bob", models: ["gpt-5"], kind: "harness", harness: { id: "h", kind: "codex", name: "Codex" } }),
  ];
  const all = perf.compareAll(sessions, [], { range: "7d", now: NOW, harnessLabel: (kind) => kind.toUpperCase() });
  assert.equal(all.range, "7d");
  assert.equal(all.sessions, 2);
  assert.equal(all.tasks, 1, "one of the two was asked for a piece of work");
  assert.equal(all.finished, 1);
  assert.deepEqual(Object.keys(all.dimensions), ["provider", "harness", "sandbox", "user", "work"]);
  assert.deepEqual(all.dimensions.provider.map((row) => row.name), ["Anthropic", "OpenAI"]);
  assert.deepEqual(all.dimensions.harness.map((row) => row.name), ["AGENTD", "CODEX"], "named by the caller's labels");
  assert.deepEqual(all.dimensions.sandbox.map((row) => row.name), ["e2b sandbox"], "the session that said no machine is not a bar");
  assert.deepEqual(all.dimensions.user.map((row) => [row.key, row.finished]), [["ada", 1], ["bob", 0]]);
  // What was left off is not lost: it comes back as the row it would have
  // been, so the page can say how much of the range the bars stand on.
  assert.equal(all.unreported.sandbox.sessions, 1);
  assert.equal(all.unreported.sandbox.tasks, 0, "it said no machine and was asked for no piece of work");
  assert.equal(all.unreported.sandbox.name, "Not reported");
  assert.equal(all.unreported.provider, null, "both sessions said a model, so nothing is off that chart");
  assert.equal(all.unreported.harness, null);
  assert.equal(all.unreported.user, null);
  assert.equal(all.dimensions.sandbox.reduce((sum, row) => sum + row.sessions, 0) + all.unreported.sandbox.sessions, all.sessions, "the bars and what is off them are the range");
});

test("the trend is the range as points, a day or an hour each, with spend on the start and a task on the day it finished", () => {
  const HOUR = 60 * 60 * 1000;
  // Three sessions on two days. The first merged the next day: it counts
  // as done then, not on the day it started. Its cost stays on its start.
  const a = session({ tokens: 1000, cost: 100, startedAt: NOW - 3 * DAY, pulls: [pull("o/r#1", "merged")] });
  const b = session({ tokens: 200, cost: 20, startedAt: NOW - 3 * DAY + HOUR, pulls: [pull("o/r#2", "open")] });
  const c = session({ tokens: 50, cost: 5, startedAt: NOW - 1 * DAY });
  const records = [{ id: "o/r#1", number: 1, state: "merged", sessionIds: [a.id], mergedAt: NOW - 2 * DAY, changesRequested: 0 }];
  const week = perf.trend([a, b, c], records, { range: "7d", now: NOW });
  assert.equal(week.step, "day");
  assert.equal(week.points.length, 8, "every day in the range, the current one included");
  assert.ok(week.points.every((point, i, all) => !i || point.at - all[i - 1].at === DAY), "one a day, in order");
  assert.ok(week.points.every((point) => point.at % DAY === 0), "UTC-aligned, carried as milliseconds");
  const on = (daysAgo) => week.points.find((point) => point.at === Math.floor((NOW - daysAgo * DAY) / DAY) * DAY);
  assert.deepEqual({ ...on(3) }, { at: on(3).at, sessions: 2, finished: 0, taken: 2, cost: 120, tokens: 1200, steers: 0, lines: 0 }, "the start day holds the spend and the tasks taken");
  assert.deepEqual({ ...on(2) }, { at: on(2).at, sessions: 0, finished: 1, taken: 0, cost: 0, tokens: 0, steers: 0, lines: 0 }, "the day it landed holds the task finished");
  assert.equal(on(1).sessions, 1);
  assert.equal(on(5).sessions, 0, "a quiet day is present, at nought");
  assert.deepEqual(week.totals, { sessions: 3, finished: 1, taken: 2, cost: 125, tokens: 1250, steers: 0, lines: 0 });

  // A merged pull request with no merge time counts as finished on the start.
  const untimed = perf.trend([a], [{ id: "o/r#1", number: 1, state: "merged", sessionIds: [a.id] }], { range: "7d", now: NOW });
  assert.equal(untimed.points.find((point) => point.finished === 1).at, on(3).at);

  // A day is hours.
  const day = perf.trend([session({ startedAt: NOW - 30 * HOUR }), session({ cost: 7, startedAt: NOW - 2 * HOUR })], [], { range: "24h", now: NOW });
  assert.equal(day.step, "hour");
  assert.equal(day.points.length, 25);
  assert.ok(day.points.every((point) => point.at % HOUR === 0));
  assert.equal(day.points.find((point) => point.at === Math.floor((NOW - 2 * HOUR) / HOUR) * HOUR).cost, 7);
  assert.equal(day.totals.sessions, 1, "the session from yesterday is outside a day's range");

  // Outside the range is not on the line.
  assert.equal(perf.trend([session({ startedAt: NOW - 40 * DAY })], [], { range: "30d", now: NOW }).totals.sessions, 0);
  assert.deepEqual(perf.TREND_METRICS, ["cost", "tokens", "finished", "sessions", "steers", "lines"]);
});

test("the trend splits into a line per group, every group over the same periods, most sessions first, the tail folded into Other", () => {
  const HOUR = 60 * 60 * 1000;
  const sessions = [
    session({ actor: "a1", name: "Nomad", owner: "ada", models: ["claude-sonnet-5"], cost: 100, startedAt: NOW - 3 * DAY, pulls: [pull("o/r#1", "merged")], machine: { id: "e2b:x", name: "x", host: "e2b" } }),
    session({ actor: "a1", name: "Nomad", owner: "ada", models: ["claude-opus-5"], cost: 50, startedAt: NOW - 2 * DAY, kind: "harness", harness: { id: "h1", kind: "claude-code", name: "Claude Code" } }),
    session({ actor: "a2", name: "Scout", owner: "bob", models: ["gpt-5"], cost: 30, startedAt: NOW - 2 * DAY + HOUR, kind: "harness", harness: { id: "h2", kind: "codex", name: "Codex" } }),
    session({ actor: "a3", name: "Quiet", owner: "cy", cost: 7, startedAt: NOW - 1 * DAY }),
  ];
  const records = [{ id: "o/r#1", number: 1, state: "merged", sessionIds: [sessions[0].id], mergedAt: NOW - 1 * DAY, changesRequested: 0 }];
  const out = perf.trend(sessions, records, { range: "7d", now: NOW, harnessLabel: (kind) => kind.toUpperCase() });
  assert.deepEqual(Object.keys(out.splits), ["provider", "model", "harness", "sandbox", "user", "executor"]);
  const names = (split) => out.splits[split].map((line) => line.name);
  assert.deepEqual(names("provider"), ["Anthropic", "OpenAI"], "most sessions first; the session that named no model is not a line");
  assert.deepEqual(names("model"), ["claude-opus-5", "claude-sonnet-5", "gpt-5"], "one each: ties by name");
  assert.deepEqual(names("harness"), ["AGENTD", "CLAUDE-CODE", "CODEX"], "named by the caller's labels");
  assert.deepEqual(names("sandbox"), ["e2b sandbox"], "three sessions said no machine: one line, for the one that did");
  assert.deepEqual(names("user"), ["ada", "bob", "cy"]);
  assert.deepEqual(names("executor"), ["Nomad", "Quiet", "Scout"]);

  // What is not a line is not lost either: the sessions that said nothing
  // come back totalled the same way, so the lines plus that are the whole.
  assert.equal(out.unreported.provider.sessions, 1);
  assert.equal(out.unreported.provider.cost, 7, "the Quiet session's spend, off the chart but counted");
  assert.deepEqual(out.unreported.sandbox.sessions, 3);
  assert.equal(out.unreported.harness, null, "every session had a harness kind, so nothing is off that chart");
  assert.equal(out.unreported.user, null);

  // Every line runs over the range's periods, and the lines of a split
  // add up to the whole: spend on the start, the task on the day it landed.
  const anthropic = out.splits.provider[0];
  assert.equal(anthropic.points.length, out.points.length);
  assert.deepEqual(anthropic.points.map((point) => point.at), out.points.map((point) => point.at));
  assert.deepEqual(anthropic.totals, { sessions: 2, finished: 1, taken: 1, cost: 150, tokens: 0, steers: 0, lines: 0 });
  for (const split of Object.keys(out.splits)) {
    const off = out.unreported[split];
    const summed = out.splits[split].reduce((sum, line) => sum + line.totals.cost, 0) + (off?.cost ?? 0);
    assert.equal(summed, out.totals.cost, `${split}'s lines, plus what did not say, add up to the whole`);
    assert.equal(out.splits[split].reduce((sum, line) => sum + line.totals.finished, 0) + (off?.finished ?? 0), 1);
  }
  const landedOn = out.points.find((point) => point.finished === 1).at;
  assert.equal(anthropic.points.find((point) => point.finished === 1).at, landedOn, "the finished task sits on the day it landed on its line too");

  // Past six groups the smallest fold into one, named for how many.
  const many = Array.from({ length: 9 }, (_, i) => session({ owner: `u${i}`, cost: 9 - i, startedAt: NOW - DAY }));
  const users = perf.trend(many, [], { range: "7d", now: NOW }).splits.user;
  assert.equal(users.length, 6);
  assert.deepEqual(users.slice(0, 5).map((line) => line.name), ["u0", "u1", "u2", "u3", "u4"], "ties by name");
  assert.equal(users[5].key, "other");
  assert.equal(users[5].name, "Other (4)");
  assert.deepEqual(users[5].folded, ["u5", "u6", "u7", "u8"]);
  assert.equal(users[5].totals.cost, 4 + 3 + 2 + 1);
  assert.equal(users[5].totals.sessions, 4);
});

test("grouping by machine keys a row the way the Executors page keys its own, so a setup's standing meets its row", () => {
  // The Executors page builds a row per machine and calls it
  // `setup:<machine id>` (index.js `discoveredSetups`). The ranking used to
  // offer no grouping that matched, so the standing was looked up by a key
  // nothing produced and every "This month" cell was a dash - on an
  // installation whose executors are all setups, that is every row there is.
  const laptop = { id: "laptop:mbp", name: "mbp" };
  const sandbox = { id: "e2b:abc", name: "abc" };
  const sessions = [
    session({ machine: laptop, pulls: [pull("o/r#1", "merged")] }),
    session({ machine: laptop, pulls: [pull("o/r#2", "closed")] }),
    session({ machine: sandbox, pulls: [pull("o/r#3", "merged")] }),
    // A session whose start hook never landed named no machine, so it is on
    // no row on that page and must be on none of these either.
    session({ machine: null, pulls: [pull("o/r#4", "merged")] }),
  ];
  const rows = perf.rank(sessions, [], { by: "machines", now: NOW }).rows;
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
  assert.deepEqual(Object.keys(byKey).sort(), ["?", "setup:e2b:abc", "setup:laptop:mbp"]);
  assert.equal(byKey["setup:laptop:mbp"].name, "mbp");
  assert.equal(byKey["setup:laptop:mbp"].kind, "setup");
  assert.equal(byKey["setup:laptop:mbp"].sessions, 2);
  assert.equal(byKey["setup:laptop:mbp"].finished, 1);
  assert.equal(byKey["setup:laptop:mbp"].tasks, 2, "the abandoned one was still a task");
  assert.equal(byKey["setup:e2b:abc"].sessions, 1);
});

// ------------------------------------------- what became of the merges

const reverted = (id, over = {}) => pull(id, "merged", { mergedAt: NOW - DAY, reverted: { at: NOW, by: { kind: "pull", number: 99, url: "u" } }, ...over });
/** Merged, deployed, and then the app put back on the release before it. */
const rolledBack = (id, over = {}) => pull(id, "merged", {
  mergedAt: NOW - DAY,
  shipped: { at: NOW - DAY, sessionId: "s1", app: "engine-prod", release: 174 },
  rolledBack: {
    at: NOW,
    app: "engine-prod",
    fromRelease: { version: 174, imageRef: "registry.fly.io/engine-prod:deployment-174" },
    toRelease: { version: 173, imageRef: "registry.fly.io/engine-prod:deployment-173" },
    by: { kind: "agent", id: "a1", name: "Scout" },
    sessionId: "s2",
  },
  ...over,
});

test("a merge that was taken back out, or that broke the build, is not a task finished", () => {
  assert.equal(perf.pullVerdict(pull("o/r#1", "merged")), "done");
  assert.equal(perf.pullVerdict(reverted("o/r#2")), "undone");
  assert.equal(perf.pullVerdict(pull("o/r#3", "merged", { brokeBuild: { runId: "r", pipeline: "p", at: NOW, url: "u" } })), "undone");
  assert.equal(perf.pullVerdict(pull("o/r#4", "merged", { followUps: 2 })), "done", "a fix behind it is not an undoing; it is on the row as its own column");
  assert.equal(perf.pullVerdict(pull("o/r#5", "closed")), "undone");
  assert.equal(perf.pullVerdict(pull("o/r#6", "open")), "doing");
  assert.equal(perf.pullVerdict(null), "doing");

  // And the Activity chip says the word, ahead of "merged".
  assert.equal(perf.outcomeOf(session({ pulls: [reverted("o/r#2")] })), "reverted");
  assert.equal(perf.outcomeOf(session({ pulls: [pull("o/r#1", "merged")] })), "merged");

  const undone = perf.rank([session({ pulls: [reverted("o/r#2")] })], [], { now: NOW });
  assert.deepEqual([undone.rows[0].finished, undone.rows[0].unfinished, undone.rows[0].tasks], [0, 1, 1]);
});

test("a merge production gave back is not a task finished either, and says so in the same word", () => {
  // The branch still carries it and GitHub still says merged; the app it
  // shipped to is on an older image, so it is running nowhere. That is the
  // strongest signal this page has, and reading it as done would be the
  // one flattery pullVerdict exists to refuse.
  const out = rolledBack("o/r#10");
  assert.equal(perf.pullVerdict(out), "undone");
  assert.equal(perf.undoneAfter(out), true);
  assert.equal(perf.outcomeOf(session({ pulls: [out] })), "reverted", "the Activity chip keeps the one word for taken back out");
  assert.equal(perf.pullVerdict(pull("o/r#11", "merged", { shipped: { at: NOW, sessionId: "s", app: "engine", release: 9 } })), "done");

  const after = perf.aftermathOf([
    pull("o/r#12", "merged", { shipped: { at: NOW, sessionId: "s", app: "engine", release: 9 } }),
    out,
    pull("o/r#13", "open"),
  ]);
  assert.deepEqual(
    [after.landed, after.shipped, after.rolledBack, after.undoneAfter],
    [2, 2, 1, 1],
    "both reached production; one of them was taken out of it again",
  );
});

test("a row says how much of what it landed came apart, and how much of it was still there a month on", () => {
  const rows = perf.rank([
    session({ actor: "a1", pulls: [pull("o/r#1", "merged", { durability: { added: 10, kept: 9, share: 0.9 } })] }),
    session({ actor: "a1", pulls: [pull("o/r#2", "merged", { followUps: 1, durability: { added: 10, kept: 5, share: 0.5 } })] }),
    session({ actor: "a1", pulls: [reverted("o/r#3")] }),
    session({ actor: "a1", pulls: [pull("o/r#4", "open")] }),
    session({ actor: "a2", pulls: [pull("o/r#5", "merged")] }),
  ], [], { now: NOW }).rows;
  const [ada] = rows.filter((row) => row.key === "a1");
  assert.equal(ada.landed, 3, "three merged, whatever became of them");
  assert.equal(ada.undoneAfter, 2, "the reverted one and the one a fix came back to");
  assert.equal(ada.failureRate, 2 / 3, "of what landed, not of what is still counted as finished");
  assert.equal(ada.kept, 0.7, "the median of the two that have been measured");
  assert.equal(ada.measured, 2);

  const [other] = rows.filter((row) => row.key === "a2");
  assert.deepEqual([other.undoneAfter, other.failureRate, other.kept], [0, 0, null], "nothing measured is not nought per cent kept");
});

test("a session comes to one word, and a session that took nothing on comes to one too", () => {
  const at = NOW - 30 * DAY;
  const ended = (over = {}) => session({ startedAt: at, ...over });
  const withEnd = (over = {}) => ({ ...ended(over), endedAt: at + 60_000 });
  const yieldOf = (record, options = {}) => perf.yieldOf(record, [], [], { now: NOW, ...options });

  assert.equal(yieldOf(withEnd({ pulls: [pull("o/r#1", "merged", { shipped: { at: NOW, sessionId: "s", app: "engine", release: 1 } })] })), "shipped");
  assert.equal(yieldOf(withEnd({ pulls: [pull("o/r#2", "merged")] })), "merged");
  assert.equal(yieldOf(withEnd({ pulls: [pull("o/r#3", "merged", { followUps: 1 })] })), "reworked");
  assert.equal(yieldOf(withEnd({ pulls: [pull("o/r#4", "merged", { changesRequested: 2 })] })), "reworked");
  assert.equal(yieldOf(withEnd({ pulls: [reverted("o/r#5")] })), "reverted");
  assert.equal(yieldOf(withEnd({ pulls: [pull("o/r#6", "closed")] })), "closed");
  assert.equal(yieldOf(withEnd({ pulls: [pull("o/r#7", "open")] })), "going");
  assert.equal(yieldOf({ ...withEnd(), filesTouched: 9 }), "discarded", "it edited nine files a month ago and nothing came of it");
  assert.equal(yieldOf({ ...withEnd(), filesTouched: 0 }), "research", "it edited nothing: a question, answered");
  assert.equal(yieldOf({ ...withEnd({ startedAt: NOW - 60_000 }), endedAt: NOW - 30_000, filesTouched: 3 }), "going", "ended an hour ago; the pull request may still be coming");
  assert.equal(yieldOf(ended({ state: "live" })), "going");

  // Reverted is read before shipped: something in production that had to
  // be taken back out is the fact worth saying.
  assert.equal(yieldOf(withEnd({ pulls: [reverted("o/r#8", { shipped: { at: NOW, sessionId: "s", app: "e", release: 2 } })] })), "reverted");
  // And "taken back out" includes production giving it back, which is the
  // same answer to the reader's question and so the same word.
  assert.equal(yieldOf(withEnd({ pulls: [rolledBack("o/r#8b")] })), "reverted");

  assert.deepEqual(
    perf.yields([withEnd({ pulls: [pull("o/r#9", "merged")] }), { ...withEnd(), filesTouched: 2 }], [], { now: NOW }),
    { shipped: 0, merged: 1, reworked: 0, reverted: 0, closed: 0, discarded: 1, research: 0, going: 0 },
  );
});

test("the comparison says what a whole way of working came to, and what it spent on work that never landed", () => {
  const at = NOW - 10 * DAY;
  const ended = (over) => ({ ...session({ startedAt: at, ...over }), endedAt: at + 60_000 });
  const compared = perf.compareAll([
    ended({ owner: "ada", cost: 100, pulls: [pull("o/r#1", "merged", { durability: { added: 10, kept: 8, share: 0.8 } })] }),
    ended({ owner: "ada", cost: 200, pulls: [reverted("o/r#2")] }),
    ended({ owner: "bob", cost: 50, pulls: [pull("o/r#3", "closed")] }),
    { ...ended({ owner: "bob", cost: 25 }), filesTouched: 4 },
  ], [], { range: "30d", now: NOW });

  assert.equal(compared.waste, 275, "the reverted one, the closed one and the discarded one");
  assert.equal(compared.spend, 375);
  assert.equal(compared.yield.reverted, 1);
  assert.equal(compared.yield.discarded, 1);
  assert.equal(compared.aftermath.landed, 2);
  assert.equal(compared.aftermath.undoneAfter, 1);
  assert.equal(compared.aftermath.kept, 0.8);

  const byUser = new Map(compared.dimensions.user.map((row) => [row.key, row]));
  assert.equal(byUser.get("ada").failureRate, 0.5);
  assert.equal(byUser.get("ada").kept, 0.8);
  assert.equal(byUser.get("bob").waste, 2, "both of Bob's sessions bought nothing that lasted");
  assert.equal(byUser.get("bob").failureRate, null, "Bob landed nothing, which is not a failure rate of nought");
});

// ------------------------------------------------------------- autonomy

test("a steer is everything after the first ask, and a session nobody came back to has none", () => {
  assert.equal(perf.steersOf(session()), 0);
  assert.equal(perf.steersOf(session({ guidance: { humanLines: 4 } })), 0, "the ask itself is not a steer, however many lines carried it");
  assert.equal(
    perf.steersOf(session({ guidance: { followUps: 2, interrupts: 1, reviewRounds: 1, retries: 1, failedTools: 8 } })),
    5,
    "a tool the agent retried by itself is not a person coming back",
  );
  assert.equal(perf.steersOf({ counts: {} }), 0, "a record from before any of this existed");
});

test("an external vendor's agent is not unsteered, it is unobserved, and the row says which", () => {
  assert.equal(perf.steeringVisibleOf(session()), true);
  assert.equal(perf.steeringVisibleOf(session({ kind: "harness" })), true);
  assert.equal(perf.steeringVisibleOf(session({ kind: "external" })), false);
  const figures = perf.autonomyFigures(session({ kind: "external" }));
  assert.equal(figures.visible, false);
  assert.deepEqual(perf.rank([session({ kind: "external" })], [], { now: NOW }).rows[0].steeringVisible, false);
  // One external session among two does not blind the row.
  const rows = perf.rank([session({ kind: "external" }), session({ kind: "harness" })], [], { by: "users", now: NOW }).rows;
  assert.equal(rows[0].steeringVisible, true);
});

test("steers the model did not label are counted as unclassified, never dropped", () => {
  const steered = session({ guidance: { followUps: 3, interrupts: 1 }, autonomy: { turns: 5, agentMs: 700, personMs: 2400, steers: { correct: 2, clarify: 1 } } });
  const figures = perf.autonomyFigures(steered);
  assert.deepEqual([figures.turns, figures.agentMs, figures.personMs], [5, 700, 2400]);
  assert.equal(figures.steers, 4);
  assert.deepEqual(figures.kinds, { correct: 2, clarify: 1 });
  assert.equal(figures.unclassified, 1, "four steers, three labelled");
  // Nothing labelled at all - an installation with no model to ask.
  assert.equal(perf.autonomyFigures(session({ guidance: { followUps: 2 } })).unclassified, 2);
});

test("a task finished first time is one nobody came back to, and the rate is over the finished ones", () => {
  const clean = session({ pulls: [pull("o/r#1", "merged")], autonomy: { turns: 1 } });
  const fought = session({ pulls: [pull("o/r#2", "merged")], guidance: { followUps: 2, interrupts: 1 }, autonomy: { turns: 4 } });
  const lost = session({ pulls: [pull("o/r#3", "closed")], guidance: { followUps: 5 }, autonomy: { turns: 6 } });
  const [row] = perf.rank([clean, fought, lost], [], { by: "users", now: NOW }).rows;
  assert.equal(row.finished, 2);
  assert.equal(row.oneShot, 1, "one of the two that landed took no steering");
  assert.equal(row.oneShotKnown, 2, "and both of them had their steering counted");
  assert.equal(row.oneShotRate, 0.5, "over the finished tasks, not over every task");
  assert.equal(row.steers, 8, "the row's whole steering, abandoned work included");
  assert.equal(
    perf.rank([session({ autonomy: { turns: 1 } })], [], { by: "users", now: NOW }).rows[0].oneShotRate,
    null,
    "nothing finished, nothing to rate",
  );
});

test("a session whose steering was never counted is not a session that took none: its tasks are unknown, not first-time", () => {
  // The prod bug this fixes. Every record from before the turn counter has
  // no `counts.turns` and an empty guidance, so `steersOf` reads nought on
  // it - and the page said each of them finished first time.
  const old = session({ pulls: [pull("o/r#1", "merged")] });
  assert.equal(perf.steeringKnownOf(old), false, "no turn was ever counted, so the nought is the sensor's");
  const [stale] = perf.rank([old], [], { by: "users", now: NOW }).rows;
  assert.equal(stale.finished, 1);
  assert.equal(stale.oneShot, 0, "not one - nobody knows");
  assert.equal(stale.oneShotKnown, 0);
  assert.equal(stale.oneShotRate, null, "and a null is what the page draws \"not measured\" from");

  // One counted turn and no steer after it is the real thing.
  const counted = session({ pulls: [pull("o/r#2", "merged")], autonomy: { turns: 1 } });
  assert.equal(perf.steeringKnownOf(counted), true);
  const [known] = perf.rank([counted], [], { by: "users", now: NOW }).rows;
  assert.equal(known.oneShot, 1);
  assert.equal(known.oneShotKnown, 1);
  assert.equal(known.oneShotRate, 1);

  // A session woken by the bell is never prompted through the door that
  // counts turns, so its guidance is the proof instead.
  assert.equal(perf.steeringKnownOf(session({ kind: "resident", guidance: { humanLines: 3 } })), true);
  assert.equal(perf.steeringKnownOf(session({ kind: "assistant", guidance: { humanLines: 1 } })), true);
  assert.equal(perf.steeringKnownOf(session({ kind: "resident" })), false, "a resident nobody said anything to says nothing either way");
  // A harness session gets no such benefit: its road counts turns.
  assert.equal(perf.steeringKnownOf(session({ kind: "harness", guidance: { humanLines: 9 } })), false);
  // And an agent we cannot watch at all is not known however it looks.
  assert.equal(perf.steeringKnownOf(session({ kind: "external", autonomy: { turns: 4 } })), false);
  assert.equal(perf.autonomyFigures(counted).known, true);
  assert.equal(perf.autonomyFigures(old).known, false);

  // Mixed: the counted task carries the rate, the uncounted one is out of
  // the denominator rather than lifting it.
  const [mixed] = perf.rank([old, counted], [], { by: "users", now: NOW }).rows;
  assert.equal(mixed.finished, 2);
  assert.equal(mixed.oneShotKnown, 1, "one of the two finished tasks can be read");
  assert.equal(mixed.oneShotRate, 1);

  // And the row says whether its steering total stands on anything at all,
  // since a sum of noughts nobody counted is not a sum.
  assert.equal(stale.steeringKnown, false);
  assert.equal(stale.steeringCounted, 0);
  assert.equal(known.steeringKnown, true);
  assert.equal(mixed.steeringKnown, true, "one counted session among two makes the total low, not meaningless");
  assert.equal(mixed.steeringCounted, 1);
});

test("the comparison stacks each option's sessions by how much steering they took, and by what kind", () => {
  const laptop = (extra) => session({ machine: { id: "laptop:mbp", name: "mbp", host: "laptop" }, ...extra });
  const rows = perf.compare(
    [
      laptop({ pulls: [pull("o/r#1", "merged")], autonomy: { turns: 1 } }),
      laptop({ pulls: [pull("o/r#2", "merged")], guidance: { followUps: 2 }, autonomy: { turns: 3, steers: { correct: 1, clarify: 1 }, agentMs: 1000, personMs: 5000 } }),
      laptop({ guidance: { followUps: 4, interrupts: 3 }, autonomy: { turns: 5, agentMs: 3000, personMs: 1000 } }),
    ],
    [],
    { dimension: "sandbox", now: NOW },
  ).rows;
  const [laptops] = rows;
  assert.deepEqual(laptops.steerBuckets, { "0": 1, "1-2": 1, "3-5": 0, "6+": 1, unknown: 0 });
  assert.equal(laptops.steerKinds.correct, 1);
  assert.equal(laptops.steerKinds.clarify, 1);
  assert.equal(laptops.steerKinds.unclassified, 7, "two of the nine steers were labelled");
  assert.equal(laptops.oneShot, 1);
  assert.equal(laptops.oneShotRate, 0.5);
  assert.equal(laptops.agentMs, 2000, "the median of the sessions that reported a clock, not the total");
  assert.equal(laptops.personMs, 3000);
  assert.equal(laptops.steeringVisible, true);
});

test("a session whose steering was never counted goes in the comparison's unknown bucket, not in \"0\"", () => {
  const laptop = (extra) => session({ machine: { id: "laptop:mbp", name: "mbp", host: "laptop" }, ...extra });
  const [laptops] = perf.compare(
    [
      laptop({ pulls: [pull("o/r#1", "merged")], autonomy: { turns: 1 } }),
      // Two records from before the counter: nought steers apiece, and
      // neither of them evidence of anything.
      laptop({ pulls: [pull("o/r#2", "merged")] }),
      laptop({}),
    ],
    [],
    { dimension: "sandbox", now: NOW },
  ).rows;
  assert.deepEqual(laptops.steerBuckets, { "0": 1, "1-2": 0, "3-5": 0, "6+": 0, unknown: 2 });
  assert.equal(laptops.finished, 2, "both merges are finished tasks");
  assert.equal(laptops.oneShotKnown, 1, "but only one of them can be read for first-time");
  assert.equal(laptops.oneShot, 1);
  assert.equal(laptops.oneShotRate, 1, "and it is not halved by a task nobody measured");

  // An option made only of uncounted records has no rate at all.
  const [older] = perf.compare([laptop({ pulls: [pull("o/r#3", "merged")] })], [], { dimension: "sandbox", now: NOW }).rows;
  assert.equal(older.finished, 1);
  assert.equal(older.oneShotKnown, 0);
  assert.equal(older.oneShotRate, null);
  assert.deepEqual(older.steerBuckets, { "0": 0, "1-2": 0, "3-5": 0, "6+": 0, unknown: 1 });
});

test("the trend counts steering per period, so a week whose spend held steady but whose steering climbed shows it", () => {
  const line = perf.trend(
    [
      session({ startedAt: NOW - 3 * DAY, guidance: { followUps: 1 } }),
      session({ startedAt: NOW - 3 * DAY, guidance: { followUps: 2, interrupts: 1 } }),
      session({ startedAt: NOW - DAY }),
    ],
    [],
    { range: "7d", now: NOW },
  );
  assert.equal(line.totals.steers, 4);
  const on = (daysAgo) => line.points.find((point) => point.at === Math.floor((NOW - daysAgo * DAY) / DAY) * DAY);
  assert.equal(on(3).steers, 4);
  assert.equal(on(1).steers, 0);
});

test("what a session wrote and what a merge kept of it - and the difference between nought and not measured", () => {
  const wrote = session({ counts: { linesAdded: 200, linesRemoved: 40, edits: 12 }, edits: { accepted: 150 } });
  const figures = perf.editsOf(wrote);
  assert.equal(figures.linesAdded, 200);
  assert.equal(figures.linesRemoved, 40);
  assert.equal(figures.accepted, 150);
  assert.equal(figures.acceptance, 0.75);
  assert.equal(figures.measured, true);

  assert.equal(figures.why, null, "a measured session has nothing to apologise for");

  // A session that edited nothing wrote nought, and that is a measurement -
  // as long as the record carries the key at all.
  const asked = session({ counts: { linesAdded: 0 } });
  assert.equal(perf.editsOf(asked).measured, true);
  assert.equal(perf.editsOf(asked).linesAdded, 0);
  assert.equal(perf.editsOf(asked).why, null);

  // A session that plainly edited files and reported no lines for them is
  // the one case where there is no answer - Codex's hooks carry no tool
  // input. Nought there would be a claim nobody can support.
  const codex = session({ harness: { id: "h1", name: "Codex", kind: "codex" }, counts: { linesAdded: 0 }, filesTouched: 6 });
  assert.equal(perf.editsOf(codex).measured, false);
  assert.equal(perf.editsOf(codex).acceptance, null);
  assert.equal(perf.editsOf(codex).why, "harness");

  // A merge that kept more lines than the session wrote - one distinct
  // line the diff repeats - is capped rather than shown over 100%.
  assert.equal(perf.editsOf(session({ counts: { linesAdded: 3 }, edits: { accepted: 9 } })).acceptance, 1);

  // Over a set, the share is pooled: four lines all kept do not outweigh
  // four hundred half kept.
  const pooled = perf.acceptanceOfAll([wrote, session({ counts: { linesAdded: 4 }, edits: { accepted: 4 } }), codex]);
  assert.equal(pooled.linesAdded, 204);
  assert.equal(pooled.accepted, 154);
  assert.equal(Math.round(pooled.acceptance * 100), 75);
  assert.equal(pooled.measured, 2);
  assert.equal(pooled.unmeasured, 1);
  assert.deepEqual(perf.acceptanceOfAll([]), { linesAdded: 0, reviewed: 0, accepted: 0, acceptance: null, measured: 0, unmeasured: 0, predates: 0, merged: 0 });

  // A session whose pull request is still open has written lines nothing
  // has kept or thrown away yet: they are not in the denominator, or the
  // figure would say how much of the week's work had merged by Tuesday.
  const waiting = perf.acceptanceOfAll([wrote, session({ counts: { linesAdded: 900 } })]);
  assert.equal(waiting.linesAdded, 1100, "written is all of it");
  assert.equal(waiting.reviewed, 200, "reviewed is what a merge has judged");
  assert.equal(waiting.acceptance, 0.75);
  assert.equal(waiting.merged, 1);
});

test("not measured has two reasons, and telling a Claude Code record its harness is at fault is the wrong one", () => {
  // A record from before the count has no `counts.linesAdded` at all. Every
  // record written since carries it, at nought when nothing was written -
  // so the key's absence is the age of the record and nothing else.
  const old = session({ harness: { id: "h1", name: "Claude Code", kind: "claude-code" }, filesTouched: 3 });
  assert.equal("linesAdded" in old.counts, false, "the fixture is a record from before the count");
  assert.equal(perf.editsOf(old).measured, false);
  assert.equal(perf.editsOf(old).why, "predates", "not the harness: Claude Code's hooks send tool_input and always did");
  // Even one that touched no files: there is no count on it either way.
  assert.equal(perf.editsOf(session({ harness: { id: "h1", name: "Claude Code", kind: "claude-code" } })).why, "predates");

  // A harness that genuinely cannot say, on a record new enough to have
  // been asked.
  for (const kind of ["codex", "opencode"]) {
    const harness = { id: `h-${kind}`, name: kind, kind };
    assert.equal(perf.editsOf(session({ harness, counts: { linesAdded: 0 }, filesTouched: 4 })).why, "harness");
  }

  // And a harness that could have said and did not: a gap this app cannot
  // explain, which it says rather than blaming the harness.
  const odd = session({ harness: { id: "h1", name: "Claude Code", kind: "claude-code" }, counts: { linesAdded: 0 }, filesTouched: 2 });
  assert.equal(perf.editsOf(odd).measured, false);
  assert.equal(perf.editsOf(odd).why, "unknown");

  // A row counts the old records apart, so the page can apologise properly.
  const over = perf.acceptanceOfAll([old, session({ counts: { linesAdded: 0 }, harness: { id: "h2", name: "Codex", kind: "codex" }, filesTouched: 1 })]);
  assert.equal(over.unmeasured, 2);
  assert.equal(over.predates, 1);
});

test("lines per finished task is a dash where nothing could be counted, not nought - nought is the flattering end", () => {
  const merged = pull("o/r#1", "merged");
  // A row whose only session predates the count finished a task and wrote
  // lines nobody has. Nought lines per task would make it the leanest row
  // on the page.
  const [blind] = perf.rank([session({ pulls: [merged], filesTouched: 5 })], [], { by: "users", now: NOW }).rows;
  assert.equal(blind.finished, 1);
  assert.equal(blind.linesMeasured, 0);
  assert.equal(blind.writtenPerFinished, null, "no lines counted, so no lines per task");
  assert.equal(blind.linesPredate, 1, "and the page can say the record is old rather than the harness mute");

  // Measured and nought is still nought: a session that wrote nothing and
  // said so has an answer.
  const [quiet] = perf.rank([session({ pulls: [pull("o/r#2", "merged")], counts: { linesAdded: 0 } })], [], { by: "users", now: NOW }).rows;
  assert.equal(quiet.linesMeasured, 1);
  assert.equal(quiet.writtenPerFinished, 0);

  // The comparison keeps the same rule.
  const [option] = perf.compare([session({ owner: "ada", pulls: [merged], filesTouched: 5 })], [], { dimension: "user", now: NOW }).rows;
  assert.equal(option.finished, 1);
  assert.equal(option.linesMeasured, 0);
  assert.equal(option.writtenPerFinished, null);
  assert.equal(option.linesPredate, 1);
});

test("a row says how much code it wrote and how much of it survived review, over the sessions that could be counted", () => {
  const merged = pull("o/r#1", "merged");
  const rows = perf.rank(
    [
      session({ actor: "a1", name: "Ada", counts: { linesAdded: 300 }, edits: { accepted: 210 }, pulls: [merged] }),
      session({ actor: "a1", name: "Ada", counts: { linesAdded: 100 }, edits: { accepted: 30 }, pulls: [pull("o/r#2", "merged")] }),
      // Its harness never said what its edits contained.
      session({ actor: "a1", name: "Ada", filesTouched: 4 }),
      session({ actor: "a2", name: "Scout", filesTouched: 9 }),
    ],
    [],
    { by: "agents", now: NOW },
  ).rows;
  const ada = rows.find((row) => row.name === "Ada");
  assert.equal(ada.written, 400);
  assert.equal(ada.accepted, 240);
  assert.equal(ada.acceptance, 0.6);
  assert.equal(ada.reviewed, 400);
  assert.equal(ada.linesReviewed, 2);
  assert.equal(ada.linesMeasured, 2);
  assert.equal(ada.linesUnmeasured, 1, "the page draws 'not measured' for a row with nothing to divide");

  const scout = rows.find((row) => row.name === "Scout");
  assert.equal(scout.linesMeasured, 0);
  assert.equal(scout.acceptance, null, "not nought: nothing about this row was counted");

  // And the comparison carries the same two figures per option.
  const compared = perf.compare(
    [session({ owner: "ada", counts: { linesAdded: 300 }, edits: { accepted: 210 }, pulls: [merged] })],
    [{ id: "o/r#1", number: 1, state: "merged", sessionIds: [], mergedAt: NOW - DAY, changesRequested: 0 }],
    { dimension: "user", now: NOW },
  ).rows[0];
  assert.equal(compared.acceptance, 0.7);
  assert.equal(compared.written, 300);
  assert.equal(compared.writtenPerFinished, 300, "one task finished, three hundred lines to do it");
});

test("sessions group by the kind of work the agent said, and the ones that never said are the Unsaid remainder", () => {
  const sessions = [
    { ...session({ owner: "ada", pulls: [pull("o/r#1", "merged")], cost: 4 }), work: "code" },
    { ...session({ owner: "ada", pulls: [pull("o/r#2", "closed")], cost: 2 }), work: "code" },
    { ...session({ owner: "bob", cost: 1 }), work: "incident" },
    session({ owner: "bob", cost: 3 }),
    { ...session({ owner: "bob" }), work: "bugfix" },
  ];
  const compared = perf.compare(sessions, [], { dimension: "work", now: NOW });
  assert.deepEqual(compared.rows.map((row) => [row.key, row.name, row.sessions]), [["code", "Code", 2], ["incident", "Incident", 1]]);
  const code = compared.rows[0];
  assert.equal(code.tasks, 2);
  assert.equal(code.finished, 1);
  assert.equal(code.closureRate, 0.5);
  assert.equal(code.cost, 6);
  assert.equal(code.costPerTask, 3);
  assert.equal(code.waste, 1, "the closed one bought nothing");
  // Nothing on the record is not a kind, and neither is a word the record
  // layer would have refused - the page reads only what noteWork kept, so
  // a stray string on a record is read as unsaid rather than drawn.
  assert.equal(compared.unreported.name, "Unsaid");
  assert.equal(compared.unreported.sessions, 2, "the record that never said and the one with a word off the list are both unsaid");
  assert.deepEqual(
    perf.compare(sessions, [], { dimension: "work", now: NOW }).rows.map((row) => row.key),
    ["code", "incident"],
    "the word off the list is a kind nobody may group by",
  );

  // Every dimension at once now includes it, and the session row carries it
  // for the filter - a null key where the agent never said, so there is no
  // "Unsaid" to pick.
  const all = perf.compareAll(sessions, [], { range: "7d", now: NOW });
  assert.ok(all.dimensions.work, "the page reads the kinds table off compareAll");
  assert.equal(all.unreported.work.sessions, 2);
  const rows = perf.rank(sessions, [], { by: "sessions", now: NOW }).rows;
  const byKey = new Map(rows.map((row) => [row.key, row]));
  assert.deepEqual(byKey.get(sessions[0].id).work, { key: "code", name: "Code" });
  assert.deepEqual(byKey.get(sessions[3].id).work, { key: null, name: null });
});
