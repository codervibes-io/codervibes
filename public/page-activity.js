// The Activity page, wired up: the read, the clock, and what it hands the
// view.
//
// The drawing is console-home.js; this is what used to sit in console.js.
// Both consoles hang it: the hosted one with the Needs action card handed
// in (console-waiting.js), the local edition (local.js) without, since a
// laptop hands out no tasks and merges nothing - and the page is the same
// page either way, which is the whole point of it being a module.
import { activityView } from "./console-home.js";

/**
 * @param {object} ctx
 * @param {object} ctx.state the console's one state object
 * @param {object} ctx.api
 * @param {() => void} ctx.render
 * @param {(path: string) => void} ctx.go
 * @param {(page: string, id?: string) => string} ctx.pathFor
 * @param {object} [opts]
 * @param {((task: object, ctx: object) => HTMLElement)|null} [opts.waitingCard]
 *   how a Needs action row is drawn, or nothing, on a console with nothing
 *   to wait on.
 */
export function activityPage({ state, api, render, go, pathFor }, { waitingCard = null } = {}) {
  let loading = null;

  /** Whether the page on screen is Activity itself - not one session under it. */
  const wants = () => state.page === "activity" && !state.selected;

  /** The page's read (/api/home, named when it was Home). One in flight at a time. */
  function load() {
    if (loading) return loading;
    loading = api
      .home()
      .then(
        (data) => {
          state.activity = { data, failed: null };
        },
        (err) => {
          state.activity = { data: null, failed: err.message };
        },
      )
      .finally(() => {
        loading = null;
      });
    return loading;
  }

  /** On arrival: read once, unless it was read already. */
  const read = () => (wants() && state.activity.data === null && !state.activity.failed ? load() : null);

  /** On every refresh while open: a session ends and a pull request merges without this page being told separately. */
  const reread = () => (wants() ? load() : null);

  /**
   * On a clock as well as on events. The stream carries what concerns this
   * person, and a session somebody else's agent is running raises no event
   * here; and even one's own live card says "started 3m ago", which is
   * wrong after four. Called by the entry's half-minute tick.
   */
  const tick = () => (wants() ? load().then(render) : null);

  function draw(pane) {
    pane.append(
      activityView({
        data: state.activity.data,
        failed: state.activity.failed,
        // Who is reading, and who their team is: the page opens on their
        // own work and narrows by the open workspace's members.
        session: state.session,
        onOpen: go,
        pathFor,
        onChanged: () => load().then(render),
        waitingCard,
      }),
    );
  }

  return { wants, load, read, reread, tick, draw };
}
