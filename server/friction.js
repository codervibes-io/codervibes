// Friction: what got in the agents' way this week, counted.
//
// A person with ten agents on four repositories learns nothing from ten
// transcripts. What they can act on is a short list: "no such file ×14,
// tests failed ×9, permission denied ×6 - and here are three sessions
// each". That is a week's worth of work the agents lost to the same few
// things, and each of those few things has an owner and a fix: a fixture
// nobody committed, a command the CLAUDE.md does not mention, a permission
// nobody granted. This module is the arithmetic behind that list.
//
// ## Counts, not words
//
// The session record is counts, ids and names, and never the words
// (sessions.js). So this does not keep the failing line anywhere: it reads
// a line, decides which of nine kinds it is, and keeps the kind. The kind
// is a count on the record, the way `failedTools` already is; the line
// stays on the session log, where the words rule already says who may read
// it. A report over a month of sessions is then arithmetic over counts -
// nothing to redact, nothing to leak, and cheap enough to draw on a page.
//
// ## A fixed vocabulary, not a model
//
// The nine kinds below are a closed list matched by regexes, and that is
// deliberate rather than a first draft waiting for a model:
//
//   - **Comparable.** "not-found ×14 this week, ×3 last" is only a
//     sentence if both weeks were classified by the same rule. A model
//     re-reading last week's lines would give a different answer today,
//     and the trend would be the classifier's drift as much as the team's.
//   - **Free and instant.** A month of sessions is tens of thousands of
//     lines. This runs in a loop with no key, no provider, no bill and no
//     failure mode - the report is never "unclassified because the proxy
//     was down".
//   - **Readable.** A person who disagrees with a row can read the regex
//     that produced it, in this file, and change it. "The model thought
//     so" is not something anybody can argue with.
//
// The cost is coarseness: nine kinds, and a tenth called `other` for a
// failure whose line says nothing we recognise. A big `other` is the
// signal that this list needs another kind, and is worth reading as such.
//
// ## What this cannot see
//
// - **A failure the agent recovered from is still a failure here.** It ran
//   the command, it did not work, it worked out why and moved on. Nobody
//   was interrupted, and it still cost a minute and some tokens. The
//   number is the friction, not the damage.
// - **A hand-back that was the right call still counts.** An agent that
//   stops to ask which of two APIs to break is doing its job. The count
//   says how often the work needed a person, which is worth knowing
//   whether or not each stop was justified - it is context, not blame,
//   and a page that shows it should say so.
// - **A failure nothing reported is not here at all.** A harness whose
//   hooks say nothing about how a tool call ended contributes no errors,
//   which reads as a clean week rather than an unmeasured one.
// - **The fix lines are guesses from a table**, not advice about your
//   repository. They say what this kind of friction is usually somebody
//   forgetting to write down; the person reading knows which.
//
// Everything here is pure - entries and counts in, rows out - so a test
// hands it a session in three lines and the route stays thin.

/**
 * The kinds of failure, each with what it means and what usually fixes it,
 * in the order they are matched: most specific first, so a line that could
 * be read two ways is read the more useful one. `looksLike` is the whole
 * of the rule - there is nothing else deciding a kind.
 *
 * The order matters in a few places worth naming:
 *
 *   - `tests-failed` is first, so "npm ERR! Test failed." is a test
 *     failure and not a dependency problem.
 *   - `dependency` before `not-found`, so npm's own ENOENT is a
 *     dependency problem; Node's `Cannot find package` is a dependency
 *     and its `Cannot find module` is a missing file, which is how Node
 *     itself means them.
 *   - `timeout` and `network` before `permission`, so "connection
 *     refused" is the network and not a permission - `refused` is a word
 *     both use.
 */
export const ERROR_KINDS = {
  "tests-failed": {
    means: "A test run came back red.",
    fix: "a skill or CLAUDE.md note on how tests are run here; a fixture the agents keep recreating",
    looksLike:
      /\btests? (?:failed|failing)\b|\b\d+ (?:tests? )?(?:failed|failing)\b|\bfailures?:\s*[1-9]|# fail [1-9]|^\s*FAIL\b|\bFAIL\s+\S+\.(?:test|spec)\b|\bassertionerror\b|\bassertion failed\b|\bexpected .{0,40}(?:to be|but got)\b/i,
  },
  dependency: {
    means: "A package could not be installed, resolved or built.",
    fix: "a lockfile or a devcontainer the agents start from; say in CLAUDE.md which package manager this repo uses",
    looksLike:
      /npm ERR!|\byarn error\b|\bpnpm (?:ERR|error)\b|cannot find package|\bERESOLVE\b|no matching distribution|could not find a version|could not compile|unresolved (?:import|dependency)|failed to (?:resolve|build) dependenc/i,
  },
  git: {
    means: "Git would not do it: a conflict, a stale branch, nothing to commit.",
    fix: "a note on the branching rule here - where to branch from, when to rebase, what may be pushed",
    looksLike:
      /\bCONFLICT\b|automatic merge failed|not a git repository|non-fast-forward|!\s*\[rejected\]|updates were rejected|nothing to commit|\bmerge conflict\b|please commit your changes or stash/i,
  },
  timeout: {
    means: "It ran until something stopped waiting.",
    fix: "a smaller command, or a longer timeout written into the harness settings; a watch mode nobody meant to start",
    // Not a bare "exceeded": "maximum call stack size exceeded" is a bug,
    // not a timeout, and it is `type-or-syntax` by its own words.
    looksLike: /\betimedout\b|\btimed out\b|\btimeout\b|deadline exceeded|time (?:limit )?exceeded|exceeded the (?:time|deadline)/i,
  },
  network: {
    means: "Something on the other end of a connection was not there.",
    fix: "the sandbox's egress rules, or a service the agents need that nothing starts for them",
    looksLike:
      /\beconnrefused\b|\benotfound\b|\beconnreset\b|\beai_again\b|\bgetaddrinfo\b|fetch failed|connection (?:refused|reset)|network is unreachable|\b(?:502|503|504)\b|bad gateway|service unavailable/i,
  },
  permission: {
    means: "It was allowed to try and not allowed to do it.",
    fix: "a permission on the executor, or a token with the scope this needs - check the access trail for the same name",
    looksLike: /\beacces\b|\beperm\b|\bdenied\b|\bforbidden\b|\b403\b|\brefused\b|not permitted|requires? (?:sudo|root)|read-only file system|\bunauthori[sz]ed\b/i,
  },
  "type-or-syntax": {
    means: "The code did not parse or did not type-check.",
    fix: "a lint or type-check step the agent can run before it hands work over; the project's language version written down",
    looksLike:
      /\bsyntaxerror\b|\btypeerror\b|unexpected token|unexpected identifier|unexpected end of|\bTS\d{3,5}\b|\bparse error\b|\bindentationerror\b|\bnameerror\b|cannot read propert|is not a function|maximum call stack/i,
  },
  "not-found": {
    means: "A file, a binary or a module was not where it was looked for.",
    fix: "a setup step in CLAUDE.md, or the file itself - an agent that cannot find it is a person who could not either",
    looksLike:
      /\benoent\b|no such file or directory|command not found|\b(?:file|path|directory) not found\b|cannot find module|module not found|\bMODULE_NOT_FOUND\b|\bmodulenotfounderror\b|no module named|is not recognized as an internal|\b404\b/i,
  },
  other: {
    means: "It failed, and the line does not say how.",
    fix: "read three of these sessions - a kind worth counting is probably hiding in them",
    // Nothing matches `other`: it is what is left when nothing else did.
    looksLike: null,
  },
};

/** The kinds, in matching order. */
export const KINDS = Object.keys(ERROR_KINDS);

/**
 * The table as a page may have it: the kinds with their two lines, and
 * not the regexes - a `RegExp` is `{}` once JSON has been through it, and
 * a route that hands out an empty object per kind teaches a page to
 * ignore the field.
 */
export const vocabulary = () => Object.fromEntries(Object.entries(ERROR_KINDS).map(([kind, { means, fix }]) => [kind, { means, fix }]));

/** How much of a failing line is read. A first line, not a stack trace. */
export const MAX_DETAIL = 300;

/**
 * The words a harness leaves behind when a command came back non-zero and
 * nothing else in the response says so. Narrow on purpose: this is the
 * only place a *line* is allowed to decide that a call failed, and a line
 * is the agent's own output - "no such file" in it is as likely to be a
 * successful `grep` as a failure.
 */
const SAYS_IT_FAILED = /\bcommand failed\b|exit(?:ed with)? (?:code|status) [1-9]|\bnon-?zero exit\b/i;

/**
 * Whether a tool call failed - one rule, so the hook path, the span path
 * and the report all decide it the same way.
 *
 * The order is: what the call was explicitly said to be, then the shape of
 * the response, then, only if nothing said anything at all, the line
 * itself. A call nobody said anything about did not fail. That default
 * matters more than it looks: a count that quietly files every successful
 * call as an error is worse than one that misses some, because the second
 * is obviously incomplete and the first is confidently wrong.
 *
 * @param {{status?: string|null, ok?: boolean|null, response?: any, detail?: string|null}} [call]
 *   `status` is the log's own (`failed` is ACP's word); `ok` is a span's;
 *   `response` is the harness's `tool_response`; `detail` is the line the
 *   log kept (`toolDetailOf`).
 */
export function isFailure({ status = null, ok = null, response = null, detail = null } = {}) {
  if (status === "failed") return true;
  if (ok === false) return true;
  if (ok === true) return false;
  if (response && typeof response === "object" && !Array.isArray(response)) {
    if (response.is_error === true || response.isError === true) return true;
    if (response.ok === false || response.success === false) return true;
    if (response.status === "failed" || response.status === "error") return true;
    if (typeof response.error === "string" ? response.error.trim() !== "" : response.error != null) return true;
    for (const key of ["exit_code", "exitCode", "returncode", "code"]) {
      const value = response[key];
      if (typeof value === "number" && value !== 0) return true;
      // Node and the shell both hand back `ENOENT`-shaped codes as strings.
      if (typeof value === "string" && /^E[A-Z]{2,}$/.test(value)) return true;
    }
    // Something on stderr is a warning until an exit code disagrees, which
    // the loop above has already looked for.
    return false;
  }
  const line = typeof response === "string" ? response : detail;
  return SAYS_IT_FAILED.test(String(line ?? "").slice(0, MAX_DETAIL));
}

/**
 * The kind of failure a tool call's detail line says it was, or null when
 * nothing says the call failed.
 *
 * `detail` is what the log keeps of how a call ended (telemetry-ingest.js
 * `toolDetailOf`: a command's first line of output, an error message).
 * Whether the call failed at all is `isFailure` above, over the same
 * `status` / `ok` / `response` the caller has - and a caller that hands in
 * none of them gets null, whatever the line says, because an agent
 * grepping for `ENOENT` found what it was looking for. Only once the call
 * is known to have failed is the line read; a failing line nothing matches,
 * or a failure with no line at all, is `other`.
 *
 * `tool` decides only the default: a fetch-shaped tool that failed
 * silently failed at the network far more often than at anything else.
 *
 * @param {string|null} detail the call's last line
 * @param {{tool?: string|null, ok?: boolean|null, status?: string|null, response?: any}} [call]
 * @returns {string|null} one of KINDS, or null
 */
export function errorKindOf(detail, { tool = null, ok = null, status = null, response = null } = {}) {
  if (!isFailure({ status, ok, response, detail })) return null;
  const line = String(detail ?? "").trim().slice(0, MAX_DETAIL);
  for (const [kind, { looksLike }] of Object.entries(ERROR_KINDS)) {
    if (looksLike && line && looksLike.test(line)) return kind;
  }
  return /fetch|web|http|curl|url/i.test(String(tool ?? "")) ? "network" : "other";
}

/** What a kind means, in a line - the table above, and nothing else. */
export const meaningOf = (kind) => ERROR_KINDS[kind]?.means ?? null;

/** Below this a kind is an incident, not a pattern, and gets no fix line. */
export const WORTH_FIXING = 2;

/**
 * The one-line suggestion for a kind that came up `count` times, or null
 * when it came up once. One `ENOENT` in a week is a typo; the fix line is
 * about a habit, and printing "write a skill" under a single occurrence is
 * how a report teaches people to skim past it.
 */
export function whatToFix(kind, count = WORTH_FIXING) {
  if (!(kind in ERROR_KINDS)) return null;
  return (Number(count) || 0) >= WORTH_FIXING ? ERROR_KINDS[kind].fix : null;
}

// ------------------------------------------------------------ hand-backs

/** How much of the agent's last message is read. A closing line, not an essay. */
export const MAX_SAID = 2000;

/**
 * The phrases that put the ball back in the person's court, in the last
 * two sentences of what the agent said. A closed list, on purpose: a
 * bigger one starts catching "let me know if this is wrong" tacked onto a
 * finished report, and the count stops meaning "the work stopped here".
 */
export const HAND_BACK_PHRASES = ["let me know", "should i", "do you want me to", "which one", "please confirm", "before i proceed"];

/** The last `count` sentences of a text, as one lower-cased line. */
function lastSentences(text, count = 2) {
  const parts = String(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.slice(-count).join(" ").toLowerCase();
}

/**
 * Whether the agent's last message of a turn handed the work back: it
 * ends on a question, or its last two sentences ask for a decision.
 *
 * Bounded and dumb by design - the last 2000 characters, one closed list
 * of phrases, no model. "Done. Tests pass." is not a hand-back; "Done.
 * Should I open the pull request?" is. A false positive costs one row in
 * a weekly count, which is the right price for a rule a person can read.
 */
export function isHandBack(said) {
  const text = String(said ?? "").trim();
  if (!text) return false;
  const tail = text.slice(-MAX_SAID);
  // Markdown and quoting sit after the punctuation that matters.
  if (/\?["'`)\]*_\s]*$/.test(tail)) return true;
  const closing = lastSentences(tail, 2);
  return HAND_BACK_PHRASES.some((phrase) => closing.includes(phrase));
}

// --------------------------------------------------------------- repeats

/** How many times one command has to be run before it is worth saying so. */
export const MIN_REPEATS = 3;

/**
 * How many distinct commands one session's record tallies, and how much of
 * a command line is read before it is fingerprinted. A session that runs
 * two hundred different commands has no repeats worth reporting and should
 * not grow a record to say so; past the cap the tally stops taking new
 * ones and goes on counting the ones it has.
 */
export const MAX_COMMANDS = 30;
export const MAX_REPEAT_TITLE = 120;

/**
 * A command line's fingerprint: FNV-1a, 32 bits, as eight hex characters.
 *
 * The record is everyone's to read across the installation, and it holds
 * counts, ids and names - never a tool's input (sessions.js, the essay). A
 * command line *is* a tool's input: it can carry a path somebody's home
 * directory is in, a hostname, a token in an env prefix. So what the
 * record keeps for a repeated command is this, and the words are looked up
 * from the session's own log - which is published under the words rule -
 * for a reader who may read them, and withheld from everybody else.
 *
 * FNV-1a because it is four lines, needs no dependency and is stable
 * across processes and restarts, which a JS string hash of our own
 * invention would have to be argued about. It is the same idea as - and
 * deliberately the same algorithm as - the line hashing in the code
 * acceptance work being built beside this; when that lands one of the two
 * should import the other.
 *
 * Thirty-two bits over the handful of distinct commands one session runs:
 * a collision would add two commands' runs onto one row, and the lookup
 * would name whichever of them it found first. At this scale that is not
 * worth a wider hash; it is worth saying out loud.
 */
export function fingerprint(text) {
  let hash = 0x811c9dc5;
  const value = String(text ?? "");
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    hash = Math.imul(hash ^ (code & 0xff), 0x01000193);
    if (code > 0xff) hash = Math.imul(hash ^ (code >>> 8), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * The fingerprint a command is tallied under: normalised first, so the
 * same command with different noise on the end is one command, and cut to
 * `MAX_REPEAT_TITLE` so a line of any length hashes the same way on both
 * sides of the lookup.
 */
export const commandHash = (title) => fingerprint(normaliseCommand(title).slice(0, MAX_REPEAT_TITLE));

/**
 * A command title as it is compared: whitespace collapsed and the noise a
 * harness adds to the end of a line taken off, so `npm test 2>&1 | tail
 * -20` and `npm test` are the same command run twice.
 */
export function normaliseCommand(title) {
  let text = String(title ?? "").replace(/\s+/g, " ").trim();
  let cut = true;
  while (cut) {
    const before = text;
    text = text
      .replace(/\s*\|\s*(?:head|tail|cat|less|more)(?:\s+-\w+)*(?:\s+\d+)?\s*$/i, "")
      .replace(/\s*2\s*>\s*(?:&\s*1|\/dev\/null)\s*$/i, "")
      .replace(/\s*>\s*\/dev\/null\s*$/i, "")
      .replace(/\s*[;&]+\s*$/, "")
      .trim();
    cut = text !== before;
  }
  return text;
}

/** Env assignments a command may be prefixed with: `CI=1 npm test`. */
const ENV_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;

/**
 * Whether a tool-call title is a command rather than a path, a URL or a
 * sentence. Titles come from `toolTitleOf`, which gives a command for a
 * shell tool and a path for a read - so the test is: more than one word,
 * and a first word shaped like a program name (lower case, or a `./path`).
 * A sentence starts with a capital and is left alone; a repeated search
 * reads as a repeated command, which is fair enough.
 */
export function looksLikeCommand(title) {
  const text = normaliseCommand(title).replace(ENV_PREFIX, "");
  if (!text || text.length > 300 || !/\s/.test(text)) return false;
  if (/^https?:\/\//i.test(text)) return false;
  const [first] = text.split(" ");
  return /^(?:\.{0,2}\/)?[a-z0-9_][a-z0-9_./-]*$/.test(first);
}

/**
 * The commands a session ran three times or more, most-run first.
 *
 * Running the same test five times is the signal - it is either a test
 * that will not pass or a command the agent could not get right, and
 * either way somebody's afternoon went into it. Titles that are not
 * commands are not counted (`looksLikeCommand`), and what comes back is
 * the normalised title, since that is what "the same command" means here.
 *
 * @param {string[]} titles every tool call's title, in order
 * @returns {{title: string, times: number}[]}
 */
export function repeatedCommands(titles) {
  const seen = new Map();
  for (const title of Array.isArray(titles) ? titles : []) {
    if (!looksLikeCommand(title)) continue;
    const key = normaliseCommand(title);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.entries()]
    .filter(([, times]) => times >= MIN_REPEATS)
    .map(([title, times]) => ({ title, times }))
    .sort((a, b) => b.times - a.times || a.title.localeCompare(b.title));
}

// ------------------------------------------------------- one session

/** The states of an access-trail entry that mean the agent was told no. */
export const REFUSED_STATES = new Set(["refused", "denied"]);

/**
 * What one session ran into, from its log and its access trail.
 *
 * The log (session-events.js) is read three ways: a `tool_call_update`
 * that says `failed` is an error, classified by its detail line and by
 * the tool of the `tool_call` it closes; the last thing the agent said
 * before each turn went idle is a hand-back or is not; every
 * `tool_call` title goes into the repeat count.
 *
 * Only a call something says failed counts (`isFailure`). A call that came
 * back `completed` with "no such file" in its output is not an error
 * here, because that is also what a successful `ls` of a path that does
 * not exist looks like, and counting it would fill the report with the
 * agent's own successful checks - but one whose line names a non-zero
 * exit is, since that is the harness saying so in its own words.
 *
 * The trail's part is refusals: `refused` for a permission that stopped a
 * call, `denied` for an ask a person turned down (access-trail.js). Hand
 * in this session's entries; the count is of what it was told no to.
 *
 * The shape is what a session record keeps as `counts.friction`, so the
 * report is the same arithmetic whether it is fed a live log or a month
 * of counts.
 *
 * @returns {{errors: Record<string, number>, handBacks: number, repeats: {title: string, times: number}[], refusals: number}}
 */
export function sessionFriction({ events = [], trail = [] } = {}) {
  const errors = {};
  const titles = [];
  const tools = new Map();
  let handBacks = 0;
  let said = null;
  let turnsEnded = 0;

  for (const entry of events) {
    switch (entry?.kind) {
      case "tool_call":
        if (entry.title) titles.push(entry.title);
        if (entry.toolCallId) tools.set(entry.toolCallId, entry.tool ?? null);
        // A call that arrived already failed - a harness that reports no
        // start, or a `done` with no `tool` hook behind it.
        {
          const kind = errorKindOf(entry.detail ?? null, { tool: entry.tool, status: entry.status });
          if (kind) errors[kind] = (errors[kind] ?? 0) + 1;
        }
        break;
      case "tool_call_update": {
        const kind = errorKindOf(entry.detail ?? null, { tool: tools.get(entry.toolCallId) ?? null, status: entry.status });
        if (kind) errors[kind] = (errors[kind] ?? 0) + 1;
        break;
      }
      case "agent_message_chunk":
        said = entry.text ?? said;
        break;
      case "platform.status":
        if (entry.status === "running") said = null;
        if (entry.status === "idle" || entry.status === "finished") {
          turnsEnded += 1;
          if (said && isHandBack(said)) handBacks += 1;
          said = null;
        }
        break;
      default:
        break;
    }
  }
  // A harness that never says a turn ended still said something last, and
  // that last word is the one the person came back to.
  if (!turnsEnded && said && isHandBack(said)) handBacks += 1;

  const refusals = (Array.isArray(trail) ? trail : []).filter((entry) => REFUSED_STATES.has(entry?.state)).length;
  return { errors, handBacks, repeats: repeatedCommands(titles), refusals };
}

/** An empty friction count, for a record written before this existed. */
export const emptyFriction = () => ({ errors: {}, handBacks: 0, repeats: [], refusals: 0 });

/**
 * One session's error kinds as a page reads them: most-common first, each
 * with what it means and - for a kind that came up more than once in this
 * one session - what usually fixes it. The session page draws this; the
 * report above draws the same shape over a range.
 */
export function kindsOf(session) {
  const { errors } = frictionOf(session);
  return Object.entries(errors)
    .filter(([kind, count]) => kind in ERROR_KINDS && count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, count]) => ({ kind, count, means: ERROR_KINDS[kind].means, fix: whatToFix(kind, count) }));
}

/**
 * The repeats worth showing: the ones that reached `MIN_REPEATS`, as
 * `{hash, times}`. The record tallies every command a session ran so that
 * the third run of one can be recognised at all; only the ones that got
 * there are a signal, and the rest are a session doing its job.
 *
 * A hash and not a command line - see `fingerprint`. Whoever draws these
 * looks the words up from the session's log for a reader entitled to
 * them, and says "a command" to everybody else.
 */
export const repeatsOf = (session) =>
  frictionOf(session).repeats.filter((repeat) => repeat?.hash && (repeat.times ?? 0) >= MIN_REPEATS);

/** A session's friction however it is carried: the shape above, or nothing. */
export function frictionOf(session) {
  const own = session?.counts?.friction ?? session?.friction ?? null;
  if (!own) return emptyFriction();
  return {
    errors: own.errors && typeof own.errors === "object" ? own.errors : {},
    handBacks: own.handBacks ?? 0,
    repeats: Array.isArray(own.repeats) ? own.repeats : [],
    refusals: own.refusals ?? 0,
  };
}

// ---------------------------------------------------------------- report

/** What a report can be folded by. */
export const BY = ["repo", "executor", "week"];

/** How many sessions a row names, so a reader can go and look. */
export const MAX_EXAMPLES = 3;
/** How many repeated commands a row shows. Five is a list; twenty is a log. */
export const MAX_REPEATS_SHOWN = 5;

/**
 * The ISO week a moment falls in, labelled `2026-W37`. Weeks start on
 * Monday and are counted in UTC - the same week for everybody reading the
 * report, which matters more than each reader's own midnight.
 */
export function isoWeekOf(at) {
  const day = new Date(Number(at) || 0);
  const utc = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  // ISO's rule: the week belongs to the year its Thursday is in.
  utc.setUTCDate(utc.getUTCDate() - ((utc.getUTCDay() + 6) % 7) + 3);
  const firstThursday = new Date(Date.UTC(utc.getUTCFullYear(), 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((utc.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Which row a session is on, and what to call it. */
function groupKeyOf(row, by) {
  if (by === "executor") return { key: row.actorId ?? "?", name: row.actorName ?? row.actorId ?? "Unknown executor" };
  if (by === "week") {
    const week = isoWeekOf(row.startedAt);
    return { key: week, name: week };
  }
  return { key: row.repoId ?? "?", name: row.repoName ?? row.repoId ?? "No repository" };
}

/** A group as it is being filled. */
const blankGroup = (key, name) => ({ key, name, sessions: 0, errors: new Map(), repeats: new Map(), handBacks: 0, refusals: 0 });

function fold(group, row) {
  const friction = frictionOf(row);
  group.sessions += 1;
  group.handBacks += friction.handBacks;
  group.refusals += friction.refusals;
  for (const [kind, count] of Object.entries(friction.errors ?? {})) {
    if (!(kind in ERROR_KINDS) || !(count > 0)) continue;
    const own = group.errors.get(kind) ?? { kind, count: 0, examples: [] };
    own.count += count;
    if (row.sessionId && own.examples.length < MAX_EXAMPLES && !own.examples.includes(row.sessionId)) own.examples.push(row.sessionId);
    group.errors.set(kind, own);
  }
  for (const repeat of friction.repeats ?? []) {
    // The record tallies every command, since the third run of one cannot
    // be recognised without having counted the first two; only the ones
    // that got to three are the signal (`repeatsOf`). By fingerprint, not
    // by words: the words are not on the record (`fingerprint`), and the
    // caller looks them up for a reader entitled to them - which is why
    // each row keeps a session or two to look them up in.
    if (!repeat?.hash || (repeat.times ?? 0) < MIN_REPEATS) continue;
    const own = group.repeats.get(repeat.hash) ?? { hash: repeat.hash, times: 0, sessions: 0, examples: [] };
    own.times += repeat.times ?? 0;
    own.sessions += 1;
    if (row.sessionId && own.examples.length < MAX_EXAMPLES && !own.examples.includes(row.sessionId)) own.examples.push(row.sessionId);
    group.repeats.set(repeat.hash, own);
  }
}

/** A filled group, as the page reads it. */
function finish(group) {
  const errors = [...group.errors.values()]
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind))
    .map((error) => ({ ...error, means: ERROR_KINDS[error.kind].means, fix: whatToFix(error.kind, error.count) }));
  return {
    key: group.key,
    name: group.name,
    sessions: group.sessions,
    errors,
    total: errors.reduce((sum, error) => sum + error.count, 0),
    handBacks: group.handBacks,
    refusals: group.refusals,
    repeats: [...group.repeats.values()].sort((a, b) => b.times - a.times || a.hash.localeCompare(b.hash)).slice(0, MAX_REPEATS_SHOWN),
  };
}

/**
 * The friction report: what the agents ran into over a range, folded per
 * repository, per executor or per week.
 *
 * `rows` are `{sessionId, repoId, repoName, actorId, actorName, startedAt,
 * friction}` - the counts a session already carries, not its log, so the
 * report over a month is arithmetic and nothing else. Each group lists
 * its error kinds most-common first, with what each usually means, what
 * usually fixes it and up to three sessions to go and read; then how
 * often the work was handed back to a person, how often a permission said
 * no, and the commands that were run over and over.
 *
 * Weeks come back oldest first, because that is a trend; everything else
 * comes back worst first, because that is a to-do list.
 *
 * @param {object[]} rows
 * @param {{since?: number, until?: number, by?: "repo"|"executor"|"week"}} [options]
 */
export function report(rows, { since = 0, until = Number.POSITIVE_INFINITY, by = "repo" } = {}) {
  const how = BY.includes(by) ? by : "repo";
  const groups = new Map();
  const all = blankGroup("all", "All");
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const at = Number(row.startedAt) || 0;
    if (at < since || at >= until) continue;
    const { key, name } = groupKeyOf(row, how);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = blankGroup(key, name)));
    // The newest session names the row - an executor renamed last week is
    // the name it has now, the way the ranking does it.
    if (at >= (group.lastAt ?? 0)) {
      group.lastAt = at;
      group.name = name;
    }
    fold(group, row);
    fold(all, row);
  }
  const list = [...groups.values()].map(finish);
  list.sort(
    how === "week"
      ? (a, b) => a.key.localeCompare(b.key)
      : (a, b) =>
          b.total + b.handBacks + b.refusals - (a.total + a.handBacks + a.refusals) ||
          b.sessions - a.sessions ||
          a.name.localeCompare(b.name),
  );
  const { key, name, ...totals } = finish(all);
  return { by: how, since, until: Number.isFinite(until) ? until : null, groups: list, totals };
}
