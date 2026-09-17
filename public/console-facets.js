// One filter over every facet, for people who do not know our filing system.
//
// The Performance page narrowed with a dropdown per facet: Executor here,
// Harness there. That asks the reader to know which drawer a thing is in
// before they can look for it - and nobody knows that Niteshift is filed
// under "place to run", or that OpenCode is a harness rather than a model,
// or which of the two Claude Code is. They know the name of the thing they
// ran with. So there is one box, it holds every value of every facet at
// once, and each answer says which drawer it came from as it is offered.
// Typing "nite" finds Niteshift and says "Place to run" beside it; typing
// "place to run" lists all of them, so the filing system is still there to
// be browsed - it is just no longer something you have to know first.
//
// The vocabulary is deliberately the comparison's (console-compare.js
// DIMENSIONS, server `groupOf`): the charts compare by model provider,
// harness, place to run and person, and this offers the same values under
// the same labels. That is what lets a pick reframe the page rather than
// only narrow it - see `framedBy`.
//
// The control itself is the console's one filter control (console-filters.js
// `filterPicker`, `multi`), so this module is a vocabulary and not a widget:
// the fuzzy rule, the type-to-narrow box and the phone layout are the same
// ones every other filter on the console got.
import { filterPicker } from "./console-filters.js";

/**
 * The facets, in the order the list offers them. `valueOf` reads one off a
 * ranking row - the row carries them (`facetsOf` on the server) because the
 * page holds every session at once and narrows on the client.
 *
 * `executor` and `repository` are the ranking's own. The middle four are the
 * comparison's dimensions, by the same keys, so the two halves of the page
 * agree about what a thing is called.
 */
export const FACETS = [
  { key: "executor", label: "Executor", valueOf: (row) => pair(row.actor?.id, row.actor?.name) },
  { key: "harness", label: "Harness", valueOf: (row) => pair(row.harness?.kind, row.harness?.kindLabel ?? row.harness?.name) },
  { key: "sandbox", label: "Place to run", valueOf: (row) => pair(row.sandbox?.key, row.sandbox?.name) },
  { key: "provider", label: "Model provider", valueOf: (row) => pair(row.provider?.key, row.provider?.name) },
  { key: "user", label: "Person", valueOf: (row) => pair(row.owner, row.owner) },
  { key: "repository", label: "Repository", valueOf: (row) => pair(row.repository, row.repository) },
  // What kind of work the agent said it was (server/work-kinds.js). A
  // session that never said has a null key and offers nothing to pick:
  // "Unsaid" is a row on the kinds table, not a thing anybody ran with.
  { key: "work", label: "Kind of work", valueOf: (row) => pair(row.work?.key, row.work?.name) },
];

/**
 * The facets the comparison above can also be read by - its dimensions, by
 * the same keys. Picking one of these reframes the charts around it; picking
 * an executor or a repository, which no chart compares by, only narrows the
 * ranking below.
 */
export const COMPARABLE = ["provider", "harness", "sandbox", "user"];

const pair = (key, label) => (key ? { key: String(key), label: String(label ?? key) } : null);

const facetOf = (key) => FACETS.find((facet) => facet.key === key) ?? null;

/**
 * A pick is one string, `facet:value`, because that is what the picker
 * hands back and what a URL could carry. Facet keys hold no colon, so the
 * first one is the seam and a value may hold as many as it likes
 * (`model:claude-opus-5` is a provider key).
 */
export const pickOf = (facet, key) => `${facet}:${key}`;
export function partsOf(pick) {
  const at = String(pick ?? "").indexOf(":");
  return at < 0 ? null : { facet: pick.slice(0, at), key: pick.slice(at + 1) };
}

/** What a pick is called in prose: the value, with its drawer behind it. */
export function labelOf(pick, entries = []) {
  const found = entries.find((entry) => entry.key === pick);
  if (found) return `${found.note ?? ""} ${found.label}`.trim();
  const parts = partsOf(pick);
  return parts ? `${facetOf(parts.facet)?.label ?? parts.facet}: ${parts.key}` : String(pick);
}

/**
 * Every value of every facet the rows hold, each once, as picker entries -
 * the facet's label is the note, which is the dim half of a row, so the list
 * reads "Niteshift / Place to run · 12 sessions".
 *
 * Drawn from all the rows rather than from what the other picks left, so an
 * option never vanishes from under the finger about to press it - the rule
 * the chip rows had before any of this.
 */
export function optionsOf(rows) {
  const out = [];
  for (const facet of FACETS) {
    const seen = new Map();
    for (const row of rows) {
      const value = facet.valueOf(row);
      if (!value) continue;
      const found = seen.get(value.key);
      if (found) found.sessions += 1;
      else seen.set(value.key, { key: pickOf(facet.key, value.key), label: value.label, facet: facet.key, sessions: 1 });
    }
    const entries = [...seen.values()].sort((a, b) => b.sessions - a.sessions || a.label.localeCompare(b.label));
    for (const entry of entries) {
      entry.note = `${facet.label} · ${entry.sessions} session${entry.sessions === 1 ? "" : "s"}`;
    }
    out.push(...entries);
  }
  return out;
}

/**
 * Whether a row survives the picks.
 *
 * Picks of the same facet are alternatives and picks of different facets are
 * conditions: "Niteshift or e2b, run with OpenCode" is what four picks mean,
 * which is what people expect and the only reading under which choosing a
 * second place to run widens the table rather than emptying it.
 */
export function matchesPicks(row, picks = []) {
  const byFacet = new Map();
  for (const pick of picks) {
    const parts = partsOf(pick);
    if (!parts) continue;
    if (!byFacet.has(parts.facet)) byFacet.set(parts.facet, new Set());
    byFacet.get(parts.facet).add(parts.key);
  }
  for (const [key, wanted] of byFacet) {
    const facet = facetOf(key);
    if (!facet) continue;
    const value = facet.valueOf(row);
    if (!value || !wanted.has(value.key)) return false;
  }
  return true;
}

/**
 * How the picks reframe the comparison above: which dimension it should be
 * showing, and which of its bars are the reader's own.
 *
 * The point of the page is what a thing is worth *against its alternatives*,
 * so a pick must not narrow the charts to itself - one bar compares with
 * nothing. It switches the charts to that thing's own dimension instead, so
 * Niteshift arrives standing beside e2b, Fly and a laptop, and lights the
 * bar that is Niteshift's. The ranking below is the half that narrows.
 *
 * The last pick the panel can show wins, because it is the one just made;
 * picks of a facet it cannot (a repository, or an executor on the charts)
 * leave it alone and only narrow the ranking.
 *
 * `allowed` is which facets the panel in question has a view for - the
 * comparison's dimensions by default, and the trend's splits when the trend
 * asks, since it can split by an executor and the charts cannot.
 *
 * @returns {{dimension: string, keys: string[]}|null}
 */
export function framedBy(picks = [], allowed = COMPARABLE) {
  const parts = picks.map(partsOf).filter((part) => part && allowed.includes(part.facet));
  if (!parts.length) return null;
  const dimension = parts[parts.length - 1].facet;
  return { dimension, keys: parts.filter((part) => part.facet === dimension).map((part) => part.key) };
}

/**
 * The box.
 *
 * `onPicks` is told the new picks and nothing here changes, the way every
 * filter on this console works: the control looks picked once the thing it
 * filters has caught up, and never before.
 */
export function smartFilter({ label = "See how your tool performed", rows = [], picks = [], onPicks }) {
  return filterPicker({
    label,
    entries: optionsOf(rows),
    picked: picks,
    onPick: onPicks,
    multi: true,
    none: "Everything",
    find: "Niteshift, OpenCode, a laptop, a person…",
  });
}
