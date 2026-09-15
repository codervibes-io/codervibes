// A pull request opened with `gh` on somebody's own machine, noticed.
//
// The agent is supposed to say which pull request it opened
// (note_pull_request; mcp.test.js) and mostly does not, so the server reads
// it off the tool call the hooks post: `gh pr create` printed a URL, so that
// session opened that pull request. What these hold: which calls count as
// opening one (creating, not viewing or listing - those print other
// people's), that a noted one is filed under the session and the repo whose
// repository it is, and that the same reading over the stored transcripts
// finds the ones opened before anybody was listening.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cv-pull-opened-"));
process.env.CODERVIBES_STORE = "json";
process.env.CODERVIBES_DATA_DIR = dataDir;
process.env.CODERVIBES_REPOS = path.join(dataDir, "repos");
test.after(() => fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

const pulls = await import("../server/pulls.js");
const sessionLog = await import("../server/sessions.js");
const sessionEvents = await import("../server/session-events.js");
const { repos } = await import("../server/repos.js");
const { pullOpenedBy, filedFor, heardToolResult, pullsOpenedIn, backfill } = await import("../server/pull-opened.js");

test.beforeEach(() => {
  pulls.pullInternals.reset();
  sessionLog.sessionInternals.reset();
});

const url = (number, repo = "ada/engine") => `https://github.com/${repo}/pull/${number}`;
const laptop = (extra = {}) =>
  sessionLog.open({
    kind: "harness",
    owner: "ada@example.com",
    actor: { kind: "harness", id: "h-1", name: "Terminal Claude" },
    repo: { kind: "github", fullName: "ada/engine" },
    branch: "feature/clock",
    ...extra,
  });

test("a command that creates a pull request and prints its URL is that pull request; viewing or listing one is not", () => {
  // gh prints the URL alone on stdout, with its chatter on stderr.
  assert.deepEqual(
    pullOpenedBy('gh pr create --title "A clock" --body "..."', { stdout: `${url(12)}\n`, stderr: "Creating pull request for feature/clock into main in ada/engine\n" }),
    { repo: "ada/engine", number: 12, url: url(12) },
  );
  // The command may be one of several on a line, and the result a plain string or content blocks.
  assert.equal(pullOpenedBy("git push -u origin feature/clock && gh pr create --fill", url(13)).number, 13);
  assert.equal(pullOpenedBy("gh pr create -f", [{ type: "text", text: `Warning: 1 uncommitted change\n${url(14)}` }]).number, 14);
  assert.equal(pullOpenedBy("gh pr create -f", `${url(15)}?expand=1`).number, 15, "a trailing query string is still that pull request");

  // Viewing, listing, checking out: URLs of pull requests this session did not open.
  assert.equal(pullOpenedBy("gh pr view 12 --json url", { stdout: url(12) }), null);
  assert.equal(pullOpenedBy("gh pr list", { stdout: `${url(3)}\n${url(4)}` }), null);
  assert.equal(pullOpenedBy("gh pr checkout 12", { stdout: url(12) }), null);
  assert.equal(pullOpenedBy("echo 'gh pr create' > notes.md", { stdout: "" }), null, "a create that printed no URL opened nothing");
  // A create that failed printed no URL.
  assert.equal(pullOpenedBy("gh pr create -f", { stdout: "", stderr: "pull request create failed: GraphQL: No commits between main and feature/clock" }), null);
  assert.equal(pullOpenedBy(null, { stdout: url(12) }), null);
  assert.equal(pullOpenedBy("gh pr create -f", null), null);
});

test("a hook's tool result opens the pull request under its session, once, and asks nothing of the log", async () => {
  const session = laptop();
  const noted = await heardToolResult(session, {
    command: 'gh pr create --title "A clock" --body "tick"',
    response: { stdout: `${url(21)}\n`, stderr: "" },
  });
  assert.ok(noted, "noted");
  const record = await pulls.get("ada/engine", 21);
  assert.equal(record.state, "open");
  assert.equal(record.url, url(21));
  assert.equal(record.headRef, "feature/clock", "the branch the session said it was on");
  assert.deepEqual(record.sessionIds, [session.id]);
  assert.equal(record.agentId, "h-1", "the harness is the actor, so it is the agent");
  assert.equal(record.repoId, null, "no repo here has that repository, so it is filed under none");
  assert.equal(session.outcome, "open", "the session learns it has a pull request out");

  // Said twice - the agent also called note_pull_request, or the hook was
  // retried - is one record, one session link.
  await heardToolResult(session, { command: "gh pr create -f", response: { stdout: url(21) } });
  assert.deepEqual((await pulls.get("ada/engine", 21)).sessionIds, [session.id]);

  // A call that opened nothing notes nothing.
  assert.equal(await heardToolResult(session, { command: "gh pr view 21", response: { stdout: url(21) } }), null);
  assert.equal(await heardToolResult(null, { command: "gh pr create -f", response: { stdout: url(22) } }), null);
  assert.equal(await pulls.get("ada/engine", 22), null);
});

test("the pull request is filed under the owner's repo whose repository it is on, so the poll asks after it", async () => {
  // Two repos of the owner's, one of them the repository; and somebody
  // else's repo of the same repository, which is not where this goes.
  const mine = { id: "r-engine", name: "Engine", owner: "ada@example.com", source: { kind: "github", repo: "ada/engine" }, members: [], agents: [] };
  const other = { id: "r-shop", name: "Shop", owner: "ada@example.com", source: { kind: "github", repo: "ada/shop" }, members: [], agents: [] };
  const theirs = { id: "r-theirs", name: "Aardvark", owner: "bob@example.com", source: { kind: "github", repo: "ada/engine" }, members: [], agents: [] };
  for (const repo of [mine, other, theirs]) repos.repos.set(repo.id, repo);
  try {
    assert.equal(filedFor("ada/engine", "ada@example.com")?.id, "r-engine");
    assert.equal(filedFor("ADA/Engine", "ada@example.com")?.id, "r-engine", "GitHub names are not case sensitive");
    assert.equal(filedFor("ada/nowhere", "ada@example.com"), null);
    assert.equal(filedFor("ada/engine", "bob@example.com")?.id, "r-theirs");

    const session = laptop();
    await heardToolResult(session, { command: "gh pr create -f", response: { stdout: url(31) } });
    const record = await pulls.get("ada/engine", 31);
    assert.equal(record.repoId, "r-engine", "this installation's own, on the repo it belongs to");
  } finally {
    for (const repo of [mine, other, theirs]) repos.repos.delete(repo.id);
  }
});

test("the stored transcripts say which pull requests a session opened, and the backfill notes the ones nobody did", async () => {
  const session = laptop();
  const call = (id, title) => sessionEvents.append(session.id, "tool_call", { toolCallId: id, title, tool: "run_command", toolKind: "execute", status: "in_progress" });
  const done = (id, detail) => sessionEvents.append(session.id, "tool_call_update", { toolCallId: id, status: "completed", detail });
  call("t1", "git push -u origin feature/clock");
  done("t1", "branch 'feature/clock' set up to track 'origin/feature/clock'.");
  call("t2", 'gh pr create --title "A clock" --body "tick"');
  done("t2", url(41));
  call("t3", "gh pr view 41 --json url");
  done("t3", url(41));
  call("t4", "gh pr create --title \"Again\" --fill");
  done("t4", "pull request create failed: a pull request for branch already exists");
  call("t5", "gh pr create -f");
  done("t5", url(42));
  // Somebody else's session, in a checkout with no remote: not read.
  const scratch = sessionLog.open({ kind: "harness", owner: "ada@example.com", actor: { kind: "harness", id: "h-2", name: "Other" } });
  sessionEvents.append(scratch.id, "tool_call", { toolCallId: "s1", title: "gh pr create -f", tool: "run_command", toolKind: "execute", status: "in_progress" });
  sessionEvents.append(scratch.id, "tool_call_update", { toolCallId: "s1", status: "completed", detail: url(43) });
  await sessionEvents.flush();

  assert.deepEqual(
    (await pullsOpenedIn(session.id)).map((pull) => pull.number),
    [41, 42],
    "the creates that printed a URL; not the view, not the failed create",
  );

  // Say one of them was noted already (the agent called note_pull_request).
  await pulls.noteOpened({ repoId: null, sessionId: session.id, repo: "ada/engine", number: 41, url: url(41), branch: "feature/clock" });

  // The sessions of the earlier tests are in the store too and are read;
  // their transcripts open nothing, so what is found is this one's.
  const first = await backfill();
  assert.ok(first.sessions >= 1, "the sessions with a checkout are read");
  assert.deepEqual({ found: first.found, noted: first.noted }, { found: 2, noted: 1 }, "two seen, the unnoted one noted");
  const later = await pulls.get("ada/engine", 42);
  assert.deepEqual(later.sessionIds, [session.id]);
  assert.equal(later.headRef, "feature/clock");
  assert.equal(await pulls.get("ada/engine", 43), null, "a session with no checkout is not read");

  // Again finds nothing new: what was noted stays noted once.
  const again = await backfill();
  assert.deepEqual({ found: again.found, noted: again.noted }, { found: 2, noted: 0 });
  assert.deepEqual((await pulls.get("ada/engine", 42)).sessionIds, [session.id]);
});
