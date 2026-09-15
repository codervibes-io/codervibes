// What a session said and did, as it happened, in order.
//
// A span (spans.js) is one thing that finished: a tool call, a model call,
// with how long it took. A session (sessions.js) is the counts. Neither is
// what a person watching an agent wants at the moment they are watching:
// the line it just said, the tool it is in the middle of, the fact that
// somebody stopped it a second ago. That is a stream - and a stream nobody
// wrote down is a page that goes blank on reload, and a session nobody can
// replay when they come back to ask what happened.
//
// So every session has a log, append-only, one sequence number per entry,
// and everything a page could show about a session in flight is an entry
// in it. The entries are the Agent Client Protocol's `session/update`
// kinds - `agent_message_chunk`, `agent_thought_chunk`, `tool_call`,
// `tool_call_update`, `plan`, `current_mode_update` - because a page that
// draws those draws every harness the same way, whichever protocol the
// harness spoke on its own machine (agentd.mjs turns Claude Code's
// stream-json into them; the API loop makes them itself; the gateway makes
// them for the calls it serves). Beside them, what the platform itself did
// to the session: `platform.status` when it started, stopped or ended;
// `platform.prompt` when a person said something to it through the session;
// `platform.cancel` when a person stopped it. Both sides of a steer are on
// the same log as the work, so "why did it stop?" reads in order.
//
// `seq` is what a reader keeps. `since(session, seq)` gives everything
// after it, from memory when it is recent and from the store when it is
// not, so a page that lost its connection asks for what it missed and gets
// exactly that. A seq is the entry's time, bumped past the last one when
// two land in the same millisecond - monotonic within a process and across
// restarts, with no counter to remember.
//
// Text is on the log: the chunks are what the agent said. So this is the
// one record about a session that is *not* everyone's: the session's owner
// and the people on its repo read the words; anyone else reads the shape -
// `publicView` - which is the kinds, the tool names and the times, the
// same line spans.js draws for a stranger.
import { EventEmitter } from "node:events";
import { publish } from "./events.js";
import { store } from "./store/index.js";

/** The update kinds a harness may report - the ACP `sessionUpdate` names, and the platform's own. */
export const KINDS = [
  "agent_message_chunk",
  "agent_thought_chunk",
  "user_message_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "current_mode_update",
  "platform.status",
  "platform.prompt",
  "platform.cancel",
];

/** What a `tool_call_update` may say a call has come to. ACP's own words. */
export const TOOL_STATUSES = ["pending", "in_progress", "completed", "failed"];

/** A session's turn: what `platform.status` says it is doing. */
export const STATUSES = ["running", "idle", "cancelling", "finished", "failed"];

/** How much text one chunk keeps. A chunk is a message, not a transcript. */
export const MAX_TEXT = 4000;
/** How many entries of one session stay in memory. */
export const RING_SIZE = 500;
/** How long the store keeps an entry - the spans' month. */
export const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** Durable writes are batched, like spans. */
export const FLUSH_MS = 1000;
export const BATCH_SIZE = 100;

/** session id -> its recent entries, oldest first. */
const rings = new Map();
/** session id -> the last seq handed out, so two in one millisecond stay in order. */
const lastSeq = new Map();
/** session id -> what the log knows of the turn: `{ status, since }`, from the last `platform.status`. */
const turns = new Map();
let pending = [];
let timer = null;

const bus = new EventEmitter();
bus.setMaxListeners(0);

const cut = (value, max = MAX_TEXT) => {
  if (value == null) return null;
  const text = String(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/**
 * What one entry keeps of what was handed in, by kind. Anything not named
 * here is dropped: the log is read by a page, and a page that draws a
 * field the writer did not mean to publish is how a transcript leaks.
 */
function shape(kind, body = {}) {
  switch (kind) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "user_message_chunk":
      // A subagent's report back to the agent is its own line, marked so
      // the page does not read it as what the agent told the person.
      return { text: cut(body.text) ?? "", ...(body.agent?.id || body.agent?.type ? { agent: { id: cut(body.agent.id, 40) ?? null, type: cut(body.agent.type, 64) ?? null } } : {}) };
    case "tool_call":
      return {
        toolCallId: cut(body.toolCallId, 80),
        title: cut(body.title, 200) ?? cut(body.tool, 64) ?? "tool",
        tool: cut(body.tool, 64),
        // ACP's own kinds: read, edit, delete, move, search, execute, think, fetch, other.
        toolKind: cut(body.toolKind, 16),
        status: TOOL_STATUSES.includes(body.status) ? body.status : "in_progress",
        ...(body.task ? { task: cut(body.task, 64) } : {}),
        // A call a subagent made, not the session's own agent: which one,
        // by the harness's id for the run and the agent's name (Explore,
        // a custom agent's name). A stranger sees the name too - it is
        // a kind of thing, like the tool's name, not anybody's words.
        ...(body.agent?.id || body.agent?.type ? { agent: { id: cut(body.agent.id, 40) ?? null, type: cut(body.agent.type, 64) ?? null } } : {}),
      };
    case "tool_call_update":
      return {
        toolCallId: cut(body.toolCallId, 80),
        status: TOOL_STATUSES.includes(body.status) ? body.status : "completed",
        ...(body.ms != null ? { ms: Math.max(0, Math.floor(Number(body.ms) || 0)) } : {}),
        ...(body.detail ? { detail: cut(body.detail, 300) } : {}),
      };
    case "plan":
      return {
        entries: (Array.isArray(body.entries) ? body.entries : []).slice(0, 50).map((entry) => ({
          content: cut(entry?.content, 300) ?? "",
          status: ["pending", "in_progress", "completed"].includes(entry?.status) ? entry.status : "pending",
        })),
      };
    case "current_mode_update":
      return { modeId: cut(body.modeId, 64) ?? "" };
    case "platform.status":
      return {
        status: STATUSES.includes(body.status) ? body.status : "running",
        ...(body.task ? { task: cut(body.task, 64) } : {}),
        ...(body.reason ? { reason: cut(body.reason, 300) } : {}),
      };
    case "platform.prompt":
      return {
        by: { kind: body.by?.kind ?? "person", id: cut(body.by?.id, 120), name: cut(body.by?.name, 120) },
        text: cut(body.text) ?? "",
        // How it reaches the agent - now, or at the next turn boundary.
        delivery: cut(body.delivery, 32) ?? "turn-boundary",
        ...(body.task ? { task: cut(body.task, 64) } : {}),
      };
    case "platform.cancel":
      return {
        by: { kind: body.by?.kind ?? "person", id: cut(body.by?.id, 120), name: cut(body.by?.name, 120) },
        ...(body.task ? { task: cut(body.task, 64) } : {}),
      };
    default:
      return {};
  }
}

/**
 * ACP's kind for a tool, from its name - what a page picks an icon by.
 * ACP's own list: read, edit, delete, move, search, execute, think, fetch,
 * other. Names are matched loosely so a harness's `Bash` and the gateway's
 * `run_command` land on the same kind.
 */
export function toolKindOf(tool) {
  const name = String(tool ?? "").toLowerCase().replace(/^mcp__[a-z0-9_-]+__/, "");
  if (/^(read|cat|view|list|ls|glob|notebookread|recent_changes|my_tasks|repo_info|platform_guide|list_)/.test(name)) return "read";
  if (/^(write|edit|multiedit|notebookedit|patch|apply|create_file)/.test(name)) return "edit";
  if (/^(delete|remove|rm|unlink|destroy)/.test(name)) return "delete";
  if (/^(move|rename|mv)/.test(name)) return "move";
  if (/^(search|grep|find|rg)/.test(name)) return "search";
  if (/^(run|exec|bash|shell|command|ensure_toolchain)/.test(name)) return "execute";
  if (/^(think|plan|todo)/.test(name)) return "think";
  if (/^(fetch|web|http|curl)/.test(name)) return "fetch";
  return "other";
}

/** The next seq for a session: its time, kept past the last. */
function nextSeq(session, at) {
  const seq = Math.max(at, (lastSeq.get(session) ?? 0) + 1);
  lastSeq.set(session, seq);
  return seq;
}

/**
 * Put one entry on a session's log. Synchronous and never throws: called
 * from the resident's poll and from the gateway's tool call, neither of
 * which should fail because the log could not be written. Returns the
 * entry, with its seq.
 *
 * @param {string} session the session id
 * @param {string} kind one of KINDS
 * @param {object} body what the kind carries - see `shape`
 * @param {{ at?: number, subject?: object }} [opts] `at` is when it
 *   happened, for a loop reporting with its own clock; `subject` is who
 *   the nudge is for (events.js `publish`) - nobody in particular by
 *   default, since a session is everyone's to see moving
 */
export function append(session, kind, body = {}, { at = Date.now(), subject = {} } = {}) {
  if (!session || !KINDS.includes(kind)) return null;
  const when = Number(at) || Date.now();
  const entry = {
    session: String(session),
    seq: nextSeq(String(session), when),
    at: when,
    kind,
    ...shape(kind, body ?? {}),
    expires: Math.floor((when + KEEP_MS) / 1000),
  };
  const ring = rings.get(entry.session) ?? [];
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
  rings.set(entry.session, ring);
  if (kind === "platform.status") turns.set(entry.session, { status: entry.status, since: when, task: entry.task ?? null });

  if (store.appendSessionEvents) {
    pending.push(entry);
    if (pending.length >= BATCH_SIZE) flush();
    else if (!timer) {
      timer = setTimeout(flush, FLUSH_MS);
      timer.unref?.();
    }
  }
  try {
    bus.emit("entry", entry);
  } catch {
    // A listener's failure is its own.
  }
  // The nudge, so a page reading the session asks for what is new. The
  // entry itself is not on the nudge: the nudge goes to everybody, and the
  // words go to whoever asks and may read them.
  publish("session.event", subject, { sessionId: entry.session, seq: entry.seq, kind });
  return entry;
}

/** Write what is waiting. Fire-and-forget from the timer; awaited by shutdown and tests. */
export async function flush() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!pending.length || !store.appendSessionEvents) return;
  const batch = pending;
  pending = [];
  try {
    await store.appendSessionEvents(batch);
  } catch (err) {
    console.warn(`${batch.length} session event(s) not stored: ${err.message}`);
  }
}

/**
 * Everything on a session's log after `seq`, oldest first, at most `limit`.
 * Memory answers when the reader is already inside the ring - the page
 * asking every few seconds for what is new, which is the hot case; the
 * store answers otherwise, and the ring's entries not yet written are
 * added on top so a page never sees a gap between the two.
 */
export async function since(session, seq = 0, { limit = 500 } = {}) {
  const id = String(session);
  const ring = rings.get(id) ?? [];
  const from = Number(seq) || 0;
  const inside = ring.length > 0 && from >= ring[0].seq;
  if (inside || !store.loadSessionEvents) {
    return ring.filter((entry) => entry.seq > from).slice(0, limit);
  }
  const stored = await store.loadSessionEvents({ session: id, since: from, limit });
  const seen = new Set(stored.map((entry) => entry.seq));
  const recent = ring.filter((entry) => entry.seq > from && !seen.has(entry.seq));
  return [...stored, ...recent].sort((a, b) => a.seq - b.seq).slice(0, limit);
}

/** The last entry of a kind on a session, from memory - the line it last said, the call it is in. */
export function last(session, kind = null, { own = false } = {}) {
  const ring = rings.get(String(session)) ?? [];
  for (let index = ring.length - 1; index >= 0; index -= 1) {
    if (kind && ring[index].kind !== kind) continue;
    // `own`: the session's agent's own line, not a subagent's report to it.
    if (own && ring[index].agent) continue;
    return ring[index];
  }
  return null;
}

/** What the session's turn is doing, by its last `platform.status`: `{ status, since, task }` or null. */
export const turnOf = (session) => turns.get(String(session)) ?? null;

/**
 * Be told of every entry as it lands, on every session. For the streaming
 * route. Returns a stop.
 */
export function subscribe(listener, { session = null } = {}) {
  const handler = (entry) => {
    if (session && entry.session !== String(session)) return;
    listener(entry);
  };
  bus.on("entry", handler);
  return () => bus.off("entry", handler);
}

/**
 * An entry as somebody not on the session's repo may see it: the kind, the
 * time, the tool's name and status, the turn's status - never the text of
 * a chunk, a prompt, a title that quotes a path, or a call's detail. Like
 * spans.js `countsOnly`, a list of what may be shown, so a field added
 * later is private until somebody says otherwise.
 */
export function publicView(entry) {
  const out = { session: entry.session, seq: entry.seq, at: entry.at, kind: entry.kind };
  if (entry.kind === "agent_message_chunk" || entry.kind === "agent_thought_chunk" || entry.kind === "user_message_chunk") {
    out.chars = entry.text?.length ?? 0;
    if (entry.agent) out.agent = entry.agent;
  }
  if (entry.kind === "tool_call") Object.assign(out, { toolCallId: entry.toolCallId, tool: entry.tool, toolKind: entry.toolKind, status: entry.status, task: entry.task ?? null, ...(entry.agent ? { agent: entry.agent } : {}) });
  if (entry.kind === "tool_call_update") Object.assign(out, { toolCallId: entry.toolCallId, status: entry.status, ms: entry.ms ?? null });
  if (entry.kind === "plan") out.entries = (entry.entries ?? []).map((item) => ({ status: item.status }));
  if (entry.kind === "current_mode_update") out.modeId = entry.modeId;
  if (entry.kind === "platform.status") Object.assign(out, { status: entry.status, task: entry.task ?? null });
  if (entry.kind === "platform.prompt") Object.assign(out, { by: { kind: entry.by?.kind ?? "person" }, delivery: entry.delivery, chars: entry.text?.length ?? 0 });
  if (entry.kind === "platform.cancel") out.by = { kind: entry.by?.kind ?? "person" };
  return out;
}

/** Forget a session's ring - at its end, a while after (sessions.js), so memory is the live ones'. */
export function forget(session) {
  rings.delete(String(session));
  turns.delete(String(session));
}

/** For tests. */
export const sessionEventInternals = {
  rings,
  pending: () => pending,
  reset() {
    rings.clear();
    lastSeq.clear();
    turns.clear();
    pending = [];
    if (timer) clearTimeout(timer);
    timer = null;
    bus.removeAllListeners();
  },
};
