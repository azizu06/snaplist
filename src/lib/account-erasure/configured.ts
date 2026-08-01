import "server-only";

import { createClerkClient } from "@clerk/nextjs/server";
import { createClient } from "@supabase/supabase-js";
import { createAccountErasureIdentity } from "./identity";
import { eraseAccount } from "./service";
import { createSupabaseAccountErasureStore } from "./store";

export interface ConfiguredAccountErasureInput {
  supabaseURL: string;
  secretKey: string;
  clerkSecretKey: string;
  revenueCatSecretKey: string;
  /**
   * Without it the RevenueCat absence read-back cannot run, and every erasure
   * holding a RevenueCat binding resolves to `deletion_needs_attention` rather
   * than claiming a deletion it did not witness. See identity.ts.
   */
  revenueCatProjectId?: string;
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
    identity: createAccountErasureIdentity({
      clerk: createClerkClient({ secretKey: input.clerkSecretKey }),
      revenueCat: {
        secretKey: input.revenueCatSecretKey,
        projectId: input.revenueCatProjectId,
      },
    }),
  };

  return {
    erase(request) {
      return eraseAccount(request, dependencies);
    },
  };
}
