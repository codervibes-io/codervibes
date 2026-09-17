// Recall: what was done here before, handed to an agent as it starts on a
// prompt - the context cache.
//
// The discover tool has been in every agent's list since the Search page
// existed, and its instructions say to ask before working something out.
// Agents do not. A tool that is optional is one skipped under any
// pressure at all, and the one time it would have paid - a deploy done
// forty tool calls the long way, a table that was known to be missing -
// is exactly the time nobody thought to ask. So the asking is taken off
// the agent: the prompt hook (setup-script.js `report prompt`) sends the
// prompt here, this module asks the index, and the answer goes back to the
// harness as context under the prompt, before the agent has read it.
//
// What is handed back is a few past turns, not sessions: the prompt that
// started each, what it ran, the end of what it said, and the session to
// open for the whole of it. That is the unit the trials chose
// (docs/recall.md): the whole prompt plus the branch as the query, words
// and meaning fused, a turn that ended in a pull request ahead of one that
// did not, and last fortnight's ahead of last month's. Three, not ten - a
// hit here costs the agent a few hundred tokens of reading on every
// prompt, and the fourth was right one time in twenty.
//
// The words rule holds (sessions.js): the agent reads as its owner, and a
// turn from a session the owner cannot open is not handed to it at all -
// there is nothing to hand; the point is the words.
import * as search from "./search.js";

/** How many turns come back. */
export const LIMIT = 3;
/** How far from the index each half is asked to look before rescoring. */
export const CANDIDATES = 60;
/** The half-life of a turn's worth, in days: a fortnight ago counts half. */
export const RECENCY_DAYS = 14;
/** What a turn from a session that ended in a pull request is worth against one that did not. */
export const PULL_PRIOR = 1.3;
/** How much of a prompt goes into the question, and of a hit into the context. */
export const PROMPT_CHARS = 500;
export const CALLS_CHARS = 420;
export const SAID_CHARS = 240;

/**
 * The words a prompt is made of when it says nothing: an agreement, a
 * nudge, a thank-you. Stemmed the way the index stems ("sounds" is
 * "sound", "thanks" is "thank"), and taken off before the count.
 */
const FILLER = new Set(
  "ok okay yes yep yeah no nope sure go ahead thank great good fine done cool nice continue proceed next ready hi hello hey please sound let try again now just also right correct exactly agree perfect awesome"
    .split(" ")
    .map(search.stem),
);

/**
 * Whether a prompt is worth asking about. "yes", "sounds good", "ok go"
 * and a pasted address say nothing the index could match, and the hit
 * they get is noise handed to the agent with a straight face: in the
 * judged sample every note under such a prompt was useless. Two words
 * that survive the stop list and the filler is the bar; a single word on
 * its own - "deploy" - passes on its weight, a single word in a sentence
 * of filler does not.
 */
export function worthAsking(prompt) {
  const text = String(prompt ?? "").trim();
  if (!text || text.startsWith("/")) return false;
  const words = text.replace(/https?:\/\/\S+/g, " ");
  const tokens = search.tokenize(words);
  const content = tokens.filter((token) => !FILLER.has(token));
  if (content.length >= 2) return true;
  return content.length === 1 && tokens.length === 1;
}

/** The branch's words, for the question: `hooks-spool-and-ship` is four of them. */
function branchWords(branch) {
  return String(branch ?? "").replace(/[-_/.]+/g, " ").trim();
}

/**
 * The best past turns for a prompt. `allow` is the owner's reading rule
 * over a hit's session; `session` is the asking session's own record id,
 * which is never handed back to itself - it has its own transcript.
 */
export async function recall(prompt, { branch = null, session = null, allow = () => true, now = Date.now(), limit = LIMIT } = {}) {
  const asked = [String(prompt ?? "").trim().slice(0, PROMPT_CHARS), branchWords(branch)].filter(Boolean).join(" ");
  if (!asked) return { hits: [], semantic: false };
  const { hits, semantic } = await search.query(asked, {
    limit: CANDIDATES,
    kinds: ["turn"],
    allow: (doc) => doc.kind === "turn" && doc.session?.id !== session && allow(doc.session),
  });
  const rescored = hits.map((hit) => {
    const ageDays = Math.max(0, now - (hit.doc.at || now)) / 86_400_000;
    const finished = Array.isArray(hit.doc.session?.pulls) && hit.doc.session.pulls.length > 0;
    return { ...hit, score: (hit.score / (1 + ageDays / RECENCY_DAYS)) * (finished ? PULL_PRIOR : 1) };
  });
  rescored.sort((x, y) => y.score - x.score);
  // One turn a session: the second-best turn of the same session says
  // less than the best turn of another, and open_session reads the rest.
  const seen = new Set();
  const out = [];
  for (const hit of rescored) {
    const id = hit.doc.session?.id;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(hit);
    if (out.length >= limit) break;
  }
  return { hits: out, semantic };
}

const day = (at) => (at ? new Date(at).toISOString().slice(0, 10) : "");
const oneLine = (text, max) => {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * The context handed to the harness: a heading the agent will recognise,
 * one numbered entry a hit - the prompt that started the turn, who and
 * when, what it ran, how it ended - and the one instruction that matters,
 * which is to open the session before doing the thing the long way. The
 * instruction travels with the data, so no harness has to be told
 * separately what the block is for.
 */
export function contextOf(hits, { origin = null } = {}) {
  if (!hits?.length) return "";
  const lines = hits.map((hit, i) => {
    const doc = hit.doc;
    const who = doc.session?.actor?.name ?? doc.session?.actor?.id ?? "somebody";
    const link = origin ? ` ${origin}/activity/${doc.session.id}` : "";
    const calls = oneLine(doc.turn?.calls?.join("; "), CALLS_CHARS);
    const said = oneLine(doc.turn?.said, SAID_CHARS);
    return (
      `${i + 1}. "${oneLine(doc.title, 140)}" - ${who}, ${day(doc.at)}, session ${doc.session.id}${link}` +
      (calls ? `\n   ran: ${calls}` : "") +
      (said ? `\n   ended: ${said}` : "")
    );
  });
  return (
    `## Done here before\n` +
    `CoderVibes found ${hits.length} past turn${hits.length === 1 ? "" : "s"} like this prompt. ` +
    `Read them before working it out from scratch; a match is a place to start, not an order. ` +
    `open_session <id> reads one whole (the ask, every call, what was said).\n\n` +
    lines.join("\n")
  );
}

/** The hook's answer, in the shape Claude Code reads off a UserPromptSubmit hook's stdout. */
export function hookOutput(context) {
  return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } };
}
