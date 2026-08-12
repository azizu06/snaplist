import { z } from "zod";
import { LLM_PROVIDERS, LLM_ROLES } from "../llm";

/**
 * The persisted contract for a run's provider-usage record (issue #716).
 *
 * Deliberately its own module, and deliberately NOT re-exported from the
 * package barrel: the registry's usage middleware imports the reporters, so a
 * value import of the role/provider lists from anywhere the barrel reaches
 * closes an import cycle (registry -> middleware -> barrel -> here ->
 * registry). Only the persistence seam needs the schema, and it imports this
 * file directly.
 */

const countSchema = z.number().int().min(0);

/**
 * Strict on purpose: an unknown key is how content would arrive, so a payload
 * carrying anything the record does not name is rejected rather than stored.
 */
export const providerUsageRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    modelCalls: countSchema,
    inputTokens: countSchema,
    cachedInputTokens: countSchema,
    outputTokens: countSchema,
    reasoningTokens: countSchema,
    models: z.array(
      z
        .object({
          role: z.enum(LLM_ROLES),
          provider: z.enum(LLM_PROVIDERS),
          model: z.string().min(1).max(200),
          calls: countSchema,
          inputTokens: countSchema,
          cachedInputTokens: countSchema,
          outputTokens: countSchema,
          reasoningTokens: countSchema,
        })
        .strict(),
    ),
    transcriptions: z
      .array(
        z
          .object({
            role: z.literal("sellerContext"),
            provider: z.enum(LLM_PROVIDERS),
            model: z.string().min(1).max(200),
            calls: countSchema,
            chargedUsd: z.null(),
          })
          .strict(),
      )
      .default([]),
    soldComps: z.array(
      z
        .object({
          strategy: z.string().min(1).max(64),
          attempts: countSchema,
          results: countSchema,
          chargedUsd: z.number().finite().min(0).nullable(),
        })
        .strict(),
    ),
  })
  .strict();
