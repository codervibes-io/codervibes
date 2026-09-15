// What kind of steer a re-prompt was: one word, from the words themselves.
//
// A session's steering count says how many times a person had to speak. It
// does not say why, and the why is the whole of what a team can act on.
// Six follow-ups because the agent kept misreading the ask is a prompt
// problem; six because the person kept thinking of new things is not a
// problem at all; six because the agent kept going the wrong way is a
// model or a harness problem. The same number, three different weeks.
//
// So each prompt after the first is labelled with one of six kinds. The
// classifier is a small model call with two pieces of text - the last thing
// the agent said, and what the person typed back - and one word out. Words
// in, an enum out: what lands on the session record is the word, never the
// text, which is the record's standing rule (sessions.js).
//
// The kinds, and the line between them:
//
//   clarify   the ask stood, but not clearly enough - the person is saying
//             what they meant, more precisely. "I meant the retry in the
//             poller, not the one in the client."
//   correct   the agent got something wrong and is being put right. "That
//             test does not assert anything."
//   redirect  nothing was wrong; the person wants it done another way, or
//             wants a different thing done next. "Do it with the existing
//             helper instead."
//   context   a fact the agent could not have known, handed over. An error
//             message pasted in, a path, a decision made elsewhere.
//   approve   permission to carry on, and nothing else. "Yes, go ahead."
//   new       a fresh piece of work, unrelated to what just happened.
//
// The line between `clarify` and `correct` is who was at fault, and between
// `correct` and `redirect` is whether the work was wrong or merely not
// wanted. Those are the two distinctions worth having, and they are why
// this is a model call and not a regular expression.
//
// **It is allowed to say nothing.** An installation with no provider or no
// key for one classifies nothing at all; a model that answers with a
// paragraph, JSON we did not ask for, or a seventh word of its own
// invention classifies nothing either. Both come back as null, the session
// keeps no kind, and every page that shows kinds shows the remainder as
// "unclassified" rather than inventing a bucket. A guessed label on a
// dashboard is worse than a gap, because a gap is visibly a gap.
import { askModel, whyNoModel, textOf, houseModel } from "./ask-model.js";

/** The kinds, in the order the pages stack them. */
export const KINDS = ["clarify", "correct", "redirect", "context", "approve", "new"];

/** How much of either side of the exchange the model is given. A label needs the gist, not the transcript. */
export const MAX_CHARS = 1500;

/** One word is the answer; this is room for the word and nothing else. */
const MAX_TOKENS = 8;

/** A label is worth a second or two, and no more - it is behind a hook. */
const TIMEOUT_MS = 15_000;

/**
 * The model that labels: the one named for this, else whichever model the
 * installation already answers its own questions with (ask-model.js
 * `houseModel`, which is also Discover's). One knob, and only for an
 * installation that wants the labelling done by something smaller or
 * cheaper than the model its Search page answers with.
 */
export const MODEL = () =>
  (process.env.CODERVIBES_STEER_MODEL ?? "").trim() || (process.env.CODERVIBES_DISCOVER_MODEL ?? "").trim() || houseModel();

const SYSTEM = `You label how a person's new message to a coding agent relates to the work the agent just reported.

Answer with exactly one of these words, lowercase, and nothing else:

clarify - the original ask stood; the person is stating what they meant more precisely.
correct - the agent got something wrong and is being put right.
redirect - nothing was wrong; the person wants it done a different way, or wants a different thing next.
context - the person is handing over a fact the agent could not have known: an error, a path, a decision made elsewhere.
approve - permission to carry on, and nothing else.
new - a fresh piece of work, unrelated to what just happened.

One word. No punctuation, no explanation.`;

const cut = (text) => {
  const words = String(text ?? "").trim();
  return words.length > MAX_CHARS ? `${words.slice(0, MAX_CHARS - 1)}…` : words;
};

/**
 * The kind in an answer, or null.
 *
 * Defensive on purpose: a small model told to say one word will sometimes
 * say `"correct"`, or `{"kind": "correct"}`, or `Correct.`, and all of
 * those mean the same thing and should count. Anything that is not one of
 * the six after that - a sentence, a word of its own, silence - is null,
 * because a label this module invented would be indistinguishable on the
 * page from one the model meant.
 */
export function kindIn(answer) {
  const text = String(answer ?? "").trim().toLowerCase();
  if (!text) return null;
  // A JSON object, when the model decided to be helpful.
  const quoted = text.match(/"(?:kind|label|answer)"\s*:\s*"([a-z]+)"/);
  const first = quoted ? quoted[1] : (text.match(/[a-z]+/)?.[0] ?? "");
  return KINDS.includes(first) ? first : null;
}

/**
 * Label one steer. Returns the kind, or null when there is nothing to say -
 * no words to read, no model to ask, or an answer that was not one of the
 * six.
 *
 * Never throws: the caller is the hook ingest path (telemetry-ingest.js),
 * and a prompt that was recorded must stay recorded whatever a model does.
 *
 * @param {{said: string|null, prompt: string, owner?: string|null, model?: string, fetch?: Function}} args
 *   `said` is the last thing the agent said, `prompt` what the person typed
 *   back. `owner` is whose key pays for the call.
 */
export async function classify({ said, prompt, owner = null, model = null, fetch: doFetch = fetch } = {}) {
  const asked = cut(prompt);
  if (!asked) return null;
  const which = model ?? MODEL();
  // Asked before anything is sent: an installation with no key must make no
  // call at all, not one that fails.
  if (await whyNoModel(which, owner)) return null;
  const before = cut(said);
  const content = `The agent last said:\n${before || "(nothing recorded)"}\n\nThe person then said:\n${asked}\n\nWhich word?`;
  try {
    const reply = await askModel({
      model: which,
      system: SYSTEM,
      messages: [{ role: "user", content }],
      maxTokens: MAX_TOKENS,
      owner,
      fetch: doFetch,
      timeoutMs: TIMEOUT_MS,
    });
    return kindIn(textOf(reply));
  } catch {
    // A label is a nicety. Not having one is not an error anybody needs to
    // hear about on the terminal that typed the prompt.
    return null;
  }
}
