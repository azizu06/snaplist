import { z } from "zod";
import type { GuestRecoveryRegistrationProducer } from "@/lib/guest-recovery/producer";
import type { PipelineResult } from "@/lib/pipeline";
import type { SellerPushDispatcher } from "@/lib/push-notifications";
import { PIPELINE_OPERATIONS_POLICY } from "@/lib/pipeline-operations/policy";
import {
  captureProviderUsageRun,
  type ProviderUsageRecord,
} from "@/lib/provider-usage";
import { pipelineQueueEnvelopeSchema } from "./envelope";
import { describeErrorForLog } from "./log-safe-error";
import type { PipelineQueue } from "./queue";
import {
  pipelineWorkerCheckpointSchema,
  type PipelineWorkerCheckpoint,
  type PipelineWorkerCheckpointWrite,
  type SellerVoiceTranscriptionAttempt,
} from "./checkpoint";
import type {
  PipelineRunStage,
  PipelineWorkerContext,
  PipelineWorkerStore,
} from "./worker-store";

export interface DurablePipelineProcessor {
  process(input: {
    context: PipelineWorkerContext;
    onCheckpoint: (
      stage: Exclude<PipelineRunStage, "queued" | "completed">,
      checkpoint: PipelineWorkerCheckpointWrite,
    ) => Promise<PipelineWorkerCheckpoint>;
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
    batchSize: z.number().int().min(1).max(10).default(
      PIPELINE_OPERATIONS_POLICY.worker.batchSize,
    ),
    visibilityTimeoutSeconds: z.number().int().min(1).max(3_600).default(
      PIPELINE_OPERATIONS_POLICY.worker.visibilityTimeoutSeconds,
    ),
    retryBaseSeconds: z.number().int().min(1).max(3_600).default(
      PIPELINE_OPERATIONS_POLICY.worker.retryBaseSeconds,
    ),
    retryMaxSeconds: z.number().int().min(1).max(3_600).default(
      PIPELINE_OPERATIONS_POLICY.worker.retryMaxSeconds,
    ),
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

function transcriptionAttemptUsage(
  usage: ProviderUsageRecord,
): ProviderUsageRecord | null {
  if (usage.transcriptions.length === 0) return null;
  return {
    schemaVersion: 1,
    modelCalls: usage.transcriptions.reduce(
      (total, entry) => total + entry.calls,
      0,
    ),
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    models: [],
    transcriptions: usage.transcriptions,
    soldComps: [],
  };
}

function checkpointTranscriptionAttemptUsage(
  attempt: SellerVoiceTranscriptionAttempt | undefined,
): ProviderUsageRecord | null {
  if (!attempt) return null;
  return {
    schemaVersion: 1,
    modelCalls: attempt.calls,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    models: [],
    transcriptions: [attempt],
    soldComps: [],
  };
}

function checkpointTranscriptionAttempt(
  checkpoint: PipelineWorkerCheckpoint,
): SellerVoiceTranscriptionAttempt | undefined {
  return (
    checkpoint.voiceAttempt?.transcriptionAttempt ??
    checkpoint.voice?.transcriptionAttempt
  );
}

function sameTranscriptionAttempt(
  left: SellerVoiceTranscriptionAttempt | undefined,
  right: SellerVoiceTranscriptionAttempt | undefined,
): boolean {
  return Boolean(
    left &&
      right &&
      left.role === right.role &&
      left.provider === right.provider &&
      left.model === right.model &&
      left.calls === right.calls &&
      left.chargedUsd === right.chargedUsd,
  );
}

function withoutTranscriptionUsage(
  usage: ProviderUsageRecord,
): ProviderUsageRecord {
  const transcriptionCalls = usage.transcriptions.reduce(
    (total, entry) => total + entry.calls,
    0,
  );
  return {
    ...usage,
    modelCalls: Math.max(0, usage.modelCalls - transcriptionCalls),
    transcriptions: [],
  };
}

async function persistProviderUsage(
  runs: PipelineWorkerStore,
  context: PipelineWorkerContext,
  usage: ProviderUsageRecord,
): Promise<boolean> {
  try {
    await runs.recordProviderUsage({
      runId: context.run.id,
      leaseToken: context.run.lease_token,
      usage,
    });
    return true;
  } catch (error) {
    // The rejection comes back from the usage write for a run whose seller
    // transcript is in flight, so its message is not ours to repeat. Log the
    // error's type and codes instead — see `describeErrorForLog`.
    console.error(
      `[pipeline.worker.provider_usage] run ${context.run.id} persistence_failed`,
      describeErrorForLog(error),
    );
    return false;
  }
}

export async function consumePipelineQueue(
  dependencies: {
    queue: PipelineQueue;
    runs: PipelineWorkerStore;
    processor: DurablePipelineProcessor;
    guestRecovery?: GuestRecoveryRegistrationProducer;
    /**
     * Tells the seller their listing is ready (#891). Optional so every
     * existing composition keeps working; absent means the run completes in
     * silence, never that it fails.
     */
    push?: SellerPushDispatcher;
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
    let readyItemName: string | null = null;
    try {
      let durableTranscriptionAttempt = checkpointTranscriptionAttempt(
        pipelineWorkerCheckpointSchema.parse(context.run.checkpoint),
      );
      const pendingTranscriptionUsage = checkpointTranscriptionAttemptUsage(
        durableTranscriptionAttempt,
      );
      if (
        pendingTranscriptionUsage &&
        !(await persistProviderUsage(
          dependencies.runs,
          context,
          pendingTranscriptionUsage,
        ))
      ) {
        throw new PipelineWorkerFailure({
          code: "provider_usage_temporarily_unavailable",
          safeMessage:
            "SnapList could not finish this listing yet and will retry automatically.",
          retryable: true,
        });
      }
      const measured = await captureProviderUsageRun(() =>
        dependencies.processor.process({
          context,
          onCheckpoint: async (stage, checkpoint) => {
            const persisted = await dependencies.runs.checkpoint({
              runId: context.run.id,
              leaseToken: context.run.lease_token,
              stage,
              checkpoint,
              leaseSeconds: config.visibilityTimeoutSeconds,
            });
            const persistedAttempt = checkpointTranscriptionAttempt(
              pipelineWorkerCheckpointSchema.parse(persisted),
            );
            if (
              persistedAttempt &&
              !sameTranscriptionAttempt(
                durableTranscriptionAttempt,
                persistedAttempt,
              )
            ) {
              const usage = checkpointTranscriptionAttemptUsage(persistedAttempt);
              if (
                !usage ||
                !(await persistProviderUsage(
                  dependencies.runs,
                  context,
                  usage,
                ))
              ) {
                throw new PipelineWorkerFailure({
                  code: "provider_usage_temporarily_unavailable",
                  safeMessage:
                    "SnapList could not finish this listing yet and will retry automatically.",
                  retryable: true,
                });
              }
              durableTranscriptionAttempt = persistedAttempt;
            }
            await dependencies.queue.defer(
              message.id,
              config.visibilityTimeoutSeconds,
            );
            return persisted;
          },
        }),
      );
      if (!measured.ok) {
        const usage = transcriptionAttemptUsage(measured.usage);
        if (usage) {
          const persisted = await persistProviderUsage(
            dependencies.runs,
            context,
            usage,
          );
          if (!persisted && !durableTranscriptionAttempt) {
            throw new PipelineWorkerFailure({
              code: "provider_usage_temporarily_unavailable",
              safeMessage:
                "SnapList could not finish this listing yet and will retry automatically.",
              retryable: true,
            });
          }
        }
        throw measured.error;
      }
      const { value: result, usage } = measured;
      // Cost telemetry (#716), written while the attempt's lease is still live
      // — completion clears it. Never allowed to fail the attempt: a listing the
      // seller already paid for cannot be lost to a bookkeeping insert, so the
      // failure is logged and the run proceeds to completion.
      const usagePersisted = await persistProviderUsage(
        dependencies.runs,
        context,
        durableTranscriptionAttempt
          ? withoutTranscriptionUsage(usage)
          : usage,
      );
      if (
        !usagePersisted &&
        usage.transcriptions.length > 0 &&
        !durableTranscriptionAttempt
      ) {
        throw new PipelineWorkerFailure({
          code: "provider_usage_temporarily_unavailable",
          safeMessage:
            "SnapList could not finish this listing yet and will retry automatically.",
          retryable: true,
        });
      }
      const guestRecoveryRegistration = dependencies.guestRecovery
        ? await dependencies.guestRecovery.prepare({
            context,
            result,
            stageUploadCleanup: async (paths) => {
              await dependencies.runs.stageGuestRecoveryUploadCleanup({
                runId: context.run.id,
                leaseToken: context.run.lease_token,
                paths,
              });
            },
          })
        : null;
      await dependencies.runs.complete({
        runId: context.run.id,
        leaseToken: context.run.lease_token,
        result,
        autopilotEnabled: context.run.autopilot_enabled,
        guestRecoveryRegistration,
      });
      completed = true;
      readyItemName = result.listing.title;
    } catch (error) {
      // `classifyFailure` collapses every non-Zod error into one retryable
      // code, so the code alone cannot answer why an attempt failed. Describe
      // the original error first. This keeps 23031e7e2, which a later squash
      // merge dropped, leaving the first real production run undiagnosable.
      //
      // Described, not logged whole: this `catch` wraps every stage, and on a
      // voice item the seller's transcript is in flight as `sellerContext`, so
      // a stage error's message can carry the seller's own words (#795).
      console.error(
        `[pipeline.worker.attempt] run ${context.run.id}`,
        describeErrorForLog(error),
      );
      const failure = classifyFailure(error);
      console.error(
        `[pipeline.worker.attempt] run ${context.run.id} code ${failure.code}`,
      );
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
      // After the completion is durable and the message is gone, because the
      // seller is being told about a listing that already exists. The identity
      // comes from the stored run, never from the envelope that arrived in the
      // queue, and the dispatcher owns the once-only guard across redelivery,
      // retry, and recovery. Guarded here as well: an announcement must not be
      // able to turn a finished, paid-for run into a failure (#891).
      try {
        await dependencies.push?.listingReady({
          userId: context.run.user_id,
          runId: context.run.id,
          itemName: readyItemName,
        });
      } catch (error) {
        console.error(
          `[pipeline.worker.push] run ${context.run.id}`,
          describeErrorForLog(error),
        );
      }
    }
  }

  return summary;
}
