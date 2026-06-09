import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMessages,
  buildUserContent,
  collectProjectContext,
  createOptions,
  deleteSession,
  getSessionPath,
  listSessions,
  loadSession,
  normalizeSessionName,
  saveSession,
} from "../bin/llm.js";

const withTempHome = async (fn) => {
  const previousHome = process.env.LOCAL_OLLAMA_JS_HOME;
  const dir = await mkdtemp(join(tmpdir(), "local-ollama-js-test-"));

  process.env.LOCAL_OLLAMA_JS_HOME = dir;

  try {
    await fn(dir);
  } finally {
    if (previousHome === undefined) {
      delete process.env.LOCAL_OLLAMA_JS_HOME;
    } else {
      process.env.LOCAL_OLLAMA_JS_HOME = previousHome;
    }

    await rm(dir, { recursive: true, force: true });
  }
};

test("normalizes safe session names", () => {
  assert.equal(normalizeSessionName("work-1"), "work-1");
  assert.equal(normalizeSessionName("team.alpha"), "team.alpha");
  assert.throws(() => normalizeSessionName("../secret"), /Session names/);
});

test("parses chat options", () => {
  const options = createOptions([
    "--session",
    "work",
    "--project",
    "--file",
    "README.md",
    "--file=package.json",
    "--model",
    "llama3.2:3b",
    "hello",
    "there",
  ]);

  assert.equal(options.session, "work");
  assert.equal(options.project, true);
  assert.deepEqual(options.files, ["README.md", "package.json"]);
  assert.equal(options.model, "llama3.2:3b");
  assert.deepEqual(options.positional, ["hello", "there"]);
});

test("collects bounded project context from useful files", async () => {
  await withTempHome(async (dir) => {
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "node_modules", "ignored"), { recursive: true });
    await mkdir(join(dir, "dist"), { recursive: true });

    await writeFile(join(dir, "README.md"), "# Project\n");
    await writeFile(join(dir, "package.json"), "{\"name\":\"example\"}\n");
    await writeFile(join(dir, "src", "index.js"), "export const value = 1;\n");
    await writeFile(join(dir, "node_modules", "ignored", "index.js"), "ignored dependency\n");
    await writeFile(join(dir, "dist", "bundle.js"), "ignored build\n");
    await writeFile(join(dir, "package-lock.json"), "ignored lockfile\n");
    await writeFile(join(dir, "logo.png"), "ignored image\n");

    const context = await collectProjectContext({ rootDir: dir });

    assert.match(context, /Project root:/);
    assert.match(context, /File: README\.md/);
    assert.match(context, /File: package\.json/);
    assert.match(context, /File: src\/index\.js/);
    assert.doesNotMatch(context, /node_modules/);
    assert.doesNotMatch(context, /dist\/bundle\.js/);
    assert.doesNotMatch(context, /package-lock\.json/);
    assert.doesNotMatch(context, /logo\.png/);
  });
});

test("builds user content with project context", async () => {
  await withTempHome(async (dir) => {
    await writeFile(join(dir, "README.md"), "# Example Project\n");

    const previousCwd = process.cwd();
    process.chdir(dir);

    try {
      const content = await buildUserContent("Summarize this.", [], { project: true });
      assert.match(content, /Project root:/);
      assert.match(content, /# Example Project/);
      assert.match(content, /Summarize this\./);
    } finally {
      process.chdir(previousCwd);
    }
  });
});

test("saves, loads, lists, and deletes sessions", async () => {
  await withTempHome(async () => {
    const session = await loadSession("work", "deepseek-coder-v2:16b");

    session.messages.push({ role: "user", content: "hello" });
    await saveSession(session);

    const loaded = await loadSession("work", "deepseek-coder-v2:16b");
    assert.equal(loaded.id, "work");
    assert.equal(loaded.messages[0].content, "hello");
    assert.deepEqual(await listSessions(), ["work"]);

    await deleteSession("work");
    assert.deepEqual(await listSessions(), []);
  });
});

test("builds user content with file context", async () => {
  await withTempHome(async (dir) => {
    const filePath = join(dir, "README.md");
    await writeFile(filePath, "# Example\n");

    const previousCwd = process.cwd();
    process.chdir(dir);

    try {
      const content = await buildUserContent("Review this.", ["README.md"]);
      assert.match(content, /File: README\.md/);
      assert.match(content, /# Example/);
      assert.match(content, /Review this\./);
    } finally {
      process.chdir(previousCwd);
    }
  });
});

test("builds bounded chat messages from session history", () => {
  const history = Array.from({ length: 25 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message ${index}`,
  }));

  const messages = buildMessages(history, "current question");

  assert.equal(messages[0].role, "system");
  assert.equal(messages.length, 22);
  assert.equal(messages[1].content, "message 5");
  assert.equal(messages.at(-1).content, "current question");
});

test("session path uses configured app home", async () => {
  await withTempHome(async (dir) => {
    assert.equal(getSessionPath("default"), join(dir, "sessions", "default.json"));
  });
});
