import type { SupabaseClient } from "@supabase/supabase-js";
import {
  decryptSecret,
  encryptSecret,
  parseEncryptionKey,
} from "../../crypto/secretbox";
import type { EbayIdentity, EbayTokenGrant } from "./oauth";

/**
 * The ebay_connections store (issue #17): per-user eBay OAuth tokens,
 * encrypted before they ever reach Postgres. This module is the only place
 * that touches the ciphertext columns, so the encrypt/decrypt seam stays in
 * one file.
 *
 * Tenancy: foreground persistence uses the seller's Clerk/RLS client, with a
 * tenant-bound server client only for generation-checked completion. Scheduled
 * work and account erasure use narrowly scoped RPCs pinned to an explicit
 * tenant and marketplace identity; service-role callers never query rows raw.
 */

export interface EbayConnectionStatus {
  connected: boolean;
  ebayUsername: string | null;
}

interface ConnectionRow {
  user_id: string;
  account_generation: string;
  ebay_user_id: string | null;
  ebay_username: string | null;
  refresh_token_enc: string;
  access_token_enc: string | null;
  access_token_expires_at: string | null;
  scopes: string[];
}

type Env = Record<string, string | undefined>;

/** What the Settings card shows. Never returns token material. */
export async function getEbayConnectionStatus(
  supabase: SupabaseClient,
  userId?: string,
  scheduled = false,
): Promise<EbayConnectionStatus> {
  if (scheduled) {
    if (!userId) throw new Error("A scheduled eBay connection read needs a tenant");
    const { data, error } = await supabase.rpc("read_scheduled_ebay_connection", {
      p_user_id: userId,
    });
    if (error) throw new Error(`Failed to read eBay connection: ${error.message}`);
    const row = data as Pick<ConnectionRow, "ebay_username"> | null;
    return row
      ? { connected: true, ebayUsername: row.ebay_username ?? null }
      : { connected: false, ebayUsername: null };
  }
  let query = supabase
    .from("ebay_connections")
    .select("ebay_username");
  if (userId) query = query.eq("user_id", userId);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`Failed to read eBay connection: ${error.message}`);
  return data
    ? { connected: true, ebayUsername: data.ebay_username ?? null }
    : { connected: false, ebayUsername: null };
}

/** Persist a fresh grant through the tenant-derived database seam. */
export async function saveEbayConnection(
  supabase: SupabaseClient,
  grant: EbayTokenGrant,
  identity: EbayIdentity | null,
  env: Env = process.env,
): Promise<void> {
  const key = parseEncryptionKey(env.EBAY_TOKEN_ENCRYPTION_KEY);
  const { error } = await supabase.rpc("save_ebay_connection", {
    p_ebay_user_id: identity?.userId ?? null,
    p_ebay_username: identity?.username ?? null,
    p_refresh_token_enc: encryptSecret(grant.refreshToken, key),
    p_access_token_enc: encryptSecret(grant.accessToken, key),
    p_access_token_expires_at: new Date(
      grant.accessTokenExpiresAt,
    ).toISOString(),
    p_scopes: grant.scopes,
  });
  if (error) throw new Error(`Failed to save eBay connection: ${error.message}`);
}

export async function deleteEbayConnection(
  supabase: SupabaseClient,
): Promise<void> {
  const { error } = await supabase.rpc("disconnect_ebay_connection");
  if (error) throw new Error(`Failed to disconnect eBay: ${error.message}`);
}

/**
 * Decrypted token view for the token provider. Internal to the adapter —
 * never crosses an API boundary.
 */
export interface DecryptedConnection {
  userId: string;
  accountGeneration: string;
  refreshToken: string;
  accessToken: string | null;
  /** Epoch ms, null when no cached access token. */
  accessTokenExpiresAt: number | null;
  scopes: string[];
}

export async function getDecryptedConnection(
  supabase: SupabaseClient,
  env: Env = process.env,
  userId?: string,
  scheduled = false,
): Promise<DecryptedConnection | null> {
  let data: ConnectionRow | null;
  let error: { message: string } | null;
  if (scheduled) {
    if (!userId) throw new Error("A scheduled eBay connection read needs a tenant");
    const result = await supabase.rpc("read_scheduled_ebay_connection", {
      p_user_id: userId,
    });
    data = result.data as ConnectionRow | null;
    error = result.error;
  } else {
    let query = supabase
      .from("ebay_connections")
      .select(
        "user_id, account_generation, ebay_user_id, ebay_username, refresh_token_enc, access_token_enc, access_token_expires_at, scopes",
      );
    if (userId) query = query.eq("user_id", userId);
    const result = await query.maybeSingle<ConnectionRow>();
    data = result.data;
    error = result.error;
  }
  if (error) throw new Error(`Failed to read eBay connection: ${error.message}`);
  if (!data) return null;

  const key = parseEncryptionKey(env.EBAY_TOKEN_ENCRYPTION_KEY);
  return {
    userId: data.user_id,
    accountGeneration: data.account_generation,
    refreshToken: decryptSecret(data.refresh_token_enc, key),
    accessToken: data.access_token_enc
      ? decryptSecret(data.access_token_enc, key)
      : null,
    accessTokenExpiresAt: data.access_token_expires_at
      ? Date.parse(data.access_token_expires_at)
      : null,
    scopes: data.scopes ?? [],
  };
}

/** Cache a refreshed access token back onto the row (encrypting it). */
export async function updateCachedAccessToken(
  supabase: SupabaseClient,
  userId: string,
  accountGeneration: string,
  accessToken: string,
  expiresAt: number,
  env: Env = process.env,
  scheduled = false,
): Promise<void> {
  const key = parseEncryptionKey(env.EBAY_TOKEN_ENCRYPTION_KEY);
  const payload = {
    p_account_generation: accountGeneration,
    p_access_token_enc: encryptSecret(accessToken, key),
    p_access_token_expires_at: new Date(expiresAt).toISOString(),
  };
  const { error } = scheduled
    ? await supabase.rpc("update_scheduled_ebay_access_token_cache", {
        p_user_id: userId,
        ...payload,
      })
    : await supabase.rpc("update_ebay_access_token_cache", payload);
  if (error) {
    throw new Error(`Failed to cache refreshed eBay access token: ${error.message}`);
  }
}

export async function beginEbayProviderDispatch(
  supabase: SupabaseClient,
  resourceId: string,
  operation: "publish" | "reprice",
  scheduled = false,
): Promise<{
  accountGeneration: string;
  attemptToken: string;
  userId?: string;
}> {
  const { data, error } = await supabase.rpc(
    scheduled
      ? "begin_scheduled_ebay_transactional_dispatch"
      : "begin_ebay_transactional_dispatch",
    {
      p_resource_id: resourceId,
      p_operation: operation,
    },
  );
  if (error) throw new Error(`Failed to begin eBay provider dispatch: ${error.message}`);
  const lease = data as {
    account_generation?: unknown;
    attempt_token?: unknown;
    user_id?: unknown;
  } | null;
  if (
    typeof lease?.account_generation !== "string" ||
    typeof lease.attempt_token !== "string"
  ) {
    throw new Error("Failed to begin eBay provider dispatch: invalid lease");
  }
  return {
    accountGeneration: lease.account_generation,
    attemptToken: lease.attempt_token,
    userId: typeof lease.user_id === "string" ? lease.user_id : undefined,
  };
}

export async function renewEbayProviderDispatch(
  supabase: SupabaseClient,
  resourceId: string,
  operation: "publish" | "reprice",
  accountGeneration: string,
  attemptToken: string,
  scheduled = false,
): Promise<void> {
  const { error } = await supabase.rpc(
    scheduled
      ? "renew_scheduled_ebay_transactional_dispatch"
      : "renew_ebay_transactional_dispatch",
    {
      p_resource_id: resourceId,
      p_operation: operation,
      p_account_generation: accountGeneration,
      p_attempt_token: attemptToken,
    },
  );
  if (error) throw new Error(`Failed to renew eBay provider dispatch: ${error.message}`);
}

export async function endEbayProviderDispatch(
  supabase: SupabaseClient,
  resourceId: string,
  operation: "publish" | "reprice",
  accountGeneration: string,
  attemptToken: string,
  scheduled = false,
): Promise<void> {
  const { error } = await supabase.rpc(
    scheduled
      ? "end_scheduled_ebay_transactional_dispatch"
      : "end_ebay_transactional_dispatch",
    {
      p_resource_id: resourceId,
      p_operation: operation,
      p_account_generation: accountGeneration,
      p_attempt_token: attemptToken,
    },
  );
  if (error) throw new Error(`Failed to end eBay provider dispatch: ${error.message}`);
}

export async function bindEbaySandboxFallback(
  supabase: SupabaseClient,
  userId: string,
  sellerId: string,
  scheduled: boolean,
): Promise<string> {
  const { data, error } = scheduled
    ? await supabase.rpc("bind_scheduled_ebay_sandbox_fallback", {
        p_user_id: userId,
        p_seller_id: sellerId,
      })
    : await supabase.rpc("bind_ebay_sandbox_fallback", {
        p_seller_id: sellerId,
      });
  if (error) throw new Error(`Failed to bind eBay Sandbox fallback: ${error.message}`);
  if (typeof data !== "string") {
    throw new Error("Failed to bind eBay Sandbox fallback: invalid generation");
  }
  return data;
}

export async function listScheduledEbayConnectionUserIds(
  supabase: SupabaseClient,
): Promise<string[]> {
  const { data, error } = await supabase.rpc(
    "list_scheduled_ebay_connection_user_ids",
  );
  if (error) {
    throw new Error(`Failed to list eBay connections: ${error.message}`);
  }
  return (data ?? []).flatMap((row: unknown) => {
    if (typeof row === "string") return [row];
    if (
      row &&
      typeof row === "object" &&
      typeof (row as { user_id?: unknown }).user_id === "string"
    ) {
      return [(row as { user_id: string }).user_id];
    }
    return [];
  });
}

/**
 * Erase everything held about an eBay user (Marketplace Account Deletion).
 * Runs on the SERVICE-ROLE client in one database transaction. Returns how
 * many tenant data sets matched the deleted identity (0 is idempotent).
 */
export async function eraseEbayUserData(
  serviceClient: SupabaseClient,
  ebayUserId: string | undefined,
  ebayUsername: string | undefined,
): Promise<number> {
  await eraseEbayMessagePhotoObjects(
    serviceClient,
    [ebayUserId, ebayUsername].filter((value): value is string => Boolean(value)),
  );
  const { data, error } = await serviceClient.rpc("erase_ebay_user_data", {
    p_ebay_user_id: ebayUserId ?? null,
    p_ebay_username: ebayUsername ?? null,
  });
  if (error) throw new Error(`Deletion erase failed: ${error.message}`);
  if (typeof data !== "number") {
    throw new Error("Deletion erase failed: database returned an invalid result");
  }
  return data;
}

async function eraseEbayMessagePhotoObjects(
  serviceClient: SupabaseClient,
  identities: string[],
): Promise<void> {
  if (!identities.length) return;
  const sellerUserIds = new Set<string>();
  for (const identity of identities) {
    for (const column of ["ebay_user_id", "ebay_username"] as const) {
      const { data, error } = await serviceClient
        .from("ebay_connections")
        .select("user_id")
        .eq(column, identity);
      if (error) throw new Error(`Deletion photo lookup failed: ${error.message}`);
      for (const row of data ?? []) sellerUserIds.add(row.user_id as string);
    }
  }
  const roots = new Set<string>();
  if (sellerUserIds.size) {
    const { data, error } = await serviceClient
      .from("messages")
      .select("id")
      .eq("marketplace", "ebay")
      .eq("direction", "inbound")
      .in("user_id", [...sellerUserIds]);
    if (error) throw new Error(`Deletion photo lookup failed: ${error.message}`);
    for (const row of data ?? []) roots.add(row.id as string);
  }
  for (const identity of identities) {
    const { data, error } = await serviceClient
      .from("messages")
      .select("id")
      .eq("marketplace", "ebay")
      .eq("direction", "inbound")
      .eq("external_buyer_id", identity);
    if (error) throw new Error(`Deletion photo lookup failed: ${error.message}`);
    for (const row of data ?? []) roots.add(row.id as string);
  }
  if (!roots.size) return;
  const { data, error } = await serviceClient
    .from("message_attachments")
    .select("storage_path")
    .in("conversation_root_id", [...roots])
    .not("storage_path", "is", null);
  if (error) throw new Error(`Deletion photo lookup failed: ${error.message}`);
  const paths = (data ?? []).flatMap((row) =>
    typeof row.storage_path === "string" ? [row.storage_path] : [],
  );
  if (!paths.length) return;
  const removed = await serviceClient.storage.from("message-photos").remove(paths);
  if (removed.error) {
    throw new Error(`Deletion photo erase failed: ${removed.error.message}`);
  }
}
