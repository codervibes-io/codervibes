// The Executors page: everything that does work, on one list, and the page
// of one of them.
//
// This was the top of console-lists.js and the executors branch of
// console.js's `drawPage`. It is its own module because it is the page a
// bare address opens, and because it is the one page a slim shell - a
// console for one person's own machines, with no connectors and no
// workspace - cannot do without.
//
// **Nothing here reaches console-external.js or console-agent.js.** Those
// two are the whole of the rest of the console by transitive import -
// console-external.js pulls console-home.js, which pulls the cards and the
// tasks - and a page module that dragged them in would make the slim shell
// a fiction. What they know is handed in instead: `describeExternal` says
// what a vendor's agent's status and location are, and `detailFor` draws
// the kinds of page this module has no drawing for. A caller that passes
// neither gets a list with harnesses and setups on it, which is what a
// machine reporting from a laptop is.
//
// What a row says comes from what the console already holds for the thing's
// own page; nothing here fetches except the ingest token, which is the
// setup line's and is read only while this page is on screen.
import { el, ago, lastSeen, agentStatus, money, helpMark, TASK_HELP } from "./console-dom.js";
import { listTable, listRow, statusCell, listHead } from "./console-list.js";
import { setupPanel, setupDetail } from "./console-connect.js";
import { harnessDetail } from "./console-harnesses.js";
import { hasAgents } from "./console-edition.js";

const plural = (n, word, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;

/**
 * "Idle" is the wrong word for an agent that is waiting on another one.
 *
 * Nothing interrupts an agent with a task, so one that has been handed work
 * and has not looked yet is idle in every sense the activity feed can see -
 * and completely different to one that has simply finished.
 */
export function waitingNote(agent) {
  const open = (agent.tasks ?? []).filter((task) => task.state === "open");
  const mine = open.filter((task) => task.to.id === agent.id);
  if (mine.length) return `${mine.length} waiting for it`;
  const sent = open.filter((task) => task.from.id === agent.id);
  return sent.length ? `waiting on ${sent[0].to.name}` : null;
}

/** Where an agent works: the repos it is in - or, for somebody else's agent, its vendor and the login it acts as. */
function whereItIs(agent, describeExternal) {
  if (agent.kind === "external") return describeExternal?.where?.(agent) ?? null;
  const names = (agent.repos ?? []).map((repo) => repo.name);
  return names.length ? names.join(", ") : null;
}

/**
 * How effective an executor is, this month, said again under the name for
 * the phone - where every cell but the status is dropped, so the three
 * figures the desktop gives columns to are gone. One line, in the order
 * the columns run: tasks finished of taken, sessions, and what it cost.
 */
function standingLine(performance, priced = false) {
  if (!performance || !performance.sessions) return null;
  const parts = [performance.tasks ? `${performance.finished} of ${plural(performance.tasks, "task")} done` : "no task", plural(performance.sessions, "session")];
  if (priced && performance.cost) parts.push(money(performance.cost));
  return `${parts.join(" · ")} this month`;
}

/**
 * Tasks: finished of those taken - "3 of 4 tasks done". A dash for one with
 * no session in the month; "no task" for one that worked and was asked for
 * no piece of work at all, which is not a zero - an agent somebody only
 * asked questions of has not failed at anything.
 *
 * This column used to be merged-of-opened pull requests, which said
 * "0 of 0" for every agent that does not write them and sorted it last.
 * What a task is now is the "?" in the head, and server/performance.js.
 *
 * Plain text, not a chip. A chip is how this console says something is on
 * or wrong - live, silent, sensitive - and a rate is neither; marking the
 * effective ones in green made the column read as a row of verdicts
 * rather than a row of figures. Whether a rate is good is the reader's
 * call, made by looking down the column.
 */
function tasksHead() {
  const head = el("span", "help-head");
  head.append("Tasks done", helpMark("a task", TASK_HELP));
  return head;
}

function tasksCell(performance) {
  if (!performance || !performance.sessions) return "—";
  return performance.tasks ? `${performance.finished} of ${plural(performance.tasks, "task")} done` : "no task";
}

/**
 * Sessions: how much work it did this month, and how much of it is running
 * now - the one second line left. The other two columns had one each,
 * saying what a task took in steering lines and money, and three stacked
 * pairs put the paragraph back in the table that splitting the cell was
 * meant to take out of it. Those per-task figures are on the executor's
 * own page, which is where a question about one executor belongs; this
 * list answers questions about several at once.
 */
function sessionsCell(performance) {
  if (!performance || !performance.sessions) return "—";
  const cell = el("span", "list-standing");
  cell.append(el("span", "", String(performance.sessions)));
  if (performance.live) cell.append(el("span", "list-standing-note", `${performance.live} live now`));
  return cell;
}

/**
 * Cost: what its sessions came to this month. A dash when nothing this
 * installation has seen carries a price - an unpriced zero reads as free,
 * which is the one thing it does not mean.
 */
function costCell(performance, priced) {
  if (!priced || !performance || !performance.sessions) return "—";
  return money(performance.cost);
}

/** What a harness row is up to: reporting now, has reported, or never heard from. */
function harnessStatus(row) {
  if (row.live) return { word: "busy", className: "chip-ok", up: true, order: 0 };
  if (row.lastAt) return { word: "reporting", className: "chip-ok", up: false, order: 1 };
  // The setup script ran here and nothing has since: not silent, which
  // would read as broken, but waiting for its first session.
  if (row.setUp && !row.sessions) return { word: "ready", className: "chip-none", up: false, order: 2 };
  return { word: "silent", className: "chip-none", up: false, order: 3 };
}

/**
 * The status of any row, by its kind. Three vocabularies - an agent's, a
 * vendor's, a harness's - with one shape, so one sort and one colour scheme
 * cover the list; a vendor's words are `describeExternal.status`, which the
 * full console passes in from console-external.js.
 */
function statusOf(row, describeExternal) {
  if (row.kind === "external" && describeExternal?.status) return describeExternal.status(row);
  // A setup reports the same way a harness does - it *is* one, found rather
  // than declared - so it gets the same words.
  if (row.kind === "harness" || row.kind === "setup") return harnessStatus(row);
  return agentStatus(row);
}

// There was a Kind column - "resident", "harness", "your setup", "vendor" -
// and a Tasks one. Neither answered a question anybody brought to this page:
// a row's kind is fixed for its life and is said on its own page, and tasks
// were a count that was a dash for every row this app did not start. The
// width they took now goes to the three figures that do change.

/**
 * Who let it in. An agent started by another agent is recorded as
 * `agent:<name>`. A person is shown by the part before the @ - a column of
 * full addresses is a column of the same domain - with the whole address
 * on hover.
 */
function invitedByOf(row) {
  const by = row.invitedBy?.by ?? row.createdBy ?? null;
  if (!by) return "—";
  if (by.startsWith("agent:")) return by.slice("agent:".length);
  const cell = el("span", null, by.includes("@") ? by.slice(0, by.indexOf("@")) : by);
  cell.title = by;
  return cell;
}

/** When it last did anything, in the words each kind has for that. */
function lastActive(row) {
  if (row.kind === "external") {
    return row.lastAt ? ago(row.lastAt) : row.verifiedAt ? `verified ${ago(Date.parse(row.verifiedAt))}` : "never verified";
  }
  if (row.kind === "setup" && !row.sessions && row.setUp) return `set up ${ago(Date.parse(row.setUp.at))}`;
  if (row.kind === "harness" || row.kind === "setup") return row.lastAt ? ago(row.lastAt) : "never";
  return lastSeen(row, { verb: "" }).trim();
}

/**
 * Everything that does work, on one list - see /api/executors for what a
 * row is. The Claude Codes reporting from laptops and sandboxes, the agents
 * invited to work over MCP, and the vendors' agents, each with where it runs
 * and who let it in.
 *
 * **Nothing here is made.** This app does not start agents any more - people
 * run them in their own terminal or their own e2b sandbox - so there is no
 * New button and no wizard. A row appears when the setup script runs
 * somewhere, or when something reports - which is why the setup line is the
 * top of this page, empty or full (console-connect.js setupPanel): it is
 * the page a bare address opens, and its first job is getting the first
 * row onto it.
 *
 * @param {object} args
 * @param {object[]} args.executors
 * @param {object|null} args.ingest the account's token and steps, /api/ingest
 * @param {string|null} [args.ingestFailed] why there is no `ingest`, when its read failed
 * @param {boolean} [args.theirs] the demo: the list is the room's rather
 *   than the reader's, so it is described as a team's setup and not as
 *   "yours" (server/index.js `executorsForRoom`)
 * @param {{status: Function, where: Function}|null} [args.describeExternal]
 *   what a vendor's agent's status and location are, from
 *   console-external.js - passed in rather than imported, see the header
 * @param {boolean} [args.machinesOnly] this installation has no invited
 *   agents and no vendors' agents, so the only thing that can ever be on
 *   this list is a machine that reported. The sentence under the line says
 *   what the list holds, and promising two kinds of row that cannot appear
 *   is how a page teaches somebody to look for a feature that is not there.
 * @param {(path: string) => void} args.onOpen
 * @param {(page: string, id: string) => string} args.pathFor
 * @param {() => void} args.onChanged
 */
export function executorsList({ executors, ingest, ingestFailed = null, priced = false, theirs = false, machinesOnly = false, describeExternal = null, onOpen, pathFor, onChanged }) {
  const rows = executors.map((row) => ({ row, status: statusOf(row, describeExternal) }));
  const busy = rows.filter(({ status }) => status.word === "busy").length;
  const idle = rows.filter(({ status }) => status.word === "idle").length;
  const waiting = executors.filter((row) => waitingNote(row)).length;
  // Nothing yet: no count under the title and no list, the line, and a
  // sentence saying what happens once it has run.
  if (!executors.length) {
    const pane = listHead("Executors", null, []);
    pane.append(setupPanel({ ingest, failed: ingestFailed, onChanged }));
    pane.append(el("p", "console-hint", "Nothing has reported yet. Once the line has run somewhere, start a session there and it appears here as a row."));
    return pane;
  }

  const summary = [
    plural(executors.length, "executor"),
    busy ? `${busy} busy` : null,
    idle ? `${idle} idle` : null,
    waiting ? `${waiting} waiting` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // The line stays above the list: the way to add another machine is the
  // same line, and a person who set one up last week is looking for it.
  const pane = listHead("Executors", summary, []);
  pane.append(setupPanel({ ingest, failed: ingestFailed, onChanged }));

  pane.append(
    el(
      "p",
      "console-hint",
      machinesOnly
        ? "Every machine reporting here. A Claude Code, Codex, Gemini CLI or OpenCode on your " +
          "laptop or in a sandbox reports what it did once the line above has run there - which " +
          "repositories it worked in, how many sessions, what they cost. Each opens to what it " +
          "has done, and to Forget, which drops the row and frees its place. The sessions and " +
          "cost are the last 30 days."
        : theirs
        ? "Everything that does work here, whoever it works for. A Claude Code, Codex or " +
          "Gemini CLI on somebody's laptop or in a sandbox reports what it did once their " +
          "setup line has run there; an agent they invited works in their repos over MCP " +
          "with exactly the permissions they ticked; a vendor's agent - Greptile, " +
          "Niteshift - works on their repositories as a bot. Each says whose machine it " +
          "runs on and who let it in, and each opens to what it has done. The pull " +
          "requests, sessions and cost are the last 30 days."
        : "Everything that does work for you. A Claude Code, Codex or Gemini CLI on your laptop " +
        "or in a sandbox reports what it did once your setup line has run there; " +
        "an agent you invited works in your repos over MCP with exactly the " +
        "permissions you tick; a vendor's agent - Greptile, Niteshift - works " +
        "on your repositories as a bot. Each says where it runs and who let " +
        "it in, and each opens to what it has done. The tasks, sessions " +
        "and cost are the last 30 days.",
    ),
  );

  // Busy first, then awake, then asleep, then never seen - and within a
  // band by this month's standing (performance.js: what got finished, less
  // what it took), then by last activity. The question this list answers is
  // "what is going on", and what is going on is at the top.
  rows.sort(
    (a, b) =>
      a.status.order - b.status.order ||
      (b.row.performance?.score ?? 0) - (a.row.performance?.score ?? 0) ||
      (b.row.lastAt ?? 0) - (a.row.lastAt ?? 0),
  );
  // The status is the one cell a phone keeps (statusCell marks it): a name
  // and whether it is working is the list at 390px.
  // Who let it in is a column only where something can be let in. An
  // installation with no invited agents (console-edition.js) has one kind
  // of row - a machine that reported - and nothing ever invited it, so the
  // column was a full column of dashes and the width is better spent on
  // the figures beside it.
  const table = listTable({
    head: ["Executor", "Location", ...(hasAgents() ? ["Invited by"] : []), "Status", tasksHead(), "Sessions", "Cost", "Last active"],
  });
  for (const { row, status } of rows) {
    const calls = row.calls ?? [];
    const running = calls.find((call) => call.state === "running");
    table.append(
      listRow({
        name: row.name,
        // What it is doing beats where it is: a working one's summary, a
        // waiting one's wait.
        note: running ? running.summary : waitingNote(row),
        // The month's standing, for the phone, where the three cells are gone.
        aside: standingLine(row.performance, priced),
        live: status.up,
        busy: status.word === "busy",
        onOpen: () => onOpen(pathFor("executors", row.id)),
        cells: [
          row.location?.label ?? whereItIs(row, describeExternal) ?? "—",
          ...(hasAgents() ? [invitedByOf(row)] : []),
          statusCell(status.word, status.className),
          tasksCell(row.performance),
          sessionsCell(row.performance),
          costCell(row.performance, priced),
          lastActive(row),
        ],
      }),
    );
  }
  pane.append(table);
  return pane;
}

/**
 * The page, wired up: the list, one executor, and the ingest token the
 * setup line at the top of the list needs.
 *
 * @param {object} ctx
 * @param {object} ctx.state the console's one state object
 * @param {object} ctx.api
 * @param {(path: string) => void} ctx.go
 * @param {(page: string, id?: string) => string} ctx.pathFor
 * @param {() => Promise} ctx.refresh
 * @param {(path: string) => Node} ctx.back
 * @param {object} [opts]
 * @param {{status: Function, where: Function}|null} [opts.describeExternal]
 * @param {(executor: object, opts: {readOnly: boolean}) => Node|null} [opts.detailFor]
 *   the page of a kind this module does not draw - a resident agent's, a
 *   vendor's. Null for a shell that has neither.
 * @param {boolean} [opts.sessionsPage] whether this shell has a page that
 *   lists a machine's sessions to send somebody to - Search, narrowed to
 *   the machine. Both editions have it; a shell whose pages do not must
 *   not draw a button to one.
 * @param {((executor: object) => Promise|void)|null} [opts.onForget] what
 *   Forget does on a machine's page, where there is a cap and forgetting is
 *   how a place comes free. Null draws no button - see console-connect.js.
 */
export function executorsPage(
  { state, api, go, pathFor, refresh, back },
  { describeExternal = null, detailFor = null, sessionsPage = true, onForget = null } = {},
) {
  let loadingIngest = null;

  /** Whether the Connect panel is on screen, and so the ingest token should be read. */
  const wantsIngest = () => state.page === "executors" && !state.selected;

  /**
   * The account's ingest token, for the Connect panel.
   *
   * Read once and kept: the answer does not change unless somebody rotates,
   * and the rotate hands the new one straight back. Not on every refresh
   * because the first read *mints* - which is right when a person has opened
   * the page that gives them a token, and would be noise on a poll.
   */
  function loadIngest() {
    if (loadingIngest || state.ingest) return loadingIngest;
    loadingIngest = api
      .ingest()
      .then(
        (answer) => {
          state.ingest = answer;
          state.failed.ingest = null;
        },
        (err) => {
          state.failed.ingest = err.message;
        },
      )
      .finally(() => {
        loadingIngest = null;
      });
    return loadingIngest;
  }

  function draw(pane) {
    if (!state.selected) {
      pane.append(
        executorsList({
          executors: state.executors,
          ingest: state.ingest,
          ingestFailed: state.failed.ingest,
          priced: state.executorsPriced,
          // In the demo the list is the made-up team's rather than the
          // reader's (server/index.js `executorsForRoom`).
          theirs: Boolean(state.session?.workspace?.demo),
          // A shell that was handed no way to draw an invited agent's page
          // or a vendor's is a shell where neither can appear on the list -
          // the two are the same fact, so the sentence under the line reads
          // off it rather than off a flag somebody has to remember to set.
          machinesOnly: !detailFor,
          describeExternal,
          onOpen: go,
          pathFor,
          // A rotate hands back the new token; keeping it is the only way it
          // is ever shown, since the next read has nothing but its hash.
          onChanged: (ingest) => {
            if (ingest) state.ingest = ingest;
            return refresh();
          },
        }),
      );
      return;
    }
    pane.append(back(pathFor("executors")));
    const executor = state.executors.find((entry) => entry.id === state.selected);
    // Gone - deleted, or an address for somebody else's. The list is the
    // honest answer, and it says so itself rather than leaving a blank pane.
    if (!executor) return go(pathFor("executors"), { replace: true });
    // In the demo every executor is one of the made-up people's, so each
    // kind of page shows what it did and leaves out what would change it -
    // the routes behind those are one person's own. See `readersOf`.
    const readOnly = Boolean(state.session?.workspace?.demo);
    // A machine of yours that reported, rather than one somebody declared:
    // what it has done and where, and nothing to start or stop.
    if (executor.kind === "setup") {
      pane.append(
        setupDetail(executor, {
          onOpen: go,
          pathFor,
          sessions: sessionsPage,
          onForget: onForget ? () => onForget(executor) : null,
        }),
      );
      return;
    }
    // A harness on a laptop reporting for nobody: what it is, how it
    // connects, and what its sessions came to. No tasks - it
    // is a process somebody runs, not an agent this app can reach.
    if (executor.kind === "harness") {
      pane.append(harnessDetail(executor, { readOnly, onChanged: refresh }));
      return;
    }
    // A resident agent's page, or somebody else's agent's - neither of
    // which this module draws; see the header.
    const detail = detailFor?.(executor, { readOnly });
    if (detail) pane.append(detail);
  }

  return {
    draw,
    loadIngest,
    // And the ingest token, read on arrival at the Executors list - the panel
    // is the first thing on that page, so it is drawn twice rather than kept
    // waiting for it.
    read: () => (wantsIngest() && state.ingest === null && !state.failed.ingest ? loadIngest() : null),
  };
}
