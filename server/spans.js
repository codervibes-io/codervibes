// The spans this installation keeps.
//
// telemetry.js turns every finished span into a plain record; this is where
// the records go. Two places: a ring of the last few thousand in memory, so
// the pages that read "what did this agent just do" answer without a store
// round trip, and the store, in batches, so a deploy does not forget what
// happened yesterday. Thirty days, then the store's TTL takes them - what a
// session was for lives on in sessions.js as counts, and the spans are the
// detail behind those counts, not the record of them.
//
// Reads are by what a page is about: a session (its timeline), a task (what
// was done for it), a trace (one call and everything under it), an agent
// (recent only - the store has no index by agent, and the question "what did
// this agent do last month" is a sessions question, not a spans one).
import { onSpan } from "./telemetry.js";
import { store } from "./store/index.js";

/** How many spans stay in memory. */
export const RING_SIZE = 5000;
/** How long the store keeps a span. */
export const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** Durable writes are batched: at most this often, or when this many are waiting. */
export const FLUSH_MS = 2000;
export const BATCH_SIZE = 200;

const ring = [];
let pending = [];
let timer = null;

/** Keep one finished span. Returns the stored record. */
export function record(span) {
  const entry = { ...span, expires: Math.floor((span.at + KEEP_MS) / 1000) };
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
  if (store.appendSpans) {
    pending.push(entry);
    if (pending.length >= BATCH_SIZE) flush();
    else if (!timer) {
      timer = setTimeout(flush, FLUSH_MS);
      timer.unref?.();
    }
  }
  return entry;
}

/**
 * Put a span already in the store back in the ring, at boot (replay.js) -
 * so `forAgent`, which reads memory alone, has yesterday in it. Not
 * written again, and not added twice.
 */
export function remember(span) {
  if (ring.some((entry) => entry.id === span.id)) return false;
  ring.push(span);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
  return true;
}

/** Write what is waiting. Fire-and-forget from the timer; awaited by shutdown and tests. */
export async function flush() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!pending.length || !store.appendSpans) return;
  const batch = pending;
  pending = [];
  try {
    await store.appendSpans(batch);
  } catch (err) {
    // A span lost to the store is still in the ring and still went out over
    // OTLP; a warning is proportionate, a retry loop is not.
    console.warn(`spans: could not store ${batch.length} spans: ${err.message}`);
  }
}

onSpan(record);

const byAt = (a, b) => a.at - b.at || a.id.localeCompare(b.id);

/** Memory and store together, once each, oldest first, at most `limit`. */
async function merged(inMemory, fromStore, limit) {
  const seen = new Map();
  for (const span of inMemory) seen.set(span.id, span);
  try {
    for (const span of (await fromStore) ?? []) if (!seen.has(span.id)) seen.set(span.id, span);
  } catch (err) {
    console.warn(`spans: could not read the store: ${err.message}`);
  }
  const all = [...seen.values()].sort(byAt);
  return all.slice(Math.max(0, all.length - limit));
}

/** Everything that happened in one session, oldest first. */
export function forSession(session, { limit = 500 } = {}) {
  return merged(
    ring.filter((span) => span.session === session),
    store.loadSpans?.({ session, limit }),
    limit,
  );
}

/** Everything done for one task. */
export function forTask(task, { limit = 500 } = {}) {
  return merged(
    ring.filter((span) => span.task === task),
    store.loadSpans?.({ task, limit }),
    limit,
  );
}

/** One trace: a call and everything under it, or a whole session's trace. */
export function forTrace(trace, { limit = 500 } = {}) {
  return merged(
    ring.filter((span) => span.trace === trace),
    store.loadSpans?.({ trace, limit }),
    limit,
  );
}

/**
 * Everything recent, memory only - the ring, which replay.js fills with
 * the last week at boot. This is the one read that is about no session,
 * task or agent in particular: the Tools page folds it (tool-stats.js).
 * `reach` says how far back the ring goes, so a page can say "counting
 * since" rather than let a short ring read as a quiet week.
 */
export function recent({ since = 0 } = {}) {
  const spans = ring.filter((span) => span.at >= since).sort(byAt);
  return { spans, reach: ring.length ? Math.min(...ring.map((span) => span.at)) : null };
}

/** What one agent did recently - memory only, see the essay. */
export function forAgent(agentId, { limit = 200 } = {}) {
  const mine = ring.filter((span) => span.attrs?.["cv.agent.id"] === agentId).sort(byAt);
  return mine.slice(Math.max(0, mine.length - limit));
}

/**
 * The attributes a span may show somebody who does not own the session:
 * counts, ids, names, outcomes. Nothing that was typed - and the list is
 * what may be shown, not what must be hidden, so an attribute added
 * tomorrow that carries a path or a command is private until somebody
 * decides otherwise.
 */
export const COUNTABLE_ATTRS = new Set([
  "cv.agent.id", "cv.agent.name", "cv.agent.kind", "cv.owner", "cv.repo.id", "cv.task.id", "cv.session.id",
  "cv.tool.name", "cv.tool.kind", "cv.tool.ok", "cv.tool.permission", "cv.ok", "cv.skill.name", "cv.skill.via",
  "cv.sandbox.id", "cv.host.id", "cv.sandbox.ms", "cv.handed.chars",
  "cv.connector.id", "cv.connector.write",
  "cv.model", "cv.tokens.input", "cv.tokens.output", "cv.tokens.cacheRead", "cv.tokens.cacheWrite", "cv.tokens.total",
  "cv.harness.id", "cv.harness.kind", "cv.vendor", "cv.provider", "cv.repo", "cv.pr.number", "cv.pull.event",
  "cv.retroactive", "cv.declared", "cv.http.status", "cv.stop", "cv.webhook.kind", "cv.webhook.event",
  "cv.gateway", "cv.gateway.generation", "cv.gateway.user", "cv.cost.cents",
  "cv.refused", "cv.approval.id", "cv.approval.verdict",
]);

/** A span with only its countable attributes on it. */
export function countsOnly(span) {
  const attrs = {};
  for (const [key, value] of Object.entries(span.attrs ?? {})) if (COUNTABLE_ATTRS.has(key)) attrs[key] = value;
  return { ...span, attrs };
}

/** For tests. */
export const spanInternals = {
  ring,
  flush,
  pending: () => pending,
  reset() {
    ring.length = 0;
    pending = [];
    if (timer) clearTimeout(timer);
    timer = null;
  },
};
