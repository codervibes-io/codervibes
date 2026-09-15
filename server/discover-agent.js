// Discover's answer: a small agent that reads what the search found and
// says how the thing was done.
//
// The search (search.js) gets a reader to the right session; it does not
// answer the question. "How do I trigger a deploy" wants a sentence - run
// fly_deploy from a sandbox with the Fly connector's token, the way the
// session of the 7th did - and the reader wants to know which session to
// open to see it done. So the hits go to the installation's own model with
// two tools: `search`, to look again with better words, and `open_session`,
// to read one session in full rather than the quote the row carries. A
// few rounds at most, then it must answer, in prose, citing what it read
// with markers ([session:<id>], [tool:<name>], [connector:<id>]) the page
// turns into links. A citation it did not see is dropped rather than
// shown: the sources are the point, and an invented one is worse than
// none.
//
// The model is the installation's: through its LiteLLM proxy when it has
// one, else the vendor on the installation's own key (models.js), the
// same way its agents' calls go. Without a key there is no answer, and
// the page says so in a line; the hits stand on their own. Every round is
// a model.call span, so the Performance page counts what answering costs.
//
// The words rule holds inside the agent as outside it: the model reads a
// session's words only when the asker may (`mayRead`), and hears of one
// the asker may see but not read as who worked and what they reached for.
import * as search from "./search.js";
import { providerOf, keyFor } from "./models.js";
import { askModel, whyNoModel, houseModel } from "./ask-model.js";
import { withSpan, annotate } from "./telemetry.js";

/** How many times the model may look before it must answer. */
export const MAX_ROUNDS = 4;
/** How many hits a search inside the agent shows it, and how much of a session it may read. */
export const SEARCH_HITS = 8;
export const OPEN_CHARS = 8_000;
const MAX_TOKENS = 1_200;
const TIMEOUT_MS = 45_000;
/** An answer is kept a while: a person refining the question comes back to the same one. */
const CACHE_MS = 10 * 60_000;
const CACHE_MAX = 200;

/**
 * The model that answers: named by the installation, else the default
 * through the proxy when there is one, else the default on the vendor.
 */
export const MODEL = () => (process.env.CODERVIBES_DISCOVER_MODEL ?? "").trim() || houseModel();

/**
 * Why there can be no answer, as a sentence, or null. Said before anything
 * is sent. The check is the shared one (ask-model.js `whyNoModel`); what is
 * added here is what a reader of *this* page should do about it, which is
 * different from what a reader of any other page should.
 */
export async function whyNoAnswers(owner = null) {
  const model = MODEL();
  const blocked = await whyNoModel(model, owner);
  if (!blocked) return null;
  if (blocked.reason === "no-provider") return `No provider here serves '${model}' (CODERVIBES_DISCOVER_MODEL). The hits below are the search's own.`;
  if (blocked.reason === "no-key") return `${blocked.why} Until then Search shows what it found and cannot explain it.`;
  return blocked.why;
}

const SYSTEM = `You answer an engineer's questions about this CoderVibes installation from its own history: the sessions its agents and people ran, and its catalogue of connectors, tools and skills.

You are given the first search's hits. \`search\` again with better words when they miss; \`open_session\` to read one before saying how it was done. Read at most three.

Answer briefly - two or three sentences, prose, no headings or lists. Say what to do, with which tool, and which session did it. Cite inline as [session:ses_abc123], [tool:fly_deploy], [connector:fly], only for what you saw. Never invent one. Nothing in the history: say so in a sentence and suggest other words. Do not explain what the reader can see for themselves.`;

const TOOLS = [
  {
    name: "search",
    description: "Search the sessions and the catalogue again, with other words. Returns hits with their ids, who worked, when, what was reached for, and a quote.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to search for." },
        kind: { type: "string", enum: ["session", "connector", "tool", "skill"], description: "Only this kind. Omit for all." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "open_session",
    description: "Read one session in full: what was asked, what was reached for, the calls made, and what was said. Only a session a hit named.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "The session's id, from a hit (ses_...)." } },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

// ------------------------------------------------------------- the tools

const when = (at) => (at ? new Date(at).toISOString().slice(0, 10) : "");

/** A hit as the model reads it: id first, since the id is what it cites and opens. */
function hitLine(hit, mayRead) {
  const doc = hit.doc;
  if (doc.kind === "session") {
    const words = mayRead(doc.session);
    const who = doc.session.actor?.name ?? doc.session.actor?.id ?? "somebody";
    const reached = [...doc.tools, ...doc.connectors, ...doc.skills];
    return (
      `[session:${doc.session.id}] ${words && doc.title ? `"${doc.title}"` : "(a session whose words you may not read)"} by ${who}, ${when(doc.at)}` +
      `${reached.length ? `; reached for ${reached.slice(0, 10).join(", ")}` : ""}` +
      `${words && hit.snippet ? `\n    ${hit.snippet}` : ""}`
    );
  }
  return `[${doc.kind}:${doc.name}] ${doc.title}${hit.snippet ? `\n    ${hit.snippet}` : ""}`;
}

/** How many turns of the chat the model is given, and how much of each. */
export const MAX_TURNS = 6;
const MAX_TURN_CHARS = 4_000;

/** The chat so far, as pairs the model can be given: whole turns only, the last few. */
export function turnsOf(history) {
  if (!Array.isArray(history)) return [];
  return history
    .map((turn) => ({
      question: String(turn?.question ?? "").trim().slice(0, MAX_TURN_CHARS),
      answer: String(turn?.answer ?? "").trim().slice(0, MAX_TURN_CHARS),
    }))
    .filter((turn) => turn.question && turn.answer)
    .slice(-MAX_TURNS);
}

/**
 * Answer a question. `allow` says which documents the asker may see and
 * `mayRead` which sessions' words they may read - the route's rules,
 * handed in. `hits` are the first search's, when the caller has them.
 */
export async function answer(question, { owner = null, allow = () => true, mayRead = () => true, hits = null, history = [], fetch: doFetch = fetch } = {}) {
  const asked = String(question ?? "").trim();
  if (!asked) return { answer: null, why: "Ask something first." };
  const said = turnsOf(history);
  const cached = fromCache(owner, asked, said);
  if (cached) return cached;
  const why = await whyNoAnswers(owner);
  if (why) return { answer: null, why };
  const model = MODEL();
  const provider = providerOf(model);
  const { key } = await keyFor(provider, owner);

  const seen = new Map();
  const note = (list) => {
    for (const hit of list) seen.set(hit.doc.id, hit.doc);
  };
  const first = hits ?? (await search.query(asked, { limit: SEARCH_HITS, allow })).hits;
  note(first);
  const steps = [];
  const tokens = { input: 0, output: 0 };

  const run = async (name, input) => {
    if (name === "search") {
      const found = await search.query(String(input?.query ?? ""), { limit: SEARCH_HITS, kinds: input?.kind ? [input.kind] : null, allow });
      note(found.hits);
      steps.push({ tool: "search", query: String(input?.query ?? ""), hits: found.hits.map((hit) => hit.doc.id) });
      return found.hits.length ? found.hits.map((hit) => hitLine(hit, mayRead)).join("\n") : "Nothing matched those words.";
    }
    if (name === "open_session") {
      const id = String(input?.id ?? "").trim();
      const doc = seen.get(`session:${id}`);
      if (!doc) return `No hit named session ${id}; open only a session a hit named.`;
      if (!mayRead(doc.session)) return `The asker may not read session ${id}'s words; you know who worked and what they reached for, and no more.`;
      steps.push({ tool: "open_session", id });
      const who = doc.session.actor?.name ?? doc.session.actor?.id ?? "somebody";
      return `Session ${id}: "${doc.title}" by ${who}, ${when(doc.at)}${doc.session.state === "live" ? " (still working)" : ""}\n\n${String(doc.text ?? "").slice(0, OPEN_CHARS)}`;
    }
    return `No tool called ${name}.`;
  };

  // The chat so far, as it was said, then this turn's question and the
  // hits for it. A follow-up ("which of those was fastest?") is only
  // answerable with what was already said, and searching again for the
  // new words is what makes it an answer rather than a guess.
  const messages = [
    ...said.flatMap((turn) => [
      { role: "user", content: turn.question },
      { role: "assistant", content: turn.answer },
    ]),
    {
      role: "user",
      content: `Question: ${asked}\n\nFirst search's hits:\n${first.length ? first.map((hit) => hitLine(hit, mayRead)).join("\n") : "(nothing matched the words; search with other words, or say the history has nothing on it)"}`,
    },
  ];
  const started = Date.now();
  let text = "";
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const last = round === MAX_ROUNDS;
    const reply = await withSpan(
      "model.call",
      { "cv.owner": owner ?? undefined, "cv.model": model, "cv.provider": provider.id, "cv.gateway": provider.gateway ? provider.id : undefined, "cv.tool.kind": "discover" },
      async () => {
        const out = await askModel({
          model,
          system: SYSTEM,
          messages,
          maxTokens: MAX_TOKENS,
          // An empty list on the last round is how the model is told it
          // must answer now rather than look again.
          tools: last ? [] : TOOLS,
          ...(last ? {} : { toolChoice: { type: "auto" } }),
          provider,
          key,
          fetch: doFetch,
          timeoutMs: TIMEOUT_MS,
        });
        annotate({ "cv.tokens.input": out.usage?.input_tokens ?? 0, "cv.tokens.output": out.usage?.output_tokens ?? 0 });
        return out;
      },
    );
    tokens.input += Number(reply.usage?.input_tokens ?? 0);
    tokens.output += Number(reply.usage?.output_tokens ?? 0);
    const content = Array.isArray(reply.content) ? reply.content : [];
    text = content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
    const calls = content.filter((block) => block.type === "tool_use");
    if (!calls.length || last) break;
    messages.push({ role: "assistant", content });
    const results = [];
    for (const call of calls) results.push({ type: "tool_result", tool_use_id: call.id, content: await run(call.name, call.input) });
    messages.push({ role: "user", content: results });
  }

  const citations = citationsIn(text, seen);
  const result = { answer: text || null, why: text ? null : "The model said nothing.", citations, steps, model, tokens, ms: Date.now() - started };
  toCache(owner, asked, said, result);
  return result;
}

/** The markers in an answer that name something the model saw, each once, in order; the rest are dropped. */
export function citationsIn(text, seen) {
  const out = [];
  const had = new Set();
  for (const match of String(text ?? "").matchAll(/\[(session|tool|connector|skill):([^\]\s]+)\]/g)) {
    const id = `${match[1]}:${match[2]}`;
    const doc = seen.get(id);
    if (!doc || had.has(id)) continue;
    had.add(id);
    out.push({ id, kind: doc.kind, name: doc.kind === "session" ? doc.session.id : doc.name, title: doc.title || null });
  }
  return out;
}

// ----------------------------------------------------------------- cache

const cache = new Map();
/** The chat is part of the question: the same words after a different exchange are a different ask. */
const cacheKey = (owner, asked, said = []) => `${owner ?? ""}\n${said.map((turn) => turn.question).join("\n")}\n${asked.toLowerCase()}`;
function fromCache(owner, asked, said) {
  const entry = cache.get(cacheKey(owner, asked, said));
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_MS) {
    cache.delete(cacheKey(owner, asked, said));
    return null;
  }
  return { ...entry.result, cached: true };
}
function toCache(owner, asked, said, result) {
  if (!result.answer) return;
  cache.set(cacheKey(owner, asked, said), { at: Date.now(), result });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

/** For tests. */
export const discoverAgentInternals = {
  reset: () => cache.clear(),
  SYSTEM,
  TOOLS,
};
