// The Performance page, wired up: what it reads, and what it hands the view.
//
// The drawing is console-performance.js; this is the half that used to sit
// in console.js - the five reads of one range, and the handful of callbacks
// that decide whether a press is a re-read or only a redraw. It is here so
// that a shell with a different set of pages can have this one without
// having the other ten (shell.js).
//
// `state.performance` stays the entry's, handed in: there is one state
// object for the whole console and a page module that kept its own would be
// a second place for the range to live.
import { performanceView } from "./console-performance.js";
import { hasWorkspaces } from "./console-edition.js";

/**
 * @param {object} ctx
 * @param {object} ctx.state the console's one state object
 * @param {object} ctx.api
 * @param {() => void} ctx.render
 * @param {(path: string) => void} ctx.go
 * @param {(page: string, id?: string) => string} ctx.pathFor
 */
export function performancePage({ state, api, render, go, pathFor }) {
  let loading = null;

  /** Whether the ranking is what is on screen. */
  const wants = () => state.page === "performance";

  function load() {
    if (loading) return loading;
    const { range } = state.performance;
    // Five reads, one range, each landing on its own: a comparison that could
    // not be read is a line on its panel, not a ranking that never appears.
    const ranking = api
      .performance(range, "sessions")
      .then(
        (data) => {
          if (state.performance.range === range) state.performance = { ...state.performance, data, failed: null };
        },
        (err) => {
          if (state.performance.range === range) state.performance = { ...state.performance, data: null, failed: err.message };
        },
      );
    const comparison = api
      .performanceCompare(range)
      .then(
        (compare) => {
          if (state.performance.range === range) state.performance = { ...state.performance, compare, compareFailed: null };
        },
        (err) => {
          if (state.performance.range === range) state.performance = { ...state.performance, compare: null, compareFailed: err.message };
        },
      );
    // And what got in the way over the same range - all three folds of it,
    // so the panel's own switch needs no request of its own.
    const rubbing = api
      .performanceFriction(range, state.performance.frictionState?.by ?? "repo")
      .then(
        (friction) => {
          if (state.performance.range === range) state.performance = { ...state.performance, friction, frictionFailed: null };
        },
        (err) => {
          if (state.performance.range === range) state.performance = { ...state.performance, friction: null, frictionFailed: err.message };
        },
      );
    // And the harness changes: another read of the same range, landing on its
    // own the way the comparison does. It is the one panel that may simply
    // not be there - a range with no CLAUDE.md commit in it draws nothing -
    // so a failure here must not take the ranking with it.
    const harness = api
      .performanceHarness(range)
      .then(
        (data) => {
          if (state.performance.range === range) state.performance = { ...state.performance, harness: data, harnessFailed: null };
        },
        (err) => {
          if (state.performance.range === range) state.performance = { ...state.performance, harness: null, harnessFailed: err.message };
        },
      );
    // And adoption: who here works with an agent, over the same range. The
    // fifth read, on its own like the others - a panel that could not be
    // read is a line on that panel. Not read at all where there are no
    // workspaces (console-edition.js): the panel is not drawn there, and a
    // read whose answer nothing looks at is a request a laptop pays for
    // every time the page is opened.
    const adopting = !hasWorkspaces()
      ? Promise.resolve()
      : api.performanceAdoption(range).then(
        (data) => {
          if (state.performance.range === range) state.performance = { ...state.performance, adoption: data, adoptionFailed: null };
        },
        (err) => {
          if (state.performance.range === range) state.performance = { ...state.performance, adoption: null, adoptionFailed: err.message };
        },
      );
    loading = Promise.all([ranking, comparison, rubbing, harness, adopting])
      .finally(() => {
        loading = null;
      });
    return loading;
  }

  /** Every session, filtered here. `/performance/agents` and the other old tab addresses still open the page; the tail is ignored. */
  function view() {
    return performanceView({
      range: state.performance.range,
      filters: state.performance.filters,
      data: state.performance.data,
      failed: state.performance.failed,
      compare: state.performance.compare,
      compareFailed: state.performance.compareFailed,
      harness: state.performance.harness,
      harnessFailed: state.performance.harnessFailed,
      adoption: state.performance.adoption,
      adoptionFailed: state.performance.adoptionFailed,
      compareState: state.performance.compareState,
      trendState: state.performance.trendState,
      friction: state.performance.friction,
      frictionFailed: state.performance.frictionFailed,
      frictionState: state.performance.frictionState,
      // The view redraws its own table; this only keeps the filters so
      // the next full redraw - a refresh - draws them pressed. The
      // comparison's dimension and the trend's metric the same way.
      onFilter: (filters) => {
        state.performance = { ...state.performance, filters };
      },
      onCompareState: (compareState) => {
        state.performance = { ...state.performance, compareState };
      },
      onTrendState: (trendState) => {
        state.performance = { ...state.performance, trendState };
      },
      // The friction panel redraws its own body when the fold changes;
      // this only keeps which fold, so a refresh comes back on it.
      onFrictionState: (frictionState) => {
        state.performance = { ...state.performance, frictionState };
      },
      onRange: (range) => {
        state.performance = { ...state.performance, range, data: null, failed: null, compare: null, compareFailed: null, friction: null, frictionFailed: null, harness: null, harnessFailed: null, adoption: null, adoptionFailed: null };
        render();
      },
      // The Include filter changed which work counts (console-where.js),
      // and that is the server's answer, not something the table can
      // filter its way to - so the range's own read is done again.
      onReread: () => {
        state.performance = { ...state.performance, data: null, failed: null, compare: null, compareFailed: null, friction: null, frictionFailed: null, harness: null, harnessFailed: null, adoption: null, adoptionFailed: null };
        render();
      },
      onOpen: go,
      pathFor,
    });
  }

  return {
    wants,
    load,
    view,
    /** Read on arrival, and again after a failure has been cleared. */
    read: () => (wants() && state.performance.data === null && !state.performance.failed ? load() : null),
    /** And again whenever something moved, while it is the page on screen. */
    reread: () => (wants() ? load() : null),
  };
}
