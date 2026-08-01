import "server-only";

import { createClient } from "@supabase/supabase-js";
import { eraseAccount } from "./service";
import { createSupabaseAccountErasureStore } from "./store";

export interface ConfiguredAccountErasureInput {
  supabaseURL: string;
  secretKey: string;
}

export function createConfiguredAccountErasureOperations(
  input: ConfiguredAccountErasureInput,
): { erase: (request: { userId: string; idempotencyKey: string }) => ReturnType<typeof eraseAccount> } {
  if (!input.secretKey.startsWith("sb_secret_")) {
    throw new Error("Account erasure requires a current Supabase secret key.");
  }

  const client = createClient(input.supabaseURL, input.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const dependencies = {
    store: createSupabaseAccountErasureStore(client),
    storage: {
      async remove(object: { bucketId: "photos" | "message-photos"; objectName: string }) {
        const { error } = await client.storage
          .from(object.bucketId)
          .remove([object.objectName]);
        if (error) throw error;
      },
    },
    // ADR-0012 leaves these provider/legal dispositions unresolved. A future
    // authority may replace this capability only after that contract changes.
    dispositions: {
      async resolvedBlockers() {
        return [];
      },
    },
  };

  return {
    erase(request) {
      return eraseAccount(request, dependencies);
    },
  };
}
