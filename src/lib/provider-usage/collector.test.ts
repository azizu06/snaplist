import { describe, expect, it } from "vitest";
import {
  captureProviderUsageRun,
  currentTranscriptionUsage,
  providerUsageRunActive,
  recordModelUsage,
  recordSoldCompOutcome,
  recordSoldCompUsage,
  recordTranscriptionUsage,
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

describe("captureProviderUsageRun", () => {
  it("captures the tally accumulated before `work` throws instead of losing it", async () => {
    const captured = await captureProviderUsageRun(async () => {
      recordModelUsage({
        role: "vision",
        provider: "openai",
        model: "resolved-vision-model",
        inputTokens: 100,
        outputTokens: 50,
      });
      throw new Error("provider call failed mid-run");
    });

    expect(captured.ok).toBe(false);
    if (captured.ok) throw new Error("unreachable");
    expect(captured.error).toBeInstanceOf(Error);
    expect((captured.error as Error).message).toBe("provider call failed mid-run");
    expect(captured.usage.modelCalls).toBe(1);
    expect(captured.usage.inputTokens).toBe(100);
  });

  it("re-throws through withProviderUsageRun so existing callers still see the failure", async () => {
    await expect(
      withProviderUsageRun(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

describe("providerUsageRunActive", () => {
  it("is false outside a run and true only while one is open", async () => {
    expect(providerUsageRunActive()).toBe(false);

    await withProviderUsageRun(async () => {
      expect(providerUsageRunActive()).toBe(true);
      return null;
    });

    expect(providerUsageRunActive()).toBe(false);
  });
});

describe("currentTranscriptionUsage", () => {
  it("reads [] outside a run and the accumulated transcriptions inside one", async () => {
    expect(currentTranscriptionUsage()).toEqual([]);

    await withProviderUsageRun(async () => {
      recordTranscriptionUsage({
        role: "sellerContext",
        provider: "openai",
        model: "resolved-transcription-model",
      });
      expect(currentTranscriptionUsage()).toEqual([
        {
          role: "sellerContext",
          provider: "openai",
          model: "resolved-transcription-model",
          calls: 1,
          chargedUsd: null,
        },
      ]);
      return null;
    });
  });
});

describe("nested provider-usage runs", () => {
  it("gives a nested run its own tally instead of merging into the enclosing one", async () => {
    const outer = await withProviderUsageRun(async () => {
      recordModelUsage({
        role: "listing",
        provider: "openai",
        model: "resolved-listing-model",
        inputTokens: 10,
        outputTokens: 10,
      });

      const inner = await withProviderUsageRun(async () => {
        recordModelUsage({
          role: "judge",
          provider: "google",
          model: "resolved-judge-model",
          inputTokens: 999,
          outputTokens: 999,
        });
        return "inner result";
      });

      expect(inner.usage.modelCalls).toBe(1);
      expect(inner.usage.inputTokens).toBe(999);

      // Back in the outer scope, reporting after the nested run resumes the
      // outer tally rather than continuing to write into the discarded inner one.
      recordModelUsage({
        role: "listing",
        provider: "openai",
        model: "resolved-listing-model",
        inputTokens: 20,
        outputTokens: 20,
      });

      return "outer result";
    });

    // The nested run's usage never leaked into the outer tally.
    expect(outer.usage.modelCalls).toBe(2);
    expect(outer.usage.inputTokens).toBe(30);
    expect(outer.usage.models.every((m) => m.role !== "judge")).toBe(true);
  });
});

/**
 * Issue #1138: a sold-comp row that only counts candidates cannot tell a broken
 * provider from an honest miss.
 *
 * Production recorded `apify: attempts 2, results 0` for an item eBay trades every
 * day. That row is consistent with three completely different worlds — the Actor
 * was broken, the Actor returned candidates the matcher rejected, or the item
 * genuinely has no comps — and choosing between them needed the provider's own
 * console. So the row now carries what was FETCHED, what the provider-neutral
 * matcher ACCEPTED, and a short bounded reason when nothing survived.
 */
describe("sold-comp usage reasons (#1138)", () => {
  it("separates candidates fetched from anchors accepted, and names why zero survived", async () => {
    const { usage } = await withProviderUsageRun(async () => {
      recordSoldCompUsage({ strategy: "apify", results: 10, chargedUsd: 0.04 });
      recordSoldCompOutcome({
        strategy: "apify",
        accepted: 0,
        reason: "all-rejected:identity-mismatch",
      });
    });

    expect(usage.soldComps).toEqual([
      {
        strategy: "apify",
        attempts: 1,
        results: 10,
        accepted: 0,
        reason: "all-rejected:identity-mismatch",
        chargedUsd: 0.04,
      },
    ]);
  });

  it("records a provider error distinctly from an honest empty result", async () => {
    const { usage } = await withProviderUsageRun(async () => {
      recordSoldCompUsage({
        strategy: "apify",
        results: 0,
        chargedUsd: 0.0001,
        reason: "provider-error",
      });
      recordSoldCompUsage({ strategy: "ebay-sold", results: 0, reason: "blocked" });
    });

    expect(usage.soldComps).toEqual([
      {
        strategy: "apify",
        attempts: 1,
        results: 0,
        accepted: 0,
        reason: "provider-error",
        chargedUsd: 0.0001,
      },
      {
        strategy: "ebay-sold",
        attempts: 1,
        results: 0,
        accepted: 0,
        reason: "blocked",
        chargedUsd: null,
      },
    ]);
  });

  it("clears the reason once the strategy accepts an anchor, so a reason always means zero", async () => {
    const { usage } = await withProviderUsageRun(async () => {
      recordSoldCompUsage({ strategy: "apify", results: 0, reason: "no-candidates" });
      recordSoldCompUsage({ strategy: "apify", results: 8 });
      recordSoldCompOutcome({ strategy: "apify", accepted: 4 });
    });

    expect(usage.soldComps).toEqual([
      {
        strategy: "apify",
        attempts: 2,
        results: 8,
        accepted: 4,
        reason: null,
        chargedUsd: null,
      },
    ]);
  });
});
