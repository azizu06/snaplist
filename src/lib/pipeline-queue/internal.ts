import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createGuestRecoveryRegistrationProducer } from "@/lib/guest-recovery/producer";
import { parseGuestRecoveryProducerEncryptionConfig } from "@/lib/guest-recovery/photo-encryption";
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
  createPipelineVoiceCapability,
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
  const voice = createPipelineVoiceCapability(admin.storage);
  const recoveryEncryption = parseGuestRecoveryProducerEncryptionConfig({
    encodedKey: process.env.GUEST_RECOVERY_ENCRYPTION_KEY,
    keyId: process.env.GUEST_RECOVERY_ENCRYPTION_KEY_ID,
  });
  const recoveryBucket = admin.storage.from("photos");
  const guestRecovery = createGuestRecoveryRegistrationProducer({
    ...recoveryEncryption,
    storage: {
      async download(path) {
        const { data, error } = await recoveryBucket.download(path);
        if (error) throw error;
        return {
          bytes: new Uint8Array(await data.arrayBuffer()),
          mediaType: data.type,
        };
      },
      async upload(path, bytes) {
        const { error } = await recoveryBucket.upload(path, bytes, {
          contentType: "application/octet-stream",
          upsert: false,
        });
        if (error) throw error;
      },
    },
  });

  return {
    queue: createSupabasePgmqPipelineQueue(queueRpc),
    runs: createSupabasePipelineWorkerStore(workerRpc),
    photos,
    voice,
    guestRecovery,
  };
}

/** Protected composition root: the route receives one bounded operation only. */
export function createInternalPipelineWorker(): PipelineWorker {
  return createPipelineWorker({
    capabilities: createInternalPipelineWorkerCapabilities(),
  });
}
