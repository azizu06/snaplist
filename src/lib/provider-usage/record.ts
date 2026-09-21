import type { LlmProvider, LlmRole, TranscriptionRole } from "../llm";

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

/**
 * The closed vocabulary for `SoldCompUsage.reason` (#1138).
 *
 * Closed on purpose. `reason` is the first string this record has carried that is
 * not a routing label, and the record is written to a tenant table, so anything
 * that could become free text is a place a query or an item description could
 * leak into telemetry. These three constants plus `all-rejected:<matcher reason>`
 * — itself drawn from the matcher's own fixed reason union — are the whole
 * grammar, and `isSoldCompUsageReason` is what the persistence schema and the
 * content-leak test both hold callers to.
 */
export const SOLD_COMP_TERMINAL_REASONS = [
  /** The strategy retrieved nothing at all; the provider reported no failure. */
  "no-candidates",
  /** The provider itself failed: non-success status, or a run that failed its own requests. */
  "provider-error",
  /** The retrieval path was refused before any candidate existed (e.g. an edge 403). */
  "blocked",
  /**
   * Candidates survived the matcher as corroboration but none anchored. The
   * retrieval worked and the evidence was real; it never cleared the bar.
   */
  "no-anchors",
] as const;

export type SoldCompTerminalReason = (typeof SOLD_COMP_TERMINAL_REASONS)[number];

/** Prefix for "candidates came back, the matcher accepted none of them". */
export const SOLD_COMP_ALL_REJECTED_PREFIX = "all-rejected:";

/**
 * How informative each reason is, so a later report cannot DOWNGRADE an earlier
 * one (#1138).
 *
 * Every path ends with the matcher being handed an empty candidate list, so the
 * last reason written is almost always the least informative one. A run whose
 * Actor timed out would have been filed as `no-candidates` — the exact
 * "broken provider looks like an item with no comps" confusion this field exists
 * to end. Ranking makes the order of reports irrelevant: what the provider saw
 * outranks what the matcher inferred from the provider's silence.
 */
const SOLD_COMP_REASON_RANK = new Map<string, number>([
  ["no-candidates", 1],
  // Candidates existed; the matcher kept none of them as anchors. More than
  // silence, less than a failure — and the same weight as `all-rejected:*`,
  // which says the same thing with a cause attached.
  ["no-anchors", 2],
  ["blocked", 3],
  ["provider-error", 4],
]);
/** Candidates existed and all were rejected — more than silence, less than a failure. */
const SOLD_COMP_ALL_REJECTED_RANK = 2;

function soldCompReasonRank(reason: string): number {
  return (
    SOLD_COMP_REASON_RANK.get(reason) ??
    (reason.startsWith(SOLD_COMP_ALL_REJECTED_PREFIX) ? SOLD_COMP_ALL_REJECTED_RANK : 0)
  );
}

/** The matcher reason suffix shape — lowercase words joined by hyphens, bounded. */
const ALL_REJECTED_SUFFIX_RE = /^[a-z][a-z-]{0,39}$/;

/** Whether a string is a legal `SoldCompUsage.reason` value. */
export function isSoldCompUsageReason(value: string): boolean {
  if ((SOLD_COMP_TERMINAL_REASONS as readonly string[]).includes(value)) return true;
  return (
    value.startsWith(SOLD_COMP_ALL_REJECTED_PREFIX) &&
    ALL_REJECTED_SUFFIX_RE.test(value.slice(SOLD_COMP_ALL_REJECTED_PREFIX.length))
  );
}

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
   * How many of those candidates the provider-neutral matcher ACCEPTED as anchors
   * (#1138). `results` alone could not tell a broken retrieval apart from a
   * retrieval the matcher threw away, and production had to be diagnosed from the
   * provider's own console because of it.
   *
   * Anchors, not the at-most-five matches the seller is shown: the display cap is
   * applied later and would understate how much evidence the strategy produced.
   */
  accepted: number;
  /**
   * A short bounded machine reason for a strategy that produced no usable
   * evidence, else null (#1138). One of `no-candidates`, `provider-error`,
   * `blocked`, or `all-rejected:<top matcher reject reason>`. Never free text,
   * never anything derived from the seller's item: every value is a constant this
   * codebase writes or a member of the matcher's own reason vocabulary.
   *
   * Invariant: a non-null reason means `accepted === 0`. A strategy that ends up
   * contributing an anchor clears whatever an earlier attempt reported.
   */
  reason: string | null;
  /**
   * The charge the provider reported for its own run, when it reports one.
   * Null when the strategy has no metered charge or did not report it — never
   * a number we computed from a rate we hold.
   */
  chargedUsd: number | null;
}

/** One media transcription triple whose provider exposes no token or charge usage. */
export interface ProviderUsageTranscriptionTotals {
  role: TranscriptionRole;
  provider: LlmProvider;
  model: string;
  calls: number;
  /** Null because the installed transcription API does not report a charge. */
  chargedUsd: null;
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
  /** Aggregate routing facts only; never audio, transcript, or provider payloads. */
  transcriptions: ProviderUsageTranscriptionTotals[];
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
  /** Why THIS attempt produced no candidates: `provider-error`, `blocked`, `no-candidates`. */
  reason?: string | null;
}

/**
 * What one sold-comp strategy produced after the provider-neutral matcher ran
 * (#1138). Reported once per strategy pass, not per attempt: anchors are decided
 * over the combined candidate set, not inside a single retrieval.
 */
export interface SoldCompOutcomeReport {
  strategy: string;
  accepted: number;
  /** `all-rejected:<top reject reason>` when candidates existed but none anchored. */
  reason?: string | null;
}

export interface TranscriptionUsageReport {
  role: TranscriptionRole;
  provider: LlmProvider;
  model: string;
  chargedUsd?: null;
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
  private readonly transcriptions = new Map<
    string,
    ProviderUsageTranscriptionTotals
  >();
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
    const totals = this.soldCompTotals(report.strategy);
    totals.attempts += 1;
    totals.results += count(report.results);
    // A reported charge accumulates; strategies that report nothing stay null so
    // "unmetered" and "charged nothing" never read the same downstream.
    if (typeof report.chargedUsd === "number" && Number.isFinite(report.chargedUsd)) {
      totals.chargedUsd = (totals.chargedUsd ?? 0) + report.chargedUsd;
    }
    this.setSoldCompReason(totals, report.reason);
    this.soldComps.set(report.strategy, totals);
  }

  /**
   * Record what the matcher accepted from one strategy's combined candidates
   * (#1138). Separate from `addSoldCompRetrieval` because it is not an attempt:
   * reporting it there would inflate `attempts`, which is the paid-run count the
   * cost record reads.
   */
  addSoldCompOutcome(report: SoldCompOutcomeReport): void {
    const totals = this.soldCompTotals(report.strategy);
    totals.accepted += count(report.accepted);
    this.setSoldCompReason(totals, report.reason);
    this.soldComps.set(report.strategy, totals);
  }

  private soldCompTotals(strategy: string): SoldCompUsage {
    return (
      this.soldComps.get(strategy) ?? {
        strategy,
        attempts: 0,
        results: 0,
        accepted: 0,
        reason: null,
        chargedUsd: null,
      }
    );
  }

  /**
   * A reason only ever describes an EMPTY contribution, so accepting an anchor
   * clears it: the first attempt of a pass can legitimately report
   * `no-candidates` and the expansion can still anchor, and a row that kept the
   * stale reason would read as a failure that did not happen.
   */
  private setSoldCompReason(totals: SoldCompUsage, reason: string | null | undefined): void {
    if (totals.accepted > 0) {
      totals.reason = null;
      return;
    }
    const value = typeof reason === "string" ? reason.trim() : "";
    // Enforced HERE rather than trusted from the call site: every reporter funnels
    // through this tally, so one check covers all of them, and an unrecognised
    // value is dropped instead of stored.
    if (!value || !isSoldCompUsageReason(value)) return;
    if (
      totals.reason != null &&
      soldCompReasonRank(value) <= soldCompReasonRank(totals.reason)
    ) {
      return;
    }
    totals.reason = value;
  }

  addTranscriptionCall(report: TranscriptionUsageReport): void {
    const key = `${report.role}\u0000${report.provider}\u0000${report.model}`;
    const totals = this.transcriptions.get(key) ?? {
      role: report.role,
      provider: report.provider,
      model: report.model,
      calls: 0,
      chargedUsd: null,
    };
    totals.calls += 1;
    this.transcriptions.set(key, totals);
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
    const transcriptions = [...this.transcriptions.values()].sort(
      (a, b) =>
        a.role.localeCompare(b.role) ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model),
    );
    return {
      schemaVersion: 1,
      modelCalls:
        models.reduce((total, entry) => total + entry.calls, 0) +
        transcriptions.reduce((total, entry) => total + entry.calls, 0),
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
      transcriptions,
      soldComps,
    };
  }
}
