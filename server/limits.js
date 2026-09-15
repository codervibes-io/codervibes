// Global guardrails.
//
// Every ceiling in the product lives here, in one place, so "how much can one
// person cost me" has a single answer rather than being spread across five
// modules. All of them are env-tunable, and all of them are printed at boot -
// a limit nobody can see is a limit nobody remembers exists.
//
// The one that used to matter most was `maxSandboxes`: every repo became a
// VM and an agent could make more, so without a ceiling a loop over
// create_sandbox was an unbounded bill. This app boots no machines, and the
// only thing left that spends its money is inference on its own key.
//
// Scope note: the counters below are per process, and production runs more
// than one machine. A per-user rate limit of 30/hour is therefore 30/hour/
// machine in the worst case.

const int = (name, fallback) => {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number, got '${raw}'`);
  }
  return Math.floor(value);
};

export const LIMITS = {
  // ---- repos. Cheap now: a repo is a registration rather than a machine
  // with a disk, so these are about one account not filling the table.
  /** Repos one person may own. */
  maxReposPerUser: int("CODERVIBES_MAX_REPOS_PER_USER", 8),
  /** Repos in the whole installation. */
  maxReposTotal: int("CODERVIBES_MAX_REPOS", 200),

  // ---- invited agents. Somebody else's model, running on somebody else's
  // machine: it spends nothing of this installation's, so the ceilings here
  // are about how hard it can hammer one repo.
  /** Tool calls one agent may have in flight at once. */
  maxConcurrentAgentCalls: int("CODERVIBES_MAX_AGENT_CALLS", 4),
  /** Tool calls one agent may make per hour. */
  maxAgentCallsPerHour: int("CODERVIBES_MAX_AGENT_CALLS_PER_HOUR", 2_000),

  // ---- inference on this installation's key. An agent that borrows the
  // door at /inference spends real money, so the ceiling that matters is on
  // tokens rather than calls: one call at a hundred thousand tokens of
  // context is the cost of two hundred small ones. Counted in the unit the
  // bill is in, see `tokenEquivalents`.
  /** Token equivalents one agent may spend in an hour. */
  maxAgentTokensPerHour: int("CODERVIBES_MAX_AGENT_TOKENS_PER_HOUR", 1_500_000),
  /** Token equivalents every agent together may spend in a day. */
  maxTokensPerDay: int("CODERVIBES_MAX_TOKENS_PER_DAY", 10_000_000),

  // ---- payload ceilings
  /** Bytes of stdout/stderr fed back to the model from one command. */
  maxCommandOutputBytes: int("CODERVIBES_MAX_COMMAND_OUTPUT", 20_000),
  /** Largest file an agent will pull out of a sandbox. */
  maxFileBytes: int("CODERVIBES_MAX_FILE_BYTES", 1_000_000),
  /**
   * Largest file that may be uploaded from a browser into a repo.
   *
   * The same ceiling as reading one, and for the same reason: a file bigger
   * than that cannot be opened in the editor or read by the agent once it is
   * in there, so accepting it would be accepting something nothing in this
   * product can then do anything with. It also has to leave room under
   * maxRequestBytes, which the base64 in the body costs 4 bytes per 3 of.
   */
  maxUploadBytes: int("CODERVIBES_MAX_UPLOAD_BYTES", 1_000_000),
  /**
   * Ceilings on exporting a repo as a zip.
   *
   * Built in memory, so both of these are really one question: how much of
   * this process is one download allowed to hold. A repo past either is
   * refused with the number rather than truncated - an archive that opens and
   * is quietly missing files is the worse failure.
   */
  maxExportFiles: int("CODERVIBES_MAX_EXPORT_FILES", 2_000),
  maxExportBytes: int("CODERVIBES_MAX_EXPORT_BYTES", 50_000_000),
  /** Largest request body accepted anywhere. */
  maxRequestBytes: int("CODERVIBES_MAX_REQUEST_BYTES", 4_000_000),
  /** People one repo may be shared with. */
  maxMembersPerRepo: int("CODERVIBES_MAX_MEMBERS", 25),
  /** People in one workspace, and workspaces one person may own (workspaces.js). */
  maxMembersPerWorkspace: int("CODERVIBES_MAX_WORKSPACE_MEMBERS", 50),
  maxWorkspacesPerUser: int("CODERVIBES_MAX_WORKSPACES_PER_USER", 10),

  // ---- repo chat. Cheap - a websocket frame and one small write - so
  // this is about a stuck client hammering the room, not about cost.
  /** Chat messages one person may send to a repo per hour. */
  maxChatMessagesPerHour: int("CODERVIBES_MAX_CHAT_PER_HOUR", 600),

  // ---- feedback. Lands in one person's inbox, and is open to people who are
  // not signed in - so the ceiling is about it not becoming a mailer.
  /** Pieces of feedback one person may send per hour. */
  maxFeedbackPerHour: int("CODERVIBES_MAX_FEEDBACK_PER_HOUR", 5),
};

export class LimitError extends Error {
  constructor(message, { status = 429, limit } = {}) {
    super(message);
    this.status = status;
    this.limit = limit;
  }
}

/** One line per limit, for the boot banner. */
export function describeLimits() {
  return [
    `repos       ${LIMITS.maxReposPerUser}/user, ${LIMITS.maxReposTotal} total`,
    `agents      ${LIMITS.maxConcurrentAgentCalls} concurrent, ` +
      `${LIMITS.maxAgentCallsPerHour}/hour per agent`,
    `tokens      ${short(LIMITS.maxAgentTokensPerHour)}/hour per agent, ` +
      `${short(LIMITS.maxTokensPerDay)}/day in all (input-token equivalents)`,
  ];
}

// ------------------------------------------------------------ concurrency

/**
 * "At most N of these at once, per key." Used for agent turns and question
 * generation, where the cost is in what runs, not in how often it is asked for.
 */
export class ConcurrencyGate {
  constructor(limit, what) {
    this.limit = limit;
    this.what = what;
    this.active = new Map(); // key -> count
  }

  /** @returns {() => void} release. Throws LimitError when the key is at its cap. */
  enter(key) {
    const id = key ?? "anonymous";
    const count = this.active.get(id) ?? 0;
    if (this.limit && count >= this.limit) {
      throw new LimitError(
        `You already have ${count} ${this.what} running. Wait for one to finish.`,
        { status: 429, limit: this.limit },
      );
    }
    this.active.set(id, count + 1);
    let released = false;
    return () => {
      if (released) return; // release() is called from a finally *and* on abort
      released = true;
      const now = (this.active.get(id) ?? 1) - 1;
      if (now <= 0) this.active.delete(id);
      else this.active.set(id, now);
    };
  }
}

// -------------------------------------------------------------- rate limit

/**
 * A sliding-window counter per key. Deliberately in memory: this is a cost
 * guardrail, not a security boundary, and a shared counter would mean a round
 * trip to DynamoDB on the hot path of every chat message.
 */
export class RateLimiter {
  constructor(limit, windowMs, what) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.what = what;
    this.hits = new Map(); // key -> number[] (timestamps)
  }

  check(key, now = Date.now()) {
    if (!this.limit) return;
    const id = key ?? "anonymous";
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(id) ?? []).filter((at) => at > cutoff);
    if (recent.length >= this.limit) {
      const retryInMs = recent[0] + this.windowMs - now;
      throw new LimitError(
        `Rate limit: ${this.limit} ${this.what} per hour. Try again in ` +
          `${Math.ceil(retryInMs / 60_000)} minute(s).`,
        { status: 429, limit: this.limit },
      );
    }
    recent.push(now);
    this.hits.set(id, recent);
  }

  /** Drop keys whose window has emptied, so an idle process doesn't grow. */
  sweep(now = Date.now()) {
    const cutoff = now - this.windowMs;
    for (const [id, times] of this.hits) {
      const recent = times.filter((at) => at > cutoff);
      if (recent.length) this.hits.set(id, recent);
      else this.hits.delete(id);
    }
  }
}

// ------------------------------------------------------------------ spend

/** A big number as it is said: 1.5M, 10M, 250k. */
export const short = (n) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

/**
 * What a model call cost, as a count of input tokens.
 *
 * The four kinds of token are priced in a fixed ratio to one another at
 * every current model - an output token is five input tokens, a cache write
 * is one and a quarter, a cache read a tenth - so one number stands for the
 * bill without a price being configured, and a ceiling in it is a ceiling
 * in money whichever model is behind it. What it is not is a token count:
 * a call that read 80,000 cached tokens and wrote 400 is 10,000 of these.
 */
export const tokenEquivalents = ({ input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = {}) =>
  Math.round(input + 1.25 * cacheWrite + 0.1 * cacheRead + 5 * output);

/**
 * A sliding-window sum per key: "at most this much of it per window". The
 * counterpart of RateLimiter for a limit on amount rather than on count,
 * and in memory for the same reason it is.
 *
 * Checked before the call and added to after it, so the call that crosses
 * the line is let through and the next is refused - a limit that had to
 * know the cost of a call before making it would not be able to.
 */
export class SpendWindow {
  constructor(limit, windowMs, what) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.what = what;
    this.spent = new Map(); // key -> {at, amount}[]
  }

  /** How much the key has spent inside the window. */
  total(key, now = Date.now()) {
    const cutoff = now - this.windowMs;
    return (this.spent.get(key ?? "anonymous") ?? []).reduce((sum, entry) => (entry.at > cutoff ? sum + entry.amount : sum), 0);
  }

  check(key, now = Date.now()) {
    if (!this.limit) return;
    const id = key ?? "anonymous";
    const cutoff = now - this.windowMs;
    const recent = (this.spent.get(id) ?? []).filter((entry) => entry.at > cutoff);
    this.spent.set(id, recent);
    const total = recent.reduce((sum, entry) => sum + entry.amount, 0);
    if (total >= this.limit) {
      const retryInMs = recent[0].at + this.windowMs - now;
      throw new LimitError(
        `Spend limit: ${short(this.limit)} ${this.what}. ${short(total)} spent so far; ` +
          `some of it is out of the window in ${Math.ceil(retryInMs / 60_000)} minute(s).`,
        { status: 429, limit: this.limit },
      );
    }
  }

  add(key, amount, now = Date.now()) {
    if (!this.limit || !amount) return;
    const id = key ?? "anonymous";
    const entries = this.spent.get(id) ?? [];
    entries.push({ at: now, amount });
    this.spent.set(id, entries);
  }

  sweep(now = Date.now()) {
    const cutoff = now - this.windowMs;
    for (const [id, entries] of this.spent) {
      const recent = entries.filter((entry) => entry.at > cutoff);
      if (recent.length) this.spent.set(id, recent);
      else this.spent.delete(id);
    }
  }
}

/** Cut text to a byte ceiling, saying so rather than silently losing the tail. */
export function truncate(text, max = LIMITS.maxCommandOutputBytes) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n[truncated at ${max} bytes of ${value.length}]`;
}
