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

The project script defaults to `qwen2.5-coder:14b`, which is a better fit for project summaries, code review, and implementation planning on machines with enough memory.

```bash
ollama pull qwen2.5-coder:14b
```

On memory-constrained machines, pull a smaller model and pass it with `--model`:

```bash
ollama pull qwen2.5-coder:3b
llm --model qwen2.5-coder:3b "Summarize README.md."
```

## 4. Install the CLI

```bash
npm install -g .
```

This installs the `llm` command from this repository.

## 5. Ask Questions With Memory

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

## 6. Connect Other Coding Tools

Ollama exposes two useful local API styles:

- Ollama native API: `http://127.0.0.1:11434`
- OpenAI-compatible API: `http://127.0.0.1:11434/v1`

### Cursor

Use Cursor's OpenAI-compatible custom model settings.

```text
Base URL: http://127.0.0.1:11434/v1
API Key: ollama
Model: qwen2.5-coder:14b
```

Before testing in Cursor, verify the local OpenAI-compatible endpoint:

```bash
curl http://127.0.0.1:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ollama" \
  -d '{
    "model": "qwen2.5-coder:14b",
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
  - name: qwen2.5-coder:14b
    provider: ollama
    model: qwen2.5-coder:14b
    apiBase: http://127.0.0.1:11434
```

#### Cline

Use an OpenAI-compatible provider:

```text
Provider: OpenAI Compatible
Base URL: http://127.0.0.1:11434/v1
API Key: ollama
Model: qwen2.5-coder:14b
```

#### Roo Code

Use an OpenAI-compatible provider:

```text
Provider: OpenAI Compatible
Base URL: http://127.0.0.1:11434/v1
API Key: ollama
Model: qwen2.5-coder:14b
```

### Terminal Coding Tools

#### OpenCode

Use Ollama's local OpenAI-compatible endpoint:

```bash
OPENAI_API_KEY=ollama \
OPENAI_BASE_URL=http://127.0.0.1:11434/v1 \
opencode
```

Select or configure the model as `qwen2.5-coder:14b`.

#### Aider

Aider can call Ollama directly:

```bash
aider --model ollama/qwen2.5-coder:14b
```

If direct Ollama mode does not work in the installed Aider version, use the OpenAI-compatible endpoint:

```bash
OPENAI_API_KEY=ollama \
OPENAI_BASE_URL=http://127.0.0.1:11434/v1 \
aider --model openai/qwen2.5-coder:14b
```

### Claude Code

Claude Code can be pointed at Ollama's Anthropic-compatible endpoint:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:11434 \
ANTHROPIC_AUTH_TOKEN=ollama \
ANTHROPIC_API_KEY=ollama \
claude --model qwen2.5-coder:14b
```

For a persistent shortcut, add this to `~/.zshrc`:

```bash
claude-ollama() {
  ANTHROPIC_BASE_URL=http://127.0.0.1:11434 \
  ANTHROPIC_AUTH_TOKEN=ollama \
  ANTHROPIC_API_KEY=ollama \
  command claude --model "${1:-qwen2.5-coder:14b}" "${@:2}"
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
model = "qwen2.5-coder:14b"
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
