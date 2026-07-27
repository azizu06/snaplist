#!/usr/bin/env node

import { runSupabase } from "./wrapper.mjs";

try {
  const result = await runSupabase(process.argv.slice(2));
  process.exit(result.status);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
