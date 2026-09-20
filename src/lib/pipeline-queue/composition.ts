import {
  PHOTOS_BUCKET,
  createVisionPipelineStages,
  type DownloadClient,
  type VisionPipelineStages,
} from "@/lib/vision";
import type { GuestRecoveryRegistrationProducer } from "@/lib/guest-recovery/producer";
import type { SellerPushDispatcher } from "@/lib/push-notifications";
import {
  createRoleKeyedSellerContextTranscriptionModel,
  resolveSellerContextTranscriber,
  type SellerContextTranscriber,
} from "@/lib/llm/seller-context";
import {
  createDurableVisionPipelineProcessor,
  type PipelineVoiceStorage,
} from "./durable-processor";
import type { PipelineQueue } from "./queue";
import type { PipelineWorkerStore } from "./worker-store";
import {
  checkpointTranscriptionAttemptUsage,
  consumePipelineQueue,
  type PipelineConsumerSummary,
} from "./worker";

export interface PipelineWorkerCapabilities {
  queue: PipelineQueue;
  runs: PipelineWorkerStore;
  photos: DownloadClient;
  voice: PipelineVoiceStorage;
  guestRecovery: GuestRecoveryRegistrationProducer;
  /**
   * Tells the seller their listing is ready (#891). Optional at this seam
   * because a runtime adapter under test composes its own capabilities; the
   * server composition root always supplies one, and a missing credential
   * fails there loudly rather than producing a dispatcher that sends nothing.
   */
  push?: SellerPushDispatcher;
}

export interface PipelineWorker {
  consume(): Promise<PipelineConsumerSummary>;
}

type ConsumerOptions = NonNullable<
  Parameters<typeof consumePipelineQueue>[1]
>;

/**
 * Runtime-neutral composition root for the existing durable pipeline worker.
 *
 * A runtime adapter may provide Supabase/PGMQ capabilities, but the consumer
 * still receives only the narrow queue, run-scoped RPC, and photo-download
 * interfaces defined by ADR-0007. No Next.js request type or generic database
 * client crosses this seam.
 */
export function createPipelineWorker(input: {
  capabilities: PipelineWorkerCapabilities;
  createStages?: (input: { supabase: DownloadClient }) => VisionPipelineStages;
  transcriber?: SellerContextTranscriber;
  consumerOptions?: ConsumerOptions;
}): PipelineWorker {
  const createStages = input.createStages ?? createVisionPipelineStages;
  const processor = createDurableVisionPipelineProcessor(
    createStages({ supabase: input.capabilities.photos }),
    {
      voiceStorage: input.capabilities.voice,
      transcriber:
        input.transcriber ??
        resolveSellerContextTranscriber({
          model: createRoleKeyedSellerContextTranscriptionModel(),
        }),
      recordTerminalOutcome: (outcome) =>
        input.capabilities.runs.recordVoiceOutcome(outcome),
      // A fresh voice run transcribes BEFORE it identifies, so it has no checkpoint
      // to carry the reservation — `checkpoint_pipeline_run` refuses a checkpoint
      // without `identified` (#1120 P0). Reserve the paid call directly instead;
      // `record_pipeline_run_provider_usage` merges a transcription-only entry
      // idempotently and in either order, so a replay cannot double-count it. A
      // false return blocks the adapter.
      //
      // KNOWN LIMIT (#1120 round 3): this reservation runs before EVERY paid
      // transcription, so the client reports every paid call — but the durable
      // receipt cannot hold more than one. The RPC accepts a transcription-only
      // record only when `calls = '1'` (migration 20260811120000), and a repeat
      // of the identical record is an idempotent replay, which is what makes
      // redelivery safe. A run that loses its combined checkpoint and
      // re-transcribes therefore pays twice and records `calls: 1`. Counting
      // truly means relaxing that invariant: a schema change, out of scope here.
      // The under-count is bounded by `pipeline_runs.max_attempts`, and no
      // credit, price, or seller-facing value reads this field.
      reserveTranscription: async ({ runId, leaseToken, attempt }) => {
        const usage = checkpointTranscriptionAttemptUsage(attempt);
        if (!usage) return false;
        try {
          await input.capabilities.runs.recordProviderUsage({
            runId,
            leaseToken,
            usage,
          });
          return true;
        } catch {
          // The rejection concerns a run whose transcript is in flight, so its
          // message is not ours to repeat (see `log-safe-error`). Refusing is the
          // whole signal the caller needs: it blocks the paid call and retries.
          return false;
        }
      },
    },
  );

  return {
    consume: () =>
      consumePipelineQueue(
        {
          queue: input.capabilities.queue,
          runs: input.capabilities.runs,
          processor,
          guestRecovery: input.capabilities.guestRecovery,
          push: input.capabilities.push,
        },
        input.consumerOptions,
      ),
  };
}

/** Restricts a storage adapter to the one private bucket the worker may read. */
export function createPipelinePhotoCapability(input: {
  from(bucket: string): {
    download(path: string): PromiseLike<{ data: Blob | null; error: { message: string } | null }>;
  };
}): DownloadClient {
  return {
    storage: {
      from(bucket) {
        if (bucket !== PHOTOS_BUCKET) {
          throw new Error("Pipeline worker may access only the private photos bucket");
        }
        const store = input.from(PHOTOS_BUCKET);
        return {
          async download(path) {
            return store.download(path);
          },
        };
      },
    },
  };
}

/** One-bucket, one-path read capability for accepted temporary voice bytes. */
export function createPipelineVoiceCapability(input: {
  from(bucket: string): {
    download(path: string): PromiseLike<{
      data: Blob | null;
      error: { message: string } | null;
    }>;
  };
}): PipelineVoiceStorage {
  return {
    async download({ path }) {
      const store = input.from(PHOTOS_BUCKET);
      const { data, error } = await store.download(path);
      if (error || !data) {
        throw new Error(error?.message ?? "Accepted seller voice was not found");
      }
      return new Uint8Array(await data.arrayBuffer());
    },
  };
}
