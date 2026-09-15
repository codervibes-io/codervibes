// The loop speaks one dialect whichever model answers it. These are the
// translations, both ways, on the shapes the loop actually sends: a system
// prompt, tools with an input schema, an assistant turn that called a tool,
// a user turn that answered it.
import test from "node:test";
import assert from "node:assert/strict";

const { toOpenAI, fromOpenAI, errorFromOpenAI, eventsFor } = await import("../server/model-dialects.js");
const { providerOf, PROVIDERS, isValidModelId, whyNotAModel } = await import("../server/models.js");

const conversation = {
  model: "gpt-5",
  max_tokens: 8192,
  system: "You are Builder.",
  tools: [
    { name: "read_file", description: "Read one file", input_schema: { type: "object", properties: { path: { type: "string" } } } },
  ],
  messages: [
    { role: "user", content: "What is in README?" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Reading it." },
        { type: "tool_use", id: "call_1", name: "read_file", input: { path: "README.md" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "# Hello" }] },
        { type: "text", text: "Go on." },
      ],
    },
  ],
};

test("a request goes out as chat completions: system first, tool results as tool messages, tools as functions", () => {
  const out = toOpenAI(conversation, PROVIDERS.openai);
  assert.equal(out.model, "gpt-5");
  assert.equal(out.stream, false, "asked for whole; the loop reads it whole");
  assert.equal(out.max_completion_tokens, 8192, "the newer OpenAI models refuse max_tokens");
  assert.equal(out.max_tokens, undefined);
  assert.deepEqual(
    out.messages.map((message) => message.role),
    ["system", "user", "assistant", "tool", "user"],
    "a tool result is its own message, directly after the call it answers",
  );
  assert.equal(out.messages[0].content, "You are Builder.");
  assert.deepEqual(out.messages[2].tool_calls, [
    { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' } },
  ]);
  assert.equal(out.messages[2].content, "Reading it.");
  assert.deepEqual(out.messages[3], { role: "tool", tool_call_id: "call_1", content: "# Hello" });
  assert.equal(out.messages[4].content, "Go on.");
  assert.deepEqual(out.tools, [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read one file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    },
  ]);
  // Gemini's compatibility endpoint still wants the older name.
  assert.equal(toOpenAI(conversation, PROVIDERS.gemini).max_tokens, 8192);
});

test("an answer comes back as an Anthropic message, tool calls and all", () => {
  const message = fromOpenAI(
    {
      id: "chatcmpl-1",
      model: "gpt-5",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_2", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 120, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 100 } },
    },
    { model: "gpt-5" },
  );
  assert.equal(message.type, "message");
  assert.equal(message.role, "assistant");
  assert.deepEqual(message.content, [{ type: "tool_use", id: "call_2", name: "read_file", input: { path: "a" } }]);
  assert.equal(message.stop_reason, "tool_use");
  // OpenAI's prompt count includes the cache; Anthropic's does not, and the
  // ledger prices the two differently.
  assert.deepEqual(message.usage, {
    input_tokens: 20,
    output_tokens: 9,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 0,
  });

  const plain = fromOpenAI({ choices: [{ finish_reason: "stop", message: { content: "Done." } }], usage: {} });
  assert.deepEqual(plain.content, [{ type: "text", text: "Done." }]);
  assert.equal(plain.stop_reason, "end_turn");
  assert.equal(fromOpenAI({ choices: [{ finish_reason: "length", message: { content: "x" } }] }).stop_reason, "max_tokens");
  // Arguments that are not JSON are an empty input, not a crash mid-episode.
  const broken = fromOpenAI({
    choices: [{ finish_reason: "stop", message: { tool_calls: [{ id: "c", function: { name: "f", arguments: "{oops" } }] } }],
  });
  assert.deepEqual(broken.content[0].input, {});
  assert.equal(broken.stop_reason, "tool_use", "a tool was called even if the endpoint said stop");
});

test("a refusal is an Anthropic error, typed by its status, in the provider's words", () => {
  const error = errorFromOpenAI(401, JSON.stringify({ error: { message: "Incorrect API key provided", type: "invalid_request_error" } }));
  assert.deepEqual(error, { type: "error", error: { type: "authentication_error", message: "Incorrect API key provided" } });
  assert.equal(errorFromOpenAI(429, "{}").error.type, "rate_limit_error");
  assert.equal(errorFromOpenAI(503, "<html>bad gateway</html>").error.message, "<html>bad gateway</html>");
  assert.equal(errorFromOpenAI(500, "").error.message, "the provider answered 500");
});

test("a whole message replays as the stream a streaming client expects", () => {
  const message = fromOpenAI({
    id: "chatcmpl-2",
    choices: [{ finish_reason: "stop", message: { content: "Hi" } }],
    usage: { prompt_tokens: 3, completion_tokens: 1 },
  });
  const events = eventsFor(message)
    .split("\n\n")
    .filter(Boolean)
    .map((chunk) => chunk.split("\n")[0].replace("event: ", ""));
  assert.deepEqual(events, [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
  assert.match(eventsFor(message), /"usage":\{"output_tokens":1\}/);
});

test("a model id names its provider, listed or not", () => {
  assert.equal(providerOf("claude-opus-5"), PROVIDERS.anthropic);
  assert.equal(providerOf("gpt-5-mini"), PROVIDERS.openai);
  assert.equal(providerOf("gemini-2.5-pro"), PROVIDERS.gemini);
  // Not in the catalogue, placed by its family - a new model is usable the
  // day it ships.
  assert.equal(providerOf("gpt-6-preview"), PROVIDERS.openai);
  assert.equal(providerOf("o5"), PROVIDERS.openai);
  assert.equal(providerOf("gemini-3-ultra"), PROVIDERS.gemini);
  assert.equal(providerOf("claude-something-new"), PROVIDERS.anthropic);
  assert.equal(providerOf("llama-4"), null, "nobody here serves it, and the caller says so");
  assert.equal(providerOf(""), null);
  assert.ok(isValidModelId("gpt-4.1"));
  assert.ok(!isValidModelId("gpt 4"), "nothing with a space, or a header could be forged from it");
  assert.ok(!isValidModelId("../v1/models"));
});

test("a name nobody serves is refused where it is written, with the families named", () => {
  assert.equal(whyNotAModel("gpt-6-preview"), null, "placed by its family, so accepted");
  assert.equal(whyNotAModel("claude-opus-5"), null);
  assert.equal(whyNotAModel("gpt 4"), "That is not a model id.");
  // A typo in the box, which used to be accepted and turn up as the agent
  // being stuck on its first call.
  const why = whyNotAModel("gmflsh");
  assert.match(why, /Nobody here serves 'gmflsh'/);
  assert.match(why, /claude-fable-5, gpt-4o, gemini-3\.1-pro-preview/, "one example per provider, so the fix is a one-step one");
});
