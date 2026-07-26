import { z } from "zod";
import { llmProviderConfigError, resolveApiKey, resolveProvider } from "./llm/registry";
import { validateEbaySoldProxyTemplate } from "./pricing/ebay-sold-egress";

const optionalProxyTemplateSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z
    .string()
    .transform((value, ctx) => {
      try {
        return validateEbaySoldProxyTemplate(value);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : "Invalid proxy template",
        });
        return z.NEVER;
      }
    })
    .optional(),
);

/**
 * Environment schema. Everything is env-configurable so that sandbox -> production
 * is a credential flip, not a rewrite (see PRD: "Path to real").
 *
 * Keep secrets server-only. Only NEXT_PUBLIC_* values reach the browser.
 */
const envSchema = z.object({
  // LLM provider registry (issue #55). `LLM_PROVIDER` (gemini/google | openai) is
  // REQUIRED outside local development and may be omitted only on a developer's own
  // machine, where it means Gemini (#501). The key for the SELECTED provider must be
  // present — OPENAI_API_KEY for OpenAI, GOOGLE_GENERATIVE_AI_API_KEY (or
  // GEMINI_API_KEY) for Gemini. Keys are never required together, so a Gemini-only
  // dev env validates without an OpenAI key.
  //
  // Typed as a plain string on purpose: `llmProviderConfigError` in the registry is
  // the SINGLE owner of the provider vocabulary, including its casing and whitespace
  // rules. A second z.enum here would report a differently-worded issue for the same
  // variable and disagree with the registry on values like `GEMINI` (see below).
  LLM_PROVIDER: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1).optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),

  // Web-search providers (pricing research agent)
  TAVILY_API_KEY: z.string().min(1).optional(),
  EXA_API_KEY: z.string().min(1).optional(),

  // Observability (issue #62). Sentry is OPTIONAL and DSN-gated: with no SENTRY_DSN,
  // error tracking is inert (structured logging via observability.ts still runs).
  // Set the DSN in the deploy env to activate grouped, alerted error capture.
  SENTRY_DSN: z.string().min(1).optional(),
  SENTRY_ENVIRONMENT: z.string().min(1).optional(),

  // Abuse & cost protection (issue #58). Upstash Redis powers rate limiting + the
  // daily spend guardrail; with both unset, an in-memory fallback keeps dev/offline
  // working (per-instance, not shared). Limits are env-tunable (defaults in
  // src/lib/abuse/config.ts); the numeric ones are parsed there.
  UPSTASH_REDIS_REST_URL: z.string().min(1).optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),
  RATE_LIMIT_FREE_PER_MINUTE: z.string().min(1).optional(),
  RATE_LIMIT_PAID_PER_MINUTE: z.string().min(1).optional(),
  QUOTA_FREE_ITEMS_PER_DAY: z.string().min(1).optional(),
  QUOTA_PAID_ITEMS_PER_DAY: z.string().min(1).optional(),
  OPENAI_DAILY_CALL_BUDGET: z.string().min(1).optional(),

  // Billing — freemium subscriptions via direct Stripe (issue #64). ALL OPTIONAL
  // and TEST-MODE: with these unset the billing endpoints return 503 ("not
  // configured") and `getEntitlement` reports everyone `free`, so the app (and the
  // offline test suite, which uses the mock adapter) runs without them. Set the
  // Stripe TEST keys to enable; going live is a key swap. The Pro price id is the
  // single paid plan (`tierLimits` models exactly free vs paid). Redirect URLs are
  // derived from the request origin, so no app-URL var is needed.
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  STRIPE_PRICE_PRO: z.string().min(1).optional(),

  // Native SnapList Pro lifecycle (#173). RevenueCat manages StoreKit purchase
  // state; the verified server bridge maps events into the #168 quota ledger.
  // All values are optional so local/offline builds are truthfully unconfigured.
  // The iOS SDK key is public but stays server-provided instead of source-coded.
  REVENUECAT_WEBHOOK_SIGNING_SECRET: z.string().min(1).optional(),
  REVENUECAT_WEBHOOK_AUTHORIZATION: z.string().min(1).optional(),
  REVENUECAT_APP_ID: z.string().min(1).optional(),
  REVENUECAT_ENTITLEMENT_ID: z.string().min(1).optional(),
  REVENUECAT_MONTHLY_PRODUCT_ID: z.string().min(1).optional(),
  REVENUECAT_IOS_PUBLIC_SDK_KEY: z.string().min(1).optional(),
  REVENUECAT_OFFERING_ID: z.string().min(1).optional(),
  SNAPLIST_PRO_MONTHLY_AI_ITEM_ALLOWANCE: z.string().min(1).optional(),

  // Experimental listing-example retrieval (ADR-0010). Default-off and bounded;
  // these are server-only controls and must never become native client state.
  LISTING_EXAMPLE_RETRIEVAL_ENABLED: z.string().min(1).optional(),
  LISTING_EXAMPLE_RETRIEVAL_TIMEOUT_MS: z.string().min(1).optional(),

  // eBay public sold-listings scraper (pricing tier "ebay-sold", issue #56).
  // Read-only price research over eBay's PUBLIC sold/completed pages — no API, no
  // auth, no secret. Set EBAY_SOLD_ENABLED=false (or 0/off) to disable the tier
  // (it then declines and the router degrades to the web-search tier). The base
  // host and outbound User-Agent are overridable for testing; the optional proxy
  // template is validated separately below. The provider's SSRF guard restricts
  // every target fetch to https *.ebay.com regardless.
  EBAY_SOLD_ENABLED: z.string().min(1).optional(),
  EBAY_SOLD_BASE_URL: z.string().min(1).optional(),
  EBAY_SOLD_USER_AGENT: z.string().min(1).optional(),
  // Optional vendor-agnostic egress seam for hosted environments where direct
  // server fetches are blocked. Missing/blank preserves direct fetch; a present
  // template is validated at config startup and must contain one `{url}` target.
  EBAY_SOLD_PROXY_TEMPLATE: optionalProxyTemplateSchema,
  // Pricing freshness (#59). All OPTIONAL with sane defaults (parsed in
  // src/lib/pricing/providers/ebay-sold.ts + freshness.ts). The TTL cache of
  // sold-comp scrapes reuses a pull for a few days (cuts scrape footprint; the
  // live page stays the source of truth); the staleness cutoff drops sales older
  // than N days; the half-life sets how fast a sale's influence on the suggested
  // price decays. With Upstash unset the cache degrades to a per-instance
  // in-memory fallback (offline-safe).
  EBAY_SOLD_CACHE_TTL_HOURS: z.string().min(1).optional(),
  EBAY_SOLD_STALE_DAYS: z.string().min(1).optional(),
  EBAY_SOLD_HALFLIFE_DAYS: z.string().min(1).optional(),

  // Background repricing and inbox sync. CRON_SECRET authenticates both routes:
  // Vercel invokes daily repricing and Supabase pg_cron/pg_net invokes the
  // five-minute inbox sync with the same bearer. With it UNSET the cron routes
  // refuse to run — the safe default. The numeric knobs below are repricing
  // policy (defaults: 14d window, batch 5, 10% drift).
  CRON_SECRET: z.string().min(1).optional(),
  REPRICE_STALE_DAYS: z.string().min(1).optional(),
  REPRICE_BATCH_SIZE: z.string().min(1).optional(),
  REPRICE_DRIFT_THRESHOLD_PCT: z.string().min(1).optional(),

  // Supabase
  NEXT_PUBLIC_SUPABASE_URL: z.string().min(1),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),

  // eBay (adapter; sandbox by default — flip to production via this URL + keys)
  EBAY_BASE_URL: z.string().min(1).default("https://api.sandbox.ebay.com"),
  // eBay API credentials. ALL OPTIONAL: adapters read them lazily at call time,
  // so the app and offline tests do not need them. Connected sellers use their
  // encrypted per-user grant. Env tokens are a restricted fallback for one
  // explicitly configured operator user/seller in the exact Sandbox origin.
  EBAY_CLIENT_ID: z.string().min(1).optional(),
  EBAY_CLIENT_SECRET: z.string().min(1).optional(),
  // A user refresh token (minted once via the authorization-code flow) exchanged
  // for short-lived access tokens; OR a pre-minted user access token for quick
  // sandbox testing. Either unlocks the Sell Inventory API.
  EBAY_REFRESH_TOKEN: z.string().min(1).optional(),
  EBAY_OAUTH_TOKEN: z.string().min(1).optional(),
  // Marketplace + business policies the offer is created against. Policy ids come
  // from the seller's sandbox account (Seller Hub or the Account API).
  EBAY_MARKETPLACE_ID: z.string().min(1).default("EBAY_US"),
  // Offer currency override; when unset the marketplace id determines it.
  EBAY_CURRENCY: z.string().min(1).optional(),
  // Content-Language locale override (e.g. nl-BE); when unset the marketplace
  // id determines it (EBAY_DE -> de-DE).
  EBAY_CONTENT_LANGUAGE: z.string().min(1).optional(),
  EBAY_FULFILLMENT_POLICY_ID: z.string().min(1).optional(),
  EBAY_PAYMENT_POLICY_ID: z.string().min(1).optional(),
  EBAY_RETURN_POLICY_ID: z.string().min(1).optional(),
  EBAY_MERCHANT_LOCATION_KEY: z.string().min(1).optional(),
  // Default leaf category for offers when the pipeline hasn't resolved one.
  EBAY_DEFAULT_CATEGORY_ID: z.string().min(1).optional(),
  // eBay Marketplace Account Deletion endpoint (production flip only). Catalogued here
  // for discoverability; the route reads them directly so the endpoint isn't coupled to
  // unrelated required vars (OPENAI/Supabase) at request time.
  EBAY_VERIFICATION_TOKEN: z.string().min(1).optional(),
  EBAY_DELETION_ENDPOINT_URL: z.string().min(1).optional(),

  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

/**
 * LLM provider issues, in `parseEnv`'s "  - VAR: message" issue format.
 *
 * Checked against the RAW environment rather than the schema's parsed output, for
 * two reasons. The deployment markers that prove a process is not a local machine
 * (#501) are the hosting platform's own variables, which this schema does not
 * declare and zod therefore strips. And NODE_ENV's schema default must not soften
 * the fence: an absent NODE_ENV has to mean the same thing here as it does to
 * `resolveProvider(process.env)` at call time.
 */
function llmProviderIssues(raw: Record<string, unknown>): string[] {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") env[key] = value;
  }

  // The provider must be SELECTABLE before anything can be said about its key.
  // Outside local development an unset LLM_PROVIDER is a config failure, never a
  // default that quietly lands on Google's unpaid tier (#501).
  const providerError = llmProviderConfigError(env);
  if (providerError) return [`  - LLM_PROVIDER: ${providerError}`];

  // The key for the SELECTED provider must be present — not merely *some* key.
  // resolveProvider is key-aware in local development (a single-key box selects
  // the usable provider), so this still accepts a Gemini-only dev box, but rejects
  // an explicit LLM_PROVIDER with no matching key, or no keys at all (#55 review).
  if (!resolveApiKey(resolveProvider(env), env)) {
    return [
      "  - OPENAI_API_KEY: Missing the API key for the selected LLM provider. Set OPENAI_API_KEY (OpenAI) or GOOGLE_GENERATIVE_AI_API_KEY / GEMINI_API_KEY (Gemini), or set LLM_PROVIDER to match the key you have.",
    ];
  }
  return [];
}

export type Env = z.infer<typeof envSchema>;

/**
 * Pure, testable env parser. Throws a readable error listing every invalid/missing
 * variable. Pass `process.env` (or a fixture in tests) — never reads globals itself.
 */
export function parseEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  const issues = parsed.success
    ? []
    : parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
  issues.push(...llmProviderIssues(raw));

  if (!parsed.success) throw new Error(`Invalid environment variables:\n${issues.join("\n")}`);
  if (issues.length > 0) throw new Error(`Invalid environment variables:\n${issues.join("\n")}`);
  return parsed.data;
}

let cached: Env | undefined;

/** Lazily parse and cache the real process env for app (non-test) use. */
export function getEnv(): Env {
  if (!cached) cached = parseEnv(process.env);
  return cached;
}
