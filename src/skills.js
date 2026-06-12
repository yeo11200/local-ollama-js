// Skill system, modeled on Claude Code's progressive disclosure: skills are
// SKILL.md files with YAML frontmatter. Only name + description go into the
// system prompt; the body is loaded on demand via /skill or the use_skill
// tool, keeping precious local-model context free.

import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const getAppHome = () => process.env.LOCAL_OLLAMA_JS_HOME || join(homedir(), ".local-ollama-js");

const getGlobalSkillsDir = () => join(getAppHome(), "skills");

const getProjectSkillsDir = (rootDir) => join(rootDir, ".llm", "skills");

// Minimal frontmatter parser: flat "key: value" lines between --- fences.
const parseFrontmatter = (raw) => {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);

  if (!match) {
    return { meta: {}, body: raw.trim() };
  }

  const meta = {};

  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");

    if (separator > 0) {
      meta[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  }

  return { meta, body: raw.slice(match[0].length).trim() };
};

const scanSkillsDir = async (dir, source) => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    let raw;
    try {
      raw = await readFile(join(dir, entry.name, "SKILL.md"), "utf8");
    } catch {
      continue;
    }

    const { meta, body } = parseFrontmatter(raw);

    skills.push({
      name: meta.name || entry.name,
      description: meta.description || "",
      body,
      source,
    });
  }

  return skills;
};

// Loads global then project skills; a project skill with the same name
// overrides the global one.
const loadSkills = async (rootDir = process.cwd()) => {
  const byName = new Map();

  for (const skill of await scanSkillsDir(getGlobalSkillsDir(), "global")) {
    byName.set(skill.name, skill);
  }

  for (const skill of await scanSkillsDir(getProjectSkillsDir(rootDir), "project")) {
    byName.set(skill.name, skill);
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
};

// One line per skill for the system prompt - names and descriptions only.
const formatSkillList = (skills) =>
  skills.map((skill) => `- ${skill.name}: ${skill.description || "(no description)"}`).join("\n");

const tokenize = (text) =>
  String(text)
    .toLowerCase()
    .split(/[^a-z0-9가-힣_]+/)
    .filter((token) => token.length > 1);

// Substring-tolerant token match so Korean particles do not break matching:
// prompt "메시지" matches description token "메시지를" and vice versa.
const tokensMatch = (a, b) => a === b || (a.length > 1 && b.length > 1 && (a.includes(b) || b.includes(a)));

// Deterministic skill matching, like Claude Code's skill-suggestion hook:
// local models cannot be trusted to call use_skill on their own, so the REPL
// matches prompts against skill names/descriptions itself. Returns skills
// with a `hits` count so callers can scale their response (nudge vs inject).
const suggestSkills = (skills, prompt, limit = 2) => {
  const promptTokens = [...new Set(tokenize(prompt))];

  if (!promptTokens.length) {
    return [];
  }

  return skills
    .map((skill) => {
      const skillTokens = [...new Set(tokenize(`${skill.name} ${skill.description}`))];
      const hits = skillTokens.filter((token) => promptTokens.some((promptToken) => tokensMatch(token, promptToken))).length;
      return { ...skill, hits };
    })
    .filter((skill) => skill.hits >= 1)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit);
};

export { formatSkillList, getGlobalSkillsDir, getProjectSkillsDir, loadSkills, parseFrontmatter, suggestSkills };
