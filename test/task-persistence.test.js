// A task, once sent, stays sent.
//
// Tasks live on the repo record and the registry keeps every record in
// memory, re-reading the store now and then (`refresh`) in case another
// process wrote. The store is read as a whole scan, and a scan is slow: it
// can begin before a save lands and return after it, carrying the copy from
// before. Merging that copy over memory silently undid the save - the task
// was in the store and gone from memory, and the next routine write of the
// record (an agent's lastSeenAt, a lease) put memory's task-less copy back
// over the store. Tasks were "often lost", and so was anything else saved in
// the window: a lead set, a focus, which repo an agent had moved to.
//
// The rule: a re-read never takes the registry backwards. What memory has
// saved is newer than anything a scan can bring in, unless another process
// wrote after - which the record's own revision number tells apart.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codervibes-tasks-"));
process.env.CODERVIBES_DATA_DIR = dataDir;
process.env.CODERVIBES_REPOS = path.join(dataDir, "repos");

const { repos } = await import("../server/repos.js");
const { store } = await import("../server/store/index.js");
const { createTask, tasksFor } = await import("../server/agent-tasks.js");
const events = await import("../server/events.js");

test.after(() => events.flush());

const OWNER = "ada@example.com";
const who = (id, name) => ({ id, name });

/** The registry's record as the store holds it right now - read directly,
 *  under whatever a test has done to the registry's own reads. */
const read = store.loadRepos.bind(store);
const stored = async (id) => (await read()).find((entry) => entry.id === id);

test("a task sent while the registry was re-reading the store is not undone by the re-read", async () => {
  repos.repos.clear();
  repos.loaded = true;
  const made = await repos.create("Shop", OWNER);
  const repo = repos.get(made.id);
  // One task already there, so this is a repo with a task list, not
  // one without - a re-read that merges by field only clobbers a field it
  // has.
  await createTask(repos, repo, {
    from: who("a", "Scout"),
    to: who("c", "Tester"),
    title: "Write the tests",
  });

  // A scan that has already read the file - before the task - and is now
  // waiting on the network, the way a DynamoDB scan of every repo is
  // for a hundred milliseconds or so.
  let release;
  const held = new Promise((resolve) => (release = resolve));
  store.loadRepos = async () => {
    const before = await read();
    await held;
    return before;
  };
  const refreshing = repos.refresh();
  await new Promise((resolve) => setTimeout(resolve, 20));

  try {
    const task = await createTask(repos, repo, {
      from: who("a", "Scout"),
      to: who("b", "Builder"),
      title: "Add a /health route",
    });
    assert.equal((await stored(repo.id)).tasks.length, 2, "the save landed");

    release();
    await refreshing;
    assert.equal(
      tasksFor(repos, "b", { role: "to" }).length,
      1,
      "and the re-read did not take it back out of memory",
    );
    assert.equal(repos.get(repo.id).tasks[1].id, task.id);

    // The write that used to finish the job: any routine save of the record.
    await repos.setDescription(repo.id, "still here", OWNER);
    assert.equal((await stored(repo.id)).tasks.length, 2, "nor out of the store");
  } finally {
    store.loadRepos = read;
  }
});

test("a record another process wrote is still taken, because its revision is newer", async () => {
  repos.repos.clear();
  repos.loaded = true;
  const made = await repos.create("Lab", OWNER);

  // The other process's write: the store's copy, one revision on, with a
  // change this process has never seen.
  const theirs = { ...(await stored(made.id)), description: "renamed elsewhere" };
  theirs.rev = (theirs.rev ?? 0) + 1;
  await store.putRepo(theirs, [theirs]);

  await repos.refresh();
  assert.equal(repos.get(made.id).description, "renamed elsewhere");
});

test("a store that has fallen behind memory is brought up to date by the re-read", async () => {
  repos.repos.clear();
  repos.loaded = true;
  const made = await repos.create("Bench", OWNER);
  const repo = repos.get(made.id);
  await createTask(repos, repo, {
    from: who("a", "Scout"),
    to: who("b", "Builder"),
    title: "Wire the bench",
  });

  // The store loses the write - a stale object saved over it, a put that
  // arrived out of order. Memory is right and the store is not.
  const behind = { ...(await stored(repo.id)), tasks: [], rev: repo.rev - 1 };
  await store.putRepo(behind, [behind]);
  assert.equal((await stored(repo.id)).tasks.length, 0, "the store has forgotten");

  await repos.refresh();
  assert.equal(repos.get(repo.id).tasks.length, 1, "memory kept the task");
  assert.equal((await stored(repo.id)).tasks.length, 1, "and gave it back to the store");
});
