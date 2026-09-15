// The Harness changes panel: did the CLAUDE.md change help?
//
// One card per commit that changed how the agents work in a repository -
// CLAUDE.md, a skill, a hook, the settings - with the fortnight before it
// beside the fortnight after. The arithmetic is the server's
// (server/harness-changes.js); this decides what a person sees of it.
//
// Three rules the panel is built on, all of them about not overclaiming:
//
//   - A card that is not settled shows the counts and no delta. There is no
//     greyed-out number, no "provisional" figure: an unsettled comparison
//     says "too early to tell" and why, because a number shown once is
//     believed however it was dressed.
//   - The counts are on the card next to the verdict, never in a tooltip.
//     "71% vs 54%" on four sessions each is not a finding, and a reader who
//     has to hover to learn that will not.
//   - What else was different about the two fortnights - who was working,
//     whose models - is one press away on every settled card. It is the
//     confound, and hiding it would make this page an argument rather than
//     a pair of numbers.
//
// It lives in its own module rather than in console-performance.js so that
// the page's own file gains one import and one append line: three pull
// requests are adding panels to that pane at once.
import { el, ago } from "./console-dom.js";

/** How each figure reads, and which way is better - the server's `FIGURES`, said for a reader. */
const FIGURES = {
  oneShotRate: { label: "Finished first time", format: "percent" },
  closureRate: { label: "Finished", format: "percent" },
  failureRate: { label: "Came apart after landing", format: "percent" },
  costPerTask: { label: "Cost per task", format: "cost" },
  steersPerTask: { label: "Steers per task", format: "number" },
  interventions: { label: "Interventions", format: "number" },
  timeToClosure: { label: "Time to finish", format: "duration" },
  tokensPerTask: { label: "Tokens per task", format: "tokens" },
  frictionPoints: { label: "Friction", format: "number" },
  turnsPerSession: { label: "Turns per session", format: "number" },
};

/** What kind of change it was, in a word a person uses. */
const KINDS = { rules: "Rules", skill: "Skill", settings: "Settings", mixed: "Rules and skills" };

/** Which chip a verdict wears. Mixed is amber because it is a thing to look at, not a thing that went wrong. */
const VERDICT_CHIP = { helped: "chip-ok", hurt: "chip-err", mixed: "chip-warn", "too-early": "" };
const VERDICT_WORD = { helped: "Helped", hurt: "Hurt", mixed: "Mixed", "too-early": "Too early" };

/** One figure in its own units. The same arithmetic the server's `show` does, so a card and a sentence agree. */
export function show(value, format = "number") {
  if (value == null) return "—";
  switch (format) {
    case "percent":
      return `${Math.round(value * 100)}%`;
    case "cost":
      if (value < 1) return "<1¢";
      return value < 100 ? `${Math.round(value)}¢` : `$${(value / 100).toFixed(2)}`;
    case "tokens":
      if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
      return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value));
    case "duration":
      if (value < 60_000) return `${Math.round(value / 1000)}s`;
      if (value < 3_600_000) return `${Math.round(value / 60_000)}m`;
      if (value < 24 * 3_600_000) return `${(value / 3_600_000).toFixed(1)}h`;
      return `${(value / (24 * 3_600_000)).toFixed(1)}d`;
    default:
      return String(Math.round(value * 10) / 10);
  }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A figure's name in the fewest words that still say which figure it is - for a table cell, not a card. */
const SHORT = {
  oneShotRate: "first time",
  closureRate: "finished",
  failureRate: "came apart",
  costPerTask: "cost per task",
  steersPerTask: "steers per task",
  interventions: "step-ins",
  timeToClosure: "time to finish",
  tokensPerTask: "tokens per task",
  frictionPoints: "friction",
};

/**
 * A skill's effect in one clause, for the note on its row: the figure that
 * moved most tellingly, with it and without it.
 *
 * The card's whole sentence would be ellipsised away in a table cell, and
 * the numbers - which are the only part worth having - are at the end of
 * it. So the row gets the lead figure and nothing else, and says which side
 * is which in words, because "71% vs 54%" on a row about a skill does not
 * say by itself which of the two used it.
 */
export function effectNote(effect) {
  const key = effect?.verdict?.good?.[0] ?? effect?.verdict?.bad?.[0] ?? null;
  const entry = key ? effect.delta?.[key] : null;
  if (!entry) return null;
  const format = FIGURES[key]?.format ?? "number";
  return `${SHORT[key] ?? key} ${show(entry.after, format)} with it, ${show(entry.before, format)} without`;
}

/** The files a commit touched, at most three named and the rest counted - a card is not a diff. */
function fileList(files = []) {
  const shown = files.slice(0, 3).join(", ");
  return files.length > 3 ? `${shown} and ${plural(files.length - 3, "more file")}` : shown || "—";
}

/**
 * The figures that moved, before and after, in the order the sentence
 * names them. Only the movers: a card listing ten figures of which two
 * moved is a card nobody reads to the end of.
 */
function movedFigures(delta = {}) {
  const rows = el("dl", "harness-figures");
  const order = ["oneShotRate", "closureRate", "failureRate", "costPerTask", "steersPerTask", "interventions", "timeToClosure", "tokensPerTask"];
  let any = false;
  for (const key of order) {
    const entry = delta[key];
    if (!entry || entry.good == null) continue;
    any = true;
    const figure = FIGURES[key] ?? { label: key, format: "number" };
    rows.append(el("dt", "harness-figure-label", figure.label));
    const value = el("dd", `harness-figure-value ${entry.good ? "harness-good" : "harness-bad"}`);
    value.append(el("span", "harness-was", show(entry.before, figure.format)));
    value.append(el("span", "harness-arrow", "→"));
    value.append(el("span", "harness-now", show(entry.after, figure.format)));
    rows.append(value);
  }
  return any ? rows : null;
}

/**
 * What else was different about the two fortnights, behind a press: who was
 * working in each, and whose models. Closed by default because it is the
 * caveat rather than the answer, and open in one tap because a reader who
 * doubts the number needs it immediately.
 */
function besideIt(beside) {
  if (!beside) return null;
  const box = el("details", "harness-beside");
  box.append(el("summary", "harness-beside-head", "What else was different about those two windows"));
  box.append(
    el(
      "p",
      "console-hint",
      "A rule is not the only thing that changed in a fortnight. If the work moved to a cheaper model or to a different person, that moves these figures too - and nothing here can tell the two apart.",
    ),
  );
  for (const [dimension, sides] of Object.entries(beside)) {
    const line = el("div", "harness-beside-row");
    line.append(el("span", "harness-beside-name", dimension === "user" ? "Who was working" : "Whose models"));
    for (const [side, label] of [["before", "before"], ["after", "after"]]) {
      const rows = sides?.[side] ?? [];
      const said = rows.length ? rows.map((row) => `${row.name} ×${row.sessions}`).join(", ") : "nobody reported";
      line.append(el("span", "harness-beside-side", `${label}: ${said}`));
    }
    box.append(line);
  }
  return box;
}

/** One change: what it was, and what happened either side of it. */
function card(entry) {
  const change = entry.change ?? {};
  const box = el("article", "harness-card");

  const head = el("div", "harness-card-head");
  head.append(el("span", `chip harness-kind harness-kind-${change.kind ?? "rules"}`, KINDS[change.kind] ?? "Harness"));
  head.append(el("span", "harness-card-title", change.message || fileList(change.files)));
  box.append(head);

  const meta = el("div", "harness-card-meta");
  meta.append(el("span", "harness-files", fileList(change.files)));
  meta.append(el("span", "harness-by", `${change.by ?? "somebody"} · ${ago(change.at)}`));
  if (change.repoName) meta.append(el("span", "harness-repo", change.repoName));
  if (change.url) {
    const link = el("a", "harness-commit", `${String(change.sha ?? "").slice(0, 7)} ↗`);
    link.href = change.url;
    link.target = "_blank";
    link.rel = "noopener";
    meta.append(link);
  }
  box.append(meta);

  const verdict = entry.verdict ?? { verdict: "too-early", sentence: "Too early to tell." };
  const said = el("p", "harness-verdict");
  said.append(el("span", `chip ${VERDICT_CHIP[verdict.verdict] ?? ""}`.trim(), VERDICT_WORD[verdict.verdict] ?? verdict.verdict));
  said.append(el("span", "harness-sentence", verdict.sentence));
  box.append(said);

  // The counts, always, beside the verdict and not behind anything: what
  // the two sides stand on is half of what the two sides say.
  const counts = entry.counts ?? {};
  box.append(
    el(
      "p",
      "harness-counts",
      `${plural(counts.before ?? 0, "session")} in the fortnight before, ${counts.after ?? 0} after.`,
    ),
  );

  if (entry.settled) {
    const figures = movedFigures(entry.delta);
    if (figures) box.append(figures);
    const also = besideIt(entry.beside);
    if (also) box.append(also);
  }
  return box;
}

/**
 * The panel. Null when the range holds no harness change at all - a page
 * with no CLAUDE.md commit in it should not carry an empty box explaining
 * what one would look like.
 *
 * @param {object} args
 * @param {object|null} args.data what /api/performance/harness said
 * @param {string|null} args.failed why it could not be read
 */
export function harnessView({ data, failed }) {
  if (failed) {
    const panel = el("section", "console-panel perf-harness");
    panel.append(el("h3", "panel-heading", "Harness changes"));
    panel.append(el("p", "console-hint", `Could not read the harness changes - ${failed}`));
    return panel;
  }
  const changes = data?.changes ?? [];
  if (!changes.length) return null;

  const panel = el("section", "console-panel perf-harness");
  panel.append(el("h3", "panel-heading", "Harness changes"));
  panel.append(
    el(
      "p",
      "console-hint",
      "What was changed about how the agents work here - CLAUDE.md, a skill, a hook, the settings - and what the fortnight after each looked like against the fortnight before. There is no control group on a real repository, so both sides are shown with what they stand on.",
    ),
  );
  const list = el("div", "harness-cards");
  for (const entry of changes) list.append(card(entry));
  panel.append(list);
  return panel;
}
