# Local LLM Setup

This repository can use a local Ollama model as a lightweight coding assistant when cloud tools are unavailable.

## 1. Install Ollama

On macOS with Homebrew:

```bash
brew install --cask ollama
```

Or install it from the Ollama desktop app if Homebrew is not available.

## 2. Start Ollama

```bash
brew services start ollama
```

The local API should be available at `http://127.0.0.1:11434`.

## 3. Pull a Model

The project script defaults to `qwen2.5-coder:14b`, a 14B coding model with native tool calling - the best fit for the interactive agent mode.

```bash
ollama pull qwen2.5-coder:14b
ollama pull nomic-embed-text   # embeddings for agent-mode RAG
```

## 4. Install the CLI

```bash
npm install -g .
```

This installs the `llm` command from this repository.

## 5. Interactive Agent Mode (Claude Code style)

Run `llm` with no arguments inside any project to start an interactive agent
session:

```bash
cd your-project
llm
```

What you get:

- **Conversation loop** with streamed responses, like Claude Code.
- **Tools**: the model can read, search, write, and edit files and run shell
  commands in the current directory. Destructive actions (write_file,
  edit_file, run_command) ask for approval first: `y` once, `a` always for
  that tool, `n` decline.
- **Automatic RAG**: project files are chunked and embedded with
  `nomic-embed-text` (set `OLLAMA_EMBED_MODEL` to change). The index is cached
  in `~/.local-ollama-js/rag/` and refreshed incrementally on startup. The
  top matching chunks are injected into every question. If no embedding model
  is pulled, it falls back to keyword matching automatically.
- **Automatic sessions**: the session name is derived from the directory, so
  running `llm` in the same project resumes the previous conversation.
- **Model independence**: models with native tool calling (qwen2.5-coder,
  llama3.1, ...) use Ollama's tools API; models without it (deepseek-coder-v2)
  automatically switch to a text-based tool protocol. Switch models mid-session
  with `/model`.

For the best agent experience, pull the embedding model once:

```bash
ollama pull nomic-embed-text
```

Slash commands inside the session:

```text
/help                 Show commands
/model <name>         Switch model (keeps history)
/models               List installed Ollama models
/session [name]       Show or switch session
/sessions             List saved sessions
/reset                Clear the current session
/rag on|off           Toggle retrieval context
/reindex              Rebuild the RAG index
/tools on|off         Toggle agent tools
/file <path>          Attach a file to the next prompt
/skills               Rescan and list installed skills
/skill <name>         Load a skill into the next prompt
/exit                 Quit
```

### Skills (Claude Code style)

Skills are reusable instruction files the agent loads on demand. Create one:

```bash
mkdir -p ~/.local-ollama-js/skills/git-commit
cat > ~/.local-ollama-js/skills/git-commit/SKILL.md <<'EOF'
---
name: git-commit
description: 한국어 git 커밋 메시지를 팀 컨벤션에 맞게 작성
---

# 커밋 메시지 작성 규칙
1. ...
EOF
```

- Global skills: `~/.local-ollama-js/skills/<name>/SKILL.md`
- Project skills: `<project>/.llm/skills/<name>/SKILL.md` (override global by name)
- Only names and descriptions are kept in the system prompt; the body loads
  on demand (progressive disclosure), keeping local-model context small.

Three activation paths:

1. **Automatic**: when your prompt strongly matches a skill's name/description
   (2+ keyword hits), the skill body is injected automatically
   (`⚡ skill loaded: ...`). A weak match only nudges the model to call the
   `use_skill` tool.
2. **Manual**: `/skill git-commit` queues the skill for the next prompt.
   Tab-completion works (`/skill g<Tab>`).
3. **Model-invoked**: the agent can call the `use_skill` tool itself.

## 6. Ask Questions With Memory (one-shot mode)

Use the default session:

```bash
llm "Summarize this repository."
```

Include selected files from the current working directory:

```bash
llm --project "Summarize this project."
llm --project "What should be improved in this codebase?"
```

Project mode is explicit. A plain `llm "..."` call does not automatically read the current directory, so use `--project` when the question needs repository context.

Continue a named session:

```bash
llm --session work "Continue from our previous discussion."
```

Include one or more files as context:

```bash
llm --file README.md "Review this file."
llm --file README.md --file package.json "Compare these files."
```

Use a different model:

```bash
llm --model llama3.2:3b "Summarize README.md."
```

Manage sessions:

```bash
llm --list-sessions
llm --show-session work
llm --reset-session work
```

Sessions are stored at `~/.local-ollama-js/sessions/<name>.json`. Each chat sends the latest 20 saved messages to Ollama so the model can remember recent context without making prompts grow without bound.

## 7. Connect Other Coding Tools

Ollama exposes two useful local API styles:

- Ollama native API: `http://127.0.0.1:11434`
- OpenAI-compatible API: `http://127.0.0.1:11434/v1`

### Cursor

Use Cursor's OpenAI-compatible custom model settings.

```text
Base URL: http://127.0.0.1:11434/v1
API Key: ollama
Model: deepseek-coder-v2:16b
```

Before testing in Cursor, verify the local OpenAI-compatible endpoint:

```bash
curl http://127.0.0.1:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ollama" \
  -d '{
    "model": "deepseek-coder-v2:16b",
    "messages": [{ "role": "user", "content": "Reply with OK only." }],
    "stream": false
  }'
```

If Cursor rejects `127.0.0.1` or plain HTTP in the UI, expose the same local Ollama endpoint through an HTTPS tunnel and use the tunnel URL with `/v1`.

If Cursor shows an unpaid invoice or team billing message, Cursor may block the app before it reaches the local model. In that case, Ollama is still usable from other tools below.

### VS Code Extensions

Use these when Cursor is blocked but you still want an editor-based local coding assistant.

#### Continue

Continue supports Ollama directly. Add a model like this in Continue's config:

```yaml
models:
  - name: deepseek-coder-v2:16b
    provider: ollama
    model: deepseek-coder-v2:16b
    apiBase: http://127.0.0.1:11434
```

#### Cline

Use an OpenAI-compatible provider:

```text
Provider: OpenAI Compatible
Base URL: http://127.0.0.1:11434/v1
API Key: ollama
Model: deepseek-coder-v2:16b
```

#### Roo Code

Use an OpenAI-compatible provider:

```text
Provider: OpenAI Compatible
Base URL: http://127.0.0.1:11434/v1
API Key: ollama
Model: deepseek-coder-v2:16b
```

### Terminal Coding Tools

#### OpenCode

Use Ollama's local OpenAI-compatible endpoint:

```bash
OPENAI_API_KEY=ollama \
OPENAI_BASE_URL=http://127.0.0.1:11434/v1 \
opencode
```

Select or configure the model as `deepseek-coder-v2:16b`.

#### Aider

Aider can call Ollama directly:

```bash
aider --model ollama/deepseek-coder-v2:16b
```

If direct Ollama mode does not work in the installed Aider version, use the OpenAI-compatible endpoint:

```bash
OPENAI_API_KEY=ollama \
OPENAI_BASE_URL=http://127.0.0.1:11434/v1 \
aider --model openai/deepseek-coder-v2:16b
```

### Claude Code

Claude Code can be pointed at Ollama's Anthropic-compatible endpoint:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:11434 \
ANTHROPIC_AUTH_TOKEN=ollama \
ANTHROPIC_API_KEY=ollama \
claude --model deepseek-coder-v2:16b
```

For a persistent shortcut, add this to `~/.zshrc`:

```bash
claude-ollama() {
  ANTHROPIC_BASE_URL=http://127.0.0.1:11434 \
  ANTHROPIC_AUTH_TOKEN=ollama \
  ANTHROPIC_API_KEY=ollama \
  command claude --model "${1:-deepseek-coder-v2:16b}" "${@:2}"
}
```

Then run:

```bash
claude-ollama
```

Use another local model:

```bash
claude-ollama llama3.2:3b
```

If a real Anthropic key is already exported in the shell, unset it first:

```bash
unset ANTHROPIC_API_KEY
```

Then rerun the command above.

### Codex CLI

For Codex CLI, configure a local OpenAI-compatible provider in `~/.codex/config.toml`:

```toml
model = "deepseek-coder-v2:16b"
model_provider = "local_ollama"

[model_providers.local_ollama]
name = "Local Ollama"
base_url = "http://127.0.0.1:11434/v1"
wire_api = "chat"
env_key = "OLLAMA_API_KEY"
```

Then run Codex with a dummy API key:

```bash
OLLAMA_API_KEY=ollama codex
```

## Notes

- This does not send code to external LLM services.
- The script calls Ollama's local `/api/chat` endpoint only.
- Set `OLLAMA_MODEL` or `OLLAMA_HOST` to change defaults without passing flags every time.
- Set `LOCAL_OLLAMA_JS_HOME` to change where sessions are stored.
- On this macOS setup, the Homebrew formula was installed but its `llama-server` runner was missing. If Ollama returns `llama-server binary not found` or `signal: killed`, run:

```bash
pnpm local-llm:repair-macos
brew services restart ollama
```
