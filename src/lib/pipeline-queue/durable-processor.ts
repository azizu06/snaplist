import { createHash } from "node:crypto";
import type { PipelineResult } from "@/lib/pipeline";
import type { SellerContext } from "@/lib/pipeline/types";
import type {
  SellerContextTranscriber,
  SellerContextTranscriptionResult,
} from "@/lib/llm/seller-context";
import { mobileSubmissionVoiceDurationMs } from "@/lib/mobile-item-submission/voice";
import type { VisionPipelineStages } from "@/lib/vision";
import {
  pipelineWorkerCheckpointSchema,
  pipelineWorkerCheckpointWriteSchema,
  sellerVoiceAttemptCheckpointSchema,
  sellerVoiceCheckpointSchema,
  type PipelineWorkerCheckpoint,
  type SellerVoiceAttemptCheckpoint,
  type SellerVoiceCheckpoint,
  type SellerVoiceTranscriptionAttempt,
} from "./checkpoint";
import type { PipelineWorkerContext } from "./worker-store";
import { PipelineWorkerFailure, type DurablePipelineProcessor } from "./worker";

export type { PipelineWorkerCheckpoint } from "./checkpoint";

export interface PipelineVoiceStorage {
  download(input: { path: string }): Promise<Uint8Array>;
}

export interface DurableVisionPipelineProcessorOptions {
  voiceStorage: PipelineVoiceStorage;
  transcriber: SellerContextTranscriber;
  recordTerminalOutcome(input: {
    runId: string;
    leaseToken: string;
    outcome: SellerContextTranscriptionResult["kind"];
    providerContacted: boolean;
  }): Promise<boolean>;
  /**
   * Durably reserve ONE content-free transcription call before the paid adapter runs
   * (#1120 P0). A fresh voice run has no `identified` yet, so it cannot reserve
   * through a checkpoint — `checkpoint_pipeline_run` rejects a checkpoint without
   * one. `record_pipeline_run_provider_usage` is the reservation that actually
   * guards the money: it has no identification precondition and already merges a
   * transcription-only entry idempotently, in either order, by design.
   *
   * Returning false BLOCKS the adapter, preserving "never contact a paid provider
   * without a durable reservation". Optional so existing compositions and tests keep
   * working; when absent the worker's checkpoint-driven gate is the only reservation,
   * which is the pre-existing behavior for a resumed run.
   */
  reserveTranscription?(input: {
    runId: string;
    leaseToken: string;
    attempt: SellerVoiceTranscriptionAttempt;
  }): Promise<boolean>;
}

/**
 * The voice-only part of a checkpoint. `resolveSellerContext` produces these and the
 * caller decides whether to write them through immediately (a resumed run already has
 * `identified`) or BUFFER them into the same write that carries `identified`.
 */
interface SellerVoiceFragment {
  voiceAttempt?: SellerVoiceAttemptCheckpoint;
  voice?: SellerVoiceCheckpoint;
}

type PersistSellerVoice = (
  fragment: SellerVoiceFragment,
) => Promise<PipelineWorkerCheckpoint>;

/**
 * Durably reserve the one paid transcription call, or throw retryable. A no-op when
 * the voice fragment was written through to a checkpoint, because the worker's
 * existing checkpoint-driven usage gate already reserved it there.
 */
type ReserveTranscription = (
  attempt: SellerVoiceTranscriptionAttempt,
) => Promise<void>;

function voiceCheckpointStage(
  context: PipelineWorkerContext,
): "identifying" | "pricing" | "generating" | "persisting" {
  switch (context.run.stage) {
    case "pricing":
    case "generating":
    case "persisting":
      return context.run.stage;
    case "queued":
    case "identifying":
    case "completed":
      return "identifying";
  }
}

async function recordTerminalVoiceOutcome(
  context: PipelineWorkerContext,
  options: DurableVisionPipelineProcessorOptions,
  outcome: SellerContextTranscriptionResult["kind"],
  providerContacted: boolean,
): Promise<void> {
  await options.recordTerminalOutcome({
    runId: context.run.id,
    leaseToken: context.run.lease_token,
    outcome,
    providerContacted,
  });
}

function ownedStoragePath(path: string, userId: string): boolean {
  const segments = path.split("/");
  return (
    segments.length > 1 &&
    segments[0] === userId &&
    segments.every(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    )
  );
}

function assertRunDerivedPhotos(context: PipelineWorkerContext): void {
  if (
    context.item.user_id !== context.run.user_id ||
    context.item.id !== context.run.item_id ||
    context.item.photos.length === 0 ||
    context.item.photos.length > 5 ||
    context.item.photos.some(
      (path) => !ownedStoragePath(path, context.run.user_id),
    )
  ) {
    throw new PipelineWorkerFailure({
      code: "invalid_run_photos",
      safeMessage: "The saved photos for this listing could not be verified.",
      retryable: false,
    });
  }
}

async function resolveSellerContext(
  context: PipelineWorkerContext,
  options: DurableVisionPipelineProcessorOptions | undefined,
  checkpoint: PipelineWorkerCheckpoint,
  persist: PersistSellerVoice,
  reserveTranscription: ReserveTranscription,
): Promise<{
  checkpoint: PipelineWorkerCheckpoint;
  sellerContext: SellerContext | undefined;
}> {
  const receipt = context.voice?.receipt;
  if (!receipt) return { checkpoint, sellerContext: undefined };
  if (
    !options ||
    context.item.user_id !== context.run.user_id ||
    context.item.id !== context.run.item_id
  ) {
    throw new PipelineWorkerFailure({
      code: "invalid_run_voice",
      safeMessage: "The saved voice note for this listing could not be verified.",
      retryable: false,
    });
  }

  const savedVoice = checkpoint.voice;
  const savedAttempt = checkpoint.voiceAttempt;
  if (
    (savedVoice &&
      (savedVoice.version !== receipt.version ||
        savedVoice.contentSha256 !== receipt.contentSha256)) ||
    (savedAttempt &&
      (savedAttempt.version !== receipt.version ||
        savedAttempt.contentSha256 !== receipt.contentSha256))
  ) {
    throw new PipelineWorkerFailure({
      code: "invalid_run_voice",
      safeMessage: "The saved voice note for this listing could not be verified.",
      retryable: false,
    });
  }
  if (savedVoice?.outcome === "transcribed") {
    await recordTerminalVoiceOutcome(
      context,
      options,
      savedVoice.outcome,
      savedVoice.providerContacted,
    );
    return { checkpoint, sellerContext: savedVoice.sellerContext };
  }
  if (savedVoice) {
    await recordTerminalVoiceOutcome(
      context,
      options,
      savedVoice.outcome,
      savedVoice.providerContacted,
    );
    return { checkpoint, sellerContext: undefined };
  }
  if (savedAttempt) {
    checkpoint = await persist({
      voice: sellerVoiceCheckpointSchema.parse({
        version: receipt.version,
        contentSha256: receipt.contentSha256,
        outcome: "failed",
        providerContacted: Boolean(savedAttempt.transcriptionAttempt),
        sellerContext: null,
        ...(savedAttempt.transcriptionAttempt
          ? { transcriptionAttempt: savedAttempt.transcriptionAttempt }
          : {}),
      }),
    });
    await recordTerminalVoiceOutcome(
      context,
      options,
      "failed",
      Boolean(savedAttempt.transcriptionAttempt),
    );
    return { checkpoint, sellerContext: undefined };
  }

  checkpoint = await persist({
    voiceAttempt: sellerVoiceAttemptCheckpointSchema.parse({
      version: receipt.version,
      contentSha256: receipt.contentSha256,
    }),
  });

  const failOpen = async () => {
    checkpoint = await persist({
      voice: sellerVoiceCheckpointSchema.parse({
        version: receipt.version,
        contentSha256: receipt.contentSha256,
        outcome: "failed",
        providerContacted: false,
        sellerContext: null,
      }),
    });
    await recordTerminalVoiceOutcome(context, options, "failed", false);
    return { checkpoint, sellerContext: undefined };
  };

  if (!ownedStoragePath(receipt.storagePath, context.run.user_id)) {
    return failOpen();
  }

  let bytes: Uint8Array;
  try {
    bytes = await options.voiceStorage.download({ path: receipt.storagePath });
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (
      receipt.mediaType !== "audio/wav" ||
      bytes.byteLength !== receipt.byteLength ||
      bytes.byteLength > 524_288 ||
      digest !== receipt.contentSha256 ||
      mobileSubmissionVoiceDurationMs(bytes) !== receipt.durationMs
    ) {
      return failOpen();
    }
  } catch {
    return failOpen();
  }

  const reservedTranscriptionAttempt = options.transcriber.transcriptionAttempt;
  if (reservedTranscriptionAttempt) {
    checkpoint = await persist({
      voiceAttempt: sellerVoiceAttemptCheckpointSchema.parse({
        version: receipt.version,
        contentSha256: receipt.contentSha256,
        transcriptionAttempt: reservedTranscriptionAttempt,
      }),
    });
    // The fragment above is only DURABLE when it was written through. On a fresh run
    // it was buffered, so the worker's checkpoint-driven usage gate has not run and
    // the paid call still needs its own durable reservation. A refusal blocks the
    // adapter: SnapList never contacts a paid provider it could not account for.
    await reserveTranscription(reservedTranscriptionAttempt);
  }

  const result = await options.transcriber
    .transcribe({
      bytes,
      mediaType: receipt.mediaType,
      contentSha256: receipt.contentSha256,
      durationMs: receipt.durationMs,
      localeHint: receipt.locale,
      signal: new AbortController().signal,
    })
    .catch(() => ({ kind: "failed" as const, providerContacted: true }));
  const sellerContext: SellerContext | undefined =
    result.kind === "transcribed"
      ? {
          text: result.text,
          language: result.language,
          provenance: "seller_voice",
          verification: "unverified",
        }
      : undefined;
  const transcriptionAttempt = reservedTranscriptionAttempt;
  checkpoint = await persist({
    voice: sellerVoiceCheckpointSchema.parse(
      result.kind === "transcribed"
          ? {
              version: receipt.version,
              contentSha256: receipt.contentSha256,
              outcome: result.kind,
              providerContacted: result.providerContacted,
              sellerContext,
              ...(transcriptionAttempt ? { transcriptionAttempt } : {}),
            }
          : {
              version: receipt.version,
              contentSha256: receipt.contentSha256,
              outcome: result.kind,
              providerContacted: result.providerContacted,
              sellerContext: null,
              ...(transcriptionAttempt ? { transcriptionAttempt } : {}),
            },
    ),
  });
  await recordTerminalVoiceOutcome(
    context,
    options,
    result.kind,
    result.providerContacted,
  );
  return { checkpoint, sellerContext };
}

export function createDurableVisionPipelineProcessor(
  stages: VisionPipelineStages,
  options?: DurableVisionPipelineProcessorOptions,
): DurablePipelineProcessor {
  return {
    async process({ context, onCheckpoint }): Promise<PipelineResult> {
      assertRunDerivedPhotos(context);
      let checkpoint: PipelineWorkerCheckpoint =
        pipelineWorkerCheckpointSchema.parse(context.run.checkpoint);

      // Voice resolves BEFORE identification (#1120). The seller's own words are an
      // unverified identity HINT to the vision call, so transcribing after it would
      // leave the hint permanently unreachable — which is exactly how an unmistakable
      // Apple AirPods Pro reached review with a null brand/model and a generic price.
      // `resolveSellerContext` reads nothing from the identification checkpoint, so
      // the move is order-only: a resumed run with a saved identification still skips
      // re-identifying, and every voice outcome/redelivery path is unchanged.
      // A run that already has an identification checkpoint writes its voice
      // fragments through immediately, exactly as before. A FRESH run cannot: the
      // transcript must reach identification, and `checkpoint_pipeline_run` refuses
      // any checkpoint without `identified` (22023). So its fragments are BUFFERED
      // and land in the same write that carries `identified` (#1120 P0).
      const writesVoiceThrough = checkpoint.identified !== undefined;
      let bufferedVoice: SellerVoiceFragment = {};

      // Threaded across fragments: voice resolution writes an attempt and then a
      // terminal outcome, and the second must build on the first. Spreading the
      // enclosing `checkpoint` each time would silently drop the attempt.
      let voiceCheckpoint = checkpoint;
      const persistSellerVoice: PersistSellerVoice = async (fragment) => {
        if (writesVoiceThrough) {
          const candidate = pipelineWorkerCheckpointWriteSchema.parse({
            ...voiceCheckpoint,
            ...fragment,
          });
          voiceCheckpoint = pipelineWorkerCheckpointSchema.parse(
            await onCheckpoint(voiceCheckpointStage(context), candidate),
          );
          return voiceCheckpoint;
        }
        bufferedVoice = { ...bufferedVoice, ...fragment };
        // An in-flight value, deliberately NOT schema-parsed: voice without
        // `identified` is exactly what the schema (and the RPC) forbid persisting.
        // It becomes a valid checkpoint when merged with `identified` below.
        voiceCheckpoint = {
          ...checkpoint,
          ...bufferedVoice,
        } as PipelineWorkerCheckpoint;
        return voiceCheckpoint;
      };

      const reserveTranscription: ReserveTranscription = async (attempt) => {
        // Written through: the worker's checkpoint-driven usage gate already
        // reserved this call before the adapter could run.
        if (writesVoiceThrough || !options?.reserveTranscription) return;
        const reserved = await options.reserveTranscription({
          runId: context.run.id,
          leaseToken: context.run.lease_token,
          attempt,
        });
        if (!reserved) {
          throw new PipelineWorkerFailure({
            code: "provider_usage_temporarily_unavailable",
            safeMessage:
              "SnapList could not finish this listing yet and will retry automatically.",
            retryable: true,
          });
        }
      };

      const voice = await resolveSellerContext(
        context,
        options,
        checkpoint,
        persistSellerVoice,
        reserveTranscription,
      );
      checkpoint = voice.checkpoint;
      const sellerContext = voice.sellerContext;

      if (!checkpoint.identified) {
        const identified = await stages.identify({
          photos: context.item.photos,
          // Omitted entirely when no transcript survived, so the photos-only path is
          // byte-for-byte what it was (PRD: voice failure degrades to photos-only).
          ...(sellerContext ? { sellerContext } : {}),
        });
        // ONE write carrying identification and every buffered voice fragment. This
        // is the first checkpoint a fresh voice run persists, and it satisfies the
        // RPC's `identified` precondition by construction.
        const candidate = pipelineWorkerCheckpointWriteSchema.parse({
          ...checkpoint,
          ...bufferedVoice,
          identified,
        });
        checkpoint = pipelineWorkerCheckpointSchema.parse(
          await onCheckpoint("identifying", candidate),
        );
      }
      const identified = checkpoint.identified;
      if (!identified) {
        throw new PipelineWorkerFailure({
          code: "invalid_checkpoint",
          safeMessage: "The saved identification checkpoint is incomplete.",
          retryable: false,
        });
      }
      const voiceBinding = context.voice?.receipt && checkpoint.voice
        ? {
            version: checkpoint.voice.version,
            contentSha256: checkpoint.voice.contentSha256,
            outcome: checkpoint.voice.outcome,
          }
        : undefined;

      if (!checkpoint.priced) {
        const priced = await stages.price({
          attributes: identified.attributes,
          // The same unverified hint the vision call received (#1120). The tier the
          // router picks, the sold query, and the confidence composite are unaffected.
          ...(sellerContext ? { sellerContext } : {}),
        });
        const candidate = pipelineWorkerCheckpointWriteSchema.parse({
          ...checkpoint,
          priced: {
            result: priced,
          },
        });
        checkpoint = pipelineWorkerCheckpointSchema.parse(
          await onCheckpoint("pricing", candidate),
        );
      }
      const priced = checkpoint.priced;

      let generated = voiceBinding
        ? checkpoint.voiceGenerations?.find(
            (entry) =>
              entry.voice.version === voiceBinding.version &&
              entry.voice.contentSha256 === voiceBinding.contentSha256 &&
              entry.voice.outcome === voiceBinding.outcome,
          )?.generated
        : checkpoint.generated;

      if (!generated) {
        const nextGenerated = await stages.generate({
          attributes: identified.attributes,
          ...(sellerContext ? { sellerContext } : {}),
        });
        const candidate = pipelineWorkerCheckpointWriteSchema.parse({
          ...checkpoint,
          generated: checkpoint.generated ?? nextGenerated,
          ...(voiceBinding
            ? {
                voiceGenerations: [
                  ...(checkpoint.voiceGenerations ?? []),
                  { voice: voiceBinding, generated: nextGenerated },
                ],
              }
            : {}),
        });
        checkpoint = pipelineWorkerCheckpointSchema.parse(
          await onCheckpoint(
            context.run.stage === "persisting" ? "persisting" : "generating",
            candidate,
          ),
        );
        generated = voiceBinding
          ? checkpoint.voiceGenerations?.find(
              (entry) =>
                entry.voice.version === voiceBinding.version &&
                entry.voice.contentSha256 === voiceBinding.contentSha256 &&
                entry.voice.outcome === voiceBinding.outcome,
            )?.generated
          : checkpoint.generated;
      }

      if (!priced || !generated) {
        throw new PipelineWorkerFailure({
          code: "invalid_checkpoint",
          safeMessage: "The saved processing checkpoint is incomplete.",
          retryable: false,
        });
      }

      return stages.assemble({
        identified,
        price: priced.result,
        generated,
        autopilotEnabled: context.run.autopilot_enabled,
      });
    },
  };
}
