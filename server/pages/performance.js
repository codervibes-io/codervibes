// The Performance page: what the work came to, and what it cost.
//
// The ranking and the comparison (performance.js), how far each person has
// taken this (adoption.js), whether a CLAUDE.md change helped
// (harness-changes.js), what got in the way (friction.js), and the same
// figures as a file (export.js). Nothing here computes a figure - the
// modules beside it do that - and everything here decides which sessions and
// which pull requests those figures are computed over, which is the scope's
// answer (server/scope.js), so the page can be mounted for a workspace or
// for one person's own machine without knowing which it is.
import * as performance from "../performance.js";
import * as harnessChanges from "../harness-changes.js";
import * as adoption from "../adoption.js";
import * as exportFile from "../export.js";
import * as friction from "../friction.js";
import * as sessionEvents from "../session-events.js";
import * as harnesses from "../harnesses.js";
import * as telemetry from "../telemetry.js";
import * as pullCost from "../pull-cost.js";
import { repos } from "../repos.js";
import { allTasks } from "../agent-tasks.js";
import { anyPriced } from "../costs.js";

/**
 * How far back of *extra* history the adoption figures read.
 *
 * Only `parallel` needs it: concurrency is a fact about a moment, so a
 * session begun before the range and still running inside it is running
 * inside it (adoption.js `contributor`). Every count still reads sessions
 * that *started* in the range, so widening the window changes no other
 * figure and leaves `rank` - which does its own filtering - untouched. A
 * day is enough: a session goes idle after fifteen minutes of silence.
 */
const ADOPTION_LOOKBACK = performance.RANGES["24h"];

/**
 * How many logs are read to put words to the commands a report names. A
 * page shows five repeats a group; the words behind them are nearly always
 * in the first session or two, and a reader who may not read any of them
 * gets the rows without words rather than a slow page.
 */
const MAX_COMMAND_LOOKUPS = 12;

/**
 * Every harness change on the repos of the open workspace, flat.
 *
 * The same repos the Harness changes panel reads (`/api/performance/harness`),
 * so "Priya tuned the harness" on the ladder and the card that measures what
 * her commit did are the same commit. A change on a repository this reader
 * cannot see is not evidence about anybody here.
 */
const harnessChangesInScope = (scope, req) =>
  [...repos.repos.values()]
    .filter((repo) => repos.inWorkspace(repo, scope.scopeOf(req)) && repos.canAccess(repo, req.cv.user))
    .flatMap((repo) => repo.harnessChanges ?? []);

/**
 * Who the adoption figures are about: the people who worked in this
 * workspace in this range, not the workspace's roster.
 *
 * Somebody on the roster who did nothing in the range is not a rung-one
 * adopter - they are not in the range at all - and putting them in would
 * move `adoptersShare` every time the team hired, which is the one thing a
 * figure called adoption must not do. A person is here if a session of
 * theirs started in the range or a pull request that merged in it was
 * theirs (adoption.js `ownerOfPull`).
 */
function adoptionOf({ sessions, records, identityRows, changes, range, now }) {
  const since = now - performance.RANGES[range];
  const logins = adoption.loginsOf(identityRows);
  const owners = adoption.sessionOwners(sessions);
  const people = new Set();
  for (const session of sessions) {
    if (session.owner && (session.startedAt ?? 0) >= since) people.add(session.owner);
  }
  for (const pull of records) {
    const at = adoption.mergedAt(pull);
    if (at == null || at < since || at > now) continue;
    const owner = adoption.ownerOfPull(pull, logins, owners);
    if (owner) people.add(owner);
  }
  const rows = [...people].map((owner) => {
    const row = adoption.contributor(owner, { sessions, pulls: records, identities: identityRows, range, now });
    // What somebody connected is theirs to know (the Connectors page shows
    // a person only their own), and the level's reason already says
    // whatever of it mattered - so the row that leaves here does not carry
    // the list, nor the GitHub login it was matched by.
    const { connectors, logins: matched, ...rest } = row;
    return {
      ...rest,
      level: adoption.levelOf(row, { harnessChanges: changes }),
      next: adoption.nextOf(row, { harnessChanges: changes }),
    };
  });
  rows.sort((a, b) => b.level.level - a.level.level || (b.pulls.share ?? -1) - (a.pulls.share ?? -1) || b.sessions - a.sessions || a.owner.localeCompare(b.owner));
  return { rows, team: adoption.team(rows), trend: adoption.trendOf(sessions, records, { now }) };
}

/**
 * How many times a permission said no to each session in the range, from
 * the access trail (access-trail.js). It is the repository's record and
 * not the session's, so every reader of the figure joins it here rather
 * than each working out its own idea of a refusal.
 */
function refusalsBySession(scope, req, since) {
  const own = new Map();
  for (const entry of scope.trailInScope(req, since).entries) {
    if (!entry.sessionId || !friction.REFUSED_STATES.has(entry.state)) continue;
    own.set(entry.sessionId, (own.get(entry.sessionId) ?? 0) + 1);
  }
  return own;
}

/**
 * Put the words back on a report's repeated commands, for a reader
 * entitled to them.
 *
 * The record keeps a command's fingerprint and not the command
 * (friction.js `fingerprint`): it is everyone's to read and a command line
 * is a tool's input. The words live on the session's log, which is
 * published under the words rule - the owner and the people on its repo -
 * so they are looked up here, in the logs of the sessions the report
 * named, and only in the ones this reader may read. A row nobody can put
 * words to keeps its count and says "a command" (console-friction.js).
 */
async function nameCommands(scope, folds, { sessions, user }) {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const rowsOf = (fold) => [...fold.groups, fold.totals];
  const wanted = new Set();
  const order = [];
  for (const fold of Object.values(folds)) {
    for (const group of rowsOf(fold)) {
      for (const repeat of group.repeats) {
        wanted.add(repeat.hash);
        for (const id of repeat.examples ?? []) if (!order.includes(id)) order.push(id);
      }
    }
  }
  if (!wanted.size) return;
  const words = new Map();
  let reads = 0;
  for (const id of order) {
    if (reads >= MAX_COMMAND_LOOKUPS || words.size === wanted.size) break;
    const session = byId.get(id);
    if (!session || !scope.mayReadWords(session, user)) continue;
    reads += 1;
    for (const entry of await sessionEvents.since(id, 0, { limit: 500 })) {
      if (entry.kind !== "tool_call" || !entry.title) continue;
      const hash = friction.commandHash(entry.title);
      if (wanted.has(hash) && !words.has(hash)) words.set(hash, friction.normaliseCommand(entry.title));
    }
  }
  for (const fold of Object.values(folds)) {
    for (const group of rowsOf(fold)) {
      for (const repeat of group.repeats) repeat.title = words.get(repeat.hash) ?? null;
    }
  }
}

/**
 * The same figures, as a file - see server/export.js for the schema and why
 * it holds columns nothing fills yet.
 *
 * Signed in rather than merely looking (`requireUser`): reading a page is
 * one thing and walking away with the workspace's month of work as a file
 * is another, and a visitor in the demo has no business doing the second.
 * The scope and the range are the Performance page's, read the same way -
 * so what comes out is what the reader was looking at, including whatever
 * the Include filter is set to.
 *
 * A range this installation does not offer is refused rather than quietly
 * turned into the default, as it is on the pages: a page that shows a week
 * when a month was asked for is a page whose heading says so, and a *file*
 * that does it is a file whose name says "30d" over seven days of rows.
 */
async function exportRows(scope, req, what) {
  const range = String(req.query.range ?? performance.DEFAULT_RANGE);
  if (!performance.RANGES[range]) return { error: `No such range: ${range}` };
  const since = Date.now() - performance.RANGES[range];
  const [sessions, records] = await Promise.all([
    scope.sessionsInScope(req, { since, limit: 1000 }),
    scope.pullsInScope(req, { since: since - performance.RANGES["30d"], limit: 1000 }),
  ]);
  if (what === "pulls") return { range, columns: exportFile.PULL_COLUMNS, rows: exportFile.pullRows(records, sessions) };
  const names = await scope.namesOf(sessions.map((session) => session.owner));
  return {
    range,
    columns: exportFile.SESSION_COLUMNS,
    rows: exportFile.sessionRows(sessions, records, allTasks(repos), {
      names,
      mayRead: (session) => scope.mayReadWords(session, req.cv.user),
      // The one friction figure that is not on the session record.
      refusals: refusalsBySession(scope, req, since),
    }),
  };
}

export function mount(app, scope) {
  const { wrap, requireViewer, requireUser } = scope;

  /** The ranking - see performance.js for what the columns mean and why there is no one number. */
  app.get("/api/performance", requireViewer, wrap(async (req, res) => {
    const range = performance.RANGES[String(req.query.range ?? "")] ? String(req.query.range) : performance.DEFAULT_RANGE;
    const by = performance.BY.includes(String(req.query.by)) ? String(req.query.by) : "agents";
    const now = Date.now();
    const since = now - performance.RANGES[range];
    // The people ranking joins the adoption figures on, so it reads the extra
    // day `parallel` needs. `rank` filters by `startedAt` itself, so the wider
    // window costs it nothing.
    const [sessions, records] = await Promise.all([
      scope.sessionsInScope(req, { since: by === "users" ? since - ADOPTION_LOOKBACK : since, limit: 1000 }),
      scope.pullsInScope(req, { since: since - performance.RANGES["30d"], limit: 1000 }),
    ]);
    const ranked = performance.rank(sessions, records, { by, range, tasks: allTasks(repos) });
    if (by === "users") {
      const names = await scope.namesOf(ranked.rows.map((row) => row.key));
      for (const row of ranked.rows) row.name = names.get(row.key) ?? row.name;
      // Three columns of "how this person works", joined on the owner the
      // ranking already keys its rows by. Same range, same scope, same
      // sessions - the two halves of the row cannot disagree because they are
      // read off one load. A row with no adoption row against it (an owner
      // whose sessions are all outside the range's start) keeps nulls, which
      // the page draws as a dash rather than as a zero.
      const adopting = adoptionOf({
        sessions,
        records,
        identityRows: await scope.identities(),
        changes: harnessChangesInScope(scope, req),
        range,
        now,
      });
      const byOwner = new Map(adopting.rows.map((row) => [row.owner, row]));
      for (const row of ranked.rows) {
        const own = byOwner.get(row.key);
        row.share = own?.pulls.share ?? null;
        row.merged = own?.pulls.merged ?? 0;
        row.withAgent = own?.pulls.withAgent ?? 0;
        row.parallel = own?.parallel ?? null;
        row.level = own?.level ?? null;
      }
    }
    if (by === "sessions") {
      // A session row is named after its first ask under the words rule
      // (describeSession) - a viewer who may not read it sees who was working
      // - and says what kind of harness it ran in by that kind's label, so
      // the page's filter chips read "Claude Code", not an id.
      const byId = new Map(sessions.map((session) => [session.id, session]));
      for (const row of ranked.rows) {
        const session = byId.get(row.key);
        row.title = session && scope.mayReadWords(session, req.cv.user) ? session.title ?? null : null;
        row.harness.kindLabel = harnesses.KINDS[row.harness.kind]?.label ?? row.harness.kind;
      }
    }
    res.json({ ...ranked, priced: anyPriced(), telemetry: telemetry.describe() });
  }));

  /**
   * The comparison - the same five figures for every option a person can
   * choose between (performance.js `compare`): by model vendor, harness,
   * where it ran, and whose it was. All four dimensions in one answer, so
   * switching between them on the page is not another request. The user
   * rows are named the way the ranking's are.
   */
  app.get("/api/performance/compare", requireViewer, wrap(async (req, res) => {
    const range = performance.RANGES[String(req.query.range ?? "")] ? String(req.query.range) : performance.DEFAULT_RANGE;
    const since = Date.now() - performance.RANGES[range];
    const [sessions, records] = await Promise.all([
      scope.sessionsInScope(req, { since, limit: 1000 }),
      scope.pullsInScope(req, { since: since - performance.RANGES["30d"], limit: 1000 }),
    ]);
    const compared = performance.compareAll(sessions, records, {
      range,
      tasks: allTasks(repos),
      harnessLabel: (kind) => harnesses.KINDS[kind]?.label ?? kind,
    });
    const names = await scope.namesOf(compared.dimensions.user.map((row) => row.key));
    for (const row of compared.dimensions.user) row.name = names.get(row.key) ?? row.name;
    // And the same range as a line - spend, tokens, tasks done, sessions per
    // period (performance.js trend) - from the same read, so switching the
    // metric on the page is not another request.
    res.json({
      ...compared,
      trend: performance.trend(sessions, records, { range, tasks: allTasks(repos), harnessLabel: (kind) => harnesses.KINDS[kind]?.label ?? kind }),
      // ---- pull-cost ----
      // And what a change costs here: the median merged pull request, what
      // each kind of work costs, and which phase of a pull request's life the
      // money goes in (pull-cost.js). Read off the costs already on the
      // records, so this adds no fetch to the route. `yieldOf` is handed in
      // so that "never landed" means the same thing here as in the yield
      // panel above it on the page.
      cost: pullCost.summaryOf(records, sessions, {
        yieldOf: performance.yieldOf,
        tasks: allTasks(repos),
        since,
      }),
      // ---- end pull-cost ----
      priced: anyPriced(),
    });
  }));

  /**
   * Did the CLAUDE.md change help? One card's worth per harness change in the
   * range: what the commit touched, and the fortnight before it beside the
   * fortnight after (harness-changes.js `beforeAfter`).
   *
   * Sessions are read from a fortnight before the range as well as inside it,
   * because a change on the range's first day needs the fortnight before that
   * day to have anything to compare against.
   *
   * Beside each change, the same window split by person and by model
   * provider. That is the confound, drawn rather than argued with: a cost
   * that halved the week a rule landed may be the rule or may be the work
   * moving to a cheaper model, and the reader can see which without leaving
   * the panel. The pair is only computed for a change worth reading - an
   * unsettled one gets its counts and nothing else.
   */
  app.get("/api/performance/harness", requireViewer, wrap(async (req, res) => {
    const range = performance.RANGES[String(req.query.range ?? "")] ? String(req.query.range) : performance.DEFAULT_RANGE;
    const now = Date.now();
    const since = now - performance.RANGES[range];
    const [sessions, records] = await Promise.all([
      scope.sessionsInScope(req, { since: since - harnessChanges.WINDOW, limit: 1000 }),
      scope.pullsInScope(req, { since: since - harnessChanges.WINDOW - performance.RANGES["30d"], limit: 1000 }),
    ]);
    const tasks = allTasks(repos);
    const harnessLabel = (kind) => harnesses.KINDS[kind]?.label ?? kind;
    const mine = [...repos.repos.values()].filter((repo) => repos.inWorkspace(repo, scope.scopeOf(req)) && repos.canAccess(repo, req.cv.user));

    const cards = [];
    for (const repo of mine) {
      for (const change of repo.harnessChanges ?? []) {
        if ((change.at ?? 0) < since) continue;
        const measured = harnessChanges.beforeAfter(sessions, records, tasks, { ...change, repoId: repo.id }, { now, harnessLabel });
        cards.push({
          ...measured,
          change: {
            ...measured.change,
            message: change.message ?? null,
            repoId: repo.id,
            repoName: repo.name ?? null,
            repository: repo.source?.repo ?? null,
            url: change.sha && repo.source?.repo ? `https://github.com/${repo.source.repo}/commit/${change.sha}` : null,
          },
          // What else was different about those two fortnights.
          beside: measured.settled ? harnessChanges.besideIt(sessions, records, tasks, measured.windows, { repoId: repo.id, harnessLabel }) : null,
        });
      }
    }
    cards.sort((a, b) => (b.change?.at ?? 0) - (a.change?.at ?? 0));
    res.json({ range, since, window: harnessChanges.WINDOW, minSessions: harnessChanges.MIN_SESSIONS, changes: cards.slice(0, 50), priced: anyPriced() });
  }));

  /**
   * How far each person has taken this - see server/adoption.js for what the
   * share is divided by and why the level is a heuristic shown with its
   * reason.
   *
   * The Performance page's scope and range, read the same way, so the panel
   * stands on the sessions the rest of the page stands on. The trend is
   * always eight weeks whatever the range: it is the line the range is a
   * point on, and a "last 24 hours" version of it would be one bar.
   */
  app.get("/api/performance/adoption", requireViewer, wrap(async (req, res) => {
    const range = performance.RANGES[String(req.query.range ?? "")] ? String(req.query.range) : performance.DEFAULT_RANGE;
    const now = Date.now();
    const since = now - performance.RANGES[range];
    const [sessions, records] = await Promise.all([
      // Eight weeks of sessions, because the trend draws eight weeks of
      // people; the rows read the range out of the same load, and
      // `contributor` does its own filtering, so nothing is double-counted.
      scope.sessionsInScope(req, { since: Math.min(since - ADOPTION_LOOKBACK, now - 8 * 7 * 24 * 60 * 60 * 1000), limit: 2000 }),
      scope.pullsInScope(req, { since: now - 9 * 7 * 24 * 60 * 60 * 1000, limit: 2000 }),
    ]);
    const adopting = adoptionOf({
      sessions,
      records,
      identityRows: await scope.identities(),
      changes: harnessChangesInScope(scope, req),
      range,
      now,
    });
    const names = await scope.namesOf(adopting.rows.map((row) => row.owner));
    for (const row of adopting.rows) row.name = names.get(row.owner) ?? row.owner;
    res.json({
      range,
      since,
      levels: adoption.LEVELS,
      parallelDays: adoption.PARALLEL_DAYS,
      // Whose row is the reader's own, so the Account page and the panel can
      // find it without matching on an address in the browser.
      me: req.cv.user ?? null,
      ...adopting,
    });
  }));

  /** One file: the rows for `what`, written as `format`, named after both. */
  const exportRoute = (what, format) =>
    wrap(async (req, res) => {
      const { error, range, columns, rows } = await exportRows(scope, req, what);
      if (error) return res.status(400).json({ error });
      const name = exportFile.filenameFor(what, range, format);
      res.type(format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
      // One write: the range is capped at a thousand rows above, which is a
      // file of a few hundred kilobytes - streaming it would be machinery
      // around something that fits in a buffer.
      res.send(format === "csv" ? exportFile.toCsv(rows, columns) : exportFile.toJson(rows, columns, { range, generatedAt: new Date().toISOString() }));
    });

  app.get("/api/export/sessions.csv", requireUser, exportRoute("sessions", "csv"));
  app.get("/api/export/sessions.json", requireUser, exportRoute("sessions", "json"));
  app.get("/api/export/pulls.csv", requireUser, exportRoute("pulls", "csv"));
  app.get("/api/export/pulls.json", requireUser, exportRoute("pulls", "json"));

  /**
   * The friction report: what got in the agents' way over the range, folded
   * per repository, per executor and per ISO week (friction.js).
   *
   * All three foldings come back from one read, the way the comparison
   * hands back all four of its dimensions - the switch on the panel is a
   * different view of the same counts, and making it a request would put a
   * spinner between a person and a question they are asking three times in
   * a row. `by` says which fold the page opens on and nothing else.
   *
   * The errors, the hand-backs and the repeats are counts already on the
   * session records (sessions.js `counts.friction`, written at ingest); the
   * refusals are the access trail's, joined here by session, since a
   * permission saying no is the repo's record and not the session's.
   */
  app.get("/api/performance/friction", requireViewer, wrap(async (req, res) => {
    const range = performance.RANGES[String(req.query.range ?? "")] ? String(req.query.range) : performance.DEFAULT_RANGE;
    const by = friction.BY.includes(String(req.query.by)) ? String(req.query.by) : "repo";
    const since = Date.now() - performance.RANGES[range];
    const sessions = await scope.sessionsInScope(req, { since, limit: 1000 });
    const refusals = refusalsBySession(scope, req, since);
    const rows = sessions.map((session) => ({
      sessionId: session.id,
      repoId: session.repoId ?? null,
      repoName: session.repoId ? repos.repos.get(session.repoId)?.name ?? null : session.repo?.fullName ?? null,
      actorId: session.actor?.id ?? null,
      actorName: session.actor?.name ?? null,
      startedAt: session.startedAt ?? 0,
      friction: { ...friction.frictionOf(session), refusals: refusals.get(session.id) ?? 0 },
    }));
    const folds = {};
    for (const fold of friction.BY) folds[fold] = friction.report(rows, { since, by: fold });
    await nameCommands(scope, folds, { sessions, user: req.cv.user });
    res.json({ range, since, by, sessions: rows.length, folds, kinds: friction.vocabulary() });
  }));
}
