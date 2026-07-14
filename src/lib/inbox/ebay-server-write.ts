import type { SupabaseClient } from "@supabase/supabase-js";

export async function applyEbayMessageWrite<T>(
  supabase: SupabaseClient,
  operation: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const { data, error } = await supabase.rpc("apply_ebay_message_write", {
    p_operation: operation,
    p_payload: payload,
  });
  if (error) {
    throw new Error(`Failed to apply eBay message write: ${error.message}`);
  }
  return data as T;
}

export async function applyScheduledEbayMessageWrite<T>(
  supabase: SupabaseClient,
  userId: string,
  operation: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const { data, error } = await supabase.rpc(
    "apply_scheduled_ebay_message_write",
    {
      p_user_id: userId,
      p_operation: operation,
      p_payload: payload,
    },
  );
  if (error) {
    throw new Error(`Failed to apply scheduled eBay message write: ${error.message}`);
  }
  return data as T;
}
