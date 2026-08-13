/**
 * Per-run provider-usage measurement (issue #716) — the measured input the
 * SnapList Pro allowance decision consumes instead of a modeled estimate.
 */
export {
  captureProviderUsageRun,
  currentTranscriptionUsage,
  providerUsageRunActive,
  recordModelUsage,
  recordSoldCompUsage,
  recordTranscriptionUsage,
  withProviderUsageRun,
  type CapturedProviderUsageRun,
  type ProviderUsageRun,
} from "./collector";
// `./post-completion` is deliberately NOT re-exported here, for the same reason
// `./schema` is not: it imports the strict schema, which value-imports the
// role/provider lists, and the registry's usage middleware imports this barrel.
// Re-exporting it closes the cycle registry -> middleware -> barrel -> schema ->
// registry, and the lists read as undefined. Both correction paths import
// `./post-completion` directly.
export {
  ProviderUsageTally,
  type ModelUsageReport,
  type ProviderUsageModelTotals,
  type ProviderUsageRecord,
  type SoldCompUsage,
  type SoldCompUsageReport,
  type ProviderUsageTranscriptionTotals,
  type TranscriptionUsageReport,
} from "./record";
