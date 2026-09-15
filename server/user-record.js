// The account's row, and the only thing that writes it.
//
// One row per person in the users table, holding everything that belongs to an
// account rather than to a repo. What lives on it so far: the answer to
// "do you write code?" (profile.js), the sandbox templates they have saved
// (sandbox-templates.js), and their free machines (machine-pool.js).
//
// It is one row on purpose. Production is DynamoDB, a new table means a new
// IAM statement and a deploy that has to land in the right order, and none of
// these are big or read by anyone but their owner. connectors/store.js made
// the same trade for credentials.
//
// The catch, and the reason this module exists rather than three modules each
// being careful: **`putProfile` replaces the whole item.** A writer that sends
// only its own field deletes the other two. That bug is silent, it is delayed,
// and it surfaces somewhere unrelated - saving a template puts the "do you
// write code?" question back in front of somebody who answered it in March.
//
// So there is one reader, one writer, and one cache. Writes are serialised per
// account: two callers patching different fields at the same moment would
// otherwise both read the old row and the second would write the first's
// change away, which is the same bug in a smaller window.
import { store } from "./store/index.js";

/**
 * Rows by account, held for the life of the process.
 *
 * Read on every session, on every agent turn, and whenever a sandbox is
 * created; written a handful of times ever. The same trade the repo
 * registry already makes.
 */
const rows = new Map(); // user -> record

/** In-flight writes, so two patches of one row cannot interleave. */
const writing = new Map(); // user -> Promise

/**
 * The account's row, or null if there has never been one.
 *
 * Null and "a row with nothing in it" have to stay different things: the
 * level question is put to anybody with no answer recorded, and a row that
 * read as empty rather than absent would ask a developer again on every
 * machine, forever.
 *
 * Throws if the store cannot be read. Callers decide what that means - for a
 * preference it means "carry on as you were", and for a list of things
 * somebody owns it means "say so", because the next write would otherwise
 * make an empty read true.
 */
export async function read(user) {
  if (!user) return null;
  if (rows.has(user)) return rows.get(user);
  const record = (await store.loadProfile(user)) ?? null;
  rows.set(user, record);
  return record;
}

/** One field of it, with a fallback. Never throws. */
export async function field(user, name, fallback = null) {
  try {
    return (await read(user))?.[name] ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Change some of the row, keeping the rest.
 *
 * Queued behind any write already in flight for this account, and the row is
 * re-read inside the queue rather than outside it - a patch that read before
 * waiting would be applying its change to a row that has since moved.
 */
export function patch(user, fields) {
  if (!user) return Promise.resolve(null);
  const next = (writing.get(user) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const existing = (await read(user)) ?? {};
      const record = { ...existing, ...fields, user };
      await store.putProfile(record);
      rows.set(user, record);
      return record;
    });

  // Only clear the slot if nothing else has queued behind us meanwhile.
  writing.set(user, next);
  next.finally(() => {
    if (writing.get(user) === next) writing.delete(user);
  }).catch(() => {});
  return next;
}

/**
 * Delete the row entirely - the account is being reset.
 *
 * Everything on it goes, which is what a reset is for. Anything the row
 * *names* that lives elsewhere (a template's tarball in S3) has to be dealt
 * with before this, or it is orphaned with nothing left pointing at it.
 */
export async function drop(user) {
  if (!user) return;
  await store.deleteProfile(user);
  rows.set(user, null);
}

/**
 * What is already in memory for an account, without a read. Null when the
 * row has never been read here - which is not "no row", and callers that
 * need the difference read instead.
 */
export const cached = (user) => (user && rows.has(user) ? rows.get(user) : null);

/** Every account whose row this process has read. */
export const cachedUsers = () => [...rows.keys()];

/** For tests, and for a sign-out that should not leave the last person cached. */
export function forget(user) {
  if (user) rows.delete(user);
  else rows.clear();
}
