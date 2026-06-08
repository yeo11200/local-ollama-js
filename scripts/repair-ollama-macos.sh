#!/usr/bin/env bash
set -euo pipefail

FORMULA_PREFIX="$(brew --prefix ollama)"
FORMULA_LIBEXEC="${FORMULA_PREFIX}/libexec"
APP_RESOURCES="/Applications/Ollama.app/Contents/Resources"

if [[ ! -x "${FORMULA_LIBEXEC}/ollama" ]]; then
  echo "Homebrew ollama formula is not installed at ${FORMULA_PREFIX}." >&2
  echo "Run: brew install ollama" >&2
  exit 1
fi

if [[ ! -x "${APP_RESOURCES}/llama-server" ]]; then
  echo "Ollama.app runner is not available at ${APP_RESOURCES}/llama-server." >&2
  echo "Run: brew install --cask ollama" >&2
  exit 1
fi

install -m 0755 "${APP_RESOURCES}/llama-server" "${FORMULA_LIBEXEC}/llama-server"

if [[ -f "${APP_RESOURCES}/libllama-server-impl.dylib" ]]; then
  install -m 0755 "${APP_RESOURCES}/libllama-server-impl.dylib" "${FORMULA_LIBEXEC}/libllama-server-impl.dylib"
fi

xattr -d com.apple.quarantine "${FORMULA_LIBEXEC}/llama-server" 2>/dev/null || true
codesign --force --sign - "${FORMULA_LIBEXEC}/llama-server"

echo "Repaired Ollama runner at ${FORMULA_LIBEXEC}/llama-server"
