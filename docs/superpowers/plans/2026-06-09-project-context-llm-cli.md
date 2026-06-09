# Project Context LLM CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit `--project` mode so `llm --project "..."` can answer using selected files from the current working directory.

**Architecture:** Keep the CLI dependency-free and add project context collection inside `bin/llm.js`. The collector recursively scans from `process.cwd()`, excludes heavy/generated/binary paths, ranks useful files first, and appends bounded file contents before the user prompt.

**Tech Stack:** Node.js ESM, `node:test`, Ollama `/api/chat`.

---

### Task 1: Add Failing Tests For Project Context

**Files:**
- Modify: `test/session.test.mjs`
- Modify: `bin/llm.js`

- [ ] **Step 1: Write tests**

Add tests that expect:
- `createOptions(["--project", "summarize"])` sets `project` to `true`.
- `buildUserContent("Summarize.", [], { project: true })` includes useful project files from the current directory.
- Project context excludes `node_modules`, `dist`, lockfiles, and binary files.

- [ ] **Step 2: Verify red**

Run: `npm test`

Expected: tests fail because `--project` and project context helpers do not exist yet.

### Task 2: Implement Project Context Collection

**Files:**
- Modify: `bin/llm.js`

- [ ] **Step 1: Add options**

Add `project: false` to parsed options and support `--project`.

- [ ] **Step 2: Add collector**

Add a dependency-free recursive scanner with these defaults:
- Max files: 30
- Max file chars: 12000
- Max total chars: 80000
- Excluded dirs: `.git`, `node_modules`, `dist`, `build`, `coverage`, `.next`, `.turbo`, `.cache`, `out`, `vendor`
- Excluded files: lockfiles, `.DS_Store`
- Excluded binary extensions: images, fonts, archives, PDFs, videos, audio

- [ ] **Step 3: Wire into prompt building**

Change `buildUserContent(prompt, files, options)` so `--file` contexts and project context can both be included before the prompt.

- [ ] **Step 4: Verify green**

Run: `npm test`

Expected: all tests pass.

### Task 3: Update Docs And Install

**Files:**
- Modify: `LOCAL_LLM.md`
- Modify: `bin/llm.js`

- [ ] **Step 1: Update help/docs**

Document:
```bash
llm --project "Summarize this project."
llm --project "What should be improved?"
```

- [ ] **Step 2: Verify CLI help**

Run: `llm --help`

Expected: help shows `--project`.

- [ ] **Step 3: Reinstall global CLI**

Run: `npm install -g .`

Expected: global `llm` uses the new code.

- [ ] **Step 4: Smoke test**

Run: `llm --project "Summarize this project in one sentence."`

Expected: response references repository context instead of asking for code.

### Task 4: Commit And Push

**Files:**
- Git commit and push only the local-ollama-js changes.

- [ ] **Step 1: Sensitive string scan**

Run a repository-specific sensitive string scan for company names, internal paths, internal product names, and private examples.

Expected: no matches.

- [ ] **Step 2: Commit**

Run:
```bash
git add .
git commit -m "Add project context mode to llm"
```

- [ ] **Step 3: Push**

Run: `git push origin main`

Expected: remote `main` advances to the new commit.
