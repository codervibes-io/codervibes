// The fold behind the Tools page: spans and closed tasks into three tables -
// tools, connectors, skills - with each half of a row from the source that
// knows it, and the harness's own tools summed into a line rather than rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fold, tasksUsing, attribute, isNative, isMirror, kindOf, RANGES, DEFAULT_RANGE, CHARS_PER_TOKEN, NATIVE_TOOLS, RECENT_SESSIONS } from "../server/tool-stats.js";

const NOW = Date.parse("2026-09-04T12:00:00Z");
const HOUR = 60 * 60 * 1000;

function toolSpan({ name, kind = "connector", ok = true, ms = 10, at = NOW, session = "ses_1", agent = ["ag_1", "Nomad", "invited"], handed = 0, sandbox = 0, harness = null }) {
  return {
    id: `${at}-${Math.random().toString(16).slice(2, 10)}`,
    name: "tool.call",
    session,
    at,
    ms,
    ok,
    attrs: {
      "cv.tool.name": name,
      "cv.tool.kind": kind,
      "cv.agent.id": agent[0],
      "cv.agent.name": agent[1],
      "cv.agent.kind": agent[2],
      ...(handed ? { "cv.handed.chars": handed } : {}),
      ...(sandbox ? { "cv.sandbox.ms": sandbox } : {}),
      ...(harness ? { "cv.harness.id": harness } : {}),
    },
  };
}

function connectorSpan({ id, tool = "github_read", write = false, ok = true, ms = 100, at = NOW, session = "ses_1", agent = ["ag_1", "Nomad", "invited"] }) {
  return {
    id: `${at}-${Math.random().toString(16).slice(2, 10)}`,
    name: "connector.call",
    session,
    at,
    ms,
    ok,
    attrs: { "cv.connector.id": id, "cv.connector.write": write, "cv.tool.name": tool, "cv.agent.id": agent[0], "cv.agent.name": agent[1], "cv.agent.kind": agent[2] },
  };
}

function skillSpan({ name, via = "tool", ok = true, at = NOW, session = "ses_1", agent = ["ag_1", "Nomad", "invited"] }) {
  return {
    id: `${at}-${Math.random().toString(16).slice(2, 10)}`,
    name: "skill.use",
    session,
    at,
    ms: 0,
    ok,
    attrs: { ...(name ? { "cv.skill.name": name } : {}), "cv.skill.via": via, "cv.tool.name": "skill", "cv.agent.id": agent[0], "cv.agent.name": agent[1], "cv.agent.kind": agent[2] },
  };
}

function task({ id, state = "done", tools = [], connectors = [], skills = [], settledAt = new Date(NOW).toISOString(), kind = "pr", failure = null, repoId = "repo-1", title = "Tidy the notes" }) {
  return { id, repoId, title, state, failure, settledAt, outcome: { kind }, to: { id: "ag_1", name: "Nomad" }, used: { tools, connectors, skills } };
}

test("the ranges are Performance's, and the default is the week", () => {
  assert.deepEqual(Object.keys(RANGES), ["24h", "7d", "30d"]);
  assert.equal(DEFAULT_RANGE, "7d");
});

test("the harness's own tools are native whatever they are called, and this app's names for them are native whatever kind says", () => {
  assert.equal(isNative("read_file", "harness"), true);
  assert.equal(isNative("anything_at_all", "harness"), true);
  assert.equal(isNative("read_file", "builtin"), true, "the sandbox's read_file, from when this app ran machines");
  assert.equal(isNative("run_command", null), true, "a task's table may name the tool and not its kind");
  assert.equal(isNative("merge_pull_request", "builtin"), false, "this app's own tool is not the harness's");
  assert.equal(isNative("send_message", "collab"), false);
  assert.equal(isNative("github_read", "connector"), false);
  // A tool the harness reported under another MCP server's name is that server's.
  assert.equal(kindOf("github.create_issue", "harness"), "mcp");
  assert.equal(isNative("github.create_issue", "harness"), false);
  assert.ok(NATIVE_TOOLS.has("read_file") && NATIVE_TOOLS.has("run_command") && NATIVE_TOOLS.has("search"));
});

test("the spans give a tool its calls, failures, times, context and callers; native calls are a line", () => {
  const spans = [
    toolSpan({ name: "github_read", ms: 10, handed: 400 }),
    toolSpan({ name: "github_read", ms: 30, handed: 800, session: "ses_2" }),
    toolSpan({ name: "github_read", ms: 200, ok: false, agent: ["ag_2", "Scout", "resident"] }),
    toolSpan({ name: "send_message", kind: "collab", ms: 5000, sandbox: 4800 }),
    // The harness's own: summed, not rows.
    toolSpan({ name: "read_file", kind: "harness", ms: 5 }),
    toolSpan({ name: "read_file", kind: "harness", ms: 7, ok: false }),
    toolSpan({ name: "run_command", kind: "harness", ms: 900 }),
    toolSpan({ name: "read_file", kind: "builtin", ms: 1 }),
  ];
  const { tools } = fold({ spans, since: NOW - HOUR });
  const { rows, totals, kinds, native } = tools;
  assert.deepEqual(rows.map((row) => row.name), ["github_read", "send_message"], "most called first, and none of the harness's own");
  const [read, send] = rows;
  assert.equal(read.calls, 3);
  assert.equal(read.failed, 1);
  assert.equal(read.okRate, 2 / 3);
  assert.equal(read.ms, 240);
  assert.equal(read.msMedian, 30);
  assert.equal(read.msMax, 200);
  assert.equal(read.handedChars, 1200);
  assert.equal(read.handedTokens, 1200 / CHARS_PER_TOKEN);
  assert.equal(read.sessions, 2);
  assert.equal(read.lastAt, NOW);
  assert.deepEqual(read.agents, [
    { id: "ag_1", name: "Nomad", kind: "invited", calls: 2, failed: 0 },
    { id: "ag_2", name: "Scout", kind: "resident", calls: 1, failed: 1 },
  ]);
  assert.equal(send.sandboxMs, 4800);
  assert.equal(send.msMedian, 5000);
  // No task has closed with either on it: the task half is empty, not wrong.
  assert.equal(read.tasks.used, 0);
  assert.equal(read.tasks.doneRate, null);
  assert.equal(totals.calls, 4, "the native calls are not in the totals");
  assert.equal(totals.failed, 1);
  assert.equal(totals.tools, 2);
  assert.equal(totals.handedTokens, 300);
  assert.equal(totals.tasks, 0);
  assert.deepEqual(kinds, [
    { kind: "connector", tools: 1, calls: 3, failed: 1, ms: 240, handedChars: 1200 },
    { kind: "collab", tools: 1, calls: 1, failed: 0, ms: 5000, handedChars: 0 },
  ]);
  assert.deepEqual(native, { tools: 2, calls: 4, failed: 1, ms: 913 }, "what was left out, so the page can say so");
});

test("the harness's copy of a call this app served is not counted again", () => {
  // Claude Code exports the mcp__codervibes__send_message it ran; mcp.js
  // recorded the same call as it served it. One call, one row of one.
  const spans = [
    toolSpan({ name: "send_message", kind: "collab", harness: "hn_1" }),
    toolSpan({ name: "send_message", kind: "collab" }),
  ];
  assert.equal(isMirror(spans[0]), true);
  assert.equal(isMirror(spans[1]), false);
  assert.equal(isMirror(toolSpan({ name: "github.create_issue", kind: "mcp", harness: "hn_1" })), false, "a server on the person's own list is only ever seen by the harness");
  const { tools } = fold({ spans, since: NOW - HOUR });
  assert.equal(tools.rows.length, 1);
  assert.equal(tools.rows[0].calls, 1);
});

test("the tasks give a tool what it was for and how those tasks came out, native tools left out", () => {
  const tasks = [
    task({ id: "t1", tools: [{ name: "read_file", kind: "builtin", calls: 4, failed: 0 }, { name: "github_open_pull", kind: "connector", calls: 1 }] }),
    task({ id: "t2", state: "failed", failure: "timeout", kind: "fix", tools: [{ name: "github_open_pull", kind: "connector", calls: 9, failed: 2 }] }),
    task({ id: "t3", state: "declined", tools: [{ name: "github_open_pull", calls: 1 }] }),
    // Still open: no verdict yet, so not counted.
    { id: "t4", repoId: "repo-1", state: "accepted", used: { tools: [{ name: "github_open_pull", calls: 1 }] } },
    // Closed with nothing on it: nothing to say.
    task({ id: "t5", tools: [] }),
    // Closed with only the harness's own tools on it: not a task with a tool on it.
    task({ id: "t6", tools: [{ name: "run_command", calls: 3 }] }),
    // The same id in another repo is another task.
    task({ id: "t1", repoId: "repo-2", tools: [{ name: "github_open_pull", calls: 1 }] }),
  ];
  const { tools } = fold({ tasks, since: NOW - HOUR });
  assert.deepEqual(tools.rows.map((row) => row.name), ["github_open_pull"]);
  const pull = tools.rows[0];
  assert.deepEqual(pull.tasks, { used: 4, done: 2, failed: 1, declined: 1, calls: 12, failedCalls: 2, kinds: { pr: 3, fix: 1 }, doneRate: 2 / 4 });
  assert.equal(pull.calls, 0, "no spans: the recent half is empty");
  assert.equal(pull.okRate, null);
  assert.equal(pull.msMedian, null);
  assert.equal(pull.kind, "connector", "the task's table names the kind when no span does");
  assert.equal(tools.totals.tasks, 4);
});

test("a connector is one row for the service, whichever tool asked, with its writes and its tools", () => {
  const spans = [
    connectorSpan({ id: "github", tool: "github_read", ms: 100 }),
    connectorSpan({ id: "github", tool: "github_read", ms: 300, session: "ses_2" }),
    connectorSpan({ id: "github", tool: "github_commit", write: true, ms: 500, ok: false, agent: ["ag_2", "Scout", "resident"] }),
    connectorSpan({ id: "linear", tool: "linear_issue", ms: 50 }),
    // Too old for the range.
    connectorSpan({ id: "linear", tool: "linear_issue", at: NOW - 2 * HOUR }),
    // Names no connector: not a row.
    { name: "connector.call", at: NOW, ms: 1, attrs: {} },
  ];
  const tasks = [
    task({ id: "t1", connectors: [{ id: "github", calls: 3, failed: 1 }] }),
    task({ id: "t2", state: "failed", connectors: [{ id: "github", calls: 1 }, { id: "linear", calls: 2 }] }),
  ];
  const { connectors } = fold({ spans, tasks, since: NOW - HOUR });
  assert.deepEqual(connectors.rows.map((row) => row.id), ["github", "linear"]);
  const [github, linear] = connectors.rows;
  assert.equal(github.calls, 3);
  assert.equal(github.failed, 1);
  assert.equal(github.okRate, 2 / 3);
  assert.equal(github.writes, 1);
  assert.equal(github.ms, 900);
  assert.equal(github.msMedian, 300);
  assert.equal(github.sessions, 2);
  assert.deepEqual(github.tools, [
    { name: "github_read", calls: 2, failed: 0 },
    { name: "github_commit", calls: 1, failed: 1 },
  ]);
  assert.deepEqual(github.agents.map((agent) => [agent.id, agent.calls, agent.failed]), [["ag_1", 2, 0], ["ag_2", 1, 1]]);
  assert.deepEqual(github.tasks, { used: 2, done: 1, failed: 1, declined: 0, calls: 4, failedCalls: 1, kinds: { pr: 2 }, doneRate: 1 / 2 });
  assert.equal(linear.calls, 1);
  assert.equal(linear.tasks.used, 1);
  assert.deepEqual(connectors.totals, { connectors: 2, calls: 4, failed: 1, writes: 1, ms: 950, tasks: 2 });
});

test("a skill is one row by name, with how it was reached; an unnamed use is counted as a line", () => {
  const spans = [
    skillSpan({ name: "codervibes-qa", via: "tool" }),
    skillSpan({ name: "codervibes-qa", via: "prompt", session: "ses_2" }),
    skillSpan({ name: "codervibes-qa", via: "file", ok: false, agent: ["ag_2", "Scout", "resident"] }),
    skillSpan({ name: "code-review", via: "tool" }),
    // A harness reporting by export alone: a skill ran, and nobody knows which.
    skillSpan({ name: null }),
    skillSpan({ name: null, at: NOW - 2 * HOUR }),
    // A via nobody knows is the Skill tool's.
    skillSpan({ name: "code-review", via: "telepathy" }),
  ];
  const tasks = [
    task({ id: "t1", skills: [{ name: "codervibes-qa", calls: 1 }] }),
    task({ id: "t2", state: "declined", skills: [{ name: "codervibes-qa", calls: 2 }, { name: "dataviz", calls: 1 }] }),
  ];
  const { skills } = fold({ spans, tasks, since: NOW - HOUR });
  assert.deepEqual(skills.rows.map((row) => row.name), ["codervibes-qa", "code-review", "dataviz"]);
  const [qa, review, viz] = skills.rows;
  assert.equal(qa.uses, 3);
  assert.equal(qa.failed, 1);
  assert.deepEqual(qa.via, { tool: 1, prompt: 1, file: 1 });
  assert.equal(qa.sessions, 2);
  assert.equal(qa.lastAt, NOW);
  assert.deepEqual(qa.agents.map((agent) => agent.id), ["ag_1", "ag_2"]);
  assert.deepEqual(qa.tasks, { used: 2, done: 1, failed: 0, declined: 1, calls: 3, failedCalls: 0, kinds: { pr: 2 }, doneRate: 1 / 2 });
  assert.deepEqual(review.via, { tool: 2, prompt: 0, file: 0 });
  assert.equal(viz.uses, 0, "on a task's table and in no span: the recent half is empty");
  assert.equal(viz.tasks.used, 1);
  assert.deepEqual(skills.totals, { skills: 3, uses: 5, unnamed: 1, sessions: 2, tasks: 2 });
});

test("the range cuts each half on its own clock", () => {
  const spans = [toolSpan({ name: "github_read", at: NOW - 2 * HOUR }), toolSpan({ name: "github_read", at: NOW })];
  const tasks = [
    task({ id: "old", tools: [{ name: "github_read", calls: 1 }], settledAt: new Date(NOW - 2 * HOUR).toISOString() }),
    task({ id: "new", tools: [{ name: "github_read", calls: 1 }] }),
  ];
  const { tools } = fold({ spans, tasks, since: NOW - HOUR });
  assert.equal(tools.rows[0].calls, 1);
  assert.equal(tools.rows[0].tasks.used, 1);
  // Spans that are not tool calls, or name no tool, are not rows.
  const none = fold({ spans: [{ name: "model.call", at: NOW, attrs: {} }, { name: "tool.call", at: NOW, attrs: {} }] });
  assert.equal(none.tools.rows.length, 0);
  assert.equal(none.connectors.rows.length, 0);
  assert.equal(none.skills.rows.length, 0);
});

test("a tool's tasks come back newest first with what the tool did on each", () => {
  const tasks = [
    task({ id: "a", tools: [{ name: "github_read", calls: 2, failed: 1 }], settledAt: "2026-09-01T00:00:00Z" }),
    task({ id: "b", state: "failed", failure: "timeout", tools: [{ name: "github_read", calls: 5 }], settledAt: "2026-09-03T00:00:00Z", repoId: "repo-2" }),
    task({ id: "c", tools: [{ name: "write_file", calls: 1 }], settledAt: "2026-09-04T00:00:00Z" }),
    { id: "d", repoId: "repo-1", state: "accepted", used: { tools: [{ name: "github_read", calls: 1 }] } },
  ];
  const rows = tasksUsing(tasks, "github_read", { since: 0 });
  assert.deepEqual(
    rows.map((row) => [row.id, row.repoId, row.state, row.failure, row.calls, row.failed]),
    [
      ["b", "repo-2", "failed", "timeout", 5, 0],
      ["a", "repo-1", "done", null, 2, 1],
    ],
  );
  assert.deepEqual(rows[0].to, { id: "ag_1", name: "Nomad" });
  assert.equal(rows[0].kind, "pr");
  assert.equal(tasksUsing(tasks, "github_read", { since: Date.parse("2026-09-02T00:00:00Z") }).length, 1);
  assert.equal(tasksUsing(tasks, "nope").length, 0);
});

test("a row keeps which sessions called it, and attribution says what those came to, closed ones first", () => {
  const spans = [
    connectorSpan({ id: "github", session: "ses_a", at: NOW - 5 * HOUR }),
    connectorSpan({ id: "github", session: "ses_b", at: NOW - 4 * HOUR }),
    connectorSpan({ id: "github", session: "ses_c", at: NOW - 3 * HOUR }),
    connectorSpan({ id: "github", session: "ses_c", at: NOW - 2 * HOUR }),
    connectorSpan({ id: "github", session: "ses_gone", at: NOW - HOUR }),
    connectorSpan({ id: "linear", session: "ses_b", at: NOW - HOUR }),
    skillSpan({ name: "code-review", session: "ses_a", at: NOW - HOUR }),
    toolSpan({ name: "send_message", kind: "collab", session: "ses_c", at: NOW - HOUR }),
  ];
  const { connectors, skills, tools } = fold({ spans, since: NOW - 24 * HOUR });
  assert.deepEqual(connectors.rows.map((row) => [row.id, row.sessionIds]), [["github", ["ses_a", "ses_b", "ses_c", "ses_gone"]], ["linear", ["ses_b"]]], "each session once, as the spans came");
  assert.deepEqual(skills.rows[0].sessionIds, ["ses_a"]);
  assert.deepEqual(tools.rows[0].sessionIds, ["ses_c"]);

  const sessions = new Map([
    ["ses_a", { id: "ses_a", title: "Fix the login bug", outcome: "merged", state: "ended", endedAt: NOW - 4 * HOUR }],
    ["ses_b", { id: "ses_b", title: "Rename the module", outcome: "open", state: "ended", endedAt: NOW - 3 * HOUR }],
    ["ses_c", { id: "ses_c", title: "Still going", outcome: "none", state: "live", endedAt: null, lastSeenAt: NOW }],
    // ses_gone is a session the caller no longer holds: counted as used, named nowhere.
  ]);
  const rows = attribute(connectors.rows, sessions);
  assert.deepEqual(rows.map((row) => row.id), ["github", "linear"], "most closed first");
  const github = rows[0];
  assert.ok(!("sessionIds" in github), "the ids were for the fold, not the page");
  assert.equal(github.sessionsUsed, 4, "every session that called it, known to the caller or not");
  assert.equal(github.sessionsClosed, 1);
  assert.equal(github.sessionsOpen, 1);
  assert.equal(github.closeRate, 0.25);
  assert.deepEqual(github.recent.map((session) => session.id), ["ses_a", "ses_b"], "closed first, then newest; a live session is counted and not named");
  assert.equal(rows[1].sessionsClosed, 0);
  assert.deepEqual(rows[1].recent.map((session) => session.id), ["ses_b"]);

  // The list of named sessions is short by design, and the closed ones win the places.
  const many = new Map();
  const ids = [];
  for (let i = 0; i < 12; i += 1) {
    const id = `ses_${i}`;
    ids.push(id);
    many.set(id, { id, outcome: i % 3 === 0 ? "merged" : "none", state: "ended", endedAt: NOW - i * HOUR });
  }
  const [row] = attribute([{ id: "x", sessionIds: ids }], many);
  assert.equal(row.recent.length, RECENT_SESSIONS);
  assert.deepEqual(row.recent.map((session) => session.id), ["ses_0", "ses_3", "ses_6", "ses_9", "ses_1"], "the four merges, then the newest of the rest");
  // Ties on closed fall to most used.
  const tied = attribute([{ id: "a", sessionIds: ["ses_1"] }, { id: "b", sessionIds: ["ses_1", "ses_2"] }], many);
  assert.deepEqual(tied.map((row) => row.id), ["b", "a"]);
});
