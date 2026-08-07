import { AsyncLocalStorage } from "node:async_hooks";
import {
  ProviderUsageTally,
  type ModelUsageReport,
  type ProviderUsageRecord,
  type SoldCompUsageReport,
} from "./record";

/**
 * The run-scoped collection seam for provider usage (issue #716).
 *
 * The reporters and the reader are far apart: the LLM registry hands out a
 * model that seven different call sites use, the sold-comp tier sits three
 * layers below pricing, and the reader is the worker's persistence step. Passing
 * a collector through every one of those signatures would mean editing every
 * pricing provider, the vision extractor, the listing generator, and the
 * `Pipeline` contract itself — a wide diff whose only payload is telemetry, and
 * one a future call site could silently forget to thread.
 *
 * So the scope is ambient instead: `AsyncLocalStorage` propagates through
 * awaits and through the `Promise.all` the pipeline uses to overlap pricing,
 * listing, and measurement, so every call started inside `withProviderUsageRun`
 * reports into that run's tally and no other's. Concurrent runs in one process
 * stay separate because each gets its own store frame.
 *
 * Outside a run the reporters are NO-OPS. That is deliberate, not lax: the eval
 * harness, benchmark scripts, and one-off spikes all resolve models through the
 * same registry, and none of them belongs to a seller's run.
 */
const runStorage = new AsyncLocalStorage<ProviderUsageTally>();

export interface ProviderUsageRun<T> {
  /** Whatever the wrapped work returned. */
  value: T;
  /** What the run reported consuming. */
  usage: ProviderUsageRecord;
}

/**
 * Run `work` inside a fresh provider-usage scope and return its result together
 * with everything reported inside it.
 *
 * Nesting starts a NEW tally rather than merging into the outer one: a nested
 * scope means a caller asked for a separate measurement, and silently folding it
 * into an enclosing run would double-count it.
 */
export async function withProviderUsageRun<T>(
  work: () => Promise<T> | T,
): Promise<ProviderUsageRun<T>> {
  const tally = new ProviderUsageTally();
  const value = await runStorage.run(tally, async () => work());
  return { value, usage: tally.snapshot() };
}

/**
 * Report one completed model call. Called by the registry's usage middleware, so
 * every model call routed through `resolveLanguageModel` is counted without its
 * call site knowing telemetry exists.
 */
export function recordModelUsage(report: ModelUsageReport): void {
  runStorage.getStore()?.addModelCall(report);
}

/**
 * Report one sold-comp retrieval attempt: how many candidates came back and, when
 * the provider reports one, what it charged for its own run.
 */
export function recordSoldCompUsage(report: SoldCompUsageReport): void {
  runStorage.getStore()?.addSoldCompRetrieval(report);
}

/** Whether a provider-usage run is currently open (the reporters' fast path). */
export function providerUsageRunActive(): boolean {
  return runStorage.getStore() !== undefined;
}
