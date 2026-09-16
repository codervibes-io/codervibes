// Activity: what is being worked on right now, and what was just finished.
// It was Home, and the page a bare address opened, until 2026-09-08; the
// search is that page now, and this is where it sends a reader.
//
// Everyone's, for everyone signed in. The page is one card per live
// session - an agent's stretch of work - in a list, one under the next,
// each the same seven facts: its name, how long, how many tokens, which
// model, whose, when it was last heard from, in which repo - and then the
// links out, to the ticket it is doing and the pull requests it opened;
// and then a list of the sessions that ended lately, each with what came
// of it. It was a page of totals with the sessions under them (Activity);
// the totals are Performance's, and the page a person opens first is
// about the work, one piece at a time.
//
// A card is a glance, not a console. What the agent is doing this second,
// who set it off, where it runs, a stuck notice, a box to say something -
// each was on the card once, and together they made a page you scrolled
// past to see who was working, which is the one question the page exists
// to answer. They are on the session's own page now, which the name opens.
//
// What is on the page is counts, ids and names, plus - for the sessions
// the viewer owns or shares a repo with - what the agent is doing and the
// task it is on, which is what somebody typed. A session somebody else
// owns arrives with the tool's name and no more (see /api/home), and its
// timeline with only the countable attributes on each span - see the
// session route. So the page can be everyone's without being anyone's
// diary.
//
// Both consoles draw it. The hosted one hands in the Needs action card
// (console-waiting.js), which is where the tasks, the merges and the
// approvals live; the local edition (local.js) hands in nothing and gets
// the page without that section - one person's sessions, working and
// finished, on their own machine. Which is why nothing here imports
// console-tasks.js: the cards do, and they are the argument.
import { api } from "./api.js";
import { el, button, ago, duration, count, problem, detailHead } from "./console-dom.js";
import { listTable, listRow, statusCell } from "./console-list.js";
import { facetPicker } from "./console-performance.js";
import { whereFilter, whereChip, whereLabel, include, widened } from "./console-where.js";
import { filterPicker } from "./console-filters.js";
// Whether there is a team to pick from, and tasks to wait on: on one
// person's machine (console-edition.js) the Who picker is a choice between
// three names for the same person, and the caveats that say whose a row is
// are about nobody.
import { hasWorkspaces } from "./console-edition.js";
// One session is its own page, in its own file - see console-session.js for
// why. What comes back from it is the vocabulary for naming a session, which
// the table below says in the same words as the page a row opens.
import { OUTCOMES, panel, goTo, whereOf, nameOf, actorLine } from "./console-session.js";

export { OUTCOMES };

const outcomeChip = (outcome) => {
  const entry = OUTCOMES[outcome] ?? OUTCOMES.none;
  return statusCell(entry.word, entry.className);
};

const plural = (n, word, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;


/** What a session's steering amounts to, in a few words. */
function steering(session) {
  const f = session.friction ?? {};
  const parts = [];
  if (f.lines) parts.push(plural(f.lines, "line"));
  if (f.retries) parts.push(plural(f.retries, "retry", "retries"));
  if (f.reviewRounds) parts.push(plural(f.reviewRounds, "review round"));
  if (f.failedTools) parts.push(`${f.failedTools} failed`);
  return parts.length ? parts.join(" · ") : "none";
}






/**
 * Sessions as a table: the finished list on Home, an agent's on its page,
 * a machine's on its. One shape, so "what did this do" reads the same
 * wherever it is asked.
 */
export function sessionsTable(sessions, { onOpen, pathFor, head = "Session", showMachine = true }) {
  const table = listTable({ head: [head, "Where", "When", "Outcome", "Steering"] });
  table.classList.add("activity-table");
  for (const session of sessions) {
    const live = session.state === "live";
    const ended = session.endedAt ?? session.lastSeenAt;
    // The machine's own page lists sessions on it, so saying "on navigator"
    // on every row there would say nothing.
    const where = [whereOf(session), showMachine && session.machine?.name && `on ${session.machine.name}`].filter(Boolean).join(" · ");
    // The mark goes in the Where cell, and into the aside as words: a
    // phone drops every cell but the kept one, and a row that says
    // "external repo" on a desktop and nothing on a phone is the bug
    // this app has shipped three times.
    const mark = whereChip(session.where);
    const said = whereLabel(session.where);
    const cell = el("span", "activity-where");
    cell.append(el("span", "activity-where-name", where));
    if (mark) cell.append(mark);
    table.append(
      listRow({
        name: nameOf(session),
        note: actorLine(session),
        aside: [where, said].filter(Boolean).join(" · "),
        live,
        cells: [
          cell,
          live ? `live · started ${ago(session.startedAt)}` : `${ago(ended)} · ran ${duration(ended - session.startedAt)}`,
          outcomeChip(session.outcome),
          steering(session),
        ],
        onOpen: () => onOpen(pathFor("activity", session.id)),
      }),
    );
  }
  return table;
}

/**
 * A panel of sessions read when it is drawn: an agent's on its Activity
 * tab, a machine's on its Sessions tab. The list is read on demand rather
 * than carried on the agent or machine record, because it is a month of
 * rows nobody asked for on a list of agents.
 *
 * @param {object} args
 * @param {string} args.title
 * @param {() => Promise<{sessions: object[]}>} args.read
 * @param {string} args.empty what to say when there are none
 * @param {(path: string) => void} args.onOpen
 * @param {(page: string, id?: string) => string} args.pathFor
 * @param {boolean} [args.showMachine] false on a machine's own page
 */
export function sessionsPanel({ title, read, empty, onOpen, pathFor, showMachine = true }) {
  const section = panel(title, el("p", "console-hint", "Reading…"));
  // A detail pane is narrower than Home, so the where and when cells wrap
  // here instead of being cut to "Navigator · on nav".
  section.classList.add("sessions-panel");
  read().then(
    ({ sessions }) => {
      section.replaceChildren(el("h3", "panel-heading", title));
      if (!sessions.length) {
        section.append(el("p", "console-hint", empty));
        return;
      }
      section.append(sessionsTable(sessions, { onOpen, pathFor, showMachine }));
      section.append(el("p", "console-caveat", "The last thirty days, newest first. Open one for its timeline, tasks and pull requests."));
    },
    (err) => {
      section.replaceChildren(el("h3", "panel-heading", title), problem(`Could not read the sessions - ${err.message}`));
    },
  );
  return section;
}

// ------------------------------------------------------------- the cards


/**
 * The pull request a session is back at work on, after handing it to a
 * person: the number as a link, and since when. Its card under Needs
 * action returns when this turn ends - said here, so the card's absence
 * reads as this and not as the pull request having gone.
 */
function backOnLine(backOn) {
  const line = el("span", "home-back-on");
  const link = el("a", "", `#${backOn.number}`);
  if (backOn.url) {
    link.href = backOn.url;
    link.target = "_blank";
    link.rel = "noopener";
  }
  line.append(link, ` since ${ago(backOn.since)} · its review card returns when this turn ends`);
  return line;
}


/**
 * One fact on a card: a label over its value. The value is a node when the
 * caller made one - a link - or the words as given.
 */
/**
 * The card's Repo fact: the repository, and the mark when it is not one of
 * this workspace's repos. On the fact rather than up in the card's head,
 * because the head does not wrap on a phone (console.css) - a chip there
 * takes the width off the name beside it, and the name is what the card is
 * for. Here it sits with the thing it is about at both widths.
 */
function repoFact(session) {
  const mark = whereChip(session.where);
  if (!mark) return whereOf(session);
  const wrap = el("span", "home-fact-where");
  wrap.append(el("span", null, whereOf(session)), mark);
  return wrap;
}

function fact(label, value) {
  const item = el("div", "home-fact");
  item.append(el("span", "home-fact-label", label));
  const out = el("span", "home-fact-value");
  out.append(value ?? "—");
  item.append(out);
  return item;
}

/**
 * How long a session has run: to now while it is live, to its end once it
 * is not. The page redraws on a timer, so a live card's clock moves.
 */
const durationOf = (session) =>
  duration((session.state === "live" ? Date.now() : session.endedAt ?? session.lastSeenAt) - session.startedAt);

/**
 * The task a session is on, as a link to where it is tracked: the ticket
 * in Linear when the task names one, else the task's title as words - a
 * task is answered from this page's Needs action, and the repo page that
 * listed them is gone. A stranger's task has no title here (nowOf), so
 * "a task" stands in; the ticket's id is a name in a tracker and travels
 * either way.
 */
function taskLink(task, { onOpen, pathFor }) {
  const ticket = task.ticket;
  if (ticket?.id) {
    if (!ticket.url) return el("span", "home-fact-text", ticket.id);
    const link = el("a", "home-fact-link", `${ticket.id} ↗`);
    link.href = ticket.url;
    link.target = "_blank";
    link.rel = "noopener";
    return link;
  }
  return goTo(task.title ?? "a task", null, onOpen);
}

/**
 * Where a session runs, for the card's side: the machine by name and the
 * kind of place it is - "MacBook Pro" over "Laptop", "sbx-4f2a" over "e2b
 * sandbox" - as the start hook reported it (index.js describeSessionMachine).
 * A session that never said - a resident, a deploy - has no place.
 */
function placeOf(session) {
  const machine = session.machine;
  if (!machine?.id) return null;
  return { name: machine.name ?? machine.id, host: machine.hostLabel ?? null };
}

/**
 * The pull requests a session opened, as one fact rather than a line each:
 * an open one is still in play, so it is a link out; the merged and the
 * closed are done, and a card of what is happening now says how many and
 * no more - the lines are on the session page.
 */
function pullsFact(pulls) {
  const value = el("span", "home-pulls");
  const open = pulls.filter((pull) => pull.state === "open");
  const merged = pulls.filter((pull) => pull.state === "merged").length;
  const closed = pulls.filter((pull) => pull.state === "closed").length;
  const pieces = [];
  for (const pull of open) {
    const label = `#${pull.number} ↗`;
    if (pull.url) {
      const link = el("a", "home-fact-link", label);
      link.href = pull.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.title = pull.title ?? "";
      pieces.push(link);
    } else {
      pieces.push(el("span", "home-fact-text", label));
    }
  }
  if (merged) pieces.push(el("span", "home-fact-text", `${merged} merged`));
  if (closed) pieces.push(el("span", "home-fact-text", `${closed} closed`));
  pieces.forEach((piece, index) => {
    if (index) value.append(" · ");
    value.append(piece);
  });
  return fact("Pull requests", value);
}

/**
 * One live session, as a card. On its far left, whose it is and where it
 * runs - the person's name over the machine's, and what kind of place that
 * is - because "who is working, and on what machine" is the first thing a
 * room of cards is asked. Then its name, and the facts a glance wants: how
 * long, how many tokens, the vendor behind the model and the harness it
 * runs in, when it was last heard from, in which repo - and, when it has
 * them, the task it is on and its pull requests, each a link out. The
 * vendor and the harness rather than the model id, because they are what
 * a person chose and what Performance compares by; the id is on the
 * session page. Nothing else: what it is doing this second and who set it
 * off are the session page's, one click away on the name.
 */
function workCard(session, { onOpen, pathFor }) {
  const card = el("article", "home-card live");
  const now = session.now ?? {};

  const side = el("div", "home-card-side");
  side.append(el("span", "home-card-owner", session.ownerName ?? session.owner ?? "somebody"));
  const place = placeOf(session);
  if (place) {
    side.append(el("span", "home-card-place", place.name));
    if (place.host) side.append(el("span", "home-card-host", place.host));
  }
  card.append(side);

  const main = el("div", "home-card-main");
  const head = el("div", "home-card-head");
  head.append(el("span", "rail-dot"));
  const name = goTo(nameOf(session), pathFor("activity", session.id), onOpen);
  name.classList.add("home-card-name");
  // The line ends in an ellipsis when the name is longer than the card;
  // the rest of it is a hover away.
  name.title = nameOf(session);
  head.append(name);
  main.append(head);

  const facts = el("div", "home-card-facts");
  facts.append(
    fact("Duration", durationOf(session)),
    fact("Tokens", session.counts?.tokens ? count(session.counts.tokens) : "0"),
    fact("Provider", session.provider ?? null),
    fact("Harness", session.harnessName ?? null),
    fact("Last active", ago(session.lastSeenAt)),
    fact("Repo", repoFact(session)),
  );
  if (now.task) facts.append(fact("Task", taskLink(now.task, { onOpen, pathFor })));
  if (session.pulls?.length) facts.append(pullsFact(session.pulls));
  // Back on a pull request it had handed to a person: its Needs action
  // card is away for this turn, and this is where it went.
  if (now.backOn) facts.append(fact("Back on", backOnLine(now.backOn)));
  main.append(facts);
  card.append(main);
  return card;
}

/** Whether "Finished recently" is open. Shut until a person opens it. */
let finishedOpen = false;

/**
 * The page.
 *
 * @param {object} args
 * @param {object|null} args.data what /api/home said, or null while reading
 * @param {string|null} args.failed why it could not be read
 * @param {(path: string) => void} args.onOpen
 * @param {(page: string, id?: string) => string} args.pathFor
 */
/**
 * The repo the page is narrowed to, or null for all of them. Module state,
 * like `finishedOpen`: the page is rebuilt whole on every event, and a
 * filter that reset itself on each tick could not be used. It is the id,
 * not the name - two repos can share a name across owners.
 */
let repoPick = null;

/**
 * The repo a row is in, as {key, label}, or null for a row in none.
 *
 * A row with no repo here is still in a repository when the harness
 * reported one (`where` is "external"), and it gets a chip of its own,
 * keyed by the repository's name: that is what makes the Repo filter able
 * to take an external repository off the page, or leave only it. Only a
 * row in no repository at all - `where` is "none" - has no chip.
 */
function repoOf(row) {
  const key = row.repoId ?? row.repo?.id ?? row.repo?.fullName ?? null;
  if (!key) return null;
  return { key, label: row.repo?.fullName ?? row.repoName ?? key };
}

/**
 * The repos the page's rows are in, each once, by name. Read off the
 * rows rather than the account's repo list: a filter for a repo with
 * nothing on the page would be a chip that empties it.
 */
function reposOn(...lists) {
  const seen = new Map();
  for (const row of lists.flat()) {
    const repo = repoOf(row);
    if (repo && !seen.has(repo.key)) seen.set(repo.key, repo);
  }
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
}

const inRepo = (row) => !repoPick || repoOf(row)?.key === repoPick;

/**
 * Whose work the page shows: the reader's own, their team's - the members
 * of the open workspace - or everyone's whose work lands on the
 * workspace's repos (a repository shared with another workspace brings
 * its people's sessions here too). "me" on every load: a person opens
 * Home to see what their own agents are doing, and the rest is a press
 * away. Module state like `repoPick`, for the same reason.
 */
let whoPick = "me";

/**
 * Everybody's, because there is no "me" to open on.
 *
 * The pick opens on the reader's own work, which is the right answer for
 * somebody with agents of their own and the wrong one for a visitor reading
 * the demo: they are nobody, "Me" matches no row, and the page that is meant
 * to show a team's month opens on "Nothing of yours is being worked on this
 * minute". Called once at boot (console.js), not on every draw - a visitor
 * may still press Me and see what the empty answer looks like.
 */
export function openOnEverybodysWork() {
  whoPick = "all";
}

const WHO = [
  ["me", "Me"],
  ["team", "My team"],
  ["all", "All"],
];

/**
 * The three, one picked. Not `facetPicker`: that puts All first and
 * unpicks to it, and this pick has no "none" - somebody's work is always
 * being shown, and "All" here is one of the three, not the absence of the
 * other two.
 */
function whoPicker(onPick) {
  return filterPicker({
    label: "Who",
    entries: WHO.map(([key, label]) => ({ key, label })),
    picked: whoPick,
    onPick: (key) => {
      if (key !== whoPick) onPick(key);
    },
    all: null,
  });
}

/**
 * The pick in force: what was pressed, or everybody's where there is
 * nobody to pick between. An installation with no workspaces
 * (console-edition.js) draws no Who picker, and "me" there would still
 * hide a row that names nobody - a session before its owner was known -
 * on a page where every row is the reader's.
 */
const whoInForce = () => (hasWorkspaces() ? whoPick : "all");

/**
 * Whether a row whose owner is `owner` is shown under the pick. A row
 * that names nobody - a task whose agent has no session around to say
 * whose it is - is not hidden by a filter that cannot judge it: it stays
 * under "team" and "all", and under "me" when it is the reader's to
 * decide, which is the one way such a row can be theirs.
 */
function underWho(owner, { me, team, askedOfMe = false }) {
  const who = whoInForce();
  if (who === "all") return true;
  if (who === "me") return owner ? owner === me : askedOfMe;
  return owner ? team.has(owner) : true;
}

/**
 * The line an empty Activity page fills in once it knows what "Workspace
 * only" left out: how many sessions, in what kind of place, and the press
 * that includes them. Hidden until there is something to say, and stays
 * hidden when there is not - an empty page with nothing behind it needs
 * no second sentence.
 */
function hiddenWork({ onChanged }) {
  const line = el("p", "console-hint home-hidden");
  line.hidden = true;
  api
    .homeEverywhere()
    .then((all) => {
      const rows = [...(all?.working ?? []), ...(all?.finished ?? [])];
      const out = rows.filter((row) => row.where && row.where !== "workspace");
      if (!out.length) return;
      const external = out.filter((row) => row.where === "external").length;
      const none = out.length - external;
      const what = [
        external ? `${plural(external, "session")} in repositories nobody connected here` : null,
        none ? `${plural(none, "session")} in no repository` : null,
      ]
        .filter(Boolean)
        .join(" and ");
      line.append(`Not shown: ${what}. `);
      line.append(
        button("ghost-btn", "Include them", () => {
          include(["external", "none"]);
          onChanged?.();
        }),
      );
      line.hidden = false;
    })
    .catch(() => null);
  return line;
}

/** "Nothing", "Nothing of yours", "Nothing of your team's" - the empty lines' opening, by the pick. */
const nothing = () => (whoInForce() === "me" ? "Nothing of yours" : whoInForce() === "team" ? "Nothing of your team's" : "Nothing");

/**
 * The page.
 *
 * @param {object} args
 * @param {object|null} args.data what /api/home said, or null while reading
 * @param {string|null} args.failed why it could not be read
 * @param {object|null} args.session who is reading, and who their team is
 * @param {(path: string) => void} args.onOpen
 * @param {(page: string, id?: string) => string} args.pathFor
 * @param {(() => void)|null} args.onChanged read the page again
 * @param {((task: object, ctx: object) => HTMLElement)|null} args.waitingCard
 *   how a Needs action row is drawn (console-waiting.js), or null on a
 *   console that has nothing to wait on - the section is then left off
 *   whatever the server sent, since a card with no buttons is a row the
 *   reader cannot act on.
 */
export function activityView({ data, failed, session = null, onOpen, pathFor, onChanged = null, waitingCard = null }) {
  const pane = el("div", "detail detail-wide");
  pane.append(
    detailHead(
      "Activity",
      el(
        "p",
        "detail-summary",
        hasWorkspaces()
          ? "What is being worked on right now, and what was finished lately - yours, your team's, or everyone's on this installation."
          : "What is being worked on right now, and what was finished lately, on this machine.",
      ),
    ),
  );

  if (failed) {
    pane.append(problem(`Could not read what is happening - ${failed}`));
    return pane;
  }
  if (!data) {
    pane.append(el("p", "console-hint", "Reading…"));
    return pane;
  }

  const redraw = () => pane.replaceWith(activityView({ data, failed, session, onOpen, pathFor, onChanged, waitingCard }));
  const tools = el("div", "list-tools home-filters");
  const groups = el("div", "filter-row");
  tools.append(groups);
  pane.append(tools);

  // Whose, first: the reader, the open workspace's members, or everyone.
  // The reader counts as their own team, whatever the member list says -
  // a personal workspace lists only them.
  const me = session?.user ?? null;
  const team = new Set((session?.workspace?.members ?? []).map((member) => member.email));
  if (me) team.add(me);
  // No picker where there is nobody to pick between: one person's
  // installation has no team, and "Me", "My team" and "All" are three
  // names for them (`whoInForce`).
  if (hasWorkspaces()) {
    groups.append(
      whoPicker((key) => {
        whoPick = key;
        redraw();
      }),
    );
  }
  const mine = (row) => underWho(row.owner ?? null, { me, team, askedOfMe: Boolean(row.canDecide) });
  const whose = {
    working: (data.working ?? []).filter(mine),
    finished: (data.finished ?? []).filter(mine),
    waiting: (data.waiting ?? []).filter(mine),
  };

  // Then what counts as this workspace's work at all: its own repos, and
  // - when asked for - repositories nobody connected here and work in
  // none. Asking re-reads the page, because that set is the server's
  // answer and not something the browser can filter its way to; the Repo
  // list below is cut from whatever comes back.
  // Nothing at all where every row is already on the page (console-where.js
  // `oneWhere`): the filter draws as null there, and so does the line
  // below that would offer to include what is not hidden.
  const where = whereFilter(() => onChanged?.());
  if (where) groups.append(where);

  // Then one repo, or all of them. The Repos page that showed one repo's
  // work went (2026-09-07); this is what replaced it - the same page,
  // narrowed. The list is the repos with something on the page under the
  // picks above; a pick that no longer matches anything (the repo went
  // quiet) falls back to all, so the page is never empty because of a
  // filter set last week.
  const repos = reposOn(whose.working, whose.finished, whose.waiting);
  if (repoPick && !repos.some((repo) => repo.key === repoPick)) repoPick = null;
  if (repos.length > 1) {
    groups.append(
      facetPicker("Repo", repos, repoPick, (key) => {
        repoPick = key;
        redraw();
      }),
    );
  }

  const working = whose.working.filter(inRepo);
  const finished = whose.finished.filter(inRepo);
  const waiting = whose.waiting.filter(inRepo);

  // First, before what is happening: what is not happening until somebody
  // here does something. A task waiting on a review, an answer or an
  // approval is the one thing on this page that asks rather than tells -
  // and so is an open pull request, which is a task's outcome waiting on a
  // person whether or not the agent parked the task on it.
  if (waiting.length && waitingCard) {
    const needs = el("section", "home-section home-waiting");
    needs.append(el("h2", "home-heading", `Needs action · ${waiting.length}`));
    const list = el("ul", "home-waiting-list");
    for (const task of waiting) list.append(waitingCard(task, { onOpen, pathFor, onChanged }));
    needs.append(list);
    needs.append(el("p", "console-caveat", "Each card is answered from here: a question with the box, a review on GitHub or with Merge, and the task comes back to its agent on its own. An open pull request stays here until it is merged or closed on GitHub. An access request is decided here, by the repo's owner, and lasts as long as the button says; a call marked 'ask first' on the agent's Access tab is approved here one call at a time, and runs once."));
    pane.append(needs);
  }

  const now = el("section", "home-section");
  now.append(el("h2", "home-heading", working.length ? `Working now · ${working.length}` : "Working now"));
  if (working.length) {
    const cards = el("div", "home-cards");
    for (const session of working) cards.append(workCard(session, { onOpen, pathFor }));
    now.append(cards);
  } else {
    now.append(el("p", "console-hint", repoPick ? `${nothing()} is being worked on in this repo this minute.` : `${nothing()} is being worked on this minute. A card appears here the moment an agent connects and starts.`));
  }
  pane.append(now);
  // A page with nothing on it at "Workspace only" may be hiding the very
  // work the reader came for: a first session is usually in a repository
  // nobody connected here - most work is, since a team rarely administers
  // the repositories it works in - and the default keeps that off every
  // listing (console-where.js). To somebody who just ran the setup line
  // and started an agent, an empty page reads as "it does not work". So an
  // empty page asks once for everything, says what that found, and offers
  // the press that shows it.
  if (where && !working.length && !finished.length && !waiting.length && !widened() && !repoPick) pane.append(hiddenWork({ onChanged }));

  // What is done is done: nothing on it asks for anything, so it opens on
  // a click rather than pushing the page down under a table. Whether it
  // is open is kept across redraws - the page is rebuilt whole every half
  // minute, and a section that shut itself on each tick would be one that
  // cannot be read.
  const done = el("details", "home-section home-done");
  done.open = finishedOpen;
  done.addEventListener("toggle", () => {
    finishedOpen = done.open;
  });
  done.append(el("summary", "home-heading", finished.length ? `Finished recently · ${finished.length}` : "Finished recently"));
  if (!finished.length) {
    done.append(el("p", "console-hint", repoPick ? `${nothing()} has finished in this repo in the last 30 days.` : `${nothing()} has finished in the last 30 days.`));
  } else {
    done.append(sessionsTable(finished, { onOpen, pathFor }));
    done.append(
      el(
        "p",
        "console-caveat",
        hasWorkspaces()
          ? "Sessions that ended in the last 30 days, newest first. A session you may read is named after its first ask; anyone else's, after who was working. The totals are on Performance."
          : "Sessions that ended in the last 30 days, newest first, each named after its first ask until the agent names it. The totals are on Performance.",
      ),
    );
  }
  pane.append(done);
  return pane;
}

