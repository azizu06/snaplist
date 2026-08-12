/**
 * LLM provider registry public surface (issue #55). Generation roles route
 * through here so the provider (OpenAI / Gemini) is a `LLM_PROVIDER` config flip
 * rather than an edit across every model call site.
 */
export {
  resolveLanguageModel,
  resolveTranscriptionModel,
  resolveProvider,
  resolveModelId,
  resolveTranscriptionModelId,
  resolveApiKey,
  oppositeProvider,
  sellerMediaConfigError,
  geminiBillingConfigError,
  LLM_PROVIDERS,
  LLM_ROLES,
  TRANSCRIPTION_ROLES,
  SELLER_MEDIA_ROLES,
  type LlmProvider,
  type LlmRole,
  type TranscriptionRole,
  type ResolveLanguageModelOptions,
  type ResolveTranscriptionModelOptions,
  type ResolvedTranscriptionModel,
} from "./registry";
// NOTE: the runtime barrel exports ONLY the registry. The fixture helpers
// (`./fixtures`, which import `node:fs`) and the contract map (`./contracts`,
// which imports the role modules) are TEST-ONLY. Re-exporting them here would
// pull `node:fs` into the client bundle — this barrel is reached by `reply.ts`,
// which a client component imports — and `contracts` would create an import
// cycle. Import them directly from `./fixtures` / `./contracts` in tests.
