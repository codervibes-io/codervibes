// Working out what a pull request cost, from the things that know.
//
// pull-cost.js is the arithmetic and nothing else: records and entries in,
// numbers out. This is the half that goes and fetches - the spans of every
// session linked to the pull request, the task record behind it, the
// tracker issue it names - so that the arithmetic stays testable without a
// store and this stays small enough to read.
//
// It is called when a pull request folds (pulls.js `apply`), which is a few
// times in a pull request's life and not on any page read: the cost lands on
// the record and every reader after that gets it for free.
//
// ## Where the entries come from, and what happens when they are gone
//
// A session's model calls are its `model.call` spans, which carry the
// tokens, the model and, where a gateway said one, the price. `spans.js`
// keeps them for thirty days in the store and a few thousand in memory, and
// `costs.js entriesFromSpan` is the one function that turns one into a
// ledger entry - reused here rather than re-read, so a span that stops
// carrying a price stops carrying it in both places at once.
//
// The plan said "spans for recent sessions and the ledger otherwise". The
// ledger cannot answer that: its entries are keyed by task and agent, not by
// session, so "what did session X spend" is a question it has no index for -
// and it is in memory only, so after a restart it knows less than the spans
// do, not more. So the rule is simpler and is stated on the record: the
// phase split is made from spans, and a pull request whose sessions' spans
// have aged out of the thirty-day window gets no cost rather than a guessed
// one. `spanned` and `sessions` on the cost say how many of its sessions
// were still readable, so a page can show "over 1 of 2 sessions" instead of
// quietly presenting half a bill as a whole one.
import { forSession } from "./spans.js";
import { entriesFromSpan } from "./costs.js";
import { costByPhase, phasesOf, explainWorkKind, ticketKeyOf } from "./pull-cost.js";
import * as sessionLog from "./sessions.js";

/** How many spans of one session are read. A long session is thousands; the cost of the tail is a rounding error. */
export const SPAN_LIMIT = 2000;

/** The entries of one session: its spans, through the ledger's own reader. */
export async function entriesForSession(sessionId) {
  const spans = await forSession(sessionId, { limit: SPAN_LIMIT }).catch(() => []);
  return spans.flatMap((span) => entriesFromSpan(span));
}

/**
 * What one pull request cost, by phase, or null when nothing can say.
 *
 * Null and not a row of noughts: a pull request whose spans are gone has an
 * unknown cost, and nought is a claim.
 */
export async function costFor(pull) {
  const ids = [...new Set(pull?.sessionIds ?? [])];
  if (!ids.length) return null;
  const perSession = new Map();
  for (const id of ids) perSession.set(id, await entriesForSession(id));
  const spanned = [...perSession.values()].filter((entries) => entries.length).length;
  if (!spanned) return null;
  const cost = costByPhase([...perSession.values()].flat(), phasesOf(pull));
  if (!cost.total.calls) return null;
  return { ...cost, spanned, sessions: ids.length };
}

/**
 * The task record a pull request is the outcome of, if this process holds
 * one. Imported at call time because the registry imports pulls.js, which
 * imports this - a cycle at load, not a cycle once everything is loaded.
 */
async function taskFor(pull) {
  const ids = pull?.taskIds ?? [];
  if (!ids.length) return null;
  try {
    const [{ repos }, { allTasks }] = await Promise.all([import("./repos.js"), import("./agent-tasks.js")]);
    return allTasks(repos).find((task) => ids.includes(task.id)) ?? null;
  } catch {
    return null;
  }
}

/**
 * The tracker issue a pull request names, asked as the person whose session
 * opened it.
 *
 * Only when there is an identifier to ask about, and only when that person
 * has Linear connected - the same rule task-ticket.js works by: a ticket can
 * be read here only where the person could already read it themselves.
 * Never fatal, and never retried: an issue nobody could fetch means the kind
 * falls through to the title, which is a worse answer and not a broken one.
 */
export async function issueFor(pull, { task = null, key = null } = {}) {
  const identifier = key ?? ticketKeyOf({ title: pull?.title, headRef: pull?.headRef, task });
  if (!identifier) return null;
  const owner = await ownerOf(pull);
  if (!owner) return null;
  try {
    const [{ credentialFor }, { issueKind }] = await Promise.all([
      import("./connectors/store.js"),
      import("./connectors/linear.js"),
    ]);
    const credential = await credentialFor(owner, "linear");
    if (!credential?.token) return null;
    return await issueKind(credential.token, identifier);
  } catch (err) {
    console.warn(`pull-cost: could not ask Linear about ${identifier}: ${err.message}`);
    return null;
  }
}

/** Whose pull request this is: the owner of a session that worked on it. */
async function ownerOf(pull) {
  for (const id of pull?.sessionIds ?? []) {
    const session = await sessionLog.get(id).catch(() => null);
    if (session?.owner) return session.owner;
  }
  return null;
}

/**
 * Work out a pull request's cost and its kind of work, and put them on the
 * record. Says whether anything changed, so the caller can decide whether
 * to save.
 *
 * The kind is settled once and then left alone: a title is edited, a task is
 * linked later, and a figure that moves under a reader who is comparing two
 * numbers is worse than one that is a little stale. Recompute it by clearing
 * `workKind`. The cost is worked out again every time it is asked for,
 * because it is a running total until the pull request closes.
 */
export async function note(record, { withIssue = true } = {}) {
  let changed = false;
  const task = await taskFor(record);

  if (!record.workKind) {
    const issue = withIssue ? await issueFor(record, { task }) : null;
    const { kind, from } = explainWorkKind({
      task,
      issue,
      title: record.title,
      headRef: record.headRef,
      author: record.author,
    });
    // `unknown` is written down like any other answer, so the next fold does
    // not go and ask Linear all over again about a pull request nobody
    // classified. A page that wants to try again clears the field.
    record.workKind = kind;
    record.workKindFrom = from;
    changed = true;
  }

  const cost = await costFor(record);
  if (cost && JSON.stringify(cost) !== JSON.stringify(record.cost ?? null)) {
    record.cost = cost;
    changed = true;
  }
  return changed;
}
