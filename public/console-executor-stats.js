// One executor's numbers - the Stats tab of an agent's page, and the same
// panel on a harness's.
//
// Three things, in the order somebody asks them. Where it stands over the
// range: sessions, tasks finished of those taken, the steering it took,
// what it cost - the row the Performance page would show for it, read
// from /api/executors/:id/stats so the two never disagree. Then its days
// one by one, as a strip of bars: "finished eight this month" and
// "finished eight one afternoon and nothing since" are different agents,
// and the tiles cannot tell them apart. Then what it reached for - the tools,
// connectors, skills and models in the spans this process still holds -
// with how many calls that sample is, because a ring of spans is not a
// month and the panel must not read as one.
//
// The strip is one series (sessions a day), so it needs no legend; a bar
// is marked when something finished that day, which is a state and not a
// second series. The bars are thin, sit on the baseline, and say their
// numbers on hover - the shape of the month is the point, not a reading
// off an axis, and the tiles above carry the figures.
import { api } from "./api.js";
import { el, button, count, money, problem, metric, metrics, helpMark, TASK_HELP } from "./console-dom.js";

/** The ranges the route takes, in the order the picker shows them. */
const RANGES = ["24h", "7d", "30d"];

const plural = (n, word, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;

function panel(title, ...children) {
  const section = el("section", "console-panel");
  section.append(el("h3", "panel-heading", title));
  section.append(...children);
  return section;
}

/** The tiles: what the range came to. Null aggregate is "nothing in the range", said plainly. */
function standing(stats) {
  const row = stats.aggregate;
  if (!row) return el("p", "console-hint", `No session in the last ${stats.range}.`);
  const rate = row.rate == null ? null : `${Math.round(row.rate * 100)}% finished`;
  const tasks = metric(`${row.finished} of ${row.tasks}`, "tasks finished", rate);
  tasks.querySelector(".metric-label")?.append(helpMark("a task", TASK_HELP));
  return metrics(
    metric(row.sessions, plural(row.sessions, "session").replace(/^\d+ /, ""), row.live ? `${row.live} live now` : null),
    tasks,
    metric(row.lines, "steering lines", row.linesPerTask != null ? `${Math.round(row.linesPerTask * 10) / 10} per task` : null),
    stats.priced
      ? metric(money(row.cost), "spent", row.costPerTask != null ? `${money(row.costPerTask)} per task` : null)
      : metric(count(stats.series.reduce((sum, day) => sum + day.tokens, 0)), "tokens", null),
  );
}

/** The strip: a bar per day, tallest the busiest, marked when something finished. */
function strip(days) {
  const most = Math.max(1, ...days.map((day) => day.sessions));
  const wrap = el("div", "exec-days");
  wrap.setAttribute("role", "img");
  wrap.setAttribute("aria-label", `Sessions a day over ${days.length} days`);
  for (const day of days) {
    const bar = el("span", `exec-day${day.finished ? " finished" : ""}${day.live ? " live" : ""}`);
    bar.style.height = `${Math.max(3, Math.round((day.sessions / most) * 100))}%`;
    bar.title = `${day.day}: ${plural(day.sessions, "session")}${day.finished ? `, ${day.finished} finished` : ""}${day.taken ? `, ${day.taken} taken` : ""}`;
    wrap.append(bar);
  }
  const ends = el("div", "exec-days-ends");
  ends.append(el("span", null, days[0]?.day ?? ""), el("span", null, days[days.length - 1]?.day ?? ""));
  return [wrap, ends];
}

/** One of the "uses" lists: a name and how often, with failures when there were any. */
function uses(title, rows, label) {
  const box = el("div", "exec-uses-list");
  box.append(el("h4", "exec-uses-title", title));
  if (!rows.length) {
    box.append(el("p", "console-hint", "None."));
    return box;
  }
  const list = el("ul");
  for (const row of rows) {
    const item = el("li");
    item.append(el("span", "exec-uses-name", label(row)));
    item.append(el("span", "exec-uses-count", ` · ${plural(row.calls, "call")}${row.failed ? ` · ${row.failed} failed` : ""}`));
    list.append(item);
  }
  box.append(list);
  return box;
}

/**
 * The panel. Reads on its own - the page is drawn from the list the
 * console already holds, and these numbers are a second question - and
 * again whenever the range changes.
 *
 * @param {string} id the executor's id
 * @param {{name?: string}} [options]
 */
export function statsPanel(id, { name = null } = {}) {
  const wrap = el("div", "exec-stats");
  let range = "7d";

  const picker = el("div", "exec-ranges");
  const body = el("div", "modal-stack");
  body.append(el("p", "console-hint", "Reading…"));

  const drawPicker = () => {
    picker.replaceChildren();
    for (const entry of RANGES) {
      picker.append(
        button(`ghost-btn${entry === range ? " active" : ""}`, entry, () => {
          if (entry === range) return;
          range = entry;
          drawPicker();
          load();
        }),
      );
    }
  };

  const draw = (stats) => {
    body.replaceChildren();
    body.append(panel(`Standing · last ${stats.range}`, standing(stats)));
    body.append(panel("Day by day", ...strip(stats.series)));
    const used = stats.used ?? {};
    const grid = el("div", "exec-uses");
    grid.append(uses("Tools", used.tools ?? [], (row) => row.name));
    grid.append(uses("Connectors", used.connectors ?? [], (row) => row.id));
    grid.append(uses("Skills", used.skills ?? [], (row) => row.name));
    grid.append(uses("Models", used.models ?? [], (row) => `${row.model}${row.tokens ? ` · ${count(row.tokens)} tokens` : ""}`));
    body.append(
      panel(
        "What it reaches for",
        el(
          "p",
          "console-caveat",
          used.sample
            ? `From the last ${plural(used.sample, "call")} this process saw${name ? ` from ${name}` : ""} - a sample, not the range.`
            : "Nothing this process has seen it call yet.",
        ),
        grid,
      ),
    );
  };

  const load = () =>
    api
      .executorStats(id, range)
      .then(draw)
      .catch((err) => body.replaceChildren(problem(`Could not read its numbers - ${err.message}`)));

  drawPicker();
  wrap.append(picker, body);
  load();
  return wrap;
}
