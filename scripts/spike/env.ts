import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Load ../../.env.local into process.env without overriding already-set vars.
 * Same minimal parser as scripts/scrape-smoke.ts — no dotenv dependency.
 */
export function loadEnvLocal(): void {
  const path = fileURLToPath(new URL("../../.env.local", import.meta.url));
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // no .env.local — rely on the ambient environment
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export const SPIKE_DIR = fileURLToPath(new URL(".", import.meta.url));
