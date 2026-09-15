// Harness evals: did the CLAUDE.md change actually help?
//
// A repository's agents are configured by files in the repository itself.
// Somebody adds a rule to CLAUDE.md, writes a skill, tightens a hook, and
// the agents that work here behave differently from that commit on. The
// question nobody can answer today is whether the change was worth making:
// did the sessions after it finish more of what they started, first time,
// for less, with less steering - or did the extra thousand words of
// instruction just cost tokens and change nothing?
//
// This module is the arithmetic for that question. It is pure: sessions,
// pull requests, tasks and spans in, figures out. The wiring that finds the
// commits (push events on the default branch) and the page that draws them
// live elsewhere.
//
// ## Why a before/after on a time window, and not an A/B
//
// The honest experiment is a randomised one: half the sessions get the new
// CLAUDE.md, half do not, and the difference is the effect. There is no way
// to run that on a real repository. The file is in the repository; every
// agent that checks the repository out reads it. There is no control group,
// and building one - serving half the agents an older CLAUDE.md - would be
// lying to half the agents about what the repository says, which is a worse
// thing to do than not knowing.
//
// So this measures what can be measured: the fortnight before the commit
// and the fortnight after, side by side, each with the number of sessions
// it stands on. Both sides are always shown with their counts, and the
// counts are never rounded away, because "71% vs 54%" on four sessions each
// is not a finding and a reader who cannot see the four will treat it as
// one.
//
// ## What confounds it, and what is done about that
//
// A fortnight is not a controlled thing. Between the two windows the model
// may have changed (a new Sonnet, a switch to Opus for the hard work); a
// different person may have been working, on different work; a week of
// small chores may sit against a week of one large feature; the harness
// itself may have been upgraded. Any of those moves every figure here, and
// none of them is the CLAUDE.md.
//
// Two answers, both partial and both honest. The first is that the page
// shows the split by person and by model beside the before/after, from the
// same window - `compare`'s dimensions over the same sessions - so a reader
// who sees the cost halve can see in the next panel that the work moved
// from Opus to Sonnet that week, and draw their own conclusion. The second
// is that this module never says "because": `verdict` says what moved, in
// which direction, on how many sessions. It does not say what caused it.
//
// ## Why `settled` exists
//
// The after window is only full once a fortnight has passed. Until then the
// figures are real but they are figures for four days, and a delta computed
// from four days against fourteen is arithmetic on two different things. On
// top of that either side may simply be too thin: one session that happened
// to merge is a 100% closure rate.
//
// `settled` is false in both those cases, and a page must say "too early to
// tell" rather than draw a delta. A number shown once is believed; the cost
// of showing an unsettled delta is that somebody reverts a good CLAUDE.md
// change on the strength of two sessions.
import { compare, friction, steersOf, tasksWorked, RANGES, DEFAULT_RANGE } from "./performance.js";
import { autonomyOf } from "./sessions.js";

const DAY = 24 * 60 * 60 * 1000;

/** How far each side of a change is looked at, by default. */
export const WINDOW = 14 * DAY;

/** The fewest sessions a side may stand on before a delta is worth drawing. */
export const MIN_SESSIONS = 3;

/** How many changes a repository's list keeps. */
export const MAX_CHANGES = 100;

/** How many harness files one change lists. A commit that rewrites more than this is a move, not a rule. */
export const MAX_FILES = 50;

// ------------------------------------------------------- the files themselves

/**
 * The files that change how an agent behaves in a repository without
 * changing the product. That is the whole definition, and it is why this
 * list is what it is: editing one of these changes the next session's
 * behaviour and ships nothing to a user.
 *
 * Each rule says which harness reads it and why it counts:
 *
 *   `CLAUDE.md` anywhere            Claude Code's standing instructions -
 *                                   the root one and every nested one, since
 *                                   a directory's own CLAUDE.md governs the
 *                                   agent working in that directory.
 *   `AGENTS.md`, `GEMINI.md`        the same file under the name Codex and
 *                                   Gemini CLI look for.
 *   `codex.md`, `.codex/**`         Codex's instructions and its config.
 *   `.claude/skills/…`,             a skill is a way of working the agent
 *   any `SKILL.md`                  loads on demand; adding one is the most
 *                                   deliberate harness change there is.
 *   `.claude/commands/**`           a slash command is a skill typed by name.
 *   `.claude/agents/**`             what a subagent is and what it may use.
 *   `.claude/hooks/**`,             the hooks and permissions the harness
 *   `.claude/settings*.json`        runs under - what it may do unasked.
 *   `.cursor/rules/**`,             Cursor's rules, old form and new.
 *   `.cursorrules`
 *   `.github/copilot-instructions.md` Copilot's standing instructions.
 *   `.windsurfrules`                Windsurf's.
 *   `opencode.json`                 OpenCode's models, agents and permissions.
 *
 * Deliberately not here: `.github/workflows/**` (that is CI, which changes
 * what happens to the work rather than how the agent works), `package.json`
 * scripts, and lint configuration. Each of those does change agent
 * behaviour at the margin, and each is edited constantly for reasons that
 * have nothing to do with the agents, so counting them would drown the
 * signal in noise.
 *
 * `kind` groups a file for the page: `rules` is prose an agent reads every
 * time, `skill` is a capability it reaches for, `settings` is what the
 * harness itself is allowed to do.
 */
export const HARNESS_FILES = [
  { match: /(^|\/)CLAUDE\.md$/i, kind: "rules", why: "Claude Code's standing instructions" },
  { match: /(^|\/)AGENTS\.md$/i, kind: "rules", why: "the standing instructions Codex and others read" },
  { match: /(^|\/)GEMINI\.md$/i, kind: "rules", why: "Gemini CLI's standing instructions" },
  { match: /(^|\/)codex\.md$/i, kind: "rules", why: "Codex's standing instructions" },
  { match: /(^|\/)\.cursorrules$/i, kind: "rules", why: "Cursor's rules, the single-file form" },
  { match: /(^|\/)\.cursor\/rules\//i, kind: "rules", why: "Cursor's rules" },
  { match: /(^|\/)\.windsurfrules$/i, kind: "rules", why: "Windsurf's rules" },
  { match: /(^|\/)\.github\/copilot-instructions\.md$/i, kind: "rules", why: "Copilot's standing instructions" },
  { match: /(^|\/)SKILL\.md$/i, kind: "skill", why: "a skill the agent loads on demand" },
  { match: /(^|\/)\.claude\/skills\//i, kind: "skill", why: "a skill and what it carries" },
  { match: /(^|\/)\.claude\/commands\//i, kind: "skill", why: "a slash command - a skill typed by name" },
  { match: /(^|\/)\.claude\/agents\//i, kind: "settings", why: "what a subagent is and what it may use" },
  { match: /(^|\/)\.claude\/hooks\//i, kind: "settings", why: "what the harness runs around every tool call" },
  { match: /(^|\/)\.claude\/settings[^/]*\.json$/i, kind: "settings", why: "the harness's permissions and environment" },
  { match: /(^|\/)\.claude\//i, kind: "settings", why: "Claude Code's configuration" },
  { match: /(^|\/)\.codex\//i, kind: "settings", why: "Codex's configuration" },
  { match: /(^|\/)opencode\.json$/i, kind: "settings", why: "OpenCode's models, agents and permissions" },
];

/** The rule a path falls under, or null. First match wins, so the specific rules sit above `.claude/**`. */
export function ruleFor(path) {
  const clean = String(path ?? "").replace(/^\.\//, "").trim();
  if (!clean) return null;
  return HARNESS_FILES.find((rule) => rule.match.test(clean)) ?? null;
}

/** Is this a file that changes how an agent behaves here? */
export const isHarnessFile = (path) => ruleFor(path) != null;

/**
 * What kind of change a set of harness files is: all skills, all rules, all
 * settings, or `mixed` when a commit did more than one of those. A commit
 * that adds a skill and mentions it in CLAUDE.md is `mixed`, which is
 * accurate - its effect cannot be attributed to either half.
 */
export function kindOf(files) {
  const kinds = new Set();
  for (const file of files ?? []) {
    const rule = ruleFor(file);
    if (rule) kinds.add(rule.kind);
  }
  if (!kinds.size) return null;
  return kinds.size === 1 ? [...kinds][0] : "mixed";
}

// ------------------------------------------------------------- push events

/**
 * The harness changes in one push, as records to keep.
 *
 * The input is a parsed push event (repo-sources/github.js `parseWebhook`),
 * whose `commits` PR A keeps as `[{sha, message, added, removed, modified}]`.
 * A payload from before that keeps only a count, and a push whose commits
 * touched no harness file has none: both give `[]`, so nothing here needs a
 * caller to know which it has.
 *
 * A deleted CLAUDE.md is as much a harness change as a rewritten one, so
 * `removed` counts alongside `added` and `modified`.
 *
 * The branch rides on each change rather than being filtered here: whether a
 * push to a work branch counts is the caller's decision (phase 2 folds only
 * the default branch, since a rule on an unmerged branch governs nobody).
 */
export function changesIn(pushEvent, { repoId = null, now = Date.now() } = {}) {
  const event = pushEvent ?? {};
  if (event.kind && event.kind !== "push") return [];
  const commits = Array.isArray(event.commits) ? event.commits : [];
  const changes = [];
  for (const commit of commits) {
    if (!commit?.sha) continue;
    const touched = [...(commit.added ?? []), ...(commit.modified ?? []), ...(commit.removed ?? [])];
    const files = [...new Set(touched.map((path) => String(path ?? "").replace(/^\.\//, "")).filter(isHarnessFile))]
      .sort()
      .slice(0, MAX_FILES);
    if (!files.length) continue;
    changes.push({
      sha: String(commit.sha),
      // A push payload dates the push, not each commit; `timestamp` is
      // GitHub's own per-commit field when the caller kept it.
      at: timeOf(commit.at ?? commit.timestamp ?? event.at) || now,
      by: commit.by ?? commit.author?.username ?? commit.author?.name ?? event.by ?? null,
      // The subject line, which is what a card says instead of a bare sha.
      // PR A already keeps it on the push record; nothing else of the
      // commit's words is read here.
      message: firstLine(commit.message),
      repo: event.repo ?? null,
      repoId: repoId ?? event.repoId ?? null,
      branch: event.branch ?? null,
      files,
      kind: kindOf(files),
    });
  }
  return changes;
}

/**
 * A repository's list of harness changes, with a push's worth folded in:
 * deduplicated by sha, newest first, bounded. Incoming wins a tie, so a
 * webhook redelivered with more of the commit on it replaces the thinner
 * copy rather than being dropped as a duplicate.
 */
export function mergeChanges(existing = [], incoming = [], { max = MAX_CHANGES } = {}) {
  const bySha = new Map();
  for (const change of existing ?? []) if (change?.sha) bySha.set(change.sha, change);
  for (const change of incoming ?? []) if (change?.sha) bySha.set(change.sha, change);
  return [...bySha.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || String(a.sha).localeCompare(String(b.sha))).slice(0, max);
}

// ----------------------------------------------------------------- windows

/**
 * The fortnight either side of a change, and how much of the after side has
 * happened yet.
 *
 * The before window ends the moment the change landed and the after window
 * starts there, so no session is on both sides; a session that started
 * before the commit and ran past it counts as before, because that is the
 * CLAUDE.md it read.
 *
 * `fullness` is the share of the after window that has elapsed - 0.3 three
 * days into a fortnight - and `full` is whether it has all happened.
 * `settled` below refuses to judge until it has.
 */
export function windowsOf(change, { window = WINDOW, now = Date.now() } = {}) {
  const at = timeOf(change?.at) || 0;
  const end = Math.min(now, at + window);
  const elapsed = Math.max(0, end - at);
  return {
    at,
    window,
    before: [at - window, at],
    after: [at, Math.max(at, end)],
    fullness: window > 0 ? Math.min(1, elapsed / window) : 1,
    full: elapsed >= window,
  };
}

// ----------------------------------------------------------------- figures

/**
 * How much steering a session took, and how many turns it went round.
 *
 * Both come from the modules that count them - `performance.steersOf` and
 * the record's own `autonomyOf` - rather than being added up again here. A
 * record written before either was counted says nothing, which reads as
 * nought known and not as nought taken; the page's counts say how many
 * sessions the figure stands on, which is the honest half of that.
 */
export { steersOf };
export const turnsOf = (session) => autonomyOf(session).turns;

/** The figures this module compares, what each is called, and which way is better. `better: null` is reported and not judged. */
export const FIGURES = {
  closureRate: { label: "Finished", better: "higher", format: "percent" },
  oneShotRate: { label: "Finished first time", better: "higher", format: "percent" },
  costPerTask: { label: "Cost per task", better: "lower", format: "cost" },
  tokensPerTask: { label: "Tokens per task", better: "lower", format: "tokens" },
  steersPerTask: { label: "Steers per task", better: "lower", format: "number" },
  interventions: { label: "Interventions per finished task", better: "lower", format: "number" },
  timeToClosure: { label: "Time to finish", better: "lower", format: "duration" },
  // What landed and then came apart - reverted, hot-fixed, or the build
  // broken (PR A's `aftermathOf`, which `compare` already puts on the row).
  // A rule that makes agents finish more and break more has not helped, and
  // without this the page would say it had.
  failureRate: { label: "Came apart after landing", better: "lower", format: "percent" },
  frictionPoints: { label: "Friction per session", better: "lower", format: "number" },
  turnsPerSession: { label: "Turns per session", better: null, format: "number" },
};

/**
 * The key every session is put under so that `compare` - which exists to
 * split sessions into groups - hands back one row for all of them. Anything
 * but `performance.UNREPORTED`, which `compare` sets aside rather than
 * returning as a row.
 */
const WHOLE = "everything";

const ratio = (a, b) => (b > 0 ? a / b : null);
const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
const timeOf = (value) => (typeof value === "number" ? value : Date.parse(value ?? "") || 0);
const firstLine = (text) => {
  const line = String(text ?? "").split("\n")[0].trim();
  return line ? line.slice(0, 200) : null;
};

const EMPTY_ROW = {
  sessions: 0, tasks: 0, finished: 0, closureRate: null,
  tokens: 0, tokensPerTask: null, cost: 0, costPerTask: null,
  timeToClosure: null, timed: 0, interventions: null,
  oneShot: 0, oneShotRate: null, failureRate: null, kept: null,
  steers: 0, steersPerTask: null, turns: 0, turnsPerSession: null, frictionPoints: null,
};

/**
 * The figures for one set of sessions: `compare`'s row for the whole set,
 * plus the three it does not carry.
 *
 * `compare` is called rather than reimplemented, so every figure a page
 * puts either side of a harness change means exactly what the same word
 * means on the Performance page and cannot drift from it - one-shot rate
 * and what came apart after landing included, since PR B and PR A put both
 * on that row. Two things are arranged for the reuse: every session is put
 * in one group (see `WHOLE`), and `now` is set so that `compare`'s own
 * range filter starts at the window's beginning - the sessions handed to it
 * have already been cut to the window at both ends, and its filter has only
 * a lower bound.
 *
 * The three added here are the ones the comparison has no column for:
 * steering per task (it carries the buckets, which are the shape rather
 * than the rate), turns per session, and the friction score.
 */
export function figuresFor(sessions, pulls = [], tasks = [], { harnessLabel, since = 0 } = {}) {
  const own = (sessions ?? []).filter(Boolean);
  if (!own.length) return { ...EMPTY_ROW };
  const compared = compare(
    own.map((session) => ({ ...session, owner: WHOLE })),
    pulls,
    { dimension: "user", tasks, harnessLabel, range: DEFAULT_RANGE, now: since + RANGES[DEFAULT_RANGE] },
  );
  // `key` and `name` are the grouping's, and the grouping is a trick to get
  // one row out of a function that exists to make several. Neither belongs
  // in the answer: a page reading "everything" off a figure set would be
  // reading this module's plumbing.
  const { key, name, ...row } = compared.rows[0] ?? { ...EMPTY_ROW, sessions: own.length };

  // Tasks taken, deduplicated the way `compare` deduplicates them: two
  // sessions on one task must not make it two in the denominator either.
  const seen = new Set();
  for (const session of own) for (const task of tasksWorked(session, pulls, tasks)) seen.add(task.id);
  const steers = own.reduce((sum, session) => sum + steersOf(session), 0);
  const turns = own.reduce((sum, session) => sum + turnsOf(session), 0);

  return {
    ...row,
    sessions: own.length,
    steers,
    steersPerTask: ratio(steers, seen.size),
    turns,
    turnsPerSession: ratio(turns, own.length),
    frictionPoints: mean(own.map((session) => friction(session).points)),
  };
}

/** Which repository a session was in, as one comparable key - the id when it has one, the full name otherwise, "" for a session that named neither. */
export const repoKeyOf = (session) =>
  session?.repoId ?? (typeof session?.repo === "string" ? session.repo : session?.repo?.fullName) ?? "";

/** Was this session in the repository the change was made to? A change that names no repository governs every session it is handed. */
export function sameRepo(session, change) {
  if (change?.repoId) return session?.repoId === change.repoId;
  if (change?.repo) return repoKeyOf(session) === change.repo;
  return true;
}

const inWindow = (session, [from, to]) => {
  const at = session?.startedAt ?? 0;
  return at >= from && at < to;
};

/**
 * How the repository's sessions differ either side of one harness change.
 *
 * Only the change's own repository counts - a rule in one repository says
 * nothing about work in another - and only sessions that *started* in a
 * window, since a session's counts are not dated finer than its start.
 *
 * `delta` carries both sides and the move for every figure, with `good`
 * saying whether the move went the way the figure's `better` wants. A page
 * needs no table of directions of its own, and `verdict` reads the same
 * thing the page draws.
 */
export function beforeAfter(sessions = [], pulls = [], tasks = [], change = null, { window = WINDOW, now = Date.now(), harnessLabel, subject = "Sessions after it" } = {}) {
  const windows = windowsOf(change, { window, now });
  const mine = (sessions ?? []).filter((session) => session && sameRepo(session, change));
  const before = mine.filter((session) => inWindow(session, windows.before));
  const after = mine.filter((session) => inWindow(session, windows.after));
  const beforeFigures = figuresFor(before, pulls, tasks, { harnessLabel, since: windows.before[0] });
  const afterFigures = figuresFor(after, pulls, tasks, { harnessLabel, since: windows.after[0] });
  const delta = deltaOf(beforeFigures, afterFigures);
  const counts = { before: before.length, after: after.length };
  const settled = windows.full && counts.before >= MIN_SESSIONS && counts.after >= MIN_SESSIONS;
  return {
    change: change ? { sha: change.sha ?? null, at: windows.at, by: change.by ?? null, files: change.files ?? [], kind: change.kind ?? null } : null,
    windows,
    before: beforeFigures,
    after: afterFigures,
    delta,
    counts,
    settled,
    verdict: settled ? verdict(delta, counts, { subject }) : tooEarly(counts, windows, subject),
  };
}

/** The dimensions a change's two windows are split by beside the delta - who was working, and whose models. */
export const CONFOUNDS = ["user", "provider"];

/**
 * What else was different about the two fortnights: who was working in each
 * and whose models the work was done on.
 *
 * This is the confound, drawn rather than argued with. A cost that halved
 * the week a rule landed may be the rule, or may be the work moving from
 * Opus to Sonnet, or may be a different person doing different work; the
 * before/after cannot tell those apart and nothing here pretends it can.
 * What a reader can do is look at the mix either side, which is `compare`'s
 * own rows for each window, and decide for themselves.
 *
 * Only what a strip beside the card needs is kept per row - the name, how
 * many sessions and tasks it held, what it cost per task - since the whole
 * comparison is a page of its own already.
 */
export function besideIt(sessions = [], pulls = [], tasks = [], windows, { repoId = null, repo = null, harnessLabel, dimensions = CONFOUNDS } = {}) {
  const change = { repoId, repo };
  const mine = (sessions ?? []).filter((session) => session && sameRepo(session, change));
  const rowsFor = (side) => {
    const own = mine.filter((session) => inWindow(session, side));
    return (dimension) =>
      compare(own, pulls, { dimension, tasks, harnessLabel, range: DEFAULT_RANGE, now: side[0] + RANGES[DEFAULT_RANGE] }).rows.map((row) => ({
        key: row.key,
        name: row.name,
        sessions: row.sessions,
        tasks: row.tasks,
        costPerTask: row.costPerTask,
      }));
  };
  const before = rowsFor(windows.before);
  const after = rowsFor(windows.after);
  const out = {};
  for (const dimension of dimensions) out[dimension] = { before: before(dimension), after: after(dimension) };
  return out;
}

/**
 * The same pair of figures for a skill: the sessions that used it against
 * the sessions that did not.
 *
 * "Did not" is not every other session in the installation - a skill used
 * only in one repository would then be compared against every repository -
 * so the comparison is the sessions of the same repositories, in the same
 * range, that never loaded it. A skill used by a session with no repository
 * is compared against the other sessions with none.
 *
 * A skill use is a `skill.use` span carrying `cv.skill.name`
 * (telemetry-ingest.js); a caller who has the sessions by another route can
 * hand in `usedBy` instead of, or as well as, the spans.
 *
 * The pair is named `before` and `after` for the same reason the fields of
 * `beforeAfter` are: `after` is the world with the thing in it, `delta` is
 * the move from one to the other, and one `verdict` reads both. There is no
 * time in it.
 */
export function skillEffect(sessions = [], spans = [], skillName, { pulls = [], tasks = [], usedBy = null, range = DEFAULT_RANGE, now = Date.now(), harnessLabel, window = null } = {}) {
  const wanted = String(skillName ?? "").toLowerCase();
  const used = new Set(usedBy ?? []);
  for (const span of spans ?? []) {
    if (span?.name !== "skill.use" || !span.session) continue;
    if (String(span.attrs?.["cv.skill.name"] ?? "").toLowerCase() !== wanted) continue;
    used.add(span.session);
  }
  const since = now - (window ?? RANGES[range] ?? RANGES[DEFAULT_RANGE]);
  const inRange = (sessions ?? []).filter((session) => session && (session.startedAt ?? 0) >= since);
  const withIt = inRange.filter((session) => used.has(session.id));
  const repos = new Set(withIt.map(repoKeyOf));
  const withoutIt = inRange.filter((session) => !used.has(session.id) && repos.has(repoKeyOf(session)));

  const beforeFigures = figuresFor(withoutIt, pulls, tasks, { harnessLabel, since });
  const afterFigures = figuresFor(withIt, pulls, tasks, { harnessLabel, since });
  const delta = deltaOf(beforeFigures, afterFigures);
  const counts = { before: withoutIt.length, after: withIt.length };
  const settled = counts.before >= MIN_SESSIONS && counts.after >= MIN_SESSIONS;
  const subject = "Sessions using it";
  return {
    skill: skillName ?? null,
    repos: [...repos].filter(Boolean),
    range,
    since,
    before: beforeFigures,
    after: afterFigures,
    delta,
    counts,
    settled,
    verdict: settled ? verdict(delta, counts, { subject }) : tooEarly(counts, null, subject),
  };
}

// ----------------------------------------------------------------- verdicts

/** How far a figure has to move before it is a move and not noise: a tenth of what it was. */
export const MOVE_SHARE = 0.1;

/** Both sides of every figure, the move between them, and whether the move was the good way. */
export function deltaOf(before, after) {
  const delta = {};
  for (const [key, figure] of Object.entries(FIGURES)) {
    const from = before?.[key] ?? null;
    const to = after?.[key] ?? null;
    const change = from == null || to == null ? null : to - from;
    const moved = movedEnough(from, to);
    const direction = change == null ? "unknown" : !moved ? "same" : change > 0 ? "up" : "down";
    let good = null;
    if (figure.better && moved && change != null) good = figure.better === "higher" ? change > 0 : change < 0;
    delta[key] = { before: from, after: to, change, moved, direction, better: figure.better, good };
  }
  return delta;
}

/** A move worth mentioning: a tenth of where it started, or any move at all away from nothing. */
function movedEnough(from, to) {
  if (from == null || to == null) return false;
  if (from === to) return false;
  if (from === 0) return to !== 0;
  return Math.abs(to - from) / Math.abs(from) >= MOVE_SHARE;
}

/** The order the sentence mentions figures in: the ones a reader came for first. */
const SENTENCE_ORDER = ["oneShotRate", "closureRate", "failureRate", "costPerTask", "steersPerTask", "interventions", "timeToClosure", "tokensPerTask", "frictionPoints"];

/** How each figure reads in a sentence, in the good direction and the bad one. Fixed words - no model is asked to write this. */
const PHRASES = {
  oneShotRate: { good: "finish first time more often", bad: "finish first time less often" },
  closureRate: { good: "finish what they start more often", bad: "finish what they start less often" },
  failureRate: { good: "have less of what they landed come apart afterwards", bad: "have more of what they landed come apart afterwards" },
  costPerTask: { good: "cost less per task", bad: "cost more per task" },
  steersPerTask: { good: "need less steering", bad: "need more steering" },
  interventions: { good: "need somebody to step in less often", bad: "need somebody to step in more often" },
  timeToClosure: { good: "land faster", bad: "take longer to land" },
  tokensPerTask: { good: "use fewer tokens per task", bad: "use more tokens per task" },
  frictionPoints: { good: "hit less friction", bad: "hit more friction" },
};

/** How many things one sentence says per side before it stops being a sentence. */
const MAX_PHRASES = 2;

/**
 * What the pair of figures amounts to: `helped`, `hurt`, `mixed`, or
 * `too-early` when either side is thinner than `MIN_SESSIONS`, with one
 * plain sentence saying which figures moved and by how much.
 *
 * The sentence is built from the table above, not written by a model. It
 * names at most two figures a side and puts the numbers on the first, which
 * is the shape a person reads at a glance: "Sessions after it finish first
 * time more often (71% vs 54%) and cost less per task."
 *
 * A pair where nothing moved a tenth is `mixed` - there are four words
 * available and none of them is "no change", so the sentence says it
 * instead: nothing here helped and nothing hurt.
 */
export function verdict(delta, counts = {}, { subject = "Sessions after it" } = {}) {
  const before = counts.before ?? 0;
  const after = counts.after ?? 0;
  if (before < MIN_SESSIONS || after < MIN_SESSIONS) return tooEarly(counts, null, subject);

  const good = [];
  const bad = [];
  for (const key of SENTENCE_ORDER) {
    const entry = delta?.[key];
    if (!entry || entry.good == null) continue;
    (entry.good ? good : bad).push({ key, entry });
  }
  const say = (list) =>
    list
      .slice(0, MAX_PHRASES)
      .map(({ key, entry }, index) => {
        const words = PHRASES[key][entry.good ? "good" : "bad"];
        return index === 0 ? `${words} (${pair(key, entry)})` : words;
      })
      .join(" and ");

  if (good.length && !bad.length) return { verdict: "helped", sentence: `${subject} ${say(good)}.`, good: good.map((one) => one.key), bad: [] };
  if (bad.length && !good.length) return { verdict: "hurt", sentence: `${subject} ${say(bad)}.`, good: [], bad: bad.map((one) => one.key) };
  if (good.length && bad.length) {
    return { verdict: "mixed", sentence: `${subject} ${say(good)}, but ${say(bad)}.`, good: good.map((one) => one.key), bad: bad.map((one) => one.key) };
  }
  return { verdict: "mixed", sentence: `${subject} look much the same.`, good: [], bad: [] };
}

/** The one verdict that is about the evidence rather than the figures. */
function tooEarly(counts = {}, windows = null, subject = "Sessions after it") {
  const before = counts.before ?? 0;
  const after = counts.after ?? 0;
  const thin = before < MIN_SESSIONS || after < MIN_SESSIONS;
  const days = windows && !windows.full ? Math.max(0, Math.round((windows.window * (1 - windows.fullness)) / DAY)) : 0;
  const reason = thin
    ? `${plural(before, "session")} before and ${after} after, and ${MIN_SESSIONS} of each is the least worth reading`
    : windows
      ? `the window after it is not up yet - ${plural(days, "day")} to go`
      : "not enough has happened since";
  return { verdict: "too-early", sentence: `Too early to tell: ${reason}.`, good: [], bad: [], subject };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ------------------------------------------------------------- the numbers

/** "71% vs 54%" - after against before, in the figure's own units. */
function pair(key, entry) {
  const format = FIGURES[key]?.format ?? "number";
  return `${show(entry.after, format)} vs ${show(entry.before, format)}`;
}

/** One figure as a person reads it. Cost is cents, the way sessions.js counts it. */
export function show(value, format = "number") {
  if (value == null) return "—";
  switch (format) {
    case "percent":
      return `${Math.round(value * 100)}%`;
    case "cost":
      if (value < 1) return "<1¢";
      return value < 100 ? `${Math.round(value)}¢` : `$${(value / 100).toFixed(2)}`;
    case "tokens":
      if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
      return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value));
    case "duration": {
      if (value < 60_000) return `${Math.round(value / 1000)}s`;
      if (value < 3_600_000) return `${Math.round(value / 60_000)}m`;
      if (value < 24 * 3_600_000) return `${(value / 3_600_000).toFixed(1)}h`;
      return `${(value / DAY).toFixed(1)}d`;
    }
    default:
      return String(Math.round(value * 10) / 10);
  }
}
