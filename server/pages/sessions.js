// One session: what it did, and what can be done to it.
//
// The record is counts, ids and names (sessions.js); this is the page's view
// of one - the outcome its pull requests give it, the machine and the trigger
// by name rather than by id, and the timeline behind the counts. The same
// view is what every listing draws a row from, so `describeSession` is
// exported beside the routes: Activity, Home and an executor's sessions all
// show the same session, and two shapes of it would drift.
//
// Mounted with a scope (server/scope.js) rather than reaching for the
// installation itself: which sessions this reader may see, whose words they
// may read, and what may be said to a live one are the scope's answers.
import * as sessionLog from "../sessions.js";
import * as sessionEvents from "../session-events.js";
import * as spans from "../spans.js";
import * as pulls from "../pulls.js";
import * as performance from "../performance.js";
import * as friction from "../friction.js";
import * as harnesses from "../harnesses.js";
import { repos } from "../repos.js";
import { describeTask, findTask, dueAt } from "../agent-tasks.js";
import { elapsed } from "../costs.js";

/**
 * A session as the Activity page lists it: the record, its outcome as the
 * pull requests say it, and the names a browser would otherwise have to
 * look up - the repo's, and a person's. `user` is who is looking, for the
 * one field on it that is words.
 */
export function describeSession(scope, session, { pulls: records = [], names = new Map(), user = null } = {}) {
  // The search vector never leaves the server. It is kept on the record so a
  // month of them costs no table (sessions.js `noteSearch`), and `...session`
  // then posted all of it to the browser: 256 packed floats per row, which on
  // the demo's Activity page was 200KB of a 933KB answer - a quarter of the
  // page's weight, for a field nothing on the page reads. Searching is done
  // here, against the index; the browser sends words and gets rows back.
  const { search, ...record } = session;
  return {
    ...record,
    // The one thing on the record that is words (sessions.js, the essay):
    // the viewer gets it under the words rule. A caller that names no
    // viewer gets no title - safe when forgotten, not leaky.
    title: user && scope.mayReadWords(session, user) ? session.title ?? null : null,
    // The links: the machine by name, and where what set it off can be
    // found. The record keeps ids (sessions.js), and a page that has to
    // look each one up is a page that draws a bare id when the lookup is
    // late or the thing is gone.
    machine: describeSessionMachine(session.machine),
    trigger: describeTrigger(session.trigger),
    counts: { ...session.counts, guidance: sessionLog.guidanceOf(session) },
    outcome: performance.outcomeOf(session, records),
    // What the whole session came to, in one word (performance.js
    // `yieldOf`) - including the sessions that took nothing on, which the
    // outcome above has nothing to say about.
    yield: performance.yieldOf(session, records, [], {}),
    pulls: performance.pullsOf(session, records).map((pull) => ({
      id: pull.id, number: pull.number, url: pull.url ?? null, state: pull.state, repo: pull.repo ?? null,
      // Which git host, so the card can call a GitLab one a merge request
      // and link to the right place (git-hosts/index.js).
      host: pull.host ?? "github",
      title: pull.title ?? null, changesRequested: performance.roundsOf(pull),
      // And what became of it after it merged (pulls.js): taken back out,
      // followed by a fix, red on the branch, or in production.
      reverted: pull.reverted ?? null,
      followUps: performance.followUpsOf(pull),
      brokeBuild: pull.brokeBuild ?? null,
      shipped: pull.shipped ?? null,
      rolledBack: pull.rolledBack ?? null,
      durability: pull.durability ?? null,
      // ---- pull-cost ----
      // What it cost, phase by phase, and what kind of work it was
      // (pull-cost.js) - the bar the session page draws under the line.
      cost: pull.cost ?? null,
      workKind: pull.workKind ?? null,
      workKindFrom: pull.workKindFrom ?? null,
      // ---- end pull-cost ----
      // And how much of it an agent wrote (pull-aftermath.js): counts and a
      // share, so the card can say "78% agent-written" without the reader
      // opening GitHub.
      attribution: pull.attribution ?? null,
      diff: pull.diff ? { additions: pull.diff.additions ?? null, deletions: pull.diff.deletions ?? null, changedFiles: pull.diff.changedFiles ?? null } : null,
    })),
    repoName: session.repoId ? repos.repos.get(session.repoId)?.name ?? null : null,
    ownerName: names.get(session.owner) ?? null,
    // The vendor behind the model and the harness it ran in, by label -
    // what a glance at a card wants (console-home.js workCard), and what
    // Performance compares by (performance.js groupOf). The model ids
    // themselves stay on `models` for the session page. Not reported is
    // null here, so the card draws a dash rather than words.
    provider: providerNameOf(session),
    harnessName: harnessNameOf(session),
    friction: performance.friction(session),
    // How much of the work it did on its own: turns, the two clocks, what
    // kind each steer was, and whether any of that could be seen at all
    // (performance.js `autonomyFigures` - an external vendor's agent is
    // unobserved rather than unsteered, and the page must say which).
    autonomy: performance.autonomyFigures(session),
    // What got in its way, by kind, with the line that says what usually
    // fixes each (friction.js). The counts are on `counts.friction`
    // already; this is them sorted and given their words, so the page does
    // not carry the table.
    frictionKinds: friction.kindsOf(session),
    repeats: friction.repeatsOf(session),
    // How much code it wrote and how much of that survived to a merge
    // (performance.js `editsOf`). `measured` false is a session whose lines
    // nobody has - the page says which of the reasons it was, since
    // "this harness cannot report lines" was being said about Claude Code
    // records that merely predate the count.
    written: performance.editsOf(session),
  };
}

/** The vendor behind a session's first model, by label - null when it reported none. */
function providerNameOf(session) {
  const group = performance.groupOf(session, "provider");
  return group.key === "unknown" ? null : group.name;
}

/** The harness a session ran in, by its label - null when the record never said. */
function harnessNameOf(session) {
  const kind = performance.harnessKindOf(session);
  return kind ? harnesses.KINDS[kind]?.label ?? kind : null;
}

/**
 * The machine a session ran on, as the session says.
 *
 * This used to be a lookup: the id came off a span, and the fleet gave it a
 * name - or did not, in which case the machine had been destroyed and the
 * answer said `gone`. There is no fleet. Every machine named here is
 * somebody's own laptop or their own e2b sandbox, reported by the session
 * start hook (telemetry-ingest.js `whereOf`), and this app has no way to
 * know whether it still exists and no business claiming it does not - saying
 * `gone` about one read as "your work ran somewhere that has been deleted"
 * for work that had just finished.
 */
function describeSessionMachine(machine) {
  if (!machine?.id) return null;
  // `hostLabel` is the host as a page says it - "Laptop", "e2b sandbox" -
  // the same words the Performance charts use for it.
  return { id: machine.id, name: machine.name ?? null, host: machine.host ?? null, hostLabel: machine.host ? performance.hostLabel(machine.host) : null, gone: false };
}

/**
 * What set a session off, with where that thing lives named: the repo the
 * task belongs to (`key` is its id). Records written before the messaging
 * went (2026-09) can name an agent's private line instead (`key` is
 * `agent:<id>`), and those are still described, so an old session still
 * says what set it going.
 */
function describeTrigger(trigger) {
  if (!trigger?.kind) return null;
  const key = trigger.key ?? null;
  let where = null;
  if (key?.startsWith("agent:")) {
    const id = key.slice("agent:".length);
    // Whoever's it is: a session is everyone's to read, so the name on
    // its link is too. Names and ids only, as ever.
    const agent = [...repos.repos.values()].flatMap((repo) => repo.agents ?? []).find((entry) => entry.id === id) ?? null;
    where = { kind: "agent", id, name: agent?.name ?? null };
  } else if (key) {
    where = { kind: "repo", id: key, name: repos.repos.get(key)?.name ?? null };
  }
  return { ...trigger, where };
}

/**
 * Whether a session is back at work on a pull request that was handed to
 * a person: its turn is running and began after the agent last said the
 * pull request was ready (pulls.js `readyAt`; since it opened, for a
 * record made only from webhooks). The turn it was opened in does not
 * count - the agent says "ready" mid-turn and finishes its say.
 *
 * @param {object} record the pull record
 * @param {string} sessionId
 * @returns {{since: number}|null}
 */
function backAt(record, sessionId) {
  if (!sessionLog.isLive(sessionId)) return null;
  const turn = sessionEvents.turnOf(sessionId);
  if (turn?.status !== "running") return null;
  const ready = record.readyAt ?? record.openedAt ?? 0;
  return turn.since > ready ? { since: turn.since } : null;
}

/** Whether any session that opened the pull request is back at work on it - see `backAt`. */
export const busy = (record) => (record.sessionIds ?? []).some((id) => backAt(record, id));

/**
 * What a session is doing this second - the Home page's additions to a
 * session record.
 *
 * A session is counts and ids, which is enough to say "Ada has been at it
 * for twenty minutes" but not what she is at. That lives on the activity
 * feed and the task, both of which hold what somebody typed - a path, a
 * command, a task's title - so they are read here with the same line the
 * session route draws: the owner and the repo's members see it, everybody
 * else sees that a tool is running and which one.
 *
 * Nothing here is a way to reach the agent. There was one until 2026-09 -
 * a box that posted a line into the repo's chat or onto the agent's private
 * line - and it went with the messaging. What a person hands an agent now
 * is a task; what they answer it with is the Resume on the task it stopped
 * on, which `task.waitingOn` below is what the card draws.
 */
export function nowOf(scope, session, user, { pulls: byPullId = new Map() } = {}) {
  const repo = session.repoId ? repos.repos.get(session.repoId) : null;
  const own = session.owner === user || (repo ? repos.canAccess(repo, user) : false);
  const actor = session.actor ?? {};
  const agent = actor.kind === "agent" && actor.id ? scope.agentNow(actor.id) : null;
  const running = agent?.calls.findLast((call) => call.state === "running") ?? null;
  // The task it is on: the latest one under the session that is still
  // open, else the latest at all - a session between tasks is still about
  // the one it just closed.
  const tasks = (session.taskIds ?? []).map((id) => findTask(repos, id)?.task).filter(Boolean);
  const task = tasks.findLast((entry) => entry.state === "open" || entry.state === "accepted" || entry.state === "blocked")
    ?? tasks[tasks.length - 1] ?? null;
  // The pull request it is back on, when it is: one it opened that is
  // still open, and this turn began after it was said to be ready. Its
  // card is away from Needs action for the turn (`busy`); this says so
  // on the working card instead.
  let backOn = null;
  for (const pull of session.pulls ?? []) {
    const record = pull?.id ? byPullId.get(pull.id) : null;
    if (!record || record.state !== "open") continue;
    const at = backAt(record, session.id);
    if (at) backOn = { repo: record.repo, number: record.number, url: record.url ?? pull.url ?? null, since: at.since };
  }
  return {
    own,
    doing: running
      ? { tool: running.tool, summary: own ? running.summary : null, since: running.at }
      : null,
    thinking: agent?.thinking ?? false,
    // What is stopping it, if anything. The message is the provider's, and
    // a provider's message can quote the request - so it stays with the
    // people who could read the request anyway.
    trouble: agent?.trouble ? { since: agent.trouble.since, message: own ? agent.trouble.message : null } : null,
    // `waitingOn` is the kind alone - "person" is what the card needs to
    // know, to draw the Resume that brings the task back (task-waits.js
    // `resumedByPerson`).
    // The ticket the task does (agent-tasks.js "Outcomes") travels with it,
    // id and link: it is a name in a tracker, the way a pull request's
    // number is a name on GitHub, not something anyone typed here.
    task: task
      ? {
        id: task.id, repoId: task.repoId ?? session.repoId ?? null, state: task.state, waitingOn: task.waitingOn?.kind ?? null,
        title: own ? task.title : null, openMs: elapsed(task), dueAt: dueAt(task),
        ticket: task.outcome?.ticket?.id
          ? { kind: task.outcome.ticket.kind ?? "linear", id: task.outcome.ticket.id, url: task.outcome.ticket.url ?? null }
          : null,
      }
      : null,
    backOn,
  };
}

/** Whether this person may read a session's words, not only its counts - see /api/sessions/:id. */
export async function sessionAccess(scope, req) {
  const session = await sessionLog.get(String(req.params.id));
  if (!session || !scope.sessionVisible(req, session)) return { session: null, own: false };
  const repo = session.repoId ? repos.repos.get(session.repoId) : null;
  const own = session.owner === req.cv.user || (repo ? repos.canAccess(repo, req.cv.user) : false);
  return { session, own };
}

export function mount(app, scope) {
  const { wrap, requireViewer } = scope;

  /**
   * One session with the timeline behind its counts. Anyone in its workspace
   * may read one - to anybody else it does not exist; what a viewer who does
   * not own it gets is the timeline with only the attributes that are counts,
   * ids and names on it - a span from somebody else's agent says "read_file,
   * 12ms, ok", never which file. The owner, and anyone on the repo, sees
   * everything a span carries. The tasks are treated the same way: their
   * titles and notes are what somebody typed.
   */
  app.get("/api/sessions/:id", requireViewer, wrap(async (req, res) => {
    const session = await sessionLog.get(String(req.params.id));
    if (!session || !scope.sessionVisible(req, session)) return res.status(404).json({ error: "No such session" });
    const repo = session.repoId ? repos.repos.get(session.repoId) : null;
    const own = session.owner === req.cv.user || (repo ? repos.canAccess(repo, req.cv.user) : false);
    const records = session.pulls?.length
      ? (await Promise.all(session.pulls.map((pull) => pulls.get(pull.repo, pull.number, pull.host ?? "github").catch(() => null)))).filter(Boolean)
      : [];
    const timeline = (await spans.forSession(session.id)).map((span) => (own ? span : spans.countsOnly(span)));
    // The commands it ran over and over, with their words for whoever may
    // read them: the record keeps a fingerprint (friction.js), and the words
    // are on this session's own log under the words rule.
    const described = describeSession(scope, { ...session, where: scope.whereOfSession(req, session) }, { pulls: records, names: await scope.namesOf([session.owner]), user: req.cv.user });
    if (own && described.repeats.length) {
      const words = new Map();
      for (const entry of await sessionEvents.since(session.id, 0, { limit: 500 })) {
        if (entry.kind !== "tool_call" || !entry.title) continue;
        const hash = friction.commandHash(entry.title);
        if (!words.has(hash)) words.set(hash, friction.normaliseCommand(entry.title));
      }
      described.repeats = described.repeats.map((repeat) => ({ ...repeat, title: words.get(repeat.hash) ?? null }));
    }
    const tasks = (session.taskIds ?? []).map((id) => findTask(repos, id)?.task).filter(Boolean).map((task) =>
      own
        ? describeTask(task)
        : { id: task.id, state: task.state, createdAt: task.createdAt, updatedAt: task.updatedAt, estimateMinutes: task.estimateMinutes ?? null, retryOf: task.retryOf ?? null, attempt: task.attempt ?? null },
    );
    res.json({
      session: described,
      own,
      // What it is doing this second and who to say something to - the same
      // as the Home page's card, so the session opens with the box the card had.
      now: nowOf(scope, session, req.cv.user),
      // What can be done to it - the buttons to draw, and why not (acp.js).
      // Which is one thing at most: answering a task the agent stopped on.
      steering: own ? scope.tierOf(session) : { tier: "C", prompt: false, cancel: false, latency: null, why: "Not your session to steer." },
      // How to carry it on in the harness that ran it. The same rule as the
      // transcript: this is for the people on the session's repo, who are
      // the people who could pick the work up.
      // What the harness this ran in resumes the conversation by, and the
      // line to type (harnesses.js `resumeFor`). Which harness it was is
      // read the way every page reads it - the record's kind, or the export
      // that named one. The same rule as the transcript: this is for the
      // people on the session's repo, who are the people who could pick the
      // work up.
      resume: own ? harnesses.resumeFor(session, performance.harnessKindOf(session)) : null,
      spans: timeline,
      tasks,
      pulls: records.map((pull) => ({
        id: pull.id, repo: pull.repo, number: pull.number, title: pull.title, url: pull.url, state: pull.state,
        openedAt: pull.openedAt, mergedAt: pull.mergedAt, closedAt: pull.closedAt, reviews: pull.reviews?.length ?? 0,
        changesRequested: performance.roundsOf(pull), comments: pull.comments ?? 0,
        // What became of it after it merged - the page draws a line each
        // (console-home.js `pullLine`), with a way to the thing that says so.
        reverted: pull.reverted ?? null,
        followUps: pull.followUps ?? [],
        brokeBuild: pull.brokeBuild ?? null,
        shipped: pull.shipped ?? null,
        rolledBack: pull.rolledBack ?? null,
        durability: pull.durability ?? null,
        // ---- pull-cost ----
        cost: pull.cost ?? null,
        workKind: pull.workKind ?? null,
        workKindFrom: pull.workKindFrom ?? null,
        // ---- end pull-cost ----
        // Who wrote the lines it merged, and how big it is.
        attribution: pull.attribution ?? null,
        diff: pull.diff ? { additions: pull.diff.additions ?? null, deletions: pull.diff.deletions ?? null, changedFiles: pull.diff.changedFiles ?? null } : null,
      })),
    });
  }));

  /**
   * A session's log from `since` (a seq; 0 for the start), oldest first -
   * see session-events.js. The words are on it, so the words go to whoever
   * may read the repo and the shape of them (`publicView`) to anybody else.
   * `next` is where to ask from next time; `turn` is what the last status
   * line said. With `Accept: text/event-stream` the same, then live: every
   * entry as it lands, until the connection closes.
   */
  app.get("/api/sessions/:id/events", requireViewer, wrap(async (req, res) => {
    const { session, own } = await sessionAccess(scope, req);
    if (!session) return res.status(404).json({ error: "No such session" });
    const since = Number(req.query.since) || 0;
    const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 1000);
    const view = (entry) => (own ? entry : sessionEvents.publicView(entry));
    const events = (await sessionEvents.since(session.id, since, { limit })).map(view);
    const next = events.length ? events.at(-1).seq : since;

    if (!/text\/event-stream/.test(req.get("accept") ?? "")) {
      return res.json({ events, next, turn: sessionEvents.turnOf(session.id), steering: own ? scope.tierOf(session) : null });
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    let last = next;
    const send = (entry) => {
      if (entry.seq <= last) return;
      last = entry.seq;
      res.write(`id: ${entry.seq}\nevent: entry\ndata: ${JSON.stringify(view(entry))}\n\n`);
    };
    for (const entry of events) res.write(`id: ${entry.seq}\nevent: entry\ndata: ${JSON.stringify(entry)}\n\n`);
    const stop = sessionEvents.subscribe(send, { session: session.id });
    const beat = setInterval(() => res.write(": beat\n\n"), 25_000);
    beat.unref?.();
    req.on("close", () => {
      clearInterval(beat);
      stop();
    });
  }));
}
