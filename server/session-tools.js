// The three tools that are about the record, not about the room.
//
// `discover` searches every session this installation has seen and the
// catalogue beside them, `open_session` reads one of those whole, and
// `name_session` says what the session doing the asking is for. They were in
// collab-tools.js with the tasks and the hand-offs, and they do not belong
// with them: those need other agents and a board to mean anything, and
// these three need only the sessions this installation already recorded. A
// CoderVibes on one laptop has no room and no tasks and still has all three - which is the whole of why they are here rather than there.
//
// So the context is a plain one, built by whoever is calling:
//
//   owner             whose sessions these are, for the answer and the trail
//   origin            where this installation is reached, for the links
//   sessionRecordId   the session to name - the one the hooks are writing
//   allow(session)    whether this caller may read that session's *words*
//   repoName(repoId)  what to call a repo, or null where there are none
//   answers           whether `answer: true` has a model to ask
//
// `allow` is handed in rather than worked out here because the rule differs:
// the hosted product asks whether the owner can open the repo the session was
// in (collab-tools.js `readerFor`), and a local installation has one person
// and no repos, so every session is theirs. Neither answer belongs in a file
// that must not import the registry.
import * as sessionLog from "./sessions.js";
import { WORDS as WORK_WORDS, described as describedKinds, kindIn } from "./work-kinds.js";
import * as search from "./search.js";
import * as discoverAgent from "./discover-agent.js";

const text = (body) => ({ content: [{ type: "text", text: body }] });
const refuse = (body) => ({ isError: true, content: [{ type: "text", text: body }] });

export const DISCOVER_TOOL = {
  name: "discover",
  permission: null,
  description:
    "Ask how something was done here before you work it out yourself: one " +
    "search over the sessions this installation has seen - what was asked, " +
    "what was said, what was reached for - and over the connectors, tools " +
    "and skills an agent can reach for. 'how do I trigger a deploy' finds " +
    "the session that ran fly_deploy from a sandbox, and the Fly connector " +
    "beside it. Each hit says why it matched and where to read the whole " +
    "thing, and open_session reads it. Sessions come back only from repos " +
    "your owner can open.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The question, in words: what you want to know how to do, or find." },
      kind: { type: "string", enum: ["session", "connector", "tool", "skill"], description: "Only this kind of thing. Omit for all four." },
      limit: { type: "integer", minimum: 1, maximum: 30, description: "How many hits. Default 10." },
      answer: { type: "boolean", description: "Also have the installation's model read the hits and say how it was done, citing them. Takes a few seconds and a model call. Default false." },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

export const OPEN_SESSION_TOOL = {
  name: "open_session",
  permission: null,
  description:
    "Read one past session in full - what was asked, what was reached for, " +
    "the calls made and what was said - by its id, from a discover hit " +
    "(ses_...). A hit's quote is a fragment; this is how it was actually " +
    "done, and the place to look before doing it again from scratch. Only " +
    "the words of a session in a repo your owner can open; of any other " +
    "you learn who worked and what they reached for, and no more.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The session's id, from a discover hit or a session's address (ses_...)." },
    },
    required: ["id"],
    additionalProperties: false,
  },
};

export const NAME_SESSION_TOOL = {
  name: "name_session",
  permission: null,
  description:
    "Say what this session is for: what the person who asked is trying to " +
    "get done, in at most eight words, as they would put it - 'Fix the " +
    "login redirect loop on prod'. It is the session's name on their Home " +
    "page. Call it as soon as you have read the first ask, before the " +
    "work; call it again if the work turns into something else - a " +
    "different task, not a detail, a correction or a next step of the same " +
    "one. Until you say, the session is named after the first line of the " +
    "ask, which is a name only when the ask opens with one. Say `kind` " +
    "with it: which kind of work this is, one word from the list, judged " +
    "by what the work is for rather than what it touches. The Performance " +
    "page groups sessions by it; a session that never says is 'unsaid'.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "What the session is for, in at most eight words. No quotes, no trailing period.",
      },
      kind: {
        type: "string",
        enum: WORK_WORDS,
        description: `What kind of work it is, one word: ${describedKinds()}.`,
      },
    },
    required: ["title"],
    additionalProperties: false,
  },
};

/** The three, in the order a client should meet them: find, read, name. */
export const SESSION_TOOL_DEFINITIONS = [DISCOVER_TOOL, OPEN_SESSION_TOOL, NAME_SESSION_TOOL];

const NAMES = new Set(SESSION_TOOL_DEFINITIONS.map((tool) => tool.name));

export const isSessionTool = (name) => NAMES.has(name);

export function executeSessionTool(name, args = {}, context) {
  switch (name) {
    case "discover":
      return discoverTool(args, context);
    case "open_session":
      return openSessionTool(args, context);
    case "name_session":
      return nameSessionTool(args, context);
    default:
      return refuse(`Unknown tool: ${name}`);
  }
}

/**
 * The agent says what the session is for, and the session's row says it.
 * The record is the one the hooks are writing when there are hooks
 * (mcp.js `recordFor`), else this connection's own - either way the row
 * the person sees.
 */
function nameSessionTool(args, context) {
  const id = context.sessionRecordId ?? null;
  if (!id) return refuse("This connection has no session to name. Initialize first, and send the mcp-session-id header with each call.");
  const kept = sessionLog.nameSession(id, args.title);
  if (!kept) return refuse("A name needs words: say what the session is for, in at most eight words.");
  // The kind travels with the name, and the vocabulary travels with the
  // word: sessions.js refuses anything off the list, so the record can
  // only ever hold one of the eight. A word the agent invented is said
  // back to it with the list, and the name is kept regardless - one wrong
  // word is not a reason to lose the right one.
  const said = args.kind == null ? null : kindIn(args.kind);
  const noted = said ? sessionLog.noteWork(id, said, WORK_WORDS) : null;
  const about = noted ? `, ${said} work,` : "";
  const refused = args.kind != null && !said ? ` '${String(args.kind).slice(0, 40)}' is not a kind of work here; the kinds are ${WORK_WORDS.join(", ")}.` : "";
  return text(`This session is now named "${kept}"${about} on the Activity page. Say so again if the work turns into something else.${refused}`);
}

/**
 * Discover, for an agent: the same search the page runs, seen as the
 * agent's owner - sessions in repos the owner can open, and the words of
 * those; the catalogue whole. Lines, with a link to each session's page,
 * since what an agent wants next is to read the one that did it.
 */
async function discoverTool(args, context) {
  const asked = String(args.query ?? "").trim();
  if (!asked) return refuse("Ask something: a few words on what you want to find or know how to do.");
  const owner = context.owner ?? null;
  const mayRead = context.allow;
  const { hits, semantic } = await search.query(asked, {
    limit: Math.min(Math.max(Number(args.limit) || 10, 1), 30),
    kinds: args.kind ? [args.kind] : null,
    allow: (doc) => doc.kind !== "session" || mayRead(doc.session),
  });
  const origin = context.origin ?? null;
  // The answer first, when asked for: the model reads the hits (and opens
  // what it needs) under the same rules, and the hits follow as evidence.
  let answered = "";
  if (args.answer && context.answers === false) {
    // An installation with no model of its own - the local edition - can
    // still search. Said as a line above the hits rather than as an error:
    // the hits are what was asked for, and refusing them because the extra
    // was not available would be a worse answer than none.
    answered =
      "Answers are off here: this CoderVibes reads the hits with no model of " +
      "its own, so there is nobody to write one. The hits below are the " +
      "whole of what it found; open_session reads one of them in full.\n\n";
  } else if (args.answer) {
    const result = await discoverAgent.answer(asked, { owner, allow: (doc) => doc.kind !== "session" || mayRead(doc.session), mayRead, hits }).catch((err) => ({ answer: null, why: err.message }));
    answered = result.answer
      ? `Answer (from ${result.citations.length} source${result.citations.length === 1 ? "" : "s"}; the markers are ids you can open):\n${result.answer}\n\n`
      : `No answer: ${result.why}\n\n`;
  }
  if (!hits.length) {
    const why = search.whyNoSemantic();
    return text(`${answered}Nothing here matches "${asked}"${semantic ? "" : " by its words"}.${why ? ` ${why}` : ""}`);
  }
  const lines = hits.map((hit) => {
    const doc = hit.doc;
    const how = [hit.terms.length ? `words: ${hit.terms.join(", ")}` : null, hit.semantic ? "meaning" : null].filter(Boolean).join("; ");
    if (doc.kind === "session") {
      const who = doc.session.actor?.name ?? doc.session.actor?.id ?? "somebody";
      const where = context.repoName(doc.session.repoId);
      const reached = [...doc.tools, ...doc.connectors, ...doc.skills];
      return (
        `- session "${doc.title || `(unnamed, ${who})`}" by ${who}${where ? ` in ${where}` : ""}, ${new Date(doc.at).toISOString().slice(0, 10)}` +
        `${reached.length ? ` - reached for ${reached.slice(0, 8).join(", ")}` : ""} (${how})` +
        `${origin ? `: ${origin}/activity/${doc.session.id}` : ""}` +
        `${hit.snippet ? `\n    ${hit.snippet}` : ""}`
      );
    }
    const page = doc.kind === "connector" ? `/connectors/${encodeURIComponent(doc.name)}` : doc.kind === "tool" ? `/tools/${encodeURIComponent(doc.name)}` : "/tools";
    return `- ${doc.kind} ${doc.title} (${how})${origin ? `: ${origin}${page}` : ""}${hit.snippet ? `\n    ${hit.snippet}` : ""}`;
  });
  const note = semantic ? "" : `\n\n(${search.whyNoSemantic() ?? "By words only."})`;
  const how = hits.some((hit) => hit.doc.kind === "session") ? "\n\nA quote is a fragment: open_session with a session's id reads the whole of it." : "";
  return text(`${answered}${hits.length} hit${hits.length === 1 ? "" : "s"} for "${asked}":\n${lines.join("\n")}${how}${note}`);
}

/**
 * One session in full, for an agent that found it: the same document the
 * search indexed and the Search page's answer reads (search.js
 * `sessionDocument` - asked, reached for, calls, said), so what a hit
 * quoted can be read whole. A session the index has not seen yet - live,
 * or older than it keeps - is built from the store on the spot. The words
 * rule is discover's: an unreadable session is who worked and what they
 * reached for, and no more.
 */
async function openSessionTool(args, context) {
  const id = String(args.id ?? "").trim().replace(/^session:/, "");
  if (!id) return refuse("Say which session: its id, from a discover hit (ses_...).");
  const doc = search.get(`session:${id}`) ?? (await search.indexSession(id).catch(() => null));
  if (!doc) return refuse(`No session ${id} here. Its id comes from a discover hit or a session's address; the index keeps ${Math.round(search.KEEP_MS / (24 * 60 * 60 * 1000))} days.`);
  const session = doc.session;
  const who = session.actor?.name ?? session.actor?.id ?? "somebody";
  const where = context.repoName(session.repoId);
  const when = doc.at ? new Date(doc.at).toISOString().slice(0, 10) : "";
  const reached = [...doc.tools, ...doc.connectors, ...doc.skills];
  const live = session.state === "live" ? " (still working)" : "";
  // A title is the ask's first line until the agent names it: words, so
  // an unreadable session is named by who and when only.
  if (!context.allow(session)) {
    return text(`Session ${id} by ${who}, ${when}${live}.\nIts words are not yours to read: it is in no repo your owner can open. ${reached.length ? `It reached for ${reached.join(", ")}.` : "What it reached for is not recorded."}`);
  }
  const head = `Session ${id}${doc.title ? ` "${doc.title}"` : ""} by ${who}${where ? ` in ${where}` : ""}, ${when}${live}`;
  const origin = context.origin ?? null;
  const body = String(doc.text ?? "").slice(0, discoverAgent.OPEN_CHARS);
  const cut = doc.text && doc.text.length > body.length ? `\n\n(cut at ${discoverAgent.OPEN_CHARS} characters${origin ? `; the whole session is at ${origin}/activity/${id}` : ""})` : "";
  return text(`${head}${origin ? `: ${origin}/activity/${id}` : ""}\n\n${body || "(nothing recorded of what was said)"}${cut}`);
}
