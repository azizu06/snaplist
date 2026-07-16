import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  createSupabasePgmqPipelineQueue,
  type PipelineQueueRpcClient,
} from "./supabase-pgmq";
import {
  createSupabasePipelineWorkerStore,
  type PipelineWorkerRpcClient,
} from "./worker-store";
import {
  createPipelinePhotoCapability,
  createPipelineWorker,
  type PipelineWorker,
  type PipelineWorkerCapabilities,
} from "./composition";

/**
 * Server-only composition root for the background worker. The privileged
 * Supabase client is enclosed here and never returned; pipeline code receives
 * only fixed queue and run-scoped RPC capabilities with no generic `.from()`.
 */
export function createInternalPipelineWorkerCapabilities(): PipelineWorkerCapabilities {
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
  const photos = createPipelinePhotoCapability(admin.storage);

  return {
    queue: createSupabasePgmqPipelineQueue(queueRpc),
    runs: createSupabasePipelineWorkerStore(workerRpc),
    photos,
  };
}

/** Protected composition root: the route receives one bounded operation only. */
export function createInternalPipelineWorker(): PipelineWorker {
  return createPipelineWorker({
    capabilities: createInternalPipelineWorkerCapabilities(),
  });
}
