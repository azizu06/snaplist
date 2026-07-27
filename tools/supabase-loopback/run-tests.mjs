import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
if (args.length !== 1 || args[0] !== "--source-only") {
  console.error("Usage: pnpm test:supabase-loopback -- --source-only");
  process.exit(2);
}

const toolRoot = path.dirname(fileURLToPath(import.meta.url));
const result = spawnSync(
  process.execPath,
  [
    "--test",
    path.join(toolRoot, "source-only.test.mjs"),
    path.join(toolRoot, "wrapper.test.mjs"),
  ],
  { stdio: "inherit" },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
