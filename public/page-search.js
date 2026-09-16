// The Search page, wired up: the ask in the address, the read it causes,
// and the model asked about it.
//
// The drawing is console-search.js; this is what used to sit in console.js.
// The ask is the address (`?q=`, `in=`, `from=`/`to=`), which is why
// `searchAsk`, `searchPath` and `searchKey` are here rather than on the
// view: a search is a link, so its spelling has to be one thing that the
// page, the shell and anything linking to a search all agree on.
import { searchView } from "./console-search.js";
import { hasAccessTrail } from "./console-edition.js";

/**
 * @param {object} ctx
 * @param {object} ctx.state the console's one state object
 * @param {object} ctx.api
 * @param {() => void} ctx.render
 * @param {(path: string) => void} ctx.go
 * @param {(page: string, id?: string) => string} ctx.pathFor
 */
export function searchPage({ state, api, render, go, pathFor }) {
  /** Where the page answers, for the addresses built here. */
  const path = pathFor("search");
  let loadingSearch = null;

  const wants = () => state.page === "search";

  /**
   * The ask in the address: `/search?q=...&in=trail&machine=...&from=...&to=...`
   * - the question, which of the two things is searched, the machine the
   * search is narrowed to, and the one bar of the histogram that was
   * pressed, or nothing of each.
   */
  function searchAsk(search = location.search) {
    const params = new URLSearchParams(search);
    return {
      q: params.get("q")?.trim() ?? "",
      // `in=trail` only where there is a trail (console-edition.js): an
      // address typed or pasted onto an installation that has none reads as
      // a plain search rather than as a page with nothing on it and no tab
      // to leave by.
      mode: params.get("in") === "trail" && hasAccessTrail() ? "trail" : "sessions",
      // One machine's sessions: what a machine's page links to, since the
      // page itself has nowhere to send somebody who wants the work
      // (console-connect.js `setupDetail`). In the address like the
      // question, so the chip that says the search is narrowed survives a
      // reload and the way out of it is the back button.
      machine: params.get("machine")?.trim() || null,
      from: Number(params.get("from")) || null,
      to: Number(params.get("to")) || null,
    };
  }

  /** The address of an ask - the same spelling wherever a search is linked from. */
  function searchPath({ q = "", mode = "sessions", machine = null, from = null, to = null } = {}) {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (mode === "trail") params.set("in", "trail");
    if (machine) params.set("machine", machine);
    if (from) params.set("from", String(from));
    if (to) params.set("to", String(to));
    const query = params.toString();
    return query ? `${path}?${query}` : path;
  }

  /** What one answer is for: the ask, the range and the provider, so a change of any reads again. */
  const searchKey = () => `${searchPath(searchAsk())} ${state.search.range} ${state.search.provider ?? ""}`;

  /**
   * Search's read, for the ask in the address and the range on the page.
   * Nothing asked is not nothing read: it is everything, newest first, with
   * the range's usage under it. A reply to an ask no longer in the address
   * is dropped, since the reader has moved on.
   */
  function loadSearch() {
    const ask = searchAsk();
    const key = searchKey();
    if (loadingSearch && state.search.asked === key) return loadingSearch;
    state.search = { ...state.search, asked: key, data: null, failed: null };
    // A new question is a new conversation: the chat was about the last one.
    if (state.search.chat.about !== ask.q) state.search = { ...state.search, chat: { about: ask.q, turns: [] } };
    const { range, provider } = state.search;
    const read = ask.mode === "trail" ? api.searchTrail(ask.q, { range, from: ask.from, to: ask.to }) : api.search(ask.q, { range, provider, machine: ask.machine, from: ask.from, to: ask.to });
    const usage = !ask.q && ask.mode === "sessions" ? loadSearchStats() : Promise.resolve();
    loadingSearch = Promise.all([
      read.then(
        (data) => {
          if (state.search.asked === key) state.search = { ...state.search, data, failed: null };
          // The hits are what the page is for; the model is asked only when
          // somebody presses AI assist - or when this account has said it
          // always wants one, which is off unless they turned it on. The
          // trail has no answer: it is searched by its words and nothing else.
          if (ask.q && ask.mode === "sessions" && state.session?.settings?.explainAlways) askModel(ask.q);
        },
        (err) => {
          if (state.search.asked === key) state.search = { ...state.search, data: null, failed: err.message };
        },
      ),
      usage,
    ]).finally(() => {
      loadingSearch = null;
    });
    return loadingSearch;
  }

  /** The range's usage, for the page with nothing typed - once per range. */
  function loadSearchStats() {
    const { range } = state.search;
    if (state.search.stats.range === range && (state.search.stats.data || state.search.stats.failed)) return Promise.resolve();
    state.search = { ...state.search, stats: { range, data: null, failed: null } };
    return api.searchStats(range).then(
      (data) => {
        if (state.search.stats.range === range) state.search = { ...state.search, stats: { range, data, failed: null } };
      },
      (err) => {
        if (state.search.stats.range === range) state.search = { ...state.search, stats: { range, data: null, failed: err.message } };
      },
    );
  }

  /**
   * Ask the model: the AI assist button, a follow-up typed under the answer,
   * or the account that always wants one. The turn goes on screen asking,
   * and is filled in when the reply lands - with the turns before it sent
   * along, which is what makes a follow-up follow anything.
   *
   * A reply to a chat the reader has left (a new search, a bar pressed that
   * started one) is dropped: `about` says which question the chat is of,
   * and the turn is found again by the position it was put in.
   */
  function askModel(question) {
    const asked = String(question ?? "").trim();
    if (!asked) return Promise.resolve();
    const about = state.search.chat.about;
    const before = state.search.chat.turns.filter((turn) => turn.data?.answer).map((turn) => ({ question: turn.question, answer: turn.data.answer }));
    const at = state.search.chat.turns.length;
    const turns = [...state.search.chat.turns, { question: asked, asking: true, data: null, failed: null }];
    state.search = { ...state.search, chat: { about, turns } };
    render();
    const settle = (patch) => {
      // The reader has left this chat (a new search, another question): the
      // reply is theirs no longer, and drawing it would put it under a
      // question it did not answer.
      if (state.search.chat.about !== about || !state.search.chat.turns[at]) return;
      const kept = [...state.search.chat.turns];
      kept[at] = { ...kept[at], asking: false, ...patch };
      state.search = { ...state.search, chat: { about, turns: kept } };
      render();
    };
    return api.searchAnswer(asked, before).then(
      (data) => settle({ data, failed: null }),
      (err) => settle({ data: null, failed: err.message }),
    );
  }

  function draw(pane) {
    const ask = searchAsk();
    const current = state.search.asked === searchKey();
    pane.append(
      searchView({
        ask,
        kind: state.search.kind,
        provider: state.search.provider,
        range: state.search.range,
        data: current ? state.search.data : null,
        failed: current ? state.search.failed : null,
        chat: state.search.chat.about === ask.q ? state.search.chat : null,
        stats: state.search.stats.range === state.search.range ? state.search.stats : null,
        // A new question keeps the machine: somebody who came from a
        // machine's page and then typed a word still means that machine's
        // work. The bar pressed is dropped, though - it was pressed for
        // the last question.
        onSearch: (q, mode) => go(searchPath({ q, mode, machine: ask.machine })),
        onMachine: () => go(searchPath({ ...ask, machine: null, from: null, to: null })),
        onMode: (mode) => go(searchPath({ ...ask, mode, from: null, to: null })),
        onBucket: (bucket, mode = ask.mode) => go(searchPath({ ...ask, mode, from: bucket?.from ?? null, to: bucket?.to ?? null })),
        onKind: (kind) => {
          state.search.kind = kind;
          render();
        },
        onProvider: (provider) => {
          state.search.provider = provider;
          loadSearch().then(render);
          render();
        },
        onRange: (range) => {
          state.search.range = range;
          loadSearch().then(render);
          render();
        },
        onReread: () => {
          state.search.asked = null;
          state.search.stats = { ...state.search.stats, range: null };
          loadSearch().then(render);
          render();
        },
        // The model is asked when somebody presses AI assist, and after
        // that whenever they ask a follow-up. Both are the same call - a
        // question with the chat so far behind it. The button sits in the
        // search box, so what it asks about is what is typed there: words
        // that have not been searched yet are searched first, so that the
        // answer and the list under it are of the same question.
        onExplain: (typed) => {
          const asked = String(typed ?? "").trim() || ask.q;
          if (!asked) return;
          if (asked !== ask.q) go(searchPath({ q: asked, mode: ask.mode }));
          askModel(asked);
        },
        onAsk: (question) => askModel(question),
        onOpen: go,
        pathFor,
      }),
    );
  }

  return {
    draw,
    wants,
    loadSearch,
    searchAsk,
    searchPath,
    searchKey,
    // Read when the ask in the address is not the one it last answered - a
    // new search, a link followed, the back button - or the range on the
    // page has moved.
    read: () => (wants() && state.search.asked !== searchKey() ? loadSearch() : null),
    reread: () => (wants() ? loadSearch() : null),
  };
}
