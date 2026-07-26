import { afterEach, describe, expect, it, vi } from "vitest";
import { register } from "./instrumentation";

/**
 * Server boot (issue #62 for Sentry; #501 for the provider fence). `register()`
 * runs once per server instance, which is the earliest point a deploy can be
 * told its configuration is unusable.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("register", () => {
  // Keep Sentry inert: `register()` initializes it, and a developer with a real
  // SENTRY_DSN exported would otherwise start a live client from a unit test.
  const localEnv = (nodeEnv: string) => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("SENTRY_DSN", "");
    vi.stubEnv("NODE_ENV", nodeEnv);
  };

  it("rejects startup when LLM_PROVIDER is unset outside local development (#501)", async () => {
    localEnv("production");
    vi.stubEnv("LLM_PROVIDER", "");
    await expect(register()).rejects.toThrow(/LLM_PROVIDER/);
  });

  it("starts normally on a local development machine, where the provider may be omitted", async () => {
    localEnv("development");
    vi.stubEnv("LLM_PROVIDER", "");
    await expect(register()).resolves.toBeUndefined();
  });

  it("starts normally on a deploy that chose a provider (#501)", async () => {
    localEnv("production");
    vi.stubEnv("LLM_PROVIDER", "openai");
    await expect(register()).resolves.toBeUndefined();
  });
});
