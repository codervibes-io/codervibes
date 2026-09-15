// A list of things, one row each, in the main pane.
//
// A row has a name, a line under it, a dot that says whether the thing is
// alive, and then as many cells as the page has facts worth a column -
// status, where it is, what it runs on. It is one shape so that the
// machines, the agents and the repos read the same way - every page
// opens on one of these now - and so the phone rule (the cells go, the name
// and the status stay) is written once.
//
// A row is not a link because a row can hold a box to tick, and a box inside
// a link is a box that opens the page. The name is the button.
import { el, button, detailHead } from "./console-dom.js";

/**
 * The table. `cells` is how many columns come after the name, so the grid
 * can be laid out in CSS rather than measured here.
 *
 * @param {object} args
 * @param {string[]} args.head the column labels, name first
 * @param {boolean} [args.pickable] whether rows carry a box to tick
 */
export function listTable({ head, pickable = false }) {
  const table = el("div", `list-table${pickable ? " pickable" : ""}`);
  table.style.setProperty("--cells", String(Math.max(0, head.length - 1)));
  table.setAttribute("role", "table");
  const row = el("div", "list-head");
  row.setAttribute("role", "row");
  if (pickable) row.append(el("span", "list-pick-gap"));
  head.forEach((label, index) => {
    // A head may be a node and not only a string: a column whose name
    // needs explaining carries the "?" that explains it (console-dom.js
    // `helpMark`), and it belongs in the head rather than in every cell.
    const cell = el("span", index === 0 ? "list-head-name" : "list-cell");
    cell.append(label);
    row.append(cell);
  });
  table.append(row);
  return table;
}

/**
 * One row.
 *
 * @param {object} args
 * @param {string} args.name
 * @param {string} [args.note] the line under the name
 * @param {boolean} [args.live] lit dot: the thing is up
 * @param {boolean} [args.busy] pulsing dot: the thing is in motion - an
 *   agent mid-call. A machine that is up is not busy; see the CSS.
 * @param {boolean} [args.selected]
 * @param {(Node|string|null|{node: Node, keep: true})[]} args.cells one per
 *   column after the name; a string becomes a plain cell, a node is put in as
 *   it is, and `keep` marks the one cell a phone still shows
 * @param {string|null} [args.aside] a cell's fact said again under the
 *   name for the phone, where the cells are gone
 * @param {(() => void)|null} args.onOpen what pressing the name does, or
 *   null for a thing with no page of its own - the name is then plain text
 *   and the row is not a target
 * @param {{checked: boolean, onChange: (checked: boolean) => void}} [args.pick]
 */
export function listRow({ name, note, aside = null, live = false, busy = false, selected = false, cells = [], onOpen = null, pick = null }) {
  const row = el("div", `list-row${live ? " live" : ""}${busy ? " busy" : ""}${selected ? " selected" : ""}`);
  row.setAttribute("role", "row");

  // The name is usually a string; a row that has to mark itself - a
  // session in a repository nobody connected here (console-where.js) -
  // hands over a node with the mark inside it. `named` is that row's name
  // in words, for the places only words go.
  const named = name instanceof Node ? name.textContent : name;

  if (pick) {
    const box = el("input", "list-pick");
    box.type = "checkbox";
    box.checked = pick.checked;
    box.setAttribute("aria-label", `Select ${named}`);
    box.addEventListener("change", () => pick.onChange(box.checked));
    row.append(box);
  }

  // A thing with no page behind it is still a row, but not a button: a
  // button that opens nothing is a promise the row cannot keep, and a
  // skill (the Tools page) has no page.
  const open = onOpen ? button("list-open", "", onOpen) : el("span", "list-open list-still");
  open.append(el("span", "rail-dot"));
  const text = el("span", "list-text");
  const label = el("span", "list-name");
  if (name instanceof Node) label.append(name);
  else label.textContent = name ?? "";
  text.append(label);
  if (note) text.append(el("span", "list-note", note));
  // A phone drops every cell but the kept one, so a fact that lives in a
  // cell on the desktop is gone there. `aside` is that fact said again
  // under the name, shown only below the breakpoint (console.css).
  if (aside) text.append(el("span", "list-aside", aside));
  open.append(text);
  row.append(open);

  for (const cell of cells) {
    const keep = cell?.keep === true;
    const content = keep ? cell.node : cell;
    // `keep` survives the phone layout, where the other cells are dropped
    // for want of width - the one fact a row must still show there.
    const wrap = el("span", `list-cell${keep ? " keep" : ""}`);
    if (content instanceof Node) wrap.append(content);
    else wrap.textContent = content ?? "—";
    row.append(wrap);
  }
  return row;
}

// ------------------------------------------------------------------- heat
//
// A column of numbers a reader is comparing against each other - the
// ranking's rate and rounds and cost, the comparison's figures - is
// shaded from pastel green to pastel red, best to worst.
//
// The point is the scan. A table of forty sessions holds the answer to
// "who is expensive" in its Cost column, and finding it meant reading
// forty numbers and holding them in your head; a column of colour answers
// it before the numbers are read at all. The number stays in the cell, so
// the colour is a second telling of something already written and nothing
// is lost to a reader who cannot see the difference between the two ends.
//
// By rank and not by value, because one session that took 400 lines of
// steering would paint every other row green under a straight min-to-max
// scale, and the reader would learn only that the outlier exists. Ties
// take the same step - two rows on 100% are not a better and a worse.
// Nothing is shaded when the column holds one value, or one row: there is
// no comparison to draw, and colouring it would invent one.

/** How many steps the ramp has: 1 is the best of the column, 5 the worst. */
export const HEAT_STEPS = 5;

/**
 * A step for each of `values`, or null for the ones with no number and for
 * every one of them when there is nothing to compare.
 *
 * `better` is which end wins - "high" for a merge rate, "low" for a cost.
 * Exported so the ordering can be proved without a DOM.
 */
export function heatRanks(values, better = "high") {
  const out = values.map(() => null);
  const known = values.map((value, at) => ({ at, value })).filter((entry) => Number.isFinite(entry.value));
  if (known.length < 2 || new Set(known.map((entry) => entry.value)).size < 2) return out;

  // The average rank of each distinct value, so equal numbers get equal
  // colour rather than the colour of whichever was drawn first.
  const sorted = [...known].sort((a, b) => a.value - b.value);
  const rankOf = new Map();
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j < sorted.length && sorted[j].value === sorted[i].value) j += 1;
    rankOf.set(sorted[i].value, (i + j - 1) / 2);
    i = j;
  }

  for (const entry of known) {
    const share = rankOf.get(entry.value) / (known.length - 1);
    const good = better === "low" ? 1 - share : share;
    out[entry.at] = HEAT_STEPS - Math.min(HEAT_STEPS - 1, Math.floor(good * HEAT_STEPS));
  }
  return out;
}

/**
 * A number as a shaded cell: the wash is on the number, not on the cell.
 *
 * A cell fills its column, so shading the cell paints the table in bands
 * the width of a column and the reader is looking at a heat map with
 * numbers on it. A pill the width of the number keeps it a table, and the
 * column of pills is still a column of colour to scan down.
 *
 * An unshaded step - null - is the plain string it always was.
 */
export function heatCell(text, step) {
  return step ? el("span", `heat heat-${step}`, text) : text;
}

/** A status chip, as a cell that a phone keeps. */
export function statusCell(word, className) {
  return { keep: true, node: el("span", `chip ${className ?? ""}`.trim(), word) };
}

/**
 * The top of a list page: its name, a count line, and the button that adds
 * one - in a row under the name, or as `corner`, the one control that sits
 * top-right of the page beside the name.
 *
 * Here rather than in console-lists.js because the lists are not one file
 * any more: the Executors page is its own module (page-executors.js) and
 * the connectors and secrets are still there, and a page head copied into
 * both would be two page heads to keep the same.
 */
export function listHead(title, summary, actions, corner = null) {
  const pane = el("div", "detail detail-wide");
  const top = detailHead(title, summary == null ? null : el("p", "detail-summary", summary), corner);
  if (corner) top.classList.add("has-corner");
  pane.append(top);
  if (actions.length) {
    const row = el("div", "detail-actions");
    row.append(...actions);
    pane.append(row);
  }
  return pane;
}
