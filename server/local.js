// CoderVibes on one person's laptop: the whole entry point.
//
// What this is: the same program as the hosted product, mounting the same
// page modules over the same records - Executors, Performance, Search,
// Tools, one session - and the same ingest door a harness on this machine
// posts to. server/pages/*.js and server/scope.js are what make that
// possible; this file is the other half of the seam, the installation
// answering for its own shape.
//
// What this is not, and none of it is an omission: no sign-in, no
// workspaces, no tasks handed between agents, no sandbox
// agents, no GitHub App, no mail, no inference. Every one of those is a
// thing that only makes sense with other people in it, and the local
// edition has one person by construction.
//
// What it does have, on top of the pages, is an MCP server of its own
// (mcp-local.js) at /mcp: three tools, no token, so the coding agent on this
// machine can read the record it has been filling. That is the same
// direction the hosted product's endpoint points in, cut to what an
// installation with one person and no connected services actually holds.
//
// One thing reaches the network, and only when a person asks for it: a git
// host they connect on the Connectors page (server/git-hosts/). A personal
// token, their own pull requests, and the answer to "did it merge" - which
// is the one fact this edition could not learn without an App, and the one
// Performance is most often asked for. Nothing else is on a timer: until a
// token is pasted, a laptop with the lid shut is a process doing nothing
// rather than a process retrying something.
//
// Three things are different from index.js, and all three are edition.js:
//
//   who     `CODERVIBES_AUTH=none`, so `identify` is always `LOCAL_USER` -
//           the account on this machine. Nothing carries a token, including
//           the ingest: the harness posts with no Authorization header at
//           all and `mountOtlp`'s `authenticate` answers with the one
//           person. That is only safe because of the third point.
//
//   how many `CODERVIBES_MAX_EXECUTORS=3`. Three machines may be seated;
//           the fourth is refused with a 409 that says how to make room
//           (ingest-token.js `refuseIfFull`), and Forget below is the room.
//
//   from    it binds to 127.0.0.1 and `sameMachine` checks the socket of
//   where   every request besides. Both, because either alone is undone by
//           a tunnel in front of it - see edition.js. BIND_HOST is refused
//           rather than honoured, since a console with no door in has no
//           business on an address other machines can reach.
//
// The defaults below are set before anything that reads the environment is
// loaded, which is why every import in this file is dynamic: static imports
// are hoisted above the statements, so an `import` of store/json-store.js at
// the top would read CODERVIBES_DATA_DIR before the line that sets it had
// run. The order is the point, so it is written out rather than relied on.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ------------------------------------------------- what this edition sets

/** Set unless the person running it said otherwise. */
const settle = (name, value) => {
  if (!String(process.env[name] ?? "").trim()) process.env[name] = value;
};

// Nobody to sign in as, and the records are files. Both are the whole of
// what "local" means to the modules underneath, and neither is a switch
// anybody should have to find.
settle("CODERVIBES_AUTH", "none");
settle("CODERVIBES_STORE", "json");
// Beside the home directory rather than beside the checkout, so a `git
// clean` or a second clone is not a month of work gone. docs/local.md says
// this is what it is; a person who wants it elsewhere sets the variable.
settle("CODERVIBES_DATA_DIR", path.join(os.homedir(), ".codervibes", "data"));
settle("CODERVIBES_MAX_EXECUTORS", "3");
settle("PORT", "3592");

fs.mkdirSync(process.env.CODERVIBES_DATA_DIR, { recursive: true });

const PORT = Number(process.env.PORT) || 3592;
const HOST = "127.0.0.1";

// ------------------------------------------------------------- the modules

const express = (await import("express")).default;
const { LOCAL_USER, MAX_EXECUTORS, sameMachine, isLoopback } = await import("./edition.js");
const { AUTH_MODE } = await import("./auth.js");
const { sessionMiddleware, requireUser, requireViewer } = await import("./session.js");
const { mountOtlp } = await import("./otlp.js");
const { mountLocalMcp } = await import("./mcp-local.js");
const { scopeFor } = await import("./scope.js");
const { WHERES } = await import("./session-where.js");
const ingestToken = await import("./ingest-token.js");
const { setupCommand } = await import("./setup-script.js");
const { LIMITS } = await import("./limits.js");
const events = await import("./events.js");
const sessionLog = await import("./sessions.js");
const search = await import("./search.js");
const replay = await import("./replay.js");
const { mount: mountExecutors } = await import("./pages/executors.js");
const { mount: mountPerformance } = await import("./pages/performance.js");
const { mount: mountSearch, refreshSearchCatalog } = await import("./pages/search.js");
const { mount: mountTools } = await import("./pages/tools.js");
const { mount: mountSessions } = await import("./pages/sessions.js");
const { mount: mountIngest } = await import("./pages/ingest.js");
const gitHosts = await import("./git-hosts/index.js");
const gitHostCredentials = await import("./git-hosts/credentials.js");
const gitHostSync = await import("./git-hosts/sync.js");

// BIND_HOST after edition.js, because `isLoopback` is the one place that
// knows what counts as this machine. Refused rather than ignored: somebody
// who set it meant it, and quietly binding somewhere else than they asked
// would be worse than not starting - this app has no sign-in, so the
// address it answers on is the whole of its security.
const BIND_HOST = String(process.env.BIND_HOST ?? "").trim();
if (BIND_HOST && !isLoopback(BIND_HOST) && BIND_HOST.toLowerCase() !== "localhost") {
  console.error(
    `BIND_HOST is ${BIND_HOST}, and this CoderVibes has no sign-in, so it answers on ${HOST} only - ` +
      `unset BIND_HOST, or run the hosted edition (server/index.js) if you want it reachable.`,
  );
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "..", "public");
const ORIGIN = `http://${HOST}:${PORT}`;

const app = express();

// Every request, before anything reads a body or a cookie: this machine or
// nothing. First in the stack because a refusal must not depend on any
// route below having remembered to ask.
app.use(sameMachine);

// ------------------------------------------------------------ the ingest
//
// What a harness on this machine exports, and what its hooks report. Before
// the JSON parser and before the session middleware, for the reasons in
// otlp.js - a batch is bigger than anything the console sends, and the
// middleware would answer first.
//
// `authenticate` is the seam that makes a token unnecessary: nothing on this
// laptop holds one, so nothing sends one, and the answer is the one person
// whatever the header says. `executor: null` deliberately - on the hosted
// product the token is the executor, so every setup on one token is one row;
// here there is no token to be one, and the honest key is the machine
// itself (telemetry-ingest.js `whereOf`). Three machines are three rows,
// which is what the cap counts.
mountOtlp(app, {
  authenticate: async () => ({ user: LOCAL_USER, harness: ingestToken.harnessOf(LOCAL_USER), executor: null }),
});

app.use(express.json({ limit: LIMITS.maxRequestBytes }));

// Nothing under /api is ever reusable: the same address is a different
// answer a minute later, and Express's ETag without a Cache-Control lets a
// browser decide otherwise.
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// The agent's own door: three tools over JSON-RPC, no credential asked for.
// Mounted here for the same reason index.js mounts its own here - before the
// session middleware, so an agent speaking MCP and a browser carrying a
// cookie cannot be confused for one another - and after `sameMachine`, which
// is the only thing standing in front of it (mcp-local.js).
mountLocalMcp(app, { user: LOCAL_USER });

app.use("/api", sessionMiddleware);

// -------------------------------------------------------------- the scope
//
// What the pages are mounted with - see server/scope.js. Almost all of it is
// the default, which is the point of the seam: the defaults *are* the
// answers for one person with no workspace and no agents of their own. Four
// things are said here because the local edition's answer is not the
// cloud's.
const scope = scopeFor({
  requireUser,
  requireViewer,

  /**
   * Whose rows the two per-account pages read. One person, always - and
   * said rather than left to the default, which reads it off the request,
   * because there is nobody else it could be and a page that went looking
   * would only find the same answer more slowly.
   */
  readersOf: () => [LOCAL_USER],

  /**
   * Which work reaches the page: all of it.
   *
   * The cloud hides two of the three (session-where.js `parse`) because a
   * person's setup reports every terminal they open and a team's page
   * should be the team's repos' work. Here there is no team and no repo
   * registry: a session in a checkout nobody registered is `external` and a
   * session in a scratch directory is `none`, and both of those are simply
   * the person's work. Hiding them would leave the four pages empty on a
   * laptop that had been reporting all week, which is exactly the bug this
   * edition exists to not have.
   */
  wheresOf: () => WHERES,

  /**
   * What Search offers beside the sessions: nothing. The catalogue is the
   * connectors and collaboration tools an installation has, and this one
   * has neither - so the search is over the sessions, which is all there
   * is to search.
   */
  catalogueSources: () => ({ connectors: [], tools: [] }),

  /**
   * The setup line this installation hands out: no token, because there is
   * nobody to authenticate - see setup-script.js, which drops every place
   * the token appears rather than writing an empty one.
   *
   * The MCP server is written into every harness all the same, without a
   * header: what it offers here is the three tools of mcp-local.js, which
   * are about the record this installation kept rather than about services
   * it has not got. An agent that cannot ask what was done here before is
   * an agent that works it out again every time.
   */
  setup: { token: "none", mcp: true },
});

const { wrap } = scope;

// ------------------------------------------------------ who is asking

/**
 * The person, for the console at boot.
 *
 * The same shape index.js answers, minus everything that would be a lie
 * here: no `auth.domain` (nothing to sign in to), no github block (no App),
 * no workspaces (there is one person, so there is nobody to be in a room
 * with). `workspace` is null for the same reason - a personal workspace
 * record exists underneath, because the scoping is written in terms of one,
 * but it is not a thing anybody here can switch, leave or invite into, and
 * reporting it would put a switcher on a page that has none.
 */
app.get("/api/session", wrap(async (req, res) => {
  res.json({
    auth: { mode: AUTH_MODE, domain: null },
    user: req.cv.user,
    // Nobody reads this without an account, because there is no account.
    visitor: false,
    demoHost: false,
    workspace: null,
    workspaces: [],
    repo: null,
    repos: [],
    permissions: [],
    // How the console behaves for this person. One flag so far, and the
    // page that would set it is the Account page, which this edition does
    // not serve - so it is off, and Search explains when asked.
    settings: { explainAlways: false },
    // How they said they work. Never asked here: the question is the
    // hosted product's onboarding, and this edition has none.
    level: null,
    name: null,
  });
}));

/**
 * What the installation can do, read once at boot.
 *
 * `auth.mode` is what the console configures sign-in from, and "none" is
 * what tells it there is none. Everything else index.js reports here is
 * about a GitHub App, which this edition has not got.
 */
app.get("/api/config", wrap(async (req, res) => {
  res.json({ auth: { mode: AUTH_MODE, domain: null }, user: req.cv.user, repo: null, permissions: [] });
}));

// --------------------------------------------------------------- the pages
//
// The console's, mounted exactly as index.js mounts them and in the same
// order. Four of them are pages a person opens; `sessions` is what a search
// result opens onto, and `ingest` is `/setup.sh`, `/healthz` and the line
// the Executors page prints.
mountExecutors(app, scope);
mountPerformance(app, scope);
mountSearch(app, scope);
mountTools(app, scope);
mountSessions(app, scope);

/**
 * Forget a machine: the one way a place comes free under the cap.
 *
 * A DELETE on the row's own address, which is `setup:<machine id>` as the
 * Executors page builds it (pages/executors.js `discoveredSetups`) - so the
 * console deletes the thing it is looking at rather than translating it
 * into something else first. Only a setup row can be forgotten, and the
 * prefix is checked rather than stripped blindly: every other kind of row
 * on that list is a record somebody made, and this edition has none of
 * them.
 *
 * It removes the row and nothing else - the sessions that ran there are
 * what happened and stay in Search - and it is not a block list: the
 * machine comes back if it reports again and there is room. See
 * ingest-token.js `forgetSetup`.
 */
app.delete("/api/executors/:id", requireUser, wrap(async (req, res) => {
  const id = String(req.params.id);
  if (!id.startsWith("setup:")) {
    return res.status(400).json({ error: "Only a machine that reported here can be forgotten." });
  }
  const forgotten = await ingestToken.forgetSetup(req.cv.user, id.slice("setup:".length));
  if (!forgotten) return res.status(404).json({ error: "No machine of yours has that id." });
  res.json({ forgotten: true, id });
}));


// ------------------------------------------------------------- git hosts
//
// The fifth page: GitHub, GitLab or Bitbucket connected with a personal
// token, so the pull requests this person opens are followed until they
// merge or close and Performance counts them rather than only counting the
// ones it saw opened.
//
// A token and nothing else - no App, no OAuth application to register, no
// callback address a laptop does not have. The token is checked with the
// host before it is kept and is never in an answer; see
// git-hosts/credentials.js.

/** What the page draws: every host, connected or not, and never a token. */
app.get("/api/git-hosts", requireUser, wrap(async (req, res) => {
  const connections = await gitHostCredentials.listFor(req.cv.user);
  const byHost = new Map(connections.map((entry) => [entry.host, entry]));
  res.json({ hosts: gitHosts.ALL.map((host) => gitHosts.describeHost(host, byHost.get(host.id) ?? null)) });
}));

/**
 * Connect one: `{ token }`, and `{ username, token }` for Bitbucket, which
 * signs in with both halves.
 *
 * A refusal is the host's own sentence with a 400 or a 401 on it - the
 * person is looking at the box they pasted into, and "401" there is a bug
 * report rather than an answer.
 */
app.post("/api/git-hosts/:host", requireUser, wrap(async (req, res) => {
  const host = gitHosts.hostOrRefuse(req.params.host);
  const credential = { token: String(req.body?.token ?? "").trim() };
  if (req.body?.username) credential.username = String(req.body.username).trim();
  const connected = await gitHostCredentials.connect(req.cv.user, host.id, credential);
  // What it will now do, straight away rather than in five minutes: a
  // person who has just connected a host is a person waiting to see
  // whether it worked. Best effort - the connection stands either way.
  const swept = await gitHostSync.sweep(req.cv.user, {}).catch(() => null);
  res.json({ ...connected, swept: swept?.seen ?? 0 });
}));

/** Forget one. The records it already folded are what happened, and stay. */
app.delete("/api/git-hosts/:host", requireUser, wrap(async (req, res) => {
  const host = gitHosts.hostOrRefuse(req.params.host);
  const forgotten = await gitHostCredentials.disconnect(req.cv.user, host.id);
  if (!forgotten) return res.status(404).json({ error: `${host.label} is not connected.` });
  res.json({ forgotten: true, host: host.id });
}));

/**
 * Ask now rather than at the next tick - the Check now button, and what a
 * test drives instead of waiting five minutes for a timer.
 */
app.post("/api/git-hosts/:host/sync", requireUser, wrap(async (req, res) => {
  const host = gitHosts.hostOrRefuse(req.params.host);
  const credential = await gitHostCredentials.credentialFor(req.cv.user, host.id);
  if (!credential) return res.status(404).json({ error: `${host.label} is not connected.` });
  res.json(await gitHostSync.sweep(req.cv.user, {}));
}));

// `/setup.sh`, `/healthz`, and the setup line the Executors page prints.
// Mounted whole rather than picked apart: what the script carries and what
// the line carries are both read off `scope.setup`, so a tokenless
// installation gets a tokenless script, a tokenless line and no way to mint
// one without a second copy of any of it here.
mountIngest(app, scope);

/**
 * Something moved.
 *
 * The same stream index.js serves and the same reader in the browser
 * (shell.js `watch`), with the filter gone: every event in this log is this
 * one person's, so there is nothing to filter out and nothing that could be
 * let through by mistake.
 */
app.get("/api/agents/stream", requireUser, wrap(async (req, res) => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const send = (event) => {
    const { data, ...head } = event;
    res.write(`id: ${event.id}\nevent: changed\ndata: ${JSON.stringify({ ...head, data })}\n\n`);
  };

  // Where the browser is, so a reconnect after a sleep catches up rather
  // than sitting on an hour-old page until the next nudge.
  const cursor = req.get("last-event-id") || null;
  res.write(`id: ${events.cursor()}\nevent: open\ndata: {}\n\n`);
  if (cursor) {
    const missed = await events.since(cursor);
    for (const event of missed.events) send(event);
    if (!missed.complete) res.write(`event: changed\ndata: ${JSON.stringify({ type: "resync" })}\n\n`);
  }

  const stop = events.subscribe(send);
  // A connection that says nothing is dropped by whatever is between; a
  // comment frame is not an event, so the browser ignores it and the socket
  // lives.
  const beat = setInterval(() => res.write(": beat\n\n"), 25_000);
  beat.unref?.();
  req.on("close", () => {
    clearInterval(beat);
    stop();
  });
}));

// --------------------------------------------------------------- the console
//
// One document, four pages, and the addresses under them - the same
// arrangement as index.js and for the same reason: a deep link, a reload and
// the back button all have to work, which is the whole difference between a
// page and a tab. `/activity/<session>` has no link in the column; it is
// what a search result opens onto.
const consolePage = (req, res) => res.sendFile("local.html", { root: PUBLIC_DIR });

for (const route of [
  "/",
  "/executors",
  "/executors/:executorId",
  "/performance",
  "/performance/:by",
  "/search",
  "/tools",
  "/tools/:toolName",
  "/connectors",
  "/activity/:sessionId",
]) {
  app.get(route, consolePage);
}

// `index: false`: the lines above decide what `/` is.
app.use(express.static(PUBLIC_DIR, { index: false }));

// ------------------------------------------------------------------- boot

app.listen(PORT, HOST, () => {
  console.log(`CoderVibes  ${ORIGIN}`);
  console.log(`connect     ${setupCommand({ origin: ORIGIN })}`);
  console.log(`agent tools ${ORIGIN}/mcp - discover, open_session, name_session (the line above wires them in)`);
  console.log(`records     ${process.env.CODERVIBES_DATA_DIR} (back that up; nothing else will)`);
  console.log(`executors   ${MAX_EXECUTORS} at a time - Forget one on the Executors page to make room`);

  // What the pages need in memory before anybody opens one. All three read
  // the store this process already has; none of them reaches the network.
  sessionLog.warm().then(() => sessionLog.sweep()).catch((err) => console.warn(`sessions: ${err.message}`));
  replay.warm({ repoNameOf: () => null }).catch((err) => console.warn(`replay: ${err.message}`));
  // The catalogue once - it is empty here (`catalogueSources`), and asking
  // for it is what makes Search's index a whole one rather than sessions
  // plus a gap - then the month's sessions, then every session from here on
  // as its log lands.
  refreshSearchCatalog(scope);
  search.warm().then((n) => console.log(`search      ${n} session(s) indexed`)).catch((err) => console.warn(`search: ${err.message}`));
  search.follow();

  // And the one loop that can reach the network, which asks nobody anything
  // until a git host is connected on the Connectors page. One person, so
  // one row to sweep.
  gitHostSync.start({ users: () => [LOCAL_USER] });
});
