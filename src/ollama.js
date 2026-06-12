// Ollama HTTP API client: streaming chat, embeddings, and model listing.

const parseNdjsonStream = async function* (response) {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (line) {
        yield JSON.parse(line);
      }

      newlineIndex = buffer.indexOf("\n");
    }
  }

  const tail = buffer.trim();
  if (tail) {
    yield JSON.parse(tail);
  }
};

const postJson = async (host, path, body) => {
  const response = await fetch(`${host}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Ollama returned ${response.status}: ${text}`);
    error.status = response.status;
    error.body = text;
    throw error;
  }

  return response;
};

// Streams a chat completion. Calls onToken for each content fragment and
// returns the final assistant message { role, content, tool_calls? }.
const chatStream = async ({ host, model, messages, tools, onToken }) => {
  const body = { model, stream: true, messages };

  if (tools?.length) {
    body.tools = tools;
  }

  const response = await postJson(host, "/api/chat", body);
  let content = "";
  const toolCalls = [];

  for await (const data of parseNdjsonStream(response)) {
    if (data.error) {
      throw new Error(`Ollama stream error: ${data.error}`);
    }

    const fragment = data.message?.content ?? "";
    if (fragment) {
      content += fragment;
      onToken?.(fragment);
    }

    if (Array.isArray(data.message?.tool_calls)) {
      toolCalls.push(...data.message.tool_calls);
    }
  }

  const message = { role: "assistant", content };
  if (toolCalls.length) {
    message.tool_calls = toolCalls;
  }

  return message;
};

// True when the error means the model does not support native tool calling.
const isToolSupportError = (error) =>
  error?.status === 400 && /tool/i.test(error.body || error.message || "");

const embed = async ({ host, model, input }) => {
  const response = await postJson(host, "/api/embed", { model, input });
  const data = await response.json();
  return data.embeddings;
};

const listModels = async ({ host }) => {
  const response = await fetch(`${host}/api/tags`);

  if (!response.ok) {
    throw new Error(`Ollama returned ${response.status} while listing models.`);
  }

  const data = await response.json();
  return (data.models || []).map((model) => model.name);
};

export { chatStream, embed, isToolSupportError, listModels };
