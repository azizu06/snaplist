import { z } from "zod";

/**
 * Environment schema. Everything is env-configurable so that sandbox -> production
 * is a credential flip, not a rewrite (see PRD: "Path to real").
 *
 * Keep secrets server-only. Only NEXT_PUBLIC_* values reach the browser.
 */
const envSchema = z.object({
  // LLM
  OPENAI_API_KEY: z.string().min(1),

  // Web-search providers (pricing research agent)
  TAVILY_API_KEY: z.string().min(1).optional(),
  EXA_API_KEY: z.string().min(1).optional(),

  // Supabase
  NEXT_PUBLIC_SUPABASE_URL: z.string().min(1),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),

  // eBay (adapter; sandbox by default — flip to production via this URL + keys)
  EBAY_BASE_URL: z.string().min(1).default("https://api.sandbox.ebay.com"),

  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

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
