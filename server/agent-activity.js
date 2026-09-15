// What an agent is doing, right now and just now.
//
// An invited agent's transcript belongs to whoever is running it - Claude Code
// on somebody's laptop, a cron job on a box nobody has looked at in a month.
// The person whose repos it is working in cannot see any of it. Until now
// the only trace it left here was a chip in the presence row of whichever
// repo it happened to be in, and whatever it chose to say in chat.
//
// That was survivable while an agent lived in one repo. It is not now: an
// agent can be making repos, booting sandboxes and deploying services
// across several at once, and "it is working" is not an answer to "on what".
//
// So every tool call is recorded here as it starts and again as it finishes.
// Deliberately a *feed* rather than a log: it is held in memory, it is capped,
// and losing it costs nothing. Nobody audits from this - it is the answer to
// "what is that thing doing", asked by a person watching a screen.
import { EventEmitter } from "node:events";
import { publish } from "./events.js";

/** Calls kept per agent. About a screenful of scrollback; a feed, not a log. */
const PER_AGENT = 60;

/**
 * Agents kept at all.
 *
 * A ceiling because this is keyed by agent id and agent ids are created by
 * anybody with an account. Without it, a loop that invites agents is a slow
 * memory leak in a process that is supposed to run for weeks.
 */
const MAX_AGENTS = 500;

/** Longest thing we will say about one call. These end up on a card. */
const MAX_SUMMARY = 160;

/** Longest reason kept for what is stopping an agent. The model's own
 *  sentence, which is what the person has to act on, is about 120. */
const MAX_TROUBLE = 500;

/** Longer than any one model answer takes; after this, "thinking" is stale. */
const THINKING_MAX_MS = 10 * 60_000;

/**
 * What each tool is doing, in words rather than in its own name.
 *
 * `run_command` means nothing to somebody watching who did not write the tool
 * list, and "list_dir" as a status line is a status line nobody reads. The
 * detail after the verb comes from the call's own arguments, which is what
 * makes two `write_file` lines tell you different things.
 */
const VERBS = {
  // In the room. The file and command tools used to be most of this table;
  // they ran on a machine of ours, and there is none - an agent's reads and
  // writes happen on its own disk, where this app never sees them.
  send_message: (input) => `Saying: ${input.text}`,
  read_messages: () => "Catching up on the chat",
  repo_info: () => "Getting its bearings",
  platform_guide: () => "Reading the guide",
  list_repos: () => "Looking at its repos",
  switch_repo: (input) => `Moving to ${input.repo}`,
  create_repo: (input) => `Connecting the repo ${input.name}`,
  list_agents: () => "Looking for another agent to ask",
  send_task: (input) => `Asking ${input.to} to: ${input.title}`,
  my_tasks: () => "Checking what it has been asked",
  update_task: (input) => `Marking a task ${input.state}`,
  note_pull_request: (input) => `Noting the pull request ${input.pull ?? ""}`.trim(),
  request_access: (input) => `Asking to be allowed ${input.permission}`,
  name_session: (input) => `Naming the session: ${input.title ?? ""}`.trim(),
  merge_pull_request: (input) => `Merging #${input.number}`,

  // What its owner has connected. These are the ones a person most wants to
  // see going past - an agent posting to Slack or committing to a repository
  // is doing something with their name on it.
  github_repos: () => "Looking for a repository",
  github_read: (input) => `Reading ${input.path ?? ""} from ${input.repo}`,
  github_issues: (input) =>
    input.number ? `Reading ${input.repo}#${input.number}` : `Searching ${input.repo}'s issues`,
  github_commit: (input) =>
    `Committing ${input.files?.length ?? 0} file(s) to ${input.repo} ${input.branch}`,
  github_pull_request: (input) =>
    input.number ? `Commenting on ${input.repo}#${input.number}` : `Opening a PR on ${input.repo}`,
  buildkite_pipelines: () => "Looking at Buildkite",
  buildkite_builds: (input) => `Checking builds of ${input.pipeline}`,
  buildkite_build: (input) => `Reading build #${input.number} of ${input.pipeline}`,
  buildkite_rebuild: (input) => `Starting a build of ${input.pipeline} ${input.branch}`,
  linear_issues: (input) => `Searching Linear${input.query ? ` for ${input.query}` : ""}`,
  linear_issue: (input) => `Reading ${input.id}`,
  linear_create_issue: (input) => `Filing "${input.title}" in ${input.team}`,
  linear_comment: (input) => `Commenting on ${input.id}`,
  slack_channels: () => "Looking at Slack channels",
  slack_history: (input) => `Reading #${input.channel}`,
  slack_post: (input) => `Posting to #${input.channel}`,
};

/** One line saying what this call is, for somebody who is not a programmer. */
/** The calls that are about a task rather than work for it. */
const BOOKKEEPING = new Set(["update_task", "my_tasks"]);

export function summarize(tool, input = {}) {
  const describe = VERBS[tool];
  let said;
  try {
    said = describe ? describe(input ?? {}) : tool.replace(/_/g, " ");
  } catch {
    // A malformed argument is the model's problem, not a reason for the
    // activity feed to throw inside a tool call.
    said = tool.replace(/_/g, " ");
  }
  const text = String(said ?? tool).replace(/\s+/g, " ").trim();
  return text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY - 1)}…` : text;
}

let nextId = 1;

/**
 * On the log, for whoever is watching: the agent's page, the repo's
 * activity, a "thinking" indicator. About the agent and its repo, so a
 * colleague in the repo hears too; ephemeral, since a busy agent makes
 * several of these a second and nobody wants them back a day later.
 */
function told(entry, call) {
  publish(
    "agent.call",
    { agentId: entry?.id ?? null, repoId: call.repoId ?? null },
    { id: call.id, tool: call.tool, state: call.state, summary: call.summary, ms: call.ms ?? null },
  );
}

class AgentActivity extends EventEmitter {
  constructor() {
    super();
    // Nothing here is a subscription per agent, so one listener per console is
    // all this ever holds. The default ceiling of 10 is not that.
    this.setMaxListeners(0);
    this.byAgent = new Map(); // agentId -> { name, owner, calls: [], updatedAt }
  }

  /** The record for one agent, created on first sight. */
  track(agent, owner) {
    let entry = this.byAgent.get(agent.id);
    if (!entry) {
      if (this.byAgent.size >= MAX_AGENTS) {
        // Oldest first. Whoever it belonged to loses a feed, not any work.
        const stalest = [...this.byAgent.entries()].sort(
          (a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0),
        )[0];
        if (stalest) this.byAgent.delete(stalest[0]);
      }
      entry = { id: agent.id, name: agent.name, owner: owner ?? null, calls: [] };
      this.byAgent.set(agent.id, entry);
    }
    entry.name = agent.name;
    if (owner) entry.owner = owner;
    return entry;
  }

  /**
   * An agent has started a tool call.
   *
   * Recorded when it *starts*, not when it finishes, which is the whole point:
   * the calls worth watching are the slow ones, and a feed that only showed
   * finished work would be silent for exactly as long as something was taking
   * too long.
   *
   * @returns {object} the call, to be handed back to `finished`
   */
  started({ agent, owner, repo, sandbox, tool, input, task = null }) {
    const entry = this.track(agent, owner);
    const call = {
      id: nextId++,
      tool,
      summary: summarize(tool, input),
      repoId: repo?.id ?? null,
      repoName: repo?.name ?? null,
      // Named only when it is somewhere other than the repo's own, so a
      // feed for the ordinary case does not repeat "default" on every line.
      sandbox: sandbox && !sandbox.default ? sandbox.name : null,
      // The task this call is part of, when the agent is on one - what lets
      // the Tasks tab say "Builder is reading src/app.js for this" rather
      // than only "Builder is busy". See `forTask`.
      task: task ? String(task) : null,
      at: Date.now(),
      state: "running",
    };
    entry.calls.push(call);
    if (entry.calls.length > PER_AGENT) entry.calls.splice(0, entry.calls.length - PER_AGENT);
    entry.updatedAt = call.at;
    this.emit("changed", { agentId: agent.id, call });
    told(entry, call);
    return call;
  }

  /**
   * A call that already happened, reported after the fact.
   *
   * A resident does its file and shell work on its own machine without
   * asking this app (agentd.mjs), so nothing here saw it start. It says what
   * it did in its next poll instead, and those land here as finished calls -
   * so the record of a task is the whole of it, not only the half that went
   * over MCP. `at` and `ms` are the loop's own, since it was there.
   */
  did({ agent, owner, repo, sandbox, tool, input, task = null, at, ms = 0, ok = true }) {
    const entry = this.track(agent, owner);
    const started = Number(at) || Date.now();
    const call = {
      id: nextId++,
      tool,
      summary: summarize(tool, input),
      repoId: repo?.id ?? null,
      repoName: repo?.name ?? null,
      sandbox: sandbox && !sandbox.default ? sandbox.name : null,
      task: task ? String(task) : null,
      at: started,
      state: ok ? "done" : "failed",
      endedAt: started + Math.max(0, Number(ms) || 0),
      ms: Math.max(0, Number(ms) || 0),
    };
    entry.calls.push(call);
    if (entry.calls.length > PER_AGENT) entry.calls.splice(0, entry.calls.length - PER_AGENT);
    entry.updatedAt = Math.max(entry.updatedAt ?? 0, call.endedAt);
    this.emit("changed", { agentId: agent.id, call });
    told(entry, call);
    return call;
  }

  /**
   * A call this process never saw, read back from a span at boot (replay.js).
   *
   * Like `did`, without the announcement: nothing is watching yet, and a
   * console that arrives later reads the feed whole. The summary is the
   * tool's name alone - a span carries no inputs, by design, so "read a
   * file" is as much as a replayed line can say - and it is the last-active
   * time that matters most: it is what stops every agent saying "never
   * connected" for the first ten minutes after a deploy.
   */
  remember({ agent, owner, repo = null, tool, task = null, at, ms = 0, ok = true, kind = null }) {
    const entry = this.track(agent, owner);
    const started = Number(at) || Date.now();
    const call = {
      id: nextId++,
      tool,
      summary: String(tool).replace(/_/g, " "),
      repoId: repo?.id ?? null,
      repoName: repo?.name ?? null,
      sandbox: null,
      task: task ? String(task) : null,
      at: started,
      state: ok ? "done" : "failed",
      endedAt: started + Math.max(0, Number(ms) || 0),
      ms: Math.max(0, Number(ms) || 0),
      ...(kind ? { kind } : {}),
      replayed: true,
    };
    entry.calls.push(call);
    if (entry.calls.length > PER_AGENT) entry.calls.splice(0, entry.calls.length - PER_AGENT);
    entry.updatedAt = Math.max(entry.updatedAt ?? 0, call.endedAt);
    return call;
  }

  /**
   * What has been done for one task, oldest first - the calls that were made
   * while the agent holding it was on it, whoever made them. Only as deep as
   * the feed: a task that took two hundred calls shows the last sixty. A feed
   * is what this is; the task record keeps the lasting summary (agent-tasks.js).
   */
  forTask(taskId) {
    const wanted = String(taskId);
    const found = [];
    for (const entry of this.byAgent.values()) {
      for (const call of entry.calls) {
        // Reporting on the task is not a step of it: "Marking a task
        // accepted" under every task, between the real lines, is noise -
        // and the note given with it is already there as a step in the
        // agent's own words (agent-tasks.js).
        if (BOOKKEEPING.has(call.tool)) continue;
        if (call.task === wanted) found.push({ ...call, agentId: entry.id, agentName: entry.name });
      }
    }
    return found.sort((a, b) => a.at - b.at || a.id - b.id);
  }

  /** The same call, done. `ok` is false for a tool that returned an error. */
  finished(call, { ok = true, detail = null } = {}) {
    if (!call) return;
    call.state = ok ? "done" : "failed";
    call.endedAt = Date.now();
    call.ms = call.endedAt - call.at;
    if (detail) call.detail = String(detail).slice(0, MAX_SUMMARY);
    const owner = [...this.byAgent.values()].find((entry) => entry.calls.includes(call));
    if (owner) owner.updatedAt = call.endedAt;
    this.emit("changed", { agentId: owner?.id ?? null, call });
    told(owner, call);
  }

  /**
   * A model call has started, or finished: the agent is thinking, as opposed
   * to doing.
   *
   * Tool calls say what an agent is doing; between them it is composing the
   * next step, and to somebody who has just asked it something that silence
   * reads as "it did not hear me". This is the "typing…" of a messenger.
   * Counted, not flagged, because a loop may have two calls in flight; and
   * stamped, because a connection that dies without its close event would
   * otherwise leave an agent thinking forever - see `forAgent`.
   */
  thinking(agent, repoId, on) {
    const entry = this.track(agent);
    entry.thinking = Math.max(0, (entry.thinking ?? 0) + (on ? 1 : -1));
    entry.thinkingAt = Date.now();
    publish("agent.thinking", { agentId: agent.id, repoId }, { thinking: entry.thinking > 0 });
  }

  /**
   * Something is stopping it: the model refused its call, or its loop gave
   * up on an episode and is waiting to try again.
   *
   * Until this, the only place that was written was the loop's own log on
   * its machine - and from the console an agent whose every model call was
   * answered "credit balance too low" looked exactly like one that was idle.
   * So it is kept on the record, with the reason in the words it was given,
   * and it goes on the feed once so the timeline says when it began. A
   * retry that fails the same way bumps the count rather than adding a line:
   * the loop tries again every minute, and sixty copies of one sentence is
   * the feed gone.
   *
   * Cleared by `recovered` - the next model call that is answered - or by a
   * restart, which is a fresh start.
   */
  trouble(agent, { message, status = null, source = "model", repo = null, at = Date.now() }) {
    const entry = this.track(agent);
    const text = String(message ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TROUBLE) || "no reason given";
    const same = entry.trouble && entry.trouble.message === text;
    entry.trouble = {
      message: text,
      status: status == null ? null : Number(status),
      source,
      at,
      since: same ? entry.trouble.since : at,
      count: same ? entry.trouble.count + 1 : 1,
    };
    if (!same) {
      const call = {
        id: nextId++,
        tool: source === "model" ? "model" : "loop",
        summary:
          source === "model"
            ? `The model refused${status ? ` (${status})` : ""}`
            : "Its loop stopped on an error",
        detail: text.slice(0, MAX_SUMMARY),
        repoId: repo?.id ?? null,
        repoName: repo?.name ?? null,
        sandbox: null,
        task: null,
        at,
        state: "failed",
        endedAt: at,
        ms: 0,
      };
      entry.calls.push(call);
      if (entry.calls.length > PER_AGENT) entry.calls.splice(0, entry.calls.length - PER_AGENT);
      entry.updatedAt = Math.max(entry.updatedAt ?? 0, at);
      this.emit("changed", { agentId: agent.id, call });
      told(entry, call);
      return;
    }
    publish("agent.trouble", { agentId: agent.id, repoId: repo?.id ?? null }, entry.trouble);
  }

  /** It is working again: a model call was answered. Nothing to say if it was fine all along. */
  recovered(agent) {
    const entry = this.byAgent.get(agent.id);
    if (!entry?.trouble) return;
    entry.trouble = null;
    publish("agent.trouble", { agentId: agent.id }, null);
  }

  /** Which sandbox a call turned out to be in, once that has been resolved. */
  placed(call, sandbox) {
    if (!call || !sandbox || sandbox.default) return;
    call.sandbox = sandbox.name;
    this.emit("changed", { agentId: null, call });
    told([...this.byAgent.values()].find((entry) => entry.calls.includes(call)), call);
  }

  /** What one agent has been doing, newest last. */
  forAgent(agentId) {
    const entry = this.byAgent.get(agentId);
    if (!entry) return { calls: [], busy: false, thinking: false, lastAt: null, trouble: null };
    // A model call that started longer ago than any answer takes is one
    // whose end was never heard - the loop was killed mid-call, or the
    // machine slept under it - not one still in flight.
    const thinking =
      (entry.thinking ?? 0) > 0 && Date.now() - (entry.thinkingAt ?? 0) < THINKING_MAX_MS;
    return {
      calls: entry.calls,
      busy: thinking || entry.calls.some((call) => call.state === "running"),
      thinking,
      lastAt: entry.updatedAt ?? null,
      // What is stopping it, if anything - see `trouble`.
      trouble: entry.trouble ?? null,
    };
  }

  /**
   * Everything one person's agents have been doing.
   *
   * `owned` is the caller's own agents - this never reads across accounts, and
   * the caller passes the list rather than this module learning how ownership
   * works.
   */
  forOwner(owned) {
    return owned.map((agent) => ({ ...agent, ...this.forAgent(agent.id) }));
  }

  /** Forget an agent that has been removed. */
  forget(agentId) {
    this.byAgent.delete(agentId);
  }
}

export const agentActivity = new AgentActivity();
