import type { LanguageModel } from "ai";

/** A read-only env bag. `process.env` satisfies this, and tests pass plain objects. */
type EnvLike = Record<string, string | undefined>;

/**
 * The LLM provider registry (issue #55).
 *
 * AGENTS.md: "OpenAI via the Vercel AI SDK. All model calls go through the SDK;
 * provider stays swappable." This module is the single place that decides, per
 * generation ROLE, (a) which PROVIDER answers (OpenAI or Google/Gemini) and
 * (b) which model id is used — so swapping the provider is one config flip, not
 * an edit across the ~9 model call sites.
 *
 * Why two providers: dev/build runs on **Gemini** (generous free tier, protects
 * the small OpenAI budget); the **showcase** runs on **OpenAI**. Default is
 * Gemini in dev and OpenAI in production, overridable by `LLM_PROVIDER`.
 *
 * Scope: this covers the GENERATION roles (`generateObject`/`generateText`).
 * EMBEDDINGS are deliberately excluded from the provider switch — the pgvector
 * column is `vector(1536)` and providers' embedding models differ in
 * dimensionality, so flipping the embedder would silently break retrieval
 * against the seeded corpus. `rag/embedding.ts` keeps its own OpenAI/synthetic
 * seam; a Gemini-embeddings switch needs a dimension-matched re-seed (follow-up).
 *
 * Keys are read from env ONLY, lazily at call time (never at import), and the
 * provider SDKs are lazy-imported so the offline test path never loads them.
 */

export const LLM_PROVIDERS = ["openai", "google"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

/**
 * The other provider family. Used by the eval's CROSS-FAMILY judge (#61): scoring
 * a generated listing with a model from the OPPOSITE family from the one that
 * generated it removes same-family self-bias from the listing-quality metric.
 */
export function oppositeProvider(provider: LlmProvider): LlmProvider {
  return provider === "openai" ? "google" : "openai";
}

/** The generation roles the registry routes. Embeddings are intentionally absent. */
export const LLM_ROLES = [
  "vision",
  "listing",
  "export",
  "pricingAgent",
  "judge",
  "reply",
] as const;
export type LlmRole = (typeof LLM_ROLES)[number];

/**
 * Per-role model-id env override (provider-agnostic — an advanced operator sets
 * it to a value valid for the ACTIVE provider). Preserves the pre-registry env
 * vars (`VISION_MODEL`, `LISTING_MODEL`, …) so existing deployments keep working.
 */
const ROLE_ENV_VAR: Record<LlmRole, string> = {
  vision: "VISION_MODEL",
  listing: "LISTING_MODEL",
  export: "EXPORT_PACK_MODEL",
  pricingAgent: "PRICING_MODEL",
  judge: "EVAL_JUDGE_MODEL",
  reply: "REPLY_MODEL",
};

/**
 * Provider-specific default model id per role. OpenAI keeps the established
 * `gpt-5.5`; Google defaults to `gemini-2.5-flash` (multimodal — covers vision —
 * and free-tier friendly). Confirm against live docs before changing (AGENTS.md);
 * every entry is overridable via the role env var above.
 */
const MODEL_DEFAULTS: Record<LlmProvider, Record<LlmRole, string>> = {
  openai: {
    vision: "gpt-5.5",
    listing: "gpt-5.5",
    export: "gpt-5.5",
    pricingAgent: "gpt-5.5",
    judge: "gpt-5.5",
    reply: "gpt-5.5",
  },
  google: {
    vision: "gemini-2.5-flash",
    listing: "gemini-2.5-flash",
    export: "gemini-2.5-flash",
    pricingAgent: "gemini-2.5-flash",
    judge: "gemini-2.5-flash",
    reply: "gemini-2.5-flash",
  },
};

/**
 * Resolve the active provider. Explicit `LLM_PROVIDER` (accepting the friendly
 * alias `gemini` for `google`) always wins. Otherwise the NODE_ENV default —
 * Gemini in dev, OpenAI in production ("Gemini dev / OpenAI showcase" with zero
 * config) — but it is KEY-AWARE: if the preferred provider has no key while the
 * other does, fall back to the one that's actually usable. So a single-key env
 * (e.g. an existing dev box with only OPENAI_API_KEY) selects the provider it can
 * run, instead of defaulting to a keyless one (#55 review). With neither key set
 * it returns the preferred default (the env guard then rejects the config).
 */
export function resolveProvider(env: EnvLike = process.env): LlmProvider {
  const explicit = env.LLM_PROVIDER?.trim().toLowerCase();
  if (explicit === "openai") return "openai";
  if (explicit === "google" || explicit === "gemini") return "google";
  const preferred: LlmProvider = env.NODE_ENV === "production" ? "openai" : "google";
  const fallback: LlmProvider = preferred === "openai" ? "google" : "openai";
  if (resolveApiKey(preferred, env)) return preferred;
  if (resolveApiKey(fallback, env)) return fallback;
  return preferred;
}

/**
 * Resolve the model id for a role: explicit override → role env var → the active
 * provider's default. Pure (env injectable) so the precedence is unit-testable.
 */
export function resolveModelId(
  role: LlmRole,
  opts: { provider?: LlmProvider; modelId?: string; env?: EnvLike } = {},
): string {
  const env = opts.env ?? process.env;
  const provider = opts.provider ?? resolveProvider(env);
  const override = opts.modelId?.trim() || env[ROLE_ENV_VAR[role]]?.trim();
  return override || MODEL_DEFAULTS[provider][role];
}

/** The API key for a provider, from env only (Google accepts the SDK's var or `GEMINI_API_KEY`). */
export function resolveApiKey(
  provider: LlmProvider,
  env: EnvLike = process.env,
): string | undefined {
  if (provider === "google") {
    return env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() || env.GEMINI_API_KEY?.trim();
  }
  return env.OPENAI_API_KEY?.trim();
}

export interface ResolveLanguageModelOptions {
  /** Force a provider (else `LLM_PROVIDER` / NODE_ENV default). */
  provider?: LlmProvider;
  /** Explicit model id (else role env var / provider default). */
  modelId?: string;
  /** Explicit API key (else resolved from env). */
  apiKey?: string;
}

/**
 * The registry's main entry point: return an AI SDK `LanguageModel` for a role,
 * ready to hand to `generateObject` / `generateText`. The provider SDK is
 * lazy-imported so the offline test path never loads it. Construction makes NO
 * network call — the request happens when the SDK function runs.
 */
export async function resolveLanguageModel(
  role: LlmRole,
  opts: ResolveLanguageModelOptions = {},
): Promise<LanguageModel> {
  const provider = opts.provider ?? resolveProvider();
  const modelId = resolveModelId(role, { provider, modelId: opts.modelId });
  const apiKey = opts.apiKey ?? resolveApiKey(provider);

  if (provider === "google") {
    const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
    const google = createGoogleGenerativeAI(apiKey ? { apiKey } : {});
    return google(modelId);
  }
  const { createOpenAI } = await import("@ai-sdk/openai");
  const openai = createOpenAI(apiKey ? { apiKey } : {});
  return openai.chat(modelId);
}
