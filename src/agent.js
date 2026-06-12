// Agent loop: send messages to the model, detect tool calls (native Ollama
// tool calling, or a <tool_call> text protocol for models without native
// support), execute them, feed results back, and repeat until the model
// produces a plain answer.

import { chatStream, isToolSupportError } from "./ollama.js";
import { describeToolCall, toolDefinitions } from "./tools.js";

const MAX_AGENT_STEPS = 20;

const agentSystemPrompt = (rootDir, skillList = "") => {
  const base = [
    "You are a coding agent working inside a local repository.",
    `Project root: ${rootDir}`,
    "You can call tools to read files, search code, edit files, and run shell commands.",
    "Only use tools when the user's request actually requires them.",
    "If the user is greeting you or making small talk, reply briefly and warmly in their language - no tools, no code analysis.",
    "Never modify files or run commands the user did not ask for.",
    "Work step by step: inspect relevant files before editing, and verify changes when possible.",
    "Use edit_file for targeted changes; use write_file only for new files or full rewrites.",
    "When the task is done, answer the user concisely in their language without calling more tools.",
  ].join(" ");

  if (!skillList) {
    return base;
  }

  return [
    base,
    "",
    "Available skills - when the user's task matches one, call use_skill with its name FIRST and follow the returned instructions:",
    skillList,
  ].join("\n");
};

// Text protocol used when the model lacks native tool calling. The model is
// told to emit exactly one tool call per turn inside <tool_call> tags.
const textProtocolPrompt = () => {
  const catalog = toolDefinitions
    .map((tool) => {
      const { name, description, parameters } = tool.function;
      return `- ${name}: ${description} Parameters: ${JSON.stringify(parameters.properties)}`;
    })
    .join("\n");

  return [
    "TOOLS: To use a tool, reply with ONLY this exact format (no other text before it):",
    '<tool_call>{"name": "<tool name>", "arguments": {<parameters>}}</tool_call>',
    "One tool call per reply. After each call you will receive the result and can continue.",
    "When you no longer need tools, reply with the final answer as plain text.",
    "Available tools:",
    catalog,
  ].join("\n");
};

// Extracts the first balanced JSON object starting at `from`. Local models
// often forget the closing </tool_call> tag, so we cannot rely on it.
const extractJsonObject = (text, from) => {
  const start = text.indexOf("{", from);

  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = inString;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
};

const TOOL_NAMES = new Set(toolDefinitions.map((tool) => tool.function.name));

const parseTextToolCall = (content) => {
  const markerIndex = content.indexOf("<tool_call>");

  if (markerIndex !== -1) {
    const json = extractJsonObject(content, markerIndex);

    if (json) {
      try {
        const parsed = JSON.parse(json);

        if (parsed && typeof parsed.name === "string") {
          return { name: parsed.name, arguments: parsed.arguments ?? {}, raw: json };
        }
      } catch {
        // Fall through to the model-specific formats below.
      }
    }
  }

  // DeepSeek models ignore the requested format and emit their trained
  // special-token syntax: <｜tool▁call▁begin｜>function<｜tool▁sep｜>NAME ```json {...} ```
  const deepseekMatch = content.match(/tool▁sep｜>\s*(\w+)/);

  if (deepseekMatch) {
    const json = extractJsonObject(content, deepseekMatch.index + deepseekMatch[0].length);

    if (json) {
      try {
        return { name: deepseekMatch[1], arguments: JSON.parse(json), raw: json };
      } catch {
        return null;
      }
    }
  }

  // Some models (observed with qwen2.5-coder) reply with a bare JSON object
  // instead of using the native API or any wrapper. Accept it only when the
  // whole message is that object and the name matches a real tool, so JSON
  // examples inside prose answers are never mistaken for calls.
  const bare = content.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");

  if (bare.startsWith("{")) {
    const json = extractJsonObject(bare, 0);

    if (json && bare.slice(json.length).trim() === "") {
      try {
        const parsed = JSON.parse(json);

        if (parsed && typeof parsed.name === "string" && TOOL_NAMES.has(parsed.name)) {
          return { name: parsed.name, arguments: parsed.arguments ?? {}, raw: json };
        }
      } catch {
        return null;
      }
    }
  }

  return null;
};

const normalizeNativeToolCall = (toolCall) => {
  const args = toolCall.function?.arguments;
  return {
    name: toolCall.function?.name,
    arguments: typeof args === "string" ? JSON.parse(args) : args ?? {},
  };
};

// Runs the agent loop. Mutates nothing; returns { messages, finalContent }
// where messages are the new messages to append to the session.
// events: { onToken, onToolStart, onToolEnd, onNotice } for UI feedback.
const runAgent = async ({
  host,
  model,
  rootDir = process.cwd(),
  history = [],
  userContent,
  executeTool,
  toolsEnabled = true,
  preferTextProtocol = false,
  skillList = "",
  events = {},
}) => {
  const newMessages = [{ role: "user", content: userContent }];
  let nativeTools = toolsEnabled && !preferTextProtocol;
  let textProtocol = preferTextProtocol;

  const buildSystemPrompt = () =>
    textProtocol
      ? `${agentSystemPrompt(rootDir, skillList)}\n\n${textProtocolPrompt()}`
      : agentSystemPrompt(rootDir, skillList);

  for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
    events.onStepStart?.();
    const messages = [
      { role: "system", content: buildSystemPrompt() },
      ...history,
      ...newMessages,
    ];

    let assistantMessage;
    try {
      assistantMessage = await chatStream({
        host,
        model,
        messages,
        tools: nativeTools && toolsEnabled ? toolDefinitions : undefined,
        onToken: events.onToken,
      });
    } catch (error) {
      if (toolsEnabled && nativeTools && isToolSupportError(error)) {
        // Model rejects the tools parameter: switch to the text protocol and retry.
        nativeTools = false;
        textProtocol = true;
        events.onNotice?.(`Model "${model}" has no native tool calling. Switching to text tool protocol.`);
        step -= 1;
        continue;
      }

      throw error;
    }

    const toolCalls = [];
    let usedTextSyntax = false;

    if (assistantMessage.tool_calls?.length) {
      for (const toolCall of assistantMessage.tool_calls) {
        toolCalls.push(normalizeNativeToolCall(toolCall));
      }
    } else if (toolsEnabled) {
      // Even native-tool models sometimes write the call as text instead of
      // using the API, so always try the text parsers as a fallback.
      const parsed = parseTextToolCall(assistantMessage.content);
      if (parsed) {
        toolCalls.push(parsed);
        usedTextSyntax = true;
      }
    }

    if (!toolCalls.length || !toolsEnabled) {
      // The model started a tool call but produced unparseable syntax. The
      // token printer already hid everything after the marker, so finishing
      // here would show the user an answer cut off mid-sentence. Bounce it
      // back to the model to retry instead.
      const looksLikeToolCall = /<tool_call>|tool▁/.test(assistantMessage.content);

      if (toolsEnabled && looksLikeToolCall) {
        events.onNotice?.("Malformed tool call from the model; asking it to retry.");
        newMessages.push(
          { role: "assistant", content: assistantMessage.content },
          {
            role: "user",
            content:
              'Your tool call could not be parsed. Reply with ONLY: <tool_call>{"name": "<tool name>", "arguments": {...}}</tool_call> using valid JSON, or answer in plain text without any tool-call syntax.',
          },
        );
        continue;
      }

      newMessages.push({ role: "assistant", content: assistantMessage.content });
      return { messages: newMessages, finalContent: assistantMessage.content, usedTextProtocol: textProtocol };
    }

    newMessages.push(
      assistantMessage.tool_calls?.length
        ? { role: "assistant", content: assistantMessage.content, tool_calls: assistantMessage.tool_calls }
        : { role: "assistant", content: assistantMessage.content },
    );

    for (const toolCall of toolCalls) {
      events.onToolStart?.(describeToolCall(toolCall.name, toolCall.arguments));
      const result = await executeTool(toolCall.name, toolCall.arguments);
      events.onToolEnd?.(toolCall.name, result);

      // Models that emitted the call as text get confused by the "tool"
      // role, so feed those results back as a user message instead.
      newMessages.push({
        role: textProtocol || usedTextSyntax ? "user" : "tool",
        content: `Tool ${toolCall.name} returned:\n${result}\n\nContinue the original task. Reply with another <tool_call> if needed, or give the final answer.`,
      });
    }
  }

  const stopNote = "Stopped: reached the maximum number of agent steps.";
  events.onNotice?.(stopNote);
  newMessages.push({ role: "assistant", content: stopNote });
  return { messages: newMessages, finalContent: stopNote, usedTextProtocol: textProtocol };
};

export { MAX_AGENT_STEPS, parseTextToolCall, runAgent, textProtocolPrompt };
