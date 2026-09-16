// What a page handler may see, and who is asking.
//
// The console's pages - Executors, Performance, Search, Tools, one session -
// are handlers over the same handful of questions: which workspace is open,
// which repos, sessions, pull requests and spans reach it, and whether this
// reader may read a session's words. index.js answered all of that inline,
// which meant the pages could only ever be mounted one way: the cloud's, with
// workspaces, a demo, and other people's rows in the answer.
//
// This is the seam between a page and the installation it is being served
// for. `scopeFor` builds one object carrying those answers - the cloud's
// where the answer is the same either way, and handed in by the entry point
// where it is not: the rows only the cloud has (somebody's invited agents,
// their vendors' agents), the name behind an address, what an agent is doing
// this second. Everything handed in has a default that says nothing rather
// than one that throws, so an entry point that has no such rows mounts the
// same pages and gets its own work alone, with no branch inside the pages
// to keep in step.
//
// The methods call each other through the object rather than through their
// own closures, so an entry point that replaces one - `scopeOf`, say, on an
// installation with no workspaces to be in - replaces it for everything
// built on it.
import { repos } from "./repos.js";
import * as sessionLog from "./sessions.js";
import * as sessionWhere from "./session-where.js";
import * as pulls from "./pulls.js";
import * as spans from "./spans.js";
import * as harnesses from "./harnesses.js";
import * as accessTrail from "./access-trail.js";
import { workspaces } from "./workspaces.js";
import { describeTask, dueAt } from "./agent-tasks.js";
import { costs, rollup, elapsed } from "./costs.js";
import { usedFor, isEmpty as nothingUsed } from "./task-usage.js";

/**
 * What can be done to a session nothing here runs.
 *
 * The default answer to "may this be steered", for an installation that only
 * watches: the same words acp.js gives a harness session, since that is what
 * every session is when this app starts none of them.
 */
export const WATCHING_ONLY = {
  tier: "C",
  prompt: false,
  cancel: false,
  latency: null,
  why: "This session is your own Claude Code reporting here; CoderVibes only watches it.",
};

/** The joins `taskForBrowser` reads when nobody has read them already. */
const EMPTY_LINKS = { pulls: new Map(), sessions: new Map(), used: new Map() };

function wrap(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      const status = err.status ?? (err.code === "ENOENT" ? 404 : 500);
      res.status(status).json({
        error: err.message,
        code: err.code,
        // Set where the answer is "sign in" rather than "that failed", so the
        // console can say so instead of reporting a fault.
        ...(err.signInRequired ? { signInRequired: true } : {}),
      });
    });
  };
}

/**
 * The scope the pages are mounted with.
 *
 * @param {object} deps what this installation answers differently - every
 *   field below may be replaced, and what is not replaced is the answer for
 *   an installation that has one person, no workspace and no agents of its
 *   own to speak of.
 */
export function scopeFor(deps = {}) {
  const scope = {
    wrap,

    // ---- who is asking -------------------------------------------------
    //
    // Passed in rather than imported, because deciding who the caller is
    // is the entry point's job: the cloud verifies a Firebase token, and an
    // installation serving one person on their own machine has nobody to
    // check. The default lets everybody through, which is the honest answer
    // when there is only ever one caller.
    requireViewer: (req, res, next) => next(),
    requireUser: (req, res, next) => next(),

    /** What this person asked to be called, or the address when nobody asked. */
    nameOf: async (user) => user,

    /** The connector identities the adoption figures match GitHub logins by. */
    identities: async () => [],

    /** What can be done to a session - see acp.js for the tiers. */
    tierOf: () => WATCHING_ONLY,

    /** What an agent is doing this second, or null when nothing here watches one. */
    agentNow: () => null,

    /** The tool calls made under a task while it is open. */
    taskCalls: () => [],

    /** What a task on a clock has spent so far. */
    spentSoFar: () => 0,

    /** A look at the tracker for any task whose ticket was last read a while ago. */
    refreshTickets: async () => 0,

    /** The connectors and tools Search offers beside the sessions. */
    catalogueSources: () => ({ connectors: [], tools: [] }),

    /**
     * What the setup line this installation hands out carries: a token, and
     * this app's tools as an MCP server (setup-script.js).
     *
     * The one field here whose default is the fuller answer rather than the
     * emptier one. Everything else defaults to saying nothing, because
     * saying nothing is the safe direction; for this it is the opposite - an
     * entry point that forgot to say would hand out a script with no token
     * check, on an installation that has accounts. So the cloud's answer is
     * the default and an installation with nobody to authenticate says so.
     */
    setup: { token: "required", mcp: true },

    /** This person's invited agents, as rows of the Executors list. */
    agentRows: async () => [],

    /** Their vendors' agents, the same way. */
    externalRows: async () => [],

    /** The harnesses they declared, as records - `describeHarness` is the page's. */
    harnessRows: (user) => harnesses.listFor(user).catch(() => []),

    /** One of their vendors' agents by id, for the pages that open a row. */
    externalOf: async () => null,

    /** Tell the room an agent has lost its seat. */
    agentGone: async () => {},

    /**
     * What is waiting on a person, for the Activity page (pages/activity.js):
     * tasks parked on a review or a question, access requests, calls held
     * for approval, open pull requests - each as a row with `waitingOn.since`
     * on it. Nothing, by default: waiting is what tasks and approvals do,
     * and an installation that hands out neither has nothing to answer
     * with. The cloud's rows are index.js `waitingRows`.
     *
     * @param {object} req
     * @param {{sessions: object[], records: object[]}} read the month's
     *   sessions in scope and its pull request records, already read for
     *   the page - so the rows can be whose-agent'd and de-duplicated
     *   against them without reading twice.
     */
    waitingRows: async () => [],

    // ---- where the caller is standing ----------------------------------

    /** The workspace the caller has open, as an id - what every listing is scoped to. */
    scopeOf: (req) => req.cv.workspace?.id ?? null,

    /** The repos the caller sees: the ones in the open workspace they may open. */
    visibleRepos: (req) => repos.listFor(req.cv.user, { workspace: scope.scopeOf(req) }),

    /** Whether the open workspace is the shared demo (workspaces.js `isDemo`). */
    demoOpen: (req) => Boolean(req.cv.workspace?.demo),

    /**
     * Whose own records a page reads.
     *
     * Nearly everything here is scoped by the open workspace already - the
     * sessions, the pull requests, the spans - and reads the same for whoever
     * has it open. Two pages are not like that: Executors is the things *you*
     * run and Connectors is the services *you* have connected, and both are
     * answered from the caller's own row rather than from the room.
     *
     * Which leaves them blank in the demo, for everybody. The demo belongs to
     * nobody real (scripts/seed-demo.mjs): its workspace, its repos, its
     * agents and its connections are the made-up people's, so "yours" there is
     * nothing, and the two pages that should be showing a month of a team's
     * setup showed Connect your setup instead. So in the demo they read the
     * demo's people, all of them, and everywhere else they read the caller as
     * before.
     *
     * Nothing is loosened by this. The demo is public by construction - a
     * visitor with no account at all may read it (session.js
     * `resolveWorkspace`) - and every route that writes still asks
     * `requireUser` and then a grant, which nobody holds here because nobody
     * is a member of the demo (workspaces.js `canSee`).
     */
    readersOf: (req) =>
      scope.demoOpen(req) ? req.cv.workspace.members.map((member) => member.email) : req.cv.user ? [req.cv.user] : [],

    /**
     * Where a piece of work sits relative to the open workspace, from the repo
     * it names and the repository it was done in - `workspace`, `external`,
     * `none`, or null for work this workspace never sees. The rule and the
     * reasoning are session-where.js; the three words are on every row the
     * pages draw, because a listing that mixes the workspace's own repos with
     * repositories nobody here registered has to say which is which.
     *
     * The repo's workspace is read off the repo rather than stamped on the
     * record, so a repo moved to another workspace takes its history with it.
     */
    whereOf: (req, { repoId = null, repository = null, host = "github", owner = null }) =>
      sessionWhere.whereIn(scope.scopeOf(req), { repoId, repository, host, owner }),

    /** What this request asked to see, from `?where=` - `workspace` alone unless it said. */
    wheresOf: (req) => sessionWhere.parse(req.query?.where),

    /** How a session names where it was done, for `whereOf` and `roomsOf`. */
    placeOf: (session) => ({
      repoId: session.repoId ?? null,
      repository: session.repo?.fullName ?? null,
      // Which git host the checkout's remote was on. Absent on every
      // session recorded before there was a choice, and those are GitHub's.
      host: session.repo?.host ?? "github",
      owner: session.owner ?? null,
    }),

    /** Whether a session is shown in the open workspace, under what the request asked for. */
    sessionInScope(req, session, wheres = scope.wheresOf(req)) {
      const where = scope.whereOf(req, scope.placeOf(session));
      return Boolean(where) && wheres.includes(where);
    },

    /**
     * The word for a session, for a page that has one in front of it rather
     * than a listing to filter. A session that reaches the open workspace no
     * way at all still gets a word - the viewer opened it from somewhere, and
     * "not this workspace's repo" is the true thing to say about it either
     * way; which of the two it is, is the shape of the record.
     */
    whereOfSession: (req, session) =>
      scope.whereOf(req, scope.placeOf(session)) ?? (session.repo?.fullName ? "external" : "none"),

    /**
     * Whether this person may read a session at all: it is in a workspace
     * they are in, or it is their own. The listings are narrower (the open
     * workspace); a link to one session from anywhere of theirs should open,
     * and so should one of their own that is no repo's - it is off every
     * page, not secret from them.
     */
    sessionVisible(req, session) {
      const rooms = sessionWhere.roomsOf(scope.placeOf(session));
      if (rooms.some((roomId) => workspaces.canSee(workspaces.find(roomId), req.cv.user))) return true;
      return Boolean(session.owner) && session.owner === req.cv.user;
    },

    /**
     * The sessions of the open workspace, lately. What every listing page starts
     * from - so `?where=` reaches Activity, Performance, Tools, Search and the
     * executors' pages through this one function, and none of them has to know
     * the rule.
     *
     * Each row comes back with `where` on it, the word for how it reached this
     * workspace: the pages mark the rows that are not the workspace's own repos'
     * (console-lists.js `whereChip`), which is the point of showing them at all.
     * The record is copied to stamp it - `list` hands out the live objects.
     */
    async sessionsInScope(req, { since, limit = 500, wheres = scope.wheresOf(req) } = {}) {
      const all = await sessionLog.list({ since, limit });
      const out = [];
      for (const session of all) {
        const where = scope.whereOf(req, scope.placeOf(session));
        if (where && wheres.includes(where)) out.push({ ...session, where });
      }
      return out;
    },

    /**
     * Whether a pull request is shown in the open workspace: it was opened from
     * a repo in it, or it is on a repository one of the workspace's repos holds
     * (a person's own pull request on the same repository, say, which the
     * Pulls page shows beside the agents' - see pulls.js scopeOf).
     */
    pullInScope(req, pull) {
      const workspace = scope.scopeOf(req);
      if (pull.repoId) return repos.inWorkspace(repos.repos.get(pull.repoId), workspace);
      return [...repos.repos.values()].some((repo) => repo.source?.repo === pull.repo && repos.inWorkspace(repo, workspace));
    },

    /** The pull requests of the open workspace, lately. */
    async pullsInScope(req, options) {
      const all = await pulls.list(options);
      return all.filter((pull) => scope.pullInScope(req, pull));
    },

    /**
     * The recent spans of the open workspace - the same line `sessionInScope`
     * draws (`whereOf`), read off the span's own attributes: the repo it was
     * for, the repository, and whose it was. A span that reaches this
     * workspace no way at all is in no workspace, as its session is, and one
     * that reaches it as `external` or `none` is kept only when the request
     * asked for that - so the Tools page and the trail count the same work
     * their session lists show and not a span more.
     */
    spansInScope(req, since, wheres = scope.wheresOf(req)) {
      const { spans: records, reach } = spans.recent({ since });
      const kept = records.filter((span) => {
        const where = scope.whereOf(req, {
          repoId: span.attrs?.["cv.repo.id"] ?? null,
          repository: span.attrs?.["cv.repo"] ?? null,
          owner: span.attrs?.["cv.owner"] ?? null,
        });
        return Boolean(where) && wheres.includes(where);
      });
      return { spans: kept, reach };
    },

    /**
     * The access trail of the open workspace for a range: every call an
     * agent made under a permission, every one refused, every permission
     * asked for and every call the owner was asked to approve - on the repos
     * of the workspace, off the spans of the same (access-trail.js). The
     * words on an entry (the reason given, the arguments asked with) go to
     * somebody who may open the repo; the rest see who, what and how it went.
     *
     * Here rather than on the page that draws it, because two pages read it:
     * Search shows the trail, and the friction report joins the refusals on
     * it per session.
     */
    trailInScope(req, since) {
      const workspace = scope.scopeOf(req);
      const mine = [...repos.repos.values()].filter((repo) => repos.inWorkspace(repo, workspace));
      const { spans: records } = scope.spansInScope(req, since);
      const readable = new Set(mine.filter((repo) => repos.canAccess(repo, req.cv.user)).map((repo) => repo.id));
      const entries = accessTrail.collect({ repos: mine, spans: records, since });
      return { entries, readable };
    },

    /**
     * Whether this person may read a session's words, not only its counts: the
     * owner, and anyone who can read the repo it worked in. The same line
     * /api/sessions/:id draws between a timeline and its shape.
     */
    mayReadWords(session, user) {
      if (session.owner === user) return true;
      const repo = session.repoId ? repos.repos.get(session.repoId) : null;
      return repo ? repos.canAccess(repo, user) : false;
    },

    /** The display names of these people, looked up once each. */
    async namesOf(users) {
      const names = new Map();
      await Promise.all([...new Set(users.filter(Boolean))].map(async (user) => {
        names.set(user, await scope.nameOf(user).catch(() => null));
      }));
      return names;
    },

    // ---- the tasks a row carries ---------------------------------------
    //
    // Here rather than on the Executors page that draws them, because the
    // repo's Tasks tab draws the same cards from index.js.

    /**
     * One task as the console reads it: the record, how long it has been open,
     * and what it cost - its own, and the roll-up including everything it handed
     * on, which is the number "what did that feature cost" actually wants. Not
     * shown until somebody asks for it: see the Cost button in console-tasks.js.
     *
     * @param {object[]} everyTask every task on the installation, because a
     *   subtask can live in a different repo to its parent
     */
    taskForBrowser(task, everyTask, links = EMPTY_LINKS) {
      // What is being done for it, while it is being done: the agent's own
      // progress lines (on the record) and the tool calls made under it (on the
      // activity feed), in one order. A closed task has had the feed folded into
      // its record already (agent-tasks.js updateTask), so only a live one reads
      // the feed - reading it for both would say everything twice.
      const live = task.state === "open" || task.state === "accepted" || task.state === "blocked";
      const calls = live ? scope.taskCalls(task.id) : [];
      const steps = [
        ...(task.steps ?? []),
        ...calls.map((call) => ({
          at: new Date(call.at).toISOString(),
          text: call.summary,
          kind: "did",
          ok: call.state !== "failed",
          running: call.state === "running",
        })),
      ].sort((a, b) => String(a.at).localeCompare(String(b.at)));
      const running = calls.findLast((call) => call.state === "running");
      return {
        ...describeTask(task),
        steps,
        // The one line for the row: what the agent holding it is doing this
        // second, or null when it is between calls (the row then says
        // "thinking", off the agent's own state).
        doing: running ? running.summary : null,
        openMs: elapsed(task),
        // When its time is up, if it is on a clock - see agent-tasks.js "Time".
        dueAt: dueAt(task),
        cost: {
          own: scope.spentSoFar(task),
          total: rollup(costs, everyTask, task.id),
          subtasks: everyTask.filter((entry) => entry.parentId === task.id).length,
        },
        // What it came to and what it was done with - see agent-tasks.js
        // "Outcomes". Pull requests are the pull records' view (pulls.js
        // `taskIds`); sessions are the session log's; `used` is on the record
        // once closed and read from the spans while live.
        pulls: links.pulls.get(task.id) ?? [],
        sessions: links.sessions.get(task.id) ?? [],
        used: task.used ?? links.used.get(task.id) ?? null,
      };
    },

    /** The tasks these agents are party to, at either end. */
    tasksOf: (everyTask, agents) =>
      everyTask.filter((task) => agents.some((agent) => agent.id === task.to.id || agent.id === task.from.id)),

    /**
     * The joins a set of tasks needs, read once for the lot: their pull
     * requests, their sessions, and - for the live ones, whose record does not
     * hold it yet - what the spans say they have used so far. And a look at
     * Linear for any ticket whose last look is stale, so the tab says where the
     * ticket is now, not where it was.
     */
    async linksFor(tasks) {
      const ids = tasks.map((task) => task.id);
      const repoIds = [...new Set(tasks.map((task) => task.repoId))];
      const liveOnes = tasks.filter((task) => !task.used && (task.state === "open" || task.state === "accepted" || task.state === "blocked"));
      const [pullMap, sessionMap, usedRows] = await Promise.all([
        pulls.byTask(repoIds).catch(() => new Map()),
        sessionLog.byTask(ids).catch(() => new Map()),
        Promise.all(liveOnes.map((task) => usedFor(task.id).then((used) => [task.id, nothingUsed(used) ? null : used]).catch(() => [task.id, null]))),
        scope.refreshTickets(tasks).catch(() => 0),
      ]);
      return { pulls: pullMap, sessions: sessionMap, used: new Map(usedRows.filter(([, used]) => used)) };
    },
  };

  return Object.assign(scope, deps);
}
