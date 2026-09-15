// The small pieces every page and panel on this console is built from.
//
// Deliberately not imported from pr-modal.js, which is where the rest of the
// app keeps its `el`. That module also pulls in the API client, Firebase and
// the markdown renderer, because it grew up alongside the Repos page - and
// this page should not load a markdown renderer to draw a list.

/** @returns {HTMLElement} */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** A button that does something. Everything on this page is one of these. */
export function button(className, text, onClick) {
  const node = el("button", className, text);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

/**
 * Hand a blob to the browser to save, under a name.
 *
 * A temporary anchor because there is no other way: a download is a
 * navigation, and the file came back through `fetch` (public/api.js
 * `fetchFile`) because the request needs the account's token on it. The
 * anchor is put in the document and taken out again in the same tick -
 * Firefox will not act on one that is not in the tree - and the object URL
 * is let go a moment later rather than at once, because Safari cancels the
 * save if the URL dies while it is still starting.
 */
export function saveFile(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = el("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * What a task is, in the words every page that counts them uses. One
 * string because four pages say it and they must not drift apart: the
 * Performance tiles and table, the Executors list, and an executor's own
 * Stats panel.
 */
export const TASK_HELP =
  "A task is one piece of work an agent was asked to do: a task handed to it here, or - when there is no task - a pull request it opened. " +
  "It is finished when the task is marked done, or the pull request merged. " +
  "A session that was only a question and an answer is not a task, and counts in neither figure.";

/**
 * A "?" beside a word the page uses but has no room to define - "tasks",
 * which is a piece of work with a verdict and not the same thing as a
 * session or a pull request (server/performance.js).
 *
 * A button and not a `title` attribute, for three reasons: a phone has no
 * hover and would never see it, a tooltip cannot be reached by keyboard,
 * and a native one takes a second to appear and reads as a delay rather
 * than as an answer. So: hover opens it on a desktop, a press opens it
 * anywhere, Escape and a press outside close it, and the text is in the
 * document either way, where a screen reader finds it.
 *
 * @param {string} word what is being explained, for the button's label
 * @param {string} text the explanation, in a sentence or two
 */
export function helpMark(word, text) {
  const wrap = el("span", "help");
  const bubble = el("span", "help-bubble", text);
  bubble.setAttribute("role", "tooltip");
  bubble.hidden = true;
  // Two reasons it can be open, tracked apart. Folding them into one flag
  // and toggling it on the press is what a "?" usually does, and it is
  // wrong on both devices: on a desktop the pointer is over the mark
  // whenever it is pressed, so the press finds the bubble already open and
  // shuts it; on a phone the tap arrives behind a synthetic hover and does
  // the same, which leaves nothing on the one device the button exists for.
  let pressed = false;
  let hovered = false;

  const mark = button("help-mark", "?", () => {
    pressed = !pressed;
    sync();
  });
  mark.setAttribute("aria-label", `What counts as ${word}`);
  mark.setAttribute("aria-expanded", "false");
  mark.setAttribute("aria-describedby", (bubble.id = `help-${Math.random().toString(36).slice(2, 8)}`));

  function sync() {
    const open = pressed || hovered;
    bubble.hidden = !open;
    mark.setAttribute("aria-expanded", String(open));
    // One at a time: a second bubble open behind the first is two answers
    // to a question nobody asked twice.
    if (open) for (const other of document.querySelectorAll(".help-bubble")) if (other !== bubble) other.hidden = true;
  }

  wrap.addEventListener("mouseenter", () => {
    hovered = true;
    sync();
  });
  wrap.addEventListener("mouseleave", () => {
    hovered = false;
    sync();
  });
  mark.addEventListener("focus", () => {
    hovered = true;
    sync();
  });
  mark.addEventListener("blur", () => {
    pressed = false;
    hovered = false;
    sync();
  });
  mark.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    pressed = false;
    hovered = false;
    sync();
  });
  wrap.append(mark, bubble);
  return wrap;
}

/**
 * How long ago, in the fewest words that are still true.
 *
 * Rounded down and never precise: this page is watched, not audited, and "2m
 * ago" is what somebody wants to know. Seconds are spelled out below a minute
 * because that is the range where the difference matters - an agent that last
 * did something 4 seconds ago is working, one that did 40 may have stopped.
 */
export function ago(at, now = Date.now()) {
  if (!at) return "never";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d ago` : new Date(at).toLocaleDateString();
}

/** How long something took, for a line that has already finished. */
export function took(ms) {
  if (!Number.isFinite(ms)) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

/**
 * A duration, in the largest unit that still says something.
 *
 * Sub-second matters here in a way it does not in the activity feed: a task
 * that took 400ms of tool time and two hours of wall clock is a task that was
 * waiting, and rounding the first to "0s" hides exactly that.
 */
export function duration(ms) {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  const hours = ms / 3_600_000;
  return hours < 24 ? `${hours.toFixed(1)}h` : `${Math.round(hours / 24)}d`;
}

/** A count, shortened. 1200 -> 1.2k. */
export function count(value) {
  if (!Number.isFinite(value)) return "—";
  if (value < 1000) return String(Math.round(value));
  if (value < 1e6) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1e6).toFixed(1)}M`;
}

/**
 * Money, from cents, or nothing at all.
 *
 * Null means no rate is configured for whatever this is - see costs.js. It
 * renders as an em dash rather than as $0.00, because "free" and "we do not
 * know" are different answers and only one of them is safe to act on.
 */
export function money(cents) {
  if (cents == null) return null;
  if (cents < 1) return `<1¢`;
  if (cents < 100) return `${Math.round(cents)}¢`;
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * When an agent was last around, said in the fewest words that are still true.
 *
 * Two facts, and they are not the same one. `lastAt` is the last thing it
 * *did*, which lives in this process and is gone at the next deploy;
 * `lastSeenAt` is the last time it authenticated, which is on its record and
 * survives. Reading only the first is how every agent on the installation
 * came to say "never connected" for the ten minutes after a restart - which is
 * the one sentence that is supposed to mean "your invite has not been used".
 *
 * @returns {string} a phrase, never empty
 */
export function lastSeen(agent, { verb = "last did something" } = {}) {
  if (agent?.lastAt) return `${verb} ${ago(agent.lastAt)}`;
  const seen = agent?.lastSeenAt ? Date.parse(agent.lastSeenAt) : NaN;
  // Without a verb it is a cell under "Last active", where "last" is the
  // heading's word and a fourth one does not fit the column.
  if (Number.isFinite(seen)) return `${verb ? "last " : ""}connected ${ago(seen)}`;
  return "never connected";
}

/**
 * What an agent is doing, in one word and a colour.
 *
 * Four words, and they answer one question - "if I message it, what
 * happens?":
 *
 *   busy             it is in the middle of a tool call; it will see the
 *                    message when that call returns.
 *   idle             it is awake and listening (`connected`: it has spoken
 *                    to the server inside the presence window), so a message
 *                    reaches it now.
 *   sleeping         it has connected before but is not here now - a resident
 *                    that stopped, a laptop with its lid shut. The message
 *                    waits until it comes back.
 *   never connected  the invite was never used; nothing is listening and
 *                    nothing will be until somebody runs it.
 *   stuck            something is stopping it - the model refused its last
 *                    call, its loop stopped on an error - and it will not
 *                    answer until that is put right (`trouble`, which says
 *                    what). Above busy, because a stuck agent is one that
 *                    is trying and failing, and "busy" was the lie that hid
 *                    an agent out of credits for an afternoon.
 *
 * One definition, because the Agents list, a repo's Agents tab and
 * Monitoring's board all say it and a person reads them ten seconds apart -
 * an agent "busy" on one and "sleeping" on the other is a bug report. `up`
 * is whether the dot beside its name should be lit: awake, in either sense.
 * `order` sorts a list the way the words above are listed - what is going on
 * at the top, what never happened at the bottom.
 */
export function agentStatus(agent) {
  if (agent.trouble) return { word: "stuck", className: "chip-err", up: false, order: 0 };
  if (agent.busy || agent.calls?.some((call) => call.state === "running")) {
    return { word: "busy", className: "chip-ok", up: true, order: 0 };
  }
  if (agent.connected) return { word: "idle", className: "chip-ok", up: true, order: 1 };
  // "Waking up" was between these: somebody said something and the agent's
  // machine was being started for it. Nothing here starts a machine, so an
  // agent that is not connected is simply not running - whoever runs it
  // decides when it next does.
  if (agent.lastAt || agent.lastSeenAt) return { word: "not running", className: "", up: false, order: 3 };
  return { word: "never connected", className: "chip-none", up: false, order: 5 };
}

/**
 * Say something went wrong, where it went wrong.
 *
 * A red line inside the panel that failed, rather than a toast in the corner:
 * this page has several panels doing several things, and a floating message
 * that does not say which one it is about is a message nobody can act on.
 */
export function problem(message) {
  return el("p", "console-problem", message);
}

/**
 * The other half of `problem`: something worked, said where the failure
 * would have been said.
 *
 * A form that clears its error and shows nothing has not told anybody it
 * worked - it looks exactly like a form that did nothing. Anywhere a
 * `problem` can appear, this is what appears instead when it did.
 */
export function done(message) {
  return el("p", "console-done", message);
}

/**
 * The top of a page: what you are looking at, and what state it is in.
 *
 * Every page in this console opens the same way - a name, then chips saying
 * what is true of it right now - and it is a helper rather than four copies
 * because it was four copies and two of them never got written. Machines and
 * Connectors opened straight into a `panel-heading`, so an `h3` was doing an
 * `h1`'s job and those two pages had no title of their own at all.
 *
 * `extras` are appended after the title, in order: a description, a status
 * line, a row of chips - whatever that page has to say about itself.
 *
 * `title` is normally the name as a string. A page that has something to put
 * *on* the title's own line rather than under it - the Workspace page's Edit,
 * which turns the name into a field where it is read - passes an element it
 * has built instead, and is then responsible for the `detail-title` inside it.
 */
export function detailHead(title, ...extras) {
  const head = el("header", "detail-head");
  head.append(typeof title === "string" ? el("h1", "detail-title", title) : title);
  for (const extra of extras) if (extra) head.append(extra);
  return head;
}

/**
 * One number, said large, with what it is and one thing about it.
 *
 * Monitoring, Account, Activity and Performance all open on a row of these;
 * it lived in Monitoring and Account each had a copy, which is how the two
 * came to differ in whether a number was a string.
 */
export function metric(value, label, note, className = "") {
  const box = el("div", `metric ${className}`.trim());
  box.append(el("div", "metric-value", String(value)));
  box.append(el("div", "metric-label", label));
  if (note) box.append(el("div", "metric-note", note));
  return box;
}

/** A row of metrics. */
export function metrics(...tiles) {
  const grid = el("div", "metric-grid");
  grid.append(...tiles);
  return grid;
}

/** A row of chips, for the head of a page. */
export function chips(...labels) {
  const wrap = el("div", "row-chips");
  for (const label of labels) {
    if (!label) continue;
    wrap.append(typeof label === "string" ? el("span", "chip", label) : label);
  }
  return wrap;
}


/**
 * A value and a Copy button. Multi-line values keep their lines.
 *
 * It lived in console-connect.js, which is the only place that had a secret
 * to hand over. It is here now because the integration picker has a command
 * of its own to hand over and a second copy of this would be a second Copy
 * button that failed differently.
 */
export function copyLine(value) {
  const line = el("div", `credential${value.includes("\n") ? " credential-block" : ""}`);
  line.append(el("code", "credential-value", value));
  line.append(
    button("ghost-btn", "Copy", async (event) => {
      try {
        await navigator.clipboard.writeText(value);
        event.target.textContent = "Copied";
      } catch {
        // Refused often enough - an insecure origin, a permission - that
        // failing silently would look like a dead button.
        event.target.textContent = "Select it and copy";
      }
    }),
  );
  return line;
}
