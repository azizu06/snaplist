import { afterEach, describe, expect, it, vi } from "vitest";
import { withProviderUsageRun } from "../provider-usage";
import { resolveLanguageModel } from "./registry";

/**
 * Every model call routed through the role-keyed registry records its token
 * counts (issue #716, acceptance criterion 1).
 *
 * Tested through `resolveLanguageModel` — the registry's only public entry
 * point and the seam AGENTS.md requires every model call to pass through — with
 * the provider's HTTP response stubbed. That proves the whole chain a real run
 * uses: role → resolved model id → provider request → the provider's own
 * reported usage → the run's record. A test against a hand-built fake model
 * would prove the wrapper adds up numbers, not that a resolved model reports.
 */

/**
 * The generate surface of a resolved model. Declared structurally rather than
 * imported: `@ai-sdk/provider` is a transitive dependency, and a test should not
 * pin a package the app does not depend on directly.
 */
type GenerateCapableModel = {
  doGenerate(options: {
    prompt: {
      role: "user";
      content: { type: "text"; text: string }[];
    }[];
  }): Promise<{ content: { type: string; text?: string }[] }>;
};

const ENV = {
  NODE_ENV: "test",
  LLM_PROVIDER: "openai",
  OPENAI_API_KEY: "test-key",
} as const;

const PROMPT = [
  {
    role: "user" as const,
    content: [{ type: "text" as const, text: "Seller's private item details" }],
  },
];

/** One OpenAI chat completion, carrying the usage block the provider returns. */
function chatCompletion(model: string) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1_700_000_000,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "{}" },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 1_200,
      completion_tokens: 300,
      total_tokens: 1_500,
      prompt_tokens_details: { cached_tokens: 640 },
      completion_tokens_details: { reasoning_tokens: 64 },
    },
  };
}

function stubProviderHttp(model: string): void {
  // A fresh Response per call: a `Response` body may only be read once, so a
  // single shared instance would fail the second call in a multi-role run.
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response(JSON.stringify(chatCompletion(model)), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registry usage recording", () => {
  it("records one routed call under its role and the model id the registry resolved", async () => {
    stubProviderHttp("configured-listing-model");

    const { usage } = await withProviderUsageRun(async () => {
      const model = (await resolveLanguageModel("listing", {
        env: { ...ENV, LISTING_MODEL: "configured-listing-model" },
      })) as unknown as GenerateCapableModel;
      await model.doGenerate({ prompt: PROMPT });
    });

    expect(usage.models).toEqual([
      {
        role: "listing",
        provider: "openai",
        model: "configured-listing-model",
        calls: 1,
        inputTokens: 1_200,
        cachedInputTokens: 640,
        outputTokens: 300,
        reasoningTokens: 64,
      },
    ]);
    expect(usage.modelCalls).toBe(1);
  });

  it("keeps roles separate so the expensive leg of a run is identifiable", async () => {
    stubProviderHttp("shared-model");

    const { usage } = await withProviderUsageRun(async () => {
      for (const role of ["vision", "pricingAgent", "listing"] as const) {
        const model = (await resolveLanguageModel(role, {
          env: ENV,
          modelId: "shared-model",
        })) as unknown as GenerateCapableModel;
        await model.doGenerate({ prompt: PROMPT });
      }
    });

    expect(usage.models.map((entry) => entry.role)).toEqual([
      "listing",
      "pricingAgent",
      "vision",
    ]);
    expect(usage.models.every((entry) => entry.calls === 1)).toBe(true);
    expect(usage.inputTokens).toBe(3_600);
  });

  it("still returns the model's own result to its call site", async () => {
    stubProviderHttp("shared-model");

    const { value } = await withProviderUsageRun(async () => {
      const model = (await resolveLanguageModel("listing", {
        env: ENV,
        modelId: "shared-model",
      })) as unknown as GenerateCapableModel;
      return model.doGenerate({ prompt: PROMPT });
    });

    expect(value.content).toEqual([{ type: "text", text: "{}" }]);
  });
});
