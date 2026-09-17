// Performance: what came of the work, and what it took.
//
// The question this answers is the one a person with several agents (and a
// harness of their own, and a vendor's bot on the repository) actually asks:
// which of these is worth the money? The measure is whether the work it was
// asked for landed, how many times it had to go round first, and how much
// steering the person had to do to get it there. So that is what is
// measured, per session, and then added up per agent, per harness, per
// person.
//
// ## A task, and why it is no longer a merged pull request
//
// The unit is a task: one piece of work an agent was asked to do. It used
// to be a merged pull request, and that was wrong for every agent that does
// not write them - one that triages issues, one that answers in Slack, one
// that reviews somebody else's branch. They scored nought and sorted last,
// which reads as "this agent is worthless" when what it means is "this page
// cannot see what this agent does".
//
// A task is wherever the ask was written down, which is one of two places:
//
//   - **A task record** (agent-tasks.js), when the work was handed over as
//     one. Its own state is the verdict: `done` landed, `failed` and
//     `declined` did not, the rest is still going.
//   - **A pull request**, when there is no task record. Merged landed,
//     closed did not, open is still going. The old measure, kept as one
//     case of the new one rather than as the whole of it.
//
// A session with neither - somebody asked a question and got an answer -
// has no verdict, and counts as a session but not as a task. Calling it
// finished because nothing went wrong would be this page's opinion; the
// honest thing is to say it was not a piece of work with an end. That is
// also why the rate is finished-of-tasks and not finished-of-sessions: a
// chatty agent would otherwise look bad at work nobody asked it to do.
//
// Components, not a number. There is a scalar `score`, and it exists to
// order rows: a table has to be sorted by something, and "finished, then
// going-and-recent, then everything else, less the friction" is a fair
// something. But no page shows the score as the answer, because a number
// that folds "finished after eleven corrections" and "a day old with none"
// into one figure has thrown away exactly what the person came to see. The
// page shows tasks finished, the rate, rounds to finish, lines per task,
// cost per task; the score decides which row is on top.
//
// `effective` is the one judgement made for the reader, and it is relative:
// finished at least one, at a rate no worse than the middle of the
// installation. On an installation where everything lands first time, an
// agent that finishes half of what it takes is the one to look at; on one
// where nothing does, it is the star. Absolute thresholds would be somebody
// else's opinion of what good is.
//
// Everything here is pure - sessions and pull requests in, rows out - so a
// test can hand it a year of history in a line and so the routes stay thin.
import { guidanceOf, autonomyOf, outcomeOfPulls, mainModelOf, workOf } from "./sessions.js";
import { LABEL as WORK_LABEL, UNSAID as WORK_UNSAID, WORDS as WORK_WORDS } from "./work-kinds.js";
import { providerOf } from "./models.js";
import { KINDS as STEER_KINDS } from "./steer-kinds.js";

const DAY = 24 * 60 * 60 * 1000;

/** How far back each range looks. */
export const RANGES = { "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY };
export const DEFAULT_RANGE = "7d";

/** What rows can be grouped by. */
export const BY = ["agents", "harnesses", "users", "sessions"];

/**
 * A task still going is worth something today and less each day: it is work
 * that may still land, and after two weeks it mostly does not.
 */
export const OPEN_DECAY_MS = 14 * DAY;
const OPEN_WORTH = 0.3;

/** The most friction can take off a score. Finished is finished, however hard-won. */
export const MAX_PENALTY = 0.5;
/** How many friction points it takes to reach that. */
const PENALTY_POINTS = 20;

/** Rounds a pull request went round: what a session summary says, or what the reviews say. */
export const roundsOf = (pull) =>
  pull?.changesRequested ?? (pull?.reviews ?? []).filter((review) => review.state === "changes_requested").length;

/**
 * The pull requests to judge a session by. The store's records when the
 * caller has them (`pulls` are records with `sessionIds`), the session's own
 * summaries otherwise; one entry per pull request either way.
 */
export function pullsOf(session, pulls = []) {
  const byId = new Map();
  for (const pull of session?.pulls ?? []) if (pull?.id) byId.set(pull.id, pull);
  for (const pull of pulls) {
    if (pull?.id && (pull.sessionIds ?? []).includes(session.id)) byId.set(pull.id, pull);
  }
  return [...byId.values()];
}

/** merged | open | closed | none. */
export function outcomeOf(session, pulls = []) {
  return outcomeOfPulls(pullsOf(session, pulls)) ?? session?.outcome ?? "none";
}

// --------------------------------------------------------------- tasks

/** A task record's state, as a verdict. Anything else it is still going. */
const TASK_VERDICT = { done: "done", failed: "undone", declined: "undone" };
/** A pull request's state, as the same verdict, for a session with no task record. */
const PULL_VERDICT = { merged: "done", closed: "undone", open: "doing" };

/** How many pull requests came back to this one - a count on a summary, a list on a record. */
export const followUpsOf = (pull) => (Array.isArray(pull?.followUps) ? pull.followUps.length : Number(pull?.followUps ?? 0));

/**
 * Whether a merge came apart afterwards (pulls.js, pull-aftermath.js):
 * somebody took it back out, or an app it shipped to was rolled back off
 * it, or it broke the build the moment it landed, or a fix had to follow
 * it. Four different things, one question - "did this actually hold?" -
 * and the page names each of them separately.
 */
export const undoneAfter = (pull) =>
  Boolean(pull?.reverted) || Boolean(pull?.rolledBack) || Boolean(pull?.brokeBuild) || followUpsOf(pull) > 0;

/**
 * A pull request's verdict, with what became of it after the merge.
 *
 * A merge that was reverted, or that broke the build, is `undone`: it is
 * not a task finished, whatever the state field says, and counting it as
 * one is the single most flattering thing this page could do. A merge that
 * merely needed a fix behind it *is* finished - the work landed and stayed
 * - and shows up in `undoneAfter` on the row instead.
 *
 * A merge rolled out of production goes with the first two rather than the
 * third, and the case for it is the strongest of the four: the merge held,
 * the *deploy* did not, and somebody thought it worth an emergency to take
 * it out again. Reading that as a finished task because the branch still
 * carries the code would be the flattery this function exists to refuse.
 */
export function pullVerdict(pull) {
  if (pull?.state === "merged" && (pull.reverted || pull.rolledBack || pull.brokeBuild)) return "undone";
  return PULL_VERDICT[pull?.state] ?? "doing";
}

/**
 * The task records a session worked on: the ones whose ids it noted as it
 * went (sessions.js `noteTask`). Records the caller has - the module stays
 * pure, so a route hands in `allTasks(repos)` and a test hands in three.
 */
export function tasksOf(session, tasks = []) {
  const ids = new Set(session?.taskIds ?? []);
  if (!ids.size || !tasks.length) return [];
  return tasks.filter((task) => ids.has(task.id));
}

/** A time that may be a number or an ISO string, as a number. Zero when neither. */
const timeOf = (value) => (typeof value === "number" ? value : Date.parse(value) || 0);

/**
 * What a session was asked to do, as tasks with verdicts - the task records
 * it noted, or its pull requests when it noted none, or nothing at all.
 *
 * Each carries the id it is deduplicated by (two sessions on one task are
 * one task on the row they share), when it started - for how much a task
 * still going is worth - and how many rounds it has been through, which is
 * attempts for a task record and review rounds for a pull request.
 */
export function tasksWorked(session, pulls = [], tasks = []) {
  const own = tasksOf(session, tasks);
  if (own.length) {
    return own.map((task) => ({
      id: `task:${task.id}`,
      verdict: TASK_VERDICT[task.state] ?? "doing",
      // A task nobody has picked up yet is not on the clock (agent-tasks.js),
      // so what a task still going is worth runs from when it was accepted.
      at: timeOf(task.acceptedAt || task.createdAt) || (session.startedAt ?? 0),
      // When it landed. A task record keeps no `doneAt`, but the state it
      // is in now is `done` and `updatedAt` is when it got there.
      doneAt: task.state === "done" ? timeOf(task.updatedAt) || null : null,
      rounds: task.attempt ?? 1,
    }));
  }
  return pullsOf(session, pulls).map((pull) => ({
    id: `pull:${pull.id}`,
    verdict: pullVerdict(pull),
    at: timeOf(pull.openedAt) || (session.startedAt ?? 0),
    doneAt: pull.state === "merged" ? timeOf(pull.mergedAt) || null : null,
    rounds: roundsOf(pull) + 1,
  }));
}

/**
 * One verdict for the session: done if any of its tasks landed, else going
 * if any is still going, else undone, else null for a session that was not
 * asked for a piece of work at all.
 *
 * Any rather than all, deliberately. A session that finished one of the two
 * tasks it touched did finish something, and the rate counts the tasks
 * themselves, so the good one is not double-counted by being here too.
 */
export function verdictOf(session, pulls = [], tasks = []) {
  const worked = tasksWorked(session, pulls, tasks);
  if (!worked.length) return null;
  if (worked.some((task) => task.verdict === "done")) return "done";
  if (worked.some((task) => task.verdict === "doing")) return "doing";
  return "undone";
}

// ----------------------------------------------------------------- yield
//
// The verdict says whether a piece of work finished. Yield says what a
// whole session came to, in one word, over every session in the range -
// including the ones with no task and no pull request, which the verdict
// has nothing to say about and which are where a good deal of the money
// goes. Eight words, in the order a reader ranks them:
//
//   shipped     something it merged is in production (deploys.js)
//   merged      something landed and stayed, first time
//   reworked    it landed, but went round again or needed a fix behind it
//   reverted    something it merged was taken back out, rolled out of
//               production again, or broke the build
//   closed      what it took on was closed, failed or declined
//   discarded   it edited files, ended, and no task or pull request ever
//               came of it - a week on, that is not a slow one, it is one
//               nobody used
//   research    it edited nothing and took nothing on: a question answered
//   going       still running, or still waiting to be judged
//
// The three that mean "the money bought nothing" - closed, discarded,
// reverted - are what `compareAll` adds up as `waste`, which is the figure
// the tile on the Performance page shows. Research is deliberately not one
// of them: a question answered is work, and calling it waste would push
// this page towards telling people not to ask questions.

/** The words, in the order the page ranks them. */
export const YIELDS = ["shipped", "merged", "reworked", "reverted", "closed", "discarded", "research", "going"];
/** The yields that mean the spend bought nothing that lasted. */
export const WASTED = new Set(["closed", "discarded", "reverted"]);
/** How long after a session ends with files edited and nothing to show it stops being "maybe still coming". */
export const DISCARD_AFTER_MS = 7 * DAY;

/**
 * How many files the session's work landed on. The hook reports each path
 * (sessions.js `noteFile`); a harness whose hook says nothing reports
 * none, and such a session cannot be told from one that only read - so it
 * counts as research, which docs/measures.md says plainly.
 */
export const filesTouchedOf = (session) => session?.filesTouched ?? session?.files?.length ?? 0;

/**
 * What the whole session came to, in one word. See the essay above.
 *
 * Pull requests are read before tasks here, deliberately: a task record
 * can say `done` about work whose pull request was reverted the next day,
 * and the pull request is the one of the two that the world checked.
 */
export function yieldOf(session, pulls = [], tasks = [], { now = Date.now() } = {}) {
  const own = pullsOf(session, pulls);
  const merged = own.filter((pull) => pull.state === "merged");
  // "Reverted" is the word for taken back out, whichever way it went out:
  // a revert on the branch, a rollback off the app, a build it turned red.
  // A ninth word for the rollback was the alternative and was not taken -
  // the vocabulary is read as a ranking, and a reader who has to learn that
  // "rolled back" sits beside "reverted" is being charged for a
  // distinction the page can make on the line beneath.
  if (merged.some((pull) => pull.reverted || pull.rolledBack || pull.brokeBuild)) return "reverted";
  if (merged.length) {
    if (merged.some((pull) => pull.shipped)) return "shipped";
    const rounds = merged.some((pull) => roundsOf(pull) > 0);
    return rounds || merged.some((pull) => followUpsOf(pull) > 0) ? "reworked" : "merged";
  }
  const verdict = verdictOf(session, pulls, tasks);
  if (verdict === "done") return tasksWorked(session, pulls, tasks).some((task) => task.rounds > 1) ? "reworked" : "merged";
  if (verdict === "doing") return "going";
  if (verdict === "undone") return "closed";
  // Neither a task record nor a pull request: what is left is how it ran.
  if (session.state === "live" || !session.endedAt) return "going";
  if (!filesTouchedOf(session)) return "research";
  return now - session.endedAt >= DISCARD_AFTER_MS ? "discarded" : "going";
}

/** Every yield in a set of sessions, counted, with every word present at nought. */
export function yields(sessions, pulls = [], { tasks = [], now = Date.now() } = {}) {
  const counted = Object.fromEntries(YIELDS.map((word) => [word, 0]));
  for (const session of sessions) counted[yieldOf(session, pulls, tasks, { now })] += 1;
  return counted;
}

/**
 * How much steering the session took, and one figure for it.
 *
 * A line from a person is a point; a follow-up is a point; a retry or a
 * review round is two, because each is a whole pass that did not land; a
 * failed tool call is a quarter, because agents recover from most of those
 * without anybody noticing.
 */
export function friction(session) {
  const guidance = guidanceOf(session);
  const lines = guidance.humanLines + guidance.followUps;
  const points = lines + 2 * (guidance.retries + guidance.reviewRounds) + guidance.failedTools / 4;
  return { ...guidance, lines, points };
}

/** What friction takes off, bounded. */
export const penaltyOf = (session) => Math.min(MAX_PENALTY, friction(session).points / PENALTY_POINTS);

/**
 * What became of a set of pull requests after they merged: how many landed
 * at all, how many of those came apart afterwards, how many reached
 * production and how many were rolled back out of it, and the median share
 * of a merge's added lines still present a month later (`kept`, null until
 * a merge in the set is old enough to have been measured -
 * pull-aftermath.js).
 *
 * `landed` and not `finished` as the denominator of `failureRate`,
 * because a reverted merge is no longer counted as finished: over
 * `finished` a row where everything was reverted would read as a failure
 * rate of nought, which is the opposite of the truth.
 */
export function aftermathOf(pulls = []) {
  const landed = pulls.filter((pull) => pull?.state === "merged");
  const shares = landed.map((pull) => pull.durability?.share).filter((share) => share != null);
  return {
    landed: landed.length,
    undoneAfter: landed.filter(undoneAfter).length,
    failureRate: ratio(landed.filter(undoneAfter).length, landed.length),
    kept: median(shares),
    measured: shares.length,
    shipped: landed.filter((pull) => pull.shipped).length,
    // Of those, the ones production gave back (pulls.js `noteRolledBack`).
    // Counted beside `shipped` rather than inside it: the merge did reach
    // production, and how long it stayed is the second question.
    rolledBack: landed.filter((pull) => pull.rolledBack).length,
  };
}

// ------------------------------------------------------------- autonomy
//
// How much of the work the agent did on its own. Friction above is a
// weighted score for ordering rows; these are counts and shares meant to be
// read as themselves, and they answer the question a team asks about a tool
// after the first month: not "did it finish" but "how much of my afternoon
// did it take to make it finish".
//
// The unit is a *steer*: everything after the first ask. A follow-up, a cut
// short, a round of review, a retried task - each is a person coming back
// to work that was supposed to be done. The first ask is not one; that is
// the work, not the steering of it.

/**
 * Every steer a session took. The name is deliberately not "interventions":
 * that is the comparison's own figure below and it is averaged over
 * finished tasks, where this is the whole count on one session.
 */
export function steersOf(session) {
  const guidance = guidanceOf(session);
  return guidance.followUps + guidance.interrupts + guidance.reviewRounds + guidance.retries;
}

/**
 * Whether this session's steering can be seen at all.
 *
 * An external vendor's agent - Greptile, Devin, a Codex cloud run - is
 * prompted somewhere we have no window on, and every steering count on it
 * is nought for want of a sensor rather than for want of steering. Nought
 * and "we cannot see" look identical on a chart and mean opposite things,
 * so the row carries this and the page prints "steering not visible"
 * instead of a number.
 */
export const steeringVisibleOf = (session) => session?.kind !== "external";

/**
 * Whether this session's steering was ever *counted* - a different question
 * from whether it could have been.
 *
 * A nought nobody counted is not a nought. Every session recorded before
 * the counters existed has no `counts.turns` and an empty `guidance`, so
 * `steersOf` reads nought on it, and a page that believes that nought says
 * those sessions finished their work first time, every time, without a
 * word - which is the opposite of what an absent sensor means. On this
 * installation it made the one-shot tile read eleven per cent off nothing
 * but the age of the records: the old ones scored a hundred, the new ones
 * scored what they earned, and the figure was the ratio of the two eras
 * rather than a fact about any agent.
 *
 * So the counter has to have run at least once. `counts.turns >= 1` says it
 * did: the first ask itself went through a door that counts (`sessions.js
 * turned` - a harness hook's prompt, the console's own, Claude Code's
 * export), and a session that took no steering after it genuinely took
 * none. The exception is the session nobody prompts through a door at all -
 * an assistant or a resident woken by the bell - whose steering arrives as
 * guidance without a turn; `humanLines > 0` is the same proof for it.
 *
 * Anything else is unknown, and unknown is drawn as "not measured" rather
 * than as a perfect score. An external agent's steering is not visible, so
 * it is not known either.
 */
export function steeringKnownOf(session) {
  if (!steeringVisibleOf(session)) return false;
  const turns = session?.counts?.turns;
  if (typeof turns === "number" && turns >= 1) return true;
  const kind = session?.kind;
  if (kind === "assistant" || kind === "resident") return guidanceOf(session).humanLines > 0;
  return false;
}

/**
 * A session's turns and its clock, with the steers labelled by kind
 * (steer-kinds.js) and the ones nobody labelled counted as such.
 *
 * `unclassified` is not a failure to report: an installation with no model
 * configured labels nothing, and a page that showed only the labelled ones
 * would quietly under-count every steer on it.
 */
export function autonomyFigures(session) {
  const { turns, agentMs, personMs, steers: byKind } = autonomyOf(session);
  const steers = steersOf(session);
  const labelled = Object.values(byKind).reduce((sum, count) => sum + (Number(count) || 0), 0);
  return {
    turns,
    agentMs,
    personMs,
    steers,
    kinds: byKind,
    unclassified: Math.max(0, steers - labelled),
    visible: steeringVisibleOf(session),
    // Whether the nought above is a nought or a gap - see `steeringKnownOf`.
    known: steeringKnownOf(session),
  };
}

// ----------------------------------------------------------- acceptance
//
// How much code the session wrote, and how much of it survived to a merge.
// The counts come from the editing calls its hooks reported
// (telemetry-ingest.js `done`), the survivors from the merged diff
// (pull-aftermath.js `heardMerge`), and the ratio is worked out here rather
// than stored, so it cannot go stale against either half.
//
// The important case is the one where there is no answer. A harness that
// sends no tool input writes code this app cannot count: `linesAdded` is
// nought and `filesTouched` is not, and a page that prints "0 lines, 0%
// kept" there has invented a fact. `measured` is how it says so.
//
// There are two ways to have no answer, though, and they are not the same
// apology. A Claude Code session recorded before the counter existed was
// told "this harness does not send what its edits contained" - which is
// false about Claude Code, whose hooks send `tool_input` and always did:
// the record simply predates the count. `why` tells them apart, so the
// page can say the true one.

/**
 * The harness kinds whose hooks genuinely carry no editing input, so a
 * session of theirs writes lines nothing here can count however new the
 * record is. Codex's hooks send no `tool_input`; OpenCode reaches this app
 * through the gateway, whose spans are model calls and carry no tool input
 * at all. Anything else that edited files and reported no lines is a gap
 * this app cannot explain, and says so rather than blaming the harness.
 */
export const HARNESS_WITHOUT_EDIT_INPUT = new Set(["codex", "opencode"]);

/**
 * What a session wrote and what became of it.
 *
 * `measured` is false only for a session that plainly edited something and
 * reported no lines for it. A session that edited nothing - a review, a
 * question answered - is measured and wrote nought, which is true.
 *
 * `why` says which kind of unmeasured it is, and is null when it is
 * measured: `predates` for a record written before `counts.linesAdded`
 * existed (the key is absent; every record since carries it, at nought),
 * `harness` for one whose harness cannot report lines at all, `unknown`
 * for a session that edited files, could have reported lines and did not.
 *
 * @returns {{linesAdded: number, linesRemoved: number, edits: number, accepted: number|null, acceptance: number|null, measured: boolean, why: string|null}}
 */
export function editsOf(session) {
  const counts = session?.counts ?? {};
  const linesAdded = counts.linesAdded ?? 0;
  const accepted = typeof session?.edits?.accepted === "number" ? session.edits.accepted : null;
  const counted = counts != null && Object.prototype.hasOwnProperty.call(counts, "linesAdded");
  const measured = linesAdded > 0 || (counted && filesTouchedOf(session) === 0);
  let why = null;
  if (!measured) {
    if (!counted) why = "predates";
    else why = HARNESS_WITHOUT_EDIT_INPUT.has(harnessKindOf(session)) ? "harness" : "unknown";
  }
  return {
    linesAdded,
    linesRemoved: counts.linesRemoved ?? 0,
    edits: counts.edits ?? 0,
    accepted,
    acceptance: linesAdded > 0 && accepted != null ? Math.min(1, accepted / linesAdded) : null,
    measured,
    why,
  };
}

/**
 * The same over a set of sessions: how many lines they wrote between them,
 * how many of those went through a review at all, how many survived it, and
 * the share.
 *
 * The share is pooled - all the accepted lines over all the *reviewed* ones
 * - and not the mean of the per-session shares, which would let a session
 * that wrote four lines and had them all merged outweigh one that wrote
 * four hundred.
 *
 * `reviewed` and not `linesAdded` is the denominator, and it matters: a
 * session whose pull request is still open has written lines that nothing
 * has kept or thrown away yet, and dividing by those would make a row's
 * acceptance a measure of how much of its work had merged by Tuesday. Only
 * a session with a merge behind it has an answer; `merged` says how many
 * that was, and `measured` how many could be counted at all, so a row can
 * say how much of itself the figure is standing on.
 *
 * `predates` is how many of the unmeasured ones were simply recorded before
 * the count existed (`editsOf` `why`), so a page can apologise with the
 * true reason instead of blaming the harness for all of them.
 */
export function acceptanceOfAll(sessions = []) {
  let linesAdded = 0;
  let reviewed = 0;
  let accepted = 0;
  let measured = 0;
  let unmeasured = 0;
  let predates = 0;
  let merged = 0;
  for (const session of sessions) {
    const own = editsOf(session);
    if (!own.measured) {
      unmeasured += 1;
      if (own.why === "predates") predates += 1;
      continue;
    }
    measured += 1;
    linesAdded += own.linesAdded;
    if (own.accepted == null) continue;
    merged += 1;
    reviewed += own.linesAdded;
    accepted += own.accepted;
  }
  return { linesAdded, reviewed, accepted, acceptance: reviewed > 0 ? Math.min(1, accepted / reviewed) : null, measured, unmeasured, predates, merged };
}

/**
 * Which bucket a session's steer count falls in, for the comparison's
 * stacked bar. `unknown` is last and is not a count of steers: it is the
 * sessions whose steering was never counted (`steeringKnownOf`), which
 * belong nowhere on a scale from nought upwards.
 */
export const STEER_BUCKETS = ["0", "1-2", "3-5", "6+", "unknown"];

export const steerBucketOf = (steers) => {
  if (steers <= 0) return "0";
  if (steers <= 2) return "1-2";
  if (steers <= 5) return "3-5";
  return "6+";
};

/** When the oldest task still going started - the session's start when nobody knows. */
function goingSince(session, worked) {
  const times = worked.filter((task) => task.verdict === "doing").map((task) => task.at).filter(Boolean);
  return times.length ? Math.min(...times) : session.startedAt ?? 0;
}

/**
 * One number, for ordering. A task finished is 1, one that did not and a
 * session that was asked for nothing are 0, one still going is worth
 * something that runs out over two weeks; friction comes off, but never
 * below zero - a session is not a debt.
 */
export function score(session, pulls = [], { tasks = [], now = Date.now() } = {}) {
  const worked = tasksWorked(session, pulls, tasks);
  const verdict = verdictOf(session, pulls, tasks);
  let base = 0;
  if (verdict === "done") base = 1;
  else if (verdict === "doing") {
    const age = Math.max(0, now - goingSince(session, worked));
    base = OPEN_WORTH * Math.max(0, 1 - age / OPEN_DECAY_MS);
  }
  return Math.max(0, base - penaltyOf(session));
}

/**
 * The harness kind a session ran in: what its record says, else the loop
 * for a resident and the session's own kind for anything else.
 */
export const harnessKindOf = (session) =>
  session.harness?.kind ?? (session.kind === "resident" ? "agentd" : session.kind);

/**
 * What a session row can be narrowed by on the Performance page: the
 * executor that did the work, the harness it ran in, whose it was. The page
 * shows every session at once and filters on the client, so these ride on
 * the row rather than being asked for again.
 */
export function facetsOf(session) {
  const kind = harnessKindOf(session);
  return {
    actor: { id: session.actor?.id ?? null, name: session.actor?.name ?? null },
    harness: { id: session.harness?.id ?? kind, name: session.harness?.name ?? kind, kind },
    // Where it ran and whose model, in the comparison's own words
    // (`groupOf`) rather than words of our own. The page's one filter offers
    // these beside the executor and the harness, and a reader pressing
    // Niteshift there presses the same Niteshift the charts have a bar for -
    // which only holds while one function decides what a thing is called.
    sandbox: groupOf(session, "sandbox"),
    provider: groupOf(session, "provider"),
    // And what kind of work it was, in the same words the kinds table
    // groups by - null key when the agent never said, so the filter offers
    // no "Unsaid" to pick and the row's note prints nothing for it.
    work: groupOf(session, "work").key === UNREPORTED ? { key: null, name: null } : groupOf(session, "work"),
    owner: session.owner ?? null,
    startedAt: session.startedAt ?? null,
    // Where the work sits relative to the workspace reading the ranking -
    // index.js `sessionsInScope` stamps it. A session row that is a
    // repository nobody connected here has to say so, or the ranking
    // silently mixes the team's repos with whatever else was open.
    where: session.where ?? null,
    repository: session.repo?.fullName ?? null,
  };
}

/** Which row a session belongs on, and what to call the row. */
export function keyOf(session, by) {
  switch (by) {
    case "agents":
      return { key: session.actor?.id ?? "?", name: session.actor?.name ?? session.actor?.id ?? "?", kind: session.kind };
    case "harnesses": {
      const harness = session.harness;
      const kind = harnessKindOf(session);
      return { key: harness?.id ?? kind, name: harness?.name ?? kind, kind };
    }
    case "users":
      return { key: session.owner ?? "?", name: session.owner ?? "?", kind: "person" };
    // The machine the start hook named, keyed the way the Executors page
    // keys its own rows (index.js `discoveredSetups`), so a setup's row and
    // its standing are the same thing said twice rather than two things
    // that have to be matched up. A session whose hook never landed named
    // no machine and is on no setup's row, so it is on none of these either.
    case "machines": {
      const machine = session.machine;
      return { key: machine?.id ? `setup:${machine.id}` : "?", name: machine?.name ?? machine?.id ?? "?", kind: "setup" };
    }
    default:
      return { key: session.id, name: session.actor?.name ?? session.id, kind: session.kind };
  }
}

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const ratio = (a, b) => (b > 0 ? a / b : null);

/**
 * One row's history: its sessions inside the range, by the UTC day each
 * started, with what each day came to. The Executors page draws it under
 * the aggregate, because "merged eight this month" and "merged eight in
 * one afternoon and nothing since" are different agents.
 *
 * Every day in the range is present, at zero when empty, so a strip of bars
 * has a bar per day and a gap is a day with nothing rather than a day the
 * reader has to infer. A pull request counts on the day of the session that
 * opened it, once.
 */
export function series(sessions, pulls = [], { key, by = "agents", range = DEFAULT_RANGE, now = Date.now(), tasks = [] } = {}) {
  const span = RANGES[range] ?? RANGES[DEFAULT_RANGE];
  const since = now - span;
  const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
  const empty = (day) => ({ day, sessions: 0, live: 0, finished: 0, taken: 0, lines: 0, steers: 0, cost: 0, tokens: 0 });
  const days = new Map();
  for (let at = since; at <= now; at += DAY) days.set(dayOf(at), empty(dayOf(at)));
  if (!days.has(dayOf(now))) days.set(dayOf(now), empty(dayOf(now)));
  const counted = new Set();
  for (const session of sessions) {
    if (!session || (session.startedAt ?? 0) < since) continue;
    if (keyOf(session, by).key !== key) continue;
    const bucket = days.get(dayOf(session.startedAt));
    if (!bucket) continue;
    bucket.sessions += 1;
    if (session.state === "live") bucket.live += 1;
    bucket.lines += friction(session).lines;
    bucket.steers += steersOf(session);
    bucket.cost += session.counts?.cost ?? 0;
    bucket.tokens += session.counts?.tokens ?? 0;
    for (const task of tasksWorked(session, pulls, tasks)) {
      if (counted.has(task.id)) continue;
      counted.add(task.id);
      bucket.taken += 1;
      if (task.verdict === "done") bucket.finished += 1;
    }
  }
  return { key, by, range, since, days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)) };
}

/**
 * Rank sessions started inside the range, grouped `by`.
 *
 * Each row: how many sessions, how many tasks it took and finished, the
 * rate, the median rounds a finished task went (1 is first time), steering
 * lines and cost per task, and the score that orders it. A task two
 * sessions worked on counts once on the row they share. A session row also
 * carries its facets (`facetsOf`): a page showing every session is a page
 * filtering by them.
 */
export function rank(sessions, pulls = [], { by = "agents", range = DEFAULT_RANGE, now = Date.now(), tasks = [] } = {}) {
  const since = now - (RANGES[range] ?? RANGES[DEFAULT_RANGE]);
  const groups = new Map();
  for (const session of sessions) {
    if (!session || (session.startedAt ?? 0) < since) continue;
    const { key, name, kind } = keyOf(session, by);
    let group = groups.get(key);
    if (!group) {
      group = { key, name, kind, sessions: 0, live: 0, tasks: new Map(), pulls: new Map(), lines: 0, steers: 0, visible: 0, counted: 0, cost: 0, score: 0, lastAt: 0, wrote: [] };
      if (by === "sessions") group.facets = facetsOf(session);
      groups.set(key, group);
    }
    group.sessions += 1;
    if (session.state === "live") group.live += 1;
    if ((session.lastSeenAt ?? session.startedAt ?? 0) > group.lastAt) {
      group.lastAt = session.lastSeenAt ?? session.startedAt ?? 0;
      group.name = name;
    }
    // How much steering this session took, carried onto each task it worked
    // so that "finished first time" can be read off the tasks themselves.
    // The first session on a task owns that figure: a second session on the
    // same task is more steering of the same piece of work, and the answer
    // to "did this land first time" is already no by then.
    const steers = steersOf(session);
    // ...and whether that count is a count at all (`steeringKnownOf`): a
    // task whose session never had its turns counted has no answer to
    // "did it land first time", and must not be given the flattering one.
    const known = steeringKnownOf(session);
    for (const task of tasksWorked(session, pulls, tasks)) {
      const already = group.tasks.get(task.id);
      group.tasks.set(task.id, { ...task, steers: already?.steers ?? steers, steersKnown: already?.steersKnown ?? known });
    }
    // What became of the merges is a fact about a pull request, not about
    // a task - a session can hold a task record whose state says `done`
    // over a merge that was reverted - so the two aftermath columns are
    // counted over the pull requests themselves, deduplicated by id.
    for (const pull of pullsOf(session, pulls)) group.pulls.set(pull.id, pull);
    group.lines += friction(session).lines;
    group.wrote.push(session);
    group.steers += steers;
    if (steeringVisibleOf(session)) group.visible += 1;
    if (known) group.counted += 1;
    group.cost += session.counts?.cost ?? 0;
    group.score += score(session, pulls, { tasks, now });
  }

  const rows = [...groups.values()].map((group) => {
    const own = [...group.tasks.values()];
    const finished = own.filter((task) => task.verdict === "done");
    const aftermath = aftermathOf([...group.pulls.values()]);
    // Landed with nobody coming back to it: no follow-up, no cut short, no
    // round of review, no retry. The figure a team watches when it wants to
    // know whether the tool is getting better rather than whether the
    // people around it are working harder.
    //
    // Only over the finished tasks whose steering was counted. A nought
    // nobody counted is not a nought (`steeringKnownOf`), and counting
    // those in would hand a perfect score to every record older than the
    // counter - which is what this row did until it was fixed.
    const knownFinished = finished.filter((task) => task.steersKnown);
    const oneShot = knownFinished.filter((task) => (task.steers ?? 0) === 0).length;
    // What the row wrote, and how much of it a reviewer kept. Pooled over
    // the row's sessions, and counted only over the ones whose harness said
    // - `linesMeasured` is how many those were, so a column drawn from two
    // sessions out of nine can say so instead of reading as the row.
    const wrote = acceptanceOfAll(group.wrote);
    return {
      key: group.key,
      name: group.name,
      kind: group.kind,
      sessions: group.sessions,
      live: group.live,
      tasks: own.length,
      finished: finished.length,
      unfinished: own.filter((task) => task.verdict === "undone").length,
      rate: ratio(finished.length, own.length),
      rounds: median(finished.map((task) => task.rounds)),
      lines: group.lines,
      steers: group.steers,
      oneShot,
      // How many finished tasks the rate stands on - nought means the row
      // has finished work whose steering nobody counted, and the page says
      // "not measured" rather than drawing a share of nothing.
      oneShotKnown: knownFinished.length,
      oneShotRate: ratio(oneShot, knownFinished.length),
      // False only when nothing on this row could be seen being steered -
      // one external agent among five sessions does not make the row's
      // count meaningless, it makes it a little low, and the caveat under
      // the table says so.
      steeringVisible: group.visible > 0,
      // And false when nothing on it was ever counted (`steeringKnownOf`).
      // `steers` is a total, and a total of noughts nobody counted reads
      // as "never needed a word" exactly as a rate of them does, so the
      // column says "not measured" there too. Same rule as `visible`: one
      // uncounted session among five makes the total a little low, not
      // meaningless.
      steeringKnown: group.counted > 0,
      steeringCounted: group.counted,
      // Per task taken, not per task finished. Per-finished said what the
      // ones that landed cost and charged the failures to nobody, so an
      // agent that abandoned nine of ten looked cheap.
      linesPerTask: ratio(group.lines, own.length),
      // Code written, code kept through review, and the share - `written`
      // and not `lines`, which on this row has always meant lines a person
      // typed at the agent.
      written: wrote.linesAdded,
      reviewed: wrote.reviewed,
      accepted: wrote.accepted,
      acceptance: wrote.acceptance,
      linesMeasured: wrote.measured,
      linesUnmeasured: wrote.unmeasured,
      // Of those, the ones recorded before the count existed rather than by
      // a harness that cannot report lines - a different apology.
      linesPredate: wrote.predates,
      linesReviewed: wrote.merged,
      // Null, not nought, when no session on the row could be counted: the
      // same rule "kept through review" already keeps. Nought lines per
      // task is the best possible score on a figure nobody can read, and a
      // row of unmeasured sessions would win it.
      writtenPerFinished: wrote.measured > 0 ? ratio(wrote.linesAdded, finished.length) : null,
      cost: group.cost,
      costPerTask: ratio(group.cost, own.length),
      // What became of what landed: how many merges came apart afterwards,
      // out of how many landed at all, and the median share of a merge's
      // added lines still there thirty days on.
      ...aftermath,
      score: Math.round(group.score * 1000) / 1000,
      lastAt: group.lastAt,
      effective: false,
      ...(group.facets ?? {}),
    };
  });

  const medianRate = median(rows.map((row) => row.rate).filter((rate) => rate != null));
  for (const row of rows) {
    row.effective = row.finished >= 1 && row.rate != null && row.rate >= (medianRate ?? 0);
  }
  rows.sort(
    (a, b) =>
      b.score - a.score ||
      b.finished - a.finished ||
      (b.rate ?? -1) - (a.rate ?? -1) ||
      b.sessions - a.sessions ||
      a.name.localeCompare(b.name),
  );
  return { rows, by, range, since, medianRate };
}

// ------------------------------------------------------------ over time
//
// The comparison and the ranking are totals over the range; this is the
// range as a line. "Spent $40 this week" and "spent $2 a day until
// Thursday, then $30" are different weeks, and a person deciding whether
// a change worked wants to see the day it happened. And the line splits:
// one per model provider, model, harness, sandbox, person or executor,
// overlaid, so "is Codex getting cheaper than Claude Code here" is read
// off two lines rather than two totals.

const HOUR = 60 * 60 * 1000;

/** The metrics a trend can show, in the order the page offers them. */
export const TREND_METRICS = ["cost", "tokens", "finished", "sessions", "steers", "lines"];

/** What the line can be split by, in the order the page offers them. */
export const TREND_SPLITS = ["provider", "model", "harness", "sandbox", "user", "executor"];

/**
 * How many lines a split draws. Past this the smallest groups fold into
 * "Other": a seventh hue is one no palette keeps apart, and a chart of
 * twelve lines is a chart of none.
 */
export const TREND_SERIES_MAX = 6;

/**
 * The key every dimension gives work whose session did not say which
 * option it was: no model reported, no machine, no owner. It is not an
 * option anybody chose, so neither the comparison nor the trend draws it
 * (see `compare`); what it held comes back beside them, as `unreported`,
 * so nothing is lost that the page cannot say.
 */
export const UNREPORTED = "unknown";

/** A session's group for a split: the comparison's dimensions, plus its model by name and its executor. */
function splitOf(session, split, { harnessLabel } = {}) {
  if (split === "model") {
    const model = mainModelOf(session);
    return model ? { key: `model:${model}`, name: model } : { key: UNREPORTED, name: "Not reported" };
  }
  if (split === "executor") {
    const { key, name } = keyOf(session, "agents");
    return { key, name };
  }
  return groupOf(session, split, { harnessLabel });
}

// `lines` here is code written, not the lines a person said - the trend
// has never had the second and the page names this one "Lines written".
const blankPoint = (at) => ({ at, sessions: 0, finished: 0, taken: 0, cost: 0, tokens: 0, steers: 0, lines: 0 });

/**
 * The range as points in time, one per hour over a day and one per day
 * otherwise, each with what the sessions of that period came to: how many
 * started, what they spent and used, how many pull requests they opened,
 * and how many tasks closed *then* - a task counts as done on the period
 * its pull request merged in, when the store's record has the time, and on
 * the period it started in when it does not. Spend and tokens sit on the
 * period the session started in: a session's counts are not dated finer
 * than that. Every period in the range is present, at zero when empty, so
 * a gap on the line is a quiet day and not a missing one. Periods are UTC-
 * aligned and carried as milliseconds; the page labels them in the
 * reader's own time.
 *
 * `splits` is the same line once per group of each split, every group
 * over the same periods, most sessions first, the tail past
 * TREND_SERIES_MAX folded into "Other" - one fixed order whatever metric
 * the page shows, so a group keeps its colour when the metric changes.
 *
 * Only sessions started inside the range are read (that is all the route
 * loads), so a task begun before the range and closed inside it is not on
 * the line. Said in the panel's caveat.
 */
export function trend(sessions, pulls = [], { range = DEFAULT_RANGE, now = Date.now(), harnessLabel, tasks = [] } = {}) {
  const span = RANGES[range] ?? RANGES[DEFAULT_RANGE];
  const since = now - span;
  const step = range === "24h" ? HOUR : DAY;
  const startOf = (ms) => Math.floor(ms / step) * step;
  const periods = [];
  for (let at = startOf(since); at <= now; at += step) periods.push(at);

  // Every session's contribution, worked out once: which period each
  // count lands on. Then the total line and every split's lines are the
  // same folding over a different key.
  const counted = new Set();
  const shares = [];
  for (const session of sessions) {
    if (!session || (session.startedAt ?? 0) < since) continue;
    const at = startOf(session.startedAt);
    if (at < periods[0] || at > periods[periods.length - 1]) continue;
    const worked = tasksWorked(session, pulls, tasks);
    let taken = 0;
    for (const task of worked) {
      if (counted.has(task.id)) continue;
      counted.add(task.id);
      taken += 1;
    }
    let finishedAt = null;
    if (worked.some((task) => task.verdict === "done")) {
      // On the period it landed in, not the one the session started in -
      // a task begun on Monday and finished on Friday is Friday's.
      const landed = worked.map((task) => task.doneAt).filter((when) => when != null);
      const when = landed.length ? startOf(Math.min(...landed)) : null;
      finishedAt = when != null && when >= periods[0] && when <= periods[periods.length - 1] ? when : at;
    }
    shares.push({ session, at, cost: session.counts?.cost ?? 0, tokens: session.counts?.tokens ?? 0, steers: steersOf(session), lines: editsOf(session).linesAdded, taken, finishedAt });
  }

  const fold = (own) => {
    const points = new Map(periods.map((at) => [at, blankPoint(at)]));
    for (const share of own) {
      const point = points.get(share.at);
      point.sessions += 1;
      point.cost += share.cost;
      point.tokens += share.tokens;
      point.steers += share.steers;
      point.lines += share.lines;
      point.taken += share.taken;
      if (share.finishedAt != null) points.get(share.finishedAt).finished += 1;
    }
    const list = [...points.values()];
    const totals = { sessions: 0, finished: 0, taken: 0, cost: 0, tokens: 0, steers: 0, lines: 0 };
    for (const point of list) for (const key of Object.keys(totals)) totals[key] += point[key];
    return { points: list, totals };
  };

  const splits = {};
  const unreported = {};
  for (const split of TREND_SPLITS) {
    const groups = new Map();
    for (const share of shares) {
      const { key, name } = splitOf(share.session, split, { harnessLabel });
      let group = groups.get(key);
      if (!group) groups.set(key, (group = { key, name, shares: [] }));
      group.shares.push(share);
    }
    // The work that did not say is not a line: it is dropped here, before
    // the order and the fold, so the six hues go to six real groups rather
    // than five and a grey one. What went with it is carried in
    // `unreported`, totalled the way a line is, so the panel can say how
    // many sessions are off the chart and the lines plus that still add
    // up to the whole.
    const missing = groups.get(UNREPORTED);
    groups.delete(UNREPORTED);
    unreported[split] = missing ? fold(missing.shares).totals : null;
    // Most sessions first, then by name.
    const ordered = [...groups.values()].sort((a, b) => b.shares.length - a.shares.length || a.name.localeCompare(b.name));
    const kept = ordered.length > TREND_SERIES_MAX ? ordered.slice(0, TREND_SERIES_MAX - 1) : ordered;
    const rest = ordered.slice(kept.length);
    const series = kept.map((group) => ({ key: group.key, name: group.name, ...fold(group.shares) }));
    if (rest.length) {
      series.push({ key: "other", name: `Other (${rest.length})`, folded: rest.map((group) => group.name), ...fold(rest.flatMap((group) => group.shares)) });
    }
    splits[split] = series;
  }

  return { range, since, step: step === HOUR ? "hour" : "day", ...fold(shares), splits, unreported };
}

// ------------------------------------------------------------ comparing

/**
 * What a session can be compared by. Not who did the work - that is the
 * ranking above - but what it was done *with*: which vendor's models, which
 * harness, where it ran, whose it was. The question is "which of these
 * options works best here", and a person choosing between Claude Code on a
 * laptop and the loop in a sandbox wants the same figures for each side of
 * that choice, over everything, not a row per agent.
 */
export const DIMENSIONS = ["provider", "harness", "sandbox", "user", "work"];

/**
 * Which group a session falls in, for a dimension: a key and a name.
 *
 * A session is nearly always on one model, so its provider is that of the
 * model it spent most of its tokens on (sessions.js `mainModelOf` - not the
 * first one to answer, which on Claude Code is a Haiku call of the
 * harness's own); one that called two vendors is counted with the heavier,
 * once, rather than twice. A harness session that reported no model at
 * all - a hook that sends tool events and nothing about the model calls
 * behind them - is `UNREPORTED`, which the charts leave out: it is work
 * nobody chose to do that way, and a grey bar for it crowded out the
 * options the reader is actually choosing between. Leaving it out is not
 * the same as pretending it is not there, so the count comes back beside
 * the rows and the page says how much of the range the bars stand on.
 * Where a session ran is what its start hook said (`machine.host`: a
 * laptop, an e2b sandbox) - `sandbox` because that is the choice a person
 * makes, and a laptop is the answer "none".
 */
export function groupOf(session, dimension, { harnessLabel = (kind) => kind } = {}) {
  switch (dimension) {
    case "provider": {
      const model = mainModelOf(session);
      const provider = model ? providerOf(model) : null;
      if (provider) return { key: provider.id, name: provider.label };
      return model ? { key: `model:${model}`, name: model } : { key: UNREPORTED, name: "Not reported" };
    }
    case "harness": {
      const kind = harnessKindOf(session);
      return { key: kind ?? UNREPORTED, name: kind ? harnessLabel(kind) : "Not reported" };
    }
    case "sandbox": {
      const host = session.machine?.host ?? null;
      return host ? { key: host, name: hostLabel(host) } : { key: UNREPORTED, name: "Not reported" };
    }
    case "user":
      return { key: session.owner ?? UNREPORTED, name: session.owner ?? "Not reported" };
    // What kind of work it was, in the agent's own word (work-kinds.js). A
    // session whose agent never said is `unreported` like any other
    // dimension's remainder, and the page draws that row as "Unsaid" -
    // the one dimension where the remainder is drawn, because "how many
    // never said" is itself the figure a person acts on.
    case "work": {
      // Only a word on the list is a kind: noteWork refuses the rest at
      // the record, and a stray string that got there some other way is
      // read as unsaid rather than drawn as a row nobody planned for.
      const work = workOf(session);
      return work && WORK_WORDS.includes(work) ? { key: work, name: WORK_LABEL[work] } : { key: UNREPORTED, name: WORK_LABEL[WORK_UNSAID] };
    }
    default:
      throw new Error(`Not a dimension: ${dimension}`);
  }
}

/** A machine host as a chart labels it. The hook's word for it, tidied. */
export function hostLabel(host) {
  if (host === "laptop") return "Laptop";
  if (host === "e2b") return "e2b sandbox";
  if (host === "fly") return "Fly sandbox";
  return host;
}

const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

/**
 * How many times a person had to step in: a line said to the agent, a
 * follow-up, a round of review. Not the friction score - that weights
 * these and adds the tool failures the agent recovered from by itself.
 * This is a count of the times somebody had to look up.
 */
export function interventionsOf(session) {
  const guidance = guidanceOf(session);
  // A cut short and a retried task are stepping in as surely as a line is,
  // and leaving them out flattered every option whose failures were the
  // sort a person had to abort rather than the sort they had to argue with.
  return guidance.humanLines + guidance.followUps + guidance.reviewRounds + guidance.interrupts + guidance.retries;
}

/**
 * The figures for each group of one dimension: tokens a task took, what a
 * task cost, how many tasks finished, how long a finished one took, how
 * many of them finished with nobody coming back, how many interventions a
 * finished one needed, what the steering was made of, and how the clock
 * split between the agent working and the agent waiting on somebody. A
 * task is a piece of work with a verdict and it finished when that verdict
 * says so - `tasksWorked`
 * above, and the essay at the top for why it is no longer "the pull
 * request merged". Per task rather than in total, so a vendor that did
 * three tasks and one that did thirty stand on the same chart - the totals
 * are on the rows too, for whoever wants them.
 *
 * Time to finish is from the session's start to the moment it landed, the
 * median across the finished tasks whose finishing time is known (a task
 * record and the store's pull record both have one; a session's own
 * summary of a pull request does not). Interventions are the mean across
 * the sessions that finished something - the cost of getting one over the
 * line, which is different from the steering an abandoned one took.
 *
 * Rows come back in one fixed order - most tasks first - whatever the
 * figure, so a group is on the same line of every chart.
 */
export function compare(sessions, pulls = [], { dimension = "provider", range = DEFAULT_RANGE, now = Date.now(), harnessLabel, tasks = [] } = {}) {
  const since = now - (RANGES[range] ?? RANGES[DEFAULT_RANGE]);
  const groups = new Map();
  for (const session of sessions) {
    if (!session || (session.startedAt ?? 0) < since) continue;
    const { key, name } = groupOf(session, dimension, { harnessLabel });
    let group = groups.get(key);
    if (!group) {
      group = {
        key, name, sessions: 0, tasks: new Map(), pulls: new Map(), tokens: 0, cost: 0, closures: [], interventions: [], yields: [],
        // The steering half: how many sessions fell in each bucket, what
        // kind each steer was, and the two clocks. Buckets rather than a
        // mean because the shape is the answer - "mostly nought with a
        // long tail" and "everything twice" have the same average and are
        // not the same option to work with.
        buckets: Object.fromEntries(STEER_BUCKETS.map((bucket) => [bucket, 0])),
        kinds: Object.fromEntries([...STEER_KINDS, "unclassified"].map((kind) => [kind, 0])),
        agentMs: [],
        personMs: [],
        visible: 0,
        // The sessions themselves, for the two code figures: how much of
        // what this option wrote a reviewer kept, and how much it wrote to
        // finish a task with.
        wrote: [],
      };
      groups.set(key, group);
    }
    group.sessions += 1;
    group.wrote.push(session);
    group.yields.push(yieldOf(session, pulls, tasks, { now }));
    for (const pull of pullsOf(session, pulls)) group.pulls.set(pull.id, pull);
    group.tokens += session.counts?.tokens ?? 0;
    group.cost += session.counts?.cost ?? 0;
    const own = autonomyFigures(session);
    if (own.visible) {
      group.visible += 1;
      // A session whose steering was never counted is not a session with
      // nought steers; it goes in its own bucket rather than swelling the
      // one the reader reads as "needed no help".
      group.buckets[own.known ? steerBucketOf(own.steers) : "unknown"] += 1;
      for (const [kind, count] of Object.entries(own.kinds)) {
        if (kind in group.kinds) group.kinds[kind] += Number(count) || 0;
      }
      group.kinds.unclassified += own.unclassified;
    }
    if (own.agentMs > 0) group.agentMs.push(own.agentMs);
    if (own.personMs > 0) group.personMs.push(own.personMs);
    for (const task of tasksWorked(session, pulls, tasks)) {
      // First session wins the task, so two sessions on one task do not
      // make it two - and the time it took is measured from that one.
      if (group.tasks.has(task.id)) continue;
      group.tasks.set(task.id, { ...task, steers: own.steers, steersKnown: own.known });
      if (task.verdict !== "done") continue;
      if (task.doneAt != null && session.startedAt != null) {
        group.closures.push(Math.max(0, task.doneAt - session.startedAt));
      }
    }
    if (verdictOf(session, pulls, tasks) === "done") group.interventions.push(interventionsOf(session));
  }
  const rowOf = (group) => {
    const own = [...group.tasks.values()];
    const done = own.filter((task) => task.verdict === "done");
    const finished = done.length;
    // Only the finished tasks whose steering was counted at all - see
    // `steeringKnownOf`. An option made entirely of records older than the
    // counter has no first-time rate, not a perfect one.
    const knownDone = done.filter((task) => task.steersKnown);
    const oneShot = knownDone.filter((task) => (task.steers ?? 0) === 0).length;
    const wrote = acceptanceOfAll(group.wrote);
    return {
      key: group.key,
      name: group.name,
      sessions: group.sessions,
      tasks: own.length,
      finished,
      closureRate: ratio(finished, own.length),
      oneShot,
      oneShotKnown: knownDone.length,
      oneShotRate: ratio(oneShot, knownDone.length),
      steerBuckets: group.buckets,
      steerKinds: group.kinds,
      // The medians rather than the totals: an option somebody ran fifty
      // sessions on would otherwise beat one they ran five on by having
      // been used, which is not a fact about the option.
      agentMs: median(group.agentMs),
      personMs: median(group.personMs),
      steeringVisible: group.visible > 0,
      tokens: group.tokens,
      tokensPerTask: ratio(group.tokens, own.length),
      // Two figures about the code itself: how much of what this option
      // wrote survived review (higher is better), and how many lines it
      // took to finish a task with (neither high nor low is good on its
      // own - it is the shape of the option, and it is read beside the
      // rate). `linesMeasured` says how many of the group's sessions could
      // be counted at all.
      written: wrote.linesAdded,
      reviewed: wrote.reviewed,
      accepted: wrote.accepted,
      acceptance: wrote.acceptance,
      linesMeasured: wrote.measured,
      linesUnmeasured: wrote.unmeasured,
      // Of those, the ones recorded before the count existed rather than by
      // a harness that cannot report lines - a different apology.
      linesPredate: wrote.predates,
      linesReviewed: wrote.merged,
      // Null and not nought when nothing here could be counted - the rule
      // `acceptance` above already keeps, and for the same reason.
      writtenPerFinished: wrote.measured > 0 ? ratio(wrote.linesAdded, finished) : null,
      cost: group.cost,
      costPerTask: ratio(group.cost, own.length),
      timeToClosure: median(group.closures),
      timed: group.closures.length,
      interventions: mean(group.interventions),
      // Two more figures for the same choice: of what this option landed,
      // how much came apart afterwards (lower is better), and how much of
      // what it wrote was still there a month later (higher is better).
      ...aftermathOf([...group.pulls.values()]),
      // And the range's sessions by what each came to, so a group can be
      // read as "of everything run this way, this much bought nothing".
      yield: Object.fromEntries(YIELDS.map((word) => [word, group.yields.filter((each) => each === word).length])),
      waste: group.yields.filter((word) => WASTED.has(word)).length,
    };
  };
  // What did not say is not one of the options: it comes back as a row
  // like the rest, under `unreported` rather than in `rows`, so the page
  // can say how much of the range is off the chart without drawing it -
  // and so rows plus unreported still cover every task in the range.
  const missing = groups.get(UNREPORTED);
  groups.delete(UNREPORTED);
  const rows = [...groups.values()]
    .map(rowOf)
    // Most tasks first, then by name.
    .sort((a, b) => b.tasks - a.tasks || a.name.localeCompare(b.name));
  return { dimension, range, since, rows, unreported: missing ? rowOf(missing) : null };
}

/**
 * Every dimension at once, for one range - what the page asks for, since
 * it switches between them without another request.
 */
export function compareAll(sessions, pulls = [], options = {}) {
  const dimensions = {};
  const unreported = {};
  for (const dimension of DIMENSIONS) {
    const compared = compare(sessions, pulls, { ...options, dimension });
    dimensions[dimension] = compared.rows;
    unreported[dimension] = compared.unreported;
  }
  const since = options.now ?? Date.now();
  const inRange = sessions.filter((session) => session && (session.startedAt ?? 0) >= since - (RANGES[options.range] ?? RANGES[DEFAULT_RANGE]));
  // The range's own totals, over the tasks themselves rather than over the
  // sessions - one task two sessions worked on is one task here too.
  const seen = new Map();
  for (const session of inRange) {
    for (const task of tasksWorked(session, pulls, options.tasks ?? [])) {
      if (!seen.has(task.id)) seen.set(task.id, task);
    }
  }
  const every = [...seen.values()];
  // And the range as a whole, by what each session came to. The tile on
  // the Performance page reads "spent on work that never landed" off
  // `waste`: the money of the sessions whose yield is closed, discarded
  // or reverted, against the money of all of them. Money and not sessions,
  // because a page about cost should say the cost.
  const now = options.now ?? Date.now();
  const counted = yields(inRange, pulls, { tasks: options.tasks ?? [], now });
  let waste = 0;
  let spend = 0;
  for (const session of inRange) {
    const cost = session.counts?.cost ?? 0;
    spend += cost;
    if (WASTED.has(yieldOf(session, pulls, options.tasks ?? [], { now }))) waste += cost;
  }
  return {
    range: options.range ?? DEFAULT_RANGE,
    sessions: inRange.length,
    tasks: every.length,
    finished: every.filter((task) => task.verdict === "done").length,
    yield: counted,
    waste,
    spend,
    aftermath: aftermathOf([...new Map(inRange.flatMap((session) => pullsOf(session, pulls).map((pull) => [pull.id, pull]))).values()]),
    dimensions,
    unreported,
  };
}
