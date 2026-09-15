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
// the session holds and the repo whose repository it is on, asked about on
// GitHub straight away, and told to the room. The agent's own call is still
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

/** A pull request's URL on GitHub, wherever it is in a line. */
export const PULL_URL = /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)\b/;

/**
 * A command that opens a pull request. Only opening: `gh pr view` and `gh
 * pr list` print URLs too, and those are other people's pull requests as
 * often as not - linking a session to one it merely looked at would make
 * the Performance page count somebody else's merge as its work.
 */
export const OPENS_PULL = /(?:^|[\s;&|(])gh\s+pr\s+create\b/;

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
  if (!OPENS_PULL.test(String(command ?? ""))) return null;
  const found = PULL_URL.exec(textOf(response));
  if (!found) return null;
  return { repo: found[1], number: Number(found[2]), url: `https://github.com/${found[1]}/pull/${found[2]}` };
}

/**
 * The repo record a pull request on a repository is filed under, among the
 * owner's: the one whose repository it is. Two of the same repository tie,
 * and the first by name wins, the way a setup token's start does.
 */
export function filedFor(fullName, owner) {
  const wanted = String(fullName ?? "").toLowerCase();
  if (!wanted) return null;
  return (
    [...repos.repos.values()]
      .filter((repo) => repo.source?.kind === "github" && String(repo.source.repo ?? "").toLowerCase() === wanted)
      .filter((repo) => !owner || repo.owner === owner || repos.canAccess(repo, owner))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))[0] ?? null
  );
}

/**
 * Note a pull request as opened by a session, ask GitHub about it, and tell
 * the room. What both ears do once they know which pull request.
 *
 * @param {object} args
 * @param {string} args.repo the repository, owner/name
 * @param {number} args.number
 * @param {string} [args.url]
 * @param {string|null} [args.title]
 * @param {string|null} [args.branch]
 * @param {object|null} [args.filedUnder] the repo record, when the caller knows it
 * @param {object|null} [args.session] the session record that opened it
 * @param {{id: string, name: string}|null} [args.agent] who did, for the room
 * @param {string|null} [args.taskId] the task the session holds
 * @param {boolean} [args.tell] say so in the room (default true)
 * @returns {Promise<{record: object, current: object, asked: boolean}>} the record as noted, and as GitHub says it stands
 */
export async function opened({ repo, number, url = null, title = null, branch = null, filedUnder = null, session = null, agent = null, taskId = null, tell = true }) {
  const under = filedUnder ?? filedFor(repo, session?.owner ?? null);
  const record = await pulls.noteOpened({
    repoId: under?.id ?? null,
    sessionId: session?.id ?? null,
    agentId: agent?.id ?? session?.actor?.id ?? null,
    taskId: taskId ?? null,
    repo,
    number,
    url: url ?? `https://github.com/${repo}/pull/${number}`,
    branch: branch ?? session?.branch ?? null,
    title,
  });
  // What GitHub says now - best effort. A repository nobody here can read
  // leaves the record as described, and the poll tries again. Both the poll
  // and the room are asked for here rather than imported: noting a pull
  // request is the hook's business and needs neither a GitHub client nor a
  // chat, and an installation that has no way to ask still files the record.
  const asked = await import("./pull-poll.js")
    .then((poll) => poll.refresh(record))
    .catch(() => null);
  const current = asked ?? record;

  if (tell && under) {
    const roomRepo = repos.get(under.id) ?? under;
    const who = agent?.name ?? session?.actor?.name ?? "Somebody";
    const { collab } = await import("./collab.js");
    collab.postFeedback(roomRepo, {
      user: null,
      name: who,
      agent: true,
      text:
        `Opened ${repo}#${number}${current.title ? ` - ${current.title}` : ""}: ${current.url}` +
        (current.state !== "open" ? ` (already ${current.state})` : " - waiting on a review and a merge"),
      about: null,
    });
  }
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
  const already = await pulls.get(seen.repo, seen.number).catch(() => null);
  if (already?.sessionIds?.includes(session.id)) return already;
  try {
    const { record } = await opened({ ...seen, session, taskId });
    return record;
  } catch (err) {
    console.warn(`pull-opened: could not note ${seen.repo}#${seen.number} from a hook: ${err.message}`);
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
        if (seen) found.set(`${seen.repo}#${seen.number}`, seen);
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
      const known = await pulls.get(pull.repo, pull.number).catch(() => null);
      if (known?.sessionIds?.includes(session.id)) continue;
      try {
        await opened({ ...pull, session, tell: false });
        out.noted += 1;
      } catch (err) {
        console.warn(`pull-opened: could not note ${pull.repo}#${pull.number} from session ${session.id}: ${err.message}`);
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
