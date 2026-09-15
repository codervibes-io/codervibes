// Agents handing work to each other.
//
// The interesting half of this is the refusals. Delegation between agents that
// can each delegate is a graph, and the failure it invites is a cycle: A asks
// B, B asks A, and both wait forever - or worse, both work forever, spending
// somebody's money on a loop nobody is watching.
//
// Two guards, tested separately because they catch different things. Ancestry
// depends on the agent saying which task it is working under, and catches the
// honest case. Reachability is computed from the tasks that exist, and catches
// the case where nobody said anything at all.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createTask, updateTask, reassignTask, tasksFor, findTask, directory, sweepOverdue, dueAt, overdue,
  workingOn, graceFor, reportsFor, newestReport, piecesOf, MAX_CHAIN, MAX_OPEN_PER_AGENT, MAX_ATTEMPTS,
} from "../server/agent-tasks.js";
import { onRing } from "../server/wake.js";

/** The part of the repo registry these functions touch. */
function fakeRegistry(...records) {
  const repos = new Map(records.map((record) => [record.id, record]));
  return { repos, async save() {} };
}

const aRepo = (over = {}) => ({
  id: "shop-a1b2c3",
  name: "Shop",
  owner: "ada@example.com",
  tasks: [],
  ...over,
});

const who = (id, name) => ({ id, name });

test("a task has two named ends, and starts open", async () => {
  const repo = aRepo();
  const registry = fakeRegistry(repo);

  const task = await createTask(registry, repo, {
    from: who("a", "Scout"),
    to: who("b", "Builder"),
    title: "  Add a  /health route ",
    detail: "The load balancer needs one. 200 and a JSON body is enough.",
  });

  assert.equal(task.title, "Add a /health route", "trimmed, and one line");
  assert.equal(task.state, "open");
  assert.equal(task.from.name, "Scout");
  assert.equal(task.to.name, "Builder");
  assert.equal(task.repoId, repo.id);
  assert.equal(task.parentId, null);
  assert.deepEqual(repo.tasks, [task], "and it is on the repo");
});

test("a task needs a title", async () => {
  const repo = aRepo();
  const registry = fakeRegistry(repo);

  await assert.rejects(
    () => createTask(registry, repo, { from: who("a", "A"), to: who("b", "B"), title: "  " }),
    /needs a title/,
  );
});

// ------------------------------------------------------------- the cycles

test("work cannot be sent back to an agent it already came through", async () => {
  // A asks B; B, working on that, tries to ask A. The chain says A has already
  // touched this piece of work, so sending it back is a loop.
  const repo = aRepo();
  const registry = fakeRegistry(repo);

  const first = await createTask(registry, repo, {
    from: who("a", "Scout"),
    to: who("b", "Builder"),
    title: "Add a health route",
  });

  await assert.rejects(
    () =>
      createTask(registry, repo, {
        from: who("b", "Builder"),
        to: who("a", "Scout"),
        title: "Tell me what shape the body should be",
        because: first.id,
      }),
    (err) => {
      assert.match(err.message, /already came through 'Scout'/);
      assert.match(err.message, new RegExp(first.id), "and says which task");
      assert.match(err.message, /Answer them instead/, "and what to do about it");
      return true;
    },
  );

  // Three deep is the same rule: A -> B -> C, and C cannot go back to A.
  const second = await createTask(registry, repo, {
    from: who("b", "Builder"),
    to: who("c", "Dbot"),
    title: "Add the column",
    because: first.id,
  });
  await assert.rejects(
    () =>
      createTask(registry, repo, {
        from: who("c", "Dbot"),
        to: who("a", "Scout"),
        title: "Back to you",
        because: second.id,
      }),
    /already came through 'Scout'/,
  );
});

test("and cannot be sent to an agent already waiting on you, however far round", async () => {
  // The guard that needs no honesty: B asked C, C asked A, and now A tries to
  // ask B without mentioning any of it. Nothing declared, and it still closes
  // a loop - so it is refused from the task graph alone.
  const repo = aRepo();
  const registry = fakeRegistry(repo);

  await createTask(registry, repo, {
    from: who("b", "Builder"),
    to: who("c", "Dbot"),
    title: "one",
  });
  await createTask(registry, repo, {
    from: who("c", "Dbot"),
    to: who("a", "Scout"),
    title: "two",
  });

  await assert.rejects(
    () =>
      createTask(registry, repo, {
        from: who("a", "Scout"),
        to: who("b", "Builder"),
        title: "three - and round we go",
      }),
    /already waiting on you/,
  );

  // Settle the chain and the same send is fine: nobody is waiting any more.
  for (const task of repo.tasks) {
    await updateTask(registry, task.id, task.to.id, { state: "done", note: "done" });
  }
  const now = await createTask(registry, repo, {
    from: who("a", "Scout"),
    to: who("b", "Builder"),
    title: "three, now that the air is clear",
  });
  assert.equal(now.state, "open");
});

test("a chain of hand-offs has an end", async () => {
  const repo = aRepo();
  const registry = fakeRegistry(repo);

  // A fresh pair each step, so ancestry is the only thing that can stop it.
  let previous = null;
  for (let step = 0; step < MAX_CHAIN; step++) {
    previous = await createTask(registry, repo, {
      from: who(`a${step}`, `A${step}`),
      to: who(`a${step + 1}`, `A${step + 1}`),
      title: `step ${step}`,
      because: previous?.id,
    });
  }

  await assert.rejects(
    () =>
      createTask(registry, repo, {
        from: who(`a${MAX_CHAIN}`, `A${MAX_CHAIN}`),
        to: who("z", "Z"),
        title: "one more",
        because: previous.id,
      }),
    /hand-offs deep, which is the limit/,
  );
});

test("an agent cannot be buried", async () => {
  const repo = aRepo();
  const registry = fakeRegistry(repo);
  for (let i = 0; i < MAX_OPEN_PER_AGENT; i++) {
    await createTask(registry, repo, {
      from: who(`s${i}`, `S${i}`),
      to: who("b", "Builder"),
      title: `task ${i}`,
    });
  }
  await assert.rejects(
    () =>
      createTask(registry, repo, {
        from: who("late", "Late"),
        to: who("b", "Builder"),
        title: "one more",
      }),
    /which is the limit/,
  );
});

// ------------------------------------------------------- moving them along

test("only the two ends may touch a task, and they may do different things", async () => {
  const repo = aRepo();
  const registry = fakeRegistry(repo);
  const task = await createTask(registry, repo, {
    from: who("a", "Scout"),
    to: who("b", "Builder"),
    title: "Add a health route",
  });

  // A third agent has no business here at all.
  await assert.rejects(
    () => updateTask(registry, task.id, "c", { state: "done" }),
    /not yours/,
  );

  // The sender can withdraw it, but cannot declare it finished - otherwise
  // "did you do it" is a question the asker answers.
  await assert.rejects(
    () => updateTask(registry, task.id, "a", { state: "done" }),
    /not yours to say/,
  );
  const withdrawn = await updateTask(registry, task.id, "a", {
    state: "declined",
    note: "never mind, did it myself",
  });
  assert.equal(withdrawn.state, "declined");

  // The receiver can say anything about it.
  const done = await updateTask(registry, task.id, "b", {
    state: "done",
    note: "Added /health, returns {ok:true}",
  });
  assert.equal(done.state, "done");
  assert.match(done.note, /ok:true/);

  await assert.rejects(
    () => updateTask(registry, task.id, "b", { state: "nonsense" }),
    /Unknown state/,
  );
  await assert.rejects(() => updateTask(registry, "no-such-task", "b", {}), /No task with id/);
});

test("each end sees the same task from its own side", async () => {
  const repo = aRepo();
  const registry = fakeRegistry(repo);
  const first = await createTask(registry, repo, {
    from: who("a", "Scout"),
    to: who("b", "Builder"),
    title: "one",
  });
  // Settled first: B cannot ask A for anything while A is still waiting on B,
  // which is the reachability guard above doing its job.
  await updateTask(registry, first.id, "b", { state: "done", note: "done" });
  await createTask(registry, repo, {
    from: who("b", "Builder"),
    to: who("a", "Scout"),
    title: "two",
  });

  assert.equal(tasksFor(registry, "a", { role: "to" }).length, 1);
  assert.equal(tasksFor(registry, "a", { role: "from" }).length, 1);
  assert.equal(tasksFor(registry, "a").length, 2, "either end, by default");
  assert.equal(tasksFor(registry, "zzz").length, 0);
  assert.equal(tasksFor(registry, "a", { state: "done" }).length, 1, "the settled one");
  assert.equal(tasksFor(registry, "a", { state: "blocked" }).length, 0);

  assert.ok(findTask(registry, repo.tasks[0].id));
  assert.equal(findTask(registry, "nope"), null);
});

// -------------------------------------------------------------- who to ask

test("the directory says what each agent is for and how buried it is", async () => {
  const repo = aRepo();
  const registry = fakeRegistry(repo);
  await createTask(registry, repo, {
    from: who("a", "Scout"),
    to: who("b", "Builder"),
    title: "one",
  });

  const listed = directory(registry, [
    { id: "a", name: "Scout", focus: "reading unfamiliar code", repos: [] },
    { id: "b", name: "Builder", focus: "", repos: [] },
  ], { exclude: "a" });

  assert.equal(listed.length, 1, "you are not in your own directory");
  assert.equal(listed[0].name, "Builder");
  // How much it is already holding, because the answer to "who should do this"
  // changes if the obvious candidate is buried.
  assert.equal(listed[0].openTasks, 1);
});

// ------------------------------------------------- moving, keeping, timing

/** A repo whose agents are known, so tasks can be moved between them. */
const aLedRepo = (_lead, ...agents) =>
  aRepo({ agents: agents.map(({ id, name }) => ({ id, name })) });

test("the agent that sent a task can move it to another agent; nobody else can", async () => {
  const scout = who("a", "Scout");
  const builder = who("b", "Builder");
  const dbot = who("c", "Dbot");
  const repo = aLedRepo(null, scout, builder, dbot);
  const registry = fakeRegistry(repo);

  const task = await createTask(registry, repo, { from: builder, to: scout, title: "index the table" });

  // Not the sender - not even the holder: refused. There is no lead whose
  // word overrides the sender's.
  await assert.rejects(
    () => reassignTask(registry, task.id, "c", builder),
    /Only the agent that sent a task may move it/,
  );
  await assert.rejects(
    () => reassignTask(registry, task.id, "a", dbot),
    /Only the agent that sent a task may move it/,
  );
  // The sender may not move it to itself - that is a loop.
  await assert.rejects(() => reassignTask(registry, task.id, "b", builder), /Sending it back is a loop/);
  // Nor to somebody not in the repo, who could not act on it.
  await assert.rejects(() => reassignTask(registry, task.id, "b", who("z", "Zed")), /not in this repo/);

  const moved = await reassignTask(registry, task.id, "b", dbot, { note: "databases are Dbot's" });
  assert.equal(moved.to.id, "c");
  assert.equal(moved.state, "open", "it starts again for the new agent");
  assert.match(moved.note, /Moved from Scout by Builder: databases are Dbot's/);
  // The new holder sees it as theirs; the old one no longer does.
  assert.equal(tasksFor(registry, "c", { role: "to" }).length, 1);
  assert.equal(tasksFor(registry, "a", { role: "to" }).length, 0);

  // Finished work is not moved: there is nothing left to do.
  await updateTask(registry, task.id, "c", { state: "done", note: "done" });
  await assert.rejects(() => reassignTask(registry, task.id, "b", scout), /nothing left to move/);
});

test("a task is between the two agents on it; a third cannot settle it", async () => {
  const other = who("l", "Other");
  const builder = who("b", "Builder");
  const dbot = who("c", "Dbot");
  const repo = aLedRepo(null, other, builder, dbot);
  const registry = fakeRegistry(repo);
  const task = await createTask(registry, repo, { from: builder, to: dbot, title: "one" });

  // A third agent - in the repo or not - cannot touch it...
  await assert.rejects(
    () => updateTask(registry, task.id, "l", { state: "declined" }),
    /not yours/,
  );
  const elsewhere = aRepo({ id: "other", agents: [] });
  await assert.rejects(
    () => updateTask(fakeRegistry(elsewhere, repo), task.id, "z", { state: "declined" }),
    /not yours/,
  );
  // ...the sender can withdraw it...
  const settled = await updateTask(registry, task.id, "b", { state: "declined", note: "not needed" });
  assert.equal(settled.state, "declined");
  // ...but not call it done: only the holder knows that.
  const again = await createTask(registry, repo, { from: builder, to: dbot, title: "two" });
  await assert.rejects(
    () => updateTask(registry, again.id, "b", { state: "done" }),
    /not yours to say/,
  );
});

test("any agent may keep a piece of a plan for itself", async () => {
  const planner = who("l", "Planner");
  const builder = who("b", "Builder");
  const repo = aLedRepo(null, planner, builder);
  const registry = fakeRegistry(repo);

  // A task to yourself is a piece of a plan with your own name on it, so
  // the Tasks tab shows who has it. Any agent breaking a request into
  // pieces may keep one.
  const asked = await createTask(registry, repo, { from: builder, to: planner, title: "ship the login page" });
  const mine = await createTask(registry, repo, {
    from: planner,
    to: planner,
    title: "wire the form to /api/login",
    because: asked.id,
    minutes: 20,
    difficulty: "medium",
  });
  assert.equal(mine.to.id, "l");
  assert.equal(mine.parentId, asked.id, "a piece of the task it was asked to do");
  assert.equal(mine.state, "open", "on the board like any other, until it is accepted");
  assert.equal(tasksFor(registry, "l", { role: "to" }).length, 2);

  // Kept for itself is not a loop, however many times: a second piece under
  // the same parent is fine too, even though the planner is now in the chain.
  const another = await createTask(registry, repo, {
    from: planner,
    to: planner,
    title: "style the form",
    because: mine.id,
    minutes: 10,
    difficulty: "easy",
  });
  assert.equal(another.parentId, mine.id);
  // Builder, too, may note a piece for itself.
  const tidy = await createTask(registry, repo, { from: builder, to: builder, title: "tidy up" });
  assert.equal(tidy.to.id, "b");
  // But the cap still holds for its own pieces, like anybody's.
  for (let i = tasksFor(registry, "l", { role: "to" }).length; i < MAX_OPEN_PER_AGENT; i += 1) {
    await createTask(registry, repo, { from: planner, to: planner, title: `piece ${i}`, minutes: 5, difficulty: "easy" });
  }
  await assert.rejects(
    () => createTask(registry, repo, { from: planner, to: planner, title: "one too many", minutes: 5, difficulty: "easy" }),
    /holding/,
  );
});

test("a piece sent back up the chain is a loop for everyone - there is no lead it may go to", async () => {
  const planner = who("l", "Planner");
  const builder = who("b", "Builder");
  const dbot = who("c", "Dbot");
  const repo = aLedRepo(null, planner, builder, dbot);
  const registry = fakeRegistry(repo);

  // Planner hands Builder a piece. Builder, doing it, wants Planner to do
  // something in turn.
  const piece = await createTask(registry, repo, { from: planner, to: builder, title: "add the route", minutes: 15, difficulty: "medium" });
  await updateTask(registry, piece.id, "b", { state: "accepted" });

  // With nobody whose job is dispatching, that is what it looks like: the
  // work going back to the agent that is waiting on it. Refused - it is a
  // question for the chat, not a task for the board.
  await assert.rejects(
    () => createTask(registry, repo, { from: builder, to: planner, title: "deploy the route", because: piece.id }),
    /Sending it back is a loop/,
  );
  await assert.rejects(
    () => createTask(registry, repo, { from: builder, to: planner, title: "deploy the route" }),
    /already waiting on you/,
  );

  // The sender is not blocked from sending more by what it is waiting on...
  const next = await createTask(registry, repo, { from: planner, to: builder, title: "add the tests", minutes: 10, difficulty: "easy" });
  assert.equal(next.to.id, "b");
  // ...and Builder may pass a piece sideways to somebody outside the chain.
  const across = await createTask(registry, repo, { from: builder, to: dbot, title: "index it", because: piece.id });
  assert.equal(across.parentId, piece.id);
  await assert.rejects(
    () => createTask(registry, repo, { from: dbot, to: builder, title: "and you do this" }),
    /already waiting on you/,
  );
});

test("a task may carry a time and a difficulty; the clock starts when the task is accepted", async () => {
  const lead = who("l", "Planner");
  const builder = who("b", "Builder");
  const dbot = who("c", "Dbot");
  const repo = aLedRepo(null, lead, builder, dbot);
  const registry = fakeRegistry(repo);

  // An estimate is optional for everyone, but one that is given is checked.
  await assert.rejects(
    () => createTask(registry, repo, { from: lead, to: builder, title: "add the route", minutes: 0, difficulty: "hard" }),
    /whole number from 1 to/,
  );
  await assert.rejects(
    () => createTask(registry, repo, { from: lead, to: builder, title: "add the route", minutes: 10, difficulty: "brutal" }),
    /one of easy, medium, hard/,
  );
  const asked = await createTask(registry, repo, { from: dbot, to: lead, title: "deploy it" });
  assert.equal(asked.estimateMinutes, undefined);

  const task = await createTask(registry, repo, {
    from: lead, to: builder, title: "add the route", minutes: 10, difficulty: "Medium",
  });
  assert.equal(task.estimateMinutes, 10);
  assert.equal(task.difficulty, "medium", "case is not a difficulty");
  assert.equal(dueAt(task), null, "no clock runs on a task nobody has picked up");
  assert.equal(overdue(task, Date.now() + 3_600_000), false, "however long it sits");

  const accepted = await updateTask(registry, task.id, "b", { state: "accepted" });
  const due = dueAt(accepted);
  assert.ok(Math.abs(due - (Date.parse(accepted.acceptedAt) + 10 * 60_000)) < 5, "ten minutes from the accept");
  assert.equal(overdue(accepted, due - 1), false);
  assert.equal(overdue(accepted, due), true);
  assert.equal(workingOn(registry, "b")?.id, task.id, "the one task it is on");
});

test("when the time is up the task is marked overdue, and after the grace it fails on its own, with the cost kept", async () => {
  const lead = who("l", "Lead");
  const builder = who("b", "Builder");
  const repo = aLedRepo("l", lead, builder);
  const registry = fakeRegistry(repo);
  const task = await createTask(registry, repo, {
    from: lead, to: builder, title: "add the route", minutes: 10, difficulty: "medium",
  });
  await updateTask(registry, task.id, "b", { state: "accepted", note: "reading the router" });
  const due = dueAt(findTask(registry, task.id).task);

  // Before its time: nothing.
  let swept = await sweepOverdue(registry, { now: due - 1 });
  assert.deepEqual(swept, { overdue: [], failed: [] });

  // At its time: stamped overdue once, still the agent's to report on.
  swept = await sweepOverdue(registry, { now: due });
  assert.equal(swept.overdue.length, 1);
  assert.equal(swept.failed.length, 0);
  let current = findTask(registry, task.id).task;
  assert.equal(current.state, "accepted", "told, not taken away");
  assert.ok(current.overdueAt);
  swept = await sweepOverdue(registry, { now: due + 1000 });
  assert.equal(swept.overdue.length, 0, "stamped once, so the agent is told once by the sweep");

  // After the grace with no report: failed, and the record says why, what it
  // was last seen doing, and what it cost - the ledger will not remember.
  assert.equal(graceFor(10), 2.5 * 60_000);
  assert.equal(graceFor(1), 2 * 60_000, "never under two minutes");
  const spent = { ms: 1200, workedMs: 12.5 * 60_000, machines: 2, computeMs: 25 * 60_000, calls: 3 };
  swept = await sweepOverdue(registry, {
    now: due + graceFor(10),
    lastStep: () => "Running npm test",
    spent: () => spent,
  });
  assert.equal(swept.failed.length, 1);
  current = findTask(registry, task.id).task;
  assert.equal(current.state, "failed");
  assert.equal(current.failure, "timeout");
  assert.match(current.note, /Ran out of time: estimated 10 min, 13 min on it, and no report from Builder\. Last seen: Running npm test\./);
  assert.deepEqual(current.spent, spent);
  assert.ok(current.settledAt);
  assert.equal(current.steps.at(-1).text, "Time ran out");
  assert.equal(workingOn(registry, "b"), null, "not on it any more");

  // Failed is final. The late report is still welcome; reopening is not.
  await assert.rejects(
    () => updateTask(registry, task.id, "b", { state: "done", note: "finished it anyway" }),
    /cannot be reopened.*Lead decides/,
  );
  const late = await updateTask(registry, task.id, "b", { state: "failed", note: "got the route in, tests still red" });
  assert.equal(late.note, "got the route in, tests still red", "the report replaces the sweep's guess");
  assert.equal(late.failure, "timeout", "but how it ended is not rewritten");
  assert.deepEqual(late.spent, spent, "and the cost is kept as it was at the close");
});

test("an agent may fail its own task and say why; the sender may retry it, twice", async () => {
  const lead = who("l", "Planner");
  const builder = who("b", "Builder");
  const dbot = who("c", "Dbot");
  const repo = aLedRepo(null, lead, builder, dbot);
  const registry = fakeRegistry(repo);
  const first = await createTask(registry, repo, {
    from: lead, to: builder, title: "add the route", detail: "GET /health", minutes: 10, difficulty: "medium",
  });
  await updateTask(registry, first.id, "b", { state: "accepted" });
  const failed = await updateTask(registry, first.id, "b", {
    state: "failed", note: "the router is generated; I do not know from what", spent: { workedMs: 60_000, machines: 1, computeMs: 60_000 },
  });
  assert.equal(failed.failure, "reported", "the agent said so, the clock did not");
  assert.equal(failed.spent.machines, 1);

  // Not just anybody's to retry.
  await assert.rejects(
    () => createTask(registry, repo, { from: dbot, to: builder, title: "again", retryOf: first.id }),
    /whether to retry it is theirs\./,
  );
  // And not a task that did not fail.
  const fine = await createTask(registry, repo, { from: lead, to: dbot, title: "index it", minutes: 5, difficulty: "easy" });
  await assert.rejects(
    () => createTask(registry, repo, { from: lead, to: dbot, title: "again", retryOf: fine.id, minutes: 5, difficulty: "easy" }),
    /is 'open', not failed/,
  );

  // The retry is a new task that names the old one, keeps its chain, copies
  // what was not restated, and carries the failed attempt's report.
  const second = await createTask(registry, repo, {
    from: lead, to: dbot, retryOf: first.id, minutes: 20, difficulty: "hard",
  });
  assert.equal(second.title, "add the route");
  assert.match(second.detail, /^GET \/health — Attempt 1 \(task \w+\) failed: the router is generated/);
  assert.equal(second.retryOf, first.id);
  assert.equal(second.attempt, 2);
  assert.equal(second.to.id, "c", "to somebody else, if the sender so decides");
  assert.equal(second.estimateMinutes, 20, "with its own estimate");
  assert.equal(findTask(registry, first.id).task.retriedAs, second.id, "and the old one points forward");
  await assert.rejects(
    () => createTask(registry, repo, { from: lead, to: dbot, retryOf: first.id, minutes: 20, difficulty: "hard" }),
    /already been retried/,
  );

  // Twice, and then it is a different problem.
  await updateTask(registry, second.id, "c", { state: "accepted" });
  await updateTask(registry, second.id, "c", { state: "failed", note: "same" });
  const third = await createTask(registry, repo, { from: lead, to: builder, retryOf: second.id, minutes: 30, difficulty: "hard" });
  assert.equal(third.attempt, MAX_ATTEMPTS);
  await updateTask(registry, third.id, "b", { state: "accepted" });
  await updateTask(registry, third.id, "b", { state: "failed", note: "same again" });
  await assert.rejects(
    () => createTask(registry, repo, { from: lead, to: builder, retryOf: third.id, minutes: 60, difficulty: "hard" }),
    /attempt 3 of 3 failing/,
  );
});

// ---------------------------------------------------------- the report back

test("a settled task goes back to whoever sent it, as itself, and rings them", async () => {
  // The lead splits a task into pieces and hands them out. It used to learn
  // a piece was done by overhearing the follower's closing line in the room
  // - and every progress line and every summary too, one model episode
  // each. Now the room does not wake it for those (agent-chat.js) and the
  // settled task comes back on its own poll instead, with what the lead
  // needs to decide what happens next.
  const lead = who("l", "Lead");
  const builder = who("b", "Builder");
  const dbot = who("c", "Dbot");
  const repo = aLedRepo("l", lead, builder, dbot);
  const registry = fakeRegistry(repo);

  const rang = [];
  const stop = onRing((key, payload) => rang.push({ key, task: payload?.task?.id ?? null }));
  try {
    const parent = await createTask(registry, repo, { from: who("p", "ada"), to: lead, title: "ship the shop" });
    await updateTask(registry, parent.id, "l", { state: "accepted" });
    const route = await createTask(registry, repo, { from: lead, to: builder, title: "add the route", because: parent.id, minutes: 15, difficulty: "easy" });
    const index = await createTask(registry, repo, { from: lead, to: dbot, title: "index it", because: parent.id, minutes: 15, difficulty: "easy" });
    assert.deepEqual(piecesOf(registry, parent).map((task) => task.id), [route.id, index.id], "the pieces of a task, oldest first");
    rang.length = 0;

    // Nothing has come back yet, and progress is not a report.
    await updateTask(registry, route.id, "b", { state: "accepted", note: "reading the router" });
    assert.deepEqual(reportsFor(registry, "l"), []);
    assert.deepEqual(rang, [], "progress does not ring the sender");

    const before = Date.now() - 1;
    const done = await updateTask(registry, route.id, "b", { state: "done", note: "GET /health answers 200" });
    assert.equal(done.settledBy, "b", "who closed it is on the record");
    assert.deepEqual(rang, [{ key: "agent:l", task: route.id }], "the close rings the sender's own key, the one its poll waits on");

    const reports = reportsFor(registry, "l", { since: before });
    assert.equal(reports.length, 1);
    const [report] = reports;
    assert.equal(report.id, route.id);
    assert.equal(report.state, "done");
    assert.equal(report.to, "Builder");
    assert.equal(report.note, "GET /health answers 200");
    assert.equal(report.parent.id, parent.id, "and what it was a piece of");
    assert.equal(report.parent.mine, true, "which is the lead's own task");
    assert.deepEqual(report.parent.stillOut.map((piece) => [piece.title, piece.to]), [["index it", "Dbot"]], "and which other pieces are still out");
    assert.equal(report.parent.settled, 0);
    assert.ok(newestReport(registry, "l") >= before, "the watermark is the newest settle");
    assert.deepEqual(reportsFor(registry, "l", { since: newestReport(registry, "l") }), [], "and past it there is nothing");

    // The other piece fails: reported the same way, with the failure on it.
    await updateTask(registry, index.id, "c", { state: "accepted" });
    await updateTask(registry, index.id, "c", { state: "failed", note: "no index permission" });
    const [, failed] = reportsFor(registry, "l", { since: before });
    assert.equal(failed.id, index.id);
    assert.equal(failed.state, "failed");
    assert.equal(failed.failure, "reported");
    assert.deepEqual(failed.parent.stillOut, [], "now every other piece of the parent has settled");
    assert.equal(failed.parent.settled, 1);

    // A task the sender withdrew itself is not a report to it.
    const spare = await createTask(registry, repo, { from: lead, to: builder, title: "never mind", minutes: 5, difficulty: "easy" });
    rang.length = 0;
    await updateTask(registry, spare.id, "l", { state: "declined", note: "not needed" });
    assert.deepEqual(rang, [], "and withdrawing does not ring yourself");
    assert.ok(!reportsFor(registry, "l", { since: before }).some((entry) => entry.id === spare.id));
    // But it is one to the agent it was taken back from? No - reports are
    // for the sender; the receiver reads its own board.
    assert.deepEqual(reportsFor(registry, "b", { since: before }), []);
  } finally {
    stop();
  }
});

test("two pieces closed in the same millisecond still come back oldest first", async () => {
  // `settledAt` is a millisecond, and two pieces of one parent closing inside
  // one is the ordinary case, not a corner: the test above closes them a few
  // microseconds apart and only the machine's clock decides whether that
  // reads as a tie. When it did, the pair came back newest-created first -
  // whatever order `tasksFor` had left - and the sender read its own pieces
  // backwards. That flake is what this pins down without a clock: the same
  // instant on both, so there is only the tie-break to test.
  const lead = who("l", "Lead");
  const builder = who("b", "Builder");
  const repo = aLedRepo("l", lead, builder);
  const registry = fakeRegistry(repo);

  const first = await createTask(registry, repo, { from: lead, to: builder, title: "add the route", minutes: 5, difficulty: "easy" });
  const second = await createTask(registry, repo, { from: lead, to: builder, title: "index it", minutes: 5, difficulty: "easy" });
  await updateTask(registry, first.id, "b", { state: "done", note: "route is in" });
  await updateTask(registry, second.id, "b", { state: "done", note: "index is in" });
  const together = new Date().toISOString();
  for (const task of repo.tasks) task.settledAt = together;

  assert.deepEqual(
    reportsFor(registry, "l", { since: 0 }).map((report) => report.title),
    ["add the route", "index it"],
  );
});

// ---------------------------------------------------------------- outcomes

test("a task closes with a report, or does not close", async () => {
  const repo = aRepo();
  const registry = fakeRegistry(repo);
  const task = await createTask(registry, repo, { from: who("a", "Scout"), to: who("b", "Builder"), title: "add the route" });

  for (const state of ["done", "failed", "declined"]) {
    await assert.rejects(() => updateTask(registry, task.id, "b", { state }), /Say w/, `${state} with nothing said`);
    await assert.rejects(() => updateTask(registry, task.id, "b", { state, note: "   " }), /Say w/, `${state} with whitespace`);
  }
  // Whose it is comes first: a stranger is told it is not theirs, not to write more.
  await assert.rejects(() => updateTask(registry, task.id, "z", { state: "done" }), /not yours/);
  // Progress needs no note; the close needs one.
  await updateTask(registry, task.id, "b", { state: "accepted" });
  const done = await updateTask(registry, task.id, "b", { state: "done", note: "Route is in on cv/shop/1a2b, PR #12, tests green." });
  assert.equal(done.state, "done");
  assert.match(done.note, /PR #12/);
});

test("a task says what it is for: a kind, and the ticket it does", async () => {
  const repo = aRepo();
  const registry = fakeRegistry(repo);
  const scout = who("a", "Scout");
  const builder = who("b", "Builder");

  // Said when sent - as an identifier, or as the URL somebody pasted.
  const rotate = await createTask(registry, repo, { from: scout, to: builder, title: "rotate the key", kind: "ops", ticket: "eng-214" });
  assert.deepEqual(rotate.outcome, {
    kind: "ops",
    ticket: { kind: "linear", id: "ENG-214", url: null, title: null, state: null, closed: null, checkedAt: null },
  });
  const pasted = await createTask(registry, repo, {
    from: scout, to: builder, title: "the thing", ticket: "https://linear.app/acme/issue/ENG-9/the-thing",
  });
  assert.equal(pasted.outcome.ticket.id, "ENG-9");
  assert.equal(pasted.outcome.ticket.url, "https://linear.app/acme/issue/ENG-9/the-thing");
  assert.equal(pasted.outcome.kind, null, "a ticket without a kind is fine");

  // Or not said at all: no outcome on the record, nothing to migrate.
  const plain = await createTask(registry, repo, { from: scout, to: builder, title: "plain" });
  assert.equal("outcome" in plain, false);

  // Nonsense is refused, not stored.
  await assert.rejects(() => createTask(registry, repo, { from: scout, to: builder, title: "x", kind: "deploy" }), /'kind' is one of/);
  await assert.rejects(() => createTask(registry, repo, { from: scout, to: builder, title: "x", ticket: "the linear one" }), /neither/);

  // Said on the close instead, with what Linear said of the ticket kept
  // beside it - the caller looked, the record remembers.
  await updateTask(registry, plain.id, "b", { state: "accepted" });
  const closed = await updateTask(registry, plain.id, "b", {
    state: "done",
    note: "ENG-300 is done: the migration ran.",
    kind: "ops",
    ticket: "ENG-300",
    ticketState: { url: "https://linear.app/acme/issue/ENG-300", title: "Run the migration", state: "Done", closed: true },
  });
  assert.equal(closed.outcome.kind, "ops");
  assert.equal(closed.outcome.ticket.id, "ENG-300");
  assert.equal(closed.outcome.ticket.closed, true);
  assert.equal(closed.outcome.ticket.state, "Done");
  assert.ok(closed.outcome.ticket.checkedAt, "stamped when it was looked at");
  // A look with no new ticket refreshes the one already there.
  const again = await updateTask(registry, closed.id, "b", { state: "failed", note: "it was reopened", ticketState: { state: "In Progress", closed: false } });
  assert.equal(again.outcome.ticket.id, "ENG-300");
  assert.equal(again.outcome.ticket.closed, false);
});

test("what a task was done with is kept at the close, once, and a late report may fill it in", async () => {
  const repo = aRepo();
  const registry = fakeRegistry(repo);
  const task = await createTask(registry, repo, { from: who("a", "Scout"), to: who("b", "Builder"), title: "x" });
  const used = { tools: [{ name: "read_file", kind: "builtin", calls: 3, failed: 0 }], connectors: [], skills: [], models: [] };

  await updateTask(registry, task.id, "b", { state: "accepted", used, note: "reading" });
  assert.equal(task.used, undefined, "not while live: the spans are still coming");

  await updateTask(registry, task.id, "b", { state: "failed", note: "no permission" });
  assert.equal(task.used, undefined, "a close with no tables in hand keeps none");
  await updateTask(registry, task.id, "b", { state: "failed", note: "no permission, still", used });
  assert.deepEqual(task.used, used, "the late report brings them");
  await updateTask(registry, task.id, "b", { state: "failed", note: "again", used: { ...used, tools: [] } });
  assert.deepEqual(task.used, used, "and they are not overwritten");
});

test("a task can be put under a parent after the fact, but not under itself or its own pieces", async () => {
  const repo = aRepo();
  const registry = fakeRegistry(repo);
  const scout = who("a", "Scout");
  const builder = who("b", "Builder");
  const dbot = who("c", "Dbot");

  const plan = await createTask(registry, repo, { from: scout, to: builder, title: "the feature" });
  const piece = await createTask(registry, repo, { from: builder, to: dbot, title: "the index" });
  assert.equal(piece.parentId, null, "sent without saying what it was for");

  await assert.rejects(() => updateTask(registry, piece.id, "b", { because: piece.id }), /piece of itself/);
  await assert.rejects(() => updateTask(registry, piece.id, "b", { because: "nope" }), /No task with id nope/);
  const linked = await updateTask(registry, piece.id, "b", { because: plan.id });
  assert.equal(linked.parentId, plan.id);
  assert.deepEqual(piecesOf(registry, plan).map((entry) => entry.id), [piece.id]);

  // The plan cannot now be put under its own piece, and the piece cannot be moved.
  await assert.rejects(() => updateTask(registry, plan.id, "b", { because: piece.id }), /round in a circle/);
  const other = await createTask(registry, repo, { from: scout, to: builder, title: "another plan" });
  await assert.rejects(() => updateTask(registry, piece.id, "b", { because: other.id }), /already a piece of/);
  // Linking to where it already is changes nothing and refuses nothing.
  assert.equal((await updateTask(registry, piece.id, "b", { because: plan.id })).parentId, plan.id);
});

test("the trail of a repo's tasks reaches into other repos, both ways, and along retries", async () => {
  const shop = aRepo();
  const docs = aRepo({ id: "docs-9f8e7d", name: "Docs" });
  const registry = fakeRegistry(shop, docs);
  const { relatedTo } = await import("../server/agent-tasks.js");
  const scout = who("a", "Scout");
  const builder = who("b", "Builder");
  const writer = who("w", "Writer");

  const plan = await createTask(registry, shop, { from: scout, to: builder, title: "the feature" });
  const page = await createTask(registry, docs, { from: builder, to: writer, title: "write it up", because: plan.id });
  await updateTask(registry, page.id, "w", { state: "failed", note: "no access" });
  const pageAgain = await createTask(registry, docs, { from: builder, to: writer, title: "", retryOf: page.id });
  const unrelated = await createTask(registry, docs, { from: scout, to: writer, title: "something else" });

  // From the shop: its piece in docs, and the retry of that piece; not the unrelated one.
  assert.deepEqual(relatedTo(registry, shop.tasks).map((task) => task.id).sort(), [page.id, pageAgain.id].sort());
  // From docs: the plan the piece descends from.
  assert.deepEqual(relatedTo(registry, docs.tasks).map((task) => task.id), [plan.id]);
  assert.ok(!relatedTo(registry, [unrelated]).length, "a task with no edges joins nothing");
});

// ------------------------------------------------------ waiting on a person

test("what a task can say it is waiting on", async () => {
  const { readWaiting, WAITING_KINDS } = await import("../server/agent-tasks.js");
  assert.deepEqual(WAITING_KINDS, ["review", "approval", "person"]);
  assert.equal(readWaiting(""), null);
  assert.deepEqual(readWaiting("review"), { kind: "review", number: null, repo: null, who: null }, "which pull request is the caller's to find");
  assert.deepEqual(readWaiting("review #12"), { kind: "review", number: 12, repo: null, who: null });
  assert.deepEqual(readWaiting("Review: ada/engine#12"), { kind: "review", number: 12, repo: "ada/engine", who: null });
  assert.deepEqual(readWaiting("review https://github.com/ada/engine/pull/7"), { kind: "review", number: 7, repo: "ada/engine", who: null });
  assert.deepEqual(readWaiting("person"), { kind: "person", number: null, repo: null, who: null });
  assert.deepEqual(readWaiting("person: ada@example.com"), { kind: "person", number: null, repo: null, who: "ada@example.com" });
  assert.throws(() => readWaiting("review twelve"), /'review #12'/);
  assert.throws(() => readWaiting("the weather"), /'review'.*'person'/);
  // An approval is not said, it is asked for - request_access sets this kind.
  assert.throws(() => readWaiting("approval"), /request_access/);
});

test("a task waiting on a review stops its clock, and the review brings it back with the time not counted", async () => {
  const { resumeTask, pullChanged, describeWait } = await import("../server/agent-tasks.js");
  const scout = who("a", "Scout");
  const builder = who("b", "Builder");
  const repo = aLedRepo(null, scout, builder);
  const registry = fakeRegistry(repo);
  const task = await createTask(registry, repo, { from: scout, to: builder, title: "add the route", minutes: 10, difficulty: "easy" });
  await updateTask(registry, task.id, "b", { state: "accepted" });
  const dueBefore = dueAt(findTask(registry, task.id).task);

  // 'waiting_on' is a way of being blocked, and a review names its pull request.
  await assert.rejects(
    () => updateTask(registry, task.id, "b", { state: "done", note: "shipped", waitingOn: { kind: "review", pull: { repo: "ada/shop", number: 12 } } }),
    /goes with state 'blocked'/,
  );
  await assert.rejects(
    () => updateTask(registry, task.id, "b", { state: "blocked", waitingOn: { kind: "review" } }),
    /Name the pull request/,
  );
  await assert.rejects(
    () => updateTask(registry, task.id, "b", { state: "blocked", waitingOn: { kind: "weather" } }),
    /one of: review, approval, person/,
  );

  const blocked = await updateTask(registry, task.id, "b", {
    state: "blocked", note: "PR is up", waitingOn: { kind: "review", pull: { repo: "ada/shop", number: 12, url: "https://github.com/ada/shop/pull/12" } },
  });
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.waitingOn.kind, "review");
  assert.deepEqual(blocked.waitingOn.pull, { repo: "ada/shop", number: 12, url: "https://github.com/ada/shop/pull/12" });
  assert.ok(blocked.waitingOn.since, "since when");
  assert.equal(describeWait(blocked.waitingOn), "a review of ada/shop#12");
  assert.equal(blocked.steps.at(-1).text, "Waiting on a review of ada/shop#12: PR is up", "the wait is a step, with what was said");
  // The clock is stopped: however long the reviewer takes, it is not overdue.
  assert.equal(overdue(blocked, dueBefore + 3_600_000), false);

  // A comment-only review does not bring it back; the room is not woken for "looks interesting".
  const pull = { repo: "ada/shop", number: 12 };
  assert.deepEqual(await pullChanged(registry, { pull, event: { kind: "review", state: "commented", by: "grace" } }), []);
  assert.equal(findTask(registry, task.id).task.state, "blocked");
  // Another pull request's review is somebody else's.
  assert.deepEqual(await pullChanged(registry, { pull: { repo: "ada/shop", number: 13 }, event: { kind: "review", state: "approved", by: "grace" } }), []);

  // Pretend the reviewer took five minutes, then a verdict comes.
  const record = registry.repos.get(repo.id);
  const stored = record.tasks.find((entry) => entry.id === task.id);
  stored.waitingOn.since = new Date(Date.now() - 5 * 60_000).toISOString();

  const rang = [];
  const stop = onRing((key, payload) => rang.push({ key, task: payload?.task?.id ?? null }));
  let resumed;
  try {
    [resumed] = await pullChanged(registry, { pull, event: { kind: "review", state: "changes_requested", by: "grace" } });
  } finally {
    stop();
  }
  assert.equal(resumed.id, task.id);
  assert.equal(resumed.state, "accepted", "back in the agent's name");
  assert.equal(resumed.waitingOn, null);
  assert.ok(resumed.pausedMs >= 5 * 60_000 - 50 && resumed.pausedMs < 5 * 60_000 + 5_000, `the wait is kept, not counted: ${resumed.pausedMs}`);
  assert.ok(Math.abs(dueAt(resumed) - (dueBefore + resumed.pausedMs)) < 5, "and the due time moved by exactly that");
  assert.equal(overdue(resumed, dueBefore + 60_000), false, "a minute past the old due time is not overdue any more");
  assert.equal(overdue(resumed, dueAt(resumed)), true);
  assert.deepEqual(resumed.steps.at(-1), { at: resumed.steps.at(-1).at, text: "Reviewed by grace: changes requested", kind: "heard" }, "what came is a step of its own kind");
  assert.deepEqual(resumed.resumed.by, { kind: "review", name: "grace" });
  assert.equal(resumed.resumed.waited.kind, "review", "the loop is told what it was waiting on");
  assert.deepEqual(rang, [{ key: "agent:b", task: task.id }], "and the agent is rung");

  // A task that is not waiting cannot be resumed - it is not stuck on anybody.
  await assert.rejects(() => resumeTask(registry, task.id, { by: { kind: "person", name: "ada" }, text: "go" }), /not waiting on anybody - it is accepted/);
  // The next report clears the framing.
  const reported = await updateTask(registry, task.id, "b", { state: "accepted", note: "fixing what grace asked for" });
  assert.equal(reported.resumed, undefined);
});

test("a task waiting on a person is brought back by that person, and a merge or close is a verdict too", async () => {
  const { resumeTask, pullChanged } = await import("../server/agent-tasks.js");
  const scout = who("a", "Scout");
  const builder = who("b", "Builder");
  const repo = aLedRepo(null, scout, builder);
  const registry = fakeRegistry(repo);

  const ask = await createTask(registry, repo, { from: scout, to: builder, title: "pick a database" });
  await updateTask(registry, ask.id, "b", { state: "accepted" });
  const waiting = await updateTask(registry, ask.id, "b", { state: "blocked", note: "Postgres or SQLite?", waitingOn: { kind: "person", who: "ada" } });
  assert.equal(waiting.waitingOn.who, "ada");
  assert.equal(waiting.steps.at(-1).text, "Waiting on ada: Postgres or SQLite?");
  // A review coming in is not what this one waits on.
  assert.deepEqual(await pullChanged(registry, { pull: { repo: "ada/shop", number: 1 }, event: { kind: "pull", state: "merged" } }), []);
  const answered = await resumeTask(registry, ask.id, { by: { kind: "person", name: "ada" }, text: "Resumed by ada: Postgres" });
  assert.equal(answered.state, "accepted");
  assert.equal(answered.note, "Resumed by ada: Postgres", "what was said is the note the board shows");
  assert.equal(answered.steps.at(-1).kind, "heard");

  const pr = await createTask(registry, repo, { from: scout, to: builder, title: "ship it" });
  await updateTask(registry, pr.id, "b", { state: "accepted" });
  await updateTask(registry, pr.id, "b", { state: "blocked", waitingOn: { kind: "review", pull: { repo: "ada/shop", number: 1 } } });
  const [merged] = await pullChanged(registry, { pull: { repo: "ada/shop", number: 1 }, event: { kind: "pull", state: "merged" } });
  assert.equal(merged.id, pr.id);
  assert.equal(merged.steps.at(-1).text, "Pull request #1 was merged");

  // Settling a waiting task ends the wait; nothing is left dangling on a done task.
  await updateTask(registry, pr.id, "b", { state: "blocked", waitingOn: { kind: "review", pull: { repo: "ada/shop", number: 1 } } });
  const done = await updateTask(registry, pr.id, "b", { state: "done", note: "merged" });
  assert.equal(done.waitingOn, null);
});
