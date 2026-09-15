// How far each person has taken this - the arithmetic behind the adoption
// figures, tested over made-up identities, sessions and pull requests, so
// the share and the ladder are known to be right before a page draws them.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cv-adoption-"));
process.env.CODERVIBES_STORE = "json";
process.env.CODERVIBES_DATA_DIR = dataDir;
process.env.CODERVIBES_TOKEN_SECRET = "adoption-tests";
test.after(() => fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

const adoption = await import("../server/adoption.js");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// A Friday, so a week's Monday is four days back and the arithmetic below is checkable by eye.
const NOW = Date.parse("2026-09-11T12:00:00Z");

let n = 0;
/** A session, with only what this module reads. */
function session({ owner = "ada@x.com", actor = "a1", kind = "harness", harness = { kind: "claude-code" }, startedAt = NOW - DAY, endedAt = null, lastSeenAt = null, state = "ended" } = {}) {
  n += 1;
  return {
    id: `ses_${n}`,
    kind,
    owner,
    actor: { kind: "agent", id: actor, name: actor },
    harness,
    startedAt,
    endedAt,
    lastSeenAt: lastSeenAt ?? endedAt ?? startedAt + 60_000,
    state,
  };
}

let p = 0;
/** A pull request, as pulls.js keeps one, with only what this module reads. */
function pull({ login = "ada", bot = false, state = "merged", mergedAt = NOW - DAY, sessionIds = [], agentId = null, externalAgentId = null } = {}) {
  p += 1;
  return {
    id: `o/r#${p}`,
    number: p,
    repo: "o/r",
    author: { login, bot },
    state,
    openedAt: mergedAt == null ? NOW - 2 * DAY : mergedAt - HOUR,
    mergedAt,
    closedAt: mergedAt,
    updatedAt: mergedAt ?? NOW,
    sessionIds,
    agentId,
    externalAgentId,
  };
}

/** An identity row, as connectors/store.js keeps one. */
const identity = (user, login, services = {}, custom = {}) => ({
  user,
  services: { ...(login ? { github: { account: login } } : {}), ...services },
  custom,
});

const IDENTITIES = [identity("ada@x.com", "ada"), identity("bob@x.com", "bobby")];

// ------------------------------------------------------------ the identity

test("a GitHub login is tied to an account by the github connector, and the first claim wins", () => {
  const logins = adoption.loginsOf([...IDENTITIES, identity("cleo@x.com", "ADA")]);
  assert.equal(logins.get("ada"), "ada@x.com", "matched case-folded");
  assert.equal(logins.get("bobby"), "bob@x.com");
  assert.equal(logins.size, 2, "the second claim on one login is not allowed to move the pull requests");
  assert.equal(adoption.loginsOf([identity("dee@x.com", null)]).size, 0, "nobody who never connected GitHub");
});

test("a person's connectors include the ones they wrote themselves, prefixed", () => {
  const rows = [identity("ada@x.com", "ada", { e2b: { account: null } }, { deploybot: {} })];
  assert.deepEqual(adoption.connectorsOf("ada@x.com", rows), ["e2b", "github", "x-deploybot"]);
  assert.deepEqual(adoption.connectorsOf("nobody@x.com", rows), []);
});

// -------------------------------------------------------- whose pull it is

test("a known human login owns the pull request, whatever session is linked to it", () => {
  const logins = adoption.loginsOf(IDENTITIES);
  const bobs = [session({ owner: "bob@x.com" })];
  const record = pull({ login: "ada", sessionIds: [bobs[0].id] });
  assert.equal(adoption.ownerOfPull(record, logins, bobs), "ada@x.com", "the author is who GitHub credits");
});

test("a bot's pull request belongs to whoever summoned it, and to nobody when no session says", () => {
  const logins = adoption.loginsOf(IDENTITIES);
  const bobs = [session({ owner: "bob@x.com" })];
  const summoned = pull({ login: "devin-ai-integration[bot]", bot: true, sessionIds: [bobs[0].id] });
  assert.equal(adoption.ownerOfPull(summoned, logins, bobs), "bob@x.com");
  const alone = pull({ login: "devin-ai-integration[bot]", bot: true });
  assert.equal(adoption.ownerOfPull(alone, logins, bobs), null, "a bot with no session behind it is nobody's");
  // A session id the caller did not hand in is not an owner either.
  assert.equal(adoption.ownerOfPull(pull({ login: "greptile[bot]", bot: true, sessionIds: ["ses_gone"] }), logins, bobs), null);
});

test("a login nobody here has claimed owns nothing", () => {
  const logins = adoption.loginsOf(IDENTITIES);
  assert.equal(adoption.ownerOfPull(pull({ login: "stranger" }), logins, []), null);
});

test("a pull request has an agent behind it when a session, an executor or a vendor's bot is on the record", () => {
  assert.equal(adoption.hasAgent(pull()), false);
  assert.equal(adoption.hasAgent(pull({ sessionIds: ["ses_1"] })), true);
  assert.equal(adoption.hasAgent(pull({ agentId: "a1" })), true);
  assert.equal(adoption.hasAgent(pull({ externalAgentId: "devin" })), true);
});

test("a merged pull request without a merge time falls back, and one still open has no time at all", () => {
  assert.equal(adoption.mergedAt(pull({ mergedAt: NOW - DAY })), NOW - DAY);
  assert.equal(adoption.mergedAt(pull({ state: "open", mergedAt: null })), null);
  assert.equal(adoption.mergedAt({ state: "merged", mergedAt: null, closedAt: NOW - DAY, updatedAt: NOW }), NOW - DAY);
  assert.equal(adoption.mergedAt({ state: "merged", mergedAt: null, closedAt: null, updatedAt: NOW }), NOW);
  // ISO strings, which is what a fold from the poll writes.
  assert.equal(adoption.mergedAt({ state: "merged", mergedAt: "2026-09-10T12:00:00Z" }), Date.parse("2026-09-10T12:00:00Z"));
});

// --------------------------------------------------------- one contributor

test("the share is agent-behind merged pull requests over all of them, and no answer when nothing merged", () => {
  const sessions = [session(), session({ actor: "a2" })];
  const pulls = [
    pull({ login: "ada", sessionIds: [sessions[0].id] }),
    pull({ login: "ada", sessionIds: [sessions[1].id] }),
    pull({ login: "ada" }), // hand-written
    pull({ login: "bobby", sessionIds: [sessions[0].id] }), // somebody else's
    pull({ login: "ada", state: "closed", mergedAt: null }), // never merged
    pull({ login: "ada", mergedAt: NOW - 40 * DAY }), // outside the range
  ];
  const row = adoption.contributor("ada@x.com", { sessions, pulls, identities: IDENTITIES, range: "7d", now: NOW });
  assert.deepEqual(row.pulls, { merged: 3, withAgent: 2, share: 2 / 3 });

  const quiet = adoption.contributor("bob@x.com", { sessions: [], pulls: [], identities: IDENTITIES, range: "7d", now: NOW });
  assert.equal(quiet.pulls.share, null, "nothing merged is no answer, not 0%");
  assert.equal(quiet.pulls.merged, 0);
});

test("sessions, harnesses and executors are counted over the range the way the ranking counts them", () => {
  const sessions = [
    session({ startedAt: NOW - 2 * DAY, actor: "a1", harness: { kind: "claude-code" } }),
    session({ startedAt: NOW - 3 * DAY, actor: "a2", harness: { kind: "codex" } }),
    session({ startedAt: NOW - 3 * DAY + HOUR, actor: "a1", harness: { kind: "claude-code" } }),
    session({ startedAt: NOW - 20 * DAY, actor: "a9", harness: { kind: "opencode" } }), // before the range
    session({ owner: "bob@x.com", startedAt: NOW - DAY, actor: "a5" }), // somebody else's
  ];
  const row = adoption.contributor("ada@x.com", { sessions, identities: IDENTITIES, range: "7d", now: NOW });
  assert.equal(row.sessions, 3);
  assert.deepEqual(row.harnesses, ["claude-code", "codex"]);
  assert.equal(row.executors, 2);
  assert.equal(row.activeDays, 2, "two of them started on the same UTC day");
  assert.deepEqual(row.logins, ["ada"]);
  assert.equal(row.lastAt, sessions[0].lastSeenAt);
});

test("a resident session with no harness record is counted by its own kind", () => {
  const row = adoption.contributor("ada@x.com", {
    sessions: [session({ kind: "resident", harness: null })],
    identities: IDENTITIES,
    range: "7d",
    now: NOW,
  });
  assert.deepEqual(row.harnesses, ["agentd"]);
});

test("parallel is the most sessions live in any one hour, and counts one begun before the range", () => {
  const at = NOW - 2 * DAY;
  const sessions = [
    session({ startedAt: at, endedAt: at + 3 * HOUR }),
    session({ startedAt: at + HOUR, endedAt: at + 2 * HOUR, actor: "a2" }),
    session({ startedAt: at + 90 * 60 * 1000, endedAt: at + 100 * 60 * 1000, actor: "a3" }),
    // Nowhere near the others: on its own, so it never raises the maximum.
    session({ startedAt: NOW - 5 * DAY, endedAt: NOW - 5 * DAY + HOUR, actor: "a4" }),
  ];
  const row = adoption.contributor("ada@x.com", { sessions, identities: IDENTITIES, range: "7d", now: NOW });
  assert.equal(row.parallel, 3, "three overlapped in the hour after the second started");

  // A session that began before the range and is still running is live in it.
  const spanning = adoption.contributor("ada@x.com", {
    sessions: [
      session({ startedAt: NOW - 30 * DAY, endedAt: null, lastSeenAt: NOW, state: "live" }),
      session({ startedAt: NOW - HOUR, actor: "a2" }),
    ],
    identities: IDENTITIES,
    range: "7d",
    now: NOW,
  });
  assert.equal(spanning.parallel, 2);
  assert.equal(spanning.sessions, 1, "but only the one that started in the range is counted as a session of it");
});

test("a session still going is live up to when it was last seen, not for ever", () => {
  const row = adoption.contributor("ada@x.com", {
    sessions: [
      session({ startedAt: NOW - 6 * DAY, endedAt: null, lastSeenAt: NOW - 6 * DAY + HOUR, state: "live" }),
      session({ startedAt: NOW - HOUR, actor: "a2" }),
    ],
    identities: IDENTITIES,
    range: "7d",
    now: NOW,
  });
  assert.equal(row.parallel, 1, "the stale one had gone quiet days before the other started");
});

test("parallelDays counts the days two were live at once, not the times it happened", () => {
  const sessions = [];
  for (const back of [1, 2, 3]) {
    const at = NOW - back * DAY;
    sessions.push(session({ startedAt: at, endedAt: at + HOUR }));
    sessions.push(session({ startedAt: at + 10 * 60 * 1000, endedAt: at + 40 * 60 * 1000, actor: "a2" }));
  }
  // A fourth day with one session only.
  sessions.push(session({ startedAt: NOW - 4 * DAY, endedAt: NOW - 4 * DAY + HOUR }));
  const row = adoption.contributor("ada@x.com", { sessions, identities: IDENTITIES, range: "7d", now: NOW });
  assert.equal(row.parallelDays, 3);
  assert.equal(row.activeDays, 4);
});

// --------------------------------------------------------------- the level

const rowFor = (over) => ({ owner: "ada@x.com", logins: ["ada"], since: NOW - 7 * DAY, until: NOW, connectors: ["github"], sessions: 0, parallel: 0, parallelDays: 0, pulls: { merged: 0, withAgent: 0, share: null }, ...over });

test("nobody with nothing in the range is a one, and says so rather than pretending", () => {
  const said = adoption.levelOf(rowFor({}));
  assert.equal(said.level, 1);
  assert.match(said.reason, /No sessions and no merged pull requests/);
});

test("asking is a one: sessions, and no merged pull request with an agent behind it", () => {
  const said = adoption.levelOf(rowFor({ sessions: 6, pulls: { merged: 2, withAgent: 0, share: 0 } }));
  assert.equal(said.level, 1);
  assert.equal(said.name, "Asking");
  assert.match(said.reason, /6 sessions/);
  assert.match(said.reason, /none of 2 merged pull requests/);
});

test("one agent is a two, and the reason carries the person's own numbers", () => {
  const said = adoption.levelOf(rowFor({ sessions: 6, parallel: 1, pulls: { merged: 5, withAgent: 3, share: 0.6 } }));
  assert.equal(said.level, 2);
  assert.equal(said.name, "One agent");
  assert.match(said.reason, /3 merged pull requests of 5 merged pull requests had an agent behind it/);
});

test("several at once is a three only when it happened on three days, not once", () => {
  const twice = adoption.levelOf(rowFor({ sessions: 9, parallel: 3, parallelDays: 2, pulls: { merged: 4, withAgent: 4, share: 1 } }));
  assert.equal(twice.level, 2, "two days is a good week with one agent, not a way of working");
  assert.match(twice.reason, /3 would be the next rung/);

  const thrice = adoption.levelOf(rowFor({ sessions: 9, parallel: 3, parallelDays: 3, pulls: { merged: 4, withAgent: 4, share: 1 } }));
  assert.equal(thrice.level, 3);
  assert.match(thrice.reason, /on 3 days of this range, 3 at the most/);
});

test("running several at once and landing nothing is not a three: the rungs are cumulative", () => {
  const busy = adoption.levelOf(rowFor({ sessions: 12, parallel: 4, parallelDays: 5, pulls: { merged: 2, withAgent: 0, share: 0 } }));
  assert.equal(busy.level, 1, "three agents grinding on work that never lands is a hard week, not a practice");
  assert.match(busy.reason, /12 sessions/);
  assert.match(busy.reason, /none of 2 merged pull requests/);
  assert.match(busy.reason, /rung 3 is one merged pull request away/, "and the reason says what is missing rather than only what failed");

  // One merged pull request with an agent behind it is the whole difference.
  const landed = adoption.levelOf(rowFor({ sessions: 12, parallel: 4, parallelDays: 5, pulls: { merged: 2, withAgent: 1, share: 0.5 } }));
  assert.equal(landed.level, 3);
});

const LANDED = { merged: 4, withAgent: 3, share: 0.75 };

test("changing a harness file in the range is a four, on top of rung two", () => {
  const changes = [
    { sha: "abc", at: NOW - 2 * DAY, by: "ada", files: ["CLAUDE.md", ".claude/skills/deploy/SKILL.md"] },
    { sha: "def", at: NOW - 3 * DAY, by: "bobby", files: ["AGENTS.md"] },
  ];
  const said = adoption.levelOf(rowFor({ sessions: 1, pulls: LANDED }), { harnessChanges: changes });
  assert.equal(said.level, 4);
  assert.equal(said.name, "Tunes the harness");
  assert.match(said.reason, /CLAUDE\.md and \.claude\/skills\/deploy\/SKILL\.md/);
  assert.match(said.reason, /1 commit/);
  assert.match(said.reason, /3 merged pull requests had an agent behind it/, "and the rung it stands on");

  // Somebody else's change, and one of theirs from before the range, are not theirs to claim.
  const old = [{ sha: "abc", at: NOW - 30 * DAY, by: "ada", files: ["CLAUDE.md"] }];
  assert.equal(adoption.levelOf(rowFor({ sessions: 1, pulls: LANDED }), { harnessChanges: old }).level, 2);
  assert.equal(adoption.levelOf(rowFor({ sessions: 1, pulls: LANDED }), { harnessChanges: [changes[1]] }).level, 2);
});

test("a harness change is matched by the account as well as by the login", () => {
  const changes = [{ sha: "abc", at: NOW - DAY, by: "Ada@X.com", files: ["CLAUDE.md"] }];
  assert.equal(adoption.levelOf(rowFor({ sessions: 2, pulls: LANDED }), { harnessChanges: changes }).level, 4);
});

test("writing a connector is a four; connecting somebody else's is not", () => {
  assert.equal(adoption.levelOf(rowFor({ sessions: 3, pulls: LANDED, connectors: ["github", "linear", "slack"] })).level, 2, "signing in is not tuning");
  assert.equal(
    adoption.levelOf(rowFor({ sessions: 3, pulls: LANDED, connectors: ["e2b", "fly", "kubernetes", "github"] })).level,
    2,
    "nor is clicking the platform the team's repository already ships on - most of a team has one, and a rung most people are on says nothing",
  );
  const own = adoption.levelOf(rowFor({ sessions: 3, pulls: LANDED, connectors: ["github", "x-deploybot"] }));
  assert.equal(own.level, 4, "a connector somebody wrote themselves is a spec they authored, on their row and nobody else's");
  assert.match(own.reason, /wrote 1 connector of their own/i);
});

test("a harness nobody has landed anything with is a one, and the reason says rung 4 is one pull request away", () => {
  const changes = [{ sha: "abc", at: NOW - DAY, by: "ada", files: [".claude/skills/deploy/SKILL.md"] }];

  // Wrote the team's skill, ran sessions, landed nothing with an agent. A
  // skill nobody has shown works does not make its author the most
  // advanced person here - but the sentence must not read as an accusation.
  const untested = adoption.levelOf(rowFor({ sessions: 8, pulls: { merged: 2, withAgent: 0, share: 0 } }), { harnessChanges: changes });
  assert.equal(untested.level, 1);
  assert.match(untested.reason, /8 sessions/);
  assert.match(untested.reason, /none of 2 merged pull requests/);
  assert.match(untested.reason, /skills\/deploy\/SKILL\.md/, "the reason names what they built");
  assert.match(untested.reason, /one merged pull request with an agent behind it is rung 4/);

  // And one merged pull request with an agent behind it takes them straight
  // to four - not to two on the way.
  assert.equal(adoption.levelOf(rowFor({ sessions: 8, pulls: { merged: 2, withAgent: 1, share: 0.5 } }), { harnessChanges: changes }).level, 4);
});

test("machinery with nobody driving it is a one, and the reason says what was set up", () => {
  const idle = adoption.levelOf(rowFor({ sessions: 0, connectors: ["x-deploybot", "github"] }));
  assert.equal(idle.level, 1, "a connector written in March and never run against is not a way of working");
  assert.match(idle.reason, /wrote 1 connector of their own/i);
  assert.match(idle.reason, /ran no session in this range/);

  const wrote = adoption.levelOf(rowFor({ sessions: 0 }), { harnessChanges: [{ sha: "abc", at: NOW - DAY, by: "ada", files: ["CLAUDE.md"] }] });
  assert.equal(wrote.level, 1, "and neither is a CLAUDE.md commit with nothing running on it");
  assert.match(wrote.reason, /CLAUDE\.md/);
  assert.match(wrote.reason, /nobody is driving it/);

  // Sessions alone are not enough any more: rung 2 is the floor.
  assert.equal(adoption.levelOf(rowFor({ sessions: 1, connectors: ["x-deploybot", "github"] })).level, 1);
  assert.equal(adoption.levelOf(rowFor({ sessions: 1, pulls: LANDED, connectors: ["x-deploybot", "github"] })).level, 4);
});

test("nothing above rung two is reachable without rung two, over every shape of row", () => {
  // The property, asserted over the cross product rather than over four
  // hand-picked rows: whatever else is true of somebody, a rung above the
  // second requires the second's merged pull request with an agent behind
  // it. Rungs 3 and 4 are two things done on top of it, so 4 does not
  // require 3 - that is the one containment this does not claim.
  const changes = [{ sha: "abc", at: NOW - DAY, by: "ada", files: ["CLAUDE.md"] }];
  let sawEachRung = new Set();
  for (const withAgent of [0, 2]) {
    for (const merged of [0, 3]) {
      for (const sessions of [0, 5]) {
        for (const parallelDays of [0, 5]) {
          for (const connectors of [["github"], ["github", "x-own"]]) {
            for (const harnessChanges of [[], changes]) {
              if (withAgent > merged) continue;
              const row = rowFor({ sessions, parallel: parallelDays ? 3 : 1, parallelDays, connectors, pulls: { merged, withAgent, share: merged ? withAgent / merged : null } });
              const { level, reason } = adoption.levelOf(row, { harnessChanges });
              sawEachRung.add(level);
              assert.ok(reason, "every rung says why");
              if (level >= 2) {
                assert.ok(withAgent > 0, `rung ${level} with no merged pull request an agent was behind`);
              }
              if (level === 3) {
                assert.ok(parallelDays >= adoption.PARALLEL_DAYS, "a three that never ran two at once");
              }
              if (level === 4) {
                assert.ok(sessions > 0, "a four with no session in the range");
                assert.ok(harnessChanges.length || connectors.some((id) => id.startsWith("x-")), "a four that tuned nothing");
              }
            }
          }
        }
      }
    }
  }
  assert.deepEqual([...sawEachRung].sort(), [1, 2, 3, 4], "and the sweep actually reached every rung");
});

test("every level has a name and a rule, and the reason is never the rule restated", () => {
  assert.deepEqual(adoption.LEVELS.map((entry) => entry.level), [1, 2, 3, 4]);
  for (const entry of adoption.LEVELS) {
    assert.ok(entry.name && entry.means, `level ${entry.level} says what it is`);
  }
  const said = adoption.levelOf(rowFor({ sessions: 2 }));
  assert.notEqual(said.reason, said.means);
});

test("the next rung says what to do, and there is none above the fourth", () => {
  const asking = adoption.nextOf(rowFor({ sessions: 5, pulls: { merged: 3, withAgent: 0, share: 0 } }));
  assert.equal(asking.level, 2);
  assert.match(asking.needs, /3 merged pull requests in this range had none behind it/);

  const one = adoption.nextOf(rowFor({ sessions: 5, parallelDays: 1, pulls: { merged: 3, withAgent: 2, share: 2 / 3 } }));
  assert.equal(one.level, 3);
  assert.match(one.needs, /2 more days/, "how far off they are, not just the rule");

  const several = adoption.nextOf(rowFor({ sessions: 9, parallel: 3, parallelDays: 4, pulls: { merged: 4, withAgent: 4, share: 1 } }));
  assert.equal(several.level, 4);
  assert.match(several.needs, /CLAUDE\.md/);

  const top = adoption.nextOf(rowFor({ sessions: 9, connectors: ["x-own"], pulls: { merged: 4, withAgent: 3, share: 0.75 } }));
  assert.equal(top, null, "nothing to reach for from the top rung");

  // Somebody who has tuned the harness and landed nothing is reaching for
  // four, not two - or the ladder would contradict the reason it just gave.
  const tuned = adoption.nextOf(rowFor({ sessions: 9, connectors: ["x-own"], pulls: { merged: 2, withAgent: 0, share: 0 } }));
  assert.equal(tuned.level, 4);
  assert.match(tuned.needs, /The harness half of rung 4 is already done\./);
  assert.doesNotMatch(tuned.needs, /their own/, "written to the reader, not about them");
});

// ---------------------------------------------------------------- the team

test("the team is the distribution, the middle person's share, and how many have adopted at all", () => {
  const rows = [
    { owner: "a", parallel: 1, pulls: { merged: 4, withAgent: 1, share: 0.25 }, level: 2 },
    { owner: "b", parallel: 4, pulls: { merged: 4, withAgent: 3, share: 0.75 }, level: 3 },
    { owner: "c", parallel: 1, pulls: { merged: 2, withAgent: 0, share: 0 }, level: 1 },
    { owner: "d", parallel: 2, pulls: { merged: 0, withAgent: 0, share: null }, level: 4 },
  ];
  const said = adoption.team(rows);
  assert.equal(said.people, 4);
  assert.deepEqual(said.byLevel, { 1: 1, 2: 1, 3: 1, 4: 1 });
  assert.equal(said.medianShare, 0.25, "the middle of the three who merged something; the fourth has no share");
  assert.equal(said.parallelMax, 4);
  assert.equal(said.adoptersShare, 0.75);
});

test("the team works the level out itself when a row has not had one attached", () => {
  const rows = [
    adoption.contributor("ada@x.com", { sessions: [session()], pulls: [pull({ login: "ada", sessionIds: ["ses_x"] })], identities: IDENTITIES, range: "7d", now: NOW }),
    adoption.contributor("bob@x.com", { sessions: [], pulls: [], identities: IDENTITIES, range: "7d", now: NOW }),
  ];
  const said = adoption.team(rows);
  assert.equal(said.people, 2);
  assert.equal(said.byLevel[1], 1, "bob has done nothing");
  assert.equal(said.byLevel[2], 1, "ada merged one with an agent behind it");
  assert.equal(said.adoptersShare, 0.5);
});

test("an empty team is people: 0 and no answers, not zeroes pretending to be answers", () => {
  const said = adoption.team([]);
  assert.equal(said.people, 0);
  assert.equal(said.medianShare, null);
  assert.equal(said.adoptersShare, null);
  assert.equal(said.parallelMax, 0);
});

// -------------------------------------------------------------- over time

test("an ISO week is keyed by the year of its Thursday and starts on a Monday", () => {
  const friday = adoption.isoWeek(Date.parse("2026-09-11T12:00:00Z"));
  assert.equal(friday.key, "2026-W37");
  assert.equal(new Date(friday.start).toISOString(), "2026-09-07T00:00:00.000Z");
  // Sunday belongs to the week that began the Monday before it, not the next one.
  assert.equal(adoption.isoWeek(Date.parse("2026-09-13T23:00:00Z")).key, "2026-W37");
  assert.equal(adoption.isoWeek(Date.parse("2026-09-14T00:00:00Z")).key, "2026-W38");
  // The turn of the year: 3 January 2027 is a Sunday, and still 2026's week 53.
  assert.equal(adoption.isoWeek(Date.parse("2027-01-03T12:00:00Z")).key, "2026-W53");
  assert.equal(adoption.isoWeek(Date.parse("2027-01-04T12:00:00Z")).key, "2027-W01");
});

test("the trend is one point per ISO week, quiet weeks included, newest last", () => {
  const sessions = [
    session({ owner: "ada@x.com", startedAt: NOW - HOUR }),
    session({ owner: "ada@x.com", startedAt: NOW - 2 * HOUR }),
    session({ owner: "bob@x.com", startedAt: NOW - 3 * HOUR }),
    session({ owner: "ada@x.com", startedAt: NOW - 14 * DAY }),
  ];
  const pulls = [
    pull({ sessionIds: ["ses_1"], mergedAt: NOW - HOUR }),
    pull({ mergedAt: NOW - 2 * HOUR }),
    pull({ agentId: "a1", mergedAt: NOW - 14 * DAY }),
    pull({ mergedAt: NOW - 60 * DAY }), // before the window
  ];
  const points = adoption.trendOf(sessions, pulls, { weeks: 4, now: NOW });
  assert.equal(points.length, 4);
  assert.deepEqual(points.map((point) => point.week), ["2026-W34", "2026-W35", "2026-W36", "2026-W37"]);

  const last = points[3];
  assert.equal(last.people, 2);
  assert.deepEqual(last.pulls, { merged: 2, withAgent: 1, share: 0.5 });

  const fortnight = points[1];
  assert.equal(fortnight.people, 1);
  assert.deepEqual(fortnight.pulls, { merged: 1, withAgent: 1, share: 1 });

  const quiet = points[0];
  assert.equal(quiet.people, 0);
  assert.deepEqual(quiet.pulls, { merged: 0, withAgent: 0, share: null }, "a quiet week has no share, and is still drawn");
});

test("the trend defaults to eight weeks and each point says the week it covers", () => {
  const points = adoption.trendOf([], [], { now: NOW });
  assert.equal(points.length, 8);
  for (const point of points) {
    assert.equal(point.end - point.start, 7 * DAY);
    assert.equal(new Date(point.start).getUTCDay(), 1, "every point begins on a Monday");
  }
  assert.equal(points[7].week, "2026-W37");
});
