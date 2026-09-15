// The shell a console hangs in: the address, the redraw, the refresh, and
// the stream that sets one off.
//
// All of this was the top and the bottom of console.js, wrapped around one
// hard-coded set of pages. It is the same code; what changed is that the
// pages are an argument. The full console passes its eleven; something
// slimmer - a console for one machine, with no sign-in and no connectors -
// passes four, and gets the same address handling, the same collapse of a
// burst of events into one read, and the same reconnecting stream without
// a second copy of any of it to keep in step.
//
// What is deliberately *not* here: which pages exist, what a page draws,
// and what it reads. Those are the caller's, handed in as `pages`,
// `drawPage`, `reads` and `rereads`. A shell that knew about Performance
// would be the console again under another name.
import { button } from "./console-dom.js";

/**
 * Build a shell over a page set.
 *
 * @param {object} args
 * @param {object} args.state the one state object, owned by the entry; the
 *   shell writes `page` and `selected` onto it and reads nothing else
 * @param {Record<string, {path: string, title: string, under?: string}>} args.pages
 * @param {string} args.defaultPage where an address that does not parse lands
 * @param {Record<string, string|{page: string, id?: boolean}>} [args.aliases]
 *   a first path segment that is another page by an old name - `/agents` for
 *   `/executors`. The id rides along unless the entry says otherwise, which
 *   is what an old address with no things under it wants (`/discover`).
 * @param {() => string} [args.fallbackPage] which page an unparseable
 *   address lands on, when that is not always `defaultPage`
 * @param {string} [args.title] what follows the page name in the titlebar
 * @param {() => void} args.drawPage draws whatever the address now says
 * @param {Array<() => (Promise|null|undefined)>} [args.reads] read on every
 *   render: each decides for itself whether the address needs it, and
 *   returns the read (which redraws when it lands) or nothing
 * @param {Array<() => (Promise|null|undefined)>} [args.rereads] the same, on
 *   every refresh - the page on screen is re-read when something moved
 * @param {() => Promise[]} [args.readAlways] the reads every refresh does
 *   whatever page is open; `apply` is handed their answers in order
 * @param {(answers: any[]) => void} [args.apply]
 * @param {(message: string) => void} [args.onProblem] where a failed refresh
 *   is said - the pane, for the console
 * @param {object} args.api
 */
export function createShell({
  state,
  pages,
  defaultPage,
  aliases = {},
  fallbackPage = null,
  title = "CoderVibes",
  drawPage,
  reads = [],
  rereads = [],
  readAlways = () => [],
  apply = () => {},
  onProblem = () => {},
  api,
}) {
  // ---------------------------------------------------------- the address

  /**
   * What the current URL means.
   *
   * Unknown paths fall to the default page rather than showing an error: the
   * only ways to get here are a typo and a stale link, and both are better
   * served by the page somebody was probably looking for. `fallbackPage`
   * is how an installation makes that answer depend on where it is - the
   * demo's own hostname lands a visitor on Activity, not on a setup line
   * for an account they do not have.
   */
  function parseLocation(pathname = location.pathname) {
    const [, first, second] = pathname.split("/");
    const id = second ? decodeURIComponent(second) : null;
    if (first && pages[first]) {
      // A page reached by an old name is that page - see `aliases`.
      const alias = aliases[first];
      return { page: typeof alias === "string" ? alias : alias?.page ?? first, id };
    }
    const alias = aliases[first];
    if (alias) {
      if (typeof alias === "string") return { page: alias, id };
      return { page: alias.page, id: alias.id === false ? null : id };
    }
    return { page: fallbackPage ? fallbackPage() : defaultPage, id: null };
  }

  /** The address of a thing, so links and navigation agree on one spelling. */
  const pathFor = (page, id) =>
    id ? `${pages[page].path}/${encodeURIComponent(id)}` : pages[page].path;

  /**
   * Go somewhere, without reloading.
   *
   * `replace` is for normalising an address rather than moving - landing on
   * `/` and settling on `/executors` must not put a step in the history that
   * the back button then has to be pressed twice to get past.
   */
  function go(path, { replace = false } = {}) {
    // The hash counts: `/connectors#secrets` is a different place from
    // `/connectors`, and going there from here is a step.
    if (path !== location.pathname + location.search + location.hash) {
      history[replace ? "replaceState" : "pushState"]({}, "", path);
    }
    render();
  }

  /** Show whatever the address currently says. */
  function render() {
    const here = parseLocation();
    state.page = here.page;
    state.selected = here.id;

    document.title = `${pages[here.page].title} · ${title}`;

    for (const link of document.querySelectorAll("[data-page]")) {
      const on = link.dataset.page === (pages[here.page].under ?? here.page);
      link.classList.toggle("active", on);
      // Spoken as well as coloured. The column is the only navigation there
      // is, so a reader who cannot see the highlight still has to be told
      // which page they are on.
      link.setAttribute("aria-current", on ? "page" : "false");
    }

    drawPage();

    // And what the address now needs read. Each read knows its own page and
    // whether it has already been answered; a page drawn before its read
    // lands says "reading…" and is drawn again when it does.
    for (const read of reads) {
      const reading = read();
      if (reading) reading.then(render);
    }
  }

  /** The way back to the list a thing was opened from. */
  const back = (path) => button("detail-back", "‹ Back", () => go(path));

  // -------------------------------------------------------- refreshing

  /**
   * Re-read the lists and redraw.
   *
   * Collapsed while one is in flight: the event stream fires once per tool
   * call an agent makes, and a busy agent makes several a second. Without
   * this a console left open on a working agent would issue a request per
   * call and render whichever answer happened to land last.
   *
   * Collapsed, not dropped: a nudge that lands mid-read is remembered and
   * one more read follows. What it announced happened after the read in
   * flight was answered - the last line of a turn, the "idle" that ends it -
   * and a page that dropped it showed a turn still running until the next
   * nudge, which for an idle agent is the 30-second clock.
   */
  let refreshing = null;
  let refreshAgain = false;

  function refresh() {
    if (refreshing) {
      refreshAgain = true;
      return refreshing;
    }
    refreshing = (async () => {
      try {
        // The always-on reads first, so `apply` can take their answers by
        // position; the page on screen is re-read alongside them rather
        // than after, since they are all one round trip's worth of wait.
        const answers = await Promise.all([...readAlways(), ...rereads.map((reread) => reread())]);
        apply(answers);
        render();
      } catch (err) {
        onProblem(err.message);
      } finally {
        refreshing = null;
        if (refreshAgain) {
          refreshAgain = false;
          refresh();
        }
      }
    })();
    return refreshing;
  }

  /**
   * Listen for "something moved".
   *
   * This was an EventSource, and in production it never connected: an
   * EventSource cannot send a header, and with Firebase auth the server knows
   * a person by the Authorization header and nothing else, so the stream was
   * answered 401 - while on a laptop, where local auth is a cookie, it was
   * live. So the same stream is read off a fetch, and the two things
   * EventSource would have done are done here: come back when the connection
   * drops, and send the last event id seen so that what happened while a
   * laptop was asleep arrives as events - or as one "resync" when the gap is
   * longer than the server's log - rather than being missed until the next
   * nudge.
   */
  function watch() {
    let lastId = null;
    let leaving = false;
    window.addEventListener("beforeunload", () => {
      leaving = true;
    });

    (async () => {
      let wait = 1_000;
      while (!leaving) {
        try {
          const response = await api.stream(lastId);
          // Signed out since the page loaded. Sign-in reloads the page, and a
          // stream that retried forever would only fill the network log.
          if (response.status === 401 || response.status === 403) return;
          if (response.ok) {
            wait = 1_000;
            await follow(response.body, (event) => {
              if (event.id) lastId = event.id;
              if (event.name === "changed") refresh();
            });
          }
        } catch {
          // A dropped connection is normal - a phone that changed networks, a
          // laptop that slept. It is not worth an error in the one console
          // people read.
        }
        await new Promise((resolve) => setTimeout(resolve, wait));
        wait = Math.min(wait * 2, 30_000);
      }
    })();
  }

  return { parseLocation, pathFor, go, render, back, refresh, watch };
}

/**
 * Server-sent events off a response body, one at a time.
 *
 * Frames are separated by a blank line; inside one, `id:`, `event:` and
 * `data:` lines, and a comment line starting with `:` (the server's
 * heartbeat), which is not an event. A partial frame at the end of a chunk
 * is carried over, not parsed - see `stream` in console-assistant.js.
 *
 * Pure on purpose: it takes a body and a callback and touches nothing else,
 * so it can be read by a test without a browser.
 */
export async function follow(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const event = { name: "message", id: null, data: "" };
      for (const line of frame.split("\n")) {
        if (line.startsWith("id:")) event.id = line.slice(3).trim();
        else if (line.startsWith("event:")) event.name = line.slice(6).trim();
        else if (line.startsWith("data:")) event.data += line.slice(5).trim();
      }
      if (event.name !== "message" || event.data) onEvent(event);
    }
  }
}
