// The kinds of work a session may say it is - a vocabulary, and the rule
// that nothing off it ever lands on a record.
//
// There is no classifier to test: the word comes from the agent, through
// name_session (test/mcp-local.test.js), and what this holds is the list
// itself and the reader that turns whatever an agent typed into one of the
// eight or into nothing.
import test from "node:test";
import assert from "node:assert/strict";

const { KINDS, WORDS, MEANING, LABEL, UNSAID, kindIn, described } = await import("../server/work-kinds.js");

test("eight kinds, the four a team asked for first, and each one means something", () => {
  assert.deepEqual(WORDS, ["code", "incident", "analysis", "experiment", "review", "question", "ops", "writing"]);
  for (const [word, meaning] of KINDS) {
    assert.equal(MEANING[word], meaning);
    assert.ok(meaning.length > 20, `${word} needs a meaning an agent can pick by`);
    assert.ok(LABEL[word], `${word} needs a name for its row`);
  }
  assert.equal(LABEL[UNSAID], "Unsaid", "the sessions that never said are a row, and it is named");
  assert.ok(!WORDS.includes(UNSAID), "unsaid is the remainder, not a kind an agent may say");
  // The tool's description lists every word, so an agent reading it can pick one.
  for (const word of WORDS) assert.match(described(), new RegExp(`\\b${word} - `));
});

test("a kind is read out of whatever the agent wrapped it in, and a word off the list is nothing", () => {
  for (const word of WORDS) assert.equal(kindIn(word), word);
  assert.equal(kindIn("Code."), "code");
  assert.equal(kindIn('"incident"'), "incident");
  assert.equal(kindIn('{"kind": "ops"}'), "ops");
  assert.equal(kindIn("  Analysis \n"), "analysis");
  assert.equal(kindIn("bugfix"), null, "a ninth word of the agent's own is not a kind");
  assert.equal(kindIn("code review"), "code", "the first word is the word - the agent was asked for one");
  assert.equal(kindIn(""), null);
  assert.equal(kindIn(null), null);
  assert.equal(kindIn(undefined), null);
});
