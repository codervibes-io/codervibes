// The event log: what happened, in order, for anybody who wants to know.
//
// Everything that shows somewhere - a line said in a room, an agent's tool
// call, a machine booting, a repo saved - used to
// have its own EventEmitter, and every consumer had to know all of them: the
// console's stream subscribed to four and still missed things, and a second
// consumer would have had to find the same four again. Now there is one
// place to say something happened and one place to hear it, and neither
// side knows about the other.
//
// It is a log, not just a bus. Each event has an id that sorts by time, the
// last few thousand are kept in memory and the durable ones are written to
// the store, so a consumer that was away - a browser whose radio dropped, a
// process that just started - asks for "everything since <id>" and catches
// up, rather than re-reading the world or missing what it did not see. That
// is also what lets more than one process serve consoles: a second instance
// follows the store's tail (`follow`) and republishes what the first wrote,
// so a console on either hears about a line said through the other.
//
// An event names its subject - a repo, an agent, an owner, a list of
// users - and `concerns` says whether a given person may hear it. A consumer
// serving a person applies it; a consumer inside the server (a watcher
// getting an agent up) hears everything. That filter is a security boundary:
// without it the rhythm of nudges would say how busy somebody else's
// repo is.
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { store } from "./store/index.js";

/** How many events stay in memory for `since` to answer from without the store. */
const RING = Number(process.env.CODERVIBES_EVENTS_RING ?? 2000);
/** How long a durable event is kept in the store. Catch-up, not history: a day is generous. */
export const KEEP_MS = Number(process.env.CODERVIBES_EVENTS_KEEP_MS ?? 24 * 60 * 60_000);
/**
 * How often to read the store's tail for events other processes wrote. Off
 * by default: one process publishes to itself directly, and reading the tail
 * is a query per tick for nothing. Set it when more than one instance runs.
 */
export const FOLLOW_MS = Number(process.env.CODERVIBES_EVENTS_FOLLOW_MS ?? 0);

/** This process, so what it reads back from the store it does not hear twice. */
export const ORIGIN = randomBytes(4).toString("hex");

/**
 * Events that happen too often to be worth a store write each: an agent's
 * tool calls come several a second. They are in the ring, so a browser that
 * was away for a moment still catches up; one away for longer re-reads.
 */
// `session.event` is the nudge that a session's log grew - session-events.js
// keeps the log itself, so the nudge has nothing to store.
const EPHEMERAL = new Set(["agent.call", "agent.thinking", "agent.trouble", "session.event", "session.title"]);

const bus = new EventEmitter();
// One listener per open console, one per watcher; a busy server has many.
bus.setMaxListeners(0);

const ring = [];
let seq = 0;

/**
 * An id that sorts by time across processes: the millisecond, then a
 * per-process sequence for events in the same millisecond, then the process.
 */
const idFor = (at, n) => `${String(at).padStart(14, "0")}-${String(n).padStart(6, "0")}-${ORIGIN}`;

/**
 * Say that something happened. Synchronous, never throws: this is called
 * from hot paths and from inside store writes, and a consumer that fails is
 * its own problem.
 *
 * @param {string} type what kind of thing - "agent.activity", "repo.saved"
 * @param {{ repoId?: string|null, agentId?: string|null, owner?: string|null, users?: string[] }} subject
 *   who it is about, which is who may hear it. Empty means everybody.
 * @param {object|null} data whatever a consumer needs to act without re-reading
 * @returns {object} the event, with its id
 */
export function publish(type, subject = {}, data = null) {
  const at = Date.now();
  seq += 1;
  const event = {
    id: idFor(at, seq),
    at,
    type,
    origin: ORIGIN,
    repoId: subject.repoId ?? null,
    agentId: subject.agentId ?? null,
    owner: subject.owner ?? null,
    users: subject.users ?? null,
    data,
  };
  remember(event);
  deliver(event);
  if (!EPHEMERAL.has(type) && store.appendEvent) {
    const write = store
      .appendEvent({ ...event, day: dayOf(at), expires: Math.floor((at + KEEP_MS) / 1000) })
      .catch((err) => console.warn(`event ${type} not stored: ${err.message}`))
      .finally(() => inFlight.delete(write));
    inFlight.add(write);
  }
  return event;
}

/** Store writes that have not landed yet - `publish` does not wait for them. */
const inFlight = new Set();

/**
 * Wait for every event published so far to be in the store. For a shutdown
 * that wants the last thing said to be there for the next process, and for
 * a test that is about to read the store back.
 */
export const flush = () => Promise.allSettled([...inFlight]).then(() => {});

function remember(event) {
  ring.push(event);
  if (ring.length > RING) ring.splice(0, ring.length - RING);
}

function deliver(event) {
  try {
    bus.emit("event", event);
  } catch (err) {
    console.warn(`an event listener failed on ${event.type}: ${err.message}`);
  }
}

/**
 * Where the log is now: a cursor that `since` answers "nothing yet" to,
 * for a consumer that wants to be able to catch up later on what it has
 * not seen anything of yet.
 */
export const cursor = () => idFor(Date.now(), seq);

/**
 * Hear every event from now on, or those a filter lets through.
 *
 * @param {(event: object) => void} handler
 * @param {{ filter?: (event: object) => boolean }} [options]
 * @returns {() => void} stop hearing
 */
export function subscribe(handler, { filter = null } = {}) {
  const listener = (event) => {
    if (filter && !filter(event)) return;
    handler(event);
  };
  bus.on("event", listener);
  return () => bus.off("event", listener);
}

/**
 * Everything after a cursor, oldest first.
 *
 * From memory when the cursor is within the ring, which is the ordinary
 * reconnect; from the store when it is older than that, or when this process
 * started after the cursor was issued. Null cursor is "nothing".
 *
 * @returns {Promise<{ events: object[], complete: boolean }>} `complete` is
 *   false when the cursor predates what can be answered - the caller should
 *   re-read rather than trust the catch-up.
 */
export async function since(cursor, { limit = 500 } = {}) {
  if (!cursor) return { events: [], complete: false };
  const oldest = ring[0];
  if (oldest && oldest.id <= cursor) {
    const events = ring.filter((event) => event.id > cursor);
    return { events: events.slice(0, limit), complete: events.length <= limit };
  }
  if (!store.loadEvents) return { events: [], complete: false };
  // Without the store's own columns: a consumer sees the same shape either way.
  const fromStore = (await store.loadEvents(cursor, { limit: limit + 1 })).map(
    ({ day, expires, ...event }) => event,
  );
  // Those in memory too, deduplicated on id: the ring may hold the newest.
  const seen = new Set(fromStore.map((event) => event.id));
  const events = [...fromStore, ...ring.filter((event) => event.id > cursor && !seen.has(event.id))]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // A day is what the store keeps, so a cursor older than that cannot be
  // answered completely, whatever came back.
  const cursorAt = Number(cursor.slice(0, 14));
  const complete = events.length <= limit && Date.now() - cursorAt < KEEP_MS;
  return { events: events.slice(0, limit), complete };
}

/**
 * Whether one person may hear one event.
 *
 * Named users first, since a private line is private whoever else could see
 * the agent; then the repo, for anybody who can access it; then the
 * agent, for its owner or anybody in its repo; then a machine's owner.
 * An event with no subject is everybody's - right for the rare whole-registry
 * write, wrong for anything that happens often.
 *
 * `access` and `agentOf` are handed in so this file need not import the
 * registry, which imports this one.
 */
export function concerns(event, user, { access, agentOf }) {
  if (event.users) return event.users.includes(user);
  if (event.repoId && access(event.repoId, user)) return true;
  if (event.agentId && agentOf(event.agentId, user)) return true;
  if (event.owner && event.owner === user) return true;
  return !event.repoId && !event.agentId && !event.owner;
}

// -------------------------------------------------------- other processes

let following = null;
let lastFollowed = null;

/**
 * Republish what other processes wrote to the store, from now on.
 *
 * A poll, because the store is DynamoDB and a JSON file, neither of which
 * pushes. One query per tick on today's partition, which at the default
 * interval is nothing; events this process wrote itself are skipped by
 * origin. Starts only when `FOLLOW_MS` is set, and returns a stop.
 */
export function follow({ everyMs = FOLLOW_MS } = {}) {
  if (!everyMs || following || !store.loadEvents) return () => {};
  lastFollowed = idFor(Date.now(), 0);
  const tick = async () => {
    try {
      const events = await store.loadEvents(lastFollowed, { limit: 500 });
      for (const event of events) {
        if (event.id > lastFollowed) lastFollowed = event.id;
        if (event.origin === ORIGIN) continue;
        const { day, expires, ...bare } = event;
        remember(bare);
        deliver(bare);
      }
    } catch (err) {
      console.warn(`events: could not follow the store: ${err.message}`);
    }
  };
  following = setInterval(tick, everyMs);
  following.unref?.();
  return () => {
    clearInterval(following);
    following = null;
  };
}

/** The UTC date an event falls on - the store's partition. */
export const dayOf = (at) => new Date(at).toISOString().slice(0, 10);

/** For tests: forget everything in memory. The store is not touched. */
export function reset() {
  ring.length = 0;
}
