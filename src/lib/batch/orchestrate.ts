/**
 * Bulk / haul capture — batch orchestration (issue #100).
 *
 * Pure, transport-free orchestration over the EXISTING single-item pipeline
 * seam: the caller supplies a `runner` (in the app: one POST to the batch item
 * route, which is the same auth → rate-limit → quota → upload →
 * `runPipelineAndPersist` spine as the single-item upload action) and this
 * module only decides *scheduling*: bounded concurrency, per-entry state, and
 * the quota short-circuit.
 *
 * Deliberate decisions (the unit-tested external behavior):
 *  - Small bounded concurrency (default 2) so the existing per-minute rate
 *    limit and the per-user daily item quota stay authoritative — a 30-item
 *    haul is a slow trickle of ordinary single-item runs, never a stampede.
 *  - A `quota` outcome (the per-user/day spend guardrail said no) marks the
 *    failing entry AND every not-yet-started entry `blocked` without calling
 *    the runner again — the quota will not reset mid-batch, so hammering the
 *    remaining N items would only burn rate limit for identical denials.
 *    In-flight entries are allowed to finish (their quota slot was already
 *    consumed server-side).
 *  - Any other failure (`rate-limit`, `error`) is isolated to its entry:
 *    one item's pipeline error never sinks the batch (partial failure is
 *    honest; the UI offers retry per entry).
 */

export type BatchFailureKind = "quota" | "rate-limit" | "error";

/** What one pipeline run reported back through the transport. */
export type BatchRunOutcome =
  | { ok: true; itemId: string; listingId: string; listingStatus: string }
  | { ok: false; kind: BatchFailureKind; message: string };

/** Per-entry orchestration state, surfaced live to the triage list. */
export type BatchEntryState =
  | { phase: "waiting" }
  | { phase: "running" }
  | { phase: "done"; itemId: string; listingId: string; listingStatus: string }
  | { phase: "failed"; kind: Exclude<BatchFailureKind, "quota">; message: string }
  /** Skipped because the daily spend guardrail was hit earlier in the batch
   *  (or this entry itself was the one the quota refused). Retryable later. */
  | { phase: "blocked"; message: string };

export interface RunBatchOptions {
  /** Max pipeline runs in flight at once. Default 2; clamped to ≥ 1. */
  concurrency?: number;
  /** Live state transitions for the triage UI. */
  onUpdate?: (index: number, state: BatchEntryState) => void;
}

export const DEFAULT_BATCH_CONCURRENCY = 2;

/**
 * Run `count` entries through `runner` with bounded concurrency. Resolves with
 * the final state of every entry (same order as the input); never rejects —
 * a runner that *throws* (transport bug) is folded into a `failed` entry.
 */
export async function runBatch(
  count: number,
  runner: (index: number) => Promise<BatchRunOutcome>,
  options: RunBatchOptions = {},
): Promise<BatchEntryState[]> {
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_BATCH_CONCURRENCY);
  const states: BatchEntryState[] = Array.from({ length: count }, () => ({
    phase: "waiting" as const,
  }));
  const set = (index: number, state: BatchEntryState) => {
    states[index] = state;
    options.onUpdate?.(index, state);
  };

  let next = 0;
  let terminalCapacityMessage: string | null = null;

  async function worker(): Promise<void> {
    while (true) {
      const index = next;
      if (index >= count) return;
      next += 1;
      if (terminalCapacityMessage) {
        set(index, {
          phase: "blocked",
          message: terminalCapacityMessage,
        });
        continue;
      }
      set(index, { phase: "running" });
      const outcome = await runEntry(runner, index);
      if (outcome.ok) {
        set(index, {
          phase: "done",
          itemId: outcome.itemId,
          listingId: outcome.listingId,
          listingStatus: outcome.listingStatus,
        });
      } else if (outcome.kind === "quota") {
        // Stop dispatching new entries and preserve the authoritative reason
        // (operational capacity or SnapList Pro) for every blocked sibling.
        terminalCapacityMessage = outcome.message;
        set(index, { phase: "blocked", message: outcome.message });
      } else {
        set(index, { phase: "failed", kind: outcome.kind, message: outcome.message });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(count, 0)) }, () => worker()),
  );
  return states;
}

/** One guarded runner call — a thrown transport error becomes a failed outcome. */
export async function runEntry(
  runner: (index: number) => Promise<BatchRunOutcome>,
  index: number,
): Promise<BatchRunOutcome> {
  try {
    return await runner(index);
  } catch {
    return {
      ok: false,
      kind: "error",
      message: "Something went wrong sending this item. Please retry.",
    };
  }
}
