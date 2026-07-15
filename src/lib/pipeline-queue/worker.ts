import { z } from "zod";
import type { PipelineResult } from "@/lib/pipeline";
import { pipelineQueueEnvelopeSchema } from "./envelope";
import type { PipelineQueue } from "./queue";
import type { PipelineWorkerCheckpoint } from "./checkpoint";
import type {
  PipelineRunStage,
  PipelineWorkerContext,
  PipelineWorkerStore,
} from "./worker-store";

export interface DurablePipelineProcessor {
  process(input: {
    context: PipelineWorkerContext;
    onCheckpoint: (
      stage: Exclude<PipelineRunStage, "queued" | "completed" | "persisting">,
      checkpoint: PipelineWorkerCheckpoint,
    ) => Promise<void>;
  }): Promise<PipelineResult>;
}

export class PipelineWorkerFailure extends Error {
  readonly code: string;
  readonly safeMessage: string;
  readonly retryable: boolean;

  constructor(input: { code: string; safeMessage: string; retryable: boolean }) {
    super(input.safeMessage);
    this.name = "PipelineWorkerFailure";
    this.code = input.code;
    this.safeMessage = input.safeMessage;
    this.retryable = input.retryable;
  }
}

const optionsSchema = z
  .object({
    batchSize: z.number().int().min(1).max(10).default(5),
    visibilityTimeoutSeconds: z.number().int().min(1).max(3_600).default(300),
    retryBaseSeconds: z.number().int().min(1).max(3_600).default(30),
    retryMaxSeconds: z.number().int().min(1).max(3_600).default(900),
  })
  .strict();

export interface PipelineConsumerSummary {
  claimed: number;
  succeeded: number;
  retrying: number;
  failed: number;
  skipped: number;
}

const rawEnvelopeSchema = z
  .object({
    run_id: z.string().uuid(),
    schema_version: z.number().int(),
  })
  .passthrough();

function classifyFailure(error: unknown): PipelineWorkerFailure {
  if (error instanceof PipelineWorkerFailure) return error;
  if (error instanceof z.ZodError) {
    return new PipelineWorkerFailure({
      code: "invalid_pipeline_result",
      safeMessage: "The generated listing did not pass validation.",
      retryable: false,
    });
  }
  return new PipelineWorkerFailure({
    code: "pipeline_temporarily_unavailable",
    safeMessage: "SnapList could not finish this listing yet and will retry automatically.",
    retryable: true,
  });
}

function retryDelay(attemptCount: number, base: number, maximum: number): number {
  return Math.min(maximum, base * 2 ** Math.max(0, attemptCount - 1));
}

export async function consumePipelineQueue(
  dependencies: {
    queue: PipelineQueue;
    runs: PipelineWorkerStore;
    processor: DurablePipelineProcessor;
  },
  options: Partial<z.input<typeof optionsSchema>> = {},
): Promise<PipelineConsumerSummary> {
  const config = optionsSchema.parse(options);
  const messages = await dependencies.queue.claim({
    limit: config.batchSize,
    visibilityTimeoutSeconds: config.visibilityTimeoutSeconds,
  });
  const summary: PipelineConsumerSummary = {
    claimed: messages.length,
    succeeded: 0,
    retrying: 0,
    failed: 0,
    skipped: 0,
  };

  for (const message of messages) {
    const envelope = pipelineQueueEnvelopeSchema.safeParse(message.envelope);
    if (!envelope.success) {
      const raw = rawEnvelopeSchema.safeParse(message.envelope);
      const rejected = raw.success
        ? await dependencies.runs.rejectMessage({
            runId: raw.data.run_id,
            messageId: message.id,
            failureCode: "unsupported_schema_version",
            safeFailureMessage:
              "This queued listing uses an unsupported job version.",
          })
        : false;
      await dependencies.queue.ack(message.id);
      if (rejected) summary.failed += 1;
      else summary.skipped += 1;
      continue;
    }

    const acquisition = await dependencies.runs.acquire({
      runId: envelope.data.run_id,
      messageId: message.id,
      leaseSeconds: config.visibilityTimeoutSeconds,
    });

    if (acquisition.kind === "deferred") {
      await dependencies.queue.defer(message.id, acquisition.retryAfterSeconds);
      summary.skipped += 1;
      continue;
    }
    if (acquisition.kind === "terminal" || acquisition.kind === "mismatch") {
      await dependencies.queue.ack(message.id);
      summary.skipped += 1;
      continue;
    }

    const { context } = acquisition;
    let completed = false;
    try {
      const result = await dependencies.processor.process({
        context,
        onCheckpoint: async (stage, checkpoint) => {
          await dependencies.runs.checkpoint({
            runId: context.run.id,
            leaseToken: context.run.lease_token,
            stage,
            checkpoint,
            leaseSeconds: config.visibilityTimeoutSeconds,
          });
          await dependencies.queue.defer(
            message.id,
            config.visibilityTimeoutSeconds,
          );
        },
      });
      await dependencies.runs.complete({
        runId: context.run.id,
        leaseToken: context.run.lease_token,
        result,
        autopilotEnabled: context.run.autopilot_enabled,
      });
      completed = true;
    } catch (error) {
      const failure = classifyFailure(error);
      const backoff = retryDelay(
        context.run.attempt_count,
        config.retryBaseSeconds,
        config.retryMaxSeconds,
      );
      const outcome = await dependencies.runs.failAttempt({
        runId: context.run.id,
        leaseToken: context.run.lease_token,
        retryable: failure.retryable,
        retryAfterSeconds: backoff,
        failureCode: failure.code,
        safeFailureMessage: failure.safeMessage,
      });
      if (outcome.status === "retrying") {
        await dependencies.queue.defer(
          message.id,
          outcome.retryAfterSeconds ?? backoff,
        );
        summary.retrying += 1;
      } else {
        await dependencies.queue.ack(message.id);
        summary.failed += 1;
      }
    }

    if (completed) {
      await dependencies.queue.ack(message.id);
      summary.succeeded += 1;
    }
  }

  return summary;
}
