// The Search page: one question over everything this installation has done.
//
// The index and the ranking are search.js; the answer that reads the hits
// back is discover-agent.js; the trail is access-trail.js. This is the page
// over the three - what a range means here, which hits this reader may see
// at all, and which of them they may read the words of. All three of those
// are the scope's (server/scope.js).
//
// The catalogue Search searches beside the sessions comes in the same way:
// the built-in connectors and this app's own tools are things the cloud
// edition has and another may not, so they are handed in rather than
// imported - a page that imported the connector registry would drag every
// vendor's client into an installation that has connected none of them.
import * as search from "../search.js";
import * as discoverAgent from "../discover-agent.js";
import * as accessTrail from "../access-trail.js";
import * as toolStats from "../tool-stats.js";
import * as performance from "../performance.js";
import * as models from "../models.js";
import * as spans from "../spans.js";
import { repos } from "../repos.js";
import { histogram } from "../histogram.js";
import { usage } from "../usage-stats.js";

/**
 * The catalogue Search searches beside the sessions: the built-in
 * connectors with their tools, this app's own tools, and the skills the
 * month's sessions used. Read whole and replaced whole (search.js
 * `indexCatalog`).
 */
export async function refreshSearchCatalog(scope) {
  try {
    const sources = scope.catalogueSources();
    const built = (sources.connectors ?? []).map((connector) => ({
      id: connector.id,
      label: connector.label,
      hint: connector.hint,
      tools: (connector.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description })),
    }));
    const tools = [
      // Not the search itself: its description quotes the example question, and would be its own first hit.
      ...(sources.tools ?? []).filter((tool) => tool.name !== "discover").map((tool) => ({ name: tool.name, description: tool.description })),
      ...built.flatMap((connector) => connector.tools.map((tool) => ({ ...tool, connector: connector.id, connectorLabel: connector.label }))),
    ];
    const since = Date.now() - search.KEEP_MS;
    const folded = toolStats.fold({ spans: spans.recent({ since }).spans, tasks: [], since });
    const skills = (folded.skills?.rows ?? []).map((row) => ({ name: row.name, sessions: row.sessions ?? row.calls ?? 0 }));
    await search.indexCatalog({ connectors: built, tools, skills });
  } catch (err) {
    console.warn(`search: could not index the catalogue: ${err.message}`);
  }
}

/**
 * The range that is no range: what Search opens on, and what the picker
 * calls "All time" - which is all the time there is, since the index
 * holds a month and the sessions' events expire at thirty days
 * (search.js KEEP_MS).
 */
const ALL_TIME = "all";

/**
 * The range a search reads: `range` as on the Tools page (a month unless
 * said otherwise), and inside it the one bucket of the histogram a person
 * pressed, as `from` and `to` in milliseconds. The histogram is always
 * over the whole range, so the bars stay put while one of them is open.
 */
function searchRange(req, { fallback = "all" } = {}) {
  const now = Date.now();
  const asked = String(req.query.range ?? "");
  const range = asked === ALL_TIME || performance.RANGES[asked] ? asked : fallback;
  // All time has no floor: the histogram takes its start from the oldest
  // thing counted (histogram.js), and nothing is dropped for its age.
  const since = range === ALL_TIME ? 0 : now - performance.RANGES[range];
  const from = Number(req.query.from) || 0;
  const to = Number(req.query.to) || 0;
  const within = from || to ? (at) => (!from || at >= from) && (!to || at < to) : () => true;
  return { now, range, since, from: from || null, to: to || null, within };
}

/** The filter's word for a session this app cannot place on a vendor. */
const NO_PROVIDER = "none";

/**
 * Whose models a session's work was done on, as the provider filter names
 * them: the providers of the models it called (search.js `sessionDocument`),
 * and `NO_PROVIDER` for a session that called none this app can place - a
 * harness that reported no model at all, or one whose id no provider
 * claims. That is an option like the rest, because "which of this reported
 * nothing" is a real question to ask of a page of numbers that do not add
 * up. Nothing in the catalogue is on a provider.
 */
function providersOf(doc) {
  if (doc.kind !== "session") return [];
  const ids = doc.providers ?? [];
  return ids.length ? ids : [NO_PROVIDER];
}

/** Every provider the hits were done on, most work first, as the filter offers them. */
function providerFacets(hits) {
  const counts = new Map();
  for (const hit of hits) for (const id of providersOf(hit.doc)) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts]
    .map(([id, count]) => ({ id, label: id === NO_PROVIDER ? "Not reported" : models.PROVIDERS[id]?.label ?? id, count }))
    .sort((one, other) => other.count - one.count || one.label.localeCompare(other.label));
}

/** An entry as the page reads it: the record, its words only for who may read them. */
function describeEntry(entry, readable) {
  const { approvalId, ...rest } = entry;
  return { ...rest, words: entry.repoId && readable.has(entry.repoId) ? entry.words : null };
}

export function mount(app, scope) {
  const { wrap, requireViewer, requireUser } = scope;

  /**
   * Search: the best sessions, connectors, tools and skills for a question
   * (search.js). The words rule as everywhere: a session in the open
   * workspace (or the asker's own, off every listing) is a hit, and its title and the quoted
   * text go only to somebody who may read the session's words - the rest
   * see who was working and what was reached for. The catalogue is
   * everybody's. `kind` narrows to one of the four and `provider` to the
   * sessions done on one vendor's models; `range` is the sessions' age, as
   * on the Tools page, and `from`/`to` one bar of the histogram that comes
   * back with the hits - which counts every match in the range, not only
   * the ones the page lists.
   *
   * Nothing asked is everything, newest first (search.js), over all time
   * unless a range says otherwise: the page a reader opens shows what this
   * installation has done, and narrows only when they say so.
   */
  app.get("/api/search", requireViewer, wrap(async (req, res) => {
    const q = String(req.query.q ?? "").trim().slice(0, 500);
    const kinds = String(req.query.kind ?? "").split(",").map((entry) => entry.trim()).filter((entry) => search.KINDS.includes(entry));
    // One provider, by the id the facets below give out - anything else is
    // no filter at all rather than a filter that matches nothing.
    const askedProvider = String(req.query.provider ?? "").trim();
    const provider = askedProvider === NO_PROVIDER || models.PROVIDERS[askedProvider] ? askedProvider : null;
    const { now, range, since, from, to, within } = searchRange(req);
    // A question is answered with its best few; nothing asked is a listing,
    // and a listing that stops at twenty reads as a search that went wrong.
    const limit = Math.min(Math.max(Number(req.query.limit) || (q ? 20 : 50), 1), 100);
    // The open workspace's sessions, as every listing - and the asker's own
    // that are no repo's, which are on no listing (sessionVisible) and would
    // otherwise be findable nowhere: a harness on their laptop, a sandbox
    // started on an empty machine.
    const own = (session) => !session.repoId && Boolean(session.owner) && session.owner === req.cv.user;
    const { hits: found, semantic } = await search.query(q, {
      limit: 500,
      kinds,
      since,
      allow: (doc) => doc.kind !== "session" || scope.sessionInScope(req, doc.session) || own(doc.session),
    });
    // Whose models the work was done on, over everything that matched -
    // counted before the filter is applied, so that the filter can be
    // undone: a list that showed only the picked provider would be a filter
    // with no way back to the others. The count is of sessions, which is
    // what the rows are; a session that called two vendors is counted under
    // both, because "was any of this done on Anthropic" is the question a
    // person asks of a filter, and a session that spent half its turns
    // there answers yes.
    const providers = providerFacets(found);
    // A connector, a tool or a skill is on no provider, so picking one shows
    // sessions alone - the catalogue is what an agent could reach for next,
    // not something anybody ran on a vendor's model.
    const matched = provider ? found.filter((hit) => providersOf(hit.doc).includes(provider)) : found;
    // The catalogue is timeless; the histogram is of the sessions.
    const timed = matched.filter((hit) => hit.doc.kind === "session");
    const hits = matched.filter((hit) => hit.doc.kind !== "session" || within(hit.doc.at)).slice(0, limit);
    res.json({
      query: q,
      range,
      from,
      to,
      provider,
      providers,
      total: matched.length,
      histogram: histogram(timed, { since, now, at: (hit) => hit.doc.at }),
      hits: hits.map(({ doc, score, terms, semantic: byMeaning, snippet }) => {
        const words = doc.kind !== "session" || scope.mayReadWords(doc.session, req.cv.user);
        const session = doc.session
          ? {
              id: doc.session.id,
              actor: { id: doc.session.actor?.id ?? null, name: doc.session.actor?.name ?? null },
              state: doc.session.state,
              startedAt: doc.session.startedAt,
              endedAt: doc.session.endedAt,
              repoName: doc.session.repoId ? repos.repos.get(doc.session.repoId)?.name ?? null : null,
              // The repository by name, and whether it is one of this
              // workspace's repos - a hit on work in a repository nobody
              // connected here says so on the row (console-search.js), the
              // way the listings do.
              repository: doc.session.repo?.fullName ?? null,
              where: scope.whereOfSession(req, doc.session),
              outcome: performance.outcomeOf(doc.session, []),
            }
          : null;
        return {
          id: doc.id,
          kind: doc.kind,
          name: doc.name ?? null,
          title: words ? doc.title || null : null,
          snippet: words ? snippet : null,
          at: doc.at,
          tools: doc.tools,
          connectors: doc.connectors,
          skills: doc.skills,
          models: doc.models ?? [],
          providers: (doc.providers ?? []).map((id) => ({ id, label: models.PROVIDERS[id]?.label ?? id })),
          session,
          score,
          why: { terms, semantic: byMeaning },
        };
      }),
      semantic,
      ...search.describe(),
    });
  }));

  /**
   * Search's answer: the same search, then the installation's model reads
   * what it found and says how the thing was done, citing the sessions and
   * tools it read (discover-agent.js). Asked for, not given: the page calls
   * this when somebody presses Explain, or on every search for somebody who
   * has said they always want it - a model call costs, and most searches
   * are answered by the list. `history` continues one as a chat. The asker's rules go in with the
   * question: which sessions they may see, and which they may read the
   * words of. No model key is an answer of null with the reason, and the
   * page shows the hits alone.
   */
  app.post("/api/search/answer", requireUser, wrap(async (req, res) => {
    const q = String(req.body?.q ?? "").trim().slice(0, 500);
    if (!q) return res.status(400).json({ error: "Ask something first." });
    // The chat so far, sent back up by the page: this is a conversation held
    // in the browser, not a thing the server keeps, so a follow-up carries
    // what it is following up on. Turns without both halves are dropped, and
    // only the last few are read (discover-agent.js turnsOf).
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    const own = (session) => !session.repoId && Boolean(session.owner) && session.owner === req.cv.user;
    try {
      const result = await discoverAgent.answer(q, {
        owner: req.cv.user,
        history,
        allow: (doc) => doc.kind !== "session" || scope.sessionInScope(req, doc.session) || own(doc.session),
        mayRead: (session) => scope.mayReadWords(session, req.cv.user),
      });
      res.json({ query: q, ...result });
    } catch (err) {
      // The model's refusal is a line on the panel, not a failed page.
      res.json({ query: q, answer: null, why: `Could not work out an answer: ${err.message}` });
    }
  }));

  /**
   * Search the trail: fuzzy over the words of every entry - a tool, a
   * permission, an agent, a person, a state - and only that; no meaning, no
   * answer. The hits come back newest-first within their score, with the
   * histogram of every match in the range and the sums of them, and
   * `from`/`to` narrow the list to one bar. Nothing typed is the whole
   * trail, newest first.
   */
  app.get("/api/search/trail", requireViewer, wrap(async (req, res) => {
    const q = String(req.query.q ?? "").trim().slice(0, 300);
    const { now, range, since, from, to, within } = searchRange(req);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const { entries, readable } = scope.trailInScope(req, since);
    const matches = q
      ? accessTrail.fuzzy(q, entries, { limit: entries.length })
      : entries.map((entry) => ({ entry, score: null, matched: [] }));
    const listed = matches.filter((hit) => within(hit.entry.at)).slice(0, limit);
    res.json({
      query: q,
      range,
      from,
      to,
      total: matches.length,
      histogram: histogram(matches, { since, now, at: (hit) => hit.entry.at, series: (hit) => accessTrail.seriesOf(hit.entry) }),
      stats: accessTrail.stats(matches.map((hit) => hit.entry)),
      hits: listed.map((hit) => ({ ...describeEntry(hit.entry, readable), score: hit.score, matched: hit.matched })),
      indexed: { entries: entries.length, reach: spans.recent({ since }).reach },
    });
  }));

  /**
   * What the open workspace has been used for over a range: the sessions,
   * the calls and what they cost, the tools and connectors reached for
   * most, the trail's sums (usage-stats.js), and the tool calls over time
   * - the same histogram the searches draw, over every call in the range.
   */
  app.get("/api/search/stats", requireViewer, wrap(async (req, res) => {
    const { now, range, since } = searchRange(req, { fallback: "7d" });
    const sessions = await scope.sessionsInScope(req, { since, limit: 2000 });
    const { spans: records, reach } = scope.spansInScope(req, since);
    const { entries } = scope.trailInScope(req, since);
    const calls = records.filter((span) => span.name === "tool.call" && span.attrs?.["cv.tool.name"]);
    res.json({
      range,
      since,
      reach,
      ...usage({ sessions, spans: records, entries }),
      histogram: histogram(calls, { since, now, series: (span) => (span.ok === false ? "stopped" : "allowed") }),
    });
  }));
}
