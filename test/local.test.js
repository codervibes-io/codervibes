// The local edition, started the way a person starts it.
//
// `node server/local.js` with nothing configured: no token, no account, no
// store to point at, no environment beyond a data directory to keep the
// test's records out of anybody's home. What it has to do is the whole
// product - take what a harness on this machine reports, over a door that
// asks for no credential, and answer the four pages and one session from it.
//
// This is an HTTP test rather than a source-reading one because that is the
// claim: every piece of it works on its own (the ingest door, the scope, the
// page modules) and none of that is evidence that they work when bolted
// together by an entry point that hands in different answers. Two of these
// caught exactly that - a where-filter that left every page empty on a
// laptop with a week of work on it, and a Forget that freed a seat and left
// the row on the page.
//
// The source-reading half at the end holds what an HTTP test cannot see:
// that the column is five pages, that the addresses the client knows are the
// addresses the server serves, and that neither file mentions a page this
// edition does not have.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startFakeGitLab } from "./fake-gitlab.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => fs.readFile(path.join(root, ...parts), "utf8");

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

let server;
let base;
let dataDir;
/** A GitLab for the Connectors page to connect to - see fake-gitlab.js. */
let gitlab;

/**
 * The environment a person starts this in: theirs, with everything this
 * edition sets for itself blanked out. Empty rather than deleted, because
 * empty is what `settle` treats as unsaid - so this is also the test that
 * the defaults are defaults and not something a test fixture supplies.
 */
const bare = (extra = {}) => ({
  ...process.env,
  CODERVIBES_AUTH: "",
  CODERVIBES_STORE: "",
  CODERVIBES_MAX_EXECUTORS: "",
  CODERVIBES_PUBLIC_URL: "",
  BIND_HOST: "",
  ANTHROPIC_API_KEY: "",
  ...extra,
});

/** A request with no credential of any kind - which is the point. */
async function call(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, { redirect: "manual", ...options });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

const post = (pathname, body) =>
  call(pathname, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/**
 * Poll until it is true, or say what it still was.
 *
 * Search indexes a session a few seconds after its last line lands
 * (search.js `SETTLE_MS`), so a read straight after the hooks is a read of
 * an index that has not been built yet. A fixed wait would be either flaky
 * or slow; this is neither.
 */
async function eventually(what, check, { within = 20_000 } = {}) {
  const deadline = Date.now() + within;
  let last;
  for (;;) {
    last = await check();
    if (last) return last;
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${within}ms`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test.before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codervibes-local-"));
  gitlab = await startFakeGitLab();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["server/local.js"], {
    cwd: root,
    env: bare({
      PORT: String(port),
      CODERVIBES_DATA_DIR: dataDir,
      // The one thing this edition reaches the network for, pointed at a
      // fake: the git host a person connects on the Connectors page.
      CODERVIBES_GITLAB_API: process.env.CODERVIBES_GITLAB_API,
    }),
    stdio: "ignore",
  });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("the local edition did not start");
    try {
      if ((await fetch(`${base}/healthz`)).status === 200) break;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
});

test.after(async () => {
  server?.kill("SIGTERM");
  gitlab?.server.close();
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

// ------------------------------------------------------- nobody signs in

test("the console opens with no cookie, no token and nobody signed in", async () => {
  const page = await call("/");
  assert.equal(page.status, 200);
  assert.match(page.body, /local\.js/, "`/` is the local console, not the full one");
  assert.doesNotMatch(page.body, /console\.js/, "and it is not serving the full console's entry");

  // No cookie was sent and none is needed: the mode says there is no
  // sign-in at all, and the user is this machine's account.
  const { status, body } = await call("/api/session");
  assert.equal(status, 200);
  assert.equal(body.auth.mode, "none");
  assert.equal(body.auth.domain, null);
  assert.equal(body.user, `${os.userInfo().username.toLowerCase()}@localhost`);
  assert.equal(body.visitor, false);
  assert.equal(body.demoHost, false);
  // Nothing that would put a switcher, a gate or an onboarding question on a
  // page this edition does not serve.
  assert.equal(body.workspace, null);
  assert.deepEqual(body.workspaces, []);
  assert.equal(body.settings.explainAlways, false);
  assert.equal(body.github, undefined, "there is no GitHub App here to describe");

  const config = await call("/api/config");
  assert.equal(config.body.auth.mode, "none", "what the console configures sign-in from says there is none");
});

test("the setup line carries no token and asks for no header, and still wires this app's tools into every harness", async () => {
  const script = (await call("/setup.sh")).body;
  assert.doesNotMatch(script, /cvh1/, "a token this installation cannot issue must not be in the line");
  assert.doesNotMatch(script, /Authorization/, "nothing here authenticates, so nothing sends a header");
  assert.doesNotMatch(script, /OTEL_EXPORTER_OTLP_HEADERS/);
  // The MCP server is written in all the same: what it offers here is the
  // three tools of mcp-local.js, which need no connected service and no
  // credential - see the test below that they answer.
  assert.match(script, new RegExp(`MCP_URL="${base}/mcp"`));
  for (const tool of ["discover", "open_session", "name_session"]) {
    assert.match(script, new RegExp(tool), `the line says nothing about ${tool}`);
  }

  // What it still does, which is the whole of what it is for: every hook
  // that reports a session as it happens.
  for (const hook of ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStop"]) {
    assert.match(script, new RegExp(`"${hook}"`), `the script no longer installs the ${hook} hook`);
  }

  // And the line the Executors page prints is the same bare one.
  const { body } = await call("/api/ingest");
  assert.equal(body.token, null, "there is no token to mint, so none is minted");
  assert.match(body.connect.command, /curl -fsSL http:\/\/127\.0\.0\.1:\d+\/setup\.sh \| sh$/);
  assert.equal(body.connect.places.length, 1, "the other places are platforms that take a token to paste");
});

// -------------------------------------------- what a machine reports here

const str = (value) => ({ stringValue: value });
const int = (value) => ({ intValue: String(value) });
const dbl = (value) => ({ doubleValue: value });
const bool = (value) => ({ boolValue: value });

/** One Claude Code log event, as its exporter writes it. */
const logEvent = (name, at, attrs) => ({
  timeUnixNano: String(at * 1e6),
  body: str(name),
  attributes: Object.entries({
    "event.name": str(name),
    "event.timestamp": str(new Date(at).toISOString()),
    "session.id": str("local-1"),
    "prompt.id": str("p-1"),
    ...attrs,
  }).map(([key, value]) => ({ key, value })),
});

const logsPayload = (records) => ({
  resourceLogs: [
    {
      resource: { attributes: [{ key: "service.name", value: str("claude-code") }] },
      scopeLogs: [{ scope: { name: "com.anthropic.claude_code" }, logRecords: records }],
    },
  ],
});

let sessionId;

test("a session reported with no credential reaches every page", async () => {
  // The hooks, as the shipper sends them: a batch, in order, one session
  // from its first breath to its last.
  const hooks = await post("/api/harness/session", {
    events: [
      { event: "start", session: "local-1", repo: "git@github.com:ada/engine.git", branch: "main", machine: "Adas-MBP", platform: "" },
      { event: "prompt", session: "local-1", input: { session_id: "local-1", prompt: "Make the deploy script idempotent" } },
      { event: "tool", session: "local-1", input: { session_id: "local-1", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "npm test" } } },
      { event: "done", session: "local-1", input: { session_id: "local-1", tool_name: "Bash", tool_use_id: "t1", tool_response: { stdout: "ok" } } },
      { event: "stop", session: "local-1", transcript: ['{"type":"assistant","message":{"content":[{"type":"text","text":"Done."}]}}'] },
      { event: "end", session: "local-1", input: { session_id: "local-1", reason: "exit" } },
    ],
  });
  assert.equal(hooks.status, 200, JSON.stringify(hooks.body));
  sessionId = hooks.body.noted[0].session;
  assert.deepEqual(hooks.body.noted[0].machine, { id: "laptop:Adas-MBP", name: "Adas-MBP", host: "laptop" });

  // And the export, which is where the tool's duration and the model's cost
  // come from. Same `session.id`, so it lands on the session the hooks made.
  const now = Date.now();
  const exported = await post(
    "/otlp/v1/logs",
    logsPayload([
      logEvent("claude_code.tool_result", now - 2000, { tool_name: str("Bash"), success: bool(true), duration_ms: int(120) }),
      logEvent("claude_code.api_request", now - 1000, {
        model: str("claude-sonnet-5"), cost_usd: dbl(0.0123), duration_ms: int(1800), input_tokens: int(1200), output_tokens: int(300),
      }),
    ]),
  );
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  assert.deepEqual(exported.body.sessions, [sessionId], "the export joined the session its hooks opened");

  // Executors: one machine, found rather than declared.
  const executors = await call("/api/executors");
  assert.equal(executors.status, 200);
  assert.equal(executors.body.executors.length, 1);
  const [machine] = executors.body.executors;
  assert.equal(machine.id, "setup:laptop:Adas-MBP");
  assert.equal(machine.kind, "setup");
  assert.equal(machine.sessions, 1);

  // Performance: it ranks. The work is in a repository nobody registered
  // here - nobody registers one here - so a page that only counted a
  // workspace's own repos would rank nothing at all.
  const ranking = await call("/api/performance?range=7d&by=sessions");
  assert.equal(ranking.status, 200);
  assert.equal(ranking.body.rows.length, 1, "the ranking is empty, which is the where-filter hiding this edition's only kind of work");
  assert.equal(ranking.body.rows[0].key, sessionId);

  // Search: a word out of the prompt finds it, once the index has settled.
  const found = await eventually('searching for "idempotent" finds the session that was asked it', async () => {
    const answer = await call("/api/search?q=idempotent&range=all");
    return answer.body.hits?.find((hit) => hit.session?.id === sessionId) ?? null;
  });
  // And it is marked for what it is: work in a repository nobody registered
  // here, which is what nearly every session on a laptop is.
  assert.equal(found.session.where, "external");

  // Tools: Bash is a tool the harness runs itself rather than one this app
  // lent it, so it is the native line rather than a row (tool-stats.js) -
  // but it is counted, which is what the page is for.
  const tools = await call("/api/tools?range=7d");
  assert.equal(tools.status, 200);
  assert.equal(tools.body.tools.native.calls, 1);
  assert.equal(tools.body.tools.native.tools, 1);

  // And the session opens, with what was asked in it.
  const detail = await call(`/api/sessions/${sessionId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.session.id, sessionId);
  const log = await call(`/api/sessions/${sessionId}/events?since=0`);
  assert.ok(
    log.body.events.some((entry) => String(entry.text ?? "").includes("Make the deploy script idempotent")),
    "the session opened without the prompt that started it",
  );
});

test("three machines are seated, the fourth is told why not, and forgetting one makes room", async () => {
  const start = (machine, session) => post("/api/harness/session", { event: "start", session, machine });

  const onBoxTwo = await start("box-2", "local-2");
  assert.equal(onBoxTwo.status, 200);
  assert.equal((await start("box-3", "local-3")).status, 200);

  const refused = await start("box-4", "local-4");
  assert.equal(refused.status, 409, "the fourth machine was seated over the cap");
  assert.match(refused.body.error.message, /seats 3 executors/);
  assert.match(refused.body.error.message, /Forget a setup/, "the refusal has to say how to make room");

  // Refused, not half-done: the list is still three.
  const seated = await call("/api/executors");
  assert.equal(seated.body.executors.length, 3);

  // Forget one. Its row goes - a seat that is free with the row still on
  // the page is two answers to "how many machines is this" - and its
  // sessions stay, because they happened.
  const forgotten = await call("/api/executors/setup%3Alaptop%3Abox-2", { method: "DELETE" });
  assert.equal(forgotten.status, 200);
  assert.equal((await call("/api/executors/setup%3Alaptop%3Abox-2", { method: "DELETE" })).status, 404, "forgetting twice is a 404, not a second forget");
  assert.equal((await call("/api/executors/ingest", { method: "DELETE" })).status, 400, "only a machine that reported here can be forgotten");

  const after = await call("/api/executors");
  assert.equal(after.body.executors.length, 2);
  assert.ok(!after.body.executors.some((row) => row.id === "setup:laptop:box-2"), "the forgotten machine is still on the list");

  // And the place is genuinely free.
  assert.equal((await start("box-4", "local-4b")).status, 200);
  assert.equal((await call("/api/executors")).body.executors.length, 3);

  // The sessions that ran on the forgotten machine are untouched: forgetting
  // is the person saying that setup is over, not that the work never
  // happened.
  const its = await call(`/api/sessions/${onBoxTwo.body.session}`);
  assert.equal(its.status, 200, "forgetting a machine took its sessions with it");
});

test("the addresses this edition serves are its own, and the ones it does not are gone", async () => {
  for (const url of ["/", "/executors", "/executors/setup%3Alaptop%3AAdas-MBP", "/performance", "/performance/harnesses", "/search", "/tools", "/tools/run_command", "/connectors"]) {
    const page = await call(url);
    assert.equal(page.status, 200, url);
    assert.match(page.body, /local\.js/, `${url} is the console`);
  }
  // One session has an address and no link in the column.
  assert.match((await call(`/activity/${sessionId}`)).body, /local\.js/);

  // And the pages that belong to the hosted product are not here at all -
  // not a stub, not a redirect to something that half works.
  for (const url of ["/secrets", "/workspace", "/account", "/workflows", "/activity", "/sign-in", "/how-it-works", "/blog"]) {
    assert.equal((await call(url)).status, 404, `${url} should not be served by the local edition`);
  }

  // The static handler still answers for what the page loads.
  for (const asset of ["/local.js", "/console.css", "/styles.css", "/shell.js"]) {
    assert.equal((await call(asset)).status, 200, asset);
  }
});

// ----------------------------------------------- the git host, connected

test("a git host connected with a token makes a merge a fact this edition knows", async () => {
  // Nothing is connected, and every host is offered - with no token in the
  // answer, which is the one thing that must be true of this route however
  // it is asked.
  const before = await call("/api/git-hosts");
  assert.equal(before.status, 200);
  assert.deepEqual(before.body.hosts.map((row) => row.host), ["github", "gitlab", "bitbucket"]);
  assert.ok(before.body.hosts.every((row) => row.connected === false && row.account === null));
  assert.equal(JSON.stringify(before.body).includes(gitlab.state.token), false);

  // A token the host refuses comes back as the host's own sentence, on the
  // request that pasted it - not a 500, and nothing kept.
  const wrong = await post("/api/git-hosts/gitlab", { token: "glpat-not-the-one" });
  assert.equal(wrong.status, 401);
  assert.match(wrong.body.error, /GitLab did not accept that token/);
  assert.match(wrong.body.error, /read_api/, "and says what the token has to be able to do");
  assert.equal((await call("/api/git-hosts")).body.hosts.find((row) => row.host === "gitlab").connected, false);

  // One that cannot be a GitLab token at all never reaches GitLab.
  assert.equal((await post("/api/git-hosts/gitlab", { token: "ghp_wrong-host" })).status, 400);
  // And a host this app does not know is a 404.
  assert.equal((await post("/api/git-hosts/sourcehut", { token: "x" })).status, 404);

  // A session on this machine, in a checkout of the GitLab project, on a
  // branch. Nothing says a merge request was ever opened: the branch is the
  // whole of the link.
  const hooks = await post("/api/harness/session", {
    events: [
      { event: "start", session: "gl-1", repo: "git@gitlab.com:ada/platform/engine.git", branch: "feature/x", machine: "Adas-MBP", platform: "" },
      { event: "prompt", session: "gl-1", input: { session_id: "gl-1", prompt: "Make the clock idempotent" } },
      { event: "end", session: "gl-1", input: { session_id: "gl-1", reason: "exit" } },
    ],
  });
  assert.equal(hooks.status, 200, JSON.stringify(hooks.body));
  const glSession = hooks.body.noted[0].session;
  assert.equal(hooks.body.noted[0].repo, "ada/platform/engine", "a GitLab remote used to name no repository at all");
  assert.equal(hooks.body.noted[0].host, "gitlab");

  // GitLab holds a merged merge request from that branch.
  gitlab.state.add({
    iid: 12,
    title: "Make the clock idempotent",
    state: "merged",
    source_branch: "feature/x",
    merged_at: "2026-09-10T09:00:00.000Z",
    updated_at: "2026-09-10T09:00:00.000Z",
  });

  // The token, pasted. The connection says who it is, asked of GitLab
  // rather than typed in.
  const connected = await post("/api/git-hosts/gitlab", { token: gitlab.state.token });
  assert.equal(connected.status, 200, JSON.stringify(connected.body));
  assert.equal(connected.body.account, "ada");
  const listed = (await call("/api/git-hosts")).body.hosts.find((row) => row.host === "gitlab");
  assert.equal(listed.connected, true);
  assert.equal(listed.account, "ada");
  assert.equal(listed.at != null, true);

  // Ask now rather than in five minutes - the Check now button's route.
  const swept = await post("/api/git-hosts/gitlab/sync", {});
  assert.equal(swept.status, 200, JSON.stringify(swept.body));
  assert.deepEqual(swept.body.failed, []);

  // And the whole point of the page: the session's work is merged, on the
  // page that counts merges.
  const detail = await call(`/api/sessions/${glSession}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.session.outcome, "merged");
  assert.equal(detail.body.session.pulls[0].host, "gitlab");
  assert.equal(detail.body.session.pulls[0].number, 12);

  // And on the page that ranks the work: a merged merge request is a
  // finished piece of work, which is what Performance counts (see
  // server/performance.js - a task, not a pull request).
  const ranking = await call("/api/performance?range=7d&by=sessions");
  const row = ranking.body.rows.find((entry) => entry.key === glSession);
  assert.ok(row, "the session is not on the ranking at all");
  assert.equal(row.tasks, 1, "the merge request is the piece of work this session took on");
  assert.equal(row.finished, 1, "and it finished, which this edition could not have known without the token");

  // Disconnecting stops the asking and leaves what was folded alone.
  assert.equal((await call("/api/git-hosts/gitlab", { method: "DELETE" })).status, 200);
  assert.equal((await call("/api/git-hosts/gitlab", { method: "DELETE" })).status, 404, "twice is not a second forget");
  assert.equal((await post("/api/git-hosts/gitlab/sync", {})).status, 404, "and there is nothing left to ask");
  assert.equal((await call(`/api/sessions/${glSession}`)).body.session.outcome, "merged", "the record is what happened, and stays");
});

test("it refuses to start on an address other machines can reach", async () => {
  // Refused rather than ignored: somebody who set BIND_HOST meant it, and a
  // console with no sign-in on 0.0.0.0 is the one failure this edition
  // cannot recover from. The sentence has to name the variable, or a person
  // reading one line of output has nothing to act on.
  const port = await freePort();
  const refused = spawn(process.execPath, ["server/local.js"], {
    cwd: root,
    env: bare({ PORT: String(port), CODERVIBES_DATA_DIR: dataDir, BIND_HOST: "0.0.0.0" }),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let said = "";
  refused.stderr.on("data", (chunk) => {
    said += chunk;
  });
  const code = await new Promise((resolve) => refused.on("exit", resolve));
  assert.notEqual(code, 0, "it started anyway");
  assert.match(said, /BIND_HOST/);
  assert.match(said, /127\.0\.0\.1/);
});

// ------------------------------------------------------- reading the source
//
// What the two files say about themselves, which no request can show: that
// the column is four pages in one order, that the client's addresses are the
// server's, and that neither names a page this edition does not have.

const html = await read("public", "local.html");
const entry = await read("public", "local.js");
const serverEntry = await read("server", "local.js");
const gitHostsPage = await read("public", "page-git-hosts.js");
const css = await read("public", "console.css");

const COLUMN = ["executors", "performance", "search", "tools", "connectors"];

test("the column is five pages, in the order the edition puts them in", () => {
  const order = [...html.matchAll(/data-page="([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(order, COLUMN, "the column is a different set or a different order");
  // One session is an address with no link, so it is in the page set and
  // not in the column.
  assert.match(entry, /activity: \{ path: "\/activity"/);
  assert.doesNotMatch(html, /data-page="activity"/);
});

test("every page the client knows is a page the server serves, and the reverse", () => {
  const known = [...entry.matchAll(/^  ([a-z]+): \{ path: "(\/[a-z]+)"/gm)].map((match) => match[2]);
  assert.deepEqual(known, ["/executors", "/performance", "/search", "/tools", "/connectors", "/activity"]);
  // The server's own list, as it hands them to `consolePage`. Each page's
  // bare address and whatever it takes under it.
  const routes = [...serverEntry.matchAll(/^  "(\/[^"]*)",$/gm)].map((match) => match[1]);
  assert.deepEqual(routes, [
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
  ]);
  for (const page of known) {
    if (page === "/activity") continue; // one session only; the bare address is Search
    assert.ok(routes.includes(page), `the client can navigate to ${page}, which the server does not serve`);
  }
});

test("neither file links to a page, a panel or a sign-in this edition does not have", () => {
  // Not a style rule: a link to /connectors here is a 404 a person finds by
  // pressing it, and an `initAuth` is a Firebase SDK fetched on a machine
  // that has nothing to sign into. Matched on what a browser would act on -
  // an href, a data-page, a call - rather than on the words, so that a
  // comment saying which of these the edition leaves out is still allowed to
  // name them.
  // Connectors is not on this list any more: this edition has one, and it
  // is its own page (page-git-hosts.js) rather than the full console's.
  for (const page of ["secrets", "workspace", "account", "workflows", "sign-in", "how-it-works", "blog"]) {
    assert.ok(!html.includes(`href="/${page}"`), `local.html links to /${page}`);
    assert.ok(!html.includes(`data-page="${page}"`), `local.html has a column entry for ${page}`);
    assert.ok(!entry.includes(`pathFor("${page}"`), `local.js navigates to ${page}`);
    assert.ok(!entry.includes(`"/${page}"`), `local.js knows the address /${page}`);
  }
  // The gate is the sign-in, the pitch and the blog; this edition has none
  // of the three, so it has neither element and calls nothing that would
  // fill them.
  assert.ok(!html.includes('id="console-gate"'));
  assert.ok(!html.includes('id="gate-page"'));
  for (const call of ["initAuth(", "signOutFirebase(", "api.signOut(", "api.connectors(", "api.secrets("]) {
    assert.ok(!entry.includes(call), `local.js calls ${call}`);
  }
  // And the reads a refresh does are the two there are: no secrets read,
  // which would 404 on every tick, and the git hosts read by the page that
  // shows them rather than by every refresh.
  assert.match(entry, /readAlways: \(\) => \[api\.session\(\), api\.executors\(\)\]/);
  assert.ok(entry.includes("api.gitHosts(") === false, "the entry reads the hosts through its page module, not itself");
  assert.match(gitHostsPage, /api\s*\n?\s*\.gitHosts\(\)/, "which is where the read is");
});

test("the Connectors page keeps its form on a phone, where every other cell is dropped", () => {
  // The durable half of "checked at both widths". A row keeps exactly one
  // cell below 860px (console.css), and on this page that cell is the form
  // - the only control it has. Three pages once shipped with their whole
  // contents unreachable at 390px and it read as the feature not working,
  // so what holds this is an assertion over the source rather than a
  // screenshot taken once.
  assert.match(gitHostsPage, /keep: true/, "the form's cell is the one a phone keeps");
  assert.ok(
    !/statusCell\(/.test(gitHostsPage),
    "the status is a chip in the name, not a second kept cell - a phone shows only the first",
  );
  assert.match(gitHostsPage, /git-hosts-table/, "and the table says which it is, so its columns can differ");

  // The two rules that makes true, both in the one stylesheet and both at
  // the one breakpoint this app has.
  const phone = css.slice(css.indexOf("@media (max-width: 860px)"));
  assert.match(css.slice(0, css.indexOf("@media (max-width: 860px)")), /\.git-hosts-table \{/, "the desktop columns come before the phone block, so the phone block still wins");
  assert.match(phone, /\.git-hosts-table \{[^}]*grid-template-columns: minmax\(0, 1fr\)/, "and on a phone the row stacks: the name on one line, the form on the next");
  assert.match(css, /\.git-host-form,\n\.git-host-actions \{[\s\S]*?flex-wrap: wrap;/, "the form wraps here and nowhere else");
});

test("the local console is the same grid as the full one, so the phone rules reach it", () => {
  // There is no second stylesheet and no second breakpoint: console.css's
  // one 860px block turns the rail into a scrolling strip and drops every
  // table cell but the name, and it does that by class. A page that built
  // its own frame would be a page with no phone layout and nothing on
  // screen to say so.
  for (const sheet of ["/styles.css", "/console.css"]) {
    assert.ok(html.includes(`href="${sheet}"`), `local.html does not load ${sheet}`);
  }
  const phone = css.slice(css.indexOf("@media (max-width: 860px)"));
  for (const klass of ["console", "app-sidebar", "sidebar-nav", "sidebar-link", "console-main"]) {
    assert.match(html, new RegExp(`class="[^"]*\\b${klass}\\b`), `local.html does not use .${klass}, which the phone block moves`);
    assert.match(phone, new RegExp(`\\.${klass}[\\s,{]`), `.${klass} has no phone rule any more; local.html is built on it`);
  }
  assert.ok(!html.includes("<style"), "local.html carries its own styles, which is a second place for the breakpoint to be wrong");
});
