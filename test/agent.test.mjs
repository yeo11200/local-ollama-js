import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";

import { parseTextToolCall } from "../src/agent.js";
import { buildIndex, chunkFile, cosineSimilarity, retrieve } from "../src/rag.js";
import { completeCommand, createTokenPrinter, projectSessionName } from "../src/repl.js";
import { loadSkills, parseFrontmatter, suggestSkills } from "../src/skills.js";
import { createToolExecutor } from "../src/tools.js";

const withTempDir = async (fn) => {
  const dir = await mkdtemp(join(tmpdir(), "local-ollama-agent-test-"));

  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test("parses text protocol tool calls", () => {
  const parsed = parseTextToolCall('Sure.\n<tool_call>{"name": "read_file", "arguments": {"path": "a.js"}}</tool_call>');
  assert.equal(parsed.name, "read_file");
  assert.deepEqual(parsed.arguments, { path: "a.js" });

  assert.equal(parseTextToolCall("plain answer"), null);
  assert.equal(parseTextToolCall("<tool_call>not json"), null);
  assert.equal(parseTextToolCall('<tool_call>{"arguments": {}}</tool_call>'), null);
});

test("parses tool calls without a closing tag or with trailing noise", () => {
  // Real output observed from deepseek-coder-v2: no closing tag, junk after.
  const sloppy = ' <tool_call>{"name": "write_file", "arguments": {"path": "hello.txt", "content": "hello agent"}}\n```json\n{}\n```';
  const parsed = parseTextToolCall(sloppy);
  assert.equal(parsed.name, "write_file");
  assert.deepEqual(parsed.arguments, { path: "hello.txt", content: "hello agent" });

  const nestedBraces = '<tool_call>{"name": "edit_file", "arguments": {"path": "a.js", "old_text": "if (x) { y(); }", "new_text": "z(\\"{\\");"}}';
  const nested = parseTextToolCall(nestedBraces);
  assert.equal(nested.name, "edit_file");
  assert.equal(nested.arguments.old_text, "if (x) { y(); }");
});

test("parses bare JSON tool calls but not JSON examples in prose", () => {
  // qwen2.5-coder sometimes replies with the call as a plain JSON object.
  const bare = '{\n  "name": "write_file",\n  "arguments": {\n    "path": "hello.txt",\n    "content": "hello qwen"\n  }\n}';
  const parsed = parseTextToolCall(bare);
  assert.equal(parsed.name, "write_file");
  assert.deepEqual(parsed.arguments, { path: "hello.txt", content: "hello qwen" });

  const fenced = '```json\n{"name": "read_file", "arguments": {"path": "a.js"}}\n```';
  assert.equal(parseTextToolCall(fenced).name, "read_file");

  // JSON object that is not a known tool: leave it alone.
  assert.equal(parseTextToolCall('{"name": "config", "arguments": {}}'), null);
  // JSON embedded in an explanation: leave it alone.
  assert.equal(parseTextToolCall('Here is an example:\n{"name": "read_file", "arguments": {}}'), null);
  // Trailing prose after the object: leave it alone.
  assert.equal(parseTextToolCall('{"name": "read_file", "arguments": {}}\nLet me know!'), null);
});

test("token printer holds bare-JSON messages for discard or flush", () => {
  const written = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (text) => {
    written.push(text);
    return true;
  };

  try {
    const printer = createTokenPrinter();

    // Consumed as a tool call: discard, nothing printed.
    printer.push('{"name": "writ');
    printer.push('e_file", "arguments": {}}');
    printer.discard();
    assert.deepEqual(written, []);

    // Real JSON answer: flushed on reset.
    printer.push('{"ok": true}');
    printer.reset();
    assert.equal(written.join(""), '{"ok": true}');
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("parses DeepSeek special-token tool call syntax", () => {
  const deepseek =
    '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>write_file\n```json\n{"path": "hello.txt", "content": "hello agent"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
  const parsed = parseTextToolCall(deepseek);
  assert.equal(parsed.name, "write_file");
  assert.deepEqual(parsed.arguments, { path: "hello.txt", content: "hello agent" });
});

test("tool executor reads, writes, edits, and searches inside the root", async () => {
  await withTempDir(async (dir) => {
    const execute = createToolExecutor({ rootDir: dir });

    await execute("write_file", { path: "src/app.js", content: "const value = 1;\n" });
    assert.equal(await readFile(join(dir, "src", "app.js"), "utf8"), "const value = 1;\n");

    const read = await execute("read_file", { path: "src/app.js" });
    assert.match(read, /1\tconst value = 1;/);

    await execute("edit_file", { path: "src/app.js", old_text: "value = 1", new_text: "value = 2" });
    assert.equal(await readFile(join(dir, "src", "app.js"), "utf8"), "const value = 2;\n");

    const search = await execute("search_files", { pattern: "value = 2" });
    assert.match(search, /src\/app\.js:1:/);

    const listing = await execute("list_dir", { path: "." });
    assert.match(listing, /src\//);
  });
});

test("tool executor blocks paths escaping the root and honors approval", async () => {
  await withTempDir(async (dir) => {
    const denied = createToolExecutor({ rootDir: dir, approve: async () => false });
    const result = await denied("write_file", { path: "a.txt", content: "x" });
    assert.match(result, /declined/);

    const execute = createToolExecutor({ rootDir: dir });
    const escape = await execute("read_file", { path: "../outside.txt" });
    assert.match(escape, /escapes the project root/);
  });
});

test("edit_file requires a unique match", async () => {
  await withTempDir(async (dir) => {
    const execute = createToolExecutor({ rootDir: dir });
    await writeFile(join(dir, "a.txt"), "dup\ndup\n");

    const result = await execute("edit_file", { path: "a.txt", old_text: "dup", new_text: "x" });
    assert.match(result, /more than once/);
  });
});

test("chunks files with line offsets", () => {
  const lines = Array.from({ length: 130 }, (_, index) => `line ${index + 1}`).join("\n");
  const chunks = chunkFile("src/big.js", lines);

  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[1].startLine, 51);
  assert.match(chunks[0].text, /^line 1\n/);
});

test("cosine similarity ranks identical vectors highest", () => {
  assert.ok(cosineSimilarity([1, 0], [1, 0]) > cosineSimilarity([1, 0], [0.5, 0.5]));
  assert.equal(cosineSimilarity([0, 0], [0, 0]), 0);
});

test("rag falls back to keyword retrieval without an embedding model", async () => {
  await withTempDir(async (dir) => {
    const previousHome = process.env.LOCAL_OLLAMA_JS_HOME;
    process.env.LOCAL_OLLAMA_JS_HOME = join(dir, "home");

    try {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src", "auth.js"), "export const login = () => {};\n");
      await writeFile(join(dir, "src", "billing.js"), "export const charge = () => {};\n");

      // Unreachable host forces the keyword fallback path.
      const built = await buildIndex({ rootDir: dir, host: "http://127.0.0.1:9" });
      assert.equal(built.mode, "keyword");
      assert.ok(built.chunkCount >= 2);

      const results = await retrieve({ rootDir: dir, host: "http://127.0.0.1:9", query: "login auth" });
      assert.ok(results.length >= 1);
      assert.equal(results[0].file, "src/auth.js");
    } finally {
      if (previousHome === undefined) {
        delete process.env.LOCAL_OLLAMA_JS_HOME;
      } else {
        process.env.LOCAL_OLLAMA_JS_HOME = previousHome;
      }
    }
  });
});

test("token printer suppresses tool_call protocol output", () => {
  const written = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (text) => {
    written.push(text);
    return true;
  };

  try {
    const printer = createTokenPrinter();
    printer.push("<tool_");
    printer.push('call>{"name":"read_file"}</tool_call>');
    printer.reset();
    assert.deepEqual(written, []);

    printer.push("Hello");
    printer.push(" world");
    printer.reset();
    assert.equal(written.join(""), "Hello world");

    // Prose followed by a tool call mid-stream: cut at the marker.
    written.length = 0;
    printer.push("Let me check that file.\n");
    printer.push('<tool_call>{"name": "read_file", "arguments": {}}');
    printer.push("more protocol noise");
    printer.reset();
    assert.equal(written.join(""), "Let me check that file.\n");
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("completes slash commands", () => {
  const [allHits] = completeCommand("/");
  assert.ok(allHits.includes("/help") && allHits.includes("/exit"));

  const [modelHits] = completeCommand("/mod");
  assert.deepEqual(modelHits, ["/model", "/models"]);

  const [noHits] = completeCommand("hello");
  assert.deepEqual(noHits, []);

  const [argHits] = completeCommand("/model qwen");
  assert.deepEqual(argHits, []);
});

test("parses SKILL.md frontmatter", () => {
  const { meta, body } = parseFrontmatter("---\nname: demo\ndescription: A demo skill\n---\n\nDo the thing.\n");
  assert.equal(meta.name, "demo");
  assert.equal(meta.description, "A demo skill");
  assert.equal(body, "Do the thing.");

  const plain = parseFrontmatter("Just instructions.");
  assert.deepEqual(plain.meta, {});
  assert.equal(plain.body, "Just instructions.");
});

test("loads global and project skills with project overriding global", async () => {
  await withTempDir(async (dir) => {
    const previousHome = process.env.LOCAL_OLLAMA_JS_HOME;
    process.env.LOCAL_OLLAMA_JS_HOME = join(dir, "home");

    try {
      await mkdir(join(dir, "home", "skills", "deploy"), { recursive: true });
      await mkdir(join(dir, "home", "skills", "review"), { recursive: true });
      await mkdir(join(dir, "project", ".llm", "skills", "deploy"), { recursive: true });

      await writeFile(
        join(dir, "home", "skills", "deploy", "SKILL.md"),
        "---\nname: deploy\ndescription: global deploy\n---\nglobal body",
      );
      await writeFile(
        join(dir, "home", "skills", "review", "SKILL.md"),
        "---\ndescription: review code\n---\nreview body",
      );
      await writeFile(
        join(dir, "project", ".llm", "skills", "deploy", "SKILL.md"),
        "---\nname: deploy\ndescription: project deploy\n---\nproject body",
      );

      const skills = await loadSkills(join(dir, "project"));
      assert.deepEqual(skills.map((skill) => skill.name), ["deploy", "review"]);

      const deploy = skills.find((skill) => skill.name === "deploy");
      assert.equal(deploy.description, "project deploy");
      assert.equal(deploy.source, "project");

      // name falls back to the directory name when frontmatter omits it
      assert.equal(skills.find((skill) => skill.name === "review").description, "review code");
    } finally {
      if (previousHome === undefined) {
        delete process.env.LOCAL_OLLAMA_JS_HOME;
      } else {
        process.env.LOCAL_OLLAMA_JS_HOME = previousHome;
      }
    }
  });
});

test("use_skill tool returns skill instructions", async () => {
  await withTempDir(async (dir) => {
    const execute = createToolExecutor({
      rootDir: dir,
      getSkill: (name) => (name === "demo" ? { name: "demo", body: "Step 1. Do it." } : undefined),
    });

    const found = await execute("use_skill", { name: "demo" });
    assert.match(found, /Step 1\. Do it\./);

    const missing = await execute("use_skill", { name: "nope" });
    assert.match(missing, /Skill not found/);
  });
});

test("suggests skills by keyword overlap with the prompt", () => {
  const skills = [
    { name: "git-commit", description: "한국어 git 커밋 메시지를 팀 컨벤션에 맞게 작성" },
    { name: "deploy", description: "스테이징 서버 배포 절차" },
  ];

  assert.deepEqual(
    suggestSkills(skills, "커밋 메시지 만들어줘").map((skill) => skill.name),
    ["git-commit"],
  );
  assert.deepEqual(
    suggestSkills(skills, "스테이징에 배포 부탁해").map((skill) => skill.name),
    ["deploy"],
  );
  assert.deepEqual(suggestSkills(skills, "하이하이"), []);
});

test("completes skill names after /skill", () => {
  const [hits] = completeCommand("/skill gi", ["git-commit", "deploy"]);
  assert.deepEqual(hits, ["/skill git-commit"]);

  const [all] = completeCommand("/skill ", ["git-commit", "deploy"]);
  assert.deepEqual(all, ["/skill git-commit", "/skill deploy"]);
});

test("derives a stable per-project session name", () => {
  const name = projectSessionName("/tmp/my project!");
  assert.match(name, /^proj-my-project--[0-9a-f]{6}$/);
  assert.equal(name, projectSessionName("/tmp/my project!"));
});
