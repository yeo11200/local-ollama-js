# Session Memory LLM CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an installable `llm` command that talks to local Ollama and remembers prior conversation turns by session.

**Architecture:** Keep the first implementation dependency-free and ESM-based. `bin/llm.js` owns argument parsing, session persistence, context assembly, Ollama API calls, and CLI output. Session JSON files live under `~/.local-ollama-js/sessions` by default, with `LOCAL_OLLAMA_JS_HOME` available for tests.

**Tech Stack:** Node.js ESM, built-in `fetch`, `node:fs/promises`, `node:test`.

---

### Task 1: Package Entry Point

**Files:**
- Create: `package.json`
- Create: `bin/llm.js`

- [ ] **Step 1: Add package metadata and bin mapping**

Create `package.json`:

```json
{
  "name": "local-ollama-js",
  "version": "0.1.0",
  "private": false,
  "type": "module",
  "bin": {
    "llm": "./bin/llm.js"
  },
  "scripts": {
    "test": "node --test"
  },
  "engines": {
    "node": ">=18"
  }
}
```

- [ ] **Step 2: Add executable CLI skeleton**

Create `bin/llm.js` with a shebang, `--help`, default model/host constants, and a placeholder `main()` that prints help when no prompt is provided.

- [ ] **Step 3: Verify bin syntax**

Run: `node --check bin/llm.js`

Expected: exit code 0.

### Task 2: Session Persistence

**Files:**
- Modify: `bin/llm.js`
- Create: `test/session.test.mjs`

- [ ] **Step 1: Implement session paths**

Use `LOCAL_OLLAMA_JS_HOME || ~/.local-ollama-js` as the app home and store sessions in `sessions/<name>.json`.

- [ ] **Step 2: Implement session commands**

Support:

```bash
llm --list-sessions
llm --show-session work
llm --reset-session work
```

- [ ] **Step 3: Add focused persistence tests**

Use `node:test` with a temporary `LOCAL_OLLAMA_JS_HOME` to verify save/load/delete/list behavior without touching the real home directory.

- [ ] **Step 4: Run tests**

Run: `npm test`

Expected: session tests pass.

### Task 3: Chat Flow

**Files:**
- Modify: `bin/llm.js`
- Modify: `test/session.test.mjs`

- [ ] **Step 1: Implement prompt and file context parsing**

Support:

```bash
llm "question"
llm --session work "question"
llm --file README.md "review this file"
llm --file README.md --file package.json "compare these files"
```

- [ ] **Step 2: Implement Ollama chat call**

Send a `system` message plus the last 20 persisted messages and the current user message to `POST /api/chat` with `stream: false`.

- [ ] **Step 3: Persist assistant responses**

After a successful response, append both the user message and assistant response to the session JSON.

- [ ] **Step 4: Run a local smoke test**

Run:

```bash
node bin/llm.js --session smoke "Reply with OK only."
```

Expected: Ollama responds, and `llm --show-session smoke` contains the user and assistant turns.

### Task 4: Documentation and Compatibility

**Files:**
- Modify: `LOCAL_LLM.md`
- Modify: `scripts/ollama-chat.mjs`

- [ ] **Step 1: Update documentation**

Document `npm install -g .`, `llm` commands, sessions, and reset/list/show operations.

- [ ] **Step 2: Keep old script usable**

Change `scripts/ollama-chat.mjs` into a thin wrapper that imports and runs `bin/llm.js`, or update it to tell users to use `llm`.

- [ ] **Step 3: Verify no company-specific examples**

Run:

```bash
rg -n "company-specific-name|internal-path|private-example" .
```

Expected: no matches.

### Task 5: Commit and Push

**Files:**
- All changed files

- [ ] **Step 1: Review diff**

Run: `git diff --stat && git status -sb`

- [ ] **Step 2: Commit**

Run:

```bash
git add package.json bin/llm.js test/session.test.mjs LOCAL_LLM.md scripts/ollama-chat.mjs docs/superpowers/plans/2026-06-09-session-memory-llm-cli.md
git commit -m "Add session memory llm CLI"
```

- [ ] **Step 3: Push**

Run: `git push origin main`
