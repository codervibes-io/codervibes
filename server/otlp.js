// Where a harness on somebody's laptop sends what it did.
//
// Three OTLP/HTTP routes - logs, metrics, traces - under `/otlp`, which is
// the endpoint the connect page prints; Claude Code appends `/v1/logs` and
// the rest itself. Each is opened by a harness token (`cvh1.`), the one
// thing that token is for: it names the account and the harness, and
// telemetry-ingest.js does the reading. A machine this app boots carries a
// token of the same shape (machine-reporting.js), and is read as a harness
// that knows where it is.
//
// Mounted before the app's JSON parser, with its own: an exporter batches,
// and a batch of a busy session is bigger than any request the console
// makes, so the ordinary limit would cut a harness off mid-afternoon. And
// mounted before the `/api` session middleware for the hook's route,
// `POST /api/harness/session`, because on the live site that middleware
// takes any bearer to be a Firebase id token and answers 401 before the
// route is reached - a harness token is not one, and is checked here.
//
// The answers are what the OTLP spec asks for - 200 with an empty object
// on success, a `partialSuccess` never, 401 for a token this app does not
// know - and a little more, for a person reading with curl: how many
// events were heard and what they became.
import express from "express";

import * as harnesses from "./harnesses.js";
import * as ingestToken from "./ingest-token.js";
import { platformOf } from "./machine-source.js";
import * as ingest from "./telemetry-ingest.js";
import { withSpan } from "./telemetry.js";
import * as sessionLog from "./sessions.js";
import * as recall from "./recall.js";

/** How big one export may be. Claude Code's default batch is a few hundred events; a day's backlog after a laptop wakes is more. */
export const MAX_EXPORT_BYTES = Number(process.env.CODERVIBES_OTLP_MAX_BYTES ?? 8 * 1024 * 1024);
/**
 * How big one hook request may be. The `ship` script the setup writes
 * posts a batch of up to twenty events, each the harness's event whole,
 * tool response and all; Claude Code caps a response at a few hundred
 * kilobytes, so twenty of the largest fit with room. A request over this
 * is answered 413, which the shipper reads as "refused, drop it" - it
 * must, or the batch would be offered again forever.
 */
export const HOOK_MAX_BYTES = 8 * 1024 * 1024;
/** How many events one hook request may carry; the shipper sends twenty. */
export const HOOK_MAX_EVENTS = 100;
/** A hook's `at` older than this is a backlog shipped late, and is dated by its own clock. */
export const HOOK_FRESH_MS = 30 * 1000;

/**
 * Who a bearer token is, or a 401.
 *
 * The default is the token check: a harness record's token, or the account's
 * one ingest token. There used to be a third - a machine this app booted
 * carried its own - and there is no such machine any more: everything that
 * reports here is somebody's own.
 */
async function byToken(token) {
  return (await harnesses.authenticate(token)) ?? (await ingestToken.authenticate(token));
}

/**
 * The 401 wall, or whoever the mount says a request is.
 *
 * A mount that was given its own `authenticate` is asked instead of the
 * token check, and is asked whatever the header says - there is no
 * `looksLikeToken` gate in front of it. That is the seam an installation
 * with one person and no accounts uses: nothing on their laptop holds a
 * token, so nothing sends one, and the answer is the one person.
 */
async function whoIs(req, res, authenticate) {
  const header = String(req.headers.authorization ?? "");
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (authenticate) {
    const who = await authenticate(token, req);
    if (who) return who;
    res.status(401).json({ error: { message: "That token is not one this app knows." } });
    return null;
  }
  if (!harnesses.looksLikeToken(token)) {
    res.status(401).json({ error: { message: "A harness token is required: Authorization: Bearer cvh1.…" } });
    return null;
  }
  const who = await byToken(token);
  if (!who) {
    res.status(401).json({ error: { message: "That token is not one this app knows. It may have been rotated; the Executors page shows the current one." } });
    return null;
  }
  return who;
}

/**
 * `e2bKeyFor` says where a machine is when only e2b knows - handed in
 * rather than imported so this module, which is the whole of the ingest
 * door, needs no connector behind it. Without one a machine is placed by
 * what it said about itself, which is what every machine that is not a
 * sandbox already relies on. `authenticate` is above.
 */
/** How big a recall request may be: a prompt and a branch name. */
export const RECALL_MAX_BYTES = 256 * 1024;

export function mountOtlp(app, { e2bKeyFor = async () => null, authenticate = null, mayRead = () => () => true } = {}) {
  const json = express.json({ limit: MAX_EXPORT_BYTES, type: ["application/json", "application/x-protobuf"] });

  const route = (signal, read) =>
    app.post(`/otlp/v1/${signal}`, json, async (req, res) => {
      const who = await whoIs(req, res, authenticate);
      if (!who) return;
      try {
        const result = await withSpan(
          "harness.export",
          { "cv.owner": who.user, "cv.harness.id": who.harness.id, "cv.harness.kind": who.harness.kind, "cv.otlp.signal": signal },
          () => read(who, req.body ?? {}),
        );
        harnesses.seen(who.user, who.harness.id).catch(() => null);
        res.status(200).json({ partialSuccess: {}, heard: result.heard, made: result.made, sessions: result.sessions });
      } catch (err) {
        const status = err.status ?? 500;
        if (status >= 500) console.warn(`[otlp] ${signal} from ${who.harness.id}: ${err.message}`);
        res.status(status).json({ error: { message: err.message } });
      }
    });

  route("logs", ingest.ingestLogs);
  route("metrics", ingest.ingestMetrics);
  route("traces", ingest.ingestTraces);

  // A body the parser refused - too big, or not JSON - is a 4xx with a
  // sentence, not the HTML page Express would write.
  app.use("/otlp", (err, req, res, next) => {
    if (!err) return next();
    const status = err.status ?? err.statusCode ?? 400;
    res.status(status >= 400 && status < 500 ? status : 400).json({ error: { message: err.type === "entity.too.large" ? `That export is bigger than ${MAX_EXPORT_BYTES} bytes; export more often.` : "The body is not JSON." } });
  });

  /**
   * The setup script's report of the machine it just ran on - see
   * ingest-token.js `noteSetup`. It answers with where the machine is
   * (machine-source.js `platformOf`), which the script keeps for its
   * hooks, so a person never has to say "this is a sandbox".
   */
  app.post("/api/harness/setup", express.json({ limit: "16kb" }), async (req, res) => {
    const who = await whoIs(req, res, authenticate);
    if (!who) return;
    try {
      const name = String(req.body?.machine ?? "").trim().slice(0, 120);
      if (!name) return res.status(400).json({ error: { message: "Which machine? The script sends its hostname or sandbox id." } });
      const markers = String(req.body?.markers ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
      const host = await platformOf({ platform: req.body?.platform ?? null, markers, machine: name }, { key: await e2bKeyFor(who.user) });
      // Filed under the token's executor, not under the name it reported: a
      // rebuilt sandbox comes back with a new id and the same token, and it
      // is the same executor. A real harness record (harnesses.js) has no
      // executor of its own and keeps the name-keyed id it always had.
      const machine = { id: who.executor ?? sessionLog.machineIdOf(host, name), name, host };
      const noted = await ingestToken.noteSetup(who.user, {
        machine,
        os: req.body?.os,
        harnesses: req.body?.harnesses,
        source: req.ip ?? null,
      });
      harnesses.seen(who.user, who.harness.id).catch(() => null);
      res.status(200).json({ machine, platform: host, harnesses: noted?.harnesses ?? [] });
    } catch (err) {
      res.status(err.status ?? 500).json({ error: { message: err.message } });
    }
  });

  // There is no /api/harness/gateway any more. The setup line used to ask
  // it for a key on the installation's LiteLLM proxy and route every
  // harness on the machine through it, unasked; the line now connects a
  // machine and nothing else, and a key is minted only for a sandbox this
  // app starts when its caller chose the proxy (sandbox-agents.js).

  /**
   * The hooks' reports - which checkout a session is in, what it was
   * asked, each tool it ran, what it said - see telemetry-ingest.js
   * `noteHook`. Its own JSON parser, for the reason at the top. The body
   * is `{events: [...]}` from the shipper the setup script writes, taken
   * in order, one after the other, since the second of a tool's two
   * events closes what the first opened; a body that is one event, from
   * a hook installed before there was a spool, is a batch of one. The
   * answer is what each became, in the same order.
   *
   * Nothing waits for this answer any more - the hook exited before the
   * request was made - so the work is done before answering rather than
   * queued: a 200 is what lets the shipper delete the events from disk,
   * and an event this app could not write must stay there.
   *
   * Each event's `at` is the machine's clock, in seconds, written when
   * the hook fired. A fresh one is dated here, to the millisecond, the
   * way it always was; one older than HOOK_FRESH_MS is a backlog shipped
   * after an outage or an offline afternoon, and is dated when it
   * happened, so the session reads at its own time rather than as an
   * hour's work done in the second the app came back.
   *
   * Where the machine is goes through the same answer as the setup
   * report's, so a hook that says nothing about its platform (an old
   * settings file, a sandbox whose mark is gone) is still placed right
   * when e2b knows the name.
   */
  app.post("/api/harness/session", express.json({ limit: HOOK_MAX_BYTES }), async (req, res) => {
    const who = await whoIs(req, res, authenticate);
    if (!who) return;
    const batch = Array.isArray(req.body?.events);
    const events = batch ? req.body.events : [req.body];
    if (events.length > HOOK_MAX_EVENTS) {
      res.status(413).json({ error: { message: `At most ${HOOK_MAX_EVENTS} events a request.` } });
      return;
    }
    const noted = [];
    let key;
    try {
      for (const event of events) {
        const machine = String(event?.machine ?? "").trim() || null;
        const said = Number(event?.at);
        const stale = Number.isFinite(said) && said > 0 && Date.now() - said * 1000 > HOOK_FRESH_MS;
        noted.push(await ingest.noteHook(who, {
          session: event?.session ?? event?.session_id ?? event?.input?.session_id,
          event: event?.event ?? null,
          at: stale ? said * 1000 : undefined,
          repo: event?.repo,
          branch: event?.branch,
          machine,
          platform: machine ? await platformOf({ platform: event?.platform ?? null, machine }, { key: (key ??= await e2bKeyFor(who.user)) }) : null,
          file: event?.file,
          input: event?.input ?? null,
          transcript: event?.transcript ?? null,
        }));
      }
      harnesses.seen(who.user, who.harness.id).catch(() => null);
      res.status(200).json(batch ? { noted } : noted[0]);
    } catch (err) {
      // A batch that failed part way: what was noted is said, so a reader
      // with curl can see how far it got; the shipper keeps the whole batch.
      res.status(err.status ?? 500).json({ error: { message: err.message }, noted: batch ? noted : undefined });
    }
  });

  /**
   * The context cache (recall.js). The prompt hook sends the prompt as
   * it is submitted and waits - the one hook that does - for what was
   * done here before, and prints the answer for the harness to put under
   * the prompt. Two hundred and four when there is nothing to say: a
   * prompt with no words in it, no past turn like it, no index yet. The
   * hook prints an empty body as nothing, and an empty answer costs the
   * agent nothing to read.
   *
   * `mayRead` is the owner's reading rule (index.js): a turn from a
   * session the owner cannot open is not offered. The session the prompt
   * belongs to is the same record the spooled prompt event lands on, so
   * the count of what was offered sits on the session the agent is in.
   */
  app.post("/api/harness/recall", express.json({ limit: RECALL_MAX_BYTES }), async (req, res) => {
    const who = await whoIs(req, res, authenticate);
    if (!who) return;
    const body = req.body ?? {};
    const prompt = String(body.input?.prompt ?? body.prompt ?? "").trim();
    const harnessSession = String(body.session ?? body.input?.session_id ?? "").trim();
    if (!prompt || !recall.worthAsking(prompt)) {
      res.status(204).end();
      return;
    }
    try {
      // The session the prompt belongs to - opened here when this is its
      // first prompt and the spooled event has not landed yet, so the two
      // meet on one record - but never taken back live: a recall is a
      // question about the past, not work on the session.
      const record = harnessSession ? await ingest.sessionFor(who, harnessSession, { at: Date.now(), revive: false }) : null;
      const { hits } = await recall.recall(prompt, {
        branch: String(body.branch ?? "").trim() || null,
        session: record?.id ?? null,
        allow: mayRead(who.user),
      });
      if (record) sessionLog.noteRecall(record.id, { offered: hits.length });
      if (!hits.length) {
        res.status(204).end();
        return;
      }
      const origin = /^https?:\/\/[^\s/]+$/.test(String(body.origin ?? "")) ? String(body.origin) : null;
      res.status(200).json(recall.hookOutput(recall.contextOf(hits, { origin })));
    } catch (err) {
      res.status(err.status ?? 500).json({ error: { message: err.message } });
    }
  });
}
