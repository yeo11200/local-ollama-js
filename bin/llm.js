#!/usr/bin/env node

import { mkdir, readFile, realpath, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const DEFAULT_MODEL = "qwen2.5-coder:14b";
const DEFAULT_HOST = "http://127.0.0.1:11434";
const DEFAULT_SESSION = "default";
const MAX_CONTEXT_MESSAGES = 20;

const systemPrompt = [
  "You are a local coding assistant for the current repository.",
  "Use the provided prompt and optional file context to answer implementation-focused questions.",
  "Give concise, implementation-focused answers.",
  "When suggesting edits, preserve existing project conventions.",
].join(" ");

const printHelp = () => {
  console.log(`Usage:
  llm "Summarize this repository."
  llm --session work "Continue from our previous discussion."
  llm --file README.md "Review this file."
  llm --reset-session work
  llm --list-sessions
  llm --show-session work

Options:
  --session <name>       Session name for remembered conversation (default: ${DEFAULT_SESSION})
  --file <path>          Include a local file as context. Can be repeated.
  --model <name>         Ollama model name (default: ${DEFAULT_MODEL})
  --host <url>           Ollama host (default: ${DEFAULT_HOST})
  --reset-session [name] Delete a session and exit
  --list-sessions        List saved sessions and exit
  --show-session [name]  Print a saved session as JSON and exit
  --json                 Print the raw Ollama JSON response
  --help                 Show this help

Environment:
  OLLAMA_MODEL           Default model override
  OLLAMA_HOST            Default host override
  LOCAL_OLLAMA_JS_HOME   Override app data directory for sessions
`);
};

const isFlag = (arg) => arg.startsWith("--");

const createOptions = (argv) => {
  const options = {
    files: [],
    positional: [],
    json: false,
    help: false,
    listSessions: false,
    resetSession: undefined,
    showSession: undefined,
    session: DEFAULT_SESSION,
    model: process.env.OLLAMA_MODEL || DEFAULT_MODEL,
    host: process.env.OLLAMA_HOST || DEFAULT_HOST,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--list-sessions") {
      options.listSessions = true;
    } else if (arg === "--session") {
      options.session = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg.startsWith("--session=")) {
      options.session = arg.slice("--session=".length);
    } else if (arg === "--file") {
      options.files.push(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg.startsWith("--file=")) {
      options.files.push(arg.slice("--file=".length));
    } else if (arg === "--model") {
      options.model = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg.startsWith("--model=")) {
      options.model = arg.slice("--model=".length);
    } else if (arg === "--host") {
      options.host = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg.startsWith("--host=")) {
      options.host = arg.slice("--host=".length);
    } else if (arg === "--reset-session") {
      const next = argv[index + 1];
      if (next && !isFlag(next)) {
        options.resetSession = next;
        index += 1;
      } else {
        options.resetSession = options.session;
      }
    } else if (arg.startsWith("--reset-session=")) {
      options.resetSession = arg.slice("--reset-session=".length);
    } else if (arg === "--show-session") {
      const next = argv[index + 1];
      if (next && !isFlag(next)) {
        options.showSession = next;
        index += 1;
      } else {
        options.showSession = options.session;
      }
    } else if (arg.startsWith("--show-session=")) {
      options.showSession = arg.slice("--show-session=".length);
    } else {
      options.positional.push(arg);
    }
  }

  options.host = options.host.replace(/\/$/, "");
  options.session = normalizeSessionName(options.session);

  if (typeof options.resetSession === "string") {
    options.resetSession = normalizeSessionName(options.resetSession);
  }

  if (typeof options.showSession === "string") {
    options.showSession = normalizeSessionName(options.showSession);
  }

  return options;
};

const readOptionValue = (argv, index, optionName) => {
  const value = argv[index + 1];

  if (!value || isFlag(value)) {
    throw new Error(`${optionName} requires a value.`);
  }

  return value;
};

const normalizeSessionName = (name) => {
  const normalized = String(name || DEFAULT_SESSION).trim();

  if (!/^[a-zA-Z0-9._-]+$/.test(normalized)) {
    throw new Error("Session names can only contain letters, numbers, dot, underscore, and dash.");
  }

  return normalized;
};

const getAppHome = () => process.env.LOCAL_OLLAMA_JS_HOME || join(homedir(), ".local-ollama-js");

const getSessionsDir = () => join(getAppHome(), "sessions");

const getSessionPath = (sessionName) => join(getSessionsDir(), `${sessionName}.json`);

const createEmptySession = (id, model) => ({
  id,
  model,
  updatedAt: new Date().toISOString(),
  messages: [],
});

const loadSession = async (sessionName, model) => {
  const path = getSessionPath(sessionName);

  try {
    const raw = await readFile(path, "utf8");
    const session = JSON.parse(raw);

    return {
      id: session.id || sessionName,
      model: session.model || model,
      updatedAt: session.updatedAt || new Date().toISOString(),
      messages: Array.isArray(session.messages) ? session.messages : [],
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return createEmptySession(sessionName, model);
    }

    throw error;
  }
};

const saveSession = async (session) => {
  await mkdir(getSessionsDir(), { recursive: true });
  session.updatedAt = new Date().toISOString();
  await writeFile(getSessionPath(session.id), `${JSON.stringify(session, null, 2)}\n`);
};

const deleteSession = async (sessionName) => {
  await rm(getSessionPath(sessionName), { force: true });
};

const listSessions = async () => {
  try {
    const entries = await readdir(getSessionsDir());
    return entries.filter((entry) => entry.endsWith(".json")).map((entry) => entry.slice(0, -5)).sort();
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }

    throw error;
  }
};

const readFileContexts = async (files) => {
  const contexts = [];

  for (const file of files) {
    const absolutePath = resolve(process.cwd(), file);
    const fileStat = await stat(absolutePath);

    if (!fileStat.isFile()) {
      throw new Error(`Not a file: ${file}`);
    }

    const content = await readFile(absolutePath, "utf8");
    contexts.push(`File: ${file}\n\n${content}`);
  }

  return contexts;
};

const buildUserContent = async (prompt, files) => {
  const parts = await readFileContexts(files);
  parts.push(prompt);
  return parts.join("\n\n---\n\n");
};

const buildMessages = (sessionMessages, userContent) => [
  {
    role: "system",
    content: systemPrompt,
  },
  ...sessionMessages.slice(-MAX_CONTEXT_MESSAGES),
  {
    role: "user",
    content: userContent,
  },
];

const chat = async ({ host, model, messages }) => {
  const response = await fetch(`${host}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      stream: false,
      messages,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama returned ${response.status}: ${text}`);
  }

  return response.json();
};

const printSession = async (sessionName) => {
  const session = await loadSession(sessionName, DEFAULT_MODEL);
  console.log(JSON.stringify(session, null, 2));
};

const run = async (argv = process.argv.slice(2)) => {
  const options = createOptions(argv);

  if (options.help || argv.length === 0) {
    printHelp();
    return;
  }

  if (options.listSessions) {
    const sessions = await listSessions();
    console.log(sessions.length ? sessions.join("\n") : "No sessions found.");
    return;
  }

  if (options.resetSession) {
    await deleteSession(options.resetSession);
    console.log(`Deleted session: ${options.resetSession}`);
    return;
  }

  if (options.showSession) {
    await printSession(options.showSession);
    return;
  }

  const prompt = options.positional.join(" ").trim();

  if (!prompt) {
    throw new Error("Prompt is required. Run `llm --help` for usage.");
  }

  const session = await loadSession(options.session, options.model);
  const userContent = await buildUserContent(prompt, options.files);
  const messages = buildMessages(session.messages, userContent);
  const data = await chat({ host: options.host, model: options.model, messages });
  const assistantContent = data.message?.content ?? "";

  session.model = options.model;
  session.messages.push(
    {
      role: "user",
      content: userContent,
      createdAt: new Date().toISOString(),
    },
    {
      role: "assistant",
      content: assistantContent,
      createdAt: new Date().toISOString(),
    },
  );

  await saveSession(session);

  if (options.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(assistantContent);
  }
};

const isDirectRun = async () => {
  if (!process.argv[1]) {
    return false;
  }

  return (await realpath(process.argv[1])) === (await realpath(fileURLToPath(import.meta.url)));
};

if (await isDirectRun()) {
  run().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    console.error("");
    console.error("Check that Ollama is installed, the server is running, and the model is pulled:");
    console.error("  ollama serve");
    console.error(`  ollama pull ${process.env.OLLAMA_MODEL || DEFAULT_MODEL}`);
    process.exit(1);
  });
}

export {
  buildMessages,
  buildUserContent,
  createOptions,
  deleteSession,
  getSessionPath,
  listSessions,
  loadSession,
  normalizeSessionName,
  run,
  saveSession,
};
