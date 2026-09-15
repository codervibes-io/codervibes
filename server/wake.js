// The bell an agent's waits are rung on.
//
// Two things here are worth waiting for rather than polling: a task sent to
// an agent, and a gated call whose approval the owner is about to press. The
// waiter holds its question open (mcp.js `approvalGate`) and this is what
// answers it: whoever sends a task rings the agent it was sent to, whoever
// decides an approval rings that call, and a wait on either of those keys is
// answered at once. Nothing is queued here - the waiter re-reads the records
// when it wakes - so a bell that rings with nobody listening is nothing, and
// a bell that rings twice is one look.
//
// Keys are strings and mean whatever the caller and the waiter agree on. In
// practice they are `agent:<id>` for a task and the approval's own key for a
// gated call (action-approvals.js `wakeKey`).
//
// A bell only reaches something that is listening. An agent whose machine is
// asleep or whose process has died hears nothing, and nothing here gets it
// up - so a ring carries what rang it, and a watcher (`onRing`) decides what
// that means: guidance.js counts what a task set off, and says so on the
// session that starts when the agent next comes up.
import { EventEmitter } from "node:events";

const bell = new EventEmitter();
// One listener per waiting poll, and a busy server has many polls waiting.
bell.setMaxListeners(0);

// Watchers apart from waiters, so `waiting()` still counts waits and only
// waits, and a watcher that throws cannot take a wait down with it.
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
 * Be told of every ring, with what rang it. For whoever wants to know that
 * something happened rather than to wait for it; a waiter uses `waitFor`.
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

/** How many waits are open right now. For tests, and for a status line. */
export const waiting = () => bell.listenerCount("wake");
