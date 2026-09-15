// One span per thing an agent did, and what a listener hears about it.
//
// telemetry.js is the spine every other record hangs off: the ledger, the
// activity feed, the session counts and the store all listen to finished
// spans rather than being told by each caller. So what these prove is the
// contract the listeners rely on - a span ends synchronously into a plain
// record with the ids on it, a child inherits the session and agent ids from
// its parent without being told, a client-timed span keeps the client's
// clock, and a `traceparent` from a sandbox names the parent it wants.
import test from "node:test";
import assert from "node:assert/strict";

const telemetry = await import("../server/telemetry.js");
const {
  withSpan, annotate, current, onSpan, retroSpan, contextOf, contextFrom, injectInto, traceparentOf,
  sessionContext, sessionTrace, endSession, cleanAttributes, toRecord, INHERITED, SPAN_NAMES, OTLP_ENDPOINT,
  ATTR_MAX, describe, telemetryInternals,
} = telemetry;

/** Collect the records a block of work produces. */
async function recorded(work) {
  const seen = [];
  const off = onSpan((record) => seen.push(record));
  try {
    await work();
  } finally {
    off();
  }
  return seen;
}

test("a span ends into a plain record, synchronously, with the ids and timing on it", async () => {
  let heard = null;
  const seen = await recorded(async () => {
    const out = await withSpan("tool.call", { "cv.tool.name": "read_file", "cv.agent.id": "a1" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "done";
    });
    assert.equal(out, "done", "the span returns what the work returned");
    heard = telemetryInternals.listeners.size;
  });
  assert.equal(seen.length, 1);
  const [record] = seen;
  assert.match(record.trace, /^[0-9a-f]{32}$/);
  assert.match(record.span, /^[0-9a-f]{16}$/);
  assert.equal(record.id, `${record.at}-${record.span}`);
  assert.equal(record.name, "tool.call");
  assert.equal(record.ok, true);
  assert.ok(record.ms >= 4, `the span measured its own duration, got ${record.ms}ms`);
  assert.equal(record.attrs["cv.tool.name"], "read_file");
  assert.equal(record.parent, null, "a span started outside any other is a root");
  assert.equal(heard, 1, "the listener was on while the work ran");
});

test("a throw ends the span failed and is rethrown; a tool that returns a failure says so on the span", async () => {
  const seen = await recorded(async () => {
    await assert.rejects(
      withSpan("tool.call", { "cv.tool.name": "run_command" }, async () => {
        throw new Error("no such command");
      }),
      /no such command/,
    );
    await withSpan("tool.call", { "cv.tool.name": "write_file" }, async () => {
      annotate({ "cv.tool.ok": false });
      return { isError: true };
    });
    await withSpan("model.call", { "cv.model": "m" }, async () => {
      annotate({ "cv.ok": false, "cv.http.status": 529 });
    });
  });
  assert.deepEqual(seen.map((record) => record.ok), [false, false, false]);
  assert.equal(seen[2].attrs["cv.http.status"], 529);
});

test("a span started inside another is its child, and inherits the session and agent ids", async () => {
  const seen = await recorded(async () => {
    await withSpan(
      "tool.call",
      { "cv.session.id": "ses_x", "cv.agent.id": "a1", "cv.agent.name": "Navigator", "cv.owner": "o", "cv.task.id": "t1", "cv.tool.name": "github_open_pull" },
      async () => {
        await withSpan("connector.call", { "cv.connector.id": "github" }, async () => {
          assert.equal(current()?.span?.length, 16, "the running span is the connector's");
        });
      },
    );
  });
  const [inner, outer] = seen;
  assert.equal(inner.name, "connector.call");
  assert.equal(inner.parent, outer.span);
  assert.equal(inner.trace, outer.trace);
  for (const key of INHERITED) {
    if (outer.attrs[key] !== undefined) assert.equal(inner.attrs[key], outer.attrs[key], `${key} is inherited`);
  }
  assert.equal(inner.session, "ses_x", "the record's session comes from the inherited attribute");
  assert.equal(inner.task, "t1");
  assert.equal(inner.attrs["cv.tool.name"], undefined, "what is not in INHERITED stays the parent's");
});

test("a session is one trace: its calls hang off a root that ends when the session does", async () => {
  const seen = await recorded(async () => {
    const ctx = sessionContext("ses_root", { "cv.agent.id": "a9", "cv.agent.kind": "resident", "cv.owner": "o" });
    assert.match(sessionTrace("ses_root"), /^[0-9a-f]{32}$/);
    await withSpan("tool.call", { "cv.tool.name": "read_file" }, async () => {}, { parent: ctx });
    await withSpan("model.call", { "cv.model": "m" }, async () => {}, { parent: sessionContext("ses_root") });
    assert.equal(endSession("ses_root", { "cv.spans": 2 }), true);
    assert.equal(endSession("ses_root"), false, "ending twice is a no");
    assert.equal(telemetryInternals.roots.has("ses_root"), false);
  });
  const [tool, model, root] = seen;
  assert.equal(root.name, "agent.session");
  assert.equal(root.session, "ses_root");
  assert.equal(root.attrs["cv.spans"], 2);
  assert.equal(tool.trace, root.trace);
  assert.equal(model.trace, root.trace);
  assert.equal(tool.parent, root.span);
  assert.equal(tool.session, "ses_root", "the session id reached the child");
  assert.equal(model.attrs["cv.agent.id"], "a9", "and so did the agent");
  assert.equal(model.attrs["cv.agent.kind"], "resident");
});

test("a span timed by somebody else keeps their clock, and says so", async () => {
  const startTime = Date.now() - 60_000;
  const seen = await recorded(async () => {
    const ids = retroSpan({
      name: "tool.call",
      startTime,
      endTime: startTime + 1234,
      attrs: { "cv.tool.name": "run_command", "cv.tool.kind": "sandbox", "cv.tool.ok": false },
    });
    assert.match(ids.trace, /^[0-9a-f]{32}$/);
  });
  const [record] = seen;
  assert.equal(record.at, startTime);
  assert.equal(record.ms, 1234);
  assert.equal(record.attrs["cv.retroactive"], true);
  assert.equal(record.kind, "sandbox", "a tool call's kind is the tool's kind");
  assert.equal(record.ok, false, "the reported failure is the span's status");
});

test("a retroactive span goes under the parent the client named, by raw ids", async () => {
  const traceId = "0af7651916cd43dd8448eb211c80319c";
  const spanId = "b7ad6b7169203331";
  const seen = await recorded(async () => {
    retroSpan({ parent: { traceId, spanId }, name: "tool.call", startTime: 1000, endTime: 1100, attrs: {} });
    retroSpan({ parent: { traceId: "not-hex", spanId }, name: "tool.call", startTime: 1000, endTime: 1100, attrs: {} });
    retroSpan({ parent: { traceId: "0".repeat(32), spanId }, name: "tool.call", startTime: 1000, endTime: 1100, attrs: {} });
  });
  assert.equal(seen[0].trace, traceId);
  assert.equal(seen[0].parent, spanId);
  assert.notEqual(seen[1].trace, traceId, "ids that are not ids start a trace of their own");
  assert.equal(seen[1].parent, null);
  assert.equal(seen[2].parent, null, "the all-zero trace id is not a trace");
  assert.equal(contextOf({ traceId: "x", spanId }), null);
});

test("an end before the start is a zero-length span, not a negative one", async () => {
  const seen = await recorded(async () => {
    retroSpan({ name: "tool.call", startTime: 5000, endTime: 4000, attrs: {} });
  });
  assert.equal(seen[0].ms, 0);
});

test("a traceparent header is honoured on the way in and written on the way out", async () => {
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const spanId = "00f067aa0ba902b7";
  const seen = await recorded(async () => {
    const parent = contextFrom({ traceparent: traceparentOf(traceId, spanId) });
    assert.ok(parent, "a traceparent names a context");
    await withSpan("tool.call", { "cv.tool.name": "x" }, async () => {
      const headers = injectInto({ authorization: "Bearer t" });
      assert.equal(headers.authorization, "Bearer t", "what was there stays");
      assert.match(headers.traceparent, new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`), "the running span is what goes out");
    }, { parent });
  });
  assert.equal(seen[0].trace, traceId);
  assert.equal(seen[0].parent, spanId);
  assert.equal(contextFrom({}), null, "no header, no context - so a caller can fall back to the session");
  assert.equal(contextFrom({ traceparent: "garbage" }), null);
  assert.equal(contextFrom(undefined), null);
});

test("attributes are counts and ids: absences dropped, strings cut, objects flattened to text", () => {
  const cleaned = cleanAttributes({
    a: undefined,
    b: null,
    c: "",
    n: 3,
    t: true,
    long: "x".repeat(ATTR_MAX + 50),
    list: ["a", null, 2],
    obj: { k: 1 },
  });
  assert.deepEqual(Object.keys(cleaned), ["c", "n", "t", "long", "list", "obj"], "an empty string is a value; null and undefined are not");
  assert.equal(cleaned.long.length, ATTR_MAX + 1, "cut at the limit, with a mark that it was");
  assert.deepEqual(cleaned.list, ["a", 2]);
  assert.equal(cleaned.obj, "[object Object]");
});

test("a listener that throws is kept from the caller and from the other listeners", async () => {
  const seen = [];
  const warned = [];
  const original = console.warn;
  console.warn = (line) => warned.push(line);
  const offBad = onSpan(() => { throw new Error("listener bug"); });
  const offGood = onSpan((record) => seen.push(record.name));
  try {
    await withSpan("tool.call", {}, async () => "ok");
  } finally {
    offBad();
    offGood();
    console.warn = original;
  }
  assert.deepEqual(seen, ["tool.call"]);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /listener failed: listener bug/);
});

test("the names are the closed set the pages group by, and the record's kind is the first word", async () => {
  assert.ok(SPAN_NAMES.includes("tool.call"));
  assert.ok(SPAN_NAMES.includes("model.call"));
  assert.ok(SPAN_NAMES.includes("agent.session"));
  const seen = await recorded(async () => {
    await withSpan("model.call", { "cv.model": "m" }, async () => {});
  });
  assert.equal(seen[0].kind, "model");
  // The record shape, once, so a store test and a page test agree on it.
  assert.deepEqual(Object.keys(seen[0]), ["id", "session", "task", "trace", "span", "parent", "name", "kind", "at", "ms", "ok", "attrs"]);
});

test("spans go out over OTLP only when an endpoint is set, and the banner says which", () => {
  // The suite runs without one, so this is the "kept here only" side; the
  // other side is the processor list growing by one when the variable is set.
  assert.equal(OTLP_ENDPOINT, process.env.OTEL_EXPORTER_OTLP_ENDPOINT || null);
  const processors = telemetryInternals.provider._activeSpanProcessor?._spanProcessors ?? [];
  const expected = OTLP_ENDPOINT ? 2 : 1;
  assert.equal(processors.length, expected, "the store processor, plus the exporter iff configured");
  assert.ok(processors[0] instanceof telemetryInternals.StoreSpanProcessor);
  if (OTLP_ENDPOINT) assert.match(describe(), /kept here and sent to /);
  else assert.match(describe(), /kept here only - set OTEL_EXPORTER_OTLP_ENDPOINT/);
});

test("the resource names the service, and the record never carries a span's own SDK objects", async () => {
  const seen = await recorded(async () => {
    await withSpan("tool.call", { "cv.tool.name": "x" }, async () => {});
  });
  assert.equal(typeof JSON.stringify(seen[0]), "string", "a record is plain JSON");
  const resource = telemetryInternals.provider.resource?.attributes ?? telemetryInternals.provider._resource?.attributes;
  assert.equal(resource?.["service.name"], "codervibes");
  assert.ok(["local", "production"].includes(resource?.["deployment.environment.name"]) || process.env.CODERVIBES_ENV);
  assert.equal(typeof toRecord, "function");
});
