import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LlmProvider, LlmRole } from "./registry";

/**
 * Recorded-response fixtures (issue #55). A fixture is the parsed object a given
 * provider returned for a given role, captured as JSON under `./fixtures/`. They
 * let unit/contract tests REPLAY a real provider response with no live call.
 *
 * Regenerate against live APIs with both keys set (OPENAI_API_KEY +
 * GOOGLE_GENERATIVE_AI_API_KEY) — drive each role's call site once per provider
 * and write the returned object to `fixtures/<role>.<provider>.json`. The
 * checked-in fixtures are realistic, schema-valid stand-ins until then; the
 * contract test (`fixtures.test.ts`) guarantees they satisfy each role's Zod
 * contract regardless of how they were produced.
 */

/** Load a recorded model-response fixture for a role × provider (parsed JSON). */
export function loadLlmFixture(role: LlmRole, provider: LlmProvider): unknown {
  const url = new URL(`./fixtures/${role}.${provider}.json`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

/**
 * Turn a recorded fixture into an injectable model-call fake: a function that
 * ignores its arguments and resolves to the recorded object. Drop it into
 * whichever seam a call site injects (its `generate` / `extract` fn) to replay a
 * real provider response offline.
 */
export function replayFixture<T>(fixture: T): (...args: unknown[]) => Promise<T> {
  return async () => fixture;
}
