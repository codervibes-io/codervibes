// What works best: the same figures for every option, side by side.
//
// The ranking below this says who finished the work. This says what the work
// was done with - which vendor's models, which harness, on a laptop or in
// a sandbox, whose - and what each choice came to: tokens a task took,
// what it cost, how many tasks finished, how long a finished one took, how
// many finished with nobody coming back to them, how many times a person
// had to step in, and how the hours split between the agent working and
// the agent waiting to be told the next thing. One chart per figure, each a
// bar per option, so "should we run this on Codex or the loop" is answered
// by reading across one row.
//
// Beside them, the one panel that is not a single figure: Steering, a
// stacked bar of what each option's steers actually were - corrections,
// clarifications, new asks. Two options with the same intervention count
// are not the same option to work with if one of them is being corrected
// and the other is being given more to do.
//
// Bars, not a table, because the reader is comparing lengths, and a table
// makes them subtract. But every bar carries its number, and the same rows
// are a table one press away - a length is a hint and a figure is a fact,
// and the person deciding wants both. The bars are drawn with the DOM -
// a track and a span whose width is the value - which is all a bar is;
// a charting library would be a dependency for a rectangle.
//
// One bar per chart is lit gold: the best option by that figure. The rest
// are grey. It is emphasis, not a verdict - "best" here is the lowest cost
// or the highest closure rate over whatever the range holds, and a vendor
// that did two tasks can top a chart it would not top over two hundred.
// So every row says how many tasks it stands on, and the gold bar carries
// the word "best" beside its figure, because a reader who does not see
// gold as different from grey would otherwise be reading a chart with no
// answer on it.
//
// **The charts, and almost no prose.** This panel had a line of hint under
// its heading, a sentence naming the winner of each of the figures,
// and a three-clause caveat under the charts - four paragraphs of text
// around five charts that say the same things themselves. The owner asked
// for the graphs, so what is left is the chips, the charts and the way to
// the table. Nothing true was dropped, only moved to where it is read: the
// figure each chart measures is its own subtitle, what a row stands on is
// the task count under its name and the tooltip on its bar, and the winner
// is the gold bar labelled "best".
import { el, button, count, money, duration, problem } from "./console-dom.js";
import { listTable, listRow, heatRanks, heatCell } from "./console-list.js";

/** The dimensions, in the order the chips show them - the server's, with labels. */
export const DIMENSIONS = [
  { key: "provider", label: "Model provider", noun: "provider" },
  { key: "harness", label: "Harness", noun: "harness" },
  { key: "sandbox", label: "Sandbox", noun: "place to run" },
  { key: "user", label: "User", noun: "person" },
];

const percent = (rate) => (rate == null ? "—" : `${Math.round(rate * 100)}%`);
const one = (n) => (n == null ? "—" : n.toFixed(1));
const plural = (n, word, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;

/**
 * The figures. `better` says which end of the bar wins, or is null for one
 * where neither end is better; `worth` says
 * whether a row's value can be a best at all - a closure rate of nought is
 * not the best closure rate, it is no closures. `known` says whether there
 * is a value to draw: a group whose sessions reported no model calls has
 * no tokens and no cost, and "0" and "<1¢" would say it was free.
 */
export const FIGURES = [
  {
    key: "closureRate",
    title: "Tasks finished",
    unit: "of the tasks it took, the share that finished",
    better: "higher",
    format: percent,
    worth: (row) => row.finished > 0,
    detail: (row) => `${row.finished} of ${plural(row.tasks, "task")} finished`,
  },
  {
    key: "tokensPerTask",
    title: "Tokens per task",
    unit: "every token a task's model calls used, averaged",
    better: "lower",
    format: (value) => (value == null ? "—" : count(Math.round(value))),
    worth: (row) => row.tokens > 0,
    known: (row) => row.tokens > 0,
    detail: (row) => `${count(row.tokens)} tokens over ${plural(row.tasks, "task")}`,
  },
  {
    key: "costPerTask",
    title: "Cost per task",
    unit: "what a task's model calls cost, averaged",
    better: "lower",
    format: (value) => (value == null ? "—" : money(value) ?? "—"),
    worth: (row) => row.cost > 0,
    known: (row) => row.tokens > 0,
    detail: (row) => `${money(row.cost) ?? "—"} over ${plural(row.tasks, "task")}`,
    priced: true,
  },
  {
    key: "timeToClosure",
    title: "Time to finish",
    unit: "from the session's start to the moment it landed, the median",
    better: "lower",
    format: (value) => (value == null ? "—" : duration(value)),
    worth: (row) => row.timeToClosure != null,
    detail: (row) => (row.timed ? `over ${plural(row.timed, "finished task")} with a known finishing time` : "no finished task with a known finishing time"),
  },
  {
    key: "oneShotRate",
    title: "Finished first time",
    unit: "of the tasks that finished whose steering was counted, the share nobody had to come back to",
    better: "higher",
    format: percent,
    worth: (row) => row.oneShot > 0,
    // A group made only of records from before this app counted turns has
    // no first-time rate: nought steers there means nothing was counted,
    // not that nobody came back. `oneShotKnown` is the denominator.
    known: (row) => (row.oneShotKnown ?? 0) > 0,
    detail: (row) =>
      row.oneShotKnown
        ? `${row.oneShot} took no steering, over ${plural(row.oneShotKnown, "finished task")} whose steering was counted`
        : row.finished
          ? "nothing here had its steering counted, so a nought would be the sensor's, not the agent's"
          : "nothing finished",
  },
  {
    key: "interventions",
    title: "Interventions to finish",
    unit: "lines said to it, follow-ups, cuts short, review rounds and retries before a task finished, averaged",
    better: "lower",
    format: one,
    worth: (row) => row.interventions != null,
    detail: (row) => (row.finished ? `over ${plural(row.finished, "finished task")}` : "nothing finished"),
  },
  // The two the aftermath added. Both are about what happened *after* the
  // merge, so both stand on what an option landed rather than on what it
  // took on: an option that landed nothing has no failure rate, which is
  // not the same as a failure rate of nought.
  {
    key: "failureRate",
    title: "Undone after landing",
    unit: "of what it landed, the share reverted, broken or followed by a fix",
    better: "lower",
    format: percent,
    worth: (row) => row.landed > 0,
    known: (row) => row.landed > 0,
    detail: (row) => (row.landed ? `${row.undoneAfter} of ${plural(row.landed, "merge")} came apart` : "nothing landed"),
  },
  {
    key: "kept",
    title: "Still there after 30 days",
    unit: "of a merge's added lines, the share still in the file a month later",
    better: "higher",
    format: percent,
    worth: (row) => row.measured > 0,
    known: (row) => row.measured > 0,
    detail: (row) => (row.measured ? `over ${plural(row.measured, "merge")} old enough to measure` : "nothing old enough to measure yet"),
  },
  // And the two about the code itself: how much of what an option wrote a
  // reviewer kept, and how many lines it took to finish a task with. Both
  // stand only on the sessions whose harness could say - a Codex session
  // writes lines nothing here counts, and an option made only of those has
  // no figure rather than a nought.
  {
    key: "acceptance",
    title: "Code kept through review",
    unit: "of the lines its sessions wrote, the share that were in the diff that merged",
    better: "higher",
    format: percent,
    worth: (row) => row.linesReviewed > 0,
    known: (row) => row.acceptance != null,
    detail: (row) =>
      row.linesMeasured
        ? row.linesReviewed
          ? `${count(row.accepted ?? 0)} of the ${count(row.reviewed)} lines that went through a review, over ${plural(row.linesReviewed, "session")}`
          : `${count(row.written)} lines written, none of them merged yet`
        : row.linesPredate
          ? "these were recorded before lines were counted here"
          : "no session here reports the lines it wrote",
  },
  {
    key: "writtenPerFinished",
    title: "Lines per finished task",
    unit: "lines of code written for each task that landed",
    better: null,
    format: (value) => (value == null ? "—" : count(Math.round(value))),
    // Nought is not the answer for an option whose sessions nobody could
    // count - it is the absence of one, and drawn as a dash. The same rule
    // "Code kept through review" above already keeps.
    worth: (row) => row.linesMeasured > 0 && row.writtenPerFinished != null,
    known: (row) => row.linesMeasured > 0 && row.writtenPerFinished != null,
    detail: (row) =>
      row.linesMeasured
        ? row.finished
          ? `over ${plural(row.finished, "finished task")}`
          : "nothing finished"
        : row.linesPredate
          ? "these were recorded before lines were counted here"
          : "no session here reports the lines it wrote",
  },
  {
    key: "agentMs",
    title: "Agent time",
    unit: "how long the agent spent working in a session, the median",
    better: "lower",
    format: (value) => (value == null ? "—" : duration(value)),
    worth: (row) => row.agentMs != null,
    known: (row) => row.agentMs != null,
    detail: (row) => `over ${plural(row.sessions, "session")}`,
  },
  {
    key: "personMs",
    title: "Waiting on a person",
    unit: "how long it sat idle between turns waiting to be told the next thing, the median",
    better: "lower",
    format: (value) => (value == null ? "—" : duration(value)),
    worth: (row) => row.personMs != null,
    known: (row) => row.personMs != null,
    detail: (row) => `over ${plural(row.sessions, "session")}`,
  },
];

/**
 * The steer kinds a bar is stacked from, in the order they are stacked, and
 * the last of them - the ones no model labelled, which are not a kind and
 * are not nothing either. Their order is the server's (steer-kinds.js) plus
 * `unclassified`; a kind the server adds later and this list has not heard
 * of is drawn at the end rather than dropped (`kindsIn`).
 */
export const STEER_KINDS = [
  { key: "clarify", label: "Clarified" },
  { key: "correct", label: "Corrected" },
  { key: "redirect", label: "Redirected" },
  { key: "context", label: "Gave context" },
  { key: "approve", label: "Approved" },
  { key: "new", label: "Asked something new" },
  { key: "unclassified", label: "Unclassified" },
];

/** The kinds present across these rows, in the fixed order, with anything new at the end. */
export function kindsIn(rows) {
  const seen = new Set();
  for (const row of rows) for (const [kind, count] of Object.entries(row.steerKinds ?? {})) if (count > 0) seen.add(kind);
  const known = STEER_KINDS.filter((kind) => seen.has(kind.key));
  const extra = [...seen].filter((kind) => !STEER_KINDS.some((entry) => entry.key === kind)).sort();
  return [...known, ...extra.map((key) => ({ key, label: key }))];
}

/**
 * How many sessions of a group fell in each steer bucket, in the server's
 * order. `unknown` is not a number of steers: it is the sessions recorded
 * before this app counted them, which would otherwise swell the "0" bucket
 * and read as an option nobody ever had to correct.
 */
export const BUCKETS = ["0", "1-2", "3-5", "6+", "unknown"];

/**
 * The steering panel: one stacked bar per option, by what kind of steer it
 * was, and beside it how the option's sessions split across the buckets.
 *
 * Stacked and not five more charts because the question is a mixture -
 * "were these corrections or new asks?" - and a mixture read across five
 * separate charts is a mixture the reader has to add up. Every segment
 * carries its count in the hover and the whole bar carries its total in
 * text, so the lengths are the hint and the numbers are the fact, as with
 * the charts above.
 */
function steeringPanel(rows) {
  const box = el("section", "chart steering");
  box.append(
    el("h4", "chart-title", "Steering"),
    el("p", "chart-unit", "everything after the first ask, by what the person was doing - and how many sessions took how much"),
  );
  const kinds = kindsIn(rows);
  const totals = rows.map((row) => Object.values(row.steerKinds ?? {}).reduce((sum, count) => sum + count, 0));
  const most = Math.max(0, ...totals);
  const list = el("ol", "chart-rows steer-rows");
  rows.forEach((row, at) => {
    const item = el("li", "chart-row steer-row");
    const label = el("span", "chart-label");
    label.append(el("span", "chart-name", row.name), el("span", "chart-n", plural(row.sessions, "session")));
    const track = el("span", "chart-track steer-track");
    if (row.steeringVisible === false) {
      // Nought here would read as "never needed a word", which is the
      // opposite of what an unobserved agent's blank means.
      track.append(el("span", "steer-none", "steering not visible"));
    } else {
      for (const kind of kinds) {
        const value = row.steerKinds?.[kind.key] ?? 0;
        if (!value) continue;
        const part = el("span", `steer-part steer-${kind.key}`);
        part.style.width = most > 0 ? `${Math.max(1.5, (value / most) * 100)}%` : "0";
        part.title = `${row.name}: ${plural(value, kind.label.toLowerCase())}`;
        track.append(part);
      }
    }
    const buckets = (row.steerBuckets ?? {})["0"] != null
      ? BUCKETS.map((bucket) => `${bucket}: ${row.steerBuckets[bucket] ?? 0}`).join(" · ")
      : "";
    const figureText = el("span", "chart-value", row.steeringVisible === false ? "—" : String(totals[at]));
    item.append(label, track, figureText);
    item.title = `${row.name}: ${plural(totals[at], "steer")}${buckets ? ` · sessions by steers - ${buckets}` : ""}`;
    list.append(item);
  });
  box.append(list);
  // The legend, because a stack of colours nobody named is a stack of
  // colours. Out of the hover, where a phone would never find it.
  if (kinds.length) {
    const legend = el("ul", "steer-legend");
    for (const kind of kinds) {
      const entry = el("li", "steer-legend-entry");
      entry.append(el("span", `steer-swatch steer-${kind.key}`), el("span", "steer-legend-label", kind.label));
      legend.append(entry);
    }
    box.append(legend);
  }
  box.append(el("p", "chart-unit steer-buckets", `Sessions by how many steers each took: ${BUCKETS.map((bucket) => `${bucket} — ${rows.reduce((sum, row) => sum + (row.steerBuckets?.[bucket] ?? 0), 0)}`).join(", ")}.`));
  return box;
}

/** The figures a page can show: cost only when a model here is priced. */
export const figuresFor = (priced) => FIGURES.filter((figure) => priced || !figure.priced);

/**
 * The row that wins a figure, or null when none can. Lowest or highest of
 * the rows worth judging; a tie goes to the row with more tasks, which is
 * the row order, so the first one.
 */
export function bestOf(rows, figure) {
  // A figure with no better end has no winner: "lines per finished task"
  // is the shape of an option, not a race, and gilding the biggest or the
  // smallest would be this page inventing an opinion.
  if (!figure.better) return null;
  let best = null;
  for (const row of rows) {
    const value = row[figure.key];
    if (value == null || !figure.worth(row)) continue;
    if (!best) best = row;
    else if (figure.better === "lower" ? value < best[figure.key] : value > best[figure.key]) best = row;
  }
  return best;
}

/**
 * One chart: a bar per row, the best lit, the value at every tip - and the
 * reader's own option lit differently.
 *
 * `picked` is the set of row keys the filter at the top of the page chose
 * (console-facets.js `framedBy`). A picked bar is not a better bar, so it
 * does not take the best's colour: it is the one you came to look at, drawn
 * in cyan against the green of whatever is winning. The two can land on the
 * same row, and then the cyan has the bar and both words are said - "yours"
 * and "best" - which is where the fact lives for a reader who does not see
 * hues regardless.
 */
function chart(rows, figure, picked = new Set()) {
  const box = el("div", "chart");
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", figure.title);
  box.append(el("h4", "chart-title", figure.title), el("p", "chart-unit", figure.unit));
  const best = bestOf(rows, figure);
  const most = Math.max(0, ...rows.map((row) => row[figure.key] ?? 0));
  const list = el("ol", "chart-rows");
  for (const row of rows) {
    const value = figure.known?.(row) === false ? null : row[figure.key];
    const mine = picked.has(row.key);
    const item = el("li", `chart-row${row === best ? " is-best" : ""}${mine ? " is-picked" : ""}`);
    const label = el("span", "chart-label");
    label.append(el("span", "chart-name", row.name), el("span", "chart-n", plural(row.tasks, "task")));
    const track = el("span", "chart-track");
    const bar = el("span", "chart-bar");
    // A bar is at least a sliver when there is a value, so a row with
    // nearly nothing still shows it has something; none at all when there
    // is no value to show.
    bar.style.width = value == null || most <= 0 ? "0" : `${Math.max(1.5, (value / most) * 100)}%`;
    track.append(bar);
    const figureText = el("span", "chart-value", figure.format(value));
    // The words beside the colour, for a reader who does not see colour.
    if (mine) figureText.append(el("span", "chart-mine", "yours"));
    if (row === best) figureText.append(el("span", "chart-best", "best"));
    item.append(label, track, figureText);
    // The hover layer: what the bar stands on, since a per-task figure
    // over two tasks and over two hundred are different facts.
    item.title = `${row.name}: ${figure.format(value)} · ${figure.detail(row)}${row === best ? " · best by this figure" : ""}${mine ? " · the one you picked" : ""}`;
    list.append(item);
  }
  box.append(list);
  return box;
}

/**
 * The same rows, every figure, as a table - the chart's twin for whoever
 * wants the numbers alone.
 *
 * The bars said which option won a figure by their length; a table of
 * numbers says it only to somebody who reads every row, so each figure's
 * column is shaded green to red by where its rows stand against each
 * other. `better` is the figure's own - the same end of it the gold bar
 * calls the winner - and the rows shaded are the rows `worth` lets win, so
 * the greenest cell in a column is the option `bestOf` gilds and the table
 * cannot disagree with the charts. That is also why a row can show a
 * number and carry no colour: nought spent is not the cheapest cost, it is
 * nothing to compare.
 */
function table(rows, figures, picked = new Set()) {
  const grid = listTable({ head: ["Option", "Tasks", ...figures.map((figure) => figure.title)] });
  grid.classList.add("compare-table");
  const valueOf = (row, figure) => (figure.known?.(row) === false || !figure.worth(row) ? null : row[figure.key]);
  // A figure with no better end is not shaded either, for the same reason
  // `bestOf` picks nobody on it.
  const heat = figures.map((figure) => heatRanks(rows.map((row) => (figure.better ? valueOf(row, figure) : null)), figure.better === "lower" ? "low" : "high"));
  rows.forEach((row, at) => {
    const line = listRow({
        name: row.name,
        note: `${row.finished} finished · ${plural(row.sessions, "session")}`,
        cells: [
          String(row.tasks),
          ...figures.map((figure, column) => heatCell(figure.format(figure.known?.(row) === false ? null : row[figure.key]), heat[column][at])),
        ],
    });
    if (picked.has(row.key)) line.classList.add("is-picked");
    grid.append(line);
  });
  return grid;
}

/**
 * The panel.
 *
 * Its own state - which dimension, charts or table - lives on the panel and
 * survives its own redraws; a redraw from outside (a refresh, a new range)
 * gets it back from the caller through `state` and `onState`, so a person
 * reading the harness charts is still reading them after the numbers move.
 *
 * @param {object} args
 * @param {object|null} args.data what /api/performance/compare said
 * @param {string|null} args.failed
 * @param {{dimension: string, table: boolean}} args.state
 * @param {(state: object) => void} args.onState told the new state; must not redraw
 * @param {{dimension: string, keys: string[]}|null} args.highlight what the
 *   page's filter picked (console-facets.js `framedBy`): the dimension this
 *   panel is being shown for, and which of its options are the reader's own.
 *   The dimension arrives through `state` and is never sent back, so it
 *   frames the panel without overwriting the reader's own choice of chips.
 */
export function compareView({ data, failed, state, onState, highlight = null }) {
  const panel = el("section", "console-panel compare");
  panel.append(el("h3", "panel-heading", "What works best"));
  if (failed) {
    panel.append(problem(`Could not read the comparison - ${failed}`));
    return panel;
  }
  if (!data) {
    panel.append(el("p", "console-hint", "Reading…"));
    return panel;
  }

  let current = { dimension: "provider", table: false, ...state };
  const figures = figuresFor(data.priced !== false);
  const body = el("div", "compare-body");
  panel.append(body);

  const set = (patch) => {
    current = { ...current, ...patch };
    onState(current);
    redraw();
  };

  function redraw() {
    const picked = DIMENSIONS.find((entry) => entry.key === current.dimension) ?? DIMENSIONS[0];
    const rows = data.dimensions?.[picked.key] ?? [];
    // Only light bars on the dimension the pick was of: a sandbox pick says
    // nothing about which harness is yours.
    const mine = new Set(highlight?.dimension === picked.key ? highlight.keys ?? [] : []);
    // Work that named none of the options is not a bar (server
    // performance.js `UNREPORTED`): the charts are what a person chooses
    // between, and on an installation whose harness sends no model the
    // grey "Not reported" bar was the tallest of them. It is not prose
    // under the charts either - the panel has none, by the owner's ask -
    // so the only place it is felt is the empty state, which says the
    // range had tasks and none of them said, rather than that it was
    // empty. The count is on the answer (`unreported`) for whoever needs
    // it; the trend panel below does say it, where it has a caveat line.
    const unreported = data.unreported?.[picked.key]?.tasks ?? 0;

    const chips = el("div", "list-filters compare-dims");
    for (const entry of DIMENSIONS) {
      const chip = button("filter-chip", entry.label, () => set({ dimension: entry.key }));
      chip.setAttribute("aria-pressed", entry.key === picked.key ? "true" : "false");
      chips.append(chip);
    }
    // A button, not a link: it is the one other thing on this panel a
    // person does, and as a 12px underlined link nobody found it.
    const flip = button("ghost-btn compare-flip", current.table ? "Show as charts" : "Show as table", () => set({ table: !current.table }));
    flip.setAttribute("aria-pressed", current.table ? "true" : "false");
    const tools = el("div", "compare-tools");
    tools.append(chips, flip);

    const parts = [tools];
    if (!rows.length) {
      parts.push(el("p", "console-hint", unreported ? `No task in the range said which ${picked.noun} it used.` : `No task in the range to compare by ${picked.noun}.`));
    } else {
      if (current.table) parts.push(table(rows, figures, mine));
      else {
        const charts = el("div", "compare-charts");
        for (const figure of figures) charts.append(chart(rows, figure, mine));
        // The one panel that is not a single figure: what the steering was
        // made of. It sits with the charts and not with the table, because
        // the table's twin of it is the numbers in the hover.
        charts.append(steeringPanel(rows));
        parts.push(charts);
      }
    }
    body.replaceChildren(...parts);
  }

  redraw();
  return panel;
}
