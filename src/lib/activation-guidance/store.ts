import { createClient } from "@supabase/supabase-js";

export interface ActivationGuidanceCompletionStore {
  isCompleted(input: { bearerToken: string; userId: string }): Promise<boolean>;
  complete(input: { bearerToken: string; userId: string }): Promise<void>;
}

interface ActivationGuidanceInsertResult {
  error: { code?: string; message: string } | null;
}

interface ActivationGuidanceTable {
  select(columns: "user_id"): {
    eq(column: "user_id", value: string): {
      maybeSingle(): PromiseLike<{
        data: { user_id: string } | null;
        error: { message: string } | null;
      }>;
    };
  };
  insert(values: { user_id: string }): PromiseLike<ActivationGuidanceInsertResult>;
}

export interface ActivationGuidanceDatabaseClient {
  from(table: "activation_guidance_completions"): ActivationGuidanceTable;
}

/**
 * The caller builds this client with the verified seller bearer. The database
 * policy remains the authority binding a completion row to that Clerk subject.
 */
export function createSupabaseActivationGuidanceStore(
  clientForBearer: (bearerToken: string) => ActivationGuidanceDatabaseClient,
): ActivationGuidanceCompletionStore {
  return {
    async isCompleted({ bearerToken, userId }) {
      const { data, error } = await clientForBearer(bearerToken)
        .from("activation_guidance_completions")
        .select("user_id")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) {
        throw new Error(`Activation guidance completion read failed: ${error.message}`);
      }
      return data !== null;
    },
    async complete({ bearerToken, userId }) {
      const { error } = await clientForBearer(bearerToken)
        .from("activation_guidance_completions")
        .insert({ user_id: userId });
      // The row is a monotonic marker. A retry after a response loss has already
      // completed the same seller's activation and is therefore success.
      if (error && error.code !== "23505") {
        throw new Error(`Activation guidance completion failed: ${error.message}`);
      }
    },
  };
}

export function createConfiguredSupabaseActivationGuidanceStore(input: {
  anonKey: string;
  supabaseURL: string;
}): ActivationGuidanceCompletionStore {
  return createSupabaseActivationGuidanceStore((bearerToken) =>
    createClient(input.supabaseURL, input.anonKey, {
      accessToken: async () => bearerToken,
      auth: { autoRefreshToken: false, persistSession: false },
    }) as unknown as ActivationGuidanceDatabaseClient,
  );
}
