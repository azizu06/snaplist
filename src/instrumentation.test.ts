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
  it("refuses to boot when LLM_PROVIDER is unset outside local development (#501)", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LLM_PROVIDER", "");
    await expect(register()).rejects.toThrow(/LLM_PROVIDER/);
  });

  it("boots normally on a local development machine, where the provider may be omitted", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("LLM_PROVIDER", "");
    await expect(register()).resolves.toBeUndefined();
  });
});
