import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMessages,
  buildUserContent,
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
    "--file",
    "README.md",
    "--file=package.json",
    "--model",
    "llama3.2:3b",
    "hello",
    "there",
  ]);

  assert.equal(options.session, "work");
  assert.deepEqual(options.files, ["README.md", "package.json"]);
  assert.equal(options.model, "llama3.2:3b");
  assert.deepEqual(options.positional, ["hello", "there"]);
});

test("saves, loads, lists, and deletes sessions", async () => {
  await withTempHome(async () => {
    const session = await loadSession("work", "qwen2.5-coder:3b");

    session.messages.push({ role: "user", content: "hello" });
    await saveSession(session);

    const loaded = await loadSession("work", "qwen2.5-coder:3b");
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
