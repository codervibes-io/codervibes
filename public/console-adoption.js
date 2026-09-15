// Adoption: how far each person has taken this, on two pages.
//
// The figures are server/adoption.js's and the essay there says what they
// mean. What this file owns is the one vocabulary they are said in, because
// the same ladder appears in two places - a panel on Performance, a strip
// on Workspace - and a rung that is called "Several at once" on one page
// and "Parallel" on another is two ladders. Account had a row of its own,
// "How you work with agents", until 2026-09-14, when the owner asked for
// it to go.
//
// The rule the whole file obeys: **the level is never shown without its
// reason.** It is a heuristic (adoption.js), and a badge with no fact under
// it is a horoscope somebody will either believe or resent. So the reason
// sits under the name in the table, not behind a hover - a phone has no
// hover, and this is the half of the row worth reading.
import { el, helpMark, metric, metrics, problem } from "./console-dom.js";
import { listTable, listRow, statusCell, heatRanks, heatCell } from "./console-list.js";

/** What the ladder is, in the one sentence the three pages share. */
export const LEVEL_HELP =
  "A rough four-rung reading of how somebody works with agents: asking, one agent, several at once, tunes the harness. " +
  "Each rung includes the one below it, and every row says the fact that put it there - it is a heuristic, so argue with the fact.";

/** What the share is, likewise. */
export const SHARE_HELP =
  "Of the pull requests this person merged in the range, the share that had a session of ours behind them. " +
  "A pull request an agent wrote without our hooks looks hand-written here, so this reads low rather than high when it is wrong.";

const percent = (rate) => (rate == null ? "—" : `${Math.round(rate * 100)}%`);
const plural = (n, word, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;

/** A column head with a `?` beside it - the shape the other tables use. */
function head(label, help) {
  const wrap = el("span", "help-head");
  wrap.append(label, helpMark(label.toLowerCase(), help));
  return wrap;
}

/**
 * Where the team is: one band per rung, widths by how many people are on it.
 *
 * The bands borrow the phase bar's markup (`.phase-bar`/`.phase-band`)
 * rather than a second bar of their own, so the phone rules that already
 * drop the percentages out of a narrow band apply here without a second
 * breakpoint to keep true.
 */
export function teamStrip(team, levels = []) {
  const wrap = el("div", "adoption-strip");
  if (!team?.people) {
    wrap.append(el("p", "console-hint", "Nobody worked here in this range, so there is nobody to place."));
    return wrap;
  }
  const bar = el("div", "phase-bar");
  const legend = el("div", "phase-legend");
  for (const entry of levels) {
    const count = team.byLevel?.[entry.level] ?? 0;
    const share = count / team.people;
    const band = el("div", `phase-band level-${entry.level}`);
    // Grow, not width: a rung with one person out of forty still has to be
    // visible, and a 2% width is a hairline.
    band.style.flexGrow = String(Math.max(share, 0.001));
    if (count) band.append(el("span", "phase-band-share", String(count)));
    band.title = `${entry.name}: ${count} of ${team.people}`;
    bar.append(band);
    const item = el("div", "phase-legend-entry");
    item.append(el("span", `phase-swatch level-${entry.level}`));
    item.append(el("span", "phase-legend-label", entry.name));
    item.append(el("span", "phase-legend-value", String(count)));
    legend.append(item);
  }
  wrap.append(bar, legend);
  return wrap;
}

/** The three figures a team has: how many have adopted, the middle share, the most at once. */
export function teamTiles(team) {
  return metrics(
    metric(percent(team?.adoptersShare), "have adopted", "merged a pull request with an agent behind it"),
    metric(percent(team?.medianShare), "the middle person", "their share of merged pull requests"),
    metric(team?.parallelMax ? String(team.parallelMax) : "—", "most at once", "agents live in one hour"),
  );
}

/** One person's rung as a chip that survives the phone. */
export const levelCell = (level) =>
  statusCell(level ? level.name : "—", level ? `level-chip level-${level.level}` : "chip-none");

/** A person's name with the sentence that put them on their rung under it. */
function nameWithReason(row) {
  const wrap = el("span", "adoption-name");
  wrap.append(el("span", "list-standing", row.name ?? row.owner));
  if (row.level?.reason) wrap.append(el("span", "adoption-reason", row.level.reason));
  return wrap;
}

/**
 * The people, a row each, hardest-working rung first.
 *
 * The share is shaded high-is-better; nothing else is. "At once" is a fact
 * about how somebody works and not a score - three agents is not better
 * than one - and shading it green would say it was.
 */
export function peopleTable(rows) {
  const table = listTable({ head: ["Person", head("Level", LEVEL_HELP), head("Share", SHARE_HELP), "At once", "Sessions", "Merged"] });
  table.classList.add("adoption-table");
  const shares = heatRanks(rows.map((row) => row.pulls?.share ?? null), "high");
  rows.forEach((row, at) => {
    table.append(
      listRow({
        name: nameWithReason(row),
        aside: [percent(row.pulls?.share), `${row.parallel ?? 0} at once`, `${row.sessions} sessions`].join(" · "),
        cells: [
          levelCell(row.level),
          heatCell(percent(row.pulls?.share), shares[at]),
          String(row.parallel ?? 0),
          String(row.sessions),
          row.pulls?.merged ? `${row.pulls.withAgent} of ${row.pulls.merged}` : "—",
        ],
      }),
    );
  });
  return table;
}

/**
 * The Performance page's panel: where the team is, then everybody.
 *
 * The caveats are not decoration. The first is the one that decides whether
 * the number can be trusted at all - an agent running without our hooks is
 * invisible here - and a reader who does not know it will read a low share
 * as a lazy colleague.
 */
export function adoptionPanel({ data, failed }) {
  const section = el("section", "console-panel adoption-panel");
  section.append(el("h3", "panel-heading", "Adoption"));
  if (failed) {
    section.append(problem(failed));
    return section;
  }
  if (!data) {
    section.append(el("p", "console-hint", "Reading who has taken this up…"));
    return section;
  }
  if (!data.rows.length) {
    section.append(el("p", "console-hint", "Nobody worked in this range, so there is nobody to place on the ladder."));
    return section;
  }
  section.append(teamTiles(data.team));
  section.append(teamStrip(data.team, data.levels));
  section.append(peopleTable(data.rows));
  section.append(
    el(
      "p",
      "console-caveat",
      "Adoption is a merged pull request with a session behind it, over every pull request that person merged. " +
        "An agent that runs without this app's hooks leaves no session, so its work reads as hand-written and the share reads low. " +
        "A vendor's bot belongs to whoever summoned it, and to nobody when no session says. " +
        "The rungs are a heuristic - each row says the fact it stands on.",
    ),
  );
  return section;
}

/** The Workspace page's strip: the same distribution, without the table. */
export function whereTheTeamIs({ data, failed }) {
  const section = el("section", "console-panel");
  section.append(el("h3", "panel-heading", "Where the team is"));
  if (failed) {
    section.append(problem(failed));
    return section;
  }
  if (!data) {
    section.append(el("p", "console-hint", "Reading how the team works…"));
    return section;
  }
  section.append(teamStrip(data.team, data.levels));
  section.append(
    el(
      "p",
      "console-hint",
      // "1 people worked here" was what a workspace with one person read;
      // the helper the rest of the console counts with says "1 person".
      `${plural(data.team.people, "person", "people")} worked here in the last 30 days. ` +
        "A rung is a rough reading of how somebody works with agents, and each includes the one below it; the Performance page says which fact put each person where.",
    ),
  );
  return section;
}
