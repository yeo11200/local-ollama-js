#!/usr/bin/env node

import { run } from "../bin/llm.js";

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
