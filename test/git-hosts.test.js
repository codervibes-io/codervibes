// A person's own git host, connected with a token and asked what became of
// the work.
//
// No App, no webhook, no installation: a personal access token, and the one
// question "my own pull requests, updated since". What these hold is the
// whole chain of that - which remote is which host, which token is not one,
// what each vendor's JSON becomes, where the token is kept and that it is
// never handed back, and the thing it is all for: a merge request that
// merged reaching the session that was on its branch, so Performance counts
// it.
//
// The three hosts are real HTTP servers (fake-gitlab.js, fake-bitbucket.js,
// fake-github.js) answering each vendor's own JSON, because the code under
// test is almost entirely translation and a stub answering the normalised
// shape would test nothing.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cv-git-hosts-"));
process.env.CODERVIBES_STORE = "json";
process.env.CODERVIBES_DATA_DIR = dataDir;
test.after(() => fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

const { startFakeGitLab } = await import("./fake-gitlab.js");
const { startFakeBitbucket } = await import("./fake-bitbucket.js");
const { startFakeGitHub } = await import("./fake-github.js");

const gitlab = await startFakeGitLab();
const bitbucket = await startFakeBitbucket();
const github = await startFakeGitHub();
test.after(() => {
  gitlab.server.close();
  bitbucket.server.close();
  github.server.close();
});

const hosts = await import("../server/git-hosts/index.js");
const credentials = await import("../server/git-hosts/credentials.js");
const sync = await import("../server/git-hosts/sync.js");
const pulls = await import("../server/pulls.js");
const sessionLog = await import("../server/sessions.js");
const userRecord = await import("../server/user-record.js");
const { pullOpenedBy } = await import("../server/pull-opened.js");

const ADA = "ada@example.com";
const GITLAB_TOKEN = { token: gitlab.state.token };
const BITBUCKET = { username: bitbucket.state.username, token: bitbucket.state.token };

test.beforeEach(() => {
  pulls.pullInternals.reset();
  sessionLog.sessionInternals.reset();
});

// ------------------------------------------------------------ the remotes

test("a git remote says which host it is on and what the repository is called there", () => {
  const cases = [
    ["https://github.com/ada/engine.git", { host: "github", fullName: "ada/engine" }],
    ["https://ada@github.com/ada/engine", { host: "github", fullName: "ada/engine" }],
    ["git@github.com:ada/engine.git", { host: "github", fullName: "ada/engine" }],
    ["ssh://git@github.com/ada/engine", { host: "github", fullName: "ada/engine" }],
    ["https://github.com/ada/engine/", { host: "github", fullName: "ada/engine" }],
    // A bare owner/name is GitHub, which is what it has always meant here.
    ["ada/engine", { host: "github", fullName: "ada/engine" }],
    // GitLab, including a project several groups deep: the whole path is
    // the project's name, and trimming it to two segments would make
    // `platform/engine` and `web/engine` one record.
    ["https://gitlab.com/ada/platform/engine.git", { host: "gitlab", fullName: "ada/platform/engine" }],
    ["git@gitlab.com:ada/platform/engine.git", { host: "gitlab", fullName: "ada/platform/engine" }],
    ["ssh://git@gitlab.com/ada/engine", { host: "gitlab", fullName: "ada/engine" }],
    // A GitLab somebody runs themselves is still GitLab's dialect.
    ["git@gitlab.example.com:ada/engine.git", { host: "gitlab", fullName: "ada/engine" }],
    ["https://bitbucket.org/ada/engine.git", { host: "bitbucket", fullName: "ada/engine" }],
    ["git@bitbucket.org:ada/engine.git", { host: "bitbucket", fullName: "ada/engine" }],
  ];
  for (const [remote, expected] of cases) {
    assert.deepEqual(hosts.parseRemote(remote), expected, remote);
  }

  // And what is not a remote of a host this app knows, which stays null
  // rather than being guessed at: a session on one is unlinked, as before.
  for (const remote of ["/home/ada/scratch", "https://example.com/ada/engine", "C:\\repos\\engine", "", null, "engine"]) {
    assert.equal(hosts.parseRemote(remote), null, String(remote));
  }

  // The same three hosts read off a web address, and the address of a pull
  // request on each - each host writes its own path.
  assert.equal(hosts.hostOf("https://gitlab.com/ada/engine/-/merge_requests/7"), "gitlab");
  assert.equal(hosts.hostOf("https://bitbucket.org/ada/engine/pull-requests/3"), "bitbucket");
  assert.equal(hosts.hostOf("https://example.com/x"), null);
  assert.equal(hosts.pullUrlOf("github", "ada/engine", 12), "https://github.com/ada/engine/pull/12");
  assert.equal(hosts.pullUrlOf("gitlab", "ada/platform/engine", 7), "https://gitlab.com/ada/platform/engine/-/merge_requests/7");
  assert.equal(hosts.pullUrlOf("bitbucket", "ada/engine", 3), "https://bitbucket.org/ada/engine/pull-requests/3");
});

test("a token that cannot be the host's is refused before anything is sent", () => {
  // A shape check, not a verification - but it is what turns a typo into a
  // sentence about the token rather than a 401 about credentials.
  assert.equal(hosts.HOSTS.github.whyNotAToken("ghp_something"), null);
  assert.equal(hosts.HOSTS.github.whyNotAToken({ token: "github_pat_11ABCD" }), null);
  assert.match(hosts.HOSTS.github.whyNotAToken("glpat-wrong-host"), /GitHub token/);
  assert.match(hosts.HOSTS.github.whyNotAToken(""), /Paste a GitHub/);

  assert.equal(hosts.HOSTS.gitlab.whyNotAToken("glpat-something"), null);
  assert.match(hosts.HOSTS.gitlab.whyNotAToken("ghp_wrong-host"), /glpat-/);

  // Bitbucket signs in with two halves, and the username is the one people
  // leave out because no other host on the page wants one.
  assert.equal(hosts.HOSTS.bitbucket.whyNotAToken({ username: "ada", token: "app-password" }), null);
  assert.match(hosts.HOSTS.bitbucket.whyNotAToken({ token: "app-password" }), /username/);
  assert.match(hosts.HOSTS.bitbucket.whyNotAToken({ username: "ada" }), /app password/);
});

// ------------------------------------------------------- what each host says

test("GitLab's own JSON becomes the one shape the fold takes, and a bad token is a sentence", async () => {
  assert.deepEqual(await hosts.HOSTS.gitlab.verify(GITLAB_TOKEN), { account: "ada" });

  const refused = await hosts.HOSTS.gitlab.verify({ token: "glpat-not-the-one" }).then(
    () => null,
    (err) => err,
  );
  assert.equal(refused.status, 401);
  assert.match(refused.message, /^GitLab did not accept that token\./, "the host is named, and the sentence is for a person");
  assert.match(refused.message, /read_api/, "and it says what the token has to be able to do");

  gitlab.state.add({
    iid: 7,
    title: "Make the clock idempotent",
    description: "Reverts ada/platform/engine#4 and picks up #5",
    state: "merged",
    merged_at: "2026-09-03T09:00:00.000Z",
    merge_commit_sha: "abc1234def",
    source_branch: "feature/clock",
  });
  const described = await hosts.HOSTS.gitlab.describePull({ fullName: "ada/platform/engine", number: 7, credential: GITLAB_TOKEN });
  assert.equal(described.host, "gitlab");
  assert.equal(described.repo, "ada/platform/engine", "the whole path, subgroup and all");
  assert.equal(described.number, 7, "the iid, which is the number a person sees");
  assert.equal(described.state, "merged");
  assert.equal(described.headRef, "feature/clock");
  assert.equal(described.baseRef, "main");
  assert.equal(described.mergeCommitSha, "abc1234def");
  assert.equal(described.url, "https://gitlab.com/ada/platform/engine/-/merge_requests/7");
  assert.deepEqual(described.author, { login: "ada", bot: false });
  assert.equal(described.mergedAt, Date.parse("2026-09-03T09:00:00.000Z"));
  assert.deepEqual(described.mentions, [4, 5], "numbers, never the words they were read out of");
  assert.equal(described.reverts, 4);
  assert.equal(described.additions, null, "GitLab says nothing about lines without a read of the diff, which is not nought");
  assert.equal(described.changedFiles, 3);
  assert.equal(described.body, undefined, "the description stops here");

  // An open one, and one GitLab calls closed.
  gitlab.state.add({ iid: 8, state: "opened" });
  gitlab.state.add({ iid: 9, state: "closed", closed_at: "2026-09-04T09:00:00.000Z" });
  assert.equal((await hosts.HOSTS.gitlab.describePull({ fullName: "ada/platform/engine", number: 8, credential: GITLAB_TOKEN })).state, "open");
  assert.equal((await hosts.HOSTS.gitlab.describePull({ fullName: "ada/platform/engine", number: 9, credential: GITLAB_TOKEN })).state, "closed");

  // The person's own, in one call: GitLab's top-level listing is already
  // scoped to whoever is asking.
  const mine = await hosts.HOSTS.gitlab.listMine({ credential: GITLAB_TOKEN, since: Date.parse("2026-08-01T00:00:00Z") });
  assert.deepEqual(mine.map((merge) => merge.number).sort(), [7, 8, 9]);
  assert.ok(mine.every((merge) => merge.repo === "ada/platform/engine" && merge.host === "gitlab"));
  const asked = gitlab.state.listings.at(-1);
  assert.equal(asked.scope, "created_by_me");
  assert.equal(asked.state, "all", "a listing that asked for open ones only would never learn anything merged");
});

test("Bitbucket signs in with both halves, and its four states are the three a record has", async () => {
  assert.deepEqual(await hosts.HOSTS.bitbucket.verify(BITBUCKET), { account: "ada" });
  const refused = await hosts.HOSTS.bitbucket.verify({ username: "ada", token: "wrong" }).then(
    () => null,
    (err) => err,
  );
  assert.equal(refused.status, 401);
  assert.match(refused.message, /^Bitbucket did not accept that token\./);
  assert.match(refused.message, /Invalid credentials/, "with Bitbucket's own words kept");
  // The username is half the credential, so the wrong one is refused too.
  assert.equal(
    await hosts.HOSTS.bitbucket.verify({ username: "bob", token: bitbucket.state.token }).then(() => null, (err) => err.status),
    401,
  );

  bitbucket.state.add({ id: 3, title: "A clock", state: "MERGED", merge_commit: "beef1234", updated_on: "2026-09-05T10:00:00.000000+00:00" });
  bitbucket.state.add({ id: 4, state: "OPEN" });
  bitbucket.state.add({ id: 5, state: "DECLINED", updated_on: "2026-09-06T10:00:00.000000+00:00" });
  bitbucket.state.add({ id: 6, state: "SUPERSEDED" });

  const described = await hosts.HOSTS.bitbucket.describePull({ fullName: "ada/engine", number: 3, credential: BITBUCKET });
  assert.equal(described.host, "bitbucket");
  assert.equal(described.repo, "ada/engine");
  assert.equal(described.state, "merged");
  assert.equal(described.mergeCommitSha, "beef1234");
  assert.equal(described.url, "https://bitbucket.org/ada/engine/pull-requests/3");
  assert.equal(described.headRef, "feature/clock");
  // There is no `closed_on`, so a settled pull request's last movement is
  // when it settled.
  assert.equal(described.mergedAt, Date.parse("2026-09-05T10:00:00.000Z"));

  const mine = await hosts.HOSTS.bitbucket.listMine({ credential: BITBUCKET, since: Date.parse("2026-08-01T00:00:00Z") });
  const byNumber = Object.fromEntries(mine.map((pull) => [pull.number, pull.state]));
  assert.deepEqual(byNumber, { 3: "merged", 4: "open", 5: "closed", 6: "closed" }, "declined and superseded are both closed: neither landed");
  assert.deepEqual(bitbucket.state.listings.at(-1).state, ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]);
});

test("GitHub's search finds the person's own, and each is read whole so the fold has a head and a base", async () => {
  const token = { token: github.state.token };
  assert.deepEqual(await hosts.HOSTS.github.verify(token), { account: "ada" });
  // The fake indexes its pull requests by number, so this is the first.
  github.state.pulls.push({
    number: 1, html_url: "https://github.com/ada/engine/pull/1", title: "A clock", body: "Fixes #3",
    state: "closed", merged: true, merge_commit_sha: "cafe1234",
    head: "feature/clock", base: "main", user: { login: "ada" },
  });
  const described = await hosts.HOSTS.github.describePull({ fullName: "ada/engine", number: 1, credential: token });
  assert.equal(described.host, "github");
  assert.equal(described.state, "merged", "closed and merged is merged, not closed");
  assert.equal(described.headRef, "feature/clock");
  assert.deepEqual(described.mentions, [3]);

  const mine = await hosts.HOSTS.github.listMine({ credential: token, limit: 10 });
  assert.deepEqual(mine.map((pull) => [pull.repo, pull.number, pull.state]), [["ada/engine", 1, "merged"]]);
  assert.match(github.state.searches.at(-1), /is:pr author:@me updated:>=\d{4}-\d{2}-\d{2}/);
  assert.ok(github.state.pullReads.length, "the search answers in the issue shape, so each one is read whole");
});

// ------------------------------------------------------------ the keeping

test("a connected host is kept on the owner's row, encrypted, and never handed back", async () => {
  userRecord.forget(ADA);
  assert.deepEqual(await credentials.listFor(ADA), []);

  const connected = await credentials.connect(ADA, "gitlab", GITLAB_TOKEN);
  assert.equal(connected.host, "gitlab");
  assert.equal(connected.account, "ada", "who the token is, asked of GitLab rather than typed in");

  const listed = await credentials.listFor(ADA);
  assert.deepEqual(listed.map(({ host, account }) => ({ host, account })), [{ host: "gitlab", account: "ada" }]);
  assert.equal(JSON.stringify(listed).includes(gitlab.state.token), false, "the listing is what a page reads, and a token is not in it");

  // The credential itself is only for the one caller that has to have it.
  assert.deepEqual(await credentials.credentialFor(ADA, "gitlab"), GITLAB_TOKEN);
  assert.equal(await credentials.credentialFor(ADA, "github"), null, "a host nobody connected has no credential");

  // On the row, as a field beside the rest of the account - and not in
  // plain sight even there when a secret is set (crypto-at-rest.js).
  const row = await userRecord.read(ADA);
  assert.ok(row.gitHosts.gitlab.credential, "the row holds it");
  assert.equal(row.gitHosts.gitlab.credential.includes("password"), false);

  // A token the host refuses is a refusal here, and nothing is kept: a page
  // that said "connected" over a sweep failing silently every five minutes
  // is the failure this order avoids.
  const refused = await credentials.connect(ADA, "bitbucket", { username: "ada", token: "wrong" }).then(() => null, (err) => err);
  assert.equal(refused.status, 401);
  assert.equal((await credentials.listFor(ADA)).length, 1, "nothing was kept");

  // And one that cannot be the host's token at all never reaches the host.
  const shape = await credentials.connect(ADA, "gitlab", { token: "ghp_wrong-host" }).then(() => null, (err) => err);
  assert.equal(shape.status, 400);

  // A host this app does not know is a 404 rather than a silent nothing.
  const unknown = await credentials.connect(ADA, "sourcehut", { token: "x" }).then(() => null, (err) => err);
  assert.equal(unknown.status, 404);

  // Disconnecting stops the asking and leaves the records alone.
  assert.equal(await credentials.disconnect(ADA, "gitlab"), true);
  assert.equal(await credentials.disconnect(ADA, "gitlab"), false, "twice is not a second forget");
  assert.deepEqual(await credentials.listFor(ADA), []);
});

// -------------------------------------------------------------- the sweep

test("a merged merge request reaches the session that was on its branch, and a second sweep changes nothing", async () => {
  userRecord.forget(ADA);
  await credentials.connect(ADA, "gitlab", GITLAB_TOKEN);

  // A session on this machine, in a checkout of the GitLab project. Nothing
  // told this app that a merge request was opened: the branch is the whole
  // of the link.
  const session = sessionLog.open({
    kind: "harness",
    owner: ADA,
    actor: { kind: "harness", id: "h-1", name: "Terminal Claude" },
    repo: { kind: "github", fullName: "ada/platform/engine", host: "gitlab" },
    branch: "feature/sweep",
  });
  gitlab.state.add({
    iid: 21,
    title: "Sweep the clock",
    state: "merged",
    merged_at: "2026-09-07T09:00:00.000Z",
    updated_at: "2026-09-07T09:00:00.000Z",
    source_branch: "feature/sweep",
  });

  const swept = await sync.sweep(ADA, { since: Date.parse("2026-08-01T00:00:00Z") });
  assert.equal(swept.hosts, 1);
  assert.ok(swept.seen >= 1);
  assert.deepEqual(swept.failed, []);

  const record = await pulls.get("ada/platform/engine", 21, "gitlab");
  assert.equal(record.state, "merged");
  assert.equal(record.id, "gitlab:ada/platform/engine!21");
  assert.deepEqual(record.sessionIds, [session.id], "joined by repository and branch, with nobody having told us anything");
  assert.equal(session.outcome, "merged", "which is what Performance counts");

  // Again with nothing new to say: no write, no second event.
  const heard = [];
  const stop = pulls.onChanged((change) => heard.push(change.pull.id));
  const second = await sync.sweep(ADA, { since: Date.parse("2026-08-01T00:00:00Z") });
  stop();
  assert.ok(second.seen >= 1);
  assert.equal(second.changed, 0, "a re-listing that came back the same changes nothing");
  assert.deepEqual(heard, []);

  // A host whose token stopped working fails on its own, and says which.
  await credentials.connect(ADA, "bitbucket", BITBUCKET);
  const held = await userRecord.read(ADA);
  await userRecord.patch(ADA, { gitHosts: { ...held.gitHosts, gitlab: { ...held.gitHosts.gitlab, credential: JSON.stringify({ token: "glpat-expired" }) } } });
  const mixed = await sync.sweep(ADA, { since: Date.parse("2026-08-01T00:00:00Z") });
  assert.deepEqual(mixed.failed, ["gitlab"], "one host's refusal is not the other's");
  assert.equal(mixed.hosts, 2);
});

test("asking one host about one record folds what it says, and asks nobody when nothing is connected", async () => {
  userRecord.forget(ADA);
  gitlab.state.add({ iid: 31, state: "opened", source_branch: "feature/one", updated_at: "2026-09-08T09:00:00.000Z" });
  const record = await pulls.noteOpened({
    repoId: null, host: "gitlab", repo: "ada/platform/engine", number: 31,
    url: hosts.pullUrlOf("gitlab", "ada/platform/engine", 31), branch: "feature/one", title: null,
  });
  assert.equal(record.host, "gitlab");

  // Nothing connected: nothing asked, and the record stands as noted.
  assert.equal(await sync.refreshPull(record, { user: ADA }), null);

  await credentials.connect(ADA, "gitlab", GITLAB_TOKEN);
  gitlab.state.add({ iid: 31, title: "The one", state: "merged", merged_at: "2026-09-09T09:00:00.000Z", source_branch: "feature/one" });
  const after = await sync.refreshPull(record, { user: ADA });
  assert.equal(after.state, "merged");
  assert.equal(after.title, "The one", "what the agent left blank, the host filled");

  // And the event it folded through is the one a webhook would have
  // delivered, marked as learnt by asking.
  const event = sync.asEvent(await hosts.HOSTS.gitlab.describePull({ fullName: "ada/platform/engine", number: 31, credential: GITLAB_TOKEN }));
  assert.equal(event.kind, "pull");
  assert.equal(event.polled, true);
  assert.equal(event.host, "gitlab");
  assert.equal(event.body, undefined, "never the words");
});

test("a sweep with nobody connected reaches no host at all", async () => {
  userRecord.forget("nobody@example.com");
  const before = gitlab.state.requests.length;
  const swept = await sync.sweep("nobody@example.com");
  assert.deepEqual(swept, { hosts: 0, seen: 0, changed: 0, failed: [] });
  assert.equal(gitlab.state.requests.length, before, "nothing on a timer reaches the network until a host is connected");

  // The timer itself is the same bargain: it is started, and a round with
  // nobody connected asks nobody anything.
  const stop = sync.start({ users: () => [], everyMs: 60_000, sweepAfterMs: null });
  stop();
});

// -------------------------------------------------- what a hook noticed

test("the pull request a command opened is read for each host's own words", () => {
  assert.deepEqual(pullOpenedBy("glab mr create --fill", { stdout: "https://gitlab.com/ada/platform/engine/-/merge_requests/7" }), {
    host: "gitlab",
    repo: "ada/platform/engine",
    number: 7,
    url: "https://gitlab.com/ada/platform/engine/-/merge_requests/7",
  });
  assert.deepEqual(pullOpenedBy("git push origin feature/clock", { stderr: "remote: https://bitbucket.org/ada/engine/pull-requests/3\n" }), {
    host: "bitbucket",
    repo: "ada/engine",
    number: 3,
    url: "https://bitbucket.org/ada/engine/pull-requests/3",
  });
  assert.equal(pullOpenedBy("glab mr view 7", { stdout: "https://gitlab.com/ada/engine/-/merge_requests/7" }), null, "viewing is not opening");
});
