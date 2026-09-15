// What a task was done with: the spans under it folded into four tables.
//
// The tables are what the Tasks tab shows and what the closed task keeps, so
// what is tested is the fold - which span becomes which row, that failures
// are counted and not just calls, that a declared token figure counts as a
// model call - and that the fold says nothing an agent typed.
import test from "node:test";
import assert from "node:assert/strict";
import { fold, usedFor, isEmpty, MAX_ROWS } from "../server/task-usage.js";
import { spanInternals } from "../server/spans.js";

const span = (name, attrs, ok = true) => ({ id: `${Math.random()}`, name, ok, kind: attrs["cv.tool.kind"] ?? name.split(".")[0], attrs, at: 1, ms: 1 });

test("tool calls, connector calls, skills and model calls each fold into their own table", () => {
  const used = fold([
    span("tool.call", { "cv.tool.name": "read_file", "cv.tool.kind": "builtin", "cv.tool.args": "secret.txt" }),
    span("tool.call", { "cv.tool.name": "read_file", "cv.tool.kind": "builtin" }),
    span("tool.call", { "cv.tool.name": "github_open_pull", "cv.tool.kind": "connector" }, false),
    span("connector.call", { "cv.connector.id": "github", "cv.connector.write": true }, false),
    span("connector.call", { "cv.connector.id": "github" }),
    span("connector.call", { "cv.connector.id": "linear" }),
    span("skill.use", { "cv.skill.name": "pr-review" }),
    span("skill.use", { "cv.skill.name": "pr-review" }),
    span("model.call", { "cv.model": "claude-sonnet-5", "cv.tokens.input": 1000, "cv.tokens.output": 200 }),
    span("model.call", { "cv.model": "claude-sonnet-5", "cv.tokens.total": 300 }),
    // A figure the agent declared on update_task, on that tool call's span.
    span("tool.call", { "cv.tool.name": "update_task", "cv.tool.kind": "collab", "cv.declared": true, "cv.model": "gpt-5", "cv.tokens.input": 50 }),
    // Things that are not any of these.
    span("agent.episode", {}),
    span("tool.call", {}),
    span("model.call", {}),
  ]);
  assert.deepEqual(used.tools, [
    { name: "read_file", kind: "builtin", calls: 2, failed: 0 },
    { name: "github_open_pull", kind: "connector", calls: 1, failed: 1 },
    { name: "update_task", kind: "collab", calls: 1, failed: 0 },
  ]);
  assert.deepEqual(used.connectors, [{ id: "github", calls: 2, failed: 1 }, { id: "linear", calls: 1, failed: 0 }]);
  assert.deepEqual(used.skills, [{ name: "pr-review", calls: 2 }]);
  assert.deepEqual(used.models, [{ model: "claude-sonnet-5", calls: 2, tokens: 1500 }, { model: "gpt-5", calls: 1, tokens: 50 }]);
  assert.equal(JSON.stringify(used).includes("secret.txt"), false, "nothing typed leaves the spans");
  assert.equal(isEmpty(used), false);
  assert.equal(isEmpty(fold([])), true);
  assert.equal(isEmpty(null), true);
});

test("a table stops at MAX_ROWS, keeping the most used", () => {
  const many = [];
  for (let i = 0; i < MAX_ROWS + 5; i += 1) {
    for (let n = 0; n <= i; n += 1) many.push(span("tool.call", { "cv.tool.name": `tool-${i}` }));
  }
  const { tools } = fold(many);
  assert.equal(tools.length, MAX_ROWS);
  assert.equal(tools[0].name, `tool-${MAX_ROWS + 4}`, "the most called first");
  assert.ok(!tools.some((row) => row.name === "tool-0"), "the least called is the one dropped");
});

test("usedFor reads the task's spans", async () => {
  spanInternals.reset();
  spanInternals.ring.push(
    { ...span("tool.call", { "cv.tool.name": "search" }), task: "t-1", session: "s" },
    { ...span("tool.call", { "cv.tool.name": "search" }), task: "t-2", session: "s" },
  );
  const used = await usedFor("t-1");
  assert.deepEqual(used.tools, [{ name: "search", kind: "tool", calls: 1, failed: 0 }]);
  spanInternals.reset();
});
