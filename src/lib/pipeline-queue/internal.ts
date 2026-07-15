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

export interface InternalPipelineWorkerCapabilities {
  queue: PipelineQueue;
  runs: PipelineWorkerStore;
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

  return {
    queue: createSupabasePgmqPipelineQueue(queueRpc),
    runs: createSupabasePipelineWorkerStore(workerRpc),
  };
}
