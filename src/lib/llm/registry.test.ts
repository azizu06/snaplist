import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LLM_ROLES,
  resolveApiKey,
  resolveLanguageModel,
  resolveModelId,
  resolveProvider,
} from "./registry";

/**
 * LLM provider registry (issue #55). The resolution functions are pure over an
 * injected env, so precedence is unit-testable offline. `resolveLanguageModel`
 * lazy-imports the real provider SDKs but makes NO network call at construction.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveProvider", () => {
  it("defaults to Gemini in dev and OpenAI in production", () => {
    expect(resolveProvider({ NODE_ENV: "development" })).toBe("google");
    expect(resolveProvider({ NODE_ENV: "test" })).toBe("google");
    expect(resolveProvider({ NODE_ENV: "production" })).toBe("openai");
  });

  it("honors an explicit LLM_PROVIDER (with `gemini` as an alias for google)", () => {
    expect(resolveProvider({ LLM_PROVIDER: "openai" })).toBe("openai");
    expect(resolveProvider({ LLM_PROVIDER: "google" })).toBe("google");
    expect(resolveProvider({ LLM_PROVIDER: "gemini" })).toBe("google");
    // Explicit wins over the NODE_ENV default.
    expect(
      resolveProvider({ LLM_PROVIDER: "openai", NODE_ENV: "development" }),
    ).toBe("openai");
  });

  it("is key-aware: falls back to the provider whose key is present", () => {
    // Dev default is Gemini, but with only an OpenAI key it picks OpenAI (usable)
    // instead of a keyless Gemini (#55 review).
    expect(resolveProvider({ NODE_ENV: "development", OPENAI_API_KEY: "x" })).toBe("openai");
    // Prod default is OpenAI, but with only a Gemini key it picks Gemini.
    expect(resolveProvider({ NODE_ENV: "production", GEMINI_API_KEY: "y" })).toBe("google");
    // Explicit LLM_PROVIDER still wins even against the available key.
    expect(
      resolveProvider({ LLM_PROVIDER: "google", OPENAI_API_KEY: "x" }),
    ).toBe("google");
  });
});

describe("resolveModelId", () => {
  it("falls back to the active provider's per-role default", () => {
    expect(resolveModelId("vision", { provider: "openai", env: {} })).toBe("gpt-5.5");
    expect(resolveModelId("vision", { provider: "google", env: {} })).toBe("gemini-2.5-flash");
    expect(resolveModelId("judge", { provider: "google", env: {} })).toBe("gemini-2.5-flash");
  });

  it("lets the role env var override the default, and an explicit id override the env var", () => {
    const env = { VISION_MODEL: "gpt-vision-custom" };
    expect(resolveModelId("vision", { provider: "openai", env })).toBe("gpt-vision-custom");
    expect(resolveModelId("vision", { provider: "openai", env, modelId: "explicit-id" })).toBe(
      "explicit-id",
    );
    // A role's env var only affects that role.
    expect(resolveModelId("listing", { provider: "openai", env })).toBe("gpt-5.5");
  });

  it("maps each role to its own env override var", () => {
    expect(
      resolveModelId("pricingAgent", { provider: "openai", env: { PRICING_MODEL: "p" } }),
    ).toBe("p");
    expect(
      resolveModelId("reply", { provider: "openai", env: { REPLY_MODEL: "r" } }),
    ).toBe("r");
    expect(
      resolveModelId("export", { provider: "openai", env: { EXPORT_PACK_MODEL: "e" } }),
    ).toBe("e");
  });
});

describe("resolveApiKey", () => {
  it("reads the provider-specific env key (Google accepts either var)", () => {
    expect(resolveApiKey("openai", { OPENAI_API_KEY: "sk-o" })).toBe("sk-o");
    expect(
      resolveApiKey("google", { GOOGLE_GENERATIVE_AI_API_KEY: "g1" }),
    ).toBe("g1");
    expect(resolveApiKey("google", { GEMINI_API_KEY: "g2" })).toBe("g2");
    expect(resolveApiKey("google", {})).toBeUndefined();
  });
});

describe("resolveLanguageModel", () => {
  it("returns a usable model for BOTH providers without a network call", async () => {
    for (const provider of ["openai", "google"] as const) {
      const model = await resolveLanguageModel("vision", { provider, apiKey: "test-key" });
      expect(model).toBeTruthy();
    }
  });

  it("constructs a model for every role", async () => {
    for (const role of LLM_ROLES) {
      const model = await resolveLanguageModel(role, { provider: "openai", apiKey: "test-key" });
      expect(model).toBeTruthy();
    }
  });
});
