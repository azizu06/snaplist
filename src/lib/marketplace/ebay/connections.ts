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
 * Tenancy: callers pass the request's USER-SCOPED client for the seller's own
 * connection (RLS pins the row), and the SERVICE-ROLE client only from the
 * account-deletion endpoint (which must erase by eBay identity, not by the
 * requesting user — there is no requesting user).
 */

export interface EbayConnectionStatus {
  connected: boolean;
  ebayUsername: string | null;
}

interface ConnectionRow {
  user_id: string;
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
): Promise<EbayConnectionStatus> {
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

/** Persist a fresh grant (encrypting both tokens). Upsert: reconnecting replaces. */
export async function saveEbayConnection(
  supabase: SupabaseClient,
  userId: string,
  grant: EbayTokenGrant,
  identity: EbayIdentity | null,
  env: Env = process.env,
): Promise<void> {
  const key = parseEncryptionKey(env.EBAY_TOKEN_ENCRYPTION_KEY);
  const { error } = await supabase.from("ebay_connections").upsert({
    user_id: userId,
    ebay_user_id: identity?.userId ?? null,
    ebay_username: identity?.username ?? null,
    refresh_token_enc: encryptSecret(grant.refreshToken, key),
    access_token_enc: encryptSecret(grant.accessToken, key),
    access_token_expires_at: new Date(grant.accessTokenExpiresAt).toISOString(),
    scopes: grant.scopes,
  });
  if (error) throw new Error(`Failed to save eBay connection: ${error.message}`);
}

export async function deleteEbayConnection(
  supabase: SupabaseClient,
): Promise<void> {
  const { error } = await supabase.from("ebay_connections").delete().neq(
    // RLS already pins the row to the caller; the tautological filter exists
    // because PostgREST refuses DELETE without any filter at all.
    "user_id",
    "",
  );
  if (error) throw new Error(`Failed to disconnect eBay: ${error.message}`);
}

/**
 * Decrypted token view for the token provider. Internal to the adapter —
 * never crosses an API boundary.
 */
export interface DecryptedConnection {
  userId: string;
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
): Promise<DecryptedConnection | null> {
  let query = supabase
    .from("ebay_connections")
    .select(
      "user_id, ebay_user_id, ebay_username, refresh_token_enc, access_token_enc, access_token_expires_at, scopes",
    );
  if (userId) query = query.eq("user_id", userId);
  const { data, error } = await query.maybeSingle<ConnectionRow>();
  if (error) throw new Error(`Failed to read eBay connection: ${error.message}`);
  if (!data) return null;

  const key = parseEncryptionKey(env.EBAY_TOKEN_ENCRYPTION_KEY);
  return {
    userId: data.user_id,
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
  accessToken: string,
  expiresAt: number,
  env: Env = process.env,
): Promise<void> {
  const key = parseEncryptionKey(env.EBAY_TOKEN_ENCRYPTION_KEY);
  const { error } = await supabase
    .from("ebay_connections")
    .update({
      access_token_enc: encryptSecret(accessToken, key),
      access_token_expires_at: new Date(expiresAt).toISOString(),
    })
    .eq("user_id", userId);
  if (error) {
    // Cache write failure is non-fatal — the caller already holds a valid
    // access token; the next call just refreshes again.
    console.warn(`[ebay] failed to cache refreshed access token: ${error.message}`);
  }
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
