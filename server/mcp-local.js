// The local edition's MCP server: three tools, no token, this machine only.
//
// The coding agent on this laptop already reports here - the setup line puts
// hooks in it, and every prompt, tool call and answer lands in this process.
// This is the other direction: the agent asking the record a question before
// it works something out from scratch. `discover` searches every session this
// installation has seen, `open_session` reads one of them whole, and
// `name_session` says what the session it is in is for, which is the name on
// its row.
//
// That is the whole list, and the shortness is the design. The hosted
// product's endpoint (mcp.js) hands an invited agent the room, the tasks, its
// owner's connectors and a merge - and every one of those needs other people,
// a repo registry or somebody else's credential. A CoderVibes on one laptop
// has none of the three by construction. What it has, and what nothing on the
// machine has, is a month of what the agents here actually did.
//
// **No credential, and none needed.** local.js puts `sameMachine` in front of
// every request and binds to loopback, so the door this opens is the same
// door the console and the ingest already answer through: this machine, or
// nothing. A token here would authenticate the one person against themselves
// - a step to do and a credential to keep that protects nothing - and the
// setup script writes the server into every harness with no Authorization
// header for that reason (setup-script.js).
//
// The transport is mcp-protocol.js, the same one the hosted endpoint uses.
import { mountProtocol } from "./mcp-protocol.js";
import { SESSION_TOOL_DEFINITIONS, isSessionTool, executeSessionTool } from "./session-tools.js";
import * as sessionLog from "./sessions.js";
import * as sessionEvents from "./session-events.js";
import * as ingestToken from "./ingest-token.js";
import { sessionCalling } from "./telemetry-ingest.js";
import { withSpan, annotate } from "./telemetry.js";
import { publicOrigin } from "./public-url.js";

const SERVER_INFO = { name: "codervibes-local", version: "0.1.0" };

/**
 * What `initialize` tells the agent it has reached.
 *
 * Written to be read by a model that has never seen this installation: what
 * the three tools are, when to call which, and - said outright rather than
 * left to be discovered by a refusal - that there is no room here and no
 * tasks. An agent that has used the hosted product's server will otherwise
 * look for `my_tasks` and `send_task`, and read their absence as a broken
 * connection rather than as a smaller installation.
 */
const instructions = (user) =>
  `You are ${user}'s own coding agent, and this is the CoderVibes running on ` +
  `the machine you are on. It has been watching the agents here work - every ` +
  `session, what was asked, every tool call and what came of it - and these ` +
  `three tools are how you read that back.\n\n` +
  `**Before you work something out from scratch, ask whether it was done ` +
  `here before.** discover searches every session this installation has ` +
  `seen, in words: "how do I trigger a deploy", "where does the rotation ` +
  `script live". Each hit says who did it, when, what they reached for, and ` +
  `quotes the words that matched. open_session then reads one of them in ` +
  `full, by the id on the hit - the ask, the calls, what was said - so you ` +
  `follow what actually worked rather than what a quote suggests.\n\n` +
  `**And say what you are doing.** Once you have read the first ask, ` +
  `name_session with what it is for, in a few words, as the person would ` +
  `put it. That is this session's name on the Executors page and in Search; ` +
  `until you say, it is named after the first line of the ask. Say it again ` +
  `if the work turns into something else - a different task, not a detail or ` +
  `a next step of the same one.\n\n` +
  `There is nothing else here. This CoderVibes has one person - you are ` +
  `running on their machine - so there is no room to talk in, nobody to hand ` +
  `a task to, and no connected service to reach. Everything else you do, you ` +
  `do with your own tools on this machine, as you would anyway.`;

export function mountLocalMcp(app, { user, path = "/mcp" } = {}) {
  return mountProtocol(app, {
    path,
    serverInfo: SERVER_INFO,
    // Everything that reaches here came from this machine: local.js checks
    // the socket before any route runs (edition.js `sameMachine`), so the
    // caller is the one person this installation has and there is nothing
    // further to ask them.
    authenticate: (req) => ({ user, origin: publicOrigin(req) }),
    tools: () => SESSION_TOOL_DEFINITIONS,
    instructions: (context) => instructions(context.user),
    call: runCall,
    // A session that opened a record of its own closes it; one that was
    // riding on a hook-fed session leaves that alone, since the hooks end it.
    onSessionEnd: (session) => sessionLog.end(session.sessionRecordId ?? null),
  });
}

async function runCall(context, name, args, session) {
  if (!isSessionTool(name)) {
    return {
      isError: true,
      content: [{
        type: "text",
        text:
          `There is no tool called '${name}' here. This CoderVibes runs on one ` +
          `machine for one person: what it offers is ` +
          `${SESSION_TOOL_DEFINITIONS.map((tool) => tool.name).join(", ")}, and nothing else. ` +
          `Run commands and edit files with your own tools, on the machine you are already on.`,
      }],
    };
  }

  const { sessionRecordId, hooked } = sessionFor(session, context.user, name);
  if (sessionRecordId) sessionLog.touch(sessionRecordId);

  // On the session's log, unless the hooks are already writing it there -
  // they write the call start and finish themselves, and a second copy would
  // read as two calls. Without hooks this is the only record that the agent
  // asked anything at all.
  const toolCallId = `mcp-${name}-${Date.now()}`;
  if (!hooked) {
    sessionEvents.append(sessionRecordId, "tool_call", {
      toolCallId,
      title: name,
      tool: name,
      toolKind: sessionEvents.toolKindOf(name),
      status: "in_progress",
    });
  }

  let outcome;
  try {
    // The call is one span, the way the hosted endpoint records its own
    // (mcp.js): what the agent called, whether it worked and how long it
    // took, from the side that served it. It is what the Tools page counts.
    //
    // Nothing else can supply it, and nothing else is allowed to: the
    // harness exports its own copy of this same call, and that copy is
    // passed over as it arrives (telemetry-ingest.js, `collab`) so that one
    // call is one span. This is the copy that stays because it is the one
    // that knows what happened - whether the tool refused, and how long the
    // serving took. Without any of it the Tools page said "no tools used"
    // to a person whose agent had just used three of ours, which is the
    // opposite of what the page is for.
    outcome = await withSpan(
      "tool.call",
      {
        "cv.session.id": sessionRecordId ?? undefined,
        "cv.owner": context.user,
        "cv.tool.name": name,
        // This app's own, as against a server on the person's own MCP list.
        "cv.tool.kind": "collab",
      },
      async () => {
        const out = await executeSessionTool(name, args ?? {}, {
          owner: context.user,
          origin: context.origin ?? null,
          sessionRecordId,
          // One person, and every session here is theirs: there is no repo to
          // ask whether they can open, because there are no repos.
          allow: () => true,
          repoName: () => null,
          // No model of this installation's own to read the hits with, so
          // `answer: true` says so instead of asking one (session-tools.js).
          answers: false,
        });
        // A tool that refused is a call that failed, and the page that
        // asks which tools keep failing has to be told so.
        annotate({ "cv.tool.ok": !out.isError });
        return out;
      },
      { parent: sessionRecordId ? sessionLog.contextFor(sessionRecordId) : null },
    );
  } catch (err) {
    // A thrown tool is still a tool result: MCP keeps protocol errors for
    // protocol problems, and an agent that gets one cannot tell "your id was
    // wrong" from "the server is broken".
    outcome = { isError: true, content: [{ type: "text", text: err.message ?? String(err) }] };
  }
  if (!hooked) {
    sessionEvents.append(sessionRecordId, "tool_call_update", {
      toolCallId,
      status: outcome.isError ? "failed" : "completed",
    });
  }
  return outcome;
}

/**
 * Which session record this call lands on, and whether the hooks already
 * wrote the call onto it.
 *
 * The same join the hosted endpoint makes (mcp.js `recordFor`), for the same
 * reason: the agent calling this is the agent whose hooks are reporting here,
 * and its `tool` hook fired before the call was sent - so the live session
 * with an open call on this very tool is the caller, and what comes of the
 * call belongs on the session that has the prompt. Without the join, naming
 * "this session" would name a second record holding nothing but the naming.
 *
 * A harness with no hooks installed announces nothing, and gets a record of
 * this connection's own, opened at the first such call rather than at
 * initialize - a connection that never calls anything is not a session.
 */
function sessionFor(session, user, name) {
  const harness = ingestToken.harnessOf(user);
  const hooked = sessionCalling({ user, harness }, name);
  if (hooked) return { sessionRecordId: hooked.id, hooked: true };
  if (session && !session.sessionRecordId) {
    session.sessionRecordId = sessionLog.open({
      kind: "harness",
      owner: user,
      actor: { kind: "agent", id: `setup:${user}`, name: `${user}'s own setup` },
      harness,
    }).id;
  }
  return { sessionRecordId: session?.sessionRecordId ?? null, hooked: false };
}
