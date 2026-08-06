import { describe, expect, it } from "vitest";
import {
  recordModelUsage,
  withProviderUsageRun,
} from "./collector";

/**
 * The run-scoped provider-usage collector (issue #716).
 *
 * Tested at its public seam — open a run, let arbitrary code report what a
 * provider charged for, read the aggregate back — because that is exactly how
 * the pipeline uses it: the reporters (the LLM registry, the sold-comp tier) are
 * far from the reader (the worker's persistence step) and never hold a
 * reference to each other.
 */

describe("withProviderUsageRun", () => {
  it("aggregates model token counts per role and resolved model id", async () => {
    const { value, usage } = await withProviderUsageRun(async () => {
      recordModelUsage({
        role: "vision",
        provider: "openai",
        model: "resolved-vision-model",
        inputTokens: 1_200,
        outputTokens: 300,
      });
      recordModelUsage({
        role: "vision",
        provider: "openai",
        model: "resolved-vision-model",
        inputTokens: 800,
        outputTokens: 100,
        cachedInputTokens: 640,
        reasoningTokens: 64,
      });
      recordModelUsage({
        role: "listing",
        provider: "openai",
        model: "resolved-listing-model",
        inputTokens: 2_000,
        outputTokens: 900,
      });
      return "pipeline result";
    });

    expect(value).toBe("pipeline result");
    expect(usage.models).toEqual([
      {
        role: "listing",
        provider: "openai",
        model: "resolved-listing-model",
        calls: 1,
        inputTokens: 2_000,
        cachedInputTokens: 0,
        outputTokens: 900,
        reasoningTokens: 0,
      },
      {
        role: "vision",
        provider: "openai",
        model: "resolved-vision-model",
        calls: 2,
        inputTokens: 2_000,
        cachedInputTokens: 640,
        outputTokens: 400,
        reasoningTokens: 64,
      },
    ]);
    expect(usage.modelCalls).toBe(3);
    expect(usage.inputTokens).toBe(4_000);
    expect(usage.outputTokens).toBe(1_300);
  });

  it("is a no-op outside a run so a model call off the pipeline records nothing", () => {
    expect(() =>
      recordModelUsage({
        role: "judge",
        provider: "google",
        model: "resolved-judge-model",
        inputTokens: 10,
        outputTokens: 10,
      }),
    ).not.toThrow();
  });
});
