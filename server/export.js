// Export: the same figures the pages show, as a file somebody else can read.
//
// Every number on the Performance page is worked out here from sessions,
// pull requests and tasks - and every one of them is stuck behind a chart
// until a person can take it away. A team that wants its agents' figures in
// the spreadsheet the rest of its engineering metrics live in, or wants to
// keep a month before the range rolls past it, or wants to check our
// arithmetic against their own, has no way to do any of that from a chart.
// So: two tables, in two formats, over the same scope and the same range
// the page is showing.
//
// ## The schema is the contract, and it is stable from today
//
// A file somebody has built a spreadsheet on is not a page: a column that
// moves or vanishes breaks whatever was reading it, silently, a month
// later. So `SESSION_COLUMNS` and `PULL_COLUMNS` are ordered lists, new
// columns are appended rather than inserted, and every column is in the
// header from the day it is named - including the ones nothing fills yet.
//
// That last part is the point of `since`. Three pull requests being built
// beside this one add the figures this product has been missing: what
// became of a merged pull request (reverted, shipped, still there after
// thirty days), how much a session was steered (turns, interrupts, kinds of
// steer), and how much of what an agent wrote survived review. Their
// columns are here now, read defensively off records that do not carry them
// yet, so they come out empty until the work lands and full the moment it
// does - and nobody's spreadsheet has to gain a column on that day. `since`
// says which pull request fills each: "now" for the ones that already do,
// "A", "B" or "C" for the ones waiting.
//
// ## The words rule holds here too
//
// A session's record is counts, ids and names, with one exception: `title`,
// what the work was for (sessions.js). It goes out to whoever may read it
// and to nobody else, which is the rule every other route follows through
// index.js `mayReadWords` - so `sessionRows` takes a `mayRead` predicate
// and leaves the cell empty rather than the caller having to remember. A
// pull request's title is GitHub's own and public there, and is exported
// as it is shown everywhere else here.
//
// Pure: sessions, pull requests and tasks in, flat rows out, so the route
// is a scope, a range and a write, and a test needs no server.
import { guidanceOf, mainModelOf } from "./sessions.js";
import * as performance from "./performance.js";
import { frictionOf, repeatsOf, kindsOf } from "./friction.js";

/** The ranges a file can be asked for - the Performance page's own. */
export const RANGES = performance.RANGES;

/**
 * A cell's value as a spreadsheet wants it: a moment as ISO 8601, a list as
 * one string, nothing at all as an empty cell rather than the word "null".
 */
const at = (value) => {
  const ms = typeof value === "number" ? value : value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
};

/**
 * A list of ids or addresses as one cell, space-joined. Space rather than a
 * comma because a comma is the file's own separator and would quote every
 * one of these; none of the things listed here (pull request ids, session
 * ids, URLs, task ids) can hold a space.
 */
const list = (values) => {
  const own = (values ?? []).filter(Boolean).map(String);
  return own.length ? own.join(" ") : null;
};

/**
 * The columns of the sessions table, in order.
 *
 * `unit` is what the number is in, said once here so the doc and the header
 * cannot drift; `since` is the pull request that fills it (above).
 */
export const SESSION_COLUMNS = [
  { key: "id", title: "Session", unit: "id", since: "now" },
  { key: "title", title: "What it was for", unit: "words", since: "now" },
  { key: "kind", title: "Kind", unit: "word", since: "now" },
  { key: "state", title: "State", unit: "word", since: "now" },
  { key: "owner", title: "Owner", unit: "email", since: "now" },
  { key: "ownerName", title: "Owner's name", unit: "name", since: "now" },
  { key: "executorId", title: "Executor", unit: "id", since: "now" },
  { key: "executor", title: "Executor's name", unit: "name", since: "now" },
  { key: "harness", title: "Harness", unit: "kind", since: "now" },
  { key: "model", title: "Model", unit: "id", since: "now" },
  { key: "provider", title: "Model vendor", unit: "name", since: "now" },
  { key: "repo", title: "Repository", unit: "owner/name", since: "now" },
  { key: "repoId", title: "Repo here", unit: "id", since: "now" },
  { key: "where", title: "How it reaches this workspace", unit: "word", since: "now" },
  { key: "machine", title: "Machine", unit: "name", since: "now" },
  { key: "machineHost", title: "Where it ran", unit: "word", since: "now" },
  { key: "startedAt", title: "Started", unit: "ISO 8601", since: "now" },
  { key: "endedAt", title: "Ended", unit: "ISO 8601", since: "now" },
  { key: "durationMs", title: "How long it ran", unit: "ms", since: "now" },
  { key: "tokens", title: "Tokens", unit: "count", since: "now" },
  { key: "costCents", title: "Cost", unit: "cents", since: "now" },
  { key: "toolCalls", title: "Tool calls", unit: "count", since: "now" },
  { key: "toolsFailed", title: "Tool calls that failed", unit: "count", since: "now" },
  { key: "modelCalls", title: "Model calls", unit: "count", since: "now" },
  { key: "humanLines", title: "Lines from a person", unit: "count", since: "now" },
  { key: "followUps", title: "Follow-ups", unit: "count", since: "now" },
  { key: "retries", title: "Retries", unit: "count", since: "now" },
  { key: "reviewRounds", title: "Review rounds", unit: "count", since: "now" },
  { key: "interventions", title: "Interventions", unit: "count", since: "now" },
  { key: "frictionPoints", title: "Friction", unit: "points", since: "now" },
  { key: "filesTouched", title: "Files touched", unit: "count", since: "now" },
  { key: "tasksTaken", title: "Tasks taken", unit: "count", since: "now" },
  { key: "tasksFinished", title: "Tasks finished", unit: "count", since: "now" },
  { key: "verdict", title: "Verdict", unit: "done / doing / undone", since: "now" },
  { key: "outcome", title: "Outcome", unit: "merged / open / closed / none", since: "now" },
  { key: "taskIds", title: "Tasks", unit: "ids", since: "now" },
  { key: "pulls", title: "Pull requests", unit: "ids", since: "now" },
  { key: "pullUrls", title: "Pull requests", unit: "URLs", since: "now" },
  // Waiting on the work being built beside this. Empty until it lands.
  { key: "turns", title: "Turns", unit: "count", since: "B" },
  { key: "interrupts", title: "Times cut short", unit: "count", since: "B" },
  { key: "steers", title: "Steers", unit: "count", since: "B" },
  { key: "agentMs", title: "Agent working", unit: "ms", since: "B" },
  { key: "personMs", title: "Waiting on a person", unit: "ms", since: "B" },
  { key: "linesAdded", title: "Lines written", unit: "count", since: "now" },
  { key: "accepted", title: "Lines kept through review", unit: "count", since: "now" },
  { key: "acceptance", title: "Share of lines kept", unit: "0-1", since: "now" },
  { key: "yield", title: "What came of it", unit: "word", since: "A" },
  // What got in its way (friction.js, and the Friction section of the doc).
  { key: "errors", title: "Failed tool calls, classified", unit: "count", since: "now" },
  // One cell rather than nine. Nine columns of mostly noughts widen every
  // row of every file for a fact that is read as a top three; and the
  // vocabulary may gain a kind one day, which in nine columns would mean
  // *inserting* one - the thing the schema promises never to do. Space-
  // joined `kind=count`, the file's own convention for a list (`list`),
  // and never a comma, so it never needs quoting.
  { key: "errorKinds", title: "How they failed", unit: "kind=count", since: "now" },
  { key: "handBacks", title: "Turns handed back to a person", unit: "count", since: "now" },
  { key: "repeats", title: "Commands run three times or more", unit: "count", since: "now" },
  { key: "repeatRuns", title: "Runs of those commands", unit: "count", since: "now" },
  { key: "refusals", title: "Refused by a permission", unit: "count", since: "now" },
];

/** The columns of the pull requests table, in order. */
export const PULL_COLUMNS = [
  { key: "id", title: "Pull request", unit: "id", since: "now" },
  { key: "repo", title: "Repository", unit: "owner/name", since: "now" },
  { key: "number", title: "Number", unit: "count", since: "now" },
  { key: "title", title: "Title", unit: "words", since: "now" },
  { key: "url", title: "Address", unit: "URL", since: "now" },
  { key: "state", title: "State", unit: "merged / open / closed", since: "now" },
  { key: "draft", title: "Draft", unit: "true / false", since: "now" },
  { key: "author", title: "Author", unit: "login", since: "now" },
  { key: "bot", title: "Author is a bot", unit: "true / false", since: "now" },
  { key: "headRef", title: "Branch", unit: "ref", since: "now" },
  { key: "baseRef", title: "Onto", unit: "ref", since: "now" },
  { key: "openedAt", title: "Opened", unit: "ISO 8601", since: "now" },
  { key: "readyAt", title: "Said ready", unit: "ISO 8601", since: "now" },
  { key: "mergedAt", title: "Merged", unit: "ISO 8601", since: "now" },
  { key: "closedAt", title: "Closed", unit: "ISO 8601", since: "now" },
  { key: "reviews", title: "Reviews", unit: "count", since: "now" },
  { key: "changesRequested", title: "Rounds of changes requested", unit: "count", since: "now" },
  { key: "comments", title: "Comments", unit: "count", since: "now" },
  { key: "sessionIds", title: "Sessions behind it", unit: "ids", since: "now" },
  { key: "agentId", title: "Executor", unit: "id", since: "now" },
  { key: "externalAgentId", title: "Vendor's agent", unit: "id", since: "now" },
  { key: "repoId", title: "Repo here", unit: "id", since: "now" },
  { key: "taskIds", title: "Tasks", unit: "ids", since: "now" },
  // Waiting on the work being built beside this. Empty until it lands.
  { key: "reverted", title: "Reverted", unit: "ISO 8601", since: "A" },
  { key: "followUps", title: "Follow-up fixes", unit: "count", since: "A" },
  { key: "brokeBuild", title: "Broke the build", unit: "true / false", since: "A" },
  { key: "shipped", title: "Shipped", unit: "ISO 8601", since: "A" },
  { key: "durability", title: "Lines still there after 30 days", unit: "0-1", since: "A" },
  // ---- pull-cost ----
  // What the change cost and what kind of change it was (pull-cost.js).
  // The three phases as their own columns rather than one: a spreadsheet
  // that has to parse "before/review/after" out of a cell is a spreadsheet
  // nobody sorts by review spend. Empty where the sessions' spans have
  // aged out - the split is unknown then, and nought would be a claim.
  { key: "workKind", title: "Kind of work", unit: "feature / fix / chore / docs / refactor / review / unknown", since: "now" },
  { key: "workKindFrom", title: "Where the kind came from", unit: "task / issue / bot / title / branch / none", since: "now" },
  { key: "costCents", title: "Cost", unit: "cents", since: "now" },
  { key: "costBeforeCents", title: "Cost before review", unit: "cents", since: "now" },
  { key: "costReviewCents", title: "Cost answering review", unit: "cents", since: "now" },
  { key: "costAfterCents", title: "Cost after it was over", unit: "cents", since: "now" },
  // ---- end pull-cost ----
  { key: "additions", title: "Lines added", unit: "count", since: "now" },
  { key: "deletions", title: "Lines removed", unit: "count", since: "now" },
  { key: "aiShare", title: "Share written by an agent", unit: "0-1", since: "now" },
  // Friction on the sessions behind it: what the work of getting this pull
  // request open ran into. Empty, not nought, for a pull request no session
  // here is behind - a human's, or a vendor's bot's.
  { key: "frictionErrors", title: "Failed tool calls behind it", unit: "count", since: "now" },
  { key: "frictionHandBacks", title: "Turns handed back behind it", unit: "count", since: "now" },
  // Appended, not slotted in beside `shipped` where it belongs by meaning:
  // the order of these columns is what somebody's spreadsheet is reading,
  // and a column inserted in the middle moves every one after it.
  { key: "rolledBack", title: "Rolled out of production", unit: "ISO 8601", since: "now" },
];

/**
 * What a session's yield was, when something can say.
 *
 * `yieldOf` is pull request A's, and this file ships before it: asked for
 * by name and used if it is there, so the column fills itself on the day A
 * merges rather than needing this module edited again. Reimplementing it
 * here would be a second definition of a word the pages already use, which
 * is worse than an empty column.
 */
const yieldOf = (session, pulls, tasks) =>
  typeof performance.yieldOf === "function" ? performance.yieldOf(session, pulls, tasks) ?? null : null;

/**
 * How much a session was steered, in the sense pull request B gives the
 * word: everything after the first ask.
 *
 * `interrupts` is B's signal and the only part of the sum that is not on
 * the record today, so its absence is what says B has not landed - without
 * it this would be three of the four terms passed off as the figure, which
 * is worse than an empty cell.
 */
function steersOf(session) {
  const guidance = guidanceOf(session);
  const interrupts = session?.counts?.guidance?.interrupts;
  if (typeof interrupts !== "number") return null;
  return guidance.followUps + interrupts + guidance.reviewRounds + guidance.retries;
}

/**
 * One row per session, in the order they were handed in.
 *
 * @param {object[]} sessions the session records in scope
 * @param {object[]} pulls the pull request records in scope, for the outcome
 * @param {object[]} tasks the task records, for the verdict
 * @param {{names?: Map<string, string>, mayRead?: (session: object) => boolean}} options
 *   `names` is owner -> display name (index.js `namesOf`); `mayRead` is
 *   whether this viewer may read a session's words, and defaults to no -
 *   safe when a caller forgets, the way `describeSession` is; `refusals`
 *   is session id -> how many times a permission said no to it, which
 *   lives on the repository's records rather than the session's
 *   (access-trail.js) and so has to be handed in.
 */
export function sessionRows(sessions = [], pulls = [], tasks = [], { names = new Map(), mayRead = () => false, refusals = new Map() } = {}) {
  return sessions.filter(Boolean).map((session) => {
    const counts = session.counts ?? {};
    const guidance = guidanceOf(session);
    const worked = performance.tasksWorked(session, pulls, tasks);
    const own = performance.pullsOf(session, pulls);
    const provider = performance.groupOf(session, "provider");
    const linesAdded = typeof counts.linesAdded === "number" ? counts.linesAdded : null;
    const friction = frictionOf(session);
    const kinds = kindsOf(session);
    const repeated = repeatsOf(session);
    const accepted = typeof session.edits?.accepted === "number" ? session.edits.accepted : null;
    // Empty rather than nought where the harness could not say: a session
    // that edited files and reported no lines for them is not a session
    // that wrote none (performance.js `editsOf`, docs/measures.md).
    const written = performance.editsOf(session);
    return {
      id: session.id ?? null,
      // The one field that is words. Empty for a viewer who may not read it,
      // never the actor's name in its place: a column that sometimes holds
      // an ask and sometimes a person is a column nothing can add up.
      title: (mayRead(session) ? session.title : null) ?? null,
      kind: session.kind ?? null,
      state: session.state ?? null,
      owner: session.owner ?? null,
      ownerName: names.get(session.owner) ?? null,
      executorId: session.actor?.id ?? null,
      executor: session.actor?.name ?? null,
      harness: performance.harnessKindOf(session) ?? null,
      model: mainModelOf(session),
      provider: provider.key === performance.UNREPORTED ? null : provider.name,
      repo: session.repo?.fullName ?? null,
      repoId: session.repoId ?? null,
      where: session.where ?? null,
      machine: session.machine?.name ?? null,
      machineHost: session.machine?.host ?? null,
      startedAt: at(session.startedAt),
      endedAt: at(session.endedAt),
      // Null while it is still going: a live session has not taken as long
      // as it is going to, and a figure that grows while nobody is looking
      // is not one to average.
      durationMs: session.endedAt && session.startedAt ? session.endedAt - session.startedAt : null,
      tokens: counts.tokens ?? 0,
      costCents: counts.cost ?? 0,
      toolCalls: counts.tools ?? 0,
      toolsFailed: counts.toolsFailed ?? 0,
      modelCalls: counts.modelCalls ?? 0,
      humanLines: guidance.humanLines,
      followUps: guidance.followUps,
      retries: guidance.retries,
      reviewRounds: guidance.reviewRounds,
      interventions: performance.interventionsOf(session),
      frictionPoints: performance.friction(session).points,
      filesTouched: session.filesTouched ?? 0,
      tasksTaken: worked.length,
      tasksFinished: worked.filter((task) => task.verdict === "done").length,
      verdict: performance.verdictOf(session, pulls, tasks),
      outcome: performance.outcomeOf(session, pulls),
      taskIds: list(session.taskIds),
      pulls: list(own.map((pull) => pull.id)),
      pullUrls: list(own.map((pull) => pull.url)),
      turns: typeof counts.turns === "number" ? counts.turns : null,
      interrupts: typeof counts.guidance?.interrupts === "number" ? counts.guidance.interrupts : null,
      steers: steersOf(session),
      agentMs: typeof counts.agentMs === "number" ? counts.agentMs : null,
      personMs: typeof counts.personMs === "number" ? counts.personMs : null,
      linesAdded: written.measured ? written.linesAdded : null,
      accepted: written.accepted,
      // Worked out rather than read, so it cannot go stale against either
      // half of it.
      acceptance: written.acceptance,
      yield: yieldOf(session, pulls, tasks),
      errors: kinds.reduce((sum, kind) => sum + kind.count, 0),
      errorKinds: list(kinds.map((kind) => `${kind.kind}=${kind.count}`)),
      handBacks: friction.handBacks,
      // Counts, not command lines: the record keeps a fingerprint rather
      // than the line (friction.js), and a file that goes to a spreadsheet
      // is the last place to start putting one back. "3 commands, 14 runs"
      // is the fact anyway - which command it was is a question for the
      // session's own page, where the words rule can be applied.
      repeats: repeated.length,
      repeatRuns: repeated.reduce((sum, repeat) => sum + repeat.times, 0),
      // The trail's, not the record's: a permission saying no is the
      // repository's record, so the caller joins it by session and a caller
      // that has no trail to hand leaves the cell empty rather than nought.
      refusals: refusals.has(session.id) ? refusals.get(session.id) : null,
    };
  });
}

// ---- pull-cost ----

/** The four money cells of a pull request's cost, all null where it has none. */
function phaseCells(cost) {
  const priced = cost?.priced ? cost : null;
  const cents = (phase) => (typeof priced?.[phase]?.cents === "number" ? priced[phase].cents : null);
  return {
    costCents: cents("total"),
    costBeforeCents: cents("before"),
    costReviewCents: cents("review"),
    costAfterCents: cents("after"),
  };
}

// ---- end pull-cost ----

/**
 * One row per pull request.
 *
 * `sessions` is here for the link back: the record's `sessionIds` is what
 * the push and the webhook worked out, and a session that noted a pull
 * request itself (`notePull`) knows about one the record may not - so the
 * cell is the union, which is what every page draws from too
 * (performance.js `pullsOf`).
 */
export function pullRows(pulls = [], sessions = []) {
  const byId = new Map(sessions.filter(Boolean).map((session) => [session.id, session]));
  /** One figure summed over the sessions behind a pull request, the ones we hold. */
  const sum = (ids, of) => [...ids].map((id) => byId.get(id)).filter(Boolean).reduce((total, session) => total + of(session), 0);
  const behind = new Map();
  for (const session of sessions.filter(Boolean)) {
    for (const pull of session.pulls ?? []) {
      if (!pull?.id) continue;
      if (!behind.has(pull.id)) behind.set(pull.id, new Set());
      behind.get(pull.id).add(session.id);
    }
  }
  return pulls.filter(Boolean).map((pull) => {
    const ids = new Set([...(pull.sessionIds ?? []), ...(behind.get(pull.id) ?? [])]);
    return {
      id: pull.id ?? null,
      repo: pull.repo ?? null,
      number: pull.number ?? null,
      title: pull.title ?? null,
      url: pull.url ?? null,
      state: pull.state ?? null,
      draft: Boolean(pull.draft),
      author: pull.author?.login ?? null,
      bot: Boolean(pull.author?.bot),
      headRef: pull.headRef ?? null,
      baseRef: pull.baseRef ?? null,
      openedAt: at(pull.openedAt),
      readyAt: at(pull.readyAt),
      mergedAt: at(pull.mergedAt),
      closedAt: at(pull.closedAt),
      reviews: (pull.reviews ?? []).length,
      changesRequested: performance.roundsOf(pull) ?? 0,
      comments: pull.comments ?? 0,
      sessionIds: list([...ids]),
      agentId: pull.agentId ?? null,
      externalAgentId: pull.externalAgentId ?? null,
      repoId: pull.repoId ?? null,
      taskIds: list(pull.taskIds),
      // A moment rather than a flag: "when" answers "whether" as well, and
      // a spreadsheet can sort by it.
      reverted: at(pull.reverted?.at),
      followUps: Array.isArray(pull.followUps) ? pull.followUps.length : null,
      brokeBuild: typeof pull.brokeBuild === "boolean" ? pull.brokeBuild : null,
      shipped: at(pull.shipped?.at),
      durability: typeof pull.durability?.share === "number" ? pull.durability.share : null,
      // ---- pull-cost ----
      workKind: pull.workKind ?? null,
      workKindFrom: pull.workKindFrom ?? null,
      // Only where something could be priced. A record whose cost came back
      // unpriced knows its tokens and not its money, and a nought here
      // would be read as a change that cost nothing.
      ...phaseCells(pull.cost),
      // ---- end pull-cost ----
      additions: typeof pull.diff?.additions === "number" ? pull.diff.additions : null,
      deletions: typeof pull.diff?.deletions === "number" ? pull.diff.deletions : null,
      aiShare: typeof pull.attribution?.share === "number" ? pull.attribution.share : null,
      frictionErrors: ids.size ? sum(ids, (session) => kindsOf(session).reduce((total, kind) => total + kind.count, 0)) : null,
      frictionHandBacks: ids.size ? sum(ids, (session) => frictionOf(session).handBacks) : null,
      // When production gave it back, if it did (pulls.js noteRolledBack) -
      // a moment, like `reverted` and `shipped`, so it sorts.
      rolledBack: at(pull.rolledBack?.at),
    };
  });
}

/**
 * One cell, quoted the way RFC 4180 says: a field holding a comma, a quote,
 * a carriage return or a newline is wrapped in quotes and its own quotes
 * doubled. Leading and trailing spaces are quoted too - a spreadsheet
 * otherwise eats them, and a name is not the same name trimmed.
 *
 * Nothing at all is an empty field, which is the one way a CSV can say
 * "there is no answer" - not the string "null", which reads back as a word.
 */
export function csvCell(value) {
  if (value == null) return "";
  const text = typeof value === "boolean" ? String(value) : String(value);
  if (!/[",\r\n]/.test(text) && text.trim() === text) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * The rows as a CSV file: a header row of column keys, then one row each,
 * CRLF between them as the RFC asks. Keys and not titles in the header,
 * because the header is what a script reads by and a title is prose that
 * may be improved.
 */
export function toCsv(rows = [], columns) {
  const keys = columns.map((column) => column.key);
  const lines = [keys.join(","), ...rows.map((row) => keys.map((key) => csvCell(row[key])).join(","))];
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * The same rows as JSON: the columns beside them, so a reader has the units
 * and knows which ones are not filled yet without going to the doc.
 */
export function toJson(rows = [], columns, extra = {}) {
  return `${JSON.stringify({ ...extra, columns, rows }, null, 2)}\n`;
}

/** What the file is called: what it holds, over what range, in what format. */
export const filenameFor = (what, range, format) => `codervibes-${what}-${range}.${format}`;
