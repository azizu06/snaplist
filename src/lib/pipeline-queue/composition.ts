import {
  PHOTOS_BUCKET,
  createVisionPipelineStages,
  type DownloadClient,
  type VisionPipelineStages,
} from "@/lib/vision";
import type { GuestRecoveryRegistrationProducer } from "@/lib/guest-recovery/producer";
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
  consumePipelineQueue,
  type PipelineConsumerSummary,
} from "./worker";

export interface PipelineWorkerCapabilities {
  queue: PipelineQueue;
  runs: PipelineWorkerStore;
  photos: DownloadClient;
  voice: PipelineVoiceStorage;
  guestRecovery: GuestRecoveryRegistrationProducer;
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
