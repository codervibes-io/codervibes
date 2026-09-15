// Adoption: how far each person has actually taken this, and where the team is.
//
// The Performance page answers "which of these agents is worth the money".
// This answers the other question a team lead asks, which is about the
// people rather than the tools: who here works with an agent, who works
// with several, who has started shaping the harness the rest of us use -
// and how that has moved over the last two months.
//
// ## Adoption is a merged pull request with a session behind it
//
// The tempting measure is sessions opened. It is the one we have most of,
// it needs no GitHub, and it is wrong. A session is somebody *asking* -
// "what does this module do", "write me a regex" - and a person who asks
// forty questions a week and hand-writes every line has not adopted
// anything; they have a very good search engine. Counting that as adoption
// makes the number go up when nothing changed, which is the failure mode of
// every adoption dashboard anybody has ever ignored.
//
// So the numerator is a *merged pull request with a session of ours behind
// it*: work that an agent did, that a person put up, and that the repository
// accepted. The denominator is every merged pull request that person had in
// the range, agent or not - which is why PR A ingests every pull request of
// a connected repository and not only the ones we opened. The ratio is then
// a real share: "seven of Ada's eleven merged pull requests last week had an
// agent behind them". A person who merged nothing has no share at all
// (`null`, not zero) - dividing by nought is not 0%, it is "no answer yet",
// and a page that shows 0% for somebody on holiday will be argued with
// before it is believed.
//
// Sessions still appear on the row, because they are how the level below
// tells "asking" from "not here yet". They are just not the measure.
//
// ## The level is a heuristic, and it is shown with its reason
//
// `LEVELS` is a four-rung ladder - asking, one agent, several at once, tunes
// the harness - and it is a judgement, not a measurement. Somebody could
// reasonably say that running four agents badly is worse than running one
// well, or that a person who never touched CLAUDE.md but reviews every diff
// carefully is the most advanced user here. They would have a point.
//
// The defence is not that the ladder is right; it is that `levelOf` hands
// back the sentence that put a person on their rung - "two or more agents at
// once on 4 of the last 7 days" - so the argument is about a fact rather
// than about a badge. A level with no reason attached is a horoscope. Every
// page that shows the number must show the sentence with it.
//
// **The rungs are cumulative, and that is the whole shape of the thing.**
// A ladder where the rules are independent tests reports nonsense with a
// straight face: somebody who connected a sandbox platform in March and
// has not opened a session since would be a four, and somebody running
// three agents at once on work that never lands would be a three. Both
// read as "this person is further along than the one who quietly merges an
// agent's pull request every day", and both are wrong, because what the
// ladder claims to measure is *what this person does with agents* - not
// what they own and not how busy they look.
//
// So **rung 2 is the floor for everything above it**: one merged pull
// request with an agent behind it. Three is that done in parallel; four is
// that plus having tuned the harness the team runs on. Rungs 3 and 4 are
// two things done on top of 2 rather than a chain - four does not require
// three - so the numbers are a reading order and the only containment the
// ladder claims is the one that matters.
//
// A skill somebody wrote that has never been behind a merged pull request
// is a skill nobody has shown works, and machinery with nobody driving it
// is not a way of working. Both are rung-one people with a good setup, and
// the reason sentence says exactly that - and names the rung one merged
// pull request away - so nobody reads the one as an accusation.
//
// ## What this cannot see
//
//   - **An agent that runs without our hooks.** No session, so its pull
//     request is indistinguishable from one somebody typed. That undercounts
//     adoption, always in the same direction, and a person whose whole team
//     works that way will look like a team of hand-writers. There is no fix
//     from here; the honest thing is to say it on the page.
//   - **A bot's pull request belongs to nobody** unless a session claims it.
//     A vendor's agent (Greptile, Devin, Codex cloud) opens under its own
//     login, which is not a person's login, so `ownerOfPull` returns null
//     and the pull request lands in no contributor's numerator *or*
//     denominator. It counts for the repository (that is PR A's figure) and
//     for nobody's personal share, unless one of our sessions was linked to
//     it, in which case it belongs to whoever summoned it.
//   - **A login nobody has claimed.** The tie between a GitHub login and an
//     account here is the `github` connector on the identity row, which only
//     exists once that person has signed in or connected. Until then their
//     merged pull requests are attributed to no one. Undercounts, again in
//     the one direction.
//   - **Work outside a connected repository.** Not ingested, so not here.
//   - **Whose gateway it is.** Rung four wanted "connected a gateway" in it
//     and cannot have it: a LiteLLM proxy is the installation's
//     (`server/litellm.js`), and the model keys live on one shared row
//     (`server/secrets.js`), so there is no per-person fact to read. The
//     rung stands on harness commits and connectors somebody wrote.
//
// Everything in this module is pure - records in, rows out - so a test can
// hand it a fortnight of history in a line and the routes stay thin.
import { RANGES, DEFAULT_RANGE, harnessKindOf } from "./performance.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** A time that may be a number or an ISO string, as a number. Null when neither. */
const timeOf = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const ratio = (a, b) => (b > 0 ? a / b : null);

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ------------------------------------------------------- logins and owners

/**
 * Every GitHub login this installation can tie to an account, as
 * `login (lowercased) -> owner`.
 *
 * The tie is the `github` connector on the identity row
 * (connectors/store.js): `services.github.account` is what GitHub called
 * the person when they signed in or connected a token. There is no other
 * record of it - we do not ask people to type their login - so somebody who
 * has never connected GitHub is not in this map and their pull requests are
 * attributed to nobody.
 *
 * A login claimed by two accounts keeps the first, deterministically. That
 * should be impossible (one GitHub account, one row) and it is not this
 * module's business to arbitrate; silently letting the later row win would
 * move a person's pull requests to somebody else's name without a word.
 */
export function loginsOf(identities = []) {
  const map = new Map();
  for (const record of identities) {
    const owner = record?.user;
    const login = record?.services?.github?.account;
    if (!owner || !login) continue;
    const key = String(login).toLowerCase();
    if (!map.has(key)) map.set(key, owner);
  }
  return map;
}

/** The connectors one account has on, and any it wrote itself. */
export function connectorsOf(owner, identities = []) {
  const record = identities.find((entry) => entry?.user === owner);
  if (!record) return [];
  return [...Object.keys(record.services ?? {}), ...Object.keys(record.custom ?? {}).map((id) => (id.startsWith("x-") ? id : `x-${id}`))].sort();
}

/** Session id -> the account it belonged to, for `ownerOfPull`. */
export function sessionOwners(sessions = []) {
  const map = new Map();
  for (const session of sessions) if (session?.id && session.owner) map.set(session.id, session.owner);
  return map;
}

/**
 * Whose merged pull request this is, or null.
 *
 * The precedence, in order, and the reason for it:
 *
 *   1. **The author's login**, when it is a person's and we know whose. The
 *      pull request is on their GitHub account and their name is on it; that
 *      is the contributor whatever ran behind it. An agent working on Ada's
 *      laptop pushes as Ada, and this is exactly right for that case.
 *   2. **A linked session's owner**, when the author is a bot or a login
 *      nobody here has claimed. This is the external-agent case: Devin opens
 *      under `devin-ai-integration[bot]`, and the pull request is adoption
 *      by whoever summoned it - but only when a session of ours says who
 *      that was. Guessing from the repository's owner would credit work to
 *      people who never asked for it.
 *   3. **Nobody.** A bot with no session behind it, or an unrecognised
 *      login, belongs to no contributor. It still counts for the repository.
 *
 * A known human login wins over a session link on purpose: two people can
 * be linked to one pull request (a session opened it, somebody else pushed
 * to the branch and became the author), and the author is the one GitHub
 * credits and the one a person reading the page expects to see.
 *
 * @param {object} pull one of pulls.js's records
 * @param {Map<string,string>} logins from `loginsOf`
 * @param {Map<string,string>|Array} owners from `sessionOwners`, or the sessions themselves
 */
export function ownerOfPull(pull, logins = new Map(), owners = new Map()) {
  if (!pull) return null;
  const byId = owners instanceof Map ? owners : sessionOwners(owners);
  const login = pull.author?.login ? String(pull.author.login).toLowerCase() : null;
  if (login && !pull.author?.bot) {
    const owner = logins.get(login);
    if (owner) return owner;
  }
  for (const id of pull.sessionIds ?? []) {
    const owner = byId.get(id);
    if (owner) return owner;
  }
  return null;
}

/**
 * Whether an agent was behind this pull request.
 *
 * A linked session is the strong signal and the one that means what we
 * want it to mean. `agentId` and `externalAgentId` are kept beside it
 * because pulls.js sets them for work that had no session of ours at all -
 * a vendor's bot recognised by its login - and that is still an agent
 * having written the code, which is the question.
 */
export const hasAgent = (pull) =>
  Boolean((pull?.sessionIds ?? []).length || pull?.agentId || pull?.externalAgentId);

/**
 * When a pull request merged, as a number, or null if it did not.
 *
 * `mergedAt` is what a fold from a webhook or the poll sets; the fallbacks
 * are for a record whose merge we learnt about second-hand and which has a
 * state but no time. A merged pull request with no time at all cannot be
 * placed in a range and is left out of every one of them.
 */
export function mergedAt(pull) {
  if (!pull) return null;
  const merged = pull.state === "merged" || pull.mergedAt != null;
  if (!merged) return null;
  return timeOf(pull.mergedAt) ?? timeOf(pull.closedAt) ?? timeOf(pull.updatedAt);
}

// -------------------------------------------------------------- one person

/**
 * When each hour of the range had how many of these sessions live in it.
 *
 * A session is live in an hour when `[startedAt, endedAt ?? lastSeenAt]`
 * touches it - `endedAt` for one that finished, `lastSeenAt` for one still
 * going or one whose harness went quiet without saying goodbye. Both ends
 * are clamped to the range, so a session that began last month contributes
 * only the hours of it that are inside.
 */
function liveHours(sessions, since, until) {
  const counts = new Map(); // hour start -> how many were live
  for (const session of sessions) {
    const from = timeOf(session?.startedAt);
    if (from == null) continue;
    const to = timeOf(session.endedAt) ?? timeOf(session.lastSeenAt) ?? from;
    const start = Math.max(since, from);
    const end = Math.min(until, Math.max(to, from));
    if (end < start) continue;
    for (let hour = Math.floor(start / HOUR) * HOUR; hour <= end; hour += HOUR) {
      counts.set(hour, (counts.get(hour) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * One person's adoption over a range.
 *
 * Two different rules about what "in the range" means, and the difference
 * is deliberate:
 *
 *   - **Counts** - sessions, harnesses, executors, active days - read the
 *     sessions that *started* in the range. That is the rule
 *     `performance.js rank` uses, so the same person's row says the same
 *     number of sessions on both pages.
 *   - **`parallel`** reads every session that was *live* in the range, even
 *     one begun before it. Concurrency is a fact about a moment in time; a
 *     session that has been running since Tuesday is running now, and
 *     pretending otherwise would say a person ran one agent on the day they
 *     ran three.
 *
 * `parallelDays` is on the row because `levelOf` needs it - how many days of
 * the range had two or more sessions live in one hour - and because "three
 * at once, once, by accident" and "two at once most days" are different
 * people and the page should be able to say which.
 */
export function contributor(owner, { sessions = [], pulls = [], identities = [], range = DEFAULT_RANGE, now = Date.now() } = {}) {
  const span = RANGES[range] ?? RANGES[DEFAULT_RANGE];
  const since = now - span;

  const own = sessions.filter((session) => session?.owner === owner);
  const started = own.filter((session) => {
    const at = timeOf(session.startedAt);
    return at != null && at >= since && at <= now;
  });

  const hours = liveHours(own, since, now);
  const byDay = new Map(); // day -> the most that were live at once in it
  for (const [hour, count] of hours) {
    const day = dayOf(hour);
    byDay.set(day, Math.max(byDay.get(day) ?? 0, count));
  }

  const logins = loginsOf(identities);
  const mineLogins = [...logins.entries()].filter(([, user]) => user === owner).map(([login]) => login);
  const owners = sessionOwners(sessions);

  let merged = 0;
  let withAgent = 0;
  let lastPullAt = 0;
  for (const pull of pulls) {
    const at = mergedAt(pull);
    if (at == null || at < since || at > now) continue;
    if (ownerOfPull(pull, logins, owners) !== owner) continue;
    merged += 1;
    if (hasAgent(pull)) withAgent += 1;
    if (at > lastPullAt) lastPullAt = at;
  }

  const lastSession = started.reduce(
    (latest, session) => Math.max(latest, timeOf(session.lastSeenAt) ?? timeOf(session.startedAt) ?? 0),
    0,
  );
  const lastAt = Math.max(lastSession, lastPullAt) || null;

  return {
    owner,
    range,
    since,
    until: now,
    logins: mineLogins,
    connectors: connectorsOf(owner, identities),
    pulls: { merged, withAgent, share: ratio(withAgent, merged) },
    sessions: started.length,
    harnesses: [...new Set(started.map((session) => harnessKindOf(session)).filter(Boolean))].sort(),
    executors: new Set(started.map((session) => session.actor?.id).filter(Boolean)).size,
    parallel: hours.size ? Math.max(...hours.values()) : 0,
    parallelDays: [...byDay.values()].filter((count) => count >= 2).length,
    activeDays: new Set(started.map((session) => dayOf(timeOf(session.startedAt)))).size,
    lastAt,
  };
}

// ------------------------------------------------------------- the ladder

/**
 * The four rungs, lowest first. Nothing above rung 2 is reachable without
 * rung 2 - see the essay at the top for why an independent test on each
 * rung reports nonsense. Rungs 3 and 4 are two things done on top of rung
 * 2 rather than a chain, so 4 does not require 3.
 *
 * `means` is the rule, in a sentence, for a page that wants to explain the
 * ladder itself. What a *person* is shown is the reason `levelOf` gives,
 * which names their own numbers.
 */
export const LEVELS = [
  { level: 1, name: "Asking", means: "sessions but no PR with an agent behind it" },
  { level: 2, name: "One agent", means: "PRs with an agent behind them, one session at a time" },
  { level: 3, name: "Several at once", means: "rung 2, and parallel ≥ 2 on at least 3 days of the range" },
  {
    level: 4,
    name: "Tunes the harness",
    means: "rung 2, sessions in the range, and changed CLAUDE.md/AGENTS.md/a skill in it or wrote a connector of their own",
  },
];

/** How many days of two-or-more it takes to be running several at once, rather than having done it once. */
export const PARALLEL_DAYS = 3;

/**
 * Which connectors count as tuning: only the ones a person wrote
 * themselves (`x-…`, connectors/custom.js).
 *
 * The first draft of this counted the platform connectors too - choosing
 * where agents run (e2b, Fly, Kubernetes) or wiring a pipeline to them
 * (Dagster, Argo, Buildkite) reads like somebody building the machinery.
 * Running it against the demo settled the argument: six of eight people had
 * one, so six of eight were on rung four, and a rung nearly everybody is on
 * says nothing. Connecting Fly is how a team's repository ships. It is a
 * fact about the team, not about how that person works with agents, and one
 * person on the team clicks it.
 *
 * Writing a connector is different in kind - it is a spec that person
 * authored, on their row and nobody else's - so it stays.
 *
 * There is deliberately no gateway here. A LiteLLM proxy is the
 * installation's (`server/litellm.js`) and so are the model keys
 * (`server/secrets.js` holds them on one shared row), so "connected a
 * gateway" is not a fact about a person that this can read. Said in
 * docs/measures.md rather than guessed at.
 */
const isTuning = (id) => String(id).startsWith("x-");

/**
 * The harness changes in this range that were this person's.
 *
 * PR E's `changesIn` gives `{sha, at, by, files}` and `by` is whatever git
 * put in the commit - a GitHub login usually, an address sometimes - so it
 * is matched against both the account and every login tied to it, case
 * folded. A change with no time is taken as inside the range: it is
 * evidence we have, and dropping it would silently demote somebody.
 */
function harnessChangesBy(row, harnessChanges) {
  const names = new Set([String(row.owner ?? "").toLowerCase(), ...(row.logins ?? []).map((login) => String(login).toLowerCase())]);
  names.delete("");
  return (harnessChanges ?? []).filter((change) => {
    if (!names.has(String(change?.by ?? "").toLowerCase())) return false;
    const at = timeOf(change?.at);
    if (at == null) return true;
    return (row.since == null || at >= row.since) && (row.until == null || at <= row.until);
  });
}

/**
 * What somebody tuned, as a sentence fragment, or null for nobody.
 *
 * `dated` says whether the fragment already places itself in the range. A
 * harness change has a time on it and only counts when it falls inside; a
 * connector is a standing fact with no date we can read, which is exactly
 * why it cannot on its own put anybody on rung four.
 */
function tunedWhat(row, harnessChanges) {
  const changes = harnessChangesBy(row, harnessChanges);
  if (changes.length) {
    const files = [...new Set(changes.flatMap((change) => change.files ?? []))];
    const what = files.length ? files.slice(0, 2).join(" and ") + (files.length > 2 ? ` and ${files.length - 2} more` : "") : "the harness files";
    return { phrase: `changed ${what} in ${plural(changes.length, "commit")} in this range`, dated: true };
  }
  const tuning = (row.connectors ?? []).filter(isTuning);
  return tuning.length ? { phrase: `wrote ${plural(tuning.length, "connector")} of their own`, dated: false } : null;
}

/**
 * What the next rung would take, or null for somebody already on the top.
 *
 * The Account page shows this under a person's own row, and it is the half
 * of a ladder that makes it worth having: "you are a two" is a label, "one
 * more day of running two at once and you are a three" is something to do.
 * Phrased as the rule, with their own distance from it where there is one.
 */
export function nextOf(contributor = {}, { harnessChanges = [] } = {}) {
  const row = contributor ?? {};
  const { level } = levelOf(row, { harnessChanges });
  const at = (want) => LEVELS.find((entry) => entry.level === want);
  if (level >= 4) return null;
  if (level === 3) {
    return { ...at(4), needs: "Change a CLAUDE.md, an AGENTS.md or a skill in this range - the harness the rest of the team runs on." };
  }
  if (level === 2) {
    const days = Math.max(0, PARALLEL_DAYS - (row.parallelDays ?? 0));
    return { ...at(3), needs: `Run two or more agents at once on ${plural(days, "more day")} of this range.` };
  }
  // Rung 2 is the floor, so it is what a one is reaching for - except for
  // somebody who has already tuned the harness, for whom the same merged
  // pull request is rung 4. Saying "next: one agent" to the person who
  // wrote the team's skill this week would be the ladder contradicting the
  // reason it just gave them.
  const merged = row.pulls?.merged ?? 0;
  const missing = merged
    ? `Get one of your merged pull requests opened from a session here - ${plural(merged, "merged pull request")} in this range had none behind it.`
    : "Merge a pull request with a session behind it.";
  const tuned = tunedWhat(row, harnessChanges);
  // Not the reason's own phrase: it is written about somebody ("wrote a
  // connector of their own") and this is written to them.
  if (tuned && (row.sessions ?? 0) > 0) return { ...at(4), needs: `${missing} The harness half of rung 4 is already done.` };
  return { ...at(2), needs: missing };
}

/**
 * Which rung a contributor is on, and the sentence that put them there.
 *
 * Read from the top down. **Rung 2 is the floor for everything above it**
 * (the essay at the top says why):
 *
 *   4  rung 2, **and** tuned the harness in this range, **and** sessions in it
 *   3  rung 2, **and** two or more agents at once on `PARALLEL_DAYS` days
 *   2  at least one merged pull request with an agent behind it
 *   1  everything else, including a person who has set the machinery up
 *      and not landed anything with it - the reason says which they are
 *
 * Rungs 3 and 4 are two different things somebody does *on top of* rung 2,
 * not a chain: four does not require three, so one merged pull request with
 * an agent behind it takes a person who tunes the harness straight from one
 * to four. The numbers are a reading order, and the only containment claim
 * the ladder makes is the one that matters - nothing above rung 2 is
 * reachable without rung 2.
 *
 * That floor is the whole point. Rung 3 gated on it because "several at
 * once" is supposed to name a way of working that *produces* something, and
 * three agents grinding on work that never lands is a bad week. Rung 4
 * gated on it for the same reason and one more: a skill somebody wrote that
 * has never been behind a merged pull request is a skill nobody has shown
 * works, and calling its author the most advanced person here - above the
 * colleague who quietly merges an agent's work every day - is the exact
 * inversion this ladder exists to avoid.
 *
 * The reason is a fact with numbers in it, not a restatement of the rule,
 * because the whole defence of a heuristic is that the reader can check it
 * and disagree. See the essay at the top.
 *
 * @param {object} contributor a row from `contributor` above
 * @param {{harnessChanges?: Array}} options PR E's `[{sha, at, by, files}]`
 */
export function levelOf(contributor = {}, { harnessChanges = [] } = {}) {
  const row = contributor ?? {};
  const merged = row.pulls?.merged ?? 0;
  const withAgent = row.pulls?.withAgent ?? 0;
  const sessions = row.sessions ?? 0;
  const parallelDays = row.parallelDays ?? 0;
  const at = (level) => LEVELS.find((entry) => entry.level === level);
  const said = (level, reason) => ({ ...at(level), reason });
  const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);

  const tuned = tunedWhat(row, harnessChanges);
  if (tuned && sessions > 0 && withAgent > 0) {
    return said(4, `${capital(tuned.phrase)}, ran ${plural(sessions, "session")}${tuned.dated ? "" : " in this range"}, and ${plural(withAgent, "merged pull request")} had an agent behind it.`);
  }
  if (parallelDays >= PARALLEL_DAYS && withAgent > 0) {
    return said(3, `Two or more agents at once on ${plural(parallelDays, "day")} of this range, ${row.parallel ?? 2} at the most, and ${plural(withAgent, "merged pull request")} came of it.`);
  }
  if (withAgent > 0) {
    const share = merged ? ` of ${plural(merged, "merged pull request")}` : "";
    const rarely = parallelDays ? ` Ran two at once on ${plural(parallelDays, "day")} - ${PARALLEL_DAYS} would be the next rung.` : "";
    return said(2, `${plural(withAgent, "merged pull request")}${share} had an agent behind it.${rarely}`);
  }
  if (sessions > 0) {
    const had = merged ? `, and none of ${plural(merged, "merged pull request")} had an agent behind it` : ", and no merged pull request in this range";
    // Landing nothing is the shape of a hard week, not of rung three or
    // four. Say what they were doing as well as what is missing, and name
    // the rung one merged pull request away - a bare "rung 1" for somebody
    // who wrote the team's skill this week reads as an accusation.
    const away = tuned
      ? ` ${capital(tuned.phrase)}, so one merged pull request with an agent behind it is rung 4.`
      : parallelDays >= PARALLEL_DAYS
        ? ` Ran two or more at once on ${plural(parallelDays, "day")}, so rung 3 is one merged pull request away.`
        : "";
    return said(1, `${plural(sessions, "session")}${had}.${away}`);
  }
  if (tuned) {
    return said(1, `${capital(tuned.phrase)}, but ran no session in this range - the machinery is set up and nobody is driving it.`);
  }
  return said(1, "No sessions and no merged pull requests in this range.");
}

// --------------------------------------------------------------- the team

/** A row's rung, whether it was worked out already or not. */
const levelNumber = (row) => (typeof row?.level === "number" ? row.level : row?.level?.level ?? levelOf(row).level);

/**
 * Where a group of people is, from their rows.
 *
 * `medianShare` rather than the team's total merged-with-agent over total
 * merged, because the total is dominated by whoever merges the most: one
 * prolific person on rung four would report a team that has adopted this
 * when nine of ten have not. The median says what the middle person's week
 * looks like, which is the question. People with nothing merged in the
 * range have no share and are left out of it - they are still counted in
 * `people` and on the ladder.
 *
 * `adoptersShare` is the headline: the share of people who have got a pull
 * request merged with an agent behind it at all. Rung one is being here;
 * rung two is the thing having happened.
 */
export function team(contributors = []) {
  const rows = contributors.filter(Boolean);
  const byLevel = { 1: 0, 2: 0, 3: 0, 4: 0 };
  let adopters = 0;
  for (const row of rows) {
    const level = levelNumber(row);
    byLevel[level] = (byLevel[level] ?? 0) + 1;
    if (level >= 2) adopters += 1;
  }
  const shares = rows.map((row) => row.pulls?.share).filter((share) => share != null);
  return {
    people: rows.length,
    byLevel,
    medianShare: median(shares),
    parallelMax: rows.length ? Math.max(...rows.map((row) => row.parallel ?? 0)) : 0,
    adoptersShare: ratio(adopters, rows.length),
  };
}

// -------------------------------------------------------------- over time

/**
 * The ISO week a moment falls in: its key (`2026-W37`) and the Monday it
 * starts on, in UTC.
 *
 * ISO rather than "the last seven days, seven times", because a week
 * boundary that moves with the hour of the request makes two loads of the
 * same page disagree. The ISO year is the year of that week's Thursday,
 * which is why the last days of December can be week 1 of the next year.
 */
export function isoWeek(ms) {
  const date = new Date(ms);
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const weekday = (new Date(midnight).getUTCDay() + 6) % 7; // Monday is 0
  const monday = midnight - weekday * DAY;
  const thursday = monday + 3 * DAY;
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY)) + 1;
  return { key: `${year}-W${String(week).padStart(2, "0")}`, start: monday };
}

/**
 * Adoption week by week, so the page can draw the line rather than a number.
 *
 * One point per ISO week, ending with the week `now` falls in and going
 * back `weeks` of them, every week present even when nothing happened -
 * a gap in the middle of a chart has to be a quiet week and not a missing
 * one. Each point: how many distinct people had a session that started that
 * week, how many pull requests merged that week, how many of those had an
 * agent behind them, and the share.
 *
 * The share here is over the whole group, not the median of the people in
 * it (which is what `team` reports and why the two can differ): a line has
 * to be one number per week, and the group's own ratio is the one that adds
 * up to the counts drawn beside it.
 *
 * Only pull requests we hold are counted, so a week before this
 * installation started ingesting a repository reads as a quiet week. The
 * page's caveat, not something this can fix.
 */
export function trendOf(sessions = [], pulls = [], { weeks = 8, now = Date.now() } = {}) {
  const thisWeek = isoWeek(now);
  const points = [];
  const byStart = new Map();
  for (let back = weeks - 1; back >= 0; back -= 1) {
    const start = thisWeek.start - back * 7 * DAY;
    const point = {
      week: isoWeek(start).key,
      start,
      end: start + 7 * DAY,
      people: 0,
      pulls: { merged: 0, withAgent: 0, share: null },
      owners: new Set(),
    };
    points.push(point);
    byStart.set(start, point);
  }
  const first = points[0].start;
  const last = points[points.length - 1].end;
  const find = (at) => (at >= first && at < last ? byStart.get(first + Math.floor((at - first) / (7 * DAY)) * 7 * DAY) : null);

  for (const session of sessions) {
    const at = timeOf(session?.startedAt);
    if (at == null || !session.owner) continue;
    find(at)?.owners.add(session.owner);
  }
  for (const pull of pulls) {
    const at = mergedAt(pull);
    if (at == null) continue;
    const point = find(at);
    if (!point) continue;
    point.pulls.merged += 1;
    if (hasAgent(pull)) point.pulls.withAgent += 1;
  }
  return points.map(({ owners, ...point }) => ({
    ...point,
    people: owners.size,
    pulls: { ...point.pulls, share: ratio(point.pulls.withAgent, point.pulls.merged) },
  }));
}
