import {
  pipelineWorkerCheckpointSchema,
  type PipelineWorkerCheckpoint,
  type PipelineWorkerCheckpointWrite,
} from "./checkpoint";

/**
 * Test-only stand-in for the database side of `checkpoint_pipeline_run`.
 *
 * The RPC stamps `priced.evidenceAsOf` from the database clock the first time a
 * priced checkpoint becomes durable, and leaves an already-stamped value alone
 * so a retry cannot move research time. Offline suites and the offline
 * benchmark all need that same rule, and each used to re-spell it; one typed
 * double keeps them from drifting apart or from quietly accepting a
 * worker-supplied timestamp.
 *
 * The authoritative proof of the real clock behavior is the live RPC/RLS
 * coverage in `worker.rls.test.ts`, not this double.
 */
export interface DatabaseCheckpointClock {
  stamp(checkpoint: PipelineWorkerCheckpointWrite): PipelineWorkerCheckpoint;
}

export function createDatabaseCheckpointClock(
  checkpointedAt: () => string,
): DatabaseCheckpointClock {
  return {
    stamp(checkpoint) {
      const priced = checkpoint.priced;
      return pipelineWorkerCheckpointSchema.parse({
        ...checkpoint,
        priced:
          priced && !priced.evidenceAsOf
            ? { ...priced, evidenceAsOf: checkpointedAt() }
            : priced,
      });
    },
  };
}
