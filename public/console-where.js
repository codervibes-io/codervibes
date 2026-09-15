// Which work a page shows, and how a row says which kind it is.
//
// Every listing in the console is the open workspace's, and until now that
// meant one thing: work in a repo somebody registered here. Work in a
// repository nobody connected - most of what an agent does for a team, in
// repositories the team does not administer - and work in no repository at
// all reached no page. Now they reach the page when the reader asks, under
// their own words (server/session-where.js):
//
//   workspace  a repo of this workspace
//   external   a repository, but not one this workspace has a repo of
//   none       no repository at all
//
// Two rules hold the whole thing together, and both are here because they
// have to be the same on Activity, Search, Performance and Tools:
//
//   - Nothing but `workspace` is shown until somebody presses for it. A
//     person's setup reports every terminal they open; a page that showed
//     all of it by default would be their laptop, not their team's work.
//   - A row that is not `workspace` says so, on the row. Mixing a
//     repository nobody here registered into a workspace listing without
//     marking it is worse than leaving it out: the numbers change and
//     nothing on screen says why.
import { el } from "./console-dom.js";
import { filterPicker } from "./console-filters.js";

/** The two that are not the default, in the order the filter offers them. */
const EXTRAS = [
  ["external", "External repos", "Work in a repository no repo of this workspace is of - nobody connected it here."],
  ["none", "No repo", "Work in no repository at all - a scratch directory, a script, a question answered."],
];

/** What a row of each kind is called, and what the words mean. */
const LABELS = {
  external: ["External repo", "In a repository no repo of this workspace is of. Nothing is connected to it here, so this app knows only the name the harness reported."],
  none: ["No repo", "The harness reported no repository - work in a scratch directory, or none."],
};

/**
 * The extras the reader has pressed for. Module state, like the Activity
 * page's own filters: the pages are rebuilt whole on every event, and a
 * filter that reset itself on each tick could not be used. Off on every
 * load, deliberately - see the rules above.
 */
const picked = new Set();

/**
 * Whether where a piece of work was done is a distinction this console
 * draws at all.
 *
 * It is a distinction *relative to a workspace* - the three words above are
 * all "…of this workspace" - so on an installation that has no workspaces
 * and one person (server/edition.js) they say nothing. Every session on a
 * laptop is in a repository nobody registered or in none, so every row
 * would carry a chip and the filter would offer to include work that is
 * already on the page. `oneWhere()` is the entry point saying so once, and
 * the filter and the chips then draw as nothing.
 *
 * A switch rather than an argument threaded through four views: what it
 * answers is a fact about the installation, not about a page, and a page
 * that had to be told would eventually be a page somebody forgot to tell.
 */
let wheres = true;
export const oneWhere = () => {
  wheres = false;
};

/** Whether a kind is being shown. `workspace` always is. */
export const showing = (where) => where === "workspace" || picked.has(where);

/**
 * What the server is asked for, as `?where=` takes it (server/session-where.js
 * `parse`). Always names `workspace`, so a request says what it wants rather
 * than relying on the default.
 */
export const param = () => ["workspace", ...EXTRAS.map(([key]) => key).filter((key) => picked.has(key))].join(",");

/** Whether anything beyond this workspace's own repos is on the page. */
export const widened = () => picked.size > 0;

/**
 * Press for the extras from code: the empty Activity page's "Include
 * them", the one press offered outside the picker (console-home.js
 * `hiddenWork`). Only the two extras can be pressed; `workspace` is
 * always on, and a key that is neither is ignored rather than kept.
 */
export function include(keys) {
  for (const key of keys) if (EXTRAS.some(([extra]) => extra === key)) picked.add(key);
}

/**
 * What a row of this kind is called, in words - for the places a chip
 * cannot go: a phone's `aside` line under a row's name (console-list.js
 * drops every cell but one below the breakpoint, so a mark that lives
 * only in a cell is a mark a phone never shows), and a page's hint.
 *
 * @returns {string|null} null for `workspace`, which needs no saying
 */
export const whereLabel = (where) => (wheres ? LABELS[where]?.[0] ?? null : null);

/**
 * The chip that marks a row as not this workspace's own - nothing at all
 * for one that is. Every listing that can show the extras draws this
 * beside the row's name.
 *
 * @param {string|null} where one of the three
 * @returns {HTMLElement|null}
 */
export function whereChip(where) {
  const said = wheres ? LABELS[where] : null;
  if (!said) return null;
  const chip = el("span", `chip chip-where chip-where-${where}`, said[0]);
  chip.title = said[1];
  return chip;
}

/**
 * The toggles. Both off to begin with; turning one on re-reads the page,
 * because which work is on it is the server's answer and not something
 * the browser can filter its way to.
 *
 * The same dropdown every other filter on this console is
 * (console-filters.js), and a set rather than a pick: the two extras are
 * independent, and asking for outside repositories is not asking to stop
 * seeing work in none. Empty is the default and says so - "Workspace
 * only" is what the button reads before anything is asked for, which is
 * the one state a reader most needs told, since it is the state where
 * the page is quietly leaving work out.
 *
 * @param {() => void} onChanged called after a change, to read the page again
 */
export function whereFilter(onChanged) {
  // Nothing to include: every row is already on the page. `filterRow` drops
  // a null, so a page with this as its only filter draws an empty strip
  // rather than a control that does nothing.
  if (!wheres) return null;
  return filterPicker({
    label: "Include",
    entries: EXTRAS.map(([key, label, why]) => ({ key, label, title: why })),
    picked: [...picked],
    multi: true,
    none: "Workspace only",
    onPick: (keys) => {
      picked.clear();
      for (const key of keys) picked.add(key);
      onChanged();
    },
  });
}
