// MCP's Streamable HTTP transport, with nothing of this app in it.
//
// This is the half of server/mcp.js that is true of any MCP server: JSON-RPC
// 2.0 over one POST endpoint, single messages and batches, `initialize` and
// the session id it hands back, `tools/list`, `tools/call`, the
// notifications, the 405 on GET and the DELETE that ends a session. None of
// it knows what a repo is, what a permission is, or who is calling.
//
// It was lifted out because there are two servers now. The hosted product's
// (mcp.js) hands an invited agent the room, the tasks and its owner's
// connectors on a bearer token; the local edition's (mcp-local.js) hands the
// coding agent on this laptop three tools over loopback and asks for no
// credential at all. Those differ in every way that matters and in no way
// that is protocol - so a second copy of the handshake, the session map and
// the error shapes would be a second place for a spec detail to be wrong,
// and the wrong one would be the one nobody was reading.
//
// There is no SDK here for the same reason there is no bundler: the surface
// we need is small enough to read in one sitting, and a dependency that
// spoke it for us would be larger than this file.
//
// What the caller supplies is in `mountProtocol` below. The rule for what
// belongs here is: if a client's request could be answered without knowing
// which installation it reached, it is this file's.
import { randomUUID } from "node:crypto";

/**
 * Protocol revisions we can speak, newest first.
 *
 * `initialize` echoes back the client's version when we know it, and our
 * newest when we do not - which is what the spec asks for, and what lets an
 * older client connect to a newer server rather than failing the handshake.
 */
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"];
const LATEST_PROTOCOL = PROTOCOL_VERSIONS[0];

/** Sessions are memory only. Losing them costs a re-initialize, nothing more. */
const SESSION_TTL_MS = 30 * 60_000;
/**
 * A ceiling, because `initialize` is the one method that allocates and it is
 * not rate limited - a holder of a valid token could otherwise sit in a loop
 * and grow this map until the process died. The oldest goes first; its owner
 * re-initializes, which is exactly what a dropped session is supposed to cost.
 */
const MAX_SESSIONS = 2_000;

// ------------------------------------------------------------- JSON-RPC

export const JSON_RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
};

const result = (id, value) => ({ jsonrpc: "2.0", id, result: value });
const failure = (id, code, message, data) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data ? { data } : {}) },
});

const inFlightKey = (sessionId, requestId) => `${sessionId ?? "-"}:${requestId}`;

/**
 * Mount one MCP endpoint.
 *
 * Everything the installation answers for is handed in:
 *
 *   authenticate(req, session)  who is calling, as whatever shape the
 *                               caller's own tools want on their context -
 *                               or null for a 401. The transport session is
 *                               passed in because which repo an agent is in
 *                               is a property of the session, not the token.
 *   unauthorized(req)           the sentence that 401 carries.
 *   tools(context)              the tool definitions this caller may see.
 *   call(context, name, args, session, { signal, requestId })
 *                               run one, and answer with an MCP tool result.
 *                               A refusal is a result with `isError`, never
 *                               a protocol fault - see the note in mcp.js.
 *   instructions(context)       what `initialize` tells the client this
 *                               server is for.
 *   serverInfo                  name and version, as the client displays it.
 *   resources                   `{ list, read(context, uri) }`, or null for
 *                               a server that offers none - in which case
 *                               the capability is not declared either.
 *   onSessionOpen(session, ctx) fill in whatever the caller keeps on a
 *                               session; it already holds id, protocol and
 *                               lastSeenAt.
 *   onSessionEnd(session)       a DELETE, or the TTL sweep, ended one.
 *   beforeDispatch(context, session, messages)
 *                               one look at the whole request before any of
 *                               it is answered.
 *
 * Deliberately outside `/api` and its session middleware: this is not a
 * browser talking with a cookie, it is an agent talking JSON-RPC, and running
 * it through cookie auth would be a way for the two to be confused.
 *
 * @returns {{sessions: Map, sweepSessions: (now?: number) => void}}
 */
export function mountProtocol(app, {
  path = "/mcp",
  authenticate,
  unauthorized = () => "Authentication is required",
  tools,
  call,
  instructions = () => undefined,
  serverInfo,
  resources = null,
  onSessionOpen = () => {},
  onSessionEnd = () => {},
  beforeDispatch = () => {},
} = {}) {
  /** id -> { id, lastSeenAt, protocol, ...whatever the caller keeps } */
  const sessions = new Map();

  /**
   * Tool calls in flight, so `notifications/cancelled` can stop one.
   *
   * Keyed by session and request id, which is what the notification names.
   * The spec says a client may cancel any request it has sent; without this
   * the notification was accepted and dropped, and an abandoned `npm install`
   * ran out its two-minute timeout inside somebody's sandbox while holding
   * one of the agent's four concurrent call slots.
   */
  const inFlight = new Map(); // `${sessionId}:${requestId}` -> AbortController

  function sweepSessions(now = Date.now()) {
    for (const [id, session] of sessions) {
      if (now - session.lastSeenAt > SESSION_TTL_MS) {
        sessions.delete(id);
        onSessionEnd(session);
      }
    }
  }

  // Every minute, so a session is called inactive within a minute of its TTL
  // rather than up to five late; the sweep is a walk over what is in memory.
  setInterval(() => sweepSessions(), 60_000).unref();

  /** Handle one JSON-RPC message. Returns a response, or null for a notification. */
  async function dispatch(message, context, session, res) {
    const { id, method, params } = message ?? {};

    if (!message || message.jsonrpc !== "2.0" || typeof method !== "string") {
      return failure(id ?? null, JSON_RPC.invalidRequest, "Not a JSON-RPC 2.0 request");
    }

    switch (method) {
      case "initialize": {
        const asked = params?.protocolVersion;
        const protocol = PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST_PROTOCOL;

        // One session per initialize. The id goes back in a header and the
        // client echoes it; it is how DELETE knows which agent just left.
        sweepSessions();
        while (sessions.size >= MAX_SESSIONS) {
          sessions.delete(sessions.keys().next().value); // insertion order: oldest
        }
        const sessionId = randomUUID();
        const opened = { id: sessionId, lastSeenAt: Date.now(), protocol };
        onSessionOpen(opened, context);
        sessions.set(sessionId, opened);
        res.setHeader("Mcp-Session-Id", sessionId);

        return result(id, {
          protocolVersion: protocol,
          capabilities: {
            tools: { listChanged: false },
            ...(resources ? { resources: { listChanged: false, subscribe: false } } : {}),
          },
          serverInfo,
          instructions: instructions(context),
        });
      }

      case "notifications/initialized":
        return null;

      case "notifications/cancelled": {
        // Notifications get no reply, whatever happens - so this is
        // deliberately quiet about an id it does not recognise. A request
        // that already finished is the ordinary case, not an error.
        inFlight.get(inFlightKey(session?.id, params?.requestId))?.abort();
        return null;
      }

      case "ping":
        return result(id, {});

      case "tools/list":
        return result(id, { tools: await tools(context) });

      case "tools/call": {
        const name = params?.name;
        if (typeof name !== "string") {
          return failure(id, JSON_RPC.invalidParams, "A tool name is required");
        }

        // Registered before the call and cleared after, so a cancellation
        // that arrives on another connection mid-call can find it.
        const flightKey = inFlightKey(session?.id, id);
        const controller = new AbortController();
        inFlight.set(flightKey, controller);
        try {
          return result(
            id,
            await call(context, name, params?.arguments, session ?? null, {
              signal: controller.signal,
              requestId: id,
            }),
          );
        } finally {
          inFlight.delete(flightKey);
        }
      }

      case "resources/list":
        return result(id, { resources: resources?.list ?? [] });

      case "resources/read": {
        const uri = params?.uri;
        const text = resources ? resources.read(context, uri) : null;
        if (text === null || text === undefined) {
          return failure(id, JSON_RPC.invalidParams, `No such resource: ${uri}`);
        }
        const entry = resources.list.find((candidate) => candidate.uri === uri);
        return result(id, { contents: [{ uri, mimeType: entry.mimeType, text }] });
      }

      // Nothing here offers prompts, but a client may still ask.
      case "prompts/list":
        return result(id, { prompts: [] });

      default:
        return failure(id, JSON_RPC.methodNotFound, `Unknown method: ${method}`);
    }
  }

  const refuse = (res, message) => {
    // The WWW-Authenticate header is what tells a compliant client this is a
    // credential problem rather than a permissions one.
    res.setHeader("WWW-Authenticate", 'Bearer realm="codervibes"');
    res.status(401).json(failure(null, JSON_RPC.invalidRequest, message));
  };

  app.post(path, async (req, res) => {
    const headerId = req.headers["mcp-session-id"];
    const session = typeof headerId === "string" ? sessions.get(headerId) : undefined;

    let context;
    try {
      context = await authenticate(req, session ?? null);
    } catch (err) {
      return res.status(500).json(failure(null, JSON_RPC.internal, err.message));
    }
    if (!context) return refuse(res, unauthorized(req));

    if (typeof headerId === "string") {
      // A session id we have never heard of (or have forgotten) is a 404,
      // which is the spec's signal to the client to initialize again.
      if (!session) {
        return res.status(404).json(
          failure(null, JSON_RPC.invalidRequest, "Unknown session; initialize again"),
        );
      }
      session.lastSeenAt = Date.now();
    }

    const body = req.body;
    const batch = Array.isArray(body);
    const messages = batch ? body : [body];
    if (!messages.length) {
      return res.status(400).json(failure(null, JSON_RPC.invalidRequest, "Empty request"));
    }

    beforeDispatch(context, session ?? null, messages);

    const responses = [];
    for (const message of messages) {
      const answer = await dispatch(message, context, session ?? null, res);
      if (answer) responses.push(answer);
    }

    // Nothing but notifications: acknowledge and send no body, as the spec
    // requires - a JSON-RPC response to a notification is a protocol error.
    if (!responses.length) return res.status(202).end();

    res.setHeader("Content-Type", "application/json");
    res.status(200).json(batch ? responses : responses[0]);
  });

  /**
   * The server-to-client stream. We have nothing to push - no sampling, no
   * roots, no tool-list changes - so this is 405, which the spec names as the
   * correct answer for a server that does not offer one.
   */
  app.get(path, (req, res) => {
    res.setHeader("Allow", "POST, DELETE");
    res.status(405).json(failure(null, JSON_RPC.invalidRequest, "No server stream"));
  });

  /** Ending a session is how an agent leaves without waiting to time out. */
  app.delete(path, async (req, res) => {
    const headerId = req.headers["mcp-session-id"];
    const session = typeof headerId === "string" ? sessions.get(headerId) : null;
    if (session) {
      sessions.delete(headerId);
      await onSessionEnd(session);
    }
    res.status(204).end();
  });

  return { sessions, sweepSessions };
}
