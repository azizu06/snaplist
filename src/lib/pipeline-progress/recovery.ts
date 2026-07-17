export type PipelineRecoveryPath = "/upload" | "/batch";

export interface PipelineRecoveryHistory {
  readonly state: unknown;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

export function buildPipelineRecoveryHref(
  path: PipelineRecoveryPath,
  batchId: string,
): string {
  const params = new URLSearchParams({ batch: batchId });
  return `${path}?${params.toString()}`;
}

/** Persist the durable lookup key before the request can commit or disconnect. */
export function persistPipelineRecoveryHandle(
  history: PipelineRecoveryHistory,
  path: PipelineRecoveryPath,
  batchId: string,
): void {
  history.replaceState(
    history.state,
    "",
    buildPipelineRecoveryHref(path, batchId),
  );
}
