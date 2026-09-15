// A pull request opened from somebody's own machine, noticed rather than declared.
//
// An agent that opens a pull request with its own `gh` is supposed to say so
// (`note_pull_request`, collab-tools.js). It mostly does not: the tool is
// one line in a long list, the agent is busy being finished, and a person
// running Claude Code on their own setup token never reads the guide at
// all. Three pull requests were opened and merged from one laptop in an
// afternoon and the Home page counted none of them - and a pull request
// nobody noted is one the poll (pull-poll.js) never asks after, so it stays
// unknown for good.
//
// But the same laptop's hooks post every tool call as it finishes
// (telemetry-ingest.js `done`), with the command and what it printed. `gh
// pr create` prints the pull request's URL and nothing else. So the server
// reads it off the hook: a command that opens a pull request, whose output
// names one, is that pull request opened by that session, and it is noted
// exactly as if the agent had said so - filed under the session, the task
// the session holds and the repo whose repository it is on, and asked about
// on GitHub straight away. The agent's own call is still
// welcome (it is how a pull request opened some other way gets in) and
// saying it twice is one record, not two.
//
// Both ears are best effort and never fail the thing that rang them: a
// hook that cannot note a pull request still logs the tool call, and a
// tool call that cannot reach GitHub is still noted.
//
// The same reading, run over the stored session logs, is the backfill: the
// pull requests opened before this existed, or while the process was
// restarting, found in the transcripts the hooks already wrote. Once at
// boot, sequentially, for the harness sessions of the last month.
import * as pulls from "./pulls.js";
import { repos } from "./repos.js";
import * as sessionLog from "./sessions.js";
import * as sessionEvents from "./session-events.js";
import { pullUrlOf } from "./git-hosts/index.js";
import * as gitHostCredentials from "./git-hosts/credentials.js";
import { refreshPull } from "./git-hosts/sync.js";

// -------------------------------------------------------- the three hosts
//
// One entry per git host, and the same reading for each: a command that
// *opens* one of that host's pull requests, and the URL its output prints.
//
// `opens` is the narrow half and it is deliberate. `gh pr view` and `gh pr
// list` print URLs too, and those are other people's pull requests as often
// as not - linking a session to one it merely looked at would make the
// Performance page count somebody else's merge as its work. Bitbucket has
// no first-party CLI that opens one, so it has no command to recognise: its
// entry matches on the URL alone, which is what `git push` prints when the
// server offers a pull request, and what a person pastes back into the
// terminal. That is looser, and it is the only reading there is; the URL
// shape (`/pull-requests/<n>`) is specific enough that nothing else on a
// line is one.

/** A pull request's URL on GitHub, wherever it is in a line. */
export const PULL_URL = /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)\b/;

/** The command that opens one there. */
export const OPENS_PULL = /(?:^|[\s;&|(])gh\s+pr\s+create\b/;

/**
 * The hosts, in the order a line is read for them. GitHub first because it
 * is what nearly every line is.
 */
export const SNIFFS = [
  { host: "github", opens: OPENS_PULL, url: PULL_URL },
  {
    host: "gitlab",
    opens: /(?:^|[\s;&|(])glab\s+mr\s+create\b/,
    // A project's path can be several groups deep, and GitLab's `-` is what
    // separates it from the thing being asked for.
    url: /https:\/\/gitlab\.com\/([A-Za-z0-9_.\-/]+?)\/-\/merge_requests\/(\d+)\b/,
  },
  {
    host: "bitbucket",
    opens: null,
    url: /https:\/\/bitbucket\.org\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull-requests\/(\d+)\b/,
  },
];

/** The text of a tool's result, whichever shape the harness gave it. */
function textOf(response) {
  if (response == null) return "";
  if (typeof response === "string") return response;
  if (Array.isArray(response)) return response.map((entry) => (typeof entry === "string" ? entry : entry?.text ?? "")).join("\n");
  if (typeof response !== "object") return "";
  if (response.stdout != null || response.stderr != null) return `${response.stdout ?? ""}\n${response.stderr ?? ""}`;
  if (typeof response.content === "string") return response.content;
  return "";
}

/**
 * The pull request a tool call opened, if it did: `{repo, number, url}`
 * from a command that opens one and an output that names one. Null for
 * every other call, including a `gh pr create` that failed and printed no
 * URL.
 */
export function pullOpenedBy(command, response) {
  const line = String(command ?? "");
  const said = textOf(response);
  for (const sniff of SNIFFS) {
    if (sniff.opens && !sniff.opens.test(line)) continue;
    const found = sniff.url.exec(said);
    if (!found) continue;
    const number = Number(found[2]);
    return { host: sniff.host, repo: found[1], number, url: pullUrlOf(sniff.host, found[1], number) };
  }
  return null;
}

/**
 * The repo record a pull request on a repository is filed under, among the
 * owner's: the one whose repository it is. Two of the same repository tie,
 * and the first by name wins, the way a setup token's start does.
 */
export function filedFor(fullName, owner, host = "github") {
  const wanted = String(fullName ?? "").toLowerCase();
  // A repo record here is a repository on GitHub; nothing on another host
  // is filed under one, and the record stands on its own.
  if (!wanted || (host ?? "github") !== "github") return null;
  return (
    [...repos.repos.values()]
      .filter((repo) => repo.source?.kind === "github" && String(repo.source.repo ?? "").toLowerCase() === wanted)
      .filter((repo) => !owner || repo.owner === owner || repos.canAccess(repo, owner))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))[0] ?? null
  );
}

/**
 * What the host says about a record now - best effort, and by whichever of
 * the two ways this installation has.
 *
 * The owner's own token first: a person who connected the host on the
 * Connectors page has one, it reads every repository they can see, and it
 * is the only way at all on an installation with no App. Otherwise the
 * installation's own way (pull-poll.js), which reads a repository that a
 * repo here is connected to. Either may answer nothing - a repository
 * nobody here can read leaves the record exactly as it was described, and
 * the sweep tries again.
 *
 * Asked for dynamically, for its own reason: pull-poll.js
 * needs a GitHub App and the local edition has none. Noting a pull request
 * is the hook's business and needs neither.
 */
async function askTheHost(record, { session = null, credentials = gitHostCredentials } = {}) {
  const user = session?.owner ?? null;
  if (user) {
    const mine = await refreshPull(record, { user, credentials }).catch(() => null);
    if (mine) return mine;
  }
  // Only GitHub has the other way, and only when something here is
  // connected to the repository.
  if ((record.host ?? "github") !== "github" || !record.repoId) return null;
  return import("./pull-poll.js")
    .then((poll) => poll.refresh(record))
    .catch(() => null);
}

/**
 * Note a pull request as opened by a session and ask the host about it.
 * What both ears do once they know which pull request.
 *
 * @param {object} args
 * @param {string} args.repo the repository, owner/name
 * @param {number} args.number
 * @param {string} [args.host] which git host it is on - "github" by default,
 *   which is what every record written before there were three is
 * @param {string} [args.url]
 * @param {string|null} [args.title]
 * @param {string|null} [args.branch]
 * @param {object|null} [args.filedUnder] the repo record, when the caller knows it
 * @param {object|null} [args.session] the session record that opened it
 * @param {{id: string, name: string}|null} [args.agent] who opened it
 * @param {string|null} [args.taskId] the task the session holds
 * @returns {Promise<{record: object, current: object, asked: boolean}>} the record as noted, and as GitHub says it stands
 */
export async function opened({ repo, number, host = "github", url = null, title = null, branch = null, filedUnder = null, session = null, agent = null, taskId = null, credentials = gitHostCredentials }) {
  const under = filedUnder ?? filedFor(repo, session?.owner ?? null, host);
  const record = await pulls.noteOpened({
    repoId: under?.id ?? null,
    sessionId: session?.id ?? null,
    agentId: agent?.id ?? session?.actor?.id ?? null,
    taskId: taskId ?? null,
    host,
    repo,
    number,
    url: url ?? pullUrlOf(host, repo, number),
    branch: branch ?? session?.branch ?? null,
    title,
  });
  const asked = await askTheHost(record, { session, credentials });
  const current = asked ?? record;

  return { record, current, asked: Boolean(asked) };
}

/**
 * A hook said a tool call finished: if it opened a pull request, note it
 * under the session. Never throws - the hook's job is the log.
 *
 * @returns {Promise<object|null>} the record noted, or null when the call opened nothing
 */
export async function heardToolResult(session, { command, response, taskId = null } = {}) {
  const seen = pullOpenedBy(command, response);
  if (!seen || !session) return null;
  const already = await pulls.get(seen.repo, seen.number, seen.host).catch(() => null);
  if (already?.sessionIds?.includes(session.id)) return already;
  try {
    const { record } = await opened({ ...seen, session, taskId });
    return record;
  } catch (err) {
    console.warn(`pull-opened: could not note ${seen.repo}#${seen.number} on ${seen.host} from a hook: ${err.message}`);
    return null;
  }
}

// --------------------------------------------------------------- backfill

/** How far back the stored transcripts are read - the month they are kept. */
const BACKFILL_MS = 30 * 24 * 60 * 60_000;
/** How many sessions one backfill reads. A month of one installation, with room. */
const BACKFILL_SESSIONS = 1000;
/** One session's log is read in pages of this many. */
const PAGE = 500;

/**
 * The pull requests one session's transcript says it opened: each
 * `tool_call` that ran a command opening one (its title is the command),
 * paired with the `tool_call_update` that closed it (its detail is the
 * first line the command printed - the URL).
 */
export async function pullsOpenedIn(sessionId) {
  const found = new Map();
  const open = new Map(); // toolCallId -> command
  let since = 0;
  for (;;) {
    const page = await sessionEvents.since(sessionId, since, { limit: PAGE });
    for (const entry of page) {
      if (entry.kind === "tool_call" && OPENS_PULL.test(String(entry.title ?? ""))) open.set(entry.toolCallId, entry.title);
      if (entry.kind === "tool_call_update" && open.has(entry.toolCallId)) {
        const seen = pullOpenedBy(open.get(entry.toolCallId), entry.detail ?? "");
        if (seen) found.set(`${seen.host}:${seen.repo}#${seen.number}`, seen);
        open.delete(entry.toolCallId);
      }
    }
    if (page.length < PAGE) break;
    since = page[page.length - 1].seq;
  }
  return [...found.values()];
}

/**
 * Read the last month's harness sessions for pull requests they opened
 * and nobody noted. Sequential, one session at a time, and quiet: the
 * room is not told about a pull request opened last week.
 *
 * @returns {Promise<{sessions: number, found: number, noted: number}>}
 */
export async function backfill({ now = Date.now(), limit = BACKFILL_SESSIONS } = {}) {
  const out = { sessions: 0, found: 0, noted: 0 };
  const sessions = (await sessionLog.list({ since: now - BACKFILL_MS, limit })).filter(
    (session) => session.kind === "harness" && session.repo?.fullName,
  );
  for (const session of sessions) {
    out.sessions += 1;
    let seen;
    try {
      seen = await pullsOpenedIn(session.id);
    } catch (err) {
      console.warn(`pull-opened: could not read session ${session.id}: ${err.message}`);
      continue;
    }
    for (const pull of seen) {
      out.found += 1;
      const known = await pulls.get(pull.repo, pull.number, pull.host).catch(() => null);
      if (known?.sessionIds?.includes(session.id)) continue;
      try {
        await opened({ ...pull, session });
        out.noted += 1;
      } catch (err) {
        console.warn(`pull-opened: could not note ${pull.repo}#${pull.number} on ${pull.host} from session ${session.id}: ${err.message}`);
      }
    }
  }
  return out;
}

/** Run the backfill once, after boot has settled. Returns the cancel, for tests. */
export function startBackfill({ afterMs = 15_000 } = {}) {
  const timer = setTimeout(() => {
    backfill()
      .then((done) => {
        if (done.found) console.log(`pull-opened  ${done.noted} pull request(s) noted from ${done.sessions} session log(s), ${done.found} seen`);
      })
      .catch((err) => console.warn(`pull-opened: backfill failed: ${err.message}`));
  }, afterMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}
