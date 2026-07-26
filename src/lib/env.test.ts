import { describe, it, expect } from "vitest";
import { parseEnv } from "./env";

const valid = {
  OPENAI_API_KEY: "sk-test",
  NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-test",
};

describe("parseEnv", () => {
  it("accepts a minimal valid env and applies defaults", () => {
    const env = parseEnv(valid);
    expect(env.OPENAI_API_KEY).toBe("sk-test");
    // env-configurable eBay base defaults to sandbox
    expect(env.EBAY_BASE_URL).toBe("https://api.sandbox.ebay.com");
    expect(env.NODE_ENV).toBe("development");
  });

  it("throws when NO LLM provider key is present (names OPENAI_API_KEY)", () => {
    // OPENAI_API_KEY is no longer required on its own (dev runs on Gemini), but at
    // least one provider key must be set — the guard message names OPENAI_API_KEY.
    const { OPENAI_API_KEY, ...missingKey } = valid;
    void OPENAI_API_KEY;
    expect(() => parseEnv(missingKey)).toThrowError(/OPENAI_API_KEY/);
  });

  it("accepts a Gemini-only dev env (no OpenAI key) and parses LLM_PROVIDER", () => {
    const { OPENAI_API_KEY, ...noOpenAI } = valid;
    void OPENAI_API_KEY;
    const env = parseEnv({
      ...noOpenAI,
      GOOGLE_GENERATIVE_AI_API_KEY: "g-test",
      LLM_PROVIDER: "gemini",
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GOOGLE_GENERATIVE_AI_API_KEY).toBe("g-test");
    expect(env.LLM_PROVIDER).toBe("gemini");
  });

  it("rejects a provider/key mismatch (LLM_PROVIDER=google but only OPENAI_API_KEY)", () => {
    // The "at least one key" check isn't enough: the SELECTED provider needs its
    // own key, or every request fails at runtime (#55 review).
    expect(() => parseEnv({ ...valid, LLM_PROVIDER: "google" })).toThrowError(
      /selected LLM provider/,
    );
  });

  it("fails config startup when LLM_PROVIDER is unset outside local development (#501)", () => {
    // Reported as a normal validation issue, alongside every other bad variable,
    // rather than escaping as a bare provider error mid-parse.
    expect(() => parseEnv({ ...valid, NODE_ENV: "production" })).toThrowError(
      /Invalid environment variables[\s\S]*LLM_PROVIDER/,
    );
    // A deploy marker makes it a deploy even when NODE_ENV reads as local.
    expect(() => parseEnv({ ...valid, NODE_ENV: "development", VERCEL: "1" })).toThrowError(
      /Invalid environment variables[\s\S]*LLM_PROVIDER/,
    );
  });

  it("treats web-search and service-role keys as optional", () => {
    const env = parseEnv(valid);
    expect(env.TAVILY_API_KEY).toBeUndefined();
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
  });

  it("accepts the server-only listing-example experiment controls", () => {
    const env = parseEnv({
      ...valid,
      LISTING_EXAMPLE_RETRIEVAL_ENABLED: "true",
      LISTING_EXAMPLE_RETRIEVAL_TIMEOUT_MS: "2000",
    });

    expect(env.LISTING_EXAMPLE_RETRIEVAL_ENABLED).toBe("true");
    expect(env.LISTING_EXAMPLE_RETRIEVAL_TIMEOUT_MS).toBe("2000");
  });

  it("treats a missing or blank sold-comps proxy template as optional", () => {
    expect(parseEnv(valid).EBAY_SOLD_PROXY_TEMPLATE).toBeUndefined();
    expect(
      parseEnv({ ...valid, EBAY_SOLD_PROXY_TEMPLATE: "   " })
        .EBAY_SOLD_PROXY_TEMPLATE,
    ).toBeUndefined();
  });

  it("accepts a valid HTTPS sold-comps proxy template", () => {
    const env = parseEnv({
      ...valid,
      EBAY_SOLD_PROXY_TEMPLATE:
        "https://proxy.example/fetch?token=deploy-secret&url={url}",
    });

    expect(env.EBAY_SOLD_PROXY_TEMPLATE).toContain("{url}");
  });

  it.each([
    ["missing placeholder", "https://proxy.example/fetch"],
    ["non-HTTPS transport", "http://proxy.example/fetch?url={url}"],
    ["embedded credentials", "https://user:pass@proxy.example/fetch?url={url}"],
    ["unparseable URL", "not-a-url/{url}"],
  ])("rejects a malformed sold-comps proxy template: %s", (_label, template) => {
    expect(() =>
      parseEnv({ ...valid, EBAY_SOLD_PROXY_TEMPLATE: template }),
    ).toThrowError(/EBAY_SOLD_PROXY_TEMPLATE/);
  });
});
