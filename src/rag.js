// Project RAG: chunk source files, embed them with a local Ollama embedding
// model, cache the index per project, and retrieve top-k chunks per question.
// Falls back to keyword scoring when no embedding model is available, so RAG
// works regardless of which models are pulled.

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, relative, resolve, sep } from "node:path";

import { embed } from "./ollama.js";

const DEFAULT_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";
const CHUNK_LINES = 60;
const CHUNK_OVERLAP_LINES = 10;
const MAX_INDEXED_FILES = 400;
const MAX_FILE_CHARS = 100_000;
const DEFAULT_TOP_K = 6;
// Chunks scoring below these are noise: greetings and chit-chat should not
// drag project code into the prompt and push the model into "coding mode".
// 0.43 calibrated against nomic-embed-text: Korean coding questions score
// 0.44-0.57 against English code chunks, chit-chat tops out around 0.42.
const MIN_VECTOR_SCORE = 0.43;
const MIN_KEYWORD_SCORE = 0.25;

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

const EXCLUDED_FILES = new Set([".DS_Store", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);

const TEXT_EXTENSIONS = new Set([
  "", ".cjs", ".css", ".html", ".js", ".json", ".jsx", ".md", ".mjs", ".mts",
  ".py", ".rb", ".sh", ".sql", ".svelte", ".toml", ".ts", ".tsx", ".txt",
  ".vue", ".yaml", ".yml",
]);

const getAppHome = () => process.env.LOCAL_OLLAMA_JS_HOME || join(homedir(), ".local-ollama-js");

const getIndexPath = (rootDir) => {
  const hash = createHash("sha1").update(resolve(rootDir)).digest("hex").slice(0, 12);
  return join(getAppHome(), "rag", `${hash}.json`);
};

const collectIndexableFiles = async (rootDir) => {
  const root = resolve(rootDir);
  const files = [];

  const visit = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= MAX_INDEXED_FILES) {
        return;
      }

      const absolute = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          await visit(absolute);
        }
        continue;
      }

      if (!entry.isFile() || EXCLUDED_FILES.has(entry.name)) {
        continue;
      }

      if (!TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        continue;
      }

      const info = await stat(absolute);
      files.push({
        absolute,
        relative: relative(root, absolute).split(sep).join("/"),
        mtimeMs: info.mtimeMs,
        size: info.size,
      });
    }
  };

  await visit(root);
  return files;
};

const chunkFile = (relativePath, content) => {
  const lines = content.slice(0, MAX_FILE_CHARS).split("\n");
  const chunks = [];

  for (let start = 0; start < lines.length; start += CHUNK_LINES - CHUNK_OVERLAP_LINES) {
    const slice = lines.slice(start, start + CHUNK_LINES);
    const text = slice.join("\n").trim();

    if (text) {
      chunks.push({
        file: relativePath,
        startLine: start + 1,
        text,
      });
    }

    if (start + CHUNK_LINES >= lines.length) {
      break;
    }
  }

  return chunks;
};

const loadIndex = async (rootDir) => {
  try {
    return JSON.parse(await readFile(getIndexPath(rootDir), "utf8"));
  } catch {
    return { embedModel: null, files: {}, chunks: [] };
  }
};

const saveIndex = async (rootDir, index) => {
  const path = getIndexPath(rootDir);
  await mkdir(join(getAppHome(), "rag"), { recursive: true });
  await writeFile(path, JSON.stringify(index));
};

const cosineSimilarity = (a, b) => {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
};

const tokenize = (text) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9가-힣_]+/)
    .filter((token) => token.length > 1);

const keywordScore = (queryTokens, chunkText) => {
  const chunkTokens = new Set(tokenize(chunkText));
  let hits = 0;

  for (const token of queryTokens) {
    if (chunkTokens.has(token)) {
      hits += 1;
    }
  }

  return hits / (queryTokens.length || 1);
};

// Builds or incrementally refreshes the index. Embeds only files whose mtime
// changed since the last run. Returns { chunkCount, fileCount, mode }.
const buildIndex = async ({ rootDir = process.cwd(), host, embedModel = DEFAULT_EMBED_MODEL, onProgress } = {}) => {
  const files = await collectIndexableFiles(rootDir);
  const previous = await loadIndex(rootDir);
  const embedModelChanged = previous.embedModel && previous.embedModel !== embedModel;

  const nextFiles = {};
  const nextChunks = [];
  const pendingChunks = [];

  for (const file of files) {
    nextFiles[file.relative] = file.mtimeMs;
    const unchanged = !embedModelChanged && previous.files?.[file.relative] === file.mtimeMs;

    if (unchanged) {
      const previousChunks = previous.chunks.filter((chunk) => chunk.file === file.relative);

      // Reuse cached chunks only if they were embedded successfully; chunks
      // saved during an embedding outage get re-embedded on the next run
      // instead of locking the index into keyword mode forever.
      if (previousChunks.length && previousChunks.every((chunk) => Array.isArray(chunk.vector))) {
        nextChunks.push(...previousChunks);
        continue;
      }
    }

    let content;
    try {
      content = await readFile(file.absolute, "utf8");
    } catch {
      continue;
    }

    if (content.includes("\u0000")) {
      continue;
    }

    pendingChunks.push(...chunkFile(file.relative, content));
  }

  let mode = "embedding";

  if (pendingChunks.length) {
    try {
      const BATCH = 16;
      for (let start = 0; start < pendingChunks.length; start += BATCH) {
        const batch = pendingChunks.slice(start, start + BATCH);
        const embeddings = await embed({ host, model: embedModel, input: batch.map((chunk) => chunk.text) });

        batch.forEach((chunk, index) => {
          chunk.vector = embeddings[index];
        });

        onProgress?.(Math.min(start + BATCH, pendingChunks.length), pendingChunks.length);
      }
    } catch {
      // Embedding model unavailable: keep chunks without vectors and use keyword retrieval.
      mode = "keyword";
    }

    nextChunks.push(...pendingChunks);
  } else if (nextChunks.some((chunk) => !chunk.vector)) {
    mode = "keyword";
  }

  const index = {
    embedModel: mode === "embedding" ? embedModel : null,
    updatedAt: new Date().toISOString(),
    files: nextFiles,
    chunks: nextChunks,
  };

  await saveIndex(rootDir, index);

  return { chunkCount: nextChunks.length, fileCount: files.length, mode };
};

// Retrieves the top-k chunks for a query. Uses vectors when present,
// keyword overlap otherwise.
const retrieve = async ({ rootDir = process.cwd(), host, query, topK = DEFAULT_TOP_K, embedModel = DEFAULT_EMBED_MODEL }) => {
  const index = await loadIndex(rootDir);

  if (!index.chunks.length) {
    return [];
  }

  const vectorChunks = index.chunks.filter((chunk) => Array.isArray(chunk.vector));
  let scored;
  let minScore = MIN_VECTOR_SCORE;

  if (vectorChunks.length) {
    try {
      const [queryVector] = await embed({ host, model: index.embedModel || embedModel, input: [query] });
      scored = vectorChunks.map((chunk) => ({ chunk, score: cosineSimilarity(queryVector, chunk.vector) }));
    } catch {
      scored = null;
    }
  }

  if (!scored) {
    const queryTokens = tokenize(query);
    scored = index.chunks.map((chunk) => ({ chunk, score: keywordScore(queryTokens, chunk.text) }));
    minScore = MIN_KEYWORD_SCORE;
  }

  return scored
    .filter(({ score }) => score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ chunk, score }) => ({ file: chunk.file, startLine: chunk.startLine, text: chunk.text, score }));
};

const formatRetrievedContext = (results) => {
  if (!results.length) {
    return "";
  }

  const sections = results.map(
    (result) => `// ${result.file}:${result.startLine}\n${result.text}`,
  );

  return [
    "Reference: project code that may relate to the question below.",
    "Use it only if it is actually relevant; otherwise ignore it completely.",
    "Do not modify these files unless the user explicitly asks for changes.",
    "",
    sections.join("\n\n---\n\n"),
  ].join("\n");
};

export { buildIndex, chunkFile, cosineSimilarity, formatRetrievedContext, getIndexPath, retrieve, tokenize };
