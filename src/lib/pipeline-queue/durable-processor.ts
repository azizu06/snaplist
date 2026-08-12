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
  type PipelineWorkerCheckpoint,
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
}

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
  persist: (
    checkpoint: ReturnType<typeof pipelineWorkerCheckpointWriteSchema.parse>,
  ) => Promise<PipelineWorkerCheckpoint>,
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
    checkpoint = await persist(
      pipelineWorkerCheckpointWriteSchema.parse({
        ...checkpoint,
        voice: {
          version: receipt.version,
          contentSha256: receipt.contentSha256,
          outcome: "failed",
          providerContacted: Boolean(savedAttempt.transcriptionAttempt),
          sellerContext: null,
          ...(savedAttempt.transcriptionAttempt
            ? { transcriptionAttempt: savedAttempt.transcriptionAttempt }
            : {}),
        },
      }),
    );
    await recordTerminalVoiceOutcome(
      context,
      options,
      "failed",
      Boolean(savedAttempt.transcriptionAttempt),
    );
    return { checkpoint, sellerContext: undefined };
  }

  checkpoint = await persist(
    pipelineWorkerCheckpointWriteSchema.parse({
      ...checkpoint,
      voiceAttempt: {
        version: receipt.version,
        contentSha256: receipt.contentSha256,
      },
    }),
  );

  const failOpen = async () => {
    checkpoint = await persist(
      pipelineWorkerCheckpointWriteSchema.parse({
        ...checkpoint,
        voice: {
          version: receipt.version,
          contentSha256: receipt.contentSha256,
          outcome: "failed",
          providerContacted: false,
          sellerContext: null,
        },
      }),
    );
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
    checkpoint = await persist(
      pipelineWorkerCheckpointWriteSchema.parse({
        ...checkpoint,
        voiceAttempt: {
          version: receipt.version,
          contentSha256: receipt.contentSha256,
          transcriptionAttempt: reservedTranscriptionAttempt,
        },
      }),
    );
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
  checkpoint = await persist(
    pipelineWorkerCheckpointWriteSchema.parse({
      ...checkpoint,
      voice:
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
    }),
  );
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

      if (!checkpoint.identified) {
        const identified = await stages.identify({ photos: context.item.photos });
        const candidate = pipelineWorkerCheckpointWriteSchema.parse({
          ...checkpoint,
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

      const voice = await resolveSellerContext(
        context,
        options,
        checkpoint,
        (candidate) => onCheckpoint(voiceCheckpointStage(context), candidate),
      );
      checkpoint = voice.checkpoint;
      const sellerContext = voice.sellerContext;
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
