// Work one agent hands to another.
//
// This is the only way work is handed around here. Agents could once talk -
// a line in a repo's chat, read on the next tool result - and that messaging
// went in 2026-09, because a remark in a log is not an assignment: nobody
// owns it, nothing tracks it, and the agent that made it has no way to find
// out whether it happened.
//
// So a task is a record with two named ends, a state, and a thread back to
// whatever caused it.
//
// ## Cycles
//
// The obvious failure of letting agents delegate to each other is A asks B,
// B asks A, and both wait forever - or worse, both work forever. Two guards,
// and the second is the one that matters:
//
//   1. **Ancestry.** A task carries the task it descends from. You cannot send
//      a task to an agent that already appears in that chain. Cheap, and it
//      catches the honest case.
//
//   2. **Reachability.** Before accepting a task from A to B, walk the graph
//      of *open* tasks forward from B. If A is reachable, B is already waiting
//      on A - directly or through six others - and this would close the loop.
//      This one needs no honesty from the caller: it is computed from the
//      tasks that exist, not from what the agent said about them.
//
// Plus a depth cap, because a chain of forty agents each waiting on the next
// is not a cycle but is not work either.
//
// ## Time
//
// A task can carry an estimate: how long it should take and how hard it is.
// Whoever sends a task may give one - a plan without times is a list. The
// clock starts when the task is
// accepted, not when it was sent: a task nobody has picked up is visible on
// the board as exactly that, and is not the assignee's fault yet. When the
// time is up, the agent on it is told to stop and report - what it got done,
// what is left, why it ran over - and the task is marked `failed`. If it
// does not report within a grace period, the sweep marks it failed itself,
// with "no report" as the reason. Either way the failed task goes back to
// whoever sent it, whose decision it is: retry it with a
// bigger estimate, retry a narrower piece, split it, or drop it. A retry is
// a new task that names the failed one (`retryOf`), so the board shows the
// attempts as a sequence rather than as one task that flickered.
//
// ## Waiting on a person
//
// Some work stops at a person. A pull request is opened and nothing more
// can happen to it until somebody reviews it; a step needs a permission the
// agent does not hold and a person decides whether it gets it; a question
// only the owner can answer. `blocked` used to mean one thing - stuck, read
// the note - and an agent at a review had the choice of sitting in a model
// loop asking "is it merged yet" or marking the task failed for want of a
// state that said what it was actually doing: waiting.
//
// So a blocked task may say what it is waiting on (`waitingOn`): a review of
// a named pull request, an approval (access-requests.js), or a person by
// name or in general. Three things follow from it being said:
//
//   - The clock stops. The estimate is the agent's time, and a day at a
//     reviewer's door is not the agent's doing; `pausedMs` accumulates the
//     waits and `dueAt` moves by that much. A task blocked with nothing
//     said is still on the clock - the agent is the one who has to get it
//     going again.
//   - The thing it waits for brings it back. A review arriving on that
//     pull request (pulls.js `onChanged`), a decision on the request, or a
//     person pressing Resume flips the task back to `accepted` with a step
//     saying what came, and rings the agent - which is what a resident's
//     loop was waiting for (resident.js). The agent never polls.
//   - The console says so in its own words: "waiting on you", not "stuck",
//     because the person reading the board is usually the one it waits on.
//
// ## Outcomes
//
// A task ends in a report - the closing note, which is required: a 'done'
// with nothing said is a task nobody can learn from, and the sender, the
// Tasks tab and next month's "what did we get for that" all read the note.
// What the report is *about* varies. The obvious outcome is a pull request,
// and one pushed while holding the task is linked to it without anybody
// saying so (pulls.js `taskIds`). But a task can be an operation - rotate
// the key, run the migration, answer the question - with no pull request
// to point at, and it can be the doing of a ticket somewhere else, in
// which case the ticket closing is the outcome that matters, and Linear
// knows whether it has. So a task carries `outcome`: what kind of work it
// is (`kind`), and the ticket it is for (`ticket`), whose state is fetched
// from Linear when the task closes and refreshed while the ticket is open.
// Pull requests are read from the pull records at read time, never copied.
//
// And `used`: the tools, connectors, skills and models the spans under it
// saw, folded once at the close (task-usage.js). The spans expire; the
// question "was that connector worth it" outlives them.
//
// ## Where they live
//
// On the repo record, like sandboxes. A task is about work in a
// repo, so that is where it belongs - and it means no new table, and
// tasks that are backed up and replicated with everything else about that
// repo.
import { randomBytes } from "node:crypto";
import { wake } from "./wake.js";
import * as guidance from "./guidance.js";

export class TaskError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Where a task can be in its life. `open` is the only one that blocks. */
export const STATES = ["open", "accepted", "done", "declined", "blocked", "failed"];

/** States that mean somebody still owes somebody something. */
const LIVE = new Set(["open", "accepted", "blocked"]);
export const isLive = (state) => LIVE.has(state);

/** How hard a task is expected to be, as the sender says it. */
export const DIFFICULTIES = ["easy", "medium", "hard"];
/** An estimate is minutes, from one to a working day. */
export const MAX_ESTIMATE_MINUTES = 480;
/**
 * How long past its estimate a task may go before it is failed without a
 * report: the agent was told at the estimate and this is the time it has
 * to say what happened. A quarter of the estimate, and never under two
 * minutes - a five-minute task with a fifteen-second grace would be failed
 * by the sweep while its update_task was on the wire.
 */
export const graceFor = (estimateMinutes) => Math.max(2 * 60_000, Math.round(estimateMinutes * 60_000 * 0.25));

/**
 * What a task is for. `pull` is a change to the code; `ops` is something
 * done to a system - a key rotated, a migration run, a service restarted;
 * `answer` is a question answered or a thing found out; `review` is a
 * verdict on somebody else's change. Unsaid is allowed, and usual: the
 * kind is for reading a month of tasks, not for gating one.
 */
export const OUTCOME_KINDS = ["pull", "ops", "answer", "review", "other"];

/**
 * What a blocked task can be waiting on - see "Waiting on a person".
 * `review` is a pull request's; `approval` is an access request's, and is
 * set by request_access rather than said (a task cannot wait on an
 * approval nobody asked for); `person` is anyone, named or not.
 */
export const WAITING_KINDS = ["review", "approval", "person"];

/**
 * A wait as the tool receives it: "review", "review #12", "review
 * owner/repo#12", "person", "person: ada@example.com". The pull request is
 * only parsed here - which one "review" alone means is the caller's to
 * find (the newest linked to the task), because the pull records are not
 * this module's. Returns `{kind, number, repo, who}` or throws.
 */
export function readWaiting(value) {
  const text = clean(value, 200);
  if (!text) return null;
  const match = /^(review|approval|person)\b\s*:?\s*(.*)$/i.exec(text);
  if (!match) {
    throw new TaskError(`'waiting_on' is 'review' (of a pull request, '#12' to name it) or 'person' (': name' to name them).`);
  }
  const kind = match[1].toLowerCase();
  const rest = match[2].trim();
  if (kind === "approval") {
    throw new TaskError("An approval is waited on by asking for it: call request_access, which blocks the task for you.");
  }
  if (kind === "person") return { kind, number: null, repo: null, who: rest.slice(0, 120) || null };
  if (!rest) return { kind, number: null, repo: null, who: null };
  const pull = /^(?:(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+)(?:\/pull\/|#))?#?(\d{1,7})$/.exec(rest);
  if (!pull) throw new TaskError(`'waiting_on': 'review #12', 'review owner/repo#12' or the pull request's URL.`);
  return { kind, number: Number(pull[2]), repo: pull[1] ?? null, who: null };
}

/** A ticket identifier as Linear writes it: ENG-214. */
const TICKET_ID = /^[A-Z][A-Z0-9]{0,9}-\d{1,7}$/i;
/** ...or as it is pasted: the issue's own URL. */
const TICKET_URL = /^https:\/\/linear\.app\/[^/]+\/issue\/([A-Z][A-Z0-9]{0,9}-\d{1,7})(?:\/|$)/i;

/**
 * A ticket as the tools receive it - an identifier or a Linear URL - as the
 * task keeps it, or the reason it is no good. Only Linear for now; the
 * `kind` is on the record so a second tracker is a second branch here and
 * nothing on the page.
 */
export function readTicket(value) {
  const text = clean(value, 300);
  if (!text) return null;
  const fromUrl = TICKET_URL.exec(text);
  const id = fromUrl ? fromUrl[1] : TICKET_ID.test(text) ? text : null;
  if (!id) {
    throw new TaskError(
      `'ticket' is a Linear issue: its identifier (ENG-214) or its URL. '${text}' is neither.`,
    );
  }
  return {
    kind: "linear",
    id: id.toUpperCase(),
    url: fromUrl ? text : null,
    title: null,
    state: null,
    closed: null,
    checkedAt: null,
  };
}

/** The outcome's kind as the tools receive it, or the reason it is no good. */
function readKind(value) {
  if (value == null || value === "") return null;
  const kind = String(value).toLowerCase();
  if (!OUTCOME_KINDS.includes(kind)) throw new TaskError(`'kind' is one of ${OUTCOME_KINDS.join(", ")}.`);
  return kind;
}

/** How many times a piece of work may be retried before it is a different problem. */
export const MAX_ATTEMPTS = 3;

/** How long a delegation chain may get before it stops being work. */
export const MAX_CHAIN = 6;

/** Open tasks one agent may be holding at once. */
export const MAX_OPEN_PER_AGENT = 20;

const clean = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Every task on the installation, with the repo each belongs to. */
export function allTasks(registry) {
  const out = [];
  for (const repo of registry.repos.values()) {
    for (const task of repo.tasks ?? []) out.push(task);
  }
  return out;
}

/**
 * Tasks involving one agent, newest first.
 *
 * @param {"to"|"from"|"either"} role which end of it they are on
 */
export function tasksFor(registry, agentId, { role = "either", state = null } = {}) {
  const id = String(agentId);
  return allTasks(registry)
    .filter((task) => {
      const mine =
        role === "to" ? task.to.id === id
        : role === "from" ? task.from.id === id
        : task.to.id === id || task.from.id === id;
      return mine && (!state || task.state === state);
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function findTask(registry, taskId) {
  for (const repo of registry.repos.values()) {
    const task = (repo.tasks ?? []).find((entry) => entry.id === String(taskId));
    if (task) return { task, repo };
  }
  return null;
}

/**
 * The registry's *current* object for a repo.
 *
 * `refresh()` re-reads from the store and replaces records wholesale, so a
 * repo object captured a moment ago can stop being the one the registry
 * holds - and mutating that one, then saving it, writes a snapshot from before
 * the refresh over whatever it brought in. Everything below re-resolves
 * immediately before it writes, so the window is a line of code rather than
 * the length of a request.
 */
const live = (registry, repo) =>
  registry.repos.get(repo.id) ?? repo;

/**
 * The one task an agent is working on, when that is knowable: the single
 * accepted task it holds. Two accepted at once and nothing is guessed - a
 * call, a token or a minute booked under the wrong task is worse than one
 * booked under none.
 */
export function workingOn(registry, agentId) {
  const held = tasksFor(registry, agentId, { role: "to", state: "accepted" });
  return held.length === 1 ? held[0] : null;
}

/**
 * What came back to an agent from the tasks it sent: the ones settled since
 * `since` by somebody other than itself - a report the sender has not read.
 *
 * This is how a "done" reaches whoever sent the task. It used to reach it
 * through the room: the closing line every update posted was overheard, and
 * the sender was woken and ran a model episode for it - and for every
 * 'accepted' and progress line too, and every summary any agent said to
 * nobody. With four agents that was the sender's context, re-read at the
 * model, for each line any of them typed. The report comes this way
 * instead: as the settled task itself, with what the sender needs
 * to decide what happens next - what the piece was part of, and whether the
 * other pieces of it are in yet. Nothing here for a piece still moving.
 *
 * Settled tasks with no `settledBy` were closed by the clock (sweepOverdue)
 * or before this was recorded; both are reports too.
 */
export function reportsFor(registry, agentId, { since = 0 } = {}) {
  const id = String(agentId);
  const settled = (task) => (task.settledAt ? Date.parse(task.settledAt) : NaN);
  // Oldest settle first, and the order is total. `settledAt` is a
  // millisecond and two pieces of one parent routinely close inside one, so
  // the tie decides the ordinary case rather than a corner - and it used to
  // fall through to whatever order `tasksFor` had left, which is newest
  // *created* first. So a lead that handed out two pieces read them back in
  // the order it sent them or the reverse depending on whether their
  // creation straddled a millisecond: the same code, either way, run to run.
  // Read from `allTasks` instead, which is the order the tasks were made in,
  // and keep that as the tie-break; a wrong-way-round pair of reports is a
  // real answer to the lead, not only a flaky test.
  const everything = allTasks(registry);
  const made = new Map(everything.map((task, at) => [task.id, at]));
  return everything
    .filter(
      (task) =>
        task.from.id === id && !LIVE.has(task.state) && settled(task) > since && task.settledBy !== id,
    )
    .sort((a, b) => settled(a) - settled(b) || made.get(a.id) - made.get(b.id))
    .map((task) => {
      const repo = registry.repos.get(task.repoId);
      const parent = task.parentId
        ? (repo?.tasks ?? []).find((entry) => entry.id === task.parentId) ?? null
        : null;
      const siblings = parent
        ? (repo?.tasks ?? []).filter((entry) => entry.parentId === parent.id && entry.id !== task.id)
        : [];
      return {
        id: task.id,
        state: task.state,
        title: task.title,
        to: task.to?.name ?? "?",
        note: task.note ?? "",
        settledAt: task.settledAt,
        ...(task.failure ? { failure: task.failure } : {}),
        ...(task.retryOf ? { attempt: task.attempt ?? 1 } : {}),
        ...(task.retriedAs ? { retriedAs: task.retriedAs } : {}),
        ...(parent
          ? {
              parent: {
                id: parent.id,
                title: parent.title,
                state: parent.state,
                mine: parent.to?.id === id,
                // The other pieces of the same parent, so the sender can tell
                // "the last one is in" from "one of three is in" without
                // a my_tasks call.
                stillOut: siblings.filter((entry) => LIVE.has(entry.state)).map((entry) => ({
                  id: entry.id,
                  title: entry.title,
                  to: entry.to?.name ?? "?",
                  state: entry.state,
                })),
                settled: siblings.filter((entry) => !LIVE.has(entry.state)).length,
              },
            }
          : {}),
      };
    });
}

/**
 * The tasks sent out for one - its pieces, when the holder split it. A task
 * with a live piece is parked with its agent rather than handed back to it
 * on every poll (resident.js `look`): the agent has done its part for now
 * and is waiting, and waiting is not a model episode.
 */
export function piecesOf(registry, task) {
  return allTasks(registry)
    .filter((entry) => entry.parentId === task.id)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/** The newest settle among an agent's sent tasks, as epoch ms - the reports watermark. */
export function newestReport(registry, agentId) {
  return tasksFor(registry, agentId, { role: "from" }).reduce((newest, task) => {
    const at = task.settledAt ? Date.parse(task.settledAt) : NaN;
    return at > newest ? at : newest;
  }, 0);
}

/**
 * When a task's time is up, as epoch ms - from the moment it was accepted,
 * for as long as the estimate says, plus however long it has spent waiting
 * on a person (`pausedMs`, see "Waiting on a person"). Null for a task with
 * no estimate or not yet started: no clock is running on either.
 */
export function dueAt(task) {
  if (!task?.estimateMinutes || !task.acceptedAt) return null;
  const started = Date.parse(task.acceptedAt);
  return Number.isFinite(started) ? started + task.estimateMinutes * 60_000 + (task.pausedMs ?? 0) : null;
}

/** A live task whose time is up. Never one waiting on a person: its clock is stopped. */
export const overdue = (task, now = Date.now()) => {
  const due = dueAt(task);
  return due != null && LIVE.has(task.state) && task.state !== "open" && !task.waitingOn && now >= due;
};

/** An estimate as the tools receive it, or the reason it is no good. */
function readEstimate(spec) {
  const minutes = spec.minutes == null || spec.minutes === "" ? null : Number(spec.minutes);
  const difficulty = spec.difficulty == null || spec.difficulty === "" ? null : String(spec.difficulty).toLowerCase();
  if (minutes != null && (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_ESTIMATE_MINUTES)) {
    throw new TaskError(`'minutes' is how long this should take: a whole number from 1 to ${MAX_ESTIMATE_MINUTES}.`);
  }
  if (difficulty != null && !DIFFICULTIES.includes(difficulty)) {
    throw new TaskError(`'difficulty' is one of ${DIFFICULTIES.join(", ")}.`);
  }
  return { minutes, difficulty };
}

/**
 * The chain of tasks this one descends from, oldest first.
 *
 * Bounded by MAX_CHAIN so a corrupted parent link - a task whose parent is
 * itself, somehow - cannot spin here rather than being refused.
 */
function ancestry(registry, taskId) {
  const chain = [];
  let at = taskId;
  const seen = new Set();
  while (at && chain.length <= MAX_CHAIN + 1 && !seen.has(at)) {
    seen.add(at);
    const found = findTask(registry, at);
    if (!found) break;
    chain.unshift(found.task);
    at = found.task.parentId;
  }
  return chain;
}

/**
 * Can `target` already reach `source` through open tasks?
 *
 * A breadth-first walk forward from `target`: who is it waiting on, who are
 * they waiting on. If `source` turns up, adding source -> target closes a
 * loop. This is the guard that does not depend on anybody declaring anything.
 */
function waitsOn(registry, target, source) {
  const open = allTasks(registry).filter((task) => LIVE.has(task.state));
  const queue = [String(target)];
  const seen = new Set(queue);
  while (queue.length) {
    const at = queue.shift();
    if (at === String(source)) return true;
    for (const task of open) {
      if (task.from.id !== at || seen.has(task.to.id)) continue;
      seen.add(task.to.id);
      queue.push(task.to.id);
    }
  }
  return false;
}

/**
 * Hand a piece of work to another agent.
 *
 * @param {object} registry the repo registry
 * @param {object} repo where the work should happen
 * @param {object} spec
 * @param {{id: string, name: string}} spec.from
 * @param {{id: string, name: string}} spec.to
 * @param {string} spec.title
 * @param {string} [spec.detail]
 * @param {string} [spec.because] the task this one descends from
 */
export async function createTask(registry, repo, spec) {
  // A retry with no new title is the same task again; with no new detail,
  // the same brief - the failed attempt's report is added below either way.
  const previous = spec.retryOf ? findTask(registry, spec.retryOf)?.task : null;
  const title = clean(spec.title, 120) || clean(previous?.title, 120);
  if (!title) throw new TaskError("A task needs a title - say what you want done");
  if (previous && !clean(spec.detail, 2000)) spec = { ...spec, detail: previous.detail };
  if (previous) {
    spec = {
      ...spec,
      detail: clean(spec.detail, 1600) +
        ` — Attempt ${(previous.attempt ?? 1)} (task ${previous.id}) failed` +
        (previous.note ? `: ${clean(previous.note, 300)}` : "."),
    };
  }

  // Re-found on the live record rather than written through the object the
  // caller holds - see `live`.
  const record = live(registry, repo);

  // A task to yourself is a piece of a plan with your own name on it: when an
  // agent breaks a request into pieces and there is nobody else to give one
  // to, the piece still belongs on the board, with a state, where the Tasks
  // tab shows who has it. The loop guards do not apply to it - trivially.
  const toSelf = spec.from.id === spec.to.id;

  // Any task may come with a time and a difficulty - see "Time" at the top.
  const estimate = readEstimate(spec);
  // And with what it is for and the ticket it does - see "Outcomes".
  const kind = readKind(spec.kind);
  const ticket = readTicket(spec.ticket);

  // A retry names what it retries. The failed task's chain is this one's
  // chain - it is the same piece of work, tried again - and only whoever
  // sent it decides to try again.
  let retrying = null;
  if (spec.retryOf) {
    const previous = findTask(registry, spec.retryOf);
    if (!previous) throw new TaskError(`No task with id ${spec.retryOf} to retry.`);
    retrying = previous.task;
    if (retrying.state !== "failed") {
      throw new TaskError(`Task ${retrying.id} is '${retrying.state}', not failed - there is nothing to retry.`);
    }
    if (retrying.from.id !== spec.from.id) {
      throw new TaskError(`Task ${retrying.id} was ${retrying.from.name}'s to send; whether to retry it is theirs.`);
    }
    if (retrying.retriedAs) {
      throw new TaskError(`Task ${retrying.id} has already been retried as ${retrying.retriedAs}.`);
    }
    if ((retrying.attempt ?? 1) >= MAX_ATTEMPTS) {
      throw new TaskError(
        `That is attempt ${retrying.attempt ?? 1} of ${MAX_ATTEMPTS} failing. Do not try the same ` +
          `thing again: split it, change the approach, or say on the task that it cannot be done as asked.`,
      );
    }
  }
  // 1. Ancestry: not to somebody this piece of work already came through.
  //    An agent breaking up a task it holds sends the pieces on from that
  //    task, so its own name is in the chain by construction: the check is
  //    for work going *back* to somebody, which a piece of your own is not.
  const parentId = spec.because ? String(spec.because) : (retrying?.parentId ?? null);
  const chain = parentId ? ancestry(registry, parentId) : [];
  if (chain.length >= MAX_CHAIN) {
    throw new TaskError(
      `This is ${chain.length} hand-offs deep, which is the limit. Do it yourself ` +
        `or tell the person who asked that it needs breaking up.`,
    );
  }
  const throughIt = new Set(chain.flatMap((task) => [task.from.id, task.to.id]));
  if (!toSelf && throughIt.has(spec.to.id)) {
    const who = chain.find((task) => task.from.id === spec.to.id || task.to.id === spec.to.id);
    throw new TaskError(
      `Refused: this work already came through '${spec.to.name}' - see task ` +
        `${who.id}, "${who.title}". Sending it back is a loop. Answer them instead.`,
    );
  }

  // 2. Reachability: not to somebody who is already, however indirectly,
  //    waiting on you. (Trivially true of yourself, and not a loop.)
  if (!toSelf && waitsOn(registry, spec.to.id, spec.from.id)) {
    throw new TaskError(
      `Refused: '${spec.to.name}' is already waiting on you, directly or through ` +
        `another agent. Finish or decline what you owe them before asking for more.`,
    );
  }

  const holding = tasksFor(registry, spec.to.id, { role: "to" }).filter((task) =>
    LIVE.has(task.state),
  );
  if (holding.length >= MAX_OPEN_PER_AGENT) {
    throw new TaskError(
      `'${spec.to.name}' is holding ${holding.length} open tasks, which is the ` +
        `limit. Wait for it to clear some.`,
    );
  }

  const task = {
    id: randomBytes(6).toString("hex"),
    repoId: repo.id,
    from: { id: spec.from.id, name: spec.from.name },
    to: { id: spec.to.id, name: spec.to.name },
    title,
    detail: clean(spec.detail, 2000),
    state: "open",
    parentId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    note: "",
    ...(kind || ticket ? { outcome: { kind, ticket } } : {}),
    ...(estimate.minutes != null ? { estimateMinutes: estimate.minutes } : {}),
    ...(estimate.difficulty ? { difficulty: estimate.difficulty } : {}),
    ...(retrying ? { retryOf: retrying.id, attempt: (retrying.attempt ?? 1) + 1 } : {}),
  };

  record.tasks = [...(record.tasks ?? []), task];
  await registry.save(record);
  if (retrying) {
    // On the failed one's own record, which may be another repo's.
    const home = live(registry, registry.repos.get(retrying.repoId) ?? { id: retrying.repoId });
    const previous = (home.tasks ?? []).find((entry) => entry.id === retrying.id);
    if (previous) {
      previous.retriedAs = task.id;
      previous.updatedAt = task.createdAt;
      await registry.save(home);
    }
    // Counted against whoever failed it, on the session that is still
    // running - a retry is one of the things a session is scored on.
    guidance.retried(retrying);
  }
  // The same key the agent's private line rings, because to the loop that is
  // waiting on it they mean the same thing: look now - see wake.js.
  wake(`agent:${task.to.id}`, { task });
  return task;
}

/**
 * Move a task along.
 *
 * Only the two ends may touch it, and they may do different things: the agent
 * it was sent to accepts, declines, blocks or finishes it; the one who sent it
 * can only withdraw it, which is `declined` with their name on it. Anything
 * else and a third agent could quietly close somebody else's work.
 */
/** Steps kept on a task. Enough to read what happened; not a transcript. */
export const MAX_STEPS = 40;

/**
 * Say what became of a task - or, while it is being done, what is being
 * done.
 *
 * `note` with a closing state is the report: what was delivered, or why
 * not. `note` with 'accepted' - the same state it is already in - is a
 * progress line: "using the GitHub connector to read the repo", "running the
 * tests"; each one is kept in `steps` rather than overwriting the last, so
 * the record reads as what the agent did in order, not only its last word.
 *
 * `did` is the tool calls made for this task, handed in by whoever can see
 * the activity feed (collab-tools.js) when the task closes: the feed forgets,
 * the task does not, and "what did it actually do" is asked of a task long
 * after the agent moved on. `used` and `spent` are kept the same way, for
 * the same reason.
 *
 * `because` puts the task under a parent after the fact - a piece sent out
 * before the agent said what it was a piece of. `kind` and `ticket` say what
 * it is for (see "Outcomes"); `ticketState` is what Linear said of the
 * ticket, fetched by the caller, kept here.
 *
 * `waitingOn` with 'blocked' says what the block is - a person, see
 * "Waiting on a person" - as `{kind, pull, request, who}`, already resolved
 * by the caller (readWaiting parses the words; which pull request "review"
 * means is found where the pull records are).
 */
export async function updateTask(
  registry,
  taskId,
  agentId,
  { state, note, did = [], spent = null, used = null, because, kind, ticket, ticketState = null, waitingOn = null } = {},
) {
  const found = findTask(registry, taskId);
  if (!found) throw new TaskError(`No task with id ${taskId}`, 404);
  const { task, repo } = found;

  // A task the clock closed stays closed. The one thing still welcome on it
  // is the report that was late: 'failed' again, with the note saying why.
  // 'done' after the fact is not - the work may well be finished, but it
  // finished outside the plan, and the sender decides what to do with that
  // from the report, not from a task that quietly flipped to done.
  if (task.state === "failed" && state && state !== "failed") {
    throw new TaskError(
      `Task ${task.id} failed at ${task.updatedAt}` +
        (task.failure === "timeout" ? " - its time ran out" : "") +
        `. It cannot be reopened: report what state the work is in (update_task ` +
        `'failed' with a note), and ${task.from.name} decides whether to retry it.`,
    );
  }

  const isReceiver = task.to.id === String(agentId);
  const isSender = task.from.id === String(agentId);
  // A task is between the two agents on it; a third cannot settle it.
  if (!isReceiver && !isSender) {
    throw new TaskError("That task is not yours - it is between two other agents", 403);
  }
  if (isSender && !isReceiver && state && state !== "declined") {
    throw new TaskError(
      "You sent this one. You can withdraw it ('declined'), but whether it is " +
        "done is not yours to say.",
      403,
    );
  }
  if (state && !STATES.includes(state)) {
    throw new TaskError(`Unknown state '${state}'. One of: ${STATES.join(", ")}`);
  }
  const said = note !== undefined ? clean(note, 1000) : "";
  // The report is the point of closing - see "Outcomes". What was delivered
  // and where it is, or what is done, what is left and why; a 'declined'
  // says whose it is instead.
  if (state && !LIVE.has(state) && !said) {
    throw new TaskError(
      state === "done"
        ? "Say what you delivered before marking it done: what changed, where it is " +
          "(the branch, pull request or ticket), what you checked, and anything left. " +
          "The agent that sent this reads the note and has no other way to find out."
        : state === "failed"
          ? "Say what is done, what is left and why it could not be finished. The sender " +
            "decides what happens next from that note."
          : "Say why: whose this is instead, or why it will not be done.",
    );
  }
  const newKind = readKind(kind);
  const newTicket = ticket === undefined ? undefined : readTicket(ticket);
  if (waitingOn) {
    if (state !== "blocked") throw new TaskError("'waiting_on' goes with state 'blocked': the task waits, it is not finished.");
    if (!WAITING_KINDS.includes(waitingOn.kind)) throw new TaskError(`A task waits on one of: ${WAITING_KINDS.join(", ")}.`);
    if (waitingOn.kind === "review" && !waitingOn.pull?.number) {
      throw new TaskError("Name the pull request ('waiting_on': 'review #12') - none is linked to this task yet.");
    }
  }

  // Re-found on the live record rather than written through the object the
  // lookup returned: see `live`. Without this an update can be applied to a
  // task object the registry has already replaced, and vanish.
  const record = live(registry, repo);
  const current =
    (record.tasks ?? []).find((entry) => entry.id === task.id) ?? task;

  // Under a parent, after the fact. The same two refusals as sending it
  // there would have met, plus the one only a link can cause: a task
  // cannot descend from its own descendant.
  if (because !== undefined && because !== null && String(because).trim()) {
    const parentId = String(because).trim();
    if (parentId === current.id) throw new TaskError("A task cannot be a piece of itself.");
    if (!findTask(registry, parentId)) throw new TaskError(`No task with id ${parentId} to put this under.`);
    if (current.parentId && current.parentId !== parentId) {
      throw new TaskError(`Task ${current.id} is already a piece of ${current.parentId}.`);
    }
    if (ancestry(registry, parentId).some((entry) => entry.id === current.id)) {
      throw new TaskError(`Task ${parentId} descends from ${current.id}; the link would go round in a circle.`);
    }
    const chain = ancestry(registry, parentId);
    if (chain.length >= MAX_CHAIN) {
      throw new TaskError(`That would make this ${chain.length + 1} hand-offs deep, past the limit of ${MAX_CHAIN}.`);
    }
    current.parentId = parentId;
  }

  const now = new Date().toISOString();
  const wasLive = LIVE.has(current.state);
  // Leaving a wait, whichever way: the time spent at the person's door is
  // taken off the clock, and the wait is over. Entering one is below, with
  // the step that says what it is.
  if (state && state !== "blocked" && current.waitingOn) endWait(current, now);
  if (state) current.state = state;
  // The agent has spoken since it was brought back: the "back with you"
  // framing (resumeTask) has served.
  if (state && current.resumed) delete current.resumed;
  if (state === "accepted" && !current.acceptedAt) current.acceptedAt = now;
  // Waiting on a person overrides a wait already there: an agent may block
  // on a review, hear back, and block again on a different person.
  if (state === "blocked" && waitingOn && wasLive) {
    if (current.waitingOn) endWait(current, now);
    current.waitingOn = {
      kind: waitingOn.kind,
      pull: waitingOn.pull ? { repo: waitingOn.pull.repo, number: waitingOn.pull.number, url: waitingOn.pull.url ?? null } : null,
      request: waitingOn.request ?? null,
      who: waitingOn.who ? clean(waitingOn.who, 120) : null,
      since: now,
    };
    // The one stamp the sweep makes is undone: a task that comes back
    // from a wait is told again when its (moved) time is up.
    delete current.overdueAt;
  }
  // Reported by the agent itself, as against closed by the clock (the sweep).
  if (state === "failed" && wasLive) current.failure = overdue(current) ? "timeout" : "reported";
  const settling = Boolean(state && !LIVE.has(state) && wasLive);
  if (settling) {
    current.settledAt = now;
    // Who closed it, so the sender is not sent its own withdrawal as a
    // report - see reportsFor.
    current.settledBy = String(agentId);
  }
  // What it cost, kept with it: the ledger that measured it forgets.
  if (settling && spent && !current.spent) current.spent = spent;
  // And what it was done with, for the same reason - see "Outcomes". On any
  // close, not only the first: the clock closes a task with no spans in
  // hand, and the late report that follows is the one that has them.
  if (state && !LIVE.has(state) && used && !current.used) current.used = used;

  // What it is for. Set at any time; a ticket can be named on the close
  // ("this was ENG-214 after all"), and what Linear says of it lands here
  // whenever the caller looked.
  if (newKind || newTicket !== undefined || ticketState) {
    const outcome = { kind: null, ticket: null, ...(current.outcome ?? {}) };
    if (newKind) outcome.kind = newKind;
    if (newTicket !== undefined) outcome.ticket = newTicket;
    if (ticketState && outcome.ticket) outcome.ticket = { ...outcome.ticket, ...ticketState, checkedAt: now };
    current.outcome = outcome;
  }

  const steps = [...(current.steps ?? [])];
  // Progress, not a verdict: kept as a step. The closing note is the verdict
  // and stays on `note`, where the sender reads it.
  if (said && (state === "accepted" || !state) && wasLive) {
    steps.push({ at: now, text: said, kind: "said" });
  }
  // A wait is a step too - the trail should read "waited on a review of
  // #12" between what was done before and what came back.
  if (state === "blocked" && waitingOn && wasLive) {
    steps.push({ at: now, text: `Waiting on ${describeWait(current.waitingOn)}${said ? `: ${said}` : ""}`, kind: "said" });
  }
  if (note !== undefined) current.note = said;

  // What the feed saw done for it, folded in once - on the close, when the
  // agent stops adding to it. Oldest first, so the order is the order.
  if (state && !LIVE.has(state) && !steps.some((step) => step.kind === "did")) {
    for (const call of did) {
      const text = clean(call.text ?? call.summary, 160);
      if (!text) continue;
      const at = Number.isFinite(call.at) ? new Date(call.at).toISOString() : now;
      steps.push({ at, text, kind: "did", ok: call.ok !== false });
    }
    steps.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  }
  current.steps = steps.slice(-MAX_STEPS);
  current.updatedAt = now;
  await registry.save(record);
  // The report goes back to whoever sent it, the way the task came: a ring
  // on the sender's own key, which its loop is holding a poll on. Progress
  // does not ring - the sender reads that on the Tasks tab, and being woken
  // for "accepted" is what this replaces (reportsFor says why).
  if (settling && current.from.id !== String(agentId)) wake(`agent:${current.from.id}`, { task: current });
  return current;
}

/** What a task waits on, in words: "a review of ada/engine#12", "approval from ada@example.com", "Ada", "a person". */
export function describeWait(waitingOn) {
  if (!waitingOn) return "";
  switch (waitingOn.kind) {
    case "review":
      return `a review of ${waitingOn.pull?.repo ? `${waitingOn.pull.repo}#` : "#"}${waitingOn.pull?.number ?? "?"}`;
    case "approval":
      return `approval${waitingOn.who ? ` from ${waitingOn.who}` : ""}`;
    default:
      return waitingOn.who ?? "a person";
  }
}

/** The wait is over: what it cost the clock is kept, the wait itself is not. */
function endWait(task, nowIso) {
  const since = Date.parse(task.waitingOn?.since ?? "");
  const waited = Number.isFinite(since) ? Math.max(0, Date.parse(nowIso) - since) : 0;
  if (waited) task.pausedMs = (task.pausedMs ?? 0) + waited;
  task.waitingOn = null;
}

/**
 * What a blocked task was waiting for has come. Back to `accepted` with a
 * step saying what came - "Reviewed by bob: changes requested", "Resumed by
 * Ada: the key is in the store now" - and the agent is rung, exactly as when
 * the task was first sent to it. Not through updateTask: the agent is not
 * the one acting, and neither is the sender.
 *
 * Refused for a task not waiting - a review arriving on a pull request whose
 * task has since moved on changes nothing, and says so.
 *
 * @param {{kind: "review"|"person"|"approval"|"system", name?: string}} by who or what brought it back
 * @param {string} text what came, for the step and for the agent's prompt
 */
export async function resumeTask(registry, taskId, { by, text }) {
  const found = findTask(registry, taskId);
  if (!found) throw new TaskError(`No task with id ${taskId}`, 404);
  const record = live(registry, found.repo);
  const current = (record.tasks ?? []).find((entry) => entry.id === taskId) ?? found.task;
  if (current.state !== "blocked" || !current.waitingOn) {
    throw new TaskError(`Task ${current.id} is not waiting on anybody - it is ${current.state}.`);
  }
  const now = new Date().toISOString();
  const waited = current.waitingOn;
  endWait(current, now);
  current.state = "accepted";
  if (!current.acceptedAt) current.acceptedAt = now;
  const heard = clean(text, 300) || `${describeWait(waited)} came`;
  current.steps = [...(current.steps ?? []), { at: now, text: heard, kind: "heard" }].slice(-MAX_STEPS);
  // For the loop that picks it back up: what it was waiting on and what
  // came, so the prompt can say so rather than "you have been given a task"
  // - see resident.js. Cleared by the next report.
  current.resumed = { at: now, by: { kind: by?.kind ?? "system", name: by?.name ?? null }, waited, text: heard };
  current.note = heard;
  current.updatedAt = now;
  await registry.save(record);
  wake(`agent:${current.to.id}`, { task: current });
  return current;
}

/**
 * Back to waiting, by the platform rather than the agent: a task brought
 * back by a prompt (task-waits.js `watchTurns`) whose turn has ended with
 * the pull request still open goes back to the review it waited on, its
 * clock stopped again - the latest updates are in, and it is a person's
 * move once more. Only from `accepted`: an agent that has since said
 * something else of the task - done, failed, waiting on somebody - is
 * believed over this.
 *
 * @returns {Promise<object|null>} the task, or null when it was not accepted
 */
export async function parkTask(registry, taskId, { waitingOn, text }) {
  const found = findTask(registry, taskId);
  if (!found) throw new TaskError(`No task with id ${taskId}`, 404);
  const record = live(registry, found.repo);
  const current = (record.tasks ?? []).find((entry) => entry.id === taskId) ?? found.task;
  if (current.state !== "accepted" || !waitingOn?.kind) return null;
  const now = new Date().toISOString();
  current.state = "blocked";
  current.waitingOn = {
    kind: waitingOn.kind,
    pull: waitingOn.pull ? { repo: waitingOn.pull.repo, number: waitingOn.pull.number, url: waitingOn.pull.url ?? null } : null,
    request: waitingOn.request ?? null,
    who: waitingOn.who ?? null,
    since: now,
  };
  delete current.overdueAt;
  delete current.resumed;
  const said = clean(text, 300) || `Waiting on ${describeWait(current.waitingOn)} again`;
  current.steps = [...(current.steps ?? []), { at: now, text: said, kind: "said" }].slice(-MAX_STEPS);
  current.note = said;
  current.updatedAt = now;
  await registry.save(record);
  return current;
}

/**
 * A pull request changed (pulls.js `onChanged`): every task waiting on a
 * review of it is brought back - on a verdict, and on the pull request
 * being merged or closed, which is a verdict too. A comment-only review is
 * not; the agent is not woken for "looks interesting".
 *
 * @returns {Promise<object[]>} the tasks resumed, for whoever tells the room
 */
export async function pullChanged(registry, { pull, event }) {
  if (!pull || !event) return [];
  let text = null;
  if (event.kind === "review" && (event.state === "approved" || event.state === "changes_requested")) {
    text = `Reviewed by ${event.by ?? "somebody"}: ${event.state === "approved" ? "approved" : "changes requested"}`;
  } else if (event.kind === "pull" && (event.state === "merged" || event.state === "closed")) {
    text = `Pull request #${pull.number} was ${event.state}`;
  }
  if (!text) return [];
  const resumed = [];
  for (const task of allTasks(registry)) {
    const on = task.waitingOn;
    if (task.state !== "blocked" || on?.kind !== "review") continue;
    if (on.pull?.repo !== pull.repo || Number(on.pull?.number) !== Number(pull.number)) continue;
    resumed.push(await resumeTask(registry, task.id, { by: { kind: "review", name: event.by ?? null }, text }));
  }
  return resumed;
}

/**
 * The clock, run every so often (index.js) and on every look a resident
 * takes (resident.js).
 *
 * Two moments per task. At its estimate it is *overdue*: stamped once, so
 * the agent on it can be told - every tool result it gets from here says
 * so (mcp.js), and its loop checks the same stamp between local calls - and
 * the room is told it is being asked to report. At its estimate plus grace
 * it is *failed*, if the agent has not said so itself by then: the record
 * says the time ran out and no report came, with the last thing the agent
 * was seen doing, and it goes back to whoever sent it to decide. Returns
 * what changed so the caller can wake and tell people.
 *
 * @returns {{ overdue: object[], failed: object[] }}
 */
export async function sweepOverdue(registry, { now = Date.now(), lastStep = () => null, spent = () => null } = {}) {
  const out = { overdue: [], failed: [] };
  for (const repo of [...registry.repos.values()]) {
    let changed = false;
    const record = live(registry, repo);
    for (const task of record.tasks ?? []) {
      if (!overdue(task, now)) continue;
      const due = dueAt(task);
      if (!task.overdueAt) {
        task.overdueAt = new Date(now).toISOString();
        task.updatedAt = task.overdueAt;
        out.overdue.push(task);
        changed = true;
      }
      if (now < due + graceFor(task.estimateMinutes)) continue;
      const onIt = Math.round((now - Date.parse(task.acceptedAt)) / 60_000);
      const last = lastStep(task);
      // The cost is read before the state flips: `spent` measures a live task
      // to now and a settled one to when it settled.
      const cost = spent(task);
      task.state = "failed";
      task.failure = "timeout";
      task.settledAt = new Date(now).toISOString();
      if (cost && !task.spent) task.spent = cost;
      task.note =
        `Ran out of time: estimated ${task.estimateMinutes} min, ${onIt} min on it, and no ` +
        `report from ${task.to.name}.` + (last ? ` Last seen: ${clean(last, 160)}.` : "");
      task.steps = [...(task.steps ?? []), { at: task.settledAt, text: "Time ran out", kind: "said" }].slice(-MAX_STEPS);
      task.updatedAt = task.settledAt;
      out.failed.push(task);
      changed = true;
    }
    if (changed) await registry.save(record);
  }
  return out;
}

/**
 * Hand a task to a different agent.
 *
 * The sender's tool: a task sent to the wrong agent used to sit until that
 * agent declined it and the sender tried somebody else, with nothing in
 * between able to say "no, this is Dbot's". Now whoever sent it can move it
 * - to whoever's skills or reachable services fit, which
 * `list_agents` says. The task goes
 * back to open with the new name on it and the new agent is woken, exactly
 * as if it had been sent there in the first place; the note says who moved
 * it and why, because the receiving agent otherwise finds a task from
 * somebody who never spoke to it.
 *
 * Refused for a task that is finished, and for anybody but the sender - the
 * agent holding it declines it instead, with a note saying whose it is.
 *
 * @param {{id: string, name: string}} target the agent it goes to
 */
export async function reassignTask(registry, taskId, agentId, target, { note } = {}) {
  const found = findTask(registry, taskId);
  if (!found) throw new TaskError(`No task with id ${taskId}`, 404);
  const { task, repo } = found;

  const record = live(registry, repo);
  if (task.from.id !== String(agentId)) {
    throw new TaskError(
      "Only the agent that sent a task may move it to another agent. Decline it " +
        "with a note saying who it should go to, and the sender can re-send it.",
      403,
    );
  }
  if (!target?.id || !(record.agents ?? []).some((agent) => agent.id === target.id)) {
    throw new TaskError(
      `'${target?.name ?? target?.id ?? "that agent"}' is not in this repo, so ` +
        `it cannot act on a task here.`,
    );
  }
  if (target.id === task.to.id) {
    throw new TaskError(`'${target.name}' already has this task.`);
  }
  if (target.id === task.from.id) {
    throw new TaskError(
      `'${target.name}' sent this task. Sending it back is a loop - decline it instead.`,
    );
  }
  if (!LIVE.has(task.state)) {
    throw new TaskError(`This task is '${task.state}' - there is nothing left to move.`);
  }

  const current = (record.tasks ?? []).find((entry) => entry.id === task.id) ?? task;
  const before = current.to.name;
  current.to = { id: target.id, name: target.name };
  current.state = "open";
  const why = clean(note, 1000);
  current.note = `Moved from ${before} by ${task.from.name}${why ? `: ${why}` : "."}`;
  current.updatedAt = new Date().toISOString();
  await registry.save(record);
  // Somebody else had it first: for the one it lands on, a follow-up.
  guidance.movedTo(target.id);
  wake(`agent:${target.id}`, { task: current });
  return current;
}

/** What a task looks like to a browser or to an agent. */
export const describeTask = (task) => ({ ...task });

/**
 * The tasks joined to a set of tasks by a parent, child or retry edge,
 * however far, wherever they live. A repo's Tasks tab draws the trail, and
 * a piece sent to another repo is on the trail even though it is not on
 * this repo's record - without it the graph has an edge into nowhere.
 *
 * @returns {object[]} the tasks joined in, not the ones given
 */
export function relatedTo(registry, tasks) {
  const every = allTasks(registry);
  const byId = new Map(every.map((task) => [task.id, task]));
  const have = new Set(tasks.map((task) => task.id));
  const queue = [...have];
  const joined = [];
  const take = (id) => {
    if (!id || have.has(id) || !byId.has(id)) return;
    have.add(id);
    joined.push(byId.get(id));
    queue.push(id);
  };
  while (queue.length) {
    const at = queue.shift();
    const task = byId.get(at);
    if (task) {
      take(task.parentId);
      take(task.retryOf);
      take(task.retriedAs);
    }
    for (const other of every) {
      if (other.parentId === at || other.retryOf === at) take(other.id);
    }
  }
  return joined;
}

/**
 * The agents one person has, as somebody deciding who to ask would want them:
 * where each one works, whether it lives somewhere, and what each one is
 * holding - because the answer changes if they are already buried.
 */
export function directory(registry, owned, { exclude = null } = {}) {
  return owned
    .filter((agent) => agent.id !== exclude)
    .map((agent) => {
      const holding = tasksFor(registry, agent.id, { role: "to" }).filter((task) =>
        LIVE.has(task.state),
      );
      return {
        id: agent.id,
        name: agent.name,
        repos: agent.repos ?? [],
        lastSeenAt: agent.lastSeenAt ?? null,
        openTasks: holding.length,
        // Where it lives, if it lives anywhere - the one thing about an agent
        // that changes what may be asked of it and what may not be done
        // around it.
        resident: agent.resident ?? null,
      };
    });
}
