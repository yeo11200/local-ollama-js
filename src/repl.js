// Interactive REPL: a Claude Code-style terminal session on top of the agent
// loop. Sessions are derived from the working directory and saved every turn,
// and the RAG index refreshes in the background on startup.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { createInterface } from "node:readline/promises";

const pkg = createRequire(import.meta.url)("../package.json");

import {
  buildUserContent,
  deleteSession,
  listSessions,
  loadSession,
  normalizeSessionName,
  saveSession,
} from "../bin/llm.js";
import { runAgent } from "./agent.js";
import { listModels } from "./ollama.js";
import { buildIndex, formatRetrievedContext, retrieve } from "./rag.js";
import { formatSkillList, getGlobalSkillsDir, loadSkills, suggestSkills } from "./skills.js";
import { createToolExecutor, describeToolCall } from "./tools.js";

const dim = (text) => `\u001b[2m${text}\u001b[0m`;
const cyan = (text) => `\u001b[36m${text}\u001b[0m`;
const yellow = (text) => `\u001b[33m${text}\u001b[0m`;

const pink = (text) => `\u001b[95m${text}\u001b[0m`;
const bold = (text) => `\u001b[1m${text}\u001b[0m`;

const boxWidth = () => Math.max(20, Math.min((process.stdout.columns || 80) - 2, 78));

// Claude Code-style welcome banner with a pixel mascot.
const printBanner = ({ model, host, rootDir }) => {
  const home = process.env.HOME || "";
  const shortRoot = home && rootDir.startsWith(home) ? `~${rootDir.slice(home.length)}` : rootDir;

  console.log("");
  console.log(`  ${pink("▐▛███▜▌")}   ${bold("Local Ollama Agent")} ${dim(`v${pkg.version}`)}`);
  console.log(`  ${pink("▝▜█▙█▛▘")}   ${model} ${dim(`· ${host}`)}`);
  console.log(`   ${pink("▘▘ ▝▝")}    ${dim(shortRoot)}`);
  console.log("");
};

// The input box is drawn in pieces: the top edge is printed as normal output
// and only the single-line "│ ❯ " becomes the readline prompt. readline
// assumes single-line prompts for cursor math, so embedding newlines in the
// prompt breaks tab-completion lists and redraws at the bottom of the screen.
const openBox = () => {
  console.log(`\n${dim(`╭${"─".repeat(boxWidth())}`)}`);
};

const promptLine = () => `${dim("│")} ${cyan("❯")} `;

const closeBox = () => {
  console.log(dim(`╰${"─".repeat(boxWidth())}`));
};

// Push the prompt up from the bottom edge of the terminal: print blank lines
// (scrolling everything up) and move the cursor back, leaving breathing room
// below for completion lists and streamed output. Claude Code does the same
// with its full TUI; this is the readline-friendly equivalent.
// Override with LLM_BOTTOM_MARGIN=<rows> (0 disables).
const reserveBottomSpace = () => {
  if (!process.stdout.isTTY) {
    return;
  }

  const terminalRows = process.stdout.rows || 24;
  const requested = process.env.LLM_BOTTOM_MARGIN === undefined ? 50 : Number(process.env.LLM_BOTTOM_MARGIN) || 0;
  // Always keep ~12 rows for the banner and conversation above the prompt.
  const margin = Math.min(requested, Math.max(0, terminalRows - 12));

  if (margin > 0) {
    process.stdout.write("\n".repeat(margin) + `\u001b[${margin}A`);
  }
};

const projectSessionName = (rootDir) => {
  const slug = basename(rootDir).replace(/[^a-zA-Z0-9._-]/g, "-") || "project";
  const hash = createHash("sha1").update(rootDir).digest("hex").slice(0, 6);
  return `proj-${slug}-${hash}`;
};

// Streams assistant tokens but cuts the output the moment a tool-call marker
// appears anywhere in the stream, so raw protocol JSON never reaches the
// screen - models often write prose first and then emit the tool call.
// Reset per assistant message.
const createTokenPrinter = () => {
  // <tool_call> is our text protocol; <｜tool is DeepSeek's trained syntax.
  const MARKERS = ["<tool_call>", "<｜tool"];
  // Hold back enough characters to recognize a marker split across fragments.
  const HOLD = Math.max(...MARKERS.map((marker) => marker.length)) - 1;
  let pending = "";
  let suppress = false;
  // Messages that open with "{" or a code fence may be a bare JSON tool call
  // (observed with qwen2.5-coder). Buffer the whole message: discard() drops
  // it when the agent consumed it as a tool call, reset() prints it when it
  // turned out to be a real answer. null = undecided yet.
  let holdAll = null;

  return {
    push(fragment) {
      if (suppress) {
        return;
      }

      pending += fragment;

      if (holdAll === null) {
        const head = pending.trimStart();

        if (!head) {
          return;
        }

        if (head.length < 3 && "```".startsWith(head)) {
          return;
        }

        holdAll = head.startsWith("{") || head.startsWith("```");
      }

      if (holdAll) {
        return;
      }

      for (const marker of MARKERS) {
        const markerIndex = pending.indexOf(marker);

        if (markerIndex !== -1) {
          if (markerIndex > 0) {
            process.stdout.write(pending.slice(0, markerIndex));
          }
          pending = "";
          suppress = true;
          return;
        }
      }

      if (pending.length > HOLD) {
        process.stdout.write(pending.slice(0, pending.length - HOLD));
        pending = pending.slice(pending.length - HOLD);
      }
    },
    reset() {
      if (!suppress && pending.trim()) {
        process.stdout.write(pending);
      }

      pending = "";
      suppress = false;
      holdAll = null;
    },
    // Drop the held buffer: the message was consumed as a tool call.
    discard() {
      pending = "";
      suppress = false;
      holdAll = null;
    },
  };
};

const COMMANDS = [
  "/help", "/model", "/models", "/session", "/sessions", "/reset",
  "/rag", "/reindex", "/tools", "/file", "/skill", "/skills", "/exit",
];

// Tab-completion for slash commands: type "/" then Tab to list them all,
// or a partial command then Tab to complete it. "/skill <Tab>" completes
// installed skill names.
const completeCommand = (line, skillNames = []) => {
  if (!line.startsWith("/")) {
    return [[], line];
  }

  const skillArg = line.match(/^\/skill\s+(\S*)$/);

  if (skillArg) {
    const hits = skillNames.filter((name) => name.startsWith(skillArg[1])).map((name) => `/skill ${name}`);
    return [hits, line];
  }

  if (line.includes(" ")) {
    return [[], line];
  }

  const hits = COMMANDS.filter((command) => command.startsWith(line));
  return [hits.length ? hits : COMMANDS, line];
};

// Claude Code-style waiting indicator: an animated status line with the
// elapsed time, cleared the moment the first token or tool event arrives.
const SPINNER_FRAMES = ["✳", "✶", "✻", "✽", "✻", "✶"];
const SPINNER_VERBS = ["Thinking", "Pondering", "Brewing", "Reasoning", "Cooking", "Untangling"];

const createSpinner = () => {
  let timer = null;
  let startedAt = 0;
  let verb = "";

  const render = () => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const frame = SPINNER_FRAMES[Math.floor((Date.now() - startedAt) / 160) % SPINNER_FRAMES.length];
    process.stdout.write(`\r\u001b[2K${pink(frame)} ${dim(`${verb}… (${elapsed}s)`)}`);
  };

  return {
    start() {
      if (!timer) {
        verb = SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)];
        startedAt = Date.now();
        timer = setInterval(render, 120);
      }
      render();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        process.stdout.write("\r\u001b[2K");
      }
    },
  };
};

const HELP = `
Commands:
  /help                 Show this help
  /model <name>         Switch model (history is kept)
  /models               List installed Ollama models
  /session [name]       Show or switch session
  /sessions             List saved sessions
  /reset                Clear the current session history
  /rag on|off           Toggle retrieval context (default: on)
  /reindex              Rebuild the RAG index now
  /tools on|off         Toggle agent tools (default: on)
  /file <path>          Attach a file to the next prompt
  /skills               Rescan and list installed skills
  /skill <name>         Load a skill's instructions into the next prompt
  /exit                 Quit

Anything else is sent to the model. The agent can read/search/edit files and
run commands in this directory; destructive actions ask for approval first.

Skills are SKILL.md files (YAML frontmatter: name, description) in
~/.local-ollama-js/skills/<name>/ (global) or <project>/.llm/skills/<name>/
(project, overrides global). The model can also load them itself via the
use_skill tool when a task matches a skill description.
`;

const startRepl = async ({ host, model, session: sessionFlag } = {}) => {
  const rootDir = process.cwd();
  const state = {
    host,
    model,
    sessionName: sessionFlag || projectSessionName(rootDir),
    ragEnabled: true,
    toolsEnabled: true,
    pendingFiles: [],
    pendingSkills: [],
    skills: [],
    alwaysAllowed: new Set(),
    // Remembered across turns so models without native tool calling do not
    // pay a failed request on every prompt.
    preferTextProtocol: false,
  };

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: (line) => completeCommand(line, state.skills.map((skill) => skill.name)),
  });
  // Hold input until the line loop below is attached, otherwise lines that
  // arrive during async startup (e.g. piped stdin) are silently dropped.
  rl.pause();
  const printer = createTokenPrinter();
  const spinner = createSpinner();

  const approve = async (name, args) => {
    if (state.alwaysAllowed.has(name)) {
      return true;
    }

    let answer;
    try {
      answer = (
        await rl.question(`${yellow("⚠")} ${describeToolCall(name, args)}\n  Allow? [y]es / [n]o / [a]lways for ${name}: `)
      )
        .trim()
        .toLowerCase();
    } catch {
      // Input closed (Ctrl+D or piped stdin ran out): treat as a decline.
      return false;
    }

    if (answer === "a") {
      state.alwaysAllowed.add(name);
      return true;
    }

    return answer === "y" || answer === "yes";
  };

  const executeTool = createToolExecutor({
    rootDir,
    approve,
    getSkill: (name) => state.skills.find((skill) => skill.name === name),
  });

  // Note: the session remembers its last model for display/history purposes,
  // but the active model always follows the flag/env/default so changing the
  // default actually takes effect on existing sessions.
  let session = await loadSession(state.sessionName, state.model);
  state.skills = await loadSkills(rootDir);

  printBanner({ model: state.model, host: state.host, rootDir });
  console.log(
    dim(
      `  session ${state.sessionName} · ${session.messages.length} saved messages · ${state.skills.length} skills · /help for commands · /exit to quit`,
    ),
  );

  // Refresh the RAG index in the background; the first question awaits it.
  let indexReady = buildIndex({ rootDir, host: state.host })
    .then((result) => {
      console.log(dim(`rag: indexed ${result.chunkCount} chunks from ${result.fileCount} files (${result.mode} mode)`));
      showPrompt();
      return result;
    })
    .catch((error) => {
      console.log(dim(`rag: indexing failed (${error.message}); continuing without retrieval`));
      return null;
    });

  const handleCommand = async (line) => {
    const [command, ...rest] = line.split(/\s+/);
    const argument = rest.join(" ").trim();

    switch (command) {
      case "/":
        // Bare "/": list available commands (Tab also completes them).
        console.log(COMMANDS.map((name) => `  ${name}`).join("\n"));
        console.log(dim("  Type a command, or press Tab after / to autocomplete. /help for details."));
        return true;
      case "/help":
        console.log(HELP);
        return true;
      case "/exit":
      case "/quit":
        rl.close();
        return true;
      case "/model":
        if (!argument) {
          console.log(`Current model: ${state.model}`);
        } else {
          state.model = argument;
          state.preferTextProtocol = false;
          console.log(`Switched model to ${state.model}. (Pull it first if needed: ollama pull ${state.model})`);
        }
        return true;
      case "/models":
        try {
          const models = await listModels({ host: state.host });
          console.log(models.length ? models.join("\n") : "No models installed.");
        } catch (error) {
          console.log(`Could not list models: ${error.message}`);
        }
        return true;
      case "/session":
        if (!argument) {
          console.log(`Current session: ${state.sessionName} (${session.messages.length} messages)`);
        } else {
          state.sessionName = normalizeSessionName(argument);
          session = await loadSession(state.sessionName, state.model);
          console.log(`Switched to session ${state.sessionName} (${session.messages.length} messages).`);
        }
        return true;
      case "/sessions": {
        const sessions = await listSessions();
        console.log(sessions.length ? sessions.join("\n") : "No sessions found.");
        return true;
      }
      case "/reset":
        await deleteSession(state.sessionName);
        session = await loadSession(state.sessionName, state.model);
        console.log(`Session ${state.sessionName} cleared.`);
        return true;
      case "/rag":
        state.ragEnabled = argument !== "off";
        console.log(`RAG ${state.ragEnabled ? "enabled" : "disabled"}.`);
        return true;
      case "/reindex":
        indexReady = buildIndex({ rootDir, host: state.host }).then((result) => {
          console.log(dim(`rag: indexed ${result.chunkCount} chunks from ${result.fileCount} files (${result.mode} mode)`));
          return result;
        });
        await indexReady;
        return true;
      case "/tools":
        state.toolsEnabled = argument !== "off";
        console.log(`Tools ${state.toolsEnabled ? "enabled" : "disabled"}.`);
        return true;
      case "/file":
        if (!argument) {
          console.log("Usage: /file <path>");
        } else {
          state.pendingFiles.push(argument);
          console.log(`Attached ${argument} to the next prompt.`);
        }
        return true;
      case "/skills":
        state.skills = await loadSkills(rootDir);
        if (state.skills.length) {
          console.log(state.skills.map((skill) => `  ${skill.name} ${dim(`(${skill.source})`)} — ${skill.description}`).join("\n"));
        } else {
          console.log(`No skills installed. Create one at ${getGlobalSkillsDir()}/<name>/SKILL.md`);
        }
        return true;
      case "/skill": {
        if (!argument) {
          if (state.skills.length) {
            console.log(state.skills.map((skill) => `  /skill ${skill.name} — ${skill.description}`).join("\n"));
          } else {
            console.log(`No skills installed. Create one at ${getGlobalSkillsDir()}/<name>/SKILL.md`);
          }
          return true;
        }
        const skill = state.skills.find((entry) => entry.name === argument);
        if (!skill) {
          console.log(`Skill not found: ${argument}. Run /skills to see what is installed.`);
        } else {
          state.pendingSkills.push(skill);
          console.log(`Skill "${skill.name}" will guide the next prompt.`);
        }
        return true;
      }
      default:
        console.log(`Unknown command: ${command}. Try /help.`);
        return true;
    }
  };

  const handlePrompt = async (prompt) => {
    let contextParts = [];

    // Skills queued with /skill: inject their full instructions up front.
    for (const skill of state.pendingSkills) {
      contextParts.push(`Skill "${skill.name}" instructions - follow these for this task:\n\n${skill.body}`);
    }

    // Local models rarely call use_skill on their own even when nudged, so
    // skill activation is deterministic: a strong keyword match (2+ hits)
    // injects the skill body directly; a weak match only nudges the model.
    const queuedNames = new Set(state.pendingSkills.map((skill) => skill.name));
    const suggested = suggestSkills(state.skills, prompt).filter((skill) => !queuedNames.has(skill.name));

    for (const skill of suggested) {
      if (skill.hits >= 2) {
        contextParts.push(`Skill "${skill.name}" instructions - follow these for this task:\n\n${skill.body}`);
        console.log(dim(`  ⚡ skill loaded: ${skill.name}`));
      } else {
        contextParts.push(
          `Skill suggestion: this request may match "${skill.name}" (${skill.description}). ` +
            `If it does, call the use_skill tool with that name first and follow its instructions.`,
        );
        console.log(dim(`  ⚡ skill suggestion: ${skill.name}`));
      }
    }

    state.pendingSkills = [];
    spinner.start();

    if (state.ragEnabled) {
      await indexReady;
      try {
        const results = await retrieve({ rootDir, host: state.host, query: prompt });
        const formatted = formatRetrievedContext(results);
        if (formatted) {
          contextParts.push(formatted);
        }
      } catch {
        // Retrieval is best-effort; the agent can still read files itself.
      }
    }

    const files = state.pendingFiles;
    state.pendingFiles = [];

    let userContent;
    try {
      userContent = await buildUserContent(prompt, files);
    } catch (error) {
      spinner.stop();
      console.log(`Could not read attached file: ${error.message}`);
      return;
    }

    if (contextParts.length) {
      userContent = [...contextParts, userContent].join("\n\n---\n\n");
    }

    try {
      const { messages, finalContent, usedTextProtocol } = await runAgent({
        host: state.host,
        model: state.model,
        rootDir,
        history: session.messages.slice(-20),
        userContent,
        executeTool,
        toolsEnabled: state.toolsEnabled,
        preferTextProtocol: state.preferTextProtocol,
        skillList: formatSkillList(state.skills),
        events: {
          onStepStart: () => {
            printer.reset();
            spinner.start();
          },
          onToken: (fragment) => {
            spinner.stop();
            printer.push(fragment);
          },
          onToolStart: (description) => {
            spinner.stop();
            // The message that produced this tool call may be sitting in the
            // printer's hold buffer (bare-JSON calls) - drop it, not print it.
            printer.discard();
            console.log(`\n${cyan("⏺")} ${description}`);
          },
          onToolEnd: (name, result) => {
            const firstLine = String(result).split("\n")[0];
            console.log(dim(`  ⎿ ${firstLine.slice(0, 120)}`));
          },
          onNotice: (notice) => {
            spinner.stop();
            // Notices accompany protocol hiccups (fallback switch, malformed
            // tool call retry) - whatever is held in the buffer is protocol
            // noise, not an answer.
            printer.discard();
            console.log(dim(`\n${notice}`));
          },
        },
      });

      spinner.stop();
      printer.reset();
      process.stdout.write("\n");

      // The printer suppresses anything starting with <tool_call>; if such a
      // message survived as the final answer it failed to parse, so show it
      // raw instead of leaving the user with a blank response.
      if ((finalContent || "").trimStart().startsWith("<tool_call>")) {
        console.log(dim("(model emitted a tool call that could not be parsed)"));
        console.log(finalContent);
      }

      if (usedTextProtocol) {
        state.preferTextProtocol = true;
      }

      const now = new Date().toISOString();
      session.model = state.model;
      session.messages.push(...messages.map((message) => ({ ...message, createdAt: now })));
      await saveSession(session);
    } catch (error) {
      spinner.stop();
      console.error(`\nError: ${error.message}`);
      console.error(dim(`Check Ollama is running (ollama serve) and the model is pulled (ollama pull ${state.model}).`));
    }
  };

  // Box bottom + hint line, redrawn below the input after every readline
  // refresh. readline wipes everything under the cursor (ESC[0J) each time
  // it re-renders the line, so a one-time pre-draw does not survive; hooking
  // _refreshLine keeps the footer alive. ESC 7/8 save and restore the cursor.
  let footerEnabled = false;

  const drawFooter = () => {
    if (!footerEnabled || !process.stdout.isTTY) {
      return;
    }

    process.stdout.write(
      `\u001b7\n${dim(`╰${"─".repeat(boxWidth())}`)}\n${dim("  /help for commands · Tab to autocomplete · /exit to quit")}\u001b8`,
    );
  };

  if (process.stdout.isTTY && typeof rl._refreshLine === "function") {
    const originalRefreshLine = rl._refreshLine.bind(rl);
    rl._refreshLine = () => {
      originalRefreshLine();
      drawFooter();
    };
  }

  const showPrompt = () => {
    openBox();
    footerEnabled = true;
    rl.setPrompt(promptLine());
    rl.prompt();
    drawFooter();
  };

  reserveBottomSpace();
  rl.resume();
  showPrompt();

  // Iterating the interface keeps working through buffered lines even if
  // stdin closes mid-command (e.g. piped input or Ctrl+D while processing).
  for await (const rawLine of rl) {
    const line = rawLine.trim();
    // Stop redrawing the footer while the turn is processed, so approval
    // prompts and streamed output do not get a stray box edge under them.
    footerEnabled = false;

    if (process.stdout.isTTY) {
      // The box bottom and hint line are already drawn below the input;
      // step past them instead of printing a second bottom edge.
      process.stdout.write("\n\n");
    } else {
      closeBox();
    }

    if (!line) {
      showPrompt();
      continue;
    }

    if (line.startsWith("/")) {
      await handleCommand(line);
    } else {
      await handlePrompt(line);
    }

    showPrompt();
  }

  console.log(dim("\nSession saved. Bye."));
  process.exit(0);
};

export { completeCommand, createTokenPrinter, projectSessionName, startRepl };
