// The friction report (server/friction.js): that a real failing line lands
// on the kind a person would put it on and a decoy does not, that a
// closing question is a hand-back and a status line is not, that the same
// command run five times is counted once and said out loud, and that a
// month of sessions folds into the short list the report is - per repo,
// per executor, per ISO week.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ERROR_KINDS,
  KINDS,
  WORTH_FIXING,
  MIN_REPEATS,
  MAX_EXAMPLES,
  errorKindOf,
  isFailure,
  meaningOf,
  whatToFix,
  isHandBack,
  looksLikeCommand,
  normaliseCommand,
  repeatedCommands,
  sessionFriction,
  frictionOf,
  emptyFriction,
  isoWeekOf,
  report,
  kindsOf,
  repeatsOf,
  vocabulary,
  commandHash,
  fingerprint,
} from "../server/friction.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-12T09:00:00Z");

// --------------------------------------------------------- the vocabulary

test("every kind says what it means and what usually fixes it, and `other` is the last resort", () => {
  for (const [kind, entry] of Object.entries(ERROR_KINDS)) {
    assert.ok(entry.means?.length > 10, `${kind} says what it means`);
    assert.ok(entry.fix?.length > 10, `${kind} says what usually fixes it`);
    assert.equal(entry.means, meaningOf(kind));
  }
  assert.equal(KINDS.at(-1), "other", "nothing matches `other`; it is what is left");
  assert.equal(ERROR_KINDS.other.looksLike, null);
  assert.equal(KINDS.length, 9);
});

test("one real failing line per kind lands where a person would put it", () => {
  const lines = {
    "tests-failed": "Tests:       3 failed, 47 passed, 50 total",
    dependency: "npm ERR! code ERESOLVE",
    git: "CONFLICT (content): Merge conflict in server/sessions.js",
    timeout: "Command timed out after 2m 0.0s",
    network: "connect ECONNREFUSED 127.0.0.1:5432",
    permission: "EACCES: permission denied, open '/usr/local/lib/node_modules'",
    "type-or-syntax": "src/index.ts(42,7): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
    "not-found": "bash: ruff: command not found",
    other: "Killed",
  };
  for (const [kind, line] of Object.entries(lines)) {
    assert.equal(errorKindOf(line, { ok: false }), kind, line);
  }
});

test("a call that worked is not a failure, whatever its output said", () => {
  // An agent grepping for ENOENT found what it was looking for.
  assert.equal(errorKindOf("src/boot.js:12: if (err.code === 'ENOENT') return null;", { ok: true }), null);
  assert.equal(errorKindOf("47 tests passed", { ok: true }), null);
  assert.equal(errorKindOf(null, { ok: false }), "other", "a failure with no line still failed");
});

test("a call nobody said failed did not fail, whatever is in its line", () => {
  // The default that matters: a caller with an old record, a span shape
  // this does not know, or a line and nothing else, must not have every
  // successful call filed as an error.
  assert.equal(errorKindOf("ls: fixtures/: No such file or directory"), null);
  assert.equal(errorKindOf("ls: fixtures/: No such file or directory", { tool: "Bash" }), null);
  assert.equal(errorKindOf("ls: fixtures/: No such file or directory", { status: "completed" }), null);
  assert.equal(errorKindOf("47 tests passed"), null);
  // And the same line once something does say the call failed.
  assert.equal(errorKindOf("ls: fixtures/: No such file or directory", { status: "failed" }), "not-found");
  assert.equal(errorKindOf("ls: fixtures/: No such file or directory", { ok: false }), "not-found");
  assert.equal(errorKindOf("ls: fixtures/: No such file or directory", { response: { is_error: true } }), "not-found");
});

test("one rule decides that a call failed, over whatever the caller happens to have", () => {
  assert.equal(isFailure({ status: "failed" }), true);
  assert.equal(isFailure({ ok: false }), true);
  assert.equal(isFailure({ ok: true, detail: "npm ERR! code ERESOLVE" }), false, "a span that says it worked, worked");
  assert.equal(isFailure({ response: { is_error: true } }), true);
  assert.equal(isFailure({ response: { error: "ENOENT: no such file" } }), true);
  assert.equal(isFailure({ response: { error: "" } }), false);
  assert.equal(isFailure({ response: { exit_code: 1 } }), true);
  assert.equal(isFailure({ response: { exitCode: 0, stderr: "warning: deprecated" } }), false, "stderr is a warning until an exit code disagrees");
  assert.equal(isFailure({ response: { stdout: "", stderr: "npm WARN old lockfile" } }), false);
  assert.equal(isFailure({ response: { code: "ENOENT" } }), true);
  assert.equal(isFailure({ response: { code: 0 } }), false);
  // The line is read only when nothing else said anything, and only for
  // the harness's own words for a non-zero exit.
  assert.equal(isFailure({ detail: "Error: Command failed: npm test" }), true);
  assert.equal(isFailure({ response: "Command failed: npm test\nTests: 2 failed" }), true);
  assert.equal(isFailure({ detail: "exited with code 2" }), true);
  assert.equal(isFailure({ detail: "ENOENT: no such file or directory" }), false);
  assert.equal(isFailure({}), false);
  assert.equal(isFailure(), false);
});

test("the decoys go the useful way round: the order of the kinds is the rule", () => {
  // npm reporting a test failure is a test failure, not a dependency problem.
  assert.equal(errorKindOf("npm ERR! Test failed.  See above for more details.", { ok: false }), "tests-failed");
  // Node's own two messages mean two different things.
  assert.equal(errorKindOf("Error: Cannot find package 'zod' imported from /app/index.js", { ok: false }), "dependency");
  assert.equal(errorKindOf("Error: Cannot find module './helpers'", { ok: false }), "not-found");
  // `refused` is a word the network and a permission share.
  assert.equal(errorKindOf("Error: connect ECONNREFUSED ::1:6379", { ok: false }), "network");
  assert.equal(errorKindOf("curl: (7) Failed to connect to localhost port 8080: Connection refused", { ok: false }), "network");
  assert.equal(errorKindOf("remote: Permission to ada/engine.git denied to nomad-bot.", { ok: false }), "permission");
  // "exceeded" on its own is not a timeout.
  assert.equal(errorKindOf("RangeError: Maximum call stack size exceeded", { ok: false }), "type-or-syntax");
  assert.equal(errorKindOf("context deadline exceeded", { ok: false }), "timeout");
  // A test run that passed is not a test failure.
  assert.equal(errorKindOf("# pass 812\n# fail 0", { ok: false }), "other");
});

test("a fetch-shaped tool that failed silently failed at the network", () => {
  assert.equal(errorKindOf("", { tool: "WebFetch", ok: false }), "network");
  assert.equal(errorKindOf("", { tool: "Bash", ok: false }), "other");
});

test("the fix line is for a habit, so one occurrence gets none", () => {
  assert.equal(whatToFix("tests-failed", 14), ERROR_KINDS["tests-failed"].fix);
  assert.match(whatToFix("tests-failed", 14), /fixture/);
  assert.equal(whatToFix("tests-failed", WORTH_FIXING), ERROR_KINDS["tests-failed"].fix);
  assert.equal(whatToFix("tests-failed", 1), null, "one ENOENT in a week is a typo, not a pattern");
  assert.equal(whatToFix("no-such-kind", 9), null);
});

// ---------------------------------------------------------- hand-backs

test("a turn that ends on a question or an ask is a hand-back; a status line is not", () => {
  assert.equal(isHandBack("Done. Tests pass."), false);
  assert.equal(isHandBack("Pushed to `friction-report`; 912 tests green."), false);
  assert.equal(isHandBack("I've pushed the branch. Should I open the pull request?"), true);
  assert.equal(isHandBack("Fixed the parser and pushed. Let me know if you want the follow-up test too."), true);
  assert.equal(isHandBack("The migration is written but I have not run it - please confirm before I proceed."), true);
  assert.equal(isHandBack("There are two ways to do this. **Which one do you want?**"), true, "markdown sits after the punctuation");
  assert.equal(isHandBack("Do you want me to revert it as well."), true, "the phrase counts even when the question mark does not arrive");
});

test("a question the agent asked itself and then answered is not a hand-back", () => {
  assert.equal(isHandBack("Why was it failing? A stale lockfile. Fixed and pushed."), false);
  assert.equal(isHandBack("Let me know is a phrase that appears here, three sentences ago. It ran. It passed."), false);
  assert.equal(isHandBack(""), false);
  assert.equal(isHandBack(null), false);
});

test("only the end of a long answer is read", () => {
  const essay = `${"The parser was rewritten. ".repeat(400)}Should I deploy it?`;
  assert.ok(essay.length > 5000);
  assert.equal(isHandBack(essay), true);
  assert.equal(isHandBack(`Should I deploy it? ${"It is deployed. ".repeat(400)}`), false);
});

// ------------------------------------------------------------- repeats

test("the same command with different noise on the end is the same command", () => {
  assert.equal(normaliseCommand("npm test 2>&1 | tail -20"), "npm test");
  assert.equal(normaliseCommand("npm  test   > /dev/null"), "npm test");
  assert.equal(normaliseCommand("node --test test/friction.test.js 2>/dev/null | head"), "node --test test/friction.test.js");
});

test("a path, a URL and a sentence are not commands", () => {
  assert.equal(looksLikeCommand("npm test"), true);
  assert.equal(looksLikeCommand("./scripts/pr-screenshots.sh friction-report a.png"), true);
  assert.equal(looksLikeCommand("CI=1 npm test"), true, "an env prefix is part of the command");
  assert.equal(looksLikeCommand("/Users/ada/src/engine/server/sessions.js"), false);
  assert.equal(looksLikeCommand("https://github.com/ada/engine/pull/12"), false);
  assert.equal(looksLikeCommand("Fix the parser bug"), false, "a sentence starts with a capital");
  assert.equal(looksLikeCommand("git"), false, "one word is a name, not a command line");
});

test("a command run three times is a repeat; twice is a Tuesday", () => {
  const titles = ["npm test", "/Users/ada/x.js", "npm test 2>&1 | tail -20", "git status", "npm test", "git status"];
  assert.deepEqual(repeatedCommands(titles), [{ title: "npm test", times: 3 }]);
  assert.equal(MIN_REPEATS, 3);
  assert.deepEqual(repeatedCommands(["npm test", "npm test"]), []);
  assert.deepEqual(repeatedCommands(Array(5).fill("/Users/ada/x.js")), [], "reading a file five times is not this");
  assert.deepEqual(repeatedCommands(null), []);
});

test("the most-run command is first", () => {
  const titles = [...Array(5).fill("npm test"), ...Array(3).fill("git rebase origin/main")];
  assert.deepEqual(repeatedCommands(titles), [
    { title: "npm test", times: 5 },
    { title: "git rebase origin/main", times: 3 },
  ]);
});

// ------------------------------------------------------- one session

/** A session log entry, as session-events.js keeps one. */
const call = (id, title, tool = "Bash") => ({ kind: "tool_call", toolCallId: id, title, tool, toolKind: "execute", status: "in_progress" });
const ended = (id, status, detail = null) => ({ kind: "tool_call_update", toolCallId: id, status, ...(detail ? { detail } : {}) });
const said = (text) => ({ kind: "agent_message_chunk", text });
const turn = (status) => ({ kind: "platform.status", status });

test("a session's friction is its failed calls by kind, its hand-backs, its repeats and its refusals", () => {
  const friction = sessionFriction({
    events: [
      turn("running"),
      call("t1", "npm test"),
      ended("t1", "failed", "Tests:       2 failed, 48 passed, 50 total"),
      call("t2", "npm test"),
      ended("t2", "failed", "Tests:       1 failed, 49 passed, 50 total"),
      call("t3", "npm test"),
      ended("t3", "completed", "50 passed"),
      call("t4", "cat fixtures/orders.json", "Read"),
      ended("t4", "failed", "ENOENT: no such file or directory, open 'fixtures/orders.json'"),
      said("Tests pass now. Should I open the pull request?"),
      turn("idle"),
    ],
    trail: [{ state: "refused" }, { state: "denied" }, { state: "ok" }, { state: "approved" }],
  });
  assert.deepEqual(friction.errors, { "tests-failed": 2, "not-found": 1 });
  assert.equal(friction.handBacks, 1);
  assert.deepEqual(friction.repeats, [{ title: "npm test", times: 3 }]);
  assert.equal(friction.refusals, 2);
});

test("a call that came back completed is not an error, even when its output says ENOENT", () => {
  const friction = sessionFriction({
    events: [call("t1", "ls fixtures/"), ended("t1", "completed", "ls: fixtures/: No such file or directory")],
  });
  assert.deepEqual(friction.errors, {}, "a successful check of a path that is not there is not friction");
  // Unless the harness said so itself, in the only words that count.
  const failed = sessionFriction({
    events: [call("t2", "npm test"), ended("t2", "completed", "Error: Command failed: npm test - 2 tests failed")],
  });
  assert.deepEqual(failed.errors, { "tests-failed": 1 });
});

test("each turn's last word is judged, and a turn that has not ended yet is not", () => {
  const events = [
    turn("running"),
    said("Which one do you want, the fast path or the correct one?"),
    turn("idle"),
    turn("running"),
    said("Done. Both are behind the flag."),
    turn("idle"),
    turn("running"),
    said("Should I deploy it?"),
  ];
  assert.equal(sessionFriction({ events }).handBacks, 1, "the turn still running is not counted");
  assert.equal(sessionFriction({ events: [...events, turn("idle")] }).handBacks, 2);
});

test("a harness that never says a turn ended still has a last word", () => {
  assert.equal(sessionFriction({ events: [said("Done."), said("Let me know if you want it rebased.")] }).handBacks, 1);
  assert.equal(sessionFriction({ events: [said("Done. Rebased and pushed.")] }).handBacks, 0);
});

test("a failure the tool hook never opened is still counted", () => {
  const friction = sessionFriction({
    events: [{ kind: "tool_call", toolCallId: "x", title: "pytest -q", tool: "Bash", status: "failed", detail: "E   ModuleNotFoundError: No module named 'httpx'" }],
  });
  assert.deepEqual(friction.errors, { "not-found": 1 });
});

test("nothing in is an empty count, not a crash", () => {
  assert.deepEqual(sessionFriction({}), emptyFriction());
  assert.deepEqual(sessionFriction(), emptyFriction());
  assert.deepEqual(frictionOf(null), emptyFriction());
  assert.deepEqual(frictionOf({ counts: { friction: { errors: { git: 2 } } } }), { errors: { git: 2 }, handBacks: 0, repeats: [], refusals: 0 });
});

// -------------------------------------------------------------- weeks

test("a week is an ISO week, Monday to Sunday, in UTC", () => {
  assert.equal(isoWeekOf(Date.parse("2026-09-12T23:59:59Z")), "2026-W37");
  assert.equal(isoWeekOf(Date.parse("2026-09-07T00:00:00Z")), "2026-W37", "the Monday it starts on");
  assert.equal(isoWeekOf(Date.parse("2026-09-13T23:00:00Z")), "2026-W37", "the Sunday it ends on");
  assert.equal(isoWeekOf(Date.parse("2026-09-14T00:00:00Z")), "2026-W38");
  // The week belongs to the year its Thursday is in.
  assert.equal(isoWeekOf(Date.parse("2025-12-29T12:00:00Z")), "2026-W01");
  assert.equal(isoWeekOf(Date.parse("2026-01-01T12:00:00Z")), "2026-W01");
});

// ------------------------------------------------------------- report

let n = 0;
/** A report row: the counts a session carries, and the little it is grouped by. */
function row({ repoId = "r1", repoName = "engine", actorId = "a1", actorName = "Nomad", startedAt = NOW - DAY, errors = {}, handBacks = 0, repeats = [], refusals = 0 } = {}) {
  n += 1;
  return { sessionId: `ses_${n}`, repoId, repoName, actorId, actorName, startedAt, friction: { errors, handBacks, repeats, refusals } };
}

test("the report is the short list: kinds most-common first, with what fixes them and sessions to read", () => {
  const rows = [
    row({ errors: { "not-found": 8, "tests-failed": 2 }, handBacks: 1 }),
    row({ errors: { "not-found": 6, "tests-failed": 7 }, refusals: 2 }),
    row({ errors: { "not-found": 1 }, repeats: [{ hash: commandHash("npm test"), times: 5 }] }),
    row({ errors: { git: 1 } }),
  ];
  const { groups, totals } = report(rows, { since: NOW - 7 * DAY, until: NOW, by: "repo" });
  assert.equal(groups.length, 1);
  const [engine] = groups;
  assert.equal(engine.key, "r1");
  assert.equal(engine.name, "engine");
  assert.equal(engine.sessions, 4);
  assert.deepEqual(
    engine.errors.map((error) => [error.kind, error.count]),
    [["not-found", 15], ["tests-failed", 9], ["git", 1]],
  );
  assert.equal(engine.errors[0].fix, ERROR_KINDS["not-found"].fix);
  assert.equal(engine.errors[0].means, ERROR_KINDS["not-found"].means);
  assert.equal(engine.errors[2].fix, null, "one conflict all week is not a habit");
  assert.deepEqual(engine.errors[0].examples, ["ses_1", "ses_2", "ses_3"]);
  assert.equal(engine.errors[0].examples.length, MAX_EXAMPLES);
  assert.equal(engine.handBacks, 1);
  assert.equal(engine.refusals, 2);
  assert.deepEqual(engine.repeats, [{ hash: commandHash("npm test"), times: 5, sessions: 1, examples: ["ses_3"] }]);
  assert.equal(engine.total, 25);
  assert.deepEqual(totals.errors.map((error) => error.count), [15, 9, 1]);
  assert.equal(totals.sessions, 4);
});

test("sessions outside the range are not in it", () => {
  const rows = [row({ startedAt: NOW - 40 * DAY, errors: { git: 9 } }), row({ startedAt: NOW - DAY, errors: { git: 1 } })];
  const { groups } = report(rows, { since: NOW - 7 * DAY, until: NOW });
  assert.equal(groups[0].sessions, 1);
  assert.equal(groups[0].total, 1);
  assert.equal(report(rows, {}).groups[0].total, 10, "no range is all of it");
});

test("the worst repo is first, and an executor's row is the same arithmetic", () => {
  const rows = [
    row({ repoId: "r1", repoName: "engine", actorId: "a1", actorName: "Nomad", errors: { "not-found": 2 } }),
    row({ repoId: "r2", repoName: "console", actorId: "a2", actorName: "Scout", errors: { timeout: 9 }, refusals: 3 }),
    row({ repoId: "r2", repoName: "console", actorId: "a1", actorName: "Nomad", handBacks: 4 }),
  ];
  const byRepo = report(rows, { by: "repo" });
  assert.deepEqual(byRepo.groups.map((group) => group.name), ["console", "engine"]);
  assert.equal(byRepo.groups[0].sessions, 2);
  assert.equal(byRepo.groups[0].handBacks, 4);

  const byExecutor = report(rows, { by: "executor" });
  assert.deepEqual(byExecutor.groups.map((group) => [group.key, group.name]), [["a2", "Scout"], ["a1", "Nomad"]]);
  assert.equal(byExecutor.groups[1].sessions, 2);
  assert.equal(byExecutor.groups[1].handBacks, 4);
  assert.equal(byExecutor.by, "executor");
  assert.equal(report(rows, { by: "nonsense" }).by, "repo", "a fold nobody offers is the default one");
});

test("by week the rows are weeks, oldest first, because that is a trend", () => {
  const rows = [
    row({ startedAt: Date.parse("2026-09-12T09:00:00Z"), errors: { "tests-failed": 1 } }),
    row({ startedAt: Date.parse("2026-09-08T09:00:00Z"), errors: { "tests-failed": 4 } }),
    row({ startedAt: Date.parse("2026-09-01T09:00:00Z"), errors: { "tests-failed": 9 } }),
  ];
  const { groups } = report(rows, { by: "week" });
  assert.deepEqual(groups.map((group) => group.key), ["2026-W36", "2026-W37"]);
  assert.deepEqual(groups.map((group) => group.total), [9, 5]);
  assert.equal(groups[1].sessions, 2);
});

test("a repeat two sessions share is one line saying both", () => {
  const test_ = commandHash("npm test");
  const rebase = commandHash("git rebase origin/main");
  const rows = [
    row({ repeats: [{ hash: test_, times: 5 }] }),
    row({ repeats: [{ hash: test_, times: 3 }, { hash: rebase, times: 3 }] }),
  ];
  const [group] = report(rows, {}).groups;
  assert.deepEqual(group.repeats, [
    { hash: test_, times: 8, sessions: 2, examples: [rows[0].sessionId, rows[1].sessionId] },
    { hash: rebase, times: 3, sessions: 1, examples: [rows[1].sessionId] },
  ]);
  // The rows name a session or two so a caller can look the words up in
  // one - the record has none (`fingerprint`).
  assert.equal(group.repeats[0].title, undefined, "the report does not invent words the record does not hold");
});

test("a kind nobody defined is not counted, whatever a record says", () => {
  const rows = [row({ errors: { "not-found": 2, "made-up": 40, git: 0 } })];
  const [group] = report(rows, {}).groups;
  assert.deepEqual(group.errors.map((error) => error.kind), ["not-found"]);
});

test("nothing to report is an empty report, not a crash", () => {
  const empty = report([], {});
  assert.deepEqual(empty.groups, []);
  assert.deepEqual(empty.totals.errors, []);
  assert.equal(empty.totals.sessions, 0);
  assert.deepEqual(report(null, {}).groups, []);
  assert.deepEqual(report([null, undefined, {}], {}).groups.length, 1, "a row with no repo and no counts is still a session");
});

test("a session log becomes a report row without anything in between", () => {
  // What phase two does at ingest, done here in one line, so the report is
  // the same arithmetic whichever way the counts were arrived at.
  const friction = sessionFriction({
    events: [
      call("t1", "pytest -q"),
      ended("t1", "failed", "E   ModuleNotFoundError: No module named 'httpx'"),
      said("The test deps are not installed. Should I add them to the lockfile?"),
      turn("idle"),
    ],
    trail: [{ state: "denied" }],
  });
  const { groups } = report([{ sessionId: "ses_x", repoId: "r1", repoName: "engine", actorId: "a1", startedAt: NOW - DAY, friction }], {});
  assert.deepEqual(groups[0].errors.map((error) => [error.kind, error.count, error.examples]), [["not-found", 1, ["ses_x"]]]);
  assert.equal(groups[0].handBacks, 1);
  assert.equal(groups[0].refusals, 1);
});

// ------------------------------------------------- what a page is handed

test("a session's own kinds come sorted, with a fix only where it is a habit", () => {
  const session = { counts: { friction: { errors: { "not-found": 1, "tests-failed": 4 }, handBacks: 2, repeats: [{ hash: commandHash("npm test"), times: 5 }, { hash: commandHash("git status"), times: 2 }] } } };
  assert.deepEqual(
    kindsOf(session).map((kind) => [kind.kind, kind.count, kind.fix === null]),
    [["tests-failed", 4, false], ["not-found", 1, true]],
  );
  assert.equal(kindsOf(session)[0].means, ERROR_KINDS["tests-failed"].means);
  assert.deepEqual(repeatsOf(session), [{ hash: commandHash("npm test"), times: 5 }], "the record tallies every command; three is the signal");
  assert.deepEqual(kindsOf({}), []);
});

test("the vocabulary a page is handed survives JSON, which a regex does not", () => {
  const table = JSON.parse(JSON.stringify(vocabulary()));
  assert.deepEqual(Object.keys(table), KINDS);
  assert.equal(table["not-found"].fix, ERROR_KINDS["not-found"].fix);
  assert.equal(table["not-found"].looksLike, undefined, "the regexes stay on the server");
});

test("a one-off command tallied on a record is not a repeat in the report", () => {
  const rows = [
    { sessionId: "ses_a", repoId: "r1", repoName: "engine", startedAt: NOW - DAY, friction: { errors: {}, handBacks: 0, refusals: 0, repeats: [{ hash: commandHash("npm test"), times: 4 }, { hash: commandHash("ls -la"), times: 1 }] } },
  ];
  const [group] = report(rows, {}).groups;
  assert.deepEqual(group.repeats, [{ hash: commandHash("npm test"), times: 4, sessions: 1, examples: ["ses_a"] }]);
});

test("a command is kept as a fingerprint, and the same command fingerprints the same way", () => {
  // What the record holds instead of the line (server/sessions.js
  // `repeated`): stable across processes, so a session that ran a command
  // before a restart and again after it is one row, not two.
  assert.match(fingerprint("npm test"), /^[0-9a-f]{8}$/);
  assert.equal(fingerprint("npm test"), fingerprint("npm test"));
  assert.notEqual(fingerprint("npm test"), fingerprint("npm run test"));
  assert.equal(fingerprint(""), "811c9dc5", "FNV-1a's offset basis, so an empty string is not zero");
  // The normalising the tally does is inside it, so the noise a harness
  // adds to the end of a line does not make a second command.
  assert.equal(commandHash("npm test 2>&1 | tail -20"), commandHash("npm  test"));
  assert.notEqual(commandHash("npm test"), commandHash("pytest -q"));
  // A line longer than the cut still hashes, and to the same thing every
  // time - both sides of the lookup cut before they hash.
  const long = `./deploy.sh ${"x".repeat(400)}`;
  assert.equal(commandHash(long), commandHash(`${long} extra`), "past the cut, two lines are one command - said in the doc");
});
