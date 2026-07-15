import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PipelineQueue } from "./queue";
import {
  createSupabasePgmqPipelineQueue,
  type PipelineQueueRpcClient,
} from "./supabase-pgmq";
import {
  createSupabasePipelineWorkerStore,
  type PipelineWorkerRpcClient,
  type PipelineWorkerStore,
} from "./worker-store";
import { PHOTOS_BUCKET, createVisionPipelineStages, type DownloadClient } from "@/lib/vision";
import { createDurableVisionPipelineProcessor } from "./durable-processor";
import { consumePipelineQueue, type PipelineConsumerSummary } from "./worker";

export interface InternalPipelineWorkerCapabilities {
  queue: PipelineQueue;
  runs: PipelineWorkerStore;
  photos: DownloadClient;
}

/**
 * Server-only composition root for the background worker. The privileged
 * Supabase client is enclosed here and never returned; pipeline code receives
 * only fixed queue and run-scoped RPC capabilities with no generic `.from()`.
 */
export function createInternalPipelineWorkerCapabilities(): InternalPipelineWorkerCapabilities {
  const admin = createAdminClient();
  const queueRpc: PipelineQueueRpcClient = {
    async rpc(functionName, args) {
      const { data, error } = await admin.rpc(functionName, args);
      return { data, error: error ? { message: error.message } : null };
    },
  };
  const workerRpc: PipelineWorkerRpcClient = {
    async rpc(functionName, args) {
      const { data, error } = await admin.rpc(functionName, args);
      return { data, error: error ? { message: error.message } : null };
    },
  };
  const photos: DownloadClient = {
    storage: {
      from(bucket) {
        if (bucket !== PHOTOS_BUCKET) {
          throw new Error("Pipeline worker may access only the private photos bucket");
        }
        const store = admin.storage.from(PHOTOS_BUCKET);
        return {
          download(path) {
            return store.download(path);
          },
        };
      },
    },
  };

  return {
    queue: createSupabasePgmqPipelineQueue(queueRpc),
    runs: createSupabasePipelineWorkerStore(workerRpc),
    photos,
  };
}

export interface InternalPipelineWorker {
  consume(): Promise<PipelineConsumerSummary>;
}

/** Protected composition root: the route receives one bounded operation only. */
export function createInternalPipelineWorker(): InternalPipelineWorker {
  const capabilities = createInternalPipelineWorkerCapabilities();
  const processor = createDurableVisionPipelineProcessor(
    createVisionPipelineStages({ supabase: capabilities.photos }),
  );
  return {
    consume: () =>
      consumePipelineQueue({
        queue: capabilities.queue,
        runs: capabilities.runs,
        processor,
      }),
  };
}
