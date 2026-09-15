// The Executors page: everything that does work here, on one list.
//
// Three kinds of row come from records somebody made - an agent this app
// invited, a harness declared for a machine, a vendor's agent connected -
// and one kind comes from the work itself: a setup that nobody declared and
// that this app finds out about when its first session arrives
// (`discoveredSetups`). Only the last kind is available to every
// installation, so it is the only one this module builds itself. The rest
// are handed in through the scope (server/scope.js), already shaped: an
// installation that invites no agents and connects no vendors mounts this
// page unchanged and gets its own machines, which is the whole of what it
// has.
//
// `locationOf` and `standingOf` are exported for the same reason - the rows
// the scope hands in have to carry the same Location column and the same
// month's standing as the ones built here, or the list would disagree with
// itself row by row.
import * as performance from "../performance.js";
import * as sessionLog from "../sessions.js";
import * as pulls from "../pulls.js";
import * as spans from "../spans.js";
import * as harnesses from "../harnesses.js";
import * as ingestToken from "../ingest-token.js";
import { MAX_EXECUTORS } from "../edition.js";
import { repos } from "../repos.js";
import { allTasks } from "../agent-tasks.js";
import { anyPriced } from "../costs.js";
import { fold as foldUsage } from "../task-usage.js";

/**
 * The month's ranking by agent (performance.js), kept for a minute: the
 * Agents list asks on every refresh, and the answer is a read of every
 * session in thirty days. A failed read is no ranking, not a failed list.
 */
const rankings = new Map();
function rankingBy(by) {
  const now = Date.now();
  const held = rankings.get(by);
  if (held?.rows && now - held.at < 60_000) return held.rows;
  const since = now - performance.RANGES["30d"];
  const fresh = {
    at: now,
    rows: Promise.all([sessionLog.list({ since, limit: 1000 }), pulls.list({ since, limit: 1000 })])
      .then(([sessions, records]) => new Map(performance.rank(sessions, records, { by, range: "30d", tasks: allTasks(repos) }).rows.map((row) => [row.key, row])))
      .catch(() => new Map()),
  };
  rankings.set(by, fresh);
  return fresh.rows;
}

/**
 * Where an executor runs, in one shape for every kind.
 *
 * There used to be two answers: a sandbox of ours for a resident, and "your
 * machine" for everything else. Only the second is true now - every agent
 * runs where its owner runs it - and which machine that is comes from the
 * work rather than from the record: a setup that reports telemetry says so
 * itself (see `discoveredSetups`).
 *
 * `whose` is what to call that machine when it is not the caller's. The
 * list is one person's everywhere but the demo, where it is twenty-five
 * people's and a column of "your machine" would be false on every row.
 */
export function locationOf(agent, harness = null, whose = null) {
  const via = harness ? { id: harness.id, name: harness.name, kind: harness.kind } : null;
  const machine = whose ?? "your machine";
  return {
    kind: "laptop",
    label: via ? `${machine} · ${via.name}` : machine,
    repoId: null,
    repoName: null,
    sandboxId: null,
    sandboxName: null,
    harness: via,
  };
}

/** A month's standing, as a row carries it - or null for one with no session in the month. */
// Where an executor stands this month, on its row of the list: the
// ranking's row (performance.js `rank`, over 30 days) less what the list
// does not show. The list carried only finished-of-taken, and a row that
// said "3 of 4" beside one that said "3 of 4" read as the same executor
// when one took forty steering lines and $60 a task and the other took
// two lines and $4 - so what a task cost, in lines and money, and how
// many sessions it took, ride along. The Stats tab has the rest.
export const standingOf = (row) =>
  row
    ? (({ score, sessions, live, tasks, finished, unfinished, rate, effective, lines, linesPerTask, cost, costPerTask }) => ({
        score, sessions, live, tasks, finished, unfinished, rate, effective, lines, linesPerTask, cost, costPerTask, range: "30d",
      }))(row)
    : null;

/**
 * Everything that does work for this person, on one list: the agents this
 * app made or invited, the harnesses on their own machines reporting here,
 * and the vendors' agents - each with where it runs, who invited it, what
 * it has been doing and where it stands this month.
 *
 * Each row carries what it has been doing, because the console asks both
 * questions at once and two round trips to draw one list is two round
 * trips. The rows that come from records are the scope's - it never reads
 * across accounts either.
 *
 * A laptop harness that reports *for* an agent is not a row: it is how that
 * agent's own steps reach here (harnesses.js), so it is the agent's
 * location. Only one reporting for nobody stands alone - and beside those,
 * the setups nobody declared at all (`discoveredSetups`), which is how
 * anything gets onto this list now.
 */
/** How far back the Executors page looks for a setup that has gone quiet. */
const SETUP_MEMORY_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The executors nobody declared: one row per machine that has reported.
 *
 * Every other row on this page exists because somebody made a record - an
 * agent they invited, a vendor they connected. A setup has no record and
 * cannot have one: this app does not start it, does not know it is coming,
 * and finds out it exists only when its first session arrives. So the rows
 * are built from the sessions themselves, grouped by the machine the start
 * hook named (setup-script.js, the `report` script).
 *
 * One row per machine rather than one per token, because the token is the
 * account's and the machine is the thing a person recognises: "my laptop"
 * and "the sandbox that ran last night" are two executors, and they are two
 * rows here even though they report on the same secret.
 */
async function discoveredSetups(user, whose = null) {
  const since = Date.now() - SETUP_MEMORY_MS;
  const [sessions, setUp, records] = await Promise.all([
    sessionLog.list({ owner: user, since, limit: 1000 }),
    ingestToken.setupsOf(user).catch(() => []),
    pulls.list({ since, limit: 1000 }).catch(() => []),
  ]);
  // Where each machine stands this month, out of the very sessions the rows
  // are built from - so a row and its standing are one read of one set of
  // work and cannot disagree. `machines` keys a session by the machine its
  // hook named, which is how a row is keyed here (performance.js `keyOf`).
  const ranked = new Map(performance.rank(sessions, records, { by: "machines", range: "30d", tasks: allTasks(repos) }).rows.map((row) => [row.key, row]));
  const byMachine = new Map();
  // A row is made the same way whether the first thing heard from a machine
  // was its setup report or its first session; the setup report just comes
  // first, and says what runs there.
  const rowFor = (machine) =>
    byMachine.get(machine.id) ?? {
      id: `setup:${machine.id}`,
      kind: "setup",
      name: machine.name,
      machine,
      // The platform, not the machine: the machine's name is already the
      // row's name, and a Location column that repeats it says nothing.
      location: {
        kind: machine.host === "laptop" ? "laptop" : "sandbox",
        label: machine.host === "laptop" ? whose ?? "your machine" : machine.host,
        repoId: null, repoName: null, sandboxId: null, sandboxName: null, harness: null,
      },
      // Nobody let it in: it reported, on a token this account holds. That
      // is a different answer to "who invited this" and it should read as one.
      invitedBy: { by: null, at: null },
      createdAt: null,
      sessions: 0,
      live: false,
      lastAt: null,
      repos: [],
      filesTouched: 0,
      tasks: [],
      calls: [],
      permissions: [],
      performance: null,
      // What the setup script said, when it ran here: when, which
      // harnesses it found, what OS. Null for a machine that only ever
      // reported through its hooks - an old settings file.
      setUp: null,
    };
  for (const entry of setUp) {
    if (Date.parse(entry.at) < since) continue;
    const row = rowFor(entry.machine);
    row.setUp = { at: entry.at, harnesses: entry.harnesses ?? [], os: entry.os ?? null };
    if (!row.createdAt) row.createdAt = entry.firstAt ?? entry.at;
    byMachine.set(entry.machine.id, row);
  }
  // Where there is a cap on how many machines may be seated, the account's
  // registry is the list. A machine forgotten to free a place must not come
  // straight back as a row built from the sessions that ran on it
  // (ingest-token.js `forgetSetup`): the seat would be free and the row
  // still there, which is two answers to "how many machines is this" - the
  // very thing the registry exists to stop being true.
  //
  // Where there is no cap - the hosted product, where `MAX_EXECUTORS` is
  // Infinity - nothing is ever forgotten, so the two agree, and the
  // sessions are left to speak for themselves. They have to: a machine that
  // was reporting before there was a map is in none, and the row assembled
  // from its work is the only one it has.
  const seated = new Set(setUp.map((entry) => entry.machine?.id));
  const seatedOnly = Number.isFinite(MAX_EXECUTORS);
  for (const record of sessions) {
    if (record.harness?.id !== ingestToken.HARNESS_ID) continue;
    if (seatedOnly && !seated.has(record.machine?.id)) continue;
    // A session that never named a machine is not an executor. The name
    // comes from the start hook, which is one best-effort curl capped at
    // five seconds; when that is lost the export still arrives and there is
    // nothing left to say whose machine it was. A row for those is a row
    // nobody can recognise - one heading collecting a flaky request from
    // every machine on the account - so the session is skipped here. It is
    // not lost: it is still on the Activity page, and the next session from
    // that machine whose hook does land is a row of its own.
    if (!record.machine) continue;
    const row = rowFor(record.machine);
    row.sessions += 1;
    row.live = row.live || record.state === "live";
    row.lastAt = Math.max(row.lastAt ?? 0, record.lastSeenAt ?? record.startedAt ?? 0);
    row.filesTouched += record.filesTouched ?? 0;
    if (!row.createdAt || record.startedAt < Date.parse(row.createdAt)) row.createdAt = new Date(record.startedAt).toISOString();
    // Which repositories the work was in - the setup's answer to "where does
    // this one work", which for a laptop is wherever its owner cd'd to.
    const repo = record.repo?.fullName ?? null;
    if (repo && !row.repos.some((entry) => entry.name === repo)) row.repos.push({ id: null, name: repo });
    byMachine.set(record.machine.id, row);
  }
  for (const row of byMachine.values()) row.performance = standingOf(ranked.get(row.id));
  return [...byMachine.values()].sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
}

async function executorsFor(scope, user, workspace = null, { whose = null, everyTask = allTasks(repos), links: shared = null } = {}) {
  const owned = repos.agentsOwnedBy(user);
  // Every task on the installation, because a subtask can live in a different
  // repo to its parent and the roll-up has to find it. Taken as an argument
  // so the room's list (`executorsForRoom`) scans once rather than once per
  // person: the demo has twenty-five of them, and this was twenty-five walks
  // of every repo's tasks to build one page.
  // The joins for every task these agents are party to, read once - the
  // agent page shows the same cards as the Tasks tab.
  //
  // The ranking is handed to the vendors' rows as the promise it is, rather
  // than awaited first: `rankingBy` caches for a minute and hands the same
  // promise back, so both halves of the list read one ranking and neither
  // waits for the other.
  const ranking = rankingBy("agents");
  const [links, ranked, rankedHarness, theirHarnesses, externalRows] = await Promise.all([
    shared ?? scope.linksFor(scope.tasksOf(everyTask, owned)),
    ranking,
    rankingBy("harnesses"),
    scope.harnessRows(user),
    // Their vendors' agents on the same list with the same ranking: a
    // Greptile that reviewed the month's pull requests is ranked by what
    // became of them, beside the agent that opened them.
    scope.externalRows(user, { ranked: ranking }),
  ]);
  const described = theirHarnesses.map(harnesses.describeHarness);
  const reporting = new Map(described.filter((entry) => entry.where === "laptop" && entry.agent?.id).map((entry) => [entry.agent.id, entry]));

  const agentRows = await scope.agentRows(user, { owned, everyTask, links, whose, ranked, reporting });

  const harnessRows = described
    .filter((entry) => entry.where === "laptop" && !entry.agent?.id && !entry.builtIn && !entry.implied)
    .map((entry) => ({
      id: entry.id,
      kind: "harness",
      name: entry.name,
      harnessKind: entry.kind,
      harnessLabel: entry.kindLabel,
      telemetry: entry.telemetry,
      location: { kind: "laptop", label: whose ?? "your machine", repoId: null, repoName: null, sandboxId: null, sandboxName: null, harness: { id: entry.id, name: entry.name, kind: entry.kind } },
      invitedBy: { by: user, at: entry.createdAt ?? null },
      createdAt: entry.createdAt ?? null,
      lastSeenAt: entry.lastSeenAt ?? null,
      lastAt: entry.lastSeenAt ? Date.parse(entry.lastSeenAt) : null,
      performance: standingOf(rankedHarness.get(entry.id)),
      live: Boolean(sessionLog.liveFor(entry.id)),
      tasks: [],
      calls: [],
      repos: [],
      permissions: [],
    }));

  const rows = [...agentRows, ...externalRows, ...harnessRows, ...(await discoveredSetups(user, whose))];
  return {
    executors: rows,
    // The old name for the same list, until every reader says executors.
    agents: rows,
    // What money would be shown, if anything. With no rates configured the
    // console reports token counts and no currency - see costs.js on why
    // nothing invents a rate.
    priced: anyPriced(),
    // Every repo this person owns in the open workspace, so the console can
    // offer to let an agent into one it is not in yet without a second
    // round trip - and not one from another workspace, which the page does
    // not show and the person did not have in mind.
    repos: [...repos.repos.values()]
      .filter((repo) => repo.owner === user && repos.inWorkspace(repo, workspace))
      .map((repo) => ({ id: repo.id, name: repo.name })),
  };
}

/**
 * The list for a room rather than a person: every executor of everybody in
 * it, on one list, each row saying whose machine it runs on.
 *
 * Only the demo reads this way (`readersOf`), and only because the demo
 * belongs to nobody: a page of Connect your setup is what a visitor got
 * where a month of a team's setup should have been. A workspace with real
 * people in it still answers one person's - somebody else's laptop and
 * what they have let their agents do is theirs to show, not the room's.
 */
async function executorsForRoom(scope, users, workspace) {
  // Read once for the whole room, not once per person in it - `linksFor` is
  // a read of the pull requests and sessions behind a set of tasks, and the
  // demo has eight people who own an agent, so this page did that same read
  // eight times over the same month of work. Everything it returns is keyed
  // by task id (`taskForBrowser`), so one call over the room's tasks answers
  // every person's lookups.
  const everyTask = allTasks(repos);
  const links = await scope.linksFor(scope.tasksOf(everyTask, users.flatMap((user) => repos.agentsOwnedBy(user))));
  const parts = await Promise.all(
    users.map((user) => executorsFor(scope, user, workspace, { whose: `${user.split("@")[0]}'s machine`, everyTask, links })),
  );
  const rows = parts.flatMap((part) => part.executors);
  return {
    executors: rows,
    agents: rows,
    priced: anyPriced(),
    // Nowhere to let one in. The repos here are the made-up people's and
    // no account holds a grant on any of them, so the picker that offers
    // to add an agent to one of your repos has nothing to offer.
    repos: [],
  };
}

/** One executor of this person's, whatever kind, or null: what the stats and access routes start from. */
async function executorOf(scope, user, id) {
  const found = repos.findAgent(id, user);
  if (found) return { kind: "invited", agent: found.agent, repo: found.repo };
  const harness = await harnesses.findFor(user, id).catch(() => null);
  if (harness) return { kind: "harness", harness };
  const external = await scope.externalOf(user, id).catch(() => null);
  if (external) return { kind: "external", external };
  return null;
}

/**
 * The same, over everybody a page may read - which is the caller alone
 * everywhere but the demo, where it is the made-up people (`readersOf`).
 * A row on the list has to open, and in the demo none of them is the
 * caller's.
 */
async function executorForReader(scope, req, id) {
  for (const user of scope.readersOf(req)) {
    const found = await executorOf(scope, user, id);
    if (found) return found;
  }
  return null;
}

export function mount(app, scope) {
  const { wrap, requireViewer, requireUser } = scope;

  const executorsAnswer = (req) =>
    scope.demoOpen(req)
      ? executorsForRoom(scope, scope.readersOf(req), scope.scopeOf(req))
      : executorsFor(scope, req.cv.user, scope.scopeOf(req));

  app.get("/api/executors", requireViewer, wrap(async (req, res) => {
    res.json(await executorsAnswer(req));
  }));

  /** The list under its old name - the same body, so a reader made before the rename keeps working. */
  app.get("/api/agents", requireViewer, wrap(async (req, res) => {
    res.json(await executorsAnswer(req));
  }));

  /**
   * One executor's numbers: where it stands over the range (the same row the
   * Performance page would show), its days one by one, and what it reached
   * for - the tools, connectors, skills and models in the spans this process
   * still holds for it. `used.sample` says how many calls that is, because a
   * ring of spans is not a month, and the page says "of the last N".
   */
  app.get("/api/executors/:id/stats", requireViewer, wrap(async (req, res) => {
    const id = String(req.params.id);
    const found = await executorForReader(scope, req, id);
    if (!found) return res.status(404).json({ error: "No executor of yours has that id." });
    const range = performance.RANGES[String(req.query.range ?? "")] ? String(req.query.range) : performance.DEFAULT_RANGE;
    const by = found.kind === "harness" ? "harnesses" : "agents";
    const since = Date.now() - performance.RANGES[range];
    const [sessions, records] = await Promise.all([
      scope.sessionsInScope(req, { since, limit: 1000 }),
      scope.pullsInScope(req, { since: since - performance.RANGES["30d"], limit: 1000 }),
    ]);
    const ranked = performance.rank(sessions, records, { by, range, tasks: allTasks(repos) });
    const seen = spans.forAgent(id);
    res.json({
      id,
      kind: found.kind,
      range,
      since,
      aggregate: ranked.rows.find((row) => row.key === id) ?? null,
      series: performance.series(sessions, records, { key: id, by, range, tasks: allTasks(repos) }).days,
      used: { ...foldUsage(seen), sample: seen.length },
      priced: anyPriced(),
    });
  }));

  /**
   * What an agent may do, and where: the one grant, and the repos it is a
   * member of. The grant is the record's, so it takes effect everywhere the
   * agent works on its next call; the memberships are added and removed a
   * repo at a time, which is what keeps "where a token reaches" explicit.
   */
  app.put("/api/executors/:id/access", requireUser, wrap(async (req, res) => {
    const id = String(req.params.id);
    const found = repos.findAgent(id, req.cv.user);
    if (!found) return res.status(404).json({ error: "No agent of yours has that id." });
    const mine = [...repos.repos.values()].filter((repo) => repo.owner === req.cv.user);

    if (req.body?.permissions || Array.isArray(req.body?.askFirst)) {
      const anywhere = found.repo ?? mine.find((repo) => repos.hasAgent(repo, id));
      if (!anywhere) return res.status(400).json({ error: "Let it into a repo first; the grant is edited from one it works in." });
      // The grant, and which of it the owner approves call by call
      // (action-approvals.js) - each only when sent, so a change to one
      // never resends the other.
      await repos.updateAgent(anywhere.id, id, {
        permissions: req.body.permissions,
        askFirst: Array.isArray(req.body.askFirst) ? req.body.askFirst : undefined,
      }, req.cv.user);
    }

    if (Array.isArray(req.body?.repos)) {
      const wanted = new Set(req.body.repos.map(String));
      for (const repo of mine) {
        const inRepo = repos.hasAgent(repo, id);
        if (wanted.has(repo.id) && !inRepo) await repos.grantAgent(repo.id, id, null, req.cv.user);
        if (!wanted.has(repo.id) && inRepo) {
          await repos.removeAgent(repo.id, id, req.cv.user);
          await scope.agentGone(repo.id, id).catch(() => {});
        }
      }
    }

    const rows = (await executorsFor(scope, req.cv.user)).executors;
    res.json({ executor: rows.find((row) => row.id === id) ?? null });
  }));
}
