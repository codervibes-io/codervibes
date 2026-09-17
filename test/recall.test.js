// The context cache (server/recall.js): that a prompt finds the past turn
// that did the thing, as a turn and not as the forty-prompt session around
// it; that the question carries the branch; that a fortnight-old turn
// outranks a month-old one and a turn from a session that ended in a pull
// request outranks one that did not; that the asking session never hears
// of itself and the owner's reading rule is the last word; that a prompt
// with nothing in it is not asked about; and that the block handed back
// names the session to open and what the turn ran.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.CODERVIBES_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "codervibes-recall-"));
process.env.CODERVIBES_STORE = "json";
const search = await import("../server/search.js");
const recall = await import("../server/recall.js");
const sessionLog = await import("../server/sessions.js");
const sessionEvents = await import("../server/session-events.js");

const { searchInternals } = search;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

test.beforeEach(() => {
  searchInternals.reset();
  delete process.env.LITELLM_BASE_URL;
  delete process.env.LITELLM_API_KEY;
});

/** A turn document the way turnDocuments makes one, by hand. */
function turn({ session, index = 0, title, calls = [], said = "", at, owner = "ada", repoId = "r1", pulls = null, tools = ["Bash"] }) {
  return {
    id: `turn:${session}:${index}`,
    kind: "turn",
    title,
    text: `Asked: ${title}\n\nCalls: ${calls.join("; ")}\n\nSaid: ${said}`,
    at,
    tools,
    connectors: [],
    skills: [],
    session: { id: session, owner, repoId, actor: { kind: "harness", id: "h1", name: "Grid" }, state: "ended", startedAt: at, endedAt: at + 60_000, pulls },
    turn: { index, at, endAt: at + 60_000, calls, said },
  };
}

test("turnDocuments cuts a session's log at each prompt: the ask, what ran under it, what was said, and when", () => {
  const session = { id: "s1", owner: "ada", repoId: "r1", state: "ended", startedAt: NOW - DAY, endedAt: NOW };
  const events = [
    { kind: "user_message_chunk", text: "deploy main to prod", at: NOW - DAY },
    { kind: "tool_call", tool: "Bash", title: "git fetch", at: NOW - DAY + 1000 },
    { kind: "tool_call", tool: "Bash", title: "fly deploy --remote-only", at: NOW - DAY + 2000 },
    { kind: "agent_message_chunk", text: "v42 is live.", at: NOW - DAY + 3000 },
    { kind: "platform.status", status: "running", at: NOW - DAY + 3500 },
    { kind: "user_message_chunk", text: "now check healthz", at: NOW - DAY + 4000 },
    { kind: "tool_call", tool: "Bash", title: "curl https://x/healthz", at: NOW - DAY + 5000 },
  ];
  const docs = search.turnDocuments(session, events);
  assert.equal(docs.length, 2);
  assert.deepEqual(docs.map((d) => d.id), ["turn:s1:0", "turn:s1:1"]);
  assert.equal(docs[0].kind, "turn");
  assert.equal(docs[0].title, "deploy main to prod");
  assert.deepEqual(docs[0].turn.calls, ["Bash: git fetch", "Bash: fly deploy --remote-only"]);
  assert.equal(docs[0].turn.said, "v42 is live.");
  assert.equal(docs[0].at, NOW - DAY);
  assert.equal(docs[0].turn.endAt, NOW - DAY + 3000, "a turn ends with its last call or word, not at the next prompt");
  assert.match(docs[0].text, /^Asked: deploy main to prod\n\nReached for: Bash\n\nCalls: Bash: git fetch; Bash: fly deploy --remote-only\n\nSaid: v42 is live\./);
  assert.deepEqual(docs[1].turn.calls, ["Bash: curl https://x/healthz"]);
  assert.equal(docs[1].turn.said, "");
  assert.equal(docs[0].session.id, "s1");
  assert.equal(search.turnDocuments(session, [{ kind: "tool_call", tool: "Bash", title: "ls" }]).length, 0, "a call before any prompt belongs to no turn");
});

test("a turn is off the Search page and the discover tool unless asked for: the page's kinds are the default", async () => {
  await search.index(turn({ session: "s1", title: "deploy main to prod", calls: ["Bash: fly deploy"], at: NOW - DAY }));
  await search.index({ id: "session:s1", kind: "session", title: "deploy main to prod", text: "Asked: deploy main to prod", at: NOW - DAY, session: { id: "s1", owner: "ada", repoId: "r1", state: "ended" } });
  const page = await search.query("deploy");
  assert.deepEqual(page.hits.map((h) => h.doc.id), ["session:s1"]);
  const turns = await search.query("deploy", { kinds: ["turn"] });
  assert.deepEqual(turns.hits.map((h) => h.doc.id), ["turn:s1:0"]);
  assert.deepEqual(search.KINDS, ["session", "turn", "connector", "tool", "skill"]);
  assert.deepEqual(search.PAGE_KINDS, ["session", "connector", "tool", "skill"]);
});

test("recall hands back the turn that did the thing, with what it ran and its session, and never the asking session's own", async () => {
  await search.index(turn({ session: "s-deploy", title: "deploy main to prod", calls: ["Bash: git fetch", "Bash: fly deploy --remote-only"], said: "Release v42 is live.", at: NOW - 2 * DAY }));
  await search.index(turn({ session: "s-tests", title: "make the suite green", calls: ["Bash: npm test"], said: "Green.", at: NOW - DAY }));
  await search.index(turn({ session: "s-me", title: "deploy main to prod", calls: ["Bash: fly deploy"], at: NOW - 3600_000 }));
  const { hits } = await recall.recall("deploy main to prod please", { session: "s-me" });
  assert.deepEqual(hits.map((h) => h.doc.id), ["turn:s-deploy:0"]);
  const block = recall.contextOf(hits, { origin: "https://cv.example" });
  assert.match(block, /^## Done here before\n/);
  assert.match(block, /1\. "deploy main to prod" - Grid, \d{4}-\d{2}-\d{2}, session s-deploy https:\/\/cv\.example\/activity\/s-deploy/);
  assert.match(block, /ran: Bash: git fetch; Bash: fly deploy --remote-only/);
  assert.match(block, /ended: Release v42 is live\./);
  assert.match(block, /open_session <id>/, "the instruction travels with the data");
  assert.equal(recall.contextOf([]), "", "nothing found is nothing said");
  assert.deepEqual(recall.hookOutput("x"), { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "x" } });
});

test("the branch's words go into the question, so a prompt that says nothing of the feature still finds the branch's own turns", async () => {
  await search.index(turn({ session: "s-hooks", title: "spool the hook events and ship them later", calls: ["Edit: server/setup-script.js"], at: NOW - DAY }));
  await search.index(turn({ session: "s-other", title: "fix the phone layout", calls: ["Edit: public/console.css"], at: NOW - DAY }));
  const bare = await recall.recall("fix it", { branch: "hooks-spool-and-ship" });
  assert.equal(bare.hits[0]?.doc.session.id, "s-hooks", "the branch's turn first; 'fix' alone would have put the layout fix level with it");
  const other = await recall.recall("fix it", { branch: "phone-layout" });
  assert.equal(other.hits[0]?.doc.session.id, "s-other");
});

test("newer turns and turns that ended in a pull request outrank the same words from longer ago and from work that went nowhere", async () => {
  await search.index(turn({ session: "s-old", title: "rotate the gateway key", calls: ["Bash: fly secrets set"], at: NOW - 40 * DAY }));
  await search.index(turn({ session: "s-new", title: "rotate the gateway key", calls: ["Bash: fly secrets set"], at: NOW - DAY }));
  const byAge = await recall.recall("rotate the gateway key", { now: NOW });
  assert.deepEqual(byAge.hits.map((h) => h.doc.session.id), ["s-new", "s-old"]);

  searchInternals.reset();
  await search.index(turn({ session: "s-nowhere", title: "rotate the gateway key", calls: ["Bash: fly secrets set"], at: NOW - DAY }));
  await search.index(turn({ session: "s-merged", title: "rotate the gateway key", calls: ["Bash: fly secrets set"], at: NOW - DAY, pulls: [{ number: 7, state: "merged" }] }));
  const byOutcome = await recall.recall("rotate the gateway key", { now: NOW });
  assert.deepEqual(byOutcome.hits.map((h) => h.doc.session.id), ["s-merged", "s-nowhere"]);
});

test("one turn a session, three sessions at most, and only sessions the owner may read", async () => {
  for (let i = 0; i < 5; i += 1) await search.index(turn({ session: "s-many", index: i, title: `deploy attempt ${i}`, calls: ["Bash: fly deploy"], at: NOW - DAY + i }));
  for (const [id, owner] of [["s-a", "ada"], ["s-b", "ada"], ["s-c", "ada"], ["s-d", "ada"], ["s-secret", "bob"]]) {
    await search.index(turn({ session: id, title: "deploy to prod", calls: ["Bash: fly deploy"], at: NOW - 2 * DAY, owner, repoId: null }));
  }
  const { hits } = await recall.recall("deploy to prod", { allow: (session) => session.owner === "ada" });
  assert.equal(hits.length, recall.LIMIT);
  assert.equal(new Set(hits.map((h) => h.doc.session.id)).size, hits.length, "no session twice");
  assert.ok(!hits.some((h) => h.doc.session.id === "s-secret"), "bob's session is not offered to ada's agent");
});

test("what a session was offered is counted on its record, read defensively like every other count", () => {
  const record = sessionLog.open({ kind: "harness", owner: "ada", actor: { kind: "harness", id: "h1", name: "Grid" } });
  assert.deepEqual(sessionLog.recallOf(record), { asked: 0, offered: 0, hits: 0 });
  assert.deepEqual(sessionLog.recallOf({ counts: {} }), { asked: 0, offered: 0, hits: 0 }, "a record from before this existed");
  sessionLog.noteRecall(record.id, { offered: 3 });
  sessionLog.noteRecall(record.id, { offered: 0 });
  sessionLog.noteRecall(record.id, { offered: 1 });
  assert.deepEqual(sessionLog.recallOf(record), { asked: 3, offered: 4, hits: 2 });
  assert.equal(sessionLog.noteRecall("ses_nobody", { offered: 1 }), null);
});

test("a prompt with nothing in it is not asked about", () => {
  for (const nothing of ["", "yes", "ok", "sounds good", "Sounds good, go ahead", "/clear", "https://linkedin.com/in/somebody", "👍"]) {
    assert.equal(recall.worthAsking(nothing), false, JSON.stringify(nothing));
  }
  for (const something of ["deploy", "fix the phone layout", "why does the suite hang on macOS", "rotate secret"]) {
    assert.equal(recall.worthAsking(something), true, JSON.stringify(something));
  }
});

test("a session's turns are indexed with it from its log, replaced whole when it grows, and their vectors kept on the record with the session's", async () => {
  const embedded = [];
  searchInternals.useEmbedder({ model: "fake", embed: async (texts) => { embedded.push(texts.length); return texts.map((t) => search.normalize([t.length % 7, 1, 2])); } });
  const record = sessionLog.open({ kind: "harness", owner: "ada", actor: { kind: "harness", id: "h1", name: "Grid" }, at: NOW - DAY });
  sessionEvents.append(record.id, "user_message_chunk", { text: "deploy main to prod" }, { at: NOW - DAY });
  sessionEvents.append(record.id, "tool_call", { tool: "Bash", title: "fly deploy" }, { at: NOW - DAY + 1000 });
  sessionEvents.append(record.id, "user_message_chunk", { text: "check healthz" }, { at: NOW - DAY + 2000 });
  await search.indexSession(record.id);
  assert.deepEqual(search.turnsOf(record.id).map((d) => d.title), ["deploy main to prod", "check healthz"]);
  assert.equal(embedded.length, 0, "a live session is not embedded, nor are its turns");
  sessionEvents.append(record.id, "tool_call", { tool: "Bash", title: "curl /healthz" }, { at: NOW - DAY + 3000 });
  sessionLog.end(record.id, { at: NOW - DAY + 4000 });
  await search.indexSession(record.id);
  assert.deepEqual(search.turnsOf(record.id).map((d) => d.turn.calls), [["Bash: fly deploy"], ["Bash: curl /healthz"]]);
  assert.deepEqual(embedded, [2, 1], "ended: the two turns as one list, then the session");
  const stored = await sessionLog.get(record.id);
  assert.equal(stored.search.model, "fake");
  assert.equal(stored.search.turns.length, 2, "one packed vector a turn, beside the session's");
  searchInternals.reset();
  searchInternals.useEmbedder({ model: "fake", embed: async () => assert.fail("the stored vectors are reused, not remade") });
  await search.indexSession(record.id);
  assert.equal(search.turnsOf(record.id).length, 2);
  assert.ok(search.turnsOf(record.id).every((d) => d.vector), "the turns' vectors came back from the record");
});
