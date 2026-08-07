import type { LlmProvider, LlmRole } from "../llm";

/**
 * The per-run provider-usage record (issue #716) — WHAT a listing-preparation
 * run consumed from paid providers, measured rather than modeled.
 *
 * Two hard rules shape every type here:
 *
 *  1. **Counts, never currency.** Tokens and retrieved-result counts are facts a
 *     provider reported for this run; a dollar figure is a rate card applied to
 *     them later, and rate cards move. The one exception is
 *     `SoldCompUsage.chargedUsd`, which the Apify Actor itself REPORTS for its
 *     own run — that is still a measurement, not a conversion we performed.
 *  2. **No content.** Nothing derived from a prompt, a model response, a secret,
 *     or the seller's item may appear. Every field below is a role name, a model
 *     id the registry resolved, a provider name, or a number.
 */

/** Token counts for one (role, provider, model) triple within a run. */
export interface ProviderUsageModelTotals {
  /** The registry role that routed these calls (`vision`, `listing`, …). */
  role: LlmRole;
  /** The provider that answered. */
  provider: LlmProvider;
  /**
   * The model id the registry ACTUALLY resolved for the call. Never a literal
   * written here: role defaults move (a provider-default flip changes every
   * role at once) and `VISION_MODEL`-style overrides differ per deployment, so
   * a run's cost can only be reconstructed from what really answered it.
   */
  model: string;
  /** How many calls this triple served. */
  calls: number;
  /** Total input (prompt) tokens the provider reported. */
  inputTokens: number;
  /** Of `inputTokens`, the part served from the provider's prompt cache. */
  cachedInputTokens: number;
  /** Total output (completion) tokens the provider reported. */
  outputTokens: number;
  /** Of `outputTokens`, the part the provider attributed to reasoning. */
  reasoningTokens: number;
}

/** What one sold-comp retrieval strategy fetched, and what it reported charging. */
export interface SoldCompUsage {
  /** Which sold-comp strategy fired (e.g. `apify`, `public-page`). */
  strategy: string;
  /** How many times that strategy ran in this run. */
  attempts: number;
  /** How many candidate results came back BEFORE matching/ranking filtered them. */
  results: number;
  /**
   * The charge the provider reported for its own run, when it reports one.
   * Null when the strategy has no metered charge or did not report it — never
   * a number we computed from a rate we hold.
   */
  chargedUsd: number | null;
}

/** One run's complete provider-usage measurement. */
export interface ProviderUsageRecord {
  /** Bumped when the persisted shape changes; the reader pins it. */
  schemaVersion: 1;
  /** Total registry-routed model calls in the run. */
  modelCalls: number;
  /** Run totals, summed across every role. */
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Per-(role, provider, model) breakdown, ordered deterministically. */
  models: ProviderUsageModelTotals[];
  /** Per-strategy sold-comp retrieval, ordered deterministically. */
  soldComps: SoldCompUsage[];
}

/** One reported model call. Counts only — the params/response never come along. */
export interface ModelUsageReport {
  role: LlmRole;
  provider: LlmProvider;
  model: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

/** One reported sold-comp retrieval attempt. */
export interface SoldCompUsageReport {
  strategy: string;
  results: number;
  chargedUsd?: number | null;
}

/** A provider may omit a count; an omitted count is zero, never a guess. */
function count(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.trunc(value as number) : 0;
}

/**
 * Accumulates one run's reports into a `ProviderUsageRecord`. Pure and
 * synchronous: the run scope owns one of these, and both reporters and the
 * reader talk only to it.
 */
export class ProviderUsageTally {
  private readonly models = new Map<string, ProviderUsageModelTotals>();
  private readonly soldComps = new Map<string, SoldCompUsage>();

  addModelCall(report: ModelUsageReport): void {
    // NUL joins the three parts: a model id may contain any printable
    // character a provider chooses, and a separator one could contain would
    // let two different triples collapse into one row.
    const key = `${report.role}\u0000${report.provider}\u0000${report.model}`;
    const totals = this.models.get(key) ?? {
      role: report.role,
      provider: report.provider,
      model: report.model,
      calls: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    };
    totals.calls += 1;
    totals.inputTokens += count(report.inputTokens);
    totals.cachedInputTokens += count(report.cachedInputTokens);
    totals.outputTokens += count(report.outputTokens);
    totals.reasoningTokens += count(report.reasoningTokens);
    this.models.set(key, totals);
  }

  addSoldCompRetrieval(report: SoldCompUsageReport): void {
    const totals = this.soldComps.get(report.strategy) ?? {
      strategy: report.strategy,
      attempts: 0,
      results: 0,
      chargedUsd: null,
    };
    totals.attempts += 1;
    totals.results += count(report.results);
    // A reported charge accumulates; strategies that report nothing stay null so
    // "unmetered" and "charged nothing" never read the same downstream.
    if (typeof report.chargedUsd === "number" && Number.isFinite(report.chargedUsd)) {
      totals.chargedUsd = (totals.chargedUsd ?? 0) + report.chargedUsd;
    }
    this.soldComps.set(report.strategy, totals);
  }

  /** The run's aggregate. Ordering is deterministic so persisted rows diff cleanly. */
  snapshot(): ProviderUsageRecord {
    const models = [...this.models.values()].sort(
      (a, b) =>
        a.role.localeCompare(b.role) ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model),
    );
    const soldComps = [...this.soldComps.values()].sort((a, b) =>
      a.strategy.localeCompare(b.strategy),
    );
    return {
      schemaVersion: 1,
      modelCalls: models.reduce((total, entry) => total + entry.calls, 0),
      inputTokens: models.reduce((total, entry) => total + entry.inputTokens, 0),
      cachedInputTokens: models.reduce(
        (total, entry) => total + entry.cachedInputTokens,
        0,
      ),
      outputTokens: models.reduce((total, entry) => total + entry.outputTokens, 0),
      reasoningTokens: models.reduce(
        (total, entry) => total + entry.reasoningTokens,
        0,
      ),
      models,
      soldComps,
    };
  }
}
