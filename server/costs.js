// What a piece of work cost.
//
// Three things, and they are not equally knowable. Being straight about which
// is which is most of the design here, because a console that presents a guess
// and a measurement in the same typeface is a console people make decisions
// from and should not.
//
//   **Time** is exact. Every tool call is timed, and a task carries the wall
//   clock between being accepted and being finished. Both are worth having and
//   they answer different questions: an agent that spent four seconds of tool
//   time across two hours was waiting for somebody, not working.
//
//   **Compute** is exact where a rate is configured. The sandbox is ours, we
//   know which host it is on and how long a call held it. Multiply by the
//   host's `costPerHourCents` and it is money. With no rate configured it is
//   machine-seconds and nothing more - see hosts.js on why we do not invent
//   one.
//
//   **Tokens** are the awkward one. For the built-in assistant we have the
//   real numbers, because the model call is ours. For an *invited* agent the
//   model runs on somebody else's machine under somebody else's key, and we
//   cannot see it. What we can measure is what we *handed* it: every byte of
//   every tool result is something it had to read, and therefore pay for. That
//   is a floor, not a total, and it is labelled as one. An agent that wants
//   the real figure on the record can report it - see `report`.
//
// Held in memory and capped, like the activity feed. This is for watching what
// is happening, not for billing anybody: losing it costs a graph.
import { MODELS, priceOf } from "./models.js";
import { onSpan } from "./telemetry.js";

/** Entries kept. Beyond this the oldest go; the rollups stay approximately right. */
const MAX_ENTRIES = 20_000;

/**
 * Characters per token, for turning "how much text did we hand it" into
 * something comparable with a token count.
 *
 * Four is the usual rule of thumb for English prose and roughly right for
 * source code. It is an estimate and every surface that shows it says so - the
 * point of the number is orders of magnitude, not accuracy.
 */
const CHARS_PER_TOKEN = 4;

export const estimateTokens = (chars) => Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);

/**
 * Whether any model here has a price, so a surface can say "tokens, not
 * dollars" up front rather than showing a column of dashes. The rates
 * themselves live with the catalogue (models.js `priceOf`).
 */
export const anyPriced = () => MODELS.some((model) => priceOf(model.id) != null) || priceOf("*") != null;

/** The four counts a usage has, all nought. */
export const noTokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

const empty = () => ({
  calls: 0,
  ms: 0,
  sandboxMs: 0,
  // Tokens we handed over, measured in characters and converted. A floor.
  handedChars: 0,
  // Tokens somebody told us about: exact for the built-in assistant, declared
  // for an invited agent.
  tokens: noTokens(),
  reported: false,
  // Of the calls, how many went on the owner's own Claude subscription
  // (claude-code.js) - counted in `tokens`, at no cost to this installation.
  subscribed: 0,
  computeCents: 0,
  pricedCompute: true,
  tokenCents: 0,
  pricedTokens: true,
});

function add(into, entry) {
  into.calls += 1;
  into.ms += entry.ms ?? 0;
  into.sandboxMs += entry.sandboxMs ?? 0;
  into.handedChars += entry.handedChars ?? 0;
  if (entry.tokens) {
    for (const key of Object.keys(into.tokens)) into.tokens[key] += entry.tokens[key] ?? 0;
    into.reported = true;
    // Priced entry by entry, because each was a call to one model and the
    // rate is the model's - a total over an Opus agent and a Sonnet agent
    // is two rates, not one. One entry with no rate makes the whole total
    // unpriced, for the reason the hosts get below.
    if (entry.subscription) {
      into.subscribed += 1;
    } else {
      // A gateway that said what the call cost (models.js `reported`) is
      // believed over the catalogue: it is the number on the bill.
      const cents = entry.cents ?? tokenCost(entry.tokens, entry.model);
      if (cents == null) into.pricedTokens = false;
      else into.tokenCents += cents;
    }
  }
  // Machine time used to be costed here, at the rate of the host this app
  // booted the machine on. It boots none: what a person's own laptop or
  // their own e2b sandbox costs is on their own bill, and this app has no
  // honest rate to apply to it. The fields stay and stay zero, so nothing
  // downstream has to learn a new shape.
  return into;
}

class Ledger {
  constructor() {
    this.entries = [];
  }

  /**
   * One unit of work.
   *
   * @param {object} entry
   * @param {string|null} entry.taskId what it was for, if the agent said
   * @param {string} entry.agentId who did it
   * @param {number} entry.ms wall clock inside the call
   * @param {number} [entry.sandboxMs] of which, holding a sandbox
   * @param {string} [entry.host] which host that sandbox is on
   * @param {string} [entry.sandbox] which machine it was, for `usage`
   * @param {number} [entry.handedChars] characters of result we sent back
   * @param {{input,output,cacheRead,cacheWrite}} [entry.tokens] real usage, when known
   * @param {string} [entry.model] which model those tokens went to, for the price
   * @param {number} [entry.cents] what the call cost, when the gateway that served it said
   */
  record(entry) {
    this.entries.push({ at: Date.now(), ...entry });
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
  }

  /**
   * Usage an agent has volunteered.
   *
   * Kept apart from what we measured, because it is a different kind of fact:
   * we are taking its word for it. Every surface that shows the two says which
   * is which.
   */
  report({ taskId, agentId, tokens, model = null }) {
    if (!tokens) return;
    this.record({ taskId, agentId, ms: 0, tokens, model, declared: true });
  }

  /** What was spent on one task, not counting anything it handed on. */
  forTask(taskId) {
    const totals = empty();
    for (const entry of this.entries) {
      if (entry.taskId === taskId) add(totals, entry);
    }
    return finish(totals);
  }

  /** Everything one agent has spent, whatever it was for. */
  forAgent(agentId) {
    const totals = empty();
    for (const entry of this.entries) {
      if (entry.agentId === agentId) add(totals, entry);
    }
    return finish(totals);
  }

  /** Work with no task attached to it - most of it, for most agents. */
  untasked(agentId) {
    const totals = empty();
    for (const entry of this.entries) {
      if (entry.agentId === agentId && !entry.taskId) add(totals, entry);
    }
    return finish(totals);
  }

  /** Which machines did work for a task - the sandboxes on its entries. */
  machinesFor(taskId) {
    const machines = new Set();
    for (const entry of this.entries) {
      if (entry.taskId === taskId && entry.sandbox) machines.add(entry.sandbox);
    }
    return machines;
  }

  forget(taskId) {
    this.entries = this.entries.filter((entry) => entry.taskId !== taskId);
  }

  /**
   * How the machines have been used since a moment: per machine, and over
   * time.
   *
   * Only calls that held a machine count, and only against that machine - a
   * call that never touched one used none, whatever it cost in tokens. The
   * caller says which machines it may see, and anything else is left out
   * rather than aggregated anonymously: a total that quietly included a
   * stranger's machine would be a number about somebody else's account.
   *
   * @param {object} args
   * @param {number} args.since epoch ms; nothing older is counted
   * @param {Set<string>} args.machines ids the caller may see
   * @param {number} args.bucketMs width of one column of the timeline
   * @param {number} [args.now]
   */
  usage({ since, machines, bucketMs, now = Date.now() }) {
    const perMachine = new Map();
    const columns = Math.max(1, Math.ceil((now - since) / bucketMs));
    const series = Array.from({ length: columns }, (_, index) => ({
      from: since + index * bucketMs,
      calls: 0,
      sandboxMs: 0,
    }));
    const totals = { ...empty(), agents: new Set() };

    for (const entry of this.entries) {
      if (entry.at < since || !entry.sandbox || !machines.has(entry.sandbox)) continue;
      const machine = perMachine.get(entry.sandbox) ?? { ...empty(), agents: new Set(), lastAt: 0 };
      add(machine, entry);
      machine.agents.add(entry.agentId);
      machine.lastAt = Math.max(machine.lastAt, entry.at);
      perMachine.set(entry.sandbox, machine);

      add(totals, entry);
      totals.agents.add(entry.agentId);

      const column = series[Math.min(columns - 1, Math.floor((entry.at - since) / bucketMs))];
      column.calls += 1;
      column.sandboxMs += entry.sandboxMs ?? 0;
    }

    return {
      series,
      totals: { ...finish(totals), agents: totals.agents.size },
      machines: [...perMachine]
        .map(([id, machine]) => ({
          id,
          ...finish(machine),
          agents: [...machine.agents],
          lastAt: machine.lastAt,
        }))
        // Busiest first: the question the dashboard is asked is "where is
        // the money going", and the answer is at the top.
        .sort((a, b) => b.sandboxMs - a.sandboxMs || b.calls - a.calls),
    };
  }
}

/**
 * Round the money and say what the totals mean.
 *
 * `handedTokens` is deliberately a separate field from `tokens` rather than
 * being folded in. They are a measurement and an estimate, and adding them
 * would produce a number that is neither.
 */
function finish(totals) {
  return {
    calls: totals.calls,
    ms: totals.ms,
    sandboxMs: totals.sandboxMs,
    tokens: totals.tokens,
    /** Only meaningful when true - otherwise `tokens` is all zeroes. */
    tokensReported: totals.reported,
    /** How many of the calls ran on the owner's Claude subscription, priced at nothing here. */
    subscribed: totals.subscribed,
    handedTokens: estimateTokens(totals.handedChars),
    computeCents: totals.pricedCompute ? Math.round(totals.computeCents * 100) / 100 : null,
    /** Null when no tokens were reported, or some of them went to a model with no price. */
    tokenCents: totals.reported && totals.pricedTokens ? Math.round(totals.tokenCents * 100) / 100 : null,
  };
}

/** A total with nothing in it, shaped like every other - what a reduce over `merge` starts from. */
export const nothingSpent = () => finish(empty());

/**
 * What one call's tokens cost at one model's rates, or null where the model
 * has no price for a kind of token it used. Nothing used is nothing spent,
 * not unknown.
 */
export function tokenCost(tokens, model) {
  const price = priceOf(model);
  const parts = [
    [tokens.input, price?.input],
    [tokens.output, price?.output],
    [tokens.cacheRead, price?.cacheRead],
    [tokens.cacheWrite ?? 0, price?.cacheWrite],
  ];
  if (parts.some(([count, rate]) => count && rate == null)) return null;
  return parts.reduce((sum, [count, rate]) => sum + ((count ?? 0) / 1e6) * (rate ?? 0), 0);
}

/** Two totals, added. Used to roll a task's subtasks up into it. */
export function merge(a, b) {
  return {
    calls: a.calls + b.calls,
    ms: a.ms + b.ms,
    sandboxMs: a.sandboxMs + b.sandboxMs,
    tokens: Object.fromEntries(
      Object.keys(noTokens()).map((key) => [key, (a.tokens[key] ?? 0) + (b.tokens[key] ?? 0)]),
    ),
    tokensReported: a.tokensReported || b.tokensReported,
    subscribed: (a.subscribed ?? 0) + (b.subscribed ?? 0),
    handedTokens: a.handedTokens + b.handedTokens,
    // One unpriced side makes the sum unpriced. A total that silently omitted
    // the part it could not price would read as cheaper than it was.
    computeCents:
      a.computeCents == null || b.computeCents == null
        ? null
        : Math.round((a.computeCents + b.computeCents) * 100) / 100,
    // The same for tokens, with one more case: a side that reported none
    // has nothing to price and is not what makes the sum unknown - a
    // parent that only delegated costs what its pieces cost.
    tokenCents:
      (a.tokensReported && a.tokenCents == null) || (b.tokensReported && b.tokenCents == null)
        ? null
        : a.tokenCents == null && b.tokenCents == null
          ? null
          : Math.round(((a.tokenCents ?? 0) + (b.tokenCents ?? 0)) * 100) / 100,
  };
}

/**
 * What a task cost including everything it handed on.
 *
 * This is the number the question "what did that feature cost" wants: a task
 * that was answered by delegating to three other agents cost what all four of
 * them spent, and the parent's own line would say almost nothing.
 *
 * `tasks` is the whole list, because descendants are found by parentId and a
 * subtask can live in a different repo to its parent.
 */
export function rollup(ledger, tasks, taskId, seen = new Set()) {
  if (seen.has(taskId)) return ledger.forTask(taskId); // a broken parent link
  seen.add(taskId);

  // A settled task's own copy outlives the ledger - see `spentOn`.
  const own = tasks.find((task) => task.id === taskId)?.spent;
  let total = own ?? ledger.forTask(taskId);
  for (const child of tasks.filter((task) => task.parentId === taskId)) {
    total = merge(total, rollup(ledger, tasks, child.id, seen));
  }
  return total;
}

/**
 * How long a task was *open*, as opposed to how long anybody worked on it.
 *
 * The gap between the two is the useful part. Four seconds of tool time over
 * two hours means an agent was waiting - for another agent, or for somebody to
 * come back - and no amount of compute accounting shows that.
 */
export function elapsed(task, now = Date.now()) {
  const from = Date.parse(task.createdAt);
  if (!Number.isFinite(from)) return null;
  const to = settled(task) ? Date.parse(task.settledAt ?? task.updatedAt) : now;
  return Number.isFinite(to) ? Math.max(0, to - from) : null;
}

const settled = (task) => task.state === "done" || task.state === "declined" || task.state === "failed";

/**
 * How long somebody was *on* a task: from accepting it to settling it, or
 * to now. Null before it was accepted - a task on the board that nobody has
 * picked up has cost nobody's time yet.
 */
export function worked(task, now = Date.now()) {
  const from = Date.parse(task.acceptedAt);
  if (!Number.isFinite(from)) return null;
  const to = settled(task) ? Date.parse(task.settledAt ?? task.updatedAt) : now;
  return Number.isFinite(to) ? Math.max(0, to - from) : null;
}

/**
 * Everything one task cost, in the shape the board and the record keep.
 *
 * On top of the ledger's totals: how long it was worked, on how many
 * machines, and the product - *compute time*, machine-minutes, the number
 * that says what a task that held three sandboxes for ten minutes actually
 * used. The machines are the ones on the ledger's entries plus the one the
 * assignee lives on, if the caller knows it: an agent doing a task on its
 * own machine with no server-side tool calls shows up in no ledger entry,
 * and one machine for the whole time is the least it used.
 *
 * A settled task keeps its own copy (`task.spent`, written on the close):
 * the ledger is in memory and forgets on restart, the record does not.
 */
export function spentOn(ledger, task, { now = Date.now(), home = null } = {}) {
  if (task.spent) return { ...task.spent, frozen: true };
  const own = ledger.forTask(task.id);
  const machines = ledger.machinesFor(task.id);
  if (home) machines.add(home);
  const workedMs = worked(task, now);
  return {
    ...own,
    workedMs,
    machines: machines.size,
    computeMs: workedMs == null ? null : workedMs * Math.max(1, machines.size),
  };
}

export const costs = new Ledger();

/**
 * The ledger hears the spans (telemetry.js) rather than being told by every
 * caller: a tool call that ended is an entry, a model call that ended is an
 * entry with tokens. What a resident reports about its own local calls is
 * `retroactive` and left out here - its usage arrives declared, through
 * `report`, and counting the calls too would price the same work twice.
 */
export function entriesFromSpan(span, { replay = false } = {}) {
  const attrs = span.attrs ?? {};
  if (attrs["cv.retroactive"]) return [];
  const who = { at: span.at, taskId: span.task ?? null, agentId: attrs["cv.agent.id"] ?? null };
  const tokens = () => ({
    input: Number(attrs["cv.tokens.input"] ?? 0),
    output: Number(attrs["cv.tokens.output"] ?? 0),
    cacheRead: Number(attrs["cv.tokens.cacheRead"] ?? 0),
    cacheWrite: Number(attrs["cv.tokens.cacheWrite"] ?? 0),
  });
  if (span.name === "tool.call") {
    const entries = [{
      ...who,
      ms: span.ms,
      sandboxMs: Number(attrs["cv.sandbox.ms"] ?? 0),
      host: attrs["cv.host.id"] ?? null,
      sandbox: attrs["cv.sandbox.id"] ?? null,
      handedChars: Number(attrs["cv.handed.chars"] ?? 0),
    }];
    // Usage an agent declared on this call (collab-tools.js) went to
    // `report` as it happened; it is on the span so a replay finds it.
    if (replay && attrs["cv.declared"]) {
      entries.push({ ...who, ms: 0, tokens: tokens(), model: attrs["cv.model"] ?? null, declared: true });
    }
    return entries;
  }
  if (span.name === "model.call" && attrs["cv.model"]) {
    // `ms` on the ledger is tool time (see the essay); a model's latency is
    // on its span, where the timeline reads it, and not added in here.
    const cents = Number(attrs["cv.cost.cents"]);
    return [{
      ...who,
      ms: 0,
      sandbox: attrs["cv.sandbox.id"] ?? null,
      model: attrs["cv.model"],
      tokens: tokens(),
      ...(attrs["cv.cost.cents"] != null && Number.isFinite(cents) ? { cents } : {}),
    }];
  }
  return [];
}

/** Fold one span into the ledger - live as they finish, and again at boot from the store (replay.js). */
export function foldSpan(span, options) {
  const entries = entriesFromSpan(span, options);
  for (const entry of entries) costs.record(entry);
  return entries;
}

onSpan((span) => foldSpan(span));
