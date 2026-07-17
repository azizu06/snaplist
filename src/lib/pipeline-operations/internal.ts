import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { runPipelineMaintenance } from "./maintenance";
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
    photos: {
      async remove(paths) {
        const { error } = await admin.storage.from("photos").remove(paths);
        if (error) throw new Error("Photo cleanup failed");
      },
    },
  });
}
