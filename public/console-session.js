// One session, read whole: what it was, what it said and did, what it
// wrote, and what became of that.
//
// This was the bottom of console-home.js, and the reason it is a file of
// its own is what it does *not* need. A session page is the answer a
// search result opens onto, so a console with Search on it has to have
// one - but the cards a task is answered on (console-tasks.js) belong to
// Activity, which such a console need not have at all. Everything about a
// session that does not need those is here. There used to be a box on
// this page to type a line to the agent, handed in as a slot; it went with
// the messaging it posted into (2026-09), and what a person hands an agent
// now is a task.
//
// The naming of a session - what to call it, who it was, where it ran -
// is here too, because it is the same vocabulary the Activity table uses
// and console-home.js imports it back. That direction is the rule: this
// file may not import console-home.js or console-tasks.js, and a test
// refuses it if it grows one.
import { api } from "./api.js";
import { el, button, ago, took, duration, count, money, problem, detailHead, chips, metric, metrics } from "./console-dom.js";
import { listTable, listRow, statusCell } from "./console-list.js";
import { KIND_LABELS } from "./console-friction.js";
import { whereChip } from "./console-where.js";
import { connectSteps } from "./console-connect.js";
import { openModal } from "./modal.js";

const plural = (n, word, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;

/** The outcome, as a chip. */
export const OUTCOMES = {
  merged: { word: "merged", className: "chip-ok" },
  // What became of the merge afterwards (server/pulls.js): in production,
  // or taken back out again. "Reverted" is read before "merged" both here
  // and on the server (sessions.js `outcomeOfPulls`), because work that
  // did not stay is not a merge with a footnote.
  shipped: { word: "shipped", className: "chip-ok" },
  reverted: { word: "reverted", className: "chip-err" },
  open: { word: "open", className: "chip-open" },
  closed: { word: "closed", className: "chip-none" },
  // A deploy session's two endings (server/deploys.js, fly_deploy).
  deployed: { word: "deployed", className: "chip-ok" },
  failed: { word: "failed", className: "chip-warn" },
  none: { word: "no pull request", className: "chip-none" },
};

export function panel(title, ...children) {
  const section = el("section", "console-panel");
  section.append(el("h3", "panel-heading", title));
  section.append(...children);
  return section;
}

/** What the six steer kinds are called in a sentence, as an adverb of frequency reads better than a count. */
const STEER_WORDS = {
  clarify: "clarified",
  correct: "corrected",
  redirect: "redirected",
  context: "given context",
  approve: "approved",
  new: "asked something new",
};

/** "once", "twice", "3 times" - how a person says a small count out loud. */
const times = (n) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

/**
 * How the session went, in one line: how many turns, how many of them cut
 * the agent off, what kind of steer each was, and where the clock went.
 *
 * "4 turns · 1 cut short · corrected twice, clarified once · agent 12m,
 * waited 40m". One line rather than five tiles because it is a sentence
 * about one session and reads as one; the tiles below it are the counts.
 *
 * An outside service's agent gets the sentence it deserves instead: we do
 * not see it being prompted, and a row of noughts would say it was never
 * steered, which is a claim we cannot make.
 */
function autonomyLine(session) {
  const own = session.autonomy ?? null;
  if (!own) return null;
  if (own.visible === false) return el("p", "session-autonomy console-caveat", "This run belongs to another service, so its steering is not visible here - not nought, unknown.");
  const parts = [];
  if (own.turns) parts.push(plural(own.turns, "turn"));
  const interrupts = session.friction?.interrupts ?? 0;
  if (interrupts) parts.push(`${interrupts} cut short`);
  const kinds = Object.entries(own.kinds ?? {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${STEER_WORDS[kind] ?? kind} ${times(count)}`);
  if (own.unclassified) kinds.push(`${plural(own.unclassified, "steer")} unclassified`);
  if (kinds.length) parts.push(kinds.join(", "));
  const clock = [];
  if (own.agentMs) clock.push(`agent ${duration(own.agentMs)}`);
  if (own.personMs) clock.push(`waited ${duration(own.personMs)}`);
  if (clock.length) parts.push(clock.join(", "));
  if (!parts.length) return null;
  return el("p", "session-autonomy", parts.join(" · "));
}

/**
 * What got in this session's way: how its failed calls failed, by kind,
 * with what usually fixes each; the turns it handed back to a person; and
 * the commands it ran over and over (server/friction.js). Nothing when
 * nothing did - a panel of noughts on a session that went well is a panel
 * that teaches people to scroll past the ones that did not.
 */
function frictionPanel(session) {
  const kinds = session.frictionKinds ?? [];
  const repeats = session.repeats ?? [];
  const handBacks = session.counts?.friction?.handBacks ?? 0;
  if (!kinds.length && !repeats.length && !handBacks) return null;
  const parts = [];
  if (kinds.length) {
    const list = el("ul", "friction-session-kinds");
    for (const kind of kinds) {
      const item = el("li", "friction-session-kind");
      item.append(el("span", "friction-kind-name", KIND_LABELS[kind.kind] ?? kind.kind), el("span", "friction-count", `×${kind.count}`));
      if (kind.means) item.append(el("span", "friction-means", kind.means));
      if (kind.fix) item.append(el("p", "friction-fix", `Usually: ${kind.fix}`));
      list.append(item);
    }
    parts.push(list);
  }
  const lines = [];
  if (handBacks) lines.push(`${plural(handBacks, "turn")} ended asking the person something`);
  // The words come back only for a reader who may read this session's
  // (server/friction.js keeps a fingerprint, not the line); anybody else
  // gets the count, which is the part that was the point.
  if (repeats.length) lines.push(`Run over and over: ${repeats.map((repeat) => `${repeat.title ?? "a command"} ×${repeat.times}`).join(" · ")}`);
  for (const line of lines) parts.push(el("p", "friction-aside", line));
  return panel("What got in the way", ...parts);
}

/**
 * What the session wrote, in one line: "312 lines written · 240 kept
 * through review (77%)".
 *
 * A harness whose hooks carry no tool input - Codex's do not - writes code
 * this app never counts, and the line says that instead of nought: the
 * session did not write nothing, we could not see it write.
 *
 * Why it could not see is the half that was wrong. A Claude Code session
 * from before the counter was told its harness sends no edits, which is
 * false of Claude Code and reads as a defect in the tool rather than as
 * the age of the record; `written.why` (performance.js `editsOf`) says
 * which of the three it is and this picks the sentence.
 */
const NOT_MEASURED = {
  predates: "Recorded before lines were counted here, so what it wrote is not measured - not nought, unknown.",
  harness: "This harness does not send what its edits contained, so the lines it wrote are not measured here - not nought, unknown.",
  unknown: "This session edited files and reported no lines, so what it wrote is not measured here - not nought, unknown.",
};

function writtenLine(session) {
  const own = session.written ?? null;
  if (!own) return null;
  if (!own.measured) {
    return el("p", "session-written console-caveat", NOT_MEASURED[own.why] ?? NOT_MEASURED.unknown);
  }
  if (!own.linesAdded) return null;
  const parts = [`${plural(own.linesAdded, "line")} written`];
  if (own.linesRemoved) parts.push(`${count(own.linesRemoved)} removed`);
  if (own.accepted != null) {
    parts.push(`${count(own.accepted)} kept through review${own.acceptance != null ? ` (${Math.round(own.acceptance * 100)}%)` : ""}`);
  }
  return el("p", "session-written", parts.join(" · "));
}

/** Where the session worked: the repository if it named one, else the repo. */
export const whereOf = (session) => session.repo?.fullName ?? session.repoName ?? "—";

/** Who the session was: "resident · Ada", with the harness when it is one. */
function whoOf(session) {
  const kind = session.harness?.name ?? session.kind ?? "agent";
  return [kind, session.ownerName ?? session.owner].filter(Boolean).join(" · ");
}

/**
 * What to call a session: what it was for, when the server said (the first
 * line of the ask - sessions.js; it is withheld from a viewer who may not
 * read the words), else who was working. With a title the actor is the
 * second line, not lost: "Your own setup" is still where it ran.
 */
export const nameOf = (session) => session.title || session.actor?.name || session.id;
export const actorLine = (session) => (session.title ? [session.actor?.name, whoOf(session)].filter(Boolean).join(" · ") : whoOf(session));

// -------------------------------------------------------------- the links
//
// A session is a stretch of work by somebody, somewhere, because of
// something: the agent, the machine, and what set it off - a task, a
// prompt. The agent and the machine have pages of their own, and the
// session says which by id (sessions.js), so each is a link here; what
// set it off is said and not linked. What it made - the pull requests -
// is under the card and on the page, linked out.

/** A link that opens a console page, or plain text when there is nowhere to go. */
export function goTo(text, path, onOpen) {
  if (!path) return el("span", "session-link-text", text);
  const link = el("a", "session-link", text);
  link.href = path;
  link.addEventListener("click", (event) => {
    event.preventDefault();
    onOpen(path);
  });
  return link;
}

/** The console page for the actor: the agent's own page. A harness, an assistant or a vendor's agent has none. */
function actorPath(session, pathFor) {
  const actor = session.actor ?? {};
  if (actor.kind === "agent" && actor.id) return pathFor("agents", actor.id);
  if (actor.kind === "external" && actor.id) return pathFor("agents", actor.id);
  return null;
}

/**
 * What set the session off, in words. Nothing is linked: a task's words are
 * on the task, a prompt's are on the laptop it was typed on, and a webhook
 * or a schedule has no words at all.
 */
function triggerOf(trigger) {
  if (!trigger?.kind) return null;
  const who = trigger.by?.name ?? null;
  const where = trigger.where ?? null;
  const from = who ? ` from ${who}` : "";
  switch (trigger.kind) {
    case "task":
      return { text: `a task${from}`, path: null };
    // Nothing says a line any more (the messaging went in 2026-09); records
    // written before it did still say what set them off.
    case "line":
      return { text: `a line${from}${where?.kind === "agent" ? ", said to it directly" : where?.name ? ` in ${where.name}` : ""}`, path: null };
    case "prompt":
      return { text: `a prompt${from}`, path: null };
    case "webhook":
      return { text: "GitHub", path: null };
    case "schedule":
      return { text: "a schedule", path: null };
    default:
      return { text: trigger.kind, path: null };
  }
}

/**
 * The line of links under a session's name: who, on what, because of what.
 * At the top of the session's page.
 */
export function sessionLinks(session, { onOpen, pathFor }) {
  const line = el("p", "session-links");
  const actor = session.actor ?? {};
  const pieces = [];
  pieces.push(goTo(actor.name ?? "somebody", actorPath(session, pathFor), onOpen));
  // Where it ran, when the session said. Not a link: it is somebody's own
  // laptop or their own e2b sandbox, and there is no page here for one -
  // this app did not start it and knows nothing about it but its name.
  const machine = session.machine;
  if (machine?.id) {
    const on = el("span", "session-link-on");
    on.append("on ", el("span", "session-link-name", machine.name ?? machine.id));
    pieces.push(on);
  }
  const trigger = triggerOf(session.trigger);
  if (trigger) {
    const by = el("span", "session-link-on");
    by.append("set off by ", goTo(trigger.text, trigger.path, onOpen));
    if (session.trigger?.at) by.append(el("span", "session-link-note", ` ${ago(session.trigger.at)}`));
    pieces.push(by);
  }
  pieces.forEach((piece, index) => {
    if (index) line.append(el("span", "session-link-sep", " · "));
    line.append(piece);
  });
  return line;
}

/**
 * What the agent is doing this second, as one line with a pulse beside it -
 * the "typing…" of a messenger. Thinking is a model call in flight; working
 * is a tool call, named as the owner's activity feed names it, or by the
 * tool alone for a session the viewer is not on.
 */
function doingLine(session) {
  const now = session.now ?? {};
  const name = session.actor?.name ?? "It";
  let text = null;
  if (now.thinking) text = `${name} is thinking…`;
  else if (now.doing) text = `${name} is working: ${now.doing.summary ?? now.doing.tool}`;
  else text = `${name} is between calls · last seen ${ago(session.lastSeenAt)}`;
  const line = el("p", `home-doing${now.thinking || now.doing ? " moving" : ""}`);
  line.append(el("span", "doing-dot"), el("span", "doing-text", text));
  return line;
}

/** The task it is on: title (or just "a task" for a stranger's), state, and its clock. */
function taskLine(task) {
  const line = el("p", "home-task");
  line.append(el("span", "home-task-title", task.title ?? "a task"));
  const facts = [task.state];
  if (task.openMs) facts.push(`open ${duration(task.openMs)}`);
  if (task.dueAt) {
    const left = task.dueAt - Date.now();
    facts.push(left > 0 ? `${duration(left)} left` : `over by ${duration(-left)}`);
  }
  line.append(el("span", "home-task-facts", facts.join(" · ")));
  return line;
}

// ------------------------------------------------------------ one session

/** A span's one-line name: the tool, the model, or the span's own name. */
function spanLabel(span) {
  const attrs = span.attrs ?? {};
  if (span.name === "tool.call") return attrs["cv.tool.name"] ?? "tool";
  if (span.name === "model.call") return attrs["cv.model"] ?? "model";
  if (span.name === "connector.call") return `${attrs["cv.connector.id"] ?? "connector"} call`;
  if (span.name === "agent.turn") return "prompt";
  return span.name;
}

/** One line of a longer text, for a note on a row. */
const oneLine = (text, max = 160) => {
  const line = String(text).replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * What a span has to say beyond its name and how long it took. The words
 * - the prompt, the command a tool was handed, an error's message - are
 * on the span for the owner and the repo's people and absent for anyone
 * else (spans.js `countsOnly`), so a row that has them shows them.
 */
function spanNote(span) {
  const attrs = span.attrs ?? {};
  const parts = [];
  if (attrs["cv.prompt.text"]) parts.push(oneLine(attrs["cv.prompt.text"]));
  if (attrs["cv.tool.args"]) parts.push(oneLine(attrs["cv.tool.args"]));
  if (attrs["cv.tool.message"] ?? attrs["cv.error"]) parts.push(oneLine(attrs["cv.tool.message"] ?? attrs["cv.error"]));
  if (attrs["cv.tool.kind"]) parts.push(attrs["cv.tool.kind"]);
  if (attrs["cv.tokens.input"] || attrs["cv.tokens.output"]) {
    parts.push(`${count(Number(attrs["cv.tokens.input"] ?? 0))} in · ${count(Number(attrs["cv.tokens.output"] ?? 0))} out`);
  }
  if (attrs["cv.sandbox.ms"]) parts.push(`${duration(Number(attrs["cv.sandbox.ms"]))} on a machine`);
  if (attrs["cv.retroactive"]) parts.push("reported by the agent");
  return parts.join(" · ");
}

/**
 * The timeline: every span, grouped by trace, oldest first. A session is
 * one trace unless something named its own - a resident's loop does, per
 * episode - so a group is "one stretch of work" and its rows are what was
 * done in it.
 */
function timeline(spans) {
  const byTrace = new Map();
  for (const span of spans) {
    if (span.name === "agent.session") continue;
    const list = byTrace.get(span.trace) ?? [];
    list.push(span);
    byTrace.set(span.trace, list);
  }
  const groups = [...byTrace.values()].sort((a, b) => a[0].at - b[0].at);
  const out = el("div", "timeline");
  if (!groups.length) {
    out.append(el("p", "console-hint", "Nothing yet."));
    return out;
  }
  for (const group of groups) {
    const first = group[0];
    const last = group[group.length - 1];
    const block = el("section", "trace");
    const head = el("div", "trace-head");
    head.append(el("span", "trace-name", `${plural(group.length, "span")}, ${took((last.at + (last.ms ?? 0)) - first.at)}`));
    head.append(el("span", "trace-note", `started ${ago(first.at)}`));
    block.append(head);
    for (const span of group) {
      const row = el("div", `timeline-row${span.ok === false ? " failed" : ""}`);
      row.append(el("span", "timeline-time", new Date(span.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })));
      const text = el("span", "timeline-text");
      text.append(el("span", "timeline-name", spanLabel(span)));
      const note = spanNote(span);
      if (note) text.append(el("span", "timeline-note", note));
      row.append(text);
      row.append(el("span", "timeline-took", took(span.ms ?? 0)));
      row.append(el("span", `chip ${span.ok === false ? "chip-err" : "chip-ok"}`, span.ok === false ? "failed" : "ok"));
      block.append(row);
    }
    out.append(block);
  }
  return out;
}

/** A link out, or plain text when there is nowhere to go. */
function out(className, label, url) {
  if (!url) return el("span", className, label);
  const link = el("a", className, label);
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener";
  return link;
}

/**
 * A pull request, as a line with a link out - and, under it, what became
 * of it after it merged (server/pulls.js, pull-aftermath.js).
 *
 * The chip is the state, except where the aftermath overrules it: a merge
 * that was taken back out - by a revert, or by production being rolled off
 * it - says "reverted", and one that is in production says "shipped". Each
 * of the rest is its own line with a way to the thing that says so - the
 * revert's pull request or commit, the fix that came back, the run that
 * went red - because "this was reverted" without a link is a fact the
 * reader cannot check.
 */
/**
 * Why the lines behind a pull request could not be counted, in the words
 * `writtenLine` uses above - when this page can honestly say which.
 *
 * It can when exactly one session is behind the merge and that session is
 * the one being read: then its own `written.why` is the pull request's
 * reason too. With two sessions behind it the reason may belong to one
 * this page is not looking at, and a guess is worse than an absence - so
 * the line says the lines were not counted and blames nobody. Blaming the
 * harness by default is what it did before, and it was wrong about Claude
 * Code, which sends its edits and always did.
 */
const PULL_NOT_MEASURED = {
  predates: "recorded before lines were counted here",
  harness: "the harness behind it does not send what its edits contained",
  unknown: "the lines behind it were not counted",
};

export function pullNotMeasured(pull, why) {
  const own = pull?.attribution ?? {};
  const alone = own.measured === 0 && own.unmeasured === 1;
  return (alone && PULL_NOT_MEASURED[why]) || PULL_NOT_MEASURED.unknown;
}

function pullLine(pull, why = null) {
  const row = el("div", "pull-line-group");
  const head = el("div", "pull-line");
  const state = pull.reverted || pull.rolledBack ? "reverted" : pull.shipped ? "shipped" : pull.state;
  const entry = OUTCOMES[state] ?? OUTCOMES.none;
  head.append(el("span", `chip ${entry.className}`, entry.word));
  head.append(out("pull-link", `${pull.repo ?? ""}#${pull.number}${pull.title ? ` · ${pull.title}` : ""}`, pull.url));
  const rounds = pull.changesRequested ?? 0;
  if (rounds) head.append(el("span", "pull-note", `sent back ${plural(rounds, "time")}`));
  // How much of what merged an agent wrote (server/pull-aftermath.js). On
  // the head beside the state, because it is a fact about the pull request
  // itself rather than something that happened to it afterwards.
  if (pull.attribution?.share != null) {
    head.append(el("span", "chip chip-none", `${Math.round(pull.attribution.share * 100)}% agent-written`));
  } else if (pull.attribution?.unmeasured) {
    // Measured nothing is not measured nought: the harness behind it never
    // said what its edits contained.
    head.append(el("span", "chip chip-none", "agent share not measured"));
  }
  row.append(head);

  const after = el("div", "pull-after");
  if (pull.reverted) {
    const by = pull.reverted.by ?? {};
    const what = by.kind === "commit" ? `commit ${String(by.sha ?? "").slice(0, 7)}` : `#${by.number}`;
    after.append(aftermathLine("Reverted", "by ", out("pull-link", what, by.url), pull.reverted.at ? ` · ${ago(pull.reverted.at)}` : ""));
  }
  if (pull.brokeBuild) {
    after.append(aftermathLine("Broke the build", "", out("pull-link", pull.brokeBuild.pipeline ?? "a run", pull.brokeBuild.url), pull.brokeBuild.at ? ` · ${ago(pull.brokeBuild.at)}` : ""));
  }
  // The follow-ups arrive as a list on the session page and as a count on
  // a card (server/index.js): both are said, neither is invented.
  const followUps = Array.isArray(pull.followUps) ? pull.followUps : [];
  if (followUps.length) {
    const links = el("span", "pull-note");
    followUps.forEach((entry, at) => {
      if (at) links.append(", ");
      links.append(out("pull-link", `#${entry.number}`, entry.url));
    });
    after.append(aftermathLine(plural(followUps.length, "fix") === "1 fix" ? "A fix came back" : "Fixes came back", "", links, ""));
  } else if (Number(pull.followUps) > 0) {
    after.append(aftermathLine("Fixes came back", `${plural(Number(pull.followUps), "pull request")} named it`, null, ""));
  }
  if (pull.shipped) {
    const where = [pull.shipped.app, pull.shipped.release != null ? `v${pull.shipped.release}` : null].filter(Boolean).join(" ");
    after.append(aftermathLine("Shipped", where || "deployed", null, pull.shipped.at ? ` · ${ago(pull.shipped.at)}` : ""));
  }
  // And out of production again (server/pulls.js `noteRolledBack`): which
  // app, the release it was on, the one it went back to, and who did it -
  // with a way into that session, since the log of the rollback is the
  // thing a reader wants next.
  if (pull.rolledBack) {
    const back = pull.rolledBack;
    const version = (release) => (release?.version != null ? `v${release.version}` : null);
    const to = version(back.toRelease) ?? "an image with no release of its own";
    const said = [back.app, version(back.fromRelease) ? `${version(back.fromRelease)} → ${to}` : `back to ${to}`].filter(Boolean).join(" · ");
    after.append(aftermathLine("Rolled back", said, whoRolled(back), back.at ? ` · ${ago(back.at)}` : ""));
  }
  if (pull.attribution?.share != null && pull.attribution.added) {
    const by = pull.attribution.by === "external"
      ? "opened by an outside service, so all of it"
      : `${count(pull.attribution.agent ?? 0)} of ${plural(pull.attribution.added, "added line")}`;
    after.append(aftermathLine("Written by an agent", by, null, ""));
  } else if (pull.attribution?.unmeasured) {
    after.append(aftermathLine("Written by an agent", `not measured - ${pullNotMeasured(pull, why)}`, null, ""));
  }
  // What git-ai's own notes say, where the repository keeps them: a second
  // opinion from a client that watched the working tree, shown beside ours
  // and labelled as somebody else's measure (server/git-ai-notes.js).
  const gitAi = pull.attribution?.gitAi ?? null;
  if (gitAi?.aiLines != null) {
    const models = Object.keys(gitAi.byModel ?? {}).filter((model) => model !== "unknown");
    after.append(aftermathLine(
      "Git AI's own note",
      `${plural(gitAi.aiLines, "line")} from an agent, ${count(gitAi.humanLines ?? 0)} from a person${models.length ? ` · ${models.join(", ")}` : ""}`,
      null,
      "",
    ));
  }
  if (pull.durability?.share != null) {
    after.append(aftermathLine(
      "Still there after 30 days",
      `${Math.round(pull.durability.share * 100)}% of ${plural(pull.durability.added, "added line")}`,
      null,
      "",
    ));
  }
  // ---- pull-cost ----
  // What it cost and where the money went, as a bar (server/pull-cost.js).
  // Under the aftermath rather than in the head line: the head says what
  // became of it, which is the question, and this is what it took.
  const phases = phaseBarFor(pull);
  if (phases) after.append(phases);
  // ---- end pull-cost ----
  // ---- merge-blame ----
  // And the lines themselves, when somebody asks for them: the share above
  // is the claim, and this is the evidence anybody can check it against
  // (server/pull-lines.js). Not fetched with the page - it costs GitHub a
  // read of the whole diff - and only offered where there is a measure to
  // check, which is a merge this app measured.
  let lines = null;
  if (pull.state === "merged" && pull.repo && pull.attribution) {
    const which = whichLines(pull);
    after.append(which.line);
    lines = which.panel;
  }
  // ---- end merge-blame ----
  if (after.childElementCount) row.append(after);
  // ---- merge-blame ----
  if (lines) row.append(lines);
  // ---- end merge-blame ----
  return row;
}

// ---- merge-blame ----

/** How many lines of one file are drawn before "show all" - about a screen. */
const BLAME_FOLD = 80;

/**
 * The control that opens the line-by-line view, and the panel it opens.
 *
 * Two nodes rather than one because the button belongs on the aftermath
 * list, indented with the rest of what became of the merge, and the panel
 * belongs under the whole group at full width - eighty lines of code do not
 * belong in a list of one-line facts.
 */
function whichLines(pull) {
  const line = el("div", "pull-aftermath");
  const panel = el("div", "blame-panel");
  panel.hidden = true;
  let drawn = false;
  const open = button("blame-open", "Which lines", async () => {
    if (drawn) {
      panel.hidden = !panel.hidden;
      open.textContent = panel.hidden ? "Which lines" : "Hide the lines";
      return;
    }
    open.disabled = true;
    open.textContent = "Reading the diff…";
    panel.textContent = "";
    try {
      const view = await api.pullLines(pull.repo, pull.number);
      for (const node of blameView(view)) panel.append(node);
      drawn = true;
      open.textContent = "Hide the lines";
    } catch {
      // The diff is read live and through the repository's own credential,
      // so the ordinary failures are all one thing to a reader: no
      // repository here to read it from (the demo workspace), or a
      // connector whose token has lapsed. One sentence in place of the
      // lines - never a spinner left turning, and never the route's own
      // words, which say "no such pull request" for a merge the reader is
      // looking straight at. The press stays live, so a token put back
      // works on the next one.
      panel.append(problem("The repository could not be read from here, so the lines cannot be shown."));
      open.textContent = "Which lines";
    }
    panel.hidden = false;
    open.disabled = false;
  });
  line.append(el("span", "pull-aftermath-what", "Line by line"));
  line.append(open);
  return { line, panel };
}

/**
 * The panel: who is which colour, then every added line of the merge with
 * a gutter saying whose it is.
 *
 * One hue per session from the app's own series palette, in the order the
 * server listed them, and a neutral one for a line no session here wrote -
 * which is not an accusation, only the absence of a match (a person typed
 * it, a harness that sends no tool input wrote it, or somebody rewrote what
 * the agent left). Past six sessions the rest share a colour and the legend
 * is what tells them apart; a pull request with seven sessions behind it is
 * not a thing a gutter can colour honestly.
 */
function blameView(view) {
  const out = [];
  const sessions = view.sessions ?? [];
  const hue = new Map(sessions.map((session, at) => [session.id, at < 6 ? `blame-by-${at + 1}` : "blame-by-other"]));
  const legend = el("div", "blame-legend");
  for (const session of sessions) {
    const key = el("span", "blame-key");
    key.append(el("span", `blame-swatch ${hue.get(session.id)}`));
    key.append(el("span", "blame-key-name", session.title || session.actor || `session ${session.id.slice(0, 8)}`));
    const said = [];
    if (session.model) said.push(session.model);
    // A session whose harness never said what its edits contained matched
    // nothing and could not have: the legend says so rather than showing it
    // beside the others with a nought against its name.
    said.push(session.measured ? `${plural(session.matched ?? 0, "line")} here` : "its harness did not say what it wrote");
    key.append(el("span", "pull-note", said.join(" · ")));
    legend.append(key);
  }
  const nobody = el("span", "blame-key");
  nobody.append(el("span", "blame-swatch blame-by-none"));
  nobody.append(el("span", "blame-key-name", "Not from a session here"));
  legend.append(nobody);
  out.push(legend);

  if (view.gitAi) {
    out.push(el("div", "blame-note", `The second gutter is Git AI's own note on the merge commit${view.gitAi.version ? ` (${view.gitAi.version})` : ""} - a measure somebody else's client made, shown beside ours rather than folded into it.`));
  }
  if (view.cut) {
    const said = [view.cut.files ? plural(view.cut.files, "file") : null, view.cut.lines ? plural(view.cut.lines, "line") : null]
      .filter(Boolean)
      .join(" and ");
    out.push(el("div", "blame-note", `This is part of the merge: ${said} more are not drawn.`));
  }
  const byPath = new Map((view.gitAi?.files ?? []).map((file) => [file.path, file.ranges ?? []]));
  for (const file of view.files ?? []) out.push(blameFile(file, { hue, gitAi: view.gitAi ? byPath.get(file.path) ?? [] : null }));
  if (!(view.files ?? []).length) {
    out.push(el("div", "blame-note", "Nothing to draw: every file this merge touched is one the measure ignores - a lockfile, a build, a snapshot."));
  }
  return out;
}

/** Which writer Git AI's note puts on a line of a file, or null where it says nothing. */
function gitAiAt(ranges, at) {
  for (const range of ranges ?? []) {
    for (const entry of range.lines ?? []) {
      const hit = Array.isArray(entry) ? at >= entry[0] && at <= entry[1] : entry === at;
      if (hit) return range.kind;
    }
  }
  return null;
}

/**
 * One file: its name, how much of it came from an agent as a thin bar, and
 * its added lines.
 *
 * The code scrolls sideways inside its own box and the column never does -
 * a 200-character line in a merged diff is ordinary, and a page that scrolls
 * sideways on a phone is broken for everything else on it. Over eighty
 * lines the rest are behind a press: a merge of two thousand lines drawn
 * whole is a panel nobody can get past.
 */
function blameFile(file, { hue, gitAi }) {
  const block = el("div", "blame-file");
  const head = el("div", "blame-file-head");
  head.append(el("span", "blame-path", file.path));
  const shown = file.lines?.length ?? 0;
  const mine = (file.lines ?? []).filter((line) => line.by).length;
  const share = shown ? Math.round((mine / shown) * 100) : 0;
  const bar = el("span", "blame-share");
  const fill = el("span", "blame-share-fill");
  fill.style.width = `${share}%`;
  bar.append(fill);
  head.append(bar);
  head.append(el("span", "pull-note", `${share}% of ${plural(shown, "added line")}`));
  block.append(head);

  const code = el("div", "blame-code");
  const draw = (from, to) => {
    for (const line of (file.lines ?? []).slice(from, to)) code.append(blameRow(line, { hue, gitAi }));
  };
  draw(0, BLAME_FOLD);
  block.append(code);
  if (shown > BLAME_FOLD) {
    const more = button("blame-more", `Show all ${count(shown)} lines`, () => {
      draw(BLAME_FOLD, shown);
      more.remove();
    });
    block.append(more);
  }
  return block;
}

/** One added line: whose it is, what Git AI says of it, its number, and the line. */
function blameRow(line, { hue, gitAi }) {
  const row = el("div", "blame-row");
  const gutter = el("span", `blame-gutter ${line.by ? hue.get(line.by) ?? "blame-by-other" : "blame-by-none"}`);
  if (line.by) gutter.title = line.by;
  row.append(gutter);
  if (gitAi) {
    const kind = gitAiAt(gitAi, line.n);
    const second = el("span", `blame-gitai${kind ? ` blame-gitai-${kind}` : ""}`);
    if (kind) second.title = kind === "human" ? "Git AI: a person" : "Git AI: an agent";
    row.append(second);
  }
  row.append(el("span", "blame-n", String(line.n)));
  // The line itself, as text and never as markup: it is a stranger's code.
  row.append(el("span", "blame-text", line.text));
  return row;
}

// ---- end merge-blame ----

// ---- pull-cost ----

/**
 * One pull request's spend, as a three-band bar and a total.
 *
 * Null where the cost is not known - a pull request whose sessions' spans
 * have aged out of the thirty-day window, or one on a model with no rate.
 * A bar of nothing would read as "it cost nothing", which is the one thing
 * it does not mean.
 */
function phaseBarFor(pull) {
  const cost = pull.cost;
  if (!cost?.priced || !(cost.total?.cents > 0)) return null;
  const line = el("div", "pull-phases");
  const bar = el("div", "phase-bar");
  for (const [name, label] of [["before", "before review"], ["review", "review"], ["after", "after"]]) {
    const cents = cost[name]?.cents ?? 0;
    if (!cents) continue;
    const band = el("div", `phase-band phase-${name}`);
    band.style.flexGrow = String(Math.max(cents / cost.total.cents, 0.001));
    band.title = `${label}: ${money(cents)}`;
    bar.append(band);
  }
  line.append(bar);
  const said = [`${money(cost.total.cents)} in all`];
  if (cost.review?.cents) said.push(`${money(cost.review.cents)} answering review`);
  if (pull.workKind && pull.workKind !== "unknown") said.push(pull.workKind);
  line.append(el("span", "pull-phase-total", said.join(" · ")));
  return line;
}

// ---- end pull-cost ----

/**
 * Who rolled an app back, as a link into the session that did it - or as
 * plain text when the roll came from somewhere with no session behind it.
 * Never nothing: "rolled back" with nobody's name on it is the one line
 * here a reader would come looking for an answer to.
 */
function whoRolled(back) {
  const name = back.by?.name ?? "somebody";
  if (!back.sessionId) return el("span", "pull-note", `by ${name}`);
  const link = el("a", "pull-link", `by ${name}`);
  link.href = `/activity/${encodeURIComponent(back.sessionId)}`;
  link.dataset.page = "activity";
  link.title = "Open the session that rolled it back";
  return link;
}

/** One line of what became of a pull request: what happened, and where to look. */
function aftermathLine(what, text, link, tail) {
  const line = el("div", "pull-aftermath");
  line.append(el("span", "pull-aftermath-what", what));
  if (text) line.append(el("span", "pull-note", text));
  if (link) line.append(link);
  if (tail) line.append(el("span", "pull-note", tail));
  return line;
}

/**
 * One Slack thread the session spoke into: which channel, and a way in.
 *
 * The words are not here and are not coming - Slack holds them and decides
 * who may read them (sessions.js `cleanThread`). What this is for is the
 * step across: somebody reading the session can open the thread the work
 * was asked for in, which until now was a thing you had to already know.
 * A thread whose permalink Slack would not give us is still worth saying;
 * it is drawn as plain text rather than dropped.
 */
function threadLine(thread) {
  const row = el("div", "pull-line");
  const label = thread.channelName ? `#${thread.channelName}` : thread.channel;
  if (thread.permalink) {
    const link = el("a", "pull-link", label);
    link.href = thread.permalink;
    link.target = "_blank";
    link.rel = "noopener";
    row.append(link);
  } else {
    row.append(el("span", "pull-link", label));
  }
  if (thread.at) row.append(el("span", "pull-note", ago(thread.at)));
  return row;
}

// ------------------------------------------------------- the transcript
//
// What the session said and did, in ACP's shape (session-events.js): a
// line per thing the agent said, a row per tool call - the call and the
// update that finished it folded into one - and a mark for each turn
// starting and ending, each line a person gave it and each stop. The
// timeline below it is the same work measured (spans: how long, did it
// fail); this is the work as it read. A viewer who is not on the repo
// gets the shape without the words - the server's `publicView` - and the
// rows say "said 120 characters" rather than what.
//
// Read from where the last read left off (console.js `loadSession`) and
// drawn whole on every redraw, which is every event; so where the reader
// had scrolled to is kept at the module, above.

/** How many rows are drawn. The log is kept longer (console.js); the store longer still. */
const TRANSCRIPT_ROWS = 400;

const clock = (at) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** A tool call's update folded into the call it finishes; everything else stands. */
function foldTranscript(events) {
  const rows = [];
  const calls = new Map();
  for (const entry of events) {
    if (entry.kind === "tool_call_update") {
      const call = calls.get(entry.toolCallId);
      if (call) {
        call.status = entry.status;
        if (entry.ms != null) call.ms = entry.ms;
        if (entry.detail) call.detail = entry.detail;
        continue;
      }
    }
    const row = { ...entry };
    if (entry.kind === "tool_call") calls.set(entry.toolCallId, row);
    rows.push(row);
  }
  return rows;
}

const TOOL_CHIP = {
  pending: ["waiting", "chip-none"],
  in_progress: ["running", "chip-open"],
  completed: ["ok", "chip-ok"],
  failed: ["failed", "chip-err"],
};

/** How a person's line reaches the agent, in the log's words. */
const DELIVERY = {
  "next-tool-result": "reaches it with its next tool call",
  "turn-boundary": "read at the start of its next turn",
};

/** What a status line means; `titles` names the task it says it was on. */
function statusWords(entry, titles) {
  const on = entry.task ? ` on ${titles.get(entry.task) ?? "a task"}` : "";
  switch (entry.status) {
    case "running": return `Turn started${on}`;
    case "cancelling": return "Stopping…";
    case "idle": return entry.reason === "stopped" ? "Turn stopped" : entry.reason ? `Idle · ${entry.reason}` : "Turn ended";
    case "finished": return "Session finished";
    case "failed": return `Session failed${entry.reason ? ` · ${entry.reason}` : ""}`;
    default: return entry.status;
  }
}

/**
 * One entry as a row: the clock, what it was, and - for a tool call -
 * how long it took and whether it worked. `own` is whether the words are
 * on the entry at all.
 */
function transcriptRow(entry, { own, titles }) {
  const row = el("div", "transcript-row");
  row.append(el("span", "transcript-time", clock(entry.at)));
  const text = el("span", "transcript-text");
  row.append(text);
  const tail = el("span", "transcript-tail");
  row.append(tail);
  const said = (words, chars, who) => el("span", "transcript-words", own ? words : `${who} said ${plural(chars ?? 0, "character")}`);
  // A person who chose no name is known by their email, never as null.
  const who = entry.by?.name ?? entry.by?.id ?? (entry.by?.kind === "person" ? "A person" : "Somebody");
  // A subagent's line - a tool it called, or what it reported back - sits
  // indented under the subagent's name (Explore, a custom agent's), so
  // the agent's own line of work reads apart from the forty reads its
  // subagent made. The name is a kind of thing, shown to a stranger too.
  if (entry.agent) {
    row.classList.add("sub");
    text.append(el("span", "transcript-agent", entry.agent.type || "subagent"));
  }
  switch (entry.kind) {
    case "agent_message_chunk":
      row.classList.add("said");
      text.append(said(entry.text, entry.chars, entry.agent ? "The subagent" : "It"));
      break;
    case "agent_thought_chunk":
      row.classList.add("thought");
      text.append(said(entry.text, entry.chars, "It"));
      break;
    case "user_message_chunk":
      row.classList.add("person");
      text.append(said(entry.text, entry.chars, "A person"));
      break;
    case "tool_call":
    case "tool_call_update": {
      row.classList.add("tool", entry.status ?? "completed");
      // The title names a path or a command for a viewer on the repo; the
      // tool's name is what everyone else gets.
      text.append(el("span", "transcript-name", (own && entry.title) || entry.tool || "tool"));
      const notes = [];
      if (own && entry.title && entry.tool && entry.title !== entry.tool) notes.push(entry.tool);
      if (entry.toolKind) notes.push(entry.toolKind);
      if (own && entry.detail) notes.push(entry.detail);
      if (notes.length) text.append(el("span", "transcript-note", notes.join(" · ")));
      if (entry.ms != null) tail.append(el("span", "transcript-took", took(entry.ms)));
      const [word, className] = TOOL_CHIP[entry.status] ?? TOOL_CHIP.completed;
      tail.append(el("span", `chip ${className}`, word));
      break;
    }
    case "platform.status":
      row.classList.add("mark", entry.status ?? "");
      text.append(el("span", "transcript-mark", statusWords(entry, titles)));
      break;
    case "platform.prompt":
      row.classList.add("person");
      text.append(own ? el("span", "transcript-words", `${who}: ${entry.text}`) : said(null, entry.chars, who));
      if (DELIVERY[entry.delivery]) text.append(el("span", "transcript-note", DELIVERY[entry.delivery]));
      break;
    case "platform.cancel":
      row.classList.add("mark", "stopped");
      text.append(el("span", "transcript-mark", `${who} asked it to stop.`));
      break;
    case "plan": {
      const steps = entry.entries ?? [];
      const done = steps.filter((step) => step.status === "completed").length;
      row.classList.add("mark");
      text.append(el("span", "transcript-mark", `Plan: ${plural(steps.length, "step")}, ${done} done`));
      break;
    }
    case "current_mode_update":
      row.classList.add("mark");
      text.append(el("span", "transcript-mark", `Mode: ${entry.modeId}`));
      break;
    default:
      row.classList.add("mark");
      text.append(el("span", "transcript-mark", entry.kind));
  }
  return row;
}

// Where the reader is in the transcript, across redraws. Remembered at the
// module rather than on the node: the page is rebuilt whole on every event,
// and a reader who had scrolled back would otherwise be thrown to the
// bottom a few times a minute.
let transcriptPinned = true;
let transcriptOffset = 0;

/**
 * The transcript, as a scrolling box. `transcript` is console.js's
 * `{ events, turn, failed }` for this session, or null before its first
 * read; `titles` names tasks by id.
 */
function transcriptBox(transcript, { own, titles }) {
  const box = el("div", "transcript");
  if (!transcript) {
    box.append(el("p", "console-hint", "Reading…"));
    return box;
  }
  if (transcript.failed) {
    box.append(problem(`Could not read the log - ${transcript.failed}`));
    return box;
  }
  let rows = foldTranscript(transcript.events);
  if (!rows.length) {
    box.append(el("p", "console-hint", "Nothing on the log yet. What the agent says and does lands here as it happens."));
    return box;
  }
  if (rows.length > TRANSCRIPT_ROWS) {
    box.append(el("p", "console-hint transcript-more", `${count(rows.length - TRANSCRIPT_ROWS)} earlier lines not shown.`));
    rows = rows.slice(rows.length - TRANSCRIPT_ROWS);
  }
  for (const row of rows) box.append(transcriptRow(row, { own, titles }));
  box.addEventListener("scroll", () => {
    if (!box.clientHeight) return;
    transcriptOffset = box.scrollTop;
    transcriptPinned = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  });
  const settle = () => {
    if (!box.isConnected || !box.clientHeight) return;
    box.scrollTop = transcriptPinned ? box.scrollHeight : transcriptOffset;
  };
  queueMicrotask(settle);
  requestAnimationFrame(settle);
  return box;
}

/**
 * The stop: ACP's session/cancel, as one button, drawn only when the
 * session can take it (acp.js `tierOf`) and pressable only while a turn
 * is running. No session can take it - every agent here runs in a process
 * this app cannot reach - so in practice this is the line that says why,
 * which is the point: a Stop button that does nothing is worse than none.
 * The button stays for the day something here can be stopped again.
 */
function steerLine(session, steering, onChanged) {
  const line = el("div", "steer-line");
  if (!steering?.cancel) {
    line.append(el("span", "steer-note", steering?.why ?? "This session cannot be steered."));
    return line;
  }
  const running = steering.latency === "instant";
  const note = el("span", "steer-note", running
    ? "Stops the turn now. The task it is on waits for you; Resume on the task brings it back."
    : "Between turns - nothing running to stop.");
  const stop = button("danger-btn steer-stop", "Stop", async () => {
    stop.disabled = true;
    stop.textContent = "Stopping…";
    try {
      const outcome = await api.cancelSession(session.id);
      note.textContent = outcome.running ? "Stopped." : "Nothing was running.";
      onChanged?.();
    } catch (err) {
      stop.disabled = false;
      stop.textContent = "Stop";
      line.append(problem(err.message));
    }
  });
  stop.disabled = !running;
  line.append(stop, note);
  return line;
}

/**
 * How to pick a session up where it stopped, for the people on its repo:
 * a Reconnect button, and the dialog behind it.
 *
 * The session page has always been somewhere to read what happened and,
 * while a session is live, to say something into it. What it could not do
 * is hand the work back to a person: the id the harness knows the
 * conversation by was on the record and on no page, so taking over a
 * colleague's session meant asking them for it, and starting one again
 * meant starting it from the top with everything it had learned thrown
 * away.
 *
 * A button rather than a panel, for the reason the Connect dialog is one:
 * almost everybody who opens a session page has come to read what
 * happened, and a command with a copy box beside it, standing open above
 * the transcript on every visit, is a setup screen in the way of the
 * thing. The one person in ten who came to take the work over presses a
 * button first, which is a press, and reads a dialog that is about
 * nothing else.
 *
 * Two things the dialog says plainly, because both are how somebody would
 * get this wrong.
 *
 * The transcript lives where the work was done. The command finds it on
 * that machine and on no other - the id is not a link and not a
 * credential, it is what a harness on that laptop or in that sandbox
 * files its own conversation under - so the machine is named in the line
 * above the command rather than left to be assumed.
 *
 * And reconnecting to a session that is still live follows the
 * conversation; it does not take it over. The line says so rather than
 * advising anybody to stop it first, because whether this app can stop a
 * session at all is the harness's business (acp.js) - the button is on
 * the page when there is one.
 */
function reconnectModal(session, resume) {
  const machine = session.machine?.name ?? session.machine?.hostLabel ?? null;
  const sandbox = session.machine?.host && session.machine.host !== "laptop";
  const where = machine
    ? `Run it on ${machine}${sandbox ? ", if that sandbox is still up" : ""}: the harness keeps the conversation there, and the id means nothing anywhere else.`
    : "Run it where the work was done: the harness keeps the conversation on that machine, and the id means nothing anywhere else.";
  const following = session.state === "live" ? " It is still live, so this follows the conversation rather than taking it over." : "";
  const steps = [];
  if (resume.command) {
    steps.push({ title: resume.harness ? `In ${resume.harness}` : "In the harness that ran it", snippet: resume.command });
  }
  steps.push({
    title: "Session id",
    snippet: resume.id,
    // A harness this app has no line to type for is still a harness that
    // knows its own sessions by id; the id alone is the whole of the
    // answer for it.
    note: resume.command ? "What the harness files this conversation under." : "What the harness files this conversation under; resume by its own flag.",
  });
  openModal({
    title: "Reconnect to this session",
    subtitle: where + following,
    width: "560px",
    body: () => connectSteps(steps, { numbered: steps.length > 1 }),
    actions: (ctx) => [{ label: "Done", primary: true, onClick: () => ctx.close() }],
  });
}

/**
 * One session.
 *
 * @param {object} args
 * @param {object|null} args.data what /api/sessions/:id said, `now` and
 *   `resume` included
 * @param {string|null} args.failed
 * @param {object|null} args.transcript its log so far - console.js `state.transcript`
 * @param {(path: string) => void} args.onOpen
 * @param {(page: string, id?: string) => string} args.pathFor
 * @param {() => void} [args.onChanged] re-read after a stop
 */
export function sessionView({ data, failed, transcript = null, onOpen, pathFor, onChanged = null }) {
  const pane = el("div", "detail detail-wide");
  if (failed) {
    pane.append(detailHead("Session"));
    pane.append(problem(`Could not read the session - ${failed}`));
    return pane;
  }
  if (!data) {
    pane.append(detailHead("Session"));
    pane.append(el("p", "console-hint", "Reading…"));
    return pane;
  }
  const { session, own, spans = [], tasks = [], pulls = [] } = data;
  // The card's additions ride along on the session (`now`), so the page
  // that opens from a card keeps the box the card had.
  const live = session.state === "live" ? { ...session, now: data.now ?? {} } : null;
  // What can be done to it - acp.js `tierOf`, as the route passes it on.
  const can = data.steering ?? null;
  const counts = session.counts ?? {};
  const friction = session.friction ?? {};
  const outcome = OUTCOMES[session.outcome] ?? OUTCOMES.none;

  const when = session.state === "live"
    ? `live · started ${ago(session.startedAt)}`
    : `${ago(session.startedAt)} · ran ${duration((session.endedAt ?? session.lastSeenAt) - session.startedAt)}`;
  pane.append(
    detailHead(
      nameOf(session),
      el("p", "detail-summary", `${actorLine(session)} · ${whereOf(session)} · ${when}`),
      chips(
        el("span", `chip ${outcome.className}`, outcome.word),
        // Where this sits relative to the workspace you have open. On a
        // listing the mark says why a row is there at all; here it says
        // that the repository on the line above is one nobody connected.
        whereChip(session.where),
        `${plural(counts.tools ?? 0, "tool call")}`,
        counts.toolsFailed ? `${counts.toolsFailed} failed` : null,
        counts.modelCalls ? `${plural(counts.modelCalls, "model call")}` : null,
        counts.tokens ? `${count(counts.tokens)} tokens` : null,
        counts.cost ? money(counts.cost) : null,
      ),
    ),
  );
  // Who, on what, because of what - each a link to its own page.
  pane.append(sessionLinks(session, { onOpen, pathFor }));

  // And the one thing that can be done to a session whether it is live or
  // long over: carry it on yourself, in the harness that ran it
  // (harnesses.js `resumeFor`). Under the links rather than under the
  // panels, because it is an action on the session and not a part of what
  // the session did - everything it needs to say is inside the dialog.
  if (data.resume) {
    const actions = el("div", "detail-actions");
    actions.append(button("ghost-btn", "Reconnect", () => reconnectModal(session, data.resume)));
    pane.append(actions);
  }

  if (live) {
    const pieces = [];
    if (live.now.task) pieces.push(taskLine(live.now.task));
    pieces.push(doingLine(live));
    if (live.now.trouble) {
      pieces.push(problem(live.now.trouble.message ? `Stuck since ${ago(live.now.trouble.since)}: ${live.now.trouble.message}` : `Stuck since ${ago(live.now.trouble.since)}.`));
    }
    // The reason nothing can be done to it from here, for whoever could
    // have done it. A stranger to the repo is not told; it is not theirs.
    if (own) pieces.push(steerLine(live, can, onChanged));
    pane.append(panel("Right now", ...pieces));
  }

  // The words are the repo's; everyone else reads the shape of them.
  const titles = new Map(tasks.map((task) => [task.id, task.title ?? null]));
  const caveats = [];
  if (!own) caveats.push(el("p", "console-caveat", "You are not on this session's repo, so the log shows what was done - not what was said."));
  pane.append(panel("Transcript", ...caveats, transcriptBox(transcript, { own, titles })));

  // The tiles are counts of what was seen; for a run nobody can watch being
  // prompted they would be a row of noughts saying it was never steered,
  // which is the claim the sentence above them exists to refuse. So the
  // sentence stands alone there.
  const watched = session.autonomy?.visible !== false;
  pane.append(
    panel(
      "Steering",
      ...[autonomyLine(session)].filter(Boolean),
      ...(watched
        ? [metrics(
            metric(friction.humanLines ?? 0, "lines from a person"),
            metric(friction.followUps ?? 0, "follow-ups"),
            metric(friction.interrupts ?? 0, "cut short"),
            metric(friction.retries ?? 0, "retries"),
            metric(friction.reviewRounds ?? 0, "review rounds"),
            metric(friction.failedTools ?? 0, "failed tool calls"),
          )]
        : []),
    ),
  );

  // And what got in its way, when something did (console-friction.js says
  // the same thing across a range; this is one session's share of it).
  const rubbing = frictionPanel(session);
  if (rubbing) pane.append(rubbing);
  // What it wrote, and what a reviewer kept of it. Its own panel rather
  // than a tile beside the steering ones: it is the other half of what the
  // session did, and on a phone a tile row is where a fact goes to hide.
  const wrote = writtenLine(session);
  if (wrote) pane.append(panel("Code written", wrote));

  if (pulls.length || session.pulls?.length) {
    const list = el("div", "pull-lines");
    // The session's own reason its lines are missing (`written.why`) goes
    // with it: where this session is the only one behind a merge, its
    // reason is the merge's reason too - see `pullNotMeasured`.
    for (const pull of pulls.length ? pulls : session.pulls) list.append(pullLine(pull, session.written?.why ?? null));
    pane.append(panel("Pull requests", list));
  }

  // Where the work was spoken about, when it was - the thread somebody
  // asked in is where they are waiting for the answer.
  const threads = session.threads ?? [];
  if (threads.length) {
    const list = el("div", "pull-lines");
    for (const thread of threads) list.append(threadLine(thread));
    pane.append(panel("Slack", list));
  }

  if (tasks.length) {
    const table = listTable({ head: ["Task", "State", "Estimate"] });
    for (const task of tasks) {
      table.append(
        listRow({
          name: task.title ?? task.id,
          note: task.retryOf ? `retry of ${task.retryOf}` : task.attempt > 1 ? `attempt ${task.attempt}` : null,
          cells: [statusCell(task.state, task.state === "done" ? "chip-ok" : task.state === "failed" ? "chip-err" : ""), task.estimateMinutes ? `${task.estimateMinutes}m` : "—"],
        }),
      );
    }
    pane.append(panel("Tasks", table));
  }

  const notes = [];
  if (!own) notes.push(el("p", "console-caveat", "You are not on this session's repo, so the timeline shows what was done and how long it took - not what was typed."));
  pane.append(panel("Timeline", ...notes, timeline(spans)));
  return pane;
}