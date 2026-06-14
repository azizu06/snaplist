import { z } from "zod";
import { resolveApiKey, resolveProvider } from "./llm/registry";

/**
 * Environment schema. Everything is env-configurable so that sandbox -> production
 * is a credential flip, not a rewrite (see PRD: "Path to real").
 *
 * Keep secrets server-only. Only NEXT_PUBLIC_* values reach the browser.
 */
const envSchema = z.object({
  // LLM provider registry (issue #55). Provider is a config flip: dev defaults to
  // Gemini (free tier — protects the OpenAI budget), the showcase runs on OpenAI.
  // `LLM_PROVIDER` overrides the NODE_ENV default (gemini/google | openai). At least
  // one provider key is required (enforced below) — OPENAI_API_KEY for the showcase,
  // GOOGLE_GENERATIVE_AI_API_KEY (or GEMINI_API_KEY) for dev. Keys are never required
  // together, so a Gemini-only dev env validates without an OpenAI key.
  LLM_PROVIDER: z.enum(["openai", "google", "gemini"]).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1).optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),

  // Web-search providers (pricing research agent)
  TAVILY_API_KEY: z.string().min(1).optional(),
  EXA_API_KEY: z.string().min(1).optional(),

  // Supabase
  NEXT_PUBLIC_SUPABASE_URL: z.string().min(1),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),

  // eBay (adapter; sandbox by default — flip to production via this URL + keys)
  EBAY_BASE_URL: z.string().min(1).default("https://api.sandbox.ebay.com"),
  // eBay Sell API credentials (issue #14). ALL OPTIONAL: the adapter reads them
  // lazily at call time and fails with a readable error if publishing is attempted
  // without them, so the rest of the app (and the offline test suite, which uses
  // the mock adapter) never needs them. App-level auth for the sandbox; per-user
  // OAuth replaces the token provider in #17 without touching the adapter.
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
}).refine(
  (e) => {
    const env = e as Record<string, string | undefined>;
    // The key for the SELECTED provider must be present — not merely *some* key.
    // resolveProvider is key-aware (a single-key env selects the usable provider),
    // so this still accepts a Gemini-only dev box, but rejects an explicit
    // LLM_PROVIDER with no matching key, or no keys at all (#55 review).
    return Boolean(resolveApiKey(resolveProvider(env), env));
  },
  {
    message:
      "Missing the API key for the selected LLM provider. Set OPENAI_API_KEY (OpenAI) or GOOGLE_GENERATIVE_AI_API_KEY / GEMINI_API_KEY (Gemini), or set LLM_PROVIDER to match the key you have.",
    path: ["OPENAI_API_KEY"],
  },
);

export type Env = z.infer<typeof envSchema>;

/**
 * Pure, testable env parser. Throws a readable error listing every invalid/missing
 * variable. Pass `process.env` (or a fixture in tests) — never reads globals itself.
 */
export function parseEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return parsed.data;
}

let cached: Env | undefined;

/** Lazily parse and cache the real process env for app (non-test) use. */
export function getEnv(): Env {
  if (!cached) cached = parseEnv(process.env);
  return cached;
}
