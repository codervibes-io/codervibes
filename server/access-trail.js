// The access trail: everything an agent did, asked for or was refused
// under a permission, as one list a person can search.
//
// Three records already hold the pieces. A permission-bearing tool call
// is a span (spans.js) with `cv.tool.permission` on it, and a refused
// one says which permission refused it (`cv.refused`, mcp.js `withheld`).
// An ask for a permission is an access request on the repo
// (access-requests.js); an ask to make one call is an action approval
// there too (action-approvals.js). Each is readable on its own page - the
// agent's Access tab, the session's timeline - and none of them answers
// "who has been merging", "what did the deploy key get used for this
// week" or "which agent keeps getting refused", because that question
// runs across agents, repos and sessions at once. So this folds the three
// into one shape, an *entry*, and the Search page searches the entries.
//
// The search is fuzzy and only that: the trail is a list of names - tools,
// permissions, agents, people - and a person looking for `fly_deploy` who
// types "fly deply" wants the row, not a model's guess at what they
// meant. No meaning, no answer; the words nearby, ranked by how nearly
// they were typed (`fuzzy`).
//
// Every entry links to the session it happened in, when one is known: a
// call carries its session on the span; a request or an approval keeps
// the id of the session that asked (`sessionId`, written by the tool
// that made it), and an older approval without one is matched to the
// span that named it (`cv.approval.id`). The link is the point - the
// trail says what happened, the session says why.
//
// The words rule applies to the words on an entry (the reason an agent
// gave, the arguments it asked to run with): they are the agent's to its
// owner, and the route hands them only to somebody who may open the repo.
import { itemFor } from "./access-requests.js";
import { argsLine } from "./action-approvals.js";

/** What an entry is. */
export const KINDS = ["call", "refusal", "request", "approval"];

/** What came of it, by kind: a call ran or failed; a refusal was refused; an ask was decided or not. */
export const STATES = ["ok", "failed", "refused", "open", "approved", "denied", "done", "lapsed"];

/** The states that mean the thing was allowed and the ones that mean it was not; `open` is neither. */
export const ALLOWED = new Set(["ok", "approved", "done"]);
export const STOPPED = new Set(["failed", "refused", "denied", "lapsed"]);

/**
 * The entries a repo's records hold: its access requests and its action
 * approvals, one entry each, at the moment of the ask, in the state the
 * record is in now.
 */
export function fromRecords(repo) {
  const out = [];
  for (const record of repo?.accessRequests ?? []) {
    const item = itemFor(repo, record.permission);
    out.push({
      id: `request:${record.id}`,
      kind: "request",
      at: Date.parse(record.at) || 0,
      agent: { id: record.agentId, name: record.agentName ?? record.agentId },
      repoId: repo.id,
      repoName: repo.name ?? null,
      permission: record.permission,
      label: item?.label ?? record.permission,
      sensitive: Boolean(item?.sensitive),
      tool: null,
      state: record.state,
      by: record.by ?? null,
      decidedAt: record.decidedAt ? Date.parse(record.decidedAt) || null : null,
      until: record.until ?? null,
      words: [record.reason, record.note ? `Owner: ${record.note}` : null].filter(Boolean).join(" · ") || null,
      taskId: record.taskId ?? null,
      sessionId: record.sessionId ?? null,
    });
  }
  for (const record of repo?.approvals ?? []) {
    const item = itemFor(repo, record.permission);
    out.push({
      id: `approval:${record.id}`,
      kind: "approval",
      at: Date.parse(record.at) || 0,
      agent: { id: record.agentId, name: record.agentName ?? record.agentId },
      repoId: repo.id,
      repoName: repo.name ?? null,
      permission: record.permission,
      label: item?.label ?? record.permission,
      sensitive: Boolean(item?.sensitive),
      tool: record.tool,
      state: record.state,
      by: record.by ?? null,
      decidedAt: record.decidedAt ? Date.parse(record.decidedAt) || null : null,
      until: null,
      words: [record.summary, argsLine(record.args), record.note ? `Owner: ${record.note}` : null].filter(Boolean).join(" · ") || null,
      taskId: record.taskId ?? null,
      sessionId: record.sessionId ?? null,
      approvalId: record.id,
    });
  }
  return out;
}

/**
 * The entries the spans hold: every tool call made under a permission,
 * and every call a permission refused. `labelOf(repoId, permission)` puts
 * the catalogue's name on the row. Spans that carry an approval's id are
 * not entries of their own - the approval is - but they say which session
 * asked, for an approval written before that was kept (`sessionsByApproval`).
 */
export function fromSpans(spans, { labelOf = (repoId, permission) => permission } = {}) {
  const out = [];
  const sessionsByApproval = new Map();
  for (const span of spans) {
    const attrs = span.attrs ?? {};
    if (attrs["cv.approval.id"] && span.session) sessionsByApproval.set(String(attrs["cv.approval.id"]), span.session);
    if (span.name !== "tool.call" || !attrs["cv.agent.id"]) continue;
    const refused = attrs["cv.refused"] ? String(attrs["cv.refused"]) : null;
    const permission = refused ?? (attrs["cv.tool.permission"] ? String(attrs["cv.tool.permission"]) : null);
    if (!permission) continue;
    // A call the gate held or refused is the approval's entry, not a call.
    if (attrs["cv.approval.verdict"] && attrs["cv.approval.verdict"] !== "run") continue;
    const repoId = attrs["cv.repo.id"] ? String(attrs["cv.repo.id"]) : null;
    out.push({
      id: `span:${span.id}`,
      kind: refused ? "refusal" : "call",
      at: span.at,
      agent: { id: String(attrs["cv.agent.id"]), name: attrs["cv.agent.name"] ? String(attrs["cv.agent.name"]) : String(attrs["cv.agent.id"]) },
      repoId,
      repoName: null,
      permission,
      label: labelOf(repoId, permission),
      sensitive: false,
      tool: attrs["cv.tool.name"] ? String(attrs["cv.tool.name"]) : null,
      state: refused ? "refused" : span.ok === false ? "failed" : "ok",
      by: null,
      decidedAt: null,
      until: null,
      words: null,
      taskId: span.task ?? null,
      sessionId: span.session ?? null,
      ms: span.ms ?? null,
    });
  }
  return { entries: out, sessionsByApproval };
}

/**
 * The whole trail for a range: the records of every repo given, the
 * spans, joined - newest first. An approval without a session is given
 * the one its span named.
 */
export function collect({ repos = [], spans = [], since = 0, labelOf } = {}) {
  const names = new Map(repos.map((repo) => [repo.id, repo.name ?? null]));
  const { entries: calls, sessionsByApproval } = fromSpans(spans, {
    labelOf: labelOf ?? ((repoId, permission) => itemFor(repos.find((repo) => repo.id === repoId) ?? null, permission)?.label ?? permission),
  });
  const entries = [];
  for (const repo of repos) {
    for (const entry of fromRecords(repo)) {
      if (!entry.sessionId && entry.approvalId) entry.sessionId = sessionsByApproval.get(entry.approvalId) ?? null;
      entries.push(entry);
    }
  }
  for (const entry of calls) {
    entry.repoName = entry.repoId ? names.get(entry.repoId) ?? null : null;
    entries.push(entry);
  }
  return entries.filter((entry) => entry.at >= since).sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}

// ------------------------------------------------------------------ fuzzy

/** The words of a text as the matcher sees them: lower-cased, split on anything that is not a letter or digit. */
export function words(text) {
  return String(text ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1);
}

/** The line an entry is searched by: everything a person might type to find it. */
export function lineOf(entry) {
  return [
    entry.kind,
    entry.state,
    entry.agent?.name,
    entry.agent?.id,
    entry.repoName,
    entry.permission,
    entry.label,
    entry.tool,
    entry.by,
    entry.words,
    entry.taskId,
    entry.sessionId,
    entry.sensitive ? "sensitive" : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Levenshtein distance, giving up past `max`. */
export function editDistance(a, b, max = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (current[j] < best) best = current[j];
    }
    if (best > max) return max + 1;
    previous = current;
  }
  return previous[b.length];
}

/**
 * How nearly one typed word matches one word of the line: the word itself,
 * then its start, then somewhere in it, then a slip or two of the fingers
 * - each worth less than the last, and nothing below a floor so that
 * "deploy" does not find "employ" by way of the last four letters.
 */
export function wordScore(typed, word) {
  if (typed === word) return 1;
  if (word.startsWith(typed)) return 0.9;
  if (typed.length >= 3 && word.includes(typed)) return 0.7;
  if (typed.length >= 4) {
    // One slip on a word of four or five letters, two on a longer one;
    // `editDistance` gives up past the ceiling, and past it is no match.
    const ceiling = typed.length >= 6 ? 2 : 1;
    const slips = editDistance(typed, word, ceiling);
    if (slips === 1) return 0.6;
    if (slips === 2 && ceiling === 2) return 0.45;
  }
  return 0;
}

/**
 * The entries that match what was typed, best first. Every typed word must
 * find some word of the entry's line; the score is how well they did on
 * average, and a tie goes to the newer entry. Each hit says which words
 * of the line the typed ones landed on, so the row can say so.
 */
export function fuzzy(query, entries, { limit = 50 } = {}) {
  const typed = [...new Set(words(query))];
  if (!typed.length) return [];
  const hits = [];
  for (const entry of entries) {
    const line = [...new Set(words(lineOf(entry)))];
    let total = 0;
    const matched = [];
    for (const one of typed) {
      let best = 0;
      let on = null;
      for (const word of line) {
        const score = wordScore(one, word);
        if (score > best) {
          best = score;
          on = word;
          if (best === 1) break;
        }
      }
      if (!best) {
        total = 0;
        break;
      }
      total += best;
      matched.push(on);
    }
    if (total) hits.push({ entry, score: total / typed.length, matched });
  }
  return hits.sort((x, y) => y.score - x.score || y.entry.at - x.entry.at).slice(0, limit);
}

// ------------------------------------------------------------------ stats

const top = (map, limit, shape) =>
  [...map.values()].sort((x, y) => y.count - x.count || String(x.key).localeCompare(String(y.key))).slice(0, limit).map(shape);

/**
 * What the trail adds up to: how many of each kind and state, which
 * permissions were reached for most and how each went, which agents did
 * the reaching, who decided what, and how many sessions it spans.
 */
export function stats(entries, { limit = 8 } = {}) {
  const byKind = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
  const byState = Object.fromEntries(STATES.map((state) => [state, 0]));
  const permissions = new Map();
  const agents = new Map();
  const deciders = new Map();
  const sessions = new Set();
  const repos = new Set();
  for (const entry of entries) {
    byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
    byState[entry.state] = (byState[entry.state] ?? 0) + 1;
    if (entry.sessionId) sessions.add(entry.sessionId);
    if (entry.repoId) repos.add(entry.repoId);
    const permission = permissions.get(entry.permission) ?? { key: entry.permission, label: entry.label, count: 0, allowed: 0, stopped: 0, open: 0 };
    permission.count += 1;
    if (ALLOWED.has(entry.state)) permission.allowed += 1;
    else if (STOPPED.has(entry.state)) permission.stopped += 1;
    else permission.open += 1;
    permissions.set(entry.permission, permission);
    const agent = agents.get(entry.agent.id) ?? { key: entry.agent.id, name: entry.agent.name, count: 0, allowed: 0, stopped: 0, open: 0 };
    agent.count += 1;
    if (ALLOWED.has(entry.state)) agent.allowed += 1;
    else if (STOPPED.has(entry.state)) agent.stopped += 1;
    else agent.open += 1;
    agents.set(entry.agent.id, agent);
    if (entry.by) {
      const who = deciders.get(entry.by) ?? { key: entry.by, count: 0, approved: 0, denied: 0 };
      who.count += 1;
      if (entry.state === "denied") who.denied += 1;
      else who.approved += 1;
      deciders.set(entry.by, who);
    }
  }
  return {
    total: entries.length,
    byKind,
    byState,
    allowed: entries.filter((entry) => ALLOWED.has(entry.state)).length,
    stopped: entries.filter((entry) => STOPPED.has(entry.state)).length,
    open: byState.open,
    sessions: sessions.size,
    repos: repos.size,
    permissions: top(permissions, limit, ({ key, label, count, allowed, stopped, open }) => ({ permission: key, label, count, allowed, stopped, open })),
    agents: top(agents, limit, ({ key, name, count, allowed, stopped, open }) => ({ id: key, name, count, allowed, stopped, open })),
    deciders: top(deciders, limit, ({ key, count, approved, denied }) => ({ who: key, count, approved, denied })),
  };
}

/** The line an entry is on the histogram: allowed, stopped, or still open. */
export const seriesOf = (entry) => (ALLOWED.has(entry.state) ? "allowed" : STOPPED.has(entry.state) ? "stopped" : "open");
