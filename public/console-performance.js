// Performance: who is finishing the work, and what it costs to steer them.
//
// Home is the work as it happens; this is the ranking over it. Every
// session in the range is a row, all of them at once, and the table says
// for each how many tasks it finished, how much steering they took and
// what each cost. The score orders the rows and the page shows the parts
// it is made of, so nobody has to trust a number they cannot take apart. A
// row whose rate is at or above the installation's median, with at least
// one task finished, is marked effective - that is the highlight, and it
// is a comparison, not a verdict.
//
// A task is a piece of work with a verdict, which is not the same thing as
// a session and no longer the same thing as a pull request - the "?" beside
// the word on the page says so in a sentence, and server/performance.js
// says why it changed.
//
// The page used to be four tabs - agents, harnesses, people, sessions -
// each a different grouping of the same sessions, and the reader had to
// guess which tab held the answer. Then it was one list behind a filter per
// facet, which asks a smaller version of the same question: which drawer is
// Niteshift in? Now one box at the top holds every value of every facet -
// executor, harness, place to run, model provider, person, repository - and
// says which drawer each came from as it offers it (console-facets.js). You
// type the name of the thing you ran with; you do not have to know what we
// decided it was.
//
// Above the ranking sits the comparison (console-compare.js): the same
// figures - tokens and cost a task took, how many finished, how long, how
// many landed first time, how much stepping in, and where the hours went -
// for every model provider, harness, place to run and person, as charts.
// The ranking says who; the comparison says with what, and which of the
// options a team can choose between is working.
//
// A pick reframes both halves, and differently, which is the whole design:
// the charts switch to the picked thing's own dimension and light its bar,
// so Niteshift arrives standing beside e2b, Fly and a laptop rather than
// alone - one bar compares with nothing - while the ranking below narrows
// to the sessions behind that bar. Compare against its peers, read its own
// work: the two questions a person has about a tool, on one screen.
import { el, button, ago, money, problem, detailHead, metric, metrics, helpMark, saveFile, TASK_HELP } from "./console-dom.js";
import { exportRows } from "./api.js";
import { listTable, listRow, statusCell, heatRanks, heatCell } from "./console-list.js";
import { filterPicker, filterRow } from "./console-filters.js";
import { smartFilter, matchesPicks, framedBy } from "./console-facets.js";
import { compareView } from "./console-compare.js";
import { harnessView } from "./console-harness.js";
import { adoptionPanel } from "./console-adoption.js";
import { trendView, SPLITS } from "./console-trend.js";
import { frictionView } from "./console-friction.js";
import { whereFilter, whereChip, whereLabel } from "./console-where.js";
import { hasTasks, hasWorkspaces } from "./console-edition.js";

/** How far back the ranking looks; the server's ranges. */
export const RANGES = [
  { key: "24h", label: "24 hours" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
];

/**
 * The dropdown that picks a range. Always one of them - there is no
 * unfiltered here, "All time" on Search is itself a range - so it has no
 * All row and pressing the picked one leaves it alone.
 */
export function rangePicker(ranges, range, onRange, ...beside) {
  return filterRow(
    filterPicker({ label: "Range", entries: ranges, picked: range, onPick: onRange, all: null }),
    ...beside,
  );
}

/**
 * The files this page can be taken away as: the sessions and the pull
 * requests behind every figure on it, as CSV for a spreadsheet or JSON for
 * a script. Beside the range because the range is what a file holds - the
 * name of the file says which - and because a person who has just narrowed
 * to a month is the person who wants the month.
 *
 * Four buttons rather than a menu: a menu would be two presses for a thing
 * done in one, and four short words wrap onto two lines on a phone, which
 * is what the row does anyway. The download goes through the API client so
 * it carries the account's token (public/api.js `fetchFile`); a bare link
 * would 401 on prod, silently, as a saved file.
 */
export const EXPORTS = [
  { what: "sessions", format: "csv", label: "Sessions CSV" },
  { what: "sessions", format: "json", label: "Sessions JSON" },
  { what: "pulls", format: "csv", label: "Pulls CSV" },
  { what: "pulls", format: "json", label: "Pulls JSON" },
];

export function exportPicker(range) {
  const root = el("div", "filter-picker export-picker");
  root.append(el("span", "filter-picker-label", "Export"));
  const group = el("div", "export-buttons");
  const said = el("span", "export-said");
  said.setAttribute("role", "status");
  for (const entry of EXPORTS) {
    const press = button("ghost-btn export-btn", entry.label, async () => {
      press.disabled = true;
      said.textContent = "";
      said.classList.remove("is-problem");
      try {
        const { blob, name } = await exportRows(entry.what, entry.format, range);
        saveFile(blob, name);
        said.textContent = `Saved ${name}`;
      } catch (err) {
        // Said here rather than thrown away: a download that does nothing
        // is indistinguishable from a browser that blocked it.
        said.textContent = `Could not export - ${err.message}`;
        said.classList.add("is-problem");
      } finally {
        press.disabled = false;
      }
    });
    group.append(press);
  }
  root.append(group, said);
  return root;
}

/**
 * No filter: every session the range holds. `picks` are `facet:value`
 * strings (console-facets.js); `session` is the words in the box beside
 * the table, which searches an ask and an id rather than a facet.
 */
export const NO_FILTERS = Object.freeze({ picks: [], session: "" });

const percent = (rate) => (rate == null ? "—" : `${Math.round(rate * 100)}%`);
const one = (n) => (n == null ? "—" : Number.isInteger(n) ? String(n) : n.toFixed(1));

// ---- pull-cost ----
//
// The cost panel's fixed parts, at module scope and not inside
// `performanceView`. They were inside it, above the function that reads
// them and below the call that runs it, which is a `const` in its own
// temporal dead zone: the whole page threw on first paint and drew
// nothing. A `function` hoists and a `const` does not, and the difference
// is invisible until it is a blank page.

/** What each phase of a pull request's life is, for the "?" beside the bar. */
const PHASE_HELP =
  "Before is everything spent up to the moment the pull request asked for a person - " +
  "planning, writing it and the agent's own testing, together, because nothing in the " +
  "log says which of the three an agent was in at the time. Review is from there to the " +
  "merge or the close: what answering the review cost. After is anything the same " +
  "sessions spent once it was over.";

const KIND_HELP =
  "What kind of change it was: the task record's own word where there is one, a linked " +
  "Linear issue's labels where there is one, and otherwise read off the title and the " +
  "branch - which is a heuristic. 'Handle the empty case' is a fix and will be counted " +
  "as unknown; a feature called 'Fix up the settings page' will be counted as a fix.";

/** One phase of the bar, sized by its share, or nothing when it took none of the money. */
function phaseBand(name, label, share, cents) {
  if (!share) return null;
  const band = el("div", `phase-band phase-${name}`);
  band.style.flexGrow = String(Math.max(share, 0.001));
  band.title = `${label}: ${money(cents) ?? "—"} · ${Math.round(share * 100)}%`;
  // The share goes inside the band where it fits and into the legend
  // always, because a band four per cent wide fits nothing - and on a
  // phone the 860px block takes it out of every band (console.css).
  band.append(el("span", "phase-band-share", `${Math.round(share * 100)}%`));
  return band;
}
// ---- end pull-cost ----

/** A row's name: its first ask when the viewer may read it, else who was working. */
const nameOf = (row) => row.title || row.actor?.name || row.name || row.key;
const harnessOf = (row) => row.harness?.kindLabel ?? row.harness?.kind ?? null;

/**
 * The rows the filters leave. The picks are exact and come from the one box
 * at the top (console-facets.js `matchesPicks`: alternatives within a facet,
 * conditions across them); the session words are words, matched against the
 * row's name, who worked and the id, so "nomad" finds Nomad's sessions and
 * "ses_01" finds one.
 */
export function applyFilters(rows, filters = NO_FILTERS) {
  const words = (filters.session ?? "").trim().toLowerCase();
  return rows.filter((row) => {
    if (!matchesPicks(row, filters.picks ?? [])) return false;
    if (words) {
      // The repository too: a session in one nobody connected here is named
      // after whoever was working (the words rule withholds its ask from
      // everyone but them), so the repository is the only thing on the row
      // a reader can search it by.
      const haystack = [nameOf(row), row.actor?.name, harnessOf(row), row.repository, row.key].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(words)) return false;
    }
    return true;
  });
}

/**
 * A dropdown for one facet, with "All" first; pressing the picked one is
 * pressing All. Activity borrows it for its repo filter, so the two pages
 * narrow the same way.
 *
 * This is the filter that most wanted to stop being chips: an executor
 * list is one row per agent anybody has run and a repo list one per
 * repository the team has touched, and neither has a ceiling.
 */
export function facetPicker(label, entries, picked, onPick) {
  return filterPicker({ label, entries, picked, onPick, find: `Type to find a ${label.toLowerCase()}` });
}

/**
 * The page.
 *
 * The filters are the caller's state, so a redraw from elsewhere keeps
 * them; but a change to one redraws only the tiles and the table here,
 * because a full redraw would take the search box - and the caret in it -
 * out from under the person typing.
 *
 * @param {object} args
 * @param {string} args.range one of RANGES
 * @param {{executor: string|null, harness: string|null, session: string}} args.filters
 * @param {object|null} args.data what /api/performance said, by session
 * @param {string|null} args.failed
 * @param {object|null} args.compare what /api/performance/compare said
 * @param {string|null} args.compareFailed
 * @param {object|null} args.harness what /api/performance/harness said
 * @param {string|null} args.harnessFailed
 * @param {{dimension: string, table: boolean}} args.compareState which charts the comparison shows
 * @param {(state: object) => void} args.onCompareState told the new state; must not redraw
 * @param {(filters: object) => void} args.onFilter told the new filters; must not redraw
 * @param {(range: string) => void} args.onRange
 * @param {() => void} args.onReread the Include filter changed; read the range again
 * @param {(path: string) => void} args.onOpen
 * @param {(page: string, id?: string) => string} args.pathFor
 */
export function performanceView({ range, filters = NO_FILTERS, data, failed, compare = null, compareFailed = null, compareState, onCompareState = () => {}, trendState, onTrendState = () => {}, friction = null, frictionFailed = null, frictionState = { by: "repo" }, onFrictionState = () => {}, harness = null, harnessFailed = null, adoption = null, adoptionFailed = null, onFilter, onRange, onReread = () => {}, onOpen, pathFor }) {
  const pane = el("div", "detail detail-wide");
  pane.append(
    detailHead(
      "Performance",
      el(
        "p",
        "detail-summary",
        hasTasks()
          ? "What the work was done with and what came of it: which model provider, harness, sandbox and person finish tasks, at what cost. Then every session in the range, ranked."
          : "What the work was done with and what came of it: which model provider and harness the sessions ran on, how much steering each took and what it cost. Then every session in the range, ranked.",
      ),
    ),
  );
  // The one filter, first, because it is the first question - "how did the
  // thing I use do?" - and because it reframes everything under it. Filled
  // once the rows are here, since its options are the rows'.
  const scope = el("div", "perf-scope");
  pane.append(scope);
  pane.append(rangePicker(RANGES, range, onRange, exportPicker(range)));
  // Beside the range, what counts as this workspace's work: its own repos,
  // and - pressed for - repositories nobody connected here and work in no
  // repository (console-where.js). It sits above the read, not inside it,
  // because it scopes everything below it the way the range does: the
  // comparison, the trend and the ranking are all one answer, and the
  // press has to stay on screen while that answer is read again.
  pane.append(filterRow(whereFilter(onReread)));

  let current = { ...NO_FILTERS, ...filters };

  // The comparison and the trend live in slots rather than being appended
  // outright, because a pick reframes them: they are drawn again, around
  // the picked thing's own dimension.
  const yieldPane = el("div", "perf-yield-slot");
  // ---- pull-cost ----
  const costPane = el("div", "perf-cost-slot");
  // ---- end pull-cost ----
  const comparePane = el("div", "perf-compare");
  const trendPane = el("div", "perf-trend");
  // Yield first: "of everything run in this range, what came of it" is the
  // question a person opens this page with, and it is the only panel here
  // that counts the sessions which took nothing on at all.
  // Then what a change costs, which is the same range priced (pull-cost.js).
  pane.append(yieldPane, costPane, comparePane, trendPane);

  // Harness changes, under the trend and above the ranking: it is about the
  // range the way the panels above it are, but it is the only one that asks
  // whether something a person *did* to the repository worked. Appended in
  // its own block, and drawn by its own module, because the pane above is
  // being added to from three directions at once.
  const harnessPane = harnessView({ data: harness, failed: harnessFailed });
  if (harnessPane) pane.append(harnessPane);

  // Who has taken this up. After the harness changes and before the
  // ranking: the panels above are about the work, this one is about the
  // people doing it, and the table below is neither.
  //
  // Where there are no workspaces there is no team to place: the ladder
  // ranked the one account on the machine against itself, under a heading
  // that said the range had nobody in it (console-edition.js).
  if (hasWorkspaces()) pane.append(adoptionPanel({ data: adoption, failed: adoptionFailed }));

  /**
   * Draw the two panels for the picks as they stand.
   *
   * The dimension a pick implies is handed down but never sent back through
   * `onCompareState`, so it is a frame and not a choice: take the pick off
   * and the charts return to whichever dimension the reader had picked for
   * themselves.
   */
  function frame() {
    const picks = current.picks ?? [];
    const framed = framedBy(picks);
    const split = framedBy(picks, SPLITS.map((entry) => entry.key));
    yieldPane.replaceChildren(...[yieldTiles()].filter(Boolean));
    // ---- pull-cost ----
    costPane.replaceChildren(...[costTiles()].filter(Boolean));
    // ---- end pull-cost ----
    comparePane.replaceChildren(
      compareView({
        data: compare,
        failed: compareFailed,
        state: framed ? { ...compareState, dimension: framed.dimension } : compareState,
        onState: onCompareState,
        highlight: framed,
      }),
    );
    trendPane.replaceChildren(
      trendView({
        data: compare,
        failed: compareFailed,
        state: split ? { ...trendState, split: split.dimension } : trendState,
        onState: onTrendState,
      }),
    );
  }
  frame();
  // Then what got in the way, over the same range (console-friction.js).
  // It sits under the charts and above the ranking because it is the third
  // question of the three this page answers - what worked best, what it
  // came to over time, and what kept going wrong - and because its rows are
  // repositories and weeks rather than sessions, so it does not belong
  // inside the table's own filter. That the pick above does not narrow it
  // is said in its caveat.
  pane.append(
    frictionView({
      data: friction,
      failed: frictionFailed,
      state: frictionState,
      onState: onFrictionState,
      onOpen,
      pathFor,
    }),
  );
  pane.append(el("h3", "panel-heading perf-ranking-heading", "Every session"));

  if (failed) {
    pane.append(problem(`Could not read the ranking - ${failed}`));
    return pane;
  }
  if (!data) {
    pane.append(el("p", "console-hint", "Reading…"));
    return pane;
  }

  const rows = data.rows ?? [];
  if (!rows.length) {
    pane.append(
      el(
        "p",
        "console-hint",
        hasTasks()
          ? "Nothing to rank yet. Rows appear as sessions run and the tasks they take are finished."
          : "Nothing to rank yet. A row appears for each session, once one has run on a machine that reports here.",
      ),
    );
    return pane;
  }

  // Beside the table, the one thing the box at the top cannot offer: words
  // that are not the name of anything - part of an ask, a session id. The
  // box is not redrawn with the results, so the caret stays put.
  const tools = el("div", "list-tools perf-filters");
  const search = el("input", "list-search");
  search.type = "search";
  search.placeholder = "Find a session - by its ask, who worked, or its id";
  search.setAttribute("aria-label", "Find a session");
  search.value = current.session ?? "";
  tools.append(search);
  pane.append(tools);

  const results = el("div", "perf-results");
  pane.append(results);

  const set = (patch) => {
    current = { ...current, ...patch };
    onFilter(current);
    redraw();
  };
  search.addEventListener("input", () => set({ session: search.value }));

  function redraw() {
    // The filter is redrawn so the picks show on it, and the panels above
    // are redrawn around them: picking Niteshift turns the charts into a
    // comparison of places to run with Niteshift lit, and the table below
    // into Niteshift's own sessions.
    scope.replaceChildren(
      filterRow(smartFilter({ rows, picks: current.picks ?? [], onPicks: (picks) => set({ picks }) })),
    );
    frame();
    results.replaceChildren(...resultsOf(applyFilters(rows, current)));
  }

  /**
   * The tasks tile and the tasks column head, each with the "?" that says
   * what a task is. The word carries the whole meaning of the page and is
   * two syllables wide, so the explanation cannot live beside it as text.
   */
  function tasksMetric(finished, taken) {
    const tile = metric(finished, "tasks finished", taken ? `of ${taken} taken` : "no task taken");
    tile.querySelector(".metric-label")?.append(helpMark("a task", TASK_HELP));
    return tile;
  }

  function tasksHead() {
    const head = el("span", "help-head");
    head.append("Tasks done", helpMark("a task", TASK_HELP));
    return head;
  }

  /**
   * What the range came to, over every session in it - the ones with no
   * task and no pull request included, which the ranking below cannot
   * show and which is where a good deal of the money goes
   * (server/performance.js, the yield essay).
   *
   * It reads the comparison's answer rather than the ranking's, because
   * yield is a fact about whole sessions and the ranking is grouped. So it
   * is drawn only once that answer is here, and it is never narrowed by
   * the filters: the tiles below are the shown rows, these are the range.
   */
  function yieldTiles() {
    const counted = compare?.yield;
    if (!counted) return null;
    const landed = counted.shipped + counted.merged + counted.reworked;
    const wasted = counted.closed + counted.discarded + counted.reverted;
    const spend = compare.spend ?? 0;
    const waste = compare.waste ?? 0;
    const kept = compare.aftermath?.kept ?? null;
    // An edition with no tasks and no git host connected yet has nothing
    // for this to count, and "0 landed · 0 shipped · 0 reverted" is not a
    // finding - it is a heading over nothing, six tiles wide, at the top of
    // the page. It comes back the moment a pull request does
    // (console-edition.js).
    if (!hasTasks() && !landed && !wasted && !waste) return null;
    const panel = el("section", "console-panel perf-yield");
    panel.append(el("h3", "panel-heading", "What the range came to"));
    panel.append(
      metrics(
        metric(landed, "landed", `of ${compare.sessions ?? 0} sessions`),
        metric(counted.shipped, "shipped", "merged and deployed"),
        metric(counted.reverted, "reverted", "taken back out, or it broke the build"),
        metric(wasted, "bought nothing", `${counted.closed} closed · ${counted.discarded} discarded`),
        metric(money(waste) ?? "—", "spent on work that never landed", spend > 0 ? `${Math.round((waste / spend) * 100)}% of the range's spend` : null),
        metric(kept == null ? "—" : percent(kept), "kept after 30 days", compare.aftermath?.measured ? `over ${compare.aftermath.measured} measured` : "nothing old enough yet"),
      ),
    );
    return panel;
  }

  // ---- pull-cost ----

  /**
   * What a change costs here (server/pull-cost.js): the middle merged pull
   * request, what each kind of work costs, and which phase of a pull
   * request's life the money goes in.
   *
   * Read off the comparison's answer, like the yield panel above it, and
   * never narrowed by the filters for the same reason: these are the range,
   * the table below is the shown rows. Drawn only where something could be
   * priced - with no rate configured this is a row of dashes and the page
   * is better off without it (costs.js on why nothing invents a rate).
   */
  function costTiles() {
    const cost = compare?.cost;
    if (!cost || !cost.perMerged?.n) return null;
    const per = cost.perMerged;
    const kinds = cost.perKind ?? {};
    const phases = cost.phases ?? {};
    const panel = el("section", "console-panel perf-cost");
    const heading = el("h3", "panel-heading", "What a change costs here");
    heading.append(helpMark("a kind of work", KIND_HELP));
    panel.append(heading);

    const kindTile = (key, label) => {
      const row = kinds[key];
      return metric(
        row?.centsPerMerged != null ? money(row.centsPerMerged) : "—",
        `per ${label} merged`,
        row?.pricedMerged ? `over ${row.pricedMerged} of ${row.merged}` : "none priced yet",
      );
    };

    panel.append(
      metrics(
        metric(money(per.cents.median) ?? "—", "the middle merged change", `over ${per.n} of ${per.merged} priced`),
        metric(money(per.cents.mean) ?? "—", "the average one", per.cents.mean > per.cents.median ? "pulled up by a few big ones" : "close to the middle"),
        kindTile("fix", "fix"),
        kindTile("feature", "feature"),
      ),
    );

    if (phases.n) {
      const bar = el("div", "phase-bar");
      const legend = el("div", "phase-legend");
      for (const [name, label] of [["before", "Before review"], ["review", "Review"], ["after", "After"]]) {
        const band = phaseBand(name, label, phases.shares?.[name], phases[name]?.cents);
        if (band) bar.append(band);
        const entry = el("div", "phase-legend-entry");
        entry.append(el("span", `phase-swatch phase-${name}`));
        entry.append(el("span", "phase-legend-label", label));
        entry.append(el("span", "phase-legend-value", money(phases[name]?.cents) ?? "—"));
        legend.append(entry);
      }
      const where = el("div", "phase-where");
      const title = el("div", "phase-where-head", "Where the money goes");
      title.append(helpMark("a phase", PHASE_HELP));
      where.append(title, bar, legend);
      panel.append(where);
    }

    const waste = cost.waste ?? null;
    const caveats = [
      `Over the ${phases.n ?? 0} merged pull requests in the range whose sessions' spans are still held - a pull request older than thirty days has no split, and is left out rather than counted at nought.`,
      waste?.cents
        ? `Of the range's spend, ${money(waste.cents)} went on work that never landed - the same money the panel above counts, here added up through the pull requests' own phases.`
        : null,
      "A session that worked on two pull requests is charged to both in full, so these are right per change and an upper bound when added together.",
    ].filter(Boolean);
    for (const line of caveats) panel.append(el("p", "console-caveat", line));
    return panel;
  }

  // ---- end pull-cost ----

  function resultsOf(shown) {
    const finished = shown.reduce((sum, row) => sum + row.finished, 0);
    const taken = shown.reduce((sum, row) => sum + row.tasks, 0);
    const effective = shown.filter((row) => row.effective).length;
    const cost = shown.reduce((sum, row) => sum + (row.cost ?? 0), 0);
    const steers = shown.reduce((sum, row) => sum + (row.steers ?? 0), 0);
    const watched = shown.some((row) => row.steeringVisible !== false);
    // Whether anything on this page had its steering counted at all - see
    // the tile below on why a total of uncounted noughts is not a total.
    const counted = shown.some((row) => row.steeringKnown !== false);
    const oneShot = shown.reduce((sum, row) => sum + (row.oneShot ?? 0), 0);
    // The finished tasks the first-time share can actually be read off:
    // ones whose session had its steering counted. A record from before
    // the counter has nought steers because nothing counted, and dividing
    // by it made every old session read as a perfect first-time finish.
    const oneShotKnown = shown.reduce((sum, row) => sum + (row.oneShotKnown ?? 0), 0);
    const narrowed = shown.length !== rows.length;
    // The sessions tile leads in every edition. What stands beside it does
    // not: where work is handed out as tasks, the headline is how many
    // finished, how many landed first time and how many rows beat the
    // median - and where none is handed out (console-edition.js) those four
    // can only ever read 0 or "—", which is a row of tiles saying the page
    // is broken. Then the headline is the two figures a laptop does have:
    // what the steering came to, and what it cost.
    const sessionsTile = metric(shown.length, narrowed ? "sessions shown" : "sessions", narrowed ? `of ${rows.length} in the range` : null);
    // Nought steers over rows nobody could watch would be the table
    // claiming they were never steered; the tile says the same thing
    // the cells do - and the same again for rows nobody counted, where
    // the total is a sum of noughts that were never added up.
    const steersTile = metric(
      !watched ? "—" : counted ? steers : "not measured",
      "steers",
      !watched
        ? "steering not visible for these"
        : counted
          ? "follow-ups, cuts short, review rounds, retries"
          : "no session here counted the steering it took",
    );
    const out = [
      hasTasks()
        ? metrics(
          sessionsTile,
          tasksMetric(finished, taken),
          // The one figure that says whether the tool is getting better
          // rather than whether the people around it are working harder.
          metric(
            oneShotKnown ? percent(oneShot / oneShotKnown) : finished ? "not measured" : "—",
            "finished first time",
            oneShotKnown
              ? `${oneShot} of ${oneShotKnown}, with nobody coming back`
              : finished
                ? "no session here counted the steering it took, so this cannot be read"
                : "nothing finished yet",
          ),
          steersTile,
          metric(percent(data.medianRate), "median rate", "the bar for effective, across everything"),
          metric(effective, "effective", `of ${shown.length} sessions`),
          metric(money(cost) ?? "—", "spent", taken ? `${money(cost / taken) ?? "—"} per task` : null),
        )
        // No "per task" under the spend either: there are no tasks to
        // divide it by, and `taken` is nought, so the note the full
        // console carries is left off rather than read as free.
        : metrics(sessionsTile, steersTile, metric(money(cost) ?? "—", "spent", null)),
    ];

    if (!shown.length) {
      out.push(el("p", "console-hint", "No session matches these filters."));
      return out;
    }

    // "Lines" was read as lines of code by everybody who did not write it -
    // it meant lines a person said to the agent, which is a different
    // quantity by three orders of magnitude and the opposite sign. It is
    // Steering now, and it counts everything after the first ask rather
    // than the lines alone. Beside it, the share of the work that landed
    // with nobody coming back to it.
    // Four of these columns are readings of tasks - what was finished, at
    // what rate, over how many rounds, how much of it first time - and
    // where no task is ever handed out (console-edition.js) they are four
    // columns of "—" with the first one, the widest and the one the page is
    // sorted by, at the head. What is left is every column that counts a
    // session or a diff, which is what that edition has.
    const table = listTable({
      head: hasTasks()
        ? ["Session", tasksHead(), "Rate", "Rounds", "Steering", "First time", "Kept in review", "Undone after", "Kept 30d", "Cost"]
        : ["Session", "Steering", "Kept in review", "Undone after", "Kept 30d", "Cost"],
    });
    table.classList.add("perf-table");
    // Each of the four numbers is shaded against the rest of its own
    // column - green where a row is doing well on it, red where it is not
    // - and against the rows on screen, not the rows the filters took
    // away, because what the reader is comparing is what they can see. A
    // rate is better high; steering and money are better low. The tasks
    // cell is left alone: it is already a chip that says whether the
    // session was effective, and two colours on one fact is one too many.
    const heat = {
      rate: heatRanks(shown.map((row) => row.rate), "high"),
      rounds: heatRanks(shown.map((row) => row.rounds), "low"),
      // A row nobody could watch, and a row nobody counted, are both out
      // of the shading: a total of noughts is the lowest number in the
      // column, and shaded green it would be the table calling an
      // unmeasured row the best-behaved one on the page.
      steers: heatRanks(shown.map((row) => (row.steeringVisible === false || row.steeringKnown === false ? null : row.steers)), "low"),
      oneShot: heatRanks(shown.map((row) => row.oneShotRate), "high"),
      // Of the lines this row wrote, the share still in the diff that
      // merged. A row nobody could measure - a harness whose hooks carry
      // no tool input - is left out of the shading rather than shaded as
      // the worst on the page.
      acceptance: heatRanks(shown.map((row) => row.acceptance), "high"),
      // Of what a row landed, the share that came apart afterwards - low
      // is good - and the share of its added lines still there a month
      // later, which is high. A row that landed nothing has no failure
      // rate, and a dash shaded green would read as a perfect record.
      undoneAfter: heatRanks(shown.map((row) => (row.landed ? row.failureRate : null)), "low"),
      kept: heatRanks(shown.map((row) => row.kept), "high"),
      // `|| null` and not `?? null`: a session that spent nought shows a
      // dash, and a dash shaded green as the cheapest row on the page
      // would be the table saying it beat the ones that spent money.
      cost: heatRanks(shown.map((row) => row.cost || null), "low"),
    };
    shown.forEach((row, at) => {
      const path = pathFor("activity", row.key);
      // A session in a repository nobody connected here says so on its
      // row, and says it again in the aside - the phone drops every cell
      // but the kept one, so a chip in a cell would vanish there.
      const mark = whereChip(row.where);
      const name = el("span", "perf-row-name");
      name.append(el("span", "perf-row-title", nameOf(row)));
      if (mark) name.append(mark);
      const line = listRow({
        name,
        note: [row.title ? row.actor?.name : null, harnessOf(row), row.lastAt ? `active ${ago(row.lastAt)}` : null].filter(Boolean).join(" · "),
        aside: [row.repository, whereLabel(row.where)].filter(Boolean).join(" · ") || null,
        live: row.live > 0,
        cells: [
          ...(hasTasks()
            ? [
              statusCell(`${row.finished} done`, row.effective ? "chip-ok" : row.tasks ? "" : "chip-none"),
              heatCell(percent(row.rate), heat.rate[at]),
              heatCell(one(row.rounds), heat.rounds[at]),
            ]
            : []),
          // A row nobody could watch being steered says so rather than
          // showing a nought that reads as "never needed a word" - and so
          // does one whose steering was never counted, which is the same
          // nought arrived at by a different road. "Not visible" is the
          // chip a phone keeps, because an unwatched agent is a fact about
          // the row; "not measured" is a plain cell the phone drops with
          // the rest, since the tile above already carries the total.
          row.steeringVisible === false
            ? statusCell("not visible", "chip-none")
            : row.steeringKnown === false
              ? el("span", "chip chip-none", "not measured")
              : heatCell(one(row.steers), heat.steers[at]),
          // Nought steers on a session nobody counted is not a first-time
          // finish, so the cell says "not measured" rather than showing a
          // hundred per cent. The same chip the column beside it draws -
          // but a plain cell, not a `statusCell`: a phone keeps every
          // `keep` cell and its table has room for the name and one fact,
          // so a third kept chip pushes the row onto a second line of the
          // grid and takes the name off the screen. On a phone this column
          // goes the way Rate, Rounds and Steering go, and the tile above
          // still says the figure is not measured.
          ...(hasTasks()
            ? [row.finished && !row.oneShotKnown ? el("span", "chip chip-none", "not measured") : heatCell(percent(row.oneShotRate), heat.oneShot[at])]
            : []),
          // Nought lines and "we could not count them" are different
          // facts, and the second is the common one: a Codex session's
          // hooks carry no tool input at all.
          row.linesMeasured ? heatCell(percent(row.acceptance), heat.acceptance[at]) : statusCell("not measured", "chip-none"),
          heatCell(row.landed ? `${row.undoneAfter} of ${row.landed}` : "—", heat.undoneAfter[at]),
          heatCell(percent(row.kept), heat.kept[at]),
          // Cost is the cell a phone keeps where the tasks chip is not there
          // to be it. That is not a nicety: `.list-row` is `display:
          // contents` and the phone grid is two columns (console.css), so a
          // row with no kept cell contributes one item and the row after it
          // fills the second column - two sessions on one line, each with
          // half a name. One kept cell a row, always, and money is the fact
          // worth keeping.
          hasTasks()
            ? heatCell(row.cost ? money(row.cost) : "—", heat.cost[at])
            : { keep: true, node: heatCell(row.cost ? money(row.cost) : "—", heat.cost[at]) },
        ],
        onOpen: () => onOpen(path),
      });
      if (row.effective) line.classList.add("effective");
      table.append(line);
    });
    out.push(table);

    const caveats = [
      hasTasks()
        ? "Score = tasks finished, minus a bounded penalty for the steering each took; ones still going count a little, less every day. Steering is everything after the first ask - a follow-up, a turn cut short, a round of review, a retried task; First time is the share of the finished tasks that took none of it."
        // No tasks here, so no score to explain and no first-time share to
        // read off one: what orders the table is what is left of it.
        : "Steering is everything after the first ask - a follow-up, a turn cut short, a round of review. Rows are ordered by what their sessions got done and how much steering that took.",
      shown.some((row) => row.steeringVisible === false)
        ? "A session run by an outside service is prompted where we cannot see it, so its steering reads \"not visible\" rather than nought."
        : null,
      shown.some((row) => row.steeringKnown === false || (row.finished && !row.oneShotKnown))
        ? hasTasks()
          ? "A session recorded before this app counted turns has no steering count at all, so Steering and First time read \"not measured\" for it - a nought nobody counted is not a nought."
          : "A session recorded before this app counted turns has no steering count at all, so Steering reads \"not measured\" for it - a nought nobody counted is not a nought."
        : null,
      "Kept in review is, of the lines a row's sessions wrote, how many were in the diff that merged - matched line by line, so a line a person rewrote is not the agent's. Undone after is, of the pull requests a row landed, how many were reverted, broke the build or had a fix come back within a month. Kept 30d is how much of a merge's added lines are still in the file thirty days on - see docs/measures.md.",
      shown.some((row) => !row.linesMeasured)
        ? "A harness whose hooks send no tool input - Codex's do not - writes lines nothing here can count, so its row reads \"not measured\" rather than nought."
        : null,
      shown.some((row) => row.linesPredate > 0)
        ? "Some of these sessions were recorded before lines were counted here at all; that is the age of the record rather than anything about the harness, and it reads \"not measured\" too."
        : null,
      "Green to red is where a row stands against the others on this page for that column, by rank - not a mark out of ten, and it moves when a filter does.",
      data.priced === false ? "No model on this installation is priced, so cost is not part of the ranking." : null,
    ].filter(Boolean);
    out.push(el("p", "console-caveat", caveats.join(" ")));
    return out;
  }

  redraw();
  return pane;
}
