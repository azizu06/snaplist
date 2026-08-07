import { wrapLanguageModel, type LanguageModel } from "ai";
import { usageRecordingMiddleware } from "./usage-recording";

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
};

/**
 * Provider-specific default model id per role. OpenAI uses `gpt-5.6-terra`
 * (text + image input, structured outputs, and 60% cheaper per token than the
 * `gpt-5.5` it replaced — see docs/unit-economics); Google defaults to
 * `gemini-2.5-flash` (multimodal — covers vision —
 * and free-tier friendly). Confirm against live docs before changing (AGENTS.md);
 * every entry is overridable via the role env var above.
 */
const MODEL_DEFAULTS: Record<LlmProvider, Record<LlmRole, string>> = {
  openai: {
    vision: "gpt-5.6-terra",
    listing: "gpt-5.6-terra",
    export: "gpt-5.6-terra",
    pricingAgent: "gpt-5.6-terra",
    judge: "gpt-5.6-terra",
  },
  google: {
    vision: "gemini-2.5-flash",
    listing: "gemini-2.5-flash",
    export: "gemini-2.5-flash",
    pricingAgent: "gemini-2.5-flash",
    judge: "gemini-2.5-flash",
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
 * Roles whose model request carries the SELLER'S OWN MEDIA — raw photo or audio
 * bytes — rather than text derived from it.
 *
 * `vision` is the only one: `vision/extract.ts` and `vision/measurements.ts` are
 * the product call sites that build `{ type: "image" }` parts, and the bytes they
 * send come straight out of the private `photos` bucket (`vision/photos.ts`).
 * Every other role receives text. `seller-media-fence.test.ts` scans the whole
 * repository and fails if a new module starts sending media without joining this
 * set or being recorded as an exemption, so the fence below cannot be reopened by
 * a role quietly gaining a media payload.
 *
 * One media call site outside `src/` is exempt by decision: `scripts/spike/
 * garment-measure.ts` sends other sellers' already-public eBay gallery photos, not
 * a SnapList seller's own. ADR-0002 Amendment 2 records the reasoning.
 */
export const SELLER_MEDIA_ROLES: ReadonlySet<LlmRole> = new Set<LlmRole>(["vision"]);

/**
 * The operator's attestation that the Google project behind the Gemini key is
 * billing-enabled, so Google's **Paid Services** terms apply to it.
 *
 * It is a claim about an external fact that no code on this machine can observe:
 * billing lives in the Google console, not in the repository. So it is asked for
 * by name and defaults to "not attested" — the safe answer — rather than being
 * inferred from the presence of a key, a NODE_ENV, or anything else.
 */
const GEMINI_BILLING_VAR = "GEMINI_BILLING_ENABLED";

/**
 * Parse the attestation: `true`/`false` (any casing, trimmed), unset meaning not
 * attested. `undefined` means the value was set to something that is neither.
 */
function parseGeminiBillingAttestation(env: EnvLike): boolean | undefined {
  const raw = env[GEMINI_BILLING_VAR]?.trim().toLowerCase() ?? "";
  if (raw === "") return false;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}

/**
 * Why `GEMINI_BILLING_ENABLED` cannot be read, or `undefined` if it can.
 *
 * Reported whatever the active provider is. The variable's vocabulary must not
 * depend on which provider happens to be selected today, or a config that says
 * `yes` would sit silently on an OpenAI deploy and then fail closed — confusingly
 * — the moment someone flipped `LLM_PROVIDER`.
 */
export function geminiBillingConfigError(env: EnvLike = process.env): string | undefined {
  if (parseGeminiBillingAttestation(env) !== undefined) return undefined;
  return (
    `${GEMINI_BILLING_VAR} is set to "${env[GEMINI_BILLING_VAR]}", which is neither ` +
    `"true" nor "false". It attests that the Google project behind the Gemini key ` +
    `is billing-enabled, so it must be stated exactly.`
  );
}

/**
 * Why this configuration may not hand `role`'s payload to `provider`, or
 * `undefined` if it may. Pure and non-throwing so the env schema can report it
 * alongside every other bad variable instead of blowing up mid-parse (#501).
 *
 * Google's Gemini API Terms split on BILLING, not on environment. Under **Unpaid
 * Services** Google uses submitted content and responses "to improve, and develop
 * Google products and services" and "Human reviewers may read, annotate, and
 * process your API input and output." Under **Paid Services** it does not, and
 * only then are the retention controls even available. A seller photo is taken
 * inside someone's home and carries faces, addresses, documents, and surroundings
 * far beyond the item, so the unpaid bargain is not ours to accept on their
 * behalf.
 *
 * Local development is the one exception, and it is allowed by name rather than
 * by fallthrough: the photos crossing a developer's own machine are that
 * developer's own, which is the condition ADR-0002 records this trade resting on.
 * It stops holding the moment a photo they did not take enters a local pipeline —
 * a seeded corpus of real listing photos, a privately supplied gold set, or a
 * TestFlight build pointed at a dev configuration — and ADR-0002 says to revisit
 * it then. `scripts/spike/garment-measure.ts` already sends photos the developer
 * did not take; it is exempt because those photos are their sellers' own public
 * listing images, and ADR-0002 Amendment 2 records that as a decision.
 */
export function sellerMediaConfigError(
  role: LlmRole,
  provider: LlmProvider,
  env: EnvLike = process.env,
): string | undefined {
  const vocabularyError = geminiBillingConfigError(env);
  if (vocabularyError) return vocabularyError;

  if (!SELLER_MEDIA_ROLES.has(role)) return undefined;
  if (provider !== "google") return undefined;
  if (parseGeminiBillingAttestation(env) === true) return undefined;
  if (isLocalDevelopment(env)) return undefined;

  return (
    `The "${role}" role sends the seller's own photo bytes to the model, and this ` +
    `configuration would send them to Google's Gemini on the UNPAID tier, whose terms ` +
    `permit Google to use submitted content to improve its products and permit human ` +
    `reviewers to read API input and output. Choose another provider ` +
    `(LLM_PROVIDER=openai), or set ${GEMINI_BILLING_VAR}=true once the Google project ` +
    `behind the key is billing-enabled so the Paid Services terms apply. Do not set it ` +
    `to make this message go away — it is a claim about billing, and the seller's ` +
    `photos are what rests on it.`
  );
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
  /** Env bag to resolve against (defaults to `process.env`; injectable for tests). */
  env?: EnvLike;
}

/**
 * The registry's main entry point: return an AI SDK `LanguageModel` for a role,
 * ready to hand to `generateObject` / `generateText`. The provider SDK is
 * lazy-imported so the offline test path never loads it. Construction makes NO
 * network call — the request happens when the SDK function runs.
 *
 * This is where the seller-media fence bites, and it is checked against the
 * EFFECTIVE provider rather than `LLM_PROVIDER`, so a call site that forces
 * `provider: "google"` (the eval's cross-family judge, a spike script) is fenced
 * on the same terms as a deploy that selected it. Throwing here is the guarantee
 * that holds identically on every host — the config-startup checks are earlier
 * and friendlier, but how hard they stop depends on the platform (ADR-0002).
 */
export async function resolveLanguageModel(
  role: LlmRole,
  opts: ResolveLanguageModelOptions = {},
): Promise<LanguageModel> {
  const env = opts.env ?? process.env;
  const provider = opts.provider ?? resolveProvider(env);
  const mediaError = sellerMediaConfigError(role, provider, env);
  if (mediaError) throw new Error(mediaError);

  const modelId = resolveModelId(role, { provider, modelId: opts.modelId, env });
  const apiKey = opts.apiKey ?? resolveApiKey(provider, env);

  // Every model handed out here is wrapped so its token counts reach the active
  // provider-usage run (#716). The wrap is applied to the RESOLVED model, so the
  // recorded id is what actually answered — not a role default read back from
  // this file, which moves whenever the provider or a `*_MODEL` override does.
  const recordUsage = usageRecordingMiddleware({ role, provider, model: modelId });

  if (provider === "google") {
    const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
    const google = createGoogleGenerativeAI(apiKey ? { apiKey } : {});
    return wrapLanguageModel({ model: google(modelId), middleware: recordUsage });
  }
  const { createOpenAI } = await import("@ai-sdk/openai");
  const openai = createOpenAI(apiKey ? { apiKey } : {});
  return wrapLanguageModel({ model: openai.chat(modelId), middleware: recordUsage });
}
