import type { LanguageModelMiddleware } from "ai";
import { recordModelUsage } from "../provider-usage";
import type { LlmProvider, LlmRole } from "./registry";

/**
 * The registry's token-count middleware (issue #716).
 *
 * The Vercel AI SDK already returns a `usage` block on every `generateObject`
 * call and we discarded it, so the cost of an AI item run was modeled rather
 * than measured. Recording it HERE — inside `resolveLanguageModel`, wrapped
 * around the model itself — means every call site is covered by construction:
 * AGENTS.md already requires all model calls to resolve through the registry,
 * and `seller-media-fence.test.ts` enforces that repo-wide. A new call site
 * cannot be added that both obeys that rule and escapes this one.
 *
 * Only `wrapGenerate` is implemented: nothing in this repository streams (no
 * `streamText`/`streamObject` call site exists), and a stream wrapper written
 * against no caller would be untested plumbing sitting on the pipeline's hot
 * path. A future streaming call site adds `wrapStream` alongside its own test.
 */

/** Which registry decision produced the model being wrapped. */
export interface UsageRecordingCall {
  role: LlmRole;
  provider: LlmProvider;
  /** The model id the registry resolved — read back out, never assumed. */
  model: string;
}

/**
 * Wrap a model so each completed generate reports its token counts to the
 * active provider-usage run.
 *
 * Recording NEVER fails the call. Cost telemetry is observability, not a
 * pipeline dependency (issue #716 acceptance criterion 5), so a throw from the
 * recorder is swallowed here rather than surfacing as a model error that would
 * strand a seller's item. The model's own result is returned untouched either
 * way — the middleware observes, it does not transform.
 */
export function usageRecordingMiddleware(
  call: UsageRecordingCall,
): LanguageModelMiddleware {
  return {
    specificationVersion: "v3",
    async wrapGenerate({ doGenerate }) {
      const result = await doGenerate();
      try {
        recordModelUsage({
          role: call.role,
          provider: call.provider,
          model: call.model,
          inputTokens: result.usage?.inputTokens?.total,
          cachedInputTokens: result.usage?.inputTokens?.cacheRead,
          outputTokens: result.usage?.outputTokens?.total,
          reasoningTokens: result.usage?.outputTokens?.reasoning,
        });
      } catch {
        // Deliberately silent: the recorder is a counter, and there is no
        // failure of it worth turning into a failed listing.
      }
      return result;
    },
  };
}
