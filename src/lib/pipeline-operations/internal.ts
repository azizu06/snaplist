import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { runPipelineMaintenance } from "./maintenance";
import { createStorageCleanupCapability } from "./storage-cleanup";
import { createSupabasePipelineOperationsStore } from "./store";

export async function runInternalPipelineMaintenance() {
  const admin = createAdminClient();
  const store = createSupabasePipelineOperationsStore({
    async rpc(functionName, args) {
      const { data, error } = await admin.rpc(functionName, args);
      return { data, error: error ? { message: error.message } : null };
    },
  });

  return runPipelineMaintenance({
    store,
    storage: createStorageCleanupCapability(admin.storage.from("photos")),
  });
}
