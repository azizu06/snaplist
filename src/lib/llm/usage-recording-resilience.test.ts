import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A broken recorder cannot break a listing (issue #716, acceptance criterion 5).
 *
 * Cost telemetry is observability. If recording ever throws — a bad column, a
 * serialization failure, a future write-through implementation — the seller's
 * model call must still return its result. That guarantee lives in the
 * middleware's own catch, so this file substitutes a recorder that always
 * throws, which is the only way the failure is reachable from outside.
 */
vi.mock("../provider-usage", () => ({
  recordModelUsage: () => {
    throw new Error("cost recorder exploded");
  },
}));

const { resolveLanguageModel } = await import("./registry");

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registry usage recording resilience", () => {
  it("returns the model's result when the recorder throws", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            created: 1_700_000_000,
            model: "listing-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "{\"ok\":true}" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 4 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const model = (await resolveLanguageModel("listing", {
      env: {
        NODE_ENV: "test",
        LLM_PROVIDER: "openai",
        OPENAI_API_KEY: "test-key",
        LISTING_MODEL: "listing-model",
      },
    })) as unknown as GenerateCapableModel;

    const result = await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });

    expect(result.content).toEqual([{ type: "text", text: "{\"ok\":true}" }]);
  });
});
