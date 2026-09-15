// What this process forgot at the last deploy, read back.
//
// Three things about agents live in memory alone: the ledger of what they
// spent (costs.js), the feed of what they did (agent-activity.js) and the
// ring of recent spans (spans.js). Each is a view over the spans - the
// ledger and the feed are filled from them as they finish - and until now
// each started empty at boot. The Monitoring page said "this server has
// been counting since <ten minutes ago>", the Account page's spend was
// this morning's, and every agent said "never connected" until it next
// did something. The spans were in the store the whole time.
//
// So at boot, before the first request is answered, the last week of them
// is read and put through the same folds the live ones go through. Bounded:
// the last `MAX_SESSIONS` sessions and `spans.forSession`'s own limit each,
// which is what the pages can show anyway. The result says how far back the
// views now reach, which is what the "counting since" line reports.
import * as sessionLog from "./sessions.js";
import * as spans from "./spans.js";
import { foldSpan } from "./costs.js";
import { agentActivity } from "./agent-activity.js";

/** How far back the views are refilled. As far as the Performance page's longest range looks at a feed. */
export const REPLAY_MS = 7 * 24 * 60 * 60 * 1000;
/** Sessions read, newest first. */
export const MAX_SESSIONS = 200;

/** A span's tool call, as the activity feed keeps one. Null for a span that is not a call an agent made. */
function callOf(span, session) {
  const attrs = span.attrs ?? {};
  if (span.name !== "tool.call" || !attrs["cv.agent.id"]) return null;
  return {
    agent: { id: attrs["cv.agent.id"], name: attrs["cv.agent.name"] ?? session.actor?.name ?? attrs["cv.agent.id"] },
    owner: attrs["cv.owner"] ?? session.owner ?? null,
    repo: attrs["cv.repo.id"] ? { id: attrs["cv.repo.id"], name: null } : null,
    tool: attrs["cv.tool.name"] ?? "tool",
    task: span.task ?? attrs["cv.task.id"] ?? null,
    at: span.at,
    ms: span.ms,
    ok: span.ok !== false,
    kind: span.kind ?? null,
  };
}

/**
 * Refill the views from the store. Returns what was replayed and the moment
 * the views now reach back to: `since` once the store has been read - an
 * empty week is a week in which nothing happened, not a week unknown - and
 * now if it could not be.
 */
export async function warm({ now = Date.now(), since = now - REPLAY_MS, limit = MAX_SESSIONS, repoNameOf = () => null } = {}) {
  const result = { sessions: 0, spans: 0, since: now };
  let sessions;
  try {
    sessions = await sessionLog.list({ since, limit });
  } catch (err) {
    console.warn(`replay: could not read the sessions: ${err.message}`);
    return result;
  }
  result.since = since;
  for (const session of sessions) {
    let own;
    try {
      own = await spans.forSession(session.id);
    } catch (err) {
      console.warn(`replay: could not read session ${session.id}: ${err.message}`);
      continue;
    }
    result.sessions += 1;
    for (const span of own) {
      if (span.at < since) continue;
      // Already here - a span this process recorded itself, or the store
      // handed back twice. Folding it again would count it again.
      if (!spans.remember(span)) continue;
      foldSpan(span, { replay: true });
      const call = callOf(span, session);
      if (call) {
        if (call.repo) call.repo.name = repoNameOf(call.repo.id);
        agentActivity.remember(call);
      }
      result.spans += 1;
    }
  }
  return result;
}
