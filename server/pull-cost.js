// What a pull request cost, split by the phase it was spent in and by the
// kind of work it was.
//
// The figure this is for is the one a person asks after the fact: "that
// feature cost $15 - where did it go?" A total says nothing they can act on.
// "$4.10 before it was opened, $5.80 getting it through review, $1.90 after
// it merged" says where to look, and "a fix costs a quarter of what a
// feature costs here" says what to expect next time.
//
// ## Why the phases are cut at the pull request's own events
//
// The obvious split is by what the agent was *doing*: planning, then
// implementing, then testing, then answering review. That is the split
// people want, and it is not one this can honestly make. Nothing on a
// session record says which of those three an agent was in at half past two
// - the only thing that would is the transcript, read by a model, and a
// figure whose provenance is "a model read the log and reckoned" is not a
// figure to put in a cost table beside a number that came off a bill.
//
// What is a fact is when the pull request opened, when somebody first
// reviewed it, and when it merged or closed. Those are timestamps GitHub
// sent us. So the cut is made there, and the phases are named for what the
// events mean rather than for what the agent was up to:
//
//   **before** - everything the linked sessions spent up to the moment the
//   pull request asked for a person's attention. Planning, implementation
//   and the agent's own testing are all inside this one number, together,
//   because splitting them is the guess above. Say so wherever it is shown:
//   this is not "implementation", it is "before anybody looked".
//
//   **review** - from that moment to the merge or close. This is review
//   addressing: what it cost to answer what the reviewer said. An agent
//   that nobody sent back has a small one; an agent that went round four
//   times has a large one, and that is the whole point of separating it.
//
//   **after** - anything the linked sessions spent once the pull request
//   was merged or closed. Follow-up commits on a branch nobody merged, a
//   session left running, work on the next thing under the same session id.
//   It is usually small and it is usually interesting when it is not.
//
// A draft is the one case where "opened" is not "asked for attention": an
// agent that opens a draft and keeps working has not asked anybody for
// anything yet, and charging that work to review would make review look
// expensive on every agent that works in the open. So for a pull request
// the record says was opened as a draft, review starts at the first review
// if one came, and at the opening otherwise. `phasesOf` decides this once
// and hands `reviewFrom` to the arithmetic, so the rule lives in one place.
//
// ## What this cannot see
//
//   - **A session that worked on two pull requests is charged to both, in
//     full.** There is nothing on a model call that says which pull request
//     it was for; all we know is which sessions a pull request is linked to.
//     So the sum of every pull request's cost can exceed what was actually
//     spent, and a page that adds them up is adding up something that is not
//     a total. Per pull request the figure is right; summed across pull
//     requests it is an upper bound, and it says so.
//
//   - **A subscription call has tokens and a price and no bill.** The rule is
//     costs.js's `subscribed`: work done on the owner's own Claude
//     subscription is counted in the tokens and costs this installation
//     nothing, so it adds nothing to `cents` and is counted separately, in
//     `subscribed`, rather than being quietly dropped or quietly priced.
//
//   - **A phase with no price is not a phase with no cost.** Where a model
//     has no rate the tokens are still counted and the cents are not, and
//     `unpriced` says how many calls went that way. `priced` is false only
//     when nothing at all could be priced, which is when the page falls back
//     to tokens - the same thing the Performance page does with `anyPriced`.
//
//   - **Work before the first linked session, or by a person, is invisible.**
//     Somebody thinking for a day and then asking an agent for twenty
//     minutes shows as twenty minutes. This measures the machine's spend and
//     nothing else, which is what it is for.
//
// Everything here is pure - pull records and ledger entries in, numbers out.
// The caller fetches. `costOfPull` takes an `entriesOf(sessionId)` that
// returns an array, deliberately synchronous: `spans.forSession` is async,
// so phase 2 resolves the spans first and hands in a lookup over what it
// got, rather than making every figure on the page await something.
import { tokenCost } from "./costs.js";

// ------------------------------------------------------------- the phases

/** The phases of a pull request's life, in order. */
export const PHASES = ["before", "review", "after"];

/**
 * What each phase means, in one line - for the glossary, and for the page
 * that draws the bar, so the words are the same in both.
 */
export const PHASE_MEANING = {
  before: "Everything spent before the pull request asked for a person: planning, implementation and the agent's own testing, together - the log cannot tell them apart.",
  review: "From the moment it asked for a person to the merge or the close: what answering the review cost.",
  after: "Anything the linked sessions spent after it merged or closed.",
};

/** A time that may be a number or an ISO string, as milliseconds. Null when it is neither. */
export function timeOf(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * When a pull request was first reviewed.
 *
 * The earliest review that is not `commented` - a comment is somebody
 * talking, a review is somebody deciding, and only the second is a round the
 * agent has to answer. (pulls.js already drops `commented` reviews on the
 * way in; this does not rely on that.) Failing that, the first comment, when
 * the record carries a time for one - the record keeps a count and some
 * folds keep a time, and a comment is at least a person having looked.
 */
export function firstReviewOf(pull) {
  const times = (pull?.reviews ?? [])
    .filter((review) => review && review.state !== "commented")
    .map((review) => timeOf(review.at))
    .filter((at) => at != null);
  if (times.length) return Math.min(...times);
  return timeOf(pull?.firstCommentAt ?? pull?.commentedAt ?? null);
}

/**
 * The moments a pull request's life is cut at.
 *
 * The four the caller asked for, plus the two the arithmetic reads:
 * `reviewFrom`, which is the opening except on a draft (see the essay), and
 * `endedAt`, the merge or the close. Derived here rather than in
 * `costByPhase` so that the draft rule is decided once, where the record is,
 * and so a test can assert on the boundary itself.
 *
 * @returns {{openedAt: number|null, firstReviewAt: number|null, mergedAt: number|null,
 *            closedAt: number|null, reviewFrom: number|null, endedAt: number|null, draft: boolean}}
 */
export function phasesOf(pull) {
  const openedAt = timeOf(pull?.openedAt);
  const firstReviewAt = firstReviewOf(pull);
  const mergedAt = timeOf(pull?.mergedAt);
  const closedAt = timeOf(pull?.closedAt);
  const draft = Boolean(pull?.draft);
  // A draft asked nobody for anything when it opened, so review starts when
  // somebody actually reviewed it. Anything else starts at the opening -
  // and a record with no opening time falls back to the first review, which
  // is the only moment it has.
  const reviewFrom = draft ? (firstReviewAt ?? openedAt) : (openedAt ?? firstReviewAt);
  // Merged and closed both arrive on a merge (a merged pull request is a
  // closed one), so the merge wins where both are there.
  const endedAt = mergedAt ?? closedAt;
  return { openedAt, firstReviewAt, mergedAt, closedAt, reviewFrom, endedAt, draft };
}

/** Which phase a moment falls in. Everything is `before` on a pull request that never opened. */
export function phaseAt(at, phases) {
  const { reviewFrom, endedAt } = phases ?? {};
  if (endedAt != null && at >= endedAt) return "after";
  if (reviewFrom != null && at >= reviewFrom) return "review";
  return "before";
}

// -------------------------------------------------------------- the money

const TOKEN_KEYS = ["input", "output", "cacheRead", "cacheWrite"];

/**
 * An entry's tokens, as a total and as the parts the price needs. A ledger
 * entry carries the four counts; a caller that only kept a total may hand a
 * number, which can be counted but not priced.
 */
function tokensOf(entry) {
  const tokens = entry?.tokens;
  if (tokens == null) return { total: 0, parts: null };
  if (typeof tokens === "number") return { total: Math.max(0, tokens), parts: null };
  let total = 0;
  for (const key of TOKEN_KEYS) total += Number(tokens[key] ?? 0);
  return { total, parts: tokens };
}

/**
 * What one entry cost this installation, in cents, or null where nothing
 * here can say.
 *
 * The order is costs.js's, and it is not re-derived: what the gateway that
 * served the call said it cost is the number on the bill and beats the
 * catalogue; failing that the catalogue prices the tokens at the rate of the
 * model they went to (`tokenCost`); a call on the owner's own subscription
 * cost this installation nothing whatever its tokens say.
 */
export function centsOf(entry) {
  if (entry?.subscription) return 0;
  const said = Number(entry?.cents);
  if (entry?.cents != null && Number.isFinite(said)) return said;
  const { parts } = tokensOf(entry);
  if (!parts) return null;
  return tokenCost(parts, entry.model ?? null);
}

const blankPhase = () => ({ cents: 0, tokens: 0, calls: 0, subscribed: 0, unpriced: 0, firstAt: null, lastAt: null });

/** Round money the way costs.js does - two decimal places of a cent. */
const round = (cents) => Math.round(cents * 100) / 100;

/**
 * What the entries of a pull request's sessions cost, phase by phase.
 *
 * An entry that carries neither tokens nor a price is not spend - a tool
 * call that took four seconds and handed back some text costs nothing here -
 * and is not counted. So `calls` is model calls, which is what a cost
 * breakdown is about.
 *
 * @param {Array<{at, tokens?, cents?, model?, subscription?}>} entries the pull request's sessions', in any order
 * @param {object} phases from `phasesOf`
 * @returns {{before, review, after, total, priced: boolean, partial: boolean}}
 *   each phase `{cents, tokens, calls, subscribed, unpriced, firstAt, lastAt}`;
 *   `priced` false when nothing at all could be priced (show tokens only),
 *   `partial` true when some of it could not (say how much is missing).
 */
export function costByPhase(entries, phases) {
  const out = { before: blankPhase(), review: blankPhase(), after: blankPhase(), total: blankPhase() };
  for (const entry of entries ?? []) {
    const { total: tokens } = tokensOf(entry);
    const cents = centsOf(entry);
    if (!tokens && cents == null) continue;
    const at = timeOf(entry?.at) ?? 0;
    for (const bucket of [out[phaseAt(at, phases)], out.total]) {
      bucket.calls += 1;
      bucket.tokens += tokens;
      if (entry?.subscription) bucket.subscribed += 1;
      if (cents == null) bucket.unpriced += 1;
      else bucket.cents += cents;
      bucket.firstAt = bucket.firstAt == null ? at : Math.min(bucket.firstAt, at);
      bucket.lastAt = bucket.lastAt == null ? at : Math.max(bucket.lastAt, at);
    }
  }
  for (const key of [...PHASES, "total"]) out[key].cents = round(out[key].cents);
  // Priced when at least one call could be, which is the question the page
  // asks: does this get a dollar sign or a token count? How much of it is
  // missing is `unpriced`, and `partial` says not to read the figure as the
  // whole bill.
  const pricedCalls = out.total.calls - out.total.unpriced;
  return { ...out, priced: pricedCalls > 0, partial: out.total.unpriced > 0 };
}

/**
 * What one pull request cost, from a caller-provided lookup of its
 * sessions' entries.
 *
 * `entriesOf` is handed each linked session id once, deduplicated, and
 * returns that session's ledger or span entries. Phase 2 resolves
 * `spans.forSession` for the recent ones and reads the ledger for the rest;
 * a test hands in a Map.
 */
export function costOfPull(pull, { entriesOf } = {}) {
  const phases = phasesOf(pull);
  const entries = [];
  for (const sessionId of new Set(pull?.sessionIds ?? [])) {
    for (const entry of entriesOf?.(sessionId) ?? []) entries.push(entry);
  }
  return { ...costByPhase(entries, phases), phases, sessions: new Set(pull?.sessionIds ?? []).size };
}

// --------------------------------------------------------- kinds of work

/**
 * The kinds of work a pull request can be. Small on purpose: every extra
 * bucket is another line on a chart that fewer pull requests fall into, and
 * the question this answers is "does a fix cost less than a feature here",
 * which needs those two to be well populated more than it needs precision.
 */
export const WORK_KINDS = ["feature", "fix", "chore", "docs", "refactor", "review", "unknown"];

/**
 * Conventional-commit prefixes, which say the kind outright and are worth
 * more than a word found anywhere in the title: `docs: fix a typo` is docs,
 * and searching for words would call it a fix.
 */
const PREFIX_KIND = {
  feat: "feature", feature: "feature",
  fix: "fix", bug: "fix", hotfix: "fix", revert: "fix",
  chore: "chore", build: "chore", ci: "chore", deps: "chore", perf: "chore", style: "chore", test: "chore",
  docs: "docs", doc: "docs",
  refactor: "refactor",
};

/**
 * Words that decide the kind when nothing better has, in the order they are
 * tried - a title with two of them takes the first, and the order runs from
 * the most specific claim to the least.
 */
const WORDS = [
  ["fix", ["fix", "fixes", "fixed", "bug", "bugs", "bugfix", "hotfix", "regression", "revert", "reverts", "broken", "crash"]],
  ["docs", ["docs", "doc", "documentation", "readme", "changelog", "typo"]],
  ["refactor", ["refactor", "refactors", "refactoring", "cleanup", "tidy", "simplify", "rename", "dedupe"]],
  ["chore", ["chore", "bump", "bumps", "deps", "dependencies", "dependency", "ci", "lockfile", "release", "version"]],
  ["feature", ["feat", "feature", "add", "adds", "support", "introduce", "implement", "new"]],
];

/** Bot logins whose pull requests are review work, and bot logins whose are chores. */
const BOT_KIND = [
  ["review", /greptile|coderabbit|codium|qodo|sourcery|reviewpad|pr-agent|codeball/i],
  ["chore", /dependabot|renovate|snyk|mergify|imgbot|allcontributors/i],
];

/** A title or a branch as the words in it: lower case, split on anything that is not a letter or a digit. */
const wordsIn = (text) => String(text ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** The kind a conventional-commit prefix claims, from a title or a branch's first segment. */
function prefixKind(title, headRef) {
  const fromTitle = /^\s*([a-z]+)(?:\([^)]*\))?!?\s*:/i.exec(String(title ?? ""));
  const titleKind = fromTitle ? PREFIX_KIND[fromTitle[1].toLowerCase()] : null;
  if (titleKind) return { kind: titleKind, from: "title" };
  // A branch named `fix/whatever` or `feat-whatever` says the same thing.
  // Not `cv/<repo>/<session>`, which is ours and says nothing (pulls.js).
  const segments = String(headRef ?? "").toLowerCase().split(/[/_-]/).filter(Boolean);
  if (segments[0] === "cv" || segments[0] === "codervibes") return null;
  const branchKind = PREFIX_KIND[segments[0]];
  return branchKind ? { kind: branchKind, from: "branch" } : null;
}

/** What a Linear issue's own type and labels say the work is. */
function issueKind(issue) {
  if (!issue) return null;
  const said = [
    issue.type,
    issue.issueType?.name,
    ...(Array.isArray(issue.labels) ? issue.labels : issue.labels?.nodes ?? []).map((label) =>
      typeof label === "string" ? label : label?.name,
    ),
  ]
    .filter(Boolean)
    .map((word) => String(word).toLowerCase());
  for (const word of said) {
    if (/\bbug\b|defect|regression|incident/.test(word)) return "fix";
    if (/feature|improvement|enhancement|story/.test(word)) return "feature";
    if (/chore|tech ?-?debt|maintenance|dependenc/.test(word)) return "chore";
    if (/\bdocs?\b|documentation/.test(word)) return "docs";
    if (/refactor|cleanup/.test(word)) return "refactor";
  }
  return null;
}

/**
 * What kind of work a pull request was, in the order the answer is worth
 * trusting.
 *
 *   1. **The task record**, when it says. `task.workKind` is an explicit
 *      answer if a future task ever carries one; `task.outcome.kind`
 *      (agent-tasks.js `OUTCOME_KINDS`) says what the outcome *is* rather
 *      than what the work was - `pull`, `ops`, `answer`, `other` are not
 *      kinds of change - so only its `review` decides anything here.
 *   2. **A linked issue**, when the caller looked one up. A tracker's own
 *      type and labels are a person's classification of the work, made
 *      before it was done and for a different purpose, which is exactly
 *      what makes it worth more than anything read off the title.
 *   3. **A review bot's login**, because a pull request opened by one is
 *      review work whatever it is called.
 *   4. **The title and the branch.** This is a heuristic and nothing more.
 *      It reads what somebody typed in a hurry and infers a category from
 *      it; "Handle the empty case" is a fix and this will call it unknown,
 *      and a feature called "Fix up the settings page" will be counted as a
 *      fix. It is here because a task record and an issue are absent far
 *      more often than they are present, and a table where nine rows in ten
 *      say "unknown" answers nothing. Every surface that shows a kind this
 *      came from should be able to say where it came from, which is why
 *      `explainWorkKind` exists.
 *   5. **`unknown`**, which is an answer. Guessing between feature and fix
 *      from a diff we have not read would not be.
 *
 * @param {object} args
 * @param {object} [args.task] the task record the pull request is the outcome of
 * @param {string} [args.title] the pull request's title
 * @param {object} [args.issue] a tracker issue, when one was looked up
 * @param {string} [args.headRef] the branch
 * @param {{login?: string, bot?: boolean}} [args.author] who opened it
 */
export function workKindOf({ task = null, title = null, issue = null, headRef = null, author = null } = {}) {
  return explainWorkKind({ task, title, issue, headRef, author }).kind;
}

/**
 * The kind and where it came from: `task` | `issue` | `bot` | `title` |
 * `branch` | `none`. The page shows a title-derived kind differently from
 * one an issue said, because one of them is a guess.
 */
export function explainWorkKind({ task = null, title = null, issue = null, headRef = null, author = null } = {}) {
  const explicit = task?.workKind ?? task?.kind ?? null;
  if (explicit && WORK_KINDS.includes(String(explicit).toLowerCase())) {
    return { kind: String(explicit).toLowerCase(), from: "task" };
  }
  if (task?.outcome?.kind === "review") return { kind: "review", from: "task" };

  const fromIssue = issueKind(issue);
  if (fromIssue) return { kind: fromIssue, from: "issue" };

  const login = String(author?.login ?? "");
  if (login) {
    for (const [kind, pattern] of BOT_KIND) if (pattern.test(login)) return { kind, from: "bot" };
  }

  const prefix = prefixKind(title, headRef);
  if (prefix) return prefix;

  const titleWords = new Set(wordsIn(title));
  const branchWords = new Set(wordsIn(headRef));
  for (const [kind, words] of WORDS) {
    if (words.some((word) => titleWords.has(word))) return { kind, from: "title" };
  }
  for (const [kind, words] of WORDS) {
    if (words.some((word) => branchWords.has(word))) return { kind, from: "branch" };
  }
  return { kind: "unknown", from: "none" };
}

/** The kind a pull request record already carries, or the one its title and branch suggest. */
export const kindOfPull = (pull, { task = null, issue = null } = {}) =>
  (WORK_KINDS.includes(pull?.workKind) ? pull.workKind : null) ??
  workKindOf({ task, issue, title: pull?.title, headRef: pull?.headRef, author: pull?.author });

/** A tracker's identifier as people write it and as branches carry it: ENG-214, eng-214. */
const TICKET_KEY = /\b([A-Z][A-Z0-9]{0,9})-(\d{1,7})\b/i;

/**
 * The issue a pull request is about, if it names one, as an identifier.
 *
 * Three places are read, and the body is not one of them. The plan said
 * "the body or the branch names an issue key"; the record keeps no body -
 * pulls.js's rule is that nothing anybody wrote is kept, and a body is
 * prose - so what is available here is the title, the branch, and the
 * ticket a linked task already resolved (`outcome.ticket`, agent-tasks.js
 * `readTicket`), which is a better source than either: somebody typed it
 * deliberately and it has already been checked against Linear.
 *
 * An identifier is not prose. Keeping `ENG-214` off a title is the same
 * kind of thing as keeping `#131` out of `mentions`: a reference is an id.
 */
export function ticketKeyOf({ title = null, headRef = null, task = null } = {}) {
  const known = task?.outcome?.ticket?.id;
  if (known) return String(known).toUpperCase();
  for (const text of [title, headRef]) {
    const found = TICKET_KEY.exec(String(text ?? ""));
    // A branch called `cv/api-gateway/1a2b3c4d` matches nothing; one called
    // `eng-214-phase-bar` does, and so does a title beginning "ENG-214:".
    if (found) return `${found[1].toUpperCase()}-${found[2]}`;
  }
  return null;
}

// ------------------------------------------------------------ the tables

/**
 * A cost lookup, however the caller keeps them: a function of the pull
 * request, a Map by pull id, or a plain object by pull id.
 */
function lookupOf(costs) {
  if (typeof costs === "function") return (pull) => costs(pull) ?? null;
  if (costs instanceof Map) return (pull) => costs.get(pull?.id) ?? null;
  if (costs && typeof costs === "object") return (pull) => costs[pull?.id] ?? null;
  return () => null;
}

const isMerged = (pull) => pull?.state === "merged" || pull?.mergedAt != null;
const closedUnmerged = (pull) => !isMerged(pull) && (pull?.state === "closed" || pull?.closedAt != null);

const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * What each kind of work costs here.
 *
 * The per-pull-request means divide by the pull requests that *could be
 * priced*, not by all of them: a kind where two of nine had a price and the
 * rest went to a model with no rate would otherwise read as costing two
 * ninths of what it does. `priced` and `pulls` are both on the row so the
 * page can say "over 2 of 9" rather than implying nine.
 *
 * Only kinds with a pull request in them come back - seven rows of noughts
 * is not a table.
 *
 * @param {object[]} pulls
 * @param {Map|object|Function} costs pull id -> the `costByPhase` result
 * @param {{kindOf?: Function}} [options] how to decide a pull request's kind, when not `kindOfPull`
 * @returns {Object<string, {pulls, merged, priced, cents, tokens, centsPerPull, centsPerMerged, tokensPerPull}>}
 */
export function perKind(pulls, costs, { kindOf = kindOfPull } = {}) {
  const costOf = lookupOf(costs);
  const out = {};
  for (const pull of pulls ?? []) {
    if (!pull) continue;
    const kind = kindOf(pull) ?? "unknown";
    const row = (out[kind] ??= {
      pulls: 0, merged: 0, priced: 0, pricedMerged: 0,
      cents: 0, mergedCents: 0, tokens: 0,
      centsPerPull: null, centsPerMerged: null, tokensPerPull: null,
    });
    row.pulls += 1;
    const merged = isMerged(pull);
    if (merged) row.merged += 1;
    const cost = costOf(pull);
    if (!cost) continue;
    row.tokens += cost.total?.tokens ?? 0;
    if (!cost.priced) continue;
    row.priced += 1;
    row.cents += cost.total?.cents ?? 0;
    if (merged) {
      row.pricedMerged += 1;
      row.mergedCents += cost.total?.cents ?? 0;
    }
  }
  for (const row of Object.values(out)) {
    row.cents = round(row.cents);
    row.mergedCents = round(row.mergedCents);
    row.centsPerPull = row.priced ? round(row.cents / row.priced) : null;
    row.centsPerMerged = row.pricedMerged ? round(row.mergedCents / row.pricedMerged) : null;
    row.tokensPerPull = row.pulls ? Math.round(row.tokens / row.pulls) : null;
  }
  return out;
}

/**
 * What a merged pull request costs here, as a mean and a median.
 *
 * Both, because they say different things and the gap between them is the
 * useful part: a median well under the mean means most changes are cheap and
 * a few are enormous, which is a different installation from one where they
 * all cost the same. Over merged pull requests only - what an abandoned one
 * cost is the waste figure below, and mixing them would answer neither
 * question.
 *
 * @returns {{cents: {mean, median}, tokens: {mean, median}, n: number, merged: number}}
 */
export function perMergedPull(pulls, costs) {
  const costOf = lookupOf(costs);
  const merged = (pulls ?? []).filter((pull) => pull && isMerged(pull));
  const cents = [];
  const tokens = [];
  for (const pull of merged) {
    const cost = costOf(pull);
    if (!cost?.priced) continue;
    cents.push(cost.total?.cents ?? 0);
    tokens.push(cost.total?.tokens ?? 0);
  }
  return {
    cents: { mean: cents.length ? round(mean(cents)) : null, median: cents.length ? round(median(cents)) : null },
    tokens: { mean: tokens.length ? Math.round(mean(tokens)) : null, median: tokens.length ? Math.round(median(tokens)) : null },
    n: cents.length,
    merged: merged.length,
  };
}

/**
 * Where the money goes across a set of pull requests, phase by phase.
 *
 * The three phases added up over every pull request that could be priced,
 * and each as a share of the total - which is the tile: "of what a change
 * costs here, two thirds goes before anybody looks at it and a fifth on
 * answering the review". Only priced pull requests are in it, and `n` says
 * how many that was, for the same reason `perKind` divides by the priced
 * ones: a phase total that quietly left out the unpriced half would read as
 * a smaller bill rather than as a partial one.
 *
 * @returns {{before, review, after, total, shares: {before, review, after}, n: number, of: number}}
 */
export function phaseTotals(pulls, costs) {
  const costOf = lookupOf(costs);
  const out = {
    before: { cents: 0, tokens: 0 },
    review: { cents: 0, tokens: 0 },
    after: { cents: 0, tokens: 0 },
    total: { cents: 0, tokens: 0 },
    n: 0,
    of: 0,
  };
  for (const pull of pulls ?? []) {
    if (!pull) continue;
    out.of += 1;
    const cost = costOf(pull);
    if (!cost?.priced) continue;
    out.n += 1;
    for (const phase of [...PHASES, "total"]) {
      out[phase].cents += cost[phase]?.cents ?? 0;
      out[phase].tokens += cost[phase]?.tokens ?? 0;
    }
  }
  for (const phase of [...PHASES, "total"]) out[phase].cents = round(out[phase].cents);
  const whole = out.total.cents;
  out.shares = Object.fromEntries(PHASES.map((phase) => [phase, whole > 0 ? out[phase].cents / whole : null]));
  return out;
}

/**
 * The yields that are money spent on nothing, when the caller has PR A's
 * `yieldOf` to hand. The same three words performance.js `WASTED` holds,
 * repeated here rather than imported so this module stays free of the one
 * that reads sessions from the store - and a test pins them equal.
 */
export const WASTED_YIELDS = ["closed", "discarded", "reverted"];

/**
 * What was spent on work that never landed, and what share of the range that
 * was.
 *
 * Two halves, which do not overlap by construction:
 *
 *   - **Pull requests that closed unmerged.** Costed by the phase
 *     arithmetic, so the review spend on a change nobody took is in here too.
 *   - **Sessions with nothing to show.** A session in the range that is on no
 *     pull request and finished no task.
 *
 * The second half is where the honest caveat is. Without PR A's `yieldOf`
 * this counts a session that asked a question and got an answer - research,
 * which is not waste - the same as one that edited eleven files and was
 * killed. When A has landed, hand in its `yieldOf` and the figure narrows to
 * `closed`, `discarded` and `reverted`, which is what it should be. Until
 * then it is an upper bound and the page should say so.
 *
 * The denominator is the sessions' own `counts.cost`, which is the meter the
 * Performance page uses, so the share is a share of something the reader has
 * already seen. Where a closed pull request has a costed figure that is used
 * for the numerator; where it has none, its sessions' counts stand in.
 *
 * @param {object[]} pulls
 * @param {Map|object|Function} costs pull id -> the `costByPhase` result
 * @param {object[]} sessions
 * @param {object} [options]
 * @param {Function} [options.yieldOf] PR A's `(session, pulls, tasks) => yield`
 * @param {object[]} [options.tasks] task records, for `yieldOf` and for the simple rule
 * @param {number} [options.since] nothing started before this counts
 * @returns {{cents, tokens, share, pulls, sessions, total: {cents, tokens}}}
 */
export function wasteOf(pulls, costs, sessions, { yieldOf = null, tasks = [], since = 0 } = {}) {
  const costOf = lookupOf(costs);
  const all = (pulls ?? []).filter(Boolean);
  const inRange = (sessions ?? []).filter((session) => session && (session.startedAt ?? 0) >= since);
  const byId = new Map(inRange.map((session) => [session.id, session]));

  const total = { cents: 0, tokens: 0 };
  for (const session of inRange) {
    total.cents += session.counts?.cost ?? 0;
    total.tokens += session.counts?.tokens ?? 0;
  }

  // Every session that a pull request in the set names, so the second half
  // knows which sessions already have something to show for themselves.
  const onSomePull = new Set();
  for (const pull of all) for (const id of pull.sessionIds ?? []) onSomePull.add(id);

  let cents = 0;
  let tokens = 0;
  let wastedPulls = 0;
  const charged = new Set();
  for (const pull of all) {
    if (!closedUnmerged(pull)) continue;
    // Only a pull request whose work happened in the range: its sessions'.
    const own = (pull.sessionIds ?? []).filter((id) => byId.has(id));
    if (!own.length) continue;
    wastedPulls += 1;
    const cost = costOf(pull);
    if (cost?.priced) {
      cents += cost.total?.cents ?? 0;
      tokens += cost.total?.tokens ?? 0;
    } else {
      for (const id of own) {
        cents += byId.get(id).counts?.cost ?? 0;
        tokens += byId.get(id).counts?.tokens ?? 0;
      }
    }
    for (const id of own) charged.add(id);
  }

  let wastedSessions = 0;
  for (const session of inRange) {
    if (charged.has(session.id)) continue;
    if (!wasWasted(session, { pulls: all, tasks, yieldOf, onSomePull })) continue;
    wastedSessions += 1;
    cents += session.counts?.cost ?? 0;
    tokens += session.counts?.tokens ?? 0;
  }

  return {
    cents: round(cents),
    tokens,
    share: total.cents > 0 ? cents / total.cents : null,
    pulls: wastedPulls,
    sessions: wastedSessions,
    total: { cents: round(total.cents), tokens: total.tokens },
  };
}

/**
 * Everything this module has to say about a range, in one answer - what the
 * Performance page's cost panel is drawn from.
 *
 * The cost of a pull request is the one on its record, put there when it
 * folded (pull-cost-fold.js); a caller with costs of its own hands in
 * `costs` instead. `yieldOf` is performance.js's, so that "never landed"
 * means the same thing here as it does in the panel above this one - see
 * docs/measures.md on why there are two ways to add that up and why the page
 * shows one of them.
 */
export function summaryOf(pulls, sessions, { yieldOf = null, tasks = [], since = 0, costs = (pull) => pull?.cost ?? null } = {}) {
  const merged = (pulls ?? []).filter((pull) => pull && isMerged(pull));
  return {
    perMerged: perMergedPull(pulls, costs),
    perKind: perKind(pulls, costs),
    phases: phaseTotals(merged, costs),
    waste: wasteOf(pulls, costs, sessions, { yieldOf, tasks, since }),
  };
}

/** Whether a session's spend bought nothing - PR A's verdict when there is one, the simple rule otherwise. */
function wasWasted(session, { pulls, tasks, yieldOf, onSomePull }) {
  if (yieldOf) return WASTED_YIELDS.includes(yieldOf(session, pulls, tasks));
  if (onSomePull.has(session.id)) return false;
  if ((session.pulls ?? []).length) return false;
  const ids = new Set(session.taskIds ?? []);
  if (!ids.size) return true;
  // A task record it finished is something to show for the money; one still
  // going is not yet, and one that failed never will be.
  return !(tasks ?? []).some((task) => ids.has(task?.id) && task?.state === "done");
}
