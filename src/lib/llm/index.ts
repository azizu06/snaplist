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
