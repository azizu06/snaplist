import type { PipelineProgressRun } from "./status";

function fractionalNanoseconds(timestamp: string): number {
  const fraction = timestamp.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? "";
  return Number(fraction.padEnd(9, "0").slice(0, 9));
}

/** Compare Postgres timestamps without losing their microsecond tie-breaker. */
export function isPipelineProgressUpdateStale(
  candidate: PipelineProgressRun,
  accepted: PipelineProgressRun,
): boolean {
  const candidateTime = Date.parse(candidate.updated_at);
  const acceptedTime = Date.parse(accepted.updated_at);
  if (Number.isFinite(candidateTime) && Number.isFinite(acceptedTime)) {
    if (candidateTime === acceptedTime) {
      return fractionalNanoseconds(candidate.updated_at)
        < fractionalNanoseconds(accepted.updated_at);
    }
    return candidateTime < acceptedTime;
  }
  return candidate.updated_at < accepted.updated_at;
}
