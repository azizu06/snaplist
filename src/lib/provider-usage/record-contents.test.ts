import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLanguageModel } from "../llm/registry";
import {
  recordModelUsage,
  recordSoldCompUsage,
  withProviderUsageRun,
  type ProviderUsageRecord,
} from ".";

/**
 * Nothing but counts reaches the cost record (issue #716, acceptance
 * criterion 6).
 *
 * The record is written to a tenant table and read back by whoever sets the Pro
 * allowance, so it is a place a secret or a seller's private item details must
 * never end up. Two things have to hold, and they fail differently:
 *
 *  1. The record's SHAPE forbids content. Proven against the tally, which every
 *     reporter funnels through — so it holds for all call sites at once,
 *     including ones added later, rather than one test per call site.
 *  2. A REAL provider round trip through the registry adds nothing. The token
 *     counts come from the provider's own response, and that response is the
 *     one place a prompt echo or a credential could realistically arrive from.
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

/** Field names the record may carry, and what type each is allowed to be. */
const RECORD_SHAPE = {
  schemaVersion: "number",
  modelCalls: "number",
  inputTokens: "number",
  cachedInputTokens: "number",
  outputTokens: "number",
  reasoningTokens: "number",
} as const;

const MODEL_SHAPE = {
  role: "string",
  provider: "string",
  model: "string",
  calls: "number",
  inputTokens: "number",
  cachedInputTokens: "number",
  outputTokens: "number",
  reasoningTokens: "number",
} as const;

const SOLD_COMP_SHAPE = {
  strategy: "string",
  attempts: "number",
  results: "number",
} as const;

/**
 * Asserts the record carries exactly the allowlisted fields, with no extra key
 * and no free-form string beyond the three routing labels (role, provider,
 * model) and the strategy name. An allowlist rather than a denylist: a leak we
 * did not think to search for still has to fail this.
 */
function expectOnlyAllowlistedFields(record: ProviderUsageRecord): void {
  expect(Object.keys(record).sort()).toEqual(
    [...Object.keys(RECORD_SHAPE), "models", "soldComps"].sort(),
  );
  for (const [key, type] of Object.entries(RECORD_SHAPE)) {
    expect(typeof record[key as keyof typeof RECORD_SHAPE]).toBe(type);
  }
  for (const entry of record.models) {
    expect(Object.keys(entry).sort()).toEqual(Object.keys(MODEL_SHAPE).sort());
    for (const [key, type] of Object.entries(MODEL_SHAPE)) {
      expect(typeof entry[key as keyof typeof MODEL_SHAPE]).toBe(type);
    }
  }
  for (const entry of record.soldComps) {
    expect(Object.keys(entry).sort()).toEqual(
      [...Object.keys(SOLD_COMP_SHAPE), "chargedUsd"].sort(),
    );
    for (const [key, type] of Object.entries(SOLD_COMP_SHAPE)) {
      expect(typeof entry[key as keyof typeof SOLD_COMP_SHAPE]).toBe(type);
    }
    expect(
      entry.chargedUsd === null || typeof entry.chargedUsd === "number",
    ).toBe(true);
  }
}

/** Strings that must never survive into a record, whatever the caller does. */
const FORBIDDEN = [
  "sk-live-not-a-real-key",
  "apify_api_not_a_real_token",
  "Grandmother's 1968 Seiko, serial 8842197",
  "123 Palm Row, Orlando",
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("provider usage record contents", () => {
  it("keeps content out even when a reporter is handed it", async () => {
    const { usage } = await withProviderUsageRun(() => {
      // A caller that passes more than the contract asks for — the shape the
      // record is written in has to be what protects us, not caller discipline.
      recordModelUsage({
        role: "vision",
        provider: "openai",
        model: "some-model",
        inputTokens: 900,
        outputTokens: 120,
        apiKey: FORBIDDEN[0],
        prompt: FORBIDDEN[2],
        sellerAddress: FORBIDDEN[3],
      } as Parameters<typeof recordModelUsage>[0]);
      recordSoldCompUsage({
        strategy: "apify",
        results: 8,
        chargedUsd: 0.019,
        token: FORBIDDEN[1],
        query: FORBIDDEN[2],
      } as Parameters<typeof recordSoldCompUsage>[0]);
    });

    expectOnlyAllowlistedFields(usage);
    const serialized = JSON.stringify(usage);
    for (const secret of FORBIDDEN) {
      expect(serialized).not.toContain(secret);
    }
    // The counts themselves still made it: this is a filter, not a black hole.
    expect(usage.inputTokens).toBe(900);
    expect(usage.soldComps[0]?.results).toBe(8);
  });

  it("adds nothing but counts from a real provider round trip", async () => {
    const sellerPrompt = FORBIDDEN[2];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            created: 1_700_000_000,
            model: "vision-model",
            choices: [
              {
                index: 0,
                // A provider that echoes the seller's words back in its own
                // response — the realistic shape of an accidental leak.
                message: { role: "assistant", content: sellerPrompt },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 400, completion_tokens: 90 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const { usage } = await withProviderUsageRun(async () => {
      const model = (await resolveLanguageModel("vision", {
        env: {
          NODE_ENV: "test",
          LLM_PROVIDER: "openai",
          OPENAI_API_KEY: FORBIDDEN[0],
          VISION_MODEL: "vision-model",
        },
      })) as unknown as GenerateCapableModel;
      await model.doGenerate({
        prompt: [
          {
            role: "user",
            content: [{ type: "text", text: sellerPrompt }],
          },
        ],
      });
    });

    expectOnlyAllowlistedFields(usage);
    const serialized = JSON.stringify(usage);
    for (const secret of FORBIDDEN) {
      expect(serialized).not.toContain(secret);
    }
    expect(usage.models[0]?.inputTokens).toBe(400);
  });
});
