// One session's page, wired up: the read, and what it hands the view.
//
// The drawing is console-session.js; this is what used to sit in
// console.js. A session is what a search result and an executor's list of
// work open onto, so any console with either of those has to have this
// page - which is why it is not part of the Activity page's module even
// though `/activity/<session>` is its address.
import { sessionView } from "./console-session.js";

/** How much of a session's log the page keeps; a long session is read from the store, not held whole. */
const TRANSCRIPT_KEEP = 1000;

/**
 * @param {object} ctx
 * @param {object} ctx.state the console's one state object
 * @param {object} ctx.api
 * @param {() => void} ctx.render
 * @param {(path: string) => void} ctx.go
 * @param {(page: string, id?: string) => string} ctx.pathFor
 * @param {object} [opts]
 * @param {((live: object|null, opts: {steer: boolean}) => Node|null)|null}
 *   [opts.talk] the box you type into - console-home.js `sessionTalk` for
 *   the full console, nothing for a shell without a chat
 */
export function sessionPage({ state, api, render, go, pathFor }, { talk = null } = {}) {
  let loading = null;

  /** Whether one session is what the address names. */
  const wants = () => state.page === "activity" && Boolean(state.selected);

  /**
   * One session, by the address's id: the session, and its log from where
   * the last read of the same session stopped. The two are read together
   * because they are drawn together, and a nudge that a line landed
   * (`session.event`) refreshes both.
   */
  function load() {
    if (loading) return loading;
    const id = state.selected;
    const since = state.transcript.id === id ? state.transcript.next : 0;
    loading = Promise.all([
      api.sessionDetail(id).then(
        (data) => {
          if (state.selected === id) state.sessionDetail = { id, data, failed: null };
        },
        (err) => {
          if (state.selected === id) state.sessionDetail = { id, data: null, failed: err.message };
        },
      ),
      api.sessionEvents(id, since).then(
        ({ events = [], next = since, turn = null }) => {
          if (state.selected !== id) return;
          const kept = state.transcript.id === id ? state.transcript.events : [];
          // Only what is new: the server answers from `since` exclusive, but a
          // read that raced another must not draw a line twice.
          const last = kept.length ? kept[kept.length - 1].seq : 0;
          const fresh = events.filter((entry) => entry.seq > last);
          const all = kept.concat(fresh);
          state.transcript = {
            id,
            events: all.length > TRANSCRIPT_KEEP ? all.slice(all.length - TRANSCRIPT_KEEP) : all,
            next: Math.max(next, last),
            turn,
            failed: null,
          };
        },
        (err) => {
          if (state.selected === id) state.transcript = { ...state.transcript, id, failed: err.message };
        },
      ),
    ]).finally(() => {
      loading = null;
    });
    return loading;
  }

  /**
   * One session. Drawn as "reading" until its read lands; the shell asked
   * for it on the render that put this page on screen.
   */
  function draw(pane) {
    const current = state.sessionDetail.id === state.selected;
    pane.append(
      sessionView({
        data: current ? state.sessionDetail.data : null,
        failed: current ? state.sessionDetail.failed : null,
        transcript: state.transcript.id === state.selected ? state.transcript : null,
        onOpen: go,
        pathFor,
        // A prompt or a stop lands on the log at once; read it back now
        // rather than at the next nudge.
        onChanged: () => load().then(render),
        talk,
      }),
    );
  }

  return {
    draw,
    wants,
    load,
    read: () => (wants() && state.sessionDetail.id !== state.selected ? load() : null),
    reread: () => (wants() ? load() : null),
  };
}
