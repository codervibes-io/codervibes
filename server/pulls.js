// Pull requests: the outcome the product measures, kept where it can be read.
//
// A session is what an agent did; a pull request is what came of it, judged
// by the people who own the repository. GitHub is the record of that - it
// knows a pull request was opened, reviewed, and merged - and it tells this
// process by webhook, or is asked (pull-poll.js) about the ones an agent
// said it opened. What is kept here is a fold of those deliveries into
// one record per pull request, linked back to the session and the agent that
// made it, so an Activity page can say "this session's work was merged" and
// a Performance page can count how often that happened.
//
// The link between a pull request and its session is the branch name. A
// branch pushed from here is called `cv/<repoId>/<sessionShort>`, so the
// pull request GitHub reports on it names the repo and the session
// without this process having to remember anything between the push and the
// webhook - which may be seconds or, when the process restarted in between,
// a different process. A pull request on any other branch is kept too, as a
// human's; it still counts for the repository.
//
// Nothing an agent wrote is kept: the title (which the agent chose, and which
// is public on GitHub anyway), the branch names, who reviewed it and how.
// Not the body, not the comments' text, not the diff.
import { store } from "./store/index.js";
import * as sessionLog from "./sessions.js";
import { withSpan } from "./telemetry.js";
// ---- pull-cost ----
import { note as noteCostFields } from "./pull-cost-fold.js";
// ---- end pull-cost ----

/**
 * Which external agent a GitHub login is, when the installation runs any.
 *
 * Said by the registry rather than asked of it: external-agents/index.js
 * calls this on the way in, so an installation that runs any external
 * agents has the answer the moment the module is loaded. This file - which
 * every page that counts a merge reads - needs none of the vendors' clients
 * to fold a webhook, and an installation with no external agents leaves it
 * as it is: every author is a person or one of this installation's own.
 */
let externalByLogin = () => null;

/** Hand this file the external-agent registry. Called once, by external-agents/index.js. */
export function useExternalByLogin(fn) {
  externalByLogin = fn ?? (() => null);
}

const MAX_REVIEWS = 200;
const MAX_SESSIONS = 20;
const MAX_TASKS = 20;
const MAX_FOLLOW_UPS = 20;
/** How long after a merge a pull request naming it is still a follow-up to it. */
export const FOLLOW_UP_MS = 30 * 24 * 60 * 60_000;
/** How far back `relate` looks for the pull requests one might be about. */
const RELATED_WINDOW_MS = 120 * 24 * 60 * 60_000;

/** The branch a repo's work is pushed to (github-repo.js branchFor). */
export const BRANCH = /^cv\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/;
/** The name before sessions existed: the repo alone. */
const LEGACY_BRANCH = /^codervibes\/([a-z0-9-]+)$/;

/** Which repo and session a head ref names, if it is one of ours. */
export function parseBranch(headRef) {
  const ours = BRANCH.exec(String(headRef ?? ""));
  // The tail is a session's last eight hex digits, or a word ("work") when
  // nothing was in session - then the repo is all the branch says.
  if (ours) return { repoId: ours[1], sessionShort: /^[0-9a-f]{8}$/.test(ours[2]) ? ours[2] : null };
  const legacy = LEGACY_BRANCH.exec(String(headRef ?? ""));
  if (legacy) return { repoId: legacy[1], sessionShort: null };
  return null;
}

/**
 * A record's id, which is what a person would write down.
 *
 * `ada/engine#12` on GitHub, exactly as it always was: a prefix on every
 * record would rename every one already stored, and GitHub is what every
 * record written before there were three hosts is. The other two say which
 * they are, and say it the way their host writes it - GitLab numbers a
 * merge request `!7`, and quoting it as `#7` would be a number a person
 * cannot paste back anywhere.
 */
export const idOf = (repo, number, host = "github") => {
  if (host === "gitlab") return `gitlab:${repo}!${number}`;
  if (!host || host === "github") return `${repo}#${number}`;
  return `${host}:${repo}#${number}`;
};

/**
 * An empty record; the folds fill it.
 *
 * `agentId` and `repoId` come from the push that made the branch, or
 * from the branch name when nothing remembered the push.
 */
function blank(repo, number, host = "github") {
  return {
    id: idOf(repo, number, host),
    kind: "pull",
    // Which of the three hosts this is on (git-hosts/index.js). Absent on
    // every record written before there was a choice, and those are
    // GitHub's - so the default is read rather than backfilled.
    host,
    repo,
    number: Number(number),
    title: null,
    url: null,
    headRef: null,
    baseRef: null,
    // The commit the merge left on the base branch. GitHub sends it and we
    // used to drop it; it is the handle a revert pushed by hand names
    // ("This reverts commit <sha>") and the only way such a revert can be
    // tied back to the pull request it undid.
    mergeCommitSha: null,
    // The pull request numbers this one's title and body name, and the one
    // it says it reverts. Numbers, never the words around them
    // (repo-sources/github.js `mentionsIn`): a reference is an id.
    mentions: [],
    reverts: null,
    author: { login: null, bot: false },
    draft: false,
    openedAt: null,
    updatedAt: Date.now(),
    mergedAt: null,
    closedAt: null,
    state: "open",
    reviews: [],
    comments: 0,
    sessionIds: [],
    // When an agent last said this was ready for a person: noted as opened
    // (noteOpened), or named as a task's outcome (noteTask). A linked
    // session working again *after* this - a new turn, from a prompt - is
    // the pull request being worked on, and it leaves Needs action until
    // the turn ends (index.js /api/home). Null on a record made only from
    // webhooks, which stands for "since it opened".
    readyAt: null,
    // The tasks whose work this is: the one the pushing agent held when it
    // pushed, and any an agent named afterwards (update_task 'pull'). A task
    // is the plan's unit and a pull request is the world's, and the Tasks
    // tab reads them together - see agent-tasks.js "Outcomes".
    taskIds: [],
    agentId: null,
    repoId: null,
    externalAgentId: null,
    // What became of it after it merged - see the essay above `relate`.
    // Null throughout on a pull request nothing has happened to since.
    reverted: null,
    followUps: [],
    brokeBuild: null,
    shipped: null,
    // And out of production again: an app this merge shipped to was put
    // back on an older image through the Fly connector (`noteRolledBack`).
    rolledBack: null,
    durability: null,
    // ---- pull-cost ----
    // What it cost and what kind of work it was (pull-cost-fold.js), worked
    // out when it folds so that no page read has to. `cost` is null where
    // the sessions' spans are gone, which is not nought - see the essay
    // there. `workKind` is settled once and left alone.
    cost: null,
    workKind: null,
    workKindFrom: null,
    // ---- end pull-cost ----
    // How big it is, and how it grew while it was open: `{additions,
    // deletions, changedFiles, history: [{at, additions, deletions}]}`.
    // GitHub sends the three numbers on every pull_request delivery and
    // this used to drop them. Counts, not a diff - what changed in those
    // lines is GitHub's to show.
    diff: null,
    // Who wrote the lines it merged (pull-aftermath.js `heardMerge`):
    // `{added, agent, share, sessions: [{id, matched}], measured,
    // unmeasured, by}`. Counts and session ids.
    attribution: null,
  };
}

// ----------------------------------------------------------- the listeners

/**
 * Who hears when a pull request changes. A task waiting on a review of it
 * is brought back this way (task-waits.js); the console is told through
 * events.js by the webhook route. Listeners, not an import: the task
 * modules import this one, and a fold that reaches into them would go round.
 */
const listeners = new Set();

/** Hear every change to a pull request as `{pull, event}`. Returns the un-listen. */
export function onChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function tellListeners(pull, event) {
  for (const fn of listeners) {
    try {
      await fn({ pull, event });
    } catch (err) {
      console.warn(`pulls: a listener failed on ${pull.id}: ${err.message}`);
    }
  }
}

// ------------------------------------------------------------- the memory

/** The last few hundred, for the card counts that cannot wait on the store. */
const recent = new Map(); // id -> record
const MAX_RECENT = 500;

function remember(record) {
  recent.delete(record.id);
  recent.set(record.id, record);
  if (recent.size > MAX_RECENT) recent.delete(recent.keys().next().value);
}

async function load(repo, number, host = "github") {
  const id = idOf(repo, number, host);
  const known = recent.get(id);
  if (known) return known;
  // The id and the host as well as the pair: a GitLab record and a GitHub
  // one can be the same repository path and the same number, and neither
  // backend can key by the pair alone. The json store writes under the
  // record's own id; the dynamo one puts the host in front of the
  // partition key (dynamo-store.js `keyedRepo`).
  const stored = store.loadPull ? await store.loadPull(repo, Number(number), id, host) : null;
  if (stored) remember(stored);
  return stored;
}

async function save(record) {
  record.updatedAt = Math.max(record.updatedAt ?? 0, Date.now());
  remember(record);
  if (store.putPull) await store.putPull(structuredClone(record));
  return record;
}

// ------------------------------------------------------------- the session

/**
 * The month of sessions the store holds, read at most once every few
 * minutes and shared by everything below.
 *
 * Both lookups here fall through to the store when memory does not have
 * the session, and the store read is five paged queries for up to two
 * thousand records. That was a rare cost when the only records folded were
 * this installation's own; the repository sweep (pull-poll.js) folds fifty
 * pull requests of a repository at a time, most of them people's, and each
 * of those found nothing in memory and went to the store for it - fifty
 * reads a quarter of an hour per repository, all of them the same answer.
 *
 * A stale answer costs nothing: a session that has just started is in
 * memory, which is checked first, and the store's copy is what matters
 * only after a restart. The promise is shared rather than the result, so
 * fifty folds in one sweep wait on one read rather than starting fifty.
 */
const SESSIONS_TTL_MS = 5 * 60_000;
const SESSIONS_WINDOW_MS = 30 * 24 * 60 * 60_000;
let sessionsRead = { at: 0, promise: null };

function storedSessions() {
  if (!store.loadSessions) return Promise.resolve([]);
  const now = Date.now();
  if (!sessionsRead.promise || now - sessionsRead.at > SESSIONS_TTL_MS) {
    sessionsRead = { at: now, promise: store.loadSessions({ since: now - SESSIONS_WINDOW_MS, limit: 2000 }).catch(() => []) };
  }
  return sessionsRead.promise;
}

/**
 * The session a branch's short id names. Memory first - the session is
 * usually live when its pull request opens - then the store, which is the
 * case after a restart.
 */
async function sessionByShort(sessionShort, repoId) {
  if (!sessionShort) return null;
  const matches = (record) => record.id.endsWith(sessionShort) && (!repoId || record.repoId === repoId);
  const live = sessionLog.inMemory().find(matches);
  if (live) return live;
  return (await storedSessions()).find(matches) ?? null;
}

/**
 * The session that said it was on this branch of this repository - a
 * harness on somebody's laptop, whose branch is whatever the person named
 * it (`POST /api/harness/session`). The most recent one, when several were.
 */
async function sessionOnBranch(repo, branch, host = "github") {
  if (!repo || !branch) return null;
  // The host as well as the path: `ada/engine` on GitHub and `ada/engine`
  // on GitLab are two repositories, and a session in one must not be linked
  // to a pull request in the other. A session recorded before sessions said
  // which host they were on is GitHub's, the same way a record is.
  const matches = (record) =>
    record.repo?.fullName === repo && (record.repo?.host ?? "github") === host && record.branch === branch;
  const newest = (list) => list.filter(matches).sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
  const live = newest(sessionLog.inMemory());
  if (live) return live;
  return newest(await storedSessions());
}

/** Note a task the pull request is the outcome of. Says whether that was new. */
function linkTask(record, taskId) {
  if (!taskId) return false;
  record.taskIds ??= [];
  if (record.taskIds.includes(taskId) || record.taskIds.length >= MAX_TASKS) return false;
  record.taskIds.push(String(taskId));
  return true;
}

/** Link a pull request to the session that made it, and tell the session. */
async function link(record, { sessionId = null, agentId = null, repoId = null, taskId = null } = {}) {
  const parsed = parseBranch(record.headRef);
  if (!record.repoId) record.repoId = repoId ?? parsed?.repoId ?? null;
  if (!record.agentId && agentId) record.agentId = agentId;
  linkTask(record, taskId);
  let session = sessionId ? await sessionLog.get(sessionId) : null;
  if (!session && parsed?.sessionShort) session = await sessionByShort(parsed.sessionShort, record.repoId);
  if (!session && !parsed) session = await sessionOnBranch(record.repo, record.headRef, record.host ?? "github");
  if (session) {
    if (!record.sessionIds.includes(session.id) && record.sessionIds.length < MAX_SESSIONS) record.sessionIds.push(session.id);
    if (!record.agentId && session.actor?.id) record.agentId = session.actor.id;
    if (!record.repoId && session.repoId) record.repoId = session.repoId;
  }
  // A pull request opened by a vendor's bot is that external agent's work
  // (external-agents/). The bot is the author, so it is the agent, unless a
  // session here already claimed it - a resident's push that the bot
  // merely commented on is still the resident's.
  const external = record.author.login ? externalByLogin(record.author.login) : null;
  if (external) {
    record.externalAgentId = external.record.id;
    if (!record.agentId) record.agentId = external.record.id;
  }
  return session;
}

/**
 * Link a session to a pull request it did not open - an external agent's
 * run on it (external-agents/sync.js) - and tell the session where the
 * pull request stands. Makes the record when the webhook has not yet.
 */
export async function linkSession(repo, number, sessionId, { host = "github" } = {}) {
  if (!repo || !Number(number) || !sessionId) return null;
  const record = (await load(repo, number, host)) ?? blank(repo, number, host);
  if (!record.sessionIds.includes(sessionId)) {
    if (record.sessionIds.length >= MAX_SESSIONS) return record;
    record.sessionIds.push(sessionId);
    await save(record);
  }
  await tellSessions(record);
  return record;
}

/** What a session records as the outcome of a pull request in this state. */
const outcomeOf = (record) => (record.state === "merged" ? "merged" : record.state === "closed" ? "closed" : "open");

/** How many times a reviewer sent this pull request back. Each is a round the session did not get right first time. */
export const changesRequestedOn = (record) => (record.reviews ?? []).filter((review) => review.state === "changes_requested").length;

/**
 * Tell every linked session where its pull request stands. The summary is
 * what a session keeps of the pull request: enough to link to it and to
 * score it, never the reviews themselves.
 */
async function tellSessions(record) {
  const summary = {
    id: record.id,
    number: record.number,
    url: record.url,
    state: record.state,
    repo: record.repo,
    // Which host, so a session's card can say "merge request" where that
    // is the word, and link to the right place when the record has no URL.
    host: record.host ?? "github",
    openedAt: record.openedAt ?? null,
    mergedAt: record.mergedAt ?? null,
    closedAt: record.closedAt ?? null,
    changesRequested: changesRequestedOn(record),
    // What became of it after it merged, so a session can be scored on it
    // without the ranking having to load every pull record: whether it was
    // undone, how many pull requests came back to it, whether it shipped,
    // and how much of it was still there thirty days on. Counts and ids.
    reverted: record.reverted ?? null,
    followUps: (record.followUps ?? []).length,
    brokeBuild: record.brokeBuild ?? null,
    shipped: record.shipped ?? null,
    rolledBack: record.rolledBack ?? null,
    durability: record.durability ?? null,
    // How big it is and how much of it an agent wrote, so the session page
    // can say "78% agent-written" without loading the pull record - counts
    // and a share, never a line of the diff.
    diff: record.diff ? { additions: record.diff.additions ?? null, deletions: record.diff.deletions ?? null, changedFiles: record.diff.changedFiles ?? null } : null,
    attribution: record.attribution
      ? {
          added: record.attribution.added ?? null,
          agent: record.attribution.agent ?? null,
          share: record.attribution.share ?? null,
          by: record.attribution.by ?? null,
          unmeasured: record.attribution.unmeasured ?? 0,
          ...(record.attribution.gitAi ? { gitAi: record.attribution.gitAi } : {}),
        }
      : null,
  };
  for (const sessionId of record.sessionIds) {
    await sessionLog.recordOutcome(sessionId, outcomeOf(record), { pull: summary }).catch(() => null);
  }
}

// ---------------------------------------------------------------- folding

/**
 * A push from here opened (or added to) a pull request: note it before
 * GitHub's webhook arrives, under the session that pushed. The webhook fills
 * in the rest and, arriving at a process that has lost this, still finds the
 * session by the branch name.
 */
export async function noteOpened({ repoId, sessionId = null, agentId = null, taskId = null, host = "github", repo, number, url, branch, title, by = null }) {
  const record = (await load(repo, number, host)) ?? blank(repo, number, host);
  if (!record.openedAt) record.openedAt = Date.now();
  record.title = title ?? record.title;
  record.url = url ?? record.url;
  record.headRef = branch ?? record.headRef;
  if (!record.author.login && by) record.author = { login: by, bot: false };
  record.readyAt = Date.now();
  await link(record, { sessionId, agentId, repoId, taskId });
  await save(record);
  await tellSessions(record);
  return record;
}

/**
 * An agent said a pull request is what a task came to (update_task 'pull').
 * Makes the record when the webhook has not yet: the task tab then shows
 * the number, and the webhook fills in the rest when it arrives.
 */
export async function noteTask(repo, number, taskId, { repoId = null, host = "github" } = {}) {
  const record = (await load(repo, number, host)) ?? blank(repo, number, host);
  if (!record.repoId && repoId) record.repoId = repoId;
  record.readyAt = Date.now();
  linkTask(record, taskId);
  await save(record);
  return record;
}

// ---------------------------------------------------------------- how big
//
// GitHub says how many lines a pull request adds and removes on every
// `pull_request` delivery, and this used to drop all three numbers. They
// are the denominator of every acceptance figure, and their *movement* is
// the one measure of review rework there is: a pull request that was 200
// lines when it was opened and 340 when it merged had 140 lines of second
// thoughts in it, and no other record here can say that.
//
// So the numbers are kept, and while the pull request is open each change
// to them is a snapshot. Only while it is open: after the merge the diff is
// fixed, and a re-listing of it by the fifteen-minute sweep must not append
// a line saying nothing happened. The history is as often as we were told,
// which is every webhook and every sweep - a sample of the pull request's
// life, not a log of it, and the doc says so.

/** How many snapshots of an open pull request's size are kept. */
const MAX_DIFF_HISTORY = 20;

// Null, undefined and "" are "this delivery did not say" - and `Number(null)`
// is nought, which would fold a real figure away to zero on the next
// listing.
const counted = (value) => (value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));

/** Fold a delivery's size into the record, and snapshot it while the pull request is open. */
function foldDiff(record, event, { at = Date.now() } = {}) {
  const additions = counted(event.additions);
  const deletions = counted(event.deletions);
  const changedFiles = counted(event.changedFiles);
  // A listing (`pull-poll.js refreshRepo`) carries none of the three:
  // GitHub's list endpoint does not send them, and "did not say" must not
  // be folded in as nought.
  if (additions === null && deletions === null && changedFiles === null) return;
  const held = record.diff ?? { additions: null, deletions: null, changedFiles: null, history: [] };
  const moved = held.additions !== additions || held.deletions !== deletions;
  const history = Array.isArray(held.history) ? held.history : [];
  record.diff = {
    additions: additions ?? held.additions,
    deletions: deletions ?? held.deletions,
    changedFiles: changedFiles ?? held.changedFiles,
    history:
      moved && record.state === "open"
        ? [...history, { at, additions: additions ?? held.additions, deletions: deletions ?? held.deletions }].slice(-MAX_DIFF_HISTORY)
        : history,
  };
}

/**
 * Fold one normalised webhook event (repo-sources parseWebhook) into the
 * record it is about.
 *
 * @returns {Promise<{pull: object, changed: boolean}|null>} null for an event that is not about a pull request
 */
export async function apply(event) {
  if (!event?.repo || !event?.number) return null;
  // An event that does not say which host it is from is GitHub's: every
  // webhook this app has ever taken is, and so is every record already
  // stored. See `idOf`.
  const host = event.host ?? "github";
  return withSpan("pull.fold", { "cv.repo": event.repo, "cv.pr.number": event.number, "cv.pull.event": event.kind, "cv.pull.host": host }, async () => {
    const held = await load(event.repo, event.number, host);
    const record = held ?? blank(event.repo, event.number, host);
    const before = JSON.stringify(record);
    const wasMerged = record.state === "merged";

    if (event.kind === "pull") {
      record.title = event.title ?? record.title;
      record.url = event.url ?? record.url;
      record.headRef = event.headRef ?? record.headRef;
      record.baseRef = event.baseRef ?? record.baseRef;
      record.mergeCommitSha = event.mergeCommitSha ?? record.mergeCommitSha;
      if (event.mentions?.length) record.mentions = [...event.mentions];
      if (event.reverts != null) record.reverts = event.reverts;
      if (event.author?.login) record.author = { login: event.author.login, bot: Boolean(event.author.bot) };
      record.draft = Boolean(event.draft);
      if (event.openedAt) record.openedAt = event.openedAt;
      if (event.state) record.state = event.state;
      record.mergedAt = event.mergedAt ?? (event.state === "merged" ? record.mergedAt ?? Date.now() : record.mergedAt);
      record.closedAt = event.closedAt ?? (event.state !== "open" ? record.closedAt ?? Date.now() : null);
      if (event.state === "open") {
        record.mergedAt = null;
        record.closedAt = null;
      }
      foldDiff(record, event);
    } else if (event.kind === "review") {
      if (event.state && event.state !== "commented") {
        const review = { by: event.by ?? null, state: event.state, at: event.at ?? Date.now() };
        if (!record.reviews.some((entry) => entry.by === review.by && entry.state === review.state && entry.at === review.at)) {
          if (record.reviews.length < MAX_REVIEWS) record.reviews.push(review);
        }
      }
      if (event.headRef) record.headRef = record.headRef ?? event.headRef;
      if (event.url) record.url = record.url ?? event.url;
      if (event.title) record.title = record.title ?? event.title;
    } else if (event.kind === "comment") {
      record.comments += 1;
    } else {
      return null;
    }

    // Whether the delivery told us anything, worked out before the two
    // steps that go looking things up. Both of them read - `link` the
    // month of sessions, `relate` the repository's other pull requests -
    // and neither can learn anything from a re-listing of a record that
    // came back word for word the same. That was free when the only
    // records folded were our own and every fold was a real change; the
    // fifteen-minute repository sweep re-lists fifty pull requests each
    // tick, nearly all of them unchanged, and without this gate each one
    // paid for both reads to arrive at the record it already had.
    const told = held === null || JSON.stringify(record) !== before;
    const becameMerged = !wasMerged && record.state === "merged";
    if (told) await link(record);
    // And what this pull request is to the others of its repository, and
    // they to it - a revert, a fix that came back (see the essay below).
    if (event.kind === "pull" && (told || becameMerged)) await relate(record, { becameMerged });
    // ---- pull-cost ----
    // What it cost, by phase, and what kind of work it was
    // (pull-cost-fold.js). Gated the same way as the two reads above and
    // for the same reason - it reads a session's spans, which is a store
    // query per session - and again on the merge, because the review phase
    // is not finished until then. Never fatal: a pull request with no cost
    // on it shows a dash, which is the honest answer anyway.
    if (record.sessionIds.length && (told || becameMerged)) {
      await noteCost(record, { becameMerged }).catch((err) => console.warn(`pulls: could not cost ${record.id}: ${err.message}`));
    }
    // ---- end pull-cost ----
    const changed = JSON.stringify(record) !== before;
    if (changed) {
      await save(record);
      await tellSessions(record);
      await tellListeners(record, event);
    }
    return { pull: record, changed };
  });
}

// ------------------------------------------------- what became of it after
//
// "Merged" is where this record used to stop, and merged is not the end of
// the story. A merge can be reverted the next morning, need a fix behind it
// by the afternoon, break the nightly build, or sit on the default branch
// for a fortnight without ever being deployed. Each of those is the
// difference between work that landed and work that only appeared to, and
// each is written down somewhere GitHub already tells us about:
//
//   - a **revert** is a pull request whose body says "Reverts owner/repo#N"
//     (GitHub's Revert button writes that itself), or one titled
//     `Revert "<the title of a merged pull request here>"`, or a commit
//     pushed to the base branch whose message says "This reverts commit
//     <the merge commit>". All three end in `reverted`, and the third is
//     why the merge commit's sha is kept at all;
//   - a **follow-up** is a pull request opened within a month of a merge,
//     on the same repository, that names its number - the fix that came
//     back to it. The revert is not one of these;
//   - **broke the build** is a failing run of a workflow engine, and is
//     joined on in pull-aftermath.js, which is where the runs are;
//   - **shipped** is a deploy from the branch it merged into (deploys.js);
//   - **rolled back** is that deploy being undone: an app it shipped to was
//     put back on an older image through the Fly connector, and every merge
//     that went out on a release newer than the one being returned to is no
//     longer running anywhere. A revert takes the code off the branch; this
//     takes it out of production and leaves the branch alone, which is why
//     it is its own fact and not a second kind of revert.
//
// What is kept of each is a number, a sha, a time and a URL. Not the words
// of the revert, not the diff, not why anybody did it - the record's rule
// holds here as everywhere else.
//
// A relation is only looked for when one of the two sides has something to
// relate: a pull request that names numbers, or one that has just merged
// and might be named by something already held. Otherwise every fold of
// every pull request would read the repository's whole history.

/** The title a `Revert "…"` pull request says it undoes, or null. */
const titleReverted = (title) => /^revert\s+"(.+)"\s*$/i.exec(String(title ?? "").trim())?.[1] ?? null;

/** Two shas, one of which may be short, naming the same commit. */
export function sameCommit(a, b) {
  const left = String(a ?? "").toLowerCase();
  const right = String(b ?? "").toLowerCase();
  if (left.length < 7 || right.length < 7) return false;
  const shorter = Math.min(left.length, right.length);
  return left.slice(0, shorter) === right.slice(0, shorter);
}

/**
 * What `candidate` is to `original`, if anything: `"revert"`,
 * `"follow-up"`, or null. Pure, and the whole of the rule.
 *
 * A revert has to have merged to have undone anything - an open one is a
 * proposal - but it is never counted as a follow-up either, because "a fix
 * came back to this" and "this was taken out" are different facts and the
 * page says them differently.
 */
export function relationOf(candidate, original) {
  if (!candidate || !original) return null;
  if (candidate.repo !== original.repo || candidate.number === original.number) return null;
  // Two hosts can spell a repository the same way, and a revert on one has
  // undone nothing on the other.
  if ((candidate.host ?? "github") !== (original.host ?? "github")) return null;
  if (original.state !== "merged" || !original.mergedAt) return null;
  const undoes =
    (candidate.reverts != null && Number(candidate.reverts) === Number(original.number)) ||
    (Boolean(original.title) && titleReverted(candidate.title) === original.title);
  if (undoes) return candidate.state === "merged" ? "revert" : null;
  const at = candidate.openedAt ?? null;
  if (!at || at < original.mergedAt || at > original.mergedAt + FOLLOW_UP_MS) return null;
  return (candidate.mentions ?? []).map(Number).includes(Number(original.number)) ? "follow-up" : null;
}

/** Write a relation onto the original. Says whether that changed anything. */
function markRelation(original, candidate, relation) {
  if (relation === "revert") {
    if (original.reverted) return false;
    original.reverted = {
      at: candidate.mergedAt ?? candidate.closedAt ?? Date.now(),
      by: { kind: "pull", number: candidate.number, url: candidate.url ?? null },
    };
    return true;
  }
  if (relation === "follow-up") {
    original.followUps ??= [];
    if (original.followUps.some((entry) => entry.number === candidate.number)) return false;
    if (original.followUps.length >= MAX_FOLLOW_UPS) return false;
    original.followUps.push({ number: candidate.number, url: candidate.url ?? null, at: candidate.openedAt ?? Date.now() });
    return true;
  }
  return false;
}

/** Whether this record could be about another one: it names numbers, or it is titled as a revert. */
const refersToAnother = (record) => record.reverts != null || (record.mentions ?? []).length > 0 || titleReverted(record.title) != null;

/**
 * Tie this record to the others of its repository, both ways: what it
 * undoes or follows up, and - when it has just merged - what already held
 * says about it, since a sweep can meet a revert before the thing it
 * reverts. Returns whether this record itself changed; the others are
 * saved and told here.
 */
async function relate(record, { becameMerged = false } = {}) {
  if (!refersToAnother(record) && !becameMerged) return false;
  const siblings = (await list({ repo: record.repo, since: Date.now() - RELATED_WINDOW_MS, limit: 500 }).catch(() => []))
    .filter((other) => other.id !== record.id);
  let own = false;
  for (const other of siblings) {
    if (markRelation(other, record, relationOf(record, other))) {
      await save(other);
      await tellSessions(other);
      await tellListeners(other, { kind: "relation", repo: other.repo, number: other.number });
    }
    if (becameMerged && markRelation(record, other, relationOf(other, record))) own = true;
  }
  return own;
}

/**
 * Commits landed on a branch (`parseWebhook` "push"): the one thing a push
 * says that a pull request cannot, which is that somebody reverted a merge
 * by hand. A `git revert` names the commit it undoes, the merge commit is
 * on the record, and the branch pushed to must be the one the merge landed
 * on - a revert on a side branch has undone nothing yet.
 *
 * Pushes were parsed and dropped until this; nothing else here reads one.
 *
 * @returns {Promise<object[]>} the records this push marked as reverted
 */
export async function applyPush(event) {
  const commits = (event?.commits ?? []).filter((commit) => commit?.reverts);
  if (!event?.repo || !event.branch || !commits.length) return [];
  const known = await list({ repo: event.repo, since: Date.now() - RELATED_WINDOW_MS, limit: 500 }).catch(() => []);
  const marked = [];
  for (const commit of commits) {
    const original = known.find(
      (record) =>
        record.state === "merged" &&
        !record.reverted &&
        record.baseRef === event.branch &&
        sameCommit(record.mergeCommitSha, commit.reverts),
    );
    if (!original) continue;
    original.reverted = {
      at: Date.now(),
      by: { kind: "commit", sha: commit.sha ?? null, url: commit.sha ? `https://github.com/${event.repo}/commit/${commit.sha}` : null },
    };
    await save(original);
    await tellSessions(original);
    await tellListeners(original, event);
    marked.push(original);
  }
  return marked;
}

/**
 * Note what pull-aftermath.js worked out about a merge: the run it broke,
 * and how much of it was still there a month on. Written once each - a
 * pull request breaks the build once, and the thirty-day figure is a
 * measurement of one moment, not a series.
 */
export async function noteBrokeBuild(repo, number, brokeBuild) {
  const record = await load(repo, number);
  if (!record || record.brokeBuild || !brokeBuild) return null;
  record.brokeBuild = brokeBuild;
  await save(record);
  await tellSessions(record);
  await tellListeners(record, { kind: "broke-build", repo, number });
  return record;
}

/**
 * A deploy went out from a branch: every merge already on that branch when
 * the clone was taken is now in production (deploys.js `tell`).
 *
 * By the clock, not by asking GitHub whether each commit is an ancestor of
 * the deployed one. That would be a read per pull request per deploy, and
 * the answer would be the same one this arithmetic gives for everything
 * but a force-push or a merge that landed during the clone. What it can be
 * wrong about is said in docs/measures.md, which is the price of the
 * figure existing at all.
 *
 * The first deploy to carry a merge is the one recorded: shipped is when
 * it first reached production, not the last time something went out.
 *
 * @param {string} repo the repository, `owner/name`
 * @param {object} args `through` is the clone's moment; `at` is when the deploy landed
 * @returns {Promise<object[]>} the records this marked
 */
export async function noteShipped(repo, { branch, through = Date.now(), at = Date.now(), sessionId = null, app = null, release = null } = {}) {
  if (!repo || !branch) return [];
  const known = await list({ repo, since: through - RELATED_WINDOW_MS, limit: 500 }).catch(() => []);
  const marked = [];
  for (const record of known) {
    if (record.state !== "merged" || record.shipped) continue;
    if (record.baseRef !== branch || !record.mergedAt || record.mergedAt > through) continue;
    record.shipped = { at, sessionId, app, release };
    await save(record);
    await tellSessions(record);
    marked.push(record);
  }
  return marked;
}

/**
 * A release version as a number, however it was written down: `42`, `"42"`,
 * `"v42"`, or the release object itself. `shipped.release` has been all
 * three over the life of this record - Fly's own number, the string a seed
 * wrote - and a comparison that assumed one of them would silently mark
 * nothing.
 */
export function releaseVersion(value) {
  const raw = value && typeof value === "object" ? value.version : value;
  const number = Number(String(raw ?? "").trim().replace(/^v/i, ""));
  return Number.isFinite(number) && String(raw ?? "").trim() !== "" ? number : null;
}

/**
 * Whether a shipped merge went out *after* the release an app is being put
 * back on - which is to say, whether the rollback takes it out again.
 *
 * By version where both are known, because that is exactly the question.
 * Where the target release is not one of Fly's at all (an image nobody here
 * built a release from), everything shipped to the app is taken out: there
 * is no ordering to compare against and the machines are demonstrably not
 * running what we shipped. Where the *merge* does not know its release -
 * Fly did not answer when it shipped - the clock stands in, the same
 * bargain `shipped` itself makes.
 */
function takenOutBy(shipped, { through, to }) {
  if (through == null) return true;
  const version = releaseVersion(shipped?.release);
  if (version != null) return version > through;
  const back = to?.createdAt ? Date.parse(to.createdAt) : NaN;
  return Number.isFinite(back) ? (shipped?.at ?? 0) > back : true;
}

/**
 * An app was put back on an older image (connectors/fly.js `fly_roll_image`,
 * heard by deploys.js): every merge that shipped to that app on a newer
 * release is out of production again.
 *
 * By app rather than by repository, because that is what a rollback names.
 * One app can carry merges from more than one repository here, and all of
 * them went back together.
 *
 * First rollback wins, like `shipped`: the record says when a merge first
 * stopped being in production, not how many times an app has been rolled
 * since. A deploy that puts it back does not clear this - it is a fact
 * about what happened, and the next `shipped` is already spoken for.
 *
 * @param {string} app the Fly app that was rolled
 * @param {object} args `through` is the version being returned to, or null
 *   when the image matches no release; `from`/`to` are the two releases
 * @returns {Promise<object[]>} the records this marked
 */
export async function noteRolledBack(app, { through = null, at = Date.now(), by = null, sessionId = null, from = null, to = null } = {}) {
  if (!app) return [];
  const known = await list({ since: at - RELATED_WINDOW_MS, limit: 500 }).catch(() => []);
  const marked = [];
  for (const record of known) {
    if (record.state !== "merged" || !record.shipped || record.rolledBack) continue;
    if (record.shipped.app !== app) continue;
    if (!takenOutBy(record.shipped, { through, to })) continue;
    record.rolledBack = { at, app, fromRelease: from ?? null, toRelease: to ?? null, by: by ?? null, sessionId: sessionId ?? null };
    await save(record);
    await tellSessions(record);
    await tellListeners(record, { kind: "rolled-back", repo: record.repo, number: record.number });
    marked.push(record);
  }
  return marked;
}

/**
 * Who wrote the lines a merge landed (pull-aftermath.js `heardMerge`).
 *
 * The `diff` handed in is counted off the fifty files GitHub sends patches
 * for, and the delivery's own three numbers are the whole pull request, so
 * it fills what is missing rather than overwriting what GitHub said. The
 * history is left exactly as it is: it is the record of an open pull
 * request growing, and this arrives after it stopped being one.
 */
export async function noteAttribution(repo, number, { attribution = null, diff = null } = {}) {
  const record = await load(repo, number);
  if (!record || !attribution) return null;
  record.attribution = attribution;
  if (diff) {
    const held = record.diff ?? {};
    record.diff = {
      additions: held.additions ?? diff.additions ?? null,
      deletions: held.deletions ?? diff.deletions ?? null,
      changedFiles: held.changedFiles ?? diff.changedFiles ?? null,
      history: Array.isArray(held.history) ? held.history : [],
    };
  }
  await save(record);
  await tellSessions(record);
  return record;
}

export async function noteDurability(repo, number, durability) {
  const record = await load(repo, number);
  if (!record || !durability) return null;
  record.durability = durability;
  await save(record);
  await tellSessions(record);
  return record;
}

// ---- pull-cost ----

/**
 * What it cost and what kind of work it was, onto the record.
 *
 * The tracker is asked only the first time a pull request is classified,
 * and only when the merge has not already settled it: a fold on a pull
 * request that has been open for a week has nothing new to learn from
 * Linear and one HTTP call is one too many on a fifteen-minute sweep of
 * fifty pull requests.
 */
async function noteCost(record, { becameMerged = false } = {}) {
  return noteCostFields(record, { withIssue: !record.workKind && (becameMerged || !record.mergedAt) });
}

/**
 * Cost a pull request again on demand - after a deploy marks it shipped, or
 * from a test. The phases move under it while it is open, so the figure a
 * page shows is only as fresh as the last fold; this is how a caller that
 * wants it fresher gets it.
 */
export async function recost(repo, number) {
  const record = await load(repo, number);
  if (!record) return null;
  if (await noteCost(record)) await save(record);
  return record;
}

// ---- end pull-cost ----

// ---------------------------------------------------------------- reading

export async function get(repo, number, host = "github") {
  return load(repo, number, host);
}

/** Pull requests, newest activity first. */
export async function list({ repo = null, repoId = null, host = null, since = 0, limit = 100 } = {}) {
  const seen = new Map();
  for (const record of recent.values()) {
    if (repo && record.repo !== repo) continue;
    // A repository path is only unique within a host, so a caller that
    // named one and means a particular host says which.
    if (host && (record.host ?? "github") !== host) continue;
    if (repoId && record.repoId !== repoId) continue;
    if (record.updatedAt < since) continue;
    seen.set(record.id, record);
  }
  if (store.loadPulls) {
    try {
      for (const record of await store.loadPulls({ repo, repoId, host, since, limit })) {
        if (!seen.has(record.id)) seen.set(record.id, record);
      }
    } catch (err) {
      console.warn(`pulls: could not read the store: ${err.message}`);
    }
  }
  return [...seen.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

/**
 * What "this repo's pull requests" means, in one place.
 *
 * Given a repo record with a repository behind it, they are the
 * repository's pull requests - every one, whoever opened them. `repoId` is
 * stamped only on records this installation's own work produced (see
 * `link`), so scoping by it shows an agent's output and calls everything
 * else "no pull requests". A repo connected to watch GitHub has no agents
 * on it and every pull request on it was opened by a person; by repoId that
 * page is empty forever, which reads as the feature being broken rather
 * than as a filter nobody asked for.
 *
 * Given a bare id, or a repo with no repository, it stays what it was: a
 * repo with nothing on GitHub can only have what was made here.
 */
function scopeOf(what) {
  if (!what || typeof what === "string") return { repoId: what ?? null };
  return what.source?.repo ? { repo: what.source.repo } : { repoId: what.id ?? null };
}

/**
 * One repo's pull requests, newest activity first.
 *
 * @param {object|string} what the repo record, or a bare repo id
 */
export const forRepo = (what, options = {}) => list({ ...options, ...scopeOf(what) });

/** What one pull request is, to a task or a session card: the public facts, no body. */
export const summarize = (record) => ({
  id: record.id,
  repo: record.repo,
  host: record.host ?? "github",
  number: record.number,
  url: record.url ?? null,
  title: record.title ?? null,
  state: record.state ?? "open",
  draft: Boolean(record.draft),
  mergedAt: record.mergedAt ?? null,
  closedAt: record.closedAt ?? null,
  changesRequested: changesRequestedOn(record),
});

/**
 * The pull requests a set of tasks came to, by task id. One read per repo
 * for a whole Tasks tab, rather than one per task: a pull request names its
 * tasks, so the join is on this side. Several repos because a task's pieces
 * can be sent to another repo, and the tab shows the whole trail.
 *
 * @returns {Promise<Map<string, object[]>>} task id -> pull summaries, newest first
 */
export async function byTask(repoIds, { since = 0 } = {}) {
  const out = new Map();
  for (const repoId of new Set([repoIds].flat().filter(Boolean))) {
    for (const record of await list({ repoId, since, limit: 500 })) {
      for (const taskId of record.taskIds ?? []) {
        if (!out.has(taskId)) out.set(taskId, []);
        out.get(taskId).push(summarize(record));
      }
    }
  }
  return out;
}

/**
 * How many of a repo's pull requests are open, from memory - for a card
 * that cannot wait. Scoped the same way as `forRepo`, so the count on the
 * card and the list behind it are answering the same question.
 *
 * @param {object|string} what the repo record, or a bare repo id
 */
export function countOpen(what) {
  const { repo, repoId } = scopeOf(what);
  let open = 0;
  for (const record of recent.values()) {
    if (record.state !== "open") continue;
    if (repo ? record.repo === repo : record.repoId === repoId) open += 1;
  }
  return open;
}

/** Fill the memory from the store so `countOpen` has something to count after a restart. */
export async function warm({ since = Date.now() - 30 * 24 * 60 * 60_000 } = {}) {
  if (!store.loadPulls) return 0;
  try {
    const stored = await store.loadPulls({ since, limit: MAX_RECENT });
    for (const record of [...stored].reverse()) if (!recent.has(record.id)) remember(record);
    return stored.length;
  } catch (err) {
    console.warn(`pulls: could not warm from the store: ${err.message}`);
    return 0;
  }
}

/** For tests. */
export const pullInternals = {
  recent,
  reset() {
    recent.clear();
    sessionsRead = { at: 0, promise: null };
  },
};
