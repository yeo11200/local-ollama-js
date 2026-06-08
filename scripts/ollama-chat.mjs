#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const DEFAULT_MODEL = "qwen2.5-coder:3b";
const DEFAULT_HOST = "http://127.0.0.1:11434";

const args = process.argv.slice(2);

const getArgValue = (name) => {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));

  if (inline) {
    return inline.slice(prefix.length);
  }

  const index = args.indexOf(name);

  if (index >= 0) {
    return args[index + 1];
  }

  return undefined;
};

const hasFlag = (name) => args.includes(name);

const printHelp = () => {
  console.log(`Usage:
  node scripts/ollama-chat.mjs "Summarize this repository."
  node scripts/ollama-chat.mjs --file README.md "Review this file."
  node scripts/ollama-chat.mjs --model llama3.1:8b "Summarize README.md."

Options:
  --file <path>       Include one local file as context
  --model <name>      Ollama model name (default: ${DEFAULT_MODEL})
  --host <url>        Ollama host (default: ${DEFAULT_HOST})
  --json             Print the raw Ollama JSON response
  --help             Show this help

Environment:
  OLLAMA_MODEL       Default model override
  OLLAMA_HOST        Default host override
`);
};

if (hasFlag("--help") || args.length === 0) {
  printHelp();
  process.exit(0);
}

const model = getArgValue("--model") || process.env.OLLAMA_MODEL || DEFAULT_MODEL;
const host = (getArgValue("--host") || process.env.OLLAMA_HOST || DEFAULT_HOST).replace(/\/$/, "");
const filePath = getArgValue("--file");
const rawJson = hasFlag("--json");

const promptParts = [];

if (filePath) {
  const absoluteFilePath = resolve(process.cwd(), filePath);
  const content = await readFile(absoluteFilePath, "utf8");

  promptParts.push(`File: ${filePath}\n\n${content}`);
}

const prompt = args
  .filter((arg, index) => {
    const previous = args[index - 1];
    return !arg.startsWith("--") && previous !== "--file" && previous !== "--model" && previous !== "--host";
  })
  .join(" ")
  .trim();

if (!prompt) {
  console.error("Error: prompt is required. Run `pnpm local-llm -- --help` for usage.");
  process.exit(1);
}

promptParts.push(prompt);

const system = [
  "You are a local coding assistant for the current repository.",
  "Use the provided prompt and optional file context to answer implementation-focused questions.",
  "Give concise, implementation-focused answers.",
  "When suggesting edits, preserve existing project conventions.",
].join(" ");

try {
  const response = await fetch(`${host}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        {
          role: "system",
          content: system,
        },
        {
          role: "user",
          content: promptParts.join("\n\n---\n\n"),
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama returned ${response.status}: ${text}`);
  }

  const data = await response.json();

  if (rawJson) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(data.message?.content ?? "");
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);

  console.error(`Failed to call Ollama at ${host}.`);
  console.error(message);
  console.error("");
  console.error("Check that Ollama is installed, the server is running, and the model is pulled:");
  console.error(`  ollama serve`);
  console.error(`  ollama pull ${model}`);
  process.exit(1);
}
