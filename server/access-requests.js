// An agent asks for a permission it does not hold; its owner decides.
//
// A permission is granted on the agent's page, ahead of time, by a person
// guessing what the work will need (permissions.js). The guess is usually
// right and occasionally short by one: the task turns out to need a merge,
// or a sandbox opened to the internet, and the agent holding "read and run"
// has two choices - fail the task for want of a permission, or find another
// tool that does the same job, which is exactly what the refusal in mcp.js
// `withheld` tells it not to do. Neither is what the owner would have
// wanted. They would have wanted to be asked.
//
// So an agent can ask: `request_access` (collab-tools.js) names the
// permission and why, and the task it is on waits on the answer the way it
// waits on a review (agent-tasks.js "Waiting on a person") - clock stopped,
// row under Needs action, agent stopped. The owner approves it for a
// while or denies it, from the row, and the task comes back with the
// answer as the step the agent reads.
//
// "For a while" is the point. A permission granted because one task needed
// it once is a permission the agent holds for every task after, and nobody
// comes back to take it away - so the grant here is timed: thirty minutes,
// two hours, a day (DURATIONS), and then it is gone, with nothing to
// remember to do. It lives on the agent's record as `grants: [{id, until,
// by, requestId}]`, folded into what the agent may do by repos.js
// `permissionsOf` while it lasts and ignored after; the permanent list the
// owner edits on the agent's page is not touched, so a grant never becomes
// permanent by being saved back from the console. What was asked and what
// was decided stays on the repo (`accessRequests`), so a request shows on
// the agent's page after the fact: who asked for what, when, and what the
// owner said.
//
// Any catalogued permission an agent can hold may be asked for, not only
// the sensitive ones: the owner is the one who decides what is sensitive
// for this repo, and the request says on its face whether the catalogue
// marks it so.
import { randomBytes } from "node:crypto";
// The catalogue as the core reads it; the connector half is registered with
// it by whoever imports permissions.js. See permissions-core.js.
import { catalogue, allows } from "./permissions-core.js";
import { repos, permissionsOf, activeGrants } from "./repos.js";

/** How long an approval lasts, as the owner picks it. */
export const DURATIONS = { "30m": 30 * 60_000, "2h": 2 * 60 * 60_000, "1d": 24 * 60 * 60_000 };
export const DEFAULT_DURATION = "2h";

/** How much of a reason the record keeps. */
export const MAX_REASON = 300;

/** Requests a repo remembers; decided ones older than this are dropped when a new one arrives. */
export const KEEP_MS = 30 * 24 * 60 * 60_000;
export const MAX_REQUESTS = 100;

export class AccessRequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const clean = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** The catalogue entry a request names, for the labels people read. */
export function itemFor(repo, permission) {
  return catalogue({ owner: repo?.owner ?? null }).find((item) => item.id === permission) ?? null;
}

/**
 * A request as the console and the tool result read it: the record plus
 * what the catalogue says of the permission today. The label is looked up
 * rather than stored so a renamed permission reads by its current name.
 */
export function describe(repo, request) {
  if (!request) return null;
  const item = itemFor(repo, request.permission);
  return {
    id: request.id,
    agentId: request.agentId,
    agentName: request.agentName,
    permission: request.permission,
    label: item?.label ?? request.permission,
    group: item?.group ?? null,
    sensitive: Boolean(item?.sensitive),
    known: Boolean(item),
    reason: request.reason,
    taskId: request.taskId ?? null,
    sessionId: request.sessionId ?? null,
    at: request.at,
    state: request.state,
    decidedAt: request.decidedAt ?? null,
    by: request.by ?? null,
    until: request.until ?? null,
    note: request.note ?? null,
  };
}

export const find = (repo, id) => (repo?.accessRequests ?? []).find((entry) => entry.id === id) ?? null;

/** The open requests on a repo, oldest first - the one waited on longest is the one to answer. */
export const open = (repo) =>
  (repo?.accessRequests ?? []).filter((entry) => entry.state === "open").sort((a, b) => String(a.at).localeCompare(String(b.at)));

/**
 * An agent asks. Refused when the permission is not one an agent can hold
 * here, when the agent holds it already (the tool it wanted is in its
 * list; ask the list), and when the same ask is already open - a second
 * request would be a second row asking the owner the same thing. The
 * record is written; blocking the task is the tool's (collab-tools.js),
 * because the task's record is agent-tasks.js's.
 */
export function request(repo, agent, { permission, reason, taskId = null, sessionId = null }) {
  const id = clean(permission, 120);
  const item = itemFor(repo, id);
  if (!item || !item.forAgents) throw new AccessRequestError(`No permission '${id}' an agent can hold here. Ask for one by its id, as the refusal named it.`);
  if (allows(permissionsOf(repo, agent), id)) throw new AccessRequestError(`'${agent.name}' already holds '${id}' in this repo.`);
  const why = clean(reason, MAX_REASON);
  if (!why) throw new AccessRequestError("Say why: what the task needs it for. The owner decides from that line.");
  const already = open(repo).find((entry) => entry.agentId === agent.id && entry.permission === id);
  if (already) throw new AccessRequestError(`'${agent.name}' has already asked for '${id}' (${already.id}); that request is waiting on the owner.`);

  const now = Date.now();
  repo.accessRequests = (repo.accessRequests ?? []).filter(
    (entry) => entry.state === "open" || now - Date.parse(entry.decidedAt ?? entry.at) < KEEP_MS,
  );
  const record = {
    id: `ar_${randomBytes(6).toString("hex")}`,
    agentId: agent.id,
    agentName: agent.name,
    permission: id,
    reason: why,
    taskId: taskId ? String(taskId) : null,
    // The session that asked, so the access trail (access-trail.js) can
    // link the ask to the work it was for; null for an ask with none.
    sessionId: sessionId ? String(sessionId) : null,
    at: new Date(now).toISOString(),
    state: "open",
  };
  repo.accessRequests.push(record);
  if (repo.accessRequests.length > MAX_REQUESTS) {
    // The oldest decided ones go first; an open one is never dropped.
    const decided = repo.accessRequests.filter((entry) => entry.state !== "open");
    const drop = new Set(decided.slice(0, repo.accessRequests.length - MAX_REQUESTS).map((entry) => entry.id));
    repo.accessRequests = repo.accessRequests.filter((entry) => !drop.has(entry.id));
  }
  return record;
}

/**
 * The owner decides. An approval writes a timed grant on the agent's record
 * in this repo; a denial writes nothing but the answer. Either closes the
 * request; a request decided once is not decided again. The note, when
 * there is one, is for the agent: "use the pull request instead".
 */
export function decide(repo, id, { by, approve, duration = DEFAULT_DURATION, note = "" }) {
  const record = find(repo, id);
  if (!record) throw new AccessRequestError(`No access request ${id} in this repo`, 404);
  if (record.state !== "open") throw new AccessRequestError(`That request was already ${record.state}.`);
  const forMs = DURATIONS[duration];
  if (approve && !forMs) throw new AccessRequestError(`An approval lasts one of: ${Object.keys(DURATIONS).join(", ")}.`);
  // The record, wherever it lives (repos.js `agentIn`): the grant goes on
  // the agent, which is the owner's, and reads in every repo it works in.
  const agent = repos.agentIn(repo, record.agentId);
  if (approve && !agent) throw new AccessRequestError(`'${record.agentName}' is no longer in this repo; there is nobody to grant it to.`, 404);

  const now = new Date();
  record.state = approve ? "approved" : "denied";
  record.decidedAt = now.toISOString();
  record.by = by ?? null;
  record.note = clean(note, MAX_REASON) || null;
  if (approve) {
    record.until = new Date(now.getTime() + forMs).toISOString();
    record.duration = duration;
    // One live grant per permission: approving again while one lasts
    // replaces it, which is the longer of the two by construction.
    agent.grants = [
      ...(agent.grants ?? []).filter((grant) => grant.id !== record.permission && Date.parse(grant.until) > now.getTime()),
      { id: record.permission, until: record.until, by: by ?? null, requestId: record.id },
    ];
    // Changed in memory above, on the one copy every reader shares; this is
    // what puts it in the store. Not waited for - the request's own record
    // is saved by the caller, and the grant is already in force.
    repos.writeAgent(repo, agent.id, (held) => {
      held.grants = [...agent.grants];
    }, { quiet: true }).catch(() => {});
  }
  return record;
}

/** The grants an agent holds right now in a repo, for its page. */
export function grantsOf(repo, agent, now = Date.now()) {
  return activeGrants(agent, now).map((grant) => ({ ...grant, label: itemFor(repo, grant.id)?.label ?? grant.id }));
}

/** A duration as a sentence reads it. */
export const durationLabel = (duration) =>
  ({ "30m": "30 minutes", "2h": "2 hours", "1d": "a day" })[duration] ?? duration;
