// The local edition's MCP server, driven the way a coding agent drives it.
//
// `node server/local.js` with nothing configured, and then plain `fetch` at
// `/mcp` with no Authorization header of any kind - because that is the
// claim: the agent on this machine gets three tools and is asked for no
// credential, since the door it came through already answers only to this
// machine.
//
// An HTTP test rather than a source-reading one for the reason the rest of
// test/local.test.js is: every piece works on its own (the transport, the
// three tools, the hook ingest) and none of that is evidence they work when
// an entry point bolts them together. The join in the middle is the part
// that has been wrong before - a `name_session` that named a record of the
// connection's own rather than the session the hooks were writing, so the
// name appeared on a row with no prompt in it and the real session kept the
// first line of the ask.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

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

/** The person's own environment, with everything this edition settles blanked. */
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

/**
 * One JSON-RPC request, with no credential. `session` is the transport's
 * `Mcp-Session-Id`, which the client echoes on everything after initialize.
 */
async function rpc(body, { session = null, method = "POST" } = {}) {
  const response = await fetch(`${base}/mcp`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(session ? { "Mcp-Session-Id": session } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let answer = null;
  try {
    answer = JSON.parse(text);
  } catch {
    answer = text || null;
  }
  return { status: response.status, body: answer, session: response.headers.get("mcp-session-id") };
}

const post = (pathname, body) =>
  fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));

const get = (pathname) =>
  fetch(`${base}${pathname}`).then(async (response) => ({ status: response.status, body: await response.json() }));

/** Poll until it is true. Search indexes a session a few seconds after its last line. */
async function eventually(what, check, { within = 25_000 } = {}) {
  const deadline = Date.now() + within;
  for (;;) {
    const answer = await check();
    if (answer) return answer;
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${within}ms`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** The text of a tool result, which is what a model actually reads. */
const said = (result) => (result.content ?? []).map((part) => part.text).join("\n");

let mcpSession;

test.before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codervibes-mcp-local-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["server/local.js"], {
    cwd: root,
    env: bare({ PORT: String(port), CODERVIBES_DATA_DIR: dataDir }),
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
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test("an agent opens the endpoint with no token at all, and is told what it has reached", async () => {
  const opened = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  mcpSession = opened.session;
  assert.ok(mcpSession, "initialize handed back no Mcp-Session-Id for the client to echo");

  const { result } = opened.body;
  assert.equal(result.protocolVersion, "2025-06-18", "the client's own version is echoed when we speak it");
  assert.deepEqual(result.serverInfo, { name: "codervibes-local", version: "0.1.0" });
  // Read by a model that has never seen this installation, so it has to say
  // what the three are for and - outright - what is not here, or an agent
  // that has used the hosted product reads the absence as a broken
  // connection rather than as a smaller installation.
  for (const word of ["discover", "open_session", "name_session", "no room", "nobody to hand"]) {
    assert.match(result.instructions, new RegExp(word), `initialize says nothing about "${word}"`);
  }

  // A notification gets no body, as the spec requires.
  const noted = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, { session: mcpSession });
  assert.equal(noted.status, 202);
  assert.equal(noted.body, null);
});

test("the tool list is the three, and nothing that needs other people or a connected service", async () => {
  const { body } = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { session: mcpSession });
  const names = body.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ["discover", "open_session", "name_session"], "find, read, name - in that order");
  for (const tool of body.result.tools) {
    assert.equal(tool.inputSchema.type, "object", `${tool.name} has no input schema a client can read`);
    assert.ok(tool.description.length > 80, `${tool.name}'s description is too short to choose it by`);
  }

  // A tool the hosted product has and this does not is a tool result saying
  // so, not a protocol fault: a model that gets a JSON-RPC error cannot tell
  // "that tool is not here" from "the server is broken".
  const { body: missing } = await rpc(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "send_message", arguments: { text: "hi" } } },
    { session: mcpSession },
  );
  assert.equal(missing.error, undefined);
  assert.equal(missing.result.isError, true);
  assert.match(said(missing.result), /no tool called 'send_message'/);
});

test("a batch is answered in one response, and a GET is refused with the method that is allowed", async () => {
  const { status, body } = await rpc(
    [
      { jsonrpc: "2.0", id: "a", method: "ping" },
      { jsonrpc: "2.0", id: "b", method: "tools/list" },
    ],
    { session: mcpSession },
  );
  assert.equal(status, 200);
  assert.ok(Array.isArray(body), "a batch came back as a single object");
  assert.deepEqual(body.map((answer) => answer.id), ["a", "b"]);

  // Nothing here is pushed to a client - no sampling, no roots, no tool-list
  // changes - so there is no stream to open, which the spec answers as 405.
  const stream = await fetch(`${base}/mcp`);
  assert.equal(stream.status, 405);
  assert.equal(stream.headers.get("allow"), "POST, DELETE");
});

let sessionId;

test("name_session names the session the hooks are writing, not a record of the connection's own", async () => {
  // The harness reports as it works: the session starts, the person asks for
  // something, and the agent calls one of this app's tools - which fires the
  // `tool` hook *before* the call is sent, which is what lets the endpoint
  // work out whose call this is (telemetry-ingest.js `sessionCalling`).
  const hooks = await post("/api/harness/session", {
    events: [
      { event: "start", session: "mcp-local-1", repo: "git@github.com:ada/engine.git", branch: "main", machine: "Adas-MBP", platform: "" },
      { event: "prompt", session: "mcp-local-1", input: { session_id: "mcp-local-1", prompt: "Make the deploy script idempotent" } },
      {
        event: "tool",
        session: "mcp-local-1",
        input: {
          session_id: "mcp-local-1",
          tool_name: "mcp__codervibes__name_session",
          tool_use_id: "t-name",
          tool_input: { title: "Idempotent deploy script" },
        },
      },
    ],
  });
  assert.equal(hooks.status, 200, JSON.stringify(hooks.body));
  sessionId = hooks.body.noted[0].session;

  const { body } = await rpc(
    {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "name_session", arguments: { title: "Idempotent deploy script" } },
    },
    { session: mcpSession },
  );
  assert.equal(body.result.isError, undefined, said(body.result));
  assert.match(said(body.result), /now named "Idempotent deploy script"/);

  // On the row a person actually looks at - the one with the prompt in it.
  const detail = await get(`/api/sessions/${sessionId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.session.title, "Idempotent deploy script");

  // And there is exactly one session: the whole point of the join is that
  // the endpoint did not open a second record for its own connection. Six
  // pull requests from six terminals once sat on one such record, and the
  // sessions that made them showed none.
  const ranked = await get("/api/performance?range=7d&by=sessions");
  assert.deepEqual(
    ranked.body.rows.map((row) => row.key),
    [sessionId],
    "the MCP connection opened a session of its own beside the one the hooks are writing",
  );
});

test("discover finds the session by a word out of the prompt, and open_session reads it whole", async () => {
  // The session has to have settled before the index has it (search.js), so
  // it is ended the way a terminal ends it and then asked for.
  await post("/api/harness/session", {
    events: [
      { event: "done", session: "mcp-local-1", input: { session_id: "mcp-local-1", tool_name: "mcp__codervibes__name_session", tool_use_id: "t-name", tool_response: { ok: true } } },
      { event: "stop", session: "mcp-local-1", transcript: ['{"type":"assistant","message":{"content":[{"type":"text","text":"Done."}]}}'] },
      { event: "end", session: "mcp-local-1", input: { session_id: "mcp-local-1", reason: "exit" } },
    ],
  });

  const found = await eventually('discover finds the session that was asked "idempotent"', async () => {
    const { body } = await rpc(
      { jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "discover", arguments: { query: "idempotent deploy" } } },
      { session: mcpSession },
    );
    const text = said(body.result);
    return text.includes(sessionId) ? text : null;
  });
  assert.match(found, /hit/, "the answer does not say how many it found");
  assert.match(found, /Idempotent deploy script/, "the hit is not named by what the agent called the session");
  assert.match(found, new RegExp(`${base}/activity/${sessionId}`), "a hit has to say where to read the whole of it");

  // And the whole of it: the ask, which is the thing a quote is a fragment of.
  const { body: opened } = await rpc(
    { jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "open_session", arguments: { id: sessionId } } },
    { session: mcpSession },
  );
  assert.equal(opened.result.isError, undefined, said(opened.result));
  const whole = said(opened.result);
  assert.match(whole, new RegExp(`Session ${sessionId}`));
  assert.match(whole, /Make the deploy script idempotent/, "the session opened without the prompt that started it");

  // An id nothing here has is a refusal that says where an id comes from,
  // rather than an empty answer the model reads as "there is nothing".
  const { body: nothing } = await rpc(
    { jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "open_session", arguments: { id: "ses_nothing" } } },
    { session: mcpSession },
  );
  assert.equal(nothing.result.isError, true);
  assert.match(said(nothing.result), /No session ses_nothing here/);
});

test("asked for an answer, discover says there is no model here rather than failing the call", async () => {
  // `answer: true` has the installation's own model read the hits. This one
  // has no model - that is the hosted product's - so the honest reply is a
  // line above the hits saying so. Refusing the call would throw away the
  // hits, which are what was asked for.
  const { body } = await rpc(
    { jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "discover", arguments: { query: "idempotent deploy", answer: true } } },
    { session: mcpSession },
  );
  assert.equal(body.result.isError, undefined, said(body.result));
  const text = said(body.result);
  assert.match(text, /Answers are off here/);
  assert.match(text, new RegExp(sessionId), "the hits went missing along with the answer");
});

test("an agent whose hooks are not installed still gets a session, opened at its first call", async () => {
  // Cursor, an older setup, a harness with no hook file: nothing announces
  // the call, so there is no session to join and the endpoint keeps one of
  // its own. Opened at the first call rather than at initialize - a
  // connection that never calls anything is not a session anybody wants a
  // row for. The calls above, made after the hooks' session had ended, are
  // the ones that opened it.
  const ranked = await get("/api/performance?range=7d&by=sessions");
  const mine = ranked.body.rows.map((row) => row.key).filter((key) => key !== sessionId);
  assert.equal(mine.length, 1, "either no record was kept for the unannounced calls, or one was kept per call");
  const own = await get(`/api/sessions/${mine[0]}`);
  assert.equal(own.body.session.kind, "harness", "it is the same Claude Code the hooks would have reported, reached from the other side");
  assert.match(own.body.session.actor.name, /own setup/);
});

test("the hook that announced the call can arrive after it, and the naming still lands on the session the person is working in", async () => {
  // The hooks do not post as they fire. Each writes its event to a spool and
  // a shipper posts what the spool holds in the background (setup-script.js),
  // so the PreToolUse that names `mcp__codervibes__name_session` regularly
  // reaches this process *after* the call it announced - by fourteen
  // milliseconds in the `claude -p` run that found this. The join looked for
  // an open call, found none, and opened a record of the connection's own:
  // one real session, two rows on Executors, and the name on the empty one.
  const before = (await get("/api/performance?range=7d&by=sessions")).body.rows.length;
  const started = await post("/api/harness/session", {
    events: [
      { event: "start", session: "mcp-local-late", repo: "git@github.com:ada/engine.git", branch: "main", machine: "Adas-MBP", platform: "" },
      { event: "prompt", session: "mcp-local-late", input: { session_id: "mcp-local-late", prompt: "Cut the flaky wait out of the deploy test" } },
    ],
  });
  const late = started.body.noted[0].session;

  // A connection of its own, as a fresh `claude -p` would open one, so this
  // cannot pass by riding on the session the earlier tests left open.
  const opened = await rpc({
    jsonrpc: "2.0",
    id: 50,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  });

  const { body } = await rpc(
    { jsonrpc: "2.0", id: 51, method: "tools/call", params: { name: "name_session", arguments: { title: "Flaky wait" } } },
    { session: opened.session },
  );
  assert.equal(body.result.isError, undefined, said(body.result));

  const detail = await get(`/api/sessions/${late}`);
  assert.equal(detail.body.session.title, "Flaky wait", "the name went on a record of the connection's own, which is the bug");

  const after = await get("/api/performance?range=7d&by=sessions");
  assert.equal(after.body.rows.length, before + 1, "the session is one row: the one with the prompt in it");

  // And the hook lands, late, on the session it always belonged to.
  await post("/api/harness/session", {
    events: [
      { event: "tool", session: "mcp-local-late", input: { session_id: "mcp-local-late", tool_name: "mcp__codervibes__name_session", tool_use_id: "t-late", tool_input: { title: "Flaky wait" } } },
      { event: "done", session: "mcp-local-late", input: { session_id: "mcp-local-late", tool_name: "mcp__codervibes__name_session", tool_use_id: "t-late", tool_response: { ok: true } } },
      { event: "end", session: "mcp-local-late", input: { session_id: "mcp-local-late", reason: "exit" } },
    ],
  });
  assert.equal((await get("/api/performance?range=7d&by=sessions")).body.rows.length, before + 1);
});

test("a handshake is not a session: initialize, tools/list and ping open no record at all", async () => {
  // A `curl` at /mcp to see whether it answers, a client that connects and
  // then sits there: neither is work, and each used to leave a row saying
  // "live" for as long as the process ran. A record is opened by a tool
  // call and by nothing else.
  const keys = async () => new Set((await get("/api/performance?range=7d&by=sessions")).body.rows.map((row) => row.key));
  const before = await keys();
  const opened = await rpc({
    jsonrpc: "2.0",
    id: 60,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "curl", version: "0" } },
  });
  await rpc({ jsonrpc: "2.0", id: 61, method: "tools/list" }, { session: opened.session });
  await rpc({ jsonrpc: "2.0", id: 62, method: "ping" }, { session: opened.session });
  assert.deepEqual([...await keys()], [...before], "a handshake left a row behind");

  // And when one is opened, leaving ends it: a session that is over is over
  // whether the client says goodbye (DELETE) or stops answering, which the
  // transport's own sweep catches at the thirty-minute TTL.
  const { body } = await rpc(
    { jsonrpc: "2.0", id: 63, method: "tools/call", params: { name: "discover", arguments: { query: "nothing at all" } } },
    { session: opened.session },
  );
  assert.equal(body.result.isError, undefined, said(body.result));
  const after = [...await keys()].filter((key) => !before.has(key));
  assert.equal(after.length, 1, "the first tool call is where a connection with no hooks behind it becomes a session");
  assert.equal((await get(`/api/sessions/${after[0]}`)).body.session.state, "live");

  await rpc(null, { session: opened.session, method: "DELETE" });
  const gone = await eventually("the record the connection opened is ended when the connection goes", async () => {
    const detail = await get(`/api/sessions/${after[0]}`);
    return detail.body.session.state === "ended" ? detail : null;
  });
  assert.ok(gone, "a connection record left live is a row saying somebody is working when nobody is");
});

test("a DELETE ends the session, and the next call on it is told to initialize again", async () => {
  const gone = await rpc(null, { session: mcpSession, method: "DELETE" });
  assert.equal(gone.status, 204);

  const after = await rpc({ jsonrpc: "2.0", id: 40, method: "tools/list" }, { session: mcpSession });
  assert.equal(after.status, 404, "an id the server has forgotten has to say so, or the client waits forever");
  assert.match(after.body.error.message, /initialize again/);

  // And a fresh one works, which is the whole of what a dropped session costs.
  const again = await rpc({
    jsonrpc: "2.0",
    id: 41,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  });
  assert.equal(again.status, 200);
  assert.ok(again.session);
  assert.notEqual(again.session, mcpSession);
});
