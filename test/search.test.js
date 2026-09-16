// Discover's index (server/search.js): that a question in words finds the
// session that did the thing, by the names it reached for as much as by
// what was said; that the semantic half adds what the words miss and is
// off, and says so, without a proxy; that a session's document is built
// from its log and its spans and rebuilt as the log grows; that vectors
// survive a restart on the record; and that the caller's word on who may
// see what is the last word.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// A store of this test's own: the JSON store next to the app is the
// default, and sessions from another run in it would be indexed too.
process.env.CODERVIBES_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "codervibes-search-"));
process.env.CODERVIBES_STORE = "json";
const search = await import("../server/search.js");
const sessionLog = await import("../server/sessions.js");
const sessionEvents = await import("../server/session-events.js");

const { searchInternals } = search;

test.beforeEach(() => {
  searchInternals.reset();
  delete process.env.LITELLM_BASE_URL;
  delete process.env.LITELLM_API_KEY;
});

/** A small deterministic embedder: a bag of hand-picked concepts, so "ship to prod" and "deploy" are neighbours. */
const CONCEPTS = [
  ["deploy", ["deploy", "ship", "release", "prod", "production", "fly_deploy", "rollout"]],
  ["test", ["test", "suite", "assert", "green", "flaky"]],
  ["auth", ["login", "sign", "oauth", "token", "password"]],
  ["sandbox", ["sandbox", "e2b", "machine", "vm"]],
];
function conceptVector(text) {
  const words = String(text).toLowerCase().split(/[^a-z0-9_]+/);
  const values = CONCEPTS.map(([, names]) => words.filter((word) => names.includes(word)).length);
  if (!values.some(Boolean)) values.push(1);
  else values.push(0);
  return search.normalize(values);
}
const fakeEmbedder = () => ({ model: "fake-concepts", embed: async (texts) => texts.map(conceptVector) });

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

/**
 * Wait for something to be true, rather than for a number of milliseconds.
 *
 * A session's document settles through the sessions store and the events
 * store, and the sweep that rebuilds an ended one runs on its own timer, so
 * "the index has caught up" is a condition and never a duration. It was a
 * duration - 30ms after the schedule, 80 for the sweep - and on a busy
 * machine, with the whole suite's stores queueing writes behind it, those
 * were not always enough: this test failed about one run in three and said
 * "indexed once it settled" about an index that was a few milliseconds
 * behind rather than wrong.
 */
async function until(ready, said, { timeout = 5000, every = 5 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await ready();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(said);
    await new Promise((resolve) => setTimeout(resolve, every));
  }
}

async function seed() {
  await search.index({
    id: "session:s-deploy",
    kind: "session",
    title: "Ship v42 to production",
    text: "Asked: can you get v42 out?\n\nReached for: fly_deploy, e2b_shell, fly\n\nSaid: Built the image on the e2b sandbox and ran fly_deploy against the codervibes app. Release v42 is live.",
    at: NOW - 2 * DAY,
    tools: ["fly_deploy", "e2b_shell"],
    connectors: ["fly", "e2b"],
    session: { id: "s-deploy", owner: "ada", repoId: "r1", actor: { kind: "agent", id: "a1", name: "Grid" }, state: "ended", startedAt: NOW - 2 * DAY, endedAt: NOW - 2 * DAY + 60000 },
  });
  await search.index({
    id: "session:s-tests",
    kind: "session",
    title: "Make the suite green again",
    text: "Asked: the tests are flaky\n\nSaid: Two asserts raced a store write; polled instead. Suite green.",
    at: NOW - 1 * DAY,
    tools: ["Bash"],
    session: { id: "s-tests", owner: "ada", repoId: "r1", actor: { kind: "agent", id: "a1", name: "Grid" }, state: "ended", startedAt: NOW - DAY, endedAt: NOW - DAY + 1000 },
  });
  await search.index({
    id: "session:s-private",
    kind: "session",
    title: "Rotate the sign-in secret",
    text: "Asked: rotate the oauth token\n\nSaid: Done, the login works.",
    at: NOW - 3 * DAY,
    session: { id: "s-private", owner: "bob", repoId: "r2", actor: { kind: "person", id: "bob", name: "Bob" }, state: "ended", startedAt: NOW - 3 * DAY, endedAt: NOW - 3 * DAY + 1000 },
  });
  await search.indexCatalog({
    connectors: [{ id: "fly", label: "Fly.io", hint: "Apps, machines, releases and deploys on Fly.", tools: [{ name: "fly_deploy", description: "Deploy an app from a sandbox." }] }],
    tools: [{ name: "fly_deploy", description: "Deploy an app from a sandbox.", connector: "fly", connectorLabel: "Fly.io" }],
    skills: [{ name: "codervibes-deploy", sessions: 3 }],
  });
}

test("the words are split the way tool names are written, stop words go, and endings fold: deploying, deployed and fly_deploy are one word", () => {
  assert.deepEqual(search.tokenize("How do I trigger a deploy?"), ["trigger", "deploy"]);
  assert.deepEqual(search.tokenize("fly_deploy e2b_start_agent"), ["fly", "deploy", "e2b", "start", "agent"]);
  assert.deepEqual(search.tokenize("Deploying was deployed by deploys"), ["deploy", "deploy", "deploy"]);
  assert.deepEqual(search.tokenize("noteSetup"), ["note", "setup"]);
});

test("a question in words finds the session that did it, by the names it reached for, and the catalogue entry beside it", async () => {
  await seed();
  const { hits, semantic } = await search.query("how do I trigger a deploy");
  assert.equal(semantic, false, "no proxy: words only");
  const ids = hits.map((hit) => hit.doc.id);
  assert.equal(ids[0], "session:s-deploy", `the session that ran fly_deploy first, got ${ids}`);
  assert.ok(ids.includes("tool:fly_deploy") && ids.includes("connector:fly"), "and the tool and connector that do it");
  assert.ok(!ids.includes("session:s-tests"), "not the session about tests");
  const first = hits[0];
  assert.deepEqual(first.terms, ["deploy"], "which words matched is said");
  assert.match(first.snippet, /fly_deploy/, "the quote is the text around the match");
  assert.equal(first.semantic, false);
});

test("the semantic half finds a paraphrase the words miss, and a document both halves find rises above one either did", async () => {
  searchInternals.useEmbedder(fakeEmbedder());
  await seed();
  // The seeded documents carry no vectors; give the sessions theirs the way indexSession would.
  for (const id of ["session:s-deploy", "session:s-tests", "session:s-private"]) {
    const doc = search.get(id);
    await search.index({ ...doc, vector: conceptVector(`${doc.title} ${doc.text}`) });
  }
  const { hits, semantic } = await search.query("ship it to prod");
  assert.equal(semantic, true);
  assert.equal(hits[0].doc.id, "session:s-deploy", "no word in common, found by meaning");
  assert.equal(hits[0].semantic, true);
  assert.deepEqual(hits[0].terms, ["ship", "prod"].filter((term) => hits[0].terms.includes(term)), "the word 'ship' is in its title too");
  const both = await search.query("deploy");
  assert.equal(both.hits[0].doc.id, "session:s-deploy");
  assert.ok(both.hits[0].terms.length && both.hits[0].semantic, "found both ways");
  // A semantic hit far from the question is noise, not a find.
  const far = await search.query("login password");
  assert.ok(!far.hits.some((hit) => hit.doc.id === "session:s-tests"), "the tests session is nothing like a login question");
});

test("without a proxy the semantic half is off and the reason is a sentence; a proxy that refuses the model is remembered the same way", async () => {
  assert.equal(search.embedder(), null);
  assert.match(search.whyNoSemantic(), /LITELLM_BASE_URL is not set/);
  assert.equal(search.describe().semantic.on, false);
  process.env.LITELLM_BASE_URL = "https://llm.example.com/v1";
  assert.match(search.whyNoSemantic(), /LITELLM_API_KEY/);
  process.env.LITELLM_API_KEY = "sk-cv";
  assert.equal(search.embedder()?.model, "text-embedding-3-small");
  assert.equal(search.whyNoSemantic(), null);
  // The proxy's refusal, as the page will say it.
  const calls = [];
  const refused = await searchInternals.proxyEmbed(["hi"], {
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return new Response('{"error":{"message":"model not found"}}', { status: 404, statusText: "Not Found" });
    },
  }).catch((err) => err);
  assert.match(refused.message, /answered 404 to text-embedding-3-small/);
  assert.equal(calls[0].url, "https://llm.example.com/v1/embeddings");
  assert.equal(calls[0].body.dimensions, search.EMBEDDING_DIMS);
  // And an answer, in the order asked, as unit vectors.
  const [a, b] = await searchInternals.proxyEmbed(["one", "two"], {
    fetch: async () => new Response(JSON.stringify({ data: [{ index: 1, embedding: [0, 2] }, { index: 0, embedding: [3, 0] }] }), { status: 200 }),
  });
  assert.deepEqual([...a], [1, 0]);
  assert.deepEqual([...b], [0, 1]);
});

test("a vector packed onto a record and unpacked ranks the same, at a quarter of the bytes", () => {
  const vector = search.normalize([0.3, -0.7, 0.1, 0.62, -0.05]);
  const packed = search.pack(vector);
  assert.equal(typeof packed, "string");
  assert.ok(Buffer.from(packed, "base64").length === 5, "one byte per dimension");
  const back = search.unpack(packed);
  let dot = 0;
  for (let i = 0; i < vector.length; i += 1) dot += vector[i] * back[i];
  assert.ok(dot > 0.999, `still the same direction: ${dot}`);
});

test("the caller's word on who may see a document is the last word, and kind and age narrow the rest", async () => {
  await seed();
  const mine = await search.query("token", { allow: (doc) => doc.kind !== "session" || doc.session.owner === "ada" });
  assert.ok(!mine.hits.some((hit) => hit.doc.id === "session:s-private"), "bob's session is not ada's to see");
  const theirs = await search.query("token", { allow: (doc) => doc.kind !== "session" || doc.session.owner === "bob" });
  assert.ok(theirs.hits.some((hit) => hit.doc.id === "session:s-private"));
  const only = await search.query("deploy", { kinds: ["connector"] });
  assert.deepEqual(only.hits.map((hit) => hit.doc.kind), ["connector"]);
  const recent = await search.query("deploy", { kinds: ["session"], since: NOW - 1.5 * DAY });
  assert.deepEqual(recent.hits, [], "the deploy session is two days old");
  assert.equal((await search.query("deploy", { limit: 1 })).hits.length, 1);
});

test("nothing asked is everything, newest first, and narrowed by the same rules a question is", async () => {
  await seed();
  const all = await search.query("   ");
  assert.ok(all.hits.length > 1, "the whole index, not an empty answer");
  const kinds = all.hits.map((hit) => hit.doc.kind);
  assert.deepEqual(kinds, [...kinds].sort((one, other) => (one === "session" ? 0 : 1) - (other === "session" ? 0 : 1)), "the sessions first: the catalogue is timeless and would otherwise flood a newest-first list");
  const times = all.hits.filter((hit) => hit.doc.kind === "session").map((hit) => hit.doc.at ?? 0);
  assert.deepEqual([...times].sort((one, other) => other - one), times, "newest first");
  assert.ok(all.hits.every((hit) => hit.terms.length === 0 && hit.semantic === false), "nothing was matched, so nothing is claimed to have matched");
  assert.ok(all.hits.every((hit) => hit.snippet === "" || hit.doc.text.replace(/\s+/g, " ").trim().startsWith(hit.snippet.replace(/…$/, ""))), "the snippet is the head of the document");
  // The same narrowing as a search: who may see it, which kind, how old.
  const mine = await search.query("", { allow: (doc) => doc.kind !== "session" || doc.session.owner === "ada" });
  assert.ok(!mine.hits.some((hit) => hit.doc.id === "session:s-private"), "bob's session is not ada's to see");
  const sessions = await search.query("", { kinds: ["session"] });
  assert.ok(sessions.hits.length > 0);
  assert.ok(sessions.hits.every((hit) => hit.doc.kind === "session"));
  const recent = await search.query("", { kinds: ["session"], since: NOW - 1.5 * DAY });
  assert.ok(recent.hits.every((hit) => hit.doc.at >= NOW - 1.5 * DAY), "an old session is not in a young range");
  assert.equal((await search.query("", { limit: 2 })).hits.length, 2);
});

test("a session's document is what was asked, what was reached for and what was said, from its log and its spans", () => {
  const session = { id: "s-9", title: "Ship it", owner: "ada", repoId: "r1", actor: { kind: "agent", id: "a1", name: "Grid" }, state: "ended", startedAt: 5, endedAt: 9 };
  const events = [
    { kind: "platform.prompt", text: "please deploy v42" },
    { kind: "agent_thought_chunk", text: "thinking about it" },
    { kind: "tool_call", title: "fly_deploy: codervibes" },
    // As the hooks write them: the name on the event, the title from the input.
    { kind: "tool_call", tool: "fly_app", title: "app: engine" },
    { kind: "tool_call", tool: "bash", title: "npm test" },
    { kind: "tool_call", tool: "tool", title: "something nameless" },
    { kind: "agent_message_chunk", text: "Deployed. " },
    { kind: "agent_message_chunk", text: "Release v42 is live." },
  ];
  const spans = [
    { attrs: { "cv.tool.name": "fly_deploy", "cv.connector.id": "fly" } },
    { attrs: { "cv.skill.name": "codervibes-deploy" } },
    { attrs: { "cv.tool.name": "fly_deploy" } },
  ];
  const doc = search.sessionDocument(session, events, spans);
  assert.equal(doc.id, "session:s-9");
  assert.equal(doc.title, "Ship it");
  assert.match(doc.text, /^Asked: please deploy v42/);
  assert.match(doc.text, /Reached for: fly_app, bash, fly_deploy, fly, codervibes-deploy/, "the hooks' names count, with no export");
  assert.match(doc.text, /Calls: fly_deploy: codervibes; fly_app: app: engine; bash: npm test; something nameless/);
  assert.match(doc.text, /Said: Deployed\. \nRelease v42 is live\.$/);
  assert.doesNotMatch(doc.text, /thinking about it/, "thoughts are not what a session said");
  assert.deepEqual(doc.tools, ["fly_app", "bash", "fly_deploy"]);
  assert.deepEqual(doc.connectors, ["fly"]);
  assert.deepEqual(doc.skills, ["codervibes-deploy"]);
  assert.deepEqual(doc.session, { id: "s-9", owner: "ada", repoId: "r1", repo: null, machine: null, actor: session.actor, state: "ended", startedAt: 5, endedAt: 9, pulls: null });
});

test("a session's document says which machine ran it, so a search can be narrowed to one", () => {
  // The machine's own page has "1 session" on it and nothing to press:
  // the way to that session is a search narrowed to this machine
  // (pages/search.js), and that is only possible if the document says
  // where the work happened.
  const machine = { id: "laptop:Adas-MBP", name: "Adas-MBP", host: "laptop" };
  const doc = search.sessionDocument({ id: "s-m", startedAt: 1, machine }, [], []);
  assert.deepEqual(doc.session.machine, machine);
});

test("a tool is a word under the harness's name for it as well as this app's: Bash finds the session that ran one", async () => {
  // A call is recorded under this app's name for it, so the index had
  // `run_command` and a person searching for the `Bash` their agent
  // showed them found nothing at all.
  const doc = search.sessionDocument(
    { id: "s-bash", title: "Green again", startedAt: NOW, state: "ended" },
    [{ kind: "platform.prompt", text: "the suite is red" }],
    [{ attrs: { "cv.tool.name": "run_command" } }, { attrs: { "cv.tool.name": "read_file" } }],
  );
  await search.index(doc);
  for (const typed of ["Bash", "run_command", "Read", "read_file"]) {
    assert.equal((await search.query(typed)).hits[0]?.doc.id, "session:s-bash", `searching for ${typed}`);
  }
  // One name on the row, though: the call happened once, and two chips
  // for it would read as two calls.
  assert.deepEqual(doc.tools, ["run_command", "read_file"]);

  // And the table is the inverse of the one that renames them
  // (telemetry-ingest.js `TOOL_NAMES`): a harness tool renamed there and
  // not here goes quietly unfindable again, which is the bug this is.
  const ingest = await fs.readFile(new URL("../server/telemetry-ingest.js", import.meta.url), "utf8");
  const table = ingest.slice(ingest.indexOf("const TOOL_NAMES = {"), ingest.indexOf("const MCP_PREFIX"));
  const renamed = [...table.matchAll(/^\s+(\w+): "(\w+)",$/gm)].map(([, from, to]) => [from, to]);
  assert.ok(renamed.length >= 13, `the table was read: ${renamed.length} entries`);
  for (const [from, to] of renamed) {
    assert.ok(search.HARNESS_NAMES[to]?.includes(from), `${from} is how a person types ${to}`);
  }
});

test("a session's document says which models it called and whose they are, and both are words the index has", async () => {
  const session = { id: "s-models", title: "Two vendors", owner: "ada", repoId: "r1", state: "ended", startedAt: 5, endedAt: 9, models: ["claude-opus-5", "gemini-2.5-pro", "claude-opus-5", ""] };
  const doc = search.sessionDocument(session, [{ kind: "platform.prompt", text: "compare them" }], []);
  assert.deepEqual(doc.models, ["claude-opus-5", "gemini-2.5-pro"], "each model once, in the order it was first called");
  assert.deepEqual(doc.providers, ["anthropic", "gemini"], "and whose they are");
  // A session that called nothing this app can place has no provider - the
  // filter's `none` is the route's word for that, not the document's.
  assert.deepEqual(search.sessionDocument({ id: "s-quiet", startedAt: 1 }, [], []).providers, []);

  // The names are searchable, which they are nowhere else: a transcript
  // says "ran it on Gemini" about as often as never, and the model id is
  // reported by the harness rather than typed by anybody.
  await search.index(doc);
  assert.equal((await search.query("gemini")).hits[0]?.doc.id, "session:s-models");
  assert.equal((await search.query("opus")).hits[0]?.doc.id, "session:s-models");
});

test("a session is indexed from the sessions module as its log lands, once it settles; ended, its vector is made and kept on the record; a stored vector is reused", async () => {
  sessionLog.sessionInternals.reset();
  sessionEvents.sessionEventInternals.reset?.();
  const embeds = [];
  searchInternals.useEmbedder({ model: "fake-concepts", embed: async (texts) => { embeds.push(...texts); return texts.map(conceptVector); } });
  const stop = search.follow({ everyMs: 20 });
  try {
    const record = sessionLog.open({ kind: "harness", owner: "ada", actor: { kind: "harness", id: "cc", name: "Claude Code" } });
    sessionEvents.append(record.id, "platform.prompt", { text: "deploy v42 to production", by: { kind: "person", id: "ada" } });
    sessionEvents.append(record.id, "agent_message_chunk", { text: "Running fly_deploy now." });
    // Not yet: the document settles after the last event.
    assert.equal(search.get(`session:${record.id}`), null);
    search.schedule(record.id, { settleMs: 0 });
    const doc = await until(() => search.get(`session:${record.id}`), "indexed once it settled");
    assert.match(doc.text, /deploy v42/);
    assert.equal(doc.session.state, "live");
    assert.equal(embeds.length, 0, "a live session is not embedded: it is still changing");
    assert.equal((await search.query("deploy")).hits[0]?.doc.id, `session:${record.id}`, "found by its words meanwhile");

    sessionLog.end(record.id);
    // The sweep sees it ended and rebuilds with the vector.
    const ended = await until(() => {
      const doc = search.get(`session:${record.id}`);
      return doc?.session.state === "ended" && doc.vector ? doc : null;
    }, "embedded once ended");
    assert.equal(embeds.length, 1);
    const kept = (await sessionLog.get(record.id)).search;
    assert.equal(kept?.model, "fake-concepts");
    assert.equal(kept.dims, ended.vector.length);

    // A restart: the record's vector is reused rather than paid for again.
    await sessionLog.flush();
    searchInternals.reset();
    searchInternals.useEmbedder({ model: "fake-concepts", embed: async (texts) => { embeds.push(...texts); return texts.map(conceptVector); } });
    process.env.CODERVIBES_EMBEDDING_MODEL = "fake-concepts";
    try {
      const n = await search.warm({ since: 0 });
      assert.ok(n >= 1);
      assert.ok(search.get(`session:${record.id}`).vector, "the vector is back");
      assert.equal(embeds.length, 1, "and was not made again");
    } finally {
      delete process.env.CODERVIBES_EMBEDDING_MODEL;
    }
  } finally {
    stop();
  }
});

test("the catalogue is replaced whole, and a session document is left alone by that", async () => {
  await seed();
  assert.equal(search.describe().indexed.connector, 1);
  await search.indexCatalog({ connectors: [], tools: [{ name: "linear_issues", description: "The issues of a Linear team." }], skills: [] });
  const { indexed } = search.describe();
  assert.deepEqual(indexed, { session: 3, connector: 0, tool: 1, skill: 0 });
  assert.ok(search.get("session:s-deploy"));
  assert.equal(search.get("connector:fly"), null);
  search.remove("session:s-deploy");
  assert.equal(search.describe().indexed.session, 2);
});

test("a document with nothing in it is never sent to the embedder, and one refusal is not the installation's news", async () => {
  // Production had this: a session with neither a title nor any text - an
  // unnamed one that recorded only a tool name - yields "" from
  // `embedTextOf`, the model refuses an empty input with a 400, and the
  // refusal was then remembered for everybody. Every reader was told
  // "Semantic search is off" and sent to add a model to the proxy's config
  // that was already there.
  const asked = [];
  searchInternals.useEmbedder({
    model: "fake-concepts",
    embed: async (texts) => {
      asked.push(...texts);
      if (texts.some((text) => !String(text).trim())) {
        const refusal = new Error("the proxy answered 400: input cannot be an empty string");
        refusal.status = 400;
        throw refusal;
      }
      return texts.map(conceptVector);
    },
  });

  // Nothing to say, so nothing is asked and no vector is kept.
  const empty = await search.index({ id: "session:blank", kind: "session", title: "", text: "", at: NOW }, { embed: true });
  assert.equal(empty.vector, undefined, "there is no vector for nothing");
  assert.deepEqual(asked, [], "the embedder was not troubled with an empty string");
  assert.equal(search.whyNoSemantic(), null, "and the installation is not told anything is wrong");

  // A document with words still gets one, and the empty one has not
  // poisoned the index.
  await search.index({ id: "session:real", kind: "session", title: "Ship v42 to production", text: "fly_deploy", at: NOW }, { embed: true });
  assert.equal(asked.length, 1);
  assert.equal(search.whyNoSemantic(), null);

  // And a 400 that does get through - the proxy complaining about what it
  // was sent - skips that document rather than turning the half off.
  searchInternals.useEmbedder({
    model: "fake-concepts",
    embed: async () => {
      const refusal = new Error("the proxy answered 400 to text-embedding-3-small: some other complaint");
      refusal.status = 400;
      throw refusal;
    },
  });
  const refused = await search.index({ id: "session:odd", kind: "session", title: "Odd one", text: "words", at: NOW }, { embed: true });
  assert.equal(refused.vector, undefined);
  assert.equal(search.whyNoSemantic(), null, "one document is not the installation");

  // A refusal that *is* about the installation is still said, because that
  // one a person can act on.
  searchInternals.useEmbedder({
    model: "fake-concepts",
    embed: async () => {
      const refusal = new Error("the proxy answered 404 to text-embedding-3-small: no such model");
      refusal.status = 404;
      throw refusal;
    },
  });
  await search.index({ id: "session:missing-model", kind: "session", title: "Another", text: "words", at: NOW }, { embed: true });
  assert.match(search.whyNoSemantic(), /Semantic search is off.*no such model/s);
});
