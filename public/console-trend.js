// Over time: one metric, as a line across the range.
//
// The comparison says what the work was done with and the ranking says
// who did it; both are totals over the range. This is the range itself,
// period by period - a point per day, or per hour over a day - for the
// one metric the reader picks: what was spent, how many tokens, how many
// tasks finished, how many sessions started. "Spent $40 this week" and
// "spent $2 a day until Thursday, then $30" are different weeks, and a
// person deciding whether a change worked wants to see the day it
// happened.
//
// Split by nothing, it is one line in the accent - nothing to tell apart,
// so no legend and no second colour. Split by a model provider, a model,
// a harness, a sandbox, a person or an executor, it is a line per group,
// overlaid, each in one of six hues kept in a fixed order (styles.css
// --series-N; the order is the server's, most sessions first, so a group
// keeps its hue when the metric changes) - with a legend always, a name
// at each line's end while there are four or fewer, the tooltip listing
// every line at the period under the pointer, and the same numbers as a
// table one press away. Past six groups the smallest fold into "Other".
//
// The lines are an SVG stretched over the plot with a non-scaling stroke,
// so it fits any width without the text inside it shrinking: every label,
// gridline, marker and legend is HTML, placed by percentage. Nothing is
// only in the hover.
import { el, button, count, money } from "./console-dom.js";
import { hasSandboxes, hasTasks } from "./console-edition.js";
import { listTable, listRow } from "./console-list.js";

/**
 * The metrics, in the order the chips offer them. `priced` marks the one
 * that is only meaningful when a model here has a price.
 */
export const METRICS = [
  // A period with nothing spent is "$0", not "<1¢": nought is not a
  // rounding.
  { key: "cost", label: "Cost", unit: "what the sessions that started in each period spent", format: (value) => (value > 0 ? money(value) ?? "—" : "$0"), priced: true },
  { key: "tokens", label: "Tokens", unit: "every token those sessions' model calls used", format: (value) => count(value), priced: false },
  { key: "finished", label: "Tasks finished", unit: "tasks that finished, on the period each finished in", format: (value) => String(value), priced: false },
  { key: "sessions", label: "Sessions", unit: "sessions started in each period", format: (value) => String(value), priced: false },
  // Everything after the first ask: a follow-up, a turn cut short, a round
  // of review, a retried task. A week whose spend held steady while this
  // line climbed is a week the tool got harder to work with.
  { key: "steers", label: "Steering", unit: "times a person came back to work in flight - follow-ups, cuts short, review rounds, retries", format: (value) => String(value), priced: false },
  // Lines of code, not lines a person typed: what the sessions of each
  // period wrote, from the editing calls their hooks reported. A harness
  // that sends no tool input writes none of these, and neither does a
  // record from before the count, so the line is what was measured rather
  // than what was written - docs/measures.md says which. It is a total and
  // not a share, so a period at nought is a period nothing was counted in
  // and no option can win by it; that is why it is drawn where the
  // per-task figures are left blank.
  { key: "lines", label: "Lines written", unit: "lines of code the sessions that started in each period wrote", format: (value) => count(value), priced: false },
];

/**
 * The metrics a page can show: cost only when a model here is priced, and
 * tasks finished only where tasks are handed out (console-edition.js) -
 * otherwise it is a chip onto a line flat at nought.
 */
export const metricsFor = (priced) => METRICS.filter((metric) => (priced || !metric.priced) && (hasTasks() || metric.key !== "finished"));

/** What the line can be split by: nothing, or one of the server's splits, in its order. */
export const SPLITS = [
  { key: "none", label: "Nothing" },
  { key: "provider", label: "Model provider" },
  { key: "model", label: "Model" },
  { key: "harness", label: "Harness" },
  { key: "sandbox", label: "Sandbox" },
  { key: "user", label: "User" },
  { key: "executor", label: "Executor" },
];

/** How many lines get a name at their end: past this the ends collide, and the legend does the naming. */
export const DIRECT_LABELS_MAX = 4;

/** A period's label in the reader's own time: the day, or the hour. */
export function labelOf(at, step, { long = false } = {}) {
  const when = new Date(at);
  if (step === "hour") {
    // Short, on the axis: "9 AM", so six of them fit a phone's width.
    const hour = when.toLocaleTimeString(undefined, long ? { hour: "numeric", minute: "2-digit" } : { hour: "numeric" });
    return long ? `${when.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${hour}` : hour;
  }
  return when.toLocaleDateString(undefined, long ? { weekday: "short", month: "short", day: "numeric" } : { month: "short", day: "numeric" });
}

/** The point with the most of a metric, or null when every point is nought. */
export function peakOf(points, key) {
  let best = null;
  for (const point of points) if ((point[key] ?? 0) > 0 && (!best || point[key] > best[key])) best = point;
  return best;
}

/** Which points get an x label: the first, the last, and a few evenly between - never so many they collide. */
export function labelledIndexes(n, most = 6) {
  if (n <= most) return [...Array(n).keys()];
  const out = new Set([0, n - 1]);
  const stride = Math.ceil((n - 1) / (most - 1));
  // One too close to the last is dropped: the last is always labelled,
  // and two labels a point apart collide on a phone.
  for (let i = stride; i < n - 1; i += stride) if (n - 1 - i > stride / 2) out.add(i);
  return [...out].sort((a, b) => a - b);
}

/** The SVG path of the line, in a 0-100 space the plot stretches to its own size. */
export function pathOf(points, key, most) {
  if (!points.length) return "";
  const x = (i) => (points.length === 1 ? 50 : (i / (points.length - 1)) * 100);
  const y = (value) => 100 - (most > 0 ? (value / most) * 100 : 0);
  return points.map((point, i) => `${i ? "L" : "M"}${x(i).toFixed(2)},${y(point[key] ?? 0).toFixed(2)}`).join(" ");
}

const svg = (tag, attrs = {}) => {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
};

/**
 * The chart for one metric: one line per series, over the same periods.
 * A lone series (no split) is the accent with its area filled; several
 * are hues by slot, lines only - overlaid areas hide each other.
 *
 * @param {{key: string, name: string, points: object[]}[]} series
 */
function chart(series, step, metric) {
  const points = series[0]?.points ?? [];
  const lone = series.length === 1;
  const most = Math.max(0, ...series.flatMap((line) => line.points.map((point) => point[metric.key] ?? 0)));
  const box = el("div", `trend-chart${lone ? "" : " is-split"}`);
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", `${metric.label} over time${lone ? "" : `, ${series.length} lines`}`);

  // The scale: three gridlines, the top one the most any period reached.
  const axis = el("div", "trend-axis");
  for (const share of [1, 0.5, 0]) {
    const tick = el("span", "trend-axis-tick", metric.format(most * share));
    tick.style.top = `${(1 - share) * 100}%`;
    axis.append(tick);
  }

  const plot = el("div", "trend-plot");
  for (const share of [1, 0.5]) {
    const grid = el("span", "trend-grid");
    grid.style.top = `${(1 - share) * 100}%`;
    plot.append(grid);
  }
  const x = (i) => (points.length === 1 ? 50 : (i / (points.length - 1)) * 100);
  const y = (value) => 100 - (most > 0 ? ((value ?? 0) / most) * 100 : 0);
  const picture = svg("svg", { class: "trend-svg", viewBox: "0 0 100 100", preserveAspectRatio: "none", "aria-hidden": "true" });
  series.forEach((line, slot) => {
    const d = pathOf(line.points, metric.key, most);
    if (!d) return;
    if (lone) picture.append(svg("path", { class: "trend-area", d: `${d} L100,100 L0,100 Z` }));
    picture.append(svg("path", { class: `trend-line${lone ? "" : ` series-${slot + 1}`}`, d, "vector-effect": "non-scaling-stroke" }));
  });
  plot.append(picture);

  // The hover layer: a hairline that snaps to the nearest period, and
  // every line's value there - the values lead, the names follow, each
  // with its swatch. On a lone line each marker is a hit target of its
  // own and focusable, so the keyboard reads the same tooltip; on
  // several the table is the keyboard's way to the numbers.
  const hair = el("span", "trend-hair");
  hair.hidden = true;
  const tip = el("span", "trend-tip");
  tip.hidden = true;
  tip.setAttribute("role", "status");
  plot.append(hair, tip);
  const show = (i) => {
    hair.style.left = `${x(i)}%`;
    hair.hidden = false;
    const rows = [el("span", "trend-tip-when", labelOf(points[i].at, step, { long: true }))];
    series.forEach((line, slot) => {
      const row = el("span", "trend-tip-row");
      if (!lone) row.append(el("span", `trend-swatch series-${slot + 1}`));
      row.append(el("strong", null, metric.format(line.points[i]?.[metric.key] ?? 0)));
      if (!lone) row.append(el("span", "trend-tip-name", ` ${line.name}`));
      rows.push(row);
    });
    tip.replaceChildren(...rows);
    tip.style.left = `${x(i)}%`;
    // To the right of the hairline unless that runs off the plot - on a
    // phone that is most of the plot - in which case to the left of it.
    tip.classList.remove("is-left");
    tip.hidden = false;
    const box = plot.getBoundingClientRect();
    if (tip.getBoundingClientRect().right > box.right) tip.classList.add("is-left");
  };
  const hide = () => {
    hair.hidden = true;
    tip.hidden = true;
  };
  if (lone) {
    const peak = peakOf(points, metric.key);
    points.forEach((point, i) => {
      const dot = el("button", `trend-dot${peak === point ? " is-peak" : ""}`);
      dot.type = "button";
      dot.style.left = `${x(i)}%`;
      dot.style.top = `${y(point[metric.key])}%`;
      dot.setAttribute("aria-label", `${labelOf(point.at, step, { long: true })}: ${metric.format(point[metric.key] ?? 0)}`);
      dot.addEventListener("focus", () => show(i));
      dot.addEventListener("blur", hide);
      plot.append(dot);
    });
  } else if (series.length <= DIRECT_LABELS_MAX) {
    // A name at each line's end, so identity is never colour alone.
    series.forEach((line, slot) => {
      const last = line.points[line.points.length - 1];
      const label = el("span", `trend-end series-${slot + 1}`, line.name);
      label.style.top = `${y(last?.[metric.key])}%`;
      plot.append(label);
    });
  }
  plot.addEventListener("pointermove", (event) => {
    const rect = plot.getBoundingClientRect();
    if (!rect.width || points.length < 2) return;
    const share = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    show(Math.round(share * (points.length - 1)));
  });
  plot.addEventListener("pointerleave", hide);

  const labels = el("div", "trend-labels");
  for (const i of labelledIndexes(points.length)) {
    const label = el("span", "trend-label", labelOf(points[i].at, step));
    label.style.left = `${x(i)}%`;
    labels.append(label);
  }

  box.append(axis, plot, labels);
  return box;
}

/** The legend: every line, its swatch, its name and its total - present whenever there is more than one. */
function legend(series, metric) {
  const list = el("ul", "trend-legend");
  list.setAttribute("aria-label", "Lines");
  series.forEach((line, slot) => {
    const item = el("li", "trend-legend-item");
    item.append(el("span", `trend-swatch series-${slot + 1}`), el("span", "trend-legend-name", line.name), el("span", "trend-legend-total", metric.format(line.totals?.[metric.key] ?? 0)));
    if (line.folded?.length) item.title = line.folded.join(", ");
    list.append(item);
  });
  return list;
}

/** The same points as a table - the chart's twin: every metric of the one line, or the one metric of every line. */
function table(series, step, metrics, metric) {
  const lone = series.length === 1;
  const head = lone ? metrics.map((entry) => entry.label) : series.map((line) => line.name);
  const grid = listTable({ head: [step === "hour" ? "Hour" : "Day", ...head] });
  grid.classList.add("trend-table");
  const points = series[0]?.points ?? [];
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const cells = lone
      ? metrics.map((entry) => entry.format(points[i][entry.key] ?? 0))
      : series.map((line) => metric.format(line.points[i]?.[metric.key] ?? 0));
    grid.append(listRow({ name: labelOf(points[i].at, step, { long: true }), cells }));
  }
  return grid;
}

/**
 * The panel.
 *
 * `data` is what /api/performance/compare said - it carries `trend` -
 * and `state` is which metric and charts-or-table, kept by the caller
 * across its own redraws the way the comparison's dimension is.
 *
 * @param {object} args
 * @param {object|null} args.data
 * @param {string|null} args.failed
 * @param {{metric: string, split: string, table: boolean}} args.state
 * @param {(state: object) => void} args.onState told the new state; must not redraw
 */
export function trendView({ data, failed, state, onState }) {
  const panel = el("section", "console-panel trend");
  panel.append(el("h3", "panel-heading", "Over time"));
  panel.append(el("p", "console-hint", "The range period by period, for one figure at a time: pick which."));
  if (failed) {
    panel.append(el("p", "console-hint", `Could not read the trend - ${failed}`));
    return panel;
  }
  if (!data?.trend) {
    panel.append(el("p", "console-hint", "Reading…"));
    return panel;
  }
  const trend = data.trend;
  const metrics = metricsFor(data.priced !== false);
  let current = { metric: metrics[0].key, split: "none", table: false, ...state };
  if (!metrics.some((metric) => metric.key === current.metric)) current.metric = metrics[0].key;
  // What this installation can split a line by. "Sandbox" goes where
  // everything runs on the one machine (console-edition.js): it is one line
  // relabelled, under a chip that promises a comparison. A split saved from
  // elsewhere falls back to none rather than drawing nothing.
  const splits = SPLITS.filter((split) => split.key !== "sandbox" || hasSandboxes());
  if (!splits.some((split) => split.key === current.split)) current.split = "none";
  const body = el("div", "trend-body");
  panel.append(body);

  const set = (patch) => {
    current = { ...current, ...patch };
    onState(current);
    redraw();
  };

  function redraw() {
    const picked = metrics.find((metric) => metric.key === current.metric) ?? metrics[0];
    const chips = el("div", "list-filters trend-metrics");
    for (const metric of metrics) {
      const chip = button("filter-chip", metric.label, () => set({ metric: metric.key }));
      chip.setAttribute("aria-pressed", metric.key === picked.key ? "true" : "false");
      chips.append(chip);
    }
    const flip = button("link-btn trend-flip", current.table ? "Show as chart" : "Show as table", () => set({ table: !current.table }));
    const tools = el("div", "compare-tools trend-tools");
    tools.append(chips, flip);
    // And what to split the line by - a second row, since it is a second
    // question: "spend" is the figure, "by harness" is the comparison.
    const splitter = el("div", "list-filters trend-splits");
    splitter.append(el("span", "trend-splits-label", "Split by"));
    for (const split of splits) {
      const chip = button("filter-chip", split.label, () => set({ split: split.key }));
      chip.setAttribute("aria-pressed", split.key === current.split ? "true" : "false");
      splitter.append(chip);
    }

    const parts = [tools, splitter];
    const points = trend.points ?? [];
    const total = trend.totals?.[picked.key] ?? 0;
    const peak = peakOf(points, picked.key);
    const unreported = current.split === "none" ? 0 : trend.unreported?.[current.split]?.sessions ?? 0;
    const series = current.split === "none"
      ? [{ key: "all", name: "Everything", points, totals: trend.totals }]
      : (trend.splits?.[current.split] ?? []).filter((line) => (line.totals?.[picked.key] ?? 0) > 0 || (line.totals?.sessions ?? 0) > 0);
    // In words, above the line: the total and where the peak was, so the
    // shape is read before it is looked at - and read at all by somebody
    // who does not see the line.
    const said = el("p", "trend-said");
    if (!peak) {
      said.textContent = `Nothing ${picked.key === "cost" ? "spent" : picked.key === "tokens" ? "used" : picked.key === "finished" ? "finished" : "started"} in the range.`;
    } else {
      said.append(
        el("strong", null, picked.format(total)),
        el("span", null, ` ${picked.label.toLowerCase()} over the range · peak `),
        el("strong", null, picked.format(peak[picked.key])),
        el("span", null, ` on ${labelOf(peak.at, trend.step, { long: true })}`),
      );
    }
    parts.push(said);
    if (peak) {
      parts.push(el("p", "chart-unit", picked.unit));
      if (series.length > 1) parts.push(legend(series, picked));
      parts.push(current.table ? table(series, trend.step, metrics, picked) : chart(series, trend.step, picked));
    }
    const folded = series.find((line) => line.key === "other");
    parts.push(el("p", "console-caveat", [
      `${trend.step === "hour" ? "An hour" : "A day"} a point, in your own time. A session counts on the period it started in; a task counts on the period it finished in. ` +
        "Sessions begun before the range are not on the line, however they ended.",
      series.length > 1 ? "Lines are most sessions first, and a group keeps its colour whichever figure is shown." : null,
      folded ? `"Other" folds the smallest: ${folded.folded.join(", ")}.` : null,
      // As on the charts above: a session that named none of the groups
      // is not a line of its own, and the reader is told how many there
      // were rather than left to wonder why the lines undershoot the
      // total the panel opened with.
      unreported ? `${unreported} session${unreported === 1 ? "" : "s"} did not say, and ${unreported === 1 ? "is" : "are"} not on the line.` : null,
    ].filter(Boolean).join(" ")));
    body.replaceChildren(...parts);
  }

  redraw();
  return panel;
}
