// What was reached for beyond the harness itself, across everybody.
//
// Every tool call an agent makes is a span (telemetry.js), and every closed
// task keeps a table of what it was done with (task-usage.js). Both are
// about one thing - one session, one task. What nobody could read off them
// was the question asked of the lot: which of the things we gave the agents
// do they actually use, which of those keep failing, and what the tasks that
// used them came to. That is what the Tools page is, and this is the fold
// behind it.
//
// Three tables, because "the things we gave the agents" are three kinds of
// thing. The **tools** are what an agent calls by name that is not its
// harness's own: this app's collaboration tools, a connector's tools, a
// server on the person's own MCP list, a vendor agent's tools. The
// **connectors** are the services behind those - "did GitHub answer, and how
// long did it take" is one question wherever the call came from
// (connectors/index.js puts a `connector.call` inside every tool call it
// serves). The **skills** are the files a harness loads for a way of working,
// which telemetry-ingest.js records as a `skill.use` when the Skill tool
// runs, when a person types one by name, or when a tool reads a SKILL.md.
//
// What is *not* a row is the harness's own tools: reading, editing, running
// a command, searching. Every session does thousands of those, and a table
// led by `read_file 40k calls` said nothing anyone came to the page to
// learn, while the connector used four times sat below the fold. They are
// summed into one line (`native`) so the page can say what it left out, and
// they stay on each session's own page where they belong.
//
// Two sources, deliberately, because they answer at different depths and
// last different lengths of time. The spans say what a call was - how long
// it took, whether it worked, how much it handed back, which agent made it -
// and are kept in memory for the last week (spans.js, replay.js). The tasks
// say what a tool was *for*: a tool used by forty tasks of which
// thirty-eight were delivered is a different thing from one used by forty
// that failed, and a task outlives its spans by a month or more. So a row is
// a thing as both see it, and the page is honest about which half each
// number came from.
//
// Counts and names only, like the tables it folds. A tool's arguments are
// what the agent typed.

/** How far back the page looks; the same ranges as Performance. */
const DAY = 24 * 60 * 60 * 1000;
export const RANGES = { "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY };
export const DEFAULT_RANGE = "7d";

/** Rows a listing keeps; a tool nobody has used forty times is not what the page is for. */
export const MAX_ROWS = 200;

/** Roughly how many characters one token is, for saying what a tool's output costs in context. */
export const CHARS_PER_TOKEN = 4;

/**
 * The harness's own tools, by the names this app gives them
 * (telemetry-ingest.js TOOL_NAMES, agentd.mjs CLAUDE_TOOLS) - and the
 * sandbox's, from when this app ran machines. A span of kind `harness` is
 * native whatever it is called; these names are for the spans that came
 * before kinds were reliable, and for a task's table, which names the tool
 * and not always its kind.
 */
export const NATIVE_TOOLS = new Set([
  "read_file", "write_file", "edit_file", "run_command", "search", "list_dir", "web_fetch", "web_search",
  "subagent", "todo", "recent_changes", "ensure_toolchain",
  "read", "edit", "multiedit", "write", "bash", "glob", "grep", "ls", "webfetch", "websearch", "task", "agent", "todowrite", "notebookedit",
  "skill",
]);

/**
 * What kind of tool a span or a task entry says it was, made consistent: a
 * tool the harness reported under another MCP server's name (`github.x`)
 * is that server's, not the harness's.
 */
export function kindOf(name, kind) {
  if (kind === "harness" && String(name).includes(".")) return "mcp";
  return kind ?? null;
}

/** Whether a tool is the harness's own - and so a line, not a row. */
export function isNative(name, kind) {
  const settled = kindOf(name, kind);
  if (settled === "harness") return true;
  if (settled === "builtin" || settled == null) return NATIVE_TOOLS.has(String(name).toLowerCase());
  return false;
}

/**
 * Whether a tool call is the harness's report of a call this app served
 * itself. Claude Code exports every tool it ran, this app's MCP tools
 * among them; mcp.js recorded the same call as it served it, with the
 * repo and the connector on it. One call, two spans - the harness's copy
 * is the one to leave out, since it knows less.
 *
 * Which copy is which is `cv.retroactive`, not `cv.harness.id`. A harness's
 * report is dated by the client's clock and marked for it (telemetry.js
 * `retroSpan`); the call this process served is not. The harness id read
 * as "the harness reported this" and is not that: a span *inherits* it
 * from the session's root (telemetry.js INHERITED), so the call mcp.js
 * served on a person's own setup carried it too, and both copies of every
 * such call were dropped. What that cost was the whole answer: the Tools
 * page listed this app's own tools for invited agents and for nobody else,
 * so a person whose agent had just used three of them read "no tools used".
 */
export function isMirror(span) {
  const attrs = span.attrs ?? {};
  return attrs["cv.tool.kind"] === "collab" && Boolean(attrs["cv.retroactive"]);
}

/** A closed task's state, as the page groups it. */
const outcomeOf = (task) => (task.state === "done" ? "done" : task.state === "failed" ? "failed" : task.state === "declined" ? "declined" : null);

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const emptyTasks = () => ({ used: 0, done: 0, failed: 0, declined: 0, calls: 0, failedCalls: 0, kinds: {} });

/** What a task's verdict adds to a row's task half. */
function countTask(row, task, outcome, entry) {
  row.tasks.used += 1;
  row.tasks[outcome] += 1;
  row.tasks.calls += Number(entry.calls) || 0;
  row.tasks.failedCalls += Number(entry.failed) || 0;
  const kind = task.outcome?.kind;
  if (kind) row.tasks.kinds[kind] = (row.tasks.kinds[kind] ?? 0) + 1;
}

/** Who made a call, added to a row's callers. */
function countAgent(row, attrs, failed) {
  const agentId = attrs["cv.agent.id"];
  if (!agentId) return;
  const agent = row.agents.get(agentId) ?? { id: agentId, name: attrs["cv.agent.name"] ?? agentId, kind: attrs["cv.agent.kind"] ?? null, calls: 0, failed: 0 };
  agent.calls += 1;
  if (failed) agent.failed += 1;
  row.agents.set(agentId, agent);
}

const settledAtOf = (task) => (task.settledAt ? Date.parse(task.settledAt) : 0);
const agentsOf = (row) => [...row.agents.values()].sort((a, b) => b.calls - a.calls);
const finishTasks = (tasks) => ({ ...tasks, doneRate: tasks.used ? tasks.done / tasks.used : null });

// -------------------------------------------------------------------- tools

function emptyTool(name, kind) {
  return {
    name,
    kind,
    calls: 0,
    failed: 0,
    ms: 0,
    durations: [],
    msMax: 0,
    sandboxMs: 0,
    handedChars: 0,
    agents: new Map(),
    sessions: new Set(),
    lastAt: 0,
    tasks: emptyTasks(),
  };
}

function foldTools(spans, tasks, since) {
  const rows = new Map();
  const native = { tools: new Set(), calls: 0, failed: 0, ms: 0 };
  const rowFor = (name, kind) => {
    let row = rows.get(name);
    if (!row) {
      row = emptyTool(name, kind ?? null);
      rows.set(name, row);
    }
    if (!row.kind && kind) row.kind = kind;
    return row;
  };

  for (const span of spans) {
    if (span.name !== "tool.call" || span.at < since) continue;
    const attrs = span.attrs ?? {};
    const name = attrs["cv.tool.name"];
    if (!name) continue;
    const failed = span.ok === false;
    const ms = Number(span.ms) || 0;
    const kind = kindOf(String(name), attrs["cv.tool.kind"] ?? span.kind ?? null);
    if (isNative(name, kind)) {
      native.tools.add(String(name));
      native.calls += 1;
      if (failed) native.failed += 1;
      native.ms += ms;
      continue;
    }
    if (isMirror(span)) continue;
    const row = rowFor(String(name), kind);
    row.calls += 1;
    if (failed) row.failed += 1;
    row.ms += ms;
    row.msMax = Math.max(row.msMax, ms);
    row.durations.push(ms);
    row.sandboxMs += Number(attrs["cv.sandbox.ms"]) || 0;
    row.handedChars += Number(attrs["cv.handed.chars"]) || 0;
    row.lastAt = Math.max(row.lastAt, span.at ?? 0);
    if (span.session) row.sessions.add(span.session);
    countAgent(row, attrs, failed);
  }

  const taskIds = new Set();
  for (const task of tasks) {
    const outcome = outcomeOf(task);
    if (!outcome || !task.used?.tools?.length || settledAtOf(task) < since) continue;
    for (const entry of task.used.tools) {
      if (!entry?.name || isNative(entry.name, entry.kind ?? null)) continue;
      countTask(rowFor(String(entry.name), kindOf(entry.name, entry.kind ?? null)), task, outcome, entry);
      // A task id is unique within its repo, not across them.
      taskIds.add(`${task.repoId}/${task.id}`);
    }
  }

  const byUse = (a, b) => b.calls + b.tasks.calls - (a.calls + a.tasks.calls) || a.name.localeCompare(b.name);
  const list = [...rows.values()].sort(byUse).slice(0, MAX_ROWS).map((row) => ({
    name: row.name,
    kind: row.kind,
    calls: row.calls,
    failed: row.failed,
    okRate: row.calls ? (row.calls - row.failed) / row.calls : null,
    ms: row.ms,
    msMedian: median(row.durations),
    msMax: row.msMax,
    sandboxMs: row.sandboxMs,
    handedChars: row.handedChars,
    handedTokens: Math.round(row.handedChars / CHARS_PER_TOKEN),
    agents: agentsOf(row),
    sessions: row.sessions.size,
    sessionIds: [...row.sessions],
    lastAt: row.lastAt || null,
    // Of the tasks that used it, how many were delivered - the tool's
    // company, not its doing; a tool on every task shares every failure.
    tasks: finishTasks(row.tasks),
  }));

  const kinds = new Map();
  for (const row of list) {
    const key = row.kind ?? "other";
    const group = kinds.get(key) ?? { kind: key, tools: 0, calls: 0, failed: 0, ms: 0, handedChars: 0 };
    group.tools += 1;
    group.calls += row.calls;
    group.failed += row.failed;
    group.ms += row.ms;
    group.handedChars += row.handedChars;
    kinds.set(key, group);
  }

  const totals = {
    tools: list.length,
    calls: list.reduce((sum, row) => sum + row.calls, 0),
    failed: list.reduce((sum, row) => sum + row.failed, 0),
    ms: list.reduce((sum, row) => sum + row.ms, 0),
    handedChars: list.reduce((sum, row) => sum + row.handedChars, 0),
    tasks: taskIds.size,
  };
  totals.handedTokens = Math.round(totals.handedChars / CHARS_PER_TOKEN);

  return {
    rows: list,
    totals,
    kinds: [...kinds.values()].sort((a, b) => b.calls - a.calls),
    native: { tools: native.tools.size, calls: native.calls, failed: native.failed, ms: native.ms },
  };
}

// --------------------------------------------------------------- connectors

function emptyConnector(id) {
  return { id, calls: 0, failed: 0, writes: 0, ms: 0, durations: [], msMax: 0, tools: new Map(), agents: new Map(), sessions: new Set(), lastAt: 0, tasks: emptyTasks() };
}

function foldConnectors(spans, tasks, since) {
  const rows = new Map();
  const rowFor = (id) => {
    let row = rows.get(id);
    if (!row) {
      row = emptyConnector(id);
      rows.set(id, row);
    }
    return row;
  };

  for (const span of spans) {
    if (span.name !== "connector.call" || span.at < since) continue;
    const attrs = span.attrs ?? {};
    const id = attrs["cv.connector.id"];
    if (!id) continue;
    const failed = span.ok === false;
    const ms = Number(span.ms) || 0;
    const row = rowFor(String(id));
    row.calls += 1;
    if (failed) row.failed += 1;
    if (attrs["cv.connector.write"] === true) row.writes += 1;
    row.ms += ms;
    row.msMax = Math.max(row.msMax, ms);
    row.durations.push(ms);
    row.lastAt = Math.max(row.lastAt, span.at ?? 0);
    if (span.session) row.sessions.add(span.session);
    const tool = attrs["cv.tool.name"];
    if (tool) {
      const entry = row.tools.get(String(tool)) ?? { name: String(tool), calls: 0, failed: 0 };
      entry.calls += 1;
      if (failed) entry.failed += 1;
      row.tools.set(String(tool), entry);
    }
    countAgent(row, attrs, failed);
  }

  const taskIds = new Set();
  for (const task of tasks) {
    const outcome = outcomeOf(task);
    if (!outcome || !task.used?.connectors?.length || settledAtOf(task) < since) continue;
    for (const entry of task.used.connectors) {
      if (!entry?.id) continue;
      countTask(rowFor(String(entry.id)), task, outcome, entry);
      taskIds.add(`${task.repoId}/${task.id}`);
    }
  }

  const byUse = (a, b) => b.calls + b.tasks.calls - (a.calls + a.tasks.calls) || a.id.localeCompare(b.id);
  const list = [...rows.values()].sort(byUse).slice(0, MAX_ROWS).map((row) => ({
    id: row.id,
    calls: row.calls,
    failed: row.failed,
    okRate: row.calls ? (row.calls - row.failed) / row.calls : null,
    writes: row.writes,
    ms: row.ms,
    msMedian: median(row.durations),
    msMax: row.msMax,
    tools: [...row.tools.values()].sort((a, b) => b.calls - a.calls),
    agents: agentsOf(row),
    sessions: row.sessions.size,
    sessionIds: [...row.sessions],
    lastAt: row.lastAt || null,
    tasks: finishTasks(row.tasks),
  }));

  return {
    rows: list,
    totals: {
      connectors: list.length,
      calls: list.reduce((sum, row) => sum + row.calls, 0),
      failed: list.reduce((sum, row) => sum + row.failed, 0),
      writes: list.reduce((sum, row) => sum + row.writes, 0),
      ms: list.reduce((sum, row) => sum + row.ms, 0),
      tasks: taskIds.size,
    },
  };
}

// ------------------------------------------------------------------- skills

/** How a skill came to be loaded - see telemetry-ingest.js `skillOfTool`. */
export const SKILL_VIAS = ["tool", "prompt", "file"];

function emptySkill(name) {
  return { name, uses: 0, failed: 0, via: { tool: 0, prompt: 0, file: 0 }, agents: new Map(), sessions: new Set(), lastAt: 0, tasks: emptyTasks() };
}

function foldSkills(spans, tasks, since) {
  const rows = new Map();
  let unnamed = 0;
  const rowFor = (name) => {
    let row = rows.get(name);
    if (!row) {
      row = emptySkill(name);
      rows.set(name, row);
    }
    return row;
  };

  for (const span of spans) {
    if (span.name !== "skill.use" || span.at < since) continue;
    const attrs = span.attrs ?? {};
    const name = attrs["cv.skill.name"];
    if (!name) {
      // A harness reporting by export alone says a skill ran and not which
      // - the hooks the setup script installs are what name it.
      unnamed += 1;
      continue;
    }
    const failed = span.ok === false;
    const row = rowFor(String(name));
    row.uses += 1;
    if (failed) row.failed += 1;
    const via = SKILL_VIAS.includes(attrs["cv.skill.via"]) ? attrs["cv.skill.via"] : "tool";
    row.via[via] += 1;
    row.lastAt = Math.max(row.lastAt, span.at ?? 0);
    if (span.session) row.sessions.add(span.session);
    countAgent(row, attrs, failed);
  }

  const taskIds = new Set();
  for (const task of tasks) {
    const outcome = outcomeOf(task);
    if (!outcome || !task.used?.skills?.length || settledAtOf(task) < since) continue;
    for (const entry of task.used.skills) {
      if (!entry?.name) continue;
      countTask(rowFor(String(entry.name)), task, outcome, entry);
      taskIds.add(`${task.repoId}/${task.id}`);
    }
  }

  const byUse = (a, b) => b.uses + b.tasks.calls - (a.uses + a.tasks.calls) || a.name.localeCompare(b.name);
  const list = [...rows.values()].sort(byUse).slice(0, MAX_ROWS).map((row) => ({
    name: row.name,
    uses: row.uses,
    failed: row.failed,
    via: row.via,
    agents: agentsOf(row),
    sessions: row.sessions.size,
    sessionIds: [...row.sessions],
    lastAt: row.lastAt || null,
    tasks: finishTasks(row.tasks),
  }));

  const sessions = new Set();
  for (const row of rows.values()) for (const session of row.sessions) sessions.add(session);

  return {
    rows: list,
    totals: {
      skills: list.length,
      uses: list.reduce((sum, row) => sum + row.uses, 0),
      unnamed,
      sessions: sessions.size,
      tasks: taskIds.size,
    },
  };
}

// ---------------------------------------------------------------- the fold

/**
 * Fold the spans and the tasks of a range into the three tables.
 *
 * `spans` are span records (spans.js): `tool.call`, `connector.call` and
 * `skill.use` count, each since `since`. `tasks` are task records with
 * `used` on them (closed tasks; a live one has no table yet), each with
 * `repoId`; those settled since `since` count.
 *
 * @returns {{ tools: object, connectors: object, skills: object }} each
 *   `{ rows, totals }`; `tools` also has `kinds` (the rows grouped by what
 *   kind of tool) and `native` (what was left out, summed)
 */
export function fold({ spans = [], tasks = [], since = 0 } = {}) {
  return {
    tools: foldTools(spans, tasks, since),
    connectors: foldConnectors(spans, tasks, since),
    skills: foldSkills(spans, tasks, since),
  };
}

/**
 * The tasks behind one tool's row, for its page: each with what the tool
 * did on it and what the task came to. Newest first.
 */
export function tasksUsing(tasks, name, { since = 0 } = {}) {
  const out = [];
  for (const task of tasks) {
    const outcome = outcomeOf(task);
    if (!outcome) continue;
    if (settledAtOf(task) < since) continue;
    const entry = (task.used?.tools ?? []).find((row) => row.name === name);
    if (!entry) continue;
    out.push({
      id: task.id,
      repoId: task.repoId,
      title: task.title,
      state: task.state,
      failure: task.failure ?? null,
      kind: task.outcome?.kind ?? null,
      to: task.to ? { id: task.to.id, name: task.to.name } : null,
      settledAt: task.settledAt,
      calls: Number(entry.calls) || 0,
      failed: Number(entry.failed) || 0,
    });
  }
  return out.sort((a, b) => String(b.settledAt).localeCompare(String(a.settledAt)));
}

// ------------------------------------------------------------ attributing

/** How many of a row's sessions the page names; the rest are a count. */
export const RECENT_SESSIONS = 5;

/**
 * What a row's sessions came to, and which of them to name.
 *
 * A row knows which sessions called it (`sessionIds`, from the spans). The
 * caller knows what those sessions were - their outcome, their title,
 * who was working - and hands them in by id. Out comes the row with
 * `sessionsUsed` (every session that called it, known or not),
 * `sessionsClosed` (those whose pull request merged) and `recent`: the
 * newest ended sessions, closed ones first, so a page can say "GitHub was
 * in the room for these nine merges, here are the last five". A live
 * session is counted and not named - it has not come to anything yet.
 *
 * Rows come back most closed first, then most used: the page is for
 * finding what has been getting work over the line, and a connector that
 * was there for nine merges belongs above one that was called more often
 * on work that went nowhere.
 *
 * @param {object[]} rows a fold's rows, each with `sessionIds`
 * @param {Map<string, object>} sessions id -> a session as described for
 *   the page: `{ id, title, actor, outcome, state, endedAt, ... }`
 */
export function attribute(rows, sessions, { limit = RECENT_SESSIONS } = {}) {
  const out = rows.map((row) => {
    const { sessionIds = [], ...rest } = row;
    const known = sessionIds.map((id) => sessions.get(id)).filter(Boolean);
    const closed = known.filter((session) => session.outcome === "merged");
    const ended = known.filter((session) => session.state !== "live");
    const endedAt = (session) => session.endedAt ?? session.lastSeenAt ?? session.startedAt ?? 0;
    const recent = ended
      .sort((a, b) => (b.outcome === "merged") - (a.outcome === "merged") || endedAt(b) - endedAt(a))
      .slice(0, limit);
    return {
      ...rest,
      sessionsUsed: sessionIds.length,
      sessionsClosed: closed.length,
      sessionsOpen: known.filter((session) => session.outcome === "open").length,
      closeRate: sessionIds.length ? closed.length / sessionIds.length : null,
      recent,
    };
  });
  return out.sort((a, b) => b.sessionsClosed - a.sessionsClosed || b.sessionsUsed - a.sessionsUsed || 0);
}
