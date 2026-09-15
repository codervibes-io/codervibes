// One call to the installation's own model, in the Anthropic shape.
//
// This app asks a model things of its own, beside the work its agents do:
// Discover reads what the search found and says how a thing was done
// (discover-agent.js); the ingest asks what kind of steer a re-prompt was
// (steer-kinds.js). Both want the same three things and neither wants to
// know about them - which provider serves this model id, which key pays
// for it, and whether the provider's door speaks Anthropic's dialect or
// OpenAI's. That was written once inside Discover, and the second caller
// is why it is here instead.
//
// The shape is Anthropic's messages API whatever the provider, because it
// is the one with tool use in it and because the translation the inference
// route already keeps (model-dialects.js) goes that way. A provider whose
// door is OpenAI-shaped - the LiteLLM proxy, OpenAI itself - is translated
// on the way out and back, so a caller writes one body and gets one answer
// however the installation is wired.
//
// `whyNoModel` is asked *before* anything is sent, and it is the difference
// between a feature that is off and a feature that is broken: an
// installation with no key has no answer to give, and the honest thing is
// a sentence saying which key to add, not a stack trace half a second
// later. Callers differ in what they do with it - Discover prints it under
// the hits, the classifier goes quiet - so it comes back as a reason and a
// sentence rather than as a thrown error.
import { providerOf, keyFor, noKeyMessage, upstreamModel, whyUnreachable, DEFAULT_MODEL, PROVIDERS } from "./models.js";
import { toOpenAI, fromOpenAI, errorFromOpenAI } from "./model-dialects.js";

/** How long one call may take. A model that has not answered in this is not going to. */
export const DEFAULT_TIMEOUT_MS = 45_000;

/**
 * The model this app asks its own questions with when nobody has named one:
 * the default through the installation's LiteLLM proxy when there is one,
 * else the default on the vendor. One answer for every such caller, so
 * pointing an installation at a proxy points all of them at it at once.
 */
export const houseModel = () => {
  if (PROVIDERS.litellm.upstream() && PROVIDERS.litellm.envKey()) return `litellm/${DEFAULT_MODEL}`;
  return DEFAULT_MODEL;
};

/**
 * Why this model cannot be called here, or null when it can.
 *
 * @returns {Promise<{reason: "no-provider"|"unreachable"|"no-key", why: string}|null>}
 *   `reason` for a caller deciding what to do; `why` for one printing it.
 */
export async function whyNoModel(model, owner = null) {
  const provider = providerOf(model);
  if (!provider) return { reason: "no-provider", why: `No provider here serves '${model}'.` };
  const unreachable = whyUnreachable(provider);
  if (unreachable) return { reason: "unreachable", why: unreachable };
  const key = await keyFor(provider, owner);
  if (!key) return { reason: "no-key", why: noKeyMessage(provider) };
  return null;
}

/**
 * The provider and the key a call on this model would go out with, or null
 * when there is no such pair. The owner's key first, the installation's
 * after (models.js `keyFor`).
 */
export async function reachFor(model, owner = null) {
  const provider = providerOf(model);
  if (!provider || whyUnreachable(provider)) return null;
  const found = await keyFor(provider, owner);
  return found ? { provider, key: found.key } : null;
}

/**
 * Ask the model once. Returns the Anthropic-shaped answer - `content`
 * blocks and `usage` - whichever dialect the provider actually spoke.
 *
 * `provider` and `key` may be handed in by a caller making several calls in
 * a row, so the key is fetched once rather than once a round; without them
 * they are worked out here from `model` and `owner`, and a model this
 * installation cannot call throws with `whyNoModel`'s sentence.
 *
 * `tools` and `toolChoice` are passed through when given - including an
 * empty tools list, which is how a caller says "this round you must
 * answer". Nothing here retries: a caller that wants a second go knows
 * whether a second go is worth the money.
 */
export async function askModel({
  model,
  system = null,
  messages = [],
  maxTokens = 1024,
  tools = undefined,
  toolChoice = undefined,
  owner = null,
  provider = null,
  key = null,
  fetch: doFetch = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  let reach = provider && key ? { provider, key } : null;
  if (!reach) {
    reach = await reachFor(model, owner);
    if (!reach) throw new Error((await whyNoModel(model, owner))?.why ?? `Cannot call '${model}' here.`);
  }
  const body = {
    model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages,
    ...(tools !== undefined ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
  };
  return complete(body, { ...reach, fetch: doFetch, timeoutMs });
}

/**
 * The call itself: the vendor's own door, or an OpenAI-shaped one behind
 * the same translation the inference route uses, so tools work either way.
 */
async function complete(body, { provider, key, fetch: doFetch = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const model = upstreamModel(provider, body.model);
  if (provider.dialect === "openai") {
    const out = toOpenAI({ ...body, model }, provider);
    const headers = { "content-type": "application/json", authorization: `Bearer ${key}`, ...(provider.headers?.() ?? {}) };
    const upstream = await doFetch(`${provider.upstream()}/chat/completions`, { method: "POST", headers, body: JSON.stringify(out), signal: AbortSignal.timeout(timeoutMs) });
    const text = await upstream.text();
    if (upstream.status >= 400) throw new Error(errorFromOpenAI(upstream.status, text).error.message);
    return fromOpenAI(JSON.parse(text), { model: body.model });
  }
  const upstream = await doFetch(`${provider.upstream()}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": key },
    body: JSON.stringify({ ...body, model }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await upstream.text();
  if (upstream.status >= 400) {
    let why = text;
    try {
      why = JSON.parse(text)?.error?.message ?? text;
    } catch {
      // Not JSON: the text is the reason.
    }
    throw new Error(`${provider.label} answered ${upstream.status}: ${String(why).slice(0, 300)}`);
  }
  return JSON.parse(text);
}

/** The text blocks of an answer, joined - what a caller wanting words asks for. */
export const textOf = (reply) =>
  (Array.isArray(reply?.content) ? reply.content : [])
    .filter((block) => block?.type === "text" && block.text)
    .map((block) => block.text)
    .join("\n")
    .trim();
