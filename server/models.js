// The models an agent may think with, and who serves each.
//
// There was one model, one provider and one key, and all three were the
// installation's. Now the model is the agent's choice and the key is its
// owner's: `OPENAI_API_KEY` is a secret like any other on the Secrets page,
// and an agent thinking with GPT is an agent whose owner put one there. The
// installation's `ANTHROPIC_API_KEY` stays as what an agent gets when its
// owner has said nothing - so nothing that worked before this stops.
//
// A model id decides its provider. The catalogue below is what the picker
// offers; an id not in it is still accepted and placed by its name, because
// providers ship models faster than this file is edited and a person who
// knows the id should not have to wait for a deploy to use it.
//
// **Gateways.** Two of the providers are not model vendors but doors to
// many: OpenRouter, a hosted one, and LiteLLM, a proxy an engineer runs
// themselves with their own keys and routing behind it. Both speak Chat
// Completions, so the translation that serves OpenAI serves them; what is
// different is the model id - `openrouter/<vendor>/<model>` and
// `litellm/<whatever the proxy calls it>`, the prefix saying which door
// and stripped at it - and that the door reports back what the call
// cost, exactly, which this app records in place of a catalogue price.
// A call through either is stamped so it can be found on the other side:
// the `user` field names the agent, the request carries `traceparent`
// (LiteLLM's own OpenTelemetry joins it to this app's trace), and the
// gateway's generation id is kept on the span.
import { publicOrigin } from "./public-url.js";

/**
 * Somebody's own keys, asked for when a key is wanted and not before.
 *
 * The secret store is the connector store underneath, and a catalogue of
 * models is read on pages that will never make a call. An installation
 * whose keys are all in the environment never loads it at all.
 */
const secrets = () => import("./secrets.js");

/** How to reach each provider, and what its key is called on the Secrets page. */
export const PROVIDERS = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    secret: "ANTHROPIC_API_KEY",
    dialect: "anthropic",
    upstream: () => (process.env.ANTHROPIC_BASE_URL_UPSTREAM ?? "https://api.anthropic.com").replace(/\/+$/, ""),
    envKey: () => process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? null,
    // How its model ids start, for an id the catalogue does not list. Sent
    // to the picker too, so it places a typed-in name the way the proxy will.
    family: /^claude/,
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    secret: "OPENAI_API_KEY",
    dialect: "openai",
    upstream: () => (process.env.OPENAI_BASE_URL_UPSTREAM ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
    envKey: () => process.env.OPENAI_API_KEY ?? null,
    // The newer models refuse `max_tokens` and want this instead.
    maxTokensField: "max_completion_tokens",
    family: /^(gpt|o\d|chatgpt|text-|codex)/,
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    secret: "GEMINI_API_KEY",
    // Google's OpenAI-compatible endpoint, which speaks tools and streaming
    // the same way OpenAI does - so one translation covers both.
    dialect: "openai",
    upstream: () =>
      (process.env.GEMINI_BASE_URL_UPSTREAM ?? "https://generativelanguage.googleapis.com/v1beta/openai").replace(
        /\/+$/,
        "",
      ),
    envKey: () => process.env.GEMINI_API_KEY ?? null,
    maxTokensField: "max_tokens",
    family: /^(gemini|gemma)/,
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    secret: "OPENROUTER_API_KEY",
    dialect: "openai",
    gateway: true,
    upstream: () => (process.env.OPENROUTER_BASE_URL_UPSTREAM ?? "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
    envKey: () => process.env.OPENROUTER_API_KEY ?? null,
    maxTokensField: "max_tokens",
    // Its ids are already `<vendor>/<model>`; ours put the door in front.
    family: /^openrouter\//,
    prefix: "openrouter/",
    // What OpenRouter shows a call as coming from, on its own activity
    // page - so a bill there can be read against this app.
    headers: () => ({ "HTTP-Referer": publicOrigin(null) ?? "https://codervibes.app", "X-Title": "CoderVibes" }),
    // Asked to say what the call cost; it answers in dollars on `usage`.
    shape: (out) => {
      out.usage = { include: true };
    },
    reported: (reply) => ({
      generation: reply?.id ?? null,
      cents: Number.isFinite(Number(reply?.usage?.cost)) ? Number(reply.usage.cost) * 100 : null,
    }),
  },
  litellm: {
    id: "litellm",
    label: "LiteLLM",
    secret: "LITELLM_API_KEY",
    dialect: "openai",
    gateway: true,
    // No default: a LiteLLM proxy is somebody's own, at an address only
    // they know. Unset, the provider is here to be named in a refusal.
    upstream: () => (process.env.LITELLM_BASE_URL ?? "").replace(/\/+$/, "") || null,
    envKey: () => process.env.LITELLM_API_KEY ?? null,
    maxTokensField: "max_tokens",
    family: /^litellm\//,
    prefix: "litellm/",
    // Tags the proxy keeps on the call, for its own spend reports.
    shape: (out, { agent, repo }) => {
      out.metadata = { tags: ["codervibes", agent ? `agent:${agent}` : null, repo ? `repo:${repo}` : null].filter(Boolean) };
    },
    // What it cost is a response header, in dollars.
    reported: (reply, headers) => {
      const raw = headers?.get?.("x-litellm-response-cost");
      const cost = raw == null || raw === "" ? NaN : Number(raw);
      return { generation: reply?.id ?? null, cents: Number.isFinite(cost) ? cost * 100 : null };
    },
  },
};

/**
 * The id a gateway is asked for: ours without the door's prefix. Any other
 * provider gets the id as it came.
 */
export const upstreamModel = (provider, modelId) =>
  provider?.prefix && String(modelId ?? "").toLowerCase().startsWith(provider.prefix)
    ? String(modelId).slice(provider.prefix.length)
    : modelId;

/**
 * Why a provider cannot be reached, or null - for the one whose address is
 * the installation's to set. Said where the key is said (inference.js),
 * before anything is sent, and on the picker beside the model.
 */
export function whyUnreachable(provider) {
  if (provider?.id === "litellm" && !provider.upstream()) {
    return "LITELLM_BASE_URL is not set, so there is no LiteLLM proxy to send the call to. Set it to the proxy's address (with /v1) and restart.";
  }
  return null;
}

/**
 * What the picker offers. `note` is the one line beside the name: what the
 * model is for, not its spec sheet.
 *
 * `price` is what the provider charges, in cents per million tokens of each
 * of the four kinds - see costs.js on why the four are kept apart. These
 * are the published list prices on the day in PRICES_CHECKED; a number in a
 * source file goes quietly wrong when a provider moves, which is what
 * CODERVIBES_PRICES is for (`priceOf`). A model with no price is counted
 * and not priced, never priced by a guess: "we do not know" and "$0.00"
 * are different answers and only one of them is safe to act on.
 *
 * OpenAI and Gemini have no cache write rate - a prompt that becomes a
 * cache entry is billed as ordinary input - so `cacheWrite` is the input
 * rate there, and the translated usage never has one anyway
 * (model-dialects.js).
 */
export const PRICES_CHECKED = "2026-09-02";

const cents = (input, output, cacheRead, cacheWrite = input) => ({ input, output, cacheRead, cacheWrite });

export const MODELS = [
  { id: "claude-fable-5", provider: "anthropic", label: "Claude Fable 5", note: "most capable", price: null },
  { id: "claude-opus-5", provider: "anthropic", label: "Claude Opus 5", note: "strong on long tasks; five times Sonnet's price", price: cents(1500, 7500, 150, 1875) },
  { id: "claude-sonnet-5", provider: "anthropic", label: "Claude Sonnet 5", note: "the default; fast and capable", price: cents(300, 1500, 30, 375) },
  { id: "claude-haiku-4-5-20251001", provider: "anthropic", label: "Claude Haiku 4.5", note: "cheapest; quick chores", price: cents(100, 500, 10, 125) },
  // The ones the shipped proxy serves (deploy/litellm/config.yaml), under
  // the names it serves them by - #86 renamed the aliases to what the vendor
  // actually runs, and the catalogue was left behind, so this file offered
  // `gpt-5` and `gemini-2.5-pro` and the proxy answered "no healthy
  // deployments" to both. `price: null` rather than a number carried over
  // from the model that used to wear the name: this file's own rule is that
  // a guess is worse than "we do not know", and a call routed through the
  // proxy is billed by what the proxy reports for it anyway (the `litellm`
  // provider reads `x-litellm-response-cost`). CODERVIBES_PRICES sets them
  // without a deploy; the deploy test holds the two files together.
  //
  // Kimi is not here: the proxy serves `kimi-k2.6`, but this app has no
  // Moonshot door of its own (no entry in PROVIDERS), so it is reached the
  // way anything else behind the proxy is - `litellm/kimi-k2.6`.
  { id: "gpt-4o", provider: "openai", label: "GPT-4o", note: "OpenAI's general model", price: null },
  { id: "gpt-4o-mini", provider: "openai", label: "GPT-4o mini", note: "cheaper, quicker", price: null },
  { id: "gpt-4.1", provider: "openai", label: "GPT-4.1", note: "long context, steady", price: cents(200, 800, 50) },
  { id: "o3", provider: "openai", label: "o3", note: "reasoning", price: cents(200, 800, 50) },
  { id: "o4-mini", provider: "openai", label: "o4-mini", note: "reasoning, cheaper", price: cents(110, 440, 27.5) },
  { id: "gemini-3.1-pro-preview", provider: "gemini", label: "Gemini 3.1 Pro", note: "Google's flagship", price: null },
  { id: "gemini-3.6-flash", provider: "gemini", label: "Gemini 3.6 Flash", note: "fast", price: null },
  // The doors. One entry each so the picker shows the form of the id; the
  // rest of what is behind them is typed in. No catalogue price: the
  // gateway says what each call cost and that number is the one kept.
  { id: "openrouter/anthropic/claude-sonnet-4.5", provider: "openrouter", label: "Claude Sonnet 4.5 via OpenRouter", note: "any OpenRouter model as openrouter/<vendor>/<model>; cost from OpenRouter", price: null },
  { id: "litellm/claude-sonnet-5", provider: "litellm", label: "Claude Sonnet 5 via LiteLLM", note: "any model your LiteLLM proxy names, as litellm/<name>; cost from the proxy", price: null },
];

/** The four rates, or null; a rate that is not a non-negative number is no rate. */
function ratesIn(raw) {
  if (!raw || typeof raw !== "object") return null;
  const rate = (value) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null);
  const price = { input: rate(raw.input), output: rate(raw.output), cacheRead: rate(raw.cacheRead), cacheWrite: rate(raw.cacheWrite) };
  if (price.cacheWrite == null) price.cacheWrite = price.input;
  return Object.values(price).some((value) => value != null) ? price : null;
}

/**
 * Prices set in the environment, read once.
 *
 * `CODERVIBES_PRICES` is a JSON object of model id to the four rates, and
 * it wins over the catalogue: it is how a moved price is corrected, or a
 * model the catalogue does not list is priced, without a deploy. A key of
 * `*` is the rate for any model with no price of its own, and the older
 * `CODERVIBES_PRICE_{INPUT,OUTPUT,CACHE_READ,CACHE_WRITE}_CENTS_PER_MTOK`
 * still mean that same thing, from when there was one model and one price.
 */
function pricesFromEnv() {
  const set = {};
  const raw = process.env.CODERVIBES_PRICES;
  if (raw) {
    try {
      for (const [id, rates] of Object.entries(JSON.parse(raw))) {
        const price = ratesIn(rates);
        if (price) set[id.toLowerCase()] = price;
      }
    } catch {
      console.warn("warning: CODERVIBES_PRICES is not a JSON object of model id to rates; ignored");
    }
  }
  const legacy = ratesIn({
    input: process.env.CODERVIBES_PRICE_INPUT_CENTS_PER_MTOK,
    output: process.env.CODERVIBES_PRICE_OUTPUT_CENTS_PER_MTOK,
    cacheRead: process.env.CODERVIBES_PRICE_CACHE_READ_CENTS_PER_MTOK,
    cacheWrite: process.env.CODERVIBES_PRICE_CACHE_WRITE_CENTS_PER_MTOK,
  });
  if (legacy && !set["*"]) set["*"] = legacy;
  return set;
}

let envPrices = null;

/**
 * What a model's tokens cost, in cents per million of each kind, or null
 * when nobody has said. The environment first, then the catalogue, then
 * the environment's rate for everything else.
 */
export function priceOf(modelId) {
  envPrices ??= pricesFromEnv();
  const id = String(modelId ?? "").toLowerCase();
  return envPrices[id] ?? MODELS.find((model) => model.id === id)?.price ?? envPrices["*"] ?? null;
}

/** Forget the environment's prices, for a test that sets them. */
export const rereadPrices = () => {
  envPrices = null;
};

/**
 * The model a resident thinks with unless whoever started it said otherwise.
 * Here rather than in resident.js because the registry writes it when a
 * model is cleared on the Settings tab, and the registry is what resident.js
 * imports, not the other way round.
 *
 * Sonnet, not Opus. A resident is a loop that runs for weeks and is woken by
 * every line of chat that names it; most of what it does is small, and the
 * one that was Opus by default spent, with three followers, a hundred
 * dollars in an hour on a team nobody was watching. Opus is a fifth of a
 * click away on the Settings tab for the agent whose work wants it. An
 * agent already started keeps the model on its record.
 */
export const DEFAULT_MODEL = process.env.CODERVIBES_RESIDENT_MODEL ?? "claude-sonnet-5";

/** A model id: what providers accept, and nothing that could be a path or a header. */
const MODEL_ID = /^[a-z0-9][a-z0-9._:/-]{0,119}$/i;

export const isValidModelId = (id) => MODEL_ID.test(String(id ?? ""));

/**
 * Why a model id cannot be given to an agent, or null when it can.
 *
 * Checked where the id is written - the wizard and the Settings tab - and
 * not only where it is used, because a name nobody serves would otherwise
 * be accepted, the agent would boot, and the refusal would turn up as the
 * agent being stuck on its first call. The sentence lists the families so
 * a typo in the box is a one-step fix.
 */
export function whyNotAModel(id) {
  if (!isValidModelId(id)) return "That is not a model id.";
  if (providerOf(id)) return null;
  const examples = Object.keys(PROVIDERS)
    .map((name) => MODELS.find((model) => model.provider === name)?.id)
    .filter(Boolean)
    .join(", ");
  return `Nobody here serves '${String(id).slice(0, 40)}'. An id names one of ${examples} or a newer model from the same family.`;
}

/**
 * Which provider serves a model.
 *
 * The catalogue first; failing that, the name. Every provider's ids start
 * the way its family does, and a new `gpt-6` should reach OpenAI on the day
 * it ships. Null for a name nobody here serves - the caller says so, rather
 * than sending it to Anthropic and passing on a 404 about a model.
 */
export function providerOf(modelId) {
  const id = String(modelId ?? "").toLowerCase();
  const listed = MODELS.find((model) => model.id === id);
  if (listed) return PROVIDERS[listed.provider];
  return Object.values(PROVIDERS).find((provider) => provider.family.test(id)) ?? null;
}

/**
 * The key an agent's calls go out with.
 *
 * Its owner's, from the Secrets page, under the provider's name; failing
 * that the installation's, from the environment. The installation's is how
 * every Anthropic call was paid for before there was a choice, and taking
 * that away would stop every agent that never chose.
 *
 * @returns {Promise<{key: string, from: "secret"|"env"}|null>}
 */
export async function keyFor(provider, owner) {
  if (owner) {
    const value = await (await secrets()).valueOf(owner, provider.secret);
    if (value) return { key: value, from: "secret" };
  }
  const env = provider.envKey();
  return env ? { key: env, from: "env" } : null;
}

/** The sentence for the agent's page when there is no key at all. */
export const noKeyMessage = (provider) =>
  `No ${provider.secret} to call ${provider.label} with. ` +
  `Add one on the Secrets page under that exact name, then restart the agent.`;

/**
 * The catalogue, with which providers this person can use today.
 *
 * `configured` is whether a call would have a key - theirs or the
 * installation's - so the picker can say "no OPENAI_API_KEY yet" beside the
 * models it cannot run rather than letting somebody find out from a stuck
 * agent.
 */
export async function catalogFor(user, { defaultModel } = {}) {
  const providers = {};
  for (const provider of Object.values(PROVIDERS)) {
    const own = user ? await (await secrets()).has(user, provider.secret) : false;
    providers[provider.id] = {
      id: provider.id,
      label: provider.label,
      secret: provider.secret,
      family: provider.family.source,
      gateway: Boolean(provider.gateway),
      // A key is not enough for a door with no address behind it.
      configured: (own || Boolean(provider.envKey())) && !whyUnreachable(provider),
      unreachable: whyUnreachable(provider),
      // Whose key it would be - so the page can say "the installation's"
      // without pretending the person put one there.
      keyFrom: own ? "secret" : provider.envKey() ? "env" : null,
    };
  }
  return { models: MODELS, providers, default: defaultModel ?? null };
}

/**
 * What a provider key is used by, for the Secrets page's `usedBy` column:
 * the models it pays for. Not a reason to refuse deleting it - an agent
 * without a key becomes a stuck agent that says so, which is recoverable in
 * a way a refused deletion of an expired key is not.
 */
export function usersOf(secretName) {
  const provider = Object.values(PROVIDERS).find((entry) => entry.secret === secretName);
  return provider ? [`${provider.label} models`] : [];
}
