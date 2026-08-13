import { z } from "zod";
import type { ProviderUsageRecord } from "./record";
import { providerUsageRecordSchema } from "./schema";

/**
 * Provider spend measured OUTSIDE a leased worker run (issue #724).
 *
 * Both guided-correction paths — the web identity correction and the native
 * Sharpen correction — run the pricing router and the listing generator after
 * their originating run has already completed. They hold no worker lease and the
 * run is no longer `running`, so `record_pipeline_run_provider_usage` rejects
 * them by construction. What they DO hold is the guided-correction capability
 * that just committed their correction, and that capability already binds a
 * tenant, an item, a listing, and the originating run.
 *
 * So the correction's spend is carried by the token that authorized the
 * correction itself. Nothing here names a run or a tenant: ownership is read off
 * the stored capability inside the database, exactly as the worker path reads it
 * off the leased run.
 */
export interface PostCompletionProviderUsage {
  /** The capability token whose correction has already committed. */
  capabilityToken: string;
  /** What the correction consumed, content-free. */
  usage: ProviderUsageRecord;
}

/** Fixed privileged capability: no generic table or arbitrary RPC surface. */
export interface PostCompletionProviderUsageRpcClient {
  rpc(
    functionName: "record_guided_correction_provider_usage",
    args: { p_completion_token: string; p_usage: unknown },
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

const postCompletionUsageSchema = z
  .object({
    // The same 43-character base64url shape the completion capability uses.
    capabilityToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    usage: providerUsageRecordSchema,
  })
  .strict();

/**
 * Persist a completed correction's provider spend against its originating run.
 *
 * The only identity presented is the capability token. The database resolves the
 * tenant, the item, and the run from the stored capability, so this caller
 * cannot name a run it does not already hold a consumed capability for — the
 * same property that makes the worker's lease-scoped writer safe.
 *
 * Returns whether a run record was actually topped up. `false` is a real answer,
 * not an error: a run the worker never recorded usage for has nothing to add to.
 */
export async function recordGuidedCorrectionProviderUsage(
  client: PostCompletionProviderUsageRpcClient,
  rawInput: PostCompletionProviderUsage,
): Promise<boolean> {
  const input = postCompletionUsageSchema.parse(rawInput);
  const result = await client.rpc("record_guided_correction_provider_usage", {
    p_completion_token: input.capabilityToken,
    p_usage: input.usage,
  });
  if (result.error) {
    throw new Error(
      `Guided correction provider usage recording failed: ${result.error.message}`,
    );
  }
  return z.boolean().parse(result.data);
}

/**
 * Report a completed correction's spend without ever letting the report fail the
 * correction.
 *
 * A guided correction is durable before this runs: the item revision, the eBay
 * draft, the prediction, and the included-credit completion are all committed.
 * Everything after that point is telemetry, and telemetry that can throw away a
 * seller's confirmed work is worse than telemetry that is occasionally missing.
 *
 * The recorder is invoked INSIDE the try so a synchronous throw is swallowed
 * too, not only a rejected promise.
 */
export async function reportPostCompletionProviderUsage(
  report: PostCompletionProviderUsage,
  record:
    | ((report: PostCompletionProviderUsage) => Promise<void> | void)
    | undefined,
): Promise<void> {
  if (!record) return;
  try {
    await record(report);
  } catch {
    // Deliberately silent at this seam: the caller owns error reporting, and a
    // missing usage row is a known, documented gap in the percentile artifact.
  }
}
