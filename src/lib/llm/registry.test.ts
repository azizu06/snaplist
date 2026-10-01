import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LLM_ROLES,
  oppositeProvider,
  resolveApiKey,
  resolveLanguageModel,
  resolveModelId,
  resolveProvider,
  resolveTranscriptionModel,
  isSellerContextTranscriptionEnabled,
  sellerContextTranscriptionConfigError,
} from "./registry";

/**
 * LLM provider registry (issue #55). The resolution functions are pure over an
 * injected env, so precedence is unit-testable offline. `resolveLanguageModel`
 * lazy-imports the real provider SDKs but makes NO network call at construction.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("oppositeProvider", () => {
  it("flips the provider family (the cross-family judge anchor, #61)", () => {
    expect(oppositeProvider("openai")).toBe("google");
    expect(oppositeProvider("google")).toBe("openai");
  });

  it("is an involution (flipping twice is identity)", () => {
    expect(oppositeProvider(oppositeProvider("openai"))).toBe("openai");
    expect(oppositeProvider(oppositeProvider("google"))).toBe("google");
  });
});

describe("resolveProvider", () => {
  it("refuses to resolve an unset LLM_PROVIDER outside local development (#501)", () => {
    // The provider must never be reached by fallthrough in a deploy: Google's
    // free tier permits product-improvement use and human review of submitted
    // content, and seller photos resolve through this function.
    for (const NODE_ENV of ["production", "staging", "preview"]) {
      expect(() => resolveProvider({ NODE_ENV })).toThrowError(/LLM_PROVIDER/);
    }
  });

  it("still resolves for a deploy that DID choose a provider (#501)", () => {
    // The other direction of the fence. Without this, inverting the local-development
    // check would break every deploy and leave the suite green.
    expect(resolveProvider({ NODE_ENV: "production", LLM_PROVIDER: "openai" })).toBe("openai");
    expect(resolveProvider({ NODE_ENV: "production", LLM_PROVIDER: "gemini" })).toBe("google");
    expect(resolveProvider({ VERCEL: "1", LLM_PROVIDER: "openai" })).toBe("openai");
  });

  it("rejects a misspelled LLM_PROVIDER instead of falling through to a default (#501)", () => {
    // A typo is a set value, so the "unset" fence never sees it. Left to fall
    // through it would land on the same default the fence exists to remove.
    expect(() => resolveProvider({ LLM_PROVIDER: "gemni" })).toThrowError(/"gemni"/);
    expect(() =>
      resolveProvider({ LLM_PROVIDER: "openal", NODE_ENV: "development" }),
    ).toThrowError(/not a provider/);
  });

  it("treats a hosted platform's runtime marker as a deploy, whatever NODE_ENV says (#501)", () => {
    // A deploy that sets NODE_ENV=development must not read as a local machine.
    for (const marker of ["VERCEL", "RENDER", "RAILWAY_ENVIRONMENT", "FLY_APP_NAME"]) {
      expect(() =>
        resolveProvider({ NODE_ENV: "development", [marker]: "1" }),
      ).toThrowError(/LLM_PROVIDER/);
    }
    // CI is not a deploy: the offline suite must behave the same in CI as locally.
    expect(resolveProvider({ NODE_ENV: "test", CI: "true" })).toBe("google");
  });

  it("defaults to Gemini in local development, by name", () => {
    expect(resolveProvider({ NODE_ENV: "development" })).toBe("google");
    expect(resolveProvider({ NODE_ENV: "test" })).toBe("google");
    // A bare `tsx` script leaves NODE_ENV unset; that is still a local machine.
    expect(resolveProvider({})).toBe("google");
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

  it("is key-aware in local development: falls back to the provider whose key is present", () => {
    // Local default is Gemini, but with only an OpenAI key it picks OpenAI (usable)
    // instead of a keyless Gemini (#55 review). Both keys are the developer's own.
    expect(resolveProvider({ NODE_ENV: "development", OPENAI_API_KEY: "x" })).toBe("openai");
    expect(resolveProvider({ NODE_ENV: "development", GEMINI_API_KEY: "y" })).toBe("google");
    // Explicit LLM_PROVIDER still wins even against the available key.
    expect(
      resolveProvider({ LLM_PROVIDER: "google", OPENAI_API_KEY: "x" }),
    ).toBe("google");
  });

  it("does not let key-awareness pick a provider for a deploy (#501)", () => {
    // The sharpest form of the old defect: a production env holding only a Gemini
    // key silently resolved to Google. The key is a credential, never a choice.
    expect(() =>
      resolveProvider({ NODE_ENV: "production", GEMINI_API_KEY: "y" }),
    ).toThrowError(/LLM_PROVIDER/);
    expect(() =>
      resolveProvider({ NODE_ENV: "production", OPENAI_API_KEY: "x" }),
    ).toThrowError(/LLM_PROVIDER/);
  });
});

describe("resolveModelId", () => {
  it("falls back to the active provider's per-role default", () => {
    expect(resolveModelId("vision", { provider: "openai", env: {} })).toBe("gpt-6-luna");
    expect(resolveModelId("judge", { provider: "openai", env: {} })).toBe("gpt-5.6-terra");
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
    expect(resolveModelId("listing", { provider: "openai", env })).toBe("gpt-6-luna");
  });

  it("maps each role to its own env override var", () => {
    expect(
      resolveModelId("pricingAgent", { provider: "openai", env: { PRICING_MODEL: "p" } }),
    ).toBe("p");
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

describe("seller context transcription activation", () => {
  it("is default-off and accepts only an explicit boolean operator choice", () => {
    expect(isSellerContextTranscriptionEnabled({})).toBe(false);
    expect(isSellerContextTranscriptionEnabled({
      SELLER_CONTEXT_TRANSCRIPTION_ENABLED: "false",
    })).toBe(false);
    expect(isSellerContextTranscriptionEnabled({
      SELLER_CONTEXT_TRANSCRIPTION_ENABLED: "true",
    })).toBe(true);
    expect(sellerContextTranscriptionConfigError({
      SELLER_CONTEXT_TRANSCRIPTION_ENABLED: "1",
    })).toMatch(/neither "true" nor "false"/i);
  });

  it("rejects explicit activation for an unsupported selected provider without exposing keys", () => {
    const error = sellerContextTranscriptionConfigError({
      LLM_PROVIDER: "google",
      GOOGLE_GENERATIVE_AI_API_KEY: "google-key-must-not-escape",
      SELLER_CONTEXT_TRANSCRIPTION_ENABLED: "true",
    });

    expect(error).toMatch(/SELLER_CONTEXT_TRANSCRIPTION_ENABLED.*LLM_PROVIDER.*google/i);
    expect(error).not.toContain("google-key-must-not-escape");
  });

  it("lets explicit OpenAI transcription override ambient Google selection", async () => {
    await expect(
      resolveTranscriptionModel("sellerContext", {
        provider: "openai",
        apiKey: "test-key",
        env: {
          LLM_PROVIDER: "google",
          SELLER_CONTEXT_TRANSCRIPTION_ENABLED: "true",
        },
      }),
    ).resolves.toMatchObject({
      provider: "openai",
      modelId: "gpt-transcribe",
    });
  });

  it("fails closed when explicit Google transcription overrides ambient OpenAI", async () => {
    await expect(
      resolveTranscriptionModel("sellerContext", {
        provider: "google",
        apiKey: "secret-must-not-escape",
        env: {
          LLM_PROVIDER: "openai",
          SELLER_CONTEXT_TRANSCRIPTION_ENABLED: "true",
        },
      }),
    ).rejects.toMatchObject({
      name: "SellerContextTranscriptionConfigurationError",
      message: expect.stringMatching(
        /SELLER_CONTEXT_TRANSCRIPTION_ENABLED.*provider.*google/i,
      ),
    });
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


describe("OpenAI role requests", () => {
  it("honors per-stage effort rollback and rejects misspelled effort before a call", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      body = JSON.parse(init.body);
      return Response.json({ id: "fixture", created: 0, model: "fixture",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      });
    }));
    const { generateText } = await import("ai");
    for (const [override, expected] of [["medium", "medium"], ["default", undefined]] as const) {
      await generateText({ model: await resolveLanguageModel("vision", {
        provider: "openai", apiKey: "fixture", env: { VISION_MODEL: "gpt-5.6-terra", VISION_REASONING_EFFORT: override },
      }), prompt: "fixture", maxRetries: 0 });
      expect(body).toMatchObject({ model: "gpt-5.6-terra" });
      expect(body.reasoning_effort).toBe(expected);
    }
    await expect(resolveLanguageModel("vision", { provider: "openai", env: { VISION_REASONING_EFFORT: "typo" } })).rejects.toThrow(/VISION_REASONING_EFFORT/);
    await expect(resolveLanguageModel("vision", { provider: "google", env: { VISION_REASONING_EFFORT: "typo" } })).resolves.toBeTruthy();
  });

  it("uploads completed audio with the new model and accepts its JSON response", async () => {
    let endpoint: unknown;
    let form: FormData | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      endpoint = url;
      form = init.body;
      return Response.json({ text: "Sony headphones in good condition", languages: [{ code: "en" }] });
    }));
    const resolved = await resolveTranscriptionModel("sellerContext", { provider: "openai", apiKey: "fixture", env: { SELLER_CONTEXT_TRANSCRIPTION_ENABLED: "true" } });
    if (!resolved) throw new Error("Transcription was not enabled");
    const { experimental_transcribe: transcribe } = await import("ai");
    const result = await transcribe({ model: resolved.model, audio: new Uint8Array([1, 2]), maxRetries: 0 });
    expect(result.text).toBe("Sony headphones in good condition");
    expect(endpoint).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(form?.get("model")).toBe("gpt-transcribe");
    expect(form?.get("file")).toBeInstanceOf(File);
    // No legacy language/timestamp/verbose-json options; API defaults to JSON.
    expect(form?.get("response_format")).toBeNull();
    expect(form?.get("language")).toBeNull();
  });

  it("sends the approved model and effort per role through the SDK", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return Response.json({
        id: "fixture", created: 0, model: "fixture",
        choices: [{ index: 0, message: { role: "assistant", content: '{"ok":true}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }));
    const { generateObject } = await import("ai");
    const { z } = await import("zod");
    for (const role of LLM_ROLES) {
      await generateObject({
        model: await resolveLanguageModel(role, { provider: "openai", apiKey: "fixture", env: {} }),
        schema: z.object({ ok: z.boolean() }), prompt: "fixture", maxRetries: 0,
      });
    }
    expect(bodies.map(body => [body.model, body.reasoning_effort])).toEqual([
      ["gpt-6-luna", "low"], ["gpt-6-luna", "none"],
      ["gpt-6-luna", "none"], ["gpt-6-luna", "low"],
      ["gpt-5.6-terra", undefined],
    ]);
  });
});
