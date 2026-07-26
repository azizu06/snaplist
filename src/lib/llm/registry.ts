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
 * the small OpenAI budget); the **showcase** runs on **OpenAI**. `LLM_PROVIDER`
 * selects one. It may be omitted ONLY on a local development machine, where it
 * means Gemini; everywhere else omitting it is a hard failure, because the free
 * tier's terms permit product-improvement use and human review of submitted
 * content and seller photos resolve through here (#501).
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
  "clarify",
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
  clarify: "CLARIFY_MODEL",
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
    clarify: "gpt-5.5",
  },
  google: {
    vision: "gemini-2.5-flash",
    listing: "gemini-2.5-flash",
    export: "gemini-2.5-flash",
    pricingAgent: "gemini-2.5-flash",
    judge: "gemini-2.5-flash",
    reply: "gemini-2.5-flash",
    clarify: "gemini-2.5-flash",
  },
};

/** Accepted `LLM_PROVIDER` spellings (`gemini` is the friendly alias for `google`). */
const PROVIDER_ALIASES: Record<string, LlmProvider | undefined> = {
  openai: "openai",
  google: "google",
  gemini: "google",
};

/**
 * Env vars set by the runtime of a hosted platform, never by a developer's shell.
 * Presence of ANY of them means this process is deployed, so an unset
 * `LLM_PROVIDER` must fail rather than default (#501).
 *
 * `CI` is deliberately NOT here: continuous integration is not a deploy, serves
 * no seller, and gating on it would make the offline suite behave differently in
 * CI than on the machine that wrote it.
 */
const DEPLOYMENT_MARKERS = [
  "VERCEL",
  "VERCEL_ENV",
  "RENDER",
  "RAILWAY_ENVIRONMENT",
  "FLY_APP_NAME",
  "AWS_LAMBDA_FUNCTION_NAME",
  "AWS_EXECUTION_ENV",
  "KUBERNETES_SERVICE_HOST",
  "NETLIFY",
  "DYNO",
] as const;

/** NODE_ENV values a developer's own machine runs under (`next dev`, vitest, a bare `tsx` script). */
const LOCAL_NODE_ENVS = new Set(["", "development", "test"]);

/**
 * The provider local development uses when `LLM_PROVIDER` is unset. Named here
 * rather than derived from NODE_ENV: the old code reached Gemini by falling
 * through the same branch a deploy would fall through, which is exactly how a
 * production deploy could have landed on it (#501).
 */
const LOCAL_DEVELOPMENT_PROVIDER: LlmProvider = "google";

/**
 * Is this process a developer's own machine — the ONE place an unset
 * `LLM_PROVIDER` may resolve to a default?
 *
 * Both conditions must hold, so it cannot be satisfied by forgetting something:
 * NODE_ENV is absent or a local value (`staging`/`preview`/`production` all
 * fail), AND no hosted platform's runtime marker is present.
 */
export function isLocalDevelopment(env: EnvLike = process.env): boolean {
  if (!LOCAL_NODE_ENVS.has(env.NODE_ENV?.trim() ?? "")) return false;
  return !DEPLOYMENT_MARKERS.some((marker) => (env[marker]?.trim() ?? "") !== "");
}

/**
 * Why this env cannot select a provider, or `undefined` if it can. Pure and
 * non-throwing so the env schema can report it as a validation issue alongside
 * every other bad variable instead of blowing up mid-parse.
 */
export function llmProviderConfigError(env: EnvLike = process.env): string | undefined {
  const raw = env.LLM_PROVIDER?.trim();
  if (raw) {
    if (PROVIDER_ALIASES[raw.toLowerCase()]) return undefined;
    return (
      `LLM_PROVIDER is set to "${raw}", which is not a provider. ` +
      `Set it to one of: ${Object.keys(PROVIDER_ALIASES).join(", ")}.`
    );
  }
  if (isLocalDevelopment(env)) return undefined;
  return (
    "LLM_PROVIDER is not set. Outside local development the provider must be chosen " +
    "explicitly (openai, google, or gemini). It must never be reached by fallthrough: " +
    "Google's unpaid tier permits use of submitted content to improve Google products " +
    "and permits human review of it, and seller photos resolve through this registry."
  );
}

/**
 * Resolve the active provider. Explicit `LLM_PROVIDER` (accepting the friendly
 * alias `gemini` for `google`) always wins.
 *
 * With it unset, resolution is allowed ONLY on a local development machine, and
 * there it selects Gemini by name (generous free tier, protects the small OpenAI
 * budget). Anywhere else this THROWS — a deploy that omits the variable fails
 * loudly instead of silently routing seller photos to a free tier whose terms
 * permit product-improvement use and human review (#501).
 *
 * The local path stays KEY-AWARE: if Gemini has no key while OpenAI does, use the
 * provider that can actually run, instead of a keyless one (#55 review). With
 * neither key set it returns Gemini and the env guard rejects the config.
 */
export function resolveProvider(env: EnvLike = process.env): LlmProvider {
  const error = llmProviderConfigError(env);
  if (error) throw new Error(error);

  const explicit = PROVIDER_ALIASES[env.LLM_PROVIDER?.trim().toLowerCase() ?? ""];
  if (explicit) return explicit;

  const preferred = LOCAL_DEVELOPMENT_PROVIDER;
  const fallback = oppositeProvider(preferred);
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
  /** Force a provider (else `LLM_PROVIDER`, which is required outside local dev). */
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
