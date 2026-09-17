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

  // It is also found by the name of the tool that ran, as the harness
  // showed it: this app records a `Bash` as `run_command` (the row above
  // and the Tools page below both say so), and a person who searched for
  // what was on their screen got nothing at all until both names were
  // words of the document (search.js `HARNESS_NAMES`).
  const byTool = await call("/api/search?q=Bash&range=all&kind=session");
  assert.ok(byTool.body.hits.some((hit) => hit.session?.id === sessionId), `searching for Bash found ${byTool.body.hits.length} sessions`);

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

  // Activity: the same page the hosted product has, answered from the same
  // route (pages/activity.js). The session ended, so it is under Finished
  // recently and not under Working now; and nothing waits on a person,
  // whatever the cloud would have put there - this edition has no tasks,
  // no approvals and no merge to offer, so the seam answers with none
  // (scope.js `waitingRows`) and the page draws no Needs action section.
  const activity = await call("/api/home");
  assert.equal(activity.status, 200, JSON.stringify(activity.body));
  assert.deepEqual(activity.body.working, []);
  assert.deepEqual(activity.body.waiting, []);
  assert.equal(activity.body.finished.length, 1);
  assert.equal(activity.body.finished[0].id, sessionId);
  assert.equal(activity.body.finished[0].where, "external", "the where-filter default would hide this edition's only kind of work");
  assert.equal(activity.body.finished[0].machine?.name, "Adas-MBP");
  assert.equal(activity.body.finished[0].files, undefined, "a finished row is a line in a table, not the session's page");
});

test("a prompt asks what was done here before and gets the turn that did it - with what it ran and the session to open - or nothing at all", async () => {
  // The session above ended; its one turn is indexed once the index settles.
  const deadline = Date.now() + 5000;
  let answer;
  for (;;) {
    answer = await post("/api/harness/recall", { session: "local-2", branch: "deploy-idempotent", origin: base, input: { session_id: "local-2", prompt: "make the deploy script safe to run twice" } });
    if (answer.status === 200 || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const block = answer.body.hookSpecificOutput.additionalContext;
  assert.equal(answer.body.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(block, /^## Done here before\n/);
  assert.match(block, new RegExp(`1\\. "Make the deploy script idempotent" - .*, session ${sessionId} ${base}/activity/${sessionId}`));
  assert.match(block, /ran: run_command: npm test/, "the calls are the payload: what the turn ran, by the ingest's names");
  assert.match(block, /ended: Done\./);
  assert.match(block, /open_session <id>/, "the instruction travels with the data");

  // A prompt with nothing in it is not asked about, and the asking session is never handed itself.
  const filler = await post("/api/harness/recall", { session: "local-2", input: { session_id: "local-2", prompt: "sounds good, go ahead" } });
  assert.equal(filler.status, 204);
  const self = await post("/api/harness/recall", { session: "local-1", input: { session_id: "local-1", prompt: "make the deploy script safe to run twice" } });
  assert.equal(self.status, 204, "local-1 is the session that did it; it has its own transcript");
});

test("three machines are seated, the fourth is told why not, and forgetting one makes room", async () => {
  const start = (machine, session) => post("/api/harness/session", { event: "start", session, machine });

  const onBoxTwo = await start("box-2", "local-2");
  assert.equal(onBoxTwo.status, 200);
  assert.equal((await start("box-3", "local-3")).status, 200);

  // Two sessions that started and have not ended are what Activity calls
  // Working now - each with where it runs, since "who is working, and on
  // what machine" is the page's first question.
  const activity = await call("/api/home");
  assert.deepEqual(activity.body.working.map((row) => row.machine?.name).sort(), ["box-2", "box-3"]);
  assert.ok(activity.body.working.every((row) => row.state === "live" && row.now), "a live row carries what it is doing this second");

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

test("a machine's page has somewhere to send you: a search takes one machine and answers with its sessions alone", async () => {
  // A second machine with work on it, so that "this machine's sessions" is
  // a question with a wrong answer available. box-4 is seated already, by
  // the test above.
  const elsewhere = await post("/api/harness/session", {
    events: [
      { event: "start", session: "local-5", repo: "git@github.com:ada/engine.git", branch: "main", machine: "box-4", platform: "" },
      { event: "prompt", session: "local-5", input: { session_id: "local-5", prompt: "Tidy the changelog" } },
      { event: "end", session: "local-5", input: { session_id: "local-5", reason: "exit" } },
    ],
  });
  assert.equal(elsewhere.status, 200, JSON.stringify(elsewhere.body));
  const onBoxFour = elsewhere.body.noted[0].session;

  // The link a machine's page draws (console-connect.js `setupDetail`):
  // the machine's id and no question at all, since Search opens
  // unfiltered. Before this there was no such link and no such facet, so
  // a machine's page said "1 session" and ended there.
  const mine = await eventually("the machine's sessions are indexed", async () => {
    const answer = await call("/api/search?machine=laptop%3AAdas-MBP&range=all");
    return answer.body.hits?.length ? answer.body : null;
  });
  assert.deepEqual(mine.hits.map((hit) => hit.session?.id), [sessionId], "what ran on this machine, and nothing else");
  // With the name on it: the link carries an id, and the chip that says
  // what the list is narrowed to should say what the reader calls it.
  assert.deepEqual(mine.machine, { id: "laptop:Adas-MBP", name: "Adas-MBP" });

  const theirs = await eventually("the other machine's session is indexed", async () => {
    const answer = await call("/api/search?machine=laptop%3Abox-4&range=all");
    return answer.body.hits?.length ? answer.body : null;
  });
  const onIt = theirs.hits.map((hit) => hit.session?.id);
  assert.ok(onIt.includes(onBoxFour), `box-4's own session is on its list: ${onIt}`);
  assert.ok(!onIt.includes(sessionId), "and this machine's is not");

  // A question narrows inside the machine rather than replacing it.
  const asked = await call("/api/search?q=idempotent&machine=laptop%3Abox-4&range=all");
  assert.deepEqual(asked.body.hits, [], "the deploy session is not box-4's answer");
  // And a machine nothing ran on is an empty list with the id on the chip,
  // not a page quietly showing everything.
  const gone = await call("/api/search?machine=laptop%3Anever&range=all");
  assert.deepEqual(gone.body.hits, []);
  assert.deepEqual(gone.body.machine, { id: "laptop:never", name: null });
});

test("the addresses this edition serves are its own, and the ones it does not are gone", async () => {
  for (const url of ["/", "/executors", "/executors/setup%3Alaptop%3AAdas-MBP", "/performance", "/performance/harnesses", "/search", "/activity", `/activity/${sessionId}`, "/tools", "/tools/run_command", "/connectors"]) {
    const page = await call(url);
    assert.equal(page.status, 200, url);
    assert.match(page.body, /local\.js/, `${url} is the console`);
  }

  // And the pages that belong to the hosted product are not here at all -
  // not a stub, not a redirect to something that half works.
  for (const url of ["/secrets", "/workspace", "/account", "/workflows", "/sign-in", "/how-it-works", "/blog"]) {
    assert.equal((await call(url)).status, 404, `${url} should not be served by the local edition`);
  }

  // The static handler still answers for what the page loads.
  for (const asset of ["/local.js", "/console.css", "/styles.css", "/shell.js"]) {
    assert.equal((await call(asset)).status, 200, asset);
  }
});

test("an address this edition has not got is answered in its own voice, with the six pages on it", async () => {
  // Express's own answer is `Cannot GET /sessions/abc` in Times New Roman:
  // the one thing this edition ever shows that does not look like the app,
  // and it names none of the pages - so somebody who guessed an address
  // (`/sessions/<id>` rather than `/activity/<id>`, say) has nothing to do
  // next but guess again.
  const missed = await call(`/sessions/${sessionId}`);
  assert.equal(missed.status, 404);
  assert.doesNotMatch(missed.body, /Cannot GET/);
  assert.match(missed.body, /console\.css/, "the page is not drawn in the console's own style");
  for (const page of ["/executors", "/performance", "/search", "/activity", "/tools", "/connectors"]) {
    assert.match(missed.body, new RegExp(`href="${page}"`), `the 404 does not offer ${page}`);
  }
  assert.match(missed.body, new RegExp(`/sessions/${sessionId}`), "it does not say which address it is about");

  // Not a redirect: an address that does not exist is worth being told
  // about once, rather than landing on Executors wondering what happened to
  // the link.
  assert.equal(missed.status, 404);

  // Under /api it stays JSON, whatever asked for it was code - an HTML body
  // there is how a fetch fails with "Unexpected token <" and says nothing
  // about the address being wrong.
  const api = await call("/api/nothing-here");
  assert.equal(api.status, 404);
  assert.match(api.body.error, /No such address: GET \/api\/nothing-here/);
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

test("a shell that exports to this installation does not make this installation export to itself", async () => {
  // Step 5 of the installer writes OTEL_EXPORTER_OTLP_ENDPOINT=<origin>/otlp
  // into ~/.codervibes/env and makes .profile, .bashrc and .zshrc source it,
  // for the coding agents on the machine. So the *next* shell has it, and
  // the next `node server/local.js` - the re-run of the installer, or the
  // "start again" line it printed - is started with it. telemetry.js reads
  // the variable as it loads and asks for an OTLP exporter the open-source
  // cut does not ship, so the second run of the installer said "Stopped it."
  // and started a server that died on ERR_MODULE_NOT_FOUND: the console a
  // person had just been reading went away and the script said nothing.
  const port = await freePort();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codervibes-exporting-"));
  const started = spawn(process.execPath, ["server/local.js"], {
    cwd: root,
    env: bare({
      PORT: String(port),
      CODERVIBES_DATA_DIR: home,
      // What the env file the installer wrote holds, verbatim - pointed at a
      // port nothing is on, because nothing should try to reach it.
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1/otlp",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer nothing",
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    }),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let said = "";
  started.stderr.on("data", (chunk) => {
    said += chunk;
  });
  try {
    const deadline = Date.now() + 20_000;
    let up = false;
    while (Date.now() < deadline && !up) {
      if (started.exitCode !== null) break;
      up = await fetch(`http://127.0.0.1:${port}/healthz`).then((res) => res.status === 200, () => false);
      if (!up) await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.equal(up, true, `it did not come up: ${said}`);
    assert.doesNotMatch(said, /ERR_MODULE_NOT_FOUND/);
    // And it says nothing about it: the person set that variable for their
    // agents, which still read it, and a line about a variable they never
    // typed at this server explains nothing.
    assert.doesNotMatch(said, /OTEL/);
  } finally {
    started.kill("SIGTERM");
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
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
// the column is six pages in one order, that the client's addresses are the
// server's, and that neither names a page this edition does not have.

const html = await read("public", "local.html");
const entry = await read("public", "local.js");
const serverEntry = await read("server", "local.js");
const gitHostsPage = await read("public", "page-git-hosts.js");
const css = await read("public", "console.css");
const edition = await read("public", "console-edition.js");
const toolsSource = await read("public", "console-tools.js");

const COLUMN = ["executors", "performance", "search", "activity", "tools", "connectors"];

test("the column is six pages, in the order the edition puts them in", () => {
  const order = [...html.matchAll(/data-page="([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(order, COLUMN, "the column is a different set or a different order");
  // Activity is a page with a link, and one session is the address under
  // it - the same address the hosted console gives a session, so a link
  // copied out of one opens in the other.
  assert.match(entry, /activity: \{ path: "\/activity", kind: "session", title: "Activity" \}/);
  assert.match(entry, /pane\.append\(back\(pathFor\("activity"\)\)\);/, "back from a session goes to Activity");
});

test("the Evaluations page is the hosted product's: this edition has no link to it, and its Performance page says where it is by name", async () => {
  // The page is the loop a team runs on its repositories (server/pages/
  // evaluations.js) and the one thing the free edition points at rather
  // than leaving off in silence - by name, never by address: the
  // open-source cut carries no address it would call (test/local-cut.test.js).
  assert.doesNotMatch(html, /data-page="evaluations"/, "the column links to a page this edition has not got");
  assert.doesNotMatch(entry, /evaluations: \{ path:/, "the router knows a page this edition has not got");
  assert.doesNotMatch(entry, /page-evaluations\.js/);
  assert.match(entry, /onePerson\(\)/);
  const performance = await read("public", "console-performance.js");
  assert.match(performance, /import \{[^}]*hasEvaluations[^}]*\} from "\.\/console-edition\.js"/);
  assert.match(performance, /if \(hasEvaluations\(\)\) \{/);
  assert.match(performance, /on the hosted edition at codervibes\.io\./, "the line names where the page is");
  assert.doesNotMatch(performance, /https:\/\/codervibes\.io/, "and not as an address the cut would carry");
  assert.match(performance, /pane\.append\(evaluationsLine\(\{ onOpen, pathFor \}\)\);/, "and the line is on the page");
});

test("every page the client knows is a page the server serves, and the reverse", () => {
  const known = [...entry.matchAll(/^  ([a-z]+): \{ path: "(\/[a-z]+)"/gm)].map((match) => match[2]);
  assert.deepEqual(known, ["/executors", "/performance", "/search", "/activity", "/tools", "/connectors"]);
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
    "/activity",
    "/activity/:sessionId",
    "/tools",
    "/tools/:toolName",
    "/connectors",
  ]);
  for (const page of known) {
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

test("the export variables are dropped before a module that reads them is loaded, and the exporter is therefore unreachable", async () => {
  // The order is the whole of it. Every import in server/local.js is dynamic
  // so that the environment is settled before anything reads it; the same
  // reasoning says the unsetting has to come before the first of them, or
  // telemetry.js has already read the variable and asked for the package.
  const unset = serverEntry.indexOf("delete process.env[name]");
  assert.ok(unset > 0, "the entry drops the OTEL_* family");
  assert.match(serverEntry, /name\.startsWith\("OTEL_"\) \|\| name === "CLAUDE_CODE_ENABLE_TELEMETRY"/);
  assert.ok(unset < serverEntry.indexOf("await import("), "it happens before the first module that could read them");

  // Why it matters that it is unreachable rather than trimmed: telemetry.js
  // asks for the OTLP exporter behind that variable, indented, so the closure
  // does not count it as a dependency and the cut does not ship it
  // (scripts/lib/closure.mjs `loadTimePackageImports`). With the variable
  // always empty here the branch cannot be taken, which is the answer to
  // "should the package ship anyway": no - the local edition never exports.
  const telemetry = await read("server", "telemetry.js");
  assert.match(telemetry, /^if \(OTLP_ENDPOINT\) \{\n {2}const \{ OTLPTraceExporter \} = await import\("@opentelemetry\/exporter-trace-otlp-http"\);/m);
});

test("every predicate an edition can turn off is on until somebody turns it off", () => {
  // The rule the whole switch rests on: the hosted console is exactly what
  // it was. A predicate that defaulted to false - or one added to
  // `onePerson` and not to the list of `let`s - would take a panel off the
  // full product with no test failing, because the full console never calls
  // anything in this file.
  const defaults = [...edition.matchAll(/^let (\w+) = (true|false);$/gm)];
  assert.ok(defaults.length >= 6, "the edition switch has lost its state");
  for (const [, name, value] of defaults) assert.equal(value, "true", `${name} is off before anybody says so`);
  // And `onePerson()` turns off every one of them: a predicate declared and
  // never flipped is a page still saying the hosted product's words.
  const flipped = [...edition.matchAll(/^  (\w+) = false;$/gm)].map((match) => match[1]);
  assert.deepEqual(flipped.sort(), defaults.map(([, name]) => name).sort(), "onePerson does not turn off what the module holds");
  // Each is read as a call, not exported as a value: a value is read once at
  // import and a module imported before `onePerson()` ran would keep the
  // answer it was given first.
  for (const name of ["hasTasks", "hasWorkspaces", "hasAgents", "hasSandboxes", "hasAccessTrail", "hasConnectorTools", "hasEvaluations"]) {
    assert.match(edition, new RegExp(`export const ${name} = \\(\\) =>`), `${name} is not a predicate`);
  }
});

test("the entry says what this edition has none of before a page is drawn, and the pages read it", async () => {
  // The finding this answers: a fresh local install ranked its one account
  // on an Adoption ladder, offered Sandbox as something to compare, kept a
  // column for who invited an agent, promised an access trail of who did
  // what under which permission, and headed its ranking with tasks that
  // nothing here hands out. Every one of those is the full console's page
  // module saying the full product's words.
  //
  // Source-read because there is no DOM here, and at the entry because the
  // call has to happen at import time: a switch flipped inside `start()`
  // would be flipped after the page modules had already been imported, and
  // a module that had read a predicate on the way in would keep the wrong
  // answer.
  assert.match(entry, /import \{ onePerson \} from "\.\/console-edition\.js";/);
  assert.match(entry, /^onePerson\(\);$/m, "the entry does not flip the switch at module scope");

  // And each page reads the one that is about it. Named individually rather
  // than looked for in the round, because what matters is which predicate a
  // page asks: a Performance that asked `hasWorkspaces()` about its task
  // columns would be right today and wrong the moment an edition has
  // workspaces without tasks.
  const reads = [
    ["console-performance.js", ["hasTasks", "hasWorkspaces"]],
    ["page-performance.js", ["hasWorkspaces"]],
    ["console-compare.js", ["hasSandboxes", "hasTasks"]],
    ["console-trend.js", ["hasSandboxes", "hasTasks"]],
    ["page-executors.js", ["hasAgents"]],
    ["console-tools.js", ["hasConnectorTools"]],
    ["console-search.js", ["hasAccessTrail", "hasConnectorTools"]],
    ["page-search.js", ["hasAccessTrail"]],
  ];
  for (const [file, predicates] of reads) {
    const source = await read("public", file);
    for (const predicate of predicates) {
      assert.match(source, new RegExp(`import \\{[^}]*\\b${predicate}\\b[^}]*\\} from "\\./console-edition\\.js"`), `${file} does not take ${predicate} from the one module`);
      assert.match(source, new RegExp(`${predicate}\\(\\)`), `${file} imports ${predicate} and never asks it`);
    }
  }

  // The four that were the finding, each pinned to the thing it decides -
  // so that a later edit which drops the branch fails here rather than
  // quietly putting the ladder back on a laptop.
  const performance = await read("public", "console-performance.js");
  assert.match(performance, /if \(hasWorkspaces\(\)\) pane\.append\(adoptionPanel\(/, "the Adoption ladder is drawn without asking whether there is a team");
  assert.match(performance, /hasTasks\(\)\n\s+\? \["Session", tasksHead\(\)/, "the ranking heads with tasks whether or not any are handed out");
  // And a row still keeps exactly one cell at 390px. The tasks chip was
  // the ranking's kept cell; taking it out left rows with none, and since
  // `.list-row` is `display: contents` over a two-column phone grid
  // (console.css), two sessions then shared one line with half a name each.
  // Caught in a screenshot, held here.
  assert.match(performance, /\{ keep: true, node: heatCell\(row\.cost \? money\(row\.cost\) : "—", heat\.cost\[at\]\) \}/, "the ranking has no cell a phone keeps");
  const executors = await read("public", "page-executors.js");
  assert.match(executors, /hasAgents\(\) \? \["Invited by"\] : \[\]/, "Invited by is a column even where nothing invites");
  const search = await read("public", "console-search.js");
  assert.match(search, /hasAccessTrail\(\)\n\s+\? "How did we do that, and who did what under which permission\?/, "the subtitle promises permissions unconditionally");
  const compare = await read("public", "console-compare.js");
  assert.match(compare, /DIMENSIONS\.filter\(\(entry\) => entry\.key !== "sandbox" \|\| hasSandboxes\(\)\)/);
  const trend = await read("public", "console-trend.js");
  assert.match(trend, /SPLITS\.filter\(\(split\) => split\.key !== "sandbox" \|\| hasSandboxes\(\)\)/);
  // And the charts above the ranking, which were ten readings of a task
  // apiece: seven of the twelve figures divide by one, so on a laptop the
  // top of the page was "—" over "0 tasks", nine times, in the panel whose
  // whole argument is that one bar compares with nothing.
  assert.match(compare, /hasTasks\(\) \|\| !figure\.tasks/);
  assert.match(trend, /hasTasks\(\) \|\| metric\.key !== "finished"/);
});

test("no page tells anybody a tool was in the room, because there are no rooms", () => {
  // Repo rooms went in #168 and the word outlived them on the Tools page,
  // where it was the caveat under every table and the note on two tiles. It
  // reads as a place a person could go and look at, which is the worst kind
  // of stale word: it sends somebody looking rather than only puzzling them.
  // Not local-only - the cloud has no rooms either - so this is asserted
  // over the whole of public/.
  // Matched on what a browser would draw rather than on the word: the
  // comments are allowed to say where the phrase came from and why it went,
  // which is the whole value of leaving that note behind.
  const drawn = toolsSource.replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(drawn, /in the room/, "the Tools page still puts a tool in a room");
  assert.match(drawn, /The tool was in the session it was called in/);
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

test("the refusal a host answers with is read in the panel, not cut off at the edge of the table", () => {
  // What a wrong token gets is the host's own sentence under the form
  // (page-git-hosts.js), and it is the only thing on the page that says
  // what to do next. It goes in a `.list-cell`, and a cell is one line with
  // its overflow hidden - because every other cell in this console holds a
  // fact. So "GitHub did not accept that token: Bad credentials" was shown
  // as "GitHub did not accept tha" at 1512px and worse at 390px, which is
  // the half that says nothing.
  assert.match(gitHostsPage, /form\.after\(problem\(err\.message\)\)/, "the refusal goes under the form, in the form's cell");
  const rule = css.slice(css.indexOf(".git-hosts-table .list-cell.keep {"));
  assert.ok(css.includes(".git-hosts-table .list-cell.keep {"), "nothing lets the one cell in this console that holds a sentence wrap");
  assert.match(rule.slice(0, rule.indexOf("}")), /white-space: normal/, "the cell still holds the sentence to one line");
  assert.match(rule.slice(0, rule.indexOf("}")), /flex-direction: column/, "the sentence sits under the form rather than beside it");
  // And at both widths, which is one rule rather than two: it is written
  // above the 860px block, where the phone's single column inherits it.
  assert.ok(
    css.indexOf(".git-hosts-table .list-cell.keep {") < css.indexOf("@media (max-width: 860px)"),
    "the wrapping is inside the phone block, so at 1512px the refusal is still cut off",
  );
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
