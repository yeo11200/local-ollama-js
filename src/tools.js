// Agent tools: definitions (Ollama tool schema) and executors.
// Destructive tools (write_file, edit_file, run_command) go through an
// approval callback so the user confirms before anything touches disk.

import { exec } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const MAX_TOOL_OUTPUT_CHARS = 16_000;
const MAX_SEARCH_RESULTS = 50;

const EXCLUDED_DIRS = new Set([
  ".cache",
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "vendor",
]);

const truncate = (text, limit = MAX_TOOL_OUTPUT_CHARS) =>
  text.length > limit ? `${text.slice(0, limit)}\n[truncated ${text.length - limit} chars]` : text;

// Keeps tool access inside the project root so the model cannot escape the workspace.
const resolveInsideRoot = (rootDir, path) => {
  const absolute = resolve(rootDir, path);
  const rel = relative(rootDir, absolute);

  if (rel.startsWith(`..${sep}`) || rel === "..") {
    throw new Error(`Path escapes the project root: ${path}`);
  }

  return absolute;
};

const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file from the project. Returns the content with line numbers.",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "File path relative to the project root." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and directories at a path inside the project.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path relative to the project root. Defaults to the root." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search project files for a text pattern (case-insensitive substring). Returns matching lines as path:line:text.",
      parameters: {
        type: "object",
        required: ["pattern"],
        properties: {
          pattern: { type: "string", description: "Text to search for." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file with the given content. Use edit_file for small changes to existing files.",
      parameters: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string", description: "File path relative to the project root." },
          content: { type: "string", description: "Full file content to write." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace an exact text snippet in an existing file. old_text must match the file exactly and appear exactly once.",
      parameters: {
        type: "object",
        required: ["path", "old_text", "new_text"],
        properties: {
          path: { type: "string", description: "File path relative to the project root." },
          old_text: { type: "string", description: "Exact existing text to replace." },
          new_text: { type: "string", description: "Replacement text." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command in the project root and return stdout/stderr. Use for tests, builds, git status, etc.",
      parameters: {
        type: "object",
        required: ["command"],
        properties: {
          command: { type: "string", description: "Shell command to execute." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "use_skill",
      description: "Load the full instructions of an installed skill by name. Call this before performing a task an available skill covers, then follow the returned instructions.",
      parameters: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", description: "Skill name exactly as shown in the available skills list." },
        },
      },
    },
  },
];

const readFileTool = async (rootDir, { path }) => {
  const absolute = resolveInsideRoot(rootDir, path);
  const content = await readFile(absolute, "utf8");
  const numbered = content
    .split("\n")
    .map((line, index) => `${index + 1}\t${line}`)
    .join("\n");

  return truncate(numbered);
};

const listDirTool = async (rootDir, { path = "." }) => {
  const absolute = resolveInsideRoot(rootDir, path);
  const entries = await readdir(absolute, { withFileTypes: true });
  const lines = entries
    .filter((entry) => !EXCLUDED_DIRS.has(entry.name))
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort();

  return lines.join("\n") || "(empty directory)";
};

const searchFilesTool = async (rootDir, { pattern }) => {
  const needle = String(pattern).toLowerCase();
  const results = [];

  const visit = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (results.length >= MAX_SEARCH_RESULTS) {
        return;
      }

      const absolute = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) {
          await visit(absolute);
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      let content;
      try {
        content = await readFile(absolute, "utf8");
      } catch {
        continue;
      }

      if (content.includes("\u0000")) {
        continue;
      }

      const lines = content.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].toLowerCase().includes(needle)) {
          const rel = relative(rootDir, absolute).split(sep).join("/");
          results.push(`${rel}:${index + 1}:${lines[index].trim()}`);

          if (results.length >= MAX_SEARCH_RESULTS) {
            break;
          }
        }
      }
    }
  };

  await visit(rootDir);
  return results.join("\n") || "No matches found.";
};

const writeFileTool = async (rootDir, { path, content }) => {
  const absolute = resolveInsideRoot(rootDir, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
  return `Wrote ${content.length} chars to ${path}`;
};

const editFileTool = async (rootDir, { path, old_text: oldText, new_text: newText }) => {
  const absolute = resolveInsideRoot(rootDir, path);
  const content = await readFile(absolute, "utf8");

  const firstIndex = content.indexOf(oldText);
  if (firstIndex === -1) {
    throw new Error(`old_text not found in ${path}. Read the file first and copy the exact text.`);
  }

  if (content.indexOf(oldText, firstIndex + 1) !== -1) {
    throw new Error(`old_text appears more than once in ${path}. Include more surrounding context.`);
  }

  await writeFile(absolute, content.replace(oldText, newText));
  return `Edited ${path}`;
};

const runCommandTool = async (rootDir, { command }) => {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: rootDir,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    return truncate([stdout, stderr].filter(Boolean).join("\n--- stderr ---\n") || "(no output)");
  } catch (error) {
    const output = [error.stdout, error.stderr, error.message].filter(Boolean).join("\n");
    return truncate(`Command failed:\n${output}`);
  }
};

const DESTRUCTIVE_TOOLS = new Set(["write_file", "edit_file", "run_command"]);

const describeToolCall = (name, args) => {
  if (name === "run_command") return `$ ${args.command}`;
  if (name === "write_file") return `write ${args.path} (${String(args.content ?? "").length} chars)`;
  if (name === "edit_file") return `edit ${args.path}`;
  if (name === "read_file") return `read ${args.path}`;
  if (name === "search_files") return `search "${args.pattern}"`;
  if (name === "list_dir") return `ls ${args.path ?? "."}`;
  if (name === "use_skill") return `skill ${args.name}`;
  return `${name} ${JSON.stringify(args)}`;
};

// approve(name, args) -> boolean. Called only for destructive tools.
// getSkill(name) -> skill object or undefined, supplied by the REPL so the
// executor always sees the freshest skill scan.
const createToolExecutor = ({ rootDir = process.cwd(), approve, getSkill } = {}) => {
  const useSkillTool = async (_root, { name }) => {
    const skill = getSkill?.(name);

    if (!skill) {
      return `Skill not found: ${name}. Check the available skills list in the system prompt.`;
    }

    return `Skill "${skill.name}" instructions:\n\n${skill.body}\n\nFollow these instructions for the user's task.`;
  };

  const executors = {
    read_file: readFileTool,
    list_dir: listDirTool,
    search_files: searchFilesTool,
    write_file: writeFileTool,
    edit_file: editFileTool,
    run_command: runCommandTool,
    use_skill: useSkillTool,
  };

  return async (name, args = {}) => {
    const executor = executors[name];

    if (!executor) {
      return `Unknown tool: ${name}. Available tools: ${Object.keys(executors).join(", ")}`;
    }

    if (DESTRUCTIVE_TOOLS.has(name) && approve) {
      const allowed = await approve(name, args);
      if (!allowed) {
        return "The user declined this action. Ask them how to proceed instead of retrying.";
      }
    }

    try {
      return await executor(rootDir, args);
    } catch (error) {
      return `Tool error: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
};

export { createToolExecutor, describeToolCall, DESTRUCTIVE_TOOLS, toolDefinitions };
