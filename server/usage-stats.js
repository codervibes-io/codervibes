// What the installation has been used for, added up over a range.
//
// The Search page opens on this, before anything is typed: how many
// sessions, by how many agents and people, how many tool calls and what
// they cost, which tools and connectors were reached for most - and the
// access trail's own sums beside them (access-trail.js `stats`). The
// numbers are the same ones Home, Tools and Performance count, folded
// here into one screen, because the question "what has been going on"
// is asked before "how did we do X" and belongs on the same page.
//
// Sessions are counted off their records (sessions.js: counts, not
// words); the tools off the spans; nothing here reads a session's text.
import * as trail from "./access-trail.js";

/** How many rows each top list carries. */
export const TOP = 8;

const topOf = (map, limit) => [...map.values()].sort((x, y) => y.count - x.count || String(x.key).localeCompare(String(y.key))).slice(0, limit);

/**
 * The figures for a range, from the sessions and spans the caller may see
 * and the trail entries of the same.
 */
export function usage({ sessions = [], spans = [], entries = [], limit = TOP } = {}) {
  const byKind = {};
  const people = new Set();
  const actors = new Set();
  let live = 0;
  let toolCalls = 0;
  let toolsFailed = 0;
  let modelCalls = 0;
  let tokens = 0;
  let cost = 0;
  for (const session of sessions) {
    byKind[session.kind ?? "other"] = (byKind[session.kind ?? "other"] ?? 0) + 1;
    if (session.owner) people.add(session.owner);
    if (session.actor?.id) actors.add(session.actor.id);
    if (session.state === "live") live += 1;
    toolCalls += Number(session.counts?.tools) || 0;
    toolsFailed += Number(session.counts?.toolsFailed) || 0;
    modelCalls += Number(session.counts?.modelCalls) || 0;
    tokens += Number(session.counts?.tokens) || 0;
    cost += Number(session.counts?.cost) || 0;
  }
  const tools = new Map();
  const connectors = new Map();
  for (const span of spans) {
    const attrs = span.attrs ?? {};
    if (span.name === "tool.call" && attrs["cv.tool.name"]) {
      const name = String(attrs["cv.tool.name"]);
      const row = tools.get(name) ?? { key: name, count: 0, failed: 0 };
      row.count += 1;
      if (span.ok === false) row.failed += 1;
      tools.set(name, row);
    }
    if (attrs["cv.connector.id"]) {
      const id = String(attrs["cv.connector.id"]);
      const row = connectors.get(id) ?? { key: id, count: 0, writes: 0 };
      row.count += 1;
      if (attrs["cv.connector.write"]) row.writes += 1;
      connectors.set(id, row);
    }
  }
  return {
    sessions: { total: sessions.length, live, byKind, people: people.size, agents: actors.size },
    calls: { tools: toolCalls, toolsFailed, models: modelCalls, tokens, cost },
    tools: topOf(tools, limit).map(({ key, count, failed }) => ({ name: key, count, failed })),
    connectors: topOf(connectors, limit).map(({ key, count, writes }) => ({ id: key, count, writes })),
    trail: trail.stats(entries, { limit }),
  };
}
