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

  it("throws listing the missing required variable", () => {
    const { OPENAI_API_KEY, ...missingKey } = valid;
    void OPENAI_API_KEY;
    expect(() => parseEnv(missingKey)).toThrowError(/OPENAI_API_KEY/);
  });

  it("treats web-search and service-role keys as optional", () => {
    const env = parseEnv(valid);
    expect(env.TAVILY_API_KEY).toBeUndefined();
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
  });
});
