/**
 * LLM provider registry public surface (issue #55). Generation roles route
 * through here so the provider (OpenAI / Gemini) is a `LLM_PROVIDER` config flip
 * rather than an edit across every model call site.
 */
export {
  resolveLanguageModel,
  resolveProvider,
  resolveModelId,
  resolveApiKey,
  LLM_PROVIDERS,
  LLM_ROLES,
  type LlmProvider,
  type LlmRole,
  type ResolveLanguageModelOptions,
} from "./registry";
// Recorded-response fixtures for offline replay + cross-provider contract tests.
// (`contracts.ts` is deliberately NOT re-exported here — it imports the role
// modules, which import this barrel, so re-exporting it would create a cycle.)
export { loadLlmFixture, replayFixture } from "./fixtures";
