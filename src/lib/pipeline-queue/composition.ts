import {
  PHOTOS_BUCKET,
  createVisionPipelineStages,
  type DownloadClient,
  type VisionPipelineStages,
} from "@/lib/vision";
import type { GuestRecoveryRegistrationProducer } from "@/lib/guest-recovery/producer";
import { createDurableVisionPipelineProcessor } from "./durable-processor";
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
  consumerOptions?: ConsumerOptions;
}): PipelineWorker {
  const createStages = input.createStages ?? createVisionPipelineStages;
  const processor = createDurableVisionPipelineProcessor(
    createStages({ supabase: input.capabilities.photos }),
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
