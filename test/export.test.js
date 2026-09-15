// The export: the rows a spreadsheet gets, and the promises made about them.
//
// Three of those promises are worth a test each. The header is a contract -
// the columns three unmerged pull requests will fill are in it today, empty,
// so nothing downstream gains a column on the day they land. The quoting is
// RFC 4180, which is the difference between a comma in an ask and a broken
// file. And the words rule holds: a session's ask goes to a reader who may
// read it and to nobody else, with the cell left empty rather than filled
// with something else.
import test from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_COLUMNS, PULL_COLUMNS, sessionRows, pullRows, toCsv, toJson, csvCell, filenameFor,
} from "../server/export.js";
import { commandHash } from "../server/friction.js";

const NOW = Date.parse("2026-09-10T12:00:00.000Z");
const MINUTE = 60_000;

/** A harness session on a laptop, ended, with a pull request behind it. */
const session = (over = {}) => ({
  id: "ses_one",
  kind: "harness",
  state: "ended",
  owner: "ada@example.com",
  actor: { kind: "harness", id: "exec_nomad", name: "Nomad" },
  harness: { id: "h1", kind: "claude-code", name: "Claude Code" },
  repoId: "engine-a1b2c3",
  repo: { fullName: "ada/engine" },
  where: "workspace",
  machine: { id: "laptop:ada-mbp", name: "ada-mbp", host: "laptop" },
  startedAt: NOW - 30 * MINUTE,
  lastSeenAt: NOW - 10 * MINUTE,
  endedAt: NOW - 10 * MINUTE,
  taskIds: [],
  models: ["claude-opus-5"],
  counts: {
    spans: 12, tools: 9, toolsFailed: 1, modelCalls: 4, tokens: 40_000, cost: 250,
    modelTokens: { "claude-opus-5": 40_000 },
    guidance: { humanLines: 2, followUps: 1, retries: 0, failedTools: 1, reviewRounds: 1 },
  },
  files: ["src/router.ts"],
  filesTouched: 1,
  pulls: [],
  title: "Add rate-limit headers, and say why",
  ...over,
});

const pull = (over = {}) => ({
  id: "ada/engine#7",
  kind: "pull",
  repo: "ada/engine",
  repoId: "engine-a1b2c3",
  number: 7,
  title: "Rate-limit headers",
  url: "https://github.com/ada/engine/pull/7",
  headRef: "cv/engine-a1b2c3/deadbeef",
  baseRef: "main",
  author: { login: "ada", bot: false },
  draft: false,
  openedAt: NOW - 25 * MINUTE,
  mergedAt: NOW - 5 * MINUTE,
  closedAt: null,
  updatedAt: NOW - 5 * MINUTE,
  state: "merged",
  reviews: [{ state: "changes_requested" }, { state: "approved" }],
  comments: 3,
  sessionIds: ["ses_one"],
  taskIds: [],
  agentId: "exec_nomad",
  repoIdOfPush: null,
  externalAgentId: null,
  ...over,
});

const rowOf = (rows, id) => rows.find((row) => row.id === id);

// ------------------------------------------------------------- the schema

test("the header holds the columns three unmerged pull requests will fill, empty until they do", () => {
  const waiting = SESSION_COLUMNS.filter((column) => column.since !== "now").map((column) => column.key);
  // C landed and its three say "now": the columns are filled from the
  // records rather than waiting for them (`linesAdded` is nought for a
  // session that edited nothing, and empty for one whose harness could not
  // say - see the row test below).
  assert.deepEqual(waiting, ["turns", "interrupts", "steers", "agentMs", "personMs", "yield"]);
  const later = PULL_COLUMNS.filter((column) => column.since !== "now").map((column) => column.key);
  assert.deepEqual(later, ["reverted", "followUps", "brokeBuild", "shipped", "durability"]);

  // Every one of them empty on a record written before that work landed -
  // not zero, which would read as "it was never steered" rather than as
  // "nothing measures that yet".
  const [row] = sessionRows([session()], [pull()], []);
  // `yield` was the first of these to land (pull request A, the outcomes
  // after a merge): it is worked out from the pull requests, not read off
  // the record, so it fills for every session the moment the code exists -
  // a merge that went round once is "reworked".
  assert.equal(row.yield, "reworked", "yield is computed now that its pull request landed");
  for (const key of waiting.filter((key) => key !== "yield")) assert.equal(row[key], null, `${key} is empty until its pull request lands`);
  const [merged] = pullRows([pull()]);
  for (const key of later) assert.equal(merged[key], null, `${key} is empty until its pull request lands`);
  // And C's three, on a pull request nobody has measured yet.
  for (const key of ["additions", "deletions", "aiShare"]) assert.equal(merged[key], null, `${key} is empty until the merge is measured`);

  // And no column is named twice, in either table: a duplicated key is a
  // column that silently overwrites another in the file.
  for (const columns of [SESSION_COLUMNS, PULL_COLUMNS]) {
    const keys = columns.map((column) => column.key);
    assert.equal(new Set(keys).size, keys.length);
    for (const column of columns) {
      assert.ok(column.title && column.unit, `${column.key} says what it is and what it is in`);
      assert.ok(["now", "A", "B", "C"].includes(column.since), `${column.key} says which pull request fills it`);
    }
  }
});

test("a row has exactly the columns the header does, and nothing else", () => {
  const [row] = sessionRows([session()], [pull()], []);
  assert.deepEqual(Object.keys(row), SESSION_COLUMNS.map((column) => column.key));
  const [merged] = pullRows([pull()]);
  assert.deepEqual(Object.keys(merged), PULL_COLUMNS.map((column) => column.key));
});

test("a record that already carries the later work fills its columns rather than waiting for a schema change", () => {
  // What a session and a pull request look like once A, B and C have
  // landed. Nothing here is edited when they do: the columns read the
  // fields those pull requests write, defensively, and start answering.
  const steered = session({
    counts: {
      ...session().counts,
      turns: 4, agentMs: 12 * MINUTE, personMs: 40 * MINUTE, linesAdded: 200,
      guidance: { ...session().counts.guidance, interrupts: 1 },
    },
    edits: { accepted: 150 },
  });
  const [row] = sessionRows([steered], [pull()], []);
  assert.equal(row.turns, 4);
  assert.equal(row.interrupts, 1);
  assert.equal(row.steers, 3, "a follow-up, a cut and a review round; no retries");
  assert.equal(row.agentMs, 12 * MINUTE);
  assert.equal(row.personMs, 40 * MINUTE);
  assert.equal(row.linesAdded, 200);
  assert.equal(row.accepted, 150);
  assert.equal(row.acceptance, 0.75);

  const [after] = pullRows([pull({
    reverted: { at: NOW, by: { kind: "pull", number: 9 } },
    followUps: [{ number: 8 }],
    brokeBuild: false,
    shipped: { at: NOW - MINUTE, app: "codervibes", release: "v42" },
    rolledBack: { at: NOW - MINUTE / 2, app: "codervibes", fromRelease: { version: 42 }, toRelease: { version: 41 }, by: { kind: "agent", name: "Scout" }, sessionId: "s1" },
    durability: { share: 0.8, added: 100, kept: 80 },
    diff: { additions: 120, deletions: 20, changedFiles: 4 },
    attribution: { share: 0.78, added: 120, agent: 94 },
  })]);
  assert.equal(after.reverted, new Date(NOW).toISOString());
  assert.equal(after.followUps, 1);
  assert.equal(after.brokeBuild, false);
  assert.equal(after.shipped, new Date(NOW - MINUTE).toISOString());
  assert.equal(after.rolledBack, new Date(NOW - MINUTE / 2).toISOString(), "shipped stands; when production gave it back is its own column");
  assert.equal(after.durability, 0.8);
  assert.equal(after.additions, 120);
  assert.equal(after.deletions, 20);
  assert.equal(after.aiShare, 0.78);
});

// -------------------------------------------------------------- the rows

test("a session row says who did the work, with what, and what came of it", () => {
  const [row] = sessionRows([session()], [pull()], [], {
    names: new Map([["ada@example.com", "Ada Lovelace"]]),
    mayRead: () => true,
  });
  assert.equal(row.id, "ses_one");
  assert.equal(row.owner, "ada@example.com");
  assert.equal(row.ownerName, "Ada Lovelace");
  assert.equal(row.executorId, "exec_nomad");
  assert.equal(row.executor, "Nomad");
  assert.equal(row.harness, "claude-code");
  assert.equal(row.model, "claude-opus-5");
  assert.equal(row.provider, "Anthropic");
  assert.equal(row.repo, "ada/engine");
  assert.equal(row.machineHost, "laptop");
  assert.equal(row.startedAt, new Date(NOW - 30 * MINUTE).toISOString());
  assert.equal(row.durationMs, 20 * MINUTE);
  assert.equal(row.tokens, 40_000);
  assert.equal(row.costCents, 250, "cents, and the column's name says so");
  assert.equal(row.toolCalls, 9);
  assert.equal(row.toolsFailed, 1);
  assert.equal(row.humanLines, 2);
  assert.equal(row.interventions, 4, "two lines, a follow-up and a round of review");
  assert.equal(row.tasksTaken, 1);
  assert.equal(row.tasksFinished, 1);
  assert.equal(row.verdict, "done");
  assert.equal(row.outcome, "merged");
  assert.equal(row.pulls, "ada/engine#7");
  assert.equal(row.pullUrls, "https://github.com/ada/engine/pull/7");
});

test("a session still going has no duration: it has not taken as long as it is going to", () => {
  const [row] = sessionRows([session({ state: "live", endedAt: null })], [], []);
  assert.equal(row.endedAt, null);
  assert.equal(row.durationMs, null);
  assert.equal(row.state, "live");
});

test("a pull request row says who opened it, how it went round, and which sessions are behind it", () => {
  // The record's own link, and a session that noted the pull request itself
  // and is not on the record's list: the cell is both, the way every page
  // reads them (performance.js `pullsOf`).
  const noted = session({ id: "ses_two", pulls: [{ id: "ada/engine#7", number: 7, state: "merged" }] });
  const [row] = pullRows([pull()], [session(), noted]);
  assert.equal(row.id, "ada/engine#7");
  assert.equal(row.number, 7);
  assert.equal(row.author, "ada");
  assert.equal(row.bot, false);
  assert.equal(row.baseRef, "main");
  assert.equal(row.state, "merged");
  assert.equal(row.mergedAt, new Date(NOW - 5 * MINUTE).toISOString());
  assert.equal(row.reviews, 2);
  assert.equal(row.changesRequested, 1);
  assert.equal(row.comments, 3);
  assert.equal(row.sessionIds, "ses_one ses_two");
});

// --------------------------------------------------------- the words rule

test("a session's ask goes out to a reader who may read it, and the cell is empty for one who may not", () => {
  const [mine] = sessionRows([session()], [], [], { mayRead: () => true });
  assert.equal(mine.title, "Add rate-limit headers, and say why");

  const [theirs] = sessionRows([session()], [], [], { mayRead: () => false });
  assert.equal(theirs.title, null, "empty, not the actor's name in its place");
  assert.equal(theirs.executor, "Nomad", "who was working is a name, and names are everybody's");
  assert.ok(!JSON.stringify(theirs).includes("rate-limit"), "the ask is nowhere on the row");

  // Forgotten is refused, not leaked: a caller that names no reader gets
  // no ask, the way index.js `describeSession` behaves.
  const [careless] = sessionRows([session()], [], []);
  assert.equal(careless.title, null);
});

// ------------------------------------------------------------- the file

test("a CSV field holding a comma, a quote or a newline is quoted, and nothing at all is an empty field", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(0), "0", "nought is a number, not nothing");
  assert.equal(csvCell(false), "false");
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('say "no"'), '"say ""no"""');
  assert.equal(csvCell("one\ntwo"), '"one\ntwo"');
  assert.equal(csvCell("one\r\ntwo"), '"one\r\ntwo"');
  assert.equal(csvCell(" padded "), '" padded "', "a spreadsheet eats an unquoted space");
});

test("the file is a header of column keys and one row each, ended the way the RFC asks", () => {
  const rows = sessionRows([session({ title: 'Fix "429", then cache' })], [pull()], [], { mayRead: () => true });
  const csv = toCsv(rows, SESSION_COLUMNS);
  const lines = csv.split("\r\n");
  assert.equal(lines[0], SESSION_COLUMNS.map((column) => column.key).join(","));
  assert.equal(lines.length, 3, "a header, a row, and the trailing break");
  assert.equal(lines[2], "");
  assert.ok(lines[1].includes('"Fix ""429"", then cache"'));
  // Every field of every row is on one line unless it is quoted, which is
  // the whole of what makes the file parseable.
  assert.equal(lines[1].split(",").length >= SESSION_COLUMNS.length, true);

  // Nothing to export is still a file with a header: a spreadsheet opening
  // an empty file shows an error, and one opening a header shows no rows.
  const empty = toCsv([], SESSION_COLUMNS);
  assert.equal(empty, `${SESSION_COLUMNS.map((column) => column.key).join(",")}\r\n`);
});

test("the JSON file carries the columns beside the rows, so a script has the units without the doc", () => {
  const rows = sessionRows([session()], [pull()], [], { mayRead: () => true });
  const parsed = JSON.parse(toJson(rows, SESSION_COLUMNS, { range: "7d" }));
  assert.equal(parsed.range, "7d");
  assert.deepEqual(parsed.columns.map((column) => column.key), SESSION_COLUMNS.map((column) => column.key));
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].id, "ses_one");
  assert.equal(parsed.rows[0].turns, null, "and an unfilled column is null rather than absent");
});

test("a file is named for what it holds and the range it holds it over", () => {
  assert.equal(filenameFor("sessions", "7d", "csv"), "codervibes-sessions-7d.csv");
  assert.equal(filenameFor("pulls", "30d", "json"), "codervibes-pulls-30d.json");
});

test("what got in the way is exported as counts and one kind=count cell, with the refusals the caller joins", () => {
  const worked = session({
    counts: {
      ...session().counts,
      friction: {
        errors: { "not-found": 4, "tests-failed": 2, permission: 1 },
        handBacks: 3,
        // Tallied as they ran, by fingerprint - the record holds no
        // command line (server/friction.js). Only the ones that got to
        // three are repeats.
        repeats: [{ hash: commandHash("npm test"), times: 6 }, { hash: commandHash("git status"), times: 2 }],
      },
    },
  });
  const [row] = sessionRows([worked], [], [], { refusals: new Map([["ses_one", 2]]) });
  assert.equal(row.errors, 7);
  assert.equal(row.errorKinds, "not-found=4 tests-failed=2 permission=1", "most-common first, no comma, so the cell never needs quoting");
  assert.equal(row.handBacks, 3);
  assert.equal(row.repeats, 1, "one command reached three");
  assert.equal(row.repeatRuns, 6, "and it ran six times");
  // Counts, never the line: a spreadsheet is the last place to put one back.
  assert.doesNotMatch(JSON.stringify(row), /npm test|git status/);
  assert.equal(row.refusals, 2);
  // The kinds cell survives the file it is written into unquoted.
  assert.equal(csvCell(row.errorKinds), row.errorKinds);

  // A caller with no trail to hand leaves the cell empty rather than
  // claiming nobody was ever refused.
  assert.equal(sessionRows([worked])[0].refusals, null);
  // And a session from before any of this counted reads as nought failures
  // rather than as a row of nulls.
  const old = sessionRows([session()])[0];
  assert.deepEqual([old.errors, old.errorKinds, old.handBacks, old.repeats, old.repeatRuns], [0, null, 0, 0, 0]);
});

test("a pull request carries the friction of the sessions behind it, and nothing for one no session here is behind", () => {
  const worked = session({
    id: "ses_two",
    pulls: [{ id: "ada/engine#7", number: 7, state: "merged" }],
    counts: { ...session().counts, friction: { errors: { git: 2 }, handBacks: 1, repeats: [] } },
  });
  const [mine] = pullRows([pull({ sessionIds: ["ses_two"] })], [worked]);
  assert.equal(mine.frictionErrors, 2);
  assert.equal(mine.frictionHandBacks, 1);
  const [theirs] = pullRows([pull({ id: "ada/engine#8", number: 8, sessionIds: [] })], [worked]);
  assert.equal(theirs.frictionErrors, null, "a human's pull request has no session of ours behind it to have had friction");
  assert.equal(theirs.frictionHandBacks, null);
});
