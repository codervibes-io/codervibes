// The account's agents: one record each, on the owner's row.
//
// An agent used to be a thing inside a repo. Its record sat in
// `repo.agents[]`, and an agent granted three repos was three copies of that
// record with the same id and the same token and three permission lists,
// one per copy (repos.js `grantAgent`). That made a repo the unit an agent
// was defined by, and it stopped being true the day the Executors page
// listed agents beside laptop harnesses and vendor bots, none of which are
// anybody's repo's: an agent is the owner's, it *works in* repos.
//
// So the record is here, on the users row beside the harnesses
// (harnesses.js made the same move first), and a repo holds only
// membership - which agents may work there, see repos.js `agentIn`. One
// record, one permission grant, one place to say where it runs and who
// invited it.
//
// What is kept, and why:
//   - `permissions`: the one grant. It used to be per repo, on the argument
//     that trust in a scratch repo is not trust in a real one. The *where*
//     is still explicit - a token reaches only the repos the agent is a
//     member of, never everything its owner owns - but the *what* is one
//     list, because the person editing it thinks of the agent, not the copy.
//   - `resident`: where it lives, for one that lives somewhere - the repo
//     and the sandbox, and the epoch that is half of its credential. A
//     resident is in one repo by construction: its credential is bound to a
//     sandbox, and a sandbox is in one repo.
//   - `createdBy`: who invited it. The answer to "where did this come from"
//     on a page that lists everything doing work.
//   - `tokenHash`: an invited agent's bearer credential, SHA-256 only, so
//     the store cannot leak a working token. Compared in constant time.
//
// A record written before this module lives in `repo.agents[]` in the old
// shape. repos.js reads both - an entry that still carries the record's
// fields *is* the record - and moves the old ones here as it loads, so a
// rollout needs no step and an old fixture in a test needs no change.
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { read as readRow, patch as patchRow, cached as cachedRow } from "./user-record.js";
import { funName } from "./agent-names.js";

export class AgentError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** An invited agent's token starts with this; see `mint`. */
export const TOKEN_PREFIX = "cva_";

/** How many agents one account may keep. They cost nothing until they connect. */
export const MAX_AGENTS = Number(process.env.CODERVIBES_MAX_AGENTS ?? 40);

export const hashToken = (token) => createHash("sha256").update(String(token)).digest("hex");

/** Constant-time compare of two hex digests of equal length. */
export function sameHash(a, b) {
  const left = Buffer.from(String(a ?? ""), "utf8");
  const right = Buffer.from(String(b ?? ""), "utf8");
  if (left.length !== right.length || !left.length) return false;
  return timingSafeEqual(left, right);
}

/** 32 bytes: this is a bearer credential with no second factor behind it. */
const mint = () => `${TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;

const normalizeEmail = (email) => String(email ?? "").trim().toLowerCase();

/**
 * The name as given, which may be nothing.
 *
 * An empty name used to be refused - "An agent needs a name" - and what a
 * person did about it was type something they had not thought about, which
 * is where "test" and "agent 2" come from. Nothing given is answered with a
 * name of the app's own instead (agent-names.js), chosen where the list it
 * has to be unique in is in hand.
 */
const cleanName = (name) => {
  const trimmed = String(name ?? "").trim();
  if (trimmed.length > 60) throw new AgentError("That name is too long (60 characters max)");
  return trimmed;
};

/**
 * Whether an entry in `repo.agents[]` is the record itself, from before the
 * record lived here. Anything that carries a credential, a home or a grant
 * is; a membership entry carries none of them.
 */
export const isLegacy = (entry) =>
  Boolean(entry) &&
  ("tokenHash" in entry || "resident" in entry || Array.isArray(entry.permissions) || "capabilities" in entry);

/**
 * The membership entry a repo keeps for an agent: enough to list it and to
 * say when and by whom it was let in here. The name is denormalised so a
 * build from before this module still lists something - it is display, not
 * identity, and the record's name wins wherever both are read.
 */
export function memberOf(record, { createdAt = null, createdBy = null, movedHereAt = null } = {}) {
  return {
    id: record.id,
    name: record.name,
    createdAt: createdAt ?? new Date().toISOString(),
    createdBy: createdBy ?? record.createdBy ?? null,
    ...(movedHereAt ? { movedHereAt } : {}),
  };
}

// ------------------------------------------------------------- reading

/** The account's agents as stored. */
async function stored(user) {
  if (!user) return [];
  const row = await readRow(user).catch(() => null);
  return (row?.agents ?? []).filter(Boolean);
}

/**
 * What is in memory for an account, without a read. Empty when the row has
 * never been read here - which is not "no agents"; `warm` first, which
 * repos.js does for every owner it loads.
 */
export const cached = (user) => (cachedRow(normalizeEmail(user))?.agents ?? []).filter(Boolean);

/** Read the row, so the synchronous readers below can answer for this account. */
export async function warm(user) {
  if (!user) return [];
  return stored(normalizeEmail(user));
}

export async function listFor(user) {
  return stored(normalizeEmail(user));
}

/** One agent of this account's, from memory. Null when unknown - or not yet read. */
export function get(user, id) {
  const wanted = String(id ?? "");
  return cached(user).find((entry) => entry.id === wanted) ?? null;
}

export async function find(user, id) {
  const wanted = String(id ?? "");
  return (await stored(normalizeEmail(user))).find((entry) => entry.id === wanted) ?? null;
}

/** The agent this token hashes to, if it is one of this account's. Memory only. */
export function findByTokenHash(user, hash) {
  return cached(user).find((entry) => entry.tokenHash && sameHash(entry.tokenHash, hash)) ?? null;
}

// ------------------------------------------------------------- writing

/**
 * Change the account's list, in place, and persist it.
 *
 * Every writer goes through this and mutates *the one array the row cache
 * holds* rather than a copy of it. Two reasons. A caller that does not wait
 * - a timestamp from a tool call (resident.js `keepAwake`) - must see its
 * change on its next read, which is before the write lands. And two writers
 * queued behind each other must not each have computed a whole list from
 * before the other: a `remove` whose list was read before an `update` wrote
 * its own put the removed record straight back. user-record serialises the
 * writes per account; this makes what they write the same array, so the
 * order they land in cannot undo one another.
 */
async function mutateAgents(user, mutate) {
  let list = cachedRow(user)?.agents;
  if (!Array.isArray(list)) {
    await readRow(user).catch(() => null);
    list = cachedRow(user)?.agents;
  }
  if (!Array.isArray(list)) list = [];
  const outcome = mutate(list);
  if (outcome === false) return false;
  await patchRow(user, { agents: list });
  return outcome;
}

/**
 * Invite one: a name, a grant, and the token it will present - returned
 * once, here, and never readable again.
 *
 * @param {string} owner
 * @param {{name?: string, permissions: string[], invitedBy?: string}} spec
 *   `permissions` is already normalised for this owner (repos.js grantFrom).
 */
export async function add(owner, { name, permissions, invitedBy = null }) {
  const user = normalizeEmail(owner);
  if (!user) throw new AgentError("Nobody is signed in", 401);
  const asked = cleanName(name);
  const token = mint();
  // The record is built inside the mutation because the name may not exist
  // yet: one nobody gave is drawn here, against the list it has to be
  // unique in rather than against a stale read of it.
  let record = null;
  await mutateAgents(user, (list) => {
    const taken = list.map((entry) => entry?.name).filter(Boolean);
    const trimmed = asked || funName(taken);
    if (taken.includes(trimmed)) throw new AgentError(`You already have an agent called '${trimmed}'`);
    if (list.length >= MAX_AGENTS) throw new AgentError(`An account can hold at most ${MAX_AGENTS} agents.`, 403);
    record = {
      id: randomBytes(8).toString("hex"),
      name: trimmed,
      kind: "invited",
      permissions: Array.isArray(permissions) ? [...permissions] : [],
      tokenHash: hashToken(token),
      createdAt: new Date().toISOString(),
      createdBy: normalizeEmail(invitedBy) || user,
      lastSeenAt: null,
      resident: null,
      movedTo: null,
    };
    list.push(record);
  });
  return { agent: record, token };
}

/**
 * Seat one in a sandbox. No token: its credential is signed per start from
 * the epoch here (resident.js `signCredential`), and stops resolving the
 * moment the record goes.
 *
 * @param {string} owner
 * @param {{name?: string, permissions: string[], repoId: string, sandboxId: string,
 *   startedBy: object, origin?: string|null, model?: string|null, dormant?: boolean}} spec
 */
export async function addResident(owner, { name, permissions, repoId, sandboxId, startedBy, origin = null, model = null, dormant = false }) {
  const user = normalizeEmail(owner);
  if (!user) throw new AgentError("Nobody is signed in", 401);
  const asked = cleanName(name);
  // Built inside the mutation for the same reason `add` is: a resident
  // nobody named draws one against the list it joins.
  let record = null;
  const build = (trimmed) => ({
    id: randomBytes(8).toString("hex"),
    name: trimmed,
    kind: "resident",
    permissions: Array.isArray(permissions) ? [...permissions] : [],
    createdAt: new Date().toISOString(),
    createdBy: startedBy?.email ? normalizeEmail(startedBy.email) : `agent:${startedBy?.name ?? "?"}`,
    lastSeenAt: null,
    resident: {
      repoId: String(repoId),
      sandboxId: String(sandboxId),
      startedAt: dormant ? null : new Date().toISOString(),
      // Who may stop it, besides its owner: the agent that started it is
      // recorded by id so a same-named agent made later does not inherit
      // the right.
      startedBy: {
        kind: startedBy?.email ? "user" : "agent",
        id: startedBy?.email ? normalizeEmail(startedBy.email) : String(startedBy?.id ?? ""),
        name: startedBy?.name ?? startedBy?.email ?? "?",
      },
      // Part of the credential. A new one is minted per start, so a
      // credential from a previous life of an agent with this name does not
      // verify against this one.
      epoch: randomBytes(8).toString("hex"),
      ...(origin ? { origin: String(origin) } : {}),
      ...(model ? { model: String(model) } : {}),
    },
    movedTo: null,
  });
  await mutateAgents(user, (list) => {
    const taken = list.map((entry) => entry?.name).filter(Boolean);
    const trimmed = asked || funName(taken);
    if (taken.includes(trimmed)) throw new AgentError(`You already have an agent called '${trimmed}'`);
    if (list.some((entry) => entry?.resident?.sandboxId === String(sandboxId) && entry?.resident?.repoId === String(repoId))) {
      throw new AgentError(`Sandbox '${sandboxId}' already has an agent living in it`);
    }
    if (list.length >= MAX_AGENTS) throw new AgentError(`An account can hold at most ${MAX_AGENTS} agents.`, 403);
    record = build(trimmed);
    list.push(record);
  });
  return record;
}

/**
 * Change a record: `mutate` is handed the stored copy and says whether it
 * changed anything, so a note that finds nothing to note writes nothing.
 * Returns the record as it now is, or null for one this account does not have.
 */
export async function update(owner, id, mutate) {
  const user = normalizeEmail(owner);
  let record = null;
  await mutateAgents(user, (list) => {
    record = list.find((entry) => entry?.id === String(id)) ?? null;
    if (!record) return false;
    return mutate(record);
  });
  return record;
}

/** Forget one. Its token, or its credential, stops resolving with it. */
export async function remove(owner, id) {
  const user = normalizeEmail(owner);
  let gone = null;
  await mutateAgents(user, (list) => {
    const index = list.findIndex((entry) => entry?.id === String(id));
    if (index < 0) return false;
    [gone] = list.splice(index, 1);
  });
  return gone;
}

/** Everything this account has, gone - the account is being reset. */
export async function removeAll(owner) {
  const user = normalizeEmail(owner);
  await mutateAgents(user, (list) => {
    if (!list.length) return false;
    list.length = 0;
  });
}

// ---------------------------------------------------------- migration

/**
 * Take a record from the old shape - an entry of `repo.agents[]` that is the
 * record itself - onto the row. Called once per copy as repos load; the
 * copies of one invited agent (one per repo it was granted) fold into one
 * record: the earliest invitation is the invitation, the newest move is the
 * move, and the grant is the union of what the copies held - since the one
 * list has to let it do everything it could do anywhere.
 *
 * Idempotent, and it never takes a field away from a record already here:
 * a copy still in the store from an older process must not undo what this
 * one has since written.
 */
export async function upsertFromLegacy(owner, entry, { repoId, permissions }) {
  const user = normalizeEmail(owner);
  if (!user || !entry?.id) return null;
  const grant = Array.isArray(permissions) ? permissions : [];
  let record = null;
  await mutateAgents(user, (all) => {
    const held = all.find((item) => item?.id === String(entry.id)) ?? null;
    record = held ?? {
      id: String(entry.id),
      name: String(entry.name ?? entry.id),
      kind: entry.resident ? "resident" : "invited",
      permissions: [],
      createdAt: entry.createdAt ?? new Date().toISOString(),
      createdBy: entry.createdBy ?? null,
      lastSeenAt: null,
      resident: null,
      movedTo: null,
    };
    if (entry.tokenHash && !record.tokenHash) record.tokenHash = entry.tokenHash;
    // What the owner granted for a while (access-requests.js) comes along,
    // once each: a grant is named by the request that made it.
    for (const grant of Array.isArray(entry.grants) ? entry.grants : []) {
      const held = record.grants ?? (record.grants = []);
      const same = (other) => (grant.requestId && other.requestId === grant.requestId) || (other.id === grant.id && other.until === grant.until);
      if (!held.some(same)) held.push(structuredClone(grant));
    }
    if (entry.createdAt && (!record.createdAt || entry.createdAt < record.createdAt)) {
      record.createdAt = entry.createdAt;
      if (entry.createdBy) record.createdBy = entry.createdBy;
    }
    if (!record.createdBy && entry.createdBy) record.createdBy = entry.createdBy;
    if (entry.lastSeenAt && (!record.lastSeenAt || entry.lastSeenAt > record.lastSeenAt)) record.lastSeenAt = entry.lastSeenAt;
    if (entry.resident && !record.resident) {
      record.kind = "resident";
      record.resident = { ...structuredClone(entry.resident), repoId: String(entry.resident.repoId ?? repoId) };
    }
    if (entry.movedHereAt && (!record.movedTo || entry.movedHereAt > record.movedTo.at)) {
      record.movedTo = { repoId: String(repoId), at: entry.movedHereAt };
    }
    for (const id of grant) if (!record.permissions.includes(id)) record.permissions.push(id);
    if (!held) all.push(record);
  });
  return record;
}

/** Never the token, or its hash, or the epoch: this object goes to the browser. */
export function describeAgent(record) {
  if (!record) return null;
  return {
    id: record.id,
    name: record.name,
    kind: record.kind ?? (record.resident ? "resident" : "invited"),
    permissions: [...(record.permissions ?? [])],
    createdAt: record.createdAt ?? null,
    createdBy: record.createdBy ?? null,
    lastSeenAt: record.lastSeenAt ?? null,
    resident: record.resident
      ? {
          repoId: record.resident.repoId ?? null,
          sandboxId: record.resident.sandboxId,
          startedAt: record.resident.startedAt ?? null,
          startedBy: record.resident.startedBy ?? null,
          model: record.resident.model ?? null,
          engine: record.resident.engine ?? null,
          harness: record.resident.harness ?? null,
          harnessId: record.resident.harnessId ?? null,
        }
      : null,
    movedTo: record.movedTo ?? null,
  };
}
