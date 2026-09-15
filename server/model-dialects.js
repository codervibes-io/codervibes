// One conversation, said in two dialects.
//
// The loop in the sandbox speaks the Anthropic Messages shape - a system
// prompt, a list of messages whose content is blocks, tools with an
// `input_schema` - and it will keep speaking it whichever model is at the
// other end: that shape is the one it was written and tested against, and
// three copies of the loop, one per provider, would be three places for the
// next bug. So the translation happens here, once, at the proxy, and the
// loop never learns it was talking to anyone but Anthropic.
//
// The other dialect is OpenAI's Chat Completions, which Google's Gemini also
// speaks at its compatibility endpoint - so this is one translation, not
// two. Only what the loop uses is translated: text, tool calls and tool
// results, images, the stop reason and the token counts. Anything else in a
// request is dropped rather than guessed at.

/**
 * An Anthropic Messages request as a Chat Completions one.
 *
 * @param {object} body what the loop sent
 * @param {{maxTokensField?: string}} provider where it is going
 */
export function toOpenAI(body, provider = {}) {
  const messages = [];
  const system = textOf(body.system);
  if (system) messages.push({ role: "system", content: system });

  for (const message of body.messages ?? []) {
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? [];
    if (message.role === "assistant") {
      const text = blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
      const calls = blocks
        .filter((block) => block.type === "tool_use")
        .map((block) => ({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        }));
      const entry = { role: "assistant", content: text || null };
      if (calls.length) entry.tool_calls = calls;
      messages.push(entry);
      continue;
    }
    // A user turn: tool results first, each its own message, because that is
    // where OpenAI expects them - directly after the call they answer. Then
    // whatever the person (or the loop) said alongside.
    for (const block of blocks) {
      if (block.type !== "tool_result") continue;
      messages.push({ role: "tool", tool_call_id: block.tool_use_id, content: resultText(block) });
    }
    const rest = blocks.filter((block) => block.type !== "tool_result").map(userPart).filter(Boolean);
    if (rest.length) {
      messages.push({
        role: "user",
        content: rest.every((part) => part.type === "text") ? rest.map((part) => part.text).join("") : rest,
      });
    }
  }

  const out = { model: body.model, messages };
  if (body.tools?.length) {
    out.tools = body.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.input_schema ?? { type: "object", properties: {} },
      },
    }));
  }
  const choice = toolChoice(body.tool_choice);
  if (choice) out.tool_choice = choice;
  if (body.max_tokens != null) out[provider.maxTokensField ?? "max_tokens"] = body.max_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.stop_sequences?.length) out.stop = body.stop_sequences;
  // Always asked for whole: the loop reads its answer whole, and a streamed
  // answer is put back together for the callers that asked for one.
  out.stream = false;
  return out;
}

/** The text of a system prompt that may be a string or blocks. */
function textOf(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/** A tool result's content, as the one string a tool message holds. */
function resultText(block) {
  const content = block.content;
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** One block of a user message, in the other shape; null for what has none. */
function userPart(block) {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "image" && block.source?.type === "base64") {
    return { type: "image_url", image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } };
  }
  if (block.type === "image" && block.source?.type === "url") {
    return { type: "image_url", image_url: { url: block.source.url } };
  }
  return null;
}

function toolChoice(choice) {
  if (!choice) return null;
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  if (choice.type === "tool") return { type: "function", function: { name: choice.name } };
  return null;
}

/**
 * A Chat Completions answer as an Anthropic message.
 *
 * Token counts are the one place the two disagree about meaning: OpenAI's
 * prompt count includes what was read from cache, Anthropic's excludes it.
 * The ledger prices the two differently, so the split is made here.
 */
export function fromOpenAI(reply, { model } = {}) {
  const choice = reply.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const content = [];
  if (message.content) content.push({ type: "text", text: String(message.content) });
  for (const call of message.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.function?.name,
      input: parseArguments(call.function?.arguments),
    });
  }
  const usage = reply.usage ?? {};
  const cached = Number(usage.prompt_tokens_details?.cached_tokens ?? 0);
  return {
    id: reply.id ?? "msg_translated",
    type: "message",
    role: "assistant",
    model: reply.model ?? model,
    content,
    stop_reason: stopReason(choice.finish_reason, content),
    stop_sequence: null,
    usage: {
      input_tokens: Math.max(0, Number(usage.prompt_tokens ?? 0) - cached),
      output_tokens: Number(usage.completion_tokens ?? 0),
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
    },
  };
}

/** The model's arguments, which are a JSON string - or, on a bad day, nearly one. */
function parseArguments(text) {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function stopReason(finish, content) {
  if (finish === "tool_calls" || finish === "function_call") return "tool_use";
  if (finish === "length") return "max_tokens";
  if (finish === "content_filter") return "refusal";
  // Some compatibility endpoints say "stop" even when they called a tool.
  if (content.some((block) => block.type === "tool_use")) return "tool_use";
  return "end_turn";
}

/**
 * An error, in the shape an Anthropic client reads.
 *
 * The status decides the type: what the two providers say in words differs,
 * what they say in numbers does not, and the loop and the agent's page both
 * read the message rather than the type anyway.
 */
export function errorFromOpenAI(status, body) {
  let message = "";
  try {
    const parsed = JSON.parse(body);
    message = parsed?.error?.message ?? parsed?.message ?? "";
  } catch {
    message = String(body ?? "").trim();
  }
  const type =
    status === 401 || status === 403
      ? "authentication_error"
      : status === 404
        ? "not_found_error"
        : status === 429
          ? "rate_limit_error"
          : status === 529
            ? "overloaded_error"
            : status >= 500
              ? "api_error"
              : "invalid_request_error";
  return { type: "error", error: { type, message: message || `the provider answered ${status}` } };
}

/**
 * A whole message as the stream a streaming client expects.
 *
 * The loop does not stream, but an Anthropic SDK pointed at this proxy
 * would, and answering `stream: true` with a JSON body is a client that
 * hangs. So the finished message is replayed as the events it would have
 * arrived as - one delta per block, which is coarse and correct.
 */
export function eventsFor(message) {
  const events = [];
  const push = (type, data) => events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  push("message_start", {
    message: { ...message, content: [], stop_reason: null, stop_sequence: null, usage: { ...message.usage, output_tokens: 0 } },
  });
  message.content.forEach((block, index) => {
    if (block.type === "text") {
      push("content_block_start", { index, content_block: { type: "text", text: "" } });
      push("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
    } else {
      push("content_block_start", { index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      push("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } });
    }
    push("content_block_stop", { index });
  });
  push("message_delta", {
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { output_tokens: message.usage.output_tokens },
  });
  push("message_stop", {});
  return events.join("");
}
