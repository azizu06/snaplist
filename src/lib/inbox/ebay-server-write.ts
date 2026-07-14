import type { SupabaseClient } from "@supabase/supabase-js";

function requireGeneration(data: unknown): string {
  if (typeof data !== "string" || data.length === 0) {
    throw new Error("Failed to begin eBay message write: invalid account generation");
  }
  return data;
}

export async function beginEbayMessageWrite(
  supabase: SupabaseClient,
): Promise<string> {
  const { data, error } = await supabase.rpc("begin_ebay_message_write");
  if (error) {
    throw new Error(`Failed to begin eBay message write: ${error.message}`);
  }
  return requireGeneration(data);
}

export async function beginScheduledEbayMessageWrite(
  supabase: SupabaseClient,
  userId: string,
): Promise<string> {
  const { data, error } = await supabase.rpc(
    "begin_scheduled_ebay_message_write",
    { p_user_id: userId },
  );
  if (error) {
    throw new Error(`Failed to begin scheduled eBay message write: ${error.message}`);
  }
  return requireGeneration(data);
}

export async function applyEbayMessageWrite<T>(
  supabase: SupabaseClient,
  operation: string,
  payload: Record<string, unknown>,
  generation: string,
): Promise<T> {
  const { data, error } = await supabase.rpc("apply_ebay_message_write", {
    p_operation: operation,
    p_payload: payload,
    p_generation: generation,
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
  payload: Record<string, unknown>,
  generation: string,
): Promise<T> {
  const { data, error } = await supabase.rpc(
    "apply_scheduled_ebay_message_write",
    {
      p_user_id: userId,
      p_operation: operation,
      p_payload: payload,
      p_generation: generation,
    },
  );
  if (error) {
    throw new Error(`Failed to apply scheduled eBay message write: ${error.message}`);
  }
  return data as T;
}

export async function readScheduledEbayInbox<T>(
  supabase: SupabaseClient,
  userId: string,
  operation: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const { data, error } = await supabase.rpc("read_scheduled_ebay_inbox", {
    p_user_id: userId,
    p_operation: operation,
    p_payload: payload,
  });
  if (error) {
    throw new Error(`Failed to read scheduled eBay inbox: ${error.message}`);
  }
  return data as T;
}
