// An action the owner approves by hand, one call at a time.
//
// The record only: which calls are gated, what one call is (the tool and
// its arguments, hashed), what a call finds waiting for it, and what a
// decision writes. The chain through a server - the gate in mcp.js holding
// a call, the owner's buttons on Home, the room hearing - is in
// task-waits.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ActionApprovalError,
  DENIAL_MS,
  KEEP_MS,
  MAX_APPROVALS,
  MAX_ARGS_CHARS,
  USE_MS,
  argsLine,
  askFirstOf,
  check,
  cleanAskFirst,
  decide,
  describe,
  find,
  forAgent,
  keyOf,
  needsApproval,
  open,
  wakeKey,
} from "../server/action-approvals.js";
import { waitFor } from "../server/wake.js";

const OWNER = "ada@example.com";
const makeRepo = () => ({
  id: "r1",
  owner: OWNER,
  agents: [
    { id: "a1", name: "Nomad", permissions: ["push_to_github", "merge_pull_request"], askFirst: ["merge_pull_request", "create_repo"] },
    { id: "a2", name: "Scout", permissions: ["merge_pull_request"] },
  ],
});
const nomad = (repo) => repo.agents[0];
const merge = { tool: "merge_pull_request", permission: "merge_pull_request", args: { number: 12, method: "squash" } };

test("a call is gated when the agent holds the permission and the owner marked it; the mark alone gates nothing", () => {
  const repo = makeRepo();
  assert.deepEqual(askFirstOf(nomad(repo)), ["merge_pull_request", "create_repo"]);
  assert.deepEqual(askFirstOf({}), []);
  assert.deepEqual(askFirstOf(null), []);
  assert.ok(needsApproval(nomad(repo), "merge_pull_request"));
  assert.ok(!needsApproval(nomad(repo), "create_repo"), "marked but not held: the refusal comes first, not the gate");
  assert.ok(!needsApproval(nomad(repo), "push_to_github"), "held but not marked");
  assert.ok(!needsApproval(nomad(repo), null), "membership is never gated");
  assert.ok(!needsApproval(repo.agents[1], "merge_pull_request"), "an agent with no mark asks for nothing");
});

test("the owner's list is kept to catalogue ids an agent can hold, in catalogue order, without the reads a write implies", () => {
  assert.deepEqual(cleanAskFirst(["merge_pull_request", "no_such_thing", "push_to_github", "merge_pull_request", 42], { owner: OWNER }), ["push_to_github", "merge_pull_request"]);
  assert.deepEqual(cleanAskFirst("merge_pull_request"), [], "a list, or nothing");
  assert.deepEqual(cleanAskFirst(["assistant"]), [], "a person's permission is not an agent's to be asked about");
});

test("one call is the tool and its arguments, however the arguments were spelled", () => {
  const a = keyOf("merge_pull_request", { number: 12, method: "squash" });
  assert.equal(a, keyOf("merge_pull_request", { method: "squash", number: 12 }), "key order does not matter");
  assert.notEqual(a, keyOf("merge_pull_request", { number: 13, method: "squash" }), "a different number is a different call");
  assert.notEqual(a, keyOf("merge_pull_request", { number: 12, method: "merge" }));
  assert.notEqual(a, keyOf("other_tool", { number: 12, method: "squash" }));
  assert.equal(keyOf("t", { a: [1, { b: 2, c: 3 }] }), keyOf("t", { a: [1, { c: 3, b: 2 }] }), "nested keys too");
  assert.notEqual(keyOf("t", { a: [1, 2] }), keyOf("t", { a: [2, 1] }), "but an array's order is the call's");
  assert.equal(keyOf("t", undefined), keyOf("t", {}));
  assert.match(a, /^[0-9a-f]{32}$/);
});

test("the first call asks and writes the record; the same call again waits; a different call asks on its own", () => {
  const repo = makeRepo();
  const t0 = Date.parse("2026-09-05T10:00:00Z");
  const first = check(repo, nomad(repo), { ...merge, taskId: "t1" }, t0);
  assert.equal(first.verdict, "asked");
  assert.match(first.record.id, /^ap_[0-9a-f]{12}$/);
  assert.deepEqual(
    { agentId: first.record.agentId, agentName: first.record.agentName, tool: first.record.tool, permission: first.record.permission, args: first.record.args, taskId: first.record.taskId, state: first.record.state, at: first.record.at },
    { agentId: "a1", agentName: "Nomad", tool: "merge_pull_request", permission: "merge_pull_request", args: { number: 12, method: "squash" }, taskId: "t1", state: "open", at: "2026-09-05T10:00:00.000Z" },
  );
  assert.equal(first.record.summary, "Merging #12", "one line for the row, from the activity feed's words");
  assert.equal(first.record.key, keyOf("merge_pull_request", merge.args));

  const again = check(repo, nomad(repo), { ...merge, args: { method: "squash", number: 12 } }, t0 + 1000);
  assert.equal(again.verdict, "wait");
  assert.equal(again.record, first.record, "the same call finds its own ask, not a second one");
  assert.equal(repo.approvals.length, 1);

  const other = check(repo, nomad(repo), { ...merge, args: { number: 13, method: "squash" } }, t0 + 2000);
  assert.equal(other.verdict, "asked");
  assert.notEqual(other.record.id, first.record.id);
  // Another agent's identical call is its own ask: the approval is of a call by somebody.
  const scout = check(repo, repo.agents[1], merge, t0 + 3000);
  assert.equal(scout.verdict, "asked");
  assert.deepEqual(open(repo).map((entry) => entry.id), [first.record.id, other.record.id, scout.record.id], "oldest first");
  assert.deepEqual(forAgent(repo, "a1").map((entry) => entry.id), [other.record.id, first.record.id], "an agent's, newest first");
  assert.equal(find(repo, first.record.id), first.record);
  assert.equal(find(repo, "ap_nope"), null);
});

test("an approval lets that call run once and is used up; the next identical call asks again", async () => {
  const repo = makeRepo();
  const t0 = Date.parse("2026-09-05T10:00:00Z");
  const { record } = check(repo, nomad(repo), merge, t0);
  assert.throws(() => decide(repo, "ap_nope", { by: OWNER, approve: true }), (err) => err instanceof ActionApprovalError && err.status === 404);

  // The gate holding the call is rung by the decision.
  const rung = waitFor([wakeKey(record.id)], { timeoutMs: 2000 });
  decide(repo, record.id, { by: OWNER, approve: true, note: "  squash is  right " }, t0 + 5000);
  assert.equal(await rung, true);
  assert.deepEqual(
    { state: record.state, decidedAt: record.decidedAt, by: record.by, note: record.note },
    { state: "approved", decidedAt: "2026-09-05T10:00:05.000Z", by: OWNER, note: "squash is right" },
  );
  assert.throws(() => decide(repo, record.id, { by: OWNER, approve: false }), /already approved/);

  const run = check(repo, nomad(repo), merge, t0 + 6000);
  assert.equal(run.verdict, "run");
  assert.equal(run.record, record);
  assert.equal(record.state, "done");
  assert.equal(record.usedAt, "2026-09-05T10:00:06.000Z");

  const twice = check(repo, nomad(repo), merge, t0 + 7000);
  assert.equal(twice.verdict, "asked", "an approval is for one call; the next one asks");
  assert.notEqual(twice.record.id, record.id);
  assert.equal(describe(repo, record).state, "done");
  assert.equal(describe(repo, record).label, "Merge pull requests");
  assert.equal(describe(repo, null), null);
});

test("an approval nobody uses lapses; a denial answers the same call for a while and then it may ask again", () => {
  const repo = makeRepo();
  const t0 = Date.parse("2026-09-05T10:00:00Z");
  const { record } = check(repo, nomad(repo), merge, t0);
  decide(repo, record.id, { by: OWNER, approve: true }, t0 + 1000);
  const late = check(repo, nomad(repo), merge, t0 + 1000 + USE_MS);
  assert.equal(late.verdict, "asked", "too late: a fresh ask");
  assert.equal(record.state, "lapsed", "and the old approval says so");

  const asked = late.record;
  decide(repo, asked.id, { by: OWNER, approve: false, note: "not on a Friday" }, t0 + 2000 + USE_MS);
  assert.equal(asked.state, "denied");
  const refused = check(repo, nomad(repo), merge, t0 + 3000 + USE_MS);
  assert.equal(refused.verdict, "denied");
  assert.equal(refused.record, asked);
  assert.equal(repo.approvals.filter((entry) => entry.state === "open").length, 0, "a refused call writes no new ask");
  const later = check(repo, nomad(repo), merge, t0 + 2000 + USE_MS + DENIAL_MS);
  assert.equal(later.verdict, "asked", "the denial has run its course; the owner is asked again");
  // A denied call with other arguments was never refused.
  const different = check(repo, nomad(repo), { ...merge, args: { number: 12, method: "merge" } }, t0 + 4000 + USE_MS);
  assert.equal(different.verdict, "asked");
});

test("long arguments are kept clipped, described whole for the row, and the repo forgets old decided ones", () => {
  const repo = makeRepo();
  const t0 = Date.parse("2026-09-05T10:00:00Z");
  const body = "x".repeat(MAX_ARGS_CHARS + 100);
  const { record } = check(repo, nomad(repo), { tool: "merge_pull_request", permission: "merge_pull_request", args: { number: 1, body } }, t0);
  assert.ok(record.args._clipped, "too long to keep whole");
  assert.equal(record.args._clipped.length, MAX_ARGS_CHARS + 1);
  assert.equal(record.key, keyOf("merge_pull_request", { number: 1, body }), "the key is of the whole call");

  assert.equal(argsLine({ number: 12, method: "squash" }), 'number: 12 · method: "squash"');
  assert.equal(argsLine({ list: [1, 2], deep: { a: 1 } }), "list: [1,2] · deep: {\"a\":1}");
  assert.ok(argsLine({ body }).length <= 200);
  assert.equal(argsLine(null), "");

  const old = new Date(t0 - KEEP_MS - 1000).toISOString();
  const recent = new Date(t0 - 1000).toISOString();
  repo.approvals = [
    { id: "ap_stale", agentId: "a1", agentName: "Nomad", tool: "t", permission: "p", args: {}, key: "k1", summary: "t", at: old, state: "denied", decidedAt: old },
    { id: "ap_kept", agentId: "a1", agentName: "Nomad", tool: "t", permission: "p", args: {}, key: "k2", summary: "t", at: old, state: "done", decidedAt: recent },
    { id: "ap_open", agentId: "a2", agentName: "Scout", tool: "t", permission: "p", args: {}, key: "k3", summary: "t", at: old, state: "open" },
  ];
  check(repo, nomad(repo), merge, t0);
  assert.deepEqual(repo.approvals.map((entry) => entry.id).slice(0, 2), ["ap_kept", "ap_open"], "stale decided ones swept; the old open one stays");

  const full = makeRepo();
  full.approvals = Array.from({ length: MAX_APPROVALS }, (_, i) => ({
    id: `ap_${i}`, agentId: "a2", agentName: "Scout", tool: "t", permission: "p", args: {}, key: `k${i}`, summary: "t", at: recent, state: i === 0 ? "open" : "denied", decidedAt: recent,
  }));
  check(full, nomad(full), merge, t0);
  assert.equal(full.approvals.length, MAX_APPROVALS);
  assert.equal(full.approvals[0].id, "ap_0", "the open one at the front survives");
  assert.ok(!full.approvals.some((entry) => entry.id === "ap_1"), "the oldest decided one went");
});
