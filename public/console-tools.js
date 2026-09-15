// Tools: what the agents reached for beyond their harness, and what came of it.
//
// The page is for one reader: an engineer, or an agent, wondering what to
// give the next session. What they want to know first is which of the
// things we gave the agents are used at all, and whether the sessions they
// were in got their work merged - so every connector, skill and tool is
// one row of a list with the same numbers beside it: how many times it was
// used, how many of those calls worked, how many sessions it was in, how
// many of those closed, when it was last used. Connectors and skills are
// lists of their own, above the rest, because those are the choices:
// which services to connect, which skills to install.
//
// It was cards before, each carrying its last five sessions by name: a
// screen and a half of reading to compare two connectors, with the fact
// somebody came for - is this used at all? - written into prose halfway
// down a card. The names have not gone. They are on the tool's own page,
// one press from its row, which is where a reader who has already picked
// a row asks what it did there.
//
// The harness's own reading, editing, running and searching is not here at
// all. Every session does thousands of those and nothing about them is a
// choice; they stay on each session's page, where "what did it read" is
// asked. The server leaves them out (tool-stats.js `isNative`).
//
// "Closed" is a session whose pull request merged. The tool was in the
// room: that is company, not cause, and the page says so - but company is
// what a reader choosing tools can act on. A row with more sessions than
// its page can name is one whose sessions are older than the ranking
// holds, or live: counted, not listed.
import { el, ago, duration, count, money, problem, detailHead, metric, metrics } from "./console-dom.js";
import { listTable, listRow, statusCell, heatRanks, heatCell } from "./console-list.js";
import { RANGES, rangePicker } from "./console-performance.js";
import { effectNote } from "./console-harness.js";
import { whereFilter, whereChip } from "./console-where.js";
import { filterRow } from "./console-filters.js";

const percent = (rate) => (rate == null ? "—" : `${Math.round(rate * 100)}%`);
const plural = (n, word) => `${count(n)} ${word}${n === 1 ? "" : "s"}`;

/** What a tool's kind is called on the page. */
const KIND = {
  builtin: "built in",
  collab: "between agents",
  connector: "connector",
  membership: "membership",
  mcp: "MCP server",
  external: "vendor agent",
  harness: "harness",
};
const kindLabel = (kind) => KIND[kind] ?? kind ?? "other";

/** How a skill was reached, as the page says it. */
const VIA = { tool: "Skill tool", prompt: "typed", file: "file read" };

/** What a session came to, as a chip: the pull request's state. */
export const OUTCOME_CHIPS = {
  merged: ["merged", "chip-ok"],
  open: ["open", "chip-open"],
  closed: ["closed", "chip-err"],
  none: ["no pull request", "chip-none"],
};

function outcomeChip(outcome) {
  const [label, className] = OUTCOME_CHIPS[outcome] ?? OUTCOME_CHIPS.none;
  return el("span", `chip ${className}`.trim(), label);
}

/** A session's name: its ask when the viewer may read it, else who was working. */
const sessionName = (session) => session.title || session.actor?.name || session.actor?.id || session.id;

/** The line about how far the numbers reach - the range, or less if the spans do not go that far. */
function reachLine(data) {
  if (!data.reach || data.reach <= data.since) return null;
  return `Calls are counted since ${new Date(data.reach).toLocaleString()} - as far back as this server holds spans.`;
}

/**
 * The sessions a row is attributed to: the last few by name, each a link
 * to the session with what it came to beside it. A row with more than are
 * named says how many more. This is the tool's own page; the lists say the
 * counts and leave the names to here.
 */
function recentSessions(row, { onOpen, pathFor }) {
  const wrap = el("div", "tool-sessions-block");
  const recent = row.recent ?? [];
  if (!recent.length) {
    wrap.append(
      el(
        "p",
        "console-hint",
        row.sessionsUsed
          ? "Used in sessions the ranking no longer holds, or in ones still running."
          : "No session used it in this range.",
      ),
    );
    return wrap;
  }
  wrap.append(el("h4", "tool-sessions-title", "Sessions"));
  const list = el("ul", "tool-sessions");
  for (const session of recent) {
    const item = el("li", "tool-session");
    const link = el("a", "tool-session-name", sessionName(session));
    link.href = pathFor("activity", session.id);
    link.addEventListener("click", (event) => {
      event.preventDefault();
      onOpen(link.getAttribute("href"));
    });
    const when = session.endedAt ?? session.lastSeenAt;
    // The repo here if there is one, else the repository the harness
    // reported, with the mark that says nobody here connected it.
    const named = session.repoName ?? session.repository ?? null;
    item.append(
      ...[
        link,
        outcomeChip(session.outcome),
        // Nothing at all for a session in one of this workspace's own
        // repos; `append` would put the word "null" on the line.
        whereChip(session.where),
      ].filter(Boolean),
      el(
        "span",
        "tool-session-note",
        [session.title ? session.actor?.name : null, named ? `in ${named}` : null, when ? ago(when) : null, session.cost ? money(session.cost) : null]
          .filter(Boolean)
          .join(" · "),
      ),
    );
    list.append(item);
  }
  wrap.append(list);
  const more = (row.sessionsUsed ?? 0) - recent.length;
  if (more > 0) wrap.append(el("p", "tool-sessions-more", `And ${plural(more, "more session")}.`));
  return wrap;
}

/**
 * How many of a row's sessions closed, as the cell a phone keeps - the one
 * fact that survives when the other columns go (`statusCell` marks it).
 */
function closedWords(row) {
  if (row.sessionsClosed) return [`${row.sessionsClosed} closed`, "chip-ok"];
  if (row.sessionsUsed) return ["none closed yet", "chip-none"];
  return ["no sessions", "chip-none"];
}
const closedCell = (row) => statusCell(...closedWords(row));

/** The columns every list on this page carries after the name. */
export const COLUMNS = ["Used", "Worked", "Sessions", "Closed", "Last used"];

/**
 * One row of any of the three lists: the thing, then the same five numbers
 * in the same order, so a connector and a tool compare without re-reading
 * the head.
 *
 * `used` is how many times it was called - loaded, for a skill - which is
 * the question the page is asked first. What worked is shaded against the
 * rest of its list (`heat`), because the row a reader wants out of forty
 * is the one failing half its calls and that is a colour to scan for, not
 * a number to compare forty times. A phone drops every cell but the closed
 * chip, so how much it was used and how much of that worked is said again
 * under the name as the row's `aside` - the failing connector is the
 * reason to open the page, and it must not be the fact the narrow screen
 * loses. Two facts and not three: the sessions count is a third that wraps
 * the line at 390px, and the closed chip beside it already says how those
 * sessions went.
 */
function statRow({ name, note, used, okRate, row, heat, onOpen }) {
  return listRow({
    name,
    note,
    aside: used ? `${count(used)} used · ${percent(okRate)} worked` : plural(row.sessionsUsed ?? 0, "session"),
    cells: [used ? count(used) : "—", used ? heatCell(percent(okRate), heat) : "—", row.sessionsUsed ? count(row.sessionsUsed) : "—", closedCell(row), row.lastAt ? ago(row.lastAt) : "—"],
    onOpen,
  });
}

/** The connectors, most closed first (the server's order); a row opens the connector. */
function connectorsTable(rows, { onOpen, pathFor }) {
  const table = listTable({ head: ["Connector", ...COLUMNS] });
  table.classList.add("tools-table");
  const heat = heatRanks(rows.map((row) => (row.calls ? row.okRate : null)), "high");
  rows.forEach((row, at) => {
    const tools = row.tools ?? [];
    table.append(
      statRow({
        name: row.id,
        note: [tools.length ? plural(tools.length, "tool") : null, row.writes ? plural(row.writes, "write") : null].filter(Boolean).join(" · "),
        used: row.calls,
        okRate: row.okRate,
        row,
        heat: heat[at],
        onOpen: () => onOpen(pathFor("connectors", row.id)),
      }),
    );
  });
  return table;
}

/**
 * The skills. A skill has no page of its own, so its row opens nothing and
 * is handed no opener: the numbers and how the skill was reached are the
 * whole of what this app knows about one.
 */
function skillsTable(rows) {
  const table = listTable({ head: ["Skill", ...COLUMNS] });
  table.classList.add("tools-table");
  const rateOf = (row) => (row.uses ? (row.uses - (row.failed ?? 0)) / row.uses : null);
  const heat = heatRanks(rows.map(rateOf), "high");
  rows.forEach((row, at) => {
    const uses = row.uses ?? 0;
    const how = Object.entries(row.via ?? {})
      .filter(([, n]) => n)
      .map(([via, n]) => `${VIA[via] ?? via} ×${n}`)
      .join(", ");
    table.append(
      statRow({
        name: row.name,
        // And what loading it did, when there is enough of it to say:
        // "Sessions using it finish first time 71% vs 54%" against the
        // sessions of the same repositories that did not (the server's
        // `skillEffect`). Nothing at all when it is too thin to judge - a
        // skill three sessions have touched has no effect worth printing,
        // and printing one would be this page's opinion.
        note: [how || null, row.failed ? `${count(row.failed)} failed` : null, effectNote(row.effect)].filter(Boolean).join(" · "),
        used: uses,
        okRate: rateOf(row),
        row,
        heat: heat[at],
        onOpen: null,
      }),
    );
  });
  return table;
}

/** The other tools - this app's, a person's MCP servers - one row each; a row opens the tool. */
function toolsTable(rows, { onOpen, pathFor }) {
  const table = listTable({ head: ["Tool", ...COLUMNS] });
  table.classList.add("tools-table");
  const heat = heatRanks(rows.map((row) => (row.calls ? row.okRate : null)), "high");
  rows.forEach((row, at) => {
    table.append(
      statRow({
        name: row.name,
        note: [kindLabel(row.kind), row.agents?.length ? plural(row.agents.length, "executor") : null].filter(Boolean).join(" · "),
        used: row.calls,
        okRate: row.okRate,
        row,
        heat: heat[at],
        onOpen: () => onOpen(pathFor("tools", row.name)),
      }),
    );
  });
  return table;
}

/** A section of the page: a heading, a line about it, and what it holds. */
function section(title, hint, ...body) {
  const wrap = el("section", "console-panel tools-section");
  wrap.append(el("h3", "panel-heading", title));
  if (hint) wrap.append(el("p", "console-hint", hint));
  wrap.append(...body.filter(Boolean));
  return wrap;
}

/**
 * The page: three lists - connectors, skills, everything else - every row
 * the same five numbers.
 *
 * @param {object} args
 * @param {string} args.range one of RANGES
 * @param {object|null} args.data what /api/tools said
 * @param {string|null} args.failed
 * @param {(range: string) => void} args.onRange
 * @param {(path: string) => void} args.onOpen
 * @param {(page: string, id?: string) => string} args.pathFor
 */
export function toolsView({ range, data, failed, onRange, onReread = () => {}, onOpen, pathFor }) {
  const pane = el("div", "detail detail-wide");
  pane.append(
    detailHead(
      "Tools",
      el(
        "p",
        "detail-summary",
        "What the agents reached for beyond their harness, and what came of it: how often each connector, skill and tool was used, and how many of the sessions it was in got their work merged. Pick what to give the next session from here.",
      ),
    ),
  );
  pane.append(rangePicker(RANGES, range, onRange));
  // Which work these totals are of: this workspace's own repos, and -
  // pressed for - repositories nobody connected here and work in no
  // repository (console-where.js). The counts change when it is pressed,
  // so the press has to be on screen beside them.
  pane.append(filterRow(whereFilter(onReread)));

  if (failed) {
    pane.append(problem(`Could not read the tools - ${failed}`));
    return pane;
  }
  if (!data) {
    pane.append(el("p", "console-hint", "Reading…"));
    return pane;
  }

  const tools = data.tools ?? { rows: [], totals: {} };
  const connectors = data.connectors ?? { rows: [], totals: {} };
  const skills = data.skills ?? { rows: [], totals: {} };
  const closedOf = (rows) => rows.reduce((sum, row) => sum + (row.sessionsClosed ?? 0), 0);
  pane.append(
    metrics(
      metric(count(connectors.rows.length), "connectors used", connectors.rows.length ? `in the room for ${plural(closedOf(connectors.rows), "closed session")}` : "none called in the range"),
      metric(count(skills.rows.length), "skills used", skills.rows.length ? `in the room for ${plural(closedOf(skills.rows), "closed session")}` : "none used in the range"),
      metric(count(tools.rows.length), "other tools", tools.totals?.calls ? `${plural(tools.totals.calls, "call")}` : "none called in the range"),
    ),
  );

  pane.append(
    section(
      "Connectors",
      "The services agents reached as you. Most closed sessions first; a row opens the connector.",
      connectors.rows.length
        ? connectorsTable(connectors.rows, { onOpen, pathFor })
        : el("p", "console-hint", "No connector was called in this range. Connect one under Connectors and it appears here with the sessions that use it."),
    ),
  );

  const unnamed = skills.totals?.unnamed
    ? `${plural(skills.totals.unnamed, "use")} could not be named: a session reporting by export alone says a skill ran, not which. The hooks the setup line installs name them.`
    : null;
  pane.append(
    section(
      "Skills",
      "A skill counts as used when the Skill tool runs, when a person types it by name (/code-review), or when a tool reads its SKILL.md. Most closed sessions first.",
      skills.rows.length ? skillsTable(skills.rows) : el("p", "console-hint", "No skill was used in this range."),
      unnamed ? el("p", "console-hint", unnamed) : null,
    ),
  );

  pane.append(
    section(
      "Other tools",
      "This app's own tools, and servers on your MCP list. A row opens the tool, and the sessions it was in are named there. The harness's reading, editing and running is not here; that is on each session's page.",
      tools.rows.length
        ? toolsTable(tools.rows, { onOpen, pathFor })
        : el("p", "console-hint", "No other tool was called in this range."),
    ),
  );

  const caveats = [
    "A closed session is one whose pull request merged. The tool was in the room for it - company, not cause; a tool on every session shares every merge.",
    reachLine(data),
  ].filter(Boolean);
  pane.append(el("p", "console-caveat", caveats.join(" ")));
  return pane;
}

/** What a task came to, as a chip. */
function taskChip(task) {
  if (task.state === "done") return el("span", "chip chip-ok", "delivered");
  if (task.state === "failed") return el("span", "chip chip-err", task.failure === "timeout" ? "out of time" : "failed");
  return el("span", "chip", task.state);
}

/**
 * One tool's page: the row's numbers as tiles, the sessions it was in,
 * the agents that call it, and the tasks it was used on.
 *
 * @param {object} args
 * @param {string} args.name
 * @param {string} args.range
 * @param {object|null} args.data what /api/tools/:name said
 * @param {string|null} args.failed
 * @param {(range: string) => void} args.onRange
 * @param {(path: string) => void} args.onOpen
 * @param {(page: string, id?: string) => string} args.pathFor
 */
export function toolView({ name, range, data, failed, onRange, onOpen, pathFor }) {
  const pane = el("div", "detail detail-wide");
  pane.append(detailHead(name, el("p", "detail-summary", data?.tool ? `A ${kindLabel(data.tool.kind)} tool.` : "")));
  pane.append(rangePicker(RANGES, range, onRange));

  if (failed) {
    pane.append(problem(`Could not read this tool - ${failed}`));
    return pane;
  }
  if (!data) {
    pane.append(el("p", "console-hint", "Reading…"));
    return pane;
  }

  const tool = data.tool;
  pane.append(
    metrics(
      metric(count(tool.sessionsUsed ?? 0), "sessions", tool.sessionsClosed ? `${tool.sessionsClosed} closed` : tool.sessionsUsed ? "none closed yet" : null),
      metric(count(tool.calls), "calls", tool.failed ? `${count(tool.failed)} failed` : tool.calls ? "none failed" : "no calls"),
      metric(percent(tool.okRate), "worked", null),
      metric(tool.msMedian == null ? "—" : duration(tool.msMedian), "median", tool.calls ? `longest ${duration(tool.msMax)}` : null),
      metric(`~${count(tool.handedTokens)}`, "tokens handed back", `${count(tool.handedChars)} characters, at four a token`),
    ),
  );

  // The sessions it was in, closed ones first.
  const sessions = el("section", "console-panel");
  sessions.append(el("h3", "panel-heading", "Used in"));
  sessions.append(recentSessions(tool, { onOpen, pathFor }));
  pane.append(sessions);

  // Who calls it. An agent's name is a link to its page.
  const agents = tool.agents ?? [];
  if (agents.length) {
    const section = el("section", "console-panel");
    section.append(el("h3", "panel-heading", "Called by"));
    const list = el("ul", "tools-agents");
    for (const agent of agents) {
      const row = el("li", "tools-agent");
      const link = el("a", "tools-agent-name", agent.name ?? agent.id);
      link.href = pathFor("executors", agent.id);
      link.addEventListener("click", (event) => {
        event.preventDefault();
        onOpen(link.getAttribute("href"));
      });
      row.append(link, el("span", "tools-agent-note", `${count(agent.calls)} call${agent.calls === 1 ? "" : "s"}${agent.failed ? `, ${agent.failed} failed` : ""}${agent.kind ? ` · ${agent.kind}` : ""}`));
      list.append(row);
    }
    section.append(list);
    pane.append(section);
  }

  // What it was for, as the tasks say. Each task is a link into its repo's Tasks tab.
  const tasks = data.tasks ?? [];
  if (tasks.length || data.elsewhere) {
    const section = el("section", "console-panel");
    section.append(el("h3", "panel-heading", "Tasks"));
    const kinds = Object.entries(tool.tasks?.kinds ?? {}).sort((a, b) => b[1] - a[1]);
    if (kinds.length) section.append(el("p", "console-hint", `For: ${kinds.map(([kind, n]) => `${kind} ×${n}`).join(", ")}`));
    const list = el("ul", "tools-tasks");
    for (const task of tasks) {
      const row = el("li", "tools-task");
      // Its title, and no more: the task is answered from Home, and the
      // page that listed a repo's tasks is gone.
      row.append(el("span", "tools-task-title", task.title), taskChip(task));
      row.append(
        el(
          "span",
          "tools-task-note",
          [task.repoName ? `in ${task.repoName}` : null, task.to?.name ? `by ${task.to.name}` : null, `${task.calls} call${task.calls === 1 ? "" : "s"}${task.failed ? `, ${task.failed} failed` : ""}`, task.settledAt ? ago(Date.parse(task.settledAt)) : null]
            .filter(Boolean)
            .join(" · "),
        ),
      );
      list.append(row);
    }
    section.append(list);
    if (data.elsewhere) section.append(el("p", "console-hint", `And ${data.elsewhere} more in repos you cannot open.`));
    pane.append(section);
  }

  const reach = reachLine(data);
  if (reach) pane.append(el("p", "console-caveat", reach));
  return pane;
}
