// Discover: one search over what this installation has seen - the sessions,
// with what was asked, what was said and what was reached for, and the
// catalogue of connectors, tools and skills an agent could reach for next.
//
// The question it answers is "how did we do X?", asked by a person on the
// Discover page or by an agent through the `discover` tool before it goes
// looking on its own: "how do I trigger a deploy" should land on the session
// that ran fly_deploy from an e2b sandbox last week, and on the Fly
// connector's page beside it.
//
// Two indexes, one answer. The lexical one is BM25 over the words - tool
// and connector names are strong tokens, so a query that says "deploy"
// finds fly_deploy whether or not anybody wrote the word - and it costs
// nothing to keep. The semantic one is a vector per document, made through
// the installation's LiteLLM proxy (an embeddings model behind it; there is
// no Anthropic embeddings model), so that "ship it to prod" finds the same
// session. They are fused by reciprocal rank, which needs no tuning across
// two scores that mean different things. Without a proxy, or one without
// an embeddings model, the semantic half is off and the page says so; the
// lexical half is always on.
//
// Both live in this process, on purpose. At this installation's size - a
// month of sessions, a few tens of kilobytes of text each - an in-process
// index answers in milliseconds and costs no service to run, back up or
// port (docs/portability.md). The one thing to keep is the seam: `index`,
// `remove`, `query`, and the document shape, so that a search service can
// stand behind the same three calls when the index outgrows the process.
// docs/search.md says at what size that is, and how the move goes.
//
// Text is a session's words, and the words rule applies (sessions.js, the
// essay): the index holds every session's text, and the caller says, per
// query, which documents the asker may see and which of those they may
// read the words of. A hit the asker may see but not read comes back as
// who was working and what was reached for, with no title and no snippet.
import * as sessionLog from "./sessions.js";
import * as sessionEvents from "./session-events.js";
import * as spans from "./spans.js";
import { PROVIDERS, providerOf } from "./models.js";

/** What a document is: a session, or one of the catalogue's three kinds. */
export const KINDS = ["session", "connector", "tool", "skill"];

/** How far back sessions are indexed at boot - the sessions' month, and the events'. */
export const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The embeddings model, by the name the proxy knows it under. OpenAI's small
 * model by default, at 256 dimensions - it supports being asked for fewer,
 * and a quarter of the size is a twentieth of the memory at the same
 * ranking for this kind of text. A model that ignores `dimensions` answers
 * with its own, and the index takes what it is given.
 */
export const EMBEDDING_MODEL = () => (process.env.CODERVIBES_EMBEDDING_MODEL ?? "").trim() || "text-embedding-3-small";
export const EMBEDDING_DIMS = 256;

/** How much of a document goes to the lexical index, and how much to the embedder. */
export const MAX_TEXT = 20_000;
export const MAX_EMBED_TEXT = 6_000;
/** How long after a session's last event its document is rebuilt. */
export const SETTLE_MS = 3_000;
/** How many candidates each index contributes before fusion. */
const CANDIDATES = 200;
/** Reciprocal rank fusion's constant: the usual 60. */
const RRF_K = 60;
/**
 * What a kind of document is worth against the others at the same rank.
 * The question is "how did we do X", and the answer is the session that
 * did it; the catalogue entry that could do it is shown beside it, not
 * above it - which BM25 alone would do, since a two-line tool description
 * that says "deploy" twice outscores a long transcript that said it once.
 */
const PRIOR = { session: 1, connector: 0.6, tool: 0.6, skill: 0.6 };

// ------------------------------------------------------------------ words

// Words a query is full of that say nothing about which document.
const STOP = new Set(
  "the a an and or of to in on for is it its this that these those with as at by be was were are from how do does did i we you my our your can could would should what which when where why who whom there here then than so if not no yes me us them they he she his her".split(" "),
);

/** A light stem: plurals and the two verb endings, so "deployed" and "deploys" are "deploy". */
export function stem(word) {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/**
 * The words of a text, as the index counts them: lower-cased, split on
 * anything that is not a letter or digit - so `fly_deploy` is "fly" and
 * "deploy" and `e2b_start_agent` is three words - with camelCase split the
 * same way, stop words dropped, and the light stem applied.
 */
export function tokenize(text) {
  const out = [];
  const spaced = String(text ?? "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  for (const raw of spaced.split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

// ---------------------------------------------------------------- lexical

/** BM25 over an inverted index: term -> (doc -> count), with the usual constants. */
class Lexical {
  constructor() {
    this.postings = new Map();
    this.lengths = new Map();
    this.totalLength = 0;
  }
  add(id, tokens) {
    this.remove(id);
    const counts = new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    for (const [term, count] of counts) {
      let posting = this.postings.get(term);
      if (!posting) this.postings.set(term, (posting = new Map()));
      posting.set(id, count);
    }
    this.lengths.set(id, tokens.length);
    this.totalLength += tokens.length;
  }
  remove(id) {
    const length = this.lengths.get(id);
    if (length == null) return;
    for (const [term, posting] of this.postings) {
      posting.delete(id);
      if (!posting.size) this.postings.delete(term);
    }
    this.lengths.delete(id);
    this.totalLength -= length;
  }
  get size() {
    return this.lengths.size;
  }
  /** The documents scoring for these tokens, best first, with the terms each matched. */
  search(tokens, limit) {
    const N = this.lengths.size;
    if (!N || !tokens.length) return [];
    const avg = this.totalLength / N;
    const k1 = 1.2;
    const b = 0.75;
    const scores = new Map();
    const matched = new Map();
    for (const term of new Set(tokens)) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      const idf = Math.log(1 + (N - posting.size + 0.5) / (posting.size + 0.5));
      for (const [id, tf] of posting) {
        const length = this.lengths.get(id) ?? avg;
        const part = idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * length) / avg)));
        scores.set(id, (scores.get(id) ?? 0) + part);
        if (!matched.has(id)) matched.set(id, new Set());
        matched.get(id).add(term);
      }
    }
    return [...scores]
      .sort((x, y) => y[1] - x[1])
      .slice(0, limit)
      .map(([id, score]) => ({ id, score, terms: [...matched.get(id)] }));
  }
}

// ---------------------------------------------------------------- vectors

/** A unit vector from any array of numbers. */
export function normalize(values) {
  const out = Float32Array.from(values, Number);
  let sum = 0;
  for (const value of out) sum += value * value;
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < out.length; i += 1) out[i] /= norm;
  return out;
}

/**
 * A vector as a session record keeps it: one signed byte per dimension,
 * base64. A quarter of a float's bytes, and ranking on unit vectors is not
 * told the difference - and it is what lets a month of vectors sit on the
 * records they belong to rather than in a store of their own.
 */
export function pack(vector) {
  const bytes = new Int8Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) bytes[i] = Math.max(-127, Math.min(127, Math.round(vector[i] * 127)));
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}
export function unpack(packed) {
  const buffer = Buffer.from(String(packed ?? ""), "base64");
  const bytes = new Int8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return normalize(Array.from(bytes, (byte) => byte / 127));
}

/** Unit vectors by document, searched by brute force - milliseconds up to the hundreds of thousands. */
class Vectors {
  constructor() {
    this.byId = new Map();
  }
  add(id, vector) {
    this.byId.set(id, vector);
  }
  remove(id) {
    this.byId.delete(id);
  }
  get size() {
    return this.byId.size;
  }
  search(query, limit) {
    const out = [];
    for (const [id, vector] of this.byId) {
      if (vector.length !== query.length) continue;
      let dot = 0;
      for (let i = 0; i < query.length; i += 1) dot += query[i] * vector[i];
      out.push({ id, score: dot });
    }
    return out.sort((x, y) => y.score - x.score).slice(0, limit);
  }
}

// --------------------------------------------------------------- embedder

/**
 * The embedder: texts in, unit vectors out, through the installation's
 * LiteLLM proxy on the installation's own key (models.js). Null when there
 * is no proxy, and `whyNoSemantic` says why. A proxy that refuses the model
 * is remembered and said the same way, until it answers.
 */
let customEmbedder = null;
let lastRefusal = null;

async function proxyEmbed(texts, { fetch: doFetch = fetch } = {}) {
  const base = PROVIDERS.litellm.upstream();
  const key = PROVIDERS.litellm.envKey();
  const response = await doFetch(`${base}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: EMBEDDING_MODEL(), input: texts, dimensions: EMBEDDING_DIMS, encoding_format: "float" }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const why = (await response.text().catch(() => "")).slice(0, 300);
    const refusal = new Error(`the proxy answered ${response.status} to ${EMBEDDING_MODEL()}: ${why || response.statusText}`);
    refusal.status = response.status;
    throw refusal;
  }
  const body = await response.json();
  const rows = Array.isArray(body?.data) ? [...body.data].sort((x, y) => (x.index ?? 0) - (y.index ?? 0)) : [];
  if (rows.length !== texts.length) throw new Error(`the proxy answered ${rows.length} vectors for ${texts.length} texts`);
  return rows.map((row) => normalize(row.embedding ?? []));
}

export function embedder() {
  if (customEmbedder) return customEmbedder;
  if (!PROVIDERS.litellm.upstream() || !PROVIDERS.litellm.envKey()) return null;
  return { model: EMBEDDING_MODEL(), embed: proxyEmbed };
}

/** Why the semantic half is off, as a sentence, or null when it is on. */
export function whyNoSemantic() {
  if (embedder()) return lastRefusal;
  if (!PROVIDERS.litellm.upstream()) {
    // What to set, not where to press: this sentence is read on an
    // installation whose console has a Connectors page and on one that has
    // no such page at all (server/local.js), and a page that does not exist
    // is worse advice than none.
    return "Semantic search needs an embeddings model, and this installation has no LiteLLM proxy (LITELLM_BASE_URL is not set). Word search is on; pointing that at a proxy that can embed turns the other half on.";
  }
  return "Semantic search needs the proxy's key: LITELLM_API_KEY is not among the installation secrets. Word search is on.";
}

/**
 * Embed, remembering a refusal so the page can say it; null when it cannot
 * be done.
 *
 * Two things this is careful about, both learned from production.
 *
 * **Nothing empty goes up.** An embeddings model refuses an empty input -
 * "Invalid 'input[0]': input cannot be an empty string" - and a document
 * with neither a title nor any text is one this installation has plenty of
 * (an unnamed session that recorded only a tool name). There is no vector
 * for "nothing", so there is nothing to ask for.
 *
 * **One document's refusal is not the installation's news.** `lastRefusal`
 * is what `whyNoSemantic` reports to every reader, so a 400 - which is the
 * proxy complaining about what it was sent - would turn the semantic half
 * off for everybody and tell them to go and edit a config file that is
 * perfectly correct. Only a refusal about the installation (no key, no such
 * model, the proxy down) is worth saying; a 400 skips that document and
 * leaves the rest of the index alone.
 */
async function embed(texts) {
  const who = embedder();
  if (!who) return null;
  if (!texts.length || texts.some((text) => !String(text ?? "").trim())) return null;
  try {
    const vectors = await who.embed(texts);
    lastRefusal = null;
    return vectors;
  } catch (err) {
    if (err.status !== 400) {
      lastRefusal = `Semantic search is off: ${err.message}. Word search is on; add ${EMBEDDING_MODEL()} to the proxy's model list (deploy/litellm/config.yaml), or name another with CODERVIBES_EMBEDDING_MODEL.`;
    }
    return null;
  }
}

// -------------------------------------------------------------- documents

/**
 * A document, as `index` takes it:
 *
 *   { id, kind, title, text, at, tools, connectors, skills,
 *     models, providers,  what a session called, and whose those models are
 *     session: { id, owner, repoId, actor, state, startedAt, endedAt } | null,
 *     name }            the catalogue entry's own id, for its page
 *
 * and, once indexed, what the index added: `vector` when it has one.
 */
const docs = new Map();
const lexical = new Lexical();
const vectors = new Vectors();
/** Query vectors, by query: a person refining a search asks the proxy once per wording. */
const queryVectors = new Map();

/**
 * The harness's own name for a tool this app renames, by the name this app
 * uses - the inverse of telemetry-ingest.js `TOOL_NAMES`.
 *
 * A call is recorded under this app's name for it (`Bash` is
 * `run_command` everywhere, so that a Claude Code session and a Codex one
 * are counted on one row), and that was the only name the index held. But
 * the name a person types into Search is the one their agent showed them:
 * searching for `Bash` found nothing at all, on an installation whose
 * every session had run one. Both names are words of a document now; only
 * this app's is on the row, since two chips for one call reads as two
 * calls. test/search.test.js checks this is still the inverse of that
 * table - a tool renamed there and not here goes quietly unfindable
 * again.
 */
export const HARNESS_NAMES = {
  read_file: ["Read"],
  edit_file: ["Edit", "MultiEdit", "NotebookEdit"],
  write_file: ["Write"],
  run_command: ["Bash"],
  search: ["Glob", "Grep"],
  list_dir: ["LS"],
  web_fetch: ["WebFetch"],
  web_search: ["WebSearch"],
  subagent: ["Task", "Agent"],
  todo: ["TodoWrite"],
};

function tokensOf(doc) {
  // The models a session called are words too: "opus" and "gemini" are how
  // a person asks for the work done on one, and neither name is anywhere
  // in a transcript - the harness reports the id, and nobody types it. So
  // are the harness's own names for the tools, for the same reason: what
  // was on screen is what gets typed into a search box.
  const tools = doc.tools ?? [];
  const asTyped = tools.flatMap((tool) => HARNESS_NAMES[tool] ?? []);
  return tokenize([doc.title, doc.text, ...tools, ...asTyped, ...(doc.connectors ?? []), ...(doc.skills ?? []), ...(doc.models ?? []), ...(doc.providers ?? [])].filter(Boolean).join("\n"));
}

/** What the embedder reads of a document: the head of it, where the ask and the names are. */
function embedTextOf(doc) {
  return [doc.title, doc.text].filter(Boolean).join("\n").slice(0, MAX_EMBED_TEXT);
}

/**
 * Put a document in, replacing one of the same id. `vector` on the document
 * is taken as is (a stored one, or a test's); otherwise, when asked to,
 * one is made through the embedder, and `onVector` hears it so the caller
 * can keep it. Returns once the words are indexed; the vector may follow.
 */
export async function index(doc, { embed: wanted = false, onVector = null } = {}) {
  if (!doc?.id || !KINDS.includes(doc.kind)) throw new Error("A document needs an id and one of the four kinds.");
  const kept = {
    ...doc,
    title: String(doc.title ?? "").slice(0, 300),
    text: String(doc.text ?? "").slice(0, MAX_TEXT),
    tools: [...new Set(doc.tools ?? [])],
    connectors: [...new Set(doc.connectors ?? [])],
    skills: [...new Set(doc.skills ?? [])],
    models: [...new Set(doc.models ?? [])],
    providers: [...new Set(doc.providers ?? [])],
    at: Number(doc.at) || 0,
  };
  docs.set(kept.id, kept);
  lexical.add(kept.id, tokensOf(kept));
  if (kept.vector) {
    vectors.add(kept.id, kept.vector);
    return kept;
  }
  vectors.remove(kept.id);
  if (wanted && embedder()) {
    const [vector] = (await embed([embedTextOf(kept)])) ?? [];
    // The document may have been replaced while the proxy answered.
    if (vector && docs.get(kept.id) === kept) {
      kept.vector = vector;
      vectors.add(kept.id, vector);
      onVector?.(vector);
    }
  }
  return kept;
}

export function remove(id) {
  docs.delete(id);
  lexical.remove(id);
  vectors.remove(id);
}

export const get = (id) => docs.get(id) ?? null;

/** What the page says of the index: how much is in it, and whether the semantic half is on. */
export function describe() {
  const counts = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
  for (const doc of docs.values()) counts[doc.kind] += 1;
  return {
    indexed: counts,
    vectors: vectors.size,
    semantic: { on: Boolean(embedder()) && !lastRefusal, model: embedder()?.model ?? null, why: whyNoSemantic() },
  };
}

// ---------------------------------------------------------------- queries

/**
 * A window of the text around the first of the query's words, for the row
 * - or the head of the text when the hit was semantic and no word matched.
 */
export function snippet(doc, terms, { width = 240 } = {}) {
  const text = String(doc.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  let at = -1;
  for (const term of terms) {
    const found = text.toLowerCase().search(new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  if (at < 0) return text.length > width ? `${text.slice(0, width - 1)}…` : text;
  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(text.length, start + width);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/**
 * Everything indexed, newest first - what the page shows with nothing
 * typed. The same narrowing as a search (`kinds`, `since`, `allow`), and
 * the same shape of hit, so the page draws one list either way; the
 * snippet is the head of the document, since no word was asked for.
 */
function newest({ limit = 20, kinds = null, since = 0, allow = () => true } = {}) {
  const wantedKinds = kinds?.length ? new Set(kinds) : null;
  const found = [];
  for (const doc of docs.values()) {
    if (wantedKinds && !wantedKinds.has(doc.kind)) continue;
    if (since && doc.at && doc.at < since) continue;
    if (!allow(doc)) continue;
    found.push(doc);
  }
  // The sessions first, newest first: what was asked and done here is what
  // a reader has come to see. The catalogue is timeless - its documents are
  // stamped with the moment the catalogue was last read, not with a moment
  // anything happened - so it sorts after them, by name.
  const rank = (doc) => (doc.kind === "session" ? 0 : 1);
  found.sort((one, other) => rank(one) - rank(other) || (rank(one) === 0 ? (other.at ?? 0) - (one.at ?? 0) : String(one.title ?? one.name ?? "").localeCompare(String(other.title ?? other.name ?? ""))));
  return found.slice(0, limit).map((doc) => ({ doc, score: 0, terms: [], semantic: false, snippet: snippet(doc, []) }));
}

/**
 * The best documents for a question. `allow` says which the asker may see
 * at all; `kinds` and `since` narrow the rest. Each hit says how it was
 * found (`why`: the words that matched, and whether the meaning did), so
 * the page can say why a row is there.
 */
export async function query(text, { limit = 20, kinds = null, since = 0, allow = () => true } = {}) {
  const asked = String(text ?? "").trim();
  // Nothing asked is not "nothing found": it is everything, newest first.
  // A reader who has just arrived has set no filter and typed no words, and
  // a page that answers that with an empty list reads as an installation
  // that has recorded nothing. The trail's search has always worked this
  // way; this is the sessions and the catalogue doing the same.
  if (!asked) return { hits: newest({ limit, kinds, since, allow }), semantic: Boolean(embedder()) && !lastRefusal };
  const tokens = tokenize(asked);
  const lexicalHits = lexical.search(tokens, CANDIDATES);
  let semanticHits = [];
  let semantic = false;
  if (embedder() && vectors.size) {
    let vector = queryVectors.get(asked);
    if (!vector) {
      [vector] = (await embed([asked])) ?? [];
      if (vector) {
        queryVectors.set(asked, vector);
        if (queryVectors.size > 500) queryVectors.delete(queryVectors.keys().next().value);
      }
    }
    if (vector) {
      semantic = true;
      semanticHits = vectors.search(vector, CANDIDATES);
    }
  }
  // Reciprocal rank fusion: a document's score is the sum over the lists it
  // is on of 1/(k + its rank there). Two lists of different scales, one
  // order, and a document both halves found rises above one either did.
  const fused = new Map();
  const note = (list, key) => {
    list.forEach((hit, rank) => {
      const entry = fused.get(hit.id) ?? { id: hit.id, score: 0, terms: [], semantic: false, similarity: null };
      entry.score += 1 / (RRF_K + rank + 1);
      if (key === "lexical") entry.terms = hit.terms;
      else {
        entry.semantic = true;
        entry.similarity = hit.score;
      }
      fused.set(hit.id, entry);
    });
  };
  note(lexicalHits, "lexical");
  note(semanticHits, "semantic");
  const wantedKinds = kinds?.length ? new Set(kinds) : null;
  const hits = [];
  for (const entry of fused.values()) entry.score *= PRIOR[docs.get(entry.id)?.kind] ?? 1;
  for (const entry of [...fused.values()].sort((x, y) => y.score - x.score)) {
    const doc = docs.get(entry.id);
    if (!doc) continue;
    if (wantedKinds && !wantedKinds.has(doc.kind)) continue;
    if (since && doc.at && doc.at < since) continue;
    if (!allow(doc)) continue;
    // A semantic-only hit well below the neighbourhood is noise, not a find.
    if (!entry.terms.length && entry.similarity != null && entry.similarity < 0.2) continue;
    hits.push({ doc, score: entry.score, terms: entry.terms, semantic: entry.semantic, snippet: snippet(doc, entry.terms) });
    if (hits.length >= limit) break;
  }
  return { hits, semantic };
}

// ---------------------------------------------------------------- sessions

/**
 * A session as a document: what was asked of it, what it said, and what
 * it reached for - from its log (session-events.js) and its spans - under
 * its name. Prompts first and the last answers last, so that the head the
 * embedder reads is the ask and the names, which is what a question is
 * about, and the tail the row quotes is what came of it.
 */
export function sessionDocument(session, events = [], sessionSpans = []) {
  const asked = [];
  const said = [];
  const calls = [];
  const eventTools = new Set();
  for (const entry of events) {
    switch (entry.kind) {
      case "user_message_chunk":
      case "platform.prompt":
        if (entry.text) asked.push(entry.text);
        break;
      case "agent_message_chunk":
        if (entry.text) said.push(entry.text);
        break;
      case "tool_call":
        // The name and the title both: the hooks write the name on every
        // call (telemetry-ingest.js `toolNameOf`), and a title is a path,
        // a command or the input's fields, which mostly does not say it.
        if (entry.tool && entry.tool !== "tool") eventTools.add(String(entry.tool));
        if (entry.title) calls.push(entry.tool && entry.tool !== "tool" && !entry.title.startsWith(`${entry.tool}:`) ? `${entry.tool}: ${entry.title}` : entry.title);
        break;
      default:
    }
  }
  // What was reached for: the export's spans name tools, connectors and
  // skills; the hooks' call events name tools. A session with hooks and no
  // export used to have no "reached for" at all, so a search by a tool's
  // name found only the sessions whose exporter was set up.
  const tools = new Set(eventTools);
  const connectors = new Set();
  const skills = new Set();
  for (const span of sessionSpans) {
    const attrs = span.attrs ?? {};
    if (attrs["cv.tool.name"]) tools.add(String(attrs["cv.tool.name"]));
    if (attrs["cv.connector.id"]) connectors.add(String(attrs["cv.connector.id"]));
    if (attrs["cv.skill.name"]) skills.add(String(attrs["cv.skill.name"]));
  }
  // What it ran on, and whose that is. A session is stamped with the models
  // it called (sessions.js `count`), and a model id says its vendor
  // (models.js `providerOf`) - so "which of this was done on Anthropic" is
  // answerable without asking every span again.
  const models = [...new Set((session.models ?? []).map((model) => String(model ?? "").trim()).filter(Boolean))];
  const providers = [...new Set(models.map((model) => providerOf(model)?.id).filter(Boolean))];
  const parts = [];
  if (asked.length) parts.push(`Asked: ${asked.join("\n").slice(0, 4000)}`);
  if (tools.size || connectors.size || skills.size) parts.push(`Reached for: ${[...tools, ...connectors, ...skills].join(", ")}`);
  if (calls.length) parts.push(`Calls: ${[...new Set(calls)].slice(0, 60).join("; ")}`);
  if (said.length) parts.push(`Said: ${said.join("\n").slice(-6000)}`);
  return {
    id: `session:${session.id}`,
    kind: "session",
    title: session.title ?? "",
    text: parts.join("\n\n"),
    at: session.startedAt ?? 0,
    tools: [...tools],
    connectors: [...connectors],
    skills: [...skills],
    models,
    providers,
    session: {
      id: session.id,
      owner: session.owner ?? null,
      repoId: session.repoId ?? null,
      // The repository's name too: which workspace a session is in is
      // read off either (index.js `roomsOf`).
      repo: session.repo ?? null,
      // Where it ran, so that a search can be narrowed to one machine
      // (pages/search.js `machine`): a machine's page has nothing to send
      // somebody to otherwise, and "1 session" that cannot be opened is
      // the end of the road rather than the way to the work.
      machine: session.machine ?? null,
      actor: session.actor ?? null,
      state: session.state ?? null,
      startedAt: session.startedAt ?? null,
      endedAt: session.endedAt ?? null,
      pulls: session.pulls ?? null,
    },
  };
}

/**
 * Rebuild one session's document from what is known of it. A stored vector
 * on the record is reused when it is the current model's; otherwise an
 * ended session is embedded and the vector kept on its record, while a
 * live one waits for its end - it is still changing, and embedding every
 * turn would be paying for the same words over and over.
 */
export async function indexSession(sessionId) {
  const session = await sessionLog.get(String(sessionId));
  if (!session) {
    remove(`session:${sessionId}`);
    return null;
  }
  const [events, records] = await Promise.all([
    sessionEvents.since(session.id, 0, { limit: 1000 }).catch(() => []),
    Promise.resolve(spans.forSession(session.id, { limit: 500 })).catch(() => []),
  ]);
  const doc = sessionDocument(session, events, records);
  const model = embedder()?.model ?? null;
  const stored = session.search;
  if (model && stored?.model === model && stored.v) doc.vector = unpack(stored.v);
  const ended = session.state !== "live";
  return index(doc, {
    embed: ended,
    onVector: (vector) => sessionLog.noteSearch(session.id, { model, dims: vector.length, v: pack(vector) }),
  });
}

// A session's document settles a few seconds after its last event, so a
// burst of chunks is one rebuild rather than fifty.
const pending = new Map();
let unsubscribe = null;
let sweeper = null;

export function schedule(sessionId, { settleMs = SETTLE_MS } = {}) {
  const id = String(sessionId);
  const due = Date.now() + settleMs;
  const waiting = pending.get(id);
  // The earlier deadline stands: a burst of events does not push the
  // rebuild back each time (a session streaming for a minute would never
  // settle), and an ask for "now" is not made to wait for one.
  if (waiting && waiting.due <= due) return;
  if (waiting) clearTimeout(waiting.timer);
  const timer = setTimeout(() => {
    pending.delete(id);
    indexSession(id).catch((err) => console.warn(`search: could not index session ${id}: ${err.message}`));
  }, settleMs);
  timer.unref?.();
  pending.set(id, { timer, due });
}

/**
 * Follow the sessions from here: every entry on any session's log schedules
 * that session's rebuild, and once a minute the live ones that have since
 * ended are rebuilt with their vector. Returns a stop.
 */
export function follow({ everyMs = 60_000 } = {}) {
  stop();
  unsubscribe = sessionEvents.subscribe((entry) => schedule(entry.session));
  sweeper = setInterval(() => {
    for (const doc of docs.values()) {
      if (doc.kind === "session" && doc.session?.state === "live" && !sessionLog.isLive(doc.session.id)) schedule(doc.session.id, { settleMs: 0 });
    }
  }, everyMs);
  sweeper.unref?.();
  return stop;
}

export function stop() {
  unsubscribe?.();
  unsubscribe = null;
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
  for (const waiting of pending.values()) clearTimeout(waiting.timer);
  pending.clear();
}

/**
 * Index the month's sessions from the store, a few at a time, in the
 * background: the page works on what is there so far. Returns how many.
 */
export async function warm({ since = Date.now() - KEEP_MS, concurrency = 4 } = {}) {
  let sessions;
  try {
    sessions = await sessionLog.list({ since, limit: 5000 });
  } catch (err) {
    console.warn(`search: could not read the sessions: ${err.message}`);
    return 0;
  }
  const queue = [...sessions];
  let done = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const session = queue.shift();
        try {
          await indexSession(session.id);
          done += 1;
        } catch (err) {
          console.warn(`search: could not index session ${session.id}: ${err.message}`);
        }
      }
    }),
  );
  return done;
}

// --------------------------------------------------------------- catalogue

/**
 * The catalogue: the connectors this installation offers, the tools each
 * of them and the platform itself give an agent, and the skills the
 * sessions have used. Everyone signed in may see all of it - it is what
 * the Connectors and Tools pages show - so these documents carry no
 * session. Replaced whole each time it is read.
 */
export async function indexCatalog({ connectors = [], tools = [], skills = [] } = {}) {
  for (const id of [...docs.keys()]) if (docs.get(id).kind !== "session") remove(id);
  const now = Date.now();
  const jobs = [];
  for (const connector of connectors) {
    const names = (connector.tools ?? []).map((tool) => tool.name);
    jobs.push(
      index({
        id: `connector:${connector.id}`,
        kind: "connector",
        name: connector.id,
        title: connector.label ?? connector.id,
        text: [connector.hint, names.length ? `Tools: ${names.join(", ")}` : null, ...(connector.tools ?? []).map((tool) => `${tool.name}: ${tool.description ?? ""}`)].filter(Boolean).join("\n"),
        tools: names,
        connectors: [connector.id],
        at: now,
      }),
    );
  }
  for (const tool of tools) {
    jobs.push(
      index({
        id: `tool:${tool.name}`,
        kind: "tool",
        name: tool.name,
        title: tool.name,
        text: [tool.description, tool.connector ? `A tool of the ${tool.connectorLabel ?? tool.connector} connector.` : "One of CoderVibes' own tools."].filter(Boolean).join("\n"),
        tools: [tool.name],
        connectors: tool.connector ? [tool.connector] : [],
        at: now,
      }),
    );
  }
  for (const skill of skills) {
    jobs.push(
      index({
        id: `skill:${skill.name}`,
        kind: "skill",
        name: skill.name,
        title: skill.name,
        text: [skill.description ?? `A skill the sessions have used`, skill.sessions ? `Used in ${skill.sessions} session${skill.sessions === 1 ? "" : "s"} lately.` : null].filter(Boolean).join("\n"),
        skills: [skill.name],
        at: now,
      }),
    );
  }
  await Promise.all(jobs);
  return jobs.length;
}

/** For tests. */
export const searchInternals = {
  reset() {
    stop();
    docs.clear();
    lexical.postings.clear();
    lexical.lengths.clear();
    lexical.totalLength = 0;
    vectors.byId.clear();
    queryVectors.clear();
    lastRefusal = null;
    customEmbedder = null;
  },
  /** Stand in for the proxy: `{ model, embed(texts) }`, or null to go back to it. */
  useEmbedder(who) {
    customEmbedder = who;
    lastRefusal = null;
    queryVectors.clear();
  },
  docs,
  proxyEmbed,
};
