// The local console: five pages, one document, and nobody to sign in as.
//
// This is console.js's job - which pages there are, what a page draws, what
// a refresh reads - over a quarter of its page set. Everything it does not
// do is the point: no `initAuth` and no gate, because the server answers
// `auth: { mode: "none" }` and the page simply opens; no secrets read,
// because this edition has none; no workspace switcher, because there is one
// person; no Activity page, because a list of everybody's work is a list of
// one person's own sessions, which Search is already over.
//
// Connectors is this console's own rather than the full one's: the page here
// is three git hosts and a token box (page-git-hosts.js), where the hosted
// product's is every service an agent can be lent. Same address, because it
// is the same question - what is this installation connected to - and a
// different page, because the answers have nothing in common.
//
// The mechanics are shell.js and the page modules, unchanged and unforked -
// the address handling, the collapse of a burst of events into one read, the
// reconnecting stream, the four pages and the session page are the same code
// the full console hangs in its own shell. That is the whole reason this
// file is short, and it is why it must stay a composition: a helper reached
// for across the line into console.js drags the tasks and the public pages
// in behind it (test/console.test.js holds this).
//
// One address is not in the column: `/activity/<session>` is one session,
// which a search result and a machine's row open onto. `back` from it goes
// to Search, since Search is the page this edition lists sessions on.
import { api } from "./api.js";
import { el, problem } from "./console-dom.js";
import { initModals } from "./modal.js";
import { createShell } from "./shell.js";
import { executorsPage } from "./page-executors.js";
import { performancePage } from "./page-performance.js";
import { searchPage } from "./page-search.js";
import { toolsPage } from "./page-tools.js";
import { gitHostsPage } from "./page-git-hosts.js";
import { sessionPage } from "./page-session.js";
import { NO_FILTERS } from "./console-performance.js";
import { oneWhere } from "./console-where.js";
import { onePerson } from "./console-edition.js";

// There is one person and no workspaces, so "a repo of this workspace",
// "a repository nobody registered here" and "no repository at all" are three
// names for the same thing: yours. The server answers with all three
// (server/local.js `wheresOf`), and the console stops drawing the filter
// that would offer to include what is already there and the chip that would
// mark every row.
oneWhere();

// And the rest of what this edition has none of: tasks, workspaces, invited
// agents, sandboxes, an access trail, connectors an agent can call
// (console-edition.js). Said once, before a page is drawn, because the pages
// are the full console's and would otherwise head a column of dashes with
// the name of a feature that is not here. Both switches are flipped at
// import time and not in `start()`: a module that read one while it was
// still true would draw the hosted product's words once and never again.
onePerson();

const dom = {
  main: () => document.getElementById("console"),
  page: () => document.getElementById("console-main"),
};

/**
 * The pages, and what each one is.
 *
 * The four in the column, in the column's order, and one that is an address
 * without a link. `kind` is what a row on a page *is*, which is also what
 * the page draws when the address names one.
 */
const PAGES = {
  executors: { path: "/executors", kind: "executor", title: "Executors" },
  performance: { path: "/performance", kind: "ranking", title: "Performance" },
  search: { path: "/search", kind: "discovery", title: "Search" },
  tools: { path: "/tools", kind: "tool", title: "Tools" },
  // The git host a person's pull requests live on, connected with their own
  // token. One row per host and no thing to open, so no `kind`.
  connectors: { path: "/connectors", kind: null, title: "Connectors" },
  // One session. Named `activity` because that is the address the full
  // console gives a session and the page module keys off (page-session.js
  // `wants`), and because a link to a session copied out of one console
  // should open in the other. `under: null` means no link in the column
  // lights up while you are on it, which is honest: it is under none of
  // them.
  activity: { path: "/activity", kind: "session", title: "Session", under: null },
};

/** Executors, because its top is the setup line and nothing is on any other page until that has run. */
const DEFAULT_PAGE = "executors";

/**
 * Everything this page knows.
 *
 * The fields the six page modules read, and no others - a state with a
 * `workspaces` in it would be a promise this edition cannot keep. The
 * shapes are console.js's, because the page modules are.
 */
const state = {
  session: null,
  executors: [],
  executorsPriced: false,
  // The setup line, read only while the Executors list is on screen.
  ingest: null,
  performance: {
    range: "7d", filters: NO_FILTERS, data: null, failed: null,
    compare: null, compareFailed: null, compareState: { dimension: "provider", table: false },
    harness: null, harnessFailed: null,
    adoption: null, adoptionFailed: null,
    trendState: { metric: "cost", split: "none", table: false },
    friction: null, frictionFailed: null, frictionState: { by: "repo" },
  },
  tools: { range: "7d", data: null, failed: null },
  // The three git hosts and which of them is connected. Null until the
  // Connectors page has been opened; `{hosts, failed}` after.
  gitHosts: null,
  toolDetail: { id: null, range: "7d", data: null, failed: null },
  search: {
    asked: null, data: null, failed: null, kind: "all", provider: null, range: "all",
    chat: { about: null, turns: [] },
    stats: { range: null, data: null, failed: null },
  },
  sessionDetail: { id: null, data: null, failed: null },
  transcript: { id: null, events: [], next: 0, turn: null, failed: null },
  // Why an optional listing is empty, when it is empty because it failed -
  // one entry, because one read here is allowed to fail on its own.
  failed: { ingest: null },
  // Which page and which row on it. The URL is the state; this is a cache
  // of what it currently says.
  page: DEFAULT_PAGE,
  selected: null,
};

const shell = createShell({
  state,
  pages: PAGES,
  defaultPage: DEFAULT_PAGE,
  // `/home/<session>` is the address a session had for a month and is in
  // plenty of links; `/agents` is what Executors was called. Both still
  // open the same thing here, for the same reason they do in the full
  // console - a link that was right yesterday should not be a 404.
  aliases: { home: "activity", agents: "executors" },
  drawPage,
  reads: [
    () => executors.read(),
    () => performance.read(),
    () => tools.readList(),
    () => search.read(),
    () => tools.readTool(),
    () => oneSession.read(),
    () => gitHosts.read(),
  ],
  // What every refresh reads whatever page is open. Two, against the full
  // console's four: there are no secrets to read, and the git hosts are
  // read by the page that shows them rather than on every tick - they can
  // only change on that page.
  readAlways: () => [api.session(), api.executors()],
  rereads: [
    () => performance.reread(),
    () => search.reread(),
    () => oneSession.reread(),
    () => gitHosts.reread(),
  ],
  apply: ([session, executorsAnswer]) => {
    state.session = session;
    state.executors = executorsAnswer.executors ?? [];
    // Whether a cost is money here or only tokens (costs.js): the list says
    // what a session cost only when it can say it in currency.
    state.executorsPriced = Boolean(executorsAnswer.priced);
  },
  onProblem: (message) => dom.page().replaceChildren(problem(message)),
  api,
});

const { parseLocation, pathFor, go, render, back, refresh, watch } = shell;

/**
 * What every page module is handed: the state it reads, the way to ask for
 * a redraw, and the way to build an address.
 */
const pageCtx = { state, api, go, pathFor, render, refresh, back };

const executors = executorsPage(pageCtx, {
  // No `describeExternal` and no `detailFor`: there are no vendors' agents
  // and no invited agents here, so the two kinds of row this module does
  // not draw are two kinds of row that never appear. What is left is
  // machines, which is what it draws itself.
  //
  // Its sessions, though, it does have a page for: Search is the listing
  // this edition has, and it takes a machine (`/search?machine=<id>`,
  // page-search.js), so the button on a machine's page opens that
  // machine's work rather than nothing at all.
  onForget: (executor) => api.forgetExecutor(executor.id).then(() => {
    // Back to the list, and read it again: the row is gone and the count
    // under the title has changed, and nothing publishes an event for it.
    go(pathFor("executors"));
    return refresh();
  }),
});
const performance = performancePage(pageCtx);
const search = searchPage(pageCtx);
const tools = toolsPage(pageCtx);
const oneSession = sessionPage(pageCtx);
// The git hosts: three rows, a token box each, and nothing an agent is lent
// - see page-git-hosts.js.
const gitHosts = gitHostsPage(pageCtx);

/** Draw whatever the address says: a page's list, or one thing on it. */
function drawPage() {
  const pane = dom.page();
  pane.replaceChildren();

  if (state.page === "executors") return executors.draw(pane);
  if (state.page === "performance") return pane.append(performance.view());
  if (state.page === "search") return search.draw(pane);
  if (state.page === "tools") return tools.draw(pane);
  if (state.page === "connectors") return gitHosts.draw(pane);

  if (state.page === "activity") {
    // `/activity` with nothing under it is not a page here - there is no
    // list of everybody's work, because everybody is one person. The
    // address settles on Search, which is the listing this edition has.
    if (!state.selected) return go(pathFor("search"), { replace: true });
    pane.append(back(pathFor("search")));
    oneSession.draw(pane);
  }
}

async function start() {
  initModals();

  // The column, and any link a page draws to another page. They are anchors,
  // so a middle click or a cmd-click still opens a tab; only a plain left
  // click is routed.
  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a[data-page]");
    if (!link) return;
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    go(link.getAttribute("href"));
  });

  // The back button is the whole reason these are addresses rather than tabs.
  window.addEventListener("popstate", render);

  try {
    state.session = await api.session();
  } catch (err) {
    // Not fatal and not a gate: there is nothing to sign into, so a session
    // that would not read is a server that is not answering, and saying so
    // is better than an empty console.
    dom.page().replaceChildren(problem(err.message));
  }

  // Settle on a canonical address before drawing anything. `/` is one of the
  // four; replacing rather than pushing keeps the back button from needing
  // two presses to leave.
  const here = parseLocation();
  const canonical = pathFor(here.page, here.id);
  // A search's question rides in the address (`?q=`) and survives the
  // settling.
  if (canonical !== location.pathname) go(canonical + (here.page === "search" ? location.search : ""), { replace: true });

  // The foot of the grid: the strip of sky, with the one line this edition
  // has to say on it. The full console's Contact and About us are the
  // public site's, and there is no public site here.
  document.getElementById("console-foot").append(
    el("p", "local-foot-note", "CoderVibes, local edition - everything here is yours, on this machine."),
  );

  await refresh();
  watch();
}

start();
