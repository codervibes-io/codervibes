// Sessions: one stretch of an agent's work, as counts.
//
// A span is one thing that happened. A session is the stretch of them that
// belongs together - an agent's MCP connection from initialize to the DELETE
// (or to going quiet), the assistant answering in one repo, a harness
// on somebody's laptop from its first event to its last, a run by an agent
// that is not ours. It is the row on the Activity page and the unit the
// Performance page scores: this session opened these pull requests, took
// this much steering, cost this much.
//
// The record is counts, ids and names. Never what was said, never a tool's
// input, never a file path - a session is everyone's to read (the
// installation sees the installation's activity) while the files and the
// transcripts are the repo's and the harness's. The spans behind the counts carry the same
// discipline (telemetry.js), so a page that goes from a session to its
// timeline crosses no line either.
//
// One thing on the record is words: `title`, what the session is for -
// the agent's own summary of it (`nameSession`), and until the agent says,
// the first line of the first prompt, cut short. A row named after its
// actor says "Your own setup" forty times down the Home page and nothing
// about what any of them was for; the ask is the one line that does, and
// the agent's word for it is better. It is kept on the record because it
// is the row's name, and it is handed out under the words rule, not the
// counts one - the owner and the repo's people see it, anyone else sees
// the actor's name (index.js `describeSession`).
//
// Beside the counts, a session says where it sits in the rest of the
// system, by id: which agent (`actor`), on which machine (`machine`), in
// which repo, which tasks it took, which pull requests came of it, which
// Slack threads it spoke into (`threads`), and what set it off (`trigger`) - the task that woke an agent, the
// line a person typed to the assistant, the first prompt of a laptop
// harness. Each of those is a thing with a page of its own, and a session
// nobody can get to from its agent, its machine, its pull request or the
// line that started it is a row with no story. The trigger is the id of the
// thing and who sent it, never the words: the words are the task's or the
// task's, and the routes fetch them for a viewer who could read them there.
//
// Counts are kept up as the spans arrive (`onSpan`), so a live session's row
// is current without a query, and the record is written to the store a
// moment later, in one write however many spans landed in that moment. An
// idle session is ended by `sweep` - a loop that stops polling, a browser
// that closed the tab, a harness whose laptop went to sleep never say
// goodbye, and a session that never ends never scores.
import { randomBytes } from "node:crypto";
// Pure arithmetic over numbers, with no imports of its own: the packing of
// a session's line fingerprints belongs to the record, so the record layer
// owns it and stays a leaf all the same.
import { pack, unpack, MAX_HASHES } from "./attribution.js";
import { onSpan, sessionContext, endSession as endRoot } from "./telemetry.js";
import { tokenCost } from "./costs.js";
import { store } from "./store/index.js";
import * as sessionEvents from "./session-events.js";
import { publish } from "./events.js";
import { errorKindOf, ERROR_KINDS, MAX_COMMANDS, commandHash } from "./friction.js";

/** Who a session belongs to, by how the work got here. */
export const KINDS = ["resident", "invited", "assistant", "harness", "external", "deploy"];

/**
 * A session nobody has touched for this long is inactive, and is ended.
 * Fifteen minutes, not the MCP transport's thirty: "working now" is a
 * claim about this quarter of an hour, and ending early costs nothing,
 * because a session that speaks again is taken back live (`byKey`).
 */
export const IDLE_MS = 15 * 60 * 1000;

/**
 * How far back a harness's key is looked for in the store when it speaks
 * again after its session ended - a laptop that slept through lunch is the
 * same session when it wakes, and a day is as long as anyone resumes one.
 */
export const RESUME_MS = 24 * 60 * 60 * 1000;

/** How long an ended session stays in memory before it is the store's alone. */
const REMEMBER_MS = 60 * 60 * 1000;

/** A pending write waits this long for more spans to land. */
const WRITE_DELAY_MS = 1000;

/** Trace ids kept on the record; a long session has one trace per call the client parented itself. */
const MAX_TRACES = 200;
const MAX_TASKS = 200;
/** How many distinct models a session remembers calling. One is the rule; a handful is a session that switched. */
const MAX_MODELS = 8;
/**
 * How many distinct files one session is remembered as having touched.
 *
 * A path is small and a session that edits two hundred of them has said
 * everything it is going to say about which part of the tree it was in -
 * past that the list is a worse answer than the count, so the count keeps
 * rising and the list stops.
 */
const MAX_FILES = 200;
/**
 * How many Slack threads one session remembers. A handful is a session that
 * answered in a thread and said so again when it finished; twenty is already
 * a session posting into Slack in a loop, and the twenty-first says nothing
 * the first twenty did not.
 */
const MAX_THREADS = 20;

/** id -> record, live ones and the recently ended. */
const records = new Map();
/** id -> timer, writes waiting to happen. */
const writes = new Map();

/**
 * What can set a session off. `line` is kept for records written before the
 * messaging layer went (2026-09): nothing produces one now, and a session
 * page that finds one still says what set that session off.
 */
export const TRIGGER_KINDS = ["task", "line", "prompt", "webhook", "schedule"];

/**
 * actor id -> the trigger waiting for the session it will produce. A ring
 * reaches an agent before the agent's machine has booted and connected, so
 * the thing that woke it is known a minute before there is a record to put
 * it on; it waits here, and `open` takes it. Kept for as long as a wake can
 * take; a trigger nobody came for is dropped, not pinned to a session that
 * starts an hour later for some other reason.
 */
const pending = new Map();
const PENDING_MS = IDLE_MS;

const newId = () => `ses_${randomBytes(8).toString("hex")}`;

/**
 * A trigger as the record keeps it: kind, the id of the thing, and who sent
 * it - kind and id and name, the way `actor` is kept. Anything else on what
 * was handed in is dropped, so a caller that passes the message itself
 * cannot put its text on the record by accident.
 */
export function cleanTrigger(trigger) {
  if (!trigger || !TRIGGER_KINDS.includes(trigger.kind)) return null;
  const by = trigger.by ?? null;
  return {
    kind: trigger.kind,
    id: trigger.id == null ? null : String(trigger.id),
    // Where the thing lives, for looking it up again: the repo a task is in.
    key: trigger.key == null ? null : String(trigger.key),
    by: by ? { kind: by.kind ?? null, id: by.id ?? null, name: by.name ?? null } : null,
    at: Number(trigger.at) || Date.now(),
  };
}

/**
 * A Slack thread as the record keeps it: where it is, and not one word of
 * what was said in it.
 *
 * The rule at the top of this file is that a session's record is counts,
 * ids and names, and a Slack message is words - somebody's words, in a
 * channel that may be private, on a record the whole installation reads.
 * So what is kept is the address: the channel, the timestamp that is the
 * thread's id, and the permalink. Slack holds the words and decides who
 * may read them, which is the right place for both.
 *
 * The permalink is checked rather than trusted. It is rendered as a link on
 * a page other people open, and it arrives from an API response - so a
 * value that is not an `https` URL on a Slack host is dropped, and the
 * thread is kept without one.
 */
export function cleanThread(thread) {
  if (!thread?.channel || !thread?.ts) return null;
  return {
    team: thread.team == null ? null : String(thread.team),
    channel: String(thread.channel),
    // The name for the eye - `#eng` says more than `C09FZ1K2L`. A name, the
    // way a repo's is, never the topic or anything anybody typed.
    channelName: thread.channelName == null ? null : String(thread.channelName).slice(0, 80),
    ts: String(thread.ts),
    permalink: slackUrl(thread.permalink),
    at: Number(thread.at) || Date.now(),
  };
}

/** A Slack permalink, or null for anything that is not one. */
function slackUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    const ok = url.protocol === "https:" && (url.hostname === "slack.com" || url.hostname.endsWith(".slack.com"));
    return ok ? url.toString() : null;
  } catch {
    return null;
  }
}

/** A machine as the record keeps it: id, and the name and host it had, since the machine may be gone by the time anybody reads this. */
export function cleanMachine(machine) {
  if (!machine?.id) return null;
  return { id: String(machine.id), name: machine.name ?? null, host: machine.host ?? null };
}

/**
 * Something set off an actor that has no live session: remember it for
 * the session the wake produces. An actor that is already live is being
 * steered, not set off (guidance.js), and this is not for it.
 */
export function setOff(actorId, trigger, at = Date.now()) {
  const clean = cleanTrigger(trigger);
  if (!actorId || !clean) return null;
  pending.set(String(actorId), { ...clean, at, until: at + PENDING_MS });
  return clean;
}

function takePending(actorId, at) {
  const found = actorId ? pending.get(String(actorId)) : null;
  if (!found) return null;
  pending.delete(String(actorId));
  if (found.until < at) return null;
  const { until, ...trigger } = found;
  return trigger;
}

/** The counts a session starts with. */
export const emptyCounts = () => ({
  spans: 0,
  tools: 0,
  toolsFailed: 0,
  modelCalls: 0,
  tokens: 0,
  cost: 0,
  // Of those tokens, how many went to each model - see `mainModelOf` on why
  // a session needs this and not just the list of names in `models`.
  modelTokens: {},
  sandboxMs: 0,
  // How many times a person spoke to it, and what each of those two sides
  // of the conversation cost in wall-clock time. A session with one turn
  // is one somebody asked once and walked away from; a session with nine
  // is one they sat with, and the two are not the same tool however alike
  // their outcomes look. `personMs` is the agent waiting for the person -
  // the part of an hour nobody bills for and everybody feels.
  turns: 0,
  agentMs: 0,
  personMs: 0,
  // What kind of steer each re-prompt was, by the words in it
  // (steer-kinds.js): `{ correct: 2, clarify: 1 }`. A kind, never the
  // words - the record's rule holds here as everywhere.
  steers: {},
  // What got in the agent's way: how each failed call failed, by kind
  // (friction.js `ERROR_KINDS`), how many turns ended with the work handed
  // back to a person, and which shell commands it ran over and over. A
  // kind, a count and the command's own title - never the failing output,
  // which stays on the log where the words rule governs who reads it.
  friction: { errors: {}, handBacks: 0, repeats: [] },
  // How much code it wrote: lines, from the input of every editing tool
  // call its hooks reported (`noteEdit`). Lines written, not lines in the
  // tree - a file written and then rewritten counts twice, because what is
  // being measured is the work, and what became of it is `edits.accepted`.
  linesAdded: 0,
  linesRemoved: 0,
  edits: 0,
  guidance: { humanLines: 0, followUps: 0, retries: 0, failedTools: 0, reviewRounds: 0, interrupts: 0 },
});

/**
 * How much steering a session took, as counts. Read this way rather than
 * `record.counts.guidance` because a record written before a signal existed
 * has no key for it, and "0" is what its absence means.
 */
export function guidanceOf(record) {
  const guidance = record?.counts?.guidance ?? {};
  return {
    humanLines: guidance.humanLines ?? 0,
    followUps: guidance.followUps ?? 0,
    retries: guidance.retries ?? 0,
    failedTools: guidance.failedTools ?? 0,
    reviewRounds: guidance.reviewRounds ?? 0,
    interrupts: guidance.interrupts ?? 0,
  };
}

/**
 * The turns and the clock, read the same defensive way: a record written
 * before any of this existed has no key for it, and nought is what that
 * means. `steers` comes back as a plain object so a caller can total it
 * without checking whether the record ever had one.
 */
export function autonomyOf(record) {
  const counts = record?.counts ?? {};
  const steers = counts.steers && typeof counts.steers === "object" ? counts.steers : {};
  return {
    turns: counts.turns ?? 0,
    agentMs: counts.agentMs ?? 0,
    personMs: counts.personMs ?? 0,
    steers: { ...steers },
  };
}

/**
 * The model a session's work was done with: the one that spent the most of
 * its tokens.
 *
 * Not `models[0]`, which is what every surface used to read and which is
 * the first model to *answer* - a different thing, and on Claude Code
 * reliably the wrong one. Claude Code opens a session with a small call to
 * Haiku of its own before the person's work reaches the model they picked,
 * so the first name on the list was Haiku on fifty-two of fifty-five
 * sessions on this installation, and the Performance page said Haiku had
 * done work that Opus and Fable did. Tokens are the honest tie-break: the
 * model a session spent its tokens on is the model it was thinking with,
 * and a title call is a rounding error against a day's work.
 *
 * Falls back to the first name for a record written before the tokens were
 * kept by model, and to null for one that reported no model at all - which
 * is left off the Performance charts rather than being guessed at
 * (performance.js `UNREPORTED`).
 */
export function mainModelOf(session) {
  const byModel = session?.counts?.modelTokens;
  if (byModel && typeof byModel === "object") {
    let best = null;
    for (const [model, spent] of Object.entries(byModel)) {
      if (!(Number(spent) > 0)) continue;
      // A tie goes to the name that sorts first, so the answer does not
      // depend on the order an object happens to have been built in.
      if (!best || spent > best[1] || (spent === best[1] && model < best[0])) best = [model, spent];
    }
    if (best) return best[0];
  }
  return session?.models?.[0] ?? null;
}

/**
 * What came of a session with these pull requests: the best of them. A
 * session that opened two, one merged and one closed, produced merged work -
 * the closed one was the draft it did not need. Null when it opened none.
 */
export function outcomeOfPulls(pulls) {
  // Ahead of merged: a merge somebody took back out is not the outcome
  // "merged" with a footnote, it is work that did not stay. The Activity
  // chip says so in its own word (console-home.js OUTCOMES), and the
  // ranking scores it as undone (performance.js `pullVerdict`).
  //
  // A merge rolled out of production (pulls.js `noteRolledBack`) says the
  // same word. It is a different event - the branch still has the code -
  // but the reader's question is "did this stay", and for both the answer
  // is no; a ninth word for it would split one fact across two chips.
  if ((pulls ?? []).some((pull) => pull?.state === "merged" && (pull.reverted || pull.rolledBack))) return "reverted";
  const states = new Set((pulls ?? []).map((pull) => pull?.state));
  if (states.has("merged")) return "merged";
  if (states.has("open")) return "open";
  if (states.has("closed")) return "closed";
  return null;
}

/** Rounds of review across the session's pull requests: each "changes requested" is one. */
const reviewRoundsOf = (pulls) => (pulls ?? []).reduce((sum, pull) => sum + (pull?.changesRequested ?? 0), 0);

/**
 * Take a pull request's summary onto a record - new, or replacing what the
 * record held for the same one - and let the outcome and the review count
 * follow. Pure over the record; the callers persist. Returns whether
 * anything changed.
 */
function foldPull(record, pull, outcome) {
  let changed = false;
  if (pull?.id) {
    const pulls = record.pulls ?? (record.pulls = []);
    const index = pulls.findIndex((entry) => entry.id === pull.id);
    if (index < 0) {
      pulls.push(pull);
      changed = true;
    } else if (JSON.stringify(pulls[index]) !== JSON.stringify(pull)) {
      pulls[index] = pull;
      changed = true;
    }
    if (!record.counts.guidance) record.counts.guidance = emptyCounts().guidance;
    const rounds = reviewRoundsOf(pulls);
    if (rounds !== (record.counts.guidance.reviewRounds ?? 0)) {
      record.counts.guidance.reviewRounds = rounds;
      changed = true;
    }
  }
  // The pulls decide when there are any; the caller's word stands when the
  // outcome was learnt some other way.
  const next = outcomeOfPulls(record.pulls) ?? outcome ?? record.outcome;
  if (next !== record.outcome) {
    record.outcome = next;
    changed = true;
  }
  return changed;
}

/**
 * Start a session. `actor` is who is working: `{ kind: "agent"|"person"|
 * "harness"|"external", id, name }`. `machine` is the sandbox it works on
 * when the caller knows it; a span naming one fills it in otherwise.
 * `trigger` is what set it off; when the caller does not say, whatever
 * `setOff` left for this actor is taken. Returns the record; the root span
 * is started the first time `contextFor` is asked for it.
 */
export function open({
  kind, owner = null, actor, harness = null, repoId = null, repo = null, branch = null, key = null,
  machine = null, trigger = null, at = Date.now(),
}) {
  if (!KINDS.includes(kind)) throw new Error(`Not a session kind: ${kind}`);
  const record = {
    id: newId(),
    kind,
    // What the outside world calls this session, when it has a name for it
    // - a harness's own session id, prefixed by the harness - so the next
    // batch of its events finds the same record (`byKey`).
    ...(key ? { key: String(key) } : {}),
    owner,
    actor: { kind: actor?.kind ?? kind, id: actor?.id ?? null, name: actor?.name ?? null },
    harness,
    repoId,
    repo,
    branch,
    machine: cleanMachine(machine),
    trigger: cleanTrigger(trigger) ?? takePending(actor?.id, at),
    startedAt: at,
    lastSeenAt: at,
    endedAt: null,
    state: "live",
    taskIds: [],
    traceIds: [],
    counts: emptyCounts(),
    // The models it called, by name, in the order first seen - see `count`.
    // A name, not a count: the Home card says which model a session is on,
    // and a session is nearly always on one.
    models: [],
    pulls: [],
    // The files the work landed on, by path - see `noteFile`. Paths only:
    // what changed in them is the pull request's to show, never this app's.
    files: [],
    filesTouched: 0,
    // What it wrote, and what survived: a fingerprint of every distinct
    // line it wrote, packed (attribution.js), and - once a pull request of
    // its has merged - how many of those lines were in the merged diff.
    // Fingerprints, never the lines: see `noteEdit`.
    edits: { hashes: "", accepted: null, at: null },
    // The Slack threads the work spoke into - see `noteThread`. Addresses
    // only: the words are Slack's, and stay there.
    threads: [],
    outcome: null,
    // What it was for, in the asker's words - see the essay, and `noteTitle`.
    title: null,
  };
  records.set(record.id, record);
  // Woken by a task somebody asked for in a Slack thread: that thread is
  // this session's, and the person waiting in it is waiting for this work.
  if (record.trigger?.kind === "task" && record.trigger.id) {
    const waiting = threadOfTask(record.trigger.id);
    if (waiting) record.threads.push(waiting);
  }
  persist(record.id, { now: true });
  // The first line of the session's log: it is running. The loop says what
  // on, per task, as it goes; a harness on a laptop says nothing more.
  sessionEvents.append(record.id, "platform.status", { status: "running" }, { at });
  return record;
}

/** The context to make this session's calls in - its root span, with the ids every child inherits. */
export function contextFor(id) {
  const record = records.get(id);
  if (!record) return sessionContext(id);
  return sessionContext(id, {
    "cv.agent.id": record.actor.id,
    "cv.agent.name": record.actor.name,
    "cv.agent.kind": record.kind,
    "cv.owner": record.owner,
    "cv.repo.id": record.repoId,
    "cv.harness.id": record.harness?.id,
    "cv.harness.kind": record.harness?.kind,
  });
}

/**
 * The session was heard from. Written, a moment later and once for however
 * many touches land in that moment: `lastSeenAt` is what decides whether a
 * session is still working, and a process that reads it from the store -
 * the next one, after a deploy (`warm`) - would otherwise take an hour of
 * hook events for a session last seen when it opened.
 */
export function touch(id, at = Date.now()) {
  const record = records.get(id);
  if (!record || record.state !== "live") return null;
  if (at > record.lastSeenAt) {
    record.lastSeenAt = at;
    persist(id);
  }
  return record;
}

/** Note a task the session worked on; it is how a task's spans and its session find each other. */
export function noteTask(id, taskId) {
  const record = records.get(id);
  if (!record || !taskId || record.taskIds.includes(taskId)) return;
  if (record.taskIds.length < MAX_TASKS) record.taskIds.push(taskId);
  persist(id);
  // If this task was asked for in a Slack thread, that thread is this
  // session's too - the person waiting in it is waiting for this work.
  const waiting = threadOfTask(taskId);
  if (waiting) noteThread(id, waiting);
}

/**
 * Note a pull request the session produced, or what has since become of
 * one it already noted - the summary is replaced, not skipped, because a
 * review round is a change to the same pull request.
 */
export function notePull(id, pull) {
  const record = records.get(id);
  if (!record || !pull?.id) return;
  if (foldPull(record, pull, null)) persist(id, { now: true });
}

/**
 * Note the machine the session works on. The first one named stands: a
 * session is where its agent sits, and a command it ran on some other
 * machine through the fleet tools does not move it.
 */
export function noteMachine(id, machine) {
  const record = records.get(id);
  const clean = cleanMachine(machine);
  if (!record || !clean || record.machine) return;
  record.machine = clean;
  persist(id, { now: true });
}

/**
 * Note a file the session's work landed on.
 *
 * The `PostToolUse` hook reports the path of every edit and write
 * (setup-script.js, the `report` script), which is one thing the OpenTelemetry
 * export cannot say: its `tool_result` event names the tool and whether it
 * succeeded, never what it was pointed at. Knowing that a session spent its
 * afternoon in `server/` is the difference between a row on the Performance
 * page and something a person can recognise as their own work.
 *
 * A path repeated is not a second file - an agent edits the same file nine
 * times - so the list is a set, and `filesTouched` counts the distinct ones
 * past the point the list stops growing.
 */
export function noteFile(id, file) {
  const record = records.get(id);
  const path = String(file ?? "").trim().slice(0, 400);
  if (!record || !path) return null;
  // A record written before this existed has no list; it grows one.
  if (!Array.isArray(record.files)) record.files = [];
  if (record.files.includes(path)) return null;
  record.filesTouched = (record.filesTouched ?? 0) + 1;
  if (record.files.length < MAX_FILES) record.files.push(path);
  persist(id);
  return record;
}

/**
 * Whether a tool call's title is a path rather than a sentence about one.
 *
 * A harness that reports its calls the ACP way titles an edit with the file
 * it edited - that *is* the title. This app's own tools title theirs in
 * words ("Committing 3 files to ada/engine main"), and taking one of those
 * for a path would put a sentence in the list of files. So: no spaces, and
 * either a directory in it or an extension on it.
 */
const PATH_TITLE = /^[^\s"']+\.[A-Za-z0-9]{1,12}$|^[^\s"']*\/[^\s"']+$/;

/**
 * The same fact from the other side, for the sessions the hooks cannot
 * reach: a sandbox agent, or one driven over ACP, reports its tool calls
 * onto the session log (session-events.js) and never runs `setup.sh`, so
 * every one of them had `filesTouched` of nought - which reads as "it never
 * touched the code" and is why a killed sandbox session scored as research
 * rather than as discarded work (performance.js `yieldOf`).
 *
 * A log entry, not a new sensor: an `edit` tool call whose title is a path
 * is the same fact the hook sends, arriving by the only road those sessions
 * have. Subscribed once, here, because this is the module the fact belongs
 * to and session-events.js must not import it back.
 */
sessionEvents.subscribe((entry) => {
  if (entry?.kind !== "tool_call" || entry.toolKind !== "edit") return;
  const title = String(entry.title ?? "").trim();
  if (!title || !PATH_TITLE.test(title)) return;
  noteFile(entry.session, title);
});

/**
 * How much code one editing call wrote, and the fingerprints of the lines
 * it wrote.
 *
 * The counts are what the Performance page divides by; the fingerprints are
 * what says, when a pull request of this session's merges, how much of what
 * it wrote actually landed (attribution.js, pull-aftermath.js
 * `measureAcceptance`).
 *
 * **Numbers and hashes in, never lines.** The caller counts and
 * fingerprints (telemetry-ingest.js `done`, where the tool input already
 * is), and this module - which is the durable record - never sees a line of
 * anybody's code. That is the same shape `steered` keeps for the same
 * reason: the record's rule is enforced by what this function can be given,
 * not by everybody remembering it.
 *
 * The set is capped (`MAX_HASHES`): a session past it is measured on a
 * stable sample of its lines, and its acceptance is a floor rather than the
 * figure.
 *
 * @param {string} id
 * @param {{added?: number, removed?: number, hashes?: Iterable<number>}} counted
 */
export function noteEdit(id, { added = 0, removed = 0, hashes = [] } = {}) {
  const record = records.get(id);
  if (!record) return null;
  if (!record.counts) record.counts = emptyCounts();
  const lines = Number(added);
  const gone = Number(removed);
  record.counts.linesAdded = (record.counts.linesAdded ?? 0) + (Number.isFinite(lines) && lines > 0 ? Math.round(lines) : 0);
  record.counts.linesRemoved = (record.counts.linesRemoved ?? 0) + (Number.isFinite(gone) && gone > 0 ? Math.round(gone) : 0);
  record.counts.edits = (record.counts.edits ?? 0) + 1;
  const held = record.edits && typeof record.edits === "object" ? record.edits : { hashes: "", accepted: null, at: null };
  const set = unpack(held.hashes);
  if (set.size < MAX_HASHES) {
    for (const hash of hashes ?? []) {
      set.add(hash);
      if (set.size >= MAX_HASHES) break;
    }
  }
  record.edits = { ...held, hashes: pack(set) };
  persist(id);
  return record;
}

/**
 * How much of what a session wrote was in a merged diff, learnt at the
 * merge - which may be days after the session ended, so a forgotten one is
 * read from the store, changed and written back, the way `recordOutcome`
 * does for the same reason.
 *
 * The share is not stored. `accepted / linesAdded` is one division, and a
 * ratio kept beside its two operands is a ratio that goes stale the first
 * time either of them moves.
 */
export async function noteAccepted(id, { accepted = 0, pull = null, at = Date.now() } = {}) {
  const lines = Number(accepted);
  if (!Number.isFinite(lines) || lines < 0) return null;
  const write = (record) => {
    const held = record.edits && typeof record.edits === "object" ? record.edits : { hashes: "", accepted: null, at: null };
    // Two merged pull requests from one session are two lots of accepted
    // lines, not the second replacing the first.
    record.edits = { ...held, accepted: (held.accepted ?? 0) + Math.round(lines), at, ...(pull ? { pull } : {}) };
    return record;
  };
  const live = records.get(id);
  if (live) {
    write(live);
    persist(id, { now: true });
    return live;
  }
  if (!store.loadSession || !store.putSession) return null;
  const stored = await store.loadSession(id);
  if (!stored) return null;
  await store.putSession(write(stored));
  return stored;
}

/**
 * task id -> the Slack thread the work was asked in, waiting for whichever
 * session takes that task.
 *
 * A tag in a channel becomes a task (the Slack app, slack-relay/), and the
 * session that does the work starts minutes later on somebody's machine -
 * so at the moment the thread is known there is no session to put it on,
 * and by the time the session exists nobody remembers the thread. This is
 * that gap, and it is the same shape as `pending` above: the fact waits
 * for the record, and the record takes it when it opens.
 *
 * What joins the two is the session's **trigger**. A task sent to a
 * sleeping agent leaves a pending trigger for it (guidance.js `noteTask`),
 * and `open` puts that on the record - so `trigger.kind === "task"` and its
 * id is how a session says which task it woke up to do. `taskIds` would
 * read as the better join and is not: nothing in the server writes to it.
 *
 * Kept rather than consumed. A task retried is a second session doing the
 * work somebody asked for in that thread, and it is the same thread; a
 * page that showed it only on the first attempt would be wrong about the
 * one people are actually reading.
 */
const threadsByTask = new Map();
/** A task nobody has taken in a day is not one this thread is still waiting for. */
const THREAD_WAIT_MS = 24 * 60 * 60 * 1000;

/**
 * Remember the thread a task was asked in, for the sessions that take it -
 * the one working on it now, and any retry after.
 */
export function threadForTask(taskId, thread) {
  const clean = cleanThread(thread);
  if (!taskId || !clean) return null;
  const now = Date.now();
  for (const [held, entry] of threadsByTask) {
    if (now - entry.at > THREAD_WAIT_MS) threadsByTask.delete(held);
  }
  threadsByTask.set(String(taskId), clean);
  // A session already on this task gets it now rather than never: the
  // agent may have woken and opened its session before the Slack app got
  // round to saying where the work came from.
  for (const record of records.values()) {
    if (holdsTask(record, taskId)) noteThread(record.id, clean);
  }
  return clean;
}

/** Whether this session is the one doing that task - by what woke it, or by what it has taken since. */
function holdsTask(record, taskId) {
  const wanted = String(taskId);
  if (record.trigger?.kind === "task" && String(record.trigger.id) === wanted) return true;
  return Boolean(record.taskIds?.includes(wanted));
}

/** The thread a task was asked in, if it was asked in one. */
export function threadOfTask(taskId) {
  const entry = threadsByTask.get(String(taskId));
  if (!entry) return null;
  if (Date.now() - entry.at > THREAD_WAIT_MS) {
    threadsByTask.delete(String(taskId));
    return null;
  }
  return entry;
}

/**
 * Note a Slack thread the session's work spoke into.
 *
 * People set agents going from Slack - a tag in a channel, a question in a
 * thread - and then read the answer in that thread and nowhere else. The
 * session that did the work is here, and until this there was no way back
 * from one to the other: the console could not say which thread an agent
 * had answered in, and Slack could not say which session had answered.
 * This is the first half, and the cheap half - the agent posts through the
 * Slack connector, and the connector says so on its way out
 * (connectors/slack.js), so nothing has to be guessed and no agent has to
 * remember to declare anything.
 *
 * The same thread twice is one thread: an agent that posts a start and a
 * finish into one thread interacted with one thread, and a page that listed
 * it twice would be reporting how chatty the agent was, which is not what
 * the panel is for.
 */
export function noteThread(id, thread) {
  const record = records.get(id);
  const clean = cleanThread(thread);
  if (!record || !clean) return null;
  // A record written before this existed has no list; it grows one.
  if (!Array.isArray(record.threads)) record.threads = [];
  const already = record.threads.some((held) => held.channel === clean.channel && held.ts === clean.ts);
  if (already || record.threads.length >= MAX_THREADS) return null;
  record.threads.push(clean);
  persist(id, { now: true });
  return clean;
}

/** Note what set the session off, for a caller that learns it after opening. The first word stands. */
export function noteTrigger(id, trigger) {
  const record = records.get(id);
  const clean = cleanTrigger(trigger);
  if (!record || !clean || record.trigger) return;
  record.trigger = clean;
  persist(id, { now: true });
}

/** How long a title gets. A row's name, not its summary; the words are on the session page. */
export const MAX_TITLE = 60;

/**
 * A title from a prompt: its first line that says anything, with the
 * whitespace folded, cut at a word when it runs long. The whole prompt is
 * often a paragraph, and a paragraph's first sentence is what a person
 * would type as the name of the work if they were asked to.
 */
export function titleOf(text) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((entry) => entry.replace(/\s+/g, " ").trim())
    .find(Boolean);
  if (!line) return null;
  if (line.length <= MAX_TITLE) return line;
  const room = line.slice(0, MAX_TITLE - 1);
  const atWord = room.lastIndexOf(" ");
  return `${(atWord > MAX_TITLE / 2 ? room.slice(0, atWord) : room).trimEnd()}…`;
}

/**
 * Name the session after its ask, until the agent names it.
 *
 * The first prompt is what the session is for, and its first line is the
 * name the moment it lands - a row with no name reads as a session with no
 * ask. It is a placeholder: the agent doing the work says what the work is
 * for (`nameSession`), and that replaces it. A later prompt is a follow-up
 * and does not rename the session - a row renamed under its reader at each
 * turn is a row nobody can find again.
 */
export function noteTitle(id, text) {
  const record = records.get(id);
  if (!record || record.title) return;
  rename(id, titleOf(text));
}

/**
 * The agent's own word for what the session is for - the `name_session`
 * tool (collab-tools.js). It has read the ask and knows what it is doing,
 * which is more than the first line of the ask says; and when the work
 * turns into something else, it says so again and the name follows.
 * Replaces whatever the name was. Returns the name as kept, or null when
 * there was nothing to keep.
 */
export function nameSession(id, text) {
  const record = records.get(id);
  const title = titleOf(text);
  if (!record || !title) return null;
  rename(id, title);
  return record.title;
}

/** Put a name on the record, cut like any title, and nudge the pages showing it. */
function rename(id, name) {
  const record = records.get(id);
  const title = titleOf(name);
  if (!record || !title || record.title === title) return;
  record.title = title;
  persist(id, { now: true });
  publish("session.title", { owner: record.owner, repoId: record.repoId }, { sessionId: id });
}

/** Note the repository and branch the session's work went to. */
export function noteBranch(id, { repo = null, branch = null, repoId = null, host = "github" } = {}) {
  const record = records.get(id);
  if (!record) return;
  // `host` is which of the three git hosts the remote was on
  // (git-hosts/index.js `parseRemote`). `kind` stays what it was: it says
  // this is a repository reference rather than anything else, and every
  // record written before there was a choice of host is GitHub's.
  if (repo && !record.repo) record.repo = { kind: "github", fullName: repo, host: host ?? "github" };
  // The repo here that the checkout is of (repos.js checkoutFor), when the
  // hook's remote names one: what puts a laptop's session in a workspace.
  if (repoId && !record.repoId) record.repoId = repoId;
  if (branch) record.branch = branch;
  persist(id, { now: true });
}

/**
 * An outcome learnt after the fact - the pull request a session opened got
 * merged, days later, when the session may be long gone from memory. The
 * live session takes it in place; a forgotten one is read from the store,
 * changed, and written back.
 */
export async function recordOutcome(id, outcome, { pull = null } = {}) {
  const record = records.get(id);
  if (record) {
    if (foldPull(record, pull, outcome)) persist(id, { now: true });
    return record;
  }
  if (!store.loadSession || !store.putSession) return null;
  const stored = await store.loadSession(id);
  if (!stored) return null;
  if (!stored.counts) stored.counts = emptyCounts();
  if (foldPull(stored, pull, outcome)) await store.putSession(stored);
  return stored;
}

/** Count one guidance signal - a line from a person, a follow-up, a retry. */
export function guided(id, signal, by = 1) {
  const record = records.get(id);
  const step = Number(by);
  // A step that is not a positive number would turn the count into a
  // string, and the score into NaN, quietly and durably. Refused instead.
  if (!record || !(signal in emptyCounts().guidance) || !Number.isFinite(step) || step <= 0) return null;
  record.counts.guidance[signal] = (record.counts.guidance[signal] ?? 0) + step;
  persist(id);
  return record;
}

/**
 * One more turn: a person said something to this session and the agent went
 * to work on it. Counted apart from `humanLines` because the two answer
 * different questions - how much steering, and how many times round - and
 * because a turn is the denominator the one-shot figures stand on
 * (performance.js).
 */
export function turned(id) {
  const record = records.get(id);
  if (!record) return null;
  if (!record.counts) record.counts = emptyCounts();
  record.counts.turns = (record.counts.turns ?? 0) + 1;
  persist(id);
  return record;
}

/**
 * Where a stretch of the session's wall clock went: the agent working, or
 * the agent waiting for a person to come back. Milliseconds, added; a
 * negative or nonsense step is refused rather than turned into NaN on a
 * durable record, the same rule `guided` keeps.
 */
export function spent(id, { agentMs = 0, personMs = 0 } = {}) {
  const record = records.get(id);
  if (!record) return null;
  if (!record.counts) record.counts = emptyCounts();
  let changed = false;
  for (const [key, value] of [["agentMs", agentMs], ["personMs", personMs]]) {
    const step = Number(value);
    if (!Number.isFinite(step) || step <= 0) continue;
    record.counts[key] = (record.counts[key] ?? 0) + Math.round(step);
    changed = true;
  }
  if (changed) persist(id);
  return changed ? record : null;
}

/**
 * What kind of steer a re-prompt was, as one word (steer-kinds.js `KINDS`).
 * The classifier arrives after the prompt it read, so this lands late and
 * on its own; a session whose installation has no model to ask keeps no
 * kinds at all, and the page says "unclassified" rather than nought.
 *
 * `allowed` is the vocabulary, and it is required rather than defaulted.
 * The word on the other end of this comes from a model - the one thing in
 * this system that will one day answer something nobody planned for - and
 * it lands on a durable record that pages then group by. A vocabulary fixed
 * here is fixed everywhere it is read; a vocabulary fixed only in the
 * classifier is fixed only until the next caller. So an unknown word is
 * refused, and a caller that names no vocabulary writes nothing at all:
 * forgetting the list must fail closed, not quietly permit anything.
 *
 * The list is handed in rather than imported because this module is where
 * the record lives and it stays a leaf. Importing steer-kinds.js would pull
 * ask-model.js, models.js and secrets.js into the graph of every module
 * that touches a session, for the sake of a six-word array, and would have
 * the record layer depending on the classifier that feeds it.
 *
 * @param {string} id
 * @param {string} kind one word
 * @param {string[]|Set<string>} allowed the kinds a record may hold
 */
export function steered(id, kind, allowed) {
  const record = records.get(id);
  const word = String(kind ?? "").trim();
  const vocabulary = allowed instanceof Set ? allowed : new Set(Array.isArray(allowed) ? allowed : []);
  if (!record || !vocabulary.has(word)) return null;
  if (!record.counts) record.counts = emptyCounts();
  if (!record.counts.steers || typeof record.counts.steers !== "object") record.counts.steers = {};
  record.counts.steers[word] = (record.counts.steers[word] ?? 0) + 1;
  persist(id);
  return record;
}

/** The friction counts of a record, made if the record predates them. */
function frictionCounts(record) {
  if (!record.counts) record.counts = emptyCounts();
  const own = record.counts.friction;
  if (!own || typeof own !== "object") record.counts.friction = { errors: {}, handBacks: 0, repeats: [] };
  else {
    if (!own.errors || typeof own.errors !== "object") own.errors = {};
    if (!Array.isArray(own.repeats)) own.repeats = [];
  }
  return record.counts.friction;
}

/**
 * A tool call failed, and this is the kind of failure it was
 * (friction.js `ERROR_KINDS`). The kind, never the line: what a person
 * needs from a hundred of these is "no such file, fourteen times, here
 * are three sessions", and the line itself is already on the log where
 * the words rule says who may read it.
 */
export function frictioned(id, kind) {
  const record = records.get(id);
  const word = String(kind ?? "").trim();
  if (!record || !(word in ERROR_KINDS)) return null;
  const friction = frictionCounts(record);
  friction.errors[word] = (friction.errors[word] ?? 0) + 1;
  persist(id);
  return record;
}

/**
 * A turn ended with the work back in the person's court - the agent asked
 * something rather than finishing (friction.js `isHandBack`). Counted
 * apart from the steering signals because it is the other side of the
 * same afternoon: a follow-up is the person coming back, a hand-back is
 * the agent stopping to wait for them.
 */
export function handedBack(id) {
  const record = records.get(id);
  if (!record) return null;
  const friction = frictionCounts(record);
  friction.handBacks = (friction.handBacks ?? 0) + 1;
  persist(id);
  return record;
}

/**
 * One more run of a shell command. Every run is tallied, not only the
 * third: a repeat cannot be recognised without having counted the runs
 * before it. What is a *signal* is the ones that reached three
 * (friction.js `repeatsOf`), and the report only reads those.
 *
 * What is kept is the command's fingerprint, never the command
 * (friction.js `fingerprint`). This record is everyone's to read across
 * the installation - counts, ids and names, and never a tool's input, per
 * the essay at the top of this file - and a command line is exactly a
 * tool's input: it can carry a path with somebody's home directory in it,
 * a hostname, a token in an env prefix. The words are on the session's own
 * log, where the words rule says who may read them, and whoever draws the
 * report looks them up there for a reader entitled to them.
 *
 * Bounded: `MAX_COMMANDS` distinct commands a session, and the line is cut
 * to `MAX_REPEAT_TITLE` before it is hashed so both sides of that lookup
 * hash the same string.
 */
export function repeated(id, title) {
  const record = records.get(id);
  const text = String(title ?? "").trim();
  if (!record || !text) return null;
  const hash = commandHash(text);
  const friction = frictionCounts(record);
  const own = friction.repeats.find((entry) => entry.hash === hash);
  if (own) own.times += 1;
  else if (friction.repeats.length < MAX_COMMANDS) friction.repeats.push({ hash, times: 1 });
  else return null;
  persist(id);
  return record;
}

/**
 * End a session. Idempotent: an ended one keeps its end time, but takes an
 * outcome learnt later - the pull request a session opened is merged days
 * after the session is over, and that is the outcome that matters.
 */
export function end(id, { outcome = null, at = Date.now() } = {}) {
  const record = records.get(id);
  if (!record) return null;
  if (record.state === "ended") {
    if (outcome && outcome !== record.outcome) {
      record.outcome = outcome;
      persist(id, { now: true });
    }
    return record;
  }
  record.state = "ended";
  record.endedAt = at;
  if (outcome) record.outcome = outcome;
  endRoot(id);
  persist(id, { now: true });
  sessionEvents.append(id, "platform.status", { status: "finished", ...(outcome ? { reason: outcome } : {}) }, { at });
  return record;
}

/** Whether a session is in memory and live - the synchronous question a caller mid-request asks. */
export const isLive = (id) => records.get(id)?.state === "live";

/** A session by id: memory first, then the store. */
export async function get(id) {
  return records.get(id) ?? (store.loadSession ? await store.loadSession(id) : null) ?? null;
}

/** What is in memory right now, live first, newest first. */
export function inMemory() {
  return [...records.values()].sort((a, b) => (a.state === b.state ? b.startedAt - a.startedAt : a.state === "live" ? -1 : 1));
}

/**
 * The session the outside world calls `key`: the live one in memory; else
 * the one that ended - in memory, or in the store's last day for the owner
 * - taken back live, because a harness that speaks again after fifteen
 * quiet minutes is continuing its session, not starting another. Ending
 * the idle early is only safe because of this: what the sweep called
 * finished is updated the moment there is more to say.
 *
 * Taken back live only for something that happened after the end: `at`
 * is when the caller's event happened, and an event from before the end -
 * a harness's exporter flushing the last log lines of a session that was
 * just cleared - counts on the finished session without reopening it.
 * `revive: false` is for a caller that knows better still: the `end` hook
 * itself, and metrics, which a harness re-exports for as long as it runs
 * and which say nothing about whether anyone is working.
 *
 * A record found in the store is taken back into memory, so the events
 * that follow count on it.
 */
export async function byKey(key, { owner = null, at = Date.now(), revive = true } = {}) {
  if (!key) return null;
  let found = null;
  for (const record of records.values()) {
    if (record.key !== key) continue;
    if (record.state === "live") return record;
    if (!found || (record.endedAt ?? 0) > (found.endedAt ?? 0)) found = record;
  }
  if (!found && store.loadSessions) {
    const stored = await store.loadSessions({ owner, since: at - RESUME_MS, limit: 500 }).catch(() => []);
    found = stored.find((record) => record.key === key) ?? null;
    if (found) {
      // Another process may have taken it live meanwhile; what is in memory
      // here is what this process was told.
      if (!found.counts) found.counts = emptyCounts();
      records.set(found.id, found);
    }
  }
  if (!found) return null;
  if (found.state === "live" || !revive || at <= (found.endedAt ?? 0)) return found;
  return reviveSession(found.id, at);
}

/**
 * An ended session heard from again is live again: the end is undone, the
 * outcome it was given stands until the pull requests say otherwise, and
 * the log says it is running once more. Returns the record.
 */
export function revive(id, at = Date.now()) {
  return reviveSession(id, at);
}

function reviveSession(id, at) {
  const record = records.get(id);
  if (!record) return null;
  if (record.state === "live") return record;
  record.state = "live";
  record.endedAt = null;
  if (at > record.lastSeenAt) record.lastSeenAt = at;
  persist(id, { now: true });
  sessionEvents.append(id, "platform.status", { status: "running", reason: "resumed" }, { at });
  return record;
}

/** Sessions on one machine, in memory and the store, newest first - the machine page's "who worked here". */
/**
 * The id a session holds for the machine it ran on: the platform and the
 * name the hook gave, as one string. These are not records this app made,
 * so the name is the id - and it is made here, once, so that whoever asks
 * for a machine's sessions (the setup route, the ingest, the e2b tools)
 * asks by the same id the ingest stored.
 */
export const machineIdOf = (host, name) => `${host}:${name}`;

export async function forMachine(machineId, { since = 0, limit = 50 } = {}) {
  if (!machineId) return [];
  const all = await list({ since, limit: 1000 });
  return all.filter((record) => record.machine?.id === machineId).slice(0, limit);
}

/**
 * Which sessions worked on which tasks, for a set of tasks at once: one read
 * for a whole Tasks tab. A session names its tasks (`taskIds`), so the join
 * is here; what a task gets is the session's id and who was in it, which is
 * the link to the session page and nothing that page would not show.
 *
 * @returns {Promise<Map<string, {id: string, actor: object, state: string, startedAt: number}[]>>} task id -> sessions, newest first
 */
export async function byTask(taskIds, { since = 0 } = {}) {
  const wanted = new Set([taskIds].flat().filter(Boolean).map(String));
  const out = new Map();
  if (!wanted.size) return out;
  for (const record of await list({ since, limit: 1000 })) {
    for (const taskId of record.taskIds ?? []) {
      if (!wanted.has(taskId)) continue;
      if (!out.has(taskId)) out.set(taskId, []);
      out.get(taskId).push({ id: record.id, actor: record.actor, kind: record.kind, state: record.state, startedAt: record.startedAt });
    }
  }
  return out;
}

/**
 * The GitHub repository a person's own harness is checked out in right now:
 * the live harness session of theirs most recently *started* whose start
 * hook named a remote (telemetry-ingest.js `noteHook`). Null when none has -
 * a session opened from the MCP side names no checkout, and is not one.
 *
 * Started, not heard from. This is read when a fresh MCP session makes its
 * first tool call (mcp.js `atCheckout`), and the Claude Code that opened
 * it is the one that started last; a person with three terminals open has
 * older sessions in other checkouts that are heard from every few seconds
 * as they work, and the most recently heard from is whichever of those
 * happened to run a tool last - which put a setup opened in codervibes in
 * chessterm because a chessterm session was busy at that moment.
 *
 * Memory only, like `liveFor`: the hook that named the checkout landed in
 * this process moments ago, and a session the store alone remembers is not
 * one anybody is typing in.
 */
export function checkoutOf(owner) {
  let found = null;
  for (const record of records.values()) {
    if (record.state !== "live" || record.kind !== "harness" || record.owner !== owner) continue;
    if (!record.repo?.fullName) continue;
    if (!found || record.startedAt > found.startedAt) found = record;
  }
  return found?.repo.fullName ?? null;
}

/** The live session of one actor, the most recently started when it has several. */
export function liveFor(actorId) {
  let found = null;
  for (const record of records.values()) {
    if (record.state !== "live" || record.actor.id !== actorId) continue;
    if (!found || record.startedAt > found.startedAt) found = record;
  }
  return found;
}

/** Sessions started since a moment, memory and store together, newest first. */
export async function list({ owner = null, since = 0, limit = 200, now = Date.now() } = {}) {
  const seen = new Map();
  for (const record of records.values()) {
    if (record.startedAt >= since && (!owner || record.owner === owner)) seen.set(record.id, record);
  }
  if (store.loadSessions) {
    try {
      for (const record of await store.loadSessions({ owner, since, limit })) {
        if (seen.has(record.id)) continue;
        // A session the store calls live that memory does not know is one
        // no sweep is watching (`warm` says how that happens). It is taken
        // in here and, if it has been quiet past the idle mark, ended on
        // the spot - so no page reads "working now" off a record that only
        // the store remembers, whatever this process has or has not done
        // since it booted.
        seen.set(record.id, record.state === "live" && !records.has(record.id) ? take(record, now) : (records.get(record.id) ?? record));
      }
    } catch (err) {
      console.warn(`sessions: could not read the store: ${err.message}`);
    }
  }
  return [...seen.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
}

/**
 * Take a stored record into memory, and end it there and then if it has
 * been quiet longer than a live session is allowed to be - at the moment it
 * should have ended, the way the sweep would have. Returns the record as
 * memory now holds it.
 */
function take(record, now = Date.now()) {
  if (!record.counts) record.counts = emptyCounts();
  records.set(record.id, record);
  if (record.state === "live" && now - record.lastSeenAt > IDLE_MS) end(record.id, { at: record.lastSeenAt + IDLE_MS });
  return record;
}

/**
 * How far back the store is read at boot for sessions it still calls live:
 * as far as the Home page shows, so nothing it lists as working is beyond
 * the sweep's reach.
 */
const WARM_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Take the sessions the store still calls live back into memory, so the
 * sweep can end them. The sweep walks memory, and a deploy empties memory:
 * every session that was live when the old process stopped stayed "live"
 * in the store with nobody left to notice it had gone quiet - twenty-eight
 * of them on the Home page one evening, most hours old, every one
 * "working now". Read once at boot. A session whose harness speaks again is
 * the same record `byKey` would have fetched from the store; one already
 * quiet past the idle mark is ended as it is taken in, fifteen minutes
 * after it was last heard from, which is when it should have been, and the
 * rest are the sweep's from here. Returns the records taken in.
 */
export async function warm({ since = Date.now() - WARM_MS, now = Date.now() } = {}) {
  if (!store.loadSessions) return [];
  let stored;
  try {
    stored = await store.loadSessions({ since, limit: 5000 });
  } catch (err) {
    console.warn(`sessions: could not read the store's live sessions: ${err.message}`);
    return [];
  }
  const taken = [];
  for (const record of stored) {
    if (record.state !== "live" || records.has(record.id)) continue;
    taken.push(take(record, now));
  }
  return taken;
}

/**
 * Keep a session's search vector on its record (search.js): the model it
 * was made by, its size, and the vector packed. On the record rather than
 * in a store of its own so that a month of them costs no table, no backup
 * and no migration, and goes when the session goes. A session no longer
 * in memory is written through the store directly - it has ended, so
 * nothing else is writing it.
 */
export async function noteSearch(id, search) {
  const kept = search ? { model: String(search.model ?? ""), dims: Number(search.dims) || 0, v: String(search.v ?? "") } : null;
  const record = records.get(id);
  if (record) {
    record.search = kept;
    persist(id);
    return true;
  }
  if (!store.putSession || !store.loadSession) return false;
  const stored = await store.loadSession(id);
  if (!stored) return false;
  await store.putSession({ ...stored, search: kept });
  return true;
}

/** End the idle, forget the long-ended. */
export function sweep(now = Date.now()) {
  const ended = [];
  for (const record of records.values()) {
    if (record.state === "live" && now - record.lastSeenAt > IDLE_MS) {
      end(record.id, { at: record.lastSeenAt + IDLE_MS });
      ended.push(record.id);
    } else if (record.state === "ended" && now - record.endedAt > REMEMBER_MS && !writes.has(record.id)) {
      records.delete(record.id);
      sessionEvents.forget(record.id);
    }
  }
  return ended;
}

// ------------------------------------------------------------- counting

/** Fold one finished span into its session's counts. */
export function count(span) {
  const record = span.session ? records.get(span.session) : null;
  if (!record || span.name === "agent.session") return null;
  const { counts, attrs } = { counts: record.counts, attrs: span.attrs ?? {} };
  counts.spans += 1;
  if (span.name === "tool.call") {
    counts.tools += 1;
    if (!span.ok) {
      counts.toolsFailed += 1;
      counts.guidance.failedTools += 1;
      // And how it failed, in a word. A sandbox agent and a gateway call
      // have no hooks behind them (telemetry-ingest.js does the hook road),
      // so without this the friction report would say a laptop's week was
      // the whole installation's.
      frictioned(record.id, errorKindOf(attrs["cv.tool.error"] ?? null, { tool: attrs["cv.tool.name"] ?? null, ok: false }));
    }
    counts.sandboxMs += Number(attrs["cv.sandbox.ms"] ?? 0);
  } else if (span.name === "model.call") {
    counts.modelCalls += 1;
    const tokens = {
      input: Number(attrs["cv.tokens.input"] ?? 0),
      output: Number(attrs["cv.tokens.output"] ?? 0),
      cacheRead: Number(attrs["cv.tokens.cacheRead"] ?? 0),
      cacheWrite: Number(attrs["cv.tokens.cacheWrite"] ?? 0),
    };
    const spent = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    counts.tokens += spent;
    const model = attrs["cv.model"] ? String(attrs["cv.model"]) : null;
    // A record written before models were kept has no list; it gets one.
    if (model) {
      record.models ??= [];
      if (!record.models.includes(model) && record.models.length < MAX_MODELS) record.models.push(model);
      // And which of them spent the tokens, which is not the same question
      // as which ones answered: see `mainModelOf`. Capped the way the list
      // is, and a model already counted keeps being counted past the cap.
      counts.modelTokens ??= {};
      if (spent && (counts.modelTokens[model] != null || Object.keys(counts.modelTokens).length < MAX_MODELS)) {
        counts.modelTokens[model] = (counts.modelTokens[model] ?? 0) + spent;
      }
    }
    // What the call cost. Whoever served it is believed first - Claude Code
    // puts `cost_usd` on every request it exports, a LiteLLM proxy and
    // OpenRouter each report what they charged - because that is the figure
    // on the bill, and a rate table in this repository goes quietly wrong
    // the day a vendor moves a price. Only with nobody saying does the
    // catalogue price the tokens (models.js `priceOf`).
    //
    // A subscription call is priced too, which is where this parts company
    // with the ledger next door: costs.js answers "what does this
    // installation owe", so work on somebody's own Claude subscription is
    // no cost to it (`subscribed`). This answers "what did this work cost",
    // and a session that spent a billion tokens did not cost nothing
    // because of how it was billed - it was showing every figure on the
    // Performance page as zero.
    const said = Number(attrs["cv.cost.cents"]);
    const cost = Number.isFinite(said) && said >= 0 ? said : model ? tokenCost(tokens, model) : null;
    if (cost) counts.cost += cost;
  }
  if (span.task && !record.taskIds.includes(span.task) && record.taskIds.length < MAX_TASKS) record.taskIds.push(span.task);
  if (span.trace && !record.traceIds.includes(span.trace) && record.traceIds.length < MAX_TRACES) record.traceIds.push(span.trace);
  // A session opened without a machine - an invited agent connecting from
  // wherever it runs - is on the first machine its calls touch. Id and host
  // only: a span does not carry the name, and the route fills it in.
  if (!record.machine && attrs["cv.sandbox.id"]) {
    record.machine = cleanMachine({ id: attrs["cv.sandbox.id"], host: attrs["cv.host.id"] ?? null });
  }
  const seen = span.at + span.ms;
  if (record.state === "live" && seen > record.lastSeenAt) record.lastSeenAt = seen;
  persist(record.id);
  return record;
}

onSpan(count);

// -------------------------------------------------------------- storing

/** Writes in flight, so `flush` can wait for them: a test that reads the store back needs to. */
const inFlight = new Set();

function persist(id, { now = false } = {}) {
  if (!store.putSession) return;
  const write = () => {
    writes.delete(id);
    const record = records.get(id);
    if (!record) return;
    const done = store.putSession(structuredClone(record)).catch((err) => {
      console.warn(`sessions: could not store ${id}: ${err.message}`);
    });
    inFlight.add(done);
    done.finally(() => inFlight.delete(done));
  };
  if (writes.has(id)) {
    if (!now) return;
    clearTimeout(writes.get(id));
    writes.delete(id);
  }
  if (now) return write();
  const timer = setTimeout(write, WRITE_DELAY_MS);
  timer.unref?.();
  writes.set(id, timer);
}

/** Write everything waiting, now, and resolve once every write has landed. For shutdown and tests. */
export function flush() {
  for (const id of [...writes.keys()]) persist(id, { now: true });
  return Promise.allSettled([...inFlight]);
}

/** For tests. */
export const sessionInternals = {
  records,
  reset() {
    for (const timer of writes.values()) clearTimeout(timer);
    writes.clear();
    records.clear();
    pending.clear();
    threadsByTask.clear();
  },
  pending,
  threadsByTask,
};
