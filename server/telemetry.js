// Tracing: one emit, every view.
//
// What an agent does used to be recorded three times over - the activity
// feed kept a list, the cost ledger kept a list, the resident's report kept a
// list - and every one of them lived in this process's memory, so a deploy
// forgot all of it. Now a tool call, a model call, a turn, a report is one
// OpenTelemetry span. The span is what the activity feed, the ledger, the
// session record and the Activity page each read their own view from, and it
// is what leaves the building when somebody wants it to: set
// OTEL_EXPORTER_OTLP_ENDPOINT and the same spans go to Jaeger, Honeycomb,
// Grafana, whatever speaks OTLP. Without it they are kept here, in the store,
// so the product's own pages need no backend that is not this one.
//
// The SDK is used for what it is good at - a span with a parent, timestamps,
// the W3C `traceparent` header for crossing a process boundary, an exporter -
// and for nothing else. No auto-instrumentation: an express or fetch span per
// request would bury the product's own dozen spans under a thousand that
// nobody asked for.
//
// Attributes are `cv.*`. Every one of them is a count, an id or a name -
// never chat text, tool input, a file path. A span leaves through the OTLP
// door to a backend this installation does not run, and the sessions built
// from spans are everyone's to read (sessions.js): what goes on a span is
// what everyone on the installation may see.
//
// Two things the SDK does not do on its own:
//
// - A span whose times are somebody else's. A resident's loop notes its own
//   local calls with a clock but without an SDK (a sandbox carries no
//   telemetry library on purpose), and reports them later. `retroSpan`
//   makes a span from those times, under the trace the loop named, and marks
//   it `cv.retroactive` so a reader knows the timestamps are the loop's.
//
// - A session as a trace. An agent's MCP session, an assistant conversation,
//   a resident's run each get one long-lived root span (`agent.session`),
//   ended when the session ends; every call made in it is a child, so a
//   session is one trace in any backend, and the child inherits the session's
//   ids (`INHERITED`) without every caller repeating them.
//
// The SDK is asked for rather than imported, and which parts are asked for
// depends on where the spans are going. The five packages below are
// load-bearing - a span is how this app records anything, so without them
// there are no sessions, no ledger and no Activity page - and they are
// loaded on the way in, before anything can ask for a span. The *exporter*
// is not: it exists to send spans to somebody else's backend, and an
// installation that has named no backend never loads it. Written this way so
// the difference is legible, and so an installation that trims its
// dependencies can see which ones it may not trim.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const { trace, context, propagation, SpanStatusCode, TraceFlags, ROOT_CONTEXT } = await import("@opentelemetry/api");
const { NodeTracerProvider, BatchSpanProcessor } = await import("@opentelemetry/sdk-trace-node");
const { resourceFromAttributes } = await import("@opentelemetry/resources");
const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = await import("@opentelemetry/semantic-conventions");
const { W3CTraceContextPropagator } = await import("@opentelemetry/core");

/** The one service name every span carries; the backend groups by it. */
export const SERVICE_NAME = "codervibes";

/** Where spans go besides the store, or null. The SDK reads the same variable. */
export const OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || null;

/** A string attribute is cut here, like agentd's `brief`: enough to recognise, never the whole thing. */
export const ATTR_MAX = 200;

/**
 * The span names this codebase emits, in one place so a reader of the store
 * can grep for the lot. A name is `<what>.<happened>`; the `cv.tool.kind`
 * attribute says which flavour of tool a `tool.call` was.
 */
export const SPAN_NAMES = [
  "agent.session", // one per session, from open to end
  "agent.turn", // the assistant answering one message
  "agent.episode", // a resident doing one piece of work
  "tool.call", // any tool, by anyone
  "connector.call", // inside a tool.call: somebody else's service
  "model.call", // one request to a model
  "resident.report", // a resident's loop reporting what it did locally
  "github.webhook", // a delivery from the GitHub App
  "external.run", // a run by an agent that is not ours
  "skill.use", // a harness reporting a skill
  "harness.export", // one OTLP export from a harness on somebody's laptop (otlp.js)
  "gateway.call", // a gateway's own view of a model.call this app made through it (telemetry-ingest.js)
];

/**
 * Attributes a child takes from its parent when it has none of its own: who
 * did it, for whom, where, for which task, in which session. Set once on the
 * session's root span (or on a turn), read off every span underneath it.
 */
export const INHERITED = [
  "cv.session.id",
  "cv.agent.id",
  "cv.agent.name",
  "cv.agent.kind",
  "cv.owner",
  "cv.repo.id",
  "cv.task.id",
  "cv.harness.id",
  "cv.harness.kind",
];

const version = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "0";
  } catch {
    return "0";
  }
})();

// ---------------------------------------------------------------- records

/** An attribute value the store and the exporter both accept. */
function plain(value) {
  if (value == null) return undefined;
  if (typeof value === "string") return value.length > ATTR_MAX ? `${value.slice(0, ATTR_MAX)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry) => plain(entry)).filter((entry) => entry !== undefined);
  return plain(String(value));
}

/** Attributes without the empties, strings cut, for `startSpan`. */
export function cleanAttributes(attrs = {}) {
  const out = {};
  for (const [key, value] of Object.entries(attrs)) {
    const kept = plain(value);
    if (kept !== undefined) out[key] = kept;
  }
  return out;
}

const msOf = ([seconds, nanos]) => seconds * 1000 + nanos / 1e6;
/**
 * Epoch ms as the SDK's `[seconds, nanos]`. Given a bare number the SDK
 * guesses: one smaller than the process's uptime is taken as "ms since the
 * process started", not as a moment - and a client's clock is a moment.
 */
const hrTimeOf = (ms) => [Math.floor(ms / 1000), Math.round((ms % 1000) * 1e6)];

/**
 * The plain record of a finished span - what the store keeps and what every
 * listener gets. Ids are the SDK's hex. `kind` is the tool kind for a tool
 * call and the first word of the name otherwise, so a reader can group
 * without parsing names. `ok` is false when the span failed or the thing
 * said it did (`cv.tool.ok` on a tool call, `cv.ok` on anything else).
 */
export function toRecord(span) {
  const { traceId, spanId } = span.spanContext();
  const attrs = cleanAttributes(span.attributes);
  const at = Math.round(msOf(span.startTime));
  const ms = Math.max(0, Math.round(msOf(span.duration)));
  const failed = span.status?.code === SpanStatusCode.ERROR || attrs["cv.tool.ok"] === false || attrs["cv.ok"] === false;
  return {
    id: `${at}-${spanId}`,
    session: attrs["cv.session.id"] ?? null,
    task: attrs["cv.task.id"] ?? null,
    trace: traceId,
    span: spanId,
    parent: span.parentSpanContext?.spanId ?? span.parentSpanId ?? null,
    name: span.name,
    kind: attrs["cv.tool.kind"] ?? span.name.split(".")[0],
    at,
    ms,
    ok: !failed,
    attrs,
  };
}

// -------------------------------------------------------------- processor

const listeners = new Set();

/**
 * Hear every finished span, as a record. The listener runs synchronously
 * inside `span.end()`, so what it records is there before the call that
 * made the span returns - the activity feed and the ledger depend on that.
 * A listener that throws is somebody else's bug, kept from the caller.
 */
export function onSpan(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The processor that is always on: hands children their parent's ids on the
 * way in, and every finished span to the listeners on the way out.
 */
class StoreSpanProcessor {
  onStart(span, parentContext) {
    const parent = trace.getSpan(parentContext);
    const from = parent?.attributes;
    if (!from) return;
    for (const key of INHERITED) {
      if (from[key] !== undefined && span.attributes[key] === undefined) span.setAttribute(key, from[key]);
    }
  }

  onEnd(span) {
    let record = null;
    for (const listener of listeners) {
      try {
        record ??= toRecord(span);
        listener(record);
      } catch (err) {
        console.warn(`telemetry: a span listener failed: ${err.message}`);
      }
    }
  }

  shutdown() {
    return Promise.resolve();
  }

  forceFlush() {
    return Promise.resolve();
  }
}

const processors = [new StoreSpanProcessor()];
if (OTLP_ENDPOINT) {
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
  processors.push(new BatchSpanProcessor(new OTLPTraceExporter()));
}

const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: SERVICE_NAME,
    [ATTR_SERVICE_VERSION]: version,
    "deployment.environment.name": process.env.CODERVIBES_ENV ?? (process.env.FLY_APP_NAME ? "production" : "local"),
  }),
  spanProcessors: processors,
});
provider.register({ propagator: new W3CTraceContextPropagator() });

const tracer = trace.getTracer(SERVICE_NAME, version);

/** For the boot banner: where spans go. */
export function describe() {
  return OTLP_ENDPOINT
    ? `kept here and sent to ${OTLP_ENDPOINT}`
    : "kept here only - set OTEL_EXPORTER_OTLP_ENDPOINT to send spans out as well";
}

/** Push every buffered span out (the OTLP batch). For shutdown and tests. */
export const flush = () => provider.forceFlush();

// ------------------------------------------------------------------ spans

/**
 * Run `fn` inside a span. The span is active for the duration, so anything
 * `fn` starts - a connector call inside a tool call, a model call inside a
 * turn - lands underneath it without being told. A throw ends the span as
 * failed and is rethrown; a tool that *returns* a failure says so with
 * `cv.tool.ok: false` (see `annotate`). `parent` is a context, for a span
 * that belongs to a session or to a `traceparent` a client sent.
 */
export async function withSpan(name, attrs, fn, { parent = null } = {}) {
  const ctx = parent ?? context.active();
  return tracer.startActiveSpan(name, { attributes: cleanAttributes(attrs) }, ctx, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err?.message ?? err).slice(0, ATTR_MAX) });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Put attributes on whatever span is running, if one is. */
export function annotate(attrs) {
  const span = trace.getActiveSpan();
  if (span?.isRecording?.()) span.setAttributes(cleanAttributes(attrs));
  return span;
}

/** The trace and span ids of whatever span is running, or null. */
export function current() {
  const span = trace.getActiveSpan();
  if (!span) return null;
  const { traceId, spanId } = span.spanContext();
  return { trace: traceId, span: spanId };
}

const HEX = (length) => new RegExp(`^[0-9a-f]{${length}}$`);
const TRACE_ID = HEX(32);
const SPAN_ID = HEX(16);

/** A context whose current span is one named by raw ids - a parent minted elsewhere. */
export function contextOf({ traceId, spanId } = {}) {
  if (!TRACE_ID.test(traceId ?? "") || !SPAN_ID.test(spanId ?? "") || /^0+$/.test(traceId)) return null;
  return trace.setSpanContext(ROOT_CONTEXT, { traceId, spanId, traceFlags: TraceFlags.SAMPLED, isRemote: true });
}

/**
 * The context a request's headers name (`traceparent`), or null when they
 * name none. Null rather than the active context so the caller can fall
 * back to the session's root on purpose.
 */
export function contextFrom(headers = {}) {
  const ctx = propagation.extract(ROOT_CONTEXT, headers ?? {});
  return trace.getSpanContext(ctx) ? ctx : null;
}

/** The headers with `traceparent` for the running span (or `ctx`) added. */
export function injectInto(headers = {}, ctx = context.active()) {
  propagation.inject(ctx, headers);
  return headers;
}

/** A `traceparent` value for raw ids, the way a client without an SDK sends one. */
export const traceparentOf = (traceId, spanId) => `00-${traceId}-${spanId}-01`;

/**
 * A span whose times are somebody else's - see the essay. `parent` is a
 * context or raw `{traceId, spanId}`; `startTime`/`endTime` are epoch ms.
 * Marked `cv.retroactive` so a reader knows the clock was the client's.
 */
export function retroSpan({ parent = null, name, startTime, endTime, attrs = {} }) {
  const ctx = (parent && typeof parent === "object" && "traceId" in parent ? contextOf(parent) : parent) ?? ROOT_CONTEXT;
  const start = Number(startTime) || Date.now();
  const end = Math.max(start, Number(endTime) || start);
  const span = tracer.startSpan(name, { startTime: hrTimeOf(start), attributes: cleanAttributes({ ...attrs, "cv.retroactive": true }) }, ctx);
  if (attrs["cv.tool.ok"] === false) span.setStatus({ code: SpanStatusCode.ERROR });
  span.end(hrTimeOf(end));
  const { traceId, spanId } = span.spanContext();
  return { trace: traceId, span: spanId };
}

// --------------------------------------------------------------- sessions

/** Live session roots: session id -> the `agent.session` span. */
const roots = new Map();

/**
 * The context to make a session's calls in: its root span, started the first
 * time it is asked for with the attributes given, so everything under it
 * inherits them. Ended by `endSession`.
 */
export function sessionContext(sessionId, attrs = {}) {
  if (!sessionId) return context.active();
  let root = roots.get(sessionId);
  if (!root) {
    root = tracer.startSpan("agent.session", { attributes: cleanAttributes({ ...attrs, "cv.session.id": sessionId }) }, ROOT_CONTEXT);
    roots.set(sessionId, root);
  }
  return trace.setSpan(ROOT_CONTEXT, root);
}

/** The trace id a session's calls share, once its root exists. */
export function sessionTrace(sessionId) {
  return roots.get(sessionId)?.spanContext().traceId ?? null;
}

/** End a session's root span; its record leaves through the listeners like any other. */
export function endSession(sessionId, attrs = {}) {
  const root = roots.get(sessionId);
  if (!root) return false;
  roots.delete(sessionId);
  root.setAttributes(cleanAttributes(attrs));
  root.end();
  return true;
}

/** A stable trace id for a thing without a session of its own - a webhook delivery, a poll. */
export const traceIdFor = (key) => createHash("sha256").update(String(key)).digest("hex").slice(0, 32);

/** For tests. */
export const telemetryInternals = { provider, roots, listeners, StoreSpanProcessor };
