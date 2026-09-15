// An action the owner approves by hand, one call at a time.
//
// A permission says what an agent may do; a grant of it lasts until it is
// taken away, and a timed grant (access-requests.js) until it runs out. Both
// answer "may it merge" once, ahead of time, for every merge after. Some
// actions are not like that. Merging to main, posting to the team's channel,
// filing a ticket under the owner's name: the owner wants each one in front
// of them, with the arguments, before it happens - not because the agent may
// not do it, but because *this one* is what they are deciding about.
//
// So a permission an agent holds can also be marked "ask first" - on the
// agent's record, as `askFirst: [id]`, edited on its Access tab. A call
// under one of those does not run. It is written here as an approval, with
// the tool, the arguments as given, and one line saying what they amount
// to; it goes to Home under Needs action; and the call waits a little for
// the answer (mcp.js `approvalGate`) before telling the agent to call again
// with the same arguments. The owner presses Approve or Deny on the row.
// An approval is for that call - the same tool with the same arguments,
// hashed - and is used up by running it once; the next call, however alike,
// asks again. An approval nobody uses lapses after USE_MS, because an
// approval that outlives the reasoning that asked for it has become a
// standing grant, which is the thing this exists to not be. A denial
// answers the same call for DENIAL_MS, so a model that retries what it
// was refused is told the same thing rather than asking the owner twice.
//
// This is deliberately not request_access. That asks for a permission and
// gets one for a while; this asks for one action and gets that action. The
// two are told apart in the console by their shape: a request says a
// permission's name, an approval shows the arguments.
import { createHash, randomBytes } from "node:crypto";
// The catalogue as the core reads it - the connector half is registered
// with it by whoever imports permissions.js, so this sees the same rows
// without the registry behind them. See permissions-core.js.
import { catalogue, allows } from "./permissions-core.js";
import { summarize } from "./agent-activity.js";
import { wake } from "./wake.js";

/** An approval that is not used within this long is gone. */
export const USE_MS = Number(process.env.CODERVIBES_APPROVAL_USE_MS ?? 15 * 60_000);
/** A denial answers the same call for this long. */
export const DENIAL_MS = Number(process.env.CODERVIBES_APPROVAL_DENIAL_MS ?? 15 * 60_000);
/** How long a gated call holds on for the answer before telling the agent to call again. */
export const WAIT_MS = Number(process.env.CODERVIBES_APPROVAL_WAIT_MS ?? 20_000);

/** How much of the arguments the record keeps, as JSON. */
export const MAX_ARGS_CHARS = 4000;
export const MAX_NOTE = 300;
/** Approvals a repo remembers; decided ones older than this are dropped when a new one arrives. */
export const KEEP_MS = 30 * 24 * 60 * 60_000;
export const MAX_APPROVALS = 200;

export class ActionApprovalError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const clean = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** The wake key a gated call waits on - see wake.js. */
export const wakeKey = (id) => `approval:${id}`;

/**
 * The permissions an agent must ask for per call. Any ids; a permission
 * the agent does not hold is not gated because it is refused first, and
 * one the catalogue has since lost gates nothing.
 */
export const askFirstOf = (agent) =>
  Array.isArray(agent?.askFirst) ? agent.askFirst.map(String).filter(Boolean) : [];

/**
 * A list the owner sent, as it is stored: catalogue ids only, once each, in
 * catalogue order. Not permissions.js `normalize`, which adds the reads a
 * write implies - marking a write "ask first" must not gate the reads.
 */
export function cleanAskFirst(ids, { owner = null } = {}) {
  const wanted = new Set((Array.isArray(ids) ? ids : []).map(String));
  return catalogue({ owner })
    .filter((item) => item.forAgents && wanted.has(item.id))
    .map((item) => item.id);
}

/** Whether a call under `permission` by this agent has to be approved first. */
export const needsApproval = (agent, permission) =>
  permission != null && allows(agent?.permissions, permission) && askFirstOf(agent).includes(permission);

/** JSON with keys in order at every depth, so the same call hashes the same however the model spelled it. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** What one call is: the tool and its arguments, hashed. */
export const keyOf = (tool, args) => createHash("sha256").update(`${tool}\n${canonical(args ?? {})}`).digest("hex").slice(0, 32);

/** The arguments as the record keeps them: the object, or a clipped string when it is too long to keep whole. */
function keptArgs(args) {
  const json = canonical(args ?? {});
  if (json.length <= MAX_ARGS_CHARS) return structuredClone(args ?? {});
  return { _clipped: `${json.slice(0, MAX_ARGS_CHARS)}…` };
}

export const find = (repo, id) => (repo?.approvals ?? []).find((entry) => entry.id === id) ?? null;

/** The open approvals on a repo, oldest first. */
export const open = (repo) =>
  (repo?.approvals ?? []).filter((entry) => entry.state === "open").sort((a, b) => String(a.at).localeCompare(String(b.at)));

/** One agent's approvals in a repo, newest first. */
export const forAgent = (repo, agentId, limit = 20) =>
  (repo?.approvals ?? []).filter((entry) => entry.agentId === agentId).slice(-limit).reverse();

const labelOf = (repo, permission) =>
  catalogue({ owner: repo?.owner ?? null }).find((item) => item.id === permission)?.label ?? permission;

/** An approval as the console and the tool result read it. */
export function describe(repo, record) {
  if (!record) return null;
  return {
    id: record.id,
    agentId: record.agentId,
    agentName: record.agentName,
    tool: record.tool,
    permission: record.permission,
    label: labelOf(repo, record.permission),
    args: record.args,
    summary: record.summary,
    taskId: record.taskId ?? null,
    sessionId: record.sessionId ?? null,
    at: record.at,
    state: record.state,
    decidedAt: record.decidedAt ?? null,
    by: record.by ?? null,
    note: record.note ?? null,
    usedAt: record.usedAt ?? null,
  };
}

/**
 * An approved call that was never made lapses; written on the record when
 * it is next looked at, so the page says "lapsed" rather than "approved"
 * for something that will not run.
 */
function settle(record, now) {
  if (record.state === "approved" && now - Date.parse(record.decidedAt) >= USE_MS) {
    record.state = "lapsed";
  }
  return record;
}

/**
 * A gated call arrives. One of four answers, and the record it rests on:
 *
 *   run    - an approval for this exact call is live; it is used up here
 *            and the caller runs the tool
 *   wait   - the same call is already in front of the owner
 *   denied - the owner said no to this call, recently enough to still mean it
 *   asked  - nothing was pending, so a new approval is written and the
 *            caller puts it in front of the owner
 *
 * The record is changed in memory; saving the repo is the caller's, since
 * a tool call's result and its save are one transaction there.
 */
export function check(repo, agent, { tool, permission, args = {}, taskId = null, sessionId = null }, now = Date.now()) {
  const key = keyOf(tool, args);
  const mine = (repo.approvals ?? []).filter((entry) => entry.agentId === agent.id && entry.key === key).map((entry) => settle(entry, now));

  const approved = mine.find((entry) => entry.state === "approved");
  if (approved) {
    approved.state = "done";
    approved.usedAt = new Date(now).toISOString();
    return { verdict: "run", record: approved };
  }
  const pending = mine.find((entry) => entry.state === "open");
  if (pending) return { verdict: "wait", record: pending };
  const denied = mine
    .filter((entry) => entry.state === "denied" && now - Date.parse(entry.decidedAt) < DENIAL_MS)
    .sort((a, b) => String(b.decidedAt).localeCompare(String(a.decidedAt)))[0];
  if (denied) return { verdict: "denied", record: denied };

  repo.approvals = (repo.approvals ?? []).filter(
    (entry) => entry.state === "open" || now - Date.parse(entry.decidedAt ?? entry.at) < KEEP_MS,
  );
  const record = {
    id: `ap_${randomBytes(6).toString("hex")}`,
    agentId: agent.id,
    agentName: agent.name,
    tool,
    permission,
    args: keptArgs(args),
    key,
    summary: summarize(tool, args ?? {}),
    taskId: taskId ? String(taskId) : null,
    // The session the call was made in (access-trail.js links the ask to it).
    sessionId: sessionId ? String(sessionId) : null,
    at: new Date(now).toISOString(),
    state: "open",
  };
  repo.approvals.push(record);
  if (repo.approvals.length > MAX_APPROVALS) {
    // The oldest decided ones go first; an open one is never dropped.
    const decided = repo.approvals.filter((entry) => entry.state !== "open");
    const drop = new Set(decided.slice(0, repo.approvals.length - MAX_APPROVALS).map((entry) => entry.id));
    repo.approvals = repo.approvals.filter((entry) => !drop.has(entry.id));
  }
  return { verdict: "asked", record };
}

/**
 * The owner decides. Either closes the approval; one decided once is not
 * decided again. The call waiting on it, if one still is, is rung
 * (wake.js) and reads the record. The note is for the agent.
 */
export function decide(repo, id, { by, approve, note = "" }, now = Date.now()) {
  const record = find(repo, id);
  if (!record) throw new ActionApprovalError(`No approval ${id} in this repo`, 404);
  if (record.state !== "open") throw new ActionApprovalError(`That call was already ${record.state}.`);
  record.state = approve ? "approved" : "denied";
  record.decidedAt = new Date(now).toISOString();
  record.by = by ?? null;
  record.note = clean(note, MAX_NOTE) || null;
  wake(wakeKey(record.id), { approval: record.id, state: record.state });
  return record;
}

/**
 * The arguments as one line for a person: `number: 12 · method: "squash"`.
 * Long values are cut; the row shows the whole object under it.
 */
export function argsLine(args, max = 200) {
  if (!args || typeof args !== "object") return "";
  const parts = Object.entries(args).map(([key, value]) => {
    const shown = typeof value === "string" ? JSON.stringify(value) : canonical(value);
    return `${key}: ${shown.length > 80 ? `${shown.slice(0, 79)}…` : shown}`;
  });
  const line = parts.join(" · ");
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
