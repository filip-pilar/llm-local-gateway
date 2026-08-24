import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

function systemText(system) {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function anthropicImage(part) {
  const source = part?.source;
  if (source?.type === "url" && typeof source.url === "string") {
    return { type: "input_image", image_url: source.url };
  }
  if (
    source?.type === "base64" &&
    typeof source.media_type === "string" &&
    typeof source.data === "string"
  ) {
    return {
      type: "input_image",
      image_url: `data:${source.media_type};base64,${source.data}`,
    };
  }
  return null;
}

function outputText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return JSON.stringify(value ?? "");
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text") return part.text ?? "";
      if (part?.type === "image") return JSON.stringify(part);
      return "";
    })
    .join("");
}

function translateMessage(message) {
  const role = message?.role === "assistant" ? "assistant" : "user";
  if (typeof message?.content === "string") {
    return [{
      type: "message",
      role,
      content: [{
        type: role === "assistant" ? "output_text" : "input_text",
        text: message.content,
      }],
    }];
  }
  if (!Array.isArray(message?.content)) return [];

  const items = [];
  let content = [];
  const flush = () => {
    if (content.length === 0) return;
    items.push({ type: "message", role, content });
    content = [];
  };
  for (const part of message.content) {
    if (part?.type === "text" && typeof part.text === "string") {
      content.push({
        type: role === "assistant" ? "output_text" : "input_text",
        text: part.text,
      });
      continue;
    }
    if (part?.type === "image" && role === "user") {
      const image = anthropicImage(part);
      if (image) content.push(image);
      continue;
    }
    if (part?.type === "tool_use") {
      flush();
      items.push({
        type: "function_call",
        call_id: part.id,
        name: part.name,
        arguments: JSON.stringify(part.input ?? {}),
      });
      continue;
    }
    if (part?.type === "tool_result") {
      flush();
      items.push({
        type: "function_call_output",
        call_id: part.tool_use_id,
        output: outputText(part.content),
      });
    }
  }
  flush();
  return items;
}

function translateToolChoice(choice) {
  if (!choice || typeof choice !== "object") return undefined;
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  if (choice.type === "tool" && choice.name) {
    return { type: "function", name: choice.name };
  }
  return undefined;
}

export function anthropicToResponses(body) {
  const translated = {
    model: body.model,
    input: (body.messages ?? []).flatMap(translateMessage),
    stream: true,
  };
  const instructions = systemText(body.system);
  if (instructions) translated.instructions = instructions;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    translated.tools = body.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.input_schema ?? { type: "object", properties: {} },
    }));
  }
  const choice = translateToolChoice(body.tool_choice);
  if (choice !== undefined) translated.tool_choice = choice;
  if (Number.isInteger(body.max_tokens)) {
    translated.max_output_tokens = body.max_tokens;
  }
  for (const key of ["temperature", "top_p"]) {
    if (typeof body[key] === "number") translated[key] = body[key];
  }
  if (Array.isArray(body.stop_sequences)) {
    translated.stop = body.stop_sequences;
  }
  return translated;
}

function responseTextParts(output) {
  const content = [];
  for (const item of output ?? []) {
    if (item?.type === "message") {
      for (const part of item.content ?? []) {
        if (part?.type === "output_text" && typeof part.text === "string") {
          content.push({ type: "text", text: part.text });
        }
      }
    } else if (item?.type === "function_call") {
      let input = {};
      try {
        input = JSON.parse(item.arguments || "{}");
      } catch {}
      content.push({
        type: "tool_use",
        id: item.call_id ?? item.id,
        name: item.name,
        input,
      });
    }
  }
  return content;
}

function stopReason(response, content) {
  if (
    response?.status === "incomplete" ||
    response?.incomplete_details?.reason === "max_output_tokens"
  ) {
    return "max_tokens";
  }
  if (content.some((part) => part.type === "tool_use")) return "tool_use";
  return "end_turn";
}

export function responsesToAnthropic(response) {
  const content = responseTextParts(response?.output);
  return {
    id: response?.id ?? "msg_grok_bridge",
    type: "message",
    role: "assistant",
    model: response?.model ?? "grok-4.5",
    content,
    stop_reason: stopReason(response, content),
    stop_sequence: null,
    usage: {
      input_tokens: response?.usage?.input_tokens ?? 0,
      output_tokens: response?.usage?.output_tokens ?? 0,
    },
  };
}

function anthropicEvent(type, value) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
}

export function createAnthropicSSETransform({
  restoreEvent = (event) => event,
} = {}) {
  let pending = "";
  const decoder = new StringDecoder("utf8");
  let started = false;
  let nextBlock = 0;
  const textBlocks = new Map();
  const toolBlocks = new Map();
  const openBlocks = new Set();
  let model = "grok-4.5";
  let messageID = "msg_grok_bridge";
  let inputTokens = 0;
  let terminal = false;

  const start = (stream, response = {}) => {
    if (started) return;
    started = true;
    model = response.model ?? model;
    messageID = response.id ?? messageID;
    inputTokens = response.usage?.input_tokens ?? 0;
    stream.push(anthropicEvent("message_start", {
      message: {
        id: messageID,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    }));
  };
  const stopBlock = (stream, index) => {
    if (!openBlocks.has(index)) return;
    openBlocks.delete(index);
    stream.push(anthropicEvent("content_block_stop", { index }));
  };
  const handle = (stream, rawEvent) => {
    const event = restoreEvent(rawEvent);
    if (!event || typeof event !== "object" || terminal) return;
    start(stream, event.response);
    if (event.type === "response.created" || event.type === "response.in_progress") {
      return;
    }
    if (
      event.type === "response.content_part.added" &&
      event.part?.type === "output_text"
    ) {
      const index = nextBlock++;
      textBlocks.set(`${event.output_index ?? 0}:${event.content_index ?? 0}`, index);
      openBlocks.add(index);
      stream.push(anthropicEvent("content_block_start", {
        index,
        content_block: { type: "text", text: "" },
      }));
      return;
    }
    if (event.type === "response.output_text.delta") {
      const key = `${event.output_index ?? 0}:${event.content_index ?? 0}`;
      let index = textBlocks.get(key);
      if (index === undefined) {
        index = nextBlock++;
        textBlocks.set(key, index);
        openBlocks.add(index);
        stream.push(anthropicEvent("content_block_start", {
          index,
          content_block: { type: "text", text: "" },
        }));
      }
      stream.push(anthropicEvent("content_block_delta", {
        index,
        delta: { type: "text_delta", text: event.delta ?? "" },
      }));
      return;
    }
    if (event.type === "response.output_text.done") {
      const key = `${event.output_index ?? 0}:${event.content_index ?? 0}`;
      stopBlock(stream, textBlocks.get(key));
      return;
    }
    if (
      event.type === "response.output_item.added" &&
      event.item?.type === "function_call"
    ) {
      const index = nextBlock++;
      const key = event.item.id ?? event.item.call_id;
      toolBlocks.set(key, index);
      openBlocks.add(index);
      stream.push(anthropicEvent("content_block_start", {
        index,
        content_block: {
          type: "tool_use",
          id: event.item.call_id ?? event.item.id,
          name: event.item.name,
          input: {},
        },
      }));
      return;
    }
    if (event.type === "response.function_call_arguments.delta") {
      const index = toolBlocks.get(event.item_id ?? event.call_id);
      if (index === undefined) return;
      stream.push(anthropicEvent("content_block_delta", {
        index,
        delta: { type: "input_json_delta", partial_json: event.delta ?? "" },
      }));
      return;
    }
    if (
      event.type === "response.output_item.done" &&
      event.item?.type === "function_call"
    ) {
      stopBlock(stream, toolBlocks.get(event.item.id ?? event.item.call_id));
      return;
    }
    if (
      event.type === "response.completed" ||
      event.type === "response.incomplete"
    ) {
      terminal = true;
      for (const index of [...openBlocks]) stopBlock(stream, index);
      const final = responsesToAnthropic(event.response);
      stream.push(anthropicEvent("message_delta", {
        delta: {
          stop_reason: final.stop_reason,
          stop_sequence: final.stop_sequence,
        },
        usage: { output_tokens: final.usage.output_tokens },
      }));
      stream.push(anthropicEvent("message_stop", {}));
      return;
    }
    if (event.type === "response.failed" || event.type === "error") {
      terminal = true;
      const error = event.error ?? event.response?.error;
      stream.push(anthropicEvent("error", {
        error: {
          type: error?.type ?? "api_error",
          message: error?.message ?? "xAI request failed",
        },
      }));
    }
  };

  return new Transform({
    transform(chunk, _encoding, callback) {
      pending += decoder.write(chunk);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        try {
          handle(this, JSON.parse(line.slice(5).trim()));
        } catch {}
      }
      callback();
    },
    flush(callback) {
      pending += decoder.end();
      if (pending.startsWith("data:")) {
        try {
          handle(this, JSON.parse(pending.slice(5).trim()));
        } catch {}
      }
      if (!started) start(this);
      if (!terminal) {
        this.push(anthropicEvent("error", {
          error: {
            type: "api_error",
            message: "xAI stream ended without a terminal response event",
          },
        }));
      }
      callback();
    },
  });
}

export function countAnthropicTokens(body) {
  const payload = JSON.stringify({
    system: body?.system ?? "",
    messages: body?.messages ?? [],
    tools: body?.tools ?? [],
  });
  // xAI does not expose subscription tokenization through the CLI proxy.
  // This conservative local estimate keeps the Anthropic compatibility route
  // useful without sending a second billable inference request.
  return Math.max(1, Math.ceil(Buffer.byteLength(payload, "utf8") / 3.5));
}
