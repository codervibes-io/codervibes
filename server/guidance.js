// Guidance: how much a person had to steer.
//
// A session's outcome is what the world says of the work - the pull request
// went in or it did not. But two sessions that both ended in a merge are not
// the same session if one was told what to do once and the other eleven
// times, and the second is the one whose agent needs looking at. So beside
// the outcome the session keeps counts of the steering it took, and this is
// where those counts come from. Counts only: a session record never holds a
// word of what was said.
//
// The signals, and where each is caught:
//
//   humanLines   a person said something to the agent - a turn typed to the
//                assistant, or a prompt their own harness reported. Caught
//                on the road it came in on, so nothing is counted that the
//                agent was not going to see.
//   followUps    the same person came back: a task moved to this agent after
//                somebody else had it, or the assistant asked a second
//                thing in a conversation that already had a first.
//   retries      a task the agent failed was sent again (`retryOf`).
//   failedTools  a tool call that did not go - counted in sessions.js from
//                the span, since that is where the failure is known.
//   reviewRounds a reviewer sent the pull request back - counted in
//                sessions.js from what pulls.js reports.
//   interrupts   the person cut the turn off: they typed again while the
//                agent was still working, or pressed Stop. Not the same as
//                a follow-up, which waits its turn - an interrupt says the
//                agent was going somewhere the person did not want it to
//                go, and it is the one signal that means "wrong", not
//                "more".
//
// ## One door for "a person spoke to this session"
//
// The same sentence arrives by three roads. A person typing in their own
// terminal reaches us as a harness hook (telemetry-ingest.js `prompt`); a
// person typing into the console reaches an invited agent through ACP
// (acp.js `prompt`); a person pressing Stop is a cancel. If each road
// counted for itself the rules would drift apart within a release, and
// they already had: the hook road counted nothing at all, so a laptop
// session scored as though nobody had steered it while a console one
// scored every line.
//
// So `prompted` and `cancelled` below are the rules, once, and every road
// calls them. What a road knows differs - a hook knows the turn's status
// from the log, a console prompt knows who pressed - and none of that
// changes what a prompt *means*: one more turn, a line from a person, a
// follow-up if it is not the first, an interrupt if the agent was mid-turn,
// and the wait before it charged to the person.
//
// Two roads are not doors here, and should be read as deliberate rather
// than forgotten. A sandbox agent steered with `e2b_say` is a harness with
// our own hooks installed, and its prompt arrives on the hook road under
// its own session - counting it here as well would count it twice. An
// external vendor's agent (Greptile, Devin, a Codex cloud run) is prompted
// somewhere we cannot see at all, and the honest answer for those is not
// nought but "not visible" - performance.js `steeringVisibleOf` says so,
// and the page prints it.
//
// Each lands on the actor's *live* session, and only on one: a session is
// the unit the counts are for, and an agent with no live session was not
// being steered - it was being set off, and the session that produces
// starts clean. What it does carry is what set it off: the watcher on the
// wake bell hands the task to sessions.js `setOff` for an agent with no
// live session, and the session opened when the machine comes up says "set
// off by a task from Grid". Ids and who, not words - see sessions.js.
import { onRing } from "./wake.js";
import * as sessionLog from "./sessions.js";
import * as sessionEvents from "./session-events.js";

/** Count a signal on an actor's live session, if it has one. */
function onLive(actorId, signal) {
  const live = actorId ? sessionLog.liveFor(actorId) : null;
  if (!live) return null;
  sessionLog.guided(live.id, signal);
  return live;
}

/** A task as a trigger: which task, in which repo, and the agent that sent it. */
export const taskTrigger = (task) => ({
  kind: "task",
  id: task?.id ?? null,
  key: task?.repoId ?? null,
  by: task?.from ? { kind: "agent", id: task.from.id ?? null, name: task.from.name ?? null } : null,
  at: task?.createdAt ? Date.parse(task.createdAt) || Date.now() : Date.now(),
});

/** A task was sent to an agent. Not steering - a task is the work itself - but the thing that sets a sleeping agent off. */
export function noteTask(key, task) {
  if (!task?.to?.id || !key.startsWith("agent:")) return null;
  const agentId = key.slice("agent:".length);
  if (String(task.to.id) !== agentId || sessionLog.liveFor(agentId)) return null;
  return sessionLog.setOff(agentId, taskTrigger(task));
}

/** A task the agent failed is being tried again. */
export function retried(previousTask) {
  return onLive(previousTask?.to?.id, "retries");
}

/** A task came to this agent after somebody else had it. */
export function movedTo(agentId) {
  return onLive(agentId, "followUps");
}

/**
 * The assistant was asked something, in a session it already holds. The
 * first turn of a conversation is a line; every one after is also a
 * follow-up, since the person is still there, still steering.
 */
export function asked(sessionId) {
  const record = sessionLog.guided(sessionId, "humanLines");
  if (!record) return null;
  if (sessionLog.guidanceOf(record).humanLines > 1) sessionLog.guided(sessionId, "followUps");
  return record;
}

/**
 * A person spoke to a session: the one rule, whichever road it came in on
 * (see the essay). Returns the record it counted on, or null.
 *
 * `turn` is what the session was doing a moment ago - session-events.js
 * `turnOf`, read here unless the caller has already read it. Running means
 * the person did not wait: that is an interrupt, and the wait before it is
 * the agent's time, not theirs. Idle means the agent had finished and the
 * clock since then was the person's, so it goes to `personMs` - which is
 * the figure that says an agent finished in twelve minutes of work spread
 * over an afternoon.
 *
 * `line` is false for a caller whose words are counted somewhere else: the
 * turn, the follow-up and the clock are still this call's, and only the
 * tally of lines would be doubled.
 *
 * @param {string} sessionId
 * @param {{ at?: number, turn?: object|null, line?: boolean }} [opts]
 */
export function prompted(sessionId, { at = Date.now(), turn = undefined, line = true } = {}) {
  const was = turn === undefined ? sessionEvents.turnOf(sessionId) : turn;
  const record = sessionLog.turned(sessionId);
  if (!record) return null;
  if (line) sessionLog.guided(sessionId, "humanLines");
  // The second ask and every one after: the person is still here, still
  // steering. The same rule `asked` keeps for the assistant.
  const again = (record.counts?.turns ?? 0) > 1;
  if (again) sessionLog.guided(sessionId, "followUps");
  // A cut short only from the second turn on. A session is marked running
  // the moment it opens (sessions.js `open`), before anybody has asked it
  // anything, so the first prompt of every session would otherwise look
  // like somebody interrupting a turn that had not started.
  if (again && was?.status === "running") sessionLog.guided(sessionId, "interrupts");
  else if (was?.status === "idle" && was.since) sessionLog.spent(sessionId, { personMs: at - was.since });
  return record;
}

/**
 * A person stopped the turn. A cut is a cut however it was made, so this
 * counts what a mid-turn prompt counts and nothing else: no turn is
 * beginning, and nobody said anything to steer by.
 */
export function cancelled(sessionId, { at = Date.now(), turn = undefined } = {}) {
  const was = turn === undefined ? sessionEvents.turnOf(sessionId) : turn;
  const record = sessionLog.guided(sessionId, "interrupts");
  if (!record) return null;
  if (was?.status === "running" && was.since) sessionLog.spent(sessionId, { agentMs: at - was.since });
  return record;
}

/**
 * Listen at the bell for what sets an agent off. Returns what `onRing`
 * returns, so a test can stop listening; the server never does.
 */
export function watchGuidance() {
  return onRing((key, payload) => {
    try {
      if (payload?.task) noteTask(key, payload.task);
    } catch {
      // Counting is not a reason for the task not to reach anybody.
    }
  });
}
