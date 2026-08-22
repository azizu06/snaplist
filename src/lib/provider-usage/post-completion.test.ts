import { describe, expect, it, vi } from "vitest";
import {
  recordGuidedCorrectionProviderUsage,
  reportPostCompletionProviderUsage,
  type PostCompletionProviderUsage,
} from "./post-completion";
import type { ProviderUsageRecord } from "./record";

const usage: ProviderUsageRecord = {
  schemaVersion: 1,
  modelCalls: 2,
  inputTokens: 300,
  cachedInputTokens: 0,
  outputTokens: 60,
  reasoningTokens: 0,
  models: [
    {
      role: "listing",
      provider: "openai",
      model: "resolved-listing",
      calls: 1,
      inputTokens: 200,
      cachedInputTokens: 0,
      outputTokens: 40,
      reasoningTokens: 0,
    },
    {
      role: "pricingAgent",
      provider: "openai",
      model: "resolved-pricing",
      calls: 1,
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 20,
      reasoningTokens: 0,
    },
  ],
  transcriptions: [],
  soldComps: [{ strategy: "apify", attempts: 1, results: 9, chargedUsd: 0.0247 }],
};

const TOKEN = "a".repeat(43);

function client(result: { data: unknown; error: { message: string } | null }) {
  return { rpc: vi.fn(async () => result) };
}

describe("recordGuidedCorrectionProviderUsage", () => {
  it("presents only the capability token and the content-free record", async () => {
    const rpc = client({ data: true, error: null });

    await recordGuidedCorrectionProviderUsage(rpc, {
      capabilityToken: TOKEN,
      usage,
    });

    // No run id, no user id, no item id: ownership is read off the stored
    // capability inside the database, never asserted by this caller.
    expect(rpc.rpc).toHaveBeenCalledWith("record_guided_correction_provider_usage", {
      p_completion_token: TOKEN,
      p_usage: usage,
    });
  });

  it("refuses a payload the persisted contract does not name", async () => {
    const rpc = client({ data: true, error: null });

    await expect(
      recordGuidedCorrectionProviderUsage(rpc, {
        capabilityToken: TOKEN,
        usage: {
          ...usage,
          prompt: "Grandmother 1968 Seiko",
        } as unknown as ProviderUsageRecord,
      }),
    ).rejects.toThrow();
    expect(rpc.rpc).not.toHaveBeenCalled();
  });

  it("refuses a malformed capability token before reaching the database", async () => {
    const rpc = client({ data: true, error: null });

    await expect(
      recordGuidedCorrectionProviderUsage(rpc, {
        capabilityToken: "too-short",
        usage,
      }),
    ).rejects.toThrow();
    expect(rpc.rpc).not.toHaveBeenCalled();
  });

  it("surfaces a database refusal instead of reporting a silent success", async () => {
    const rpc = client({
      data: null,
      error: { message: "Guided correction capability is unavailable" },
    });

    await expect(
      recordGuidedCorrectionProviderUsage(rpc, { capabilityToken: TOKEN, usage }),
    ).rejects.toThrow(/capability is unavailable/);
  });

  it("reports whether the record actually landed on a run", async () => {
    // `false` is the honest answer when the originating run has no record to
    // top up — the correction still happened, the artifact just cannot see it.
    const rpc = client({ data: false, error: null });

    await expect(
      recordGuidedCorrectionProviderUsage(rpc, { capabilityToken: TOKEN, usage }),
    ).resolves.toBe(false);
  });
});

describe("reportPostCompletionProviderUsage", () => {
  const report: PostCompletionProviderUsage = { capabilityToken: TOKEN, usage };

  it("does nothing when no recorder is wired", async () => {
    await expect(
      reportPostCompletionProviderUsage(report, undefined),
    ).resolves.toBeUndefined();
  });

  it("swallows a rejected recorder", async () => {
    await expect(
      reportPostCompletionProviderUsage(report, async () => {
        throw new Error("writer unavailable");
      }),
    ).resolves.toBeUndefined();
  });

  it("swallows a recorder that throws synchronously", async () => {
    await expect(
      reportPostCompletionProviderUsage(report, () => {
        throw new Error("writer unavailable");
      }),
    ).resolves.toBeUndefined();
  });

  it("reports a rejected recorder's failure to onError before swallowing it", async () => {
    const onError = vi.fn();
    const failure = new Error("writer unavailable");

    await reportPostCompletionProviderUsage(
      report,
      async () => {
        throw failure;
      },
      onError,
    );

    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("reports a synchronously-thrown recorder failure to onError too", async () => {
    const onError = vi.fn();
    const failure = new Error("writer unavailable");

    await reportPostCompletionProviderUsage(
      report,
      () => {
        throw failure;
      },
      onError,
    );

    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("never lets a broken onError escape the swallow", async () => {
    await expect(
      reportPostCompletionProviderUsage(
        report,
        async () => {
          throw new Error("writer unavailable");
        },
        () => {
          throw new Error("logger is also broken");
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("does not call onError when the recorder succeeds", async () => {
    const onError = vi.fn();

    await reportPostCompletionProviderUsage(report, async () => undefined, onError);

    expect(onError).not.toHaveBeenCalled();
  });
});
