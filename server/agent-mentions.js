// Who a line in the room is for.
//
// Agents are told to say, with a tag, and the same rule reads the tags on
// their behalf - so "is this for me" is decided once here, and the loop in a
// sandbox and the carry on a tool result agree.
//
// It is text and nothing else: no chat store, no registry, no agent record.
// That is why it is its own file rather than the bottom of agent-chat.js,
// where it lived. guidance.js asks this question about every line that rings
// the bell, and it was loading the whole private-chat log - and the repo
// chat behind it - to ask it. agent-chat.js re-exports all three, so the
// callers that always asked there still can.

const TAG = /(^|[^a-z0-9_@])@([a-z0-9][a-z0-9._-]*)/gi;

/**
 * The tags in a line: the names, and the three words that are not names.
 *
 * `@all` is everyone; `@humans` is the people, so agents stay out of it;
 * `@agents` is every agent. Anything else after an `@` is taken as a name.
 */
export function audience(text) {
  const names = new Set();
  let all = false;
  let humans = false;
  let agents = false;
  for (const match of String(text ?? "").matchAll(TAG)) {
    const tag = match[2].toLowerCase().replace(/[.]+$/, "");
    if (tag === "all") all = true;
    else if (tag === "humans") humans = true;
    else if (tag === "agents") agents = true;
    else names.add(tag);
  }
  return { names, all, humans, agents };
}

/** A word-boundary match on a name, case-insensitively, tagged or not. */
export const mentions = (text, name) => {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(String(text ?? ""));
};

/**
 * What a line in the room is to one agent.
 *
 *   "addressed"  it was named, or the line was to @agents or @all: answer it.
 *   "overheard"  a person said it to nobody in particular: read it, act or
 *                answer only if it is about your work, else stay quiet.
 *   "not"        it was to somebody else, to @humans, or another agent
 *                talking to nobody in particular.
 *
 * The last case is deliberate. Agents report what they did into the room,
 * and if each report woke every other agent to decide it was not for them,
 * three agents would spend the day reading each other's summaries. People
 * are different: a person who types into the room without a tag is talking
 * to whoever is there, and an agent that never looks up is the one everybody
 * complains about.
 *
 * The name is matched with or without the `@`: people wrote "Scout, stop"
 * long before there was a convention, and it still means Scout.
 *
 * There is no exception for anybody. There used to be a lead that heard
 * every line so it could hand work around; each line woke it for a model
 * episode over its whole context, which was most of what a four-agent team
 * cost per hour. An agent that wants another's attention names it.
 */
export function addressed(message, agentName) {
  const text = message.text ?? "";
  const tags = audience(text);
  if (mentions(text, agentName)) return "addressed";
  if (tags.agents || tags.all) return "addressed";
  if (tags.humans) return "not";
  if (message.agent) return "not";
  if (tags.names.size) return "not";
  return "overheard";
}
