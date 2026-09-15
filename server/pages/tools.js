// The Tools page: what the agents reach for, and what came of it.
//
// The three tables and where their rows come from are tool-stats.js; this is
// the page over them - the range, the spans and closed tasks it folds, the
// sessions each row is attributed to, and whether a skill made any
// difference. Which spans and which sessions those are is the scope's
// (server/scope.js), so the page reads a workspace's work or one person's
// without a branch of its own.
import * as toolStats from "../tool-stats.js";
import * as harnessChanges from "../harness-changes.js";
import * as performance from "../performance.js";
import * as telemetry from "../telemetry.js";
import * as harnesses from "../harnesses.js";
import { repos } from "../repos.js";
import { allTasks, isLive } from "../agent-tasks.js";

/**
 * The tools, connectors and skills, across everybody - see tool-stats.js
 * for the three tables, the two sources and why both, and why the
 * harness's own tools are a line rather than rows. Everyone signed in reads
 * the same page: the rows are names and counts. What the page cannot do is
 * name a task - those are on the tool's own page, and only for repos the
 * viewer can open.
 */
function toolRange(req) {
  const range = toolStats.RANGES[String(req.query.range ?? "")] ? String(req.query.range) : toolStats.DEFAULT_RANGE;
  return { range, since: Date.now() - toolStats.RANGES[range] };
}

/** Every closed task on every repo of the open workspace, with its repo: the durable half of the fold. */
function closedTasks(scope, req) {
  const out = [];
  for (const repo of repos.repos.values()) {
    if (!repos.inWorkspace(repo, scope.scopeOf(req))) continue;
    for (const task of repo.tasks ?? []) if (task.used && !isLive(task.state)) out.push({ ...task, repoId: repo.id });
  }
  return out;
}

/**
 * The sessions a tool's row can be attributed to (tool-stats.js
 * `attribute`), by id: what each was for, who was working, and what came
 * of it. The words rule applies to the title as everywhere else - a viewer
 * who may not read a session's words sees who was working. Sessions are
 * read from a week before the range, since a span in the range can belong
 * to a session that started before it.
 */
async function sessionsForTools(scope, req, since) {
  const [sessions, records] = await Promise.all([
    scope.sessionsInScope(req, { since: since - toolStats.RANGES["7d"], limit: 1000 }),
    scope.pullsInScope(req, { since: since - performance.RANGES["30d"], limit: 1000 }),
  ]);
  return new Map(sessions.map((session) => [session.id, {
    id: session.id,
    title: scope.mayReadWords(session, req.cv.user) ? session.title ?? null : null,
    actor: { id: session.actor?.id ?? null, name: session.actor?.name ?? null },
    kind: session.kind,
    state: session.state,
    outcome: performance.outcomeOf(session, records),
    startedAt: session.startedAt ?? null,
    lastSeenAt: session.lastSeenAt ?? null,
    endedAt: session.endedAt ?? null,
    repoName: session.repoId ? repos.repos.get(session.repoId)?.name ?? null : null,
    // The repository, and whether it is one of this workspace's repos - a
    // tool's sessions are a listing like any other, and one of them in a
    // repository nobody connected here says so on its line.
    repository: session.repo?.fullName ?? null,
    where: session.where ?? null,
    cost: session.counts?.cost ?? 0,
  }]));
}

/**
 * What each skill did for the sessions that loaded it, against the
 * sessions of the same repositories that did not (harness-changes.js
 * `skillEffect`). One line on the row - "sessions using it finish first
 * time 71% vs 54%" - or nothing at all, which is what a skill three
 * sessions have touched deserves.
 *
 * The rows already carry the sessions that used them (`sessionIds`), so
 * nothing is looked up per skill: one read of the range's sessions, then
 * arithmetic. Two bounds on top of that, because each skill costs two
 * passes over the range's sessions: only rows with enough uses to reach a
 * verdict at all, and only the most-used `MAX_SKILL_EFFECTS` of those. The
 * rows arrive most-used first, and a skill two hundred rows down is not
 * worth a second of page load to nobody.
 */
const MAX_SKILL_EFFECTS = 20;

async function addSkillEffects(scope, req, rows, since) {
  const candidates = rows
    .filter((row) => (row.sessionIds ?? []).length >= harnessChanges.MIN_SESSIONS)
    .slice(0, MAX_SKILL_EFFECTS);
  if (!candidates.length) return;
  const [sessions, records] = await Promise.all([
    scope.sessionsInScope(req, { since, limit: 1000 }),
    scope.pullsInScope(req, { since: since - performance.RANGES["30d"], limit: 1000 }),
  ]);
  const tasks = allTasks(repos);
  const harnessLabel = (kind) => harnesses.KINDS[kind]?.label ?? kind;
  for (const row of candidates) {
    const effect = harnessChanges.skillEffect(sessions, [], row.name, {
      usedBy: row.sessionIds,
      pulls: records,
      tasks,
      harnessLabel,
      // The sessions are already the page's range; `window` says so rather
      // than letting the default range narrow them again.
      window: Date.now() - since,
    });
    row.effect = effect.settled ? { verdict: effect.verdict, counts: effect.counts, delta: effect.delta } : null;
  }
}

export function mount(app, scope) {
  const { wrap, requireViewer } = scope;

  app.get("/api/tools", requireViewer, wrap(async (req, res) => {
    const { range, since } = toolRange(req);
    const { spans: records, reach } = scope.spansInScope(req, since);
    const folded = toolStats.fold({ spans: records, tasks: closedTasks(scope, req), since });
    // Whether a skill made any difference: the sessions that loaded it
    // against the sessions of the same repositories that did not
    // (harness-changes.js `skillEffect`). Worked out before `attribute`,
    // which is what folds `sessionIds` away into counts.
    await addSkillEffects(scope, req, folded.skills.rows, since);
    // Each row with the sessions it was in the room for, and what those
    // came to - the page is for finding what has been getting work merged.
    const sessions = await sessionsForTools(scope, req, since);
    for (const table of ["tools", "connectors", "skills"]) folded[table].rows = toolStats.attribute(folded[table].rows, sessions);
    res.json({
      range,
      since,
      // How far back the spans go, which may be less than the range asked for.
      reach,
      ...folded,
      telemetry: telemetry.describe(),
    });
  }));

  app.get("/api/tools/:name", requireViewer, wrap(async (req, res) => {
    const { range, since } = toolRange(req);
    const name = String(req.params.name);
    const { spans: records, reach } = scope.spansInScope(req, since);
    const tasks = closedTasks(scope, req);
    const folded = toolStats.fold({ spans: records, tasks, since });
    const found = folded.tools.rows.find((entry) => entry.name === name);
    if (!found) return res.status(404).json({ error: `No tool called '${name}' has been used in the last ${range}` });
    const [row] = toolStats.attribute([found], await sessionsForTools(scope, req, since));
    // The tasks that used it: named for repos the viewer can open, counted for the rest.
    const using = toolStats.tasksUsing(tasks, name, { since });
    const readable = using.filter((task) => {
      const repo = repos.repos.get(task.repoId);
      return repo && repos.canAccess(repo, req.cv.user);
    });
    res.json({
      range,
      since,
      reach,
      tool: row,
      tasks: readable.map((task) => ({ ...task, repoName: repos.repos.get(task.repoId)?.name ?? null })),
      elsewhere: using.length - readable.length,
      telemetry: telemetry.describe(),
    });
  }));
}
