// The bell a resident agent waits on.
//
// A resident asks "anything for me?" for as long as it lives, and until this
// file it asked on a timer that slowed down while nothing happened - up to a
// minute between looks. A person who says something to an agent and watches
// the chat for a minute concludes the agent does not work, and they are not
// wrong: a minute is not a conversation.
//
// So instead of answering "no" and hanging up, the poll route holds the
// question open (resident.js) and this is what wakes it: whoever posts a
// message rings the key it was posted under, whoever sends a task rings the
// agent it was sent to, and a poll waiting on either of those keys is
// answered at once. Nothing is queued here - the poll re-reads the records
// when it wakes - so a bell that rings with nobody listening is nothing, and
// a bell that rings twice is one look.
//
// Keys are strings and mean whatever the caller and the waiter agree on. In
// practice they are a chat key (`<repoId>` for a room, `agent:<id>` for
// the owner's private line - see agent-chat.js) and `agent:<id>` again for a
// task, which is the same key on purpose: both mean "this agent has something".
//
// A bell only reaches an agent that is listening. One whose machine is asleep
// or whose process has died hears nothing, and until resident.js started
// watching the bell (`onRing`) that agent stayed silent until somebody
// noticed - which is the "it does not answer" that every other fix here was
// for. So a ring carries what rang it - the message, the task - and the
// watcher decides whether somebody who is not listening should be got up.
import { EventEmitter } from "node:events";

const bell = new EventEmitter();
// One listener per waiting poll, and a busy server has many polls waiting.
bell.setMaxListeners(0);

// Watchers apart from waiters, so `waiting()` still counts polls and only
// polls, and a watcher that throws cannot take a poll down with it.
const watchers = new EventEmitter();
watchers.setMaxListeners(0);

/** Ring a key. Cheap, synchronous, never throws; safe to call in a hot path. */
export function wake(key, payload = null) {
  if (!key) return;
  bell.emit("wake", String(key));
  try {
    watchers.emit("ring", String(key), payload);
  } catch (err) {
    console.warn(`a bell watcher failed: ${err.message}`);
  }
}

/**
 * Be told of every ring, with what rang it. For whoever gets up an agent
 * that was not listening; a waiter uses `waitFor`.
 *
 * @param {(key: string, payload: unknown) => void} watcher
 * @returns {() => void} stop watching
 */
export function onRing(watcher) {
  watchers.on("ring", watcher);
  return () => watchers.off("ring", watcher);
}

/**
 * Wait until one of `keys` is rung, the time is up, or the caller goes away.
 *
 * Resolves `true` if woken and `false` otherwise. The signal is what stops a
 * closed connection from leaving a listener behind for the whole wait.
 */
export function waitFor(keys, { timeoutMs, signal } = {}) {
  const wanted = new Set(keys.filter(Boolean).map(String));
  if (!wanted.size) return Promise.resolve(false);
  if (signal?.aborted) return Promise.resolve(false);

  return new Promise((resolve) => {
    let timer = null;
    const finish = (woken) => {
      bell.off("wake", onWake);
      signal?.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
      resolve(woken);
    };
    const onWake = (key) => {
      if (wanted.has(key)) finish(true);
    };
    const onAbort = () => finish(false);

    bell.on("wake", onWake);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs > 0) timer = setTimeout(() => finish(false), timeoutMs);
  });
}

/** How many polls are waiting right now. For tests, and for a status line. */
export const waiting = () => bell.listenerCount("wake");
