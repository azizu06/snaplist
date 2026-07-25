import {
  pipelineWorkerCheckpointSchema,
  type PipelineWorkerCheckpoint,
  type PipelineWorkerCheckpointWrite,
} from "./checkpoint";

/**
 * Test-only stand-in for the database side of `checkpoint_pipeline_run`. Its
 * job is to stop four offline fakes from re-spelling the same stamping branch
 * and drifting apart, not to reproduce the RPC exactly.
 *
 * What it models: a priced checkpoint arriving without `evidenceAsOf` comes
 * back stamped, and an already-stamped value is returned untouched, so offline
 * suites see research time behave as durable rather than recomputed.
 *
 * What it deliberately does NOT model, because a stateless double cannot:
 * the real RPC keys the stamp on the *stored* row
 * (`not (checkpoint ? 'priced') and p_checkpoint ? 'priced'`) and then
 * overwrites unconditionally, so it discards a worker-supplied `evidenceAsOf`
 * rather than preserving it as this double does. It also rejects a payload that
 * fails `p_checkpoint @> checkpoint` instead of re-stamping a regressed one.
 *
 * Do not read a green offline suite as evidence that a worker-supplied
 * timestamp would survive, or be refused, in production. That rule is proved
 * only by the live RPC/RLS coverage in `worker.rls.test.ts`, which is the
 * authority for anything about the real clock.
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
