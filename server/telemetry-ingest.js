// What a harness on somebody's laptop sends here, read into sessions.
//
// Claude Code, told to (`CLAUDE_CODE_ENABLE_TELEMETRY=1` and an OTLP
// endpoint - harnesses.js `connect` prints the block), exports its events
// as OpenTelemetry logs: a prompt was given, a tool ran, a model was
// called. Pointed at this app with a harness token, those events land at
// `/otlp/v1/logs` and become the same spans a resident's work becomes -
// `tool.call`, `model.call`, `skill.use` - filed under a session of kind
// `harness`, so a person's own terminal ranks on the Performance page
// beside the residents, by the same counts.
//
// **Content, not only counts.** This used to keep counts alone - a tool's
// name and how long it took, a prompt's length - on the ground that a
// session is everyone's to read and what a person typed is not. A timeline
// of "edit_file · 12ms · ok" turned out to say nothing worth opening the
// page for. So what a harness sends is kept: the prompt when the export
// carries it (the setup script asks for it), a Bash command, an error's
// message. Who may read it is the same rule a resident's session already
// has (index.js `/api/sessions/:id`): the owner and the people on the repo
// see everything a span carries, anybody else the countable attributes
// (spans.js COUNTABLE_ATTRS) - so the content is private by that list,
// not by being thrown away at the door. What is still dropped is
// identity: the `user.email` on every event says nothing the token does
// not, and is not written anywhere.
//
// The events name a session (`session.id`, Claude Code's own) and a prompt
// (`prompt.id`); they name no repository, and they never say which file a
// tool read or what the model answered. All of that comes from the hooks
// the setup script installs, which post each event whole to
// `/api/harness/session` - `noteHook` - where it becomes the session's
// transcript (session-events.js), the repository that lets a pull request
// on the branch find the session (pulls.js `sessionOnBranch`), and the
// files the work landed on.
//
// The format is OTLP/JSON as the collector spec writes it: resources hold
// scopes hold records, attributes are `{key, value: {stringValue|intValue|
// doubleValue|boolValue}}`, times are nanoseconds as strings. Metrics are
// accepted and counted, not read: what they say - lines of code, cost,
// commits - is already in the events or in the pull requests.
//
// **A gateway's traces.** A LiteLLM proxy exports OpenTelemetry too
// (`litellm_request` spans, attributes in the GenAI convention), and
// pointed here with a harness token they are read two ways. A span whose
// parent is a `model.call` this app made - the proxy honoured the
// `traceparent` inference.js sent - is the same call seen from the other
// side: it is filed under ours as `gateway.call`, saying which model the
// proxy actually routed to and what it charged, and not counted again.
// A span with no parent here is a call something else made through the
// proxy - an engineer's own harness, a script - and becomes a `model.call`
// in a session of its own, keyed by the proxy's `user` (or its key alias),
// so that spend and those models rank beside everyone else's. OpenRouter
// exports nothing; what a call through it cost is on the answer, and
// inference.js keeps it there.
import { retroSpan, traceIdFor } from "./telemetry.js";
import * as sessionLog from "./sessions.js";
import * as sessionEvents from "./session-events.js";
import * as spans from "./spans.js";
import { costs } from "./costs.js";
import { heardToolResult } from "./pull-opened.js";
import { repos } from "./repos.js";
import { parseRemote } from "./git-hosts/index.js";
import * as guidance from "./guidance.js";
import * as ingestToken from "./ingest-token.js";
import { classify, KINDS as STEER_KINDS } from "./steer-kinds.js";
import * as friction from "./friction.js";
import { linesOfEdit, hashesOf } from "./attribution.js";

export class IngestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** The attributes that say who, which the token already says - never recorded. Content is kept; see the essay. */
export const NEVER_RECORDED = ["user.email", "user.id", "user.account_uuid", "organization.id"];

/** How much of a prompt, a command or an error one span keeps. A span is a line on a timeline, not a transcript. */
export const MAX_SPAN_TEXT = 2000;

const cut = (value, max = MAX_SPAN_TEXT) => {
  if (value == null) return undefined;
  const text = String(value);
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/**
 * A cost somebody else reported, in cents, or null when they did not.
 *
 * Every vendor here writes dollars - Claude Code's `cost_usd`, LiteLLM's
 * `llm.response_cost`, OpenRouter's `usage.cost` - and everything downstream
 * of this file counts in cents (costs.js, models.js `priceOf`), so the
 * conversion happens once, here. A figure that is not a non-negative number
 * is nobody saying: nought is free and null is unknown, and the difference
 * is the whole point of keeping the reported figure at all.
 */
export function centsOf(dollars) {
  if (dollars == null || dollars === "") return null;
  const value = Number(dollars);
  if (!Number.isFinite(value) || value < 0) return null;
  // Four decimal places of a cent: a cheap call is thousandths of one, and
  // a hundred of them a day should not round away to nothing.
  return Math.round(value * 100 * 10_000) / 10_000;
}

/**
 * What a tool was handed, as one line, from Claude Code's `tool_parameters`
 * - a JSON string it writes for some tools: a Bash command, an MCP server
 * and tool. Anything else it may carry tomorrow is kept as it came.
 */
export function toolArgsOf(parameters) {
  if (parameters == null) return undefined;
  const text = String(parameters);
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      if (parsed.full_command ?? parsed.bash_command) return cut(parsed.full_command ?? parsed.bash_command);
      if (parsed.mcp_server || parsed.mcp_tool) return cut([parsed.mcp_server, parsed.mcp_tool].filter(Boolean).join(" · "));
      const rest = Object.entries(parsed).filter(([, value]) => value != null && value !== "");
      return rest.length ? cut(rest.map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`).join(" · ")) : undefined;
    }
  } catch {
    // Not JSON: whatever it is, it is what the tool was handed.
  }
  return cut(text);
}

/** Claude Code's own tool names, as this app's spans name them - the loop's table (agentd.mjs `CLAUDE_TOOLS`), plus the rest. */
const TOOL_NAMES = {
  Read: "read_file",
  Edit: "edit_file",
  MultiEdit: "edit_file",
  Write: "write_file",
  Bash: "run_command",
  Glob: "search",
  Grep: "search",
  LS: "list_dir",
  WebFetch: "web_fetch",
  WebSearch: "web_search",
  Task: "subagent",
  Agent: "subagent",
  TodoWrite: "todo",
  NotebookEdit: "edit_file",
};
const MCP_PREFIX = "mcp__codervibes__";

/**
 * What kind of tool the harness ran, from its name: this app's own
 * (`collab` - mcp.js and mcp-local.js record the same call with more on it
 * as they serve it, so the export's copy of one of these is not kept at
 * all), a server on the person's own MCP list (`mcp`), or the harness's own
 * reading, editing and running (`harness`).
 */
export function toolKindOf(name) {
  const text = String(name ?? "");
  if (text.startsWith(MCP_PREFIX)) return "collab";
  if (text.startsWith("mcp__")) return "mcp";
  return "harness";
}

/**
 * The name Claude Code's export gives every MCP call, whichever server and
 * whichever tool it was: `mcp_tool`, and nothing else on the event to say
 * more (2.1.272, checked against a real session's export).
 *
 * Taken at face value that is a tool called `mcp_tool` that the harness runs
 * itself - `harness` kind, native - so every call an agent made to a server
 * on its MCP list, this app's own tools included, was summed into the native
 * line and the Tools page could not name one of them. The page whose whole
 * question is "which of the things we gave the agents do they use" answered
 * "none" for the things we gave them.
 *
 * The hooks do say: PreToolUse carries `mcp__codervibes__discover` in
 * `tool_name`. So a generic export is renamed from the hook that announced
 * the same call (`mcpNamed`), and the span is the tool the agent called.
 */
const GENERIC_MCP_TOOL = "mcp_tool";

/**
 * MCP calls the hooks named, per session, kept until the export's copy of
 * the same call arrives - which is seconds later, in the next batch, and so
 * after the `done` hook has already closed the call in `openCalls`.
 *
 * Bounded twice: fifty per session, and nothing older than the window. A
 * name nobody claims is dropped rather than kept for a call that is never
 * coming.
 */
const mcpCalls = new Map();

/**
 * How far apart the hook's moment and the export's start may be and still be
 * the same call. The hook fires as the call is made and the export dates it
 * by `at - duration_ms`; the two agree to well under a second when both
 * clocks are this machine's, and this is wide enough for a spooled backlog
 * shipped by a laptop whose clock drifted.
 */
const MCP_MATCH_MS = 30_000;

function noteMcpCall(session, tool, at) {
  const mine = (mcpCalls.get(session) ?? []).filter((call) => at - call.at <= MCP_MATCH_MS);
  mine.push({ tool, at });
  mcpCalls.set(session, mine.slice(-50));
}

/**
 * The hook's name for the MCP call that started at `startedAt`, consumed so
 * two exports cannot both claim one hook. Nearest start wins: a session runs
 * its calls one after another, and "nearest" is what keeps two calls of the
 * same tool in the order they were made.
 */
function mcpNamed(session, startedAt) {
  const mine = mcpCalls.get(session);
  if (!mine?.length) return null;
  let best = -1;
  for (let index = 0; index < mine.length; index += 1) {
    const away = Math.abs(mine[index].at - startedAt);
    if (away > MCP_MATCH_MS) continue;
    if (best < 0 || away < Math.abs(mine[best].at - startedAt)) best = index;
  }
  if (best < 0) return null;
  const [call] = mine.splice(best, 1);
  if (!mine.length) mcpCalls.delete(session);
  return call.tool;
}

/**
 * What the export's tool was really called. Everything but an MCP call is
 * already named; one of those is `mcp_tool` and is named by the hook that
 * announced it, or by the parameters when the harness wrote them (an older
 * Claude Code puts `mcp_server` and `mcp_tool` in `tool_parameters`).
 *
 * A call neither names stays `mcp_tool` and stays in the native line: a row
 * called `mcp_tool` on the Tools page would be a row nobody can act on, and
 * an installation whose harnesses report no hooks has nothing here to say
 * which server was asked.
 */
function exportedToolName(record, attrs, startedAt) {
  const name = String(attrs.tool_name ?? "");
  if (name !== GENERIC_MCP_TOOL) return name;
  const said = parametersName(attrs.tool_parameters);
  return said ?? mcpNamed(record.id, startedAt) ?? name;
}

/** `{"mcp_server":"codervibes","mcp_tool":"discover"}` as the harness's own name for it. */
function parametersName(parameters) {
  if (parameters == null) return null;
  try {
    const parsed = JSON.parse(String(parameters));
    if (parsed?.mcp_server && parsed?.mcp_tool) return `mcp__${parsed.mcp_server}__${parsed.mcp_tool}`;
  } catch {
    // Not JSON, so it says nothing about which server was asked.
  }
  return null;
}

// ------------------------------------------------------------------ skills
//
// A skill is a file the harness loads for a way of working - a SKILL.md
// under .claude/skills, .codex/skills, .agents/skills - and nothing in a
// harness's export says which one. Three things do, and each becomes a
// `skill.use` span named for the skill and marked with how it was reached
// (`cv.skill.via`):
//
//   `tool` - Claude Code's Skill tool (Gemini CLI's activate_skill), whose
//   input names the skill. The PreToolUse hook has the input whole; the
//   export's tool_result has it as `tool_parameters` when the version
//   writes them, and not otherwise.
//
//   `prompt` - a person typed it by name, `/code-review --fix`, which
//   reaches the model as the skill's text and runs no tool at all. Both the
//   UserPromptSubmit hook and the export's user_prompt carry the words.
//
//   `file` - a tool read the skill's file: a Read of SKILL.md, a `cat` of
//   it in a shell. What a harness without a Skill tool does, and what a
//   subagent does with a skill it was handed.
//
// The hooks and the export both see the first two, so a session whose
// hooks are reporting (`hooked`) has its skills named by the hooks alone
// and the export's copy is dropped - the hook fires before the tool runs
// and the export arrives after, so by the time the export's copy lands the
// hook's has been recorded. A session reporting by export alone still gets
// a `skill.use`, named when the export names it and not otherwise; the
// Tools page counts the unnamed ones as a line, not a row.

/**
 * Claude Code's own slash commands, which are typed like a skill and are
 * not one. A first guess at the list; a name missing from it is one skill
 * row nobody recognises, which is easier to notice than a skill never
 * counted.
 */
export const BUILTIN_COMMANDS = new Set([
  "add-dir", "agents", "bug", "clear", "compact", "config", "context", "cost", "doctor", "exit", "export", "fast", "help", "hooks",
  "ide", "install-github-app", "login", "logout", "mcp", "memory", "model", "output-style", "permissions", "plugin", "privacy-settings",
  "quit", "release-notes", "rename", "resume", "rewind", "stats", "status", "statusline", "tasks", "terminal-setup", "theme", "upgrade",
  "usage", "vim", "workflows", "artifacts",
]);

/** The skill a prompt names, if it starts with one: `/code-review --fix` is `code-review`. Null for words and for the harness's own commands. */
export function skillOfPrompt(text) {
  const match = /^\/([a-z0-9][a-z0-9_:.-]*)(?=\s|$)/i.exec(String(text ?? "").trim());
  if (!match) return null;
  const name = match[1].toLowerCase().replace(/[.:]+$/, "");
  return name && !BUILTIN_COMMANDS.has(name) ? name : null;
}

const SKILL_TOOLS = new Set(["Skill", "activate_skill"]);
const SKILL_FILE = /skills\/([^\s/"'`]+)\/SKILL\.md\b/i;
const COMMAND_FILE = /\.claude\/commands\/([^\s/"'`]+)\.md\b/;

/**
 * The skill a tool call is, if it is one, with how it was reached: the
 * Skill tool by its input (`tool`), or any tool handed a skill's file
 * (`file`). Null for a tool that is neither. A Skill call whose input names
 * nothing is still a skill, unnamed.
 */
export function skillOfTool(tool, input) {
  const args = input && typeof input === "object" ? input : {};
  if (SKILL_TOOLS.has(String(tool ?? ""))) {
    const name = String(args.skill ?? args.name ?? args.skill_name ?? "").trim().toLowerCase();
    return { name: name || null, via: "tool" };
  }
  const text = Object.values(args).filter((value) => typeof value === "string").join("\n");
  const file = SKILL_FILE.exec(text) ?? COMMAND_FILE.exec(text);
  return file ? { name: file[1].toLowerCase(), via: "file" } : null;
}

/** The skill named in the export's `tool_parameters` for a Skill call - a JSON string, when the version writes one. */
function skillOfParameters(parameters) {
  if (parameters == null) return null;
  try {
    const parsed = JSON.parse(String(parameters));
    return skillOfTool("Skill", parsed)?.name ?? null;
  } catch {
    return null;
  }
}

/** The sessions whose hooks are reporting, so the export's copy of a skill is not counted twice. Memory only: the next hook sets it again. */
const hooked = new Set();

/** One skill loaded, as a span on the session. */
function skillSpan(record, { name, via, tool, at, ms = 0, ok = true, promptId = null }) {
  retroSpan({
    parent: parentFor(record, promptId),
    name: "skill.use",
    startTime: at - ms,
    endTime: at,
    attrs: {
      ...inheritedOf(record),
      "cv.tool.name": tool,
      "cv.tool.ok": ok,
      "cv.skill.name": name ?? undefined,
      "cv.skill.via": via,
    },
  });
}

/** How many events one request may carry; more is a misconfigured exporter, not a session. */
export const MAX_RECORDS = 5000;

// ----------------------------------------------------------------- reading

/** One OTLP attribute value, as a plain value. */
function valueOf(value) {
  if (value == null || typeof value !== "object") return value ?? null;
  if ("stringValue" in value) return String(value.stringValue);
  if ("intValue" in value) return Number(value.intValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("boolValue" in value) return Boolean(value.boolValue);
  if ("arrayValue" in value) return (value.arrayValue?.values ?? []).map(valueOf);
  return null;
}

/** An OTLP attribute list as an object, with what is never recorded already gone. */
export function attributesOf(list) {
  const out = {};
  for (const entry of Array.isArray(list) ? list : []) {
    const key = String(entry?.key ?? "");
    if (!key || NEVER_RECORDED.includes(key)) continue;
    out[key] = valueOf(entry.value);
  }
  return out;
}

/** Nanoseconds since the epoch, as a string or number, to milliseconds. */
const msOf = (nanos, fallback = Date.now()) => {
  const n = Number(nanos);
  return Number.isFinite(n) && n > 0 ? Math.round(n / 1e6) : fallback;
};

/** Every log record in an OTLP/JSON logs payload, flattened. */
export function logRecordsOf(body) {
  const out = [];
  for (const resource of body?.resourceLogs ?? []) {
    for (const scope of resource?.scopeLogs ?? []) {
      for (const record of scope?.logRecords ?? []) {
        if (out.length >= MAX_RECORDS) return out;
        out.push(record);
      }
    }
  }
  return out;
}

/** Every span in an OTLP/JSON traces payload, flattened. */
export function spansOf(body) {
  const out = [];
  for (const resource of body?.resourceSpans ?? []) {
    for (const scope of resource?.scopeSpans ?? []) {
      for (const span of scope?.spans ?? []) {
        if (out.length >= MAX_RECORDS) return out;
        out.push(span);
      }
    }
  }
  return out;
}

/** How many data points a metrics payload carries - all that is read of it. */
export function metricPointsOf(body) {
  let n = 0;
  for (const resource of body?.resourceMetrics ?? []) {
    for (const scope of resource?.scopeMetrics ?? []) {
      for (const metric of scope?.metrics ?? []) {
        const series = metric?.sum ?? metric?.gauge ?? metric?.histogram ?? null;
        n += series?.dataPoints?.length ?? 0;
      }
    }
  }
  return n;
}

/** A trace or span id as OTLP/JSON writes it - hex, or base64 from an older exporter - as hex. */
function idOf(value, length) {
  const text = String(value ?? "");
  if (new RegExp(`^[0-9a-f]{${length}}$`, "i").test(text)) return text.toLowerCase();
  try {
    const hex = Buffer.from(text, "base64").toString("hex");
    return hex.length === length ? hex : null;
  } catch {
    return null;
  }
}

/** A span id for a prompt: the half of its hash the trace id does not use. */
const spanIdFor = (key) => traceIdFor(`span:${key}`).slice(0, 16);

// ---------------------------------------------------------------- sessions

/**
 * The session a harness's events belong on: the one with this key - live,
 * or ended and taken back live when what arrived happened after the end
 * (sessions.js `byKey`; `revive: false` never takes one back) - or a new
 * one, unless `open: false`, when nothing known is null: metrics say which
 * session they are about but are no reason to start one.
 *
 * Keyed by harness and the harness's own session id, so two
 * terminals with the same Claude Code session id on two harnesses are two
 * sessions, and one restart of this process is not a new session.
 *
 * Whose the session is: the agent the harness reports for, when it names
 * one (harnesses.js, the essay) - so the row on the Activity page, the pull
 * request that comes of it and the cost of its model calls are the agent's,
 * the same agent whose MCP calls arrive here on its own token. A harness
 * that names no agent is the actor itself.
 */
export async function sessionFor({ user, harness }, harnessSessionId, { at = Date.now(), revive = true, open = true } = {}) {
  const key = `${harness.id}:${harnessSessionId || "unnamed"}`;
  const found = await sessionLog.byKey(key, { owner: user, at, revive });
  if (found) return found;
  if (!open) return null;
  return sessionLog.open({
    kind: "harness",
    owner: user,
    actor: harness.agent
      ? { kind: "agent", id: harness.agent.id, name: harness.agent.name ?? harness.name }
      : { kind: "harness", id: harness.id, name: harness.name },
    harness: { id: harness.id, kind: harness.kind },
    // A machine's token (machine-reporting.js) says where the work was
    // done; a laptop's never can.
    machine: harness.machine ?? null,
    key,
    at,
  });
}

/** The attributes every span of a session carries; a retroactive span has no parent in memory to inherit them from. */
function inheritedOf(record) {
  return {
    "cv.session.id": record.id,
    "cv.agent.id": record.actor.id,
    "cv.agent.name": record.actor.name,
    "cv.agent.kind": record.kind,
    "cv.owner": record.owner,
    "cv.harness.id": record.harness?.id,
    "cv.harness.kind": record.harness?.kind,
    // Which repo, and which repository, the work was for - what a listing
    // scopes by (index.js spansInScope). The start hook sets both before
    // any span arrives; a span before it carries neither.
    "cv.repo.id": record.repoId ?? undefined,
    "cv.repo": record.repo?.fullName ?? undefined,
  };
}

/** The parent a prompt's spans hang under: a trace per prompt, a session-wide one when the event names none. */
function parentFor(record, promptId) {
  const key = promptId ? `prompt:${promptId}` : `session:${record.id}`;
  return { traceId: traceIdFor(key), spanId: spanIdFor(key) };
}

/** This app's name for a Claude Code tool. */
export function toolNameOf(name) {
  const text = String(name ?? "");
  if (text.startsWith(MCP_PREFIX)) return text.slice(MCP_PREFIX.length);
  if (text.startsWith("mcp__")) return text.replace(/^mcp__/, "").replace(/__/, ".");
  return TOOL_NAMES[text] ?? text.toLowerCase();
}

// ------------------------------------------------------------------ events

/**
 * One Claude Code event into the session. Returns what it became, for the
 * response and the tests: a span name, or null for one that is heard and
 * kept only as "the session is alive".
 */
async function fold(who, record, event) {
  const attrs = event.attrs;
  const at = event.at;
  const parent = parentFor(record, attrs["prompt.id"]);
  const inherited = inheritedOf(record);
  const ms = Math.max(0, Number(attrs.duration_ms ?? 0));
  switch (event.name) {
    case "claude_code.user_prompt": {
      // A person typed: the clearest steering signal there is - counted
      // once, by whichever of the two roads this session is on. A Claude
      // Code set up by `setup.sh` reports the same keystroke twice, as a
      // hook (which lands first, milliseconds after the Enter) and again in
      // this export five seconds later; counting both would double every
      // laptop session's steering. The hook is the better road - it knows
      // the turn's status, so it can tell a cut short from a follow-up - so
      // when it is reporting, this one only keeps the words.
      if (!hooked.has(record.id)) guidance.prompted(record.id, { at });
      // The first prompt is what the session is for. Its id and the person;
      // the words go on the turn's span below, when the export carries them
      // - and its first line becomes the session's name (sessions.js).
      sessionLog.noteTrigger(record.id, {
        kind: "prompt", id: attrs["prompt.id"] ?? null, key: null,
        by: { kind: "person", id: who.user ?? null, name: null }, at,
      });
      if (attrs.prompt) sessionLog.noteTitle(record.id, attrs.prompt);
      retroSpan({
        parent: { traceId: parent.traceId, spanId: parent.spanId },
        name: "agent.turn",
        startTime: at,
        endTime: at,
        attrs: { ...inherited, "cv.prompt.chars": Number(attrs.prompt_length ?? 0) || undefined, "cv.prompt.text": cut(attrs.prompt) },
      });
      // A skill typed by name is a skill used - unless this session's hooks
      // are reporting, in which case they said so already.
      const typed = hooked.has(record.id) ? null : skillOfPrompt(attrs.prompt);
      if (typed) skillSpan(record, { name: typed, via: "prompt", tool: "prompt", at, promptId: attrs["prompt.id"] });
      return "agent.turn";
    }
    case "claude_code.tool_result": {
      // What it was called, which for an MCP call the export does not say
      // and the hook does (`exportedToolName`). Read before anything else
      // here, because the name is also what decides the kind.
      const named = exportedToolName(record, attrs, at - ms);
      const tool = toolNameOf(named);
      const isSkill = SKILL_TOOLS.has(String(attrs.tool_name));
      const ok = attrs.success == null ? true : Boolean(attrs.success);
      if (isSkill && hooked.has(record.id)) {
        // The hook recorded this skill, by name, before it ran.
        sessionLog.touch(record.id, at);
        return null;
      }
      if (!isSkill && toolKindOf(named) === "collab" && hooked.has(record.id)) {
        // A call to one of this app's own tools, on a session the hooks are
        // reporting - so this app served the call and recorded it *on this
        // same session* as it did (mcp.js and mcp-local.js join the call to
        // the session whose hook announced it), with the repo, the task and
        // whether the tool refused on it, none of which the export knows.
        // Two spans for one call, and the two pages that count them
        // disagreed: the Tools page dropped this copy (tool-stats.js
        // `isMirror`) and the session's own counts kept both, so a session
        // that made three MCP calls wore a chip saying five tool calls.
        //
        // Dropped here rather than filtered on the way out, because a span
        // nothing should ever count is a span not worth keeping: the one
        // that stays is the one that knows more.
        //
        // Only with the hooks, because they are what makes the two copies
        // land on one session. A harness that exports and does not hook has
        // its MCP calls recorded against the endpoint's own connection
        // record, and this copy is the only one this session will ever see.
        sessionLog.touch(record.id, at);
        return null;
      }
      retroSpan({
        parent,
        name: isSkill ? "skill.use" : "tool.call",
        startTime: at - ms,
        endTime: at,
        attrs: {
          ...inherited,
          "cv.tool.name": tool,
          "cv.tool.kind": toolKindOf(named),
          "cv.tool.ok": ok,
          "cv.tool.args": toolArgsOf(attrs.tool_parameters),
          "cv.tool.decision": attrs.decision_source ?? undefined,
          "cv.tool.error": ok ? undefined : attrs.error_type ?? undefined,
          "cv.tool.message": ok ? undefined : cut(attrs.error),
          ...(isSkill ? { "cv.skill.name": skillOfParameters(attrs.tool_parameters) ?? undefined, "cv.skill.via": "tool" } : {}),
        },
      });
      return isSkill ? "skill.use" : "tool.call";
    }
    case "claude_code.api_request": {
      const tokens = {
        input: Number(attrs.input_tokens ?? 0) || 0,
        output: Number(attrs.output_tokens ?? 0) || 0,
        cacheRead: Number(attrs.cache_read_tokens ?? 0) || 0,
        cacheWrite: Number(attrs.cache_creation_tokens ?? 0) || 0,
      };
      const model = attrs.model ? String(attrs.model) : null;
      // What Claude Code says the call cost, in dollars, on every request it
      // exports. Kept, because it is the vendor's own figure for this exact
      // call: no rate table here has to be right, and none has to be
      // corrected when a price moves. This was being read and dropped, and
      // it is why every cost on the Performance page was zero.
      const cents = centsOf(attrs.cost_usd);
      retroSpan({
        parent,
        name: "model.call",
        startTime: at - ms,
        endTime: at,
        attrs: {
          ...inherited,
          "cv.model": model ?? undefined,
          "cv.tokens.input": tokens.input,
          "cv.tokens.output": tokens.output,
          "cv.tokens.cacheRead": tokens.cacheRead,
          "cv.tokens.cacheWrite": tokens.cacheWrite,
          ...(cents != null ? { "cv.cost.cents": cents } : {}),
          // Whose bill it landed on, which is not the same as what it cost:
          // work on the person's own Claude subscription is no cost to this
          // installation (costs.js `subscribed`) and still cost what the
          // line above says.
          "cv.subscription": true,
          "cv.request.id": attrs.request_id ?? undefined,
          "cv.skill.name": attrs["skill.name"] ?? undefined,
        },
      });
      // The ledger, as declared usage on the subscription - the way a
      // resident on Claude Code reports its own (resident.js `spent`).
      costs.record({ agentId: record.actor.id, taskId: null, ms: 0, tokens, model, declared: true, subscription: true, ...(cents != null ? { cents } : {}) });
      return "model.call";
    }
    case "claude_code.api_error": {
      retroSpan({
        parent,
        name: "model.call",
        startTime: at - ms,
        endTime: at,
        attrs: {
          ...inherited,
          "cv.model": attrs.model ?? undefined,
          "cv.ok": false,
          "cv.status": Number(attrs.status_code ?? 0) || undefined,
          "cv.attempt": Number(attrs.attempt ?? 0) || undefined,
          "cv.error": cut(attrs.error),
          "cv.subscription": true,
        },
      });
      return "model.call";
    }
    default:
      // Tool decisions, assistant responses, MCP connections, auth: the
      // session is alive, and nothing more is kept of them.
      sessionLog.touch(record.id, at);
      return null;
  }
}

/**
 * The event's name, always in this file's `claude_code.x` spelling.
 *
 * Claude Code has written it both ways. It used to put the qualified name in
 * the `event.name` attribute; it now puts the bare `user_prompt` there and
 * keeps the qualified one in the body. Reading only the attribute meant every
 * event failed the `claude_code.` test below and the whole export was dropped
 * - a laptop's session appeared, because the hook creates it, and then sat at
 * zero counts forever, which reads as an idle harness rather than as a
 * version skew. So take the qualified name from wherever it is and qualify a
 * bare one; both spellings have to keep working, since which one arrives
 * depends on the version on somebody else's laptop.
 */
function nameOfEvent(attrs, logRecord) {
  const candidates = [attrs["event.name"], logRecord?.body?.stringValue];
  for (const candidate of candidates) {
    const value = String(candidate ?? "");
    if (value.startsWith("claude_code.")) return value;
  }
  const bare = String(attrs["event.name"] ?? "");
  return bare ? `claude_code.${bare}` : "";
}

/** One log record as an event: its name, time, session and attributes. */
function eventOf(logRecord) {
  const attrs = attributesOf(logRecord?.attributes);
  return {
    name: nameOfEvent(attrs, logRecord),
    at: msOf(logRecord?.timeUnixNano ?? logRecord?.observedTimeUnixNano),
    session: attrs["session.id"] ?? null,
    attrs,
  };
}

/**
 * A batch of Claude Code's log events, from one harness. Returns what was
 * made of them, by span name, and the sessions touched.
 */
export async function ingestLogs(who, body) {
  const made = {};
  const sessions = new Set();
  let heard = 0;
  for (const logRecord of logRecordsOf(body)) {
    const event = eventOf(logRecord);
    if (!event.name.startsWith("claude_code.")) continue;
    heard += 1;
    const record = await sessionFor(who, event.session, { at: event.at });
    sessions.add(record.id);
    const became = await fold(who, record, event);
    if (became) made[became] = (made[became] ?? 0) + 1;
  }
  return { heard, made, sessions: [...sessions] };
}

/**
 * A batch of a harness's spans, from one machine. Its own trace ids are
 * kept, so a `traceparent` it sent an MCP request under lands in the same
 * trace as the span that made it. Names become this app's: for Claude Code
 * (the enhanced-telemetry beta) an interaction is a turn, an llm_request a
 * model call, a tool a tool call; for OpenCode, which exports to the same
 * endpoint from the standard OTEL_EXPORTER_OTLP_* variables, `Tool.execute`
 * is a tool call. A span this app has no name for is passed over rather
 * than filed under a guess.
 */
export async function ingestTraces(who, body) {
  const made = {};
  const sessions = new Set();
  let heard = 0;
  for (const span of spansOf(body)) {
    const attrs = attributesOf(span?.attributes);
    const name = String(span?.name ?? "");
    if (name === GATEWAY_SPAN) {
      heard += 1;
      const became = await gatewaySpan(who, span, attrs);
      made[became.name] = (made[became.name] ?? 0) + 1;
      if (became.session) sessions.add(became.session);
      continue;
    }
    const ours = name.startsWith("claude_code.interaction")
      ? "agent.turn"
      : name.startsWith("claude_code.llm_request")
        ? "model.call"
        : name.startsWith("claude_code.tool")
          ? "tool.call"
          : // OpenCode names a span for the code that made it, not for the
            // harness, so there is no prefix to match on. `Tool.execute` is
            // the one that says a tool ran, and it carries `session.id` and
            // `tool.name` under the keys read below - the same ones Claude
            // Code uses. Its model calls need no name here: they arrive as
            // the proxy's own gateway span, with the tokens and the cost.
            name === OPENCODE_TOOL_SPAN
            ? "tool.call"
            : null;
    if (!ours) continue;
    heard += 1;
    const start = msOf(span.startTimeUnixNano);
    const end = msOf(span.endTimeUnixNano, start);
    const record = await sessionFor(who, attrs["session.id"], { at: start });
    sessions.add(record.id);
    const traceId = idOf(span.traceId, 32);
    const parentId = idOf(span.parentSpanId, 16) ?? spanIdFor(`trace:${traceId}`);
    const failed = Number(span?.status?.code ?? 0) === 2;
    retroSpan({
      parent: traceId ? { traceId, spanId: parentId } : parentFor(record, attrs["prompt.id"]),
      name: ours,
      startTime: start,
      endTime: end,
      attrs: {
        ...inheritedOf(record),
        ...(ours === "tool.call"
          ? { "cv.tool.name": toolNameOf(attrs.tool_name ?? attrs["tool.name"]), "cv.tool.kind": "harness", "cv.tool.ok": !failed }
          : {}),
        ...(ours === "model.call" ? { "cv.model": attrs.model ?? undefined, "cv.subscription": true, "cv.ok": !failed } : {}),
      },
    });
    made[ours] = (made[ours] ?? 0) + 1;
  }
  return { heard, made, sessions: [...sessions] };
}

/** The span a LiteLLM proxy wraps each call in. Its child, `raw_gen_ai_request`, is the same call again and is left alone. */
export const GATEWAY_SPAN = "litellm_request";

/** The span OpenCode wraps each tool run in - `tool.name`, `tool.call_id`, `session.id`, `message.id`. */
export const OPENCODE_TOOL_SPAN = "Tool.execute";

/** The GenAI-convention numbers on a gateway span, in the ledger's four kinds. */
function gatewayTokens(attrs) {
  const n = (key) => Number(attrs[key] ?? 0) || 0;
  const cacheRead = n("gen_ai.usage.cache_read_input_tokens");
  return {
    input: Math.max(0, n("gen_ai.usage.prompt_tokens") - cacheRead),
    output: n("gen_ai.usage.completion_tokens"),
    cacheRead,
    cacheWrite: n("gen_ai.usage.cache_creation_input_tokens"),
  };
}

/**
 * The messages on a gateway span, in order, as `{role, text}`.
 *
 * LiteLLM writes the call itself onto the span, flattened the way the
 * GenAI convention flattens it: `gen_ai.prompt.<n>.role` and
 * `.content` for what was sent, `gen_ai.completion.<n>.role` and
 * `.content` for what came back. Nothing here is optional to us - a call
 * through the proxy with only its token counts kept is a row in a ledger,
 * and the point of routing a harness through a gateway is that the work it
 * did is readable afterwards. The proxy leaves them on unless somebody
 * turns message logging off (deploy/litellm/config.yaml says how, and
 * why they might); when they are off, this finds nothing and the span is
 * filed with its numbers as before.
 *
 * The indices are read as numbers, not as the strings they arrive as, so
 * message 10 does not sort between 1 and 2.
 */
export function gatewayMessages(attrs, prefix) {
  const found = new Map();
  const head = `gen_ai.${prefix}.`;
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (!key.startsWith(head)) continue;
    const rest = key.slice(head.length);
    const dot = rest.indexOf(".");
    if (dot < 0) continue;
    const index = Number(rest.slice(0, dot));
    if (!Number.isInteger(index) || index < 0) continue;
    const field = rest.slice(dot + 1);
    if (field !== "role" && field !== "content") continue;
    const message = found.get(index) ?? {};
    message[field] = value == null ? "" : String(value);
    found.set(index, message);
  }
  return [...found.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, message]) => ({ role: message.role || (prefix === "completion" ? "assistant" : "user"), text: message.content ?? "" }))
    .filter((message) => message.text !== "");
}

/**
 * The part of a call's messages that is new: everything after the last
 * thing the model said.
 *
 * A chat call carries the whole conversation every time, so filing every
 * message of every call would write the first turn onto the session twenty
 * times over. What is new in the twentieth call is what follows the
 * nineteenth answer - and on the first call that is the whole of it, system
 * prompt included, which is why this is a tail rather than "the last
 * message".
 */
export function newlyAsked(asked) {
  const last = asked.map((message) => message.role).lastIndexOf("assistant");
  return last < 0 ? asked : asked.slice(last + 1);
}

/**
 * The messages of one gateway call, onto a session's log, so a call routed
 * through the proxy reads the way a harness's own turn reads.
 *
 * A message the model said is an `agent_message_chunk`; anything else -
 * the person, the system prompt, a tool's result - is a
 * `user_message_chunk`, with its role named in the text when it is not the
 * person's, because the log's chunks carry text and no role of their own.
 */
function gatewaySaid(session, { asked, answered }, at) {
  if (!session) return;
  for (const message of newlyAsked(asked)) {
    const text = message.role === "user" ? message.text : `${message.role}: ${message.text}`;
    sessionEvents.append(session, message.role === "assistant" ? "agent_message_chunk" : "user_message_chunk", { text }, { at });
  }
  for (const message of answered) {
    sessionEvents.append(session, "agent_message_chunk", { text: message.text }, { at });
  }
}

/** What the proxy said the call cost, in cents, when it said. LiteLLM writes dollars. */
function gatewayCents(attrs) {
  for (const key of ["llm.response_cost", "gen_ai.usage.cost", "response_cost"]) {
    const cents = centsOf(attrs[key]);
    if (cents != null) return cents;
  }
  return null;
}

/**
 * One `litellm_request` span, filed. Under this app's own `model.call`
 * when the proxy carried our trace on, else as a model call of its own in
 * a session for whoever the proxy says asked.
 */
async function gatewaySpan(who, span, attrs) {
  const start = msOf(span.startTimeUnixNano);
  const end = msOf(span.endTimeUnixNano, start);
  const failed = Number(span?.status?.code ?? 0) === 2;
  const traceId = idOf(span.traceId, 32);
  const parentId = idOf(span.parentSpanId, 16);
  const model = attrs["gen_ai.response.model"] ?? attrs["gen_ai.request.model"] ?? undefined;
  const told = {
    "cv.gateway": "litellm",
    "cv.provider": attrs["gen_ai.system"] ?? undefined,
    "cv.model": model,
    "cv.gateway.generation": attrs["gen_ai.response.id"] ?? undefined,
    "cv.ok": !failed,
  };
  const tokens = gatewayTokens(attrs);
  const counted = {
    "cv.tokens.input": tokens.input,
    "cv.tokens.output": tokens.output,
    "cv.tokens.cacheRead": tokens.cacheRead,
    "cv.tokens.cacheWrite": tokens.cacheWrite,
    "cv.tokens.total": tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
  };
  const cents = gatewayCents(attrs);
  // What was asked and what came back. On the span, cut to a line, the way
  // a prompt is; whole, on the session's log, which is where a transcript
  // belongs (session-events.js).
  const said = { asked: gatewayMessages(attrs, "prompt"), answered: gatewayMessages(attrs, "completion") };
  const words = {
    "cv.prompt.text": cut(newlyAsked(said.asked).at(-1)?.text),
    "cv.completion.text": cut(said.answered.at(-1)?.text),
  };

  // Ours, seen from the proxy: the parent is a model.call this app made.
  const mine = traceId && parentId ? (await spans.forTrace(traceId)).find((known) => known.span === parentId && known.name === "model.call") : null;
  if (mine) {
    retroSpan({
      parent: { traceId, spanId: parentId },
      name: "gateway.call",
      startTime: start,
      endTime: end,
      attrs: {
        "cv.session.id": mine.session ?? undefined,
        "cv.agent.id": mine.attrs?.["cv.agent.id"],
        "cv.owner": mine.attrs?.["cv.owner"],
        "cv.task.id": mine.attrs?.["cv.task.id"],
        ...told,
        ...counted,
        ...words,
        ...(cents != null ? { "cv.cost.cents": cents } : {}),
        // costs.js counts the model.call; this is the same call again.
        "cv.retroactive": true,
      },
    });
    // This app's own call (it is the one that carries `traceparent`, so it
    // is the only kind that lands here), and nothing else writes what it
    // asked or heard onto the session - inference.js records a span and no
    // words. So the proxy's copy is the transcript here too.
    gatewaySaid(mine.session ?? null, said, start);
    return { name: "gateway.call", session: mine.session ?? null };
  }

  // Somebody else's call through the proxy: a session per asker.
  const asker = attrs["llm.user"] ?? attrs["metadata.user_api_key_alias"] ?? attrs["metadata.user_api_key_user_id"] ?? null;
  const record = await sessionFor(who, `litellm:${asker ?? "unnamed"}`, { at: start });
  retroSpan({
    parent: traceId ? { traceId, spanId: parentId ?? spanIdFor(`trace:${traceId}`) } : parentFor(record, null),
    name: "model.call",
    startTime: start,
    endTime: end,
    attrs: {
      ...inheritedOf(record),
      ...told,
      ...counted,
      ...words,
      ...(cents != null ? { "cv.cost.cents": cents } : {}),
      "cv.gateway.user": asker ?? undefined,
    },
  });
  // Nothing else reports this session - the proxy is all there is of it -
  // so the words the proxy carried are the whole transcript.
  gatewaySaid(record.id, said, start);
  // The ledger, the way a harness's own calls reach it (ingestLogs): a
  // retroactive span is not folded, so this is said outright - at the
  // proxy's price when it gave one, the catalogue's otherwise.
  costs.record({ agentId: record.actor.id, taskId: null, ms: 0, tokens, model, declared: true, ...(cents != null ? { cents } : {}) });
  return { name: "model.call", session: record.id };
}

/**
 * Metrics: counted so the response can say they arrived, and the sessions
 * they name looked up - never opened, touched or taken back live. A
 * harness exports its cumulative sums every interval for as long as it
 * runs, stamped with the collection time and with the session ids of every
 * session the process has had - so a session cleared with `/clear` kept
 * arriving here once a minute, and each arrival reopened it as working.
 * A metric point is not somebody working; the hooks and the log events are.
 */
export async function ingestMetrics(who, body) {
  const heard = metricPointsOf(body);
  const sessions = new Set();
  for (const resource of body?.resourceMetrics ?? []) {
    for (const scope of resource?.scopeMetrics ?? []) {
      for (const metric of scope?.metrics ?? []) {
        const series = metric?.sum ?? metric?.gauge ?? metric?.histogram ?? null;
        for (const point of series?.dataPoints ?? []) {
          const attrs = attributesOf(point?.attributes);
          if (!attrs["session.id"]) continue;
          const record = await sessionFor(who, attrs["session.id"], { at: msOf(point.timeUnixNano), revive: false, open: false });
          if (record) sessions.add(record.id);
        }
      }
    }
  }
  return { heard, made: {}, sessions: [...sessions] };
}

// ------------------------------------------------------------ the checkout

/**
 * The repository a git remote names, and which host it is on.
 *
 * The parsing is git-hosts/index.js, which knows all three hosts' remote
 * spellings: this used to be a GitHub-only regular expression here, and a
 * checkout of a GitLab project reported as a session in no repository at
 * all - which on the Search page reads as "none" and on every listing as
 * work that happened nowhere.
 *
 * Anything it cannot place - a host this app does not know, a local path -
 * is null, as it always was: the session stays unlinked rather than linked
 * to the wrong thing.
 *
 * This answers the name alone, which is all its callers ever wanted;
 * the start hook above reads `parseRemote` itself, because it also has to
 * write down which host.
 */
export function fullNameOf(remote) {
  return parseRemote(remote)?.fullName ?? null;
}

/** The tools whose `file_path` is a file the work landed on, in Claude Code's and Gemini CLI's names. */
const EDITING_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "write_file", "replace", "edit"]);

/**
 * What a tool call was, in a line: the path, the command, the pattern, the
 * URL - whichever the tool's input has - from Claude Code's `tool_input`
 * (Gemini CLI's is shaped the same). A tool with none of those is named by
 * its input as a whole, and one with no input by its name.
 */
export function toolTitleOf(tool, input) {
  const args = input && typeof input === "object" ? input : {};
  const first = ["file_path", "notebook_path", "command", "pattern", "url", "query", "skill", "description", "prompt", "path"].find(
    (key) => typeof args[key] === "string" && args[key].trim(),
  );
  if (first === "pattern" && typeof args.path === "string" && args.path.trim()) return `${args.pattern} in ${args.path}`;
  if (first) return args[first].trim();
  const rest = Object.entries(args).filter(([, value]) => value != null && value !== "");
  return rest.length ? rest.map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`).join(" · ") : String(tool ?? "tool");
}

/**
 * What a tool call came to, in a line, from Claude Code's `tool_response`:
 * a command's first line of output, how many lines a read was, how many
 * files a search found. Nothing for a tool whose title already says it -
 * an edit is its path.
 */
export function toolDetailOf(response) {
  if (response == null) return null;
  const line = (text) => String(text ?? "").split("\n").map((entry) => entry.trim()).find(Boolean) ?? null;
  if (typeof response === "string") return line(response);
  if (Array.isArray(response)) return line(response.map((entry) => (typeof entry === "string" ? entry : entry?.text ?? "")).join("\n"));
  if (typeof response !== "object") return null;
  if (response.stdout != null || response.stderr != null) return line(response.stdout) ?? line(response.stderr);
  if (response.file?.numLines != null) return `${response.file.numLines} lines`;
  if (response.numFiles != null) return `${response.numFiles} files`;
  if (response.numLines != null) return `${response.numLines} lines`;
  if (typeof response.content === "string") return line(response.content);
  if (typeof response.error === "string") return line(response.error);
  return null;
}

/**
 * What the agent said last, from the lines of its transcript the `stop`
 * hook sends: Claude Code's transcript is JSONL, one `{type: "assistant",
 * message: {content: [...]}}` line per message, and the last line with a
 * text block on it is the answer to the turn. The last line is not that
 * line: a turn is several assistant entries - a thought, each tool_use, the
 * answer - so the tail usually ends on a tool call with no text in it, and
 * reading the last entry rather than the last text would report the turn's
 * first sentence or nothing at all. Lines that will not parse are skipped,
 * not fatal - a transcript format is somebody else's to change.
 *
 * Whether the answer is in the file yet is a separate question, and not one
 * this can answer: see the `end` event in `noteHook`.
 */
export function lastSaidOf(lines) {
  const entries = (Array.isArray(lines) ? lines : []).map((entry) => {
    if (entry && typeof entry === "object") return entry;
    try {
      return JSON.parse(String(entry));
    } catch {
      return null;
    }
  });
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry || (entry.type && entry.type !== "assistant")) continue;
    const content = entry.message?.content ?? entry.content;
    const text = typeof content === "string"
      ? content
      : (Array.isArray(content) ? content : []).filter((block) => block?.type === "text" && block.text).map((block) => block.text).join("\n");
    if (text.trim()) return text.trim();
  }
  return null;
}

/**
 * The tool calls a session is in the middle of, by the id the hook gave
 * them - so `done` finds the `tool` it finishes, and can say how long it
 * took, which no hook says on its own. A harness that names no
 * `tool_use_id` (an older Claude Code) is matched by tool name, oldest
 * first. Memory only: a call left open across a restart stays open on the
 * page, which is true.
 */
const openCalls = new Map();
let anonymous = 0;

function openCall(session, id, tool, at) {
  const mine = openCalls.get(session) ?? [];
  mine.push({ id, tool, at });
  openCalls.set(session, mine.slice(-50));
}

function closeCall(session, id, tool) {
  const mine = openCalls.get(session) ?? [];
  const index = id ? mine.findIndex((call) => call.id === id) : mine.findIndex((call) => call.tool === tool);
  if (index < 0) return null;
  const [call] = mine.splice(index, 1);
  if (!mine.length) openCalls.delete(session);
  return call;
}

/**
 * How long after its `tool` hook a call of this app's own tools can still
 * be arriving at /mcp. The hook runs before the call is made and returns
 * before it is; the request follows within the second. An open call older
 * than this is one whose `done` hook was never heard, not one on its way.
 */
const CALLING_MS = 60_000;

/** Whether a harness's name for a tool - `mcp__codervibes__x`, `codervibes__x`, `x` - is this app's tool `name`. */
const namesOurTool = (tool, name) => tool === name || String(tool ?? "").endsWith(`__${name}`);

/**
 * How recently a hook-fed session must have been heard from to be taken as
 * the one calling, when no open call names the tool.
 *
 * The join below wants the `tool` hook to have arrived before the call it
 * announced, and it used to: the hook posted as it fired. It does not any
 * more. Each hook writes its event to `~/.codervibes/spool` and a shipper
 * posts the spool in the background (setup-script.js), so the PreToolUse
 * that named `mcp__codervibes__name_session` regularly lands here *after*
 * the call - by fourteen milliseconds in the run that found this - and the
 * join missed by that much. What the session then got was a record of its
 * own holding nothing but the naming, and the name went on that: one
 * `claude -p` run, two rows on Executors, and the titled one empty.
 *
 * So when nothing is open on this tool, the owner's most recently heard
 * hook-fed session is the caller. Two minutes, because a person at a
 * keyboard is heard from far more often than that - every prompt, every
 * tool call and every stop is an event - and because it is longer than any
 * spool lag: the shipper runs on each hook and posts what it holds. A
 * session quiet for longer than two minutes is one nobody is working in,
 * and a call that arrives then is somebody else's - a second harness, a
 * probe - and gets a record of its own.
 *
 * The cost of being wrong is small and the cost of the old behaviour was
 * not: two live terminals of the same person under the same harness are
 * already indistinguishable here (same owner, same ingest harness), so the
 * newest wins, and what it costs is a call on the wrong one of that
 * person's own sessions rather than a phantom row with nothing in it.
 */
const AT_KEYBOARD_MS = 2 * 60_000;

/** When a session was last heard from - what decides which live one is the one being worked in. */
const heardAt = (record) => Number(record.lastSeenAt ?? record.startedAt ?? 0);

/**
 * The hook-fed session that is calling one of this app's tools right now.
 *
 * A person's own setup reaches /mcp on the same token the hooks report on,
 * and the MCP endpoint used to open a session of its own for the
 * connection - so a session's work was two records: the one the hooks
 * wrote, with the prompt, the branch and the `gh pr create`, and one with
 * only the calls made through here. A pull request noted through here was
 * filed against the second, which had no branch and no words; six pull
 * requests from six terminals sat on one such record, and the sessions
 * that had made them showed none.
 *
 * The hooks say which session it is: Claude Code runs the `tool` hook
 * before it makes the call, and the hook posts before the call is sent, so
 * by the time the call reaches /mcp the session it comes from has an open
 * call on that very tool (`openCalls`). The owner's live session under this
 * harness with the newest such open call is the caller.
 *
 * That is the exact answer, and it is only available when the hook has
 * landed. Since the hooks spool and ship (`AT_KEYBOARD_MS`) it often has
 * not, so failing that, the owner's most recently heard hook-fed session
 * is taken as the caller - which is the same session a moment earlier or
 * later, and was the whole of the bug.
 *
 * Neither means no hook-fed session of this person is live at all: the
 * hooks are not installed (a Cursor, an older setup) or nobody is working.
 * The endpoint keeps a record of its own for those, opened at the first
 * tool call and not before.
 */
export function sessionCalling({ user, harness }, name, { at = Date.now() } = {}) {
  let best = null;
  let heard = null;
  for (const record of sessionLog.inMemory()) {
    if (record.state !== "live" || record.kind !== "harness" || !record.key) continue;
    if (record.owner !== user || record.harness?.id !== harness?.id) continue;
    if (at - heardAt(record) <= AT_KEYBOARD_MS && (!heard || heardAt(record) > heardAt(heard))) heard = record;
    for (const call of openCalls.get(record.id) ?? []) {
      if (!namesOurTool(call.tool, name) || at - call.at > CALLING_MS) continue;
      if (!best || call.at > best.at) best = { at: call.at, record };
    }
  }
  return best?.record ?? heard;
}

/**
 * What kind of steer this prompt was, asked of a small model and written
 * onto the session as one word (steer-kinds.js).
 *
 * Only from the second turn on: the first prompt of a session is the ask,
 * and there is nothing to steer yet. Fire-and-forget, and it never throws
 * into the ingest path - a hook that waited on a model call would put the
 * person's terminal behind our latency, and a classifier that failed would
 * lose the prompt event with it. An installation with no model configured
 * classifies nothing and the pages say "unclassified", which is true.
 */
function noteSteerKind(record, { said, prompt, turns }) {
  if (turns <= 1 || !prompt) return;
  Promise.resolve()
    .then(() => classify({ said, prompt, owner: record.owner ?? null }))
    .then((kind) => {
      // The vocabulary travels with the word: sessions.js refuses anything
      // not on this list, so the record can only ever hold one of the six.
      if (kind) sessionLog.steered(record.id, kind, STEER_KINDS);
    })
    .catch(() => {
      // Not knowing what kind of steer it was is not a reason for the
      // prompt not to have been recorded.
    });
}

/**
 * Which subagent made a tool call, when one did. Claude Code runs a
 * subagent (its Agent tool: Explore, a custom agent) inside the same
 * session and fires the session's hooks for the subagent's calls too,
 * with `agent_id` and `agent_type` on the event and nothing else to
 * tell them from the session's own. Kept on the call, so the transcript
 * says who reached for what rather than folding a subagent's forty reads
 * into the agent's own line of work.
 */
function agentOf(body) {
  const id = String(body?.agent_id ?? "").trim();
  const type = String(body?.agent_type ?? body?.agent_name ?? "").trim();
  return id || type ? { agent: { id: id || null, type: type || null } } : {};
}

/**
 * What the hooks report, which is everything the export cannot say - and,
 * since the hooks are handed each event whole, the session as it read.
 *
 * Seven events arrive on this one route (setup-script.js, the `report`
 * script), each
 * with the harness's own JSON as `input`:
 *
 *   `start` - the repository, the branch and the machine. `repo` is whatever
 *   `git remote get-url origin` printed, an HTTPS or SSH GitHub URL, or
 *   nothing for a checkout with no remote, which is noted as nothing.
 *
 *   `prompt` - a person typed. The words go on the transcript as a
 *   `user_message_chunk`, and the turn is marked running. A prompt that
 *   names a skill (`/code-review`) is a `skill.use` too.
 *
 *   `tool` - a tool is about to run: a `tool_call` titled by its input,
 *   the path or the command (`toolTitleOf`). The Skill tool, or a read of
 *   a SKILL.md, is a `skill.use` named for the skill (`skillOfTool`).
 *
 *   `done` - it ran: the `tool_call_update` that closes it, with what it
 *   came to (`toolDetailOf`) and how long it took. An editing tool's path
 *   is a file the work landed on.
 *
 *   `stop` - the turn ended: what the agent said last, from the transcript
 *   lines the hook sends (`lastSaidOf`), as an `agent_message_chunk`, and
 *   the turn marked idle.
 *
 *   `subagent` - a subagent finished (Claude Code's SubagentStop): what
 *   it reported back, as a line under its name. Its own tool calls arrive
 *   as `tool`/`done` with `agent_id` and `agent_type` on the input, and
 *   are kept marked with them (`agentOf`).
 *
 *   `end` - the session is over. Without it a session sits live until the
 *   idle sweep, and "working now" means "worked in the last quarter hour".
 *   It carries the transcript tail too, because by now the file is finished
 *   and at `stop` it may not have been (below).
 *
 *   `file` - one path an edit landed on; what the hook sent before `done`
 *   existed, kept so an old settings file goes on working.
 *
 * An event this does not know is taken as `start`, because that is what the
 * one hook that existed before them sent, and an old settings file on
 * somebody's laptop should keep working rather than start erroring.
 *
 * Who reads the words is session-events.js's rule, the same as a
 * resident's: the owner and the people on the repo; everyone else the shape.
 *
 * The session is opened here if its first telemetry has not arrived yet,
 * which at a session's start it usually has not.
 */
export async function noteHook(who, { session, event = null, at: when = null, repo = null, branch = null, machine = null, platform = null, file = null, input = null, transcript = null } = {}) {
  const harnessSessionId = String(session ?? "").trim();
  if (!harnessSessionId) throw new IngestError("Which session? The hook sends Claude Code's session_id.");
  const body = input && typeof input === "object" ? input : {};
  // Now, unless the caller says when: a backlog the machine shipped late
  // is dated by the machine's clock (otlp.js says which is which).
  const at = Number.isFinite(Number(when)) && Number(when) > 0 ? Number(when) : Date.now();
  // The end of a session - Claude Code's SessionEnd, which `/clear` fires
  // too - must not take a finished one back live on its way to ending it.
  const record = await sessionFor(who, harnessSessionId, { at, revive: event !== "end" });

  switch (event) {
    case "end":
      // What the agent actually finished on, when the `stop` hook did not
      // get it. Claude Code fires Stop and appends the turn's last assistant
      // entry to the transcript file in whichever order it likes: in a
      // `claude -p` run - a stranger's first session - the hook read the
      // file a beat early, so the last entry with any text in it was a
      // mid-turn line ("I'll load those tool schemas first.") and that is
      // what the session said the agent answered. By the time the session
      // ends the file is complete, so the same tail is read again and the
      // real answer put on the log if it is not the one already there.
      if (transcript) {
        const said = lastSaidOf(transcript);
        const already = sessionEvents.last(record.id, "agent_message_chunk", { own: true })?.text ?? null;
        if (said && said !== already) {
          sessionEvents.append(record.id, "agent_message_chunk", { text: said }, { at });
          // And the turn that ended on a question is one somebody has to
          // come back to (friction.js `isHandBack`) - a fact read off the
          // last line, which until now was the wrong line.
          if (friction.isHandBack(said) && !friction.isHandBack(already)) sessionLog.handedBack(record.id);
        }
      }
      sessionLog.end(record.id);
      openCalls.delete(record.id);
      hooked.delete(record.id);
      // The names the hooks gave this session's MCP calls outlive the
      // session by the window, because the export's copy of a call arrives
      // in the next batch and that batch can land after the session ended -
      // which for a `claude -p` run is every call it made. After the window
      // nothing can claim them (`mcpNamed`), so this is only the tidying.
      setTimeout(() => mcpCalls.delete(record.id), MCP_MATCH_MS).unref?.();
      return { session: record.id, event: "end", reason: String(body.reason ?? "").trim() || null };

    case "file": {
      // The old hook read the path out itself; the report script now sends the event whole.
      const path = file ?? body.tool_input?.file_path ?? null;
      sessionLog.noteFile(record.id, path);
      return { session: record.id, event: "file", file: String(path ?? "").trim() || null };
    }

    case "prompt": {
      hooked.add(record.id);
      const text = String(body.prompt ?? "").trim();
      // What the agent had just said, before this prompt goes on the log -
      // the half of the exchange the classifier needs to tell "you
      // misunderstood" from "now do the next thing".
      const said = sessionEvents.last(record.id, "agent_message_chunk", { own: true })?.text ?? null;
      // Counted before the turn is marked running, because whether the
      // *previous* turn was still running is what makes this a cut short
      // rather than a follow-up (guidance.js `prompted`).
      const counted = guidance.prompted(record.id, { at });
      if (text) {
        sessionEvents.append(record.id, "user_message_chunk", { text }, { at });
        // The first ask names the session; a later one is a follow-up and
        // does not rename it (sessions.js `noteTitle`).
        sessionLog.noteTitle(record.id, text);
      }
      // `/code-review` is a skill used, by the person's hand.
      const typed = skillOfPrompt(text);
      if (typed) skillSpan(record, { name: typed, via: "prompt", tool: "prompt", at });
      sessionEvents.append(record.id, "platform.status", { status: "running" }, { at });
      sessionLog.touch(record.id, at);
      noteSteerKind(record, { said, prompt: text, turns: counted?.counts?.turns ?? 0 });
      return { session: record.id, event: "prompt", chars: text.length, title: record.title ?? null, skill: typed };
    }

    case "tool": {
      hooked.add(record.id);
      const tool = String(body.tool_name ?? "").trim() || "tool";
      const id = String(body.tool_use_id ?? "").trim() || `${record.id}:${(anonymous += 1)}`;
      const title = toolTitleOf(tool, body.tool_input);
      openCall(record.id, id, tool, at);
      // An MCP call is the one kind the export cannot name, so the name is
      // kept here for the export's copy of this call to borrow
      // (`exportedToolName`).
      if (tool.startsWith("mcp__")) noteMcpCall(record.id, tool, at);
      sessionEvents.append(
        record.id,
        "tool_call",
        { toolCallId: id, title, tool: toolNameOf(tool), toolKind: sessionEvents.toolKindOf(tool), status: "in_progress", ...agentOf(body) },
        { at },
      );
      // A skill, if the call is one: the Skill tool, or a read of a
      // skill's file. Recorded as it starts, which is when the hook has the
      // input - and before the export's copy of it can arrive.
      const skill = skillOfTool(tool, body.tool_input);
      if (skill) skillSpan(record, { ...skill, tool: toolNameOf(tool), at });
      // The same command for the third time is somebody's afternoon going
      // into one test (friction.js). Tallied as it starts, from the title
      // the log already carries - and only for a tool that runs things: a
      // connector call titled "github_read on ada/engine" is shaped like a
      // command and is not one, and three of those are an agent working.
      if (sessionEvents.toolKindOf(tool) === "execute" && friction.looksLikeCommand(title)) {
        sessionLog.repeated(record.id, friction.normaliseCommand(title));
      }
      sessionLog.touch(record.id, at);
      return { session: record.id, event: "tool", toolCallId: id, title, skill: skill?.name ?? null };
    }

    case "done": {
      hooked.add(record.id);
      const tool = String(body.tool_name ?? "").trim() || "tool";
      const call = closeCall(record.id, String(body.tool_use_id ?? "").trim() || null, tool);
      const id = call?.id ?? (String(body.tool_use_id ?? "").trim() || null);
      const detail = toolDetailOf(body.tool_response);
      // Whether it worked, by the one rule (friction.js `isFailure`): the
      // harness's own `is_error`, an error string, a non-zero exit code -
      // and only failing that, the line itself, and only its words for a
      // non-zero exit. The log said "completed" for every call before this,
      // failures included, so a page could not tell them apart and neither
      // could the report.
      const failed = friction.isFailure({ response: body.tool_response, detail });
      const kind = failed ? friction.errorKindOf(detail, { tool, ok: false }) : null;
      if (kind) sessionLog.frictioned(record.id, kind);
      const status = failed ? "failed" : "completed";
      if (id) {
        sessionEvents.append(
          record.id,
          "tool_call_update",
          { toolCallId: id, status, ...(call ? { ms: at - call.at } : {}), ...(detail ? { detail } : {}) },
          { at },
        );
      } else {
        // A finish with no start - the hook for `tool` was not installed,
        // or the call opened before a restart. Say the call happened.
        sessionEvents.append(
          record.id,
          "tool_call",
          { toolCallId: `${record.id}:${(anonymous += 1)}`, title: toolTitleOf(tool, body.tool_input), tool: toolNameOf(tool), toolKind: sessionEvents.toolKindOf(tool), status, ...agentOf(body) },
          { at },
        );
      }
      const path = EDITING_TOOLS.has(tool) ? body.tool_input?.file_path ?? body.tool_input?.notebook_path ?? null : null;
      if (path) sessionLog.noteFile(record.id, path);
      // ---- lines written (PR C) ----------------------------------------
      // The one place in this process that ever sees a line of somebody's
      // code: the hook sends the whole `tool_input`, and the only things
      // that leave this block are two counts and a set of 32-bit
      // fingerprints (attribution.js). Nothing here is kept, logged or
      // spanned, and `noteEdit` cannot be handed a line even by mistake.
      //
      // A harness whose hooks carry no input - Codex's do not - counts
      // nothing here and reports "not measured" rather than nought
      // (performance.js `editsOf`).
      if (EDITING_TOOLS.has(tool) && body.tool_input) {
        const { added, removed } = linesOfEdit(tool, body.tool_input);
        if (added.length || removed.length) {
          sessionLog.noteEdit(record.id, { added: added.length, removed: removed.length, hashes: hashesOf(added) });
        }
      }
      // ---- end lines written -------------------------------------------
      sessionLog.touch(record.id, at);
      // A command that opened a pull request is that pull request, opened
      // by this session - noted here because the agent mostly does not say
      // so itself (pull-opened.js). Best effort: the log entry above stands
      // whether or not GitHub can be reached.
      const pull = await heardToolResult(record, { command: body.tool_input?.command ?? null, response: body.tool_response });
      return { session: record.id, event: "done", toolCallId: id, file: path ?? null, detail, failed: kind, pull: pull ? { repo: pull.repo, number: pull.number, url: pull.url } : null };
    }

    case "subagent": {
      // A subagent finished (Claude Code's SubagentStop): what it reported
      // back to the agent, on the log as its own line under its name. Its
      // calls came in as `tool` events carrying the same agent id, so the
      // transcript reads: the Agent call, the subagent's reads, its report.
      hooked.add(record.id);
      const said = String(body.last_assistant_message ?? "").trim();
      const who = agentOf(body);
      if (said) sessionEvents.append(record.id, "agent_message_chunk", { text: said, ...who }, { at });
      sessionLog.touch(record.id, at);
      return { session: record.id, event: "subagent", chars: said.length, agent: who.agent ?? null };
    }

    case "stop": {
      const said = lastSaidOf(transcript);
      // The turn is over: the stretch since it was marked running was the
      // agent's own time. Read before the status is appended, since that
      // append is what moves the clock (session-events.js `turnOf`).
      const turn = sessionEvents.turnOf(record.id);
      if (turn?.status === "running" && turn.since) sessionLog.spent(record.id, { agentMs: at - turn.since });
      // A turn that ended on a question is one the person has to come back
      // to before anything else happens (friction.js `isHandBack`). Read
      // from the same last line the log keeps, and counted as a kind rather
      // than kept as words.
      const handedBack = friction.isHandBack(said);
      if (handedBack) sessionLog.handedBack(record.id);
      if (said) sessionEvents.append(record.id, "agent_message_chunk", { text: said }, { at });
      sessionEvents.append(record.id, "platform.status", { status: "idle" }, { at });
      sessionLog.touch(record.id, at);
      return { session: record.id, event: "stop", chars: said?.length ?? 0, handedBack };
    }

    default: {
      const remote = repo ? parseRemote(String(repo)) : null;
      const fullName = remote?.fullName ?? null;
      const host = remote?.host ?? "github";
      const cleanBranch = String(branch ?? "").trim().slice(0, 200) || null;
      // The repo here the checkout is of, so the session is that repo's -
      // in its workspace, on its pages, readable by the people on it. A
      // checkout of a repository nobody connected here is no repo's, and
      // on no page: a person's own setup reports every terminal they
      // open, and the ones that are not this installation's work stay
      // off it.
      const home = fullName ? repos.checkoutFor(fullName, record.owner, host) : null;
      sessionLog.noteBranch(record.id, { repo: fullName, host, branch: cleanBranch, repoId: home?.id ?? null });
      // Where it ran. A laptop reports its hostname and an e2b sandbox its
      // own id, and either is the machine as far as this app is concerned -
      // there is no other record of one to reconcile it against any more.
      const where = whereOf(machine, platform, who?.executor ?? null);
      // Registered on the owner's row before it is written onto the session,
      // because that map is this account's one list of machines and a
      // session hook is how plenty of them first arrive (ingest-token.js
      // `noteMachine`). An installation that seats a fixed number of
      // executors refuses a new machine here with a 409, which otlp.js
      // passes through as the answer to the request - and a 4xx is what
      // makes the spool shipper drop the batch rather than offer it
      // forever, which is the right end for events from a machine this
      // installation has no place for.
      if (where) await ingestToken.noteMachine(record.owner, where);
      if (where) sessionLog.noteMachine(record.id, where);
      return { session: record.id, event: "start", repo: fullName, host, branch: cleanBranch, machine: where };
    }
  }
}

/** The name this had while it noted the checkout and nothing else. */
export const noteRepo = noteHook;

/**
 * The machine a hook named, as a session holds one.
 *
 * The id is the executor the token registered (ingest-token.js), so a
 * session lands on the same row its setup did however the machine is calling
 * itself this time - a rebuilt sandbox has a new id every night and is the
 * same executor. The name stays as the label, because "which box was this"
 * is still worth reading on the session.
 *
 * Without an executor - a harness record of its own (harnesses.js), which
 * registers no executor - the id is the name, as it always was: there is no
 * id of ours to give those, and two setups calling themselves the same thing
 * are the same machine to us. `platform` is empty for a laptop, which is
 * exactly what it should say.
 */
function whereOf(machine, platform, executor = null) {
  const name = String(machine ?? "").trim().slice(0, 120);
  if (!name) return null;
  const host = String(platform ?? "").trim().slice(0, 40) || "laptop";
  return { id: executor ?? sessionLog.machineIdOf(host, name), name, host };
}
